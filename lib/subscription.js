'use strict';

// Agentic Trading subscription (Johnny 2026-10-16): ONE flat plan —
// $49.99/mo, everything included, priced as the early-signup reward and
// locked while the subscriber stays subscribed. No tiers.
//
// Payments run through Stripe Checkout in subscription mode with inline
// price_data, so no pre-created Stripe Price is required. The server reads
// STRIPE_SECRET_KEY from the app environment at runtime; this module never
// stores, logs, or returns the key. When the key is ABSENT the checkout
// endpoint records a founding signup instead (founding-list mode, the
// by-design state until Johnny's LLC + Stripe account are ready): the
// account is flagged founding in the DB and billing opens the moment
// payments go live. Apple Pay / Google Pay ride along with Stripe
// Checkout automatically (Apple Pay additionally needs the domain
// verified in the Stripe dashboard).
//
// State lives in the main user database (jqf.db, volume-backed), one row
// per account: popup dismissal, founding signup, and active subscription
// are all server-side and survive devices/deploys. Nothing here gates the
// owner's own bot access, and nothing here touches any bot strategy.

const referrals = require('./referrals');
const exemptions = require('./subscription-exemptions');

const PRICE_CENTS = 4999;
const PRICE_DISPLAY = '$49.99';
const CURRENCY = 'usd';
const PRODUCT_NAME = 'QureshiFinance Agentic Trading';
const FOUNDING_CONFIRMATION =
  "You're on the founding list — billing opens the moment payments go live";
