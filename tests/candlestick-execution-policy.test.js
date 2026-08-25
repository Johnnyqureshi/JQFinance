'use strict';
const assert = require('assert');
const { sanitizeCandlestickExecutionConfig, calculateCandlestickEntryCapacity } = require('../lib/candlestick-execution-policy');

let passed = 0; let failed = 0;
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); failed++; } }
console.log('\nCandlestick execution safety\n');
test('cannot lower the two-R floor or disable position capacity through saved settings', () => {
  const config = sanitizeCandlestickExecutionConfig({ minRewardRisk: -50, maxPositions: 999, minBars: 1, lookback: 0 }, { minRewardRisk:2, maxPositions:1, minBars:20, lookback:15 });
  assert.strictEqual(config.minRewardRisk, 2);
  assert.strictEqual(config.maxPositions, 2);
  assert.strictEqual(config.minBars, 20);
  assert.strictEqual(config.lookback, 5);
});
test('counts pending long and short parents before submitting another symbol', () => {
  const capacity = calculateCandlestickEntryCapacity(
    [{ symbol:'AAPL' }],
    [{ id:'order-long', client_order_id:'cndl_a', side:'buy' }, { id:'stop-child', side:'sell', parent_order_id:'order-long' }, { id:'order-short', client_order_id:'cndl_b', side:'sell_short' }],
    [{ entry_client_order_id:'cndl_a' }, { entry_client_order_id:'timeout-c' }]
  );
  assert.deepStrictEqual(capacity, { held:1, pendingEntries:3, used:4 });
});
test('counts a timeout-reserved journal entry even before broker visibility', () => {
  const capacity = calculateCandlestickEntryCapacity([], [], [{ entry_order_id:'cndl_timeout', entry_client_order_id:'cndl_timeout' }]);
  assert.strictEqual(capacity.used, 1);
});
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);