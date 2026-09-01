'use strict';

const assert = require('assert');
const {
  normalizeYahooFloatSummary,
  scannerFloatFields,
  fetchMomentumQuoteWithFloat,
  momentumRowFromQuote,
} = require('../lib/momentum-float');

const baseQuote = {
  regularMarketPrice: 5,
  regularMarketChangePercent: 12,
  regularMarketVolume: 2_000_000,
  averageDailyVolume3Month: 1_000_000,
};
const config = {
  minPrice: 1,
  maxPrice: 100,
  minGainPercent: 2,
  minVolume: 100_000,
  minRelVol: 1.5,
  minScore: 0,
  maxFloat: 10_000_000,
};

function scannerResult(summary, quote = baseQuote) {
  return { ...quote, ...scannerFloatFields(normalizeYahooFloatSummary(summary), quote) };
}

(async () => {
  const preferred = scannerResult({
    defaultKeyStatistics: { floatShares: 4_000_000, sharesOutstanding: 14_000_000 },
  });
  assert.strictEqual(preferred.float, 4_000_000);
  assert.strictEqual(preferred.floatSource, 'floatShares');
  assert.strictEqual(momentumRowFromQuote('FLOAT', preferred, config).row.score, 4);

  const fallbackSummary = {
    defaultKeyStatistics: { sharesOutstanding: 4_500_000 },
  };
  const fallback = scannerResult(fallbackSummary);
  assert.strictEqual(fallback.float, 4_500_000);
  assert.strictEqual(fallback.floatSource, 'sharesOutstanding');
  assert.strictEqual(momentumRowFromQuote('FALLBACK', fallback, config).eligible, true);

  const scheduledFallback = await fetchMomentumQuoteWithFloat('FALLBACK', {
    fetchQuote: async () => ({ ...baseQuote }),
    fetchFloatData: async () => normalizeYahooFloatSummary(fallbackSummary),
  });
  assert.strictEqual(scheduledFallback.float, 4_500_000);
  assert.strictEqual(scheduledFallback.floatSource, 'sharesOutstanding');
  const scheduledScore = momentumRowFromQuote('FALLBACK', scheduledFallback, config);
  assert.strictEqual(scheduledScore.eligible, true);
  assert.strictEqual(scheduledScore.row.score, 4);

  const aboveCeilingSummary = {
    summaryDetail: { sharesOutstanding: 11_000_000 },
  };
  const aboveCeiling = await fetchMomentumQuoteWithFloat('CEILING', {
    fetchQuote: async () => ({ ...baseQuote }),
    fetchFloatData: async () => normalizeYahooFloatSummary(aboveCeilingSummary),
  });
  assert.strictEqual(aboveCeiling.float, 11_000_000);
  assert.strictEqual(aboveCeiling.floatSource, 'sharesOutstanding');
  assert.strictEqual(momentumRowFromQuote('CEILING', aboveCeiling, config).eligible, false);
  assert.strictEqual(momentumRowFromQuote('CEILING', aboveCeiling, config).reason, 'float above configured maximum');

  const missing = scannerResult({ defaultKeyStatistics: {}, summaryDetail: {} });
  assert.strictEqual(missing.float, null);
  assert.strictEqual(missing.floatSource, null);
  assert.strictEqual(momentumRowFromQuote('MISSING', missing, config).row.floatShares, null);

  console.log('✓ Yahoo float canonicalization, scanner exposure, scoring, and ceiling');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
