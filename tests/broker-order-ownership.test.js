'use strict';

const assert = require('assert');
const { brokerOrderMatchesIntent } = require('../lib/broker-order-ownership');

assert.strictEqual(brokerOrderMatchesIntent({ client_order_id: 'mt-7-AAPL' }, 'mt-7-AAPL'), true);
assert.strictEqual(brokerOrderMatchesIntent({ client_order_id: 'pmh_7_AAPL_partial' }, 'pmh_7_AAPL_runner'), false);
assert.strictEqual(brokerOrderMatchesIntent({ id: 'broker-id-without-client-id' }, 'cndl_7_AAPL'), false);
assert.strictEqual(brokerOrderMatchesIntent({ client_order_id: 'cndl_7_AAPL' }, ''), false);

console.log('broker order ownership tests passed');