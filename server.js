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

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// Suppress noisy yahoo-finance2 deprecation warnings for modules we use intentionally
const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  const msg = args[0]?.toString() || '';
  if (msg.includes('financial statements submodules') || msg.includes('fundamentalsTimeSeries')) return;
  _origWarn(...args);
};

const app      = express();
const PORT     = 5000;
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

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);  // Trust Replit's reverse proxy for correct cookie behaviour
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(session({
  store:             new SQLiteStore({ db: 'sessions.db', dir: '.' }),
  secret:            process.env.SESSION_SECRET || 'jqf-dev-secret-change-me',
  resave:            false,
  saveUninitialized: false,
  rolling:           true,   // Reset cookie expiry on every request (keeps active users logged in)
  cookie: {
    httpOnly: true,
    secure:   false,          // Works over both HTTP and HTTPS
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
app.post('/api/auth/register', async (req, res) => {
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
app.post('/api/auth/login', async (req, res) => {
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
  if (!sym) return res.status(400).json({ error: 'Symbol required.' });
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

// Recent orders
app.get('/api/alpaca/orders', requireAuth, async (req, res) => {
  try { res.json(await alpacaFetch(req.session.userId, '/v2/orders?limit=20&status=all')); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
  try { await alpacaFetch(req.session.userId, `/v2/orders/${req.params.id}`, { method: 'DELETE' }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Close position (market sell)
app.delete('/api/alpaca/position/:sym', requireAuth, async (req, res) => {
  try { res.json(await alpacaFetch(req.session.userId, `/v2/positions/${req.params.sym}`, { method: 'DELETE' })); }
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

async function computeBounceSignal(symbol) {
  const bars = await fetchOHLCV(symbol, 120);
  if (!bars || bars.length < 60) return { symbol, error: 'Insufficient data', confirmed: false };

  const closes = bars.map(b => b.c);
  const cur    = bars.at(-1);
  const prev   = bars.at(-2);

  const ema8  = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema34 = calcEMA(closes, 34);
  const sma50 = calcSMA(closes, 50);
  const stoch = calcStochastic(bars, 8, 3, 3);

  if (!ema8 || !ema21 || !ema34 || !sma50 || !stoch) {
    return { symbol, error: 'Indicator error', confirmed: false };
  }

  const price   = cur.c;
  const prevHigh = prev.h;
  const { pctK, pctD } = stoch;

  // ── 4 Conditions ────────────────────────────────────────────────────────────
  const cond1 = ema8 > ema21 && ema21 > ema34 && ema34 > sma50;  // uptrend stack
  const cond2 = price <= ema8 && price >= sma50;                  // in pullback zone
  const cond3 = pctK < 40;                                        // stoch oversold
  const cond4 = price > prevHigh;                                  // close above prev bar high

  const confirmed = cond1 && cond2 && cond3 && cond4;

  // ── TP / SL ──────────────────────────────────────────────────────────────────
  const swingHigh   = findSwingHigh(bars, 30);
  const pullbackLow = findPullbackLow(bars, 10);
  const tpLevel = swingHigh ?? price * 1.05;
  const slLevel = Math.max(pullbackLow ?? 0, sma50 - (sma50 * 0.001)); // closer of pullback low or just below SMA50

  const riskDist   = price - slLevel;
  const rewardDist = tpLevel - price;
  const rr = riskDist > 0 ? rewardDist / riskDist : 0;

  return {
    symbol,
    price:    +price.toFixed(4),
    ema8:     +ema8.toFixed(4),
    ema21:    +ema21.toFixed(4),
    ema34:    +ema34.toFixed(4),
    sma50:    +sma50.toFixed(4),
    stochK:   +pctK.toFixed(2),
    stochD:   +pctD.toFixed(2),
    prevHigh: +prevHigh.toFixed(4),
    cond1,
    cond2,
    cond3,
    cond4,
    confirmed,
    tpLevel:  +tpLevel.toFixed(4),
    slLevel:  +slLevel.toFixed(4),
    rr:       +rr.toFixed(2),
    date:     cur.t,
    error:    null,
  };
}

// ── Bounce 2.0 Scanner Universe ───────────────────────────────────────────────
const BOUNCE_UNIVERSE = [
  // Mega-cap
  'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','PLTR','COIN',
  // High-beta growth
  'HOOD','SOFI','MARA','RIOT','CLSK','CORZ','HUT','BITF','IREN',
  // Leveraged ETFs (momentum vehicles)
  'TQQQ','SOXL','SPXL','TECL','LABU','UPRO','TNA','FAS',
  // Major index ETFs
  'SPY','QQQ','IWM','DIA','SMH','ARKK',
  // Consumer tech
  'NFLX','UBER','SHOP','SQ','PYPL','SNAP','PINS','RBLX','DKNG',
  // Auto/EV
  'F','GM','RIVN','NIO','LI',
  // Semis
  'TSM','AVGO','QCOM','MU','INTC','AMAT','LRCX','KLAC','ARM','SMCI',
  // Financials
  'JPM','BAC','GS','MS','C','WFC','SCHW',
  // Energy
  'XOM','CVX','COP','SLB','HAL',
  // Commodities/Metals
  'GLD','SLV','GDX','GDXJ','USO',
  // Cloud/Cyber
  'CRWD','S','PANW','SNOW','DDOG','TWLO','MDB','ZS','NET',
  // Biotech/Pharma
  'MRNA','BNTX','PFE','ABBV','LLY','REGN',
];

// GET /api/bounce-signal/:symbol
app.get('/api/bounce-signal/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    const signal = await computeBounceSignal(sym);
    res.json(signal);
  } catch (e) {
    res.status(500).json({ symbol: sym, error: e.message, confirmed: false });
  }
});

// GET /api/bounce-scan?symbols=AAPL,TSLA,... (omit for full universe)
const _bounceCache = new Map(); // sym -> { data, ts }
const BOUNCE_TTL   = 5 * 60 * 1000; // 5 min cache per symbol

app.get('/api/bounce-scan', async (req, res) => {
  let syms = req.query.symbols
    ? req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : BOUNCE_UNIVERSE;
  syms = [...new Set(syms)].slice(0, 80);

  const now = Date.now();
  const BATCH = 8;
  const results = [];

  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      const cached = _bounceCache.get(sym);
      if (cached && now - cached.ts < BOUNCE_TTL) return cached.data;
      const sig = await computeBounceSignal(sym);
      _bounceCache.set(sym, { data: sig, ts: now });
      return sig;
    }));
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ symbol: batch[idx], error: r.reason?.message || 'Failed', confirmed: false });
    });
  }

  results.sort((a, b) => {
    if (a.confirmed && !b.confirmed) return -1;
    if (!a.confirmed && b.confirmed) return 1;
    return (b.rr || 0) - (a.rr || 0);
  });

  res.json({
    ok: true,
    total: results.length,
    confirmed: results.filter(r => r.confirmed).length,
    results,
    scannedAt: new Date().toISOString(),
  });
});


// ── GET/PUT /api/bounce/auto-settings ─────────────────────────────────────────
app.get('/api/bounce/auto-settings', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM auto_trade_settings WHERE user_id = ?').get(req.session.userId);
  res.json(row ? { enabled: row.enabled, amount: row.investment_amount, leverage: row.leverage } : { enabled: 0, amount: 500, leverage: 1 });
});

app.put('/api/bounce/auto-settings', requireAuth, (req, res) => {
  const { enabled, amount, leverage } = req.body;
  db.prepare(`
    INSERT INTO auto_trade_settings (user_id, enabled, investment_amount, leverage)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, investment_amount=excluded.investment_amount, leverage=excluded.leverage
  `).run(req.session.userId, enabled ? 1 : 0, amount || 500, leverage || 1);
  res.json({ ok: true });
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

// ── Volatility Expansion Signal Computation ───────────────────────────────────
async function computeVESignal(symbol) {
  const bars = await fetchOHLCV(symbol, 150);
  if (!bars || bars.length < 60) return { symbol, error: 'Insufficient data', direction: null, confirmed: false };

  const closes  = bars.map(b => b.c);
  const volumes = bars.map(b => b.v || 0);
  const cur     = bars.at(-1);

  // ── ATR series and 20-period ATR average ──────────────────────────────────
  const atrSeries = calcATRSeries(bars, 14);
  const curATR    = atrSeries.at(-1);
  if (!curATR) return { symbol, error: 'ATR error', direction: null, confirmed: false };

  const recentATRs = atrSeries.slice(-20).filter(v => v !== null);
  const atrAvg20   = recentATRs.reduce((a, b) => a + b, 0) / recentATRs.length;

  // ── Count consecutive recent bars where ATR < avg (contraction) ───────────
  let contractionBars = 0;
  for (let i = atrSeries.length - 1; i >= 0; i--) {
    if (atrSeries[i] !== null && atrSeries[i] < atrAvg20) contractionBars++;
    else break;
  }
  const hasContraction = contractionBars >= 5;

  // ── Bollinger Band width — current and lookback ───────────────────────────
  const bbCur  = calcBBWidth(closes, 20, 2);
  if (!bbCur)  return { symbol, error: 'BB error', direction: null, confirmed: false };

  const bbWidths   = calcBBWidthSeries(closes, 20, 2, 21);
  const minWidth20 = Math.min(...bbWidths);
  const isSqueezed = bbCur.width <= minWidth20 * 1.15;  // within 15% of the 20-bar minimum

  // ── Consolidation range (highest high / lowest low during contraction) ────
  const contractionWindow = Math.max(contractionBars, 5);
  const rangeBars  = bars.slice(-contractionWindow);
  const rangeHigh  = Math.max(...rangeBars.map(b => b.h));
  const rangeLow   = Math.min(...rangeBars.map(b => b.l));
  const rangeMid   = (rangeHigh + rangeLow) / 2;

  // ── Volume surge ──────────────────────────────────────────────────────────
  const avgVol20   = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const curVol     = cur.v || 0;
  const volRatio   = avgVol20 > 0 ? curVol / avgVol20 : 0;
  const hasVolSurge = volRatio >= 1.5;

  // ── Entry triggers ────────────────────────────────────────────────────────
  const price      = cur.c;
  const longTrig   = price > rangeHigh && hasVolSurge;
  const shortTrig  = price < rangeLow  && hasVolSurge;
  const confirmed  = (longTrig || shortTrig) && hasContraction && isSqueezed;
  const direction  = confirmed ? (longTrig ? 'LONG' : 'SHORT') : null;

  // ── Stop loss ─────────────────────────────────────────────────────────────
  const slLong  = rangeMid;
  const slShort = rangeMid;
  const sl      = direction === 'LONG' ? slLong : direction === 'SHORT' ? slShort : rangeMid;

  // Risk/Reward — TP is previous structure high (Long) / low (Short)
  const swingTP = direction === 'LONG'
    ? Math.max(...bars.slice(-40, -contractionWindow).map(b => b.h) || [price * 1.06])
    : Math.min(...bars.slice(-40, -contractionWindow).map(b => b.l) || [price * 0.94]);
  const tpLevel = swingTP || (direction === 'LONG' ? price * 1.06 : price * 0.94);

  const riskDist   = direction === 'LONG'  ? price - sl : sl - price;
  const rewardDist = direction === 'LONG'  ? tpLevel - price : price - tpLevel;
  const rr         = riskDist > 0 ? +(rewardDist / riskDist).toFixed(2) : 0;

  return {
    symbol,
    price:           +price.toFixed(4),
    atr:             +curATR.toFixed(4),
    atrAvg20:        +atrAvg20.toFixed(4),
    atrRatio:        +(curATR / atrAvg20).toFixed(3),
    contractionBars,
    hasContraction,
    bbWidth:         +bbCur.width.toFixed(3),
    bbSMA:           +bbCur.sma.toFixed(4),
    bbUpper:         +bbCur.upper.toFixed(4),
    bbLower:         +bbCur.lower.toFixed(4),
    bbMinWidth20:    +minWidth20.toFixed(3),
    isSqueezed,
    rangeHigh:       +rangeHigh.toFixed(4),
    rangeLow:        +rangeLow.toFixed(4),
    rangeMid:        +rangeMid.toFixed(4),
    volRatio:        +volRatio.toFixed(2),
    hasVolSurge,
    direction,
    confirmed,
    signal:          confirmed ? `VOLATILITY EXPANSION CONFIRMED — ${direction}` : null,
    slLevel:         +sl.toFixed(4),
    tpLevel:         +tpLevel.toFixed(4),
    rr,
    date:            cur.t,
    error:           null,
  };
}

// ── VE Universe (same broad universe as Bounce 2.0) ───────────────────────────
const VE_UNIVERSE = [
  'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','PLTR','COIN',
  'HOOD','SOFI','MARA','RIOT','CLSK','CORZ',
  'TQQQ','SOXL','SPXL','TECL','LABU','UPRO','TNA','FAS',
  'SPY','QQQ','IWM','DIA','SMH','ARKK',
  'NFLX','UBER','SHOP','SQ','PYPL','SNAP','PINS','RBLX','DKNG',
  'F','GM','RIVN','NIO','LI',
  'TSM','AVGO','QCOM','MU','INTC','AMAT','LRCX','KLAC','ARM','SMCI',
  'JPM','BAC','GS','MS','C','WFC','SCHW',
  'XOM','CVX','COP','SLB','HAL',
  'GLD','SLV','GDX','GDXJ','USO',
  'CRWD','PANW','SNOW','DDOG','NET','ZS','MDB',
  'MRNA','PFE','ABBV','LLY','REGN',
];

// ── VE signal cache ────────────────────────────────────────────────────────────
const _veCache = new Map();
const VE_TTL   = 5 * 60 * 1000;

// ── GET /api/ve/signal/:symbol ────────────────────────────────────────────────
app.get('/api/ve/signal/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    const sig = await computeVESignal(sym);
    res.json(sig);
  } catch (e) {
    res.status(500).json({ symbol: sym, error: e.message, confirmed: false });
  }
});

// ── GET /api/ve/scan?symbols=... ──────────────────────────────────────────────
app.get('/api/ve/scan', async (req, res) => {
  let syms = req.query.symbols
    ? req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : VE_UNIVERSE;
  syms = [...new Set(syms)].slice(0, 80);

  const now   = Date.now();
  const BATCH = 6;
  const results = [];

  for (let i = 0; i < syms.length; i += BATCH) {
    const batch   = syms.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      const cached = _veCache.get(sym);
      if (cached && now - cached.ts < VE_TTL) return cached.data;
      const sig = await computeVESignal(sym);
      _veCache.set(sym, { data: sig, ts: now });
      return sig;
    }));
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ symbol: batch[idx], error: r.reason?.message || 'Failed', confirmed: false });
    });
  }

  results.sort((a, b) => {
    if (a.confirmed && !b.confirmed) return -1;
    if (!a.confirmed && b.confirmed) return 1;
    const aScore = (a.hasContraction ? 1 : 0) + (a.isSqueezed ? 1 : 0) + (a.hasVolSurge ? 1 : 0);
    const bScore = (b.hasContraction ? 1 : 0) + (b.isSqueezed ? 1 : 0) + (b.hasVolSurge ? 1 : 0);
    return bScore - aScore;
  });

  res.json({
    ok: true,
    total: results.length,
    confirmed: results.filter(r => r.confirmed).length,
    results,
    scannedAt: new Date().toISOString(),
  });
});

