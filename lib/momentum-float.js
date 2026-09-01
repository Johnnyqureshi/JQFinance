'use strict';

function normalizeYahooFloatSummary(summary) {
  const stats = summary?.defaultKeyStatistics || {};
  const detail = summary?.summaryDetail || {};
  const floatShares = Number.isFinite(stats.floatShares) ? stats.floatShares : null;
  const sharesOutstanding = Number.isFinite(stats.sharesOutstanding)
    ? stats.sharesOutstanding
    : Number.isFinite(detail.sharesOutstanding) ? detail.sharesOutstanding : null;

  return {
    float: floatShares ?? sharesOutstanding,
    floatShares,
    sharesOutstanding,
    floatSource: floatShares != null
      ? 'floatShares'
      : sharesOutstanding != null ? 'sharesOutstanding' : null,
  };
}

function scannerFloatFields(fundamentals = {}, quote = {}) {
  const canonicalFloat = fundamentals.float ?? quote.floatShares ?? null;
  return {
    float: canonicalFloat,
    floatSh: canonicalFloat,
    floatShares: fundamentals.floatShares ?? quote.floatShares ?? null,
    sharesOutstanding: fundamentals.sharesOutstanding ?? null,
    floatSource: fundamentals.float != null
      ? fundamentals.floatSource
      : quote.floatShares != null ? 'quote' : null,
  };
}

async function fetchMomentumQuoteWithFloat(symbol, { fetchQuote, fetchFloatData }) {
  const [quote, fundamentals] = await Promise.all([
    fetchQuote(symbol),
    fetchFloatData(symbol),
  ]);
  return { ...quote, ...scannerFloatFields(fundamentals, quote) };
}

function momentumRowFromQuote(symbol, quote, config) {
  const price = Number(quote?.regularMarketPrice);
  const change = Number(quote?.regularMarketChangePercent ?? 0);
  const volume = Number(quote?.regularMarketVolume ?? 0);
  const averageVolume = Number(quote?.averageDailyVolume3Month ?? quote?.averageDailyVolume10Day ?? 0);
  const relVol = averageVolume > 0 ? volume / averageVolume : null;
  const canonicalFloat = Number(quote?.float ?? quote?.floatSh ?? quote?.floatShares);
  const floatShares = Number.isFinite(canonicalFloat) && canonicalFloat > 0 ? canonicalFloat : null;
  const row = { symbol, price, change, volume, relVol, floatShares };

  if (!(price >= config.minPrice && price <= config.maxPrice)) return { eligible: false, reason: 'price outside configured range', row };
  if (!(change >= config.minGainPercent)) return { eligible: false, reason: 'daily momentum below threshold', row };
  if (!(volume >= config.minVolume)) return { eligible: false, reason: 'absolute volume below threshold', row };
  if (!(relVol >= config.minRelVol)) return { eligible: false, reason: 'relative volume below threshold', row };
  if (row.floatShares != null && row.floatShares > config.maxFloat) return { eligible: false, reason: 'float above configured maximum', row };

  let score = 0;
  if (change >= 2) score++;
  if (change >= 10) score++;
  if (change >= 30) score++;
  if (relVol >= 1.5) score++;
  if (relVol >= 5) score++;
  if (row.floatShares != null && row.floatShares < 5_000_000) score++;
  return { eligible: score >= config.minScore, reason: score >= config.minScore ? null : 'scanner score below threshold', row: { ...row, score } };
}

module.exports = {
  normalizeYahooFloatSummary,
  scannerFloatFields,
  fetchMomentumQuoteWithFloat,
  momentumRowFromQuote,
};
