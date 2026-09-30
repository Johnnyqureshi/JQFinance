'use strict';

// Flipper wall calculator tests — range extraction, flip-swing selection with
// gap enforcement, null flips, and determinism. node:test style.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { computeWalls, DEFAULT_FLIPPER_RULES } = require('../lib/flipper/walls');

// --- fixture builders -------------------------------------------------------
// ET trading days in September 2026 (weekdays only).
const DATES = [
  '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07',
  '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14',
  '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21',
  '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28',
];
const TRADE_DATE = '2026-09-29';

// A daily bar at 14:30 ET on the given date (t = ms epoch).
function bar(date, o, h, l, c, v = 1000000) {
  return { t: Date.parse(`${date}T14:30:00-04:00`), o, h, l, c, v };
}

// History: 19 flat days (h=9.50, l=9.00) with four planted fractal swings
// (swingLookback=3, so each swing needs 3 lower/higher bars on each side):
//   high swing B (far):  idx 5  h=10.20  (gap 2.0% above rangeHigh)
//   high swing A (near): idx 15 h=10.05  (gap 0.5% — fails the 1% gap)
//   low swing B (far):   idx 9  l=9.30   (gap 2.1% below rangeLow)
//   low swing A (near):  idx 13 l=9.45   (gap 0.53% — fails the 1% gap)
// Yesterday (idx 19): rangeHigh=10.00, rangeLow=9.50.
function fixtureBars() {
  const bars = DATES.map(d => bar(d, 9.40, 9.50, 9.00, 9.42));
  const setH = (idxs, h) => idxs.forEach(i => { bars[i].h = h; });
  const setL = (idxs, l) => idxs.forEach(i => { bars[i].l = l; });
  // high swing B at idx 5
  bars[5].h = 10.20; setH([2, 3, 4, 6, 7, 8], 9.60);
  // low swing B at idx 9
  bars[9].l = 9.30; setL([6, 7, 8, 10, 11, 12], 9.60);
  // high swing A at idx 15
  bars[15].h = 10.05; setH([12, 13, 14, 16, 17, 18], 9.60);
  // low swing A at idx 13
  bars[13].l = 9.45; setL([10, 11, 12, 14, 15, 16], 9.60);
  // yesterday
  Object.assign(bars[19], { o: 9.60, h: 10.00, l: 9.50, c: 9.80 });
  return bars;
}

test('range high/low come from the last daily bar before the trade date', () => {
  const walls = computeWalls({ symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: fixtureBars() });
  assert.equal(walls.symbol, 'TEST');
  assert.equal(walls.tradeDate, TRADE_DATE);
  assert.equal(walls.rangeHigh, 10.00);
  assert.equal(walls.rangeLow, 9.50);
});

test('yesterday is the last bar strictly before tradeDate, not an intraday bar for today', () => {
  const bars = fixtureBars();
  bars.push(bar(TRADE_DATE, 9.70, 9.75, 9.68, 9.72)); // today's partial daily bar
  const walls = computeWalls({ symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: bars });
  assert.equal(walls.rangeHigh, 10.00);
  assert.equal(walls.rangeLow, 9.50);
});

test('flip high = nearest qualifying swing above rangeHigh; nearer swing failing the gap is skipped', () => {
  const walls = computeWalls({ symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: fixtureBars() });
  // idx 15 (10.05, gap 0.5%) is nearer but fails the 1% gap; idx 5 (10.20, gap 2%) qualifies.
  assert.equal(walls.flipHigh, 10.20);
});

test('flip low = nearest qualifying swing below rangeLow; nearer swing failing the gap is skipped', () => {
  const walls = computeWalls({ symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: fixtureBars() });
  // idx 13 (9.45, gap 0.53%) is nearer but fails the 1% gap; idx 9 (9.30, gap 2.1%) qualifies.
  assert.equal(walls.flipLow, 9.30);
});

test('flip walls are null when no qualifying swing exists', () => {
  const flat = DATES.map(d => bar(d, 9.40, 9.50, 9.00, 9.42));
  Object.assign(flat[19], { o: 9.60, h: 10.00, l: 9.50, c: 9.80 });
  const walls = computeWalls({ symbol: 'FLAT', tradeDate: TRADE_DATE, dailyBars: flat });
  assert.equal(walls.rangeHigh, 10.00);
  assert.equal(walls.rangeLow, 9.50);
  assert.equal(walls.flipHigh, null);
  assert.equal(walls.flipLow, null);
});

test('a swing exactly on the wrong side of the range wall is ignored', () => {
  const bars = fixtureBars();
  // A big swing high that sits BELOW the range high must not become flipHigh.
  bars[11].h = 9.90;
  const walls = computeWalls({ symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: bars });
  assert.equal(walls.flipHigh, 10.20);
});

test('computeWalls is deterministic: identical inputs produce identical walls', () => {
  const bars = fixtureBars();
  const a = computeWalls({ symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: bars });
  const b = computeWalls({ symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: fixtureBars() });
  assert.deepEqual(a, b);
});

test('rules overrides are honoured (e.g. tighter gap)', () => {
  const walls = computeWalls({
    symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: fixtureBars(),
    rules: { flipGapPct: 0.4 }, // the nearer swings (0.5% / 0.53%) now qualify
  });
  assert.equal(walls.flipHigh, 10.05);
  assert.equal(walls.flipLow, 9.45);
});

test('flip search is capped by flipLookbackBars', () => {
  const walls = computeWalls({
    symbol: 'TEST', tradeDate: TRADE_DATE, dailyBars: fixtureBars(),
    rules: { flipLookbackBars: 4 }, // only the 4 bars before yesterday: idx 15..18
  });
  // idx 15 (10.05) is visible but fails the 1% gap; idx 5 is out of range.
  assert.equal(walls.flipHigh, null);
  assert.equal(walls.flipLow, null); // idx 13 is out of range too
});

test('local DEFAULT_FLIPPER_RULES matches the pinned contract values', () => {
  assert.equal(DEFAULT_FLIPPER_RULES.swingLookback, 3);
  assert.equal(DEFAULT_FLIPPER_RULES.flipGapPct, 1.0);
  assert.equal(DEFAULT_FLIPPER_RULES.flipLookbackBars, 120);
  assert.equal(DEFAULT_FLIPPER_RULES.wallTolerancePct, 0.15);
  assert.equal(DEFAULT_FLIPPER_RULES.minC1MovePct, 0.75);
  assert.equal(DEFAULT_FLIPPER_RULES.breakoutCancelPct, 0.25);
  assert.equal(DEFAULT_FLIPPER_RULES.minPrice, 1);
  assert.equal(DEFAULT_FLIPPER_RULES.maxPrice, 20);
});

test('throws when there is no daily bar before the trade date', () => {
  assert.throws(
    () => computeWalls({ symbol: 'X', tradeDate: '2026-09-01', dailyBars: [bar('2026-09-01', 1, 2, 0.5, 1.5)] }),
    /no daily bar before tradeDate/
  );
});
