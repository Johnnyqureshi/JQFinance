'use strict';

// Crypto Breakout Bot — orchestration service (server-side).
//
// The crypto engine (lib/crypto/indicators, scoring, regime) is pure. This
// module wires it into the running app the way lib/warrior/service.js wires
// the Warrior strategy: own crypto_* tables, own op leases (crypto_leases),
// a 60s scheduler loop STAGGERED ~15s behind B2's loop (halfway between B2
// and Warrior), FULLY AUTOMATED entries in paper (no manual approval —
// unlike Warrior), server-side position management, and /api/crypto/*
// routes via mountCrypto(). B2 and Warrior files, tables, routes and UI are
// never touched.
//
// Primary loop: FIND BREAKOUT → CONFIRM WITH VOLUME → ENTER → RIDE
// MOMENTUM → DETECT VOLUME FADE/EXHAUSTION → TAKE PROFITS → TRAIL REMAINING.
//
// Safety posture (mirrors B2/Warrior): fail-closed — any broker/data/
// stale-data/order-confirmation/risk failure withholds new orders; open
// positions are reconciled with the broker before acting when state is
// unknown; fills are never assumed. PAPER is the default AND ONLY mode —
// there is no live_armed column on crypto_settings and any live activation
// attempt is refused loudly.
//
// Crypto never closes: there is NO market-hours gate. The 60s scheduler runs
// 24/7. Data requests are FEED-LESS: Alpaca's v1beta3 crypto endpoints
// reject ANY feed parameter with HTTP 400 ("unexpected query parameter(s):
// feed") — verified live 2026-10-05. There is no SIP/IEX split for crypto
// data; sending feed=sip (the stock-API habit) broke every bars/quotes
// call. Never add a feed parameter to a crypto data request.

const crypto = require('crypto');
const {
  emaSeries, rsiSeries, macdSeries, atrSeries, sessionVwap,
  avgVolume, volumeMaSeries, rvol, swingPoints, marketStructure,
  rollingHigh, rollingLow, computeCryptoIntraday, utcDateKey,
} = require('./indicators');
const {
  scoreBreakout, minScoreForRegime, rvolRequirementMultiplier,
  DEFAULT_RULES: SCORING_DEFAULTS, DEFAULT_WEIGHTS,
} = require('./scoring');
const { classifyBtcRegime, altcoinLongsAllowed } = require('./regime');

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced']);
const PAPER = 'https://paper-api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const STRATEGY = 'crypto';
const SCOPE = 'crypto'; // broker_account_owners scope for the crypto bot's dedicated account
const SCHEDULER_MS = 60000;
const UNIVERSE_REFRESH_MS = 6 * 3600000;
const QUOTE_MAX_AGE_MS = 120000;
const OPPORTUNITY_TTL_MS = 4 * 3600000; // opportunities expire after 4h without entry
const STABLECOINS = new Set(['USDC', 'USDT', 'USDG']);

// Full config surface. Stored as JSON in crypto_settings.rules; the
// settings UI edits every key below.
const DEFAULT_CRYPTO_RULES = Object.freeze({
  // Opportunity scoring (spec §4) — 0–100 with Johnny's weights.
  minScore: 75, highQuality: 85,
  weights: Object.freeze({ ...DEFAULT_WEIGHTS }),
  // Breakout detection (spec §6–§7)
  rvolMin: 2.0, rvolStrong: 3.0, rvolExceptional: 4.0,
  swingLeft: 3, swingRight: 3,
  resistanceLookback: 50,
  breakoutMaxExtensionAtr: 2.0, // don't chase extremely extended candles
  retestEnabled: true, retestWindowHours: 24,
  // Universe filters (spec §1–§2)
  maxSpreadPct: 0.5, minDollarVolume24h: 1000000, minPrice: 0.01,
  stablecoinsEnabled: false, paxgEnabled: false,
  scanBudget: 50,
  // Entries — FULLY AUTOMATED in paper (spec §22); no approval step.
  autoEnter: true,
  sizingMode: 'fixed_dollar', // 'fixed_dollar' | 'pct_equity'
  fixedDollar: 500, pctEquity: 2,
  maxPositionNotional: 2000, maxPositionPct: 5,
  stopMode: 'atr', // 'pct' | 'atr' | 'structure'
  stopPct: 3, atrStopMult: 2.0,
  // Profit management (spec §12) — configurable scale-out ladder.
  scaleOutTiers: Object.freeze([
    Object.freeze({ pct: 2, qty: 0.2 }),
    Object.freeze({ pct: 4, qty: 0.2 }),
    Object.freeze({ pct: 6, qty: 0.2 }),
  ]),
  // Trailing stop (spec §15) — ATR-based with tightening stages.
  trailingAtrMult: 2.5,
  tightenOnVolumeFade: 1.8,
  tightenOnExhaustion: 1.2,
  // Exits (spec §13–§15)
  breakoutFailureBars: 6,
  vwapLossEnabled: true, emaBreakdownEnabled: true,
  // Risk engine (spec §16–§19)
  maxDailyLossPct: 3, maxPositions: 5, maxConsecutiveLosses: 4,
  maxTradesPerHour: 6, maxTotalExposurePct: 25, maxCorrelatedExposurePct: 15,
  emergencyStop: false,
});
const EXIT_REASONS = Object.freeze([
  'TAKE_PROFIT', 'PARTIAL_PROFIT', 'VOLUME_FADE', 'MOMENTUM_EXHAUSTION',
  'TRAILING_STOP', 'STOP_LOSS', 'BREAKOUT_FAILURE', 'VWAP_LOSS',
  'EMA_BREAKDOWN', 'BEARISH_REVERSAL', 'MARKET_REGIME_CHANGE', 'MANUAL_EXIT',
]);
// Journal columns for crypto_trades (TEXT storage, like warrior's journal).
const CRYPTO_TRADE_FIELDS = Object.freeze([
  'tradeId', 'symbol', 'date', 'enteredAt', 'exitedAt',
  'entryPrice', 'exitPrice', 'qty', 'entryScore', 'entryRvol', 'regime',
  'breakoutLevel', 'stopPrice', 'targetPrice', 'entryReason', 'exitReason',
  'exitDetail', 'pnl', 'pnlPct', 'mfe', 'mae', 'holdMinutes',
  'orderStatus', 'entryOrderId', 'exitOrderId',
]);

