'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSearchGapAnalysis,
  detectSessionGaps,
  summarizePatternAnalysis,
} = require('../lib/search-gap-analysis');

function bar(day, o, h, l, c) {
  return { t: `2026-01-${String(day).padStart(2, '0')}`, o, h, l, c };
}

test('detects true range gaps and ignores ordinary opening gaps', () => {
  const result = detectSessionGaps([
    bar(1, 100, 101, 99, 100),
    bar(2, 103, 104, 102, 103),
    bar(3, 101, 103, 100, 102),
  ]);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].direction, 'UP');
  assert.equal(result.gaps[0].zoneLow, 101);
  assert.equal(result.gaps[0].zoneHigh, 102);
});

test('returns nearest unfilled gaps above and below with historical rates', () => {
  const bars = [];
  for (let day = 1; day <= 25; day += 1) bars.push(bar(day, 100, 101, 99, 100));
  bars[1] = bar(2, 103, 104, 102, 103);
  bars[2] = bar(3, 100, 101, 99, 100);
  bars[23] = bar(24, 105, 106, 104, 105);
  bars[24] = bar(25, 110, 111, 109, 110);
  const result = buildSearchGapAnalysis({ dailyBars: bars, currentPrice: 110 });
  assert.equal(result.below.direction, 'UP');
  assert.equal(result.below.zoneHigh, 109);
  assert.equal(result.above, null);
  assert.equal(typeof result.below.historicalFill.fillRatePct, 'number');
});

test('summarizes daily and intraday patterns without inventing certainty', () => {
  const result = summarizePatternAnalysis({
    daily: [{ name: 'Double Bottom', type: 'BULLISH', strength: 3, desc: 'test' }],
    intraday: [{ name: 'Shooting Star', type: 'BEARISH', strength: 2, desc: 'test' }],
  });
  assert.equal(result.direction, 'BULLISH');
  assert.equal(result.netScore, 6);
  assert.equal(result.patterns.length, 2);
});

test('reports an unfilled gap that currently contains the live price', () => {
  const bars = [
    bar(1, 100, 101, 99, 100),
    bar(2, 104, 105, 103, 104),
    ...Array.from({ length: 22 }, (_, index) => bar(index + 3, 104, 105, 102, 104)),
  ];
  const result = buildSearchGapAnalysis({ dailyBars: bars, currentPrice: 102.5 });
  assert.equal(result.current.direction, 'UP');
  assert.equal(result.current.zoneLow, 101);
  assert.equal(result.current.zoneHigh, 103);
  assert.equal(result.current.remainingFillPct > 0, true);
});