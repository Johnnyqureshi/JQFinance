'use strict';
// Provider adapter. Official Cboe JSON is opt-in; Yahoo is a clearly labelled fallback.
const fetch = require('node-fetch');
const yahooChart = async (symbol, range = '2y') => {
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`, { headers: { 'User-Agent': 'VixionBot/1.0' }, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`Yahoo chart ${symbol} returned ${response.status}`);
  const result = (await response.json())?.chart?.result?.[0], quote = result?.indicators?.quote?.[0] || {};
  return (result?.timestamp || []).map((t, i) => ({ t: new Date(t * 1000).toISOString(), c: quote.close?.[i] })).filter(x => Number.isFinite(x.c));
};
async function acquireMarketData() {
  const generatedAt = new Date().toISOString(), official = process.env.CBOE_DATA_API_URL;
  let officialError = null;
  if (official) {
    try {
      const response = await fetch(official, { headers: { Accept: 'application/json', ...(process.env.CBOE_DATA_API_KEY ? { Authorization: `Bearer ${process.env.CBOE_DATA_API_KEY}` } : {}) }, signal: AbortSignal.timeout(Number(process.env.VOLATILITY_TIMEOUT_MS || 7000)) });
      if (!response.ok) throw new Error(`Cboe API returned ${response.status}`);
      const payload = await response.json();
      return { ...payload, source: 'Official Cboe JSON API', generatedAt, timestamp: payload.timestamp || generatedAt, status: 'LIVE' };
    } catch (error) {
      officialError = error.message;
    }
  }
  const symbols = { vix: '^VIX', vix9d: '^VIX9D', vix3m: '^VIX3M', vix6m: '^VIX6M', vix1y: '^VIX1Y', vvix: '^VVIX', spy: 'SPY' };
  const result = await Promise.allSettled(Object.entries(symbols).map(async ([key, symbol]) => [key, await yahooChart(symbol)]));
  const histories = Object.fromEntries(result.filter(x => x.status === 'fulfilled').map(x => x.value));
  const sourceTimestamps = Object.values(histories).map(rows => rows?.at(-1)?.t).filter(Boolean);
  const timestamp = sourceTimestamps.sort().at(-1) || null;
  return {
    histories,
    source: 'Yahoo Finance fallback for Cboe-listed indices (not official Cboe)',
    generatedAt,
    timestamp,
    status: histories.vix?.length ? 'FALLBACK' : 'UNAVAILABLE',
    ...(officialError ? { officialProviderError: officialError } : {}),
  };
}
module.exports = { acquireMarketData, yahooChart };