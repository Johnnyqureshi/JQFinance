'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchFibonacci } = require('../lib/search-fibonacci');

function bar(day, high, low, close) {
  return { t: `2026-07-${String(day).padStart(2, '0')}`, o: close, h: high, l: low, c: close };
}

test('maps bullish swing retracements from high back toward low', () => {
  const bars = [
    bar(1, 102, 100, 101), bar(2, 103, 101, 102), bar(3, 104, 102, 103),
    bar(4, 103, 101, 102), bar(5, 102, 100, 101), bar(6, 104, 102, 103),
    bar(7, 108, 104, 107), bar(8, 112, 108, 111), bar(9, 110, 107, 109),
    bar(10, 109, 106, 108), bar(11, 108, 105, 107), bar(12, 109, 106, 108),
  ];
  const result = buildSearchFibonacci({ dailyBars: bars, currentPrice: 108 });
  assert.equal(result.available, true);
  assert.equal(result.swing.direction, 'BULLISH');
  assert.equal(result.levels.length, 5);
  assert.equal(result.levels[0].price > result.levels.at(-1).price, true);
  assert.equal(result.methodology.includes('not a standalone'), true);
});

test('fails safely without enough completed history', () => {
  const result = buildSearchFibonacci({
    dailyBars: [bar(1, 102, 100, 101)],
    currentPrice: 101,
  });
  assert.equal(result.available, false);
});

test('keeps Fibonacci contribution bounded', () => {
  const bars = Array.from({ length: 20 }, (_, index) =>
    bar(index + 1, 101 + index, 99 + index, 100 + index));
  const result = buildSearchFibonacci({ dailyBars: bars, currentPrice: 125 });
  assert.equal(result.available, true);
  assert.equal(result.confluenceScore <= 10, true);
});
test('nearest support/resistance price always pairs with its own level-list ratio', () => {
  // Regression lock: the UI once showed a nearest-support price tagged with a
  // different ratio than the level list. nearestSupport/nearestResistance must
  // be the identical level object (price AND ratio) from the levels array.
  const bars = Array.from({ length: 40 }, (_, index) => {
    const base = 200 + index * 1.5 + Math.sin(index) * 2;
    return bar(index + 1, base + 2, base - 2, base);
  });
  for (const currentPrice of [205, 225, 250, 262]) {
    const result = buildSearchFibonacci({ dailyBars: bars, currentPrice });
    if (!result.available) continue;
    for (const key of ['nearestSupport', 'nearestResistance']) {
      const near = result[key];
      if (!near) continue;
      const match = result.levels.find(l => l.price === near.price);
      assert.ok(match, `${key} price ${near.price} must exist in levels`);
      assert.equal(match.ratio, near.ratio, `${key} ratio must match level-list ratio for $${near.price}`);
    }
  }
});
