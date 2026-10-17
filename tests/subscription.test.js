'use strict';

// Unlock Agentic Trading subscription (Johnny 2026-10-16): ONE flat
// $49.99/mo plan, no tiers. Popup state logic, founding-signup record,
// Stripe Checkout session creation with a stubbed key, and
// success-return marking. No real Stripe key is ever used here.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const sub = require('../lib/subscription');
const read = p => readFileSync(require.resolve(p), 'utf8');
const html = read('../index.html');
const server = read('../server.js');
const appJs = read('../public/js/app.js');
const subJs = read('../public/js/subscription.js');

function freshDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO users(id) VALUES (7)').run();
  sub.ensureSubscriptionSchema(db);
  return db;
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
    body: null, statusCode: 200, redirectTo: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    redirect(url) { this.redirectTo = url; return this; },
  };
}

test('popup state: fresh account sees the popup; price is the flat $49.99', () => {
  const s = sub.computePopupState(null, { hasStripeKey: false });
  assert.equal(s.shouldShowPopup, true);
  assert.equal(s.status, 'none');
  assert.equal(s.priceCents, 4999);
  assert.equal(s.priceDisplay, '$49.99');
  assert.equal(s.checkoutMode, 'founding');
  assert.equal(s.entryLabel, 'Unlock Agentic Trading');
  assert.equal(sub.computePopupState(null, { hasStripeKey: true }).checkoutMode, 'stripe');
});

test('popup state: dismissal is remembered — popup stays down, entry point remains', () => {
  const db = freshDb();
  sub.recordPopupDismissal(db, 7);
  const s = sub.getPopupState(db, 7, {});
  assert.equal(s.dismissed, true);
  assert.equal(s.shouldShowPopup, false);
  assert.equal(s.entryLabel, 'Unlock Agentic Trading');
});

test('popup state: founding signup suppresses the popup and relabels the entry point', () => {
  const db = freshDb();
  sub.recordFoundingSignup(db, 7);
  const s = sub.getPopupState(db, 7, {});
  assert.equal(s.founding, true);
  assert.equal(s.shouldShowPopup, false);
  assert.equal(s.entryLabel, 'Agentic Trading: Founding list');
});

test('popup state: subscribers never see the popup; entry point reads Active', () => {
  const s = sub.computePopupState(
    { status: 'active', founding: 1, popup_dismissed_at: null }, {});
  assert.equal(s.subscribed, true);
  assert.equal(s.shouldShowPopup, false);
  assert.equal(s.entryLabel, 'Agentic Trading: Active');
});

test('founding-signup record: user id, timestamp, founding flag, $49.99, idempotent', () => {
  const db = freshDb();
  const row = sub.recordFoundingSignup(db, 7);
  assert.equal(row.user_id, 7);
  assert.equal(row.status, 'founding');
  assert.equal(Number(row.founding), 1);
  assert.ok(row.founding_at, 'founding timestamp recorded');
  assert.equal(Number(row.plan_amount_cents), 4999);
  const again = sub.recordFoundingSignup(db, 7);
  assert.equal(again.founding_at, row.founding_at, 're-click keeps the original timestamp');
});

test('checkout params: subscription mode with inline price_data (4999 USD, monthly, product name)', () => {
  const p = sub.buildCheckoutSessionParams({
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no', userId: 7,
  });
  assert.equal(p.mode, 'subscription');
  const item = p.line_items[0];
  assert.equal(item.price_data.unit_amount, 4999);
  assert.equal(item.price_data.currency, 'usd');
  assert.equal(item.price_data.recurring.interval, 'month');
  assert.equal(item.price_data.product_data.name, 'QureshiFinance Agentic Trading');
  assert.equal(p.client_reference_id, '7');
});

test('checkout-session creation with a stubbed key posts the inline price to Stripe', async () => {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true, status: 200,
      json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/cs_test_123' }),
    };
  };
  const session = await sub.createCheckoutSession({
    secretKey: 'sk_test_stubbed',
    fetchImpl: fetchStub,
    successUrl: 'https://example.test/api/subscription/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://example.test/api/subscription/checkout/cancel',
    userId: 7,
  });
  assert.equal(session.id, 'cs_test_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk_test_stubbed');
  const body = decodeURIComponent(calls[0].options.body);
  assert.ok(body.includes('mode=subscription'), 'subscription mode sent');
  assert.ok(body.includes('[unit_amount]=4999'), 'inline price_data amount 4999 sent');
  assert.ok(body.includes('[currency]=usd'), 'usd sent');
  assert.ok(body.includes('[recurring][interval]=month'), 'monthly recurring sent');
  assert.ok(body.includes('QureshiFinance Agentic Trading'), 'product name sent');
});

test('checkout route without a key records a founding signup and charges nothing', async () => {
  const db = freshDb();
  const app = fakeApp();
  const out = sub.mountSubscription({
    app, db, requireAuth: requireAuthStub,
    getStripeSecretKey: () => null,
    fetchImpl: async () => { throw new Error('Stripe must not be called in founding mode'); },
  });
  for (const r of ['GET /api/subscription/status', 'POST /api/subscription/dismiss',
    'POST /api/subscription/checkout', 'GET /api/subscription/checkout/success',
    'GET /api/subscription/checkout/cancel']) {
    assert.ok(out.routes.includes(r), `mountSubscription exposes ${r}`);
  }
  const res = fakeRes();
  await app.handlers.get('POST /api/subscription/checkout')({ session: { userId: 7 } }, res);
  assert.equal(res.body.mode, 'founding');
  assert.equal(res.body.founding, true);
  assert.equal(res.body.confirmation,
    "You're on the founding list — billing opens the moment payments go live");
  const row = sub.getSubscriptionRow(db, 7);
  assert.equal(row.status, 'founding');
  assert.equal(Number(row.founding), 1);
});

