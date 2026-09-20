'use strict';

const assert = require('assert');
const {
  buildHistoricalForecast,
  buildWalkForwardValidationReport,
  validateBars,
} = require('../lib/historical-forecast');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n`, error);
    process.exitCode = 1;
  }
}

function buildHistory(cycles = 16) {
  const bars = [];
  const start = Date.UTC(2010, 0, 4);
  let day = 0;
  const add = (close) => {
    const date = new Date(start + day++ * 86400000).toISOString().slice(0, 10);
    bars.push({ t: date, o: close * 0.998, h: close * 1.012, l: close * 0.987, c: close, v: 1_000_000 });
  };
  const pattern = Array.from({ length: 90 }, (_, i) => 100 + Math.sin(i / 8) * 3 + i * 0.045);
  for (let cycle = 0; cycle < cycles; cycle++) {
    pattern.forEach(value => add(value));
    const bullish = cycle % 2 === 0;
    for (let i = 1; i <= 30; i++) add(pattern.at(-1) * (1 + (bullish ? 1 : -1) * i * 0.0018));
  }
  pattern.forEach(value => add(value));
  return bars;
}

function buildRegimeHistory(trainingCycles = 20, unseenCycles = 10) {
  const bars = [];
  const start = Date.UTC(2000, 0, 3);
  let day = 0;
  const add = close => {
    const date = new Date(start + day++ * 86400000).toISOString().slice(0, 10);
    bars.push({ t: date, o: close * 0.998, h: close * 1.012, l: close * 0.987, c: close, v: 1_000_000 });
  };
  const pattern = Array.from({ length: 90 }, (_, i) => 100 + Math.sin(i / 8) * 3 + i * 0.045);
  for (let cycle = 0; cycle < trainingCycles + unseenCycles; cycle++) {
    pattern.forEach(value => add(value));
    const bullish = cycle < trainingCycles;
    for (let i = 1; i <= 30; i++) add(pattern.at(-1) * (1 + (bullish ? 1 : -1) * i * 0.0018));
  }
  return bars;
}

console.log('\nHistorical forecast engine\n');

test('validates clean OHLCV history and rejects malformed rows', () => {
  const checked = validateBars([
    { t: '2020-01-02', o: 10, h: 11, l: 9, c: 10.5, v: 100 },
    { t: '2020-01-03', o: 10, h: 9, l: 8, c: 9, v: 100 },
  ]);
  assert.equal(checked.bars.length, 1);
  assert.equal(checked.quality.invalidCount, 1);
});

test('withholds probabilities when the clean historical sample is insufficient', () => {
  const bars = buildHistory(1).slice(-130);
  const result = buildHistoricalForecast({ ticker: 'TEST', bars, lookback: 90, horizon: 30 });
  assert.equal(result.status, 'INSUFFICIENT_HISTORICAL_DATA');
  assert.equal(result.probabilities, null);
});

test('builds normalized, weighted historical outcomes only from prior windows', () => {
  const bars = buildHistory();
  const result = buildHistoricalForecast({ ticker: 'TEST', bars, lookback: 90, horizon: 30 });
  assert.equal(result.available, true);
  assert.equal(result.displayable, true);
  assert.ok(result.matchCount >= 10);
  assert.ok(result.closest.similarity >= 0 && result.closest.similarity <= 1);
  const total = result.probabilities.bull + result.probabilities.bear + result.probabilities.neutral;
  assert.ok(Math.abs(total - 1) < 1e-10);
  assert.equal(result.paths.current.length, 90);
  assert.equal(result.paths.current.at(-1), 100);
  assert.equal(result.paths.closest.length, 31);
  assert.equal(result.paths.closest[0], 100);
  assert.equal(result.paths.analogs.length, result.matchCount);
  assert.ok(result.paths.analogs.every(analog =>
    typeof analog.date === 'string'
    && Array.isArray(analog.path)
    && analog.path.length === 31
    && analog.path[0] === 100));
  if (result.paths.bullish) assert.equal(result.paths.bullish.average[0], 100);
  if (result.paths.bearish) assert.equal(result.paths.bearish.average[0], 100);
});

test('returns read-only historical match metrics without exposing chart internals', () => {
  const result = buildHistoricalForecast({ ticker: 'TEST', bars: buildHistory(), lookback: 90, horizon: 30 });
  assert.ok(result.displayable);
  assert.equal(result.matches.length, result.matchCount);
  assert.ok(result.matches.every(match =>
    typeof match.date === 'string'
    && Number.isFinite(match.similarity)
    && ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(match.outcome)
    && Number.isFinite(match.forwardReturn)
    && Number.isFinite(match.maxRise)
    && Number.isFinite(match.maxDrawdown)
    && !Object.hasOwn(match, 'forwardPath')
    && !Object.hasOwn(match, 'endIndex')));
});

test('rejects out-of-order history through the clean-history sample gate', () => {
  const bars = buildHistory();
  [bars[0], bars[1]] = [bars[1], bars[0]];
  const result = buildHistoricalForecast({ ticker: 'TEST', bars, lookback: 90, horizon: 30 });
  assert.equal(result.dataQuality.clean, false);
  assert.equal(result.status, 'INSUFFICIENT_HISTORICAL_DATA');
  assert.equal(result.matches.length, 0);
});

test('purges outcome windows overlapping the current reference pattern', () => {
  const bars = buildHistory();
  const lookback = 90;
  const horizon = 30;
  const result = buildHistoricalForecast({ ticker: 'TEST', bars, lookback, horizon });
  const lastEligibleDate = bars.at(-(lookback + horizon + 1)).t;
  assert.ok(result.matches.every(match => match.date <= lastEligibleDate));
});

test('uses embargoed spans instead of overlapping analog observations', () => {
  const bars = buildHistory();
  const horizon = 30;
  const lookback = 90;
  const result = buildHistoricalForecast({ ticker: 'TEST', bars, lookback, horizon });
  const indexFor = date => bars.findIndex(bar => bar.t === date);
  const indexes = result.matches.map(match => indexFor(match.date));
  for (let i = 0; i < indexes.length; i++) {
    for (let j = i + 1; j < indexes.length; j++) {
      assert.ok(Math.abs(indexes[i] - indexes[j]) >= lookback + horizon);
    }
  }
  assert.equal(result.paths.closest.length, horizon + 1);
});

test('caps weak evidence and avoids a directional display for too few separated matches', () => {
  const bars = buildHistory(4);
  const result = buildHistoricalForecast({ ticker: 'TEST', bars, lookback: 90, horizon: 30 });
  assert.equal(result.status, 'LIMITED_HISTORICAL_SAMPLE');
  assert.equal(result.displayable, false);
  assert.equal(result.probabilities, null);
  assert.ok(result.robustness <= 3);
});

test('builds a deterministic read-only walk-forward report by lookback and horizon', () => {
  const input = {
    ticker: 'TEST',
    bars: buildHistory(),
    lookbacks: [90],
    horizons: [30],
    step: 30,
  };
  const first = buildWalkForwardValidationReport(input);
  const second = buildWalkForwardValidationReport(input);
  assert.deepStrictEqual(first, second);
  assert.equal(first.available, true);
  assert.equal(first.mode, 'READ_ONLY');
  assert.equal(first.liveExecutionAllowed, false);
  assert.equal(first.automationChanged, false);
  assert.equal(first.groups.length, 1);
  assert.equal(first.groups[0].lookback, 90);
  assert.equal(first.groups[0].horizon, 30);
  assert.ok(first.groups[0].evaluatedCalls >= 10);
  assert.equal(first.groups[0].overlappingCallsExcluded, 0);
  assert.ok(Number.isFinite(first.groups[0].brierScore));
  assert.ok(first.groups[0].predictedProbabilityRanges.bull);
  assert.ok(first.groups[0].reliability.bear.length > 0);
  assert.ok(first.calls.every(call =>
    call.futureDataUsedByForecast === false
    && call.forecastUsedBarsThrough === call.asOf
    && call.outcomeDate > call.asOf));
});

test('keeps future outcome bars out of the historical forecast call', () => {
  const bars = buildHistory();
  const asOfIndex = bars.length - 31;
  const options = {
    ticker: 'TEST',
    lookbacks: [90],
    horizons: [30],
    startIndex: asOfIndex,
    endIndex: asOfIndex,
    step: 1,
    minSample: 1,
  };
  const original = buildWalkForwardValidationReport({ ...options, bars });
  const changedFuture = bars.map((bar, index) => {
    if (index <= asOfIndex) return { ...bar };
    const close = bar.c * 0.7;
    return { ...bar, o: close * 0.998, h: close * 1.012, l: close * 0.987, c: close };
  });
  const changed = buildWalkForwardValidationReport({ ...options, bars: changedFuture });
  assert.equal(original.calls.length, 1);
  assert.equal(changed.calls.length, 1);
  assert.deepStrictEqual(original.calls[0].probabilities, changed.calls[0].probabilities);
  assert.deepStrictEqual(original.calls[0].probabilityIntervals, changed.calls[0].probabilityIntervals);
  assert.notEqual(original.calls[0].realizedReturn, changed.calls[0].realizedReturn);
});

test('flags too-small point-in-time calibration samples', () => {
  const bars = buildHistory();
  const report = buildWalkForwardValidationReport({
    bars,
    lookbacks: [90],
    horizons: [30],
    startIndex: bars.length - 31,
    endIndex: bars.length - 31,
    step: 1,
    minSample: 10,
  });
  assert.equal(report.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(report.groups[0].status, 'INSUFFICIENT_SAMPLE');
  assert.ok(report.flags.some(flag => flag.code === 'TOO_SMALL_SAMPLE'));
});

test('does not count overlapping outcome windows as independent calibration evidence', () => {
  const trainingCycles = 20;
  const bars = buildRegimeHistory(trainingCycles, 2);
  const firstUnseenForecast = trainingCycles * 120 + 89;
  const report = buildWalkForwardValidationReport({
    bars,
    lookbacks: [90],
    horizons: [30],
    startIndex: firstUnseenForecast,
    endIndex: firstUnseenForecast + 25,
    step: 5,
    minSample: 2,
  });
  assert.ok(report.groups[0].displayableCalls >= 2);
  assert.equal(report.groups[0].independentEvaluatedCalls, 1);
  assert.ok(report.groups[0].overlappingCallsExcluded >= 1);
  assert.equal(report.groups[0].status, 'INSUFFICIENT_SAMPLE');
  assert.ok(report.flags.some(flag => flag.code === 'TOO_SMALL_SAMPLE'));
});

test('flags overconfident probabilities that fail on a later unseen regime', () => {
  const trainingCycles = 20;
  const bars = buildRegimeHistory(trainingCycles, 10);
  const firstUnseenForecast = trainingCycles * 120 + 89;
  const report = buildWalkForwardValidationReport({
    bars,
    lookbacks: [90],
    horizons: [30],
    startIndex: firstUnseenForecast,
    step: 120,
    minSample: 10,
  });
  assert.equal(report.groups[0].evaluatedCalls, 10);
  assert.equal(report.status, 'POOR_CALIBRATION');
  assert.equal(report.groups[0].status, 'POOR_CALIBRATION');
  assert.ok(report.flags.some(flag => flag.code === 'POOR_CALIBRATION'));
  assert.ok(report.groups[0].realizedOutcomeRates.bear > report.groups[0].meanPredictedProbabilities.bear);
});

if (!process.exitCode) console.log(`\nResults: ${passed} passed, 0 failed`);