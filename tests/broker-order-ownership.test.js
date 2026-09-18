'use strict';
const assert = require('node:assert/strict');
const { brokerOrderMatchesIntent } = require('../lib/broker-order-ownership');
assert.equal(brokerOrderMatchesIntent({ client_order_id: 'leap-owned' }, 'leap-owned'), true);
assert.equal(brokerOrderMatchesIntent({ client_order_id: 'foreign' }, 'leap-owned'), false);
assert.equal(brokerOrderMatchesIntent({}, ''), false);
assert.equal(brokerOrderMatchesIntent(null, 'leap-owned'), false);
console.log('broker order ownership tests passed');
