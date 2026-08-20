require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const fetch        = require('node-fetch');
const YahooFinance = require('yahoo-finance2').default;
const Database     = require('better-sqlite3');
const bcrypt       = require('bcryptjs');
const session      = require('express-session');
const SQLiteStore  = require('connect-sqlite3')(session);
const helmet       = require('helmet');
const crypto       = require('crypto');
const {
  CATALYST_TERMS,
  buildCatalystEvent,
  dedupeEvents,
} = require('./lib/catalyst-intel');

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

// ── SQLite Database ────────────────────────────────────────────────────────────
const db = new Database('jqf.db');
db.pragma('journal_mode = WAL');
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
    mode       TEXT    DEFAULT 'paper',
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
].forEach(sql => { try { db.prepare(sql).run(); } catch(_) {} });

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
          mode       TEXT    NOT NULL DEFAULT 'paper',
          PRIMARY KEY (user_id, mode),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO alpaca_creds_new (user_id, api_key, api_secret, mode)
          SELECT user_id, api_key, api_secret, COALESCE(mode,'paper') FROM alpaca_creds;
        DROP TABLE alpaca_creds;
        ALTER TABLE alpaca_creds_new RENAME TO alpaca_creds;
      `);
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

// ── App settings table (persists generated secrets etc.) ──────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`).run();

// ── Seed: ensure the primary admin account always exists ─────────────────────
// This runs at startup so the account is present even on a fresh deployment DB.
// The hash below is bcrypt of 'JQFinance2024!' (rounds=10).
// On every startup we upsert the admin account so a stale or missing hash
// in any environment (dev or production) is automatically corrected.
(function seedAdminUser() {
  const ADMIN_USER = 'johnnyqureshi';
  const ADMIN_HASH = '$2b$10$jqVXi70VTQegfWo3GiVvi.a4fl5QGzh34.tIzRwxIYjvu33SClh.a';
  const existing = db.prepare('SELECT id, password_hash FROM users WHERE LOWER(username)=LOWER(?)').get(ADMIN_USER);
  if (!existing) {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(ADMIN_USER, ADMIN_HASH);
    console.log(`[Seed] Created admin account: ${ADMIN_USER}`);
  } else if (existing.password_hash !== ADMIN_HASH) {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(ADMIN_HASH, existing.id);
    console.log(`[Seed] Reset admin password hash for: ${ADMIN_USER}`);
  }
})();

// Generate or retrieve a persistent session secret so sessions survive restarts
// and cannot be forged even if SESSION_SECRET env var is absent.
function getSessionSecret() {
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret && envSecret.length >= 32) return envSecret;
  const row = db.prepare("SELECT value FROM app_settings WHERE key='session_secret'").get();
  if (row) return row.value;
  const generated = crypto.randomBytes(64).toString('hex');
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('session_secret', ?)").run(generated);
  console.log('[Security] No SESSION_SECRET env var found — generated and stored a random secret in DB.');
  return generated;
}
const SESSION_SECRET = getSessionSecret();

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

// ── Startup migration: ensure all 3 active bots are enabled ───────────────────
// Deletes any explicitly-disabled rows for the current bot names so they
// revert to the default ON state. If a user disables a bot via the UI toggle
// it persists until the next restart/redeploy, at which point it resets to ON.
// This prevents bots from silently staying off after a container restart.
db.prepare(`
  DELETE FROM bot_toggles
  WHERE bot_name IN ('countertrend','orb','swing') AND enabled = 0
`).run();

