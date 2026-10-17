'use strict';

// USERS admin page (Johnny 2026-10-17): owner-only admin view of every
// registered user — email, joined/verified, subscription state in plain
// words (Free / Founding / Active / Exempt), referral standing, and each
// connected bot's mode/state/open positions/account size.
//
// The gate is the feature: page route AND data API return 404 for every
// non-owner (logged in or not), the nav entry is injected client-side
// only for the owner (never in static markup), and the "Exempt" label
// exists only inside this owner payload — the subscription layer calls
// the same accounts plain "active". Account size comes from the Kiaan
// service's stored per-user snapshot (captured whenever the service
// reads the broker account), never from a broker pull at page load.
// Fixtures/tests only — no production accounts.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const admin = require('../lib/admin-users');
const sub = require('../lib/subscription');
const refs = require('../lib/referrals');
const exemptions = require('../lib/subscription-exemptions');
const { createKiaanService } = require('../lib/kiaan/service');
const { createCredentialVault } = require('../lib/credential-vault');

const read = p => readFileSync(require.resolve(p), 'utf8');
const html = read('../index.html');
const serverJs = read('../server.js');
const appJs = read('../public/js/app.js');
const usersJs = read('../public/js/users.js');

const OWNER = admin.OWNER_USER_ID;

// --- user-store fixtures -----------------------------------------------------

function freshUserDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users(
    id INTEGER PRIMARY KEY, username TEXT, email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT)`);
  sub.ensureSubscriptionSchema(db);
  refs.ensureReferralSchema(db);
  exemptions.ensureExemptionSchema(db);
  return db;
}

function addUser(db, id, email, { verified = 1, created = '2026-10-10 12:00:00' } = {}) {
  db.prepare('INSERT INTO users(id, username, email, email_verified, created_at) VALUES (?,?,?,?,?)')
    .run(id, `user${id}`, email, verified, created);
}

// Owner + four accounts covering every subscription label:
//  21 founding (and a referrer), 22 active, 23 exempt, 24 free/unverified.
function fixtureDb() {
  const db = freshUserDb();
  addUser(db, OWNER, 'owner@example.test', { created: '2026-09-25 09:00:00' });
  addUser(db, 21, 'founding@example.test', { created: '2026-10-16 10:00:00' });
  addUser(db, 22, 'active@example.test', { created: '2026-10-16 11:00:00' });
  addUser(db, 23, 'family@example.test', { created: '2026-10-17 09:00:00' });
  addUser(db, 24, 'free@example.test', { verified: 0, created: '2026-10-17 10:00:00' });
  sub.recordFoundingSignup(db, 21);
  db.prepare("INSERT INTO agentic_subscriptions(user_id, status, founding) VALUES (22, 'active', 0)").run();
  exemptions.addExemption(db, 'family@example.test', 'test fixture');
  // Exempt wins over a stored status too: give 23 a founding row.
  sub.recordFoundingSignup(db, 23);
  // Referrals: 21 referred 22 (active) and 24 (free) → 1 active, 20% off.
  const code = refs.getOrCreateReferralCode(db, 21);
  refs.recordAttribution(db, {
    referredUserId: 22, referrerUserId: 21, code,
    referredEmail: 'active@example.test', referrerEmail: 'founding@example.test',
  });
  refs.recordAttribution(db, {
    referredUserId: 24, referrerUserId: 21, code,
    referredEmail: 'free@example.test', referrerEmail: 'founding@example.test',
  });
  return db;
}

const FAKE_ROSTER = [
  { userId: 21, connected: true, mode: 'LIVE', enabled: true, openPositions: 2, equity: 4321.5, buyingPower: 8000.25, equityAsOf: '2026-10-17T14:00:00.000Z' },
  { userId: 23, connected: true, mode: 'PAPER', enabled: false, openPositions: 0, equity: null, buyingPower: null, equityAsOf: null },
];
const fakeKiaanService = { adminBotRoster: () => FAKE_ROSTER.map(r => ({ ...r })) };

// --- payload assembly ----------------------------------------------------------

test('payload: totals, labels, referral standing, bot rows, newest first', () => {
  const db = fixtureDb();
  const payload = admin.buildAdminUsersPayload({ db, kiaanService: fakeKiaanService });
  assert.deepEqual(payload.totals, { users: 5, founding: 1, activeSubscribers: 2, botsConnected: 2 });
  const ids = payload.users.map(u => u.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'rows sorted newest first');
  const byId = new Map(payload.users.map(u => [u.id, u]));

  const founding = byId.get(21);
  assert.equal(founding.subscription, 'Founding');
  assert.equal(founding.emailVerified, true);
  assert.deepEqual(founding.referrals, { joined: 2, active: 1, discountPct: 20 });
  assert.deepEqual(founding.bot, {
    connected: true, mode: 'LIVE', enabled: true, openPositions: 2,
    equity: 4321.5, buyingPower: 8000.25, equityAsOf: '2026-10-17T14:00:00.000Z',
  });

  const active = byId.get(22);
  assert.equal(active.subscription, 'Active');
  assert.equal(active.bot, null, 'no bot connected → null (client renders dashes)');

  const exempt = byId.get(23);
  assert.equal(exempt.subscription, 'Exempt', 'exemption wins over the stored founding row');
  assert.equal(exempt.bot.connected, true);
  assert.equal(exempt.bot.equity, null, 'connected but never read → no size yet');

  const free = byId.get(24);
  assert.equal(free.subscription, 'Free');
  assert.equal(free.emailVerified, false);
  assert.equal(free.bot, null);

  assert.equal(byId.get(OWNER).subscription, 'Free');
});

test('the Exempt label is admin-only: the subscription layer calls the same account active', () => {
  const db = fixtureDb();
  const state = sub.getPopupState(db, 23);
  assert.equal(state.status, 'active');
  assert.equal(state.subscribed, true);
  assert.ok(!('label' in state) || state.label !== 'Exempt');
  assert.equal(admin.subscriptionStateLabel(db, { id: 23, email: 'family@example.test' }), 'Exempt');
});

test('payload works with no kiaan service (bot columns all null, totals still right)', () => {
  const db = fixtureDb();
  const payload = admin.buildAdminUsersPayload({ db, kiaanService: null });
  assert.equal(payload.totals.botsConnected, 0);
  assert.ok(payload.users.every(u => u.bot === null));
});

// --- route gating --------------------------------------------------------------

function fakeApp() {
  const handlers = new Map();
  return {
    handlers,
    get: (p, ...h) => handlers.set(`GET ${p}`, h[h.length - 1]),
    post: (p, ...h) => handlers.set(`POST ${p}`, h[h.length - 1]),
  };
}
function fakeRes() {
  return {
    body: null, statusCode: 200, redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    type() { return this; },
    send(payload) { this.body = payload; return this; },
    redirect(url) { this.statusCode = 302; this.redirectedTo = url; return this; },
  };
}
function mountedApp() {
  const db = fixtureDb();
  const app = fakeApp();
  admin.mountAdminUsers({ app, db, kiaanService: fakeKiaanService, getStripeSecretKey: () => null });
  return app;
}

test('API: owner gets 200 with rows; non-owner and anonymous get 404', async () => {
  const app = mountedApp();
  const handler = app.handlers.get('GET /api/admin/users');
  assert.ok(handler, 'route mounted');

  const ownerRes = fakeRes();
  await handler({ session: { userId: OWNER } }, ownerRes);
  assert.equal(ownerRes.statusCode, 200);
  assert.equal(ownerRes.body.ok, true);
  assert.equal(ownerRes.body.totals.users, 5);
  assert.equal(ownerRes.body.users.length, 5);

  const otherRes = fakeRes();
  await handler({ session: { userId: 21 } }, otherRes);
  assert.equal(otherRes.statusCode, 404, 'logged-in non-owner reads as not found');
  assert.ok(!JSON.stringify(otherRes.body).includes('@example.test'), 'no user data leaks in the 404');

  const anonRes = fakeRes();
  await handler({}, anonRes);
  assert.equal(anonRes.statusCode, 404, 'anonymous reads as not found, not 401');
});

test('page route: owner redirects into the SPA page; everyone else 404', async () => {
  const app = mountedApp();
  const handler = app.handlers.get('GET /users');
  assert.ok(handler, 'page route mounted');

  const ownerRes = fakeRes();
  await handler({ session: { userId: OWNER } }, ownerRes);
  assert.equal(ownerRes.redirectedTo, '/#users');

  const otherRes = fakeRes();
  await handler({ session: { userId: 22 } }, otherRes);
  assert.equal(otherRes.statusCode, 404);

  const anonRes = fakeRes();
  await handler({ session: null }, anonRes);
  assert.equal(anonRes.statusCode, 404);
});

// --- static wiring ---------------------------------------------------------------

test('server.js mounts the admin module pinned to the owner identity', () => {
  assert.ok(serverJs.includes("require('./lib/admin-users')"), 'admin module required');
  assert.ok(serverJs.includes('mountAdminUsers({'), 'admin module mounted');
  assert.ok(serverJs.includes('ownerUserId: 1000000005'), 'mounted with the owner id');
  assert.ok(serverJs.includes('isOwner: uid === 1000000005'), '/api/auth/me reports isOwner');
});

test('index.html: page container + bumped assets, and NO static USERS nav entry', () => {
  assert.ok(html.includes('id="page-users"'), 'page-users container exists');
  assert.ok(html.includes('/js/users.js?v=20261017a'), 'users.js included with a cache-busting tag');
  assert.ok(html.includes('/public/css/users.css?v=20261017a'), 'users.css included with a cache-busting tag');
  assert.ok(html.includes('/js/app.js?v=20261017b'), 'app.js tag bumped for the nav injection');
  assert.ok(!html.includes('data-page="users"'), 'USERS nav entry is never in the static markup');
});

test('app.js injects the USERS nav only for the owner and routes the page', () => {
  assert.ok(/page==='users'/.test(appJs), 'app.js activates the users page');
  assert.ok(/window\.usersPage/.test(appJs), 'app.js drives window.usersPage');
  assert.ok(appJs.includes('injectUsersNav'), 'owner nav injection exists');
  assert.ok(appJs.includes('user.isOwner'), 'injection is keyed on the owner flag');
  assert.ok(appJs.includes('removeUsersNav'), 'nav is removed on logout/non-owner');
});

test('users.js reads only the gated admin API and renders sizes with freshness', () => {
  assert.ok(usersJs.includes('/api/admin/users'), 'users.js fetches the admin API');
  assert.ok(usersJs.includes('Not reported yet'), 'unreported account size is labelled, not invented');
  assert.ok(usersJs.includes('window.usersPage'), 'users.js exposes window.usersPage');
  assert.ok(!usersJs.includes('/v2/account') && !usersJs.includes('alpaca'), 'no broker access from the client');
});

// --- kiaan service: snapshot capture + roster ------------------------------------

function makeKiaanFixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO users(id) VALUES (7);
    CREATE TABLE broker_account_owners(account_id TEXT PRIMARY KEY, user_id INTEGER, scope TEXT, mode TEXT, claimed_at TEXT);
    CREATE TABLE broker_account_quarantine(account_id TEXT PRIMARY KEY, resolved_at TEXT);
  `);
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-987654321');
  const account = {
    id: 'acct-admin-users-test', status: 'ACTIVE',
    trading_blocked: false, account_blocked: false, trade_suspended_by_user: false,
    equity: '4321.50', buying_power: '8000.25', last_equity: '4300.00',
  };
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v2/account') {
      return { ok: true, status: 200, json: async () => ({ ...account }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const service = createKiaanService({ db, vault, fetch: fetchImpl, persistenceReady: () => true });
  return { db, service, account };
}

test('kiaan service: status() captures the account snapshot; roster reports it', async () => {
  const { db, service, account } = makeKiaanFixture();
  assert.deepEqual(service.accountSnapshot(7), { equity: null, buyingPower: null, equityAsOf: null },
    'nothing captured before the first account read');
  await service.connect(7, { key: 'k'.repeat(8), secret: 's'.repeat(8), mode: 'live' });
  await service.setSettings(7, { enabled: true });
  await service.status(7);
  const snap = service.accountSnapshot(7);
  assert.equal(snap.equity, 4321.5);
  assert.equal(snap.buyingPower, 8000.25);
  assert.ok(typeof snap.equityAsOf === 'string' && snap.equityAsOf.length > 0, 'snapshot carries a timestamp');

  // A later read refreshes the stored size (fresher value, same path).
  account.equity = '4400.00';
  await service.status(7);
  assert.equal(service.accountSnapshot(7).equity, 4400);

  db.prepare(`INSERT INTO kiaan_positions(position_id, user_id, symbol, status, opened_at)
    VALUES ('pos-admin-1', 7, 'SQQQ', 'open', '2026-10-17T14:00:00.000Z')`).run();
  const roster = service.adminBotRoster();
  const row = roster.find(r => r.userId === 7);
  assert.equal(row.connected, true);
  assert.equal(row.mode, 'LIVE', 'roster reports the stored credential mode');
  assert.equal(row.enabled, true);
  assert.equal(row.openPositions, 1);
  assert.equal(row.equity, 4400, 'roster size is the latest captured snapshot');
  assert.equal(row.buyingPower, 8000.25);
  assert.ok(typeof row.equityAsOf === 'string' && row.equityAsOf.length > 0);
  assert.equal(roster.find(r => r.userId === 999), undefined, 'users with no bot state are absent (admin maps them to dashes)');
});
