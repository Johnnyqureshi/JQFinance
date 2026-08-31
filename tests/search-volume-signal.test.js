'use strict';

const assert = require('assert');
const {
  buildSearchVolumeSignal,
  newsCatalystScore,
  selectCompletedDailyBar,
  timeOfDayRelativeVolume,
  volumeAcceleration,
} = require('../lib/search-volume-signal');

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

function timestamp(date, minute) {
  return Date.parse(`${date}T00:00:00.000Z`) + minute * 60_000;
}

function session(date, {
  start = 100,
  step = 0.2,
  volumes = Array(12).fill(100),
  malformedIndex = -1,
} = {}) {
  return volumes.map((volume, index) => {
    const close = start + step * index;
    const rising = step >= 0;
    return {
      t: timestamp(date, 570 + index * 5),
      session: 'reg',
      o: close - (rising ? 0.1 : -0.1),
      h: close + 0.2,
      l: close - 0.2,
      c: close,
      v: index === malformedIndex ? null : volume,
    };
  });
}

const history = [
  ...session('2026-01-02'),
  ...session('2026-01-03'),
  ...session('2026-01-04'),
];
const acceleratingVolumes = [...Array(9).fill(120), ...Array(3).fill(300)];
const nowMs = timestamp('2026-01-05', 630);

function build({
  current = session('2026-01-05', { volumes: acceleratingVolumes }),
  historical = history,
  levels = {
    support: [{ price: 99, label: 'Support' }],
    resistance: [{ price: 102.5, label: 'Resistance' }],
  },
  indicators = { rsi14: 62, vwap: 101, macd: { value: 1.2, signal: 0.8 } },
  market = { trend: 'BULLISH' },
  price = current.at(-1)?.c,
  freshness = null,
  news = [],
  dayChangePct = null,
  fibonacci = null,
} = {}) {
  return buildSearchVolumeSignal({
    price,
    intradayBars: current,
    volumeHistory5m: historical,
    barsByInterval: { oneMinute: current, fiveMinute: current, fifteenMinute: current },
    levels,
    indicators,
    market,
    news,
    dayChangePct,
    nowMs,
    timezone: 'UTC',
    freshness,
    fibonacci,
  });
}

console.log('\nSearch-page volume signal\n');

test('normalizes cumulative RVOL to the same session minute', () => {
  const current = session('2026-01-05', { volumes: acceleratingVolumes });
  const result = timeOfDayRelativeVolume({
    currentBars: current,
    historicalBars: history,
    nowMs,
    timezone: 'UTC',
  });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.sampleSize, 3);
  assert.strictEqual(result.expectedVolume, 1200);
  assert.strictEqual(result.currentCumulativeVolume, 1980);
  assert.strictEqual(+result.value.toFixed(2), 1.65);
});

test('calculates acceleration independently for 1m, 5m, and 15m evidence', () => {
  const current = session('2026-01-05', { volumes: acceleratingVolumes });
  const result = volumeAcceleration({
    barsByInterval: { oneMinute: current, fiveMinute: current, fifteenMinute: current },
    currentDate: '2026-01-05',
    nowMs,
    timezone: 'UTC',
  });
  assert.strictEqual(result.available, true);
  assert(result.ratio > 2);
  assert.strictEqual(result.byTimeframe.oneMinute.state, 'ACCELERATING');
  assert.strictEqual(result.byTimeframe.fiveMinute.state, 'ACCELERATING');
  assert.strictEqual(result.byTimeframe.fifteenMinute.state, 'ACCELERATING');
});

test('classifies bullish pressure near resistance as a provisional BUY', () => {
  const result = build({});
  assert.strictEqual(result.signal.label, 'BUY');
  assert.strictEqual(result.signal.setup, 'BREAKOUT WATCH');
  assert.strictEqual(result.signal.stage, 'PROVISIONAL');
  assert.strictEqual(result.signal.direction, 'BULLISH');
  assert(result.relativeVolume.value >= 1.5);
  assert(result.volumeAcceleration.ratio > 1.1);
  assert(result.bullishVolumeScore > result.bearishVolumeScore);
  assert(result.pumpPressure >= 50);
});

