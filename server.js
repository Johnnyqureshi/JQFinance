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
const MAX_TRADE_PRICE = 30;          // Bot only executes LONG trades on stocks priced ≤ $30
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

// ── App settings table (persists generated secrets etc.) ──────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`).run();

// ── Seed: ensure the primary admin account always exists ─────────────────────
// This runs at startup so the account is present even on a fresh deployment DB.
// The hash below is bcrypt of 'JQFinance2024!' (rounds=10). The user can change
// their password at any time via the lock-icon modal; this only seeds if missing.
(function seedAdminUser() {
  const ADMIN_USER = 'johnnyqureshi';
  const ADMIN_HASH = '$2b$10$it125q.J9OKxhcn2pNGHR.FA6/isY4CWt5GH/IXMzJqW94se1i.aW';
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(ADMIN_USER);
  if (!existing) {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(ADMIN_USER, ADMIN_HASH);
    console.log(`[Seed] Created admin account: ${ADMIN_USER}`);
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

// ── GET /api/quote/:symbol ─────────────────────────────────────────────────────
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const q = await yfChartQuote(req.params.symbol.toUpperCase());
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/snapshots?symbols=A,B ────────────────────────────────────────────
app.get('/api/snapshots', async (req, res) => {
  const syms = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!syms.length) return res.json({});
  try {
    // Batch-fetch all symbols in one SDK call — much faster than individual fetches
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
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const url  = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`;
    const r    = await fetch(url, { headers: YH });
    const data = await r.json();
    const out  = (data?.quotes || [])
      .filter(x => ['EQUITY','ETF','MUTUALFUND','INDEX','CRYPTOCURRENCY'].includes(x.quoteType) && x.symbol && !x.symbol.includes('.'))
      .slice(0, 8)
      .map(x => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchange || '', quoteType: x.quoteType || '' }));
    res.json(out);
  } catch { res.json([]); }
});

// ── GET /api/bars/:symbol?timeframe=&limit= ───────────────────────────────────
app.get('/api/bars/:symbol', async (req, res) => {
  const sym      = req.params.symbol.toUpperCase();
  const tf       = req.query.timeframe || '1Day';
  const limit    = parseInt(req.query.limit) || 60;
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
  } catch (e) { res.json({ bars: [] }); }
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
    .filter(Boolean).slice(0, 50);
  if (!symbols.length) return res.json({ results: [] });

  const BATCH = 5;
  const out   = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk   = symbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(chunk.map(async sym => {
      try {
        const [quote, bars] = await Promise.all([
          yf.quote(sym, {}, { validateResult: false }).catch(() => null),
          fetchOHLCV(sym, 70).catch(() => null),
        ]);
        if (!quote?.regularMarketPrice) return null;

        const price     = quote.regularMarketPrice;
        const change    = quote.regularMarketChangePercent ?? 0;
        const volume    = quote.regularMarketVolume ?? 0;
        const avgVol    = quote.averageDailyVolume3Month ?? quote.averageDailyVolume10Day ?? 0;
        const relVol    = avgVol > 0 ? +(volume / avgVol).toFixed(2) : null;
        const marketCap = quote.marketCap ?? null;
        const floatSh   = quote.floatShares ?? null;
        const w52High   = quote.fiftyTwoWeekHigh ?? null;
        const w52Dist   = w52High ? +((price - w52High) / w52High * 100).toFixed(2) : null;
        const name      = quote.shortName ?? quote.longName ?? sym;

        let atr14 = null, rsi14 = null;
        if (bars && bars.length >= 20) {
          const closes = bars.map(b => b.c);
          try { atr14 = +calcATR(bars, 14).toFixed(3); } catch(_) {}
          try { rsi14 = +calcRSI(closes, 14).toFixed(1); } catch(_) {}
        }

        return { sym, name, price, change: +change.toFixed(2), volume, relVol, atr14, rsi14, floatSh, marketCap, w52Dist };
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
    try { rsi14 = +calcRSI(closes, 14).toFixed(1); } catch (_) {}
    const aboveEma = price > ema21;
    const aboveSma = price > sma50;
    const rsiOk    = rsi14 < 70 && rsi14 > 30;
    const condsMet = [aboveEma, aboveSma, rsiOk].filter(Boolean).length;
    const signal    = condsMet === 3 ? 'BUY' : condsMet === 2 ? 'WATCH' : 'HOLD';
    const confidence = condsMet === 3 ? 72 : condsMet === 2 ? 48 : 30;
    const reasons = [];
    if (aboveEma) reasons.push('Price above 21 EMA (short-term trend up)');
    if (aboveSma) reasons.push('Price above 50 SMA (medium-term trend up)');
    if (rsiOk)    reasons.push(`RSI ${rsi14} — momentum neutral/healthy`);
    res.json({
      ok: true,
      symbol: sym,
      signal: {
        signal, confidence, reasons,
        price, ema8: ema21, sma50,
        confirmed: condsMet === 3,
        zoneStr: condsMet === 3 ? 'Trend aligned — all conditions met' : condsMet === 2 ? 'Partial setup — monitoring' : 'No active setup',
      },
      regime: { regime: 'NEUTRAL', label: 'Market Neutral' },
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/intraday/:symbol (5-min bars — includes pre/post market) ──────────
app.get('/api/intraday/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    // Fetch 5-min bars and live quote in parallel
    // Chart API provides the intraday bars; yf.quote() provides correct marketState + extended prices
    const [chartRes, liveQuote] = await Promise.all([
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

    // Use yf.quote() for accurate marketState and extended-hours prices
    const marketState = liveQuote?.marketState || 'CLOSED';
    const isPost = ['POST', 'POSTPOST'].includes(marketState);
    const isPre  = ['PRE',  'PREPRE' ].includes(marketState);
    const regPrice = liveQuote?.regularMarketPrice ?? bars.at(-1)?.c ?? null;
    let extendedPrice = null;
    if (isPost) {
      extendedPrice = liveQuote?.postMarketPrice ?? null;
    } else if (isPre) {
      extendedPrice = liveQuote?.preMarketPrice ?? liveQuote?.postMarketPrice ?? null;
    }

    res.json({
      bars,
      price:         extendedPrice ?? regPrice,
      regularClose:  regPrice,
      extendedPrice,
      extendedType:  isPost ? 'AH' : (isPre && liveQuote?.preMarketPrice != null) ? 'PRE' : (isPre && extendedPrice != null) ? 'AH' : null,
      marketState,
      previousClose: liveQuote?.regularMarketPreviousClose ?? null,
      open:          liveQuote?.regularMarketOpen ?? bars[0]?.o ?? null,
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

// ── Hardcoded 2026 economic calendar (fallback when FMP is unavailable) ────────
const ECO_CALENDAR_2026 = [
  { date:'2026-04-10', event:'CPI (March)',                        impact:'High',   estimate:'2.8%',  previous:'2.8%'  },
  { date:'2026-04-11', event:'Core CPI (March)',                   impact:'High',   estimate:'3.1%',  previous:'3.1%'  },
  { date:'2026-04-11', event:'PPI (March)',                        impact:'Medium', estimate:'2.5%',  previous:'2.7%'  },
  { date:'2026-04-15', event:'Retail Sales (March)',               impact:'High',   estimate:'0.5%',  previous:'-0.9%' },
  { date:'2026-04-16', event:'Initial Jobless Claims',             impact:'Medium', estimate:'225K',  previous:'219K'  },
  { date:'2026-04-17', event:'Housing Starts (March)',             impact:'Medium', estimate:'1.42M', previous:'1.50M' },
  { date:'2026-04-17', event:'Michigan Consumer Sentiment (Apr P)',impact:'Medium', estimate:'57.0',  previous:'57.0'  },
  { date:'2026-04-23', event:'Initial Jobless Claims',             impact:'Medium', estimate:'225K',  previous:null    },
  { date:'2026-04-25', event:'PCE Price Index (March)',            impact:'High',   estimate:'2.5%',  previous:'2.5%'  },
  { date:'2026-04-25', event:'GDP (Q1 2026 Advance)',              impact:'High',   estimate:'1.3%',  previous:'2.4%'  },
  { date:'2026-04-30', event:'FOMC Meeting Begins',                impact:'High',   estimate:null,    previous:'4.25-4.50%' },
  { date:'2026-04-30', event:'Consumer Confidence (April)',        impact:'Medium', estimate:'95.0',  previous:'92.9'  },
  { date:'2026-05-01', event:'FOMC Rate Decision',                 impact:'High',   estimate:'4.25-4.50%', previous:'4.25-4.50%' },
  { date:'2026-05-01', event:'Non-Farm Payrolls (April)',          impact:'High',   estimate:'135K',  previous:'228K'  },
  { date:'2026-05-01', event:'Unemployment Rate (April)',          impact:'High',   estimate:'4.2%',  previous:'4.2%'  },
  { date:'2026-05-07', event:'Initial Jobless Claims',             impact:'Medium', estimate:'225K',  previous:null    },
  { date:'2026-05-13', event:'CPI (April)',                        impact:'High',   estimate:null,    previous:'2.8%'  },
  { date:'2026-05-14', event:'PPI (April)',                        impact:'Medium', estimate:null,    previous:'2.5%'  },
  { date:'2026-05-15', event:'Retail Sales (April)',               impact:'High',   estimate:null,    previous:'0.5%'  },
  { date:'2026-05-28', event:'GDP (Q1 2026 Second)',               impact:'High',   estimate:null,    previous:null    },
  { date:'2026-06-05', event:'Non-Farm Payrolls (May)',            impact:'High',   estimate:null,    previous:null    },
  { date:'2026-06-10', event:'CPI (May)',                          impact:'High',   estimate:null,    previous:null    },
  { date:'2026-06-16', event:'FOMC Meeting Begins',                impact:'High',   estimate:null,    previous:'4.25-4.50%' },
  { date:'2026-06-17', event:'FOMC Rate Decision',                 impact:'High',   estimate:null,    previous:'4.25-4.50%' },
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
const AGENT_SYSTEM_PROMPT = `You are JQF Agent — an expert AI financial assistant embedded inside JQFinance, a professional stock research and real-time analysis platform built by Johnny Qureshi.

PLATFORM OVERVIEW:
JQFinance is a single-page application with four main pages:
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

// ── Alpaca Markets Integration ─────────────────────────────────────────────────

function getAlpacaCreds(userId) {
  return db.prepare('SELECT api_key, api_secret, mode FROM alpaca_creds WHERE user_id = ?').get(userId);
}

async function alpacaFetch(userId, path, opts = {}, _retry = true) {
  const creds = getAlpacaCreds(userId);
  if (!creds) throw new Error('Alpaca not connected. Please add your API credentials.');
  const base = creds.mode === 'live'
    ? 'https://api.alpaca.markets'
    : 'https://paper-api.alpaca.markets';
  const r = await fetch(base + path, {
    ...opts,
    headers: {
      'APCA-API-KEY-ID':     creds.api_key,
      'APCA-API-SECRET-KEY': creds.api_secret,
      'Content-Type':        'application/json',
      ...(opts.headers || {}),
    },
  });
  // Auto-retry once on 429 after 1 second back-off
  if (r.status === 429 && _retry) {
    console.warn(`[AT] Alpaca 429 rate-limit on ${path} — retrying in 1 s`);
    await new Promise(res => setTimeout(res, 1000));
    return alpacaFetch(userId, path, opts, false);
  }
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `Alpaca error (${r.status})`);
  return data;
}

// Save credentials
app.put('/api/alpaca/credentials', requireAuth, (req, res) => {
  const { apiKey, apiSecret, mode } = req.body || {};
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'API key and secret required.' });
  const m = mode === 'live' ? 'live' : 'paper';
  db.prepare('INSERT OR REPLACE INTO alpaca_creds (user_id, api_key, api_secret, mode) VALUES (?, ?, ?, ?)').run(req.session.userId, apiKey.trim(), apiSecret.trim(), m);
  res.json({ ok: true, mode: m });
});

// Delete credentials (disconnect)
app.delete('/api/alpaca/credentials', requireAuth, (req, res) => {
  db.prepare('DELETE FROM alpaca_creds WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true });
});

// Check connection status
app.get('/api/alpaca/credentials', requireAuth, (req, res) => {
  const creds = getAlpacaCreds(req.session.userId);
  res.json({ connected: !!creds, mode: creds?.mode || 'paper' });
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
  if (!symbol || !side || !amount) return res.status(400).json({ error: 'symbol, side, amount required.' });

  // Validate leverage (1–4x, must be numeric)
  const lev = Math.min(4, Math.max(1, isFinite(+leverage) ? +leverage : 1));

  try {
    // Get live price to calculate shares and TP/SL levels
    const quote = await yfChartQuote(symbol);
    if (!quote?.regularClose && !quote?.price) throw new Error('Could not fetch current price for ' + symbol);
    const price = quote.regularClose ?? quote.price;

    const leveragedAmount = amount * lev;
    const hasBracket = tpPct > 0 || slPct > 0;
    const sideL = side.toLowerCase();

    let orderBody;

    if (hasBracket) {
      // Bracket orders require integer qty (Alpaca limitation for margin)
      const shares = Math.max(1, Math.floor(leveragedAmount / price));
      orderBody = {
        symbol,
        qty:            String(shares),
        side:           sideL,
        type:           'market',
        time_in_force:  'day',
        order_class:    'bracket',
      };
      if (tpPct > 0) {
        const tpPrice = sideL === 'buy'
          ? (price * (1 + tpPct / 100)).toFixed(2)
          : (price * (1 - tpPct / 100)).toFixed(2);
        orderBody.take_profit = { limit_price: tpPrice };
      }
      if (slPct > 0) {
        const slPrice = sideL === 'buy'
          ? (price * (1 - slPct / 100)).toFixed(2)
          : (price * (1 + slPct / 100)).toFixed(2);
        orderBody.stop_loss = { stop_price: slPrice };
      }
    } else {
      // Simple notional order (supports fractional shares)
      orderBody = {
        symbol,
        notional:       leveragedAmount.toFixed(2),
        side:           sideL,
        type:           'market',
        time_in_force:  'day',
      };
    }

    const data = await alpacaFetch(req.session.userId, '/v2/orders', {
      method: 'POST',
      body:   JSON.stringify(orderBody),
    });
    res.json({ ok: true, order: data, shares: orderBody.qty || null, price, leverage: lev });
  } catch (e) { res.status(400).json({ error: e.message }); }
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

function findSwingHigh(bars, lookback = 30) {
  // Look back through bars (excluding last few) for the most recent pivot high
  const slice = bars.slice(-lookback, -1);
  return slice.length ? Math.max(...slice.map(b => b.h)) : null;
}

function findPullbackLow(bars, lookback = 10) {
  const slice = bars.slice(-lookback);
  return slice.length ? Math.min(...slice.map(b => b.l)) : null;
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
app.get('/api/bots/status', requireAuth, async (req, res) => {
  try {
    const spyLevels = await getSPYLevels();

    let account = null, pdtAllowed = true, pdtReason = '';
    try {
      account = await alpacaFetch(req.session.userId, '/v2/account');
      const equity   = parseFloat(account.equity || 0);
      const dtCount  = parseInt(account.daytrade_count || 0, 10);
      const isPDT    = !!account.pattern_day_trader;
      if (isPDT && equity < 25000) {
        pdtAllowed = false;
        pdtReason  = `Account is PDT-flagged with equity $${equity.toFixed(0)} < $25,000`;
      } else if (!isPDT && dtCount >= 3) {
        pdtAllowed = false;
        pdtReason  = `${dtCount}/3 day-trades used in rolling 5-day window`;
      } else {
        pdtReason = isPDT
          ? `PDT account — equity $${equity.toFixed(0)} ≥ $25,000 — unlimited day trades`
          : `${dtCount}/3 day-trades used — ${3 - dtCount} remaining today`;
      }
    } catch (e) {
      pdtReason = 'Could not fetch Alpaca account — not connected?';
    }

    // Latest trade logs per bot (last 10 across all strategies)
    const recentTrades = db.prepare(
      `SELECT symbol, strategy, side, shares, entry_price, status, created_at
       FROM auto_trade_log WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 10`
    ).all(req.session.userId);

    res.json({
      universeSize: MASTER_UNIVERSE.length,
      spyLevels,
      pdt: { allowed: pdtAllowed, reason: pdtReason,
             daytradeCount: account ? parseInt(account.daytrade_count || 0) : null,
             equity: account ? parseFloat(account.equity || 0) : null,
             patternDayTrader: account ? !!account.pattern_day_trader : null },
      recentTrades,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bot toggle helpers ─────────────────────────────────────────────────────────
const BOT_NAMES = ['countertrend','orb','swing'];

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
  // Run active bots concurrently (non-blocking to the HTTP response)
  Promise.allSettled([
    runCTAutoTrader(),
    runSwingAutoTrader()
  ]).then(results => {
    const errs = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
    if (errs.length) console.warn('[Trigger] Bot errors:', errs.join('; '));
    else console.log('[Trigger] Manual scan cycle complete.');
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

// ── POST /api/bots/simulate — dry-run all 3 strategy signal engines ───────────
// Runs CT scan, ORB signal, and Swing (SPY/QQQ/SH) signal computations with NO
// market-hours restriction and NO real order placement. Returns a full signal
// report for each bot plus hypothetical position sizing from trade_settings.
app.post('/api/bots/simulate', requireAuth, async (req, res) => {
  try {
    // Fetch user's trade settings for position sizing
    const ts = db.prepare('SELECT * FROM trade_settings WHERE user_id=?').get(req.session.userId)
             || { position_mode: 'pct', position_pct: 15, position_amount: 5000, leverage: 1 };

    // Try to get real equity from Alpaca; fall back to $10k placeholder
    let equity = 10000;
    let alpacaConnected = false;
    try {
      const acct = await alpacaFetch(req.session.userId, '/v2/account');
      equity = parseFloat(acct.equity || acct.portfolio_value || 10000);
      alpacaConnected = true;
    } catch {}

    const lev      = Math.min(3, Math.max(1, ts.leverage || 1));
    const posValue = ts.position_mode === 'fixed'
      ? (ts.position_amount || 5000) * lev
      : equity * ((ts.position_pct || 15) / 100) * lev;

    // ── CT: scan top 25 symbols for speed ────────────────────────────────────
    const CT_SIM_SET = CT_UNIVERSE.slice(0, 25);
    const ctRaw = [];
    const SIM_CONCURRENCY = 5;
    for (let i = 0; i < CT_SIM_SET.length; i += SIM_CONCURRENCY) {
      const batch = CT_SIM_SET.slice(i, i + SIM_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(s => computeCTSignal(s)));
      settled.forEach(r => { if (r.status === 'fulfilled' && r.value) ctRaw.push(r.value); });
    }
    const ctConfirmed = ctRaw.filter(s => s.confirmed).sort((a, b) => (b.score || 0) - (a.score || 0));
    const ctBest = ctConfirmed[0] || null;
    let ctTrade = null;
    if (ctBest) {
      const price  = ctBest.price || 1;
      const shares = Math.max(1, Math.floor(posValue / price));
      const sl     = ctBest.stopLoss  ? +ctBest.stopLoss.toFixed(2)  : +(price * 0.985).toFixed(2);
      const tp     = ctBest.target    ? +ctBest.target.toFixed(2)    : +(price * 1.04).toFixed(2);
      ctTrade = {
        symbol: ctBest.symbol, side: ctBest.direction === 'LONG' ? 'BUY' : 'BUY INVERSE',
        signalType: ctBest.signalType, price: +price.toFixed(2), shares,
        dollars: +(shares * price).toFixed(2),
        sl, tp, score: +(ctBest.score || 0).toFixed(1),
        rsi: ctBest.rsi != null ? +ctBest.rsi.toFixed(1) : null,
      };
    }

    // ── ORB: force-fresh computation ─────────────────────────────────────────
    _orbSignalTs = 0;
    const orbSig = await computeORBSignal(5).catch(e => ({ error: e.message, confirmed: false }));

    // ── Swing: SPY long, QQQ long, SH inverse ────────────────────────────────
    const [spyR, qqqR, invR] = await Promise.allSettled([
      computeSwingLongSignal('SPY'),
      computeSwingLongSignal('QQQ'),
      computeSwingInverseSignal(),
    ]);
    const spySig = spyR.status === 'fulfilled' ? spyR.value : { confirmed: false, error: spyR.reason?.message };
    const qqqSig = qqqR.status === 'fulfilled' ? qqqR.value : { confirmed: false, error: qqqR.reason?.message };
    const invSig = invR.status === 'fulfilled' ? invR.value : { confirmed: false, error: invR.reason?.message };

    const swingTrades = [];
    for (const sig of [spySig, qqqSig, invSig]) {
      if (!sig?.confirmed) continue;
      const price  = sig.price || 1;
      const shares = Math.max(1, Math.floor(posValue / price));
      swingTrades.push({
        symbol: sig.symbol, direction: sig.direction,
        price: +price.toFixed(2), shares,
        dollars: +(shares * price).toFixed(2),
        sl: sig.stopLevel, tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3,
      });
    }

    res.json({
      meta: {
        equity: +equity.toFixed(2), alpacaConnected,
        positionValue: +posValue.toFixed(2),
        settings: { mode: ts.position_mode, pct: ts.position_pct, fixed: ts.position_amount, leverage: lev },
        ts: new Date().toISOString(),
      },
      ct: {
        scanned: CT_SIM_SET.length,
        confirmedCount: ctConfirmed.length,
        topSignals: ctRaw.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 8).map(s => ({
          symbol: s.symbol, signalType: s.signalType, direction: s.direction,
          price: s.price ? +s.price.toFixed(2) : null, score: +(s.score || 0).toFixed(1),
          confirmed: s.confirmed, rsi: s.rsi != null ? +s.rsi.toFixed(1) : null,
        })),
        bestTrade: ctTrade,
      },
      orb: orbSig,
      swing: { spy: spySig, qqq: qqqSig, inverse: invSig, trades: swingTrades },
    });
  } catch (e) {
    console.error('[Simulate] Error:', e);
    res.status(500).json({ error: e.message });
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
// ORB (OPENING RANGE BREAKOUT) — Strategy 6
// Monitors SPY using 1-min FMP intraday bars.
//  • 5-min ORB  window: 9:30–9:35 ET  (first candle — 0DTE edge)
//  • 60-min ORB window: 9:30–10:30 ET (directional swing confirmation)
// Default: 5-min ORB. All filters must pass before execution.
// One trade per day per user. Proxied via SPXL (long) / SPXS (short) → ≤$30.
// ══════════════════════════════════════════════════════════════════════════════

// Fetch 1-min or 5-min intraday bars for today from FMP (newest→oldest, reversed)
async function fetchFMPIntraday(symbol, interval = '1min') {
  if (!FMP_KEY) return null;
  const et    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const today = `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;
  const url = `https://financialmodelingprep.com/api/v3/historical-chart/${interval}/${symbol}?from=${today}&to=${today}&apikey=${FMP_KEY}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'JohnnyFinance/1.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    // FMP returns newest first — reverse to chronological order
    return data.reverse().map(b => ({
      t: b.date,    // "2024-01-15 09:30:00"
      o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume || 0,
    }));
  } catch (e) { console.error('[ORB] FMP fetch error:', e.message); return null; }
}

// Parse "YYYY-MM-DD HH:MM:SS" → minutes since midnight ET
function fmpTimeToMins(dateStr) {
  const timePart = dateStr.split(' ')[1] || '';
  const [h, m]   = timePart.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Compute VWAP from array of bars (typical price × volume cumulative)
function calcVWAP(bars) {
  let cumPV = 0, cumVol = 0;
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    cumPV  += typical * (b.v || 0);
    cumVol += (b.v || 0);
  }
  return cumVol > 0 ? cumPV / cumVol : null;
}

let _orbSignalCache = null;
let _orbSignalTs    = 0;
const ORB_SIGNAL_TTL = 60 * 1000; // re-compute at most once per minute

async function computeORBSignal(orbWindowMins = 5) {
  const now = Date.now();
  if (_orbSignalCache && now - _orbSignalTs < ORB_SIGNAL_TTL) return _orbSignalCache;

  const et      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day     = et.getDay();  // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri
  const today   = `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;
  const curMins = et.getHours() * 60 + et.getMinutes();

  // Weekday filter — trade Mon–Fri (PDT rules enforced per trade)
  const isMWF = day >= 1 && day <= 5; // renamed kept for compatibility

  // ── Fetch VIX to check excessive volatility ───────────────────────────────
  let vix = null;
  try {
    const vixBars = await fetchOHLCV('^VIX', 2);
    vix = vixBars?.at(-1)?.c ?? null;
  } catch (_) {}
  const vixOk = vix === null || vix <= 35; // skip if VIX > 35

  // ── Fetch 1-min intraday bars for SPY ────────────────────────────────────
  const bars = await fetchFMPIntraday('SPY', '1min');
  const base = {
    today, isMWF, vix: vix ? +vix.toFixed(2) : null, vixOk,
    confirmed: false, breakout: 'NONE', orbHigh: null, orbLow: null,
    orbWindowMins,
  };

  if (!bars || bars.length < 5) {
    const result = { ...base, reason: 'Insufficient intraday data from FMP' };
    _orbSignalCache = result; _orbSignalTs = now;
    return result;
  }

  // ── Opening range: 9:30 ET = 570 min, window end = 570 + orbWindowMins ──
  const ORB_START = 570;
  const ORB_END   = ORB_START + orbWindowMins;

  const orbBars = bars.filter(b => {
    const m = fmpTimeToMins(b.t);
    return m >= ORB_START && m < ORB_END;
  });

  const postOrbBars = bars.filter(b => fmpTimeToMins(b.t) >= ORB_END);

  if (orbBars.length === 0) {
    const result = { ...base, reason: `ORB window (${orbWindowMins}-min) not yet complete` };
    _orbSignalCache = result; _orbSignalTs = now;
    return result;
  }

  const orbHigh = Math.max(...orbBars.map(b => b.h));
  const orbLow  = Math.min(...orbBars.map(b => b.l));
  const orbMid  = (orbHigh + orbLow) / 2;
  const rangeWidthPct = orbLow > 0 ? ((orbHigh - orbLow) / orbLow) * 100 : 0;
  const validRange    = rangeWidthPct >= 0.2;

  // ── VWAP from all bars up to current moment ───────────────────────────────
  const vwap = calcVWAP(bars);

  // ── RSI(14) on close prices ───────────────────────────────────────────────
  const closes = bars.map(b => b.c);
  let rsi = 50;
  try { rsi = calcRSI(closes, 14); } catch (_) {}

  // ── Volume: compare latest bar to 20-bar rolling average ─────────────────
  const recentVols = bars.slice(-21, -1).map(b => b.v || 0);
  const avgVol20   = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
  const latestBar  = bars.at(-1);
  const curVol     = latestBar.v || 0;
  const hasVolume  = avgVol20 > 0 && curVol > avgVol20;

  // ── Breakout detection — only on candles AFTER the ORB window ─────────────
  // A breakout requires a full CANDLE CLOSE above orbHigh or below orbLow.
  // Wicks do not count. Check most recent post-ORB bar.
  let breakout = 'NONE';
  let breakoutBar = null;

  if (postOrbBars.length > 0) {
    const latest = postOrbBars.at(-1);
    if (latest.c > orbHigh)  { breakout = 'BULLISH'; breakoutBar = latest; }
    if (latest.c < orbLow)   { breakout = 'BEARISH'; breakoutBar = latest; }
  }

  // ── False breakout check — did price re-enter the range within 2 candles? ─
  let fakeout = false;
  if (breakout !== 'NONE' && postOrbBars.length >= 2) {
    // Check the 2 bars just before the latest bar
    const recentPost = postOrbBars.slice(-3, -1);
    const alreadyBroken = recentPost.some(b =>
      (breakout === 'BULLISH' && b.c > orbHigh) || (breakout === 'BEARISH' && b.c < orbLow)
    );
    if (alreadyBroken) {
      // ORB broke before — check if any intermediate bar re-entered the range
      fakeout = recentPost.some(b => b.c >= orbLow && b.c <= orbHigh);
    }
  }

  const price        = latestBar.c;
  const vwapAligned  = breakout === 'NONE' ? null
    : breakout === 'BULLISH' ? price > (vwap ?? price)
    : price < (vwap ?? price);
  const rsiOk        = breakout === 'NONE' ? null
    : breakout === 'BULLISH' ? rsi <= 75
    : rsi >= 25;

  const failReasons = [];
  if (!isMWF)      failReasons.push('Not a weekday (Mon–Fri)');
  if (!validRange) failReasons.push(`Range ${rangeWidthPct.toFixed(3)}% < 0.2%`);
  if (!vixOk)      failReasons.push(`VIX ${vix} > 35`);
  if (breakout === 'NONE') failReasons.push('No breakout yet');
  if (breakout !== 'NONE') {
    if (!hasVolume)    failReasons.push('Volume below 20-bar avg');
    if (!vwapAligned)  failReasons.push('VWAP misaligned');
    if (!rsiOk)        failReasons.push(`RSI ${rsi.toFixed(1)} in extreme zone`);
    if (fakeout)       failReasons.push('False breakout — price re-entered range');
  }

  const allFiltersPassed = isMWF && validRange && vixOk && breakout !== 'NONE'
    && hasVolume && vwapAligned && rsiOk && !fakeout;

  // ── Risk/reward levels ────────────────────────────────────────────────────
  const rangeWidth = orbHigh - orbLow;
  const slLevel    = +orbMid.toFixed(2); // stop = 50% of ORB (midpoint)
  const tpLevel    = breakout === 'BULLISH'
    ? +(orbHigh + rangeWidth * 1.5).toFixed(2)   // primary: 1.5× range beyond breakout
    : +(orbLow  - rangeWidth * 1.5).toFixed(2);

  const result = {
    today, isMWF, vix: vix ? +vix.toFixed(2) : null, vixOk,
    orbHigh: +orbHigh.toFixed(2), orbLow: +orbLow.toFixed(2), orbMid: +orbMid.toFixed(2),
    rangeWidthPct: +rangeWidthPct.toFixed(3), validRange,
    price: +price.toFixed(2), vwap: vwap ? +vwap.toFixed(2) : null,
    rsi: +rsi.toFixed(1), rsiOk,
    hasVolume, vwapAligned, fakeout, breakout,
    orbWindowMins, orbBarsCount: orbBars.length, postOrbBarsCount: postOrbBars.length,
    allFiltersPassed,
    failReasons,
    confirmed: allFiltersPassed,
    direction: breakout !== 'NONE' ? breakout : null,
    slLevel, tpLevel,
    signal: allFiltersPassed
      ? `ORB ${breakout} · ${rangeWidthPct.toFixed(3)}% range · RSI ${rsi.toFixed(1)} · VIX ${vix?.toFixed(1) ?? '—'}`
      : failReasons.length ? `SKIP — ${failReasons.join(', ')}` : 'Monitoring…',
    reason: failReasons.length ? failReasons.join(', ') : null,
  };

  _orbSignalCache = result;
  _orbSignalTs    = now;
  return result;
}

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
// or null if the proxy itself is also > $30 or if no mapping exists.
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

// ── Shared PDT guard ────────────────────────────────────────────────────────
// Pattern Day Trader rule: ≥4 same-day round-trips in a rolling 5-day window
// on a margin account with equity < $25,000 triggers PDT status.
// We block any NEW entry conservatively at daytrade_count >= 2 (1-trade buffer)
// to prevent accidentally crossing the 4-trade threshold if 2 bots fire at once.
async function checkPDTAllowed(userId, botName) {
  try {
    const acct    = await alpacaFetch(userId, '/v2/account');
    const equity  = parseFloat(acct.equity || 0);
    const dtCount = parseInt(acct.daytrade_count || 0, 10);
    const isPDT   = !!acct.pattern_day_trader;
    if (isPDT && equity < 25000) {
      console.log(`[${botName}] PDT flagged — equity $${equity.toFixed(0)} < $25,000 — blocked`);
      return false;
    }
    // Block at 3 used — the cross-bot lock prevents concurrent races so we use the natural limit
    if (!isPDT && dtCount >= 3) {
      console.log(`[${botName}] PDT guard — ${dtCount}/3 day-trades used (rolling 5-day) for user ${userId} — blocked`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[${botName}] Could not fetch account for PDT check (user ${userId}):`, e.message);
    return false; // block on fetch error — safety first
  }
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
// COUNTERTREND SETUP — Strategy 4
// ══════════════════════════════════════════════════════════════════════════════

// ── CT auto-trade settings table ──────────────────────────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS ct_auto_settings (
    user_id  INTEGER PRIMARY KEY,
    enabled  INTEGER NOT NULL DEFAULT 0,
    amount   REAL    NOT NULL DEFAULT 500,
    leverage REAL    NOT NULL DEFAULT 1
  )
`).run();

// ── RSI(14) helper ─────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

// ── Full RSI series (one value per bar) ───────────────────────────────────────
function calcRSISeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

// ── SMA helper ─────────────────────────────────────────────────────────────────
function calcSMA(arr, period) {
  if (!arr || arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Pivot high/low detection ───────────────────────────────────────────────────
function findPivots(bars, wing = 5) {
  const highs = [], lows = [];
  for (let i = wing; i < bars.length - wing; i++) {
    const h = bars[i].h, l = bars[i].l;
    let isHigh = true, isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (bars[j].h >= h) isHigh = false;
      if (bars[j].l <= l) isLow  = false;
    }
    if (isHigh) highs.push({ idx: i, price: h });
    if (isLow)  lows.push({ idx: i,  price: l });
  }
  return { highs, lows };
}

// ── S/R levels tested ≥2 times in 6 months ────────────────────────────────────
function findSRLevels(bars) {
  const tol = 0.015; // 1.5% cluster tolerance
  const { highs, lows } = findPivots(bars, 5);

  function cluster(pivots, type) {
    const levels = [];
    for (const p of pivots) {
      let merged = false;
      for (const lv of levels) {
        if (Math.abs(p.price - lv.price) / lv.price < tol) {
          lv.price = (lv.price * lv.count + p.price) / (lv.count + 1);
          lv.count++;
          merged = true;
          break;
        }
      }
      if (!merged) levels.push({ price: p.price, count: 1, type });
    }
    return levels.filter(lv => lv.count >= 2);
  }

  const resistance = cluster(highs, 'resistance');
  const support    = cluster(lows,  'support');
  return { resistance, support };
}

// ── Engulfing candle detection ─────────────────────────────────────────────────
function detectEngulfing(bars) {
  if (bars.length < 2) return { bearish: false, bullish: false };
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  const bearish = curr.o > prev.c && curr.c < prev.o && curr.c < curr.o;
  const bullish = curr.o < prev.c && curr.c > prev.o && curr.c > curr.o;
  return { bearish, bullish };
}

// ── RSI divergence (look back up to 50 bars) ──────────────────────────────────
function detectRSIDivergence(bars, rsiSeries) {
  const wing = 4, lookback = Math.min(50, bars.length - 1);
  const start = bars.length - lookback;

  const swingHighs = [], swingLows = [];
  for (let i = start + wing; i < bars.length - wing; i++) {
    let isPH = true, isPL = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isPH = false;
      if (bars[j].l <= bars[i].l) isPL  = false;
    }
    if (isPH && rsiSeries[i] != null) swingHighs.push({ i, price: bars[i].h, rsi: rsiSeries[i] });
    if (isPL  && rsiSeries[i] != null) swingLows.push({ i,  price: bars[i].l, rsi: rsiSeries[i] });
  }

  let bearishDiv = false, bullishDiv = false;
  if (swingHighs.length >= 2) {
    const [a, b] = swingHighs.slice(-2);
    if (b.price > a.price && b.rsi < a.rsi) bearishDiv = true;
  }
  if (swingLows.length >= 2) {
    const [a, b] = swingLows.slice(-2);
    if (b.price < a.price && b.rsi > a.rsi) bullishDiv = true;
  }
  return { bearishDiv, bullishDiv };
}

// ── 2618 trendline-break + retest ─────────────────────────────────────────────
function detect2618(bars, rsiSeries) {
  const { highs, lows } = findPivots(bars, 5);
  const n = bars.length;

  function checkBreakRetest(pivots, side) {
    if (pivots.length < 2) return false;
    const [p1, p2] = pivots.slice(-2);
    // Trendline: y = p1.price + (p2.price - p1.price) * (x - p1.idx) / (p2.idx - p1.idx)
    const slope  = (p2.price - p1.price) / (p2.idx - p1.idx);
    const trendAt = x => p1.price + slope * (x - p1.idx);

    // Did price cross the trendline after p2?
    let crossIdx = -1;
    for (let i = p2.idx + 1; i < n; i++) {
      const tl = trendAt(i);
      if (side === 'bear' && bars[i].c < tl) { crossIdx = i; break; }
      if (side === 'bull' && bars[i].c > tl) { crossIdx = i; break; }
    }
    if (crossIdx < 0) return false;

    // After cross, has price retested the trendline?
    const currTL = trendAt(n - 1);
    const currClose = bars[n - 1].c;
    const dist = Math.abs(currClose - currTL) / currTL;
    if (dist > 0.015) return false; // within 1.5%

    // Retest bar closes in reversal direction
    if (side === 'bear' && bars[n - 1].c < bars[n - 2].c) return true;
    if (side === 'bull' && bars[n - 1].c > bars[n - 2].c) return true;
    return false;
  }

  const bearish2618 = checkBreakRetest(highs, 'bear');
  const bullish2618 = checkBreakRetest(lows,  'bull');
  return { bearish2618, bullish2618 };
}

// ── Main CT Signal Computation ─────────────────────────────────────────────────
async function computeCTSignal(symbol) {
  try {
    // Fetch ~200 days of daily bars
    const rawBars = await yf.historical(symbol, {
      period1: new Date(Date.now() - 210 * 86400000),
      period2: new Date(),
      interval: '1d',
    });
    if (!rawBars || rawBars.length < 30) return null;

    const bars = rawBars.map(b => ({
      t: b.date, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
    })).filter(b => b.c > 0);
    if (bars.length < 30) return null;

    const closes = bars.map(b => b.c);
    const highs  = bars.map(b => b.h);
    const lows   = bars.map(b => b.l);
    const n = bars.length;
    const price = closes[n - 1];

    // ── Indicators ──────────────────────────────────────────────────────────
    const rsiSeries = calcRSISeries(closes);
    const rsi       = rsiSeries[n - 1];
    const sma50     = calcSMA(closes, 50);
    const sma200    = calcSMA(closes, 200);
    const swingHigh = Math.max(...highs.slice(-20));
    const swingLow  = Math.min(...lows.slice(-20));

    // ── RSI overbought/oversold ─────────────────────────────────────────────
    const overbought  = rsi != null && rsi >= 70;
    const oversold    = rsi != null && rsi <= 30;

    // ── S/R Levels ──────────────────────────────────────────────────────────
    const { resistance, support } = findSRLevels(bars);

    // Find nearest resistance/support to current price (within 3%)
    const nearRes = resistance
      .filter(lv => Math.abs(price - lv.price) / price < 0.03)
      .sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price))[0] || null;
    const nearSup = support
      .filter(lv => Math.abs(price - lv.price) / price < 0.03)
      .sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price))[0] || null;

    const nearResWithin1pct = nearRes && Math.abs(price - nearRes.price) / price < 0.01;
    const nearSupWithin1pct = nearSup && Math.abs(price - nearSup.price) / price < 0.01;

    // ── Engulfing candles ────────────────────────────────────────────────────
    const { bearish: bearEngulf, bullish: bullEngulf } = detectEngulfing(bars);

    // ── RSI Divergence ───────────────────────────────────────────────────────
    const { bearishDiv, bullishDiv } = detectRSIDivergence(bars, rsiSeries);

    // ── 2618 Setup ───────────────────────────────────────────────────────────
    const { bearish2618, bullish2618 } = detect2618(bars, rsiSeries);

    // ── Short: at resistance + reversal confirmation ─────────────────────────
    const shortAtRes     = overbought && nearResWithin1pct;
    const shortConfirm   = bearEngulf || bearishDiv;
    const shortSignal    = shortAtRes && shortConfirm;

    // ── Long: at support + reversal confirmation ─────────────────────────────
    const longAtSup      = oversold && nearSupWithin1pct;
    const longConfirm    = bullEngulf || bullishDiv;
    const longSignal     = longAtSup && longConfirm;

    // ── 2618 signals (override direction) ───────────────────────────────────
    const is2618Short = bearish2618 && (overbought || nearResWithin1pct);
    const is2618Long  = bullish2618 && (oversold  || nearSupWithin1pct);

    // ── Determine primary signal type ────────────────────────────────────────
    let signalType = 'WATCHING';
    let direction  = null;
    if (is2618Short || is2618Long) {
      signalType = '2618 RETEST ENTRY';
      direction  = is2618Short ? 'SHORT' : 'LONG';
    } else if (shortSignal) {
      signalType = 'COUNTERTREND SHORT SETUP';
      direction  = 'SHORT';
    } else if (longSignal) {
      signalType = 'COUNTERTREND LONG SETUP';
      direction  = 'LONG';
    }

    const confirmed = signalType !== 'WATCHING';

    // ── Stop & target — SL = 1 tick outside swing high/low; TP = prior S/R or key MA (min 2:1) ──
    let stopLoss = null, target = null, riskReward = null;
    const srLevel = direction === 'SHORT' ? nearRes?.price : nearSup?.price;
    const srLabel = direction === 'SHORT' ? 'Resistance' : 'Support';

    if (direction === 'SHORT') {
      stopLoss = +(swingHigh * 1.001).toFixed(2); // 1 tick above swing high
      const stopDist = stopLoss - price;
      const candidates = [sma50, sma200, nearSup?.price].filter(v => v && v < price);
      target = candidates.length ? Math.max(...candidates) : price - 2 * stopDist;
      riskReward = stopDist > 0 ? ((price - target) / stopDist).toFixed(2) : null;
    } else if (direction === 'LONG') {
      stopLoss = +(swingLow * 0.999).toFixed(2);  // 1 tick below swing low
      const stopDist = price - stopLoss;
      const candidates = [sma50, sma200, nearRes?.price].filter(v => v && v > price);
      target = candidates.length ? Math.min(...candidates) : price + 2 * stopDist;
      riskReward = stopDist > 0 ? ((target - price) / stopDist).toFixed(2) : null;
    }

    return {
      symbol,
      price:              +price.toFixed(2),
      rsi:                rsi != null ? +rsi.toFixed(1) : null,
      overbought,
      oversold,
      sma50:              sma50 ? +sma50.toFixed(2) : null,
      sma200:             sma200 ? +sma200.toFixed(2) : null,
      nearResistance:     nearRes ? +nearRes.price.toFixed(2) : null,
      nearSupport:        nearSup ? +nearSup.price.toFixed(2) : null,
      nearResWithin1pct,
      nearSupWithin1pct,
      srLevel:            srLevel ? +srLevel.toFixed(2) : null,
      srLabel,
      bearEngulf,
      bullEngulf,
      bearishDiv,
      bullishDiv,
      bearish2618,
      bullish2618,
      swingHigh:          +swingHigh.toFixed(2),
      swingLow:           +swingLow.toFixed(2),
      direction,
      signalType,
      confirmed,
      stopLoss:           stopLoss ? +stopLoss.toFixed(2) : null,
      target:             target   ? +target.toFixed(2)   : null,
      riskReward:         riskReward ? +riskReward : null,
      candlePattern:      bearEngulf ? 'Bearish Engulfing' : bullEngulf ? 'Bullish Engulfing' : null,
      divergence:         bearishDiv ? 'Bearish RSI Divergence' : bullishDiv ? 'Bullish RSI Divergence' : null,
    };
  } catch (e) {
    return null;
  }
}

// ── CT scan universe (broad large-cap list) ────────────────────────────────────
const CT_UNIVERSE = MASTER_UNIVERSE;

// ── CT signal cache ────────────────────────────────────────────────────────────
const _ctCache = new Map();

// ── GET /api/ct/signal/:symbol ─────────────────────────────────────────────────
app.get('/api/ct/signal/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const cached = _ctCache.get(sym);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return res.json(cached.data);
  const data = await computeCTSignal(sym);
  if (!data) return res.status(404).json({ error: 'No data' });
  _ctCache.set(sym, { ts: Date.now(), data });
  res.json(data);
});

// ── GET /api/ct/scan?symbols=... ──────────────────────────────────────────────
app.get('/api/ct/scan', async (req, res) => {
  const requested = req.query.symbols
    ? req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : CT_UNIVERSE;

  const results = [];
  const concurrency = 6;
  for (let i = 0; i < requested.length; i += concurrency) {
    const batch = requested.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(s => computeCTSignal(s)));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value) {
        _ctCache.set(batch[j], { ts: Date.now(), data: r.value });
        results.push(r.value);
      }
    });
  }
  results.sort((a, b) => {
    const rank = s => s === '2618 RETEST ENTRY' ? 0 : s === 'COUNTERTREND SHORT SETUP' || s === 'COUNTERTREND LONG SETUP' ? 1 : 2;
    return rank(a.signalType) - rank(b.signalType);
  });
  res.json({ results, total: results.length, confirmed: results.filter(r => r.confirmed).length });
});

// ── GET /api/ct/auto-settings ─────────────────────────────────────────────────
app.get('/api/ct/auto-settings', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM ct_auto_settings WHERE user_id = ?').get(req.session.userId);
  res.json(row || { enabled: 0, amount: 500, leverage: 1 });
});

// ── PUT /api/ct/auto-settings ─────────────────────────────────────────────────
app.put('/api/ct/auto-settings', requireAuth, (req, res) => {
  const { enabled, amount, leverage } = req.body;
  db.prepare(`
    INSERT INTO ct_auto_settings (user_id, enabled, amount, leverage)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, amount=excluded.amount, leverage=excluded.leverage
  `).run(req.session.userId, enabled ? 1 : 0, amount || 500, leverage || 1);
  res.json({ ok: true });
});

// ── GET /api/ct/trade-log ─────────────────────────────────────────────────────
app.get('/api/ct/trade-log', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM auto_trade_log WHERE user_id = ? AND strategy = 'countertrend' ORDER BY created_at DESC LIMIT 50`
  ).all(req.session.userId);
  res.json(rows);
});

// ── Server-side CT Auto-Trader ─────────────────────────────────────────────────
async function runCTAutoTrader() {
  const now = new Date();
  const h = now.getUTCHours(), m = now.getUTCMinutes();
  const inSession = (h > 13 || (h === 13 && m >= 30)) && h < 20;
  if (!inSession) return;

  const users = db.prepare('SELECT DISTINCT user_id, 500 AS amount, 1 AS leverage FROM alpaca_creds').all();
  if (!users.length) return;

  // Build confirmed signals using cache (5-min TTL) to avoid hammering Yahoo every 60 sec
  const nowMs = Date.now();
  const CT_CACHE_TTL = 5 * 60 * 1000;
  const signals = [];
  const concurrency = 4;
  for (let i = 0; i < CT_UNIVERSE.length; i += concurrency) {
    const batch = CT_UNIVERSE.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(async s => {
      const cached = _ctCache.get(s);
      if (cached && nowMs - cached.ts < CT_CACHE_TTL) return cached.data;
      const data = await computeCTSignal(s);
      if (data) _ctCache.set(s, { ts: nowMs, data });
      return data;
    }));
    settled.forEach(r => {
      if (r.status === 'fulfilled' && r.value?.confirmed) signals.push(r.value);
    });
  }
  if (!signals.length) return;

  // Pick best CT signal by strength score
  signals.sort((a, b) => (b.score || 0) - (a.score || 0));
  const bestCT = signals[0];
  // ── Seasonal & OpEx context — computed once per scan cycle ────────────────
  const ctSeason = computeSeasonalContext();
  if (ctSeason.hardBlock) {
    console.log(`[CT-Bot] SEASONAL BLOCK: ${ctSeason.hardBlockReason}`);
    return;
  }
  console.log(`[CT-Bot] Best signal: ${bestCT.symbol} ${bestCT.signalType} (${signals.length} confirmed) | Season: ${ctSeason.monthly.label} | OpEx: ${ctSeason.daysToOpEx}d | SizeMult: ${ctSeason.sizeMult}× ${ctSeason.inOpExWeek ? '(OpEx week)' : ''}`);

  for (const user of users) {
    const creds = db.prepare('SELECT * FROM alpaca_creds WHERE user_id = ?').get(user.user_id);
    if (!creds) continue;
    if (!isBotEnabled(user.user_id, 'countertrend')) { console.log(`[CT-Bot] Disabled for user ${user.user_id} — skipping`); continue; }
    if (!acquireBotLock(user.user_id)) { console.log(`[CT-Bot] User ${user.user_id} locked by another bot — skipping`); continue; }
    try {
    if (!await checkPDTAllowed(user.user_id, 'CT-Bot')) continue;

    // Count positions + pending bracket orders toward slot cap
    const slots = await getOpenSlots(user.user_id, 'CT-Bot');
    if (!slots || slots.available <= 0) continue;
    const positions = slots.positions;

    for (const sig of [bestCT]) {
      // Cooldown: 1 trade per symbol per day per strategy
      const alreadyTraded = db.prepare(
        `SELECT id FROM auto_trade_log WHERE user_id=? AND symbol=? AND strategy='countertrend'
         AND created_at > datetime('now','-1 day')`
      ).get(user.user_id, sig.symbol);
      if (alreadyTraded) continue;

      if (Array.isArray(positions) && positions.some(p => p.symbol === sig.symbol)) continue;

      const lev    = Math.min(4, Math.max(1, user.leverage || 1));
      const amount = (user.amount || 500) * lev * ctSeason.sizeMult; // seasonal sizing adjustment

      if (sig.direction === 'LONG') {
        // ── LONG: buy the underlying (or its leveraged proxy if > $30) ─────
        const price  = sig.price;
        const ctSpyGate = await checkSPYGate(sig.symbol, price, 'long');
        if (!ctSpyGate.allowed) { console.log(`[CT-Bot] SPY-Gate BLOCKED: ${ctSpyGate.reason}`); continue; }
        const ctLongWhaleGate = await checkWhaleGate(sig.symbol, 'LONG');
        if (!ctLongWhaleGate.allowed) { console.log(`[CT-Bot] Whale-Gate BLOCKED: ${ctLongWhaleGate.reason}`); continue; }
        if (ctLongWhaleGate.reason) console.log(`[CT-Bot] Whale-Gate: ${ctLongWhaleGate.reason}`);
        const ctLongDPGate = await checkDarkPoolGate(sig.symbol, price, 'LONG');
        if (!ctLongDPGate.allowed) { console.log(`[CT-Bot] DP-Gate BLOCKED: ${ctLongDPGate.reason}`); continue; }
        if (ctLongDPGate.reason) console.log(`[CT-Bot] DP-Gate: ${ctLongDPGate.reason}`);
        // Route expensive stocks ($30+) to their 2×/3× leveraged proxy
        let tradeSymbol = sig.symbol;
        let tradePrice  = price;
        if (price > MAX_TRADE_PRICE) {
          const proxy = await getLeveragedProxy(sig.symbol, price);
          if (!proxy) { console.log(`[CT-Bot] SKIP ${sig.symbol} @ $${price} — above $30 cap, no proxy available`); continue; }
          console.log(`[CT-Bot] ${sig.symbol} @ $${price} → leveraged proxy ${proxy.symbol} @ $${proxy.price}`);
          if (Array.isArray(positions) && positions.some(p => p.symbol === proxy.symbol)) { console.log(`[CT-Bot] Already holding proxy ${proxy.symbol}`); continue; }
          tradeSymbol = proxy.symbol;
          tradePrice  = proxy.price;
        }
        const shares = Math.max(1, Math.floor(amount / tradePrice));
        // Tighten stop during OpEx/bearish season: bring stop closer to entry by stopAdjust factor
        const rawSLDist = sig.stopLoss ? (tradePrice - sig.stopLoss) : (tradePrice * 0.015);
        const adjSLDist = rawSLDist / ctSeason.stopAdjust;
        const slPrice   = Math.max(0.01, tradePrice - adjSLDist).toFixed(2);
        const tpPrice = sig.target ? sig.target.toFixed(2) : (tradePrice * 1.04).toFixed(2);
        const orderBody = {
          symbol: tradeSymbol, qty: String(shares), side: 'buy',
          type: 'market', time_in_force: 'day', order_class: 'bracket',
          take_profit: { limit_price: tpPrice }, stop_loss: { stop_price: slPrice },
        };
        try {
          const order = await alpacaFetch(user.user_id, '/v2/orders', { method: 'POST', body: JSON.stringify(orderBody) });
          db.prepare(`INSERT INTO auto_trade_log (user_id,symbol,side,shares,entry_price,tp_price,sl_price,alpaca_order_id,signal,strategy,status,created_at) VALUES (?,?,'buy',?,?,?,?,?,?,'countertrend','open',datetime('now'))`).run(user.user_id, tradeSymbol, shares, tradePrice, tpPrice, slPrice, order.id || null, sig.signalType);
          console.log(`[CT-Bot] ORDER: BUY ${shares} ${tradeSymbol} @ ~$${tradePrice} [${sig.signalType}]${tradeSymbol !== sig.symbol ? ` (proxy for ${sig.symbol})` : ''}`);
        } catch (e) { console.error(`[CT-Bot] Order failed ${tradeSymbol}:`, e.message); }

      } else {
        // ── SHORT: buy the corresponding inverse ETF instead of shorting ──
        const inverseTicker = INVERSE_MAP[sig.symbol];
        if (!inverseTicker) {
          console.log(`[CT-Bot] No inverse ETF mapped for ${sig.symbol} SHORT — skipping`);
          continue;
        }
        // SPY gate for short bias
        const ctShortGate = await checkSPYGate(sig.symbol, sig.price, 'short');
        if (!ctShortGate.allowed) { console.log(`[CT-Bot] SPY-Gate BLOCKED short: ${ctShortGate.reason}`); continue; }
        const ctShortWhaleGate = await checkWhaleGate(sig.symbol, 'SHORT');
        if (!ctShortWhaleGate.allowed) { console.log(`[CT-Bot] Whale-Gate BLOCKED short: ${ctShortWhaleGate.reason}`); continue; }
        if (ctShortWhaleGate.reason) console.log(`[CT-Bot] Whale-Gate short: ${ctShortWhaleGate.reason}`);
        const ctShortDPGate = await checkDarkPoolGate(sig.symbol, sig.price, 'SHORT');
        if (!ctShortDPGate.allowed) { console.log(`[CT-Bot] DP-Gate BLOCKED short: ${ctShortDPGate.reason}`); continue; }
        if (ctShortDPGate.reason) console.log(`[CT-Bot] DP-Gate short: ${ctShortDPGate.reason}`);
        // Check cooldown on inverse ticker too
        const invAlreadyIn = Array.isArray(positions) && positions.some(p => p.symbol === inverseTicker);
        if (invAlreadyIn) { console.log(`[CT-Bot] Already holding ${inverseTicker} — skipping`); continue; }

        const invBars = await fetchOHLCV(inverseTicker, 2).catch(() => null);
        const invPrice = invBars?.at(-1)?.c;
        if (!invPrice) {
          console.log(`[CT-Bot] Could not fetch price for ${inverseTicker} — skipping`);
          continue;
        }
        // Translate % risk/reward from underlying signal to inverse ETF price levels
        const slPct = sig.stopLoss ? (sig.stopLoss - sig.price) / sig.price : 0.015;
        const tpPct = sig.target   ? (sig.price - sig.target)   / sig.price : 0.03;
        const invSlPrice = (invPrice * (1 - slPct)).toFixed(2);
        const invTpPrice = (invPrice * (1 + tpPct)).toFixed(2);
        const invShares  = Math.max(1, Math.floor(amount / invPrice));
        const orderBody  = {
          symbol: inverseTicker, qty: String(invShares), side: 'buy',
          type: 'market', time_in_force: 'day', order_class: 'bracket',
          take_profit: { limit_price: invTpPrice }, stop_loss: { stop_price: invSlPrice },
        };
        try {
          const order = await alpacaFetch(user.user_id, '/v2/orders', { method: 'POST', body: JSON.stringify(orderBody) });
          db.prepare(`INSERT INTO auto_trade_log (user_id,symbol,side,shares,entry_price,tp_price,sl_price,alpaca_order_id,signal,strategy,status,created_at) VALUES (?,?,'buy',?,?,?,?,?,?,'countertrend','open',datetime('now'))`).run(user.user_id, inverseTicker, invShares, invPrice, invTpPrice, invSlPrice, order.id || null, `${sig.signalType} via ${inverseTicker} (signal: ${sig.symbol})`);
          console.log(`[CT-Bot] ORDER: BUY ${invShares} ${inverseTicker} (inverse of ${sig.symbol} SHORT) [${sig.signalType}] SL=${invSlPrice} TP=${invTpPrice}`);
        } catch (e) { console.error(`[CT-Bot] Order failed ${inverseTicker}:`, e.message); }
      }
    }
    } finally { releaseBotLock(user.user_id); }
  }
}

// ── Start CT auto-trader interval — scans every 60 seconds during market hours ─
setInterval(runCTAutoTrader, 60 * 1000);
console.log('[CT-Bot] Countertrend auto-trader initialized — scans every 60 sec during market hours');

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
async function computeSwingLongSignal(symbol) {
  const daily = await fetchOHLCV(symbol, 350).catch(() => null);
  if (!daily || daily.length < 100) return { symbol, confirmed: false, error: 'Insufficient data' };

  const weekly  = groupDailyToWeekly(daily);
  if (weekly.length < 30) return { symbol, confirmed: false, error: 'Insufficient weekly data' };

  const wCloses  = weekly.map(b => b.c);
  const wVolumes = weekly.map(b => b.v);
  const curW     = weekly.at(-1);
  const price    = curW.c;

  // Use longest available window (200 bars ideal; fall back to what we have)
  const win200 = Math.min(200, wCloses.length - 1);
  const win50  = Math.min(50,  wCloses.length - 1);
  const win21  = Math.min(21,  wCloses.length - 1);

  const ref200 = calcSMA(wCloses, win200);
  const sma50w = calcSMA(wCloses, win50);
  const ema21w = calcEMA(wCloses, win21);

  // Cond 1: Price within 2% of 200w SMA/EMA
  const pct200 = Math.abs(price - ref200) / ref200 * 100;
  const cond1  = pct200 <= 2;

  // Cond 2: Weekly RSI 30–45, hooking upward
  let wRSI = 50, prevWRSI = 50;
  try {
    const rs = calcRSISeries(wCloses, 14);
    wRSI = rs.at(-1); prevWRSI = rs.at(-2);
  } catch (_) {}
  const cond2 = wRSI >= 30 && wRSI <= 45 && wRSI > prevWRSI;

  // Cond 3: Daily bullish engulfing or hammer, closing above 200d SMA
  const dCloses = daily.map(b => b.c);
  const sma200d = calcSMA(dCloses, Math.min(200, dCloses.length - 1));
  const d0 = daily.at(-1), d1 = daily.at(-2);
  const isBullEngulf = d0.c > d0.o && d0.c > d1.o && d0.o < d1.c && d0.c > sma200d;
  const isHammer     = d0.c > d0.o && (d0.h - d0.c) / Math.max(0.001, d0.h - d0.l) < 0.3 && d0.c > sma200d;
  const cond3 = isBullEngulf || isHammer;

  // Cond 4: 50w SMA > 200w SMA (secular uptrend — correction, not breakdown)
  const cond4 = sma50w > ref200;

  // Cond 5: Weekly volume ≥ 10-week average
  const vol10avg = wVolumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
  const cond5    = curW.v >= vol10avg;

  const confirmed = cond1 && cond2 && cond3 && cond4 && cond5;

  // Swing high for TP3 (highest close over last 52 weeks)
  const priorHigh = Math.max(...wCloses.slice(-52));
  const tp1 = +ema21w.toFixed(2);
  const tp2 = +sma50w.toFixed(2);
  const tp3 = priorHigh > price ? +priorHigh.toFixed(2) : +(price * 1.08).toFixed(2);

  return {
    symbol, confirmed, direction: 'LONG',
    price: +price.toFixed(2), ref200: +ref200.toFixed(2),
    sma50w: +sma50w.toFixed(2), ema21w, wRSI: +wRSI.toFixed(1), pct200: +pct200.toFixed(2),
    cond1, cond2, cond3, cond4, cond5,
    stopLevel: +(ref200 * 0.97).toFixed(2),
    tp1, tp2, tp3,
    failReasons: [
      !cond1 && `Price ${pct200.toFixed(1)}% from 200w SMA (need ≤2%)`,
      !cond2 && `Weekly RSI ${wRSI.toFixed(1)} not in 30–45 range or not hooking up`,
      !cond3 && 'No bullish daily candle (engulfing/hammer) above 200d SMA',
      !cond4 && '50w SMA below 200w SMA — secular uptrend broken',
      !cond5 && 'Volume below 10-week average',
    ].filter(Boolean),
  };
}

// ── Swing Inverse Signal (TOP) — 5 conditions, buys SH (1× inverse SPY) ──────
async function computeSwingInverseSignal() {
  const daily = await fetchOHLCV('SPY', 350).catch(() => null);
  if (!daily || daily.length < 100) return { symbol: 'SH', confirmed: false, error: 'Insufficient data' };

  const weekly   = groupDailyToWeekly(daily);
  if (weekly.length < 30) return { symbol: 'SH', confirmed: false, error: 'Insufficient weekly data' };

  const wCloses  = weekly.map(b => b.c);
  const wVolumes = weekly.map(b => b.v);
  const curW     = weekly.at(-1);
  const prevW    = weekly.at(-2);
  const price    = curW.c;

  const win200 = Math.min(200, wCloses.length - 1);
  const ref200 = calcSMA(wCloses, win200);
  const ema21w = calcEMA(wCloses, Math.min(21, wCloses.length - 1));
  const sma50w = calcSMA(wCloses, Math.min(50, wCloses.length - 1));

  const ema8ser  = calcEMASeries(wCloses, Math.min(8,  wCloses.length - 2));
  const ema21ser = calcEMASeries(wCloses, Math.min(21, wCloses.length - 2));

  // Cond 1: SPY >10% above 200w SMA (extended / euphoric)
  const pct200 = (price - ref200) / ref200 * 100;
  const cond1  = pct200 > 10;

  // Cond 2: 8 EMA crossed below 21 EMA on weekly (macro momentum shift)
  const c8 = ema8ser.at(-1), c21 = ema21ser.at(-1);
  const p8 = ema8ser.at(-2), p21 = ema21ser.at(-2);
  const cond2 = c8 < c21 && p8 >= p21;

  // Cond 3: RSI was above 70, now rolled below 70 (overbought exit)
  let wRSI = 50, prevWRSI = 50;
  try {
    const rs = calcRSISeries(wCloses, 14);
    wRSI = rs.at(-1); prevWRSI = rs.at(-2);
  } catch (_) {}
  const cond3 = prevWRSI > 70 && wRSI < 70;

  // Cond 4: Bearish weekly candle (shooting star, bearish engulfing, dark cloud)
  const body     = Math.abs(curW.c - curW.o);
  const upWick   = curW.h - Math.max(curW.o, curW.c);
  const isStar   = curW.c < curW.o && upWick > body * 2;
  const isBearE  = curW.c < curW.o && curW.o > prevW.c && curW.c < prevW.o;
  const isDCloud = curW.c < curW.o && curW.o > prevW.h && curW.c < (prevW.o + prevW.c) / 2;
  const cond4    = isStar || isBearE || isDCloud;

  // Cond 5: Weekly volume ≥ 10-week average
  const vol10avg = wVolumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
  const cond5    = curW.v >= vol10avg;

  const confirmed = cond1 && cond2 && cond3 && cond4 && cond5;

  // SH moves inversely: its TP levels are where SPY finds support (going down)
  const tp1 = +ema21w.toFixed(2); // SPY 21w EMA
  const tp2 = +sma50w.toFixed(2); // SPY 50w SMA
  const tp3 = +ref200.toFixed(2); // SPY 200w SMA — ultimate magnet

  const shQuote = await yfChartQuote('SH').catch(() => null);
  const shPrice = shQuote?.price ?? 35;

  return {
    symbol: 'SH', confirmed, direction: 'INVERSE',
    price: +shPrice.toFixed(2), spyPrice: +price.toFixed(2),
    ref200: +ref200.toFixed(2), pct200: +pct200.toFixed(2), wRSI: +wRSI.toFixed(1),
    cond1, cond2, cond3, cond4, cond5,
    stopLevel: +(curW.h * 1.02).toFixed(2), // SL: SPY weekly close 2% above rejection high
    tp1, tp2, tp3,
    failReasons: [
      !cond1 && `SPY only ${pct200.toFixed(1)}% above 200w SMA (need >10%)`,
      !cond2 && 'No 8 EMA / 21 EMA bearish cross on weekly chart',
      !cond3 && `RSI ${wRSI.toFixed(1)} — no rollover from overbought (>70)`,
      !cond4 && 'No bearish reversal candle this week',
      !cond5 && 'Volume below 10-week average',
    ].filter(Boolean),
  };
}

// ── Entry execution ───────────────────────────────────────────────────────────
async function executeSwingEntry(userId, sig) {
  try {
    const existing = db.prepare(`SELECT id FROM swing_trade_log WHERE user_id=? AND phase NOT IN ('closed') AND direction=?`).get(userId, sig.direction);
    if (existing) { console.log(`[Swing-Bot] Already have open ${sig.direction} swing — skipping`); return; }

    const account  = await alpacaFetch(userId, '/v2/account');
    const equity   = parseFloat(account.equity || account.portfolio_value || 0);
    if (equity <= 0) return;

    // ── Seasonal context for Swing bot (advisory + sizing) ──────────────────
    const swingSeason = computeSeasonalContext();
    const ts = db.prepare('SELECT * FROM trade_settings WHERE user_id=?').get(userId)
             || { position_mode: 'pct', position_pct: 15, position_amount: 5000, leverage: 1 };
    const basePosValue = ts.position_mode === 'fixed'
      ? ts.position_amount
      : equity * (ts.position_pct / 100);
    const posValue = basePosValue * swingSeason.sizeMult; // apply seasonal scaling
    const price    = sig.price;
    if (!price || price <= 0) return;
    const shares   = Math.max(1, Math.floor(posValue / price));

    const seasonNote = swingSeason.sizeNotes.length
      ? ` | Seasonal: ${swingSeason.sizeNotes.join('; ')}`
      : '';
    console.log(`[Swing-Bot] Placing ${sig.direction} limit order: ${sig.symbol} × ${shares} @ $${price.toFixed(2)} | SL=$${sig.stopLevel} | TP1=$${sig.tp1} TP2=$${sig.tp2} TP3=$${sig.tp3} | SizeMult=${swingSeason.sizeMult}×${seasonNote}`);

    const order = await alpacaFetch(userId, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({ symbol: sig.symbol, qty: String(shares), side: 'buy', type: 'limit', time_in_force: 'day', limit_price: price.toFixed(2) }),
    });

    const notesField = `${sig.direction} | All 5 weekly conditions confirmed${seasonNote} | OpEx: ${swingSeason.daysToOpEx}d | ${swingSeason.monthly.label}`;
    db.prepare(`
      INSERT INTO swing_trade_log (user_id, symbol, direction, entry_price, shares, shares_remaining, alpaca_order_id, stop_level, trailing_stop, tp1_price, tp2_price, tp3_price, signal_date, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,date('now'),?)
    `).run(userId, sig.symbol, sig.direction, price, shares, shares, order.id || null, sig.stopLevel, sig.stopLevel, sig.tp1, sig.tp2, sig.tp3, notesField);

    console.log(`[Swing-Bot] ✓ Limit order placed: ${sig.symbol} × ${shares} @ $${price.toFixed(2)}`);
  } catch (e) {
    console.error(`[Swing-Bot] Entry failed for ${sig.symbol}:`, e.message);
  }
}

// ── Swing Auto-Trader — Monday-only entry, fires hourly ──────────────────────
async function runSwingAutoTrader() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (et.getDay() !== 1) return; // Monday only — wait for weekly candle confirmation
  if (!isMarketOpen()) return;

  // ── Seasonal & OpEx context — Swing bot is advisory; log but don't hard-block ─
  const swingRunSeason = computeSeasonalContext();
  if (swingRunSeason.hardBlock) {
    console.log(`[Swing-Bot] SEASONAL HARD BLOCK (will not enter): ${swingRunSeason.hardBlockReason}`);
    return;
  }
  console.log(`[Swing-Bot] Monday scan | Season: ${swingRunSeason.monthly.label} | SizeMult: ${swingRunSeason.sizeMult}× | OpEx: ${swingRunSeason.daysToOpEx}d away`);

  const users = db.prepare('SELECT DISTINCT user_id FROM alpaca_creds').all();
  if (!users.length) return;

  const [spyR, qqqR, invR] = await Promise.allSettled([
    computeSwingLongSignal('SPY'),
    computeSwingLongSignal('QQQ'),
    computeSwingInverseSignal(),
  ]);
  const spySig = spyR.status === 'fulfilled' ? spyR.value : null;
  const qqqSig = qqqR.status === 'fulfilled' ? qqqR.value : null;
  const invSig = invR.status === 'fulfilled' ? invR.value : null;

  const longSig = spySig?.confirmed ? spySig : qqqSig?.confirmed ? qqqSig : null;
  const shortSig = invSig?.confirmed ? invSig : null;

  console.log(`[Swing-Bot] Monday scan | SPY long: ${spySig?.confirmed||false} (${spySig?.failReasons?.length ? spySig.failReasons[0] : 'all pass'}) | QQQ long: ${qqqSig?.confirmed||false} | Inverse: ${shortSig?.confirmed||false}`);

  for (const user of users) {
    if (!getAlpacaCreds(user.user_id)) continue;
    if (!isBotEnabled(user.user_id, 'swing')) continue;
    if (longSig)  await executeSwingEntry(user.user_id, longSig);
    if (shortSig && !longSig) await executeSwingEntry(user.user_id, shortSig);
  }
}

// ── Swing TP Monitor — runs every 15 min, checks TP1/TP2/TP3 levels ──────────
async function monitorSwingTPs() {
  if (!isMarketOpen()) return;
  const openTrades = db.prepare(`SELECT * FROM swing_trade_log WHERE phase NOT IN ('closed')`).all();
  if (!openTrades.length) return;

  for (const trade of openTrades) {
    try {
      const q = await yfChartQuote(trade.symbol).catch(() => null);
      if (!q?.price) continue;
      const price     = q.price;
      const sharesLeft = trade.shares_remaining || trade.shares;
      if (sharesLeft <= 0) continue;

      // ── Stop loss ──────────────────────────────────────────────────────────
      if (price <= trade.trailing_stop) {
        console.log(`[Swing-Bot] Stop hit: ${trade.symbol} $${price.toFixed(2)} ≤ stop $${trade.trailing_stop} — closing`);
        try {
          await alpacaFetch(trade.user_id, `/v2/positions/${trade.symbol}`, { method: 'DELETE' });
          db.prepare(`UPDATE swing_trade_log SET phase='closed', closed_at=datetime('now'), notes=notes||' | STOP $'||? WHERE id=?`).run(price.toFixed(2), trade.id);
        } catch (e) { console.error('[Swing-Bot] Stop close error:', e.message); }
        continue;
      }

      // ── TP1: 21w EMA — trim 33%, trail stop to breakeven ──────────────────
      if (trade.phase === 'open' && price >= trade.tp1_price) {
        const sellQty  = Math.max(1, Math.floor(sharesLeft * 0.33));
        const newStop  = trade.entry_price;
        console.log(`[Swing-Bot] TP1 hit: ${trade.symbol} $${price.toFixed(2)} ≥ $${trade.tp1_price} — selling ${sellQty} shares, stop → breakeven $${newStop}`);
        try {
          await alpacaFetch(trade.user_id, '/v2/orders', { method: 'POST', body: JSON.stringify({ symbol: trade.symbol, qty: String(sellQty), side: 'sell', type: 'market', time_in_force: 'day' }) });
          db.prepare(`UPDATE swing_trade_log SET phase='tp1_hit', shares_remaining=?, trailing_stop=?, notes=notes||' | TP1 $'||? WHERE id=?`).run(sharesLeft - sellQty, newStop, price.toFixed(2), trade.id);
        } catch (e) { console.error('[Swing-Bot] TP1 trim error:', e.message); }
        continue;
      }

      // ── TP2: 50w SMA — trim another 33%, trail stop to TP1 ───────────────
      if (trade.phase === 'tp1_hit' && price >= trade.tp2_price) {
        const sellQty = Math.max(1, Math.floor(sharesLeft * 0.50));
        const newStop = trade.tp1_price;
        console.log(`[Swing-Bot] TP2 hit: ${trade.symbol} $${price.toFixed(2)} ≥ $${trade.tp2_price} — selling ${sellQty} shares, stop → TP1 $${newStop}`);
        try {
          await alpacaFetch(trade.user_id, '/v2/orders', { method: 'POST', body: JSON.stringify({ symbol: trade.symbol, qty: String(sellQty), side: 'sell', type: 'market', time_in_force: 'day' }) });
          db.prepare(`UPDATE swing_trade_log SET phase='tp2_hit', shares_remaining=?, trailing_stop=?, notes=notes||' | TP2 $'||? WHERE id=?`).run(sharesLeft - sellQty, newStop, price.toFixed(2), trade.id);
        } catch (e) { console.error('[Swing-Bot] TP2 trim error:', e.message); }
        continue;
      }

      // ── TP3: prior swing high / +8% — exit final 34% ─────────────────────
      if (trade.phase === 'tp2_hit' && price >= trade.tp3_price) {
        console.log(`[Swing-Bot] TP3 hit: ${trade.symbol} $${price.toFixed(2)} ≥ $${trade.tp3_price} — full exit`);
        try {
          await alpacaFetch(trade.user_id, `/v2/positions/${trade.symbol}`, { method: 'DELETE' });
          db.prepare(`UPDATE swing_trade_log SET phase='closed', shares_remaining=0, closed_at=datetime('now'), notes=notes||' | TP3 $'||? WHERE id=?`).run(price.toFixed(2), trade.id);
        } catch (e) { console.error('[Swing-Bot] TP3 close error:', e.message); }
      }
    } catch (e) {
      console.error(`[Swing-Bot] Monitor error trade ${trade.id}:`, e.message);
    }
  }
}

setInterval(runSwingAutoTrader, 60 * 60 * 1000);  // hourly — Monday gate inside
setInterval(monitorSwingTPs,   15 * 60 * 1000);   // TP/stop check every 15 min
console.log('[Swing-Bot] Swing auto-trader initialized — Monday entry (weekly confirmation) · SPY/QQQ long + SH inverse · TP1/TP2/TP3 trimming · Trailing stop');

// ══════════════════════════════════════════════════════════════════════════════
// BOT 6 — ORB (OPENING RANGE BREAKOUT) AUTO-TRADER
// SPY-only strategy. Runs every 2 minutes starting at 9:35 ET.
// Uses FMP 1-min bars to detect confirmed candle-close breakouts.
// BULLISH ORB → buy cheapest MASTER_UNIVERSE stock with positive momentum today
// BEARISH ORB → buy cheapest inverse ETF from MASTER_UNIVERSE
// Take profit: RSI ≥ 75 on the position (monitored every 2 min). Bracket order
// carries a generous 18% ceiling as emergency fallback only.
// One trade per day per user. Session is logged to orb_session_log for review.
// ══════════════════════════════════════════════════════════════════════════════

// All inverse/short ETFs present in MASTER_UNIVERSE — used by BEARISH ORB picker
const ORB_INVERSE_ETF_SET = new Set([
  'SQQQ','QID','AAPD','AMDD','AMZD','PLTD','QQQD','NVD','NVDQ','MSTZ','TSLZ','TSDD',
  'SBIT','TZA','SPXS','SOXS','TECS','FAZ','ERY','LABD','DUST','JDST',
  'AIBD','TSXD','DRIP','DXD','SRTY','BIS',
  'SH','PSQ','RWM','DOG','TBF','SJB','GLL','ZSL','SCO','SARK','GGLS','RGTZ','CORD',
]);

// Batch-fetch prices, % change, volume, and momentum score for a pool of symbols
async function fetchOrbCandidatePrices(symbols) {
  const results = [];
  for (let i = 0; i < symbols.length; i += 10) {
    const batch   = symbols.slice(i, i + 10);
    const settled = await Promise.allSettled(batch.map(s => yfChartQuote(s).catch(() => null)));
    settled.forEach(r => {
      if (r.status !== 'fulfilled' || !r.value) return;
      const q = r.value;
      if (!q.price || q.price <= 0 || q.price > MAX_TRADE_PRICE) return;
      const changePct = q.changesPercentage ?? 0;
      const volume    = q.volume    ?? 0;
      const avgVolume = q.avgVolume ?? 0;
      const relVol    = avgVolume > 0 ? +(volume / avgVolume).toFixed(2) : null;
      // Momentum score: % gain × relative-volume surge — identical to Momentum bot scoring
      const score     = relVol != null ? +(changePct * relVol).toFixed(3) : changePct;
      results.push({ symbol: q.symbol, price: q.price, change: changePct, volume, avgVolume, relVol, score });
    });
  }
  return results;
}

// ── ORB bullish candidate: highest-momentum cheap stock (pre-market pumper) ──
// Ranks by score = change% × relVol so a stock up 10% on 3× volume beats
// one up 1% on 5× volume. ADBG-style gap-and-rockets rise to the top.
// Tiers:  1) change ≥ 3% AND relVol ≥ 1.5  (confirmed pre-market surge)
//         2) change ≥ 1% AND relVol ≥ 1.0   (modest momentum)
//         3) any positive change              (last resort)
async function findCheapestBullishCandidate(heldSymbols) {
  const pool = MASTER_UNIVERSE.filter(s => !ORB_INVERSE_ETF_SET.has(s));
  const all  = await fetchOrbCandidatePrices(pool);
  const avail = all.filter(c => !heldSymbols.has(c.symbol) && c.change > 0);

  // Sort each tier by score DESC (best momentum first), not by price
  const tier1 = avail.filter(c => c.change >= 3 && (c.relVol ?? 0) >= 1.5)
                      .sort((a, b) => b.score - a.score);
  if (tier1.length) {
    console.log(`[ORB-Bot] Bullish tier-1 candidates: ${tier1.slice(0,5).map(c=>`${c.symbol}(+${c.change.toFixed(1)}% ${c.relVol}×vol)`).join(', ')}`);
    return tier1[0];
  }

  const tier2 = avail.filter(c => c.change >= 1 && (c.relVol ?? 0) >= 1.0)
                      .sort((a, b) => b.score - a.score);
  if (tier2.length) {
    console.log(`[ORB-Bot] Bullish tier-2 candidates: ${tier2.slice(0,5).map(c=>`${c.symbol}(+${c.change.toFixed(1)}% ${c.relVol}×vol)`).join(', ')}`);
    return tier2[0];
  }

  // Last-resort: any positive, sorted by score
  const tier3 = avail.sort((a, b) => b.score - a.score);
  if (tier3.length) console.log(`[ORB-Bot] Bullish tier-3 (last resort): ${tier3[0].symbol} +${tier3[0].change.toFixed(1)}%`);
  return tier3[0] ?? null;
}

// ── ORB bearish candidate: highest-momentum inverse ETF (market collapse play) ─
async function findCheapestBearishCandidate(heldSymbols) {
  const pool  = [...ORB_INVERSE_ETF_SET].filter(s => MASTER_UNIVERSE.includes(s));
  const all   = await fetchOrbCandidatePrices(pool);
  const avail = all.filter(c => !heldSymbols.has(c.symbol));

  // Prefer those already rising (inverse ETF up = market falling), ranked by score
  const rising = avail.filter(c => c.change > 0).sort((a, b) => b.score - a.score);
  if (rising.length) {
    console.log(`[ORB-Bot] Bearish candidates: ${rising.slice(0,5).map(c=>`${c.symbol}(+${c.change.toFixed(1)}%)`).join(', ')}`);
    return rising[0];
  }
  // Fallback: any available inverse, cheapest first (bearish signal is from SPY, not ETF change)
  return avail.sort((a, b) => a.price - b.price)[0] ?? null;
}

async function runORBAutoTrader() {
  if (!isMarketOpen()) return;

  // ORB window = 9:30–9:35 ET. Don't scan until window is confirmed closed + 1 bar buffer.
  const et      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const curMins = et.getHours() * 60 + et.getMinutes();
  if (curMins < 576) return; // wait until 9:36 ET so ORB bars are fully settled

  // ── Seasonal & OpEx context ───────────────────────────────────────────────
  const orbSeason = computeSeasonalContext();
  if (orbSeason.hardBlock) {
    console.log(`[ORB-Bot] SEASONAL BLOCK: ${orbSeason.hardBlockReason}`);
    return;
  }

  const users = db.prepare('SELECT DISTINCT user_id, 500 AS amount, 1 AS leverage FROM alpaca_creds').all();
  if (!users.length) return;

  const sig   = await computeORBSignal(5); // 5-min ORB window
  const today = sig.today;

  // Log what we see even when no trade is taken (for session log completeness)
  console.log(`[ORB-Bot] ${today} | Range: $${sig.orbHigh ?? '—'}/$${sig.orbLow ?? '—'} (${sig.rangeWidthPct ?? '—'}%) | Breakout: ${sig.breakout} | Season: ${orbSeason.monthly.label} | SizeMult: ${orbSeason.sizeMult}× | Filters: ${sig.confirmed ? 'ALL PASS' : (sig.failReasons?.join(', ') || 'pending')}`);

  if (!sig.confirmed) return;

  for (const user of users) {
    const creds = getAlpacaCreds(user.user_id);
    if (!creds) continue;
    if (!isBotEnabled(user.user_id, 'orb')) { console.log(`[ORB-Bot] Disabled for user ${user.user_id} — skipping`); continue; }

    // One trade per day per user
    const sessionRow = db.prepare(`SELECT * FROM orb_session_log WHERE user_id = ? AND trade_date = ?`).get(user.user_id, today);
    if (sessionRow?.trade_taken) {
      console.log(`[ORB-Bot] User ${user.user_id} already traded today — skipping`);
      continue;
    }

    if (!acquireBotLock(user.user_id)) {
      console.log(`[ORB-Bot] User ${user.user_id} locked by another bot — skipping`);
      continue;
    }
    try {
      if (!await checkPDTAllowed(user.user_id, 'ORB-Bot')) continue;

      // ── ORB PDT-caution guard: if ≥3 winning ORB trades in the last 5 ──────
      // calendar days, rest until that window rolls off to protect day-trade
      // count from creeping toward the PDT 3-trade limit.
      {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 5);
        const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,'0')}-${String(cutoff.getDate()).padStart(2,'0')}`;
        const { cnt: recentWins } = db.prepare(`
          SELECT COUNT(*) AS cnt FROM orb_session_log
          WHERE user_id=? AND trade_taken=1 AND result='WIN' AND trade_date >= ?
        `).get(user.user_id, cutoffStr);
        if (recentWins >= 3) {
          console.log(`[ORB-Bot] User ${user.user_id} has ${recentWins} ORB wins in last 5 days — resting to preserve PDT headroom`);
          continue;
        }
      }

      const slots = await getOpenSlots(user.user_id, 'ORB-Bot');
      if (!slots || slots.available <= 0) continue;
      const positions   = slots.positions;
      const heldSymbols = new Set(Array.isArray(positions) ? positions.map(p => p.symbol) : []);

      // ── Find candidate stock (cheapest with momentum or inverse) ──────────
      let candidate;
      if (sig.direction === 'BULLISH') {
        console.log(`[ORB-Bot] BULLISH breakout — scanning for cheapest momentum stock…`);
        candidate = await findCheapestBullishCandidate(heldSymbols);
      } else {
        console.log(`[ORB-Bot] BEARISH breakout — scanning for cheapest inverse ETF…`);
        candidate = await findCheapestBearishCandidate(heldSymbols);
      }

      if (!candidate) {
        console.log(`[ORB-Bot] No eligible candidate found (all held or above $${MAX_TRADE_PRICE}) — skipping`);
        upsertORBSessionLog(user.user_id, today, sig, { trade_taken: 0, notes: 'No eligible candidate found' });
        continue;
      }

      console.log(`[ORB-Bot] Candidate: ${candidate.symbol} @ $${candidate.price.toFixed(2)} (${candidate.change > 0 ? '+' : ''}${candidate.change.toFixed(2)}%)`);

      // ── Whale + Dark Pool gates on the candidate symbol ────────────────────
      const direction = sig.direction === 'BULLISH' ? 'LONG' : 'SHORT';
      const whaleGate = await checkWhaleGate(candidate.symbol, direction);
      if (!whaleGate.allowed) {
        console.log(`[ORB-Bot] Whale-Gate BLOCKED ${candidate.symbol}: ${whaleGate.reason}`);
        upsertORBSessionLog(user.user_id, today, sig, { trade_taken: 0, notes: `Whale-Gate blocked ${candidate.symbol}` });
        continue;
      }

      const dpGate = await checkDarkPoolGate(candidate.symbol, candidate.price, direction);
      if (!dpGate.allowed) {
        console.log(`[ORB-Bot] DP-Gate BLOCKED ${candidate.symbol}: ${dpGate.reason}`);
        upsertORBSessionLog(user.user_id, today, sig, { trade_taken: 0, notes: `DP-Gate blocked ${candidate.symbol}` });
        continue;
      }

      // ── Position sizing (with seasonal multiplier) ─────────────────────────
      const lev    = Math.min(4, Math.max(1, user.leverage || 1));
      const amount = (user.amount || 500) * lev * orbSeason.sizeMult;
      let   shares = Math.max(1, Math.floor(amount / candidate.price));

      // SL = tightened during OpEx/bearish season; TP = ceiling 18% (RSI 75 monitor exits first)
      const slDistPct = 0.05 / orbSeason.stopAdjust; // e.g., 5% normal → 4.35% during OpEx week
      const slPrice = (candidate.price * (1 - slDistPct)).toFixed(2);
      const tpPrice = (candidate.price * 1.18).toFixed(2);

      // Max loss cap: 1.5% of account equity
      try {
        const acct = await alpacaFetch(user.user_id, '/v2/account');
        const equity  = parseFloat(acct.equity || 0);
        const maxLoss = equity * 0.015;
        const riskPerShare = candidate.price * 0.05; // 5% SL distance
        if (riskPerShare > 0 && shares * riskPerShare > maxLoss) {
          shares = Math.max(1, Math.floor(maxLoss / riskPerShare));
          console.log(`[ORB-Bot] Capped to ${shares} shares (1.5% equity limit $${maxLoss.toFixed(0)})`);
        }
      } catch (_) {}

      const orderBody = {
        symbol:        candidate.symbol,
        qty:           String(shares),
        side:          'buy',
        type:          'market',
        time_in_force: 'day',
        order_class:   'bracket',
        take_profit:   { limit_price: tpPrice },
        stop_loss:     { stop_price:  slPrice },
      };

      try {
        const order   = await alpacaFetch(user.user_id, '/v2/orders', { method: 'POST', body: JSON.stringify(orderBody) });
        const orderId = order.id || null;

        db.prepare(`INSERT INTO auto_trade_log (user_id,symbol,side,shares,entry_price,tp_price,sl_price,alpaca_order_id,signal,strategy,status,created_at) VALUES (?,?,'buy',?,?,?,?,?,?,'orb','open',datetime('now'))`).run(
          user.user_id, candidate.symbol, shares, candidate.price, tpPrice, slPrice, orderId,
          `ORB ${sig.direction} · ${candidate.symbol} $${candidate.price.toFixed(2)} · SPY range $${sig.orbHigh}/$${sig.orbLow} · RSI-75 exit`
        );

        upsertORBSessionLog(user.user_id, today, sig, {
          trade_taken: 1, entry_price: candidate.price,
          stop_price: parseFloat(slPrice), target_price: parseFloat(tpPrice),
          trade_symbol: candidate.symbol, shares, alpaca_order_id: orderId,
          result: 'OPEN',
          notes: `${candidate.symbol} @ $${candidate.price.toFixed(2)} (${candidate.change > 0 ? '+' : ''}${candidate.change.toFixed(2)}%) · ORB ${sig.direction} · RSI-75 exit active`,
        });

        console.log(`[ORB-Bot] ✓ ORDER: BUY ${shares} ${candidate.symbol} @ ~$${candidate.price.toFixed(2)} | ORB ${sig.direction} · SL=${slPrice} · TP=${tpPrice} (RSI-75 dynamic exit active)`);
      } catch (e) {
        console.error(`[ORB-Bot] Order failed for ${candidate.symbol}:`, e.message);
        upsertORBSessionLog(user.user_id, today, sig, { trade_taken: 0, notes: `Order error: ${e.message}` });
      }
    } finally {
      releaseBotLock(user.user_id);
    }
  }
}

// ── Per-trade trailing state (in-memory; survives restarts via fresh peak detection) ──
// { peakPrice: number, partialDone: boolean }
const orbTrailingState = new Map();

// ── Full-exit helper ─────────────────────────────────────────────────────────
async function sellAllORBPosition(trade, rsi, today, reason) {
  await alpacaFetch(trade.user_id, `/v2/positions/${trade.symbol}`, { method: 'DELETE' });
  db.prepare(`UPDATE auto_trade_log SET status='closed', exit_reason=?, closed_at=datetime('now') WHERE id=?`)
    .run(reason, trade.id);
  db.prepare(`UPDATE orb_session_log SET result='WIN', notes=notes||' | '||? WHERE user_id=? AND trade_date=?`)
    .run(reason, trade.user_id, today);
  orbTrailingState.delete(trade.id);
  console.log(`[ORB-Bot] ✓ Full exit: ${trade.symbol} — ${reason}`);
}

// ── ORB Exit Monitor — runs every 2 min ──────────────────────────────────────
// Three-phase exit strategy:
//   Phase 1 — RSI > 65  : 1% trailing stop armed. Sells 100% if price ≤ 99% of peak.
//   Phase 2 — RSI ≥ 75  : Sell 85% of shares at market. Let 15% run.
//   Phase 3 — after partial: 1% trailing stop on remaining 15% until pullback.
async function monitorORBRSIExit() {
  if (!isMarketOpen()) return;
  const openTrades = db.prepare(`
    SELECT id, user_id, symbol, entry_price, shares FROM auto_trade_log
    WHERE strategy = 'orb' AND status = 'open'
  `).all();
  if (!openTrades.length) return;

  const et    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const today = `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;

  for (const trade of openTrades) {
    try {
      // ── Get RSI from daily bars ────────────────────────────────────────────
      const bars = await fetchOHLCV(trade.symbol, 30).catch(() => null);
      if (!bars || bars.length < 15) continue;
      let rsi = 50;
      try { rsi = calcRSI(bars.map(b => b.c), 14); } catch (_) {}

      // ── Get live position from Alpaca (current price + real qty) ──────────
      let position = null;
      try { position = await alpacaFetch(trade.user_id, `/v2/positions/${trade.symbol}`); } catch (_) {}
      if (!position) continue;

      const currentPrice = parseFloat(position.current_price ?? position.avg_entry_price ?? trade.entry_price);
      const currentQty   = parseInt(position.qty ?? 0);

      if (currentQty <= 0) {
        // Closed externally (bracket SL hit, manual close, etc.)
        db.prepare(`UPDATE auto_trade_log SET status='closed', exit_reason='closed_externally', closed_at=datetime('now') WHERE id=?`).run(trade.id);
        orbTrailingState.delete(trade.id);
        console.log(`[ORB-Bot] ${trade.symbol} position is gone externally — marking closed`);
        continue;
      }

      // ── Initialise or update trailing peak ────────────────────────────────
      if (!orbTrailingState.has(trade.id)) {
        orbTrailingState.set(trade.id, { peakPrice: currentPrice, partialDone: false });
      }
      const state = orbTrailingState.get(trade.id);
      if (currentPrice > state.peakPrice) state.peakPrice = currentPrice;

      const trailStop = +(state.peakPrice * 0.99).toFixed(4); // 1% below peak

      console.log(`[ORB-Bot] ${trade.symbol} RSI=${rsi.toFixed(1)} | price=$${currentPrice} | peak=$${state.peakPrice.toFixed(2)} | trail=$${trailStop.toFixed(2)} | qty=${currentQty} | partial=${state.partialDone}`);

      // ── PHASE 2: RSI ≥ 75 — sell 85%, let 15% run ────────────────────────
      if (rsi >= 75 && !state.partialDone) {
        const sellQty = Math.max(1, Math.floor(currentQty * 0.85));
        if (sellQty >= currentQty) {
          // Rounding left nothing — just close everything
          await sellAllORBPosition(trade, rsi, today, `RSI-75 full exit (RSI=${rsi.toFixed(1)})`);
          continue;
        }
        console.log(`[ORB-Bot] RSI ${rsi.toFixed(1)} ≥ 75 on ${trade.symbol} — selling ${sellQty}/${currentQty} shares (85% partial). Keeping ${currentQty - sellQty} shares with 1% trail @ $${trailStop.toFixed(2)}`);
        try {
          await alpacaFetch(trade.user_id, '/v2/orders', {
            method: 'POST',
            body: JSON.stringify({ symbol: trade.symbol, qty: String(sellQty), side: 'sell', type: 'market', time_in_force: 'day' }),
          });
          state.partialDone = true;
          db.prepare(`UPDATE orb_session_log SET notes=notes||? WHERE user_id=? AND trade_date=?`)
            .run(` | RSI-75 partial 85% sold @ $${currentPrice.toFixed(2)} RSI=${rsi.toFixed(1)}`, trade.user_id, today);
          console.log(`[ORB-Bot] ✓ Partial exit done: ${sellQty} ${trade.symbol} sold. ${currentQty - sellQty} shares running with 1% trailing stop.`);
        } catch (e) {
          console.error(`[ORB-Bot] Partial exit failed for ${trade.symbol}:`, e.message);
        }
        continue;
      }

      // ── PHASE 1 + 3: RSI > 65 → trailing stop active ─────────────────────
      // (Phase 1 = before partial, Phase 3 = after partial — same 1% trail logic)
      if (rsi > 65) {
        if (currentPrice <= trailStop) {
          const phaseLabel = state.partialDone
            ? `1% trail on final 15% (RSI=${rsi.toFixed(1)}, peak=$${state.peakPrice.toFixed(2)})`
            : `1% trailing stop (RSI=${rsi.toFixed(1)}, peak=$${state.peakPrice.toFixed(2)})`;
          console.log(`[ORB-Bot] Trail stop hit on ${trade.symbol}: $${currentPrice} ≤ $${trailStop.toFixed(2)} — selling all remaining ${currentQty} shares`);
          try {
            await sellAllORBPosition(trade, rsi, today, phaseLabel);
          } catch (e) {
            console.error(`[ORB-Bot] Trail stop exit failed for ${trade.symbol}:`, e.message);
          }
        }
        // else: still climbing — hold and wait for next 2-min check
      }

    } catch (e) {
      console.error(`[ORB-Bot] Monitor error for trade ${trade.id}:`, e.message);
    }
  }
}

// Helper: upsert the ORB session log row for today
function upsertORBSessionLog(userId, tradeDate, sig, overrides = {}) {
  const base = {
    user_id:            userId,
    trade_date:         tradeDate,
    orb_type:           '5min',
    orb_high:           sig.orbHigh   ?? null,
    orb_low:            sig.orbLow    ?? null,
    range_width_pct:    sig.rangeWidthPct ?? null,
    valid_range:        sig.validRange ? 1 : 0,
    breakout_direction: sig.breakout  ?? 'NONE',
    breakout_price:     sig.price     ?? null,
    volume_confirmed:   sig.hasVolume ? 1 : 0,
    vwap_aligned:       sig.vwapAligned ? 1 : 0,
    rsi_ok:             sig.rsiOk     ? 1 : 0,
    vix_ok:             sig.vixOk     ? 1 : 0,
    mwf_ok:             sig.isMWF     ? 1 : 0,
    all_filters_passed: sig.confirmed  ? 1 : 0,
    trade_taken:        0,
    result:             'OPEN',
    notes:              sig.failReasons?.join(', ') || null,
  };
  const row = { ...base, ...overrides };
  db.prepare(`
    INSERT INTO orb_session_log
      (user_id, trade_date, orb_type, orb_high, orb_low, range_width_pct, valid_range,
       breakout_direction, breakout_price, volume_confirmed, vwap_aligned, rsi_ok, vix_ok,
       mwf_ok, all_filters_passed, trade_taken, entry_price, stop_price, target_price,
       trade_symbol, shares, alpaca_order_id, result, notes)
    VALUES
      (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, trade_date) DO UPDATE SET
      orb_high=excluded.orb_high, orb_low=excluded.orb_low,
      range_width_pct=excluded.range_width_pct, valid_range=excluded.valid_range,
      breakout_direction=excluded.breakout_direction, breakout_price=excluded.breakout_price,
      volume_confirmed=excluded.volume_confirmed, vwap_aligned=excluded.vwap_aligned,
      rsi_ok=excluded.rsi_ok, vix_ok=excluded.vix_ok, mwf_ok=excluded.mwf_ok,
      all_filters_passed=excluded.all_filters_passed,
      trade_taken=CASE WHEN excluded.trade_taken=1 THEN 1 ELSE orb_session_log.trade_taken END,
      entry_price=COALESCE(excluded.entry_price, orb_session_log.entry_price),
      stop_price=COALESCE(excluded.stop_price, orb_session_log.stop_price),
      target_price=COALESCE(excluded.target_price, orb_session_log.target_price),
      trade_symbol=COALESCE(excluded.trade_symbol, orb_session_log.trade_symbol),
      shares=COALESCE(excluded.shares, orb_session_log.shares),
      alpaca_order_id=COALESCE(excluded.alpaca_order_id, orb_session_log.alpaca_order_id),
      result=COALESCE(excluded.result, orb_session_log.result),
      notes=COALESCE(excluded.notes, orb_session_log.notes)
  `).run(
    row.user_id, row.trade_date, row.orb_type, row.orb_high, row.orb_low,
    row.range_width_pct, row.valid_range, row.breakout_direction, row.breakout_price,
    row.volume_confirmed, row.vwap_aligned, row.rsi_ok, row.vix_ok, row.mwf_ok,
    row.all_filters_passed, row.trade_taken, row.entry_price ?? null,
    row.stop_price ?? null, row.target_price ?? null, row.trade_symbol ?? null,
    row.shares ?? null, row.alpaca_order_id ?? null, row.result, row.notes
  );
}

// ── GET /api/orb-log — recent ORB session log (last 20 sessions) ──────────────
app.get('/api/orb-log', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT trade_date, orb_type, orb_high, orb_low, range_width_pct, valid_range,
             breakout_direction, volume_confirmed, vwap_aligned, rsi_ok, vix_ok, mwf_ok,
             all_filters_passed, trade_taken, entry_price, stop_price, target_price,
             trade_symbol, shares, result, notes, created_at
      FROM orb_session_log
      WHERE user_id = ?
      ORDER BY trade_date DESC
      LIMIT 20
    `).all(req.session.userId);
    res.json({ sessions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/orb-signal — live ORB signal state for the dashboard ─────────────
app.get('/api/orb-signal', requireAuth, async (req, res) => {
  try {
    _orbSignalTs = 0; // force fresh computation
    const sig = await computeORBSignal(5);
    res.json(sig);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ORB scans every 2 minutes — tight enough to catch breakouts shortly after they form
setInterval(runORBAutoTrader,   2 * 60 * 1000);
// RSI-75 exit monitor runs every 2 minutes throughout the session
setInterval(monitorORBRSIExit, 2 * 60 * 1000);
console.log('[ORB-Bot] Opening Range Breakout auto-trader initialized — scans every 2 min (active after 9:36 ET, Mon–Fri) · RSI-75 exit monitor active · PDT-aware');

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Johnny Qureshi Finance on :${PORT}`);
  // Pre-load SPY levels immediately at startup so data is ready before market open
  getSPYLevels().then(lvl => {
    if (lvl) console.log(`[SPY-Gate] Pre-loaded at startup — FLOOR $${lvl.floor}  MAX PAIN $${lvl.maxPain}  ROOF $${lvl.roof}  (${lvl.expiry})`);
    else     console.warn('[SPY-Gate] Startup pre-load returned no data — will retry on first request');
  });
  // Refresh SPY levels every 30 min so they stay current through the trading day
  setInterval(() => getSPYLevels(), 30 * 60 * 1000);
});