// ── Startup: sync alpaca_creds from env vars (paper + live independently) ─────
// Supports two naming conventions so either works without renaming:
//   Paper:  ALPACA_PAPER_KEY / ALPACA_PAPER_SECRET
//           ALPACA_API_KEY   / ALPACA_API_SECRET  (alias)
//           ALPACA_API_KEY   / ALPACA_SECRET_KEY  (alias — user preferred)
//   Live:   ALPACA_LIVE_KEY  / ALPACA_LIVE_SECRET
//   Mode:   ALPACA_MODE = "paper" (default) or "live" — sets the active mode
{
  const paperKey    = process.env.ALPACA_PAPER_KEY
                   || process.env.ALPACA_API_KEY;
  const paperSecret = process.env.ALPACA_PAPER_SECRET
                   || process.env.ALPACA_API_SECRET
                   || process.env.ALPACA_SECRET_KEY;
  const liveKey     = process.env.ALPACA_LIVE_KEY;
  const liveSecret  = process.env.ALPACA_LIVE_SECRET
                   || process.env.ALPACA_LIVE_SECRET_KEY;
  const activeMode  = (process.env.ALPACA_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';

  if (paperKey && paperSecret) {
    db.prepare(`INSERT OR REPLACE INTO alpaca_creds (user_id, api_key, api_secret, mode) VALUES (1,?,?,'paper')`).run(paperKey, paperSecret);
    console.log('[Startup] Synced paper alpaca_creds from env vars');
  }
  if (liveKey && liveSecret) {
    db.prepare(`INSERT OR REPLACE INTO alpaca_creds (user_id, api_key, api_secret, mode) VALUES (1,?,?,'live')`).run(liveKey, liveSecret);
    console.log('[Startup] Synced live alpaca_creds from env vars');
  }
  if (paperKey || liveKey) {
    db.prepare(`INSERT OR REPLACE INTO alpaca_active_mode (user_id, mode) VALUES (1, ?)`).run(activeMode);
  }
}

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
app.use(session({
  store:             new SQLiteStore({ db: 'sessions.db', dir: '.' }),
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

// Auth guard helper
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
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
    const stats = summary?.defaultKeyStatistics || {};
    const detail = summary?.summaryDetail || {};
    const floatShares = Number.isFinite(stats.floatShares) ? stats.floatShares : null;
    const sharesOutstanding = Number.isFinite(stats.sharesOutstanding)
      ? stats.sharesOutstanding
      : Number.isFinite(detail.sharesOutstanding) ? detail.sharesOutstanding : null;
    const data = {
      float: floatShares ?? sharesOutstanding,
      floatShares,
      sharesOutstanding,
      floatSource: floatShares != null ? 'floatShares' : sharesOutstanding != null ? 'sharesOutstanding' : null,
    };
    _floatCacheSet(sym, data);
    return data;
  } catch (_) {
    // The scanner can still use quote.floatShares when quoteSummary is
    // unavailable (for example, a temporary Yahoo module/rate-limit failure).
    return { float: null, floatShares: null, sharesOutstanding: null, floatSource: null };
  }
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
    const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    const info = stmt.run(u, hash);
    req.session.userId   = info.lastInsertRowid;
    req.session.username = u;
    req.session.save(() => res.json({ id: info.lastInsertRowid, username: u }));
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken.' });
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// Login
app.post('/api/auth/login', rateLimitAuth, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) ORDER BY id ASC LIMIT 1').get(username.trim());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.save(() => res.json({ id: user.id, username: user.username }));
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
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found.' });
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);
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

async function alpacaDataFetch(userId, path, _attempt = 0) {
  try {
    const creds = getAlpacaCreds(userId);
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
        return alpacaDataFetch(userId, path, _attempt + 1);
      }
      return null;
    }
    clearTimeout(timeoutId);
    if (r.status === 429 && _attempt < 2) {
      await new Promise(res => setTimeout(res, 2000 * (_attempt + 1)));
      return alpacaDataFetch(userId, path, _attempt + 1);
    }
    if ([502, 503, 504].includes(r.status) && _attempt < 2) {
      await new Promise(res => setTimeout(res, 1500 * (_attempt + 1)));
      return alpacaDataFetch(userId, path, _attempt + 1);
    }
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// Returns any userId that has Alpaca credentials — used by non-auth endpoints
// so they can still benefit from Alpaca data without being session-bound.
function getAnyAlpacaUserId() {
  // Must skip sentinel rows — disconnected users have api_key = '__disconnected__'
  // and must not be used to make live API calls.
  const rows = db.prepare('SELECT user_id FROM alpaca_creds').all();
  for (const r of rows) {
    if (getAlpacaCreds(r.user_id)) return r.user_id;
  }
  return null;
}

// Fetch Alpaca snapshot(s) for one or more symbols.
// Returns { AAPL: { latestTrade, latestQuote, minuteBar, dailyBar, prevDailyBar }, ... }
async function alpacaSnapshotFetch(userId, symbols) {
  const syms = Array.isArray(symbols) ? symbols.join(',') : symbols;
  return alpacaDataFetch(userId, `/v2/stocks/snapshots?symbols=${encodeURIComponent(syms)}&feed=iex`);
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
  };
}

// ── fetchLiveQuote: Alpaca-first, Yahoo-fallback ───────────────────────────────
// Single source of truth for real-time price throughout the app.
// data.alpaca.markets is the primary feed (24/7); Yahoo Finance is the safety net.
async function fetchLiveQuote(symbol, userId = null) {
  const uid = userId ?? getAnyAlpacaUserId();
  if (uid) {
    try {
      const snap = await alpacaSnapshotFetch(uid, symbol);
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
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const q = await fetchLiveQuote(req.params.symbol.toUpperCase());
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/snapshots?symbols=A,B ────────────────────────────────────────────
// Alpaca batch snapshot tried first (one call, 24/7); Yahoo Finance fallback.
app.get('/api/snapshots', async (req, res) => {
  const syms = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!syms.length) return res.json({});
  try {
    const uid = getAnyAlpacaUserId();
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
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

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
      if (out.length) { _searchCacheSet(cacheKey, out); return res.json(out); }
    }
  } catch { /* fall through to Alpaca */ }

  // ── 2. Alpaca asset catalogue fallback (works 24/7, no rate limits) ─────────
  try {
    const uid = getAnyAlpacaUserId();
    if (uid) {
      const upper = q.toUpperCase();
      // Try exact symbol match first
      const exact = await alpacaDataFetch(uid, `/v2/assets/${upper}`).catch(() => null);
      if (exact?.symbol) {
        const out = [{ symbol: exact.symbol, name: exact.name || exact.symbol, exchange: exact.exchange || '', quoteType: exact.class === 'crypto' ? 'CRYPTOCURRENCY' : 'EQUITY' }];
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
        if (matched.length) { _searchCacheSet(cacheKey, matched); return res.json(matched); }
      }
    }
  } catch { /* fall through */ }

  res.json([]);
});

// ── GET /api/bars/:symbol?timeframe=&limit= ───────────────────────────────────
app.get('/api/bars/:symbol', async (req, res) => {
  const sym   = req.params.symbol.toUpperCase();
  const tf    = req.query.timeframe || '1Day';
  const limit = parseInt(req.query.limit) || 60;

  // ── Try Alpaca bars first (24/7, includes extended-hours OHLCV) ────────────
  const uid = getAnyAlpacaUserId();
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
        const floatSh   = fundamentals.float
          ?? quote.floatShares
          ?? null;
        const floatSource = fundamentals.float != null
          ? fundamentals.floatSource
          : quote.floatShares != null ? 'quote' : null;
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
          float: floatSh, floatSh, floatShares: fundamentals.floatShares ?? quote.floatShares ?? null,
          sharesOutstanding: fundamentals.sharesOutstanding ?? null, floatSource,
          marketCap, w52Dist,
        };
      } catch { return null; }
    }));
    out.push(...settled.map(r => r.value).filter(Boolean));
  }
  res.json({ results: out });
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
app.get('/api/intraday/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    const uid = getAnyAlpacaUserId();

    // ── Alpaca path ───────────────────────────────────────────────────────────
    if (uid) {
      const [barsData, snapData] = await Promise.all([
        alpacaDataFetch(uid, `/v2/stocks/${sym}/bars?timeframe=5Min&limit=100&adjustment=all&feed=iex`).catch(() => null),
        alpacaSnapshotFetch(uid, sym).catch(() => null),
      ]);
      if (barsData?.bars?.length) {
        const bars  = barsData.bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
        const snap  = snapData?.[sym];
        const normQ = snap ? _normaliseAlpacaSnapshot(sym, snap) : null;
        const marketState = currentMarketState();
        return res.json({
          bars,
          price:         normQ?.price ?? bars.at(-1)?.c ?? null,
          regularClose:  normQ?.regularClose ?? bars.at(-1)?.c ?? null,
          extendedPrice: normQ?.extendedPrice ?? null,
          extendedType:  normQ?.extendedType  ?? null,
          marketState,
          previousClose: normQ?.previousClose ?? null,
          open:          normQ?.open ?? bars[0]?.o ?? null,
        });
      }
    }

    // ── Yahoo Finance fallback ────────────────────────────────────────────────
    const [chartRes, yfQuote] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=1d&includePrePost=true`, { headers: YH }),
      yf.quote(sym, {}, { validateResult: false }).catch(() => null),
    ]);

    if (!chartRes.ok) return res.json({ bars: [], price: null });
    const d  = await chartRes.json();
    const rs = d?.chart?.result?.[0];
    if (!rs) return res.json({ bars: [], price: null });

    const times = rs.timestamp || [];
    const q     = rs.indicators?.quote?.[0] || {};
    const bars  = times.map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      o: q.open?.[i]   ?? null, h: q.high?.[i]   ?? null,
      l: q.low?.[i]    ?? null, c: q.close?.[i]  ?? null,
      v: q.volume?.[i] ?? null,
    })).filter(b => b.c != null);

    const marketState = yfQuote?.marketState || 'CLOSED';
    const isPost = ['POST', 'POSTPOST'].includes(marketState);
    const isPre  = ['PRE',  'PREPRE' ].includes(marketState);
    const regPrice = yfQuote?.regularMarketPrice ?? bars.at(-1)?.c ?? null;
    let extendedPrice = null;
    if (isPost)     extendedPrice = yfQuote?.postMarketPrice ?? null;
    else if (isPre) extendedPrice = yfQuote?.preMarketPrice ?? yfQuote?.postMarketPrice ?? null;

    res.json({
      bars,
      price:         extendedPrice ?? regPrice,
      regularClose:  regPrice,
      extendedPrice,
      extendedType:  isPost ? 'AH' : (isPre && yfQuote?.preMarketPrice != null) ? 'PRE' : (isPre && extendedPrice != null) ? 'AH' : null,
      marketState,
      previousClose: yfQuote?.regularMarketPreviousClose ?? null,
      open:          yfQuote?.regularMarketOpen ?? bars[0]?.o ?? null,
    });
  } catch (e) {
    console.error('Intraday error:', e.message);
    res.json({ bars: [], price: null });
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
const GP_CACHE_MS = 3 * 60 * 1000;
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

async function gpFetchIntraday5m(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d&includePrePost=true`;
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

function gpATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
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

// Historical analogs: past days with a 1-day drop >= threshold%.
// Measures what actually happened the SAME day (low→close rebound) and the NEXT day.
function gpAnalogs(daily, thresholdPct) {
  const events = [];
  for (let i = 1; i < daily.length - 1; i++) {
    const chg = ((daily[i].c - daily[i - 1].c) / daily[i - 1].c) * 100;
    if (chg > -thresholdPct) continue;
    const day = daily[i], next = daily[i + 1];
    const reboundClose = day.l > 0 ? ((day.c - day.l) / day.l) * 100 : 0;   // low → close
    const reboundHigh  = day.l > 0 ? ((Math.max(day.h, next.h) - day.l) / day.l) * 100 : 0;
    const nextRet      = ((next.c - day.c) / day.c) * 100;
    // max further downside over following 3 days
    let minLow = day.l;
    for (let j = i + 1; j <= Math.min(i + 3, daily.length - 1); j++) minLow = Math.min(minLow, daily[j].l);
    events.push({
      reboundClose, reboundHigh, nextRet,
      nextGreen: next.c > next.o,
      bounced3: reboundClose >= 3,
      bounced5: reboundClose >= 5,
      furtherDown: ((minLow - day.l) / day.l) * 100,
    });
  }
  if (!events.length) return null;
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const pct = f => Math.round((events.filter(f).length / events.length) * 100);
  return {
    sampleSize: events.length,
    lowConfidence: events.length < 10,
    bounced3Pct: pct(e => e.bounced3),
    bounced5Pct: pct(e => e.bounced5),
    closedGreenNextPct: pct(e => e.nextGreen),
    avgMaxReboundPct: +avg(events.map(e => e.reboundHigh)).toFixed(1),
    medMaxReboundPct: +med(events.map(e => e.reboundHigh)).toFixed(1),
    avgNextDayPct: +avg(events.map(e => e.nextRet)).toFixed(1),
    maxFurtherDownsidePct: +Math.min(...events.map(e => e.furtherDown)).toFixed(1),
  };
}

// Swing highs/lows (5-bar pivots) from recent daily bars
function gpSwings(daily, lookback = 90) {
  const bars = daily.slice(-lookback);
  const highs = [], lows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const w = bars.slice(i - 2, i + 3);
    if (bars[i].h === Math.max(...w.map(b => b.h))) highs.push(bars[i].h);
    if (bars[i].l === Math.min(...w.map(b => b.l))) lows.push(bars[i].l);
  }
  return { highs, lows };
}

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
    const [quote, daily, intra, profile, mktRaw] = await Promise.all([
      fetchLiveQuote(sym, req.session.userId).catch(() => null),
      gpFetchDaily(sym, '2y'),
      gpFetchIntraday5m(sym),
      yf.quoteSummary(sym, { modules: ['assetProfile'] }, { validateResult: false }).catch(() => null),
      yf.quote(['SPY', 'QQQ', 'IWM'], {}, { validateResult: false }).catch(() => null),
    ]);

    if (!quote?.price || !daily?.length) {
      return { ok: false, unavailable: true, symbol: sym, error: 'REAL-TIME DATA UNAVAILABLE' };
    }

    const dataGaps = [];
    const price  = quote.price;
    const closes = daily.map(b => b.c);
    const atr    = gpATR(daily);
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
    const dropMag = chg1d != null && chg1d < 0 ? Math.abs(chg1d) : null;
    const threshold = dropMag == null ? null : dropMag >= 10 ? 10 : dropMag >= 8 ? 8 : dropMag >= 5 ? 5 : null;
    const analogs = threshold ? gpAnalogs(daily, threshold) : null;

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
        news = (nd.news || []).slice(0, 5).map(n => ({
          headline: n.title, source: n.publisher,
          date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10) : null,
        }));
      }
    } catch { /* news optional */ }
    if (!news.length) dataGaps.push('No recent news retrieved');

    // Key levels
    const prevDay = daily.at(-2) || null;
    const swings = gpSwings(daily);
    const candidates = [];
    const push = (p, label) => { if (p != null && isFinite(p) && p > 0) candidates.push({ price: +(+p).toFixed(2), label }); };
    if (prevDay) { push(prevDay.h, "Prev day high"); push(prevDay.l, "Prev day low"); }
    push(quote.dayHigh, 'Today high'); push(quote.dayLow, 'Today low');
    push(vwap, 'VWAP');
    if (premarket) { push(premarket.high, 'Premarket high'); push(premarket.low, 'Premarket low'); }
    push(indicators.sma20, 'SMA 20'); push(indicators.sma50, 'SMA 50'); push(indicators.sma200, 'SMA 200');
    swings.highs.slice(-3).forEach(h => push(h, 'Swing high'));
    swings.lows.slice(-3).forEach(l => push(l, 'Swing low'));
    const inRange = candidates.filter(c => Math.abs(c.price - price) / price <= 0.15);
    const dedupe = arr => {
      const out = [];
      arr.forEach(c => {
        const near = out.find(o => Math.abs(o.price - c.price) / price < 0.004);
        if (near) near.label += ' + ' + c.label; else out.push({ ...c });
      });
      return out;
    };
    const support = dedupe(inRange.filter(c => c.price < price).sort((a, b) => b.price - a.price)).slice(0, 3);
    const resistance = dedupe(inRange.filter(c => c.price > price).sort((a, b) => a.price - b.price)).slice(0, 3);
    const breakdown = support.length ? +(support.at(-1).price - (atr ?? price * 0.02) * 0.5).toFixed(2) : null;
    const levels = { support, resistance, breakdown, currentPrice: +price.toFixed(2) };

    // Probabilities — analog base rates adjusted by live context, rounded to 5s
    const clamp5 = v => Math.max(5, Math.min(95, Math.round(v / 5) * 5));
    let pBounce, pGreen, p3, p5;
    if (analogs && !analogs.lowConfidence) {
      pBounce = analogs.bounced3Pct * 0.6 + 40 * 0.4;
      p3 = analogs.bounced3Pct; p5 = analogs.bounced5Pct;
      pGreen = analogs.closedGreenNextPct;
    } else {
      pBounce = 50; p3 = 40; p5 = 25; pGreen = 45;
    }
    const adj = (indicators.distVwapPct != null && indicators.distVwapPct > 0 ? 8 : indicators.distVwapPct != null ? -8 : 0)
      + (market.trend === 'BULLISH' ? 6 : market.trend === 'BEARISH' ? -6 : 0)
      + (market.sectorTrend === 'BULLISH' ? 4 : market.sectorTrend === 'BEARISH' ? -4 : 0)
      + (oversold.label.includes('OVERSOLD') && relVol != null && relVol >= 2 ? 5 : 0);
    const probabilities = {
      reliefBounce: clamp5(pBounce + adj),
      closeGreen:   clamp5(pGreen + adj),
      rebound3:     clamp5(p3 + adj * 0.5),
      rebound5:     clamp5(p5 + adj * 0.5),
      downsideLeg:  clamp5(100 - (pBounce + adj)),
      basis: analogs
        ? `Base rates from ${analogs.sampleSize} past session(s) that closed down ${threshold}%+ (end-of-day statistics — intraday timing not modeled)${analogs.lowConfidence ? '. LIMITED SAMPLE, LOW CONFIDENCE' : ''}. Adjusted for VWAP position, market and sector trend.`
        : 'No comparable historical selloff for the current move — probabilities are neutral heuristics adjusted for live context. LOW CONFIDENCE.',
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
    const apiKey = process.env.AIML_API_KEY;
    if (apiKey) {
      const facts = { symbol: sym, snapshot, indicators: { ...indicators, macd: indicators.macd ? { histogram: +indicators.macd.histogram.toFixed(3) } : null }, selloff, oversold, analogs: analogs ? { threshold, ...analogs } : null, market, news, levels, probabilities };
      const gpPrompt = 'You are an experienced intraday trader writing a concise AI TRADE GAME PLAN. You are given VERIFIED market facts as JSON. RULES: Use ONLY the numbers provided — never invent prices, statistics or news. Never claim certainty; prefer "evidence favors" language. Oversold alone is NOT a buy signal. Warn against catching a falling knife when the stock is down sharply. If no attractive setup exists respond with tradeSetup null and noTrade true. Respond with STRICT JSON only (no markdown): {"setup":"BULLISH|LEAN BULLISH|NEUTRAL|LEAN BEARISH|BEARISH","verdict":"1-2 sentence summary","why":["3-5 short reasons"],"scenarios":{"bullish":{"plan":"...","trigger":"...","invalidation":"..."},"range":{"plan":"..."},"bearish":{"plan":"...","trigger":"...","invalidation":"..."}},"changeMind":["2-3 specific price/volume conditions that would invalidate the thesis"],"whyFail":["2-4 specific risks"],"tradeSetup":{"entryZone":"...","confirmationEntry":"...","stop":"...","target1":"...","target2":"...","target3":"...","riskReward":"..."}|null,"noTrade":false,"fallingKnifeWarning":"one sentence or null"}';
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
            ai = { available: true, ...parsed };
          } catch { ai = { available: false, reason: 'AI returned unparseable output' }; }
        } else {
          ai = { available: false, reason: `AI service error (${r.status})` };
        }
      } catch { ai = { available: false, reason: 'AI service unreachable' }; }
    } else {
      ai = { available: false, reason: 'AI key not configured' };
    }

    const out = {
      ok: true, symbol: sym, generatedAt: new Date().toISOString(), dataGaps,
      snapshot, indicators: { ...indicators, macd: indicators.macd ? { value: +indicators.macd.value.toFixed(3), signal: +indicators.macd.signal.toFixed(3), histogram: +indicators.macd.histogram.toFixed(3) } : null },
      selloff, oversold,
      analogs: analogs ? { threshold, ...analogs } : null,
      market, news, levels, probabilities,
      confidence: { overall, parts },
      ai,
    };
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

