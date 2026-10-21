'use strict';

// Email-verification token lifecycle for VixionBot.
//
// Only the SHA-256 hash of a token is ever persisted; the raw token exists
// solely in the verification email link. Tokens are single-use with a 24-hour
// expiry. All functions take an explicit better-sqlite3 db handle so they are
// unit-testable against :memory: databases.
//
// Expected schema (created by server.js migrations):
//   users(email TEXT, email_verified INTEGER NOT NULL DEFAULT 0)
//   email_verification_tokens(id, user_id, token_hash UNIQUE, expires_at,
//                             used_at, created_at)

const crypto = require('crypto');

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

// Issue a fresh token for a user. Any previous unused tokens for that user are
// invalidated so only the newest link works.
function issueToken(db, userId, nowMs = Date.now()) {
  const raw = generateToken();
  const tokenHash = hashToken(raw);
  const expiresAt = toIso(nowMs + TOKEN_TTL_MS);
  const invalidate = db.prepare(
    `UPDATE email_verification_tokens SET used_at = COALESCE(used_at, datetime('now'))
     WHERE user_id = ? AND used_at IS NULL`
  );
  const insert = db.prepare(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`
  );
  const run = db.transaction(() => {
    invalidate.run(userId);
    insert.run(userId, tokenHash, expiresAt);
  });
  run();
  return { raw, tokenHash, expiresAt };
}

// Validate a raw token. On success the token is atomically marked used and the
// owning user id is returned. Returns { ok, userId?, code? } where code is one
// of 'invalid' | 'expired' | 'used'.
function consumeToken(db, rawToken, nowMs = Date.now()) {
  if (!rawToken || typeof rawToken !== 'string') return { ok: false, code: 'invalid' };
  const tokenHash = hashToken(rawToken);
  const row = db.prepare(
    'SELECT id, user_id, expires_at, used_at FROM email_verification_tokens WHERE token_hash = ?'
  ).get(tokenHash);
  if (!row) return { ok: false, code: 'invalid' };
  if (row.used_at) return { ok: false, code: 'used' };
  if (Date.parse(row.expires_at) <= nowMs) return { ok: false, code: 'expired' };
  const mark = db.prepare(
    `UPDATE email_verification_tokens SET used_at = datetime('now')
     WHERE id = ? AND used_at IS NULL`
  );
  const changed = mark.run(row.id).changes;
  if (!changed) return { ok: false, code: 'used' }; // lost a single-use race
  return { ok: true, userId: Number(row.user_id) };
}

function isEmailVerified(db, userId) {
  const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(userId);
  return !!row && Number(row.email_verified) === 1;
}

function setEmailVerified(db, userId, verified) {
  db.prepare('UPDATE users SET email_verified = ? WHERE id = ?').run(verified ? 1 : 0, userId);
}

function getUserEmail(db, userId) {
  const row = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  return row ? row.email || null : null;
}

// Grandfathering: users who already connected a broker or have trading
// activity keep full access without needing to verify.
const ACTIVITY_TABLES = [
  'alpaca_creds',
];

function tableExists(db, name) {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
    return !!row;
  } catch {
    return false;
  }
}

function hasBrokerActivity(db, userId) {
  for (const table of ACTIVITY_TABLES) {
    if (!tableExists(db, table)) continue;
    try {
      const row = db.prepare(`SELECT 1 FROM ${table} WHERE user_id = ? LIMIT 1`).get(userId);
      if (row) return true;
    } catch {
      // Table exists but has no user_id column — skip rather than fail.
    }
  }
  return false;
}

// Grandfathering (refined rule): EVERY account that exists at deploy time is
// marked verified, so no existing user is ever locked out — login is
// username-based and nobody verified anything before this shipped. Only
// accounts registered after the deploy go through the verification flow.
// A sentinel row makes this run exactly once per database.
function grandfatherAllUsers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const done = db.prepare(`SELECT 1 FROM schema_meta WHERE key='email_verification_grandfathered'`).get();
  if (done) return 0;
  const result = db.prepare(`UPDATE users SET email_verified=1 WHERE COALESCE(email_verified,0)=0`).run();
  db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('email_verification_grandfathered', datetime('now'))`).run();
  return result.changes;
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  return e.length >= 5 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

module.exports = {
  TOKEN_TTL_MS,
  generateToken,
  hashToken,
  issueToken,
  consumeToken,
  isEmailVerified,
  setEmailVerified,
  getUserEmail,
  hasBrokerActivity,
  grandfatherAllUsers,
  isValidEmail,
};
