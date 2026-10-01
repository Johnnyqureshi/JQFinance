'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { RETIRED_TABLES, retireRemovedStrategies } = require('../lib/retired-strategies-migration');
const { barsFromBrokerResponse, completedDailyBars, completedWeeklyBars } = require('../lib/market-bars');
const { retireLegacyAccount } = require('../lib/legacy-account-retirement');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');

for (const prefix of ['momentum', 'opening-momentum', 'candlestick', 'swing', 'money-printer', 'bots', 'bot-trades', 'auto-trade', 'countertrend']) {
  assert.ok(!new RegExp(`app\\.(?:get|post|put|delete|use)\\(['"]/api/${prefix}(?:/|['"])`).test(source), `retired API ${prefix}`);
}
assert.ok(!/if\s*\(false\)/.test(source), 'no hidden retired implementations');
for (const table of RETIRED_TABLES) {
  assert.ok(!new RegExp(`\\b(?:FROM|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\\s+${table}\\b`, 'i').test(source), `retired storage access ${table}`);
}
for (const route of ['/api/search', '/api/scanner-batch', '/api/alpaca/order']) {
  assert.ok(source.includes(`'${route}'`), `preserved ${route}`);
}
assert.doesNotMatch(source, /(?:completedSwing|candlestickBarsFromResponse|aggregateSwingWeeklyBars)/);

const schemaDb = new Database(':memory:');
for (const match of source.matchAll(/db\.(?:exec|prepare)\(`\s*(CREATE TABLE IF NOT EXISTS[\s\S]*?)`\)/g)) {
  schemaDb.exec(match[1]);
}
schemaDb.prepare("INSERT INTO users (username,password_hash) VALUES ('schema-test','fixture')").run();
schemaDb.prepare("INSERT INTO alpaca_creds (user_id,api_key,api_secret,mode,account_id) VALUES (1,'fixture-key','fixture-secret','paper','preserved-account')").run();
vm.runInNewContext(section('// ── DB migration: upgrade alpaca_creds', '// ── Active-mode tracker'), {
  db: schemaDb, console: { log() {}, error(message) { throw new Error(message); } },
});
assert.equal(schemaDb.prepare('SELECT account_id FROM alpaca_creds').get().account_id, 'preserved-account');
assert.equal(schemaDb.prepare('PRAGMA table_info(alpaca_creds)').all().filter(row => row.pk).length, 2);
retireRemovedStrategies(schemaDb);
retireRemovedStrategies(schemaDb);
assert.ok(schemaDb.prepare("SELECT 1 FROM sqlite_master WHERE name='trade_settings'").get());
for (const table of RETIRED_TABLES) assert.equal(schemaDb.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table), undefined);
schemaDb.close();

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
  INSERT INTO users VALUES (1,'test','test');
  CREATE TABLE alpaca_creds (user_id INTEGER, mode TEXT, api_key TEXT, api_secret TEXT, api_key_enc TEXT, api_secret_enc TEXT, account_id TEXT);
  CREATE TABLE alpaca_active_mode (user_id INTEGER, mode TEXT);
  CREATE TABLE broker_account_owners (account_id TEXT PRIMARY KEY, user_id INTEGER, scope TEXT, mode TEXT, claimed_at TEXT);
  CREATE TABLE broker_account_quarantine (account_id TEXT PRIMARY KEY, reason TEXT, detected_at TEXT, resolved_at TEXT);
  INSERT INTO broker_account_owners VALUES ('b2-account',1,'b2','paper','now'),('manual-account',1,'manual','paper','now'),('retired',1,'momentum','paper','now');
  INSERT INTO broker_account_quarantine VALUES ('b2-account','B2_RECONCILIATION_REQUIRED','now',NULL);
  INSERT INTO alpaca_creds VALUES (1,'paper','fixture','fixture',NULL,NULL,'manual-account');
  INSERT INTO alpaca_active_mode VALUES (1,'paper');
