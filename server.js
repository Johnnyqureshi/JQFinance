require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── KEYS ─────────────────────────────────────────────────────────────────────

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com/stable';

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_API_SECRET;
const ALPACA_DATA   = 'https://data.alpaca.markets/v2';

const alpacaHeaders = {
  'APCA-API-KEY-ID':     ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type':        'application/json',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Transform an FMP quote object into the Alpaca snapshot shape the frontend expects
function fmpToSnapshot(q) {
  if (!q || !q.symbol) return null;
  return {
    latestTrade:  { p: q.price ?? 0 },
    latestQuote:  { ap: q.price ?? 0, bp: q.price ?? 0 },
    prevDailyBar: { c: q.previousClose ?? q.price ?? 0 },
    dailyBar: {
      o:  q.open    ?? q.price ?? 0,
      h:  q.dayHigh ?? q.price ?? 0,
      l:  q.dayLow  ?? q.price ?? 0,
      v:  q.volume  ?? 0,
      vw: q.price   ?? 0,   // FMP has no VWAP; use price as close approximation
    },
  };
}

// US-only exchange filter for search results
const US_EXCHANGES = new Set([
  'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'NYSE MKT',
  'NYSE American', 'BATS', 'CBOE', 'OTC', 'PINK',
]);

// Grade-to-category for analyst ratings tally
function gradeCategory(grade) {
  if (!grade) return 'hold';
  const g = grade.toLowerCase().trim();
  if (['strong buy', 'strong outperform', 'top pick', 'conviction buy'].some(s => g.includes(s))) return 'strongBuy';
  if (!g.includes('strong') && ['sell', 'underperform', 'underweight', 'market underperform', 'reduce', 'negative', 'sector underperform'].some(s => g === s || g.includes(s))) return 'sell';
  if (['strong sell', 'strong underperform'].some(s => g.includes(s))) return 'strongSell';
  if (['buy', 'outperform', 'overweight', 'market outperform', 'accumulate', 'positive', 'sector outperform', 'add'].some(s => g === s || g.includes(s))) return 'buy';
  return 'hold';
}

// ─── /api/snapshots ───────────────────────────────────────────────────────────
// Returns batch price snapshots in Alpaca snapshot shape.
// FMP free plan doesn't support comma-delimited batch quotes, so we fetch each
// symbol individually in parallel (cheap on latency, ~200ms per batch).

app.get('/api/snapshots', async (req, res) => {
  try {
    if (!FMP_API_KEY) return res.status(500).json({ error: 'FMP_API_KEY not configured' });

    const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
    if (symbols.length === 0) return res.json({});

    const results = await Promise.all(
      symbols.map(sym =>
        fetch(`${FMP_BASE}/quote?symbol=${encodeURIComponent(sym)}&apikey=${FMP_API_KEY}`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );

    const out = {};
    results.forEach((data, i) => {
      const sym = symbols[i];
      const q   = Array.isArray(data) ? data[0] : data;
      const snap = fmpToSnapshot(q);
      if (snap) out[sym] = snap;
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/bars/:symbol ────────────────────────────────────────────────────────
// Historical OHLCV bars — tries Alpaca; returns empty array on auth failure

app.get('/api/bars/:symbol', async (req, res) => {
  const symbol    = req.params.symbol.toUpperCase();
  const timeframe = req.query.timeframe || '1Day';
  const limit     = req.query.limit     || 60;

  try {
    const url = `${ALPACA_DATA}/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex&adjustment=raw`;
    const response = await fetch(url, { headers: alpacaHeaders });

    if (response.ok) {
      return res.json(await response.json());
    }

    // Alpaca auth failure — return empty bars so UI degrades gracefully
    if (response.status === 401 || response.status === 403) {
      return res.json({ bars: [], alpaca_error: 'Alpaca API keys invalid or expired' });
    }

    const err = await response.text();
    return res.status(response.status).json({ bars: [], error: err });
  } catch (e) {
    res.json({ bars: [], error: e.message });
  }
});

// ─── /api/quote/:symbol ───────────────────────────────────────────────────────
// Single-symbol snapshot via FMP

app.get('/api/quote/:symbol', async (req, res) => {
  try {
    if (!FMP_API_KEY) return res.status(500).json({ error: 'FMP_API_KEY not configured' });

    const symbol = req.params.symbol.toUpperCase();
    const url = `${FMP_BASE}/quote?symbol=${symbol}&apikey=${FMP_API_KEY}`;
    const response = await fetch(url);

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const quotes = await response.json();
    const q = Array.isArray(quotes) ? quotes[0] : quotes;
    const snap = fmpToSnapshot(q);

    if (!snap) return res.status(404).json({ error: 'Symbol not found' });
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/news/:symbol ────────────────────────────────────────────────────────
// Market news from FMP articles, filtered by ticker when possible

app.get('/api/news/:symbol', async (req, res) => {
  try {
    if (!FMP_API_KEY) return res.json({ news: [] });

    const symbol = req.params.symbol.toUpperCase();

    // Fetch a larger batch so we have enough after filtering
    const url = `${FMP_BASE}/fmp-articles?page=0&size=50&apikey=${FMP_API_KEY}`;
    const response = await fetch(url);

    if (!response.ok) return res.json({ news: [] });

    const articles = await response.json();
    if (!Array.isArray(articles)) return res.json({ news: [] });

    // Filter to articles that mention this symbol in the tickers field
    const relevant = articles.filter(a => {
      if (!a.tickers) return false;
      const tickers = a.tickers.split(',').map(t => t.trim().toUpperCase());
      return tickers.includes(symbol);
    });

    // Fall back to most recent articles if none are symbol-specific
    const source = relevant.length >= 3 ? relevant : articles;

    const news = source.slice(0, 10).map(a => ({
      headline:   a.title   || '',
      url:        a.link    || '#',
      source:     a.site    || 'FMP',
      created_at: a.date    || new Date().toISOString(),
      summary:    a.content ? a.content.slice(0, 200) : '',
    }));

    res.json({ news });
  } catch (e) {
    res.json({ news: [] });
  }
});

// ─── /api/search ──────────────────────────────────────────────────────────────
// Symbol + name search via FMP, filtered to US-listed equities

app.get('/api/search', async (req, res) => {
  try {
    if (!FMP_API_KEY) return res.json([]);

    const query = (req.query.q || '').trim();
    if (!query) return res.json([]);

    const url = `${FMP_BASE}/search-name?query=${encodeURIComponent(query)}&limit=50&apikey=${FMP_API_KEY}`;
    const response = await fetch(url);

    if (!response.ok) return res.json([]);

    const results = await response.json();
    if (!Array.isArray(results)) return res.json([]);

    const filtered = results
      .filter(r => {
        if (!r.symbol || !r.exchange) return false;
        // Keep US exchanges only, exclude symbols with dots (foreign listings)
        return US_EXCHANGES.has(r.exchange) && !r.symbol.includes('.');
      })
      .slice(0, 20)
      .map(r => ({ symbol: r.symbol, name: r.name || r.symbol }));

    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/stock/:ticker ───────────────────────────────────────────────────────
// Analyst ratings + price targets + upgrades from FMP

app.get('/api/stock/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();

  if (!FMP_API_KEY) {
    return res.status(500).json({ error: 'FMP_API_KEY not configured' });
  }

  try {
    const [gradesRes, targetRes] = await Promise.all([
      fetch(`${FMP_BASE}/grades?symbol=${ticker}&limit=50&apikey=${FMP_API_KEY}`),
      fetch(`${FMP_BASE}/price-target-consensus?symbol=${ticker}&apikey=${FMP_API_KEY}`),
    ]);

    // ── Analyst ratings ──
    let ratings  = null;
    let upgrades = [];

    if (gradesRes.ok) {
      const raw  = await gradesRes.json();
      const list = Array.isArray(raw) ? raw : [];

      upgrades = list.slice(0, 10).map(u => ({
        date:          u.date           ?? null,
        gradingCompany: u.gradingCompany ?? null,
        action:        u.action         ?? null,
        previousGrade: u.previousGrade  ?? null,
        newGrade:      u.newGrade       ?? null,
      }));

      const counts = { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 };
      list.forEach(g => { counts[gradeCategory(g.newGrade)]++; });

      const total   = Object.values(counts).reduce((a, b) => a + b, 0);
      const bullish = counts.strongBuy + counts.buy;
      const bearish = counts.sell      + counts.strongSell;
      let consensus = 'N/A';
      if (total > 0) {
        if (bullish / total > 0.6)      consensus = 'Strong Buy';
        else if (bullish / total > 0.4) consensus = 'Buy';
        else if (bearish / total > 0.4) consensus = 'Sell';
        else                             consensus = 'Hold';
      }
      ratings = { ...counts, total, consensus };
    }

    // ── Price target consensus ──
    let priceTarget = null;
    if (targetRes.ok) {
      const raw  = await targetRes.json();
      const item = Array.isArray(raw) ? raw[0] : raw;
      if (item && Object.keys(item).length > 0) {
        priceTarget = {
          targetHigh:       item.targetHigh       ?? item.priceTargetHigh    ?? null,
          targetLow:        item.targetLow        ?? item.priceTargetLow     ?? null,
          targetMedian:     item.targetMedian     ?? item.priceTargetMedian  ?? null,
          targetMean:       item.targetMean       ?? item.priceTargetAverage ?? null,
          numberOfAnalysts: item.numberOfAnalysts ?? null,
          lastUpdated:      item.lastUpdated      ?? null,
        };
      }
    }

    res.json({ symbol: ticker, ratings, priceTarget, upgrades });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/historical/:symbol ─────────────────────────────────────────────────
// OHLCV daily history via Yahoo Finance chart API (free, no key required).
// Returns { symbol, historical: [...] } newest-first, matching FMP's shape.

app.get('/api/historical/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2mo`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockPulse/1.0)' },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Yahoo Finance returned ${response.status}` });
    }

    const data  = await response.json();
    const result = data?.chart?.result?.[0];

    if (!result) return res.status(404).json({ error: 'Symbol not found' });

    const timestamps = result.timestamp         || [];
    const quote      = result.indicators?.quote?.[0] || {};
    const opens      = quote.open   || [];
    const highs      = quote.high   || [];
    const lows       = quote.low    || [];
    const closes     = quote.close  || [];
    const volumes    = quote.volume || [];

    // Build newest-first array (Yahoo is oldest-first)
    const historical = timestamps
      .map((ts, i) => ({
        date:   new Date(ts * 1000).toISOString().slice(0, 10),
        open:   opens[i]   ?? null,
        high:   highs[i]   ?? null,
        low:    lows[i]    ?? null,
        close:  closes[i]  ?? null,
        volume: volumes[i] ?? null,
      }))
      .filter(d => d.close !== null)
      .reverse(); // newest first

    res.json({ symbol, historical });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FALLBACK ──────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StockPulse running on port ${PORT}`);
});