const EXEMPT_CONFIRMATION =
  'Agentic Trading is active on your account — subscription fees are waived for this account.';
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function ensureSubscriptionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agentic_subscriptions (
      user_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'none',
      founding INTEGER NOT NULL DEFAULT 0,
      popup_dismissed_at TEXT,
      founding_at TEXT,
      subscribed_at TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_checkout_session_id TEXT,
      plan_amount_cents INTEGER NOT NULL DEFAULT 4999,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function getSubscriptionRow(db, userId) {
  ensureSubscriptionSchema(db);
  return db.prepare('SELECT * FROM agentic_subscriptions WHERE user_id=?')
    .get(Number(userId)) || null;
}

// Pure popup/entry-point state logic (unit-tested without a DB).
// shouldShowPopup is true only for an account that has neither subscribed
// nor joined the founding list and has not dismissed the popup. The owner
// is treated like everyone else for DISPLAY (Johnny wants to see the
// design); the owner's bot access never depends on this state.
//
// Fee-exempt accounts (lib/subscription-exemptions.js — keyed on the
// registered email) compute as subscribed/active here: no popup, the
// Active entry label, and checkout never engages for them.
function computePopupState(row, { hasStripeKey = false, exempt = false } = {}) {
  const status = row && row.status ? String(row.status) : 'none';
  const subscribed = status === 'active' || !!exempt;
  const founding = !!row && (Number(row.founding) === 1 || status === 'founding');
  const dismissed = !!row && !!row.popup_dismissed_at;
  const shouldShowPopup = !subscribed && !founding && !dismissed;
  return {
    status: subscribed ? 'active' : founding ? 'founding' : 'none',
    subscribed,
    exempt: !!exempt,
    founding,
    dismissed,
    shouldShowPopup,
    checkoutMode: hasStripeKey ? 'stripe' : 'founding',
    priceCents: PRICE_CENTS,
    priceDisplay: PRICE_DISPLAY,
    entryLabel: subscribed
      ? 'Agentic Trading: Active'
      : founding
        ? 'Agentic Trading: Founding list'
        : 'Unlock Agentic Trading',
  };
}

// The subscription-state layer: every surface (status endpoint, popup,
// checkout, dismiss echo) reads state through here, so the email-keyed
// exemption is resolved here once — it applies to existing accounts and
// to accounts that register with an exempt email later alike.
function getPopupState(db, userId, opts = {}) {
  const exempt = opts.exempt !== undefined
    ? !!opts.exempt
    : exemptions.isExemptUser(db, userId);
  return computePopupState(getSubscriptionRow(db, userId), { ...opts, exempt });
}

function upsert(db, userId, fields) {
  ensureSubscriptionSchema(db);
  const uid = Number(userId);
  db.prepare(`
    INSERT INTO agentic_subscriptions (user_id) VALUES (?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(uid);
  const sets = Object.keys(fields).map(k => `${k}=?`).join(', ');
  db.prepare(`UPDATE agentic_subscriptions
    SET ${sets}, updated_at=datetime('now') WHERE user_id=?`)
    .run(...Object.values(fields), uid);
  return getSubscriptionRow(db, uid);
}

function recordPopupDismissal(db, userId) {
  return upsert(db, userId, { popup_dismissed_at: new Date().toISOString() });
}

// Founding-list mode: the CTA records the signup (user id + timestamp +
// founding flag) instead of charging. Idempotent — re-clicking keeps the
// original founding timestamp.
function recordFoundingSignup(db, userId) {
  const existing = getSubscriptionRow(db, userId);
  if (existing && existing.status === 'active') return existing;
  if (existing && Number(existing.founding) === 1 && existing.founding_at) return existing;
  return upsert(db, userId, {
    status: 'founding',
    founding: 1,
    founding_at: new Date().toISOString(),
    plan_amount_cents: PRICE_CENTS,
  });
}

// Mark an account subscribed after a VERIFIED Stripe success return.
// Founding stays set: the $49.99 early-signup price is locked.
function markSubscribed(db, userId, { customerId = null, subscriptionId = null, sessionId = null } = {}) {
  const existing = getSubscriptionRow(db, userId);
  return upsert(db, userId, {
    status: 'active',
    founding: 1,
    founding_at: existing && existing.founding_at ? existing.founding_at : new Date().toISOString(),
    subscribed_at: new Date().toISOString(),
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    stripe_checkout_session_id: sessionId,
    plan_amount_cents: PRICE_CENTS,
  });
}

// Referral billing hook (Johnny 2026-10-17): the discount tiers are
// deterministic, so each maps to one durable Stripe coupon id. The
// coupon carries the tier current at checkout; the entitlement itself
// is recomputed live in lib/referrals.js and governs the displayed
// price and any future checkout.
const REFERRAL_COUPON_PCTS = [20, 40, 60];
function referralCouponId(pct) {
  return `qf-referral-${Number(pct)}`;
}

function buildCheckoutSessionParams({ successUrl, cancelUrl, userId, customerEmail = null, discountPct = 0 }) {
  const params = {
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(userId),
    metadata: { user_id: String(userId), plan: 'agentic-trading-founding' },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY,
        unit_amount: PRICE_CENTS,
        recurring: { interval: 'month' },
        product_data: { name: PRODUCT_NAME },
      },
    }],
    subscription_data: { metadata: { user_id: String(userId) } },
  };
  if (customerEmail) params.customer_email = customerEmail;
  if (REFERRAL_COUPON_PCTS.includes(Number(discountPct))) {
    params.discounts = [{ coupon: referralCouponId(discountPct) }];
  }
  return params;
}

// Ensure the deterministic referral coupon exists in Stripe before a
// checkout references it: read it, and create it on a miss. Any other
// Stripe failure aborts checkout loudly (the route answers "not
// charged, nothing changed") rather than silently billing full price.
async function ensureReferralCoupon({ secretKey, fetchImpl, discountPct }) {
  const pct = Number(discountPct);
  if (!REFERRAL_COUPON_PCTS.includes(pct)) return null;
  const id = referralCouponId(pct);
  try {
    const existing = await stripeRequest({
      secretKey, fetchImpl, method: 'GET', path: `/coupons/${encodeURIComponent(id)}`,
    });
    if (existing && existing.id) return existing;
  } catch (_) { /* missing — create it below */ }
  return stripeRequest({
    secretKey, fetchImpl, method: 'POST', path: '/coupons',
    params: {
      id, percent_off: pct, duration: 'forever',
      name: `Refer & Save — ${pct}% off while referrals stay subscribed`,
    },
  });
}

// Stripe's API is form-encoded with bracketed nested keys.
function encodeStripeForm(value, prefix, out) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => encodeStripeForm(item, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      encodeStripeForm(v, prefix ? `${prefix}[${k}]` : k, out);
    }
  } else if (value !== undefined && value !== null) {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

async function stripeRequest({ secretKey, fetchImpl, method, path, params }) {
  const options = {
    method,
    headers: { Authorization: `Bearer ${secretKey}` },
  };
  if (params) {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = encodeStripeForm(params, '', []).join('&');
  }
  const response = await fetchImpl(`${STRIPE_API_BASE}${path}`, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message : `Stripe request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function createCheckoutSession({ secretKey, fetchImpl, successUrl, cancelUrl, userId, customerEmail, discountPct = 0 }) {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured.');
  if (REFERRAL_COUPON_PCTS.includes(Number(discountPct))) {
    await ensureReferralCoupon({ secretKey, fetchImpl, discountPct });
  }
  const params = buildCheckoutSessionParams({ successUrl, cancelUrl, userId, customerEmail, discountPct });
  const session = await stripeRequest({
    secretKey, fetchImpl, method: 'POST', path: '/checkout/sessions', params,
  });
  if (!session || !session.id || !session.url) throw new Error('Stripe did not return a checkout session.');
  return session;
}

async function retrieveCheckoutSession({ secretKey, fetchImpl, sessionId }) {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured.');
  return stripeRequest({
    secretKey, fetchImpl, method: 'GET',
    path: `/checkout/sessions/${encodeURIComponent(sessionId)}`,
  });
}

// Success-return verification: trust Stripe, not the redirect. The
// session must belong to this user and actually be paid/complete before
// the account is marked subscribed; anything else leaves it unchanged.
function sessionBelongsToUser(session, userId) {
  if (!session) return false;
  const uid = String(userId);
  return String(session.client_reference_id || '') === uid
    || String(session.metadata && session.metadata.user_id || '') === uid;
}

function sessionIsPaid(session) {
  if (!session) return false;
  return session.payment_status === 'paid' || session.status === 'complete';
}

async function verifyAndMarkSubscribed({ db, secretKey, fetchImpl, sessionId, userId }) {
  const session = await retrieveCheckoutSession({ secretKey, fetchImpl, sessionId });
  if (!sessionBelongsToUser(session, userId)) return { ok: false, reason: 'session-user-mismatch' };
  if (!sessionIsPaid(session)) return { ok: false, reason: 'session-not-paid' };
  const row = markSubscribed(db, userId, {
    customerId: typeof session.customer === 'string' ? session.customer : null,
    subscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
    sessionId: session.id || sessionId,
  });
  return { ok: true, row };
}

function mountSubscription({ app, db, requireAuth, getStripeSecretKey, fetchImpl }) {
  ensureSubscriptionSchema(db);
  const routes = [];
  const get = (p, ...h) => { app.get(p, ...h); routes.push(`GET ${p}`); };
  const post = (p, ...h) => { app.post(p, ...h); routes.push(`POST ${p}`); };

  get('/api/subscription/status', requireAuth, (req, res) => {
    const state = getPopupState(db, req.session.userId, {
      hasStripeKey: !!getStripeSecretKey(),
    });
    res.json({ ok: true, ...state });
  });

  post('/api/subscription/dismiss', requireAuth, (req, res) => {
    recordPopupDismissal(db, req.session.userId);
    res.json({ ok: true, ...getPopupState(db, req.session.userId, { hasStripeKey: !!getStripeSecretKey() }) });
  });

  post('/api/subscription/checkout', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const secretKey = getStripeSecretKey();
    if (exemptions.isExemptUser(db, userId)) {
      // Fee-exempt account (Johnny 2026-10-17): already a full active
      // subscriber. Never record a founding signup, never create a
      // Stripe session, never charge — answer with the active state.
      return res.json({
        ok: true,
        mode: 'exempt',
        confirmation: EXEMPT_CONFIRMATION,
        ...getPopupState(db, userId, { hasStripeKey: !!secretKey }),
      });
    }
    if (!secretKey) {
      // Founding-list mode (expected until the LLC + Stripe account are
      // ready): record the signup, charge nothing.
      recordFoundingSignup(db, userId);
      return res.json({
        ok: true,
        mode: 'founding',
        founding: true,
        confirmation: FOUNDING_CONFIRMATION,
        ...getPopupState(db, userId, { hasStripeKey: false }),
      });
    }
    try {
      const origin = `${req.protocol}://${req.get('host')}`;
      // Refer & Save: apply the account's current referral discount
      // (recomputed live; 0 for most accounts, which adds no calls).
      const discountPct = referrals.getReferralDiscountPct(db, userId, { billingLive: true });
      const session = await createCheckoutSession({
        secretKey,
        fetchImpl,
        userId,
        discountPct,
        successUrl: `${origin}/api/subscription/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/api/subscription/checkout/cancel`,
      });
      upsert(db, userId, { stripe_checkout_session_id: session.id });
      return res.json({ ok: true, mode: 'stripe', url: session.url, sessionId: session.id });
    } catch (error) {
      console.error('[Subscription] Stripe checkout creation failed:', error.message);
      return res.status(422).json({ error: 'Checkout could not be started. Your account was not charged and nothing changed.' });
    }
  });

  get('/api/subscription/checkout/success', requireAuth, async (req, res) => {
    const secretKey = getStripeSecretKey();
    const sessionId = String(req.query.session_id || '');
    if (!secretKey || !sessionId) return res.redirect('/?subscription=unconfirmed');
    try {
      const result = await verifyAndMarkSubscribed({
        db, secretKey, fetchImpl, sessionId, userId: req.session.userId,
      });
      return res.redirect(result.ok ? '/?subscription=active' : '/?subscription=unconfirmed');
    } catch (error) {
      console.error('[Subscription] Stripe success verification failed:', error.message);
      return res.redirect('/?subscription=unconfirmed');
    }
  });

  // Cancel/failure return: the account is left exactly as it was.
  get('/api/subscription/checkout/cancel', (req, res) => {
    res.redirect('/?subscription=cancelled');
  });

  return { routes };
}

module.exports = {
  PRICE_CENTS,
  PRICE_DISPLAY,
  CURRENCY,
  PRODUCT_NAME,
  FOUNDING_CONFIRMATION,
  EXEMPT_CONFIRMATION,
  isExemptUser: exemptions.isExemptUser,
  isExemptEmail: exemptions.isExemptEmail,
  ensureSubscriptionSchema,
  getSubscriptionRow,
  computePopupState,
  getPopupState,
  recordPopupDismissal,
  recordFoundingSignup,
  markSubscribed,
  buildCheckoutSessionParams,
  encodeStripeForm,
  REFERRAL_COUPON_PCTS,
  referralCouponId,
  ensureReferralCoupon,
  createCheckoutSession,
  retrieveCheckoutSession,
  sessionBelongsToUser,
  sessionIsPaid,
  verifyAndMarkSubscribed,
  mountSubscription,
};