test('checkout route with a stubbed key returns the Stripe Checkout URL', async () => {
  const db = freshDb();
  const app = fakeApp();
  sub.mountSubscription({
    app, db, requireAuth: requireAuthStub,
    getStripeSecretKey: () => 'sk_test_stubbed',
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ id: 'cs_test_9', url: 'https://checkout.stripe.com/c/cs_test_9' }),
    }),
  });
  const res = fakeRes();
  await app.handlers.get('POST /api/subscription/checkout')(
    { session: { userId: 7 }, protocol: 'https', get: () => 'example.test' }, res);
  assert.equal(res.body.mode, 'stripe');
  assert.equal(res.body.url, 'https://checkout.stripe.com/c/cs_test_9');
  assert.equal(sub.getSubscriptionRow(db, 7).status, 'none', 'not subscribed before payment');
  assert.equal(sub.getSubscriptionRow(db, 7).stripe_checkout_session_id, 'cs_test_9');
});

test('success-return marking: only a verified paid session for THIS user subscribes the account', async () => {
  const db = freshDb();
  const paidFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      id: 'cs_test_1', status: 'complete', payment_status: 'paid',
      client_reference_id: '7', customer: 'cus_1', subscription: 'sub_1',
    }),
  });
  const ok = await sub.verifyAndMarkSubscribed({
    db, secretKey: 'sk_test_stubbed', fetchImpl: paidFetch, sessionId: 'cs_test_1', userId: 7,
  });
  assert.equal(ok.ok, true);
  const row = sub.getSubscriptionRow(db, 7);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.founding), 1, 'founding price lock kept');
  assert.equal(row.stripe_subscription_id, 'sub_1');
  assert.ok(row.subscribed_at);

  const db2 = freshDb();
  const unpaid = await sub.verifyAndMarkSubscribed({
    db: db2, secretKey: 'sk_test_stubbed',
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ id: 'cs_x', status: 'open', payment_status: 'unpaid', client_reference_id: '7' }),
    }),
    sessionId: 'cs_x', userId: 7,
  });
  assert.equal(unpaid.ok, false);
  assert.equal(sub.getSubscriptionRow(db2, 7), null, 'unpaid session leaves the account unchanged');

  const db3 = freshDb();
  const wrongUser = await sub.verifyAndMarkSubscribed({
    db: db3, secretKey: 'sk_test_stubbed',
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ id: 'cs_y', status: 'complete', payment_status: 'paid', client_reference_id: '99' }),
    }),
    sessionId: 'cs_y', userId: 7,
  });
  assert.equal(wrongUser.ok, false);
  assert.equal(sub.getSubscriptionRow(db3, 7), null, 'another user\'s session changes nothing');
});

test('index.html carries the popup markup, ONE $49.99 plan, entry points, bumped assets', () => {
  assert.ok(html.includes('Unlock Agentic Trading'), 'headline present');
  assert.ok(html.includes('id="subscriptionOverlay"'), 'popup overlay present');
  assert.ok(html.includes('id="subscriptionCta"'), 'CTA present');
  assert.ok(html.includes('Unlock Now'), 'CTA label present');
  assert.ok(html.includes('Maybe later'), 'dismiss control present');
  assert.ok(html.includes('$49.99'), 'flat price shown');
  assert.ok(html.includes('Early signup reward — locked while you stay subscribed'), 'early-signup lock copy present');
  assert.ok(html.includes('id="subscriptionNavBtn"'), 'nav entry point present');
  assert.ok(html.includes('id="subscriptionBannerBtn"'), 'dashboard entry point present');
  assert.ok(html.includes('id="subscriptionKiaanBtn"'), 'Kiaan page entry point present');
  assert.ok(html.includes('/js/subscription.js?v=20261017b'), 'subscription.js tag bumped');
  assert.ok(html.includes('/public/css/subscription.css?v=20261017a'), 'subscription.css tag bumped');
  assert.ok(html.includes('/js/app.js?v=20261017a'), 'app.js tag bumped for the login hook');
  assert.ok(!/paypal/i.test(html), 'no PayPal in this build (phase 2)');
});

test('client + server wiring: popup after login, per-account dismiss, env-only Stripe key', () => {
  assert.ok(appJs.includes('window.subscriptionPopup?.onAuthenticated(user)'), 'showApp triggers the popup flow');
  assert.ok(subJs.includes('/api/subscription/status'), 'client reads server popup state');
  assert.ok(subJs.includes('/api/subscription/dismiss'), 'client posts dismissal to the server');
  assert.ok(subJs.includes('/api/subscription/checkout'), 'client starts checkout on the server');
  assert.ok(subJs.includes('Agentic Trading: Active') || subJs.includes('state.entryLabel'), 'entry label comes from server state');
  assert.ok(server.includes("require('./lib/subscription')"), 'server requires the subscription module');
  assert.ok(server.includes('mountSubscription({'), 'server mounts subscription routes');
  assert.ok(server.includes('process.env.STRIPE_SECRET_KEY'), 'Stripe key read from the app environment only');
  assert.ok(!/sk_(live|test)_/.test(server), 'no Stripe key material in server source');
  assert.ok(!subJs.includes('api/paypal') && !subJs.includes('paypal.com'), 'no PayPal integration in the client (phase 2)');
});
