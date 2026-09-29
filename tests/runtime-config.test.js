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
// Production must boot through scripts/boot.js so the durable Postgres snapshot
// is restored before server.js opens automated-trading.db. Running server.js
// directly skips the restore and the startup checkpoint then overwrites the
// good snapshot with an empty image (every deploy wipes bot state).
const pkg = require('../package.json');
assert.strictEqual(
  pkg.scripts && pkg.scripts.start,
  'node scripts/boot.js',
  'package.json scripts.start must be "node scripts/boot.js" so snapshot restore runs in production'
);
