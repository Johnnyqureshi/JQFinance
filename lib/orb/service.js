'use strict';

// ORB Bot — Opening Range Breakout orchestration service (server-side).
//
// The ORB engine (lib/orb/engine.js) is pure. This module wires it into the
// running app the way lib/flipper/service.js wires the Flipper strategy: own
// orb_* tables, an own op lease (orb_leases), a 60s scheduler loop with its
// first run delayed ~120s (staggered after flipper's ~90s first tick),
// server-side position management via engine planExit, EOD flatten at
// 15:55 ET, and /api/orb/* routes via mountOrb().
//
// Zero imports from warrior/flipper/crypto lib dirs (ET helpers come from
// ./engine's _et; broker-universe is shared infra). Never touches
// warrior_*/flipper_*/crypto_* tables. Reuses shared infra only: market
// data, Alpaca connection plumbing, account info, broker_account_owners /
// broker_account_quarantine / automated_action_intents.
//
// Safety posture (mirrors Flipper): fail-closed — any broker/data/stale-data/
// order-confirmation/risk failure withholds new orders; open positions are
// reconciled with the broker before acting when state is unknown; fills are
// never assumed. PAPER is the default mode; LIVE connect is refused loudly
// and LIVE orders require rules.tradingMode==='LIVE' AND rules.liveEnabled
// AND rules.liveConfirmed AND a live credential — and even then are refused
// because no live credential can exist (connect only stores paper).

const crypto = require('crypto');
const {
  DEFAULT_ORB_RULES, parseWatchlist, computeOpeningRange, classifyRegime, evaluateEntry,
  planExit, sizePosition, checkDailyLocks, recordTradeResult, validateConfig,
  _et,
} = require('./engine');
const { buildTradeRecord, TRADE_FIELDS } = require('./journal');
const { buildTradableEquityCatalog } = require('../broker-universe');

const { easternDate, easternTimeMinutes, easternDayStartMs, parseClock, etClock } = _et;

const TERMINAL = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'replaced']);
const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const STRATEGY = 'orb';
const SCOPE = 'orb'; // broker_account_owners scope for ORB's dedicated account
const UNIVERSE_SYMBOL_CAP = 60; // per-cycle symbol budget (lean scans)
const FIRST_TICK_DELAY_MS = 120000; // ~120s: staggers after flipper's ~90s first tick
const TICK_MS = 60000;
const BAR_FRESH_MS = 10 * 60000; // decision bars must be this fresh
const EOD_FLATTEN_MIN = 15 * 60 + 55; // 15:55 ET
const DAY_MS = 86400000;

