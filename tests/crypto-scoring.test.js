'use strict';

// Crypto breakout scoring — 0–100 weighted score, Johnny's weights, regime
// adjustments, and configurability.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  scoreBreakout, minScoreForRegime, rvolRequirementMultiplier, DEFAULT_WEIGHTS,
} = require('../lib/crypto/scoring');

function perfectInput() {
  return {
    breakout: { confirmed: true, closeAboveResistance: true, breakoutAtr: 1.5, resistanceTests: 3, retest: false },
    volume: { rvol: 4.5, priceUp: true, volumeRising: true },
    structure: { trend: 'uptrend' },
    htf: { trend: 'bullish', aboveEma200: true, emaAligned: true },
    momentum: { rsi: 62, macdPositive: true, macdHistRising: true, bearishDivergence: false },
    vwapEma: { aboveVwap: true, ema9Above20: true, ema20Above50: true, priceAboveEma50: true },
    liquidity: { spreadPct: 0.05, spreadOk: true, dollarVolumeOk: true },
    regime: 'bullish',
  };
}
function weakInput() {
  return {
    breakout: { confirmed: false, closeAboveResistance: false, breakoutAtr: 0.1, resistanceTests: 0, retest: false },
    volume: { rvol: 0.8, priceUp: false, volumeRising: false },
    structure: { trend: 'downtrend' },
    htf: { trend: 'bearish', aboveEma200: false, emaAligned: false },
    momentum: { rsi: 38, macdPositive: false, macdHistRising: false, bearishDivergence: true },
    vwapEma: { aboveVwap: false, ema9Above20: false, ema20Above50: false, priceAboveEma50: false },
    liquidity: { spreadPct: 2.5, spreadOk: false, dollarVolumeOk: false },
    regime: 'bearish',
  };
}

test('default weights sum to 100 with Johnny\'s allocation', () => {
  const total = Object.values(DEFAULT_WEIGHTS).reduce((s, w) => s + w, 0);
  assert.equal(total, 100);
  assert.deepEqual(DEFAULT_WEIGHTS, {
    breakoutQuality: 20, volumeConfirmation: 20, rvol: 15,
    priceStructure: 10, htfTrend: 10, momentum: 10,
    vwapEma: 5, liquiditySpread: 5, regime: 5,
  });
});

test('a perfect breakout scores near 100 and meets the minimum', () => {
  const r = scoreBreakout(perfectInput());
  assert.ok(r.score >= 90, `perfect setup should score >= 90, got ${r.score}`);
  assert.ok(r.score <= 100, `score caps at 100, got ${r.score}`);
  assert.equal(r.meetsMinimum, true);
  assert.equal(r.minRequired, 75);
});

test('a weak setup scores low and fails the minimum', () => {
  const r = scoreBreakout(weakInput());
  assert.ok(r.score < 50, `weak setup should score < 50, got ${r.score}`);
  assert.equal(r.meetsMinimum, false);
});

test('a wick-only breakout (no close above resistance) loses breakout-quality points', () => {
  const a = scoreBreakout(perfectInput());
  const wick = perfectInput();
  wick.breakout.closeAboveResistance = false;
  const b = scoreBreakout(wick);
  assert.ok(b.breakdown.breakoutQuality < a.breakdown.breakoutQuality,
    'close-above-resistance must be worth breakout-quality points');
});

test('RVOL tiers move the score: 2.0 < 3.0 < 4.0', () => {
  const at = rvol => scoreBreakout({ ...perfectInput(), volume: { rvol, priceUp: true, volumeRising: true } });
  const s2 = at(2.0), s3 = at(3.0), s4 = at(4.0);
  assert.ok(s2.breakdown.rvol < s3.breakdown.rvol && s3.breakdown.rvol < s4.breakdown.rvol,
    `RVOL tiers must order the score: 2.0=${s2.breakdown.rvol} 3.0=${s3.breakdown.rvol} 4.0=${s4.breakdown.rvol}`);
});

test('bearish RSI divergence penalizes momentum', () => {
  const clean = scoreBreakout(perfectInput());
  const div = perfectInput();
  div.momentum.bearishDivergence = true;
  const penalized = scoreBreakout(div);
  assert.ok(penalized.breakdown.momentum < clean.breakdown.momentum, 'divergence must cost momentum points');
});

test('overbought RSI (>85) does not predict the top but scores below the sweet spot', () => {
  const sweet = scoreBreakout(perfectInput());
  const ob = perfectInput();
  ob.momentum.rsi = 88;
  const overbought = scoreBreakout(ob);
  assert.ok(overbought.breakdown.momentum < sweet.breakdown.momentum,
    'overbought RSI should score below the 55–75 sweet spot');
  assert.ok(overbought.breakdown.momentum > 0, 'overbought is not an automatic zero');
});

test('minScoreForRegime raises the bar in bearish and high-volatility regimes', () => {
  assert.equal(minScoreForRegime('bullish', 75), 75);
  assert.equal(minScoreForRegime('neutral', 75), 75);
  assert.equal(minScoreForRegime('bearish', 75), 85);
  assert.equal(minScoreForRegime('high_volatility', 75), 90);
});

test('a decent setup passes in bullish but fails in bearish regime', () => {
  const input = perfectInput();
  input.volume.rvol = 2.2;
  input.momentum.rsi = 58;
  const bull = scoreBreakout({ ...input, regime: 'bullish' });
  const bear = scoreBreakout({ ...input, regime: 'bearish' });
  assert.ok(bull.score > bear.score, 'regime bucket must differentiate');
  assert.ok(bear.minRequired > bull.minRequired, 'bearish regime must raise the bar');
});

test('rvolRequirementMultiplier demands stronger volume when BTC is weak', () => {
  assert.equal(rvolRequirementMultiplier('bullish'), 1);
  assert.equal(rvolRequirementMultiplier('neutral'), 1);
  assert.equal(rvolRequirementMultiplier('bearish'), 1.25);
  assert.equal(rvolRequirementMultiplier('high_volatility'), 1.5);
});

test('weights are configurable via the rules object', () => {
  const r = scoreBreakout(perfectInput(), { weights: { rvol: 30, breakoutQuality: 5 } });
  assert.ok(r.breakdown.rvol > r.breakdown.breakoutQuality,
    'custom weights must reshape the breakdown');
  const total = Object.values(r.breakdown).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - r.score) < 0.11, 'breakdown must sum to the score');
});

test('minScore is configurable', () => {
  const r = scoreBreakout(perfectInput(), { minScore: 99 });
  assert.equal(r.minRequired, 99);
  assert.equal(r.meetsMinimum, r.score >= 99);
});

test('every bucket reports a reason', () => {
  const r = scoreBreakout(perfectInput());
  assert.equal(r.reasons.length, 9, 'one reason per bucket');
  assert.ok(r.reasons.every(x => typeof x === 'string' && x.length > 0));
});
