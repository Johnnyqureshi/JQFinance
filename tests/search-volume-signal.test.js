'use strict';

const assert = require('assert');
const {
  buildSearchVolumeSignal,
  newsCatalystScore,
  selectCompletedDailyBar,
  structureForBars,
  timeOfDayRelativeVolume,
  volumeAcceleration,
  selectCrypto24hReference,
  canonicalCrypto5mSeries,
  crypto24hStats,
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

function structuredSession(date, {
  highStructure = 'HH',
  lowStructure = 'HL',
  volumes = acceleratingVolumes,
  breakout = false,
} = {}) {
  const bars = session(date, { start: 100, step: 0.2, volumes });
  const firstHigh = highStructure === 'HH' ? 102 : 103;
  const secondHigh = highStructure === 'HH' ? 103 : 102.5;
  const firstLow = 98;
  const secondLow = lowStructure === 'HL' ? 99 : 97;
  bars.forEach((bar, index) => {
    bar.h = 101;
    bar.l = 100;
    if (index === 2) bar.h = firstHigh;
    if (index === 4) bar.l = firstLow;
    if (index === 6) bar.h = secondHigh;
    if (index === 8) bar.l = secondLow;
  });
  if (breakout) {
    bars[10].c = secondHigh + 0.3;
    bars[11].c = secondHigh + 0.5;
  }
  return bars;
}

const history = [
  ...session('2026-01-02'),
  ...session('2026-01-03'),
  ...session('2026-01-04'),
];
const acceleratingVolumes = [...Array(9).fill(120), ...Array(3).fill(300)];
const nowMs = timestamp('2026-01-05', 630);

function build({
  current = structuredSession('2026-01-05'),
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
  dailyBars = [],
  relativeDailyVolume = null,
  dayRangePosition = null,
  macroPressure = [],
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
    relativeDailyVolume,
    dayRangePosition,
    dailyBars,
    macroPressure,
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

test('keeps bullish structure near resistance as a breakout watch, not a BUY', () => {
  const result = build({});
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.setup, 'BULLISH STRUCTURE — RESISTANCE TEST');
  assert.strictEqual(result.signal.stage, 'WAITING');
  assert.strictEqual(result.signal.direction, 'NEUTRAL');
  assert.strictEqual(result.entryQuality.trendBias, 'BULLISH');
  assert.strictEqual(result.entryQuality.entryAllowed, false);
  assert(result.confidence < 70);
  assert(result.relativeVolume.value >= 1.5);
  assert(result.volumeAcceleration.ratio > 1.1);
  assert(result.bullishVolumeScore > result.bearishVolumeScore);
  assert(result.pumpPressure >= 50);
});

test('blocks a bullish BUY when immediate resistance offers poor risk/reward', () => {
  const result = build({
    levels: {
      support: [{ price: 99 }],
      resistance: [{ price: 102.3 }],
    },
    price: 102.2,
  });
  assert.equal(result.signal.label, 'WAIT');
  assert.equal(result.signal.setup, 'BULLISH STRUCTURE — RESISTANCE TEST');
  assert(result.entryQuality.distanceToResistancePct < 0.5);
  assert(result.entryQuality.blockedReasons.includes('UNCONFIRMED_RESISTANCE_TEST'));
  assert(result.reasons.some(reason => /directly beneath resistance/i.test(reason)));
});

test('detects a failed breakout as a bull trap instead of returning BUY', () => {
  const current = structuredSession('2026-01-05');
  current[10].h = 103.2;
  current[10].c = 102.8;
  current[11].c = 102.2;
  const result = build({
    current,
    price: 102.2,
    levels: { support: [{ price: 99 }], resistance: [{ price: 102.5 }] },
  });
  assert.equal(result.signal.label, 'WAIT');
  assert.equal(result.signal.setup, 'BULL TRAP');
  assert.equal(result.entryQuality.breakoutState, 'BULL TRAP');
  assert(result.reasons.some(reason => /failed to hold/i.test(reason)));
});

test('requires a level break, volume expansion, and follow-through for confirmation', () => {
  const result = build({
    levels: {
      support: [{ price: 99 }],
      resistance: [{ price: 101.5 }, { price: 110 }],
    },
    dayChangePct: 2,
    dayRangePosition: 0.65,
    dailyBars: [96, 97, 98, 99, 100].map(c => ({ c })),
    indicators: {
      rsi14: 62,
      vwap: 101,
      sma20: 99,
      sma50: 96,
      sma200: 90,
      atr: 2,
      macd: { value: 1.2, signal: 0.8 },
    },
    macroPressure: [{ key: 'market', state: 'BULLISH' }],
  });
  assert.strictEqual(result.signal.label, 'BUY');
  assert.strictEqual(result.signal.setup, 'BREAKOUT CONFIRMED');
  assert.strictEqual(result.signal.stage, 'CONFIRMED');
  assert.strictEqual(result.levels.resistance.broken, true);
  assert.strictEqual(result.levels.resistance.followThrough, true);
});

test('does not confirm a crypto breakout from aggregate volume without verified spot participation', () => {
  const current = structuredSession('2026-01-05', { breakout: true });
  const result = buildSearchVolumeSignal({
    price: current.at(-1).c,
    intradayBars: current,
    volumeHistory5m: history,
    barsByInterval: { oneMinute: current, fiveMinute: current, fifteenMinute: current },
    levels: { support: [{ price: 99 }], resistance: [{ price: 101.5 }] },
    indicators: { rsi14: 62, vwap: 101, macd: { value: 1.2, signal: 0.8 } },
    nowMs,
    timezone: 'UTC',
    sessionMode: 'continuous',
    assetClass: 'crypto',
    spotVolumeConfirmed: false,
  });
  assert.equal(result.signal.label, 'WAIT');
  assert.equal(result.signal.setup, 'BULLISH PRICE ACTION — SQUEEZE-DRIVEN BREAKOUT NOT CONFIRMED');
  assert.equal(result.entryQuality.volumeOrigin, 'SPOT/FUTURES PARTICIPATION UNVERIFIED');
  assert(result.entryQuality.blockedReasons.includes('ORGANIC_SPOT_VOLUME_UNVERIFIED'));
});

test('waits when a support breakdown lacks confirmed bearish swing structure', () => {
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
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.direction, 'NEUTRAL');
  assert.strictEqual(result.signal.stage, 'WAITING');
  assert.strictEqual(result.levels.support.broken, true);
  assert(result.bearishVolumeScore > result.bullishVolumeScore);
});

test('does not allow a bullish signal from elevated RSI, resistance, or high volume alone', () => {
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
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.stage, 'WAITING');
  assert.strictEqual(result.signal.direction, 'NEUTRAL');
  assert.strictEqual(result.confidence, 0);
});