function getAlpacaCreds(userId) {
  // Determine which mode this user has active
  const activeModeRow = db.prepare('SELECT mode FROM alpaca_active_mode WHERE user_id=?').get(userId);
  const activeMode    = activeModeRow?.mode || 'paper';

  // Strict: only return credentials for the ACTIVE mode — never silently fall back
  // to the other mode, as that could send "live mode" orders to a paper account.
  const row = db.prepare('SELECT api_key, api_secret, mode FROM alpaca_creds WHERE user_id=? AND mode=?').get(userId, activeMode);
  if (!row || row.api_key === DISCONNECTED_SENTINEL) return null;
  return row;
}

// Helper: check if a specific mode has valid (non-sentinel) credentials in DB
function _alpacaCredsExist(userId, mode) {
  const row = db.prepare('SELECT api_key FROM alpaca_creds WHERE user_id=? AND mode=?').get(userId, mode);
  return !!row && row.api_key !== DISCONNECTED_SENTINEL;
}

async function alpacaFetch(userId, path, opts = {}, _attempt = 0) {
  const creds = getAlpacaCreds(userId);
  if (!creds) throw new Error('Alpaca not connected. Please add your API credentials.');
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
      return alpacaFetch(userId, path, opts, _attempt + 1);
    }
    throw new Error(`Alpaca unreachable${isGet ? ` after ${MAX_ATTEMPTS} attempts` : ''}: ${netErr.message}`);
  }
  clearTimeout(timeoutId);
  const isGet = !opts.method || opts.method === 'GET';
  // Rate-limit back-off: 429 → wait and retry (GET only — safe to repeat)
  if (r.status === 429 && isGet && _attempt < MAX_ATTEMPTS - 1) {
    const delay = Math.min(2000 * (_attempt + 1), 8000);
    console.warn(`[AT] Alpaca 429 rate-limit on ${path} — retrying in ${delay}ms`);
    await new Promise(res => setTimeout(res, delay));
    return alpacaFetch(userId, path, opts, _attempt + 1);
  }
  // Transient server errors (502/503/504) — retry GET requests only
  if ([502, 503, 504].includes(r.status) && isGet && _attempt < MAX_ATTEMPTS - 1) {
    const delay = Math.min(1500 * 2 ** _attempt, 8000);
    console.warn(`[AT] Alpaca ${r.status} on ${path} (attempt ${_attempt + 1}/${MAX_ATTEMPTS}) — retrying in ${delay}ms`);
    await new Promise(res => setTimeout(res, delay));
    return alpacaFetch(userId, path, opts, _attempt + 1);
  }
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403)
    throw new Error('Alpaca authentication failed — check your API credentials.');
  if (!r.ok) throw new Error(data.message || `Alpaca error (${r.status})`);
  return data;
}

