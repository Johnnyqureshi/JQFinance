'use strict';

// Refer & Save (Johnny 2026-10-17): 20% off per referred friend who
// subscribes, stacking to a 60% cap, while they stay subscribed.
// Attribution end-to-end at the module level (arrive with code →
// register → referred_by set), self-referral and same-email refusal,
// set-once attribution, discount math, step-down on deactivation, the
// founding/billing-live switch in isActiveSubscriber, and the Stripe
// coupon hook at checkout. Tests only — no production accounts.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const refs = require('../lib/referrals');
const sub = require('../lib/subscription');
const read = p => readFileSync(require.resolve(p), 'utf8');
const html = read('../index.html');
const server = read('../server.js');
const appJs = read('../public/js/app.js');
const refsJs = read('../public/js/referrals.js');

function freshDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0)');
  sub.ensureSubscriptionSchema(db);
  refs.ensureReferralSchema(db);
  return db;
}

function addUser(db, id, { email = null, verified = 1 } = {}) {
  db.prepare('INSERT INTO users(id, email, email_verified) VALUES (?, ?, ?)')
    .run(id, email || `user${id}@example.test`, verified);
}

// The register-route flow, at the level the route itself runs it:
// resolve the posted code, then record attribution for the new account.
function simulateSignup(db, newUserId, code, newEmail) {
  const referrerId = refs.resolveReferralCode(db, code);
  assert.ok(referrerId, 'code resolves to a referrer');
  return refs.recordAttribution(db, {
    referredUserId: newUserId, referrerUserId: referrerId, code,
    referredEmail: newEmail, referrerEmail: `user${referrerId}@example.test`,
  });
}

function makeFounding(db, userId) {
  sub.recordFoundingSignup(db, userId);
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

test('referral code: stable per account, unique per account, resolves to exactly its owner', () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 8);
  const c7 = refs.getOrCreateReferralCode(db, 7);
  assert.equal(refs.getOrCreateReferralCode(db, 7), c7, 'same account, same code');
  const c8 = refs.getOrCreateReferralCode(db, 8);
  assert.notEqual(c7, c8, 'different accounts, different codes');
  assert.equal(refs.resolveReferralCode(db, c7), 7);
  assert.equal(refs.resolveReferralCode(db, c8), 8);
  assert.equal(refs.resolveReferralCode(db, c7.toLowerCase()), 7, 'codes are case-insensitive');
  assert.equal(refs.resolveReferralCode(db, 'ZZZZZZZZ'), null, 'unknown code resolves to nobody');
  assert.equal(refs.resolveReferralCode(db, ''), null);
  assert.equal(refs.resolveReferralCode(db, null), null);
});

test('attribution end-to-end: arrive with code → register → referred_by set, summary counts the join', () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 9);
  const code = refs.getOrCreateReferralCode(db, 7);
  const result = simulateSignup(db, 9, code, 'user9@example.test');
  assert.equal(result.ok, true);
  const attr = refs.getAttribution(db, 9);
  assert.equal(Number(attr.referrer_user_id), 7);
  assert.equal(attr.code, code);
  const summary = refs.getReferralSummary(db, 7);
  assert.equal(summary.joinedCount, 1);
  assert.equal(summary.code, code);
  assert.equal(summary.linkPath, `/?ref=${code}`);
});

test('self-referral is refused — a code can never attribute its own owner', () => {
  const db = freshDb();
  addUser(db, 7);
  const direct = refs.recordAttribution(db, { referredUserId: 7, referrerUserId: 7 });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'self-referral');
  assert.equal(refs.getAttribution(db, 7), null);
});

test('same-email attribution is refused', () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 9);
  const result = refs.recordAttribution(db, {
    referredUserId: 9, referrerUserId: 7,
    referredEmail: 'Same@Example.test', referrerEmail: 'same@example.test',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'same-email');
  assert.equal(refs.getAttribution(db, 9), null);
});

test('attribution is set once — a second code never overwrites the first referrer', () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 8); addUser(db, 9);
  refs.getOrCreateReferralCode(db, 7);
  const c8 = refs.getOrCreateReferralCode(db, 8);
  assert.equal(simulateSignup(db, 9, refs.getOrCreateReferralCode(db, 7), 'user9@example.test').ok, true);
  const second = simulateSignup(db, 9, c8, 'user9@example.test');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-attributed');
  assert.equal(Number(refs.getAttribution(db, 9).referrer_user_id), 7, 'first referrer stands');
});

