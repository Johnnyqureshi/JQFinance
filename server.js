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

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

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
].forEach(sql => { try { db.prepare(sql).run(); } catch(_) {} });

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

// ── Schema migrations (safe re-runs) ─────────────────────────────────────────
try { db.exec('ALTER TABLE auto_trade_log ADD COLUMN reasons TEXT'); } catch {}
try { db.exec('ALTER TABLE auto_trade_log ADD COLUMN exit_reason TEXT'); } catch {}
try { db.exec('ALTER TABLE auto_trade_log ADD COLUMN buying_power REAL'); } catch {}
try { db.exec('ALTER TABLE auto_trade_log ADD COLUMN order_placed_at TEXT'); } catch {}
try { db.exec('ALTER TABLE auto_trade_log ADD COLUMN atr REAL'); } catch {}
try { db.exec('ALTER TABLE auto_trade_log ADD COLUMN settled_cash REAL'); } catch {}
try { db.exec('ALTER TABLE auto_trade_log ADD COLUMN leverage REAL DEFAULT 1'); } catch {}

// ── Per-user in-memory state ──────────────────────────────────────────────────
const autoTraderStatus  = new Map(); // userId → { scanning, lastScan, lastAction, candidates, error }
// orderRateLimiter removed — Alpaca enforces its own rate limits
const atScanningUsers   = new Set(); // userId → prevents concurrent scans

// ── Sector ETFs — used for rotation detection each scan cycle ────────────────
const SECTOR_ETFS = ['XLK','XLF','XLE','XLV','XLI','XLC','XLY','XLP','XLB','XLRE','XLU'];

// ── Per-sector pools — all stocks typically under $50 ────────────────────────
const SECTOR_POOLS = {
  XLK: ['PLTR','SOFI','SOUN','IONQ','BBAI','SNAP','RDDT','HOOD','TWLO','PINS',
        'OPEN','AI','KVYO','SMCI','INTC','MU','AEHR','WOLF','POWI','AMBA'],
  XLF: ['SOFI','HOOD','AFRM','UPST','COOP','RKT','PFSI','NYCB','PRAA','ENVA'],
  XLE: ['SLB','HAL','DVN','OVV','CRC','PBR','CLNE','TELL','GEVO','REI'],
  XLV: ['NVAX','HIMS','ACCD','TDOC','AMWL','DOCS','RXRX','ACMR','FULC','VERA'],
  XLC: ['SNAP','RBLX','PINS','MTCH','BMBL','GROV','DUOL','SMAR','WDAY','SEAT'],
  XLY: ['GME','AMC','RIVN','LCID','NIO','XPEV','WKHS','BLNK','CHPT','GOEV',
        'DKNG','PENN','RDFN','OPEN','ABNB','LYFT','UBER'],
  XLI: ['JOBY','ACHR','RKLB','LUNR','SPCE','BWXT','KTOS','AVAV','SWBI','RGR'],
  XLB: ['CLF','X','MT','VALE','CSTM','ATI','CMC','WOR','STLD','NUE'],
  XLRE: ['OPEN','RDFN','Z','UWMC','GHLD','PFSI','RKT','COOP','EXPI','HOUS'],
  XLU: ['MARA','RIOT','CLSK','HUT','CIFR','IREN','BTDR','WGMI','SDIG','BTBT'],
  XLP: ['PRPL','VRA','XRAY','CENT','EDUC','USFD','SFM','GO','CASY','CHEF'],
};

// ── Baseline anchor list — always scanned, all under $50, proven liquid ───────
const AT_BASE = [
  // ── 3× Bull ETFs ──────────────────────────────────────────────────────────
  'TQQQ',  // 3x Nasdaq-100
  'SOXL',  // 3x Semiconductors
  'SPXL',  // 3x S&P 500
  'UPRO',  // 3x S&P 500 (ProShares)
  'TECL',  // 3x Technology
  'LABU',  // 3x Biotech
  'BULZ',  // 3x Mega-cap Tech
  'TNA',   // 3x Russell 2000
  'FAS',   // 3x Financials
  'FNGU',  // 3x FANG+
  'DFEN',  // 3x Aerospace & Defense
  'DPST',  // 3x Regional Banks
  'RETL',  // 3x Retail
  'PILL',  // 3x Pharma
  'HIBL',  // 3x S&P High Beta
  'MIDU',  // 3x S&P 400 Midcap
  'UTSL',  // 3x Utilities
  'NAIL',  // 3x Homebuilders
  'CURE',  // 3x Healthcare
  'WANT',  // 3x Consumer Discretionary
  'WEBL',  // 3x Dow Jones Internet
  // ── 2× Bull ETFs ──────────────────────────────────────────────────────────
  'ROM',   // 2x Technology
  'UWM',   // 2x Russell 2000
  'UCO',   // 2x Bloomberg Crude Oil
  'ERX',   // 2x Energy (Direxion)
  'NUGT',  // 2x Gold Miners
  'BOIL',  // 2x Bloomberg Natural Gas
  'DIG',   // 2x Oil & Gas
  'AGQ',   // 2x Silver
  'BITX',  // 2x Bitcoin Strategy
  'USD',   // 3x Regional Banks (ProShares)
  // ── 3× Inverse (Bear) ETFs ────────────────────────────────────────────────
  'SQQQ',  // 3x inverse Nasdaq-100
  'SOXS',  // 3x inverse Semiconductors
  'SPXS',  // 3x inverse S&P 500
  'SDOW',  // 3x inverse Dow Jones
  'TECS',  // 3x inverse Technology
  'LABD',  // 3x inverse Biotech
  'BERZ',  // 3x inverse Mega-cap Tech
  'FAZ',   // 3x inverse Financials
  'DRV',   // 3x inverse Real Estate
  'SRTY',  // 3x inverse Russell 2000
  'HIBS',  // 3x inverse S&P High Beta
  'TZA',   // 3x inverse Russell 2000 (Direxion)
  'WEBS',  // 3x inverse China
  'MIDZ',  // 3x inverse S&P 400 Midcap
  // ── 2× Inverse (Bear) ETFs ────────────────────────────────────────────────
  'DRIP',  // 2x inverse Energy
  'DUST',  // 2x inverse Gold Miners
  'SCO',   // 2x inverse Crude Oil
  'KOLD',  // 2x inverse Natural Gas
  'SDS',   // 2x inverse S&P 500
  'QID',   // 2x inverse Nasdaq-100
  'TWM',   // 2x inverse Russell 2000
  'DUG',   // 2x inverse Oil & Gas
  'GLL',   // 2x inverse Gold
  'ZSL',   // 2x inverse Silver
  // ── Volatility products ───────────────────────────────────────────────────
  'UVXY',  // 1.5x VIX Short-Term Futures
  'UVIX',  // 2x VIX Short-Term Futures
  'VXX',   // 1x VIX Short-Term Futures
  'SVXY',  // -0.5x VIX (inverse volatility)
  // ── Single-stock 2× Bull leveraged ETFs ───────────────────────────────────
  'TSLL',  // 2x Tesla (Direxion)
  'NVDX',  // 2x NVIDIA (T-Rex)
  'NVDG',  // 2x NVIDIA (Themes)
  'NVDL',  // 2x NVIDIA (GraniteShares)
  'AMDL',  // 2x AMD (GraniteShares)
  'HOOG',  // 2x Alphabet/Google (Leverage Shares)
  'PLTG',  // 2x Palantir (Leverage Shares)
  'PMAX',  // Powell Max
  'SMCL',  // Single-stock leveraged
  // ── Single-stock 2× Inverse leveraged ETFs ────────────────────────────────
  'NVDQ',  // 2x inverse NVIDIA (T-Rex)
  'NVD',   // 2x inverse NVIDIA (T-Rex)
  'MSTZ',  // 2x inverse MicroStrategy (T-Rex)
  'TSLZ',  // 2x inverse Tesla (T-Rex)
  'TSDD',  // 2x inverse Tesla
  'PLTD',  // 2x inverse Palantir (Leverage Shares)
  'CORD',  // 2x inverse Coinbase (T-Rex)
  'AAPD',  // 2x inverse Apple (Direxion)
  'AMDD',  // 2x inverse AMD (Direxion)
  'GGLS',  // 2x inverse Alphabet (Direxion)
  'QQQD',  // 2x inverse QQQ (Direxion)
  'SBIT',  // 2x inverse Bitcoin (ProShares)
  'RGTZ',  // 2x inverse Mag-7 (Defiance)
  // ── Mining & critical metals ───────────────────────────────────────────────
  'USAS',  // Americas Gold & Silver
  'ASM',   // Avino Silver & Gold
  'CRML',  // Critical Metals
  'DNN',   // Denison Mines
  'NVA',   // Nova Minerals
  'TMQ',   // Trilogy Metals
  'TGB',   // Taseko Mines
  'NAK',   // Northern Dynasty Minerals
  'PLG',   // Platinum Group Metals
  // ── Energy — oil, gas, uranium ────────────────────────────────────────────
  'RIG',   // Transocean
  'EGY',   // Vaalco Energy
  'BTE',   // Baytex Energy
  'ANNA',  // AleAnna
  'NEXT',  // NextDecade
  'URG',   // Ur-Energy
  'TALO',  // Talos Energy
  'SOC',   // Sable Offshore
  'SSL',   // Sasol
  // ── Robotics & AI hardware ────────────────────────────────────────────────
  'RCAT',  // Red Cat (drone defence)
  'UMAC',  // Unusual Machines
  'RR',    // Richtech Robotics
  'SERV',  // Serve Robotics
  // High-beta under $50
  'PLTR','SOFI','HOOD','SNAP','RBLX','GME','AMC','RIVN','LCID','NIO',
  'XPEV','MARA','RIOT','CLSK','SOUN','IONQ','BBAI','ACHR','JOBY','RKLB',
  'HIMS','LUNR','RDDT','KVYO','AFRM','UPST','DKNG','PENN','SQ','PYPL',
  'PINS','TWLO','MTCH','BMBL','ROKU','OPEN','AI','BLNK','CHPT','WKHS',
  'BABA','NIO','JD','PDD','LI','XPEV','BIDU','MNSO','VIPS','TIGR',
  'NVAX','MRNA','HIMS','ACCD','TDOC','AMWL','DOCS','RXRX','ACMR','VERA',
  'INTC','MU','WOLF','POWI','AMBA','SMCI','CEVA','FORM','RMBS','SLAB',
];

