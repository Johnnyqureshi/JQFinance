'use strict';

const assert = require('assert');
const {
  calculateRegularSessionVwap,
  isFreshQuoteTimestamp,
  regularSessionBars,
  regularSessionWindow,
} = require('../lib/intraday-vwap');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    failed++;
  }
}

const bar = (t, price, volume) => ({ t, o: price, h: price, l: price, c: price, v: volume });

console.log('\nIntraday VWAP safety');

test('uses the regular New York session across daylight saving time', () => {
  const summer = regularSessionWindow(new Date('2026-08-25T15:00:00.000Z'));
  const winter = regularSessionWindow(new Date('2026-01-06T15:00:00.000Z'));
  assert.strictEqual(summer.start.toISOString(), '2026-08-25T13:30:00.000Z');
  assert.strictEqual(winter.start.toISOString(), '2026-01-06T14:30:00.000Z');
});

test('excludes prior-day, premarket, and after-hours bars from VWAP', () => {
  const now = new Date('2026-08-25T15:00:00.000Z'); // 11:00 AM ET
  const bars = [
    bar('2026-08-24T19:55:00.000Z', 1, 50_000),
    bar('2026-08-25T13:25:00.000Z', 100, 50_000),
    bar('2026-08-25T13:30:00.000Z', 10, 100),
    bar('2026-08-25T13:35:00.000Z', 12, 300),
    bar('2026-08-25T20:00:00.000Z', 200, 50_000),
  ];
  assert.deepStrictEqual(regularSessionBars(bars, now).map(row => row.c), [10, 12]);
  assert.strictEqual(calculateRegularSessionVwap(bars, now), 11.5);
});

test('fails closed when a quote timestamp is absent, stale, or implausibly future-dated', () => {
  const now = new Date('2026-08-25T15:00:00.000Z');
  assert.strictEqual(isFreshQuoteTimestamp('2026-08-25T14:59:50.000Z', now), true);
  assert.strictEqual(isFreshQuoteTimestamp('2026-08-25T14:59:30.000Z', now), false);
  assert.strictEqual(isFreshQuoteTimestamp(null, now), false);
  assert.strictEqual(isFreshQuoteTimestamp('2026-08-25T15:00:10.000Z', now), false);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);