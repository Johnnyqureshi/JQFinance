'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  atrWilder,
  buildSearchLevels,
  completedDailyBars,
  dailyPivots,
} = require('../lib/search-levels');

function bars(count, start = 100) {
  const output = [];
  for (let index = 0; index < count; index += 1) {
    const day = String(index + 1).padStart(2, '0');
    const close = start + index;
    output.push({
      t: `2026-08-${day}`,
      o: close - 0.5,
      h: close + 2,
      l: close - 2,
      c: close,
      v: 1_000_000 + index,
    });
  }
  return output;
}

test('excludes the current forming daily candle during regular hours', () => {
  const input = bars(15);
  const completed = completedDailyBars(input, {
    nowMs: Date.parse('2026-08-15T16:00:00Z'),
    marketState: 'REGULAR',
  });
  assert.equal(completed.length, 14);
  assert.equal(completed.at(-1).t, '2026-08-14');
});

test('includes the just-completed session after the regular close', () => {
  const input = bars(15);
  const completed = completedDailyBars(input, {
    nowMs: Date.parse('2026-08-15T22:00:00Z'),
    marketState: 'POST',
  });
  assert.equal(completed.length, 15);
  assert.equal(completed.at(-1).t, '2026-08-15');
});

test('excludes a same-date provider candle during PRE and PREPRE', () => {
  const input = bars(15);
  for (const marketState of ['PRE', 'PREPRE']) {
    const completed = completedDailyBars(input, {
      nowMs: Date.parse('2026-08-15T12:00:00Z'),
      marketState,
    });
    assert.equal(completed.length, 14);
    assert.equal(completed.at(-1).t, '2026-08-14');
  }
});

test('closed non-session dates retain the latest earlier completed session', () => {
  const input = bars(15);
  const completed = completedDailyBars(input, {
    nowMs: Date.parse('2026-08-16T16:00:00Z'),
    marketState: 'CLOSED',
  });
  assert.equal(completed.length, 15);
  assert.equal(completed.at(-1).t, '2026-08-15');
});

test('uses exactly prior-session OHLC for standard floor pivots', () => {
  const pivots = dailyPivots({ t: '2026-08-14', h: 110, l: 100, c: 106 }, 108, 4);
  assert.equal(pivots.pp, 105.33333333333333);
  assert.equal(pivots.r1, 110.66666666666666);
  assert.equal(pivots.s1, 100.66666666666666);
  assert.equal(pivots.r2, 115.33333333333333);
  assert.equal(pivots.s2, 95.33333333333333);
  assert.equal(pivots.anchorDate, '2026-08-14');
});

test('Wilder ATR requires 14 true ranges and has no off-by-one error', () => {
  const input = bars(15);
  const atr = atrWilder(input, 14);
  assert.equal(atr, 4);
  assert.equal(atrWilder(input.slice(0, 14), 14), null);
});

test('ATR buffer uses only the latest 14 true ranges', () => {
  const oldOutlier = {
    t: '2026-07-31', o: 100, h: 300, l: 1, c: 100, v: 1_000_000,
  };
  const recent = bars(15);
  assert.equal(atrWilder([oldOutlier, ...recent], 14), atrWilder(recent, 14));
});

test('search levels use 14 completed sessions and expose narrow ATR zones', () => {
  const input = bars(20);
  const result = buildSearchLevels({
    dailyBars: input,
    currentPrice: 120.5,
    marketState: 'CLOSED',
    nowMs: Date.parse('2026-08-21T12:00:00Z'),
  });
  assert.equal(result.displayLevels.lookback, 14);
  assert.equal(result.displayLevels.anchorDate, '2026-08-20');
  assert.ok(result.displayLevels.bias.zoneLow < result.displayLevels.bias.price);
  assert.ok(result.displayLevels.bias.zoneHigh > result.displayLevels.bias.price);
  assert.ok(result.levels.buffer > 0);
  assert.ok(result.dailyPivots);
});

test('forming candle changes cannot repaint regular-session levels', () => {
  const completed = bars(15);
  const formingA = { t: '2026-08-16', o: 115, h: 116, l: 114, c: 115.5, v: 100 };
  const formingB = { ...formingA, h: 140, l: 90, c: 130, v: 9_000_000 };
  const options = {
    currentPrice: 116,
    marketState: 'REGULAR',
    nowMs: Date.parse('2026-08-16T16:00:00Z'),
  };
  const first = buildSearchLevels({ dailyBars: [...completed, formingA], ...options });
  const second = buildSearchLevels({ dailyBars: [...completed, formingB], ...options });
  assert.deepEqual(first.displayLevels, second.displayLevels);
  assert.deepEqual(first.dailyPivots, second.dailyPivots);
});

test('withholds ATR-buffered levels when completed history is insufficient', () => {
  const result = buildSearchLevels({
    dailyBars: bars(14),
    currentPrice: 114.5,
    marketState: 'CLOSED',
    nowMs: Date.parse('2026-08-15T22:00:00Z'),
  });
  assert.equal(result.levels, null);
  assert.equal(result.displayLevels, null);
  assert.equal(result.atr, null);
  assert.ok(result.dailyPivots);
  assert.match(result.unavailableReason, /15 completed sessions/);
});