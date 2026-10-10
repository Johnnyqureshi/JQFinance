'use strict';

// Flipper Bot — "Invisible Wall Reversal" orchestration service (server-side).
//
// The Flipper engine (lib/flipper/walls, signals, scanner, risk, journal,
// backtest) is pure. This module wires it into the running app the way
// lib/warrior/service.js wires the Warrior strategy: own flipper_* tables,
// own op leases (flipper_leases), a 60s scheduler loop with its first run
// delayed ~90s (staggered after crypto), a 3-candle setup state machine
// (C1 wall test → C2 confirmation → C3 trigger), server-side position
// management, and /api/flipper/* routes via mountFlipper().
//
// B2 / Warrior / Crypto files, tables, routes, schedulers and UI are never
// touched. Zero shared strategy state — every table is flipper_*, every route
// is /api/flipper/*.
//
// Strategy recap (SPEC "Invisible Wall Reversal"): before the open, four
// walls are computed per liquid symbol (yesterday's range high/low + nearest
// fractal swing high/low beyond them). A touch candle — one of the first
// `touchWindowCandles` 15-min candles after 9:30 ET (default 2, replay-
// validated 2026-10-10) — must test-and-reject a wall; the NEXT candle must
// confirm in the opposite direction; entry is a break of the confirmation
// candle's extreme during the 15-min window that follows it only (touch
// 9:30 → trigger 10:00–10:15; touch 9:45 → trigger 10:15–10:30). Stop
// defaults to the touch-candle extreme + buffer; target defaults to the
// opposite range wall.
//
// Safety posture (mirrors Warrior): fail-closed — any broker/data/stale-data/
// order-confirmation/risk failure withholds new orders; open positions are
// reconciled with the broker before acting when state is unknown; fills are
// never assumed. PAPER is the default and only working mode; LIVE connect is
// refused loudly and LIVE orders require rules.tradingMode==='LIVE' AND
// rules.liveEnabled AND rules.liveConfirmed (two switches) — and even then
// are refused because no live credential can exist.

const crypto = require('crypto');
const { computeWalls, DEFAULT_FLIPPER_RULES } = require('./walls');
const { detectWallTest, confirmC2, checkTrigger } = require('./signals');
const { fetchUniverse, fetchQuotes, filterLiquid, rankUniverse } = require('./scanner');
const { sizePosition, computeStop, computeTarget, rejectionStrength, priorityScore, tickPrice } = require('./risk');
const { buildTradeRecord, TRADE_FIELDS } = require('./journal');
const { runBacktest } = require('./backtest');

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced']);
const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const STRATEGY = 'flipper';
const SCOPE = 'flipper'; // broker_account_owners scope for Flipper's dedicated account
const TRIGGER_FRESH_MS = 10 * 60000; // trigger-phase 1m bars must be this fresh
const UNIVERSE_CHUNK = 200;

