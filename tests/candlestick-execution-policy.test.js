'use strict';
const assert = require('assert');
const {
  sanitizeCandlestickExecutionConfig,
  candlestickEntrySide,
  buildCandlestickBracketOrder,
  candlestickBarsFromResponse,
  requireCandlestickBrokerCollection,
  calculateCandlestickEntryCapacity,
} = require('../lib/candlestick-execution-policy');

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
    [{ id:'order-long', client_order_id:'cndl_a', side:'buy' }, { id:'stop-child', side:'sell', parent_order_id:'order-long' }, { id:'order-short', client_order_id:'cndl_b', side:'sell' }],
    [{ entry_client_order_id:'cndl_a' }, { entry_client_order_id:'timeout-c' }]
  );
  assert.deepStrictEqual(capacity, { held:1, pendingEntries:3, used:4 });
});
test('uses Alpaca order sides for long and short entries', () => {
  assert.strictEqual(candlestickEntrySide('LONG'), 'buy');
  assert.strictEqual(candlestickEntrySide('SHORT'), 'sell');
});
test('builds a paper/live-compatible bracket market order', () => {
  const order = buildCandlestickBracketOrder({
    symbol: 'NVDA', qty: 3, direction: 'SHORT', clientOrderId: 'cndl_test_1', target: 98.123, stop: 104.567,
  });
  assert.deepStrictEqual(order, {
    symbol: 'NVDA', qty: '3', side: 'sell', type: 'market', time_in_force: 'day',
    client_order_id: 'cndl_test_1', order_class: 'bracket',
    take_profit: { limit_price: '98.12' }, stop_loss: { stop_price: '104.57' },
  });
});
test('accepts both documented single-symbol and keyed Alpaca bars responses', () => {
  const bars = [{ t:'2026-08-28T15:00:00Z', o:10, h:11, l:9, c:10.5, v:1000 }];
  assert.strictEqual(candlestickBarsFromResponse({ bars }, 'AAPL'), bars);
  assert.strictEqual(candlestickBarsFromResponse({ bars:{ AAPL:bars } }, 'aapl'), bars);
  assert.throws(() => candlestickBarsFromResponse({ bars:{} }, 'AAPL'), /unexpected bars response/);
  assert.throws(() => candlestickBarsFromResponse(null, 'AAPL'), /did not return a response/);
});
test('fails closed when broker position or order collections are malformed', () => {
  const rows = [{ symbol:'AAPL' }];
  assert.strictEqual(requireCandlestickBrokerCollection(rows, 'positions'), rows);
  assert.throws(() => requireCandlestickBrokerCollection({ data:rows }, 'positions'), /unexpected positions response/);
  assert.throws(() => requireCandlestickBrokerCollection(null, 'open-orders'), /unexpected open-orders response/);
});
test('counts a timeout-reserved journal entry even before broker visibility', () => {
  const capacity = calculateCandlestickEntryCapacity([], [], [{ entry_order_id:'cndl_timeout', entry_client_order_id:'cndl_timeout' }]);
  assert.strictEqual(capacity.used, 1);
});
test('reserves a confirmed journal position until the broker positions feed catches up', () => {
  const beforeBrokerPosition = calculateCandlestickEntryCapacity([], [], [{ symbol:'NVDA', entry_client_order_id:'cndl_filled' }]);
  const afterBrokerPosition = calculateCandlestickEntryCapacity([{ symbol:'NVDA' }], [], [{ symbol:'NVDA', entry_client_order_id:'cndl_filled' }]);
  assert.strictEqual(beforeBrokerPosition.used, 1);
  assert.strictEqual(afterBrokerPosition.used, 1);
});
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);