const assert = require('assert');
const { calculateRrgStyle } = require('../public/js/rrg-style.js');

function bars(closes, start = '2026-01-01') {
  return closes.map((c, index) => {
    const day = new Date(`${start}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + index);
    return { t: day.toISOString(), c };
  });
}

const benchmark = bars(Array.from({ length: 31 }, () => 100), '2026-01-01');
const leading = bars(Array.from({ length: 31 }, (_, index) => 100 + index), '2026-01-01');
const result = calculateRrgStyle(leading, benchmark, {
  now: Date.parse('2026-02-15T12:00:00Z'),
});

assert.strictEqual(result.available, true);
assert.strictEqual(result.quadrant, 'Leading');
assert(result.rsRatio > 100);
assert(result.rsMomentum > 100);
assert.strictEqual(result.benchmark, 'SPY');

const insufficient = calculateRrgStyle(
  bars([100, 101], '2026-01-01'),
  bars([100, 100], '2026-01-01'),
  { now: Date.parse('2026-02-15T12:00:00Z') },
);
assert.strictEqual(insufficient.available, false);
assert.strictEqual(insufficient.reason, 'INSUFFICIENT_COMPLETED_BARS');

const currentSector = bars(Array.from({ length: 25 }, () => 100), '2026-01-01');
const currentBenchmark = bars(Array.from({ length: 25 }, () => 100), '2026-01-01');
currentSector.push({ t: '2026-01-26T16:00:00Z', c: 100 });
currentBenchmark.push({ t: '2026-01-26T16:00:00Z', c: 100 });
const currentDay = calculateRrgStyle(
  currentSector,
  currentBenchmark,
  { now: Date.parse('2026-01-26T12:00:00Z') },
);
assert.strictEqual(currentDay.observations, 25, 'current partial day must not be used');

console.log('RRG-style tests passed');