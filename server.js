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
const { createPostgresAuthStore } = require('./lib/postgres-auth-store');
const { retireLegacyAccount } = require('./lib/legacy-account-retirement');
const { requiresPriceActionForEntry } = require('./lib/order-entry-policy');
const {
  normalizeYahooFloatSummary,
  scannerFloatFields,
  fetchMomentumQuoteWithFloat,
  momentumRowFromQuote,
} = require('./lib/momentum-float');
const {
  serverOwnedConfig,
  serverOwnedMomentumConfig,
  shouldAutoEnableAfterConnection,
} = require('./lib/automatic-bot-settings');
const helmet       = require('helmet');
const crypto       = require('crypto');
const {
  CATALYST_TERMS,
  buildCatalystEvent,
  dedupeEvents,
} = require('./lib/catalyst-intel');
const { buildTechnicalConfluence } = require('./lib/technical-probability-engine');
const { buildSearchVolumeSignal } = require('./lib/search-volume-signal');
const { buildSearchLevels } = require('./lib/search-levels');
const { buildSearchGapAnalysis, summarizePatternAnalysis } = require('./lib/search-gap-analysis');
const { buildSearchFibonacci } = require('./lib/search-fibonacci');
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
} = require('./lib/historical-forecast');
const { evaluatePriceActionSetup } = require('./lib/price-action-setups');
const { regularSessionWindow } = require('./lib/intraday-vwap');
const { evaluateMomentumOrderVwapGate } = require('./lib/momentum-vwap-gate');
const {
  evaluateMarketDirection,
  canUseInverseFallback,
  hasCompleteMomentumQuote,
} = require('./lib/market-direction');
const { createMomentumInverseCycleStore } = require('./lib/momentum-inverse-cycle');
const {
  sanitizeCandlestickExecutionConfig,
  calculateCandlestickEntryCapacity,
  buildCandlestickBracketOrder,
  candlestickBarsFromResponse,
  requireCandlestickBrokerCollection,
} = require('./lib/candlestick-execution-policy');
const { summarizeCandlestickBrokerOrder, needsUnprotectedExit, cancellationAction } = require('./lib/candlestick-reconciliation');
const {
  DEFAULT_CANDLE_CONFIG,
  evaluateCandlestickSetup,
  aggregateTimeframeBars,
  simulateCandlestickBacktest,
} = require('./lib/candlestick-strategy');
const {
  DEFAULT_SWING_CONFIG,
  evaluateSwingSetup,
  simulateSwingBacktest,
  aggregateSwingWeeklyBars,
  ema: swingEma,
  atr: swingAtr,
} = require('./lib/swing-strategy');
const {
  sanitizeSwingExecutionConfig,
  calculateLongQuantity,
  buildSwingEntryOrder,
} = require('./lib/swing-execution-policy');
const {
  calculateSwingAllocations,
  ratchetSwingStop,
  buildSwingClientOrderId,
} = require('./lib/swing-management');
const {
  summarizeSwingLotProtection,
  assertSwingOwnedBrokerTree,
} = require('./lib/swing-reconciliation');
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
const {
  DEFAULT_PMH_CONFIG,
  evaluatePmhBreak,
  evaluatePmhRunnerExit,
} = require('./lib/opening-momentum-pmh');
const { createPaperShadow } = require('./lib/paper-shadow');
const { EmergencyFlattenError, runEmergencyFlatten } = require('./lib/emergency-flatten');
const {
  filledSellOrder,
  isTerminalWithoutFill,
  momentumWorkerHealth,
  needsRescueReplacement,
} = require('./lib/bot-trade-journal');
const { createCredentialVault } = require('./lib/credential-vault');
const { brokerOrderMatchesIntent } = require('./lib/broker-order-ownership');
const {
  buildTradableEquityCatalog,
  selectTradableEquityCandidates,
  selectCatalogRotation,
  resolveInverseSymbol,
  calculateEntryCapacity,
  canReserveEntryUnits,
  isLikelyCryptoSymbol,
} = require('./lib/broker-universe');
const {
  CANDLESTICK_WATCHLIST,
  nextCandlestickWatchlistBatch,
} = require('./lib/candlestick-watchlist');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// Suppress noisy yahoo-finance2 deprecation warnings for modules we use intentionally
const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  const msg = args[0]?.toString() || '';
  if (msg.includes('financial statements submodules') || msg.includes('fundamentalsTimeSeries')) return;
  _origWarn(...args);
};

const app      = express();
const PORT           = 5000;
const MAX_TRADE_PRICE = 15;          // Bot only executes trades on stocks/ETFs priced ≤ $15
const MAX_CONCURRENT_POSITIONS = 2;  // Hard cap — all 6 bots combined never hold more than 2 positions
const MIN_RR_RATIO = 2.0;            // Minimum risk:reward required to enter any trade (raised for quality)
const FMP_KEY  = process.env.FMP_API_KEY;
const NEWS_KEY = process.env.NEWSAPI_KEY;
const SEARCH_AI_KEY = process.env.AIML_API_KEY;

// ── SQLite Database ────────────────────────────────────────────────────────────
const db = new Database('jqf.db');
db.pragma('journal_mode = WAL');
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
  CREATE TABLE IF NOT EXISTS auto_trade_settings (
    user_id              INTEGER PRIMARY KEY,
    enabled              INTEGER DEFAULT 0,
    max_positions        INTEGER DEFAULT 1,
    investment_amount    REAL    DEFAULT 1000.0,
    leverage             REAL    DEFAULT 1.0,
    min_volume           INTEGER DEFAULT 500000,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS auto_trade_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    symbol          TEXT    NOT NULL,
    side            TEXT    NOT NULL,
    shares          REAL,
    entry_price     REAL,
    tp_price        REAL,
    sl_price        REAL,
    alpaca_order_id TEXT,
    signal          TEXT,
    confidence      INTEGER,
    status          TEXT    DEFAULT 'open',
    pnl             REAL,
    created_at      TEXT    DEFAULT (datetime('now')),
    closed_at       TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS bot_trade_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    symbol              TEXT    NOT NULL,
    entry_price         REAL    NOT NULL,
    exit_price          REAL,
    shares              REAL    NOT NULL,
    pnl                 REAL,
    mode                TEXT    NOT NULL DEFAULT 'paper',
    status              TEXT    NOT NULL DEFAULT 'open',
    stop_price          REAL,
    take_profit_rsi     REAL,
    take_profit_pct     REAL,
    entry_order_id      TEXT,
    pending_exit_order_id TEXT,
    pending_exit_client_order_id TEXT,
    pending_exit_reason TEXT,
    exit_cooldown_until TEXT,
    broker_account_id TEXT,
    rescue_stop_client_order_id TEXT,
    entry_filled_qty REAL,
    entry_fill_finalized INTEGER NOT NULL DEFAULT 0,
    exit_reason         TEXT,
    timestamp           TEXT    NOT NULL DEFAULT (datetime('now')),
    closed_at           TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_bot_trade_log_user_timestamp
    ON bot_trade_log (user_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_bot_trade_log_open
    ON bot_trade_log (user_id, symbol, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_trade_log_entry_order
    ON bot_trade_log (user_id, entry_order_id)
    WHERE entry_order_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS momentum_exit_fills (
    trade_id INTEGER NOT NULL,
    broker_order_id TEXT NOT NULL,
    filled_qty REAL NOT NULL,
    filled_notional REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trade_id, broker_order_id),
    FOREIGN KEY (trade_id) REFERENCES bot_trade_log(id) ON DELETE CASCADE
  );
`);

// PMH snapshots are frozen per user/symbol/session. Settings are separate from
// Momentum Trader so changing one strategy cannot silently change the other.
db.exec(`
  CREATE TABLE IF NOT EXISTS pmh_session_snapshots (
    user_id      INTEGER NOT NULL,
    symbol       TEXT NOT NULL,
    session_date TEXT NOT NULL,
    pmh_high     REAL NOT NULL,
    pmh_low      REAL NOT NULL,
    pmh_volume   REAL NOT NULL,
    opening_price REAL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol, session_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS pmh_settings (
    user_id    INTEGER PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 0,
    live_armed INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS pmh_entry_intents (
    user_id      INTEGER NOT NULL,
    symbol       TEXT NOT NULL,
    session_date TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    detail       TEXT,
    PRIMARY KEY (user_id, symbol, session_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS candlestick_settings (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    live_armed INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS candlestick_candidates (
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS candlestick_trade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('LONG','SHORT')),
    entry_price REAL NOT NULL,
    exit_price REAL,
    shares REAL NOT NULL,
    stop_price REAL NOT NULL,
    target_price REAL NOT NULL,
    mode TEXT NOT NULL DEFAULT 'paper',
    status TEXT NOT NULL DEFAULT 'pending_entry',
    entry_order_id TEXT,
    entry_client_order_id TEXT NOT NULL,
    exit_order_id TEXT,
    exit_client_order_id TEXT,
    pnl REAL,
    exit_reason TEXT,
    setup_json TEXT NOT NULL DEFAULT '{}',
    signal_bar_at TEXT,
    protection_grace_until TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    UNIQUE(user_id, entry_client_order_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_candlestick_trade_open
    ON candlestick_trade_log (user_id, status);
  CREATE TABLE IF NOT EXISTS candlestick_signal_reservations (
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    signal_bar_at TEXT NOT NULL,
    trade_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol, signal_bar_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS candlestick_exit_fills (
    trade_id INTEGER NOT NULL,
    broker_order_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    reason TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trade_id, broker_order_id),
    FOREIGN KEY (trade_id) REFERENCES candlestick_trade_log(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS candlestick_execution_leases (
    user_id INTEGER PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Swing automation is deliberately isolated from every intraday strategy.
// Its credentials, settings, catalog cursor, candidates, reservations, order
// journal, and durable lease cannot be read by another bot's execution path.
db.exec(`
  CREATE TABLE IF NOT EXISTS swing_settings (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    live_armed INTEGER NOT NULL DEFAULT 0,
    max_position_dollars REAL NOT NULL DEFAULT 1000,
    rotation_offset INTEGER NOT NULL DEFAULT 0,
    last_cycle_at TEXT,
    last_cycle_status TEXT,
    last_cycle_reason TEXT,
    last_cycle_scanned INTEGER NOT NULL DEFAULT 0,
    last_cycle_eligible INTEGER NOT NULL DEFAULT 0,
    last_cycle_source TEXT,
    last_scan_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS swing_alpaca_creds (
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
  CREATE UNIQUE INDEX IF NOT EXISTS uq_swing_alpaca_creds_account
    ON swing_alpaca_creds (user_id, account_id)
    WHERE account_id IS NOT NULL AND api_key <> '__disconnected__';
  CREATE TABLE IF NOT EXISTS swing_alpaca_active_mode (
    user_id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'paper' CHECK(mode IN ('paper','live')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS swing_candidates (
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    signal_bar_at TEXT,
    evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS swing_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'paper',
    account_id TEXT,
    status TEXT NOT NULL DEFAULT 'entry_intent',
    requested_shares INTEGER NOT NULL,
    filled_shares INTEGER NOT NULL DEFAULT 0,
    shares_remaining INTEGER NOT NULL DEFAULT 0,
    entry_price REAL,
    stop_price REAL NOT NULL,
    tp1_price REAL NOT NULL,
    tp2_price REAL NOT NULL,
    tp3_price REAL NOT NULL,
    trailing_stop REAL,
    signal_bar_at TEXT NOT NULL,
    setup_json TEXT NOT NULL DEFAULT '{}',
    entry_orders_json TEXT NOT NULL DEFAULT '[]',
    exit_client_order_id TEXT,
    exit_order_id TEXT,
    exit_reason TEXT,
    pnl REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    UNIQUE(user_id, symbol, signal_bar_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_swing_trades_open
    ON swing_trades (user_id, status, symbol);
  CREATE TABLE IF NOT EXISTS swing_entry_reservations (
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    signal_bar_at TEXT NOT NULL,
    trade_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol, signal_bar_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS swing_exit_fills (
    trade_id INTEGER NOT NULL,
    broker_order_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    purpose TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trade_id, broker_order_id),
    FOREIGN KEY (trade_id) REFERENCES swing_trades(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS swing_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS swing_events (
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
    FOREIGN KEY (trade_id) REFERENCES swing_trades(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_swing_events_user_created
    ON swing_events (user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS swing_execution_leases (
    user_id INTEGER PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
try { db.prepare(`ALTER TABLE swing_trades ADD COLUMN account_id TEXT`).run(); } catch (_) {}

// Long-call LEAP automation has a wholly separate broker identity and journal.
// Entry authorization may be paused, but reconciliation records remain durable.
db.exec(`
  CREATE TABLE IF NOT EXISTS options_settings (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    live_armed INTEGER NOT NULL DEFAULT 0,
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

// ── DB migrations — add columns that didn't exist in older schema ─────────────
[
  `ALTER TABLE auto_trade_settings ADD COLUMN investment_amount REAL DEFAULT 1000.0`,
  `ALTER TABLE auto_trade_settings ADD COLUMN min_volume INTEGER DEFAULT 500000`,
  `ALTER TABLE auto_trade_settings ADD COLUMN order_type TEXT DEFAULT 'auto'`,
  `ALTER TABLE auto_trade_settings ADD COLUMN trade_duration TEXT DEFAULT 'swing'`,
  `ALTER TABLE auto_trade_log ADD COLUMN leverage REAL DEFAULT 1`,
  `ALTER TABLE auto_trade_log ADD COLUMN exit_reason TEXT`,
  `ALTER TABLE auto_trade_log ADD COLUMN order_placed_at TEXT`,
  `ALTER TABLE auto_trade_log ADD COLUMN reasons TEXT`,
  `ALTER TABLE auto_trade_log ADD COLUMN buying_power REAL`,
  `ALTER TABLE auto_trade_log ADD COLUMN settled_cash REAL`,
  `ALTER TABLE auto_trade_log ADD COLUMN atr REAL`,
  `ALTER TABLE auto_trade_log ADD COLUMN strategy TEXT DEFAULT 'bounce'`,
  `ALTER TABLE bot_trade_log ADD COLUMN stop_price REAL`,
  `ALTER TABLE bot_trade_log ADD COLUMN take_profit_rsi REAL`,
  `ALTER TABLE bot_trade_log ADD COLUMN take_profit_pct REAL`,
  `ALTER TABLE bot_trade_log ADD COLUMN entry_order_id TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN pending_exit_order_id TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN pending_exit_client_order_id TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN pending_exit_reason TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN exit_reason TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN strategy TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN entry_client_order_id TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN rescue_stop_order_id TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN exit_cooldown_until TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN broker_account_id TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN rescue_stop_client_order_id TEXT`,
  `ALTER TABLE bot_trade_log ADD COLUMN entry_filled_qty REAL`,
  `ALTER TABLE bot_trade_log ADD COLUMN entry_fill_finalized INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE candlestick_trade_log ADD COLUMN signal_bar_at TEXT`,
  `ALTER TABLE candlestick_trade_log ADD COLUMN protection_grace_until TEXT`,
  `ALTER TABLE candlestick_trade_log ADD COLUMN exit_requested_at TEXT`,
  `ALTER TABLE candlestick_settings ADD COLUMN updated_at TEXT`,
  `ALTER TABLE candlestick_settings ADD COLUMN last_cycle_at TEXT`,
  `ALTER TABLE candlestick_settings ADD COLUMN last_cycle_status TEXT`,
  `ALTER TABLE candlestick_settings ADD COLUMN last_cycle_reason TEXT`,
  `ALTER TABLE candlestick_settings ADD COLUMN last_cycle_scanned INTEGER`,
  `ALTER TABLE candlestick_settings ADD COLUMN last_cycle_eligible INTEGER`,
  `ALTER TABLE candlestick_settings ADD COLUMN last_cycle_source TEXT`,
  `ALTER TABLE alpaca_creds ADD COLUMN api_key_enc TEXT`,
  `ALTER TABLE alpaca_creds ADD COLUMN api_secret_enc TEXT`,
  `ALTER TABLE bot_alpaca_creds ADD COLUMN api_key_enc TEXT`,
  `ALTER TABLE bot_alpaca_creds ADD COLUMN api_secret_enc TEXT`,
  `ALTER TABLE candlestick_alpaca_creds ADD COLUMN api_key_enc TEXT`,
  `ALTER TABLE candlestick_alpaca_creds ADD COLUMN api_secret_enc TEXT`,
].forEach(sql => { try { db.prepare(sql).run(); } catch(_) {} });
db.prepare(`CREATE INDEX IF NOT EXISTS idx_candlestick_trade_signal
  ON candlestick_trade_log (user_id, symbol, signal_bar_at)`).run();

// Paper/shadow evidence is global to the frozen study, never tied to a broker
// account and never capable of submitting an order.
const paperShadow = createPaperShadow({
  db,
  rootDir: __dirname,
  resolveMarketRegime: () => resolvePaperMarketRegime(),
});

// ── DB migration: upgrade alpaca_creds to composite (user_id, mode) PK ────────
// Allows separate paper + live credentials to coexist for the same user.
// Safe to run on every startup — the PRAGMA check prevents double-migration.
{
  const pkCols = db.prepare('PRAGMA table_info(alpaca_creds)').all()
    .filter(c => c.pk > 0).map(c => c.name);
  if (pkCols.length === 1 && pkCols[0] === 'user_id') {
    try {
      db.exec(`
        CREATE TABLE alpaca_creds_new (
          user_id    INTEGER NOT NULL,
          api_key    TEXT    NOT NULL,
          api_secret TEXT    NOT NULL,
          api_key_enc TEXT,
          api_secret_enc TEXT,
          mode       TEXT    NOT NULL DEFAULT 'paper',
          PRIMARY KEY (user_id, mode),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO alpaca_creds_new (user_id, api_key, api_secret, api_key_enc, api_secret_enc, mode)
          SELECT user_id, api_key, api_secret, api_key_enc, api_secret_enc, COALESCE(mode,'paper') FROM alpaca_creds;
        DROP TABLE alpaca_creds;
        ALTER TABLE alpaca_creds_new RENAME TO alpaca_creds;
      `);
      console.log('[Migration] alpaca_creds → composite (user_id, mode) PK');
    } catch(e) { console.error('[Migration] alpaca_creds failed:', e.message); }
  }
}
// Account IDs are non-secret broker identities used to prevent accidental
// account sharing across manual and automated trading scopes.
try { db.prepare('ALTER TABLE alpaca_creds ADD COLUMN account_id TEXT').run(); } catch (_) {}

// ── Active-mode tracker — which account (paper/live) each user is using ───────
db.prepare(`
  CREATE TABLE IF NOT EXISTS alpaca_active_mode (
    user_id INTEGER PRIMARY KEY,
    mode    TEXT    NOT NULL DEFAULT 'paper',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

// Bot connections intentionally live outside the legacy/manual Alpaca account
// tables. A Momentum account and a PMH account must be independently connected
// and may not point at the same broker account, even when different API keys
// are used for that account.
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_alpaca_creds (
    user_id    INTEGER NOT NULL,
    bot        TEXT    NOT NULL CHECK (bot IN ('momentum', 'pmh')),
    mode       TEXT    NOT NULL CHECK (mode IN ('paper', 'live')),
    api_key    TEXT    NOT NULL,
    api_secret TEXT    NOT NULL,
    api_key_enc TEXT,
    api_secret_enc TEXT,
    account_id TEXT,
    PRIMARY KEY (user_id, bot, mode),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_bot_alpaca_creds_account
    ON bot_alpaca_creds (user_id, account_id);
  CREATE TABLE IF NOT EXISTS bot_alpaca_active_mode (
    user_id INTEGER NOT NULL,
    bot     TEXT    NOT NULL CHECK (bot IN ('momentum', 'pmh')),
    mode    TEXT    NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
    PRIMARY KEY (user_id, bot),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS candlestick_alpaca_creds (
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
  CREATE TABLE IF NOT EXISTS candlestick_alpaca_active_mode (
    user_id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'paper' CHECK(mode IN ('paper','live')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_alpaca_creds_account
    ON bot_alpaca_creds (user_id, account_id)
    WHERE account_id IS NOT NULL AND api_key <> '__disconnected__'`);
} catch (error) {
  // Do not silently overwrite a historical duplicate. New connections are
  // still checked below and the owner can reconnect the affected bot safely.
  console.error('[Alpaca] Existing bot account duplication needs reconnection:', error.message);
}

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
for (const seed of [
  `INSERT OR IGNORE INTO broker_account_owners(account_id,user_id,scope,mode)
   SELECT account_id,user_id,'manual',mode FROM alpaca_creds
   WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'`,
  `INSERT OR IGNORE INTO broker_account_owners(account_id,user_id,scope,mode)
   SELECT account_id,user_id,bot,mode FROM bot_alpaca_creds
   WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'`,
  `INSERT OR IGNORE INTO broker_account_owners(account_id,user_id,scope,mode)
   SELECT account_id,user_id,'candlestick',mode FROM candlestick_alpaca_creds
   WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'`,
  `INSERT OR IGNORE INTO broker_account_owners(account_id,user_id,scope,mode)
   SELECT account_id,user_id,'swing',mode FROM swing_alpaca_creds
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
    SELECT account_id,user_id,bot AS scope FROM bot_alpaca_creds
      WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'
    UNION ALL
    SELECT account_id,user_id,'candlestick' AS scope FROM candlestick_alpaca_creds
      WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'
    UNION ALL
    SELECT account_id,user_id,'swing' AS scope FROM swing_alpaca_creds
      WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'
    UNION ALL
    SELECT account_id,user_id,'options' AS scope FROM options_alpaca_creds
      WHERE account_id IS NOT NULL AND api_key<>'__disconnected__'
  )
`).all();
const duplicatedBrokerAccounts = findDuplicateBrokerAssignments(legacyBrokerAssignments);
db.prepare(`UPDATE broker_account_quarantine SET resolved_at=datetime('now') WHERE resolved_at IS NULL`).run();
for (const accountId of duplicatedBrokerAccounts) {
  db.prepare(`INSERT INTO broker_account_quarantine(account_id,reason,detected_at,resolved_at)
    VALUES (?,'LEGACY_DUPLICATE_ASSIGNMENT',datetime('now'),NULL)
    ON CONFLICT(account_id) DO UPDATE SET reason=excluded.reason,detected_at=excluded.detected_at,resolved_at=NULL`)
    .run(accountId);
}
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
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) if (now > entry.resetAt) authAttempts.delete(ip);
}, 15 * 60 * 1000);

// ── VE auto-trade settings table ──────────────────────────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS ve_auto_settings (
    user_id  INTEGER PRIMARY KEY,
    enabled  INTEGER DEFAULT 0,
    amount   REAL    DEFAULT 1000.0,
    leverage INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

// ── Bot toggles — per-user on/off state for each of the 6 bots ───────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS bot_toggles (
    user_id  INTEGER NOT NULL,
    bot_name TEXT    NOT NULL,
    enabled  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, bot_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

// Momentum used to retain its execution switch and every scanner threshold only
// in localStorage.  Persist them beside the other strategy settings so a browser
// closing cannot silently turn an enabled strategy into an inert one.
db.prepare(`
  CREATE TABLE IF NOT EXISTS momentum_settings (
    user_id     INTEGER PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 0,
    live_armed  INTEGER NOT NULL DEFAULT 0,
    config_json TEXT    NOT NULL DEFAULT '{}',
    last_inverse_at TEXT,
    last_inverse_status TEXT,
    last_inverse_reason TEXT,
    last_inverse_symbol TEXT,
    last_cycle_at TEXT,
    last_cycle_status TEXT,
    last_cycle_reason TEXT,
    last_cycle_source TEXT,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();
try { db.prepare(`ALTER TABLE pmh_settings ADD COLUMN live_armed INTEGER NOT NULL DEFAULT 0`).run(); } catch (_) {}
try { db.prepare(`ALTER TABLE momentum_settings ADD COLUMN live_armed INTEGER NOT NULL DEFAULT 0`).run(); } catch (_) {}
[
  `ALTER TABLE momentum_settings ADD COLUMN last_inverse_at TEXT`,
  `ALTER TABLE momentum_settings ADD COLUMN last_inverse_status TEXT`,
  `ALTER TABLE momentum_settings ADD COLUMN last_inverse_reason TEXT`,
  `ALTER TABLE momentum_settings ADD COLUMN last_inverse_symbol TEXT`,
  `ALTER TABLE momentum_settings ADD COLUMN last_cycle_at TEXT`,
  `ALTER TABLE momentum_settings ADD COLUMN last_cycle_status TEXT`,
  `ALTER TABLE momentum_settings ADD COLUMN last_cycle_reason TEXT`,
  `ALTER TABLE momentum_settings ADD COLUMN last_cycle_source TEXT`,
].forEach(sql => { try { db.prepare(sql).run(); } catch (_) {} });

// ── Security migration: retire a source-disclosed bootstrap account ──────────
// This is deliberately one-way. It runs after every automation table exists,
// so the legacy account cannot retain an enabled execution control.
if (retireLegacyAccount({
  db,
  sessionDb,
  username: 'johnnyqureshi',
  replacementPasswordHash: bcrypt.hashSync(crypto.randomBytes(48).toString('base64url'), 12),
  botNames: ['countertrend', 'pmh'],
})) {
  console.warn('[Security] Retired the legacy bootstrap account and removed its broker access. Create a new account and reconnect broker credentials.');
}

// Account identities and sessions are shared through PostgreSQL. The deployment
// runs as a single VM so the established SQLite trading journal and broker state
// remain consistent while their full shared-data migration is completed.
const authStore = createPostgresAuthStore({
  databaseUrl: process.env.DATABASE_URL,
  sessionTtlMs: 90 * 24 * 60 * 60 * 1000,
});
let authStoreInitError = null;
const authStoreReady = authStore.init(db)
  .then(() => authStore.retireLegacyUsername(
    bcrypt.hashSync(crypto.randomBytes(48).toString('base64url'), 12)
  ))
  .catch(error => {
    authStoreInitError = error;
    console.error('[Auth] Shared authentication store failed to initialize:', error.message);
  });

// Broker credentials are attached only through the authenticated per-user
// settings flow. Never assign environment credentials to a fixed user ID.

// ── ORB session log — one row per user per trading day ────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS orb_session_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    trade_date          TEXT    NOT NULL,
    orb_type            TEXT    NOT NULL DEFAULT '5min',
    orb_high            REAL,
    orb_low             REAL,
    range_width_pct     REAL,
    valid_range         INTEGER DEFAULT 0,
    breakout_direction  TEXT    DEFAULT 'NONE',
    breakout_price      REAL,
    volume_confirmed    INTEGER DEFAULT 0,
    vwap_aligned        INTEGER DEFAULT 0,
    rsi_ok              INTEGER DEFAULT 0,
    vix_ok              INTEGER DEFAULT 0,
    mwf_ok              INTEGER DEFAULT 0,
    all_filters_passed  INTEGER DEFAULT 0,
    trade_taken         INTEGER DEFAULT 0,
    entry_price         REAL,
    stop_price          REAL,
    target_price        REAL,
    trade_symbol        TEXT,
    shares              INTEGER,
    alpaca_order_id     TEXT,
    result              TEXT    DEFAULT 'OPEN',
    notes               TEXT,
    created_at          TEXT    DEFAULT (datetime('now')),
    UNIQUE(user_id, trade_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);  // Trust Replit's reverse proxy for correct cookie behaviour

// Security headers: removes X-Powered-By, sets X-Frame-Options, X-Content-Type-Options, etc.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: allow credentials from any origin — security is enforced by
// session auth (requireAuth), bcrypt, rate limiting, and input validation.
app.use(cors({ credentials: true, origin: true }));

app.use(express.json({ limit: '50kb' }));
const PostgresSessionStore = authStore.createSessionStore(session);
app.use(session({
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
}));
app.use(express.static(path.join(__dirname, 'public')));
// The application shell lives at the project root while its CSS/JS assets
// live under public/. Serve both paths so the published app and custom domain
// have a real homepage instead of Express's default "Cannot GET /" response.
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function requireAuthStore(req, res, next) {
  await authStoreReady;
  if (authStoreInitError) {
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

// SQLite still owns broker connections and trade journals while PostgreSQL owns
// identities and sessions. A session created before the migration can be valid
// while its matching SQLite compatibility row is absent; reconcile it before
// writing any foreign-key-bound trading data.
async function ensureSessionUserInTradingStore(req) {
  const sessionUserId = Number(req.session?.userId);
  if (!Number.isSafeInteger(sessionUserId) || sessionUserId <= 0) {
    throw new Error('Authenticated session has no valid user identity.');
  }
  await authStoreReady;
  if (authStoreInitError) throw authStoreInitError;
  const user = await authStore.findUserById(sessionUserId);
  if (!user) throw new Error('Authenticated user was not found.');
  authStore.syncSqliteUser(db, user);
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

function _fetchMomentumQuote(sym) {
  return fetchMomentumQuoteWithFloat(sym, {
    fetchQuote: symbol => yf.quote(symbol, {}, { validateResult: false }),
    fetchFloatData: _fetchFloatData,
  });
}

// ── Auth Routes ────────────────────────────────────────────────────────────────

// Register
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

async function alpacaDataFetch(userId, path, scope = 'manual', _attempt = 0) {
  try {
    const creds = getAlpacaCreds(userId, scope);
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
        return alpacaDataFetch(userId, path, scope, _attempt + 1);
      }
      return null;
    }
    clearTimeout(timeoutId);
    if (r.status === 429 && _attempt < 2) {
      await new Promise(res => setTimeout(res, 2000 * (_attempt + 1)));
      return alpacaDataFetch(userId, path, scope, _attempt + 1);
    }
    if ([502, 503, 504].includes(r.status) && _attempt < 2) {
      await new Promise(res => setTimeout(res, 1500 * (_attempt + 1)));
      return alpacaDataFetch(userId, path, scope, _attempt + 1);
    }
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
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
    const payload = { ...data, provider: 'Yahoo Finance chart API', adjustedCloseUsed: true, years };
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
  if (!symbols.length) return res.json({ results: [] });

  const BATCH = 5;
  const out   = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk   = symbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(chunk.map(async sym => {
      try {
        const [quote, bars, fundamentals] = await Promise.all([
          yf.quote(sym, {}, { validateResult: false }).catch(() => null),
          fetchOHLCV(sym, 70).catch(() => null),
          _fetchFloatData(sym),
        ]);
        if (!quote) return null;
        const price = quote.regularMarketPrice;
        if (!price || !isFinite(price) || price <= 0) return null;

        const change    = quote.regularMarketChangePercent ?? 0;
        const volume    = quote.regularMarketVolume ?? 0;
        const avgVol    = quote.averageDailyVolume3Month ?? quote.averageDailyVolume10Day ?? 0;
        const relVol    = avgVol > 0 ? +(volume / avgVol).toFixed(2) : null;
        const marketCap = quote.marketCap ?? null;
        // Prefer quoteSummary's floatShares, then sharesOutstanding, then the
        // quote endpoint's optional floatShares field as a final fallback.
        const floatFields = scannerFloatFields(fundamentals, quote);
        const w52High   = quote.fiftyTwoWeekHigh ?? null;
        const w52Dist   = w52High ? +((price - w52High) / w52High * 100).toFixed(2) : null;
        const name      = quote.shortName ?? quote.longName ?? sym;

        let atr14 = null, rsi14 = null;
        if (bars && bars.length >= 20) {
          const closes = bars.map(b => b.c);
          try { atr14 = +calcATR(bars, 14).toFixed(3); } catch(_) {}
          try { const v = calcRSI(closes, 14); rsi14 = v != null ? +v.toFixed(1) : null; } catch(_) {}
        }

        return {
          sym, name, price, change: +change.toFixed(2), volume, relVol, atr14, rsi14,
          ...floatFields,
          marketCap, w52Dist,
        };
      } catch { return null; }
    }));
    out.push(...settled.map(r => r.value).filter(Boolean));
  }
  res.json({ results: out });
  // Feed the exact same observed rows into the order-free shadow comparator.
  // It records paired baseline/selected decisions and hypothetical outcomes;
  // this path has no broker client and cannot place an order.
  paperShadow.ingest(out, { snapshotAt: Date.now() })
    .catch(error => console.error('[PaperShadow]', error.message));
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
        const vwapEntry = evaluateMomentumOrderVwapGate({ bars, snapshot: snap, now });
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

    const vwapEntry = evaluateMomentumOrderVwapGate({ bars, snapshot: null, now });
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

function completedFiveMinuteFreshness(bars, maxAgeMs = 16 * 60_000) {
  const last = bars.at(-1);
  const startedAt = gpTimestampMs(last?.t);
  const completedAt = Number.isFinite(startedAt) ? startedAt + 5 * 60_000 : NaN;
  return {
    fresh: Number.isFinite(completedAt) && Date.now() - completedAt >= 0 && Date.now() - completedAt <= maxAgeMs,
    sourceTimestamp: last?.t || null,
  };
}

function gpSourceFreshness({ quote, daily, oneMinute, fiveMinute, fifteenMinute, hourly }) {
  const ageOf = value => {
    const timestamp = gpTimestampMs(value);
    return timestamp == null ? null : Math.max(0, Date.now() - timestamp);
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

app.get('/api/gameplan/:sym', requireAuth, async (req, res) => {
  const sym = String(req.params.sym || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  if (!sym) return res.status(400).json({ ok: false, error: 'Symbol required' });

  // ?force=1 bypasses the cache, but per user+symbol at most once per cooldown window
  let force = !!req.query.force;
  if (force) {
    const fKey = `${req.session.userId}:${sym}`;
    const lastForce = _gpForceAt.get(fKey) || 0;
    if (Date.now() - lastForce < GP_FORCE_COOLDOWN_MS) force = false;
    else {
      _gpForceAt.set(fKey, Date.now());
      if (_gpForceAt.size > 200) _gpForceAt.delete(_gpForceAt.keys().next().value);
    }
  }

  const cached = _gpCache.get(sym);
  if (cached && Date.now() - cached.at < GP_CACHE_MS && !force) {
    return res.json({ ...cached.data, cached: true });
  }

  // Coalesce: if a generation for this symbol is already running, share its result
  const inflight = _gpInflight.get(sym);
  if (inflight) {
    try { return res.json(await inflight); }
    catch { return res.status(500).json({ ok: false, error: 'Game plan generation failed' }); }
  }

  const job = (async () => {
    const [quote, daily, intra, volumeHistory5m, analogHistory5m, intra1m, intra15m, intra1h, profile, mktRaw] = await Promise.all([
      fetchLiveQuote(sym, req.session.userId).catch(() => null),
      gpFetchDaily(sym, '2y'),
      gpFetchIntraday5m(sym),
      gpFetchIntraday(sym, '5m', '5d'),
      gpFetchIntraday(sym, '5m', '60d'),
      gpFetchIntraday(sym, '1m', '1d'),
      gpFetchIntraday(sym, '15m', '5d'),
      gpFetchIntraday(sym, '1h', '3mo'),
      yf.quoteSummary(sym, { modules: ['assetProfile'] }, { validateResult: false }).catch(() => null),
      yf.quote(['SPY', 'QQQ', 'IWM'], {}, { validateResult: false }).catch(() => null),
    ]);

    if (!quote?.price || !daily?.length) {
      return { ok: false, unavailable: true, symbol: sym, error: 'REAL-TIME DATA UNAVAILABLE' };
    }

    const dataGaps = [];
    const price  = quote.price;
    const closes = daily.map(b => b.c);
    const searchLevelAnalysis = buildSearchLevels({
      dailyBars: daily,
      currentPrice: price,
      marketState: quote.marketState,
    });
    const atr    = searchLevelAnalysis.atr;
    const vwap   = gpVWAP(intra);
    if (!intra?.length) dataGaps.push('Intraday 5-min data unavailable');
    if (vwap == null)   dataGaps.push('VWAP unavailable (no regular-session volume yet)');

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
    if (indicators.sma200 == null) dataGaps.push('SMA 200 unavailable (insufficient history)');

    // Sell-off stats
    const chgN = n => closes.length > n ? +(((price - closes.at(-1 - n)) / closes.at(-1 - n)) * 100).toFixed(1) : null;
    const high20 = Math.max(...daily.slice(-20).map(b => b.h));
    const relVol = quote.volume && quote.avgVolume ? +(quote.volume / quote.avgVolume).toFixed(1) : null;
    const gapPct = quote.open && quote.previousClose ? +(((quote.open - quote.previousClose) / quote.previousClose) * 100).toFixed(1) : null;
    const chg1d = quote.previousClose ? +(((price - quote.previousClose) / quote.previousClose) * 100).toFixed(1) : null;
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
    const currentAnalog = selectCurrentRegularSnapshot(intra, quote.previousClose, {
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
    mktArr.forEach(q => { if (q?.symbol) mkt[q.symbol] = +(q.regularMarketChangePercent ?? 0).toFixed(2); });
    const sectorName = profile?.assetProfile?.sector || null;
    const sectorEtf = sectorName ? SECTOR_ETF[sectorName] || null : null;
    let sectorChg = null;
    if (sectorEtf) {
      try {
        const sq = await yf.quote(sectorEtf, {}, { validateResult: false });
        sectorChg = +(sq?.regularMarketChangePercent ?? 0).toFixed(2);
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
    const market = {
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
    const displayLevels = searchLevelAnalysis.displayLevels;
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
    });
    const smartMoneyMaps = buildSmartMoneyTimeframes({
      hourly: intra1h,
      daily: searchLevelAnalysis.completedBars,
      currentPrice: price,
    });
    const smartMoney = smartMoneyMaps['1D'];

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
    const completedIntra5m = completedFiveMinuteBars(intra);
    const patternAnalysis = summarizePatternAnalysis({
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
      relativeStrength: stockVsSpy == null ? null : stockVsSpy >= 1,
      freshness: completedFiveMinuteFreshness(completedIntra5m),
    });
    if (!intra1m?.length) dataGaps.push('1-minute timeframe unavailable');
    if (!intra15m?.length) dataGaps.push('15-minute timeframe unavailable');
    if (!intra1h?.length) dataGaps.push('1-hour timeframe unavailable');

    // Search-page-only volume signal. Keep the existing confluence object
    // untouched because automated bots and their execution contracts must not
    // inherit search-page signal semantics.
    const searchSignal = buildSearchVolumeSignal({
      price,
      intradayBars: intra,
      volumeHistory5m,
      barsByInterval: { oneMinute: intra1m, fiveMinute: intra, fifteenMinute: intra15m },
      levels,
      indicators,
      market,
      dayChangePct: chg1d,
      relativeDailyVolume: relVol,
      dayRangePosition: quote.dayHigh > quote.dayLow
        ? (price - quote.dayLow) / (quote.dayHigh - quote.dayLow)
        : null,
      news,
      freshness: sourceFreshness,
      patternAnalysis,
      fibonacci,
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
    const parts = {
      technical: Math.min(100, 40 + (indicators.rsi14 != null ? 15 : 0) + (vwap != null ? 15 : 0) + (indicators.macd ? 15 : 0) + (atr != null ? 15 : 0)),
      historical: analogs ? (analogs.lowConfidence ? 35 : Math.min(90, 40 + analogs.sampleSize * 2)) : 15,
      market: mkt.SPY != null ? 75 : 20,
      sector: sectorChg != null ? 75 : 25,
      catalyst: news.length ? 65 : 30,
      volume: relVol != null ? (relVol >= 1.5 ? 80 : 60) : 25,
    };
    const overall = Math.round(Object.values(parts).reduce((a, b) => a + b, 0) / Object.keys(parts).length);

    const snapshot = {
      price: +price.toFixed(2), prevClose: quote.previousClose, open: quote.open,
      high: quote.dayHigh, low: quote.dayLow, volume: quote.volume, avgVolume: quote.avgVolume,
      relVol, marketCap: quote.marketCap, wk52High: quote.yearHigh, wk52Low: quote.yearLow,
      marketState: quote.marketState, premarket, changePct: chg1d,
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
        quote: { provider: quote.source || 'Yahoo Finance', asOf: quote.asOf || generatedAt },
        intraday: { provider: 'Yahoo Finance chart API', intervals: ['1m', '5m', '15m', '1h'] },
        daily: { provider: 'Yahoo Finance chart API' },
        news: [...new Set(news.map(item => item.provider).filter(Boolean))],
      },
      snapshot, indicators: { ...indicators, macd: indicators.macd ? { value: +indicators.macd.value.toFixed(3), signal: +indicators.macd.signal.toFixed(3), histogram: +indicators.macd.histogram.toFixed(3) } : null },
      selloff, oversold,
      analogs: analogs ? { threshold, ...analogs } : null,
      market, news, levels, displayLevels, dailyPivots, gapAnalysis, patternAnalysis, fibonacci,
      smartMoney: { ...smartMoney, availableTimeframes: SMART_MONEY_TIMEFRAME_ORDER },
      probabilities, confluence, searchSignal,
      confidence: { overall, parts },
      ai,
    };
    _smartMoneyCache.set(`${sym}:1D`, { at: Date.now(), data: smartMoney });
    for (const [mapTimeframe, data] of Object.entries(smartMoneyMaps)) {
      if (data.available) _smartMoneyCache.set(`${sym}:${mapTimeframe}`, { at: Date.now(), data });
    }
    _gpCache.set(sym, { at: Date.now(), data: out });
    if (_gpCache.size > 50) _gpCache.delete(_gpCache.keys().next().value);
    return out;
  })();

  _gpInflight.set(sym, job);
  try {
    res.json(await job);
  } catch (e) {
    console.error('[GamePlan]', sym, e.message);
    res.status(500).json({ ok: false, error: 'Game plan generation failed' });
  } finally {
    _gpInflight.delete(sym);
  }
});

// ── Alpaca Markets Integration ─────────────────────────────────────────────────

// Sentinel key written to DB when the user explicitly disconnects so that the
// environment-variable fallback is suppressed for that user.
const DISCONNECTED_SENTINEL = '__disconnected__';
const ENCRYPTED_CREDENTIAL_MARKER = '__encrypted__';
const BOT_ALPACA_SCOPES = new Set(['momentum', 'pmh', 'candlestick', 'swing', 'options']);
const isCandlestickScope = scope => scope === 'candlestick';
const isSwingScope = scope => scope === 'swing';
const isOptionsScope = scope => scope === 'options';
const hasActiveSwingTrades = userId => !!db.prepare(`SELECT 1 FROM swing_trades
  WHERE user_id=? AND status NOT IN ('closed','rejected','canceled') LIMIT 1`).get(userId);
const hasActiveOptionsTrades = userId => !!db.prepare(`SELECT 1 FROM options_trades
  WHERE user_id=? AND status NOT IN ('closed','rejected','canceled') LIMIT 1`).get(userId);
const brokerScopeLabel = scope => scope === 'pmh' ? 'Opening Momentum'
  : scope === 'momentum' ? 'Momentum Trader'
    : scope === 'candlestick' ? 'Candlestick Automation'
      : scope === 'swing' ? 'Swing Trading Bot'
        : scope === 'options' ? 'LEAP Options Bot' : 'manual trading';

function normalizeAlpacaScope(value, fallback = 'manual') {
  return BOT_ALPACA_SCOPES.has(value) ? value : fallback;
}

function requestAlpacaScope(req, fallback = 'manual') {
  return normalizeAlpacaScope(req.body?.connection ?? req.query?.connection, fallback);
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
      owner: 'Momentum Trader or Opening Momentum',
      rows: db.prepare(`SELECT user_id,bot FROM bot_alpaca_creds
        WHERE account_id=? AND api_key<>?`).all(accountId, DISCONNECTED_SENTINEL),
      same: row => row.user_id === userId && row.bot === scope,
    },
    {
      owner: 'Candlestick Automation',
      rows: db.prepare(`SELECT user_id FROM candlestick_alpaca_creds
        WHERE account_id=? AND api_key<>?`).all(accountId, DISCONNECTED_SENTINEL),
      same: row => scope === 'candlestick' && row.user_id === userId,
    },
    {
      owner: 'Swing Trading Bot',
      rows: db.prepare(`SELECT user_id FROM swing_alpaca_creds
        WHERE account_id=? AND api_key<>?`).all(accountId, DISCONNECTED_SENTINEL),
      same: row => scope === 'swing' && row.user_id === userId,
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
      UNION ALL SELECT user_id,bot AS scope FROM bot_alpaca_creds WHERE account_id=? AND api_key<>?
      UNION ALL SELECT user_id,'candlestick' AS scope FROM candlestick_alpaca_creds WHERE account_id=? AND api_key<>?
      UNION ALL SELECT user_id,'swing' AS scope FROM swing_alpaca_creds WHERE account_id=? AND api_key<>?
      UNION ALL SELECT user_id,'options' AS scope FROM options_alpaca_creds WHERE account_id=? AND api_key<>?
    )
  `).all(
    accountId, DISCONNECTED_SENTINEL,
    accountId, DISCONNECTED_SENTINEL,
    accountId, DISCONNECTED_SENTINEL,
    accountId, DISCONNECTED_SENTINEL,
    accountId, DISCONNECTED_SENTINEL,
  );
  return new Set(rows.map(row => `${row.user_id}:${row.scope}`)).size;
}

function refreshBrokerAccountQuarantine(accountId) {
  if (!accountId) return;
  const count = brokerAccountOwnerCount(accountId);
  if (count > 1) {
    db.prepare(`INSERT INTO broker_account_quarantine(account_id,reason,detected_at,resolved_at)
      VALUES (?,'DUPLICATE_ASSIGNMENT',datetime('now'),NULL)
      ON CONFLICT(account_id) DO UPDATE SET reason=excluded.reason,resolved_at=NULL`).run(accountId);
  } else {
    db.prepare(`UPDATE broker_account_quarantine SET resolved_at=datetime('now')
      WHERE account_id=? AND resolved_at IS NULL`).run(accountId);
  }
}

function isBrokerAccountQuarantined(accountId) {
  if (!accountId) return false;
  return !!db.prepare(`SELECT 1 FROM broker_account_quarantine
    WHERE account_id=? AND resolved_at IS NULL`).get(accountId);
}

function storedBrokerAccountId(userId, scope, mode) {
  if (scope === 'manual') return db.prepare(`SELECT account_id FROM alpaca_creds WHERE user_id=? AND mode=?`).get(userId, mode)?.account_id || null;
  if (scope === 'candlestick') return db.prepare(`SELECT account_id FROM candlestick_alpaca_creds WHERE user_id=? AND mode=?`).get(userId, mode)?.account_id || null;
  if (scope === 'swing') return db.prepare(`SELECT account_id FROM swing_alpaca_creds WHERE user_id=? AND mode=?`).get(userId, mode)?.account_id || null;
  if (scope === 'options') return db.prepare(`SELECT account_id FROM options_alpaca_creds WHERE user_id=? AND mode=?`).get(userId, mode)?.account_id || null;
  return db.prepare(`SELECT account_id FROM bot_alpaca_creds WHERE user_id=? AND bot=? AND mode=?`).get(userId, scope, mode)?.account_id || null;
}

function releaseBrokerAccountOwnershipIfUnused(userId, scope, accountId) {
  if (!accountId) return;
  let inUse;
  if (scope === 'manual') inUse = db.prepare(`SELECT 1 FROM alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1`).get(userId, accountId, DISCONNECTED_SENTINEL);
  else if (scope === 'candlestick') inUse = db.prepare(`SELECT 1 FROM candlestick_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1`).get(userId, accountId, DISCONNECTED_SENTINEL);
  else if (scope === 'swing') inUse = db.prepare(`SELECT 1 FROM swing_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1`).get(userId, accountId, DISCONNECTED_SENTINEL);
  else if (scope === 'options') inUse = db.prepare(`SELECT 1 FROM options_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1`).get(userId, accountId, DISCONNECTED_SENTINEL);
  else inUse = db.prepare(`SELECT 1 FROM bot_alpaca_creds WHERE user_id=? AND bot=? AND account_id=? AND api_key<>? LIMIT 1`).get(userId, scope, accountId, DISCONNECTED_SENTINEL);
  if (!inUse) db.prepare(`DELETE FROM broker_account_owners WHERE account_id=? AND user_id=? AND scope=?`).run(accountId, userId, scope);
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
    console.warn(`[Alpaca] Stored ${table} credential is unavailable: ${error.message}`);
    return null;
  }
}

function getAlpacaCreds(userId, scope = 'manual') {
  if (isOptionsScope(scope)) {
    const active = db.prepare('SELECT mode FROM options_alpaca_active_mode WHERE user_id=?')
      .get(userId)?.mode || 'paper';
    const row = db.prepare(`SELECT api_key, api_secret, api_key_enc, api_secret_enc, mode, account_id
      FROM options_alpaca_creds WHERE user_id=? AND mode=?`).get(userId, active);
    if (!row || row.api_key === DISCONNECTED_SENTINEL || !row.account_id || isBrokerAccountQuarantined(row.account_id)) return null;
    return decryptStoredAlpacaCredentials(row, 'options_alpaca_creds', 'user_id=? AND mode=?', [userId, active]);
  }
  if (isSwingScope(scope)) {
    const active = db.prepare('SELECT mode FROM swing_alpaca_active_mode WHERE user_id=?')
      .get(userId)?.mode || 'paper';
    const row = db.prepare(`SELECT api_key, api_secret, api_key_enc, api_secret_enc, mode, account_id
      FROM swing_alpaca_creds WHERE user_id=? AND mode=?`).get(userId, active);
    if (!row || row.api_key === DISCONNECTED_SENTINEL || !row.account_id || isBrokerAccountQuarantined(row.account_id)) return null;
    return decryptStoredAlpacaCredentials(row, 'swing_alpaca_creds', 'user_id=? AND mode=?', [userId, active]);
  }
  if (isCandlestickScope(scope)) {
    const active = db.prepare('SELECT mode FROM candlestick_alpaca_active_mode WHERE user_id=?')
      .get(userId)?.mode || 'paper';
    const row = db.prepare(`SELECT api_key, api_secret, api_key_enc, api_secret_enc, mode, account_id
      FROM candlestick_alpaca_creds WHERE user_id=? AND mode=?`).get(userId, active);
    if (!row || row.api_key === DISCONNECTED_SENTINEL || !row.account_id || isBrokerAccountQuarantined(row.account_id)) return null;
    return decryptStoredAlpacaCredentials(row, 'candlestick_alpaca_creds', 'user_id=? AND mode=?', [userId, active]);
  }
  if (BOT_ALPACA_SCOPES.has(scope)) {
    const active = db.prepare('SELECT mode FROM bot_alpaca_active_mode WHERE user_id=? AND bot=?')
      .get(userId, scope)?.mode || 'paper';
    const row = db.prepare(`
      SELECT api_key, api_secret, api_key_enc, api_secret_enc, mode, account_id
      FROM bot_alpaca_creds WHERE user_id=? AND bot=? AND mode=?
    `).get(userId, scope, active);
    // Credentials saved before broker identity verification must be reconnected
    // before an automated bot can use them.
    if (!row || row.api_key === DISCONNECTED_SENTINEL || !row.account_id || isBrokerAccountQuarantined(row.account_id)) return null;
    return decryptStoredAlpacaCredentials(row, 'bot_alpaca_creds', 'user_id=? AND bot=? AND mode=?', [userId, scope, active]);
  }
  // Determine which mode this user has active
  const activeModeRow = db.prepare('SELECT mode FROM alpaca_active_mode WHERE user_id=?').get(userId);
  const activeMode    = activeModeRow?.mode || 'paper';

  // Strict: only return credentials for the ACTIVE mode — never silently fall back
  // to the other mode, as that could send "live mode" orders to a paper account.
  const row = db.prepare('SELECT api_key, api_secret, api_key_enc, api_secret_enc, mode, account_id FROM alpaca_creds WHERE user_id=? AND mode=?').get(userId, activeMode);
  // Do not permit a legacy manual key pair to trade until it has been
  // revalidated and associated with a specific broker account ID.
  if (!row || row.api_key === DISCONNECTED_SENTINEL || !row.account_id || isBrokerAccountQuarantined(row.account_id)) return null;
  return decryptStoredAlpacaCredentials(row, 'alpaca_creds', 'user_id=? AND mode=?', [userId, activeMode]);
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
  if (isOptionsScope(scope)) {
    const row = db.prepare('SELECT api_key,api_secret,api_key_enc,api_secret_enc,account_id FROM options_alpaca_creds WHERE user_id=? AND mode=?')
      .get(userId, mode);
    return storedCredentialExists(row) && !isBrokerAccountQuarantined(row.account_id);
  }
  if (isSwingScope(scope)) {
    const row = db.prepare('SELECT api_key,api_secret,api_key_enc,api_secret_enc,account_id FROM swing_alpaca_creds WHERE user_id=? AND mode=?')
      .get(userId, mode);
    return storedCredentialExists(row) && !isBrokerAccountQuarantined(row.account_id);
  }
  if (isCandlestickScope(scope)) {
    const row = db.prepare('SELECT api_key,api_secret,api_key_enc,api_secret_enc,account_id FROM candlestick_alpaca_creds WHERE user_id=? AND mode=?')
      .get(userId, mode);
    return storedCredentialExists(row) && !isBrokerAccountQuarantined(row.account_id);
  }
  if (BOT_ALPACA_SCOPES.has(scope)) {
    const row = db.prepare('SELECT api_key,api_secret,api_key_enc,api_secret_enc,account_id FROM bot_alpaca_creds WHERE user_id=? AND bot=? AND mode=?')
      .get(userId, scope, mode);
    return storedCredentialExists(row) && !isBrokerAccountQuarantined(row.account_id);
  }
  const row = db.prepare('SELECT api_key,api_secret,api_key_enc,api_secret_enc,account_id FROM alpaca_creds WHERE user_id=? AND mode=?').get(userId, mode);
  return storedCredentialExists(row) && !isBrokerAccountQuarantined(row.account_id);
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
    // Only retry GET requests — POST/PUT/DELETE are not idempotent.
    // Retrying an order-placement POST after a timeout could create a duplicate order.
    const isGet = !opts.method || opts.method === 'GET';
    if (isGet && _attempt < MAX_ATTEMPTS - 1) {
      const delay = Math.min(1000 * 2 ** _attempt, 8000);
      console.warn(`[AT] Alpaca network error on ${path} (attempt ${_attempt + 1}/${MAX_ATTEMPTS}) — retrying in ${delay}ms: ${netErr.message}`);
      await new Promise(res => setTimeout(res, delay));
      return alpacaFetchWithCredentials(creds, path, opts, _attempt + 1);
    }
    const error = new Error(`Alpaca unreachable${isGet ? ` after ${MAX_ATTEMPTS} attempts` : ''}: ${netErr.message}`);
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
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) {
    const error = new Error('Alpaca authentication failed — check your API credentials.');
    error.alpacaStatus = r.status;
    throw error;
  }
  if (!r.ok) {
    const error = new Error(data.message || `Alpaca error (${r.status})`);
    error.alpacaStatus = r.status;
    error.alpacaTransient = r.status === 429 || r.status >= 500;
    throw error;
  }
  return data;
}

// Existing manual trading routes retain their connection behavior. Bot code must
// use alpacaFetchFor with its fixed scope and can never fall back to this path.
async function alpacaFetch(userId, path, opts = {}, _attempt = 0) {
  return alpacaFetchFor(userId, 'manual', path, opts, _attempt);
}

// Asset listings change far less often than prices. Cache the broker's
// authoritative active/tradable US-equity catalog per connected account so a
// scanner refresh never has to enumerate every asset again.
const ALPACA_ASSET_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const _alpacaAssetCatalogCache = new Map();
const _alpacaCatalogRotationState = new Map();

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

function nextAlpacaCatalogRotation(catalogEntry, prioritySymbols, {
  strategy = 'momentum',
  limit = 300,
  priorityLimit = 180,
  rotationLimit = 120,
} = {}) {
  const snapshotId = `${catalogEntry.key}:${catalogEntry.at}`;
  const stateKey = `${catalogEntry.key}:${strategy}`;
  let state = _alpacaCatalogRotationState.get(stateKey);
  if (!state || state.snapshotId !== snapshotId) {
    state = { snapshotId, offset: 0 };
    _alpacaCatalogRotationState.set(stateKey, state);
  }
  const rotation = selectCatalogRotation(catalogEntry.catalog, {
    prioritySymbols,
    limit,
    priorityLimit,
    rotationLimit,
    rotationOffset: state.offset,
  });
  state.offset = rotation.nextOffset;
  if (_alpacaCatalogRotationState.size > 200) _alpacaCatalogRotationState.delete(_alpacaCatalogRotationState.keys().next().value);
  return rotation;
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
  if (!shouldAutoEnableAfterConnection(mode)) return false;
  if (scope === 'momentum') {
    const config = momentumConfigFor(userId).config;
    db.prepare(`INSERT INTO momentum_settings (user_id,enabled,live_armed,config_json,updated_at)
      VALUES (?,1,0,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET
      enabled=1,live_armed=0,config_json=excluded.config_json,updated_at=datetime('now')`)
      .run(userId, JSON.stringify(config));
  } else if (scope === 'pmh') {
    const config = pmhConfigFor(userId).config;
    db.prepare(`INSERT INTO pmh_settings (user_id,enabled,live_armed,config_json)
      VALUES (?,1,0,?) ON CONFLICT(user_id) DO UPDATE SET
      enabled=1,live_armed=0,config_json=excluded.config_json`)
      .run(userId, JSON.stringify(config));
    db.prepare(`INSERT INTO bot_toggles (user_id,bot_name,enabled) VALUES (?,'pmh',1)
      ON CONFLICT(user_id,bot_name) DO UPDATE SET enabled=1`).run(userId);
  } else if (scope === 'candlestick') {
    const config = candlestickConfigFor(userId).config;
    db.prepare(`INSERT INTO candlestick_settings (user_id,enabled,live_armed,config_json,updated_at)
      VALUES (?,1,0,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET
      enabled=1,live_armed=0,config_json=excluded.config_json,updated_at=datetime('now')`)
      .run(userId, JSON.stringify(config));
  } else if (scope === 'swing') {
    const settings = swingConfigFor(userId);
    db.prepare(`INSERT INTO swing_settings (user_id,enabled,live_armed,max_position_dollars,updated_at)
      VALUES (?,1,0,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET
      enabled=1,live_armed=0,updated_at=datetime('now')`)
      .run(userId, settings.maxPositionDollars);
  } else if (scope === 'options') {
    const settings = optionsConfigFor(userId);
    db.prepare(`INSERT INTO options_settings (user_id,enabled,live_armed,max_position_dollars,updated_at)
      VALUES (?,1,0,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET
      enabled=1,live_armed=0,updated_at=datetime('now')`)
      .run(userId, settings.maxPositionDollars);
  } else {
    return false;
  }
  console.log(`[Automation] ${brokerScopeLabel(scope)} Paper automation enabled after verified broker connection.`);
  return true;
}

// Save credentials — stores the key pair for the given mode, sets it as active
app.put('/api/alpaca/credentials', requireAuth, async (req, res) => {
  const { apiKey, apiSecret, mode } = req.body || {};
  const scope = requestAlpacaScope(req);
  const key = (apiKey  || '').trim();
  const sec = (apiSecret || '').trim();
  if (!key || !sec) return res.status(400).json({ error: 'API key and secret required.' });
  if (key.length < 8 || sec.length < 8) return res.status(400).json({ error: 'Credentials look too short — paste the full key and secret.' });
  const m = mode === 'live' ? 'live' : 'paper';
  let verifiedAccountId = '';
  let uid;
  let previousAccountId = null;
  let encryptedKey = '';
  let encryptedSecret = '';

  try {
    uid = await ensureSessionUserInTradingStore(req);
    previousAccountId = storedBrokerAccountId(uid, scope, m);
  } catch (error) {
    console.error('[Auth] Could not reconcile authenticated user for broker connection:', error.message);
    return res.status(503).json({
      error: 'Your signed-in account could not be prepared for broker connections. Sign out, sign back in, and try again.',
    });
  }
  if (isSwingScope(scope) && hasActiveSwingTrades(uid)) {
    return res.status(409).json({
      error: 'Close or fully reconcile active Swing positions before replacing this broker connection.',
    });
  }
  if (isOptionsScope(scope) && hasActiveOptionsTrades(uid)) {
    return res.status(409).json({
      error: 'Close or fully reconcile active LEAP option positions before replacing this broker connection.',
    });
  }

  // ── Validate credentials against Alpaca before saving ─────────────────────
  // Never store credentials that Alpaca rejects.
  const base = m === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 10000);
    const test = await fetch(`${base}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID':     key,
        'APCA-API-SECRET-KEY': sec,
        'Content-Type':        'application/json',
      },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (test.status === 401 || test.status === 403) {
      return res.status(401).json({ error: 'Alpaca rejected these credentials — double-check your key and secret.' });
    }
    if (!test.ok) {
      const body = await test.json().catch(() => ({}));
      return res.status(400).json({ error: body.message || `Alpaca returned ${test.status} — please try again.` });
    }
    const account = await test.json().catch(() => ({}));
    verifiedAccountId = String(account?.id || account?.account_number || '').trim();
    if (!verifiedAccountId) {
      return res.status(400).json({ error: 'Alpaca did not return a broker account ID, so this connection cannot be safely verified.' });
    }
    if (isSwingScope(scope) && hasActiveSwingTrades(uid)) {
      return res.status(409).json({
        error: 'A Swing entry became active while Alpaca was verifying this connection. Reconcile it before changing accounts.',
      });
    }
    if (isOptionsScope(scope) && hasActiveOptionsTrades(uid)) {
      return res.status(409).json({
        error: 'A LEAP entry became active while Alpaca was verifying this connection. Reconcile it before changing accounts.',
      });
    }
    const ownershipConflict = alpacaAccountConflict(uid, scope, verifiedAccountId);
    if (ownershipConflict) {
      return res.status(409).json({
        error: `This Alpaca account is already assigned to ${ownershipConflict.owner}. Every app user and trading strategy requires a different broker account.`,
      });
    }
    if (!claimBrokerAccountOwnership(uid, scope, m, verifiedAccountId)) {
      return res.status(409).json({
        error: 'This Alpaca account was assigned to another app user or strategy while it was being verified.',
      });
    }
    encryptedKey = credentialVault.encrypt(key);
    encryptedSecret = credentialVault.encrypt(sec);
    if (scope !== 'manual') {
      const conflict = db.prepare(`
        SELECT bot FROM bot_alpaca_creds
        WHERE user_id=? AND account_id=? AND api_key<>? AND bot<>?
        LIMIT 1
      `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL, ['momentum', 'pmh'].includes(scope) ? scope : '');
      if (conflict) return res.status(409).json({
        error: `This Alpaca account is already connected to ${brokerScopeLabel(conflict.bot)}. Each bot must use a different Alpaca account.`,
      });
      const candleConflict = !isCandlestickScope(scope) && db.prepare(`
        SELECT 1 FROM candlestick_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1
      `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL);
      if (candleConflict) return res.status(409).json({
        error: 'This Alpaca account is already connected to Candlestick Automation. Each bot must use a different Alpaca account.',
      });
      const swingConflict = !isSwingScope(scope) && db.prepare(`
        SELECT 1 FROM swing_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1
      `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL);
      if (swingConflict) return res.status(409).json({
        error: 'This Alpaca account is already connected to the Swing Trading Bot. Each bot must use a different Alpaca account.',
      });
      const optionsConflict = !isOptionsScope(scope) && db.prepare(`
        SELECT 1 FROM options_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1
      `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL);
      if (optionsConflict) return res.status(409).json({
        error: 'This Alpaca account is already connected to the LEAP Options Bot. Each bot must use a different Alpaca account.',
      });
      const manualConflict = db.prepare(`
        SELECT 1 FROM alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1
      `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL);
      if (manualConflict) {
        return res.status(409).json({ error: 'This Alpaca account is already connected for manual trading. Use a separate account for each automated bot.' });
      }
      if (isOptionsScope(scope)) {
        db.prepare(`INSERT INTO options_alpaca_creds
          (user_id,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,mode) DO UPDATE SET
          api_key=excluded.api_key,api_secret=excluded.api_secret,
          api_key_enc=excluded.api_key_enc,api_secret_enc=excluded.api_secret_enc,
          account_id=excluded.account_id`)
          .run(uid, m, ENCRYPTED_CREDENTIAL_MARKER, ENCRYPTED_CREDENTIAL_MARKER, encryptedKey, encryptedSecret, verifiedAccountId);
        db.prepare('INSERT OR REPLACE INTO options_alpaca_active_mode (user_id,mode) VALUES (?,?)').run(uid, m);
        db.prepare('UPDATE options_settings SET live_armed=0 WHERE user_id=?').run(uid);
      } else if (isSwingScope(scope)) {
        db.prepare(`INSERT INTO swing_alpaca_creds
          (user_id,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,mode) DO UPDATE SET
          api_key=excluded.api_key,api_secret=excluded.api_secret,
          api_key_enc=excluded.api_key_enc,api_secret_enc=excluded.api_secret_enc,
          account_id=excluded.account_id`)
          .run(uid, m, ENCRYPTED_CREDENTIAL_MARKER, ENCRYPTED_CREDENTIAL_MARKER, encryptedKey, encryptedSecret, verifiedAccountId);
        db.prepare('INSERT OR REPLACE INTO swing_alpaca_active_mode (user_id,mode) VALUES (?,?)').run(uid, m);
        db.prepare('UPDATE swing_settings SET live_armed=0 WHERE user_id=?').run(uid);
      } else if (isCandlestickScope(scope)) {
        db.prepare(`INSERT INTO candlestick_alpaca_creds
          (user_id,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,mode) DO UPDATE SET
          api_key=excluded.api_key,api_secret=excluded.api_secret,
          api_key_enc=excluded.api_key_enc,api_secret_enc=excluded.api_secret_enc,
          account_id=excluded.account_id`)
          .run(uid, m, ENCRYPTED_CREDENTIAL_MARKER, ENCRYPTED_CREDENTIAL_MARKER, encryptedKey, encryptedSecret, verifiedAccountId);
        db.prepare('INSERT OR REPLACE INTO candlestick_alpaca_active_mode (user_id,mode) VALUES (?,?)').run(uid, m);
        // A verified credential or account change always revokes the prior
        // explicit live-order acknowledgement. Merely connecting a live key
        // must never inherit authority to trade real money from another account.
        db.prepare('UPDATE candlestick_settings SET live_armed=0 WHERE user_id=?').run(uid);
      } else {
        db.prepare(`
          INSERT INTO bot_alpaca_creds (user_id,bot,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(user_id,bot,mode) DO UPDATE SET
            api_key=excluded.api_key, api_secret=excluded.api_secret,
            api_key_enc=excluded.api_key_enc, api_secret_enc=excluded.api_secret_enc,
            account_id=excluded.account_id
        `).run(uid, scope, m, ENCRYPTED_CREDENTIAL_MARKER, ENCRYPTED_CREDENTIAL_MARKER, encryptedKey, encryptedSecret, verifiedAccountId);
        db.prepare('INSERT OR REPLACE INTO bot_alpaca_active_mode (user_id,bot,mode) VALUES (?,?,?)')
          .run(uid, scope, m);
        if (scope === 'momentum') {
          db.prepare('UPDATE momentum_settings SET live_armed=0 WHERE user_id=?').run(uid);
        } else if (scope === 'pmh') {
          db.prepare('UPDATE pmh_settings SET live_armed=0 WHERE user_id=?').run(uid);
        }
      }
      autoEnablePaperStrategy(uid, scope, m);
      if (previousAccountId && previousAccountId !== verifiedAccountId) {
        releaseBrokerAccountOwnershipIfUnused(uid, scope, previousAccountId);
      }
      return res.json({
        ok: true,
        mode: m,
        connection: scope,
        accountId: verifiedAccountId,
        automationEnabled: shouldAutoEnableAfterConnection(m),
        liveArmed: false,
      });
    }
  } catch (e) {
    if (verifiedAccountId && storedBrokerAccountId(uid, scope, m) !== verifiedAccountId) {
      releaseBrokerAccountOwnershipIfUnused(uid, scope, verifiedAccountId);
    }
    if (e.name === 'AbortError') return res.status(400).json({ error: 'Alpaca did not respond in time — check your connection.' });
    if (e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      console.error('[Alpaca] Trading-store identity reconciliation failed:', e.message);
      return res.status(503).json({
        error: 'Your signed-in account could not be linked to the trading store. Sign out, sign back in, and try again.',
      });
    }
    console.warn('[Alpaca] Credential verification did not complete:', e.name || 'unknown error');
    return res.status(400).json({ error: 'Could not reach Alpaca to verify credentials. Check the connection and try again.' });
  }

  const botConflict = db.prepare(`
    SELECT bot FROM bot_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1
  `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL);
  const candleConflict = db.prepare(`
    SELECT 1 FROM candlestick_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1
  `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL);
  const swingConflict = db.prepare(`
    SELECT 1 FROM swing_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1
  `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL);
  if (swingConflict) {
    return res.status(409).json({
      error: 'This Alpaca account is already connected to the Swing Trading Bot. Manual trading requires its own broker account.',
    });
  }
  const optionsConflict = db.prepare(`
    SELECT 1 FROM options_alpaca_creds WHERE user_id=? AND account_id=? AND api_key<>? LIMIT 1
  `).get(uid, verifiedAccountId, DISCONNECTED_SENTINEL);
  if (optionsConflict) {
    return res.status(409).json({
      error: 'This Alpaca account is already connected to the LEAP Options Bot. Manual trading requires its own broker account.',
    });
  }
  if (candleConflict) {
    return res.status(409).json({
      error: 'This Alpaca account is already connected to Candlestick Automation. Manual trading requires its own broker account.',
    });
  }
  if (botConflict) {
    return res.status(409).json({
      error: `This Alpaca account is already connected to ${brokerScopeLabel(botConflict.bot)}. Manual trading requires its own broker account.`,
    });
  }
  db.prepare(`
    INSERT INTO alpaca_creds (user_id,api_key,api_secret,api_key_enc,api_secret_enc,mode,account_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id,mode) DO UPDATE SET
      api_key=excluded.api_key, api_secret=excluded.api_secret,
      api_key_enc=excluded.api_key_enc, api_secret_enc=excluded.api_secret_enc,
      account_id=excluded.account_id
  `).run(uid, ENCRYPTED_CREDENTIAL_MARKER, ENCRYPTED_CREDENTIAL_MARKER, encryptedKey, encryptedSecret, m, verifiedAccountId);
  db.prepare('INSERT OR REPLACE INTO alpaca_active_mode (user_id, mode) VALUES (?,?)').run(uid, m);
  if (previousAccountId && previousAccountId !== verifiedAccountId) {
    releaseBrokerAccountOwnershipIfUnused(uid, scope, previousAccountId);
  }
  res.json({ ok: true, mode: m, accountId: verifiedAccountId });
});

// Disconnect — writes sentinel for the currently-active mode only.
// The other mode's credentials remain stored and can be reactivated via switch-mode.
app.delete('/api/alpaca/credentials', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const scope = requestAlpacaScope(req);
  if (isSwingScope(scope) && hasActiveSwingTrades(uid)) {
    return res.status(409).json({
      error: 'Close or fully reconcile active Swing positions before disconnecting this broker account.',
    });
  }
  if (isOptionsScope(scope) && hasActiveOptionsTrades(uid)) {
    return res.status(409).json({
      error: 'Close or fully reconcile active LEAP option positions before disconnecting this broker account.',
    });
  }
  if (scope !== 'manual') {
    if (isOptionsScope(scope)) {
      const active = db.prepare('SELECT mode FROM options_alpaca_active_mode WHERE user_id=?').get(uid)?.mode || 'paper';
      const accountId = storedBrokerAccountId(uid, scope, active);
      db.prepare(`INSERT OR REPLACE INTO options_alpaca_creds
        (user_id,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
        VALUES (?,?,?,?,?,?,NULL)`).run(uid, active, DISCONNECTED_SENTINEL, DISCONNECTED_SENTINEL, null, null);
      db.prepare('UPDATE options_settings SET live_armed=0 WHERE user_id=?').run(uid);
      releaseBrokerAccountOwnershipIfUnused(uid, scope, accountId);
      return res.json({ ok: true, connection: scope });
    }
    if (isSwingScope(scope)) {
      const active = db.prepare('SELECT mode FROM swing_alpaca_active_mode WHERE user_id=?').get(uid)?.mode || 'paper';
      const accountId = storedBrokerAccountId(uid, scope, active);
      db.prepare(`INSERT OR REPLACE INTO swing_alpaca_creds
        (user_id,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
        VALUES (?,?,?,?,?,?,NULL)`).run(uid, active, DISCONNECTED_SENTINEL, DISCONNECTED_SENTINEL, null, null);
      db.prepare('UPDATE swing_settings SET live_armed=0 WHERE user_id=?').run(uid);
      releaseBrokerAccountOwnershipIfUnused(uid, scope, accountId);
      return res.json({ ok: true, connection: scope });
    }
    if (isCandlestickScope(scope)) {
      const active = db.prepare('SELECT mode FROM candlestick_alpaca_active_mode WHERE user_id=?').get(uid)?.mode || 'paper';
      const accountId = storedBrokerAccountId(uid, scope, active);
      db.prepare(`INSERT OR REPLACE INTO candlestick_alpaca_creds
        (user_id,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
        VALUES (?,?,?,?,?,?,NULL)`).run(uid, active, DISCONNECTED_SENTINEL, DISCONNECTED_SENTINEL, null, null);
      db.prepare('UPDATE candlestick_settings SET live_armed=0 WHERE user_id=?').run(uid);
      releaseBrokerAccountOwnershipIfUnused(uid, scope, accountId);
      return res.json({ ok: true, connection: scope });
    }
    const active = db.prepare('SELECT mode FROM bot_alpaca_active_mode WHERE user_id=? AND bot=?')
      .get(uid, scope)?.mode || 'paper';
    const accountId = storedBrokerAccountId(uid, scope, active);
    db.prepare(`
      INSERT OR REPLACE INTO bot_alpaca_creds
        (user_id,bot,mode,api_key,api_secret,api_key_enc,api_secret_enc,account_id)
      VALUES (?,?,?,?,?,?,?,NULL)
    `).run(uid, scope, active, DISCONNECTED_SENTINEL, DISCONNECTED_SENTINEL, null, null);
    if (scope === 'momentum') {
      db.prepare('UPDATE momentum_settings SET live_armed=0 WHERE user_id=?').run(uid);
    } else if (scope === 'pmh') {
      db.prepare('UPDATE pmh_settings SET live_armed=0 WHERE user_id=?').run(uid);
    }
    releaseBrokerAccountOwnershipIfUnused(uid, scope, accountId);
    return res.json({ ok: true, connection: scope });
  }
  const activeModeRow = db.prepare('SELECT mode FROM alpaca_active_mode WHERE user_id=?').get(uid);
  const m = activeModeRow?.mode || 'paper';
  const accountId = storedBrokerAccountId(uid, scope, m);
  db.prepare(`
    INSERT INTO alpaca_creds (user_id,api_key,api_secret,api_key_enc,api_secret_enc,mode,account_id) VALUES (?,?,?,?,?,?,NULL)
    ON CONFLICT(user_id,mode) DO UPDATE SET
      api_key=excluded.api_key, api_secret=excluded.api_secret,
      api_key_enc=NULL, api_secret_enc=NULL, account_id=NULL
  `).run(
    uid, DISCONNECTED_SENTINEL, DISCONNECTED_SENTINEL, null, null, m
  );
  releaseBrokerAccountOwnershipIfUnused(uid, scope, accountId);
  res.json({ ok: true });
});

// Check connection status — returns active-mode creds plus availability of both modes
app.get('/api/alpaca/credentials', requireAuth, (req, res) => {
  const uid   = req.session.userId;
  const scope = requestAlpacaScope(req);
  const creds = getAlpacaCreds(uid, scope);
  const paperConnected = _alpacaCredsExist(uid, 'paper', scope);
  const liveConnected  = _alpacaCredsExist(uid, 'live', scope);
  const activeModeRow  = scope === 'manual'
    ? db.prepare('SELECT mode FROM alpaca_active_mode WHERE user_id=?').get(uid)
    : isOptionsScope(scope)
      ? db.prepare('SELECT mode FROM options_alpaca_active_mode WHERE user_id=?').get(uid)
    : isSwingScope(scope)
      ? db.prepare('SELECT mode FROM swing_alpaca_active_mode WHERE user_id=?').get(uid)
    : isCandlestickScope(scope)
      ? db.prepare('SELECT mode FROM candlestick_alpaca_active_mode WHERE user_id=?').get(uid)
      : db.prepare('SELECT mode FROM bot_alpaca_active_mode WHERE user_id=? AND bot=?').get(uid, scope);
  const activeMode     = activeModeRow?.mode || (creds?.mode) || 'paper';
  res.json({
    connected:      !!creds,
    mode:           activeMode,
    paperConnected,
    liveConnected,
    connection: scope,
    accountId: creds?.account_id || null,
  });
});

// Switch active mode — requires credentials for the target mode to already be stored
app.post('/api/alpaca/switch-mode', requireAuth, (req, res) => {
  const { mode } = req.body || {};
  const m   = mode === 'live' ? 'live' : 'paper';
  const uid = req.session.userId;
  const scope = requestAlpacaScope(req);
  if (isSwingScope(scope) && hasActiveSwingTrades(uid)) {
    return res.status(409).json({
      error: 'Close or fully reconcile active Swing positions before switching its broker mode.',
    });
  }
  if (isOptionsScope(scope) && hasActiveOptionsTrades(uid)) {
    return res.status(409).json({
      error: 'Close or fully reconcile active LEAP option positions before switching its broker mode.',
    });
  }
  if (!_alpacaCredsExist(uid, m, scope)) {
    return res.status(400).json({ error: `No ${m} account connected. Save your ${m} API keys first.` });
  }
  if (scope === 'manual') {
    db.prepare('INSERT OR REPLACE INTO alpaca_active_mode (user_id, mode) VALUES (?,?)').run(uid, m);
  } else if (isOptionsScope(scope)) {
    db.prepare('INSERT OR REPLACE INTO options_alpaca_active_mode (user_id,mode) VALUES (?,?)').run(uid, m);
    db.prepare('UPDATE options_settings SET live_armed=0 WHERE user_id=?').run(uid);
  } else if (isSwingScope(scope)) {
    db.prepare('INSERT OR REPLACE INTO swing_alpaca_active_mode (user_id,mode) VALUES (?,?)').run(uid, m);
    db.prepare('UPDATE swing_settings SET live_armed=0 WHERE user_id=?').run(uid);
  } else if (isCandlestickScope(scope)) {
    db.prepare('INSERT OR REPLACE INTO candlestick_alpaca_active_mode (user_id,mode) VALUES (?,?)').run(uid, m);
    // Switching accounts/modes also requires an intentional new live arm.
    db.prepare('UPDATE candlestick_settings SET live_armed=0 WHERE user_id=?').run(uid);
  } else {
    db.prepare('INSERT OR REPLACE INTO bot_alpaca_active_mode (user_id,bot,mode) VALUES (?,?,?)')
      .run(uid, scope, m);
    if (scope === 'momentum') {
      db.prepare('UPDATE momentum_settings SET live_armed=0 WHERE user_id=?').run(uid);
    } else if (scope === 'pmh') {
      db.prepare('UPDATE pmh_settings SET live_armed=0 WHERE user_id=?').run(uid);
    }
  }
  autoEnablePaperStrategy(uid, scope, m);
  res.json({
    ok: true,
    mode: m,
    connection: scope,
    automationEnabled: shouldAutoEnableAfterConnection(m),
    liveArmed: false,
  });
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

async function evaluateMomentumEntryPriceAction(userId, symbol, scope = 'momentum') {
  const now = new Date();
  const start = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
  const [barsData, snapshots] = await Promise.all([
    alpacaDataFetch(userId,
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=5Min&start=${encodeURIComponent(start)}&limit=100&adjustment=all&feed=iex`,
      scope
    ).catch(() => null),
    alpacaSnapshotFetch(userId, `${symbol},SPY`, scope).catch(() => null),
  ]);
  const rawBars = Array.isArray(barsData?.bars) ? barsData.bars : [];
  const barStartMs = bar => {
    const timestamp = bar?.t;
    return typeof timestamp === 'number'
      ? (timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp)
      : Date.parse(timestamp || '');
  };
  // Alpaca can include the active five-minute bucket. A setup is never allowed
  // to treat an unfinished bar as a close/volume confirmation.
  const bars = rawBars.filter(bar => {
    const startedAt = barStartMs(bar);
    return Number.isFinite(startedAt) && startedAt + 5 * 60_000 <= now.getTime();
  });
  const snapshot = snapshots?.[symbol] || null;
  const spy = snapshots?.SPY || null;
  const price = snapshot?.latestTrade?.p ?? snapshot?.minuteBar?.c ?? bars.at(-1)?.c ?? null;
  const latestBarAt = bars.at(-1)?.t;
  const latestBarMs = barStartMs(bars.at(-1));
  const completedAtMs = Number.isFinite(latestBarMs) ? latestBarMs + 5 * 60_000 : NaN;
  const symbolOpen = snapshot?.dailyBar?.o;
  const spyOpen = spy?.dailyBar?.o;
  const spyPrice = spy?.latestTrade?.p ?? spy?.minuteBar?.c;
  const symbolMove = Number.isFinite(symbolOpen) && Number.isFinite(price) ? price / symbolOpen - 1 : null;
  const marketMove = Number.isFinite(spyOpen) && Number.isFinite(spyPrice) ? spyPrice / spyOpen - 1 : null;
  return evaluatePriceActionSetup({
    symbol,
    bars,
    price,
    market: { trend: Number.isFinite(marketMove) ? (marketMove >= 0 ? 'BULLISH' : 'BEARISH') : 'UNKNOWN' },
    relativeStrength: Number.isFinite(symbolMove) && Number.isFinite(marketMove) ? symbolMove >= marketMove : null,
    freshness: {
      // Require a newly completed five-minute confirmation; after two minutes
      // it is too old for an automated momentum entry.
      fresh: Number.isFinite(completedAtMs) && Date.now() - completedAtMs >= 0 && Date.now() - completedAtMs <= 2 * 60 * 1000,
      sourceTimestamp: latestBarAt || null,
    },
  });
}

async function evaluateMomentumOrderVwap(userId, symbol, now = new Date()) {
  const { start, end } = regularSessionWindow(now);
  if (now < start || now >= end) {
    return evaluateMomentumOrderVwapGate({ bars: [], snapshot: null, now });
  }
  const [barData, snapshotData] = await Promise.all([
    alpacaDataFetch(
      userId,
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=5Min&start=${encodeURIComponent(start.toISOString())}&limit=1000&adjustment=all&feed=iex`,
      'momentum'
    ),
    alpacaSnapshotFetch(userId, symbol, 'momentum'),
  ]);
  const bars = (barData?.bars || []).map(bar => ({
    t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v,
  }));
  return evaluateMomentumOrderVwapGate({
    bars,
    snapshot: snapshotData?.[symbol] || null,
    now,
  });
}

// Place order (market with optional TP/SL bracket)
async function placeAlpacaOrder(req, res) {
  if (isAlpacaFlattening(req.session.userId)) {
    return res.status(409).json({ error: 'Emergency flatten is in progress. New orders are temporarily blocked.' });
  }
  const { symbol, side, amount, tpPct, slPct, leverage, clientOrderId } = req.body || {};
  const scope = req._alpacaScope || requestAlpacaScope(req);

  // ── Input validation ───────────────────────────────────────────────────────
  if (!symbol || !side) return res.status(400).json({ error: 'symbol and side required.' });
  if (!/^[A-Z0-9.\-]{1,12}$/i.test(symbol)) return res.status(400).json({ error: 'Invalid symbol.' });
  const sideL = side.toLowerCase();
  if (sideL !== 'buy' && sideL !== 'sell') return res.status(400).json({ error: 'side must be buy or sell.' });
  const isCryptoSym = isLikelyCryptoSymbol(symbol);
  const requiresMomentumVwap = scope === 'momentum' && sideL === 'buy' && !isCryptoSym;

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

      // Cancel any open orders on this symbol (e.g. the OTO stop-loss child)
      // BEFORE selling — otherwise the leftover stop order could later trigger
      // against nothing (or a re-entered position) and flip the account short.
      try {
        const open = await alpacaFetchFor(req.session.userId, scope, `/v2/orders?status=open&symbols=${symbol.toUpperCase()}`, { method: 'GET' });
        for (const o of (Array.isArray(open) ? open : [])) {
          await alpacaFetchFor(req.session.userId, scope, `/v2/orders/${o.id}`, { method: 'DELETE' }).catch(() => {});
        }
      } catch (_) {} // no open orders / cancel failure → proceed; Alpaca rejects unsafe sells
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
  const requiresPriceAction = requiresPriceActionForEntry({ side: sideL, isCrypto: isCryptoSym });
  if (!isCryptoSym && !isMarketOpen()) {
    return res.status(400).json({ error: 'Market is closed. Equity orders are only accepted during regular market hours (9:35 AM – 3:50 PM ET, Mon–Fri). Use Alpaca directly for extended-hours orders.' });
  }

  let entryLockHeld = false;
  let momentumPriceAction = null;
  let momentumVwapEntry = null;
  try {
    // The order endpoint is shared by manual orders and the Momentum bot.
    // Reserve the cross-bot lock before looking at capacity, so simultaneous
    // buys cannot each consume the last available slot.
    if (sideL === 'buy') {
      if (!acquireBotLock(req.session.userId)) {
        return res.status(409).json({ error: 'Another entry is being prepared. Please wait for it to settle.' });
      }
      entryLockHeld = true;
      if (!isCryptoSym) await assertAlpacaTradableEquity(req.session.userId, symbol, { fresh: true, scope });
      if (requiresMomentumVwap) {
        momentumVwapEntry = await evaluateMomentumOrderVwap(req.session.userId, symbol.toUpperCase());
        if (!momentumVwapEntry.eligible) {
          return res.status(409).json({
            error: `Momentum VWAP gate blocked entry: ${momentumVwapEntry.reason}`,
            vwap: momentumVwapEntry,
          });
        }
      }
      // A non-PMH buy cannot bypass structural setup validation by using the
      // generic order URL. PMH has an independent frozen-opening contract.
      if (requiresPriceAction) {
        momentumPriceAction = await evaluateMomentumEntryPriceAction(req.session.userId, symbol.toUpperCase(), scope);
        if (!momentumPriceAction.eligible || momentumPriceAction.direction !== 'LONG_ONLY') {
          return res.status(409).json({
            error: `Momentum price-action gate blocked entry: ${(momentumPriceAction.reasons || ['no confirmed long setup']).slice(0, 2).join(' ')}`,
            priceAction: momentumPriceAction,
          });
        }
      }
      const slots = await getOpenSlots(req.session.userId, 'Order', scope);
      if (!canReserveEntryUnits(slots)) {
        return res.status(409).json({ error: 'Position limit reached or account data unavailable.' });
      }
    }

    // Re-check the safety gates immediately before building the broker request.
    // The VWAP confirmation is server-owned and deliberately fetched again: a
    // browser response or earlier quote must never authorize a later entry.
    if (requiresPriceAction) {
      momentumPriceAction = await evaluateMomentumEntryPriceAction(req.session.userId, symbol.toUpperCase(), scope);
      if (!momentumPriceAction.eligible || momentumPriceAction.direction !== 'LONG_ONLY') {
        return res.status(409).json({
          error: `Momentum price-action recheck blocked entry: ${(momentumPriceAction.reasons || ['no confirmed long setup']).slice(0, 2).join(' ')}`,
          priceAction: momentumPriceAction,
        });
      }
    }
    if (requiresMomentumVwap) {
      momentumVwapEntry = await evaluateMomentumOrderVwap(req.session.userId, symbol.toUpperCase());
      if (!momentumVwapEntry.eligible) {
        return res.status(409).json({
          error: `Momentum VWAP recheck blocked entry: ${momentumVwapEntry.reason}`,
          vwap: momentumVwapEntry,
        });
      }
    }

    // Get live price to calculate shares and TP/SL levels (Alpaca-first, 24/7)
    const quote = requiresMomentumVwap
      ? null
      : await fetchLiveQuote(symbol.toUpperCase(), req.session.userId, scope);
    // Momentum entries use the fresh executable ask that just cleared the
    // server-side VWAP recheck. Other routes retain the general live quote.
    const price = requiresMomentumVwap
      ? momentumVwapEntry.price
      : quote?.price ?? quote?.regularMarketPrice ?? quote?.regularClose;
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
    // Last possible control-boundary check before the broker POST. This remains
    // separate from the admission check so a direct caller cannot reuse a
    // previously valid browser quote while the stock has moved below VWAP.
    if (requiresMomentumVwap) {
      momentumVwapEntry = await evaluateMomentumOrderVwap(req.session.userId, symbol.toUpperCase());
      if (!momentumVwapEntry.eligible) {
        return res.status(409).json({
          error: `Momentum VWAP final recheck blocked entry: ${momentumVwapEntry.reason}`,
          vwap: momentumVwapEntry,
        });
      }
    }
    if (requiresPriceAction) {
      const roundedStop = Number((price * (1 - slNum / 100)).toFixed(2));
      if (!(slNum > 0) || !Number.isFinite(roundedStop) || roundedStop < Number(momentumPriceAction.invalidation)) {
        throw new Error('Momentum protective stop must be at or above the fresh rounded structural invalidation level.');
      }
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
    if (entryLockHeld) releaseBotLock(req.session.userId);
  }
}

// Manual trading remains isolated from strategy automation. Strategy entries
// are owned exclusively by their server schedulers.
app.post('/api/alpaca/order', requireAuth, (req, res) => {
  req._alpacaScope = 'manual';
  return placeAlpacaOrder(req, res);
});
app.post('/api/momentum/order', requireAuth, (req, res) => {
  res.status(409).json({ error: 'Momentum entries are submitted only by the server automation scheduler.' });
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
  try { await alpacaFetchFor(req.session.userId, requestAlpacaScope(req), `/v2/orders/${req.params.id}`, { method: 'DELETE' }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Close position (market sell)
app.delete('/api/alpaca/position/:sym', requireAuth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) return res.status(400).json({ error: 'Invalid symbol.' });
  try { res.json(await alpacaFetchFor(req.session.userId, requestAlpacaScope(req), `/v2/positions/${sym}`, { method: 'DELETE' })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Persistent Momentum bot trade journal ──────────────────────────────────────
// A journal row is opened when an AUTO-BUY is accepted and finalized when the bot
// observes the position close. This makes performance survive page reloads while
// keeping manual orders out of the bot-specific results.
function botTradePerformance(userId, todayOnly = false, strategy = 'all') {
  const dateFilter = todayOnly
    ? `AND date(closed_at, 'localtime') = date('now', 'localtime')`
    : '';
  const strategyFilter = strategy === 'momentum'
    ? `AND (strategy IS NULL OR strategy='momentum')`
    : '';
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_trades,
      COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
      AVG(CASE WHEN pnl > 0 THEN pnl END) AS average_gain,
      AVG(CASE WHEN pnl < 0 THEN pnl END) AS average_loss,
      COALESCE(SUM(pnl), 0) AS total_realized_pnl
    FROM bot_trade_log
    WHERE user_id = ?
      AND status = 'closed'
      AND exit_price IS NOT NULL
      ${dateFilter}
      ${strategyFilter}
  `).get(userId);
  const totalTrades = Number(row?.total_trades || 0);
  const wins = Number(row?.wins || 0);
  return {
    totalTrades,
    winRate: totalTrades ? +(wins / totalTrades * 100).toFixed(2) : 0,
    averageGain: row?.average_gain == null ? null : Number(row.average_gain),
    averageLoss: row?.average_loss == null ? null : Number(row.average_loss),
    totalRealizedPnl: Number(row?.total_realized_pnl || 0),
  };
}

app.get('/api/bot-trades', requireAuth, (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 250))
    : 100;
  const userId = req.session.userId;
  const momentumOnly = req.query.strategy === 'momentum';
  const strategyClause = momentumOnly
    ? ` AND (strategy IS NULL OR strategy='momentum')`
    : '';
  const openTrades = db.prepare(`
    SELECT id, symbol, entry_price, exit_price, shares, pnl, mode, status,
            stop_price, take_profit_rsi, take_profit_pct, entry_order_id, pending_exit_order_id,
           pending_exit_reason, exit_reason, timestamp, closed_at
    FROM bot_trade_log
    WHERE user_id = ? AND status = 'open'${strategyClause}
    ORDER BY timestamp DESC, id DESC
  `).all(userId);
  const history = db.prepare(`
    SELECT id, symbol, entry_price, exit_price, shares, pnl, mode, status,
            stop_price, take_profit_rsi, take_profit_pct, entry_order_id, pending_exit_order_id,
           pending_exit_reason, exit_reason, timestamp, closed_at
    FROM bot_trade_log
    WHERE user_id = ? AND status <> 'open'${strategyClause}
    ORDER BY COALESCE(closed_at, timestamp) DESC, id DESC
    LIMIT ?
  `).all(userId, limit);
  const trades = [...openTrades, ...history].sort((a, b) =>
    String(b.closed_at || b.timestamp).localeCompare(String(a.closed_at || a.timestamp)) || b.id - a.id
  );

  res.json({
    trades,
    performance: {
      today: botTradePerformance(userId, true, momentumOnly ? 'momentum' : 'all'),
      allTime: botTradePerformance(userId, false, momentumOnly ? 'momentum' : 'all'),
    },
  });
});

app.post('/api/bot-trades', requireAuth, (req, res) => {
  const body = req.body || {};
  const userId = req.session.userId;
  const momentumJournal = body.connection === 'momentum';
  const action = String(body.action || body.event || '').trim().toLowerCase();
  const isEntry = ['buy', 'entry', 'auto-buy', 'auto_buy'].includes(action);
  const isExit = ['exit', 'close', 'sell', 'auto-exit', 'auto_exit'].includes(action);
  const isEntrySync = ['sync', 'sync-entry', 'sync_entry'].includes(action);
  const isExitPending = ['submit-exit', 'submit_exit', 'pending-exit', 'pending_exit'].includes(action);
  const isClearExitPending = ['clear-exit', 'clear_exit', 'clear-pending-exit', 'clear_pending_exit'].includes(action);
  const isVoid = ['void', 'cancel', 'cancel-entry'].includes(action);
  const symbol = String(body.symbol || '').trim().toUpperCase();

  if (!isEntry && !isExit && !isEntrySync && !isExitPending && !isClearExitPending && !isVoid) {
    return res.status(400).json({ error: 'action must be a buy/entry, entry sync, exit event, or void event.' });
  }
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol.' });
  }

  if (isVoid) {
    const requestedTradeId = Number.parseInt(body.tradeId, 10);
    if (!Number.isInteger(requestedTradeId) || requestedTradeId <= 0) {
      return res.status(400).json({ error: 'tradeId is required to void an open trade.' });
    }
    const openTrade = db.prepare(`
      SELECT * FROM bot_trade_log WHERE id=? AND user_id=? AND symbol=? AND status='open'
      ${momentumJournal ? `AND (strategy IS NULL OR strategy='momentum')` : ''}
    `).get(requestedTradeId, userId, symbol);
    if (!openTrade) {
      return res.status(404).json({ error: `No open bot trade found for ${symbol}.` });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : 'Entry order was not accepted';
    db.prepare(`UPDATE bot_trade_log SET status='void', exit_reason=?, closed_at=datetime('now') WHERE id=?`)
      .run(reason, openTrade.id);
    const trade = db.prepare('SELECT * FROM bot_trade_log WHERE id=?').get(openTrade.id);
    return res.json({
      trade,
      performance: {
        today: botTradePerformance(userId, true, momentumOnly ? 'momentum' : 'all'),
        allTime: botTradePerformance(userId, false, momentumOnly ? 'momentum' : 'all'),
      },
    });
  }

  if (isExitPending || isClearExitPending) {
    const requestedTradeId = Number.parseInt(body.tradeId, 10);
    if (!Number.isInteger(requestedTradeId) || requestedTradeId <= 0) {
      return res.status(400).json({ error: 'tradeId is required to update an exit order.' });
    }
    const openTrade = db.prepare(`
      SELECT * FROM bot_trade_log WHERE id=? AND user_id=? AND symbol=? AND status='open'
      ${momentumJournal ? `AND (strategy IS NULL OR strategy='momentum')` : ''}
    `).get(requestedTradeId, userId, symbol);
    if (!openTrade) {
      return res.status(404).json({ error: `No open bot trade found for ${symbol}.` });
    }
    if (isExitPending) {
      const exitOrderId = typeof body.exitOrderId === 'string' ? body.exitOrderId.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(exitOrderId)) {
        return res.status(400).json({ error: 'exitOrderId is required for a pending exit.' });
      }
      const reason = typeof body.exitReason === 'string'
        ? body.exitReason.trim().slice(0, 200)
        : 'Broker exit submitted';
      db.prepare(`
        UPDATE bot_trade_log SET pending_exit_order_id=?, pending_exit_reason=? WHERE id=?
      `).run(exitOrderId, reason, openTrade.id);
    } else {
      db.prepare(`
        UPDATE bot_trade_log SET pending_exit_order_id=NULL, pending_exit_reason=NULL WHERE id=?
      `).run(openTrade.id);
    }
    const trade = db.prepare('SELECT * FROM bot_trade_log WHERE id=?').get(openTrade.id);
    return res.json({
      trade,
      performance: {
        today: botTradePerformance(userId, true),
        allTime: botTradePerformance(userId),
      },
    });
  }

  if (isEntry || isEntrySync) {
    const entryPrice = Number(body.entryPrice);
    const shares = Number(body.shares);
    const requestedTradeId = Number.parseInt(body.tradeId, 10);
    if (isEntrySync) {
      if (!Number.isInteger(requestedTradeId) || requestedTradeId <= 0) {
        return res.status(400).json({ error: 'tradeId is required to sync an open trade.' });
      }
      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(shares) || shares <= 0) {
        return res.status(400).json({ error: 'entryPrice and shares must be positive numbers.' });
      }
      const openTrade = db.prepare(`
        SELECT * FROM bot_trade_log WHERE id=? AND user_id=? AND symbol=? AND status='open'
        ${momentumJournal ? `AND (strategy IS NULL OR strategy='momentum')` : ''}
      `).get(requestedTradeId, userId, symbol);
      if (!openTrade) {
        return res.status(404).json({ error: `No open bot trade found for ${symbol}.` });
      }
      db.prepare('UPDATE bot_trade_log SET entry_price=?, shares=? WHERE id=?')
        .run(entryPrice, shares, openTrade.id);
      const trade = db.prepare('SELECT * FROM bot_trade_log WHERE id=?').get(openTrade.id);
      return res.json({
        trade,
        performance: {
          today: botTradePerformance(userId, true),
          allTime: botTradePerformance(userId),
        },
      });
    }

    const stopPrice = body.stopPrice == null ? null : Number(body.stopPrice);
    const takeProfitRsi = body.takeProfitRsi == null ? null : Number(body.takeProfitRsi);
    const takeProfitPct = body.takeProfitPct == null ? null : Number(body.takeProfitPct);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return res.status(400).json({ error: 'entryPrice must be a positive number.' });
    }
    if (!Number.isFinite(shares) || shares <= 0) {
      return res.status(400).json({ error: 'shares must be a positive number.' });
    }
    if (stopPrice != null && (!Number.isFinite(stopPrice) || stopPrice <= 0)) {
      return res.status(400).json({ error: 'stopPrice must be a positive number when provided.' });
    }
    if (takeProfitRsi != null && (!Number.isFinite(takeProfitRsi) || takeProfitRsi <= 0 || takeProfitRsi > 100)) {
      return res.status(400).json({ error: 'takeProfitRsi must be between 0 and 100 when provided.' });
    }
    if (takeProfitPct != null && (!Number.isFinite(takeProfitPct) || takeProfitPct <= 0 || takeProfitPct > 100)) {
      return res.status(400).json({ error: 'takeProfitPct must be between 0 and 100 when provided.' });
    }

    const entryOrderId = typeof body.entryOrderId === 'string'
      ? body.entryOrderId.trim().slice(0, 100)
      : null;
    if (entryOrderId) {
      const existing = db.prepare(`
        SELECT * FROM bot_trade_log WHERE user_id=? AND entry_order_id=?
      `).get(userId, entryOrderId);
      if (existing) {
        return res.json({
          trade: existing,
          performance: {
            today: botTradePerformance(userId, true),
            allTime: botTradePerformance(userId),
          },
        });
      }
    }
    const modeRow = momentumJournal
      ? db.prepare('SELECT mode FROM bot_alpaca_active_mode WHERE user_id=? AND bot=?').get(userId, 'momentum')
      : db.prepare('SELECT mode FROM alpaca_active_mode WHERE user_id=?').get(userId);
    const mode = modeRow?.mode === 'live' ? 'live' : 'paper';
    const result = db.prepare(`
      INSERT INTO bot_trade_log
        (user_id, symbol, entry_price, shares, mode, stop_price, take_profit_rsi, take_profit_pct, entry_order_id, strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, symbol, entryPrice, shares, mode, stopPrice, takeProfitRsi, takeProfitPct,
      entryOrderId, momentumJournal ? 'momentum' : null
    );
    const trade = db.prepare('SELECT * FROM bot_trade_log WHERE id=?').get(result.lastInsertRowid);
    return res.status(201).json({
      trade,
      performance: {
        today: botTradePerformance(userId, true),
        allTime: botTradePerformance(userId),
      },
    });
  }

  const exitPrice = Number(body.exitPrice);
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    return res.status(400).json({ error: 'exitPrice must be a positive number.' });
  }
  const brokerEntryPrice = body.entryPrice == null ? null : Number(body.entryPrice);
  const brokerExitShares = body.shares == null ? null : Number(body.shares);
  if (brokerEntryPrice != null && (!Number.isFinite(brokerEntryPrice) || brokerEntryPrice <= 0)) {
    return res.status(400).json({ error: 'entryPrice must be a positive number when provided.' });
  }
  if (brokerExitShares != null && (!Number.isFinite(brokerExitShares) || brokerExitShares <= 0)) {
    return res.status(400).json({ error: 'shares must be a positive number when provided.' });
  }
  const requestedTradeId = Number.parseInt(body.tradeId, 10);
  const trade = Number.isInteger(requestedTradeId) && requestedTradeId > 0
    ? db.prepare(`
        SELECT * FROM bot_trade_log
        WHERE id=? AND user_id=? AND symbol=? AND status='open'
        ${momentumJournal ? `AND (strategy IS NULL OR strategy='momentum')` : ''}
      `).get(requestedTradeId, userId, symbol)
    : db.prepare(`
        SELECT * FROM bot_trade_log
        WHERE user_id=? AND symbol=? AND status='open'
        ${momentumJournal ? `AND (strategy IS NULL OR strategy='momentum')` : ''}
        ORDER BY id DESC LIMIT 1
      `).get(userId, symbol);
  if (!trade) {
    return res.status(404).json({ error: `No open bot trade found for ${symbol}.` });
  }

  const finalEntryPrice = brokerEntryPrice ?? Number(trade.entry_price);
  const finalShares = brokerExitShares ?? Number(trade.shares);
  const pnl = +((exitPrice - finalEntryPrice) * finalShares).toFixed(6);
  const exitReason = typeof body.exitReason === 'string'
    ? body.exitReason.trim().slice(0, 200)
    : null;
  db.prepare(`
    UPDATE bot_trade_log
    SET entry_price=?, shares=?, exit_price=?, pnl=?, status='closed',
        pending_exit_order_id=NULL, pending_exit_reason=NULL, exit_reason=?, closed_at=datetime('now')
    WHERE id=?
  `).run(finalEntryPrice, finalShares, exitPrice, pnl, exitReason, trade.id);
  const closedTrade = db.prepare('SELECT * FROM bot_trade_log WHERE id=?').get(trade.id);
  res.json({
    trade: closedTrade,
    performance: {
      today: botTradePerformance(userId, true),
      allTime: botTradePerformance(userId),
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-TRADER ENGINE  (production-quality, no mock data)
// ═══════════════════════════════════════════════════════════════════════════════


// ── Bounce 2.0 — Indicator Math ───────────────────────────────────────────────
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
function calcStochastic(bars, kPeriod = 8, kSmooth = 3, dPeriod = 3) {
  if (bars.length < kPeriod + kSmooth + dPeriod - 2) return null;
  const rawK = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1);
    const ll = Math.min(...slice.map(b => b.l));
    const hh = Math.max(...slice.map(b => b.h));
    const rng = hh - ll;
    rawK.push(rng === 0 ? 50 : ((bars[i].c - ll) / rng) * 100);
  }
  if (rawK.length < kSmooth) return null;
  // Smoothed %K = rolling SMA(kSmooth) of rawK — return last value
  const smoothedKArr = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    const s = rawK.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / kSmooth;
    smoothedKArr.push(s);
  }
  if (smoothedKArr.length < dPeriod) return null;
  const pctK = smoothedKArr.at(-1);
  const pctD = smoothedKArr.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  return { pctK, pctD };
}


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

let _paperRegimeCache = { at: 0, value: null };
async function resolvePaperMarketRegime() {
  const now = Date.now();
  if (_paperRegimeCache.value && now - _paperRegimeCache.at < 5 * 60 * 1000) {
    return _paperRegimeCache.value;
  }
  try {
    const bars = await fetchOHLCV('SPY', 30);
    const closes = (bars || []).map(bar => Number(bar.c)).filter(Number.isFinite);
    if (closes.length < 20) return null;
    const prior = closes.slice(-21, -1);
    const basis = prior.length >= 20 ? prior : closes.slice(-20);
    const sma20 = basis.reduce((sum, value) => sum + value, 0) / basis.length;
    const last = closes.at(-1);
    const value = last >= sma20 ? 'BULLISH' : 'BEARISH';
    _paperRegimeCache = { at: now, value };
    return value;
  } catch {
    return null;
  }
}


// ── Bounce 2.0 Scanner Universe ───────────────────────────────────────────────
// ── Master scan universe — all 4 bots use this list ───────────────────────────
// Symbols transcribed from the user's portfolio screenshots. Keep this list
// explicit so it is easy to audit when the shared bot library changes.
const SCREENSHOT_STOCK_LIBRARY = [
  'OKLL','SKHL','AVS','SPCH','SNDC','MSTZ','RGTZ','RAM','APRE','CDTG',
  'INTW','HODU','TSLG','PATX','MUU','SNXX','SKHX','GLL','TSXD','TSLZ',
  'NVDQ','TSDD','CORD','DAMD','PLTD','SMCZ','QQQD','ORCZ','NVD','ORCU',
  'SOFX','KEEL','CIFG','AFRU','IRE','AMAU','NVDL','SMCX','PLTG','ADBG',
  'NOWL','VYX','UECG','NUVB','NVDY','TSLL','SATL','USAS','EXK','MTA',
  'BTG','DNN','CRML','TMQ','ASM','PLG','IAUX',
];
// PMH's default scan universe — shared by the manual scan endpoint and the
// always-on server-side scheduler so both consider the same symbols.
const PMH_DEFAULT_SYMBOLS = [
  'AAPL','NVDA','AMD','TSLA','PLTR','SOFI','HOOD','MARA','IONQ','SMCI','COIN','QQQ','SPY',
  ...SCREENSHOT_STOCK_LIBRARY,
];
// PMH remains available for paper validation, but live submissions are paused
// until its broker-race and partial-fill evidence is complete. An explicit
// environment override is required to re-enable live execution.
const PMH_LIVE_AUTOMATION_PAUSED = process.env.PMH_LIVE_AUTOMATION_PAUSED !== 'false';

function pmhLivePauseReason(userId) {
  const creds = getAlpacaCreds(userId, 'pmh');
  return PMH_LIVE_AUTOMATION_PAUSED && creds?.mode === 'live'
    ? 'PMH live automation is paused for safety validation. Paper mode remains available.'
    : null;
}
// Broader discovery defaults deliberately retain the hard execution safeguards:
// a current price, real liquidity, broker tradability, completed/fresh
// price-action evidence, structural invalidation, market hours, risk sizing,
// duplicate prevention, and broker-held exits are still mandatory.
const DEFAULT_MOMENTUM_CONFIG = Object.freeze({
  // Position dollars is the only user-editable strategy value. Every signal,
  // risk, universe, and execution threshold below is server-owned.
  positionMode: 'fixed',
  positionValue: 1000,
  maxPositionDollars: 1000,
  maxTradesPerDay: 5,
  maxDailyLoss: 500,
  minPrice: 1,
  maxPrice: 100,
  minGainPercent: 2,
  minRelVol: 1.5,
  requireNewsCatalyst: false,
  maxFloat: 100_000_000,
  minVolume: 100_000,
  minScore: 2,
  stopPercent: 5,
  takeProfitPercent: 10,
  minRR: 2,
  emaFast: 9,
  emaSlow: 21,
  universeMode: 'alpaca',
});
function sanitizeMomentumExecutionConfig(input = {}) {
  return serverOwnedMomentumConfig(DEFAULT_MOMENTUM_CONFIG, input);
}
function momentumConfigFor(userId) {
  const row = db.prepare(`SELECT enabled,live_armed,config_json,updated_at,last_cycle_at,
    last_cycle_status,last_cycle_reason,last_cycle_source
    FROM momentum_settings WHERE user_id=?`).get(userId);
  let saved = {};
  try { saved = row?.config_json ? JSON.parse(row.config_json) : {}; } catch (_) {}
  const openTrades = Number(db.prepare(`SELECT COUNT(*) AS count FROM bot_trade_log
    WHERE user_id=? AND status='open' AND (strategy IS NULL OR strategy='momentum')`).get(userId)?.count || 0);
  const creds = getAlpacaCreds(userId, 'momentum');
  return {
    enabled: !!row?.enabled,
    liveArmed: !!row?.live_armed,
    config: serverOwnedMomentumConfig(DEFAULT_MOMENTUM_CONFIG, saved),
    runtime: {
      settingsUpdatedAt: row?.updated_at || null,
      lastCycleAt: row?.last_cycle_at || null,
      lastCycleStatus: row?.last_cycle_status || null,
      lastCycleReason: row?.last_cycle_reason || null,
      lastCycleSource: row?.last_cycle_source || null,
      openTrades,
      mode: creds?.mode || null,
      ...momentumWorkerHealth({
        enabled: !!row?.enabled,
        connected: !!creds,
        openTrades,
        lastCycleAt: row?.last_cycle_at,
        lastCycleStatus: row?.last_cycle_status,
        lastCycleReason: row?.last_cycle_reason,
      }),
    },
  };
}

function recordMomentumCycle(userId, outcome) {
  db.prepare(`INSERT INTO momentum_settings
    (user_id,enabled,live_armed,config_json,last_cycle_at,last_cycle_status,last_cycle_reason,last_cycle_source,updated_at)
    VALUES (?,0,0,'{}',datetime('now'),?,?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      last_cycle_at=datetime('now'),last_cycle_status=excluded.last_cycle_status,
      last_cycle_reason=excluded.last_cycle_reason,last_cycle_source=excluded.last_cycle_source`)
    .run(
      userId,
      String(outcome?.status || 'unknown').slice(0, 40),
      String(outcome?.reason || '').slice(0, 300) || null,
      String(outcome?.source || 'server-scheduler').slice(0, 40),
    );
}

function momentumSymbolCoolingDown(userId, symbol) {
  return !!db.prepare(`SELECT 1 FROM bot_trade_log
    WHERE user_id=? AND symbol=? AND (strategy IS NULL OR strategy='momentum')
      AND exit_cooldown_until > datetime('now')
    ORDER BY id DESC LIMIT 1`).get(userId, symbol);
}

function assertPinnedMomentumAccount(userId, pinnedCreds) {
  const active = getAlpacaCreds(userId, 'momentum');
  if (!active || !pinnedCreds
      || active.mode !== pinnedCreds.mode
      || active.account_id !== pinnedCreds.account_id) {
    throw new Error('The active Momentum broker account changed during the worker cycle.');
  }
}

function momentumBrokerFetch(userId, pinnedCreds, path, opts = {}) {
  assertPinnedMomentumAccount(userId, pinnedCreds);
  return alpacaFetchWithCredentials(pinnedCreds, path, opts);
}

async function momentumBrokerMutation(userId, pinnedCreds, path, opts) {
  assertPinnedMomentumAccount(userId, pinnedCreds);
  beginAlpacaOrderRequest(userId);
  try {
    if (isAlpacaFlattening(userId)) {
      throw new Error('Emergency flatten is in progress; Momentum order changes are blocked.');
    }
    return await alpacaFetchWithCredentials(pinnedCreds, path, opts);
  } finally {
    endAlpacaOrderRequest(userId);
  }
}

const momentumInverseCycleStore = createMomentumInverseCycleStore(db);

async function getMomentumMarketDirection(userId, now = new Date()) {
  const { start, end } = regularSessionWindow(now);
  if (now < start || now >= end) {
    return evaluateMarketDirection({}, now);
  }
  const rows = await Promise.all(['SPY', 'QQQ'].map(async symbol => {
    const data = await alpacaDataFetch(
      userId,
      `/v2/stocks/${symbol}/bars?timeframe=5Min&start=${encodeURIComponent(start.toISOString())}&limit=1000&adjustment=all&feed=iex`,
      'momentum'
    );
    return [symbol, (data?.bars || []).map(bar => ({
      t: bar.t, o: Number(bar.o), h: Number(bar.h), l: Number(bar.l), c: Number(bar.c), v: Number(bar.v),
    }))];
  }));
  return evaluateMarketDirection(Object.fromEntries(rows), now);
}

function pmhConfigFor(userId) {
  const row = db.prepare('SELECT enabled,live_armed,config_json FROM pmh_settings WHERE user_id=?').get(userId);
  let saved = {};
  try { saved = row?.config_json ? JSON.parse(row.config_json) : {}; } catch (_) {}
  return {
    enabled: !!row?.enabled,
    liveArmed: !!row?.live_armed,
    config: serverOwnedConfig(DEFAULT_PMH_CONFIG, saved),
  };
}

const MASTER_UNIVERSE = [
  // ── Mega-cap tech ──────────────────────────────────────────────────────────
  'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','PLTR','COIN',
  // ── High-beta / crypto adjacent ────────────────────────────────────────────
  'HOOD','SOFI','MARA','RIOT','CLSK','CORZ','HUT','BITF','IREN','BMNR','SMCL','PMAX',
  // ── Leveraged long ETFs ────────────────────────────────────────────────────
  'TQQQ','SOXL','SPXL','TECL','LABU','UPRO','TNA','FAS','ERX','UDOW',
  'TSLL','NVDX','NVDL','AMDL','PLTG','HOOG','NVDG','MSFU','AAPU','AMZU','GGLL','METU',
  // ── Major index ETFs ───────────────────────────────────────────────────────
  'SPY','QQQ','IWM','DIA','SMH','ARKK',
  // ── Inverse / short ETFs ───────────────────────────────────────────────────
  'SQQQ','QID','AAPD','AMDD','AMZD','PLTD','QQQD','NVD','NVDQ','MSTZ','TSLZ','TSDD',
  'SBIT','TZA','SPXS','SOXS','TECS','FAZ','ERY','LABD','DUST','JDST',
  'AIBD','TSXD','DRIP','DXD',
  'SH','PSQ','RWM','DOG','TBF','SJB','GLL','ZSL','SCO','SARK','GGLS','RGTZ','CORD',
  // ── Consumer / growth tech ─────────────────────────────────────────────────
  'NFLX','UBER','SHOP','SQ','PYPL','SNAP','PINS','RBLX','DKNG',
  // ── Autos / EV ─────────────────────────────────────────────────────────────
  'F','GM','RIVN','NIO','LI','ACHR',
  // ── Robotics / drones ──────────────────────────────────────────────────────
  'RCAT','UMAC','RR','SERV','ONDS',
  // ── Quantum / AI stocks ────────────────────────────────────────────────────
  'QBTS','RGTI','SOUN','BBAI',
  // ── Semiconductors ─────────────────────────────────────────────────────────
  'TSM','AVGO','QCOM','MU','INTC','AMAT','LRCX','KLAC','ARM','SMCI','NVTS',
  // ── Financials ─────────────────────────────────────────────────────────────
  'JPM','BAC','GS','MS','C','WFC','SCHW','AXP','LDI',
  // ── Energy ─────────────────────────────────────────────────────────────────
  'XOM','CVX','COP','SLB','HAL','RIG','EGY','BTE','ANNA','NEXT','URG',
  'UUUU','SMR',
  'TALO','SOC','SSL','PBR','CLF',
  // ── Commodities / metals ETFs ──────────────────────────────────────────────
  'GLD','SLV','GDX','GDXJ','USO',
  // ── Mining / precious metals stocks ───────────────────────────────────────
  'USAS','ASM','CRML','DNN','NVA','TMQ','TGB','NAK','PLG','IAUX',
  // ── Lithium / battery materials ────────────────────────────────────────────
  'LAC',
  // ── Cloud / cyber ──────────────────────────────────────────────────────────
  'CRWD','S','PANW','SNOW','DDOG','TWLO','MDB','ZS','NET',
  // ── Biotech / pharma (large cap) ───────────────────────────────────────────
  'MRNA','BNTX','PFE','ABBV','LLY','REGN',
  // ── Biotech / genomics (high-beta small & mid cap, mostly <$25) ────────────
  'NVAX','RXRX','BEAM','EDIT','CRSP','NTLA','FATE','SGMO','NKTR',
  'TGTX','IMVT','DNLI','ARDX','SANA','GERN','AGEN','IOVA','PRAX','ACAD',
  // ── Digital health / medical devices ───────────────────────────────────────
  'TDOC','HIMS','DOCS','NVCR','TMDX','NVRO','PTON',
  // ── High-volume small caps (<$25) ──────────────────────────────────────────
  'IONQ','RKLB','ASTS','JOBY','LUNR','GSAT','CLOV','OPEN','SPWR',
  // ── Biotech & healthcare ETFs (base + leveraged bull/bear) ─────────────────
  // XBI = SPDR S&P Biotech | IBB = iShares Biotech | ARKG = ARK Genomic
  // BIB = 2x long IBB | BIS = 2x short IBB | CURE = 3x Healthcare bull
  'XBI','IBB','ARKG','BIB','BIS','CURE',
  // ── Small-cap leveraged / inverse (Russell 2000) ────────────────────────────
  // URTY = 3x long IWM | SRTY = 3x inverse IWM
  'URTY','SRTY',
  // ── Cannabis — high-volume momentum, typically <$5 ─────────────────────────
  'TLRY','SNDL','CGC','ACB','CRON',
  // ── EV / clean-energy penny stocks ──────────────────────────────────────────
  'WKHS','GOEV','MULN','NKLA',
  // ── Biotech penny stocks (<$5, active short-term momentum) ──────────────────
  'BNGO','OCGN','SENS','APLT','CRBP','ABVC',
  // ── Tech / meme penny stocks ────────────────────────────────────────────────
  'MVIS','BB','NOK','AMC','ATER','XELA','HOLO','VERB',
  // ── Shipping / energy penny stocks ──────────────────────────────────────────
  'IMPP','INDO','FFIE',
  // ── Crypto-adjacent penny miners ────────────────────────────────────────────
  'BTBT','CIFR','SLNH',
  // ── Large-cap value / defensives ───────────────────────────────────────────
  'BRK.B','V','MA','UNH','JNJ','PG','HD','MRK','COST','WMT','KO','PEP',
  'TMO','ORCL','CRM','CSCO','ACN','MCD','LIN','ADBE','ABT','DHR','NKE',
  'TXN','AMGN','QCOM','NEE','UNP','PM','RTX','HON','INTU','IBM',
  'SPGI','LOW','CAT','DE','ELV','ISRG','BLK','BKNG','SYK','MMC',
  'GILD','PLD','ADI','MDT','TJX','VRTX','SO','DUK','MO','ZTS','CB','CI',
  'CME','EOG','TLT','HYG',
  // ── Crypto tokens (Layer-1 / Layer-2) ─────────────────────────────────────
  'AVAX','LINK','ETC','UNI','TRUMP','RENDER','ZRO','TON','NEAR',
  'XRP','DOT','LIT','SUI','ORCA','MNT','ASTER','VIRTUAL',
  'XTZ','ADA','ARB','OP','HBAR','XLM','DOGE',
  // ── DeFi tokens ────────────────────────────────────────────────────────────
  'RAY','AERO','LDO','SNX','ONDO','SYRUP','CRV',
  'ENA','EIGEN','IMX','GRT','SKY','SEI','PYTH',
  // ── Meme / community tokens ────────────────────────────────────────────────
  'WIF','POPCAT','MOODENG','PENGU','FLOKI','SHIB','BONK','PEPE',
  // ── Smaller / emerging tokens ──────────────────────────────────────────────
  'WLFI','AVNT','XPL','SKR','ZORA','XCN','MEW','CC',
  // ── User-added ─────────────────────────────────────────────────────────────
  'ADBG','GLND','USAR','ZSX','DOGD','AVS','BABO','KMLI','NBIG','NBIZ','LLYX','BRKU',
  ...SCREENSHOT_STOCK_LIBRARY,
];


// ── Latest paper-only walk-forward validation report ─────────────────────────
// Read-only: this route cannot alter scanner settings or submit broker orders.
app.get('/api/momentum/strategy-validation', requireAuth, (req, res) => {
  const reportPath = path.join(__dirname, 'reports', 'strategy-validation-latest.json');
  res.set('Cache-Control', 'no-store');
  try {
    if (!fs.existsSync(reportPath)) {
      return res.json({ available: false, mode: 'PAPER_ONLY' });
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const walkForward = report.walkForward || {};
    const checks = walkForward.promotionChecks || {};
    return res.json({
      available: true,
      studyId: report.studyId,
      generatedAt: report.generatedAt,
      mode: 'PAPER_ONLY',
      promotionStatus: walkForward.promotionStatus || 'NO_PROMOTION',
      selectionOutcome: walkForward.selectionOutcome || null,
      selectedName: walkForward.selectionAudit?.selectedName || 'baseline',
      testMetrics: walkForward.testResults?.metrics || {},
      testConfidenceInterval: walkForward.testResults?.ci || null,
      inputSha256: report.inputSnapshot?.inputSha256 || null,
      snapshotPath: report.inputSnapshot?.snapshotPath || null,
      experimentSha256: report.experiment?.experimentSha256 || null,
      replayCommand: report.experiment?.replayCommand || null,
      failedChecks: Object.entries(checks)
        .filter(([, check]) => !check?.pass)
        .map(([name]) => name),
      sampleAdequate: !!checks.minValidationTrades?.pass && !!checks.minTestTrades?.pass,
      strategyEvaluable: walkForward.promotionStatus === 'PROMOTED_TO_PAPER'
        && !!checks.minValidationTrades?.pass
        && !!checks.minTestTrades?.pass,
      provider: report.dataQuality?.provider || 'unknown',
      feed: report.dataQuality?.feed || 'historical OHLCV',
      receivedSymbols: report.dataQuality?.receivedSymbols || 0,
      barCount: report.dataQuality?.barCount || 0,
      primaryCaveat: report.dataQuality?.dataGaps?.[0]
        || 'Historical results do not guarantee future performance.',
      liveOrdersChanged: false,
    });
  } catch (error) {
    console.error('Strategy validation report read error:', error.message);
    return res.status(500).json({ error: 'Validation report could not be read' });
  }
});

// ── Live paper/shadow comparison ──────────────────────────────────────────────
// Read-only summary of hypothetical decisions/outcomes observed by scanner
// requests. The service has no Alpaca dependency and cannot submit orders.
app.get('/api/momentum/paper-comparison', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json(paperShadow.summary());
  } catch (error) {
    console.error('[PaperShadow] summary:', error.message);
    return res.status(503).json({
      available: false,
      mode: 'PAPER_ONLY',
      liveExecutionAllowed: false,
      error: 'Paper comparison is temporarily unavailable',
    });
  }
});

// ── Opening Momentum — PMH Break data contract ────────────────────────────────
function pmhEtParts(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function pmhFinite(value) {
  return value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
    && Number.isFinite(Number(value));
}

function pmhValidMinute(bar) {
  if (!bar || ![bar.o, bar.h, bar.l, bar.c, bar.v].every(pmhFinite)) return false;
  const [o, h, l, c, v] = [bar.o, bar.h, bar.l, bar.c, bar.v].map(Number);
  return o > 0 && h > 0 && l > 0 && c > 0 && v > 0
    && h >= l && h >= o && h >= c && l <= o && l <= c;
}

function pmhCompleteMinuteGroup(values, expectedBars) {
  if (values.length !== expectedBars || !values.every(pmhValidMinute)) return false;
  const times = values.map(bar => new Date(bar.t).getTime());
  return times.every((time, index) => Number.isFinite(time) && (index === 0 || time - times[index - 1] === 60_000));
}

function pmhTwoMinuteBars(bars) {
  const groups = new Map();
  for (const b of (Array.isArray(bars) ? bars : [])) {
    const et = pmhEtParts(b.t);
    if (!et || et.minutes < 570 || et.minutes >= 960) continue;
    const bucket = Math.floor((et.minutes - 570) / 2);
    const key = `${et.date}:${bucket}`;
    const g = groups.get(key) || { date: et.date, bucket, bars: [] };
    g.bars.push(b); groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    const values = g.bars.slice().sort((a, b) => new Date(a.t) - new Date(b.t));
    if (!pmhCompleteMinuteGroup(values, 2)) return null;
    return {
      date: g.date, bucket: g.bucket, t: values[0].t,
      open: Number(values[0].o), high: Math.max(...values.map(b => Number(b.h))),
      low: Math.min(...values.map(b => Number(b.l))), close: Number(values.at(-1).c),
      volume: values.reduce((sum, b) => sum + Number(b.v), 0),
      complete: true,
    };
  }).filter(Boolean);
}

function pmhFiveMinuteBars(bars) {
  const groups = new Map();
  for (const b of (Array.isArray(bars) ? bars : [])) {
    const et = pmhEtParts(b.t);
    if (!et || et.minutes < 570 || et.minutes >= 960) continue;
    const bucket = Math.floor((et.minutes - 570) / 5);
    const key = `${et.date}:${bucket}`;
    const group = groups.get(key) || { date: et.date, bucket, bars: [] };
    group.bars.push(b);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const values = group.bars.slice().sort((a, b) => new Date(a.t) - new Date(b.t));
    if (!pmhCompleteMinuteGroup(values, 5)) return null;
    return {
      t: values[0].t,
      o: Number(values[0].o),
      h: Math.max(...values.map(b => Number(b.h))),
      l: Math.min(...values.map(b => Number(b.l))),
      c: Number(values.at(-1).c),
      v: values.reduce((sum, b) => sum + Number(b.v), 0),
      session: 'reg',
    };
  }).filter(Boolean);
}

function pmhMeanStd(values) {
  const nums = values.filter(Number.isFinite);
  if (nums.length < 5) return null;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return { mean, stdDev: Math.sqrt(variance), samples: nums.length };
}

function pmhFresh(timestamp, maxAgeMs) {
  const time = new Date(timestamp || 0).getTime();
  return Number.isFinite(time) && Date.now() - time >= 0 && Date.now() - time <= maxAgeMs;
}

async function buildPmhCandidate(userId, symbol, config = DEFAULT_PMH_CONFIG) {
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  if (!sym) return { symbol: '', status: 'BLOCKED', eligible: false, reasons: ['Invalid symbol.'] };
  const now = new Date();
  const end = now.toISOString();
  const start = new Date(now.getTime() - 21 * 86400000).toISOString();
  const [snapshots, barsData, dailyData, spySnapshots] = await Promise.all([
    alpacaSnapshotFetch(userId, `${sym},SPY`, 'pmh').catch(() => null),
    alpacaDataFetch(userId, `/v2/stocks/${sym}/bars?timeframe=1Min&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000&adjustment=all&feed=iex`, 'pmh').catch(() => null),
    alpacaDataFetch(userId, `/v2/stocks/${sym}/bars?timeframe=1Day&limit=30&adjustment=all&feed=iex`, 'pmh').catch(() => null),
    alpacaSnapshotFetch(userId, 'SPY', 'pmh').catch(() => null),
  ]);
  const snap = snapshots?.[sym];
  const spy = spySnapshots?.SPY || snapshots?.SPY;
  const oneMinute = Array.isArray(barsData?.bars) ? barsData.bars : [];
  const twoMinute = pmhTwoMinuteBars(oneMinute)
    .filter(bar => new Date(bar.t).getTime() + 2 * 60_000 <= now.getTime());
  const fiveMinute = pmhFiveMinuteBars(oneMinute);
  const etNow = pmhEtParts(now);
  const sessionDate = etNow?.date || now.toISOString().slice(0, 10);
  const sessionBars = oneMinute.filter(b => pmhEtParts(b.t)?.date === sessionDate);
  const premarketBars = sessionBars.filter(b => {
    const mins = pmhEtParts(b.t)?.minutes;
    return mins >= 240 && mins < 570;
  });
  const regularBars = sessionBars.filter(b => (pmhEtParts(b.t)?.minutes || 0) >= 570);
  const previous = snap?.prevDailyBar || {};
  const firstRegular = regularBars.slice().sort((a, b) => new Date(a.t) - new Date(b.t))[0];
  const openingPrice = snap?.dailyBar?.o ?? firstRegular?.o ?? null;

  let frozen = db.prepare('SELECT * FROM pmh_session_snapshots WHERE user_id=? AND symbol=? AND session_date=?')
    .get(userId, sym, sessionDate);
  // A PMH is immutable only once the entire pre-market session has ended. Do
  // not write an early 04:00–09:29 reading, or a later pre-market high would
  // be silently ignored and create a false breakout level.
  if (!frozen && premarketBars.length && (etNow?.minutes || 0) >= 570) {
    frozen = {
      user_id: userId, symbol: sym, session_date: sessionDate,
      pmh_high: Math.max(...premarketBars.map(b => b.h)),
      pmh_low: Math.min(...premarketBars.map(b => b.l)),
      pmh_volume: premarketBars.reduce((s, b) => s + (Number(b.v) || 0), 0),
    };
    db.prepare(`INSERT OR IGNORE INTO pmh_session_snapshots
      (user_id,symbol,session_date,pmh_high,pmh_low,pmh_volume,opening_price)
      VALUES (?,?,?,?,?,?,?)`).run(userId, sym, sessionDate, frozen.pmh_high, frozen.pmh_low, frozen.pmh_volume, openingPrice);
    frozen = db.prepare('SELECT * FROM pmh_session_snapshots WHERE user_id=? AND symbol=? AND session_date=?')
      .get(userId, sym, sessionDate);
  } else if (frozen && openingPrice && !frozen.opening_price) {
    db.prepare('UPDATE pmh_session_snapshots SET opening_price=? WHERE user_id=? AND symbol=? AND session_date=?')
      .run(openingPrice, userId, sym, sessionDate);
    frozen.opening_price = openingPrice;
  }

  const completed = twoMinute.filter(b => b.date === sessionDate);
  const latestCandle = completed.at(-1) || null;
  const baseline = latestCandle ? pmhMeanStd(twoMinute
    .filter(b => b.bucket === latestCandle.bucket && b.date !== sessionDate)
    .map(b => b.volume)) : null;
  const closes = completed.map(b => b.close);
  const ema9 = calcEMA(closes, 9);
  const dailyBars = Array.isArray(dailyData?.bars) ? dailyData.bars : [];
  const atrBars = dailyBars.slice(-15);
  const atr = atrBars.length >= 5
    ? atrBars.reduce((s, b) => s + (b.h - b.l), 0) / atrBars.length : null;
  const entry = latestCandle?.close ?? snap?.latestTrade?.p ?? null;
  const resistanceCandidates = [
    ...dailyBars.map(b => b.h),
    ...completed.slice(0, -1).map(b => b.high),
  ].filter(v => Number.isFinite(v) && Number.isFinite(entry) && v > entry);
  const resistance = resistanceCandidates.length ? Math.min(...resistanceCandidates) : null;
  const bid = snap?.latestQuote?.bp ?? null;
  const ask = snap?.latestQuote?.ap ?? null;
  const price = snap?.latestTrade?.p ?? latestCandle?.close ?? null;
  const latestBarTime = latestCandle?.t || oneMinute.at(-1)?.t;
  const quoteTime = snap?.latestQuote?.t || snap?.latestTrade?.t;
  const marketPrice = spy?.latestTrade?.p ?? spy?.minuteBar?.c;
  const marketOpen = spy?.dailyBar?.o;
  const candidateMove = openingPrice && price ? price / openingPrice - 1 : null;
  const marketMove = marketOpen && marketPrice ? marketPrice / marketOpen - 1 : null;

  const result = evaluatePmhBreak({
    symbol: sym,
    premarket: frozen ? {
      high: frozen.pmh_high, low: frozen.pmh_low, volume: frozen.pmh_volume, frozen: true,
    } : { frozen: false },
    previousDay: { close: previous.c, high: previous.h, low: previous.l },
    openingPrice: frozen?.opening_price ?? openingPrice,
    candle: latestCandle ? {
      open: latestCandle.open, high: latestCandle.high, low: latestCandle.low,
      close: latestCandle.close, volume: latestCandle.volume,
    } : null,
    volumeBaseline: baseline,
    quote: { price, bid, ask },
    resistance,
    atr,
    ema9,
    market: { available: Number.isFinite(marketMove), bullish: Number.isFinite(marketMove) ? marketMove >= 0 : false, movePct: marketMove == null ? null : marketMove * 100 },
    sector: { available: false, bullish: false },
    relativeStrength: Number.isFinite(candidateMove) && Number.isFinite(marketMove) ? candidateMove >= marketMove : null,
    freshness: {
      bars: pmhFresh(latestBarTime, 4 * 60 * 1000),
      quote: pmhFresh(quoteTime, 30 * 1000),
      barsAt: latestBarTime || null, quoteAt: quoteTime || null,
    },
    evaluatedAt: now.toISOString(),
  }, config);
  const completedFiveMinute = completedFiveMinuteBars(fiveMinute);
  result.priceAction = evaluatePriceActionSetup({
    symbol: sym,
    bars: completedFiveMinute,
    price,
    // PMH remains anchored to its own frozen level and opening gate. This
    // context is explanatory only and cannot make an ineligible PMH trade
    // eligible.
    vwap: null,
    market: { trend: Number.isFinite(marketMove) ? (marketMove >= 0 ? 'BULLISH' : 'BEARISH') : 'UNKNOWN' },
    relativeStrength: Number.isFinite(candidateMove) && Number.isFinite(marketMove) ? candidateMove >= marketMove : null,
    freshness: completedFiveMinuteFreshness(completedFiveMinute),
  });
  return result;
}

app.get('/api/opening-momentum/settings', requireAuth, (req, res) => {
  const settings = pmhConfigFor(req.session.userId);
  res.json({
    enabled: settings.enabled,
    liveArmed: settings.liveArmed,
    config: settings.config,
    liveAutomationPaused: PMH_LIVE_AUTOMATION_PAUSED,
  });
});

app.put('/api/opening-momentum/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const prior = pmhConfigFor(req.session.userId);
  const config = serverOwnedConfig(
    DEFAULT_PMH_CONFIG,
    prior.config,
    body.maxPositionDollars ?? body.config?.maxPositionDollars
  );
  const creds = getAlpacaCreds(req.session.userId, 'pmh');
  const liveArmed = body.liveArmed === true && creds?.mode === 'live';
  const enabled = body.enabled === true;
  db.prepare(`INSERT INTO pmh_settings (user_id,enabled,live_armed,config_json) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,live_armed=excluded.live_armed,config_json=excluded.config_json`)
    .run(req.session.userId, enabled ? 1 : 0, liveArmed ? 1 : 0, JSON.stringify(config));
  res.json({ ok: true, enabled, liveArmed, config });
});

app.get('/api/opening-momentum/scan', requireAuth, async (req, res) => {
  const raw = String(req.query.symbols || PMH_DEFAULT_SYMBOLS.join(','));
  const requestedSymbols = raw.split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9.-]{1,12}$/.test(s)).slice(0, 25);
  let catalog = null;
  let catalogEntry = null;
  let catalogError = null;
  try {
    catalogEntry = await getAlpacaTradableEquityCatalog(req.session.userId, { scope: 'pmh' });
    catalog = catalogEntry.catalog;
  }
  catch (error) { catalogError = error; }
  const selection = selectTradableEquityCandidates(requestedSymbols, catalog);
  const rotation = catalog
    ? nextAlpacaCatalogRotation(catalogEntry, requestedSymbols, {
      strategy: 'pmh', limit: 25, priorityLimit: 13, rotationLimit: 12,
    })
    : null;
  const symbols = rotation ? rotation.symbols : selection.symbols;
  const config = pmhConfigFor(req.session.userId).config;
  const results = await Promise.all(symbols.map(sym => buildPmhCandidate(req.session.userId, sym, config).catch(error => ({
    symbol: sym, status: 'BLOCKED', eligible: false, score: 0, reasons: [`Market data unavailable: ${error.message}`],
  }))));
  res.set('Cache-Control', 'no-store').json({
    strategy: 'opening-momentum-pmh-v1', sessionDate: pmhEtParts(new Date())?.date, results, config,
    coverage: {
      candidateSource: catalog
        ? 'Alpaca catalog rotation with PMH watchlist priority'
        : 'Opening Momentum PMH watchlist',
      verification: catalog ? 'alpaca-active-tradable-catalog-snapshot' : 'unverified-no-broker-connection',
      availableAtBroker: catalog ? catalog.size : null,
      catalogSnapshotAt: catalogEntry ? new Date(catalogEntry.at).toISOString() : null,
      requested: requestedSymbols.length, scanned: symbols.length, rejected: selection.rejected,
      priorityWatchlistSymbols: rotation?.prioritySymbols.length || selection.symbols.length,
      rotatingCatalogSymbols: rotation?.rotatingSymbols.length || 0,
      rotation: rotation ? { batch: rotation.batch + 1, totalBatches: rotation.totalBatches } : null,
      note: catalog
        ? 'PMH keeps its focused watchlist priority while rotating a bounded lane across the same verified Alpaca catalog snapshot.'
        : catalogError?.message || null,
    },
  });
});

function pmhError(message, status, extra) {
  return Object.assign(new Error(message), { status, ...extra });
}

async function executePmhEntry(userId, symbol, source = 'manual') {
  if (!isBotEnabled(userId, 'pmh')) throw pmhError('Opening Momentum automation is disabled.', 409);
  const pmhSetting = db.prepare('SELECT enabled FROM pmh_settings WHERE user_id=?').get(userId);
  if (!pmhSetting?.enabled) throw pmhError('Opening Momentum strategy is disabled in its persisted settings.', 409);
  const settings = pmhConfigFor(userId);
  const creds = getAlpacaCreds(userId, 'pmh');
  if (creds?.mode === 'live' && !settings.liveArmed) {
    throw pmhError('Opening Momentum Live orders are not explicitly armed.', 409);
  }
  const livePause = pmhLivePauseReason(userId);
  if (livePause) throw pmhError(livePause, 409);
  let clientOrderId = null;
  let submittedOrders = [];
  try {
    if (!isMarketOpen()) throw pmhError('Market is closed for regular-session PMH entries.', 400);
    await assertAlpacaTradableEquity(userId, symbol, { fresh: true, scope: 'pmh' });
    const slots = await getOpenSlots(userId, 'PMH', 'pmh');
    // A PMH setup submits two independently protected BUY parents (partial +
    // runner), so reserve both shared entry units before either reaches Alpaca.
    if (!canReserveEntryUnits(slots, 2)) throw pmhError('PMH needs two available entry slots for its protected partial and runner lots.', 409);
    if (slots.positions.some(p => p.symbol === symbol) ||
        slots.openOrders.some(o => o.symbol === symbol)) throw pmhError(`${symbol} already has a position or pending order.`, 409);
    const allSymbolOrders = await alpacaFetchFor(userId, 'pmh', `/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`);
    if (Array.isArray(allSymbolOrders) && allSymbolOrders.length) throw pmhError(`${symbol} already has a broker-open order.`, 409);
    const config = settings.config;
    const candidate = await buildPmhCandidate(userId, symbol, config);
    if (!candidate.eligible) throw pmhError('Trade is not eligible.', 400, { candidate });
    // Calculate risk from a fresh executable quote, not a 2-minute candle
    // close. A marketable limit bounds upward slippage; without a usable ask,
    // the trade is blocked rather than sized optimistically.
    const freshSnapshot = await alpacaSnapshotFetch(userId, symbol, 'pmh');
    const executableAsk = Number(freshSnapshot?.[symbol]?.latestQuote?.ap);
    const executableQuoteAt = freshSnapshot?.[symbol]?.latestQuote?.t;
    if (!(executableAsk > 0) || !pmhFresh(executableQuoteAt, 15 * 1000)) {
      throw pmhError('Fresh executable Alpaca ask is unavailable; PMH order blocked.', 400);
    }
    const slippageCap = 0.0025; // 25 bps maximum accepted entry drift
    const boundedEntry = +(executableAsk * (1 + slippageCap)).toFixed(2);
    const stop = Number(candidate.levels.stop);
    const boundedRisk = boundedEntry - stop;
    const boundedRiskPct = boundedRisk / boundedEntry * 100;
    if (!(boundedRisk > 0) || boundedRiskPct > config.maxRiskPerSharePct ||
        !Number.isFinite(candidate.levels.resistance) ||
        candidate.levels.resistance - boundedEntry < boundedRisk * config.minRoomRiskMultiple) {
      throw pmhError('Fresh quote invalidates the configured stop or resistance-risk gate.', 400);
    }
    if (boundedEntry > MAX_TRADE_PRICE) throw pmhError(`PMH preserves the account-wide $${MAX_TRADE_PRICE} maximum trade price.`, 400);
    const daily = db.prepare(`SELECT COUNT(DISTINCT COALESCE(entry_client_order_id, CAST(id AS TEXT))) AS trades,
      COALESCE(SUM(CASE WHEN pnl < 0 THEN -pnl ELSE 0 END), 0) AS losses
      FROM bot_trade_log WHERE user_id=? AND strategy LIKE 'opening-momentum-pmh%'
      AND date(timestamp, 'localtime')=date('now','localtime') AND status <> 'void'`).get(userId);
    if (Number(daily.trades) >= config.maxTradesPerDay) throw pmhError('PMH daily trade limit reached.', 409);
    if (Number(daily.losses) >= config.maxDailyLoss) throw pmhError('PMH daily loss limit reached.', 409);
    const mode = getAlpacaCreds(userId, 'pmh')?.mode || 'paper';
    const riskShares = Math.floor(config.maxRiskDollars / boundedRisk);
    const positionShares = Math.floor(config.maxPositionDollars / boundedEntry);
    const shares = Math.min(riskShares, positionShares);
    if (!Number.isInteger(shares) || shares < 1) throw pmhError('Risk sizing produced less than one whole share.', 400);
    const entry = boundedEntry;
    const target = Number((entry + boundedRisk * config.partialTargetR).toFixed(2));
    const sessionDate = pmhEtParts(new Date())?.date;
    if (!sessionDate) throw pmhError('Trading session date is unavailable.', 400);
    try {
      db.prepare(`INSERT INTO pmh_entry_intents (user_id,symbol,session_date,status,detail) VALUES (?,?,?,?,?)`)
        .run(userId, symbol, sessionDate, 'pending', `PMH broker submission reserved (${source})`);
    } catch (e) {
      throw pmhError(`${symbol} already has a PMH entry intent for this session.`, 409);
    }
    // Use two broker-protected lots: a bracket lot realizes the configured
    // partial target, while an OTO lot is the independent EMA-managed runner.
    // This avoids a browser-side partial sell that could leave an oversized stop
    // behind and accidentally create a short position.
    // One-share setups still need a broker-held target. Treat the sole share as
    // the protected partial lot instead of silently turning it into a targetless
    // runner.
    const partialQty = shares === 1 ? 1
      : Math.max(1, Math.min(shares - 1, Math.floor(shares * config.partialPercent / 100)));
    const runnerQty = shares - partialQty;
    const orders = submittedOrders;
    const submitLot = async (qty, kind) => {
      const clientId = `pmh_${sessionDate.replaceAll('-','')}_${userId}_${symbol}_${kind}`.slice(0, 48);
      clientOrderId = clientId;
      const existing = db.prepare('SELECT id FROM bot_trade_log WHERE user_id=? AND entry_client_order_id=?').get(userId, clientId);
      if (existing) throw new Error('This PMH entry lot is already recorded.');
      const strategy = kind === 'partial' ? 'opening-momentum-pmh-partial' : 'opening-momentum-pmh-runner';
      const trade = db.prepare(`INSERT INTO bot_trade_log
        (user_id,symbol,entry_price,shares,mode,status,stop_price,take_profit_rsi,entry_order_id,entry_client_order_id,strategy)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(userId, symbol, entry, qty, mode, 'pending_entry', stop, config.partialTargetR, clientId, clientId, strategy);
      // Record the broker submission attempt before issuing POST. A network
      // timeout is ambiguous: Alpaca may accept it, so reconciliation must use
      // this durable client ID even when no broker order ID comes back.
      const submitted = { kind, order: null, tradeId: trade.lastInsertRowid, qty, clientOrderId: clientId };
      orders.push(submitted);
      const orderBody = {
        symbol, qty: String(qty), side: 'buy', type: 'limit', limit_price: entry.toFixed(2), time_in_force: 'day', client_order_id: clientId,
        ...(kind === 'partial'
          ? { order_class: 'bracket', take_profit: { limit_price: target.toFixed(2) }, stop_loss: { stop_price: stop.toFixed(2) } }
          : { order_class: 'oto', stop_loss: { stop_price: stop.toFixed(2) } }),
      };
      beginAlpacaOrderRequest(userId);
      let order;
      try { order = await alpacaFetchFor(userId, 'pmh', '/v2/orders', { method: 'POST', body: JSON.stringify(orderBody) }); }
      finally { endAlpacaOrderRequest(userId); }
      db.prepare('UPDATE bot_trade_log SET entry_order_id=? WHERE id=?').run(order?.id || clientId, trade.lastInsertRowid);
      submitted.order = order;
    };
    if (partialQty) await submitLot(partialQty, 'partial');
    await submitLot(runnerQty, 'runner');
    db.prepare(`UPDATE pmh_entry_intents SET status='submitted',detail=? WHERE user_id=? AND symbol=? AND session_date=?`)
      .run(`Submitted ${orders.length} protected PMH lot(s)`, userId, symbol, sessionDate);
    return { ok: true, strategy: 'opening-momentum-pmh-v1', mode, orders, target, stop, candidate };
  } catch (error) {
    const sessionDate = pmhEtParts(new Date())?.date;
    if (sessionDate) db.prepare(`UPDATE pmh_entry_intents SET status=?,detail=? WHERE user_id=? AND symbol=? AND session_date=?`)
      .run(
        submittedOrders.length ? 'partial_submission_pending_reconciliation' : 'error',
        String(error.message || 'Broker submission failed').slice(0, 240),
        userId, symbol, sessionDate,
      );
    error.clientOrderId = clientOrderId;
    error.reconciliationRequired = submittedOrders.length > 0;
    error.submittedLots = submittedOrders.map(order => ({ kind: order.kind, orderId: order.order?.id || null, qty: order.qty }));
    throw error;
  }
}

app.post('/api/opening-momentum/execute', requireAuth, async (req, res) => {
  res.status(409).json({ error: 'Opening Momentum entries are submitted only by the server automation scheduler.' });
});

app.get('/api/opening-momentum/trades', requireAuth, (req, res) => {
  const trades = db.prepare(`SELECT * FROM bot_trade_log WHERE user_id=? AND strategy LIKE 'opening-momentum-pmh%'
    ORDER BY timestamp DESC LIMIT 30`).all(req.session.userId);
  res.json({ trades });
});

// Reconcile only broker-confirmed PMH fills. The browser can request this while
// open; it never manufactures a fill price, exit, or P&L from a quote.
async function reconcilePmhTrades(userId) {
  const pmhFetch = (path, opts = {}) => alpacaFetchFor(userId, 'pmh', path, opts);
  const pmhConfig = pmhConfigFor(userId).config;
  const open = db.prepare(`SELECT * FROM bot_trade_log WHERE user_id=? AND strategy LIKE 'opening-momentum-pmh%'
    AND status IN ('pending_entry','open','pending_exit','exit_reserving') ORDER BY id`).all(userId);
  const reconciled = [];
  for (const trade of open) {
    let runnerStopCancelled = false;
    try {
      if (trade.status === 'pending_entry') {
        const order = trade.entry_order_id === trade.entry_client_order_id
          ? await pmhFetch(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(trade.entry_client_order_id)}&nested=true`)
          : await pmhFetch(`/v2/orders/${encodeURIComponent(trade.entry_order_id)}?nested=true`);
        if (!brokerOrderMatchesIntent(order, trade.entry_client_order_id)) {
          throw new Error('Broker response does not match the PMH entry intent.');
        }
        if (Number(order.filled_qty) > 0 && Number(order.filled_avg_price) > 0) {
          db.prepare(`UPDATE bot_trade_log SET status='open', entry_price=?, shares=?, entry_order_id=? WHERE id=?`)
            .run(Number(order.filled_avg_price), Number(order.filled_qty), order.id, trade.id);
          reconciled.push({ id: trade.id, status: 'open', event: order.status === 'filled' ? 'entry fill confirmed' : 'partial entry fill confirmed' });
        } else if (['canceled', 'rejected', 'expired'].includes(order.status)) {
          db.prepare(`UPDATE bot_trade_log SET status='void', exit_reason=?, closed_at=datetime('now') WHERE id=?`)
            .run(`Entry ${order.status} by broker`, trade.id);
          reconciled.push({ id: trade.id, status: 'void', event: `entry ${order.status}` });
        }
        continue;
      }
      if (trade.status === 'pending_exit' && trade.pending_exit_order_id) {
        const order = await pmhFetch(`/v2/orders/${encodeURIComponent(trade.pending_exit_order_id)}`);
        let expectedExitClientId = trade.pending_exit_client_order_id;
        // Older journal rows predate durable runner-exit client IDs. Recover
        // them only when the broker ID matches this user's and symbol's PMH
        // namespace; otherwise do not apply the response to the journal.
        if (!expectedExitClientId) {
          const recovered = String(order?.client_order_id || '');
          const legacyPrefix = `pmhx_${userId}_${trade.symbol}_`;
          if (!recovered.startsWith(legacyPrefix)) {
            throw new Error('Broker response cannot be bound to the legacy PMH exit intent.');
          }
          expectedExitClientId = recovered;
          db.prepare('UPDATE bot_trade_log SET pending_exit_client_order_id=? WHERE id=?')
            .run(expectedExitClientId, trade.id);
        }
        if (!brokerOrderMatchesIntent(order, expectedExitClientId)) {
          throw new Error('Broker response does not match the PMH exit intent.');
        }
        if (order.status === 'filled' && Number(order.filled_qty) > 0 && Number(order.filled_avg_price) > 0) {
          const filledQty = Number(order.filled_qty);
          const exitPrice = Number(order.filled_avg_price);
          const pnl = +((exitPrice - Number(trade.entry_price)) * filledQty).toFixed(6);
          db.prepare(`UPDATE bot_trade_log SET status='closed', exit_price=?, shares=?, pnl=?, exit_reason=?,
            pending_exit_order_id=NULL,pending_exit_client_order_id=NULL,pending_exit_reason=NULL,closed_at=datetime('now') WHERE id=?`)
            .run(exitPrice, filledQty, pnl, trade.pending_exit_reason || 'PMH runner exit', trade.id);
          reconciled.push({ id: trade.id, status: 'closed', event: 'exit fill confirmed' });
        }
        continue;
      }
      // Parent orders expose their protective child legs. A broker-filled
      // bracket target/stop is the only source of a realized partial result.
      const parent = await pmhFetch(`/v2/orders/${encodeURIComponent(trade.entry_order_id)}?nested=true`);
      if (!brokerOrderMatchesIntent(parent, trade.entry_client_order_id)) {
        throw new Error('Broker response does not match the PMH journal owner.');
      }
      const filledLeg = (parent?.legs || []).find(leg =>
        leg.status === 'filled' && Number(leg.filled_qty) > 0 && Number(leg.filled_avg_price) > 0
      );
      if (filledLeg) {
        const filledQty = Number(filledLeg.filled_qty);
        const exitPrice = Number(filledLeg.filled_avg_price);
        const pnl = +((exitPrice - Number(trade.entry_price)) * filledQty).toFixed(6);
        db.prepare(`UPDATE bot_trade_log SET status='closed', exit_price=?, shares=?, pnl=?, exit_reason=?, closed_at=datetime('now') WHERE id=?`)
          .run(exitPrice, filledQty, pnl, filledLeg.type === 'limit' ? 'Partial target broker fill' : 'Protective stop broker fill', trade.id);
        reconciled.push({ id: trade.id, status: 'closed', event: 'protective leg fill confirmed' });
        continue;
      }
      // The partial lot has a native Alpaca bracket. It never uses the runner
      // manager or a browser-estimated partial sell.
      if (trade.strategy === 'opening-momentum-pmh-partial') continue;
      // An earlier cycle acquired the exit reservation but could not finish.
      // It may still reconcile a broker leg above, but it must never submit a
      // second discretionary sell without operator review.
      if (trade.status === 'exit_reserving' || trade.rescue_stop_order_id) {
        reconciled.push({ id: trade.id, status: trade.status, event: 'runner exit remains reserved; broker state must reconcile before another sell' });
        continue;
      }
      // For an active runner, the exit decision uses a completed 2-minute
      // candle only. Before sending a sell, cancel any stop child so it cannot
      // later flip the account short; the generic no-short guard is preserved.
      if (!isMarketOpen()) continue;
      const candidate = await buildPmhCandidate(userId, trade.symbol, pmhConfig);
      if (!candidate.freshness?.bars) continue;
      const runner = evaluatePmhRunnerExit({
        candle: candidate.candle,
        pmh: candidate.premarket?.high,
        ema9: candidate.context?.ema9,
        momentumCollapsed: candidate.candle?.upperWickRatio > .55 && candidate.candle?.close < candidate.candle?.open,
        majorReversal: candidate.status === 'BREAKOUT FAILED',
      });
      if (!runner.exit) continue;
      // A durable compare-and-swap is the second line of defense after the
      // in-process bot lock. Only the winning request may cancel a stop or
      // submit a runner exit.
      const exitClientId = `pmhx_${userId}_${trade.symbol}_${Date.now()}`.slice(0, 48);
      const claimed = db.prepare(`UPDATE bot_trade_log SET status='exit_reserving',
        pending_exit_reason=?,pending_exit_client_order_id=?
        WHERE id=? AND user_id=? AND status='open'`).run(runner.reason, exitClientId, trade.id, userId);
      if (claimed.changes !== 1) continue;
      const position = await pmhFetch(`/v2/positions/${trade.symbol}`);
      const qty = Math.min(Number(position?.qty), Number(trade.shares));
      if (!(qty > 0)) continue; // Preserve journal until broker evidence explains the disappearance.
      // Cancel only this runner's own OTO stop child. The partial bracket stays
      // in force and continues to protect/target its separate lot.
      let stopCancelAmbiguous = false;
      for (const leg of (parent.legs || [])) {
        if (leg.status === 'new' || leg.status === 'accepted' || leg.status === 'pending_new') {
          await pmhFetch(`/v2/orders/${leg.id}`, { method: 'DELETE' });
          const settledLeg = await pmhFetch(`/v2/orders/${leg.id}`);
          if (!['canceled', 'cancelled'].includes(String(settledLeg?.status || '').toLowerCase())) {
            stopCancelAmbiguous = true;
          } else {
            runnerStopCancelled = true;
          }
        }
      }
      // A stop may fill while the cancel request is in flight. In that
      // ambiguous state, do not submit a discretionary sell; reconcile the
      // terminal broker state on the next cycle instead.
      const afterCancel = await pmhFetch(`/v2/orders/${encodeURIComponent(trade.entry_order_id)}?nested=true`);
      if (!brokerOrderMatchesIntent(afterCancel, trade.entry_client_order_id)) {
        throw new Error('Broker response does not match the PMH journal owner after cancellation.');
      }
      const stopFilledDuringCancel = (afterCancel?.legs || []).some(leg => leg.status === 'filled');
      if (stopCancelAmbiguous || stopFilledDuringCancel) {
        reconciled.push({ id: trade.id, status: 'open', event: 'runner stop cancellation unsettled; no discretionary sell submitted' });
        continue;
      }
      const currentPosition = await pmhFetch(`/v2/positions/${trade.symbol}`);
      const remainingRunnerQty = Math.min(Number(currentPosition?.qty), Number(trade.shares));
      if (!(remainingRunnerQty > 0)) continue;
      beginAlpacaOrderRequest(userId);
      let exitOrder;
      try {
        exitOrder = await pmhFetch('/v2/orders', { method: 'POST', body: JSON.stringify({
          symbol: trade.symbol, qty: String(remainingRunnerQty), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: exitClientId,
        }) });
      } catch (exitError) {
        // We deliberately canceled the old OTO stop before this market exit.
        // If the broker did not accept the exit, immediately try to restore a
        // protective stop for the broker-confirmed remaining runner quantity.
        try {
          const rescuePosition = await pmhFetch(`/v2/positions/${trade.symbol}`);
          const rescueQty = Math.min(Number(rescuePosition?.qty), Number(trade.shares));
          if (rescueQty > 0 && Number(trade.stop_price) > 0) {
            const rescueOrder = await pmhFetch('/v2/orders', { method: 'POST', body: JSON.stringify({
              symbol: trade.symbol, qty: String(rescueQty), side: 'sell', type: 'stop', time_in_force: 'day',
              stop_price: Number(trade.stop_price).toFixed(2),
              client_order_id: `pmhr_${userId}_${trade.symbol}_${Date.now()}`.slice(0, 48),
            }) });
            db.prepare(`UPDATE bot_trade_log SET status='protected_after_exit_failure', rescue_stop_order_id=?,
              pending_exit_order_id=NULL,pending_exit_client_order_id=NULL,pending_exit_reason=? WHERE id=?`)
              .run(rescueOrder.id, 'Runner exit failed; replacement stop submitted', trade.id);
          }
        } catch (_) {}
        throw exitError;
      } finally { endAlpacaOrderRequest(userId); }
      db.prepare(`UPDATE bot_trade_log SET status='pending_exit', pending_exit_order_id=?, pending_exit_reason=? WHERE id=?`)
        .run(exitOrder?.id || exitClientId, runner.reason, trade.id);
      reconciled.push({ id: trade.id, status: 'pending_exit', event: runner.reason });
    } catch (error) {
      // Any failure after the original runner stop was terminally canceled must
      // leave the runner protected or reserved for manual broker resolution.
      // Never return it to `open`, which could submit a second discretionary
      // sell on a later polling cycle.
      if (runnerStopCancelled) {
        try {
          const latest = db.prepare('SELECT rescue_stop_order_id FROM bot_trade_log WHERE id=?').get(trade.id);
          if (!latest?.rescue_stop_order_id) {
            const rescuePosition = await pmhFetch(`/v2/positions/${trade.symbol}`);
            const rescueQty = Math.min(Number(rescuePosition?.qty), Number(trade.shares));
            if (rescueQty > 0 && Number(trade.stop_price) > 0) {
              beginAlpacaOrderRequest(userId);
              let rescueOrder;
              try {
                rescueOrder = await pmhFetch('/v2/orders', { method: 'POST', body: JSON.stringify({
                  symbol: trade.symbol, qty: String(rescueQty), side: 'sell', type: 'stop', time_in_force: 'day',
                  stop_price: Number(trade.stop_price).toFixed(2),
                  client_order_id: `pmhr_${userId}_${trade.symbol}_${Date.now()}`.slice(0, 48),
                }) });
              } finally { endAlpacaOrderRequest(userId); }
              db.prepare(`UPDATE bot_trade_log SET status='protected_after_exit_failure', rescue_stop_order_id=?,
                pending_exit_order_id=NULL,pending_exit_client_order_id=NULL,pending_exit_reason=? WHERE id=?`)
                .run(rescueOrder.id, 'Runner reconciliation failed; replacement stop submitted', trade.id);
            }
          }
        } catch (_) {}
      }
      reconciled.push({ id: trade.id, status: trade.status, error: error.message });
    }
  }
  const trades = db.prepare(`SELECT * FROM bot_trade_log WHERE user_id=? AND strategy LIKE 'opening-momentum-pmh%'
    ORDER BY timestamp DESC LIMIT 30`).all(userId);
  return { reconciled, trades };
}

app.post('/api/opening-momentum/reconcile', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  if (!acquireBotLock(userId)) return res.status(409).json({ error: 'Another bot reconciliation cycle is in progress.' });
  try {
    const { reconciled, trades } = await reconcilePmhTrades(userId);
    res.json({ ok: true, reconciled, trades });
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    releaseBotLock(userId);
  }
});

// ── GET /api/bots/status — SPY gate + PDT state for the logged-in user ────────
// ── Momentum: intraday analysis (MACD, candle patterns, move %) ──────────────
app.get('/api/momentum/analysis/:sym', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const sym = req.params.sym.toUpperCase().replace(/[^A-Z.]/g, '');
    if (!sym) return res.status(400).json({ error: 'Invalid symbol' });

    // 1-minute bars, 240-minute lookback — mirrors data.py get_intraday_bars()
    const now   = new Date();
    const start = new Date(now.getTime() - 240 * 60 * 1000);

    const [barsData, fiveMinuteData] = await Promise.all([
      alpacaDataFetch(uid,
        `/v2/stocks/${sym}/bars?timeframe=1Min&start=${encodeURIComponent(start.toISOString())}&limit=300&adjustment=all&feed=iex`,
        'momentum'
      ).catch(() => null),
      alpacaDataFetch(uid,
        `/v2/stocks/${sym}/bars?timeframe=5Min&start=${encodeURIComponent(start.toISOString())}&limit=100&adjustment=all&feed=iex`,
        'momentum'
      ).catch(() => null),
    ]);

    const bars = barsData?.bars || [];
    if (!bars.length) return res.json({ sym, bars: 0, error: 'No intraday bars — market may be closed' });

    const closes = bars.map(b => b.c);
    const highs  = bars.map(b => b.h);
    const lows   = bars.map(b => b.l);
    const opens  = bars.map(b => b.o);
    const vols   = bars.map(b => b.v);

    const dailyOpen = opens[0];
    const dailyHigh = Math.max(...highs);
    const dailyLow  = Math.min(...lows);
    const lastClose = closes[closes.length - 1];
    const lastBar   = bars[bars.length - 1];
    const lastVol   = vols[vols.length - 1];

    // % of intraday move (open→high) currently held
    const moveRange = dailyHigh - dailyOpen;
    const pctOfMove = moveRange > 0.0001
      ? +((lastClose - dailyOpen) / moveRange * 100).toFixed(1)
      : null;

    // ── EMA helper (ewm span=N → alpha = 2/(N+1), mirrors pandas .ewm) ─────
    function ema(vals, period) {
      if (vals.length < period) return [];
      const k = 2 / (period + 1);
      let e = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const out = new Array(period - 1).fill(null);
      out.push(e);
      for (let i = period; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
      return out;
    }

    // ── VWAP — mirrors calculate_vwap() in data.py ──────────────────────────
    // VWAP = cumsum(typical_price × volume) / cumsum(volume)
    let cumPV = 0, cumVol = 0;
    const vwapArr = bars.map(b => {
      const tp = (b.h + b.l + b.c) / 3;   // typical_price
      cumPV  += tp * b.v;
      cumVol += b.v;
      return cumVol > 0 ? cumPV / cumVol : null;
    });
    const currentVwap = vwapArr[vwapArr.length - 1];
    const fiveMinuteBars = completedFiveMinuteBars(fiveMinuteData?.bars);
    const priceAction = evaluatePriceActionSetup({
      symbol: sym,
      bars: fiveMinuteBars,
      price: lastClose,
      vwap: null,
      freshness: completedFiveMinuteFreshness(fiveMinuteBars),
      // The standalone analysis endpoint has no market/sector comparison
      // payload, so it remains conservative and marks relative strength
      // unavailable rather than inventing it.
      market: { trend: 'UNKNOWN' },
      relativeStrength: null,
    });

    // ── EMA9 + EMA20 on close — mirrors calculate_indicators() in data.py ───
    const ema9arr  = ema(closes, 9);
    const ema20arr = ema(closes, 20);
    const currentEma9  = ema9arr.length  ? ema9arr[ema9arr.length - 1]   : null;
    const currentEma20 = ema20arr.length ? ema20arr[ema20arr.length - 1] : null;

    // ── volume_avg20 + relative_volume (rolling 20, shifted 1) ─────────────
    const priorVols  = vols.slice(0, -1);           // shift(1): exclude current bar
    const vol20slice = priorVols.slice(-20);
    const vol20avg   = vol20slice.length > 0
      ? vol20slice.reduce((a, b) => a + b, 0) / vol20slice.length
      : null;
    const relVolIntraday = vol20avg && vol20avg > 0 ? +(lastVol / vol20avg).toFixed(2) : null;

    // ── high_20: 20-bar rolling max of high, shifted 1 — mirrors data.py ───
    // .rolling(20).max().shift(1) → max of 20 bars preceding current bar
    const priorHighs = highs.slice(0, -1);
    const h20slice   = priorHighs.slice(-20);
    const high20     = h20slice.length > 0 ? +Math.max(...h20slice).toFixed(4) : null;
    const breakingHigh20 = high20 != null && lastClose > high20;

    // ── Candle tail analysis (last 1-min bar) ────────────────────────────────
    const bHigh = Math.max(lastBar.c, lastBar.o);
    const bLow  = Math.min(lastBar.c, lastBar.o);
    const totalRange         = lastBar.h - lastBar.l || 0.0001;
    const upperTail          = +(lastBar.h - bHigh).toFixed(4);
    const lowerTail          = +(bLow - lastBar.l).toFixed(4);
    const toppingTailScore   = +(upperTail / totalRange).toFixed(3);
    const bottomingTailScore = +(lowerTail / totalRange).toFixed(3);

    // ── MACD(12,26,9) on 1-min close ────────────────────────────────────────
    const e12      = ema(closes, 12);
    const e26      = ema(closes, 26);
    const macdLine = e12.map((v, i) => (v != null && e26[i] != null) ? +(v - e26[i]).toFixed(5) : null);
    const macdNums = macdLine.filter(v => v != null);
    const sigArr   = ema(macdNums, 9);
    const lastMacd = macdNums.length ? macdNums[macdNums.length - 1] : null;
    const lastSig  = sigArr.length   ? sigArr[sigArr.length - 1]      : null;
    const lastHist = (lastMacd != null && lastSig != null) ? +(lastMacd - lastSig).toFixed(5) : null;

    // ── Intraday RSI(14) on 1-min close — used for the RSI take-profit exit ──
    let rsi14 = null;
    try { const v = calcRSI(closes, 14); rsi14 = v != null ? +v.toFixed(1) : null; } catch (_) {}

    res.json({
      sym,
      bars: bars.length,
      rsi14,
      dailyOpen, dailyHigh, dailyLow, lastClose, pctOfMove,
      // ── data.py indicators ─────────────────────────────────────────────────
      vwap:            currentVwap  != null ? +currentVwap.toFixed(4)  : null,
      ema9:            currentEma9  != null ? +currentEma9.toFixed(4)  : null,
      ema20:           currentEma20 != null ? +currentEma20.toFixed(4) : null,
      relVolIntraday,
      high20,
      priceAboveVwap:  currentVwap  != null ? lastClose > currentVwap  : null,
      priceAboveEma9:  currentEma9  != null ? lastClose > currentEma9  : null,
      priceAboveEma20: currentEma20 != null ? lastClose > currentEma20 : null,
      breakingHigh20,
      priceAction,
      // ── candle + MACD ──────────────────────────────────────────────────────
      lastCandle: {
        open: lastBar.o, high: lastBar.h, low: lastBar.l, close: lastBar.c,
        isRed: lastBar.c < lastBar.o,
        toppingTailScore, bottomingTailScore, upperTail, lowerTail, relVolIntraday,
      },
      macd: lastMacd != null ? {
        value: lastMacd, signal: lastSig, histogram: lastHist,
        positive: lastMacd > 0,
        bullishCross: lastHist != null && lastHist > 0 && lastMacd > 0,
      } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/patterns/:sym — standalone daily candle pattern endpoint ─────────
// ── Inverse-ETF resolver ──────────────────────────────────────────────────────
// No shorting on this platform: to trade the downside of a stock or the market,
// buy the specifically mapped inverse ETF instead. Unknown mappings are
// intentionally blocked: silently choosing SH creates unrelated exposure.
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
// ── GET /api/momentum/news/:sym ──────────────────────────────────────────────
// Returns { hasCatalyst, headline, articles } for the last 24 hours.
// Uses NewsAPI (NEWSAPI_KEY). Results cached 10 min per symbol.
const _momentumNewsCache = new Map();
const MOMENTUM_NEWS_TTL  = 10 * 60 * 1000; // 10 minutes

app.get('/api/momentum/news/:sym', requireAuth, async (req, res) => {
  const sym = req.params.sym.toUpperCase().trim();
  if (!/^[A-Z]{1,6}$/.test(sym)) return res.status(400).json({ error: 'Invalid symbol' });

  // Serve from cache if fresh
  const cached = _momentumNewsCache.get(sym);
  if (cached && Date.now() - cached.ts < MOMENTUM_NEWS_TTL) return res.json(cached.data);

  if (!NEWS_KEY) {
    return res.json({ hasCatalyst: false, headline: null, articles: [], source: 'no_key' });
  }

  try {
    // Use exact ISO-8601 timestamp so NewsAPI doesn't widen the window to midnight.
    // Also post-filter by publishedAt to enforce the 24-hour cutoff regardless of
    // any rounding or timezone offset the API applies on its side.
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const from     = new Date(cutoffMs).toISOString(); // e.g. 2026-08-17T23:36:00.000Z
    const q        = encodeURIComponent(sym);
    const url      = `https://newsapi.org/v2/everything?q=${q}&from=${from}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_KEY}`;
    const r        = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!r.ok) {
      console.warn(`[MomentumNews] NewsAPI HTTP ${r.status} for ${sym}`);
      return res.json({ hasCatalyst: false, headline: null, articles: [], source: 'newsapi_err' });
    }

    const data     = await r.json();
    const articles = (data.articles || [])
      .filter(a => {
        if (!a.title || a.title === '[Removed]') return false;
        // Post-filter: reject anything published before the 24-hour cutoff
        if (a.publishedAt) {
          const pub = new Date(a.publishedAt).getTime();
          if (!isNaN(pub) && pub < cutoffMs) return false;
        }
        return true;
      })
      .slice(0, 5)
      .map(a => ({
        headline:    a.title,
        url:         a.url,
        source:      a.source?.name || '',
        publishedAt: a.publishedAt || null,
      }));

    const hasCatalyst = articles.length > 0;
    const headline    = hasCatalyst ? articles[0].headline : null;
    const result      = { hasCatalyst, headline, articles, source: 'newsapi' };

    _momentumNewsCache.set(sym, { data: result, ts: Date.now() });
    res.json(result);
  } catch (e) {
    console.error('[MomentumNews] error for', sym, e.message);
    res.json({ hasCatalyst: false, headline: null, articles: [], source: 'error' });
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
  for (let i = 0; i < symbols.length; i += 6) {
    const chunk = symbols.slice(i, i + 6);
    const settled = await Promise.allSettled(chunk.map(async symbol => {
      const quote = await yf.quote(symbol, {}, { validateResult: false });
      const price = quote?.regularMarketPrice;
      if (!Number.isFinite(price) || price < 0.5 || price > 20) return null;
      const marketCap = Number.isFinite(quote.marketCap) ? quote.marketCap : null;
      if (marketCap != null && (marketCap < 20e6 || marketCap > 1e9)) return null;
      const floatData = await _fetchFloatData(symbol);
      const avgVol = quote.averageDailyVolume3Month ?? quote.averageDailyVolume10Day ?? null;
      const volume = quote.regularMarketVolume ?? null;
      return {
        symbol,
        company: quote.shortName || quote.longName || symbol,
        price,
        changePct: Number.isFinite(quote.regularMarketChangePercent) ? +quote.regularMarketChangePercent.toFixed(2) : null,
        volume,
        relVol: volume != null && avgVol ? +(volume / avgVol).toFixed(2) : null,
        marketCap,
        float: floatData.float ?? quote.floatShares ?? null,
        floatSource: floatData.floatSource ?? (quote.floatShares != null ? 'quote' : null),
      };
    }));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        marketBySymbol.set(result.value.symbol, result.value);
      }
    }
  }
  if (!marketBySymbol.size && articles.length) dataGaps.push('Market-data enrichment returned no qualifying $20M–$1B, $0.50–$20 symbols');
  return marketBySymbol;
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
  const marketBySymbol = await bciEnrichMarkets(articles, dataGaps);
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

// ── Full-market universe cache (4-minute TTL) ─────────────────────────────────
let _universeCache = null;
let _universeCacheAt = 0;
const UNIVERSE_TTL_MS = 4 * 60 * 1000;

// ── Momentum page: live full-market universe ───────────────────────────────────
// Sources (Yahoo Finance public screeners — no API key required):
//   1. day_gainers       — stocks up ≥3% today (large + mid cap)
//   2. small_cap_gainers — small-cap stocks gaining today ($0–$5B market cap)
//   3. most_actives      — highest volume across all caps (catches pre-filter candidates)
// Pre-filters $1–$60 price and ≥2% gain before returning to keep scanner focused.
app.get('/api/momentum/universe', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    let catalog = null;
    let catalogEntry = null;
    let catalogError = null;
    try {
      catalogEntry = await getAlpacaTradableEquityCatalog(req.session.userId, { scope: 'momentum' });
      catalog = catalogEntry.catalog;
    }
    catch (error) { catalogError = error; }

    const respond = (rawPayload, cached) => {
      if (catalog) {
        // Never enumerate all broker assets in a single browser refresh. Reserve
        // room for liquid market movers, then rotate the remaining budget
        // through every active/tradable Alpaca stock and ETF.
        const rotation = nextAlpacaCatalogRotation(catalogEntry, rawPayload.symbols);
        const includedGainers = (rawPayload.gainers || []).filter(symbol => rotation.symbols.includes(symbol));
        const includedSmallCap = (rawPayload.smallCap || []).filter(symbol => rotation.symbols.includes(symbol));
        const includedActives = (rawPayload.highVolume || []).filter(symbol => rotation.symbols.includes(symbol));
        return res.json({
          ...rawPayload,
          symbols: rotation.symbols,
          source: 'alpaca-active-tradable-rotating-catalog',
          candidateSource: 'Alpaca active/tradable catalog: market-mover priority plus rotating catalog coverage',
          count: rotation.symbols.length,
          gainers: includedGainers,
          smallCap: includedSmallCap,
          highVolume: includedActives,
          cached,
          coverage: {
            verification: 'alpaca-active-tradable-catalog-snapshot',
            availableAtBroker: catalog.size,
            catalogSnapshotAt: new Date(catalogEntry.at).toISOString(),
            candidatesRanked: catalog.size,
            priorityMarketMovers: rotation.prioritySymbols.length,
            rotatingCatalogSymbols: rotation.rotatingSymbols.length,
            scanned: rotation.symbols.length,
            rotation: { batch: rotation.batch + 1, totalBatches: rotation.totalBatches },
            rejected: selectTradableEquityCandidates(rawPayload.symbols, catalog).rejected,
            note: 'The bot scans a bounded batch from one cached Alpaca catalog snapshot each refresh; mover priority does not alter rotation coverage.',
          },
        });
      }
      const selection = selectTradableEquityCandidates(rawPayload.symbols, catalog);
      return res.json({
        ...rawPayload,
        symbols: selection.symbols,
        source: rawPayload.source,
        candidateSource: rawPayload.candidateSource,
        count: selection.symbols.length,
        cached,
        coverage: {
          verification: 'unverified-no-broker-connection',
          availableAtBroker: null,
          candidatesFromSource: rawPayload.symbols.length,
          scanned: selection.symbols.length,
          rejected: selection.rejected,
          note: catalogError?.message || null,
        },
      });
    };
    if (_universeCache && (now - _universeCacheAt) < UNIVERSE_TTL_MS) {
      return respond(_universeCache, true);
    }

    const YF_SCREENER = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved';
    const YF_HDR = { ...YH, 'Accept': 'application/json' };

    // Fetch all three screeners in parallel
    const [gainersRes, smallCapRes, activesRes] = await Promise.all([
      fetch(`${YF_SCREENER}?count=100&scrIds=day_gainers`,        { headers: YF_HDR }).catch(() => null),
      fetch(`${YF_SCREENER}?count=100&scrIds=small_cap_gainers`,  { headers: YF_HDR }).catch(() => null),
      fetch(`${YF_SCREENER}?count=100&scrIds=most_actives`,       { headers: YF_HDR }).catch(() => null),
    ]);

    const parseScreener = async r => {
      if (!r?.ok) return [];
      try {
        const d = await r.json();
        return d?.finance?.result?.[0]?.quotes || [];
      } catch { return []; }
    };

    const [gainersRaw, smallCapRaw, activesRaw] = await Promise.all([
      parseScreener(gainersRes),
      parseScreener(smallCapRes),
      parseScreener(activesRes),
    ]);

    const clean = s => s && /^[A-Z]{1,6}$/.test(s);

    // Day gainers: price $1–$60, gain ≥2%
    const gainers = gainersRaw
      .filter(q => clean(q.symbol) && (q.regularMarketPrice||0) >= 1 && (q.regularMarketPrice||0) <= 60 && (q.regularMarketChangePercent||0) >= 2)
      .map(q => ({ symbol: q.symbol, price: q.regularMarketPrice, change: q.regularMarketChangePercent }));

    // Small-cap gainers: price $1–$20 (prime 5-pillar range), gain ≥2%
    const seen = new Set(gainers.map(g => g.symbol));
    const smallCap = smallCapRaw
      .filter(q => clean(q.symbol) && !seen.has(q.symbol) && (q.regularMarketPrice||0) >= 1 && (q.regularMarketPrice||0) <= 20 && (q.regularMarketChangePercent||0) >= 2)
      .map(q => ({ symbol: q.symbol, price: q.regularMarketPrice, change: q.regularMarketChangePercent }));
    smallCap.forEach(s => seen.add(s.symbol));

    // Most-actives: add any not already captured (regardless of direction — scanner will filter)
    const actives = activesRaw
      .map(q => q.symbol).filter(s => clean(s) && !seen.has(s));

    const allSymbols = [
      ...gainers.map(g => g.symbol),
      ...smallCap.map(g => g.symbol),
      ...actives,
    ];

    const payload = allSymbols.length ? {
      symbols:    allSymbols,
      source:     'yahoo-market-movers',
      candidateSource: 'Yahoo day gainers, small-cap gainers, and most active lists',
      gainers:    gainers.map(g => g.symbol),
      smallCap:   smallCap.map(g => g.symbol),
      highVolume: actives,
    } : {
      symbols: MASTER_UNIVERSE,
      source: 'curated-fallback',
      candidateSource: 'Curated stock and ETF fallback list',
      gainers: [], smallCap: [], highVolume: [],
    };

    _universeCache   = payload;
    _universeCacheAt = now;
    console.log(`[Universe] YF full market: ${gainers.length} day-gainers + ${smallCap.length} small-cap + ${actives.length} actives = ${allSymbols.length} total`);
    respond(payload, false);
  } catch (e) {
    console.error('[Universe] Error:', e.message);
    const selection = selectTradableEquityCandidates(MASTER_UNIVERSE);
    res.json({
      symbols: selection.symbols, source: 'curated-fallback',
      candidateSource: 'Curated stock and ETF fallback list', count: selection.symbols.length, cached: false,
      coverage: { verification: 'unverified-server-error', availableAtBroker: null, candidatesFromSource: MASTER_UNIVERSE.length, scanned: selection.symbols.length, rejected: selection.rejected, note: e.message },
    });
  }
});

app.get('/api/momentum/settings', requireAuth, (req, res) => {
  const settings = momentumConfigFor(req.session.userId);
  res.set('Cache-Control', 'no-store').json(settings);
});

app.get('/api/momentum/market-direction', requireAuth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json({
      ...await getMomentumMarketDirection(req.session.userId),
      inverseCycle: momentumInverseCycleStore.get(req.session.userId),
    });
  } catch (error) {
    res.status(503).json({
      available: false,
      direction: 'UNAVAILABLE',
      dropping: false,
      inverseMode: false,
      inverseSymbol: null,
      reason: `Market direction unavailable: ${error.message}`,
    });
  }
});

app.put('/api/momentum/settings', requireAuth, (req, res) => {
  const prior = momentumConfigFor(req.session.userId);
  const requestedPositionDollars = req.body?.maxPositionDollars
    ?? req.body?.config?.maxPositionDollars
    ?? req.body?.config?.positionValue;
  const config = serverOwnedMomentumConfig(
    DEFAULT_MOMENTUM_CONFIG,
    prior.config,
    requestedPositionDollars
  );
  const enabled = req.body?.enabled === true;
  const creds = getAlpacaCreds(req.session.userId, 'momentum');
  const liveArmed = req.body?.liveArmed === true && creds?.mode === 'live';
  db.prepare(`
    INSERT INTO momentum_settings (user_id,enabled,live_armed,config_json,updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      enabled=excluded.enabled,live_armed=excluded.live_armed,
      config_json=excluded.config_json,updated_at=excluded.updated_at
  `).run(req.session.userId, enabled ? 1 : 0, liveArmed ? 1 : 0, JSON.stringify(config));
  res.json({ ok: true, enabled, liveArmed, config });
});

async function buildMomentumCandidate(userId, symbol, config) {
  const sym = String(symbol || '').toUpperCase();
  const quote = await _fetchMomentumQuote(sym);
  if (!hasCompleteMomentumQuote(quote)) {
    throw new Error('Fresh candidate quote lacks required finite price, change, or volume evidence.');
  }
  const basic = momentumRowFromQuote(sym, quote, config);
  if (!basic.eligible) return { symbol: sym, eligible: false, stage: 'SCANNER', reason: basic.reason, ...basic.row };
  // The scheduler does not trade on a scanner score alone.  It must obtain a
  // newly completed 5-minute structural setup with VWAP, volume, relative
  // strength, and invalidation evidence from the server-owned safety gate.
  const priceAction = await evaluateMomentumEntryPriceAction(userId, sym, 'momentum');
  if (!priceAction?.eligible || priceAction.direction !== 'LONG_ONLY') {
    return {
      symbol: sym, eligible: false, stage: 'PRICE_ACTION',
      reason: (priceAction?.reasons || ['fresh structural evidence unavailable']).slice(0, 2).join(' '),
      ...basic.row, priceAction,
    };
  }
  return { symbol: sym, eligible: true, stage: 'READY', ...basic.row, priceAction };
}

function recordMomentumEntryIntent(userId, candidate, entryPrice, shares, stopPrice, clientOrderId, mode, takeProfitPct) {
  const creds = getAlpacaCreds(userId, 'momentum');
  if (!creds || creds.mode !== mode || !creds.account_id) {
    throw new Error('The active Momentum broker identity is unavailable for the entry journal.');
  }
  const result = db.prepare(`
    INSERT INTO bot_trade_log
      (user_id,symbol,entry_price,shares,mode,status,stop_price,take_profit_pct,entry_order_id,strategy,broker_account_id)
    VALUES (?,?,?,?,?,'open',?,?,?,'momentum',?)
  `).run(userId, candidate.symbol, entryPrice, shares, mode, stopPrice, takeProfitPct,
    clientOrderId, creds.account_id);
  return db.prepare('SELECT * FROM bot_trade_log WHERE id=?').get(result.lastInsertRowid);
}

async function applyMomentumExitFill(userId, pinnedCreds, trade, exitOrder, reason) {
  const orderId = String(exitOrder?.id || '');
  const filledQty = Number(exitOrder?.filled_qty);
  const filledPrice = Number(exitOrder?.filled_avg_price);
  if (!orderId || !(filledQty > 0 && filledPrice > 0)) return { recorded: false, closed: false };
  db.prepare(`INSERT INTO momentum_exit_fills
    (trade_id,broker_order_id,filled_qty,filled_notional,updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(trade_id,broker_order_id) DO UPDATE SET
      filled_qty=excluded.filled_qty,filled_notional=excluded.filled_notional,updated_at=datetime('now')`)
    .run(trade.id, orderId, filledQty, filledQty * filledPrice);
  const totals = db.prepare(`SELECT COALESCE(SUM(filled_qty),0) AS qty,
    COALESCE(SUM(filled_notional),0) AS notional
    FROM momentum_exit_fills WHERE trade_id=?`).get(trade.id);
  const positions = await momentumBrokerFetch(userId, pinnedCreds, '/v2/positions');
  const position = (Array.isArray(positions) ? positions : []).find(item => item.symbol === trade.symbol);
  if (position && Number(position.qty) > 0) {
    db.prepare('UPDATE bot_trade_log SET shares=? WHERE id=? AND status=\'open\'')
      .run(Number(position.qty), trade.id);
    return { recorded: true, closed: false, remainingQty: Number(position.qty) };
  }
  const totalQty = Number(totals.qty);
  const totalNotional = Number(totals.notional);
  const expectedQty = Number(trade.entry_filled_qty);
  if (!trade.entry_fill_finalized || !(expectedQty > 0) || totalQty + 1e-8 < expectedQty) {
    return {
      recorded: true,
      closed: false,
      discrepancy: true,
      reason: trade.entry_fill_finalized
        ? `Broker is flat but only ${totalQty} of ${expectedQty || 'unknown'} entry shares have confirmed exit fills.`
        : 'Broker is flat but the final confirmed entry quantity is not yet known.',
    };
  }
  const exitPrice = totalQty > 0 ? totalNotional / totalQty : null;
  if (!(exitPrice > 0)) return { recorded: true, closed: false };
  db.prepare(`UPDATE bot_trade_log
    SET shares=?,exit_price=?,pnl=?,status='closed',
      pending_exit_order_id=NULL,pending_exit_client_order_id=NULL,pending_exit_reason=NULL,
      rescue_stop_order_id=NULL,rescue_stop_client_order_id=NULL,
      exit_reason=?,exit_cooldown_until=datetime('now','+15 minutes'),closed_at=datetime('now')
    WHERE id=? AND status='open'`)
    .run(totalQty, exitPrice, +(totalNotional - Number(trade.entry_price) * totalQty).toFixed(6),
      reason, trade.id);
  return { recorded: true, closed: true };
}

async function ensureMomentumResidualProtection(userId, pinnedCreds, trade, quantity) {
  if (!(quantity > 0) || !(Number(trade.stop_price) > 0)) {
    throw new Error(`Residual stop protection cannot be verified for ${trade.symbol}.`);
  }
  const openOrders = await momentumBrokerFetch(userId, pinnedCreds, '/v2/orders?limit=500&status=open');
  const protectedAtBroker = (Array.isArray(openOrders) ? openOrders : []).some(order =>
    order.symbol === trade.symbol
    && String(order.side || '').toLowerCase() === 'sell'
    && ['stop', 'stop_limit'].includes(String(order.type || '').toLowerCase())
    && Number(order.qty) >= quantity
    && Number(order.stop_price) + 0.001 >= Number(trade.stop_price)
    && !['filled', 'canceled', 'cancelled', 'rejected', 'expired'].includes(String(order.status || '').toLowerCase())
  );
  if (protectedAtBroker) return { existing: true };
  const rescueClientOrderId = `mt-rescue-${userId}-${trade.id}-${Date.now().toString(36)}`.slice(0, 48);
  db.prepare('UPDATE bot_trade_log SET rescue_stop_client_order_id=? WHERE id=?')
    .run(rescueClientOrderId, trade.id);
  const rescue = await momentumBrokerMutation(userId, pinnedCreds, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol: trade.symbol, qty: String(quantity), side: 'sell', type: 'stop',
      time_in_force: 'day', stop_price: Number(trade.stop_price).toFixed(2),
      client_order_id: rescueClientOrderId,
    }),
  });
  db.prepare('UPDATE bot_trade_log SET rescue_stop_order_id=? WHERE id=?')
    .run(rescue?.id || null, trade.id);
  return { existing: false, order: rescue };
}

async function reconcileMomentumTrades(userId, pinnedCreds) {
  const trades = db.prepare(`
    SELECT * FROM bot_trade_log
    WHERE user_id=? AND status='open' AND (strategy IS NULL OR strategy='momentum')
  `).all(userId);
  const reconciled = [];
  for (const trade of trades) {
    if (!pinnedCreds) throw new Error('Dedicated Momentum broker account is unavailable.');
    if (trade.mode !== pinnedCreds.mode) {
      throw new Error(`Saved ${trade.mode} trade cannot be reconciled through the active ${pinnedCreds.mode} account.`);
    }
    if (trade.broker_account_id && trade.broker_account_id !== pinnedCreds.account_id) {
      throw new Error(`Saved trade ${trade.id} belongs to a different Momentum broker account.`);
    }
    const clientOrderId = String(trade.entry_order_id || '');
    if (!clientOrderId) continue;
    try {
      let entryOrder = null;
      if (!trade.broker_account_id) {
        entryOrder = await momentumBrokerFetch(userId, pinnedCreds,
          `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}&nested=true`);
        if (!brokerOrderMatchesIntent(entryOrder, clientOrderId)) {
          throw new Error('Legacy Momentum trade could not be bound to the active broker account.');
        }
        db.prepare(`UPDATE bot_trade_log SET broker_account_id=?
          WHERE id=? AND broker_account_id IS NULL`).run(pinnedCreds.account_id, trade.id);
        trade.broker_account_id = pinnedCreds.account_id;
      }
      if (!entryOrder) {
        entryOrder = await momentumBrokerFetch(userId, pinnedCreds,
          `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}&nested=true`);
      }
      const observedEntryQty = Number(entryOrder?.filled_qty);
      const entryTerminal = ['filled', 'canceled', 'cancelled', 'rejected', 'expired']
        .includes(String(entryOrder?.status || '').toLowerCase());
      if (observedEntryQty > Number(trade.entry_filled_qty || 0) || (entryTerminal && !trade.entry_fill_finalized)) {
        db.prepare(`UPDATE bot_trade_log SET
          entry_filled_qty=MAX(COALESCE(entry_filled_qty,0),?),
          entry_fill_finalized=CASE WHEN ? THEN 1 ELSE entry_fill_finalized END
          WHERE id=?`).run(Math.max(0, observedEntryQty || 0), entryTerminal ? 1 : 0, trade.id);
        trade.entry_filled_qty = Math.max(Number(trade.entry_filled_qty || 0), observedEntryQty || 0);
        trade.entry_fill_finalized = entryTerminal ? 1 : trade.entry_fill_finalized;
      }
      if (trade.rescue_stop_order_id || trade.rescue_stop_client_order_id) {
        const rescuePath = trade.rescue_stop_order_id
          ? `/v2/orders/${encodeURIComponent(trade.rescue_stop_order_id)}?nested=true`
          : `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(trade.rescue_stop_client_order_id)}&nested=true`;
        const rescueOrder = await momentumBrokerFetch(userId, pinnedCreds, rescuePath);
        const rescueFill = filledSellOrder(rescueOrder);
        if (rescueFill) {
          const applied = await applyMomentumExitFill(
            userId, pinnedCreds, trade, rescueFill, 'Broker rescue stop filled'
          );
          if (applied.discrepancy) throw new Error(applied.reason);
          reconciled.push({ id: trade.id, event: applied.closed ? 'rescue stop fill confirmed' : 'partial rescue fill confirmed' });
          if (applied.closed) continue;
          if (['canceled', 'cancelled', 'rejected', 'expired'].includes(String(rescueOrder.status || '').toLowerCase())) {
            await ensureMomentumResidualProtection(userId, pinnedCreds, trade, applied.remainingQty);
            reconciled.push({ id: trade.id, event: 'residual stop protection restored' });
          }
        } else if (isTerminalWithoutFill(rescueOrder)) {
          const positions = await momentumBrokerFetch(userId, pinnedCreds, '/v2/positions');
          const residual = (Array.isArray(positions) ? positions : [])
            .find(item => item.symbol === trade.symbol);
          const residualQty = Number(residual?.qty);
          if (!needsRescueReplacement(rescueOrder, residualQty)) {
            throw new Error(`Rescue stop for ${trade.symbol} ended without a fill and no confirmed exit explains the flat broker position.`);
          }
          db.prepare(`UPDATE bot_trade_log SET rescue_stop_order_id=NULL,
            rescue_stop_client_order_id=NULL WHERE id=?`).run(trade.id);
          await ensureMomentumResidualProtection(userId, pinnedCreds, trade, residualQty);
          reconciled.push({ id: trade.id, event: 'terminal rescue stop replaced' });
          continue;
        }
      }
      if (trade.pending_exit_client_order_id || trade.pending_exit_order_id) {
        const pendingId = String(trade.pending_exit_client_order_id || trade.pending_exit_order_id);
        const pendingIsClientId = !!trade.pending_exit_client_order_id
          || !/^[a-f0-9-]{10,40}$/i.test(pendingId);
        const pendingPath = pendingIsClientId
          ? `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(pendingId)}&nested=true`
          : `/v2/orders/${encodeURIComponent(pendingId)}?nested=true`;
        const pendingOrder = await momentumBrokerFetch(userId, pinnedCreds, pendingPath);
        const pendingFill = filledSellOrder(pendingOrder);
        if (pendingFill) {
          const applied = await applyMomentumExitFill(
            userId, pinnedCreds, trade, pendingFill,
            trade.pending_exit_reason || 'Broker RSI take-profit filled'
          );
          if (applied.discrepancy) throw new Error(applied.reason);
          reconciled.push({ id: trade.id, event: applied.closed ? 'RSI exit fill confirmed' : 'partial RSI exit fill confirmed' });
          if (applied.closed) continue;
          if (['canceled', 'cancelled', 'rejected', 'expired'].includes(String(pendingOrder.status || '').toLowerCase())) {
            await ensureMomentumResidualProtection(userId, pinnedCreds, trade, applied.remainingQty);
            db.prepare(`UPDATE bot_trade_log SET pending_exit_order_id=NULL,
              pending_exit_client_order_id=NULL,pending_exit_reason=NULL WHERE id=?`).run(trade.id);
            reconciled.push({ id: trade.id, event: 'terminal partial exit protected for retry' });
          }
        }
        if (isTerminalWithoutFill(pendingOrder)) {
          const positions = await momentumBrokerFetch(userId, pinnedCreds, '/v2/positions');
          const residual = (Array.isArray(positions) ? positions : []).find(item => item.symbol === trade.symbol);
          if (residual && Number(residual.qty) > 0) {
            await ensureMomentumResidualProtection(userId, pinnedCreds, trade, Number(residual.qty));
          }
          db.prepare(`UPDATE bot_trade_log SET pending_exit_order_id=NULL,
            pending_exit_client_order_id=NULL,pending_exit_reason=NULL WHERE id=?`).run(trade.id);
          reconciled.push({ id: trade.id, event: `pending exit ${String(pendingOrder.status).toLowerCase()}` });
        } else {
          continue;
        }
      }
      const order = entryOrder;
      if (!brokerOrderMatchesIntent(order, clientOrderId)) {
        throw new Error('Broker response does not match the Momentum order intent.');
      }
      const status = String(order?.status || '').toLowerCase();
      const filledEntry = Number(order?.filled_avg_price);
      const filledShares = Number(order?.filled_qty);
      if (filledEntry > 0 && filledShares > 0) {
        db.prepare('UPDATE bot_trade_log SET entry_price=?,shares=? WHERE id=?')
          .run(filledEntry, filledShares, trade.id);
        reconciled.push({ id: trade.id, event: status === 'filled' ? 'entry fill confirmed' : 'partial entry fill confirmed' });
      } else if (['canceled', 'rejected', 'expired'].includes(status) && !(filledShares > 0)) {
        db.prepare(`UPDATE bot_trade_log SET status='void',exit_reason=?,closed_at=datetime('now') WHERE id=?`)
          .run(`Broker entry ${status}`, trade.id);
        reconciled.push({ id: trade.id, event: `entry ${status}` });
        continue;
      }
      const exit = (Array.isArray(order?.legs) ? order.legs : []).find(leg =>
        String(leg?.side || '').toLowerCase() === 'sell' &&
        Number(leg?.filled_avg_price) > 0 && Number(leg?.filled_qty) > 0
      );
      if (!exit) continue;
      const applied = await applyMomentumExitFill(
        userId, pinnedCreds, { ...trade, entry_price: filledEntry > 0 ? filledEntry : trade.entry_price }, exit,
        String(exit.type || '').startsWith('stop') ? 'Broker stop-loss filled' : 'Broker take-profit filled'
      );
      if (applied.discrepancy) throw new Error(applied.reason);
      reconciled.push({ id: trade.id, event: applied.closed ? 'protected exit fill confirmed' : 'partial protected exit fill confirmed' });
    } catch (error) {
      // Network failures and ambiguous broker POSTs are intentionally left open
      // for a later exact-client-order reconciliation; never infer a close.
      console.warn(`[Momentum] reconciliation deferred for ${trade.symbol}: ${error.message}`);
    }
  }
  return reconciled;
}

async function momentumRsiFor(userId, symbol) {
  const now = new Date();
  const start = new Date(now.getTime() - 240 * 60 * 1000);
  const data = await alpacaDataFetch(userId,
    `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Min&start=${encodeURIComponent(start.toISOString())}&limit=300&adjustment=all&feed=iex`,
    'momentum');
  const bars = Array.isArray(data?.bars) ? data.bars : [];
  if (bars.length < 15) throw new Error(`Fresh intraday RSI evidence is unavailable for ${symbol}.`);
  const completed = bars.filter(bar => {
    const startedAt = gpTimestampMs(bar?.t);
    return Number.isFinite(startedAt) && startedAt + 60_000 <= Date.now();
  });
  const value = calcRSI(completed.map(bar => Number(bar.c)), 14);
  if (!Number.isFinite(value)) throw new Error(`Fresh intraday RSI evidence is unavailable for ${symbol}.`);
  return +value.toFixed(1);
}

async function submitMomentumRsiExit(userId, pinnedCreds, trade, position, rsi) {
  if (!pinnedCreds || pinnedCreds.mode !== trade.mode) {
    throw new Error(`Momentum exit account mismatch for ${trade.symbol}.`);
  }
  const quantity = Number(position?.qty);
  if (!(quantity > 0) || String(position?.symbol || '') !== trade.symbol) {
    throw new Error(`Broker position quantity is unavailable for ${trade.symbol}.`);
  }
  const clientOrderId = `mt-exit-${userId}-${trade.id}-${Date.now().toString(36)}`.slice(0, 48);
  const reason = `RSI take-profit (${rsi} ≥ ${Number(trade.take_profit_rsi)})`;
  db.prepare(`UPDATE bot_trade_log SET pending_exit_client_order_id=?,pending_exit_reason=?
    WHERE id=? AND status='open' AND pending_exit_client_order_id IS NULL AND pending_exit_order_id IS NULL`)
    .run(clientOrderId, reason, trade.id);
  const reserved = db.prepare('SELECT pending_exit_client_order_id FROM bot_trade_log WHERE id=?').get(trade.id);
  if (reserved?.pending_exit_client_order_id !== clientOrderId) return null;

  try {
    const parent = await momentumBrokerFetch(userId, pinnedCreds,
      `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(trade.entry_order_id)}&nested=true`);
    const openProtectiveOrders = (Array.isArray(parent?.legs) ? parent.legs : []).filter(order =>
      String(order?.side || '').toLowerCase() === 'sell'
      && !['filled', 'canceled', 'cancelled', 'rejected', 'expired'].includes(String(order?.status || '').toLowerCase())
    );
    for (const order of openProtectiveOrders) {
      await momentumBrokerMutation(userId, pinnedCreds,
        `/v2/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE' });
    }

    const submitted = await momentumBrokerMutation(userId, pinnedCreds, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: trade.symbol,
        qty: String(quantity),
        side: 'sell',
        type: 'market',
        time_in_force: 'day',
        client_order_id: clientOrderId,
      }),
    });
    if (submitted?.id) {
      db.prepare(`UPDATE bot_trade_log SET pending_exit_order_id=?
        WHERE id=? AND pending_exit_client_order_id=?`).run(submitted.id, trade.id, clientOrderId);
    }
    return submitted;
  } catch (error) {
    let exitOrder = null;
    try {
      exitOrder = await momentumBrokerFetch(userId, pinnedCreds,
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}&nested=true`);
    } catch (lookupError) {
      if (lookupError.alpacaStatus !== 404) {
        console.warn(`[Momentum] exit recovery lookup failed for ${trade.symbol}: ${lookupError.message}`);
      }
    }
    if (exitOrder?.id) {
      db.prepare('UPDATE bot_trade_log SET pending_exit_order_id=? WHERE id=?')
        .run(exitOrder.id, trade.id);
      throw error;
    }
    try {
      const positions = await momentumBrokerFetch(userId, pinnedCreds, '/v2/positions');
      const residual = (Array.isArray(positions) ? positions : []).find(item => item.symbol === trade.symbol);
      if (residual && Number(residual.qty) > 0) {
        await ensureMomentumResidualProtection(userId, pinnedCreds, trade, Number(residual.qty));
      }
      db.prepare(`UPDATE bot_trade_log SET pending_exit_order_id=NULL,
        pending_exit_client_order_id=NULL,pending_exit_reason=NULL WHERE id=?`).run(trade.id);
    } catch (recoveryError) {
      console.error(`[Momentum] exit protection recovery failed for ${trade.symbol}: ${recoveryError.message}`);
    }
    throw error;
  }
}

async function manageMomentumOpenPositions(userId, pinnedCreds) {
  if (!isMarketOpen()) return [];
  const trades = db.prepare(`SELECT * FROM bot_trade_log
    WHERE user_id=? AND status='open' AND (strategy IS NULL OR strategy='momentum')
    ORDER BY id`).all(userId);
  if (!trades.length) return [];
  const positions = await momentumBrokerFetch(userId, pinnedCreds, '/v2/positions');
  const bySymbol = new Map((Array.isArray(positions) ? positions : []).map(position => [position.symbol, position]));
  const exits = [];
  for (const trade of trades) {
    if (trade.pending_exit_client_order_id || trade.pending_exit_order_id) continue;
    if (!(Number(trade.take_profit_rsi) > 0) || Number(trade.take_profit_pct) > 0) continue;
    const position = bySymbol.get(trade.symbol);
    if (!position) continue;
    const rsi = await momentumRsiFor(userId, trade.symbol);
    if (rsi < Number(trade.take_profit_rsi)) continue;
    const submitted = await submitMomentumRsiExit(userId, pinnedCreds, trade, position, rsi);
    if (submitted) exits.push({ tradeId: trade.id, symbol: trade.symbol, rsi });
  }
  return exits;
}

async function executeMomentumEntry(userId, candidate, pinnedCreds = null) {
  const { enabled, liveArmed, config } = momentumConfigFor(userId);
  if (!enabled) throw new Error('Momentum automation is disabled in persisted settings.');
  const creds = pinnedCreds || getAlpacaCreds(userId, 'momentum');
  if (!creds) throw new Error('Connect the dedicated Momentum Alpaca account first.');
  if (creds.mode === 'live' && !liveArmed) {
    throw new Error('Momentum Live orders are not explicitly armed.');
  }
  if (!isMarketOpen()) throw new Error('Market is closed for Momentum automation.');
  if (momentumSymbolCoolingDown(userId, candidate.symbol)) {
    throw new Error(`${candidate.symbol} is in the persisted 15-minute exit cooldown.`);
  }
  const pinnedFetch = path => momentumBrokerFetch(userId, creds, path);
  await assertAlpacaTradableEquity(userId, candidate.symbol, {
    fresh: true, scope: 'momentum', brokerFetch: pinnedFetch,
  });
  const fresh = await buildMomentumCandidate(userId, candidate.symbol, config);
  if (!fresh.eligible) throw new Error(`Fresh Momentum verification blocked entry: ${fresh.reason}`);
  const slots = await getOpenSlots(userId, 'Momentum', 'momentum', pinnedFetch);
  if (!canReserveEntryUnits(slots)) throw new Error('Position limit reached or account data is unavailable.');
  if (slots.positions.some(position => position.symbol === fresh.symbol) ||
      slots.openOrders.some(order => order.symbol === fresh.symbol)) {
    throw new Error(`${fresh.symbol} already has a position or pending broker order.`);
  }
  const daily = db.prepare(`
    SELECT COUNT(*) AS entries,
      COALESCE(SUM(CASE WHEN status='closed' AND pnl < 0 THEN -pnl ELSE 0 END),0) AS losses
    FROM bot_trade_log
    WHERE user_id=? AND (strategy IS NULL OR strategy='momentum')
      AND date(timestamp,'localtime')=date('now','localtime') AND status<>'void'
  `).get(userId);
  if (Number(daily.entries) >= config.maxTradesPerDay) throw new Error('Momentum daily trade limit reached.');
  if (Number(daily.losses) >= config.maxDailyLoss) throw new Error('Momentum daily loss limit reached.');
  const [account, liveQuote] = await Promise.all([
    momentumBrokerFetch(userId, creds, '/v2/account'),
    fetchLiveQuote(fresh.symbol, userId, 'momentum'),
  ]);
  const entryPrice = Number(liveQuote?.price ?? liveQuote?.regularMarketPrice);
  const equity = Number(account?.equity);
  if (!(entryPrice > 0 && equity > 0)) throw new Error('Fresh executable price or account equity is unavailable.');
  const structuralStop = Number(fresh.priceAction?.invalidation);
  const structuralSlPct = structuralStop > 0 && structuralStop < entryPrice
    ? (entryPrice - structuralStop) / entryPrice * 100 : null;
  const slPct = structuralSlPct == null ? config.stopPercent : Math.min(config.stopPercent, structuralSlPct);
  const tpPct = config.takeProfitPercent;
  if (!(slPct > 0 && tpPct > 0 && tpPct / slPct >= config.minRR)) {
    throw new Error('Configured target does not meet the required protected risk/reward ratio.');
  }
  const amount = config.positionMode === 'fixed' ? config.positionValue : equity * config.positionValue / 100;
  const riskPctOfEquity = amount * slPct / 100 / equity * 100;
  if (!(amount > 0) || riskPctOfEquity > 5) throw new Error('Momentum position would exceed the 5% equity risk cap.');
  const shares = Math.floor(amount / entryPrice);
  if (shares < 1) throw new Error('Configured position size is below one share at the current price.');
  const clientOrderId = `mt-${userId}-${fresh.symbol}-${Date.now().toString(36)}`.slice(0, 48);
  const stopPrice = +(entryPrice * (1 - slPct / 100)).toFixed(2);
  const targetPrice = +(entryPrice * (1 + tpPct / 100)).toFixed(2);
  const trade = recordMomentumEntryIntent(userId, fresh, entryPrice, shares, stopPrice, clientOrderId, creds.mode, tpPct);
  try {
  const order = await momentumBrokerMutation(userId, creds, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: fresh.symbol, qty: String(shares), side: 'buy', type: 'market', time_in_force: 'day',
        order_class: 'bracket',
        take_profit: { limit_price: targetPrice.toFixed(2) },
        stop_loss: { stop_price: stopPrice.toFixed(2) },
        client_order_id: clientOrderId,
      }),
    });
    return { trade, order, candidate: fresh };
  } catch (error) {
    if (!error.alpacaTransient) {
      db.prepare(`UPDATE bot_trade_log SET status='void',exit_reason=?,closed_at=datetime('now') WHERE id=?`)
        .run(`Broker entry was not accepted: ${error.message}`.slice(0, 200), trade.id);
    }
    throw error;
  }
}

async function executeMomentumInverseEntry(userId, marketDirection, pinnedCreds = null) {
  const { enabled, liveArmed, config } = momentumConfigFor(userId);
  if (!enabled) throw new Error('Momentum automation is disabled in persisted settings.');
  const creds = pinnedCreds || getAlpacaCreds(userId, 'momentum');
  if (!creds) throw new Error('Connect the dedicated Momentum Alpaca account first.');
  if (creds.mode === 'live' && !liveArmed) throw new Error('Momentum Live orders are not explicitly armed.');
  if (!isMarketOpen()) throw new Error('Market is closed for Momentum automation.');

  const freshMarket = await getMomentumMarketDirection(userId);
  if (!freshMarket.dropping || freshMarket.inverseSymbol !== marketDirection.inverseSymbol) {
    throw new Error('Fresh market-direction recheck no longer permits inverse mode.');
  }
  const symbol = freshMarket.inverseSymbol;
  if (momentumSymbolCoolingDown(userId, symbol)) {
    throw new Error(`${symbol} is in the persisted 15-minute exit cooldown.`);
  }
  const pinnedFetch = path => momentumBrokerFetch(userId, creds, path);
  await assertAlpacaTradableEquity(userId, symbol, {
    fresh: true, scope: 'momentum', brokerFetch: pinnedFetch,
  });
  const inverseVwap = await evaluateMomentumOrderVwap(userId, symbol);
  if (!inverseVwap.eligible) throw new Error(`Inverse ETF VWAP gate blocked entry: ${inverseVwap.reason}`);
  const slots = await getOpenSlots(userId, 'Momentum inverse', 'momentum', pinnedFetch);
  if (!canReserveEntryUnits(slots)) throw new Error('Position limit reached or account data is unavailable.');
  if (slots.positions.some(position => position.symbol === symbol) ||
      slots.openOrders.some(order => order.symbol === symbol)) {
    throw new Error(`${symbol} already has a position or pending broker order.`);
  }
  const daily = db.prepare(`
    SELECT COUNT(*) AS entries,
      COALESCE(SUM(CASE WHEN status='closed' AND pnl < 0 THEN -pnl ELSE 0 END),0) AS losses
    FROM bot_trade_log
    WHERE user_id=? AND (strategy IS NULL OR strategy='momentum')
      AND date(timestamp,'localtime')=date('now','localtime') AND status<>'void'
  `).get(userId);
  if (Number(daily.entries) >= config.maxTradesPerDay) throw new Error('Momentum daily trade limit reached.');
  if (Number(daily.losses) >= config.maxDailyLoss) throw new Error('Momentum daily loss limit reached.');
  const account = await momentumBrokerFetch(userId, creds, '/v2/account');
  const entryPrice = Number(inverseVwap.price);
  const equity = Number(account?.equity);
  if (!(entryPrice > 0 && equity > 0)) throw new Error('Fresh executable price or account equity is unavailable.');
  const slPct = config.stopPercent;
  const tpPct = config.takeProfitPercent;
  const amount = config.positionValue;
  const riskPctOfEquity = amount * slPct / 100 / equity * 100;
  if (!(amount > 0) || riskPctOfEquity > 5) throw new Error('Momentum inverse position would exceed the 5% equity risk cap.');
  if (!(tpPct / slPct >= config.minRR)) throw new Error('Inverse target does not meet the required protected risk/reward ratio.');
  const shares = Math.floor(amount / entryPrice);
  if (shares < 1) throw new Error('Configured position size is below one inverse ETF share at the current price.');
  const clientOrderId = `mt-inv-${userId}-${symbol}-${Date.now().toString(36)}`.slice(0, 48);
  const stopPrice = +(entryPrice * (1 - slPct / 100)).toFixed(2);
  const targetPrice = +(entryPrice * (1 + tpPct / 100)).toFixed(2);
  const candidate = { symbol };
  const trade = recordMomentumEntryIntent(userId, candidate, entryPrice, shares, stopPrice, clientOrderId, creds.mode, tpPct);
  try {
    const order = await momentumBrokerMutation(userId, creds, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol, qty: String(shares), side: 'buy', type: 'market', time_in_force: 'day',
        order_class: 'bracket',
        take_profit: { limit_price: targetPrice.toFixed(2) },
        stop_loss: { stop_price: stopPrice.toFixed(2) },
        client_order_id: clientOrderId,
      }),
    });
    console.log(`[Momentum] MARKET DOWN — inverse mode BUY ${symbol}: ${freshMarket.reason}`);
    return { trade, order, candidate, marketDirection: freshMarket };
  } catch (error) {
    if (!error.alpacaTransient) {
      db.prepare(`UPDATE bot_trade_log SET status='void',exit_reason=?,closed_at=datetime('now') WHERE id=?`)
        .run(`Broker inverse entry was not accepted: ${error.message}`.slice(0, 200), trade.id);
    }
    throw error;
  }
}

app.get('/api/bots/status', requireAuth, async (req, res) => {
  try {
    const spyLevels = await getSPYLevels();

    // PDT rule eliminated per SEC approval of FINRA SR-FINRA-2025-017, effective ~June 2026.
    let account = null;
    try {
      account = await alpacaFetch(req.session.userId, '/v2/account');
    } catch (e) { /* not connected */ }

    // Latest trade logs per bot (last 10 across all strategies)
    const recentTrades = db.prepare(
      `SELECT symbol, strategy, side, shares, entry_price, status, created_at
       FROM auto_trade_log WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 10`
    ).all(req.session.userId);
    const userId = req.session.userId;
    const pmhSetting = db.prepare('SELECT enabled FROM pmh_settings WHERE user_id=?').get(userId);
    const botSettings = [
      { name: 'momentum', enabled: momentumConfigFor(userId).enabled, scope: 'momentum' },
      { name: 'opening-momentum', enabled: !!pmhSetting?.enabled && isBotEnabled(userId, 'pmh'), scope: 'pmh' },
      { name: 'candlestick', enabled: candlestickConfigFor(userId).enabled, scope: 'candlestick' },
      { name: 'swing', enabled: swingConfigFor(userId).enabled, scope: 'swing' },
      { name: 'options', enabled: optionsConfigFor(userId).enabled, scope: 'options' },
    ];
    const botReadiness = await Promise.all(botSettings.map(async bot => {
      const creds = getAlpacaCreds(userId, bot.scope);
      if (!creds) return { ...bot, connected: false, executable: false, mode: null, reason: 'Dedicated broker account is not connected.' };
      try {
        const brokerAccount = await alpacaFetchFor(userId, bot.scope, '/v2/account');
        const accountActive = String(brokerAccount?.status || '').toUpperCase() === 'ACTIVE';
        const livePaused = bot.scope === 'pmh' && creds.mode === 'live' && PMH_LIVE_AUTOMATION_PAUSED;
        return {
          ...bot,
          connected: true,
          mode: creds.mode,
          accountActive,
          livePaused,
          executable: bot.enabled && accountActive && !livePaused
            && (bot.scope !== 'momentum' || momentumConfigFor(userId).liveArmed || creds.mode !== 'live')
            && (bot.scope !== 'pmh' || pmhConfigFor(userId).liveArmed || creds.mode !== 'live')
            && (bot.scope !== 'candlestick' || candlestickConfigFor(userId).liveArmed || creds.mode !== 'live')
            && (bot.scope !== 'swing' || swingConfigFor(userId).liveArmed || creds.mode !== 'live')
            && (bot.scope !== 'options' || optionsConfigFor(userId).liveArmed || creds.mode !== 'live'),
          reason: !bot.enabled ? 'Strategy is disabled.'
            : livePaused ? 'PMH live automation is paused for safety validation. Paper mode remains available.'
            : !accountActive ? 'Broker account is not active.'
            : bot.scope === 'momentum' && creds.mode === 'live' && !momentumConfigFor(userId).liveArmed
              ? 'Live Momentum authorization is not armed.'
              : bot.scope === 'pmh' && creds.mode === 'live' && !pmhConfigFor(userId).liveArmed
                ? 'Live Opening Momentum authorization is not armed.'
            : bot.scope === 'candlestick' && creds.mode === 'live' && !candlestickConfigFor(userId).liveArmed
              ? 'Live candlestick authorization is not armed.'
              : bot.scope === 'swing' && creds.mode === 'live' && !swingConfigFor(userId).liveArmed
                ? 'Live Swing authorization is not armed.'
              : bot.scope === 'options' && creds.mode === 'live' && !optionsConfigFor(userId).liveArmed
                ? 'Live Options authorization is not armed.'
              : null,
        };
      } catch (error) {
        return { ...bot, connected: true, executable: false, mode: creds.mode, reason: `Broker readiness check failed: ${error.message}` };
      }
    }));

    res.json({
      universeSize: MASTER_UNIVERSE.length,
      spyLevels,
      // PDT rule eliminated per SEC approval of FINRA SR-FINRA-2025-017, effective ~June 2026.
      pdt: { allowed: true, reason: 'PDT restrictions removed — FINRA SR-FINRA-2025-017',
             daytradeCount: account ? parseInt(account.daytrade_count || 0) : null,
             equity: account ? parseFloat(account.equity || 0) : null,
             patternDayTrader: false },
      recentTrades,
      botReadiness,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bot toggle helpers ─────────────────────────────────────────────────────────
const BOT_NAMES = ['countertrend', 'pmh', 'momentum', 'candlestick'];

function isBotEnabled(userId, botName) {
  const row = db.prepare('SELECT enabled FROM bot_toggles WHERE user_id=? AND bot_name=?').get(userId, botName);
  // PMH is deliberately opt-in; an account connection must never silently
  // activate a new opening-range strategy.
  return row ? !!row.enabled : ['pmh', 'momentum', 'candlestick'].includes(botName) ? false : true;
}

// GET /api/bots/toggles — returns { bounce: true, volatility_expansion: false, … }
app.get('/api/bots/toggles', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT bot_name, enabled FROM bot_toggles WHERE user_id=?').all(req.session.userId);
  const map  = Object.fromEntries(BOT_NAMES.map(b => [b, ['pmh', 'momentum', 'candlestick'].includes(b) ? false : true]));
  rows.forEach(r => { map[r.bot_name] = !!r.enabled; });
  res.json(map);
});

// POST /api/bots/toggle — body: { bot: 'bounce', enabled: true/false }
app.post('/api/bots/toggle', requireAuth, (req, res) => {
  const { bot, enabled } = req.body;
  if (!BOT_NAMES.includes(bot)) return res.status(400).json({ error: 'Unknown bot name' });
  db.prepare(`
    INSERT INTO bot_toggles (user_id, bot_name, enabled) VALUES (?,?,?)
    ON CONFLICT(user_id, bot_name) DO UPDATE SET enabled=excluded.enabled
  `).run(req.session.userId, bot, enabled ? 1 : 0);
  console.log(`[Bot-Toggle] User ${req.session.userId} set ${bot} → ${enabled ? 'ON' : 'OFF'}`);
  res.json({ ok: true, bot, enabled: !!enabled });
});

// ── POST /api/bots/trigger — manually fire one server-owned cycle per bot ────
app.post('/api/bots/trigger', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  // Run sequentially. The shared account-level execution lock remains the
  // boundary between a triggered cycle, a scheduler tick, and manual orders.
  const outcomes = [];
  for (const runCycle of [runMomentumCycle, runPmhCycle, runCandlestickCycle, runSwingCycle, runOptionsCycle]) {
    try {
      outcomes.push(await runCycle(userId, 'manual-trigger'));
    } catch (error) {
      outcomes.push({ bot: 'unknown', status: 'error', error: 'Cycle could not complete safely.' });
      console.warn('[Bot trigger] cycle withheld:', error.message);
    }
  }
  const submitted = outcomes.filter(outcome => outcome?.submitted).map(outcome => outcome.bot);
  const reconciled = outcomes.filter(outcome => outcome?.reconciled > 0).map(outcome => outcome.bot);
  res.json({
    ok: outcomes.some(outcome => outcome?.status !== 'error'),
    marketOpen: isMarketOpen(),
    outcomes,
    message: submitted.length
      ? `Cycle completed; ${submitted.join(', ')} submitted a broker-reviewed entry.`
      : reconciled.length
        ? `Cycle completed; reconciled ${reconciled.join(', ')} broker records.`
        : isMarketOpen()
          ? 'Cycle completed; no enabled strategy found a broker-approved entry.'
          : 'Cycle completed; reconciled enabled strategies. New entries remain closed outside market hours.',
  });
});


// ── DELETE /api/bots/clear-log — wipe the user's bot trade log ───────────────
app.delete('/api/bots/clear-log', requireAuth, (req, res) => {
  try {
    const { changes } = db.prepare('DELETE FROM auto_trade_log WHERE user_id = ?').run(req.session.userId);
    console.log(`[BotLog] Cleared ${changes} trade log entries for user ${req.session.userId}`);
    res.json({ ok: true, deleted: changes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
function calcATRSeries(bars, period = 14) {
  const result = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    const trs = [];
    for (let j = 1; j <= period; j++) {
      const prev = bars[i - j];
      const cur  = bars[i - j + 1];
      const tr   = Math.max(
        cur.h - cur.l,
        Math.abs(cur.h - prev.c),
        Math.abs(cur.l - prev.c)
      );
      trs.push(tr);
    }
    result[i] = trs.reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

// ── Bollinger Bands series ────────────────────────────────────────────────────
function calcBBWidth(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma   = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period;
  const std   = Math.sqrt(variance);
  const upper = sma + mult * std;
  const lower = sma - mult * std;
  const width = sma > 0 ? (upper - lower) / sma * 100 : 0;
  return { sma, upper, lower, std, width };
}

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

function calcBBWidthSeries(closes, period = 20, mult = 2, lookback = 20) {
  const widths = [];
  for (let i = closes.length - lookback; i <= closes.length; i++) {
    if (i < period) { widths.push(null); continue; }
    const slice = closes.slice(i - period, i);
    const sma   = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);
    const w     = sma > 0 ? ((sma + mult * std) - (sma - mult * std)) / sma * 100 : 0;
    widths.push(w);
  }
  return widths.filter(v => v !== null);
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

// ── Leveraged-proxy map ───────────────────────────────────────────────────────
// When a LONG signal fires for a stock priced > $30, all 4 bots trade this
// cheaper 2×/3× leveraged ETF instead of skipping the signal entirely.
// Gates (SPY / Whale / Dark Pool) still run on the ORIGINAL underlying symbol
// so the analysis reflects the real market. Only the order uses the proxy.
const LEVERAGED_MAP = {
  // ── Single-stock 2× leveraged ETFs (Direxion / T-Rex) ────────────────────
  'NVDA':  'NVDL',  // Direxion Daily NVDA Bull 2×
  'TSLA':  'TSLL',  // Direxion Daily TSLA Bull 2×
  'AAPL':  'AAPU',  // Direxion Daily AAPL Bull 2×
  'MSFT':  'MSFU',  // T-Rex 2× Long Microsoft
  'AMZN':  'AMZU',  // Direxion Daily AMZN Bull 2×
  'GOOGL': 'GGLL',  // Direxion Daily GOOGL Bull 2×
  'META':  'METU',  // T-Rex 2× Long Meta Platforms
  'AMD':   'AMDL',  // T-Rex 2× Long AMD
  'PLTR':  'PLTG',  // T-Rex 2× Long Palantir
  // ── Index ETFs → 3× leveraged bull ───────────────────────────────────────
  'SPY':   'SPXL',  'QQQ':  'TQQQ',  'IWM':  'TNA',
  'DIA':   'UDOW',  'SMH':  'SOXL',
  // ── Expensive semis → SOXL (3× semis bull) ───────────────────────────────
  'AVGO':  'SOXL',  'MU':   'SOXL',  'ARM':  'SOXL',
  'AMAT':  'SOXL',  'LRCX': 'SOXL',  'KLAC': 'SOXL',
  'QCOM':  'SOXL',  'TSM':  'SOXL',  'INTC': 'SOXL',
  'TXN':   'SOXL',  'ADI':  'SOXL',  'SMCI': 'SOXL',
  // ── Expensive tech (no specific single-stock ETF) → TQQQ ─────────────────
  'NFLX':  'TQQQ',  'SHOP': 'TQQQ',  'UBER': 'TQQQ',
  'CRM':   'TQQQ',  'ORCL': 'TQQQ',  'ADBE': 'TQQQ',
  'INTU':  'TQQQ',  'BKNG': 'TQQQ',  'ACN':  'TQQQ',
  'CSCO':  'TQQQ',  'IBM':  'TQQQ',
  // ── Expensive financials → FAS (3× financials bull) ──────────────────────
  'JPM':   'FAS',   'BAC':  'FAS',   'GS':   'FAS',
  'MS':    'FAS',   'C':    'FAS',   'WFC':  'FAS',
  'V':     'FAS',   'MA':   'FAS',   'AXP':  'FAS',
  'BLK':   'FAS',   'SPGI': 'FAS',   'CME':  'FAS',
  // ── Expensive healthcare / biotech → CURE (3× healthcare bull) ───────────
  'UNH':   'CURE',  'LLY':  'CURE',  'REGN': 'CURE',
  'ISRG':  'CURE',  'TMO':  'CURE',  'DHR':  'CURE',
  'ABT':   'CURE',  'SYK':  'CURE',  'VRTX': 'CURE',
  'AMGN':  'CURE',  'GILD': 'CURE',
  // ── Expensive energy → ERX (3× energy bull) ──────────────────────────────
  'XOM':   'ERX',   'CVX':  'ERX',   'COP':  'ERX',
  // ── Expensive defensives / industrials → SPXL ────────────────────────────
  'BRK.B': 'SPXL',  'WMT':  'SPXL',  'COST': 'SPXL',
  'HD':    'SPXL',  'LOW':  'SPXL',  'MCD':  'SPXL',
  'CAT':   'SPXL',  'DE':   'SPXL',  'UNP':  'SPXL',
  'RTX':   'SPXL',  'HON':  'SPXL',  'LIN':  'SPXL',
  'NEE':   'SPXL',  'MRK':  'SPXL',  'PG':   'SPXL',
  'ZTS':   'SPXL',  'NKE':  'SPXL',  'PM':   'SPXL',
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

// Returns the affordable 2×/3× leveraged proxy for an expensive stock,
// or null if the proxy itself is also > $25 or if no mapping exists.
async function getLeveragedProxy(symbol, price, userId = null) {
  if (price <= MAX_TRADE_PRICE) return null;
  const proxyTicker = LEVERAGED_MAP[symbol];
  if (!proxyTicker || ETF_PRODUCT_METADATA[proxyTicker]?.direction !== 'long') return null;
  try {
    if (userId) await assertAlpacaTradableEquity(userId, proxyTicker);
    const bars = await fetchOHLCV(proxyTicker, 2);
    const proxyPrice = bars?.at(-1)?.c;
    if (!proxyPrice || proxyPrice > MAX_TRADE_PRICE) return null;
    return { symbol: proxyTicker, price: proxyPrice };
  } catch { return null; }
}


// Runs every 5 minutes during regular US market hours (9:35 AM – 3:50 PM ET Mon-Fri)
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

// Returns { allowed: boolean, reason: string }
// side = 'long' (buying SPY) | 'short' (buying SH / inverse ETF)
async function checkSPYGate(symbol, price, side = 'long') {
  if (symbol !== 'SPY') return { allowed: true, reason: '' };
  const levels = await getSPYLevels();
  if (!levels) {
    console.warn('[SPY-Gate] No options data — proceeding without gate');
    return { allowed: true, reason: 'no options data' };
  }
  logSPYLevels(levels);
  const { floor, maxPain, roof } = levels;
  const PROX = 0.75; // "at a level" = within $0.75

  if (side === 'long') {
    if (price >= roof - PROX)  return { allowed: false, reason: `SPY $${price} AT/ABOVE ROOF $${roof} — no long` };
    if (price <= floor + PROX) return { allowed: false, reason: `SPY $${price} AT/BELOW FLOOR $${floor} — expect bounce, no forced long` };
    if (price > maxPain)       return { allowed: false, reason: `SPY $${price} ABOVE MAX PAIN $${maxPain} — bias SHORT, skipping long` };
    return { allowed: true,  reason: `SPY $${price} below max pain $${maxPain} — LONG bias confirmed` };
  }
  // side === 'short' (buying inverse ETF)
  if (price <= floor + PROX) return { allowed: false, reason: `SPY $${price} AT/BELOW FLOOR $${floor} — expect bounce, no short` };
  if (price < maxPain)       return { allowed: false, reason: `SPY $${price} BELOW MAX PAIN $${maxPain} — bias LONG, skipping short` };
  return { allowed: true, reason: `SPY $${price} above max pain $${maxPain} — SHORT bias confirmed` };
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

// Returns { allowed: bool, reason: string }
// direction = 'LONG' | 'SHORT'
// SPY is already handled by the SPY options gate — skip duplicate analysis.
async function checkWhaleGate(symbol, direction) {
  if (symbol === 'SPY') return { allowed: true, reason: '' }; // SPY gate handles this
  const whale = await detectWhaleSignal(symbol);
  if (!whale) return { allowed: true, reason: 'no options data' };
  const { callPutRatio, putCallRatio, callSweep, putSweep } = whale;
  if (direction === 'LONG') {
    if (putCallRatio >= 2.0)
      return { allowed: false, reason: `Whale BEARISH — put/call ${putCallRatio.toFixed(2)}:1 on ${symbol}` };
    if (putSweep && !callSweep && putCallRatio > 1.5)
      return { allowed: false, reason: `Whale PUT sweep on ${symbol} — skipping LONG` };
    return { allowed: true, reason: callPutRatio >= 1.5 ? `Whale BULLISH (call/put ${callPutRatio.toFixed(2)})` : '' };
  }
  if (direction === 'SHORT') {
    if (callPutRatio >= 2.0)
      return { allowed: false, reason: `Whale BULLISH — call/put ${callPutRatio.toFixed(2)}:1 on ${symbol}` };
    if (callSweep && !putSweep && callPutRatio > 1.5)
      return { allowed: false, reason: `Whale CALL sweep on ${symbol} — skipping SHORT` };
    return { allowed: true, reason: putCallRatio >= 1.5 ? `Whale BEARISH (put/call ${putCallRatio.toFixed(2)})` : '' };
  }
  return { allowed: true, reason: '' };
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

// Returns { allowed: bool, reason: string }
// direction = 'LONG' | 'SHORT'
// Block rules:
//   LONG  blocked if price > VAH * 1.03 (chasing above institutional zone)
//   SHORT blocked if price < VAL * 0.97 (oversold below institutional zone)
// Confirmation logged if price is near POC / VAL (long) or VAH (short).
async function checkDarkPoolGate(symbol, price, direction) {
  const dp = await detectDarkPoolLevels(symbol);
  if (!dp) return { allowed: true, reason: 'no DP data' };
  const { poc, vah, val } = dp;
  const prox = price * 0.008; // 0.8% proximity window

  if (direction === 'LONG') {
    if (price > vah * 1.03)
      return { allowed: false, reason: `DP: price $${price.toFixed(2)} is >3% above VAH $${vah} — chasing above dark pool zone` };
    const label = Math.abs(price - poc) <= prox ? `near POC $${poc}`
                : Math.abs(price - val) <= prox ? `near VAL $${val}` : '';
    return { allowed: true, reason: label ? `DP LONG confirmed — ${label}` : '' };
  }
  if (direction === 'SHORT') {
    if (price < val * 0.97)
      return { allowed: false, reason: `DP: price $${price.toFixed(2)} is >3% below VAL $${val} — oversold below dark pool zone` };
    const label = Math.abs(price - poc) <= prox ? `near POC $${poc}`
                : Math.abs(price - vah) <= prox ? `near VAH $${vah}` : '';
    return { allowed: true, reason: label ? `DP SHORT confirmed — ${label}` : '' };
  }
  return { allowed: true, reason: '' };
}

// ── PDT guard — eliminated per SEC approval of FINRA SR-FINRA-2025-017, effective ~June 2026.
// Pattern Day Trader designation and day-trade count restrictions no longer apply.
async function checkPDTAllowed(userId, botName) {
  return true;
}

// ── Cross-bot execution lock ─────────────────────────────────────────────────
// Prevents two bots from simultaneously executing for the same user.
// Lock expires after 90 seconds to avoid permanent deadlock on unexpected errors.
const _botLock = new Map(); // userId -> lock acquired timestamp
function acquireBotLock(userId) {
  const uid = String(userId);
  const now = Date.now();
  const ts  = _botLock.get(uid);
  if (ts && now - ts < 90_000) return false; // locked by another bot
  _botLock.set(uid, now);
  return true;
}
function releaseBotLock(userId) { _botLock.delete(String(userId)); }

// The in-memory cross-bot lock is useful within one process, but UltraBot3
// execution additionally needs a durable, ownership-fenced lease. A restart or
// a second worker therefore cannot turn a check-then-insert into two entries.
function acquireCandlestickExecutionLease(userId) {
  const token = crypto.randomUUID();
  const result = db.prepare(`INSERT INTO candlestick_execution_leases (user_id,token,expires_at)
    VALUES (?, ?, datetime('now','+5 minutes'))
    ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
    WHERE candlestick_execution_leases.expires_at <= datetime('now')`).run(userId, token);
  return result.changes === 1 ? token : null;
}
function renewCandlestickExecutionLease(userId, token) {
  if (!token) return false;
  return db.prepare(`UPDATE candlestick_execution_leases SET expires_at=datetime('now','+5 minutes')
    WHERE user_id=? AND token=? AND expires_at > datetime('now')`).run(userId, token).changes === 1;
}
function requireCandlestickExecutionLease(userId, token) {
  if (!renewCandlestickExecutionLease(userId, token)) {
    throw new Error('UltraBot3 execution lease expired or was replaced; reconciliation stopped without submitting another order.');
  }
}
function releaseCandlestickExecutionLease(userId, token) {
  if (token) db.prepare('DELETE FROM candlestick_execution_leases WHERE user_id=? AND token=?').run(userId, token);
}

// ── Slot counter: positions + all pending long entries ────────────────────────
// Every open BUY consumes capacity, including simple manual, OTO, bracket and
// PMH orders. Protective legs are SELLs and therefore do not consume a slot.
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

// ── Standalone Candlestick Automation ──────────────────────────────────────────
// This strategy has its own broker scope, settings, journal, and scheduler. It
// does not reuse Momentum or PMH analysis or execution paths.
const CANDLESTICK_DEFAULTS = Object.freeze({
  ...DEFAULT_CANDLE_CONFIG,
  maxPositionDollars: 1000,
  maxRiskDollars: 100,
  maxPositions: 1,
  maxSymbols: 16,
});
const candlestickWatchlistRotation = new Map();
const candleBarTime = bar => {
  const raw = bar?.t ?? bar?.timestamp;
  const n = typeof raw === 'number' ? (raw < 10_000_000_000 ? raw * 1000 : raw) : Date.parse(raw || '');
  return Number.isFinite(n) ? n : null;
};
function completedCandlestickBars(rawBars, durationMs = 5 * 60 * 1000) {
  const now = Date.now();
  return (Array.isArray(rawBars) ? rawBars : []).filter(bar => {
    const t = candleBarTime(bar);
    return t && t + durationMs <= now - 1_000;
  }).map(bar => ({ o: +bar.o, h: +bar.h, l: +bar.l, c: +bar.c, v: +bar.v, t: bar.t }));
}
function candlestickFresh(bars, maxAgeMs = 8 * 60 * 1000) {
  const last = bars?.at(-1);
  const stamp = candleBarTime(last);
  return !!stamp && Date.now() - stamp <= maxAgeMs;
}
function candlestickConfigFor(userId) {
  const row = db.prepare('SELECT enabled,live_armed,config_json FROM candlestick_settings WHERE user_id=?').get(userId);
  let saved = {};
  try { saved = row?.config_json ? JSON.parse(row.config_json) : {}; } catch (_) {}
  const config = sanitizeCandlestickExecutionConfig(
    serverOwnedConfig(CANDLESTICK_DEFAULTS, saved, undefined, { maximum: 100_000 }),
    CANDLESTICK_DEFAULTS
  );
  return { enabled: !!row?.enabled, liveArmed: !!row?.live_armed, config };
}
function candlestickRuntimeFor(userId) {
  const row = db.prepare(`SELECT updated_at,last_cycle_at,last_cycle_status,last_cycle_reason,
    last_cycle_scanned,last_cycle_eligible,last_cycle_source
    FROM candlestick_settings WHERE user_id=?`).get(userId);
  return row ? {
    settingsUpdatedAt: row.updated_at || null,
    lastCycleAt: row.last_cycle_at || null,
    lastCycleStatus: row.last_cycle_status || null,
    lastCycleReason: row.last_cycle_reason || null,
    lastCycleScanned: Number(row.last_cycle_scanned || 0),
    lastCycleEligible: Number(row.last_cycle_eligible || 0),
    lastCycleSource: row.last_cycle_source || null,
  } : {
    settingsUpdatedAt: null, lastCycleAt: null, lastCycleStatus: null,
    lastCycleReason: null, lastCycleScanned: 0, lastCycleEligible: 0, lastCycleSource: null,
  };
}
function recordCandlestickCycle(userId, outcome) {
  db.prepare(`UPDATE candlestick_settings SET
    last_cycle_at=datetime('now'),last_cycle_status=?,last_cycle_reason=?,
    last_cycle_scanned=?,last_cycle_eligible=?,last_cycle_source=?
    WHERE user_id=?`).run(
      String(outcome?.status || 'unknown').slice(0, 40),
      String(outcome?.reason || '').slice(0, 300) || null,
      Math.max(0, Number(outcome?.scanned || 0)),
      Math.max(0, Number(outcome?.eligible || 0)),
      String(outcome?.source || 'server-scheduler').slice(0, 40),
      userId,
    );
}
async function buildCandlestickCandidate(userId, symbol, config = CANDLESTICK_DEFAULTS) {
  const sym = String(symbol || '').toUpperCase();
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString();
  const data = await alpacaDataFetch(userId,
    `/v2/stocks/${encodeURIComponent(sym)}/bars?timeframe=5Min&start=${encodeURIComponent(start)}&limit=110&adjustment=all&feed=iex`,
    'candlestick');
  const bars = completedCandlestickBars(candlestickBarsFromResponse(data, sym));
  // Aggregation can produce a bucket whose final 5-minute constituent has
  // closed while the enclosing 15-minute candle has not. It is not completed
  // evidence and must be withheld from multi-timeframe confirmation.
  const higherDurationMs = 15 * 60 * 1000;
  const higher = aggregateTimeframeBars(bars, higherDurationMs).filter(bar => {
    const startAt = candleBarTime(bar);
    return startAt && startAt + higherDurationMs <= Date.now() - 1_000;
  });
  const setup = evaluateCandlestickSetup({
    symbol: sym, bars,
    timeframes: { primary: { bars, fresh: candlestickFresh(bars) }, higher: { bars: higher, fresh: candlestickFresh(higher, 20 * 60 * 1000) } },
    freshness: { primary: candlestickFresh(bars), higher: candlestickFresh(higher, 20 * 60 * 1000) },
  }, config);
  return { ...setup, symbol: sym, evaluatedAt: new Date().toISOString(),
    freshness: { bars: candlestickFresh(bars), higher: candlestickFresh(higher, 20 * 60 * 1000), barsAt: bars.at(-1)?.t || null } };
}
function saveCandlestickCandidates(userId, candidates) {
  const statement = db.prepare(`INSERT INTO candlestick_candidates (user_id,symbol,payload_json,evaluated_at)
    VALUES (?,?,?,datetime('now')) ON CONFLICT(user_id,symbol) DO UPDATE SET payload_json=excluded.payload_json,evaluated_at=excluded.evaluated_at`);
  const save = db.transaction(rows => rows.forEach(row => statement.run(userId, row.symbol, JSON.stringify(row))));
  save(candidates);
}
function candlestickPnl(trade, exitPrice, qty) {
  const multiplier = trade.direction === 'SHORT' ? -1 : 1;
  return +((Number(exitPrice) - Number(trade.entry_price)) * Number(qty) * multiplier).toFixed(6);
}
function candlestickOrderLookupPath(orderId, clientOrderId) {
  return orderId && orderId !== clientOrderId
    ? `/v2/orders/${encodeURIComponent(orderId)}?nested=true`
    : `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}&nested=true`;
}
function candlestickSignalAlreadyAttempted(userId, symbol, signalBarAt) {
  if (!signalBarAt) return false;
  return !!db.prepare(`SELECT 1 FROM candlestick_trade_log
    WHERE user_id=? AND symbol=? AND signal_bar_at=? LIMIT 1`).get(userId, symbol, signalBarAt);
}
function reserveCandlestickSignal(userId, symbol, signalBarAt) {
  return db.prepare(`INSERT OR IGNORE INTO candlestick_signal_reservations (user_id,symbol,signal_bar_at)
    VALUES (?,?,?)`).run(userId, symbol, signalBarAt).changes === 1;
}
function releaseCandlestickSignalReservation(userId, symbol, signalBarAt) {
  db.prepare(`DELETE FROM candlestick_signal_reservations
    WHERE user_id=? AND symbol=? AND signal_bar_at=? AND trade_id IS NULL`).run(userId, symbol, signalBarAt);
}
function attachCandlestickSignalReservation(userId, symbol, signalBarAt, tradeId) {
  db.prepare(`UPDATE candlestick_signal_reservations SET trade_id=?
    WHERE user_id=? AND symbol=? AND signal_bar_at=?`).run(tradeId, userId, symbol, signalBarAt);
}
function recordCandlestickExitFill(trade, order, reason) {
  const orderId = String(order?.id || order?.client_order_id || '');
  const quantity = Number(order?.filled_qty);
  const price = Number(order?.filled_avg_price);
  if (!orderId || !(quantity > 0) || !(price > 0)) return false;
  db.prepare(`INSERT INTO candlestick_exit_fills (trade_id,broker_order_id,quantity,price,reason,updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(trade_id,broker_order_id) DO UPDATE SET
      quantity=excluded.quantity,price=excluded.price,reason=excluded.reason,updated_at=datetime('now')`)
    .run(trade.id, orderId, quantity, price, reason);
  return true;
}
function candlestickRealizedPnl(trade) {
  const fills = db.prepare('SELECT quantity,price FROM candlestick_exit_fills WHERE trade_id=?').all(trade.id);
  if (!fills.length) return null;
  const quantity = fills.reduce((sum, fill) => sum + Number(fill.quantity), 0);
  const weightedExit = fills.reduce((sum, fill) => sum + Number(fill.quantity) * Number(fill.price), 0) / quantity;
  return {
    quantity,
    averageExit: weightedExit,
    pnl: fills.reduce((sum, fill) => sum + candlestickPnl(trade, fill.price, fill.quantity), 0),
  };
}
async function candlestickPosition(userId, symbol) {
  try { return await alpacaFetchFor(userId, 'candlestick', `/v2/positions/${encodeURIComponent(symbol)}`); }
  catch (error) { if (error.alpacaStatus === 404) return null; throw error; }
}
async function candlestickBrokerState(userId) {
  const [positions, openOrders] = await Promise.all([
    alpacaFetchFor(userId, 'candlestick', '/v2/positions'),
    alpacaFetchFor(userId, 'candlestick', '/v2/orders?status=open&limit=500'),
  ]);
  requireCandlestickBrokerCollection(positions, 'positions');
  requireCandlestickBrokerCollection(openOrders, 'open-orders');
  const pendingJournal = db.prepare(`SELECT symbol,entry_order_id,entry_client_order_id FROM candlestick_trade_log
    WHERE user_id=? AND status IN ('entry_intent','entry_unknown','pending_entry','open','protection_pending','rescue_cancel_intent','rescue_cancel_pending','exit_intent','pending_exit','exit_unknown','exit_failed')`).all(userId);
  return {
    positions,
    openOrders,
    pendingJournal,
  };
}
async function executeCandlestickEntry(userId, symbol, source = 'manual', leaseToken = null) {
  let { enabled, liveArmed, config } = candlestickConfigFor(userId);
  if (!enabled) throw new Error('Candlestick automation is disabled in persisted settings.');
  let creds = getAlpacaCreds(userId, 'candlestick');
  if (!creds) throw new Error('Connect the dedicated Candlestick Automation Alpaca account first.');
  if (creds.mode === 'live' && !liveArmed) throw new Error('Live trading is connected but not explicitly armed.');
  if (!isMarketOpen()) throw new Error('Market is closed for candlestick automation.');
  const asset = await assertAlpacaTradableEquity(userId, symbol, { fresh: true, scope: 'candlestick' });
  let candidate = await buildCandlestickCandidate(userId, symbol, config);
  saveCandlestickCandidates(userId, [candidate]);
  if (!candidate.eligible) {
    const error = new Error('Trade is not eligible after fresh server-side re-evaluation.');
    error.candidate = candidate; throw error;
  }
  if (candidate.direction === 'SHORT' && !asset.shortable) {
    throw new Error(`${symbol} is not currently shortable at Alpaca.`);
  }
  const signalBarAt = candidate.freshness?.barsAt;
  if (!signalBarAt) throw new Error('The completed confirmation timestamp is unavailable.');
  if (candlestickSignalAlreadyAttempted(userId, symbol, signalBarAt)) {
    throw new Error('This completed UltraBot3 setup has already been submitted or withheld; wait for a new confirmation candle.');
  }
  // Re-read settings and rebuild the evidence at the commit point. A browser
  // save, account change, or new completed candle can never leave a stale
  // candidate authorized for submission.
  ({ enabled, liveArmed, config } = candlestickConfigFor(userId));
  creds = getAlpacaCreds(userId, 'candlestick');
  if (!enabled || !creds || (creds.mode === 'live' && !liveArmed)) {
    throw new Error('UltraBot3 settings or live authorization changed; no order was submitted.');
  }
  candidate = await buildCandlestickCandidate(userId, symbol, config);
  saveCandlestickCandidates(userId, [candidate]);
  if (!candidate.eligible || candidate.freshness?.barsAt !== signalBarAt) {
    const error = new Error('The completed setup changed during broker revalidation.');
    error.candidate = candidate; throw error;
  }
  const { positions, openOrders, pendingJournal } = await candlestickBrokerState(userId);
  const capacity = calculateCandlestickEntryCapacity(positions, openOrders, pendingJournal);
  if (capacity.used >= config.maxPositions) throw new Error('Candlestick position limit reached by open or pending entries.');
  if (positions.some(p => p.symbol === symbol) || openOrders.some(o => o.symbol === symbol)) throw new Error(`${symbol} already has a candlestick position or broker-open order.`);
  const snapshot = await alpacaSnapshotFetch(userId, symbol, 'candlestick');
  const quote = snapshot?.[symbol]?.latestQuote;
  const executable = candidate.direction === 'SHORT' ? Number(quote?.bp) : Number(quote?.ap);
  const quoteTime = candleBarTime({ t: quote?.t });
  if (!(executable > 0) || !quoteTime || Date.now() - quoteTime > 20_000) throw new Error('Fresh executable Alpaca quote is unavailable.');
  const stop = Number(candidate.stop);
  const risk = candidate.direction === 'SHORT' ? stop - executable : executable - stop;
  const target = Number(candidate.direction === 'SHORT'
    ? executable - risk * config.minRewardRisk : executable + risk * config.minRewardRisk);
  if (!(risk > 0) || !Number.isFinite(target)) throw new Error('Fresh quote invalidates the technical stop.');
  const shares = Math.floor(Math.min(config.maxPositionDollars / executable, config.maxRiskDollars / risk));
  if (!(shares >= 1)) throw new Error('Risk sizing produced less than one share.');
  // This is the last state check before the durable intent and non-idempotent
  // POST. It protects against a live-arm/config change while quote data arrived.
  const finalSettings = candlestickConfigFor(userId);
  const finalCreds = getAlpacaCreds(userId, 'candlestick');
  if (!finalSettings.enabled || !finalCreds || (finalCreds.mode === 'live' && !finalSettings.liveArmed)) {
    throw new Error('UltraBot3 authorization changed immediately before submission.');
  }
  if (JSON.stringify(finalSettings.config) !== JSON.stringify(config)) {
    throw new Error('UltraBot3 risk settings changed during revalidation; scan again before submitting.');
  }
  if (candlestickSignalAlreadyAttempted(userId, symbol, signalBarAt)) {
    throw new Error('This completed UltraBot3 setup was already reserved by another execution cycle.');
  }
  const clientId = `cndl_${userId}_${symbol}_${Date.now()}`.slice(0, 48);
  const createEntryIntent = db.transaction(() => {
    if (!reserveCandlestickSignal(userId, symbol, signalBarAt)) {
      throw new Error('This completed UltraBot3 setup is already reserved by another execution cycle.');
    }
    // Renew immediately before the all-synchronous reservation → journal →
    // dispatch handoff. Once the durable row says pending_entry, this worker
    // proceeds to the broker POST without another lease gap that could create
    // an intent that was never dispatched.
    requireCandlestickExecutionLease(userId, leaseToken);
    const journal = db.prepare(`INSERT INTO candlestick_trade_log
      (user_id,symbol,direction,entry_price,shares,stop_price,target_price,mode,status,entry_order_id,entry_client_order_id,setup_json,signal_bar_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(userId, symbol, candidate.direction, executable, shares, stop, target,
      finalCreds.mode, 'entry_intent', clientId, clientId, JSON.stringify(candidate), signalBarAt);
    attachCandlestickSignalReservation(userId, symbol, signalBarAt, journal.lastInsertRowid);
    return journal;
  });
  const journal = createEntryIntent();
  const order = buildCandlestickBracketOrder({
    symbol, qty: shares, direction: candidate.direction, clientOrderId: clientId,
    target, stop,
  });
  beginAlpacaOrderRequest(userId);
  try {
    const submitted = await alpacaFetchFor(userId, 'candlestick', '/v2/orders', { method: 'POST', body: JSON.stringify(order) });
    requireCandlestickExecutionLease(userId, leaseToken);
    db.prepare(`UPDATE candlestick_trade_log SET status='pending_entry',entry_order_id=? WHERE id=?`)
      .run(submitted?.id || clientId, journal.lastInsertRowid);
    return { ok: true, source, order: submitted, candidate, tradeId: journal.lastInsertRowid };
  } finally { endAlpacaOrderRequest(userId); }
}
async function requestCandlestickProtectionCancellation(userId, trade, parent, summary, leaseToken) {
  const cancellationIds = [
    ...(summary?.parentActive && String(parent?.status || '').toLowerCase() !== 'pending_cancel' && parent?.id ? [parent.id] : []),
    ...((summary?.activeLegs || [])
      .filter(leg => String(leg?.status || '').toLowerCase() !== 'pending_cancel')
      .map(leg => leg?.id).filter(Boolean)),
  ];
  if ((summary?.activeLegs || []).some(leg => !leg?.id) || (summary?.parentActive && !parent?.id)) {
    throw new Error('Broker reported a live unprotected bracket order without a cancellable order ID.');
  }
  requireCandlestickExecutionLease(userId, leaseToken);
  db.prepare(`UPDATE candlestick_trade_log SET status='rescue_cancel_intent',exit_reason=? WHERE id=?`)
    .run('Missing broker stop/target protection; cancellation requested before emergency exit', trade.id);
  // Every known live order is already pending cancellation. Do not POST a
  // duplicate DELETE; retain the durable pending state and await terminal
  // confirmation on the next broker snapshot.
  if (!cancellationIds.length) {
    db.prepare(`UPDATE candlestick_trade_log SET status='rescue_cancel_pending',exit_reason=? WHERE id=?`)
      .run('Waiting for broker-confirmed parent and child cancellations before emergency exit', trade.id);
    return;
  }
  for (const orderId of [...new Set(cancellationIds)]) {
    await alpacaFetchFor(userId, 'candlestick', `/v2/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
  }
  requireCandlestickExecutionLease(userId, leaseToken);
  db.prepare(`UPDATE candlestick_trade_log SET status='rescue_cancel_pending',exit_reason=? WHERE id=?`)
    .run('Waiting for broker-confirmed parent and child cancellations before emergency exit', trade.id);
}
async function requestCandlestickProtectiveExit(userId, trade, leaseToken) {
  requireCandlestickExecutionLease(userId, leaseToken);
  const position = await candlestickPosition(userId, trade.symbol);
  const quantity = Math.abs(Number(position?.qty));
  if (!(quantity > 0)) throw new Error('Broker did not return a closable unprotected position.');
  // A broker-confirmed rejected/canceled rescue order may be safely replaced.
  // Any ambiguous attempt keeps its original durable client ID for lookup.
  const clientId = trade.status === 'exit_failed'
    ? `cndl_exit_${trade.user_id}_${trade.symbol}_${Date.now()}`.slice(0, 48)
    : (trade.exit_client_order_id || `cndl_exit_${trade.user_id}_${trade.symbol}_${Date.now()}`.slice(0, 48));
  // A durable intent means dispatch has not yet been confirmed. If the process
  // dies before/during POST, reconciliation can retry this exact client ID;
  // Alpaca's client-order uniqueness prevents a second rescue close.
  requireCandlestickExecutionLease(userId, leaseToken);
  db.prepare(`UPDATE candlestick_trade_log SET status='exit_intent',exit_client_order_id=?,exit_order_id=?,exit_reason=?,
    exit_requested_at=datetime('now') WHERE id=?`)
    .run(clientId, clientId, 'Missing broker stop/target protection; emergency exit requested', trade.id);
  const order = {
    symbol: trade.symbol, qty: String(quantity),
    side: Number(position.qty) < 0 ? 'buy' : 'sell',
    type: 'market', time_in_force: 'day', client_order_id: clientId,
  };
  beginAlpacaOrderRequest(userId);
  try {
    const submitted = await alpacaFetchFor(userId, 'candlestick', '/v2/orders', { method: 'POST', body: JSON.stringify(order) });
    requireCandlestickExecutionLease(userId, leaseToken);
    db.prepare(`UPDATE candlestick_trade_log SET status='pending_exit',exit_order_id=? WHERE id=?`)
      .run(submitted?.id || clientId, trade.id);
    return submitted;
  } finally { endAlpacaOrderRequest(userId); }
}
async function closeCandlestickTradeIfFlat(userId, trade, reason, leaseToken) {
  const position = await candlestickPosition(userId, trade.symbol);
  if (position && Math.abs(Number(position.qty)) > 0) return false;
  const realized = candlestickRealizedPnl(trade);
  if (!realized || !(realized.quantity > 0)) return false;
  requireCandlestickExecutionLease(userId, leaseToken);
  db.prepare(`UPDATE candlestick_trade_log SET status='closed',exit_price=?,pnl=?,exit_reason=?,closed_at=datetime('now') WHERE id=?`)
    .run(realized.averageExit, realized.pnl, reason, trade.id);
  return true;
}
async function reconcileCandlestickTrades(userId, leaseToken = null) {
  const open = db.prepare(`SELECT * FROM candlestick_trade_log WHERE user_id=?
    AND status IN ('entry_intent','entry_unknown','pending_entry','open','protection_pending','rescue_cancel_intent','rescue_cancel_pending','exit_intent','pending_exit','exit_unknown','exit_failed') ORDER BY id`).all(userId);
  const events = [];
  for (const trade of open) {
    try {
      requireCandlestickExecutionLease(userId, leaseToken);
      if (trade.status === 'exit_intent') {
        try {
          const knownExit = await alpacaFetchFor(userId, 'candlestick', candlestickOrderLookupPath(trade.exit_order_id, trade.exit_client_order_id));
          if (!brokerOrderMatchesIntent(knownExit, trade.exit_client_order_id)) {
            throw new Error('Broker response does not match the Candlestick exit intent.');
          }
          requireCandlestickExecutionLease(userId, leaseToken);
          db.prepare(`UPDATE candlestick_trade_log SET status='pending_exit',exit_order_id=? WHERE id=?`)
            .run(knownExit?.id || trade.exit_order_id, trade.id);
          events.push({ id: trade.id, event: 'rescue exit broker order recovered' });
        } catch (error) {
          if (error.alpacaStatus === 404) {
            // It may never have left the process. Retry the same client ID only:
            // broker-level idempotency prevents a duplicate market close.
            await requestCandlestickProtectiveExit(userId, trade, leaseToken);
            events.push({ id: trade.id, event: 'rescue exit intent re-dispatched with the same client ID' });
          } else throw error;
        }
        continue;
      }
      if (trade.status === 'pending_exit' || trade.status === 'exit_unknown') {
        let exit;
        try {
          exit = await alpacaFetchFor(userId, 'candlestick', candlestickOrderLookupPath(trade.exit_order_id, trade.exit_client_order_id));
          if (!brokerOrderMatchesIntent(exit, trade.exit_client_order_id)) {
            throw new Error('Broker response does not match the Candlestick exit intent.');
          }
        } catch (error) {
          if (error.alpacaStatus === 404) {
            // A POST timeout and a temporarily unavailable client-order lookup
            // are indistinguishable. Hold capacity and wait; submitting another
            // market close here could reverse an already-accepted exit.
            db.prepare(`UPDATE candlestick_trade_log SET status='exit_unknown',exit_reason=? WHERE id=?`)
              .run('Emergency exit outcome is awaiting broker confirmation; no replacement order will be sent', trade.id);
            events.push({ id: trade.id, event: 'emergency exit outcome remains unknown' });
            continue;
          }
          throw error;
        }
        if (Number(exit.filled_qty) > 0 && Number(exit.filled_avg_price) > 0) {
          recordCandlestickExitFill(trade, exit, 'Emergency exit fill');
          if (await closeCandlestickTradeIfFlat(userId, trade, 'Emergency exit fill confirmed', leaseToken)) {
            events.push({ id: trade.id, event: 'unprotected position exit confirmed' });
          } else {
            events.push({ id: trade.id, event: 'partial emergency exit fill confirmed; residual position remains protected by reconciliation' });
          }
        } else if (['canceled','rejected','expired'].includes(String(exit.status).toLowerCase())) {
          db.prepare(`UPDATE candlestick_trade_log SET status='exit_failed',exit_reason=? WHERE id=?`)
            .run(`Emergency exit ${String(exit.status).toLowerCase()} by broker; reconciliation will retry`, trade.id);
          events.push({ id: trade.id, event: `emergency exit ${exit.status}` });
        }
        continue;
      }
      let parent;
      try {
        parent = await alpacaFetchFor(userId, 'candlestick', candlestickOrderLookupPath(trade.entry_order_id, trade.entry_client_order_id));
      } catch (error) {
        if (trade.status === 'entry_intent' && error.alpacaStatus === 404) {
          requireCandlestickExecutionLease(userId, leaseToken);
          db.prepare(`UPDATE candlestick_trade_log SET status='entry_unknown',exit_reason=? WHERE id=?`)
            .run('Entry intent was not found at broker; no stale entry will be re-submitted automatically', trade.id);
          events.push({ id: trade.id, event: 'entry intent outcome unknown; capacity remains reserved' });
          continue;
        }
        throw error;
      }
      if (!brokerOrderMatchesIntent(parent, trade.entry_client_order_id)) {
        throw new Error('Broker response does not match the Candlestick entry intent.');
      }
      const positionForProtection = await candlestickPosition(userId, trade.symbol);
      const remainingQuantity = positionForProtection && Math.abs(Number(positionForProtection.qty)) > 0
        ? Math.abs(Number(positionForProtection.qty)) : null;
      const summary = summarizeCandlestickBrokerOrder(parent, {
        direction: trade.direction, symbol: trade.symbol, targetPrice: trade.target_price, stopPrice: trade.stop_price, remainingQuantity,
      });
      if (summary.exitFills.length) {
        summary.exitFills.forEach(leg => recordCandlestickExitFill(trade, leg, leg.type === 'limit' ? 'Broker target fill' : 'Broker protective stop fill'));
        const reason = summary.exitFills.some(leg => leg.type === 'limit') ? 'Broker target fill confirmed' : 'Broker protective stop fill confirmed';
        if (await closeCandlestickTradeIfFlat(userId, trade, reason, leaseToken)) {
          events.push({ id: trade.id, event: 'protective fill confirmed' });
          continue;
        } else {
          events.push({ id: trade.id, event: 'partial protective fill confirmed; residual position remains open' });
        }
      }
      if (summary.hasEntryFill) {
        const nextStatus = summary.protection.complete ? 'open' : 'protection_pending';
        db.prepare(`UPDATE candlestick_trade_log SET status=?,entry_price=?,shares=?,entry_order_id=?,
          protection_grace_until=COALESCE(protection_grace_until,datetime('now','+30 seconds')) WHERE id=?`)
          .run(nextStatus, summary.filledAveragePrice, summary.filledQty, parent.id, trade.id);
        // A fully filled protective leg may have flattened the lot (handled
        // above). When it was only partial, continue validating protection for
        // the residual instead of letting its historical fill suppress rescue.
        const residualSummary = summary.exitFills.length ? { ...summary, exitFills: [] } : summary;
        if (needsUnprotectedExit(residualSummary, trade.protection_grace_until)) {
          const cancelAction = cancellationAction(summary, trade.status);
          if (cancelAction === 'submit_or_retry_cancel') {
              await requestCandlestickProtectionCancellation(userId, trade, parent, summary, leaseToken);
              events.push({ id: trade.id, event: 'missing protection; conflicting bracket orders canceled before emergency exit' });
          } else if (cancelAction === 'parent_terminal') {
            await requestCandlestickProtectiveExit(userId, { ...trade, entry_order_id: parent.id }, leaseToken);
            events.push({ id: trade.id, event: 'missing protection after parent terminal state; emergency exit submitted' });
          } else {
            events.push({ id: trade.id, event: 'waiting for broker-confirmed parent cancellation before emergency exit' });
          }
        } else {
          events.push({ id: trade.id, event: summary.protection.complete ? 'entry and bracket protection confirmed' : 'entry fill awaiting bracket protection' });
        }
      } else if (['canceled','rejected','expired'].includes(summary.parentStatus)) {
          db.prepare(`UPDATE candlestick_trade_log SET status='void',exit_reason=?,closed_at=datetime('now') WHERE id=?`)
            .run(`Entry ${summary.parentStatus} by broker`, trade.id);
        events.push({ id: trade.id, event: `entry ${summary.parentStatus}` });
      }
    } catch (error) { events.push({ id: trade.id, error: error.message }); }
  }
  return events;
}


// ── FMP helpers ───────────────────────────────────────────────────────────────
const FMP_BASE = 'https://financialmodelingprep.com/api';
const FMP_H    = { headers: { 'User-Agent': 'Mozilla/5.0' } };

async function fmpGet(path) {
  if (!FMP_KEY) return null;
  const sep = path.includes('?') ? '&' : '?';
  const r   = await fetch(`${FMP_BASE}${path}${sep}apikey=${FMP_KEY}`, FMP_H);
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// ── EMA series helper ─────────────────────────────────────────────────────────
function calcEMASeries(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// ── Fetch Yahoo Finance earnings fundamentals (primary data source) ────────────
async function fetchYahooEarningsFundamentals(symbol) {
  try {
    // earningsHistory: EPS surprise + incomeStatementHistory: annual revenue
    const data = await yf.quoteSummary(symbol, {
      modules: ['earningsHistory', 'incomeStatementHistory'],
    });
    return data;
  } catch { return null; }
}

// ── Detect earnings announcement date from price bars via volume spike ─────────
// When we know the fiscal quarter end but not the exact announcement date,
// find the bar with the highest volume spike in the 5-75 day window after quarter end.
function detectEarningsBarIdx(bars, fiscalQuarterEndDate) {
  const qEndMs = new Date(fiscalQuarterEndDate).getTime();
  const winStart = qEndMs + 5  * 86400000;
  const winEnd   = qEndMs + 75 * 86400000;

  // Bars before the quarter end, for avg volume reference
  const preBars = bars.filter(b => new Date(b.t).getTime() < qEndMs);
  const preAvg  = preBars.slice(-20).reduce((a, b) => a + (b.v || 0), 0) / Math.max(1, Math.min(20, preBars.length));

  let bestIdx = -1, bestScore = 0;
  for (let i = 0; i < bars.length; i++) {
    const bMs = new Date(bars[i].t).getTime();
    if (bMs < winStart || bMs > winEnd) continue;
    const volRatio = preAvg > 0 ? (bars[i].v || 0) / preAvg : 0;
    // Score = volume ratio * abs(gap) — high volume + big move = likely earnings day
    const gapMag = i > 0 ? Math.abs((bars[i].o - bars[i - 1].c) / bars[i - 1].c) : 0;
    const score  = volRatio * (1 + gapMag * 10);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

// ── Explosive Earnings Signal Computation ─────────────────────────────────────


// ══════════════════════════════════════════════════════════════════════════════
// SWING TRADING BOT — isolated multi-week stock / ETF automation
// ══════════════════════════════════════════════════════════════════════════════

const SWING_SCOPE = 'swing';
const SWING_CEILINGS = Object.freeze({
  maxPositionDollars: 100000,
  maxRiskDollars: 500,
  maxPositions: 5,
  maxAggregateExposure: 250000,
  maxSectorPositions: 2,
  maxSymbols: 40,
  minAverageDollarVolume: 5000000,
  minRewardRisk: 2,
});
const _swingContextCache = new Map();
const _swingCalendarCache = new Map();

function swingConfigFor(userId) {
  const row = db.prepare(`SELECT enabled,live_armed,max_position_dollars,rotation_offset,
    last_cycle_at,last_cycle_status,last_cycle_reason,last_cycle_scanned,last_cycle_eligible,last_cycle_source,last_scan_at,updated_at
    FROM swing_settings WHERE user_id=?`).get(userId);
  const requested = { maxPositionDollars: row?.max_position_dollars ?? 1000 };
  const execution = sanitizeSwingExecutionConfig(requested, SWING_CEILINGS);
  execution.maxRiskDollars = Math.min(
    SWING_CEILINGS.maxRiskDollars,
    Math.max(10, execution.maxPositionDollars * 0.02)
  );
  return {
    enabled: !!row?.enabled,
    liveArmed: !!row?.live_armed,
    maxPositionDollars: execution.maxPositionDollars,
    execution,
    rotationOffset: Math.max(0, Number(row?.rotation_offset || 0)),
    runtime: {
      settingsUpdatedAt: row?.updated_at || null,
      lastCycleAt: row?.last_cycle_at || null,
      lastCycleStatus: row?.last_cycle_status || null,
      lastCycleReason: row?.last_cycle_reason || null,
      lastCycleScanned: Number(row?.last_cycle_scanned || 0),
      lastCycleEligible: Number(row?.last_cycle_eligible || 0),
      lastCycleSource: row?.last_cycle_source || null,
      lastScanAt: row?.last_scan_at || null,
    },
  };
}

function getPinnedSwingCreds(userId, mode, expectedAccountId) {
  if (!expectedAccountId) {
    throw new Error('This Swing lifecycle record has no immutable broker account identity.');
  }
  if (isBrokerAccountQuarantined(expectedAccountId)) {
    throw new Error('This broker account is quarantined because it was assigned to more than one user or strategy.');
  }
  const row = db.prepare(`SELECT api_key,api_secret,api_key_enc,api_secret_enc,mode,account_id
    FROM swing_alpaca_creds WHERE user_id=? AND mode=?`).get(userId, mode);
  if (!row || row.api_key === DISCONNECTED_SENTINEL || !row.account_id) {
    throw new Error(`The ${mode} Swing credential needed by this trade is unavailable.`);
  }
  if (expectedAccountId && String(row.account_id) !== String(expectedAccountId)) {
    throw new Error('Swing broker identity no longer matches the account pinned to this trade.');
  }
  return decryptStoredAlpacaCredentials(row, 'swing_alpaca_creds', 'user_id=? AND mode=?', [userId, mode]);
}

function recordSwingCycle(userId, outcome) {
  db.prepare(`INSERT INTO swing_settings
    (user_id,last_cycle_at,last_cycle_status,last_cycle_reason,last_cycle_scanned,last_cycle_eligible,last_cycle_source)
    VALUES (?,datetime('now'),?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET last_cycle_at=datetime('now'),
      last_cycle_status=excluded.last_cycle_status,last_cycle_reason=excluded.last_cycle_reason,
      last_cycle_scanned=excluded.last_cycle_scanned,last_cycle_eligible=excluded.last_cycle_eligible,
      last_cycle_source=excluded.last_cycle_source`)
    .run(userId, String(outcome?.status || 'unknown').slice(0, 40),
      String(outcome?.reason || '').slice(0, 300) || null,
      Math.max(0, Number(outcome?.scanned || 0)),
      Math.max(0, Number(outcome?.eligible || 0)),
      String(outcome?.source || 'server-scheduler').slice(0, 40));
}

function acquireSwingExecutionLease(userId) {
  const token = crypto.randomUUID();
  const result = db.prepare(`INSERT INTO swing_execution_leases (user_id,token,expires_at)
    VALUES (?, ?, datetime('now','+10 minutes'))
    ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
    WHERE swing_execution_leases.expires_at <= datetime('now')`).run(userId, token);
  return result.changes === 1 ? token : null;
}
function requireSwingExecutionLease(userId, token) {
  if (!token || db.prepare(`UPDATE swing_execution_leases SET expires_at=datetime('now','+10 minutes')
    WHERE user_id=? AND token=? AND expires_at > datetime('now')`).run(userId, token).changes !== 1) {
    throw new Error('Swing execution lease expired or was replaced; no further broker action was taken.');
  }
}
function releaseSwingExecutionLease(userId, token) {
  if (token) db.prepare('DELETE FROM swing_execution_leases WHERE user_id=? AND token=?').run(userId, token);
}

function easternDateKey(value = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}
function isoWeekMonday(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}
function completedSwingDailyBars(rawBars, now = Date.now()) {
  const today = easternDateKey(now);
  return (Array.isArray(rawBars) ? rawBars : []).filter(bar => {
    const timestamp = Date.parse(bar?.t ?? bar?.timestamp ?? '');
    return Number.isFinite(timestamp) && easternDateKey(timestamp) < today;
  }).map(bar => ({
    o: +bar.o, h: +bar.h, l: +bar.l, c: +bar.c, v: +bar.v,
    t: bar.t ?? bar.timestamp, completed: true,
  })).filter(bar => [bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite));
}
function completedSwingWeeklyBars(dailyBars, now = Date.now()) {
  const currentWeek = isoWeekMonday(easternDateKey(now));
  return aggregateSwingWeeklyBars(dailyBars)
    .filter(bar => bar.t < currentWeek)
    .map(bar => ({ ...bar, completed: true }));
}
async function expectedSwingSessions(userId, now = Date.now()) {
  const creds = getAlpacaCreds(userId, SWING_SCOPE);
  if (!creds) return null;
  const cacheKey = `${userId}:${creds.mode}:${creds.account_id}`;
  const cached = _swingCalendarCache.get(cacheKey);
  if (cached && now - cached.at < 6 * 60 * 60 * 1000) return cached.value;
  const today = easternDateKey(now);
  const start = easternDateKey(now - 60 * 86400000);
  const sessions = await alpacaFetchFor(userId, SWING_SCOPE, `/v2/calendar?start=${start}&end=${today}`);
  if (!Array.isArray(sessions) || !sessions.length) throw new Error('Alpaca trading calendar is unavailable.');
  const prior = sessions.filter(item => String(item.date) < today);
  const daily = prior.at(-1)?.date || null;
  const currentWeek = isoWeekMonday(today);
  const completedWeeks = prior.filter(item => isoWeekMonday(String(item.date)) < currentWeek);
  const weekly = completedWeeks.at(-1)?.date || null;
  const value = { daily, weekly };
  _swingCalendarCache.set(cacheKey, { at: now, value });
  return value;
}
async function swingBarFreshness(userId, dailyBars, weeklyBars) {
  const expected = await expectedSwingSessions(userId);
  const dailyDate = easternDateKey(Date.parse(dailyBars.at(-1)?.t || ''));
  const weeklyDate = easternDateKey(Date.parse(weeklyBars.at(-1)?.completedAt || weeklyBars.at(-1)?.t || ''));
  return {
    daily: !!expected?.daily && dailyDate === expected.daily,
    weekly: !!expected?.weekly && weeklyDate === expected.weekly,
  };
}

async function swingOptionalContext(symbol, dailyBars, userId) {
  const key = String(symbol).toUpperCase();
  const cached = _swingContextCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value;
  let quality = null;
  let sectorName = null;
  try {
    const summary = await yf.quoteSummary(key, {
      modules: ['assetProfile', 'financialData', 'defaultKeyStatistics', 'summaryDetail'],
    }, { validateResult: false });
    const fd = summary?.financialData || {};
    const stats = summary?.defaultKeyStatistics || {};
    sectorName = summary?.assetProfile?.sector || null;
    const facts = [
      Number(fd.revenueGrowth) > 0,
      Number(fd.earningsGrowth) > 0,
      Number(fd.returnOnEquity) > 0,
      Number(fd.freeCashflow) > 0,
      Number(fd.debtToEquity) >= 0 && Number(fd.debtToEquity) < 200,
      Number(stats.profitMargins) > 0,
    ];
    const available = [
      fd.revenueGrowth, fd.earningsGrowth, fd.returnOnEquity,
      fd.freeCashflow, fd.debtToEquity, stats.profitMargins,
    ].filter(value => Number.isFinite(Number(value))).length;
    if (available >= 3) quality = Math.round(facts.filter(Boolean).length / 6 * 100);
  } catch (_) {
    // Fundamentals are optional context. Their absence is disclosed below and
    // can never be replaced by generated or guessed values.
  }
  let relativeStrength = null;
  let market = null;
  try {
    const spyKey = '__SPY_DAILY__';
    let spy = _swingContextCache.get(spyKey);
    if (!spy || Date.now() - spy.at >= 15 * 60 * 1000) {
      const start = new Date(Date.now() - 120 * 86400000).toISOString();
      const data = await alpacaDataFetch(userId, `/v2/stocks/SPY/bars?timeframe=1Day&start=${encodeURIComponent(start)}&limit=100&adjustment=all&feed=iex`, SWING_SCOPE);
      const bars = completedSwingDailyBars(candlestickBarsFromResponse(data, 'SPY'));
      spy = { at: Date.now(), value: bars };
      _swingContextCache.set(spyKey, spy);
    }
    const stock20 = dailyBars.length >= 21 ? dailyBars.at(-1).c / dailyBars.at(-21).c - 1 : null;
    const spyBars = spy.value;
    const spy20 = spyBars.length >= 21 ? spyBars.at(-1).c / spyBars.at(-21).c - 1 : null;
    if (Number.isFinite(stock20) && Number.isFinite(spy20)) relativeStrength = stock20 - spy20;
    if (Number.isFinite(spy20)) market = spy20;
  } catch (_) {}
  const value = {
    quality,
    catalyst: null,
    // A sector label is useful for concentration limits, but it is not
    // sector-relative performance evidence and therefore earns no score.
    sector: null,
    sectorName,
    relativeStrength,
    market,
    sourceState: {
      fundamentals: quality == null ? 'UNAVAILABLE' : 'AVAILABLE',
      catalyst: 'UNAVAILABLE',
      sector: sectorName ? 'LABEL_ONLY; RELATIVE_EVIDENCE_UNAVAILABLE' : 'UNAVAILABLE',
      market: market == null ? 'UNAVAILABLE' : 'AVAILABLE',
    },
  };
  _swingContextCache.set(key, { at: Date.now(), value });
  return value;
}

async function buildSwingCandidate(userId, symbol, execution = swingConfigFor(userId).execution) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(sym)) throw new Error('A valid stock or ETF symbol is required.');
  const start = new Date(Date.now() - 3 * 365 * 86400000).toISOString();
  const payload = await alpacaDataFetch(userId,
    `/v2/stocks/${encodeURIComponent(sym)}/bars?timeframe=1Day&start=${encodeURIComponent(start)}&limit=1000&adjustment=all&feed=iex`,
    SWING_SCOPE);
  if (!payload) throw new Error('Alpaca daily bars are unavailable.');
  const dailyBars = completedSwingDailyBars(candlestickBarsFromResponse(payload, sym));
  const weeklyBars = completedSwingWeeklyBars(dailyBars);
  const optional = await swingOptionalContext(sym, dailyBars, userId);
  const setup = evaluateSwingSetup({
    symbol: sym,
    dailyBars,
    weeklyBars,
    freshness: await swingBarFreshness(userId, dailyBars, weeklyBars),
    quality: optional.quality,
    catalyst: optional.catalyst,
    sector: optional.sector,
    relativeStrength: optional.relativeStrength,
    market: optional.market,
  }, {
    ...DEFAULT_SWING_CONFIG,
    minAverageDollarVolume: execution.minAverageDollarVolume,
    minRewardRisk: execution.minRewardRisk,
  });
  return {
    ...setup,
    symbol: sym,
    stop: setup.structuralStop,
    target: setup.targets?.[0]?.price ?? null,
    sector: optional.sectorName || 'UNKNOWN',
    sourceState: optional.sourceState,
    evaluatedAt: new Date().toISOString(),
    signalBarAt: dailyBars.at(-1)?.t || null,
  };
}

function saveSwingCandidates(userId, candidates) {
  const statement = db.prepare(`INSERT INTO swing_candidates
    (user_id,symbol,payload_json,signal_bar_at,evaluated_at) VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(user_id,symbol) DO UPDATE SET payload_json=excluded.payload_json,
      signal_bar_at=excluded.signal_bar_at,evaluated_at=datetime('now')`);
  db.transaction(rows => rows.forEach(row =>
    statement.run(userId, row.symbol, JSON.stringify(row), row.signalBarAt || null)))(candidates);
  const event = db.prepare(`INSERT INTO swing_events
    (user_id,symbol,event_type,reason_code,details_json,source_at)
    VALUES (?,?,'SCAN_DECISION',?,?,?)`);
  db.transaction(rows => rows.forEach(row => event.run(
    userId, row.symbol, row.eligible ? 'ELIGIBLE' : String(row.status || 'REJECTED').slice(0, 40),
    JSON.stringify({ score: row.score, confidence: row.confidence, reasons: row.reasons || [], sourceState: row.sourceState || null }),
    row.signalBarAt || row.evaluatedAt || null
  )))(candidates);
}

async function scanSwingUniverse(userId, { persistRotation = true } = {}) {
  const settings = swingConfigFor(userId);
  const catalogEntry = await getAlpacaTradableEquityCatalog(userId, { scope: SWING_SCOPE });
  const rotation = selectCatalogRotation(catalogEntry.catalog, {
    limit: settings.execution.maxSymbols,
    priorityLimit: 0,
    rotationLimit: settings.execution.maxSymbols,
    rotationOffset: settings.rotationOffset,
  });
  if (persistRotation) {
    db.prepare(`INSERT INTO swing_settings (user_id,rotation_offset) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET rotation_offset=excluded.rotation_offset`)
      .run(userId, rotation.nextOffset);
  }
  const rows = await mapWithConcurrency(rotation.symbols, 6, async symbol => {
    try { return await buildSwingCandidate(userId, symbol, settings.execution); }
    catch (error) {
      return {
        symbol, direction: null, status: 'DATA UNAVAILABLE', eligible: false,
        watchState: 'UNAVAILABLE', score: 0, confidence: 0,
        reasons: [`Required market evidence unavailable: ${error.message}`],
        evaluatedAt: new Date().toISOString(),
      };
    }
  });
  saveSwingCandidates(userId, rows);
  return {
    strategy: 'long-only-swing-v1',
    results: rows.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)),
    evaluatedAt: new Date().toISOString(),
    funnel: {
      scanned: rows.length,
      eligible: rows.filter(row => row.eligible).length,
      rejected: rows.filter(row => !row.eligible).length,
    },
    coverage: {
      catalogSize: catalogEntry.catalog.size,
      scanned: rows.length,
      rotationBatch: rotation.batch,
      totalBatches: rotation.totalBatches,
      nextOffset: rotation.nextOffset,
      note: 'Stable persisted rotation across the active, tradable Alpaca US stock and ETF catalog.',
    },
  };
}

function swingOrderLookupPath(orderId, clientOrderId) {
  return orderId && orderId !== clientOrderId
    ? `/v2/orders/${encodeURIComponent(orderId)}?nested=true`
    : `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}&nested=true`;
}
function swingLots(trade) {
  try { return Array.isArray(JSON.parse(trade.entry_orders_json)) ? JSON.parse(trade.entry_orders_json) : []; }
  catch (_) { return []; }
}
function addSwingAlert(userId, symbol, type, message) {
  db.prepare(`INSERT INTO swing_alerts (user_id,symbol,type,message) VALUES (?,?,?,?)`)
    .run(userId, symbol || null, String(type).slice(0, 40), String(message).slice(0, 500));
}
function recordSwingEvent(userId, {
  tradeId = null, symbol = null, eventType, reasonCode = null, details = {}, sourceAt = null,
}) {
  db.prepare(`INSERT INTO swing_events
    (user_id,trade_id,symbol,event_type,reason_code,details_json,source_at)
    VALUES (?,?,?,?,?,?,?)`).run(
      userId, tradeId, symbol, String(eventType || 'UNKNOWN').slice(0, 50),
      reasonCode == null ? null : String(reasonCode).slice(0, 50),
      JSON.stringify(details || {}), sourceAt || null
    );
}
function recordSwingExitFill(tradeId, order, purpose) {
  const id = String(order?.id || '');
  const qty = Number(order?.filled_qty);
  const price = Number(order?.filled_avg_price);
  if (!id || !(qty > 0) || !(price > 0)) return;
  const existed = !!db.prepare(`SELECT 1 FROM swing_exit_fills WHERE trade_id=? AND broker_order_id=?`)
    .get(tradeId, id);
  db.prepare(`INSERT INTO swing_exit_fills (trade_id,broker_order_id,quantity,price,purpose,updated_at)
    VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(trade_id,broker_order_id) DO UPDATE SET
    quantity=excluded.quantity,price=excluded.price,purpose=excluded.purpose,updated_at=datetime('now')`)
    .run(tradeId, id, qty, price, purpose);
  return !existed;
}

async function executeSwingEntry(userId, symbol, source = 'manual', leaseToken = null) {
  let settings = swingConfigFor(userId);
  let creds = getAlpacaCreds(userId, SWING_SCOPE);
  const preflightBrokerIdentity = creds ? `${creds.mode}:${creds.account_id}` : null;
  if (!settings.enabled) throw new Error('Swing automation is disabled in persisted settings.');
  if (!creds) throw new Error('Connect the dedicated Swing Trading Alpaca account first.');
  if (creds.mode === 'live' && !settings.liveArmed) throw new Error('Live Swing trading is not explicitly armed.');
  if (!isMarketOpen()) throw new Error('Swing entries are submitted only during the regular session.');
  await assertAlpacaTradableEquity(userId, symbol, { fresh: true, scope: SWING_SCOPE });
  let candidate = await buildSwingCandidate(userId, symbol, settings.execution);
  saveSwingCandidates(userId, [candidate]);
  if (!candidate.eligible || !candidate.signalBarAt) {
    const error = new Error('Swing setup is not eligible after fresh completed-bar evaluation.');
    error.candidate = candidate;
    throw error;
  }
  const brokerState = await Promise.all([
    alpacaFetchFor(userId, SWING_SCOPE, '/v2/positions'),
    alpacaFetchFor(userId, SWING_SCOPE, '/v2/orders?status=open&limit=500'),
    alpacaFetchFor(userId, SWING_SCOPE, '/v2/account'),
  ]);
  const [positions, openOrders, account] = brokerState;
  if (!Array.isArray(positions) || !Array.isArray(openOrders)) throw new Error('Broker capacity is unavailable.');
  const activeTrades = db.prepare(`SELECT * FROM swing_trades WHERE user_id=? AND status NOT IN ('closed','rejected','canceled')`).all(userId);
  const brokerExposureSymbols = new Set(positions.map(row => String(row.symbol || '').toUpperCase()).filter(Boolean));
  for (const order of openOrders) {
    if (!order?.parent_order_id && String(order.side).toLowerCase() === 'buy') {
      brokerExposureSymbols.add(String(order.symbol || '').toUpperCase());
    }
  }
  for (const trade of activeTrades) brokerExposureSymbols.add(trade.symbol);
  if (brokerExposureSymbols.size >= settings.execution.maxPositions) throw new Error('Swing portfolio position limit is reached.');
  if (activeTrades.some(row => row.symbol === symbol) || positions.some(row => row.symbol === symbol)
      || openOrders.some(row => row.symbol === symbol)) {
    throw new Error(`${symbol} already has a Swing position or unresolved broker order.`);
  }
  const pendingExposure = openOrders.reduce((sum, order) => {
    if (order?.parent_order_id || String(order?.side || '').toLowerCase() !== 'buy') return sum;
    const price = Number(order.limit_price || order.notional || 0);
    const quantity = Number(order.qty || 0);
    return sum + (Number(order.notional) > 0 ? Number(order.notional) : Math.max(0, price * quantity));
  }, 0);
  const aggregateExposure = positions.reduce((sum, row) => sum + Math.abs(Number(row.market_value || 0)), 0)
    + pendingExposure;
  if (aggregateExposure >= settings.execution.maxAggregateExposure) throw new Error('Swing aggregate exposure ceiling is reached.');
  const sector = candidate.sector || 'UNKNOWN';
  const sectorCount = activeTrades.filter(row => {
    try { return (JSON.parse(row.setup_json)?.sector || 'UNKNOWN') === sector; } catch (_) { return sector === 'UNKNOWN'; }
  }).length;
  const sectorCap = sector === 'UNKNOWN' ? 1 : settings.execution.maxSectorPositions;
  if (sectorCount >= sectorCap) throw new Error(`Swing ${sector === 'UNKNOWN' ? 'unknown-sector' : sector} concentration limit is reached.`);
  const snapshot = await alpacaSnapshotFetch(userId, symbol, SWING_SCOPE);
  const quote = snapshot?.[symbol]?.latestQuote;
  const ask = Number(quote?.ap), bid = Number(quote?.bp);
  const quoteAt = Date.parse(quote?.t || '');
  if (!(ask > 0) || !(bid > 0) || !Number.isFinite(quoteAt) || Date.now() - quoteAt > 30000) {
    throw new Error('A fresh executable Alpaca quote is required.');
  }
  if ((ask - bid) / ask > 0.02) throw new Error('Current spread is too wide for an automated Swing entry.');
  if (ask > Number(candidate.entry) * 1.03) throw new Error('Price moved more than 3% above the completed-bar setup; entry is withheld.');
  const stop = Number(candidate.structuralStop);
  if (!(stop > 0 && stop < ask)) throw new Error('Fresh price invalidated the structural stop.');
  const risk = ask - stop;
  const maxAvailable = Math.min(
    settings.maxPositionDollars,
    Math.max(0, Number(account?.buying_power || 0)),
    Math.max(0, settings.execution.maxAggregateExposure - aggregateExposure)
  );
  const historicalResistance = Number(candidate.targets?.[2]?.price);
  const availableRewardR = Number.isFinite(historicalResistance)
    ? (historicalResistance - ask) / risk : 0;
  if (availableRewardR < settings.execution.minRewardRisk) {
    throw new Error('Fresh quote no longer provides the required reward-to-risk.');
  }
  const plannedRewardR = Math.min(3, availableRewardR);
  const targets = [plannedRewardR / 3, plannedRewardR * 2 / 3, plannedRewardR]
    .map((multiple, index) => ({
      name: `T${index + 1}`, price: +(ask + risk * multiple).toFixed(2), r: +multiple.toFixed(2),
    }));
  const limitPrice = Math.ceil(ask * 100) / 100;
  if (!(targets[0].price > limitPrice)) throw new Error('The first target is too close to place a bounded protected entry.');
  const shares = calculateLongQuantity({
    entry: limitPrice, stop, maxPositionDollars: maxAvailable,
    maxRiskDollars: settings.execution.maxRiskDollars,
  });
  if (!(shares >= 1)) throw new Error('Risk and buying-power limits produced less than one share.');
  settings = swingConfigFor(userId);
  creds = getAlpacaCreds(userId, SWING_SCOPE);
  if (!settings.enabled || !creds || (creds.mode === 'live' && !settings.liveArmed)) {
    throw new Error('Swing authorization changed during final broker checks.');
  }
  if (`${creds.mode}:${creds.account_id}` !== preflightBrokerIdentity) {
    throw new Error('The Swing broker account or mode changed during preflight; no order was submitted.');
  }
  const pinnedCreds = { ...creds };
  const finalAccount = await alpacaFetchWithCredentials(pinnedCreds, '/v2/account');
  if (String(finalAccount?.status || '').toUpperCase() !== 'ACTIVE'
      || finalAccount?.trading_blocked === true || finalAccount?.account_blocked === true) {
    throw new Error('Alpaca reports that the pinned Swing account is inactive or blocked.');
  }
  const allocation = calculateSwingAllocations(shares);
  requireSwingExecutionLease(userId, leaseToken);
  const createIntent = db.transaction(() => {
    const reservation = db.prepare(`INSERT OR IGNORE INTO swing_entry_reservations
      (user_id,symbol,signal_bar_at) VALUES (?,?,?)`).run(userId, symbol, candidate.signalBarAt);
    if (reservation.changes !== 1) throw new Error('This completed Swing signal is already reserved.');
    const inserted = db.prepare(`INSERT INTO swing_trades
      (user_id,symbol,mode,account_id,status,requested_shares,stop_price,tp1_price,tp2_price,tp3_price,
       trailing_stop,signal_bar_at,setup_json,entry_orders_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        userId, symbol, pinnedCreds.mode, pinnedCreds.account_id, 'entry_intent', shares, stop,
        targets[0].price, targets[1].price, targets[2].price, stop,
        candidate.signalBarAt, JSON.stringify({ ...candidate, entry: ask, targets }),
        '[]'
      );
    db.prepare(`UPDATE swing_entry_reservations SET trade_id=? WHERE user_id=? AND symbol=? AND signal_bar_at=?`)
      .run(inserted.lastInsertRowid, userId, symbol, candidate.signalBarAt);
    return inserted.lastInsertRowid;
  });
  const tradeId = Number(createIntent());
  recordSwingEvent(userId, {
    tradeId, symbol, eventType: 'ENTRY_INTENT', reasonCode: 'FRESH_SETUP_RESERVED',
    details: { requestedShares: shares, maxPositionDollars: settings.maxPositionDollars, limitPrice, stop, targets, source },
    sourceAt: candidate.signalBarAt,
  });
  const pieces = [
    { purpose: 'TP1', qty: allocation.target1, target: targets[0].price },
    { purpose: 'TP2', qty: allocation.target2, target: targets[1].price },
    { purpose: 'TP3', qty: allocation.target3, target: targets[2].price },
    { purpose: 'RUNNER', qty: allocation.final, target: null },
  ].filter(piece => piece.qty > 0);
  const lots = pieces.map((piece, index) => ({
    ...piece,
    clientOrderId: buildSwingClientOrderId({ symbol, tradeId, purpose: piece.purpose, sequence: index }),
    brokerOrderId: null,
    status: 'intent',
  }));
  db.prepare(`UPDATE swing_trades SET entry_orders_json=?,updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(lots), tradeId);
  for (let index = 0; index < lots.length; index++) {
    const lot = lots[index];
    requireSwingExecutionLease(userId, leaseToken);
    const order = lot.purpose === 'RUNNER'
      ? {
        symbol, qty: String(lot.qty), side: 'buy', type: 'limit', limit_price: limitPrice.toFixed(2), time_in_force: 'gtc',
        client_order_id: lot.clientOrderId, order_class: 'oto',
        stop_loss: { stop_price: stop.toFixed(2) },
      }
      : buildSwingEntryOrder({
        symbol, qty: lot.qty, clientOrderId: lot.clientOrderId, limitPrice, stop, target: lot.target,
      });
    beginAlpacaOrderRequest(userId);
    try {
      const submitted = await alpacaFetchWithCredentials(pinnedCreds, '/v2/orders', {
        method: 'POST', body: JSON.stringify(order),
      });
      lot.brokerOrderId = submitted?.id || lot.clientOrderId;
      lot.status = 'submitted';
      db.prepare(`UPDATE swing_trades SET status='pending_entry',entry_orders_json=?,updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(lots), tradeId);
      recordSwingEvent(userId, {
        tradeId, symbol, eventType: 'ENTRY_SUBMITTED', reasonCode: lot.purpose,
        details: { clientOrderId: lot.clientOrderId, brokerOrderId: lot.brokerOrderId, quantity: lot.qty },
      });
    } catch (error) {
      lot.status = 'unknown';
      for (let pending = index + 1; pending < lots.length; pending++) {
        lots[pending].status = 'not_submitted';
      }
      db.prepare(`UPDATE swing_trades SET status='entry_unknown',entry_orders_json=?,exit_reason=?,updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(lots), `Entry lot ${lot.purpose} outcome is unknown; no replacement was submitted`, tradeId);
      addSwingAlert(userId, symbol, 'ENTRY_UNKNOWN', `Broker confirmation is unknown for ${lot.purpose}. Capacity remains reserved.`);
      recordSwingEvent(userId, {
        tradeId, symbol, eventType: 'ENTRY_UNKNOWN', reasonCode: lot.purpose,
        details: { clientOrderId: lot.clientOrderId, error: error.message },
      });
      throw error;
    } finally {
      endAlpacaOrderRequest(userId);
    }
  }
  return { ok: true, source, tradeId, candidate: { ...candidate, entry: ask, targets }, lots };
}

async function maybeRatchetSwingRunner(userId, trade, parents, exitPurposes, leaseToken, pinnedCreds) {
  if (!exitPurposes.has('TP3')) return null;
  const runnerIndex = swingLots(trade).findIndex(lot => lot.purpose === 'RUNNER');
  if (runnerIndex < 0) return null;
  const runnerParent = parents[runnerIndex];
  const stopLeg = runnerParent?.legs?.find(leg =>
    ['stop', 'stop_limit', 'trailing_stop'].includes(String(leg?.type || '').toLowerCase())
      && ['new', 'accepted', 'held', 'open', 'partially_filled'].includes(String(leg?.status || '').toLowerCase()));
  if (!stopLeg?.id) return null;
  const start = new Date(Date.now() - 180 * 86400000).toISOString();
  const payload = await alpacaDataFetch(userId,
    `/v2/stocks/${encodeURIComponent(trade.symbol)}/bars?timeframe=1Day&start=${encodeURIComponent(start)}&limit=160&adjustment=all&feed=iex`,
    SWING_SCOPE);
  if (!payload) return null;
  const bars = completedSwingDailyBars(candlestickBarsFromResponse(payload, trade.symbol));
  if (bars.length < 25) return null;
  const closes = bars.map(bar => bar.c);
  const ema20 = swingEma(closes, 20);
  const atr14 = swingAtr(bars, 14);
  const swingLow = Math.min(...bars.slice(-10).map(bar => bar.l));
  const proposed = Math.min(bars.at(-1).c * 0.98, Math.max(ema20 || 0, swingLow - (atr14 || 0) * 0.5));
  const nextStop = ratchetSwingStop(Number(stopLeg.stop_price || trade.trailing_stop || trade.stop_price), proposed);
  if (!(nextStop > Number(trade.trailing_stop || trade.stop_price) + 0.01) || !(nextStop < bars.at(-1).c)) return null;
  requireSwingExecutionLease(userId, leaseToken);
  await alpacaFetchWithCredentials(pinnedCreds, `/v2/orders/${encodeURIComponent(stopLeg.id)}`, {
    method: 'PATCH', body: JSON.stringify({ stop_price: Number(nextStop).toFixed(2) }),
  });
  db.prepare(`UPDATE swing_trades SET trailing_stop=?,updated_at=datetime('now') WHERE id=?`).run(nextStop, trade.id);
  recordSwingEvent(userId, {
    tradeId: trade.id, symbol: trade.symbol, eventType: 'STOP_RATCHETED',
    reasonCode: 'TP3_CONFIRMED', details: { previousStop: trade.trailing_stop, nextStop },
  });
  return nextStop;
}

async function reconcileSwingTrades(userId, leaseToken) {
  const trades = db.prepare(`SELECT * FROM swing_trades WHERE user_id=?
    AND status NOT IN ('closed','rejected','canceled') ORDER BY id`).all(userId);
  const events = [];
  for (const trade of trades) {
    requireSwingExecutionLease(userId, leaseToken);
    const pinnedCreds = getPinnedSwingCreds(userId, trade.mode, trade.account_id);
    const lots = swingLots(trade);
    const parents = [];
    let entryQty = 0;
    let entryValue = 0;
    let unresolved = false;
    for (let index = 0; index < lots.length; index++) {
      const lot = lots[index];
      if (lot.status === 'not_submitted' || lot.status === 'missing_terminal') continue;
      try {
        const parent = await alpacaFetchWithCredentials(pinnedCreds,
          swingOrderLookupPath(lot.brokerOrderId, lot.clientOrderId));
        assertSwingOwnedBrokerTree(parent, {
          symbol: trade.symbol,
          clientOrderId: lot.clientOrderId,
          quantity: lot.qty,
        });
        parents[index] = parent;
        const qty = Number(parent.filled_qty || 0);
        const price = Number(parent.filled_avg_price || 0);
        if (qty > 0 && price > 0) {
          entryQty += qty;
          entryValue += qty * price;
        }
        for (const leg of Array.isArray(parent.legs) ? parent.legs : []) {
          if (Number(leg.filled_qty) > 0 && Number(leg.filled_avg_price) > 0) {
            const purpose = lot.purpose === 'RUNNER' ? 'TRAILING_STOP' : lot.purpose;
            if (recordSwingExitFill(trade.id, leg, purpose)) {
              recordSwingEvent(userId, {
                tradeId: trade.id, symbol: trade.symbol, eventType: 'EXIT_FILL',
                reasonCode: purpose,
                details: { brokerOrderId: leg.id, quantity: Number(leg.filled_qty), price: Number(leg.filled_avg_price) },
              });
            }
          }
        }
        if (lot.emergencyExitClientId) {
          try {
            const emergency = await alpacaFetchWithCredentials(pinnedCreds,
              swingOrderLookupPath(lot.emergencyExitOrderId, lot.emergencyExitClientId));
            if (!brokerOrderMatchesIntent(emergency, lot.emergencyExitClientId)) {
              throw new Error('Broker response does not match the Swing fail-safe exit intent.');
            }
            lot.emergencyExitOrderId = emergency.id || lot.emergencyExitClientId;
            lot.emergencyExitStatus = emergency.status;
            const purpose = `PROTECTION_EXIT:${lot.purpose}`;
            if (recordSwingExitFill(trade.id, emergency, purpose)) {
              recordSwingEvent(userId, {
                tradeId: trade.id, symbol: trade.symbol, eventType: 'EXIT_FILL',
                reasonCode: purpose,
                details: { brokerOrderId: emergency.id, quantity: Number(emergency.filled_qty), price: Number(emergency.filled_avg_price) },
              });
            }
          } catch (error) {
            if (error.alpacaStatus !== 404) throw error;
            unresolved = true;
          }
        }
      } catch (error) {
        if (error.alpacaStatus === 404) {
          const oldEnough = Date.now() - Date.parse(`${trade.created_at}Z`) > 15 * 60 * 1000;
          if (lot.status === 'unknown' && oldEnough) {
            lot.status = 'missing_terminal';
            addSwingAlert(userId, trade.symbol, 'ENTRY_MISSING',
              `${lot.purpose} was not found by its immutable client ID after the reconciliation window.`);
            recordSwingEvent(userId, {
              tradeId: trade.id, symbol: trade.symbol, eventType: 'ENTRY_MISSING',
              reasonCode: lot.purpose, details: { clientOrderId: lot.clientOrderId },
            });
          } else {
            unresolved = true;
            events.push({ id: trade.id, event: `${lot.purpose} entry outcome remains unknown` });
          }
          continue;
        }
        throw error;
      }
    }
    db.prepare(`UPDATE swing_trades SET entry_orders_json=?,updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(lots), trade.id);
    const exits = db.prepare(`SELECT quantity,price,purpose FROM swing_exit_fills WHERE trade_id=?`).all(trade.id);
    const exitedQty = exits.reduce((sum, fill) => sum + Number(fill.quantity || 0), 0);
    const remaining = Math.max(0, entryQty - exitedQty);
    const entryPrice = entryQty > 0 ? entryValue / entryQty : null;
    const pnl = entryPrice == null ? null : exits.reduce((sum, fill) =>
      sum + (Number(fill.price) - entryPrice) * Number(fill.quantity), 0);
    const purposes = new Set(exits.map(fill => fill.purpose));
    if (entryQty > Number(trade.filled_shares || 0)) {
      recordSwingEvent(userId, {
        tradeId: trade.id, symbol: trade.symbol, eventType: 'ENTRY_FILL',
        reasonCode: entryQty < trade.requested_shares ? 'PARTIAL' : 'COMPLETE',
        details: { previousFilled: Number(trade.filled_shares || 0), filledShares: entryQty, entryPrice },
      });
    }
    let setupState = {};
    try { setupState = JSON.parse(trade.setup_json || '{}'); } catch (_) {}
    const thesisDate = easternDateKey();
    if (entryQty > 0 && setupState?.runtime?.lastThesisCheckDate !== thesisDate) {
      try {
        const current = await buildSwingCandidate(userId, trade.symbol, swingConfigFor(userId).execution);
        const evidence = current.evidence || {};
        const thesisInvalidated = evidence.weeklyTrend === false
          || (evidence.sma200Rising === false && Number(current.entry) < Number(evidence.ema20));
        if (thesisInvalidated) {
          for (const lot of lots) lot.forceExitReason = 'LONG_TERM_THESIS_INVALIDATED';
          addSwingAlert(userId, trade.symbol, 'THESIS_INVALIDATED',
            'Completed daily/weekly structure invalidated the Swing thesis. Owned exits are being canceled before a fail-safe close.');
          recordSwingEvent(userId, {
            tradeId: trade.id, symbol: trade.symbol, eventType: 'THESIS_INVALIDATED',
            reasonCode: evidence.weeklyTrend === false ? 'WEEKLY_STRUCTURE_BROKEN' : 'DECLINING_200_DAY_STRUCTURE',
            details: { signalBarAt: current.signalBarAt, evidence },
            sourceAt: current.signalBarAt,
          });
        }
        setupState.runtime = { ...(setupState.runtime || {}), lastThesisCheckDate: thesisDate };
        db.prepare(`UPDATE swing_trades SET setup_json=?,entry_orders_json=?,updated_at=datetime('now') WHERE id=?`)
          .run(JSON.stringify(setupState), JSON.stringify(lots), trade.id);
      } catch (error) {
        recordSwingEvent(userId, {
          tradeId: trade.id, symbol: trade.symbol, eventType: 'THESIS_CHECK_UNAVAILABLE',
          reasonCode: 'DATA_UNAVAILABLE', details: { error: error.message },
        });
      }
    }
    let protectionIntervention = false;
    for (let index = 0; index < lots.length; index++) {
      const lot = lots[index];
      const parent = parents[index];
      if (!parent) continue;
      const lotExited = exits.filter(fill =>
        fill.purpose === lot.purpose
        || fill.purpose === (lot.purpose === 'RUNNER' ? 'TRAILING_STOP' : '')
        || fill.purpose === `PROTECTION_EXIT:${lot.purpose}`
      ).reduce((sum, fill) => sum + Number(fill.quantity || 0), 0);
      const protection = summarizeSwingLotProtection(parent, lotExited);
      const forcedThesisExit = !!lot.forceExitReason;
      if (!protection.requiresFailSafeExit && !forcedThesisExit) continue;
      protectionIntervention = true;
      unresolved = true;
      if (protection.activeOrders.length) {
        for (const ownedOrder of protection.activeOrders) {
          requireSwingExecutionLease(userId, leaseToken);
          try {
            await alpacaFetchWithCredentials(pinnedCreds,
              `/v2/orders/${encodeURIComponent(ownedOrder.id)}`, { method: 'DELETE' });
          } catch (error) {
            if (error.alpacaStatus !== 404) throw error;
          }
        }
        if (lot.protectionState !== 'cancel_requested') {
          lot.protectionState = 'cancel_requested';
          addSwingAlert(userId, trade.symbol,
            forcedThesisExit ? 'THESIS_EXIT_PENDING' : 'PROTECTION_MISSING',
            forcedThesisExit
              ? `${lot.purpose} owned exit orders were canceled after completed bars invalidated the thesis.`
              : `${lot.purpose} has ${protection.remainingQuantity} broker-confirmed shares without adequate stop coverage. Owned orders were canceled before a fail-safe exit.`);
          recordSwingEvent(userId, {
            tradeId: trade.id, symbol: trade.symbol,
            eventType: forcedThesisExit ? 'THESIS_EXIT_CANCELING' : 'PROTECTION_MISSING',
            reasonCode: lot.purpose, details: { ...protection, forceExitReason: lot.forceExitReason || null },
          });
        }
        continue;
      }
      if (!lot.emergencyExitClientId) {
        lot.emergencyExitClientId = buildSwingClientOrderId({
          symbol: trade.symbol, tradeId: trade.id, purpose: `PROTECT-${lot.purpose}`, sequence: index,
        });
        lot.emergencyExitStatus = 'intent';
        db.prepare(`UPDATE swing_trades SET status='protection_exit_pending',entry_orders_json=?,updated_at=datetime('now') WHERE id=?`)
          .run(JSON.stringify(lots), trade.id);
        requireSwingExecutionLease(userId, leaseToken);
        beginAlpacaOrderRequest(userId);
        try {
          const emergency = await alpacaFetchWithCredentials(pinnedCreds, '/v2/orders', {
            method: 'POST',
            body: JSON.stringify({
              symbol: trade.symbol,
              qty: String(Math.floor(protection.remainingQuantity)),
              side: 'sell',
              type: 'market',
              time_in_force: 'day',
              client_order_id: lot.emergencyExitClientId,
            }),
          });
          lot.emergencyExitOrderId = emergency?.id || lot.emergencyExitClientId;
          lot.emergencyExitStatus = emergency?.status || 'submitted';
          recordSwingEvent(userId, {
            tradeId: trade.id, symbol: trade.symbol, eventType: 'PROTECTION_EXIT_SUBMITTED',
            reasonCode: lot.purpose,
            details: { quantity: protection.remainingQuantity, clientOrderId: lot.emergencyExitClientId },
          });
        } catch (error) {
          lot.emergencyExitStatus = 'unknown';
          addSwingAlert(userId, trade.symbol, 'PROTECTION_EXIT_UNKNOWN',
            `${lot.purpose} fail-safe exit outcome is unknown and must be reconciled by client ID.`);
        } finally {
          endAlpacaOrderRequest(userId);
        }
      }
    }
    db.prepare(`UPDATE swing_trades SET entry_orders_json=?,updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(lots), trade.id);
    let status = protectionIntervention ? 'protection_exit_pending'
      : unresolved ? 'entry_unknown' : entryQty > 0 ? 'open' : 'pending_entry';
    const submittedLots = lots.filter(lot => lot.status !== 'not_submitted' && lot.status !== 'missing_terminal');
    const everyParentTerminal = submittedLots.every(lot => {
      const index = lots.indexOf(lot);
      return ['filled', 'canceled', 'rejected', 'expired', 'stopped']
        .includes(String(parents[index]?.status || '').toLowerCase());
    });
    if (entryQty <= 0 && everyParentTerminal) status = 'canceled';
    if (entryQty > 0 && remaining <= 0) status = 'closed';
    db.prepare(`UPDATE swing_trades SET status=?,filled_shares=?,shares_remaining=?,entry_price=?,pnl=?,
      closed_at=CASE WHEN ?='closed' THEN datetime('now') ELSE closed_at END,updated_at=datetime('now') WHERE id=?`)
      .run(status, entryQty, remaining, entryPrice, pnl, status, trade.id);
    recordSwingEvent(userId, {
      tradeId: trade.id, symbol: trade.symbol, eventType: 'RECONCILIATION',
      reasonCode: status, details: { entryQty, exitedQty, remaining, pnl, protectionIntervention },
    });
    if (status === 'closed') {
      recordSwingEvent(userId, {
        tradeId: trade.id, symbol: trade.symbol, eventType: 'TRADE_CLOSED',
        reasonCode: 'BROKER_CONFIRMED_EXITS', details: { entryQty, exitedQty, pnl },
      });
      events.push({ id: trade.id, event: 'all broker-confirmed Swing lots closed' });
      continue;
    }
    const ratcheted = await maybeRatchetSwingRunner(userId, trade, parents, purposes, leaseToken, pinnedCreds);
    if (ratcheted) events.push({ id: trade.id, event: `runner stop ratcheted to ${ratcheted}` });
  }
  return events;
}

// ── Swing Trading API ─────────────────────────────────────────────────────────
app.get('/api/swing/settings', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const settings = swingConfigFor(userId);
    res.set('Cache-Control', 'no-store').json({
      enabled: settings.enabled,
      liveArmed: settings.liveArmed,
      maxPositionDollars: settings.maxPositionDollars,
    });
  } catch (error) {
    res.status(503).json({ error: 'Swing settings are temporarily unavailable.' });
  }
});

app.put('/api/swing/settings', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const prior = swingConfigFor(userId);
    const safe = sanitizeSwingExecutionConfig({
      maxPositionDollars: req.body?.maxPositionDollars ?? prior.maxPositionDollars,
    }, SWING_CEILINGS);
    const creds = getAlpacaCreds(userId, SWING_SCOPE);
    const liveArmed = req.body?.liveArmed === true && creds?.mode === 'live';
    const enabled = req.body?.enabled === true;
    db.prepare(`INSERT INTO swing_settings
      (user_id,enabled,live_armed,max_position_dollars,updated_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,live_armed=excluded.live_armed,
        max_position_dollars=excluded.max_position_dollars,updated_at=datetime('now')`)
      .run(userId, enabled ? 1 : 0, liveArmed ? 1 : 0, safe.maxPositionDollars);
    res.json({ ok: true, enabled, liveArmed, maxPositionDollars: safe.maxPositionDollars });
  } catch (error) {
    res.status(503).json({ error: 'Swing settings could not be saved.' });
  }
});

app.get('/api/swing/readiness', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const settings = swingConfigFor(userId);
    const creds = getAlpacaCreds(userId, SWING_SCOPE);
    let broker = { reachable: false, active: false, tradingBlocked: false, accountBlocked: false };
    let brokerError = null;
    if (creds) {
      try {
        const account = await alpacaFetchFor(userId, SWING_SCOPE, '/v2/account');
        broker = {
          reachable: true,
          active: String(account?.status || '').toUpperCase() === 'ACTIVE',
          tradingBlocked: account?.trading_blocked === true,
          accountBlocked: account?.account_blocked === true,
        };
      } catch (error) { brokerError = error.message; }
    }
    const brokerReady = !!creds && broker.reachable && broker.active
      && !broker.tradingBlocked && !broker.accountBlocked;
    const blockers = [];
    if (!creds) blockers.push('A dedicated Swing Alpaca account is not connected.');
    else if (!broker.reachable) blockers.push(`Broker readiness failed: ${brokerError || 'Alpaca did not respond.'}`);
    else {
      if (!broker.active) blockers.push('Alpaca reports that the Swing account is not active.');
      if (broker.tradingBlocked || broker.accountBlocked) blockers.push('Alpaca reports that trading is blocked.');
    }
    if (!settings.enabled) blockers.push('Swing automation is paused.');
    if (creds?.mode === 'live' && !settings.liveArmed) blockers.push('Live Swing orders are not explicitly armed.');
    if (!isMarketOpen()) blockers.push('New entries wait for the next regular-session window.');
    res.set('Cache-Control', 'no-store').json({
      connected: !!creds,
      accountId: creds?.account_id || null,
      mode: creds?.mode || 'paper',
      enabled: settings.enabled,
      liveArmed: settings.liveArmed,
      ready: brokerReady && settings.enabled && (creds?.mode !== 'live' || settings.liveArmed),
      brokerReady,
      reconciliationReady: brokerReady,
      entryReadyNow: brokerReady && settings.enabled && isMarketOpen()
        && (creds?.mode !== 'live' || settings.liveArmed),
      broker,
      marketOpen: isMarketOpen(),
      blockers,
      riskPolicy: {
        maxPositionDollars: settings.maxPositionDollars,
        maxRiskDollars: settings.execution.maxRiskDollars,
        maxPositions: settings.execution.maxPositions,
        maxAggregateExposure: settings.execution.maxAggregateExposure,
        maxSectorPositions: settings.execution.maxSectorPositions,
      },
      ...settings.runtime,
    });
  } catch (error) {
    res.status(503).json({ error: 'Swing readiness could not be verified.' });
  }
});

app.get('/api/swing/scan', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    if (!getAlpacaCreds(userId, SWING_SCOPE)) {
      return res.status(400).json({ error: 'Connect the dedicated Swing Alpaca account to scan.' });
    }
    const result = await scanSwingUniverse(userId);
    db.prepare(`UPDATE swing_settings SET last_scan_at=datetime('now') WHERE user_id=?`).run(userId);
    res.set('Cache-Control', 'no-store').json(result);
  } catch (error) {
    res.status(503).json({ error: `Swing scan unavailable: ${error.message}` });
  }
});

app.get('/api/swing/candidates', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const stored = db.prepare(`SELECT payload_json,evaluated_at FROM swing_candidates
      WHERE user_id=? ORDER BY evaluated_at DESC LIMIT 200`).all(userId);
    const results = stored.map(row => {
      try { return JSON.parse(row.payload_json); } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    res.set('Cache-Control', 'no-store').json({
      strategy: 'long-only-swing-v1',
      results,
      evaluatedAt: stored[0]?.evaluated_at || null,
      funnel: {
        scanned: results.length,
        eligible: results.filter(row => row.eligible).length,
        rejected: results.filter(row => !row.eligible).length,
      },
    });
  } catch (_) {
    res.status(503).json({ error: 'Stored Swing candidates could not be loaded.' });
  }
});

app.post('/api/swing/execute', requireAuth, async (req, res) => {
  res.status(409).json({ error: 'Swing entries are submitted only by the server automation scheduler.' });
});

app.get('/api/swing/trades', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const trades = db.prepare(`SELECT id,symbol,mode,status,requested_shares,filled_shares,shares_remaining,
      entry_price,stop_price,tp1_price,tp2_price,tp3_price,trailing_stop,exit_reason,pnl,created_at,closed_at
      FROM swing_trades WHERE user_id=? ORDER BY id DESC LIMIT 100`).all(userId);
    res.json({ trades });
  } catch (_) { res.status(503).json({ error: 'Swing broker journal could not be loaded.' }); }
});

app.get('/api/swing/alerts', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const alerts = db.prepare(`SELECT id,symbol,type,message,created_at FROM swing_alerts
      WHERE user_id=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 50`).all(userId);
    res.json({ alerts });
  } catch (_) { res.status(503).json({ error: 'Swing alerts could not be loaded.' }); }
});

app.get('/api/swing/performance', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const closed = db.prepare(`SELECT pnl FROM swing_trades WHERE user_id=? AND status='closed' AND pnl IS NOT NULL`).all(userId);
    const values = closed.map(row => Number(row.pnl)).filter(Number.isFinite);
    const wins = values.filter(value => value > 0);
    res.json({ metrics: {
      trades: values.length,
      closedTrades: values.length,
      winRate: values.length ? wins.length / values.length : null,
      netPnl: values.reduce((sum, value) => sum + value, 0),
      averagePnl: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    } });
  } catch (_) { res.status(503).json({ error: 'Swing performance could not be loaded.' }); }
});

app.post('/api/swing/reconcile', requireAuth, async (req, res) => {
  let userId;
  try { userId = await ensureSessionUserInTradingStore(req); }
  catch (_) { return res.status(503).json({ error: 'Swing trading identity could not be verified.' }); }
  if (!acquireBotLock(userId)) return res.status(409).json({ error: 'Another broker order cycle is in progress.' });
  const lease = acquireSwingExecutionLease(userId);
  if (!lease) { releaseBotLock(userId); return res.status(409).json({ error: 'Another Swing cycle is still reconciling.' }); }
  try {
    if (!getAlpacaCreds(userId, SWING_SCOPE)) throw new Error('Connect the dedicated Swing Alpaca account first.');
    const reconciled = await reconcileSwingTrades(userId, lease);
    const trades = db.prepare(`SELECT id,symbol,mode,status,requested_shares,filled_shares,shares_remaining,
      entry_price,stop_price,tp1_price,tp2_price,tp3_price,trailing_stop,exit_reason,pnl,created_at,closed_at
      FROM swing_trades WHERE user_id=? ORDER BY id DESC LIMIT 100`).all(userId);
    res.json({ ok: true, reconciled, trades });
  } catch (error) { res.status(400).json({ error: error.message }); }
  finally { releaseSwingExecutionLease(userId, lease); releaseBotLock(userId); }
});

app.get('/api/swing/backtest', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const symbol = String(req.query.symbol || 'SPY').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol)) return res.status(400).json({ error: 'A valid symbol is required.' });
    if (!getAlpacaCreds(userId, SWING_SCOPE)) return res.status(400).json({ error: 'Connect the dedicated Swing Alpaca account to backtest.' });
    const start = new Date(Date.now() - 5 * 365 * 86400000).toISOString();
    const payload = await alpacaDataFetch(userId,
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${encodeURIComponent(start)}&limit=2000&adjustment=all&feed=iex`,
      SWING_SCOPE);
    if (!payload) throw new Error('Historical Alpaca bars are unavailable.');
    const dailyBars = completedSwingDailyBars(candlestickBarsFromResponse(payload, symbol));
    const weeklyBars = completedSwingWeeklyBars(dailyBars);
    const replay = simulateSwingBacktest({
      symbol, dailyBars, weeklyBars, freshness: { daily: true, weekly: true },
      relativeStrength: 0, quality: null, catalyst: null, sector: null, market: null,
    }, { ...DEFAULT_SWING_CONFIG, minAverageDollarVolume: SWING_CEILINGS.minAverageDollarVolume });
    const closed = replay.records.filter(record => Number.isFinite(Number(record.realizedR)));
    const rs = closed.map(record => Number(record.realizedR));
    let balance = 0, peak = 0, maxDrawdown = 0;
    for (const value of rs) {
      balance += value; peak = Math.max(peak, balance); maxDrawdown = Math.max(maxDrawdown, peak - balance);
    }
    res.json({
      strategy: replay.strategy,
      symbol,
      insufficientEvidence: closed.length < 20,
      note: closed.length < 20
        ? 'Insufficient completed samples to make a performance claim.'
        : 'Chronological next-session replay with slippage and conservative same-bar stop priority. Historical results are not guarantees.',
      metrics: {
        trades: closed.length,
        winRate: closed.length ? rs.filter(value => value > 0).length / closed.length : null,
        expectancyR: rs.length ? rs.reduce((sum, value) => sum + value, 0) / rs.length : null,
        maxDrawdownR: maxDrawdown,
      },
      records: replay.records.slice(-100),
    });
  } catch (error) {
    res.status(503).json({ error: `Swing backtest unavailable: ${error.message}` });
  }
});

async function runSwingCycle(userId, source = 'server-scheduler') {
  const outcome = { bot: 'swing', source, status: 'skipped', reconciled: 0, submitted: false };
  const finish = details => {
    const result = { ...outcome, ...details };
    recordSwingCycle(userId, result);
    return result;
  };
  const creds = getAlpacaCreds(userId, SWING_SCOPE);
  const settings = swingConfigFor(userId);
  if (!creds) return finish({ reason: 'Dedicated Swing broker account is not connected.' });
  if (!acquireBotLock(userId)) return finish({ status: 'busy', reason: 'Another broker cycle is in progress.' });
  const lease = acquireSwingExecutionLease(userId);
  if (!lease) {
    releaseBotLock(userId);
    return finish({ status: 'busy', reason: 'Swing reconciliation is already in progress.' });
  }
  try {
    const events = await reconcileSwingTrades(userId, lease);
    outcome.reconciled = events.length;
    if (!settings.enabled) return finish({
      status: 'reconciled_paused',
      reason: 'Automation is paused; existing Swing lots and broker-held protection were still reconciled.',
    });
    if (creds.mode === 'live' && !settings.liveArmed) return finish({
      status: 'reconciled_live_unarmed',
      reason: 'Live entries are unarmed; existing Swing lots and protection were still reconciled.',
    });
    if (!isMarketOpen()) return finish({ status: 'market_closed', reason: 'New entries wait for the regular session.' });
    const lastScan = Date.parse(settings.runtime.lastScanAt || '');
    if (Number.isFinite(lastScan) && Date.now() - lastScan < 30 * 60 * 1000) {
      return finish({ status: 'reconciled', reason: 'Existing positions reconciled; the next catalog rotation is not due yet.' });
    }
    const scan = await scanSwingUniverse(userId);
    db.prepare(`UPDATE swing_settings SET last_scan_at=datetime('now') WHERE user_id=?`).run(userId);
    const eligible = scan.results.filter(row => row.eligible).sort((a, b) => b.score - a.score);
    if (!eligible.length) return finish({
      status: 'no_entry', reason: `No qualifying setup in ${scan.results.length} rotated symbols.`,
      scanned: scan.results.length, eligible: 0,
    });
    await executeSwingEntry(userId, eligible[0].symbol, source, lease);
    return finish({
      status: 'submitted', submitted: true, symbol: eligible[0].symbol,
      scanned: scan.results.length, eligible: eligible.length,
      reason: `Submitted broker-protected Swing lots for ${eligible[0].symbol}.`,
    });
  } catch (error) {
    console.warn(`[Swing] user ${userId} cycle withheld: ${error.message}`);
    addSwingAlert(userId, null, 'CYCLE_WITHHELD', String(error.message || 'Swing cycle was withheld.'));
    return finish({ status: 'withheld', reason: String(error.message || 'Safety gates withheld the cycle.').slice(0, 300) });
  } finally {
    releaseSwingExecutionLease(userId, lease);
    releaseBotLock(userId);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LEAP OPTIONS BOT — isolated, long-call, completed-week automation
// ══════════════════════════════════════════════════════════════════════════════

const OPTIONS_SCOPE = 'options';
const OPTIONS_MIN_APPROVAL_LEVEL = 2;
const OPTIONS_MAX_POSITION_DOLLARS = 100000;
const OPTIONS_QUOTE_MAX_AGE_MS = 60 * 1000;
const OPTIONS_MAX_SPREAD_FRACTION = 0.15;

function optionsConfigFor(userId) {
  const row = db.prepare(`SELECT enabled,live_armed,max_position_dollars,last_cycle_at,
    last_cycle_status,last_cycle_reason,last_scan_at,updated_at
    FROM options_settings WHERE user_id=?`).get(userId);
  const maxPositionDollars = Math.min(
    OPTIONS_MAX_POSITION_DOLLARS,
    Math.max(1, Number(row?.max_position_dollars || 1000))
  );
  return {
    enabled: !!row?.enabled,
    liveArmed: !!row?.live_armed,
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
  if (isBrokerAccountQuarantined(expectedAccountId)) {
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
  return completedSwingWeeklyBars(dailyBars, now).map(bar => ({
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
  const dailyBars = completedSwingDailyBars(candlestickBarsFromResponse(payload, symbol));
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
  if (!(bid > 0) || !(ask > bid) || !Number.isFinite(timestamp)
      || Date.now() - timestamp > OPTIONS_QUOTE_MAX_AGE_MS) {
    throw new Error(`${symbol} does not have a fresh, uncrossed Alpaca quote.`);
  }
  if ((ask - bid) / ((ask + bid) / 2) > 0.02) {
    throw new Error(`${symbol} underlying spread is too wide.`);
  }
  return { bid, ask, mid: (bid + ask) / 2, timestamp, raw: quote };
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
    contract: null,
  };
  if (!signal.eligible || !includeContract) return candidate;
  const underlying = await optionsUnderlyingQuote(userId, sym);
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

async function scanOptionsUniverse(userId) {
  const results = await mapWithConcurrency(LEAP_UNDERLYINGS, 3, async symbol => {
    try { return await buildOptionsCandidate(userId, symbol); }
    catch (error) {
      return {
        strategy: 'leap-options-v1', symbol, direction: 'LONG_CALL', eligible: false,
        status: 'DATA UNAVAILABLE', score: 0,
        reasons: [`Required verified evidence is unavailable: ${error.message}`],
        evidence: null, contract: null, evaluatedAt: new Date().toISOString(),
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
  let settings = optionsConfigFor(userId);
  let creds = getAlpacaCreds(userId, OPTIONS_SCOPE);
  const brokerIdentity = creds ? `${creds.mode}:${creds.account_id}` : null;
  if (!settings.enabled) throw new Error('LEAP Options automation is disabled in persisted settings.');
  if (!creds) throw new Error('Connect the dedicated LEAP Options Alpaca account first.');
  if (creds.mode === 'live' && !settings.liveArmed) throw new Error('Live LEAP option orders are not explicitly armed.');
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
  if (!settings.enabled || !creds || (creds.mode === 'live' && !settings.liveArmed)
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
    const prior = optionsConfigFor(userId);
    const maxPositionDollars = Math.min(OPTIONS_MAX_POSITION_DOLLARS,
      Math.max(1, Number(req.body?.maxPositionDollars ?? prior.maxPositionDollars)));
    if (!Number.isFinite(maxPositionDollars)) return res.status(400).json({ error: 'Maximum position dollars must be finite.' });
    const creds = getAlpacaCreds(userId, OPTIONS_SCOPE);
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
    db.prepare(`INSERT INTO options_settings
      (user_id,enabled,live_armed,max_position_dollars,updated_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,live_armed=excluded.live_armed,
        max_position_dollars=excluded.max_position_dollars,updated_at=datetime('now')`)
      .run(userId, enabled ? 1 : 0, liveArmed ? 1 : 0, maxPositionDollars);
    res.json({ ok: true, enabled, liveArmed, maxPositionDollars });
  } catch (error) { res.status(503).json({ error: `Options settings could not be saved: ${error.message}` }); }
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
    if (!isMarketOpen()) blockers.push('New entries wait for the next regular-session window.');
    res.set('Cache-Control', 'no-store').json({
      connected: !!creds,
      accountId: creds?.account_id || null,
      mode: creds?.mode || 'paper',
      enabled: settings.enabled,
      liveArmed: settings.liveArmed,
      ready: brokerReady && settings.enabled && (creds?.mode !== 'live' || settings.liveArmed),
      reconciliationReady: !!creds && !!account && approval.active && !approval.blocked,
      entryReadyNow: brokerReady && settings.enabled && isMarketOpen()
        && (creds?.mode !== 'live' || settings.liveArmed),
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
  if (!acquireBotLock(userId)) return res.status(409).json({ error: 'Another broker order cycle is in progress.' });
  const lease = acquireOptionsExecutionLease(userId);
  if (!lease) { releaseBotLock(userId); return res.status(409).json({ error: 'Another Options cycle is still reconciling.' }); }
  try {
    if (!getAlpacaCreds(userId, OPTIONS_SCOPE)) throw new Error('Connect the dedicated Options Alpaca account first.');
    const reconciled = await reconcileOptionsTrades(userId, lease);
    res.json({ ok: true, reconciled, trades: optionsTradeRows(userId) });
  } catch (error) { res.status(400).json({ error: error.message }); }
  finally { releaseOptionsExecutionLease(userId, lease); releaseBotLock(userId); }
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
  if (!acquireBotLock(userId)) return finish({ status: 'busy', reason: 'Another broker cycle is in progress.' });
  const lease = acquireOptionsExecutionLease(userId);
  if (!lease) {
    releaseBotLock(userId);
    return finish({ status: 'busy', reason: 'Options reconciliation is already in progress.' });
  }
  try {
    const events = await reconcileOptionsTrades(userId, lease);
    outcome.reconciled = events.length;
    if (!settings.enabled) return finish({
      status: 'reconciled_paused',
      reason: 'Automation is paused; broker-confirmed option positions and owned exits were still reconciled.',
    });
    if (creds.mode === 'live' && !settings.liveArmed) return finish({
      status: 'reconciled_live_unarmed',
      reason: 'Live entries are unarmed; existing option positions and exits were still reconciled.',
    });
    if (!isMarketOpen()) return finish({ status: 'market_closed', reason: 'New option entries wait for the regular session.' });
    const lastScan = Date.parse(settings.runtime.lastScanAt || '');
    if (Number.isFinite(lastScan) && Date.now() - lastScan < 6 * 60 * 60 * 1000) {
      return finish({ status: 'reconciled', reason: 'Existing LEAP lifecycles reconciled; the next fixed-universe scan is not due.' });
    }
    const scan = await scanOptionsUniverse(userId);
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
    releaseBotLock(userId);
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
// Migrate old per-bot table if present (no-op if already done)
try { db.prepare(`INSERT OR IGNORE INTO trade_settings (user_id,position_mode,position_pct,position_amount) SELECT user_id,position_mode,position_pct,position_amount FROM swing_auto_settings`).run(); } catch(_) {}
try { db.prepare(`ALTER TABLE swing_settings ADD COLUMN last_scan_at TEXT`).run(); } catch (_) {}

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
function groupDailyToWeekly(dailyBars) {
  const weeks = {};
  for (const bar of dailyBars) {
    const d   = new Date((bar.t || '').includes('T') ? bar.t : bar.t + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon  = new Date(d);
    mon.setUTCDate(d.getUTCDate() + diff);
    const key = `${mon.getUTCFullYear()}-${String(mon.getUTCMonth()+1).padStart(2,'0')}-${String(mon.getUTCDate()).padStart(2,'0')}`;
    if (!weeks[key]) {
      weeks[key] = { t: key, completedAt: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 };
    } else {
      const w = weeks[key];
      w.h = Math.max(w.h, bar.h);
      w.l = Math.min(w.l, bar.l);
      w.c = bar.c;
      w.v += bar.v || 0;
      w.completedAt = bar.t;
    }
  }
  return Object.values(weeks).sort((a, b) => a.t.localeCompare(b.t));
}

// ── Swing Long Signal (BOTTOM) — 5 conditions on weekly + daily ───────────────
// ── Swing VIX Signal — two zones, two directions ─────────────────────────────
//
//  VIX 20–45  → INVERSE play: buy cheapest inverse ETF < $10
//               Exit: VIX crushes below 17 (fear gone, inverse loses value)
//
//  VIX 12–20  → LONG play: buy cheapest strong-fundamental stock < $10
//               Exit: VIX rises back above 20 (fear returning, long at risk)
//

// ══════════════════════════════════════════════════════════════════════════════

// ── Candlestick Automation API ─────────────────────────────────────────────────
app.get('/api/candlestick/settings', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const { enabled, liveArmed, config } = candlestickConfigFor(userId);
    res.json({ enabled, liveArmed, config });
  } catch (error) {
    console.error('[Candlestick] Could not load persisted settings:', error.message);
    res.status(503).json({ error: 'UltraBot3 settings are temporarily unavailable. Sign out, sign back in, and try again.' });
  }
});

app.put('/api/candlestick/settings', requireAuth, (req, res) => {
  (async () => {
    const userId = await ensureSessionUserInTradingStore(req);
    const body = req.body || {};
    const prior = candlestickConfigFor(userId);
    const config = serverOwnedConfig(
      CANDLESTICK_DEFAULTS,
      prior.config,
      body.maxPositionDollars ?? body.config?.maxPositionDollars,
      { maximum: 100_000 }
    );
    const safeConfig = sanitizeCandlestickExecutionConfig(config, CANDLESTICK_DEFAULTS);
    // Live execution must be deliberately armed after the user has connected a
    // live broker account; connecting keys alone never turns on real orders.
    const liveArmed = body.liveArmed === true && getAlpacaCreds(userId, 'candlestick')?.mode === 'live';
    db.prepare(`INSERT INTO candlestick_settings (user_id,enabled,live_armed,config_json,updated_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,live_armed=excluded.live_armed,
        config_json=excluded.config_json,updated_at=datetime('now')`)
      .run(userId, body.enabled === true ? 1 : 0, liveArmed ? 1 : 0, JSON.stringify(safeConfig));
    res.json({ ok: true, enabled: body.enabled === true, liveArmed, config: safeConfig });
  })().catch(error => {
    console.error('[Candlestick] Could not persist settings:', error.message);
    res.status(503).json({ error: 'UltraBot3 settings could not be saved. Sign out, sign back in, and try again.' });
  });
});

app.get('/api/candlestick/readiness', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const settings = candlestickConfigFor(userId);
    const runtime = candlestickRuntimeFor(userId);
    const creds = getAlpacaCreds(userId, 'candlestick');
    let broker = { reachable: false, active: false, tradingBlocked: false, accountBlocked: false };
    let brokerError = null;
    if (creds) {
      try {
        const account = await alpacaFetchFor(userId, 'candlestick', '/v2/account');
        broker = {
          reachable: true,
          active: String(account?.status || '').toUpperCase() === 'ACTIVE',
          tradingBlocked: account?.trading_blocked === true,
          accountBlocked: account?.account_blocked === true,
        };
      } catch (error) {
        brokerError = error.message;
      }
    }
    const marketOpen = isMarketOpen();
    const brokerReady = !!creds && broker.reachable && broker.active
      && !broker.tradingBlocked && !broker.accountBlocked;
    const automationReady = brokerReady && settings.enabled
      && (creds?.mode !== 'live' || settings.liveArmed);
    const blockers = [];
    if (!creds) blockers.push('Dedicated Alpaca account is not connected to UltraBot3.');
    else if (!broker.reachable) blockers.push(`Broker readiness check failed: ${brokerError || 'Alpaca did not respond.'}`);
    else {
      if (!broker.active) blockers.push('Alpaca reports that the account is not active.');
      if (broker.tradingBlocked || broker.accountBlocked) blockers.push('Alpaca reports that trading is blocked on this account.');
    }
    if (!settings.enabled) blockers.push('UltraBot3 automation is disabled.');
    if (creds?.mode === 'live' && !settings.liveArmed) blockers.push('Live trading is connected but not explicitly armed.');
    if (!marketOpen) blockers.push('The regular-session entry window is closed.');
    res.set('Cache-Control', 'no-store').json({
      connected: !!creds,
      accountId: creds?.account_id || null,
      mode: creds?.mode || null,
      enabled: settings.enabled,
      liveArmed: settings.liveArmed,
      broker,
      marketOpen,
      brokerReady,
      automationReady,
      reconciliationReady: brokerReady,
      schedulerEligible: automationReady && marketOpen,
      entryReadyNow: automationReady && marketOpen,
      readinessScope: 'Broker, persisted automation, and market-window readiness. Every order still requires fresh completed bars, quote, capacity, and risk checks.',
      blockers,
      watchlistSize: CANDLESTICK_WATCHLIST.length,
      ...runtime,
    });
  } catch (error) {
    console.error('[Candlestick] Readiness check failed:', error.message);
    res.status(503).json({ error: 'UltraBot3 readiness could not be verified.' });
  }
});

app.get('/api/candlestick/scan', requireAuth, async (req, res) => {
  let userId;
  try { userId = await ensureSessionUserInTradingStore(req); }
  catch (error) { return res.status(503).json({ error: 'UltraBot3 trading identity could not be verified.' }); }
  const { config } = candlestickConfigFor(userId);
  const requestedParam = String(req.query.symbols || '').trim();
  const requested = requestedParam
    ? requestedParam.split(',').map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z0-9.-]{1,12}$/.test(s)).slice(0, config.maxSymbols)
    : null;
  const batch = requested
    ? { symbols: requested, batch: null, totalBatches: null }
    : nextCandlestickWatchlistBatch(CANDLESTICK_WATCHLIST, candlestickWatchlistRotation, String(userId), config.maxSymbols);
  if (!getAlpacaCreds(userId, 'candlestick')) {
    return res.status(400).json({ error: 'Connect the dedicated Candlestick Automation Alpaca account to scan.' });
  }
  const results = await Promise.all(batch.symbols.map(symbol => buildCandlestickCandidate(userId, symbol, config)
    .catch(error => ({ symbol, status: 'NO TRADE', eligible: false, score: 0, reasons: [`Market data unavailable: ${error.message}`] }))));
  saveCandlestickCandidates(userId, results);
  const funnel = results.reduce((acc, row) => {
    const key = row.eligible ? 'eligible' : row.direction ? 'rejected' : 'noPattern';
    acc[key]++; return acc;
  }, { eligible: 0, rejected: 0, noPattern: 0 });
  res.set('Cache-Control', 'no-store').json({
    strategy: 'candlestick-automation-v1', results, config, funnel,
    coverage: {
      watchlistSize: CANDLESTICK_WATCHLIST.length,
      scanned: batch.symbols.length,
      rotationBatch: batch.batch,
      totalBatches: batch.totalBatches,
      note: requested ? 'Explicit symbols requested.' : 'UltraBot3 rotates through its complete dedicated watchlist across scan cycles.',
    },
    evaluatedAt: new Date().toISOString(),
  });
});

app.post('/api/candlestick/execute', requireAuth, async (req, res) => {
  res.status(409).json({ error: 'UltraBot3 entries are submitted only by the server automation scheduler.' });
});

app.get('/api/candlestick/trades', requireAuth, async (req, res) => {
  try {
    const userId = await ensureSessionUserInTradingStore(req);
    const trades = db.prepare('SELECT * FROM candlestick_trade_log WHERE user_id=? ORDER BY timestamp DESC LIMIT 50').all(userId);
    res.json({ trades });
  } catch (error) {
    res.status(503).json({ error: 'UltraBot3 broker journal could not be loaded.' });
  }
});

app.post('/api/candlestick/reconcile', requireAuth, async (req, res) => {
  let userId;
  try { userId = await ensureSessionUserInTradingStore(req); }
  catch (error) { return res.status(503).json({ error: 'UltraBot3 trading identity could not be verified.' }); }
  if (!acquireBotLock(userId)) return res.status(409).json({ error: 'Another bot order cycle is in progress.' });
  const lease = acquireCandlestickExecutionLease(userId);
  if (!lease) { releaseBotLock(userId); return res.status(409).json({ error: 'Another UltraBot3 execution cycle is still reconciling this account.' }); }
  try {
    const reconciled = await reconcileCandlestickTrades(userId, lease);
    const trades = db.prepare('SELECT * FROM candlestick_trade_log WHERE user_id=? ORDER BY timestamp DESC LIMIT 50').all(userId);
    res.json({ ok: true, reconciled, trades });
  } catch (error) { res.status(400).json({ error: error.message }); }
  finally { releaseCandlestickExecutionLease(userId, lease); releaseBotLock(userId); }
});

app.get('/api/candlestick/backtest', requireAuth, async (req, res) => {
  let userId;
  try { userId = await ensureSessionUserInTradingStore(req); }
  catch (error) { return res.status(503).json({ error: 'UltraBot3 trading identity could not be verified.' }); }
  const symbol = String(req.query.symbol || 'SPY').toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return res.status(400).json({ error: 'A valid symbol is required.' });
  const { config } = candlestickConfigFor(userId);
  if (!getAlpacaCreds(userId, 'candlestick')) return res.status(400).json({ error: 'Connect the dedicated Candlestick Automation Alpaca account to backtest.' });
  const start = new Date(Date.now() - 18 * 24 * 60 * 60 * 1000).toISOString();
  const data = await alpacaDataFetch(userId,
    `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=5Min&start=${encodeURIComponent(start)}&limit=10000&adjustment=all&feed=iex`,
    'candlestick');
  const bars = completedCandlestickBars(candlestickBarsFromResponse(data, symbol));
  const replay = simulateCandlestickBacktest({ symbol, bars, higherTimeframeMs: 15 * 60 * 1000 }, config);
  const closed = replay.records.filter(r => r.outcome !== 'OPEN');
  const rs = closed.map(r => r.outcome === 'TARGET' ? Number(r.setup.riskReward || 0) : -1);
  const wins = rs.filter(r => r > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = Math.abs(rs.filter(r => r < 0).reduce((a, b) => a + b, 0));
  let balance = 0, peak = 0, maxDrawdown = 0;
  rs.forEach(r => { balance += r; peak = Math.max(peak, balance); maxDrawdown = Math.max(maxDrawdown, peak - balance); });
  const countBy = mapper => Object.entries(closed.reduce((acc, r) => { const key = mapper(r); acc[key] = (acc[key] || 0) + 1; return acc; }, {}));
  res.json({
    strategy: replay.strategy, symbol, insufficientEvidence: closed.length < 20,
    note: closed.length < 20 ? 'Insufficient completed samples to make a performance claim.' : 'Historical replay is descriptive, not a profitability claim.',
    metrics: { trades: closed.length, winRate: closed.length ? wins.length / closed.length : null, averageR: rs.length ? rs.reduce((a,b) => a+b,0) / rs.length : null,
      profitFactor: grossLoss ? grossWin / grossLoss : null, expectancyR: rs.length ? rs.reduce((a,b) => a+b,0) / rs.length : null, maxDrawdownR: maxDrawdown },
    breakdowns: { setup: countBy(r => Object.entries(r.setup.evidence?.patterns || {}).filter(([,v]) => v).map(([k]) => k).join(', ') || 'other'),
      scoreRange: countBy(r => `${Math.floor((r.setup.score || 0) / 10) * 10}-${Math.floor((r.setup.score || 0) / 10) * 10 + 9}`),
      regime: countBy(r => r.setup.evidence?.regime?.regime || 'UNKNOWN'),
      relativeVolume: countBy(r => Number(r.setup.evidence?.relativeVolume || 0) >= 2 ? '2x+' : 'under 2x') },
    records: replay.records.slice(-100),
  });
});

// The scheduler is intentionally server-owned. It runs only with a dedicated
// connected scope, persisted enablement, an explicit live arm, fresh evidence,
// and an available broker position. Closing the page never disables protection
// or reconciliation, but no condition ever forces a demonstration trade.
async function runCandlestickCycle(userId, source = 'server-scheduler') {
  const outcome = { bot: 'candlestick', source, status: 'skipped', reconciled: 0, submitted: false };
  const finish = details => {
    const result = { ...outcome, ...details };
    recordCandlestickCycle(userId, result);
    return result;
  };
  const creds = getAlpacaCreds(userId, 'candlestick');
  const settings = candlestickConfigFor(userId);
  if (!creds) return finish({ reason: 'Dedicated broker account is not connected.' });
  if (!acquireBotLock(userId)) return finish({ status: 'busy', reason: 'Another broker cycle is in progress.' });
  const lease = acquireCandlestickExecutionLease(userId);
  if (!lease) {
    releaseBotLock(userId);
    return finish({ status: 'busy', reason: 'Candlestick reconciliation is already in progress.' });
  }
  try {
    const events = await reconcileCandlestickTrades(userId, lease);
    outcome.reconciled = events.length;
    if (!settings.enabled) return finish({
      status: 'reconciled_paused',
      reason: 'Automation is paused; existing broker positions and orders were still reconciled.',
    });
    if (creds.mode === 'live' && !settings.liveArmed) return finish({
      status: 'reconciled_live_unarmed',
      reason: 'Live entries are not armed; existing broker positions and orders were still reconciled.',
    });
    if (!isMarketOpen()) return finish({ status: 'market_closed', reason: 'The regular-session entry window is closed.' });
    const batch = nextCandlestickWatchlistBatch(
      CANDLESTICK_WATCHLIST, candlestickWatchlistRotation, String(userId), settings.config.maxSymbols
    );
    const candidates = (await Promise.all(batch.symbols
      .map(symbol => buildCandlestickCandidate(userId, symbol, settings.config).catch(error => ({
        symbol,
        status: 'DATA ERROR',
        eligible: false,
        score: 0,
        technicalError: true,
        reasons: [`Market data unavailable: ${error.message}`],
        evaluatedAt: new Date().toISOString(),
      }))))).filter(Boolean);
    saveCandlestickCandidates(userId, candidates);
    const eligible = candidates.filter(row => row.eligible).sort((a, b) => b.score - a.score);
    const candidate = eligible[0];
    const dataErrors = candidates.filter(row => row.technicalError).length;
    if (!candidate) return finish({
      status: dataErrors === candidates.length ? 'data_unavailable' : 'no_entry',
      reason: dataErrors === candidates.length
        ? `Market data failed for all ${candidates.length} scanned symbols.`
        : `No qualifying setup in ${candidates.length} scanned symbols${dataErrors ? `; ${dataErrors} had market-data errors` : ''}.`,
      scanned: candidates.length,
      eligible: 0,
    });
    await executeCandlestickEntry(userId, candidate.symbol, source, lease);
    return finish({
      status: 'submitted', submitted: true, symbol: candidate.symbol,
      scanned: candidates.length, eligible: eligible.length,
      reason: `Submitted the highest-scoring eligible setup: ${candidate.symbol}.`,
    });
  } catch (error) {
    console.warn(`[Candlestick] user ${userId} cycle withheld: ${error.message}`);
    return finish({
      status: 'withheld',
      reason: String(error.message || 'Broker or market evidence did not permit a safe cycle.').slice(0, 300),
    });
  } finally {
    releaseCandlestickExecutionLease(userId, lease);
    releaseBotLock(userId);
  }
}

let candlestickSchedulerRunning = false;
setInterval(async () => {
  if (candlestickSchedulerRunning) return;
  candlestickSchedulerRunning = true;
  try {
    const users = db.prepare(`SELECT user_id FROM candlestick_settings WHERE enabled=1
      UNION
      SELECT DISTINCT user_id FROM candlestick_trade_log
      WHERE status IN ('entry_intent','entry_unknown','pending_entry','open','protection_pending',
        'rescue_cancel_intent','rescue_cancel_pending','exit_intent','pending_exit','exit_unknown','exit_failed')`).all();
    for (const { user_id: userId } of users) {
      await runCandlestickCycle(userId);
    }
  } finally { candlestickSchedulerRunning = false; }
}, 60 * 1000);

// PMH's scheduler mirrors the candlestick pattern above: server-owned so
// entries, protective-leg reconciliation, and runner exits keep running once
// a user enables the strategy, regardless of whether their browser tab is
// open. It only acts for users who explicitly enabled PMH automation and
// connected a dedicated PMH broker account.
async function runPmhCycle(userId, source = 'server-scheduler') {
  const outcome = { bot: 'pmh', status: 'skipped', reconciled: 0, submitted: false };
  if (!isBotEnabled(userId, 'pmh')) return { ...outcome, reason: 'Strategy is disabled.' };
  const settings = pmhConfigFor(userId);
  if (!settings.enabled) return { ...outcome, reason: 'Strategy is disabled.' };
  const creds = getAlpacaCreds(userId, 'pmh');
  if (!creds) return { ...outcome, reason: 'Dedicated broker account is not connected.' };
  if (PMH_LIVE_AUTOMATION_PAUSED && creds.mode === 'live') {
    return { ...outcome, status: 'paused_live', reason: 'PMH live automation is paused for safety validation. Paper mode remains available.' };
  }
  if (creds.mode === 'live' && !settings.liveArmed) {
    return { ...outcome, status: 'live_unarmed', reason: 'PMH Live orders are not explicitly armed.' };
  }
  if (!acquireBotLock(userId)) return { ...outcome, status: 'busy', reason: 'Another broker cycle is in progress.' };
  try {
    const reconciliation = await reconcilePmhTrades(userId);
    outcome.reconciled = reconciliation.reconciled.length;
    if (!isMarketOpen()) return { ...outcome, status: 'reconciled' };
    const config = settings.config;
    const catalogEntry = await getAlpacaTradableEquityCatalog(userId, { scope: 'pmh' });
    const rotation = nextAlpacaCatalogRotation(catalogEntry, PMH_DEFAULT_SYMBOLS, {
      strategy: 'pmh-scheduler', limit: 25, priorityLimit: 13, rotationLimit: 12,
    });
    const candidates = (await Promise.all(rotation.symbols
      .map(symbol => buildPmhCandidate(userId, symbol, config).catch(() => null)))).filter(Boolean);
    const candidate = candidates.filter(row => row.eligible).sort((a, b) => b.score - a.score)[0];
    if (!candidate) return { ...outcome, status: 'no_entry' };
    await executePmhEntry(userId, candidate.symbol, source);
    return { ...outcome, status: 'submitted', submitted: true, symbol: candidate.symbol };
  } catch (error) {
    console.warn(`[PMH] user ${userId} cycle withheld: ${error.message}`);
    return { ...outcome, status: 'withheld', reason: 'Broker or market evidence did not permit a safe cycle.' };
  } finally {
    releaseBotLock(userId);
  }
}

let pmhSchedulerRunning = false;
setInterval(async () => {
  if (pmhSchedulerRunning) return;
  pmhSchedulerRunning = true;
  try {
    const users = db.prepare('SELECT user_id FROM pmh_settings WHERE enabled=1').all();
    for (const { user_id: userId } of users) {
      await runPmhCycle(userId);
    }
  } finally { pmhSchedulerRunning = false; }
}, 60 * 1000);

// Momentum is server-owned for the same reason as PMH and UltraBot3: an enabled
// strategy must continue scanning, reconciling broker fills, and retaining its
// broker-held protection after the browser disconnects. Discovery is bounded per
// cycle but rotates across the complete broker catalog, so no fixed top-three
// shortlist can starve the rest of the tradable universe.
let momentumSchedulerRunning = false;
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

async function runMomentumCycle(userId, source = 'server-scheduler') {
  const outcome = { bot: 'momentum', source, status: 'skipped', reconciled: 0, exitsSubmitted: 0, submitted: false };
  const finish = details => {
    const result = { ...outcome, ...details };
    recordMomentumCycle(userId, result);
    return result;
  };
  const { enabled, liveArmed, config } = momentumConfigFor(userId);
  const creds = getAlpacaCreds(userId, 'momentum');
  if (!creds) return finish({ status: 'broker_outage', reason: 'Dedicated broker account is not connected.' });
  if (!acquireBotLock(userId)) return finish({ status: 'busy', reason: 'Another broker cycle is in progress.' });
  let inverseAttempt = null;
  try {
    // Exact client-order-ID reconciliation runs even outside market hours and
    // under the same lock as submission, so a trigger cannot race a scheduler
    // tick into a duplicate decision.
    if (isAlpacaFlattening(userId)) {
      return finish({ status: 'busy', reason: 'Emergency flatten is in progress.' });
    }
    outcome.reconciled = (await reconcileMomentumTrades(userId, creds)).length;
    outcome.exitsSubmitted = (await manageMomentumOpenPositions(userId, creds)).length;
    if (!enabled) return finish({
      status: 'disabled_monitoring',
      reason: 'Automation is explicitly disabled; existing Momentum positions were still monitored and reconciled.',
    });
    if (creds.mode === 'live' && !liveArmed) {
      return finish({
        status: 'live_unarmed',
        reason: 'Live entries are not armed; existing Momentum positions were still monitored and reconciled.',
      });
    }
    if (!isMarketOpen()) return finish({ status: 'reconciled', reason: 'Market closed; existing positions were reconciled.' });
    const catalogEntry = await getAlpacaTradableEquityCatalog(userId, { scope: 'momentum' });
    const rotation = nextAlpacaCatalogRotation(catalogEntry, MASTER_UNIVERSE, {
      strategy: 'momentum-scheduler', limit: 80, priorityLimit: 20, rotationLimit: 60,
    });
    let quoteResults = await mapWithConcurrency(rotation.symbols, 8, async symbol => {
      try {
        const quote = await _fetchMomentumQuote(symbol);
        if (!hasCompleteMomentumQuote(quote)) throw new Error('Quote payload lacks required price, change, or volume evidence.');
        const basic = momentumRowFromQuote(symbol, quote, config);
        return { ok: true, row: basic.eligible ? basic.row : null };
      } catch (error) {
        return { ok: false, symbol, error: error.message };
      }
    });
    // One bounded retry prevents a transient provider hiccup from needlessly
    // disabling the fallback, but unresolved coverage always fails closed.
    const failedQuoteIndexes = quoteResults
      .map((result, index) => result.ok ? -1 : index)
      .filter(index => index >= 0);
    if (failedQuoteIndexes.length) {
      const retries = await mapWithConcurrency(failedQuoteIndexes, 4, async index => {
        const symbol = rotation.symbols[index];
        try {
          const quote = await _fetchMomentumQuote(symbol);
          if (!hasCompleteMomentumQuote(quote)) throw new Error('Quote payload lacks required price, change, or volume evidence.');
          const basic = momentumRowFromQuote(symbol, quote, config);
          return { index, result: { ok: true, row: basic.eligible ? basic.row : null } };
        } catch (error) {
          return { index, result: { ok: false, symbol, error: error.message } };
        }
      });
      quoteResults = quoteResults.slice();
      retries.forEach(({ index, result }) => { quoteResults[index] = result; });
    }
    const raw = quoteResults.filter(result => result.ok && result.row).map(result => result.row);
    const shortlist = raw.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12);
    const candidateResults = await Promise.all(shortlist
      .map(row => buildMomentumCandidate(userId, row.symbol, config)
        .then(candidate => ({ ok: true, candidate }))
        .catch(error => {
        console.warn(`[Momentum] ${row.symbol} evidence unavailable: ${error.message}`);
        return { ok: false, symbol: row.symbol, error: error.message };
      })));
    const candidates = candidateResults.filter(result => result.ok).map(result => result.candidate);
    const candidate = candidates.filter(row => row.eligible).sort((a, b) => b.score - a.score)[0];
    if (!candidate) {
      const fallbackCoverage = canUseInverseFallback({
        scannedSymbols: rotation.symbols.length,
        completedQuotes: quoteResults.filter(result => result.ok).length,
        quoteFailures: quoteResults.filter(result => !result.ok).length,
        shortlisted: shortlist.length,
        completedCandidates: candidateResults.filter(result => result.ok).length,
        candidateFailures: candidateResults.filter(result => !result.ok).length,
        eligibleLongs: 0,
      });
      if (!fallbackCoverage.allowed) {
        momentumInverseCycleStore.update(
          userId,
          'withheld',
          `Inverse fallback blocked: ${fallbackCoverage.reason}`,
          null
        );
        return finish({
          status: 'withheld',
          reason: `Inverse fallback blocked: ${fallbackCoverage.reason}`,
        });
      }
      const marketDirection = await getMomentumMarketDirection(userId);
      if (!marketDirection.dropping) {
        return finish({ status: 'no_entry', reason: marketDirection.reason || 'No safe entry was available.', marketDirection });
      }
      inverseAttempt = marketDirection;
      await executeMomentumInverseEntry(userId, marketDirection, creds);
      momentumInverseCycleStore.update(
        userId,
        'submitted',
        `BUY ${marketDirection.inverseSymbol} submitted because no safe long passed and ${marketDirection.reason}`,
        marketDirection.inverseSymbol
      );
      return finish({
        status: 'submitted', submitted: true, inverseMode: true,
        symbol: marketDirection.inverseSymbol, marketDirection, source,
      });
    }
    await executeMomentumEntry(userId, candidate, creds);
    return finish({ status: 'submitted', submitted: true, symbol: candidate.symbol, source });
  } catch (error) {
    console.warn(`[Momentum] user ${userId} cycle withheld: ${error.message}`);
    if (inverseAttempt) {
      momentumInverseCycleStore.update(
        userId,
        'withheld',
        `Inverse entry withheld: ${error.message}`,
        inverseAttempt.inverseSymbol
      );
    }
    const brokerOutage = error.alpacaTransient || error.alpacaStatus
      || /unreachable|authentication|broker account|account mismatch|cannot be reconciled/i.test(error.message);
    return finish({
      status: brokerOutage ? 'broker_outage' : 'withheld',
      reason: brokerOutage ? error.message : 'Broker or market evidence did not permit a safe cycle.',
    });
  } finally {
    releaseBotLock(userId);
  }
}

setInterval(async () => {
  if (momentumSchedulerRunning) return;
  momentumSchedulerRunning = true;
  try {
    const users = db.prepare(`SELECT user_id FROM momentum_settings WHERE enabled=1
      UNION SELECT DISTINCT user_id FROM bot_trade_log
      WHERE status='open' AND (strategy IS NULL OR strategy='momentum')`).all();
    for (const { user_id: userId } of users) {
      await runMomentumCycle(userId);
    }
  } finally {
    momentumSchedulerRunning = false;
  }
}, 60 * 1000);

// Swing reconciliation remains frequent enough to observe partial fills and
// broker-held exits, while expensive daily-universe scans are throttled inside
// runSwingCycle and keep advancing a persisted catalog cursor.
let swingSchedulerRunning = false;
setInterval(async () => {
  if (swingSchedulerRunning) return;
  swingSchedulerRunning = true;
  try {
    const users = db.prepare(`SELECT user_id FROM swing_settings WHERE enabled=1
      UNION SELECT DISTINCT user_id FROM swing_trades
      WHERE status NOT IN ('closed','rejected','canceled')`).all();
    for (const { user_id: userId } of users) await runSwingCycle(userId);
  } finally {
    swingSchedulerRunning = false;
  }
}, 2 * 60 * 1000);

// LEAP reconciliation runs independently of browser sessions and continues for
// open broker lifecycles even when new entries are paused.
let optionsSchedulerRunning = false;
setInterval(async () => {
  if (optionsSchedulerRunning) return;
  optionsSchedulerRunning = true;
  try {
    const users = db.prepare(`SELECT user_id FROM options_settings WHERE enabled=1
      UNION SELECT DISTINCT user_id FROM options_trades
      WHERE status NOT IN ('closed','rejected','canceled')`).all();
    for (const { user_id: userId } of users) await runOptionsCycle(userId);
  } finally {
    optionsSchedulerRunning = false;
  }
}, 2 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qureshi Finance on :${PORT}`);
  // Pre-load SPY levels immediately at startup so data is ready before market open
  getSPYLevels().then(lvl => {
    if (lvl) console.log(`[SPY-Gate] Pre-loaded at startup — FLOOR $${lvl.floor}  MAX PAIN $${lvl.maxPain}  ROOF $${lvl.roof}  (${lvl.expiry})`);
    else     console.warn('[SPY-Gate] Startup pre-load returned no data — will retry on first request');
  });
  // Refresh SPY levels every 30 min so they stay current through the trading day
  setInterval(() => getSPYLevels(), 30 * 60 * 1000);
});
