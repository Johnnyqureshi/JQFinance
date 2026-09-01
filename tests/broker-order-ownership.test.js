'use strict';

const assert = require('assert');
const {
  activeProtectiveLegsForIntent,
  brokerOrderMatchesIntent,
  protectiveCancellationSettled,
} = require('../lib/broker-order-ownership');

assert.strictEqual(brokerOrderMatchesIntent({ client_order_id: 'mt-7-AAPL' }, 'mt-7-AAPL'), true);
assert.strictEqual(brokerOrderMatchesIntent({ client_order_id: 'pmh_7_AAPL_partial' }, 'pmh_7_AAPL_runner'), false);
assert.strictEqual(brokerOrderMatchesIntent({ id: 'broker-id-without-client-id' }, 'cndl_7_AAPL'), false);
assert.strictEqual(brokerOrderMatchesIntent({ client_order_id: 'cndl_7_AAPL' }, ''), false);
const parent = {
  client_order_id: 'mt-7-AAPL',
  legs: [
    { id: 'mt-stop', side: 'sell', status: 'new' },
    { id: 'mt-target', side: 'sell', status: 'canceled' },
  ],
};
assert.deepStrictEqual(activeProtectiveLegsForIntent(parent, 'mt-7-AAPL').map(order => order.id), ['mt-stop']);
assert.deepStrictEqual(activeProtectiveLegsForIntent(parent, 'pmh_7_AAPL_runner'), []);
assert.strictEqual(protectiveCancellationSettled(parent, 'mt-7-AAPL'), false);
assert.strictEqual(protectiveCancellationSettled({
  ...parent,
  legs: parent.legs.map(order => ({ ...order, status: 'canceled' })),
}, 'mt-7-AAPL'), true);

console.log('broker order ownership tests passed');