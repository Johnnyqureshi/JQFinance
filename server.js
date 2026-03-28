require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');

const app = express();
const PORT = 5000;
const FMP_KEY = process.env.FMP_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── GET /api/quote/:ticker ────────────────────────────────────────────────────
app.get('/api/quote/:ticker', async (req, res) => {
  const { ticker } = req.params;
  try {
    const url = `https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).json({ error: 'FMP error' });

    const data = await response.json();
    const q = Array.isArray(data) ? data[0] : data;
    if (!q || !q.symbol) return res.status(404).json({ error: 'Ticker not found' });

    res.json({
      price:             q.price,
      change:            q.change,
      changesPercentage: q.changesPercentage,
      volume:            q.volume,
      avgVolume:         q.avgVolume,
      dayHigh:           q.dayHigh,
      dayLow:            q.dayLow,
      open:              q.open,
      previousClose:     q.previousClose,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/history/:ticker ──────────────────────────────────────────────────
app.get('/api/history/:ticker', async (req, res) => {
  const { ticker } = req.params;
  try {
    const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?timeseries=14&apikey=${FMP_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).json({ error: 'FMP error' });

    const data = await response.json();
    res.json({ historical: data.historical || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/ratings/:ticker ──────────────────────────────────────────────────
app.get('/api/ratings/:ticker', async (req, res) => {
  const { ticker } = req.params;
  try {
    const url = `https://financialmodelingprep.com/api/v3/analyst-stock-recommendations/${ticker}?apikey=${FMP_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).json({ error: 'FMP error' });

    const data = await response.json();
    const entry = Array.isArray(data) && data.length > 0 ? data[0] : null;

    if (!entry) return res.json({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 });

    res.json({
      strongBuy:  entry.analystRatingsStrongBuy  || 0,
      buy:        entry.analystRatingsbuy        || 0,
      hold:       entry.analystRatingsHold       || 0,
      sell:       entry.analystRatingsSell       || 0,
      strongSell: entry.analystRatingsStrongSell || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StockPulse backend running on port ${PORT}`);
});