test('uses the documented weighted confidence and keeps it bounded', () => {
  const result = build({});
  const totalWeight = Object.values(result.weights).reduce((sum, value) => sum + value, 0);
  assert.strictEqual(+totalWeight.toFixed(2), 1);
  assert(result.confidence >= 0 && result.confidence <= 100);
  assert.strictEqual(result.weights.trend, 0.25);
  assert.strictEqual(result.weights.momentum, 0.15);
  assert.strictEqual(result.weights.volume, 0.15);
  assert.strictEqual(result.weights.entryQuality, 0.20);
  assert.strictEqual(result.weights.supportResistance, 0.10);
  assert.strictEqual(result.weights.extensionChase, 0.10);
  assert.strictEqual(result.weights.marketMacro, 0.05);
});

test('classifies a MSTR-style +15% overbought extension near resistance as bullish but not buyable', () => {
  const result = build({
    price: 102.2,
    dayChangePct: 15,
    relativeDailyVolume: 2.2,
    dayRangePosition: 0.92,
    dailyBars: [80, 84, 89, 95, 100].map(c => ({ c })),
    levels: {
      support: [{ price: 95, label: 'Completed-session support' }],
      resistance: [{ price: 103, label: 'Multi-touch resistance' }],
    },
    indicators: {
      rsi14: 79,
      vwap: 98,
      sma20: 92,
      sma50: 82,
      sma200: 60,
      atr: 2,
      macd: { value: 1.5, signal: 0.8 },
    },
    macroPressure: [
      { key: 'rates', state: 'BEARISH' },
      { key: 'risk', state: 'BEARISH' },
    ],
  });
  assert.equal(result.signal.label, 'WAIT');
  assert.equal(result.signal.state, 'BULLISH — EXTENDED');
  assert.equal(result.entryQuality.trendBias, 'BULLISH');
  assert.equal(result.entryQuality.entryAllowed, false);
  assert.equal(result.entryQuality.chaseRiskLabel, 'HIGH');
  assert(result.entryQuality.score < 50);
  assert(result.confidence < 60);
  assert(result.reasons.some(reason => /Bullish trend and momentum remain intact/i.test(reason)));
  assert(result.confidenceBreakdown.parts.marketMacro < 50);
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
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.stage, 'WAITING');
  assert.strictEqual(result.confidence, 0);
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
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.stage, 'WAITING');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.dataQuality.currentVolumeFresh, false);
  assert.strictEqual(result.dataQuality.accelerationAvailable, false);
  assert(result.dataQuality.missing.includes('Current 5-minute volume is stale'));
});

