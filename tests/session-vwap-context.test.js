'use strict';

const assert = require('assert');
const {
  evaluateSessionVwapContext,
  evaluateVwapSupport,
} = require('../lib/session-vwap-context');

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

console.log('\nRegular-session VWAP research context');

const now = new Date('2026-08-25T15:00:00.000Z'); // 11:00 AM ET
const regularBar = (timestamp, price, volume = 100) => ({
  t: timestamp, o: price, h: price, l: price, c: price, v: volume,
});
const snapshot = (ask, timestamp = '2026-08-25T14:59:55.000Z') => ({
  latestQuote: { ap: ask, t: timestamp },
});

test('rejects a fresh price below VWAP with the reversal log', () => {
  const result = evaluateVwapSupport({ price: 9.99, vwap: 10, priceFresh: true });
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reason, 'SKIP — price below VWAP (potential reversal)');
});

test('rejects a price exactly at VWAP because confirmation requires above', () => {
  const result = evaluateVwapSupport({ price: 10, vwap: 10, priceFresh: true });
  assert.strictEqual(result.eligible, false);
  assert.match(result.reason, /at VWAP/i);
});

test('ignores unrelated browser settings when measuring VWAP support', () => {
  const legacySettings = { requireAboveVwap: false };
  const result = evaluateVwapSupport({
    ...legacySettings,
    price: 9.5,
    vwap: 10,
    priceFresh: true,
  });
  assert.strictEqual(result.eligible, false);
});

test('rejects stale quote data and only accepts a price strictly above VWAP', () => {
  assert.strictEqual(
    evaluateVwapSupport({ price: 10.5, vwap: 10, priceFresh: false }).eligible,
    false
  );
  assert.strictEqual(
    evaluateVwapSupport({ price: 10.01, vwap: 10, priceFresh: true }).eligible,
    true
  );
});

test('VWAP research context rejects below and equal VWAP asks', () => {
  const bars = [regularBar('2026-08-25T13:30:00.000Z', 10)];
  assert.strictEqual(
    evaluateSessionVwapContext({ bars, snapshot: snapshot(9.99), now }).eligible,
    false
  );
  assert.strictEqual(
    evaluateSessionVwapContext({ bars, snapshot: snapshot(10), now }).eligible,
    false
  );
});

test('VWAP research context rejects missing, stale, and out-of-session evidence', () => {
  const bars = [regularBar('2026-08-25T13:30:00.000Z', 10)];
  assert.strictEqual(
    evaluateSessionVwapContext({ bars, snapshot: snapshot(10.1, '2026-08-25T14:59:30.000Z'), now }).eligible,
    false
  );
  assert.strictEqual(
    evaluateSessionVwapContext({ bars, snapshot: null, now }).eligible,
    false
  );
  assert.strictEqual(
    evaluateSessionVwapContext({
      bars,
      snapshot: snapshot(10.1),
      now: new Date('2026-08-25T13:20:00.000Z'),
    }).eligible,
    false
  );
});

test('VWAP research context accepts only a fresh executable ask above session VWAP', () => {
  const result = evaluateSessionVwapContext({
    bars: [regularBar('2026-08-25T13:30:00.000Z', 10)],
    snapshot: snapshot(10.01),
    now,
  });
  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.price, 10.01);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);