'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { closeServer } = require('../lib/graceful-shutdown');

test('HTTP drain resolves only after the server close callback', async () => {
  let callback;
  let idleClosed = false;
  const server = {
    listening: true,
    close(fn) { callback = fn; },
    closeIdleConnections() { idleClosed = true; },
  };
  let resolved = false;
  const draining = closeServer(server, { timeoutMs: 100 }).then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(idleClosed, true);
  callback();
  await draining;
  assert.equal(resolved, true);
});

test('HTTP drain timeout rejects instead of permitting a fence release', async () => {
  let forced = false;
  const server = {
    listening: true,
    close() {},
    closeIdleConnections() {},
    closeAllConnections() { forced = true; },
  };
  await assert.rejects(closeServer(server, { timeoutMs: 5 }), /fence release withheld/);
  assert.equal(forced, true);
});