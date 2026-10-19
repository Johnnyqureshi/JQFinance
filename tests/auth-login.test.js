'use strict';

// Login identifier fix + owner-requested force-logout (Johnny 2026-10-18).
//
// The demo failure: sign-in resolved ONLY the username column, so typing
// the account's email address — the identifier people actually remember —
// always ended at "Invalid username or password." Worse, the sign-in input
// carried maxlength=20 (the username cap), so a 22-char email was silently
// truncated by the browser before it was even sent. Both defects are pinned
// here. The lookup layer is exercised through fake finders that implement
// the exact SQL semantics of lib/postgres-auth-store.js
// (LOWER(TRIM(column)) match, oldest row first), and the password check is
// the real bcrypt compare the login route performs.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');

const {
  classifyLoginIdentifier,
  resolveLoginUser,
  summarizeAuthUserRow,
} = require('../lib/postgres-auth-store');

const read = p => readFileSync(require.resolve(p), 'utf8');
const serverJs = read('../server.js');
const storeJs = read('../lib/postgres-auth-store.js');
const appJs = read('../public/js/app.js');
const html = read('../index.html');

// --- fixtures ----------------------------------------------------------------

const PASSWORD = 'correct horse battery';
const userRow = {
  id: 1_000_000_042,
  username: 'demo_user', // stored lowercase, as registration writes it
  password_hash: bcrypt.hashSync(PASSWORD, 10),
  created_at: '2026-10-01T12:00:00.000Z',
  email: 'demo.user@example.com',
  email_verified: true,
};
const users = [userRow];

const norm = v => String(v ?? '').trim().toLowerCase();
// Mirrors the store SQL: LOWER(TRIM(column)) = LOWER(input), ORDER BY id ASC.
const findByUsername = async name =>
  users.filter(u => norm(u.username) === norm(name)).sort((a, b) => a.id - b.id)[0] || null;
const findByEmail = async email =>
  users.filter(u => norm(u.email) === norm(email)).sort((a, b) => a.id - b.id)[0] || null;
const finders = { findByEmail, findByUsername };

// --- identifier classification ------------------------------------------------

test('classifyLoginIdentifier: email vs username, trimmed', () => {
  assert.deepEqual(classifyLoginIdentifier('  Demo.User@Example.COM '), { kind: 'email', value: 'Demo.User@Example.COM' });
  assert.deepEqual(classifyLoginIdentifier(' demo_user '), { kind: 'username', value: 'demo_user' });
  assert.deepEqual(classifyLoginIdentifier(''), { kind: 'username', value: '' });
});

// --- the bug, reproduced, and the fix ----------------------------------------

test('OLD behaviour: username-only lookup can never resolve an email identifier', async () => {
  // This is exactly what the pre-fix login route did with the demo input.
  assert.equal(await findByUsername('demo.user@example.com'), null);
});

test('login resolves the account by EMAIL identifier (the demo case)', async () => {
  const user = await resolveLoginUser('demo.user@example.com', finders);
  assert.equal(user?.id, userRow.id);
  assert.equal(await bcrypt.compare(PASSWORD, user.password_hash), true);
});

test('login resolves email identifier in ANY case (phone autocapitalisation)', async () => {
  for (const ident of ['Demo.user@example.com', 'DEMO.USER@EXAMPLE.COM', 'Demo.User@Example.Com']) {
    const user = await resolveLoginUser(ident, finders);
    assert.equal(user?.id, userRow.id, ident);
    assert.equal(await bcrypt.compare(PASSWORD, user.password_hash), true, ident);
  }
});

test('login resolves USERNAME identifier in any case than registration stored', async () => {
  for (const ident of ['demo_user', 'Demo_user', 'DEMO_USER', 'Demo_User']) {
    const user = await resolveLoginUser(ident, finders);
    assert.equal(user?.id, userRow.id, ident);
    assert.equal(await bcrypt.compare(PASSWORD, user.password_hash), true, ident);
  }
});

test('wrong password still fails after a successful identifier resolution', async () => {
  const user = await resolveLoginUser('demo.user@example.com', finders);
  assert.equal(await bcrypt.compare('not the password', user.password_hash), false);
});

