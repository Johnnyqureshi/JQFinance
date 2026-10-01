'use strict';

// Warrior Bot — orchestration service (server-side).
//
// The Warrior engine (lib/warrior/indicators, patterns, scoring, regime,
// risk, backtest, journal) is pure. This module wires it into the running
// app the way lib/b2-service.js wires the B2 strategy: own warrior_*
// tables, own op leases (warrior_leases), a 60s scheduler loop STAGGERED
// ~30s behind B2's loop, a proposal → manual-approval → execution flow,
// server-side position management, and /api/warrior/* routes via
// mountWarrior(). B2 files, tables, routes and UI are never touched.
//
// THE ONE MANUAL CONTROL: the scanner only ever creates PROPOSALS. A trade
// reaches the broker only when the user presses Approve on a specific
// proposal. From the fill onward management is 100% automatic (breakeven,
// partials, trailing, exits, EOD flatten).
//
// Safety posture (mirrors B2): fail-closed — any broker/data/stale-data/
// order-confirmation/risk failure withholds new orders; open positions are
// reconciled with the broker before acting when state is unknown; fills are
// never assumed. PAPER is the default and only working mode; LIVE orders
// require rules.tradingMode==='LIVE' AND rules.liveConfirmed===true (two
// switches) and are refused loudly otherwise.
//
// Live uses incremental computeIntraday per 60s cycle; the backtest route
// documents that it uses the engine's precomputed per-bar path instead.

const crypto = require('crypto');
const { computeIntraday, emaSeries, openingRange, premarketLevels, prevDayLevels, swingPoints, etDateKey, etMinutes, volumeFadeDetected } = require('./indicators');
const { detectAll } = require('./patterns');
const { scoreSetup, DEFAULT_RULES: SCORING_DEFAULTS } = require('./scoring');
const { classifyRegime } = require('./regime');
const { planTrade, checkDailyLimits, validatePreTrade, DEFAULT_DAILY_RULES, PRE_TRADE_CHECKS } = require('./risk');
const { runBacktest, DEFAULT_CONFIG: BACKTEST_DEFAULTS } = require('./backtest');
const { buildTradeRecord, TRADE_FIELDS } = require('./journal');

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced']);
const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const STRATEGY = 'warrior';
const SCOPE = 'warrior'; // broker_account_owners scope for Warrior's dedicated account
const EOD_FLATTEN_MINUTES = 15 * 60 + 55; // 15:55 ET
const PROPOSAL_TTL_MS = 30 * 60 * 1000; // proposals expire 30 minutes after creation
const UNIVERSE_REFRESH_MS = 6 * 3600000;
const QUOTE_MAX_AGE_MS = 60000;
// Premarket priority carry: names that move (screener) or pass phase 1
// during the premarket get this rotation-priority boost so the first
// regular-session scans at 09:30 ET reach them first. Movers lead:
// screener names get the full boost, other phase-1 survivors a smaller
// one, so a premarket mover always outranks a merely-eligible name.
const PREMARKET_PRIORITY_BOOST = 5;
const PREMARKET_PHASE1_BOOST = 2;

// Full §39 config surface. Stored as JSON in warrior_settings.rules; the
// settings UI edits every key below.
const DEFAULT_WARRIOR_RULES = Object.freeze({
  // Setup scoring (spec §16)
  minScoreBull: 9, minScoreNeutral: 10, minScoreBear: 12,
  highQuality: 11, minRR: 2.0, strongRvol: 2, veryStrongRvol: 5,
  // Position sizing
  riskPerTradePct: 0.5, maxRiskPerTradePct: 1.0,
  // Auto-approval (Johnny 2026-09-30): eligible proposals skip the manual
  // size-approval step and go straight to the entry order at a fixed dollar
  // size. All pre-trade gates (paper-only, account, 12-check risk gate,
  // daily limits) still run on every auto-approved proposal.
  autoApprove: true, autoApproveDollars: 500,
  // Daily portfolio guards
  maxDailyLossPct: 2, maxConsecutiveLosses: 3, maxPositions: 3,
  maxTradesPerDay: 10, cooldownMinutesAfterLoss: 15,
  // Position management
  breakevenAction: 'breakeven', // 'breakeven' | 'ema9' | 'none'
  trailingMethod: 'ema9', // 'ema9' | 'atr' | 'swing' | 'vwap' | 'fixedPct'
  partialAtR: 2, partialPct: 0.5,
  // Hold the runners (Johnny 2026-10-01): after the partial banks at
  // +partialAtR, the remainder has NO fixed target — it rides while volume
  // stays strong and exits when volume fades (recent-bar volume below
  // fadeVolumeFraction × the trailing fadeBaselineBars average, over the
  // last fadeStallBars bars) AND price stalls (close below the prior bar's
  // low or below VWAP). The stop-loss ALWAYS stays live; breakeven,
  // trailing, max-hold and EOD flatten are unchanged. Exit reason:
  // 'volume_fade'. Definition lives in indicators.volumeFadeDetected and
  // is shared verbatim with the backtester.
  holdRunners: true,
  fadeVolumeFraction: 0.6, fadeStallBars: 2, fadeBaselineBars: 20,
  maxHoldCandles: 20, eodFlatten: true,
  // Pattern allow-list (checkboxes in settings)
  allowedPatterns: Object.freeze({
    CandleOverCandle: true, MicroPullback: true, BullFlag: true, ABCD: true,
    CupAndHandle: true, InvertedHeadAndShoulders: true, VwapReclaim: true,
  }),
  // Trading-hours toggles (regular session 09:30–16:00 ET is always on).
  // Premarket scanning is ON (Johnny 2026-10-01): small/mid caps start
  // moving well before the open, so scan ticks run from 04:00 ET. Entries
  // stay blocked until 09:30 ET while premarketScanOnly is on (default) —
  // enforced in approveProposal, not just the scheduler.
  premarketEnabled: true, premarketScanOnly: true, afterHoursEnabled: false,
  // Universe filters
  minPrice: 0.1, maxPrice: 20, minAvgDailyVolume: 500000, minDollarVolume: 5000000,
  minRvol: 1.5, minPctGain: 2, maxSpread: 0.01, minMarketCap: 100000000,
  exchanges: Object.freeze(['NASDAQ', 'NYSE', 'NYSE American']),
  scanBudget: 100,
  // Trading mode — PAPER is the default and only working mode. LIVE orders
  // additionally require liveEnabled AND liveConfirmed (two switches).
  tradingMode: 'PAPER', liveEnabled: false, liveConfirmed: false,
});

