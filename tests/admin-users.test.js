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
const adminControls = require('../lib/admin-controls');
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
    connected: true, mode: 'LIVE', enabled: true, adminHold: false, openPositions: 2,
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
  assert.ok(html.includes('/js/users.js?v=20261019a'), 'users.js included with a cache-busting tag');
  assert.ok(html.includes('/public/css/users.css?v=20261019a'), 'users.css included with a cache-busting tag');
  assert.ok(html.includes('/js/app.js?v=20261020b'), 'app.js tag bumped for the nav injection');
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

// --- admin controls: mutations behind the same gate (Johnny 2026-10-17) ------
//
// Suspend/reactivate, subscription-state setting, and the per-account
// fee discount. The rails: non-owners get 404 on every mutation
// endpoint, the owner can never be a mutation target, an admin-set
// Exempt behaves exactly like the env-configured one, the effective
// discount is max(referral, admin), and every change lands in the
// audit log with old → new values.

const MUTATION_PATHS = [
  '/api/admin/users/:userId/suspension',
  '/api/admin/users/:userId/subscription',
  '/api/admin/users/:userId/discount',
];
const MUTATION_BODIES = {
  '/api/admin/users/:userId/suspension': { suspended: true },
  '/api/admin/users/:userId/subscription': { state: 'active' },
  '/api/admin/users/:userId/discount': { pct: 25 },
};

function fakeKiaanWithHold() {
  const holds = [];
  return {
    holds,
    adminBotRoster: () => FAKE_ROSTER.map(r => ({ ...r })),
    setAdminHold: (uid, on) => { holds.push([Number(uid), !!on]); return false; },
  };
}

function mountedControls() {
  const db = fixtureDb();
  const app = fakeApp();
  const kiaanService = fakeKiaanWithHold();
  admin.mountAdminUsers({ app, db, kiaanService, getStripeSecretKey: () => null });
  return { db, app, kiaanService };
}

async function post(app, path, opts) {
  const handler = app.handlers.get(`POST ${path}`);
  assert.ok(handler, `route mounted: POST ${path}`);
  const res = fakeRes();
  await handler(
    { session: opts.session, params: { userId: String(opts.targetId) }, body: opts.body }, res);
  return res;
}

test('mutations: non-owner and anonymous get 404 on every endpoint, nothing changes', async () => {
  const { db, app, kiaanService } = mountedControls();
  for (const path of MUTATION_PATHS) {
    const body = MUTATION_BODIES[path];
    const otherRes = await post(app, path, { session: { userId: 22 }, targetId: 21, body });
    assert.equal(otherRes.statusCode, 404, `non-owner POST ${path} reads as not found`);
    assert.ok(!JSON.stringify(otherRes.body).includes('@example.test'), 'no user data in the 404');
    const anonRes = await post(app, path, { session: undefined, targetId: 21, body });
    assert.equal(anonRes.statusCode, 404, `anonymous POST ${path} reads as not found`);
  }
  assert.equal(adminControls.isSuspended(db, 21), false, 'no suspension was written');
  assert.equal(adminControls.getAdminDiscountPct(db, 21), null, 'no discount was written');
  assert.equal(kiaanService.holds.length, 0, 'bot hold never touched');
  assert.equal(adminControls.listAudit(db, 50).length, 0, 'no audit rows from refused attempts');
});

test('mutations: the owner can never be a target — clear refusal, no state change', async () => {
  const { db, app } = mountedControls();
  for (const path of MUTATION_PATHS) {
    const res = await post(app, path, {
      session: { userId: OWNER }, targetId: OWNER, body: MUTATION_BODIES[path],
    });
    assert.equal(res.statusCode, 400, `owner self-mutation refused on ${path}`);
    assert.match(res.body.error, /owner account cannot/i);
  }
  assert.equal(adminControls.isSuspended(db, OWNER), false);
  assert.equal(adminControls.getAdminDiscountPct(db, OWNER), null);
  assert.equal(sub.getPopupState(db, OWNER).status, 'none', 'owner subscription state untouched');
  assert.equal(adminControls.listAudit(db, 50).length, 0, 'refusals are not audited as actions');
});

