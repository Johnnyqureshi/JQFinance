'use strict';

// Singles & Doubles (SD) orchestration service.
//
// An independent intraday momentum strategy that runs alongside B2 without
// sharing any strategy state with it: own tables (sd_*), own op leases
// (sd_leases), own settings/credentials, and its own 'sd-' client order ID
// prefix. Equities only. Defaults: enabled=0, mode='paper'. Live trading is
// impossible without an explicit arm through the shared strategy registry.
//
// The strategy itself lives in lib/sd-strategy.js (Workstream 1) and is
// injected here as `strategy`; the service only orchestrates scanning,
// authorization, order lifecycle, and reconciliation. This mirrors the
// structure and safety patterns of lib/b2-service.js without importing it.

const crypto = require('crypto');
const { DEFAULT_LIQUIDITY_POLICY } = require('./liquidity-policy');
const { evaluateAlpacaLiquidity } = require('./liquidity-providers');
const { calculateRegularSessionVwap } = require('./intraday-vwap');
const { brokerOrderMatchesIntent } = require('./broker-order-ownership');

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced']);
const CLOSED = new Set(['closed', 'rejected', 'canceled']);
const ACTIVE_STOP = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'held']);
const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const STRATEGY_KEY = 'singles_doubles';
const SCOPE = 'singles_doubles';
const SCAN_BATCH = 40; // symbols evaluated per cycle
const EOD_FLATTEN_MINUTES = 15 * 60 + 50; // 15:50 ET
const QUOTE_MAX_AGE_MS = 60000;
const PRICE_RECHECK_MS = 7 * 86400000; // re-check stale out-of-band prices weekly

