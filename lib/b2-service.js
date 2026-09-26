'use strict';

const crypto = require('crypto');
const { DEFAULT_LIQUIDITY_POLICY } = require('./liquidity-policy');
const { evaluateAlpacaLiquidity } = require('./liquidity-providers');

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced']);
const CLOSED = new Set(['closed', 'rejected', 'canceled']);
const ACTIVE_STOP = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'held']);
const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';

class B2Error extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
function number(value) { return value == null || value === '' ? NaN : Number(value); }
function stopPrice(price) {
  const value = number(price) * 0.95;
  const scale = value >= 1 ? 100 : 10000;
  return Math.ceil(value * scale - 1e-8) / scale;
}
function clientId(...parts) {
  return `b2-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}
function easternDate(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}
function sessionClose(session) {
  // Calendar close is exchange-local and includes holiday / early-close hours.
  const [hour, minute] = String(session?.close || '').split(':').map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(session?.date) || !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59) return NaN;
  const noon = new Date(`${session.date}T12:00:00Z`);
  if (!Number.isFinite(noon.getTime())) return NaN;
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(noon));
  return Date.parse(`${session.date}T00:00:00Z`) + (hour + 12 - localHour) * 3600000 + minute * 60000;
}

function createB2Service({
  db, vault, fetch: fetchBroker, now = () => Date.now(), strategy,
  getAutomaticBotContext = async () => null,
  automaticBotSettings = null,
  persistenceReady = () => true,
  durability = null,
  batchSize = 100, timeoutMs = 10000, leaseMs = 180000,
}) {
  if (!db || !vault || typeof fetchBroker !== 'function') throw new Error('B2 requires database, vault and fetch.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('B2 batch size must be an integer between 1 and 1000.');
  const rules = strategy || require('./b2-strategy');
  let timer = null;
  let running = false;
  let generation = 0;
  let ticking = false;
  let activeTick = null;
  const timestamp = () => new Date(now()).toISOString();
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS b2_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), mode TEXT NOT NULL DEFAULT 'paper',
      enabled INTEGER NOT NULL DEFAULT 0, live_armed INTEGER NOT NULL DEFAULT 0,
      max_position_dollars REAL NOT NULL DEFAULT 1000, revision INTEGER NOT NULL DEFAULT 0,
      last_cycle_at TEXT, scheduler_status TEXT NOT NULL DEFAULT 'idle', scheduler_reason TEXT,
      data_error TEXT, data_feed TEXT NOT NULL DEFAULT 'sip'
    );
    CREATE TABLE IF NOT EXISTS b2_credentials (
      user_id INTEGER NOT NULL REFERENCES users(id), mode TEXT NOT NULL,
      account_id TEXT NOT NULL, api_key TEXT NOT NULL, api_secret TEXT NOT NULL,
      PRIMARY KEY(user_id,mode)
    );
    CREATE TABLE IF NOT EXISTS b2_leases (
      user_id INTEGER PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS b2_universe (
      account_id TEXT NOT NULL, symbol TEXT NOT NULL, asset TEXT NOT NULL,
      PRIMARY KEY(account_id,symbol)
    );
    CREATE TABLE IF NOT EXISTS b2_coverage (
      account_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0,
      scanned INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT, catalog_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS b2_candidates (
      account_id TEXT NOT NULL, symbol TEXT NOT NULL, result TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(account_id,symbol)
    );
    CREATE TABLE IF NOT EXISTS b2_priority (
      account_id TEXT NOT NULL, symbol TEXT NOT NULL, score REAL NOT NULL,
      relative_volume REAL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id,symbol)
    );
    CREATE TABLE IF NOT EXISTS b2_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      account_id TEXT NOT NULL, mode TEXT NOT NULL, symbol TEXT NOT NULL, event_id TEXT NOT NULL,
      client_id TEXT NOT NULL UNIQUE, order_id TEXT, status TEXT NOT NULL,
      entry_price REAL, filled_shares REAL NOT NULL DEFAULT 0, stop_price REAL,
      stop_id TEXT, exit_id TEXT, exit_client_id TEXT, exit_price REAL, pnl REAL,
      protection TEXT NOT NULL DEFAULT 'unknown', exit_requested INTEGER NOT NULL DEFAULT 0,
      last_exit_session TEXT, signal_date TEXT, restore_client_id TEXT, exit_rejected INTEGER NOT NULL DEFAULT 0,
      exit_generation INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(account_id,symbol,event_id)
    );
    CREATE TABLE IF NOT EXISTS b2_exit_fills (
      trade_id INTEGER NOT NULL REFERENCES b2_trades(id), order_id TEXT NOT NULL,
      shares REAL NOT NULL, price REAL NOT NULL, PRIMARY KEY(trade_id,order_id)
    );
    CREATE TABLE IF NOT EXISTS b2_close_attempts (
      trade_id INTEGER NOT NULL REFERENCES b2_trades(id), generation INTEGER NOT NULL,
      client_id TEXT NOT NULL UNIQUE, order_id TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(trade_id,generation)
    );
    CREATE TABLE IF NOT EXISTS b2_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      account_id TEXT, type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const tradeColumns = new Set(db.prepare('PRAGMA table_info(b2_trades)').all().map(row => row.name));
  for (const [column, definition] of [
    ['last_exit_session', 'TEXT'], ['signal_date', 'TEXT'], ['restore_client_id', 'TEXT'], ['exit_rejected', 'INTEGER NOT NULL DEFAULT 0'],
    ['exit_generation', 'INTEGER NOT NULL DEFAULT 0'], ['retry_after', 'INTEGER NOT NULL DEFAULT 0'],
    ['exit_reason', 'TEXT'],
  ]) {
    if (!tradeColumns.has(column)) db.exec(`ALTER TABLE b2_trades ADD COLUMN ${column} ${definition}`);
  }
  if (!db.prepare('PRAGMA table_info(b2_settings)').all().some(row => row.name === 'data_error')) db.exec('ALTER TABLE b2_settings ADD COLUMN data_error TEXT');
  const settingsColumns = new Set(db.prepare('PRAGMA table_info(b2_settings)').all().map(row => row.name));
  for (const [column, definition] of [
    ['automation_revision', 'INTEGER NOT NULL DEFAULT 0'], ['market_open', 'INTEGER'], ['market_clock_at', 'INTEGER'],
  ]) {
    if (!settingsColumns.has(column)) db.exec(`ALTER TABLE b2_settings ADD COLUMN ${column} ${definition}`);
  }
  if (!settingsColumns.has('data_feed')) db.exec("ALTER TABLE b2_settings ADD COLUMN data_feed TEXT NOT NULL DEFAULT 'sip'");
  db.prepare("UPDATE b2_settings SET data_feed='sip' WHERE data_feed IS NULL OR data_feed NOT IN ('sip','iex')").run();
  const getSettings = uid => db.prepare('SELECT * FROM b2_settings WHERE user_id=?').get(uid);
  function ensure(uid) {
    db.prepare('INSERT OR IGNORE INTO b2_settings(user_id) VALUES (?)').run(uid);
    return getSettings(uid);
  }
  function credential(uid, mode) {
    const row = db.prepare('SELECT * FROM b2_credentials WHERE user_id=? AND mode=?').get(uid, mode);
    if (!row) return null;

    const encryptedKey = vault.isEncrypted(row.api_key);
    const encryptedSecret = vault.isEncrypted(row.api_secret);
    if (encryptedKey && encryptedSecret) return row;

    // B2 was introduced after the vault, but a database can still contain a
    // record created by an intermediate build. Upgrade that record on first
    // use without ever returning the plaintext values to the rest of the
    // service. A half-encrypted or marker row fails closed instead of trying
    // to guess which value is authoritative.
    if (encryptedKey || encryptedSecret ||
        typeof row.api_key !== 'string' || typeof row.api_secret !== 'string' ||
        !row.api_key || !row.api_secret || row.api_key === '__encrypted__' || row.api_secret === '__encrypted__') {
      return null;
    }
    try {
      const nextKey = vault.encrypt(row.api_key);
      const nextSecret = vault.encrypt(row.api_secret);
      const migrated = db.prepare(`UPDATE b2_credentials
        SET api_key=?, api_secret=?
        WHERE user_id=? AND mode=? AND api_key=? AND api_secret=?`).run(
        nextKey, nextSecret, uid, mode, row.api_key, row.api_secret
      );
      if (migrated.changes === 1) return { ...row, api_key: nextKey, api_secret: nextSecret };
      const current = db.prepare('SELECT * FROM b2_credentials WHERE user_id=? AND mode=?').get(uid, mode);
      return vault.isEncrypted(current?.api_key) && vault.isEncrypted(current?.api_secret) ? current : null;
    } catch (_) {
      // Never include a credential or upstream error in a broker status path.
      return null;
    }
  }
  const unresolved = uid => db.prepare("SELECT * FROM b2_trades WHERE user_id=? AND status NOT IN ('closed','rejected','canceled') ORDER BY id").all(uid);
  const quarantined = account => !!db.prepare('SELECT 1 FROM broker_account_quarantine WHERE account_id=? AND resolved_at IS NULL').get(account);
  function alert(uid, account, type, message) {
    // Messages are fixed application text, never upstream error bodies or credentials.
    const previous = db.prepare('SELECT type,message,created_at FROM b2_alerts WHERE user_id=? ORDER BY id DESC LIMIT 1').get(uid);
    if (previous?.type === type && previous.message === message && now() - Date.parse(previous.created_at) < 300000) return;
    db.prepare('INSERT INTO b2_alerts(user_id,account_id,type,message,created_at) VALUES (?,?,?,?,?)')
      .run(uid, account || null, type, message, timestamp());
  }
  function coverage(account) {
    const row = account && db.prepare('SELECT * FROM b2_coverage WHERE account_id=?').get(account);
    const priority = account ? db.prepare('SELECT COUNT(*) AS n FROM b2_priority WHERE account_id=?').get(account)?.n || 0 : 0;
    return { total: row?.total || 0, scanned: row?.scanned || 0, cursor: row?.cursor || 0, updatedAt: row?.updated_at || null,
      batchSize, priority, minimumPassCycles: Math.ceil((row?.total || 0) / batchSize) };
  }
  function scanFailure(error) {
    const message = error instanceof B2Error ? error.message : '';
    if (/stale|malformed|bars|snapshots|calendar|clock|market data|probe|feed|historical/i.test(message)) {
      return {
        outcome: 'error',
        reasonCode: /stale|clock/i.test(message) ? 'stale_data' : 'data_error',
        reason: 'Broker market data is missing, stale, or malformed; this symbol was withheld.',
      };
    }
    return {
      outcome: 'error',
      reasonCode: 'broker_error',
      reason: 'Broker or market-data request failed; this symbol was withheld.',
    };
  }
  function normalizeScanResult(result) {
    const eligible = result?.eligible === true;
    return {
      ...result,
      outcome: eligible ? 'eligible' : 'rejected',
      reasonCode: eligible ? 'strategy_eligible' : 'strategy_gate',
    };
  }
  // Universe pre-filter: momentum names are re-scanned every cycle ahead of the
  // rotating universe, so a fresh crossover is not missed while ~10k symbols
  // rotate at batchSize per cycle. Priority rows are written from the same
  // evaluation the strategy already performs, so no extra market-data calls
  // are needed. A failed scan never touches the hot list; expiry prunes it.
  function recordPriority(ctx, results, evaluatedAt, dataError) {
    if (dataError) return;
    const account = ctx.cred.account_id;
    const cutoff = new Date(now() - rules.B2_RULES.priorityMaxAgeDays * 86400000).toISOString();
    guard(ctx.lease);
    db.transaction(() => {
      db.prepare('DELETE FROM b2_priority WHERE account_id=? AND updated_at<?').run(account, cutoff);
      const upsert = db.prepare(`INSERT INTO b2_priority(account_id,symbol,score,relative_volume,updated_at)
        VALUES (?,?,?,?,?) ON CONFLICT(account_id,symbol) DO UPDATE SET
        score=excluded.score,relative_volume=excluded.relative_volume,updated_at=excluded.updated_at`);
      const drop = db.prepare('DELETE FROM b2_priority WHERE account_id=? AND symbol=?');
      for (const result of results) {
        if (result.outcome === 'error' || typeof result.symbol !== 'string') continue;
        const gain = Number(result.metrics?.dailyGainPct);
        const rvol = Number(result.metrics?.relativeVolume);
        const price = Number(result.metrics?.price);
        const hot = Number.isFinite(gain) && gain >= rules.B2_RULES.priorityMinDailyGainPct
          && Number.isFinite(rvol) && rvol >= rules.B2_RULES.priorityMinRelativeVolume
          && Number.isFinite(price) && price >= rules.B2_RULES.minPrice && price <= rules.B2_RULES.maxPrice;
        if (hot) upsert.run(account, result.symbol, gain, rvol, evaluatedAt);
        else drop.run(account, result.symbol);
      }
    })();
  }
  function selectScanAssets(ctx, state, all) {
    const account = ctx.cred.account_id;
    const etfSymbols = rules.LEVERAGED_ETF_SYMBOLS || new Set();
    const maxPriority = Math.min(rules.B2_RULES.priorityBatchSize, batchSize);
    const cutoff = new Date(now() - rules.B2_RULES.priorityMaxAgeDays * 86400000).toISOString();
    const hot = db.prepare(`SELECT symbol FROM b2_priority WHERE account_id=? AND updated_at>=?
      AND symbol NOT IN (SELECT symbol FROM b2_trades WHERE account_id=?
        AND status NOT IN ('closed','rejected','canceled'))
      ORDER BY score DESC, relative_volume DESC LIMIT ?`).all(account, cutoff, account, maxPriority);
    const bySymbol = new Map();
    for (const row of all) {
      try { bySymbol.set(JSON.parse(row.asset).symbol, row.asset); } catch (_) { /* malformed asset rows are skipped */ }
    }
    // Leveraged/inverse ETFs are always scanned: they are few, liquid, and
    // exempt from the $20 stock price cap by strategy rules.
    const etfAssets = [];
    const etfSymbolSet = new Set();
    for (const symbol of etfSymbols) {
      const existing = bySymbol.get(symbol);
      if (typeof existing === 'string') { etfAssets.push(JSON.parse(existing)); etfSymbolSet.add(symbol); continue; }
      // Curated ETFs are always scanned, even when the broker catalog omits
      // them; they ride along additively and never disturb rotation.
      const asset = { symbol, class: 'us_equity', status: 'active', tradable: true };
      bySymbol.set(symbol, JSON.stringify(asset));
      etfAssets.push(asset);
      etfSymbolSet.add(symbol);
    }
    const priorityAssets = [];
    const prioritySymbols = new Set();
    for (const { symbol } of hot) {
      if (etfSymbolSet.has(symbol)) continue;
      const asset = bySymbol.get(symbol);
      if (typeof asset === 'string') { priorityAssets.push(JSON.parse(asset)); prioritySymbols.add(symbol); }
    }
    // Price-aware rotation: symbols last seen above the skip threshold with
    // fresh readings are skipped (the cursor still advances past them) so
    // scan budget concentrates on names that can pass the entry price
    // gate. Stale readings are re-checked after the recheck window in case
    // a name has fallen into range. No wrap: the cursor advances to the end
    // of the universe, then a fresh pass starts at zero.
    const skipAbove = Number(rules.B2_RULES.universePriceSkipAbove) || 22;
    const recheckMs = (Number(rules.B2_RULES.universePriceRecheckDays) || 7) * 86400000;
    // The curated list is additive: it never consumes the rotation budget,
    // so universe coverage is unaffected by its fixed size.
    const rotationBudget = Math.max(batchSize - priorityAssets.length, 0);
    const remaining = Math.max(all.length - state.cursor, 0);
    const examineCap = rotationBudget > 0 ? Math.min(remaining, Math.max(rotationBudget * 4, rotationBudget + 50)) : 0;
    const windowEntries = [];
    for (let i = 0; i < examineCap; i++) {
      let asset = null;
      try { asset = JSON.parse(all[state.cursor + i].asset); } catch (_) { /* unscannable below */ }
      windowEntries.push(asset);
    }
    const tooExpensive = new Set();
    const pricedSymbols = windowEntries.filter(a => a && typeof a.symbol === 'string').map(a => a.symbol);
    if (pricedSymbols.length) {
      const priceCutoff = new Date(now() - recheckMs).toISOString();
      const placeholders = pricedSymbols.map(() => '?').join(',');
      const priceRows = db.prepare(`SELECT symbol, result, updated_at FROM b2_candidates
        WHERE account_id=? AND symbol IN (${placeholders})`).all(account, ...pricedSymbols);
      for (const row of priceRows) {
        if (row.updated_at < priceCutoff) continue;
        try {
          const price = Number(JSON.parse(row.result)?.metrics?.price);
          if (Number.isFinite(price) && price > skipAbove) tooExpensive.add(row.symbol);
        } catch (_) { /* unreadable rows are scanned normally */ }
      }
    }
    const rotationAssets = [];
    let examined = 0;
    for (const asset of windowEntries) {
      if (rotationAssets.length >= rotationBudget) break;
      examined += 1;
      if (!asset || typeof asset.symbol !== 'string') continue;
      if (prioritySymbols.has(asset.symbol) || etfSymbolSet.has(asset.symbol)) continue;
      if (tooExpensive.has(asset.symbol)) continue;
      rotationAssets.push(asset);
    }
    return { assets: [...etfAssets, ...priorityAssets, ...rotationAssets],
      priorityCount: priorityAssets.length, rotationCount: examined, etfCount: etfAssets.length };
  }
  function persistScanResults(ctx, state, selection, results, dataError = null) {
    const evaluatedAt = timestamp();
    const bounded = results.map(result => ({ ...result, evaluatedAt }));
    const { assets, rotationCount } = selection;
    guard(ctx.lease);
    db.transaction(() => {
      const put = db.prepare('INSERT OR REPLACE INTO b2_candidates(account_id,symbol,result,updated_at) VALUES (?,?,?,?)');
      for (const result of bounded) put.run(ctx.cred.account_id, result.symbol, JSON.stringify(result), evaluatedAt);
      const count = assets.length;
      const total = db.prepare('SELECT total FROM b2_coverage WHERE account_id=?').get(ctx.cred.account_id)?.total || count;
      db.prepare('UPDATE b2_coverage SET cursor=?,scanned=?,updated_at=? WHERE account_id=?')
        .run((state.cursor + rotationCount) % total, state.cursor + rotationCount,
          evaluatedAt, ctx.cred.account_id);
      db.prepare('UPDATE b2_settings SET data_error=? WHERE user_id=?').run(dataError, ctx.uid);
    })();
    recordPriority(ctx, bounded, evaluatedAt, dataError);
    return bounded;
  }
  function status(uid) {
    const settings = getSettings(uid) || { mode: 'paper', enabled: 0, live_armed: 0, max_position_dollars: 1000 };
    const cred = credential(uid, settings.mode);
    const connections = Object.fromEntries(['paper', 'live'].map(mode => {
      const saved = credential(uid, mode);
      return [mode, { connected: !!saved, accountId: saved?.account_id || null }];
    }));
    const clockAge = settings.market_clock_at == null ? NaN : now() - settings.market_clock_at;
    const blockers = [];
    if (!persistenceReady()) blockers.push('Durable automated-trading PostgreSQL schema is unavailable; new entries are withheld.');
    if (!cred) blockers.push('Connect a dedicated B2 broker account.');
    if (!settings.enabled) blockers.push('Automation is paused.');
    if (settings.mode === 'live' && !settings.live_armed) blockers.push('Live trading requires explicit arming.');
    if (settings.mode === 'live' && settings.live_armed && automaticBotSettings?.owner(uid)?.strategy !== 'b2') {
      blockers.push('Another strategy owns this user’s Live authorization.');
    }
    if (cred && quarantined(cred.account_id)) blockers.push('Broker account is quarantined.');
    const owner = cred && db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (cred && (!owner || owner.user_id !== uid || owner.scope !== 'b2' || owner.mode !== cred.mode)) {
      blockers.push('Broker account ownership is not verified.');
    }
    if (unresolved(uid).some(t => t.protection !== 'protected' || t.exit_requested)) blockers.push('An order or protective stop requires reconciliation.');
    if (settings.scheduler_status === 'error') blockers.push(settings.scheduler_reason || 'Broker reconciliation failed.');
    if (settings.data_error) blockers.push(settings.data_error);
    const marketOpen = Number.isFinite(clockAge) && clockAge >= -5000 && clockAge <= 120000 && settings.market_open != null
      ? !!settings.market_open : null;
    const entryBlockers = [...blockers];
    if (marketOpen === null) entryBlockers.push('Market-hours state has not been verified by the broker.');
    else if (!marketOpen) entryBlockers.push('Market is closed; existing positions remain under reconciliation.');
    const entryReadyNow = entryBlockers.length === 0;
    const schedulerEligibilityReason = entryReadyNow
      ? 'Eligible for the next server-owned scan and guarded entry check.'
      : entryBlockers[0];
    const fleet = automaticBotSettings?.status(uid, 'b2', {
      mode: settings.mode, enabled: !!settings.enabled, liveArmed: !!settings.live_armed,
    }) || { posture: settings.enabled ? (settings.mode === 'live' && settings.live_armed ? 'live-armed' : 'active') : 'paused', liveOwner: null };
    return {
      connected: !!cred, mode: settings.mode, accountId: cred?.account_id || null, connections,
      marketOpen,
      enabled: !!settings.enabled, liveArmed: !!settings.live_armed,
      dataFeed: settings.data_feed || 'sip',
      maxPositionDollars: settings.max_position_dollars, ready: !blockers.length, blockers,
      entryReadyNow, schedulerEligible: entryReadyNow, schedulerEligibilityReason,
      readiness: {
        connected: !!cred,
        automationEnabled: !!settings.enabled,
        mode: settings.mode,
        liveArmed: !!settings.live_armed,
        marketOpen,
        schedulerEligible: entryReadyNow,
        reason: schedulerEligibilityReason,
      },
      scheduler: { lastCycleAt: settings.last_cycle_at || null, status: settings.scheduler_status || 'idle', reason: settings.scheduler_reason || null },
      posture: fleet.posture, liveOwner: fleet.liveOwner,
      coverage: coverage(cred?.account_id), rules: rules.B2_RULES,
      liquidityPolicy: DEFAULT_LIQUIDITY_POLICY,
    };
  }
  async function locked(uid, work) {
    const token = crypto.randomUUID();
    const result = db.prepare(`INSERT INTO b2_leases(user_id,token,expires_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
      WHERE b2_leases.expires_at<=?`).run(uid, token, now() + leaseMs, now());
    if (!result.changes) throw new B2Error('B2 is reconciling this account. Retry shortly.');
    const lease = { uid, token, generation };
    try { return await work(lease); }
    finally {
      db.prepare('DELETE FROM b2_leases WHERE user_id=? AND token=?').run(uid, token);
      if (durability?.flush && persistenceReady()) await durability.flush('b2-operation');
    }
  }
  function guard(lease) {
    const renewed = db.prepare('UPDATE b2_leases SET expires_at=? WHERE user_id=? AND token=? AND expires_at>?')
      .run(now() + leaseMs, lease.uid, lease.token, now());
    if (!renewed.changes) throw new B2Error('B2 lease expired; broker action withheld.');
  }
  function context(uid, lease, mode) {
    const settings = ensure(uid);
    const cred = credential(uid, mode || settings.mode);
    if (!cred) throw new B2Error('Connect a dedicated B2 broker account.');
    return { uid, lease, settings, cred };
  }
  function authorize(ctx, entry = false) {
    guard(ctx.lease);
    if (entry && !persistenceReady()) {
      throw new B2Error('Automated trading persistence is unavailable; broker entry withheld.');
    }
    const current = getSettings(ctx.uid);
    const cred = credential(ctx.uid, ctx.cred.mode);
    if (!cred || cred.account_id !== ctx.cred.account_id || cred.api_key !== ctx.cred.api_key ||
        cred.api_secret !== ctx.cred.api_secret || current.revision !== ctx.settings.revision) {
      throw new B2Error('B2 authorization changed; action withheld.');
    }
    const owner = db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get(cred.account_id);
    if (!owner || owner.scope !== 'b2' || owner.user_id !== ctx.uid || owner.mode !== cred.mode || quarantined(cred.account_id)) {
      throw new B2Error('B2 broker account ownership is not verified.');
    }
    if (entry && (!running || ctx.lease.generation !== generation || !current.enabled ||
        current.automation_revision !== ctx.settings.automation_revision ||
        current.mode !== cred.mode || (current.mode === 'live' && (!current.live_armed ||
          (automaticBotSettings && automaticBotSettings.owner(ctx.uid)?.strategy !== 'b2'))))) {
      throw new B2Error('B2 entries are paused or live trading is not armed.');
    }
  }
  async function request(cred, path, { method = 'GET', body, data = false, allow404 = false, ctx, entry = false,
    entitlementProbe = false } = {}) {
    if (ctx) {
      guard(ctx.lease);
      if (method !== 'GET') authorize(ctx, entry);
    }
    if (method !== 'GET' && durability?.flush) {
      if (ctx) {
        const clientOrderId = body?.client_order_id || body?.client_order_idempotency_key || null;
        const purpose = path.includes('orders') ? (body?.side === 'buy' ? 'entry' : body?.type === 'stop' ? 'protection' : 'exit') : 'broker-action';
        const intent = db.prepare(`
          INSERT INTO automated_action_intents
            (strategy,user_id,account_id,mode,method,path,purpose,client_order_id,request_json,state,updated_at)
          VALUES ('b2',?,?,?,?,?,?,?,?,'prepared',datetime('now'))
        `).run(ctx.uid, cred.account_id, cred.mode, method, path, purpose, clientOrderId, JSON.stringify(body || {}));
        ctx.actionIntentId = intent.lastInsertRowid;
      }
      await durability.flush(`b2-before-${method.toLowerCase()}`);
      if (ctx) authorize(ctx, entry);
    }
    const controller = new AbortController();
    let timeout;
    try {
      const call = (async () => {
        const response = await fetchBroker(`${data ? DATA : cred.mode === 'live' ? LIVE : PAPER}${path}`, {
          method, signal: controller.signal,
          headers: { 'APCA-API-KEY-ID': vault.decrypt(cred.api_key), 'APCA-API-SECRET-KEY': vault.decrypt(cred.api_secret), 'Content-Type': 'application/json' },
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
             db.prepare('UPDATE b2_settings SET data_error=? WHERE user_id=?').run(message, ctx.uid);
          }
          const failure = new B2Error(`Broker request failed (HTTP ${response.status}); action withheld.`, 502);
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
        timeout = setTimeout(() => { controller.abort(); reject(new B2Error('Broker request timed out; reconciliation required.', 502)); }, timeoutMs);
      })]);
      if (ctx) guard(ctx.lease);
      if (method !== 'GET' && durability?.flush) {
        if (ctx?.actionIntentId) db.prepare(`
          UPDATE automated_action_intents SET state='submitted', broker_order_id=?, updated_at=datetime('now')
          WHERE id=?
        `).run(result?.id || null, ctx.actionIntentId);
        await durability.flush(`b2-after-${method.toLowerCase()}`);
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
        try { await durability.flush(`b2-unknown-${method.toLowerCase()}`); } catch (_) {}
      }
      if (error instanceof B2Error) throw error;
      throw new B2Error('Broker connection or response failed; action withheld.', 502);
    } finally { clearTimeout(timeout); }
  }
  async function broker(ctx, path, options = {}) {
    const isClock = path === '/v2/clock';
    if (isClock) db.prepare('UPDATE b2_settings SET market_open=NULL,market_clock_at=NULL WHERE user_id=?').run(ctx.uid);
    const result = await request(ctx.cred, path, { ...options, ctx });
    if (isClock) {
      const time = Date.parse(result?.timestamp);
      if (!Number.isFinite(time) || now() - time > 120000 || time - now() > 5000 || typeof result?.is_open !== 'boolean') {
        throw new B2Error('Broker clock is missing or stale.');
      }
      db.prepare('UPDATE b2_settings SET market_open=?,market_clock_at=? WHERE user_id=?').run(Number(result.is_open), time, ctx.uid);
    }
    return result;
  }
  function validateAccount(account, expected) {
    if (typeof account?.id !== 'string' || !account.id.trim() || (expected && account.id !== expected) || account.status !== 'ACTIVE' ||
        account.trading_blocked || account.account_blocked || account.trade_suspended_by_user) {
      throw new B2Error('Broker account identity or trading permission is not valid.');
    }
  }
  async function assertEmpty(ctx) {
    if (unresolved(ctx.uid).length) throw new B2Error('Resolve all B2 orders and positions before changing the connection.');
    const positions = await broker(ctx, '/v2/positions');
    const orders = await broker(ctx, '/v2/orders?status=open&limit=500&nested=true');
    if (!Array.isArray(positions) || !Array.isArray(orders)) throw new B2Error('Broker lifecycle data is missing.');
    if (positions.length || orders.length) throw new B2Error('Broker positions or orders remain. Connection change blocked.');
    guard(ctx.lease);
  }
  function release(uid, cred) {
    if (!cred) return;
    const remaining = db.prepare('SELECT 1 FROM b2_credentials WHERE account_id=?').get(cred.account_id);
    if (!remaining) db.prepare("DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope='b2'").run(cred.account_id, uid);
  }
  function validateInput(input, allowed, message) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowed.includes(key))) throw new B2Error(message, 400);
    if (input.authorizeLive !== undefined && typeof input.authorizeLive !== 'boolean') {
      throw new B2Error('authorizeLive must be boolean.', 400);
    }
  }
  function assertActivationUnchanged(uid, settings) {
    const current = getSettings(uid);
    if (current.revision !== settings.revision || current.automation_revision !== settings.automation_revision) {
      throw new B2Error('B2 authorization changed; activation withheld.');
    }
  }
  async function setCredentials(uid, input) {
    if (!persistenceReady()) throw new B2Error('Automated trading persistence is unavailable; B2 entries remain paused. Publish the database schema before connecting.', 503);
    validateInput(input, ['mode', 'apiKey', 'apiSecret', 'authorizeLive'], 'Only mode, API key, API secret and live authorization may be supplied.');
    if (!['paper', 'live'].includes(input?.mode) || typeof input.apiKey !== 'string' ||
        typeof input.apiSecret !== 'string' || !input.apiKey.trim() || !input.apiSecret.trim() ||
        input.apiKey.length > 512 || input.apiSecret.length > 512) throw new B2Error('Valid mode, API key and secret are required.', 400);
    return locked(uid, async lease => {
      const settings = ensure(uid);
      if (unresolved(uid).length) throw new B2Error('Resolve all B2 orders and positions before replacing credentials.');
      for (const row of db.prepare('SELECT * FROM b2_credentials WHERE user_id=?').all(uid)) {
        await assertEmpty(context(uid, lease, row.mode));
      }
      const next = { mode: input.mode, api_key: vault.encrypt(input.apiKey.trim()), api_secret: vault.encrypt(input.apiSecret.trim()) };
      const account = await request(next, '/v2/account');
      validateAccount(account);
      guard(lease);
      db.transaction(() => {
        assertActivationUnchanged(uid, settings);
        if (quarantined(account.id)) throw new B2Error('Broker account is quarantined.');
        const owner = db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at)
          VALUES (?,?,'b2',?,?) ON CONFLICT(account_id) DO UPDATE SET claimed_at=excluded.claimed_at
          WHERE broker_account_owners.user_id=excluded.user_id AND broker_account_owners.scope='b2'
            AND broker_account_owners.mode=excluded.mode`).run(account.id, uid, input.mode, timestamp());
        if (!owner.changes) throw new B2Error('This broker account is already assigned to another user, mode or trading scope.');
        const old = credential(uid, input.mode);
        db.prepare(`INSERT INTO b2_credentials(user_id,mode,account_id,api_key,api_secret) VALUES (?,?,?,?,?)
          ON CONFLICT(user_id,mode) DO UPDATE SET account_id=excluded.account_id,api_key=excluded.api_key,api_secret=excluded.api_secret`)
          .run(uid, input.mode, account.id, next.api_key, next.api_secret);
        release(uid, old);
        db.prepare(`UPDATE b2_settings SET mode=?,enabled=?,live_armed=0,data_feed='sip',revision=revision+1,
           market_open=NULL,market_clock_at=NULL,scheduler_status='idle',scheduler_reason=NULL,data_error=NULL WHERE user_id=?`)
          .run(input.mode, 0, uid); // Never auto-enable: the user must explicitly start automation.
        automaticBotSettings?.revoke(uid, 'b2');
      })();
      return status(uid);
    });
  }
  async function disconnect(uid) {
    return locked(uid, async lease => {
      ensure(uid);
      if (unresolved(uid).length) throw new B2Error('Resolve all B2 orders and positions before disconnecting.');
      const rows = db.prepare('SELECT * FROM b2_credentials WHERE user_id=?').all(uid);
      for (const row of rows) await assertEmpty(context(uid, lease, row.mode));
      db.transaction(() => {
        db.prepare('DELETE FROM b2_credentials WHERE user_id=?').run(uid);
        rows.forEach(row => release(uid, row));
        db.prepare("UPDATE b2_settings SET enabled=0,live_armed=0,data_feed='sip',market_open=NULL,market_clock_at=NULL,revision=revision+1 WHERE user_id=?").run(uid);
        automaticBotSettings?.revoke(uid, 'b2');
      })();
      return status(uid);
    });
  }
  async function setMode(uid, input) {
    validateInput(input, ['mode', 'authorizeLive'], 'Only mode and live authorization may be supplied.');
    const { mode } = input;
    if (!['paper', 'live'].includes(mode)) throw new B2Error('Mode must be paper or live.', 400);
    return locked(uid, async lease => {
      const current = ensure(uid);
      if (unresolved(uid).length) throw new B2Error('Resolve all B2 orders and positions before switching modes.');
      if (credential(uid, current.mode)) await assertEmpty(context(uid, lease));
      const saved = credential(uid, mode);
      if (saved) {
        const ctx = context(uid, lease, mode);
        authorize(ctx);
        validateAccount(await broker(ctx, '/v2/account'), saved.account_id);
        if (mode !== current.mode) await assertEmpty(ctx);
        authorize(ctx);
      }
      assertActivationUnchanged(uid, current);
      db.prepare(`UPDATE b2_settings SET mode=?,enabled=?,live_armed=0,data_feed='sip',revision=revision+1,
         market_open=NULL,market_clock_at=NULL,scheduler_status='idle',scheduler_reason=NULL,data_error=NULL WHERE user_id=?`)
        .run(mode, 0, uid); // Never auto-enable: the user must explicitly start automation.
      automaticBotSettings?.revoke(uid, 'b2');
      return status(uid);
    });
  }
  async function setSettings(uid, input) {
    validateInput(input, ['maxPositionDollars'], 'Only maximum position dollars may be changed.');
    if (input.maxPositionDollars !== undefined && (typeof input.maxPositionDollars !== 'number' ||
        !Number.isFinite(input.maxPositionDollars) || input.maxPositionDollars < 1 || input.maxPositionDollars > 100000000)) {
      throw new B2Error('Maximum position dollars must be between $1 and $100,000,000.', 400);
    }
    return locked(uid, async () => {
      const current = ensure(uid);
      db.prepare('UPDATE b2_settings SET max_position_dollars=?,revision=revision+1 WHERE user_id=?')
        .run(input.maxPositionDollars ?? current.max_position_dollars, uid);
      return status(uid);
    });
  }
  async function setAutomation(uid, input) {
    validateInput(input, ['action', 'authorizeLive'], 'Only action and live authorization may be supplied.');
    if (!['pause', 'resume'].includes(input.action)) throw new B2Error('Action must be pause or resume.', 400);
    if (input.action === 'resume' && !persistenceReady()) {
      throw new B2Error('Automated trading persistence is unavailable; B2 entries remain paused. Publish the database schema before resuming.', 503);
    }
    if (input.action === 'pause') {
      ensure(uid);
      // Emergency entry revocation must not wait for a scan's lease or invalidate
      // its protective actions. Pending activation attempts observe this revision.
      db.prepare(`UPDATE b2_settings SET enabled=0,live_armed=0,automation_revision=automation_revision+1,
        scheduler_status='paused',scheduler_reason='Paused; owned trades still reconciled.' WHERE user_id=?`).run(uid);
      automaticBotSettings?.revoke(uid, 'b2');
      if (durability?.flush) await durability.flush('b2-paused');
      return status(uid);
    }
    return locked(uid, async lease => {
      const ctx = context(uid, lease);
      if (ctx.settings.mode === 'live' && input.authorizeLive !== true) {
        throw new B2Error('Live automation requires fresh explicit authorization.', 400);
      }
      authorize(ctx);
      validateAccount(await broker(ctx, '/v2/account'), ctx.cred.account_id);
      authorize(ctx);
      assertActivationUnchanged(uid, ctx.settings);
      const activate = () => db.prepare(`UPDATE b2_settings SET enabled=1,live_armed=?,revision=revision+1,
        scheduler_status='idle',scheduler_reason=NULL WHERE user_id=?`).run(Number(ctx.settings.mode === 'live'), uid);
      if (ctx.settings.mode === 'live' && automaticBotSettings) automaticBotSettings.arm(uid, 'b2', activate);
      else activate();
      return status(uid);
    });
  }
  function candidates(uid) {
    const setting = getSettings(uid);
    const cred = setting && credential(uid, setting.mode);
    if (!cred) return { candidates: [], coverage: coverage(null) };
    const values = db.prepare('SELECT result FROM b2_candidates WHERE account_id=? ORDER BY symbol').all(cred.account_id)
      .map(row => {
        const result = JSON.parse(row.result);
        const age = now() - Date.parse(result.evaluatedAt);
        if (!Number.isFinite(age) || age > 120000 || age < -5000) {
          return { ...result, eligible: false, signal: 'WAIT',
            reasons: [...(result.reasons || []), 'Candidate evidence is stale; a fresh scan and complete order validation are required.'] };
        }
        return result;
      }).sort(rules.rankB2Candidates);
    return { candidates: values, coverage: coverage(cred.account_id) };
  }
  function trades(uid) {
    return { trades: db.prepare(`SELECT symbol,mode,status,entry_price AS entryPrice,filled_shares AS filledShares,
      stop_price AS stopPrice,exit_price AS exitPrice,pnl,exit_requested AS exitRequested,exit_reason AS exitReason,created_at AS createdAt FROM b2_trades WHERE user_id=? ORDER BY id DESC LIMIT 500`).all(uid) };
  }
  function alerts(uid) {
    return { alerts: db.prepare('SELECT type,message,created_at AS createdAt FROM b2_alerts WHERE user_id=? ORDER BY id DESC LIMIT 200').all(uid) };
  }
  async function market(ctx) {
    const clock = await broker(ctx, '/v2/clock');
    const brokerNow = Date.parse(clock?.timestamp);
    if (!Number.isFinite(brokerNow) || Math.abs(now() - brokerNow) > 120000 || typeof clock.is_open !== 'boolean') {
      throw new B2Error('Broker clock is missing or stale.');
    }
    const replayDates = unresolved(ctx.uid).filter(t => t.account_id === ctx.cred.account_id)
      .map(t => Date.parse(`${t.last_exit_session || easternDate(t.created_at)}T00:00:00Z`)).filter(Number.isFinite);
    // Verify the complete MA window and every replayed exit session, including
    // holdings that predate the normal lookback. loadBars extends its start too.
    const start = easternDate(Math.min(brokerNow - 400 * 86400000, ...replayDates.map(date => date - 300 * 86400000)));
    const end = easternDate(brokerNow);
    const calendar = await broker(ctx, `/v2/calendar?start=${start}&end=${end}`);
    if (!Array.isArray(calendar) || calendar.some(session => !Number.isFinite(sessionClose(session)))) {
      throw new B2Error('Broker calendar is unavailable or malformed.');
    }
    const completed = calendar.filter(s => sessionClose(s) < brokerNow).sort((a, b) => a.date.localeCompare(b.date));
    const completedSessionDates = completed.map(session => session.date);
    if (completed.length < 65 || new Set(completedSessionDates).size !== completed.length) {
      throw new B2Error('Completed trading-session calendar is not verified.');
    }
    return { clock, expectedSessionDate: completed[completed.length - 1].date, completedSessionDates };
  }
  async function catalog(ctx) {
    const account = ctx.cred.account_id;
    const state = db.prepare('SELECT * FROM b2_coverage WHERE account_id=?').get(account);
    if (state && now() - state.catalog_at < 6 * 3600000) return;
    const assets = await broker(ctx, '/v2/assets?status=active&asset_class=us_equity');
    if (!Array.isArray(assets) || !assets.length) throw new B2Error('Tradable asset universe is unavailable.');
    const eligible = [...new Map(assets.filter(a => a?.status === 'active' && a.tradable === true &&
      a.class === 'us_equity' && typeof a.symbol === 'string' && a.symbol.trim()).map(a => [a.symbol, a])).values()];
    if (!eligible.length) throw new B2Error('Tradable asset universe is empty.');
    guard(ctx.lease);
    db.transaction(() => {
      const oldSymbols = db.prepare('SELECT symbol FROM b2_universe WHERE account_id=? ORDER BY symbol').all(account).map(a => a.symbol);
      const sorted = eligible.sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
      const membershipChanged = oldSymbols.length !== sorted.length || oldSymbols.some((symbol, index) => symbol !== sorted[index].symbol);
      db.prepare('DELETE FROM b2_universe WHERE account_id=?').run(account);
      const insert = db.prepare('INSERT OR REPLACE INTO b2_universe(account_id,symbol,asset) VALUES (?,?,?)');
      sorted.forEach(asset => insert.run(account, asset.symbol, JSON.stringify(asset)));
      const next = membershipChanged ? 0 : state?.cursor || 0;
      db.prepare(`INSERT INTO b2_coverage(account_id,total,catalog_at,cursor,scanned) VALUES (?,?,?,?,0)
        ON CONFLICT(account_id) DO UPDATE SET total=excluded.total,catalog_at=excluded.catalog_at,cursor=excluded.cursor,
          scanned=?`).run(account, sorted.length, now(), next, membershipChanged ? 0 : state?.scanned || 0);
      db.prepare('DELETE FROM b2_candidates WHERE account_id=? AND symbol NOT IN (SELECT symbol FROM b2_universe WHERE account_id=?)').run(account, account);
    })();
  }
  async function loadBars(ctx, symbols, expectedSessionDate, since) {
    const result = Object.fromEntries(symbols.map(s => [s, []]));
    const start = new Date(Math.min(Date.parse(`${expectedSessionDate}T00:00:00Z`),
      since ? Date.parse(`${since}T00:00:00Z`) : Infinity) - 300 * 86400000).toISOString();
    const end = new Date(Date.parse(`${expectedSessionDate}T00:00:00Z`) + 86400000).toISOString();
    let page = null;
    const seen = new Set();
    // Alpaca pages across symbols, not one page per symbol. Exhaust pagination.
    for (let count = 0; count < 50; count++) {
      const query = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start, end, limit: '10000', adjustment: 'all',
        feed: ctx.feed || 'sip', sort: 'asc' });
      if (page) query.set('page_token', page);
      const data = await broker(ctx, `/v2/stocks/bars?${query}`, { data: true });
      if (!data?.bars || typeof data.bars !== 'object') throw new B2Error('Historical bars are unavailable.');
      for (const symbol of symbols) {
        if (data.bars[symbol] !== undefined && !Array.isArray(data.bars[symbol])) throw new B2Error('Historical bars are malformed.');
        result[symbol].push(...(data.bars[symbol] || []));
      }
      page = data.next_page_token;
      if (!page) return result;
      if (seen.has(page)) throw new B2Error('Historical bar pagination repeated a token.');
      seen.add(page);
    }
    throw new B2Error('Historical bar pagination exceeded its safety bound.');
  }
  async function resolveFeed(ctx) {
    let saved = getSettings(ctx.uid)?.data_feed || 'sip';
    // Live is SIP-only. Never honor a stale persisted Paper fallback after
    // switching modes, including across a process restart.
    if (ctx.cred.mode === 'live' && saved === 'iex') {
      db.prepare("UPDATE b2_settings SET data_feed='sip' WHERE user_id=?").run(ctx.uid);
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
      const maxAge = rules.B2_RULES?.maxQuoteAgeMs || 60000;
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
        // Verify the substitute feed before persisting it. A failed or
        // malformed IEX probe must remain fail-closed on SIP.
        let iexProbe;
        try {
          iexProbe = await request(ctx.cred, '/v2/stocks/SPY/snapshot?feed=iex',
            { data: true, ctx, entitlementProbe: true });
        } catch (iexError) {
          const message = iexError.httpStatus
            ? `Alpaca IEX market-data probe was rejected (HTTP ${iexError.httpStatus}).`
            : 'Alpaca IEX market-data probe failed; feed selection withheld.';
          db.prepare('UPDATE b2_settings SET data_error=? WHERE user_id=?').run(message, ctx.uid);
          throw iexError;
        }
        if (!validProbe(iexProbe)) {
          db.prepare("UPDATE b2_settings SET data_error='Alpaca IEX market-data probe was malformed; feed selection withheld.' WHERE user_id=?")
            .run(ctx.uid);
          throw new B2Error('IEX market data probe is malformed.');
        }
        db.prepare("UPDATE b2_settings SET data_feed='iex',data_error=NULL WHERE user_id=?").run(ctx.uid);
        ctx.feed = 'iex';
        return ctx.feed;
      }
      if (error.httpStatus === 403 && ctx.cred.mode === 'live') {
        db.prepare("UPDATE b2_settings SET data_error='Consolidated SIP market data entitlement is required.' WHERE user_id=?")
          .run(ctx.uid);
        throw new B2Error('Consolidated SIP market data entitlement is required for Live B2; entries withheld.');
      }
      const message = error.httpStatus
        ? `Alpaca SIP market-data probe was rejected (HTTP ${error.httpStatus}).`
        : 'Alpaca SIP market-data probe failed; feed selection withheld.';
      db.prepare('UPDATE b2_settings SET data_error=? WHERE user_id=?').run(message, ctx.uid);
      throw error;
    }
    if (!validProbe(probe)) {
      db.prepare("UPDATE b2_settings SET data_error='Alpaca SIP market-data probe was malformed; feed selection withheld.' WHERE user_id=?")
        .run(ctx.uid);
      throw new B2Error('Market data entitlement probe is malformed.');
    }
    ctx.feed = 'sip';
    return ctx.feed;
  }
  async function evaluate(ctx, assets, marketState) {
    const symbols = assets.map(a => a.symbol);
    if (!symbols.length) return [];
    const bars = await loadBars(ctx, symbols, marketState.expectedSessionDate);
    const snapshots = await broker(ctx, `/v2/stocks/snapshots?${new URLSearchParams({ symbols: symbols.join(','), feed: ctx.feed || 'sip' })}`, { data: true });
    if (!snapshots || typeof snapshots !== 'object') throw new B2Error('Market snapshots are unavailable.');
    return assets.map(asset => {
      const history = bars[asset.symbol];
      const snapshot = snapshots[asset.symbol] || {};
      const liquidity = evaluateAlpacaLiquidity(snapshot, {
        now: now(), marketState: marketState.clock?.is_open ? 'REGULAR' : 'CLOSED',
      });
      // Exit/protection decisions are authoritative and must never depend on an
      // entry-liquidity screen. Attach the evidence, then gate BUY research only.
      const result = rules.evaluateB2({ bars: history, snapshot, asset,
        now: now(), expectedSessionDate: marketState.expectedSessionDate, completedSessionDates: marketState.completedSessionDates });
      result.sharedContext = marketState.sharedContext || null;
      if (result.signal === 'EXIT' || result.crossover === 'BEARISH') {
        return { ...result, liquidity };
      }
      if (!liquidity.eligible) {
        return {
          ...result,
          eligible: false,
          signal: 'WAIT',
          reasons: [...(result.reasons || []), ...liquidity.reasons],
          gates: [...(result.gates || []), {
            name: 'Shared liquidity policy', passed: false, reason: liquidity.reasons.join(' '),
          }],
          liquidity,
        };
      }
      if (history.length < 100) {
        return { ...result, eligible: false, signal: result.signal === 'EXIT' ? 'EXIT' : 'WAIT',
          reasons: [...(result.reasons || []), 'At least 100 completed daily bars are required.'], liquidity };
      }
      return { ...result, liquidity };
    });
  }
  async function scanContext(ctx, marketState, sharedContext = null) {
    const strategyMarketState = { ...marketState, sharedContext };
    await catalog(ctx);
    const state = db.prepare('SELECT * FROM b2_coverage WHERE account_id=?').get(ctx.cred.account_id);
    const all = db.prepare('SELECT asset FROM b2_universe WHERE account_id=? ORDER BY symbol').all(ctx.cred.account_id);
    const selection = selectScanAssets(ctx, state, all);
    const assets = selection.assets;
    let results;
    try {
      results = (await evaluate(ctx, assets, strategyMarketState)).map(normalizeScanResult);
    } catch (error) {
      const failure = scanFailure(error);
      results = assets.map(asset => ({
        symbol: asset.symbol,
        eligible: false,
        signal: 'WAIT',
        outcome: failure.outcome,
        reasonCode: failure.reasonCode,
        reasons: [failure.reason],
      }));
      persistScanResults(ctx, state, selection, results, failure.reason);
      error.scanPersisted = true;
      throw error;
    }
    return persistScanResults(ctx, state, selection, results).sort(rules.rankB2Candidates);
  }
  async function scan(uid) {
    return locked(uid, async lease => {
      const ctx = context(uid, lease);
      try {
        authorize(ctx);
        const state = await market(ctx);
        await resolveFeed(ctx);
        await scanContext(ctx, state);
        return candidates(uid);
      } catch (error) {
        if (!error.scanPersisted) {
          const failure = scanFailure(error);
          try {
            await catalog(ctx);
            const state = db.prepare('SELECT * FROM b2_coverage WHERE account_id=?').get(ctx.cred.account_id);
            const all = db.prepare('SELECT asset FROM b2_universe WHERE account_id=? ORDER BY symbol').all(ctx.cred.account_id);
            if (state && all.length) {
              const selection = selectScanAssets(ctx, state, all);
              const assets = selection.assets;
              const results = assets.map(asset => ({
                symbol: asset.symbol,
                eligible: false,
                signal: 'WAIT',
                outcome: failure.outcome,
                reasonCode: failure.reasonCode,
                reasons: [failure.reason],
              }));
              persistScanResults(ctx, state, selection, results, failure.reason);
            }
          } catch (_) {
            // The original scan error remains authoritative; a missing universe
            // cannot be turned into fabricated per-symbol results.
          }
        }
        throw error;
      }
    });
  }
  function updateTrade(id, fields) {
    const entries = Object.entries({ ...fields, updated_at: timestamp() });
    db.prepare(`UPDATE b2_trades SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([, value]) => value), id);
  }
  const reload = id => db.prepare('SELECT * FROM b2_trades WHERE id=?').get(id);
  function problem(ctx, trade, message) {
    updateTrade(trade.id, { protection: 'unknown' });
    alert(ctx.uid, ctx.cred.account_id, 'protection', message);
  }
  async function orderByClient(ctx, id) {
    return broker(ctx, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`, { allow404: true });
  }
  async function readOrder(ctx, id) {
    return broker(ctx, `/v2/orders/${encodeURIComponent(id)}?nested=true`);
  }
  function ownedOrder(order, trade, side) {
    return order?.id && order.symbol === trade.symbol && order.side === side;
  }
  async function latestStop(ctx, order) {
    const seen = new Set();
    while (order?.replaced_by) {
      if (seen.has(order.id) || seen.size > 8) throw new B2Error('Protective replacement chain is unresolved.');
      seen.add(order.id);
      order = await readOrder(ctx, order.replaced_by);
    }
    return order;
  }
  function recordExitFill(trade, order) {
    if (!ownedOrder(order, trade, 'sell')) throw new B2Error('Exit order ownership is not verified.');
    const quantity = number(order.filled_qty);
    if (quantity > 0) {
      if (!(number(order.filled_avg_price) > 0)) throw new B2Error('Exit fill price is missing.');
      db.prepare(`INSERT INTO b2_exit_fills(trade_id,order_id,shares,price) VALUES (?,?,?,?)
        ON CONFLICT(trade_id,order_id) DO UPDATE SET shares=excluded.shares,price=excluded.price`)
        .run(trade.id, order.id, quantity, number(order.filled_avg_price));
    }
  }
  function exited(trade) {
    return db.prepare('SELECT COALESCE(SUM(shares),0) AS shares,COALESCE(SUM(shares*price),0) AS proceeds FROM b2_exit_fills WHERE trade_id=?').get(trade.id);
  }
  async function finishExit(ctx, trade, order) {
    recordExitFill(trade, order);
    const positions = await broker(ctx, '/v2/positions');
    if (!Array.isArray(positions)) throw new B2Error('Positions are unavailable.');
    const remaining = positions.find(p => p.symbol === trade.symbol && number(p.qty) !== 0);
    const fills = exited(trade);
    if (TERMINAL.has(order.status) && !remaining && fills.shares === number(trade.filled_shares) && fills.shares > 0) {
      if (trade.exit_client_id && order.client_order_id === trade.exit_client_id) {
        db.prepare('UPDATE b2_close_attempts SET order_id=?,status=? WHERE trade_id=? AND generation=?')
          .run(order.id, order.status, trade.id, trade.exit_generation);
      }
      updateTrade(trade.id, { status: 'closed', protection: 'settled', exit_price: fills.proceeds / fills.shares,
        pnl: fills.proceeds - trade.entry_price * trade.filled_shares });
      return true;
    }
    return false;
  }
  async function settleFailedClose(ctx, trade, exit) {
    if (exit) recordExitFill(trade, exit);
    await restoreProtection(ctx, trade);
    if (reload(trade.id).protection !== 'protected') return;
    db.transaction(() => {
      db.prepare('UPDATE b2_close_attempts SET order_id=?,status=? WHERE trade_id=? AND generation=?')
        .run(exit?.id || null, exit?.status || 'rejected', trade.id, trade.exit_generation);
      // Only definitive terminal failures get a fresh durable generation.
      // Unknown POSTs and unsettled cancellations never pass this branch.
      updateTrade(trade.id, { exit_client_id: null, exit_id: null, exit_rejected: 0,
        exit_generation: trade.exit_generation + 1, retry_after: now() + 60000, status: 'exit_retry' });
    })();
  }
  async function resolveRestoreIntent(ctx, trade) {
    if (!trade.restore_client_id) return true;
    // stop_id can still reference the canceled predecessor after a lost POST
    // response. The durable restore intent, not that predecessor, determines
    // which sell must be reconciled before any competing close is permitted.
    const restored = await orderByClient(ctx, trade.restore_client_id);
    if (!restored) {
      updateTrade(trade.id, { protection: 'restore_unknown' });
      alert(ctx.uid, ctx.cred.account_id, 'protection',
        'Protective restore acceptance is unresolved. Its reservation is retained; no competing close or duplicate stop will be sent.');
      return false;
    }
    if (!ownedOrder(restored, trade, 'sell') || restored.client_order_id !== trade.restore_client_id || restored.type !== 'stop') {
      throw new B2Error('Restored protective order ownership is not verified.');
    }
    const current = await latestStop(ctx, restored);
    if (!ownedOrder(current, trade, 'sell') || current.type !== 'stop') throw new B2Error('Restored protective replacement ownership is not verified.');
    updateTrade(trade.id, { stop_id: current.id,
      stop_price: Number.isFinite(number(current.stop_price)) ? number(current.stop_price) : null });
    return true;
  }
  async function reconcileTrade(ctx, initial) {
    let trade = reload(initial.id);
    if (!await resolveRestoreIntent(ctx, trade)) return;
    trade = reload(trade.id);
    const parent = trade.order_id ? await readOrder(ctx, trade.order_id) : await orderByClient(ctx, trade.client_id);
    if (!parent) {
      problem(ctx, trade, 'Entry submission is unresolved. No retry is permitted until broker acceptance is known.');
      return;
    }
    if (!ownedOrder(parent, trade, 'buy') || parent.client_order_id !== trade.client_id) throw new B2Error('Entry order ownership is not verified.');
    const filled = number(parent.filled_qty);
    if (!Number.isFinite(filled) || filled < 0) throw new B2Error('Broker entry fill data is unavailable.');
    updateTrade(trade.id, { order_id: parent.id, filled_shares: filled,
      entry_price: filled > 0 && Number.isFinite(number(parent.filled_avg_price)) ? number(parent.filled_avg_price) : null });
    const legs = Array.isArray(parent.legs) ? parent.legs : [];
    let stop = trade.stop_id ? await latestStop(ctx, await readOrder(ctx, trade.stop_id)) :
      legs.find(leg => leg.side === 'sell' && ['stop', 'stop_limit'].includes(leg.type));
    if (stop) stop = await latestStop(ctx, stop);
    if (stop && !ownedOrder(stop, trade, 'sell')) throw new B2Error('Protective order ownership is not verified.');
    if (stop) updateTrade(trade.id, { stop_id: stop.id, stop_price: Number.isFinite(number(stop.stop_price)) ? number(stop.stop_price) : null });
    trade = reload(trade.id);
    if (filled === 0 && TERMINAL.has(parent.status)) {
      if (stop && !TERMINAL.has(stop.status)) stop = await cancelConfirmed(ctx, stop);
      if (stop && number(stop.filled_qty) > 0) {
        problem(ctx, trade, 'Protective sell reported fills without an owned entry. Immediate broker review is required.');
        return;
      }
      if (!stop && parent.status !== 'rejected') {
        problem(ctx, trade, 'Terminal entry has no verifiable protective-child settlement.');
        return;
      }
      updateTrade(trade.id, { status: parent.status === 'rejected' ? 'rejected' : 'canceled', protection: 'settled' });
      return;
    }
    if (stop) {
      recordExitFill(trade, stop);
      if (stop.status === 'filled' && await finishExit(ctx, trade, stop)) return;
    }
    if (trade.exit_client_id) {
      if (trade.exit_rejected) { await settleFailedClose(ctx, trade, null); return; }
      const exit = trade.exit_id ? await readOrder(ctx, trade.exit_id) : await orderByClient(ctx, trade.exit_client_id);
      if (!exit) {
        problem(ctx, trade, 'Exit submission is unresolved. Manual broker review is required; no duplicate sell will be sent.');
        return;
      }
      if (!ownedOrder(exit, trade, 'sell') || exit.client_order_id !== trade.exit_client_id) throw new B2Error('Exit ownership is not verified.');
      updateTrade(trade.id, { exit_id: exit.id, status: 'exiting' });
      if (await finishExit(ctx, trade, exit)) return;
      if (TERMINAL.has(exit.status)) {
        await settleFailedClose(ctx, trade, exit);
      } else {
        problem(ctx, trade, 'Exit is pending or partially filled; broker settlement and protection require review.');
      }
      return;
    }
    if (filled === 0) {
      const attached = parent.order_class === 'oto' && stop && stop.type === 'stop' && ACTIVE_STOP.has(stop.status) &&
        number(stop.qty) === number(parent.qty) && number(stop.stop_price) === stopPrice(parent.limit_price);
      updateTrade(trade.id, { status: 'pending', protection: attached ? 'protected' : 'unknown' });
      if (!attached) alert(ctx.uid, ctx.cred.account_id, 'protection', 'Pending entry does not yet have a verified attached protective stop.');
      return;
    }
    if (!(trade.entry_price > 0)) { problem(ctx, trade, 'Entry fill price is missing; protective price cannot be verified.'); return; }
    const positions = await broker(ctx, '/v2/positions');
    if (!Array.isArray(positions)) throw new B2Error('Positions are unavailable.');
    const position = positions.find(p => p.symbol === trade.symbol);
    const remaining = filled - exited(trade).shares;
    if (!position || number(position.qty) !== remaining || number(position.qty) <= 0) {
      problem(ctx, trade, 'Broker position differs from owned entry fills. No unrelated shares will be managed.');
      return;
    }
    if (!stop || !ACTIVE_STOP.has(stop.status) || stop.status === 'held') {
      problem(ctx, trade, 'Filled shares lack a verified active 5% protective stop. New entries are blocked.');
      // Alpaca can hold OTO children until full fill: cancel the remaining parent,
      // settle its child, then protect confirmed shares without competing sells.
      if (!trade.exit_requested && trade.restore_client_id) {
        await restoreProtection(ctx, trade);
      } else if (!trade.exit_requested && stop && (stop.status === 'held' || ['canceled', 'expired', 'rejected'].includes(stop.status))) {
        try {
          const settledParent = await cancelConfirmed(ctx, parent);
          if (!TERMINAL.has(settledParent.status)) return;
          let settledStop = stop && await latestStop(ctx, await readOrder(ctx, stop.id));
          if (settledStop && !TERMINAL.has(settledStop.status)) {
            if (ACTIVE_STOP.has(settledStop.status) && settledStop.status !== 'held') return;
            settledStop = await cancelConfirmed(ctx, settledStop);
          }
          if (settledStop) recordExitFill(trade, settledStop);
          updateTrade(trade.id, { filled_shares: number(settledParent.filled_qty), entry_price: number(settledParent.filled_avg_price) });
          await restoreProtection(ctx, reload(trade.id));
        } catch (_) {
          alert(ctx.uid, ctx.cred.account_id, 'protection', 'Partial-fill protection could not be confirmed. Broker review is required.');
        }
      }
      return;
    }
    // Lock the filled quantity before resizing a live child. Otherwise a late
    // parent fill could arrive after the replacement and remain unprotected.
    if (!TERMINAL.has(parent.status)) {
      try {
        await cancelConfirmed(ctx, parent);
        await reconcileTrade(ctx, trade);
      } catch (_) { problem(ctx, trade, 'Partial entry cancellation is unresolved; its active stop has been retained.'); }
      return;
    }
    const target = stopPrice(trade.entry_price);
    if (!Number.isFinite(number(stop.stop_price)) || number(stop.stop_price) + 0.00001 < target ||
        number(stop.qty) - number(stop.filled_qty || 0) !== remaining) {
      try {
        if (legs.some(leg => leg.id === stop.id) && parent.order_class === 'oto') {
          throw new B2Error('Alpaca does not support replacement of OTO legs. Existing protection is retained for broker review.');
        }
        const replacement = await broker(ctx, `/v2/orders/${encodeURIComponent(stop.id)}`, {
          method: 'PATCH', body: { stop_price: String(target), qty: String(remaining + number(stop.filled_qty || 0)) },
        });
        if (!ownedOrder(replacement, trade, 'sell')) throw new B2Error('Protective replacement was not confirmed.');
        stop = await latestStop(ctx, await readOrder(ctx, replacement.id));
        if (!ACTIVE_STOP.has(stop.status) || stop.status === 'held' || !Number.isFinite(number(stop.stop_price)) ||
            number(stop.stop_price) + 0.00001 < target ||
            number(stop.qty) - number(stop.filled_qty || 0) !== remaining) {
          throw new B2Error('Protective replacement is not active.');
        }
        updateTrade(trade.id, { stop_id: stop.id, stop_price: number(stop.stop_price) });
      } catch (error) {
        problem(ctx, trade, error instanceof B2Error && error.message.startsWith('Alpaca does not support') ?
          error.message : 'Protective stop replacement is unresolved; the existing stop was not canceled.');
        return;
      }
    }
    updateTrade(trade.id, { status: parent.status === 'filled' ? 'open' : 'partial', protection: 'protected' });
  }
  async function restoreProtection(ctx, trade) {
    const positions = await broker(ctx, '/v2/positions');
    if (!Array.isArray(positions)) throw new B2Error('Positions are unavailable.');
    const position = positions.find(p => p.symbol === trade.symbol);
    if (!position || !(number(position.qty) > 0) || number(position.qty) !== trade.filled_shares - exited(trade).shares) {
      problem(ctx, trade, 'Failed exit quantity cannot be reconciled; broker review is required.');
      return;
    }
    const id = trade.restore_client_id || clientId(trade.client_id, 'restore', trade.stop_id || 'entry');
    let stop = await orderByClient(ctx, id);
    if (stop && ['canceled', 'expired', 'rejected'].includes(stop.status) && number(stop.filled_qty) === 0 &&
        trade.restore_client_id && stop.id === trade.stop_id) {
      updateTrade(trade.id, { restore_client_id: null });
      return restoreProtection(ctx, reload(trade.id));
    }
    // Persist intent before POST; an ambiguous restore is never blindly retried.
    if (!stop && !trade.restore_client_id) {
      updateTrade(trade.id, { protection: 'restore_unknown', restore_client_id: id });
      try {
        stop = await broker(ctx, '/v2/orders', { method: 'POST', body: {
          symbol: trade.symbol, qty: String(position.qty), side: 'sell', type: 'stop',
          time_in_force: 'gtc', stop_price: String(stopPrice(trade.entry_price)), client_order_id: id,
        } });
      } catch (_) { stop = await orderByClient(ctx, id); }
    }
    if (ownedOrder(stop, trade, 'sell') && ACTIVE_STOP.has(stop.status) && stop.status !== 'held' &&
        number(stop.qty) - number(stop.filled_qty || 0) === number(position.qty) &&
        number(stop.stop_price) >= stopPrice(trade.entry_price)) {
      updateTrade(trade.id, { stop_id: stop.id, stop_price: number(stop.stop_price), protection: 'protected',
        status: trade.exit_client_id ? 'exit_failed' : 'open' });
      alert(ctx.uid, ctx.cred.account_id, trade.exit_client_id ? 'exit' : 'protection',
        trade.exit_client_id ? 'Bearish exit failed. A broker-held stop was restored; a new close attempt may run after confirmed settlement and a cooldown.' :
          'Remaining partial entry was canceled and confirmed filled shares now have a broker-held protective stop.');
    } else {
      updateTrade(trade.id, { protection: 'restore_unknown' });
      alert(ctx.uid, ctx.cred.account_id, 'protection', 'Failed exit protection could not be confirmed. Immediate broker review is required.');
    }
  }
  async function cancelConfirmed(ctx, order, depth = 0) {
    if (depth > 8) throw new B2Error('Cancellation replacement chain is unresolved.');
    if (order.replaced_by) return cancelConfirmed(ctx, await latestStop(ctx, order), depth + 1);
    if (order.status === 'replaced') throw new B2Error('Replacement identity is unavailable; cancellation is not settled.');
    if (TERMINAL.has(order.status)) return order;
    await broker(ctx, `/v2/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE' });
    const settled = await readOrder(ctx, order.id);
    if (settled.replaced_by) return cancelConfirmed(ctx, await latestStop(ctx, settled), depth + 1);
    if (settled.status === 'replaced') throw new B2Error('Replacement identity is unavailable; cancellation is not settled.');
    if (!TERMINAL.has(settled.status)) throw new B2Error('Order cancellation is not settled.');
    return settled;
  }
  function safeExitWindow(clock) {
    const brokerTime = Date.parse(clock?.timestamp);
    const closes = Date.parse(clock?.next_close);
    return clock?.is_open === true && Number.isFinite(brokerTime) && Math.abs(now() - brokerTime) <= 120000 &&
      Number.isFinite(closes) && closes - Math.max(now(), brokerTime) > 120000;
  }
  async function bearishExitAttempt(ctx, initial) {
    let trade = reload(initial.id);
    if (CLOSED.has(trade.status) || trade.exit_client_id || trade.retry_after > now()) return;
    updateTrade(trade.id, { exit_requested: 1 });
    const clock = await broker(ctx, '/v2/clock');
    const closeLabel = trade.exit_reason === 'take_profit' ? 'Take-profit close' : 'Bearish close';
    if (!safeExitWindow(clock)) {
      alert(ctx.uid, ctx.cred.account_id, 'exit', `${closeLabel} deferred: the broker must confirm an open market with more than two minutes before close. Existing protection is retained.`);
      return;
    }
    // Stop any remaining parent fills before canceling its protective child.
    let parent = await readOrder(ctx, trade.order_id);
    if (!ownedOrder(parent, trade, 'buy') || parent.client_order_id !== trade.client_id) throw new B2Error('Entry ownership is not verified.');
    if (!TERMINAL.has(parent.status)) parent = await cancelConfirmed(ctx, parent);
    await reconcileTrade(ctx, trade);
    trade = reload(trade.id);
    if (CLOSED.has(trade.status)) return;
    // Reconciliation can return without resolving a restore. Never clear its
    // client ID merely because the old stop_id points to a canceled child.
    if (!await resolveRestoreIntent(ctx, trade)) return;
    trade = reload(trade.id);
    if (!trade.stop_id) throw new B2Error('Cannot safely close an unverified protected position.');
    const stop = await latestStop(ctx, await readOrder(ctx, trade.stop_id));
    if (!ownedOrder(stop, trade, 'sell')) throw new B2Error('Stop ownership is not verified.');
    try {
      const settled = await cancelConfirmed(ctx, stop);
      recordExitFill(trade, settled);
      if (settled.status === 'filled') { await reconcileTrade(ctx, trade); return; }
      updateTrade(trade.id, { status: 'closing', protection: 'unknown', restore_client_id: null });
    } catch (_) {
      problem(ctx, trade, 'Protective stop cancellation is unresolved. No close order will be sent.');
      return;
    }
    // Refresh actual parent fills and positions after confirmed cancel; never use stale requested quantity.
    parent = await readOrder(ctx, trade.order_id);
    const positions = await broker(ctx, '/v2/positions');
    if (!Array.isArray(positions)) throw new B2Error('Positions are unavailable after stop cancellation.');
    const position = positions.find(p => p.symbol === trade.symbol);
    const quantity = number(position?.qty);
    if (!(quantity > 0) || quantity !== number(parent.filled_qty) - exited(trade).shares || !(number(parent.filled_avg_price) > 0)) {
      problem(ctx, trade, 'Position quantity changed during close. Broker review is required.');
      await restoreProtection(ctx, trade);
      return;
    }
    const finalClock = await broker(ctx, '/v2/clock');
    if (!safeExitWindow(finalClock)) {
      await restoreProtection(ctx, reload(trade.id));
      alert(ctx.uid, ctx.cred.account_id, 'exit', 'Close window ended after stop cancellation. GTC protection restoration was attempted; bearish intent is retained for the next safe market window.');
      return;
    }
    const exitClient = clientId(trade.client_id, 'bearish-exit', trade.exit_generation);
    db.transaction(() => {
      updateTrade(trade.id, { exit_client_id: exitClient, status: 'exit_unknown', protection: 'unknown',
        filled_shares: number(parent.filled_qty), entry_price: number(parent.filled_avg_price) });
      db.prepare(`INSERT INTO b2_close_attempts(trade_id,generation,client_id,status,created_at) VALUES (?,?,?,'submission_unknown',?)`)
        .run(trade.id, trade.exit_generation, exitClient, timestamp());
    })();
    let exit;
    try {
      exit = await broker(ctx, '/v2/orders', { method: 'POST', body: {
        symbol: trade.symbol, qty: String(quantity), side: 'sell', type: 'market',
        time_in_force: 'day', client_order_id: exitClient,
      } });
    } catch (error) {
      exit = await orderByClient(ctx, exitClient);
      if (exit) {
        if (ownedOrder(exit, trade, 'sell') && exit.client_order_id === exitClient) updateTrade(trade.id, { exit_id: exit.id });
        await reconcileTrade(ctx, reload(trade.id));
        return;
      }
      if ([400, 401, 403, 404, 422].includes(error.httpStatus) && !error.duplicateClient) {
        updateTrade(trade.id, { exit_rejected: 1 });
        await settleFailedClose(ctx, reload(trade.id), null);
        return;
      }
    }
    if (ownedOrder(exit, trade, 'sell') && exit.client_order_id === exitClient) updateTrade(trade.id, { exit_id: exit.id });
    await reconcileTrade(ctx, reload(trade.id));
  }
  async function bearishExit(ctx, initial) {
    try { await bearishExitAttempt(ctx, initial); }
    catch (error) {
      const trade = reload(initial.id);
      if (trade.exit_requested && !trade.exit_client_id && trade.protection === 'unknown' && trade.stop_id) {
        try {
          const stop = await latestStop(ctx, await readOrder(ctx, trade.stop_id));
          if (['canceled', 'expired', 'rejected'].includes(stop.status)) await restoreProtection(ctx, trade);
        } catch (_) {
          alert(ctx.uid, ctx.cred.account_id, 'protection', 'Close preparation failed after stop cancellation. Residual protection is unconfirmed; immediate broker review is required.');
        }
      }
      throw error;
    }
  }
  async function expirePending(ctx, state) {
    for (const trade of unresolved(ctx.uid).filter(t => t.account_id === ctx.cred.account_id && t.order_id)) {
      const signalDate = trade.signal_date || String(trade.event_id).split(':')[1];
      if (state.clock.is_open && signalDate === state.expectedSessionDate) continue;
      const parent = await readOrder(ctx, trade.order_id);
      if (!ownedOrder(parent, trade, 'buy') || parent.client_order_id !== trade.client_id) throw new B2Error('Entry ownership is not verified.');
      // Never cancel a filled parent's stop when its signal/session expires.
      if (number(parent.filled_qty) === 0 && !TERMINAL.has(parent.status)) {
        await cancelConfirmed(ctx, parent);
        await reconcileTrade(ctx, trade);
      }
    }
  }
  async function settleClosingWindow(ctx, state) {
    if (safeExitWindow(state.clock)) return;
    for (const trade of unresolved(ctx.uid).filter(t => t.account_id === ctx.cred.account_id && t.exit_client_id)) {
      const exit = trade.exit_id ? await readOrder(ctx, trade.exit_id) : await orderByClient(ctx, trade.exit_client_id);
      if (!exit || !ownedOrder(exit, trade, 'sell') || exit.client_order_id !== trade.exit_client_id) {
        problem(ctx, trade, 'Close acceptance is unknown near the bell. No competing stop or duplicate sell will be sent; immediate broker review is required.');
        continue;
      }
      try {
        const settled = await cancelConfirmed(ctx, exit);
        recordExitFill(trade, settled);
        await reconcileTrade(ctx, trade);
      } catch (_) {
        problem(ctx, trade, 'Close cancellation near the bell is unresolved. Residual protection requires immediate broker review.');
      }
    }
  }
  // Unrealized gain in percent for a long position. Prefers the broker's
  // unrealized_plpc; falls back to current vs average-entry price. Returns
  // null when no usable long position exists — the caller then skips the
  // take-profit check (fail closed; protection stays in place).
  function unrealizedGainPct(position, trade) {
    if (!(number(position?.qty) > 0)) return null;
    const plpc = number(position?.unrealized_plpc);
    if (Number.isFinite(plpc)) return plpc * 100;
    const current = number(position?.current_price);
    const avgEntry = number(position?.avg_entry_price) || number(trade?.entry_price);
    if (current > 0 && avgEntry > 0) return (current / avgEntry - 1) * 100;
    return null;
  }
  async function reconcile(ctx, marketState) {
    authorize(ctx);
    const records = unresolved(ctx.uid).filter(t => t.account_id === ctx.cred.account_id);
    for (const trade of records) {
      try { await reconcileTrade(ctx, trade); }
      catch (_) { problem(ctx, trade, 'Broker lifecycle reconciliation failed. New entries are blocked until resolved.'); }
    }
    if (!marketState?.clock.is_open) return;
    // Profit-target review reads live positions once per cycle. A failed
    // fetch skips only the target check; the bearish replay below still runs.
    let positionBySymbol = new Map();
    try {
      const positionList = await broker(ctx, '/v2/positions');
      if (!Array.isArray(positionList)) throw new B2Error('Broker positions are unavailable for profit-target review.');
      positionBySymbol = new Map(positionList.filter(p => number(p.qty) > 0).map(p => [p.symbol, p]));
    } catch (_) {
      alert(ctx.uid, ctx.cred.account_id, 'exit', 'Position profit-target review is unavailable; existing protection is retained.');
    }
    for (const initial of records) {
      const trade = reload(initial.id);
      if (CLOSED.has(trade.status) || !trade.order_id || trade.exit_client_id) continue;
      try {
        if (trade.exit_requested) { await bearishExit(ctx, trade); continue; }
        const gainPct = unrealizedGainPct(positionBySymbol.get(trade.symbol), trade);
        if (gainPct !== null && gainPct >= rules.B2_RULES.takeProfitPct) {
          updateTrade(trade.id, { exit_requested: 1, exit_reason: 'take_profit' });
          await bearishExit(ctx, reload(trade.id));
          continue;
        }
        // Replay every completed session since the entry / last successful check.
        // No snapshot or entry-filter dependency: an outage must not lose an exit.
        const since = trade.last_exit_session || easternDate(trade.created_at);
        const history = (await loadBars(ctx, [trade.symbol], marketState.expectedSessionDate, since))[trade.symbol];
        const dateOf = rules.sessionDate || easternDate;
        let bearish = false;
        let checked = since;
        for (let i = 64; i < history.length; i++) {
          const date = dateOf(history[i].t);
          if (date <= since || date > marketState.expectedSessionDate) continue;
          const result = rules.evaluateB2({ bars: history.slice(0, i + 1), asset: { symbol: trade.symbol },
            now: now(), expectedSessionDate: date,
            completedSessionDates: marketState.completedSessionDates.filter(session => session <= date) });
          if (!Number.isFinite(number(result.metrics?.fastMA))) throw new B2Error('Owned position daily history is incomplete.');
          checked = date;
          if (result.crossover === 'BEARISH' || result.signal === 'EXIT') { bearish = true; break; }
        }
        if (checked !== marketState.expectedSessionDate && !bearish) throw new B2Error('Owned position completed-session history is stale.');
        updateTrade(trade.id, { last_exit_session: checked, ...(bearish ? { exit_requested: 1, exit_reason: 'bearish' } : {}) });
        if (bearish) await bearishExit(ctx, reload(trade.id));
      } catch (_) { alert(ctx.uid, ctx.cred.account_id, 'exit', 'Owned position exit evaluation or execution is unavailable; existing protection is retained where possible.'); }
    }
  }
  async function enter(ctx, candidate, marketState) {
    authorize(ctx, true);
    if (unresolved(ctx.uid).some(t => t.protection !== 'protected' || t.exit_requested)) return;
    if (db.prepare('SELECT 1 FROM b2_trades WHERE account_id=? AND symbol=? AND event_id=?')
      .get(ctx.cred.account_id, candidate.symbol, candidate.eventId)) return;
    const asset = await broker(ctx, `/v2/assets/${encodeURIComponent(candidate.symbol)}`);
    const account = await broker(ctx, '/v2/account');
    validateAccount(account, ctx.cred.account_id);
    const clock = await broker(ctx, '/v2/clock');
    if (!clock?.is_open || !Number.isFinite(Date.parse(clock.timestamp)) || Math.abs(now() - Date.parse(clock.timestamp)) > 120000) return;
    const positions = await broker(ctx, '/v2/positions');
    const orders = await broker(ctx, '/v2/orders?status=open&limit=500&nested=true');
    if (!Array.isArray(positions) || !Array.isArray(orders) || orders.length >= 500) throw new B2Error('Complete broker portfolio data is unavailable.');
    const held = new Set(positions.filter(p => number(p.qty) !== 0).map(p => p.symbol));
    const pending = new Set(orders.filter(o => o.side === 'buy' && !TERMINAL.has(o.status)).map(o => o.id || o.client_order_id));
    for (const trade of unresolved(ctx.uid).filter(t => t.account_id === ctx.cred.account_id && ['pending', 'partial', 'submission_unknown'].includes(t.status))) {
      pending.add(trade.order_id || trade.client_id);
    }
    // Count each pending parent conservatively, even where its partially-filled position already exists.
    // Position capacity is owned by the strategy rules (B2_RULES.maxPositions); never hardcode it here.
    const maxPositions = rules.B2_RULES?.maxPositions ?? 2;
    if (held.size + pending.size >= maxPositions || held.has(candidate.symbol) || orders.some(o => o.symbol === candidate.symbol) ||
        unresolved(ctx.uid).some(t => t.account_id === ctx.cred.account_id && t.symbol === candidate.symbol)) return;
    const [fresh] = await evaluate(ctx, [asset], marketState);
    if (!fresh?.eligible || fresh.signal !== 'BUY' || !fresh.eventId || fresh.eventId !== candidate.eventId) return;
    const snapshot = await broker(ctx, `/v2/stocks/${encodeURIComponent(candidate.symbol)}/snapshot?feed=${ctx.feed || 'sip'}`, { data: true });
    const quote = snapshot?.latestQuote;
    const ask = number(quote?.ap);
    const bid = number(quote?.bp);
    if (!(ask > 0 && bid > 0 && ask >= bid) || !Number.isFinite(Date.parse(quote?.t)) ||
        now() - Date.parse(quote.t) > 60000 || Date.parse(quote.t) - now() > 5000) return;
    // Recheck every gate against the last quote/snapshot, not only the ranked scan result.
    const finalBars = await loadBars(ctx, [candidate.symbol], marketState.expectedSessionDate);
    const finalHistory = finalBars[candidate.symbol];
    const finalLiquidity = evaluateAlpacaLiquidity(snapshot, {
      now: now(), marketState: marketState.clock?.is_open ? 'REGULAR' : 'CLOSED',
    });
    if (!finalLiquidity.eligible) return;
    const final = rules.evaluateB2({ bars: finalBars[candidate.symbol], snapshot, asset, now: now(),
      expectedSessionDate: marketState.expectedSessionDate, completedSessionDates: marketState.completedSessionDates });
    if (!final.eligible || final.signal !== 'BUY' || final.eventId !== candidate.eventId || finalBars[candidate.symbol].length < 100) return;
    const id = clientId(ctx.cred.account_id, candidate.symbol, candidate.eventId);
    const finalAsset = await broker(ctx, `/v2/assets/${encodeURIComponent(candidate.symbol)}`);
    const finalAccount = await broker(ctx, '/v2/account');
    validateAccount(finalAccount, ctx.cred.account_id);
    const finalPositions = await broker(ctx, '/v2/positions');
    const finalOrders = await broker(ctx, '/v2/orders?status=open&limit=500&nested=true');
    if (!Array.isArray(finalPositions) || !Array.isArray(finalOrders) || finalOrders.length >= 500) throw new B2Error('Final portfolio data is unavailable.');
    const finalHeld = new Set(finalPositions.filter(p => number(p.qty) !== 0).map(p => p.symbol));
    const finalPending = new Set(finalOrders.filter(o => o.side === 'buy' && !TERMINAL.has(o.status)).map(o => o.id || o.client_order_id));
    for (const trade of unresolved(ctx.uid).filter(t => t.account_id === ctx.cred.account_id && ['pending', 'partial', 'submission_unknown'].includes(t.status))) {
      finalPending.add(trade.order_id || trade.client_id);
    }
    if (finalHeld.size + finalPending.size >= maxPositions || finalHeld.has(candidate.symbol) || finalOrders.some(o => o.symbol === candidate.symbol)) return;
    const finalClock = await broker(ctx, '/v2/clock');
    if (!finalClock?.is_open || !Number.isFinite(Date.parse(finalClock.timestamp)) ||
        Math.abs(now() - Date.parse(finalClock.timestamp)) > 120000 || now() - Date.parse(quote.t) > 60000) return;
    const lastEvidence = rules.evaluateB2({ bars: finalBars[candidate.symbol], snapshot, asset: finalAsset,
      now: now(), expectedSessionDate: marketState.expectedSessionDate, completedSessionDates: marketState.completedSessionDates });
    if (!lastEvidence.eligible || lastEvidence.signal !== 'BUY' || lastEvidence.eventId !== candidate.eventId) return;
    const order = rules.buildB2Entry({ symbol: candidate.symbol, ask, maxPositionDollars: ctx.settings.max_position_dollars,
      buyingPower: number(finalAccount.buying_power), clientOrderId: id });
    if (!order || order.side !== 'buy' || order.type !== 'limit' || order.order_class !== 'oto' ||
        order.time_in_force !== 'gtc' || !(number(order.stop_loss?.stop_price) > 0) || order.client_order_id !== id) {
      throw new B2Error('A GTC protected entry order could not be constructed.');
    }
    authorize(ctx, true);
    const reservation = db.prepare(`INSERT OR IGNORE INTO b2_trades(user_id,account_id,mode,symbol,event_id,client_id,status,last_exit_session,signal_date,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'submission_unknown',?,?,?,?)`).run(ctx.uid, ctx.cred.account_id, ctx.cred.mode, candidate.symbol, candidate.eventId, id,
      candidate.signalDate || marketState.expectedSessionDate, candidate.signalDate || marketState.expectedSessionDate, timestamp(), timestamp());
    if (!reservation.changes) return;
    const trade = reload(reservation.lastInsertRowid);
    let response;
    try { response = await broker(ctx, '/v2/orders', { method: 'POST', body: order, entry: true }); }
    catch (error) {
      response = await orderByClient(ctx, id);
      if (response) {
        if (ownedOrder(response, trade, 'buy') && response.client_order_id === id) updateTrade(trade.id, { order_id: response.id });
        await reconcileTrade(ctx, reload(trade.id));
        return;
      }
      if ([400, 401, 403, 404, 422].includes(error.httpStatus) && !error.duplicateClient) {
        updateTrade(trade.id, { status: 'rejected', protection: 'settled' });
        alert(ctx.uid, ctx.cred.account_id, 'entry', 'Broker rejected the protected entry. The crossover reservation will not be retried.');
        return;
      }
    }
    if (ownedOrder(response, trade, 'buy') && response.client_order_id === id) updateTrade(trade.id, { order_id: response.id });
    await reconcileTrade(ctx, reload(trade.id));
  }
  async function runCycle(uid) {
    return locked(uid, async lease => {
      const settings = ensure(uid);
      const cred = credential(uid, settings.mode);
      if (!cred) {
        const reason = 'No verified dedicated B2 broker account is connected; scheduler cycle withheld.';
        db.prepare("UPDATE b2_settings SET last_cycle_at=?,scheduler_status='blocked',scheduler_reason=? WHERE user_id=?")
          .run(timestamp(), reason, uid);
        return { status: 'blocked', reason };
      }
      const ctx = context(uid, lease);
      db.prepare("UPDATE b2_settings SET last_cycle_at=?,scheduler_status='running',scheduler_reason=NULL WHERE user_id=?").run(timestamp(), uid);
      try {
        authorize(ctx);
        validateAccount(await broker(ctx, '/v2/account'), cred.account_id);
        // Reconcile fills/protection even if calendar/market data subsequently fails.
        await reconcile(ctx, null);
        const state = await market(ctx);
         // Establish one feed for the entire strategy evaluation. SIP is
         // always probed first; only a Paper SIP 403 may select cached IEX.
         let feedError = null;
         try { await resolveFeed(ctx); } catch (error) { feedError = error; }
        await expirePending(ctx, state);
        await settleClosingWindow(ctx, state);
        if (state.clock.is_open) await reconcile(ctx, state);
         if (feedError) throw feedError;
        if (!state.clock.is_open) {
          db.prepare("UPDATE b2_settings SET scheduler_status='market_closed',scheduler_reason='Market closed; reconciled only.' WHERE user_id=?").run(uid);
          return;
        }
        const sharedContext = await getAutomaticBotContext({ userId: uid, strategy: 'b2-v1' });
        const ranked = await scanContext(ctx, state, sharedContext);
        const active = getSettings(uid);
        if (active.enabled && (active.mode !== 'live' || active.live_armed) && running) {
          for (const candidate of ranked.filter(c => c.eligible && c.signal === 'BUY')) await enter(ctx, candidate, state);
        }
        const enabled = getSettings(uid).enabled;
        db.prepare("UPDATE b2_settings SET scheduler_status=?,scheduler_reason=? WHERE user_id=?")
          .run(enabled ? 'idle' : 'paused', enabled ? 'Cycle complete.' : 'Paused; owned trades still reconciled.', uid);
      } catch (error) {
        const message = error instanceof B2Error ? error.message : 'B2 cycle failed safely; entries withheld.';
        db.prepare("UPDATE b2_settings SET scheduler_status='error',scheduler_reason=? WHERE user_id=?").run(message, uid);
        alert(uid, cred.account_id, 'cycle', message);
      }
    });
  }
  function tick() {
    if (activeTick) return Promise.resolve();
    if (!running) return Promise.resolve();
    ticking = true;
    activeTick = (async () => {
      const users = db.prepare('SELECT user_id FROM b2_settings ORDER BY user_id').all();
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
    setAutomation, setCredentials, disconnect, setMode, candidates, scan, trades, alerts,
  };
}

function mountB2({ app, db, requireAuth, ensureSessionUserInTradingStore, vault, fetch, emailVerified, ...options }) {
  const service = createB2Service({ db, vault, fetch, ...options });
  // verifyEmail: true = always require verified email; function(req) = decide per request
  // (used so automation "pause" stays allowed while "resume" requires verification).
  const EMAIL_UNVERIFIED = 'Please verify your email address before connecting a broker account or enabling automation. Check your inbox for the verification link.';
  const route = (method, path, action, synchronize = false, verifyEmail = false) => {
    app[method](`/api/b2/${path}`, requireAuth, async (req, res) => {
      try {
        const uid = synchronize ? await ensureSessionUserInTradingStore(req) : Number(req.session?.userId);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new B2Error('Authenticated user identity is invalid.', 401);
        const needVerified = typeof verifyEmail === 'function' ? verifyEmail(req) : verifyEmail;
        if (needVerified && typeof emailVerified === 'function' && !emailVerified(uid)) {
          res.status(403).json({ error: EMAIL_UNVERIFIED, code: 'EMAIL_UNVERIFIED' });
          return;
        }
        res.json(await action(uid, req));
      } catch (error) {
        res.status(error instanceof B2Error ? error.status : 500).json({
          error: error instanceof B2Error ? error.message : 'B2 request failed safely. Please retry or review account readiness.',
        });
      }
    });
  };
  route('get', 'status', uid => service.status(uid));
  route('put', 'settings', (uid, req) => service.setSettings(uid, req.body), true);
  route('post', 'automation', (uid, req) => service.setAutomation(uid, req.body), true, req => req.body?.action === 'resume');
  route('get', 'candidates', uid => service.candidates(uid));
  route('post', 'scan', uid => service.scan(uid), true);
  route('get', 'trades', uid => service.trades(uid));
  route('get', 'alerts', uid => service.alerts(uid));
  route('put', 'credentials', (uid, req) => service.setCredentials(uid, req.body), true, true);
  route('delete', 'credentials', uid => service.disconnect(uid), true);
  route('post', 'mode', (uid, req) => service.setMode(uid, req.body), true);
  return service;
}

module.exports = { mountB2, createB2Service, B2Error };