test('suspend: blocks at the state layer, sets the bot hold, audits; reactivate restores both', async () => {
  const { db, app, kiaanService } = mountedControls();
  const res = await post(app, '/api/admin/users/:userId/suspension', {
    session: { userId: OWNER }, targetId: 21, body: { suspended: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.suspended, true, 'refreshed row shows the suspension');
  assert.equal(adminControls.isSuspended(db, 21), true, 'the flag server.js requireAuth reads is set');
  assert.deepEqual(kiaanService.holds, [[21, true]], 'bot admin_hold set through the service');

  let audit = adminControls.listAudit(db, 10);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'suspend');
  assert.equal(audit[0].target_user_id, 21);
  assert.equal(audit[0].actor_user_id, OWNER);
  assert.equal(audit[0].old_value, 'active');
  assert.equal(audit[0].new_value, 'suspended');

  const back = await post(app, '/api/admin/users/:userId/suspension', {
    session: { userId: OWNER }, targetId: 21, body: { suspended: false },
  });
  assert.equal(back.statusCode, 200);
  assert.equal(back.body.user.suspended, false);
  assert.equal(adminControls.isSuspended(db, 21), false, 'reactivation lifts the flag exactly');
  assert.deepEqual(kiaanService.holds, [[21, true], [21, false]], 'bot hold lifted with the account');
  audit = adminControls.listAudit(db, 10);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].action, 'reactivate', 'audit is newest first');
  assert.equal(audit[0].old_value, 'suspended');
  assert.equal(audit[0].new_value, 'active');

  const badBody = await post(app, '/api/admin/users/:userId/suspension', {
    session: { userId: OWNER }, targetId: 21, body: { suspended: 'yes' },
  });
  assert.equal(badBody.statusCode, 400, 'non-boolean suspended is refused');
});

test('subscription setting: free/founding/active write through the shared state row', async () => {
  const { db, app } = mountedControls();
  const setState = state => post(app, '/api/admin/users/:userId/subscription', {
    session: { userId: OWNER }, targetId: 24, body: { state },
  });
  let res = await setState('founding');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.subscription, 'Founding');
  assert.equal(sub.getSubscriptionRow(db, 24).status, 'founding');

  res = await setState('active');
  assert.equal(res.body.user.subscription, 'Active');
  assert.equal(sub.getPopupState(db, 24).status, 'active');

  res = await setState('free');
  assert.equal(res.body.user.subscription, 'Free');
  assert.equal(sub.getPopupState(db, 24).status, 'none');

  const audit = adminControls.listAudit(db, 10)
    .filter(r => r.action === 'subscription' && r.target_user_id === 24);
  assert.deepEqual(audit.map(r => [r.old_value, r.new_value]), [
    ['Active', 'Free'], ['Founding', 'Active'], ['Free', 'Founding'],
  ], 'each change audited with old → new labels, newest first');

  const bad = await post(app, '/api/admin/users/:userId/subscription', {
    session: { userId: OWNER }, targetId: 24, body: { state: 'vip' },
  });
  assert.equal(bad.statusCode, 400, 'unknown states are refused');
});