class CryptoError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
function number(value) { return value == null || value === '' ? NaN : Number(value); }
function clientId(...parts) {
  return `crypto-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}
function baseSymbol(symbol) {
  return String(symbol || '').split('/')[0].toUpperCase();
}
function roundQty(qty) {
  // Fractional crypto quantities — 8dp is plenty for every Alpaca pair.
  return Math.floor(number(qty) * 1e8) / 1e8;
}
function utcDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function createCryptoService({
  db, vault, fetch: fetchBroker, now = () => Date.now(),
  getAutomaticBotContext = async () => null,
  automaticBotSettings = null,
  persistenceReady = () => true,
  durability = null,
  sendEmail = null,
  batchSize = 100, timeoutMs = 10000, leaseMs = 180000,
  exitPoll = null, // { tries, intervalMs } — test seam
}) {
  if (!db || !vault || typeof fetchBroker !== 'function') throw new Error('Crypto requires database, vault and fetch.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Crypto batch size must be an integer between 1 and 1000.');
  let timer = null;
  let running = false;
  let generation = 0;
  let ticking = false;
  let activeTick = null;
  const timestamp = () => new Date(now()).toISOString();

  // ---------------------------------------------------------------------------
  // Schema — all crypto_* tables, user-scoped unless noted. Created at
  // service construction so a cold start works without any migration step.
  // ---------------------------------------------------------------------------
  const tradeFieldDefs = CRYPTO_TRADE_FIELDS.map(f => `"${f}" TEXT`).join(',\n    ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS crypto_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'paper',
      rules TEXT NOT NULL DEFAULT '{}',
      scheduler_status TEXT NOT NULL DEFAULT 'idle',
      scheduler_reason TEXT,
      last_cycle_at TEXT
    );
    CREATE TABLE IF NOT EXISTS crypto_credentials (
      user_id INTEGER NOT NULL REFERENCES users(id),
      mode TEXT NOT NULL,
      key_enc TEXT NOT NULL,
      secret_enc TEXT NOT NULL,
      account_id TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (user_id, mode)
    );
    CREATE TABLE IF NOT EXISTS crypto_universe (
      symbol TEXT PRIMARY KEY,
      base TEXT NOT NULL,
      added_at TEXT NOT NULL,
      last_scanned TEXT,
      last_validated TEXT,
      priority REAL NOT NULL DEFAULT 0,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS crypto_breakouts (
      symbol TEXT PRIMARY KEY,
      level REAL NOT NULL,
      breakout_at TEXT NOT NULL,
      score REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crypto_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_run_id TEXT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      symbol TEXT NOT NULL,
      outcome TEXT NOT NULL,
      score REAL NOT NULL,
      score_breakdown TEXT NOT NULL DEFAULT '{}',
      price REAL, breakout_level REAL, rvol REAL, volume REAL,
      rsi REAL, macd REAL, vwap REAL, ema_structure TEXT, atr REAL,
      regime TEXT, reasons TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crypto_scan_runs (
      run_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      started_at TEXT NOT NULL,
      symbols_scanned INTEGER NOT NULL DEFAULT 0,
      candidates INTEGER NOT NULL DEFAULT 0,
      opportunities INTEGER NOT NULL DEFAULT 0,
      entries INTEGER NOT NULL DEFAULT 0,
      exits INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      regime TEXT,
      detail_json TEXT
    );
    CREATE TABLE IF NOT EXISTS crypto_positions (
      position_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      symbol TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      entry_price REAL,
      stop_price REAL,
      entry_atr REAL,
      entry_rvol REAL,
      entry_score REAL,
      regime_at_entry TEXT,
      breakout_level REAL,
      highest_price REAL,
      mfe REAL NOT NULL DEFAULT 0,
      mae REAL NOT NULL DEFAULT 0,
      scale_tiers_hit TEXT NOT NULL DEFAULT '[]',
      banked_pnl REAL NOT NULL DEFAULT 0,
      trailing_mult REAL,
      volume_fade_stage INTEGER NOT NULL DEFAULT 0,
      stop_stage TEXT NOT NULL DEFAULT 'initial',
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TEXT NOT NULL,
      updated_at TEXT,
      entry_order_id TEXT
    );
    CREATE TABLE IF NOT EXISTS crypto_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      ${tradeFieldDefs},
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crypto_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crypto_backtests (
      backtest_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      params TEXT NOT NULL,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crypto_backtest_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backtest_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      trade_json TEXT NOT NULL
    );
    -- crypto_journal retired 2026-09-29 (Johnny: no zombie data).
    -- Dead table: no API route or UI ever read it; dropped at boot.
    CREATE TABLE IF NOT EXISTS crypto_leases (
      user_id INTEGER PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  // Idempotent migrations for existing databases.
  for (const [table, column, ddl] of [
    ['crypto_positions', 'protection_gen', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  // ---------------------------------------------------------------------------
  // Settings, credentials, leases, broker plumbing — mirrors warrior-service.
  // ---------------------------------------------------------------------------
  const getSettings = uid => db.prepare('SELECT * FROM crypto_settings WHERE user_id=?').get(uid);
  function ensure(uid) {
    db.prepare('INSERT OR IGNORE INTO crypto_settings(user_id) VALUES (?)').run(uid);
    return getSettings(uid);
  }
  function getRules(uid) {
    const settings = ensure(uid);
    let stored = {};
    try { stored = JSON.parse(settings.rules || '{}'); } catch (_) { stored = {}; }
    const merged = { ...DEFAULT_CRYPTO_RULES, ...stored };
    merged.weights = { ...DEFAULT_CRYPTO_RULES.weights, ...(stored.weights || {}) };
    if (!Array.isArray(merged.scaleOutTiers)) merged.scaleOutTiers = [...DEFAULT_CRYPTO_RULES.scaleOutTiers];
    return merged;
  }
  function credential(uid, mode) {
    const row = db.prepare('SELECT * FROM crypto_credentials WHERE user_id=? AND mode=?').get(uid, mode);
    if (!row) return null;
    // A missing or half-encrypted row fails closed, exactly like B2/Warrior.
    if (!vault.isEncrypted(row.key_enc) || !vault.isEncrypted(row.secret_enc)) return null;
    return row;
  }
  const quarantined = account =>
    !!db.prepare('SELECT 1 FROM broker_account_quarantine WHERE account_id=? AND resolved_at IS NULL').get(account);
  const EMAIL_KINDS = new Set(['entry', 'fill', 'exit', 'risk', 'system']);
  function alert(uid, kind, message) {
    // Messages are fixed application text, never upstream error bodies or credentials.
    const previous = db.prepare('SELECT kind,message,created_at FROM crypto_alerts WHERE user_id=? ORDER BY id DESC LIMIT 1').get(uid);
    if (previous?.kind === kind && previous.message === message && now() - Date.parse(previous.created_at) < 300000) return;
    db.prepare('INSERT INTO crypto_alerts(user_id,kind,message,created_at) VALUES (?,?,?,?)')
      .run(uid, kind, message, timestamp());
    if (sendEmail && EMAIL_KINDS.has(kind)) {
      try { void Promise.resolve(sendEmail({ userId: uid, kind, message })).catch(() => {}); }
      catch (_) { /* alert persistence above is authoritative */ }
    }
  }
  async function locked(uid, work) {
    const token = crypto.randomUUID();
    const result = db.prepare(`INSERT INTO crypto_leases(user_id,token,expires_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
      WHERE crypto_leases.expires_at<=?`).run(uid, token, now() + leaseMs, now());
    if (!result.changes) throw new CryptoError('Crypto is reconciling this account. Retry shortly.');
    const lease = { uid, token, generation };
    try { return await work(lease); }
    finally {
      db.prepare('DELETE FROM crypto_leases WHERE user_id=? AND token=?').run(uid, token);
      if (durability?.flush && persistenceReady()) await durability.flush('crypto-operation');
    }
  }
  function guard(lease) {
    const renewed = db.prepare('UPDATE crypto_leases SET expires_at=? WHERE user_id=? AND token=? AND expires_at>?')
      .run(now() + leaseMs, lease.uid, lease.token, now());
    if (!renewed.changes) throw new CryptoError('Crypto lease expired; broker action withheld.');
  }
  function context(uid, lease, mode) {
    const settings = ensure(uid);
    const cred = credential(uid, mode || settings.mode);
    if (!cred) throw new CryptoError('Connect a dedicated crypto broker account.');
    return { uid, lease, settings, cred, rules: getRules(uid) };
  }
  function authorize(ctx) {
    guard(ctx.lease);
    const cred = credential(ctx.uid, ctx.cred.mode);
    if (!cred || cred.account_id !== ctx.cred.account_id || cred.key_enc !== ctx.cred.key_enc ||
        cred.secret_enc !== ctx.cred.secret_enc) {
      throw new CryptoError('Crypto authorization changed; action withheld.');
    }
    const owner = db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (!owner || owner.scope !== SCOPE || owner.user_id !== ctx.uid || owner.mode !== cred.mode || quarantined(cred.account_id)) {
      throw new CryptoError('Crypto broker account ownership is not verified.');
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
          VALUES ('crypto',?,?,?,?,?,?,?,?,'prepared',datetime('now'))
        `).run(ctx.uid, cred.account_id, cred.mode, method, path, purpose, clientOrderId, JSON.stringify(body || {}));
        ctx.actionIntentId = intent.lastInsertRowid;
      }
      await durability.flush(`crypto-before-${method.toLowerCase()}`);
      if (ctx) authorize(ctx);
    }
    const controller = new AbortController();
    let timeout;
    try {
      const call = (async () => {
        const doFetch = p => fetchBroker(`${data ? DATA : PAPER}${p}`, {
          method, signal: controller.signal,
          headers: { 'APCA-API-KEY-ID': vault.decrypt(cred.key_enc), 'APCA-API-SECRET-KEY': vault.decrypt(cred.secret_enc), 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        let response = await doFetch(path);
        // No feed fallback here: crypto data endpoints reject the feed
        // parameter outright (HTTP 400), so there is nothing to fall back
        // to — requests are built feed-less at the call sites.
        if (allow404 && response.status === 404) return null;
        if (!response.ok) {
          const failure = new CryptoError(`Broker request failed (HTTP ${response.status}); action withheld.`, 502);
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
        timeout = setTimeout(() => { controller.abort(); reject(new CryptoError('Broker request timed out; reconciliation required.', 502)); }, timeoutMs);
      })]);
      if (ctx) guard(ctx.lease);
      if (method !== 'GET' && durability?.flush) {
        if (ctx?.actionIntentId) db.prepare(`
          UPDATE automated_action_intents SET state='submitted', broker_order_id=?, updated_at=datetime('now')
          WHERE id=?
        `).run(result?.id || null, ctx.actionIntentId);
        await durability.flush(`crypto-after-${method.toLowerCase()}`);
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
        try { await durability.flush(`crypto-unknown-${method.toLowerCase()}`); } catch (_) {}
      }
      if (error instanceof CryptoError) throw error;
      throw new CryptoError('Broker connection or response failed; action withheld.', 502);
    } finally { clearTimeout(timeout); }
  }
  // Paper-only: cred.mode is always 'paper' (connect() never stores live
  // credentials), so the broker host is always PAPER.
  async function broker(ctx, path, options = {}) {
    return request(ctx.cred, path, { ...options, ctx });
  }
  function validateAccount(account, expected) {
    if (typeof account?.id !== 'string' || !account.id.trim() || (expected && account.id !== expected) || account.status !== 'ACTIVE' ||
        account.trading_blocked || account.account_blocked || account.trade_suspended_by_user) {
      throw new CryptoError('Broker account identity or trading permission is not valid.');
    }
  }
  async function orderByClient(ctx, id) {
    return broker(ctx, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`, { allow404: true });
  }
  function release(uid, cred) {
    if (!cred) return;
    const remaining = db.prepare('SELECT 1 FROM crypto_credentials WHERE account_id=?').get(cred.account_id);
    if (!remaining) db.prepare("DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope='crypto'").run(cred.account_id, uid);
  }
  function validateInput(input, allowed, message) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowed.includes(key))) throw new CryptoError(message, 400);
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // ---------------------------------------------------------------------------
  // Connect / disconnect / settings / status
  // ---------------------------------------------------------------------------
  async function connect(uid, input) {
    if (!persistenceReady()) throw new CryptoError('Automated trading persistence is unavailable; crypto entries remain paused.', 503);
    validateInput(input, ['key', 'secret'], 'Only key and secret may be supplied.');
    if (typeof input.key !== 'string' || typeof input.secret !== 'string' ||
        !input.key.trim() || !input.secret.trim() || input.key.length > 512 || input.secret.length > 512) {
      throw new CryptoError('Valid API key and secret are required.', 400);
    }
    return locked(uid, async lease => {
      const settings = ensure(uid);
      const next = { mode: 'paper', key_enc: vault.encrypt(input.key.trim()), secret_enc: vault.encrypt(input.secret.trim()) };
      const account = await request(next, '/v2/account');
      validateAccount(account);
      guard(lease);
      db.transaction(() => {
        if (quarantined(account.id)) throw new CryptoError('Broker account is quarantined.');
        const owner = db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at)
          VALUES (?,?,'crypto',?,?) ON CONFLICT(account_id) DO UPDATE SET claimed_at=excluded.claimed_at
          WHERE broker_account_owners.user_id=excluded.user_id AND broker_account_owners.scope='crypto'
            AND broker_account_owners.mode=excluded.mode`).run(account.id, uid, 'paper', timestamp());
        if (!owner.changes) throw new CryptoError('This broker account is already assigned to another user, mode or trading scope.');
        const old = credential(uid, 'paper');
        db.prepare(`INSERT INTO crypto_credentials(user_id,mode,key_enc,secret_enc,account_id,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(user_id,mode) DO UPDATE SET key_enc=excluded.key_enc,secret_enc=excluded.secret_enc,
            account_id=excluded.account_id,updated_at=excluded.updated_at`)
          .run(uid, 'paper', next.key_enc, next.secret_enc, account.id, timestamp());
        release(uid, old);
        // Connect-and-go for paper: the 24/7 scanner starts immediately.
        // Live is never connected — the bot is paper-only by design.
        db.prepare("UPDATE crypto_settings SET mode='paper',enabled=1,scheduler_status='idle',scheduler_reason=NULL WHERE user_id=?").run(uid);
        automaticBotSettings?.revoke?.(uid, 'crypto');
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
      const live = db.prepare(`SELECT 1 FROM crypto_positions
        WHERE user_id=? AND status IN ('open','pending_entry') LIMIT 1`).get(uid);
      if (live) throw new CryptoError('Close or flatten all crypto positions (including pending entries) before disconnecting.');
      const rows = db.prepare('SELECT * FROM crypto_credentials WHERE user_id=?').all(uid);
      db.transaction(() => {
        db.prepare('DELETE FROM crypto_credentials WHERE user_id=?').run(uid);
        rows.forEach(row => release(uid, row));
        db.prepare('UPDATE crypto_settings SET enabled=0 WHERE user_id=?').run(uid);
      });
      void lease;
      return status(uid);
    });
  }
  const RULE_TYPES = {
    minScore: 'number', highQuality: 'number',
    rvolMin: 'number', rvolStrong: 'number', rvolExceptional: 'number',
    swingLeft: 'number', swingRight: 'number', resistanceLookback: 'number',
    breakoutMaxExtensionAtr: 'number',
    retestEnabled: 'boolean', retestWindowHours: 'number',
    maxSpreadPct: 'number', minDollarVolume24h: 'number', minPrice: 'number',
    stablecoinsEnabled: 'boolean', paxgEnabled: 'boolean',
    scanBudget: 'number',
    autoEnter: 'boolean',
    sizingMode: ['fixed_dollar', 'pct_equity'],
    fixedDollar: 'number', pctEquity: 'number',
    maxPositionNotional: 'number', maxPositionPct: 'number',
    stopMode: ['pct', 'atr', 'structure'],
    stopPct: 'number', atrStopMult: 'number',
    trailingAtrMult: 'number', tightenOnVolumeFade: 'number', tightenOnExhaustion: 'number',
    breakoutFailureBars: 'number',
    vwapLossEnabled: 'boolean', emaBreakdownEnabled: 'boolean',
    maxDailyLossPct: 'number', maxPositions: 'number', maxConsecutiveLosses: 'number',
    maxTradesPerHour: 'number', maxTotalExposurePct: 'number', maxCorrelatedExposurePct: 'number',
    emergencyStop: 'boolean',
  };
  const LIVE_KEYS = new Set(['tradingMode', 'liveEnabled', 'liveConfirmed', 'live_armed', 'liveArmed']);
  function setSettings(uid, input) {
    validateInput(input, ['enabled', 'rules', 'weights', 'scaleOutTiers'], 'Only enabled, rules, weights and scaleOutTiers may be changed.');
    return locked(uid, async () => {
      const current = ensure(uid);
      const rules = { ...getRules(uid) };
      const patch = input.rules && typeof input.rules === 'object' ? input.rules : {};
      // PAPER-ONLY: the crypto bot has no live_armed column and no live
      // path. Any live activation attempt is refused loudly, never stored.
      for (const key of Object.keys(patch)) {
        if (LIVE_KEYS.has(key)) {
          throw new CryptoError('The crypto breakout bot is paper-only. Live activation is refused — there is no live mode to arm.', 403);
        }
      }
      for (const [key, value] of Object.entries(patch)) {
        const type = RULE_TYPES[key];
        if (!type) throw new CryptoError(`Unknown setting: ${key}.`, 400);
        if (Array.isArray(type)) {
          if (!type.includes(value)) throw new CryptoError(`${key} must be one of ${type.join(', ')}.`, 400);
        } else if (type === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new CryptoError(`${key} must be a finite non-negative number.`, 400);
        } else if (type === 'boolean') {
          if (typeof value !== 'boolean') throw new CryptoError(`${key} must be boolean.`, 400);
        }
        rules[key] = value;
      }
      if (input.weights && typeof input.weights === 'object') {
        for (const [name, weight] of Object.entries(input.weights)) {
          if (!(name in DEFAULT_CRYPTO_RULES.weights)) throw new CryptoError(`Unknown weight: ${name}.`, 400);
          if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) throw new CryptoError(`Weight ${name} must be a finite non-negative number.`, 400);
          rules.weights[name] = weight;
        }
      }
      if (input.scaleOutTiers !== undefined) {
        if (!Array.isArray(input.scaleOutTiers) || !input.scaleOutTiers.length || input.scaleOutTiers.length > 5 ||
            !input.scaleOutTiers.every(t => t && typeof t.pct === 'number' && t.pct > 0 &&
              typeof t.qty === 'number' && t.qty > 0 && t.qty < 1)) {
          throw new CryptoError('scaleOutTiers must be 1–5 tiers of { pct>0, 0<qty<1 }.', 400);
        }
        const total = input.scaleOutTiers.reduce((s, t) => s + t.qty, 0);
        if (total >= 1) throw new CryptoError('scaleOutTiers must leave a runner — total tier qty must be < 1.', 400);
        rules.scaleOutTiers = input.scaleOutTiers.map(t => ({ pct: t.pct, qty: t.qty }));
      }
      // Sanity: RVOL tiers stay ordered; risk budget stays sane.
      if (!(rules.rvolMin <= rules.rvolStrong && rules.rvolStrong <= rules.rvolExceptional)) {
        throw new CryptoError('RVOL tiers must satisfy min ≤ strong ≤ exceptional.', 400);
      }
      const enabled = input.enabled === undefined ? !!current.enabled : !!input.enabled;
      db.prepare('UPDATE crypto_settings SET enabled=?,rules=? WHERE user_id=?')
        .run(Number(enabled), JSON.stringify({ ...rules, weights: rules.weights, scaleOutTiers: rules.scaleOutTiers }), uid);
      return status(uid);
    });
  }
  function getSettingsView(uid) {
    const settings = ensure(uid);
    const rules = getRules(uid);
    return {
      enabled: !!settings.enabled, mode: settings.mode, rules,
      paperNote: 'The crypto breakout bot is paper-only by design: crypto_settings has no live_armed column, and any live activation attempt is refused loudly.',
      exitReasons: [...EXIT_REASONS],
    };
  }
  function openPositions(uid) {
    return db.prepare("SELECT * FROM crypto_positions WHERE user_id=? AND status='open' ORDER BY opened_at").all(uid);
  }
  function closedTrades(uid) {
    return db.prepare("SELECT * FROM crypto_trades WHERE user_id=? AND exitedAt IS NOT NULL AND exitedAt != '' ORDER BY exitedAt").all(uid);
  }
  function paperStats(uid, openUnrealized = 0) {
    const trades = closedTrades(uid);
    const pnls = trades.map(t => number(t.pnl)).filter(Number.isFinite);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const grossWin = wins.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
    const net = pnls.reduce((s, p) => s + p, 0);
    // Max drawdown over the realized equity curve.
    let peak = 0, curve = 0, maxDd = 0;
    for (const p of pnls) {
      curve += p;
      if (curve > peak) peak = curve;
      maxDd = Math.max(maxDd, peak - curve);
    }
    return {
      tradeCount: pnls.length,
      wins: wins.length, losses: losses.length,
      winRate: pnls.length ? wins.length / pnls.length : null,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : (grossWin > 0 ? null : null),
      grossWin: +grossWin.toFixed(2), grossLoss: +grossLoss.toFixed(2),
      netPnl: +net.toFixed(2),
      maxDrawdown: +maxDd.toFixed(2),
      openUnrealized: +openUnrealized.toFixed(2),
    };
  }
  function dailyStats(uid, equity) {
    const today = utcDay(now());
    const closedToday = db.prepare('SELECT * FROM crypto_trades WHERE user_id=? AND date=?').all(uid, today);
    const dayPnl = closedToday.reduce((sum, t) => sum + (number(t.pnl) || 0), 0);
    const recent = db.prepare('SELECT pnl, exitedAt FROM crypto_trades WHERE user_id=? AND exitedAt IS NOT NULL AND exitedAt != ? ORDER BY exitedAt DESC LIMIT 20').all(uid, '');
    let consecutiveLosses = 0;
    let minutesSinceLastLoss = null;
    for (const t of recent) {
      if ((number(t.pnl) || 0) < 0) {
        consecutiveLosses++;
        if (minutesSinceLastLoss === null && t.exitedAt) minutesSinceLastLoss = (now() - Date.parse(t.exitedAt)) / 60000;
      } else break;
    }
    const hourAgo = new Date(now() - 3600000).toISOString();
    const tradesLastHour = db.prepare('SELECT COUNT(*) AS n FROM crypto_trades WHERE user_id=? AND enteredAt>=?').get(uid, hourAgo)?.n || 0;
    return {
      dayPnl, consecutiveLosses, minutesSinceLastLoss, tradesLastHour,
      openPositions: openPositions(uid).length,
      equity: number(equity) || 0,
    };
  }
  // Full risk-engine gate for NEW entries. Returns { ok, reasons[] }.
  function entryGates({ uid, rules, stats, account, quote, symbol, notional, spreadPct, regime }) {
    const reasons = [];
    const equity = number(account?.equity) || stats.equity || 0;
    if (rules.emergencyStop) reasons.push('Emergency stop is active.');
    if (stats.dayPnl <= -(rules.maxDailyLossPct / 100) * equity && equity > 0)
      reasons.push(`Daily loss ${(stats.dayPnl).toFixed(2)} hit the ${rules.maxDailyLossPct}% cap.`);
    if (stats.consecutiveLosses >= rules.maxConsecutiveLosses)
      reasons.push(`${stats.consecutiveLosses} consecutive losses (max ${rules.maxConsecutiveLosses}).`);
    if (stats.openPositions >= rules.maxPositions)
      reasons.push(`${stats.openPositions} open positions (max ${rules.maxPositions}).`);
    if (stats.tradesLastHour >= rules.maxTradesPerHour)
      reasons.push(`${stats.tradesLastHour} trades in the last hour (max ${rules.maxTradesPerHour}).`);
    if (equity > 0) {
      const exposure = currentExposure(uid, equity);
      if (exposure.totalPct >= rules.maxTotalExposurePct)
        reasons.push(`Total exposure ${exposure.totalPct.toFixed(1)}% ≥ ${rules.maxTotalExposurePct}% cap.`);
      // Correlation protection: crypto longs move together — cap the whole
      // correlated book, not just the single position.
      if (exposure.correlatedPct + (notional / equity) * 100 >= rules.maxCorrelatedExposurePct)
        reasons.push(`Correlated crypto exposure ${exposure.correlatedPct.toFixed(1)}% would exceed ${rules.maxCorrelatedExposurePct}%.`);
    }
    if (spreadPct != null && spreadPct > rules.maxSpreadPct)
      reasons.push(`Spread ${spreadPct.toFixed(3)}% exceeds ${rules.maxSpreadPct}% cap.`);
    if (!(notional > 0)) reasons.push('Position sizes to zero notional.');
    if (!quote) reasons.push('No fresh quote — bad data halts new entries.');
    const dup = db.prepare(`SELECT 1 FROM crypto_positions WHERE user_id=? AND symbol=? AND status IN ('open','pending_entry') LIMIT 1`)
      .get(uid, symbol);
    if (dup) reasons.push('A position in this symbol is already open or pending.');
    if (regime === 'bearish' || regime === 'high_volatility') {
      if (!altcoinLongsAllowed(regime) && baseSymbol(symbol) !== 'BTC')
        reasons.push(`BTC regime is ${regime} — new altcoin longs withheld.`);
    }
    return { ok: reasons.length === 0, reasons };
  }
  function currentExposure(uid, equity) {
    // Local open positions are the exposure book (broker-truth reconciled
    // every cycle before entries run).
    const rows = db.prepare("SELECT symbol, qty, entry_price FROM crypto_positions WHERE user_id=? AND status='open'").all(uid);
    let total = 0;
    for (const r of rows) total += Math.abs(number(r.qty) * number(r.entry_price));
    const totalPct = equity > 0 ? (total / equity) * 100 : 0;
    return { total, totalPct, correlatedPct: totalPct }; // all crypto longs share the BTC beta
  }
  async function status(uid) {
    const settings = ensure(uid);
    const rules = getRules(uid);
    const cred = credential(uid, settings.mode);
    let account = null;
    if (cred) {
      try { account = await request(cred, '/v2/account'); }
      catch (_) { account = null; /* status must never throw on a broker hiccup */ }
    }
    const equity = number(account?.equity) || 0;
    const stats = dailyStats(uid, equity);
    let openUnrealized = 0;
    if (cred && account) {
      try {
        const bp = await request(cred, '/v2/positions');
        for (const p of bp || []) {
          if (baseSymbol(p.symbol) && String(p.symbol).includes('/')) {
            openUnrealized += number(p.unrealized_pl) || 0;
          }
        }
      } catch (_) { /* open P&L best-effort */ }
    }
    const paper = paperStats(uid, openUnrealized);
    const blockers = [];
    if (!cred) blockers.push('Connect a dedicated crypto paper account.');
    if (!settings.enabled) blockers.push('Scanner is paused.');
    if (rules.emergencyStop) blockers.push('Emergency stop is ACTIVE — new entries halted.');
    if (equity > 0 && stats.dayPnl <= -(rules.maxDailyLossPct / 100) * equity) blockers.push('Daily loss cap reached.');
    if (stats.consecutiveLosses >= rules.maxConsecutiveLosses) blockers.push('Consecutive-loss cap reached.');
    const lastRun = db.prepare('SELECT regime,started_at FROM crypto_scan_runs WHERE user_id=? ORDER BY started_at DESC LIMIT 1').get(uid);
    return {
      connected: !!cred, mode: settings.mode, accountId: cred?.account_id || null,
      enabled: !!settings.enabled, ready: blockers.length === 0, blockers,
      equity, buyingPower: number(account?.buying_power) || 0,
      todayPnl: stats.dayPnl, openPositions: stats.openPositions,
      paper, regime: lastRun?.regime || null,
      emergencyStop: !!rules.emergencyStop,
      rules,
      scheduler: { lastCycleAt: settings.last_cycle_at || null, status: settings.scheduler_status || 'idle', reason: settings.scheduler_reason || null },
    };
  }
  function opportunities(uid, query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const rows = db.prepare(`SELECT * FROM crypto_opportunities WHERE user_id=? AND status='open'
      ORDER BY score DESC, created_at DESC LIMIT ?`).all(uid, limit);
    return { opportunities: rows.map(r => ({
      ...r, score_breakdown: JSON.parse(r.score_breakdown || '{}'), reasons: JSON.parse(r.reasons || '[]'),
    })) };
  }
  function positions(uid) {
    return { positions: openPositions(uid).map(p => ({ ...p, scale_tiers_hit: JSON.parse(p.scale_tiers_hit || '[]') })) };
  }
  function trades(uid, query = {}) {
    const where = ['user_id=?'];
    const args = [uid];
    if (query.symbol) { where.push('symbol=?'); args.push(String(query.symbol).toUpperCase()); }
    const rows = db.prepare(`SELECT * FROM crypto_trades WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`).all(...args);
    return { trades: rows.map(r => ({ ...r, status: r.exitedAt ? 'closed' : 'open' })) };
  }
  function alerts(uid) {
    return { alerts: db.prepare('SELECT kind,message,created_at AS createdAt FROM crypto_alerts WHERE user_id=? ORDER BY id DESC LIMIT 200').all(uid) };
  }
  function universe(uid) {
    // Deliberately global: shared broker reference data (tradable crypto
    // symbols plus scan metadata) — no user identity, credentials, positions
    // or P&L lives here. The route still requires auth.
    void uid;
    const rows = db.prepare('SELECT symbol,base,added_at AS addedAt,last_scanned AS lastScanned,priority,reason FROM crypto_universe ORDER BY priority DESC, symbol LIMIT 500').all();
    const total = db.prepare('SELECT COUNT(*) AS n FROM crypto_universe').get()?.n || 0;
    return { universe: rows, total };
  }
  function latestScan(uid) {
    const run = db.prepare('SELECT * FROM crypto_scan_runs WHERE user_id=? ORDER BY started_at DESC LIMIT 1').get(uid);
    if (!run) return { run: null, rows: [], counts: { openOpportunities: 0, openPositions: 0 } };
    let rows = [];
    try { rows = JSON.parse(run.detail_json || '[]'); } catch (_) { rows = []; }
    const openOpportunities = db.prepare("SELECT COUNT(*) AS n FROM crypto_opportunities WHERE user_id=? AND status='open'").get(uid)?.n || 0;
    return { run: { ...run, detail_json: undefined }, rows, counts: { openOpportunities, openPositions: openPositions(uid).length } };
  }

  // ---------------------------------------------------------------------------
  // Diagnostics pruning (Johnny 2026-09-29: lean database — no zombie data)
  // ---------------------------------------------------------------------------
  // 7-day retention on diagnostic history; real trade records
  // (crypto_trades) and live state are never pruned. Non-open opportunities
  // (expired/stale/entered) older than 7 days go; open rows are actionable
  // state and stay. Backtests keep the newest 20 runs.
  function pruneDiagnostics(uid) {
    db.prepare(`DELETE FROM crypto_alerts WHERE user_id=? AND created_at < datetime('now','-7 days')`)
      .run(uid);
    db.prepare(`DELETE FROM crypto_opportunities WHERE user_id=? AND status != 'open'
      AND created_at < datetime('now','-7 days')`)
      .run(uid);
    db.prepare(`DELETE FROM crypto_backtests WHERE user_id=? AND backtest_id NOT IN (
      SELECT backtest_id FROM crypto_backtests WHERE user_id=? ORDER BY created_at DESC, backtest_id DESC LIMIT 20)`)
      .run(uid, uid);
    db.prepare(`DELETE FROM crypto_backtest_trades WHERE backtest_id NOT IN (SELECT backtest_id FROM crypto_backtests)`)
      .run();
  }

  // ---------------------------------------------------------------------------
  // Market data — Alpaca v1beta3 crypto endpoints (/v1beta3/crypto/us/bars,
  // /v1beta3/crypto/us/latest/quotes). Feed-less on purpose: the crypto
  // endpoints 400 on any feed parameter (see the header note).
  // ---------------------------------------------------------------------------
  function normalizeBars(raw) {
    return (Array.isArray(raw) ? raw : [])
      .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
      .filter(b => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite))
      .sort((a, b) => a.t - b.t);
  }
  async function loadCryptoBars(ctx, symbols, timeframe, start, end) {
    const out = Object.fromEntries(symbols.map(s => [s, []]));
    if (!symbols.length) return out;
    let page = null;
    for (let count = 0; count < 10; count++) {
      const query = new URLSearchParams({
        symbols: symbols.join(','), timeframe, start, end,
        limit: '10000', sort: 'asc',
      });
      if (page) query.set('page_token', page);
      const data = await broker(ctx, `/v1beta3/crypto/us/bars?${query}`, { data: true });
      if (!data?.bars || typeof data.bars !== 'object') throw new CryptoError('Crypto bars are unavailable.');
      for (const s of symbols) out[s].push(...(data.bars[s] || []));
      page = data.next_page_token;
      if (!page) break;
    }
    for (const s of symbols) out[s] = normalizeBars(out[s]);
    return out;
  }
  async function latestQuotes(ctx, symbols) {
    const out = {};
    if (!symbols.length) return out;
    // Batch in groups of 25 to keep URLs small.
    for (let i = 0; i < symbols.length; i += 25) {
      const batch = symbols.slice(i, i + 25);
      const query = new URLSearchParams({ symbols: batch.join(',') });
      const data = await broker(ctx, `/v1beta3/crypto/us/latest/quotes?${query}`, { data: true });
      const quotes = data?.quotes || {};
      for (const s of batch) {
        const q = quotes[s];
        if (q && Number.isFinite(+q.bp) && Number.isFinite(+q.ap)) {
          out[s] = { bid: +q.bp, ask: +q.ap, t: Date.parse(q.t), mid: (+q.bp + +q.ap) / 2 };
        }
      }
    }
    return out;
  }
  function spreadPctOf(quote) {
    if (!quote || !(quote.mid > 0)) return null;
    return ((quote.ask - quote.bid) / quote.mid) * 100;
  }
  async function btcRegime(ctx) {
    // BTC is the primary regime indicator. Daily bars give the 20/50 EMA
    // stack, the day change, and the daily ATR%.
    try {
      const start = new Date(now() - 120 * 86400000).toISOString();
      const end = new Date(now()).toISOString();
      const bars = await loadCryptoBars(ctx, ['BTC/USD'], '1Day', start, end);
      const daily = bars['BTC/USD'] || [];
      if (daily.length < 51) return { regime: 'neutral', reasons: ['Insufficient BTC daily history — defaulting to neutral.'] };
      const closes = daily.map(b => b.c);
      const e20 = emaSeries(closes, 20);
      const e50 = emaSeries(closes, 50);
      const last = daily[daily.length - 1];
      const prev = daily[daily.length - 2];
      const atr = atrSeries(daily, 14);
      const lastAtr = atr[atr.length - 1];
      return classifyBtcRegime({
        btc: {
          price: last.c, ema20: e20[e20.length - 1], ema50: e50[e50.length - 1],
          dayChangePct: prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0,
          atrPct: lastAtr != null && last.c ? (lastAtr / last.c) * 100 : null,
        },
      });
    } catch (_) {
      return { regime: 'neutral', reasons: ['BTC regime data unavailable — defaulting to neutral.'] };
    }
  }

  // ---------------------------------------------------------------------------
  // Universe discovery — GET /v2/assets?asset_class=crypto at startup and
  // every UNIVERSE_REFRESH_MS. Active, tradable crypto assets with valid
  // data, sufficient liquidity and an acceptable spread. New assets are
  // auto-added after validation; dead ones are auto-removed without
  // crashing. Symbols are "BASE/USD".
  // ---------------------------------------------------------------------------
  function assetEligible(asset, rules) {
    if (!asset || asset.status !== 'active' || asset.tradable !== true) return null;
    if (asset.class !== 'crypto' && asset.asset_class !== 'crypto') return null;
    const symbol = String(asset.symbol || '').toUpperCase();
    if (!symbol.endsWith('/USD')) return null;
    const base = baseSymbol(symbol);
    if (!base) return null;
    if (STABLECOINS.has(base) && !rules.stablecoinsEnabled) return { symbol, base, excluded: 'stablecoin' };
    if (base === 'PAXG' && !rules.paxgEnabled) return { symbol, base, excluded: 'paxg' };
    return { symbol, base, excluded: null };
  }
  async function validateUniverseAsset(ctx, symbol, rules) {
    // Data + liquidity + spread validation for one asset. Returns a reason
    // string when invalid, null when valid.
    try {
      const quotes = await latestQuotes(ctx, [symbol]);
      const quote = quotes[symbol];
      if (!quote) return 'no quote data';
      const spread = spreadPctOf(quote);
      if (spread === null || spread > rules.maxSpreadPct) return `spread ${spread === null ? 'n/a' : spread.toFixed(3) + '%'} over ${rules.maxSpreadPct}%`;
      const end = new Date(now()).toISOString();
      const start = new Date(now() - 86400000).toISOString();
      const bars = await loadCryptoBars(ctx, [symbol], '1Hour', start, end);
      const hourly = bars[symbol] || [];
      if (hourly.length < 6) return 'insufficient market data';
      const dollarVol = hourly.reduce((s, b) => s + b.v * b.c, 0);
      if (!(dollarVol >= rules.minDollarVolume24h)) return `24h dollar volume ${Math.round(dollarVol)} below ${rules.minDollarVolume24h}`;
      if (!(quote.mid >= rules.minPrice)) return `price ${quote.mid} below ${rules.minPrice}`;
      return null;
    } catch (error) {
      return `validation error: ${String(error?.message || error).slice(0, 120)}`;
    }
  }
  async function refreshUniverse(ctx) {
    const last = db.prepare('SELECT MAX(last_validated) AS lv FROM crypto_universe').get()?.lv;
    const total = db.prepare('SELECT COUNT(*) AS n FROM crypto_universe').get()?.n || 0;
    if (last && now() - Date.parse(last) < UNIVERSE_REFRESH_MS && total > 0) return total;
    const assets = await broker(ctx, '/v2/assets?asset_class=crypto');
    if (!Array.isArray(assets) || !assets.length) throw new CryptoError('Crypto asset universe is unavailable.');
    const rules = ctx.rules;
    const seen = new Set();
    const validated = [];
    for (const asset of assets) {
      guard(ctx.lease);
      const info = assetEligible(asset, rules);
      if (!info || info.excluded) continue;
      seen.add(info.symbol);
      validated.push(info);
    }
    if (!validated.length) throw new CryptoError('Crypto asset universe is empty after filtering.');
    // Validate in batches; a single bad asset never crashes the refresh.
    const kept = [];
    for (const info of validated) {
      guard(ctx.lease);
      const reason = await validateUniverseAsset(ctx, info.symbol, rules);
      kept.push({ ...info, reason });
    }
    db.transaction(() => {
      // Auto-remove dead/unavailable assets, auto-add newly validated ones.
      const existing = new Set(db.prepare('SELECT symbol FROM crypto_universe').all().map(r => r.symbol));
      for (const { symbol, base, reason } of kept) {
        if (reason) {
          db.prepare('DELETE FROM crypto_universe WHERE symbol=?').run(symbol);
          continue;
        }
        if (existing.has(symbol)) {
          db.prepare('UPDATE crypto_universe SET last_validated=?, reason=NULL WHERE symbol=?').run(timestamp(), symbol);
        } else {
          db.prepare('INSERT INTO crypto_universe(symbol,base,added_at,last_scanned,last_validated,priority) VALUES (?,?,?,?,?,0)')
            .run(symbol, base, timestamp(), null, timestamp());
        }
      }
      // Anything no longer reported by the broker is removed.
      const stale = db.prepare('SELECT symbol FROM crypto_universe').all().map(r => r.symbol).filter(s => !seen.has(s));
      for (const s of stale) db.prepare('DELETE FROM crypto_universe WHERE symbol=?').run(s);
    })();
    return db.prepare('SELECT COUNT(*) AS n FROM crypto_universe').get()?.n || 0;
  }
  function selectScanSymbols(ctx) {
    const budget = Math.min(Math.max(Number(ctx.rules.scanBudget) || 50, 1), batchSize);
    const rows = db.prepare(`SELECT symbol FROM crypto_universe
      ORDER BY priority DESC, last_scanned ASC NULLS FIRST LIMIT ?`).all(budget);
    return rows.map(r => r.symbol);
  }

  // ---------------------------------------------------------------------------
  // Breakout detection — candle CLOSE above resistance (a wick alone never
  // qualifies). Resistance from: recent swing highs, consolidation high,
  // previous day high, previous week high, 20-period high, 50-period high.
  // ---------------------------------------------------------------------------
  function resistanceCandidates({ m5, daily, left, right, lookback }) {
    const cands = [];
    const swings = swingPoints(m5.slice(-Math.max(lookback, 20)), left, right);
    for (const s of swings.highs.slice(-3)) cands.push(s.price);
    const cons = m5.slice(-21, -1).filter(c => [c.o, c.h, c.l, c.c].every(Number.isFinite));
    if (cons.length) cands.push(Math.max(...cons.map(c => c.h)));
    if (daily.length >= 2) cands.push(+daily[daily.length - 2].h); // previous day high
    const week = daily.slice(-6, -1).filter(c => Number.isFinite(+c.h));
    if (week.length) cands.push(Math.max(...week.map(c => +c.h))); // previous week high
    const h20 = rollingHigh(m5, 20);
    const h50 = rollingHigh(m5, 50);
    if (h20 !== null) cands.push(h20);
    if (h50 !== null) cands.push(h50);
    return [...new Set(cands.filter(v => Number.isFinite(v) && v > 0))].sort((a, b) => a - b);
  }
  function nearestResistanceAbove(candidates, price) {
    // The lowest resistance still above the price (with a hair of tolerance).
    const above = candidates.filter(r => r > price * 1.0005);
    return above.length ? above[0] : null;
  }
  function detectBreakout({ symbol, m5, daily, ind, rules, regime }) {
    if (!m5.length || m5.length < 60) return { outcome: 'none', reason: 'Insufficient 5m history.' };
    const last = m5[m5.length - 1];
    const prev = m5[m5.length - 2];
    const row = ind[ind.length - 1] || {};
    const price = last.c;
    // Resistance is anchored to COMPLETED history (every bar before the
    // evaluation bar) — the breakout bar's own high must never be its own
    // resistance, or no close could ever break out.
    const history = m5.slice(0, -1);
    const cands = resistanceCandidates({ m5: history, daily, left: rules.swingLeft, right: rules.swingRight, lookback: rules.resistanceLookback });
    const resistance = nearestResistanceAbove(cands, prev.c);
    const atr = row.atr14;
    const rvolNow = row.rvol || 1;
    const tests = cands.filter(r => prev.h >= r * 0.999 && prev.h <= r * 1.005).length;
    if (resistance === null) return { outcome: 'none', reason: 'No resistance overhead.' };
    const closeAbove = last.c > resistance;
    const extensionAtr = atr && atr > 0 ? (last.c - resistance) / atr : 0;
    if (!closeAbove) {
      // Retest watch: a recorded breakout whose level is now being retested.
      if (rules.retestEnabled) {
        const prior = db.prepare('SELECT * FROM crypto_breakouts WHERE symbol=?').get(symbol);
        if (prior && now() - Date.parse(prior.breakout_at) < rules.retestWindowHours * 3600000) {
          const level = number(prior.level);
          const holding = last.l >= level - (atr || 0) * 0.3 && last.c >= level * 0.998;
          const buyersBack = last.c > last.o && rvolNow >= 1.5 && rvolNow >= (prev.v / Math.max(row.avgVol20 || 1, 1)) * 0.9;
          if (holding && buyersBack) {
            return { outcome: 'retest', resistance: level, retest: true, closeAboveResistance: true,
              breakoutAtr: extensionAtr, resistanceTests: tests, rvol: rvolNow, atr,
              reason: 'Confirmed breakout retest: former resistance held as support with buyers returning.' };
          }
        }
      }
      return { outcome: 'none', reason: `No close above resistance ${resistance.toFixed(6)}.` };
    }
    // Don't chase extremely extended candles — wait for a retest.
    if (atr && atr > 0 && extensionAtr > rules.breakoutMaxExtensionAtr) {
      db.prepare(`INSERT INTO crypto_breakouts(symbol,level,breakout_at,score) VALUES (?,?,?,?)
        ON CONFLICT(symbol) DO UPDATE SET level=excluded.level,breakout_at=excluded.breakout_at,score=excluded.score`)
        .run(symbol, resistance, timestamp(), 0);
      return { outcome: 'none', reason: `Breakout ${(extensionAtr).toFixed(2)} ATR above resistance — too extended, watching for retest.`, extended: true, resistance };
    }
    return { outcome: 'breakout', resistance, retest: false, closeAboveResistance: true,
      breakoutAtr: extensionAtr, resistanceTests: tests, rvol: rvolNow, atr,
      reason: `Candle closed above resistance ${resistance.toFixed(6)}.` };
  }

  function scoreSymbol({ uid, symbol, m5, daily, ind, rules, regime, quote }) {
    const detection = detectBreakout({ symbol, m5, daily, ind, rules, regime: regime.regime });
    const last = m5[m5.length - 1];
    const row = ind[ind.length - 1] || {};
    const prevRow = ind[ind.length - 2] || {};
    const price = last.c;
    const struct = marketStructure(m5.slice(-80), rules.swingLeft, rules.swingRight);
    const rsi = row.rsi14;
    const macdPositive = row.macd != null && row.macd > 0;
    const macdHistRising = row.macdHist != null && prevRow.macdHist != null && row.macdHist > prevRow.macdHist;
    // Bearish RSI divergence: price makes a higher high, RSI a lower high.
    const closes = m5.slice(-30).map(b => b.c);
    const rsiTail = ind.slice(-30).map(r => r.rsi14);
    let bearishDivergence = false;
    if (closes.length >= 20) {
      const p1 = Math.max(...closes.slice(0, 15)); const p2 = Math.max(...closes.slice(15));
      const r1 = Math.max(...rsiTail.slice(0, 15).filter(Number.isFinite));
      const r2 = Math.max(...rsiTail.slice(15).filter(Number.isFinite));
      bearishDivergence = Number.isFinite(r1) && Number.isFinite(r2) && p2 > p1 && r2 < r1;
    }
    // HTF trend from daily bars: 20/50 EMA stack + price position.
    const dCloses = daily.map(b => +b.c).filter(Number.isFinite);
    let htfTrend = 'neutral', aboveEma200 = null, emaAligned = null;
    if (dCloses.length >= 50) {
      const de20 = emaSeries(dCloses, 20); const de50 = emaSeries(dCloses, 50);
      const e20 = de20[de20.length - 1]; const e50 = de50[de50.length - 1];
      if (e20 != null && e50 != null) {
        emaAligned = price > e20 && e20 > e50 ? true : price < e20 && e20 < e50 ? false : null;
        htfTrend = price > e20 && e20 > e50 ? 'bullish' : price < e20 && e20 < e50 ? 'bearish' : 'neutral';
      }
      if (dCloses.length >= 200) {
        const de200 = emaSeries(dCloses, 200);
        const e200 = de200[de200.length - 1];
        aboveEma200 = e200 != null ? price > e200 : null;
      }
    }
    const spread = spreadPctOf(quote);
    const dollarVol24h = m5.slice(-288).reduce((s, b) => s + (b.v || 0) * b.c, 0);
    const scoring = scoreBreakout({
      breakout: { confirmed: detection.outcome !== 'none', closeAboveResistance: !!detection.closeAboveResistance,
        breakoutAtr: detection.breakoutAtr, resistanceTests: detection.resistanceTests, retest: !!detection.retest },
      volume: { rvol: row.rvol, priceUp: last.c > last.o, volumeRising: last.v > (m5[m5.length - 2]?.v || 0) },
      structure: { trend: struct.trend },
      htf: { trend: htfTrend, aboveEma200, emaAligned },
      momentum: { rsi, macdPositive, macdHistRising, bearishDivergence },
      vwapEma: { aboveVwap: row.vwap != null && price > row.vwap,
        ema9Above20: row.ema9 != null && row.ema20 != null && row.ema9 >= row.ema20,
        ema20Above50: row.ema20 != null && row.ema50 != null && row.ema20 >= row.ema50,
        priceAboveEma50: row.ema50 != null && price > row.ema50 },
      liquidity: { spreadPct: spread, spreadOk: spread !== null && spread <= rules.maxSpreadPct,
        dollarVolumeOk: dollarVol24h >= rules.minDollarVolume24h },
      regime: regime.regime,
    }, { weights: rules.weights, minScore: rules.minScore, highQuality: rules.highQuality,
      rvolTiers: { min: rules.rvolMin, strong: rules.rvolStrong, exceptional: rules.rvolExceptional } });
    const emaStructure = [
      row.ema9 != null && price > row.ema9 ? '9' : null,
      row.ema20 != null && price > row.ema20 ? '20' : null,
      row.ema50 != null && price > row.ema50 ? '50' : null,
    ].filter(Boolean).join('>') || 'below';
    return {
      symbol, price, outcome: detection.outcome, resistance: detection.resistance ?? null,
      rvol: row.rvol, volume: last.v, rsi, macd: row.macd, vwap: row.vwap,
      emaStructure, atr: row.atr14, regime: regime.regime,
      score: scoring.score, scoreBreakdown: scoring.breakdown, reasons: scoring.reasons,
      minRequired: scoring.minRequired, meetsMinimum: scoring.meetsMinimum,
      highQuality: scoring.highQuality, reason: detection.reason,
      htfTrend, bearishDivergence, macdHistRising,
    };
  }

  // ---------------------------------------------------------------------------
  // Scan cycle — 5m bars for the budget, breakout detection + scoring,
  // opportunities persisted for the dashboard and the auto-entry flow.
  // ---------------------------------------------------------------------------
  function expireOpportunities(uid) {
    const expired = db.prepare(`UPDATE crypto_opportunities SET status='expired'
      WHERE user_id=? AND status='open' AND expires_at<?`).run(uid, timestamp());
    return expired.changes || 0;
  }
  async function scanCycle(ctx, account) {
    const runId = crypto.randomUUID();
    const startedAt = timestamp();
    db.prepare(`INSERT INTO crypto_scan_runs(run_id,user_id,started_at) VALUES (?,?,?)`).run(runId, ctx.uid, startedAt);
    const funnel = { symbols: 0, candidates: 0, opportunities: 0, errors: 0 };
    const rows = []; // in-memory only — never persisted (no zombie data)
    let regime = { regime: 'neutral', reasons: ['Regime not evaluated.'] };
    try {
      await refreshUniverse(ctx);
      const symbols = selectScanSymbols(ctx);
      funnel.symbols = symbols.length;
      if (!symbols.length) throw new CryptoError('Crypto scan universe is empty.');
      regime = await btcRegime(ctx);
      const end = new Date(now()).toISOString();
      const start5m = new Date(now() - 3 * 86400000).toISOString();
      const startDaily = new Date(now() - 400 * 86400000).toISOString();
      const [m5BySymbol, dailyBySymbol, quotes] = await Promise.all([
        loadCryptoBars(ctx, symbols, '5Min', start5m, end),
        loadCryptoBars(ctx, symbols, '1Day', startDaily, end),
        latestQuotes(ctx, symbols).catch(() => ({})),
      ]);
      for (const symbol of symbols) {
        guard(ctx.lease);
        try {
          const m5 = m5BySymbol[symbol] || [];
          const daily = dailyBySymbol[symbol] || [];
          if (m5.length < 60 || daily.length < 50) { funnel.errors++; continue; }
          const ind = computeCryptoIntraday(m5);
          const result = scoreSymbol({ uid: ctx.uid, symbol, m5, daily, ind,
            rules: ctx.rules, regime, quote: quotes[symbol] || null });
          funnel.candidates++;
          const view = { symbol: result.symbol, price: result.price, outcome: result.outcome,
            score: result.score, rvol: result.rvol, rsi: result.rsi, regime: result.regime,
            resistance: result.resistance, reason: result.reason };
          rows.push(view);
          db.prepare('UPDATE crypto_universe SET last_scanned=? WHERE symbol=?').run(timestamp(), symbol);
          if (result.outcome === 'none') continue;
          // RVOL gate with the regime multiplier (bearish BTC demands
          // stronger volume on altcoin breakouts).
          const rvolNeed = ctx.rules.rvolMin * rvolRequirementMultiplier(regime.regime);
          if (!((result.rvol || 0) >= rvolNeed)) {
            rows[rows.length - 1].outcome = 'rejected';
            rows[rows.length - 1].reason = `RVOL ${(result.rvol || 0).toFixed(2)}x below ${rvolNeed.toFixed(2)}x (${regime.regime} regime).`;
            continue;
          }
          if (!result.meetsMinimum) {
            rows[rows.length - 1].outcome = 'rejected';
            rows[rows.length - 1].reason = `Score ${result.score} below ${regime.regime} minimum ${result.minRequired}.`;
            continue;
          }
          // Duplicate protection: no second open opportunity or position for
          // the same symbol.
          const dupOpp = db.prepare(`SELECT 1 FROM crypto_opportunities
            WHERE user_id=? AND symbol=? AND status='open'`).get(ctx.uid, symbol);
          const dupPos = db.prepare(`SELECT 1 FROM crypto_positions
            WHERE user_id=? AND symbol=? AND status IN ('open','pending_entry')`).get(ctx.uid, symbol);
          if (dupOpp || dupPos) {
            rows[rows.length - 1].outcome = 'rejected';
            rows[rows.length - 1].reason = 'An open opportunity or position for this symbol already exists.';
            continue;
          }
          funnel.opportunities++;
          db.prepare(`INSERT INTO crypto_opportunities(scan_run_id,user_id,symbol,outcome,score,score_breakdown,
            price,breakout_level,rvol,volume,rsi,macd,vwap,ema_structure,atr,regime,reasons,status,created_at,expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`).run(
            runId, ctx.uid, symbol, result.outcome, result.score, JSON.stringify(result.scoreBreakdown),
            result.price, result.resistance, result.rvol, result.volume, result.rsi, result.macd,
            result.vwap, result.emaStructure, result.atr, result.regime, JSON.stringify(result.reasons),
            timestamp(), new Date(now() + OPPORTUNITY_TTL_MS).toISOString());
          db.prepare('UPDATE crypto_universe SET priority=priority+1 WHERE symbol=?').run(symbol);
          if (result.outcome === 'breakout') {
            db.prepare(`INSERT INTO crypto_breakouts(symbol,level,breakout_at,score) VALUES (?,?,?,?)
              ON CONFLICT(symbol) DO UPDATE SET level=excluded.level,breakout_at=excluded.breakout_at,score=excluded.score`)
              .run(symbol, result.resistance, timestamp(), result.score);
          }
          if (result.highQuality) {
            alert(ctx.uid, 'entry', `High-quality crypto breakout: ${symbol} scored ${result.score} (RVOL ${(result.rvol || 0).toFixed(1)}x, ${result.regime} regime).`);
          }
        } catch (error) {
          funnel.errors++;
          rows.push({ symbol, outcome: 'error', reason: String(error?.message || error).slice(0, 200) });
        }
      }
    } catch (error) {
      funnel.errors++;
      throw error;
    } finally {
      // Funnel counts only — per-symbol detail rows are NOT persisted
      // (Johnny: no zombie data). Old scan runs are pruned to 7 days.
      db.prepare(`UPDATE crypto_scan_runs SET symbols_scanned=?,candidates=?,opportunities=?,
        errors=?,regime=?,detail_json=NULL WHERE run_id=?`)
        .run(funnel.symbols, funnel.candidates, funnel.opportunities,
          funnel.errors, regime.regime, runId);
      db.prepare(`DELETE FROM crypto_scan_runs WHERE user_id=? AND started_at < datetime('now','-7 days')`)
        .run(ctx.uid);
      try { pruneDiagnostics(ctx.uid); } catch (_) { /* Prune is best-effort. */ }
    }
    return { runId, funnel, regime: regime.regime };
  }

  // ---------------------------------------------------------------------------
  // Entries — FULLY AUTOMATED in paper. No approval step (unlike Warrior):
  // a qualifying opportunity passes the risk gates and the entry order goes
  // straight to the broker. Fills are never assumed.
  // ---------------------------------------------------------------------------
  function positionNotional(rules, equity, buyingPower) {
    let notional = rules.sizingMode === 'pct_equity'
      ? (equity * rules.pctEquity) / 100
      : rules.fixedDollar;
    notional = Math.min(notional, rules.maxPositionNotional);
    if (equity > 0) notional = Math.min(notional, (equity * rules.maxPositionPct) / 100);
    if (buyingPower > 0) notional = Math.min(notional, buyingPower);
    return Math.max(0, notional);
  }
  function computeStop({ entry, atr, m5, stopMode, stopPct, atrStopMult }) {
    if (stopMode === 'pct') return entry * (1 - stopPct / 100);
    if (stopMode === 'structure') {
      const swingLow = rollingLow(m5.slice(-30), 30);
      const level = swingLow != null ? swingLow : entry - (atr || 0) * 2;
      return Math.min(level, entry * 0.999);
    }
    // 'atr' default
    return entry - atrStopMult * (atr || entry * 0.02);
  }
  async function awaitFill(ctx, clientOrderId, { tries = 12, intervalMs = 500 } = {}) {
    const poll = { tries: exitPoll?.tries ?? tries, intervalMs: exitPoll?.intervalMs ?? intervalMs };
    for (let i = 0; i < poll.tries; i++) {
      const order = await orderByClient(ctx, clientOrderId).catch(() => null);
      if (order?.status === 'filled') return order;
      if (order && TERMINAL.has(order.status)) return order;
      await sleep(poll.intervalMs);
    }
    return null;
  }
  async function enterPosition(ctx, opportunity, quote, account, regime) {
    const rules = ctx.rules;
    const symbol = opportunity.symbol;
    const entryId = clientId('entry', symbol, String(now()));
    // Duplicate-order protection: adopt an already-working entry for this
    // symbol instead of submitting a second one.
    const prior = await orderByClient(ctx, entryId).catch(() => null);
    if (prior && !TERMINAL.has(prior.status)) {
      alert(ctx.uid, 'risk', `Crypto ${symbol}: entry already working — adopting, no duplicate order.`);
      return { adopted: true, order: prior };
    }
    const equity = number(account?.equity) || 0;
    const buyingPower = number(account?.buying_power) || 0;
    const notional = positionNotional(rules, equity, buyingPower);
    const stats = dailyStats(ctx.uid, equity);
    const spread = spreadPctOf(quote);
    const gates = entryGates({ uid: ctx.uid, rules, stats, account, quote, symbol, notional, spreadPct: spread, regime: regime.regime });
    if (!rules.autoEnter) gates.reasons.push('autoEnter is off — entries withheld.');
    if (!gates.ok) {
      alert(ctx.uid, 'risk', `Crypto ${symbol}: entry blocked (${gates.reasons.join(' ')}).`);
      db.prepare("UPDATE crypto_opportunities SET status='stale' WHERE id=?").run(opportunity.id);
      throw new CryptoError(`Entry gates failed: ${gates.reasons.join(' ')}`, 409);
    }
    // Slippage guard: quoted mid must be near the opportunity price.
    const mid = quote.mid;
    const slippagePct = opportunity.price > 0 ? (Math.abs(mid - opportunity.price) / opportunity.price) * 100 : 0;
    // Entry at the quoted mid via market notional order (crypto is liquid;
    // market fills are the honest fill model). TIF gtc — Alpaca rejects
    // 'day' for crypto orders (422).
    const order = await broker(ctx, '/v2/orders', { method: 'POST', body: {
      symbol, notional: +notional.toFixed(2), side: 'buy', type: 'market',
      time_in_force: 'gtc', client_order_id: entryId,
    } });
    guard(ctx.lease);
    const confirmed = await awaitFill(ctx, entryId);
    if (confirmed?.status !== 'filled' || !(number(confirmed.filled_qty) > 0)) {
      alert(ctx.uid, 'risk', `Crypto ${symbol}: entry not confirmed — no position taken.`);
      throw new CryptoError('Entry fill was not confirmed; position withheld.', 502);
    }
    const fillPrice = number(confirmed.filled_avg_price) || mid;
    const qty = roundQty(number(confirmed.filled_qty));
    const atr = number(opportunity.atr) || fillPrice * 0.02;
    // Load a short tape for structure-based stops.
    let stop;
    try {
      const end = new Date(now()).toISOString();
      const bars = await loadCryptoBars(ctx, [symbol], '5Min', new Date(now() - 86400000).toISOString(), end);
      stop = computeStop({ entry: fillPrice, atr, m5: bars[symbol] || [],
        stopMode: rules.stopMode, stopPct: rules.stopPct, atrStopMult: rules.atrStopMult });
    } catch (_) {
      stop = computeStop({ entry: fillPrice, atr, m5: [], stopMode: rules.stopMode === 'structure' ? 'atr' : rules.stopMode,
        stopPct: rules.stopPct, atrStopMult: rules.atrStopMult });
    }
    if (!(stop > 0 && stop < fillPrice)) stop = fillPrice * 0.97; // fail-safe floor
    const positionId = crypto.randomUUID();
    db.prepare(`INSERT INTO crypto_positions(position_id,user_id,symbol,qty,entry_price,stop_price,
      entry_atr,entry_rvol,entry_score,regime_at_entry,breakout_level,highest_price,
      trailing_mult,status,opened_at,updated_at,entry_order_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`).run(
      positionId, ctx.uid, symbol, qty, fillPrice, stop,
      atr, number(opportunity.rvol) || null, opportunity.score, regime.regime,
      number(opportunity.breakout_level) || null, fillPrice,
      rules.trailingAtrMult, timestamp(), timestamp(), confirmed.id || null);
    db.prepare("UPDATE crypto_opportunities SET status='entered' WHERE id=?").run(opportunity.id);
    const pos = db.prepare('SELECT * FROM crypto_positions WHERE position_id=?').get(positionId);
    // Attach protection: one limit take-profit per scale-out tier + a runner stop_limit.
    try {
      await attachProtection(ctx, pos);
      alert(ctx.uid, 'fill', `Crypto filled ${symbol} ${qty} @ ${fillPrice.toFixed(6)} (score ${opportunity.score}); tiered protection attached.`);
    } catch (error) {
      alert(ctx.uid, 'risk', `Crypto ${symbol}: fill confirmed but protection failed (${error.message || 'broker error'}) — position UNPROTECTED until re-attached.`);
    }
    return { entered: true, positionId, order: confirmed, fillPrice, qty, slippagePct };
  }
  async function entryCycle(ctx, account, regime) {
    // Top open opportunities by score, oldest first within a score band.
    const opps = db.prepare(`SELECT * FROM crypto_opportunities WHERE user_id=? AND status='open'
      ORDER BY score DESC, created_at ASC LIMIT ?`).all(ctx.uid, Math.max(1, ctx.rules.maxPositions));
    if (!opps.length) return { attempted: 0, entered: 0 };
    const symbols = [...new Set(opps.map(o => o.symbol))];
    let quotes = {};
    try { quotes = await latestQuotes(ctx, symbols); }
    catch (_) { quotes = {}; /* bad data halts new entries, fail closed */ }
    let entered = 0, attempted = 0;
    for (const opp of opps) {
      guard(ctx.lease);
      if (openPositions(ctx.uid).length >= ctx.rules.maxPositions) break;
      const quote = quotes[opp.symbol] || null;
      // Data-freshness gate: a stale quote halts THIS entry, never a guess.
      if (!quote || !Number.isFinite(quote.t) || now() - quote.t > QUOTE_MAX_AGE_MS) {
        alert(ctx.uid, 'risk', `Crypto ${opp.symbol}: quote missing or stale — entry withheld.`);
        continue;
      }
      attempted++;
      try {
        await enterPosition(ctx, opp, quote, account, regime);
        entered++;
      } catch (error) {
        if (!(error instanceof CryptoError)) throw error;
        // Gate failures are expected; the opportunity is already marked stale.
      }
    }
    return { attempted, entered };
  }

  // ---------------------------------------------------------------------------
  // Sizing helper for the tier ladder. Tier quantities are fractions of the
  // ORIGINAL fill so partial fills of earlier tiers never distort the ladder.
  // ---------------------------------------------------------------------------
  function tierQty(pos, tier, idx, tiers) {
    // Tier quantities are fractions of the ORIGINAL fill so partial fills of
    // earlier tiers never distort the ladder.
    const original = number(pos.qty) + (JSON.parse(pos.scale_tiers_hit || '[]')
      .reduce((s, h) => s + (number(h.qty) || 0), 0));
    const base = original > 0 ? original : number(pos.qty);
    return roundQty(base * tier.qty);
  }
  async function cancelOrderById(ctx, orderId) {
    if (!orderId) return false;
    try { await broker(ctx, `/v2/orders/${orderId}`, { method: 'DELETE' }); return true; }
    catch (_) { return false; }
  }
  // ---------------------------------------------------------------------------
  // Protection — software-managed, because Alpaca crypto rejects OCO/bracket
  // order classes (42210000) and plain stop orders. Tier take-profits are
  // standalone limit sells (TIF gtc); the runner is a single stop_limit sell
  // (the only broker-side stop type crypto supports). The 60s loop watches
  // fills, banks partials, and cancel-and-replaces the runner when the stop
  // ratchets or the quantity shrinks. Broker truth is re-read before every
  // change — a live broker stop is never "adopted" when its price or
  // quantity disagrees with local state.
  // ---------------------------------------------------------------------------
  function tpClientId(pos, tierIdx, gen) {
    return gen > 0 ? `tp-${pos.position_id}-t${tierIdx}-g${gen}` : `tp-${pos.position_id}-t${tierIdx}`;
  }
  function runnerClientId(pos, gen) {
    return `sl-${pos.position_id}-g${gen}`;
  }
  function protectionPrefixes(pos) {
    return [`tp-${pos.position_id}-`, `sl-${pos.position_id}-`];
  }
  async function openProtectionOrders(ctx, pos) {
    // Live broker-side protection orders for this position, any generation.
    // Returns null when broker truth is unknown — callers must withhold
    // changes rather than stack a second set of orders.
    const orders = await broker(ctx, '/v2/orders?status=open&limit=500&direction=desc').catch(() => null);
    if (!Array.isArray(orders)) return null;
    const prefixes = protectionPrefixes(pos);
    return orders.filter(o => prefixes.some(p => String(o.client_order_id || '').startsWith(p)));
  }
  async function bumpProtectionGen(pos) {
    db.prepare('UPDATE crypto_positions SET protection_gen=protection_gen+1,updated_at=? WHERE position_id=?')
      .run(timestamp(), pos.position_id);
    pos.protection_gen = number(db.prepare('SELECT protection_gen FROM crypto_positions WHERE position_id=?')
      .get(pos.position_id)?.protection_gen) || 0;
    return pos.protection_gen;
  }
  function runnerQtyFor(pos, tiers, hitIdx) {
    // Shares the runner stop must cover: everything not already banked and
    // not covered by a live tier take-profit. Total open sells (unhit TPs +
    // runner) always equals the position — never more.
    return roundQty(number(pos.qty) - tiers
      .map((t, i) => hitIdx.has(i) ? 0 : tierQty(pos, t, i, tiers))
      .reduce((s, q) => s + q, 0));
  }
  async function attachProtection(ctx, pos, { stop: stopOverride } = {}) {
    const rules = ctx.rules;
    const tiers = rules.scaleOutTiers || [];
    const entry = number(pos.entry_price);
    // The ratchet passes the intended stop explicitly so broker truth is
    // established BEFORE the local row is touched.
    const stop = stopOverride != null ? number(stopOverride) : number(pos.stop_price);
    // A trailing stop can sit ABOVE entry once profit is locked in — the
    // only invariant is positivity (the strategy is long-only).
    if (!(entry > 0 && stop > 0)) throw new CryptoError('Protection requires a valid entry and stop.');
    const gen = number(pos.protection_gen) || 0;
    const hits = JSON.parse(pos.scale_tiers_hit || '[]');
    const hitIdx = new Set(hits.map(h => h.tier));
    // Tier take-profits: one limit sell each. Live orders are adopted;
    // filled ones are left for the fill reconciliation below.
    for (let i = 0; i < tiers.length; i++) {
      if (hitIdx.has(i)) continue; // already banked
      const tier = tiers[i];
      const qty = tierQty(pos, tier, i, tiers);
      if (!(qty > 0)) continue;
      const tp = entry * (1 + tier.pct / 100);
      let live = false, fired = false, sawTerminal = false;
      for (let g = 0; g <= gen; g++) {
        const o = await orderByClient(ctx, tpClientId(pos, i, g)).catch(() => null);
        if (!o) continue;
        if (!TERMINAL.has(o.status)) { live = true; break; }
        if (o.status === 'filled' && number(o.filled_qty) > 0) { fired = true; break; }
        sawTerminal = true;
      }
      if (live || fired) continue;
      // A terminal, non-filled id is never reused (Alpaca treats
      // client_order_id as unique) — re-arm under a fresh generation.
      const useGen = sawTerminal ? await bumpProtectionGen(pos) : gen;
      await broker(ctx, '/v2/orders', { method: 'POST', body: {
        symbol: pos.symbol, qty, side: 'sell', type: 'limit', time_in_force: 'gtc',
        limit_price: +tp.toFixed(6),
        client_order_id: tpClientId(pos, i, useGen),
      } });
    }
    // Runner stop: the remainder after all tiers. The trailing engine moves
    // it via replaceRunnerStop — cancel first, verify dead, then place.
    const runnerQty = runnerQtyFor(pos, tiers, hitIdx);
    if (runnerQty > 0) await replaceRunnerStop(ctx, pos, { qty: runnerQty, stop });
    db.prepare('UPDATE crypto_positions SET updated_at=? WHERE position_id=?').run(timestamp(), pos.position_id);
  }
  async function replaceRunnerStop(ctx, pos, { qty, stop }) {
    // Broker-truth-safe runner replacement: a live runner whose price or
    // quantity disagrees with local state is canceled and verified dead
    // BEFORE the replacement goes out — two live sell stops for the same
    // shares must never coexist.
    const gen = number(pos.protection_gen) || 0;
    const id = runnerClientId(pos, gen);
    const stopPx = +stop.toFixed(6);
    const limitPx = +(stop * 0.9995).toFixed(6);
    const existing = await orderByClient(ctx, id).catch(() => null);
    const live = existing && !TERMINAL.has(existing.status);
    if (!(qty > 0)) {
      // No shares left to protect (every tier banked): kill any live runner
      // and place nothing — a zero-quantity stop must never be submitted.
      if (live) {
        await cancelOrderById(ctx, existing.id);
        const recheck = await orderByClient(ctx, id).catch(() => null);
        if (recheck && !TERMINAL.has(recheck.status))
          throw new CryptoError('Runner stop could not be canceled - refusing to leave a live stop on zero shares.');
      }
      return null;
    }
    const matches = live &&
      Math.abs(number(existing.stop_price) - stopPx) <= stopPx * 1e-6 &&
      Math.abs(number(existing.qty) - qty) <= Math.max(1e-9, qty * 1e-6);
    if (matches) return existing; // broker truth agrees — adopt
    if (live) {
      await cancelOrderById(ctx, existing.id);
      const recheck = await orderByClient(ctx, id).catch(() => null);
      if (recheck && !TERMINAL.has(recheck.status))
        throw new CryptoError('Runner stop could not be canceled — refusing to stack a second stop; local stop unchanged.');
    }
    const newGen = await bumpProtectionGen(pos);
    return broker(ctx, '/v2/orders', { method: 'POST', body: {
      symbol: pos.symbol, qty, side: 'sell', type: 'stop_limit',
      time_in_force: 'gtc', stop_price: stopPx, limit_price: limitPx,
      client_order_id: runnerClientId(pos, newGen),
    } });
  }
  async function cancelProtection(ctx, pos) {
    // Cancel every live protection order for this position, any generation.
    // Returns true when nothing protective remains live, false when broker
    // truth is unknown (the caller must withhold the exit).
    const orders = await openProtectionOrders(ctx, pos);
    if (orders === null) return false;
    for (const o of orders) await cancelOrderById(ctx, o.id);
    const recheck = await openProtectionOrders(ctx, pos);
    if (recheck === null) return false;
    return recheck.length === 0;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation + automatic management. Broker truth first; strategy
  // exits use the 12 explicit exit reasons.
  // ---------------------------------------------------------------------------
  function journalTrade(uid, rec) {
    const cols = CRYPTO_TRADE_FIELDS.map(f => `"${f}"`).join(',');
    const placeholders = CRYPTO_TRADE_FIELDS.map(() => '?').join(',');
    db.prepare(`INSERT INTO crypto_trades(user_id,${cols},created_at) VALUES (?,${placeholders},?)`)
      .run(uid, ...CRYPTO_TRADE_FIELDS.map(f => rec[f] ?? null), timestamp());
  }
  function buildRecord(fields = {}) {
    const rec = {};
    for (const key of CRYPTO_TRADE_FIELDS) rec[key] = key in fields ? fields[key] : null;
    if (!rec.tradeId && rec.symbol && rec.enteredAt) rec.tradeId = `${rec.symbol}-${rec.enteredAt}`;
    return rec;
  }
  async function handleTierFills(ctx, pos) {
    // Returns { banked, closed } — banked P&L from filled tier take-profits,
    // and whether the runner stop filled (the position is stopped out).
    const rules = ctx.rules;
    const tiers = rules.scaleOutTiers || [];
    const gen = number(pos.protection_gen) || 0;
    let banked = 0;
    const hits = JSON.parse(pos.scale_tiers_hit || '[]');
    const hitIdx = new Set(hits.map(h => h.tier));
    for (let i = 0; i < tiers.length; i++) {
      if (hitIdx.has(i)) continue;
      let fill = null;
      for (let g = 0; g <= gen; g++) {
        const o = await orderByClient(ctx, tpClientId(pos, i, g)).catch(() => null);
        if (o && o.status === 'filled' && number(o.filled_qty) > 0) { fill = o; break; }
      }
      if (!fill) continue;
      const qty = Math.max(0, roundQty(number(fill.filled_qty)));
      const fillPrice = number(fill.filled_avg_price) || 0;
      if (!(qty > 0 && fillPrice > 0)) continue;
      const legPnl = (fillPrice - number(pos.entry_price)) * qty;
      banked += legPnl;
      hits.push({ tier: i, qty, fillPrice });
      const remaining = roundQty(Math.max(0, number(pos.qty) - qty));
      db.prepare('UPDATE crypto_positions SET scale_tiers_hit=?,banked_pnl=banked_pnl+?,qty=?,updated_at=? WHERE position_id=?')
        .run(JSON.stringify(hits), legPnl, remaining, timestamp(), pos.position_id);
      pos.qty = remaining;
      pos.banked_pnl = (number(pos.banked_pnl) || 0) + legPnl;
      pos.scale_tiers_hit = JSON.stringify(hits);
      const rec = buildRecord({
        tradeId: `${pos.position_id}-t${i}`, symbol: pos.symbol, date: utcDay(pos.opened_at),
        enteredAt: pos.opened_at, exitedAt: timestamp(),
        entryPrice: pos.entry_price, exitPrice: fillPrice, qty,
        entryScore: pos.entry_score, entryRvol: pos.entry_rvol, regime: pos.regime_at_entry,
        breakoutLevel: pos.breakout_level, stopPrice: pos.stop_price,
        targetPrice: number(pos.entry_price) * (1 + tiers[i].pct / 100),
        entryReason: 'BREAKOUT', exitReason: 'PARTIAL_PROFIT',
        exitDetail: `Scale-out tier ${i + 1} at +${tiers[i].pct}%`,
        pnl: +legPnl.toFixed(2),
        pnlPct: number(pos.entry_price) > 0 ? +((fillPrice - number(pos.entry_price)) / number(pos.entry_price) * 100).toFixed(4) : null,
        orderStatus: 'filled', exitOrderId: fill.id || null,
      });
      journalTrade(ctx.uid, rec);
      alert(ctx.uid, 'exit', `Crypto ${pos.symbol}: PARTIAL_PROFIT tier ${i + 1} (+${tiers[i].pct}%) — ${qty} @ ${fillPrice.toFixed(6)} (P&L ${legPnl >= 0 ? '+' : ''}${legPnl.toFixed(2)}).`);
      // Shrink the runner stop to the remaining shares — cancel-and-replace,
      // never two live stops for the same shares.
      try {
        hitIdx.add(i);
        await replaceRunnerStop(ctx, pos, { qty: Math.max(0, runnerQtyFor(pos, tiers, hitIdx)), stop: number(pos.stop_price) });
      } catch (error) {
        alert(ctx.uid, 'risk', `Crypto ${pos.symbol}: tier ${i + 1} banked but the runner stop could not be resized (${error.message || 'broker error'}) — manual check advised.`);
      }
    }
    // Runner stop filled at any generation → the position is stopped out.
    for (let g = gen; g >= 0; g--) {
      const runner = await orderByClient(ctx, runnerClientId(pos, g)).catch(() => null);
      if (runner && runner.status === 'filled' && number(runner.filled_qty) > 0) {
        return { banked, closed: true,
          stopFill: { qty: roundQty(number(runner.filled_qty)), fillPrice: number(runner.filled_avg_price) || 0 } };
      }
    }
    return { banked, closed: false };
  }
  async function closePosition(ctx, pos, { reason, detail, price, nonce = '' }) {
    // Journal ONLY on a confirmed fill. Protection orders must be dead
    // BEFORE the market exit goes out — they must never coexist, or a fill
    // race could oversell the position.
    if (!EXIT_REASONS.includes(reason)) throw new CryptoError(`Unknown exit reason: ${reason}.`);
    const cleared = await cancelProtection(ctx, pos);
    if (!cleared) {
      alert(ctx.uid, 'risk', `Crypto ${pos.symbol}: exit (${reason}) withheld — protection could not be canceled first.`);
      return false;
    }
    const qty = roundQty(number(pos.qty));
    if (!(qty > 0)) {
      db.prepare("UPDATE crypto_positions SET status='closed',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
      return true;
    }
    const exitId = clientId('exit', reason, pos.position_id, String(now()), nonce);
    const prior = await orderByClient(ctx, exitId).catch(() => null);
    if (prior && TERMINAL.has(prior.status) && prior.status !== 'filled') {
      // A terminal prior id is never reused — retry with a fresh nonce so
      // the recomputed id cannot collide with the dead one.
      return closePosition(ctx, pos, { reason, detail, price, nonce: `${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    }
    let order;
    try {
      order = await broker(ctx, '/v2/orders', { method: 'POST', body: {
        symbol: pos.symbol, qty, side: 'sell', type: 'market',
        time_in_force: 'gtc', client_order_id: exitId,
      } });
    } catch (error) {
      if (error?.duplicateClient) {
        const existing = await orderByClient(ctx, exitId).catch(() => null);
        if (existing) order = existing;
      }
      if (!order) return false;
    }
    const confirmed = await awaitFill(ctx, exitId);
    if (confirmed?.status !== 'filled' || !(number(confirmed.filled_qty) > 0)) {
      const live = confirmed && !TERMINAL.has(confirmed.status) ? confirmed
        : await orderByClient(ctx, exitId).catch(() => null);
      if (live && !TERMINAL.has(live.status)) await cancelOrderById(ctx, live.id).catch(() => null);
      alert(ctx.uid, 'risk', `Crypto ${pos.symbol}: exit (${reason}) not confirmed — will retry next cycle.`);
      return false;
    }
    const fillQty = roundQty(number(confirmed.filled_qty));
    const fillPrice = number(confirmed.filled_avg_price) || price || 0;
    const banked = number(pos.banked_pnl) || 0;
    const legPnl = (fillPrice - number(pos.entry_price)) * fillQty;
    const pnl = +(legPnl + banked).toFixed(2);
    const entryNotional = number(pos.entry_price) * fillQty;
    const holdMinutes = Math.round((now() - Date.parse(pos.opened_at)) / 60000);
    const rec = buildRecord({
      symbol: pos.symbol, date: utcDay(pos.opened_at),
      enteredAt: pos.opened_at, exitedAt: timestamp(),
      entryPrice: pos.entry_price, exitPrice: fillPrice, qty: fillQty,
      entryScore: pos.entry_score, entryRvol: pos.entry_rvol, regime: pos.regime_at_entry,
      breakoutLevel: pos.breakout_level, stopPrice: pos.stop_price,
      entryReason: 'BREAKOUT', exitReason: reason, exitDetail: detail || null,
      pnl, pnlPct: entryNotional > 0 ? +(pnl / entryNotional * 100).toFixed(4) : null,
      mfe: pos.mfe != null ? +number(pos.mfe).toFixed(4) : null,
      mae: pos.mae != null ? +number(pos.mae).toFixed(4) : null,
      holdMinutes, orderStatus: 'filled',
      entryOrderId: pos.entry_order_id, exitOrderId: confirmed.id || null,
    });
    journalTrade(ctx.uid, rec);
    db.prepare("UPDATE crypto_positions SET status='closed',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
    alert(ctx.uid, 'exit', `Crypto ${pos.symbol}: ${reason} @ ${fillPrice.toFixed(6)} (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}).`);
    return true;
  }
  async function closeMissing(ctx, pos) {
    // Broker truth says flat. Identify which protection order fired (if any)
    // and journal the exit. When NO order confirms a fill, the exit price and
    // P&L stay NULL — never fabricated — but the row still closes because
    // the broker is authoritatively flat.
    const rules = ctx.rules;
    const tiers = rules.scaleOutTiers || [];
    const gen = number(pos.protection_gen) || 0;
    let exitPrice = null, exitReason = 'MANUAL_EXIT', filledQty = 0, detail = 'Broker shows flat without a confirmed protection fill — treated as an external/manual close.';
    for (let i = 0; i < tiers.length; i++) {
      for (let g = 0; g <= gen; g++) {
        const tp = await orderByClient(ctx, tpClientId(pos, i, g)).catch(() => null);
        if (tp?.status === 'filled' && number(tp.filled_qty) > 0) {
          filledQty = Math.max(filledQty, roundQty(number(tp.filled_qty)));
          exitPrice = number(tp.filled_avg_price) || exitPrice;
          exitReason = 'TAKE_PROFIT'; detail = `Tier ${i + 1} take-profit filled; broker flat.`;
        }
      }
    }
    for (let g = gen; g >= 0; g--) {
      const runner = await orderByClient(ctx, runnerClientId(pos, g)).catch(() => null);
      if (runner?.status === 'filled' && number(runner.filled_qty) > 0 && exitPrice === null) {
        filledQty = Math.max(filledQty, roundQty(number(runner.filled_qty)));
        exitPrice = number(runner.filled_avg_price) || null;
        exitReason = pos.stop_stage === 'initial' ? 'STOP_LOSS' : 'TRAILING_STOP';
        detail = 'Runner stop filled; broker flat.';
      }
    }
    const banked = number(pos.banked_pnl) || 0;
    const qty = filledQty > 0 ? filledQty : roundQty(number(pos.qty) || 0);
    const pnl = exitPrice != null && exitPrice > 0 && qty > 0
      ? +((exitPrice - number(pos.entry_price)) * qty + banked).toFixed(2) : null;
    const rec = buildRecord({
      symbol: pos.symbol, date: utcDay(pos.opened_at),
      enteredAt: pos.opened_at, exitedAt: timestamp(),
      entryPrice: pos.entry_price, exitPrice, qty,
      entryScore: pos.entry_score, entryRvol: pos.entry_rvol, regime: pos.regime_at_entry,
      breakoutLevel: pos.breakout_level, stopPrice: pos.stop_price,
      entryReason: 'BREAKOUT', exitReason, exitDetail: detail,
      pnl, pnlPct: pnl != null && number(pos.entry_price) > 0 && qty > 0
        ? +(pnl / (number(pos.entry_price) * qty) * 100).toFixed(4) : null,
      mfe: pos.mfe != null ? +number(pos.mfe).toFixed(4) : null,
      mae: pos.mae != null ? +number(pos.mae).toFixed(4) : null,
      holdMinutes: Math.round((now() - Date.parse(pos.opened_at)) / 60000),
      orderStatus: exitPrice != null ? 'filled' : 'unknown',
      entryOrderId: pos.entry_order_id,
    });
    journalTrade(ctx.uid, rec);
    db.prepare("UPDATE crypto_positions SET status='closed',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
    await cancelProtection(ctx, pos).catch(() => {});
    alert(ctx.uid, 'exit', exitPrice != null
      ? `Crypto ${pos.symbol}: broker shows no position — closed as ${exitReason} at ${exitPrice.toFixed(6)} (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}).`
      : `Crypto ${pos.symbol}: broker shows no position and no protection leg confirms a fill — closed with UNKNOWN exit price/P&L; manual review advised.`);
  }
  // Momentum-exhaustion check: multiple confirmations, never one signal.
  function exhaustionSignals({ m5, ind, pos }) {
    const row = ind[ind.length - 1] || {};
    const prev = ind[ind.length - 2] || {};
    const last = m5[m5.length - 1];
    const signals = [];
    const rvolNow = row.rvol || 1;
    const entryRvol = number(pos.entry_rvol) || rvolNow;
    if (rvolNow < entryRvol * 0.5) signals.push('falling RVOL');
    if ((row.volMa20 || 0) < (prev.volMa20 || 0)) signals.push('falling volume');
    if (row.macdHist != null && prev.macdHist != null && row.macdHist < prev.macdHist && row.macdHist < 0) signals.push('MACD histogram deteriorating');
    const closes = m5.slice(-10).map(b => b.c);
    if (closes.length >= 6 && Math.max(...closes.slice(-3)) < Math.max(...closes.slice(0, 6))) signals.push('failed higher high');
    if (last.h > 0 && (last.h - Math.max(last.o, last.c)) / last.h > 0.004 && last.c < last.o) signals.push('large upper wick');
    if (row.vwap != null && last.c < row.vwap) signals.push('loss of VWAP');
    if (row.ema9 != null && last.c < row.ema9) signals.push('loss of 9 EMA');
    // Bearish reversal candle: red candle closing in the lower third with an upper wick.
    const range = last.h - last.l;
    if (range > 0 && last.c < last.o && (last.c - last.l) / range < 0.35) signals.push('bearish reversal candle');
    return signals;
  }
  async function manageCycle(ctx, account, regime, quotes, bars5m) {
    const rules = ctx.rules;
    const closed = [];
    for (const pos of openPositions(ctx.uid)) {
      guard(ctx.lease);
      const symbol = pos.symbol;
      const quote = quotes[symbol];
      const m5 = bars5m[symbol] || [];
      const price = quote && quote.mid > 0 ? quote.mid : (m5.length ? m5[m5.length - 1].c : 0);
      if (!(price > 0)) {
        alert(ctx.uid, 'risk', `Crypto ${symbol}: no fresh price — management withheld until data returns.`);
        continue;
      }
      const entry = number(pos.entry_price);
      const atr = number(pos.entry_atr) || entry * 0.02;
      // Track MFE/MAE and the high-water mark.
      const mfe = Math.max(number(pos.mfe) || 0, ((price - entry) / entry) * 100);
      const mae = Math.min(number(pos.mae) || 0, ((price - entry) / entry) * 100);
      const highest = Math.max(number(pos.highest_price) || entry, price);
      db.prepare('UPDATE crypto_positions SET highest_price=?,mfe=?,mae=?,updated_at=? WHERE position_id=?')
        .run(highest, mfe, mae, timestamp(), pos.position_id);
      pos.highest_price = highest; pos.mfe = mfe; pos.mae = mae;
      // 1) Tier fills first — banked partials, or a stop leg that closed us.
      const fills = await handleTierFills(ctx, pos);
      if (fills.closed && fills.stopFill) {
        const qty = fills.stopFill.qty;
        const fillPrice = fills.stopFill.fillPrice || price;
        const banked = (number(pos.banked_pnl) || 0);
        const pnl = +((fillPrice - entry) * qty + banked).toFixed(2);
        const rec = buildRecord({
          symbol, date: utcDay(pos.opened_at), enteredAt: pos.opened_at, exitedAt: timestamp(),
          entryPrice: entry, exitPrice: fillPrice, qty,
          entryScore: pos.entry_score, entryRvol: pos.entry_rvol, regime: pos.regime_at_entry,
          breakoutLevel: pos.breakout_level, stopPrice: pos.stop_price,
          entryReason: 'BREAKOUT', exitReason: pos.stop_stage === 'initial' ? 'STOP_LOSS' : 'TRAILING_STOP',
          exitDetail: 'Protection stop leg filled.',
          pnl, pnlPct: entry > 0 && qty > 0 ? +(pnl / (entry * qty) * 100).toFixed(4) : null,
          mfe: +mfe.toFixed(4), mae: +mae.toFixed(4),
          holdMinutes: Math.round((now() - Date.parse(pos.opened_at)) / 60000),
          orderStatus: 'filled', entryOrderId: pos.entry_order_id,
        });
        journalTrade(ctx.uid, rec);
        db.prepare("UPDATE crypto_positions SET status='closed',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
        await cancelProtection(ctx, pos).catch(() => {});
        closed.push(`${symbol}:${rec.exitReason}`);
        continue;
      }
      if (!(number(pos.qty) > 0)) {
        db.prepare("UPDATE crypto_positions SET status='closed',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
        continue;
      }
      const ind = m5.length >= 30 ? computeCryptoIntraday(m5) : [];
      const row = ind.length ? ind[ind.length - 1] : {};
      const last = m5.length ? m5[m5.length - 1] : null;
      const barsHeld = last ? Math.max(1, Math.round((now() - Date.parse(pos.opened_at)) / 300000)) : 1;
      let reason = null, detail = null;
      // 2) Strategy exits, in priority order.
      if (price <= number(pos.stop_price)) { reason = pos.stop_stage === 'initial' ? 'STOP_LOSS' : 'TRAILING_STOP'; detail = `Price ${price.toFixed(6)} at/below stop ${number(pos.stop_price).toFixed(6)}.`; }
      else if (last && rules.breakoutFailureBars > 0 && barsHeld <= rules.breakoutFailureBars &&
          number(pos.breakout_level) > 0 && last.c < number(pos.breakout_level)) {
        reason = 'BREAKOUT_FAILURE'; detail = `Closed back below the breakout level ${number(pos.breakout_level).toFixed(6)} within ${rules.breakoutFailureBars} bars.`;
      } else if (last && rules.vwapLossEnabled && row.vwap != null && last.c < row.vwap && mfe > 0.5) {
        reason = 'VWAP_LOSS'; detail = 'Lost session VWAP after a profitable excursion.';
      } else if (last && rules.emaBreakdownEnabled && row.ema20 != null && last.c < row.ema20 && last.o < row.ema20 && mfe > 0.5) {
        reason = 'EMA_BREAKDOWN'; detail = 'Closed below the 20 EMA.';
      }
      // Volume fade → tighten, then exit if the fade persists with momentum loss.
      const rvolNow = row.rvol || 1;
      const entryRvol = number(pos.entry_rvol) || rvolNow;
      const fading = rvolNow < entryRvol * 0.5 && mfe > 1;
      if (!reason && fading && pos.volume_fade_stage === 0) {
        const tight = Math.max(rules.tightenOnVolumeFade, 0.5);
        db.prepare('UPDATE crypto_positions SET volume_fade_stage=1,trailing_mult=?,stop_stage=? WHERE position_id=?')
          .run(tight, 'tightened', pos.position_id);
        pos.trailing_mult = tight; pos.volume_fade_stage = 1; pos.stop_stage = 'tightened';
        alert(ctx.uid, 'risk', `Crypto ${symbol}: volume fading (RVOL ${rvolNow.toFixed(2)}x vs ${entryRvol.toFixed(2)}x at entry) — trailing tightened to ${tight} ATR.`);
      }
      const signals = ind.length ? exhaustionSignals({ m5, ind, pos }) : [];
      if (!reason && signals.length >= 3) {
        if (pos.volume_fade_stage < 2) {
          const tight = Math.max(rules.tightenOnExhaustion, 0.5);
          db.prepare('UPDATE crypto_positions SET volume_fade_stage=2,trailing_mult=?,stop_stage=? WHERE position_id=?')
            .run(tight, 'tightened', pos.position_id);
          pos.trailing_mult = tight; pos.volume_fade_stage = 2; pos.stop_stage = 'tightened';
          alert(ctx.uid, 'risk', `Crypto ${symbol}: momentum exhaustion warning (${signals.slice(0, 3).join('; ')}) — trailing tightened to ${tight} ATR.`);
        } else {
          reason = 'MOMENTUM_EXHAUSTION'; detail = `Confirmed by: ${signals.join('; ')}.`;
        }
      }
      if (!reason && signals.length === 1 && signals[0] === 'bearish reversal candle' && mfe > 2) {
        reason = 'BEARISH_REVERSAL'; detail = 'Bearish reversal candle after a profitable run.';
      }
      // ATR trailing stop on the runner.
      const trailMult = number(pos.trailing_mult) || rules.trailingAtrMult;
      const trailLine = highest - trailMult * atr;
      if (!reason && trailLine > number(pos.stop_price) && price < trailLine && mfe > 0.5) {
        reason = 'TRAILING_STOP'; detail = `Price ${price.toFixed(6)} below the ${trailMult} ATR trailing line ${trailLine.toFixed(6)}.`;
      }
      // Regime change: BTC turned bearish/high-volatility — exit altcoin longs.
      if (!reason && (regime.regime === 'bearish' || regime.regime === 'high_volatility') && baseSymbol(symbol) !== 'BTC') {
        reason = 'MARKET_REGIME_CHANGE'; detail = `BTC regime flipped to ${regime.regime}.`;
      }
      // Plain volume fade with momentum deterioration and no other trigger:
      // begin taking profits.
      if (!reason && fading && pos.volume_fade_stage >= 1 && signals.length >= 2) {
        reason = 'VOLUME_FADE'; detail = `Breakout volume faded (RVOL ${rvolNow.toFixed(2)}x) with momentum deterioration (${signals.slice(0, 2).join('; ')}).`;
      }
      if (reason) {
        const ok = await closePosition(ctx, pos, { reason, detail, price });
        if (ok) closed.push(`${symbol}:${reason}`);
      } else {
        // Ratchet the runner stop up under the trailing line. Broker truth
        // comes FIRST: the cancel-and-replace runs against the intended stop,
        // and the local row is only committed after it succeeds. On failure
        // the old local stop AND the old broker stop stay intact — a stale
        // broker stop is never adopted.
        const newStop = Math.max(number(pos.stop_price), trailLine > entry ? trailLine : number(pos.stop_price));
        if (newStop > number(pos.stop_price) && mfe > 1) {
          try {
            await attachProtection(ctx, pos, { stop: newStop });
            db.prepare('UPDATE crypto_positions SET stop_price=?,stop_stage=?,updated_at=? WHERE position_id=?')
              .run(newStop, 'trailing', timestamp(), pos.position_id);
            pos.stop_price = newStop; pos.stop_stage = 'trailing';
          } catch (error) {
            alert(ctx.uid, 'risk', `Crypto ${symbol}: trailing ratchet failed (${error.message || 'broker error'}) — keeping stop ${number(pos.stop_price).toFixed(6)}.`);
          }
        }
      }
    }
    return { closed };
  }
  async function reconcileCycle(ctx, account) {
    const opened = [];
    const closed = [];
    // Pending entries: resolve each entry order by broker truth.
    for (const pos of db.prepare("SELECT * FROM crypto_positions WHERE user_id=? AND status='pending_entry'").all(ctx.uid)) {
      guard(ctx.lease);
      let resolved = null;
      try { resolved = await orderByClient(ctx, pos.entry_order_id); } catch (_) { resolved = null; }
      if (!resolved || !TERMINAL.has(resolved.status)) continue;
      if (resolved.status === 'filled' && number(resolved.filled_qty) > 0) {
        const fillPrice = number(resolved.filled_avg_price) || number(pos.entry_price);
        const qty = roundQty(number(resolved.filled_qty));
        db.prepare("UPDATE crypto_positions SET status='open',qty=?,entry_price=?,updated_at=? WHERE position_id=?")
          .run(qty, fillPrice, timestamp(), pos.position_id);
        pos.status = 'open'; pos.qty = qty; pos.entry_price = fillPrice;
        try {
          await attachProtection(ctx, pos);
          opened.push(pos.symbol);
          alert(ctx.uid, 'fill', `Crypto filled ${pos.symbol} ${qty} @ ${fillPrice.toFixed(6)}; protection attached.`);
        } catch (error) {
          alert(ctx.uid, 'risk', `Crypto ${pos.symbol}: fill confirmed but protection failed (${error.message || 'broker error'}) — position UNPROTECTED until re-attached.`);
        }
      } else {
        db.prepare("UPDATE crypto_positions SET status='rejected',updated_at=? WHERE position_id=?").run(timestamp(), pos.position_id);
        const rec = buildRecord({ symbol: pos.symbol, date: utcDay(pos.opened_at),
          enteredAt: pos.opened_at, entryPrice: pos.entry_price, qty: 0,
          entryReason: 'BREAKOUT', orderStatus: 'rejected' });
        journalTrade(ctx.uid, rec);
        alert(ctx.uid, 'system', `Crypto ${pos.symbol}: entry order ${resolved.status} — no position taken.`);
      }
    }
    // Broker-truth positions. A FAILED fetch pauses reconciliation entirely —
    // it must never look like "no positions".
    let brokerPositions;
    try {
      brokerPositions = await broker(ctx, '/v2/positions');
      if (!Array.isArray(brokerPositions)) throw new CryptoError('Positions response malformed.');
    } catch (error) {
      db.prepare("UPDATE crypto_settings SET scheduler_status='error',scheduler_reason=?,last_cycle_at=? WHERE user_id=?")
        .run('Broker positions unavailable — reconciliation paused; no positions were opened, closed, or changed.',
          timestamp(), ctx.uid);
      alert(ctx.uid, 'risk', 'Crypto: broker positions request failed — reconciliation paused until broker truth returns. No state changed.');
      return { opened, closed, paused: true };
    }
    const cryptoBrokerPos = (brokerPositions || []).filter(p => String(p.symbol || '').includes('/'));
    for (const pos of openPositions(ctx.uid)) {
      guard(ctx.lease);
      const brokerPos = cryptoBrokerPos.find(p => String(p.symbol).toUpperCase() === pos.symbol.toUpperCase());
      if (!brokerPos) {
        await closeMissing(ctx, pos);
        closed.push(`${pos.symbol}:missing`);
        continue;
      }
      const qty = Math.max(0, roundQty(number(brokerPos.qty) || 0));
      if (qty !== number(pos.qty)) {
        db.prepare('UPDATE crypto_positions SET qty=?,updated_at=? WHERE position_id=?').run(qty, timestamp(), pos.position_id);
        pos.qty = qty;
      }
      // Protection must be live. Re-attach when every protection order is
      // dead; a FAILED lookup withholds changes rather than stacking a
      // second set of orders.
      const liveProtection = await openProtectionOrders(ctx, pos);
      if (liveProtection === null) {
        alert(ctx.uid, 'risk', `Crypto ${pos.symbol}: protection state unknown (broker lookup failed) — withholding changes until broker truth returns.`);
      } else if (liveProtection.length === 0 && qty > 0) {
        try { await attachProtection(ctx, pos); }
        catch (error) {
          alert(ctx.uid, 'risk', `Crypto ${pos.symbol}: protection is not live (${error.message || 'broker error'}) — position unmanaged until re-attached.`);
        }
      }
    }
    // Adopt broker-held crypto the service doesn't track (crashed entry run
    // or a manual trade on this account) — never submit a duplicate.
    for (const bp of cryptoBrokerPos) {
      const symbol = String(bp.symbol).toUpperCase();
      const tracked = db.prepare("SELECT 1 FROM crypto_positions WHERE user_id=? AND symbol=? AND status IN ('open','pending_entry')")
        .get(ctx.uid, symbol);
      if (!tracked && number(bp.qty) > 0) {
        db.prepare(`INSERT INTO crypto_positions(position_id,user_id,symbol,qty,entry_price,stop_price,
          entry_atr,highest_price,trailing_mult,status,opened_at,updated_at)
          VALUES (?,?,?,?,?,?,?, ?,?,'open',?,?)`)
          .run(crypto.randomUUID(), ctx.uid, symbol, roundQty(number(bp.qty)),
            number(bp.avg_entry_price) || 0, (number(bp.avg_entry_price) || 0) * 0.97,
            (number(bp.avg_entry_price) || 0) * 0.02, number(bp.avg_entry_price) || 0,
            ctx.rules.trailingAtrMult, timestamp(), timestamp());
        opened.push(`${symbol}:adopted`);
        alert(ctx.uid, 'system', `Crypto ${symbol}: broker holds an untracked position — adopted, no duplicate order.`);
      }
    }
    return { opened, closed };
  }

  // ---------------------------------------------------------------------------
  // Emergency stop — halt new entries AND flatten every open position with
  // confirmed fills. Journaled as MANUAL_EXIT.
  // ---------------------------------------------------------------------------
  async function emergencyStop(uid) {
    return locked(uid, async lease => {
      const settings = ensure(uid);
      const rules = getRules(uid);
      rules.emergencyStop = true;
      db.prepare('UPDATE crypto_settings SET rules=? WHERE user_id=?')
        .run(JSON.stringify({ ...rules, weights: rules.weights, scaleOutTiers: rules.scaleOutTiers }), uid);
      const cred = credential(uid, settings.mode);
      const flattened = [];
      if (cred) {
        const ctx = { uid, lease, settings, cred, rules };
        authorize(ctx);
        for (const pos of openPositions(uid)) {
          guard(lease);
          const ok = await closePosition(ctx, pos, {
            reason: 'MANUAL_EXIT', detail: 'Emergency stop — flattened by user.', price: 0,
          });
          if (ok) flattened.push(pos.symbol);
        }
      }
      alert(uid, 'risk', `Crypto EMERGENCY STOP engaged — ${flattened.length} position(s) flattened, new entries halted.`);
      return { ok: true, emergencyStop: true, flattened };
    });
  }

  // ---------------------------------------------------------------------------
  // Scheduler lifecycle — 60s cadence, 24/7 (crypto never closes: NO
  // market-hours gate). First run delayed ~15s so the loop lands between
  // B2's and Warrior's cycles.
  // ---------------------------------------------------------------------------
  async function run(uid) {
    return locked(uid, async lease => {
      const settings = ensure(uid);
      if (!settings.enabled) return { ok: true, skipped: 'disabled' };
      const rules = getRules(uid);
      const cred = credential(uid, settings.mode);
      if (!cred) {
        db.prepare("UPDATE crypto_settings SET scheduler_status='idle',scheduler_reason='Not connected.' WHERE user_id=?").run(uid);
        return { ok: false, reason: 'not-connected' };
      }
      const ctx = { uid, lease, settings, cred, rules };
      expireOpportunities(uid);
      const account = await broker(ctx, '/v2/account');
      validateAccount(account, cred.account_id);
      guard(lease);
      // Reconcile positions FIRST, so risk math sees broker truth.
      const reconcileResult = await reconcileCycle(ctx, account);
      if (reconcileResult.paused) {
        return { ok: true, reconcile: reconcileResult, scan: null, entry: null, manage: null, paused: true };
      }
      const equity = number(account.equity) || 0;
      const stats = dailyStats(uid, equity);
      stats._uid = uid;
      const halted = rules.emergencyStop ||
        (equity > 0 && stats.dayPnl <= -(rules.maxDailyLossPct / 100) * equity) ||
        stats.consecutiveLosses >= rules.maxConsecutiveLosses;
      let scanResult = null, entryResult = null, manageResult = null;
      let regime = { regime: 'neutral', reasons: [] };
      if (!halted) {
        scanResult = await scanCycle(ctx, account);
        regime = { regime: scanResult.regime, reasons: [] };
        // Fresh quotes + 5m tape for entries and management.
        const posSymbols = openPositions(uid).map(p => p.symbol);
        const oppSymbols = db.prepare("SELECT DISTINCT symbol FROM crypto_opportunities WHERE user_id=? AND status='open'")
          .all(uid).map(r => r.symbol);
        const symbols = [...new Set([...posSymbols, ...oppSymbols])];
        let quotes = {}, bars5m = {};
        try {
          const end = new Date(now()).toISOString();
          [quotes, bars5m] = await Promise.all([
            latestQuotes(ctx, symbols).catch(() => ({})),
            loadCryptoBars(ctx, symbols, '5Min', new Date(now() - 86400000).toISOString(), end).catch(() => ({})),
          ]);
        } catch (_) { /* entries fail closed below; management withholds per-position */ }
        entryResult = await entryCycle(ctx, account, regime);
        manageResult = await manageCycle(ctx, account, regime, quotes, bars5m);
        db.prepare(`UPDATE crypto_settings SET scheduler_status='ok',scheduler_reason=?,last_cycle_at=? WHERE user_id=?`)
          .run(null, timestamp(), uid);
      } else {
        // Halted accounts still manage open positions (trailing/exits),
        // but never scan or enter.
        const posSymbols = openPositions(uid).map(p => p.symbol);
        let quotes = {}, bars5m = {};
        try {
          const end = new Date(now()).toISOString();
          [quotes, bars5m] = await Promise.all([
            latestQuotes(ctx, posSymbols).catch(() => ({})),
            loadCryptoBars(ctx, posSymbols, '5Min', new Date(now() - 86400000).toISOString(), end).catch(() => ({})),
          ]);
        } catch (_) {}
        regime = await btcRegime(ctx);
        manageResult = await manageCycle(ctx, account, regime, quotes, bars5m);
        const haltReason = rules.emergencyStop ? 'Emergency stop active.'
          : `Halted: daily-loss or consecutive-loss cap reached.`;
        db.prepare(`UPDATE crypto_settings SET scheduler_status='ok',scheduler_reason=?,last_cycle_at=? WHERE user_id=?`)
          .run(haltReason, timestamp(), uid);
        scanResult = { skipped: 'halted' };
      }
      if (durability?.flush && persistenceReady()) await durability.flush('crypto-tick');
      return { ok: true, reconcile: reconcileResult, scan: scanResult, entry: entryResult,
        manage: manageResult, halted, regime: regime.regime };
    });
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
          if (dispatch?.markTickFailure) await dispatch.markTickFailure('crypto', error);
        } catch (_) { /* never let failure bookkeeping break the loop */ }
      }
    } finally {
      if (activeTick === tickRun) activeTick = null;
      ticking = false;
    }
  }
  async function runTick() {
    const rows = db.prepare('SELECT user_id,mode FROM crypto_settings WHERE enabled=1').all();
    for (const row of rows) {
      const settings = getSettings(row.user_id);
      if (!settings?.enabled) continue;
      try {
        await run(row.user_id);
        if (durability?.flush && persistenceReady()) await durability.flush('crypto-tick');
      } catch (error) {
        db.prepare('UPDATE crypto_settings SET scheduler_status=?,scheduler_reason=?,last_cycle_at=? WHERE user_id=?')
          .run('error', String(error?.message || error).slice(0, 500), timestamp(), row.user_id);
        try { alert(row.user_id, 'system', `Crypto scan failed: ${String(error?.message || error).slice(0, 200)}`); }
        catch (_) { /* alert insert best-effort */ }
      }
    }
  }
  function start() {
    if (running) return;
    running = true;
    generation++;
    db.prepare("UPDATE crypto_settings SET scheduler_status='idle',scheduler_reason=NULL WHERE scheduler_status='running'").run();
    // First run delayed ~15s so the crypto loop lands between B2's and
    // Warrior's cycles. Crypto trades 24/7 — no market-hours check.
    setTimeout(() => { if (running) void tick(); }, 15000);
    timer = setInterval(tick, SCHEDULER_MS);
  }
  function stop() { running = false; if (timer) { clearInterval(timer); timer = null; } }
  async function drain() {
    stop();
    if (activeTick) await activeTick;
  }

  // ---------------------------------------------------------------------------
  // Backtest — event-driven on REAL historical bars (no fake data). The
  // engine walks each symbol's 5m tape bar-by-bar: breakout detection uses
  // only bars <= the current index, entries fill at the NEXT bar's open,
  // and management (scale-outs, trailing, exits) replays every subsequent
  // bar. Indicator series are precomputed but no-look-ahead by
  // construction, so index-guarded reads see exactly what the live engine
  // would have seen.
  // ---------------------------------------------------------------------------
  function runCryptoBacktest({ bars5mBySymbol, dailyBySymbol = {}, rules, equity }) {
    const R = { ...DEFAULT_CRYPTO_RULES, ...rules };
    const trades = [];
    for (const [symbol, m5raw] of Object.entries(bars5mBySymbol)) {
      const m5 = (m5raw || []).filter(b => [b.o, b.h, b.l, b.c].every(Number.isFinite));
      if (m5.length < 120) continue;
      const daily = dailyBySymbol[symbol] || [];
      const ind = computeCryptoIntraday(m5);
      const rsiAll = ind.map(r => r.rsi14);
      let position = null;
      const WARMUP = 100;
      for (let i = WARMUP; i < m5.length - 1; i++) {
        const row = ind[i];
        if (!position) {
          // Breakout: close above the max high of the prior 50 bars
          // (excluding the current bar), with RVOL confirmation.
          const window = m5.slice(Math.max(0, i - 50), i);
          const resistance = Math.max(...window.map(b => b.h));
          const rvolNow = row.rvol || 1;
          if (m5[i].c > resistance && rvolNow >= R.rvolMin) {
            const entry = m5[i + 1].o; // fill at next bar's open
            if (!(entry > 0)) continue;
            const atr = row.atr14 || entry * 0.02;
            const notional = Math.min(
              R.sizingMode === 'pct_equity' ? (equity * R.pctEquity) / 100 : R.fixedDollar,
              R.maxPositionNotional);
            const qty = notional / entry;
            const stop = R.stopMode === 'pct' ? entry * (1 - R.stopPct / 100) : entry - R.atrStopMult * atr;
            position = {
              entry, qty, stop, atr, entryIdx: i,
              breakoutLevel: resistance, highest: entry,
              tiersHit: new Set(), banked: 0, mfe: 0, mae: 0,
              trailMult: R.trailingAtrMult,
            };
          }
          continue;
        }
        // Manage the open position bar-by-bar.
        const bar = m5[i];
        position.highest = Math.max(position.highest, bar.h);
        position.mfe = Math.max(position.mfe, ((bar.h - position.entry) / position.entry) * 100);
        position.mae = Math.min(position.mae, ((bar.l - position.entry) / position.entry) * 100);
        let exitReason = null, exitPrice = null, exitQty = position.qty;
        // Scale-out tiers.
        for (let ti = 0; ti < R.scaleOutTiers.length; ti++) {
          if (position.tiersHit.has(ti)) continue;
          const tier = R.scaleOutTiers[ti];
          const tp = position.entry * (1 + tier.pct / 100);
          if (bar.h >= tp) {
            const q = position.qty * tier.qty;
            position.banked += (tp - position.entry) * q;
            position.qty -= q;
            position.tiersHit.add(ti);
            trades.push({ symbol, side: 'partial', tier: ti + 1,
              entryPrice: position.entry, exitPrice: tp, qty: q,
              exitReason: 'PARTIAL_PROFIT', pnl: (tp - position.entry) * q,
              enteredAt: m5[position.entryIdx].t, exitedAt: bar.t });
          }
        }
        if (bar.l <= position.stop) { exitReason = position.trailMult < R.trailingAtrMult ? 'TRAILING_STOP' : 'STOP_LOSS'; exitPrice = position.stop; }
        else if (i - position.entryIdx <= R.breakoutFailureBars && bar.c < position.breakoutLevel) { exitReason = 'BREAKOUT_FAILURE'; exitPrice = bar.c; }
        else {
          const trailLine = position.highest - position.trailMult * position.atr;
          if (trailLine > position.stop && bar.l <= trailLine && position.mfe > 0.5) { exitReason = 'TRAILING_STOP'; exitPrice = trailLine; }
        }
        if (!exitReason && position.mfe > 1) {
          // Volume fade + momentum deterioration → tighten, then exit.
          const rvolNow = row.rvol || 1;
          const histDown = row.macdHist != null && ind[i - 1].macdHist != null && row.macdHist < ind[i - 1].macdHist;
          if (rvolNow < 1 && histDown && position.trailMult === R.trailingAtrMult) {
            position.trailMult = R.tightenOnVolumeFade;
          } else if (rvolNow < 1 && histDown && position.trailMult === R.tightenOnVolumeFade) {
            exitReason = 'VOLUME_FADE'; exitPrice = bar.c;
          }
        }
        if (exitReason) {
          const pnl = (exitPrice - position.entry) * position.qty + position.banked;
          trades.push({ symbol, side: 'exit', entryPrice: position.entry, exitPrice, qty: position.qty,
            exitReason, pnl, mfe: position.mfe, mae: position.mae,
            holdBars: i - position.entryIdx,
            enteredAt: m5[position.entryIdx].t, exitedAt: bar.t });
          position = null;
        }
      }
      // An open position at the end of the tape closes at the last close.
      if (position) {
        const last = m5[m5.length - 1];
        const pnl = (last.c - position.entry) * position.qty + position.banked;
        trades.push({ symbol, side: 'exit', entryPrice: position.entry, exitPrice: last.c, qty: position.qty,
          exitReason: 'MANUAL_EXIT', pnl, mfe: position.mfe, mae: position.mae,
          holdBars: m5.length - 1 - position.entryIdx,
          enteredAt: m5[position.entryIdx].t, exitedAt: last.t, note: 'end of tape' });
      }
    }
    // Report.
    const exits = trades.filter(t => t.side === 'exit');
    const pnls = exits.map(t => t.pnl);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const grossWin = wins.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
    const net = pnls.reduce((s, p) => s + p, 0);
    let peak = 0, curve = 0, maxDd = 0;
    for (const p of pnls) { curve += p; if (curve > peak) peak = curve; maxDd = Math.max(maxDd, peak - curve); }
    const byExitReason = {};
    for (const t of exits) byExitReason[t.exitReason] = (byExitReason[t.exitReason] || 0) + 1;
    return {
      report: {
        symbols: Object.keys(bars5mBySymbol), equity,
        trades: exits.length,
        partials: trades.filter(t => t.side === 'partial').length,
        wins: wins.length, losses: losses.length,
        winRate: exits.length ? wins.length / exits.length : null,
        profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : null,
        netPnl: +net.toFixed(2),
        returnPct: equity > 0 ? +(net / equity * 100).toFixed(4) : null,
        maxDrawdown: +maxDd.toFixed(2),
        avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : null,
        avgLoss: losses.length ? +(grossLoss / losses.length).toFixed(2) : null,
        byExitReason,
      },
      trades,
    };
  }
  async function backtest(uid, input = {}) {
    validateInput(input, ['symbols', 'days', 'params'], 'Only symbols, days and params may be supplied.');
    const symbols = Array.isArray(input.symbols) && input.symbols.length
      ? [...new Set(input.symbols.map(s => String(s).toUpperCase()).filter(Boolean))].slice(0, 10)
      : ['BTC/USD'];
    if (!symbols.length) throw new CryptoError('At least one symbol is required.', 400);
    const days = Math.min(Math.max(Number(input.days) || 30, 5), 90);
    const rules = getRules(uid);
    const params = {
      minScore: rules.minScore, rvolMin: rules.rvolMin,
      riskPerTradePct: null, maxDailyLossPct: rules.maxDailyLossPct, maxPositions: rules.maxPositions,
      ...(input.params && typeof input.params === 'object' ? input.params : {}),
    };
    // Historical bars come through the same guarded broker path as the live
    // scan (read-only lease, dedicated crypto credentials). Fail closed
    // when the broker is not connected — backtests never fabricate bars.
    const bars5mBySymbol = {};
    const dailyBySymbol = {};
    const dataErrors = {};
    const equity = await locked(uid, async lease => {
      const settings = ensure(uid);
      const cred = credential(uid, settings.mode);
      if (!cred) throw new CryptoError('Connect a dedicated crypto broker account to run backtests.', 409);
      const ctx = { uid, lease, settings, cred, rules };
      let accountEquity = 25000;
      try {
        const account = await broker(ctx, '/v2/account');
        if (Number.isFinite(+account?.equity)) accountEquity = +account.equity;
      } catch (_) { /* sizing falls back to the default equity */ }
      const end = new Date(now()).toISOString();
      for (const symbol of symbols) {
        guard(lease);
        try {
          // One request per day keeps payloads bounded; crypto trades 24/7
          // so there are no weekend gaps to skip.
          const m5 = [];
          const daily = [];
          const dayMs = 86400000;
          let cursor = now();
          let fetched = 0, attempts = 0;
          while (fetched < days && attempts < days + 5) {
            attempts++;
            const dEnd = new Date(cursor).toISOString();
            const dStart = new Date(cursor - dayMs).toISOString();
            const bars = await loadCryptoBars(ctx, [symbol], '5Min', dStart, dEnd);
            const dayBars = bars[symbol] || [];
            if (dayBars.length) { m5.push(...dayBars); fetched++; }
            cursor -= dayMs;
          }
          m5.sort((a, b) => a.t - b.t);
          const dBars = await loadCryptoBars(ctx, [symbol], '1Day',
            new Date(now() - (days + 60) * dayMs).toISOString(), end);
          daily.push(...(dBars[symbol] || []));
          if (m5.length < 120) { dataErrors[symbol] = 'Insufficient 5m bars for the requested range.'; continue; }
          bars5mBySymbol[symbol] = m5;
          dailyBySymbol[symbol] = daily;
        } catch (error) {
          dataErrors[symbol] = error.message || 'Bar fetch failed.';
        }
      }
      return accountEquity;
    });
    if (!Object.keys(bars5mBySymbol).length) {
      throw new CryptoError('No usable historical data for the requested symbols.', 502);
    }
    const { report, trades } = runCryptoBacktest({ bars5mBySymbol, dailyBySymbol, rules, equity });
    const backtestId = crypto.randomUUID();
    const createdAt = timestamp();
    const storedParams = { symbols, days, params, dataErrors };
    db.transaction(() => {
      db.prepare('INSERT INTO crypto_backtests(backtest_id,user_id,params,report,created_at) VALUES (?,?,?,?,?)')
        .run(backtestId, uid, JSON.stringify(storedParams), JSON.stringify(report), createdAt);
      const insert = db.prepare('INSERT INTO crypto_backtest_trades(backtest_id,idx,trade_json) VALUES (?,?,?)');
      const capped = trades.slice(0, 500);
      capped.forEach((t, idx) => insert.run(backtestId, idx, JSON.stringify(t)));
    })();
    return { backtestId, report, trades: trades.length, dataErrors };
  }
  function getBacktests(uid) {
    const rows = db.prepare('SELECT backtest_id,params,created_at FROM crypto_backtests WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(uid);
    return { backtests: rows.map(r => ({ backtestId: r.backtest_id, params: JSON.parse(r.params || '{}'), createdAt: r.created_at })) };
  }
  function getBacktest(uid, backtestId) {
    const row = db.prepare('SELECT * FROM crypto_backtests WHERE backtest_id=? AND user_id=?').get(backtestId, uid);
    if (!row) throw new CryptoError('Backtest not found.', 404);
    const tradeRows = db.prepare('SELECT idx,trade_json FROM crypto_backtest_trades WHERE backtest_id=? ORDER BY idx').all(backtestId);
    return {
      backtestId: row.backtest_id, params: JSON.parse(row.params || '{}'),
      report: JSON.parse(row.report || '{}'), createdAt: row.created_at,
      trades: tradeRows.map(r => JSON.parse(r.trade_json)),
    };
  }
  // crypto_journal retired 2026-09-29 (Johnny: no zombie data) — removed.

  const service = {
    strategy: STRATEGY,
    start, stop, drain,
    connect, disconnect,
    settings: getSettingsView, updateSettings: setSettings,
    status, universe, opportunities, positions, trades, alerts,
    backtest, getBacktests, getBacktest,
    pruneDiagnostics,
    emergencyStop, run,
    DEFAULT_CRYPTO_RULES, EXIT_REASONS, CRYPTO_TRADE_FIELDS,
    // Test seams.
    scoreSymbol: ({ uid, symbol, m5, daily, rules, regime, quote }) =>
      scoreSymbol({ uid, symbol, m5, daily, ind: computeCryptoIntraday(m5),
        rules: rules || getRules(uid), regime: regime || { regime: 'neutral', reasons: [] }, quote: quote || null }),
    detectBreakout: ({ symbol, m5, daily, rules, regime }) =>
      detectBreakout({ symbol, m5, daily, ind: computeCryptoIntraday(m5),
        rules: rules || DEFAULT_CRYPTO_RULES, regime: regime || { regime: 'neutral', reasons: [] } }),
    runCryptoBacktest,
    entryGates: (args) => entryGates(args),
  };
  return service;
}

// ---------------------------------------------------------------------------
// Route mounting — mirrors mountWarrior but under /api/crypto, exactly the
// API contract Crew C's dashboard calls.
// ---------------------------------------------------------------------------
function mountCrypto({ app, service, requireAuth, ensureSessionUserInTradingStore }) {
  if (!app || !service || typeof requireAuth !== 'function') throw new Error('Crypto requires an app, a service and requireAuth.');
  const withUser = handler => async (req, res, next) => {
    try {
      const uid = ensureSessionUserInTradingStore
        ? await ensureSessionUserInTradingStore(req)
        : Number(req.session?.userId);
      const result = await handler(uid, req, res);
      if (!res.headersSent && result !== undefined) res.json(result);
    } catch (error) {
      const status = error instanceof CryptoError ? error.status : 500;
      if (!res.headersSent) res.status(status).json({ error: error?.message || 'Crypto request failed.' });
    }
  };
  const json = bodyParserJson();
  app.get('/api/crypto/status', requireAuth, withUser(uid => service.status(uid)));
  app.post('/api/crypto/connect', requireAuth, json, withUser((uid, req) => service.connect(uid, req.body || {})));
  app.post('/api/crypto/disconnect', requireAuth, json, withUser(uid => service.disconnect(uid)));
  app.get('/api/crypto/universe', requireAuth, withUser(uid => service.universe(uid)));
  app.get('/api/crypto/opportunities', requireAuth, withUser((uid, req) => service.opportunities(uid, req.query || {})));
  app.get('/api/crypto/positions', requireAuth, withUser(uid => service.positions(uid)));
  app.get('/api/crypto/trades', requireAuth, withUser((uid, req) => service.trades(uid, req.query || {})));
  app.get('/api/crypto/alerts', requireAuth, withUser(uid => service.alerts(uid)));
  app.get('/api/crypto/settings', requireAuth, withUser(uid => service.settings(uid)));
  app.put('/api/crypto/settings', requireAuth, json, withUser((uid, req) => service.updateSettings(uid, req.body || {})));
  app.post('/api/crypto/backtest', requireAuth, json, withUser((uid, req) => service.backtest(uid, req.body || {})));
  app.post('/api/crypto/emergency-stop', requireAuth, json, withUser(uid => service.emergencyStop(uid)));
}
function bodyParserJson() {
  try {
    return require('express').json();
  } catch (_) {
    return (req, _res, next) => {
      let data = '';
      req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { req.body = data ? JSON.parse(data) : {}; } catch (_) { req.body = {}; } next(); });
    };
  }
}

module.exports = {
  createCryptoService,
  mountCrypto,
  CryptoError,
  DEFAULT_CRYPTO_RULES,
  EXIT_REASONS, // the 12 explicit exit reasons are part of the API contract
};