test('requires a level break, volume expansion, and follow-through for confirmation', () => {
  const result = build({
    levels: {
      support: [{ price: 99 }],
      resistance: [{ price: 101.5 }],
    },
  });
  assert.strictEqual(result.signal.label, 'BUY');
  assert.strictEqual(result.signal.setup, 'BREAKOUT CONFIRMED');
  assert.strictEqual(result.signal.stage, 'CONFIRMED');
  assert.strictEqual(result.levels.resistance.broken, true);
  assert.strictEqual(result.levels.resistance.followThrough, true);
});

test('issues SELL only for a high-volume structural support breakdown', () => {
  const current = session('2026-01-05', {
    start: 102.2,
    step: -0.2,
    volumes: acceleratingVolumes,
  });
  const result = build({
    current,
    price: current.at(-1).c,
    levels: {
      support: [{ price: 100.5 }],
      resistance: [{ price: 103 }],
    },
    indicators: { rsi14: 42, vwap: 101.5, macd: { value: -1.1, signal: -0.7 } },
    market: { trend: 'BEARISH' },
  });
  assert.strictEqual(result.signal.label, 'SELL');
  assert.strictEqual(result.signal.direction, 'BEARISH');
  assert.strictEqual(result.levels.support.broken, true);
  assert(result.bearishVolumeScore > result.bullishVolumeScore);
});

test('does not SELL from elevated RSI, resistance, or high volume alone', () => {
  const current = session('2026-01-05', {
    start: 100,
    step: 0,
    volumes: acceleratingVolumes,
  });
  const result = build({
    current,
    price: 100,
    levels: {
      support: [{ price: 99 }],
      resistance: [{ price: 100.5 }],
    },
    indicators: { rsi14: 88, vwap: 100, macd: { value: 0, signal: 0 } },
    market: { trend: 'NEUTRAL' },
  });
  assert.strictEqual(result.signal.label, 'BUY');
  assert.strictEqual(result.signal.stage, 'PROVISIONAL');
  assert.strictEqual(result.signal.direction, 'BULLISH');
});

test('uses the documented weighted confidence and keeps it bounded', () => {
  const result = build({});
  const totalWeight = Object.values(result.weights).reduce((sum, value) => sum + value, 0);
  assert.strictEqual(+totalWeight.toFixed(2), 1);
  assert(result.confidence >= 0 && result.confidence <= 100);
  assert.strictEqual(result.weights.volumeFlow, 0.25);
  assert.strictEqual(result.weights.structureMomentum, 0.25);
  assert.strictEqual(result.weights.supportResistance, 0.20);
  assert.strictEqual(result.weights.trend, 0.15);
  assert.strictEqual(result.weights.rsi, 0.10);
  assert.strictEqual(result.weights.other, 0.05);
});

test('lets Fibonacci add bounded confluence without confirming a trade', () => {
  const baseline = build();
  const withFibonacci = build({
    fibonacci: {
      available: true,
      direction: 'BULLISH',
      confluenceScore: 10,
      setup: 'BULLISH SWING HOLDING 61.8%',
    },
  });
  assert.strictEqual(withFibonacci.fibonacci.available, true);
  assert.strictEqual(withFibonacci.signal.stage, baseline.signal.stage);
  assert(withFibonacci.dataQuality.directionalEvidence.bullish
    > baseline.dataQuality.directionalEvidence.bullish);
  assert(withFibonacci.reasons.some(reason => reason.includes('volume confirmation is still required')));
});

test('fails safely when historical volume is missing or malformed', () => {
  const malformed = [
    ...session('2026-01-02', { malformedIndex: 2 }),
    ...session('2026-01-03', { malformedIndex: 3 }),
  ];
  const result = build({ historical: malformed });
  assert(['BUY', 'SELL'].includes(result.signal.label));
  assert.strictEqual(result.signal.stage, 'PROVISIONAL');
  assert(result.confidence <= 35);
  assert.strictEqual(result.dataQuality.volumeBaselineAvailable, false);
  assert(result.dataQuality.missing.includes('Time-of-day volume baseline'));
});