class WarriorError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
function number(value) { return value == null || value === '' ? NaN : Number(value); }
function clientId(...parts) {
  return `warrior-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}
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

// Pure pre-trade input assembly → the engine's 12-check gate. Exported for
// tests; approveProposal() builds its inputs through this function.
function preTradeInputs({
  marketOpen = false, dataFresh = false, pattern = null,
  indicatorsOk = false, regimeOk = false,
  entry, stop, target, rr, minRR = 2.0,
  buyingPower = 0, notional = 0, shares = 0,
  duplicatePosition = false, dailyLimitsOk = false,
} = {}) {
  return validatePreTrade({
    marketOpen, dataFresh, pattern, indicatorsOk, regimeOk,
    entry, stop, target, rr, minRR,
    buyingPower, notional: shares > 0 ? notional : notional,
    duplicatePosition, dailyLimitsOk,
  });
}

// Level 2 order-flow interface stub (spec L2). Alpaca paper exposes no
// order-book contract, so this always reports unavailable and the engine
// never blocks on it — price/volume confirmation only.
function assessOrderFlow(_symbol) {
  return { available: false, reason: 'Level 2 unavailable on Alpaca paper — price/volume confirmation only' };
}

function createWarriorService({
  db, vault, fetch: fetchBroker, now = () => Date.now(),
  getAutomaticBotContext = async () => null,
  automaticBotSettings = null,
  persistenceReady = () => true,
  durability = null,
  sendEmail = null,
  batchSize = 100, timeoutMs = 10000, leaseMs = 180000,
  exitPoll = null, // { tries, intervalMs } — test seam; production default is 24 x 500ms
}) {
  if (!db || !vault || typeof fetchBroker !== 'function') throw new Error('Warrior requires database, vault and fetch.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Warrior batch size must be an integer between 1 and 1000.');
  let timer = null;
  let running = false;
  let generation = 0;
  let ticking = false;
  let activeTick = null;
  // Remember SIP entitlement failures: once Alpaca 403s a SIP data request,
  // route subsequent data requests straight to IEX instead of failing first.
  let iexFallback = false;
  const timestamp = () => new Date(now()).toISOString();

  // ---------------------------------------------------------------------------
  // Schema — all warrior_* tables, user-scoped. Created at mount so a cold
  // start works without any migration step.
  // ---------------------------------------------------------------------------
  const tradeFieldDefs = TRADE_FIELDS.map(f => `"${f}" TEXT`).join(',\n    ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS warrior_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'paper',
      rules TEXT NOT NULL DEFAULT '{}',
      scheduler_status TEXT NOT NULL DEFAULT 'idle',
      scheduler_reason TEXT,
      last_cycle_at TEXT
    );
    CREATE TABLE IF NOT EXISTS warrior_credentials (
      user_id INTEGER NOT NULL REFERENCES users(id),
      mode TEXT NOT NULL,
      key_enc TEXT NOT NULL,
      secret_enc TEXT NOT NULL,
      account_id TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (user_id, mode)
    );
    CREATE TABLE IF NOT EXISTS warrior_proposals (
      proposal_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      symbol TEXT NOT NULL,
      pattern_name TEXT NOT NULL,
      score REAL NOT NULL,
      entry REAL NOT NULL,
      stop REAL NOT NULL,
      target REAL NOT NULL,
      rr REAL NOT NULL,
      shares_recommended INTEGER NOT NULL,
      reasons TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warrior_positions (
      position_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      symbol TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      entry_price REAL,
      stop_price REAL,
      target_price REAL,
      partial_taken INTEGER NOT NULL DEFAULT 0,
      breakeven_set INTEGER NOT NULL DEFAULT 0,
      trailing_method TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TEXT NOT NULL,
      updated_at TEXT,
      entry_order_id TEXT,
      proposal_id TEXT,
      pattern_name TEXT,
      highest_r REAL NOT NULL DEFAULT 0,
      hold_candles INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS warrior_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      ${tradeFieldDefs},
      created_at TEXT NOT NULL
    );
    -- NOTE: warrior_rejections was removed 2026-09-29 (Johnny: no rejection
    -- logs, no zombie data). The table is dropped at boot by
    -- dropRetiredWarriorRejectionTable(). Rejections are funnel counts only.
    CREATE TABLE IF NOT EXISTS warrior_scan_runs (
      run_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      started_at TEXT NOT NULL,
      symbols_scanned INTEGER NOT NULL DEFAULT 0,
      universe_pass INTEGER NOT NULL DEFAULT 0,
      momentum_pass INTEGER NOT NULL DEFAULT 0,
      pattern_pass INTEGER NOT NULL DEFAULT 0,
      proposals_created INTEGER NOT NULL DEFAULT 0,
      positions_opened INTEGER NOT NULL DEFAULT 0,
      positions_closed INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      regime TEXT,
      detail_json TEXT
    );
    CREATE TABLE IF NOT EXISTS warrior_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warrior_backtests (
      backtest_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      params TEXT NOT NULL,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warrior_backtest_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backtest_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      trade_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warrior_universe (
      symbol TEXT PRIMARY KEY,
      last_scanned TEXT,
      priority REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS warrior_leases (
      user_id INTEGER PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  // Column migrations for databases created before these fields existed.
  // Guarded: ALTER TABLE throws when the column is already present.
  for (const [table, column, ddl] of [
    ['warrior_positions', 'banked_pnl', 'REAL NOT NULL DEFAULT 0'],
    ['warrior_positions', 'exit_oco_id', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); }
    catch (_) { /* column already exists */ }
  }
  // One-shot rules upgrade (Johnny 2026-10-01): premarket scanning ON.
  // Stored rules written before this change carry the old
  // premarketEnabled:false default explicitly, so the new default alone
  // would never reach existing users. Flip it once and stamp the row; a
  // later settings choice to disable premarket is never overridden.
  for (const row of db.prepare('SELECT user_id, rules FROM warrior_settings').all()) {
    let stored = null;
    try { stored = JSON.parse(row.rules || '{}'); } catch (_) { stored = null; }
    if (!stored || typeof stored !== 'object' || stored.warriorPremarketV1) continue;
    stored.premarketEnabled = true;
    stored.warriorPremarketV1 = true;
    db.prepare('UPDATE warrior_settings SET rules=? WHERE user_id=?').run(JSON.stringify(stored), row.user_id);
  }

  // ---------------------------------------------------------------------------
  // Settings, credentials, leases, broker plumbing — mirrors b2-service.
  // ---------------------------------------------------------------------------
  const getSettings = uid => db.prepare('SELECT * FROM warrior_settings WHERE user_id=?').get(uid);
  function ensure(uid) {
    db.prepare('INSERT OR IGNORE INTO warrior_settings(user_id) VALUES (?)').run(uid);
    return getSettings(uid);
  }
  function getRules(uid) {
    const settings = ensure(uid);
    let stored = {};
    try { stored = JSON.parse(settings.rules || '{}'); } catch (_) { stored = {}; }
    const merged = { ...DEFAULT_WARRIOR_RULES, ...stored };
    merged.allowedPatterns = { ...DEFAULT_WARRIOR_RULES.allowedPatterns, ...(stored.allowedPatterns || {}) };
    if (!Array.isArray(merged.exchanges)) merged.exchanges = [...DEFAULT_WARRIOR_RULES.exchanges];
    return merged;
  }
  function credential(uid, mode) {
    const row = db.prepare('SELECT * FROM warrior_credentials WHERE user_id=? AND mode=?').get(uid, mode);
    if (!row) return null;
    // A missing or half-encrypted row fails closed, exactly like B2.
    if (!vault.isEncrypted(row.key_enc) || !vault.isEncrypted(row.secret_enc)) return null;
    return row;
  }
  const quarantined = account =>
    !!db.prepare('SELECT 1 FROM broker_account_quarantine WHERE account_id=? AND resolved_at IS NULL').get(account);
  const EMAIL_KINDS = new Set(['proposal', 'approval', 'fill', 'stop', 'target', 'exit', 'risk', 'system']);
  function alert(uid, kind, message) {
    // Messages are fixed application text, never upstream error bodies or credentials.
    const previous = db.prepare('SELECT kind,message,created_at FROM warrior_alerts WHERE user_id=? ORDER BY id DESC LIMIT 1').get(uid);
    if (previous?.kind === kind && previous.message === message && now() - Date.parse(previous.created_at) < 300000) return;
    db.prepare('INSERT INTO warrior_alerts(user_id,kind,message,created_at) VALUES (?,?,?,?)')
      .run(uid, kind, message, timestamp());
    // Email only when a sender is injected AND configured — b2-service has no
    // email path at all, so by default alerts live in warrior_alerts only.
    if (sendEmail && EMAIL_KINDS.has(kind)) {
      try { void Promise.resolve(sendEmail({ userId: uid, kind, message })).catch(() => {}); }
      catch (_) { /* alert persistence above is authoritative */ }
    }
  }
  async function locked(uid, work) {
    const token = crypto.randomUUID();
    const result = db.prepare(`INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
      WHERE warrior_leases.expires_at<=?`).run(uid, token, now() + leaseMs, now());
    if (!result.changes) throw new WarriorError('Warrior is reconciling this account. Retry shortly.');
    const lease = { uid, token, generation };
    try { return await work(lease); }
    finally {
      db.prepare('DELETE FROM warrior_leases WHERE user_id=? AND token=?').run(uid, token);
      if (durability?.flush && persistenceReady()) await durability.flush('warrior-operation');
    }
  }
  function guard(lease) {
    const renewed = db.prepare('UPDATE warrior_leases SET expires_at=? WHERE user_id=? AND token=? AND expires_at>?')
      .run(now() + leaseMs, lease.uid, lease.token, now());
    if (!renewed.changes) throw new WarriorError('Warrior lease expired; broker action withheld.');
  }
  function context(uid, lease, mode) {
    const settings = ensure(uid);
    const cred = credential(uid, mode || settings.mode);
    if (!cred) throw new WarriorError('Connect a dedicated Warrior broker account.');
    return { uid, lease, settings, cred, rules: getRules(uid) };
  }
  function authorize(ctx) {
    guard(ctx.lease);
    const current = getSettings(ctx.uid);
    const cred = credential(ctx.uid, ctx.cred.mode);
    if (!cred || cred.account_id !== ctx.cred.account_id || cred.key_enc !== ctx.cred.key_enc ||
        cred.secret_enc !== ctx.cred.secret_enc) {
      throw new WarriorError('Warrior authorization changed; action withheld.');
    }
    const owner = db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (!owner || owner.scope !== SCOPE || owner.user_id !== ctx.uid || owner.mode !== cred.mode || quarantined(cred.account_id)) {
      throw new WarriorError('Warrior broker account ownership is not verified.');
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
          VALUES ('warrior',?,?,?,?,?,?,?,?,'prepared',datetime('now'))
        `).run(ctx.uid, cred.account_id, cred.mode, method, path, purpose, clientOrderId, JSON.stringify(body || {}));
        ctx.actionIntentId = intent.lastInsertRowid;
      }
      await durability.flush(`warrior-before-${method.toLowerCase()}`);
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
          const failure = new WarriorError(`Broker request failed (HTTP ${response.status}); action withheld.`, 502);
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
        timeout = setTimeout(() => { controller.abort(); reject(new WarriorError('Broker request timed out; reconciliation required.', 502)); }, timeoutMs);
      })]);
      if (ctx) guard(ctx.lease);
      if (method !== 'GET' && durability?.flush) {
        if (ctx?.actionIntentId) db.prepare(`
          UPDATE automated_action_intents SET state='submitted', broker_order_id=?, updated_at=datetime('now')
          WHERE id=?
        `).run(result?.id || null, ctx.actionIntentId);
        await durability.flush(`warrior-after-${method.toLowerCase()}`);
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
        try { await durability.flush(`warrior-unknown-${method.toLowerCase()}`); } catch (_) {}
      }
      if (error instanceof WarriorError) throw error;
      throw new WarriorError('Broker connection or response failed; action withheld.', 502);
    } finally { clearTimeout(timeout); }
  }
  async function broker(ctx, path, options = {}) {
    return request(ctx.cred, path, { ...options, ctx });
  }
  function validateAccount(account, expected) {
    if (typeof account?.id !== 'string' || !account.id.trim() || (expected && account.id !== expected) || account.status !== 'ACTIVE' ||
        account.trading_blocked || account.account_blocked || account.trade_suspended_by_user) {
      throw new WarriorError('Broker account identity or trading permission is not valid.');
    }
  }
  async function orderByClient(ctx, id) {
    return broker(ctx, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`, { allow404: true });
  }
  function release(uid, cred) {
    if (!cred) return;
    const remaining = db.prepare('SELECT 1 FROM warrior_credentials WHERE account_id=?').get(cred.account_id);
    if (!remaining) db.prepare("DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope='warrior'").run(cred.account_id, uid);
  }
  function validateInput(input, allowed, message) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowed.includes(key))) throw new WarriorError(message, 400);
  }

  // ---------------------------------------------------------------------------
  // Connect / disconnect / settings / status
  // ---------------------------------------------------------------------------
  async function connect(uid, input) {
    if (!persistenceReady()) throw new WarriorError('Automated trading persistence is unavailable; Warrior entries remain paused.', 503);
    validateInput(input, ['key', 'secret'], 'Only key and secret may be supplied.');
    if (typeof input.key !== 'string' || typeof input.secret !== 'string' ||
        !input.key.trim() || !input.secret.trim() || input.key.length > 512 || input.secret.length > 512) {
      throw new WarriorError('Valid API key and secret are required.', 400);
    }
    return locked(uid, async lease => {
      const settings = ensure(uid);
      const next = { mode: 'paper', key_enc: vault.encrypt(input.key.trim()), secret_enc: vault.encrypt(input.secret.trim()) };
      const account = await request(next, '/v2/account');
      validateAccount(account);
      guard(lease);
      db.transaction(() => {
        if (quarantined(account.id)) throw new WarriorError('Broker account is quarantined.');
        const owner = db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at)
          VALUES (?,?,'warrior',?,?) ON CONFLICT(account_id) DO UPDATE SET claimed_at=excluded.claimed_at
          WHERE broker_account_owners.user_id=excluded.user_id AND broker_account_owners.scope='warrior'
            AND broker_account_owners.mode=excluded.mode`).run(account.id, uid, 'paper', timestamp());
        if (!owner.changes) throw new WarriorError('This broker account is already assigned to another user, mode or trading scope.');
        const old = credential(uid, 'paper');
        db.prepare(`INSERT INTO warrior_credentials(user_id,mode,key_enc,secret_enc,account_id,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(user_id,mode) DO UPDATE SET key_enc=excluded.key_enc,secret_enc=excluded.secret_enc,
            account_id=excluded.account_id,updated_at=excluded.updated_at`)
          .run(uid, 'paper', next.key_enc, next.secret_enc, account.id, timestamp());
        release(uid, old);
        // Connect-and-go for paper: the scanner starts creating proposals
        // immediately (proposals still need manual approval — nothing trades
        // on its own). Live is never connected here.
        db.prepare("UPDATE warrior_settings SET mode='paper',enabled=1,scheduler_status='idle',scheduler_reason=NULL WHERE user_id=?").run(uid);
        automaticBotSettings?.revoke?.(uid, 'warrior');
      })();
      void settings;
      return status(uid);
    });
  }
  async function disconnect(uid) {
    return locked(uid, async lease => {
      ensure(uid);
      // Block while anything is live OR working: an open position or a
      // pending entry order. Disconnecting with a working entry would
      // orphan broker state the service no longer manages.
      const live = db.prepare(`SELECT 1 FROM warrior_positions
        WHERE user_id=? AND status IN ('open','pending_entry') LIMIT 1`).get(uid);
      if (live) throw new WarriorError('Close or flatten all Warrior positions (including pending entries) before disconnecting.');
      const rows = db.prepare('SELECT * FROM warrior_credentials WHERE user_id=?').all(uid);
      db.transaction(() => {
        db.prepare('DELETE FROM warrior_credentials WHERE user_id=?').run(uid);
        rows.forEach(row => release(uid, row));
        db.prepare('UPDATE warrior_settings SET enabled=0 WHERE user_id=?').run(uid);
      });
      void lease;
      return status(uid);
    });
  }
  const RULE_TYPES = {
    minScoreBull: 'number', minScoreNeutral: 'number', minScoreBear: 'number',
    highQuality: 'number', minRR: 'number', strongRvol: 'number', veryStrongRvol: 'number',
    riskPerTradePct: 'number', maxRiskPerTradePct: 'number',
    autoApprove: 'boolean', autoApproveDollars: 'number',
    maxDailyLossPct: 'number', maxConsecutiveLosses: 'number', maxPositions: 'number',
    maxTradesPerDay: 'number', cooldownMinutesAfterLoss: 'number',
    breakevenAction: ['breakeven', 'ema9', 'none'],
    trailingMethod: ['ema9', 'atr', 'swing', 'vwap', 'fixedPct'],
    partialAtR: 'number', partialPct: 'number',
    holdRunners: 'boolean',
    fadeVolumeFraction: 'number', fadeStallBars: 'number', fadeBaselineBars: 'number',
    maxHoldCandles: 'number', eodFlatten: 'boolean',
    premarketEnabled: 'boolean', premarketScanOnly: 'boolean', afterHoursEnabled: 'boolean',
    minPrice: 'number', maxPrice: 'number', minAvgDailyVolume: 'number', minDollarVolume: 'number',
    minRvol: 'number', minPctGain: 'number', maxSpread: 'number', minMarketCap: 'number',
    scanBudget: 'number',
    tradingMode: ['PAPER', 'LIVE'], liveEnabled: 'boolean', liveConfirmed: 'boolean',
  };
  function setSettings(uid, input) {
    validateInput(input, ['enabled', 'rules', 'allowedPatterns', 'exchanges'], 'Only enabled, rules, allowedPatterns and exchanges may be changed.');
    return locked(uid, async () => {
      const current = ensure(uid);
      const rules = { ...getRules(uid) };
      const patch = input.rules && typeof input.rules === 'object' ? input.rules : {};
      for (const [key, value] of Object.entries(patch)) {
        const type = RULE_TYPES[key];
        if (!type) throw new WarriorError(`Unknown setting: ${key}.`, 400);
        if (Array.isArray(type)) {
          if (!type.includes(value)) throw new WarriorError(`${key} must be one of ${type.join(', ')}.`, 400);
        } else if (type === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new WarriorError(`${key} must be a finite non-negative number.`, 400);
        } else if (type === 'boolean') {
          if (typeof value !== 'boolean') throw new WarriorError(`${key} must be boolean.`, 400);
        }
        rules[key] = value;
      }
      if (input.allowedPatterns && typeof input.allowedPatterns === 'object') {
        for (const [name, on] of Object.entries(input.allowedPatterns)) {
          if (!(name in DEFAULT_WARRIOR_RULES.allowedPatterns)) throw new WarriorError(`Unknown pattern: ${name}.`, 400);
          if (typeof on !== 'boolean') throw new WarriorError(`Pattern ${name} must be boolean.`, 400);
          rules.allowedPatterns[name] = on;
        }
      }
      if (input.exchanges !== undefined) {
        if (!Array.isArray(input.exchanges) || !input.exchanges.every(e => typeof e === 'string')) {
          throw new WarriorError('exchanges must be an array of strings.', 400);
        }
        rules.exchanges = input.exchanges;
      }
      // Sanity: score minimums stay ordered, risk budget stays sane.
      if (!(rules.minScoreBull <= rules.minScoreNeutral && rules.minScoreNeutral <= rules.minScoreBear)) {
        throw new WarriorError('Score minimums must satisfy bull ≤ neutral ≤ bear.', 400);
      }
      if (rules.riskPerTradePct > rules.maxRiskPerTradePct) {
        throw new WarriorError('riskPerTradePct cannot exceed maxRiskPerTradePct.', 400);
      }
      const enabled = input.enabled === undefined ? !!current.enabled : !!input.enabled;
      db.prepare('UPDATE warrior_settings SET enabled=?,rules=? WHERE user_id=?')
        .run(Number(enabled), JSON.stringify({ ...rules, allowedPatterns: rules.allowedPatterns, exchanges: rules.exchanges }), uid);
      return status(uid);
    });
  }
  function getSettingsView(uid) {
    const settings = ensure(uid);
    const rules = getRules(uid);
    return {
      enabled: !!settings.enabled, mode: settings.mode, rules,
      orderFlow: assessOrderFlow(null), // L2 stub surfaced in settings
      marketCapNote: 'minMarketCap is inert: the Alpaca paper plan exposes no market-cap field, so the filter cannot be evaluated.',
      liveNote: 'LIVE orders require tradingMode=LIVE AND liveEnabled AND liveConfirmed. Anything less is refused loudly; paper is the only working mode.',
    };
  }
  function openPositions(uid) {
    return db.prepare("SELECT * FROM warrior_positions WHERE user_id=? AND status='open' ORDER BY opened_at").all(uid);
  }
  function dailyStats(uid, equity) {
    const today = easternDate(now());
    const closedToday = db.prepare('SELECT * FROM warrior_trades WHERE user_id=? AND date=?').all(uid, today);
    const dayPnl = closedToday.reduce((sum, t) => sum + (number(t.pnl) || 0), 0);
    const recent = db.prepare('SELECT pnl, exitedAt FROM warrior_trades WHERE user_id=? AND exitedAt IS NOT NULL ORDER BY exitedAt DESC LIMIT 20').all(uid);
    let consecutiveLosses = 0;
    let minutesSinceLastLoss = null;
    for (const t of recent) {
      if ((number(t.pnl) || 0) < 0) {
        consecutiveLosses++;
        if (minutesSinceLastLoss === null && t.exitedAt) minutesSinceLastLoss = (now() - Date.parse(t.exitedAt)) / 60000;
      } else break;
    }
    return {
      dayPnl, consecutiveLosses, minutesSinceLastLoss,
      openPositions: openPositions(uid).length,
      tradesToday: closedToday.length + openPositions(uid).length,
      equity: number(equity) || 0,
    };
  }
  async function status(uid) {
    const settings = ensure(uid);
    const rules = getRules(uid);
    const cred = credential(uid, settings.mode);
    let account = null;
    if (cred) {
      try {
        account = await request(cred, '/v2/account');
      } catch (_) { account = null; /* status must never throw on a broker hiccup */ }
    }
    const equity = number(account?.equity) || 0;
    const stats = dailyStats(uid, equity);
    const limits = checkDailyLimits({
      dayPnl: stats.dayPnl, equity, consecutiveLosses: stats.consecutiveLosses,
      openPositions: stats.openPositions, tradesToday: stats.tradesToday,
      minutesSinceLastLoss: stats.minutesSinceLastLoss,
      rules: { maxDailyLossPct: rules.maxDailyLossPct, maxConsecutiveLosses: rules.maxConsecutiveLosses,
        maxPositions: rules.maxPositions, maxTradesPerDay: rules.maxTradesPerDay,
        cooldownMinutesAfterLoss: rules.cooldownMinutesAfterLoss },
    });
    const allTrades = db.prepare('SELECT pnl FROM warrior_trades WHERE user_id=? AND exitedAt IS NOT NULL').all(uid);
    const wins = allTrades.filter(t => (number(t.pnl) || 0) > 0).length;
    const lastRun = db.prepare('SELECT regime,started_at FROM warrior_scan_runs WHERE user_id=? ORDER BY started_at DESC LIMIT 1').get(uid);
    const blockers = [];
    if (!cred) blockers.push('Connect a dedicated Warrior paper account.');
    if (!settings.enabled) blockers.push('Scanner is paused.');
    if (!limits.ok) blockers.push(...limits.reasons);
    const liveRequested = rules.tradingMode === 'LIVE';
    if (liveRequested && !(rules.liveEnabled && rules.liveConfirmed)) {
      blockers.push('LIVE requested without both live switches — orders refused until liveEnabled and liveConfirmed are both set.');
    } else if (liveRequested) {
      blockers.push('LIVE requested but no live connection exists — paper is the only working mode; orders refused.');
    }
    return {
      connected: !!cred, mode: settings.mode, accountId: cred?.account_id || null,
      enabled: !!settings.enabled, ready: blockers.length === 0, blockers,
      equity, buyingPower: number(account?.buying_power) || 0,
      todayPnl: stats.dayPnl, todayR: null, // R is per-trade; summed below when available
      openPositions: stats.openPositions, dailyLoss: Math.min(0, stats.dayPnl),
      tradeCount: allTrades.length, winRate: allTrades.length ? wins / allTrades.length : null,
      regime: lastRun?.regime || null,
      rules,
      orderFlow: assessOrderFlow(null),
      scheduler: { lastCycleAt: settings.last_cycle_at || null, status: settings.scheduler_status || 'idle', reason: settings.scheduler_reason || null },
    };
  }
  function proposals(uid, query = {}) {
    const statuses = String(query.status || 'pending').split(',').map(s => s.trim()).filter(Boolean);
    const placeholders = statuses.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM warrior_proposals WHERE user_id=? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 200`)
      .all(uid, ...statuses);
    return { proposals: rows.map(r => ({ ...r, reasons: JSON.parse(r.reasons || '[]') })) };
  }
  function positions(uid) {
    return { positions: openPositions(uid) };
  }
  function trades(uid, query = {}) {
    const where = ['user_id=?'];
    const args = [uid];
    if (query.symbol) { where.push('ticker=?'); args.push(String(query.symbol).toUpperCase()); }
    const closed = db.prepare(`SELECT * FROM warrior_trades WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`).all(...args);
    // Open positions ride along as journal-shaped rows so the dashboard and
    // home card see one trade list.
    const open = openPositions(uid).map(p => buildTradeRecord({
      tradeId: p.position_id, ticker: p.symbol, date: easternDate(p.opened_at),
      enteredAt: p.opened_at, pattern: p.pattern_name, entryPrice: p.entry_price,
      stopPrice: p.stop_price, targetPrice: p.target_price, shares: p.qty,
      orderStatus: p.qty > 0 ? 'filled' : 'pending',
    }));
    const rows = [...open, ...closed].map(r => ({
      ...r,
      status: r.exitedAt ? 'closed' : 'open',
      createdAt: r.enteredAt || null,
    }));
    return { trades: rows };
  }
  function alerts(uid) {
    return { alerts: db.prepare('SELECT kind,message,created_at AS createdAt FROM warrior_alerts WHERE user_id=? ORDER BY id DESC LIMIT 200').all(uid) };
  }
  function universe(uid) {
    // Deliberately global: the universe is shared broker reference data
    // (tradable symbols plus scan-rotation metadata) — no user identity,
    // credentials, positions, or P&L lives here. Every user-scoped surface
    // (proposals, positions, trades, alerts, settings,
    // credentials) carries user_id. The route still requires auth.
    void uid;
    const rows = db.prepare('SELECT symbol,last_scanned AS lastScanned,priority FROM warrior_universe ORDER BY priority DESC, symbol LIMIT 500').all();
    const total = db.prepare('SELECT COUNT(*) AS n FROM warrior_universe').get()?.n || 0;
    return { universe: rows, total };
  }
  function latestScan(uid) {
    const run = db.prepare('SELECT * FROM warrior_scan_runs WHERE user_id=? ORDER BY started_at DESC LIMIT 1').get(uid);
    if (!run) return { run: null, rows: [], counts: { pendingProposals: 0, openPositions: 0 } };
    let rows = [];
    try { rows = JSON.parse(run.detail_json || '[]'); } catch (_) { rows = []; }
    const pendingProposals = db.prepare("SELECT COUNT(*) AS n FROM warrior_proposals WHERE user_id=? AND status='pending'").get(uid)?.n || 0;
    return { run: { ...run, detail_json: undefined }, rows, counts: { pendingProposals, openPositions: openPositions(uid).length } };
  }

  // ---------------------------------------------------------------------------
  // Market data + universe + scan cycle
  // ---------------------------------------------------------------------------
  async function marketSession(ctx) {
    // Calendar-backed session check: ET-minutes alone would claim "premarket"
    // on a Saturday. The window is regular 09:30–16:00, premarket 04:00–09:30
    // and after-hours 16:00–20:00 when the matching rule toggle is on.
    const today = easternDate(now());
    const calendar = await broker(ctx, `/v2/calendar?start=${today}&end=${today}`);
    if (!Array.isArray(calendar) || !calendar.length || !calendar[0]?.date) {
      throw new WarriorError('Broker calendar is unavailable; market-hours state is unknown.');
    }
    const clock = await broker(ctx, '/v2/clock');
    const clockTime = Date.parse(clock?.timestamp);
    if (!Number.isFinite(clockTime) || Math.abs(now() - clockTime) > 120000) {
      throw new WarriorError('Broker clock is missing or stale.');
    }
    const mins = easternTimeMinutes(now());
    const rules = ctx.rules;
    const inRegular = mins >= 570 && mins < 960;
    const inPremarket = rules.premarketEnabled && mins >= 240 && mins < 570;
    const inAfterHours = rules.afterHoursEnabled && mins >= 960 && mins < 1200;
    return { clock, session: calendar[0], windowOpen: inRegular || inPremarket || inAfterHours, regularOpen: inRegular, premarket: inPremarket, minutes: mins };
  }
  async function refreshUniverse(ctx) {
    const row = db.prepare('SELECT MAX(last_scanned) AS lastScan FROM warrior_universe').get();
    if (row?.lastScan && now() - Date.parse(row.lastScan) < UNIVERSE_REFRESH_MS) {
      const total = db.prepare('SELECT COUNT(*) AS n FROM warrior_universe').get()?.n || 0;
      if (total > 0) return total;
    }
    const assets = await broker(ctx, '/v2/assets?status=active&asset_class=us_equity');
    if (!Array.isArray(assets) || !assets.length) throw new WarriorError('Tradable asset universe is unavailable.');
    const symbols = [...new Set(assets
      .filter(a => a?.status === 'active' && a.tradable === true && a.class === 'us_equity' &&
        typeof a.symbol === 'string' && a.symbol.trim() && !a.symbol.includes('.'))
      .map(a => a.symbol.trim().toUpperCase()))].sort();
    if (!symbols.length) throw new WarriorError('Tradable asset universe is empty.');
    guard(ctx.lease);
    db.transaction(() => {
      db.prepare('DELETE FROM warrior_universe').run();
      const insert = db.prepare('INSERT INTO warrior_universe(symbol,last_scanned,priority) VALUES (?,?,0)');
      for (const symbol of symbols) insert.run(symbol, timestamp());
    })();
    return symbols.length;
  }
  function selectScanSymbols(ctx) {
    const budget = Math.min(Math.max(Number(ctx.rules.scanBudget) || 100, 1), batchSize);
    // Momentum names from prior cycles scan first (rotation budget preserved);
    // the rest rotate oldest-first.
    const rows = db.prepare(`SELECT symbol FROM warrior_universe
      ORDER BY priority DESC, last_scanned ASC NULLS FIRST LIMIT ?`).all(budget);
    return rows.map(r => r.symbol);
  }
  // Live movers feed (Johnny 2026-10-01): the day's top gainers and
  // most-active names jump the rotation queue, so a stock that wakes up
  // mid-session (SSM sat flat all morning, then ran +96% from 1:25 PM ET)
  // is scanned the same cycle it appears on the screener instead of
  // whenever the 100-of-~11,000 rotation happens to reach it. Fail-soft:
  // any screener trouble falls back to the plain rotation — a scan must
  // never die because the movers feed did.
  async function loadMovers(ctx) {
    const symbols = [];
    const seen = new Set();
    const add = list => {
      for (const entry of Array.isArray(list) ? list : []) {
        const symbol = typeof entry?.symbol === 'string' ? entry.symbol.trim().toUpperCase() : '';
        if (symbol && !symbol.includes('.') && !seen.has(symbol)) { seen.add(symbol); symbols.push(symbol); }
      }
    };
    try {
      const movers = await broker(ctx, '/v1beta1/screener/stocks/gainers-losers?top=50', { data: true });
      add(movers?.gainers);
    } catch (_) { /* rotation still covers the universe */ }
    try {
      const actives = await broker(ctx, '/v1beta1/screener/stocks/most-actives?by=volume&top=50', { data: true });
      add(actives?.most_actives);
    } catch (_) { /* same */ }
    return symbols;
  }
  async function selectScanSymbolsWithMovers(ctx) {
    const budget = Math.min(Math.max(Number(ctx.rules.scanBudget) || 100, 1), batchSize);
    const rotation = selectScanSymbols(ctx);
    const movers = await loadMovers(ctx);
    if (!movers.length) return { symbols: rotation, front: [] };
    const inUniverse = new Set(db.prepare('SELECT symbol FROM warrior_universe').all().map(r => r.symbol));
    // Movers get at most half the cycle budget so the rotation still turns.
    const front = movers.filter(s => inUniverse.has(s)).slice(0, Math.ceil(budget / 2));
    if (!front.length) return { symbols: rotation, front: [] };
    const frontSet = new Set(front);
    return { symbols: [...front, ...rotation.filter(s => !frontSet.has(s))].slice(0, budget), front };
  }
  async function loadDailyBars(ctx, symbols, sessions = 45) {
    const start = new Date(now() - sessions * 2 * 86400000).toISOString();
    const end = new Date(now()).toISOString();
    const out = Object.fromEntries(symbols.map(s => [s, []]));
    let page = null;
    for (let count = 0; count < 10; count++) {
      const query = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start, end, limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc' });
      if (page) query.set('page_token', page);
      const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
      if (!data?.bars || typeof data.bars !== 'object') throw new WarriorError('Historical daily bars are unavailable.');
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
  async function loadMinuteBars(ctx, symbols) {
    const start = easternDayStartUtc(now());
    const end = new Date(now()).toISOString();
    const out = Object.fromEntries(symbols.map(s => [s, []]));
    let page = null;
    for (let count = 0; count < 10; count++) {
      const query = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Min', start, end, limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc' });
      if (page) query.set('page_token', page);
      const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
      if (!data?.bars || typeof data.bars !== 'object') throw new WarriorError('Intraday bars are unavailable.');
      for (const s of symbols) out[s].push(...(data.bars[s] || []));
      page = data.next_page_token;
      if (!page) break;
    }
    for (const s of symbols) {
      out[s] = out[s]
        .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
        .filter(b => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite))
        .sort((a, b) => a.t - b.t);
    }
    return out;
  }
  function buildLevels(m1, daily) {
    const or = openingRange(m1, 30);
    const pm = premarketLevels(m1);
    const pd = prevDayLevels(daily);
    const swings = swingPoints(m1.slice(-60), 3, 3);
    return {
      supports: swings.lows.map(s => s.price),
      resistances: swings.highs.map(s => s.price),
      prevDayHigh: pd?.high ?? null, prevDayLow: pd?.low ?? null,
      premarketHigh: pm?.high ?? null, premarketLow: pm?.low ?? null,
      openingRangeHigh: or?.high ?? null, openingRangeLow: or?.low ?? null,
    };
  }
  async function regimeForCycle(ctx) {
    // SPY/QQQ ride the same data path as the scan; VIX is not offered on the
    // Alpaca paper plan, so the VIX-spike override stays dormant.
    try {
      const bars = await loadDailyBars(ctx, ['SPY', 'QQQ'], 30);
      const statsOf = sym => {
        const daily = bars[sym] || [];
        if (daily.length < 21) return { price: null, ema20: null, dayChangePct: null };
        const closes = daily.map(b => +b.c);
        const e20 = emaSeries(closes, 20);
        const last = daily[daily.length - 1];
        const prev = daily[daily.length - 2];
        return {
          price: +last.c,
          ema20: e20[e20.length - 1],
          dayChangePct: prev.c ? ((+last.c - +prev.c) / +prev.c) * 100 : null,
        };
      };
      return classifyRegime({ spy: statsOf('SPY'), qqq: statsOf('QQQ'), vix: null, vixChangePct: null });
    } catch (_) {
      return { regime: 'NEUTRAL', reasons: ['Index data unavailable — defaulting to neutral.'] };
    }
  }
  function scoreSymbol({ uid, symbol, m1, daily, levels, regime, rules, account }) {
    const reasons = [];
    if (!m1.length || !daily.length) {
      return { symbol, outcome: 'error', reason: 'Missing intraday or daily bars; symbol withheld.' };
    }
    const last = m1[m1.length - 1];
    const prevDaily = daily[daily.length - 2];
    const price = last.c;
    const dayChgPct = prevDaily && +prevDaily.c ? ((price - +prevDaily.c) / +prevDaily.c) * 100 : 0;
    // Universe filters (spec §39 universe surface). Market cap is NOT exposed
    // by the Alpaca paper plan — the filter is inert and says so.
    if (!(price >= rules.minPrice && price <= rules.maxPrice)) {
      return { symbol, price, outcome: 'rejected', stage: 'universe',
        reason: `Price ${price.toFixed(2)} outside ${rules.minPrice}–${rules.maxPrice}.` };
    }
    // Liquidity: same daily-based semantics as the scan's phase 1 — the
    // 20-day average OR today's actual volume satisfies the gate (Johnny
    // 2026-10-01); a name must fail both to be rejected. (This check used
    // to average the last 20 MINUTE bars against the daily threshold —
    // a units mismatch that rejected nearly every real stock.)
    const dayVol = +((daily[daily.length - 1] || {}).v || 0);
    const avgDayVol = daily.length >= 20
      ? daily.slice(-21, -1).reduce((s, b) => s + +b.v, 0) / 20 : null;
    if (avgDayVol != null && avgDayVol < rules.minAvgDailyVolume && dayVol < rules.minAvgDailyVolume) {
      return { symbol, price, outcome: 'rejected', stage: 'universe',
        reason: `Average volume ${Math.round(avgDayVol)} and today's volume ${Math.round(dayVol)} both below ${rules.minAvgDailyVolume}.` };
    }
    if (avgDayVol != null && avgDayVol * price < rules.minDollarVolume && dayVol * price < rules.minDollarVolume) {
      return { symbol, price, outcome: 'rejected', stage: 'universe',
        reason: `Average and today's dollar volume both below ${rules.minDollarVolume}.` };
    }
    // Momentum pre-filter from the daily bar (intraday RVOL comes later).
    const dayRvol = avgDayVol ? dayVol / avgDayVol : null;
    if (!(dayChgPct >= rules.minPctGain)) {
      return { symbol, price, outcome: 'rejected', stage: 'momentum',
        reason: `Day change ${dayChgPct.toFixed(2)}% below ${rules.minPctGain}% minimum.` };
    }
    if (dayRvol != null && dayRvol < rules.minRvol) {
      return { symbol, price, outcome: 'rejected', stage: 'momentum',
        reason: `Day relative volume ${dayRvol.toFixed(2)}x below ${rules.minRvol}x minimum.` };
    }
    // Pattern + scoring on the full 1m tape.
    const ind = computeIntraday(m1);
    const i = m1.length - 1;
    const row = ind[i] || {};
    const prevRow = ind[i - 1] || {};
    const extended = {
      price, vwap: row.vwap, ema9: row.ema9, ema20: row.ema20,
      macd: row.macd, macdHist: row.macdHist, macdHistPrev: prevRow.macdHist, rvol: row.rvol,
    };
    const allowed = rules.allowedPatterns || {};
    let patterns = [];
    try { patterns = detectAll({ candles: m1, ind, levels }); } catch (_) { patterns = []; }
    patterns = patterns.filter(p => allowed[p.pattern_name] !== false);
    if (!patterns.length) {
      return { symbol, price, chgPct: dayChgPct, rvol: row.rvol, volume: last.v,
        vwap: row.vwap, ema9: row.ema9, ema20: row.ema20, macd: row.macd,
        outcome: 'rejected', stage: 'pattern', reason: 'No enabled pattern detected a valid setup.' };
    }
    const top = patterns[0];
    const closes = daily.map(b => +b.c);
    const e200 = closes.length >= 200 ? emaSeries(closes, 200) : null;
    const scoring = scoreSetup({
      pattern: top,
      ind: extended,
      regime: regime.regime,
      dayChangePct: dayChgPct,
      newIntradayHigh: last.h >= Math.max(...m1.map(b => b.h)),
      volumeExpanding: m1.length > 1 ? last.v > m1[m1.length - 2].v : false,
      aboveEma200Daily: e200 ? price > e200[e200.length - 1] : null,
    }, {
      minScore: rules.minScore, highQuality: rules.highQuality,
      minScoreBull: rules.minScoreBull, minScoreNeutral: rules.minScoreNeutral,
      minScoreBear: rules.minScoreBear, minRR: rules.minRR,
      strongRvol: rules.strongRvol, veryStrongRvol: rules.veryStrongRvol,
    });
    const row_view = { symbol, price, chgPct: dayChgPct, rvol: row.rvol, volume: last.v,
      vwap: row.vwap, ema9: row.ema9, ema20: row.ema20, macd: row.macd,
      pattern: top.pattern_name, score: scoring.score, displayScore: scoring.displayScore,
      entry: top.entry_price, stop: top.stop_price, target: top.target_price, rr: top.risk_reward,
      reasons: scoring.reasons };
    if (!scoring.meetsMinimum) {
      return { ...row_view, outcome: 'rejected', stage: 'score',
        reason: `Score ${scoring.score} below ${regime.regime} minimum ${scoring.minRequired}.` };
    }
    if (!(top.risk_reward >= rules.minRR)) {
      return { ...row_view, outcome: 'rejected', stage: 'risk_reward',
        reason: `R:R ${top.risk_reward} below ${rules.minRR} minimum.` };
    }
    // Duplicate protection: no second open proposal or position for the
    // same symbol+pattern.
    const dupProposal = db.prepare(`SELECT 1 FROM warrior_proposals
      WHERE user_id=? AND symbol=? AND pattern_name=? AND status='pending'`).get(uid, symbol, top.pattern_name);
    const dupPosition = db.prepare(`SELECT 1 FROM warrior_positions
      WHERE user_id=? AND symbol=? AND status='open'`).get(uid, symbol);
    if (dupProposal || dupPosition) {
      return { ...row_view, outcome: 'rejected', stage: 'duplicate',
        reason: dupProposal ? 'An open proposal for this symbol+pattern already exists.' : 'A position in this symbol is already open.' };
    }
    let plan;
    try {
      plan = planTrade({ entry: top.entry_price, stop: top.stop_price, target: top.target_price,
        equity: number(account?.equity) || 0,
        riskPerTradePct: rules.riskPerTradePct, maxRiskPerTradePct: rules.maxRiskPerTradePct });
    } catch (error) {
      return { ...row_view, outcome: 'rejected', stage: 'sizing', reason: `Position sizing failed: ${error.message}` };
    }
    if (!(plan.sharesRecommended > 0)) {
      return { ...row_view, outcome: 'rejected', stage: 'sizing', reason: 'Risk budget sizes to zero shares.' };
    }
    return { ...row_view, outcome: 'eligible', patternDetail: top, plan,
      explanation: top.explanation, regime: regime.regime };
  }
  async function scanCycle(ctx, marketState, account) {
    const runId = crypto.randomUUID();
    const startedAt = timestamp();
    db.prepare(`INSERT INTO warrior_scan_runs(run_id,user_id,started_at) VALUES (?,?,?)`).run(runId, ctx.uid, startedAt);
    const funnel = { symbols: 0, universe: 0, momentum: 0, pattern: 0, proposals: 0, rejected: 0, errors: 0 };
    const createdProposalIds = [];
    let regime = { regime: 'NEUTRAL', reasons: ['Regime not evaluated.'] };
    try {
      await refreshUniverse(ctx);
      const { symbols, front } = await selectScanSymbolsWithMovers(ctx);
      funnel.symbols = symbols.length;
      if (!symbols.length) throw new WarriorError('Scan universe is empty.');
      regime = await regimeForCycle(ctx);
      const dailyBySymbol = await loadDailyBars(ctx, symbols);
      // Phase 1 on daily bars: universe + momentum filters (cheap).
      const phase1 = [];
      for (const symbol of symbols) {
        guard(ctx.lease);
        const daily = (dailyBySymbol[symbol] || []).map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }));
        if (daily.length < 21) { funnel.errors++; continue; }
        const lastD = daily[daily.length - 1];
        const price = +lastD.c;
        const prevClose = +daily[daily.length - 2].c;
        const dayChgPct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        const avgVol20 = daily.slice(-21, -1).reduce((s, b) => s + b.v, 0) / 20;
        const avgDollarVol = avgVol20 * price;
        const dayVol = +lastD.v;
        const dayRvol = avgVol20 ? dayVol / avgVol20 : null;
        const dayDollarVol = dayVol * price;
        const r = ctx.rules;
        let stage = null, reason = null;
        if (!(price >= r.minPrice && price <= r.maxPrice)) { stage = 'universe'; reason = `Price ${price.toFixed(2)} outside ${r.minPrice}–${r.maxPrice}.`; }
        // Liquidity gates (Johnny 2026-10-01): today's actual volume is an
        // alternative pass to the 20-day average. A name that normally
        // sleeps but is trading real volume today (SSM: $2.7M average
        // dollar volume, ~$80M traded today) is liquid NOW; a name must
        // fail on both the average and today to be rejected.
        else if (avgVol20 < r.minAvgDailyVolume && dayVol < r.minAvgDailyVolume) { stage = 'universe'; reason = `Average daily volume ${Math.round(avgVol20)} and today's volume ${Math.round(dayVol)} both below ${r.minAvgDailyVolume}.`; }
        else if (avgDollarVol < r.minDollarVolume && dayDollarVol < r.minDollarVolume) { stage = 'universe'; reason = 'Average and today\'s dollar volume both below minimum.'; }
        else if (!(dayChgPct >= r.minPctGain)) { stage = 'momentum'; reason = `Day change ${dayChgPct.toFixed(2)}% below ${r.minPctGain}% minimum.`; }
        else if (dayRvol != null && dayRvol < r.minRvol) { stage = 'momentum'; reason = `Day relative volume ${dayRvol.toFixed(2)}x below ${r.minRvol}x minimum.`; }
        if (stage) {
          // Rejections are counted in the funnel only — per-symbol rejection
          // rows are not persisted (Johnny: no zombie data).
          funnel.rejected++;
          continue;
        }
        funnel.universe++; funnel.momentum++;
        phase1.push({ symbol, daily });
      }
      // Phase 2: 1m bars only for momentum survivors → patterns → scoring.
      let minuteBySymbol = {};
      if (phase1.length) minuteBySymbol = await loadMinuteBars(ctx, phase1.map(p => p.symbol));
      for (const { symbol, daily } of phase1) {
        guard(ctx.lease);
        const m1 = minuteBySymbol[symbol] || [];
        const result = scoreSymbol({ uid: ctx.uid, symbol, m1, daily, levels: buildLevels(m1, daily), regime, rules: ctx.rules, account });
        if (result.outcome === 'eligible') {
          funnel.pattern++;
          const proposalId = crypto.randomUUID();
          // Auto-approve sizing: fixed dollar notional instead of the
          // risk-model share count. Manual approval (autoApprove off) keeps
          // the risk-model recommendation as the suggested size.
          const autoSize = ctx.rules.autoApprove === true;
          const autoDollars = number(ctx.rules.autoApproveDollars) > 0 ? number(ctx.rules.autoApproveDollars) : 500;
          const shares = autoSize
            ? Math.max(1, Math.floor(autoDollars / result.entry))
            : result.plan.sharesRecommended;
          const reasons = [...(result.explanation ? [result.explanation] : []), ...(result.reasons || [])];
          if (autoSize) reasons.push(`Auto-approve: $${autoDollars} default size (${shares} shares).`);
          db.prepare(`INSERT INTO warrior_proposals(proposal_id,user_id,symbol,pattern_name,score,entry,stop,target,rr,
            shares_recommended,reasons,status,created_at,expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(
            proposalId, ctx.uid, symbol, result.pattern, result.score, result.entry, result.stop,
            result.target, result.rr, shares,
            JSON.stringify(reasons),
            timestamp(), new Date(now() + PROPOSAL_TTL_MS).toISOString());
          createdProposalIds.push(proposalId);
          funnel.proposals++;
          db.prepare('UPDATE warrior_universe SET priority=priority+1,last_scanned=? WHERE symbol=?').run(timestamp(), symbol);
          if (result.score >= ctx.rules.highQuality) {
            alert(ctx.uid, 'proposal', `High-quality Warrior setup: ${symbol} ${result.pattern} scored ${result.displayScore} (R:R ${result.rr}).`);
          }
        } else if (result.outcome === 'rejected') {
          // Counted in the funnel only — no per-symbol rejection rows.
          funnel.rejected++;
        } else {
          funnel.errors++;
        }
        db.prepare('UPDATE warrior_universe SET last_scanned=? WHERE symbol=?').run(timestamp(), symbol);
      }
      // Premarket priority carry (Johnny 2026-10-01): names on the movers
      // feed or through phase 1 during the premarket are boosted in the
      // rotation, so the first regular-session scans at 09:30 ET reach
      // them FIRST — the trend was spotted ahead of the open instead of
      // being discovered after it. Priority only orders the existing
      // rotation; the cycle budget is unchanged.
      if (marketState?.premarket) {
        const frontSet = new Set(front);
        for (const symbol of front) {
          guard(ctx.lease);
          db.prepare('UPDATE warrior_universe SET priority=priority+? WHERE symbol=?')
            .run(PREMARKET_PRIORITY_BOOST, symbol);
        }
        for (const p of phase1) {
          if (frontSet.has(p.symbol)) continue;
          guard(ctx.lease);
          db.prepare('UPDATE warrior_universe SET priority=priority+? WHERE symbol=?')
            .run(PREMARKET_PHASE1_BOOST, p.symbol);
        }
      }
    } catch (error) {
      funnel.errors++;
      throw error;
    } finally {
      // Funnel counts only — per-symbol detail rows are NOT persisted
      // (Johnny: no zombie data). Old scan runs are pruned to 7 days.
      db.prepare(`UPDATE warrior_scan_runs SET symbols_scanned=?,universe_pass=?,momentum_pass=?,pattern_pass=?,
        proposals_created=?,errors=?,regime=?,detail_json=NULL WHERE run_id=?`)
        .run(funnel.symbols, funnel.universe, funnel.momentum, funnel.pattern, funnel.proposals,
          funnel.errors, regime.regime, runId);
      db.prepare(`DELETE FROM warrior_scan_runs WHERE user_id=? AND started_at < datetime('now','-7 days')`)
        .run(ctx.uid);
      try { pruneDiagnostics(ctx.uid); } catch (_) { /* Prune is best-effort. */ }
    }
    return { runId, funnel, regime: regime.regime, proposalIds: createdProposalIds };
  }

  // ---------------------------------------------------------------------------
  // Diagnostics pruning (Johnny 2026-09-29: lean database — no zombie data)
  // ---------------------------------------------------------------------------
  // 7-day retention on diagnostic history; real trade records
  // (warrior_trades) and live state are never pruned. Terminal proposals
  // (expired/rejected) older than 7 days go; pending rows and proposals
  // backing an open position stay. Backtests keep the newest 20 runs.
  function pruneDiagnostics(uid) {
    db.prepare(`DELETE FROM warrior_alerts WHERE user_id=? AND created_at < datetime('now','-7 days')`)
      .run(uid);
    db.prepare(`DELETE FROM warrior_proposals WHERE user_id=? AND status IN ('expired','rejected')
      AND created_at < datetime('now','-7 days')
      AND proposal_id NOT IN (SELECT proposal_id FROM warrior_positions WHERE proposal_id IS NOT NULL)`)
      .run(uid);
    db.prepare(`DELETE FROM warrior_backtests WHERE user_id=? AND backtest_id NOT IN (
      SELECT backtest_id FROM warrior_backtests WHERE user_id=? ORDER BY created_at DESC, backtest_id DESC LIMIT 20)`)
      .run(uid, uid);
    db.prepare(`DELETE FROM warrior_backtest_trades WHERE backtest_id NOT IN (SELECT backtest_id FROM warrior_backtests)`)
      .run();
  }

  // ---------------------------------------------------------------------------
  // Proposal approval (manual, or automatic when rules.autoApprove is on) and rejection
  // ---------------------------------------------------------------------------
  async function approveProposal(uid, proposalId, opts = {}) {
    return locked(uid, async lease => {
      const proposal = db.prepare('SELECT * FROM warrior_proposals WHERE proposal_id=? AND user_id=?').get(proposalId, uid);
      if (!proposal) throw new WarriorError('Proposal not found.', 404);
      const settings = ensure(uid);
      const rules = getRules(uid);
      const ctx = { uid, lease, settings, cred: null, rules };
      // Re-approve of an already-approved proposal reconciles the same order,
      // never submits a second one.
      if (proposal.status === 'approved') {
        ctx.cred = credential(uid, settings.mode);
        if (!ctx.cred) throw new WarriorError('Connect a dedicated Warrior broker account.');
        const prior = await orderByClient(ctx, proposal.proposal_id);
        if (prior?.id) {
          authorize(ctx);
          return { proposal: { ...proposal, reasons: JSON.parse(proposal.reasons || '[]') }, order: prior, reconciled: true };
        }
        // Approved but no live order — fall through to (re)submission.
      } else {
        if (proposal.status !== 'pending') throw new WarriorError(`Proposal is ${proposal.status}.`, 409);
        if (Date.parse(proposal.expires_at) < now()) {
          db.prepare("UPDATE warrior_proposals SET status='expired' WHERE proposal_id=?").run(proposalId);
          throw new WarriorError('Proposal expired without approval.');
        }
      }
      const cred = credential(uid, settings.mode);
      if (!cred) throw new WarriorError('Connect a dedicated Warrior broker account.');
      ctx.cred = cred;
      // PAPER ONLY — default and expected operating mode. LIVE orders require
      // tradingMode==='LIVE' AND liveEnabled AND liveConfirmed; anything less
      // is an incomplete live authorization and is refused loudly. Even a
      // fully-set LIVE triple cannot trade: connect() only ever stores paper
      // credentials, so there is no live credential to authorize against.
      const liveRequested = rules.tradingMode === 'LIVE';
      if (liveRequested && !(rules.liveEnabled === true && rules.liveConfirmed === true)) {
        throw new WarriorError('LIVE orders require tradingMode=LIVE AND liveEnabled AND liveConfirmed. Action withheld.');
      }
      if (liveRequested) {
        throw new WarriorError('LIVE trading is not connected for Warrior — paper is the only working mode. Action withheld.');
      }
      authorize(ctx);
      const account = await broker(ctx, '/v2/account');
      validateAccount(account, cred.account_id);
      guard(lease);
      const marketState = await marketSession(ctx);
      if (!marketState.windowOpen) throw new WarriorError('Market window is closed; approval withheld.');
      // Premarket scan-only (Johnny 2026-10-01): proposals may be CREATED
      // from 04:00 ET, but no entry order leaves before the 09:30 ET open
      // while premarketScanOnly is on (the default). Enforced here, in the
      // order path itself — not just in the scheduler — so no caller
      // (auto-approve loop, UI, retry) can enter during the premarket.
      // Switching premarketScanOnly off is the explicit opt-in to
      // premarket entries, and the pre-trade gate below then treats the
      // premarket window as open.
      if (marketState.premarket && rules.premarketScanOnly !== false) {
        throw new WarriorError('Premarket is scan-only — entries wait for the 09:30 ET open (premarketScanOnly is on).');
      }
      guard(lease);
      const orders = await broker(ctx, '/v2/orders?status=open&direction=desc&limit=100');
      const brokerPositions = await broker(ctx, '/v2/positions');
      // Position identity reconciliation: if the broker already holds this
      // symbol under Warrior's scope we adopt the position instead of
      // submitting a second entry.
      const brokerPos = (brokerPositions || []).find(p => String(p.symbol).toUpperCase() === proposal.symbol);
      const ordersFor = (orders || []).filter(o => o.client_order_id === proposal.proposal_id);
      const terminal = ordersFor.find(o => TERMINAL.has(o.status));
      const openOrder = ordersFor.find(o => !TERMINAL.has(o.status));
      // Freshness: one fresh 1m quote via the latest bar endpoint.
      const latest = await broker(ctx, `/v2/stocks/bars/latest?symbols=${encodeURIComponent(proposal.symbol)}&feed=sip`, { data: true });
      const latestBar = latest?.bars?.[proposal.symbol]?.DailyBar || latest?.bars?.[proposal.symbol]?.daily;
      const latestTime = latestBar ? Date.parse(latestBar.t) : NaN;
      const dataFresh = Number.isFinite(latestTime) && (now() - latestTime) < QUOTE_MAX_AGE_MS;
      const latestPrice = latestBar ? +latestBar.c : null;
      const equity = number(account.equity) || 0;
      const stats = dailyStats(uid, equity);
      const limits = checkDailyLimits({
        dayPnl: stats.dayPnl, equity, consecutiveLosses: stats.consecutiveLosses,
        openPositions: stats.openPositions, tradesToday: stats.tradesToday,
        minutesSinceLastLoss: stats.minutesSinceLastLoss,
        rules: { maxDailyLossPct: rules.maxDailyLossPct, maxConsecutiveLosses: rules.maxConsecutiveLosses,
          maxPositions: rules.maxPositions, maxTradesPerDay: rules.maxTradesPerDay,
          cooldownMinutesAfterLoss: rules.cooldownMinutesAfterLoss },
      });
      const reasons = JSON.parse(proposal.reasons || '[]');
      if (brokerPos) {
        // Adopt: broker holds the symbol (e.g. a crashed approval run or a
        // manually taken trade on this account) — never submit a duplicate.
        db.prepare(`INSERT INTO warrior_positions(position_id,user_id,symbol,qty,entry_price,stop_price,target_price,
          status,opened_at,updated_at,entry_order_id,proposal_id,pattern_name)
          VALUES (?,?,?,?,?,?,?,'open',?,?,NULL,?,?)
          ON CONFLICT(position_id) DO NOTHING`).run(
          crypto.randomUUID(), uid, proposal.symbol, number(brokerPos.qty) || 0,
          number(brokerPos.avg_entry_price) || proposal.entry, proposal.stop, proposal.target,
          timestamp(), timestamp(), proposal.proposal_id, proposal.pattern_name);
        db.prepare("UPDATE warrior_proposals SET status='approved' WHERE proposal_id=?").run(proposal.proposal_id);
        alert(uid, 'approval', `Warrior ${proposal.symbol}: broker already holds the position — adopted, no duplicate order.`);
        return { proposal: { ...proposal, status: 'approved', reasons }, order: openOrder || terminal || null, adopted: true };
      }
      // Re-verify indicator and regime preconditions live: fresh 1m tape must
      // compute clean indicators, and the index regime must classify.
      let indicatorsOk = false, regimeOk = false;
      try {
        const tape = (await loadMinuteBars(ctx, [proposal.symbol]))[proposal.symbol] || [];
        const indRows = computeIntraday(tape);
        const lastInd = indRows[indRows.length - 1] || {};
        indicatorsOk = ['vwap', 'ema9', 'ema20', 'macd'].every(k => Number.isFinite(lastInd[k]));
      } catch (_) { indicatorsOk = false; }
      try {
        const rg = await regimeForCycle(ctx);
        regimeOk = typeof rg?.regime === 'string' && rg.regime.length > 0;
      } catch (_) { regimeOk = false; }
      // All 12 engine gates, assembled from broker-truth + local state. The
      // pattern itself was validated at detection time (detectAll only
      // returns valid patterns); the proposal row is that validated artifact.
      const checks = preTradeInputs({
        marketOpen: marketState.regularOpen || (marketState.premarket && rules.premarketScanOnly === false), dataFresh,
        pattern: { name: proposal.pattern_name, pattern_valid: true },
        indicatorsOk, regimeOk,
        entry: proposal.entry, stop: proposal.stop, target: proposal.target,
        rr: proposal.rr, minRR: rules.minRR,
        buyingPower: number(account.buying_power) || 0,
        notional: proposal.entry * proposal.shares_recommended,
        shares: proposal.shares_recommended,
        duplicatePosition: !!brokerPos || ordersFor.length > 0,
        dailyLimitsOk: limits.ok,
      });
      if (!checks.ok) {
        const detail = checks.checks.filter(c => !c.passed).map(c => c.name).join(', ');
        alert(uid, 'risk', `Warrior ${proposal.symbol}: approval blocked by pre-trade gates (${detail}).`);
        throw new WarriorError(`Pre-trade gates failed: ${detail}.`, 409);
      }
      if (openOrder) {
        // The order is already working — reconcile, don't resubmit.
        db.prepare("UPDATE warrior_proposals SET status='approved' WHERE proposal_id=?").run(proposal.proposal_id);
        return { proposal: { ...proposal, status: 'approved', reasons }, order: openOrder, reconciled: true };
      }
      // Stop-first fills would be ideal, but Alpaca bracket orders couple
      // the stop to the entry order — instead we submit a plain limit entry
      // and, once the fill is confirmed by broker truth, attach a stop-loss
      // and take-profit as independent orders (fail-closed if the fill can't
      // be confirmed or a leg can't be attached).
      const limitPrice = +proposal.entry.toFixed(4);
      const order = await broker(ctx, '/v2/orders', { method: 'POST', entry: true, body: {
        symbol: proposal.symbol, qty: proposal.shares_recommended, side: 'buy',
        type: 'limit', time_in_force: 'day', limit_price: limitPrice,
        client_order_id: proposal.proposal_id, // idempotency: same key resubmits nothing new
      } });
      guard(lease);
      // Verify terminal state of our own client order by broker truth — never
      // assume the submission response.
      const confirmed = await orderByClient(ctx, proposal.proposal_id);
      const orderId = confirmed?.id || order?.id;
      db.transaction(() => {
        db.prepare("UPDATE warrior_proposals SET status='approved' WHERE proposal_id=?").run(proposal.proposal_id);
        db.prepare(`INSERT INTO warrior_positions(position_id,user_id,symbol,qty,entry_price,stop_price,target_price,
          status,opened_at,updated_at,entry_order_id,proposal_id,pattern_name)
          VALUES (?,?,?,?,?,?,?,'pending_entry',?,?,?, ?,?)
          ON CONFLICT(position_id) DO NOTHING`).run(
          crypto.randomUUID(), uid, proposal.symbol, 0, proposal.entry,
          proposal.stop, proposal.target, timestamp(), timestamp(), orderId,
          proposal.proposal_id, proposal.pattern_name);
      })();
      alert(uid, 'approval', `Warrior ${opts.auto ? 'auto-approved' : 'approved'} entry: ${proposal.symbol} x${proposal.shares_recommended} @ ${proposal.entry.toFixed(2)} (proposal ${proposal.proposal_id.slice(0, 8)}…).`);
      return { proposal: { ...proposal, status: 'approved', reasons }, order: confirmed || order, submitted: true };
    });
  }
  function rejectProposal(uid, proposalId, input = {}) {
    return locked(uid, async () => {
      const proposal = db.prepare('SELECT * FROM warrior_proposals WHERE proposal_id=? AND user_id=?').get(proposalId, uid);
      if (!proposal) throw new WarriorError('Proposal not found.', 404);
      if (proposal.status !== 'pending') throw new WarriorError(`Proposal is ${proposal.status}.`, 409);
      db.prepare("UPDATE warrior_proposals SET status='rejected' WHERE proposal_id=?").run(proposalId);
      // No rejection log row — the proposal's own status is the record.
      return { ok: true, proposalId };
    });
  }

  // ---------------------------------------------------------------------------
  // Position reconciliation + automatic management (fills onward, no manual
  // step: pending_entry → open → partial → breakeven → trailing → exit)
  // ---------------------------------------------------------------------------
  async function reconcileCycle(ctx, marketState, account) {
    const opened = [];
    const closed = [];
    // 1) Pending entries: resolve each entry order by broker truth, attach
    //    stop+target legs only after a CONFIRMED fill (fail-closed).
    for (const pos of db.prepare("SELECT * FROM warrior_positions WHERE user_id=? AND status='pending_entry'").all(ctx.uid)) {
      guard(ctx.lease);
      let resolved = null;
      try { resolved = await orderByClient(ctx, pos.proposal_id); } catch (_) { resolved = null; }
      if (!resolved || !TERMINAL.has(resolved.status)) continue; // still working — leave for the next cycle
      if (resolved.status === 'filled' && number(resolved.filled_qty) > 0) {
        const fillPrice = number(resolved.filled_avg_price) || number(resolved.limit_price) || pos.entry_price;
        const qty = Math.floor(number(resolved.filled_qty));
        db.prepare(`UPDATE warrior_positions SET status='open',qty=?,entry_price=?,updated_at=? WHERE position_id=?`)
          .run(qty, fillPrice, timestamp(), pos.position_id);
        pos.status = 'open'; pos.qty = qty; pos.entry_price = fillPrice;
        // Attach ONE broker-side OCO (take-profit + stop) — only after a
        // CONFIRMED fill, and never as two independent legs.
        try {
          await attachProtection(ctx, pos, {
            qty, stopPrice: pos.stop_price, targetPrice: pos.target_price, tag: 'init',
          });
          opened.push(pos.symbol);
          alert(ctx.uid, 'fill', `Warrior filled ${pos.symbol} x${qty} @ ${fillPrice.toFixed(2)}; OCO protection attached.`);
        } catch (error) {
          // The position is real but unprotected — loud alert; the
          // per-cycle protection check re-attaches until confirmed.
          alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: fill confirmed but OCO protection failed (${error.message || 'broker error'}) — position UNPROTECTED until re-attached.`);
        }
      } else {
        // Entry died (canceled/expired/rejected): journal it as rejected and
        // never leave a phantom position.
        db.prepare("UPDATE warrior_positions SET status='rejected',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
        const rec = buildTradeRecord({ tradeId: pos.position_id, ticker: pos.symbol, date: easternDate(pos.opened_at),
          enteredAt: pos.opened_at, pattern: pos.pattern_name, entryPrice: pos.entry_price,
          stopPrice: pos.stop_price, targetPrice: pos.target_price, shares: 0, orderStatus: 'rejected' });
        insertTrade(ctx.uid, rec);
        alert(ctx.uid, 'system', `Warrior ${pos.symbol}: entry order ${resolved.status} — no position taken.`);
      }
    }
    // 2) Open positions: broker-truth quantity, then automatic management.
    // Fail CLOSED on broker uncertainty: if the positions request fails we
    // pause reconciliation entirely — a failed fetch must never look like
    // "no positions" (that path closes local state).
    let brokerPositions;
    try {
      brokerPositions = await broker(ctx, '/v2/positions');
      if (!Array.isArray(brokerPositions)) throw new WarriorError('Positions response malformed.');
    } catch (error) {
      db.prepare("UPDATE warrior_settings SET scheduler_status='error',scheduler_reason=?,last_cycle_at=? WHERE user_id=?")
        .run('Broker positions unavailable — reconciliation paused; no positions were opened, closed, or changed.',
          timestamp(), ctx.uid);
      alert(ctx.uid, 'risk', 'Warrior: broker positions request failed — reconciliation paused until broker truth returns. No state changed.');
      return { opened, closed, paused: true };
    }
    for (const pos of openPositions(ctx.uid)) {
      guard(ctx.lease);
      const brokerPos = brokerPositions
        .find(p => String(p.symbol).toUpperCase() === pos.symbol);
      if (!brokerPos) {
        // The broker shows nothing — the position is gone (stopped out,
        // exited externally, or a bookkeeping error). Query the fill legs by
        // broker truth before closing out locally.
        await closeMissing(ctx, pos);
        closed.push(`${pos.symbol}:missing`);
        continue;
      }
      const qty = Math.max(0, Math.floor(number(brokerPos.qty) || 0));
      const curPrice = number(brokerPos.current_price) || 0;
      if (qty !== pos.qty) {
        db.prepare('UPDATE warrior_positions SET qty=?,updated_at=? WHERE position_id=?')
          .run(qty, timestamp(), pos.position_id);
        pos.qty = qty;
      }
      // Hold-the-runner (Johnny 2026-10-01): with holdRunners on, once the
      // partial is banked the remainder is a runner — protected STOP-ONLY
      // (no fixed target leg) and exited by volume fade / trailing / stop /
      // max-hold / EOD instead of at the old fixed target.
      const holdRunners = ctx.rules.holdRunners === true;
      // Protection must be live and cover exactly what we hold. Re-attach
      // the OCO when it is missing, dead, or a leg already fired — a stale
      // OCO covering the wrong quantity is worse than a loud re-attach.
      // A FAILED lookup is not "no OCO": we withhold changes rather than
      // risk stacking a second OCO on a flaky network.
      let ocoParent = null, ocoLookupFailed = false;
      if (pos.exit_oco_id) {
        try { ocoParent = await orderByClient(ctx, pos.exit_oco_id); }
        catch (_) { ocoLookupFailed = true; }
      }
      const ocoLive = ocoParent && !TERMINAL.has(ocoParent.status) && !ocoFilledLeg(ocoParent);
      if (ocoLookupFailed) {
        alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: protection state unknown (broker lookup failed) — withholding changes until broker truth returns.`);
      } else if (!ocoLive && qty > 0) {
        try {
          await attachProtection(ctx, pos, {
            qty, stopPrice: pos.stop_price, targetPrice: holdRunners && pos.partial_taken ? null : pos.target_price, tag: `r${Date.now()}`,
          });
        } catch (error) {
          alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: OCO protection is not live (${error.message || 'broker error'}) — position unmanaged until re-attached.`);
        }
      }
      const risk = Math.max(pos.entry_price - pos.stop_price, 1e-9);
      const curR = (curPrice - pos.entry_price) / risk;
      const highestR = Math.max(pos.highest_r || 0, curR);
      db.prepare('UPDATE warrior_positions SET highest_r=?,hold_candles=hold_candles+1,updated_at=? WHERE position_id=?')
        .run(highestR, timestamp(), pos.position_id);
      const rules = ctx.rules;
      const exitIntent = { symbol: pos.symbol, qty, reason: null, price: curPrice };
      // Stop-hit: current price at/below stop (the attached stop leg usually
      // handles this; this is the backstop if it is missing).
      if (curPrice > 0 && curPrice <= pos.stop_price) exitIntent.reason = 'stop';
      // Target-hit: current price at/above target → full exit (partial at +2R
      // taken first if still holding the full lot). SUPPRESSED entirely
      // while holdRunners is on: the partial still banks at +partialAtR,
      // but the remainder is never dumped at the fixed target — it exits
      // on the volume fade (or stop / trailing / max-hold / EOD) instead.
      else if (curPrice > 0 && curPrice >= pos.target_price && !holdRunners) exitIntent.reason = 'target';
      // Partial at +2R: cancel the OCO first (it must never cover shares we
      // no longer hold), sell half only on a CONFIRMED fill, then re-protect
      // the runner. Any failure restores protection or raises a loud alert —
      // never a silent half-protected position.
      if (!pos.partial_taken && curR >= rules.partialAtR && qty >= 2 && !exitIntent.reason) {
        const half = Math.floor(qty / 2);
        const canceled = await cancelProtection(ctx, pos);
        if (!canceled) {
          alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: partial withheld — protection could not be canceled first.`);
        } else {
          const fill = await exitShares(ctx, pos, half, 'partial');
          const remainder = qty - (fill ? fill.filledQty : 0);
          if (fill && remainder > 0) {
            const banked = (fill.fillPrice - number(pos.entry_price)) * fill.filledQty;
            let reattached = false;
            try {
              await attachProtection(ctx, pos, {
                qty: remainder, stopPrice: pos.stop_price, targetPrice: holdRunners ? null : pos.target_price, tag: `p${Date.now()}`,
              });
              reattached = true;
            } catch (error) {
              alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: partial filled but runner re-protection failed (${error.message || 'broker error'}) — runner UNPROTECTED until re-attached.`);
            }
            db.prepare('UPDATE warrior_positions SET partial_taken=1,qty=?,banked_pnl=banked_pnl+?,updated_at=? WHERE position_id=?')
              .run(remainder, banked, timestamp(), pos.position_id);
            pos.qty = remainder; pos.partial_taken = 1;
            pos.banked_pnl = (number(pos.banked_pnl) || 0) + banked;
            alert(ctx.uid, 'exit', `Warrior ${pos.symbol}: partial at +${rules.partialAtR}R — sold ${fill.filledQty} @ ${fill.fillPrice.toFixed(2)}${reattached ? '; runner re-protected.' : ''}`);
          } else {
            // Nothing sold — restore protection immediately under a fresh tag
            // (a canceled client_order_id is never reused).
            try {
              await attachProtection(ctx, pos, {
                qty, stopPrice: pos.stop_price, targetPrice: pos.target_price, tag: `r${Date.now()}`,
              });
            } catch (error) {
              alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: protection restore failed after withheld partial (${error.message || 'broker error'}).`);
            }
          }
        }
      }
      // The partial may have changed what we hold — re-sync the exit intent
      // quantity so a later exit in this same cycle can never oversell.
      exitIntent.qty = Math.floor(number(pos.qty) || 0);
      // Breakeven: after +1R ratchet the stop — to entry ('breakeven') or to
      // the higher of entry and EMA9 ('ema9'). Local state changes ONLY
      // after the broker confirms the OCO replacement (inside moveStop);
      // a failed move keeps the old protection and retries next cycle.
      if (!pos.breakeven_set && highestR >= 1 && rules.breakevenAction !== 'none' && !exitIntent.reason) {
        let newStop = number(pos.entry_price) || 0;
        if (rules.breakevenAction === 'ema9') {
          try {
            const line = await trailingLine(ctx, pos, { ...rules, trailingMethod: 'ema9' });
            if (line != null && line > newStop) newStop = line;
          } catch (_) { /* fall back to entry breakeven */ }
        }
        if (newStop > 0 && await moveStop(ctx, pos, newStop)) {
          alert(ctx.uid, 'system', `Warrior ${pos.symbol}: stop ratcheted to ${newStop.toFixed(2)} after +1R.`);
        }
      }
      // Volume-fade exit for the runner (Johnny 2026-10-01): checked after
      // stop / partial / breakeven and before the trailing stop, so a
      // faded runner reports 'volume_fade' — while volume is still strong
      // this never fires and the trailing stop keeps owning pullbacks.
      // The fade definition is shared with the backtester
      // (indicators.volumeFadeDetected): recent volume below
      // fadeVolumeFraction × the trailing baseline AND a price stall.
      if (!exitIntent.reason && holdRunners && pos.partial_taken) {
        try {
          const m1 = (await loadMinuteBars(ctx, [pos.symbol]))[pos.symbol] || [];
          if (volumeFadeDetected(m1, rules)) exitIntent.reason = 'volume_fade';
        } catch (_) { /* no bars, no fade call — stop/trailing/EOD still guard */ }
      }
      // Trailing stop (EMA9 default): current price pulled back below the
      // trailing line exits the runner.
      if (!exitIntent.reason && rules.trailingMethod !== 'none') {
        const line = await trailingLine(ctx, pos, rules);
        if (line != null && curPrice > 0 && curPrice < line) exitIntent.reason = 'trailing_stop';
      }
      // Max-hold and EOD flatten.
      if (!exitIntent.reason) {
        if ((pos.hold_candles || 0) >= rules.maxHoldCandles) exitIntent.reason = 'max_hold';
        else if (rules.eodFlatten && marketState.minutes >= EOD_FLATTEN_MINUTES) exitIntent.reason = 'eod_flatten';
      }
      if (exitIntent.reason) {
        const result = await closePosition(ctx, pos, exitIntent);
        if (result) closed.push(`${pos.symbol}:${exitIntent.reason}`);
      }
    }
    // 3) EOD flatten sweep: any position still open at 15:55+ exits market.
    // (handled per-position above; the rules.eodFlatten gate covers it)
    return { opened, closed };
  }
  // ---------------------------------------------------------------------------
  // Protection — ONE broker-side order per position: an OCO (take-profit
  // limit + stop), or, for a held runner whose partial has banked, a
  // stop-only order (no fixed target leg). Never two independent orders:
  // independent legs are the classic failure — a filled take-profit leaves
  // a live stop that can open an unmanaged short. The parent is tracked on
  // the position row (exit_oco_id); every mutation cancels-and-replaces
  // the whole parent so the exits can never disagree.
  // ---------------------------------------------------------------------------
  function ocoLegs(parent) {
    return Array.isArray(parent?.legs) ? parent.legs : [];
  }
  function ocoFilledLeg(parent) {
    // Returns the leg that filled (take-profit or stop), or null.
    for (const leg of ocoLegs(parent)) {
      if (leg?.status === 'filled' && number(leg.filled_qty) > 0) return leg;
    }
    return null;
  }
  async function cancelOrderById(ctx, orderId) {
    if (!orderId) return false;
    try {
      await broker(ctx, `/v2/orders/${orderId}`, { method: 'DELETE' });
      return true;
    } catch (_) { return false; }
  }
  async function cancelProtection(ctx, pos) {
    // Cancel the OCO parent (exit_oco_id holds its client_order_id).
    // Returns true when nothing protective remains live.
    if (!pos.exit_oco_id) return true;
    const target = await orderByClient(ctx, pos.exit_oco_id).catch(() => null);
    if (!target) return true;
    if (TERMINAL.has(target.status)) return true;
    await cancelOrderById(ctx, target.id);
    const recheck = await orderByClient(ctx, pos.exit_oco_id).catch(() => null);
    return !recheck || TERMINAL.has(recheck.status);
  }
  async function attachProtection(ctx, pos, { qty, stopPrice, targetPrice, tag }) {
    // Cancel-and-replace the protection parent. Idempotent: the
    // deterministic client_order_id means a retry adopts the existing
    // parent instead of stacking a second one. Throws on failure —
    // callers must NOT update local state when this throws.
    // targetPrice === null means STOP-ONLY protection (a held runner: the
    // stop is the only broker-side exit; the take-profit leg is omitted
    // entirely so nothing can dump the runner at a fixed target).
    if (!(qty > 0)) throw new WarriorError('Protection requires a positive quantity.');
    if (!(stopPrice > 0) || (targetPrice != null && !(targetPrice > stopPrice))) {
      throw new WarriorError('Protection requires a positive stop and, when a target is set, a target above it.');
    }
    const ocoId = `oco-${pos.proposal_id}-${tag}`;
    // A failed lookup throws (fail closed) — it must never be mistaken for
    // "no existing OCO", or a retry could stack a second protection order.
    const existing = await orderByClient(ctx, ocoId);
    if (existing && !TERMINAL.has(existing.status)) {
      db.prepare('UPDATE warrior_positions SET exit_oco_id=? WHERE position_id=?').run(ocoId, pos.position_id);
      pos.exit_oco_id = ocoId;
      return existing;
    }
    if (existing && TERMINAL.has(existing.status) && (ocoFilledLeg(existing) || existing.status === 'filled')) {
      // A previous protection order already fired (OCO leg, or the whole
      // stop-only order) — the position is being closed by the broker;
      // never stack another protection order on top.
      throw new WarriorError('A protection leg already filled; position is closing via the broker.');
    }
    const canceled = await cancelProtection(ctx, pos);
    if (!canceled) throw new WarriorError('Existing protection could not be canceled; refusing to stack a second OCO.');
    const body = targetPrice == null
      ? {
        symbol: pos.symbol, qty: Math.floor(qty), side: 'sell', type: 'stop',
        time_in_force: 'day',
        // Same 5bps trigger padding as the OCO stop leg.
        stop_price: +(stopPrice * 1.0005).toFixed(4),
        client_order_id: ocoId,
      }
      : {
        symbol: pos.symbol, qty: Math.floor(qty), side: 'sell', type: 'limit',
        time_in_force: 'day', order_class: 'oco',
        // 5bps of trigger/limit padding, same tolerance the old independent
        // legs used: the stop triggers a touch early, the target a touch low.
        take_profit: { limit_price: +(targetPrice * 0.9995).toFixed(4) },
        stop_loss: { stop_price: +(stopPrice * 1.0005).toFixed(4) },
        client_order_id: ocoId,
      };
    const parent = await broker(ctx, '/v2/orders', { method: 'POST', body });
    if (!parent?.id) throw new WarriorError('Broker did not return the protection order.');
    db.prepare('UPDATE warrior_positions SET exit_oco_id=? WHERE position_id=?').run(ocoId, pos.position_id);
    pos.exit_oco_id = ocoId;
    return parent;
  }
  async function moveStop(ctx, pos, newStop) {
    // Breakeven/trailing ratchet: replace the OCO with a tighter stop.
    // Local state changes only after the broker confirms the replacement.
    if (!(newStop > 0)) return false;
    if (newStop <= (pos.stop_price || 0)) return true; // already at least this tight
    try {
      await attachProtection(ctx, pos, {
        qty: pos.qty, stopPrice: newStop,
        // A held runner keeps stop-only protection through the ratchet.
        targetPrice: ctx.rules?.holdRunners === true && pos.partial_taken ? null : pos.target_price,
        tag: 'be',
      });
      db.prepare('UPDATE warrior_positions SET stop_price=?,breakeven_set=1,updated_at=? WHERE position_id=?')
        .run(newStop, timestamp(), pos.position_id);
      pos.stop_price = newStop;
      pos.breakeven_set = 1;
      return true;
    } catch (error) {
      alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: stop move failed (${error.message || 'broker error'}) — keeping the existing protection; will retry.`);
      return false;
    }
  }
  async function trailingLine(ctx, pos, rules) {
    const method = rules.trailingMethod || 'ema9';
    try {
      const m1 = (await loadMinuteBars(ctx, [pos.symbol]))[pos.symbol] || [];
      if (m1.length < 2) return null;
      if (method === 'ema9') {
        const closes = m1.map(b => b.c);
        const e9 = emaSeries(closes, 9);
        return e9[e9.length - 1];
      }
      if (method === 'fixedPct') {
        const highs = m1.slice(-10);
        const hi = Math.max(...highs.map(b => b.h));
        return hi * 0.995;
      }
      if (method === 'swing' || method === 'vwap') {
        const ind = computeIntraday(m1);
        const row = ind[ind.length - 1] || {};
        if (method === 'vwap') return row.vwap ?? null;
        const swings = swingPoints(m1.slice(-30), 3, 3);
        return swings.lows.length ? swings.lows[swings.lows.length - 1].price : null;
      }
      // 'atr': 1.5 ATR below the recent high.
      const ind = computeIntraday(m1);
      const row = ind[ind.length - 1] || {};
      const hi = Math.max(...m1.slice(-14).map(b => b.h));
      return row.atr14 != null ? hi - 1.5 * row.atr14 : null;
    } catch (_) { return null; }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function submitExitOrder(ctx, pos, qty, reason) {
    // Submits the exit market order. Never stacks an exit on a protection
    // leg that already fired — the broker-owned close wins and closeMissing
    // journals it.
    if (pos.exit_oco_id) {
      const parent = await orderByClient(ctx, pos.exit_oco_id).catch(() => null);
      if (ocoFilledLeg(parent) || parent?.status === 'filled') return { skipped: 'leg-filled' };
    }
    // Adopt a still-working exit from an earlier attempt (crash safety)
    // rather than stacking a second sell on the same shares.
    try {
      const openOrders = await broker(ctx, `/v2/orders?status=open&symbols=${encodeURIComponent(pos.symbol)}`);
      const working = (Array.isArray(openOrders) ? openOrders : [])
        .find(o => String(o.symbol).toUpperCase() === pos.symbol
          && o.side === 'sell' && !TERMINAL.has(o.status)
          && /^exit-/.test(String(o.client_order_id || '')));
      if (working) return { order: working, clientId: working.client_order_id };
    } catch (_) { /* fall through to a fresh submit */ }
    const baseId = `exit-${reason}-${pos.proposal_id}`;
    // A terminal prior id is never reused (the broker may reject it as a
    // duplicate) — mint a fresh one for the retry.
    const prior = await orderByClient(ctx, baseId).catch(() => null);
    const clientId = prior && TERMINAL.has(prior.status) ? `${baseId}-r${Date.now()}` : baseId;
    try {
      const order = await broker(ctx, '/v2/orders', { method: 'POST', body: {
        symbol: pos.symbol, qty: Math.floor(qty), side: 'sell', type: 'market',
        time_in_force: 'day', client_order_id: clientId,
      } });
      return { order, clientId };
    } catch (error) {
      if (error?.duplicateClient) {
        // A previous attempt submitted this exact exit; adopt and reconcile it.
        const existing = await orderByClient(ctx, clientId).catch(() => null);
        if (existing) return { order: existing, clientId };
      }
      return { error };
    }
  }
  async function awaitExitFill(ctx, clientId, { tries = 24, intervalMs = 500 } = {}) {
    // Bounded poll for a confirmed fill. Returns the filled order, the
    // terminal-but-unfilled order, or null on timeout (caller cancels the
    // stale order and retries next cycle — a live unconfirmed exit must
    // never be journaled as closed).
    for (let i = 0; i < tries; i++) {
      const order = await orderByClient(ctx, clientId).catch(() => null);
      if (order?.status === 'filled') return order;
      if (order && TERMINAL.has(order.status)) return order;
      await sleep(intervalMs);
    }
    return null;
  }
  async function exitShares(ctx, pos, qty, reason) {
    // Full exit-confirmation path: submit → bounded fill poll → journal only
    // on a CONFIRMED fill. Returns { filledQty, fillPrice } or null.
    if (!(qty > 0)) return null;
    const sub = await submitExitOrder(ctx, pos, qty, reason);
    if (sub.skipped || sub.error || !sub.order) return null;
    const poll = { tries: exitPoll?.tries ?? 24, intervalMs: exitPoll?.intervalMs ?? 500 };
    const resolved = await awaitExitFill(ctx, sub.clientId, poll);
    if (resolved?.status === 'filled' && number(resolved.filled_qty) > 0) {
      return { filledQty: Math.floor(number(resolved.filled_qty)), fillPrice: number(resolved.filled_avg_price) || 0 };
    }
    // Not confirmed: cancel any working exit so it can never fill later as
    // an unintended short, then retry next cycle.
    const live = resolved && !TERMINAL.has(resolved.status) ? resolved
      : await orderByClient(ctx, sub.clientId).catch(() => null);
    if (live && !TERMINAL.has(live.status)) await cancelOrderById(ctx, live.id).catch(() => null);
    return null;
  }
  function planRiskPerShare(uid, pos) {
    // Original risk per share from the APPROVED proposal (the plan), not the
    // possibly-ratcheted live stop — so R multiples stay honest.
    try {
      const proposal = db.prepare('SELECT entry,stop FROM warrior_proposals WHERE proposal_id=? AND user_id=?')
        .get(pos.proposal_id, uid);
      const risk = number(proposal?.entry) - number(proposal?.stop);
      if (risk > 0) return risk;
    } catch (_) { /* fall through */ }
    const fallback = number(pos.entry_price) - number(pos.stop_price);
    return fallback > 0 ? fallback : NaN;
  }
  async function closeMissing(ctx, pos) {
    // Broker truth says flat. Identify which OCO leg fired (if any) and
    // journal the exit. When NO leg confirms a fill, the exit price and P&L
    // stay NULL — never fabricated — but the row still closes because the
    // broker is authoritatively flat (a phantom open position would be worse).
    let exitPrice = null, exitReason = 'missing', filledQty = 0;
    if (pos.exit_oco_id) {
      const parent = await orderByClient(ctx, pos.exit_oco_id).catch(() => null);
      const leg = ocoFilledLeg(parent);
      if (leg) {
        filledQty = Math.floor(number(leg.filled_qty));
        exitPrice = number(leg.filled_avg_price) || null;
        // OCO legs: the take-profit leg is a limit order, the stop leg a stop order.
        exitReason = leg.type === 'limit' ? 'target' : 'stop';
      } else if (parent?.status === 'filled' && number(parent.filled_qty) > 0) {
        // Stop-only protection (a held runner): the parent order itself is
        // the stop — its fill IS the exit.
        filledQty = Math.floor(number(parent.filled_qty));
        exitPrice = number(parent.filled_avg_price) || null;
        exitReason = 'stop';
      }
    }
    const banked = number(pos.banked_pnl) || 0;
    const risk = planRiskPerShare(ctx.uid, pos);
    const qty = filledQty > 0 ? filledQty : Math.floor(number(pos.qty) || 0);
    const pnl = exitPrice != null && exitPrice > 0 && qty > 0
      ? +((exitPrice - number(pos.entry_price)) * qty + banked).toFixed(2) : null;
    const rec = buildTradeRecord({
      tradeId: pos.position_id, ticker: pos.symbol, date: easternDate(pos.opened_at),
      enteredAt: pos.opened_at, exitedAt: timestamp(), pattern: pos.pattern_name,
      entryPrice: pos.entry_price, stopPrice: pos.stop_price, targetPrice: pos.target_price,
      shares: qty, exitPrice, exitReason, orderStatus: exitPrice != null ? 'filled' : 'unknown',
      pnl, rMultiple: pnl != null && risk > 0 && qty > 0 ? +(pnl / (risk * qty)).toFixed(4) : null,
    });
    insertTrade(ctx.uid, rec);
    db.prepare("UPDATE warrior_positions SET status='closed',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
    await cancelProtection(ctx, pos);
    alert(ctx.uid, 'exit', exitPrice != null
      ? `Warrior ${pos.symbol}: broker shows no position — closed as ${exitReason} at ${exitPrice.toFixed(2)} (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}).`
      : `Warrior ${pos.symbol}: broker shows no position and no protection leg confirms a fill — closed with UNKNOWN exit price/P&L; manual review advised.`);
  }
  async function closePosition(ctx, pos, intent) {
    // Journal ONLY on a confirmed fill. A partial fill of a full-exit intent
    // banks its P&L and keeps the remainder under management.
    // The OCO must be dead BEFORE the market exit goes out — the two must
    // never coexist, or a fill race could leave an unintended short.
    const cleared = await cancelProtection(ctx, pos);
    if (!cleared) {
      alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: exit (${intent.reason}) withheld — protection could not be canceled first.`);
      return false;
    }
    const fill = await exitShares(ctx, pos, intent.qty, intent.reason);
    if (!fill) {
      alert(ctx.uid, 'risk', `Warrior ${pos.symbol}: exit (${intent.reason}) not confirmed — will retry next cycle.`);
      return false;
    }
    const banked = number(pos.banked_pnl) || 0;
    const risk = planRiskPerShare(ctx.uid, pos);
    const legPnl = (fill.fillPrice - number(pos.entry_price)) * fill.filledQty;
    const fullQty = Math.floor(number(intent.qty) || 0);
    if (fill.filledQty < fullQty) {
      // Partial fill of the exit: bank it, keep managing the remainder.
      db.prepare('UPDATE warrior_positions SET qty=?,banked_pnl=banked_pnl+?,updated_at=? WHERE position_id=?')
        .run(fullQty - fill.filledQty, legPnl, timestamp(), pos.position_id);
      alert(ctx.uid, 'exit', `Warrior ${pos.symbol}: exit (${intent.reason}) partially filled ${fill.filledQty}/${fullQty} @ ${fill.fillPrice.toFixed(2)} — managing the remainder.`);
      return false;
    }
    const pnl = +(legPnl + banked).toFixed(2);
    const rec = buildTradeRecord({
      tradeId: pos.position_id, ticker: pos.symbol, date: easternDate(pos.opened_at),
      enteredAt: pos.opened_at, exitedAt: timestamp(), pattern: pos.pattern_name,
      entryPrice: pos.entry_price, stopPrice: pos.stop_price, targetPrice: pos.target_price,
      shares: fill.filledQty, exitPrice: fill.fillPrice, exitReason: intent.reason,
      orderStatus: 'filled', pnl,
      pnlPct: number(pos.entry_price) > 0
        ? +(pnl / (number(pos.entry_price) * fill.filledQty) * 100).toFixed(4) : null,
      rMultiple: risk > 0 ? +(pnl / (risk * fill.filledQty)).toFixed(4) : null,
    });
    insertTrade(ctx.uid, rec);
    db.prepare("UPDATE warrior_positions SET status='closed',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
    alert(ctx.uid, 'exit', `Warrior ${pos.symbol}: exited ${intent.reason} @ ${fill.fillPrice.toFixed(2)} (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}).`);
    return true;
  }
  function insertTrade(uid, rec) {
    const cols = TRADE_FIELDS.map(f => `"${f}"`).join(',');
    const placeholders = TRADE_FIELDS.map(() => '?').join(',');
    db.prepare(`INSERT INTO warrior_trades(user_id,${cols},created_at) VALUES (?,${placeholders},?)`)
      .run(uid, ...TRADE_FIELDS.map(f => rec[f] ?? null), timestamp());
  }

  // ---------------------------------------------------------------------------
  // Scheduler lifecycle — 60s cadence, first run delayed ~30s after start so
  // the Warrior loop sits halfway between B2's cycles. Reconciles positions
  // before ever considering new proposals; auto-approvable proposals are
  // submitted right after the scan lease releases (full gate stack intact).
  // ---------------------------------------------------------------------------
  function expireProposals(uid) {
    const expired = db.prepare(`UPDATE warrior_proposals SET status='expired'
      WHERE user_id=? AND status='pending' AND expires_at<?`).run(uid, timestamp());
    return expired.changes || 0;
  }
  async function run(uid) {
    const result = await locked(uid, async lease => {
      const settings = ensure(uid);
      if (!settings.enabled) return { ok: true, skipped: 'disabled' };
      const rules = getRules(uid);
      const cred = credential(uid, settings.mode);
      if (!cred) {
        db.prepare("UPDATE warrior_settings SET scheduler_status='idle',scheduler_reason='Not connected.' WHERE user_id=?").run(uid);
        return { ok: false, reason: 'not-connected' };
      }
      const ctx = { uid, lease, settings, cred, rules };
      expireProposals(uid);
      const marketState = await marketSession(ctx);
      const account = await broker(ctx, '/v2/account');
      validateAccount(account, cred.account_id);
      guard(lease);
      // Reconcile positions FIRST, so risk math sees broker truth.
      const reconcileResult = await reconcileCycle(ctx, marketState, account);
      if (reconcileResult.paused) {
        // Broker truth was unavailable: the pause branch already recorded
        // scheduler_status='error'. Do not scan, do not overwrite the status.
        return { ok: true, reconcile: reconcileResult, scan: null,
          windowOpen: marketState.windowOpen, paused: true };
      }
      const equity = number(account.equity) || 0;
      const stats = dailyStats(uid, equity);
      const limits = checkDailyLimits({
        dayPnl: stats.dayPnl, equity, consecutiveLosses: stats.consecutiveLosses,
        openPositions: stats.openPositions, tradesToday: stats.tradesToday,
        minutesSinceLastLoss: stats.minutesSinceLastLoss,
        rules: { maxDailyLossPct: rules.maxDailyLossPct, maxConsecutiveLosses: rules.maxConsecutiveLosses,
          maxPositions: rules.maxPositions, maxTradesPerDay: rules.maxTradesPerDay,
          cooldownMinutesAfterLoss: rules.cooldownMinutesAfterLoss },
      });
      let scanResult = null;
      if (marketState.windowOpen) {
        // A halted account still reconciles and manages, but never scans for
        // new proposals — proposals must not pile up behind a daily-loss halt.
        scanResult = limits.ok
          ? await scanCycle(ctx, marketState, account)
          : { skipped: 'halted', reasons: limits.reasons };
      }
      db.prepare(`UPDATE warrior_settings SET scheduler_status='ok',scheduler_reason=?,
        last_cycle_at=? WHERE user_id=?`).run(
        limits.ok ? null : `Halted: ${limits.reasons.join(' ')}`, timestamp(), uid);
      return { ok: true, reconcile: reconcileResult, scan: scanResult,
        windowOpen: marketState.windowOpen, halted: !limits.ok, haltReasons: limits.reasons };
    });
    // Auto-approve proposals created this tick. Runs OUTSIDE the scan lease:
    // approveProposal() takes its own lease, and nested locks would refuse.
    // Every auto-approval still passes the full gate stack (paper-only,
    // account check, market window, 12-check pre-trade gate).
    const created = result && result.scan && result.scan.proposalIds;
    if (created && created.length && getRules(uid).autoApprove === true) {
      for (const proposalId of created) {
        try {
          await approveProposal(uid, proposalId, { auto: true });
        } catch (error) {
          alert(uid, 'system', `Warrior auto-approve skipped proposal ${String(proposalId).slice(0, 8)}: ${error.message}`);
        }
      }
    }
    return result;
  }
  async function tick() {
    if (ticking || !running || !persistenceReady()) return;
    ticking = true;
    const tickRun = runTick();
    activeTick = tickRun;
    try { await tickRun; } catch (error) {
      if (getAutomaticBotContext) {
        try {
          const dispatch = await getAutomaticBotContext();
          if (dispatch?.markTickFailure) await dispatch.markTickFailure('warrior', error);
        } catch (_) { /* never let failure bookkeeping break the loop */ }
      }
    } finally {
      if (activeTick === tickRun) activeTick = null;
      ticking = false;
    }
  }
  async function runTick() {
    const rows = db.prepare('SELECT user_id,mode FROM warrior_settings WHERE enabled=1').all();
    for (const row of rows) {
      const settings = getSettings(row.user_id);
      if (!settings?.enabled) continue;
      try {
        await run(row.user_id);
        if (durability?.flush && persistenceReady()) await durability.flush('warrior-tick');
      } catch (error) {
        db.prepare('UPDATE warrior_settings SET scheduler_status=?,scheduler_reason=?,last_cycle_at=? WHERE user_id=?')
          .run('error', String(error?.message || error).slice(0, 500), timestamp(), row.user_id);
        try { alert(row.user_id, 'system', `Warrior scan failed: ${String(error?.message || error).slice(0, 200)}`); }
        catch (_) { /* alert insert best-effort */ }
      }
    }
  }
  function start() {
    if (running) return;
    running = true;
    generation++;
    db.prepare("UPDATE warrior_settings SET scheduler_status='idle',scheduler_reason=NULL WHERE scheduler_status='running'").run();
    // First run is delayed ~30s so the loop lands halfway between B2 cycles.
    setTimeout(() => { if (running) void tick(); }, 30000);
    timer = setInterval(tick, 60000);
  }
  function stop() { running = false; if (timer) { clearInterval(timer); timer = null; } }
  async function drain() {
    stop();
    if (activeTick) await activeTick;
  }

  // ---------------------------------------------------------------------------
  // Backtests — same detect→score pipeline via the engine. NOTE: live scanning
  // evaluates candles incrementally as they form; the backtest uses the
  // engine's precomputed per-bar path (indicators computed over the whole
  // series, then stepped bar-by-bar) so scores are defined everywhere while
  // fills still see only bars <= the current index (no look-ahead on prices).
  // ---------------------------------------------------------------------------
  function aggregateM5(m1) {
    // Aggregate 1m bars into 5m buckets on the ET clock; the first bar's
    // timestamp represents its bucket (the engine only needs ordering plus
    // etMinutes/etDateKey derivation).
    const buckets = new Map();
    for (const b of m1) {
      const key = `${etDateKey(b.t)}:${Math.floor(etMinutes(b.t) / 5)}`;
      const agg = buckets.get(key);
      if (!agg) buckets.set(key, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
      else {
        agg.h = Math.max(agg.h, b.h); agg.l = Math.min(agg.l, b.l);
        agg.c = b.c; agg.v += b.v || 0;
      }
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t);
  }
  function etWeekday(ms) {
    // Weekday of the ET calendar date (noon UTC on that date is always the
    // same ET calendar day).
    return new Date(`${etDateKey(ms)}T12:00:00Z`).getUTCDay();
  }
  async function loadBacktestMinuteBars(ctx, symbol, days) {
    // One broker request per trading day (extended-hours tape, 04:00–20:00
    // ET), most recent first, skipping weekends. Same SIP feed as the live
    // scan — a backtest never mixes feeds within one evaluation.
    const out = [];
    let cursor = Date.parse(easternDayStartUtc(now()));
    let fetched = 0, attempts = 0;
    while (fetched < days && attempts < days + 14) {
      attempts++;
      const dayStart = cursor;
      cursor -= 86400000;
      const wd = etWeekday(dayStart);
      if (wd === 0 || wd === 6) continue; // weekend: no regular session
      const dayStartIso = new Date(dayStart).toISOString();
      const dayEndIso = new Date(dayStart + 20 * 3600000).toISOString(); // 20:00 ET ≈ dayStart+20h
      const query = new URLSearchParams({
        symbols: symbol, timeframe: '1Min',
        start: dayStartIso, end: dayEndIso,
        limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc',
      });
      let page = null;
      const dayBars = [];
      for (let count = 0; count < 4; count++) {
        if (page) query.set('page_token', page);
        const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
        if (!data?.bars || typeof data.bars !== 'object') {
          throw new WarriorError('Historical intraday bars are unavailable.');
        }
        dayBars.push(...(data.bars[symbol] || []));
        page = data.next_page_token;
        if (!page) break;
      }
      const normalized = dayBars
        .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
        .filter(b => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite))
        .sort((a, b) => a.t - b.t);
      if (normalized.length) { out.push(...normalized); fetched++; }
    }
    return out.sort((a, b) => a.t - b.t);
  }
  function backtestStrategy(symbol, ctx, rules) {
    // Mirrors scoreSymbol()'s detect→score gate on the engine's per-bar
    // context. Returns null for "no signal" — the engine handles session
    // windows, sizing, RR, daily-loss halts, and EOD flattening itself.
    try {
      const regime = (ctx.regime && ctx.regime.regime) || 'NEUTRAL';
      const allowed = rules.allowedPatterns || {};
      const pattern = (ctx.patterns || []).find(p => p && allowed[p.pattern_name] !== false) || null;
      if (!pattern || pattern.pattern_valid === false) return null;
      const price = +ctx.bar.c;
      if (!Number.isFinite(price) || price <= 0) return null;
      if (!(price >= rules.minPrice && price <= rules.maxPrice)) return null;
      const dailies = ctx.history.daily || [];
      const prevDaily = dailies[dailies.length - 2] || {};
      const lastDaily = dailies[dailies.length - 1] || {};
      const dayChgPct = +prevDaily.c ? ((price - +prevDaily.c) / +prevDaily.c) * 100 : 0;
      if (!(dayChgPct >= rules.minPctGain)) return null;
      const avgDayVol = dailies.length >= 21
        ? dailies.slice(-21, -1).reduce((s, b) => s + (+b.v || 0), 0) / 20 : null;
      const dayRvol = avgDayVol ? (+lastDaily.v || 0) / avgDayVol : null;
      if (dayRvol != null && dayRvol < rules.minRvol) return null;
      const ind = ctx.indicators || [];
      const row = ind[ind.length - 1] || {};
      const prevRow = ind[ind.length - 2] || {};
      const closes = dailies.map(b => +b.c).filter(Number.isFinite);
      const e200 = closes.length >= 200 ? emaSeries(closes, 200) : null;
      const scoring = scoreSetup({
        pattern,
        ind: { price, vwap: row.vwap, ema9: row.ema9, ema20: row.ema20,
          macd: row.macd, macdHist: row.macdHist, macdHistPrev: prevRow.macdHist, rvol: row.rvol },
        regime,
        dayChangePct: dayChgPct,
        newIntradayHigh: ctx.newIntradayHigh,
        volumeExpanding: (row.rvol || 0) >= 1.5,
        aboveEma200Daily: e200 ? price > e200[e200.length - 1] : null,
      }, {
        minScore: rules.minScore, highQuality: rules.highQuality,
        minScoreBull: rules.minScoreBull, minScoreNeutral: rules.minScoreNeutral,
        minScoreBear: rules.minScoreBear, minRR: rules.minRR,
        strongRvol: rules.strongRvol, veryStrongRvol: rules.veryStrongRvol,
      });
      if (!scoring.meetsMinimum) return null;
      if (!(pattern.risk_reward >= rules.minRR)) return null;
      if (!(pattern.entry_price > pattern.stop_price && pattern.target_price > pattern.entry_price)) return null;
      return {
        pattern,
        entry: pattern.entry_price, stop: pattern.stop_price, target: pattern.target_price,
        pattern_name: pattern.pattern_name,
      };
    } catch { return null; }
  }
  async function runBacktestRoute(uid, input = {}) {
    validateInput(input, ['symbols', 'days', 'params', 'limit'], 'Only symbols, days, params and limit may be supplied.');
    const symbols = Array.isArray(input.symbols) && input.symbols.length
      ? [...new Set(input.symbols.map(s => String(s).toUpperCase()).filter(Boolean))].slice(0, 10)
      : ['SPY'];
    if (!symbols.length) throw new WarriorError('At least one symbol is required.', 400);
    const days = Math.min(Math.max(Number(input.days) || 30, 5), 90);
    const rules = getRules(uid);
    const params = {
      minScoreBull: rules.minScoreBull, minScoreNeutral: rules.minScoreNeutral,
      minScoreBear: rules.minScoreBear, minRR: rules.minRR,
      riskPerTradePct: rules.riskPerTradePct, maxRiskPerTradePct: rules.maxRiskPerTradePct,
      maxDailyLossPct: rules.maxDailyLossPct, maxPositions: rules.maxPositions,
      // Exit-engine parity: the backtester mirrors (does not share) the
      // live exit logic, so the runner rules must be passed through or
      // backtests would silently use different exits than live trading.
      partialAtR: rules.partialAtR, partialPct: rules.partialPct,
      holdRunners: rules.holdRunners, fadeVolumeFraction: rules.fadeVolumeFraction,
      fadeStallBars: rules.fadeStallBars, fadeBaselineBars: rules.fadeBaselineBars,
      ...(input.params && typeof input.params === 'object' ? input.params : {}),
    };
    // Historical bars come through the same guarded broker path as the live
    // scan (read-only lease, dedicated Warrior credentials). Fail closed
    // when the broker is not connected — backtests never fabricate bars.
    const barsBySymbol = {};
    const dataErrors = {};
    const equity = await locked(uid, async lease => {
      const settings = ensure(uid);
      const cred = credential(uid, settings.mode);
      if (!cred) throw new WarriorError('Connect a dedicated Warrior broker account to run backtests.', 409);
      const ctx = { uid, lease, settings, cred, rules };
      let accountEquity = 25000;
      try {
        const account = await broker(ctx, '/v2/account');
        if (Number.isFinite(+account?.equity)) accountEquity = +account.equity;
      } catch (_) { /* sizing falls back to the default equity */ }
      const needIndex = ['SPY', 'QQQ'].filter(s => !symbols.includes(s));
      const dailyBySymbol = await loadDailyBars(ctx, [...symbols, ...needIndex], days + 40);
      for (const symbol of symbols) {
        guard(lease);
        try {
          const m1 = await loadBacktestMinuteBars(ctx, symbol, days);
          if (m1.length < 60) { dataErrors[symbol] = 'Insufficient minute bars for the requested range.'; continue; }
          const daily = (dailyBySymbol[symbol] || [])
            .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
            .filter(b => Number.isFinite(b.t));
          barsBySymbol[symbol] = { m1, m5: aggregateM5(m1), daily };
        } catch (error) {
          dataErrors[symbol] = error.message || 'Bar fetch failed.';
        }
      }
      // Index daily series let the engine classify regime the same way the
      // live scan does (the strategy symbols themselves stay untouched).
      for (const s of needIndex) {
        const daily = (dailyBySymbol[s] || [])
          .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
          .filter(b => Number.isFinite(b.t));
        if (daily.length >= 21) barsBySymbol[s] = { m1: [], m5: [], daily };
      }
      return accountEquity;
    });
    const evaluated = Object.keys(barsBySymbol).filter(s => (barsBySymbol[s].m1 || []).length);
    if (!evaluated.length) {
      throw new WarriorError('No usable historical data for the requested symbols.', 502);
    }
    const { report, trades } = runBacktest({
      barsBySymbol,
      strategy: (symbol, ctx) => backtestStrategy(symbol, ctx, rules),
      config: {
        equity,
        riskPerTradePct: rules.riskPerTradePct,
        maxRiskPerTradePct: rules.maxRiskPerTradePct,
        maxDailyLossPct: rules.maxDailyLossPct,
        maxPositions: rules.maxPositions,
      },
    });
    const backtestId = crypto.randomUUID();
    const createdAt = timestamp();
    const storedParams = { symbols, days, params, dataErrors };
    db.transaction(() => {
      db.prepare('INSERT INTO warrior_backtests(backtest_id,user_id,params,report,created_at) VALUES (?,?,?,?,?)')
        .run(backtestId, uid, JSON.stringify(storedParams), JSON.stringify(report), createdAt);
      const insert = db.prepare('INSERT INTO warrior_backtest_trades(backtest_id,idx,trade_json) VALUES (?,?,?)');
      const capped = (trades || []).slice(0, 500);
      capped.forEach((t, idx) => insert.run(backtestId, idx, JSON.stringify(t)));
    })();
    return { backtestId, report, trades: (trades || []).length, dataErrors };
  }
  function getBacktests(uid, query = {}) {
    const rows = db.prepare('SELECT backtest_id,params,created_at FROM warrior_backtests WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(uid);
    return { backtests: rows.map(r => ({ backtestId: r.backtest_id, params: JSON.parse(r.params || '{}'), createdAt: r.created_at })) };
  }
  function getBacktest(uid, backtestId) {
    const row = db.prepare('SELECT * FROM warrior_backtests WHERE backtest_id=? AND user_id=?').get(backtestId, uid);
    if (!row) throw new WarriorError('Backtest not found.', 404);
    const tradeRows = db.prepare('SELECT idx,trade_json FROM warrior_backtest_trades WHERE backtest_id=? ORDER BY idx').all(backtestId);
    return {
      backtestId: row.backtest_id, params: JSON.parse(row.params || '{}'),
      report: JSON.parse(row.report || '{}'), createdAt: row.created_at,
      trades: tradeRows.map(r => JSON.parse(r.trade_json)),
    };
  }

  const service = {
    strategy: STRATEGY,
    start, stop, drain,
    connect, disconnect, setSettings, getSettings: getSettingsView, status,
    proposals, approveProposal, rejectProposal, positions, trades, alerts,
    universe, latestScan, run,
    backtest: runBacktestRoute, getBacktests, getBacktest,
    pruneDiagnostics,
    DEFAULT_WARRIOR_RULES, PRE_TRADE_CHECKS, assessOrderFlow, preTradeInputs,
    // Test seam: evaluate one symbol's scan pipeline without a broker.
    // Accepts { uid, symbol, m1, daily, rules, account }; requires a live
    // lease row for the uid (guard checks the warrior_leases table).
    scoreSymbol: ({ uid, symbol, m1, daily, rules, account }) =>
      scoreSymbol({ uid, symbol, m1, daily, levels: buildLevels(m1, daily),
        regime: { regime: 'BULLISH', reasons: [] }, rules: rules || DEFAULT_WARRIOR_RULES,
        account: account || {} }),
  };
  return service;
}

// ---------------------------------------------------------------------------
// Route mounting — mirrors b2-service.mountB2 but under /api/warrior.
// ---------------------------------------------------------------------------
function mountWarrior({ app, service, requireAuth, ensureSessionUserInTradingStore }) {
  if (!app || !service || typeof requireAuth !== 'function') throw new Error('Warrior requires an app, a service and requireAuth.');
  const withUser = handler => async (req, res, next) => {
    try {
      // Mirror B2: sync the session user into the trading store before any
      // FK-scoped warrior_* write.
      const uid = ensureSessionUserInTradingStore
        ? await ensureSessionUserInTradingStore(req)
        : Number(req.session?.userId);
      const result = await handler(uid, req, res);
      // Handlers return plain data; serialize it like B2's route wrapper.
      // If a handler already sent a response (headersSent), leave it alone.
      if (!res.headersSent && result !== undefined) res.json(result);
    } catch (error) {
      const status = error instanceof WarriorError ? error.status : 500;
      if (!res.headersSent) res.status(status).json({ error: error?.message || 'Warrior request failed.' });
    }
  };
  const json = bodyParserJson();
  app.get('/api/warrior/status', requireAuth, withUser(uid => service.status(uid)));
  app.post('/api/warrior/connect', requireAuth, json, withUser((uid, req) => service.connect(uid, req.body || {})));
  app.post('/api/warrior/disconnect', requireAuth, json, withUser(uid => service.disconnect(uid)));
  app.get('/api/warrior/settings', requireAuth, withUser(uid => service.getSettings(uid)));
  app.put('/api/warrior/settings', requireAuth, json, withUser((uid, req) => service.setSettings(uid, req.body || {})));
  app.get('/api/warrior/scan', requireAuth, withUser(uid => service.latestScan(uid)));
  app.get('/api/warrior/proposals', requireAuth, withUser((uid, req) => service.proposals(uid, req.query || {})));
  app.post('/api/warrior/proposals/:id/approve', requireAuth, json, withUser((uid, req) => service.approveProposal(uid, req.params.id)));
  app.post('/api/warrior/proposals/:id/reject', requireAuth, json, withUser((uid, req) => service.rejectProposal(uid, req.params.id, req.body || {})));
  app.get('/api/warrior/positions', requireAuth, withUser(uid => service.positions(uid)));
  app.get('/api/warrior/trades', requireAuth, withUser((uid, req) => service.trades(uid, req.query || {})));
  app.post('/api/warrior/backtest', requireAuth, json, withUser((uid, req) => service.backtest(uid, req.body || {})));
  app.get('/api/warrior/backtests', requireAuth, withUser((uid, req) => service.getBacktests(uid, req.query || {})));
  app.get('/api/warrior/backtests/:id', requireAuth, withUser((uid, req) => service.getBacktest(uid, req.params.id)));
  app.get('/api/warrior/alerts', requireAuth, withUser(uid => service.alerts(uid)));
  app.get('/api/warrior/universe', requireAuth, withUser(uid => service.universe(uid)));
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

module.exports = {
  createWarriorService,
  mountWarrior,
  WarriorError,
  DEFAULT_WARRIOR_RULES,
  PRE_TRADE_CHECKS,
  assessOrderFlow,
  preTradeInputs,
  volumeFadeDetected,
};
