'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { retireLegacyAccount } = require('../lib/legacy-account-retirement');

const db = new Database(':memory:');
const sessionDb = new Database(':memory:');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT);
  CREATE TABLE alpaca_creds (user_id INTEGER, api_key TEXT, api_secret TEXT, mode TEXT);
  CREATE TABLE alpaca_active_mode (user_id INTEGER, mode TEXT);
  CREATE TABLE auto_trade_settings (user_id INTEGER, enabled INTEGER);
  CREATE TABLE pmh_settings (user_id INTEGER, enabled INTEGER);
  CREATE TABLE bot_toggles (user_id INTEGER, bot_name TEXT, enabled INTEGER, PRIMARY KEY (user_id, bot_name));
  CREATE TABLE ve_auto_settings (user_id INTEGER, enabled INTEGER);
`);
sessionDb.exec('CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expired INTEGER)');
db.prepare("INSERT INTO users VALUES (1, 'johnnyqureshi', 'legacy-hash')").run();
db.prepare("INSERT INTO alpaca_creds VALUES (1, 'key', 'secret', 'live')").run();
db.prepare("INSERT INTO alpaca_active_mode VALUES (1, 'live')").run();
db.prepare("INSERT INTO auto_trade_settings VALUES (1, 1)").run();
db.prepare("INSERT INTO pmh_settings VALUES (1, 1)").run();
db.prepare("INSERT INTO ve_auto_settings VALUES (1, 1)").run();
sessionDb.prepare("INSERT INTO sessions VALUES ('legacy', ?, 0)").run('{"userId":1}');

assert.strictEqual(retireLegacyAccount({
  db, sessionDb, username: 'johnnyqureshi', replacementPasswordHash: 'random-replacement-hash',
}), true);
const retired = db.prepare('SELECT * FROM users WHERE id=1').get();
assert.strictEqual(retired.username, 'retired-bootstrap-1');
assert.strictEqual(retired.password_hash, 'random-replacement-hash');
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM alpaca_creds WHERE user_id=1').get().count, 0);
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM alpaca_active_mode WHERE user_id=1').get().count, 0);
assert.strictEqual(db.prepare('SELECT enabled FROM auto_trade_settings WHERE user_id=1').get().enabled, 0);
assert.strictEqual(db.prepare('SELECT enabled FROM pmh_settings WHERE user_id=1').get().enabled, 0);
assert.strictEqual(db.prepare('SELECT enabled FROM ve_auto_settings WHERE user_id=1').get().enabled, 0);
assert.strictEqual(db.prepare("SELECT enabled FROM bot_toggles WHERE user_id=1 AND bot_name='pmh'").get().enabled, 0);
assert.strictEqual(db.prepare("SELECT enabled FROM bot_toggles WHERE user_id=1 AND bot_name='countertrend'").get().enabled, 0);
assert.strictEqual(sessionDb.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
assert.strictEqual(retireLegacyAccount({
  db, sessionDb, username: 'johnnyqureshi', replacementPasswordHash: 'other',
}), false);
// Re-registration scenario: the owner creates a fresh account with the same
// username after retirement. A later boot must NOT re-retire the fresh row.
db.prepare("INSERT INTO users VALUES (2, 'johnnyqureshi', 'fresh-hash')").run();
assert.strictEqual(retireLegacyAccount({
  db, sessionDb, username: 'johnnyqureshi', replacementPasswordHash: 'other',
}), false);
const fresh = db.prepare('SELECT * FROM users WHERE id=2').get();
assert.strictEqual(fresh.username, 'johnnyqureshi');
assert.strictEqual(fresh.password_hash, 'fresh-hash');
console.log('legacy account retirement tests passed');