'use strict';
const assert = require('assert');
const { summarizeCandlestickBrokerOrder, needsUnprotectedExit, cancellationAction } = require('../lib/candlestick-reconciliation');

let passed = 0; let failed = 0;
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); failed++; } }
const parent = (overrides = {}) => ({ status:'filled', filled_qty:'10', filled_avg_price:'12.50', legs:[], ...overrides });

console.log('\nUltraBot3 broker reconciliation\n');
test('recognizes a long bracket only when both target and stop are active', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ id:'parent-long', legs:[
    { type:'limit', status:'new', parent_order_id:'parent-long', symbol:'NVDA', side:'sell', qty:'10', limit_price:'14.50' },
    { type:'stop', status:'accepted', parent_order_id:'parent-long', symbol:'NVDA', side:'sell', qty:'10', stop_price:'11.50' },
  ] }), { direction:'LONG', symbol:'NVDA', targetPrice:14.5, stopPrice:11.5 });
  assert.strictEqual(summary.hasEntryFill, true);
  assert.strictEqual(summary.protection.complete, true);
  assert.strictEqual(needsUnprotectedExit(summary, null), false);
});
test('recognizes a short bracket and broker-confirmed target exit', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ id:'parent-short', legs:[
    { type:'limit', status:'filled', parent_order_id:'parent-short', symbol:'NVDA', side:'buy', qty:'10', limit_price:'11.25', filled_qty:'4', filled_avg_price:'11.25' },
    { type:'stop', status:'canceled', parent_order_id:'parent-short', symbol:'NVDA', side:'buy', qty:'10', stop_price:'13.50' },
  ] }), { direction:'SHORT', symbol:'NVDA', targetPrice:11.25, stopPrice:13.5 });
  assert.strictEqual(summary.protection.complete, false);
  assert.strictEqual(summary.exitFills[0].type, 'limit');
  assert.strictEqual(needsUnprotectedExit(summary, null), false);
});
test('requires a protective close for a canceled partial entry without bracket legs', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ status:'canceled', filled_qty:'3', legs:[] }));
  assert.strictEqual(summary.hasEntryFill, true);
  assert.strictEqual(needsUnprotectedExit(summary, null), true);
});
test('gives an active partial parent a finite protection grace period', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ status:'partially_filled', legs:[] }));
  assert.strictEqual(needsUnprotectedExit(summary, '2030-01-01T00:00:00.000Z', Date.parse('2029-12-31T23:59:00.000Z')), false);
  assert.strictEqual(needsUnprotectedExit(summary, '2030-01-01T00:00:00.000Z', Date.parse('2030-01-01T00:00:01.000Z')), true);
});
test('records a partially-filled protective leg rather than treating it as no exit', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ status:'partially_filled', legs:[
    { type:'stop', status:'partially_filled', filled_qty:'2', filled_avg_price:'11.40' },
  ] }));
  assert.strictEqual(summary.exitFills.length, 1);
  assert.strictEqual(summary.exitFills[0].filled_qty, '2');
});
test('fails closed when a nested protective leg omits its parent association', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ id:'parent-long', legs:[
    { type:'limit', status:'new', symbol:'NVDA', side:'sell', qty:'10', limit_price:'14.50' },
    { type:'stop', status:'accepted', symbol:'NVDA', side:'sell', qty:'10', stop_price:'11.50' },
  ] }), { direction:'LONG', symbol:'NVDA', targetPrice:14.5, stopPrice:11.5 });
  assert.strictEqual(summary.protection.complete, false);
});
test('does not rescue while Alpaca reports a parent cancellation as pending', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ status:'pending_cancel', legs:[] }));
  assert.strictEqual(summary.parentActive, true);
  assert.strictEqual(needsUnprotectedExit(summary, '2020-01-01T00:00:00.000Z', Date.parse('2021-01-01T00:00:00.000Z')), true);
  assert.strictEqual(cancellationAction(summary, 'rescue_cancel_pending'), 'await_terminal_parent');
});
test('retries a cancellation intent after its DELETE request fails', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ status:'accepted', legs:[] }));
  assert.strictEqual(cancellationAction(summary, 'rescue_cancel_intent'), 'submit_or_retry_cancel');
});
test('cancels a still-live bracket child after the parent is filled before rescue', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ id:'parent-filled', status:'filled', legs:[
    { id:'target-live', type:'limit', status:'accepted', parent_order_id:'parent-filled', symbol:'NVDA', side:'sell', qty:'10', limit_price:'14.50' },
  ] }), { direction:'LONG', symbol:'NVDA', targetPrice:14.5, stopPrice:11.5, remainingQuantity:10 });
  assert.strictEqual(summary.parentTerminal, true);
  assert.strictEqual(summary.activeLegs.length, 1);
  assert.strictEqual(cancellationAction(summary, 'protection_pending'), 'submit_or_retry_cancel');
});
test('accepts resized residual bracket protection after a partial target fill', () => {
  const summary = summarizeCandlestickBrokerOrder(parent({ id:'parent-partial', status:'filled', legs:[
    { id:'target', type:'limit', status:'partially_filled', parent_order_id:'parent-partial', symbol:'NVDA', side:'sell', qty:'6', limit_price:'14.50', filled_qty:'4', filled_avg_price:'14.50' },
    { id:'stop', type:'stop', status:'accepted', parent_order_id:'parent-partial', symbol:'NVDA', side:'sell', qty:'6', stop_price:'11.50' },
  ] }), { direction:'LONG', symbol:'NVDA', targetPrice:14.5, stopPrice:11.5, remainingQuantity:6 });
  assert.strictEqual(summary.protection.complete, true);
  assert.strictEqual(needsUnprotectedExit(summary, null), false);
});
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);