test('waits when one required acceleration timeframe is missing', () => {
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
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.stage, 'WAITING');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.dataQuality.accelerationAvailable, false);
  assert(result.volumeAcceleration.missingTimeframes.includes('fifteenMinute'));
});

test('MSTR-like +10% day with insufficient structure and missing 15m acceleration waits', () => {
  const current = session('2026-01-05', { start: 100, step: 1, volumes: acceleratingVolumes });
  const result = buildSearchVolumeSignal({
    price: 110,
    dayChangePct: 10,
    intradayBars: current,
    volumeHistory5m: history,
    barsByInterval: { oneMinute: current, fiveMinute: current, fifteenMinute: current.slice(0, 5) },
    levels: { support: [{ price: 99 }], resistance: [{ price: 115 }] },
    nowMs,
    timezone: 'UTC',
  });
  assert.equal(result.structure.structuralBias, 'INSUFFICIENT');
  assert.equal(result.signal.label, 'WAIT');
  assert.equal(result.signal.direction, 'NEUTRAL');
  assert.equal(result.signal.stage, 'WAITING');
  assert.equal(result.confidence, 0);
  assert(result.dataQuality.missing.includes('Short-term volume acceleration'));
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
  const current = structuredSession('2026-01-05');
  const result = build({
    current,
    price: 100,
    market: { trend: 'NEUTRAL' },
    indicators: {
      rsi14: 50,
      vwap: 100,
      sma20: 99,
      sma50: 96,
      sma200: 90,
      atr: 2,
      macd: { value: 0, signal: 0 },
    },
    dayChangePct: 1,
    dayRangePosition: 0.5,
    dailyBars: [96, 97, 98, 99, 99.5].map(c => ({ c })),
    macroPressure: [{ key: 'market', state: 'NEUTRAL' }],
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

test('does not let breakout confirmation bypass severe extension and chase controls', () => {
  const result = build({
    levels: {
      support: [{ price: 99 }],
      resistance: [{ price: 101.5 }, { price: 112 }],
    },
    dayChangePct: 15,
    dayRangePosition: 0.95,
    dailyBars: [82, 86, 91, 96, 100].map(c => ({ c })),
    relativeDailyVolume: 2.5,
    indicators: {
      rsi14: 82,
      vwap: 98,
      sma20: 88,
      sma50: 78,
      sma200: 55,
      atr: 2,
      macd: { value: 2, signal: 1 },
    },
    macroPressure: [{ key: 'market', state: 'BULLISH' }],
  });
  assert.equal(result.signal.setup, 'BREAKOUT CONFIRMED');
  assert.equal(result.signal.label, 'WAIT');
  assert.equal(result.signal.state, 'BULLISH — EXTENDED');
  assert.equal(result.entryQuality.entryAllowed, false);
  assert(result.entryQuality.chaseRisk >= 50);
});

test('keeps a confirmed breakout on watch when measured upside room and risk reward are insufficient', () => {
  const result = build({
    levels: {
      support: [{ price: 99 }],
      resistance: [{ price: 101.5 }, { price: 103.7 }],
    },
    dayChangePct: 2,
    dayRangePosition: 0.7,
    dailyBars: [96, 97, 98, 99, 100].map(c => ({ c })),
    indicators: {
      rsi14: 62,
      vwap: 101,
      sma20: 99,
      sma50: 96,
      sma200: 90,
      atr: 2,
      macd: { value: 1.2, signal: 0.8 },
    },
    macroPressure: [{ key: 'market', state: 'BULLISH' }],
  });
  assert.equal(result.signal.setup, 'BREAKOUT CONFIRMED');
  assert.equal(result.signal.label, 'WAIT');
  assert.equal(result.signal.state, 'BREAKOUT WATCH');
  assert.equal(result.entryQuality.entryAllowed, false);
  assert(result.entryQuality.distanceToResistancePct < 2);
  assert(result.entryQuality.riskRewardToFirstResistance < 1.5);
});

test('scores missing entry inputs as unavailable instead of favorable evidence', () => {
  const result = build({
    indicators: { rsi14: 62, vwap: 101 },
    dayChangePct: null,
    dailyBars: [],
    dayRangePosition: null,
    macroPressure: [],
  });
  assert.equal(result.confidenceBreakdown.parts.trend, null);
  assert.equal(result.confidenceBreakdown.parts.entryQuality, null);
  assert.equal(result.confidenceBreakdown.parts.extensionChase, null);
  assert.equal(result.confidenceBreakdown.parts.marketMacro, null);
  assert.deepEqual(
    result.confidenceBreakdown.missingParts.sort(),
    ['entryQuality', 'extensionChase', 'marketMacro', 'trend'].sort(),
  );
  assert.equal(result.entryQuality.score, null);
  assert(result.dataQuality.missing.includes('20 SMA'));
  assert(result.dataQuality.missing.includes('Verified market/macro pressure'));
});

test('classifies confirmed HH and HL pivots as bullish structure', () => {
  const structure = structureForBars(structuredSession('2026-01-05'));
  assert.strictEqual(structure.highStructure, 'HH');
  assert.strictEqual(structure.lowStructure, 'HL');
  assert.strictEqual(structure.structuralBias, 'BULLISH');
});

test('classifies confirmed LH and LL pivots as bearish structure', () => {
  const structure = structureForBars(structuredSession('2026-01-05', {
    highStructure: 'LH',
    lowStructure: 'LL',
  }));
  assert.strictEqual(structure.highStructure, 'LH');
  assert.strictEqual(structure.lowStructure, 'LL');
  assert.strictEqual(structure.structuralBias, 'BEARISH');
});

test('treats LH and HL as mixed until the lower high is broken and held', () => {
  const structure = structureForBars(structuredSession('2026-01-05', {
    highStructure: 'LH',
    lowStructure: 'HL',
  }));
  assert.strictEqual(structure.structuralBias, 'MIXED');
  assert.strictEqual(structure.breakoutConfirmed, false);
});

test('confirms bullish transition only after two closes hold above the lower high', () => {
  const structure = structureForBars(structuredSession('2026-01-05', {
    highStructure: 'LH',
    lowStructure: 'HL',
    breakout: true,
  }));
  assert.strictEqual(structure.structuralBreakLevel, 102.5);
  assert.strictEqual(structure.breakoutConfirmed, true);
  assert.strictEqual(structure.structuralBias, 'BULLISH');
});

test('reports insufficient structure when confirmed pivots are unavailable', () => {
  const structure = structureForBars(session('2026-01-05'));
  assert.strictEqual(structure.highStructure, 'INSUFFICIENT');
  assert.strictEqual(structure.lowStructure, 'INSUFFICIENT');
  assert.strictEqual(structure.structuralBias, 'INSUFFICIENT');
});

test('prohibits BUY from higher lows alone while lower highs remain intact', () => {
  const current = structuredSession('2026-01-05', {
    highStructure: 'LH',
    lowStructure: 'HL',
  });
  const result = build({
    current,
    price: current.at(-1).c,
    indicators: { rsi14: 62, vwap: 99, macd: { value: 2, signal: 1 } },
    market: { trend: 'BULLISH' },
    news: [{ headline: 'Company beats estimates and raises guidance', publishedAt: '2026-01-05T09:45:00.000Z' }],
  });
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.direction, 'NEUTRAL');
  assert.strictEqual(result.signal.stage, 'WAITING');
  assert.strictEqual(result.structure.structuralBias, 'MIXED');
  assert(result.reasons.some(reason => /lower highs remain intact/i.test(reason)));
  assert(!result.reasons.includes('Higher lows are developing'));
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
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.direction, 'NEUTRAL');
  assert.strictEqual(result.signal.stage, 'WAITING');
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
  assert.strictEqual(result.signal.label, 'WAIT');
  assert.strictEqual(result.signal.stage, 'WAITING');
  assert.notStrictEqual(result.signal.setup, 'SUPPORT BREAKDOWN');
  assert.strictEqual(result.confidence, 0);
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

test('selects an exact and near-24h crypto reference, but rejects stale or malformed closes', () => {
  const target = timestamp('2026-01-05', 1200);
  assert.strictEqual(selectCrypto24hReference([{ t: target - 24 * 60 * 60 * 1000, c: 100 }], target).c, 100);
  assert.strictEqual(selectCrypto24hReference([{ t: target - 24 * 60 * 60 * 1000 + 10 * 60 * 1000, c: 101 }], target).c, 101);
  assert.strictEqual(selectCrypto24hReference([{ t: target - 24 * 60 * 60 * 1000 - 16 * 60 * 1000, c: 100 }], target), null);
  assert.strictEqual(selectCrypto24hReference([{ t: target - 24 * 60 * 60 * 1000, c: 0 }], target), null);
  assert.strictEqual(selectCrypto24hReference([{ t: target - 24 * 60 * 60 * 1000, c: 'bad' }], target), null);
});

test('canonical crypto series sorts bars, excludes forming/malformed rows, and computes 24H stats', () => {
  const now = timestamp('2026-01-05', 120);
  const bars = [
    { t: now - 5 * 60_000, o: 11, h: 13, l: 10, c: 12, v: 5 },
    { t: now - 15 * 60_000, o: 9, h: 10, l: 8, c: 9, v: 3 },
    { t: now + 5 * 60_000, o: 20, h: 21, l: 19, c: 20, v: 9 },
    { t: now - 10 * 60_000, o: 10, h: 11, l: 9, c: null, v: 4 },
  ];
  const canonical = canonicalCrypto5mSeries(bars, [{ t: now - 30 * 60_000, o: 1, h: 1, l: 1, c: 1, v: 1 }], now);
  assert.deepStrictEqual(canonical.map(bar => bar.c), [9, 12]);
  const stats = crypto24hStats(canonical);
  assert.strictEqual(stats.high, 13);
  assert.strictEqual(stats.low, 8);
  assert.strictEqual(stats.volume, 8);
  assert.strictEqual(stats.vwap, (9 * 3 + 12 * 5) / 8);
});

test('continuous mode includes overnight bars in structure, UTC-day RVOL, and acceleration', () => {
  const makeBars = (date, startMinute, count, volume = 100) => Array.from({ length: count }, (_, i) => ({
    t: timestamp(date, startMinute + i * 5),
    o: 100 + i * 0.1, h: 100.3 + i * 0.1, l: 99.8 + i * 0.1, c: 100 + i * 0.1, v: volume,
  }));
  const overnight = makeBars('2026-01-05', 60, 18, 200);
  const history = [
    ...makeBars('2026-01-02', 60, 18, 100),
    ...makeBars('2026-01-03', 60, 18, 100),
    ...makeBars('2026-01-04', 60, 18, 100),
  ];
  const result = buildSearchVolumeSignal({
    price: 100.5,
    intradayBars: overnight,
    volumeHistory5m: history,
    barsByInterval: { oneMinute: overnight, fiveMinute: overnight, fifteenMinute: overnight },
    nowMs: timestamp('2026-01-05', 155),
    timezone: 'UTC',
    sessionMode: 'continuous',
    minimumVolumeSessions: 3,
  });
  assert.strictEqual(result.sessionMode, 'continuous');
  assert.strictEqual(result.relativeVolume.available, true);
  assert(result.relativeVolume.reason.includes('UTC-day RVOL'));
  assert.strictEqual(result.volumeAcceleration.available, true);
  assert.strictEqual(result.structure.priceRising, true);
  assert(!result.reasons.some(reason => /regular session|time-of-day/i.test(reason)));
});

test('regular mode retains session filtering and never admits overnight bars', () => {
  const overnight = Array.from({ length: 6 }, (_, i) => ({
    t: timestamp('2026-01-05', 60 + i * 5), session: 'post',
    o: 100, h: 101, l: 99, c: 100 + i, v: 100,
  }));
  const result = buildSearchVolumeSignal({
    price: 105,
    intradayBars: overnight,
    volumeHistory5m: overnight,
    barsByInterval: { oneMinute: overnight, fiveMinute: overnight, fifteenMinute: overnight },
    nowMs: timestamp('2026-01-05', 95),
    timezone: 'UTC',
  });
  assert.strictEqual(result.relativeVolume.available, false);
  assert.strictEqual(result.structure.highStructure, 'INSUFFICIENT');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);