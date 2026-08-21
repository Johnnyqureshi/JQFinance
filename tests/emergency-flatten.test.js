'use strict';

const assert = require('assert');
const { EmergencyFlattenError, runEmergencyFlatten } = require('../lib/emergency-flatten');

async function testAcceptedEntryIsCancelledBeforeLiquidation() {
  let inFlightOrderRequests = 1;
  let openOrders = [{ id: 'entry-accepted-not-filled' }];
  let positions = [];
  const calls = [];

  const result = await runEmergencyFlatten({
    waitForOrderRequests: async () => {
      inFlightOrderRequests = 0;
      calls.push('wait-for-order-request');
    },
    listOpenOrders: async () => openOrders,
    cancelOpenOrders: async orders => {
      calls.push(`cancel:${orders.map(order => order.id).join(',')}`);
      openOrders = [];
      return orders.map(order => ({ id: order.id, ok: true }));
    },
    closeAllPositions: async () => {
      assert.strictEqual(inFlightOrderRequests, 0, 'liquidation must wait for started order requests');
      assert.deepStrictEqual(openOrders, [], 'all open entries must be cancelled before liquidation');
      calls.push('close-positions');
      positions = [];
      return [{ symbol: 'TEST', status: 200 }];
    },
    listPositions: async () => positions,
    wait: async () => {},
    attempts: 3,
  });

  assert.strictEqual(result.verified, true);
  assert.deepStrictEqual(calls, [
    'wait-for-order-request',
    'cancel:entry-accepted-not-filled',
    'close-positions',
  ]);
}

async function testReportsUncancelledOrdersInsteadOfClosingBlindly() {
  const stuckOrder = [{ id: 'still-open' }];
  await assert.rejects(
    () => runEmergencyFlatten({
      waitForOrderRequests: async () => {},
      listOpenOrders: async () => stuckOrder,
      cancelOpenOrders: async () => { throw new Error('broker cancellation rejected'); },
      closeAllPositions: async () => {
        throw new Error('positions must not be closed while an entry remains open');
      },
      listPositions: async () => [],
      wait: async () => {},
      attempts: 2,
    }),
    error => {
      assert(error instanceof EmergencyFlattenError);
      assert.deepStrictEqual(error.details.openOrderIds, ['still-open']);
      assert.strictEqual(error.details.cancellationAttempts.length, 2);
      return true;
    }
  );
}

(async () => {
  await testAcceptedEntryIsCancelledBeforeLiquidation();
  await testReportsUncancelledOrdersInsteadOfClosingBlindly();
  console.log('Emergency flatten tests: 2 passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});