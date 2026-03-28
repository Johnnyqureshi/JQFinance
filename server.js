require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');

const app     = express();
const PORT    = 5000;
const FMP_KEY = process.env.FMP_API_KEY;
const FMP_V3  = 'https://financialmodelingprep.com/api/v3';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Yahoo Finance helpers ─────────────────────────────────────────────────────

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

async function yahooOneQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const r   = await fetch(url, { headers: YF_HEADERS });
  if (!r.ok) return null;
  const data   = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const meta  = result.meta || {};
  const ohlcv = result.indicators?.quote?.[0] || {};
  const closes = (ohlcv.close || []).filter(v => v != null);
  const opens  = (ohlcv.open  || []).filter(v => v != null);
  const vols   = (ohlcv.volume|| []).filter(v => v != null);

  const price  = meta.regularMarketPrice ?? closes[closes.length - 1] ?? null;
  const prev   = meta.chartPreviousClose ?? (closes.length >= 2 ? closes[closes.length - 2] : null);
  const open   = opens[opens.length - 1]  ?? null;
  const change = price != null && prev != null ? price - prev : null;
  const changePct = change != null && prev ? (change / prev) * 100 : null;

  // 5-day avg volume
  const avgVolume = vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null;

  return {
    symbol:            meta.symbol || symbol,
    name:              meta.longName || meta.shortName || symbol,
    price,
    change,
    changesPercentage: changePct,
    open,
    dayHigh:           meta.regularMarketDayHigh ?? null,
    dayLow:            meta.regularMarketDayLow  ?? null,
    previousClose:     prev,
    volume:            meta.regularMarketVolume  ?? (vols.length ? vols[vols.length - 1] : null),
    avgVolume,
  };
}

async function yahooQuotes(symbols) {
  if (!symbols.length) return {};
  const results = await Promise.all(
    symbols.map(sym => yahooOneQuote(sym).then(q => ({ sym, q })).catch(() => ({ sym, q: null })))
  );
  const out = {};
  results.forEach(({ sym, q }) => { if (q) out[sym] = q; });
  return out;
}

// ─── FMP helper (graceful — never throws to caller) ──────────────────────────

async function fmpGet(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${FMP_V3}${endpoint}${sep}apikey=${FMP_KEY}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`FMP ${r.status}`);
  return r.json();
}

// ─── GET /api/snapshots?symbols=A,B,C  (Yahoo Finance — no rate limit) ────────
app.get('/api/snapshots', async (req, res) => {
  const raw  = (req.query.symbols || '').trim();
  if (!raw) return res.json({});
  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  try {
    const results = await yahooQuotes(syms);
    res.json(results);
  } catch (e) {
    console.error('[snapshots]', e.message);
    res.json({});
  }
});

// ─── GET /api/quote/:symbol  (Yahoo Finance — no rate limit) ─────────────────
app.get('/api/quote/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    const results = await yahooQuotes([sym]);
    const q = results[sym];
    if (!q) return res.status(404).json({ error: 'Symbol not found' });
    res.json(q);
  } catch (e) {
    console.error('[quote]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/search?q=query  (Yahoo Finance search — no rate limit) ─────────
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const url  = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
    const r    = await fetch(url, { headers: YF_HEADERS });
    const data = await r.json();
    const quotes = (data?.quotes || []).filter(x =>
      x.quoteType === 'EQUITY' && x.symbol && !x.symbol.includes('.')
    );
    res.json(quotes.slice(0, 8).map(x => ({
      symbol:            x.symbol,
      name:              x.shortname || x.longname || x.symbol,
      exchangeShortName: x.exchange  || '',
    })));
  } catch (e) {
    console.error('[search]', e.message);
    res.json([]);
  }
});