class OrbError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
function number(value) { return value == null || value === '' ? NaN : Number(value); }
// Unique client order IDs: orb-<40 hex of sha256>. Inputs must vary per
// setup attempt (uid, date, symbol, decision, entry, attempt ms) so a retry
// of the SAME setup reuses the id (idempotent) while a new setup never
// collides.
function clientId(...parts) {
  return `orb-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}
function isoNow(now) { return new Date(now()).toISOString(); }

function createOrbService({
  db, vault, fetch: fetchBroker, now = () => Date.now(),
  getAutomaticBotContext = async () => null,
  automaticBotSettings = null,
  persistenceReady = () => true,
  durability = null,
  sendEmail = null,
  batchSize = 100, timeoutMs = 10000, leaseMs = 180000,
  exitPoll = null, // { tries, intervalMs } — test seam; production default is 12 x 500ms
}) {
  if (!db || !vault || typeof fetchBroker !== 'function') throw new Error('ORB requires database, vault and fetch.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('ORB batch size must be an integer between 1 and 1000.');
  let timer = null;
  let running = false;
  let generation = 0;
  let ticking = false;
  let activeTick = null;
  // Remember SIP entitlement failures: once Alpaca 403s a SIP data request,
  // route subsequent data requests straight to IEX instead of failing first.
  let iexFallback = false;
  const timestamp = () => isoNow(now);

  // ---------------------------------------------------------------------------
  // Schema — all orb_* tables, user-scoped. Created at mount so a cold start
  // works without any migration step. Trade columns are exactly TRADE_FIELDS
  // from lib/orb/journal.js (all TEXT, like flipper).
  // ---------------------------------------------------------------------------
  const tradeFieldDefs = TRADE_FIELDS.map(f => `"${f}" TEXT`).join(',\n    ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS orb_settings (
      user_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'paper',
      rules TEXT NOT NULL DEFAULT '{}',
      scheduler_status TEXT NOT NULL DEFAULT 'idle',
      scheduler_reason TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS orb_credentials (
      user_id INTEGER PRIMARY KEY,
      api_key_enc TEXT NOT NULL,
      api_secret_enc TEXT NOT NULL,
      mode TEXT NOT NULL,
      account_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orb_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orb_positions (
      position_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      trade_id TEXT,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_client_order_id TEXT,
      entry_price REAL,
      shares INTEGER,
      stop_price REAL,
      targets_json TEXT,
      breakeven_at INTEGER NOT NULL DEFAULT 0,
      partials_taken TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending_entry',
      opened_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS orb_trades (
      trade_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ${tradeFieldDefs},
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orb_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orb_rejected (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      score REAL,
      reject_reasons TEXT NOT NULL DEFAULT '[]',
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orb_backtests (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      report TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orb_backtest_trades (
      backtest_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      trade_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orb_day_state (
      user_id INTEGER NOT NULL,
      trade_date TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT,
      PRIMARY KEY (user_id, trade_date)
    );
    CREATE TABLE IF NOT EXISTS orb_candidates (
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT,
      PRIMARY KEY (user_id, symbol, trade_date)
    );
  `);

  // ---------------------------------------------------------------------------
  // One-shot factory-exit migration (Johnny 2026-10-01, let winners run):
  // a stored rules row still holding the EXACT factory exits — targets
  // 50%@1.5R + 50%@3R with trailMode 'none' — is patched to the new factory
  // profile (single 25% partial at 2R, ATR trailing, no OR-width partials).
  // Any deliberate customization (different targets or a trail mode already
  // chosen) is left untouched. Idempotent: patched rows no longer match.
  // ---------------------------------------------------------------------------
  try {
    const rows = db.prepare('SELECT user_id, rules FROM orb_settings').all();
    for (const row of rows) {
      let stored = null;
      try { stored = JSON.parse(row.rules || '{}'); } catch (_) { stored = null; }
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
      const t = Array.isArray(stored.targets) ? stored.targets : [];
      const factoryTargets = t.length === 2
        && +t[0].r === 1.5 && +t[0].pct === 50
        && +t[1].r === 3 && +t[1].pct === 50;
      if (factoryTargets && String(stored.trailMode || '') === 'none') {
        stored.targets = [{ r: 2, pct: 25 }];
        stored.trailMode = 'atr';
        stored.orWidthTargets = false;
        db.prepare('UPDATE orb_settings SET rules=?, updated_at=? WHERE user_id=?')
          .run(JSON.stringify(stored), timestamp(), row.user_id);
      }
    }
  } catch (_) { /* best-effort: new defaults still apply wherever no row exists */ }

  // ---------------------------------------------------------------------------
  // One-shot watchlist addition (Johnny 2026-10-08): TSDD joins the fixed
  // watchlist. Appended to every stored watchlist that lacks it — an empty
  // watchlist (scan-everything mode) is left untouched, and rows already
  // carrying TSDD no longer match, so the step is idempotent.
  // ---------------------------------------------------------------------------
  try {
    const rows = db.prepare('SELECT user_id, rules FROM orb_settings').all();
    for (const row of rows) {
      let stored = null;
      try { stored = JSON.parse(row.rules || '{}'); } catch (_) { stored = null; }
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
      if (typeof stored.watchlist === 'string' && stored.watchlist.trim()) {
        const tokens = stored.watchlist.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (!tokens.includes('TSDD')) {
          stored.watchlist = `${stored.watchlist},TSDD`;
          db.prepare('UPDATE orb_settings SET rules=?, updated_at=? WHERE user_id=?')
            .run(JSON.stringify(stored), timestamp(), row.user_id);
        }
      } else if (Array.isArray(stored.watchlist) && stored.watchlist.length) {
        const tokens = stored.watchlist.map(s => String(s).trim().toUpperCase());
        if (!tokens.includes('TSDD')) {
          stored.watchlist = [...stored.watchlist, 'TSDD'];
          db.prepare('UPDATE orb_settings SET rules=?, updated_at=? WHERE user_id=?')
            .run(JSON.stringify(stored), timestamp(), row.user_id);
        }
      }
    }
  } catch (_) { /* best-effort: the code default already carries TSDD */ }

  // ---------------------------------------------------------------------------
  // Settings, credentials, leases, broker plumbing — mirrors flipper.
  // ---------------------------------------------------------------------------
  const getSettings = uid => db.prepare('SELECT * FROM orb_settings WHERE user_id=?').get(uid);
  function ensure(uid) {
    db.prepare('INSERT OR IGNORE INTO orb_settings(user_id) VALUES (?)').run(uid);
    return getSettings(uid);
  }
  function getRules(uid) {
    const settings = ensure(uid);
    let stored = {};
    try { stored = JSON.parse(settings.rules || '{}'); } catch (_) { stored = {}; }
    return { ...DEFAULT_ORB_RULES, ...stored };
  }
  function credential(uid) {
    const row = db.prepare('SELECT * FROM orb_credentials WHERE user_id=?').get(uid);
    if (!row) return null;
    // A missing or half-encrypted row fails closed, exactly like Flipper.
    if (!vault.isEncrypted(row.api_key_enc) || !vault.isEncrypted(row.api_secret_enc)) return null;
    return row;
  }
  const quarantined = account =>
    !!db.prepare('SELECT 1 FROM broker_account_quarantine WHERE account_id=? AND resolved_at IS NULL').get(account);
  const EMAIL_KINDS = new Set(['entry', 'exit', 'risk', 'system']);
  function alert(uid, kind, message) {
    // Messages are fixed application text, never upstream error bodies or credentials.
    const previous = db.prepare('SELECT kind,message,created_at FROM orb_alerts WHERE user_id=? ORDER BY id DESC LIMIT 1').get(uid);
    if (previous?.kind === kind && previous.message === message && now() - Date.parse(previous.created_at) < 300000) return;
    db.prepare('INSERT INTO orb_alerts(user_id,kind,message,created_at) VALUES (?,?,?,?)')
      .run(uid, kind, message, timestamp());
    if (sendEmail && EMAIL_KINDS.has(kind)) {
      try { void Promise.resolve(sendEmail({ userId: uid, kind, message })).catch(() => {}); }
      catch (_) { /* alert persistence above is authoritative */ }
    }
  }
  async function locked(uid, work) {
    const name = `orb-op:${uid}`;
    const token = crypto.randomUUID();
    const leaseUntil = new Date(now() + leaseMs).toISOString();
    const result = db.prepare(`INSERT INTO orb_leases(name,owner,expires_at) VALUES (?,?,?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE orb_leases.expires_at<=?`).run(name, token, leaseUntil, timestamp());
    if (!result.changes) throw new OrbError('ORB is reconciling this account. Retry shortly.');
    const lease = { uid, token, generation, name };
    try { return await work(lease); }
    finally {
      db.prepare('DELETE FROM orb_leases WHERE name=? AND owner=?').run(name, token);
      // Never await this flush on a user-facing path: flush() resolves only
      // after the next throttled mutation checkpoint (up to ~60s), which
      // stalled connect/settings responses past client and edge timeouts
      // (2026-10-05: connects looked hung / returned unreadable responses).
      // flush() marks the mutation dirty synchronously, so the checkpoint
      // still lands on the same schedule. Broker-action flushes stay awaited.
      if (durability?.flush && persistenceReady()) { try { durability.flush('orb-operation').catch(() => {}); } catch (_) {} }
    }
  }
  function guard(lease) {
    const renewed = db.prepare('UPDATE orb_leases SET expires_at=? WHERE name=? AND owner=? AND expires_at>?')
      .run(new Date(now() + leaseMs).toISOString(), lease.name, lease.token, timestamp());
    if (!renewed.changes) throw new OrbError('ORB lease expired; broker action withheld.');
  }
  function context(uid, lease, mode) {
    const settings = ensure(uid);
    const cred = credential(uid);
    if (!cred) throw new OrbError('Connect a dedicated ORB broker account.');
    return { uid, lease, settings, cred, rules: getRules(uid) };
  }
  function authorize(ctx) {
    guard(ctx.lease);
    const current = getSettings(ctx.uid);
    const cred = credential(ctx.uid);
    if (!cred || cred.account_id !== ctx.cred.account_id || cred.api_key_enc !== ctx.cred.api_key_enc ||
        cred.api_secret_enc !== ctx.cred.api_secret_enc) {
      throw new OrbError('ORB authorization changed; action withheld.');
    }
    const owner = db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (!owner || owner.scope !== SCOPE || owner.user_id !== ctx.uid || owner.mode !== cred.mode || quarantined(cred.account_id)) {
      throw new OrbError('ORB broker account ownership is not verified.');
    }
  }
  async function request(cred, path, { method = 'GET', body, data = false, allow404 = false, ctx } = {}) {
    if (ctx) {
      guard(ctx.lease);
      if (method !== 'GET') authorize(ctx);
    }
    if (method !== 'GET' && durability?.flush) {
      if (ctx) {
        const clientOrderId = body?.client_order_id || null;
        const purpose = path.includes('orders') ? (body?.side === 'buy' ? 'entry' : 'exit') : 'broker-action';
        const intent = db.prepare(`
          INSERT INTO automated_action_intents
            (strategy,user_id,account_id,mode,method,path,purpose,client_order_id,request_json,state,updated_at)
          VALUES ('orb',?,?,?,?,?,?,?,?,'prepared',datetime('now'))
        `).run(ctx.uid, cred.account_id, cred.mode, method, path, purpose, clientOrderId, JSON.stringify(body || {}));
        ctx.actionIntentId = intent.lastInsertRowid;
      }
      await durability.flush(`orb-before-${method.toLowerCase()}`);
      if (ctx) authorize(ctx);
    }
    const controller = new AbortController();
    let timeout;
    try {
      const call = (async () => {
        const doFetch = p => fetchBroker(`${data ? DATA : cred.mode === 'live' ? LIVE : PAPER}${p}`, {
          method, signal: controller.signal,
          headers: { 'APCA-API-KEY-ID': vault.decrypt(cred.api_key_enc), 'APCA-API-SECRET-KEY': vault.decrypt(cred.api_secret_enc), 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        let response = await doFetch(path);
        // Paper accounts without a consolidated-data entitlement get HTTP 403
        // on SIP feed requests. Fall back to IEX once (and remember it) so
        // scans keep working on the free feed.
        if (data && response.status === 403 && path.includes('feed=sip')) {
          iexFallback = true;
          response = await doFetch(path.replace('feed=sip', 'feed=iex'));
        } else if (data && iexFallback && path.includes('feed=sip')) {
          response = await doFetch(path.replace('feed=sip', 'feed=iex'));
        }
        if (allow404 && response.status === 404) return null;
        if (!response.ok) {
          const failure = new OrbError(`Broker request failed (HTTP ${response.status}); action withheld.`, 502);
          failure.httpStatus = response.status;
          if (response.status === 422) {
            try {
              const rejection = await response.json();
              failure.duplicateClient = /(?:client.?order.?id.*(?:unique|exist|duplicate))|duplicate/i.test(String(rejection?.message || ''));
            } catch (_) { failure.duplicateClient = true; }
          }
          throw failure;
        }
        return response.status === 204 ? null : await response.json();
      })();
      const result = await Promise.race([call, new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new OrbError('Broker request timed out; reconciliation required.', 502)); }, timeoutMs);
      })]);
      if (ctx) guard(ctx.lease);
      if (method !== 'GET' && durability?.flush) {
        if (ctx?.actionIntentId) db.prepare(`
          UPDATE automated_action_intents SET state='submitted', broker_order_id=?, updated_at=datetime('now')
          WHERE id=?
        `).run(result?.id || null, ctx.actionIntentId);
        await durability.flush(`orb-after-${method.toLowerCase()}`);
      }
      return result;
    } catch (error) {
      if (method !== 'GET' && durability?.flush && ctx?.actionIntentId) {
        const definitive = Number(error?.httpStatus) >= 400 && Number(error?.httpStatus) < 500;
        db.prepare(`
          UPDATE automated_action_intents SET state=?, last_error=?, updated_at=datetime('now')
          WHERE id=?
        `).run(definitive ? 'rejected' : 'submission_unknown',
          definitive ? 'Broker definitively rejected the action.' : 'Broker response was not confirmed; reconciliation required.',
          ctx.actionIntentId);
        try { await durability.flush(`orb-unknown-${method.toLowerCase()}`); } catch (_) {}
      }
      if (error instanceof OrbError) throw error;
      throw new OrbError('Broker connection or response failed; action withheld.', 502);
    } finally { clearTimeout(timeout); }
  }
  async function broker(ctx, path, options = {}) {
    return request(ctx.cred, path, { ...options, ctx });
  }
  function validateAccount(account, expected) {
    if (typeof account?.id !== 'string' || !account.id.trim() || (expected && account.id !== expected) || account.status !== 'ACTIVE' ||
        account.trading_blocked || account.account_blocked || account.trade_suspended_by_user) {
      throw new OrbError('Broker account identity or trading permission is not valid.');
    }
  }
  async function orderByClient(ctx, id) {
    return broker(ctx, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`, { allow404: true });
  }
  function release(uid, cred) {
    if (!cred) return;
    const remaining = db.prepare('SELECT 1 FROM orb_credentials WHERE account_id=?').get(cred.account_id);
    if (!remaining) db.prepare("DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope='orb'").run(cred.account_id, uid);
  }
  function validateInput(input, allowed, message) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowed.includes(key))) throw new OrbError(message, 400);
  }

  // ---------------------------------------------------------------------------
  // Connect / disconnect / settings / status
  // ---------------------------------------------------------------------------
  async function connect(uid, input) {
    if (!persistenceReady()) throw new OrbError('Automated trading persistence is unavailable; ORB entries remain paused.', 503);
    validateInput(input, ['key', 'secret', 'mode'], 'Only key, secret and mode may be supplied.');
    if (typeof input.key !== 'string' || typeof input.secret !== 'string' ||
        !input.key.trim() || !input.secret.trim() || input.key.length > 512 || input.secret.length > 512) {
      throw new OrbError('Valid API key and secret are required.', 400);
    }
    // PAPER is the only working mode. A live connect is refused LOUDLY —
    // there is no quiet downgrade to paper.
    if (input.mode !== undefined && String(input.mode).toLowerCase() !== 'paper') {
      throw new OrbError('LIVE trading is not connected for ORB — paper is the only working mode. Connect paper keys.', 400);
    }
    return locked(uid, async lease => {
      ensure(uid);
      const next = { mode: 'paper', api_key_enc: vault.encrypt(input.key.trim()), api_secret_enc: vault.encrypt(input.secret.trim()) };
      const account = await request(next, '/v2/account');
      validateAccount(account);
      guard(lease);
      db.transaction(() => {
        if (quarantined(account.id)) throw new OrbError('Broker account is quarantined.');
        const owner = db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at)
          VALUES (?,?,'orb',?,?) ON CONFLICT(account_id) DO UPDATE SET claimed_at=excluded.claimed_at
          WHERE broker_account_owners.user_id=excluded.user_id AND broker_account_owners.scope='orb'
            AND broker_account_owners.mode=excluded.mode`).run(account.id, uid, 'paper', timestamp());
        if (!owner.changes) throw new OrbError('This broker account is already assigned to another user, mode or trading scope.');
        const old = credential(uid);
        db.prepare(`INSERT INTO orb_credentials(user_id,api_key_enc,api_secret_enc,mode,account_id) VALUES (?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET api_key_enc=excluded.api_key_enc,api_secret_enc=excluded.api_secret_enc,
            mode=excluded.mode,account_id=excluded.account_id`)
          .run(uid, next.api_key_enc, next.api_secret_enc, 'paper', account.id);
        release(uid, old);
        // ORB ships DISABLED: connecting stores credentials only. Johnny
        // enables the bot himself in the UI.
        db.prepare("UPDATE orb_settings SET mode='paper',scheduler_status='idle',scheduler_reason=NULL,updated_at=? WHERE user_id=?")
          .run(timestamp(), uid);
        automaticBotSettings?.revoke?.(uid, 'orb');
      })();
      return { ok: true, accountId: account.id };
    });
  }
  async function disconnect(uid) {
    return locked(uid, async () => {
      ensure(uid);
      // Block while anything is live OR working: an open position or a
      // pending entry order. Disconnecting with a working entry would
      // orphan broker state the service no longer manages.
      const live = db.prepare(`SELECT 1 FROM orb_positions
        WHERE user_id=? AND status IN ('open','pending_entry') LIMIT 1`).get(uid);
      if (live) throw new OrbError('Close or flatten all ORB positions (including pending entries) before disconnecting.');
      const rows = db.prepare('SELECT * FROM orb_credentials WHERE user_id=?').all(uid);
      db.transaction(() => {
        db.prepare('DELETE FROM orb_credentials WHERE user_id=?').run(uid);
        rows.forEach(row => release(uid, row));
        db.prepare('UPDATE orb_settings SET enabled=0,updated_at=? WHERE user_id=?').run(timestamp(), uid);
      })();
      return { ok: true };
    });
  }

  // Rule type map for setSettings: every DEFAULT_ORB_RULES key is accepted;
  // anything else is rejected as unknown. 'clock' = "HH:MM" (24h).
  const RULE_TYPES = {
    orMinutes: [5, 15, 30],
    entryWindowStart: 'clock', entryWindowEnd: 'clock',
    secondWindowEnabled: 'boolean', secondWindowStart: 'clock', secondWindowEnd: 'clock',
    minScore: 'number', weights: 'weights',
    minRvol: 'number', preferredRvol: 'number', strongRvol: 'number',
    minPrice: 'number', maxPrice: 'number', minAvgVolume: 'number', maxSpreadPct: 'number', maxPositions: 'number',
    watchlist: 'watchlist', // comma-separated string or array → stored normalized
    allowLong: 'boolean', allowShort: 'boolean',
    entryMode: ['direct', 'retest', 'either'],
    maxAttemptsPerSymbol: 'number', cooldownMinutes: 'number',
    sizingMode: ['dollars', 'shares', 'acctpct', 'risk'],
    fixedDollars: 'number', fixedShares: 'number', acctPct: 'number', riskPct: 'number',
    stopMode: ['pct', 'atr', 'oropposite', 'breakoutlevel', 'retestextreme', 'dollarrisk'],
    stopPct: 'number', atrStopMult: 'number', dollarRisk: 'number',
    targets: 'targets', breakevenR: 'number', trailMode: ['none', 'atr', 'vwap'], orWidthTargets: 'boolean',
    maxDailyLossDollars: 'number', maxTradesPerDay: 'number', maxConsecLosses: 'number',
    maxExposureDollars: 'number', maxTradesPerSymbol: 'number',
    requireVwapAgree: 'boolean', minLevelClearancePct: 'number', minRR: 'number',
    maxWickPct: 'number', maxExtensionAtrs: 'number', maxRsiLong: 'number',
    newsPolicy: ['block', 'reduce', 'allow'],
    tradingMode: ['PAPER', 'LIVE'], liveEnabled: 'boolean', liveConfirmed: 'boolean',
  };
  function setSettings(uid, input) {
    validateInput(input, ['enabled', 'rules'], 'Only enabled and rules may be changed.');
    return locked(uid, async () => {
      const current = ensure(uid);
      const rules = { ...getRules(uid) };
      const patch = input.rules && typeof input.rules === 'object' ? input.rules : {};
      for (const [key, rawValue] of Object.entries(patch)) {
        const type = RULE_TYPES[key];
        if (!type) throw new OrbError(`Unknown setting: ${key}.`, 400);
        const value = rawValue;
        if (Array.isArray(type)) {
          if (!type.includes(value)) throw new OrbError(`${key} must be one of ${type.join(', ')}.`, 400);
        } else if (type === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new OrbError(`${key} must be a finite non-negative number.`, 400);
        } else if (type === 'boolean') {
          if (typeof value !== 'boolean') throw new OrbError(`${key} must be boolean.`, 400);
        } else if (type === 'clock') {
          if (typeof value !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) {
            throw new OrbError(`${key} must be a clock time like "09:45".`, 400);
          }
        } else if (type === 'weights') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrbError('weights must be an object of component weights.', 400);
          const merged = { ...rules.weights };
          for (const [wk, wv] of Object.entries(value)) {
            if (!(wk in DEFAULT_ORB_RULES.weights)) throw new OrbError(`Unknown weight: ${wk}.`, 400);
            if (typeof wv !== 'number' || !Number.isFinite(wv) || wv < 0) throw new OrbError(`weights.${wk} must be a non-negative number.`, 400);
            merged[wk] = wv;
          }
          rules.weights = merged;
          continue;
        } else if (type === 'targets') {
          if (!Array.isArray(value) || !value.length) throw new OrbError('targets must be a non-empty array of {r, pct}.', 400);
          rules.targets = value.map(t => ({ r: +t.r, pct: +t.pct }));
          continue;
        } else if (type === 'watchlist') {
          // Normalize to a canonical comma-separated string (uppercase,
          // deduped, no empties) via the shared engine parser. Empty input
          // clears the list → full-universe scan.
          rules.watchlist = parseWatchlist({ watchlist: value }).join(',');
          continue;
        }
        rules[key] = value;
      }
      // Full engine validation on the merged rules (price band order, weight
      // sum, target pct sum, LIVE triple-switch rule, everything).
      const validation = validateConfig(rules);
      if (!validation.ok) {
        throw new OrbError(`Invalid ORB configuration: ${validation.errors.join(' | ')}`, 400);
      }
      const enabled = input.enabled === undefined ? !!current.enabled : !!input.enabled;
      db.prepare('UPDATE orb_settings SET enabled=?,rules=?,revision=revision+1,updated_at=? WHERE user_id=?')
        .run(Number(enabled), JSON.stringify(rules), timestamp(), uid);
      return status(uid);
    });
  }
  function getSettingsView(uid) {
    const settings = ensure(uid);
    return {
      enabled: !!settings.enabled, mode: settings.mode, rules: getRules(uid),
      revision: settings.revision || 0,
      liveNote: 'LIVE orders require tradingMode=LIVE AND liveEnabled AND liveConfirmed AND a live credential. Anything less is refused loudly; paper is the only working mode and live connect is refused.',
    };
  }
  function openPositions(uid) {
    return db.prepare("SELECT * FROM orb_positions WHERE user_id=? AND status IN ('open','pending_entry') ORDER BY opened_at").all(uid);
  }
  function setSchedulerState(uid, statusValue, reason) {
    db.prepare(`INSERT INTO orb_settings(user_id,scheduler_status,scheduler_reason,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET scheduler_status=excluded.scheduler_status,
        scheduler_reason=excluded.scheduler_reason,updated_at=excluded.updated_at`)
      .run(uid, statusValue, reason || null, timestamp());
  }
  async function status(uid) {
    const settings = ensure(uid);
    const rules = getRules(uid);
    const cred = credential(uid);
    let account = null;
    if (cred) {
      try { account = await request(cred, '/v2/account'); }
      catch (_) { account = null; /* status must never throw on a broker hiccup */ }
    }
    const openCount = db.prepare("SELECT COUNT(*) AS n FROM orb_positions WHERE user_id=? AND status IN ('open','pending_entry')").get(uid)?.n || 0;
    const blockers = [];
    if (!cred) blockers.push('Connect a dedicated ORB paper account.');
    if (!settings.enabled) blockers.push('ORB is paused.');
    if (rules.tradingMode === 'LIVE') {
      blockers.push('LIVE requested — paper is the only working mode; orders refused until live is connected.');
    }
    return {
      enabled: !!settings.enabled, mode: settings.mode, connected: !!cred,
      accountId: cred?.account_id || null,
      schedulerStatus: settings.scheduler_status || 'idle',
      schedulerReason: settings.scheduler_reason || null,
      lastCycleAt: settings.updated_at || null,
      revision: settings.revision || 0,
      ready: blockers.length === 0, blockers,
      equity: number(account?.equity) || 0,
      buyingPower: number(account?.buying_power) || 0,
      openPositions: openCount,
    };
  }
  function insertTrade(uid, rec) {
    const cols = TRADE_FIELDS.map(f => `"${f}"`).join(',');
    const placeholders = TRADE_FIELDS.map(() => '?').join(',');
    const tradeId = crypto.randomUUID();
    db.prepare(`INSERT INTO orb_trades(trade_id,user_id,${cols},created_at) VALUES (?,?,${placeholders},?)`)
      .run(tradeId, uid, ...TRADE_FIELDS.map(f => rec[f] ?? null), timestamp());
    return tradeId;
  }
  function positions(uid) {
    return { positions: openPositions(uid) };
  }
  function trades(uid, query = {}) {
    const where = ['user_id=?'];
    const args = [uid];
    if (query.symbol) { where.push('symbol=?'); args.push(String(query.symbol).toUpperCase()); }
    const closed = db.prepare(`SELECT * FROM orb_trades WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`).all(...args);
    // Open positions ride along as journal-shaped rows so the dashboard sees
    // one trade list. Journal keeps exactly the TRADE_FIELDS from journal.js.
    const open = openPositions(uid).map(p => buildTradeRecord({
      direction: p.direction, entryTime: p.opened_at, symbol: p.symbol,
      entryPrice: p.entry_price, stopPrice: p.stop_price, targets: p.targets_json,
      size: p.shares, entryReason: 'open position',
    }));
    const rows = [...open, ...closed].map(r => ({
      ...r, status: r.closedAt ? 'closed' : 'open',
    }));
    return { trades: rows };
  }
  function alerts(uid) {
    return { alerts: db.prepare('SELECT kind,message,created_at AS createdAt FROM orb_alerts WHERE user_id=? ORDER BY id DESC LIMIT 200').all(uid) };
  }
  function universe(uid) {
    // Today's scanned candidates ARE the universe (lean DB: no separate
    // universe table, no per-symbol scan metadata).
    const tradeDate = easternDate(now());
    const rows = db.prepare(`SELECT symbol, trade_date AS tradeDate, data FROM orb_candidates
      WHERE user_id=? AND trade_date=? ORDER BY symbol`).all(uid, tradeDate)
      .map(r => {
        let data = {};
        try { data = JSON.parse(r.data || '{}'); } catch (_) {}
        return { symbol: r.symbol, direction: data.direction || null, score: data.score ?? null, tradeDate: r.tradeDate };
      });
    return { universe: rows, total: rows.length, tradeDate };
  }

  // ---------------------------------------------------------------------------
  // Daily locks state — keyed by ET date. checkDailyLocks only evaluates;
  // this state is never reset intraday, a fresh object starts per date.
  // ---------------------------------------------------------------------------
  function freshDayState(tradeDate) {
    return {
      date: tradeDate, pnl: 0, trades: 0, consecLosses: 0,
      openPositions: 0, exposureDollars: 0, tradesBySymbol: {}, attempts: {},
    };
  }
  function getDayState(uid, tradeDate) {
    const row = db.prepare('SELECT state FROM orb_day_state WHERE user_id=? AND trade_date=?').get(uid, tradeDate);
    if (row) {
      try {
        const parsed = JSON.parse(row.state || '{}');
        return { ...freshDayState(tradeDate), ...parsed };
      } catch (_) { /* fall through to fresh */ }
    }
    return freshDayState(tradeDate);
  }
  function saveDayState(uid, dayState) {
    db.prepare(`INSERT INTO orb_day_state(user_id,trade_date,state,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id,trade_date) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
      .run(uid, dayState.date, JSON.stringify(dayState), timestamp());
  }
  function recordAttempt(dayState, symbol, result) {
    const d = { ...dayState, attempts: { ...(dayState.attempts || {}) } };
    const list = Array.isArray(d.attempts[symbol]) ? d.attempts[symbol].slice() : [];
    list.push({ t: now(), result });
    d.attempts[symbol] = list;
    return d;
  }

  // ---------------------------------------------------------------------------
  // News policy. No news feed is wired, so checkNews() returns
  // { available:false }. The engine blocks entries when
  // hasMaterialNews===true && newsPolicy==='block' and halves size when
  // 'reduce'. With no source we do NOT block everything (that would brick
  // the bot forever): trading is allowed, newsUnavailable:true is recorded
  // in the journal and on candidates, and the dashboard says explicitly that
  // no news data is available. This matches the spec's "explicitly say when
  // data is unavailable — never invent catalysts" rule.
  // ---------------------------------------------------------------------------
  function checkNews() {
    return { available: false, material: null };
  }

  // Paper-first gate for order submission. LIVE needs the full triple
  // (tradingMode + both switches) AND a live credential — and connect only
  // ever stores paper credentials, so this is defense in depth that refuses
  // loudly rather than downgrading quietly.
  function assertLiveAllowed(ctx) {
    const rules = ctx.rules || getRules(ctx.uid);
    const mode = String(rules.tradingMode || 'PAPER').toUpperCase();
    if (mode === 'LIVE') {
      if (rules.liveEnabled === true && rules.liveConfirmed === true && ctx.cred.mode === 'live') return;
      throw new OrbError('LIVE order refused: tradingMode=LIVE requires liveEnabled, liveConfirmed AND a connected live credential. Paper is the only working mode.', 403);
    }
    if (mode !== 'PAPER') throw new OrbError(`Order refused: unknown tradingMode "${rules.tradingMode}".`, 403);
  }

  // ---------------------------------------------------------------------------
  // Market data — guarded broker paths with the SIP→IEX fallback in request().
  // ---------------------------------------------------------------------------
  async function marketSession(ctx) {
    // Calendar-backed session check: ET-minutes alone would claim "regular"
    // on a Saturday. ORB trades the regular session only (09:30–16:00 ET).
    const today = easternDate(now());
    const calendar = await broker(ctx, `/v2/calendar?start=${today}&end=${today}`);
    if (!Array.isArray(calendar)) {
      throw new OrbError('Broker calendar is unavailable; market-hours state is unknown.');
    }
    if (!calendar.length || !calendar[0]?.date) {
      // A clean empty calendar means no session today (weekend/holiday) —
      // idle, don't alarm. A non-array above is a real data failure.
      const closed = new OrbError('Market is closed today.');
      closed.marketClosed = true;
      throw closed;
    }
    const clock = await broker(ctx, '/v2/clock');
    const clockTime = Date.parse(clock?.timestamp);
    if (!Number.isFinite(clockTime) || Math.abs(now() - clockTime) > 120000) {
      throw new OrbError('Broker clock is missing or stale.');
    }
    const mins = easternTimeMinutes(now());
    const inRegular = mins >= 570 && mins < 960;
    return { clock, session: calendar[0], windowOpen: inRegular, regularOpen: inRegular, minutes: mins };
  }
  // Flatten minute: 15:55 ET, or 12:55 on early-close days (Alpaca calendar
  // close ≤ 13:00 ET).
  function eodFlattenMinutes(marketState) {
    const close = parseClock(marketState?.session?.close, 16 * 60);
    if (close <= 13 * 60) return 12 * 60 + 55;
    return EOD_FLATTEN_MIN;
  }
  function toEngineBars(raw) {
    return (Array.isArray(raw) ? raw : [])
      .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
      .filter(b => Number.isFinite(b.t) && Number.isFinite(b.c))
      .sort((a, b) => a.t - b.t);
  }
  async function fetchDailyBars(ctx, symbols, sessions = 25) {
    const out = Object.fromEntries(symbols.map(s => [s, []]));
    for (let i = 0; i < symbols.length; i += 200) {
      const chunk = symbols.slice(i, i + 200);
      guard(ctx.lease);
      const query = new URLSearchParams({
        symbols: chunk.join(','), timeframe: '1Day',
        start: new Date(now() - sessions * 2 * DAY_MS).toISOString(),
        end: new Date(now()).toISOString(),
        limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc',
      });
      const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
      if (!data?.bars || typeof data.bars !== 'object') throw new OrbError('Historical daily bars are unavailable.');
      for (const s of chunk) out[s] = toEngineBars(data.bars[s]);
    }
    return out;
  }
  async function fetchMinuteBars(ctx, symbols, startIso, endIso) {
    const out = Object.fromEntries(symbols.map(s => [s, []]));
    for (let i = 0; i < symbols.length; i += 200) {
      const chunk = symbols.slice(i, i + 200);
      guard(ctx.lease);
      const query = new URLSearchParams({
        symbols: chunk.join(','), timeframe: '1Min', start: startIso, end: endIso,
        limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc',
      });
      const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
      if (!data?.bars || typeof data.bars !== 'object') throw new OrbError('Intraday minute bars are unavailable.');
      for (const s of chunk) out[s] = toEngineBars(data.bars[s]);
    }
    return out;
  }
  async function fetchLatestBars(ctx, symbols) {
    // Latest price per symbol: /v2/stocks/bars/latest → { bars: { SYM: bar } }.
    const out = {};
    for (let i = 0; i < symbols.length; i += 200) {
      const chunk = symbols.slice(i, i + 200);
      guard(ctx.lease);
      const data = await broker(ctx, `/v2/stocks/bars/latest?symbols=${chunk.map(encodeURIComponent).join(',')}&feed=sip`, { data: true });
      const bars = data?.bars || {};
      for (const s of chunk) {
        const entry = bars[s];
        const bar = entry && typeof entry === 'object'
          ? (entry.MinuteBar || entry.minute || entry.DailyBar || entry.daily || entry) : null;
        const price = number(bar?.c);
        const t = bar?.t ? Date.parse(bar.t) : NaN;
        if (Number.isFinite(price) && price > 0 && Number.isFinite(t)) out[s] = { price, t };
      }
    }
    return out;
  }
  async function fetchLatestQuotes(ctx, symbols) {
    // Spread per symbol: /v2/stocks/quotes/latest → { quotes: { SYM: quote } }.
    const out = {};
    for (let i = 0; i < symbols.length; i += 200) {
      const chunk = symbols.slice(i, i + 200);
      guard(ctx.lease);
      const data = await broker(ctx, `/v2/stocks/quotes/latest?symbols=${chunk.map(encodeURIComponent).join(',')}&feed=sip`, { data: true });
      const quotes = data?.quotes || data?.quote || {};
      for (const s of chunk) {
        const entry = quotes[s];
        const q = entry && typeof entry === 'object' ? (entry.Quote || entry.quote || entry) : null;
        const bid = number(q?.bp ?? q?.bid); const ask = number(q?.ap ?? q?.ask);
        const t = q?.t ? Date.parse(q.t) : NaN;
        const spreadPct = (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid)
          ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
        if (spreadPct !== null) out[s] = { spreadPct, t: Number.isFinite(t) ? t : null };
      }
    }
    return out;
  }

  // --- pure per-symbol derivations (local copies; engine stays pure) --------
  function vwapOf(bars) {
    let pv = 0; let v = 0;
    for (const b of bars) {
      if (![b.h, b.l, b.c, b.v].every(Number.isFinite)) continue;
      pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v;
    }
    return v > 0 ? pv / v : null;
  }
  function atrOf(daily, period = 14) {
    const ds = (Array.isArray(daily) ? daily : []).filter(b => [b.h, b.l, b.c].every(Number.isFinite));
    if (ds.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < ds.length; i++) {
      trs.push(Math.max(ds[i].h - ds[i].l, Math.abs(ds[i].h - ds[i - 1].c), Math.abs(ds[i].l - ds[i - 1].c)));
    }
    const recent = trs.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }
  function avgDailyVolume(daily, lookback = 20) {
    const vols = (Array.isArray(daily) ? daily : [])
      .filter(b => Number.isFinite(+b.v)).slice(-lookback).map(b => +b.v);
    return vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  }
  function dayChangePct(daily) {
    const ds = Array.isArray(daily) ? daily : [];
    if (ds.length < 2) return null;
    const prev = ds[ds.length - 2]; const last = ds[ds.length - 1];
    if (!Number.isFinite(+prev.c) || !Number.isFinite(+last.c) || +prev.c <= 0) return null;
    return ((+last.c - +prev.c) / +prev.c) * 100;
  }
  // Premarket context: bars before 9:30 ET today + prior daily bar for levels.
  function premarketContext(bars, prevDaily) {
    const dayStart = easternDayStartMs(now());
    const openMs = dayStart + 9.5 * 3600000;
    const pm = (Array.isArray(bars) ? bars : []).filter(b => b.t < openMs);
    let high = null; let low = null; let volume = 0;
    for (const b of pm) {
      if (Number.isFinite(+b.h)) high = high === null ? +b.h : Math.max(high, +b.h);
      if (Number.isFinite(+b.l)) low = low === null ? +b.l : Math.min(low, +b.l);
      if (Number.isFinite(+b.v)) volume += +b.v;
    }
    let trend = 'flat';
    if (pm.length >= 2) {
      const first = +pm[0].c; const last = +pm[pm.length - 1].c;
      if (Number.isFinite(first) && Number.isFinite(last) && first > 0) {
        const chg = ((last - first) / first) * 100;
        trend = chg > 0.1 ? 'up' : chg < -0.1 ? 'down' : 'flat';
      }
    }
    const prevClose = prevDaily && Number.isFinite(+prevDaily.c) ? +prevDaily.c : null;
    const firstOpen = pm.length && Number.isFinite(+pm[0].o) ? +pm[0].o : null;
    const gapPct = (firstOpen !== null && prevClose) ? ((firstOpen - prevClose) / prevClose) * 100 : null;
    return {
      high, low, volume, trend, gapPct,
      priorHigh: prevDaily && Number.isFinite(+prevDaily.h) ? +prevDaily.h : null,
      priorLow: prevDaily && Number.isFinite(+prevDaily.l) ? +prevDaily.l : null,
      priorClose: prevClose,
    };
  }
  function safeJson(value, fallback) {
    try { const parsed = JSON.parse(value); return parsed ?? fallback; } catch (_) { return fallback; }
  }

  // --- candidate / rejected persistence --------------------------------------
  function upsertCandidate(uid, tradeDate, symbol, data) {
    db.prepare(`INSERT INTO orb_candidates(user_id,symbol,trade_date,data,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id,symbol,trade_date) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
      .run(uid, symbol, tradeDate, JSON.stringify(data || {}), timestamp());
  }
  // One row per symbol/day (delete-then-insert): keeps rejected-setup
  // retention lean while retaining exact no-trade reasons per the spec.
  function recordRejected(uid, tradeDate, symbol, score, rejectReasons, context) {
    db.prepare('DELETE FROM orb_rejected WHERE user_id=? AND symbol=? AND trade_date=?').run(uid, symbol, tradeDate);
    db.prepare(`INSERT INTO orb_rejected(user_id,symbol,trade_date,score,reject_reasons,context,created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(uid, symbol, tradeDate, score ?? null, JSON.stringify(rejectReasons || []),
        JSON.stringify(context || {}), timestamp());
  }

  // ---------------------------------------------------------------------------
  // Dashboard — regime, indices, candidates with OR/score/why, day state,
  // locks, positions, today's trades. Best-effort broker reads; a dashboard
  // hiccup must never throw (display-only).
  // ---------------------------------------------------------------------------
  async function dashboard(uid) {
    const tradeDate = easternDate(now());
    const settings = ensure(uid);
    const rules = getRules(uid);
    const cred = credential(uid);
    let regime = null;
    let indices = { spy: null, qqq: null, iwm: null, vix: null };
    if (cred) {
      try {
        const query = new URLSearchParams({
          symbols: 'SPY,QQQ,IWM', timeframe: '1Day',
          start: new Date(now() - 10 * DAY_MS).toISOString(),
          end: new Date(now()).toISOString(),
          limit: '100', adjustment: 'all', feed: 'sip', sort: 'asc',
        });
        const data = await request(cred, `/v2/stocks/bars?${query}`, { data: true });
        const bars = data?.bars || {};
        const changeOf = s => dayChangePct(toEngineBars(bars[s]));
        const lastOf = s => { const b = toEngineBars(bars[s]); return b.length ? b[b.length - 1] : null; };
        const spy = changeOf('SPY'); const qqq = changeOf('QQQ'); const iwm = changeOf('IWM');
        let vix = null; let vixChange = null;
        try {
          const vq = new URLSearchParams({
            symbols: 'VIX', timeframe: '1Day',
            start: new Date(now() - 10 * DAY_MS).toISOString(),
            end: new Date(now()).toISOString(), limit: '100', feed: 'sip', sort: 'asc',
          });
          const vdata = await request(cred, `/v2/stocks/bars?${vq}`, { data: true });
          const vb = toEngineBars(vdata?.bars?.VIX);
          if (vb.length) { vix = +vb[vb.length - 1].c; vixChange = dayChangePct(vb); }
        } catch (_) { /* VIX unavailable — classifyRegime handles nulls */ }
        regime = classifyRegime({ spyChangePct: spy, qqqChangePct: qqq, iwmChangePct: iwm, vix, vixChangePct: vixChange });
        indices = {
          spy: lastOf('SPY') ? { price: +lastOf('SPY').c, changePct: spy } : null,
          qqq: lastOf('QQQ') ? { price: +lastOf('QQQ').c, changePct: qqq } : null,
          iwm: lastOf('IWM') ? { price: +lastOf('IWM').c, changePct: iwm } : null,
          vix: vix !== null ? { price: vix, changePct: vixChange } : null,
        };
      } catch (_) { regime = null; /* display-only: stale/absent beats a failed dashboard */ }
    }
    const candidates = db.prepare('SELECT symbol, trade_date AS tradeDate, data FROM orb_candidates WHERE user_id=? AND trade_date=? ORDER BY symbol')
      .all(uid, tradeDate)
      .map(r => ({ symbol: r.symbol, tradeDate: r.tradeDate, ...safeJson(r.data, {}) }))
      .map(c => {
        // Normalize the engine's points-object breakdown into the UI's
        // [{name, weight, score(0-100)}] bars shape.
        const raw = c.scoreBreakdown || c.breakdown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const weights = (rules.weights && typeof rules.weights === 'object') ? rules.weights : {};
          c.scoreBreakdown = Object.entries(raw).map(([name, pts]) => {
            const w = Number(weights[name]) || 0;
            const p = Number(pts) || 0;
            return { name, weight: w, score: w > 0 ? Math.max(0, Math.min(100, (p / w) * 100)) : 0 };
          });
        }
        return c;
      });
    const rejected = db.prepare(`SELECT symbol, trade_date AS tradeDate, score, reject_reasons AS rejectReasons,
        context, created_at AS createdAt FROM orb_rejected WHERE user_id=? AND trade_date=? ORDER BY id DESC LIMIT 100`)
      .all(uid, tradeDate)
      .map(r => ({ ...r, rejectReasons: safeJson(r.rejectReasons, []), context: safeJson(r.context, {}) }));
    const dayState = getDayState(uid, tradeDate);
    const locks = checkDailyLocks(dayState, rules);
    const dayStart = new Date(easternDayStartMs(now())).toISOString();
    const todaysTrades = db.prepare('SELECT * FROM orb_trades WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 200')
      .all(uid, dayStart);
    return {
      tradeDate,
      status: {
        enabled: !!settings.enabled, mode: settings.mode,
        schedulerStatus: settings.scheduler_status || 'idle',
        schedulerReason: settings.scheduler_reason || null,
        lastCycleAt: settings.updated_at || null,
      },
      regime,
      indices,
      news: { available: false, note: 'No news feed is wired — news data is unavailable; entries are not news-gated and this is recorded in the journal.' },
      candidates,
      rejected,
      dayState,
      locks,
      positions: openPositions(uid),
      todaysTrades,
    };
  }

  // ---------------------------------------------------------------------------
  // Entry gate — pre-trade checks right before an order goes out. Fail-closed:
  // any lock, cap, duplicate, or stale-data condition withholds the entry.
  // ---------------------------------------------------------------------------
  function entryGate(ctx, rules, dayState, symbol) {
    const locks = checkDailyLocks(dayState, rules);
    if (locks.locked) return { ok: false, reason: locks.reasons[0] };
    const openCount = db.prepare("SELECT COUNT(*) AS n FROM orb_positions WHERE user_id=? AND status IN ('open','pending_entry')").get(ctx.uid)?.n || 0;
    if (openCount >= rules.maxPositions) {
      return { ok: false, reason: `MAX_POSITIONS: ${openCount} open/pending positions at the ${rules.maxPositions} cap` };
    }
    const symCount = (dayState.tradesBySymbol && dayState.tradesBySymbol[symbol]) || 0;
    if (symCount >= rules.maxTradesPerSymbol) {
      return { ok: false, reason: `MAX_TRADES_PER_SYMBOL: ${symbol} at ${symCount} (cap ${rules.maxTradesPerSymbol})` };
    }
    const existing = db.prepare("SELECT 1 FROM orb_positions WHERE user_id=? AND symbol=? AND status IN ('open','pending_entry')").get(ctx.uid, symbol);
    if (existing) return { ok: false, reason: `POSITION_EXISTS: ${symbol} already has an open or pending ORB position` };
    if ((dayState.exposureDollars || 0) >= rules.maxExposureDollars) {
      return { ok: false, reason: `MAX_EXPOSURE: $${Number(dayState.exposureDollars).toFixed(2)} at the $${rules.maxExposureDollars} cap` };
    }
    return { ok: true };
  }

  // Poll a working order by client id until it fills, dies, or the poll
  // budget runs out. Never throws on unknown state — the caller decides.
  async function pollOrderFill(ctx, clientOrderId, initial) {
    const poll = exitPoll || { tries: 12, intervalMs: 500 };
    let seen = initial || null;
    for (let i = 0; i < poll.tries; i++) {
      guard(ctx.lease);
      const fetched = await orderByClient(ctx, clientOrderId).catch(() => null);
      if (fetched) seen = fetched;
      const st = String(seen?.status || '').toLowerCase();
      const filledQty = Math.abs(Math.round(number(seen?.filled_qty) || 0));
      const qty = Math.abs(Math.round(number(seen?.qty) || 0));
      if (st === 'filled' || (qty > 0 && filledQty >= qty)) break;
      if (TERMINAL.has(st)) break;
      if (poll.intervalMs > 0) await new Promise(r => setTimeout(r, poll.intervalMs));
    }
    return seen;
  }

  // Confirm a working entry order against the broker. Fills are never
  // assumed: 'open' only on a confirmed fill, dead orders are removed, and
  // unknown state stays pending for the next tick's reconciliation.
  async function finalizeEntryFromOrder(ctx, pos, seen, { res = null, meta = null, tradeDate } = {}) {
    const { uid } = ctx;
    const rules = ctx.rules;
    const st = String(seen?.status || '').toLowerCase();
    const filledQty = Math.abs(Math.round(number(seen?.filled_qty) || 0));
    const qty = Math.abs(Math.round(number(seen?.qty) || pos.shares || 0));
    const avgPrice = number(seen?.filled_avg_price);
    const filled = (st === 'filled' || (qty > 0 && filledQty >= qty)) && filledQty > 0 && Number.isFinite(avgPrice);
    if (filled) {
      db.prepare("UPDATE orb_positions SET status='open', entry_price=?, shares=?, updated_at=? WHERE position_id=?")
        .run(avgPrice, filledQty, timestamp(), pos.position_id);
      let tradeId = pos.trade_id;
      if (!tradeId) {
        const rec = buildTradeRecord({
          direction: pos.direction, entryTime: timestamp(), symbol: pos.symbol,
          orHigh: meta?.or?.high ?? null, orLow: meta?.or?.low ?? null, orWidth: meta?.or?.width ?? null,
          vwap: meta?.vwap ?? null, rvol: meta?.rvol ?? null, atr: meta?.atr ?? null,
          regime: meta?.regime?.regime ?? null,
          score: res?.score ?? null, scoreBreakdown: res?.breakdown ? JSON.stringify(res.breakdown) : null,
          size: filledQty, entryPrice: avgPrice, stopPrice: res?.stop ?? pos.stop_price,
          targets: res?.targets ? JSON.stringify(res.targets) : pos.targets_json,
          riskDollars: res?.riskDollars ?? null,
          entryReason: res?.why
            ? `${res.why}${meta?.news?.available ? '' : ' [news unavailable: no feed wired]'}`
            : 'reconciled broker fill',
          rejectReasons: res?.rejectReasons ? JSON.stringify(res.rejectReasons) : '[]',
          newsPolicy: rules.newsPolicy, createdAt: timestamp(), closedAt: null,
        });
        tradeId = insertTrade(uid, rec);
        db.prepare('UPDATE orb_positions SET trade_id=? WHERE position_id=?').run(tradeId, pos.position_id);
      }
      let dayState = getDayState(uid, tradeDate);
      dayState = recordAttempt(dayState, pos.symbol, 'entered');
      dayState.trades = (dayState.trades || 0) + 1;
      dayState.tradesBySymbol = { ...(dayState.tradesBySymbol || {}) };
      dayState.tradesBySymbol[pos.symbol] = (dayState.tradesBySymbol[pos.symbol] || 0) + 1;
      dayState.exposureDollars = (dayState.exposureDollars || 0) + avgPrice * filledQty;
      saveDayState(uid, dayState);
      alert(uid, 'entry', `ORB entry ${pos.symbol} ${pos.direction} ${filledQty} sh @ $${avgPrice}${res?.score != null ? ` (score ${res.score})` : ''}.`);
      return 'open';
    }
    if (TERMINAL.has(st) && filledQty === 0) {
      db.prepare('DELETE FROM orb_positions WHERE position_id=?').run(pos.position_id);
      let dayState = getDayState(uid, tradeDate);
      dayState = recordAttempt(dayState, pos.symbol, 'failed');
      saveDayState(uid, dayState);
      alert(uid, 'system', `ORB entry ${pos.symbol} ${st} with no fill — working order removed.`);
      return 'dead';
    }
    if (filledQty > 0 && filledQty < qty) {
      // Partial fill: keep working the remainder.
      db.prepare('UPDATE orb_positions SET shares=?, updated_at=? WHERE position_id=?')
        .run(qty - filledQty, timestamp(), pos.position_id);
    }
    let dayState = getDayState(uid, tradeDate);
    dayState = recordAttempt(dayState, pos.symbol, 'pending');
    saveDayState(uid, dayState);
    return 'pending';
  }

  async function submitEntry(ctx, tradeDate, symbol, res, meta) {
    const { uid } = ctx;
    const rules = ctx.rules;
    assertLiveAllowed(ctx);
    // Fail closed on stale decision data.
    const barsAge = now() - (meta.lastBarT || 0);
    if (!Number.isFinite(meta.lastBarT) || barsAge > BAR_FRESH_MS) {
      throw new OrbError(`Stale market data for ${symbol}; entry withheld.`);
    }
    // Duplicate prevention: the client order id is deterministic per setup
    // attempt, so a retry of the SAME setup reuses it (idempotent) while a
    // new setup gets a fresh id.
    const id = clientId(uid, tradeDate, symbol, res.decision, String(Math.round(res.entry * 10000)), String(now()));
    const dupOrder = await orderByClient(ctx, id).catch(() => null);
    if (dupOrder && !TERMINAL.has(String(dupOrder.status || '').toLowerCase())) {
      throw new OrbError(`Duplicate entry suppressed: a working broker order already exists for ${symbol}.`);
    }
    const dupLocal = db.prepare('SELECT 1 FROM orb_positions WHERE user_id=? AND entry_client_order_id=?').get(uid, id);
    if (dupLocal) throw new OrbError(`Duplicate entry suppressed: ${symbol} entry already tracked.`);
    const side = String(res.decision).includes('long') ? 'buy' : 'sell';
    const direction = String(res.decision).includes('long') ? 'long' : 'short';
    const order = await broker(ctx, '/v2/orders', {
      method: 'POST',
      body: {
        symbol, qty: res.size.shares, side, type: 'limit', time_in_force: 'day',
        limit_price: res.entry, client_order_id: id,
      },
    });
    // Track the working entry immediately; the fill is confirmed below and
    // reconciled on later ticks. Never assume the fill.
    const positionId = crypto.randomUUID();
    db.prepare(`INSERT INTO orb_positions(position_id,user_id,trade_id,symbol,direction,entry_client_order_id,
      entry_price,shares,stop_price,targets_json,breakeven_at,partials_taken,status,opened_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(positionId, uid, null, symbol, direction, id, res.entry, res.size.shares,
        res.stop, JSON.stringify(res.targets || []), 0, '[]', 'pending_entry', timestamp(), timestamp());
    const pos = db.prepare('SELECT * FROM orb_positions WHERE position_id=?').get(positionId);
    const seen = await pollOrderFill(ctx, id, order);
    return finalizeEntryFromOrder(ctx, pos, seen, { res, meta, tradeDate });
  }

  // ---------------------------------------------------------------------------
  // Position management — reconcile with the broker, then run engine planExit
  // (breakeven / partials / trail / exit), plus EOD flatten at 15:55 ET.
  // Stops are managed server-side (mental stops): planExit returns a newStop
  // and this layer acts on stop hits with market orders.
  // ---------------------------------------------------------------------------
  async function reconcilePending(ctx, pos) {
    const tradeDate = easternDate(now());
    const seen = await orderByClient(ctx, pos.entry_client_order_id).catch(() => null);
    if (!seen) {
      // Unknown order state — fail closed: keep the stub, alert, do NOT resubmit.
      alert(ctx.uid, 'system', `ORB pending entry ${pos.symbol}: broker order state unknown — no action, reconciliation required.`);
      return;
    }
    await finalizeEntryFromOrder(ctx, pos, seen, { tradeDate });
  }

  async function closePosition(ctx, pos, exitReason) {
    const { uid } = ctx;
    assertLiveAllowed(ctx);
    const side = pos.direction === 'long' ? 'sell' : 'buy';
    const cid = clientId(uid, 'exit', pos.position_id, String(now()));
    const order = await broker(ctx, '/v2/orders', {
      method: 'POST',
      body: { symbol: pos.symbol, qty: pos.shares, side, type: 'market', time_in_force: 'day', client_order_id: cid },
    });
    const seen = await pollOrderFill(ctx, cid, order);
    const exitPrice = number(seen?.filled_avg_price);
    const filledQty = Math.abs(Math.round(number(seen?.filled_qty) || 0));
    if (!Number.isFinite(exitPrice) || filledQty <= 0) {
      // Uncertain order state — fail closed: keep the position, alert loudly.
      alert(uid, 'risk', `ORB exit for ${pos.symbol} has uncertain fill state — position kept, reconciliation required.`);
      throw new OrbError(`Exit order for ${pos.symbol} has uncertain fill state; reconciliation required.`);
    }
    const signed = pos.direction === 'long' ? 1 : -1;
    const pnl = signed * (exitPrice - pos.entry_price) * filledQty;
    const riskPerShare = Math.abs(pos.entry_price - pos.stop_price);
    const rMultiple = riskPerShare > 0 ? pnl / (riskPerShare * filledQty) : 0;
    if (pos.trade_id) {
      db.prepare('UPDATE orb_trades SET "exitPrice"=?, "pnl"=?, "rMultiple"=?, "exitReason"=?, "closedAt"=? WHERE trade_id=?')
        .run(String(exitPrice), String(pnl), String(rMultiple),
          `${exitReason}: ${pos.direction} ${filledQty} sh @ $${exitPrice}`, timestamp(), pos.trade_id);
    }
    db.prepare('DELETE FROM orb_positions WHERE position_id=?').run(pos.position_id);
    let dayState = getDayState(uid, easternDate(now()));
    dayState = recordTradeResult(dayState, { pnl, symbol: pos.symbol });
    dayState.exposureDollars = Math.max(0, number(dayState.exposureDollars) - pos.entry_price * filledQty);
    saveDayState(uid, dayState);
    alert(uid, 'exit', `ORB exit (${exitReason}) ${pos.symbol} ${pos.direction} ${filledQty} sh @ $${exitPrice.toFixed(2)} — P&L $${pnl.toFixed(2)} (${rMultiple.toFixed(2)}R).`);
    return { exitPrice, filledQty, pnl, rMultiple };
  }

  async function applyPlan(ctx, pos, plan) {
    const { uid } = ctx;
    if (plan.action === 'hold') return { action: 'hold' };
    if (plan.action === 'breakeven') {
      db.prepare('UPDATE orb_positions SET stop_price=?, breakeven_at=1, updated_at=? WHERE position_id=?')
        .run(plan.newStop, timestamp(), pos.position_id);
      return { action: 'breakeven' };
    }
    if (plan.action === 'trail') {
      db.prepare('UPDATE orb_positions SET stop_price=?, updated_at=? WHERE position_id=?')
        .run(plan.newStop, timestamp(), pos.position_id);
      return { action: 'trail' };
    }
    assertLiveAllowed(ctx);
    const exitSide = pos.direction === 'long' ? 'sell' : 'buy';
    if (plan.action === 'partial') {
      const t = plan.target || {};
      let qty = Math.max(1, Math.round(pos.shares * (number(t.pct) || 0) / 100));
      if (qty >= pos.shares) qty = pos.shares - 1; // never flatten on a "partial"
      if (qty < 1) return { action: 'hold' };
      const cid = clientId(uid, 'partial', pos.position_id, String(t.r ?? ''), String(now()));
      const order = await broker(ctx, '/v2/orders', {
        method: 'POST',
        body: { symbol: pos.symbol, qty, side: exitSide, type: 'market', time_in_force: 'day', client_order_id: cid },
      });
      const seen = await pollOrderFill(ctx, cid, order);
      const filledQty = Math.abs(Math.round(number(seen?.filled_qty) || 0));
      if (filledQty > 0) {
        const taken = safeJson(pos.partials_taken, []);
        if (t.r != null && !taken.includes(+t.r)) taken.push(+t.r);
        db.prepare('UPDATE orb_positions SET shares=shares-?, partials_taken=?, updated_at=? WHERE position_id=?')
          .run(Math.min(filledQty, pos.shares - 1), JSON.stringify(taken), timestamp(), pos.position_id);
        alert(uid, 'exit', `ORB partial ${pos.symbol}: took ${filledQty} sh off at ${t.r}R target.`);
      }
      return { action: 'partial' };
    }
    if (plan.action === 'exit') {
      const reason = /^EXIT/i.test(plan.reason || '') ? 'stop' : 'exit-signal';
      await closePosition(ctx, pos, reason);
      return { action: 'exit' };
    }
    return { action: 'hold' };
  }

  async function managePositions(ctx, marketState, tradeDate, funnel) {
    const { uid } = ctx;
    const rules = ctx.rules;
    const positions = openPositions(uid);
    if (!positions.length) return { managed: 0 };
    let brokerPositions;
    try {
      brokerPositions = await broker(ctx, '/v2/positions');
    } catch (error) {
      alert(uid, 'system', 'ORB position reconciliation unavailable — position actions withheld this tick.');
      return { managed: 0, reconciled: false };
    }
    if (!Array.isArray(brokerPositions)) {
      alert(uid, 'system', 'ORB broker positions response invalid — position actions withheld this tick.');
      return { managed: 0, reconciled: false };
    }
    const eod = marketState.minutes >= eodFlattenMinutes(marketState);
    // Market context for planExit (ATR/VWAP trailing): best-effort fetches.
    const openSyms = [...new Set(positions.filter(p => p.status === 'open').map(p => p.symbol))];
    const atrMap = {}; const vwapMap = {}; const priceMap = {};
    try {
      Object.assign(priceMap, await fetchLatestBars(ctx, [...new Set(positions.map(p => p.symbol))]));
      if (openSyms.length) {
        const daily = await fetchDailyBars(ctx, openSyms, 25);
        const mins = await fetchMinuteBars(ctx, openSyms,
          new Date(easternDayStartMs(now())).toISOString(), new Date(now()).toISOString());
        for (const s of openSyms) { atrMap[s] = atrOf(daily[s]); vwapMap[s] = vwapOf(mins[s]); }
      }
    } catch (_) { /* per-symbol staleness checks below withhold exits */ }
    for (const pos of positions) {
      guard(ctx.lease);
      try {
        if (pos.status === 'pending_entry') {
          if (eod) {
            // EOD: cancel the working entry instead of letting it fill overnight.
            const order = await orderByClient(ctx, pos.entry_client_order_id).catch(() => null);
            if (order?.id && !TERMINAL.has(String(order.status || '').toLowerCase())) {
              await broker(ctx, `/v2/orders/${order.id}`, { method: 'DELETE', allow404: true });
            }
            db.prepare('DELETE FROM orb_positions WHERE position_id=?').run(pos.position_id);
            let dayState = getDayState(uid, tradeDate);
            dayState = recordAttempt(dayState, pos.symbol, 'cancelled-eod');
            saveDayState(uid, dayState);
            alert(uid, 'system', `ORB EOD flatten: cancelled pending entry ${pos.symbol}.`);
          } else {
            await reconcilePending(ctx, pos);
          }
          continue;
        }
        const bp = brokerPositions.find(p => String(p.symbol || '').toUpperCase() === pos.symbol);
        const brokerQty = Math.abs(Math.round(number(bp?.qty) || 0));
        if (!bp || brokerQty <= 0) {
          // No broker position — check the entry order before assuming anything.
          const order = await orderByClient(ctx, pos.entry_client_order_id).catch(() => null);
          const st = String(order?.status || '').toLowerCase();
          const filledQty = Math.abs(Math.round(number(order?.filled_qty) || 0));
          if (order && TERMINAL.has(st) && filledQty === 0) {
            db.prepare('DELETE FROM orb_positions WHERE position_id=?').run(pos.position_id);
            alert(uid, 'system', `ORB ${pos.symbol} entry order ${st} with no fill — local position removed.`);
          } else {
            alert(uid, 'system', `ORB ${pos.symbol}: no broker position found; order state ${st || 'unknown'} — action withheld, reconciliation required.`);
          }
          continue;
        }
        if (eod) {
          await closePosition(ctx, pos, 'eod_flatten');
          continue;
        }
        const latest = priceMap[pos.symbol];
        if (!latest || now() - latest.t > BAR_FRESH_MS) {
          alert(uid, 'system', `ORB ${pos.symbol}: price data stale — exit decisions withheld this tick.`);
          continue;
        }
        const plan = planExit({
          direction: pos.direction, entry: pos.entry_price, stop: pos.stop_price,
          targets: safeJson(pos.targets_json, []), size: pos.shares,
          breakevenAt: pos.breakeven_at, partialsTaken: safeJson(pos.partials_taken, []),
          breakevenR: rules.breakevenR, trailMode: rules.trailMode, trailAtrMult: rules.atrStopMult,
        }, { price: latest.price, vwap: vwapMap[pos.symbol] ?? null, atr: atrMap[pos.symbol] ?? null });
        await applyPlan(ctx, pos, plan);
      } catch (error) {
        funnel.errors++;
        alert(uid, 'system', `ORB position management withheld for ${pos.symbol}: ${error instanceof OrbError ? error.message : 'unexpected error'}`);
      }
    }
    return { managed: positions.length };
  }

  // ---------------------------------------------------------------------------
  // Scan cycle — one 60s tick: lease → enabled/connected/market checks →
  // manage open positions → scan the universe for ORB entries.
  // Fail-closed: any broker/data/stale/unknown-order-state failure withholds
  // new entries; open positions are reconciled with the broker before acting.
  // ---------------------------------------------------------------------------
  async function scanEntries(ctx, marketState, tradeDate, funnel) {
    const { uid } = ctx;
    const rules = ctx.rules;
    let dayState = getDayState(uid, tradeDate);
    const locks = checkDailyLocks(dayState, rules);
    if (locks.locked) {
      alert(uid, 'risk', `ORB daily locks engaged — no new entries: ${locks.reasons[0]}`);
      return { entered: 0, skipped: 'daily-locks' };
    }
    // Universe: when the fixed watchlist is set it IS the universe (the
    // Alpaca asset catalog is skipped) and the price band is bypassed for
    // its symbols — volume, spread, RVOL, scoring, and entry gates still
    // apply. Otherwise the full Alpaca us_equity catalog (stocks + ETFs,
    // incl. leveraged/inverse) filtered by the price band. Per-cycle symbol
    // budget keeps scans lean.
    const watchSymbols = parseWatchlist(rules);
    const onWatchlist = watchSymbols.length > 0;
    let symbols;
    if (onWatchlist) {
      symbols = watchSymbols;
      funnel.universe = symbols.length;
      funnel.watchlist = true;
    } else {
      const assets = await broker(ctx, '/v2/assets?status=active&asset_class=us_equity');
      const catalog = buildTradableEquityCatalog(assets);
      funnel.universe = catalog.size;
      symbols = [...catalog.keys()].slice(0, 400);
    }
    const latest = await fetchLatestBars(ctx, symbols);
    symbols = symbols.filter(s => {
      const p = latest[s]?.price;
      if (p == null) return false;
      return onWatchlist || (p >= rules.minPrice && p <= rules.maxPrice);
    });
    const withIndex = [...new Set([...symbols, 'SPY', 'QQQ', 'IWM'])];
    const daily = await fetchDailyBars(ctx, withIndex, 25);
    const avgVols = {};
    symbols = symbols.filter(s => {
      const av = avgDailyVolume(daily[s]);
      avgVols[s] = av;
      return av != null && av >= rules.minAvgVolume;
    });
    funnel.liquid = symbols.length;
    const quotes = await fetchLatestQuotes(ctx, symbols);
    symbols = symbols.filter(s => {
      const sp = quotes[s]?.spreadPct;
      return sp != null && sp <= rules.maxSpreadPct;
    }).slice(0, onWatchlist ? symbols.length : UNIVERSE_SYMBOL_CAP);
    const startIso = new Date(easternDayStartMs(now())).toISOString();
    const minutes = await fetchMinuteBars(ctx, symbols, startIso, new Date(now()).toISOString());
    const spyChg = dayChangePct(daily.SPY);
    let vix = null; let vixChg = null;
    try {
      const vd = await fetchDailyBars(ctx, ['VIX'], 10);
      const vb = vd.VIX;
      if (vb.length) { vix = +vb[vb.length - 1].c; vixChg = dayChangePct(vb); }
    } catch (_) { /* VIX unavailable — classifyRegime handles nulls */ }
    const regime = classifyRegime({
      spyChangePct: spyChg, qqqChangePct: dayChangePct(daily.QQQ),
      iwmChangePct: dayChangePct(daily.IWM), vix, vixChangePct: vixChg,
    });
    const news = checkNews();
    const equity = number(ctx.account?.equity);
    let entered = 0;
    for (const symbol of symbols) {
      guard(ctx.lease);
      try {
        const bars = minutes[symbol] || [];
        const or = computeOpeningRange(bars, rules.orMinutes);
        const ds = daily[symbol] || [];
        const prevDaily = ds.length >= 2 ? ds[ds.length - 2] : null;
        if (or.error || !prevDaily || !bars.length) {
          const reason = or.error ? `BAD_OR_DATA: ${or.error}` : 'LEVELS_MISSING: not enough daily history for prior levels';
          recordRejected(uid, tradeDate, symbol, 0, [reason], { newsUnavailable: !news.available });
          upsertCandidate(uid, tradeDate, symbol, {
            direction: null, decision: 'wait', score: 0, why: reason,
            newsUnavailable: !news.available, rejectReasons: [reason], updatedAt: timestamp(),
          });
          continue;
        }
        const pm = premarketContext(bars, prevDaily);
        const atr = atrOf(ds);
        const vwap = vwapOf(bars);
        const avgVol = avgVols[symbol];
        const todayVol = bars.reduce((a, b) => a + (Number.isFinite(+b.v) ? +b.v : 0), 0);
        const rvol = avgVol > 0 ? todayVol / avgVol : null;
        const firstO = +bars[0].o; const lastC = +bars[bars.length - 1].c;
        const dayChg = firstO > 0 ? ((lastC - firstO) / firstO) * 100 : null;
        const relStrength = (dayChg != null && spyChg != null) ? dayChg - spyChg : null;
        const spreadPct = quotes[symbol]?.spreadPct ?? null;
        const base = {
          symbol, bars, or, vwap, rvol, avgVolume: avgVol, spreadPct,
          relStrengthVsSpy: relStrength, regime, atr,
          premarket: { trend: pm.trend, gapPct: pm.gapPct },
          levels: { priorHigh: pm.priorHigh, priorLow: pm.priorLow },
          lastAttempts: (dayState.attempts && dayState.attempts[symbol]) || [],
          accountEquity: equity, nowMs: now(), rules,
        };
        const decisions = [];
        for (const direction of ['long', 'short']) {
          if (direction === 'long' && rules.allowLong !== true) continue;
          if (direction === 'short' && rules.allowShort !== true) continue;
          decisions.push({ direction, res: evaluateEntry({ ...base, direction }) });
        }
        let best = null;
        for (const d of decisions) {
          if (String(d.res.decision).startsWith('enter') && (!best || d.res.score > best.res.score)) best = d;
        }
        const allRejects = [...new Set(decisions.flatMap(d => d.res.rejectReasons || []))];
        const bestScore = decisions.reduce((m, d) => Math.max(m, d.res.score || 0), 0);
        const data = {
          direction: best ? best.direction : null,
          decision: best ? best.res.decision : 'wait',
          score: best ? best.res.score : bestScore,
          or: { high: or.high, low: or.low, mid: or.mid, width: or.width },
          price: lastC, vwap, rvol, relStrengthVsSpy: relStrength, atr,
          regime: regime.regime,
          entry: best ? best.res.entry : null, stop: best ? best.res.stop : null,
          targets: best ? best.res.targets : null,
          riskDollars: best && best.res.riskDollars != null ? best.res.riskDollars : null,
          why: best ? best.res.why : decisions.map(d =>
            `${d.direction}: ${(d.res.rejectReasons || []).slice(0, 3).join(' | ') || 'no setup'}`).join(' ;; '),
          newsUnavailable: !news.available,
          rejectReasons: best ? best.res.rejectReasons : allRejects,
          updatedAt: timestamp(),
        };
        upsertCandidate(uid, tradeDate, symbol, data);
        if (!best) {
          recordRejected(uid, tradeDate, symbol, data.score, allRejects,
            { orHigh: or.high, orLow: or.low, newsUnavailable: !news.available });
          continue;
        }
        // Fresh locks right before the order — never trust a stale dayState.
        dayState = getDayState(uid, tradeDate);
        const gate = entryGate(ctx, rules, dayState, symbol);
        if (!gate.ok) {
          recordRejected(uid, tradeDate, symbol, best.res.score,
            [`ENTRY_GATE: ${gate.reason}`, ...(best.res.rejectReasons || [])],
            { orHigh: or.high, orLow: or.low, newsUnavailable: !news.available });
          alert(uid, 'system', `ORB entry withheld for ${symbol}: ${gate.reason}`);
          continue;
        }
        await submitEntry(ctx, tradeDate, symbol, best.res, {
          or, vwap, rvol, atr, regime, news, lastBarT: bars[bars.length - 1].t,
        });
        entered++;
        funnel.entries++;
        dayState = getDayState(uid, tradeDate);
      } catch (error) {
        funnel.errors++;
        const message = error instanceof OrbError ? error.message : 'Unexpected ORB scan error; order withheld.';
        alert(uid, 'system', `ORB scan withheld for ${symbol}: ${message}`);
      }
    }
    return { entered };
  }

  async function scanCycle(uid) {
    return locked(uid, async lease => {
      const tradeDate = easternDate(now());
      const settings = ensure(uid);
      // Disabled users: no broker calls — just idle state and a lean prune.
      if (!settings.enabled) {
        setSchedulerState(uid, 'idle', 'ORB is paused.');
        try { await pruneDiagnostics(uid); } catch (_) { /* best-effort */ }
        return;
      }
      if (!persistenceReady()) {
        setSchedulerState(uid, 'error', 'Persistence unavailable; ORB paused.');
        return;
      }
      const ctx = context(uid, lease);
      const rules = getRules(uid);
      ctx.rules = rules;
      const funnel = { universe: 0, liquid: 0, entries: 0, errors: 0 };
      try {
        const cred = credential(uid);
        if (!cred) throw new OrbError('Connect a dedicated ORB broker account.');
        guard(lease);
        // Broker account verification FIRST: identity, trading permission,
        // and the account id we expect, then the market-session check.
        const account = await broker(ctx, '/v2/account');
        validateAccount(account, cred.account_id);
        ctx.account = account;
        const marketState = await marketSession(ctx);
        // Position management runs every tick during the session: reconcile,
        // breakeven/partials/trail/exit, EOD flatten.
        await managePositions(ctx, marketState, tradeDate, funnel);
        // New entries only in the regular session.
        if (marketState.regularOpen) {
          await scanEntries(ctx, marketState, tradeDate, funnel);
        }
        setSchedulerState(uid, 'ok', null);
        pruneDiagnostics(uid).catch(() => {});
      } catch (error) {
        funnel.errors++;
        if (error?.marketClosed) {
          setSchedulerState(uid, 'idle', 'Market is closed.');
          return;
        }
        const message = error instanceof OrbError ? error.message : 'Unexpected ORB scheduler error; next tick will retry.';
        setSchedulerState(uid, 'error', message);
        if (!(error instanceof OrbError) && !(error?.httpStatus)) {
          alert(uid, 'system', 'ORB scheduler errored safely — orders withheld until the next tick.');
        }
      }
    });
  }
  async function runTick(uid) {
    // One tick per user, sequentially; generation-gated so a drain that
    // starts mid-loop prevents post-drain broker calls.
    if (ticking) return;
    ticking = true;
    const myGeneration = generation;
    try {
      await scanCycle(uid);
    } catch (_) { /* scanCycle self-reports; never throw out of the loop */ }
    finally {
      ticking = false;
      if (myGeneration !== generation) return;
    }
  }
  function usersWithIdentity() {
    // Any orb_settings row is an identity row. Disabled-but-configured users
    // get prune only (no broker calls); only enabled ones trade.
    return db.prepare('SELECT user_id FROM orb_settings').all().map(r => r.user_id);
  }
  function start() {
    if (timer) return;
    running = true;
    const tickAll = async () => {
      if (!running) return;
      for (const uid of usersWithIdentity()) {
        if (!running) break;
        try { await runTick(uid); }
        catch (_) { /* never break the loop */ }
      }
    };
    // First tick delayed ~120s (staggered after flipper's ~90s first tick).
    // CrashGuard: the outer tickAll callback must never reject into the
    // process.
    const safeTickAll = () => tickAll().catch(error => {
      console.error('[ORB] scheduler tick escaped containment:', error && error.stack ? error.stack : error);
    });
    timer = setTimeout(() => {
      safeTickAll().then(() => {
        if (running) timer = setInterval(safeTickAll, TICK_MS);
      });
    }, FIRST_TICK_DELAY_MS);
  }
  function stop() {
    running = false;
    if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; }
  }
  async function drain(timeoutMs = 30000) {
    stop();
    generation += 1;
    if (activeTick || ticking) {
      const deadline = Date.now() + timeoutMs;
      while ((activeTick || ticking) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }
  function lifecycleStatus() {
    return { running, ticking, generation, nextTickMs: timer ? FIRST_TICK_DELAY_MS : null, iexFallback };
  }

  // ---------------------------------------------------------------------------
  // pruneDiagnostics — lean DB retention: 7-day alerts, 30-day rejected
  // setups, backtests capped at newest 20 (orphan trade rows removed),
  // candidates from past dates, day-state older than 30 days. Real trade
  // records, positions, settings, creds, leases untouched.
  // ---------------------------------------------------------------------------
  async function pruneDiagnostics(uid) {
    try {
      const cutoff = new Date(now() - 7 * DAY_MS).toISOString();
      db.prepare('DELETE FROM orb_alerts WHERE user_id=? AND created_at<?').run(uid, cutoff);
      const rejectCutoff = new Date(now() - 30 * DAY_MS).toISOString();
      db.prepare('DELETE FROM orb_rejected WHERE user_id=? AND created_at<?').run(uid, rejectCutoff);
      const oldBacktests = db.prepare('SELECT id FROM orb_backtests WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 20').all(uid);
      db.transaction(() => {
        for (const row of oldBacktests) {
          db.prepare('DELETE FROM orb_backtest_trades WHERE backtest_id=?').run(row.id);
          db.prepare('DELETE FROM orb_backtests WHERE id=?').run(row.id);
        }
      })();
      const today = easternDate(now());
      db.prepare('DELETE FROM orb_candidates WHERE user_id=? AND trade_date<?').run(uid, today);
      const stateCutoff = new Date(now() - 30 * DAY_MS).toISOString().slice(0, 10);
      db.prepare('DELETE FROM orb_day_state WHERE user_id=? AND trade_date<?').run(uid, stateCutoff);
      if (durability?.flush && persistenceReady()) await durability.flush('orb-prune');
    } catch (_) { /* pruning is best-effort */ }
  }

  // ---------------------------------------------------------------------------
  // Backtest — point-in-time engine (lib/orb/backtest.js) over the connected
  // account's own bars, persisted to orb_backtests / orb_backtest_trades.
  // The engine is required lazily so a missing module fails loudly at call
  // time (503), never at module load, and never touches the network.
  // ---------------------------------------------------------------------------
  function addDaysIso(dateStr, days) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  async function backtest(uid, input) {
    validateInput(input, ['startDate', 'endDate', 'rules'], 'Only startDate, endDate and rules may be supplied.');
    let runBacktest;
    try {
      runBacktest = require('./backtest').runBacktest;
    } catch (_) {
      throw new OrbError('ORB backtest engine is not available yet (lib/orb/backtest.js is built in a later wave).', 503);
    }
    if (typeof runBacktest !== 'function') throw new OrbError('ORB backtest engine is not available yet.', 503);
    const settings = ensure(uid);
    const cred = credential(uid);
    if (!cred) throw new OrbError('Connect an ORB broker account before running a backtest.', 400);
    const rules = { ...DEFAULT_ORB_RULES, ...(input.rules || {}) };
    const today = easternDate(now());
    const endDate = typeof input.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.endDate) ? input.endDate : today;
    const startDate = typeof input.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.startDate) ? input.startDate : addDaysIso(endDate, -29);
    if (startDate > endDate) throw new OrbError('startDate must not be after endDate.', 400);
    // Cap the window to the most recent 90 days.
    const earliest = addDaysIso(endDate, -89);
    const cappedStart = startDate < earliest ? earliest : startDate;
    return locked(uid, async lease => {
      guard(lease);
      const ctx = { uid, lease, settings, cred, rules };
      // Universe for the backtest: the fixed watchlist when set (price band
      // bypassed, like the live/paper scan), otherwise the rules price band
      // over the broker asset catalog, capped at 30 symbols.
      const btWatchSymbols = parseWatchlist(rules);
      const btOnWatchlist = btWatchSymbols.length > 0;
      let symbols;
      if (btOnWatchlist) {
        symbols = btWatchSymbols;
      } else {
        const assets = await broker(ctx, '/v2/assets?status=active&asset_class=us_equity');
        const catalog = buildTradableEquityCatalog(assets);
        symbols = [...catalog.keys()].slice(0, 200);
      }
      const latest = await fetchLatestBars(ctx, symbols);
      symbols = symbols
        .filter(s => {
          const p = latest[s]?.price;
          if (p == null) return false;
          return btOnWatchlist || (p >= rules.minPrice && p <= rules.maxPrice);
        })
        .slice(0, btOnWatchlist ? symbols.length : 30);
      if (!symbols.length) throw new OrbError(
        btOnWatchlist ? 'No backtest watchlist symbols have usable price data.' : 'No backtest symbols pass the price band.', 400);
      // Fetch range plus 90 days of history for indicator warmup.
      const fetchStart = new Date(`${addDaysIso(cappedStart, -90)}T12:00:00Z`).toISOString();
      const fetchEnd = new Date(`${addDaysIso(endDate, 1)}T12:00:00Z`).toISOString();
      const daily = await fetchDailyBars(ctx, symbols, 120);
      const m1 = await fetchMinuteBars(ctx, symbols, fetchStart, fetchEnd);
      guard(lease);
      // Real engine contract (lib/orb/backtest.js):
      // runBacktest({ barsBySymbol, indexData, startDate, endDate, rules,
      //   initialEquity, slippageBps, commissionPerShare, orMinutes })
      //   → { summary, byDirection, byOrDuration, byScoreBucket, byRvolBucket,
      //       byRegime, byTimeOfDay, trades, equityCurve }.
      // barsBySymbol[s] is an array of 1-minute bars {t,o,h,l,c,v} (the
      // engine aggregates daily history itself, strictly point-in-time);
      // indexData carries daily closes for regime classification.
      const barsBySymbol = {};
      for (const s of symbols) barsBySymbol[s] = m1[s] || [];
      const idxDaily = await fetchDailyBars(ctx, ['SPY', 'QQQ', 'IWM', 'VIX'], 120);
      const indexData = {};
      for (const k of ['SPY', 'QQQ', 'IWM', 'VIX']) {
        indexData[k.toLowerCase()] = (idxDaily[k] || []).map(b => ({ t: b.t, c: b.c }));
      }
      const result = runBacktest({ barsBySymbol, indexData, startDate: cappedStart, endDate, rules }) || {};
      const { trades: engineTrades, ...report } = result;
      const id = crypto.randomUUID();
      db.transaction(() => {
        db.prepare('INSERT INTO orb_backtests(id,user_id,params,report,created_at) VALUES (?,?,?,?,?)')
          .run(id, uid, JSON.stringify({ startDate: cappedStart, endDate, rules }), JSON.stringify(report || {}), timestamp());
        const insertTradeRow = db.prepare('INSERT INTO orb_backtest_trades(backtest_id,seq,trade_json) VALUES (?,?,?)');
        (engineTrades || []).forEach((trade, i) => insertTradeRow.run(id, i, JSON.stringify(trade)));
      })();
      db.transaction(() => {
        const old = db.prepare('SELECT id FROM orb_backtests WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 20').all(uid);
        for (const row of old) {
          db.prepare('DELETE FROM orb_backtest_trades WHERE backtest_id=?').run(row.id);
          db.prepare('DELETE FROM orb_backtests WHERE id=?').run(row.id);
        }
      })();
      return { backtestId: id, report, trades: engineTrades };
    });
  }
  function getBacktests(uid) {
    return {
      backtests: db.prepare('SELECT id AS backtestId, params, report, created_at AS createdAt FROM orb_backtests WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(uid)
        .map(r => ({ backtestId: r.backtestId, params: safeJson(r.params, {}), report: safeJson(r.report, {}), createdAt: r.createdAt })),
    };
  }
  function getBacktest(uid, id) {
    const row = db.prepare('SELECT id AS backtestId, params, report, created_at AS createdAt FROM orb_backtests WHERE user_id=? AND id=?').get(uid, id);
    if (!row) throw new OrbError('Backtest not found.', 404);
    const trades = db.prepare('SELECT trade_json FROM orb_backtest_trades WHERE backtest_id=? ORDER BY seq').all(id)
      .map(r => safeJson(r.trade_json, {}));
    return {
      backtestId: row.backtestId, params: safeJson(row.params, {}),
      report: safeJson(row.report, {}), trades, createdAt: row.createdAt,
    };
  }

  const service = {
    strategy: STRATEGY,
    start, stop, drain, lifecycleStatus,
    connect, disconnect,
    setSettings, getSettings: getSettingsView, status,
    dashboard, positions, trades, alerts, universe,
    backtest, getBacktests, getBacktest,
    pruneDiagnostics,
    DEFAULT_ORB_RULES,
    parseWatchlist, // engine-level watchlist normalization (test/UI reuse)
    _scanCycle: scanCycle, // test hook: drive one 60s tick without the scheduler
    _clientId: clientId, // test hook: client order id uniqueness
    _checkNews: checkNews, // test hook: news policy behavior
  };
  return service;
}

// Mount /api/orb/* routes on the app, mirror of flipper's mountFlipper.
// Call convention: mountOrb({ app, service, requireAuth,
// ensureSessionUserInTradingStore }). The 13 routes:
//   GET    /api/orb/status
//   POST   /api/orb/connect
//   POST   /api/orb/disconnect
//   GET    /api/orb/settings
//   PUT    /api/orb/settings
//   GET    /api/orb/dashboard
//   GET    /api/orb/positions
//   GET    /api/orb/trades
//   GET    /api/orb/alerts
//   GET    /api/orb/universe
//   POST   /api/orb/backtest
//   GET    /api/orb/backtests
//   GET    /api/orb/backtests/:id
function mountOrb({ app, service, requireAuth, ensureSessionUserInTradingStore }) {
  if (!app || !service || typeof requireAuth !== 'function') throw new Error('ORB requires an app, a service and requireAuth.');
  const withUser = handler => async (req, res, next) => {
    try {
      // Mirror Flipper: sync the session user into the trading store before
      // any FK-scoped orb_* write.
      const uid = ensureSessionUserInTradingStore
        ? await ensureSessionUserInTradingStore(req)
        : Number(req.session?.userId);
      const result = await handler(uid, req, res);
      // Handlers return plain data; serialize it. If a handler already sent
      // a response (headersSent), leave it alone.
      if (!res.headersSent && result !== undefined) res.json(result);
    } catch (error) {
      // Never surface a broker failure as HTTP 502: the CDN/proxy layer
      // replaces origin 502 bodies with its own error page, so the client
      // could not parse the JSON and showed 'unreadable response' even
      // though the app sent a valid error body (proven in Railway HTTP
      // logs 2026-10-05). 422 keeps the real message intact.
      const status = error instanceof OrbError ? (error.status === 502 ? 422 : error.status) : 500;
      if (!res.headersSent) res.status(status).json({ error: error?.message || 'ORB request failed.' });
    }
  };
  const json = bodyParserJson();
  app.get('/api/orb/status', requireAuth, withUser(uid => service.status(uid)));
  app.post('/api/orb/connect', requireAuth, json, withUser((uid, req) => service.connect(uid, req.body || {})));
  app.post('/api/orb/disconnect', requireAuth, json, withUser(uid => service.disconnect(uid)));
  app.get('/api/orb/settings', requireAuth, withUser(uid => service.getSettings(uid)));
  app.put('/api/orb/settings', requireAuth, json, withUser((uid, req) => service.setSettings(uid, req.body || {})));
  app.get('/api/orb/dashboard', requireAuth, withUser(uid => service.dashboard(uid)));
  app.get('/api/orb/positions', requireAuth, withUser(uid => service.positions(uid)));
  app.get('/api/orb/trades', requireAuth, withUser((uid, req) => service.trades(uid, req.query || {})));
  app.get('/api/orb/alerts', requireAuth, withUser(uid => service.alerts(uid)));
  app.get('/api/orb/universe', requireAuth, withUser(uid => service.universe(uid)));
  app.post('/api/orb/backtest', requireAuth, json, withUser((uid, req) => service.backtest(uid, req.body || {})));
  app.get('/api/orb/backtests', requireAuth, withUser(uid => service.getBacktests(uid)));
  app.get('/api/orb/backtests/:id', requireAuth, withUser((uid, req) => service.getBacktest(uid, req.params.id)));
  return {
    routes: [
      'GET /api/orb/status', 'POST /api/orb/connect', 'POST /api/orb/disconnect',
      'GET /api/orb/settings', 'PUT /api/orb/settings', 'GET /api/orb/dashboard', 'GET /api/orb/positions',
      'GET /api/orb/trades', 'GET /api/orb/alerts', 'GET /api/orb/universe', 'POST /api/orb/backtest',
      'GET /api/orb/backtests', 'GET /api/orb/backtests/:id',
    ],
  };
}

function bodyParserJson() {
  try {
    return require('express').json();
  } catch (_) {
    // Last resort: minimal JSON body reader for our own routes.
    return (req, _res, next) => {
      let data = '';
      req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { req.body = data ? JSON.parse(data) : {}; } catch (_) { req.body = {}; } next(); });
    };
  }
}

module.exports = { createOrbService, mountOrb, OrbError, DEFAULT_ORB_RULES, parseWatchlist };
