'use strict';

// Stripe webhook (Johnny 2026-10-18): Stripe's server-to-server word
// activates subscribers even when the payer's browser never completes
// the success redirect, and frees accounts when Stripe cancels them or
// a renewal charge fails. Signature verification is hand-rolled
// (HMAC-SHA256 over `${t}.${rawBody}`), event handling is idempotent,
// exempt accounts are ignored, and the endpoint fails closed until
// STRIPE_WEBHOOK_SECRET is set. No real Stripe secret is used here —
// signatures are computed in-test with a fake secret.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const sub = require('../lib/subscription');
const hook = require('../lib/stripe-webhook');
const read = p => readFileSync(require.resolve(p), 'utf8');
const server = read('../server.js');
const hookSrc = read('../lib/stripe-webhook.js');

const SECRET = 'whsec_fake_test_secret';
const EXEMPT_EMAIL = 'exempt-relative@example.com';

function freshDb() {
  delete process.env.SUBSCRIPTION_EXEMPT_EMAILS;
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT)');
  db.prepare('INSERT INTO users(id, email) VALUES (7, ?)').run('regular@example.com');
  db.prepare('INSERT INTO users(id, email) VALUES (8, ?)').run(EXEMPT_EMAIL);
  sub.ensureSubscriptionSchema(db);
  hook.ensureStripeWebhookSchema(db);
  return db;
}

// Sign exactly the way Stripe does — computed here with node:crypto,
// independent of the implementation under test.
function sign(rawBody, secret = SECRET, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

function fakeRes() {
  return {
    body: null, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function deliver(handler, event, { secret = SECRET, header = undefined, raw = undefined } = {}) {
  const rawBody = raw !== undefined ? raw : JSON.stringify(event);
  const res = fakeRes();
  handler({
    headers: { 'stripe-signature': header !== undefined ? header : sign(rawBody, secret) },
    body: Buffer.from(rawBody, 'utf8'),
  }, res);
  return res;
}

function makeHandler(db, secret = SECRET) {
  return hook.createStripeWebhookHandler({ db, getWebhookSecret: () => secret });
}

function paidSessionEvent(overrides = {}) {
  return {
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_live_1',
        mode: 'subscription',
        payment_status: 'paid',
        status: 'complete',
        client_reference_id: '7',
        metadata: { user_id: '7' },
        customer: 'cus_1',
        subscription: 'sub_1',
        ...overrides,
      },
    },
  };
}

function eventRows(db) {
  return db.prepare('SELECT * FROM stripe_webhook_events ORDER BY event_id').all();
}

test('signature verification: valid passes; tampered body, wrong secret, stale timestamp, junk all fail', () => {
  const raw = JSON.stringify({ id: 'evt_x', type: 'ping' });
  assert.equal(hook.verifyStripeSignature(Buffer.from(raw), sign(raw), SECRET), true);
  assert.equal(hook.verifyStripeSignature(Buffer.from(`${raw} `), sign(raw), SECRET), false, 'body altered after signing');
  assert.equal(hook.verifyStripeSignature(Buffer.from(raw), sign(raw, 'whsec_other'), SECRET), false, 'wrong secret');
  const now = Math.floor(Date.now() / 1000);
  assert.equal(hook.verifyStripeSignature(Buffer.from(raw), sign(raw, SECRET, now - 301), SECRET), false, 'timestamp older than 5 minutes');
  assert.equal(hook.verifyStripeSignature(Buffer.from(raw), sign(raw, SECRET, now - 299), SECRET), true, 'inside the tolerance window');
  assert.equal(hook.verifyStripeSignature(Buffer.from(raw), undefined, SECRET), false, 'missing header');
  assert.equal(hook.verifyStripeSignature(Buffer.from(raw), 'garbage', SECRET), false, 'unparseable header');
  assert.equal(hook.verifyStripeSignature(Buffer.from(raw), sign(raw), null), false, 'no secret configured');
  // The module's own header builder agrees with the in-test construction.
  assert.equal(
    hook.computeStripeSignatureHeader(Buffer.from(raw), SECRET, now),
    sign(raw, SECRET, now));
});

test('checkout.session.completed (paid): activates through markSubscribed with the Stripe ids', () => {
  const db = freshDb();
  const handler = makeHandler(db);
  const res = deliver(handler, paidSessionEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
  const row = sub.getSubscriptionRow(db, 7);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.founding), 1, 'founding price lock kept, same as the success-return path');
  assert.equal(row.stripe_customer_id, 'cus_1');
  assert.equal(row.stripe_subscription_id, 'sub_1');
  assert.equal(row.stripe_checkout_session_id, 'cs_live_1');
  assert.ok(row.subscribed_at);
  assert.equal(eventRows(db).length, 1, 'event id recorded for idempotency');
});