test('discount math: 0/1/2/3/4 active referrals → 0/20/40/60/60% and $49.99/$39.99/$29.99/$19.99/$19.99', () => {
  const db = freshDb();
  addUser(db, 7);
  const code = refs.getOrCreateReferralCode(db, 7);
  const expect = [
    { pct: 0, display: '$49.99' }, { pct: 20, display: '$39.99' },
    { pct: 40, display: '$29.99' }, { pct: 60, display: '$19.99' },
    { pct: 60, display: '$19.99' },
  ];
  for (let i = 0; i < expect.length; i += 1) {
    const s = refs.getReferralSummary(db, 7);
    assert.equal(s.activeCount, i, `active count at step ${i}`);
    assert.equal(s.discountPct, expect[i].pct, `discount at step ${i}`);
    assert.equal(s.discountedPriceDisplay, expect[i].display, `price at step ${i}`);
    const friend = 100 + i;
    addUser(db, friend);
    assert.equal(simulateSignup(db, friend, code, `user${friend}@example.test`).ok, true);
    makeFounding(db, friend); // verified (default) + founding list → active in founding phase
  }
  const s = refs.getReferralSummary(db, 7);
  assert.equal(s.joinedCount, 5);
  assert.equal(s.activeCount, 5);
  assert.equal(s.discountPct, 60, 'cap holds past 3 referrals');
});

test('a referred account that is not verified does not count as active in founding phase', () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 9, { verified: 0 });
  const code = refs.getOrCreateReferralCode(db, 7);
  simulateSignup(db, 9, code, 'user9@example.test');
  makeFounding(db, 9);
  const s = refs.getReferralSummary(db, 7);
  assert.equal(s.joinedCount, 1, 'the join is tracked');
  assert.equal(s.activeCount, 0, 'unverified does not earn the discount');
  assert.equal(s.discountPct, 0);
});

test('discount steps down automatically when a referred account stops being active', () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 9); addUser(db, 10);
  const code = refs.getOrCreateReferralCode(db, 7);
  simulateSignup(db, 9, code, 'user9@example.test');
  simulateSignup(db, 10, code, 'user10@example.test');
  makeFounding(db, 9); makeFounding(db, 10);
  assert.equal(refs.getReferralSummary(db, 7).discountPct, 40);
  // Friend 10 leaves the founding list → no longer active → step down.
  db.prepare("UPDATE agentic_subscriptions SET status='none', founding=0 WHERE user_id=?").run(10);
  const s = refs.getReferralSummary(db, 7);
  assert.equal(s.activeCount, 1);
  assert.equal(s.discountPct, 20);
  assert.equal(s.discountedPriceDisplay, '$39.99');
});

test('billing-live switch: founding referrals stop counting, paying subscribers count', () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 9); addUser(db, 10);
  const code = refs.getOrCreateReferralCode(db, 7);
  simulateSignup(db, 9, code, 'user9@example.test');
  simulateSignup(db, 10, code, 'user10@example.test');
  makeFounding(db, 9);
  sub.markSubscribed(db, 10, {});
  assert.equal(refs.getReferralSummary(db, 7).activeCount, 2, 'founding phase counts both');
  const live = refs.getReferralSummary(db, 7, { billingLive: true });
  assert.equal(live.activeCount, 1, 'billing live counts only the paying subscriber');
  assert.equal(live.discountPct, 20);
  assert.equal(refs.isActiveSubscriber(db, 9, { billingLive: true }), false);
  assert.equal(refs.isActiveSubscriber(db, 10, { billingLive: true }), true);
});

test('owner is unaffected: Johnny gets a code and a summary, and his popup state never changes', () => {
  const db = freshDb();
  const OWNER = 1000000005;
  addUser(db, OWNER); addUser(db, 9);
  sub.recordFoundingSignup(db, OWNER);
  const before = sub.getPopupState(db, OWNER, {});
  const code = refs.getOrCreateReferralCode(db, OWNER);
  simulateSignup(db, 9, code, 'user9@example.test');
  makeFounding(db, 9);
  const summary = refs.getReferralSummary(db, OWNER);
  assert.equal(summary.discountPct, 20, 'owner earns referral discounts like anyone');
  const after = sub.getPopupState(db, OWNER, {});
  assert.deepEqual(after, before, 'referral activity does not touch subscription/popup state');
  assert.equal(after.founding, true);
});

test('GET /api/referrals/me returns the account summary (code, counts, discount, rule)', async () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 9);
  const app = fakeApp();
  const out = refs.mountReferrals({
    app, db, requireAuth: requireAuthStub, getStripeSecretKey: () => null,
  });
  assert.ok(out.routes.includes('GET /api/referrals/me'));
  const code = refs.getOrCreateReferralCode(db, 7);
  simulateSignup(db, 9, code, 'user9@example.test');
  makeFounding(db, 9);
  const res = fakeRes();
  await app.handlers.get('GET /api/referrals/me')({ session: { userId: 7 } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.code, code);
  assert.equal(res.body.linkPath, `/?ref=${code}`);
  assert.equal(res.body.joinedCount, 1);
  assert.equal(res.body.activeCount, 1);
  assert.equal(res.body.discountPct, 20);
  assert.equal(res.body.discountedPriceDisplay, '$39.99');
  assert.equal(res.body.rule, '20% off for each friend who subscribes, up to 60% off, while they stay subscribed.');
});

