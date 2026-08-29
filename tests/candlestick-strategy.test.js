'use strict';

const assert = require('assert');
const { evaluateCandlestickSetup, simulateCandlestickBacktest } = require('../lib/candlestick-strategy');

let passed = 0; let failed = 0;
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); failed++; } }
let stamp = Date.UTC(2024, 0, 2, 14, 30);
function bar(o, c, v = 1000) { stamp += 300000; return { o, c, h: Math.max(o, c) + .08, l: Math.min(o, c) - .08, v, t: new Date(stamp).toISOString() }; }
function input(bars, extra = {}) {
  return { symbol: 'TEST', bars, timeframes: { primary: { bars, fresh: true }, higher: { bars: bars.slice(0, -1), fresh: true } }, ...extra };
}
function rising() { return Array.from({ length: 20 }, (_, i) => bar(10 + i * .03, 10.02 + i * .03)); }
function falling() { return Array.from({ length: 20 }, (_, i) => bar(12 - i * .03, 11.98 - i * .03)); }

console.log('\nCandlestick automation\n');
test('makes a confirmed long setup eligible', () => {
  const bars = rising(); bars.push(bar(10.48, 10.9, 2200), bar(10.91, 11.02, 1600));
  const result = evaluateCandlestickSetup(input(bars));
  assert.strictEqual(result.direction, 'LONG'); assert.strictEqual(result.eligible, true);
});
test('makes a confirmed short setup eligible', () => {
  const bars = falling(); bars.push(bar(11.42, 10.98, 2200), bar(10.97, 10.85, 1600));
  const result = evaluateCandlestickSetup(input(bars));
  assert.strictEqual(result.direction, 'SHORT'); assert.strictEqual(result.eligible, true);
});
test('fails closed for stale or absent multi-timeframe data', () => {
  const result = evaluateCandlestickSetup({ symbol: 'X', bars: rising(), freshness: { fresh: false } });
  assert.strictEqual(result.eligible, false); assert(result.reasons.some(reason => /multi-timeframe|fresh/i.test(reason)));
});
test('always bounds score from zero through one hundred', () => {
  const result = evaluateCandlestickSetup(input(rising().concat([bar(10.7, 11.5, 9000), bar(11.6, 11.8, 5000)])));
  assert(result.score >= 0 && result.score <= 100);
});
test('rejects choppy patterns without a high-strength breakout', () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(10 + (i % 2 ? .03 : -.03), 10 + (i % 2 ? -.01 : .01)));
  bars.push(bar(10.0, 10.08, 1300), bar(10.09, 10.16, 1200));
  const result = evaluateCandlestickSetup(input(bars));
  assert.strictEqual(result.eligible, false); assert(result.reasons.some(reason => /choppy|neutral/i.test(reason)));
});
test('a bullish pattern score cannot make a long below VWAP eligible', () => {
  const bars = rising();
  bars.push(bar(10.48, 10.9, 2200), bar(10.91, 11.02, 1600));
  const result = evaluateCandlestickSetup(input(bars, { support: 1, resistance: 10.7 }));
  // Force session VWAP above the signal by adding a large-volume high-price
  // completed bar to the historical evidence, while preserving the long pattern.
  const altered = bars.map((item, index) => index === 0 ? { ...item, o:20, h:20.1, l:19.9, c:20, v:1_000_000 } : item);
  const blocked = evaluateCandlestickSetup(input(altered));
  assert.strictEqual(blocked.direction, 'LONG');
  assert.strictEqual(blocked.eligible, false);
  assert(blocked.reasons.some(reason => /VWAP/i.test(reason)));
});
test('backtest records use only later bars for outcomes', () => {
  const bars = rising(); bars.push(bar(10.48, 10.9, 2200), bar(10.91, 11.02, 1600), bar(11.03, 11.4, 1600));
  const result = simulateCandlestickBacktest(input(bars));
  assert(result.records.length > 0);
  result.records.forEach(record => {
    assert.strictEqual(record.decisionBarCount, record.decisionIndex + 1);
    assert(record.outcomeStartIndex > record.decisionIndex);
    if (record.exitIndex !== null) assert(record.exitIndex >= record.outcomeStartIndex);
  });
});
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);