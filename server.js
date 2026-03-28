require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = 5000;

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE = 'https://financialmodelingprep.com/stable';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_API_SECRET;
const ALPACA_DATA_URL = 'https://data.alpaca.markets/v2';
const ALPACA_BROKER_URL = 'https://paper-api.alpaca.markets/v2';

const alpacaHeaders = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json'
};

const FEED_SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN',
  'META', 'GOOGL', 'AMD', 'NFLX', 'PYPL',
  'JPM', 'BAC', 'GS', 'V', 'MA',
  'SPY', 'QQQ', 'DIA', 'IWM', 'GLD'
];

app.get('/api/snapshots', async (req, res) => {
  try {
    const symbols = (req.query.symbols || FEED_SYMBOLS.join(',')).toUpperCase();
    const url = `${ALPACA_DATA_URL}/stocks/snapshots?symbols=${symbols}&feed=iex`;
    const response = await fetch(url, { headers: alpacaHeaders });
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bars/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const timeframe = req.query.timeframe || '1Day';
    const limit = req.query.limit || 60;
    const url = `${ALPACA_DATA_URL}/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex&adjustment=raw`;
    const response = await fetch(url, { headers: alpacaHeaders });
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const url = `${ALPACA_DATA_URL}/stocks/${symbol}/snapshot?feed=iex`;
    const response = await fetch(url, { headers: alpacaHeaders });
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/news/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const url = `https://data.alpaca.markets/v1beta1/news?symbols=${symbol}&limit=10`;
    const response = await fetch(url, { headers: alpacaHeaders });
    if (!response.ok) {
      return res.json({ news: [] });
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    const url = `${ALPACA_BROKER_URL}/assets?status=active&asset_class=us_equity`;
    const response = await fetch(url, { headers: alpacaHeaders });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch assets' });
    }
    const assets = await response.json();
    const filtered = assets
      .filter(a => a.tradable && (
        a.symbol.toUpperCase().includes(query.toUpperCase()) ||
        (a.name && a.name.toUpperCase().includes(query.toUpperCase()))
      ))
      .slice(0, 20)
      .map(a => ({ symbol: a.symbol, name: a.name }));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Grade → category mapping for analyst ratings tally
function gradeCategory(grade) {
  if (!grade) return 'hold';
  const g = grade.toLowerCase().trim();
  if (['strong buy','strong outperform','top pick','conviction buy'].some(s => g.includes(s))) return 'strongBuy';
  if (['buy','outperform','overweight','market outperform','accumulate','positive','sector outperform','add'].some(s => g === s || g.includes(s))) return 'buy';
  if (['sell','underperform','underweight','market underperform','reduce','negative','sector underperform'].some(s => g === s || g.includes(s)) && !g.includes('strong')) return 'sell';
  if (['strong sell','strong underperform'].some(s => g.includes(s))) return 'strongSell';
  return 'hold'; // neutral/hold/market perform/peer perform/equal-weight/in-line
}

app.get('/api/stock/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();

  if (!FMP_API_KEY) {
    return res.status(500).json({ error: 'FMP_API_KEY not configured' });
  }

  try {
    const [gradesRes, targetRes] = await Promise.all([
      fetch(`${FMP_BASE}/grades?symbol=${ticker}&limit=50&apikey=${FMP_API_KEY}`),
      fetch(`${FMP_BASE}/price-target-consensus?symbol=${ticker}&apikey=${FMP_API_KEY}`)
    ]);

    // ── Analyst ratings — computed from recent grade history (last 50 entries) ──
    let ratings = null;
    let upgrades = [];

    if (gradesRes.ok) {
      const raw = await gradesRes.json();
      const list = Array.isArray(raw) ? raw : [];

      // Latest 10 entries → upgrades/downgrades table
      upgrades = list.slice(0, 10).map(u => ({
        date:      u.date      ?? null,
        firm:      u.gradingCompany ?? null,
        action:    u.action    ?? null,
        fromGrade: u.previousGrade ?? null,
        toGrade:   u.newGrade  ?? null,
      }));

      // Tally all 50 entries → ratings distribution
      const counts = { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 };
      list.forEach(g => {
        const cat = gradeCategory(g.newGrade);
        counts[cat]++;
      });
      const total = counts.strongBuy + counts.buy + counts.hold + counts.sell + counts.strongSell;
      const bullish = counts.strongBuy + counts.buy;
      const bearish = counts.sell + counts.strongSell;
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
      const raw = await targetRes.json();
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

    res.json({
      symbol:      ticker,
      ratings,
      priceTarget,
      upgrades,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StockPulse running on port ${PORT}`);
});