// ─── GET /api/bars/:symbol  (Yahoo Finance OHLCV — no rate limit) ────────────
app.get('/api/bars/:symbol', async (req, res) => {
  const symbol    = req.params.symbol.toUpperCase();
  const timeframe = req.query.timeframe || '1Day';
  const limit     = parseInt(req.query.limit) || 60;

  const intervalMap = { '1Hour': '1h', '1Day': '1d', '1Min': '1m', '5Min': '5m', '15Min': '15m' };
  const interval    = intervalMap[timeframe] || '1d';
  const range       = limit <= 7 ? '5d' : limit <= 30 ? '1mo' : limit <= 90 ? '3mo' : limit <= 180 ? '6mo' : '1y';

  try {
    const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
    const r      = await fetch(url, { headers: YF_HEADERS });
    if (!r.ok) return res.status(r.status).json({ bars: [] });
    const data   = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.json({ bars: [] });

    const times = result.timestamp || [];
    const ohlcv = result.indicators?.quote?.[0] || {};
    const { open = [], high = [], low = [], close = [], volume = [] } = ohlcv;

    const bars = times.map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      o: open[i]   ?? null,
      h: high[i]   ?? null,
      l: low[i]    ?? null,
      c: close[i]  ?? null,
      v: volume[i] ?? null,
    })).filter(b => b.c !== null);

    res.json({ bars: bars.slice(-limit) });
  } catch (e) {
    console.error('[bars]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/historical/:symbol  (Yahoo Finance daily — for Trader RSI) ──────
app.get('/api/historical/:symbol', async (req, res) => {
  const symbol     = req.params.symbol.toUpperCase();
  const timeseries = parseInt(req.query.timeseries) || 30;
  try {
    const range = timeseries <= 30 ? '1mo' : timeseries <= 90 ? '3mo' : '6mo';
    const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`;
    const r     = await fetch(url, { headers: YF_HEADERS });
    if (!r.ok) return res.status(r.status).json({ historical: [] });
    const data   = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.json({ historical: [] });

    const times = result.timestamp || [];
    const ohlcv = result.indicators?.quote?.[0] || {};
    const { open = [], high = [], low = [], close = [], volume = [] } = ohlcv;

    // Return newest-first to match original FMP shape
    const historical = times.map((t, i) => ({
      date:   new Date(t * 1000).toISOString().slice(0, 10),
      open:   open[i]   ?? null,
      high:   high[i]   ?? null,
      low:    low[i]    ?? null,
      close:  close[i]  ?? null,
      volume: volume[i] ?? null,
    })).filter(b => b.close !== null).reverse();

    res.json({ historical: historical.slice(0, timeseries) });
  } catch (e) {
    console.error('[historical]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/news/:symbol  (FMP with graceful fallback) ─────────────────────
app.get('/api/news/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await fmpGet(`/stock_news?tickers=${symbol}&limit=20`);
    const news = (Array.isArray(data) ? data : []).map(n => ({
      headline:   n.title,
      title:      n.title,
      summary:    n.text,
      url:        n.url,
      source:     n.site,
      created_at: n.publishedDate,
    }));
    res.json({ news });
  } catch (e) {
    console.error('[news]', e.message);
    // Fallback: Yahoo Finance news
    try {
      const url  = `https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&quotesCount=0&newsCount=10`;
      const r    = await fetch(url, { headers: YF_HEADERS });
      const data = await r.json();
      const news = (data?.news || []).map(n => ({
        headline:   n.title,
        title:      n.title,
        url:        n.link,
        source:     n.publisher,
        created_at: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      }));
      res.json({ news });
    } catch {
      res.json({ news: [] });
    }
  }
});

// ─── GET /api/stock/:symbol  (FMP analyst data with graceful fallback) ────────
app.get('/api/stock/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  const empty = { ratings: { strongBuy:0, buy:0, hold:0, sell:0, strongSell:0, total:0 }, priceTarget: null, upgrades: [] };

  try {
    const [ratingData, ptData, upgradesData] = await Promise.all([
      fmpGet(`/analyst-stock-recommendations/${symbol}`).catch(() => []),
      fmpGet(`/price-target-consensus?symbol=${symbol}`).catch(() => []),
      fmpGet(`/upgrades-downgrades?symbol=${symbol}`).catch(() => []),
    ]);

    const rEntry = Array.isArray(ratingData) && ratingData[0] ? ratingData[0] : null;
    const ratings = rEntry ? {
      strongBuy:  rEntry.analystRatingsStrongBuy  || 0,
      buy:        rEntry.analystRatingsbuy         || 0,
      hold:       rEntry.analystRatingsHold        || 0,
      sell:       rEntry.analystRatingsSell        || 0,
      strongSell: rEntry.analystRatingsStrongSell  || 0,
      total: (rEntry.analystRatingsStrongBuy  || 0)
           + (rEntry.analystRatingsbuy         || 0)
           + (rEntry.analystRatingsHold        || 0)
           + (rEntry.analystRatingsSell        || 0)
           + (rEntry.analystRatingsStrongSell  || 0),
    } : empty.ratings;

    const pt = Array.isArray(ptData) ? ptData[0] : ptData;
    const priceTarget = pt ? {
      targetLow:    pt.targetLow,
      targetMedian: pt.targetMedian || pt.targetConsensus,
      targetHigh:   pt.targetHigh,
    } : null;

    const upgrades = (Array.isArray(upgradesData) ? upgradesData : []).slice(0, 10).map(u => ({
      gradingCompany: u.gradingCompany,
      date:           u.publishedDate || u.date,
      previousGrade:  u.previousGrade,
      newGrade:       u.newGrade,
      action:         u.action,
    }));

    res.json({ ratings, priceTarget, upgrades });
  } catch (e) {
    console.error('[stock]', e.message);
    res.json(empty);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StockPulse running on port ${PORT}`);
});
