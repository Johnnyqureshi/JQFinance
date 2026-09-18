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

module.exports = { normalizeYahooFloatSummary, scannerFloatFields };
