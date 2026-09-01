'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applySearchMarketRegime,
  buildSearchMarketContext,
  classifySearchMarketRegime,
  classifyRelativeStrength,
} = require('../lib/search-market-regime');

function dailyBars(count, start, step = 1) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * step;
    return { t: `2026-01-${String(index + 1).padStart(2, '0')}`, o: close - 0.2, h: close + 0.5, l: close - 0.5, c: close, v: 1_000_000 };
  });
}

const bullishSignal = {
  signal: { label: 'BUY', direction: 'BULLISH', stage: 'PROVISIONAL' },
  confidence: 70,
  bullishVolumeScore: 70,
  dataQuality: { volumeBaselineAvailable: true },
  structure: { higherLows: true },
  reasons: ['Price structure and volume support buyers'],
};

const freshSpy = {
  regularMarketPrice: 140,
  regularMarketChangePercent: 0.8,
  marketState: 'CLOSED',
};

test('classifies completed SPY trend evidence into a strong bullish regime', () => {
  const result = classifySearchMarketRegime({
    quote: freshSpy,
    dailyBars: dailyBars(210, 80, 0.3),
    marketState: 'CLOSED',
    nowMs: Date.parse('2026-08-01T18:00:00Z'),
  });
  assert.equal(result.available, true);
  assert.equal(result.regime, 'STRONG BULLISH');
  assert.equal(result.direction, 'BULLISH');
  assert.ok(result.evidence.length >= 4);
});

test('keeps a bullish stock buy aligned with a bullish SPY regime', () => {
  const result = applySearchMarketRegime({
    searchSignal: bullishSignal,
    spyRegime: { available: true, regime: 'BULLISH', direction: 'BULLISH' },
    sector: { label: 'BULLISH', direction: 'BULLISH' },
    relativeStrength: { label: 'MODERATE', score: 5, evidence: 'Moderate outperformance versus SPY' },
    sensitivity: { high: false },
  });
  assert.equal(result.signal.label, 'BUY');
  assert.equal(result.marketContext.marketAlignment.state, 'ALIGNED');
});

test('downgrades a bullish stock against a bearish SPY regime', () => {
  const result = applySearchMarketRegime({
    searchSignal: bullishSignal,
    spyRegime: { available: true, regime: 'BEARISH', direction: 'BEARISH' },
    sector: { label: 'NEUTRAL', direction: 'NEUTRAL' },
    relativeStrength: { label: 'NEUTRAL', score: 0, evidence: 'No meaningful multi-session relative-strength edge' },
    sensitivity: { high: false },
  });
  assert.equal(result.signal.label, 'BUY');
  assert.equal(result.marketContext.marketAlignment.state, 'COUNTER-TREND');
  assert(result.confidence < bullishSignal.confidence);
});

test('keeps the existing sell label when SPY and the stock are bearish', () => {
  const result = applySearchMarketRegime({
    searchSignal: { ...bullishSignal, signal: { label: 'SELL', direction: 'BEARISH', stage: 'CONFIRMED' }, confidence: 80 },
    spyRegime: { available: true, regime: 'STRONG BEARISH', direction: 'BEARISH' },
    sector: { label: 'BEARISH', direction: 'BEARISH' },
    relativeStrength: { label: 'WEAK', score: -10, evidence: 'Multi-session underperformance versus SPY' },
    sensitivity: { high: false },
  });
  assert.equal(result.signal.label, 'SELL');
});

test('keeps the existing sell label when SPY is strongly bullish', () => {
  const result = applySearchMarketRegime({
    searchSignal: { ...bullishSignal, signal: { label: 'SELL', direction: 'BEARISH', stage: 'PROVISIONAL' }, confidence: 70 },
    spyRegime: { available: true, regime: 'STRONG BULLISH', direction: 'BULLISH' },
    sector: { label: 'BEARISH', direction: 'BEARISH' },
    relativeStrength: { label: 'WEAK', score: -10, evidence: 'Multi-session underperformance versus SPY' },
    sensitivity: { high: false },
  });
  assert.equal(result.signal.label, 'SELL');
  assert.equal(result.marketContext.marketAlignment.state, 'COUNTER-TREND');
});

test('keeps the existing buy label for strong relative strength in a bearish market', () => {
  const result = applySearchMarketRegime({
    searchSignal: { ...bullishSignal, confidence: 55 },
    spyRegime: { available: true, regime: 'BEARISH', direction: 'BEARISH' },
    sector: { label: 'BULLISH', direction: 'BULLISH' },
    relativeStrength: { label: 'STRONG', score: 10, evidence: 'Multi-session outperformance versus SPY' },
    sensitivity: { high: false },
  });
  assert.equal(result.signal.label, 'BUY');
  assert.equal(result.marketContext.marketAlignment.label, 'BEARISH');
});

test('treats a crypto-sensitive MSTR-style asset more cautiously in strong bearish SPY', () => {
  const context = buildSearchMarketContext({
    symbol: 'MSTR',
    quote: freshSpy,
    stockQuote: { shortName: 'Strategy' },
    spyDailyBars: dailyBars(210, 140, -0.3),
    stockDailyBars: dailyBars(210, 50, 0.5),
    stockSignal: { ...bullishSignal, signal: { ...bullishSignal.signal, stage: 'PROVISIONAL' } },
    sectorTrend: 'BULLISH',
    sectorChangePct: 0.6,
    sectorEtf: 'XLK',
    profile: { assetProfile: { longBusinessSummary: 'A company holding bitcoin and digital assets.' } },
    nowMs: Date.parse('2026-08-01T18:00:00Z'),
  });
  const result = applySearchMarketRegime({
    searchSignal: bullishSignal,
    spyRegime: { ...context.spy, available: true, regime: 'STRONG BEARISH', direction: 'BEARISH' },
    sector: context.sector,
    relativeStrength: { label: 'STRONG', score: 10, evidence: 'Multi-session outperformance versus SPY' },
    sensitivity: context.sensitivity,
  });
  assert.equal(context.sensitivity.high, true);
  assert.equal(result.signal.label, 'BUY');
});

test('fails closed when SPY data is unavailable and does not invent relative strength', () => {
  const result = applySearchMarketRegime({
    searchSignal: bullishSignal,
    spyRegime: { available: false, regime: 'UNAVAILABLE', direction: null, missing: ['SPY data'] },
    sector: { label: 'BULLISH', direction: 'BULLISH' },
    relativeStrength: { label: 'UNAVAILABLE', score: 0 },
  });
  assert.equal(result.signal.label, 'BUY');
  assert.equal(result.marketContext.marketAlignment.label, 'UNAVAILABLE');
  assert.equal(result.dataQuality.marketContextAvailable, false);

  const relative = classifyRelativeStrength({ stockDailyBars: [], spyDailyBars: [] });
  assert.equal(relative.label, 'UNAVAILABLE');
});