// ── Dynamic universe builder — called each scan cycle ─────────────────────────
// Runs most-active screener + sector rotation in parallel, returns symbol list + metadata
// Cache last successful universe so a transient Yahoo failure never leaves us with nothing
let _universeCache = null;

async function atBuildUniverse() {
  const symbolSet = new Set(AT_BASE);
  let hotSectors  = [];

  const [activeResult, sectorResult] = await Promise.allSettled([
    // 1. Yahoo Finance most-active — top 100 stocks by today's volume
    fetch(
      'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=100&start=0',
      { headers: YH }
    ).then(r => r.ok ? r.json() : null).catch(() => null),

    // 2. Sector ETF quotes for rotation ranking
    yf.quote(SECTOR_ETFS, {}, { validateResult: false }).catch(() => null),
  ]);

  // Process most-active screener
  if (activeResult.status === 'fulfilled' && activeResult.value) {
    const quotes = activeResult.value?.finance?.result?.[0]?.quotes || [];
    let added = 0;
    for (const q of quotes) {
      if (q.symbol && (q.regularMarketPrice || 0) > 2 && (q.regularMarketPrice || 0) <= 30) {
        symbolSet.add(q.symbol); added++;
      }
    }
    console.log(`[AT Universe] most-active screener: ${added} under-$30 symbols added`);
  } else {
    console.warn('[AT Universe] most-active screener unavailable — using base list');
  }

  // Process sector rotation
  if (sectorResult.status === 'fulfilled' && sectorResult.value) {
    const sArr = Array.isArray(sectorResult.value) ? sectorResult.value : [sectorResult.value];
    const ranked = sArr
      .filter(q => q?.regularMarketVolume > 0)
      .sort((a, b) => (b.regularMarketVolume || 0) - (a.regularMarketVolume || 0));

    hotSectors = ranked.slice(0, 4).map(q => ({
      etf:    q.symbol,
      vol:    q.regularMarketVolume,
      chg:    q.regularMarketChangePercent,
    }));

    const hotNames = hotSectors.map(s => `${s.etf}(${s.chg >= 0 ? '+' : ''}${(s.chg||0).toFixed(2)}%)`).join(', ');
    console.log('[AT Universe] hot sectors: ' + hotNames);

    for (const { etf } of hotSectors) {
      for (const sym of (SECTOR_POOLS[etf] || [])) symbolSet.add(sym);
    }
  }

  const result = { symbols: [...symbolSet], hotSectors };
  // Save successful build to cache — used as fallback if Yahoo is rate-limited next cycle
  _universeCache = result;
  return result;
}

// ── Market hours guard (US Eastern) ──────────────────────────────────────────
function isUSMarketOpen() {
  try {
    const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const et    = new Date(etStr);
    const day   = et.getDay();   // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;
    const mins  = et.getHours() * 60 + et.getMinutes();
    return mins >= 570 && mins < 960; // 9:30 – 16:00 ET
  } catch { return false; }
}

// Rate limiter removed — Alpaca enforces its own API limits on their side.
// Internal throttling was blocking valid trades after 10 scan attempts/hr.

// ── Analysis math (100% real bars from Yahoo Finance) ────────────────────────
function atVWAP(bars) {
  let st = 0, sv = 0;
  for (const b of bars) {
    if (!b.v || b.v <= 0 || b.h == null || b.l == null) continue;
    st += ((b.h + b.l + b.c) / 3) * b.v; sv += b.v;
  }
  return sv > 0 ? st / sv : null;
}

function atRSI(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i-1];
    d >= 0 ? (g += d) : (l -= d);
  }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function atSR(bars, price) {
  if (bars.length < 5 || !price) return { support: null, resistance: null };
  const sup = [], res = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const h = bars[i].h, l = bars[i].l;
    if (h != null && h > bars[i-1].h && h > bars[i-2].h && h > bars[i+1].h && h > bars[i+2].h) res.push(h);
    if (l != null && l < bars[i-1].l && l < bars[i-2].l && l < bars[i+1].l && l < bars[i+2].l) sup.push(l);
  }
  const nearest = (arr, above) => {
    const f = above ? arr.filter(v => v > price) : arr.filter(v => v < price);
    return f.length ? (above ? Math.min(...f) : Math.max(...f)) : null;
  };
  return { support: nearest(sup, false), resistance: nearest(res, true) };
}

function atMomentum(bars) {
  const last = bars.slice(-Math.min(6, bars.length));
  let score = 0;
  for (const b of last) {
    if (b.c > b.o) score++;
    else if (b.c < b.o) score--;
  }
  return score;
}

function atEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// ── ATR — Average True Range ──────────────────────────────────────────────────
function atATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// ── Volume Profile — VAH / VAL / POC ─────────────────────────────────────────
// Divides the session range into price buckets, distributes volume proportionally,
// then expands from the Point of Control until 70% of total volume is captured.
function atVolumeProfile(bars, numBuckets = 24) {
  if (!bars || bars.length < 5) return null;
  const validBars = bars.filter(b => b.h != null && b.l != null && b.v > 0);
  if (validBars.length < 3) return null;
  const hi = Math.max(...validBars.map(b => b.h));
  const lo = Math.min(...validBars.map(b => b.l));
  if (hi - lo < 0.01) return null;
  const bucketSize = (hi - lo) / numBuckets;
  const buckets = Array.from({ length: numBuckets }, (_, i) => ({
    low:    lo + i * bucketSize,
    high:   lo + (i + 1) * bucketSize,
    center: lo + (i + 0.5) * bucketSize,
    volume: 0,
  }));
  for (const b of validBars) {
    const bRange = b.h - b.l;
    if (bRange < 0.001) {
      const idx = Math.max(0, Math.min(numBuckets - 1, Math.floor((b.c - lo) / bucketSize)));
      buckets[idx].volume += b.v;
    } else {
      for (let bi = 0; bi < numBuckets; bi++) {
        const overlap = Math.min(b.h, buckets[bi].high) - Math.max(b.l, buckets[bi].low);
        if (overlap > 0) buckets[bi].volume += b.v * (overlap / bRange);
      }
    }
  }
  // Point of Control — highest-volume bucket
  let pocIdx = 0;
  for (let i = 1; i < numBuckets; i++) {
    if (buckets[i].volume > buckets[pocIdx].volume) pocIdx = i;
  }
  // Value Area — expand from POC until 70% of session volume is captured
  const totalVol = buckets.reduce((s, b) => s + b.volume, 0);
  let vaVol = buckets[pocIdx].volume;
  let vaLo = pocIdx, vaHi = pocIdx;
  while (vaVol < totalVol * 0.70) {
    const canUp   = vaHi < numBuckets - 1;
    const canDown = vaLo > 0;
    if (!canUp && !canDown) break;
    const upVol   = canUp   ? buckets[vaHi + 1].volume : -1;
    const downVol = canDown ? buckets[vaLo - 1].volume : -1;
    if (upVol >= downVol) { vaHi++; vaVol += buckets[vaHi].volume; }
    else                  { vaLo--; vaVol += buckets[vaLo].volume; }
  }
  return {
    poc: parseFloat(buckets[pocIdx].center.toFixed(2)),
    vah: parseFloat(buckets[vaHi].high.toFixed(2)),
    val: parseFloat(buckets[vaLo].low.toFixed(2)),
    totalVol,
  };
}

// ── Higher High / Higher Low structure (last 5 bars) ─────────────────────────
function atHHHL(bars) {
  if (bars.length < 4) return false;
  const last = bars.slice(-5);
  let hh = false, hl = false;
  for (let i = 1; i < last.length; i++) {
    if (last[i].h > last[i - 1].h) hh = true;
    if (last[i].l > last[i - 1].l) hl = true;
  }
  return hh && hl;
}

// ── Market session guards (US/Eastern) ────────────────────────────────────────
function atSessionInfo() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const day   = et.getDay();
  const mins  = et.getHours() * 60 + et.getMinutes();
  const isWeekend     = day === 0 || day === 6;
  const isMarketOpen  = !isWeekend && mins >= 570 && mins < 960; // 9:30–16:00
  const isEarlyWindow = !isWeekend && mins >= 570 && mins < 585; // 9:30–9:45 blackout
  const isNearClose   = !isWeekend && mins >= 945;               // ≥ 15:45 → force close
  return { isMarketOpen, isEarlyWindow, isNearClose, mins };
}

// ── Signal engine — Volume Profile first, RSI/VWAP/EMA as secondary ──────────
//
//  PHILOSOPHY:
//    Volume Profile defines WHERE price is relative to where the most volume
//    was traded (the Value Area). The engine uses two primary triggers:
//      1. VAL Bounce  — price sitting on Value Area Low support → buy the bounce
//      2. POC Breakout — price breaks above Point of Control with volume surge
//    These two triggers determine ENTRY. RSI, VWAP, and EMAs score confidence
//    but never block a trade on their own.
//    Take Profit = VAH (Value Area High — where volume thins out above)
//    Stop Loss   = just below VAL (invalidation of the support thesis)
//
function atSignal(bars, closes, price, rsi, vwap, volData, atr, vp) {
  // No Volume Profile = no signal. VP is the foundation.
  if (!vp) {
    return {
      signal: 'HOLD', confidence: 0, price, rsi, vwap,
      reasons: ['✗ volume profile: insufficient bar data to compute VAH/VAL/POC'],
      checks: { volume_profile: { pass: false, detail: 'need ≥5 bars with volume' } },
      vah: null, val: null, poc: null,
    };
  }

  const ema9   = atEMA(closes, 9);
  const ema21  = atEMA(closes, 21);
  const hhhl   = atHHHL(bars);
  const vwapPct = vwap ? ((price - vwap) / vwap) * 100 : 0;

  // ── VP zone calculations ───────────────────────────────────────────────────
  const vaWidth    = vp.vah - vp.val;                          // value area spread
  const nearVAL    = price >= vp.val && price <= vp.val + vaWidth * 0.12; // within 12% of VA width above VAL
  const tightVAL   = price >= vp.val && price <= vp.val + vaWidth * 0.05; // within 5% — prime entry
  const abovePOC   = price > vp.poc;
  const belowVAH   = price < vp.vah;
  const inVA       = price >= vp.val && price <= vp.vah;

  // ── Volume data ────────────────────────────────────────────────────────────
  const volRatio = volData.avgV > 0 ? volData.lastV / volData.avgV : 0;
  const volSurge = volRatio >= 1.5;   // 50% above average = surge
  const volOk    = volRatio >= 1.0;   // at least average

  // ── PRIMARY TRIGGERS (Volume Profile-based) ───────────────────────────────
  //  val_bounce:   price on VAL support — pure price location, no volume requirement
  //                (mid-day bars always read low volume vs open — volOk would kill every setup)
  //  poc_breakout: price above POC with any above-average volume conviction
  const val_bounce   = nearVAL  && belowVAH && price > 2;
  const poc_breakout = abovePOC && belowVAH && price > 2 && volRatio >= 1.2;
  const primaryFires = val_bounce || poc_breakout;

  // ── Zone description for UI ────────────────────────────────────────────────
  const zoneStr = tightVAL  ? '🎯 Tight VAL entry'
    : val_bounce             ? '📍 VAL bounce zone'
    : poc_breakout           ? '🔼 POC breakout'
    : price < vp.val         ? '⬇ Below VAL — bearish'
    : price > vp.vah         ? '⬆ Extended above VAH'
    : inVA                   ? '↔ Inside value area'
    : '–';

  // ── SECONDARY: Confidence scoring (not blockers) ───────────────────────────
  const rsiOk     = rsi != null && rsi >= 30 && rsi <= 70;
  const aboveVWAP = vwap && price > vwap;
  const trendOk   = ema9 != null && ema21 != null && price > ema9 && price > ema21;

  const vpDetail = `VAL $${vp.val} · POC $${vp.poc} · VAH $${vp.vah}`;
  const checks = {
    vp_primary:      { pass: primaryFires,  detail: primaryFires ? `${val_bounce?'VAL bounce':'POC breakout'} — ${vpDetail}` : `no VP trigger (${zoneStr}) — ${vpDetail}` },
    price_above_2:   { pass: price > 2,     detail: '$' + price.toFixed(2) },
    rsi_healthy:     { pass: rsiOk,         detail: rsi != null ? `RSI=${rsi.toFixed(0)}` : 'n/a' },
    above_vwap:      { pass: !!aboveVWAP,   detail: vwap ? `VWAP=$${vwap.toFixed(2)} (${vwapPct.toFixed(1)}%)` : 'n/a' },
    ema_trend:       { pass: trendOk,       detail: ema9 && ema21 ? `EMA9=$${ema9.toFixed(2)} EMA21=$${ema21.toFixed(2)}` : 'n/a' },
    hhhl_structure:  { pass: hhhl,          detail: hhhl ? 'HH+HL confirmed' : 'no structure' },
    volume_surge:    { pass: volSurge,      detail: volData.avgV > 0 ? volRatio.toFixed(1) + '× avg' : 'n/a' },
  };

  // ── Confidence calculation ─────────────────────────────────────────────────
  let confidence;
  if (primaryFires) {
    // Base 65 when VP trigger fires. Secondary indicators add points.
    confidence = 65;
    if (rsiOk)      confidence += 8;   // momentum not extreme
    if (aboveVWAP)  confidence += 5;   // above intraday fair value
    if (trendOk)    confidence += 5;   // EMA stack confirms direction
    if (hhhl)       confidence += 4;   // structure trending up
    if (volSurge)   confidence += 6;   // above-average conviction
    if (tightVAL)   confidence += 8;   // tight VAL = prime bounce spot
  } else {
    // No VP trigger — score secondaries only (won't reach trade threshold)
    const secPass = [rsiOk, !!aboveVWAP, trendOk, hhhl, volSurge].filter(Boolean).length;
    confidence = secPass * 7;   // max 35 — below 65 threshold
  }

  const reasons = Object.entries(checks).map(([k, v]) =>
    (v.pass ? '✓ ' : '✗ ') + k.replace(/_/g, ' ') + ': ' + v.detail
  );

  return {
    signal:     primaryFires ? 'BUY' : 'HOLD',
    confidence: Math.min(confidence, 97),
    reasons, checks, price, rsi, vwap, vwapPct,
    ema9, ema21, atr, hhhl,
    vah:      vp.vah,
    val:      vp.val,
    poc:      vp.poc,
    nearVAL, tightVAL, abovePOC, inVA,
    zoneStr,
  };
}

