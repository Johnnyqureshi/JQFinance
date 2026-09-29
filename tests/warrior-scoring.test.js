'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_RULES, scoreSetup } = require('../lib/warrior/scoring');

const perfectInd = {
  price: 105, vwap: 104, ema9: 104.5, ema20: 104,
  macd: 0.5, macdHist: 0.2, macdHistPrev: 0.1, rvol: 3,
};
const perfectPattern = { pattern_valid: true, pattern_score: 2.5, pattern_name: 'BullFlag' };

test('DEFAULT_RULES carries the spec thresholds', () => {
  assert.deepEqual(
    [DEFAULT_RULES.minScore, DEFAULT_RULES.highQuality, DEFAULT_RULES.minScoreBull,
      DEFAULT_RULES.minScoreNeutral, DEFAULT_RULES.minScoreBear, DEFAULT_RULES.minRR],
    [9, 11, 9, 10, 12, 2.0]);
  assert.equal(DEFAULT_RULES.strongRvol, 2);
});

test('a perfect setup scores 16, displays 15+, and clears every gate', () => {
  const s = scoreSetup({
    pattern: perfectPattern, ind: perfectInd, regime: 'BULLISH',
    dayChangePct: 4, newIntradayHigh: true, volumeExpanding: true, aboveEma200Daily: true,
  });
  assert.equal(s.score, 16);
  assert.equal(s.displayScore, '15+');
  assert.deepEqual(s.breakdown, { momentum: 6, trend: 5, macd: 2, pattern: 3 });
  assert.equal(s.minRequired, 9);
  assert.equal(s.meetsMinimum, true);
  assert.equal(s.highQuality, true);
  assert.ok(s.reasons.length > 0);
});

test('a weak setup scores below 9 and fails the minimum', () => {
  const s = scoreSetup({
    pattern: null,
    ind: { price: 99, vwap: 100, ema9: 100.5, ema20: 101, macd: -0.2, macdHist: -0.1, macdHistPrev: -0.05, rvol: 0.8 },
    regime: 'NEUTRAL', dayChangePct: 0.5, newIntradayHigh: false,
    volumeExpanding: false, aboveEma200Daily: false,
  });
  assert.ok(s.score < 9);
  assert.equal(s.displayScore, String(s.score));
  assert.equal(s.minRequired, 10);
  assert.equal(s.meetsMinimum, false);
  assert.equal(s.highQuality, false);
});

test('regime adjusts the minimum: bear needs 12', () => {
  const base = {
    pattern: null, regime: 'BULLISH', dayChangePct: 2,
    newIntradayHigh: true, volumeExpanding: false, aboveEma200Daily: true,
    ind: { price: 105, vwap: 104, ema9: 104.9, ema20: 104.8, macd: 0.1, macdHist: 0.05, macdHistPrev: 0.04, rvol: 2.5 },
  };
  const bull = scoreSetup(base);
  assert.equal(bull.score, 11); // momentum 4 + trend 5 + macd 2
  assert.equal(bull.minRequired, 9);
  const bear = scoreSetup({ ...base, regime: 'BEARISH' });
  assert.equal(bear.minRequired, 12);
  assert.equal(bear.meetsMinimum, bear.score >= 12);
  // An 11-point setup passes in a bull market but not a bear market.
  assert.ok(bull.score >= 9 && bull.score < 12);
  assert.equal(bull.meetsMinimum, true);
  assert.equal(bear.meetsMinimum, false);
});

test('missing indicator data awards no points but never throws', () => {
  const s = scoreSetup({ pattern: null, ind: {}, regime: 'NEUTRAL' });
  assert.equal(s.score, 0);
  assert.equal(s.meetsMinimum, false);
});

test('custom rules override the regime minimums', () => {
  const s = scoreSetup(
    { pattern: perfectPattern, ind: perfectInd, regime: 'BEARISH', dayChangePct: 4, newIntradayHigh: true, volumeExpanding: true, aboveEma200Daily: true },
    { ...DEFAULT_RULES, minScoreBear: 16 },
  );
  assert.equal(s.minRequired, 16);
  assert.equal(s.meetsMinimum, true);
});