// ── GET /api/ve/auto-settings ─────────────────────────────────────────────────
app.get('/api/ve/auto-settings', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM ve_auto_settings WHERE user_id = ?').get(req.session.userId);
  res.json(row || { enabled: 0, amount: 1000, leverage: 1 });
});

// ── PUT /api/ve/auto-settings ─────────────────────────────────────────────────
app.put('/api/ve/auto-settings', requireAuth, (req, res) => {
  const { enabled, amount, leverage } = req.body || {};
  db.prepare(`
    INSERT INTO ve_auto_settings (user_id, enabled, amount, leverage)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, amount = excluded.amount, leverage = excluded.leverage
  `).run(req.session.userId, enabled ? 1 : 0, +amount || 1000, +leverage || 1);
  res.json({ ok: true });
});

// ── Server-side VE Auto-Trader ────────────────────────────────────────────────
// Runs every 5 minutes during regular US market hours (9:35 AM – 3:50 PM ET Mon-Fri)
function isMarketOpen() {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 575 && mins < 950; // 9:35–3:50 ET
}

// ── Server-side Bounce 2.0 Auto-Trader (runs after isMarketOpen is defined) ────
async function runBounceAutoTrader() {
  if (!isMarketOpen()) return;
  const users = db.prepare('SELECT user_id, investment_amount AS amount, leverage FROM auto_trade_settings WHERE enabled = 1').all();
  if (!users.length) return;
  console.log(`[Bounce-Bot] Auto-scan for ${users.length} user(s)`);
  const now = Date.now();
  const signals = [];
  for (let i = 0; i < BOUNCE_UNIVERSE.length; i += 8) {
    const batch = BOUNCE_UNIVERSE.slice(i, i + 8);
    const settled = await Promise.allSettled(batch.map(async sym => {
      const cached = _bounceCache.get(sym);
      if (cached && now - cached.ts < BOUNCE_TTL) return cached.data;
      const sig = await computeBounceSignal(sym);
      _bounceCache.set(sym, { data: sig, ts: now });
      return sig;
    }));
    settled.forEach(r => { if (r.status === 'fulfilled' && r.value?.confirmed) signals.push(r.value); });
  }
  if (!signals.length) { console.log('[Bounce-Bot] No confirmed signals.'); return; }
  console.log(`[Bounce-Bot] ${signals.length} confirmed: ${signals.map(s => s.symbol).join(', ')}`);
  for (const user of users) {
    const creds = getAlpacaCreds(user.user_id);
    if (!creds) continue;
    for (const sig of signals) {
      let positions = [];
      try { positions = await alpacaFetch(user.user_id, '/v2/positions'); } catch { continue; }
      if (Array.isArray(positions) && positions.some(p => p.symbol === sig.symbol)) continue;
      const recent = db.prepare(`SELECT id FROM auto_trade_log WHERE user_id=? AND symbol=? AND strategy='bounce' AND created_at >= datetime('now','-30 minutes')`).get(user.user_id, sig.symbol);
      if (recent) continue;
      const lev = Math.min(4, Math.max(1, user.leverage || 1));
      const amount = (user.amount || 500) * lev;
      const price = sig.price;
      const shares = Math.max(1, Math.floor(amount / price));
      const slPrice = (price * 0.985).toFixed(2);
      const tpPrice = sig.tp ? sig.tp.toFixed(2) : (price * 1.045).toFixed(2);
      const orderBody = { symbol: sig.symbol, qty: String(shares), side: 'buy', type: 'market', time_in_force: 'day', order_class: 'bracket', take_profit: { limit_price: tpPrice }, stop_loss: { stop_price: slPrice } };
      try {
        const order = await alpacaFetch(user.user_id, '/v2/orders', { method: 'POST', body: JSON.stringify(orderBody) });
        db.prepare(`INSERT INTO auto_trade_log (user_id,symbol,side,shares,entry_price,tp_price,sl_price,alpaca_order_id,signal,strategy,status,created_at) VALUES (?,?,'buy',?,?,?,?,?,?,'bounce','open',datetime('now'))`).run(user.user_id, sig.symbol, shares, price, tpPrice, slPrice, order.id || null, sig.signal || 'confirmed');
        console.log(`[Bounce-Bot] ORDER: BUY ${shares} ${sig.symbol} @ ~$${price}`);
      } catch (e) { console.error(`[Bounce-Bot] Order failed ${sig.symbol}:`, e.message); }
    }
  }
}
setInterval(runBounceAutoTrader, 5 * 60 * 1000);
console.log('[Bounce-Bot] Bounce 2.0 auto-trader initialized — scans every 5 min during market hours');

