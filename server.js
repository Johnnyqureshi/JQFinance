require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fetch    = require('node-fetch');

const app     = express();
const PORT    = 5000;
const FMP_KEY = process.env.FMP_API_KEY;
const FMP     = 'https://financialmodelingprep.com/api/v3';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helper ───────────────────────────────────────────────────────────────────

async function fmpGet(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${FMP}${endpoint}${sep}apikey=${FMP_KEY}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`FMP ${r.status}: ${endpoint}`);
  return r.json();
}

// Flat quote fields extracted from FMP /quote response
function flatQuote(q) {
  if (!q || !q.symbol) return null;
  return {
    symbol:            q.symbol,
    name:              q.name              || '',
    price:             q.price             ?? null,
    change:            q.change            ?? null,
    changesPercentage: q.changesPercentage ?? null,
    open:              q.open              ?? null,
    dayHigh:           q.dayHigh           ?? null,
    dayLow:            q.dayLow            ?? null,
    previousClose:     q.previousClose     ?? null,
    volume:            q.volume            ?? null,
    avgVolume:         q.avgVolume         ?? null,
  };
}

// ─── GET /api/quote/:symbol ───────────────────────────────────────────────────
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const data = await fmpGet(`/quote/${req.params.symbol.toUpperCase()}`);
    const q    = flatQuote(Array.isArray(data) ? data[0] : data);
    if (!q) return res.status(404).json({ error: 'Symbol not found' });
    res.json(q);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/snapshots?symbols=A,B,C ─────────────────────────────────────────
// Returns { SYM: flatQuote, ... }
app.get('/api/snapshots', async (req, res) => {
  const raw  = (req.query.symbols || '').trim();
  if (!raw) return res.json({});
  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

  try {
    const results = await Promise.all(
      syms.map(sym =>
        fmpGet(`/quote/${sym}`)
          .then(d => ({ sym, q: flatQuote(Array.isArray(d) ? d[0] : d) }))
          .catch(() => ({ sym, q: null }))
      )
    );
    const out = {};
    results.forEach(({ sym, q }) => { if (q) out[sym] = q; });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/bars/:symbol?timeframe=1Hour|1Day&limit=N ──────────────────────
// Returns { bars: [{t, o, h, l, c, v}] } via Yahoo Finance (no key needed)
app.get('/api/bars/:symbol', async (req, res) => {
  const symbol    = req.params.symbol.toUpperCase();
  const timeframe = req.query.timeframe || '1Day';
  const limit     = parseInt(req.query.limit) || 60;

  const intervalMap = { '1Hour': '1h', '1Day': '1d', '1Min': '1m', '5Min': '5m', '15Min': '15m' };
  const interval    = intervalMap[timeframe] || '1d';
  const range       = limit <= 7 ? '5d' : limit <= 30 ? '1mo' : limit <= 90 ? '3mo' : limit <= 180 ? '6mo' : '1y';

  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
    const r    = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/historical/:symbol?timeseries=N ─────────────────────────────────
// Returns { historical: [...] } newest-first
app.get('/api/historical/:symbol', async (req, res) => {
  const timeseries = parseInt(req.query.timeseries) || 14;
  try {
    const data = await fmpGet(`/historical-price-full/${req.params.symbol.toUpperCase()}?timeseries=${timeseries}`);
    res.json({ historical: data.historical || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/history/:symbol ─────────────────────────────────────────────────
app.get('/api/history/:symbol', async (req, res) => {
  const timeseries = parseInt(req.query.timeseries) || 14;
  try {
    const data = await fmpGet(`/historical-price-full/${req.params.symbol.toUpperCase()}?timeseries=${timeseries}`);
    res.json({ historical: data.historical || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/news/:symbol ────────────────────────────────────────────────────
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
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/search?q=query ──────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const data    = await fmpGet(`/search?query=${encodeURIComponent(q)}&limit=10&exchange=NASDAQ,NYSE,AMEX`);
    const results = (Array.isArray(data) ? data : []).map(r => ({
      symbol:            r.symbol,
      name:              r.name,
      exchangeShortName: r.exchangeShortName,
    }));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/stock/:symbol ───────────────────────────────────────────────────
app.get('/api/stock/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
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
    } : { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, total: 0 };

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
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/ratings/:symbol ─────────────────────────────────────────────────
app.get('/api/ratings/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data  = await fmpGet(`/analyst-stock-recommendations/${symbol}`);
    const entry = Array.isArray(data) && data[0] ? data[0] : null;
    if (!entry) return res.json({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 });
    res.json({
      strongBuy:  entry.analystRatingsStrongBuy  || 0,
      buy:        entry.analystRatingsbuy         || 0,
      hold:       entry.analystRatingsHold        || 0,
      sell:       entry.analystRatingsSell        || 0,
      strongSell: entry.analystRatingsStrongSell  || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StockPulse backend running on port ${PORT}`);
});