`);
for (const table of RETIRED_TABLES) db.exec(`CREATE TABLE "${table}" (id INTEGER)`);
retireRemovedStrategies(db);
retireRemovedStrategies(db);
for (const table of RETIRED_TABLES) assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table), undefined);
assert.equal(db.prepare("SELECT COUNT(*) n FROM broker_account_owners WHERE scope='b2'").get().n, 1);
assert.equal(db.prepare("SELECT COUNT(*) n FROM broker_account_owners WHERE scope='momentum'").get().n, 0);
assert.equal(db.prepare('SELECT COUNT(*) n FROM alpaca_creds').get().n, 1);
assert.equal(db.prepare("SELECT resolved_at FROM broker_account_quarantine WHERE account_id='b2-account'").get().resolved_at, null);

// Evaluate only isolated helper declarations, never the server/app or a broker.
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} boundary`);
  return source.slice(a, b);
}
const context = vm.createContext({
  db, DISCONNECTED_SENTINEL: '__disconnected__', ENCRYPTED_CREDENTIAL_MARKER: '__encrypted__',
  brokerScopeLabel: scope => scope,
  decryptStoredAlpacaCredentials: row => row,
});
vm.runInContext(
  section('function normalizeAlpacaScope(', 'function decryptStoredAlpacaCredentials(')
  + section('function getAlpacaCreds(', 'async function alpacaFetchFor('), context
);
assert.equal(context.normalizeAlpacaScope(undefined), 'manual');
assert.equal(context.normalizeAlpacaScope('manual'), 'manual');
for (const scope of ['momentum', 'pmh', 'candlestick', 'swing', 'money-printer', 'b2', 'options', '', null, {}, []]) {
  assert.throws(() => context.normalizeAlpacaScope(scope), /Invalid broker connection scope/);
  assert.throws(() => context.getAlpacaCreds(1, scope), /Invalid broker connection scope/);
}
assert.equal(context.getAlpacaCreds(1, 'manual').account_id, 'manual-account');
assert.throws(() => context.getAlpacaCreds(1, 'options'), /Invalid broker connection scope/);
assert.throws(() => context._alpacaCredsExist(1, 'paper', 'options'), /Invalid broker connection scope/);
assert.equal(context.alpacaAccountConflict(1, 'manual', 'b2-account').owner, 'b2');
assert.equal(context.brokerAccountOwnerCount('manual-account'), 1);
context.refreshBrokerAccountQuarantine('b2-account');
assert.equal(context.isBrokerAccountQuarantined('b2-account'), true, 'do not clear a future strategy quarantine');
db.prepare("UPDATE broker_account_quarantine SET reason='DUPLICATE_ASSIGNMENT' WHERE account_id='b2-account'").run();
context.refreshBrokerAccountQuarantine('b2-account');
assert.equal(context.isBrokerAccountQuarantined('b2-account'), true, 'a foreign strategy must resolve its own duplicate quarantine');
db.prepare("UPDATE broker_account_quarantine SET reason='B2_RECONCILIATION_REQUIRED' WHERE account_id='b2-account'").run();
db.prepare("UPDATE alpaca_creds SET account_id='b2-account'").run();
assert.equal(context.brokerAccountOwnerCount('b2-account'), 2, 'registry participates in duplicate checks');
context.refreshBrokerAccountQuarantine('b2-account');
assert.equal(context.getAlpacaCreds(1, 'manual'), null, 'account conflict fails closed');
assert.equal(db.prepare("SELECT reason FROM broker_account_quarantine WHERE account_id='b2-account'").get().reason, 'B2_RECONCILIATION_REQUIRED');
assert.equal(context.claimBrokerAccountOwnership(1, 'options', 'paper', 'b2-account'), false);

const bars = [
  { t: '2026-09-10T04:00:00Z', o: 10, h: 13, l: 9, c: 12, v: 100 },
  { t: '2026-09-11T04:00:00Z', o: 12, h: 14, l: 11, c: 13, v: 200 },
  { t: '2026-09-14T04:00:00Z', o: 13, h: 15, l: 12, c: 14, v: 300 },
];
assert.deepEqual(barsFromBrokerResponse({ bars }, 'QQQ'), bars);
assert.deepEqual(barsFromBrokerResponse({ bars: { QQQ: bars } }, 'QQQ'), bars);
assert.throws(() => barsFromBrokerResponse({}, 'QQQ'), /unavailable/);
const daily = completedDailyBars(bars, Date.parse('2026-09-14T18:00:00Z'));
assert.equal(daily.length, 2);
const weekly = completedWeeklyBars(daily, Date.parse('2026-09-14T18:00:00Z'));
assert.equal(weekly.length, 1);
assert.equal(weekly[0].c, 13);
assert.equal(weekly[0].v, 300);
assert.equal(weekly[0].completedAt, bars[1].t);

const emptyDb = new Database(':memory:');
const sessionDb = new Database(':memory:');
emptyDb.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT); INSERT INTO users VALUES (1,'legacy','old')");
assert.equal(retireLegacyAccount({ db: emptyDb, sessionDb, username: 'legacy', replacementPasswordHash: 'new' }), true);
assert.equal(retireLegacyAccount({ db: emptyDb, sessionDb, username: 'legacy', replacementPasswordHash: 'new' }), false);
emptyDb.close();
sessionDb.close();
db.close();
console.log('retired strategy boundaries, migration, ownership, and shared history tests passed');