// ── Fetch real 5-min bars from Yahoo Finance ──────────────────────────────────
async function atFetchBars(sym) {
  try {
    // 5-day fixed-range VP gives a statistically meaningful distribution.
    // Session-only (1d) has <24 bars in the first 2 hours — not enough for reliable VAH/VAL/POC.
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=5d&includePrePost=false`,
      { headers: YH }
    );
    if (!r.ok) { console.warn(`[AT bars] ${sym} HTTP ${r.status}`); return null; }
    const d  = await r.json();
    const rs = d?.chart?.result?.[0];
    if (!rs) return null;
    const times = rs.timestamp || [];
    const q = rs.indicators?.quote?.[0] || {};
    const bars = times.map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      o: q.open?.[i]  ?? null,
      h: q.high?.[i]  ?? null,
      l: q.low?.[i]   ?? null,
      c: q.close?.[i] ?? null,
      v: q.volume?.[i]?? null,
    })).filter(b => b.c != null && b.h != null && b.l != null && b.v > 0);
    return bars.length >= 15 ? bars : null;
  } catch(e) { console.warn(`[AT bars] ${sym} error:`, e.message); return null; }
}

// ── Full analysis for one symbol — returns signal or null ─────────────────────
async function atAnalyze(sym) {
  const bars = await atFetchBars(sym);
  if (!bars) return null;

  const price  = bars[bars.length - 1].c;
  const closes = bars.map(b => b.c);
  const vwap   = atVWAP(bars);
  const rsi    = atRSI(closes) ?? 50;
  const atr    = atATR(bars);
  const vp     = atVolumeProfile(bars);   // VAH / VAL / POC

  const vols  = bars.map(b => b.v ?? 0).filter(v => v > 0);
  const avgV  = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const lastV = bars[bars.length - 1].v ?? 0;
  const volData = { lastV, avgV, surge: avgV > 0 && lastV / avgV > 1.8 };

  return atSignal(bars, closes, price, rsi, vwap, volData, atr, vp);
}

// ── Place bracket order — VP-first sizing, VAH as TP, VAL as SL ──────────────
async function atPlaceOrder(userId, sym, sig, settledCash, buyingPower, settings) {
  const price = sig.price;
  const atr   = sig.atr;

  if (sig.signal !== 'BUY') return { skipped: true, reason: 'BUY only mode' };
  if (price <= 2)            return { skipped: true, reason: 'price ≤ $2' };

  // ── Auto-leverage: confidence-scaled, capped at user's max setting ───────
  const maxLev  = Math.min(4, Math.max(1, settings.leverage || 1));
  const conf    = sig.confidence || 0;
  const lev     = conf >= 90 ? maxLev : conf >= 80 ? Math.min(maxLev, 2) : 1;

  // ── TP / SL anchored to Value Area ─────────────────────────────────────────
  //   TP = VAH  — where volume thins out above; natural profit magnet
  //   SL = VAL  - 0.5× ATR  — just below support, exit if thesis is wrong
  //   Fallback to ATR multiples when VP unavailable (shouldn't happen often)
  const limitPx  = parseFloat((price * 1.0005).toFixed(2)); // limit 0.05% above last — rounded to cent (Alpaca requires ≥$0.01 increment)

  let tpPrice, slPrice;
  if (sig.vah && sig.val) {
    const isPocBreak = sig.zoneStr?.includes('POC breakout');
    const vaWidth    = sig.vah - sig.val;
    // POC breakout: target a full VA-width above VAH (momentum projection)
    // VAL bounce:   target VAH (price travels floor → ceiling of value area)
    tpPrice = isPocBreak && vaWidth > 0
      ? parseFloat((sig.vah + vaWidth).toFixed(2))
      : parseFloat(sig.vah.toFixed(2));
    slPrice = parseFloat((sig.val - (atr ? 0.5 * atr : sig.val * 0.005)).toFixed(2));
    // Sanity: TP must be above entry, SL must be below entry
    if (tpPrice <= limitPx) tpPrice = parseFloat((limitPx * 1.02).toFixed(2));
    if (slPrice >= limitPx) slPrice = parseFloat((limitPx * 0.985).toFixed(2));
  } else if (atr && atr > 0) {
    slPrice = parseFloat((limitPx - 1.5 * atr).toFixed(2));
    tpPrice = parseFloat((limitPx + 3.0 * atr).toFixed(2));
  } else {
    return { skipped: true, reason: 'No VAH/VAL or ATR for order levels' };
  }

  // ── Position sizing: user's dollar allocation × leverage / share price ────
  const investUSD  = settings.investment_amount || 1000;
  const allocUSD   = investUSD * lev;
  const rawShares  = Math.floor(allocUSD / limitPx);
  const maxByBP    = Math.floor((buyingPower * 0.95) / limitPx);
  const shares     = Math.max(1, Math.min(rawShares, maxByBP));

  if (rawShares < 1) {
    console.warn('[AT] user=' + userId + ' ' + sym + ': investment $' + investUSD.toFixed(0) + ' too small for price $' + price.toFixed(2));
    return { insufficientBP: true };
  }

  // ── Determine order type ──────────────────────────────────────────────────
  //   auto   → market for poc_breakout (speed matters), limit for val_bounce (precise entry)
  //   limit  → always limit (current price + 0.05% buffer)
  //   market → always market (fills immediately at best available price)
  const orderTypeSetting = settings.order_type || 'auto';
  const signalType       = sig.zoneStr || '';
  const useMarket = orderTypeSetting === 'market'
    || (orderTypeSetting === 'auto' && signalType.includes('POC breakout'));
  const entryPx  = useMarket ? price : limitPx; // for sizing when market

  const slDist   = parseFloat((entryPx - slPrice).toFixed(4));
  const tpDist   = parseFloat((tpPrice  - entryPx).toFixed(4));
  const rr       = slDist > 0 ? (tpDist / slDist).toFixed(2) : '?';

  // ── Determine time-in-force (day vs GTC for swing trades) ────────────────
  // Market orders MUST be 'day' (Alpaca rejects GTC market orders).
  // Limit orders in swing mode use 'gtc' so the entry stays open overnight
  // and the bracket legs (TP + SL) persist until actually hit.
  const isSwing = (settings.trade_duration || 'swing') === 'swing';
  const tif = (isSwing && !useMarket) ? 'gtc' : 'day';

  // ── Build order body — limit or market bracket ────────────────────────────
  const orderBody = {
    symbol:        sym,
    qty:           String(shares),
    side:          'buy',
    type:          useMarket ? 'market' : 'limit',
    time_in_force: tif,
    order_class:   'bracket',
    take_profit:   { limit_price: String(tpPrice) },
    stop_loss:     { stop_price:  String(slPrice)  },
  };
  // Limit orders need an explicit limit_price; market orders must NOT include it
  if (!useMarket) orderBody.limit_price = String(limitPx);

  const durLabel = isSwing ? 'SWING/GTC' : 'DAY';
  console.log(`[AT] ${sym}: ${useMarket ? 'MARKET' : 'LIMIT'} ${durLabel} order qty=${shares} entry~$${entryPx.toFixed(2)} TP=$${tpPrice} SL=$${slPrice} R:R=${rr}`);

  const order = await alpacaFetch(userId, '/v2/orders', {
    method: 'POST',
    body:   JSON.stringify(orderBody),
  });

  if (order?.id) {
    const notional = (shares * limitPx).toFixed(2);
    const levStr   = lev > 1 ? ` | ${lev}x` : '';
    const vpStr    = sig.vah ? ` | VAL $${sig.val} → VAH $${sig.vah}` : '';
    const action   = `AUTO BUY ${shares}sh ${sym} @ $${limitPx.toFixed(2)} | SL $${slPrice} | TP $${tpPrice} (VAH) | R:R ${rr}:1 | ${sig.confidence}% conf | ${durLabel}${levStr}${vpStr}`;
    db.prepare(`
      INSERT INTO auto_trade_log
        (user_id, symbol, side, shares, entry_price, tp_price, sl_price,
         alpaca_order_id, signal, confidence, reasons, buying_power,
         settled_cash, atr, order_placed_at, leverage, status)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_fill')
    `).run(
      userId, sym, shares, limitPx, tpPrice, slPrice,
      order.id, sig.signal, sig.confidence,
      JSON.stringify(sig.reasons), buyingPower,
      settledCash, atr, new Date().toISOString(), lev
    );
    autoTraderStatus.set(userId, { ...(autoTraderStatus.get(userId) || {}), lastAction: action });
    console.log('[AutoTrader] user=' + userId + ' ' + action + ' | notional $' + notional);
    return { placed: true, order };
  }

  const errMsg = order?.message || order?.code || 'order rejected';
  console.error('[AT] user=' + userId + ' ' + sym + ' order failed: ' + errMsg);
  return { failed: true, error: errMsg };
}

// ── Exit monitor — runs every cycle before new entries ────────────────────────
async function atCheckExits(userId, positions, settings, session) {
  const allTracked = db.prepare(
    `SELECT * FROM auto_trade_log WHERE user_id = ? AND status IN ('open','pending_fill')`
  ).all(userId);

  let exitCount = 0;

  for (const log of allTracked) {

    // ── PENDING orders: promote to open or cancel after 120 s ─────────────────
    if (log.status === 'pending_fill') {
      const ageMs = log.order_placed_at ? Date.now() - new Date(log.order_placed_at).getTime() : Infinity;
      try {
        const ord = await alpacaFetch(userId, '/v2/orders/' + log.alpaca_order_id);
        if (ord?.status === 'filled' || ord?.status === 'partially_filled') {
          const fillPx = parseFloat(ord.filled_avg_price || log.entry_price);
          db.prepare(`UPDATE auto_trade_log SET status='open', entry_price=? WHERE id=?`).run(fillPx, log.id);
          console.log('[AT] user=' + userId + ' ' + log.symbol + ' limit order filled @ $' + fillPx);
        } else if (ageMs >= 120_000 || ord?.status === 'expired' || ord?.status === 'canceled') {
          // Cancel unfilled limit order after 2 minutes
          await alpacaFetch(userId, '/v2/orders/' + log.alpaca_order_id, { method: 'DELETE' }).catch(() => {});
          db.prepare(`UPDATE auto_trade_log SET status='cancelled', closed_at=datetime('now'), exit_reason='unfilled_timeout' WHERE id=?`).run(log.id);
          console.log('[AT] user=' + userId + ' ' + log.symbol + ' unfilled limit order cancelled (' + Math.round(ageMs / 1000) + 's)');
          exitCount++;
        }
      } catch(e) { console.warn('[AT] pending check error ' + log.symbol + ':', e.message); }
      continue;
    }

    // ── OPEN positions ─────────────────────────────────────────────────────────
    const pos = Array.isArray(positions) ? positions.find(p => p.symbol === log.symbol) : null;

    // Position gone — broker closed it (TP or SL bracket filled)
    if (!pos) {
      let realPnl = null;
      try {
        const orders = await alpacaFetch(userId, '/v2/orders?status=closed&symbols=' + log.symbol + '&limit=5');
        const closed = Array.isArray(orders)
          ? orders.find(o => o.legs?.length || o.type === 'limit' || o.type === 'stop')
          : null;
        if (closed?.filled_avg_price && log.entry_price) {
          const fillPx = parseFloat(closed.filled_avg_price);
          realPnl = (fillPx - log.entry_price) * log.shares;
        }
      } catch {}
      const pnlStr = realPnl != null ? '$' + realPnl.toFixed(2) : 'unknown';
      db.prepare(`UPDATE auto_trade_log SET status='closed', closed_at=datetime('now'), pnl=?, exit_reason='broker_close' WHERE id=?`).run(realPnl, log.id);
      console.log('[AT] user=' + userId + ' ' + log.symbol + ' closed by broker bracket | P&L ' + pnlStr);
      exitCount++;
      continue;
    }

    // Active position — check exit conditions (only during market hours)
    if (!session.isMarketOpen) continue;
    try {
      const pnl       = parseFloat(pos.unrealized_pl  || 0);
      const curPrice  = parseFloat(pos.current_price  || 0);

      // Fetch current bars for EMA check
      const bars = await atFetchBars(log.symbol);
      const closes = bars ? bars.map(b => b.c) : [];
      const ema9   = closes.length >= 9 ? atEMA(closes, 9) : null;

      // ── Hard exit if price closes below 9 EMA ────────────────────────────────
      if (ema9 != null && curPrice < ema9) {
        await atClosePosition(userId, log, pnl, 'price_below_ema9');
        exitCount++;
        continue;
      }

    } catch(e) {
      console.error('[AT] Exit check error ' + log.symbol + ':', e.message);
    }
  }
  return exitCount;
}

// ── Close a position — cancel brackets, market close, log ────────────────────
async function atClosePosition(userId, log, pnl, reason) {
  try {
    const openOrds = await alpacaFetch(userId, '/v2/orders?status=open&symbols=' + log.symbol + '&limit=10');
    if (Array.isArray(openOrds)) {
      for (const o of openOrds) {
        if (o.id !== log.alpaca_order_id) {
          await alpacaFetch(userId, '/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {});
        }
      }
    }
  } catch {}
  await alpacaFetch(userId, '/v2/positions/' + log.symbol, { method: 'DELETE' });
  db.prepare(`UPDATE auto_trade_log SET status='closed', closed_at=datetime('now'), pnl=?, exit_reason=? WHERE id=?`).run(pnl, reason, log.id);
  const sign = pnl >= 0 ? '+' : '';
  const action = 'EXIT ' + log.symbol + ' (' + reason.replace(/_/g, ' ') + ') | P&L ' + sign + '$' + pnl.toFixed(2);
  autoTraderStatus.set(userId, { ...(autoTraderStatus.get(userId) || {}), lastAction: action });
  console.log('[AutoTrader] user=' + userId + ' ' + action);
}

// ── Main engine for one user ──────────────────────────────────────────────────
async function atRunForUser(userId, dryRun = false) {
  // Prevent concurrent scans for the same user
  if (atScanningUsers.has(userId)) {
    console.log(`[AT] user=${userId} scan already in progress — skipping`);
    return;
  }
  atScanningUsers.add(userId);

  const settings = db.prepare('SELECT * FROM auto_trade_settings WHERE user_id = ?').get(userId);
  if (!settings?.enabled && !dryRun) { atScanningUsers.delete(userId); return; }

  const session    = atSessionInfo();
  const marketOpen = session.isMarketOpen;

  autoTraderStatus.set(userId, {
    scanning:   true,
    lastScan:   new Date().toISOString(),
    lastAction: autoTraderStatus.get(userId)?.lastAction || null,
    candidates: [],
    error:      null,
    marketOpen,
    earlyWindow: session.isEarlyWindow,
    nearClose:   session.isNearClose,
  });

  let result = { exitCount: 0, entryAttempt: null, candidates: [], hotSectors: [], marketOpen, dryRun };

  try {
    // ── 1. Fetch account state from Alpaca ────────────────────────────────────
    let acct, positions;
    try {
      [acct, positions] = await Promise.all([
        alpacaFetch(userId, '/v2/account'),
        alpacaFetch(userId, '/v2/positions'),
      ]);
    } catch(e) {
      autoTraderStatus.set(userId, {
        scanning: false, lastScan: new Date().toISOString(),
        marketOpen, error: 'Alpaca unreachable: ' + e.message,
      });
      atScanningUsers.delete(userId);
      return result;
    }

    if (acct.error || acct.account_blocked) {
      const errMsg = acct.message || acct.error || 'Account error';
      autoTraderStatus.set(userId, { scanning: false, lastScan: new Date().toISOString(), error: errMsg });
      atScanningUsers.delete(userId);
      return result;
    }

    const equity      = parseFloat(acct.equity      || 0);
    const buyingPower = parseFloat(acct.buying_power || 0);
    const settledCash = parseFloat(acct.cash         || acct.equity || 0); // settled cash only
    if (equity <= 0) { atScanningUsers.delete(userId); return result; }

    // ── PDT protection ───────────────────────────────────────────────────────
    // Pattern Day Trader rule: if equity < $25k AND daytrade_count >= 3, skip entries
    const daytradeCount = parseInt(acct.daytrade_count || 0, 10);
    const isPDT         = acct.pattern_day_trader === true;
    const pdtBlocked    = equity < 25000 && daytradeCount >= 3;
    result.pdtBlocked   = pdtBlocked;
    result.daytradeCount= daytradeCount;
    if (pdtBlocked && !dryRun) {
      console.warn('[AT] user=' + userId + ' PDT protection active — daytradeCount=' + daytradeCount + ' equity=$' + equity.toFixed(0));
    }

    // Log session state at the start of each cycle
    console.log('[AutoTrader] user=' + userId + ' settled=$' + settledCash.toFixed(2) + ' BP=$' + buyingPower.toFixed(2) + ' positions=' + (Array.isArray(positions) ? positions.length : 0) + (pdtBlocked?' [PDT BLOCKED]':''));

    const posArr   = Array.isArray(positions) ? positions : [];
    const openSyms = new Set(posArr.map(p => p.symbol));

    // ── 2. Check exits on all open/pending auto-trade positions ──────────────
    // Runs every cycle regardless of market hours — broker_close/pending reconciliation
    // is always needed; active EMA exits are gated inside atCheckExits by session.isMarketOpen
    if (!dryRun) {
      result.exitCount = await atCheckExits(userId, posArr, settings, session);

      // Re-fetch positions after exits so position count is accurate
      if (result.exitCount > 0) {
        try {
          const freshPos = await alpacaFetch(userId, '/v2/positions');
          if (Array.isArray(freshPos)) {
            posArr.length = 0;
            freshPos.forEach(p => posArr.push(p));
            openSyms.clear();
            posArr.forEach(p => openSyms.add(p.symbol));
          }
        } catch {}
      }
    }

    // ── 3. Build dynamic universe + quote all symbols ─────────────────────────
    let candidates = [];
    const MIN_DAILY_VOL = 1_000_000;   // 1M minimum — ensures real liquidity
    const MAX_PRICE     = 30;          // hard cap — under-$30 only for better VP spread
    try {
      let universeData;
      try {
        universeData = await atBuildUniverse();
      } catch (universeErr) {
        // Yahoo Finance / network failure — fall back to the last known-good universe
        if (_universeCache) {
          console.warn('[AT Universe] build failed, using cached universe from last cycle:', universeErr.message);
          universeData = _universeCache;
        } else {
          throw universeErr; // no cache yet — propagate so error shows in UI
        }
      }
      const { symbols: universe, hotSectors } = universeData;
      result.hotSectors = hotSectors;

      const rawQ = await yf.quote(universe, {}, { validateResult: false });
      const arr  = Array.isArray(rawQ) ? rawQ : (rawQ ? [rawQ] : []);
      candidates = arr
        .filter(q => q?.symbol
          && (q.regularMarketPrice || 0) >  2           // no penny stocks
          && (q.regularMarketPrice || 0) <= MAX_PRICE   // hard cap $50
          && (q.regularMarketVolume || 0) >= MIN_DAILY_VOL) // min 1M vol today
        .sort((a, b) => (b.regularMarketVolume || 0) - (a.regularMarketVolume || 0));

      const syms = candidates.map(c => c.symbol);
      console.log(`[AutoTrader] ${candidates.length} qualify ($2-$30, vol≥1M) from ${universe.length} universe: ${syms.slice(0,20).join(',')}`);

      candidates = candidates.map(q => ({
        symbol: q.symbol,
        volume: q.regularMarketVolume,
        price:  q.regularMarketPrice,
      }));
    } catch(e) {
      console.error('[AT] Universe scan error:', e.message);
    }

    result.candidates = candidates.map(c => c.symbol);

    autoTraderStatus.set(userId, {
      scanning: true, lastScan: new Date().toISOString(), marketOpen,
      lastAction: autoTraderStatus.get(userId)?.lastAction,
      candidates: result.candidates,
      earlyWindow: session.isEarlyWindow,
      nearClose:   session.isNearClose,
    });

    // ── 4. Analyze candidates — find highest-confidence BUY signal ────────────
    const MAX_POSITIONS = Math.min(settings.max_positions || 1, 4); // user-configurable, max 4
    const atmOpen = db.prepare(
      `SELECT COUNT(*) as cnt FROM auto_trade_log WHERE user_id=? AND status IN ('open','pending_fill')`
    ).get(userId)?.cnt || 0;

    // Analyze all candidates in parallel (no order placement yet)
    const analyses = await Promise.all(
      candidates
        .filter(c => !openSyms.has(c.symbol))
        .filter(c => !db.prepare(
            `SELECT id FROM auto_trade_log WHERE user_id=? AND symbol=? AND status IN ('open','pending_fill')`
          ).get(userId, c.symbol))
        .map(async c => ({
          symbol: c.symbol,
          volume: c.volume,
          sig:    await atAnalyze(c.symbol).catch(() => null),
        }))
    );

    // Log each symbol's result for full transparency
    for (const a of analyses) {
      const s = a.sig;
      if (!s) { console.log(`[AT] ${a.symbol}: no data`); continue; }
      const zone  = s.zoneStr  || '--';
      const vpStr = s.vah ? `VAL $${s.val} POC $${s.poc} VAH $${s.vah}` : 'no VP';
      console.log(`[AT] ${a.symbol}: ${s.signal} conf=${s.confidence}% price=$${s.price?.toFixed(2)} zone="${zone}" ${vpStr}`);
    }

    // BUY only (cash account) — VP trigger fires + minimum R:R of 1.0
    const MIN_RR = 1.0;
    const actionable = analyses
      .filter(a => {
        if (a.sig?.signal !== 'BUY') return false;
        const sig          = a.sig;
        const atr          = sig.atr || (sig.val ? sig.val * 0.005 : 0);
        const sl           = sig.val - atr * 0.5;
        const px           = sig.price;
        if (!sig.vah || !sl || !px) return false;
        const isPocBreak   = sig.zoneStr?.includes('POC breakout');
        const vaWidth      = (sig.vah && sig.val) ? sig.vah - sig.val : 0;
        // POC breakouts extend TP a full VA-width above VAH (momentum projection)
        // VAL bounces keep TP = VAH (price travels from floor to ceiling of VA)
        const tp = isPocBreak && vaWidth > 0 ? sig.vah + vaWidth : sig.vah;
        const rr = (tp - px) / Math.max(px - sl, 0.001);
        if (rr < MIN_RR) {
          console.log(`[AT] ${a.symbol}: BUY skipped — R:R=${rr.toFixed(2)} < ${MIN_RR} (VA too tight)${isPocBreak ? ' [extended TP used]' : ''}`);
          return false;
        }
        return true;
      })
      .sort((a, b) => b.sig.confidence - a.sig.confidence);
    console.log('[AutoTrader] BUY signals: ' + actionable.length + ' of ' + analyses.length + ' analyzed (R:R≥' + MIN_RR + ')');

    // Build analyses for UI — include VP levels and zone context
    const maxLevSetting = Math.min(4, Math.max(1, settings.leverage || 1));
    result.analyses = analyses.map(a => {
      const sig = a.sig || {};
      const c   = sig.confidence || 0;
      const lev = c >= 90 ? maxLevSetting : c >= 80 ? Math.min(maxLevSetting, 2) : 1;
      // VP-based TP/SL for display — POC breakouts show extended TP (VAH + VA width)
      const entryPx      = sig.price ? parseFloat((sig.price * 1.0005).toFixed(4)) : null;
      let tp_price = null, sl_price = null;
      if (sig.vah && sig.val && entryPx) {
        const isPocBreakDisp = sig.zoneStr?.includes('POC breakout');
        const vaWidthDisp    = sig.vah - sig.val;
        tp_price = isPocBreakDisp && vaWidthDisp > 0
          ? parseFloat((sig.vah + vaWidthDisp).toFixed(2))
          : parseFloat(sig.vah.toFixed(2));
        sl_price = parseFloat((sig.val - (sig.atr ? 0.5 * sig.atr : sig.val * 0.005)).toFixed(2));
        if (tp_price <= entryPx) tp_price = parseFloat((entryPx * 1.02).toFixed(2));
        if (sl_price >= entryPx) sl_price = parseFloat((entryPx * 0.985).toFixed(2));
      }
      return {
        symbol:       a.symbol,
        signal:       sig.signal     || 'HOLD',
        confidence:   sig.confidence || 0,
        price:        sig.price,
        rsi:          sig.rsi,
        atr:          sig.atr,
        ema9:         sig.ema9,
        ema21:        sig.ema21,
        vah:          sig.vah,
        val:          sig.val,
        poc:          sig.poc,
        nearVAL:      sig.nearVAL,
        tightVAL:     sig.tightVAL,
        abovePOC:     sig.abovePOC,
        inVA:         sig.inVA,
        zoneStr:      sig.zoneStr,
        reasons:      sig.reasons    || [],
        checks:       sig.checks     || {},
        autoLeverage: lev,
        sl_price,
        tp_price,
      };
    });

    // Persist latest analyses + sector rotation in status so polling can surface them
    autoTraderStatus.set(userId, {
      ...(autoTraderStatus.get(userId) || {}),
      analyses:     result.analyses,
      hotSectors:   result.hotSectors,
      pdtBlocked,
      daytradeCount,
    });

    // ── 5. Place order — walk all actionable signals until one fills ──────────
    const canEnter = !dryRun && session.isMarketOpen && atmOpen < MAX_POSITIONS && actionable.length > 0 && !pdtBlocked;
    if (canEnter) {
      let placed = false;
      for (const candidate of actionable) {
        result.entryAttempt = candidate.symbol;
        const orderResult = await atPlaceOrder(userId, candidate.symbol, candidate.sig, settledCash, buyingPower, settings);
        result.orderResult = orderResult;

        if (orderResult.placed) {
          placed = true;
          break; // success — stop trying further signals this cycle
        }
        if (orderResult.insufficientBP) {
          console.log(`[AT] ${candidate.symbol}: insufficient buying power — trying next signal`);
          continue;
        }
        if (orderResult.failed) {
          console.log(`[AT] ${candidate.symbol}: order failed (${orderResult.error}) — trying next signal`);
          continue;
        }
        // skipped (e.g. HOLD signal) — move on
        continue;
      }
      if (!placed) {
        autoTraderStatus.set(userId, {
          ...(autoTraderStatus.get(userId) || {}),
          lastAction: `${actionable.length} signal(s) found — all skipped (BP/price check failed)`,
        });
      }
    } else if (!dryRun && !session.isMarketOpen) {
      autoTraderStatus.set(userId, {
        ...(autoTraderStatus.get(userId) || {}),
        lastAction: 'Market closed — monitoring exits only',
      });
    } else if (!dryRun && atmOpen >= MAX_POSITIONS) {
      autoTraderStatus.set(userId, {
        ...(autoTraderStatus.get(userId) || {}),
        lastAction: 'At max positions (' + atmOpen + '/' + MAX_POSITIONS + ') — monitoring only',
      });
    } else if (!dryRun && actionable.length === 0) {
      autoTraderStatus.set(userId, {
        ...(autoTraderStatus.get(userId) || {}),
        lastAction: `Scan complete — no VP entry signals found (${candidates.length} scanned)`,
      });
    }

  } catch(e) {
    console.error(`[AutoTrader] user=${userId} fatal:`, e.message);
    autoTraderStatus.set(userId, {
      scanning: false, lastScan: new Date().toISOString(),
      error: e.message, marketOpen,
    });
  } finally {
    autoTraderStatus.set(userId, {
      ...(autoTraderStatus.get(userId) || {}),
      scanning: false,
      lastScan: new Date().toISOString(),
    });
    atScanningUsers.delete(userId);
  }

  return result;
}

// ── Engine loop — fires every 60 seconds ──────────────────────────────────────
let _lastEngineTick = Date.now();

async function atRunAll() {
  _lastEngineTick = Date.now();
  const enabled = db.prepare('SELECT user_id FROM auto_trade_settings WHERE enabled = 1').all();
  for (const { user_id } of enabled) {
    atRunForUser(user_id, false).catch(e =>
      console.error(`[AutoTrader] user=${user_id} unhandled:`, e.message)
    );
  }
}
let atInterval = setInterval(atRunAll, 60_000);
console.log('[AutoTrader] Engine started — scanning every 60 s');

// ── Watchdog — restarts the interval if the engine goes silent for >2 minutes ─
setInterval(() => {
  const gap = Date.now() - _lastEngineTick;
  if (gap > 120_000) {
    console.warn(`[AutoTrader] Watchdog: engine silent for ${Math.round(gap / 1000)}s — restarting interval`);
    clearInterval(atInterval);
    atInterval = setInterval(atRunAll, 60_000);
    atRunAll();
  }
}, 30_000);

// ── Auto-trade API routes ─────────────────────────────────────────────────────

const AT_DEFAULTS = {
  enabled: 0, max_positions: 1, investment_amount: 1000, leverage: 1.0, min_volume: 500_000, order_type: 'auto', trade_duration: 'swing',
};

app.get('/api/alpaca/auto-settings', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM auto_trade_settings WHERE user_id = ?').get(req.session.userId);
  res.json(s || AT_DEFAULTS);
});

app.put('/api/alpaca/auto-settings', requireAuth, (req, res) => {
  if (!getAlpacaCreds(req.session.userId)) return res.status(400).json({ error: 'Connect Alpaca first.' });
  const b     = req.body || {};
  const clamp = (v, mn, mx, def) => Math.min(mx, Math.max(mn, isFinite(+v) ? +v : def));
  const orderType    = ['limit','market','auto'].includes(b.order_type)    ? b.order_type    : 'auto';
  const tradeDur     = ['day','swing'].includes(b.trade_duration)          ? b.trade_duration : 'swing';
  db.prepare(`
    INSERT OR REPLACE INTO auto_trade_settings
      (user_id, enabled, max_positions, investment_amount, leverage, min_volume, order_type, trade_duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.userId,
    b.enabled ? 1 : 0,
    clamp(b.max_positions,    1,   4,           1),
    clamp(b.investment_amount,50, 500_000, 1000),
    clamp(b.leverage,         1,   4,           1),
    clamp(b.min_volume,  500_000, 100_000_000, 500_000),
    orderType,
    tradeDur,
  );
  res.json({ ok: true });
});

