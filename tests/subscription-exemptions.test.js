'use strict';

// Subscription fee exemptions (Johnny 2026-10-17, PRIVATE): a small
// set of designated accounts never pay subscription fees. The exempt
// addresses are configured ONLY through the SUBSCRIPTION_EXEMPT_EMAILS
// environment variable — they never appear in this repo — so these
// tests configure obvious fakes through that same variable. Matching
// is keyed on the registered EMAIL (case-insensitive), resolved at the
// subscription-state layer: existing accounts and later registrations
// alike, in founding-list mode and in the billing phase. An exempt
// account reads as a full active subscriber everywhere: no popup, no
// checkout, no charge, and it counts as active for Refer & Save.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const sub = require('../lib/subscription');
const refs = require('../lib/referrals');
const exemptions = require('../lib/subscription-exemptions');
const read = p => readFileSync(require.resolve(p), 'utf8');
const html = read('../index.html');
const appJs = read('../public/js/app.js');
const subJs = read('../public/js/subscription.js');
const refsJs = read('../public/js/referrals.js');

// Obvious fakes — the real exempt addresses exist only in the server
// environment, never in this repo.
const EXEMPT_A = 'nephew1@example.com';
const EXEMPT_B = 'nephew2@example.com';

function freshDb() {
  process.env.SUBSCRIPTION_EXEMPT_EMAILS = `${EXEMPT_A},${EXEMPT_B}`;
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0)');
  sub.ensureSubscriptionSchema(db);
  refs.ensureReferralSchema(db);
  exemptions.ensureExemptionSchema(db);
  return db;
}

function addUser(db, id, email, { verified = 1 } = {}) {
  db.prepare('INSERT INTO users(id, email, email_verified) VALUES (?, ?, ?)')
    .run(id, email, verified);
}

const requireAuthStub = (req, res, next) => next();
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
    body: null, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    redirect() { return this; },
  };
}

test('env-configured list: both configured emails are exempt, matched case-insensitively', () => {
  const db = freshDb();
  assert.equal(exemptions.isExemptEmail(db, EXEMPT_A), true);
  assert.equal(exemptions.isExemptEmail(db, EXEMPT_B), true);
  assert.equal(exemptions.isExemptEmail(db, 'NEPHEW1@EXAMPLE.COM'), true, 'query case variant matches');
  assert.equal(exemptions.isExemptEmail(db, '  Nephew2@Example.com '), true, 'case + whitespace match');
  assert.equal(exemptions.isExemptEmail(db, 'someoneelse@example.test'), false);
  assert.equal(exemptions.isExemptEmail(db, ''), false);
  assert.equal(exemptions.isExemptEmail(db, null), false);
});

test('env parsing: comma-separated, whitespace- and case-tolerant; empty default exempts nobody', () => {
  assert.deepEqual(
    exemptions.getConfiguredExemptEmails({ SUBSCRIPTION_EXEMPT_EMAILS: ' Nephew1@Example.com ,NEPHEW2@example.com, ' }),
    [EXEMPT_A, EXEMPT_B]);
  assert.deepEqual(exemptions.getConfiguredExemptEmails({}), [], 'unset var → empty list');
  assert.deepEqual(exemptions.getConfiguredExemptEmails({ SUBSCRIPTION_EXEMPT_EMAILS: '' }), []);
  const saved = process.env.SUBSCRIPTION_EXEMPT_EMAILS;
  delete process.env.SUBSCRIPTION_EXEMPT_EMAILS;
  try {
    const db = freshDbNoEnv();
    assert.equal(exemptions.isExemptEmail(db, EXEMPT_A), false, 'nobody is exempt without configuration');
  } finally {
    process.env.SUBSCRIPTION_EXEMPT_EMAILS = saved;
  }
  function freshDbNoEnv() {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0)');
    return db;
  }
});

test('exempt account state: active with zero billing — no row, no popup, Active label', () => {
  const db = freshDb();
  addUser(db, 21, 'Nephew1@Example.com'); // registered with a case-variant email
  const s = sub.getPopupState(db, 21, { hasStripeKey: false });
  assert.equal(s.status, 'active');
  assert.equal(s.subscribed, true);
  assert.equal(s.exempt, true);
  assert.equal(s.shouldShowPopup, false, 'popup never appears for an exempt account');
  assert.equal(s.entryLabel, 'Agentic Trading: Active');
  assert.equal(sub.getSubscriptionRow(db, 21), null,
    'reading state creates no subscription/founding row — zero billing footprint');
  const sLive = sub.getPopupState(db, 21, { hasStripeKey: true });
  assert.equal(sLive.status, 'active', 'active in the billing phase too');
  assert.equal(sLive.subscribed, true);
});

