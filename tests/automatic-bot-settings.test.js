'use strict';

const assert = require('assert');
const {
  clampPositionDollars,
  serverOwnedConfig,
  serverOwnedMomentumConfig,
  shouldAutoEnableAfterConnection,
} = require('../lib/automatic-bot-settings');

assert.strictEqual(clampPositionDollars(2_500, 1_000), 2_500);
assert.strictEqual(clampPositionDollars(-10, 1_000), 1);
assert.strictEqual(clampPositionDollars('not-a-number', 1_000), 1_000);
assert.strictEqual(clampPositionDollars(2_000_000, 1_000), 1_000_000);

const pmhDefaults = {
  minScore: 80,
  maxRiskDollars: 100,
  maxPositionDollars: 5_000,
};
const pmh = serverOwnedConfig(
  pmhDefaults,
  { minScore: 1, maxRiskDollars: 99_999, maxPositionDollars: 3_000 },
  4_000
);
assert.deepStrictEqual(pmh, {
  minScore: 80,
  maxRiskDollars: 100,
  maxPositionDollars: 4_000,
});

const momentumDefaults = {
  positionMode: 'fixed',
  positionValue: 1_000,
  minScore: 2,
  stopPercent: 5,
};
const momentum = serverOwnedMomentumConfig(
  momentumDefaults,
  { positionMode: 'fixed', positionValue: 2_000, minScore: 0, stopPercent: 25 },
  3_500
);
assert.deepStrictEqual(momentum, {
  positionMode: 'fixed',
  positionValue: 3_500,
  maxPositionDollars: 3_500,
  minScore: 2,
  stopPercent: 5,
});

assert.strictEqual(shouldAutoEnableAfterConnection('paper'), true);
assert.strictEqual(shouldAutoEnableAfterConnection('live'), false);
assert.strictEqual(shouldAutoEnableAfterConnection(), false);

console.log('automatic bot settings tests passed');