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
`);

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

app.listen(PORT, '0.0.0.0', () => console.log(`Johnny Qureshi Finance on :${PORT}`));
