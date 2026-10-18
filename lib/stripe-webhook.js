'use strict';

// Stripe webhook receiver (Johnny 2026-10-18): closes the activation
// gap in the subscription flow. Until now an account was marked
// subscribed ONLY when the payer's browser completed the success
// redirect (GET /api/subscription/checkout/success); a payer who paid
// and closed the tab stayed Free, and Stripe-side cancellations or
// failed renewals never reached the app. This endpoint is Stripe's
// server-to-server word instead:
//
//   checkout.session.completed  → mark the account subscribed through
//                                 the SAME markSubscribed() the success
//                                 return uses.
//   customer.subscription.deleted → free the account through the SAME
//                                 admin upsert layer (setSubscriptionStateAdmin).
//   invoice.payment_failed (subscription invoice) → same freeing: when
//                                 payment stops, access stops.
//
// Security: every delivery is signature-verified by hand (no Stripe
// SDK in this codebase) — HMAC-SHA256 over `${t}.${rawBody}` against
// the STRIPE_WEBHOOK_SECRET app env var, constant-time compare,
// timestamps older than 5 minutes rejected. That is why the route is
// mounted with the RAW body BEFORE the JSON parser in server.js.
// When the secret is not set the endpoint fails closed (400, no state
// change) and the rest of the site behaves exactly as before.
//
// Idempotency: processed event ids are persisted in
// stripe_webhook_events; a redelivery is acked 200 without
// re-processing (Stripe retries on any non-200, so a well-formed,
// validly-signed event NEVER gets a 500 — unresolvable users are
// logged and acked).
//
// Fee-exempt accounts (lib/subscription-exemptions.js, email-keyed)
// outrank Stripe state entirely: their events are ignored and the
// exemption store is never touched here.

const crypto = require('node:crypto');
const express = require('express');
const sub = require('./subscription');
const exemptions = require('./subscription-exemptions');

const SIGNATURE_TOLERANCE_SECONDS = 300; // Stripe's own default window

function ensureStripeWebhookSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// Parse a Stripe-Signature header ("t=...,v1=...,v1=...") — multiple
// v1 values occur during signing-secret rotation; any match verifies.
function parseSignatureHeader(header) {
  if (typeof header !== 'string' || !header) return null;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && timestamp === null) timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || !signatures.length) return null;
  return { timestamp, signatures };
}

function verifyStripeSignature(rawBody, signatureHeader, secret, {
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
  nowSeconds = null,
} = {}) {
  if (!secret || typeof secret !== 'string') return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const timestampSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const now = nowSeconds === null ? Math.floor(Date.now() / 1000) : Number(nowSeconds);
  if (Math.abs(now - timestampSeconds) > toleranceSeconds) return false;
  const signedPayload = Buffer.concat([Buffer.from(`${parsed.timestamp}.`, 'utf8'), body]);
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return parsed.signatures.some(candidate => {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    return candidateBuf.length === expectedBuf.length
      && crypto.timingSafeEqual(candidateBuf, expectedBuf);
  });
}

