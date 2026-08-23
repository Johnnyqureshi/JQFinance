'use strict';

const assert = require('assert');
const { requiresPriceActionForEntry } = require('../lib/order-entry-policy');

assert.strictEqual(requiresPriceActionForEntry({ side: 'buy', isCrypto: false }), true);
assert.strictEqual(requiresPriceActionForEntry({ side: 'BUY', isCrypto: false }), true);
assert.strictEqual(requiresPriceActionForEntry({ side: 'sell', isCrypto: false }), false);
assert.strictEqual(requiresPriceActionForEntry({ side: 'buy', isCrypto: true }), false);
assert.strictEqual(requiresPriceActionForEntry({ side: 'buy', isCrypto: false, strategy: 'pmh' }), false);
console.log('order entry policy tests passed');