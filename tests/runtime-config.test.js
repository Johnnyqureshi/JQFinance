'use strict';

const assert = require('assert');
const { resolvePort } = require('../lib/runtime-config');

assert.strictEqual(resolvePort(undefined), 5000);
assert.strictEqual(resolvePort('8080'), 8080);
assert.strictEqual(resolvePort(3000), 3000);
for (const invalid of ['abc', '5000.5', 0, 65536, -1]) {
  assert.throws(() => resolvePort(invalid), /PORT must be an integer/);
}

console.log('Runtime deployment configuration tests passed.');