test('fails safely when current intraday volume is stale', () => {
  const result = build({
    freshness: {
      oneMinute: { fresh: false },
      fiveMinute: { fresh: false },
      fifteenMinute: { fresh: false },
    },
  });
  assert(['BUY', 'SELL'].includes(result.signal.label));
  assert.strictEqual(result.signal.stage, 'PROVISIONAL');
  assert(result.confidence <= 35);
  assert.strictEqual(result.dataQuality.currentVolumeFresh, false);
  assert.strictEqual(result.dataQuality.accelerationAvailable, false);
  assert(result.dataQuality.missing.includes('Current 5-minute volume is stale'));
});

test('still emits a low-quality binary signal when one acceleration timeframe is missing', () => {
  const current = session('2026-01-05', { volumes: acceleratingVolumes });
  const result = buildSearchVolumeSignal({
    price: current.at(-1).c,
    intradayBars: current,
    volumeHistory5m: history,
    barsByInterval: { oneMinute: current, fiveMinute: current, fifteenMinute: current.slice(0, 5) },
    levels: { support: [{ price: 99 }], resistance: [{ price: 102.5 }] },
    indicators: { rsi14: 62 },
    market: { trend: 'BULLISH' },
    nowMs,
    timezone: 'UTC',
  });
  assert(['BUY', 'SELL'].includes(result.signal.label));
  assert.strictEqual(result.signal.stage, 'PROVISIONAL');
  assert(result.confidence <= 35);
  assert.strictEqual(result.dataQuality.accelerationAvailable, false);
  assert(result.volumeAcceleration.missingTimeframes.includes('fifteenMinute'));
});

test('excludes a still-forming candle from acceleration evidence', () => {
  const current = session('2026-01-05', { volumes: acceleratingVolumes });
  const partialNow = timestamp('2026-01-05', 628);
  const result = volumeAcceleration({
    barsByInterval: {
      oneMinute: current.slice(-6),
      fiveMinute: current.slice(-6),
      fifteenMinute: current.slice(-6),
    },
    currentDate: '2026-01-05',
    nowMs: partialNow,
    timezone: 'UTC',
  });
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.byTimeframe.fiveMinute.sampleBars, 5);
  assert.strictEqual(result.byTimeframe.fiveMinute.state, 'INSUFFICIENT BARS');
  assert.strictEqual(result.byTimeframe.fifteenMinute.sampleBars, 3);
});

test('does not confirm a breakout from a forming 5-minute candle', () => {
  const current = session('2026-01-05', { volumes: acceleratingVolumes });
  const partialNow = timestamp('2026-01-05', 628);
  const result = buildSearchVolumeSignal({
    price: current.at(-1).c,
    intradayBars: current,
    volumeHistory5m: history,
    barsByInterval: { oneMinute: current, fiveMinute: current, fifteenMinute: current },
    levels: {
      support: [{ price: 99 }],
      resistance: [{ price: 101.9 }],
    },
    indicators: { rsi14: 62 },
    market: { trend: 'BULLISH' },
    nowMs: partialNow,
    timezone: 'UTC',
  });
  assert.notStrictEqual(result.signal.setup, 'BREAKOUT CONFIRMED');
  assert.strictEqual(result.levels.resistance.broken, false);
});

test('weights late-breaking positive news only when price and volume corroborate it', () => {
  const current = session('2026-01-05', {
    start: 100,
    step: 0.2,
    volumes: acceleratingVolumes,
  });
  const result = build({
    current,
    price: 100,
    market: { trend: 'NEUTRAL' },
    indicators: { rsi14: 50, vwap: 100, macd: { value: 0, signal: 0 } },
    news: [{
      headline: 'Company beats estimates and raises guidance after record revenue',
      publishedAt: '2026-01-05T09:45:00.000Z',
    }],
  });
  assert.strictEqual(result.signal.label, 'BUY');
  assert(result.newsImpact.bullishScore > result.newsImpact.bearishScore);
  assert.strictEqual(result.newsImpact.freshCatalystCount, 1);
  assert.strictEqual(result.newsImpact.appliedDirection, 'BULLISH');
});