app.get('/api/alpaca/auto-log', requireAuth, (req, res) => {
  const logs = db.prepare(
    'SELECT * FROM auto_trade_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.session.userId);
  // Parse stored JSON reasons field
  res.json(logs.map(l => ({
    ...l,
    reasons: l.reasons ? JSON.parse(l.reasons).join(', ') : '',
  })));
});

app.get('/api/alpaca/auto-status', requireAuth, (req, res) => {
  const st       = autoTraderStatus.get(req.session.userId) || {};
  const sess     = atSessionInfo();
  const settings2 = db.prepare('SELECT max_positions FROM auto_trade_settings WHERE user_id=?').get(req.session.userId);
  const openCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM auto_trade_log WHERE user_id=? AND status IN ('open','pending_fill')`
  ).get(req.session.userId)?.cnt || 0;
  res.json({
    scanning:      false,
    lastScan:      null,
    lastAction:    null,
    candidates:    [],
    analyses:      [],
    hotSectors:    [],
    pdtBlocked:    false,
    daytradeCount: 0,
    marketOpen:    sess.isMarketOpen,
    openPositions: openCount,
    maxPositions:  settings2?.max_positions || 1,
    ...st,
  });
});

// Trigger one real scan cycle immediately
app.post('/api/alpaca/auto-scan', requireAuth, async (req, res) => {
  if (!getAlpacaCreds(req.session.userId)) return res.status(400).json({ error: 'Connect Alpaca first.' });
  atRunForUser(req.session.userId, false).catch(e =>
    console.error('[AT] manual scan:', e.message)
  );
  res.json({ ok: true, message: 'Scan triggered — results in ~10 s.' });
});

// ── Simulation endpoint — dry run with real data, NO orders placed ────────────
app.post('/api/alpaca/simulate', requireAuth, async (req, res) => {
  if (!getAlpacaCreds(req.session.userId)) return res.status(400).json({ error: 'Connect Alpaca first.' });
  try {
    const result = await atRunForUser(req.session.userId, true /* dryRun */);
    res.json({ ok: true, simulation: result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Backtest endpoint — 60 days of 1h bars, VP strategy simulated ─────────────
app.get('/api/alpaca/backtest', requireAuth, async (req, res) => {
  const BT_SYMBOLS = [
    'AAPL','TSLA','NVDA','AMD','META','AMZN','MSFT','GOOGL','NFLX','COIN',
    'SPY','QQQ','BABA','SHOP','SNAP','UBER','LYFT','PLTR','RBLX','SOFI'
  ];
  const trades  = [];
  const errors  = [];

  for (const sym of BT_SYMBOLS) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1h&range=60d&includePrePost=false`;
      const r   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { errors.push(sym); continue; }
      const d   = await r.json();
      const rs  = d?.chart?.result?.[0];
      if (!rs)  { errors.push(sym); continue; }

      const times = rs.timestamp || [];
      const q     = rs.indicators?.quote?.[0] || {};
      const allBars = times.map((t, i) => ({
        t: new Date(t * 1000),
        o: q.open?.[i]   ?? null,
        h: q.high?.[i]   ?? null,
        l: q.low?.[i]    ?? null,
        c: q.close?.[i]  ?? null,
        v: q.volume?.[i] ?? 0,
      })).filter(b => b.h != null && b.l != null && b.c != null && b.v > 0);

      // Group by NY trading day
      const days = {};
      for (const bar of allBars) {
        const key = bar.t.toLocaleDateString('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
        if (!days[key]) days[key] = [];
        days[key].push(bar);
      }

      for (const [date, bars] of Object.entries(days)) {
        if (bars.length < 5) continue;
        bars.sort((a, b) => a.t - b.t);

        const vp = atVolumeProfile(bars);
        if (!vp || vp.vah <= vp.val) continue;

        const vaWidth   = vp.vah - vp.val;
        const openBar   = bars[0];
        const openPrice = openBar.o ?? openBar.c;
        if (!openPrice || openPrice <= 2) continue;

        // ── Check if open is in VAL bounce zone OR first bar breaks above POC ──
        const avgVol  = bars.reduce((s, b) => s + b.v, 0) / bars.length;
        const inValZone    = openPrice >= vp.val && openPrice <= vp.val + vaWidth * 0.12 && openBar.v >= avgVol * 0.7;
        const pocBreakout  = openPrice > vp.poc && openBar.v >= avgVol * 1.5;
        if (!inValZone && !pocBreakout) continue;

        const trigger  = inValZone ? 'val_bounce' : 'poc_breakout';
        const slLevel  = vp.val * 0.995;           // 0.5% below VAL
        const tpLevel  = vp.vah;

        if (tpLevel <= openPrice) continue;        // sanity: must have upside
        if (slLevel >= openPrice) continue;        // sanity: must have downside

        // Simulate: scan remaining bars for TP or SL hit
        let hit = 'expired';
        let exitPrice = bars[bars.length - 1].c;
        for (let i = 1; i < bars.length; i++) {
          const bar    = bars[i];
          const tpHit  = bar.h >= tpLevel;
          const slHit  = bar.l <= slLevel;
          if (tpHit && slHit) { hit = 'tp'; exitPrice = tpLevel; break; } // gap up counts as win
          if (tpHit)          { hit = 'tp'; exitPrice = tpLevel; break; }
          if (slHit)          { hit = 'sl'; exitPrice = slLevel; break; }
        }

        const tpDist  = tpLevel - openPrice;
        const slDist  = openPrice - slLevel;
        const rr      = slDist > 0 ? parseFloat((tpDist / slDist).toFixed(2)) : 0;
        const pnlPct  = parseFloat((((exitPrice - openPrice) / openPrice) * 100).toFixed(3));

        trades.push({ symbol: sym, date, trigger, hit, openPrice: parseFloat(openPrice.toFixed(2)),
          tpLevel: parseFloat(tpLevel.toFixed(2)), slLevel: parseFloat(slLevel.toFixed(2)),
          vah: vp.vah, val: vp.val, poc: vp.poc, rr, pnlPct });
      }
    } catch (e) { errors.push(sym); }
  }

  trades.sort((a, b) => new Date(b.date) - new Date(a.date));

  const wins    = trades.filter(t => t.hit === 'tp');
  const losses  = trades.filter(t => t.hit === 'sl');
  const expired = trades.filter(t => t.hit === 'expired');
  const winRate = trades.length > 0 ? parseFloat((wins.length / trades.length * 100).toFixed(1)) : 0;
  const avgRR   = trades.length > 0 ? parseFloat((trades.reduce((s, t) => s + t.rr, 0) / trades.length).toFixed(2)) : 0;
  const totalPnl = parseFloat(trades.reduce((s, t) => s + t.pnlPct, 0).toFixed(2));
  const avgWin  = wins.length   > 0 ? parseFloat((wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length).toFixed(2))     : 0;
  const avgLoss = losses.length > 0 ? parseFloat((losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length).toFixed(2)) : 0;
  // Kelly criterion for expected value
  const w = winRate / 100;
  const b = avgRR;
  const kelly = b > 0 ? parseFloat(((w - (1 - w) / b) * 100).toFixed(1)) : 0;

  res.json({
    ok: true,
    stats: { total: trades.length, wins: wins.length, losses: losses.length,
             expired: expired.length, winRate, avgRR, totalPnl, avgWin, avgLoss, kelly, errors },
    trades: trades.slice(0, 200),
  });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Johnny Qureshi Finance on :${PORT}`));
