'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/volatility/calculations');
const { applySearchMarketRegime } = require('../lib/search-market-regime');
const bars = values => values.map((c, i) => ({ t: `2025-01-${String(i + 1).padStart(2, '0')}`, c }));

test('computes known realized volatility from log returns', () => {
  const data = bars([100, 110, 121]);
  const expected = Math.sqrt(252) * Math.sqrt(((Math.log(1.1) - Math.log(1.1)) ** 2 + (Math.log(1.1) - Math.log(1.1)) ** 2));
  assert.equal(c.realizedVol(data, 2), expected);
});
test('calculates percentile and VIX term structure', () => {
  assert.equal(c.percentile(3, [1, 2, 3, 4]), 75);
  const term = c.termStructure({ vix: 20, vix3m: 22, vix6m: 24, vix1y: 25 });
  assert.equal(term.classification, 'STEEP CONTANGO');
  assert.ok(Math.abs(term.normalizedSlopes.vix3mToVix - .1) < 1e-12);
});
test('does not fabricate IV rank without IV history', () => {
  assert.equal(c.ivRank(.3, []).ivRank, null);
  const ranked = c.ivRank(.3, [.1, .2, .4]);
  assert.equal(ranked.ivRank, 66.66666666666666);
  assert.equal(ranked.ivPercentile, 66.66666666666666);
});
test('calculates Black-Scholes gamma and expected move', () => {
  assert.ok(c.bsGamma({ spot: 100, strike: 100, iv: .2, dte: 30 }) > 0);
  const move = c.expectedMove(100, .2, 30);
  assert.ok(Math.abs(move.amount - 5.733821790809959) < 1e-12);
  assert.equal(move.upper, 100 + move.amount);
});
test('models inferred gamma exposure and a deterministic gamma flip', () => {
  const chain = [
    { strike: 90, impliedVolatility: .2, dte: 30, openInterest: 100, type: 'call' },
    { strike: 110, impliedVolatility: .2, dte: 30, openInterest: 500, type: 'put' },
  ];
  const exposure = c.gammaExposure(chain, 100);
  assert.ok(exposure.callGamma > 0);
  assert.ok(exposure.putGamma < 0);
  assert.equal(c.gammaFlip(chain, 100), 100);
});
test('missing volatility and feature-off inputs preserve BUY and SELL labels', () => {
  const buy = { signal: { label: 'BUY', direction: 'BULLISH', stage: 'CONFIRMED' }, confidence: 70, dataQuality: {} };
  const sell = { signal: { label: 'SELL', direction: 'BEARISH', stage: 'CONFIRMED' }, confidence: 70, dataQuality: {} };
  for (const signal of [buy, sell]) {
    const result = applySearchMarketRegime({ searchSignal: signal, volatility: { status: 'UNAVAILABLE', completeness: 0 } });
    assert.equal(result.signal.label, signal.signal.label);
    assert.equal(result.confidence, 70);
    assert.equal(result.confidenceBreakdown.volatility, 0);
  }
});
test('selects a representative near-term at-the-money IV and computes ATR percentile', () => {
  const chain = [
    { strike: 80, impliedVolatility: .55, dte: 5 },
    { strike: 99, impliedVolatility: .24, dte: 14 },
    { strike: 101, impliedVolatility: .26, dte: 14 },
    { strike: 120, impliedVolatility: .48, dte: 14 },
  ];
  assert.deepEqual(c.currentOptionIv(chain, 100), { iv: .26, dte: 14 });
  const daily = Array.from({ length: 40 }, (_, i) => ({
    c: 100 + i, h: 102 + i, l: 98 + i,
  }));
  assert.ok(Number.isFinite(c.atrPercentile(daily)));
});
test('fresh complete volatility adjusts confidence but never changes the verdict', () => {
  const signal = {
    signal: { label: 'BUY', direction: 'BULLISH', stage: 'CONFIRMED' },
    confidence: 70,
    dataQuality: {},
  };
  const result = applySearchMarketRegime({
    searchSignal: signal,
    volatility: {
      available: true,
      status: 'LIVE',
      ageMs: 1000,
      completeness: 1,
      scores: { volatilityRegime: 90, gamma: 25 },
    },
  });
  assert.equal(result.signal.label, 'BUY');
  assert.equal(result.signal.direction, 'BULLISH');
  assert.equal(result.signal.stage, 'CONFIRMED');
  assert.notEqual(result.confidence, 70);
  assert.ok(Math.abs(result.confidenceBreakdown.volatility) <= 15);
  assert.ok(Math.abs(result.confidenceBreakdown.gamma) <= 10);
});
test('stale volatility has zero confidence influence', () => {
  const signal = {
    signal: { label: 'SELL', direction: 'BEARISH', stage: 'CONFIRMED' },
    confidence: 65,
    dataQuality: {},
  };
  const result = applySearchMarketRegime({
    searchSignal: signal,
    volatility: {
      available: true,
      status: 'STALE_FALLBACK',
      ageMs: 10 * 24 * 60 * 60 * 1000,
      completeness: 1,
      scores: { volatilityRegime: 100, gamma: 0 },
    },
  });
  assert.equal(result.signal.label, 'SELL');
  assert.equal(result.confidence, 65);
  assert.equal(result.confidenceBreakdown.volatility, 0);
  assert.equal(result.confidenceBreakdown.gamma, 0);
});