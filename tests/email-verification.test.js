'use strict';

// Email-verification token lifecycle tests (pure logic, SQLite :memory:).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ev = require('../lib/email-verification');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE email_verification_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE alpaca_creds (user_id INTEGER PRIMARY KEY, api_key TEXT NOT NULL, api_secret TEXT NOT NULL);
  `);
  return db;
}

function addUser(db, id, username, verified = 0) {
  db.prepare('INSERT INTO users (id, username, password_hash, email_verified) VALUES (?,?,?,?)')
    .run(id, username, 'hash', verified ? 1 : 0);
}

// ── Token generation / hashing ──────────────────────────────────────────────

test('generateToken returns 64-char hex and is unique', () => {
  const a = ev.generateToken();
  const b = ev.generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('hashToken is deterministic SHA-256 hex', () => {
  const h = ev.hashToken('abc123');
  assert.equal(h, crypto.createHash('sha256').update('abc123', 'utf8').digest('hex'));
  assert.match(h, /^[0-9a-f]{64}$/);
});

// ── Issue / consume round-trip ──────────────────────────────────────────────

test('issue + consume round-trip succeeds and returns the user id', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  const { raw, tokenHash } = ev.issueToken(db, 1);
  assert.match(raw, /^[0-9a-f]{64}$/);
  const stored = db.prepare('SELECT token_hash FROM email_verification_tokens WHERE user_id=1').get();
  assert.equal(stored.token_hash, tokenHash);
  assert.notEqual(stored.token_hash, raw); // hash-only storage
  const res = ev.consumeToken(db, raw);
  assert.equal(res.ok, true);
  assert.equal(res.userId, 1);
});

test('garbage token is invalid', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  assert.deepEqual(ev.consumeToken(db, 'not-a-real-token'), { ok: false, code: 'invalid' });
  assert.deepEqual(ev.consumeToken(db, ''), { ok: false, code: 'invalid' });
  assert.deepEqual(ev.consumeToken(db, null), { ok: false, code: 'invalid' });
});

test('expired token is rejected', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  const issuedAt = Date.now() - ev.TOKEN_TTL_MS - 1000;
  const { raw } = ev.issueToken(db, 1, issuedAt);
  const res = ev.consumeToken(db, raw, Date.now());
  assert.equal(res.ok, false);
  assert.equal(res.code, 'expired');
});

test('token is single-use: second consume reports used', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  const { raw } = ev.issueToken(db, 1);
  assert.equal(ev.consumeToken(db, raw).ok, true);
  const second = ev.consumeToken(db, raw);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'used');
});

test('re-issuing invalidates the previous token', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  const first = ev.issueToken(db, 1);
  const second = ev.issueToken(db, 1);
  assert.equal(ev.consumeToken(db, first.raw).code, 'used');
  assert.equal(ev.consumeToken(db, second.raw).ok, true);
});

// ── Verification flag ───────────────────────────────────────────────────────

test('isEmailVerified / setEmailVerified round-trip', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  addUser(db, 2, 'bob', 1);
  assert.equal(ev.isEmailVerified(db, 1), false);
  assert.equal(ev.isEmailVerified(db, 2), true);
  assert.equal(ev.isEmailVerified(db, 999), false);
  ev.setEmailVerified(db, 1, true);
  assert.equal(ev.isEmailVerified(db, 1), true);
  ev.setEmailVerified(db, 1, false);
  assert.equal(ev.isEmailVerified(db, 1), false);
});

// ── Email validation ────────────────────────────────────────────────────────

test('isValidEmail accepts good addresses and rejects bad ones', () => {
  assert.equal(ev.isValidEmail('a@b.co'), true);
  assert.equal(ev.isValidEmail('User.Name+tag@Example.COM'), true);
  assert.equal(ev.isValidEmail('no-at-sign'), false);
  assert.equal(ev.isValidEmail('a@b'), false);
  assert.equal(ev.isValidEmail('a b@c.com'), false);
  assert.equal(ev.isValidEmail(''), false);
  assert.equal(ev.isValidEmail(null), false);
  assert.equal(ev.isValidEmail('x'.repeat(250) + '@b.co'), false); // > 254 chars
});

// ── Grandfathering (all pre-existing users, exactly once) ───────────────────

test('grandfatherAllUsers marks every unverified user, runs once', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  addUser(db, 2, 'bob');
  addUser(db, 3, 'cara', 1);
  const n = ev.grandfatherAllUsers(db);
  assert.equal(n, 2);
  assert.equal(ev.isEmailVerified(db, 1), true);
  assert.equal(ev.isEmailVerified(db, 2), true);
  assert.equal(ev.isEmailVerified(db, 3), true);
  // Sentinel: second run is a no-op.
  assert.equal(ev.grandfatherAllUsers(db), 0);
});

test('users registered after grandfathering stay unverified', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  assert.equal(ev.grandfatherAllUsers(db), 1);
  addUser(db, 2, 'newbie');
  assert.equal(ev.isEmailVerified(db, 2), false);
  assert.equal(ev.grandfatherAllUsers(db), 0); // still a no-op
  assert.equal(ev.isEmailVerified(db, 2), false);
});

// ── Broker-activity helper ──────────────────────────────────────────────────

test('hasBrokerActivity detects credential rows', () => {
  const db = makeDb();
  addUser(db, 1, 'alice');
  addUser(db, 2, 'bob');
  db.prepare('INSERT INTO alpaca_creds (user_id, api_key, api_secret) VALUES (?,?,?)').run(1, 'k', 's');
  assert.equal(ev.hasBrokerActivity(db, 1), true);
  assert.equal(ev.hasBrokerActivity(db, 2), false);
});

console.log(`\nemail-verification: ${passed} passed`);