async function runVEAutoTrader() {
  if (!isMarketOpen()) return;

  const users = db.prepare('SELECT user_id, amount, leverage FROM ve_auto_settings WHERE enabled = 1').all();
  if (!users.length) return;

  console.log(`[VE-Bot] Auto-scan triggered for ${users.length} user(s)`);

  // Scan universe with a focused batch
  const now = Date.now();
  const universe = VE_UNIVERSE.slice(0, 40); // top 40 most liquid symbols
  const BATCH = 6;
  const signals = [];

  for (let i = 0; i < universe.length; i += BATCH) {
    const batch   = universe.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      const cached = _veCache.get(sym);
      if (cached && now - cached.ts < VE_TTL) return cached.data;
      const sig = await computeVESignal(sym);
      _veCache.set(sym, { data: sig, ts: Date.now() });
      return sig;
    }));
    settled.forEach(r => { if (r.status === 'fulfilled' && r.value.confirmed) signals.push(r.value); });
  }

  if (!signals.length) { console.log('[VE-Bot] No confirmed signals.'); return; }
  console.log(`[VE-Bot] ${signals.length} confirmed signal(s): ${signals.map(s => s.symbol + ' ' + s.direction).join(', ')}`);

  for (const user of users) {
    const creds = getAlpacaCreds(user.user_id);
    if (!creds) continue;

    for (const sig of signals) {
      // Check for existing position to avoid duplicates
      let positions = [];
      try {
        positions = await alpacaFetch(user.user_id, '/v2/positions');
      } catch { continue; }

      const alreadyIn = Array.isArray(positions) && positions.some(p => p.symbol === sig.symbol);
      if (alreadyIn) { console.log(`[VE-Bot] Already in ${sig.symbol} — skipping`); continue; }

      // Check for recent trade in this symbol (30-min cooldown)
      const recentTrade = db.prepare(`
        SELECT id FROM auto_trade_log
        WHERE user_id = ? AND symbol = ? AND strategy = 'volatility_expansion'
        AND created_at >= datetime('now', '-30 minutes')
      `).get(user.user_id, sig.symbol);
      if (recentTrade) { console.log(`[VE-Bot] Cooldown active for ${sig.symbol}`); continue; }

      const side   = sig.direction === 'LONG' ? 'buy' : 'sell';
      const lev    = Math.min(4, Math.max(1, user.leverage || 1));
      const amount = (user.amount || 1000) * lev;

      let price = sig.price;
      const tpPct = sig.tpLevel && price ? Math.abs((sig.tpLevel - price) / price * 100) : 0;
      const slPct = 1.5; // fixed 1.5% SL per strategy rules

      const shares = Math.max(1, Math.floor(amount / price));
      const orderBody = {
        symbol:         sig.symbol,
        qty:            String(shares),
        side,
        type:           'market',
        time_in_force:  'day',
        order_class:    'bracket',
      };
      if (tpPct > 0.2) {
        const tpPrice = side === 'buy'
          ? (price * (1 + tpPct / 100)).toFixed(2)
          : (price * (1 - tpPct / 100)).toFixed(2);
        orderBody.take_profit = { limit_price: tpPrice };
      }
      if (slPct > 0) {
        const slPrice = side === 'buy'
          ? (price * (1 - slPct / 100)).toFixed(2)
          : (price * (1 + slPct / 100)).toFixed(2);
        orderBody.stop_loss = { stop_price: slPrice };
      }

      try {
        const order = await alpacaFetch(user.user_id, '/v2/orders', {
          method: 'POST',
          body:   JSON.stringify(orderBody),
        });

        db.prepare(`
          INSERT INTO auto_trade_log
            (user_id, symbol, side, shares, entry_price, tp_price, sl_price, alpaca_order_id, signal, strategy, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'volatility_expansion', 'open', datetime('now'))
        `).run(user.user_id, sig.symbol, side, shares, price,
              orderBody.take_profit?.limit_price || null,
              orderBody.stop_loss?.stop_price    || null,
              order.id || null,
              sig.signal || sig.direction);

        console.log(`[VE-Bot] ORDER PLACED: ${side.toUpperCase()} ${shares} ${sig.symbol} @ ~$${price} for user ${user.user_id}`);
      } catch (e) {
        console.error(`[VE-Bot] Order failed for ${sig.symbol}:`, e.message);
      }
    }
  }
}

