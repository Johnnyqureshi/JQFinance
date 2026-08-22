/**
 * Deterministic checks for the probability/confluence engine.
 * Run with: node tests/technical-probability-engine.test.js
 */
'use strict';

const assert = require('assert');
const { buildTechnicalConfluence } = require('../lib/technical-probability-engine');

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

function makeBars({ start, step, count = 70, volume = 1_000, up = true, session = 'reg' }) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + step * index;
    const open = close - (up ? 0.15 : -0.15);
    return { o: open, h: close + 0.35, l: close - 0.35, c: close, v: volume + index * 20, session };
  });
}
function freshSources() {
  return Object.fromEntries(
    ['quote', 'oneMinute', 'fiveMinute', 'fifteenMinute', 'hourly', 'daily']
      .map(key => [key, { fresh: true, ageMs: 1_000, maxAgeMs: 60_000 }])
  );
}

const bullishDaily = makeBars({ start: 20, step: 0.18, count: 240, volume: 20_000, up: true });
const bullishIntra = makeBars({ start: 58, step: 0.08, count: 40, volume: 3_000, up: true });
const bearishDaily = makeBars({ start: 70, step: -0.2, count: 240, volume: 20_000, up: false });
const bearishIntra = makeBars({ start: 24, step: -0.08, count: 40, volume: 3_000, up: false });

console.log('\nTechnical probability engine\n');

test('requires multiple confirmations before calling a bullish setup confirmed', () => {
  const result = buildTechnicalConfluence({
    price: bullishIntra.at(-1).c,
    dailyBars: bullishDaily,
    intradayBars: bullishIntra,
    indicators: {
      rsi14: 63, ema9: 60.9, ema20: 59.8, sma50: 55, sma200: 42, atr: 1.2,
      macd: { value: 1.2, signal: 0.8, histogram: 0.4 },
    },
    levels: { support: [{ price: 60.5, label: 'Repeated support', confirmations: 3 }], resistance: [{ price: 63, label: 'Range high', confirmations: 2 }] },
    relVol: 2.1, dayChangePct: 3.2,
    market: { trend: 'BULLISH', sectorTrend: 'BULLISH', spy: 0.7, sectorChangePct: 0.9 },
    freshness: freshSources(),
    timeframes: {
      oneMinute: bullishIntra, fiveMinute: bullishIntra, fifteenMinute: bullishIntra,
      hourly: bullishIntra, daily: bullishDaily,
    },
  });
  assert.strictEqual(result.available, true);
  assert(result.scores.bullish > result.scores.bearish);
  assert(['CONFIRMED', 'ENTRY CONFIRMATION'].includes(result.signal.stage));
  assert(result.audit.bullishFactors.length >= 4);
});

test('does not treat oversold RSI as a buy without confluence', () => {
  const result = buildTechnicalConfluence({
    price: bearishIntra.at(-1).c,
    dailyBars: bearishDaily,
    intradayBars: bearishIntra,
    indicators: {
      rsi14: 27, ema9: 20, ema20: 22, sma50: 30, sma200: 45, atr: 1.4,
      macd: { value: -1.2, signal: -0.7, histogram: -0.5 },
    },
    levels: { support: [{ price: 19.5, label: 'Unconfirmed support' }], resistance: [{ price: 22, label: 'Broken resistance' }] },
    relVol: 2.5, dayChangePct: -4.5,
    market: { trend: 'BEARISH', sectorTrend: 'BEARISH', spy: -1.1, sectorChangePct: -1.3 },
    freshness: freshSources(),
    timeframes: {
      oneMinute: bearishIntra, fiveMinute: bearishIntra, fifteenMinute: bearishIntra,
      hourly: bearishIntra, daily: bearishDaily,
    },
  });
  assert(result.scores.bearish > result.scores.bullish);
  assert.notStrictEqual(result.signal.label, 'HIGH-PROBABILITY BULLISH SETUP');
  assert(result.audit.notes.some(note => /oversold/i.test(note)));
});

test('surfaces missing inputs instead of inventing a directional call', () => {
  const result = buildTechnicalConfluence({ price: 10, dailyBars: [], intradayBars: [], levels: {} });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.signal.label, 'DATA INCOMPLETE — NO TRADE');
  assert(result.audit.missingInputs.length > 0);
  assert.strictEqual(result.dataQuality.entryEligible, false);
  assert.strictEqual(result.signal.stage, 'WATCH');
});

test('caps a bullish setup when a required higher timeframe is unavailable', () => {
  const result = buildTechnicalConfluence({
    price: bullishIntra.at(-1).c,
    dailyBars: bullishDaily,
    intradayBars: bullishIntra,
    indicators: {
      rsi14: 63, ema9: 60.9, ema20: 59.8, sma50: 55, sma200: 42, atr: 1.2,
      macd: { value: 1.2, signal: 0.8, histogram: 0.4 },
    },
    levels: { support: [{ price: 60.5, label: 'Repeated support', confirmations: 3 }], resistance: [{ price: 63, label: 'Range high', confirmations: 2 }] },
    relVol: 2.1, dayChangePct: 3.2,
    market: { trend: 'BULLISH', sectorTrend: 'BULLISH', spy: 0.7, sectorChangePct: 0.9 },
    freshness: freshSources(),
    timeframes: { oneMinute: bullishIntra, fiveMinute: bullishIntra, fifteenMinute: null, hourly: bullishIntra, daily: bullishDaily },
  });
  assert.strictEqual(result.dataQuality.entryEligible, false);
  assert.strictEqual(result.signal.label, 'DATA INCOMPLETE — NO TRADE');
  assert(result.scores.setupQuality <= 55);
});

test('blocks a confirmed-looking setup when any required market source is stale', () => {
  const freshness = freshSources();
  freshness.fiveMinute = { fresh: false, ageMs: 60 * 60_000, maxAgeMs: 16 * 60_000 };
  const result = buildTechnicalConfluence({
    price: bullishIntra.at(-1).c,
    dailyBars: bullishDaily,
    intradayBars: bullishIntra,
    indicators: {
      rsi14: 63, ema9: 60.9, ema20: 59.8, sma50: 55, sma200: 42, atr: 1.2,
      macd: { value: 1.2, signal: 0.8, histogram: 0.4 },
    },
    levels: { support: [{ price: 60.5, label: 'Repeated support', confirmations: 3 }], resistance: [{ price: 63, label: 'Range high', confirmations: 2 }] },
    relVol: 2.1, dayChangePct: 3.2,
    market: { trend: 'BULLISH', sectorTrend: 'BULLISH', spy: 0.7, sectorChangePct: 0.9 },
    freshness,
    timeframes: {
      oneMinute: bullishIntra, fiveMinute: bullishIntra, fifteenMinute: bullishIntra,
      hourly: bullishIntra, daily: bullishDaily,
    },
  });
  assert.strictEqual(result.dataQuality.entryEligible, false);
  assert.strictEqual(result.dataQuality.fresh, false);
  assert.strictEqual(result.signal.label, 'DATA INCOMPLETE — NO TRADE');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);