test('computePopupState: exempt wins over any stored row, popup suppressed', () => {
  const s = sub.computePopupState(null, { exempt: true });
  assert.equal(s.subscribed, true);
  assert.equal(s.status, 'active');
  assert.equal(s.shouldShowPopup, false);
  const s2 = sub.computePopupState(
    { status: 'none', founding: 0, popup_dismissed_at: null }, { exempt: true });
  assert.equal(s2.subscribed, true);
  const plain = sub.computePopupState(null, {});
  assert.equal(plain.exempt, false, 'non-exempt state is explicitly not exempt');
});

test('checkout in founding mode: exempt account is answered Active, no founding signup recorded', async () => {
  const db = freshDb();
  addUser(db, 22, EXEMPT_B);
  const app = fakeApp();
  sub.mountSubscription({
    app, db, requireAuth: requireAuthStub,
    getStripeSecretKey: () => null,
    fetchImpl: async () => { throw new Error('Stripe must not be called for an exempt account'); },
  });
  const res = fakeRes();
  await app.handlers.get('POST /api/subscription/checkout')({ session: { userId: 22 } }, res);
  assert.equal(res.body.mode, 'exempt');
  assert.equal(res.body.status, 'active');
  assert.equal(res.body.subscribed, true);
  assert.equal(res.body.confirmation, sub.EXEMPT_CONFIRMATION);
  assert.equal(sub.getSubscriptionRow(db, 22), null,
    'no founding row, no session id — the exempt account never enters billing');
});

test('checkout with a Stripe key: exempt account creates NO Stripe session and is never charged', async () => {
  const db = freshDb();
  addUser(db, 23, EXEMPT_A);
  let stripeCalls = 0;
  const app = fakeApp();
  sub.mountSubscription({
    app, db, requireAuth: requireAuthStub,
    getStripeSecretKey: () => 'sk_test_stubbed',
    fetchImpl: async () => {
      stripeCalls += 1;
      throw new Error('Stripe must not be called for an exempt account');
    },
  });
  const res = fakeRes();
  await app.handlers.get('POST /api/subscription/checkout')(
    { session: { userId: 23 }, protocol: 'https', get: () => 'example.test' }, res);
  assert.equal(stripeCalls, 0, 'zero Stripe calls for an exempt account');
  assert.equal(res.body.mode, 'exempt');
  assert.equal(res.body.url, undefined, 'no checkout URL handed out');
  assert.equal(res.body.sessionId, undefined, 'no session id');
  assert.equal(res.body.status, 'active');
  assert.equal(sub.getSubscriptionRow(db, 23), null, 'nothing recorded, nothing to charge');
});

test('not-yet-registered exempt email becomes active on registration + verification', () => {
  const db = freshDb();
  // Before the account exists the email is already configured, but no
  // user resolves as exempt.
  assert.equal(exemptions.isExemptEmail(db, EXEMPT_B), true);
  assert.equal(exemptions.isExemptUser(db, 42), false, 'no such account yet');
  // The account registers (with a case-variant email) and verifies.
  addUser(db, 42, 'NEPHEW2@EXAMPLE.COM', { verified: 1 });
  assert.equal(exemptions.isExemptUser(db, 42), true);
  const s = sub.getPopupState(db, 42, {});
  assert.equal(s.status, 'active');
  assert.equal(s.subscribed, true);
  assert.equal(refs.isActiveSubscriber(db, 42), true, 'counts as active in founding phase');
  assert.equal(refs.isActiveSubscriber(db, 42, { billingLive: true }), true,
    'counts as active in the billing phase too — without ever paying');
});

