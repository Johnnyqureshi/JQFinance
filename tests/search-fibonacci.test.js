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