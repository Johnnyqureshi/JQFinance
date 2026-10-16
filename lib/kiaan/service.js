'use strict';

// Kiaan Bot — regime-first orchestration service (server-side, stage 2).
//
// The Kiaan engine (lib/kiaan/engine.js + regime.js) is pure. This module
// wires it into the running app the way lib/orb/service.js wires ORB: own
// kiaan_* tables, an own op lease (kiaan_leases, 180s), a 60s scheduler
// loop (first run delayed ~150s, staggered after ORB's ~120s), broker-side
// protection (Warrior-style OCO for the first target tranche + a stop-only
// order for the remainder, tick-aware prices), server-side position
// management (breakeven at 1R, 3R target exit, stop backstop), EOD flatten
// at the rules flattenTime (default 15:55 ET), and /api/kiaan/* routes via
// mountKiaan().
//
// Every cycle decides the REGIME before any symbol is considered and
// journals the session stance plus every candidate decision (including
// stand-asides) into kiaan_decisions — a zero-trade day is explainable
// from the bot's own records.
//
// 2026-10-12 EXPANSION (Johnny: "Expand the list on Kiaan to the same
// ones as ORB"): rules.longUniverse carries ORB's 87-name watchlist.
// On a risk-on stance (guard off) those names may be entered as
// ordinary longs, cap-exempt, under the full confirmation stack; the
// scan always includes them (band/cap bypass, like the hedge list).
// Every other ordinary name stays blocked in hedge-only mode, guard
// and risk-off days stay hedges-only, and an empty longUniverse
// restores pure hedge-only. A one-shot seed at construction persists
// the list into stored rules rows that predate it.
//
// 2026-10-11 REBUILD (strategy-lab Test 3, the passed candidate): the
// bot is HEDGE-ONLY by default (rules.hedgeOnly) — ordinary longs are
// never entered; the hedge list trades only on seek-hedges days — and
// entered positions are MANAGED on intraday exit geometry
// (rules.exitAtrTimeframe '15m': stop/targets from ATR(14) on 15-minute
// bars, fetched per entering symbol and rebased onto the decision in
// rebaseExitGeometry). Share sizing still uses the engine's daily-ATR
// decision, exactly as the lab held share counts. Both behaviors are
// rules: hedgeOnly:false restores the long side, 'daily' restores the
// old managed geometry.
//
// 2026-10-16 SLEEVE (strategy-lab Tests 7/9/10, Johnny's on-the-fly
// authorization): a single-stock inverse sleeve runs as a SEPARATE book
// alongside the incumbent six hedges — the 31-name screened list in
// rules.sleeveSymbols, its own dedicated slot (rules.sleeveMaxPositions,
// default 1), sleeve-local day state for its locks, and entries only on
// ticks where SPY is breaking down (below intraday VWAP and within
// 0.15% of its running intraday low). Incumbent evaluations count only
// incumbent positions, so the sleeve can neither displace an incumbent
// trade nor be blocked by a full incumbent book (the failure mode that
// sank Tests 7 and 9). Positions carry a sleeve flag; sleeve decisions
// journal under CAND:SLEEVE:<symbol> and sleeve trades carry a
// 'SLEEVE: ' entry-reason prefix, so sleeve P&L reports separately.
// rules.sleeveEnabled:false turns the sleeve off, incumbents untouched.
//
// Zero imports from warrior/flipper/orb lib dirs (ET helpers are local
// copies — the house pattern; broker-universe is shared infra). Never
// touches warrior_*/flipper_*/orb_* tables. Reuses shared infra only:
// market data, Alpaca connection plumbing, account info,
// broker_account_owners / broker_account_quarantine /
// automated_action_intents.
//
// PAPER-ONLY IS STRUCTURAL: the engine forces tradingMode 'PAPER', live
// connect is refused loudly, and there is no live order path anywhere in
// this module. Fail-closed throughout: any broker/data/stale-data/
// order-confirmation/risk failure withholds new orders; fills are never
// assumed; broker error bodies are NEVER discarded — Alpaca's code and
// message ride along in errors and alerts (fleet lesson, 2026-10-07).
//
// Regime context sources: SPY/QQQ day change + intraday trend from Alpaca
// bars (the bot's own paper account data feed, SIP→IEX fallback like the
// other bots); breadth (advancers share across the bot's own liquid
// universe, day-change sign from the same Alpaca daily/minute data the
// scan already fetches — wired 2026-10-10); VIX level/day move, 10Y yield
// change and oil day change from Yahoo Finance chart data — the same
// source the site itself uses
// for ^VIX/^TNX/CL=F (server.js market widgets); the relief-bounce guard
// (2026-10-11) additionally reads the absolute 10Y level from ^TNX and
// Brent's absolute level from BZ=F on the same Yahoo source. Alpaca does not serve
// the VIX index; if the Yahoo VIX read fails, VIX is null, the regime
// classifies 'unknown', and the bot stands aside and journals why.

const crypto = require('crypto');
const {
  DEFAULT_KIAAN_RULES, mergedKiaanRules, parseSymbolList, isHedgeSymbol,
  classifyRegime, evaluateSession, evaluateCandidate, checkDailyLocks,
  atr15OfBars, intradayExitGeometry,
  validateConfig,
} = require('./engine');
const { buildTradeRecord, TRADE_FIELDS } = require('./journal');
const { buildTradableEquityCatalog } = require('../broker-universe');

// ---------------------------------------------------------------------------
// ET wall-clock helpers (local copies — house pattern; no cross-bot imports)
// ---------------------------------------------------------------------------
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
function easternDayStartMs(value) {
  // Midnight ET on the ET date of `value` (ORB engine's proven formula).
  const date = easternDate(value);
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(`${date}T12:00:00Z`)));
  const offsetHours = 12 - localHour; // 4 for EDT, 5 for EST
  return Date.parse(`${date}T00:00:00-${String(offsetHours).padStart(2, '0')}:00`);
}
function parseClock(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return fallback;
  const mins = (+m[1]) * 60 + (+m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : fallback;
}
// Alpaca takes sub-penny prices only below $1; at $1+ an order price must
// land on a whole cent or the order is rejected (HTTP 422). Ported from
// Warrior's tickPrice (the 2026-10-05 OCO lesson).
function tickPrice(px) { return px >= 1 ? +px.toFixed(2) : +px.toFixed(4); }

const TERMINAL = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'replaced']);
const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const STRATEGY = 'kiaan';
const SCOPE = 'kiaan'; // broker_account_owners scope for Kiaan's dedicated account
const UNIVERSE_SYMBOL_CAP = 60; // per-cycle symbol budget (lean scans)
const FIRST_TICK_DELAY_MS = 150000; // ~150s: staggers after ORB's ~120s first tick
const TICK_MS = 60000;
const BAR_FRESH_MS = 10 * 60000; // decision bars must be this fresh
const DAY_MS = 86400000;
const MACRO_CACHE_MS = 5 * 60000; // Yahoo macro reads are cached ~5 min