// Save credentials — stores the key pair for the given mode, sets it as active
app.put('/api/alpaca/credentials', requireAuth, async (req, res) => {
  const { apiKey, apiSecret, mode } = req.body || {};
  const key = (apiKey  || '').trim();
  const sec = (apiSecret || '').trim();
  if (!key || !sec) return res.status(400).json({ error: 'API key and secret required.' });
  if (key.length < 8 || sec.length < 8) return res.status(400).json({ error: 'Credentials look too short — paste the full key and secret.' });
  const m = mode === 'live' ? 'live' : 'paper';

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
  } catch (e) {
    if (e.name === 'AbortError') return res.status(400).json({ error: 'Alpaca did not respond in time — check your connection.' });
    return res.status(400).json({ error: 'Could not reach Alpaca to verify credentials: ' + e.message });
  }

  const uid = req.session.userId;
  db.prepare('INSERT OR REPLACE INTO alpaca_creds (user_id, api_key, api_secret, mode) VALUES (?,?,?,?)').run(uid, key, sec, m);
  db.prepare('INSERT OR REPLACE INTO alpaca_active_mode (user_id, mode) VALUES (?,?)').run(uid, m);
  res.json({ ok: true, mode: m });
});

// Disconnect — writes sentinel for the currently-active mode only.
// The other mode's credentials remain stored and can be reactivated via switch-mode.
app.delete('/api/alpaca/credentials', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const activeModeRow = db.prepare('SELECT mode FROM alpaca_active_mode WHERE user_id=?').get(uid);
  const m = activeModeRow?.mode || 'paper';
  db.prepare('INSERT OR REPLACE INTO alpaca_creds (user_id, api_key, api_secret, mode) VALUES (?,?,?,?)').run(
    uid, DISCONNECTED_SENTINEL, DISCONNECTED_SENTINEL, m
  );
  res.json({ ok: true });
});