// ── GET /api/ve/trade-log ─────────────────────────────────────────────────────
app.get('/api/ve/trade-log', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM auto_trade_log
    WHERE user_id = ? AND strategy = 'volatility_expansion'
    ORDER BY created_at DESC LIMIT 50
  `).all(req.session.userId);
  res.json(rows);
});

// ── Start VE auto-trader interval ─────────────────────────────────────────────
setInterval(runVEAutoTrader, 5 * 60 * 1000); // every 5 minutes
console.log('[VE-Bot] Auto-trader engine initialized — scans every 5 min during market hours');


// ══════════════════════════════════════════════════════════════════════════════
// EXPLOSIVE EARNINGS SETUP — Strategy 3
// ══════════════════════════════════════════════════════════════════════════════

// ── EE auto-trade settings table ──────────────────────────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS ee_auto_settings (
    user_id  INTEGER PRIMARY KEY,
    enabled  INTEGER DEFAULT 0,
    amount   REAL    DEFAULT 1000.0,
    leverage INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

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
async function computeEESignal(symbol) {
  const base = {
    symbol, confirmed: false, signalType: null, earningsDate: null,
    hasRecentEarnings: false, dataSource: 'yahoo',
    epsSurprisePct: null, revenueGrowthPct: null, analystTarget: null,
    shortFloat: null, shortSqueezePotential: false,
    passEPS: false, passRevenue: false,
    gapPct: null, volRatio: null, resistance: null,
    resistanceBroken: false, passGap: false, passVolume: false, passResistance: false,
    price: null, ema10: null, ema10Distance: null, nearEMA10: false, stopLoss: null,
  };

  // 1. Fetch Yahoo Finance fundamentals + price bars in parallel;
  //    also try FMP as a premium supplement (fails gracefully if key invalid)
  const [yfData, fmpSurprises, fmpIncome, fmpTarget, fmpShortFloat, bars] = await Promise.all([
    fetchYahooEarningsFundamentals(symbol),
    fmpGet(`/v3/earnings-surprises/${symbol}`).catch(() => null),
    fmpGet(`/v3/income-statement/${symbol}?period=quarter&limit=5`).catch(() => null),
    fmpGet(`/v3/price-target-consensus?symbol=${symbol}`).catch(() => null),
    fmpGet(`/v4/short-float?symbol=${symbol}`).catch(() => null),
    fetchOHLCV(symbol, 150),
  ]);

  if (!bars || bars.length < 30) return { ...base, error: 'Insufficient price data' };
  base.price = bars.at(-1).c;

  // ── 2. Resolve earnings date ───────────────────────────────────────────────
  // Prefer FMP (gives exact announcement date), fall back to Yahoo quarterly end + heuristic
  let earningsDate = null;
  let epsSurprisePct = null;

  const fmpEps = Array.isArray(fmpSurprises) ? fmpSurprises[0] : null;
  if (fmpEps?.date) {
    // FMP has exact announcement date
    earningsDate = fmpEps.date;
    base.dataSource = 'fmp';
    if (fmpEps.actualEarningResult != null && fmpEps.estimatedEarning != null && fmpEps.estimatedEarning !== 0) {
      epsSurprisePct = ((fmpEps.actualEarningResult - fmpEps.estimatedEarning) / Math.abs(fmpEps.estimatedEarning)) * 100;
    }
  } else {
    // Use Yahoo Finance earningsHistory — quarter field = fiscal quarter END date
    const yfHist = yfData?.earningsHistory?.history;
    const lastQ  = yfHist?.length ? yfHist[yfHist.length - 1] : null;
    if (!lastQ) return { ...base, error: 'No earnings history available' };

    const fiscalQEnd = lastQ.quarter instanceof Date
      ? lastQ.quarter.toISOString().slice(0, 10)
      : String(lastQ.quarter).slice(0, 10);

    epsSurprisePct = lastQ.surprisePercent != null ? lastQ.surprisePercent * 100 : null;

    // Detect actual announcement bar from volume spike
    const detectedIdx = detectEarningsBarIdx(bars, fiscalQEnd);
    if (detectedIdx > 0) {
      earningsDate = bars[detectedIdx].t;
    } else {
      // Estimate: fiscal quarter end + ~30 days (typical announcement lag)
      const estMs = new Date(fiscalQEnd).getTime() + 30 * 86400000;
      const estDate = new Date(estMs).toISOString().slice(0, 10);
      // Find closest bar
      const closeIdx = bars.findIndex(b => b.t >= estDate);
      if (closeIdx > 0) earningsDate = bars[closeIdx].t;
    }
  }

  if (!earningsDate) return { ...base, error: 'Could not determine earnings date' };

  const ageDays = (Date.now() - new Date(earningsDate).getTime()) / 86400000;
  if (ageDays > 90) return { ...base, error: `Last earnings ~${Math.round(ageDays)}d ago — outside 90-day window` };

  base.hasRecentEarnings = true;
  base.earningsDate = earningsDate;

  // ── 3. EPS Surprise % ─────────────────────────────────────────────────────
  // Prefer FMP if available (more accurate), else Yahoo surprise %
  if (epsSurprisePct != null) {
    base.epsSurprisePct = epsSurprisePct;
    base.passEPS        = base.epsSurprisePct >= 15;
  }

  // ── 4. Revenue Growth YoY ─────────────────────────────────────────────────
  // FMP quarterly income (preferred) → Yahoo annual income (fallback)
  if (Array.isArray(fmpIncome) && fmpIncome.length >= 2) {
    const curQ  = fmpIncome[0];
    const cmpQ  = fmpIncome.length >= 5 ? fmpIncome[4] : fmpIncome[1];
    if (curQ?.revenue && cmpQ?.revenue > 0) {
      base.revenueGrowthPct = ((curQ.revenue - cmpQ.revenue) / cmpQ.revenue) * 100;
      base.passRevenue      = base.revenueGrowthPct >= 25;
    }
  } else {
    // Yahoo annual income — YoY comparison (most recent 2 years)
    const annualStmts = yfData?.incomeStatementHistory?.incomeStatementHistory;
    if (Array.isArray(annualStmts) && annualStmts.length >= 2) {
      const cur  = annualStmts[0];
      const prev = annualStmts[1];
      if (cur?.totalRevenue && prev?.totalRevenue > 0) {
        base.revenueGrowthPct = ((cur.totalRevenue - prev.totalRevenue) / prev.totalRevenue) * 100;
        base.passRevenue      = base.revenueGrowthPct >= 25;
      }
    }
  }

  // ── 5. Analyst target (FMP premium) ───────────────────────────────────────
  const pt = Array.isArray(fmpTarget) ? fmpTarget[0] : fmpTarget;
  base.analystTarget = pt?.targetConsensus ?? pt?.priceTarget ?? null;

  // ── 6. Short float (FMP premium) ──────────────────────────────────────────
  if (Array.isArray(fmpShortFloat) && fmpShortFloat[0]) {
    base.shortFloat           = fmpShortFloat[0].shortFloat ?? null;
    base.shortSqueezePotential = (base.shortFloat || 0) > 10;
  }

  // ── 7. Find earnings day bar ───────────────────────────────────────────────
  const earningsIdx = bars.findIndex(b => b.t >= earningsDate);
  if (earningsIdx < 1) return { ...base, error: 'No price bar found for earnings date' };
  const earningsBar = bars[earningsIdx];
  const prevBarE    = bars[earningsIdx - 1];

  // ── 8. Gap % on earnings day ───────────────────────────────────────────────
  if (earningsBar.o != null && prevBarE.c != null) {
    base.gapPct  = ((earningsBar.o - prevBarE.c) / prevBarE.c) * 100;
    base.passGap = base.gapPct >= 5;
  }

  // ── 9. Volume vs 20-day pre-earnings average ───────────────────────────────
  const preSlice  = bars.slice(Math.max(0, earningsIdx - 20), earningsIdx);
  const avgVol    = preSlice.length ? preSlice.reduce((a, b) => a + (b.v || 0), 0) / preSlice.length : 0;
  base.volRatio   = avgVol > 0 ? (earningsBar.v || 0) / avgVol : null;
  base.passVolume = (base.volRatio || 0) >= 2;

  // ── 10. 3-month resistance (highest high in 63 bars before earnings) ───────
  const resBars         = bars.slice(Math.max(0, earningsIdx - 63), earningsIdx);
  base.resistance       = resBars.length ? Math.max(...resBars.map(b => b.h)) : null;
  base.resistanceBroken = base.resistance != null && earningsBar.c > base.resistance;
  base.passResistance   = base.resistanceBroken;

  // ── 11. 10 EMA on full bar series ─────────────────────────────────────────
  const closes    = bars.map(b => b.c);
  const ema10Ser  = calcEMASeries(closes, 10);
  base.ema10      = ema10Ser.at(-1);
  if (base.ema10 && base.price) {
    base.ema10Distance = ((base.price - base.ema10) / base.ema10) * 100;
  }
  base.nearEMA10 = Math.abs(base.ema10Distance ?? 999) <= 2;

  // ── 12. Post-earnings entry trigger detection ──────────────────────────────
  const postBars = bars.slice(earningsIdx + 1);
  const postEMAs = ema10Ser.slice(earningsIdx + 1);

  if (postBars.length >= 1) {
    const lastBar   = bars.at(-1);
    const prevBar2  = bars.at(-2);
    const lastEMA10 = ema10Ser.at(-1);

    // ENTRY_ZONE: price consolidating near 10 EMA, close above prev bar high
    if (base.nearEMA10 && prevBar2 && lastBar.c > prevBar2.h) {
      base.signalType = 'ENTRY_ZONE';
    }

    // SHAKEOUT_ENTRY: prev bar dipped below 10 EMA, this bar reclaims above EMA
    if (postBars.length >= 2) {
      const n          = postBars.length;
      const pb         = postBars[n - 2];
      const pema       = postEMAs[n - 2];
      const shakeoutDip = pb && pema != null && pb.l < pema;
      const reclaim     = lastEMA10 != null && lastBar.c > lastEMA10;
      if (shakeoutDip && reclaim) base.signalType = 'SHAKEOUT_ENTRY';
    }

    // WATCHING: gap + volume confirmed but no entry trigger yet
    if (!base.signalType && base.passGap && base.passVolume) base.signalType = 'WATCHING';
  }

  // ── 13. Stop loss (3% below entry) ────────────────────────────────────────
  if (base.price) base.stopLoss = +(base.price * 0.97).toFixed(2);

  // ── 14. Confirmed flag ────────────────────────────────────────────────────
  // Full confirmation requires fundamentals (EPS + Revenue) AND technical (gap + volume) AND entry trigger
  // If fundamental data is unavailable (neither FMP nor Yahoo returned it), skip fundamental gate
  const hasFundamental = base.epsSurprisePct != null && base.revenueGrowthPct != null;
  const fundamentalPass = hasFundamental ? (base.passEPS && base.passRevenue) : false;
  base.confirmed = fundamentalPass && base.passGap && base.passVolume
    && (base.signalType === 'ENTRY_ZONE' || base.signalType === 'SHAKEOUT_ENTRY');

  return base;
}

// ── Fetch recent earnings from FMP calendar (default EE scan universe) ─────────
async function fetchRecentEarningsSymbols() {
  // Try FMP calendar first (exact announcement dates)
  const today = new Date();
  const from  = new Date(today); from.setDate(from.getDate() - 30);
  const fmt   = d => d.toISOString().slice(0, 10);
  const data  = await fmpGet(`/v3/earning_calendar?from=${fmt(from)}&to=${fmt(today)}`).catch(() => null);
  if (Array.isArray(data) && data.length) {
    const seen = new Set();
    const syms = [];
    for (const item of data) {
      if (!item.symbol || seen.has(item.symbol) || item.symbol.includes('.') || item.symbol.length > 5) continue;
      seen.add(item.symbol);
      syms.push(item.symbol);
      if (syms.length >= 50) break;
    }
    if (syms.length) return syms;
  }

  // FMP failed — return a curated list of high-volume earners likely to have
  // reported earnings in the last 60 days (banks in early Q, tech mid-Q, etc.)
  return [
    // Q1 2026 early reporters (banks, financials)
    'JPM','BAC','WFC','GS','MS','C','BLK','USB','PNC',
    // Large-cap tech (report mid-Q)
    'MSFT','GOOGL','META','AMZN','AAPL','NVDA','AMD','TSLA','NFLX',
    // Growth / AI
    'SNOW','CRWD','DDOG','PANW','NET','S','MDB','ZS',
    // Consumer / Retail
    'AMZN','COST','TGT','WMT','HD','LOW',
    // Healthcare
    'LLY','ABBV','REGN','MRNA','PFE',
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate
}

// ── EE cache ──────────────────────────────────────────────────────────────────
const _eeCache = new Map();
const EE_TTL   = 10 * 60 * 1000; // 10 min (FMP calls are heavy)

// ── GET /api/ee/signal/:symbol ────────────────────────────────────────────────
app.get('/api/ee/signal/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    const cached = _eeCache.get(sym);
    if (cached && Date.now() - cached.ts < EE_TTL) return res.json(cached.data);
    const sig = await computeEESignal(sym);
    _eeCache.set(sym, { data: sig, ts: Date.now() });
    res.json(sig);
  } catch (e) {
    res.status(500).json({ symbol: sym, error: e.message, confirmed: false });
  }
});

// ── GET /api/ee/scan?symbols=AAPL,TSLA,... ────────────────────────────────────
app.get('/api/ee/scan', async (req, res) => {
  let syms;
  if (req.query.symbols) {
    syms = req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  } else {
    // Try to get symbols that recently had earnings from FMP
    const earningsSyms = await fetchRecentEarningsSymbols();
    syms = earningsSyms || BOUNCE_UNIVERSE.slice(0, 40);
  }
  syms = [...new Set(syms)].slice(0, 60);

  const now    = Date.now();
  const BATCH  = 4; // small batch — each symbol makes 4 FMP calls
  const results = [];

  for (let i = 0; i < syms.length; i += BATCH) {
    const batch   = syms.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      const cached = _eeCache.get(sym);
      if (cached && now - cached.ts < EE_TTL) return cached.data;
      const sig = await computeEESignal(sym);
      _eeCache.set(sym, { data: sig, ts: Date.now() });
      return sig;
    }));
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ symbol: batch[idx], error: r.reason?.message || 'Failed', confirmed: false });
    });
    // Small pause between FMP batches to respect rate limits
    if (i + BATCH < syms.length) await new Promise(r => setTimeout(r, 300));
  }

  // Sort: ENTRY_ZONE first, then SHAKEOUT, WATCHING, rest
  const order = { ENTRY_ZONE: 0, SHAKEOUT_ENTRY: 1, WATCHING: 2 };
  results.sort((a, b) => {
    const oa = order[a.signalType] ?? 9;
    const ob = order[b.signalType] ?? 9;
    if (oa !== ob) return oa - ob;
    return (b.gapPct || 0) - (a.gapPct || 0);
  });

  res.json({
    ok: true,
    total: results.length,
    confirmed: results.filter(r => r.confirmed).length,
    entryZone: results.filter(r => r.signalType === 'ENTRY_ZONE').length,
    shakeout:  results.filter(r => r.signalType === 'SHAKEOUT_ENTRY').length,
    watching:  results.filter(r => r.signalType === 'WATCHING').length,
    results,
    scannedAt: new Date().toISOString(),
  });
});

// ── GET/PUT /api/ee/auto-settings ─────────────────────────────────────────────
app.get('/api/ee/auto-settings', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM ee_auto_settings WHERE user_id = ?').get(req.session.userId);
  res.json({ enabled: !!(row?.enabled), amount: row?.amount || 1000, leverage: row?.leverage || 1 });
});

app.put('/api/ee/auto-settings', requireAuth, (req, res) => {
  const { enabled, amount, leverage } = req.body || {};
  db.prepare(`
    INSERT INTO ee_auto_settings (user_id, enabled, amount, leverage)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enabled  = excluded.enabled,
      amount   = excluded.amount,
      leverage = excluded.leverage
  `).run(req.session.userId, enabled ? 1 : 0, +amount || 1000, +leverage || 1);
  res.json({ ok: true });
});

// ── GET /api/ee/trade-log ─────────────────────────────────────────────────────
app.get('/api/ee/trade-log', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM auto_trade_log
    WHERE user_id = ? AND strategy = 'explosive_earnings'
    ORDER BY created_at DESC LIMIT 50
  `).all(req.session.userId);
  res.json(rows);
});

