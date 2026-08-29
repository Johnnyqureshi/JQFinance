'use strict';

const assert = require('assert');
const { summarizeSwingLotProtection, assertSwingOwnedBrokerTree } = require('../lib/swing-reconciliation');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(` ✓ ${name}`); }
  catch (error) { failed++; console.error(` ✗ ${name}: ${error.message}`); }
}

test('a partially filled parent without activated legs requires a fail-safe exit', () => {
  const result = summarizeSwingLotProtection({
    id: 'parent', status: 'partially_filled', filled_qty: '3', legs: [],
  });
  assert.equal(result.requiresFailSafeExit, true);
  assert.equal(result.activeOrders.length, 1);
});

test('an owned active stop must cover every remaining filled share', () => {
  const result = summarizeSwingLotProtection({
    id: 'parent', status: 'filled', filled_qty: '5',
    legs: [{ id: 'stop', status: 'new', type: 'stop', qty: '5', filled_qty: '0' }],
  }, 2);
  assert.equal(result.remainingQuantity, 3);
  assert.equal(result.protected, true);
});

test('an undersized stop is not treated as adequate protection', () => {
  const result = summarizeSwingLotProtection({
    id: 'parent', status: 'filled', filled_qty: '5',
    legs: [{ id: 'stop', status: 'new', type: 'stop', qty: '2', filled_qty: '0' }],
  });
  assert.equal(result.protected, false);
  assert.equal(result.requiresFailSafeExit, true);
});
test('pending cancellation remains active so a close cannot race the broker', () => {
  const result = summarizeSwingLotProtection({
    id: 'parent', status: 'filled', filled_qty: '2',
    legs: [{ id: 'stop', status: 'pending_cancel', type: 'stop', qty: '2', filled_qty: '0' }],
  });
  assert.equal(result.activeOrders.length, 1);
});
test('nested exits must prove parent attachment, symbol, and closing side', () => {
  const intent = { symbol: 'AAPL', clientOrderId: 'swing-aapl-1-tp1-0', quantity: 2 };
  const valid = {
    id: 'parent', client_order_id: intent.clientOrderId, symbol: 'AAPL', side: 'buy', qty: '2',
    legs: [{ id:'stop', parent_order_id:'parent', symbol:'AAPL', side:'sell', type:'stop' }],
  };
  assert.equal(assertSwingOwnedBrokerTree(valid, intent), true);
  assert.throws(() => assertSwingOwnedBrokerTree({
    ...valid, legs: [{ ...valid.legs[0], parent_order_id:'unrelated-parent' }],
  }, intent), /ownership validation/);
});

if (failed) process.exit(1);