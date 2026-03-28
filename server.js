const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = 5000;

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

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StockPulse running on port ${PORT}`);
});