// ── Server-side EE Auto-Trader ─────────────────────────────────────────────────
async function runEEAutoTrader() {
  if (!isMarketOpen()) return;

  const users = db.prepare('SELECT user_id, amount, leverage FROM ee_auto_settings WHERE enabled = 1').all();
  if (!users.length) return;

  console.log(`[EE-Bot] Auto-scan triggered for ${users.length} user(s)`);

  const now     = Date.now();
  const earningSyms = await fetchRecentEarningsSymbols().catch(() => null) || BOUNCE_UNIVERSE.slice(0, 25);
  const BATCH   = 4;
  const signals = [];

  for (let i = 0; i < earningSyms.length; i += BATCH) {
    const batch   = earningSyms.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async sym => {
      const cached = _eeCache.get(sym);
      if (cached && now - cached.ts < EE_TTL) return cached.data;
      const sig = await computeEESignal(sym);
      _eeCache.set(sym, { data: sig, ts: Date.now() });
      return sig;
    }));
    settled.forEach(r => {
      if (r.status === 'fulfilled' && r.value.confirmed) signals.push(r.value);
    });
    if (i + BATCH < earningSyms.length) await new Promise(r => setTimeout(r, 300));
  }

  if (!signals.length) { console.log('[EE-Bot] No confirmed entry signals.'); return; }
  console.log(`[EE-Bot] ${signals.length} confirmed signal(s): ${signals.map(s => `${s.symbol} ${s.signalType}`).join(', ')}`);

  for (const user of users) {
    const creds = getAlpacaCreds(user.user_id);
    if (!creds) continue;

    for (const sig of signals) {
      let positions = [];
      try { positions = await alpacaFetch(user.user_id, '/v2/positions'); } catch { continue; }

      const alreadyIn = Array.isArray(positions) && positions.some(p => p.symbol === sig.symbol);
      if (alreadyIn) { console.log(`[EE-Bot] Already in ${sig.symbol} — skipping`); continue; }

      const recentTrade = db.prepare(`
        SELECT id FROM auto_trade_log
        WHERE user_id = ? AND symbol = ? AND strategy = 'explosive_earnings'
        AND created_at >= datetime('now', '-60 minutes')
      `).get(user.user_id, sig.symbol);
      if (recentTrade) { console.log(`[EE-Bot] Cooldown active for ${sig.symbol}`); continue; }

      const lev    = Math.min(4, Math.max(1, user.leverage || 1));
      const amount = (user.amount || 1000) * lev;
      const price  = sig.price;
      const shares = Math.max(1, Math.floor(amount / price));

      // SL = 1.5% below entry; TP = 4.5% above (3:1 R/R)
      const slPrice = (price * 0.985).toFixed(2);
      const tpPrice = (price * 1.045).toFixed(2);

      const orderBody = {
        symbol:        sig.symbol,
        qty:           String(shares),
        side:          'buy',
        type:          'market',
        time_in_force: 'day',
        order_class:   'bracket',
        take_profit:   { limit_price: tpPrice },
        stop_loss:     { stop_price: slPrice },
      };

      try {
        const order = await alpacaFetch(user.user_id, '/v2/orders', {
          method: 'POST',
          body:   JSON.stringify(orderBody),
        });

        db.prepare(`
          INSERT INTO auto_trade_log
            (user_id, symbol, side, shares, entry_price, tp_price, sl_price, alpaca_order_id, signal, strategy, status, created_at)
          VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, 'explosive_earnings', 'open', datetime('now'))
        `).run(
          user.user_id, sig.symbol, shares, price,
          tpPrice, slPrice,
          order.id || null,
          sig.signalType
        );

        console.log(`[EE-Bot] ORDER: BUY ${shares} ${sig.symbol} @ ~$${price} [${sig.signalType}] user=${user.user_id}`);
      } catch (e) {
        console.error(`[EE-Bot] Order failed ${sig.symbol}:`, e.message);
      }
    }
  }
}

