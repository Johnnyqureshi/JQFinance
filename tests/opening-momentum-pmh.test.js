'use strict';
const assert = require('assert');
const { evaluatePmhBreak, evaluatePmhRunnerExit } = require('../lib/opening-momentum-pmh');
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; } }
function valid(overrides = {}) {
  return {
    symbol: 'TEST', freshness: { bars: true, quote: true },
    premarket: { frozen: true, high: 10.5, low: 9.9, volume: 900000 },
    previousDay: { close: 9.8, high: 10.0, low: 9.2 }, openingPrice: 10.1,
    candle: { open: 10.52, high: 10.85, low: 10.5, close: 10.82, volume: 12000 },
    volumeBaseline: { mean: 4000, stdDev: 3000, samples: 10 },
    quote: { price: 10.82, bid: 10.81, ask: 10.83 }, resistance: 11.8,
    market: { available: true, bullish: true }, sector: { available: true, bullish: true },
    relativeStrength: true, atr: .4, ema9: 10.55, ...overrides,
  };
}
console.log('\nOpening Momentum PMH evaluator\n');
test('requires a closed candle above frozen PMH, not a wick', () => {
  const r = evaluatePmhBreak(valid({ candle: { open: 10.45, high: 10.8, low: 10.4, close: 10.49, volume: 12000 } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /Wick-only/.test(x)));
});
test('rejects red rejection candle', () => {
  const r = evaluatePmhBreak(valid({ candle: { open: 10.8, high: 10.85, low: 10.5, close: 10.55, volume: 12000 } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /red/.test(x)));
});
test('blocks stale required evidence', () => {
  const r = evaluatePmhBreak(valid({ freshness: { bars: false, quote: false } }));
  assert.strictEqual(r.status, 'BLOCKED'); assert.strictEqual(r.eligible, false);
});
test('blocks without same-time volume history', () => {
  const r = evaluatePmhBreak(valid({ volumeBaseline: { mean: 4000, stdDev: 1000, samples: 2 } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /baseline/.test(x)));
});
test('blocks a candle with missing volume instead of treating it as zero', () => {
  const r = evaluatePmhBreak(valid({ candle: { open: 10.52, high: 10.85, low: 10.5, close: 10.82, volume: null } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /volume baseline/.test(x)));
});
test('enforces strict opening above previous close and high', () => {
  const r = evaluatePmhBreak(valid({ openingPrice: 10.0 }));
  assert.strictEqual(r.opening.eligible, false); assert.strictEqual(r.eligible, false);
});
test('keeps the frozen PMH opening gate authoritative over supplemental setup context', () => {
  const r = evaluatePmhBreak(valid({
    openingPrice: 10.0,
    priceAction: { eligible: true, setup: { type: 'BREAKOUT_CONTINUATION' } },
  }));
  assert.strictEqual(r.eligible, false);
  assert(r.reasons.some(x => /Opening price must be above/.test(x)));
});
test('uses dollar risk divided by breakout-low distance', () => {
  const r = evaluatePmhBreak(valid());
  assert.strictEqual(r.sizing.method, 'risk'); assert.strictEqual(r.sizing.shares, Math.floor(100 / .32));
});
test('caps risk-sized shares at the configured position limit', () => {
  const r = evaluatePmhBreak(valid(), { maxPositionDollars: 100 });
  assert.strictEqual(r.sizing.shares, Math.floor(100 / 10.82));
  assert(r.sizing.estimatedNotional <= 100);
});
test('score is bounded and resistance can block trade', () => {
  const r = evaluatePmhBreak(valid({ resistance: 10.95 }));
  assert(r.score >= 0 && r.score <= 100); assert.strictEqual(r.eligible, false);
});
test('applies the configured maximum trade price as a hard eligibility gate', () => {
  const r = evaluatePmhBreak(valid({ quote: { price: 15.01, bid: 15, ask: 15.02 } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /trade ceiling/.test(x)));
});
test('runner exits only after a completed failure condition', () => {
  assert.strictEqual(evaluatePmhRunnerExit({ candle: { close: 10.4 }, pmh: 10.5, ema9: 10.45 }).exit, true);
  assert.strictEqual(evaluatePmhRunnerExit({ candle: { close: 10.7 }, pmh: 10.5, ema9: 10.6 }).exit, false);
});
if (failed) process.exitCode = 1;
console.log(`\n${passed} passed, ${failed} failed`);