class SdError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
function number(value) { return value == null || value === '' ? NaN : Number(value); }
function clientId(...parts) {
  return `sd-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}
function easternDate(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}
// ISO instant for the start of the given value's New York trading date,
// expressed in UTC. Used for day-boundary comparisons against UTC timestamps.
function easternDayStartUtc(value) {
  const date = easternDate(value);
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(`${date}T12:00:00Z`)));
  const offsetHours = 12 - localHour; // 4 for EDT, 5 for EST
  return new Date(`${date}T00:00:00-${String(offsetHours).padStart(2, '0')}:00`).toISOString();
}
function easternTimeMinutes(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return get('hour') * 60 + get('minute');
}

function createSdService({
  db, vault, fetch: fetchBroker, now = () => Date.now(), strategy,
  getAutomaticBotContext = async () => null,
  automaticBotSettings = null,
  persistenceReady = () => true,
  durability = null,
  batchSize = 100, timeoutMs = 10000, leaseMs = 180000,
}) {
  if (!db || !vault || typeof fetchBroker !== 'function') throw new Error('SD requires database, vault and fetch.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('SD batch size must be an integer between 1 and 1000.');
  // The strategy module is Workstream 1's deliverable; tests may inject a mock.
  const rules = strategy || require('./sd-strategy');
  const scanBatch = Math.min(batchSize, SCAN_BATCH);
  let timer = null;
  let running = false;
  let generation = 0;
  let ticking = false;
  let activeTick = null;
  const timestamp = () => new Date(now()).toISOString();

  // ---------------------------------------------------------------------------
  // Schema. Canonical SD tables first, then the shared intent/ownership tables
  // (IF NOT EXISTS so a cold start works without B2), then working columns
  // that mirror b2-service's ALTER TABLE evolution pattern.
  // ---------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS sd_settings(
      user_id TEXT PRIMARY KEY, enabled INT DEFAULT 0, mode TEXT DEFAULT 'paper', paper INT DEFAULT 1,
      single_target_pct REAL DEFAULT 1.0, double_target_pct REAL DEFAULT 2.0, partial_sell_pct REAL DEFAULT 50,
      min_quality_score INT DEFAULT 7, max_risk_per_trade REAL DEFAULT 250, max_daily_loss REAL DEFAULT 500,
      max_open_positions INT DEFAULT 3, max_total_exposure REAL DEFAULT 5000, max_trades_per_day INT DEFAULT 10,
      max_position_dollars REAL DEFAULT 2000, eod_flatten INT DEFAULT 1, revision INT DEFAULT 1,
      automation_revision INT DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sd_credentials(
      user_id TEXT, mode TEXT, key_enc TEXT, secret_enc TEXT, updated_at TEXT, PRIMARY KEY(user_id, mode));
    CREATE TABLE IF NOT EXISTS sd_trades(
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, symbol TEXT, event_id TEXT, side TEXT DEFAULT 'long',
      status TEXT DEFAULT 'pending', setup TEXT, quality_score INT, entry_price REAL, filled_shares REAL DEFAULT 0,
      stop_price REAL, single_target REAL, double_target REAL, partial_taken INT DEFAULT 0, exit_price REAL,
      pnl REAL, exit_reason TEXT, client_id TEXT, signal_date TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT,
      UNIQUE(account_id, symbol, event_id));
    CREATE TABLE IF NOT EXISTS sd_exit_fills(
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INT, fill_price REAL, fill_qty REAL, proceeds REAL, filled_at TEXT);
    CREATE TABLE IF NOT EXISTS sd_close_attempts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INT, attempt TEXT, result TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sd_scan_runs(
      run_id TEXT PRIMARY KEY, started_at TEXT, symbols_scanned INT DEFAULT 0, liquidity_pass INT DEFAULT 0,
      momentum_pass INT DEFAULT 0, vwap_pass INT DEFAULT 0, quality_score_pass INT DEFAULT 0, risk_pass INT DEFAULT 0,
      orders_attempted INT DEFAULT 0, orders_accepted INT DEFAULT 0, orders_rejected INT DEFAULT 0,
      orders_filled INT DEFAULT 0, positions_opened INT DEFAULT 0, positions_closed INT DEFAULT 0,
      winning_trades INT DEFAULT 0, losing_trades INT DEFAULT 0, realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sd_rejections(
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, symbol TEXT, stage TEXT, reason TEXT);
    CREATE TABLE IF NOT EXISTS sd_candidates(
      symbol TEXT PRIMARY KEY, outcome TEXT, score INT, setup TEXT, gates TEXT, reasons TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS sd_universe(
      symbol TEXT PRIMARY KEY, name TEXT, price REAL, avg_volume REAL, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS sd_coverage(
      id INT PRIMARY KEY CHECK(id=1), cursor TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS sd_leases(
      user_id TEXT PRIMARY KEY, token TEXT, generation INT DEFAULT 1, expires_at TEXT);
    CREATE TABLE IF NOT EXISTS sd_alerts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, message TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS automated_action_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      purpose TEXT NOT NULL,
      client_order_id TEXT,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'prepared',
      broker_order_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS broker_account_owners (
      account_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, scope TEXT NOT NULL,
      mode TEXT NOT NULL, claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS broker_account_quarantine (
      account_id TEXT PRIMARY KEY, reason TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
    );
  `);
  // Working columns for the broker order lifecycle, added the same way
  // b2-service evolves b2_settings/b2_trades. Canonical DDL stays untouched.
  const tradeColumns = new Set(db.prepare('PRAGMA table_info(sd_trades)').all().map(row => row.name));
  for (const [column, definition] of [
    ['order_id', 'TEXT'], ['stop_id', 'TEXT'], ['exit_client_id', 'TEXT'], ['exit_id', 'TEXT'],
    ['protection', "TEXT DEFAULT 'unknown'"],
  ]) {
    if (!tradeColumns.has(column)) db.exec(`ALTER TABLE sd_trades ADD COLUMN ${column} ${definition}`);
  }
  const settingsColumns = new Set(db.prepare('PRAGMA table_info(sd_settings)').all().map(row => row.name));
  for (const [column, definition] of [
    ['live_armed', 'INTEGER NOT NULL DEFAULT 0'], ['last_cycle_at', 'TEXT'],
    ['scheduler_status', "TEXT NOT NULL DEFAULT 'idle'"], ['scheduler_reason', 'TEXT'],
    ['data_feed', "TEXT NOT NULL DEFAULT 'sip'"], ['data_error', 'TEXT'],
    ['market_open', 'INTEGER'], ['market_clock_at', 'INTEGER'],
  ]) {
    if (!settingsColumns.has(column)) db.exec(`ALTER TABLE sd_settings ADD COLUMN ${column} ${definition}`);
  }
  db.prepare("UPDATE sd_settings SET data_feed='sip' WHERE data_feed IS NULL OR data_feed NOT IN ('sip','iex')").run();

  const sdUserId = uid => String(uid);
  const getSettings = uid => db.prepare('SELECT * FROM sd_settings WHERE user_id=?').get(sdUserId(uid));
  function ensure(uid) {
    db.prepare('INSERT OR IGNORE INTO sd_settings(user_id) VALUES (?)').run(sdUserId(uid));
    return getSettings(uid);
  }
  // Credentials live per (user, mode) in sd_credentials; the broker account
  // identity comes from the dedicated broker_account_owners row with
  // scope='singles_doubles'. A missing or half-encrypted row fails closed.
  function credential(uid, mode) {
    const row = db.prepare(`SELECT c.user_id, c.mode, c.key_enc, c.secret_enc, c.updated_at, o.account_id
      FROM sd_credentials c
      LEFT JOIN broker_account_owners o
        ON o.account_id IS NOT NULL AND o.user_id=? AND o.scope=? AND o.mode=c.mode
      WHERE c.user_id=? AND c.mode=?`).get(Number(uid), SCOPE, sdUserId(uid), mode);
    if (!row) return null;
    if (!vault.isEncrypted(row.key_enc) || !vault.isEncrypted(row.secret_enc)) return null;
    if (!row.account_id) return null;
    return row;
  }
  const unresolvedByAccount = account =>
    db.prepare("SELECT * FROM sd_trades WHERE account_id=? AND status NOT IN ('closed','rejected','canceled') ORDER BY id").all(account);
  const quarantined = account =>
    !!db.prepare('SELECT 1 FROM broker_account_quarantine WHERE account_id=? AND resolved_at IS NULL').get(account);
  function alert(uid, kind, message) {
    // Messages are fixed application text, never upstream error bodies or credentials.
    const previous = db.prepare('SELECT kind,message,created_at FROM sd_alerts WHERE user_id=? ORDER BY id DESC LIMIT 1').get(sdUserId(uid));
    if (previous?.kind === kind && previous.message === message && now() - Date.parse(previous.created_at) < 300000) return;
    db.prepare('INSERT INTO sd_alerts(user_id,kind,message,created_at) VALUES (?,?,?,?)')
      .run(sdUserId(uid), kind, message, timestamp());
  }
  function coverage() {
    const row = db.prepare('SELECT * FROM sd_coverage WHERE id=1').get();
    const total = db.prepare('SELECT COUNT(*) AS n FROM sd_universe').get()?.n || 0;
    return { cursor: parseInt(row?.cursor || '0', 10) || 0, symbolsScanned: total,
      updatedAt: row?.updated_at || null, batchSize: scanBatch };
  }

  // ---------------------------------------------------------------------------
  // Operation lease. One durable lease per user; guard() renews it before any
  // broker action so a lost lease withholds work instead of double-acting.
  // ---------------------------------------------------------------------------
  async function locked(uid, work) {
    const token = crypto.randomUUID();
    const expiry = new Date(now() + leaseMs).toISOString();
    const result = db.prepare(`INSERT INTO sd_leases(user_id,token,generation,expires_at) VALUES (?,?,1,?)
      ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,generation=sd_leases.generation+1,expires_at=excluded.expires_at
      WHERE sd_leases.expires_at<=?`).run(sdUserId(uid), token, expiry, timestamp());
    if (!result.changes) throw new SdError('Singles & Doubles is reconciling this account. Retry shortly.');
    const lease = { uid, token, generation };
    try { return await work(lease); }
    finally {
      db.prepare('DELETE FROM sd_leases WHERE user_id=? AND token=?').run(sdUserId(uid), token);
      if (durability?.flush && persistenceReady()) await durability.flush('sd-operation');
    }
  }
  function guard(lease) {
    const renewed = db.prepare('UPDATE sd_leases SET expires_at=?,generation=generation+1 WHERE user_id=? AND token=? AND expires_at>?')
      .run(new Date(now() + leaseMs).toISOString(), sdUserId(lease.uid), lease.token, timestamp());
    if (!renewed.changes) throw new SdError('Singles & Doubles lease expired; broker action withheld.');
  }
  function context(uid, lease, mode) {
    const settings = ensure(uid);
    const cred = credential(uid, mode || settings.mode);
    if (!cred) throw new SdError('Connect a dedicated Singles & Doubles broker account.');
    return { uid, lease, settings, cred };
  }

  // ---------------------------------------------------------------------------
  // Authorization. Returns {ok} or {ok:false, blocker} so callers can surface
  // the blocker; assertAuthorized() converts a denial into a thrown SdError.
  // Fail-closed ordering: lease -> persistence (entries) -> credentials ->
  // ownership -> enabled (entries) -> live arming (entries).
  // ---------------------------------------------------------------------------
  function authorize(ctx, entry = false) {
    guard(ctx.lease);
    const fail = blocker => ({ ok: false, blocker });
    if (entry && !persistenceReady()) {
      return fail('Automated trading persistence is unavailable; broker entry withheld.');
    }
    const current = getSettings(ctx.uid);
    const cred = credential(ctx.uid, ctx.cred.mode);
    if (!cred || cred.account_id !== ctx.cred.account_id || cred.key_enc !== ctx.cred.key_enc ||
        cred.secret_enc !== ctx.cred.secret_enc || current.revision !== ctx.settings.revision) {
      return fail('Singles & Doubles authorization changed; action withheld.');
    }
    const owner = db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (!owner || owner.scope !== SCOPE || Number(owner.user_id) !== Number(ctx.uid) ||
        owner.mode !== cred.mode || quarantined(cred.account_id)) {
      return fail('Singles & Doubles broker account ownership is not verified.');
    }
    if (!entry) return { ok: true };
    if (!current.enabled) return fail('Automation is paused.');
    if (!running || ctx.lease.generation !== generation ||
        current.automation_revision !== ctx.settings.automation_revision ||
        current.mode !== cred.mode ||
        (current.mode === 'live' && (!current.live_armed ||
          (automaticBotSettings && automaticBotSettings.owner(ctx.uid)?.strategy !== STRATEGY_KEY)))) {
      return fail('Singles & Doubles entries are paused or live trading is not armed.');
    }
    return { ok: true };
  }
  function assertAuthorized(ctx, entry = false) {
    const result = authorize(ctx, entry);
    if (!result.ok) throw new SdError(result.blocker);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Broker transport: raw fetch against the Alpaca REST + market-data hosts,
  // per-call decrypted credentials, 10s abort timeout, and the durable intent
  // ledger. Mutating calls are never retried after a timeout: they land in
  // 'submission_unknown' and are reconciled by client order ID.
  // ---------------------------------------------------------------------------
  async function request(cred, path, { method = 'GET', body, data = false, allow404 = false, ctx, entry = false,
    entitlementProbe = false } = {}) {
    if (ctx) {
      guard(ctx.lease);
      if (method !== 'GET') assertAuthorized(ctx, entry);
    }
    if (method !== 'GET' && durability?.flush) {
      if (ctx) {
        const clientOrderId = body?.client_order_id || body?.client_order_idempotency_key || null;
        const purpose = path.includes('orders')
          ? (body?.side === 'buy' ? 'entry' : body?.type === 'stop' ? 'protection' : 'exit')
          : 'broker-action';
        const intent = db.prepare(`
          INSERT INTO automated_action_intents
            (strategy,user_id,account_id,mode,method,path,purpose,client_order_id,request_json,state,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'prepared',datetime('now'))
        `).run(STRATEGY_KEY, Number(ctx.uid), cred.account_id, cred.mode, method, path, purpose,
          clientOrderId, JSON.stringify(body || {}));
        ctx.actionIntentId = intent.lastInsertRowid;
      }
      await durability.flush(`sd-before-${method.toLowerCase()}`);
      if (ctx) assertAuthorized(ctx, entry);
    }
    const controller = new AbortController();
    let timeout;
    try {
      const call = (async () => {
        const response = await fetchBroker(`${data ? DATA : cred.mode === 'live' ? LIVE : PAPER}${path}`, {
          method, signal: controller.signal,
          headers: { 'APCA-API-KEY-ID': vault.decrypt(cred.key_enc), 'APCA-API-SECRET-KEY': vault.decrypt(cred.secret_enc), 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (allow404 && response.status === 404) return null;
        if (!response.ok) {
          if (data && ctx && !entitlementProbe && [401, 403, 422].includes(response.status)) {
            const feed = /(?:^|[?&])feed=(sip|iex)(?:&|$)/.exec(path)?.[1] || 'sip';
            const message = response.status === 401
              ? `Alpaca ${feed.toUpperCase()} market-data permission was rejected (HTTP 401).`
              : response.status === 403 && feed === 'sip'
                ? 'Consolidated SIP market data entitlement is required.'
                : response.status === 403
                  ? 'Alpaca IEX market data is unavailable (HTTP 403).'
                  : `Alpaca ${feed.toUpperCase()} market-data request was rejected (HTTP ${response.status}).`;
            db.prepare('UPDATE sd_settings SET data_error=? WHERE user_id=?').run(message, sdUserId(ctx.uid));
          }
          const failure = new SdError(`Broker request failed (HTTP ${response.status}); action withheld.`, 502);
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
        timeout = setTimeout(() => { controller.abort(); reject(new SdError('Broker request timed out; reconciliation required.', 502)); }, timeoutMs);
      })]);
      if (ctx) guard(ctx.lease);
      if (method !== 'GET' && durability?.flush) {
        if (ctx?.actionIntentId) db.prepare(`
          UPDATE automated_action_intents SET state='submitted', broker_order_id=?, updated_at=datetime('now')
          WHERE id=?
        `).run(result?.id || null, ctx.actionIntentId);
        await durability.flush(`sd-after-${method.toLowerCase()}`);
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
        try { await durability.flush(`sd-unknown-${method.toLowerCase()}`); } catch (_) {}
      }
      if (error instanceof SdError) throw error;
      throw new SdError('Broker connection or response failed; action withheld.', 502);
    } finally { clearTimeout(timeout); }
  }
  async function broker(ctx, path, options = {}) {
    const isClock = path === '/v2/clock';
    if (isClock) db.prepare('UPDATE sd_settings SET market_open=NULL,market_clock_at=NULL WHERE user_id=?').run(sdUserId(ctx.uid));
    const result = await request(ctx.cred, path, { ...options, ctx });
    if (isClock) {
      const time = Date.parse(result?.timestamp);
      if (!Number.isFinite(time) || now() - time > 120000 || time - now() > 5000 || typeof result?.is_open !== 'boolean') {
        throw new SdError('Broker clock is missing or stale.');
      }
      db.prepare('UPDATE sd_settings SET market_open=?,market_clock_at=? WHERE user_id=?').run(Number(result.is_open), time, sdUserId(ctx.uid));
    }
    return result;
  }
  function validateAccount(account, expected) {
    if (typeof account?.id !== 'string' || !account.id.trim() || (expected && account.id !== expected) || account.status !== 'ACTIVE' ||
        account.trading_blocked || account.account_blocked || account.trade_suspended_by_user) {
      throw new SdError('Broker account identity or trading permission is not valid.');
    }
  }
  async function assertEmpty(ctx) {
    if (unresolvedByAccount(ctx.cred.account_id).length) throw new SdError('Resolve all Singles & Doubles orders and positions before changing the connection.');
    const positions = await broker(ctx, '/v2/positions');
    const orders = await broker(ctx, '/v2/orders?status=open&limit=500&nested=true');
    if (!Array.isArray(positions) || !Array.isArray(orders)) throw new SdError('Broker lifecycle data is missing.');
    if (positions.length || orders.length) throw new SdError('Broker positions or orders remain. Connection change blocked.');
    guard(ctx.lease);
  }
  function release(uid, cred) {
    if (!cred) return;
    const remaining = db.prepare('SELECT 1 FROM sd_credentials WHERE user_id=?').get(sdUserId(uid));
    if (!remaining) db.prepare("DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope=?")
      .run(cred.account_id, Number(uid), SCOPE);
  }
  function validateInput(input, allowed, message) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowed.includes(key))) throw new SdError(message, 400);
    if (input.authorizeLive !== undefined && typeof input.authorizeLive !== 'boolean') {
      throw new SdError('authorizeLive must be boolean.', 400);
    }
  }
  function assertActivationUnchanged(uid, settings) {
    const current = getSettings(uid);
    if (current.revision !== settings.revision || current.automation_revision !== settings.automation_revision) {
      throw new SdError('Singles & Doubles authorization changed; activation withheld.');
    }
  }
  function publicSettings(uid) {
    const s = getSettings(uid) || {};
    // Desk defaults: pre-fill the UI so a fresh user is never left guessing.
    // 1% single / 2% double / half off at T1, 7/12 quality bar, $250 risk per
    // trade (1% of a $25k account), $500 daily stop (2R), 3 concurrent max,
    // $5k total exposure, 10 trades/day, $2k per position.
    const SETTING_DEFAULTS = {
      single_target_pct: 1.0, double_target_pct: 2.0, partial_sell_pct: 50,
      min_quality_score: 7, max_risk_per_trade: 250, max_daily_loss: 500,
      max_open_positions: 3, max_total_exposure: 5000, max_trades_per_day: 10,
      max_position_dollars: 2000, eod_flatten: 1,
    };
    const pick = key => (s[key] == null ? SETTING_DEFAULTS[key] : s[key]);
    return {
      single_target_pct: pick('single_target_pct'), double_target_pct: pick('double_target_pct'),
      partial_sell_pct: pick('partial_sell_pct'), min_quality_score: pick('min_quality_score'),
      max_risk_per_trade: pick('max_risk_per_trade'), max_daily_loss: pick('max_daily_loss'),
      max_open_positions: pick('max_open_positions'), max_total_exposure: pick('max_total_exposure'),
      max_trades_per_day: pick('max_trades_per_day'), max_position_dollars: pick('max_position_dollars'),
      eod_flatten: s.eod_flatten == null ? true : !!s.eod_flatten,
      enabled: !!s.enabled, mode: s.mode || 'paper',
      paper: (s.mode || 'paper') === 'paper', live_armed: !!s.live_armed, revision: s.revision,
    };
  }

  // ---------------------------------------------------------------------------
  // Connection and settings management.
  // ---------------------------------------------------------------------------
  async function setCredentials(uid, input) {
    if (!persistenceReady()) throw new SdError('Automated trading persistence is unavailable; Singles & Doubles entries remain paused. Publish the database schema before connecting.', 503);
    // The UI contract sends {key, secret}; tolerate the apiKey/apiSecret shape too.
    validateInput(input, ['mode', 'key', 'secret', 'apiKey', 'apiSecret'], 'Only mode, API key and API secret may be supplied.');
    const mode = input?.mode ?? getSettings(uid)?.mode ?? 'paper';
    const apiKey = input?.apiKey ?? input?.key;
    const apiSecret = input?.apiSecret ?? input?.secret;
    if (!['paper', 'live'].includes(mode) || typeof apiKey !== 'string' ||
        typeof apiSecret !== 'string' || !apiKey.trim() || !apiSecret.trim() ||
        apiKey.length > 512 || apiSecret.length > 512) throw new SdError('Valid mode, API key and secret are required.', 400);
    return locked(uid, async lease => {
      const settings = ensure(uid);
      if (unresolvedByAccount(credential(uid, settings.mode)?.account_id || '').length &&
          credential(uid, settings.mode)) throw new SdError('Resolve all Singles & Doubles orders and positions before replacing credentials.');
      for (const row of db.prepare('SELECT mode FROM sd_credentials WHERE user_id=?').all(sdUserId(uid))) {
        await assertEmpty(context(uid, lease, row.mode));
      }
      const next = { mode, key_enc: vault.encrypt(apiKey.trim()), secret_enc: vault.encrypt(apiSecret.trim()) };
      const account = await request(next, '/v2/account');
      validateAccount(account);
      guard(lease);
      db.transaction(() => {
        assertActivationUnchanged(uid, settings);
        if (quarantined(account.id)) throw new SdError('Broker account is quarantined.');
        const owner = db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at)
          VALUES (?,?,?, ?,?) ON CONFLICT(account_id) DO UPDATE SET claimed_at=excluded.claimed_at
          WHERE broker_account_owners.user_id=excluded.user_id AND broker_account_owners.scope=?
            AND broker_account_owners.mode=excluded.mode`).run(account.id, Number(uid), SCOPE, mode, timestamp(), SCOPE);
        if (!owner.changes) throw new SdError('This broker account is already assigned to another user, mode or trading scope.');
        const old = credential(uid, mode);
        db.prepare(`INSERT INTO sd_credentials(user_id,mode,key_enc,secret_enc,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(user_id,mode) DO UPDATE SET key_enc=excluded.key_enc,secret_enc=excluded.secret_enc,updated_at=excluded.updated_at`)
          .run(sdUserId(uid), mode, next.key_enc, next.secret_enc, timestamp());
        release(uid, old && { account_id: old.account_id });
        db.prepare(`UPDATE sd_settings SET mode=?,enabled=?,live_armed=0,data_feed='sip',revision=revision+1,
           market_open=NULL,market_clock_at=NULL,scheduler_status='idle',scheduler_reason=NULL,data_error=NULL WHERE user_id=?`)
          .run(mode, 0, sdUserId(uid)); // Never auto-enable: the user must explicitly start automation.
        automaticBotSettings?.revoke(uid, STRATEGY_KEY);
      })();
      return { ok: true };
    });
  }
  async function disconnect(uid) {
    return locked(uid, async lease => {
      ensure(uid);
      const creds = db.prepare('SELECT mode FROM sd_credentials WHERE user_id=?').all(sdUserId(uid));
      for (const row of creds) {
        const cred = credential(uid, row.mode);
        if (cred && unresolvedByAccount(cred.account_id).length) {
          throw new SdError('Resolve all Singles & Doubles orders and positions before disconnecting.');
        }
        await assertEmpty(context(uid, lease, row.mode));
      }
      db.transaction(() => {
        db.prepare('DELETE FROM sd_credentials WHERE user_id=?').run(sdUserId(uid));
        creds.forEach(row => {
          const owner = db.prepare('SELECT account_id FROM broker_account_owners WHERE user_id=? AND scope=? AND mode=?')
            .get(Number(uid), SCOPE, row.mode);
          if (owner) release(uid, owner);
        });
        db.prepare("UPDATE sd_settings SET enabled=0,live_armed=0,data_feed='sip',market_open=NULL,market_clock_at=NULL,revision=revision+1 WHERE user_id=?")
          .run(sdUserId(uid));
        automaticBotSettings?.revoke(uid, STRATEGY_KEY);
      })();
      return { ok: true };
    });
  }
  async function setMode(uid, input) {
    validateInput(input, ['mode', 'authorizeLive'], 'Only mode and live authorization may be supplied.');
    const { mode } = input;
    if (!['paper', 'live'].includes(mode)) throw new SdError('Mode must be paper or live.', 400);
    return locked(uid, async lease => {
      const current = ensure(uid);
      const currentCred = credential(uid, current.mode);
      if (currentCred && unresolvedByAccount(currentCred.account_id).length) {
        throw new SdError('Resolve all Singles & Doubles orders and positions before switching modes.');
      }
      if (currentCred) await assertEmpty(context(uid, lease));
      const saved = credential(uid, mode);
      if (saved) {
        const ctx = context(uid, lease, mode);
        assertAuthorized(ctx);
        validateAccount(await broker(ctx, '/v2/account'), saved.account_id);
        if (mode !== current.mode) await assertEmpty(ctx);
        assertAuthorized(ctx);
      }
      assertActivationUnchanged(uid, current);
      db.prepare(`UPDATE sd_settings SET mode=?,enabled=?,live_armed=0,data_feed='sip',revision=revision+1,
         market_open=NULL,market_clock_at=NULL,scheduler_status='idle',scheduler_reason=NULL,data_error=NULL WHERE user_id=?`)
        .run(mode, 0, sdUserId(uid)); // Never auto-enable: the user must explicitly start automation.
      automaticBotSettings?.revoke(uid, STRATEGY_KEY);
      return { ok: true, mode };
    });
  }
  const SETTING_LIMITS = {
    single_target_pct: [0.75, 1.25], double_target_pct: [1.5, 3.0], partial_sell_pct: [10, 100],
    min_quality_score: [1, 12], max_risk_per_trade: [1, 1000000], max_daily_loss: [1, 1000000],
    max_open_positions: [1, 10], max_total_exposure: [100, 100000000], max_trades_per_day: [1, 50],
    max_position_dollars: [1, 100000000], eod_flatten: [0, 1],
  };
  async function setSettings(uid, input) {
    const allowed = Object.keys(SETTING_LIMITS);
    validateInput(input, allowed, 'Only Singles & Doubles strategy settings may be changed.');
    const updates = {};
    for (const key of allowed) {
      if (input[key] === undefined) continue;
      let value = input[key];
      if (key === 'eod_flatten') {
        if (value === true) value = 1;
        else if (value === false) value = 0;
      }
      const [lo, hi] = SETTING_LIMITS[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi ||
          (['min_quality_score', 'max_open_positions', 'max_trades_per_day', 'eod_flatten'].includes(key) && !Number.isInteger(value))) {
        throw new SdError(`${key} must be between ${lo} and ${hi}.`, 400);
      }
      updates[key] = value;
    }
    if (!Object.keys(updates).length) throw new SdError('No recognized settings were supplied.', 400);
    return locked(uid, async () => {
      ensure(uid);
      const assignments = Object.keys(updates).map(key => `${key}=?`).join(',');
      db.prepare(`UPDATE sd_settings SET ${assignments},revision=revision+1 WHERE user_id=?`)
        .run(...Object.values(updates), sdUserId(uid));
      return { ok: true, settings: publicSettings(uid) };
    });
  }
  async function setAutomation(uid, input) {
    validateInput(input, ['action', 'authorizeLive'], 'Only action and live authorization may be supplied.');
    if (!['pause', 'resume'].includes(input.action)) throw new SdError('Action must be pause or resume.', 400);
    if (input.action === 'resume' && !persistenceReady()) {
      throw new SdError('Automated trading persistence is unavailable; Singles & Doubles entries remain paused. Publish the database schema before resuming.', 503);
    }
    if (input.action === 'pause') {
      ensure(uid);
      // Emergency entry revocation must not wait for a scan's lease or invalidate
      // its protective actions. Pending activation attempts observe this revision.
      db.prepare(`UPDATE sd_settings SET enabled=0,live_armed=0,automation_revision=automation_revision+1,
        scheduler_status='paused',scheduler_reason='Paused; owned trades still reconciled.' WHERE user_id=?`).run(sdUserId(uid));
      automaticBotSettings?.revoke(uid, STRATEGY_KEY);
      if (durability?.flush) await durability.flush('sd-paused');
      return { ok: true, enabled: false };
    }
    return locked(uid, async lease => {
      const ctx = context(uid, lease);
      if (ctx.settings.mode === 'live' && input.authorizeLive !== true) {
        throw new SdError('Live automation requires fresh explicit authorization.', 400);
      }
      assertAuthorized(ctx);
      validateAccount(await broker(ctx, '/v2/account'), ctx.cred.account_id);
      assertAuthorized(ctx);
      assertActivationUnchanged(uid, ctx.settings);
      const activate = () => db.prepare(`UPDATE sd_settings SET enabled=1,live_armed=?,revision=revision+1,
        scheduler_status='idle',scheduler_reason=NULL WHERE user_id=?`).run(Number(ctx.settings.mode === 'live'), sdUserId(uid));
      if (ctx.settings.mode === 'live' && automaticBotSettings) {
        try {
          automaticBotSettings.arm(uid, STRATEGY_KEY, activate);
        } catch (error) {
          // The shared registry only knows the strategies it was built with.
          // A missing registration fails closed: live can never arm silently.
          throw new SdError(`Live arming is unavailable: ${error.message}`, 409);
        }
      } else activate();
      return { ok: true, enabled: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Read endpoints.
  // ---------------------------------------------------------------------------
  function fleetStatus(uid, settings) {
    const liveOwner = automaticBotSettings?.owner(uid)?.strategy || null;
    try {
      const fleet = automaticBotSettings?.status(uid, STRATEGY_KEY, {
        mode: settings.mode, enabled: !!settings.enabled, liveArmed: !!settings.live_armed,
      });
      if (fleet) return { posture: fleet.posture, liveOwner: fleet.liveOwner };
    } catch (_) {
      // The shared registry predates this strategy; fall back to local posture.
    }
    let posture = 'paused';
    if (settings.enabled && settings.mode === 'paper') posture = 'active';
    else if (settings.enabled && settings.mode === 'live' && settings.live_armed && liveOwner === STRATEGY_KEY) posture = 'live-armed';
    else if (settings.mode === 'live' && liveOwner && liveOwner !== STRATEGY_KEY) posture = 'shadowing';
    return { posture, liveOwner };
  }
  function status(uid) {
    const settings = getSettings(uid) || { mode: 'paper', enabled: 0, live_armed: 0 };
    const cred = credential(uid, settings.mode);
    const clockAge = settings.market_clock_at == null ? NaN : now() - settings.market_clock_at;
    const blockers = [];
    if (!persistenceReady()) blockers.push('Durable automated-trading PostgreSQL schema is unavailable; new entries are withheld.');
    if (!cred) blockers.push('Connect a dedicated Singles & Doubles broker account.');
    if (!settings.enabled) blockers.push('Automation is paused.');
    if (settings.mode === 'live' && !settings.live_armed) blockers.push('Live trading requires explicit arming.');
    if (settings.mode === 'live' && settings.live_armed && automaticBotSettings?.owner(uid)?.strategy !== STRATEGY_KEY) {
      blockers.push('Another strategy owns this user’s Live authorization.');
    }
    if (cred && quarantined(cred.account_id)) blockers.push('Broker account is quarantined.');
    const owner = cred && db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (cred && (!owner || Number(owner.user_id) !== Number(uid) || owner.scope !== SCOPE || owner.mode !== cred.mode)) {
      blockers.push('Broker account ownership is not verified.');
    }
    if (cred && unresolvedByAccount(cred.account_id).some(t => t.protection !== 'protected' || t.exit_client_id)) {
      blockers.push('An order or protective stop requires reconciliation.');
    }
    if (settings.scheduler_status === 'error') blockers.push(settings.scheduler_reason || 'Broker reconciliation failed.');
    if (settings.data_error) blockers.push(settings.data_error);
    const marketOpen = Number.isFinite(clockAge) && clockAge >= -5000 && clockAge <= 120000 && settings.market_open != null
      ? !!settings.market_open : null;
    const fleet = fleetStatus(uid, settings);
    const effectiveRules = { ...(rules.SD_RULES || {}), ...publicSettings(uid) };
    const funnel = db.prepare('SELECT * FROM sd_scan_runs ORDER BY started_at DESC LIMIT 1').get() || null;
    return {
      ok: true,
      enabled: !!settings.enabled,
      mode: settings.mode || 'paper',
      paper: (settings.mode || 'paper') === 'paper',
      posture: fleet.posture,
      liveOwner: fleet.liveOwner,
      blockers,
      marketOpen,
      scheduler: { running, lastTickAt: settings.last_cycle_at || null,
        status: settings.scheduler_status || 'idle', reason: settings.scheduler_reason || null },
      coverage: coverage(),
      rules: effectiveRules,
      liquidityPolicy: DEFAULT_LIQUIDITY_POLICY,
      funnel,
    };
  }
  function funnel() {
    const run = db.prepare('SELECT * FROM sd_scan_runs ORDER BY started_at DESC LIMIT 1').get() || null;
    const topRejections = run ? db.prepare(`SELECT stage, reason, COUNT(*) AS count FROM sd_rejections
      WHERE run_id=? GROUP BY stage, reason ORDER BY count DESC LIMIT 15`).all(run.run_id) : [];
    return { run, topRejections };
  }
  function trades(uid) {
    const cred = credential(uid, (getSettings(uid) || {}).mode || 'paper');
    const rows = cred ? db.prepare(`SELECT id, account_id, symbol, event_id, side, status, setup, quality_score,
      entry_price, filled_shares, stop_price, single_target, double_target, partial_taken, exit_price, pnl,
      exit_reason, client_id, signal_date, created_at, updated_at
      FROM sd_trades WHERE account_id=? ORDER BY id DESC LIMIT 500`).all(cred.account_id) : [];
    return { trades: rows };
  }
  function stats(uid) {
    const settings = getSettings(uid) || {};
    const cred = credential(uid, settings.mode || 'paper');
    const label = settings.mode === 'live' && settings.live_armed ? 'LIVE' : 'PAPER';
    const empty = { label, trades: 0, winRate: 0, avgWinner: 0, avgLoser: 0, profitFactor: 0,
      totalRealizedPnl: 0, avgPnlPerTrade: 0, largestWin: 0, largestLoss: 0, avgHoldingMinutes: 0,
      singlesHit: 0, doublesHit: 0, stopOuts: 0, rejectedSignals: 0, ordersRejected: 0, openPositions: 0 };
    if (!cred) return empty;
    const closed = db.prepare(`SELECT pnl, partial_taken, exit_reason, created_at, updated_at
      FROM sd_trades WHERE account_id=? AND status='closed'`).all(cred.account_id);
    // Definitions: trades = closed trades. winRate = winners / closed.
    // singlesHit = trades where a partial profit was taken. doublesHit =
    // closed with exit_reason='double_target'. stopOuts = closed with
    // exit_reason='stop'. rejectedSignals = sd_rejections rows (all runs).
    // ordersRejected = journal rows in terminal 'rejected' state.
    const winners = closed.filter(t => number(t.pnl) > 0);
    const losers = closed.filter(t => number(t.pnl) < 0);
    const grossWin = winners.reduce((sum, t) => sum + number(t.pnl), 0);
    const grossLoss = losers.reduce((sum, t) => sum + number(t.pnl), 0);
    const totalRealizedPnl = closed.reduce((sum, t) => sum + (Number.isFinite(number(t.pnl)) ? number(t.pnl) : 0), 0);
    const holdings = closed
      .map(t => (Date.parse(t.updated_at) - Date.parse(t.created_at)) / 60000)
      .filter(Number.isFinite);
    return {
      label,
      trades: closed.length,
      winRate: closed.length ? winners.length / closed.length : 0,
      avgWinner: winners.length ? grossWin / winners.length : 0,
      avgLoser: losers.length ? grossLoss / losers.length : 0,
      profitFactor: grossLoss !== 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? grossWin : 0),
      totalRealizedPnl,
      avgPnlPerTrade: closed.length ? totalRealizedPnl / closed.length : 0,
      largestWin: winners.length ? Math.max(...winners.map(t => number(t.pnl))) : 0,
      largestLoss: losers.length ? Math.min(...losers.map(t => number(t.pnl))) : 0,
      avgHoldingMinutes: holdings.length ? holdings.reduce((a, b) => a + b, 0) / holdings.length : 0,
      singlesHit: db.prepare("SELECT COUNT(*) n FROM sd_trades WHERE account_id=? AND partial_taken=1").get(cred.account_id)?.n || 0,
      doublesHit: db.prepare("SELECT COUNT(*) n FROM sd_trades WHERE account_id=? AND status='closed' AND exit_reason='double_target'").get(cred.account_id)?.n || 0,
      stopOuts: db.prepare("SELECT COUNT(*) n FROM sd_trades WHERE account_id=? AND status='closed' AND exit_reason='stop'").get(cred.account_id)?.n || 0,
      rejectedSignals: db.prepare('SELECT COUNT(*) n FROM sd_rejections').get()?.n || 0,
      ordersRejected: db.prepare("SELECT COUNT(*) n FROM sd_trades WHERE account_id=? AND status='rejected'").get(cred.account_id)?.n || 0,
      openPositions: unresolvedByAccount(cred.account_id).filter(t => ['open', 'partial'].includes(t.status)).length,
    };
  }
  function alerts(uid) {
    return { alerts: db.prepare('SELECT kind,message,created_at AS createdAt FROM sd_alerts WHERE user_id=? ORDER BY id DESC LIMIT 200').all(sdUserId(uid)) };
  }
  function candidates() {
    const rows = db.prepare('SELECT symbol,outcome,score,setup,gates,reasons,updated_at FROM sd_candidates ORDER BY symbol').all()
      .map(row => ({ ...row, gates: safeJson(row.gates, []), reasons: safeJson(row.reasons, []) }));
    return { candidates: rows, coverage: coverage() };
  }
  function safeJson(value, fallback) {
    try { const parsed = JSON.parse(value); return parsed == null ? fallback : parsed; }
    catch (_) { return fallback; }
  }

  // ---------------------------------------------------------------------------
  // Market data. One feed is resolved per cycle (SIP probed first; only Paper
  // may fall back to IEX on a 403; Live is SIP-only fail-closed), then reused
  // for every bars/snapshot call in the cycle.
  // ---------------------------------------------------------------------------
  async function market(ctx) {
    const clock = await broker(ctx, '/v2/clock');
    const brokerNow = Date.parse(clock?.timestamp);
    if (!Number.isFinite(brokerNow) || Math.abs(now() - brokerNow) > 120000 || typeof clock.is_open !== 'boolean') {
      throw new SdError('Broker clock is missing or stale.');
    }
    return { clock };
  }
  async function resolveFeed(ctx) {
    let saved = getSettings(ctx.uid)?.data_feed || 'sip';
    // Live is SIP-only. Never honor a stale persisted Paper fallback after
    // switching modes, including across a process restart.
    if (ctx.cred.mode === 'live' && saved === 'iex') {
      db.prepare("UPDATE sd_settings SET data_feed='sip' WHERE user_id=?").run(sdUserId(ctx.uid));
      saved = 'sip';
    }
    if (saved === 'iex') { ctx.feed = 'iex'; return ctx.feed; }
    const validProbe = probe => {
      const quote = probe?.latestQuote;
      const bid = number(quote?.bp);
      const ask = number(quote?.ap);
      const bidSize = number(quote?.bs);
      const askSize = number(quote?.as);
      const quoteTime = Date.parse(quote?.t);
      const maxAge = rules.SD_RULES?.maxQuoteAgeMs || 60000;
      return !!probe && typeof probe === 'object' && !Array.isArray(probe) &&
        quote && typeof quote === 'object' && !Array.isArray(quote) &&
        Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid &&
        Number.isFinite(bidSize) && Number.isFinite(askSize) && bidSize > 0 && askSize > 0 &&
        Number.isFinite(quoteTime) && quoteTime <= now() && now() - quoteTime <= maxAge &&
        easternDate(quoteTime) === easternDate(now());
    };
    let probe;
    try {
      probe = await request(ctx.cred, '/v2/stocks/SPY/snapshot?feed=sip', { data: true, ctx, entitlementProbe: true });
    } catch (error) {
      if (error.httpStatus === 403 && ctx.cred.mode === 'paper') {
        let iexProbe;
        try {
          iexProbe = await request(ctx.cred, '/v2/stocks/SPY/snapshot?feed=iex', { data: true, ctx, entitlementProbe: true });
        } catch (iexError) {
          const message = iexError.httpStatus
            ? `Alpaca IEX market-data probe was rejected (HTTP ${iexError.httpStatus}).`
            : 'Alpaca IEX market-data probe failed; feed selection withheld.';
          db.prepare('UPDATE sd_settings SET data_error=? WHERE user_id=?').run(message, sdUserId(ctx.uid));
          throw iexError;
        }
        if (!validProbe(iexProbe)) {
          db.prepare("UPDATE sd_settings SET data_error='Alpaca IEX market-data probe was malformed; feed selection withheld.' WHERE user_id=?")
            .run(sdUserId(ctx.uid));
          throw new SdError('IEX market data probe is malformed.');
        }
        db.prepare("UPDATE sd_settings SET data_feed='iex',data_error=NULL WHERE user_id=?").run(sdUserId(ctx.uid));
        ctx.feed = 'iex';
        return ctx.feed;
      }
      if (error.httpStatus === 403 && ctx.cred.mode === 'live') {
        db.prepare("UPDATE sd_settings SET data_error='Consolidated SIP market data entitlement is required.' WHERE user_id=?")
          .run(sdUserId(ctx.uid));
        throw new SdError('Consolidated SIP market data entitlement is required for Live Singles & Doubles; entries withheld.');
      }
      const message = error.httpStatus
        ? `Alpaca SIP market-data probe was rejected (HTTP ${error.httpStatus}).`
        : 'Alpaca SIP market-data probe failed; feed selection withheld.';
      db.prepare('UPDATE sd_settings SET data_error=? WHERE user_id=?').run(message, sdUserId(ctx.uid));
      throw error;
    }
    if (!validProbe(probe)) {
      db.prepare("UPDATE sd_settings SET data_error='Alpaca SIP market-data probe was malformed; feed selection withheld.' WHERE user_id=?")
        .run(sdUserId(ctx.uid));
      throw new SdError('Market data entitlement probe is malformed.');
    }
    ctx.feed = 'sip';
    return ctx.feed;
  }
  async function catalog(ctx) {
    const row = db.prepare('SELECT * FROM sd_coverage WHERE id=1').get();
    if (row && now() - Date.parse(row.updated_at) < 6 * 3600000) return;
    const assets = await broker(ctx, '/v2/assets?status=active&asset_class=us_equity');
    if (!Array.isArray(assets) || !assets.length) throw new SdError('Tradable asset universe is unavailable.');
    const eligible = [...new Map(assets.filter(a => a?.status === 'active' && a.tradable === true &&
      a.class === 'us_equity' && typeof a.symbol === 'string' && a.symbol.trim()).map(a => [a.symbol, a])).values()];
    if (!eligible.length) throw new SdError('Tradable asset universe is empty.');
    guard(ctx.lease);
    db.transaction(() => {
      const sorted = eligible.sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
      db.prepare('DELETE FROM sd_universe').run();
      const insert = db.prepare('INSERT OR REPLACE INTO sd_universe(symbol,name,price,avg_volume,updated_at) VALUES (?,?,?,?,?)');
      for (const asset of sorted) insert.run(asset.symbol, asset.name || null, null, null, timestamp());
      const total = sorted.length;
      let cursor = parseInt(row?.cursor || '0', 10) || 0;
      if (cursor >= total) cursor = 0;
      db.prepare(`INSERT INTO sd_coverage(id,cursor,updated_at) VALUES (1,?,?)
        ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at`)
        .run(String(cursor), timestamp());
      db.prepare('DELETE FROM sd_candidates WHERE symbol NOT IN (SELECT symbol FROM sd_universe)').run();
    })();
  }
  function selectScanSymbols() {
    const total = db.prepare('SELECT COUNT(*) AS n FROM sd_universe').get()?.n || 0;
    if (!total) return { symbols: [], cursor: 0, consumed: 0, total };
    let cursor = parseInt(db.prepare('SELECT cursor FROM sd_coverage WHERE id=1').get()?.cursor || '0', 10) || 0;
    if (cursor >= total) cursor = 0;
    // Price-aware rotation: symbols last seen outside the $5-$50 band with a
    // fresh reading are skipped (the cursor still advances past them) so the
    // 40-symbol budget concentrates on names that can pass the entry price
    // gate. Stale readings are re-checked after the recheck window. No wrap
    // mid-pass: the cursor advances to the end, then a fresh pass starts at 0.
    const minPrice = number(rules.SD_RULES?.minPrice) || 5;
    const maxPrice = number(rules.SD_RULES?.maxPrice) || 50;
    const priceCutoff = new Date(now() - PRICE_RECHECK_MS).toISOString();
    const window = db.prepare('SELECT symbol,price,updated_at FROM sd_universe ORDER BY symbol LIMIT ? OFFSET ?')
      .all(scanBatch * 3, cursor);
    const symbols = [];
    let consumed = 0;
    for (const row of window) {
      if (symbols.length >= scanBatch) break;
      consumed += 1;
      const price = number(row.price);
      const fresh = row.updated_at && row.updated_at >= priceCutoff;
      if (fresh && Number.isFinite(price) && (price < minPrice || price > maxPrice)) continue;
      symbols.push(row.symbol);
    }
    return { symbols, cursor, consumed, total };
  }
  async function loadBars(ctx, symbols, { timeframe, start, end, pageBound }) {
    const result = Object.fromEntries(symbols.map(s => [s, []]));
    if (!symbols.length) return result;
    let page = null;
    const seen = new Set();
    for (let count = 0; count < pageBound; count++) {
      const query = new URLSearchParams({ symbols: symbols.join(','), timeframe, start, end,
        limit: '10000', adjustment: 'all', feed: ctx.feed || 'sip', sort: 'asc' });
      if (page) query.set('page_token', page);
      const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
      if (!data?.bars || typeof data.bars !== 'object') throw new SdError('Historical bars are unavailable.');
      for (const symbol of symbols) {
        if (data.bars[symbol] !== undefined && !Array.isArray(data.bars[symbol])) throw new SdError('Historical bars are malformed.');
        result[symbol].push(...(data.bars[symbol] || []));
      }
      page = data.next_page_token;
      if (!page) return result;
      if (seen.has(page)) throw new SdError('Historical bar pagination repeated a token.');
      seen.add(page);
    }
    throw new SdError('Historical bar pagination exceeded its safety bound.');
  }
  async function loadIntradayBars(ctx, symbols) {
    const start = easternDayStartUtc(now());
    const end = new Date(now()).toISOString();
    return loadBars(ctx, symbols, { timeframe: '1Min', start, end, pageBound: 20 });
  }
  async function loadDailyBars(ctx, symbols, days = 75) {
    const start = easternDate(now() - days * 86400000);
    const end = easternDate(now() + 86400000);
    return loadBars(ctx, symbols, { timeframe: '1Day', start, end, pageBound: 20 });
  }
  function averageDollarVolume(dailyBars, lookback = 20) {
    const bars = (Array.isArray(dailyBars) ? dailyBars : []).slice(-lookback);
    let sum = 0;
    let count = 0;
    for (const bar of bars) {
      const price = number(bar?.c);
      const volume = number(bar?.v);
      if (price > 0 && volume > 0) { sum += price * volume; count += 1; }
    }
    return count ? sum / count : null;
  }
  async function spyRegimeOf(ctx) {
    const snapshot = await broker(ctx, `/v2/stocks/SPY/snapshot?feed=${ctx.feed || 'sip'}`, { data: true });
    const tradePrice = number(snapshot?.latestTrade?.p);
    const prevClose = number(snapshot?.prevDailyBar?.c);
    if (!(tradePrice > 0) || !(prevClose > 0)) throw new SdError('SPY regime data is unavailable; scan withheld.');
    const spyDayChangePct = (tradePrice / prevClose - 1) * 100;
    const bars = await loadIntradayBars(ctx, ['SPY']);
    const vwap = calculateRegularSessionVwap(bars.SPY || []);
    const spyAboveVwap = vwap != null && tradePrice > vwap;
    return rules.classifySpyRegime({ spyDayChangePct, spyAboveVwap });
  }

  // ---------------------------------------------------------------------------
  // Scan. ~40 symbols per cycle on a rotating cursor. Every evaluated symbol
  // lands in sd_candidates; every rejected one also lands in sd_rejections
  // with its first failed gate; exactly one sd_scan_runs row is written per
  // cycle with the full funnel counters.
  // ---------------------------------------------------------------------------
  function beginScanRun() {
    const runId = `sd-${easternDate(now())}-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO sd_scan_runs(run_id,started_at) VALUES (?,?)`).run(runId, timestamp());
    return runId;
  }
  function normalizeScanResult(result, symbol) {
    const eligible = result?.eligible === true;
    return {
      ...result, symbol, eligible,
      signal: eligible ? 'BUY' : 'WAIT',
      outcome: eligible ? 'eligible' : 'rejected',
      eventId: `${symbol}:${easternDate(now())}:SD`,
      evaluatedAt: timestamp(),
    };
  }  function scanFailure(error) {
    const message = error instanceof SdError ? error.message : '';
    if (/stale|malformed|bars|snapshots|clock|market data|probe|feed|historical/i.test(message)) {
      return { outcome: 'error', reason: 'Broker market data is missing, stale, or malformed; this symbol was withheld.' };
    }
    return { outcome: 'error', reason: 'Broker or market-data request failed; this symbol was withheld.' };
  }
  function scoreSymbol(ctx, symbol, intradayBars, dailyBars, snapshot, marketState) {
    // The shared liquidity screen is an entry-only gate: it never overrides
    // an EXIT/signal decision, it only withholds BUY research.
    const liquidity = evaluateAlpacaLiquidity(snapshot, { now: now(), marketState: 'REGULAR' });
    let result = rules.evaluateSd({
      intradayBars: intradayBars || [], dailyBars: dailyBars || [], snapshot: snapshot || {},
      spyRegime: marketState.spyRegime, spreadPct: liquidity.spreadPct,
      avgDollarVol: averageDollarVolume(dailyBars, 20),
      minScore: ctx.settings.min_quality_score, settings: ctx.settings,
    });
    result = { ...result, liquidity,
      // Carried for universe price bookkeeping only; not strategy evidence.
      lastPrice: number(result?.lastPrice) > 0 ? number(result.lastPrice) : number(snapshot?.latestTrade?.p) || null,
      sessionVolume: liquidity.shareVolume != null ? liquidity.shareVolume : null };
    if (result.signal === 'BUY' && !liquidity.eligible) {
      result = {
        ...result, eligible: false, signal: 'WAIT',
        reasons: [...(result.reasons || []), ...liquidity.reasons],
        gates: [...(result.gates || []), {
          name: 'Shared liquidity policy', passed: false, reason: liquidity.reasons.join(' '),
        }],
      };
    }
    return normalizeScanResult(result, symbol);
  }
  function persistScanResults(ctx, runId, selection, results) {
    const evaluatedAt = timestamp();
    const { symbols, cursor, consumed, total } = selection;
    const passCounts = {};
    guard(ctx.lease);
    db.transaction(() => {
      const put = db.prepare(`INSERT INTO sd_candidates(symbol,outcome,score,setup,gates,reasons,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET
        outcome=excluded.outcome,score=excluded.score,setup=excluded.setup,gates=excluded.gates,
        reasons=excluded.reasons,updated_at=excluded.updated_at`);
      const reject = db.prepare('INSERT INTO sd_rejections(run_id,symbol,stage,reason) VALUES (?,?,?,?)');
      const price = db.prepare('UPDATE sd_universe SET price=?,avg_volume=?,updated_at=? WHERE symbol=?');
      for (const result of results) {
        put.run(result.symbol, result.outcome, Number.isFinite(number(result.score)) ? Math.round(number(result.score)) : null,
          result.setup || null, JSON.stringify(result.gates || []), JSON.stringify(result.reasons || []), evaluatedAt);
        for (const gate of result.gates || []) {
          if (gate && gate.passed) passCounts[gate.name] = (passCounts[gate.name] || 0) + 1;
        }
        if (!result.eligible) {
          const failed = (result.gates || []).find(gate => gate && gate.passed === false);
          reject.run(runId, result.symbol, failed?.name || result.outcome || 'strategy',
            failed?.reason || (result.reasons || [])[0] || 'Withheld by the strategy evaluation.');
        }
        const lastPrice = number(result.lastPrice) > 0 ? number(result.lastPrice) : null;
        const sessionVolume = result.sessionVolume != null && result.sessionVolume >= 0 ? result.sessionVolume : null;
        price.run(lastPrice, sessionVolume, evaluatedAt, result.symbol);
      }
      const nextCursor = cursor + consumed >= total ? 0 : cursor + consumed;
      db.prepare('UPDATE sd_coverage SET cursor=?,updated_at=? WHERE id=1').run(String(nextCursor), evaluatedAt);
      db.prepare(`UPDATE sd_scan_runs SET symbols_scanned=?,liquidity_pass=?,momentum_pass=?,vwap_pass=?,
        quality_score_pass=?,risk_pass=? WHERE run_id=?`)
        .run(symbols.length, passCounts.liquidity || 0, passCounts.momentum || 0, passCounts.vwap || 0,
          passCounts.quality_score || 0, passCounts.risk || 0, runId);
    })();
    return results;
  }
  // Finalize the run's order/trade counters from the journal: all counters
  // derive from rows created or closed since the run started.
  function finalizeScanRun(runId, { unrealizedPnl = 0 } = {}) {
    const startedAt = db.prepare('SELECT started_at FROM sd_scan_runs WHERE run_id=?').get(runId)?.started_at;
    if (!startedAt) return;
    const day = `datetime(created_at)>=datetime('${startedAt.replace(/'/g, "''")}')`;
    const closedDay = `datetime(updated_at)>=datetime('${startedAt.replace(/'/g, "''")}')`;
    const one = (sql, params = []) => db.prepare(sql).get(...params) || {};
    const attempted = one(`SELECT COUNT(*) n FROM sd_trades WHERE ${day}`).n || 0;
    const accepted = one(`SELECT COUNT(*) n FROM sd_trades WHERE ${day} AND order_id IS NOT NULL`).n || 0;
    const rejected = one(`SELECT COUNT(*) n FROM sd_trades WHERE status='rejected' AND ${closedDay}`).n || 0;
    const filled = one(`SELECT COUNT(*) n FROM sd_trades WHERE ${day} AND filled_shares>0`).n || 0;
    const opened = one(`SELECT COUNT(*) n FROM sd_trades WHERE ${day} AND status IN ('open','partial')`).n || 0;
    const closedRows = db.prepare(`SELECT pnl FROM sd_trades WHERE status='closed' AND ${closedDay}`).all();
    const winning = closedRows.filter(r => number(r.pnl) > 0).length;
    const losing = closedRows.filter(r => number(r.pnl) < 0).length;
    const realized = closedRows.reduce((sum, r) => sum + (Number.isFinite(number(r.pnl)) ? number(r.pnl) : 0), 0);
    db.prepare(`UPDATE sd_scan_runs SET orders_attempted=?,orders_accepted=?,orders_rejected=?,orders_filled=?,
      positions_opened=?,positions_closed=?,winning_trades=?,losing_trades=?,realized_pnl=?,unrealized_pnl=? WHERE run_id=?`)
      .run(attempted, accepted, rejected, filled, opened, closedRows.length, winning, losing, realized, unrealizedPnl, runId);
  }
  async function scanContext(ctx, marketState, runId) {
    await catalog(ctx);
    const selection = selectScanSymbols();
    if (!selection.symbols.length) {
      persistScanResults(ctx, runId, selection, []);
      return [];
    }
    let results;
    try {
      const [minuteBars, dailyBars, snapshots] = await Promise.all([
        loadIntradayBars(ctx, selection.symbols),
        loadDailyBars(ctx, selection.symbols),
        broker(ctx, `/v2/stocks/snapshots?${new URLSearchParams({ symbols: selection.symbols.join(','), feed: ctx.feed || 'sip' })}`, { data: true }),
      ]);
      if (!snapshots || typeof snapshots !== 'object') throw new SdError('Market snapshots are unavailable.');
      results = selection.symbols.map(symbol =>
        scoreSymbol(ctx, symbol, minuteBars[symbol] || [], dailyBars[symbol] || [], snapshots[symbol] || {}, marketState));
    } catch (error) {
      const failure = scanFailure(error);
      results = selection.symbols.map(symbol => ({
        symbol, eligible: false, signal: 'WAIT', outcome: failure.outcome, setup: null, score: 0,
        gates: [], reasons: [failure.reason], eventId: `${symbol}:${easternDate(now())}:SD`, evaluatedAt: timestamp(),
      }));
      persistScanResults(ctx, runId, selection, results);
      error.scanPersisted = true;
      throw error;
    }
    persistScanResults(ctx, runId, selection, results);
    return results.filter(r => r.eligible && r.signal === 'BUY').sort(rules.rankSdCandidates);
  }
  async function scan(uid) {
    return locked(uid, async lease => {
      const ctx = context(uid, lease);
      const runId = beginScanRun();
      try {
        assertAuthorized(ctx);
        const { clock } = await market(ctx);
        await resolveFeed(ctx);
        const spyRegime = await spyRegimeOf(ctx);
        await scanContext(ctx, { clock, spyRegime }, runId);
        finalizeScanRun(runId);
        return { ok: true, run_id: runId };
      } catch (error) {
        if (!error.scanPersisted) {
          try { finalizeScanRun(runId); } catch (_) {}
        }
        throw error;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Order lifecycle. Safety rules copied from the B2 pattern:
  // - deterministic client_order_id, reservation INSERT OR IGNORE before POST;
  // - durability flush before mutating calls;
  // - POSTs are never retried after a timeout -> 'submission_unknown' ->
  //   reconcile by client_order_id lookup;
  // - definitive 4xx -> 'rejected';
  // - strict client_order_id ownership: never manage shares we didn't fill;
  // - stops are never widened, only tightened (breakeven on the runner).
  // ---------------------------------------------------------------------------
  function updateTrade(id, fields) {
    const entries = Object.entries({ ...fields, updated_at: timestamp() });
    db.prepare(`UPDATE sd_trades SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([, value]) => value), id);
  }
  const reload = id => db.prepare('SELECT * FROM sd_trades WHERE id=?').get(id);
  function problem(ctx, trade, message) {
    updateTrade(trade.id, { protection: 'unknown' });
    alert(ctx.uid, 'protection', message);
  }
  async function orderByClient(ctx, id) {
    return broker(ctx, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`, { allow404: true });
  }
  async function readOrder(ctx, id) {
    return broker(ctx, `/v2/orders/${encodeURIComponent(id)}?nested=true`);
  }
  async function latestStop(ctx, order) {
    const seen = new Set();
    while (order?.replaced_by) {
      if (seen.has(order.id) || seen.size > 8) throw new SdError('Protective replacement chain is unresolved.');
      seen.add(order.id);
      order = await readOrder(ctx, order.replaced_by);
    }
    return order;
  }
  function recordExitFill(trade, order) {
    if (!order || order.symbol !== trade.symbol || order.side !== 'sell') throw new SdError('Exit order ownership is not verified.');
    const quantity = number(order.filled_qty);
    if (quantity > 0) {
      if (!(number(order.filled_avg_price) > 0)) throw new SdError('Exit fill price is missing.');
      // sd_exit_fills carries no broker order id, so dedupe on the natural
      // (qty, price) pair to keep reconcile idempotent across cycles.
      const existing = db.prepare('SELECT 1 FROM sd_exit_fills WHERE trade_id=? AND fill_qty=? AND fill_price=?')
        .get(trade.id, quantity, number(order.filled_avg_price));
      if (!existing) {
        db.prepare('INSERT INTO sd_exit_fills(trade_id,fill_price,fill_qty,proceeds,filled_at) VALUES (?,?,?,?,?)')
          .run(trade.id, number(order.filled_avg_price), quantity, quantity * number(order.filled_avg_price), timestamp());
      }
    }
  }
  function exited(trade) {
    return db.prepare('SELECT COALESCE(SUM(fill_qty),0) AS shares,COALESCE(SUM(fill_qty*fill_price),0) AS proceeds FROM sd_exit_fills WHERE trade_id=?').get(trade.id);
  }
  async function finishExit(ctx, trade, order, reasonHint) {
    recordExitFill(trade, order);
    const positions = await broker(ctx, '/v2/positions');
    if (!Array.isArray(positions)) throw new SdError('Positions are unavailable.');
    const remaining = positions.find(p => p.symbol === trade.symbol && number(p.qty) !== 0);
    const fills = exited(trade);
    if (TERMINAL.has(order.status) && !remaining && fills.shares === number(trade.filled_shares) && fills.shares > 0) {
      const reason = trade.exit_reason || reasonHint || 'stop';
      updateTrade(trade.id, { status: 'closed', protection: 'settled', exit_reason: reason,
        exit_price: fills.proceeds / fills.shares,
        pnl: fills.proceeds - number(trade.entry_price) * number(trade.filled_shares) });
      db.prepare("UPDATE sd_close_attempts SET result='closed' WHERE trade_id=? AND result='submission_unknown'").run(trade.id);
      return true;
    }
    return false;
  }
  async function cancelConfirmed(ctx, order, depth = 0) {
    if (depth > 8) throw new SdError('Cancellation replacement chain is unresolved.');
    if (order.replaced_by) return cancelConfirmed(ctx, await latestStop(ctx, order), depth + 1);
    if (order.status === 'replaced') throw new SdError('Replacement identity is unavailable; cancellation is not settled.');
    if (TERMINAL.has(order.status)) return order;
    await broker(ctx, `/v2/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE' });
    const settled = await readOrder(ctx, order.id);
    if (settled.replaced_by) return cancelConfirmed(ctx, await latestStop(ctx, settled), depth + 1);
    if (settled.status === 'replaced') throw new SdError('Replacement identity is unavailable; cancellation is not settled.');
    if (!TERMINAL.has(settled.status)) throw new SdError('Order cancellation is not settled.');
    return settled;
  }
  // Restore a protective stop at the trade's recorded stop price. The recorded
  // price only ever moves up (breakeven on the runner), so restoration can
  // never widen the stop.
  async function ensureProtection(ctx, trade) {
    const remaining = number(trade.filled_shares) - exited(trade).shares;
    if (!(remaining > 0) || trade.exit_client_id) return;
    const stopPrice = number(trade.stop_price);
    if (!(stopPrice > 0)) { problem(ctx, trade, 'Protective stop price is missing; new entries are blocked.'); return; }
    const id = clientId(ctx.cred.account_id, trade.symbol, trade.event_id, 'stop', String(stopPrice));
    let stop = await orderByClient(ctx, id);
    if (!stop) {
      try {
        stop = await broker(ctx, '/v2/orders', { method: 'POST', body: {
          symbol: trade.symbol, qty: String(remaining), side: 'sell', type: 'stop',
          time_in_force: 'gtc', stop_price: String(stopPrice), client_order_id: id,
        } });
      } catch (_) { stop = await orderByClient(ctx, id); }
    }
    if (stop && brokerOrderMatchesIntent(stop, id) && stop.symbol === trade.symbol && stop.side === 'sell' &&
        ACTIVE_STOP.has(stop.status) && stop.status !== 'held' &&
        number(stop.qty) - number(stop.filled_qty || 0) === remaining &&
        Number.isFinite(number(stop.stop_price)) && number(stop.stop_price) + 1e-9 >= stopPrice) {
      updateTrade(trade.id, { stop_id: stop.id, stop_price: number(stop.stop_price), protection: 'protected' });
    } else {
      problem(ctx, trade, 'Filled shares lack a verified active protective stop. New entries are blocked until protection is confirmed.');
    }
  }
  async function reconcileTrade(ctx, initial) {
    let trade = reload(initial.id);
    const parent = trade.order_id ? await readOrder(ctx, trade.order_id) : await orderByClient(ctx, trade.client_id);
    if (!parent) {
      problem(ctx, trade, 'Entry submission is unresolved. No retry is permitted until broker acceptance is known.');
      return;
    }
    if (!brokerOrderMatchesIntent(parent, trade.client_id) || parent.symbol !== trade.symbol || parent.side !== 'buy') {
      throw new SdError('Entry order ownership is not verified.');
    }
    const filled = number(parent.filled_qty);
    if (!Number.isFinite(filled) || filled < 0) throw new SdError('Broker entry fill data is unavailable.');
    updateTrade(trade.id, { order_id: parent.id, filled_shares: filled,
      entry_price: filled > 0 && Number.isFinite(number(parent.filled_avg_price)) ? number(parent.filled_avg_price) : null });
    const legs = Array.isArray(parent.legs) ? parent.legs : [];
    let stop = trade.stop_id ? await latestStop(ctx, await readOrder(ctx, trade.stop_id)) :
      legs.find(leg => leg.side === 'sell' && ['stop', 'stop_limit'].includes(leg.type));
    if (stop) stop = await latestStop(ctx, stop);
    if (stop && (stop.symbol !== trade.symbol || stop.side !== 'sell')) throw new SdError('Protective order ownership is not verified.');
    if (stop) updateTrade(trade.id, { stop_id: stop.id, stop_price: Number.isFinite(number(stop.stop_price)) ? number(stop.stop_price) : null });
    trade = reload(trade.id);
    if (filled === 0 && TERMINAL.has(parent.status)) {
      if (stop && !TERMINAL.has(stop.status)) stop = await cancelConfirmed(ctx, stop);
      if (stop && number(stop.filled_qty) > 0) {
        problem(ctx, trade, 'Protective sell reported fills without an owned entry. Immediate broker review is required.');
        return;
      }
      updateTrade(trade.id, { status: parent.status === 'rejected' ? 'rejected' : 'canceled', protection: 'settled' });
      return;
    }
    if (stop) {
      recordExitFill(trade, stop);
      if (stop.status === 'filled') {
        updateTrade(trade.id, { exit_reason: 'stop' });
        if (await finishExit(ctx, reload(trade.id), stop, 'stop')) return;
      }
    }
    if (trade.exit_client_id) {
      const exit = trade.exit_id ? await readOrder(ctx, trade.exit_id) : await orderByClient(ctx, trade.exit_client_id);
      if (!exit) {
        problem(ctx, trade, 'Exit submission is unresolved. Manual broker review is required; no duplicate sell will be sent.');
        return;
      }
      if (!brokerOrderMatchesIntent(exit, trade.exit_client_id) || exit.symbol !== trade.symbol || exit.side !== 'sell') {
        throw new SdError('Exit ownership is not verified.');
      }
      updateTrade(trade.id, { exit_id: exit.id, status: 'exiting' });
      if (await finishExit(ctx, trade, exit)) return;
      if (TERMINAL.has(exit.status)) {
        // Failed close: restore protection and allow a fresh attempt next cycle.
        db.prepare("UPDATE sd_close_attempts SET result=? WHERE trade_id=? AND result='submission_unknown'").run(exit.status, trade.id);
        updateTrade(trade.id, { exit_client_id: null, exit_id: null, status: trade.partial_taken ? 'partial' : 'open' });
        await ensureProtection(ctx, reload(trade.id));
      } else {
        problem(ctx, trade, 'Exit is pending or partially filled; broker settlement requires review.');
      }
      return;
    }
    if (filled === 0) {
      const attached = parent.order_class === 'oto' && stop && stop.type === 'stop' && ACTIVE_STOP.has(stop.status) &&
        number(stop.qty) === number(parent.qty);
      updateTrade(trade.id, { status: 'pending', protection: attached ? 'protected' : 'unknown' });
      if (!attached) alert(ctx.uid, 'protection', 'Pending entry does not yet have a verified attached protective stop.');
      return;
    }
    if (!(trade.entry_price > 0)) { problem(ctx, trade, 'Entry fill price is missing; protective price cannot be verified.'); return; }
    const positions = await broker(ctx, '/v2/positions');
    if (!Array.isArray(positions)) throw new SdError('Positions are unavailable.');
    const position = positions.find(p => p.symbol === trade.symbol);
    const remaining = filled - exited(trade).shares;
    if (!position || number(position.qty) !== remaining || number(position.qty) <= 0) {
      problem(ctx, trade, 'Broker position differs from owned entry fills. No unrelated shares will be managed.');
      return;
    }
    if (!stop || !ACTIVE_STOP.has(stop.status) || stop.status === 'held') {
      await ensureProtection(ctx, trade);
      return;
    }
    // Lock the filled quantity before any further action: a late parent fill
    // arriving after this point must not sit unprotected.
    if (!TERMINAL.has(parent.status)) {
      try {
        await cancelConfirmed(ctx, parent);
        await reconcileTrade(ctx, trade);
      } catch (_) { problem(ctx, trade, 'Partial entry cancellation is unresolved; its active stop has been retained.'); }
      return;
    }
    updateTrade(trade.id, { status: trade.partial_taken ? 'partial' : 'open', protection: 'protected' });
  }

  // ---------------------------------------------------------------------------
  // Signal management for open positions: single/double profit targets, the
  // partial-sale + breakeven runner flow, VWAP-failure exits, invalidated
  // setups, and the 15:50 ET end-of-day flatten.
  // ---------------------------------------------------------------------------
  function vwapFail(minuteBars) {
    const session = (Array.isArray(minuteBars) ? minuteBars : [])
      .filter(b => Number.isFinite(number(b?.c)) && Number.isFinite(number(b?.v)) && number(b.v) >= 0);
    if (session.length < 22) return false;
    const vwap = calculateRegularSessionVwap(session);
    if (!(vwap > 0)) return false;
    const lastTwo = session.slice(-2);
    if (!lastTwo.every(b => number(b.c) < vwap)) return false;
    // Volume spike: the latest bar prints at least 2x the median of the prior 20.
    const vols = session.slice(-21, -1).map(b => number(b.v)).filter(v => v > 0).sort((a, b) => a - b);
    if (!vols.length) return false;
    const median = vols[Math.floor(vols.length / 2)];
    return number(lastTwo[1].v) >= 2 * median;
  }
  function eodDue(ctx) {
    return !!ctx.settings.eod_flatten && easternTimeMinutes(now()) >= EOD_FLATTEN_MINUTES;
  }
  async function takePartial(ctx, trade) {
    const account = ctx.cred.account_id;
    let current = reload(trade.id);
    const remaining = number(current.filled_shares) - exited(current).shares;
    const partialQty = Math.floor(remaining * number(ctx.settings.partial_sell_pct) / 100);
    if (!(partialQty >= 1) || partialQty >= remaining) return;
    // Cancel the existing stop first so the partial sell never competes with it.
    if (current.stop_id) {
      try {
        const stop = await latestStop(ctx, await readOrder(ctx, current.stop_id));
        if (stop && !TERMINAL.has(stop.status)) {
          const settled = await cancelConfirmed(ctx, stop);
          recordExitFill(current, settled);
        }
      } catch (_) {
        problem(ctx, current, 'Protective stop cancellation is unresolved. No partial sale will be sent.');
        return;
      }
    }
    const id = clientId(account, current.symbol, current.event_id, 'partial');
    db.prepare('INSERT INTO sd_close_attempts(trade_id,attempt,result) VALUES (?,?,?)')
      .run(current.id, 'single_partial', 'submission_unknown');
    let order = await orderByClient(ctx, id);
    if (!order) {
      try {
        order = await broker(ctx, '/v2/orders', { method: 'POST', body: {
          symbol: current.symbol, qty: String(partialQty), side: 'sell', type: 'market',
          time_in_force: 'day', client_order_id: id,
        } });
      } catch (_) { order = await orderByClient(ctx, id); }
    }
    if (!order || !brokerOrderMatchesIntent(order, id) || order.symbol !== current.symbol || order.side !== 'sell') {
      db.prepare("UPDATE sd_close_attempts SET result='unknown' WHERE trade_id=? AND attempt='single_partial' AND result='submission_unknown'")
        .run(current.id);
      problem(ctx, current, 'Partial-profit submission is unresolved. No duplicate sell will be sent.');
      return;
    }
    recordExitFill(current, order);
    db.prepare("UPDATE sd_close_attempts SET result='filled' WHERE trade_id=? AND attempt='single_partial' AND result='submission_unknown'")
      .run(current.id);
    // Move the runner's stop to breakeven. Breakeven is above the original
    // stop for a long, so the stop only ever tightens.
    current = reload(current.id);
    const runnerQty = number(current.filled_shares) - exited(current).shares;
    if (runnerQty > 0) {
      const breakeven = Math.ceil(number(current.entry_price) * 100 - 1e-9) / 100;
      const stopId = clientId(account, current.symbol, current.event_id, 'stop-be');
      let stopOrder = await orderByClient(ctx, stopId);
      if (!stopOrder) {
        try {
          stopOrder = await broker(ctx, '/v2/orders', { method: 'POST', body: {
            symbol: current.symbol, qty: String(runnerQty), side: 'sell', type: 'stop',
            time_in_force: 'gtc', stop_price: String(breakeven), client_order_id: stopId,
          } });
        } catch (_) { stopOrder = await orderByClient(ctx, stopId); }
      }
      if (stopOrder && brokerOrderMatchesIntent(stopOrder, stopId) && stopOrder.symbol === current.symbol &&
          stopOrder.side === 'sell' && ACTIVE_STOP.has(stopOrder.status) && stopOrder.status !== 'held') {
        updateTrade(current.id, { partial_taken: 1, stop_id: stopOrder.id,
          stop_price: number(stopOrder.stop_price), status: 'partial', protection: 'protected' });
        alert(ctx.uid, 'exit', `Singles & Doubles took partial profit on ${current.symbol}; the runner's stop moved to breakeven.`);
        return;
      }
      problem(ctx, current, 'Runner stop could not be confirmed after the partial sale. Broker review is required.');
      return;
    }
    updateTrade(current.id, { partial_taken: 1, status: 'partial' });
  }
  async function closePosition(ctx, trade, reason) {
    const account = ctx.cred.account_id;
    let current = reload(trade.id);
    if (CLOSED.has(current.status) || current.exit_client_id) return;
    const positions = await broker(ctx, '/v2/positions');
    if (!Array.isArray(positions)) throw new SdError('Positions are unavailable.');
    const position = positions.find(p => p.symbol === current.symbol);
    const quantity = number(position?.qty);
    const remaining = number(current.filled_shares) - exited(current).shares;
    if (!(quantity > 0) || quantity !== remaining) {
      problem(ctx, current, 'Broker position differs from owned fills. No unrelated shares will be managed.');
      return;
    }
    if (current.stop_id) {
      try {
        const stop = await latestStop(ctx, await readOrder(ctx, current.stop_id));
        if (stop && !TERMINAL.has(stop.status)) {
          const settled = await cancelConfirmed(ctx, stop);
          recordExitFill(current, settled);
          if (settled.status === 'filled') {
            updateTrade(current.id, { exit_reason: 'stop' });
            if (await finishExit(ctx, reload(current.id), settled, 'stop')) return;
          }
        }
      } catch (_) {
        problem(ctx, current, 'Protective stop cancellation is unresolved. No close order will be sent.');
        return;
      }
    }
    current = reload(current.id);
    const exitClient = clientId(account, current.symbol, current.event_id, reason);
    db.prepare('INSERT INTO sd_close_attempts(trade_id,attempt,result) VALUES (?,?,?)')
      .run(current.id, reason, 'submission_unknown');
    updateTrade(current.id, { exit_client_id: exitClient, exit_reason: reason, status: 'exiting', protection: 'unknown' });
    let exit;
    try {
      exit = await broker(ctx, '/v2/orders', { method: 'POST', body: {
        symbol: current.symbol, qty: String(remaining), side: 'sell', type: 'market',
        time_in_force: 'day', client_order_id: exitClient,
      } });
    } catch (error) {
      exit = await orderByClient(ctx, exitClient);
      if (exit && brokerOrderMatchesIntent(exit, exitClient) && exit.symbol === current.symbol && exit.side === 'sell') {
        updateTrade(current.id, { exit_id: exit.id });
        await reconcileTrade(ctx, reload(current.id));
        return;
      }
      if ([400, 401, 403, 404, 422].includes(error.httpStatus) && !error.duplicateClient) {
        db.prepare("UPDATE sd_close_attempts SET result='rejected' WHERE trade_id=? AND attempt=? AND result='submission_unknown'")
          .run(current.id, reason);
        updateTrade(current.id, { exit_client_id: null, exit_reason: null, status: current.partial_taken ? 'partial' : 'open' });
        await ensureProtection(ctx, reload(current.id));
        alert(ctx.uid, 'exit', 'Broker rejected the Singles & Doubles close. Protection was restored; the position remains open.');
        return;
      }
      problem(ctx, current, 'Close submission is unresolved. Manual broker review is required; no duplicate sell will be sent.');
      return;
    }
    if (exit && brokerOrderMatchesIntent(exit, exitClient)) updateTrade(current.id, { exit_id: exit.id });
    await reconcileTrade(ctx, reload(current.id));
  }
  async function signalCheck(ctx, trade, marketState, data) {
    if (CLOSED.has(trade.status) || trade.exit_client_id) return;
    if (!['open', 'partial'].includes(trade.status)) return;
    const remaining = number(trade.filled_shares) - exited(trade).shares;
    if (!(remaining > 0)) return;
    const position = data.positionsBySymbol.get(trade.symbol);
    const last = number(position?.current_price) || number(data.snapshots?.[trade.symbol]?.latestTrade?.p);
    if (!(last > 0)) return;
    if (eodDue(ctx)) { await closePosition(ctx, trade, 'eod_flatten'); return; }
    if (last >= trade.double_target) { await closePosition(ctx, trade, 'double_target'); return; }
    if (last >= trade.single_target && !trade.partial_taken) { await takePartial(ctx, trade); return; }
    if (vwapFail(data.minuteBars[trade.symbol])) { await closePosition(ctx, trade, 'vwap_fail'); return; }
    // Recompute the quality score against live data; a collapsed setup exits.
    try {
      const recheck = rules.evaluateSd({
        intradayBars: data.minuteBars[trade.symbol] || [], dailyBars: data.dailyBars[trade.symbol] || [],
        snapshot: data.snapshots?.[trade.symbol] || {}, spyRegime: marketState.spyRegime,
        spreadPct: null, avgDollarVol: null, minScore: ctx.settings.min_quality_score, settings: ctx.settings,
      });
      const floor = number(recheck?.effectiveMinScore ?? ctx.settings.min_quality_score);
      if (Number.isFinite(number(recheck?.score)) && number(recheck.score) < floor - 2) {
        await closePosition(ctx, trade, 'invalid_setup');
      }
    } catch (_) {
      // A failed re-evaluation never forces an exit; protection stays in place.
    }
  }
  async function reconcile(ctx, marketState) {
    assertAuthorized(ctx);
    const account = ctx.cred.account_id;
    const records = unresolvedByAccount(account);
    for (const trade of records) {
      try { await reconcileTrade(ctx, trade); }
      catch (_) { problem(ctx, trade, 'Broker lifecycle reconciliation failed. New entries are blocked until resolved.'); }
    }
    if (!marketState?.clock?.is_open) return;
    const symbols = [...new Set(records.map(t => t.symbol))];
    let data = { minuteBars: {}, dailyBars: {}, snapshots: {}, positionsBySymbol: new Map(), spyRegime: marketState.spyRegime };
    if (symbols.length) {
      try {
        const [minuteBars, dailyBars, snapshots, positions] = await Promise.all([
          loadIntradayBars(ctx, symbols),
          loadDailyBars(ctx, symbols),
          broker(ctx, `/v2/stocks/snapshots?${new URLSearchParams({ symbols: symbols.join(','), feed: ctx.feed || 'sip' })}`, { data: true }),
          broker(ctx, '/v2/positions'),
        ]);
        if (!snapshots || typeof snapshots !== 'object') throw new SdError('Market snapshots are unavailable.');
        data = { minuteBars, dailyBars, snapshots,
          positionsBySymbol: new Map((Array.isArray(positions) ? positions : []).map(p => [p.symbol, p])),
          spyRegime: marketState.spyRegime };
      } catch (_) {
        alert(ctx.uid, 'exit', 'Owned-position signal data is unavailable; existing protection is retained.');
        return;
      }
    }
    for (const initial of records) {
      const trade = reload(initial.id);
      if (CLOSED.has(trade.status) || !trade.order_id || trade.exit_client_id) continue;
      try { await signalCheck(ctx, trade, marketState, data); }
      catch (_) { alert(ctx.uid, 'exit', 'Owned position exit evaluation is unavailable; existing protection is retained where possible.'); }
    }
  }

  // ---------------------------------------------------------------------------
  // Entries. Daily risk guards run first, then B2's guarded entry pattern:
  // reservation INSERT OR IGNORE, double portfolio verification, fresh signal
  // re-evaluation, fresh quote, risk sizing, protected OTO construction.
  // ---------------------------------------------------------------------------
  function easternDayBounds(value) {
    const start = easternDayStartUtc(value);
    return [start, new Date(Date.parse(start) + 86400000).toISOString()];
  }
  function dailyGuards(ctx) {
    const s = ctx.settings;
    const account = ctx.cred.account_id;
    const [dayStart, dayEnd] = easternDayBounds(now());
    const realizedDayPnl = db.prepare(`SELECT COALESCE(SUM(pnl),0) AS p FROM sd_trades
      WHERE account_id=? AND status='closed' AND datetime(updated_at)>=datetime(?) AND datetime(updated_at)<datetime(?)`)
      .get(account, dayStart, dayEnd)?.p || 0;
    if (realizedDayPnl <= -Math.abs(number(s.max_daily_loss))) {
      return { ok: false, blocker: `Daily loss limit reached (${realizedDayPnl.toFixed(2)}); entries halted for the session.` };
    }
    const tradesToday = db.prepare(`SELECT COUNT(*) AS n FROM sd_trades
      WHERE account_id=? AND datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)`)
      .get(account, dayStart, dayEnd)?.n || 0;
    if (tradesToday >= s.max_trades_per_day) {
      return { ok: false, blocker: `Maximum trades per day reached (${tradesToday}); entries halted.` };
    }
    const open = unresolvedByAccount(account).filter(t => ['open', 'partial'].includes(t.status));
    if (open.length >= s.max_open_positions) {
      return { ok: false, blocker: `Maximum open positions reached (${open.length}); entries halted.` };
    }
    const exposure = open.reduce((sum, t) => sum + Math.abs(number(t.entry_price) * number(t.filled_shares)), 0);
    if (exposure >= s.max_total_exposure) {
      return { ok: false, blocker: `Maximum total exposure reached ($${exposure.toFixed(2)}); entries halted.` };
    }
    return { ok: true };
  }
  async function enter(ctx, candidate, marketState) {
    assertAuthorized(ctx, true);
    const account = ctx.cred.account_id;
    if (unresolvedByAccount(account).some(t => t.protection !== 'protected' || t.exit_client_id)) return;
    const guards = dailyGuards(ctx);
    if (!guards.ok) { alert(ctx.uid, 'entry', guards.blocker); return; }
    const eventId = `${candidate.symbol}:${easternDate(now())}:SD`;
    if (db.prepare('SELECT 1 FROM sd_trades WHERE account_id=? AND symbol=? AND event_id=?')
      .get(account, candidate.symbol, eventId)) return;
    const asset = await broker(ctx, `/v2/assets/${encodeURIComponent(candidate.symbol)}`);
    if (!asset || asset.tradable !== true || asset.status !== 'active' || asset.class !== 'us_equity') return;
    const accountInfo = await broker(ctx, '/v2/account');
    validateAccount(accountInfo, account);
    const clock = await broker(ctx, '/v2/clock');
    if (!clock?.is_open || !Number.isFinite(Date.parse(clock.timestamp)) || Math.abs(now() - Date.parse(clock.timestamp)) > 120000) return;
    const positions = await broker(ctx, '/v2/positions');
    const orders = await broker(ctx, '/v2/orders?status=open&limit=500&nested=true');
    if (!Array.isArray(positions) || !Array.isArray(orders) || orders.length >= 500) throw new SdError('Complete broker portfolio data is unavailable.');
    const held = new Set(positions.filter(p => number(p.qty) !== 0).map(p => p.symbol));
    const pending = new Set(orders.filter(o => o.side === 'buy' && !TERMINAL.has(o.status)).map(o => o.id || o.client_order_id));
    for (const trade of unresolvedByAccount(account).filter(t => ['pending', 'partial', 'submission_unknown'].includes(t.status))) {
      pending.add(trade.order_id || trade.client_id);
    }
    const maxPositions = ctx.settings.max_open_positions;
    if (held.size + pending.size >= maxPositions || held.has(candidate.symbol) || orders.some(o => o.symbol === candidate.symbol) ||
        unresolvedByAccount(account).some(t => t.symbol === candidate.symbol)) return;
    // Fresh signal re-evaluation against current bars/snapshot, not the
    // ranked scan result. The event must still be the current session's.
    const [minuteBars, dailyBars, snapshots] = await Promise.all([
      loadIntradayBars(ctx, [candidate.symbol]),
      loadDailyBars(ctx, [candidate.symbol]),
      broker(ctx, `/v2/stocks/${encodeURIComponent(candidate.symbol)}/snapshot?feed=${ctx.feed || 'sip'}`, { data: true }),
    ]);
    const fresh = scoreSymbol(ctx, candidate.symbol, minuteBars[candidate.symbol] || [],
      dailyBars[candidate.symbol] || [], snapshots || {}, marketState);
    if (!fresh?.eligible || fresh.signal !== 'BUY' || fresh.eventId !== eventId) return;
    const quote = snapshots?.latestQuote;
    const ask = number(quote?.ap);
    const bid = number(quote?.bp);
    if (!(ask > 0 && bid > 0 && ask >= bid) || !Number.isFinite(Date.parse(quote?.t)) ||
        now() - Date.parse(quote.t) > QUOTE_MAX_AGE_MS || Date.parse(quote.t) - now() > 5000) return;
    const sizing = rules.sizePosition({
      equity: number(accountInfo.equity), buyingPower: number(accountInfo.buying_power),
      entryPrice: ask, stopPrice: fresh.stopPrice,
      maxRiskPerTrade: ctx.settings.max_risk_per_trade, maxPositionDollars: ctx.settings.max_position_dollars,
    });
    const qty = Math.floor(number(sizing?.qty) * number(fresh.sizeMultiplier ?? 1));
    if (!(qty >= 1)) return;
    const id = clientId(account, candidate.symbol, eventId);
    const order = rules.buildSdEntry({ symbol: candidate.symbol, bid, ask, qty,
      stopPrice: fresh.stopPrice, clientOrderId: id });
    if (!order || order.side !== 'buy' || order.order_class !== 'oto' || order.client_order_id !== id ||
        !(number(order.stop_loss?.stop_price) > 0)) {
      throw new SdError('A protected OTO entry order could not be constructed.');
    }
    // Final verification pass immediately before the reservation.
    const finalAccount = await broker(ctx, '/v2/account');
    validateAccount(finalAccount, account);
    const finalPositions = await broker(ctx, '/v2/positions');
    const finalOrders = await broker(ctx, '/v2/orders?status=open&limit=500&nested=true');
    if (!Array.isArray(finalPositions) || !Array.isArray(finalOrders) || finalOrders.length >= 500) {
      throw new SdError('Final portfolio data is unavailable.');
    }
    const finalHeld = new Set(finalPositions.filter(p => number(p.qty) !== 0).map(p => p.symbol));
    if (finalHeld.size >= maxPositions || finalHeld.has(candidate.symbol) || finalOrders.some(o => o.symbol === candidate.symbol)) return;
    const finalClock = await broker(ctx, '/v2/clock');
    if (!finalClock?.is_open || !Number.isFinite(Date.parse(finalClock.timestamp)) ||
        Math.abs(now() - Date.parse(finalClock.timestamp)) > 120000 || now() - Date.parse(quote.t) > QUOTE_MAX_AGE_MS) return;
    assertAuthorized(ctx, true);
    // The reservation is the idempotency key: INSERT OR IGNORE on the
    // UNIQUE(account_id,symbol,event_id) journal row happens before the POST.
    const reservation = db.prepare(`INSERT OR IGNORE INTO sd_trades
      (account_id,symbol,event_id,side,status,setup,quality_score,stop_price,single_target,double_target,
       client_id,signal_date,created_at,updated_at)
      VALUES (?,?,?,'long','submission_unknown',?,?,?,?,?,?, ?,?,?)`)
      .run(account, candidate.symbol, eventId, fresh.setup || null,
        Number.isFinite(number(fresh.score)) ? Math.round(number(fresh.score)) : null,
        fresh.stopPrice ?? null, fresh.singleTarget ?? null, fresh.doubleTarget ?? null, id,
        easternDate(now()), timestamp(), timestamp());
    if (!reservation.changes) return;
    const trade = reload(reservation.lastInsertRowid);
    let response;
    try { response = await broker(ctx, '/v2/orders', { method: 'POST', body: order, entry: true }); }
    catch (error) {
      response = await orderByClient(ctx, id);
      if (response) {
        if (brokerOrderMatchesIntent(response, id) && response.symbol === candidate.symbol && response.side === 'buy') {
          updateTrade(trade.id, { order_id: response.id });
        }
        await reconcileTrade(ctx, reload(trade.id));
        return;
      }
      if ([400, 401, 403, 404, 422].includes(error.httpStatus) && !error.duplicateClient) {
        updateTrade(trade.id, { status: 'rejected', protection: 'settled' });
        alert(ctx.uid, 'entry', 'Broker rejected the Singles & Doubles protected entry. The reservation will not be retried.');
        return;
      }
    }
    if (response && brokerOrderMatchesIntent(response, id) && response.symbol === candidate.symbol && response.side === 'buy') {
      updateTrade(trade.id, { order_id: response.id });
    }
    await reconcileTrade(ctx, reload(trade.id));
  }

  // ---------------------------------------------------------------------------
  // Scheduler cycle.
  // ---------------------------------------------------------------------------
  async function runCycle(uid) {
    return locked(uid, async lease => {
      const settings = ensure(uid);
      const cred = credential(uid, settings.mode);
      if (!cred) {
        const reason = 'No verified dedicated Singles & Doubles broker account is connected; scheduler cycle withheld.';
        db.prepare("UPDATE sd_settings SET last_cycle_at=?,scheduler_status='blocked',scheduler_reason=? WHERE user_id=?")
          .run(timestamp(), reason, sdUserId(uid));
        return { status: 'blocked', reason };
      }
      const ctx = context(uid, lease);
      db.prepare("UPDATE sd_settings SET last_cycle_at=?,scheduler_status='running',scheduler_reason=NULL WHERE user_id=?")
        .run(timestamp(), sdUserId(uid));
      const runId = beginScanRun();
      try {
        assertAuthorized(ctx);
        validateAccount(await broker(ctx, '/v2/account'), cred.account_id);
        // Reconcile fills/protection even if the clock or market data fails next.
        await reconcile(ctx, null);
        const { clock } = await market(ctx);
        if (!clock.is_open) {
          finalizeScanRun(runId);
          db.prepare("UPDATE sd_settings SET scheduler_status='market_closed',scheduler_reason='Market closed; reconciled only.' WHERE user_id=?")
            .run(sdUserId(uid));
          return { status: 'market_closed', run_id: runId };
        }
        // One feed for the whole cycle. SIP probed first; only Paper may fall
        // back to IEX on a 403; Live is SIP-only fail-closed.
        await resolveFeed(ctx);
        const spyRegime = await spyRegimeOf(ctx);
        const marketState = { clock, spyRegime };
        await reconcile(ctx, marketState);
        const ranked = await scanContext(ctx, marketState, runId);
        const active = getSettings(uid);
        if (active.enabled && (active.mode !== 'live' || active.live_armed) && running && authorize(ctx).ok) {
          for (const candidate of ranked) await enter(ctx, candidate, marketState);
        }
        const unrealized = await unrealizedPnl(ctx);
        finalizeScanRun(runId, { unrealizedPnl: unrealized });
        const enabled = getSettings(uid).enabled;
        db.prepare("UPDATE sd_settings SET scheduler_status=?,scheduler_reason=? WHERE user_id=?")
          .run(enabled ? 'idle' : 'paused', enabled ? 'Cycle complete.' : 'Paused; owned trades still reconciled.', sdUserId(uid));
        return { status: 'ok', run_id: runId };
      } catch (error) {
        const message = error instanceof SdError ? error.message : 'Singles & Doubles cycle failed safely; entries withheld.';
        db.prepare("UPDATE sd_settings SET scheduler_status='error',scheduler_reason=? WHERE user_id=?").run(message, sdUserId(uid));
        try { finalizeScanRun(runId); } catch (_) {}
        alert(uid, 'cycle', message);
        return { status: 'error', reason: message };
      }
    });
  }
  async function unrealizedPnl(ctx) {
    try {
      const positions = await broker(ctx, '/v2/positions');
      if (!Array.isArray(positions)) return 0;
      const open = new Set(unresolvedByAccount(ctx.cred.account_id).filter(t => ['open', 'partial'].includes(t.status)).map(t => t.symbol));
      return positions.filter(p => open.has(p.symbol))
        .reduce((sum, p) => sum + (Number.isFinite(number(p.unrealized_pl)) ? number(p.unrealized_pl) : 0), 0);
    } catch (_) { return 0; }
  }
  function tick() {
    if (activeTick) return Promise.resolve();
    if (!running) return Promise.resolve();
    ticking = true;
    activeTick = (async () => {
      const users = db.prepare('SELECT user_id FROM sd_settings ORDER BY user_id').all();
      let next = 0;
      // Bounded account-level fairness; each worker's broker requests remain
      // sequential and durable per-account leases prevent overlapping cycles.
      await Promise.all(Array.from({ length: Math.min(3, users.length) }, async () => {
        while (running && next < users.length) {
          const row = users[next++];
          try { await runCycle(row.user_id); } catch (_) { /* Another process owns the durable lease. */ }
        }
      }));
    })().finally(() => {
      ticking = false;
      activeTick = null;
    });
    return activeTick;
  }
  function start({ schedule = true } = {}) {
    if (running) return;
    running = true;
    if (schedule) {
      timer = setInterval(() => { void tick(); }, 60000);
      timer.unref?.();
      void tick();
    }
  }
  function stop() {
    running = false;
    generation++;
    if (timer) clearInterval(timer);
    timer = null;
  }
  async function drain() {
    stop();
    if (activeTick) await activeTick;
  }
  function lifecycleStatus() {
    return { running, ticking, scheduled: timer !== null };
  }
  return {
    start, stop, drain, lifecycleStatus, tick, runCycle, status, setSettings,
    setAutomation, setCredentials, disconnect, setMode, candidates, scan, trades, stats, alerts, funnel,
  };
}

function mountSd({ app, db, requireAuth, ensureSessionUserInTradingStore, vault, fetch, ...options }) {
  const service = createSdService({ db, vault, fetch, ...options });
  const route = (method, path, action, synchronize = false) => {
    app[method](`/api/sd/${path}`, requireAuth, async (req, res) => {
      try {
        const uid = synchronize ? await ensureSessionUserInTradingStore(req) : Number(req.session?.userId);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new SdError('Authenticated user identity is invalid.', 401);
        res.json(await action(uid, req));
      } catch (error) {
        res.status(error instanceof SdError ? error.status : 500).json({
          error: error instanceof SdError ? error.message : 'Singles & Doubles request failed safely. Please retry or review account readiness.',
        });
      }
    });
  };
  route('get', 'status', uid => service.status(uid));
  route('get', 'funnel', uid => service.funnel(uid));
  route('get', 'trades', uid => service.trades(uid));
  route('get', 'stats', uid => service.stats(uid));
  route('post', 'scan', uid => service.scan(uid), true);
  route('put', 'settings', (uid, req) => service.setSettings(uid, req.body), true);
  route('post', 'automation', (uid, req) => service.setAutomation(uid, req.body), true);
  route('put', 'credentials', (uid, req) => service.setCredentials(uid, req.body), true);
  route('delete', 'credentials', uid => service.disconnect(uid), true);
  route('post', 'mode', (uid, req) => service.setMode(uid, req.body), true);
  return service;
}

module.exports = { mountSd, createSdService, SdError };