// Check connection status — returns active-mode creds plus availability of both modes
app.get('/api/alpaca/credentials', requireAuth, (req, res) => {
  const uid   = req.session.userId;
  const creds = getAlpacaCreds(uid);
  const paperConnected = _alpacaCredsExist(uid, 'paper');
  const liveConnected  = _alpacaCredsExist(uid, 'live');
  const activeModeRow  = db.prepare('SELECT mode FROM alpaca_active_mode WHERE user_id=?').get(uid);
  const activeMode     = activeModeRow?.mode || (creds?.mode) || 'paper';
  res.json({
    connected:      !!creds,
    mode:           activeMode,
    paperConnected,
    liveConnected,
  });
});

// Switch active mode — requires credentials for the target mode to already be stored
app.post('/api/alpaca/switch-mode', requireAuth, (req, res) => {
  const { mode } = req.body || {};
  const m   = mode === 'live' ? 'live' : 'paper';
  const uid = req.session.userId;
  if (!_alpacaCredsExist(uid, m)) {
    return res.status(400).json({ error: `No ${m} account connected. Save your ${m} API keys first.` });
  }
  db.prepare('INSERT OR REPLACE INTO alpaca_active_mode (user_id, mode) VALUES (?,?)').run(uid, m);
  res.json({ ok: true, mode: m });
});

