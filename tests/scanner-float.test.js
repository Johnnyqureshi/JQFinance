'use strict';
const assert = require('node:assert/strict');
const { normalizeYahooFloatSummary, scannerFloatFields } = require('../lib/scanner-float');

const measured = normalizeYahooFloatSummary({
  defaultKeyStatistics: { floatShares: 4_000_000, sharesOutstanding: 8_000_000 },
});
assert.equal(measured.float, 4_000_000);
assert.equal(measured.floatSource, 'floatShares');
const fallback = normalizeYahooFloatSummary({ summaryDetail: { sharesOutstanding: 8_000_000 } });
assert.equal(fallback.float, 8_000_000);
assert.equal(fallback.floatSource, 'sharesOutstanding');
assert.equal(normalizeYahooFloatSummary({}).float, null);
assert.equal(scannerFloatFields(measured).floatSh, 4_000_000);
assert.equal(scannerFloatFields({}, { floatShares: 100 }).floatSource, 'quote');
console.log('scanner float tests passed');