test('admin-set Exempt behaves exactly like the configured exemption, and un-sets cleanly', async () => {
  const { db, app } = mountedControls();
  const res = await post(app, '/api/admin/users/:userId/subscription', {
    session: { userId: OWNER }, targetId: 24, body: { state: 'exempt' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.subscription, 'Exempt');
  assert.equal(exemptions.isExemptUser(db, 24), true, 'same store as the env configuration');
  // Popup layer: full active subscriber, no popup, Active label.
  const state = sub.getPopupState(db, 24);
  assert.equal(state.status, 'active');
  assert.equal(state.subscribed, true);
  assert.equal(state.shouldShowPopup, false);
  // Referral switch: an exempt account counts as an active subscriber.
  assert.equal(refs.isActiveSubscriber(db, 24), true);
  // Checkout route: exempt short-circuit — no founding signup recorded.
  const checkoutApp = fakeApp();
  sub.mountSubscription({
    app: checkoutApp, db,
    requireAuth: (req, res2, next) => next(),
    getStripeSecretKey: () => null,
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  const checkout = checkoutApp.handlers.get('POST /api/subscription/checkout');
  const coRes = fakeRes();
  await checkout({ session: { userId: 24 }, protocol: 'https', get: () => 'example.test' }, coRes);
  assert.equal(coRes.body.mode, 'exempt', 'checkout refuses an exempt account');
  assert.equal(sub.getSubscriptionRow(db, 24), null, 'no founding/active row was written for the exempt account');

  const back = await post(app, '/api/admin/users/:userId/subscription', {
    session: { userId: OWNER }, targetId: 24, body: { state: 'free' },
  });
  assert.equal(back.body.user.subscription, 'Free');
  assert.equal(exemptions.isExemptUser(db, 24), false, 'admin exemption removed when the state moves on');
  assert.equal(refs.isActiveSubscriber(db, 24), false, 'and it stops counting as an active subscriber');
});

test('an env-configured exemption survives an admin state change (the configuration wins)', async () => {
  const db = fixtureDb();
  addUser(db, 31, 'envkeep@example.test');
  const app = fakeApp();
  admin.mountAdminUsers({ app, db, kiaanService: fakeKiaanService, getStripeSecretKey: () => null });
  process.env.SUBSCRIPTION_EXEMPT_EMAILS = 'envkeep@example.test';
  try {
    assert.equal(exemptions.isExemptUser(db, 31), true, 'fixture: exempt via the environment');
    const res = await post(app, '/api/admin/users/:userId/subscription', {
      session: { userId: OWNER }, targetId: 31, body: { state: 'free' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.user.subscription, 'Exempt', 'label stays Exempt — the env configuration wins');
    assert.equal(exemptions.isExemptUser(db, 31), true);
  } finally {
    delete process.env.SUBSCRIPTION_EXEMPT_EMAILS;
  }
});

test('fee discount: effective = max(referral, admin); clearing returns to the referral tier', async () => {
  const { db, app } = mountedControls();
  const setDiscount = pct => post(app, '/api/admin/users/:userId/discount', {
    session: { userId: OWNER }, targetId: 21, body: { pct },
  });
  // Fixture: user 21 has ONE active referral → 20% referral discount.
  assert.equal(adminControls.getEffectiveDiscountPct(db, 21, { billingLive: false }), 20);

  let res = await setDiscount(30);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.adminDiscountPct, 30);
  assert.equal(res.body.user.effectiveDiscountPct, 30, 'admin 30 beats referral 20');
  assert.equal(adminControls.getEffectiveDiscountPct(db, 21, { billingLive: false }), 30);

  // A second active referral earns 40% — the admin deal must NOT undercut it.
  addUser(db, 25, 'second@example.test');
  sub.recordFoundingSignup(db, 25);
  refs.recordAttribution(db, {
    referredUserId: 25, referrerUserId: 21, code: refs.getOrCreateReferralCode(db, 21),
    referredEmail: 'second@example.test', referrerEmail: 'founding@example.test',
  });
  assert.equal(refs.getReferralDiscountPct(db, 21, { billingLive: false }), 40);
  assert.equal(adminControls.getEffectiveDiscountPct(db, 21, { billingLive: false }), 40,
    'referral 40 beats admin 30 — effective follows the better deal');

  res = await setDiscount(50);
  assert.equal(res.body.user.effectiveDiscountPct, 50, 'admin 50 beats referral 40');

  res = await setDiscount(null);
  assert.equal(res.body.user.adminDiscountPct, null, 'clearing removes the override');
  assert.equal(res.body.user.effectiveDiscountPct, 40, 'effective falls back to the referral tier');

  const audit = adminControls.listAudit(db, 10)
    .filter(r => r.action === 'discount' && r.target_user_id === 21);
  assert.deepEqual(audit.map(r => [r.old_value, r.new_value]), [
    ['50%', 'none'], ['30%', '50%'], ['none', '30%'],
  ], 'discount changes audited with old → new percentages');

  for (const bad of [150, -5, 12.5, 'lots']) {
    const badRes = await post(app, '/api/admin/users/:userId/discount', {
      session: { userId: OWNER }, targetId: 21, body: { pct: bad },
    });
    assert.equal(badRes.statusCode, 400, `invalid pct ${JSON.stringify(bad)} refused`);
  }
  assert.equal(adminControls.getAdminDiscountPct(db, 21), null, 'invalid attempts wrote nothing');
});

test('checkout coupons: any effective percentage gets a deterministic coupon id', async () => {
  assert.equal(sub.discountCouponId(20), 'qf-referral-20', 'referral tiers keep their durable ids');
  assert.equal(sub.discountCouponId(40), 'qf-referral-40');
  assert.equal(sub.discountCouponId(60), 'qf-referral-60');
  assert.equal(sub.discountCouponId(50), 'qf-discount-50');
  assert.equal(sub.discountCouponId(100), 'qf-discount-100');

  const params = sub.buildCheckoutSessionParams({
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no',
    userId: 7, discountPct: 50,
  });
  assert.deepEqual(params.discounts, [{ coupon: 'qf-discount-50' }]);
  const none = sub.buildCheckoutSessionParams({
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no', userId: 7,
  });
  assert.ok(!('discounts' in none), 'no discount → no coupon attached');

  // The coupon is ensured in Stripe before the session references it.
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/coupons/')) {
      return { ok: false, status: 404, json: async () => ({ error: { message: 'No such coupon' } }) };
    }
    if (options && options.method === 'POST' && url.endsWith('/coupons')) {
      return { ok: true, status: 200, json: async () => ({ id: 'qf-discount-50' }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'cs_test_50', url: 'https://checkout.stripe.com/c/cs_test_50' }) };
  };
  const session = await sub.createCheckoutSession({
    secretKey: 'sk_test_stubbed', fetchImpl: fetchStub,
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no',
    userId: 7, discountPct: 50,
  });
  assert.equal(session.id, 'cs_test_50');
  const createCoupon = calls.find(c => c.options && c.options.method === 'POST' && c.url.endsWith('/coupons'));
  assert.ok(createCoupon, 'the qf-discount-50 coupon was created first');
  assert.ok(decodeURIComponent(createCoupon.options.body).includes('percent_off=50'));
  const sessionCall = calls[calls.length - 1];
  assert.ok(decodeURIComponent(sessionCall.options.body).includes('qf-discount-50'),
    'the session references the ensured coupon');
});

test('payload: roster rows carry the control state; audit list rides along with target emails', async () => {
  const { db, app } = mountedControls();
  await post(app, '/api/admin/users/:userId/suspension', {
    session: { userId: OWNER }, targetId: 22, body: { suspended: true },
  });
  await post(app, '/api/admin/users/:userId/discount', {
    session: { userId: OWNER }, targetId: 22, body: { pct: 45 },
  });
  const payload = admin.buildAdminUsersPayload({ db, kiaanService: fakeKiaanWithHold() });
  const row = payload.users.find(u => u.id === 22);
  assert.equal(row.suspended, true);
  assert.equal(row.adminDiscountPct, 45);
  assert.equal(row.effectiveDiscountPct, 45, 'no referrals — the admin deal is the effective one');
  assert.equal(row.isOwnerRow, false);
  const ownerRow = payload.users.find(u => u.id === OWNER);
  assert.equal(ownerRow.isOwnerRow, true, 'the owner row is marked so the UI renders no controls');
  assert.equal(ownerRow.suspended, false);
  assert.equal(payload.audit.length, 2);
  assert.equal(payload.audit[0].action, 'discount', 'audit newest first');
  assert.equal(payload.audit[0].targetEmail, 'active@example.test');
  assert.equal(payload.audit[1].action, 'suspend');
});

test('server.js enforces suspension in requireAuth and at login', () => {
  assert.ok(serverJs.includes("require('./lib/admin-controls')"), 'admin-controls required');
  assert.ok(serverJs.includes('adminControls.isSuspended(db, uid)'), 'requireAuth checks the suspension flag');
  assert.ok(serverJs.includes('adminControls.isSuspended(db, user.id)'), 'login checks the suspension flag');
  assert.ok(serverJs.includes("code: 'ACCOUNT_SUSPENDED'"), 'suspension has its own refusal code');
});

test('users.js wires the admin controls and the audit list', () => {
  assert.ok(usersJs.includes('/suspension'), 'suspend/reactivate posts to the suspension endpoint');
  assert.ok(usersJs.includes('/subscription'), 'state changes post to the subscription endpoint');
  assert.ok(usersJs.includes('/discount'), 'fee changes post to the discount endpoint');
  assert.ok(usersJs.includes('user.isOwnerRow'), 'no controls render on the owner row');
  assert.ok(usersJs.includes('usrAudit'), 'the audit list renders');
  assert.ok(usersJs.includes('Recent admin actions'), 'audit section is labelled');
  assert.ok(usersJs.includes('data-action'), 'row actions are delegated from the table body');
});