test('checkout.session.completed resolves the user from metadata when client_reference_id is absent', () => {
  const db = freshDb();
  const handler = makeHandler(db);
  const evt = paidSessionEvent({ client_reference_id: null });
  const res = deliver(handler, evt);
  assert.equal(res.statusCode, 200);
  assert.equal(sub.getSubscriptionRow(db, 7).status, 'active');
});

test('checkout.session.completed for a TRIALING session (no_payment_required) activates', () => {
  // First trading week free: the completed trial session owes $0, so
  // Stripe reports payment_status 'no_payment_required', not 'paid'.
  // The subscriber must still be activated — the trial IS the access.
  const db = freshDb();
  const handler = makeHandler(db);
  const evt = paidSessionEvent({ payment_status: 'no_payment_required' });
  const res = deliver(handler, evt);
  assert.equal(res.statusCode, 200);
  const row = sub.getSubscriptionRow(db, 7);
  assert.equal(row.status, 'active');
  assert.equal(row.stripe_subscription_id, 'sub_1');
  assert.ok(row.subscribed_at);
});

test('checkout.session.completed for an UNPAID session does not activate', () => {
  const db = freshDb();
  const handler = makeHandler(db);
  const evt = paidSessionEvent({ payment_status: 'unpaid', status: 'open' });
  const res = deliver(handler, evt);
  assert.equal(res.statusCode, 200, 'well-formed signed events are still acked');
  assert.equal(sub.getSubscriptionRow(db, 7), null, 'no subscription row written');
});

test('invalid signature: 400 and nothing changes — no row, no event record', () => {
  const db = freshDb();
  const handler = makeHandler(db);
  const res = deliver(handler, paidSessionEvent(), { secret: 'whsec_wrong' });
  assert.equal(res.statusCode, 400);
  assert.equal(sub.getSubscriptionRow(db, 7), null);
  assert.equal(eventRows(db).length, 0);
});

test('missing signature header: 400 and nothing changes', () => {
  const db = freshDb();
  const handler = makeHandler(db);
  const res = deliver(handler, paidSessionEvent(), { header: '' });
  assert.equal(res.statusCode, 400);
  assert.equal(sub.getSubscriptionRow(db, 7), null);
});

test('secret unset: endpoint fails closed (400) even for a well-formed signed delivery', () => {
  const db = freshDb();
  const handler = hook.createStripeWebhookHandler({ db, getWebhookSecret: () => null });
  const res = deliver(handler, paidSessionEvent());
  assert.equal(res.statusCode, 400);
  assert.equal(sub.getSubscriptionRow(db, 7), null);
  assert.equal(eventRows(db).length, 0);
});

test('duplicate delivery: acked 200, written once — subscribed_at does not move', () => {
  const db = freshDb();
  const handler = makeHandler(db);
  const evt = paidSessionEvent();
  const first = deliver(handler, evt);
  assert.equal(first.statusCode, 200);
  const rowAfterFirst = sub.getSubscriptionRow(db, 7);
  const second = deliver(handler, evt);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  const rowAfterSecond = sub.getSubscriptionRow(db, 7);
  assert.equal(rowAfterSecond.subscribed_at, rowAfterFirst.subscribed_at, 'no second write');
  assert.equal(eventRows(db).length, 1, 'one event record');
});

test('customer.subscription.deleted: frees the account through the admin upsert layer', () => {
  const db = freshDb();
  sub.markSubscribed(db, 7, { customerId: 'cus_1', subscriptionId: 'sub_1', sessionId: 'cs_live_1' });
  const handler = makeHandler(db);
  const res = deliver(handler, {
    id: 'evt_deleted_1',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', customer: 'cus_1', metadata: {} } },
  });
  assert.equal(res.statusCode, 200);
  const row = sub.getSubscriptionRow(db, 7);
  assert.equal(row.status, 'none');
  assert.equal(Number(row.founding), 0);
  assert.equal(sub.getPopupState(db, 7, {}).subscribed, false);
});