// Account info
app.get('/api/alpaca/account', requireAuth, async (req, res) => {
  try { res.json(await alpacaFetch(req.session.userId, '/v2/account')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Open positions
app.get('/api/alpaca/positions', requireAuth, async (req, res) => {
  try { res.json(await alpacaFetch(req.session.userId, '/v2/positions')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Pending orders only (not order history — only shows new/partially_filled)
app.get('/api/alpaca/orders', requireAuth, async (req, res) => {
  try { res.json(await alpacaFetch(req.session.userId, '/v2/orders?limit=50&status=open')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Close ALL open positions at market price
app.delete('/api/alpaca/positions', requireAuth, async (req, res) => {
  try {
    const result = await alpacaFetch(req.session.userId, '/v2/positions', { method: 'DELETE' });
    res.json({ ok: true, result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Public SPY gate levels — no auth needed (cached server-side)
app.get('/api/spy-levels', async (req, res) => {
  try {
    const lvl = await getSPYLevels();
    res.json(lvl ?? { floor: null, maxPain: null, roof: null, expiry: null });
  } catch (e) { res.json({ floor: null, maxPain: null, roof: null, expiry: null }); }
});

// Place order (market with optional TP/SL bracket)
app.post('/api/alpaca/order', requireAuth, async (req, res) => {
  const { symbol, side, amount, tpPct, slPct, leverage } = req.body || {};

  // ── Input validation ───────────────────────────────────────────────────────
  if (!symbol || !side) return res.status(400).json({ error: 'symbol and side required.' });
  if (!/^[A-Z0-9.\-]{1,12}$/i.test(symbol)) return res.status(400).json({ error: 'Invalid symbol.' });
  const sideL = side.toLowerCase();
  if (sideL !== 'buy' && sideL !== 'sell') return res.status(400).json({ error: 'side must be buy or sell.' });

  const amtNum = parseFloat(amount);
  if (!isFinite(amtNum) || amtNum <= 0) return res.status(400).json({ error: 'amount must be a positive number.' });

  const tpNum  = parseFloat(tpPct)  || 0;
  const slNum  = parseFloat(slPct)  || 0;
  if (tpNum < 0 || slNum < 0) return res.status(400).json({ error: 'tpPct and slPct must be non-negative.' });

  // ── NO-SHORT POLICY ─────────────────────────────────────────────────────────
  // This platform never opens short positions. A SELL order is only allowed to
  // close (or reduce) an existing long position. To profit from a falling
  // stock/market, buy the mapped inverse ETF instead (GET /api/inverse/:sym).
  if (sideL === 'sell') {
    try {
      const pos = await alpacaFetch(req.session.userId, `/v2/positions/${symbol.toUpperCase()}`, { method: 'GET' });
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
        const open = await alpacaFetch(req.session.userId, `/v2/orders?status=open&symbols=${symbol.toUpperCase()}`, { method: 'GET' });
        for (const o of (Array.isArray(open) ? open : [])) {
          await alpacaFetch(req.session.userId, `/v2/orders/${o.id}`, { method: 'DELETE' }).catch(() => {});
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
  const isCryptoSym = /[-]|USD$|USDT$/.test(symbol.toUpperCase());
  if (!isCryptoSym && !isMarketOpen()) {
    return res.status(400).json({ error: 'Market is closed. Equity orders are only accepted during regular market hours (9:35 AM – 3:50 PM ET, Mon–Fri). Use Alpaca directly for extended-hours orders.' });
  }

  try {
    // Get live price to calculate shares and TP/SL levels (Alpaca-first, 24/7)
    const quote = await fetchLiveQuote(symbol.toUpperCase(), req.session.userId);
    // BUG FIX: use live `price` field — regularClose is prior-session close and causes stale bracket levels
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

    const data = await alpacaFetch(req.session.userId, '/v2/orders', {
      method: 'POST',
      body:   JSON.stringify(orderBody),
    });
    res.json({ ok: true, order: data, shares: orderBody.qty || null, price, leverage: lev });
  } catch (e) {
    const status = e.message.includes('authentication') ? 401 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Cancel order
app.delete('/api/alpaca/order/:id', requireAuth, async (req, res) => {
  if (!/^[a-f0-9\-]{10,40}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid order ID.' });
  try { await alpacaFetch(req.session.userId, `/v2/orders/${req.params.id}`, { method: 'DELETE' }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Close position (market sell)
app.delete('/api/alpaca/position/:sym', requireAuth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) return res.status(400).json({ error: 'Invalid symbol.' });
  try { res.json(await alpacaFetch(req.session.userId, `/v2/positions/${sym}`, { method: 'DELETE' })); }
  catch (e) { res.status(400).json({ error: e.message }); }
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



// ── Bounce 2.0 Scanner Universe ───────────────────────────────────────────────
// ── Master scan universe — all 4 bots use this list ───────────────────────────
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
];



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

    const barsData = await alpacaDataFetch(uid,
      `/v2/stocks/${sym}/bars?timeframe=1Min&start=${encodeURIComponent(start.toISOString())}&limit=300&adjustment=all&feed=iex`
    ).catch(() => null);

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
// buy the mapped inverse ETF instead. Falls back to SH (inverse S&P 500).
app.get('/api/inverse/:sym', (req, res) => {
  const sym = req.params.sym?.toUpperCase().replace(/[^A-Z.\-]/g, '');
  if (!sym) return res.status(400).json({ ok: false, error: 'symbol required' });
  const inverse = INVERSE_MAP[sym] || 'SH';
  res.json({ ok: true, sym, inverse, mapped: !!INVERSE_MAP[sym],
    note: INVERSE_MAP[sym]
      ? `${sym} falls → ${inverse} rises (mapped inverse ETF)`
      : `No specific mapping for ${sym} — SH (inverse S&P 500) is the general market hedge` });
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
    if (_universeCache && (now - _universeCacheAt) < UNIVERSE_TTL_MS) {
      return res.json({ ..._universeCache, cached: true });
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

    if (!allSymbols.length) {
      return res.json({ symbols: MASTER_UNIVERSE, source: 'curated-fallback', count: MASTER_UNIVERSE.length, gainers: [], cached: false });
    }

    const payload = {
      symbols:    allSymbols,
      source:     'yf-full-market',
      count:      allSymbols.length,
      gainers:    gainers.map(g => g.symbol),
      smallCap:   smallCap.map(g => g.symbol),
      highVolume: actives,
      cached:     false,
    };

    _universeCache   = payload;
    _universeCacheAt = now;
    console.log(`[Universe] YF full market: ${gainers.length} day-gainers + ${smallCap.length} small-cap + ${actives.length} actives = ${allSymbols.length} total`);
    res.json(payload);
  } catch (e) {
    console.error('[Universe] Error:', e.message);
    res.json({ symbols: MASTER_UNIVERSE, source: 'curated-fallback', count: MASTER_UNIVERSE.length, cached: false });
  }
});

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

    res.json({
      universeSize: MASTER_UNIVERSE.length,
      spyLevels,
      // PDT rule eliminated per SEC approval of FINRA SR-FINRA-2025-017, effective ~June 2026.
      pdt: { allowed: true, reason: 'PDT restrictions removed — FINRA SR-FINRA-2025-017',
             daytradeCount: account ? parseInt(account.daytrade_count || 0) : null,
             equity: account ? parseFloat(account.equity || 0) : null,
             patternDayTrader: false },
      recentTrades,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bot toggle helpers ─────────────────────────────────────────────────────────
const BOT_NAMES = ['countertrend'];

function isBotEnabled(userId, botName) {
  const row = db.prepare('SELECT enabled FROM bot_toggles WHERE user_id=? AND bot_name=?').get(userId, botName);
  return row ? !!row.enabled : true; // default ON if no row exists yet
}

// GET /api/bots/toggles — returns { bounce: true, volatility_expansion: false, … }
app.get('/api/bots/toggles', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT bot_name, enabled FROM bot_toggles WHERE user_id=?').all(req.session.userId);
  const map  = Object.fromEntries(BOT_NAMES.map(b => [b, true])); // default all ON
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

// ── POST /api/bots/trigger — manually fire one scan cycle on all 4 bots ──────
app.post('/api/bots/trigger', requireAuth, async (req, res) => {
  if (!isMarketOpen()) return res.json({ ok: false, message: 'Market is closed — bots only trade during market hours (9:30–16:00 ET Mon–Fri).' });
  res.json({ ok: true, message: 'Scan cycle triggered — check the trade log in a few seconds.' });
  // No auto-traders remaining (Swing and ORB removed)
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

// Returns the affordable 2×/3× leveraged proxy for an expensive stock,
// or null if the proxy itself is also > $25 or if no mapping exists.
async function getLeveragedProxy(symbol, price) {
  if (price <= MAX_TRADE_PRICE) return null;
  const proxyTicker = LEVERAGED_MAP[symbol];
  if (!proxyTicker) return null;
  try {
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

// ── Slot counter: positions + pending bracket orders ─────────────────────────
// Each open position = 1 slot. Each pending parent bracket order (not yet filled)
// = 1 slot. Bracket child legs (TP limit / SL stop) have legs=[] and don't count.
async function getOpenSlots(userId, botName) {
  let positions = [], openOrders = [];
  try { positions = await alpacaFetch(userId, '/v2/positions'); } catch { return null; }
  try {
    const allOpen = await alpacaFetch(userId, '/v2/orders?status=open&limit=50');
    // Only parent bracket orders have a non-empty legs array
    openOrders = Array.isArray(allOpen)
      ? allOpen.filter(o => Array.isArray(o.legs) && o.legs.length > 0)
      : [];
  } catch { /* positions-only fallback */ }
  const used      = (Array.isArray(positions) ? positions.length : 0) + openOrders.length;
  const available = Math.max(0, MAX_CONCURRENT_POSITIONS - used);
  if (available <= 0)
    console.log(`[${botName}] Slot cap: ${positions.length} pos + ${openOrders.length} pending orders = ${used}/${MAX_CONCURRENT_POSITIONS}`);
  return { available, positions: Array.isArray(positions) ? positions : [], openOrders };
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
// SWING TRADING BOT — Weekly/Daily Chart Strategy
// Minimum hold: 5 trading days. No day trading. Weekly candle confirmation only.
// Instruments: SPY / QQQ (long bottom signal) | SH / SPXS (inverse top signal)
// Entry: Limit order Monday morning. Size: 15% of account equity.
// Exit: TP1 33% @ 21w EMA → TP2 33% @ 50w SMA → TP3 34% @ prior high / +8%
// Trailing stop: breakeven after TP1, moves to TP1 after TP2.
// ══════════════════════════════════════════════════════════════════════════════

db.prepare(`
  CREATE TABLE IF NOT EXISTS swing_trade_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    symbol           TEXT    NOT NULL,
    direction        TEXT    NOT NULL,
    entry_price      REAL,
    shares           INTEGER,
    shares_remaining INTEGER,
    alpaca_order_id  TEXT,
    stop_level       REAL,
    trailing_stop    REAL,
    tp1_price        REAL,
    tp2_price        REAL,
    tp3_price        REAL,
    phase            TEXT DEFAULT 'open',
    signal_date      TEXT,
    notes            TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    closed_at        TEXT
  )
`).run();

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
      weeks[key] = { t: key, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 };
    } else {
      const w = weeks[key];
      w.h = Math.max(w.h, bar.h);
      w.l = Math.min(w.l, bar.l);
      w.c = bar.c;
      w.v += bar.v || 0;
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