// Build a Stripe-Signature header for a payload — the mirror of
// verifyStripeSignature (used by tests; Stripe builds its own live).
function computeStripeSignatureHeader(rawBody, secret, timestampSeconds) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const t = String(Math.floor(Number(timestampSeconds)));
  const signedPayload = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body]);
  const v1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${t},v1=${v1}`;
}

// Claim an event id for processing. Returns true exactly once per id;
// redeliveries return false and must be acked without re-processing.
function claimStripeEvent(db, eventId, eventType) {
  ensureStripeWebhookSchema(db);
  const result = db.prepare(
    'INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type) VALUES (?, ?)')
    .run(String(eventId), String(eventType || ''));
  return result.changes === 1;
}

function positiveUserId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The user a checkout session belongs to: our session creation sets
// client_reference_id AND metadata.user_id to the account id.
function userIdFromSession(session) {
  if (!session) return null;
  return positiveUserId(session.client_reference_id)
    || positiveUserId(session.metadata && session.metadata.user_id);
}

function userIdFromMetadata(obj) {
  return obj ? positiveUserId(obj.metadata && obj.metadata.user_id) : null;
}

function findUserIdByStripeIds(db, { subscriptionId = null, customerId = null } = {}) {
  sub.ensureSubscriptionSchema(db);
  if (subscriptionId) {
    const row = db.prepare('SELECT user_id FROM agentic_subscriptions WHERE stripe_subscription_id=?')
      .get(String(subscriptionId));
    if (row) return Number(row.user_id);
  }
  if (customerId) {
    const row = db.prepare('SELECT user_id FROM agentic_subscriptions WHERE stripe_customer_id=?')
      .get(String(customerId));
    if (row) return Number(row.user_id);
  }
  return null;
}

// Resolve the account an event object belongs to: explicit metadata
// first (set at checkout), then the Stripe ids stored on the row.
function resolveEventUserId(db, obj, { subscriptionId = null } = {}) {
  const fromMetadata = userIdFromMetadata(obj);
  if (fromMetadata) return fromMetadata;
  return findUserIdByStripeIds(db, {
    subscriptionId: subscriptionId || (obj && typeof obj.id === 'string' ? obj.id : null),
    customerId: obj && typeof obj.customer === 'string' ? obj.customer : null,
  });
}

// Dispatch one verified event. Pure state transitions — signature and
// idempotency live in the handler. Returns an action descriptor; an
// 'unresolved' action is logged by the handler and still acked 200.
function handleStripeWebhookEvent(db, event) {
  const obj = (event && event.data && event.data.object) || {};
  if (!event || typeof event.type !== 'string') return { action: 'ignored-malformed' };

  if (event.type === 'checkout.session.completed') {
    if (obj.mode && obj.mode !== 'subscription') return { action: 'ignored-mode' };
    // A trialing subscription (first trading week free, Johnny
    // 2026-10-18) owes $0 at checkout, so Stripe reports the completed
    // session as payment_status 'no_payment_required', not 'paid'.
    // Both mean checkout finished and the subscription exists — the
    // user gets access for the trial, which is the point. A genuinely
    // 'unpaid' session still does not activate.
    if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
      return { action: 'ignored-unpaid' };
    }
    const userId = userIdFromSession(obj);
    if (!userId) return { action: 'unresolved' };
    if (exemptions.isExemptUser(db, userId)) return { action: 'ignored-exempt', userId };
    sub.markSubscribed(db, userId, {
      customerId: typeof obj.customer === 'string' ? obj.customer : null,
      subscriptionId: typeof obj.subscription === 'string' ? obj.subscription : null,
      sessionId: typeof obj.id === 'string' ? obj.id : null,
    });
    return { action: 'subscribed', userId };
  }

  if (event.type === 'customer.subscription.deleted') {
    const userId = resolveEventUserId(db, obj);
    if (!userId) return { action: 'unresolved' };
    if (exemptions.isExemptUser(db, userId)) return { action: 'ignored-exempt', userId };
    sub.setSubscriptionStateAdmin(db, userId, 'free');
    return { action: 'freed', userId };
  }

  if (event.type === 'invoice.payment_failed') {
    const subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : null;
    const billingReason = typeof obj.billing_reason === 'string' ? obj.billing_reason : '';
    if (!subscriptionId && !billingReason.startsWith('subscription')) {
      return { action: 'ignored-non-subscription' };
    }
    const userId = resolveEventUserId(db, obj, { subscriptionId });
    if (!userId) return { action: 'unresolved' };
    if (exemptions.isExemptUser(db, userId)) return { action: 'ignored-exempt', userId };
    sub.setSubscriptionStateAdmin(db, userId, 'free');
    return { action: 'freed', userId };
  }

  return { action: 'ignored-type' };
}

function createStripeWebhookHandler({ db, getWebhookSecret }) {
  ensureStripeWebhookSchema(db);
  return (req, res) => {
    const reject = message => res.status(400).json({ error: message });
    const secret = typeof getWebhookSecret === 'function' ? getWebhookSecret() : null;
    // Fail closed until Johnny sets STRIPE_WEBHOOK_SECRET: nothing is
    // processed and no state can change through this route.
    if (!secret) return reject('Stripe webhook is not configured.');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    if (!rawBody) return reject('Missing request body.');
    const signature = req.headers && req.headers['stripe-signature'];
    if (!verifyStripeSignature(rawBody, signature, secret)) {
      return reject('Signature verification failed.');
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (_) {
      return reject('Invalid payload.');
    }
    if (!event || typeof event.id !== 'string' || !event.id
      || typeof event.type !== 'string' || !event.type) {
      return reject('Invalid event.');
    }
    if (!claimStripeEvent(db, event.id, event.type)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    try {
      const result = handleStripeWebhookEvent(db, event);
      if (result.action === 'unresolved') {
        console.warn(`[StripeWebhook] ${event.type} ${event.id}: no account resolved; acked without changes.`);
      }
    } catch (error) {
      // Never 500 a validly-signed delivery — Stripe would retry for
      // days. The event id stays claimed; the state layer's upserts
      // are idempotent, and the USERS page can repair any single case.
      console.error(`[StripeWebhook] handling ${event.type} ${event.id} failed:`, error.message);
    }
    return res.status(200).json({ received: true });
  };
}

// Mount BEFORE the JSON body parser (server.js): the raw bytes are
// the signed payload, so express.raw must see the request first.
function mountStripeWebhook({ app, db, getWebhookSecret }) {
  const handler = createStripeWebhookHandler({ db, getWebhookSecret });
  app.post('/api/stripe/webhook',
    express.raw({ type: '*/*', limit: '256kb' }),
    handler);
  return { routes: ['POST /api/stripe/webhook'], handler };
}

module.exports = {
  SIGNATURE_TOLERANCE_SECONDS,
  ensureStripeWebhookSchema,
  parseSignatureHeader,
  verifyStripeSignature,
  computeStripeSignatureHeader,
  claimStripeEvent,
  userIdFromSession,
  findUserIdByStripeIds,
  handleStripeWebhookEvent,
  createStripeWebhookHandler,
  mountStripeWebhook,
};