test('invoice.payment_failed on a subscription invoice: frees the account', () => {
  const db = freshDb();
  sub.markSubscribed(db, 7, { customerId: 'cus_1', subscriptionId: 'sub_1', sessionId: 'cs_live_1' });
  const handler = makeHandler(db);
  const res = deliver(handler, {
    id: 'evt_invoice_fail_1',
    type: 'invoice.payment_failed',
    data: { object: { id: 'in_1', subscription: 'sub_1', customer: 'cus_1', billing_reason: 'subscription_cycle' } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(sub.getSubscriptionRow(db, 7).status, 'none');
});

test('unknown customer: deleted event for ids nobody owns is acked 200, no crash, no change', () => {
  const db = freshDb();
  const handler = makeHandler(db);
  const res = deliver(handler, {
    id: 'evt_deleted_unknown',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_stranger', customer: 'cus_stranger', metadata: {} } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
  assert.equal(sub.getSubscriptionRow(db, 7), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agentic_subscriptions').get().n, 0);
});

test('exempt account: Stripe events are ignored — no activation write, no freeing', () => {
  process.env.SUBSCRIPTION_EXEMPT_EMAILS = EXEMPT_EMAIL;
  try {
    const db = freshDb();
    process.env.SUBSCRIPTION_EXEMPT_EMAILS = EXEMPT_EMAIL;
    const handler = makeHandler(db);
    // A paid checkout completing for the exempt account writes nothing:
    // the exemption (email-keyed) is the whole story for that account.
    const checkoutEvt = paidSessionEvent({ client_reference_id: '8', metadata: { user_id: '8' } });
    checkoutEvt.id = 'evt_exempt_checkout';
    const res1 = deliver(handler, checkoutEvt);
    assert.equal(res1.statusCode, 200);
    assert.equal(sub.getSubscriptionRow(db, 8), null, 'no subscription row for the exempt account');
    // And a deletion event cannot free an exempt account either.
    sub.markSubscribed(db, 8, { customerId: 'cus_8', subscriptionId: 'sub_8', sessionId: 'cs_8' });
    const delEvt = {
      id: 'evt_exempt_deleted',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_8', customer: 'cus_8', metadata: { user_id: '8' } } },
    };
    const res2 = deliver(handler, delEvt);
    assert.equal(res2.statusCode, 200);
    assert.equal(sub.getSubscriptionRow(db, 8).status, 'active', 'exempt state untouched by Stripe events');
  } finally {
    delete process.env.SUBSCRIPTION_EXEMPT_EMAILS;
  }
});

test('unrelated event types are acked 200 and ignored', () => {
  const db = freshDb();
  const handler = makeHandler(db);
  const res = deliver(handler, {
    id: 'evt_other', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agentic_subscriptions').get().n, 0);
});

test('mount: route registered with a raw-body parser ahead of the handler', () => {
  const db = freshDb();
  const calls = [];
  const app = { post: (...args) => calls.push(args) };
  const out = hook.mountStripeWebhook({ app, db, getWebhookSecret: () => SECRET });
  assert.deepEqual(out.routes, ['POST /api/stripe/webhook']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/stripe/webhook');
  assert.equal(calls[0].length, 3, 'path + raw parser + handler');
  assert.equal(typeof calls[0][2], 'function');
});

test('wiring: server mounts the webhook BEFORE the JSON parser; secret is env-only; no SDK', () => {
  assert.ok(server.includes("require('./lib/stripe-webhook')"), 'server requires the webhook module');
  assert.ok(server.includes('mountStripeWebhook({'), 'server mounts the webhook');
  assert.ok(server.includes('process.env.STRIPE_WEBHOOK_SECRET'), 'webhook secret read from the app environment only');
  const mountAt = server.indexOf('mountStripeWebhook({');
  const jsonAt = server.indexOf('app.use(express.json(');
  assert.ok(mountAt !== -1 && jsonAt !== -1 && mountAt < jsonAt,
    'webhook mount precedes the JSON body parser so the raw body survives');
  assert.ok(!/whsec_/.test(server), 'no webhook secret material in server source');
  assert.ok(!hookSrc.includes("require('stripe')") && !hookSrc.includes('require("stripe")'),
    'no Stripe SDK — verification is hand-rolled');
});
