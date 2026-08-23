'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { createPostgresAuthStore } = require('../lib/postgres-auth-store');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT
  );
`);

// No PostgreSQL query is made in this test. The store is used only to exercise
// the synchronous compatibility bridge that maintains foreign-keyed SQLite rows.
const authStore = createPostgresAuthStore({
  databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
  sessionTtlMs: 60_000,
});

authStore.syncSqliteUser(db, {
  id: 1_000_000_001,
  username: 'alice',
  password_hash: 'alice-hash',
  created_at: '2026-08-23T00:00:00.000Z',
});
assert.deepStrictEqual(
  db.prepare('SELECT id, username, password_hash FROM users WHERE id=?').get(1_000_000_001),
  { id: 1_000_000_001, username: 'alice', password_hash: 'alice-hash' },
);

// Updating the same identity is safe and must not touch any other user.
authStore.syncSqliteUser(db, {
  id: 1_000_000_001,
  username: 'alice',
  password_hash: 'new-alice-hash',
  created_at: '2026-08-23T00:00:00.000Z',
});
assert.strictEqual(
  db.prepare('SELECT password_hash FROM users WHERE id=?').get(1_000_000_001).password_hash,
  'new-alice-hash',
);

// A different shared identity must never take over Alice's local state by ID.
assert.throws(() => authStore.syncSqliteUser(db, {
  id: 1_000_000_001,
  username: 'bob',
  password_hash: 'bob-hash',
  created_at: '2026-08-23T00:00:00.000Z',
}), /identity collision/);
assert.strictEqual(
  db.prepare('SELECT username FROM users WHERE id=?').get(1_000_000_001).username,
  'alice',
);

// Nor may a different shared ID take over Alice's local username.
assert.throws(() => authStore.syncSqliteUser(db, {
  id: 1_000_000_002,
  username: 'alice',
  password_hash: 'other-hash',
  created_at: '2026-08-23T00:00:00.000Z',
}), /identity collision/);
assert.strictEqual(
  db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
  1,
);

db.close();
console.log('PostgreSQL auth bridge isolation tests passed');