// ── Start EE auto-trader interval ─────────────────────────────────────────────
setInterval(runEEAutoTrader, 5 * 60 * 1000);
console.log('[EE-Bot] Explosive Earnings auto-trader initialized — scans every 5 min during market hours');


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

    // ── Stop & target (1.5% stop per user spec; 2:1 R/R minimum) ────────────
    const slPct  = 0.015;
    let stopLoss = null, target = null, riskReward = null;
    const srLevel = direction === 'SHORT' ? nearRes?.price : nearSup?.price;
    const srLabel = direction === 'SHORT' ? 'Resistance' : 'Support';

    if (direction === 'SHORT') {
      const stopFromSwing = swingHigh * 1.001; // 1 tick above swing high
      const stopFrom15   = price * (1 + slPct);
      stopLoss = Math.max(stopFromSwing, stopFrom15);
      const stopDist = stopLoss - price;
      // Target: nearest support or key MA; fallback = 2× stop dist
      const candidates = [sma50, sma200, nearSup?.price].filter(v => v && v < price);
      target = candidates.length ? Math.max(...candidates) : price - 2 * stopDist;
      riskReward = stopDist > 0 ? ((price - target) / stopDist).toFixed(2) : null;
    } else if (direction === 'LONG') {
      const stopFromSwing = swingLow * 0.999;
      const stopFrom15   = price * (1 - slPct);
      stopLoss = Math.min(stopFromSwing, stopFrom15);
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
const CT_UNIVERSE = [
  'AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','BRK.B','JPM','V',
  'UNH','XOM','LLY','JNJ','PG','MA','AVGO','HD','CVX','MRK',
  'COST','ABBV','AMD','NFLX','WMT','BAC','KO','PEP','TMO','ORCL',
  'CRM','CSCO','ACN','MCD','LIN','ADBE','ABT','DHR','NKE','TXN',
  'AMGN','QCOM','NEE','UNP','PM','SCHW','RTX','HON','INTU','IBM',
  'SPGI','LOW','GS','CAT','AMAT','DE','ELV','ISRG','BLK','BKNG',
  'SYK','AXP','MMC','GILD','PLD','ADI','MDT','TJX','VRTX','C',
  'REGN','SO','DUK','MO','ZTS','CB','CI','CME','EOG','SLB',
  'SPY','QQQ','IWM','DIA','GLD','TLT','HYG',
];

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

  const users = db.prepare('SELECT user_id, amount, leverage FROM ct_auto_settings WHERE enabled = 1').all();
  if (!users.length) return;

  const signals = [];
  const concurrency = 4;
  for (let i = 0; i < CT_UNIVERSE.length; i += concurrency) {
    const batch = CT_UNIVERSE.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(s => computeCTSignal(s)));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value?.confirmed) signals.push(r.value);
    });
  }
  if (!signals.length) return;

  for (const user of users) {
    const creds = db.prepare('SELECT * FROM alpaca_creds WHERE user_id = ?').get(user.user_id);
    if (!creds) continue;

    const base = creds.paper
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';
    const headers = {
      'APCA-API-KEY-ID': creds.api_key,
      'APCA-API-SECRET-KEY': creds.api_secret,
      'Content-Type': 'application/json',
    };

    for (const sig of signals) {
      const alreadyTraded = db.prepare(
        `SELECT id FROM auto_trade_log WHERE user_id=? AND symbol=? AND strategy='countertrend'
         AND created_at > datetime('now','-1 day')`
      ).get(user.user_id, sig.symbol);
      if (alreadyTraded) continue;

      try {
        const notional = (user.amount * user.leverage).toFixed(2);
        const side = sig.direction === 'SHORT' ? 'sell' : 'buy';

        const orderBody = {
          symbol: sig.symbol,
          notional,
          side,
          type: 'market',
          time_in_force: 'day',
        };

        const orderRes = await fetch(`${base}/v2/orders`, {
          method: 'POST', headers, body: JSON.stringify(orderBody),
        });
        const order = await orderRes.json();
        const orderId = order.id || null;
        const status  = orderRes.ok ? 'placed' : `error:${order.message || order.code}`;

        db.prepare(
          `INSERT INTO auto_trade_log (user_id, symbol, strategy, signal_type, confidence, amount, order_id, status)
           VALUES (?, ?, 'countertrend', ?, ?, ?, ?, ?)`
        ).run(user.user_id, sig.symbol, sig.signalType, sig.riskReward || 0, notional, orderId, status);
      } catch (err) {
        db.prepare(
          `INSERT INTO auto_trade_log (user_id, symbol, strategy, signal_type, confidence, amount, order_id, status)
           VALUES (?, ?, 'countertrend', ?, 0, 0, NULL, ?)`
        ).run(user.user_id, sig.symbol, sig.signalType, `error:${err.message}`);
      }
    }
  }
}

// ── Start CT auto-trader interval ─────────────────────────────────────────────
setInterval(runCTAutoTrader, 5 * 60 * 1000);
console.log('[CT-Bot] Countertrend auto-trader initialized — scans every 5 min during market hours');

app.listen(PORT, '0.0.0.0', () => console.log(`Johnny Qureshi Finance on :${PORT}`));