// ET wall-clock helpers (local copies — no lib/warrior imports).
function easternDate(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}
function easternTimeMinutes(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return get('hour') * 60 + get('minute');
}
// ISO instant for midnight at the start of the given value's New York date.
function easternDayStartUtc(value) {
  const date = easternDate(value);
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(`${date}T12:00:00Z`)));
  const offsetHours = 12 - localHour; // 4 for EDT, 5 for EST
  return new Date(`${date}T00:00:00-${String(offsetHours).padStart(2, '0')}:00`).toISOString();
}
function parseClock(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return fallback;
  const mins = (+m[1]) * 60 + (+m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : fallback;
}

class FlipperError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
function number(value) { return value == null || value === '' ? NaN : Number(value); }
function clientId(...parts) {
  return `flipper-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}
function isoNow(now) { return new Date(now()).toISOString(); }

function createFlipperService({
  db, vault, fetch: fetchBroker, now = () => Date.now(),
  getAutomaticBotContext = async () => null,
  automaticBotSettings = null,
  persistenceReady = () => true,
  durability = null,
  sendEmail = null,
  batchSize = 100, timeoutMs = 10000, leaseMs = 180000,
  exitPoll = null, // { tries, intervalMs } — test seam; production default is 24 x 500ms
}) {
  if (!db || !vault || typeof fetchBroker !== 'function') throw new Error('Flipper requires database, vault and fetch.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Flipper batch size must be an integer between 1 and 1000.');
  let timer = null;
  let running = false;
  let generation = 0;
  let ticking = false;
  let activeTick = null;
  // Remember SIP entitlement failures: once Alpaca 403s a SIP data request,
  // route subsequent data requests straight to IEX instead of failing first.
  let iexFallback = false;
  // Per-day session cache (in-process): adv + yesterday volume per symbol,
  // filled by the pre-market wall pass and used for priority scoring.
  // Key: `${uid}:${tradeDate}`.
  const sessionCache = new Map();
  const timestamp = () => isoNow(now);

  // ---------------------------------------------------------------------------
  // Schema — all flipper_* tables, user-scoped. Created at mount so a cold
  // start works without any migration step. Trade columns are exactly the 20
  // SPEC §18 fields from lib/flipper/journal.js (TRADE_FIELDS).
  // ---------------------------------------------------------------------------
  const tradeFieldDefs = TRADE_FIELDS.map(f => `"${f}" TEXT`).join(',\n    ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS flipper_settings (
      user_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'paper',
      rules TEXT NOT NULL DEFAULT '{}',
      scheduler_status TEXT NOT NULL DEFAULT 'idle',
      scheduler_reason TEXT,
      last_cycle_at TEXT
    );
    CREATE TABLE IF NOT EXISTS flipper_credentials (
      user_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      key_enc TEXT NOT NULL,
      secret_enc TEXT NOT NULL,
      account_id TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (user_id, mode)
    );
    CREATE TABLE IF NOT EXISTS flipper_walls (
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      range_high REAL,
      range_low REAL,
      flip_high REAL,
      flip_low REAL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, symbol, trade_date)
    );
    CREATE TABLE IF NOT EXISTS flipper_setups (
      setup_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      direction TEXT,
      wall_type TEXT,
      wall_price REAL,
      state TEXT,
      c1_json TEXT,
      c2_json TEXT,
      trigger_price REAL,
      stop_price REAL,
      target_price REAL,
      priority_score REAL,
      why TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS flipper_positions (
      position_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT,
      entry_price REAL,
      shares INTEGER,
      stop_price REAL,
      target_price REAL,
      wall_type TEXT,
      wall_price REAL,
      setup_json TEXT,
      entry_at TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS flipper_trades (
      trade_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ${tradeFieldDefs},
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flipper_alerts (
      alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flipper_backtests (
      backtest_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      params TEXT NOT NULL,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flipper_backtest_trades (
      backtest_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      trade_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flipper_scan_runs (
      run_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      trade_date TEXT,
      started_at TEXT NOT NULL,
      universe_n INTEGER NOT NULL DEFAULT 0,
      liquid_n INTEGER NOT NULL DEFAULT 0,
      wall_tested_n INTEGER NOT NULL DEFAULT 0,
      setups_n INTEGER NOT NULL DEFAULT 0,
      triggered_n INTEGER NOT NULL DEFAULT 0,
      errors_n INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS flipper_leases (
      user_id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  // ---------------------------------------------------------------------------
  // Settings, credentials, leases, broker plumbing — mirrors warrior/b2.
  // ---------------------------------------------------------------------------
  const getSettings = uid => db.prepare('SELECT * FROM flipper_settings WHERE user_id=?').get(uid);
  function ensure(uid) {
    db.prepare('INSERT OR IGNORE INTO flipper_settings(user_id) VALUES (?)').run(uid);
    return getSettings(uid);
  }
  function getRules(uid) {
    const settings = ensure(uid);
    let stored = {};
    try { stored = JSON.parse(settings.rules || '{}'); } catch (_) { stored = {}; }
    return { ...DEFAULT_FLIPPER_RULES, ...stored };
  }
  function credential(uid, mode) {
    const row = db.prepare('SELECT * FROM flipper_credentials WHERE user_id=? AND mode=?').get(uid, mode);
    if (!row) return null;
    // A missing or half-encrypted row fails closed, exactly like Warrior/B2.
    if (!vault.isEncrypted(row.key_enc) || !vault.isEncrypted(row.secret_enc)) return null;
    return row;
  }
  const quarantined = account =>
    !!db.prepare('SELECT 1 FROM broker_account_quarantine WHERE account_id=? AND resolved_at IS NULL').get(account);
  const EMAIL_KINDS = new Set(['entry', 'fill', 'stop', 'target', 'exit', 'risk', 'system']);
  function alert(uid, kind, message) {
    // Messages are fixed application text, never upstream error bodies or credentials.
    const previous = db.prepare('SELECT kind,message,created_at FROM flipper_alerts WHERE user_id=? ORDER BY alert_id DESC LIMIT 1').get(uid);
    if (previous?.kind === kind && previous.message === message && now() - Date.parse(previous.created_at) < 300000) return;
    db.prepare('INSERT INTO flipper_alerts(user_id,created_at,kind,message) VALUES (?,?,?,?)')
      .run(uid, timestamp(), kind, message);
    if (sendEmail && EMAIL_KINDS.has(kind)) {
      try { void Promise.resolve(sendEmail({ userId: uid, kind, message })).catch(() => {}); }
      catch (_) { /* alert persistence above is authoritative */ }
    }
  }
  async function locked(uid, work) {
    const token = crypto.randomUUID();
    const leaseUntil = new Date(now() + leaseMs).toISOString();
    const result = db.prepare(`INSERT INTO flipper_leases(user_id,owner,expires_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE flipper_leases.expires_at<=?`).run(uid, token, leaseUntil, timestamp());
    if (!result.changes) throw new FlipperError('Flipper is reconciling this account. Retry shortly.');
    const lease = { uid, token, generation };
    try { return await work(lease); }
    finally {
      db.prepare('DELETE FROM flipper_leases WHERE user_id=? AND owner=?').run(uid, token);
      // Never await this flush on a user-facing path: flush() resolves only
      // after the next throttled mutation checkpoint (up to ~60s), which
      // stalled connect/settings responses past client and edge timeouts
      // (2026-10-05: connects looked hung / returned unreadable responses).
      // flush() marks the mutation dirty synchronously, so the checkpoint
      // still lands on the same schedule. Broker-action flushes stay awaited.
      if (durability?.flush && persistenceReady()) { try { durability.flush('flipper-operation').catch(() => {}); } catch (_) {} }
    }
  }
  function guard(lease) {
    const renewed = db.prepare('UPDATE flipper_leases SET expires_at=? WHERE user_id=? AND owner=? AND expires_at>?')
      .run(new Date(now() + leaseMs).toISOString(), lease.uid, lease.token, timestamp());
    if (!renewed.changes) throw new FlipperError('Flipper lease expired; broker action withheld.');
  }
  function context(uid, lease, mode) {
    const settings = ensure(uid);
    const cred = credential(uid, mode || settings.mode);
    if (!cred) throw new FlipperError('Connect a dedicated Flipper broker account.');
    return { uid, lease, settings, cred, rules: getRules(uid) };
  }
  function authorize(ctx) {
    guard(ctx.lease);
    const current = getSettings(ctx.uid);
    const cred = credential(ctx.uid, ctx.cred.mode);
    if (!cred || cred.account_id !== ctx.cred.account_id || cred.key_enc !== ctx.cred.key_enc ||
        cred.secret_enc !== ctx.cred.secret_enc) {
      throw new FlipperError('Flipper authorization changed; action withheld.');
    }
    const owner = db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (!owner || owner.scope !== SCOPE || owner.user_id !== ctx.uid || owner.mode !== cred.mode || quarantined(cred.account_id)) {
      throw new FlipperError('Flipper broker account ownership is not verified.');
    }
  }
  async function request(cred, path, { method = 'GET', body, data = false, allow404 = false, ctx, entry = false } = {}) {
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
          VALUES ('flipper',?,?,?,?,?,?,?,?,'prepared',datetime('now'))
        `).run(ctx.uid, cred.account_id, cred.mode, method, path, purpose, clientOrderId, JSON.stringify(body || {}));
        ctx.actionIntentId = intent.lastInsertRowid;
      }
      await durability.flush(`flipper-before-${method.toLowerCase()}`);
      if (ctx) authorize(ctx);
    }
    const controller = new AbortController();
    let timeout;
    try {
      const call = (async () => {
        const doFetch = p => fetchBroker(`${data ? DATA : cred.mode === 'live' ? LIVE : PAPER}${p}`, {
          method, signal: controller.signal,
          headers: { 'APCA-API-KEY-ID': vault.decrypt(cred.key_enc), 'APCA-API-SECRET-KEY': vault.decrypt(cred.secret_enc), 'Content-Type': 'application/json' },
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
          const failure = new FlipperError(`Broker request failed (HTTP ${response.status}); action withheld.`, 502);
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
        timeout = setTimeout(() => { controller.abort(); reject(new FlipperError('Broker request timed out; reconciliation required.', 502)); }, timeoutMs);
      })]);
      if (ctx) guard(ctx.lease);
      if (method !== 'GET' && durability?.flush) {
        if (ctx?.actionIntentId) db.prepare(`
          UPDATE automated_action_intents SET state='submitted', broker_order_id=?, updated_at=datetime('now')
          WHERE id=?
        `).run(result?.id || null, ctx.actionIntentId);
        await durability.flush(`flipper-after-${method.toLowerCase()}`);
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
        try { await durability.flush(`flipper-unknown-${method.toLowerCase()}`); } catch (_) {}
      }
      if (error instanceof FlipperError) throw error;
      throw new FlipperError('Broker connection or response failed; action withheld.', 502);
    } finally { clearTimeout(timeout); }
  }
  async function broker(ctx, path, options = {}) {
    return request(ctx.cred, path, { ...options, ctx });
  }
  // Read-only scanner fetch for lib/flipper/scanner.js: routes /v2/assets to
  // the trading API and /v2/stocks/* to the data API, with auth headers and
  // the same SIP→IEX 403 fallback. Matches the (path) => Promise<Response>
  // shape the scanner module expects.
  async function scannerFetch(cred, path) {
    const base = path.startsWith('/v2/stocks/') ? DATA : (cred.mode === 'live' ? LIVE : PAPER);
    const doFetch = p => fetchBroker(`${base}${p}`, {
      headers: { 'APCA-API-KEY-ID': vault.decrypt(cred.key_enc), 'APCA-API-SECRET-KEY': vault.decrypt(cred.secret_enc) },
    });
    let response = await doFetch(path);
    if (path.startsWith('/v2/stocks/') && response.status === 403 && path.includes('feed=sip')) {
      iexFallback = true;
      response = await doFetch(path.replace('feed=sip', 'feed=iex'));
    } else if (path.startsWith('/v2/stocks/') && iexFallback && path.includes('feed=sip')) {
      response = await doFetch(path.replace('feed=sip', 'feed=iex'));
    }
    return response;
  }
  function validateAccount(account, expected) {
    if (typeof account?.id !== 'string' || !account.id.trim() || (expected && account.id !== expected) || account.status !== 'ACTIVE' ||
        account.trading_blocked || account.account_blocked || account.trade_suspended_by_user) {
      throw new FlipperError('Broker account identity or trading permission is not valid.');
    }
  }
  async function orderByClient(ctx, id) {
    return broker(ctx, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`, { allow404: true });
  }
  function release(uid, cred) {
    if (!cred) return;
    const remaining = db.prepare('SELECT 1 FROM flipper_credentials WHERE account_id=?').get(cred.account_id);
    if (!remaining) db.prepare("DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope='flipper'").run(cred.account_id, uid);
  }
  function validateInput(input, allowed, message) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowed.includes(key))) throw new FlipperError(message, 400);
  }

  // ---------------------------------------------------------------------------
  // Connect / disconnect / settings / status
  // ---------------------------------------------------------------------------
  async function connect(uid, input) {
    if (!persistenceReady()) throw new FlipperError('Automated trading persistence is unavailable; Flipper entries remain paused.', 503);
    validateInput(input, ['key', 'secret', 'mode'], 'Only key, secret and mode may be supplied.');
    if (typeof input.key !== 'string' || typeof input.secret !== 'string' ||
        !input.key.trim() || !input.secret.trim() || input.key.length > 512 || input.secret.length > 512) {
      throw new FlipperError('Valid API key and secret are required.', 400);
    }
    // PAPER is the only working mode. A live connect is refused LOUDLY —
    // there is no quiet downgrade to paper.
    if (input.mode !== undefined && String(input.mode).toLowerCase() !== 'paper') {
      throw new FlipperError('LIVE trading is not connected for Flipper — paper is the only working mode. Connect paper keys.', 400);
    }
    return locked(uid, async lease => {
      ensure(uid);
      const next = { mode: 'paper', key_enc: vault.encrypt(input.key.trim()), secret_enc: vault.encrypt(input.secret.trim()) };
      const account = await request(next, '/v2/account');
      validateAccount(account);
      guard(lease);
      db.transaction(() => {
        if (quarantined(account.id)) throw new FlipperError('Broker account is quarantined.');
        const owner = db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at)
          VALUES (?,?,'flipper',?,?) ON CONFLICT(account_id) DO UPDATE SET claimed_at=excluded.claimed_at
          WHERE broker_account_owners.user_id=excluded.user_id AND broker_account_owners.scope='flipper'
            AND broker_account_owners.mode=excluded.mode`).run(account.id, uid, 'paper', timestamp());
        if (!owner.changes) throw new FlipperError('This broker account is already assigned to another user, mode or trading scope.');
        const old = credential(uid, 'paper');
        db.prepare(`INSERT INTO flipper_credentials(user_id,mode,key_enc,secret_enc,account_id,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(user_id,mode) DO UPDATE SET key_enc=excluded.key_enc,secret_enc=excluded.secret_enc,
            account_id=excluded.account_id,updated_at=excluded.updated_at`)
          .run(uid, 'paper', next.key_enc, next.secret_enc, account.id, timestamp());
        release(uid, old);
        // Unlike Warrior's connect-and-go, Flipper ships DISABLED: connecting
        // stores credentials only. Johnny enables the bot himself in the UI.
        db.prepare("UPDATE flipper_settings SET mode='paper',scheduler_status='idle',scheduler_reason=NULL WHERE user_id=?").run(uid);
        automaticBotSettings?.revoke?.(uid, 'flipper');
      })();
      return { ok: true, accountId: account.id };
    });
  }
  async function disconnect(uid) {
    return locked(uid, async lease => {
      ensure(uid);
      // Block while anything is live OR working: an open position or a
      // pending entry order. Disconnecting with a working entry would
      // orphan broker state the service no longer manages.
      const live = db.prepare(`SELECT 1 FROM flipper_positions
        WHERE user_id=? AND status IN ('open','pending_entry') LIMIT 1`).get(uid);
      if (live) throw new FlipperError('Close or flatten all Flipper positions (including pending entries) before disconnecting.');
      const rows = db.prepare('SELECT * FROM flipper_credentials WHERE user_id=?').all(uid);
      db.transaction(() => {
        db.prepare('DELETE FROM flipper_credentials WHERE user_id=?').run(uid);
        rows.forEach(row => release(uid, row));
        db.prepare('UPDATE flipper_settings SET enabled=0 WHERE user_id=?').run(uid);
      });
      void lease;
      return { ok: true };
    });
  }
  // Canonical enum spellings (pinned). Aliases accepted in setSettings and
  // normalized BEFORE validation:
  //   targetMode: 'rr_target' → 'rr' (the UI's spelling)
  //   stopMode:   'dollar' → 'dollars'
  //   sizeMode:   'risk' | 'riskpct' → 'risk_pct'
  const ENUM_ALIASES = {
    targetMode: { rr_target: 'rr' },
    stopMode: { dollar: 'dollars' },
    sizeMode: { risk: 'risk_pct', riskpct: 'risk_pct' },
  };
  const RULE_TYPES = {
    minPrice: 'number', maxPrice: 'number',
    minAvgDailyVolume: 'number', minDayVolume: 'number', maxSpreadPct: 'number',
    includeETFs: 'boolean', scanBudget: 'number',
    swingLookback: 'number', flipGapPct: 'number', flipLookbackBars: 'number',
    wallTolerancePct: 'number', touchWindowCandles: 'number',
    minC1MovePct: 'number', breakoutCancelPct: 'number',
    stopMode: ['structure', 'percent', 'dollars'],
    stopBufferPct: 'number', stopPercent: 'number', stopDollars: 'number',
    targetMode: ['full', 'partial_runner', 'rr'],
    partialPct: 'number', runnerTrailPct: 'number', rrTarget: 'number',
    sizeMode: ['shares', 'dollars', 'risk_pct'],
    defaultShares: 'number', defaultDollars: 'number',
    riskPct: 'number', maxRiskPerTradePct: 'number',
    maxPositions: 'number', maxTradesPerDay: 'number', maxDailyLossPct: 'number',
    eodFlattenTime: 'clock', limitOffsetPct: 'number',
    slippageBps: 'number', commissionPerShare: 'number',
    tradingMode: ['PAPER', 'LIVE'], liveEnabled: 'boolean', liveConfirmed: 'boolean',
  };
  function normalizeRuleValue(key, value) {
    const aliases = ENUM_ALIASES[key];
    if (aliases && typeof value === 'string' && aliases[value] !== undefined) return aliases[value];
    return value;
  }
  function setSettings(uid, input) {
    validateInput(input, ['enabled', 'rules'], 'Only enabled and rules may be changed.');
    return locked(uid, async () => {
      const current = ensure(uid);
      const rules = { ...getRules(uid) };
      const patch = input.rules && typeof input.rules === 'object' ? input.rules : {};
      for (const [key, rawValue] of Object.entries(patch)) {
        const type = RULE_TYPES[key];
        if (!type) throw new FlipperError(`Unknown setting: ${key}.`, 400);
        const value = normalizeRuleValue(key, rawValue);
        if (Array.isArray(type)) {
          if (!type.includes(value)) throw new FlipperError(`${key} must be one of ${type.join(', ')}.`, 400);
        } else if (type === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new FlipperError(`${key} must be a finite non-negative number.`, 400);
        } else if (type === 'boolean') {
          if (typeof value !== 'boolean') throw new FlipperError(`${key} must be boolean.`, 400);
        } else if (type === 'clock') {
          if (typeof value !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) {
            throw new FlipperError(`${key} must be a clock time like "15:55".`, 400);
          }
        }
        rules[key] = value;
      }
      // Sanity: price band ordered, risk budget sane, position caps positive.
      if (!(rules.minPrice <= rules.maxPrice)) {
        throw new FlipperError('minPrice cannot exceed maxPrice.', 400);
      }
      if (rules.riskPct > rules.maxRiskPerTradePct) {
        throw new FlipperError('riskPct cannot exceed maxRiskPerTradePct.', 400);
      }
      if (!(rules.maxPositions >= 1) || !(rules.maxTradesPerDay >= 1)) {
        throw new FlipperError('maxPositions and maxTradesPerDay must be at least 1.', 400);
      }
      const enabled = input.enabled === undefined ? !!current.enabled : !!input.enabled;
      db.prepare('UPDATE flipper_settings SET enabled=?,rules=? WHERE user_id=?')
        .run(Number(enabled), JSON.stringify(rules), uid);
      return status(uid);
    });
  }
  function getSettingsView(uid) {
    const settings = ensure(uid);
    return {
      enabled: !!settings.enabled, mode: settings.mode, rules: getRules(uid),
      liveNote: 'LIVE orders require tradingMode=LIVE AND liveEnabled AND liveConfirmed. Anything less is refused loudly; paper is the only working mode and live connect is refused.',
    };
  }
  function openPositions(uid) {
    return db.prepare("SELECT * FROM flipper_positions WHERE user_id=? AND status IN ('open','pending_entry') ORDER BY entry_at").all(uid);
  }
  function dayStartIso() { return easternDayStartUtc(now()); }
  async function status(uid) {
    const settings = ensure(uid);
    const rules = getRules(uid);
    const cred = credential(uid, settings.mode);
    let account = null;
    if (cred) {
      try { account = await request(cred, '/v2/account'); }
      catch (_) { account = null; /* status must never throw on a broker hiccup */ }
    }
    const openCount = db.prepare("SELECT COUNT(*) AS n FROM flipper_positions WHERE user_id=? AND status IN ('open','pending_entry')").get(uid)?.n || 0;
    const blockers = [];
    if (!cred) blockers.push('Connect a dedicated Flipper paper account.');
    if (!settings.enabled) blockers.push('Flipper is paused.');
    if (rules.tradingMode === 'LIVE') {
      blockers.push('LIVE requested — paper is the only working mode; orders refused until live is connected.');
    }
    return {
      enabled: !!settings.enabled, mode: settings.mode, connected: !!cred,
      accountId: cred?.account_id || null,
      schedulerStatus: settings.scheduler_status || 'idle',
      schedulerReason: settings.scheduler_reason || null,
      lastCycleAt: settings.last_cycle_at || null,
      ready: blockers.length === 0, blockers,
      equity: number(account?.equity) || 0,
      buyingPower: number(account?.buying_power) || 0,
      openPositions: openCount,
    };
  }
  function insertTrade(uid, rec) {
    const cols = TRADE_FIELDS.map(f => `"${f}"`).join(',');
    const placeholders = TRADE_FIELDS.map(() => '?').join(',');
    db.prepare(`INSERT INTO flipper_trades(trade_id,user_id,${cols},created_at) VALUES (?,?,${placeholders},?)`)
      .run(crypto.randomUUID(), uid, ...TRADE_FIELDS.map(f => rec[f] ?? null), timestamp());
  }
  function positions(uid) {
    return { positions: openPositions(uid) };
  }
  function trades(uid, query = {}) {
    const where = ['user_id=?'];
    const args = [uid];
    if (query.symbol) { where.push('ticker=?'); args.push(String(query.symbol).toUpperCase()); }
    const closed = db.prepare(`SELECT * FROM flipper_trades WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`).all(...args);
    // Open positions ride along as journal-shaped rows so the dashboard sees
    // one trade list. Journal keeps exactly the 20 SPEC §18 fields.
    const open = openPositions(uid).map(p => buildTradeRecord({
      ticker: p.symbol, direction: p.direction,
      entryPrice: p.entry_price, wallType: p.wall_type, wallPrice: p.wall_price,
      stopPrice: p.stop_price, targetPrice: p.target_price, positionSize: p.shares,
      entryTimestamp: p.entry_at,
    }));
    const rows = [...open, ...closed].map(r => ({
      ...r, status: r.exitTimestamp ? 'closed' : 'open',
    }));
    return { trades: rows };
  }
  function alerts(uid) {
    return { alerts: db.prepare('SELECT kind,message,created_at AS createdAt FROM flipper_alerts WHERE user_id=? ORDER BY alert_id DESC LIMIT 200').all(uid) };
  }
  function universe(uid) {
    // Today's cached wall set IS the scanned universe (lean DB: no separate
    // universe table, no per-symbol scan metadata).
    const tradeDate = easternDate(now());
    const rows = db.prepare('SELECT symbol,trade_date AS tradeDate FROM flipper_walls WHERE user_id=? AND trade_date=? ORDER BY symbol')
      .all(uid, tradeDate);
    return { universe: rows, total: rows.length, tradeDate };
  }

  // ---------------------------------------------------------------------------
  // Dashboard — SPEC §19: active walls, current price, distance to nearest
  // wall, the setup state machine, and exactly WHY a trade was/wasn't taken.
  // ---------------------------------------------------------------------------
  async function latestPrices(uid, symbols) {
    const out = {};
    if (!symbols.length) return out;
    const settings = getSettings(uid);
    const cred = credential(uid, settings?.mode);
    if (!cred) return out;
    try {
      const data = await request(cred,
        `/v2/stocks/bars/latest?symbols=${symbols.map(encodeURIComponent).join(',')}&feed=sip`, { data: true });
      const bars = data?.bars || {};
      for (const symbol of symbols) {
        const entry = bars[symbol];
        const bar = entry && typeof entry === 'object'
          ? (entry.MinuteBar || entry.minute || entry.DailyBar || entry.daily || entry) : null;
        const price = number(bar?.c);
        const t = bar?.t ? Date.parse(bar.t) : NaN;
        if (Number.isFinite(price) && price > 0 && Number.isFinite(t) && (now() - t) < 15 * 60000) {
          out[symbol] = price;
        }
      }
    } catch (_) { /* display-only: stale prices beat a failed dashboard */ }
    return out;
  }
  async function dashboard(uid) {
    const tradeDate = easternDate(now());
    const settings = ensure(uid);
    const setupRows = db.prepare(`SELECT s.*, w.range_high, w.range_low, w.flip_high, w.flip_low
      FROM flipper_setups s LEFT JOIN flipper_walls w
        ON w.user_id=s.user_id AND w.symbol=s.symbol AND w.trade_date=s.trade_date
      WHERE s.user_id=? AND s.trade_date=?
      ORDER BY COALESCE(s.priority_score,0) DESC, s.symbol`).all(uid, tradeDate);
    const symbols = [...new Set(setupRows.map(r => r.symbol))];
    const prices = await latestPrices(uid, symbols);
    const setups = setupRows.map(r => {
      const walls = {
        rangeHigh: r.range_high ?? null, flipHigh: r.flip_high ?? null,
        rangeLow: r.range_low ?? null, flipLow: r.flip_low ?? null,
      };
      const currentPrice = prices[r.symbol] ?? null;
      let distancePct = null;
      if (currentPrice != null) {
        let best = null;
        for (const w of [walls.rangeHigh, walls.flipHigh, walls.rangeLow, walls.flipLow]) {
          if (!(w > 0)) continue;
          const d = ((currentPrice - w) / w) * 100;
          if (best === null || Math.abs(d) < Math.abs(best)) best = d;
        }
        distancePct = best;
      }
      return {
        symbol: r.symbol, direction: r.direction, wallType: r.wall_type,
        wallPrice: r.wall_price, walls, currentPrice, distancePct,
        state: r.state, why: r.why,
        triggerPrice: r.trigger_price, stopPrice: r.stop_price, targetPrice: r.target_price,
        priorityScore: r.priority_score,
      };
    });
    const dayStart = dayStartIso();
    const todaysTrades = db.prepare(`SELECT * FROM flipper_trades
      WHERE user_id=? AND (entryTimestamp>=? OR exitTimestamp>=?) ORDER BY created_at DESC LIMIT 200`)
      .all(uid, dayStart, dayStart);
    return {
      tradeDate,
      status: {
        enabled: !!settings.enabled, mode: settings.mode,
        schedulerStatus: settings.scheduler_status || 'idle',
        schedulerReason: settings.scheduler_reason || null,
        lastCycleAt: settings.last_cycle_at || null,
      },
      setups, positions: openPositions(uid), todaysTrades,
    };
  }

  // ---------------------------------------------------------------------------
  // Market data — mirrors warrior's guarded broker paths.
  // ---------------------------------------------------------------------------
  async function marketSession(ctx) {
    // Calendar-backed session check: ET-minutes alone would claim "premarket"
    // on a Saturday. Flipper trades the regular session only (09:30–16:00 ET);
    // walls are computed pre-market and entries only fire 10:00–10:15 ET.
    const today = easternDate(now());
    const calendar = await broker(ctx, `/v2/calendar?start=${today}&end=${today}`);
    if (!Array.isArray(calendar)) {
      throw new FlipperError('Broker calendar is unavailable; market-hours state is unknown.');
    }
    if (!calendar.length || !calendar[0]?.date) {
      // A clean empty calendar means no session today (weekend/holiday) —
      // idle, don't alarm. A non-array above is a real data failure.
      const closed = new FlipperError('Market is closed today.');
      closed.marketClosed = true;
      throw closed;
    }
    const clock = await broker(ctx, '/v2/clock');
    const clockTime = Date.parse(clock?.timestamp);
    if (!Number.isFinite(clockTime) || Math.abs(now() - clockTime) > 120000) {
      throw new FlipperError('Broker clock is missing or stale.');
    }
    const mins = easternTimeMinutes(now());
    const inRegular = mins >= 570 && mins < 960;
    return { clock, session: calendar[0], windowOpen: inRegular, regularOpen: inRegular, minutes: mins };
  }
  // Flatten minute: configured eodFlattenTime, or 12:55 on early-close days
  // (Alpaca calendar close ≤ 13:00 ET) per coordinator interpretation #9.
  function flattenMinutes(marketState, rules) {
    const close = parseClock(marketState?.session?.close, 16 * 60);
    if (close <= 13 * 60) return 12 * 60 + 55;
    return parseClock(rules.eodFlattenTime, 15 * 60 + 55);
  }
  async function loadDailyBars(ctx, symbols, sessions = 150) {
    const start = new Date(now() - sessions * 2 * 86400000).toISOString();
    const end = new Date(now()).toISOString();
    const out = Object.fromEntries(symbols.map(s => [s, []]));
    let page = null;
    for (let count = 0; count < 10; count++) {
      const query = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start, end, limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc' });
      if (page) query.set('page_token', page);
      const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
      if (!data?.bars || typeof data.bars !== 'object') throw new FlipperError('Historical daily bars are unavailable.');
      for (const s of symbols) out[s].push(...(data.bars[s] || []));
      page = data.next_page_token;
      if (!page) break;
    }
    for (const s of symbols) {
      out[s] = out[s]
        .filter(b => Number.isFinite(Date.parse(b.t)))
        .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
        .slice(-sessions);
    }
    return out;
  }
  async function loadMinuteBars(ctx, symbols, startIso, endIso) {
    const start = startIso || easternDayStartUtc(now());
    const end = endIso || new Date(now()).toISOString();
    const out = Object.fromEntries(symbols.map(s => [s, []]));
    for (let i = 0; i < symbols.length; i += batchSize) {
      const chunk = symbols.slice(i, i + batchSize);
      let page = null;
      for (let count = 0; count < 10; count++) {
        guard(ctx.lease);
        const query = new URLSearchParams({ symbols: chunk.join(','), timeframe: '1Min', start, end, limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc' });
        if (page) query.set('page_token', page);
        const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
        if (!data?.bars || typeof data.bars !== 'object') throw new FlipperError('Intraday bars are unavailable.');
        for (const s of chunk) out[s].push(...(data.bars[s] || []));
        page = data.next_page_token;
        if (!page) break;
      }
    }
    for (const s of symbols) {
      out[s] = out[s]
        .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
        .filter(b => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite))
        .sort((a, b) => a.t - b.t);
    }
    return out;
  }
  // Aggregate 1m bars into ET 15-min buckets for a trade date. Returns
  // [{t, o, h, l, c, v}] with t = bucket-start ms, oldest → newest.
  function aggregate15(m1, tradeDate) {
    const dayStartMs = Date.parse(easternDayStartUtc(new Date(`${tradeDate}T12:00:00Z`).getTime()));
    const buckets = new Map();
    for (const b of m1) {
      if (easternDate(b.t) !== tradeDate) continue;
      const mins = easternTimeMinutes(b.t);
      const bucket = Math.floor(mins / 15) * 15;
      const t = dayStartMs + bucket * 60000;
      const agg = buckets.get(bucket);
      if (!agg) buckets.set(bucket, { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
      else {
        agg.h = Math.max(agg.h, b.h); agg.l = Math.min(agg.l, b.l);
        agg.c = b.c; agg.v += b.v || 0;
      }
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }
  function sessionCandles(m1, tradeDate) {
    const buckets = new Map();
    for (const c of aggregate15(m1, tradeDate)) buckets.set(easternTimeMinutes(c.t), c);
    return {
      c1: buckets.get(570) || null, // 9:30–9:45
      c2: buckets.get(585) || null, // 9:45–10:00
      c3: buckets.get(600) || null, // 10:00–10:15
    };
  }
  // Generalized setup candles (2026-10-10): the touch candle is identified
  // by its bucket-start minute, which aggregate15 stamps into candle.t.
  // Stored setup candles from before this change may lack `t` — callers
  // fall back to the original single-candle layout (touch 570, confirm 585).
  function candlesByMinute(m1, tradeDate) {
    const buckets = new Map();
    for (const c of aggregate15(m1, tradeDate)) buckets.set(easternTimeMinutes(c.t), c);
    return buckets;
  }
  function candleMinuteOf(candle, fallback) {
    if (!candle || !Number.isFinite(+candle.t)) return fallback;
    const mins = easternTimeMinutes(+candle.t);
    return Number.isFinite(mins) ? mins : fallback;
  }
  function parseStoredCandle(json) {
    try { return JSON.parse(json || 'null'); } catch (_) { return null; }
  }
  function touchWindowCount(rules) {
    const n = Math.floor(+rules?.touchWindowCandles);
    return Number.isFinite(n) && n >= 1 ? Math.min(4, n) : 1;
  }
  function fmtEtMin(mins) {
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
  }

  // risk.js's computeStop documents stopMode 'dollar' (singular) while the
  // pinned API enum spells it 'dollars'. Translate at the call site — the
  // Wave-1 pure modules cannot be edited.
  function stopRules(rules) {
    return rules && rules.stopMode === 'dollars' ? { ...rules, stopMode: 'dollar' } : rules;
  }
  // ---------------------------------------------------------------------------
  // Scan pipeline — pre-market walls, C1 wall tests, C2 confirmation.
  // ---------------------------------------------------------------------------
  function looksLikeEtf(name) {
    return /\b(ETF|ETN)\b/i.test(String(name || ''));
  }
  function cacheKey(uid, tradeDate) { return `${uid}:${tradeDate}`; }
  // Pre-market (first tick of the day, before 9:30 ET): compute + cache the
  // four walls per liquid symbol into flipper_walls. Walls are NEVER
  // recomputed intraday — an existing row for (user, symbol, tradeDate) wins.
  async function ensureWalls(ctx, tradeDate, funnel) {
    const have = db.prepare('SELECT COUNT(*) AS n FROM flipper_walls WHERE user_id=? AND trade_date=?')
      .get(ctx.uid, tradeDate)?.n || 0;
    if (have > 0) return { cached: true, symbols: have };
    guard(ctx.lease);
    const rules = ctx.rules;
    const fetch = p => scannerFetch(ctx.cred, p);
    const catalog = await fetchUniverse({ fetch });
    if (!catalog.length) throw new FlipperError('Tradable asset universe is unavailable.');
    funnel.universe = catalog.length;
    const isEtfBySymbol = {};
    const allSymbols = [];
    for (const entry of catalog) {
      allSymbols.push(entry.symbol);
      isEtfBySymbol[entry.symbol] = looksLikeEtf(entry.name);
    }
    guard(ctx.lease);
    const quotes = await fetchQuotes({ fetch, symbols: allSymbols }, { chunkSize: UNIVERSE_CHUNK });
    // Stage 1: price band on the quote midpoint (cheap, no daily bars yet).
    const pricePassing = allSymbols.filter(s => {
      const q = quotes[s];
      const mid = q && Number.isFinite(q.price) && q.price > 0 ? q.price
        : (Number.isFinite(q?.bid) && Number.isFinite(q?.ask) && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : null);
      return mid != null && mid >= rules.minPrice && mid <= rules.maxPrice;
    });
    guard(ctx.lease);
    // Stage 2: daily bars for the price-passing set → adv + yesterday volume.
    const dailyBySymbol = await loadDailyBars(ctx, pricePassing, 30);
    const dailyStats = {};
    const dayVolumes = {};
    for (const s of pricePassing) {
      const bars = (dailyBySymbol[s] || [])
        .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
        .filter(b => Number.isFinite(b.t))
        .sort((a, b) => a.t - b.t);
      const completed = bars.filter(b => easternDate(b.t) < tradeDate);
      const adv = completed.length >= 20
        ? completed.slice(-20).reduce((sum, b) => sum + (b.v || 0), 0) / 20 : 0;
      const yesterdayVol = completed.length ? (completed[completed.length - 1].v || 0) : 0;
      dailyStats[s] = { adv, dayVolume: yesterdayVol, isEtf: !!isEtfBySymbol[s] };
      dayVolumes[s] = yesterdayVol;
    }
    // Stage 3: liquidity filter (aggregate counts only — no per-symbol
    // rejection rows, ever). minDayVolume is a SESSION-time gate (today's
    // volume is ~0 pre-market), so it is not enforced here; the trigger
    // phase checks it against the live 1-minute tape.
    const liquid = filterLiquid({
      symbols: pricePassing, quotes, dailyStats,
      rules: { ...rules, minDayVolume: 0 },
    });
    funnel.liquid = liquid.passedCount;
    const ranked = rankUniverse({ symbols: liquid.passed, dayVolumes, rules });
    guard(ctx.lease);
    // Deep history for the flip swing search: the ranked set is small
    // (<= scanBudget), so fetch the full flipLookbackBars window only for it.
    const wallBarsBySymbol = await loadDailyBars(ctx, ranked);
    guard(ctx.lease);
    const insert = db.prepare(`INSERT OR IGNORE INTO flipper_walls
      (user_id,symbol,trade_date,range_high,range_low,flip_high,flip_low,created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    const advCache = {};
    let walls = 0;
    for (const symbol of ranked) {
      guard(ctx.lease);
      const bars = (wallBarsBySymbol[symbol] || dailyBySymbol[symbol] || [])
        .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
        .filter(b => Number.isFinite(b.t))
        .sort((a, b) => a.t - b.t);
      let computed;
      try {
        computed = computeWalls({ symbol, tradeDate, dailyBars: bars, rules });
      } catch (error) {
        funnel.errors++;
        continue;
      }
      insert.run(ctx.uid, symbol, tradeDate,
        computed.rangeHigh, computed.rangeLow, computed.flipHigh, computed.flipLow, timestamp());
      advCache[symbol] = { adv: dailyStats[symbol]?.adv || 0, quote: quotes[symbol] || null };
      walls++;
    }
    funnel.walls = walls;
    sessionCache.set(cacheKey(ctx.uid, tradeDate), advCache);
    return { cached: false, symbols: walls };
  }
  function walledSymbols(uid, tradeDate) {
    return db.prepare('SELECT symbol,range_high,range_low,flip_high,flip_low FROM flipper_walls WHERE user_id=? AND trade_date=?')
      .all(uid, tradeDate);
  }
  function wallObject(row) {
    return {
      symbol: row.symbol, tradeDate: row.trade_date,
      rangeHigh: row.range_high, rangeLow: row.range_low,
      flipHigh: row.flip_high, flipLow: row.flip_low,
    };
  }
  // Touch candles complete from 9:45 ET on: aggregate each completed touch
  // candle per walled symbol and record wall tests as setups in state
  // 'testing_wall', with the WHY text for the dashboard (SPEC §19).
  // Test hook: records one C1 wall-test setup row. Extracted so the
  // INSERT's column/placeholder arity is covered by a regression test
  // (2026-09-30: a missing wall_price placeholder threw on every live tick).
  function recordSetup(uid, tradeDate, symbol, cand, c1) {
    const startMin = candleMinuteOf(c1, 570);
    const label = startMin === 570 ? 'C1' : startMin === 585 ? 'C2' : 'Touch candle';
    const why = `${label} (${fmtEtMin(startMin)}-${fmtEtMin(startMin + 15)} ET) tested the ${cand.wallType.replace(/_/g, ' ')} wall at ` +
      `${(+cand.wallPrice).toFixed(2)} and rejected it (tolerance ±${getRules(uid).wallTolerancePct}%). ` +
      `Awaiting confirmation from the next candle.`;
    db.prepare(`INSERT INTO flipper_setups
      (setup_id,user_id,symbol,trade_date,direction,wall_type,wall_price,state,
       c1_json,c2_json,trigger_price,stop_price,target_price,priority_score,why,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'testing_wall',?,NULL,NULL,NULL,NULL,NULL,?,?,?)`)
      .run(crypto.randomUUID(), uid, symbol, tradeDate,
        cand.direction, cand.wallType, cand.wallPrice,
        JSON.stringify(c1), why, timestamp(), timestamp());
    return why;
  }
  // Touch phase (generalized 2026-10-10; replaces the C1-only phase): each
  // of the first `touchWindowCandles` 15-min candles is evaluated as a
  // potential touch candle once it has completed. One setup claim per
  // (symbol, wall) per day — the earliest touch wins, matching the
  // backtester — so re-running a bucket on a later tick (or after a
  // restart) never duplicates a setup.
  async function c1Phase(ctx, tradeDate, funnel) {
    const walls = walledSymbols(ctx.uid, tradeDate);
    if (!walls.length) return { skipped: true, reason: 'no-walls' };
    const minsNow = easternTimeMinutes(now());
    const buckets = [];
    for (let i = 0; i < touchWindowCount(ctx.rules); i++) {
      const touchMin = 570 + i * 15;
      if (minsNow >= touchMin + 15) buckets.push(touchMin);
    }
    if (!buckets.length) return { skipped: true, reason: 'no-completed-touch-candle' };
    const dayStartMs = Date.parse(easternDayStartUtc(now()));
    const lastBucket = buckets[buckets.length - 1];
    const m1 = await loadMinuteBars(ctx, walls.map(w => w.symbol),
      new Date(dayStartMs + 570 * 60000).toISOString(),
      new Date(dayStartMs + (lastBucket + 15) * 60000).toISOString());
    const existing = db.prepare('SELECT symbol,wall_type FROM flipper_setups WHERE user_id=? AND trade_date=?')
      .all(ctx.uid, tradeDate);
    const claimed = new Set(existing.map(r => `${r.symbol}:${r.wall_type}`));
    const insert = (symbol, cand, c1) => recordSetup(ctx.uid, tradeDate, symbol, cand, c1);
    let tested = 0, setups = 0;
    for (const row of walls) {
      guard(ctx.lease);
      const byMinute = candlesByMinute(m1[row.symbol] || [], tradeDate);
      for (const touchMin of buckets) {
        const touch = byMinute.get(touchMin);
        if (!touch) { funnel.errors++; continue; }
        tested++;
        let candidates = [];
        try { candidates = detectWallTest({ walls: wallObject(row), c1: touch, rules: ctx.rules }) || []; }
        catch (_) { candidates = []; }
        for (const cand of candidates) {
          const claimKey = `${row.symbol}:${cand.wallType}`;
          if (claimed.has(claimKey)) continue;
          claimed.add(claimKey);
          insert(row.symbol, cand, touch);
          setups++;
        }
      }
    }
    funnel.wallTested = tested;
    funnel.setups = (funnel.setups || 0) + setups;
    if (setups) alert(ctx.uid, 'system', `Flipper: ${setups} wall-test setup${setups === 1 ? '' : 's'} recorded for ${tradeDate}; awaiting confirmation from the next candle.`);
    return { tested, setups };
  }
  // Confirmation (finalized once the candle after a setup's touch candle
  // completes): confirm for every testing_wall setup → 'waiting_c2' (with
  // trigger level, stop, target and priority score) or 'cancelled', with
  // reasons (SPEC §19).
  async function c2Phase(ctx, tradeDate, funnel) {
    const pending = db.prepare(`SELECT * FROM flipper_setups
      WHERE user_id=? AND trade_date=? AND state='testing_wall'`).all(ctx.uid, tradeDate);
    if (!pending.length) return { skipped: true };
    const symbols = [...new Set(pending.map(p => p.symbol))];
    const dayStartMs = Date.parse(easternDayStartUtc(now()));
    const m1 = await loadMinuteBars(ctx, symbols,
      new Date(dayStartMs + 570 * 60000).toISOString(),
      new Date(dayStartMs + (570 + (touchWindowCount(ctx.rules) + 1) * 15) * 60000).toISOString());
    const cache = sessionCache.get(cacheKey(ctx.uid, tradeDate)) || {};
    const update = db.prepare(`UPDATE flipper_setups SET state=?,c2_json=?,trigger_price=?,
      stop_price=?,target_price=?,priority_score=?,why=?,updated_at=? WHERE setup_id=?`);
    let confirmed = 0, cancelled = 0;
    for (const setup of pending) {
      guard(ctx.lease);
      // The confirmation candle is the candle AFTER this setup's touch
      // candle (touch minute is stamped in the stored touch candle's t;
      // pre-2026-10-10 rows without t fall back to touch 570 / confirm 585).
      const storedTouch = parseStoredCandle(setup.c1_json);
      const touchMin = candleMinuteOf(storedTouch, 570);
      const confirmMin = touchMin + 15;
      if (easternTimeMinutes(now()) < confirmMin + 15) continue; // confirmation candle not complete yet
      const byMinute = candlesByMinute(m1[setup.symbol] || [], tradeDate);
      const c2 = byMinute.get(confirmMin) || null;
      const c1obj = byMinute.get(touchMin) || storedTouch;
      if (!c2 || !c1obj) {
        update.run('cancelled', null, null, null, null, null,
          `${setup.why || ''} C2 candle missing — setup cancelled.`.trim(),
          timestamp(), setup.setup_id);
        cancelled++;
        continue;
      }
      const candidate = { direction: setup.direction, wallType: setup.wall_type, wallPrice: setup.wall_price };
      const walls = {
        symbol: setup.symbol, tradeDate,
        rangeHigh: null, rangeLow: null, flipHigh: null, flipLow: null,
      };
      const wallRow = db.prepare('SELECT range_high,range_low,flip_high,flip_low FROM flipper_walls WHERE user_id=? AND symbol=? AND trade_date=?')
        .get(ctx.uid, setup.symbol, tradeDate);
      if (wallRow) {
        walls.rangeHigh = wallRow.range_high; walls.rangeLow = wallRow.range_low;
        walls.flipHigh = wallRow.flip_high; walls.flipLow = wallRow.flip_low;
      }
      let verdict;
      try { verdict = confirmC2({ candidate, c2, walls, rules: ctx.rules }); }
      catch (error) { verdict = { ok: false, reasons: [`C2 confirmation errored: ${error.message}`] }; }
      const why = `${setup.why || ''} ${(verdict.reasons || []).join(' ')}`.trim();
      if (!verdict.ok) {
        update.run('cancelled', JSON.stringify(c2), null, null, null, null, why, timestamp(), setup.setup_id);
        cancelled++;
        continue;
      }
      const triggerPrice = setup.direction === 'long' ? c2.h : c2.l;
      let stopPrice = NaN, target = NaN;
      try { stopPrice = +computeStop({ direction: setup.direction, c1: c1obj, entryPrice: triggerPrice, rules: stopRules(ctx.rules) }); } catch (_) { /* NaN */ }
      try {
        const tg = computeTarget({ direction: setup.direction, walls, entryPrice: triggerPrice, stopPrice, rules: ctx.rules });
        target = +(tg && typeof tg === 'object' ? tg.target : tg);
      } catch (_) { /* NaN */ }
      // Priority score (SPEC §17): rejection strength + normalized rvol, rr,
      // liquidity and spread tightness (pinned weights in risk.js).
      const entry = cache[setup.symbol] || {};
      const adv = entry.adv || 0;
      const dayVol = (m1[setup.symbol] || []).reduce((s, b) => s + (b.v || 0), 0);
      const q = entry.quote || {};
      const spreadPct = (Number.isFinite(q.bid) && Number.isFinite(q.ask) && q.bid > 0 && q.ask > 0)
        ? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100 : NaN;
      const risk = Math.abs(triggerPrice - stopPrice);
      const reward = Math.abs(target - triggerPrice);
      let score = 0;
      try {
        score = priorityScore({
          rejectionStrength: rejectionStrength({ direction: setup.direction, c1: c1obj, wallPrice: setup.wall_price, rules: ctx.rules }),
          rvol: adv > 0 && dayVol > 0 ? Math.min(1, (dayVol / adv) / 3) : 0.5,
          rr: risk > 0 ? Math.min(1, (reward / risk) / 4) : 0,
          liquidity: adv > 0 ? Math.min(1, adv / 2000000) : 0.5,
          spreadTightness: Number.isFinite(spreadPct)
            ? Math.max(0, Math.min(1, 1 - spreadPct / Math.max(0.01, +ctx.rules.maxSpreadPct || 0.5))) : 0.5,
        });
      } catch (_) { score = 0; }
      update.run('waiting_c2', JSON.stringify(c2), triggerPrice,
        Number.isFinite(stopPrice) ? stopPrice : null,
        Number.isFinite(target) ? target : null,
        score, why, timestamp(), setup.setup_id);
      confirmed++;
    }
    funnel.confirmed = confirmed;
    funnel.cancelled = (funnel.cancelled || 0) + cancelled;
    return { confirmed, cancelled };
  }

  // ---------------------------------------------------------------------------
  // Trigger phase — the 15-min window after each setup's confirmation
  // candle: watch for breaks of the confirmation extreme, rank simultaneous
  // triggers objectively (SPEC §17), then enter with full execution safety
  // (never fire-and-forget).
  // ---------------------------------------------------------------------------
  function executionSafetyCheck(ctx, marketState, rules, funnel) {
    const account = ctx.account;
    if (!account || typeof account.id !== 'string') {
      throw new FlipperError('Broker account is not verified; entries withheld.');
    }
    if (!marketState.regularOpen) throw new FlipperError('Regular session is not open; entries withheld.');
    if (ctx.lease.generation !== generation) throw new FlipperError('Flipper lease generation changed; entries withheld.');
    const flatten = flattenMinutes(marketState, rules);
    if (marketState.minutes >= flatten) throw new FlipperError('EOD flatten window reached; entries withheld.');
    // Daily-loss halt (SPEC §21): halt new entries after -maxDailyLossPct
    // account-equity drawdown from the last day-open reset.
    if (account.last_equity != null) {
      const equity = number(account.equity);
      const lastEquity = number(account.last_equity);
      if (Number.isFinite(equity) && Number.isFinite(lastEquity) && lastEquity > 0 &&
          ((equity - lastEquity) / lastEquity) * 100 <= -rules.maxDailyLossPct) {
        throw new FlipperError('Daily loss limit hit; entries halted for today.');
      }
    }
  }
  async function triggerPhase(ctx, marketState, tradeDate, funnel) {
    const candidates = db.prepare(`SELECT * FROM flipper_setups
      WHERE user_id=? AND trade_date=? AND state='waiting_c2'
      ORDER BY COALESCE(priority_score,0) DESC, symbol`).all(ctx.uid, tradeDate);
    if (!candidates.length) return { triggered: 0, entered: 0 };
    guard(ctx.lease);
    const dayStartMs = Date.parse(easternDayStartUtc(now()));
    // Each setup's trigger window follows ITS confirmation candle:
    // triggerStart = confirm minute + 15, window = [triggerStart, +15).
    // Stored rows without a candle timestamp fall back to confirm 585 →
    // trigger 600–615 (the original layout).
    const windowOf = setup => {
      const confirmMin = candleMinuteOf(parseStoredCandle(setup.c2_json), 585);
      const start = confirmMin + 15;
      return { start, end: start + 15 };
    };
    const earliestStart = Math.min(...candidates.map(s => windowOf(s).start));
    const m1 = await loadMinuteBars(ctx, [...new Set(candidates.map(c => c.symbol))],
      new Date(dayStartMs + earliestStart * 60000).toISOString(), undefined);
    const cache = sessionCache.get(cacheKey(ctx.uid, tradeDate)) || {};
    const mark = db.prepare('UPDATE flipper_setups SET state=?,why=?,updated_at=? WHERE setup_id=?');
    const triggered = [];
    for (const setup of candidates) {
      guard(ctx.lease);
      const { start: triggerStart, end: triggerEnd } = windowOf(setup);
      if (marketState.minutes < triggerStart) continue; // this setup's window has not opened yet
      const windowEnded = marketState.minutes >= triggerEnd;
      // Stale-tape guard: the trigger window's latest 1m bar must be fresh.
      // An empty tape is different from a stale tape: early in the window
      // the first trigger bar may not have been published yet, so keep the
      // setup alive for the next tick instead of cancelling it. Only once
      // the window has ended does an empty tape close the setup out.
      const tape = (m1[setup.symbol] || [])
        .filter(b => easternDate(b.t) === tradeDate && easternTimeMinutes(b.t) >= triggerStart);
      const latestBar = tape.length ? tape[tape.length - 1] : null;
      if (!latestBar) {
        if (windowEnded) {
          mark.run('cancelled', `${setup.why || ''} Trigger window ended before any trigger tape arrived — setup cancelled.`.trim(), timestamp(), setup.setup_id);
        }
        continue;
      }
      if (now() - latestBar.t > TRIGGER_FRESH_MS) {
        funnel.errors++;
        mark.run('cancelled', `${setup.why || ''} Trigger tape is stale — setup cancelled.`.trim(), timestamp(), setup.setup_id);
        continue;
      }
      if (windowEnded) {
        mark.run('cancelled', `${setup.why || ''} Trigger window ended before a trigger fired — setup cancelled.`.trim(), timestamp(), setup.setup_id);
        continue;
      }
      // minDayVolume is a SESSION-time gate: today's 1m volume must qualify.
      const dayVol = tape.reduce((s, b) => s + (b.v || 0), 0);
      if (dayVol < ctx.rules.minDayVolume) {
        mark.run('cancelled', `${setup.why || ''} Today's volume (${dayVol.toLocaleString('en-US')}) below minDayVolume — setup cancelled.`.trim(), timestamp(), setup.setup_id);
        continue;
      }
      const price = latestBar.c;
      const cand = { direction: setup.direction, wallType: setup.wall_type, wallPrice: setup.wall_price };
      const c2 = setup.c2_json ? JSON.parse(setup.c2_json) : null;
      if (!c2) { funnel.errors++; continue; }
      let res;
      try { res = checkTrigger({ candidate: cand, c2, price, rules: ctx.rules }); }
      catch (error) { funnel.errors++; continue; }
      if (!res?.triggered) continue;
      triggered.push({ setup, triggerPrice: +res.entryPrice, price });
    }
    funnel.triggered = triggered.length;
    if (!triggered.length) return { triggered: 0, entered: 0 };
    // Capacity: remaining positions and today's entry budget. Entries are
    // counted from flipper_positions (the journal row is written at exit).
    const openNow = db.prepare("SELECT COUNT(*) AS n FROM flipper_positions WHERE user_id=? AND status IN ('open','pending_entry')").get(ctx.uid)?.n || 0;
    const todayEntries = db.prepare("SELECT COUNT(*) AS n FROM flipper_positions WHERE user_id=? AND entry_at>=?").get(ctx.uid, dayStartIso())?.n || 0;
    let slots = Math.max(0, Math.floor(ctx.rules.maxPositions) - openNow);
    let entriesLeft = Math.max(0, Math.floor(ctx.rules.maxTradesPerDay) - todayEntries);
    let entered = 0;
    // Priority order already: highest priority_score first. Partial-fill
    // fallback: a rejected/failed entry moves to the next-ranked setup.
    for (const item of triggered) {
      if (slots <= 0 || entriesLeft <= 0) {
        mark.run('cancelled', `${item.setup.why || ''} Capacity exhausted — setup cancelled.`.trim(), timestamp(), item.setup.setup_id);
        continue;
      }
      guard(ctx.lease);
      try {
        await enterTrade(ctx, marketState, tradeDate, item.setup, item.triggerPrice, cache, funnel);
        entered++;
        slots--; entriesLeft--;
      } catch (error) {
        funnel.errors++;
        alert(ctx.uid, 'entry', `Flipper: entry for ${item.setup.symbol} ${item.setup.direction} failed safely — ${error.message}`);
      }
    }
    return { triggered: triggered.length, entered };
  }
  async function enterTrade(ctx, marketState, tradeDate, setup, triggerPrice, cache, funnel) {
    const uid = ctx.uid;
    const rules = ctx.rules;
    const account = ctx.account;
    executionSafetyCheck(ctx, marketState, rules, funnel);
    // Re-fetch account before sizing so buying power is current.
    const fresh = await broker(ctx, '/v2/account');
    validateAccount(fresh, account.id);
    const equity = number(fresh.equity) || 0;
    const entryPrice = triggerPrice;
    const stopPrice = setup.stop_price != null ? +setup.stop_price : NaN;
    const targetPrice = setup.target_price != null ? +setup.target_price : NaN;
    if (!(entryPrice > 0)) throw new FlipperError('Trigger price is invalid; entry withheld.');
    const shares = sizePosition({
      direction: setup.direction, entryPrice, stopPrice, equity, rules,
    });
    if (!Number.isFinite(shares) || shares <= 0) {
      db.prepare('UPDATE flipper_setups SET state=?,why=?,updated_at=? WHERE setup_id=?')
        .run('cancelled', `${setup.why || ''} Position sizing returned 0 — setup cancelled.`.trim(), timestamp(), setup.setup_id);
      return;
    }
    const entryTs = new Date(now()).toISOString();
    const offset = 1 + (rules.limitOffsetPct || 0) / 100;
    const limitPrice = setup.direction === 'long' ? entryPrice * offset : entryPrice / offset;
    // Idempotent client_order_id: a retry after a lost response reconciles
    // via :by_client_order_id instead of double-firing (never fire-and-forget).
    const cid = clientId('entry', uid, setup.setup_id, entryPrice.toFixed(4), shares);
    const seen = await orderByClient(ctx, cid);
    if (seen) throw new FlipperError('An entry order for this setup already exists.');
    const side = setup.direction === 'long' ? 'buy' : 'sell';
    const order = await broker(ctx, '/v2/orders', { method: 'POST', entry: true, body: {
      symbol: setup.symbol, qty: shares, side, type: 'limit', time_in_force: 'day',
      limit_price: tickPrice(limitPrice), client_order_id: cid,
    } });
    if (typeof order?.id !== 'string') throw new FlipperError('Broker did not confirm the entry order.');
    const fill = await pollOrder(ctx, order.id, order.status);
    const statusNow = String(fill?.status || '').toLowerCase();
    if (statusNow !== 'filled') {
      // Not filled: release the order. Do NOT assume a partial fill either —
      // reconcile the authoritative quantity and never proceed.
      await cancelOrder(ctx, order.id, order.status);
      db.prepare('UPDATE flipper_setups SET state=?,why=?,updated_at=? WHERE setup_id=?')
        .run('cancelled', `${setup.why || ''} Entry order did not fill — setup cancelled.`.trim(), timestamp(), setup.setup_id);
      return;
    }
    const filledQty = number(fill?.filled_qty) || 0;
    if (filledQty <= 0) throw new FlipperError('Entry fill quantity is invalid; trade withheld.');
    const filledPrice = number(fill?.filled_avg_price) || entryPrice;
    // The journal row is written ONCE at exit (mirrors Warrior): open
    // positions ride along as synthesized journal rows in trades().
    // The setup is marked 'entered' in the same transaction as the position
    // insert, so a crash before attachProtection cannot double-enter it.
    const positionId = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('UPDATE flipper_setups SET state=?,why=?,updated_at=? WHERE setup_id=? AND state=?')
        .run('entered', `${setup.why || ''} Entered ${filledQty} @ ${filledPrice.toFixed(2)} via limit order ${order.id}.`.trim(), timestamp(), setup.setup_id, 'waiting_c2');
      db.prepare(`INSERT INTO flipper_positions
        (position_id,user_id,symbol,direction,entry_price,shares,stop_price,target_price,
         wall_type,wall_price,setup_json,entry_at,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open')`)
        .run(positionId, uid, setup.symbol, setup.direction, filledPrice, Math.round(filledQty),
          Number.isFinite(stopPrice) ? stopPrice : null,
          Number.isFinite(targetPrice) ? targetPrice : null,
          setup.wall_type, +setup.wall_price, setup.c2_json, fill?.filled_at || entryTs);
    })();
    await attachProtection(ctx, positionId, cid);
    alert(ctx.uid, 'entry', `Flipper: ${setup.direction} ${setup.symbol} ×${filledQty} @ ${filledPrice.toFixed(2)} (${setup.wall_type}).`);
    funnel.entries = (funnel.entries || 0) + 1;
  }

  // ---------------------------------------------------------------------------
  // Order helpers + bracket protection + position management.
  // ---------------------------------------------------------------------------
  const EXIT_POLL_DEFAULT = { tries: 24, intervalMs: 500 };
  async function pollOrder(ctx, orderId, initialStatus) {
    let statusNow = initialStatus;
    if (!TERMINAL.has(String(statusNow || '').toLowerCase())) {
      const cfg = exitPoll || EXIT_POLL_DEFAULT;
      for (let i = 0; i < cfg.tries; i++) {
        await new Promise(r => setTimeout(r, cfg.intervalMs));
        guard(ctx.lease);
        const refreshed = await orderById(ctx, orderId);
        statusNow = String(refreshed?.status || '').toLowerCase();
        if (TERMINAL.has(statusNow)) return refreshed;
      }
    }
    return orderById(ctx, orderId);
  }
  async function orderById(ctx, orderId) {
    return broker(ctx, `/v2/orders/${encodeURIComponent(orderId)}`, { allow404: true });
  }
  async function cancelOrder(ctx, orderId, statusNow) {
    const status = String(statusNow || '').toLowerCase();
    if (!orderId || TERMINAL.has(status)) return;
    try { await broker(ctx, `/v2/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE', entry: true }); }
    catch (_) { /* a terminal race may 404 — the order is done either way */ }
  }
  // Bracket/OCO protection: a single OCO order holding the stop-leg and the
  // target-leg, so a crash leaves broker-side protection in place.
  async function attachProtection(ctx, positionId, entryClientId) {
    const position = db.prepare('SELECT * FROM flipper_positions WHERE position_id=?').get(positionId);
    if (!position) return;
    const side = position.direction === 'long' ? 'sell' : 'buy';
    const cid = clientId('protect', ctx.uid, positionId, entryClientId);
    const legs = [];
    const stopCid = clientId('stop', ctx.uid, positionId, entryClientId);
    if (position.stop_price != null && +position.stop_price > 0) {
      legs.push({ id: 'stop', type: 'stop', stop_price: tickPrice(+position.stop_price), client_order_id: stopCid });
    }
    if (position.target_price != null && +position.target_price > 0) {
      legs.push({ id: 'target', type: 'limit', limit_price: tickPrice(+position.target_price),
        client_order_id: clientId('target', ctx.uid, positionId, entryClientId) });
    }
    if (!legs.length) return;
    const seen = await orderByClient(ctx, cid);
    if (seen) return; // already protected — idempotent re-attach is a no-op
    try {
      await broker(ctx, '/v2/orders', { method: 'POST', entry: true, body: {
        symbol: position.symbol, qty: position.shares, side, type: 'market',
        time_in_force: 'gtc', order_class: 'oco', client_order_id: cid,
        legs: legs.map(leg => ({ ...leg, symbol: position.symbol, qty: position.shares, side, time_in_force: 'gtc' })),
      } });
    } catch (error) {
      // Protection refused: never leave a position naked silently. If the
      // broker rejected the OCO outright (422), flatten immediately;
      // otherwise alert LOUD and reconcile on the next tick.
      if (error.httpStatus === 422) {
        alert(ctx.uid, 'risk', `Flipper: protection order for ${position.symbol} was REJECTED by the broker — flattening ${position.shares} shares now.`);
        await closePosition(ctx, positionId, 'protection_rejected', 'Protection order rejected by broker.');
      } else {
        alert(ctx.uid, 'risk', `Flipper: protection order for ${position.symbol} failed to confirm — position may be unprotected; reconciliation required. ${error.message}`);
      }
    }
  }
  async function exitShares(ctx, position, shares, reason) {
    if (!position || shares <= 0) return;
    const side = position.direction === 'long' ? 'sell' : 'buy';
    const cid = clientId('exit', ctx.uid, position.position_id, reason, shares);
    const seen = await orderByClient(ctx, cid);
    if (seen) return; // already working on this exit — idempotent
    const order = await broker(ctx, '/v2/orders', { method: 'POST', entry: true, body: {
      symbol: position.symbol, qty: shares, side, type: 'market', time_in_force: 'day',
      client_order_id: cid,
    } });
    if (typeof order?.id !== 'string') throw new FlipperError('Broker did not confirm the exit order.');
    const fill = await pollOrder(ctx, order.id, order.status);
    if (String(fill?.status || '').toLowerCase() !== 'filled') {
      throw new FlipperError('Exit order did not confirm filled; reconciliation required.');
    }
    return fill;
  }
  // Cancel broker protection legs for a position, then refresh what the
  // broker actually holds. Returns { openOrders, brokerQty }.
  async function cancelProtection(ctx, position) {
    const open = await broker(ctx,
      `/v2/orders?status=open&symbols=${encodeURIComponent(position.symbol)}`);
    // Every Flipper protection client_order_id embeds the full position_id
    // (clientId('stop'|'target'|'protect', uid, positionId, ...)).
    const prefix = position.position_id.slice(0, 8);
    const targets = (Array.isArray(open) ? open : []).filter(o =>
      String(o?.client_order_id || '').includes(prefix));
    for (const o of targets) {
      guard(ctx.lease);
      await cancelOrder(ctx, o.id, o.status);
    }
    const positions = await broker(ctx, '/v2/positions');
    const held = (Array.isArray(positions) ? positions : []).find(p => String(p?.symbol).toUpperCase() === position.symbol);
    return { brokerQty: Math.abs(Math.round(number(held?.qty) || 0)) };
  }
  async function closePosition(ctx, positionId, exitReason, note) {
    const position = db.prepare('SELECT * FROM flipper_positions WHERE position_id=?').get(positionId);
    if (!position || position.status !== 'open') return;
    guard(ctx.lease);
    // Stale-order guard: reconcile the broker before acting.
    const { brokerQty } = await cancelProtection(ctx, position);
    const shares = brokerQty > 0 ? brokerQty : position.shares;
    const exitTs = new Date(now()).toISOString();
    if (shares > 0) {
      const fill = await exitShares(ctx, position, shares, exitReason);
      const exitPrice = number(fill?.filled_avg_price) || position.entry_price;
      db.transaction(() => {
        db.prepare("UPDATE flipper_positions SET status='closed' WHERE position_id=?").run(positionId);
        const rec = buildTradeRecord({
          ticker: position.symbol, direction: position.direction,
          wallType: position.wall_type, wallPrice: position.wall_price,
          entryPrice: position.entry_price, positionSize: position.shares,
          stopPrice: position.stop_price, targetPrice: position.target_price,
          entryTimestamp: position.entry_at, exitTimestamp: exitTs,
          exitPrice, exitReason, notes: note || 'auto-exit',
        });
        const cols = TRADE_FIELDS.map(f => `"${f}"`).join(',');
        const placeholders = TRADE_FIELDS.map(() => '?').join(',');
        db.prepare(`INSERT INTO flipper_trades(trade_id,user_id,${cols},created_at) VALUES (?,?,${placeholders},?)`)
          .run(crypto.randomUUID(), ctx.uid, ...TRADE_FIELDS.map(f => rec[f] ?? null), timestamp());
      })();
      alert(ctx.uid, exitReason === 'stop' ? 'stop' : exitReason === 'target' ? 'target' : 'exit',
        `Flipper: ${position.direction} ${position.symbol} exited (${exitReason}) ${shares} @ ${exitPrice.toFixed(2)}.`);
    } else {
      // Broker holds nothing for this symbol — close locally without an order.
      db.transaction(() => {
        db.prepare("UPDATE flipper_positions SET status='closed' WHERE position_id=?").run(positionId);
        const rec = buildTradeRecord({
          ticker: position.symbol, direction: position.direction,
          wallType: position.wall_type, wallPrice: position.wall_price,
          entryPrice: position.entry_price, positionSize: position.shares,
          stopPrice: position.stop_price, targetPrice: position.target_price,
          entryTimestamp: position.entry_at, exitTimestamp: exitTs,
          exitPrice: position.entry_price, exitReason: 'reconciled_missing', notes: note || 'broker holds zero',
        });
        const cols = TRADE_FIELDS.map(f => `"${f}"`).join(',');
        const placeholders = TRADE_FIELDS.map(() => '?').join(',');
        db.prepare(`INSERT INTO flipper_trades(trade_id,user_id,${cols},created_at) VALUES (?,?,${placeholders},?)`)
          .run(crypto.randomUUID(), ctx.uid, ...TRADE_FIELDS.map(f => rec[f] ?? null), timestamp());
      })();
    }
  }
  // Reconcile every open/pending position with the broker each tick
  // (warrior-style): never trust local state after an unknown outcome.
  async function reconcileBrokerPositions(ctx, positions) {
    guard(ctx.lease);
    const brokerPositions = await broker(ctx, '/v2/positions');
    const held = new Map((Array.isArray(brokerPositions) ? brokerPositions : [])
      .map(p => [String(p?.symbol).toUpperCase(), Math.abs(Math.round(number(p?.qty) || 0))]));
    const openOrders = await broker(ctx, '/v2/orders?status=open');
    const working = new Set((Array.isArray(openOrders) ? openOrders : [])
      .map(o => String(o?.symbol).toUpperCase()));
    for (const position of positions) {
      guard(ctx.lease);
      const qty = held.get(position.symbol) || 0;
      if (position.status === 'pending_entry') {
        // Pending entries resolve to open once the broker confirms a hold.
        if (qty > 0) db.prepare("UPDATE flipper_positions SET status='open',shares=? WHERE position_id=?").run(qty, position.position_id);
        else if (!working.has(position.symbol)) {
          db.prepare("UPDATE flipper_positions SET status='closed' WHERE position_id=?").run(position.position_id);
          alert(ctx.uid, 'system', `Flipper: pending entry for ${position.symbol} has no broker hold and no working order — closed.`);
        }
      } else if (position.status === 'open' && qty === 0 && !working.has(position.symbol)) {
        // Broker holds nothing and nothing is working: close out locally as
        // a reconciled missing position.
        await closePosition(ctx, position.position_id, 'reconciled_missing', 'Broker holds no shares for this position.');
      }
    }
  }
  async function managePositions(ctx, marketState, tradeDate, funnel) {
    const positions = openPositions(ctx.uid);
    if (!positions.length) return;
    await reconcileBrokerPositions(ctx, positions);
    const flattenAt = flattenMinutes(marketState, ctx.rules);
    // Fresh prices for management decisions.
    const symbols = [...new Set(positions.map(p => p.symbol))];
    const dayStartMs = Date.parse(easternDayStartUtc(now()));
    const m1 = await loadMinuteBars(ctx, symbols, new Date(dayStartMs).toISOString(), undefined);
    for (const position of positions) {
      guard(ctx.lease);
      const tape = (m1[position.symbol] || []).filter(b => easternDate(b.t) === tradeDate);
      const price = tape.length ? tape[tape.length - 1].c : NaN;
      if (!Number.isFinite(price)) { funnel.errors++; continue; }
      const rules = ctx.rules;
      // 1) Hard EOD flatten — SPEC §21: the whole book flattens.
      if (marketState.minutes >= flattenAt) {
        await closePosition(ctx, position.position_id, 'eod_flatten', 'EOD flatten.');
        continue;
      }
      const isLong = position.direction === 'long';
      const entry = +position.entry_price;
      const stop = position.stop_price != null ? +position.stop_price : NaN;
      const target = position.target_price != null ? +position.target_price : NaN;
      // 2) Stop / target (broker OCO legs already guard these; the manager
      //    is the local mirror that keeps our books in sync).
      const hitStop = Number.isFinite(stop) && (isLong ? price <= stop : price >= stop);
      const hitTarget = Number.isFinite(target) && (isLong ? price >= target : price <= target);
      if (hitStop) { await closePosition(ctx, position.position_id, 'stop', 'Stop hit.'); continue; }
      if (rules.targetMode === 'full' && hitTarget) {
        await closePosition(ctx, position.position_id, 'target', 'Target hit.'); continue;
      }
      // 3) partial_runner: at the target, sell partialPct% at market, then
      //    trail the remaining runner by runnerTrailPct from the favorable
      //    extreme. target_price is cleared after the partial so it fires once.
      if (rules.targetMode === 'partial_runner' && hitTarget) {
        const partialShares = Math.max(1, Math.floor(position.shares * (rules.partialPct / 100)));
        if (partialShares < position.shares) {
          const { brokerQty } = await cancelProtection(ctx, position);
          const exitQty = Math.min(partialShares, brokerQty > 0 ? brokerQty : position.shares);
          try {
            await exitShares(ctx, position, exitQty, 'partial');
          } catch (error) {
            // Partial exit failed after protection was cancelled — re-arm
            // protection immediately so the runner is never left naked.
            await attachProtection(ctx, position.position_id);
            throw error;
          }
          const remaining = position.shares - exitQty;
          const trailPct = (rules.runnerTrailPct || 1.0) / 100;
          const trailAnchor = isLong ? Math.max(price, entry) : Math.min(price, entry);
          const trailStop = isLong ? trailAnchor * (1 - trailPct) : trailAnchor * (1 + trailPct);
          db.prepare('UPDATE flipper_positions SET shares=?,stop_price=?,target_price=NULL WHERE position_id=?')
            .run(remaining, tickPrice(trailStop), position.position_id);
          await attachProtection(ctx, position.position_id);
          alert(ctx.uid, 'exit', `Flipper: partial +${rules.partialPct}% on ${position.symbol} (${exitQty} shares); runner ${remaining} trails at ${trailStop.toFixed(2)}.`);
          continue;
        }
      }
      // 4) Structure-stop trailing (default stopMode): ratchet the stop to
      //    breakeven once the trade is 1R in profit.
      if (rules.stopMode === 'structure' && Number.isFinite(stop)) {
        const risk = Math.abs(entry - stop);
        const profit = isLong ? price - entry : entry - price;
        if (risk > 0 && profit >= risk) {
          const breakeven = isLong ? Math.max(stop, entry) : Math.min(stop, entry);
          const stored = +position.stop_price;
          const better = isLong ? breakeven > stored : breakeven < stored;
          if (better && Math.abs(breakeven - entry) > 1e-9) {
            await cancelProtection(ctx, position);
            db.prepare('UPDATE flipper_positions SET stop_price=? WHERE position_id=?').run(tickPrice(entry), position.position_id);
            await attachProtection(ctx, position.position_id);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduler loop — mirrors warrior's shape: 60s cadence, first tick delayed
  // ~90s (staggered after crypto), per-user, lease-guarded, fail-closed.
  // ---------------------------------------------------------------------------
  function setSchedulerState(uid, statusValue, reason) {
    db.prepare(`INSERT INTO flipper_settings(user_id,scheduler_status,scheduler_reason,last_cycle_at)
      VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET scheduler_status=excluded.scheduler_status,
        scheduler_reason=excluded.scheduler_reason,last_cycle_at=excluded.last_cycle_at`)
      .run(uid, statusValue, reason || null, timestamp());
  }
  async function scanCycle(uid) {
    return locked(uid, async lease => {
      const tradeDate = easternDate(now());
      const settings = ensure(uid);
      // Disabled users: no scan-run rows, no broker calls — just idle state
      // and a lean prune. Writing a scan row every 60s for a paused bot is
      // exactly the diagnostic noise the lean-DB rules forbid.
      if (!settings.enabled) {
        setSchedulerState(uid, 'idle', 'Flipper is paused.');
        try { await pruneDiagnostics(uid); } catch (_) { /* best-effort */ }
        return;
      }
      if (!persistenceReady()) {
        setSchedulerState(uid, 'error', 'Persistence unavailable; Flipper paused.');
        return;
      }
      const ctx = context(uid, lease);
      const rules = getRules(uid);
      ctx.rules = rules;
      const funnel = {
        universe: 0, liquid: 0, walls: 0, wallTested: 0, setups: 0,
        triggered: 0, entries: 0, errors: 0,
      };
      const runId = crypto.randomUUID();
      db.prepare(`INSERT INTO flipper_scan_runs(run_id,user_id,trade_date,started_at)
        VALUES (?,?,?,?)`).run(runId, uid, tradeDate, timestamp());
      const touch = () => db.prepare(`UPDATE flipper_scan_runs SET
        universe_n=?,liquid_n=?,wall_tested_n=?,setups_n=?,triggered_n=?,errors_n=?
        WHERE run_id=?`).run(funnel.universe, funnel.liquid, funnel.wallTested,
        funnel.setups, funnel.triggered, funnel.errors, runId);
      try {
        const cred = credential(uid, settings.mode);
        if (!cred) throw new FlipperError('Connect a dedicated Flipper broker account.');
        guard(lease);
        // Broker account verification FIRST (mirror warrior/b2): verify
        // identity, trading permission, and the account id we expect, then
        // run the market-session check.
        const account = await broker(ctx, '/v2/account');
        validateAccount(account, cred.account_id);
        ctx.account = account;
        // LIVE orders require BOTH live switches AND a connected live
        // credential. Connect refuses live loudly, so a live credential can
        // never exist — this is defense in depth, never a path to live trading.
        if (rules.tradingMode === 'LIVE' || rules.liveEnabled || rules.liveConfirmed) {
          throw new FlipperError('LIVE requested — paper is the only working mode; orders refused until live is connected.');
        }
        const marketState = await marketSession(ctx);
        const mins = marketState.minutes;
        // Pre-market (first tick before 9:30 ET): compute/cache walls once per
        // symbol/day. This also fills the session cache (adv, quotes) used
        // for priority scoring later.
        if (mins < 570) await ensureWalls(ctx, tradeDate, funnel);
        // Touch candles finalize from the first tick at/after 9:45 ET
        // (each completed touch-window candle is evaluated in turn).
        if (mins >= 585) await c1Phase(ctx, tradeDate, funnel);
        // Confirmation candles finalize from the first tick at/after
        // 10:00 ET (a setup confirms on the candle after its touch).
        if (mins >= 600) await c2Phase(ctx, tradeDate, funnel);
        // Trigger windows follow each confirmation (10:00–10:15 ET for a
        // first-candle touch, 10:15–10:30 for a second-candle touch). The
        // phase also runs on the first tick at/after a window ends solely
        // to close out setups left waiting; triggerPhase itself withholds
        // entries then.
        if (marketState.regularOpen && mins >= 600) {
          await triggerPhase(ctx, marketState, tradeDate, funnel);
        }
        // Position management runs the whole session (and the trigger
        // window): reconcile, stops/targets/partials/trail, EOD flatten.
        await managePositions(ctx, marketState, tradeDate, funnel);
        setSchedulerState(uid, 'ok', null);
        pruneDiagnostics(uid).catch(() => {});
        touch();
      } catch (error) {
        funnel.errors++;
        touch();
        if (error?.marketClosed) {
          setSchedulerState(uid, 'idle', 'Market is closed.');
          return;
        }
        const message = error instanceof FlipperError ? error.message : 'Unexpected Flipper scheduler error; next tick will retry.';
        setSchedulerState(uid, 'error', message);
        if (!(error instanceof FlipperError) && !(error?.httpStatus)) {
          alert(uid, 'system', 'Flipper scheduler errored safely — orders withheld until the next tick.');
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
    // Any flipper_settings row is an identity row (matching the lean-DB
    // identity list). Disabled-but-configured users get prune only (no
    // scan-run rows); only enabled ones trade.
    return db.prepare('SELECT user_id FROM flipper_settings').all().map(r => r.user_id);
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
    // First tick delayed ~90s (staggered after crypto's first tick).
    // CrashGuard: the outer tickAll callback must never reject into the
    // process (e.g. usersWithIdentity() throwing on a DB hiccup).
    const safeTickAll = () => tickAll().catch(error => {
      console.error('[Flipper] scheduler tick escaped containment:', error && error.stack ? error.stack : error);
    });
    timer = setTimeout(() => {
      safeTickAll().then(() => {
        if (running) timer = setInterval(safeTickAll, 60000);
      });
    }, 90000);
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
    return { running, ticking, generation, nextTickMs: timer ? 90000 : null, iexFallback };
  }
  // ---------------------------------------------------------------------------
  // pruneDiagnostics — lean DB retention, mirrors warrior's: 7-day alerts,
  // terminal setups older than 7 days, backtests capped at newest 20
  // (orphan trade rows removed), 30-day scan runs. Real trade records,
  // positions, settings, creds, walls, leases untouched.
  // ---------------------------------------------------------------------------
  async function pruneDiagnostics(uid) {
    try {
      const cutoff = new Date(now() - 7 * 86400000).toISOString();
      db.prepare('DELETE FROM flipper_alerts WHERE user_id=? AND created_at<?').run(uid, cutoff);
      const setupDateCutoff = new Date(now() - 7 * 86400000).toISOString().slice(0, 10);
      db.prepare(`DELETE FROM flipper_setups WHERE user_id=? AND trade_date<?
        AND state IN ('long_triggered','short_triggered','cancelled','expired')`).run(uid, setupDateCutoff);
      const oldBacktests = db.prepare(`SELECT backtest_id FROM flipper_backtests
        WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 20`).all(uid);
      db.transaction(() => {
        for (const row of oldBacktests) {
          db.prepare('DELETE FROM flipper_backtest_trades WHERE backtest_id=?').run(row.backtest_id);
          db.prepare('DELETE FROM flipper_backtests WHERE backtest_id=?').run(row.backtest_id);
        }
      })();
      const runCutoff = new Date(now() - 30 * 86400000).toISOString();
      db.prepare('DELETE FROM flipper_scan_runs WHERE user_id=? AND started_at<?').run(uid, runCutoff);
      if (durability?.flush && persistenceReady()) await durability.flush('flipper-prune');
    } catch (_) { /* pruning is best-effort */ }
  }

  // ---------------------------------------------------------------------------
  // Backtest — point-in-time engine (lib/flipper/backtest.js) over the
  // connected account's own bars, capped to the last 90 days, persisted to
  // flipper_backtests / flipper_backtest_trades.
  // ---------------------------------------------------------------------------
  function addDaysIso(dateStr, days) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  async function backtest(uid, input) {
    validateInput(input, ['symbols', 'from', 'to', 'rules'], 'Only symbols, from, to and rules may be supplied.');
    const settings = ensure(uid);
    const cred = credential(uid, settings.mode);
    if (!cred) throw new FlipperError('Connect a Flipper broker account before running a backtest.', 400);
    const rules = { ...DEFAULT_FLIPPER_RULES, ...(input.rules || {}) };
    const today = easternDate(now());
    const to = typeof input.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : today;
    const from = typeof input.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.from) ? input.from : addDaysIso(to, -29);
    if (from > to) throw new FlipperError('from must not be after to.', 400);
    // Cap the window to the most recent 90 days — the engine needs a 120-bar
    // flip lookback behind 'from', so fetch from-90d to 'to'.
    const earliest = addDaysIso(to, -89);
    const cappedFrom = from < earliest ? earliest : from;
    const symbols = Array.from(new Set((input.symbols || []).map(s => String(s).toUpperCase().trim()).filter(Boolean))).slice(0, 50);
    if (!symbols.length) throw new FlipperError('symbols must be a non-empty array.', 400);
    return locked(uid, async lease => {
      guard(lease);
      const ctx = { uid, lease, settings, cred, rules };
      const fetchStart = new Date(`${addDaysIso(cappedFrom, -90)}T12:00:00Z`).toISOString();
      const fetchEnd = new Date(`${to}T12:00:00Z`).toISOString();
      // 120-bar flip lookback behind 'from': fetch daily bars for the capped
      // range plus 90 days of history in one paginated pass.
      const daily = Object.fromEntries(symbols.map(s => [s, []]));
      let page = null;
      for (let count = 0; count < 10; count++) {
        guard(lease);
        const query = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start: fetchStart, end: fetchEnd, limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc' });
        if (page) query.set('page_token', page);
        const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
        if (!data?.bars || typeof data.bars !== 'object') throw new FlipperError('Backtest bars are unavailable.');
        for (const s of symbols) daily[s].push(...(data.bars[s] || []));
        page = data.next_page_token;
        if (!page) break;
      }
      guard(lease);
      const m1raw = await loadMinuteBars(ctx, symbols, fetchStart, fetchEnd);
      // The engine wants { daily, m15, m1 } per symbol, with the 15m candles
      // aggregated in ET buckets exactly like the live sessionCandles path.
      const barsBySymbol = {};
      for (const s of symbols) {
        const m1 = (m1raw[s] || []).slice().sort((a, b) => a.t - b.t);
        const m15 = [];
        const dates = [...new Set(m1.map(b => easternDate(b.t)))]
          .filter(d => d >= cappedFrom && d <= to).sort();
        for (const d of dates) m15.push(...aggregate15(m1, d));
        const completedDaily = (daily[s] || [])
          .map(b => ({ t: b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
          .filter(b => Number.isFinite(Date.parse(b.t)))
          .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
        barsBySymbol[s] = { daily: completedDaily, m15, m1 };
      }
      // The engine's computeStop documents stopMode 'dollar' (singular);
      // translate the pinned 'dollars' spelling at the call site.
      const { report, trades: engineTrades } = runBacktest({ barsBySymbol, config: { symbols, from: cappedFrom, to, rules: stopRules(rules) } });
      const backtestId = crypto.randomUUID();
      db.transaction(() => {
        db.prepare('INSERT INTO flipper_backtests(backtest_id,user_id,params,report,created_at) VALUES (?,?,?,?,?)')
          .run(backtestId, uid, JSON.stringify({ symbols, from: cappedFrom, to, rules }), JSON.stringify(report), timestamp());
        const insertTradeRow = db.prepare('INSERT INTO flipper_backtest_trades(backtest_id,seq,trade_json) VALUES (?,?,?)');
        engineTrades.forEach((trade, i) => insertTradeRow.run(backtestId, i, JSON.stringify(trade)));
      })();
      // Retention: newest 20 runs only (done inline, same as the prune pass).
      db.transaction(() => {
        const old = db.prepare(`SELECT backtest_id FROM flipper_backtests WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 20`).all(uid);
        for (const row of old) {
          db.prepare('DELETE FROM flipper_backtest_trades WHERE backtest_id=?').run(row.backtest_id);
          db.prepare('DELETE FROM flipper_backtests WHERE backtest_id=?').run(row.backtest_id);
        }
      })();
      return { backtestId, report, trades: engineTrades };
    });
  }
  function getBacktests(uid) {
    return {
      backtests: db.prepare('SELECT backtest_id AS backtestId, params, report, created_at AS createdAt FROM flipper_backtests WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(uid)
        .map(r => ({ backtestId: r.backtestId, params: JSON.parse(r.params || '{}'), report: JSON.parse(r.report || '{}'), createdAt: r.createdAt })),
    };
  }
  function getBacktest(uid, id) {
    const row = db.prepare('SELECT backtest_id AS backtestId, params, report, created_at AS createdAt FROM flipper_backtests WHERE user_id=? AND backtest_id=?').get(uid, id);
    if (!row) throw new FlipperError('Backtest not found.', 404);
    const trades = db.prepare('SELECT trade_json FROM flipper_backtest_trades WHERE backtest_id=? ORDER BY seq').all(id)
      .map(r => JSON.parse(r.trade_json));
    return {
      backtestId: row.backtestId, params: JSON.parse(row.params || '{}'),
      report: JSON.parse(row.report || '{}'), trades, createdAt: row.createdAt,
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
    DEFAULT_FLIPPER_RULES,
    _recordSetup: recordSetup, // test hook: C1 setup INSERT arity regression cover
    _scanCycle: scanCycle, // test hook: live entry tick-clean regression cover
  };
  return service;
}

function bodyParserJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (error) { reject(new FlipperError('Request body is not valid JSON.', 400)); }
    });
    req.on('error', reject);
  });
}

// Mount /api/flipper/* routes on the app, mirror of warrior's mountWarrior.
// Call convention: mountFlipper({ app, service, requireAuth,
// ensureSessionUserInTradingStore }). The 13 routes:
//   GET    /api/flipper/status
//   POST   /api/flipper/connect
//   POST   /api/flipper/disconnect
//   GET    /api/flipper/settings
//   PUT    /api/flipper/settings
//   GET    /api/flipper/dashboard
//   GET    /api/flipper/positions
//   GET    /api/flipper/trades
//   GET    /api/flipper/alerts
//   GET    /api/flipper/universe
//   POST   /api/flipper/backtest
//   GET    /api/flipper/backtests
//   GET    /api/flipper/backtests/:id
function mountFlipper({ app, service, requireAuth, ensureSessionUserInTradingStore }) {
  if (!app || !service || typeof requireAuth !== 'function') throw new Error('Flipper requires an app, a service and requireAuth.');
  const withUser = handler => async (req, res, next) => {
    try {
      // Mirror Warrior: sync the session user into the trading store before
      // any FK-scoped flipper_* write.
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
      const status = error instanceof FlipperError ? (error.status === 502 ? 422 : error.status) : 500;
      if (!res.headersSent) res.status(status).json({ error: error?.message || 'Flipper request failed.' });
    }
  };
  const json = bodyParserJson();
  app.get('/api/flipper/status', requireAuth, withUser(uid => service.status(uid)));
  app.post('/api/flipper/connect', requireAuth, json, withUser((uid, req) => service.connect(uid, req.body || {})));
  app.post('/api/flipper/disconnect', requireAuth, json, withUser(uid => service.disconnect(uid)));
  app.get('/api/flipper/settings', requireAuth, withUser(uid => service.getSettings(uid)));
  app.put('/api/flipper/settings', requireAuth, json, withUser((uid, req) => service.setSettings(uid, req.body || {})));
  app.get('/api/flipper/dashboard', requireAuth, withUser(uid => service.dashboard(uid)));
  app.get('/api/flipper/positions', requireAuth, withUser(uid => service.positions(uid)));
  app.get('/api/flipper/trades', requireAuth, withUser((uid, req) => service.trades(uid, req.query || {})));
  app.get('/api/flipper/alerts', requireAuth, withUser(uid => service.alerts(uid)));
  app.get('/api/flipper/universe', requireAuth, withUser(uid => service.universe(uid)));
  app.post('/api/flipper/backtest', requireAuth, json, withUser((uid, req) => service.backtest(uid, req.body || {})));
  app.get('/api/flipper/backtests', requireAuth, withUser(uid => service.getBacktests(uid)));
  app.get('/api/flipper/backtests/:id', requireAuth, withUser((uid, req) => service.getBacktest(uid, req.params.id)));
  return {
    routes: [
      'GET /api/flipper/status', 'POST /api/flipper/connect', 'POST /api/flipper/disconnect',
      'GET /api/flipper/settings', 'PUT /api/flipper/settings', 'GET /api/flipper/dashboard',
      'GET /api/flipper/positions', 'GET /api/flipper/trades', 'GET /api/flipper/alerts',
      'GET /api/flipper/universe', 'POST /api/flipper/backtest',
      'GET /api/flipper/backtests', 'GET /api/flipper/backtests/:id',
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

module.exports = { createFlipperService, mountFlipper, FlipperError, DEFAULT_FLIPPER_RULES };