class KiaanError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
function number(value) { return value == null || value === '' ? NaN : Number(value); }
// Unique client order IDs: kiaan-<40 hex of sha256> (ORB pattern).
function clientId(...parts) {
  return `kiaan-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}
function isoNow(now) { return new Date(now()).toISOString(); }

function createKiaanService({
  db, vault, fetch: fetchBroker, now = () => Date.now(),
  getAutomaticBotContext = async () => null,
  automaticBotSettings = null,
  persistenceReady = () => true,
  durability = null,
  sendEmail = null,
  batchSize = 100, timeoutMs = 10000, leaseMs = 180000,
  exitPoll = null, // { tries, intervalMs } — test seam; production default is 12 x 500ms
}) {
  if (!db || !vault || typeof fetchBroker !== 'function') throw new Error('Kiaan requires database, vault and fetch.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Kiaan batch size must be an integer between 1 and 1000.');
  let timer = null;
  let running = false;
  let generation = 0;
  let ticking = false;
  let activeTick = null;
  // Set once any SIP data request has been downgraded to IEX in this
  // process. Observability only — it no longer reroutes anything (the old
  // latch rewrote every later request to IEX for the life of the process;
  // see the per-request fallback in request()).
  let iexFallback = false;
  // IEX carries only a slice of consolidated volume (measured 2026-10-13:
  // TCRT's 20-session ADV read 8,928 on IEX bars vs ~111-135K consolidated,
  // ~7-8%). The rules' absolute volume floors are calibrated to
  // consolidated volume, so when the daily bars behind a gate were served
  // by IEX the floor scales by this share (volumeFloor) — the gate keeps
  // its consolidated intent instead of silently rejecting every real name.
  const IEX_VOLUME_SHARE = 0.08;
  let dailyBarsFeed = null; // 'sip' | 'iex' — feed that served the latest daily-bars load
  function volumeFloor(consolidatedFloor) {
    return dailyBarsFeed === 'iex' ? Math.round(consolidatedFloor * IEX_VOLUME_SHARE) : consolidatedFloor;
  }
  const macroCache = new Map(); // yahoo symbol -> { at, closes }
  // Day-scoped caches for the scan's heavy near-static broker reads
  // (2026-10-08): the full /v2/assets catalog (multi-MB) and per-symbol
  // daily bars were re-downloaded on EVERY 60s cycle, and any single
  // response slower than the 10s request timeout killed the whole cycle
  // ('Broker request timed out; reconciliation required.'). Both caches
  // are keyed by ET trade date; a process restart simply refetches once.
  let assetsCatalogCache = { date: null, catalog: null };
  const dailyBarsCache = { date: null, bySymbol: new Map() };
  // 15-minute bars for the intraday exit geometry (2026-10-11): fetched
  // ONLY for a symbol that just produced an enter-long decision (≤ the
  // 6-trades/day lock), cached per symbol per trade date in the same
  // day-scoped pattern, refreshed when older than one 15m bucket so a
  // same-symbol re-entry later in the day sees completed bars.
  const bars15Cache = { date: null, bySymbol: new Map() }; // symbol -> { at, bars }
  const timestamp = () => isoNow(now);

  // ---------------------------------------------------------------------------
  // Schema — all kiaan_* tables, user-scoped, created at construction so a
  // cold start works without any migration step. Trade columns are exactly
  // TRADE_FIELDS from lib/kiaan/journal.js (all TEXT, like the other bots).
  // ---------------------------------------------------------------------------
  const tradeFieldDefs = TRADE_FIELDS.map(f => `"${f}" TEXT`).join(',\n    ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kiaan_settings (
      user_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'paper',
      rules TEXT NOT NULL DEFAULT '{}',
      scheduler_status TEXT NOT NULL DEFAULT 'idle',
      scheduler_reason TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS kiaan_credentials (
      user_id INTEGER PRIMARY KEY,
      api_key_enc TEXT NOT NULL,
      api_secret_enc TEXT NOT NULL,
      mode TEXT NOT NULL,
      account_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kiaan_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kiaan_positions (
      position_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      trade_id TEXT,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'long',
      entry_client_order_id TEXT,
      entry_price REAL,
      shares INTEGER,
      entry_shares INTEGER,
      stop_price REAL,
      initial_stop_price REAL,
      targets_json TEXT,
      breakeven_at INTEGER NOT NULL DEFAULT 0,
      partials_taken TEXT NOT NULL DEFAULT '[]',
      oco_id TEXT,
      stop_order_id TEXT,
      t1_qty INTEGER NOT NULL DEFAULT 0,
      t2_qty INTEGER NOT NULL DEFAULT 0,
      t1_status TEXT NOT NULL DEFAULT 'none',
      t2_status TEXT NOT NULL DEFAULT 'none',
      realized_pnl REAL NOT NULL DEFAULT 0,
      exit_proceeds REAL NOT NULL DEFAULT 0,
      exited_shares INTEGER NOT NULL DEFAULT 0,
      sleeve INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_entry',
      opened_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS kiaan_trades (
      trade_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ${tradeFieldDefs},
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kiaan_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kiaan_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      dkey TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT,
      decision TEXT,
      regime TEXT,
      reasons TEXT NOT NULL DEFAULT '[]',
      why TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE(user_id, trade_date, dkey)
    );
    CREATE TABLE IF NOT EXISTS kiaan_day_state (
      user_id INTEGER NOT NULL,
      trade_date TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT,
      PRIMARY KEY (user_id, trade_date)
    );
  `);

  // Sleeve column migration (2026-10-16): databases created before the
  // sleeve ship have no `sleeve` column on kiaan_positions — add it once,
  // guarded, exactly like a stored-rules seed. Fresh databases get it
  // from the CREATE TABLE above and skip this.
  try {
    const posCols = db.prepare('PRAGMA table_info(kiaan_positions)').all().map(c => c.name);
    if (!posCols.includes('sleeve')) {
      db.exec('ALTER TABLE kiaan_positions ADD COLUMN sleeve INTEGER NOT NULL DEFAULT 0');
    }
  } catch (_) { /* best-effort: a missing column fails loudly at first sleeve write, never silently */ }

  // ---------------------------------------------------------------------------
  // One-shot longUniverse seed (Johnny 2026-10-12: "Expand the list on
  // Kiaan to the same ones as ORB"): stored Kiaan rules rows that
  // predate the longUniverse rule get it persisted as ORB's 87-name
  // watchlist (the DEFAULT_KIAAN_RULES value, copied verbatim from
  // ORB's stored watchlist) so the live config itself carries the
  // expansion. A row already carrying a longUniverse — including a
  // deliberately emptied one (pure hedge-only) — is untouched.
  // Idempotent: seeded rows no longer match.
  // ---------------------------------------------------------------------------
  try {
    const rows = db.prepare('SELECT user_id, rules FROM kiaan_settings').all();
    for (const row of rows) {
      let stored = null;
      try { stored = JSON.parse(row.rules || '{}'); } catch (_) { stored = null; }
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
      let changed = false;
      if (stored.longUniverse === undefined) {
        stored.longUniverse = DEFAULT_KIAAN_RULES.longUniverse;
        changed = true;
      }
      // Sleeve seed (2026-10-16): rows predating the sleeve ship get the
      // tested 31-name list persisted the same way, so the live config
      // itself carries the sleeve. A row already carrying sleeveSymbols
      // — including a deliberately emptied one — is untouched.
      if (stored.sleeveSymbols === undefined) {
        stored.sleeveSymbols = DEFAULT_KIAAN_RULES.sleeveSymbols;
        changed = true;
      }
      if (changed) {
        db.prepare('UPDATE kiaan_settings SET rules=?, updated_at=? WHERE user_id=?')
          .run(JSON.stringify(stored), new Date(now()).toISOString(), row.user_id);
      }
    }
  } catch (_) { /* best-effort: merged defaults already yield the 87-name list */ }

  // ---------------------------------------------------------------------------
  // Settings, credentials, leases, broker plumbing — mirrors ORB/Flipper.
  // ---------------------------------------------------------------------------
  const getSettings = uid => db.prepare('SELECT * FROM kiaan_settings WHERE user_id=?').get(uid);
  function ensure(uid) {
    db.prepare('INSERT OR IGNORE INTO kiaan_settings(user_id) VALUES (?)').run(uid);
    return getSettings(uid);
  }
  function getRules(uid) {
    const settings = ensure(uid);
    let stored = {};
    try { stored = JSON.parse(settings.rules || '{}'); } catch (_) { stored = {}; }
    return mergedKiaanRules(stored);
  }
  function credential(uid) {
    const row = db.prepare('SELECT * FROM kiaan_credentials WHERE user_id=?').get(uid);
    if (!row) return null;
    // A missing or half-encrypted row fails closed, exactly like the fleet.
    if (!vault.isEncrypted(row.api_key_enc) || !vault.isEncrypted(row.api_secret_enc)) return null;
    return row;
  }
  const quarantined = account =>
    !!db.prepare('SELECT 1 FROM broker_account_quarantine WHERE account_id=? AND resolved_at IS NULL').get(account);
  const EMAIL_KINDS = new Set(['entry', 'exit', 'risk', 'system']);
  function alert(uid, kind, message) {
    const previous = db.prepare('SELECT kind,message,created_at FROM kiaan_alerts WHERE user_id=? ORDER BY id DESC LIMIT 1').get(uid);
    if (previous?.kind === kind && previous.message === message && now() - Date.parse(previous.created_at) < 300000) return;
    db.prepare('INSERT INTO kiaan_alerts(user_id,kind,message,created_at) VALUES (?,?,?,?)')
      .run(uid, kind, message, timestamp());
    if (sendEmail && EMAIL_KINDS.has(kind)) {
      try { void Promise.resolve(sendEmail({ userId: uid, kind, message })).catch(() => {}); }
      catch (_) { /* alert persistence above is authoritative */ }
    }
  }
  async function locked(uid, work) {
    const name = `kiaan-op:${uid}`;
    const token = crypto.randomUUID();
    const leaseUntil = new Date(now() + leaseMs).toISOString();
    const result = db.prepare(`INSERT INTO kiaan_leases(name,owner,expires_at) VALUES (?,?,?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE kiaan_leases.expires_at<=?`).run(name, token, leaseUntil, timestamp());
    if (!result.changes) throw new KiaanError('Kiaan Bot is reconciling this account. Retry shortly.');
    const lease = { uid, token, generation, name };
    try { return await work(lease); }
    finally {
      db.prepare('DELETE FROM kiaan_leases WHERE name=? AND owner=?').run(name, token);
      // Never await this flush on a user-facing path: flush() resolves only
      // after the next throttled mutation checkpoint (up to ~60s), which
      // stalled connect/settings responses past client and edge timeouts
      // (2026-10-05 fleet lesson). flush() marks the mutation dirty
      // synchronously, so the checkpoint still lands on schedule.
      // Broker-action flushes stay awaited (inside request()).
      if (durability?.flush && persistenceReady()) { try { durability.flush('kiaan-operation').catch(() => {}); } catch (_) {} }
    }
  }
  function guard(lease) {
    const renewed = db.prepare('UPDATE kiaan_leases SET expires_at=? WHERE name=? AND owner=? AND expires_at>?')
      .run(new Date(now() + leaseMs).toISOString(), lease.name, lease.token, timestamp());
    if (!renewed.changes) throw new KiaanError('Kiaan lease expired; broker action withheld.');
  }
  function context(uid, lease, mode) {
    const settings = ensure(uid);
    const cred = credential(uid);
    if (!cred) throw new KiaanError('Connect a dedicated Kiaan Bot broker account.');
    return { uid, lease, settings, cred, rules: getRules(uid) };
  }
  function authorize(ctx) {
    guard(ctx.lease);
    const cred = credential(ctx.uid);
    if (!cred || cred.account_id !== ctx.cred.account_id || cred.api_key_enc !== ctx.cred.api_key_enc ||
        cred.api_secret_enc !== ctx.cred.api_secret_enc) {
      throw new KiaanError('Kiaan authorization changed; action withheld.');
    }
    const owner = db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (!owner || owner.scope !== SCOPE || owner.user_id !== ctx.uid || owner.mode !== cred.mode || quarantined(cred.account_id)) {
      throw new KiaanError('Kiaan broker account ownership is not verified.');
    }
  }
  async function request(cred, path, { method = 'GET', body, data = false, allow404 = false, ctx, feedRef = null } = {}) {
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
          VALUES ('kiaan',?,?,?,?,?,?,?,?,'prepared',datetime('now'))
        `).run(ctx.uid, cred.account_id, cred.mode, method, path, purpose, clientOrderId, JSON.stringify(body || {}));
        ctx.actionIntentId = intent.lastInsertRowid;
      }
      await durability.flush(`kiaan-before-${method.toLowerCase()}`);
      if (ctx) authorize(ctx);
    }
    // GETs are idempotent reads: ONE retry after a timeout (fresh abort
    // controller + timer per attempt). Non-GET (order) calls are NEVER
    // retried — a timed-out order may have reached the broker, so its
    // outcome stays 'reconciliation required' exactly as before.
    const maxAttempts = method === 'GET' ? 2 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        // Paper accounts without a consolidated-data entitlement get HTTP
        // 403 on SIP feed requests. Retry THIS request once on IEX —
        // per request, never latched: the next request still asks for its
        // stated feed first, so one 403 cannot silently rewrite unrelated
        // data for the life of the process (the old latch did exactly
        // that, and the liquidity gates ended up judging
        // consolidated-calibrated floors against IEX-only volume). The
        // downgrade is logged loudly once, and the effective feed is
        // reported via feedRef so absolute-volume gates can apply
        // feed-aware floors (volumeFloor).
        if (data && response.status === 403 && path.includes('feed=sip')) {
          if (!iexFallback) {
            console.error('[Kiaan] DATA FEED DOWNGRADE: a SIP data request returned 403 (no consolidated-data entitlement on this account) and was retried on IEX. IEX volume is exchange-only (~8% of consolidated); absolute volume floors are applied feed-aware. Later requests still try SIP first.');
          }
          iexFallback = true;
          if (feedRef) feedRef.feed = 'iex';
          response = await doFetch(path.replace('feed=sip', 'feed=iex'));
        } else if (data && feedRef && path.includes('feed=sip')) {
          feedRef.feed = 'sip';
        }
        if (allow404 && response.status === 404) return null;
        if (!response.ok) {
          // NEVER discard the broker's error body (fleet lesson 2026-10-07):
          // Alpaca's code + message ride along in the thrown error so the
          // journal/alerts can name the exact refusal.
          let code = null; let message = null; let duplicateClient = false;
          try {
            const rejection = await response.json();
            code = rejection?.code ?? null;
            message = rejection?.message ? String(rejection.message).slice(0, 240) : null;
            duplicateClient = /(?:client.?order.?id.*(?:unique|exist|duplicate))|duplicate/i.test(String(rejection?.message || ''));
          } catch (_) { /* body unreadable — status alone is carried */ }
          const failure = new KiaanError(
            `Broker request failed (HTTP ${response.status})${code ? ` [${code}]` : ''}${message ? `: ${message}` : '; action withheld.'}`,
            502,
          );
          failure.httpStatus = response.status;
          failure.brokerCode = code;
          failure.duplicateClient = !!duplicateClient;
          throw failure;
        }
        return response.status === 204 ? null : await response.json();
      })();
      const result = await Promise.race([call, new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          const failure = new KiaanError('Broker request timed out; reconciliation required.', 502);
          failure.timedOut = true;
          reject(failure);
        }, timeoutMs);
      })]);
      if (ctx) guard(ctx.lease);
      if (method !== 'GET' && durability?.flush) {
        if (ctx?.actionIntentId) db.prepare(`
          UPDATE automated_action_intents SET state='submitted', broker_order_id=?, updated_at=datetime('now')
          WHERE id=?
        `).run(result?.id || null, ctx.actionIntentId);
        await durability.flush(`kiaan-after-${method.toLowerCase()}`);
      }
      return result;
    } catch (error) {
      if (method === 'GET' && error?.timedOut === true && attempt < maxAttempts) continue;
      if (method !== 'GET' && durability?.flush && ctx?.actionIntentId) {
        const definitive = Number(error?.httpStatus) >= 400 && Number(error?.httpStatus) < 500;
        db.prepare(`
          UPDATE automated_action_intents SET state=?, last_error=?, updated_at=datetime('now')
          WHERE id=?
        `).run(definitive ? 'rejected' : 'submission_unknown',
          definitive ? `Broker definitively rejected the action. ${String(error?.message || '').slice(0, 240)}` : 'Broker response was not confirmed; reconciliation required.',
          ctx.actionIntentId);
        try { await durability.flush(`kiaan-unknown-${method.toLowerCase()}`); } catch (_) {}
      }
      if (error instanceof KiaanError) throw error;
      throw new KiaanError('Broker connection or response failed; action withheld.', 502);
    } finally { clearTimeout(timeout); }
    }
  }
  async function broker(ctx, path, options = {}) {
    return request(ctx.cred, path, { ...options, ctx });
  }
  function validateAccount(account, expected) {
    if (typeof account?.id !== 'string' || !account.id.trim() || (expected && account.id !== expected) || account.status !== 'ACTIVE' ||
        account.trading_blocked || account.account_blocked || account.trade_suspended_by_user) {
      throw new KiaanError('Broker account identity or trading permission is not valid.');
    }
  }
  async function orderByClient(ctx, id) {
    return broker(ctx, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`, { allow404: true });
  }
  async function cancelOrderById(ctx, orderId) {
    return broker(ctx, `/v2/orders/${orderId}`, { method: 'DELETE', allow404: true });
  }
  function release(uid, cred) {
    if (!cred) return;
    const remaining = db.prepare('SELECT 1 FROM kiaan_credentials WHERE account_id=?').get(cred.account_id);
    if (!remaining) db.prepare("DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope='kiaan'").run(cred.account_id, uid);
  }
  function validateInput(input, allowed, message) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowed.includes(key))) throw new KiaanError(message, 400);
  }

  // ---------------------------------------------------------------------------
  // Connect / disconnect / settings / status — mirrors ORB. PAPER is the
  // only working mode; a live connect is refused LOUDLY (no quiet downgrade).
  // ---------------------------------------------------------------------------
  async function connect(uid, input) {
    if (!persistenceReady()) throw new KiaanError('Automated trading persistence is unavailable; Kiaan entries remain paused.', 503);
    validateInput(input, ['key', 'secret', 'mode'], 'Only key, secret and mode may be supplied.');
    if (typeof input.key !== 'string' || typeof input.secret !== 'string' ||
        !input.key.trim() || !input.secret.trim() || input.key.length > 512 || input.secret.length > 512) {
      throw new KiaanError('Valid API key and secret are required.', 400);
    }
    if (input.mode !== undefined && String(input.mode).toLowerCase() !== 'paper') {
      throw new KiaanError('LIVE trading does not exist for Kiaan Bot — paper is the only mode, by design. Connect paper keys.', 400);
    }
    return locked(uid, async lease => {
      ensure(uid);
      const next = { mode: 'paper', api_key_enc: vault.encrypt(input.key.trim()), api_secret_enc: vault.encrypt(input.secret.trim()) };
      const account = await request(next, '/v2/account');
      validateAccount(account);
      guard(lease);
      db.transaction(() => {
        if (quarantined(account.id)) throw new KiaanError('Broker account is quarantined.');
        const owner = db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at)
          VALUES (?,?,'kiaan',?,?) ON CONFLICT(account_id) DO UPDATE SET claimed_at=excluded.claimed_at
          WHERE broker_account_owners.user_id=excluded.user_id AND broker_account_owners.scope='kiaan'
            AND broker_account_owners.mode=excluded.mode`).run(account.id, uid, 'paper', timestamp());
        if (!owner.changes) throw new KiaanError('This broker account is already assigned to another user, mode or trading scope.');
        const old = credential(uid);
        db.prepare(`INSERT INTO kiaan_credentials(user_id,api_key_enc,api_secret_enc,mode,account_id) VALUES (?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET api_key_enc=excluded.api_key_enc,api_secret_enc=excluded.api_secret_enc,
            mode=excluded.mode,account_id=excluded.account_id`)
          .run(uid, next.api_key_enc, next.api_secret_enc, 'paper', account.id);
        release(uid, old);
        // Kiaan ships DISABLED: connecting stores credentials only. Johnny
        // enables the bot himself in the UI.
        db.prepare("UPDATE kiaan_settings SET mode='paper',scheduler_status='idle',scheduler_reason=NULL,updated_at=? WHERE user_id=?")
          .run(timestamp(), uid);
        automaticBotSettings?.revoke?.(uid, 'kiaan');
      })();
      return { ok: true, accountId: account.id };
    });
  }
  async function disconnect(uid) {
    return locked(uid, async () => {
      ensure(uid);
      const live = db.prepare(`SELECT 1 FROM kiaan_positions
        WHERE user_id=? AND status IN ('open','pending_entry') LIMIT 1`).get(uid);
      if (live) throw new KiaanError('Close or flatten all Kiaan Bot positions (including pending entries) before disconnecting.');
      const rows = db.prepare('SELECT * FROM kiaan_credentials WHERE user_id=?').all(uid);
      db.transaction(() => {
        db.prepare('DELETE FROM kiaan_credentials WHERE user_id=?').run(uid);
        rows.forEach(row => release(uid, row));
        db.prepare('UPDATE kiaan_settings SET enabled=0,updated_at=? WHERE user_id=?').run(timestamp(), uid);
      })();
      return { ok: true };
    });
  }

  // Rule type map for setSettings: every DEFAULT_KIAAN_RULES key is
  // accepted; anything else is rejected as unknown. 'clock' = "HH:MM" (24h).
  // tradingMode accepts PAPER only — there is no live mode to switch to.
  const RULE_TYPES = {
    orMinutes: [5, 15, 30],
    entryWindowStart: 'clock', entryWindowEnd: 'clock', flattenTime: 'clock',
    minPrice: 'number', maxPrice: 'number', minAvgVolume: 'number', maxSpreadPct: 'number',
    hedgeSymbols: 'text',
    longUniverse: 'text',
    sleeveEnabled: 'boolean',
    sleeveSymbols: 'text',
    sleeveMaxPositions: 'number',
    hedgeOnly: 'boolean',
    exitAtrTimeframe: ['15m', 'daily'],
    minRelStrengthPct: 'number', minRvol: 'number',
    maxExtensionAtrs: 'number', maxDayGainPct: 'number',
    sizingMode: ['dollars', 'risk'],
    fixedDollars: 'number', maxRiskPerTradeDollars: 'number', atrStopMult: 'number',
    targets: 'targets', breakevenR: 'number', maxPositions: 'number',
    maxDailyLossPct: 'number', maxConsecutiveLosses: 'number', maxTradesPerDay: 'number',
    tradingMode: ['PAPER'],
    // Regime thresholds (owned by lib/kiaan/regime.js)
    spyStrongPct: 'number', spyWeakPct: 'number', qqqStrongPct: 'number', qqqWeakPct: 'number',
    vixCalm: 'number', vixElevated: 'number', vixHigh: 'number', vixPanic: 'number',
    vixSpikePct: 'number', hardDownPct: 'number',
    breadthStrongPct: 'number', breadthWeakPct: 'number',
    oilSpikePct: 'number', yieldSpikeBps: 'number',
    riskOnScore: 'number', riskOffScore: 'number',
    guardYieldMin: 'number', guardBrentMin: 'number',
  };
  function setSettings(uid, input) {
    validateInput(input, ['enabled', 'rules'], 'Only enabled and rules may be changed.');
    return locked(uid, async () => {
      const current = ensure(uid);
      const rules = { ...getRules(uid) };
      const patch = input.rules && typeof input.rules === 'object' ? input.rules : {};
      for (const [key, rawValue] of Object.entries(patch)) {
        const type = RULE_TYPES[key];
        if (!type) throw new KiaanError(`Unknown setting: ${key}.`, 400);
        const value = rawValue;
        if (Array.isArray(type)) {
          if (!type.includes(value)) throw new KiaanError(`${key} must be one of ${type.join(', ')}.`, 400);
        } else if (type === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new KiaanError(`${key} must be a finite number.`, 400);
        } else if (type === 'boolean') {
          if (typeof value !== 'boolean') throw new KiaanError(`${key} must be a boolean (true or false).`, 400);
        } else if (type === 'clock') {
          if (typeof value !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) {
            throw new KiaanError(`${key} must be a clock time like "09:45".`, 400);
          }
        } else if (type === 'text') {
          if (typeof value !== 'string' || value.length > 512) throw new KiaanError(`${key} must be a short string.`, 400);
        } else if (type === 'targets') {
          if (!Array.isArray(value) || !value.length) throw new KiaanError('targets must be a non-empty array of {r, pct}.', 400);
          rules.targets = value.map(t => ({ r: +t.r, pct: +t.pct }));
          continue;
        }
        rules[key] = value;
      }
      // Full engine validation on the merged rules (window order, band
      // order, targets, paper-only, everything).
      const validation = validateConfig(rules);
      if (!validation.ok) {
        throw new KiaanError(`Invalid Kiaan configuration: ${validation.errors.join(' | ')}`, 400);
      }
      const enabled = input.enabled === undefined ? !!current.enabled : !!input.enabled;
      db.prepare('UPDATE kiaan_settings SET enabled=?,rules=?,revision=revision+1,updated_at=? WHERE user_id=?')
        .run(Number(enabled), JSON.stringify(mergedKiaanRules(rules)), timestamp(), uid);
      return status(uid);
    });
  }
  function getSettingsView(uid) {
    const settings = ensure(uid);
    return {
      enabled: !!settings.enabled, mode: settings.mode, rules: getRules(uid),
      revision: settings.revision || 0,
      liveNote: 'Kiaan Bot is paper-only by design: mergedKiaanRules() forces tradingMode PAPER and there is no live connect or live order path. Moving it live would require changing code, not flipping a setting.',
    };
  }
  function openPositions(uid) {
    return db.prepare("SELECT * FROM kiaan_positions WHERE user_id=? AND status IN ('open','pending_entry') ORDER BY opened_at").all(uid);
  }
  function setSchedulerState(uid, statusValue, reason) {
    db.prepare(`INSERT INTO kiaan_settings(user_id,scheduler_status,scheduler_reason,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET scheduler_status=excluded.scheduler_status,
        scheduler_reason=excluded.scheduler_reason,updated_at=excluded.updated_at`)
      .run(uid, statusValue, reason || null, timestamp());
  }
  async function status(uid) {
    const settings = ensure(uid);
    const cred = credential(uid);
    let account = null;
    if (cred) {
      try { account = await request(cred, '/v2/account'); }
      catch (_) { account = null; /* status must never throw on a broker hiccup */ }
    }
    const openCount = db.prepare("SELECT COUNT(*) AS n FROM kiaan_positions WHERE user_id=? AND status IN ('open','pending_entry')").get(uid)?.n || 0;
    const blockers = [];
    if (!cred) blockers.push('Connect a dedicated Kiaan Bot paper account.');
    if (!settings.enabled) blockers.push('Kiaan Bot is paused.');
    return {
      enabled: !!settings.enabled, mode: settings.mode, connected: !!cred,
      tradingMode: 'PAPER',
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
    db.prepare(`INSERT INTO kiaan_trades(trade_id,user_id,${cols},created_at) VALUES (?,?,${placeholders},?)`)
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
    const closed = db.prepare(`SELECT * FROM kiaan_trades WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`).all(...args);
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
    return { alerts: db.prepare('SELECT kind,message,created_at AS createdAt FROM kiaan_alerts WHERE user_id=? ORDER BY id DESC LIMIT 200').all(uid) };
  }
  function safeJson(value, fallback) {
    try { const parsed = JSON.parse(value); return parsed ?? fallback; } catch (_) { return fallback; }
  }

  // ---------------------------------------------------------------------------
  // Decisions journal — EVERY session stance and candidate decision is
  // persisted with its reasons (spec §6). Session rows upsert per
  // (day, regime, stance) so a stance change starts a fresh row; candidate
  // rows upsert per (day, symbol) with the latest evaluation — the same
  // lean retention model as ORB's candidates/rejected tables.
  // ---------------------------------------------------------------------------
  function recordSessionDecision(uid, tradeDate, session, cls) {
    const dkey = `SESSION:${session.regime}:${session.stance}`;
    db.prepare(`INSERT INTO kiaan_decisions(user_id,dkey,trade_date,kind,symbol,decision,regime,reasons,why,data,created_at,updated_at)
      VALUES (?,?,?,'session','SESSION',?,?,?,?,?,?,?)
      ON CONFLICT(user_id,trade_date,dkey) DO UPDATE SET decision=excluded.decision,regime=excluded.regime,
        reasons=excluded.reasons,why=excluded.why,data=excluded.data,updated_at=excluded.updated_at`)
      .run(uid, dkey, tradeDate, session.stance, session.regime,
        JSON.stringify(session.reasons || []), session.why,
        JSON.stringify({ score: session.score, locked: session.locked, guardActive: session.guardActive === true, hedgeOnly: session.hedgeOnly === true, longUniverseSize: session.longUniverseSize ?? null, inputs: cls?.inputs || null }),
        timestamp(), timestamp());
  }
  function recordCandidateDecision(uid, tradeDate, decision, features, sleeve = false) {
    // Sleeve decisions journal under their own dkey so a sleeve name that
    // is also a long-universe name keeps both books' records distinct.
    const dkey = sleeve ? `CAND:SLEEVE:${decision.symbol}` : `CAND:${decision.symbol}`;
    db.prepare(`INSERT INTO kiaan_decisions(user_id,dkey,trade_date,kind,symbol,decision,regime,reasons,why,data,created_at,updated_at)
      VALUES (?,?,?,'candidate',?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,trade_date,dkey) DO UPDATE SET decision=excluded.decision,regime=excluded.regime,
        reasons=excluded.reasons,why=excluded.why,data=excluded.data,updated_at=excluded.updated_at`)
      .run(uid, dkey, tradeDate, decision.symbol, decision.decision, decision.regime,
        JSON.stringify(decision.reasons || []), decision.why,
        JSON.stringify({ sleeve: !!sleeve, features: features || null, entry: decision.entry, stop: decision.stop, targets: decision.targets, size: decision.size, exitGeometry: decision.exitGeometry || null }),
        timestamp(), timestamp());
  }
  function journal(uid, query = {}) {
    const tradeDate = typeof query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.date)
      ? query.date : easternDate(now());
    const rows = db.prepare(`SELECT kind,symbol,decision,regime,reasons,why,data,created_at AS createdAt,updated_at AS updatedAt
      FROM kiaan_decisions WHERE user_id=? AND trade_date=? ORDER BY kind DESC, symbol`).all(uid, tradeDate)
      .map(r => ({ ...r, reasons: safeJson(r.reasons, []), data: safeJson(r.data, {}) }));
    return { tradeDate, decisions: rows };
  }
  function universe(uid) {
    const tradeDate = easternDate(now());
    const rows = db.prepare(`SELECT symbol, decision, regime, updated_at AS updatedAt FROM kiaan_decisions
      WHERE user_id=? AND trade_date=? AND kind='candidate' ORDER BY symbol`).all(uid, tradeDate);
    return { universe: rows, total: rows.length, tradeDate };
  }

  // ---------------------------------------------------------------------------
  // Day state — keyed by ET date; feeds the engine's daily locks.
  // { pnl (realized $), trades, consecLosses, wins, losses, exposureDollars,
  //   tradesBySymbol }
  // ---------------------------------------------------------------------------
  function freshDayState(tradeDate) {
    return {
      date: tradeDate, pnl: 0, trades: 0, consecLosses: 0, wins: 0, losses: 0,
      exposureDollars: 0, tradesBySymbol: {},
      // Sleeve-local counters (2026-10-16): the sleeve's locks judge the
      // sleeve's own record, and the incumbent view subtracts these, so
      // neither book's locks ever see the other book's activity.
      sleeveTrades: 0, sleevePnl: 0, sleeveConsecLosses: 0,
    };
  }
  function getDayState(uid, tradeDate) {
    const row = db.prepare('SELECT state FROM kiaan_day_state WHERE user_id=? AND trade_date=?').get(uid, tradeDate);
    if (row) {
      try {
        const parsed = JSON.parse(row.state || '{}');
        return { ...freshDayState(tradeDate), ...parsed };
      } catch (_) { /* fall through to fresh */ }
    }
    return freshDayState(tradeDate);
  }
  function saveDayState(uid, dayState) {
    db.prepare(`INSERT INTO kiaan_day_state(user_id,trade_date,state,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id,trade_date) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
      .run(uid, dayState.date, JSON.stringify(dayState), timestamp());
  }
  // Engine-facing day state: dailyPnlPct is realized P&L vs account equity.
  // With no trustworthy equity it stays null and the engine's daily-loss
  // lock simply does not evaluate (the scan cycle always has real equity;
  // the stored-data dashboard may not).
  // Engine-facing day state — the INCUMBENT book's view (2026-10-16):
  // open positions, trade count, realized P&L and loss streak all exclude
  // the sleeve, so a sleeve position can never consume an incumbent slot
  // or trip an incumbent lock (zero displacement, strategy-lab Test 10).
  // consecutiveLosses is incumbent-only by construction: sleeve closes
  // update sleeveConsecLosses instead (finalizeClosedPosition). Day
  // states written before the sleeve ship carry zero sleeve counters, so
  // this view is exactly the old one until the sleeve first trades.
  function engineDayState(uid, tradeDate, equity) {
    const ds = getDayState(uid, tradeDate);
    const open = db.prepare("SELECT COUNT(*) AS n FROM kiaan_positions WHERE user_id=? AND status IN ('open','pending_entry') AND sleeve=0").get(uid)?.n || 0;
    const incumbentPnl = (ds.pnl || 0) - (ds.sleevePnl || 0);
    const dailyPnlPct = Number.isFinite(equity) && equity > 0
      ? (incumbentPnl / equity) * 100
      : null;
    return {
      openPositions: open, tradesToday: Math.max(0, (ds.trades || 0) - (ds.sleeveTrades || 0)),
      dailyPnlPct, consecutiveLosses: ds.consecLosses || 0,
    };
  }
  // The sleeve's own engine-facing day state: its open count, its trades,
  // its realized P&L against account equity, its loss streak — the
  // sleeve-local dayState the lab sim judged the sleeve book against.
  function engineSleeveDayState(uid, tradeDate, equity) {
    const ds = getDayState(uid, tradeDate);
    const open = db.prepare("SELECT COUNT(*) AS n FROM kiaan_positions WHERE user_id=? AND status IN ('open','pending_entry') AND sleeve=1").get(uid)?.n || 0;
    const dailyPnlPct = Number.isFinite(equity) && equity > 0
      ? ((ds.sleevePnl || 0) / equity) * 100
      : null;
    return {
      openPositions: open, tradesToday: ds.sleeveTrades || 0,
      dailyPnlPct, consecutiveLosses: ds.sleeveConsecLosses || 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Market data — guarded broker paths with the SIP→IEX fallback in
  // request() (mirrors ORB), plus Yahoo Finance macro reads.
  // ---------------------------------------------------------------------------
  async function marketSession(ctx) {
    // Calendar-backed session check: ET-minutes alone would claim "regular"
    // on a Saturday. Kiaan trades the regular session only (09:30–16:00 ET).
    const today = easternDate(now());
    const calendar = await broker(ctx, `/v2/calendar?start=${today}&end=${today}`);
    if (!Array.isArray(calendar)) {
      throw new KiaanError('Broker calendar is unavailable; market-hours state is unknown.');
    }
    if (!calendar.length || !calendar[0]?.date) {
      const closed = new KiaanError('Market is closed today.');
      closed.marketClosed = true;
      throw closed;
    }
    const clock = await broker(ctx, '/v2/clock');
    const clockTime = Date.parse(clock?.timestamp);
    if (!Number.isFinite(clockTime) || Math.abs(now() - clockTime) > 120000) {
      throw new KiaanError('Broker clock is missing or stale.');
    }
    const mins = easternTimeMinutes(now());
    const inRegular = mins >= 570 && mins < 960;
    return { clock, session: calendar[0], windowOpen: inRegular, regularOpen: inRegular, minutes: mins };
  }
  // Flatten minute: the rules flattenTime (default 15:55 ET), or 5 minutes
  // before an early close (calendar close ≤ 13:00 ET).
  function eodFlattenMinutes(marketState, rules) {
    const close = parseClock(marketState?.session?.close, 16 * 60);
    if (close <= 13 * 60) return close - 5;
    return parseClock(rules?.flattenTime, 15 * 60 + 55);
  }
  function toEngineBars(raw) {
    return (Array.isArray(raw) ? raw : [])
      .map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }))
      .filter(b => Number.isFinite(b.t) && Number.isFinite(b.c))
      .sort((a, b) => a.t - b.t);
  }
  async function fetchDailyBars(ctx, symbols, sessions = 25) {
    // Day-scoped cache: daily bars are history (ATR / avg volume / prior
    // closes). Re-downloading ~400 symbols on every 60s cycle was the
    // main timeout bottleneck — only symbols not yet fetched for this
    // trade date hit the broker; a restart refetches once, which is fine.
    const tradeDate = easternDate(now());
    if (dailyBarsCache.date !== tradeDate) {
      dailyBarsCache.date = tradeDate;
      dailyBarsCache.bySymbol = new Map();
    }
    const out = {};
    const missing = [];
    for (const s of symbols) {
      const hit = dailyBarsCache.bySymbol.get(s);
      if (hit && hit.sessions === sessions) {
        out[s] = hit.bars;
        if (hit.feed) dailyBarsFeed = hit.feed;
      } else missing.push(s);
    }
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      guard(ctx.lease);
      const query = new URLSearchParams({
        symbols: chunk.join(','), timeframe: '1Day',
        start: new Date(now() - sessions * 2 * DAY_MS).toISOString(),
        end: new Date(now()).toISOString(),
        limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc',
      });
      const feedRef = {};
      const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true, feedRef });
      if (!data?.bars || typeof data.bars !== 'object') throw new KiaanError('Historical daily bars are unavailable.');
      if (feedRef.feed) dailyBarsFeed = feedRef.feed;
      for (const s of chunk) {
        const bars = toEngineBars(data.bars[s]);
        dailyBarsCache.bySymbol.set(s, { sessions, bars, feed: feedRef.feed || null });
        out[s] = bars;
      }
    }
    for (const s of symbols) if (!(s in out)) out[s] = [];
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
      if (!data?.bars || typeof data.bars !== 'object') throw new KiaanError('Intraday minute bars are unavailable.');
      for (const s of chunk) out[s] = toEngineBars(data.bars[s]);
    }
    return out;
  }
  // 15-minute bars for ONE symbol (the intraday exit geometry). The
  // lookback covers ~10 calendar days so the ATR(14) series is seeded
  // from prior sessions, exactly like the lab sim; the day-scoped cache
  // keeps it to at most one fetch per symbol per 15-minute bucket, and
  // it is only ever called for a symbol that just decided enter-long.
  async function fetch15MinBars(ctx, symbol) {
    const tradeDate = easternDate(now());
    if (bars15Cache.date !== tradeDate) {
      bars15Cache.date = tradeDate;
      bars15Cache.bySymbol = new Map();
    }
    const hit = bars15Cache.bySymbol.get(symbol);
    if (hit && now() - hit.at < 15 * 60000) return hit.bars;
    guard(ctx.lease);
    const query = new URLSearchParams({
      symbols: symbol, timeframe: '15Min',
      start: new Date(now() - 10 * DAY_MS).toISOString(),
      end: new Date(now()).toISOString(),
      limit: '10000', adjustment: 'all', feed: 'sip', sort: 'asc',
    });
    const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
    if (!data?.bars || typeof data.bars !== 'object') throw new KiaanError('Intraday 15-minute bars are unavailable.');
    const bars = toEngineBars(data.bars[symbol]);
    bars15Cache.bySymbol.set(symbol, { at: now(), bars });
    return bars;
  }
  // Rebase an enter-long decision's MANAGED geometry (stop / targets)
  // onto ATR(14) of 15-minute bars when rules.exitAtrTimeframe is
  // '15m' (2026-10-11 rebuild). The decision's entry and SIZE are left
  // exactly as the engine computed them — sizing keeps the daily-ATR
  // stop, per the lab. When the 15m ATR is unavailable (fewer than 15
  // completed 15m bars) or cannot produce a valid stop, the daily
  // geometry stands and the fallback is journaled on the decision's
  // reasons (and in its exitGeometry record). Mutates and returns the
  // decision.
  async function rebaseExitGeometry(ctx, symbol, decision) {
    const rules = ctx.rules;
    if (!decision || decision.decision !== 'enter-long') return decision;
    if (String(rules.exitAtrTimeframe || 'daily') !== '15m') {
      decision.exitGeometry = { source: 'daily', atr15: null };
      return decision;
    }
    let atr15 = null;
    try {
      const bars = await fetch15MinBars(ctx, symbol);
      atr15 = atr15OfBars(bars, now());
    } catch (_) { atr15 = null; /* fail-soft: daily geometry + journal */ }
    const geo = atr15 !== null
      ? intradayExitGeometry({ entry: decision.entry, atr15, rules })
      : null;
    if (!geo) {
      decision.exitGeometry = { source: 'daily-fallback', atr15: null };
      decision.reasons.push(`EXIT_GEOMETRY_FALLBACK: 15-minute ATR unavailable for ${symbol} (fewer than 15 completed 15m bars or no valid intraday stop) — this position is managed on the daily-ATR geometry`);
      return decision;
    }
    decision.exitGeometry = { source: '15m', atr15: geo.atr15 };
    decision.reasons.push(`EXIT_GEOMETRY_15M: managed stop/targets rebased on ATR(14) 15m $${geo.atr15.toFixed(2)} — stop $${geo.stop.toFixed(2)}, R $${geo.risk.toFixed(2)}; share sizing unchanged (daily-ATR based)`);
    decision.stop = geo.stop;
    decision.targets = geo.targets;
    decision.why += ` Managed exit geometry is intraday: stop $${geo.stop.toFixed(2)} and targets ${geo.targets.map(t => `$${t.price.toFixed(2)} (${t.r}R, ${t.pct}%)`).join(' | ')} from ATR(14) on 15-minute bars.`;
    return decision;
  }
  async function fetchLatestBars(ctx, symbols) {
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

  // --- pure per-symbol derivations (local copies; engine stays pure) ------
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
    // Prior completed sessions only — today's forming bar is not an average.
    const ds = Array.isArray(daily) ? daily : [];
    const vols = ds.slice(0, -1).filter(b => Number.isFinite(+b.v)).slice(-lookback).map(b => +b.v);
    const fallback = ds.filter(b => Number.isFinite(+b.v)).slice(-lookback).map(b => +b.v);
    const use = vols.length >= 5 ? vols : fallback;
    return use.length ? use.reduce((a, b) => a + b, 0) / use.length : null;
  }
  function dayChangePct(daily) {
    const ds = Array.isArray(daily) ? daily : [];
    if (ds.length < 2) return null;
    const prev = ds[ds.length - 2]; const last = ds[ds.length - 1];
    if (!Number.isFinite(+prev.c) || !Number.isFinite(+last.c) || +prev.c <= 0) return null;
    return ((+last.c - +prev.c) / +prev.c) * 100;
  }
  // Daily bars come from the day-scoped cache, so the last bar (today's
  // forming daily bar) would freeze at the first cycle's close. Refresh
  // just that close from this cycle's fresh minute bars — no extra broker
  // call — so the regime's day-change vote stays live all session. If the
  // last daily bar is not today's (broker returned completed bars only),
  // the series is used untouched.
  function withLiveFormingClose(daily, minuteBars, tradeDate) {
    const ds = Array.isArray(daily) ? daily : [];
    if (!ds.length || !Array.isArray(minuteBars) || !minuteBars.length) return ds;
    const last = ds[ds.length - 1];
    if (easternDate(last.t) !== tradeDate) return ds;
    const close = +minuteBars[minuteBars.length - 1].c;
    if (!Number.isFinite(close) || close <= 0) return ds;
    return [...ds.slice(0, -1), { ...last, c: close }];
  }
  // Intraday trend from today's 1-minute bars: session drift of the last
  // close vs the first bar's open. ±0.05% dead-band → 'flat'.
  function intradayTrend(minuteBars) {
    const bars = Array.isArray(minuteBars) ? minuteBars : [];
    if (bars.length < 5) return null;
    const first = +bars[0].o; const last = +bars[bars.length - 1].c;
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
    const chg = ((last - first) / first) * 100;
    return chg > 0.05 ? 'up' : chg < -0.05 ? 'down' : 'flat';
  }
  // TIME-OF-DAY-SCALED relative volume (pace): today's per-minute volume
  // rate vs the name's average per-minute rate over a full session. This is
  // the fix for ORB's flawed cumulative/full-day ratio (2026-10-08): a name
  // trading at exactly its normal pace reads 1.0x at ANY time of day.
  function paceRvol(todayVolume, avgDailyVol, nowMs) {
    if (!Number.isFinite(todayVolume) || !Number.isFinite(avgDailyVol) || avgDailyVol <= 0) return null;
    const elapsed = Math.min(390, Math.max(1, easternTimeMinutes(nowMs) - 570));
    return (todayVolume / elapsed) / (avgDailyVol / 390);
  }
  // VWAP reclaim: price is above session VWAP now AND at least one earlier
  // bar closed below the (running) VWAP — a genuine reclaim, not a drift.
  function computeVwapReclaim(bars) {
    let pv = 0; let v = 0; let dippedBelow = false; let lastVwap = null;
    for (const b of bars) {
      if (![b.h, b.l, b.c, b.v].every(Number.isFinite)) continue;
      pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v;
      if (v <= 0) continue;
      lastVwap = pv / v;
      if (b.c < lastVwap) dippedBelow = true;
    }
    if (!bars.length || lastVwap === null) return { vwap: null, reclaimed: false };
    const lastClose = +bars[bars.length - 1].c;
    return { vwap: lastVwap, reclaimed: dippedBelow && lastClose > lastVwap };
  }

  // --- Yahoo macro reads (^VIX/^TNX/CL=F, plus BZ=F for the guard) --------
  async function fetchYahooCloses(symbol) {
    const cached = macroCache.get(symbol);
    if (cached && now() - cached.at < MACRO_CACHE_MS) return cached.closes;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const response = await fetchBroker(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QureshiFinance/1.0)' } });
    if (!response || !response.ok) throw new KiaanError(`Yahoo macro read failed for ${symbol} (HTTP ${response?.status ?? 'n/a'}).`);
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    const closes = (result?.indicators?.quote?.[0]?.close || [])
      .map(v => (Number.isFinite(+v) ? +v : null))
      .filter(v => v !== null);
    if (!closes.length) throw new KiaanError(`Yahoo macro read for ${symbol} returned no closes.`);
    macroCache.set(symbol, { at: now(), closes });
    return closes;
  }
  async function fetchMacroContext() {
    // VIX is a CORE regime input: if it cannot be read, the regime must
    // classify 'unknown' and the bot stands aside (fail closed, journaled).
    // 10Y/oil are optional stress votes — absent values are simply skipped
    // by the classifier. The relief-bounce guard also consumes ABSOLUTE
    // levels (10Y yield level from ^TNX, Brent level from BZ=F, both on
    // the same 5-minute Yahoo cache); a missing level leaves the guard
    // unevaluated and the score classification standing (fail-soft).
    const read = async symbol => {
      try { return await fetchYahooCloses(symbol); } catch (_) { return null; }
    };
    const [vixCloses, tnxCloses, oilCloses, brentCloses] = await Promise.all(
      [read('^VIX'), read('^TNX'), read('CL=F'), read('BZ=F')],
    );
    const lastTwo = closes => (closes && closes.length >= 2
      ? { last: closes[closes.length - 1], prev: closes[closes.length - 2] }
      : closes && closes.length === 1 ? { last: closes[0], prev: null } : null);
    const vixT = lastTwo(vixCloses);
    const tnxT = lastTwo(tnxCloses);
    const oilT = lastTwo(oilCloses);
    const brentT = lastTwo(brentCloses);
    return {
      vix: vixT ? {
        level: vixT.last,
        dayChangePct: vixT.prev ? ((vixT.last - vixT.prev) / vixT.prev) * 100 : null,
      } : null,
      rates: tnxT ? {
        tenYearChangeBps: tnxT.prev !== null ? (tnxT.last - tnxT.prev) * 100 : null, // ^TNX is quoted in %
        tenYearLevel: tnxT.last,
      } : null,
      oil: (oilT || brentT) ? {
        dayChangePct: oilT && oilT.prev ? ((oilT.last - oilT.prev) / oilT.prev) * 100 : null, // WTI (CL=F) drives the existing oil vote
        brentLevel: brentT ? brentT.last : null,
      } : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Dashboard — today's stance/regime (from the journaled session decision),
  // candidate decisions, day state, locks, positions, today's trades.
  // Stored data only: a dashboard read must never depend on the broker.
  // ---------------------------------------------------------------------------
  async function dashboard(uid) {
    const tradeDate = easternDate(now());
    const settings = ensure(uid);
    const rules = getRules(uid);
    const sessionRow = db.prepare(`SELECT decision,regime,reasons,why,data,updated_at AS updatedAt
      FROM kiaan_decisions WHERE user_id=? AND trade_date=? AND kind='session'
      ORDER BY updated_at DESC LIMIT 1`).get(uid, tradeDate);
    const sessionData = sessionRow ? safeJson(sessionRow.data, {}) : {};
    const candidates = db.prepare(`SELECT symbol,decision,regime,reasons,why,data,updated_at AS updatedAt
      FROM kiaan_decisions WHERE user_id=? AND trade_date=? AND kind='candidate' ORDER BY symbol`).all(uid, tradeDate)
      .map(r => ({ ...r, reasons: safeJson(r.reasons, []), data: safeJson(r.data, {}) }));
    const dayState = getDayState(uid, tradeDate);
    const locks = checkDailyLocks(engineDayState(uid, tradeDate, null), rules);
    const dayStart = new Date(easternDayStartMs(now())).toISOString();
    const todaysTrades = db.prepare('SELECT * FROM kiaan_trades WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 200')
      .all(uid, dayStart);
    return {
      tradeDate,
      status: {
        enabled: !!settings.enabled, mode: settings.mode, tradingMode: 'PAPER',
        schedulerStatus: settings.scheduler_status || 'idle',
        schedulerReason: settings.scheduler_reason || null,
        lastCycleAt: settings.updated_at || null,
      },
      session: sessionRow ? {
        stance: sessionRow.decision, regime: sessionRow.regime,
        score: sessionData.score ?? null, locked: !!sessionData.locked,
        reasons: safeJson(sessionRow.reasons, []), why: sessionRow.why,
        inputs: sessionData.inputs || null, updatedAt: sessionRow.updatedAt,
      } : null,
      candidates,
      dayState,
      locks,
      positions: openPositions(uid),
      todaysTrades,
    };
  }

  // ---------------------------------------------------------------------------
  // Entry gate — pre-trade checks right before an order goes out (fail
  // closed), plus order polling. Fills are never assumed.
  // ---------------------------------------------------------------------------
  function entryGate(ctx, rules, symbol, equity, { sleeve = false } = {}) {
    // Sleeve entries are gated against the sleeve's own day state and its
    // own slot count under the sleeve rules (maxPositions =
    // sleeveMaxPositions); incumbent entries keep the incumbent view.
    // The per-symbol POSITION_EXISTS check stays global: one symbol is
    // never held by both books at once.
    const locks = checkDailyLocks(
      sleeve ? engineSleeveDayState(ctx.uid, easternDate(now()), equity) : engineDayState(ctx.uid, easternDate(now()), equity),
      rules,
    );
    if (locks.locked) return { ok: false, reason: locks.reasons[0] };
    const openCount = db.prepare(`SELECT COUNT(*) AS n FROM kiaan_positions WHERE user_id=? AND status IN ('open','pending_entry') AND sleeve=${sleeve ? 1 : 0}`).get(ctx.uid)?.n || 0;
    if (openCount >= rules.maxPositions) {
      return { ok: false, reason: `MAX_POSITIONS: ${openCount} open/pending ${sleeve ? 'sleeve ' : ''}positions at the ${rules.maxPositions} cap` };
    }
    const existing = db.prepare("SELECT 1 FROM kiaan_positions WHERE user_id=? AND symbol=? AND status IN ('open','pending_entry')").get(ctx.uid, symbol);
    if (existing) return { ok: false, reason: `POSITION_EXISTS: ${symbol} already has an open or pending Kiaan position` };
    return { ok: true };
  }
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

  // ---------------------------------------------------------------------------
  // Broker-side protection — Warrior's model, ported: an OCO order covers
  // the FIRST target tranche (take-profit at the first R target, stop-loss
  // at the position stop) and a stop-only order covers the remainder (the
  // final R target is taken server-side). All prices go through tickPrice
  // with the same 5bps trigger/limit padding Warrior uses, so no sub-penny
  // price ever reaches Alpaca (the 2026-10-05 422 lesson). Client ids are
  // deterministic per position+tranche+tag, so a retry adopts the existing
  // order instead of stacking a second one.
  // ---------------------------------------------------------------------------
  // Attaches protection for every tranche whose status is 'none' (initial)
  // or 'replace' (after a breakeven cancel). The tranche split is computed
  // once, at the first attach, and stored on the position row; later
  // attaches reuse it. `tag` differentiates client order ids across
  // generations ('t1' initial, 'be' breakeven) — Warrior's pattern, since a
  // cancelled order's client id cannot be assumed reusable.
  async function attachProtection(ctx, pos, { stopPrice, tag = 't1' }) {
    const targets = safeJson(pos.targets_json, []);
    const firstTarget = targets.length ? targets[0] : null;
    let t1Qty = pos.t1_qty || 0;
    let t2Qty = pos.t2_qty || 0;
    if (!(t1Qty > 0) && !(t2Qty > 0)) {
      t1Qty = pos.shares;
      if (firstTarget && targets.length > 1) {
        t1Qty = Math.floor(pos.shares * (number(firstTarget.pct) || 0) / 100);
        if (t1Qty < 1) t1Qty = pos.shares; // too small to split: OCO covers all
      }
      t2Qty = pos.shares - t1Qty;
    }
    const updates = {
      t1_qty: t1Qty, t2_qty: t2Qty,
      t1_status: pos.t1_status || 'none', t2_status: pos.t2_status || 'none',
      oco_id: pos.oco_id || null, stop_order_id: pos.stop_order_id || null,
    };
    if (t1Qty > 0 && firstTarget && (updates.t1_status === 'none' || updates.t1_status === 'replace')) {
      const ocoId = `kiaan-oco-${pos.position_id}-${tag}`;
      const existing = await orderByClient(ctx, ocoId);
      if (existing && !TERMINAL.has(String(existing.status || '').toLowerCase())) {
        updates.oco_id = ocoId; updates.t1_status = 'protected';
      } else if (existing && TERMINAL.has(String(existing.status || '').toLowerCase())) {
        throw new KiaanError('A previous Kiaan protection order already completed; position is closing via the broker.');
      } else {
        const parent = await broker(ctx, '/v2/orders', {
          method: 'POST',
          body: {
            symbol: pos.symbol, qty: t1Qty, side: 'sell', type: 'limit',
            time_in_force: 'day', order_class: 'oco',
            take_profit: { limit_price: tickPrice(firstTarget.price * 0.9995) },
            stop_loss: { stop_price: tickPrice(stopPrice * 1.0005) },
            client_order_id: ocoId,
          },
        });
        if (!parent?.id) throw new KiaanError('Broker did not return the Kiaan protection order.');
        updates.oco_id = ocoId; updates.t1_status = 'protected';
      }
    }
    if (t2Qty > 0 && (updates.t2_status === 'none' || updates.t2_status === 'replace')) {
      const stopId = `kiaan-stop-${pos.position_id}-${tag}`;
      const existing = await orderByClient(ctx, stopId);
      if (existing && !TERMINAL.has(String(existing.status || '').toLowerCase())) {
        updates.stop_order_id = stopId; updates.t2_status = 'protected';
      } else if (existing && TERMINAL.has(String(existing.status || '').toLowerCase())) {
        throw new KiaanError('A previous Kiaan stop order already completed; position is closing via the broker.');
      } else {
        const order = await broker(ctx, '/v2/orders', {
          method: 'POST',
          body: {
            symbol: pos.symbol, qty: t2Qty, side: 'sell', type: 'stop',
            time_in_force: 'day', stop_price: tickPrice(stopPrice * 1.0005),
            client_order_id: stopId,
          },
        });
        if (!order?.id) throw new KiaanError('Broker did not return the Kiaan stop order.');
        updates.stop_order_id = stopId; updates.t2_status = 'protected';
      }
    }
    db.prepare(`UPDATE kiaan_positions SET t1_qty=?, t2_qty=?, t1_status=?, t2_status=?, oco_id=?, stop_order_id=?, updated_at=? WHERE position_id=?`)
      .run(updates.t1_qty, updates.t2_qty, updates.t1_status, updates.t2_status, updates.oco_id, updates.stop_order_id, timestamp(), pos.position_id);
    Object.assign(pos, updates);
    return updates;
  }
  async function cancelProtectionOrder(ctx, clientOrderId) {
    if (!clientOrderId) return true;
    const order = await orderByClient(ctx, clientOrderId).catch(() => null);
    if (!order) return true;
    if (TERMINAL.has(String(order.status || '').toLowerCase())) return true;
    await cancelOrderById(ctx, order.id);
    const recheck = await orderByClient(ctx, clientOrderId).catch(() => null);
    return !recheck || TERMINAL.has(String(recheck.status || '').toLowerCase());
  }
  async function cancelAllProtection(ctx, pos) {
    // Best-effort: returns false when something protective may still be
    // live, in which case callers must not submit a competing exit.
    let ok = true;
    if (pos.t1_status === 'protected') ok = (await cancelProtectionOrder(ctx, pos.oco_id)) && ok;
    if (pos.t2_status === 'protected') ok = (await cancelProtectionOrder(ctx, pos.stop_order_id)) && ok;
    return ok;
  }

  // Record one tranche's exit on the position row and in the day state.
  // Returns the refreshed position row.
  function recordTrancheExit(uid, pos, tranche, exitPrice, qty, reason) {
    const pnl = (exitPrice - pos.entry_price) * qty; // longs only, by design
    const realized = (pos.realized_pnl || 0) + pnl;
    const proceeds = (pos.exit_proceeds || 0) + exitPrice * qty;
    const exited = (pos.exited_shares || 0) + qty;
    const remaining = Math.max(0, (pos.shares || 0) - qty);
    const statusCol = tranche === 't1' ? 't1_status' : 't2_status';
    let partials = safeJson(pos.partials_taken, []);
    if (tranche === 't1' && reason === 'target') {
      const firstR = +(safeJson(pos.targets_json, [])[0]?.r);
      if (Number.isFinite(firstR) && !partials.includes(firstR)) partials = [...partials, firstR];
    }
    db.prepare(`UPDATE kiaan_positions SET realized_pnl=?, exit_proceeds=?, exited_shares=?, shares=?,
      ${statusCol}=?, partials_taken=?, updated_at=? WHERE position_id=?`)
      .run(realized, proceeds, exited, remaining,
        reason === 'target' ? 'target' : 'closed',
        JSON.stringify(partials),
        timestamp(), pos.position_id);
    let dayState = getDayState(uid, easternDate(now()));
    dayState.pnl = (dayState.pnl || 0) + pnl;
    if (pos.sleeve) dayState.sleevePnl = (dayState.sleevePnl || 0) + pnl;
    saveDayState(uid, dayState);
    alert(uid, 'exit', `Kiaan ${reason === 'target' ? 'target' : 'exit'} ${pos.symbol}: ${qty} sh @ $${exitPrice.toFixed(2)} (${reason}) — tranche P&L $${pnl.toFixed(2)}.`);
    return db.prepare('SELECT * FROM kiaan_positions WHERE position_id=?').get(pos.position_id);
  }
  // Fully close a position whose shares have all exited: finalize the
  // journal trade row with the blended exit price and total P&L, update
  // win/loss streaks, and drop the position row.
  function finalizeClosedPosition(uid, pos, exitReason) {
    const entryShares = pos.entry_shares || pos.exited_shares || 0;
    const exitPrice = entryShares > 0 ? pos.exit_proceeds / entryShares : pos.entry_price;
    const pnl = pos.realized_pnl || 0;
    const riskPerShare = Math.abs(pos.entry_price - (pos.initial_stop_price ?? pos.stop_price));
    const rMultiple = riskPerShare > 0 && entryShares > 0 ? pnl / (riskPerShare * entryShares) : 0;
    if (pos.trade_id) {
      db.prepare('UPDATE kiaan_trades SET "exitPrice"=?, "pnl"=?, "rMultiple"=?, "exitReason"=?, "closedAt"=? WHERE trade_id=?')
        .run(String(+exitPrice.toFixed(4)), String(+pnl.toFixed(2)), String(+rMultiple.toFixed(4)),
          `${exitReason}: blended exit $${exitPrice.toFixed(2)} on ${entryShares} sh`, timestamp(), pos.trade_id);
    }
    db.prepare('DELETE FROM kiaan_positions WHERE position_id=?').run(pos.position_id);
    let dayState = getDayState(uid, easternDate(now()));
    if (pnl > 0) { dayState.wins = (dayState.wins || 0) + 1; }
    else if (pnl < 0) { dayState.losses = (dayState.losses || 0) + 1; }
    // The loss streak that feeds the engine's locks is per-book: a sleeve
    // close moves only the sleeve streak, an incumbent close only the
    // incumbent streak (zero cross-book displacement, Test 10).
    if (pos.sleeve) {
      if (pnl > 0) dayState.sleeveConsecLosses = 0;
      else if (pnl < 0) dayState.sleeveConsecLosses = (dayState.sleeveConsecLosses || 0) + 1;
    } else {
      if (pnl > 0) dayState.consecLosses = 0;
      else if (pnl < 0) dayState.consecLosses = (dayState.consecLosses || 0) + 1;
    }
    dayState.exposureDollars = Math.max(0, (dayState.exposureDollars || 0) - pos.entry_price * entryShares);
    saveDayState(uid, dayState);
    alert(uid, 'exit', `Kiaan position closed ${pos.symbol} — P&L $${pnl.toFixed(2)} (${rMultiple.toFixed(2)}R).`);
    return { exitPrice, pnl, rMultiple };
  }

  async function finalizeEntryFromOrder(ctx, pos, seen, { res = null, meta = null, tradeDate } = {}) {
    const { uid } = ctx;
    const st = String(seen?.status || '').toLowerCase();
    const filledQty = Math.abs(Math.round(number(seen?.filled_qty) || 0));
    const qty = Math.abs(Math.round(number(seen?.qty) || pos.shares || 0));
    const avgPrice = number(seen?.filled_avg_price);
    const filled = (st === 'filled' || (qty > 0 && filledQty >= qty)) && filledQty > 0 && Number.isFinite(avgPrice);
    if (filled) {
      db.prepare("UPDATE kiaan_positions SET status='open', entry_price=?, shares=?, entry_shares=?, updated_at=? WHERE position_id=?")
        .run(avgPrice, filledQty, filledQty, timestamp(), pos.position_id);
      const fresh = db.prepare('SELECT * FROM kiaan_positions WHERE position_id=?').get(pos.position_id);
      let tradeId = pos.trade_id;
      if (!tradeId) {
        const rec = buildTradeRecord({
          direction: 'long', entryTime: timestamp(), symbol: pos.symbol,
          regime: meta?.regime ?? null, regimeScore: meta?.regimeScore ?? null,
          relStrength: meta?.features?.relStrengthPct ?? null,
          rvol: meta?.features?.rvol ?? null, atr: meta?.features?.atr ?? null,
          orHigh: meta?.features?.orHigh ?? null, orLow: meta?.features?.orLow ?? null,
          vwap: meta?.features?.vwap ?? null,
          size: filledQty, entryPrice: avgPrice, stopPrice: res?.stop ?? pos.stop_price,
          targets: res?.targets ? JSON.stringify(res.targets) : pos.targets_json,
          riskDollars: res?.size?.riskDollars ?? null,
          entryReason: (pos.sleeve ? 'SLEEVE: ' : '') + (res?.why || 'reconciled broker fill'),
          createdAt: timestamp(), closedAt: null,
        });
        tradeId = insertTrade(uid, rec);
        db.prepare('UPDATE kiaan_positions SET trade_id=? WHERE position_id=?').run(tradeId, pos.position_id);
        fresh.trade_id = tradeId;
      }
      let dayState = getDayState(uid, tradeDate);
      dayState.trades = (dayState.trades || 0) + 1;
      if (pos.sleeve) dayState.sleeveTrades = (dayState.sleeveTrades || 0) + 1;
      dayState.tradesBySymbol = { ...(dayState.tradesBySymbol || {}) };
      dayState.tradesBySymbol[pos.symbol] = (dayState.tradesBySymbol[pos.symbol] || 0) + 1;
      dayState.exposureDollars = (dayState.exposureDollars || 0) + avgPrice * filledQty;
      saveDayState(uid, dayState);
      alert(uid, 'entry', `Kiaan entry ${pos.symbol} long ${filledQty} sh @ $${avgPrice} (${meta?.regime || 'regime n/a'}).`);
      // Broker-side protection goes on immediately; a failure here leaves
      // the position OPEN but loudly alerted — the server-side stop
      // backstop in managePositions still guards it every tick.
      try {
        await attachProtection(ctx, fresh, { stopPrice: fresh.stop_price });
      } catch (error) {
        alert(uid, 'risk', `Kiaan ${pos.symbol}: protection attach FAILED (${error.message}) — position is UNPROTECTED at the broker; server-side stop management is the only guard. Will retry next tick.`);
      }
      return 'open';
    }
    if (TERMINAL.has(st) && filledQty === 0) {
      db.prepare('DELETE FROM kiaan_positions WHERE position_id=?').run(pos.position_id);
      alert(uid, 'system', `Kiaan entry ${pos.symbol} ${st} with no fill — working order removed.`);
      return 'dead';
    }
    if (filledQty > 0 && filledQty < qty) {
      db.prepare('UPDATE kiaan_positions SET shares=?, updated_at=? WHERE position_id=?')
        .run(qty - filledQty, timestamp(), pos.position_id);
    }
    return 'pending';
  }

  async function submitEntry(ctx, tradeDate, symbol, res, meta) {
    const { uid } = ctx;
    // Fail closed on stale decision data.
    const barsAge = now() - (meta.lastBarT || 0);
    if (!Number.isFinite(meta.lastBarT) || barsAge > BAR_FRESH_MS) {
      throw new KiaanError(`Stale market data for ${symbol}; entry withheld.`);
    }
    const id = clientId(uid, tradeDate, symbol, res.decision, String(Math.round(res.entry * 10000)), String(now()));
    const dupOrder = await orderByClient(ctx, id).catch(() => null);
    if (dupOrder && !TERMINAL.has(String(dupOrder.status || '').toLowerCase())) {
      throw new KiaanError(`Duplicate entry suppressed: a working broker order already exists for ${symbol}.`);
    }
    const dupLocal = db.prepare('SELECT 1 FROM kiaan_positions WHERE user_id=? AND entry_client_order_id=?').get(uid, id);
    if (dupLocal) throw new KiaanError(`Duplicate entry suppressed: ${symbol} entry already tracked.`);
    const order = await broker(ctx, '/v2/orders', {
      method: 'POST',
      body: {
        symbol, qty: res.size.shares, side: 'buy', type: 'limit', time_in_force: 'day',
        limit_price: tickPrice(res.entry), client_order_id: id,
      },
    });
    const positionId = crypto.randomUUID();
    db.prepare(`INSERT INTO kiaan_positions(position_id,user_id,trade_id,symbol,direction,entry_client_order_id,
      entry_price,shares,entry_shares,stop_price,initial_stop_price,targets_json,breakeven_at,partials_taken,status,sleeve,opened_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(positionId, uid, null, symbol, 'long', id, res.entry, res.size.shares, res.size.shares,
        res.stop, res.stop, JSON.stringify(res.targets || []), 0, '[]', 'pending_entry', meta?.sleeve ? 1 : 0, timestamp(), timestamp());
    const pos = db.prepare('SELECT * FROM kiaan_positions WHERE position_id=?').get(positionId);
    const seen = await pollOrderFill(ctx, id, order);
    return finalizeEntryFromOrder(ctx, pos, seen, { res, meta, tradeDate });
  }

  async function reconcilePending(ctx, pos) {
    const tradeDate = easternDate(now());
    const seen = await orderByClient(ctx, pos.entry_client_order_id).catch(() => null);
    if (!seen) {
      alert(ctx.uid, 'system', `Kiaan pending entry ${pos.symbol}: broker order state unknown — no action, reconciliation required.`);
      return;
    }
    await finalizeEntryFromOrder(ctx, pos, seen, { tradeDate });
  }

  // A bot market exit already working at the broker for this position
  // (e.g. an EOD sell submitted after the close and held by the broker
  // for the next session — the 2026-10-12 SOXS pattern) must never be
  // stacked with a second sell: Alpaca holds the shares for the first
  // order and rejects every duplicate with "insufficient qty available",
  // forever. Protection orders (oco/stop client ids) are not exits.
  // Fail-closed: an unreadable open-orders list withholds the exit.
  async function workingExitOrder(ctx, pos) {
    const orders = await broker(ctx, `/v2/orders?status=open&symbols=${encodeURIComponent(pos.symbol)}`);
    if (!Array.isArray(orders)) throw new KiaanError(`Open-order state for ${pos.symbol} is unreadable; exit withheld.`);
    return orders.find(o => o && String(o.symbol || '').toUpperCase() === pos.symbol
      && String(o.side || '').toLowerCase() === 'sell'
      && String(o.type || '').toLowerCase() === 'market'
      && !TERMINAL.has(String(o.status || '').toLowerCase())
      && !String(o.client_order_id || '').startsWith('kiaan-oco-')
      && !String(o.client_order_id || '').startsWith('kiaan-stop-')) || null;
  }

  // Market-sell `qty` shares of an open position (targets, stop backstop,
  // EOD). Protection for the shares being sold must already be cancelled
  // by the caller. Returns the confirmed exit price or throws (fail closed).
  async function marketExit(ctx, pos, qty, reason) {
    const working = await workingExitOrder(ctx, pos);
    if (working) {
      throw new KiaanError(`Exit for ${pos.symbol} is already working at the broker (held order ${working.id || 'unknown'}); a duplicate exit is withheld — its fill will be reconciled from broker records.`);
    }
    const cid = clientId(ctx.uid, 'exit', pos.position_id, reason, String(now()));
    const order = await broker(ctx, '/v2/orders', {
      method: 'POST',
      body: { symbol: pos.symbol, qty, side: 'sell', type: 'market', time_in_force: 'day', client_order_id: cid },
    });
    const seen = await pollOrderFill(ctx, cid, order);
    const exitPrice = number(seen?.filled_avg_price);
    const filledQty = Math.abs(Math.round(number(seen?.filled_qty) || 0));
    if (!Number.isFinite(exitPrice) || filledQty <= 0) {
      alert(ctx.uid, 'risk', `Kiaan exit (${reason}) for ${pos.symbol} has uncertain fill state — position kept, reconciliation required.`);
      throw new KiaanError(`Exit order for ${pos.symbol} has uncertain fill state; reconciliation required.`);
    }
    return { exitPrice, filledQty: Math.min(filledQty, qty) };
  }

  // An OCO parent order is NOT itself 'filled' when one of its legs
  // fills: Alpaca reports the fill on the leg (parent.legs[]) while the
  // parent's own status/filled_qty stay non-terminal. Checking only the
  // parent was the 2026-10-12 SQQQ defect — the t2 stop-only parent DID
  // report 'filled' and booked (+$0.07), but the t1 OCO stop leg's fill
  // was invisible to the old check, so 7 sh stayed tracked against a
  // flat broker account and alerted forever. Warrior's ocoFilledLeg
  // pattern is the proven model: legs first, parent second.
  function ocoFilledLeg(order) {
    const legs = Array.isArray(order?.legs) ? order.legs : [];
    for (const leg of legs) {
      if (leg && String(leg.status || '').toLowerCase() === 'filled'
        && Math.abs(Math.round(number(leg.filled_qty) || 0)) > 0
        && Number.isFinite(number(leg.filled_avg_price))) return leg;
    }
    return null;
  }
  function trancheExitReason(orderLike, pos) {
    const type = String(orderLike?.type || '').toLowerCase();
    if (type === 'limit') return 'target';
    if (type === 'stop' || type === 'stop_limit') return 'stop_loss';
    if (type === 'market') return 'eod_flatten';
    const exitPrice = number(orderLike?.filled_avg_price);
    const targets = safeJson(pos.targets_json, []);
    const t1 = targets.length ? targets[0] : null;
    // Price heuristic (the pre-leg check's rule): at/near the first
    // target => take-profit leg; anything else => stop leg.
    return t1 && Number.isFinite(exitPrice) && exitPrice >= +t1.price * 0.99 ? 'target' : 'stop_loss';
  }

  // Reconcile broker-side protection fills into the position row. Returns
  // the refreshed row, or null when the position fully closed here.
  async function reconcileProtection(ctx, pos) {
    let cur = pos;
    if (cur.t1_status === 'protected' && cur.oco_id) {
      const order = await orderByClient(ctx, cur.oco_id).catch(() => null);
      const leg = ocoFilledLeg(order);
      if (leg) {
        const exitPrice = number(leg.filled_avg_price);
        const filledQty = Math.abs(Math.round(number(leg.filled_qty) || 0));
        cur = recordTrancheExit(ctx.uid, cur, 't1', exitPrice, Math.min(filledQty, cur.t1_qty || filledQty), trancheExitReason(leg, cur));
      } else if (order && String(order.status || '').toLowerCase() === 'filled') {
        const exitPrice = number(order.filled_avg_price);
        const filledQty = Math.abs(Math.round(number(order.filled_qty) || 0));
        if (Number.isFinite(exitPrice) && filledQty > 0) {
          cur = recordTrancheExit(ctx.uid, cur, 't1', exitPrice, Math.min(filledQty, cur.t1_qty || filledQty), trancheExitReason(order, cur));
        }
      }
    }
    if (cur && cur.t2_status === 'protected' && cur.stop_order_id) {
      const order = await orderByClient(ctx, cur.stop_order_id).catch(() => null);
      if (order && String(order.status || '').toLowerCase() === 'filled') {
        const exitPrice = number(order.filled_avg_price);
        const filledQty = Math.abs(Math.round(number(order.filled_qty) || 0));
        if (Number.isFinite(exitPrice) && filledQty > 0) {
          cur = recordTrancheExit(ctx.uid, cur, 't2', exitPrice, Math.min(filledQty, cur.t2_qty || filledQty), 'stop_loss');
        }
      }
    }
    if (cur && cur.shares <= 0 && (cur.exited_shares || 0) > 0) {
      finalizeClosedPosition(ctx.uid, cur, 'broker_protection');
      return null;
    }
    return cur;
  }

  // ---------------------------------------------------------------------------
  // Missing-position resolution (2026-10-12 SQQQ repair). The broker —
  // whose /v2/positions response already succeeded — shows NO position
  // for a tracked open symbol. Resolve from the broker's own fill
  // records instead of alerting "reconciliation required" forever:
  //   1. protection fills, legs included (reconcileProtection above);
  //   2. the closed-order history for this symbol since the position
  //      opened — filled sells the per-id lookups missed (an OCO leg
  //      listed as its own order, a bot market exit that filled after
  //      its poll gave up, a manual close) are booked at their ACTUAL
  //      fill prices against the unbooked tranches;
  //   3. a never-filled entry (entry order terminal with zero fill, or
  //      no filled buy anywhere in the history) is VOIDED — the tracked
  //      row is removed and its trade row closed as void, no capital
  //      was ever deployed.
  // Returns null when the position fully resolved (closed or voided),
  // or the (possibly partially booked) row when the mismatch is still
  // unexplained — the caller then withholds action and alerts exactly
  // as before. Fail-closed: any failed history read leaves the row
  // untouched.
  // ---------------------------------------------------------------------------
  async function resolveMissingPosition(ctx, pos) {
    const { uid } = ctx;
    let cur = await reconcileProtection(ctx, pos);
    if (!cur) return null;
    if (cur.shares <= 0) return null;
    let orders = null;
    try {
      const openedMs = Date.parse(cur.opened_at);
      const after = Number.isFinite(openedMs)
        ? `&after=${encodeURIComponent(new Date(openedMs - 60000).toISOString())}` : '';
      const list = await broker(ctx, `/v2/orders?status=closed&direction=desc&limit=100${after}&symbols=${encodeURIComponent(cur.symbol)}`);
      if (Array.isArray(list)) orders = list;
    } catch (_) { orders = null; }
    if (!orders) return cur; // history unreadable — unresolved, withhold
    const byTimeAsc = [...orders].sort((a, b) =>
      Date.parse(a?.filled_at || a?.updated_at || a?.created_at || 0) - Date.parse(b?.filled_at || b?.updated_at || b?.created_at || 0));
    const filledSells = byTimeAsc.filter(o => o && String(o.side || '').toLowerCase() === 'sell'
      && String(o.status || '').toLowerCase() === 'filled'
      && Math.abs(Math.round(number(o.filled_qty) || 0)) > 0
      && Number.isFinite(number(o.filled_avg_price)) && number(o.filled_avg_price) > 0);
    // Never double-book a tranche reconcileProtection already recorded:
    // a history order carrying a booked tranche's client id is that
    // tranche's own fill.
    const bookedClientIds = new Set();
    if (['closed', 'target'].includes(cur.t1_status) && cur.oco_id) bookedClientIds.add(cur.oco_id);
    if (['closed', 'target'].includes(cur.t2_status) && cur.stop_order_id) bookedClientIds.add(cur.stop_order_id);
    const pickTranche = row => {
      if ((row.t1_qty || 0) > 0 && !['closed', 'target'].includes(row.t1_status)) return 't1';
      if ((row.t2_qty || 0) > 0 && !['closed', 'target'].includes(row.t2_status)) return 't2';
      return (row.t2_qty || 0) > 0 ? 't2' : 't1';
    };
    let lastReason = null;
    for (const sell of filledSells) {
      if (!cur || cur.shares <= 0) break;
      if (sell.client_order_id && bookedClientIds.has(sell.client_order_id)) continue;
      let remainingSell = Math.abs(Math.round(number(sell.filled_qty) || 0));
      const price = number(sell.filled_avg_price);
      const reason = trancheExitReason(sell, cur);
      while (remainingSell > 0 && cur && cur.shares > 0) {
        const tranche = pickTranche(cur);
        const trancheSize = tranche === 't1' ? (cur.t1_qty || 0) : (cur.t2_qty || 0);
        const cap = trancheSize > 0 ? trancheSize : cur.shares;
        const qty = Math.min(remainingSell, cur.shares, cap);
        if (qty <= 0) break;
        cur = recordTrancheExit(uid, cur, tranche, price, qty, reason);
        lastReason = reason;
        remainingSell -= qty;
      }
    }
    if (cur && cur.shares <= 0 && (cur.exited_shares || 0) > 0) {
      finalizeClosedPosition(uid, cur, lastReason || 'broker_reconciled');
      alert(uid, 'system', `Kiaan ${cur.symbol}: broker-flat position resolved from broker fill records — exit booked, position closed.`);
      return null;
    }
    if (cur && cur.shares > 0) {
      // Never-filled entry: the broker took no money, so there is no
      // exit to book — void the tracked row from broker truth.
      const entryOrder = await orderByClient(ctx, cur.entry_client_order_id).catch(() => null);
      const entryFilledQty = Math.abs(Math.round(number(entryOrder?.filled_qty) || 0));
      const entryTerminal = !!entryOrder && TERMINAL.has(String(entryOrder.status || '').toLowerCase());
      const anyFilledBuy = orders.some(o => o && String(o.side || '').toLowerCase() === 'buy'
        && String(o.status || '').toLowerCase() === 'filled'
        && Math.abs(Math.round(number(o.filled_qty) || 0)) > 0);
      if ((entryTerminal && entryFilledQty === 0) || (!entryOrder && !anyFilledBuy)) {
        if (cur.trade_id) {
          db.prepare('UPDATE kiaan_trades SET "exitPrice"=?, "pnl"=?, "rMultiple"=?, "exitReason"=?, "closedAt"=? WHERE trade_id=?')
            .run(null, '0', '0', 'void_never_filled: broker entry order never filled — tracked position removed, no capital deployed', timestamp(), cur.trade_id);
          const ds = getDayState(uid, easternDate(now()));
          ds.exposureDollars = Math.max(0, (ds.exposureDollars || 0) - (cur.entry_price || 0) * (cur.entry_shares || cur.shares || 0));
          ds.trades = Math.max(0, (ds.trades || 0) - 1);
          if (ds.tradesBySymbol) ds.tradesBySymbol[cur.symbol] = Math.max(0, (ds.tradesBySymbol[cur.symbol] || 0) - 1);
          saveDayState(uid, ds);
        }
        db.prepare('DELETE FROM kiaan_positions WHERE position_id=?').run(cur.position_id);
        alert(uid, 'system', `Kiaan ${cur.symbol}: entry never filled at the broker — tracked position voided, no capital was deployed.`);
        return null;
      }
    }
    return cur;
  }

  // ---------------------------------------------------------------------------
  // Position management — reconcile with the broker first, then: retry any
  // missing protection, move the stop to breakeven at breakevenR, take the
  // final R target on the remainder tranche, run the server-side stop
  // backstop, and flatten everything at the EOD flatten minute.
  // ---------------------------------------------------------------------------
  async function managePositions(ctx, marketState, tradeDate, funnel) {
    const { uid } = ctx;
    const rules = ctx.rules;
    const positions = openPositions(uid);
    if (!positions.length) return { managed: 0 };
    let brokerPositions;
    try {
      brokerPositions = await broker(ctx, '/v2/positions');
    } catch (error) {
      alert(uid, 'system', 'Kiaan position reconciliation unavailable — position actions withheld this tick.');
      return { managed: 0, reconciled: false };
    }
    if (!Array.isArray(brokerPositions)) {
      alert(uid, 'system', 'Kiaan broker positions response invalid — position actions withheld this tick.');
      return { managed: 0, reconciled: false };
    }
    const eod = marketState.minutes >= eodFlattenMinutes(marketState, rules);
    let priceMap = {};
    try {
      priceMap = await fetchLatestBars(ctx, [...new Set(positions.map(p => p.symbol))]);
    } catch (_) { /* per-symbol staleness checks below withhold actions */ }
    for (const pos of positions) {
      guard(ctx.lease);
      try {
        let cur = db.prepare('SELECT * FROM kiaan_positions WHERE position_id=?').get(pos.position_id);
        if (!cur) continue;
        if (cur.status === 'pending_entry') {
          if (eod) {
            const order = await orderByClient(ctx, cur.entry_client_order_id).catch(() => null);
            if (order?.id && !TERMINAL.has(String(order.status || '').toLowerCase())) {
              await cancelOrderById(ctx, order.id);
            }
            db.prepare('DELETE FROM kiaan_positions WHERE position_id=?').run(cur.position_id);
            alert(uid, 'system', `Kiaan EOD flatten: cancelled pending entry ${cur.symbol}.`);
          } else {
            await reconcilePending(ctx, cur);
          }
          continue;
        }
        // Broker-side protection fills land first.
        cur = await reconcileProtection(ctx, cur);
        if (!cur) continue;
        const bp = brokerPositions.find(p => String(p.symbol || '').toUpperCase() === cur.symbol);
        const brokerQty = Math.abs(Math.round(number(bp?.qty) || 0));
        if (!bp || brokerQty <= 0) {
          // Broker is authoritatively flat for this symbol: resolve the
          // tracked row from broker fill records (book the real exit, or
          // void a never-filled entry) instead of alerting forever. Only
          // a still-unexplained mismatch keeps the fail-safe alert.
          const resolved = await resolveMissingPosition(ctx, cur);
          if (!resolved) continue;
          alert(uid, 'system', `Kiaan ${cur.symbol}: no broker position found while ${resolved.shares} sh are tracked — action withheld, reconciliation required.`);
          continue;
        }
        if (eod) {
          const cancelled = await cancelAllProtection(ctx, cur);
          if (!cancelled) {
            alert(uid, 'risk', `Kiaan ${cur.symbol}: EOD flatten withheld — protection could not be confirmed cancelled; will retry.`);
            continue;
          }
          const { exitPrice, filledQty } = await marketExit(ctx, cur, cur.shares, 'eod_flatten');
          const tranche = (cur.t2_qty || 0) > 0 && cur.t2_status !== 'target' && cur.t2_status !== 'closed' ? 't2' : 't1';
          cur = recordTrancheExit(uid, cur, tranche, exitPrice, filledQty, 'eod_flatten');
          if (cur.shares <= 0) finalizeClosedPosition(uid, cur, 'eod_flatten');
          continue;
        }
        const latest = priceMap[cur.symbol];
        if (!latest || now() - latest.t > BAR_FRESH_MS) {
          alert(uid, 'system', `Kiaan ${cur.symbol}: price data stale — exit decisions withheld this tick.`);
          continue;
        }
        const price = latest.price;
        const targets = safeJson(cur.targets_json, []);
        const riskPerShare = Math.abs(cur.entry_price - (cur.initial_stop_price ?? cur.stop_price));
        // Retry protection for any tranche that never got its order on
        // (the entry-time attach failure path). Deterministic client ids
        // make the retry adopt, never duplicate.
        const needsProtection = targets.length > 0 && (
          cur.t1_status === 'none'
          || (cur.t2_status === 'none' && (cur.t2_qty || 0) > 0)
          || (!(cur.t1_qty > 0) && !(cur.t2_qty > 0)));
        if (needsProtection) {
          try {
            await attachProtection(ctx, cur, { stopPrice: cur.stop_price });
            cur = db.prepare('SELECT * FROM kiaan_positions WHERE position_id=?').get(cur.position_id);
          } catch (error) {
            alert(uid, 'risk', `Kiaan ${cur.symbol}: protection retry failed (${error.message}) — server-side stop management remains the only guard.`);
          }
        }
        // Final R target on the remainder tranche — taken server-side.
        const lastTarget = targets.length ? targets[targets.length - 1] : null;
        if (lastTarget && targets.length > 1 && cur.t2_status === 'protected' && price >= +lastTarget.price) {
          const cancelled = await cancelProtectionOrder(ctx, cur.stop_order_id);
          if (cancelled) {
            const { exitPrice, filledQty } = await marketExit(ctx, cur, cur.t2_qty, 'target');
            cur = recordTrancheExit(uid, cur, 't2', exitPrice, filledQty, 'target');
            if (cur.shares <= 0) { finalizeClosedPosition(uid, cur, 'target_final'); continue; }
          } else {
            alert(uid, 'risk', `Kiaan ${cur.symbol}: final-target exit withheld — stop order cancel unconfirmed.`);
          }
        }
        // Breakeven: at breakevenR, cancel protection and re-attach with
        // the stop at entry. Local state changes only after the broker
        // confirms the replacement.
        if (!cur.breakeven_at && riskPerShare > 0 && cur.stop_price < cur.entry_price
          && price >= cur.entry_price + (+rules.breakevenR) * riskPerShare) {
          const cancelled = await cancelAllProtection(ctx, cur);
          if (cancelled) {
            const t1s = cur.t1_status === 'protected' ? 'replace' : cur.t1_status;
            const t2s = cur.t2_status === 'protected' ? 'replace' : cur.t2_status;
            db.prepare('UPDATE kiaan_positions SET stop_price=?, breakeven_at=1, t1_status=?, t2_status=?, updated_at=? WHERE position_id=?')
              .run(cur.entry_price, t1s, t2s, timestamp(), cur.position_id);
            cur = db.prepare('SELECT * FROM kiaan_positions WHERE position_id=?').get(cur.position_id);
            try {
              await attachProtection(ctx, cur, { stopPrice: cur.entry_price, tag: 'be' });
              alert(uid, 'system', `Kiaan ${cur.symbol}: stop moved to breakeven @ $${cur.entry_price.toFixed(2)}.`);
            } catch (error) {
              alert(uid, 'risk', `Kiaan ${cur.symbol}: breakeven re-attach FAILED (${error.message}) — position UNPROTECTED at the broker; server-side stop management is the only guard.`);
            }
            cur = db.prepare('SELECT * FROM kiaan_positions WHERE position_id=?').get(cur.position_id);
          }
        }
        // Server-side stop backstop — guards positions whose broker-side
        // protection is missing, and double-guards the rest.
        if (cur && cur.shares > 0 && price <= cur.stop_price) {
          const cancelled = await cancelAllProtection(ctx, cur);
          if (cancelled) {
            const { exitPrice, filledQty } = await marketExit(ctx, cur, cur.shares, 'stop_loss');
            const tranche = (cur.t2_qty || 0) > 0 && cur.t2_status !== 'target' && cur.t2_status !== 'closed' ? 't2' : 't1';
            cur = recordTrancheExit(uid, cur, tranche, exitPrice, filledQty, 'stop_loss');
            if (cur.shares <= 0) finalizeClosedPosition(uid, cur, 'stop_loss');
          } else {
            alert(uid, 'risk', `Kiaan ${cur.symbol}: stop hit but protection cancel unconfirmed — exit withheld this tick.`);
          }
        }
      } catch (error) {
        funnel.errors++;
        alert(uid, 'system', `Kiaan position management withheld for ${pos.symbol}: ${error instanceof KiaanError ? error.message : 'unexpected error'}`);
      }
    }
    return { managed: positions.length };
  }

  // ---------------------------------------------------------------------------
  // Scan cycle — one 60s tick: lease → enabled/connected/market checks →
  // manage open positions → classify the regime → journal the stance →
  // only then scan candidates. Fail-closed throughout.
  // ---------------------------------------------------------------------------
  async function scanEntries(ctx, marketState, tradeDate, funnel) {
    const { uid } = ctx;
    const rules = ctx.rules;
    const equity = number(ctx.account?.equity);
    const dayStartMs = easternDayStartMs(now());
    const openMs = dayStartMs + 9.5 * 3600000; // 09:30 ET
    const dayStartIso = new Date(dayStartMs).toISOString();

    // --- 1. Market context: SPY/QQQ from Alpaca bars, VIX/10Y/oil from
    // Yahoo. (Classification happens at step 4, after the universe exists —
    // the regime's breadth vote is computed from the bot's own universe.)
    const idxDaily = await fetchDailyBars(ctx, ['SPY', 'QQQ'], 25);
    const idxMinutes = await fetchMinuteBars(ctx, ['SPY', 'QQQ'], dayStartIso, new Date(now()).toISOString());
    const macro = await fetchMacroContext();
    const spyDayChangePct = dayChangePct(withLiveFormingClose(idxDaily.SPY, idxMinutes.SPY, tradeDate));
    const qqqDayChangePct = dayChangePct(withLiveFormingClose(idxDaily.QQQ, idxMinutes.QQQ, tradeDate));

    // --- 2. Universe: the hedge list always, plus the most liquid catalog
    // names inside the price band. The engine still gates every symbol.
    // Long universe (2026-10-12): ORB's 87 names are always included too —
    // like the hedge list they bypass the catalog price-band filter and
    // the 60-name cap below, so a risk-on day can actually reach them;
    // the engine exempts them from the $20 cap and gates every other leg.
    const hedgeSymbols = parseSymbolList(rules.hedgeSymbols);
    const longUniverseSymbols = parseSymbolList(rules.longUniverse);
    // The /v2/assets response is the full multi-MB US equity list and the
    // tradable catalog built from it is static within a trade date —
    // fetch + build it once per day, not once per 60s cycle.
    let catalog = assetsCatalogCache.date === tradeDate ? assetsCatalogCache.catalog : null;
    if (!catalog) {
      const assets = await broker(ctx, '/v2/assets?status=active&asset_class=us_equity');
      catalog = buildTradableEquityCatalog(assets);
      assetsCatalogCache = { date: tradeDate, catalog };
    }
    // Liquidity sort BEFORE any cap (diagnosis 2026-10-09 addendum §5b):
    // the old code took the first 400 catalog symbols in Alpaca API
    // response order and only then filtered/sorted by average volume, so
    // eligibility was decided by API order, not liquidity. Daily bars are
    // day-scoped-cached (Oct 8), so fetching the full catalog's history
    // costs one cached pass per trade date; the 60-name cap below is kept.
    let catalogSymbols = [...catalog.keys()];
    const daily = await fetchDailyBars(ctx, [...new Set([...catalogSymbols, ...hedgeSymbols, ...longUniverseSymbols])], 25);
    const avgVols = {};
    catalogSymbols = catalogSymbols.filter(s => {
      const av = avgDailyVolume(daily[s]);
      avgVols[s] = av;
      return av != null && av >= volumeFloor(rules.minAvgVolume);
    });
    catalogSymbols.sort((a, b) => (avgVols[b] || 0) - (avgVols[a] || 0));
    const latestCatalog = await fetchLatestBars(ctx, catalogSymbols);
    catalogSymbols = catalogSymbols.filter(s => {
      const p = latestCatalog[s]?.price;
      return p != null && p >= rules.minPrice && p <= rules.maxPrice;
    }).slice(0, UNIVERSE_SYMBOL_CAP);
    const symbols = [...new Set([...catalogSymbols, ...hedgeSymbols, ...longUniverseSymbols])];
    funnel.universe = symbols.length;
    const quotes = await fetchLatestQuotes(ctx, symbols);
    const latestAll = await fetchLatestBars(ctx, symbols);
    const minutes = await fetchMinuteBars(ctx, symbols, dayStartIso, new Date(now()).toISOString());

    // --- 3. Breadth: advancers / (advancers + decliners) across the bot's
    // own liquid universe for the day, from the day-change sign computed
    // out of data already fetched in this cycle — day-scoped-cached daily
    // bars (Oct 8 fix) for the prior close, this cycle's minute/latest
    // prices for the live price. Never a fresh heavy fetch per tick.
    // Fail-soft: symbols without a usable prior close or live price are
    // excluded; if none qualify, breadth stays null, the breadth vote is
    // 0, and the regime still classifies from the remaining votes.
    let advancers = 0, decliners = 0;
    for (const symbol of symbols) {
      const ds = daily[symbol] || [];
      const prevDaily = ds.length >= 2 ? ds[ds.length - 2] : null;
      const sessionBars = (minutes[symbol] || []).filter(b => b.t >= openMs && easternDate(b.t) === tradeDate);
      const lastBar = sessionBars.length ? sessionBars[sessionBars.length - 1] : null;
      const price = lastBar ? +lastBar.c : (latestAll[symbol]?.price ?? null);
      if (!prevDaily || !(+prevDaily.c > 0) || price == null || !(price > 0)) continue;
      const chg = ((price - +prevDaily.c) / +prevDaily.c) * 100;
      if (chg > 0) advancers++;
      else if (chg < 0) decliners++;
    }
    const breadthPct = (advancers + decliners) > 0
      ? +((advancers / (advancers + decliners)) * 100).toFixed(2) : null;
    funnel.breadth = breadthPct;

    // --- 4. Regime: classified BEFORE any candidate is considered, with
    // the real breadth vote wired in. The breadth value is journaled on
    // the session decision row via classifyRegime's inputs echo
    // (inputs.breadthAdvancersPct), present or null.
    const market = {
      spy: { dayChangePct: spyDayChangePct, trend: intradayTrend((idxMinutes.SPY || []).filter(b => b.t >= openMs)) },
      qqq: { dayChangePct: qqqDayChangePct, trend: intradayTrend((idxMinutes.QQQ || []).filter(b => b.t >= openMs)) },
      vix: macro.vix, rates: macro.rates, oil: macro.oil,
      ...(breadthPct != null ? { breadth: { advancersPct: breadthPct } } : {}),
    };
    const cls = classifyRegime(market, rules);
    const session = evaluateSession({ market, regime: cls, dayState: engineDayState(uid, tradeDate, equity) }, rules);
    recordSessionDecision(uid, tradeDate, session, cls);
    funnel.regime = session.regime;
    funnel.stance = session.stance;
    if (session.locked) {
      const lockReason = (session.reasons || []).find(r => /HALT|MAX_/.test(r));
      if (lockReason) alert(uid, 'risk', `Kiaan daily locks engaged — no new entries: ${lockReason}`);
    }
    if (session.stance === 'stand-aside') {
      return { entered: 0, skipped: session.locked ? 'daily-locks' : `regime-${session.regime}` };
    }

    // --- 5. Candidates.
    const spyChg = market.spy.dayChangePct;
    let entered = 0;
    for (const symbol of symbols) {
      guard(ctx.lease);
      try {
        const sessionBars = (minutes[symbol] || []).filter(b => b.t >= openMs && easternDate(b.t) === tradeDate);
        const ds = daily[symbol] || [];
        const prevDaily = ds.length >= 2 ? ds[ds.length - 2] : null;
        const lastBar = sessionBars.length ? sessionBars[sessionBars.length - 1] : null;
        const price = lastBar ? +lastBar.c : (latestAll[symbol]?.price ?? null);
        const orEndMs = openMs + (+rules.orMinutes) * 60000;
        const orBars = sessionBars.filter(b => b.t < orEndMs);
        const orHigh = orBars.length ? Math.max(...orBars.map(b => +b.h)) : null;
        const orLow = orBars.length ? Math.min(...orBars.map(b => +b.l)) : null;
        const { vwap, reclaimed } = computeVwapReclaim(sessionBars);
        const avgVol = avgVols[symbol] != null ? avgVols[symbol] : avgDailyVolume(ds);
        const todayVol = sessionBars.reduce((a, b) => a + (Number.isFinite(+b.v) ? +b.v : 0), 0);
        const symDayChg = prevDaily && price != null && +prevDaily.c > 0
          ? ((price - +prevDaily.c) / +prevDaily.c) * 100 : null;
        const candidate = {
          symbol,
          price,
          prevClose: prevDaily ? +prevDaily.c : null,
          dayChangePct: symDayChg,
          relStrengthPct: symDayChg != null && spyChg != null ? symDayChg - spyChg : null,
          vwap,
          orHigh, orLow,
          brokeOrHigh: !!(lastBar && orHigh !== null && +lastBar.c > orHigh),
          reclaimedVwap: reclaimed,
          rvol: paceRvol(todayVol, avgVol, now()),
          atr: atrOf(ds),
          avgVolume: avgVol,
          spreadPct: quotes[symbol]?.spreadPct ?? null,
          isInverseHedge: isHedgeSymbol(symbol, rules),
        };
        const decision = evaluateCandidate(
          { market, regime: cls, nowMs: now(), dayState: engineDayState(uid, tradeDate, equity), accountEquity: equity },
          candidate, rules,
        );
        // Intraday exit geometry (2026-10-11): an enter-long decision's
        // managed stop/targets are rebased onto ATR(14) of 15m bars
        // BEFORE journaling, so the journal, the position row and the
        // broker protection all carry the geometry actually managed.
        if (decision.decision === 'enter-long') {
          await rebaseExitGeometry(ctx, symbol, decision);
        }
        recordCandidateDecision(uid, tradeDate, decision, candidate);
        if (decision.decision !== 'enter-long') continue;
        const gate = entryGate(ctx, rules, symbol, equity);
        if (!gate.ok) {
          alert(uid, 'system', `Kiaan entry withheld for ${symbol}: ${gate.reason}`);
          continue;
        }
        await submitEntry(ctx, tradeDate, symbol, decision, {
          features: candidate, regime: cls.regime, regimeScore: cls.score,
          lastBarT: lastBar ? lastBar.t : (latestAll[symbol]?.t || null),
        });
        entered++;
        funnel.entries++;
      } catch (error) {
        funnel.errors++;
        const message = error instanceof KiaanError ? error.message : 'Unexpected Kiaan scan error; order withheld.';
        alert(uid, 'system', `Kiaan scan withheld for ${symbol}: ${message}`);
      }
    }

    // --- 6. Single-stock inverse sleeve (2026-10-16): a separate book
    // with its own slot, evaluated only while the stance is seek-hedges.
    // The incumbent book above is completely untouched by this pass.
    if (rules.sleeveEnabled === true && session.stance === 'seek-hedges') {
      entered += await scanSleeveEntries(ctx, { market, cls, tradeDate, equity, funnel, idxMinutes, dayStartIso, openMs, spyChg });
    }
    return { entered };
  }

  // The sleeve pass (strategy-lab Test 10's construction, mirrored):
  // candidates are the rules.sleeveSymbols names (the incumbent hedge
  // six are never sleeve candidates — they keep their incumbent path),
  // evaluated as hedges under sleeve rules — hedgeSymbols extended with
  // the sleeve list, maxPositions = sleeveMaxPositions — against the
  // sleeve-local day state. After the engine's full confirmation stack
  // passes, the SPY-breakdown gate decides: SPY's last session bar must
  // sit below SPY's intraday VWAP and within 0.15% of SPY's running
  // intraday low, exactly the sim's predicate. Everything else — spread
  // gate, anti-chase, $500 sizing / $50 risk cap, 15m-ATR exit geometry,
  // entry window, EOD flatten — is the incumbents' machinery, shared.
  async function scanSleeveEntries(ctx, env) {
    const { uid } = ctx;
    const rules = ctx.rules;
    const { market, cls, tradeDate, equity, funnel, idxMinutes, dayStartIso, openMs, spyChg } = env;
    const sleeveSymbols = parseSymbolList(rules.sleeveSymbols)
      .filter(s => !isHedgeSymbol(s, rules));
    if (!sleeveSymbols.length) return 0;
    const sleeveRules = {
      ...rules,
      hedgeSymbols: [...parseSymbolList(rules.hedgeSymbols), ...sleeveSymbols].join(','),
      maxPositions: Math.max(1, Math.floor(+rules.sleeveMaxPositions) || 1),
    };
    // SPY intraday state from SPY's own session bars (the sim's
    // spyStateSeries: cumulative typical-price VWAP + running low over
    // the session bars this cycle already fetched for the regime).
    const spyBars = (idxMinutes.SPY || []).filter(b => b.t >= openMs && easternDate(b.t) === tradeDate);
    let spyState = null;
    if (spyBars.length) {
      let vn = 0; let vd = 0; let runLow = Infinity;
      for (const b of spyBars) {
        const typ = (+b.h + +b.l + +b.c) / 3;
        vn += typ * (+b.v || 0); vd += (+b.v || 0);
        if (Number.isFinite(+b.l)) runLow = Math.min(runLow, +b.l);
      }
      const close = +spyBars[spyBars.length - 1].c;
      const vwap = vd > 0 ? vn / vd : null;
      spyState = {
        close, vwap, runLow: Number.isFinite(runLow) ? runLow : null,
        breakingDown: vwap !== null && runLow !== null && close < vwap && close <= runLow * 1.0015,
      };
    }
    funnel.sleeveUniverse = sleeveSymbols.length;
    funnel.spyBreakingDown = !!(spyState && spyState.breakingDown);
    const daily = await fetchDailyBars(ctx, sleeveSymbols, 25);
    const quotes = await fetchLatestQuotes(ctx, sleeveSymbols);
    const latestAll = await fetchLatestBars(ctx, sleeveSymbols);
    const minutes = await fetchMinuteBars(ctx, sleeveSymbols, dayStartIso, new Date(now()).toISOString());
    let entered = 0;
    for (const symbol of sleeveSymbols) {
      guard(ctx.lease);
      try {
        const sessionBars = (minutes[symbol] || []).filter(b => b.t >= openMs && easternDate(b.t) === tradeDate);
        const ds = daily[symbol] || [];
        const prevDaily = ds.length >= 2 ? ds[ds.length - 2] : null;
        const lastBar = sessionBars.length ? sessionBars[sessionBars.length - 1] : null;
        const price = lastBar ? +lastBar.c : (latestAll[symbol]?.price ?? null);
        const orEndMs = openMs + (+rules.orMinutes) * 60000;
        const orBars = sessionBars.filter(b => b.t < orEndMs);
        const orHigh = orBars.length ? Math.max(...orBars.map(b => +b.h)) : null;
        const orLow = orBars.length ? Math.min(...orBars.map(b => +b.l)) : null;
        const { vwap, reclaimed } = computeVwapReclaim(sessionBars);
        const avgVol = avgDailyVolume(ds);
        const todayVol = sessionBars.reduce((a, b) => a + (Number.isFinite(+b.v) ? +b.v : 0), 0);
        const symDayChg = prevDaily && price != null && +prevDaily.c > 0
          ? ((price - +prevDaily.c) / +prevDaily.c) * 100 : null;
        const candidate = {
          symbol,
          price,
          prevClose: prevDaily ? +prevDaily.c : null,
          dayChangePct: symDayChg,
          relStrengthPct: symDayChg != null && spyChg != null ? symDayChg - spyChg : null,
          vwap,
          orHigh, orLow,
          brokeOrHigh: !!(lastBar && orHigh !== null && +lastBar.c > orHigh),
          reclaimedVwap: reclaimed,
          rvol: paceRvol(todayVol, avgVol, now()),
          atr: atrOf(ds),
          avgVolume: avgVol,
          spreadPct: quotes[symbol]?.spreadPct ?? null,
          isInverseHedge: true,
          sleeve: true,
        };
        let decision = evaluateCandidate(
          { market, regime: cls, nowMs: now(), dayState: engineSleeveDayState(uid, tradeDate, equity), accountEquity: equity },
          candidate, sleeveRules,
        );
        decision.reasons.push(`SLEEVE: ${symbol} is a single-stock inverse sleeve candidate — dedicated sleeve slot (max ${sleeveRules.maxPositions}), sleeve-local locks, SPY-breakdown gate applies; the incumbent hedge book's slots and state are untouched by this evaluation`);
        if (decision.decision === 'enter-long' && !(spyState && spyState.breakingDown)) {
          const gateReason = `SLEEVE_SPY_GATE: SPY is not breaking down at this tick (${spyState
            ? `close $${spyState.close.toFixed(2)} vs intraday VWAP ${spyState.vwap === null ? 'n/a' : `$${spyState.vwap.toFixed(2)}`}, running intraday low ${spyState.runLow === null ? 'n/a' : `$${spyState.runLow.toFixed(2)}`}`
            : 'SPY intraday state unavailable'}) — sleeve entries require SPY below its intraday VWAP and within 0.15% of its running low; entry withheld`;
          decision = {
            ...decision, decision: 'no-trade', side: null,
            reasons: [...decision.reasons, gateReason],
            why: `NO-TRADE ${symbol} — ${gateReason}`,
            entry: null, stop: null, targets: null, size: null, rr: null,
          };
        }
        if (decision.decision === 'enter-long') {
          decision.reasons.push(`SLEEVE_SPY_GATE_OK: SPY breaking down at entry (close $${spyState.close.toFixed(2)} < VWAP $${spyState.vwap.toFixed(2)}, within 0.15% of running low $${spyState.runLow.toFixed(2)})`);
          await rebaseExitGeometry(ctx, symbol, decision);
        }
        recordCandidateDecision(uid, tradeDate, decision, candidate, true);
        if (decision.decision !== 'enter-long') continue;
        const gate = entryGate(ctx, sleeveRules, symbol, equity, { sleeve: true });
        if (!gate.ok) {
          alert(uid, 'system', `Kiaan sleeve entry withheld for ${symbol}: ${gate.reason}`);
          continue;
        }
        await submitEntry(ctx, tradeDate, symbol, decision, {
          features: candidate, regime: cls.regime, regimeScore: cls.score,
          lastBarT: lastBar ? lastBar.t : (latestAll[symbol]?.t || null),
          sleeve: true,
        });
        entered++;
        funnel.entries++;
        funnel.sleeveEntries = (funnel.sleeveEntries || 0) + 1;
      } catch (error) {
        funnel.errors++;
        const message = error instanceof KiaanError ? error.message : 'Unexpected Kiaan sleeve scan error; order withheld.';
        alert(uid, 'system', `Kiaan sleeve scan withheld for ${symbol}: ${message}`);
      }
    }
    return entered;
  }

  async function scanCycle(uid) {
    return locked(uid, async lease => {
      const tradeDate = easternDate(now());
      const settings = ensure(uid);
      // Disabled users: no broker calls — just idle state and a lean prune.
      if (!settings.enabled) {
        setSchedulerState(uid, 'idle', 'Kiaan Bot is paused.');
        // Never await the prune under the lease (2026-10-05 fleet lesson):
        // fire-and-forget, exactly like the enabled branch below, so a
        // disabled user's Connect/Resume clicks never hit a held lease.
        pruneDiagnostics(uid).catch(() => {});
        return;
      }
      if (!persistenceReady()) {
        setSchedulerState(uid, 'error', 'Persistence unavailable; Kiaan Bot paused.');
        return;
      }
      const ctx = context(uid, lease);
      const rules = getRules(uid);
      ctx.rules = rules;
      const funnel = { universe: 0, entries: 0, errors: 0, regime: null, stance: null, breadth: null };
      try {
        const cred = credential(uid);
        if (!cred) throw new KiaanError('Connect a dedicated Kiaan Bot broker account.');
        guard(lease);
        const account = await broker(ctx, '/v2/account');
        validateAccount(account, cred.account_id);
        ctx.account = account;
        const marketState = await marketSession(ctx);
        await managePositions(ctx, marketState, tradeDate, funnel);
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
        const message = error instanceof KiaanError ? error.message : 'Unexpected Kiaan scheduler error; next tick will retry.';
        setSchedulerState(uid, 'error', message);
        if (!(error instanceof KiaanError) && !(error?.httpStatus)) {
          alert(uid, 'system', 'Kiaan scheduler errored safely — orders withheld until the next tick.');
        }
      }
    });
  }
  async function runTick(uid) {
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
    return db.prepare('SELECT user_id FROM kiaan_settings').all().map(r => r.user_id);
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
    const safeTickAll = () => tickAll().catch(error => {
      console.error('[Kiaan] scheduler tick escaped containment:', error && error.stack ? error.stack : error);
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
  // pruneDiagnostics — lean DB retention (Johnny's doctrine): 7-day alerts,
  // 30-day decision journal + day state. Real trade records, positions,
  // settings, creds, leases untouched.
  // ---------------------------------------------------------------------------
  async function pruneDiagnostics(uid) {
    try {
      const cutoff = new Date(now() - 7 * DAY_MS).toISOString();
      db.prepare('DELETE FROM kiaan_alerts WHERE user_id=? AND created_at<?').run(uid, cutoff);
      const decisionCutoff = new Date(now() - 30 * DAY_MS).toISOString().slice(0, 10);
      db.prepare('DELETE FROM kiaan_decisions WHERE user_id=? AND trade_date<?').run(uid, decisionCutoff);
      db.prepare('DELETE FROM kiaan_day_state WHERE user_id=? AND trade_date<?').run(uid, decisionCutoff);
      // Fire-and-forget, never awaited: flush() with a non-exempt reason
      // resolves only at the next throttled mutation checkpoint (up to
      // 60s+), so awaiting it here could hold a caller (and its op-lease)
      // hostage (2026-10-05 fleet lesson — same pattern as locked()'s
      // finally). flush() marks the mutation dirty synchronously.
      if (durability?.flush && persistenceReady()) { try { durability.flush('kiaan-prune').catch(() => {}); } catch (_) {} }
    } catch (_) { /* pruning is best-effort */ }
  }

  const service = {
    strategy: STRATEGY,
    start, stop, drain, lifecycleStatus,
    connect, disconnect,
    setSettings, getSettings: getSettingsView, status,
    dashboard, positions, trades, alerts, journal, universe,
    pruneDiagnostics,
    DEFAULT_KIAAN_RULES,
    _scanCycle: scanCycle, // test hook: drive one tick without the scheduler
    _clientId: clientId, // test hook: client order id uniqueness
    _tickPrice: tickPrice, // test hook: tick-aware rounding
  };
  return service;
}

// Mount /api/kiaan/* routes on the app, mirror of ORB's mountOrb.
function mountKiaan({ app, service, requireAuth, ensureSessionUserInTradingStore }) {
  if (!app || !service || typeof requireAuth !== 'function') throw new Error('Kiaan requires an app, a service and requireAuth.');
  const withUser = handler => async (req, res, next) => {
    try {
      const uid = ensureSessionUserInTradingStore
        ? await ensureSessionUserInTradingStore(req)
        : Number(req.session?.userId);
      const result = await handler(uid, req, res);
      if (!res.headersSent && result !== undefined) res.json(result);
    } catch (error) {
      // Never surface a broker failure as HTTP 502: the CDN/proxy layer
      // replaces origin 502 bodies with its own error page (fleet lesson
      // 2026-10-05). 422 keeps the real message intact.
      const status = error instanceof KiaanError ? (error.status === 502 ? 422 : error.status) : 500;
      if (!res.headersSent) res.status(status).json({ error: error?.message || 'Kiaan request failed.' });
    }
  };
  const json = bodyParserJson();
  app.get('/api/kiaan/status', requireAuth, withUser(uid => service.status(uid)));
  app.post('/api/kiaan/connect', requireAuth, json, withUser((uid, req) => service.connect(uid, req.body || {})));
  app.post('/api/kiaan/disconnect', requireAuth, json, withUser(uid => service.disconnect(uid)));
  app.get('/api/kiaan/settings', requireAuth, withUser(uid => service.getSettings(uid)));
  app.put('/api/kiaan/settings', requireAuth, json, withUser((uid, req) => service.setSettings(uid, req.body || {})));
  app.get('/api/kiaan/dashboard', requireAuth, withUser(uid => service.dashboard(uid)));
  app.get('/api/kiaan/positions', requireAuth, withUser(uid => service.positions(uid)));
  app.get('/api/kiaan/trades', requireAuth, withUser((uid, req) => service.trades(uid, req.query || {})));
  app.get('/api/kiaan/alerts', requireAuth, withUser(uid => service.alerts(uid)));
  app.get('/api/kiaan/journal', requireAuth, withUser((uid, req) => service.journal(uid, req.query || {})));
  app.get('/api/kiaan/universe', requireAuth, withUser(uid => service.universe(uid)));
  return {
    routes: [
      'GET /api/kiaan/status', 'POST /api/kiaan/connect', 'POST /api/kiaan/disconnect',
      'GET /api/kiaan/settings', 'PUT /api/kiaan/settings', 'GET /api/kiaan/dashboard',
      'GET /api/kiaan/positions', 'GET /api/kiaan/trades', 'GET /api/kiaan/alerts',
      'GET /api/kiaan/journal', 'GET /api/kiaan/universe',
    ],
  };
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

module.exports = { createKiaanService, mountKiaan, KiaanError, DEFAULT_KIAAN_RULES };
