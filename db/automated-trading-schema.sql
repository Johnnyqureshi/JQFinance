-- Development schema for durable automated-trading state.
-- Replit applies this schema to production during Publish; never run it
-- against production from application startup or a deploy hook.

CREATE TABLE IF NOT EXISTS broker_account_owners (
  account_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('manual','b2','options')),
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS broker_account_quarantine (
  account_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS automatic_live_bot_arms (
  user_id BIGINT PRIMARY KEY REFERENCES app_auth_users(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('b2','options')),
  armed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS b2_settings (
  user_id BIGINT PRIMARY KEY REFERENCES app_auth_users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  live_armed BOOLEAN NOT NULL DEFAULT FALSE,
  max_position_dollars NUMERIC(18,2) NOT NULL DEFAULT 1000 CHECK (max_position_dollars >= 1),
  revision BIGINT NOT NULL DEFAULT 0,
  last_cycle_at TIMESTAMPTZ,
  scheduler_status TEXT NOT NULL DEFAULT 'idle',
  scheduler_reason TEXT,
  data_error TEXT,
  data_feed TEXT NOT NULL DEFAULT 'sip' CHECK (data_feed IN ('sip','iex')),
  automation_revision BIGINT NOT NULL DEFAULT 0,
  market_open BOOLEAN,
  market_clock_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS b2_credentials (
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  account_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_secret TEXT NOT NULL,
  PRIMARY KEY (user_id, mode),
  UNIQUE (account_id, mode)
);
CREATE TABLE IF NOT EXISTS b2_leases (
  user_id BIGINT PRIMARY KEY REFERENCES app_auth_users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS b2_universe (
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset JSONB NOT NULL,
  PRIMARY KEY (account_id, symbol)
);
CREATE TABLE IF NOT EXISTS b2_coverage (
  account_id TEXT PRIMARY KEY,
  cursor BIGINT NOT NULL DEFAULT 0,
  scanned BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ,
  catalog_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS b2_candidates (
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  result JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, symbol)
);
CREATE TABLE IF NOT EXISTS b2_priority (
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  relative_volume DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, symbol)
);
CREATE TABLE IF NOT EXISTS b2_trades (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  symbol TEXT NOT NULL,
  event_id TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  order_id TEXT,
  status TEXT NOT NULL,
  entry_price NUMERIC(18,6),
  filled_shares NUMERIC(18,6) NOT NULL DEFAULT 0,
  stop_price NUMERIC(18,6),
  stop_id TEXT,
  exit_id TEXT,
  exit_client_id TEXT,
  exit_price NUMERIC(18,6),
  pnl NUMERIC(18,6),
  protection TEXT NOT NULL DEFAULT 'unknown',
  exit_requested BOOLEAN NOT NULL DEFAULT FALSE,
  last_exit_session TEXT,
  signal_date TEXT,
  restore_client_id TEXT,
  exit_rejected BOOLEAN NOT NULL DEFAULT FALSE,
  exit_generation BIGINT NOT NULL DEFAULT 0,
  retry_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, symbol, event_id)
);
CREATE TABLE IF NOT EXISTS b2_exit_fills (
  trade_id BIGINT NOT NULL REFERENCES b2_trades(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  shares NUMERIC(18,6) NOT NULL,
  price NUMERIC(18,6) NOT NULL,
  PRIMARY KEY (trade_id, order_id)
);
CREATE TABLE IF NOT EXISTS b2_close_attempts (
  trade_id BIGINT NOT NULL REFERENCES b2_trades(id) ON DELETE CASCADE,
  generation BIGINT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  order_id TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trade_id, generation)
);
CREATE TABLE IF NOT EXISTS b2_alerts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  account_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS options_settings (
  user_id BIGINT PRIMARY KEY REFERENCES app_auth_users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  live_armed BOOLEAN NOT NULL DEFAULT FALSE,
  activation_revision BIGINT NOT NULL DEFAULT 0,
  max_position_dollars NUMERIC(18,2) NOT NULL DEFAULT 1000 CHECK (max_position_dollars >= 1),
  last_cycle_at TIMESTAMPTZ,
  last_cycle_status TEXT,
  last_cycle_reason TEXT,
  last_scan_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS options_alpaca_creds (
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  api_key TEXT NOT NULL,
  api_secret TEXT NOT NULL,
  api_key_enc TEXT,
  api_secret_enc TEXT,
  account_id TEXT,
  PRIMARY KEY (user_id, mode),
  UNIQUE (user_id, account_id)
);
CREATE TABLE IF NOT EXISTS options_alpaca_active_mode (
  user_id BIGINT PRIMARY KEY REFERENCES app_auth_users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live'))
);
CREATE TABLE IF NOT EXISTS options_candidates (
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  payload JSONB NOT NULL,
  signal_bar_at TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, symbol)
);
CREATE TABLE IF NOT EXISTS options_entry_reservations (
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  signal_bar_at TIMESTAMPTZ NOT NULL,
  trade_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, symbol, signal_bar_at)
);
CREATE TABLE IF NOT EXISTS options_trades (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  underlying_symbol TEXT NOT NULL,
  contract_symbol TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'entry_intent',
  requested_contracts INTEGER NOT NULL,
  filled_contracts INTEGER NOT NULL DEFAULT 0,
  contracts_remaining INTEGER NOT NULL DEFAULT 0,
  entry_price NUMERIC(18,6),
  target_price NUMERIC(18,6),
  strike_price NUMERIC(18,6) NOT NULL,
  expiration_date DATE NOT NULL,
  multiplier INTEGER NOT NULL DEFAULT 100,
  signal_bar_at TIMESTAMPTZ NOT NULL,
  setup JSONB NOT NULL DEFAULT '{}'::jsonb,
  entry_client_order_id TEXT NOT NULL UNIQUE,
  entry_order_id TEXT,
  target_client_order_id TEXT,
  target_order_id TEXT,
  target_revision BIGINT NOT NULL DEFAULT 0,
  thesis_exit_client_order_id TEXT,
  thesis_exit_order_id TEXT,
  exit_reason TEXT,
  pnl NUMERIC(18,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS options_fills (
  trade_id BIGINT NOT NULL REFERENCES options_trades(id) ON DELETE CASCADE,
  broker_order_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price NUMERIC(18,6) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trade_id, broker_order_id)
);
CREATE TABLE IF NOT EXISTS options_alerts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  symbol TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS options_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  trade_id BIGINT REFERENCES options_trades(id) ON DELETE SET NULL,
  symbol TEXT,
  event_type TEXT NOT NULL,
  reason_code TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS options_execution_leases (
  user_id BIGINT PRIMARY KEY REFERENCES app_auth_users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS broker_order_intents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_auth_users(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('b2','options')),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  trade_id BIGINT,
  purpose TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  request JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','submission_unknown','submitted','rejected','canceled')),
  broker_order_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy, account_id, client_order_id)
);

-- Fenced durable image used by the single VM dispatcher. The image is a
-- consistent SQLite serialization, never a raw WAL file copy.
CREATE TABLE IF NOT EXISTS automated_trading_snapshots (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  generation BIGINT NOT NULL CHECK (generation >= 0),
  schema_version INTEGER NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  image BYTEA NOT NULL,
  fence_epoch BIGINT NOT NULL CHECK (fence_epoch >= 0),
  fence_owner TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'checkpoint',
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automated_trading_fences (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  owner_id TEXT,
  epoch BIGINT NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO automated_trading_fences(singleton, epoch)
VALUES (TRUE, 0)
ON CONFLICT (singleton) DO NOTHING;

-- Replit's publish-time schema differ wraps PostgreSQL check definitions.
-- A bare boolean CHECK (singleton) was emitted as invalid
-- CHECK (CHECK (singleton)); the primary key plus application-owned TRUE key
-- already enforce the one-row access pattern.
ALTER TABLE automated_trading_snapshots
  DROP CONSTRAINT IF EXISTS automated_trading_snapshots_singleton_check;
ALTER TABLE automated_trading_fences
  DROP CONSTRAINT IF EXISTS automated_trading_fences_singleton_check;
-- Singles & Doubles strategy scope (sd_*). SQLite-first DDL; sd-service also
-- runs these as CREATE TABLE IF NOT EXISTS at runtime. Kept identical.
CREATE TABLE IF NOT EXISTS sd_settings (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'paper',
  paper INTEGER NOT NULL DEFAULT 1,
  single_target_pct REAL NOT NULL DEFAULT 1.0,
  double_target_pct REAL NOT NULL DEFAULT 2.0,
  partial_sell_pct REAL NOT NULL DEFAULT 50,
  min_quality_score INTEGER NOT NULL DEFAULT 7,
  max_risk_per_trade REAL NOT NULL DEFAULT 250,
  max_daily_loss REAL NOT NULL DEFAULT 500,
  max_open_positions INTEGER NOT NULL DEFAULT 3,
  max_total_exposure REAL NOT NULL DEFAULT 5000,
  max_trades_per_day INTEGER NOT NULL DEFAULT 10,
  max_position_dollars REAL NOT NULL DEFAULT 2000,
  eod_flatten INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  automation_revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sd_credentials (
  user_id TEXT NOT NULL, mode TEXT NOT NULL,
  key_enc TEXT NOT NULL, secret_enc TEXT NOT NULL,
  updated_at TEXT, PRIMARY KEY (user_id, mode)
);
CREATE TABLE IF NOT EXISTS sd_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL, symbol TEXT NOT NULL, event_id TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'long',
  status TEXT NOT NULL DEFAULT 'pending',
  setup TEXT, quality_score INTEGER,
  entry_price REAL, filled_shares REAL DEFAULT 0,
  stop_price REAL, single_target REAL, double_target REAL,
  partial_taken INTEGER NOT NULL DEFAULT 0,
  exit_price REAL, pnl REAL,
  exit_reason TEXT, client_id TEXT,
  signal_date TEXT, created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(account_id, symbol, event_id)
);
CREATE TABLE IF NOT EXISTS sd_exit_fills (id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER, fill_price REAL, fill_qty REAL, proceeds REAL, filled_at TEXT);
CREATE TABLE IF NOT EXISTS sd_close_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER, attempt TEXT, result TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sd_scan_runs (run_id TEXT PRIMARY KEY, started_at TEXT, symbols_scanned INTEGER DEFAULT 0, liquidity_pass INTEGER DEFAULT 0, momentum_pass INTEGER DEFAULT 0, vwap_pass INTEGER DEFAULT 0, quality_score_pass INTEGER DEFAULT 0, risk_pass INTEGER DEFAULT 0, orders_attempted INTEGER DEFAULT 0, orders_accepted INTEGER DEFAULT 0, orders_rejected INTEGER DEFAULT 0, orders_filled INTEGER DEFAULT 0, positions_opened INTEGER DEFAULT 0, positions_closed INTEGER DEFAULT 0, winning_trades INTEGER DEFAULT 0, losing_trades INTEGER DEFAULT 0, realized_pnl REAL DEFAULT 0, unrealized_pnl REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sd_rejections (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, symbol TEXT NOT NULL, stage TEXT NOT NULL, reason TEXT);
CREATE TABLE IF NOT EXISTS sd_candidates (symbol TEXT PRIMARY KEY, outcome TEXT, score INTEGER, setup TEXT, gates TEXT, reasons TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sd_universe (symbol TEXT PRIMARY KEY, name TEXT, price REAL, avg_volume REAL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sd_coverage (id INTEGER PRIMARY KEY CHECK (id=1), cursor TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sd_leases (user_id TEXT PRIMARY KEY, token TEXT, generation INTEGER DEFAULT 1, expires_at TEXT);
CREATE TABLE IF NOT EXISTS sd_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, message TEXT, created_at TEXT DEFAULT (datetime('now')));