test('exempt referred account counts toward the referrer discount in both phases', () => {
  const db = freshDb();
  addUser(db, 7, 'referrer@example.test');
  addUser(db, 24, EXEMPT_A);
  const code = refs.getOrCreateReferralCode(db, 7);
  const attr = refs.recordAttribution(db, {
    referredUserId: 24, referrerUserId: 7, code,
    referredEmail: EXEMPT_A, referrerEmail: 'referrer@example.test',
  });
  assert.equal(attr.ok, true);
  // The exempt account never joins the founding list and never pays —
  // it still counts, so the referrer holds the 20% tier in either phase.
  const foundingPhase = refs.getReferralSummary(db, 7);
  assert.equal(foundingPhase.activeCount, 1);
  assert.equal(foundingPhase.discountPct, 20);
  assert.equal(foundingPhase.discountedPriceDisplay, '$39.99');
  const billingPhase = refs.getReferralSummary(db, 7, { billingLive: true });
  assert.equal(billingPhase.activeCount, 1, 'exempt referral counts with billing live');
  assert.equal(billingPhase.discountPct, 20);
});

test('non-exempt accounts behave exactly as before', async () => {
  const db = freshDb();
  addUser(db, 30, 'regular@example.test');
  const s = sub.getPopupState(db, 30, {});
  assert.equal(s.status, 'none');
  assert.equal(s.subscribed, false);
  assert.equal(s.exempt, false);
  assert.equal(s.shouldShowPopup, true);
  assert.equal(s.entryLabel, 'Unlock Agentic Trading');
  assert.equal(refs.isActiveSubscriber(db, 30), false);
  assert.equal(refs.isActiveSubscriber(db, 30, { billingLive: true }), false);
  // Founding flow still works for them.
  const app = fakeApp();
  sub.mountSubscription({
    app, db, requireAuth: requireAuthStub,
    getStripeSecretKey: () => null,
    fetchImpl: async () => { throw new Error('no Stripe in founding mode'); },
  });
  const res = fakeRes();
  await app.handlers.get('POST /api/subscription/checkout')({ session: { userId: 30 } }, res);
  assert.equal(res.body.mode, 'founding');
  assert.equal(sub.getSubscriptionRow(db, 30).status, 'founding');
  const after = sub.getPopupState(db, 30, {});
  assert.equal(after.founding, true);
  assert.equal(after.exempt, false);
});

test('privacy: no exempt address is baked into any tracked source or public surface', () => {
  const exSrc = read('../lib/subscription-exemptions.js');
  assert.ok(exSrc.includes('SUBSCRIPTION_EXEMPT_EMAILS'), 'the list comes from the environment');
  assert.ok(!/@(gmail|yahoo|outlook|hotmail)\.com/i.test(exSrc),
    'no real-world address baked into the exemptions module');
  for (const [name, src] of Object.entries({ html, appJs, subJs, refsJs })) {
    assert.ok(!src.includes(EXEMPT_A) && !src.includes(EXEMPT_B),
      `${name} carries no exemption list`);
    assert.ok(!src.includes('SUBSCRIPTION_EXEMPT_EMAILS') && !src.includes('subscription_exemptions'),
      `${name} exposes nothing about the exemption mechanism`);
  }
  // The status payload for an exempt account carries no list, no other
  // accounts, and no marker beyond its own Active state.
  const db = freshDb();
  addUser(db, 21, EXEMPT_A);
  const s = sub.getPopupState(db, 21, {});
  assert.deepEqual(Object.keys(s).sort(), [
    'checkoutMode', 'dismissed', 'entryLabel', 'exempt', 'founding',
    'priceCents', 'priceDisplay', 'shouldShowPopup', 'status', 'subscribed',
  ], 'state shape is the standard one — nothing extra leaks');
});

test('wiring: both subscription state and the referral switch consult the email-keyed list', () => {
  const subSrc = read('../lib/subscription.js');
  const refsSrc = read('../lib/referrals.js');
  const exSrc = read('../lib/subscription-exemptions.js');
  assert.ok(subSrc.includes("require('./subscription-exemptions')"), 'subscription requires the exemption module');
  assert.ok(refsSrc.includes("require('./subscription-exemptions')"), 'referrals requires the exemption module');
  assert.ok(subSrc.includes('isExemptUser'), 'subscription state resolves the exemption');
  assert.ok(refsSrc.includes('isExemptUser'), 'the active-subscriber switch resolves the exemption');
  assert.ok(exSrc.includes('subscription_exemptions'), 'configured addresses land in the email-keyed table');
  assert.ok(exSrc.includes('toLowerCase'), 'matching is case-insensitive');
});