test('billing hook: checkout params carry the deterministic coupon for the effective discount', () => {
  const base = { successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no', userId: 7 };
  assert.equal(sub.buildCheckoutSessionParams(base).discounts, undefined, 'no discount, no coupon');
  assert.equal(sub.buildCheckoutSessionParams({ ...base, discountPct: 0 }).discounts, undefined, 'zero discount, no coupon');
  assert.deepEqual(
    sub.buildCheckoutSessionParams({ ...base, discountPct: 40 }).discounts,
    [{ coupon: 'qf-referral-40' }], 'referral tiers keep their durable coupon ids');
  // Admin fee discounts (USERS page, 2026-10-17) made ANY percentage a
  // real discount: off-tier pcts get their own deterministic coupon.
  assert.deepEqual(
    sub.buildCheckoutSessionParams({ ...base, discountPct: 15 }).discounts,
    [{ coupon: 'qf-discount-15' }], 'off-tier pct now maps to the generic discount coupon');
});

test('billing hook: session creation ensures the coupon, then posts the discount to Stripe', async () => {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/coupons/') && options.method === 'GET') {
      return { ok: false, status: 404, json: async () => ({ error: { message: "No such coupon: 'qf-referral-20'" } }) };
    }
    if (url.endsWith('/coupons')) return { ok: true, status: 200, json: async () => ({ id: 'qf-referral-20' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'cs_test_ref', url: 'https://checkout.stripe.com/c/cs_test_ref' }) };
  };
  const session = await sub.createCheckoutSession({
    secretKey: 'sk_test_stubbed', fetchImpl: fetchStub, userId: 7, discountPct: 20,
    successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no',
  });
  assert.equal(session.id, 'cs_test_ref');
  assert.equal(calls.length, 3, 'coupon GET miss → coupon POST → session POST');
  assert.ok(calls[0].url.includes('/coupons/qf-referral-20'));
  assert.ok(calls[1].url.endsWith('/coupons'));
  const couponBody = decodeURIComponent(calls[1].options.body);
  assert.ok(couponBody.includes('percent_off=20'), 'coupon created at 20% off');
  const sessionBody = decodeURIComponent(calls[2].options.body);
  assert.ok(sessionBody.includes('discounts[0][coupon]=qf-referral-20'), 'session carries the referral coupon');
  assert.ok(sessionBody.includes('[unit_amount]=4999'), 'list price stays the flat $49.99 — discount rides the coupon');
});

test('billing hook: checkout route applies the CURRENT referral discount for a paying-phase account', async () => {
  const db = freshDb();
  addUser(db, 7); addUser(db, 8);
  // Friend 8 arrived via 7's link and is a paying subscriber, so at
  // checkout time (billing live) account 7 holds a 20% entitlement.
  const code = refs.getOrCreateReferralCode(db, 7);
  simulateSignup(db, 8, code, 'user8@example.test');
  sub.markSubscribed(db, 8, {});
  const calls = [];
  const app = fakeApp();
  sub.mountSubscription({
    app, db, requireAuth: requireAuthStub,
    getStripeSecretKey: () => 'sk_test_stubbed',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/coupons/') && options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'qf-referral-20' }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'cs_test_disc', url: 'https://checkout.stripe.com/c/cs_test_disc' }) };
    },
  });
  const res = fakeRes();
  await app.handlers.get('POST /api/subscription/checkout')(
    { session: { userId: 7 }, protocol: 'https', get: () => 'example.test' }, res);
  assert.equal(res.body.mode, 'stripe');
  const sessionCall = calls.find(c => c.url.endsWith('/checkout/sessions'));
  assert.ok(sessionCall, 'session created');
  assert.ok(decodeURIComponent(sessionCall.options.body).includes('qf-referral-20'),
    'the live discount reached the Stripe session');
});

test('wiring: register carries the code, the card is on the dashboard, assets bumped', () => {
  assert.ok(server.includes("require('./lib/referrals')"), 'server requires the referrals module');
  assert.ok(server.includes('mountReferrals({'), 'server mounts referral routes');
  assert.ok(server.includes('referralCode'), 'register route reads the posted referral code');
  assert.ok(server.includes('recordAttribution'), 'register route records attribution');
  assert.ok(appJs.includes('qf-referral-code'), 'client stores the arrival code');
  assert.ok(appJs.includes('referralCode'), 'client posts the code at signup');
  assert.ok(appJs.includes('window.referralsCard?.refresh()'), 'dashboard refresh hooks the card');
  assert.ok(html.includes('id="referralCard"'), 'Refer & Save card present');
  assert.ok(html.includes('Refer &amp; Save'), 'card title present');
  assert.ok(html.includes('20% off for each friend who subscribes, up to 60% off, while they stay subscribed.'),
    'plain-language rule on the card');
  assert.ok(html.includes('id="referralLink"') && html.includes('id="referralCopyBtn"'), 'link + copy button present');
  assert.ok(html.includes('/js/referrals.js?v=20261018a'), 'referrals.js tag present and bumped');
  assert.ok(refsJs.includes('/api/referrals/me'), 'client reads the server summary');
  assert.ok(refsJs.includes('navigator.clipboard'), 'copy button uses the clipboard');
});
