'use strict';
const assert = require('node:assert/strict');
const { evaluateLiquidity, validateLiquidityPolicy, DEFAULT_LIQUIDITY_POLICY: defaults } = require('../lib/liquidity-policy');

const NOW = Date.parse('2026-09-14T15:00:00Z');
const good = {
  price: 10, volume: 100000, bid: 9.95, ask: 10.05, changePct: 5,
  now: NOW, marketState: 'REGULAR',
  priceTimestamp: NOW - 1000, volumeTimestamp: NOW - 1000, quoteTimestamp: NOW - 1000,
};
assert.equal(evaluateLiquidity(good).eligible, true);
assert.equal(evaluateLiquidity(null).eligible, false);
// Exactly 1% spread can accumulate binary rounding, so use integer quote values.
const boundary = { ...good, price: 100, bid: 199, ask: 201 };
assert.equal(evaluateLiquidity(boundary).eligible, true);
assert.equal(evaluateLiquidity({ ...good, bid: 10, ask: 10 }).eligible, true);
assert.equal(evaluateLiquidity({ ...good, volume: 99999 }).codes.includes('LOW_SHARE_VOLUME'), true);
assert.equal(evaluateLiquidity({ ...good, price: 9 }).codes.includes('LOW_DOLLAR_VOLUME'), true);
assert.equal(evaluateLiquidity({ ...boundary, ask: 201.01 }).codes.includes('WIDE_SPREAD'), true);
for (const missing of [undefined, null, '', ' ', NaN, Infinity, false, -1]) {
  const result = evaluateLiquidity({ ...good, bid: missing });
  assert.equal(result.eligible, false);
  assert.equal(result.spreadStatus, 'unavailable');
  assert.ok(result.codes.includes('SPREAD_UNAVAILABLE'));
}
assert.ok(evaluateLiquidity({ ...good, bid: 11, ask: 10 }).codes.includes('SPREAD_UNAVAILABLE'));
for (const volume of [null, undefined, '', NaN, -1, false]) {
  assert.ok(evaluateLiquidity({ ...good, volume }).codes.includes('SHARE_VOLUME_UNAVAILABLE'));
}
assert.ok(evaluateLiquidity({ ...good, price: null }).codes.includes('DOLLAR_VOLUME_UNAVAILABLE'));
assert.equal(evaluateLiquidity({ ...good, bid: null, ask: null }, { ...defaults, maxSpreadPct: null }).eligible, true);
assert.equal(evaluateLiquidity({ ...good, bid: null }, { ...defaults, maxSpreadPct: 0 }).eligible, false);
assert.ok(evaluateLiquidity({ ...good, bid: 10, ask: 10, changePct: 30 }).codes.includes('PUMP_LIKE_LOW_LIQUIDITY'));
assert.equal(evaluateLiquidity({ ...boundary, changePct: 30 }).eligible, true);
assert.equal(evaluateLiquidity({ ...good, bid: 10, ask: 10, changePct: 29.99 }).eligible, true);
for (const policy of [{ ...defaults, minShareVolume: -1 }, { ...defaults, maxSpreadPct: '' }, { ...defaults, pumpChangePct: 0 }, { ...defaults, pumpMinDollarVolume: 0 }]) {
  assert.throws(() => validateLiquidityPolicy(policy), TypeError);
}
assert.ok(evaluateLiquidity({ ...good, price: Number.MAX_VALUE }).codes.includes('DOLLAR_VOLUME_UNAVAILABLE'));
assert.ok(evaluateLiquidity({ ...good, marketState: 'PRE' }).codes.includes('SESSION_NOT_REGULAR'));
assert.ok(evaluateLiquidity({ ...good, now: Date.parse('2026-09-14T12:00:00Z') }).codes.includes('SESSION_NOT_REGULAR'));
assert.ok(evaluateLiquidity({ ...good, quoteTimestamp: NOW - 60001 }).codes.includes('QUOTE_STALE'));
assert.ok(evaluateLiquidity({ ...good, volumeTimestamp: Date.parse('2026-09-11T19:59:00Z') }).codes.includes('VOLUME_WRONG_SESSION'));
console.log('liquidity-policy: boundary, missing-data, pump-like and configuration checks passed');