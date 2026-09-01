'use strict';

const assert = require('assert');
const { buildHistoricalForecast, validateBars } = require('../lib/historical-forecast');

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

if (!process.exitCode) console.log(`\nResults: ${passed} passed, 0 failed`);