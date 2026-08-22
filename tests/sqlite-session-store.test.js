'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const session = require('express-session');
const createStore = require('../lib/sqlite-session-store');

const db = new Database(':memory:');
const Store = createStore(session, db, 60_000);
const store = new Store();
let passed = 0;
let failed = 0;

function call(method, ...args) {
  return new Promise((resolve, reject) => store[method](...args, (error, value) => error ? reject(error) : resolve(value)));
}
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); failed++; }
}

(async () => {
  console.log('\nSQLite session store\n');
  await test('persists and reloads an active session', async () => {
    const sess = { userId: 7, cookie: { originalMaxAge: 60_000 } };
    await call('set', 'session-a', sess);
    assert.deepStrictEqual(await call('get', 'session-a'), sess);
  });
  await test('removes expired sessions instead of authenticating them', async () => {
    await call('set', 'session-expired', { userId: 8, cookie: { expires: new Date(Date.now() - 1).toISOString() } });
    assert.strictEqual(await call('get', 'session-expired'), null);
  });
  await test('touch renews the session and destroy removes it', async () => {
    await call('set', 'session-b', { userId: 9, cookie: { originalMaxAge: 1 } });
    await call('touch', 'session-b', { userId: 9, cookie: { originalMaxAge: 60_000 } });
    assert.strictEqual((await call('get', 'session-b')).userId, 9);
    await call('destroy', 'session-b');
    assert.strictEqual(await call('get', 'session-b'), null);
  });
  db.close();
  if (failed) process.exitCode = 1;
  console.log(`\n${passed} passed, ${failed} failed`);
})();