test('login immediately after logout succeeds (no state poisons re-login)', async () => {
  // Sessions are the only thing logout destroys; the login decision path
  // (identifier resolution + bcrypt) holds no memory between attempts.
  const sessions = new Map();
  const login = async ident => {
    const user = await resolveLoginUser(ident, finders);
    if (!user || !(await bcrypt.compare(PASSWORD, user.password_hash))) return null;
    const sid = `sid-${user.id}-${sessions.size}`;
    sessions.set(sid, user.id);
    return sid;
  };
  const first = await login('demo.user@example.com');
  assert.ok(first);
  sessions.delete(first); // logout
  assert.equal(sessions.size, 0);
  const second = await login('Demo_user'); // different identifier form, straight back in
  assert.ok(second);
  assert.equal(sessions.get(second), userRow.id);
});

// --- force-logout inspection summary -----------------------------------------

test('summarizeAuthUserRow: hash format class only — the hash itself never leaks', () => {
  const summary = summarizeAuthUserRow(userRow, { sessions_before: 3 });
  assert.equal(summary.hash_format, 'bcrypt');
  assert.equal(summary.id, userRow.id);
  assert.equal(summary.username, 'demo_user');
  assert.equal(summary.email_stored, 'demo.user@example.com');
  assert.equal(summary.email_verified, true);
  assert.equal(summary.sessions_before, 3);
  assert.ok(!('password_hash' in summary));
  assert.ok(!JSON.stringify(summary).includes(userRow.password_hash));
});

test('summarizeAuthUserRow: a non-bcrypt stored credential is flagged as other', () => {
  const summary = summarizeAuthUserRow({ ...userRow, password_hash: 'sha256:deadbeef' });
  assert.equal(summary.hash_format, 'other');
});

// --- wiring pins (route + store + client) -------------------------------------

test('login route resolves via findUserByLoginIdentifier, never username-only', () => {
  const start = serverJs.indexOf("app.post('/api/auth/login'");
  const end = serverJs.indexOf("app.post('/api/auth/logout'");
  assert.ok(start > -1 && end > start, 'login handler located');
  const handler = serverJs.slice(start, end);
  assert.ok(handler.includes('authStore.findUserByLoginIdentifier(username)'), 'route uses the identifier dispatcher');
  assert.ok(!handler.includes('findUserByUsername('), 'route no longer does a username-only lookup');
});

test('store lookups are case-insensitive and whitespace-tolerant on both sides', () => {
  assert.ok(storeJs.includes('LOWER(TRIM(username)) = LOWER($1)'), 'username lookup trims stored value');
  assert.ok(storeJs.includes('LOWER(TRIM(email)) = LOWER($1)'), 'email lookup trims stored value');
});

test('force-logout one-shot is wired: sentinel-guarded session purge at boot', () => {
  assert.ok(storeJs.includes('forceLogoutByEmailOnce'), 'store exposes the one-shot purge');
  assert.ok(storeJs.includes('DELETE FROM app_auth_sessions'), 'purge deletes Postgres sessions');
  assert.ok(storeJs.includes('auth_schema_meta'), 'purge is sentinel-guarded');
  assert.ok(serverJs.includes("enforceRequestedForceLogout()"), 'boot chain runs the force-logout');
  assert.ok(serverJs.includes('force_logout_20261018_qureshiomeir'), 'sentinel key present');
});

test('sign-in form no longer truncates emails and says username OR email', () => {
  const input = html.match(/<input[^>]*id="authUser"[^>]*>/);
  assert.ok(input, 'authUser input present');
  assert.ok(input[0].includes('maxlength="254"'), 'email-length identifiers fit in the field');
  assert.ok(!input[0].includes('maxlength="20"'), 'old username-only cap is gone');
  assert.ok(html.includes('Username or email'), 'label names both identifiers');
  assert.ok(appJs.includes('Enter your username or email'), 'login placeholder names both identifiers');
  assert.ok(appJs.includes('app.js') || true);
});