test('weights late-breaking negative news only when price and volume corroborate it', () => {
  const current = session('2026-01-05', {
    start: 102.2,
    step: -0.2,
    volumes: acceleratingVolumes,
  });
  const result = build({
    current,
    price: current.at(-1).c,
    market: { trend: 'NEUTRAL' },
    indicators: { rsi14: 50, vwap: 100, macd: { value: 0, signal: 0 } },
    news: [{
      headline: 'Company downgraded after weak outlook and cuts guidance',
      publishedAt: '2026-01-05T09:45:00.000Z',
    }],
  });
  assert.strictEqual(result.signal.label, 'SELL');
  assert(result.newsImpact.bearishScore > result.newsImpact.bullishScore);
  assert.strictEqual(result.newsImpact.appliedDirection, 'BEARISH');
});

test('does not let news choose the side without matching price and volume', () => {
  const current = session('2026-01-05', {
    start: 100,
    step: 0,
    volumes: acceleratingVolumes,
  });
  const base = build({
    current,
    price: 100,
    market: { trend: 'NEUTRAL' },
    indicators: { rsi14: 50, vwap: 100, macd: { value: 0, signal: 0 } },
  });
  const withNews = build({
    current,
    price: 100,
    market: { trend: 'NEUTRAL' },
    indicators: { rsi14: 50, vwap: 100, macd: { value: 0, signal: 0 } },
    news: [{
      headline: 'Company downgraded after weak outlook and cuts guidance',
      publishedAt: '2026-01-05T09:45:00.000Z',
    }],
  });
  assert.strictEqual(withNews.signal.label, base.signal.label);
  assert.strictEqual(withNews.newsImpact.appliedDirection, null);
});

test('ignores stale directional headlines older than seven days', () => {
  const result = newsCatalystScore([{
    headline: 'Company downgraded and cuts guidance',
    publishedAt: '2025-12-20T09:45:00.000Z',
  }], nowMs);
  assert.strictEqual(result.bullishScore, 0);
  assert.strictEqual(result.bearishScore, 0);
  assert.strictEqual(result.freshCatalystCount, 0);
});

test('rejects future-dated news and does not double-count overlapping words', () => {
  const future = newsCatalystScore([{
    headline: 'Company beats estimates',
    publishedAt: '2026-01-06T09:45:00.000Z',
  }], nowMs);
  assert.strictEqual(future.bullishScore, 0);

  const exact = newsCatalystScore([{
    headline: 'Company beats estimates',
    publishedAt: '2026-01-05T09:45:00.000Z',
  }], nowMs);
  assert.strictEqual(exact.bullishScore, 12);
});

test('does not confirm a stale support break and caps its confidence', () => {
  const current = session('2026-01-05', {
    start: 102.2,
    step: -0.2,
    volumes: acceleratingVolumes,
  });
  const result = build({
    current,
    price: current.at(-1).c,
    levels: { support: [{ price: 100.5 }], resistance: [{ price: 103 }] },
    indicators: { rsi14: 42, vwap: 101.5, macd: { value: -1.1, signal: -0.7 } },
    market: { trend: 'BEARISH' },
    freshness: {
      oneMinute: { fresh: false },
      fiveMinute: { fresh: false },
      fifteenMinute: { fresh: false },
    },
  });
  assert.strictEqual(result.signal.label, 'SELL');
  assert.strictEqual(result.signal.stage, 'PROVISIONAL');
  assert.notStrictEqual(result.signal.setup, 'SUPPORT BREAKDOWN');
  assert(result.confidence <= 35);
});

test('uses the latest completed daily bar for pivots without skipping closed sessions', () => {
  const bars = [
    { t: '2026-01-02', o: 100, h: 102, l: 99, c: 101 },
    { t: '2026-01-05', o: 101, h: 104, l: 100, c: 103 },
  ];
  const closed = selectCompletedDailyBar(bars, {
    nowMs: Date.parse('2026-01-06T02:00:00Z'),
    marketState: 'CLOSED',
    timezone: 'UTC',
  });
  assert.strictEqual(closed.t, '2026-01-05');

  const forming = selectCompletedDailyBar(bars, {
    nowMs: Date.parse('2026-01-05T15:00:00Z'),
    marketState: 'REGULAR',
    timezone: 'UTC',
  });
  assert.strictEqual(forming.t, '2026-01-02');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);