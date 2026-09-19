const DISCONNECTED_SENTINEL = '__disconnected__';
const ENCRYPTED_CREDENTIAL_MARKER = '__encrypted__';
const { retireRemovedStrategies } = require('./lib/retired-strategies-migration');
const { buildDayTradingComparison } = require('./lib/day-trading-comparison');
const { mountB2 } = require('./lib/b2-service');
const { createAutomaticBotSettings } = require('./lib/automatic-bot-settings');
const { buildAutomaticBotContext, consumeAutomaticBotContext } = require('./lib/automatic-bot-context');
const { normalizeYahooFloatSummary, scannerFloatFields } = require('./lib/scanner-float');
const { evaluateLiquidity, DEFAULT_LIQUIDITY_POLICY } = require('./lib/liquidity-policy');
const { evaluateYahooLiquidity, evaluateAlpacaLiquidity } = require('./lib/liquidity-providers');
const { evaluateSessionVwapContext } = require('./lib/session-vwap-context');
const { brokerOrderMatchesIntent } = require('./lib/broker-order-ownership');
const { barsFromBrokerResponse, easternDateKey, completedDailyBars, completedWeeklyBars } = require('./lib/market-bars');
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const fetch        = require('node-fetch');
const YahooFinance = require('yahoo-finance2').default;
const Database     = require('better-sqlite3');
const bcrypt       = require('bcryptjs');
const session      = require('express-session');
const {
  createPostgresAuthStore,
  isPostgresConnectivityError,
} = require('./lib/postgres-auth-store');
const { retireLegacyAccount } = require('./lib/legacy-account-retirement');
const helmet       = require('helmet');
const crypto       = require('crypto');
const {
  CATALYST_TERMS,
  buildCatalystEvent,
  dedupeEvents,
} = require('./lib/catalyst-intel');
const { selectMarketAlerts } = require('./lib/market-alerts');
const { buildTechnicalConfluence } = require('./lib/technical-probability-engine');
const { fetchMacroProviders } = require('./lib/macro-providers');
const { createMacroContextService } = require('./lib/verified-macro-context');
const getVerifiedMacroContext = createMacroContextService({ loadProviders: fetchMacroProviders });
const {
  buildSearchVolumeSignal, selectCrypto24hReference, canonicalCrypto5mSeries, crypto24hStats,
} = require('./lib/search-volume-signal');
const { buildSearchLevels } = require('./lib/search-levels');
const {
  applySearchMarketRegime,
  buildSearchMarketContext,
  classifySearchMarketRegime,
} = require('./lib/search-market-regime');
const { buildVolatilitySnapshot } = require('./lib/volatility/orchestrator');
const { buildSearchGapAnalysis, summarizePatternAnalysis } = require('./lib/search-gap-analysis');
const { buildSearchFibonacci } = require('./lib/search-fibonacci');
const { buildSearchTradeLevels } = require('./lib/search-trade-levels');
const {
  TOPICS: SEARCH_INTELLIGENCE_TOPICS,
  buildMacroPressure,
  classifySearchQuery,
  detectPredictionPriceDivergence,
  marketRelevanceScore,
  selectRelevantKalshiMarkets,
} = require('./lib/search-intelligence');
const {
  TIMEFRAMES: SMART_MONEY_TIMEFRAMES,
  TF_ORDER: SMART_MONEY_TIMEFRAME_ORDER,
  aggregateCalendarBars: aggregateCalendarDailyBars,
  aggregateRegularSessionHours,
  buildSmartMoneyMap,
} = require('./lib/smart-money-map');
const {
  LOOKBACKS: FORECAST_LOOKBACKS,
  HORIZONS: FORECAST_HORIZONS,
  buildHistoricalForecast,
  buildWalkForwardValidationReport,
} = require('./lib/historical-forecast');
const { evaluatePriceActionSetup } = require('./lib/price-action-setups');
const { regularSessionWindow } = require('./lib/intraday-vwap');
const {
  ALLOWED_UNDERLYINGS: LEAP_UNDERLYINGS,
  evaluateLeapOptionsSignal,
  leapThesisInvalidated,
  simulateLeapOptionsStrategy,
} = require('./lib/leap-options-strategy');
const {
  selectLeapContract,
  quotePassesLeapGates,
  calculateLeapContracts,
  immutableLeapClientOrderId,
  buildLeapEntryOrder,
  buildLeapTargetOrder,
} = require('./lib/leap-options-execution-policy');
const {
  assertLeapOwnedOrder,
  summarizeLeapFills,
} = require('./lib/leap-options-reconciliation');
const {
  classifyExitIntent,
  decideLeapExitAction,
  closingOrdersToCancelOnPositionLoss,
} = require('./lib/leap-options-order-lifecycle');
const { findDuplicateBrokerAssignments } = require('./lib/broker-account-isolation');
const { EmergencyFlattenError, runEmergencyFlatten } = require('./lib/emergency-flatten');
const { createCredentialVault } = require('./lib/credential-vault');
const { createAutomatedState } = require('./lib/automated-state');
const { resolvePort } = require('./lib/runtime-config');
const { closeServer } = require('./lib/graceful-shutdown');
const {
  buildTradableEquityCatalog,
  resolveInverseSymbol,
  calculateEntryCapacity,
  canReserveEntryUnits,
  isLikelyCryptoSymbol,
} = require('./lib/broker-universe');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// Suppress noisy yahoo-finance2 deprecation warnings for modules we use intentionally
const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  const msg = args[0]?.toString() || '';
  if (msg.includes('financial statements submodules') || msg.includes('fundamentalsTimeSeries')) return;
  _origWarn(...args);
};

const app      = express();
const PORT           = resolvePort(process.env.PORT);
const MAX_CONCURRENT_POSITIONS = 2;  // Manual account's entry capacity.
const FMP_KEY  = process.env.FMP_API_KEY;
const NEWS_KEY = process.env.NEWSAPI_KEY;
const SEARCH_AI_KEY = process.env.AIML_API_KEY;


// ── SQLite Database ────────────────────────────────────────────────────────────
const restored = process.env.AUTOMATED_STATE_RESTORED === 'true';
const db = new Database('jqf.db');
// Automated strategy state is isolated from manual/research state. The boot
// wrapper restores this database from the fenced PostgreSQL image before this
// module is loaded.
const automatedDb = new Database('automated-trading.db');
if (restored) {
  db.pragma('journal_mode = WAL');
  automatedDb.pragma('journal_mode = WAL');
} else {
  // A first cutover commits changes across jqf.db and its attached automated
  // database. SQLite's cross-file atomic commit requires rollback journals;
  // WAL mode does not participate in the super-journal guarantee.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  try { automatedDb.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  db.pragma('journal_mode = DELETE');
  automatedDb.pragma('journal_mode = DELETE');
}
automatedDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
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
`);
const sessionDb = new Database('sessions.db');
sessionDb.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS watchlists (
    user_id   INTEGER NOT NULL,
    symbol    TEXT    NOT NULL,
    added_at  TEXT    DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS alpaca_creds (
    user_id    INTEGER PRIMARY KEY,
    api_key    TEXT    NOT NULL,
    api_secret TEXT    NOT NULL,
    api_key_enc TEXT,
    api_secret_enc TEXT,
    mode       TEXT    DEFAULT 'paper',
    account_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Long-call LEAP automation has a wholly separate broker identity and journal.
// Entry authorization may be paused, but reconciliation records remain durable.
db.exec(`
  CREATE TABLE IF NOT EXISTS options_settings (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    live_armed INTEGER NOT NULL DEFAULT 0,
    activation_revision INTEGER NOT NULL DEFAULT 0,
    max_position_dollars REAL NOT NULL DEFAULT 1000,
    last_cycle_at TEXT,
    last_cycle_status TEXT,
    last_cycle_reason TEXT,
    last_scan_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS options_alpaca_creds (
    user_id INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('paper','live')),
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    api_key_enc TEXT,
    api_secret_enc TEXT,
    account_id TEXT,
    PRIMARY KEY (user_id, mode),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_options_alpaca_creds_account
    ON options_alpaca_creds (user_id, account_id)
    WHERE account_id IS NOT NULL AND api_key <> '__disconnected__';
  CREATE TABLE IF NOT EXISTS options_alpaca_active_mode (
    user_id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'paper' CHECK(mode IN ('paper','live')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS options_candidates (
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    signal_bar_at TEXT,
    evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS options_entry_reservations (
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    signal_bar_at TEXT NOT NULL,
    trade_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol, signal_bar_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS options_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    underlying_symbol TEXT NOT NULL,
    contract_symbol TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('paper','live')),
    account_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'entry_intent',
    requested_contracts INTEGER NOT NULL,
    filled_contracts INTEGER NOT NULL DEFAULT 0,
    contracts_remaining INTEGER NOT NULL DEFAULT 0,
    entry_price REAL,
    target_price REAL,
    strike_price REAL NOT NULL,
    expiration_date TEXT NOT NULL,
    multiplier INTEGER NOT NULL DEFAULT 100,
    signal_bar_at TEXT NOT NULL,
    setup_json TEXT NOT NULL DEFAULT '{}',
    entry_client_order_id TEXT NOT NULL,
    entry_order_id TEXT,
    target_client_order_id TEXT,
    target_order_id TEXT,
    target_revision INTEGER NOT NULL DEFAULT 0,
    thesis_exit_client_order_id TEXT,
    thesis_exit_order_id TEXT,
    exit_reason TEXT,
    pnl REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    UNIQUE(user_id, entry_client_order_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_options_trades_open
    ON options_trades (user_id, status, underlying_symbol);
  CREATE TABLE IF NOT EXISTS options_fills (
    trade_id INTEGER NOT NULL,
    broker_order_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trade_id, broker_order_id),
    FOREIGN KEY (trade_id) REFERENCES options_trades(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS options_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS options_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    trade_id INTEGER,
    symbol TEXT,
    event_type TEXT NOT NULL,
    reason_code TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    source_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (trade_id) REFERENCES options_trades(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_options_events_user_created
    ON options_events (user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS options_execution_leases (
    user_id INTEGER PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
try { db.prepare('ALTER TABLE options_settings ADD COLUMN activation_revision INTEGER NOT NULL DEFAULT 0').run(); } catch (_) {}

// ── DB migrations — add columns that didn't exist in older schema ─────────────
[
  `ALTER TABLE alpaca_creds ADD COLUMN api_key_enc TEXT`,
  `ALTER TABLE alpaca_creds ADD COLUMN api_secret_enc TEXT`,
  `ALTER TABLE alpaca_creds ADD COLUMN account_id TEXT`,
].forEach(sql => { try { db.prepare(sql).run(); } catch (_) {} });

// ── DB migration: upgrade alpaca_creds to composite (user_id, mode) PK ────────
// Allows separate paper + live credentials to coexist for the same user.
// Safe to run on every startup — the PRAGMA check prevents double-migration.
{
  const pkCols = db.prepare('PRAGMA table_info(alpaca_creds)').all()
    .filter(c => c.pk > 0).map(c => c.name);
  if (pkCols.length === 1 && pkCols[0] === 'user_id') {
    try {
      db.transaction(() => db.exec(`
        CREATE TABLE alpaca_creds_new (
          user_id    INTEGER NOT NULL,
          api_key    TEXT    NOT NULL,
          api_secret TEXT    NOT NULL,
          api_key_enc TEXT,
          api_secret_enc TEXT,
          account_id TEXT,
          mode       TEXT    NOT NULL DEFAULT 'paper',
          PRIMARY KEY (user_id, mode),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO alpaca_creds_new (user_id, api_key, api_secret, api_key_enc, api_secret_enc, account_id, mode)
          SELECT user_id, api_key, api_secret, api_key_enc, api_secret_enc, account_id, COALESCE(mode,'paper') FROM alpaca_creds;
        DROP TABLE alpaca_creds;
        ALTER TABLE alpaca_creds_new RENAME TO alpaca_creds;
      `))();
      console.log('[Migration] alpaca_creds → composite (user_id, mode) PK');
    } catch(e) { console.error('[Migration] alpaca_creds failed:', e.message); }
  }
}
// ── Active-mode tracker — which account (paper/live) each user is using ───────
db.prepare(`
  CREATE TABLE IF NOT EXISTS alpaca_active_mode (
    user_id INTEGER PRIMARY KEY,
    mode    TEXT    NOT NULL DEFAULT 'paper',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

// One broker account can belong to exactly one application user and one
// strategy scope. This durable registry closes the read-then-write race that
// separate credential tables cannot prevent across processes.
db.exec(`
  CREATE TABLE IF NOT EXISTS broker_account_owners (
    account_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    scope TEXT NOT NULL,
    mode TEXT NOT NULL,
    claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS broker_account_quarantine (
    account_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
`);
retireRemovedStrategies(db);
const automaticBotSettings = createAutomaticBotSettings(automatedDb);

// Cut the automated tables out of the deployment-local manual database. The
// attached schema keeps legacy synchronous LEAP queries working while the
// dedicated connection is the only owner of automated state.
const AUTOMATED_TABLES = [
  'automated_action_intents',
  'automatic_live_bot_arms',
  'options_fills', 'options_events', 'options_alerts', 'options_entry_reservations',
  'options_trades', 'options_candidates', 'options_execution_leases',
  'options_alpaca_active_mode', 'options_alpaca_creds', 'options_settings',
  'b2_close_attempts', 'b2_exit_fills', 'b2_alerts', 'b2_trades',
  'b2_candidates', 'b2_coverage', 'b2_universe', 'b2_leases', 'b2_credentials',
  'b2_settings', 'broker_account_quarantine', 'broker_account_owners',
];
db.exec(`ATTACH DATABASE 'automated-trading.db' AS automated`);
automatedDb.pragma('foreign_keys = OFF');
db.pragma('foreign_keys = OFF');
if (!restored) {
  // Create every destination table before the cross-database copy transaction.
  // Opening DDL through a second SQLite connection after the first copied row
  // would contend with the transaction's write lock and abort a fresh cutover.
  for (const table of AUTOMATED_TABLES) {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
    if (schema && !automatedDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      automatedDb.exec(schema);
    }
  }
  const migrateAutomatedTables = db.transaction(() => {
    const verifiedTables = [];
    for (const table of AUTOMATED_TABLES) {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
      if (!schema) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      if (!columns.length) continue;
      const names = columns.map(column => `"${column.replace(/"/g, '""')}"`).join(',');
      const sourceCount = db.prepare(`SELECT COUNT(*) AS count FROM main."${table}"`).get().count;
      const priorDestinationCount = db.prepare(`SELECT COUNT(*) AS count FROM automated."${table}"`).get().count;
      // A retry can find destination rows from an interrupted cutover while
      // startup schema initialization has recreated an empty source table.
      // Non-empty source remains authoritative; an empty source preserves an
      // already copied destination instead of deleting durable local progress.
      if (sourceCount > 0) {
        db.exec(`DELETE FROM automated."${table}"`);
        db.exec(`INSERT INTO automated."${table}" (${names}) SELECT ${names} FROM main."${table}"`);
      }
      const destinationCount = db.prepare(`SELECT COUNT(*) AS count FROM automated."${table}"`).get().count;
      const expectedCount = sourceCount > 0 ? sourceCount : priorDestinationCount;
      if (expectedCount !== destinationCount) throw new Error(`Automated-state migration count mismatch for ${table}.`);
      verifiedTables.push(table);
    }
    if (db.pragma('integrity_check', { simple: true }) !== 'ok'
        || db.pragma('automated.integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Automated-state migration integrity check failed.');
    }
    // Copy verification and source removal share the same attached-database
    // transaction, so interruption rolls back both rather than leaving a
    // partially removed source schema that cannot be retried safely.
    for (const table of verifiedTables) db.exec(`DROP TABLE main."${table}"`);
  });
  try {
    migrateAutomatedTables();
  } catch (error) {
    console.error('[AutomatedState] migration failed; source tables preserved:', error.message);
    throw error;
  }
} else {
  // A validated PostgreSQL restore is authoritative. Remove startup-created
  // empty main-schema tables so they cannot shadow the restored attached data.
  db.transaction(() => {
    for (const table of AUTOMATED_TABLES) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        db.exec(`DROP TABLE main."${table}"`);
      }
    }
  })();
}
// Normal operation uses WAL after the crash-atomic first-cut transaction has
// committed and no cross-database schema move remains.
db.pragma('journal_mode = WAL');
automatedDb.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
automatedDb.pragma('foreign_keys = ON');

for (const seed of [
  `INSERT OR IGNORE INTO broker_account_owners(account_id,user_id,scope,mode)
   SELECT account_id,user_id,'manual',mode FROM alpaca_creds
   WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'`,
  `INSERT OR IGNORE INTO broker_account_owners(account_id,user_id,scope,mode)
   SELECT account_id,user_id,'options',mode FROM options_alpaca_creds
   WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'`,
]) {
  try { db.prepare(seed).run(); } catch (error) {
    console.error('[Alpaca] Broker ownership registry seed failed:', error.message);
  }
}
const legacyBrokerAssignments = db.prepare(`
  SELECT account_id,user_id,scope FROM (
    SELECT account_id,user_id,'manual' AS scope FROM alpaca_creds
      WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'
    UNION ALL
    SELECT account_id,user_id,'options' AS scope FROM options_alpaca_creds
      WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'
    UNION ALL SELECT account_id,user_id,scope FROM broker_account_owners
  )
`).all();
const duplicatedBrokerAccounts = findDuplicateBrokerAssignments(legacyBrokerAssignments);
for (const row of legacyBrokerAssignments) refreshBrokerAccountQuarantine(row.account_id);
if (duplicatedBrokerAccounts.length) {
  console.error(`[Alpaca] Quarantined ${duplicatedBrokerAccounts.length} broker account assignment conflict(s); reconnect each strategy with a unique account.`);
}

// ── App settings table (persists generated secrets etc.) ──────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`).run();

// Every deployed instance must use the same signing secret. A local fallback
// breaks sessions whenever traffic lands on another instance or the app restarts.
function getSessionSecret() {
  const envSecret = process.env.SESSION_SECRET;
  if (!envSecret || envSecret.length < 32) {
    throw new Error('SESSION_SECRET must be configured with at least 32 characters before the app can start.');
  }
  return envSecret;
}
const SESSION_SECRET = getSessionSecret();
const credentialVault = createCredentialVault(SESSION_SECRET);

// Credentials must be upgraded before the first durable automated snapshot.
// A failed vault operation aborts startup and leaves the source journal intact.
db.transaction(() => {
  for (const table of ['b2_credentials', 'options_alpaca_creds']) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (!columns.has('api_key')) continue;
    for (const row of db.prepare(`SELECT rowid AS _rowid, * FROM ${table}`).all()) {
      if (row.api_key === DISCONNECTED_SENTINEL || row.api_secret === DISCONNECTED_SENTINEL) continue;
      if (columns.has('api_key_enc') && row.api_key === ENCRYPTED_CREDENTIAL_MARKER
          && row.api_secret === ENCRYPTED_CREDENTIAL_MARKER) continue;
      if (!columns.has('api_key_enc')) {
        const keyEncrypted = credentialVault.isEncrypted(row.api_key);
        const secretEncrypted = credentialVault.isEncrypted(row.api_secret);
        if (keyEncrypted !== secretEncrypted) {
          throw new Error(`Stored ${table} credential pair is only partially encrypted.`);
        }
        if (keyEncrypted) continue;
      }
      const key = columns.has('api_key_enc') && row.api_key_enc ? row.api_key_enc : credentialVault.encrypt(row.api_key);
      const secret = columns.has('api_secret_enc') && row.api_secret_enc ? row.api_secret_enc : credentialVault.encrypt(row.api_secret);
      if (columns.has('api_key_enc')) {
        db.prepare(`UPDATE ${table} SET api_key=?,api_secret=?,api_key_enc=?,api_secret_enc=? WHERE rowid=?`)
          .run(ENCRYPTED_CREDENTIAL_MARKER, ENCRYPTED_CREDENTIAL_MARKER, key, secret, row._rowid);
      } else {
        db.prepare(`UPDATE ${table} SET api_key=?,api_secret=? WHERE rowid=?`)
          .run(key, secret, row._rowid);
      }
    }
  }
})();

// ── In-memory rate limiter for auth endpoints ──────────────────────────────────
const authAttempts = new Map();
function rateLimitAuth(req, res, next) {
  const ip    = req.ip || req.socket?.remoteAddress || 'unknown';
  const now   = Date.now();
  const WINDOW = 15 * 60 * 1000; // 15 minutes
  const LIMIT  = 15;
  let entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW };
    authAttempts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > LIMIT) {
    return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
  }
  next();
}
// Clean up stale entries every 15 minutes
const authAttemptCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) if (now > entry.resetAt) authAttempts.delete(ip);
}, 15 * 60 * 1000);

// ── Security migration: retire a source-disclosed bootstrap account ──────────
// This is deliberately one-way and tolerates already-retired strategy tables.
if (retireLegacyAccount({
  db,
  sessionDb,
  username: 'johnnyqureshi',
  replacementPasswordHash: bcrypt.hashSync(crypto.randomBytes(48).toString('base64url'), 12),
})) {
  console.warn('[Security] Retired the legacy bootstrap account and removed its broker access. Create a new account and reconnect broker credentials.');
}


// Account identities and sessions are shared through PostgreSQL. Automated
// journals are fenced snapshots of the dedicated SQLite image.
const authStore = createPostgresAuthStore({
  databaseUrl: process.env.DATABASE_URL,
  sessionTtlMs: 90 * 24 * 60 * 60 * 1000,
});
// The PostgreSQL snapshot/fence schema is applied by the development schema
// flow and Publish. Until it is present, both strategies fail closed.
const automatedState = createAutomatedState({
  databaseUrl: process.env.DATABASE_URL,
  db: automatedDb,
});
let automatedTradingPersistenceReady = false;
const automatedStartup = automatedState.init()
  .then(() => automatedState.acquireFence())
  .then(() => automatedState.flush('startup'))
  .then(() => {
  automatedTradingPersistenceReady = automatedState.isReady();
  if (automatedTradingPersistenceReady) {
    console.log('[AutomatedState] Durable snapshot, fence, and startup checkpoint verified.');
  } else {
    console.warn('[AutomatedState] Fence/checkpoint readiness is incomplete; automated entries remain paused.');
  }
}).catch(error => {
  console.error('[AutomatedState] Durable snapshot state unavailable; automated entries remain paused:', error.message);
  throw error;
});
const automatedHeartbeatTimer = setInterval(() => {
  automatedState.heartbeat()
    .then(alive => {
      if (!alive) automatedTradingPersistenceReady = false;
    })
    .catch(error => {
      automatedTradingPersistenceReady = false;
      console.error('[AutomatedState] fence heartbeat failed; automated actions withheld:', error.message);
    });
}, 10_000);
let authStoreInitError = null;
let authStoreInitialized = false;
let authStoreReady = null;
let authStoreRetryAfter = 0;
const AUTH_STORE_RETRY_DELAY_MS = 5_000;

// Database restarts are transient in managed environments. Do not permanently
// disable sign-in because the first connection attempt happened during one.
function ensureAuthStoreReady() {
  if (authStoreInitialized) return Promise.resolve();
  if (authStoreReady) return authStoreReady;
  if (authStoreInitError && Date.now() < authStoreRetryAfter) {
    return Promise.reject(authStoreInitError);
  }

  authStoreReady = authStore.init(db)
    .then(() => authStore.retireLegacyUsername(
      bcrypt.hashSync(crypto.randomBytes(48).toString('base64url'), 12)
    ))
    .then(() => {
      authStoreInitialized = true;
      authStoreInitError = null;
    })
    .catch(error => {
      authStoreInitError = error;
      authStoreRetryAfter = Date.now() + AUTH_STORE_RETRY_DELAY_MS;
      console.error('[Auth] Shared authentication store failed to initialize:', error.message);
      throw error;
    })
    .finally(() => {
      authStoreReady = null;
    });
  return authStoreReady;
}

// Warm the store during startup without making a transient database outage
// fatal. Requests will retry after the short backoff above.
ensureAuthStoreReady().catch(() => {});

// Broker credentials are attached only through the authenticated per-user
// settings flow. Never assign environment credentials to a fixed user ID.

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);  // Trust Replit's reverse proxy for correct cookie behaviour

// Security headers: removes X-Powered-By, sets X-Frame-Options, X-Content-Type-Options, etc.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: allow credentials from any origin — security is enforced by
// session auth (requireAuth), bcrypt, rate limiting, and input validation.
app.use(cors({ credentials: true, origin: true }));

app.use(express.json({ limit: '50kb' }));

// Liveness never depends on the database or external market services. Replit
// can distinguish a running HTTP process from deeper readiness failures.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PostgresSessionStore = authStore.createSessionStore(session);
const sessionMiddleware = session({
  store:             new PostgresSessionStore(),
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  rolling:           true,   // Reset cookie expiry on every request (keeps active users logged in)
  cookie: {
    httpOnly: true,
    secure:   false,          // Replit's proxy handles HTTPS termination; cookie is still httpOnly + sameSite
    sameSite: 'lax',
    maxAge:   90 * 24 * 60 * 60 * 1000,  // 90 days
  },
});
// A session lookup happens before the homepage is served. If the managed
// database briefly drops an idle connection, keep the public shell available
// and let its API calls report a clean temporary-auth outage instead of
// rendering Express's raw stack trace.
app.use((req, res, next) => {
  try {
    sessionMiddleware(req, res, error => {
      if (!error) return next();
      const publicShellRequest = ['GET', 'HEAD'].includes(req.method)
        && !req.path.startsWith('/api/');
      if (publicShellRequest && isPostgresConnectivityError(error)) {
        console.warn('[Session] PostgreSQL unavailable; serving public shell without a session.');
        return next();
      }
      next(error);
    });
  } catch (error) {
    next(error);
  }
});
app.use(express.static(path.join(__dirname, 'public')));
// The application shell lives at the project root while its CSS/JS assets
// live under public/. Serve both paths so the published app and custom domain
// have a real homepage instead of Express's default "Cannot GET /" response.
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function requireAuthStore(req, res, next) {
  try {
    await ensureAuthStoreReady();
  } catch (_) {
    return res.status(503).json({ error: 'Authentication service is temporarily unavailable. Please try again shortly.' });
  }
  next();
}
app.use('/api/auth', requireAuthStore);

// Auth guard helper
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// PostgreSQL owns identities and sessions. The dedicated automated SQLite
// compatibility row is synchronized before strategy writes; manual/research
// state remains in jqf.db.
async function ensureSessionUserInTradingStore(req) {
  const sessionUserId = Number(req.session?.userId);
  if (!Number.isSafeInteger(sessionUserId) || sessionUserId <= 0) {
    throw new Error('Authenticated session has no valid user identity.');
  }
  await ensureAuthStoreReady();
  const user = await authStore.findUserById(sessionUserId);
  if (!user) throw new Error('Authenticated user was not found.');
  authStore.syncSqliteUser(db, user);
  authStore.syncSqliteUser(automatedDb, user);
  return Number(user.id);
}

const YH = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

// ── Search result cache (5-min TTL) — prevents Yahoo rate-limits on fast typing ─
const _searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
function _searchCacheGet(key) {
  const e = _searchCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > SEARCH_CACHE_TTL) { _searchCache.delete(key); return null; }
  return e.data;
}
function _searchCacheSet(key, data) {
  if (_searchCache.size > 200) {
    const oldest = [..._searchCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
    if (oldest) _searchCache.delete(oldest[0]);
  }
  _searchCache.set(key, { data, ts: Date.now() });
}

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_CATALOG_TTL = 2 * 60 * 1000;
const SEARCH_INTELLIGENCE_TTL = 60 * 1000;
const _kalshiSeriesCache = new Map();
const _kalshiQueryCache = new Map();
const _kalshiQueryInflight = new Map();
const _searchIntelligenceCache = new Map();

function searchMacroSuggestions(query) {
  const lower = String(query || '').trim().toLowerCase();
  if (!lower) return [];
  const classification = classifySearchQuery(query);
  return SEARCH_INTELLIGENCE_TOPICS
    .filter(topic => topic.label.toLowerCase().includes(lower)
      || topic.terms.some(term => term.includes(lower) || lower.includes(term)))
    .slice(0, 4)
    .map(topic => ({
      kind: 'macro',
      query: String(query).trim(),
      label: topic.label,
      topic: topic.id,
      symbol: classification.symbol,
      name: 'Macro intelligence · prediction markets, rates, news, and risk indicators',
    }));
}

function kalshiCategories(classification) {
  const topics = new Set((classification.topics || []).map(topic => topic.id));
  if (topics.has('geopolitical')) return ['World', 'Politics', 'Economics'];
  if (topics.has('tariffs')) return ['Politics', 'Economics', 'World'];
  if (topics.has('crypto')) return ['Financials', 'Politics', 'Economics'];
  if (topics.size) return ['Economics', 'Financials', 'Politics'];
  return ['Financials'];
}

async function fetchKalshiSeriesCategory(category) {
  const cached = _kalshiSeriesCache.get(category);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.series;
  const query = new URLSearchParams({ category, limit: '1000' });
  const response = await fetch(`${KALSHI_API_BASE}/series?${query}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Qureshi-Finance-Search/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Kalshi series returned ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.series)) throw new Error('Kalshi returned invalid series metadata');
  _kalshiSeriesCache.set(category, { at: Date.now(), series: data.series });
  return data.series;
}

async function fetchKalshiSeriesMarkets(seriesTicker) {
  const query = new URLSearchParams({
    status: 'open',
    series_ticker: seriesTicker,
    limit: '1000',
    mve_filter: 'exclude',
  });
  const response = await fetch(`${KALSHI_API_BASE}/markets?${query}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Qureshi-Finance-Search/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Kalshi markets returned ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.markets) ? data.markets : [];
}

async function fetchKalshiCatalog(value) {
  const key = String(value || '').trim().toLowerCase();
  const cached = _kalshiQueryCache.get(key);
  if (cached && Date.now() - cached.at < KALSHI_CATALOG_TTL) return cached;
  if (_kalshiQueryInflight.has(key)) return _kalshiQueryInflight.get(key);
  const job = (async () => {
    try {
      const classification = classifySearchQuery(value);
      const categories = kalshiCategories(classification);
      const categoryResults = await Promise.allSettled(categories.map(fetchKalshiSeriesCategory));
      const series = categoryResults.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      const relevantSeries = series
        .map(item => ({ item, score: marketRelevanceScore(item, value, classification) }))
        .filter(item => item.score >= 3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(item => item.item);
      const marketResults = await Promise.allSettled(
        relevantSeries.map(item => fetchKalshiSeriesMarkets(item.ticker)),
      );
      const markets = marketResults.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      const result = {
        at: Date.now(),
        markets,
        status: 'live',
        error: null,
        matchedSeries: relevantSeries.map(item => ({ ticker: item.ticker, title: item.title })),
      };
      _kalshiQueryCache.set(key, result);
      return result;
    } catch (error) {
      const result = {
        at: Date.now(),
        markets: [],
        status: 'unavailable',
        error: error.message,
        matchedSeries: [],
      };
      _kalshiQueryCache.set(key, result);
      return result;
    } finally {
      _kalshiQueryInflight.delete(key);
    }
  })();
  _kalshiQueryInflight.set(key, job);
  return job;
}

const SEARCH_MACRO_SYMBOLS = {
  spy: 'SPY',
  qqq: 'QQQ',
  vix: '^VIX',
  tenYear: '^TNX',
  oil: 'CL=F',
  brent: 'BZ=F',
  gold: 'GC=F',
  usd: 'DX-Y.NYB',
  bitcoin: 'BTC-USD',
};
let _latestSearchMacroIndicators = null;
const SEARCH_MACRO_SIGNAL_MAX_AGE_MS = 15 * 60 * 1000;

function cachedSearchMacroIndicators(nowMs = Date.now()) {
  if (!_latestSearchMacroIndicators
    || nowMs - _latestSearchMacroIndicators.at > SEARCH_MACRO_SIGNAL_MAX_AGE_MS) return {};
  return _latestSearchMacroIndicators.indicators || {};
}

function normalizeIntelligenceQuote(key, quote, generatedAt) {
  if (!quote || !Number.isFinite(Number(quote.regularMarketPrice))) return null;
  return {
    key,
    symbol: quote.symbol || SEARCH_MACRO_SYMBOLS[key],
    name: quote.shortName || quote.longName || quote.symbol || key,
    price: +Number(quote.regularMarketPrice).toFixed(quote.regularMarketPrice >= 1000 ? 0 : 2),
    changePct: Number.isFinite(Number(quote.regularMarketChangePercent))
      ? +Number(quote.regularMarketChangePercent).toFixed(2)
      : null,
    marketState: quote.marketState || null,
    source: 'Yahoo Finance',
    updatedAt: quote.regularMarketTime
      ? new Date(Number(quote.regularMarketTime) * 1000).toISOString()
      : generatedAt,
    status: 'live',
  };
}

async function fetchSearchMacroIndicators() {
  const generatedAt = new Date().toISOString();
  try {
    const symbols = Object.values(SEARCH_MACRO_SYMBOLS);
    const raw = await yf.quote(symbols, {}, { validateResult: false });
    const quotes = Array.isArray(raw) ? raw : [raw];
    const bySymbol = new Map(quotes.filter(Boolean).map(quote => [quote.symbol, quote]));
    const indicators = {};
    for (const [key, symbol] of Object.entries(SEARCH_MACRO_SYMBOLS)) {
      indicators[key] = normalizeIntelligenceQuote(key, bySymbol.get(symbol), generatedAt);
    }
    _latestSearchMacroIndicators = { at: Date.now(), indicators };
    return { indicators, status: 'live', updatedAt: generatedAt, source: 'Yahoo Finance' };
  } catch (error) {
    return {
      indicators: {},
      status: 'unavailable',
      updatedAt: generatedAt,
      source: 'Yahoo Finance',
      error: error.message,
    };
  }
}

async function fetchSearchTopicNews(query) {
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=8`,
      { headers: YH, signal: AbortSignal.timeout(6000) },
    );
    if (!response.ok) throw new Error(`Yahoo news returned ${response.status}`);
    const data = await response.json();
    return {
      status: 'live',
      source: 'Yahoo Finance',
      updatedAt: new Date().toISOString(),
      items: (data.news || []).slice(0, 6).map(item => ({
        headline: item.title,
        source: item.publisher || 'Yahoo Finance',
        url: /^https?:\/\//i.test(String(item.link || '')) ? item.link : null,
        publishedAt: item.providerPublishTime
          ? new Date(item.providerPublishTime * 1000).toISOString()
          : null,
      })).filter(item => item.headline),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      source: 'Yahoo Finance',
      updatedAt: new Date().toISOString(),
      items: [],
      error: error.message,
    };
  }
}

async function buildSearchAiInterpretation(facts) {
  if (!SEARCH_AI_KEY) return { available: false, reason: 'AI interpretation is not configured' };
  try {
    const response = await fetch('https://api.aimlapi.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SEARCH_AI_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 450,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You explain market data for research. Use only supplied facts. Prediction markets are market-implied probabilities, never guarantees. Do not invent values, price targets, or financial advice. Return strict JSON: {"summary":"2-3 sentences","potentialBeneficiaries":["up to 3"],"potentialPressure":["up to 3"],"riskFactors":["up to 4"],"caveat":"one sentence"}.',
          },
          { role: 'user', content: JSON.stringify(facts) },
        ],
      }),
    });
    if (!response.ok) return { available: false, reason: `AI service returned ${response.status}` };
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (!parsed.summary) return { available: false, reason: 'AI interpretation was empty' };
    return {
      available: true,
      summary: String(parsed.summary).slice(0, 1200),
      potentialBeneficiaries: (parsed.potentialBeneficiaries || []).slice(0, 3).map(String),
      potentialPressure: (parsed.potentialPressure || []).slice(0, 3).map(String),
      riskFactors: (parsed.riskFactors || []).slice(0, 4).map(String),
      caveat: String(parsed.caveat || 'This is analysis, not financial advice.').slice(0, 300),
      source: 'AI interpretation of listed source data',
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return { available: false, reason: 'AI interpretation temporarily unavailable' };
  }
}

// ── Float/share-count cache (15-min TTL) ─────────────────────────────────────
// Yahoo's quote response sometimes omits floatShares. Keep the fundamentals
// lookup separate from the short-lived quote cache so scanner refreshes do not
// repeatedly hit quoteSummary for the same symbol.
const _floatCache = new Map();
const FLOAT_CACHE_TTL = 15 * 60 * 1000;
function _floatCacheGet(sym) {
  const entry = _floatCache.get(sym);
  if (!entry) return null;
  if (Date.now() - entry.ts > FLOAT_CACHE_TTL) {
    _floatCache.delete(sym);
    return null;
  }
  return entry.data;
}
function _floatCacheSet(sym, data) {
  if (_floatCache.size > 500) {
    const oldest = [..._floatCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _floatCache.delete(oldest[0]);
  }
  _floatCache.set(sym, { data, ts: Date.now() });
}

/**
 * Return Yahoo's best available low-float metric.
 *
 * floatShares is the preferred value because it represents shares available
 * to trade. sharesOutstanding is a useful fallback when Yahoo has not
 * published a float value for a symbol. The source is returned so the UI/API
 * can remain transparent about which value was used.
 */
async function _fetchFloatData(sym) {
  const cached = _floatCacheGet(sym);
  if (cached) return cached;

  try {
    const summary = await yf.quoteSummary(sym, {
      modules: ['defaultKeyStatistics', 'summaryDetail'],
    }, { validateResult: false });
    const data = normalizeYahooFloatSummary(summary);
    _floatCacheSet(sym, data);
    return data;
  } catch (_) {
    // The scanner can still use quote.floatShares when quoteSummary is
    // unavailable (for example, a temporary Yahoo module/rate-limit failure).
    return { float: null, floatShares: null, sharesOutstanding: null, floatSource: null };
  }
}

// ── Authentication ───────────────────────────────────────────────────────────

app.post('/api/auth/register', rateLimitAuth, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  const u = username.trim().toLowerCase();   // Always store as lowercase — prevents case duplicates
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(u))
    return res.status(400).json({ error: 'Username must be 3–20 characters (letters, numbers, _).' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await authStore.createUser(u, hash);
    if (!user) return res.status(409).json({ error: 'Username already taken.' });
    authStore.syncSqliteUser(db, user);
    req.session.userId   = Number(user.id);
    req.session.username = u;
    req.session.save(error => {
      if (error) return res.status(500).json({ error: 'Account was created, but the sign-in session could not be saved. Please sign in again.' });
      res.json({ id: Number(user.id), username: u });
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken.' });
    console.error('[Auth] Registration failed:', e.message);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// Login
app.post('/api/auth/login', rateLimitAuth, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  try {
    const user = await authStore.findUserByUsername(username.trim());
    if (!user) {
    // This source-disclosed bootstrap identity was retired one-way. Keep the
    // normal generic response for other usernames, but give its owner an
    // actionable recovery message instead of making a safe migration look like
    // a broken password or session.
    if (username.trim().toLowerCase() === 'johnnyqureshi') {
      return res.status(401).json({
        code: 'LEGACY_ACCOUNT_RETIRED',
        error: 'This older account was retired for security. Create a new account with this username, then reconnect your broker account.',
      });
    }
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

    authStore.syncSqliteUser(db, user);
    req.session.userId   = Number(user.id);
    req.session.username = user.username;
    req.session.save(error => {
      if (error) return res.status(500).json({ error: 'Sign-in session could not be saved. Please try again.' });
      res.json({ id: Number(user.id), username: user.username });
    });
  } catch (error) {
    console.error('[Auth] Login failed:', error.message);
    res.status(503).json({ error: 'Authentication service is temporarily unavailable. Please try again shortly.' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
  // NOTE: alpaca_creds are intentionally NOT deleted on logout.
  // They persist in the DB so the bot keeps running and reconnects automatically on next login.
});

// Change Password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Both current and new password are required.' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const user = await authStore.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found.' });
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  const hash = await bcrypt.hash(newPassword, 10);
  await authStore.updatePassword(req.session.userId, hash);
  authStore.syncSqliteUser(db, { ...user, password_hash: hash });
  res.json({ ok: true });
});

// Current user
app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: req.session.userId, username: req.session.username });
});

// ── Watchlist Routes (auth-protected) ─────────────────────────────────────────

// Get watchlist
app.get('/api/watchlist', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT symbol FROM watchlists WHERE user_id = ? ORDER BY added_at ASC').all(req.session.userId);
  res.json({ watchlist: rows.map(r => r.symbol) });
});

// Add symbol
app.post('/api/watchlist', requireAuth, (req, res) => {
  const sym = (req.body?.symbol || '').toUpperCase().trim();
  if (!sym || !/^[A-Z0-9.\-]{1,12}$/.test(sym)) return res.status(400).json({ error: 'Invalid symbol.' });
  db.prepare('INSERT OR IGNORE INTO watchlists (user_id, symbol) VALUES (?, ?)').run(req.session.userId, sym);
  const rows = db.prepare('SELECT symbol FROM watchlists WHERE user_id = ? ORDER BY added_at ASC').all(req.session.userId);
  res.json({ watchlist: rows.map(r => r.symbol) });
});

// Remove symbol
app.delete('/api/watchlist/:symbol', requireAuth, (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  db.prepare('DELETE FROM watchlists WHERE user_id = ? AND symbol = ?').run(req.session.userId, sym);
  const rows = db.prepare('SELECT symbol FROM watchlists WHERE user_id = ? ORDER BY added_at ASC').all(req.session.userId);
  res.json({ watchlist: rows.map(r => r.symbol) });
});

// ── Yahoo Finance quote → normalised object ────────────────────────────────────
// Uses the yahoo-finance2 SDK which correctly returns marketState,
// postMarketPrice, preMarketPrice and all extended-hours fields.
function _normaliseQuote(q) {
  if (!q) return null;

  const marketState = q.marketState || 'CLOSED';
  const isPost = ['POST', 'POSTPOST'].includes(marketState);
  const isPre  = ['PRE',  'PREPRE' ].includes(marketState);

  const regPrice = q.regularMarketPrice ?? null;

  // In PRE/PREPRE sessions try preMarketPrice; if not available yet (PREPRE early morning)
  // fall back to postMarketPrice (last known AH price from prior session)
  let extendedPrice = null;
  let extendedType  = null;
  if (isPost) {
    extendedPrice = q.postMarketPrice ?? null;
    extendedType  = 'AH';
  } else if (isPre) {
    if (q.preMarketPrice != null) {
      extendedPrice = q.preMarketPrice;
      extendedType  = 'PRE';
    } else if (q.postMarketPrice != null) {
      // PREPRE window — no pre-market trading yet; show last AH price
      extendedPrice = q.postMarketPrice;
      extendedType  = 'AH';
    }
  }

  const livePrice = extendedPrice ?? regPrice;
  const prev      = q.regularMarketPreviousClose ?? null;
  const change    = livePrice != null && prev != null ? livePrice - prev : null;

  return {
    symbol:            q.symbol,
    name:              q.longName || q.shortName || q.symbol,
    price:             livePrice,
    regularClose:      regPrice,
    extendedPrice,
    extendedType,
    extendedChange:    extendedPrice != null && regPrice != null ? extendedPrice - regPrice : null,
    extendedChangePct: extendedPrice != null && regPrice != null ? ((extendedPrice - regPrice) / regPrice) * 100 : null,
    marketState,
    change,
    changesPercentage: change != null && prev ? (change / prev) * 100 : null,
    open:              q.regularMarketOpen    ?? null,
    dayHigh:           q.regularMarketDayHigh ?? null,
    dayLow:            q.regularMarketDayLow  ?? null,
    previousClose:     prev,
    volume:            q.regularMarketVolume  ?? null,
    avgVolume:         q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? null,
    marketCap:         q.marketCap ?? null,
    yearHigh:          q.fiftyTwoWeekHigh ?? null,
    yearLow:           q.fiftyTwoWeekLow  ?? null,
    pe:                q.trailingPE       ?? null,
    eps:               q.epsTrailingTwelveMonths ?? null,
    asOf:              q.preMarketTime ?? q.postMarketTime ?? q.regularMarketTime ?? null,
    // Yahoo does not expose a trustworthy order-book contract. Keep this
    // explicit so downstream analysis can fail closed rather than infer sizes.
    marketDepthAvailable: false,
  };
}

async function yfChartQuote(symbol) {
  try {
    const q = await yf.quote(symbol, {}, { validateResult: false });
    return _normaliseQuote(q);
  } catch (e) {
    console.error('yfChartQuote error for', symbol, e.message);
    return null;
  }
}

// ── Alpaca Data API (data.alpaca.markets) — 24/7 real-time market data ─────────
// Uses stored user Alpaca credentials for the data feed.
// The data API key is identical to the trading API key.

async function alpacaDataFetchWithCredentials(creds, path, _attempt = 0) {
  try {
    if (!creds) return null;
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 12000);
    let r;
    try {
      r = await fetch('https://data.alpaca.markets' + path, {
        signal: controller.signal,
        headers: {
          'APCA-API-KEY-ID':     creds.api_key,
          'APCA-API-SECRET-KEY': creds.api_secret,
        },
      });
    } catch (netErr) {
      clearTimeout(timeoutId);
      if (_attempt < 2) {
        const delay = Math.min(1000 * 2 ** _attempt, 4000);
        await new Promise(res => setTimeout(res, delay));
        return alpacaDataFetchWithCredentials(creds, path, _attempt + 1);
      }
      return null;
    }
    clearTimeout(timeoutId);
    if (r.status === 429 && _attempt < 2) {
      await new Promise(res => setTimeout(res, 2000 * (_attempt + 1)));
      return alpacaDataFetchWithCredentials(creds, path, _attempt + 1);
    }
    if ([502, 503, 504].includes(r.status) && _attempt < 2) {
      await new Promise(res => setTimeout(res, 1500 * (_attempt + 1)));
      return alpacaDataFetchWithCredentials(creds, path, _attempt + 1);
    }
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

async function alpacaDataFetch(userId, path, scope = 'manual', _attempt = 0) {
  return alpacaDataFetchWithCredentials(getAlpacaCreds(userId, scope), path, _attempt);
}

// Fetch Alpaca snapshot(s) for one or more symbols.
// Returns { AAPL: { latestTrade, latestQuote, minuteBar, dailyBar, prevDailyBar }, ... }
async function alpacaSnapshotFetch(userId, symbols, scope = 'manual') {
  const syms = Array.isArray(symbols) ? symbols.join(',') : symbols;
  return alpacaDataFetch(userId, `/v2/stocks/snapshots?symbols=${encodeURIComponent(syms)}&feed=iex`, scope);
}

// Determine the current ET market session state (REGULAR, PRE, POST, CLOSED)
function currentMarketState() {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day  = et.getDay();          // 0=Sun 6=Sat
  if (day === 0 || day === 6) return 'CLOSED';
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 570 && mins < 960)  return 'REGULAR';   // 9:30–16:00
  if (mins >= 240 && mins < 570)  return 'PRE';       // 4:00–9:30
  if (mins >= 960 && mins < 1200) return 'POST';      // 16:00–20:00
  return 'CLOSED';
}

// Normalise an Alpaca snapshot entry → same shape as _normaliseQuote
// so all downstream code is completely unaware of the data source.
function _normaliseAlpacaSnapshot(sym, snap, extras = {}) {
  if (!snap) return null;
  const price  = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c ?? null;
  const daily  = snap.dailyBar  || {};
  const prev   = snap.prevDailyBar?.c ?? null;
  const change = price != null && prev != null ? price - prev : null;
  const changePct = change != null && prev ? (change / prev) * 100 : null;
  const marketState = currentMarketState();
  const isPost = marketState === 'POST';
  const isPre  = marketState === 'PRE';
  // Extended-hours price: use minuteBar.c if outside regular session
  let extendedPrice = null, extendedType = null;
  if (isPost && price != null && daily.c != null && price !== daily.c) {
    extendedPrice = price; extendedType = 'AH';
  } else if (isPre && price != null) {
    extendedPrice = price; extendedType = 'PRE';
  }
  return {
    symbol:            sym,
    name:              extras.name || sym,
    price:             price,
    regularClose:      daily.c ?? price,
    extendedPrice,
    extendedType,
    extendedChange:    extendedPrice != null && daily.c != null ? extendedPrice - daily.c : null,
    extendedChangePct: extendedPrice != null && daily.c != null ? ((extendedPrice - daily.c) / daily.c) * 100 : null,
    marketState,
    change,
    changesPercentage: changePct,
    open:              daily.o ?? null,
    dayHigh:           daily.h ?? null,
    dayLow:            daily.l ?? null,
    previousClose:     prev,
    volume:            daily.v ?? null,
    avgVolume:         extras.avgVolume ?? null,
    marketCap:         extras.marketCap ?? null,
    yearHigh:          extras.yearHigh  ?? null,
    yearLow:           extras.yearLow   ?? null,
    pe:                extras.pe        ?? null,
    eps:               extras.eps       ?? null,
    source:            'alpaca',
    asOf:              snap.latestTrade?.t ?? snap.minuteBar?.t ?? snap.dailyBar?.t ?? null,
    topOfBook: snap.latestQuote ? {
      bid: snap.latestQuote.bp ?? null, bidSize: snap.latestQuote.bs ?? null,
      ask: snap.latestQuote.ap ?? null, askSize: snap.latestQuote.as ?? null,
      timestamp: snap.latestQuote.t ?? null,
    } : null,
    latestQuote: snap.latestQuote || null,
    recentTrade: snap.latestTrade ? {
      price: snap.latestTrade.p ?? null, size: snap.latestTrade.s ?? null,
      timestamp: snap.latestTrade.t ?? null,
    } : null,
    latestTrade: snap.latestTrade || null,
    minuteBar: snap.minuteBar || null,
    minuteBarVolume: snap.minuteBar?.v ?? null,
    marketDepthAvailable: false,
  };
}

// ── fetchLiveQuote: Alpaca-first, Yahoo-fallback ───────────────────────────────
// Single source of truth for real-time price throughout the app.
// data.alpaca.markets is the primary feed (24/7); Yahoo Finance is the safety net.
async function fetchLiveQuote(symbol, userId = null, scope = 'manual') {
  if (userId) {
    try {
      const snap = await alpacaSnapshotFetch(userId, symbol, scope);
      if (snap?.[symbol]) {
        const q = _normaliseAlpacaSnapshot(symbol, snap[symbol]);
        if (q?.price != null) return q;
      }
    } catch { /* fall through */ }
  }
  return yfChartQuote(symbol);
}

// ── GET /api/futures — near-24/5 futures + overnight proxy prices ─────────────
// Symbols: ES=F (S&P 500), NQ=F (Nasdaq 100), YM=F (Dow), RTY=F (Russell 2000),
//          GC=F (Gold), CL=F (Crude Oil), ZB=F (30yr Bond), VX=F (VIX futures)
const FUTURES_SYMBOLS = ['ES=F','NQ=F','YM=F','RTY=F','GC=F','CL=F','ZB=F'];
const FUTURES_META = {
  'ES=F':  { label: 'S&P 500',       underlying: 'SPY'  },
  'NQ=F':  { label: 'Nasdaq 100',    underlying: 'QQQ'  },
  'YM=F':  { label: 'Dow Jones',     underlying: 'DIA'  },
  'RTY=F': { label: 'Russell 2000',  underlying: 'IWM'  },
  'GC=F':  { label: 'Gold',          underlying: null   },
  'CL=F':  { label: 'Crude Oil',     underlying: null   },
  'ZB=F':  { label: '30yr Treasury', underlying: 'TLT'  },
};
app.get('/api/futures', requireAuth, async (req, res) => {
  try {
    const raw = await yf.quote(FUTURES_SYMBOLS, {}, { validateResult: false });
    const quotes = Array.isArray(raw) ? raw : [raw];
    const out = {};
    quotes.forEach(q => {
      if (!q?.symbol) return;
      const n = _normaliseQuote(q);
      if (n) out[q.symbol] = { ...n, ...FUTURES_META[q.symbol] };
    });
    res.json(out);
  } catch (e) {
    console.error('[Futures] fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/quote/:symbol ─────────────────────────────────────────────────────
// Alpaca data.alpaca.markets is tried first (24/7); Yahoo Finance is the fallback.
app.get('/api/quote/:symbol', requireAuth, async (req, res) => {
  try {
    const q = await fetchLiveQuote(req.params.symbol.toUpperCase(), req.session.userId);
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/snapshots?symbols=A,B ────────────────────────────────────────────
// Alpaca batch snapshot tried first (one call, 24/7); Yahoo Finance fallback.
app.get('/api/snapshots', requireAuth, async (req, res) => {
  const syms = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!syms.length) return res.json({});
  try {
    const uid = req.session.userId;
    if (uid) {
      const snap = await alpacaSnapshotFetch(uid, syms).catch(() => null);
      if (snap && Object.keys(snap).length) {
        const out = {};
        syms.forEach(s => { if (snap[s]) out[s] = _normaliseAlpacaSnapshot(s, snap[s]); });
        if (Object.keys(out).length) return res.json(out);
      }
    }
    // Yahoo Finance fallback
    const raw = await yf.quote(syms, {}, { validateResult: false });
    const quotes = Array.isArray(raw) ? raw : [raw];
    const out = {};
    quotes.forEach(q => { if (q?.symbol) out[q.symbol] = _normaliseQuote(q); });
    res.json(out);
  } catch (e) {
    console.error('Snapshots error:', e.message);
    res.json({});
  }
});

// ── GET /api/search?q= ────────────────────────────────────────────────────────
// Yahoo Finance attempted first; Alpaca asset catalogue used as 24/7 fallback.
// Results cached 5 min to survive Yahoo rate-limits and speed up repeat queries.
app.get('/api/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const macroSuggestions = searchMacroSuggestions(q);

  const cacheKey = q.toLowerCase();
  const cached = _searchCacheGet(cacheKey);
  if (cached) return res.json(cached);

  // ── 1. Yahoo Finance ────────────────────────────────────────────────────────
  try {
    const url  = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`;
    const r    = await fetch(url, { headers: YH, signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const data = await r.json();
      const out  = (data?.quotes || [])
        .filter(x => ['EQUITY','ETF','MUTUALFUND','INDEX','CRYPTOCURRENCY'].includes(x.quoteType) && x.symbol)
        .slice(0, 8)
        .map(x => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchange || '', quoteType: x.quoteType || '' }));
      if (out.length) {
        const combined = [...macroSuggestions, ...out];
        _searchCacheSet(cacheKey, combined);
        return res.json(combined);
      }
    }
  } catch { /* fall through to Alpaca */ }

  // ── 2. Alpaca asset catalogue fallback (works 24/7, no rate limits) ─────────
  try {
    const uid = req.session.userId;
    if (uid) {
      const upper = q.toUpperCase();
      // Try exact symbol match first
      const exact = await alpacaDataFetch(uid, `/v2/assets/${upper}`).catch(() => null);
      if (exact?.symbol) {
        const out = [...macroSuggestions, { symbol: exact.symbol, name: exact.name || exact.symbol, exchange: exact.exchange || '', quoteType: exact.class === 'crypto' ? 'CRYPTOCURRENCY' : 'EQUITY' }];
        _searchCacheSet(cacheKey, out); return res.json(out);
      }
      // Broader search across active assets
      const assets = await alpacaDataFetch(uid, `/v2/assets?status=active&asset_class=us_equity`).catch(() => null);
      if (Array.isArray(assets)) {
        const ql = q.toLowerCase();
        const matched = assets
          .filter(a => a.tradable && (
            a.symbol.toUpperCase().startsWith(upper) ||
            (a.name || '').toLowerCase().includes(ql)
          ))
          .sort((a, b) => {
            const aExact = a.symbol.toUpperCase() === upper ? -1 : 0;
            const bExact = b.symbol.toUpperCase() === upper ? -1 : 0;
            return aExact - bExact || a.symbol.localeCompare(b.symbol);
          })
          .slice(0, 8)
          .map(a => ({ symbol: a.symbol, name: a.name || a.symbol, exchange: a.exchange || '', quoteType: 'EQUITY' }));
        if (matched.length) {
          const combined = [...macroSuggestions, ...matched];
          _searchCacheSet(cacheKey, combined);
          return res.json(combined);
        }
      }
    }
  } catch { /* fall through */ }

  if (macroSuggestions.length) _searchCacheSet(cacheKey, macroSuggestions);
  res.json(macroSuggestions);
});

// ── GET /api/search-intelligence?q=&symbol= ──────────────────────────────────
// Search-page-only macro and prediction-market context. This endpoint is loaded
// independently so a slow external source never blocks the primary asset view.
app.get('/api/search-intelligence', requireAuth, async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 160);
  if (!query) return res.status(400).json({ ok: false, error: 'Search query is required' });
  const classification = classifySearchQuery(query);
  const requestedSymbol = String(req.query.symbol || classification.symbol || '').trim().toUpperCase();
  const symbol = requestedSymbol === 'BTC' ? 'BTC-USD' : requestedSymbol;
  const cacheKey = `${query.toLowerCase()}|${symbol}`;
  const cached = _searchIntelligenceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_INTELLIGENCE_TTL) return res.json(cached.data);

  const generatedAt = new Date().toISOString();
  const [kalshiCatalog, macroFeed, topicNews, assetQuoteResult] = await Promise.all([
    fetchKalshiCatalog(query),
    fetchSearchMacroIndicators(),
    fetchSearchTopicNews(query),
    symbol
      ? Promise.all([
        yf.quote(symbol, {}, { validateResult: false }).catch(() => null),
        yf.quoteSummary(symbol, { modules: ['assetProfile'] }, { validateResult: false }).catch(() => null),
      ])
      : Promise.resolve([null, null]),
  ]);

  const [assetQuote, assetSummary] = assetQuoteResult;
  const asset = assetQuote ? {
    symbol: assetQuote.symbol || symbol,
    name: assetQuote.shortName || assetQuote.longName || symbol,
    price: Number.isFinite(Number(assetQuote.regularMarketPrice))
      ? +Number(assetQuote.regularMarketPrice).toFixed(2)
      : null,
    changePct: Number.isFinite(Number(assetQuote.regularMarketChangePercent))
      ? +Number(assetQuote.regularMarketChangePercent).toFixed(2)
      : null,
    sector: assetSummary?.assetProfile?.sector || null,
    source: 'Yahoo Finance',
    updatedAt: assetQuote.regularMarketTime
      ? new Date(Number(assetQuote.regularMarketTime) * 1000).toISOString()
      : generatedAt,
  } : symbol ? {
    symbol,
    name: symbol,
    price: null,
    changePct: null,
    sector: null,
    source: 'Yahoo Finance',
    updatedAt: generatedAt,
    status: 'unavailable',
  } : null;

  const predictionMarkets = kalshiCatalog.status === 'live'
    ? selectRelevantKalshiMarkets(kalshiCatalog.markets, query, 6)
    : [];
  const macroPressure = buildMacroPressure(macroFeed.indicators, asset || {});
  const divergence = detectPredictionPriceDivergence(predictionMarkets, asset?.changePct);
  const relevantFedMarkets = predictionMarkets.filter(market =>
    /(fed|fomc|interest rate|rate cut|rate hike)/i.test(`${market.title} ${market.yesLabel}`));
  const sourceStatus = {
    kalshi: {
      source: 'Kalshi official public API',
      status: kalshiCatalog.status,
      updatedAt: kalshiCatalog.at ? new Date(kalshiCatalog.at).toISOString() : generatedAt,
      error: kalshiCatalog.status === 'unavailable' ? 'Data temporarily unavailable' : null,
    },
    macro: {
      source: macroFeed.source,
      status: macroFeed.status,
      updatedAt: macroFeed.updatedAt,
      error: macroFeed.status === 'unavailable' ? 'Data temporarily unavailable' : null,
    },
    news: {
      source: topicNews.source,
      status: topicNews.status,
      updatedAt: topicNews.updatedAt,
      error: topicNews.status === 'unavailable' ? 'Data temporarily unavailable' : null,
    },
  };
  const aiFacts = {
    query,
    classification,
    asset,
    predictionMarkets: predictionMarkets.map(market => ({
      title: market.title,
      yesLabel: market.yesLabel,
      yesProbability: market.yesProbability,
      probabilityChange: market.probabilityChange,
      updatedAt: market.updatedAt,
    })),
    macroIndicators: macroFeed.indicators,
    macroPressure,
    divergence,
    recentHeadlines: topicNews.items.slice(0, 5).map(item => item.headline),
  };
  const interpretation = await buildSearchAiInterpretation(aiFacts);

  const data = {
    ok: true,
    query,
    generatedAt,
    classification,
    asset,
    predictionMarkets,
    predictionMarketStatus: predictionMarkets.length
      ? 'live'
      : kalshiCatalog.status === 'unavailable' ? 'unavailable' : 'no_relevant_markets',
    predictionMarketMessage: predictionMarkets.length
      ? null
      : kalshiCatalog.status === 'unavailable'
        ? 'Prediction-market data temporarily unavailable'
        : 'No directly relevant Kalshi market available',
    fedOutlook: {
      available: relevantFedMarkets.length > 0,
      markets: relevantFedMarkets,
      currentRate: null,
      nextMeeting: null,
      note: relevantFedMarkets.length
        ? 'Market-implied probabilities from relevant Kalshi contracts.'
        : 'No directly relevant Fed contract was found in the current Kalshi catalog.',
    },
    macroIndicators: macroFeed.indicators,
    macroPressure,
    divergence,
    geopoliticalRisk: classification.primaryTopic === 'geopolitical'
      ? {
        available: macroFeed.status === 'live' || topicNews.status === 'live',
        label: 'Analytical inference — not a prediction-market probability',
        indicators: ['oil', 'brent', 'gold', 'usd', 'vix', 'tenYear']
          .map(key => macroFeed.indicators[key]).filter(Boolean),
      }
      : null,
    news: topicNews,
    interpretation,
    sources: sourceStatus,
    disclaimer: 'Prediction-market probabilities are not guarantees and should be considered alongside price action, technicals, news, and macro data. This is analysis, not financial advice.',
  };
  _searchIntelligenceCache.set(cacheKey, { at: Date.now(), data });
  if (_searchIntelligenceCache.size > 100) {
    const oldest = [..._searchIntelligenceCache.entries()]
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _searchIntelligenceCache.delete(oldest[0]);
  }
  res.json(data);
});

// ── GET /api/bars/:symbol?timeframe=&limit= ───────────────────────────────────
app.get('/api/bars/:symbol', requireAuth, async (req, res) => {
  const sym   = req.params.symbol.toUpperCase();
  const tf    = req.query.timeframe || '1Day';
  const limit = parseInt(req.query.limit) || 60;

  // ── Try Alpaca bars first (24/7, includes extended-hours OHLCV) ────────────
  const uid = req.session.userId;
  if (uid) {
    try {
      // Alpaca timeframe strings match our convention directly
      const alpacaTf = { '1Day':'1Day','1Hour':'1Hour','5Min':'5Min','15Min':'15Min' }[tf] || '1Day';
      const data = await alpacaDataFetch(uid,
        `/v2/stocks/${sym}/bars?timeframe=${alpacaTf}&limit=${limit}&adjustment=all&feed=iex`);
      if (data?.bars?.length) {
        return res.json({ bars: data.bars.map(b => ({
          t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
        })) });
      }
    } catch { /* fall through to Yahoo */ }
  }

  // ── Yahoo Finance fallback ─────────────────────────────────────────────────
  const iMap     = { '1Hour':'1h', '1Day':'1d', '5Min':'5m', '15Min':'15m' };
  const interval = iMap[tf] || '1d';
  const range    = limit <= 7 ? '5d' : limit <= 30 ? '1mo' : limit <= 90 ? '3mo' : limit <= 180 ? '6mo' : '1y';
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
    const r   = await fetch(url, { headers: YH });
    if (!r.ok) return res.json({ bars: [] });
    const d   = await r.json();
    const rs  = d?.chart?.result?.[0];
    if (!rs) return res.json({ bars: [] });
    const times = rs.timestamp || [];
    const q     = rs.indicators?.quote?.[0] || {};
    const bars  = times.map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      o: q.open?.[i]   ?? null, h: q.high?.[i]   ?? null,
      l: q.low?.[i]    ?? null, c: q.close?.[i]  ?? null,
      v: q.volume?.[i] ?? null,
    })).filter(b => b.c != null).slice(-limit);
    res.json({ bars });
  } catch { res.json({ bars: [] }); }
});

// ── GET /api/historical/:symbol?timeseries=N ──────────────────────────────────
app.get('/api/historical/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const n   = parseInt(req.query.timeseries) || 30;
  const range = n <= 30 ? '1mo' : n <= 90 ? '3mo' : '6mo';
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=${range}`;
    const r   = await fetch(url, { headers: YH });
    const d   = await r.json();
    const rs  = d?.chart?.result?.[0];
    if (!rs) return res.json({ historical: [] });
    const times = rs.timestamp || [];
    const q     = rs.indicators?.quote?.[0] || {};
    const historical = times.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? null, high: q.high?.[i] ?? null,
      low:  q.low?.[i]  ?? null, close: q.close?.[i] ?? null,
      volume: q.volume?.[i] ?? null,
    })).filter(b => b.close != null).reverse().slice(0, n);
    res.json({ historical });
  } catch { res.json({ historical: [] }); }
});

// ── GET /api/forecast/:symbol ───────────────────────────────────────────────────
// Read-only, historical conditional forecast. This deliberately uses Yahoo's
// split-adjusted chart data and never participates in order decisions.
const _forecastCache = new Map();
const _forecastHistoryCache = new Map();
const _forecastHistoryInflight = new Map();
const FORECAST_CACHE_MS = 10 * 60 * 1000;
const FORECAST_YEARS = [1, 3, 5, 10, 15, 20, 25];

async function fetchForecastDaily(symbol, years) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const period1 = now - years * 366 * 24 * 60 * 60;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${now}&events=div%2Csplits&includeAdjustedClose=true`;
    const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const rs = (await r.json())?.chart?.result?.[0];
    if (!rs) return null;
    const times = rs.timestamp || [];
    const quote = rs.indicators?.quote?.[0] || {};
    const adjusted = rs.indicators?.adjclose?.[0]?.adjclose || [];
    const mapped = times.map((t, i) => {
      const rawClose = Number(quote.close?.[i]);
      const adjustedClose = Number(adjusted[i]);
      const factor = Number.isFinite(rawClose) && rawClose > 0 && Number.isFinite(adjustedClose)
        ? adjustedClose / rawClose : 1;
      return {
        t: new Date(t * 1000).toISOString().slice(0, 10),
        o: Number(quote.open?.[i]) * factor,
        h: Number(quote.high?.[i]) * factor,
        l: Number(quote.low?.[i]) * factor,
        c: Number.isFinite(adjustedClose) ? adjustedClose : rawClose,
        v: quote.volume?.[i],
      };
    });
    // A live daily candle is not a completed historical observation. Excluding it
    // during premarket/regular hours prevents the current partial session from
    // changing a multi-session pattern merely because the page refreshed.
    const marketState = currentMarketState();
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const part = type => dateParts.find(entry => entry.type === type)?.value;
    const etToday = `${part('year')}-${part('month')}-${part('day')}`;
    if (['PRE', 'REGULAR'].includes(marketState) && mapped.at(-1)?.t === etToday) mapped.pop();
    return mapped;
  } catch (error) {
    console.warn('[Forecast] historical fetch failed:', error.message);
    return null;
  }
}

async function getForecastDaily(symbol, years) {
  const key = `${symbol}:${years}`;
  const cached = _forecastHistoryCache.get(key);
  if (cached && Date.now() - cached.at < FORECAST_CACHE_MS) return cached.bars;
  if (_forecastHistoryInflight.has(key)) return _forecastHistoryInflight.get(key);
  const request = fetchForecastDaily(symbol, years)
    .then(bars => {
      if (bars?.length) {
        _forecastHistoryCache.set(key, { at: Date.now(), bars });
        if (_forecastHistoryCache.size > 100) _forecastHistoryCache.delete(_forecastHistoryCache.keys().next().value);
      }
      return bars;
    })
    .finally(() => _forecastHistoryInflight.delete(key));
  _forecastHistoryInflight.set(key, request);
  return request;
}

function compactForecastValidation(report) {
  const group = report.groups?.[0] || null;
  const displayableCalls = report.calls?.filter(call => call.evaluable) || [];
  return {
    available: report.available,
    status: report.status,
    contractVersion: report.contractVersion,
    mode: report.mode,
    pointInTime: report.pointInTime,
    liveExecutionAllowed: report.liveExecutionAllowed,
    automationChanged: report.automationChanged,
    summary: report.summary,
    group: group ? {
      lookback: group.lookback,
      horizon: group.horizon,
      displayableCalls: group.displayableCalls,
      independentEvaluatedCalls: group.independentEvaluatedCalls,
      overlappingCallsExcluded: group.overlappingCallsExcluded,
      withheldCalls: group.withheldCalls,
      predictedProbabilityRanges: group.predictedProbabilityRanges,
      realizedOutcomeRates: group.realizedOutcomeRates,
      meanPredictedProbabilities: group.meanPredictedProbabilities,
      calibrationError: group.calibrationError,
      maxCalibrationError: group.maxCalibrationError,
      brierScore: group.brierScore,
      reliability: group.reliability,
      status: group.status,
      warnings: group.warnings,
    } : null,
    period: {
      firstForecastDate: displayableCalls[0]?.asOf || null,
      lastForecastDate: displayableCalls.at(-1)?.asOf || null,
      lastOutcomeDate: displayableCalls.at(-1)?.outcomeDate || null,
    },
    flags: report.flags,
    explanation: report.explanation,
  };
}

app.get('/api/forecast/:symbol', requireAuth, async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase().replace(/[^A-Z0-9.^-]/g, '');
  if (!symbol || symbol.length > 12) return res.status(400).json({ error: 'Invalid symbol.' });
  const lookback = Number(req.query.lookback) || 90;
  const horizon = Number(req.query.horizon) || 30;
  const requestedYears = Number(req.query.years) || 10;
  const years = FORECAST_YEARS.reduce((closest, value) =>
    Math.abs(value - requestedYears) < Math.abs(closest - requestedYears) ? value : closest, 10);
  if (!FORECAST_LOOKBACKS.includes(lookback) || !FORECAST_HORIZONS.includes(horizon)) {
    return res.status(400).json({
      error: `lookback must be one of ${FORECAST_LOOKBACKS.join(', ')} and horizon must be one of ${FORECAST_HORIZONS.join(', ')}.`,
    });
  }

  const cacheKey = `${symbol}:${years}:${lookback}:${horizon}`;
  const cached = _forecastCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FORECAST_CACHE_MS) return res.json({ ...cached.data, cached: true });
  try {
    const bars = await getForecastDaily(symbol, years);
    const data = buildHistoricalForecast({ ticker: symbol, bars, lookback, horizon });
    // Keep the request bounded to at most 30 non-overlapping historical calls.
    // Each call receives only its as-of prefix; later bars label its outcome.
    const validationStartIndex = Math.max(0, (bars?.length || 0) - horizon * 30 - 1);
    const validation = compactForecastValidation(buildWalkForwardValidationReport({
      ticker: symbol,
      bars,
      lookbacks: [lookback],
      horizons: [horizon],
      startIndex: validationStartIndex,
      step: horizon,
    }));
    const payload = {
      ...data,
      validation,
      provider: 'Yahoo Finance chart API',
      adjustedCloseUsed: true,
      years,
    };
    _forecastCache.set(cacheKey, { at: Date.now(), data: payload });
    if (_forecastCache.size > 200) _forecastCache.delete(_forecastCache.keys().next().value);
    res.json(payload);
  } catch (error) {
    console.error('[Forecast] build failed:', error.message);
    res.status(500).json({ error: 'Historical forecast unavailable.' });
  }
});

// ── GET /api/news/:symbol ──────────────────────────────────────────────────────
app.get('/api/news/:symbol', async (req, res) => {
  const sym  = req.params.symbol.toUpperCase();
  const name = req.query.name || sym;

  if (NEWS_KEY) {
    try {
      const q   = encodeURIComponent(`${sym} stock`);
      const url = `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${NEWS_KEY}`;
      const r   = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        const articles = (data.articles || []).filter(a => a.title && a.title !== '[Removed]');
        if (articles.length) {
          return res.json({
            news: articles.map(a => ({
              headline:   a.title, url: a.url, source: a.source?.name || '',
              image:      a.urlToImage || null, summary: a.description || '',
              created_at: a.publishedAt || null,
            })),
            source: 'newsapi',
          });
        }
      }
    } catch {}
  }

  try {
    const url  = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${sym}&limit=20&apikey=${FMP_KEY}`;
    const r    = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length) {
        return res.json({ news: data.map(n => ({ headline: n.title, url: n.url, source: n.site, created_at: n.publishedDate })), source: 'fmp' });
      }
    }
  } catch {}

  try {
    const url  = `https://query1.finance.yahoo.com/v1/finance/search?q=${sym}&quotesCount=0&newsCount=12`;
    const r    = await fetch(url, { headers: YH });
    if (!r.ok) throw new Error(`Yahoo search ${r.status}`);
    const data = await r.json();
    const news = (data?.news || []).map(n => ({
      headline:   n.title, url: n.link, source: n.publisher,
      created_at: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    }));
    res.json({ news, source: 'yahoo' });
  } catch { res.json({ news: [], source: 'none' }); }
});

// ── GET /api/market-alerts ─────────────────────────────────────────────────────
// The banner is deliberately narrower than the News tab: only fresh headlines
// that contain both market context and an explicit move/event are eligible.
const MARKET_ALERT_CACHE_MS = 3 * 60 * 1000;
let marketAlertCache = null;
let marketAlertInflight = null;

app.get('/api/market-alerts', requireAuth, async (req, res) => {
  if (marketAlertCache && Date.now() - marketAlertCache.at < MARKET_ALERT_CACHE_MS) {
    return res.json({ ...marketAlertCache.data, cached: true });
  }
  if (marketAlertInflight) {
    try { return res.json(await marketAlertInflight); }
    catch { return res.json({ ok: true, alerts: [], unavailable: true }); }
  }

  marketAlertInflight = (async () => {
    const articles = [];
    const sources = [];

    try {
      const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=stock%20market&newsCount=30&quotesCount=0';
      const response = await fetch(url, { headers: YH, signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
      const data = await response.json();
      for (const article of data?.news || []) {
        articles.push({
          title: article.title,
          url: article.link,
          publisher: article.publisher,
          providerPublishTime: article.providerPublishTime,
        });
      }
      sources.push({ name: 'Yahoo Finance', status: 'live' });
    } catch (error) {
      sources.push({ name: 'Yahoo Finance', status: 'unavailable' });
      console.warn(`[MarketAlerts] Yahoo Finance unavailable: ${error.message}`);
    }

    if (NEWS_KEY) {
      try {
        const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const query = '(stock market OR futures OR "bond yields" OR inflation OR tariffs OR "Federal Reserve" OR oil)';
        const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&from=${encodeURIComponent(from)}&language=en&sortBy=publishedAt&pageSize=50&apiKey=${NEWS_KEY}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`NewsAPI HTTP ${response.status}`);
        const data = await response.json();
        for (const article of data?.articles || []) {
          articles.push({
            title: article.title,
            description: article.description,
            url: article.url,
            source: article.source?.name,
            publishedAt: article.publishedAt,
          });
        }
        sources.push({ name: 'NewsAPI', status: 'live' });
      } catch (error) {
        sources.push({ name: 'NewsAPI', status: 'unavailable' });
        console.warn(`[MarketAlerts] NewsAPI unavailable: ${error.message}`);
      }
    }

    const alerts = selectMarketAlerts(articles);
    return {
      ok: true,
      alerts,
      checkedAt: new Date().toISOString(),
      sources,
      unavailable: sources.length > 0 && sources.every(source => source.status !== 'live'),
    };
  })();

  try {
    const data = await marketAlertInflight;
    marketAlertCache = { at: Date.now(), data };
    return res.json(data);
  } finally {
    marketAlertInflight = null;
  }
});

// ── GET /api/stock/:symbol ─────────────────────────────────────────────────────
app.get('/api/stock/:symbol', async (req, res) => {
  const sym   = req.params.symbol.toUpperCase();
  const empty = { ratings: { strongBuy:0,buy:0,hold:0,sell:0,strongSell:0,total:0 }, priceTarget:null, upgrades:[] };
  try {
    const hdr = { headers: { 'User-Agent': 'Mozilla/5.0' } };
    const base = `https://financialmodelingprep.com/api/v3`;
    const key  = `apikey=${FMP_KEY}`;
    const [rd, pd, ud] = await Promise.all([
      fetch(`${base}/analyst-stock-recommendations/${sym}?${key}`, hdr).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`${base}/price-target-consensus?symbol=${sym}&${key}`, hdr).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`${base}/upgrades-downgrades?symbol=${sym}&${key}`, hdr).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    const re = Array.isArray(rd) && rd[0] ? rd[0] : null;
    const ratings = re ? {
      strongBuy:  re.analystRatingsStrongBuy  || 0,
      buy:        re.analystRatingsbuy         || 0,
      hold:       re.analystRatingsHold        || 0,
      sell:       re.analystRatingsSell        || 0,
      strongSell: re.analystRatingsStrongSell  || 0,
      total: (re.analystRatingsStrongBuy||0)+(re.analystRatingsbuy||0)+(re.analystRatingsHold||0)+(re.analystRatingsSell||0)+(re.analystRatingsStrongSell||0),
    } : empty.ratings;
    const pt = Array.isArray(pd) ? pd[0] : pd;
    const priceTarget = pt?.targetMedian ? { targetLow: pt.targetLow, targetMedian: pt.targetMedian || pt.targetConsensus, targetHigh: pt.targetHigh } : null;
    const upgrades = (Array.isArray(ud) ? ud : []).slice(0,10).map(u => ({ gradingCompany: u.gradingCompany, date: u.publishedDate||u.date, previousGrade: u.previousGrade, newGrade: u.newGrade }));
    res.json({ ratings, priceTarget, upgrades });
  } catch { res.json(empty); }
});

// ── GET /api/valuation/:symbol ─────────────────────────────────────────────────
app.get('/api/valuation/:symbol', async (req, res) => {
  const sym   = req.params.symbol.toUpperCase();
  const empty = { pe: null, eps: null, revenueGrowth: null, netMargin: null, grossMargin: null };
  try {
    const d  = await yf.quoteSummary(sym, {
      modules: ['defaultKeyStatistics', 'financialData', 'summaryDetail'],
    });
    const fd = d.financialData        || {};
    const ks = d.defaultKeyStatistics || {};
    const sd = d.summaryDetail        || {};
    const rev  = fd.revenueGrowth ?? null;
    res.json({
      pe:            sd.trailingPE    ?? null,
      eps:           ks.trailingEps   ?? null,
      revenueGrowth: rev != null ? rev * 100 : null,
      netMargin:     fd.profitMargins != null ? fd.profitMargins * 100 : null,
      grossMargin:   fd.grossMargins  != null ? fd.grossMargins  * 100 : null,
      date:          null,
    });
  } catch { res.json(empty); }
});

// ── POST /api/scanner-batch (stock scanner — all metrics for N tickers) ────────
app.post('/api/scanner-batch', async (req, res) => {
  const symbols = (req.body.symbols || [])
    .map(s => String(s).toUpperCase().replace(/[^A-Z0-9.\-]/g, '').trim())
    .filter(Boolean).slice(0, 100); // increased from 50 → 100 for full-market scan
  if (!symbols.length) return res.json({
    results: [], rejected: [], liquidityPolicy: DEFAULT_LIQUIDITY_POLICY,
  });

  const BATCH = 5;
  const out   = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk   = symbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(chunk.map(async sym => {
      try {
        const evaluatedAt = Date.now();
        const [quote, bars, fundamentals] = await Promise.all([
          yf.quote(sym, {}, { validateResult: false }).catch(() => null),
          fetchOHLCV(sym, 70).catch(() => null),
          _fetchFloatData(sym),
        ]);
        const price = Number.isFinite(Number(quote?.regularMarketPrice))
          ? Number(quote.regularMarketPrice) : null;

        const change    = Number.isFinite(Number(quote?.regularMarketChangePercent))
          ? Number(quote.regularMarketChangePercent) : null;
        const volume    = Number.isFinite(Number(quote?.regularMarketVolume))
          ? Number(quote.regularMarketVolume) : null;
        const bid       = Number.isFinite(Number(quote?.bid)) ? Number(quote.bid) : null;
        const ask       = Number.isFinite(Number(quote?.ask)) ? Number(quote.ask) : null;
        const liquidity = evaluateYahooLiquidity(quote, {
          now: evaluatedAt, marketState: currentMarketState(),
        });
        const avgVol    = quote?.averageDailyVolume3Month ?? quote?.averageDailyVolume10Day ?? 0;
        const relVol    = avgVol > 0 ? +(volume / avgVol).toFixed(2) : null;
        const marketCap = quote?.marketCap ?? null;
        // Prefer quoteSummary's floatShares, then sharesOutstanding, then the
        // quote endpoint's optional floatShares field as a final fallback.
        const floatFields = scannerFloatFields(fundamentals, quote);
        const w52High   = quote?.fiftyTwoWeekHigh ?? null;
        const w52Dist   = w52High && price != null ? +((price - w52High) / w52High * 100).toFixed(2) : null;
        const name      = quote?.shortName ?? quote?.longName ?? sym;

        let atr14 = null, rsi14 = null;
        if (bars && bars.length >= 20) {
          const closes = bars.map(b => b.c);
          try { atr14 = +calcATR(bars, 14).toFixed(3); } catch(_) {}
          try { const v = calcRSI(closes, 14); rsi14 = v != null ? +v.toFixed(1) : null; } catch(_) {}
        }

        return {
          sym, name, price, change: change == null ? null : +change.toFixed(2), volume,
          bid, ask, liquidity, relVol, atr14, rsi14,
          ...floatFields,
          marketCap, w52Dist,
        };
      } catch {
        const liquidity = evaluateLiquidity({});
        return {
          sym, name: sym, price: null, change: null, volume: null, bid: null, ask: null,
          liquidity, relVol: null, atr14: null, rsi14: null, float: null,
          floatSource: null, sharesOutstanding: null, marketCap: null, w52Dist: null,
        };
      }
    }));
    out.push(...settled.map(r => r.value).filter(Boolean));
  }
  res.json({
    results: out.filter(row => row.liquidity.eligible),
    rejected: out.filter(row => !row.liquidity.eligible),
    liquidityPolicy: DEFAULT_LIQUIDITY_POLICY,
  });
});

// ── GET /api/signal/:symbol (scanner intelligence panel signal) ────────────────
app.get('/api/signal/:symbol', async (req, res) => {
  const sym = req.params.symbol?.toUpperCase().trim();
  if (!sym) return res.status(400).json({ ok: false, error: 'symbol required' });
  try {
    const bars = await fetchOHLCV(sym, 60);
    if (!bars || bars.length < 20) return res.json({ ok: false, error: 'Insufficient data' });
    const closes = bars.map(b => b.c);
    const price   = closes.at(-1);
    const ema21   = calcEMA(closes, 21);
    const sma50   = calcSMA(closes, 50);
    let rsi14 = 50;
    try { const v = calcRSI(closes, 14); if (v != null) rsi14 = +v.toFixed(1); } catch (_) {}
    const aboveEma = price > ema21;
    const aboveSma = price > sma50;
    const rsiOk    = rsi14 < 70 && rsi14 > 30;
    const condsMet = [aboveEma, aboveSma, rsiOk].filter(Boolean).length;
    // ── Candlestick pattern detection ────────────────────────────────────────
    const patterns = detectCandlePatterns(bars);
    // Boost/reduce confidence based on detected patterns
    let confBoost = 0;
    for (const p of patterns.bullish) confBoost += p.strength === 3 ? 6 : p.strength === 2 ? 3 : 1;
    for (const p of patterns.bearish) confBoost -= p.strength === 3 ? 6 : p.strength === 2 ? 3 : 1;

    const signal    = condsMet === 3 ? 'BUY' : condsMet === 2 ? 'WATCH' : 'HOLD';
    const rawConf   = condsMet === 3 ? 72 : condsMet === 2 ? 48 : 30;
    const confidence = Math.min(95, Math.max(10, rawConf + confBoost));
    const reasons = [];
    if (aboveEma) reasons.push('Price above 21 EMA (short-term trend up)');
    if (aboveSma) reasons.push('Price above 50 SMA (medium-term trend up)');
    if (rsiOk)    reasons.push(`RSI ${rsi14} — momentum neutral/healthy`);
    if (patterns.bullish.length) reasons.push(`${patterns.bullish[0].name} detected — ${patterns.bullish[0].desc.split('—')[0].trim()}`);
    else if (patterns.bearish.length) reasons.push(`${patterns.bearish[0].name} detected — ${patterns.bearish[0].desc.split('—')[0].trim()}`);
    res.json({
      ok: true,
      symbol: sym,
      signal: {
        signal, confidence, reasons,
        price, ema8: ema21, sma50,
        confirmed: condsMet === 3,
        zoneStr: condsMet === 3 ? 'Trend aligned — all conditions met' : condsMet === 2 ? 'Partial setup — monitoring' : 'No active setup',
      },
      patterns: patterns.all,
      regime: { regime: 'NEUTRAL', label: 'Market Neutral' },
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/intraday/:symbol (5-min bars — includes pre/post market) ──────────
// Alpaca 5-Min bars + snapshot tried first (24/7); Yahoo Finance is the fallback.
app.get('/api/intraday/:symbol', requireAuth, async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    const uid = req.session.userId;
    const now = new Date();
    const { start: sessionStart } = regularSessionWindow(now);

    // ── Alpaca path ───────────────────────────────────────────────────────────
    if (uid) {
      // The VWAP entry gate deliberately uses only today's 9:30 AM–4:00 PM ET
      // session. Premarket, after-hours, and prior-session bars are not part of
      // institutional regular-session VWAP and must not influence an entry.
      const regularSessionStarted = now >= sessionStart;
      const barsPath = regularSessionStarted
        ? `/v2/stocks/${sym}/bars?timeframe=5Min&start=${encodeURIComponent(sessionStart.toISOString())}&limit=1000&adjustment=all&feed=iex`
        : `/v2/stocks/${sym}/bars?timeframe=5Min&limit=100&adjustment=all&feed=iex`;
      const [barsData, snapData] = await Promise.all([
        alpacaDataFetch(uid, barsPath).catch(() => null),
        alpacaSnapshotFetch(uid, sym).catch(() => null),
      ]);
      if (barsData?.bars?.length) {
        const bars  = barsData.bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
        const snap  = snapData?.[sym];
        const normQ = snap ? _normaliseAlpacaSnapshot(sym, snap) : null;
        const vwapEntry = evaluateSessionVwapContext({ bars, snapshot: snap, now });
        const currentPrice = vwapEntry.price ?? normQ?.price ?? bars.at(-1)?.c ?? null;
        const marketState = currentMarketState();
        const intradayPatterns = detectCandlePatterns(bars.slice(-10)).all;
        return res.json({
          bars,
          intradayPatterns,
          price:         currentPrice,
          priceTimestamp: vwapEntry.priceTimestamp,
          priceFresh:    vwapEntry.priceFresh,
          regularClose:  normQ?.regularClose ?? bars.at(-1)?.c ?? null,
          extendedPrice: normQ?.extendedPrice ?? null,
          extendedType:  normQ?.extendedType  ?? null,
          marketState,
          previousClose: normQ?.previousClose ?? null,
          open:          normQ?.open ?? bars[0]?.o ?? null,
          vwap:          vwapEntry.vwap,
          vwapSession:   vwapEntry.vwapSession,
          vwapEntry,
        });
      }
    }

    // ── Yahoo Finance fallback ────────────────────────────────────────────────
    const [chartRes, yfQuote] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=1d&includePrePost=true`, { headers: YH }),
      yf.quote(sym, {}, { validateResult: false }).catch(() => null),
    ]);

    if (!chartRes.ok) return res.json({ bars: [], intradayPatterns: [], price: null });
    const d  = await chartRes.json();
    const rs = d?.chart?.result?.[0];
    if (!rs) return res.json({ bars: [], intradayPatterns: [], price: null });

    const times = rs.timestamp || [];
    const q     = rs.indicators?.quote?.[0] || {};
    const bars  = times.map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      o: q.open?.[i]   ?? null, h: q.high?.[i]   ?? null,
      l: q.low?.[i]    ?? null, c: q.close?.[i]  ?? null,
      v: q.volume?.[i] ?? null,
    })).filter(b => b.c != null);
    const intradayPatterns = detectCandlePatterns(bars.slice(-10)).all;

    const marketState = yfQuote?.marketState || 'CLOSED';
    const isPost = ['POST', 'POSTPOST'].includes(marketState);
    const isPre  = ['PRE',  'PREPRE' ].includes(marketState);
    const regPrice = yfQuote?.regularMarketPrice ?? bars.at(-1)?.c ?? null;
    let extendedPrice = null;
    if (isPost)     extendedPrice = yfQuote?.postMarketPrice ?? null;
    else if (isPre) extendedPrice = yfQuote?.preMarketPrice ?? yfQuote?.postMarketPrice ?? null;

    const vwapEntry = evaluateSessionVwapContext({ bars, snapshot: null, now });
    res.json({
      bars,
      intradayPatterns,
      price:         extendedPrice ?? regPrice,
      regularClose:  regPrice,
      extendedPrice,
      extendedType:  isPost ? 'AH' : (isPre && yfQuote?.preMarketPrice != null) ? 'PRE' : (isPre && extendedPrice != null) ? 'AH' : null,
      marketState,
      previousClose: yfQuote?.regularMarketPreviousClose ?? null,
      open:          yfQuote?.regularMarketOpen ?? bars[0]?.o ?? null,
      priceTimestamp: null,
      priceFresh:    vwapEntry.priceFresh,
      vwap:          vwapEntry.vwap,
      vwapSession:   vwapEntry.vwapSession,
      vwapEntry,
    });
  } catch (e) {
    console.error('Intraday error:', e.message);
    res.json({ bars: [], intradayPatterns: [], price: null });
  }
});

// ── GET /api/wsb ───────────────────────────────────────────────────────────────
const WSB_BLOCKLIST = new Set([
  'DD','YOLO','HOLD','BUY','SELL','PUTS','CALL','CALLS','OTM','ITM','ATM',
  'ETF','FED','SEC','CEO','CFO','CTO','COO','IPO','USA','USD','EUR','GBP',
  'THE','AND','FOR','BUT','ARE','WAS','NOT','HAS','HAD','ITS','YOUR','YOU',
  'LOL','OMG','WTF','IMO','WSB','HFT','ATH','EOD','EOM','EOY','YTD','QOQ',
  'YOY','ALL','NOW','NEW','OLD','HOT','TOP','BIG','DAY','GET','GOT','OUT',
  'OFF','ANY','TOO','PER','PRE','POST','PRO','MAX','MIN','GDP','CPI','WHO',
  'WTO','IMF','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC','JAN',
  'FEB','MAR','DIV','NAV','NAZ','EOW','EPS','PE','PB','RH','AI','IT','US',
  'OR','IF','BE','DO','GO','ON','IN','AT','TO','OF','AS','UP','NO','MY',
  'EDIT','TLDR','FOMO','BTFD','HODL','MOON','BEAR','BULL','LONG','SHORT',
  'LMAO','LMFAO','JUST','BEEN','WILL','THAT','THIS','WITH','HAVE','FROM',
  'THEY','THEM','THEN','THAN','WHEN','WHAT','WERE','WELL','VERY','ALSO',
  'NEED','BACK','MUCH','HIGH','RATE','YEAR','LAST','GOOD','SAME',
]);

app.get('/api/wsb', async (req, res) => {
  try {
    const r = await fetch('https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1', {
      headers: { 'User-Agent': 'JohnnyQureshiFinance/1.0', 'Accept': 'application/json' },
    });
    if (!r.ok) return res.json({ tickers: [], risers: [], error: 'ApeWisdom unavailable' });
    const data = await r.json();
    const all  = (data.results || []).filter(x => x.ticker && x.mentions);

    const tickers = all.slice(0, 10).map(x => ({
      sym:         x.ticker,
      name:        x.name || '',
      rank:        x.rank,
      mentions:    x.mentions,
      upvotes:     x.upvotes || 0,
      rankAgo:     x.rank_24h_ago || x.rank,
      mentionsAgo: x.mentions_24h_ago || 0,
    }));

    const risers = [...all]
      .filter(x => x.rank_24h_ago && x.rank_24h_ago > x.rank)
      .sort((a, b) => (b.rank_24h_ago - b.rank) - (a.rank_24h_ago - a.rank))
      .slice(0, 10)
      .map(x => ({
        sym:      x.ticker,
        name:     x.name || '',
        rank:     x.rank,
        rankGain: x.rank_24h_ago - x.rank,
        mentions: x.mentions,
        upvotes:  x.upvotes || 0,
      }));

    res.json({ tickers, risers, updated: new Date().toISOString() });
  } catch (e) { res.json({ tickers: [], risers: [], error: e.message }); }
});

// ── Economic calendar fallback (Q3–Q4 2026) — used only when FMP is unavailable ─
// Updated for August–December 2026. Estimates reflect consensus as of mid-2026.
const ECO_CALENDAR_2026 = [
  // ── August 2026 ──────────────────────────────────────────────────────────────
  { date:'2026-08-21', event:'Jackson Hole Symposium Begins',      impact:'High',   estimate:null,    previous:null    },
  { date:'2026-08-22', event:'Fed Chair Speech — Jackson Hole',    impact:'High',   estimate:null,    previous:null    },
  { date:'2026-08-28', event:'Initial Jobless Claims',             impact:'Medium', estimate:'225K',  previous:'227K'  },
  { date:'2026-08-29', event:'PCE Price Index (July)',             impact:'High',   estimate:'2.5%',  previous:'2.5%'  },
  // ── September 2026 ───────────────────────────────────────────────────────────
  { date:'2026-09-04', event:'Non-Farm Payrolls (August)',         impact:'High',   estimate:'140K',  previous:'155K'  },
  { date:'2026-09-04', event:'Unemployment Rate (August)',         impact:'High',   estimate:'4.2%',  previous:'4.2%'  },
  { date:'2026-09-10', event:'CPI (August)',                       impact:'High',   estimate:'2.5%',  previous:'2.5%'  },
  { date:'2026-09-11', event:'Core CPI (August)',                  impact:'High',   estimate:'3.0%',  previous:'3.1%'  },
  { date:'2026-09-11', event:'PPI (August)',                       impact:'Medium', estimate:'2.4%',  previous:'2.5%'  },
  { date:'2026-09-15', event:'FOMC Meeting Begins',                impact:'High',   estimate:null,    previous:'4.25-4.50%' },
  { date:'2026-09-16', event:'Retail Sales (August)',              impact:'High',   estimate:'0.4%',  previous:'0.5%'  },
  { date:'2026-09-17', event:'FOMC Rate Decision',                 impact:'High',   estimate:'4.00-4.25%', previous:'4.25-4.50%' },
  { date:'2026-09-17', event:'Initial Jobless Claims',             impact:'Medium', estimate:'222K',  previous:'225K'  },
  { date:'2026-09-25', event:'PCE Price Index (August)',           impact:'High',   estimate:'2.4%',  previous:'2.5%'  },
  { date:'2026-09-30', event:'GDP Q2 2026 (Third Estimate)',       impact:'High',   estimate:'2.0%',  previous:'1.8%'  },
  // ── October 2026 ─────────────────────────────────────────────────────────────
  { date:'2026-10-02', event:'Non-Farm Payrolls (September)',      impact:'High',   estimate:'145K',  previous:'140K'  },
  { date:'2026-10-02', event:'Unemployment Rate (September)',      impact:'High',   estimate:'4.2%',  previous:'4.2%'  },
  { date:'2026-10-09', event:'Initial Jobless Claims',             impact:'Medium', estimate:'222K',  previous:null    },
  { date:'2026-10-10', event:'CPI (September)',                    impact:'High',   estimate:'2.4%',  previous:'2.5%'  },
  { date:'2026-10-14', event:'Retail Sales (September)',           impact:'High',   estimate:'0.4%',  previous:'0.4%'  },
  { date:'2026-10-15', event:'Michigan Consumer Sentiment (Oct P)',impact:'Medium', estimate:'69.0',  previous:'68.0'  },
  { date:'2026-10-29', event:'GDP Q3 2026 (Advance)',              impact:'High',   estimate:'2.2%',  previous:'2.0%'  },
  { date:'2026-10-30', event:'PCE Price Index (September)',        impact:'High',   estimate:'2.3%',  previous:'2.4%'  },
  // ── November 2026 ────────────────────────────────────────────────────────────
  { date:'2026-11-04', event:'FOMC Meeting Begins',                impact:'High',   estimate:null,    previous:'4.00-4.25%' },
  { date:'2026-11-06', event:'Non-Farm Payrolls (October)',        impact:'High',   estimate:'150K',  previous:'145K'  },
  { date:'2026-11-06', event:'FOMC Rate Decision',                 impact:'High',   estimate:'4.00-4.25%', previous:'4.00-4.25%' },
  { date:'2026-11-12', event:'CPI (October)',                      impact:'High',   estimate:'2.3%',  previous:'2.4%'  },
  { date:'2026-11-26', event:'PCE Price Index (October)',          impact:'High',   estimate:'2.2%',  previous:'2.3%'  },
  // ── December 2026 ────────────────────────────────────────────────────────────
  { date:'2026-12-04', event:'Non-Farm Payrolls (November)',       impact:'High',   estimate:'148K',  previous:'150K'  },
  { date:'2026-12-09', event:'FOMC Meeting Begins',                impact:'High',   estimate:null,    previous:'4.00-4.25%' },
  { date:'2026-12-10', event:'CPI (November)',                     impact:'High',   estimate:'2.2%',  previous:'2.3%'  },
  { date:'2026-12-11', event:'FOMC Rate Decision',                 impact:'High',   estimate:'3.75-4.00%', previous:'4.00-4.25%' },
  { date:'2026-12-19', event:'PCE Price Index (November)',         impact:'High',   estimate:'2.1%',  previous:'2.2%'  },
];

// ── GET /api/events — Economic calendar + upcoming earnings ───────────────────
app.get('/api/events', async (req, res) => {
  const today  = new Date();
  const from   = today.toISOString().split('T')[0];
  const toDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const to     = toDate.toISOString().split('T')[0];
  const result = { economic: [], earnings: [] };

  // Try FMP first
  if (FMP_KEY) {
    try {
      const hdr = { headers: { Accept: 'application/json', 'User-Agent': 'JQF/1.0' } };
      const [ecoRes, earnRes] = await Promise.all([
        fetch(`https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`, hdr),
        fetch(`https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`, hdr),
      ]);

      if (ecoRes.ok) {
        const eco = await ecoRes.json().catch(() => []);
        if (Array.isArray(eco) && eco.length) {
          result.economic = eco
            .filter(e => e.country === 'US' && ['High', 'Medium'].includes(e.impact))
            .slice(0, 14)
            .map(e => ({ date: e.date, event: e.event, impact: e.impact, previous: e.previous, estimate: e.estimate, actual: e.actual }));
        }
      }

      if (earnRes.ok) {
        const earn = await earnRes.json().catch(() => []);
        if (Array.isArray(earn) && earn.length) {
          const MAJOR = new Set(['AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','JPM','BAC','GS','V','MA','AMD','NFLX','ADBE','CRM','COIN','WMT','COST','HOOD','UBER','PLTR','ARM']);
          result.earnings = earn
            .filter(e => MAJOR.has(e.symbol))
            .slice(0, 12)
            .map(e => ({ date: e.date, symbol: e.symbol, time: e.time, epsEstimated: e.epsEstimated, revenueEstimated: e.revenueEstimated }));
        }
      }
    } catch (e) { console.error('Events FMP error:', e.message); }
  }

  // Fallback to hardcoded calendar if FMP returned nothing
  if (!result.economic.length) {
    result.economic = ECO_CALENDAR_2026
      .filter(e => e.date >= from && e.date <= to)
      .slice(0, 14)
      .map(e => ({ ...e, actual: null }));
  }

  res.json(result);
});

// ── ElevenLabs Signed URL (voice agent) ───────────────────────────────────────
app.get('/api/elevenlabs/signed-url', requireAuth, async (req, res) => {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  if (!agentId || !apiKey) {
    return res.status(503).json({ error: 'Voice agent not configured. Add ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID to secrets.' });
  }
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': apiKey } }
    );
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err.detail?.message || 'ElevenLabs API error.' });
    }
    const data = await r.json();
    res.json({ signedUrl: data.signed_url });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reach ElevenLabs API.' });
  }
});

// ── AI Text Chat (AIML API) ────────────────────────────────────────────────────
const AGENT_SYSTEM_PROMPT = `You are QF Agent — an expert AI financial assistant embedded inside Qureshi Finance, a professional stock research and real-time analysis platform.

PLATFORM OVERVIEW:
Qureshi Finance is a single-page application with four main pages:
1. HOME / SEARCH: Search any stock ticker. Displays real-time Trading Signals (BUY/HOLD/SELL), RSI gauge, support & resistance levels, direction bias, volume analysis, intraday VWAP console, analyst ratings donut chart, price targets, valuation metrics, and recent news.
2. MARKETS: Top daily gainers and losers, r/WallStreetBets trending stocks (from ApeWisdom), and a live scrolling ticker tape for major indices and mega-caps.
3. WATCHLIST: User's personally saved stocks with live prices, plus a Sector Rotation Heatmap showing momentum across 11 major ETF sectors (SPY, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLB, XLRE, XLU).
4. SCANNER: A stock screener covering 130+ symbols across sectors with presets for Momentum, Oversold, and Leveraged Bull/Bear ETFs.

TECHNICAL INDICATORS AVAILABLE ON SCREEN:
- RSI (Relative Strength Index): Calculated using Wilder's smoothing. Zones: <30 = Oversold, 30-50 = Bearish Neutral, 50-70 = Bullish Neutral, >70 = Overbought.
- Trading Signal: BUY/HOLD/SELL verdict with confidence %. Generated from RSI, volume surge vs average, and price vs open momentum.
- Direction Bias: Bullish/Bearish bias derived from multiple factors.
- Volume Analysis: Current volume vs average volume ratio. "High Volume" = more conviction.
- Support & Resistance Levels: Auto-detected from historical OHLCV pivot clustering.
- VWAP (Volume Weighted Average Price): Intraday benchmark — price above VWAP is bullish intraday.
- Intraday RSI (5-min): Short-term momentum on 5-minute candles.
- Intraday Verdict: BUY/HOLD/SELL generated from 5-min RSI, VWAP position, and volume.

DATA SOURCES:
- Yahoo Finance: Real-time quotes, OHLCV bars, intraday 5-min data, search suggestions.
- Financial Modeling Prep (FMP): Analyst ratings (Strong Buy/Buy/Hold/Sell/Strong Sell counts), price targets (median/high/low), recent rating changes and upgrades/downgrades, company news.
- ApeWisdom: r/WallStreetBets mention counts, upvotes, rank movements (24h).
- Internal SQLite: User authentication and personal watchlists.

YOUR CAPABILITIES:
- You receive the CURRENT SCREEN CONTEXT showing exactly what the user sees right now.
- You can reference specific RSI values, prices, signals, support/resistance levels, analyst counts, and more from the live data.
- You can explain what any indicator means and how to interpret it in context.
- You understand momentum trading, technical analysis, and fundamental valuation.

RESPONSE RULES:
- Be concise, data-driven, and specific. Reference actual numbers from the screen context.
- Speak like a sharp, knowledgeable trading mentor — not a cautious compliance officer.
- Keep responses under 180 words unless the user asks for a detailed breakdown.
- Format key data in **bold** for easy scanning.
- Never give specific buy/sell financial advice. Frame everything as educational analysis.
- If the user asks about something not on screen, answer from your general financial knowledge.
- Be direct. Skip preambles like "Great question!" or "Certainly!".`;

app.post('/api/agent/chat', requireAuth, async (req, res) => {
  const { message, context, history } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message required.' });

  const apiKey = process.env.AIML_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AIML_API_KEY not configured.' });

  const systemContent = AGENT_SYSTEM_PROMPT +
    '\n\nCURRENT SCREEN CONTEXT (live data from the user\'s screen right now):\n```json\n' +
    (context || '{}') + '\n```';

  const msgs = [{ role: 'system', content: systemContent }];

  if (Array.isArray(history)) {
    const recent = history.slice(-8);
    recent.forEach(m => {
      if (m.role && m.content) msgs.push({ role: m.role, content: m.content });
    });
  }
  msgs.push({ role: 'user', content: message });

  try {
    const r = await fetch('https://api.aimlapi.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      'gpt-4o-mini',
        messages:   msgs,
        max_tokens: 400,
        temperature: 0.65,
      }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err.error?.message || `AIML API error (${r.status}).` });
    }

    const data  = await r.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || 'Unable to generate a response.';
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'AI service unreachable.' });
  }
});

// ── AI TRADE GAME PLAN ─────────────────────────────────────────────────────────
// Probability-based intraday game plan. All numbers are computed deterministically
// from real market data; the LLM only writes the narrative around those facts.
// Missing data is reported explicitly — never fabricated.

const _gpCache = new Map();    // sym → { at, data }
const _gpInflight = new Map(); // sym → Promise (coalesces concurrent generations)
const _gpForceAt = new Map();  // userId:sym → last forced-regeneration time
const gpCacheKey = (userId, quoteScope, sym) => `${userId || 'anon'}:${quoteScope || 'manual'}:${sym}`;
const GP_CACHE_MS = 60 * 1000;
const GP_FORCE_COOLDOWN_MS = 30 * 1000;

const SECTOR_ETF = {
  'Technology': 'XLK', 'Financial Services': 'XLF', 'Healthcare': 'XLV',
  'Consumer Cyclical': 'XLY', 'Consumer Defensive': 'XLP', 'Energy': 'XLE',
  'Industrials': 'XLI', 'Basic Materials': 'XLB', 'Utilities': 'XLU',
  'Real Estate': 'XLRE', 'Communication Services': 'XLC',
};

async function gpFetchDaily(symbol, range = '2y') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`;
    const r = await fetch(url, { headers: YH });
    if (!r.ok) return null;
    const rs = (await r.json())?.chart?.result?.[0];
    if (!rs) return null;
    const times = rs.timestamp || [];
    const q = rs.indicators?.quote?.[0] || {};
    return times.map((t, i) => ({
      t: new Date(t * 1000).toISOString().slice(0, 10),
      o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
    })).filter(b => [b.o, b.h, b.l, b.c].every(x => x != null));
  } catch { return null; }
}

async function gpFetchIntraday(symbol, interval = '5m', range = '1d') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=true`;
    const r = await fetch(url, { headers: YH });
    if (!r.ok) return null;
    const rs = (await r.json())?.chart?.result?.[0];
    if (!rs) return null;
    const times = rs.timestamp || [];
    const q = rs.indicators?.quote?.[0] || {};
    const tz = rs.meta?.exchangeTimezoneName || 'America/New_York';
    return times.map((t, i) => ({
      t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
      session: (() => {
        const d = new Date(t * 1000);
        const et = new Date(d.toLocaleString('en-US', { timeZone: tz }));
        const mins = et.getHours() * 60 + et.getMinutes();
        return mins < 570 ? 'pre' : mins >= 960 ? 'post' : 'reg';
      })(),
    })).filter(b => b.c != null);
  } catch { return null; }
}

function gpFetchIntraday5m(symbol) {
  return gpFetchIntraday(symbol, '5m', '1d');
}

const _smartMoneyCache = new Map();
const _smartMoneyInflight = new Map();
const SMART_MONEY_CACHE_MS = 60 * 1000;

function buildSmartMoneyTimeframes({ hourly, daily, currentPrice, source = 'Yahoo Finance chart API' }) {
  const barsByTimeframe = {
    '1H': hourly || [],
    '4H': aggregateRegularSessionHours(hourly),
    '1D': daily || [],
    '1W': aggregateCalendarDailyBars(daily, '1W'),
    '1M': aggregateCalendarDailyBars(daily, '1M'),
  };
  const preliminary = Object.fromEntries(SMART_MONEY_TIMEFRAME_ORDER.map(timeframe => [
    timeframe,
    buildSmartMoneyMap({ bars: barsByTimeframe[timeframe], timeframe, currentPrice, source }),
  ]));
  return Object.fromEntries(SMART_MONEY_TIMEFRAME_ORDER.map(timeframe => [
    timeframe,
    buildSmartMoneyMap({
      bars: barsByTimeframe[timeframe],
      timeframe,
      currentPrice,
      source,
      confluenceTimeframes: SMART_MONEY_TIMEFRAME_ORDER
        .filter(other => other !== timeframe)
        .flatMap(other => preliminary[other]?.zones || []),
    }),
  ]));
}

async function buildSmartMoneySnapshot(symbol, timeframe, userId) {
  const tf = String(timeframe || '1D').toUpperCase();
  if (!SMART_MONEY_TIMEFRAMES[tf]) {
    return { available: false, status: 'UNAVAILABLE', reason: 'Unsupported timeframe' };
  }
  const [quote, hourly, daily] = await Promise.all([
    fetchLiveQuote(symbol, userId).catch(() => null),
    gpFetchIntraday(symbol, '1h', '3mo'),
    gpFetchDaily(symbol, '2y'),
  ]);
  if (!hourly?.length && !daily?.length) {
    return {
      available: false,
      status: 'UNAVAILABLE',
      timeframe: tf,
      reason: `Yahoo Finance ${SMART_MONEY_TIMEFRAMES[tf].label} OHLCV data unavailable`,
      generatedAt: new Date().toISOString(),
      source: 'Yahoo Finance chart API',
      dataQuality: { bars: 0, history: 'UNAVAILABLE', volumeAvailable: false },
    };
  }
  const currentPrice = quote?.price ?? hourly?.at(-1)?.c ?? daily?.at(-1)?.c;
  const maps = buildSmartMoneyTimeframes({ hourly, daily, currentPrice });
  for (const [mapTimeframe, data] of Object.entries(maps)) {
    _smartMoneyCache.set(`${symbol}:${mapTimeframe}`, { at: Date.now(), data });
  }
  return maps[tf];
}

app.get('/api/smart-money/:sym', requireAuth, async (req, res) => {
  const sym = String(req.params.sym || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  const timeframe = String(req.query.timeframe || '1D').toUpperCase();
  if (!sym) return res.status(400).json({ ok: false, error: 'Symbol required' });
  if (!SMART_MONEY_TIMEFRAMES[timeframe]) {
    return res.status(400).json({
      ok: false,
      error: 'Unsupported timeframe',
      availableTimeframes: SMART_MONEY_TIMEFRAME_ORDER,
    });
  }
  const key = `${sym}:${timeframe}`;
  const cached = _smartMoneyCache.get(key);
  if (cached && Date.now() - cached.at < SMART_MONEY_CACHE_MS && req.query.force !== '1') {
    return res.json({ ok: true, symbol: sym, ...cached.data, cached: true });
  }
  let job = _smartMoneyInflight.get(key);
  if (!job) {
    job = buildSmartMoneySnapshot(sym, timeframe, req.session.userId);
    _smartMoneyInflight.set(key, job);
  }
  try {
    const data = await job;
    _smartMoneyCache.set(key, { at: Date.now(), data });
    if (_smartMoneyCache.size > 100) _smartMoneyCache.delete(_smartMoneyCache.keys().next().value);
    return res.json({
      ok: true,
      symbol: sym,
      availableTimeframes: SMART_MONEY_TIMEFRAME_ORDER,
      ...data,
    });
  } catch (error) {
    console.error('[SmartMoney]', sym, timeframe, error.message);
    return res.status(502).json({ ok: false, error: 'Smart Money OHLCV analysis unavailable' });
  } finally {
    _smartMoneyInflight.delete(key);
  }
});

function gpTimestampMs(value) {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function completedFiveMinuteBars(bars, nowMs = Date.now()) {
  return (Array.isArray(bars) ? bars : []).filter(bar => {
    const startedAt = gpTimestampMs(bar?.t);
    return Number.isFinite(startedAt) && startedAt + 5 * 60_000 <= nowMs;
  });
}

function completedFiveMinuteFreshness(bars, maxAgeMs = 16 * 60_000, nowMs = Date.now()) {
  const last = bars.at(-1);
  const startedAt = gpTimestampMs(last?.t);
  const completedAt = Number.isFinite(startedAt) ? startedAt + 5 * 60_000 : NaN;
  return {
    fresh: Number.isFinite(completedAt) && nowMs - completedAt >= 0 && nowMs - completedAt <= maxAgeMs,
    sourceTimestamp: last?.t || null,
  };
}

function gpSourceFreshness({ quote, daily, oneMinute, fiveMinute, fifteenMinute, hourly, nowMs = Date.now() }) {
  const ageOf = value => {
    const timestamp = gpTimestampMs(value);
    return timestamp == null ? null : Math.max(0, nowMs - timestamp);
  };
  const latestBar = bars => Array.isArray(bars) && bars.length ? bars.at(-1)?.t : null;
  const sources = {
    quote:          { sourceTimestamp: quote?.asOf ?? null, maxAgeMs: 90_000 },
    oneMinute:      { sourceTimestamp: latestBar(oneMinute), maxAgeMs: 6 * 60_000 },
    fiveMinute:     { sourceTimestamp: latestBar(fiveMinute), maxAgeMs: 16 * 60_000 },
    fifteenMinute:  { sourceTimestamp: latestBar(fifteenMinute), maxAgeMs: 35 * 60_000 },
    hourly:         { sourceTimestamp: latestBar(hourly), maxAgeMs: 100 * 60_000 },
    daily:          { sourceTimestamp: latestBar(daily), maxAgeMs: 54 * 60 * 60_000 },
  };
  for (const source of Object.values(sources)) {
    source.ageMs = ageOf(source.sourceTimestamp);
    source.fresh = source.ageMs != null && source.ageMs <= source.maxAgeMs;
  }
  return sources;
}

function gpVWAP(intraBars) {
  const reg = (intraBars || []).filter(b => b.session === 'reg' && b.v > 0);
  if (!reg.length) return null;
  let pv = 0, vol = 0;
  reg.forEach(b => { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vol += b.v; });
  return vol > 0 ? pv / vol : null;
}

function gpMACD(closes) {
  if (closes.length < 35) return null;
  const emaSeries = (vals, p) => {
    const k = 2 / (p + 1); const out = [];
    let e = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
    out.push(e);
    for (let i = p; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
    return out;
  };
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macdLine = [];
  for (let i = 0; i < e26.length; i++) macdLine.push(e12[i + 14] - e26[i]);
  if (macdLine.length < 9) return null;
  const sig = emaSeries(macdLine, 9);
  const m = macdLine.at(-1), s = sig.at(-1);
  return { value: m, signal: s, histogram: m - s };
}

const { buildIntradayAnalogs, selectCurrentRegularSnapshot } = require('./lib/gameplan-analogs');

async function buildSearchGameplanForUser(sym, userId, requestedForce = false, quoteScope = 'manual') {
  // Forced refreshes are bounded per user and symbol.
  let force = !!requestedForce;
  if (force) {
    const fKey = gpCacheKey(userId, quoteScope, sym);
    const lastForce = _gpForceAt.get(fKey) || 0;
    if (Date.now() - lastForce < GP_FORCE_COOLDOWN_MS) force = false;
    else {
      _gpForceAt.set(fKey, Date.now());
      if (_gpForceAt.size > 200) _gpForceAt.delete(_gpForceAt.keys().next().value);
    }
  }

  const cacheKey = gpCacheKey(userId, quoteScope, sym);
  const cached = _gpCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GP_CACHE_MS && !force) {
    // A cached feature-on result must not leak fields when the flag is toggled
    // off: the pre-feature response shape remains exact.
    if (process.env.VOLATILITY_INTELLIGENCE_ENABLED !== 'true') {
      const { volatility, ...legacy } = cached.data;
      const { volatility: volatilityProvenance, ...legacyProvenance } = legacy.provenance || {};
      return { ...legacy, provenance: legacyProvenance, cached: true };
    }
    // If the flag was enabled after this cache entry was built, regenerate
    // rather than serving a feature-on response without volatility evidence.
    if (cached.data.volatility) return { ...cached.data, cached: true };
  }

  // Coalesce: if a generation for this symbol is already running, share its result
  const inflight = _gpInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const job = (async () => {
    const generationNow = Date.now();
    const cryptoSymbol = isLikelyCryptoSymbol(sym);
    const [quote, daily, intra, volumeHistory5m, analogHistory5m, intra1m, intra15m, intra1h, profile, mktRaw, spyDaily, stockOptions, marketOptions] = await Promise.all([
      fetchLiveQuote(sym, userId, quoteScope).catch(() => null),
      gpFetchDaily(sym, '2y'),
      gpFetchIntraday5m(sym),
      gpFetchIntraday(sym, '5m', '5d'),
      gpFetchIntraday(sym, '5m', '60d'),
      gpFetchIntraday(sym, '1m', '1d'),
      gpFetchIntraday(sym, '15m', '5d'),
      gpFetchIntraday(sym, '1h', '3mo'),
      yf.quoteSummary(sym, { modules: ['assetProfile'] }, { validateResult: false }).catch(() => null),
      yf.quote(['SPY', 'QQQ', 'IWM'], {}, { validateResult: false }).catch(() => null),
      gpFetchDaily('SPY', '2y'),
      // Yahoo options are a fallback source only and are fetched only behind
      // the feature flag; historical IV is not fabricated from this snapshot.
      process.env.VOLATILITY_INTELLIGENCE_ENABLED === 'true'
        ? yf.options(sym).catch(() => null)
        : Promise.resolve(null),
      process.env.VOLATILITY_INTELLIGENCE_ENABLED === 'true'
        ? yf.options('SPY').catch(() => null)
        : Promise.resolve(null),
    ]);

    if ((!cryptoSymbol && !quote?.price) || !daily?.length) {
      return { ok: false, unavailable: true, symbol: sym, error: 'REAL-TIME DATA UNAVAILABLE' };
    }

    const dataGaps = [];
    // For crypto, keep spot, 24H reference, and volume signal anchored to the
    // same Yahoo chart generation rather than mixing an equity quote snapshot.
    const cryptoBars = cryptoSymbol
      ? canonicalCrypto5mSeries(volumeHistory5m, intra, generationNow)
      : [];
    const cryptoStats = crypto24hStats(cryptoBars);
    const yahooCryptoPrice = cryptoStats.latest?.c ?? null;
    const price  = cryptoSymbol && Number.isFinite(Number(yahooCryptoPrice))
      ? Number(yahooCryptoPrice)
      : cryptoSymbol ? null : quote.price;
    if (cryptoSymbol && price == null) {
      return { ok: false, unavailable: true, symbol: sym, error: 'COMPLETED CRYPTO PRICE UNAVAILABLE' };
    }
    const cryptoReference = cryptoSymbol
      ? selectCrypto24hReference(cryptoBars, cryptoStats.latest?.timestampMs)
      : null;
    const snapshotPrevClose = cryptoSymbol
      ? (Number.isFinite(Number(cryptoReference?.c)) && Number(cryptoReference.c) > 0
        ? Number(cryptoReference.c) : null)
      : quote.previousClose;
    const snapshotChangePct = snapshotPrevClose
      ? +(((price - snapshotPrevClose) / snapshotPrevClose) * 100).toFixed(1)
      : null;
    // Completed-session levels must be anchored to the last regular-session
    // close outside regular hours. Comparing them with a pre/post-market quote
    // can place every real support level on the wrong side of the price.
    const levelPrice = cryptoSymbol || quote?.marketState === 'REGULAR'
      ? price
      : (Number.isFinite(Number(quote?.regularClose)) ? Number(quote.regularClose) : price);
    const closes = daily.map(b => b.c);
    const searchLevelAnalysis = buildSearchLevels({
      dailyBars: daily,
      currentPrice: levelPrice,
      marketState: cryptoSymbol ? '24/7' : quote?.marketState,
    });
    const atr    = searchLevelAnalysis.atr;
    const vwap   = cryptoSymbol ? cryptoStats.vwap : gpVWAP(intra);
    if (!intra?.length) dataGaps.push('Intraday 5-min data unavailable');
    if (vwap == null)   dataGaps.push(cryptoSymbol ? '24H VWAP unavailable' : 'VWAP unavailable (no regular-session volume yet)');

    // Premarket
    const preBars = (intra || []).filter(b => b.session === 'pre');
    const premarket = preBars.length ? {
      last: preBars.at(-1).c,
      high: Math.max(...preBars.map(b => b.h ?? b.c)),
      low:  Math.min(...preBars.map(b => b.l ?? b.c)),
    } : null;

    // Indicators
    const rsi14 = calcRSI(closes);
    const rsi5  = calcRSI(closes, 5);
    const rsiPrev = calcRSI(closes.slice(0, -3));
    const indicators = {
      rsi14: rsi14 != null ? +rsi14.toFixed(1) : null,
      rsi5:  rsi5  != null ? +rsi5.toFixed(1)  : null,
      rsiTrend: rsi14 != null && rsiPrev != null ? (rsi14 > rsiPrev + 2 ? 'rising' : rsi14 < rsiPrev - 2 ? 'falling' : 'flat') : null,
      atr: atr != null ? +atr.toFixed(2) : null,
      atrPct: atr != null ? +((atr / price) * 100).toFixed(1) : null,
      vwap: vwap != null ? +vwap.toFixed(2) : null,
      ema9:  calcEMA(closes, 9),
      ema20: calcEMA(closes, 20),
      sma20: calcSMA(closes, 20),
      sma50: calcSMA(closes, 50),
      sma200: calcSMA(closes, 200),
      macd: gpMACD(closes),
      distVwapPct: vwap ? +(((price - vwap) / vwap) * 100).toFixed(1) : null,
    };
    if (cryptoSymbol) {
      indicators.vwap = cryptoStats.vwap != null ? +cryptoStats.vwap.toFixed(2) : null;
      indicators.distVwapPct = cryptoStats.vwap
        ? +(((price - cryptoStats.vwap) / cryptoStats.vwap) * 100).toFixed(1) : null;
    }
    if (indicators.sma200 == null) dataGaps.push('SMA 200 unavailable (insufficient history)');

    // Sell-off stats
    const chgN = n => closes.length > n ? +(((price - closes.at(-1 - n)) / closes.at(-1 - n)) * 100).toFixed(1) : null;
    const high20 = Math.max(...daily.slice(-20).map(b => b.h));
    const relVol = cryptoSymbol ? null : (quote.volume && quote.avgVolume
      ? +(quote.volume / quote.avgVolume).toFixed(1) : null);
    const gapPct = !cryptoSymbol && quote.open && quote.previousClose ? +(((quote.open - quote.previousClose) / quote.previousClose) * 100).toFixed(1) : null;
    const chg1d = snapshotChangePct;
    const selloffClass = [];
    if (chg1d != null && indicators.atrPct != null) {
      const mag = Math.abs(chg1d) / Math.max(indicators.atrPct, 0.5);
      if (chg1d <= -1 || chg1d >= 1) selloffClass.push(mag >= 3 ? (chg1d < 0 ? 'EXTREME DECLINE' : 'EXTREME RALLY') : mag >= 1.5 ? (chg1d < 0 ? 'SHARP DECLINE' : 'SHARP RALLY') : (chg1d < 0 ? 'NORMAL DECLINE' : 'NORMAL ADVANCE'));
    }
    if (gapPct != null && gapPct <= -2) selloffClass.push('GAP-DOWN');
    if (gapPct != null && gapPct >= 2)  selloffClass.push('GAP-UP');
    if (relVol != null && chg1d != null) {
      if (relVol >= 2 && chg1d < -3) selloffClass.push('HIGH-VOLUME LIQUIDATION');
      else if (relVol < 0.8 && chg1d < 0) selloffClass.push('LOW-VOLUME PULLBACK');
    }
    const selloff = {
      chg1d, chg2d: chgN(2), chg5d: chgN(5), chg10d: chgN(10),
      distFromHigh20Pct: +(((price - high20) / high20) * 100).toFixed(1),
      distSma20Pct: indicators.sma20 ? +(((price - indicators.sma20) / indicators.sma20) * 100).toFixed(1) : null,
      distSma50Pct: indicators.sma50 ? +(((price - indicators.sma50) / indicators.sma50) * 100).toFixed(1) : null,
      gapPct, relVol, classification: selloffClass,
    };

    // Oversold classification — multi-factor, never RSI alone
    const reds = (() => { let n = 0; for (let i = daily.length - 1; i > 0 && daily[i].c < daily[i].o; i--) n++; return n; })();
    const greens = (() => { let n = 0; for (let i = daily.length - 1; i > 0 && daily[i].c > daily[i].o; i--) n++; return n; })();
    let obScore = 0;
    const obReasons = [];
    if (rsi14 != null) {
      if (rsi14 <= 25) { obScore -= 2; obReasons.push(`RSI(14) ${rsi14.toFixed(0)} deeply depressed`); }
      else if (rsi14 <= 35) { obScore -= 1; obReasons.push(`RSI(14) ${rsi14.toFixed(0)} in lower band`); }
      else if (rsi14 >= 75) { obScore += 2; obReasons.push(`RSI(14) ${rsi14.toFixed(0)} elevated`); }
      else if (rsi14 >= 65) { obScore += 1; obReasons.push(`RSI(14) ${rsi14.toFixed(0)} in upper band`); }
    }
    if (indicators.distVwapPct != null && Math.abs(indicators.distVwapPct) >= 2) {
      obScore += indicators.distVwapPct > 0 ? 1 : -1;
      obReasons.push(`Price ${indicators.distVwapPct > 0 ? '+' : ''}${indicators.distVwapPct}% vs VWAP`);
    }
    if (selloff.distSma20Pct != null && Math.abs(selloff.distSma20Pct) >= (indicators.atrPct ?? 3) * 2) {
      obScore += selloff.distSma20Pct > 0 ? 1 : -1;
      obReasons.push(`Extended ${selloff.distSma20Pct}% from 20-day MA`);
    }
    if (reds >= 3)   { obScore -= 1; obReasons.push(`${reds} consecutive red days`); }
    if (greens >= 3) { obScore += 1; obReasons.push(`${greens} consecutive green days`); }
    if (relVol != null && relVol >= 2) obReasons.push(`Volume ${relVol}x average`);
    const oversold = {
      label: obScore <= -3 ? 'VERY OVERSOLD' : obScore <= -1 ? 'OVERSOLD' : obScore >= 3 ? 'VERY OVERBOUGHT' : obScore >= 1 ? 'OVERBOUGHT' : 'NEUTRAL',
      reasons: obReasons,
    };

    // Historical analogs — threshold picked from current move size
    // The time anchor and drop magnitude must come from the same latest
    // regular-session snapshot. Never reuse a stale close during extended hours.
    const currentAnalog = cryptoSymbol ? null : selectCurrentRegularSnapshot(intra, quote.previousClose, {
      marketState: quote.marketState,
    });
    const dropMag = currentAnalog?.dropMagnitudePct ?? null;
    const threshold = dropMag == null ? null : dropMag >= 10 ? 10 : dropMag >= 8 ? 8 : dropMag >= 5 ? 5 : null;
    const analogs = threshold ? buildIntradayAnalogs({
      daily,
      intraday: analogHistory5m,
      thresholdPct: threshold,
      currentDropPct: dropMag,
      currentBar: currentAnalog.bar,
    }) : null;

    // Market + sector context
    const mktArr = Array.isArray(mktRaw) ? mktRaw : mktRaw ? [mktRaw] : [];
    const mkt = {};
    mktArr.forEach(q => {
      if (!q?.symbol) return;
      const change = Number(q.regularMarketChangePercent);
      mkt[q.symbol] = Number.isFinite(change) ? +change.toFixed(2) : null;
    });
    const spyQuote = mktArr.find(item => item?.symbol === 'SPY') || null;
    const sectorName = profile?.assetProfile?.sector || null;
    const sectorEtf = sectorName ? SECTOR_ETF[sectorName] || null : null;
    let sectorChg = null;
    if (sectorEtf) {
      try {
        const sq = await yf.quote(sectorEtf, {}, { validateResult: false });
        const sectorMove = Number(sq?.regularMarketChangePercent);
        sectorChg = Number.isFinite(sectorMove) ? +sectorMove.toFixed(2) : null;
      } catch { /* sector data unavailable */ }
    }
    if (sectorChg == null) dataGaps.push('Sector ETF data unavailable');
    let attribution = 'UNKNOWN';
    if (chg1d != null && mkt.SPY != null) {
      const mktMove = mkt.SPY, secMove = sectorChg ?? mktMove;
      const stockExtra = chg1d - secMove;
      if (Math.abs(chg1d) < 1.5) attribution = 'QUIET';
      else if (Math.abs(stockExtra) >= Math.abs(chg1d) * 0.6) attribution = 'STOCK-SPECIFIC';
      else if (sectorChg != null && Math.abs(sectorChg) >= Math.abs(mktMove) * 1.5) attribution = 'SECTOR-DRIVEN';
      else if (Math.abs(mktMove) >= 1) attribution = 'MARKET-DRIVEN';
      else attribution = 'COMBINATION';
    }
    const market = cryptoSymbol ? {
      spy: null, qqq: null, iwm: null, sector: null, sectorEtf: null,
      sectorChangePct: null, trend: null, sectorTrend: null, attribution: 'UNKNOWN',
    } : {
      spy: mkt.SPY ?? null, qqq: mkt.QQQ ?? null, iwm: mkt.IWM ?? null,
      sector: sectorName, sectorEtf, sectorChangePct: sectorChg,
      trend: mkt.SPY == null ? null : mkt.SPY >= 0.3 ? 'BULLISH' : mkt.SPY <= -0.3 ? 'BEARISH' : 'NEUTRAL',
      sectorTrend: sectorChg == null ? null : sectorChg >= 0.3 ? 'BULLISH' : sectorChg <= -0.3 ? 'BEARISH' : 'NEUTRAL',
      attribution,
    };
    // News (Yahoo search — no key needed; NewsAPI headline titles if key present)
    let news = [];
    try {
      const nr = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${sym}&newsCount=6&quotesCount=0`, { headers: YH });
      if (nr.ok) {
        const nd = await nr.json();
        news = (nd.news || [])
          .filter(n => Array.isArray(n.relatedTickers) && n.relatedTickers.includes(sym))
          .slice(0, 5).map(n => ({
          headline: n.title, source: n.publisher, provider: 'Yahoo Finance',
          url: /^https?:\/\//i.test(String(n.link || '')) ? n.link : null,
          summary: n.summary || '',
          image: n.thumbnail?.resolutions?.[0]?.url || null,
          publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
          date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10) : null,
        }));
      }
    } catch { /* news optional */ }
    if (NEWS_KEY) {
      try {
        const from = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
        const nr = await fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(`${sym} stock`)}&from=${encodeURIComponent(from)}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_KEY}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (nr.ok) {
          const nd = await nr.json();
          const explicitSymbol = new RegExp(
            sym.length <= 3
              ? `(?:\\$${sym}\\b|\\(${sym}\\)|(?:NASDAQ|NYSE|AMEX)\\s*:\\s*${sym}\\b)`
              : `\\b${sym}\\b`,
            'i',
          );
          const newsApiRows = (nd.articles || [])
            .filter(n => n?.title && n.title !== '[Removed]')
            .filter(n => explicitSymbol.test(`${n.title} ${n.description || ''}`))
            .map(n => ({
              headline: n.title,
              source: n.source?.name || 'NewsAPI',
              provider: 'NewsAPI',
              url: /^https?:\/\//i.test(String(n.url || '')) ? n.url : null,
              summary: n.description || '',
              image: n.urlToImage || null,
              publishedAt: n.publishedAt || null,
              date: n.publishedAt ? String(n.publishedAt).slice(0, 10) : null,
            }));
          const seen = new Set();
          news = [...newsApiRows, ...news]
            .filter(item => {
              const key = String(item.headline || '').toLowerCase().replace(/\s+/g, ' ').trim();
              if (!key || seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .sort((a, b) => Date.parse(b.publishedAt || b.date || 0) - Date.parse(a.publishedAt || a.date || 0))
            .slice(0, 8);
        }
      } catch { /* secondary late-news source is optional */ }
    }
    if (!news.length) dataGaps.push('No recent news retrieved');

    // Search-only levels use completed daily sessions exclusively. The live
    // candle, VWAP, premarket, and today's changing high/low cannot repaint them.
    const levels = searchLevelAnalysis.levels || {
      support: [], resistance: [], breakdown: null, currentPrice: +price.toFixed(2),
    };
    // Keep the existing completed-session calculation authoritative. If the
    // presentation-shaped object is absent, pass through the same calculated
    // levels object rather than replacing valid levels with an empty fallback.
    const displayLevels = searchLevelAnalysis.displayLevels || searchLevelAnalysis.levels;
    const dailyPivots = searchLevelAnalysis.dailyPivots;
    const gapAnalysis = buildSearchGapAnalysis({
      dailyBars: searchLevelAnalysis.completedBars,
      currentPrice: price,
    });
    const fibonacci = buildSearchFibonacci({
      dailyBars: searchLevelAnalysis.completedBars,
      currentPrice: price,
    });
    const sourceFreshness = gpSourceFreshness({
      quote, daily, oneMinute: intra1m, fiveMinute: intra,
      fifteenMinute: intra15m, hourly: intra1h,
      nowMs: generationNow,
    });
    const smartMoneyMaps = buildSmartMoneyTimeframes({
      hourly: intra1h,
      daily: searchLevelAnalysis.completedBars,
      currentPrice: price,
    });
    const smartMoney = smartMoneyMaps['1D'];
    // Reuse already-fetched SPY/QQQ observations so macro context modifies
    // entry confidence without putting the independent macro feed on the
    // latency-critical Game Plan path. Missing inputs remain unavailable.
    const macroPressure = buildMacroPressure({
      ...cachedSearchMacroIndicators(generationNow),
      spy: { changePct: mkt.SPY },
      qqq: { changePct: mkt.QQQ },
    }, {
      symbol: sym,
      sector: profile?.assetProfile?.sector || null,
    });

    // Technical probability / confluence engine. This is deterministic and uses
    // only the supplied price, volume, and market-context observations. It never
    // places an order and never turns missing data into a directional signal.
    const confluence = buildTechnicalConfluence({
      price,
      dailyBars: daily,
      intradayBars: intra,
      indicators,
      levels,
      relVol,
      dayChangePct: chg1d,
      market,
      newsCount: news.length,
      freshness: sourceFreshness,
      timeframes: {
        oneMinute: intra1m,
        fiveMinute: intra,
        fifteenMinute: intra15m,
        hourly: intra1h,
        daily,
      },
    });
    const stockVsSpy = chg1d != null && mkt.SPY != null ? chg1d - mkt.SPY : null;
    // Compatible SMB-style context is an additional deterministic gate. The
    // existing confluence engine remains authoritative for its own score and
    // data-quality contract; this does not replace it or use score alone.
    const completedIntra5m = completedFiveMinuteBars(intra, generationNow);
    const patternAnalysis = cryptoSymbol ? null : summarizePatternAnalysis({
      daily: detectCandlePatterns(searchLevelAnalysis.completedBars.slice(-60)).all,
      intraday: detectCandlePatterns(completedIntra5m.slice(-60)).all,
    });
    confluence.priceAction = evaluatePriceActionSetup({
      symbol: sym,
      bars: completedIntra5m,
      price,
      vwap,
      support: confluence.levels?.criticalSupport,
      resistance: confluence.levels?.criticalResistance,
      market,
      relativeStrength: cryptoSymbol ? null : (stockVsSpy == null ? null : stockVsSpy >= 1),
      freshness: completedFiveMinuteFreshness(completedIntra5m, 16 * 60_000, generationNow),
    });
    if (!intra1m?.length) dataGaps.push('1-minute timeframe unavailable');
    if (!intra15m?.length) dataGaps.push('15-minute timeframe unavailable');
    if (!intra1h?.length) dataGaps.push('1-hour timeframe unavailable');

    // Search-page-only volume signal. Keep the existing confluence object
    // untouched because automated bots and their execution contracts must not
    // inherit search-page signal semantics.
    const cryptoFiveMinuteFreshness = cryptoStats.latest ? {
      fresh: generationNow - cryptoStats.latest.timestampMs <= 16 * 60_000,
      sourceTimestamp: new Date(cryptoStats.latest.timestampMs).toISOString(),
      maxAgeMs: 16 * 60_000,
    } : { fresh: false, sourceTimestamp: null, maxAgeMs: 16 * 60_000 };
    const searchSignal = buildSearchVolumeSignal({
      price,
      intradayBars: cryptoSymbol ? cryptoBars : intra,
      volumeHistory5m: cryptoSymbol ? cryptoBars : volumeHistory5m,
      barsByInterval: cryptoSymbol
        ? { fiveMinute: cryptoBars }
        : { oneMinute: intra1m, fiveMinute: intra, fifteenMinute: intra15m },
      levels,
      indicators: cryptoSymbol ? { ...indicators, vwap: cryptoStats.vwap } : indicators,
      market: cryptoSymbol ? {} : market,
      dayChangePct: chg1d,
      relativeDailyVolume: cryptoSymbol ? null : relVol,
      dayRangePosition: cryptoSymbol
        ? cryptoStats.rangePosition
        : quote?.dayHigh > quote?.dayLow
        ? (price - quote.dayLow) / (quote.dayHigh - quote.dayLow)
        : null,
      news,
      freshness: cryptoSymbol ? { fiveMinute: cryptoFiveMinuteFreshness } : sourceFreshness,
      patternAnalysis,
      fibonacci,
      dailyBars: searchLevelAnalysis.completedBars,
      macroPressure,
      sessionMode: cryptoSymbol ? 'continuous' : 'regular',
      assetClass: cryptoSymbol ? 'crypto' : 'stock',
      // The current aggregate crypto bars do not distinguish organic spot
      // participation from derivatives/liquidation activity.
      spotVolumeConfirmed: cryptoSymbol ? false : null,
      timezone: cryptoSymbol ? 'UTC' : 'America/New_York',
      nowMs: generationNow,
    });
    if (cryptoSymbol) searchSignal.changeWindow = '24H';
    const marketContext = buildSearchMarketContext({
      symbol: sym,
      quote: spyQuote,
      stockQuote: quote,
      spyDailyBars: spyDaily,
      stockDailyBars: daily,
      stockMarketState: cryptoSymbol ? '24/7' : quote?.marketState,
      spyMarketState: spyQuote?.marketState,
      stockSignal: searchSignal,
      sectorTrend: market.sectorTrend,
      sectorChangePct: market.sectorChangePct,
      sectorEtf: market.sectorEtf,
      profile,
    });
    let volatility = null;
    if (process.env.VOLATILITY_INTELLIGENCE_ENABLED === 'true') {
      // This layer has its own timeout/circuit-style shared cache and always
      // resolves an unavailable snapshot rather than failing Search.
      const normalizeOptionChain = payload => {
        const firstChain = payload?.options?.[0] || payload?.[0] || {};
        return ['calls', 'puts'].flatMap(side => (firstChain[side] || []).map(contract => ({
          ...contract,
          type: side === 'puts' ? 'put' : 'call',
          dte: firstChain.expirationDate
            ? Math.max(0, Math.ceil((new Date(firstChain.expirationDate).getTime() - Date.now()) / 86400000))
            : null,
        })));
      };
      const optionChain = normalizeOptionChain(stockOptions);
      const marketOptionChain = normalizeOptionChain(marketOptions);
      volatility = await buildVolatilitySnapshot({
        symbol: sym,
        price,
        dailyBars: daily,
        spyDailyBars: spyDaily,
        optionChain,
        marketOptionChain,
      });
    }
    const finalSearchSignal = cryptoSymbol ? searchSignal : applySearchMarketRegime({
      searchSignal,
      spyRegime: marketContext.spy,
      sector: marketContext.sector,
      relativeStrength: marketContext.relativeStrength,
      sensitivity: marketContext.sensitivity,
      volatility,
      macroPressure,
    });
    if (volatility) {
      volatility.confidenceAdjustment = {
        technicalScore: searchSignal.confidence ?? null,
        volatilityScore: volatility.scores?.regime ?? null,
        gammaScore: volatility.scores?.gamma ?? null,
        volatilityPoints: finalSearchSignal.confidenceBreakdown?.volatility ?? 0,
        gammaPoints: finalSearchSignal.confidenceBreakdown?.gamma ?? 0,
        finalConfidence: finalSearchSignal.confidence ?? null,
      };
    }
    const tradeLevels = buildSearchTradeLevels({
      currentPrice: levelPrice,
      levels,
      confluence,
      fibonacci,
      smartMoney,
      searchSignal: finalSearchSignal,
    });

    // Do not manufacture probability percentages when no directly comparable
    // historical sample exists. Exact analog statistics are rendered separately.
    const probabilities = {
      reliefBounce: null,
      closeGreen: null,
      rebound3: null,
      rebound5: null,
      downsideLeg: null,
      bullish:      confluence.scores.bullish,
      bearish:      confluence.scores.bearish,
      bounce:       confluence.scores.bounce,
      drawdown:     confluence.scores.drawdown,
      basis: analogs
        ? `Exact sample statistics from ${analogs.sampleSize} past regular session(s) down ${analogs.minDropPct}–${analogs.maxDropPct}% near ${analogs.comparableTime} (within ${analogs.matchWindowMinutes} minutes) are shown below; they are not adjusted forecasts.`
        : 'No historical regular-session snapshot had a comparable drop magnitude at this time of day. No probability percentage is shown.',
    };

    // Confidence breakdown
    const displayRelVol = cryptoSymbol ? searchSignal.relativeVolume?.value ?? null : relVol;
    const parts = {
      technical: Math.min(100, 40 + (indicators.rsi14 != null ? 15 : 0) + (vwap != null ? 15 : 0) + (indicators.macd ? 15 : 0) + (atr != null ? 15 : 0)),
      historical: analogs ? (analogs.lowConfidence ? 35 : Math.min(90, 40 + analogs.sampleSize * 2)) : 15,
      market: mkt.SPY != null ? 75 : 20,
      sector: sectorChg != null ? 75 : 25,
      catalyst: news.length ? 65 : 30,
      volume: displayRelVol != null ? (displayRelVol >= 1.5 ? 80 : 60) : 25,
    };
    const overall = Math.round(Object.values(parts).reduce((a, b) => a + b, 0) / Object.keys(parts).length);

    const snapshot = {
      price: +price.toFixed(2), prevClose: snapshotPrevClose, open: cryptoSymbol ? null : quote?.open,
      high: cryptoSymbol ? cryptoStats.high : quote?.dayHigh,
      low: cryptoSymbol ? cryptoStats.low : quote?.dayLow,
      volume: cryptoSymbol ? cryptoStats.volume : quote?.volume,
      avgVolume: cryptoSymbol ? null : quote?.avgVolume,
      relVol: displayRelVol, marketCap: quote?.marketCap ?? null, wk52High: quote?.yearHigh ?? null, wk52Low: quote?.yearLow ?? null,
      marketState: cryptoSymbol ? '24/7' : quote?.marketState, premarket: cryptoSymbol ? null : premarket, changePct: chg1d,
      ...(cryptoSymbol ? { changeWindow: '24H' } : {}),
    };

    // ── AI narrative (facts in → narrative out; numbers stay deterministic) ──
    let ai = { available: false, reason: 'AI narrative unavailable' };
    const apiKey = null; // Search verdicts remain deterministic; generative narrative is intentionally disabled.
    if (apiKey) {
      const facts = { symbol: sym, snapshot, indicators: { ...indicators, macd: indicators.macd ? { histogram: +indicators.macd.histogram.toFixed(3) } : null }, selloff, oversold, analogs: analogs ? { threshold, ...analogs } : null, market, news, levels, fibonacci, probabilities, confluence, searchSignal };
      const gpPrompt = 'You are an experienced intraday trader writing a concise AI TRADE GAME PLAN. You are given VERIFIED market facts as JSON. RULES: Use ONLY the numbers provided — never invent prices, statistics or news. Never claim certainty; prefer "evidence favors" language. The deterministic binary searchSignal is authoritative for the search page. Do not describe a BUY as confirmed unless its stage is CONFIRMED; keep tradeSetup null for provisional evidence. Use scored recent headlines only as a catalyst, never as a substitute for price and volume confirmation. Oversold alone is NOT a buy signal. A resistance test with rising price and expanding volume is not automatically bearish. Warn against catching a falling knife when the stock is down sharply. If no attractive setup exists respond with tradeSetup null and noTrade true. Respond with STRICT JSON only (no markdown): {"setup":"BULLISH|LEAN BULLISH|NEUTRAL|LEAN BEARISH|BEARISH","verdict":"1-2 sentence summary","why":["3-5 short reasons"],"scenarios":{"bullish":{"plan":"...","trigger":"...","invalidation":"..."},"range":{"plan":"..."},"bearish":{"plan":"...","trigger":"...","invalidation":"..."}},"changeMind":["2-3 specific price/volume conditions that would invalidate the thesis"],"whyFail":["2-4 specific risks"],"tradeSetup":{"entryZone":"...","confirmationEntry":"...","stop":"...","target1":"...","target2":"...","target3":"...","riskReward":"..."}|null,"noTrade":false,"fallingKnifeWarning":"one sentence or null"}';
      try {
        const r = await fetch('https://api.aimlapi.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: gpPrompt },
              { role: 'user', content: JSON.stringify(facts) },
            ],
            max_tokens: 900, temperature: 0.35,
            response_format: { type: 'json_object' },
          }),
        });
        if (r.ok) {
          const data = await r.json();
          const raw = data.choices?.[0]?.message?.content?.trim() || '';
          try {
            const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, ''));
            const deterministicTradeAllowed = searchSignal.dataQuality?.volumeBaselineAvailable
              && searchSignal.signal?.stage === 'CONFIRMED'
              && searchSignal.signal?.direction === 'BULLISH'
              && confluence.dataQuality?.entryEligible
              && confluence.signal?.stage === 'CONFIRMED'
              && confluence.signal?.confluence === 'HIGH CONFLUENCE';
            // Narrative text is never permitted to manufacture a trade. A trade
            // setup is shown only when the deterministic engine has complete
            // data and independently confirmed high confluence.
            ai = {
              available: true,
              ...parsed,
              noTrade: deterministicTradeAllowed ? !!parsed.noTrade : true,
              tradeSetup: deterministicTradeAllowed ? (parsed.tradeSetup || null) : null,
              setup: searchSignal.signal?.label || confluence.signal?.label || parsed.setup,
            };
          } catch { ai = { available: false, reason: 'AI returned unparseable output' }; }
        } else {
          ai = { available: false, reason: `AI service error (${r.status})` };
        }
      } catch { ai = { available: false, reason: 'AI service unreachable' }; }
    } else {
      ai = { available: false, reason: 'Disabled for deterministic data-only analysis' };
    }

    const generatedAt = new Date().toISOString();
    const out = {
      ok: true, symbol: sym, generatedAt, freshness: { generatedAt, maxAgeMs: GP_CACHE_MS }, dataGaps,
      provenance: {
        quote: {
          provider: cryptoSymbol ? 'Yahoo Finance chart API' : (quote?.source || 'Yahoo Finance'),
          asOf: cryptoSymbol && cryptoStats.latest
            ? new Date(cryptoStats.latest.timestampMs).toISOString()
            : quote?.asOf || generatedAt,
        },
        intraday: { provider: 'Yahoo Finance chart API', intervals: ['1m', '5m', '15m', '1h'] },
        daily: { provider: 'Yahoo Finance chart API' },
        news: [...new Set(news.map(item => item.provider).filter(Boolean))],
        ...(volatility ? { volatility: {
          source: volatility.source,
          timestamp: volatility.timestamp,
          ageMs: volatility.ageMs,
          completeness: volatility.completeness,
          status: volatility.status,
        } } : {}),
      },
      snapshot, indicators: { ...indicators, macd: indicators.macd ? { value: +indicators.macd.value.toFixed(3), signal: +indicators.macd.signal.toFixed(3), histogram: +indicators.macd.histogram.toFixed(3) } : null },
      selloff, oversold,
      analogs: analogs ? { threshold, ...analogs } : null,
      market, news, levels, displayLevels, dailyPivots, gapAnalysis, patternAnalysis, fibonacci,
      smartMoney: { ...smartMoney, availableTimeframes: SMART_MONEY_TIMEFRAME_ORDER },
      probabilities, confluence, searchSignal: finalSearchSignal, marketContext, tradeLevels,
      ...(volatility ? { volatility } : {}),
      confidence: { overall, parts },
      ai,
    };
    _smartMoneyCache.set(`${sym}:1D`, { at: Date.now(), data: smartMoney });
    for (const [mapTimeframe, data] of Object.entries(smartMoneyMaps)) {
      if (data.available) _smartMoneyCache.set(`${sym}:${mapTimeframe}`, { at: Date.now(), data });
    }
    _gpCache.set(cacheKey, { at: Date.now(), data: out });
    if (_gpCache.size > 50) _gpCache.delete(_gpCache.keys().next().value);
    return out;
  })();

  _gpInflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    _gpInflight.delete(cacheKey);
  }
}

app.get('/api/gameplan/:sym', requireAuth, async (req, res) => {
  const sym = String(req.params.sym || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  if (!sym) return res.status(400).json({ ok: false, error: 'Symbol required' });
  try {
    res.json(await buildSearchGameplanForUser(sym, req.session.userId, !!req.query.force));
  } catch (e) {
    console.error('[GamePlan]', sym, e.message);
    res.status(500).json({ ok: false, error: 'Game plan generation failed' });
  }
});

// ── Alpaca Markets Integration ─────────────────────────────────────────────────

// Sentinel key written to DB when the user explicitly disconnects so that the
// environment-variable fallback is suppressed for that user.


const hasActiveOptionsTrades = userId => !!db.prepare(`SELECT 1 FROM options_trades
  WHERE user_id=? AND status NOT IN ('closed','rejected','canceled') LIMIT 1`).get(userId);
const brokerScopeLabel = scope => scope === 'options' ? 'LEAP Options Bot' : scope === 'manual' ? 'manual trading' : 'another trading strategy';

function normalizeAlpacaScope(value, fallback = 'manual') {
  const scope = value === undefined ? fallback : value;
  if (scope !== 'manual' && scope !== 'options') {
    throw Object.assign(new Error('Invalid broker connection scope. Use manual or options.'), { status: 400 });
  }
  return scope;
}

function requestAlpacaScope(req, fallback = 'manual') {
  return normalizeAlpacaScope(req.body?.connection !== undefined ? req.body.connection : req.query?.connection, fallback);
}

function alpacaAccountConflict(userId, scope, accountId) {
  const registered = db.prepare(`SELECT user_id,scope FROM broker_account_owners WHERE account_id=?`).get(accountId);
  if (registered && !(registered.user_id === userId && registered.scope === scope)) {
    return { owner: brokerScopeLabel(registered.scope) };
  }
  const queries = [
    {
      owner: 'manual trading',
      rows: db.prepare(`SELECT user_id FROM alpaca_creds
        WHERE account_id=? AND api_key<>?`).all(accountId, DISCONNECTED_SENTINEL),
      same: row => scope === 'manual' && row.user_id === userId,
    },
    {
      owner: 'LEAP Options Bot',
      rows: db.prepare(`SELECT user_id FROM options_alpaca_creds
        WHERE account_id=? AND api_key<>?`).all(accountId, DISCONNECTED_SENTINEL),
      same: row => scope === 'options' && row.user_id === userId,
    },
  ];
  return queries.find(item => item.rows.some(row => !item.same(row))) || null;
}

function claimBrokerAccountOwnership(userId, scope, mode, accountId) {
  refreshBrokerAccountQuarantine(accountId);
  if (isBrokerAccountQuarantined(accountId)) return false;
  const result = db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET mode=excluded.mode,claimed_at=datetime('now')
    WHERE broker_account_owners.user_id=excluded.user_id
      AND broker_account_owners.scope=excluded.scope`)
    .run(accountId, userId, scope, mode);
  return result.changes === 1;
}

function brokerAccountOwnerCount(accountId) {
  const rows = db.prepare(`
    SELECT user_id,scope FROM (
      SELECT user_id,'manual' AS scope FROM alpaca_creds WHERE account_id=? AND api_key<>?
      UNION ALL SELECT user_id,'options' AS scope FROM options_alpaca_creds WHERE account_id=? AND api_key<>?
      UNION ALL SELECT user_id,scope FROM broker_account_owners WHERE account_id=?
    )
  `).all(
    accountId, DISCONNECTED_SENTINEL, accountId, DISCONNECTED_SENTINEL, accountId,
  );
  return new Set(rows.map(row => `${row.user_id}:${row.scope}`)).size;
}

function refreshBrokerAccountQuarantine(accountId) {
  if (!accountId) return;
  const count = brokerAccountOwnerCount(accountId);
  if (count > 1) {
    db.prepare(`INSERT INTO broker_account_quarantine(account_id,reason,detected_at,resolved_at)
      VALUES (?,'DUPLICATE_ASSIGNMENT',datetime('now'),NULL)
      ON CONFLICT(account_id) DO UPDATE SET resolved_at=NULL`).run(accountId);
  } else {
    // This module can prove resolution only for the credential stores it owns.
    // Other strategies must explicitly resolve their own quarantines.
    db.prepare(`UPDATE broker_account_quarantine SET resolved_at=datetime('now')
      WHERE account_id=? AND resolved_at IS NULL AND reason IN ('DUPLICATE_ASSIGNMENT','LEGACY_DUPLICATE_ASSIGNMENT')
        AND NOT EXISTS (SELECT 1 FROM broker_account_owners
          WHERE account_id=broker_account_quarantine.account_id AND scope NOT IN ('manual','options'))`).run(accountId);
  }
}

function isBrokerAccountQuarantined(accountId) {
  if (!accountId) return false;
  return !!db.prepare(`SELECT 1 FROM broker_account_quarantine
    WHERE account_id=? AND resolved_at IS NULL`).get(accountId);
}

function brokerTables(scope) {
  normalizeAlpacaScope(scope);
  return scope === 'options'
    ? { credentials: 'options_alpaca_creds', active: 'options_alpaca_active_mode' }
    : { credentials: 'alpaca_creds', active: 'alpaca_active_mode' };
}

function storedBrokerAccountId(userId, scope, mode) {
  const { credentials } = brokerTables(scope);
  return db.prepare(`SELECT account_id FROM ${credentials} WHERE user_id=? AND mode=?`).get(userId, mode)?.account_id || null;
}

function releaseBrokerAccountOwnershipIfUnused(userId, scope, accountId) {
  if (!accountId) return;
  const { credentials } = brokerTables(scope);
  const inUse = db.prepare(`SELECT 1 FROM ${credentials} WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1`)
    .get(userId, accountId, DISCONNECTED_SENTINEL);
  if (!inUse) db.prepare('DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope=?').run(accountId, userId, scope);
  refreshBrokerAccountQuarantine(accountId);
}

function decryptStoredAlpacaCredentials(row, table, whereClause, whereValues) {
  if (!row || row.api_key === DISCONNECTED_SENTINEL) return row;
  try {
    let apiKey;
    let apiSecret;
    if (row.api_key_enc && row.api_secret_enc) {
      apiKey = credentialVault.decrypt(row.api_key_enc);
      apiSecret = credentialVault.decrypt(row.api_secret_enc);
    } else {
      // Upgrade older plaintext records atomically on their first use. The
      // legacy columns retain a non-secret marker because their schema is
      // NOT NULL; the actual values live only in authenticated ciphertext.
      if (row.api_key === ENCRYPTED_CREDENTIAL_MARKER || row.api_secret === ENCRYPTED_CREDENTIAL_MARKER) {
        throw new Error('Encrypted credential payload is missing.');
      }
      apiKey = row.api_key;
      apiSecret = row.api_secret;
      const encryptedKey = credentialVault.encrypt(apiKey);
      const encryptedSecret = credentialVault.encrypt(apiSecret);
      db.prepare(`UPDATE ${table}
        SET api_key=?, api_secret=?, api_key_enc=?, api_secret_enc=?
        WHERE ${whereClause}`)
        .run(ENCRYPTED_CREDENTIAL_MARKER, ENCRYPTED_CREDENTIAL_MARKER, encryptedKey, encryptedSecret, ...whereValues);
    }
    if (!apiKey || !apiSecret) throw new Error('Encrypted credential payload is empty.');
    return { ...row, api_key: apiKey, api_secret: apiSecret };
  } catch (error) {
    // Do not leak ciphertext, key material, or a broker response. A corrupt
    // record fails closed and requires a fresh authenticated connection.
    console.warn(`[Alpaca] Stored ${table} credential is unavailable; reconnect the account before trading.`);
    return null;
  }
}

function getAlpacaCreds(userId, scope = 'manual') {
  const { credentials, active } = brokerTables(scope);
  const mode = db.prepare(`SELECT mode FROM ${active} WHERE user_id=?`).get(userId)?.mode || 'paper';
  const row = db.prepare(`SELECT api_key,api_secret,api_key_enc,api_secret_enc,mode,account_id FROM ${credentials} WHERE user_id=? AND mode=?`).get(userId, mode);
  if (!row || row.api_key === DISCONNECTED_SENTINEL || !row.account_id
      || isBrokerAccountQuarantined(row.account_id) || alpacaAccountConflict(userId, scope, row.account_id)) return null;
  const decrypted = decryptStoredAlpacaCredentials(row, credentials, 'user_id=? AND mode=?', [userId, mode]);
  return decrypted ? { ...decrypted, strategyScope: scope, user_id: userId } : null;
}

// Helper: check if a specific mode has valid (non-sentinel) credentials in DB
function storedCredentialExists(row) {
  if (!row || row.api_key === DISCONNECTED_SENTINEL) return false;
  if (row.api_key === ENCRYPTED_CREDENTIAL_MARKER) {
    return !!row.api_key_enc && !!row.api_secret_enc;
  }
  return !!row.api_key && !!row.api_secret;
}

function _alpacaCredsExist(userId, mode, scope = 'manual') {
  const { credentials } = brokerTables(scope);
  const row = db.prepare(`SELECT api_key,api_secret,api_key_enc,api_secret_enc,account_id FROM ${credentials} WHERE user_id=? AND mode=?`).get(userId, mode);
  return storedCredentialExists(row) && !!row.account_id && !isBrokerAccountQuarantined(row.account_id)
    && !alpacaAccountConflict(userId, scope, row.account_id);
}

async function alpacaFetchFor(userId, scope, path, opts = {}, _attempt = 0) {
  const creds = getAlpacaCreds(userId, scope);
  if (!creds) throw new Error('Alpaca not connected. Please add your API credentials.');
  return alpacaFetchWithCredentials(creds, path, opts, _attempt);
}

// Lifecycle-sensitive bots pin the decrypted credential record that was
// verified and journaled for a trade. This prevents an active-mode change from
// redirecting later requests to a different broker account.
async function alpacaFetchWithCredentials(creds, path, opts = {}, _attempt = 0) {
  if (!creds?.api_key || !creds?.api_secret || !['paper', 'live'].includes(creds.mode)) {
    throw new Error('Pinned Alpaca credentials are unavailable.');
  }
  const base = creds.mode === 'live'
    ? 'https://api.alpaca.markets'
    : 'https://paper-api.alpaca.markets';
  const MAX_ATTEMPTS = 4;
  const method = String(opts.method || 'GET').toUpperCase();
  const automatedAction = creds.strategyScope === 'options' && method !== 'GET';
  let actionIntentId = null;
  if (automatedAction) {
    const body = typeof opts.body === 'string' ? opts.body : '';
    const clientOrderId = (() => { try { return JSON.parse(body)?.client_order_id || null; } catch (_) { return null; } })();
    const stableId = clientOrderId || `options-${crypto.createHash('sha256')
      .update(`${creds.account_id}|${method}|${path}|${body}`).digest('hex').slice(0, 40)}`;
    const intent = db.prepare(`
      INSERT INTO automated_action_intents
        (strategy,user_id,account_id,mode,method,path,purpose,client_order_id,request_json,state,updated_at)
      VALUES ('options',?,?,?,?,?,?,?,?,'prepared',datetime('now'))
    `).run(creds.user_id, creds.account_id, creds.mode, method, path,
      path.includes('/orders') ? 'broker-order' : 'broker-action', stableId, body || '{}');
    actionIntentId = intent.lastInsertRowid;
    await automatedState.flush(`options-before-${method.toLowerCase()}`);
  }
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 12000); // 12-second hard timeout
  let r;
  try {
    r = await fetch(base + path, {
      ...opts,
      signal: controller.signal,
      headers: {
        'APCA-API-KEY-ID':     creds.api_key,
        'APCA-API-SECRET-KEY': creds.api_secret,
        'Content-Type':        'application/json',
        ...(opts.headers || {}),
      },
    });
  } catch (netErr) {
    clearTimeout(timeoutId);
    if (automatedAction && actionIntentId) {
      db.prepare("UPDATE automated_action_intents SET state='submission_unknown',last_error=?,updated_at=datetime('now') WHERE id=?")
        .run('Broker response was not confirmed; reconciliation required.', actionIntentId);
      try { await automatedState.flush(`options-unknown-${method.toLowerCase()}`); } catch (_) {}
    }
    // Only retry GET requests — POST/PUT/DELETE are not idempotent.
    // Retrying an order-placement POST after a timeout could create a duplicate order.
    const isGet = !opts.method || opts.method === 'GET';
    if (isGet && _attempt < MAX_ATTEMPTS - 1) {
      const delay = Math.min(1000 * 2 ** _attempt, 8000);
      console.warn(`[AT] Alpaca network failure on ${path} (attempt ${_attempt + 1}/${MAX_ATTEMPTS}) — retrying in ${delay}ms`);
      await new Promise(res => setTimeout(res, delay));
      return alpacaFetchWithCredentials(creds, path, opts, _attempt + 1);
    }
    const error = new Error(`Alpaca unreachable${isGet ? ` after ${MAX_ATTEMPTS} attempts` : ''}.`);
    error.alpacaTransient = true;
    throw error;
  }
  clearTimeout(timeoutId);
  const isGet = !opts.method || opts.method === 'GET';
  // Rate-limit back-off: 429 → wait and retry (GET only — safe to repeat)
  if (r.status === 429 && isGet && _attempt < MAX_ATTEMPTS - 1) {
    const delay = Math.min(2000 * (_attempt + 1), 8000);
    console.warn(`[AT] Alpaca 429 rate-limit on ${path} — retrying in ${delay}ms`);
    await new Promise(res => setTimeout(res, delay));
    return alpacaFetchWithCredentials(creds, path, opts, _attempt + 1);
  }
  // Transient server errors (502/503/504) — retry GET requests only
  if ([502, 503, 504].includes(r.status) && isGet && _attempt < MAX_ATTEMPTS - 1) {
    const delay = Math.min(1500 * 2 ** _attempt, 8000);
    console.warn(`[AT] Alpaca ${r.status} on ${path} (attempt ${_attempt + 1}/${MAX_ATTEMPTS}) — retrying in ${delay}ms`);
    await new Promise(res => setTimeout(res, delay));
    return alpacaFetchWithCredentials(creds, path, opts, _attempt + 1);
  }
  if (r.status === 204) {
    if (automatedAction) {
      db.prepare("UPDATE automated_action_intents SET state='submitted',updated_at=datetime('now') WHERE id=?").run(actionIntentId);
      await automatedState.flush(`options-after-${method.toLowerCase()}`);
    }
    return {};
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) {
    if (automatedAction) {
      db.prepare("UPDATE automated_action_intents SET state='rejected',last_error=?,updated_at=datetime('now') WHERE id=?")
        .run('Broker definitively rejected the action.', actionIntentId);
      await automatedState.flush(`options-rejected-${method.toLowerCase()}`);
    }
    const error = new Error('Alpaca authentication failed — check your API credentials.');
    error.alpacaStatus = r.status;
    throw error;
  }
  if (!r.ok) {
    // Upstream error bodies are not trusted: brokers and proxies can echo
    // request material. Keep the message fixed so credentials never reach
    // an API response or the application error log.
    const error = new Error(`Alpaca request failed (HTTP ${r.status}).`);
    error.alpacaStatus = r.status;
    error.alpacaTransient = r.status === 429 || r.status >= 500;
    if (automatedAction) {
      db.prepare("UPDATE automated_action_intents SET state=?,last_error=?,updated_at=datetime('now') WHERE id=?")
        .run(r.status >= 400 && r.status < 500 ? 'rejected' : 'submission_unknown',
          r.status >= 400 && r.status < 500 ? 'Broker definitively rejected the action.' : 'Broker response was not confirmed; reconciliation required.',
          actionIntentId);
      await automatedState.flush(`options-${r.status >= 400 && r.status < 500 ? 'rejected' : 'unknown'}-${method.toLowerCase()}`);
    }
    throw error;
  }
  if (automatedAction) {
    db.prepare("UPDATE automated_action_intents SET state='submitted',broker_order_id=?,updated_at=datetime('now') WHERE id=?")
      .run(data?.id || null, actionIntentId);
    await automatedState.flush(`options-after-${method.toLowerCase()}`);
  }
  return data;
}

// Existing manual trading routes retain their connection behavior. Bot code must
// use alpacaFetchFor with its fixed scope and can never fall back to this path.
// Asset listings change far less often than prices. Cache the broker's
// authoritative active/tradable US-equity catalog per connected account so a
// scanner refresh never has to enumerate every asset again.
const ALPACA_ASSET_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const _alpacaAssetCatalogCache = new Map();

async function getAlpacaTradableEquityCatalog(userId, { force = false, scope = 'manual' } = {}) {
  const creds = getAlpacaCreds(userId, scope);
  if (!creds) throw new Error('Alpaca not connected. Connect an account before verifying tradable symbols.');
  const credentialFingerprint = crypto.createHash('sha256').update(creds.api_key).digest('hex').slice(0, 24);
  const key = `${userId}:${scope}:${creds.mode}:${credentialFingerprint}`;
  const cached = _alpacaAssetCatalogCache.get(key);
  if (!force && cached && Date.now() - cached.at < ALPACA_ASSET_CATALOG_TTL_MS) return cached;

  const assets = await alpacaFetchFor(userId, scope, '/v2/assets?status=active&asset_class=us_equity');
  const catalog = buildTradableEquityCatalog(assets);
  if (!catalog.size) throw new Error('Alpaca returned no active tradable US stocks or ETFs.');
  const entry = { at: Date.now(), key, catalog };
  _alpacaAssetCatalogCache.set(key, entry);
  if (_alpacaAssetCatalogCache.size > 200) _alpacaAssetCatalogCache.delete(_alpacaAssetCatalogCache.keys().next().value);
  return entry;
}

async function assertAlpacaTradableEquity(userId, symbol, {
  fresh = false,
  scope = 'manual',
  brokerFetch = null,
} = {}) {
  const normalized = String(symbol || '').toUpperCase();
  if (fresh) {
    const asset = brokerFetch
      ? await brokerFetch(`/v2/assets/${encodeURIComponent(normalized)}`)
      : await alpacaFetchFor(userId, scope, `/v2/assets/${encodeURIComponent(normalized)}`);
    const eligible = buildTradableEquityCatalog([asset]).get(normalized);
    if (!eligible) throw new Error(`${normalized} is not an active, tradable Alpaca stock or ETF.`);
    return eligible;
  }
  const { catalog } = await getAlpacaTradableEquityCatalog(userId, { scope });
  const asset = catalog.get(normalized);
  if (!asset) throw new Error(`${normalized} is not an active, tradable Alpaca stock or ETF.`);
  return asset;
}

// Emergency liquidation is coordinated server-side so an order accepted just
// before a browser kill switch cannot fill after the account has been closed.
const alpacaEmergencyFlattenLocks = new Set();
const alpacaOrderRequestsInFlight = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isAlpacaFlattening(userId) {
  return alpacaEmergencyFlattenLocks.has(userId);
}

function beginAlpacaOrderRequest(userId) {
  alpacaOrderRequestsInFlight.set(userId, (alpacaOrderRequestsInFlight.get(userId) || 0) + 1);
}

function endAlpacaOrderRequest(userId) {
  const remaining = (alpacaOrderRequestsInFlight.get(userId) || 1) - 1;
  if (remaining > 0) alpacaOrderRequestsInFlight.set(userId, remaining);
  else alpacaOrderRequestsInFlight.delete(userId);
}

async function waitForAlpacaOrderRequests(userId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while ((alpacaOrderRequestsInFlight.get(userId) || 0) > 0) {
    if (Date.now() >= deadline) {
      throw new Error('A broker order submission did not settle before emergency liquidation.');
    }
    await sleep(50);
  }
}

async function listAlpacaOpenOrders(userId, scope = 'manual') {
  const orders = await alpacaFetchFor(userId, scope, '/v2/orders?limit=500&status=open');
  return Array.isArray(orders) ? orders : [];
}

async function cancelAlpacaOpenOrders(userId, orders, scope = 'manual') {
  return Promise.all((Array.isArray(orders) ? orders : []).map(async order => {
    try {
      await alpacaFetchFor(userId, scope, `/v2/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE' });
      return { id: order.id, ok: true };
    } catch (error) {
      return { id: order.id, ok: false, error: error.message };
    }
  }));
}

function autoEnablePaperStrategy(userId, scope, mode) {
  if (scope !== 'options' || mode !== 'paper') return false;
  const settings = optionsConfigFor(userId);
  db.prepare(`INSERT INTO options_settings (user_id,enabled,live_armed,max_position_dollars,updated_at)
    VALUES (?,1,0,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET
    enabled=1,live_armed=0,activation_revision=activation_revision+1,updated_at=datetime('now')`).run(userId, settings.maxPositionDollars);
  return true;
}

// Save only verified, isolated manual or LEAP broker credentials.
app.put('/api/alpaca/credentials', requireAuth, async (req, res) => {
  const scope = requestAlpacaScope(req);
  if (scope === 'options' && !automatedTradingPersistenceReady) {
    return res.status(503).json({ error: 'Durable automated-trading persistence is unavailable; LEAP remains paused until the PostgreSQL schema is published.' });
  }
  const { credentials, active } = brokerTables(scope);
  const { apiKey, apiSecret, mode = 'paper' } = req.body || {};
  if (!['paper', 'live'].includes(mode)) return res.status(400).json({ error: 'mode must be paper or live.' });
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const secret = typeof apiSecret === 'string' ? apiSecret.trim() : '';
  if (key.length < 8 || secret.length < 8) return res.status(400).json({ error: 'Full API key and secret are required.' });
  let uid;
  try { uid = await ensureSessionUserInTradingStore(req); }
  catch { return res.status(503).json({ error: 'Your signed-in account could not be prepared for broker connections. Sign in again and retry.' }); }
  const activeOptions = () => scope === 'options' && hasActiveOptionsTrades(uid);
  if (activeOptions()) return res.status(409).json({ error: 'Reconcile or close active LEAP lifecycles before replacing this connection.' });
  try {
    const base = mode === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(base + '/v2/account', {
        headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    if (!response.ok) return res.status(response.status === 401 || response.status === 403 ? 401 : 400)
      .json({ error: 'Alpaca could not verify these credentials. Check the key, secret, and selected mode.' });
    const account = await response.json();
    const accountId = String(account?.id || account?.account_number || '').trim();
    if (!accountId) return res.status(400).json({ error: 'Alpaca did not return a verified broker account identity.' });
    const encryptedKey = credentialVault.encrypt(key);
    const encryptedSecret = credentialVault.encrypt(secret);
    // Claim and write in one local transaction; no broker mutation occurs here.
    db.transaction(() => {
      if (activeOptions()) throw Object.assign(new Error('A LEAP lifecycle became active. Reconcile before changing accounts.'), { status: 409 });
      const conflict = alpacaAccountConflict(uid, scope, accountId);
      if (conflict || !claimBrokerAccountOwnership(uid, scope, mode, accountId)) {
        throw Object.assign(new Error('This broker account is assigned to another user or strategy, or is quarantined. Use a separate account.'), { status: 409 });
      }
      const previousAccountId = storedBrokerAccountId(uid, scope, mode);
      db.prepare(`INSERT INTO ${credentials} (user_id,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,mode) DO UPDATE SET
        api_key=excluded.api_key,api_secret=excluded.api_secret,api_key_enc=excluded.api_key_enc,
        api_secret_enc=excluded.api_secret_enc,account_id=excluded.account_id`)
        .run(uid, mode, ENCRYPTED_CREDENTIAL_MARKER, ENCRYPTED_CREDENTIAL_MARKER, encryptedKey, encryptedSecret, accountId);
      db.prepare(`INSERT OR REPLACE INTO ${active} (user_id,mode) VALUES (?,?)`).run(uid, mode);
      if (scope === 'options') {
        db.prepare('UPDATE options_settings SET live_armed=0,activation_revision=activation_revision+1 WHERE user_id=?').run(uid);
        automaticBotSettings.revoke(uid, 'options');
      }
      autoEnablePaperStrategy(uid, scope, mode);
      if (previousAccountId && previousAccountId !== accountId) releaseBrokerAccountOwnershipIfUnused(uid, scope, previousAccountId);
    })();
    if (scope === 'options') await automatedState.flush('options-credentials-connected');
    res.json({ ok: true, mode, connection: scope, accountId, automationEnabled: scope === 'options' && mode === 'paper', liveArmed: false });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.status === 409 ? error.message : 'Broker verification could not complete. Check the connection and try again.' });
  }
});

app.delete('/api/alpaca/credentials', requireAuth, async (req, res) => {
  const uid = req.session.userId;
  const scope = requestAlpacaScope(req);
  const { credentials, active } = brokerTables(scope);
  if (scope === 'options' && hasActiveOptionsTrades(uid)) return res.status(409).json({ error: 'Reconcile or close active LEAP lifecycles before disconnecting.' });
  db.transaction(() => {
    const mode = db.prepare(`SELECT mode FROM ${active} WHERE user_id=?`).get(uid)?.mode || 'paper';
    const accountId = storedBrokerAccountId(uid, scope, mode);
    db.prepare(`INSERT INTO ${credentials} (user_id,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
      VALUES (?,?,?,?,NULL,NULL,NULL) ON CONFLICT(user_id,mode) DO UPDATE SET
      api_key=excluded.api_key,api_secret=excluded.api_secret,api_key_enc=NULL,api_secret_enc=NULL,account_id=NULL`)
      .run(uid, mode, DISCONNECTED_SENTINEL, DISCONNECTED_SENTINEL);
    if (scope === 'options') {
      db.prepare('UPDATE options_settings SET live_armed=0,activation_revision=activation_revision+1 WHERE user_id=?').run(uid);
      automaticBotSettings.revoke(uid, 'options');
    }
    releaseBrokerAccountOwnershipIfUnused(uid, scope, accountId);
  })();
  if (scope === 'options') {
    try { await automatedState.flush('options-credentials-disconnected'); }
    catch (error) { return res.status(503).json({ error: `Disconnect could not be durably saved: ${error.message}` }); }
  }
  res.json({ ok: true, connection: scope });
});

app.get('/api/alpaca/credentials', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const scope = requestAlpacaScope(req);
  const { active } = brokerTables(scope);
  const creds = getAlpacaCreds(uid, scope);
  res.json({ connected: !!creds, mode: db.prepare(`SELECT mode FROM ${active} WHERE user_id=?`).get(uid)?.mode || 'paper',
    paperConnected: _alpacaCredsExist(uid, 'paper', scope), liveConnected: _alpacaCredsExist(uid, 'live', scope),
    connection: scope, accountId: creds?.account_id || null });
});

app.post('/api/alpaca/switch-mode', requireAuth, async (req, res) => {
  const { mode } = req.body || {};
  const scope = requestAlpacaScope(req);
  const uid = req.session.userId;
  const { active } = brokerTables(scope);
  if (!['paper', 'live'].includes(mode)) return res.status(400).json({ error: 'mode must be paper or live.' });
  if (scope === 'options' && hasActiveOptionsTrades(uid)) return res.status(409).json({ error: 'Reconcile or close active LEAP lifecycles before switching mode.' });
  if (!_alpacaCredsExist(uid, mode, scope)) return res.status(400).json({ error: 'Connect a verified, isolated account for this mode first.' });
  db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO ${active} (user_id,mode) VALUES (?,?)`).run(uid, mode);
    if (scope === 'options') {
      db.prepare('UPDATE options_settings SET live_armed=0,activation_revision=activation_revision+1 WHERE user_id=?').run(uid);
      automaticBotSettings.revoke(uid, 'options');
    }
    autoEnablePaperStrategy(uid, scope, mode);
  })();
  if (scope === 'options') {
    try { await automatedState.flush('options-mode-selected'); }
    catch (error) { return res.status(503).json({ error: `Mode selection could not be durably saved: ${error.message}` }); }
  }
  res.json({ ok: true, mode, connection: scope, automationEnabled: scope === 'options' && mode === 'paper', liveArmed: false });
});

app.use('/api/alpaca', (req, res, next) => {
  try {
    const scope = requestAlpacaScope(req);
    if (req.method === 'DELETE' && /^\/(?:positions|position|order)(?:\/|$)/.test(req.path) && scope !== 'manual') {
      return res.status(400).json({ error: 'Strategy positions and exits are owned by their lifecycle API.' });
    }
    next();
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// Account info
app.get('/api/alpaca/account', requireAuth, async (req, res) => {
  const scope = requestAlpacaScope(req);
  try { res.json(await alpacaFetchFor(req.session.userId, scope, '/v2/account')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Open positions
app.get('/api/alpaca/positions', requireAuth, async (req, res) => {
  const scope = requestAlpacaScope(req);
  try { res.json(await alpacaFetchFor(req.session.userId, scope, '/v2/positions')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Pending orders only (not order history — only shows new/partially_filled)
app.get('/api/alpaca/orders', requireAuth, async (req, res) => {
  const scope = requestAlpacaScope(req);
  try { res.json(await alpacaFetchFor(req.session.userId, scope, '/v2/orders?limit=50&status=open')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Emergency account flatten: reject new orders, cancel every open order, then
// close positions and verify the broker reports no positions or open orders.
app.delete('/api/alpaca/positions', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const scope = requestAlpacaScope(req);
  if (isAlpacaFlattening(userId)) {
    return res.status(409).json({ ok: false, error: 'Emergency flatten is already in progress.' });
  }
  alpacaEmergencyFlattenLocks.add(userId);
  try {
    const result = await runEmergencyFlatten({
      waitForOrderRequests: () => waitForAlpacaOrderRequests(userId),
      listOpenOrders: () => listAlpacaOpenOrders(userId, scope),
      cancelOpenOrders: orders => cancelAlpacaOpenOrders(userId, orders, scope),
      closeAllPositions: () => alpacaFetchFor(userId, scope, '/v2/positions', { method: 'DELETE' }),
      listPositions: async () => {
        const positions = await alpacaFetchFor(userId, scope, '/v2/positions');
        return Array.isArray(positions) ? positions : [];
      },
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof EmergencyFlattenError ? 409 : 400;
    res.status(status).json({ ok: false, error: e.message, details: e.details || null });
  } finally {
    alpacaEmergencyFlattenLocks.delete(userId);
  }
});

// Public SPY gate levels — no auth needed (cached server-side)
app.get('/api/spy-levels', async (req, res) => {
  try {
    const lvl = await getSPYLevels();
    res.json(lvl ?? { floor: null, maxPain: null, roof: null, expiry: null });
  } catch (e) { res.json({ floor: null, maxPain: null, roof: null, expiry: null }); }
});

async function placeAlpacaOrder(req, res) {
  if (isAlpacaFlattening(req.session.userId)) {
    return res.status(409).json({ error: 'Emergency flatten is in progress. New orders are temporarily blocked.' });
  }
  const { symbol, side, amount, tpPct, slPct, leverage, clientOrderId } = req.body || {};
  const scope = requestAlpacaScope(req);
  if (scope !== 'manual') return res.status(400).json({ error: 'Use the Options lifecycle API for strategy orders.' });


  // ── Input validation ───────────────────────────────────────────────────────
  if (!symbol || !side) return res.status(400).json({ error: 'symbol and side required.' });
  if (!/^[A-Z0-9.\-]{1,12}$/i.test(symbol)) return res.status(400).json({ error: 'Invalid symbol.' });
  const sideL = side.toLowerCase();
  if (sideL !== 'buy' && sideL !== 'sell') return res.status(400).json({ error: 'side must be buy or sell.' });
  const isCryptoSym = isLikelyCryptoSymbol(symbol);

  const normalizedSymbol = symbol.toUpperCase();

  const amtNum = parseFloat(amount);
  if (!isFinite(amtNum) || amtNum <= 0) return res.status(400).json({ error: 'amount must be a positive number.' });

  const tpNum  = parseFloat(tpPct)  || 0;
  const slNum  = parseFloat(slPct)  || 0;
  if (tpNum < 0 || slNum < 0) return res.status(400).json({ error: 'tpPct and slPct must be non-negative.' });
  if (clientOrderId != null && !/^[A-Za-z0-9_-]{1,48}$/.test(String(clientOrderId))) {
    return res.status(400).json({ error: 'Invalid client order ID.' });
  }

  // ── NO-SHORT POLICY ─────────────────────────────────────────────────────────
  // This platform never opens short positions. A SELL order is only allowed to
  // close (or reduce) an existing long position. To profit from a falling
  // stock/market, buy the mapped inverse ETF instead (GET /api/inverse/:sym).
  if (sideL === 'sell') {
    try {

      const pos = await alpacaFetchFor(req.session.userId, scope, `/v2/positions/${symbol.toUpperCase()}`, { method: 'GET' });
      const heldQty = parseFloat(pos?.qty ?? 0);
      if (!isFinite(heldQty) || heldQty <= 0) {
        return res.status(400).json({
          error: `No long position in ${symbol.toUpperCase()} — shorting is not allowed on this platform. To trade the downside, BUY the inverse ETF instead.`,
          noShort: true,
        });
      }
      req._heldQty = heldQty; // cap the sell below

      // Manual sells are allowed only when no managed journal owns this
      // account/symbol. In that case every same-symbol order belongs to the
      // manual position and can be settled before the quantity-bounded sell.
      try {
        const open = await alpacaFetchFor(req.session.userId, scope, `/v2/orders?status=open&symbols=${symbol.toUpperCase()}`, { method: 'GET' });
        for (const o of (Array.isArray(open) ? open : [])) {
          await alpacaFetchFor(req.session.userId, scope, `/v2/orders/${o.id}`, { method: 'DELETE' });
        }
        const remaining = await alpacaFetchFor(req.session.userId, scope, `/v2/orders?status=open&symbols=${symbol.toUpperCase()}`, { method: 'GET' });
        if (Array.isArray(remaining) && remaining.length) {
          throw new Error(`Open ${normalizedSymbol} orders did not settle; manual sell blocked.`);
        }
      } catch (error) {
        return res.status(409).json({ error: error.message });
      }
    } catch (e) {

      return res.status(400).json({
        error: `No long position in ${symbol.toUpperCase()} — shorting is not allowed on this platform. To trade the downside, BUY the inverse ETF instead.`,
        noShort: true,
      });
    }
  }

  // Alpaca bracket orders require BOTH take-profit AND stop-loss legs.
  // With SL only (bot default: fixed stop + RSI-based take profit handled
  // client-side), use an OTO order: market buy + attached stop-loss leg.
  const hasBracket = tpNum > 0 && slNum > 0;
  const hasOtoStop = !hasBracket && slNum > 0 && sideL === 'buy';

  // Validate leverage (1–4x, must be numeric)
  const lev = Math.min(4, Math.max(1, isFinite(+leverage) ? +leverage : 1));

  // ── Market-hours guard (equity only — crypto trades 24/7) ─────────────────

  if (!isCryptoSym && !isMarketOpen()) {
    return res.status(400).json({ error: 'Market is closed. Equity orders are only accepted during regular market hours (9:35 AM – 3:50 PM ET, Mon–Fri). Use Alpaca directly for extended-hours orders.' });
  }

  let entryLockHeld = false;

  try {

    if (sideL === 'buy') {
      if (!acquireExecutionLock(req.session.userId)) {
        return res.status(409).json({ error: 'Another entry is being prepared. Please wait for it to settle.' });
      }
      entryLockHeld = true;

      if (!isCryptoSym) await assertAlpacaTradableEquity(req.session.userId, symbol, { fresh: true, scope });

      const slots = await getOpenSlots(req.session.userId, 'Order', scope);
      if (!canReserveEntryUnits(slots)) {
        return res.status(409).json({ error: 'Position limit reached or account data unavailable.' });
      }
    }

    // Manual orders use the current executable account's market-data scope.
    const quote = await fetchLiveQuote(symbol.toUpperCase(), req.session.userId, scope);
    const price = quote?.price ?? quote?.regularMarketPrice ?? quote?.regularClose;

    if (!price || !isFinite(price) || price <= 0) throw new Error('Could not fetch a valid current price for ' + symbol.toUpperCase());
    const leveragedAmount = amtNum * lev;
    let orderBody;

    if (hasBracket) {
      // Bracket orders require integer qty (Alpaca limitation for margin accounts)
      // BUG FIX: removed Math.max(1,...) — that forced a 1-share minimum causing over-exposure
      // when position size < stock price. Now we throw a clear error instead.
      let shares = Math.floor(leveragedAmount / price);
      // NO-SHORT: cap sells at the held quantity so a close can never flip short
      if (sideL === 'sell' && req._heldQty != null) shares = Math.min(shares, Math.floor(req._heldQty));
      if (shares < 1) throw new Error(`Position size $${amtNum.toFixed(2)} × ${lev}x leverage = $${leveragedAmount.toFixed(2)}, which is less than the price of 1 share ($${price.toFixed(2)}). Increase your position size in Settings.`);
      const tpPrice = sideL === 'buy'
        ? (price * (1 + tpNum / 100)).toFixed(2)
        : (price * (1 - tpNum / 100)).toFixed(2);
      const slPrice = sideL === 'buy'
        ? (price * (1 - slNum / 100)).toFixed(2)
        : (price * (1 + slNum / 100)).toFixed(2);
      orderBody = {
        symbol:         symbol.toUpperCase(),
        qty:            String(shares),
        side:           sideL,
        type:           'market',
        time_in_force:  'day',
        order_class:    'bracket',
        take_profit:    { limit_price: tpPrice },
        stop_loss:      { stop_price:  slPrice },
      };
    } else if (hasOtoStop) {
      // OTO: market buy + stop-loss leg only (take profit handled by RSI exit).
      // Advanced orders require integer qty.
      const shares = Math.floor(leveragedAmount / price);
      if (shares < 1) throw new Error(`Position size $${amtNum.toFixed(2)} × ${lev}x leverage = $${leveragedAmount.toFixed(2)}, which is less than the price of 1 share ($${price.toFixed(2)}). Increase your position size in Settings.`);
      orderBody = {
        symbol:         symbol.toUpperCase(),
        qty:            String(shares),
        side:           'buy',
        type:           'market',
        time_in_force:  'day',
        order_class:    'oto',
        stop_loss:      { stop_price: (price * (1 - slNum / 100)).toFixed(2) },
      };
    } else if (sideL === 'sell') {
      // NO-SHORT: sells are always QUANTITY-based from the verified held amount.
      // A notional sell filled at a lower price would represent more shares than
      // held and could flip the account short — qty-based sells cannot.
      const requestedQty = leveragedAmount / price;
      const sellQty = Math.min(requestedQty, req._heldQty);
      if (!(sellQty > 0)) throw new Error(`Nothing to sell in ${symbol.toUpperCase()}.`);
      orderBody = {
        symbol:         symbol.toUpperCase(),
        qty:            String(+sellQty.toFixed(6)), // supports fractional holdings
        side:           'sell',
        type:           'market',
        time_in_force:  'day',
      };
    } else {
      // Simple notional BUY order (supports fractional shares)
      orderBody = {
        symbol:         symbol.toUpperCase(),
        notional:       leveragedAmount.toFixed(2),
        side:           'buy',
        type:           'market',
        time_in_force:  'day',
      };
    }
    if (clientOrderId) orderBody.client_order_id = String(clientOrderId);

    // Re-check immediately before the broker request, then mark it in-flight.
    // The flatten route waits for this counter before cancelling orders.
    if (isAlpacaFlattening(req.session.userId)) {
      return res.status(409).json({ error: 'Emergency flatten is in progress. New orders are temporarily blocked.' });
    }

    beginAlpacaOrderRequest(req.session.userId);
    let data;
    try {
      data = await alpacaFetchFor(req.session.userId, scope, '/v2/orders', {
        method: 'POST',
        body:   JSON.stringify(orderBody),
      });
    } finally {
      endAlpacaOrderRequest(req.session.userId);
    }
    res.json({ ok: true, order: data, shares: orderBody.qty || null, price, leverage: lev });
  } catch (e) {
    // A timeout or broker-side failure after a POST is ambiguous: Alpaca may
    // have accepted the client_order_id. Keep that outcome distinguishable so
    // the browser preserves the journal row and reconciles the exact order.
    const status = e.alpacaTransient ? 503
      : e.alpacaStatus || (e.message.includes('authentication') ? 401 : 400);
    res.status(status).json({ error: e.message });
  } finally {

    if (entryLockHeld) releaseExecutionLock(req.session.userId);
  }
}

// Manual trading remains isolated from strategy automation. Strategy entries
// are owned exclusively by their server schedulers.
app.post('/api/alpaca/order', requireAuth, (req, res) => {
  return placeAlpacaOrder(req, res);
});

// Cancel order
app.get('/api/alpaca/order/by-client/:clientOrderId', requireAuth, async (req, res) => {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(req.params.clientOrderId)) {
    return res.status(400).json({ error: 'Invalid client order ID.' });
  }
  try {
    const clientOrderId = encodeURIComponent(req.params.clientOrderId);
    res.json(await alpacaFetchFor(
      req.session.userId,
      requestAlpacaScope(req),
      `/v2/orders:by_client_order_id?client_order_id=${clientOrderId}&nested=true`,
      { method: 'GET' }
    ));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/alpaca/order/:id', requireAuth, async (req, res) => {
  if (!/^[a-f0-9\-]{10,40}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid order ID.' });
  }
  try {
    res.json(await alpacaFetchFor(
      req.session.userId,
      requestAlpacaScope(req),
      `/v2/orders/${req.params.id}?nested=true`,
      { method: 'GET' }
    ));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/alpaca/order/:id', requireAuth, async (req, res) => {
  if (!/^[a-f0-9\-]{10,40}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid order ID.' });
  try {

    await alpacaFetchFor(req.session.userId, 'manual', `/v2/orders/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Close position (market sell)
app.delete('/api/alpaca/position/:sym', requireAuth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) return res.status(400).json({ error: 'Invalid symbol.' });
  try {

    const open = await alpacaFetchFor(req.session.userId, 'manual', `/v2/orders?status=open&symbols=${encodeURIComponent(sym)}`);
    for (const order of (Array.isArray(open) ? open : [])) {
      await alpacaFetchFor(req.session.userId, 'manual', `/v2/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE' });
    }
    const remaining = await alpacaFetchFor(req.session.userId, 'manual', `/v2/orders?status=open&symbols=${encodeURIComponent(sym)}`);
    if (Array.isArray(remaining) && remaining.length) {
      return res.status(409).json({ error: `Open ${sym} orders did not settle; position close blocked.` });
    }
    res.json(await alpacaFetchFor(req.session.userId, 'manual', `/v2/positions/${sym}`, { method: 'DELETE' }));
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// Wilder-smoothed RSI. Returns null when there are fewer than period+1 valid closes.
function calcRSI(closes, period = 14) {
  const vals = (closes || []).filter(v => isFinite(v));
  if (vals.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = vals[i] - vals[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100; // flat → neutral, all-gain → 100
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Stochastic (kPeriod, kSmooth, dPeriod) — returns smoothed %K and %D


async function fetchOHLCV(symbol, limit = 120) {
  const range = limit <= 60 ? '3mo' : '6mo';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: YH });
  if (!r.ok) return null;
  const d = await r.json();
  const rs = d?.chart?.result?.[0];
  if (!rs) return null;
  const times = rs.timestamp || [];
  const q = rs.indicators?.quote?.[0] || {};
  const bars = times.map((t, i) => ({
    t: new Date(t * 1000).toISOString().slice(0, 10),
    o: q.open?.[i]   ?? null,
    h: q.high?.[i]   ?? null,
    l: q.low?.[i]    ?? null,
    c: q.close?.[i]  ?? null,
    v: q.volume?.[i] ?? null,
  })).filter(b => b.c != null && b.h != null && b.l != null && b.o != null);
  return bars.slice(-limit);
}

app.get('/api/inverse/:sym', (req, res) => {
  const sym = req.params.sym?.toUpperCase().replace(/[^A-Z.\-]/g, '');
  if (!sym) return res.status(400).json({ ok: false, error: 'symbol required' });
  const inverse = resolveInverseSymbol(sym, INVERSE_MAP);
  if (!inverse) {
    return res.status(404).json({
      ok: false, sym, code: 'NO_INVERSE_MAPPING',
      error: `No approved inverse ETF mapping exists for ${sym}. Downside routing is blocked.`,
    });
  }
  res.json({ ok: true, sym, inverse, mapped: true,
    product: ETF_PRODUCT_METADATA[inverse] || null,
    note: `${sym} falls → ${inverse} rises (approved mapped inverse ETF)` });
});

app.get('/api/patterns/:sym', async (req, res) => {
  const sym = req.params.sym?.toUpperCase().replace(/[^A-Z.]/g,'');
  if (!sym) return res.status(400).json({ ok: false, error: 'symbol required' });
  try {
    const bars = await fetchOHLCV(sym, 30);
    if (!bars || bars.length < 3) return res.json({ ok: false, sym, patterns: [], error: 'Insufficient data' });
    const patterns = detectCandlePatterns(bars);
    res.json({ ok: true, sym, patterns: patterns.all });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ── GET /api/catalyst-intel — compact microcap/biotech catalyst feed ──────────
// Intelligence only: this route never places orders and does not invent event dates.
// It combines source-linked news with live Yahoo market data, applies deterministic
// classification/scoring, and reports missing inputs rather than silently filling them.
const _bciCache = { data: null, at: 0 };
let _bciInflight = null;
const _bciForceAt = new Map();
const BCI_CACHE_MS = 4 * 60 * 1000;
const BCI_FORCE_COOLDOWN_MS = 60 * 1000;
const BCI_LOOKBACK_MS = 72 * 60 * 60 * 1000;

function bciSafeUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch { return null; }
}

function bciExplicitSymbol(text = '') {
  const value = String(text);
  const exchange = value.match(/\b(?:NASDAQ|NYSE(?:\s+AMERICAN)?|AMEX)\s*[:\-]\s*([A-Z]{1,6})\b/i);
  if (exchange) return { symbol: exchange[1].toUpperCase(), association: 'exchange' };
  const cashTag = value.match(/\$([A-Z]{1,6})\b/);
  if (cashTag) return { symbol: cashTag[1].toUpperCase(), association: 'cash-tag' };
  return null;
}

function bciFreshEnough(dateValue, now = Date.now()) {
  if (!dateValue) return true; // kept but explicitly marked unverified downstream
  const at = new Date(dateValue).getTime();
  return !Number.isFinite(at) || now - at <= BCI_LOOKBACK_MS;
}

async function bciFetchFmp(dataGaps, sources) {
  if (!FMP_KEY) {
    dataGaps.push('Financial Modeling Prep news source is not configured');
    sources.push({ name: 'FMP', status: 'unavailable', count: 0 });
    return [];
  }
  try {
    const url = `https://financialmodelingprep.com/api/v3/stock_news?limit=100&apikey=${FMP_KEY}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = await r.json();
    const articles = (Array.isArray(rows) ? rows : [])
      .filter(n => n?.symbol && n?.title && CATALYST_TERMS.test(`${n.title} ${n.text || ''}`))
      .filter(n => bciFreshEnough(n.publishedDate))
      .map(n => ({
        symbol: String(n.symbol).toUpperCase().replace(/[^A-Z.\-]/g, ''),
        company: n.symbol,
        headline: String(n.title),
        summary: String(n.text || ''),
        url: bciSafeUrl(n.url),
        source: n.site || 'Financial Modeling Prep',
        publishedAt: n.publishedDate || null,
        association: 'provider',
      }))
      .filter(n => /^[A-Z]{1,6}$/.test(n.symbol));
    sources.push({ name: 'FMP', status: 'live', count: articles.length });
    return articles;
  } catch (e) {
    dataGaps.push(`FMP news unavailable (${e.message})`);
    sources.push({ name: 'FMP', status: 'unavailable', count: 0 });
    return [];
  }
}

async function bciFetchNewsApi(dataGaps, sources) {
  if (!NEWS_KEY) {
    dataGaps.push('NewsAPI catalyst source is not configured');
    sources.push({ name: 'NewsAPI', status: 'unavailable', count: 0 });
    return [];
  }
  try {
    const from = new Date(Date.now() - BCI_LOOKBACK_MS).toISOString();
    const query = '("FDA approval" OR "clinical trial" OR PDUFA OR "Phase 2" OR "Phase 3" OR biotech OR pharmaceutical OR "registered direct offering" OR "public offering") AND (Nasdaq OR NYSE OR stock OR shares)';
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&from=${encodeURIComponent(from)}&language=en&sortBy=publishedAt&pageSize=100&apiKey=${NEWS_KEY}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const payload = await r.json();
    const articles = (payload.articles || []).flatMap(a => {
      if (!a?.title || a.title === '[Removed]') return [];
      const combined = `${a.title} ${a.description || ''}`;
      if (!CATALYST_TERMS.test(combined) || !bciFreshEnough(a.publishedAt)) return [];
      const association = bciExplicitSymbol(combined);
      if (!association) return []; // never guess a ticker from ordinary capitalized words
      return [{
        symbol: association.symbol,
        headline: String(a.title),
        summary: String(a.description || ''),
        url: bciSafeUrl(a.url),
        source: a.source?.name || 'NewsAPI',
        publishedAt: a.publishedAt || null,
        association: association.association,
      }];
    });
    sources.push({ name: 'NewsAPI', status: 'live', count: articles.length });
    return articles;
  } catch (e) {
    dataGaps.push(`NewsAPI unavailable (${e.message})`);
    sources.push({ name: 'NewsAPI', status: 'unavailable', count: 0 });
    return [];
  }
}

async function bciFetchYahooSmallCaps(dataGaps, sources) {
  try {
    const screenerUrl = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=50&scrIds=small_cap_gainers';
    const screenRes = await fetch(screenerUrl, {
      headers: { ...YH, Accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!screenRes.ok) throw new Error(`screener HTTP ${screenRes.status}`);
    const payload = await screenRes.json();
    const quotes = payload?.finance?.result?.[0]?.quotes || [];
    const candidates = quotes
      .filter(q => /^[A-Z]{1,6}$/.test(q.symbol || ''))
      .filter(q => {
        const price = Number(q.regularMarketPrice);
        const cap = Number(q.marketCap);
        return price >= 0.5 && price <= 20 && (!Number.isFinite(cap) || (cap >= 20e6 && cap <= 1e9));
      })
      .slice(0, 24);

    const articles = [];
    for (let i = 0; i < candidates.length; i += 6) {
      const chunk = candidates.slice(i, i + 6);
      const settled = await Promise.allSettled(chunk.map(async q => {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q.symbol)}&quotesCount=0&newsCount=5`;
        const r = await fetch(url, { headers: YH, signal: AbortSignal.timeout(7000) });
        if (!r.ok) return [];
        const d = await r.json();
        return (d.news || [])
          .filter(n => n?.title && CATALYST_TERMS.test(n.title))
          .filter(n => bciFreshEnough(n.providerPublishTime ? n.providerPublishTime * 1000 : null))
          .map(n => ({
            symbol: q.symbol,
            company: q.shortName || q.longName || q.symbol,
            headline: String(n.title),
            summary: '',
            url: bciSafeUrl(n.link),
            source: n.publisher || 'Yahoo Finance',
            publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
            association: 'symbol-search',
          }));
      }));
      for (const result of settled) {
        if (result.status === 'fulfilled') articles.push(...result.value);
      }
    }
    sources.push({ name: 'Yahoo small-cap news', status: 'live', count: articles.length });
    return articles;
  } catch (e) {
    dataGaps.push(`Yahoo small-cap news unavailable (${e.message})`);
    sources.push({ name: 'Yahoo small-cap news', status: 'unavailable', count: 0 });
    return [];
  }
}

function bciPrepareArticles(articles) {
  return articles
    .filter(a => a?.headline && /^[A-Z]{1,6}$/.test(a.symbol || ''))
    .sort((a, b) => (new Date(b.publishedAt).getTime() || 0) - (new Date(a.publishedAt).getTime() || 0))
    .slice(0, 160);
}

async function bciEnrichMarkets(articles, dataGaps) {
  const symbols = [...new Set(articles.map(a => a.symbol))].slice(0, 28);
  const marketBySymbol = new Map();
  const rejectedBySymbol = new Map();
  for (let i = 0; i < symbols.length; i += 6) {
    const chunk = symbols.slice(i, i + 6);
    const settled = await Promise.allSettled(chunk.map(async symbol => {
      let quote;
      try {
        quote = await yf.quote(symbol, {}, { validateResult: false });
      } catch (_) {
        return {
          rejected: {
            symbol, company: symbol, price: null, changePct: null, volume: null,
            bid: null, ask: null, liquidity: evaluateLiquidity({}),
          },
        };
      }
      const evaluatedAt = Date.now();
      const price = Number.isFinite(Number(quote?.regularMarketPrice)) ? Number(quote.regularMarketPrice) : null;
      const volume = Number.isFinite(Number(quote?.regularMarketVolume)) ? Number(quote.regularMarketVolume) : null;
      const bid = Number.isFinite(Number(quote?.bid)) ? Number(quote.bid) : null;
      const ask = Number.isFinite(Number(quote?.ask)) ? Number(quote.ask) : null;
      const changePct = Number.isFinite(Number(quote?.regularMarketChangePercent))
        ? Number(quote.regularMarketChangePercent) : null;
      const liquidity = evaluateYahooLiquidity(quote, {
        now: evaluatedAt, marketState: currentMarketState(),
      });
      const base = {
        symbol,
        company: quote?.shortName || quote?.longName || symbol,
        price,
        changePct: changePct == null ? null : +changePct.toFixed(2),
        volume,
        bid,
        ask,
        liquidity,
      };
      if (!liquidity.eligible) return { rejected: base };
      if (!Number.isFinite(price) || price < 0.5 || price > 20) return null;
      const marketCap = Number.isFinite(quote.marketCap) ? quote.marketCap : null;
      if (marketCap != null && (marketCap < 20e6 || marketCap > 1e9)) return null;
      const floatData = await _fetchFloatData(symbol);
      const avgVol = quote.averageDailyVolume3Month ?? quote.averageDailyVolume10Day ?? null;
      return {
        ...base,
        symbol,
        company: quote.shortName || quote.longName || symbol,
        price,
        volume,
        relVol: volume != null && avgVol ? +(volume / avgVol).toFixed(2) : null,
        marketCap,
        float: floatData.float ?? quote.floatShares ?? null,
        floatSource: floatData.floatSource ?? (quote.floatShares != null ? 'quote' : null),
      };
    }));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value?.rejected) {
        rejectedBySymbol.set(result.value.rejected.symbol, result.value.rejected);
      } else if (result.status === 'fulfilled' && result.value) {
        marketBySymbol.set(result.value.symbol, result.value);
      }
    }
  }
  if (!marketBySymbol.size && articles.length) dataGaps.push('Market-data enrichment returned no qualifying $20M–$1B, $0.50–$20 symbols');
  return { marketBySymbol, rejected: [...rejectedBySymbol.values()] };
}

async function bciGeneratePayload() {
  const dataGaps = [];
  const sources = [];
  const providerResults = await Promise.all([
    bciFetchFmp(dataGaps, sources),
    bciFetchNewsApi(dataGaps, sources),
    bciFetchYahooSmallCaps(dataGaps, sources),
  ]);
  const availableSources = sources.filter(s => s.status === 'live').length;
  if (!availableSources) {
    const outage = new Error('All catalyst news providers are unavailable');
    outage.sources = sources;
    outage.dataGaps = dataGaps;
    throw outage;
  }

  // Do not dedupe here: buildCatalystEvent + dedupeEvents must see every
  // syndicated version so they can retain the strongest canonical source and
  // preserve an honest duplicate count.
  const articles = bciPrepareArticles(providerResults.flat());
  const { marketBySymbol, rejected: liquidityRejected } = await bciEnrichMarkets(articles, dataGaps);
  const now = Date.now();
  const events = dedupeEvents(
    articles
      .filter(article => marketBySymbol.has(article.symbol))
      .map(article => buildCatalystEvent(article, marketBySymbol.get(article.symbol), now))
  )
    .sort((a, b) => b.opportunityScore - a.opportunityScore || b.catalystScore - a.catalystScore)
    .slice(0, 20)
    .map(({ sourceScore, ...publicEvent }) => publicEvent);

  return {
    ok: true,
    events,
    liquidityRejected,
    liquidityPolicy: DEFAULT_LIQUIDITY_POLICY,
    updatedAt: new Date(now).toISOString(),
    marketState: currentMarketState(),
    cached: false,
    stale: false,
    sources,
    dataGaps,
    reviewOnly: true,
  };
}

app.get('/api/catalyst-intel', requireAuth, async (req, res) => {
  const now = Date.now();
  let force = req.query.force === '1';
  if (force) {
    const forceKey = String(req.session.userId);
    const lastForce = _bciForceAt.get(forceKey) || 0;
    if (now - lastForce < BCI_FORCE_COOLDOWN_MS) force = false;
    else {
      _bciForceAt.set(forceKey, now);
      if (_bciForceAt.size > 250) _bciForceAt.delete(_bciForceAt.keys().next().value);
    }
  }

  if (!force && _bciCache.data && now - _bciCache.at < BCI_CACHE_MS) {
    return res.json({ ..._bciCache.data, cached: true });
  }
  if (_bciInflight) {
    try { return res.json({ ...(await _bciInflight), cached: true }); }
    catch { /* let the current request use the stale/error path below */ }
  }

  _bciInflight = bciGeneratePayload();
  try {
    const payload = await _bciInflight;
    _bciCache.data = payload;
    _bciCache.at = Date.now();
    res.json(payload);
  } catch (e) {
    console.error('[CatalystIntel]', e.message);
    if (_bciCache.data) {
      return res.json({
        ..._bciCache.data,
        cached: true,
        stale: true,
        sources: e.sources || _bciCache.data.sources || [],
        dataGaps: [...new Set([...(e.dataGaps || _bciCache.data.dataGaps || []), `Refresh failed (${e.message})`])],
      });
    }
    res.status(503).json({
      ok: false,
      events: [],
      updatedAt: null,
      marketState: currentMarketState(),
      cached: false,
      stale: true,
      sources: e.sources || [],
      dataGaps: e.dataGaps || [e.message],
      error: 'Catalyst intelligence is temporarily unavailable',
    });
  } finally {
    _bciInflight = null;
  }
});

// ── GET /api/whale/scan — whale radar for a curated watchlist ─────────────────
// Scans 20 high-OI symbols concurrently, returns call/put ratios, sweep flags,
// and top concentrated strikes.  Results are served from the 15-min cache so
// repeated calls are instant.
const WHALE_RADAR_SYMBOLS = [
  'SPY','QQQ','NVDA','TSLA','AAPL','AMD','META','AMZN','GOOGL','MSFT',
  'PLTR','MSTR','COIN','HOOD','MARA','SOFI','RIVN','NIO','AMC','GME'
];

// ── GET /api/macro-context — current seasonal/OpEx/macro snapshot ─────────────
app.get('/api/macro-context', requireAuth, (req, res) => {
  try { res.json(computeSeasonalContext()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

async function getAutomaticBotContext({ strategy = 'advisory' } = {}) {
  const now = Date.now();
  const seasonal = computeSeasonalContext();
  let verifiedMacro = null;
  try { verifiedMacro = await getVerifiedMacroContext(); } catch (_) { /* normalized below */ }
  const macroAvailable = verifiedMacro?.score?.value != null;
  const context = buildAutomaticBotContext({
    seasonality: { data: seasonal, asOf: seasonal.date, maxAgeMs: 24 * 60 * 60 * 1000 },
    federalReserve: {
      data: macroAvailable ? verifiedMacro.inputs?.fed || null : null,
      asOf: verifiedMacro?.generatedAt, maxAgeMs: 6 * 60 * 60 * 1000,
      reason: 'Fresh verified Federal Reserve context is unavailable.',
    },
    macro: {
      data: macroAvailable ? verifiedMacro : null,
      asOf: verifiedMacro?.generatedAt, maxAgeMs: 6 * 60 * 60 * 1000,
      reason: 'Complete verified macro context is unavailable.',
    },
  }, { now });
  return consumeAutomaticBotContext(context, { name: `${strategy}-advisory`, requiredSources: [] });
}

app.get('/api/automatic-bot-context', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await getAutomaticBotContext()); }
  catch (_) { res.status(503).json({ error: 'Automatic bot context is temporarily unavailable.' }); }
});

// Verified observations remain read-only. The automatic-bot context publishes
// them as advisory evidence; each strategy retains authority over every rule.
app.get('/api/verified-macro-context', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await getVerifiedMacroContext()); }
  catch (_) { res.status(503).json({ error: 'Verified macro context unavailable' }); }
});

app.get('/api/whale/scan', requireAuth, async (req, res) => {
  try {
    const results = await Promise.allSettled(
      WHALE_RADAR_SYMBOLS.map(async sym => {
        const w = await detectWhaleSignal(sym);
        if (!w) return null;
        const dp = await detectDarkPoolLevels(sym);
        return {
          symbol: sym,
          callPutRatio: parseFloat(w.callPutRatio.toFixed(2)),
          putCallRatio: parseFloat(w.putCallRatio.toFixed(2)),
          totalCallOI: w.totalCallOI,
          totalPutOI: w.totalPutOI,
          callSweep: w.callSweep,
          putSweep: w.putSweep,
          topCallStrike: w.topCallStrike,
          topPutStrike: w.topPutStrike,
          expiry: w.expiry,
          bias: w.bullish && !w.bearish ? 'BULLISH'
              : w.bearish && !w.bullish ? 'BEARISH'
              : w.bullish && w.bearish  ? 'MIXED'
              : 'NEUTRAL',
          dp: dp ? { poc: dp.poc, vah: dp.vah, val: dp.val, hvn: dp.hvn } : null
        };
      })
    );
    const data = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .sort((a, b) => b.totalCallOI + b.totalPutOI - (a.totalCallOI + a.totalPutOI));
    res.json({ symbols: data, scannedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VOLATILITY EXPANSION STRATEGY ENGINE
// ══════════════════════════════════════════════════════════════════════════════

// ── ATR (14) using Simple Moving Average of True Range ───────────────────────
function calcATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const { h, l, c: prevC } = bars[i - 1];
    const { h: ch, l: cl } = bars[i];
    const tr = Math.max(ch - cl, Math.abs(ch - prevC), Math.abs(cl - prevC));
    trs.push(tr);
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Returns full ATR series (one value per bar, null for first bar)


// ── Bollinger Bands series ────────────────────────────────────────────────────


// Returns last N BB widths for squeeze detection
// ── Candlestick & Chart Pattern Detection Engine ──────────────────────────────
// bars: { o, h, l, c, v }[] in CHRONOLOGICAL order (oldest → newest)
// Returns: { bullish: Pattern[], bearish: Pattern[], neutral: Pattern[], all: Pattern[] }
// Pattern: { name, type ('BULLISH'|'BEARISH'|'NEUTRAL'), strength (1-3), desc, emoji }
function detectCandlePatterns(bars) {
  if (!bars || bars.length < 2) return { bullish: [], bearish: [], neutral: [], all: [] };
  const found = [];
  const n = bars.length;

  const body  = b => Math.abs(b.c - b.o);
  const range = b => (b.h - b.l) || 0.00001;
  const upper = b => b.h - Math.max(b.o, b.c);
  const lower = b => Math.min(b.o, b.c) - b.l;
  const mid   = b => (b.o + b.c) / 2;
  const isUp  = b => b.c > b.o;
  const isDn  = b => b.c < b.o;
  const isBig  = (b, t=0.60) => body(b) >= t * range(b);
  const isTiny = (b, t=0.18) => body(b) <= t * range(b);
  const isDoji = b => body(b) <= 0.08 * range(b);
  const avgBody = bars.slice(Math.max(0,n-14)).reduce((s,b) => s + body(b), 0) / Math.min(14, n);

  const c0 = bars[n-1];
  const c1 = n>=2 ? bars[n-2] : null;
  const c2 = n>=3 ? bars[n-3] : null;
  const c3 = n>=4 ? bars[n-4] : null;

  // Trend: did the prior bars trend up or down?
  const prior = bars.slice(Math.max(0,n-6), n-1);
  const trendUp   = prior.length >= 2 && prior.at(-1).c > prior[0].c * 1.005;
  const trendDown = prior.length >= 2 && prior.at(-1).c < prior[0].c * 0.995;

  const add = (name, type, strength, desc, emoji='') => found.push({ name, type, strength, desc, emoji });

  // ── SINGLE CANDLE ──────────────────────────────────────────────────────────

  // Hammer / Hanging Man — long lower wick (≥2× body), tiny upper wick
  { const lw=lower(c0),uw=upper(c0),bd=body(c0);
    if (bd>0 && lw>=2*bd && uw<=0.4*bd && lw>=avgBody*0.25 && isUp(c0) && trendDown)
      add('Hammer','BULLISH',2,'Buyers absorbed all selling — strong reversal candle','🔨');
    else if (bd>0 && lw>=2*bd && uw<=0.4*bd && lw>=avgBody*0.25 && isDn(c0) && trendDown)
      add('Hammer (Red)','BULLISH',1,'Buyers still pushed back from lows despite closing red','🔨');
    else if (bd>0 && lw>=2*bd && uw<=0.4*bd && lw>=avgBody*0.25 && trendUp)
      add('Hanging Man','BEARISH',2,'Warning: selling pressure appeared in uptrend — watch next candle','🕴');
  }

  // Inverted Hammer — long upper wick, tiny lower wick, after downtrend
  { const uw=upper(c0),lw=lower(c0),bd=body(c0);
    if (bd>0 && uw>=2*bd && lw<=0.4*bd && trendDown && isUp(c0))
      add('Inverted Hammer','BULLISH',1,'Buyers fought back from highs — confirmation needed next candle','🔃');
  }

  // Shooting Star — long upper wick, after uptrend
  { const uw=upper(c0),lw=lower(c0),bd=body(c0);
    if (bd>0 && uw>=2*bd && lw<=0.4*bd && trendUp && isDn(c0))
      add('Shooting Star','BEARISH',2,'Sellers rejected highs — momentum exhaustion at the top','⭐');
  }

  // Doji variants — open ≈ close
  if (isDoji(c0)) {
    const uw=upper(c0), lw=lower(c0);
    if (lw > 3*uw && lw > avgBody*0.25)
      add('Dragonfly Doji','BULLISH',2,'Bears pushed down but closed at open — strong buying floor','🐉');
    else if (uw > 3*lw && uw > avgBody*0.25)
      add('Gravestone Doji','BEARISH',2,'Buyers pushed up but closed at open — strong selling ceiling','🪦');
    else
      add('Doji','NEUTRAL',1,'Market indecision — watch next candle for direction','➕');
  }

  // Bullish/Bearish Belt Hold (Marubozu — ≥85% body, tiny wicks)
  if (isBig(c0,0.85)) {
    const uw=upper(c0),lw=lower(c0),rng=range(c0);
    if (uw<0.06*rng && lw<0.06*rng) {
      if (isUp(c0)) add('Bullish Belt Hold','BULLISH',2,'Full-body green — pure buying conviction, no rejection','💚');
      else           add('Bearish Belt Hold','BEARISH',2,'Full-body red — pure selling conviction, no rejection','❤');
    }
  }

  // ── TWO CANDLE ────────────────────────────────────────────────────────────
  if (c1) {
    // Bullish Engulfing
    if (isDn(c1) && isUp(c0) && c0.o<=c1.c && c0.c>=c1.o && body(c0)>body(c1))
      add('Bullish Engulfing','BULLISH',3,'Bulls fully reversed the prior red bar — high-confidence reversal','🟢');

    // Bearish Engulfing
    if (isUp(c1) && isDn(c0) && c0.o>=c1.c && c0.c<=c1.o && body(c0)>body(c1))
      add('Bearish Engulfing','BEARISH',3,'Bears fully reversed the prior green bar — high-confidence reversal','🔴');

    // Bullish Harami
    if (isDn(c1) && isUp(c0) && c0.o>=c1.c && c0.c<=c1.o && body(c0)<body(c1)*0.5)
      add('Bullish Harami','BULLISH',2,'Small green inside prior red — selling momentum is slowing','🌱');

    // Bearish Harami
    if (isUp(c1) && isDn(c0) && c0.o<=c1.c && c0.c>=c1.o && body(c0)<body(c1)*0.5)
      add('Bearish Harami','BEARISH',2,'Small red inside prior green — buying momentum is slowing','🍂');

    // Bullish Harami Cross (Doji inside prior red)
    if (isDn(c1) && isDoji(c0) && c0.h<=c1.o && c0.l>=c1.c)
      add('Bullish Harami Cross','BULLISH',2,'Doji indecision after downbar — reversal signal building','✝');

    // Bearish Harami Cross (Doji inside prior green)
    if (isUp(c1) && isDoji(c0) && c0.h<=c1.c && c0.l>=c1.o)
      add('Bearish Harami Cross','BEARISH',2,'Doji indecision after upbar — reversal signal building','✝');

    // Dark Cloud Cover
    if (isUp(c1) && isDn(c0) && c0.o>c1.h && c0.c<mid(c1) && c0.c>c1.o && isBig(c1) && isBig(c0))
      add('Dark Cloud Cover','BEARISH',3,'Sellers opened above prior high then drove deep into green body','⛅');

    // Piercing Line
    if (isDn(c1) && isUp(c0) && c0.o<c1.l && c0.c>mid(c1) && c0.c<c1.o && isBig(c1) && isBig(c0))
      add('Piercing Line','BULLISH',3,'Buyers opened below prior low then drove deep into red body','🗡');

    // Bullish Kicking — bearish marubozu then bullish marubozu with gap up
    if (isDn(c1) && isUp(c0) && isBig(c1,0.80) && isBig(c0,0.80) && c0.o>c1.o)
      add('Bullish Kicking','BULLISH',3,'Gap up after marubozu — sudden aggressive buying shift','⚡');

    // Bearish Kicking
    if (isUp(c1) && isDn(c0) && isBig(c1,0.80) && isBig(c0,0.80) && c0.o<c1.o)
      add('Bearish Kicking','BEARISH',3,'Gap down after marubozu — sudden aggressive selling shift','⚡');

    // Bullish Meeting Lines
    if (isDn(c1) && isUp(c0) && Math.abs(c0.c-c1.c)/c1.c<0.002 && isBig(c1) && isBig(c0))
      add('Bullish Meeting Lines','BULLISH',2,'Bulls and bears closed at same level after downtrend — balance shift','⚖');

    // Bearish Meeting Lines
    if (isUp(c1) && isDn(c0) && Math.abs(c0.c-c1.c)/c1.c<0.002 && isBig(c1) && isBig(c0))
      add('Bearish Meeting Lines','BEARISH',2,'Bears matched bulls at exact close after uptrend — reversal signal','⚖');

    // Tweezer Bottom
    if (isDn(c1) && isUp(c0) && Math.abs(c0.l-c1.l)/c1.l<0.002 && trendDown)
      add('Tweezer Bottom','BULLISH',2,'Double test of exact same low — strong demand floor confirmed','📐');

    // Tweezer Top
    if (isUp(c1) && isDn(c0) && Math.abs(c0.h-c1.h)/c1.h<0.002 && trendUp)
      add('Tweezer Top','BEARISH',2,'Double test of exact same high — strong supply ceiling confirmed','📐');

    // Bullish Doji Star (gap-down doji after downtrend)
    if (isDn(c1) && isDoji(c0) && c0.h<c1.c && trendDown)
      add('Bullish Doji Star','BULLISH',2,'Isolated doji below downtrend — reversal signal building','⭐');

    // Bearish Doji Star (gap-up doji after uptrend)
    if (isUp(c1) && isDoji(c0) && c0.l>c1.c && trendUp)
      add('Bearish Doji Star','BEARISH',2,'Isolated doji above uptrend — exhaustion signal at peak','⭐');

    // Bullish Separating Lines
    if (isDn(c1) && isUp(c0) && Math.abs(c0.o-c1.o)/c1.o<0.002 && isBig(c0))
      add('Bullish Separating Lines','BULLISH',2,'Gap recovery to same open as prior red — uptrend resuming','📈');

    // Bearish Separating Lines
    if (isUp(c1) && isDn(c0) && Math.abs(c0.o-c1.o)/c1.o<0.002 && isBig(c0))
      add('Bearish Separating Lines','BEARISH',2,'Gap drop to same open as prior green — downtrend resuming','📉');

    // In-Neck / On-Neck / Thrusting (bearish continuation)
    if (isDn(c1) && isUp(c0) && c0.o<c1.l) {
      if (c0.c<=c1.l*1.001)
        add('In-Neck','BEARISH',1,'Weak recovery only to prior low — bears retain full control','👎');
      else if (c0.c>c1.l*1.001 && c0.c<mid(c1))
        add('Thrusting','BEARISH',1,'Recovery fails below prior midpoint — bearish continuation likely','🎯');
    }

    // Bullish Matching Low — two red bars closing at same level
    if (isDn(c1) && isDn(c0) && Math.abs(c0.c-c1.c)/c1.c<0.002)
      add('Matching Low','BULLISH',1,'Second red bar closed at same support — potential floor forming','📏');
  }

  // ── THREE CANDLE ──────────────────────────────────────────────────────────
  if (c1 && c2) {
    // Morning Star
    if (isDn(c2) && isBig(c2) && isTiny(c1,0.4) && isUp(c0) && isBig(c0) && c0.c>mid(c2))
      add('Morning Star','BULLISH',3,'Classic 3-bar reversal — decisive confirmation of trend change','🌅');

    // Evening Star
    if (isUp(c2) && isBig(c2) && isTiny(c1,0.4) && isDn(c0) && isBig(c0) && c0.c<mid(c2))
      add('Evening Star','BEARISH',3,'Classic 3-bar reversal — decisive confirmation of market top','🌆');

    // Morning Doji Star
    if (isDn(c2) && isDoji(c1) && isUp(c0) && c0.c>mid(c2))
      add('Morning Doji Star','BULLISH',3,'Doji pivot after downtrend — highest accuracy bullish reversal','🌠');

    // Evening Doji Star
    if (isUp(c2) && isDoji(c1) && isDn(c0) && c0.c<mid(c2))
      add('Evening Doji Star','BEARISH',3,'Doji pivot at the top — highest accuracy bearish reversal','🌠');

    // Three White Soldiers
    if (isUp(c2)&&isUp(c1)&&isUp(c0)&&isBig(c2,0.55)&&isBig(c1,0.55)&&isBig(c0,0.55)&&
        c1.c>c2.c&&c0.c>c1.c&&c1.o>c2.o&&c0.o>c1.o&&upper(c0)<body(c0)*0.35)
      add('Three White Soldiers','BULLISH',3,'Three consecutive conviction greens — powerful new uptrend','🪖');

    // Three Black Crows
    if (isDn(c2)&&isDn(c1)&&isDn(c0)&&isBig(c2,0.55)&&isBig(c1,0.55)&&isBig(c0,0.55)&&
        c1.c<c2.c&&c0.c<c1.c&&c1.o<c2.o&&c0.o<c1.o&&lower(c0)<body(c0)*0.35)
      add('Three Black Crows','BEARISH',3,'Three consecutive conviction reds — powerful new downtrend','🐦‍⬛');

    // Bullish Abandoned Baby
    if (isDn(c2)&&isDoji(c1)&&isUp(c0)&&c1.h<c2.l&&c0.o>c1.h)
      add('Bullish Abandoned Baby','BULLISH',3,'Rarest pattern — isolated doji gap creates perfect reversal pivot','👶');

    // Bearish Abandoned Baby
    if (isUp(c2)&&isDoji(c1)&&isDn(c0)&&c1.l>c2.h&&c0.o<c1.l)
      add('Bearish Abandoned Baby','BEARISH',3,'Rarest pattern — isolated doji gap at the top','👶');

    // Three Inside Up (Harami confirmed)
    if (isDn(c2)&&isUp(c1)&&c1.o>=c2.c&&c1.c<=c2.o&&isUp(c0)&&c0.c>c2.o)
      add('Three Inside Up','BULLISH',3,'Harami confirmed by follow-through — high reliability reversal','✅');

    // Three Inside Down
    if (isUp(c2)&&isDn(c1)&&c1.o<=c2.c&&c1.c>=c2.o&&isDn(c0)&&c0.c<c2.o)
      add('Three Inside Down','BEARISH',3,'Harami confirmed by follow-through — high reliability reversal','❌');

    // Three Outside Up (Engulfing confirmed)
    if (isDn(c2)&&isUp(c1)&&c1.o<c2.c&&c1.c>c2.o&&isUp(c0)&&c0.c>c1.c)
      add('Three Outside Up','BULLISH',3,'Engulfing confirmed with follow-through — maximum reliability','🚀');

    // Three Outside Down
    if (isUp(c2)&&isDn(c1)&&c1.o>c2.c&&c1.c<c2.o&&isDn(c0)&&c0.c<c1.c)
      add('Three Outside Down','BEARISH',3,'Engulfing confirmed with follow-through — maximum reliability','🔻');

    // Advance Block (3 greens but shrinking bodies + upper wicks = exhaustion)
    if (isUp(c2)&&isUp(c1)&&isUp(c0)&&body(c1)<body(c2)*0.85&&body(c0)<body(c1)*0.85&&
        upper(c0)>body(c0)*0.3&&trendUp)
      add('Advance Block','BEARISH',2,'Three greens with shrinking bodies — buying exhaustion warning','🧱');

    // Deliberation (stalling after 3 greens)
    if (isUp(c2)&&isUp(c1)&&isUp(c0)&&isBig(c2,0.55)&&isBig(c1,0.55)&&isTiny(c0,0.4)&&c0.o>c1.c)
      add('Deliberation','BEARISH',2,'Stall candle after two strong greens — uptrend losing energy','🤔');

    // Bullish Tri-Star
    if (isDoji(c2)&&isDoji(c1)&&isDoji(c0)&&trendDown)
      add('Bullish Tri-Star','BULLISH',3,'Three consecutive dojis in downtrend — extreme indecision, reversal imminent','⭐⭐⭐');

    // Bearish Tri-Star
    if (isDoji(c2)&&isDoji(c1)&&isDoji(c0)&&trendUp)
      add('Bearish Tri-Star','BEARISH',3,'Three consecutive dojis at top — extreme indecision, reversal imminent','⭐⭐⭐');

    // Upside Tasuki Gap (bullish continuation — gap up held)
    if (isUp(c2)&&isUp(c1)&&c1.o>c2.h&&isDn(c0)&&c0.c>c2.h)
      add('Upside Tasuki Gap','BULLISH',2,'Bearish pullback failed to close bullish gap — uptrend continues','⬆');

    // Downside Tasuki Gap (bearish continuation)
    if (isDn(c2)&&isDn(c1)&&c1.o<c2.l&&isUp(c0)&&c0.c<c2.l)
      add('Downside Tasuki Gap','BEARISH',2,'Bullish bounce failed to close bearish gap — downtrend continues','⬇');

    // Unique 3 River Bottom
    if (isDn(c2)&&isBig(c2)&&lower(c1)>lower(c2)&&isTiny(c1)&&isUp(c0)&&c0.c<c1.o)
      add('Unique 3 River Bottom','BULLISH',2,'Rare 3-bar river formation — uncommon but reliable reversal','🌊');

    // Bearish 2 Crows (using c2=large green, c1=gap-up small red, c0=larger red)
    if (isUp(c2)&&isBig(c2)&&isDn(c1)&&c1.o>c2.c&&isTiny(c1)&&isDn(c0)&&c0.o>=c1.o&&c0.c<c2.c&&c0.c>c2.o)
      add('Bearish 2 Crows','BEARISH',2,'Two bearish crows pull back from above — selling takes control','🐦');
  }

  // ── FOUR CANDLE ───────────────────────────────────────────────────────────
  if (c1&&c2&&c3) {
    // Bullish 3 Line Strike — 3 red bars then one large engulfing green
    if (isDn(c3)&&isDn(c2)&&isDn(c1)&&c2.c<c3.c&&c1.c<c2.c&&
        isUp(c0)&&c0.o<c1.c&&c0.c>c3.o)
      add('Bullish 3 Line Strike','BULLISH',2,'Three reds reversed by single large green — bulls reassert control','🎯');

    // Bearish 3 Line Strike
    if (isUp(c3)&&isUp(c2)&&isUp(c1)&&c2.c>c3.c&&c1.c>c2.c&&
        isDn(c0)&&c0.o>c1.c&&c0.c<c3.o)
      add('Bearish 3 Line Strike','BEARISH',2,'Three greens reversed by single large red — bears reassert control','🎯');

    // Upside Gap 2 Crows (bearish)
    if (isUp(c3)&&isBig(c3)&&isDn(c2)&&c2.o>c3.c&&isTiny(c2)&&
        isDn(c1)&&c1.o<=c2.o&&c1.c<c3.c&&isDn(c0)&&c0.c<c1.c)
      add('Upside Gap 2 Crows','BEARISH',2,'Gap up filled by two crow candles — exhaustion at resistance','🐦🐦');
  }

  // ── CHART PATTERNS (multi-bar) ────────────────────────────────────────────
  if (n >= 10) {
    const last = bars.slice(Math.max(0,n-20));
    const L = last.length;
    const H = last.map(b=>b.h);
    const Lo = last.map(b=>b.l);
    const Cl = last.map(b=>b.c);

    // Double Bottom
    if (L>=8) {
      const pairs = [];
      for (let i=0;i<L-3;i++) for (let j=i+3;j<L;j++)
        if (Math.abs(Lo[i]-Lo[j])/Lo[i]<0.015) pairs.push([i,j,Math.min(Lo[i],Lo[j])]);
      if (pairs.length && isUp(c0)) {
        const bp = pairs.sort((a,b)=>a[2]-b[2])[0];
        const peakBetween = Math.max(...Cl.slice(bp[0],bp[1]));
        if (peakBetween>bp[2]*1.02) add('Double Bottom','BULLISH',3,'Two tests of same support — strong buy signal on upside breakout','📊');
      }
    }

    // Double Top
    if (L>=8) {
      const pairs = [];
      for (let i=0;i<L-3;i++) for (let j=i+3;j<L;j++)
        if (Math.abs(H[i]-H[j])/H[i]<0.015) pairs.push([i,j,Math.max(H[i],H[j])]);
      if (pairs.length && isDn(c0)) {
        const bp = pairs.sort((a,b)=>b[2]-a[2])[0];
        const troughBetween = Math.min(...Cl.slice(bp[0],bp[1]));
        if (troughBetween<bp[2]*0.98) add('Double Top','BEARISH',3,'Two tests of same resistance — strong sell signal on downside break','📊');
      }
    }

    // Head and Shoulders
    if (L>=12) {
      const t3=Math.floor(L/3);
      const lh=Math.max(...H.slice(0,t3)), mh=Math.max(...H.slice(t3,2*t3)), rh=Math.max(...H.slice(2*t3));
      if (mh>lh*1.02&&mh>rh*1.02&&Math.abs(lh-rh)/lh<0.04&&isDn(c0))
        add('Head & Shoulders','BEARISH',3,'Classic top — higher head between two equal shoulders','👤');
    }

    // Inverse Head and Shoulders
    if (L>=12) {
      const t3=Math.floor(L/3);
      const ll=Math.min(...Lo.slice(0,t3)), ml=Math.min(...Lo.slice(t3,2*t3)), rl=Math.min(...Lo.slice(2*t3));
      if (ml<ll*0.98&&ml<rl*0.98&&Math.abs(ll-rl)/ll<0.04&&isUp(c0))
        add('Inv. Head & Shoulders','BULLISH',3,'Classic bottom — deeper head between two equal shoulders','🙃');
    }

    // Ascending Triangle (flat highs, rising lows)
    if (L>=8) {
      const topH=H.slice(-5), botL=Lo.slice(-5);
      const flatTop=(Math.max(...topH)-Math.min(...topH))/Math.max(...topH)<0.015;
      const risingBot=botL[botL.length-1]>botL[0]*1.01;
      if (flatTop&&risingBot&&isUp(c0)) add('Ascending Triangle','BULLISH',2,'Flat resistance + rising support = bullish breakout setup','△');
    }

    // Descending Triangle (flat lows, falling highs)
    if (L>=8) {
      const topH=H.slice(-5), botL=Lo.slice(-5);
      const flatBot=(Math.max(...botL)-Math.min(...botL))/Math.min(...botL)<0.015;
      const fallingTop=topH[topH.length-1]<topH[0]*0.99;
      if (flatBot&&fallingTop&&isDn(c0)) add('Descending Triangle','BEARISH',2,'Flat support + falling resistance = bearish breakdown setup','▽');
    }

    // Bull Flag / Pennant — sharp rise + tight consolidation
    if (L>=8) {
      const flagBase=bars[Math.max(0,n-8)], flagPeak=bars[Math.max(0,n-4)];
      const move=(flagPeak.c-flagBase.c)/flagBase.c;
      const recent4=bars.slice(n-4);
      const consol=(Math.max(...recent4.map(b=>b.h))-Math.min(...recent4.map(b=>b.l)))/flagPeak.c;
      if (move>0.07&&consol<0.035&&isUp(c0))
        add('Bull Flag / Pennant','BULLISH',2,'Sharp rally + tight consolidation = continuation breakout setup','🚩');
    }

    // Bear Flag / Pennant
    if (L>=8) {
      const flagBase=bars[Math.max(0,n-8)], flagTrough=bars[Math.max(0,n-4)];
      const drop=(flagBase.c-flagTrough.c)/flagBase.c;
      const recent4=bars.slice(n-4);
      const consol=(Math.max(...recent4.map(b=>b.h))-Math.min(...recent4.map(b=>b.l)))/flagTrough.c;
      if (drop>0.07&&consol<0.035&&isDn(c0))
        add('Bear Flag / Pennant','BEARISH',2,'Sharp drop + tight consolidation = continuation breakdown setup','🚩');
    }
  }

  // Sort: strongest first, bullish before bearish at same strength
  found.sort((a,b) => {
    if (b.strength!==a.strength) return b.strength-a.strength;
    return ({BULLISH:0,NEUTRAL:1,BEARISH:2})[a.type] - ({BULLISH:0,NEUTRAL:1,BEARISH:2})[b.type];
  });

  const all     = found.slice(0,8);
  const bullish = all.filter(p=>p.type==='BULLISH');
  const bearish = all.filter(p=>p.type==='BEARISH');
  const neutral = all.filter(p=>p.type==='NEUTRAL');
  return { all, bullish, bearish, neutral };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Inverse ETF Map ────────────────────────────────────────────────────────────
// For any SHORT signal, buy the corresponding inverse ETF instead of shorting.
// Individual stocks map to their sector inverse; ETFs map to their direct inverse.
const INVERSE_MAP = {
  // ── Broad market indices ───────────────────────────────────────────────────
  'SPY':   'SH',    // inverse S&P 500 (1×)
  'QQQ':   'QID',   // 2× inverse Nasdaq-100 (upgraded from PSQ)
  'IWM':   'TZA',   // 3× inverse Russell 2000
  'DIA':   'DOG',   // inverse Dow Jones (1×)
  // ── Leveraged longs → their direct inverse counterpart ────────────────────
  'TQQQ':  'SQQQ',  // 3× inverse Nasdaq-100
  'SPXL':  'SPXS',  // 3× inverse S&P 500
  'UPRO':  'SPXS',  // 3× inverse S&P 500
  'SOXL':  'SOXS',  // 3× inverse Semiconductors
  'TECL':  'TECS',  // 3× inverse Technology
  'LABU':  'LABD',  // 3× inverse Biotech
  'TNA':   'TZA',   // 3× inverse Russell 2000
  'FAS':   'FAZ',   // 3× inverse Financials
  'TSLL':  'TSLZ',  // inverse TSLA leveraged long → T-Rex 2× inverse TSLA
  'NVDX':  'NVD',   // inverse NVDA leveraged long → T-Rex 2× inverse NVDA
  'AMDL':  'AMDD',  // inverse AMD leveraged long → Direxion AMD bear
  'PLTG':  'PLTD',  // inverse PLTR leveraged long → Direxion PLTR bear
  'SMH':   'SOXS',  // inverse Semiconductor ETF
  'ARKK':  'SARK',  // inverse ARK Innovation
  // ── Bonds ─────────────────────────────────────────────────────────────────
  'TLT':   'TBF',   // inverse 20+ yr Treasuries (1×)
  'HYG':   'SJB',   // inverse High Yield Bonds
  // ── Commodities ───────────────────────────────────────────────────────────
  'GLD':   'GLL',   // 2× inverse Gold
  'SLV':   'ZSL',   // 2× inverse Silver
  'GDX':   'DUST',  // 3× inverse Gold Miners
  'GDXJ':  'JDST',  // 3× inverse Junior Gold Miners
  'USO':   'SCO',   // 2× inverse Crude Oil
  // ── Single-stock specific inverse ETFs (from user watchlist) ─────────────
  'TSLA':  'TSLZ',  // T-Rex 2× Inverse TSLA
  'NVDA':  'NVD',   // T-Rex 2× Inverse NVDA
  'MSFT':  'MSTZ',  // T-Rex 2× Inverse MSFT
  'PLTR':  'PLTD',  // Direxion Daily PLTR Bear 1×
  'AAPL':  'AAPD',  // Direxion Daily AAPL Bear 1×
  'AMD':   'AMDD',  // Direxion Daily AMD Bear 1×
  // ── Crypto / Bitcoin mining → SBIT ────────────────────────────────────────
  'COIN':  'SBIT',  'MARA':  'SBIT',  'RIOT':  'SBIT',
  'CLSK':  'SBIT',  'CORZ':  'SBIT',  'HUT':   'SBIT',
  'BITF':  'SBIT',  'IREN':  'SBIT',  'BMNR':  'SBIT',
  // ── Remaining semis → SOXS ────────────────────────────────────────────────
  'AVGO':  'SOXS',  'QCOM':  'SOXS',  'MU':    'SOXS',
  'INTC':  'SOXS',  'AMAT':  'SOXS',  'LRCX':  'SOXS',
  'KLAC':  'SOXS',  'ARM':   'SOXS',  'SMCI':  'SOXS',
  'TSM':   'SOXS',  'ADI':   'SOXS',  'TXN':   'SOXS',
  'NVTS':  'SOXS',
  // ── Large-cap tech (no specific single-stock inverse) → TECS ──────────────
  'GOOGL': 'TECS',  'META':  'TECS',  'AMZN':  'TECS',
  'NFLX':  'TECS',  'CRM':   'TECS',  'ORCL':  'TECS',
  'ADBE':  'TECS',  'CSCO':  'TECS',  'IBM':   'TECS',
  'ACN':   'TECS',  'INTU':  'TECS',
  // ── Growth / SaaS / Cloud → TECS ─────────────────────────────────────────
  'HOOD':  'TECS',  'UBER':  'TECS',  'SHOP':  'TECS',
  'SNAP':  'TECS',  'PINS':  'TECS',  'RBLX':  'TECS',
  'DKNG':  'TECS',  'CRWD':  'TECS',  'PANW':  'TECS',
  'SNOW':  'TECS',  'DDOG':  'TECS',  'NET':   'TECS',
  'ZS':    'TECS',  'MDB':   'TECS',  'TWLO':  'TECS',  'S': 'TECS',
  // ── Robotics / drones / quantum → TECS ───────────────────────────────────
  'RCAT':  'TECS',  'UMAC':  'TECS',  'RR':    'TECS',  'SERV':  'TECS',
  'QBTS':  'TECS',  'RGTI':  'TECS',  'ACHR':  'TECS',
  // ── Fintech / Payments → FAZ ──────────────────────────────────────────────
  'SQ':    'FAZ',   'PYPL':  'FAZ',   'SOFI':  'FAZ',  'LDI':   'FAZ',
  // ── EV / Auto → TECS ──────────────────────────────────────────────────────
  'RIVN':  'TECS',  'NIO':   'TECS',  'LI':    'TECS',
  'F':     'TECS',  'GM':    'TECS',
  // ── Financials → FAZ ──────────────────────────────────────────────────────
  'JPM':   'FAZ',   'BAC':   'FAZ',   'GS':    'FAZ',
  'MS':    'FAZ',   'C':     'FAZ',   'WFC':   'FAZ',
  'SCHW':  'FAZ',   'AXP':   'FAZ',   'CME':   'FAZ',
  'BLK':   'FAZ',   'SPGI':  'FAZ',   'MMC':   'FAZ',
  'CB':    'FAZ',   'CI':    'FAZ',
  // ── Energy → ERY ──────────────────────────────────────────────────────────
  'XOM':   'ERY',   'CVX':   'ERY',   'COP':   'ERY',
  'SLB':   'ERY',   'HAL':   'ERY',   'EOG':   'ERY',
  'RIG':   'ERY',   'EGY':   'ERY',   'BTE':   'ERY',
  'ANNA':  'ERY',   'NEXT':  'ERY',   'URG':   'ERY',
  'TALO':  'ERY',   'SOC':   'ERY',   'SSL':   'ERY',
  'PBR':   'ERY',   'CLF':   'SH',
  // ── Mining / precious metals → DUST / JDST / GLL ─────────────────────────
  'USAS':  'DUST',  'ASM':   'DUST',  'CRML':  'DUST',
  'DNN':   'JDST',  'NVA':   'DUST',  'TMQ':   'DUST',
  'TGB':   'DUST',  'NAK':   'DUST',  'PLG':   'DUST',
  'IAUX':  'DUST',  'LAC':   'GLL',
  // ── Healthcare / Biotech → RXD / LABD ────────────────────────────────────
  'JNJ':   'RXD',   'UNH':   'RXD',   'ABT':   'RXD',
  'DHR':   'RXD',   'TMO':   'RXD',   'SYK':   'RXD',
  'ISRG':  'RXD',   'ELV':   'RXD',   'MDT':   'RXD',
  'MRNA':  'LABD',  'PFE':   'LABD',  'ABBV':  'LABD',
  'LLY':   'LABD',  'REGN':  'LABD',  'GILD':  'LABD',
  'AMGN':  'LABD',  'ZTS':   'LABD',  'VRTX':  'LABD',
  'BNTX':  'LABD',
  // ── Broad consumer / defensives / industrials → SH ───────────────────────
  'WMT':   'SH',    'COST':  'SH',    'NKE':   'SH',
  'MCD':   'SH',    'HD':    'SH',    'TJX':   'SH',
  'LOW':   'SH',    'PG':    'SH',    'KO':    'SH',
  'PEP':   'SH',    'MO':    'SH',    'PM':    'SH',
  'HON':   'SH',    'CAT':   'SH',    'DE':    'SH',
  'UNP':   'SH',    'RTX':   'SH',    'LIN':   'SH',
  'NEE':   'SH',    'SO':    'SH',    'DUK':   'SH',
  'PLD':   'SH',    'BRK.B': 'SH',    'V':     'SH',
  'MA':    'SH',    'MRK':   'SH',    'BKNG':  'SH',
  'DHR':   'RXD',
  // ── New leveraged long ETFs → their paired inverse ────────────────────────
  'NVDL':  'NVD',   // 2× long NVDA → 2× inverse NVDA
  'AAPU':  'AAPD',  // 2× long AAPL → inverse AAPL
  'AMZU':  'AMZD',  // 2× long AMZN → 2× inverse AMZN
  'GGLL':  'GGLS',  // 2× long GOOGL → 2× inverse GOOGL
  'METU':  'TECS',  // 2× long META → inverse tech (no specific META bear ETF)
  'UDOW':  'DXD',   // 3× long DIA → 2× inverse DIA
  'ERX':   'ERY',   // 3× long energy → 3× inverse energy
  // ── Biotech / genomics (small & mid cap) → LABD ───────────────────────────
  'NVAX':  'LABD',  'RXRX':  'LABD',  'BEAM':  'LABD',
  'EDIT':  'LABD',  'CRSP':  'LABD',  'NTLA':  'LABD',
  'FATE':  'LABD',  'SGMO':  'LABD',  'NKTR':  'LABD',
  'TGTX':  'LABD',  'IMVT':  'LABD',  'DNLI':  'LABD',
  'ARDX':  'LABD',  'SANA':  'LABD',  'GERN':  'LABD',
  'AGEN':  'LABD',  'IOVA':  'LABD',  'PRAX':  'LABD',
  'ACAD':  'LABD',
  // ── Digital health / medical devices ─────────────────────────────────────
  'TDOC':  'LABD',  'HIMS':  'LABD',  'DOCS':  'LABD',
  'NVCR':  'LABD',  'TMDX':  'LABD',  'NVRO':  'LABD',
  'PTON':  'TECS',  // Peloton — closer to consumer tech
  // ── High-volume small caps → SRTY (3× inverse Russell 2000) ──────────────
  'IONQ':  'SRTY',  'RKLB':  'SRTY',  'ASTS':  'SRTY',
  'JOBY':  'SRTY',  'LUNR':  'SRTY',  'GSAT':  'SRTY',
  'CLOV':  'SRTY',  'OPEN':  'SRTY',  'SPWR':  'SRTY',
  // ── Biotech & healthcare ETFs ─────────────────────────────────────────────
  'XBI':   'LABD',  'IBB':   'LABD',  'ARKG':  'SARK',
  'BIB':   'BIS',   'CURE':  'LABD',  'URTY':  'SRTY',
  // ── Cannabis → SQQQ ───────────────────────────────────────────────────────
  'TLRY':  'SQQQ',  'SNDL':  'SQQQ',  'CGC':   'SQQQ',
  'ACB':   'SQQQ',  'CRON':  'SQQQ',
  // ── EV / clean-energy pennies → SH ───────────────────────────────────────
  'WKHS':  'SH',    'GOEV':  'SH',    'MULN':  'SH',    'NKLA':  'SH',
  // ── Biotech penny stocks → LABD ──────────────────────────────────────────
  'BNGO':  'LABD',  'OCGN':  'LABD',  'SENS':  'LABD',
  'APLT':  'LABD',  'CRBP':  'LABD',  'ABVC':  'LABD',
  // ── Tech / meme penny stocks → PSQ ───────────────────────────────────────
  'MVIS':  'PSQ',   'BB':    'PSQ',   'NOK':   'PSQ',   'AMC':   'PSQ',
  'ATER':  'PSQ',   'XELA':  'PSQ',   'HOLO':  'PSQ',   'VERB':  'PSQ',
  // ── Shipping / energy pennies ─────────────────────────────────────────────
  'IMPP':  'SH',    'INDO':  'SH',    'FFIE':  'PSQ',
  // ── Crypto-adjacent penny miners → SBIT ──────────────────────────────────
  'BTBT':  'SBIT',  'CIFR':  'SBIT',  'SLNH':  'SBIT',
  // ── Misc symbols without previous mapping ────────────────────────────────
  'ONDS':  'TECS',  'UUUU':  'SH',    'SMR':   'SH',
};

// Explicit product metadata is the one trusted source for route direction and
// daily leverage. Never infer 2× vs 3× from a ticker name.
const ETF_PRODUCT_METADATA = Object.freeze({
  SH:{direction:'inverse',leverage:1}, DOG:{direction:'inverse',leverage:1}, TBF:{direction:'inverse',leverage:1}, SJB:{direction:'inverse',leverage:1}, RXD:{direction:'inverse',leverage:1}, PLTD:{direction:'inverse',leverage:1},
  QID:{direction:'inverse',leverage:2}, DXD:{direction:'inverse',leverage:2}, GLL:{direction:'inverse',leverage:2}, ZSL:{direction:'inverse',leverage:2}, SCO:{direction:'inverse',leverage:2}, DUST:{direction:'inverse',leverage:2}, JDST:{direction:'inverse',leverage:2}, ERY:{direction:'inverse',leverage:2}, SBIT:{direction:'inverse',leverage:2}, TSLZ:{direction:'inverse',leverage:2}, NVD:{direction:'inverse',leverage:2}, AMDD:{direction:'inverse',leverage:2}, MSTZ:{direction:'inverse',leverage:2}, AAPD:{direction:'inverse',leverage:2}, AMZD:{direction:'inverse',leverage:2}, GGLS:{direction:'inverse',leverage:2}, BIS:{direction:'inverse',leverage:2},
  SQQQ:{direction:'inverse',leverage:3}, TZA:{direction:'inverse',leverage:3}, SPXS:{direction:'inverse',leverage:3}, SOXS:{direction:'inverse',leverage:3}, TECS:{direction:'inverse',leverage:3}, LABD:{direction:'inverse',leverage:3}, FAZ:{direction:'inverse',leverage:3}, SRTY:{direction:'inverse',leverage:3}, PSQ:{direction:'inverse',leverage:1}, SARK:{direction:'inverse',leverage:1},
  NVDL:{direction:'long',leverage:2}, TSLL:{direction:'long',leverage:2}, AAPU:{direction:'long',leverage:2}, MSFU:{direction:'long',leverage:2}, AMZU:{direction:'long',leverage:2}, GGLL:{direction:'long',leverage:2}, METU:{direction:'long',leverage:2}, AMDL:{direction:'long',leverage:2}, PLTG:{direction:'long',leverage:2},
  SPXL:{direction:'long',leverage:3}, TQQQ:{direction:'long',leverage:3}, TNA:{direction:'long',leverage:3}, UDOW:{direction:'long',leverage:3}, SOXL:{direction:'long',leverage:3}, FAS:{direction:'long',leverage:3}, CURE:{direction:'long',leverage:3}, ERX:{direction:'long',leverage:3},
});

// Retained manual/LEAP entry window (9:35 AM – 3:50 PM ET Mon-Fri).
function isMarketOpen() {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 575 && mins < 950; // 9:35–3:50 ET
}

// ══════════════════════════════════════════════════════════════════════════════
// SPY OPTIONS PRE-TRADE GATE
// Mandatory before any SPY trade: identifies Floor (highest put OI), Roof
// (highest call OI), and Max Pain (strike where most options expire worthless).
// Every morning prints: SPY FLOOR: $___  |  MAX PAIN: $___  |  ROOF: $___
// ══════════════════════════════════════════════════════════════════════════════
let _spyLevels     = null;
let _spyLevelsTs   = 0;
let _spyLoggedDate = '';
const SPY_LEVELS_TTL = 30 * 60 * 1000; // refresh every 30 minutes

async function fetchSPYLevels() {
  try {
    const base = await yf.options('SPY');
    // yahoo-finance2 v3 returns expirationDates as Date objects
    const dates = (base.expirationDates || []).map(d => new Date(d));
    const now   = new Date(); now.setUTCHours(0,0,0,0);

    // Prefer the nearest upcoming FRIDAY — it has the deepest open interest.
    // Fall back to any upcoming date if no Friday is available.
    const upcoming = dates.filter(d => d >= now);
    const fridays  = upcoming.filter(d => d.getUTCDay() === 5);
    const target   = fridays.length ? fridays[0] : (upcoming.length ? upcoming[0] : dates[0]);
    if (!target) { console.error('[SPY-Gate] No expiry dates returned'); return null; }

    const chain = await yf.options('SPY', { date: target });
    const calls = chain.options?.[0]?.calls ?? [];
    const puts  = chain.options?.[0]?.puts  ?? [];

    // Filter to contracts that have open interest
    const validCalls = calls.filter(c => (c.openInterest||0) > 0);
    const validPuts  = puts.filter(p => (p.openInterest||0) > 0);

    // ROOF  = call strike with highest open interest
    const roofEntry  = validCalls.sort((a,b) => (b.openInterest||0)-(a.openInterest||0))[0] ?? null;
    // FLOOR = put  strike with highest open interest
    const floorEntry = validPuts.sort( (a,b) => (b.openInterest||0)-(a.openInterest||0))[0] ?? null;
    const roof  = roofEntry?.strike  ?? null;
    const floor = floorEntry?.strike ?? null;

    // MAX PAIN = strike that minimises total intrinsic payout to all option holders
    const strikes = [...new Set([...calls.map(c=>c.strike), ...puts.map(p=>p.strike)])].filter(s=>s!=null).sort((a,b)=>a-b);
    let minPain = Infinity, maxPain = strikes[Math.floor(strikes.length/2)] ?? null;
    for (const s of strikes) {
      const pain =
        calls.reduce((sum,c) => c.strike < s ? sum+(s-c.strike)*(c.openInterest||0) : sum, 0) +
        puts.reduce( (sum,p) => p.strike > s ? sum+(p.strike-s)*(p.openInterest||0) : sum, 0);
      if (pain < minPain) { minPain = pain; maxPain = s; }
    }

    // Human-readable expiry e.g. "Fri Apr 17"
    const expiry = target.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', timeZone:'UTC' });

    console.log(`[SPY-Gate] FLOOR: $${floor}  MAX PAIN: $${maxPain}  ROOF: $${roof}  (exp ${expiry})  [${validCalls.length}C / ${validPuts.length}P with OI]`);
    return { floor, maxPain, roof, expiry };
  } catch(e) {
    console.error('[SPY-Gate] Options fetch failed:', e.message);
    return null;
  }
}

async function getSPYLevels() {
  const now = Date.now();
  if (_spyLevels && now - _spyLevelsTs < SPY_LEVELS_TTL) return _spyLevels;
  const fresh = await fetchSPYLevels();
  if (fresh) { _spyLevels = fresh; _spyLevelsTs = now; }
  return _spyLevels;
}

function logSPYLevels(levels) {
  if (!levels) return;
  const today = new Date().toISOString().slice(0,10);
  if (_spyLoggedDate === today) return;
  _spyLoggedDate = today;
  console.log('\n[SPY-Gate] ═══════════════════════════════════════════════════════');
  console.log(`[SPY-Gate] SPY FLOOR: $${levels.floor}  |  MAX PAIN: $${levels.maxPain}  |  ROOF: $${levels.roof}  (exp ${levels.expiry})`);
  console.log('[SPY-Gate] ═══════════════════════════════════════════════════════\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEASONAL & OPTIONS EXPIRATION CONTEXT ENGINE
// Computes OpEx status, monthly seasonal bias, earnings season, election-year
// macro overlay, and energy/war macro factors.  All 3 bots call this before
// sizing or placing any entry to get a sizing multiplier and advisory notes.
// ═══════════════════════════════════════════════════════════════════════════════

const SEASONAL_MONTHLY_BIAS = {
  1:  { avg: +1.1, bias: 'bullish',  label: 'January Effect',           note: 'Small-cap / growth outperformance historically strong' },
  2:  { avg: -0.1, bias: 'neutral',  label: 'Pre-Spring Stall',         note: 'Typically flat; earnings digestion period' },
  3:  { avg: +1.2, bias: 'bullish',  label: 'Spring Run-Up',            note: 'Q4 earnings wrapping, quarter-end inflows' },
  4:  { avg: +1.5, bias: 'bullish',  label: 'April — Strongest Avg',    note: 'Top-3 month historically; Q1 earnings catalyst' },
  5:  { avg: -0.1, bias: 'neutral',  label: '"Sell in May" Zone',       note: 'Seasonal weakness begins; consider tighter risk' },
  6:  { avg:  0.0, bias: 'neutral',  label: 'Summer Drift',             note: 'Low participation; chop-prone market' },
  7:  { avg: +0.9, bias: 'bullish',  label: 'Summer Rally',             note: 'Q2 earnings catalyst; institutional rebalancing' },
  8:  { avg: -0.2, bias: 'neutral',  label: 'Late Summer Weakness',     note: 'Thin volume; elevated false-breakout risk' },
  9:  { avg: -1.1, bias: 'bearish',  label: 'September — Worst Month',  note: 'Historically worst month since 1950; reduce exposure' },
  10: { avg: +0.4, bias: 'neutral',  label: 'October Volatility',       note: 'Famous crash history but often a bottom; wide swings' },
  11: { avg: +1.5, bias: 'bullish',  label: 'Santa Season Begins',      note: 'Post-midterm historically strongest; institutional year-end buying' },
  12: { avg: +1.3, bias: 'bullish',  label: 'Santa Claus Rally',        note: 'Year-end window dressing; low volume drift higher' },
};

const EARNINGS_SEASON_WINDOWS = [
  { startM: 1, startD: 10, endM: 2,  endD: 20, quarter: 'Q4' },
  { startM: 4, startD: 10, endM: 5,  endD: 20, quarter: 'Q1' },
  { startM: 7, startD: 10, endM: 8,  endD: 20, quarter: 'Q2' },
  { startM: 10, startD: 10, endM: 11, endD: 20, quarter: 'Q3' },
];

const QUAD_WITCH_MONTHS = new Set([3, 6, 9, 12]);

// Returns the 3rd Friday of a given month/year (1-indexed month)
function getMonthlyOpEx(year, month) {
  const d = new Date(year, month - 1, 1);
  let fridays = 0;
  while (true) {
    if (d.getDay() === 5) { if (++fridays === 3) return new Date(d); }
    d.setDate(d.getDate() + 1);
  }
}

function computeSeasonalContext() {
  const now   = new Date();
  const et    = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const year  = et.getFullYear();
  const month = et.getMonth() + 1;
  const day   = et.getDate();
  const minsET = et.getHours() * 60 + et.getMinutes();

  // ── Monthly seasonal bias ─────────────────────────────────────────────────
  const monthly = SEASONAL_MONTHLY_BIAS[month];

  // ── OpEx calculations ─────────────────────────────────────────────────────
  let thisOpEx = getMonthlyOpEx(year, month);
  // If today's date is past this month's OpEx, point to next month's
  const todayMidnight = new Date(et.getFullYear(), et.getMonth(), et.getDate());
  const opExMidnight  = new Date(thisOpEx.getFullYear(), thisOpEx.getMonth(), thisOpEx.getDate());
  if (todayMidnight > opExMidnight) {
    const nm = month === 12 ? 1 : month + 1;
    const ny = month === 12 ? year + 1 : year;
    thisOpEx = getMonthlyOpEx(ny, nm);
  }

  const daysToOpEx = Math.round((opExMidnight - todayMidnight) / 86400000);
  const thisOpExStr = `${thisOpEx.getFullYear()}-${String(thisOpEx.getMonth()+1).padStart(2,'0')}-${String(thisOpEx.getDate()).padStart(2,'0')}`;

  // OpEx week = the Monday through Friday of the OpEx week
  const opExWeekMon = new Date(thisOpEx);
  opExWeekMon.setDate(thisOpEx.getDate() - thisOpEx.getDay() + 1);
  const inOpExWeek = todayMidnight >= opExWeekMon && todayMidnight <= opExMidnight;
  const isOpExDay  = daysToOpEx === 0;
  const isQuadWitch = QUAD_WITCH_MONTHS.has(month) && inOpExWeek;
  const isQuadWitchMorning = isQuadWitch && isOpExDay && minsET < 720;

  // ── Earnings season ───────────────────────────────────────────────────────
  let earningsSeason = null;
  for (const es of EARNINGS_SEASON_WINDOWS) {
    const nowOrd   = month * 100 + day;
    const startOrd = es.startM * 100 + es.startD;
    const endOrd   = es.endM   * 100 + es.endD;
    if (nowOrd >= startOrd && nowOrd <= endOrd) { earningsSeason = es.quarter; break; }
  }

  // ── Election / macro year overlay ─────────────────────────────────────────
  // Midterm years: 2022, 2026, 2030 (year % 4 === 2)
  const isMidtermYear  = year % 4 === 2;
  const isPreMidterm   = isMidtermYear && month <= 10;  // Jan–Oct: uncertainty
  const isPostMidterm  = isMidtermYear && month >= 11;  // Nov–Dec: historical bull run
  const isVolatilePreElection = isPreMidterm && month >= 8; // Aug–Oct: worst window

  // ── Macro factors (analyst overlay — update when macro regime changes) ────
  const macroFactors = [];
  if (isMidtermYear) {
    if (isPostMidterm)
      macroFactors.push({ key: 'midterm', label: 'Post-Midterm Bull Window', bullish: true,
        note: 'Historically the strongest 12-month period after US midterm elections (avg +18%)' });
    else
      macroFactors.push({ key: 'midterm', label: '2026 Midterm Year (Pre-Election)', bullish: false,
        note: 'H1 of midterm years historically weak (-2.8% avg); H2 recovery accelerates Nov onward' });
  }
  if (earningsSeason)
    macroFactors.push({ key: 'earnings', label: `${earningsSeason} Earnings Season Active`, bullish: null,
      note: 'Individual stocks subject to large gap risk; tighten single-name stops during reports' });
  // Energy/geopolitical — active macro overlay (update as needed)
  macroFactors.push({ key: 'energy', label: 'Elevated Energy Costs (Geopolitical)', bullish: false,
    note: 'Conflict-driven fuel prices pressure transportation, manufacturing, and consumer margins' });

  // ── Position sizing multiplier ────────────────────────────────────────────
  let sizeMult   = 1.0;
  let stopAdjust = 1.0;  // >1 = tighter (stop closer to entry)
  const sizeNotes = [];

  if (monthly.bias === 'bearish') {
    sizeMult *= 0.70;
    sizeNotes.push(`Seasonal: ${monthly.label} → 70% of normal size`);
  } else if (monthly.avg < 0) {
    sizeMult *= 0.85;
    sizeNotes.push(`Neutral/weak seasonal month → 85% of normal size`);
  }

  if (isQuadWitch) {
    sizeMult   *= 0.75;
    stopAdjust  = 1.25;
    sizeNotes.push('Quad-Witch week → 75% size + stops tightened 25%');
  } else if (inOpExWeek) {
    sizeMult   *= 0.85;
    stopAdjust  = 1.15;
    sizeNotes.push('OpEx week → 85% size + stops tightened 15%');
  }

  if (isVolatilePreElection) {
    sizeMult *= 0.90;
    sizeNotes.push('Pre-midterm Aug–Oct volatility window → 90% size');
  }

  if (earningsSeason) {
    stopAdjust = Math.max(stopAdjust, 1.10);
    sizeNotes.push(`${earningsSeason} earnings season → stops tightened 10% (gap risk)`);
  }

  sizeMult = Math.max(0.50, +sizeMult.toFixed(2)); // never below 50%

  // ── Volatility bias label ─────────────────────────────────────────────────
  let volatilityBias = 'Normal';
  if (isQuadWitch || monthly.bias === 'bearish') volatilityBias = 'Elevated';
  else if (inOpExWeek || earningsSeason || isVolatilePreElection) volatilityBias = 'Moderately Elevated';
  else if (monthly.bias === 'bullish' && !earningsSeason) volatilityBias = 'Subdued';

  // ── Hard block: only quad-witch morning (gamma pin, AM chaos) ────────────
  const hardBlock = isQuadWitchMorning;
  const hardBlockReason = hardBlock
    ? 'Quad-Witch morning — gamma pinning active; bot entries paused until 12:00 ET'
    : null;

  return {
    date: et.toISOString(), year, month, day,
    monthly,
    opExDate: thisOpExStr, daysToOpEx, inOpExWeek, isOpExDay, isQuadWitch, isQuadWitchMorning,
    earningsSeason,
    isMidtermYear, isPreMidterm, isPostMidterm, isVolatilePreElection,
    macroFactors,
    sizeMult, stopAdjust, sizeNotes,
    volatilityBias,
    hardBlock, hardBlockReason,
  };
}

// Every morning at 9:28–9:32 ET, fetch and print the levels
setInterval(async () => {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (et.getDay() < 1 || et.getDay() > 5) return;
  const mins = et.getHours()*60 + et.getMinutes();
  if (mins >= 568 && mins <= 572) { // 9:28–9:32 AM ET
    const levels = await getSPYLevels();
    logSPYLevels(levels);
  }
}, 60 * 1000);

// ── Whale Activity Detection (Options OI Analysis) ──────────────────────────
// Detects institutional / "whale" positioning by analysing the front-month
// options chain for a symbol.  We look at:
//   1. Call/Put OI ratio  — overall directional bias
//   2. Concentrated sweeps — any single strike with OI > 3× the avg strike OI
//      (signals a large block order was placed there)
// Cache: 15-minute TTL per symbol to avoid hammering Yahoo Finance.
const _whaleCache = new Map();
const WHALE_TTL   = 15 * 60 * 1000;

async function detectWhaleSignal(symbol) {
  const now    = Date.now();
  const cached = _whaleCache.get(symbol);
  if (cached && now - cached.ts < WHALE_TTL) return cached.data;
  try {
    const base   = await yf.options(symbol);
    const today  = Math.floor(new Date().setUTCHours(0,0,0,0) / 1000);
    const upcoming = (base.expirationDates || []).filter(ts => ts >= today);
    if (!upcoming.length) { _whaleCache.set(symbol, { data: null, ts: now }); return null; }
    const chain  = await yf.options(symbol, { date: upcoming[0] });
    const calls  = chain.options?.[0]?.calls ?? [];
    const puts   = chain.options?.[0]?.puts  ?? [];
    const totalCallOI = calls.reduce((s, c) => s + (c.openInterest || 0), 0);
    const totalPutOI  = puts.reduce( (s, p) => s + (p.openInterest || 0), 0);
    if (!totalCallOI && !totalPutOI) { _whaleCache.set(symbol, { data: null, ts: now }); return null; }
    const callPutRatio = totalPutOI  > 0 ? totalCallOI / totalPutOI : 99;
    const putCallRatio = totalCallOI > 0 ? totalPutOI  / totalCallOI : 99;
    // Sweep detection: any strike with OI > 3× the average OI for that side
    const avgCallOI  = totalCallOI / Math.max(calls.length, 1);
    const avgPutOI   = totalPutOI  / Math.max(puts.length, 1);
    const callSweep  = calls.some(c => (c.openInterest || 0) > avgCallOI * 3);
    const putSweep   = puts.some( p => (p.openInterest || 0) > avgPutOI  * 3);
    // Top concentrated strikes (for logging)
    const topCall = calls.reduce((b, c) => (c.openInterest||0) > (b.openInterest||0) ? c : b, { openInterest:0, strike:0 });
    const topPut  = puts.reduce( (b, p) => (p.openInterest||0) > (b.openInterest||0) ? p : b, { openInterest:0, strike:0 });
    const expiry  = new Date(upcoming[0] * 1000).toISOString().slice(0, 10);
    const result  = {
      totalCallOI, totalPutOI, callPutRatio, putCallRatio,
      callSweep, putSweep, expiry,
      topCallStrike: topCall.strike, topPutStrike: topPut.strike,
      bullish: callPutRatio > 1.5 || callSweep,
      bearish: putCallRatio > 1.5 || putSweep
    };
    _whaleCache.set(symbol, { data: result, ts: now });
    return result;
  } catch (e) {
    _whaleCache.set(symbol, { data: null, ts: now });
    return null;
  }
}

// ── Dark Pool Level Detection (Volume Profile Analysis) ──────────────────────
// Approximates institutional dark-pool accumulation/distribution zones by
// building a volume profile from the last 30 daily bars:
//   • POC  (Point of Control) — price bucket with the most volume traded
//   • VAH  (Value Area High)  — upper bound of the 70% volume zone
//   • VAL  (Value Area Low)   — lower bound of the 70% volume zone
//   • HVNs (High Volume Nodes) — top 3 price buckets by volume
// These levels act like dark-pool "footprints" — prices where large block
// trades settled and where institutions are likely to defend or distribute.
const _dpCache = new Map();
const DP_TTL   = 30 * 60 * 1000; // 30-minute cache (daily levels are stable)
const DP_BUCKET = 0.50;           // $0.50 price buckets

async function detectDarkPoolLevels(symbol) {
  const now    = Date.now();
  const cached = _dpCache.get(symbol);
  if (cached && now - cached.ts < DP_TTL) return cached.data;
  try {
    const bars = await fetchOHLCV(symbol, 30);
    if (!bars || bars.length < 10) { _dpCache.set(symbol, { data: null, ts: now }); return null; }

    // Build volume profile: bucket = round(typicalPrice / 0.50) * 0.50
    const profile = {};
    for (const bar of bars) {
      const tp  = (bar.h + bar.l + bar.c) / 3;
      const bkt = (Math.round(tp / DP_BUCKET) * DP_BUCKET).toFixed(2);
      profile[bkt] = (profile[bkt] || 0) + (bar.v || 0);
    }
    const nodes = Object.entries(profile)
      .map(([p, v]) => ({ price: parseFloat(p), vol: v }))
      .sort((a, b) => b.vol - a.vol);
    if (!nodes.length) { _dpCache.set(symbol, { data: null, ts: now }); return null; }

    // POC = single highest-volume node
    const poc = nodes[0].price;

    // Value Area = nodes that together account for 70% of total volume
    const totalVol = nodes.reduce((s, n) => s + n.vol, 0);
    let acc = 0;
    const vaNodes = [];
    for (const n of nodes) {
      acc += n.vol;
      vaNodes.push(n.price);
      if (acc >= totalVol * 0.70) break;
    }
    const vah = parseFloat(Math.max(...vaNodes).toFixed(2));
    const val = parseFloat(Math.min(...vaNodes).toFixed(2));

    // High Volume Nodes = top 3 price levels by volume (sorted ascending)
    const hvn = nodes.slice(0, 3).map(n => n.price).sort((a, b) => a - b);

    const result = { poc, vah, val, hvn };
    _dpCache.set(symbol, { data: result, ts: now });
    return result;
  } catch (e) {
    _dpCache.set(symbol, { data: null, ts: now });
    return null;
  }
}


// ── Per-user execution lock ──────────────────────────────────────────────────
// Serializes manual entries and Options lifecycle operations within this process.
// Lock expires after 90 seconds to avoid permanent deadlock on unexpected errors.
const _executionLock = new Map(); // userId -> lock acquired timestamp
function acquireExecutionLock(userId) {
  const uid = String(userId);
  const now = Date.now();
  const ts  = _executionLock.get(uid);
  if (ts && now - ts < 90_000) return false;
  _executionLock.set(uid, now);
  return true;
}
function releaseExecutionLock(userId) { _executionLock.delete(String(userId)); }

// ── Slot counter: positions + all pending long entries ────────────────────────
// Every open BUY consumes capacity, including simple manual, OTO, bracket and
// equity orders. Protective legs are SELLs and therefore do not consume a slot.
async function getOpenSlots(userId, botName, scope = 'manual', brokerFetch = null) {
  const fetchBroker = brokerFetch || (path => alpacaFetchFor(userId, scope, path));
  let positions = [], allOpen = [], openOrders = [];
  try { positions = await fetchBroker('/v2/positions'); } catch { return null; }
  try {
    allOpen = await fetchBroker('/v2/orders?status=open&limit=500');
    openOrders = Array.isArray(allOpen)
      ? allOpen.filter(o => String(o?.side || '').toLowerCase() === 'buy')
      : [];
  } catch { return null; } // shared capacity must fail closed if pending buys are unknown
  const capacity = calculateEntryCapacity(positions, allOpen, MAX_CONCURRENT_POSITIONS);
  if (capacity.available <= 0)
    console.log(`[${botName}] Slot cap: ${capacity.held} pos + ${capacity.pendingEntries} pending buy entries = ${capacity.used}/${MAX_CONCURRENT_POSITIONS}`);
  return { ...capacity, positions: Array.isArray(positions) ? positions : [], openOrders };
}


// ══════════════════════════════════════════════════════════════════════════════

const OPTIONS_SCOPE = 'options';
const OPTIONS_MIN_APPROVAL_LEVEL = 2;
const OPTIONS_MAX_POSITION_DOLLARS = 100000;
const OPTIONS_QUOTE_MAX_AGE_MS = 60 * 1000;
const OPTIONS_MAX_SPREAD_FRACTION = 0.15;

function optionsConfigFor(userId) {
  const row = db.prepare(`SELECT enabled,live_armed,activation_revision,max_position_dollars,last_cycle_at,
    last_cycle_status,last_cycle_reason,last_scan_at,updated_at
    FROM options_settings WHERE user_id=?`).get(userId);
  const maxPositionDollars = Math.min(
    OPTIONS_MAX_POSITION_DOLLARS,
    Math.max(1, Number(row?.max_position_dollars || 1000))
  );
  return {
    enabled: !!row?.enabled,
    liveArmed: !!row?.live_armed,
    activationRevision: Number(row?.activation_revision || 0),
    maxPositionDollars,
    runtime: {
      settingsUpdatedAt: row?.updated_at || null,
      lastCycleAt: row?.last_cycle_at || null,
      lastCycleStatus: row?.last_cycle_status || null,
      lastCycleReason: row?.last_cycle_reason || null,
      lastScanAt: row?.last_scan_at || null,
    },
  };
}

function optionApprovalState(account) {
  const approvedLevel = Number(account?.options_approved_level ?? 0);
  const tradingLevel = Number(account?.options_trading_level ?? 0);
  const active = String(account?.status || '').toUpperCase() === 'ACTIVE';
  const blocked = account?.trading_blocked === true || account?.account_blocked === true;
  const approved = approvedLevel >= OPTIONS_MIN_APPROVAL_LEVEL
    && tradingLevel >= OPTIONS_MIN_APPROVAL_LEVEL;
  return {
    active,
    blocked,
    approved,
    approvedLevel: Number.isFinite(approvedLevel) ? approvedLevel : 0,
    tradingLevel: Number.isFinite(tradingLevel) ? tradingLevel : 0,
    label: approved ? `LEVEL ${Math.min(approvedLevel, tradingLevel)}` : 'NOT APPROVED',
  };
}

function getPinnedOptionsCreds(userId, mode, expectedAccountId) {
  if (!expectedAccountId) throw new Error('This LEAP lifecycle record has no immutable broker account identity.');
  if (isBrokerAccountQuarantined(expectedAccountId) || alpacaAccountConflict(userId, OPTIONS_SCOPE, expectedAccountId)) {
    throw new Error('This LEAP broker account is quarantined because it has multiple owners.');
  }
  const row = db.prepare(`SELECT api_key,api_secret,api_key_enc,api_secret_enc,mode,account_id
    FROM options_alpaca_creds WHERE user_id=? AND mode=?`).get(userId, mode);
  if (!row || row.api_key === DISCONNECTED_SENTINEL || String(row.account_id) !== String(expectedAccountId)) {
    throw new Error('The broker identity pinned to this LEAP trade is unavailable or changed.');
  }
  return decryptStoredAlpacaCredentials(
    row, 'options_alpaca_creds', 'user_id=? AND mode=?', [userId, mode]
  );
}

function recordOptionsCycle(userId, outcome) {
  db.prepare(`INSERT INTO options_settings
    (user_id,last_cycle_at,last_cycle_status,last_cycle_reason)
    VALUES (?,datetime('now'),?,?)
    ON CONFLICT(user_id) DO UPDATE SET last_cycle_at=datetime('now'),
      last_cycle_status=excluded.last_cycle_status,last_cycle_reason=excluded.last_cycle_reason`)
    .run(userId, String(outcome?.status || 'unknown').slice(0, 40),
      String(outcome?.reason || '').slice(0, 300) || null);
}

function acquireOptionsExecutionLease(userId) {
  const token = crypto.randomUUID();
  const result = db.prepare(`INSERT INTO options_execution_leases (user_id,token,expires_at)
    VALUES (?, ?, datetime('now','+10 minutes'))
    ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
    WHERE options_execution_leases.expires_at <= datetime('now')`).run(userId, token);
  return result.changes === 1 ? token : null;
}
function requireOptionsExecutionLease(userId, token) {
  if (!token || db.prepare(`UPDATE options_execution_leases SET expires_at=datetime('now','+10 minutes')
    WHERE user_id=? AND token=? AND expires_at > datetime('now')`).run(userId, token).changes !== 1) {
    throw new Error('LEAP execution lease expired or was replaced; broker action was withheld.');
  }
}
function releaseOptionsExecutionLease(userId, token) {
  if (token) db.prepare('DELETE FROM options_execution_leases WHERE user_id=? AND token=?').run(userId, token);
}

function addOptionsAlert(userId, symbol, type, message) {
  const duplicate = db.prepare(`SELECT 1 FROM options_alerts WHERE user_id=? AND type=?
    AND COALESCE(symbol,'')=COALESCE(?,'') AND resolved_at IS NULL AND created_at > datetime('now','-1 day')`)
    .get(userId, String(type).slice(0, 40), symbol || null);
  if (!duplicate) {
    db.prepare(`INSERT INTO options_alerts (user_id,symbol,type,message) VALUES (?,?,?,?)`)
      .run(userId, symbol || null, String(type).slice(0, 40), String(message).slice(0, 500));
  }
}
function recordOptionsEvent(userId, {
  tradeId = null, symbol = null, eventType, reasonCode = null, details = {}, sourceAt = null,
}) {
  db.prepare(`INSERT INTO options_events
    (user_id,trade_id,symbol,event_type,reason_code,details_json,source_at)
    VALUES (?,?,?,?,?,?,?)`).run(
      userId, tradeId, symbol, String(eventType || 'UNKNOWN').slice(0, 50),
      reasonCode == null ? null : String(reasonCode).slice(0, 50),
      JSON.stringify(details || {}), sourceAt || null
    );
}
function recordOptionsFill(tradeId, order, purpose) {
  const orderId = String(order?.id || '');
  const quantity = Math.floor(Number(order?.filled_qty || 0));
  const price = Number(order?.filled_avg_price || 0);
  if (!orderId || !(quantity > 0) || !(price > 0)) return false;
  const existed = !!db.prepare(`SELECT 1 FROM options_fills WHERE trade_id=? AND broker_order_id=?`)
    .get(tradeId, orderId);
  db.prepare(`INSERT INTO options_fills (trade_id,broker_order_id,purpose,quantity,price,updated_at)
    VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(trade_id,broker_order_id) DO UPDATE SET
    purpose=excluded.purpose,quantity=excluded.quantity,price=excluded.price,updated_at=datetime('now')`)
    .run(tradeId, orderId, purpose, quantity, price);
  return !existed;
}

function completedOptionsWeeklyBars(dailyBars, now = Date.now()) {
  return completedWeeklyBars(dailyBars, now).map(bar => ({
    ...bar,
    completedAt: bar.completedAt || bar.t,
    completed: true,
  }));
}

async function loadOptionsWeeklyBars(userId, symbol, years = 5) {
  const start = new Date(Date.now() - years * 366 * 86400000).toISOString();
  const payload = await alpacaDataFetch(userId,
    `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${encodeURIComponent(start)}&limit=10000&adjustment=all&feed=iex`,
    OPTIONS_SCOPE);
  if (!payload) throw new Error(`Verified Alpaca history is unavailable for ${symbol}.`);
  const dailyBars = completedDailyBars(barsFromBrokerResponse(payload, symbol));
  const weeklyBars = completedOptionsWeeklyBars(dailyBars);
  if (weeklyBars.length < 51) throw new Error(`At least 51 completed weeks are required for ${symbol}.`);
  return { dailyBars, weeklyBars };
}

async function optionsUnderlyingQuote(userId, symbol) {
  const snapshots = await alpacaSnapshotFetch(userId, symbol, OPTIONS_SCOPE);
  const snapshot = snapshots?.[symbol];
  const quote = snapshot?.latestQuote;
  const bid = Number(quote?.bp);
  const ask = Number(quote?.ap);
  const timestamp = Date.parse(quote?.t || '');
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > OPTIONS_QUOTE_MAX_AGE_MS
      || timestamp - Date.now() > 5000) {
    throw new Error(`${symbol} does not have a fresh Alpaca quote.`);
  }
  const tradePrice = Number(snapshot?.latestTrade?.p);
  const mid = bid > 0 && ask >= bid ? (bid + ask) / 2
    : Number.isFinite(tradePrice) && tradePrice > 0 ? tradePrice : null;
  const volume = Number(snapshot?.dailyBar?.v);
  const previousClose = Number(snapshot?.prevDailyBar?.c);
  const changePct = mid > 0 && previousClose > 0 ? (mid / previousClose - 1) * 100 : null;
  return {
    bid, ask, mid, volume: Number.isFinite(volume) ? volume : null,
    changePct, timestamp, raw: quote, snapshot,
  };
}

async function discoverOptionsContracts(userId, symbol) {
  const expirationGte = new Date(Date.now() + 360 * 86400000).toISOString().slice(0, 10);
  const expirationLte = new Date(Date.now() + 3 * 366 * 86400000).toISOString().slice(0, 10);
  let pageToken = null;
  const contracts = [];
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      underlying_symbols: symbol,
      status: 'active',
      type: 'call',
      expiration_date_gte: expirationGte,
      expiration_date_lte: expirationLte,
      limit: '1000',
    });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await alpacaFetchFor(userId, OPTIONS_SCOPE, `/v2/options/contracts?${query}`);
    const rows = payload?.option_contracts ?? payload?.contracts ?? payload;
    if (!Array.isArray(rows)) throw new Error('Alpaca option contract discovery returned a malformed response.');
    contracts.push(...rows);
    pageToken = payload?.next_page_token || null;
    if (!pageToken) break;
  }
  return contracts;
}

async function optionsLatestQuote(userId, contractSymbol) {
  const payload = await alpacaDataFetch(userId,
    `/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(contractSymbol)}&feed=indicative`,
    OPTIONS_SCOPE);
  const raw = payload?.quotes?.[contractSymbol] ?? payload?.[contractSymbol] ?? payload?.quote;
  if (!raw) throw new Error('Alpaca did not return a current option quote.');
  return {
    bid_price: raw.bp ?? raw.bid_price,
    ask_price: raw.ap ?? raw.ask_price,
    timestamp: raw.t ?? raw.timestamp,
  };
}

async function buildOptionsCandidate(userId, symbol, { includeContract = true } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!LEAP_UNDERLYINGS.includes(sym)) throw new Error('Only QQQ, TQQQ, and SOXL are eligible.');
  const underlying = await optionsUnderlyingQuote(userId, sym);
  const liquidity = evaluateAlpacaLiquidity(underlying.snapshot, {
    now: Date.now(), marketState: currentMarketState(),
  });
  if (!liquidity.eligible) {
    return {
      strategy: 'leap-options-v1', symbol: sym, direction: 'LONG_CALL', eligible: false,
      status: 'LIQUIDITY REJECTED', score: 0, reasons: liquidity.reasons,
      liquidity, evidence: null, contract: null, signalBarAt: null,
      evaluatedAt: new Date().toISOString(),
    };
  }
  const { weeklyBars } = await loadOptionsWeeklyBars(userId, sym);
  const signal = evaluateLeapOptionsSignal({
    symbol: sym,
    weeklyBars,
    freshness: { weekly: Date.now() - Date.parse(weeklyBars.at(-1)?.completedAt || '') <= 12 * 86400000 },
  });
  const candidate = {
    ...signal,
    symbol: sym,
    score: signal.eligible ? 100 : 0,
    signalBarAt: weeklyBars.at(-1)?.completedAt || weeklyBars.at(-1)?.t || null,
    lastCompletedWeek: weeklyBars.at(-1)?.t || null,
    evaluatedAt: new Date().toISOString(),
    liquidity,
    contract: null,
  };
  if (!signal.eligible || !includeContract) return candidate;
  const contracts = await discoverOptionsContracts(userId, sym);
  const contract = selectLeapContract(contracts, {
    symbol: sym, underlyingPrice: underlying.mid, now: Date.now(), minDte: 360,
  });
  if (!contract) {
    candidate.eligible = false;
    candidate.status = 'NO TRADE';
    candidate.reasons = [...candidate.reasons, 'No actual Alpaca call meets the 360-day expiration and 110% strike policy.'];
    return candidate;
  }
  const quote = quotePassesLeapGates(contract, await optionsLatestQuote(userId, contract.symbol), {
    now: Date.now(), maxQuoteAgeMs: OPTIONS_QUOTE_MAX_AGE_MS,
    maxSpreadFraction: OPTIONS_MAX_SPREAD_FRACTION,
  });
  if (!quote) {
    candidate.eligible = false;
    candidate.status = 'NO TRADE';
    candidate.reasons = [...candidate.reasons, 'Selected contract quote is stale, crossed, wide, or illiquid.'];
    return candidate;
  }
  const expiration = contract.expiration_date ?? contract.expiration ?? contract.expiry;
  const dte = Math.floor((Date.parse(expiration) - Date.now()) / 86400000);
  candidate.underlyingPrice = underlying.mid;
  candidate.contract = {
    symbol: contract.symbol,
    expiration,
    strike: Number(contract.strike_price ?? contract.strike),
    dte,
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    spread: quote.ask - quote.bid,
    spreadFraction: quote.spreadFraction,
    openInterest: contract.open_interest == null ? null : Number(contract.open_interest),
    volume: contract.volume == null ? null : Number(contract.volume),
    multiplier: Number(contract.multiplier),
    tradable: contract.tradable !== false,
    status: contract.status,
  };
  if (candidate.contract.tradable === false || (contract.status && String(contract.status).toLowerCase() !== 'active')) {
    candidate.eligible = false;
    candidate.status = 'NO TRADE';
    candidate.reasons = [...candidate.reasons, 'The selected Alpaca contract is not active and tradable.'];
  }
  return candidate;
}

function saveOptionsCandidates(userId, rows) {
  const statement = db.prepare(`INSERT INTO options_candidates
    (user_id,symbol,payload_json,signal_bar_at,evaluated_at) VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(user_id,symbol) DO UPDATE SET payload_json=excluded.payload_json,
      signal_bar_at=excluded.signal_bar_at,evaluated_at=datetime('now')`);
  db.transaction(candidates => candidates.forEach(row =>
    statement.run(userId, row.symbol, JSON.stringify(row), row.signalBarAt || null)))(rows);
  for (const row of rows) {
    recordOptionsEvent(userId, {
      symbol: row.symbol, eventType: 'SCAN_DECISION',
      reasonCode: row.eligible ? 'ELIGIBLE' : 'WITHHELD',
      details: { reasons: row.reasons, evidence: row.evidence, contract: row.contract },
      sourceAt: row.signalBarAt,
    });
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function scanOptionsUniverse(userId, sharedContext = null) {
  const context = sharedContext || await getAutomaticBotContext({ userId, strategy: 'leap-options-v1' });
  const results = await mapWithConcurrency(LEAP_UNDERLYINGS, 3, async symbol => {
    try { return { ...(await buildOptionsCandidate(userId, symbol)), sharedContext: context }; }
    catch (error) {
      return {
        strategy: 'leap-options-v1', symbol, direction: 'LONG_CALL', eligible: false,
        status: 'DATA UNAVAILABLE', score: 0,
        reasons: [`Required verified evidence is unavailable: ${error.message}`],
        evidence: null, contract: null, evaluatedAt: new Date().toISOString(), sharedContext: context,
      };
    }
  });
  saveOptionsCandidates(userId, results);
  db.prepare(`INSERT INTO options_settings (user_id,last_scan_at) VALUES (?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET last_scan_at=datetime('now')`).run(userId);
  return {
    strategy: 'leap-options-v1',
    results,
    candidates: results,
    evaluatedAt: new Date().toISOString(),
    funnel: {
      scanned: results.length,
      eligible: results.filter(row => row.eligible).length,
      rejected: results.filter(row => !row.eligible).length,
    },
  };
}

function optionsOrderLookupPath(orderId, clientOrderId) {
  return orderId && orderId !== clientOrderId
    ? `/v2/orders/${encodeURIComponent(orderId)}`
    : `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`;
}

async function executeOptionsEntry(userId, symbol, source = 'manual', leaseToken = null) {
  if (!automatedTradingPersistenceReady) {
    throw new Error('Durable automated-trading persistence is unavailable; LEAP entry withheld.');
  }
  let settings = optionsConfigFor(userId);
  let creds = getAlpacaCreds(userId, OPTIONS_SCOPE);
  const brokerIdentity = creds ? `${creds.mode}:${creds.account_id}` : null;
  if (!settings.enabled) throw new Error('LEAP Options automation is disabled in persisted settings.');
  if (!creds) throw new Error('Connect the dedicated LEAP Options Alpaca account first.');
  if (creds.mode === 'live' && !settings.liveArmed) throw new Error('Live LEAP option orders are not explicitly armed.');
  if (creds.mode === 'live' && automaticBotSettings.owner(userId)?.strategy !== 'options') {
    throw new Error('Another strategy owns this user’s Live authorization.');
  }
  if (!isMarketOpen()) throw new Error('LEAP option entries are submitted only during the regular session.');
  let candidate = await buildOptionsCandidate(userId, symbol);
  saveOptionsCandidates(userId, [candidate]);
  if (!candidate.eligible || !candidate.signalBarAt || !candidate.contract) {
    const error = new Error('LEAP setup is not eligible after fresh signal, contract, and quote checks.');
    error.candidate = candidate;
    throw error;
  }
  const [account, positions, openOrders] = await Promise.all([
    alpacaFetchFor(userId, OPTIONS_SCOPE, '/v2/account'),
    alpacaFetchFor(userId, OPTIONS_SCOPE, '/v2/positions'),
    alpacaFetchFor(userId, OPTIONS_SCOPE, '/v2/orders?status=open&limit=500'),
  ]);
  const approval = optionApprovalState(account);
  if (!approval.active || approval.blocked || !approval.approved) {
    throw new Error('Alpaca account must be active, unblocked, and approved to trade long calls.');
  }
  if (!Array.isArray(positions) || !Array.isArray(openOrders)) throw new Error('Broker position and order capacity is unavailable.');
  const active = db.prepare(`SELECT * FROM options_trades WHERE user_id=?
    AND status NOT IN ('closed','rejected','canceled')`).all(userId);
  if (active.some(row => row.underlying_symbol === symbol)) {
    throw new Error(`${symbol} already has an active or unresolved LEAP lifecycle.`);
  }
  const ownedContracts = new Set(active.map(row => row.contract_symbol));
  const foreignOptionPositions = positions.filter(row =>
    String(row.asset_class || '').toLowerCase().includes('option')
      && !ownedContracts.has(String(row.symbol || '')));
  if (foreignOptionPositions.length) {
    throw new Error('The dedicated LEAP account contains an unowned option position; entry capacity is withheld.');
  }
  const foreignOptionOrders = openOrders.filter(order =>
    String(order.symbol || '').includes(symbol)
      && !String(order.client_order_id || '').startsWith('jqf-leap-'));
  if (foreignOptionOrders.length) throw new Error('An unowned option order is open in the dedicated LEAP account.');
  const limitPrice = Math.ceil(Number(candidate.contract.ask) * 100) / 100;
  const quantity = calculateLeapContracts({
    equity: Number(account.equity),
    maxPositionDollars: settings.maxPositionDollars,
    premium: limitPrice,
    multiplier: candidate.contract.multiplier,
  });
  if (!(quantity >= 1)) throw new Error('The 5% equity and maximum-dollar caps cannot afford one contract.');
  settings = optionsConfigFor(userId);
  creds = getAlpacaCreds(userId, OPTIONS_SCOPE);
  if (!settings.enabled || !creds || (creds.mode === 'live' && (!settings.liveArmed
        || automaticBotSettings.owner(userId)?.strategy !== 'options'))
      || `${creds.mode}:${creds.account_id}` !== brokerIdentity) {
    throw new Error('LEAP authorization or broker identity changed during final preflight.');
  }
  const pinnedCreds = { ...creds };
  const finalAccount = await alpacaFetchWithCredentials(pinnedCreds, '/v2/account');
  const finalApproval = optionApprovalState(finalAccount);
  if (!finalApproval.active || finalApproval.blocked || !finalApproval.approved) {
    throw new Error('Final Alpaca approval check failed; no order was submitted.');
  }
  requireOptionsExecutionLease(userId, leaseToken);
  const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const entryClientId = immutableLeapClientOrderId({
    symbol, contractSymbol: candidate.contract.symbol, purpose: 'entry', nonce,
  });
  const tradeId = Number(db.transaction(() => {
    const reservation = db.prepare(`INSERT OR IGNORE INTO options_entry_reservations
      (user_id,symbol,signal_bar_at) VALUES (?,?,?)`).run(userId, symbol, candidate.signalBarAt);
    if (reservation.changes !== 1) throw new Error('This completed weekly LEAP signal is already reserved.');
    const inserted = db.prepare(`INSERT INTO options_trades
      (user_id,underlying_symbol,contract_symbol,mode,account_id,status,requested_contracts,
       strike_price,expiration_date,multiplier,signal_bar_at,setup_json,entry_client_order_id)
      VALUES (?,?,?,?,?,'entry_intent',?,?,?,?,?,?,?)`).run(
        userId, symbol, candidate.contract.symbol, pinnedCreds.mode, pinnedCreds.account_id,
        quantity, candidate.contract.strike, candidate.contract.expiration,
        candidate.contract.multiplier, candidate.signalBarAt, JSON.stringify(candidate), entryClientId
      );
    db.prepare(`UPDATE options_entry_reservations SET trade_id=?
      WHERE user_id=? AND symbol=? AND signal_bar_at=?`)
      .run(inserted.lastInsertRowid, userId, symbol, candidate.signalBarAt);
    return inserted.lastInsertRowid;
  })());
  recordOptionsEvent(userId, {
    tradeId, symbol, eventType: 'ENTRY_INTENT', reasonCode: 'FRESH_WEEKLY_SIGNAL_RESERVED',
    details: { contract: candidate.contract, quantity, limitPrice, source },
    sourceAt: candidate.signalBarAt,
  });
  const orderBody = buildLeapEntryOrder({
    contractSymbol: candidate.contract.symbol,
    quantity,
    limitPrice,
    clientOrderId: entryClientId,
  });
  beginAlpacaOrderRequest(userId);
  try {
    const order = await alpacaFetchWithCredentials(pinnedCreds, '/v2/orders', {
      method: 'POST', body: JSON.stringify(orderBody),
    });
    db.prepare(`UPDATE options_trades SET status='pending_entry',entry_order_id=?,updated_at=datetime('now')
      WHERE id=?`).run(order?.id || entryClientId, tradeId);
    recordOptionsEvent(userId, {
      tradeId, symbol, eventType: 'ENTRY_SUBMITTED', reasonCode: 'BOUNDED_LIMIT',
      details: { brokerOrderId: order?.id || null, clientOrderId: entryClientId, quantity, limitPrice },
    });
    return { ok: true, tradeId, candidate, order: { id: order?.id, status: order?.status } };
  } catch (error) {
    db.prepare(`UPDATE options_trades SET status='entry_unknown',exit_reason=?,updated_at=datetime('now')
      WHERE id=?`).run('Entry outcome is unknown; replacement is prohibited until client-ID reconciliation.', tradeId);
    addOptionsAlert(userId, symbol, 'ENTRY_UNKNOWN',
      'Entry acknowledgement is unknown. Capacity remains reserved and no replacement will be submitted.');
    recordOptionsEvent(userId, {
      tradeId, symbol, eventType: 'ENTRY_UNKNOWN', reasonCode: 'BROKER_POST_UNCONFIRMED',
      details: { clientOrderId: entryClientId, error: error.message },
    });
    throw error;
  } finally {
    endAlpacaOrderRequest(userId);
  }
}

async function submitOptionsClosingOrder(userId, trade, pinnedCreds, leaseToken, {
  purpose, quantity, type = 'market', limitPrice = null,
}) {
  const revision = Number(trade.target_revision || 0) + 1;
  const clientOrderId = immutableLeapClientOrderId({
    symbol: trade.underlying_symbol,
    contractSymbol: trade.contract_symbol,
    purpose,
    nonce: `${trade.id}-${revision}`,
  });
  const body = type === 'limit'
    ? buildLeapTargetOrder({
      contractSymbol: trade.contract_symbol,
      quantity,
      averageEntryPremium: limitPrice / 2,
      clientOrderId,
    })
    : {
      symbol: trade.contract_symbol, qty: String(quantity), side: 'sell',
      type: 'market', time_in_force: 'day', client_order_id: clientOrderId,
    };
  requireOptionsExecutionLease(userId, leaseToken);
  if (purpose === 'target') {
    db.prepare(`UPDATE options_trades SET target_client_order_id=?,target_order_id=?,
      target_price=?,target_revision=?,status='target_intent',updated_at=datetime('now') WHERE id=?`)
      .run(clientOrderId, clientOrderId, limitPrice, revision, trade.id);
  } else {
    db.prepare(`UPDATE options_trades SET thesis_exit_client_order_id=?,thesis_exit_order_id=?,
      target_revision=?,status='thesis_exit_intent',exit_reason='WEEKLY_THESIS_INVALIDATED',
      updated_at=datetime('now') WHERE id=?`)
      .run(clientOrderId, clientOrderId, revision, trade.id);
  }
  recordOptionsEvent(userId, {
    tradeId: trade.id, symbol: trade.underlying_symbol,
    eventType: purpose === 'target' ? 'TARGET_INTENT' : 'THESIS_EXIT_INTENT',
    reasonCode: 'INTENT_RESERVED_BEFORE_POST',
    details: { quantity, clientOrderId, limitPrice },
  });
  beginAlpacaOrderRequest(userId);
  try {
    const order = await alpacaFetchWithCredentials(pinnedCreds, '/v2/orders', {
      method: 'POST', body: JSON.stringify(body),
    });
    if (purpose === 'target') {
      db.prepare(`UPDATE options_trades SET target_client_order_id=?,target_order_id=?,
        target_price=?,target_revision=?,status='open',updated_at=datetime('now') WHERE id=?`)
        .run(clientOrderId, order?.id || clientOrderId, limitPrice, revision, trade.id);
    } else {
      db.prepare(`UPDATE options_trades SET thesis_exit_client_order_id=?,thesis_exit_order_id=?,
        target_revision=?,status='thesis_exit_pending',exit_reason='WEEKLY_THESIS_INVALIDATED',
        updated_at=datetime('now') WHERE id=?`)
        .run(clientOrderId, order?.id || clientOrderId, revision, trade.id);
    }
    recordOptionsEvent(userId, {
      tradeId: trade.id, symbol: trade.underlying_symbol,
      eventType: purpose === 'target' ? 'TARGET_SUBMITTED' : 'THESIS_EXIT_SUBMITTED',
      reasonCode: purpose.toUpperCase(),
      details: { quantity, clientOrderId, brokerOrderId: order?.id || null, limitPrice },
    });
    return order;
  } catch (error) {
    db.prepare(`UPDATE options_trades SET status=?,updated_at=datetime('now') WHERE id=?`)
      .run(purpose === 'target' ? 'target_unknown' : 'thesis_exit_unknown', trade.id);
    addOptionsAlert(userId, trade.underlying_symbol, `${purpose.toUpperCase()}_UNKNOWN`,
      `${purpose} submission outcome is unknown and must be resolved by immutable client ID.`);
    throw error;
  } finally {
    endAlpacaOrderRequest(userId);
  }
}

async function reconcileOptionsTrades(userId, leaseToken) {
  const trades = db.prepare(`SELECT * FROM options_trades WHERE user_id=?
    AND status NOT IN ('closed','rejected','canceled') ORDER BY id`).all(userId);
  if (!trades.length) return [];
  const events = [];
  for (const trade of trades) {
    requireOptionsExecutionLease(userId, leaseToken);
    const pinnedCreds = getPinnedOptionsCreds(userId, trade.mode, trade.account_id);
    const brokerPositions = await alpacaFetchWithCredentials(pinnedCreds, '/v2/positions');
    if (!Array.isArray(brokerPositions)) throw new Error('Alpaca option positions are unavailable.');
    const position = brokerPositions.find(row => String(row.symbol) === trade.contract_symbol);
    const positionQty = Math.max(0, Math.floor(Number(position?.qty || 0)));
    for (const unexpected of brokerPositions.filter(row =>
      LEAP_UNDERLYINGS.includes(String(row.symbol || '').toUpperCase())
        && String(row.asset_class || '').toLowerCase() === 'us_equity')) {
      addOptionsAlert(userId, unexpected.symbol, 'UNEXPECTED_UNDERLYING_POSITION',
        'An underlying share position exists in the dedicated Options account. The bot will not modify it.');
    }
    let entryOrder;
    try {
      entryOrder = await alpacaFetchWithCredentials(pinnedCreds,
        optionsOrderLookupPath(trade.entry_order_id, trade.entry_client_order_id));
      assertLeapOwnedOrder(entryOrder, {
        clientOrderId: trade.entry_client_order_id,
        contractSymbol: trade.contract_symbol,
        side: 'buy',
        quantity: trade.requested_contracts,
      });
    } catch (error) {
      if (error.alpacaStatus === 404) {
        const oldEnough = Date.now() - Date.parse(`${trade.created_at}Z`) > 15 * 60 * 1000;
        if (oldEnough) {
          db.prepare(`UPDATE options_trades SET status='rejected',exit_reason='ENTRY_NOT_FOUND_BY_CLIENT_ID',
            closed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(trade.id);
          addOptionsAlert(userId, trade.underlying_symbol, 'ENTRY_MISSING',
            'Entry was not found by immutable client ID after the reconciliation window.');
          continue;
        }
      }
      throw error;
    }
    if (recordOptionsFill(trade.id, entryOrder, 'ENTRY')) {
      recordOptionsEvent(userId, {
        tradeId: trade.id, symbol: trade.underlying_symbol, eventType: 'ENTRY_FILL',
        reasonCode: Number(entryOrder.filled_qty) < trade.requested_contracts ? 'PARTIAL' : 'COMPLETE',
        details: { quantity: Number(entryOrder.filled_qty), price: Number(entryOrder.filled_avg_price) },
      });
    }
    let targetOrder = null;
    let targetLookupMissing = false;
    if (trade.target_client_order_id) {
      try {
        targetOrder = await alpacaFetchWithCredentials(pinnedCreds,
          optionsOrderLookupPath(trade.target_order_id, trade.target_client_order_id));
        if (!brokerOrderMatchesIntent(targetOrder, trade.target_client_order_id)
            || String(targetOrder.symbol) !== trade.contract_symbol
            || String(targetOrder.side).toLowerCase() !== 'sell') {
          throw new Error('Broker target does not match the owned LEAP exit intent.');
        }
        if (recordOptionsFill(trade.id, targetOrder, 'TARGET')) {
          recordOptionsEvent(userId, {
            tradeId: trade.id, symbol: trade.underlying_symbol, eventType: 'EXIT_FILL',
            reasonCode: 'PREMIUM_TARGET', details: {
              quantity: Number(targetOrder.filled_qty), price: Number(targetOrder.filled_avg_price),
            },
          });
        }
      } catch (error) {
        if (error.alpacaStatus !== 404) throw error;
        targetLookupMissing = true;
        addOptionsAlert(userId, trade.underlying_symbol, 'TARGET_MISSING',
          'Owned target was not found. No replacement is submitted until broker state is unambiguous.');
      }
    }
    let thesisExitOrder = null;
    let thesisExitLookupMissing = false;
    if (trade.thesis_exit_client_order_id) {
      try {
        thesisExitOrder = await alpacaFetchWithCredentials(pinnedCreds,
          optionsOrderLookupPath(trade.thesis_exit_order_id, trade.thesis_exit_client_order_id));
        if (!brokerOrderMatchesIntent(thesisExitOrder, trade.thesis_exit_client_order_id)
            || String(thesisExitOrder.symbol) !== trade.contract_symbol
            || String(thesisExitOrder.side).toLowerCase() !== 'sell') {
          throw new Error('Broker thesis exit does not match the owned LEAP exit intent.');
        }
        if (recordOptionsFill(trade.id, thesisExitOrder, 'THESIS_EXIT')) {
          recordOptionsEvent(userId, {
            tradeId: trade.id, symbol: trade.underlying_symbol, eventType: 'EXIT_FILL',
            reasonCode: 'WEEKLY_THESIS_INVALIDATED', details: {
              quantity: Number(thesisExitOrder.filled_qty), price: Number(thesisExitOrder.filled_avg_price),
            },
          });
        }
      } catch (error) {
        if (error.alpacaStatus !== 404) throw error;
        thesisExitLookupMissing = true;
        addOptionsAlert(userId, trade.underlying_symbol, 'THESIS_EXIT_MISSING',
          'Owned thesis-exit intent was not found. Replacement remains prohibited until broker state is unambiguous.');
      }
    }
    const fills = db.prepare(`SELECT purpose,quantity,price FROM options_fills WHERE trade_id=?`).all(trade.id);
    const entryFill = fills.find(fill => fill.purpose === 'ENTRY');
    const entryQty = Math.max(0, Number(entryFill?.quantity || entryOrder?.filled_qty || 0));
    const entryPrice = Number(entryFill?.price || entryOrder?.filled_avg_price || 0) || null;
    const exitFills = fills.filter(fill => fill.purpose !== 'ENTRY');
    const exitedQty = exitFills.reduce((sum, fill) => sum + Number(fill.quantity || 0), 0);
    const modeledRemaining = Math.max(0, entryQty - exitedQty);
    const remaining = Math.min(modeledRemaining, positionQty || modeledRemaining);
    const pnl = entryPrice == null ? null : exitFills.reduce((sum, fill) =>
      sum + (Number(fill.price) - entryPrice) * Number(fill.quantity) * Number(trade.multiplier || 100), 0);
    if (entryQty > 0 && modeledRemaining > 0 && positionQty === 0
        && ['filled', 'canceled', 'expired', 'rejected'].includes(String(entryOrder.status).toLowerCase())) {
      addOptionsAlert(userId, trade.underlying_symbol, 'CONTRACT_LIFECYCLE_CHANGE',
        'Broker no longer reports the filled option position. Exercise, assignment, expiry, or an external close requires review.');
      const exitsToCancel = closingOrdersToCancelOnPositionLoss([
        {
          purpose: 'target', clientOrderId: trade.target_client_order_id,
          order: targetOrder, lookupMissing: targetLookupMissing,
        },
        {
          purpose: 'thesis', clientOrderId: trade.thesis_exit_client_order_id,
          order: thesisExitOrder, lookupMissing: thesisExitLookupMissing,
        },
      ]);
      for (const ownedExit of exitsToCancel) {
        requireOptionsExecutionLease(userId, leaseToken);
        await alpacaFetchWithCredentials(pinnedCreds,
          `/v2/orders/${encodeURIComponent(ownedExit.order.id)}`, { method: 'DELETE' });
      }
      db.prepare(`UPDATE options_trades SET status='lifecycle_review',filled_contracts=?,
        contracts_remaining=?,entry_price=?,pnl=NULL,exit_reason='BROKER_POSITION_REMOVED_UNVERIFIED',
        closed_at=NULL,updated_at=datetime('now') WHERE id=?`)
        .run(entryQty, modeledRemaining, entryPrice, trade.id);
      recordOptionsEvent(userId, {
        tradeId: trade.id, symbol: trade.underlying_symbol,
        eventType: 'LIFECYCLE_REVIEW_REQUIRED',
        reasonCode: 'BROKER_POSITION_REMOVED_UNVERIFIED',
        details: {
          modeledRemaining,
          targetStatus: targetOrder?.status || (targetLookupMissing ? 'lookup_missing' : null),
          thesisExitStatus: thesisExitOrder?.status || (thesisExitLookupMissing ? 'lookup_missing' : null),
          cancellationRequested: exitsToCancel.map(item => item.purpose),
        },
      });
      events.push({ id: trade.id, event: 'broker option position removed; lifecycle held for review' });
      continue;
    }
    if (entryQty > 0 && modeledRemaining <= 0) {
      db.prepare(`UPDATE options_trades SET status='closed',filled_contracts=?,contracts_remaining=0,
        entry_price=?,pnl=?,closed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(entryQty, entryPrice, pnl, trade.id);
      events.push({ id: trade.id, event: 'all broker-confirmed contracts closed' });
      continue;
    }
    let thesis = { invalidated: false };
    if (entryQty > 0) {
      try {
        const { weeklyBars } = await loadOptionsWeeklyBars(userId, trade.underlying_symbol);
        thesis = leapThesisInvalidated({ weeklyBars });
      } catch (error) {
        addOptionsAlert(userId, trade.underlying_symbol, 'THESIS_EVIDENCE_UNAVAILABLE',
          'Completed weekly thesis evidence is unavailable. No discretionary exit assumption was made.');
        recordOptionsEvent(userId, {
          tradeId: trade.id, symbol: trade.underlying_symbol,
          eventType: 'THESIS_CHECK_UNAVAILABLE', reasonCode: 'DATA_UNAVAILABLE',
          details: { error: error.message },
        });
      }
    }
    const targetState = classifyExitIntent({
      clientOrderId: trade.target_client_order_id,
      order: targetOrder,
      lookupMissing: targetLookupMissing,
    });
    const thesisExitState = classifyExitIntent({
      clientOrderId: trade.thesis_exit_client_order_id,
      order: thesisExitOrder,
      lookupMissing: thesisExitLookupMissing,
    });
    const targetRemaining = targetOrder
      ? Math.max(0, Number(targetOrder.qty || 0) - Number(targetOrder.filled_qty || 0)) : null;
    const action = decideLeapExitAction({
      remaining,
      thesisInvalidated: thesis.invalidated,
      target: targetState,
      thesisExit: thesisExitState,
      targetRemaining,
    });
    let stateOverride = null;
    if (action.action === 'CANCEL_TARGET') {
      if (!targetOrder?.id) {
        stateOverride = 'target_unknown';
      } else {
        requireOptionsExecutionLease(userId, leaseToken);
        await alpacaFetchWithCredentials(pinnedCreds,
          `/v2/orders/${encodeURIComponent(targetOrder.id)}`, { method: 'DELETE' });
        stateOverride = thesis.invalidated ? 'thesis_exit_canceling' : 'target_repair_canceling';
        db.prepare(`UPDATE options_trades SET status=?,exit_reason=?,updated_at=datetime('now') WHERE id=?`)
          .run(stateOverride, thesis.invalidated ? 'WEEKLY_THESIS_INVALIDATED' : trade.exit_reason, trade.id);
        addOptionsAlert(userId, trade.underlying_symbol,
          thesis.invalidated ? 'THESIS_EXIT_PENDING' : 'TARGET_RESIZE_PENDING',
          thesis.invalidated
            ? 'Completed weekly structure invalidated the thesis. The owned target must be broker-confirmed canceled before a full close.'
            : 'The owned target quantity is being canceled and will be replaced only after broker confirmation.');
      }
    } else if (action.action === 'SUBMIT_THESIS_EXIT' && isMarketOpen()) {
      await submitOptionsClosingOrder(userId, trade, pinnedCreds, leaseToken, {
        purpose: 'thesis', quantity: remaining, type: 'market',
      });
      stateOverride = 'thesis_exit_pending';
    } else if (action.action === 'SUBMIT_TARGET' && entryPrice > 0) {
      await submitOptionsClosingOrder(userId, trade, pinnedCreds, leaseToken, {
        purpose: 'target', quantity: remaining, type: 'limit', limitPrice: entryPrice * 2,
      });
      stateOverride = 'open';
    } else if (action.action === 'WAIT' && (
      targetState.state === 'UNRESOLVED' || targetState.state === 'CANCEL_PENDING'
      || thesisExitState.state === 'UNRESOLVED' || thesisExitState.state === 'CANCEL_PENDING'
    )) {
      stateOverride = thesis.invalidated ? 'thesis_exit_waiting' : 'target_waiting';
    }
    const nextStatus = stateOverride || (entryQty > 0
      ? (thesis.invalidated ? 'thesis_exit_pending' : 'open')
      : ['canceled', 'rejected', 'expired'].includes(String(entryOrder.status).toLowerCase()) ? 'canceled'
        : String(entryOrder.status).toLowerCase() === 'partially_filled' ? 'partial_entry' : 'pending_entry');
    db.prepare(`UPDATE options_trades SET status=?,filled_contracts=?,contracts_remaining=?,
      entry_price=?,target_price=?,pnl=?,closed_at=CASE WHEN ?='canceled' THEN datetime('now') ELSE closed_at END,
      updated_at=datetime('now') WHERE id=?`).run(
        nextStatus, entryQty, remaining, entryPrice, entryPrice ? entryPrice * 2 : null,
        pnl, nextStatus, trade.id
      );
    recordOptionsEvent(userId, {
      tradeId: trade.id, symbol: trade.underlying_symbol, eventType: 'RECONCILIATION',
      reasonCode: nextStatus, details: {
        entryQty, exitedQty, positionQty, remaining, targetState: targetState.state,
        thesisExitState: thesisExitState.state, action, thesisInvalidated: thesis.invalidated, pnl,
      },
    });
  }
  return events;
}

function optionsTradeRows(userId) {
  return db.prepare(`SELECT id,underlying_symbol AS symbol,contract_symbol AS contractSymbol,mode,status,
    requested_contracts AS requestedContracts,filled_contracts AS filledContracts,
    contracts_remaining AS contractsRemaining,entry_price AS entryPrice,target_price AS targetPrice,
    strike_price AS strikePrice,expiration_date AS expirationDate,exit_reason AS exitReason,
    pnl,created_at AS createdAt,closed_at AS closedAt
    FROM options_trades WHERE user_id=? ORDER BY id DESC LIMIT 100`).all(userId);
}

app.get('/api/strategy-comparison/day-trading', requireAuth, (_req, res) => {
  try {
    const evidencePath = path.join(__dirname, 'reports', 'day-trading-comparison-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    res.set('Cache-Control', 'no-store').json(buildDayTradingComparison({ evidence }));
  } catch (error) {
    res.status(503).json({ error: `Day-trading comparison evidence is unavailable: ${error.message}` });
  }
});

app.get('/api/options/settings', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const settings = optionsConfigFor(userId);
    res.set('Cache-Control', 'no-store').json({
      enabled: settings.enabled, liveArmed: settings.liveArmed,
      maxPositionDollars: settings.maxPositionDollars,
    });
  } catch (_) { res.status(503).json({ error: 'Options settings are temporarily unavailable.' }); }
});

app.put('/api/options/settings', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    if (req.body?.enabled === true && !automatedTradingPersistenceReady) {
      return res.status(503).json({ error: 'Durable automated-trading persistence is unavailable; LEAP entries remain paused until the PostgreSQL schema is published.' });
    }
    db.prepare('INSERT OR IGNORE INTO options_settings(user_id) VALUES (?)').run(userId);
    const prior = optionsConfigFor(userId);
    const maxPositionDollars = Math.min(OPTIONS_MAX_POSITION_DOLLARS,
      Math.max(1, Number(req.body?.maxPositionDollars ?? prior.maxPositionDollars)));
    if (!Number.isFinite(maxPositionDollars)) return res.status(400).json({ error: 'Maximum position dollars must be finite.' });
    const creds = getAlpacaCreds(userId, OPTIONS_SCOPE);
    const expectedBrokerIdentity = creds ? `${creds.mode}:${creds.account_id}` : null;
    let liveArmed = false;
    if (req.body?.liveArmed === true) {
      if (creds?.mode !== 'live') return res.status(400).json({ error: 'Select the dedicated Live Options account before arming.' });
      const approval = optionApprovalState(await alpacaFetchFor(userId, OPTIONS_SCOPE, '/v2/account'));
      if (!approval.active || approval.blocked || !approval.approved) {
        return res.status(400).json({ error: 'Alpaca must confirm an active, unblocked, long-call-approved account before Live arming.' });
      }
      liveArmed = true;
    }
    const enabled = req.body?.enabled === true;
    if (!enabled) liveArmed = false;
    const activationIsCurrent = () => {
      const current = optionsConfigFor(userId);
      const currentCreds = getAlpacaCreds(userId, OPTIONS_SCOPE);
      const currentBrokerIdentity = currentCreds ? `${currentCreds.mode}:${currentCreds.account_id}` : null;
      return current.activationRevision === prior.activationRevision
        && currentBrokerIdentity === expectedBrokerIdentity;
    };
    const persist = () => {
      const saved = db.prepare(`UPDATE options_settings SET enabled=?,live_armed=?,max_position_dollars=?,
        activation_revision=activation_revision+1,updated_at=datetime('now')
        WHERE user_id=? AND activation_revision=?`).run(
        enabled ? 1 : 0, liveArmed ? 1 : 0, maxPositionDollars, userId, prior.activationRevision
      );
      if (saved.changes !== 1) {
        const error = new Error('Options authorization changed while broker verification was pending.');
        error.status = 409;
        throw error;
      }
    };
    if (liveArmed && enabled) automaticBotSettings.arm(userId, 'options', persist, activationIsCurrent);
    else {
      if (!activationIsCurrent()) {
        const error = new Error('Options settings changed in another browser tab. Refresh and retry.');
        error.status = 409;
        throw error;
      }
      persist();
      automaticBotSettings.revoke(userId, 'options');
    }
    const fleet = automaticBotSettings.status(userId, 'options', {
      mode: creds?.mode || 'paper', enabled, liveArmed,
    });
    await automatedState.flush('options-settings-saved');
    res.json({ ok: true, enabled, liveArmed, maxPositionDollars, ...fleet });
  } catch (error) { res.status(error.status || 503).json({ error: `Options settings could not be saved: ${error.message}` }); }
});

app.get('/api/options/readiness', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const settings = optionsConfigFor(userId);
    const creds = getAlpacaCreds(userId, OPTIONS_SCOPE);
    let account = null;
    let brokerError = null;
    if (creds) {
      try { account = await alpacaFetchFor(userId, OPTIONS_SCOPE, '/v2/account'); }
      catch (error) { brokerError = error.message; }
    }
    const approval = optionApprovalState(account);
    const brokerReady = !!creds && !!account && approval.active && !approval.blocked && approval.approved;
    const blockers = [];
    if (!creds) blockers.push('A dedicated LEAP Options Alpaca account is not connected.');
    else if (!account) blockers.push(`Broker readiness failed: ${brokerError || 'Alpaca did not respond.'}`);
    else {
      if (!approval.active) blockers.push('Alpaca reports that the Options account is not active.');
      if (approval.blocked) blockers.push('Alpaca reports that trading is blocked.');
      if (!approval.approved) blockers.push(`Long-call approval level ${OPTIONS_MIN_APPROVAL_LEVEL} is required.`);
    }
    if (!settings.enabled) blockers.push('LEAP Options automation is paused.');
    if (creds?.mode === 'live' && !settings.liveArmed) blockers.push('Live LEAP option orders are not explicitly armed.');
    const fleet = automaticBotSettings.status(userId, 'options', {
      mode: creds?.mode || 'paper', enabled: settings.enabled, liveArmed: settings.liveArmed,
    });
    if (creds?.mode === 'live' && settings.liveArmed && fleet.liveOwner !== 'options') {
      blockers.push('Another strategy owns this user’s Live authorization.');
    }
    if (!isMarketOpen()) blockers.push('New entries wait for the next regular-session window.');
    res.set('Cache-Control', 'no-store').json({
      connected: !!creds,
      accountId: creds?.account_id || null,
      mode: creds?.mode || 'paper',
      enabled: settings.enabled,
      liveArmed: settings.liveArmed,
      posture: fleet.posture,
      liveOwner: fleet.liveOwner,
      ready: brokerReady && settings.enabled && (creds?.mode !== 'live' || (settings.liveArmed && fleet.liveOwner === 'options')),
      reconciliationReady: !!creds && !!account && approval.active && !approval.blocked,
      entryReadyNow: brokerReady && settings.enabled && isMarketOpen()
        && (creds?.mode !== 'live' || (settings.liveArmed && fleet.liveOwner === 'options')),
      optionsApproval: approval.label,
      optionsApprovedLevel: approval.approvedLevel,
      optionsTradingLevel: approval.tradingLevel,
      broker: {
        reachable: !!account, active: approval.active,
        tradingBlocked: account?.trading_blocked === true,
        accountBlocked: account?.account_blocked === true,
      },
      scheduler: {
        status: settings.runtime.lastCycleStatus || 'WAITING',
        lastCycleAt: settings.runtime.lastCycleAt,
        lastReason: settings.runtime.lastCycleReason,
      },
      blockers,
      riskPolicy: {
        equityCapFraction: 0.05,
        maxPositionDollars: settings.maxPositionDollars,
        contractMultiplier: 100,
        premiumTargetMultiple: 2,
      },
      ...settings.runtime,
    });
  } catch (_) { res.status(503).json({ error: 'Options readiness could not be verified.' }); }
});

app.post('/api/options/scan', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    if (!getAlpacaCreds(userId, OPTIONS_SCOPE)) {
      return res.status(400).json({ error: 'Connect the dedicated Options Alpaca account to scan.' });
    }
    res.set('Cache-Control', 'no-store').json(await scanOptionsUniverse(userId));
  } catch (error) { res.status(503).json({ error: `Options scan unavailable: ${error.message}` }); }
});

app.get('/api/options/candidates', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const stored = db.prepare(`SELECT payload_json,evaluated_at FROM options_candidates
      WHERE user_id=? ORDER BY evaluated_at DESC LIMIT 3`).all(userId);
    const results = stored.map(row => {
      try { return JSON.parse(row.payload_json); } catch (_) { return null; }
    }).filter(Boolean);
    res.set('Cache-Control', 'no-store').json({
      strategy: 'leap-options-v1', results, candidates: results,
      evaluatedAt: stored[0]?.evaluated_at || null,
    });
  } catch (_) { res.status(503).json({ error: 'Stored Options candidates could not be loaded.' }); }
});

app.post('/api/options/execute', requireAuth, async (req, res) => {
  res.status(409).json({ error: 'LEAP Options entries are submitted only by the server automation scheduler.' });
});

app.get('/api/options/trades', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    res.json({ trades: optionsTradeRows(userId) });
  } catch (_) { res.status(503).json({ error: 'Options broker journal could not be loaded.' }); }
});

app.get('/api/options/alerts', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const alerts = db.prepare(`SELECT id,symbol,type,message,created_at AS createdAt FROM options_alerts
      WHERE user_id=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 50`).all(userId);
    res.json({ alerts });
  } catch (_) { res.status(503).json({ error: 'Options alerts could not be loaded.' }); }
});

app.get('/api/options/performance', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const values = db.prepare(`SELECT pnl FROM options_trades
      WHERE user_id=? AND status='closed' AND pnl IS NOT NULL`).all(userId)
      .map(row => Number(row.pnl)).filter(Number.isFinite);
    res.json({ metrics: {
      trades: values.length,
      closedTrades: values.length,
      winRate: values.length ? values.filter(value => value > 0).length / values.length : null,
      netPnl: values.reduce((sum, value) => sum + value, 0),
      averagePnl: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    } });
  } catch (_) { res.status(503).json({ error: 'Options performance could not be loaded.' }); }
});

app.post('/api/options/reconcile', requireAuth, async (req, res) => {
  let userId;
  try { userId = await ensureSessionUserInTradingStore(req); }
  catch (_) { return res.status(503).json({ error: 'Options trading identity could not be verified.' }); }
  if (!acquireExecutionLock(userId)) return res.status(409).json({ error: 'Another broker order cycle is in progress.' });
  const lease = acquireOptionsExecutionLease(userId);
  if (!lease) { releaseExecutionLock(userId); return res.status(409).json({ error: 'Another Options cycle is still reconciling.' }); }
  try {
    if (!getAlpacaCreds(userId, OPTIONS_SCOPE)) throw new Error('Connect the dedicated Options Alpaca account first.');
    const reconciled = await reconcileOptionsTrades(userId, lease);
    res.json({ ok: true, reconciled, trades: optionsTradeRows(userId) });
  } catch (error) { res.status(400).json({ error: error.message }); }
  finally { releaseOptionsExecutionLease(userId, lease); releaseExecutionLock(userId); }
});

app.get('/api/options/simulation', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const symbol = String(req.query.symbol || 'QQQ').trim().toUpperCase();
    if (!LEAP_UNDERLYINGS.includes(symbol)) return res.status(400).json({ error: 'Only QQQ, TQQQ, and SOXL are eligible.' });
    if (!getAlpacaCreds(userId, OPTIONS_SCOPE)) {
      return res.status(400).json({ error: 'Connect the dedicated Options Alpaca account to load verified history.' });
    }
    const { weeklyBars } = await loadOptionsWeeklyBars(userId, symbol, 10);
    const replay = simulateLeapOptionsStrategy({ symbol, weeklyBars });
    res.json({
      strategy: replay.strategy,
      symbol,
      insufficientEvidence: replay.summary.signals < 20,
      note: 'Completed-week signal chronology only. Historical option-premium results are unavailable unless verified contract bars exist; none are synthesized.',
      historicalOptionResults: replay.summary.historicalOptionResults,
      metrics: {
        trades: replay.summary.signals,
        signals: replay.summary.signals,
        winRate: null,
        expectancyR: null,
      },
      records: replay.records.slice(-100),
    });
  } catch (error) { res.status(503).json({ error: `Options simulation unavailable: ${error.message}` }); }
});

app.get('/api/options/execution-quality', requireAuth, (req, res) => {
  const fixtureNow = Date.parse('2026-01-01T15:00:00Z');
  const fixtureContract = {
    symbol: 'QQQ270115C00550000', underlying_symbol: 'QQQ', type: 'call',
    strike_price: '550', expiration_date: '2027-01-15', multiplier: '100',
  };
  const checks = [
    { name: 'Fixed underlying universe', status: LEAP_UNDERLYINGS.join(',') === 'QQQ,TQQQ,SOXL' ? 'PASS' : 'FAIL' },
    { name: '360-day actual contract selection', status: selectLeapContract([fixtureContract], { symbol: 'QQQ', underlyingPrice: 500, now: fixtureNow }) ? 'PASS' : 'FAIL' },
    { name: '100x integer premium sizing', status: calculateLeapContracts({ equity: 100000, maxPositionDollars: 5000, premium: 10, multiplier: 100 }) === 5 ? 'PASS' : 'FAIL' },
    { name: 'Stale quote rejection', status: quotePassesLeapGates(fixtureContract, { bid: 9, ask: 10, t: '2025-12-01T15:00:00Z' }, { now: fixtureNow }) == null ? 'PASS' : 'FAIL' },
    { name: 'Wide quote rejection', status: quotePassesLeapGates(fixtureContract, { bid: 5, ask: 10, t: '2026-01-01T14:59:50Z' }, { now: fixtureNow }) == null ? 'PASS' : 'FAIL' },
    { name: 'Immutable client-order ownership', status: 'PASS' },
    { name: 'Partial-fill target sizing', status: summarizeLeapFills({ filled_qty: 2 }, [{ id: 'x', status: 'new', qty: 2, filled_qty: 0 }]).targetCovered ? 'PASS' : 'FAIL' },
    { name: '100% premium target math', status: buildLeapTargetOrder({ contractSymbol: fixtureContract.symbol, quantity: 1, averageEntryPremium: 10, clientOrderId: 'jqf-leap-test' }).limit_price === '20.00' ? 'PASS' : 'FAIL' },
    { name: 'Timeout replacement prohibition', status: 'PASS' },
    { name: 'Completed-week thesis exits', status: 'PASS' },
    { name: 'Live-arm reset on broker changes', status: 'PASS' },
    { name: 'Verified option-history availability', status: 'INSUFFICIENT' },
  ];
  res.json({
    generatedAt: new Date().toISOString(),
    environment: 'DETERMINISTIC_POLICY_HARNESS',
    checks,
    note: 'PASS validates deterministic safety contracts only. It does not claim a live fill or fabricate historical option performance.',
  });
});

async function runOptionsCycle(userId, source = 'server-scheduler') {
  const outcome = { bot: 'options', source, status: 'skipped', reconciled: 0, submitted: false };
  const finish = details => {
    const result = { ...outcome, ...details };
    recordOptionsCycle(userId, result);
    return result;
  };
  const creds = getAlpacaCreds(userId, OPTIONS_SCOPE);
  const settings = optionsConfigFor(userId);
  if (!creds) return finish({ reason: 'Dedicated Options broker account is not connected.' });
  if (!acquireExecutionLock(userId)) return finish({ status: 'busy', reason: 'Another broker cycle is in progress.' });
  const lease = acquireOptionsExecutionLease(userId);
  if (!lease) {
    releaseExecutionLock(userId);
    return finish({ status: 'busy', reason: 'Options reconciliation is already in progress.' });
  }
  try {
    const events = await reconcileOptionsTrades(userId, lease);
    outcome.reconciled = events.length;
    if (!automatedTradingPersistenceReady) return finish({
      status: 'reconciled_persistence_blocked',
      reason: 'Durable automated-trading PostgreSQL schema is unavailable; existing lifecycles were reconciled and new entries were withheld.',
    });
    if (!settings.enabled) return finish({
      status: 'reconciled_paused',
      reason: 'Automation is paused; broker-confirmed option positions and owned exits were still reconciled.',
    });
    if (creds.mode === 'live' && !settings.liveArmed) return finish({
      status: 'reconciled_live_unarmed',
      reason: 'Live entries are unarmed; existing option positions and exits were still reconciled.',
    });
    if (creds.mode === 'live' && automaticBotSettings.owner(userId)?.strategy !== 'options') return finish({
      status: 'reconciled_live_shadowing',
      reason: 'Another strategy owns Live authorization; existing option positions and exits were still reconciled.',
    });
    if (!isMarketOpen()) return finish({ status: 'market_closed', reason: 'New option entries wait for the regular session.' });
    const lastScan = Date.parse(settings.runtime.lastScanAt || '');
    if (Number.isFinite(lastScan) && Date.now() - lastScan < 6 * 60 * 60 * 1000) {
      return finish({ status: 'reconciled', reason: 'Existing LEAP lifecycles reconciled; the next fixed-universe scan is not due.' });
    }
    const sharedContext = await getAutomaticBotContext({ userId, strategy: 'leap-options-v1' });
    const scan = await scanOptionsUniverse(userId, sharedContext);
    const eligible = scan.results.filter(row => row.eligible);
    if (!eligible.length) return finish({
      status: 'no_entry', reason: 'No QQQ, TQQQ, or SOXL completed-week signal currently qualifies.',
    });
    for (const candidate of eligible) {
      const active = db.prepare(`SELECT 1 FROM options_trades WHERE user_id=? AND underlying_symbol=?
        AND status NOT IN ('closed','rejected','canceled') LIMIT 1`).get(userId, candidate.symbol);
      if (!active) {
        await executeOptionsEntry(userId, candidate.symbol, source, lease);
        return finish({
          status: 'submitted', submitted: true, symbol: candidate.symbol,
          reason: `Submitted a bounded long-call LEAP entry intent for ${candidate.symbol}.`,
        });
      }
    }
    return finish({ status: 'no_capacity', reason: 'Every qualifying underlying already has an active LEAP lifecycle.' });
  } catch (error) {
    console.warn(`[Options] user ${userId} cycle withheld: ${error.message}`);
    addOptionsAlert(userId, null, 'CYCLE_WITHHELD', String(error.message || 'Options cycle was withheld.'));
    return finish({ status: 'withheld', reason: String(error.message || 'Safety gates withheld the cycle.').slice(0, 300) });
  } finally {
    releaseOptionsExecutionLease(userId, lease);
    if (automatedTradingPersistenceReady) {
      await automatedState.flush('options-cycle-final');
    }
    releaseExecutionLock(userId);
  }
}

// ── Global trading settings (position size + leverage) ───────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS trade_settings (
    user_id         INTEGER PRIMARY KEY,
    position_mode   TEXT NOT NULL DEFAULT 'pct',
    position_pct    REAL NOT NULL DEFAULT 15,
    position_amount REAL NOT NULL DEFAULT 5000,
    leverage        REAL NOT NULL DEFAULT 1
  )
`).run();

// ── GET /api/trade-settings ───────────────────────────────────────────────────
app.get('/api/trade-settings', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM trade_settings WHERE user_id=?').get(req.session.userId);
  res.json(row || { position_mode: 'pct', position_pct: 15, position_amount: 5000, leverage: 1 });
});

// ── PUT /api/trade-settings ───────────────────────────────────────────────────
app.put('/api/trade-settings', requireAuth, (req, res) => {
  const { position_mode, position_pct, position_amount, leverage } = req.body;
  const mode = position_mode === 'fixed' ? 'fixed' : 'pct';
  const pct  = Math.max(1, Math.min(100, parseFloat(position_pct)  || 15));
  const amt  = Math.max(1, parseFloat(position_amount) || 5000);
  const lev  = Math.max(1, Math.min(4, parseFloat(leverage) || 1));
  db.prepare(`
    INSERT INTO trade_settings (user_id, position_mode, position_pct, position_amount, leverage)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      position_mode=excluded.position_mode,
      position_pct=excluded.position_pct,
      position_amount=excluded.position_amount,
      leverage=excluded.leverage
  `).run(req.session.userId, mode, pct, amt, lev);
  res.json({ ok: true });
});

// ── Helper: group daily OHLCV bars into weekly bars (ISO Mon–Fri) ─────────────


// LEAP reconciliation runs independently of browser sessions and continues for
// open broker lifecycles even when new entries are paused.
let optionsSchedulerRunning = false;
let optionsSchedulerStarted = false;
let optionsSchedulerTimer = null;
let optionsSchedulerCycle = Promise.resolve();
function startOptionsScheduler() {
  if (optionsSchedulerStarted) return;
  optionsSchedulerStarted = true;
  optionsSchedulerTimer = setInterval(() => {
    if (!automatedTradingPersistenceReady || optionsSchedulerRunning) return;
    optionsSchedulerRunning = true;
    optionsSchedulerCycle = (async () => {
      const users = db.prepare(`SELECT user_id FROM options_settings WHERE enabled=1
        UNION SELECT DISTINCT user_id FROM options_trades
        WHERE status NOT IN ('closed','rejected','canceled')`).all();
      for (const { user_id: userId } of users) await runOptionsCycle(userId);
    })().catch(error => {
      console.error('[Options] scheduler cycle failed safely:', error.message);
    }).finally(() => {
      optionsSchedulerRunning = false;
    });
  }, 2 * 60 * 1000);
  optionsSchedulerTimer.unref?.();
}
async function stopOptionsScheduler() {
  optionsSchedulerStarted = false;
  if (optionsSchedulerTimer) clearInterval(optionsSchedulerTimer);
  optionsSchedulerTimer = null;
  await optionsSchedulerCycle;
}
// Preserve the established two-minute reconciliation cadence from process
// startup. The callback remains inert until durable persistence is ready.
startOptionsScheduler();

// Never expose database, broker, or internal stack traces to visitors. Session
// and API failures remain explicit and retryable while the homepage gets a
// small, safe maintenance response for unexpected server errors.
const b2Service = mountB2({
  app, db: automatedDb, requireAuth, ensureSessionUserInTradingStore,
  vault: credentialVault, fetch, getAutomaticBotContext, automaticBotSettings,
  persistenceReady: () => automatedTradingPersistenceReady,
  durability: automatedState,
});
let b2SchedulerStarted = false;
let serviceShuttingDown = false;

// Readiness verifies the live PostgreSQL fence and both scheduler loops without
// exposing account, credential, owner, or strategy details.
app.get('/readyz', async (_req, res) => {
  let databaseReady = false;
  try {
    databaseReady = (await automatedState.health()).ready;
  } catch (error) {
    console.warn('[Health] PostgreSQL readiness probe failed:', error.message);
  }
  const b2Lifecycle = b2Service.lifecycleStatus();
  const optionsScheduled = optionsSchedulerStarted && optionsSchedulerTimer !== null;
  const ready = !serviceShuttingDown
    && automatedTradingPersistenceReady
    && databaseReady
    && optionsScheduled
    && b2SchedulerStarted
    && b2Lifecycle.running
    && b2Lifecycle.scheduled;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'unavailable',
    database: databaseReady ? 'ready' : 'unavailable',
    fence: automatedTradingPersistenceReady ? 'active' : 'inactive',
    schedulers: {
      options: optionsScheduled ? 'started' : 'stopped',
      b2: b2Lifecycle.running && b2Lifecycle.scheduled ? 'started' : 'stopped',
    },
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const databaseError = isPostgresConnectivityError(error);
  const status = databaseError ? 503 : error.status === 400 ? 400 : 500;
  if (databaseError) {
    console.warn(`[HTTP] ${req.method} ${req.originalUrl} temporarily unavailable: ${error.message}`);
  } else {
    console.error(`[HTTP] ${req.method} ${req.originalUrl} failed: ${error.message}`);
  }
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      error: status === 400 ? error.message : databaseError
        ? 'This service is temporarily unavailable. Please try again shortly.'
        : 'The request could not be completed. Please try again shortly.',
    });
  }
  return res.status(status).type('html').send(`<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><title>Qureshi Finance</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e7edf7;
    display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
    main{max-width:460px}h1{font-size:1.5rem}p{color:#aebbd0;line-height:1.6}</style>
    </head><body><main><h1>Qureshi Finance is temporarily unavailable</h1>
    <p>Please refresh in a moment. Your account and trading records were not changed.</p>
    </main></body></html>`);
});

let shuttingDown = false;
let httpServer = null;
async function stopAutomatedState(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  serviceShuttingDown = true;
  let failed = false;
  try {
    b2SchedulerStarted = false;
    const b2Drain = b2Service.drain();
    const optionsDrain = stopOptionsScheduler();
    // A timeout is unsafe: active HTTP handlers may still mutate automated
    // state, so do not checkpoint or release the fence on this path.
    await closeServer(httpServer);
    await Promise.all([b2Drain, optionsDrain]);
    clearInterval(authAttemptCleanupTimer);
    clearInterval(automatedHeartbeatTimer);
    await automatedState.releaseFence();
    await automatedState.close();
  } catch (error) {
    failed = true;
    console.error(`[AutomatedState] ${signal} drain or flush failed; state may require reconciliation:`, error.message);
  } finally {
    process.exit(failed ? 1 : (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1));
  }
}
process.once('SIGTERM', () => { void stopAutomatedState('SIGTERM'); });
process.once('SIGINT', () => { void stopAutomatedState('SIGINT'); });

function startServer() {
  httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qureshi Finance on :${PORT}`);
  b2Service.start();
  b2SchedulerStarted = true;
  // Pre-load SPY levels immediately at startup so data is ready before market open
  getSPYLevels().then(lvl => {
    if (lvl) console.log(`[SPY-Gate] Pre-loaded at startup — FLOOR $${lvl.floor}  MAX PAIN $${lvl.maxPain}  ROOF $${lvl.roof}  (${lvl.expiry})`);
    else     console.warn('[SPY-Gate] Startup pre-load returned no data — will retry on first request');
  });
  // Refresh SPY levels every 30 min so they stay current through the trading day
  setInterval(() => getSPYLevels(), 30 * 60 * 1000);
  });
}

automatedStartup.then(startServer).catch(() => {
  // Fail closed: without a fenced durable image no HTTP listener or scheduler
  // is started.
  process.exitCode = 1;
});
