'use strict';

// Agentic Trading subscription (Johnny 2026-10-16): ONE flat plan —
// $49.99/mo, everything included, priced as the early-signup reward and
// locked while the subscriber stays subscribed. No tiers.
//
// Annual option (Johnny 2026-10-20): the same plan billed yearly at
// $539.89/year — exactly 10% off 12 × $49.99 ($599.88). Monthly stays
// the default everywhere; the annual choice lives in the unlock popup
// and flows plan='annual' through checkout. Trial and referral/admin
// percent discounts apply identically to both intervals.
//
// Free trial (Johnny 2026-10-18; extended 2026-10-19): marketed as
// "14 days free" — actually 10 business days, then $49.99/mo. Stripe
// has no business-day trial unit, so checkout passes an explicit
// subscription_data.trial_end timestamp (see computeTrialEndEpoch).
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
const adminControls = require('./admin-controls');

const PRICE_CENTS = 4999;
const PRICE_DISPLAY = '$49.99';
const ANNUAL_PRICE_CENTS = 53989; // 10% off 12 × 4999¢ ($599.88 → $539.89)
const ANNUAL_PRICE_DISPLAY = '$539.89';
const TRIAL_BUSINESS_DAYS = 10;
const TRIAL_TIME_ZONE = 'America/Chicago';
const TRIAL_COPY = 'First 14 days free, then $49.99/mo — or $539.89/year, 10% off';

// Billing plans (Johnny 2026-10-20): 'monthly' is the default and the
// fallback for anything unrecognized — the checkout route is lenient
// with the plan field the same way it is with discount percentages.
const PLANS = {
  monthly: { cents: PRICE_CENTS, interval: 'month', display: PRICE_DISPLAY },
  annual: { cents: ANNUAL_PRICE_CENTS, interval: 'year', display: ANNUAL_PRICE_DISPLAY },
};
function normalizePlan(plan) {
  return plan === 'annual' ? 'annual' : 'monthly';
}
const CURRENCY = 'usd';
const PRODUCT_NAME = 'VixionBot Agentic Trading';
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
      trial_popup_dismissed_at TEXT,
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
  // Trial promo popup dismissal (Johnny 2026-10-18): same per-account
  // server-side flag pattern as popup_dismissed_at, added in place for
  // databases created before the trial popup existed.
  const columns = db.prepare('PRAGMA table_info(agentic_subscriptions)')
    .all().map(c => c.name);
  if (!columns.includes('trial_popup_dismissed_at')) {
    db.exec('ALTER TABLE agentic_subscriptions ADD COLUMN trial_popup_dismissed_at TEXT');
  }
}

// The owner's account is pinned across the build (same pin as
// lib/admin-users.js OWNER_USER_ID): the trial promo never nags the
// owner, and the owner's access never depends on subscription state.
const OWNER_USER_ID = 1000000005;
function isOwnerUser(userId) {
  return Number(userId) === OWNER_USER_ID;
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
function computePopupState(row, { hasStripeKey = false, exempt = false, isOwner = false } = {}) {
  const status = row && row.status ? String(row.status) : 'none';
  const subscribed = status === 'active' || !!exempt;
  const founding = !!row && (Number(row.founding) === 1 || status === 'founding');
  const dismissed = !!row && !!row.popup_dismissed_at;
  const shouldShowPopup = !subscribed && !founding && !dismissed;
  // Trial promo popup audience (Johnny 2026-10-18): exactly the
  // accounts that could still convert — free, not exempt (exempt
  // computes subscribed above), not on the founding list, not the
  // owner — and only until they dismiss it or subscribe (subscribing
  // flips status to active, which removes them from the audience).
  const trialDismissed = !!row && !!row.trial_popup_dismissed_at;
  const showTrialPopup = !subscribed && !founding && !isOwner && !trialDismissed;
  return {
    status: subscribed ? 'active' : founding ? 'founding' : 'none',
    subscribed,
    exempt: !!exempt,
    founding,
    dismissed,
    trialDismissed,
    showTrialPopup,
    shouldShowPopup,
    checkoutMode: hasStripeKey ? 'stripe' : 'founding',
    priceCents: PRICE_CENTS,
    priceDisplay: PRICE_DISPLAY,
    annualPriceCents: ANNUAL_PRICE_CENTS,
    annualPriceDisplay: ANNUAL_PRICE_DISPLAY,
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
  const isOwner = opts.isOwner !== undefined
    ? !!opts.isOwner
    : isOwnerUser(userId);
  return computePopupState(getSubscriptionRow(db, userId), { ...opts, exempt, isOwner });
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

// Trial promo popup dismissal: once recorded, the promo never shows
// for this account again (subscribing also ends it, via the audience
// rule in computePopupState).
function recordTrialPopupDismissal(db, userId) {
  return upsert(db, userId, { trial_popup_dismissed_at: new Date().toISOString() });
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
// Founding stays set: the $49.99 early-signup price is locked. The
// billing interval is recorded through plan_amount_cents (4999 monthly
// vs 53989 annual) — the one place the row distinguishes the two.
function markSubscribed(db, userId, { customerId = null, subscriptionId = null, sessionId = null, plan = 'monthly' } = {}) {
  const existing = getSubscriptionRow(db, userId);
  return upsert(db, userId, {
    status: 'active',
    founding: 1,
    founding_at: existing && existing.founding_at ? existing.founding_at : new Date().toISOString(),
    subscribed_at: new Date().toISOString(),
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    stripe_checkout_session_id: sessionId,
    plan_amount_cents: PLANS[normalizePlan(plan)].cents,
  });
}

// Admin subscription override (Johnny 2026-10-17): the owner sets an
// account's state directly from the USERS page. Writes go through the
// same agentic_subscriptions row every surface reads, so an admin-set
// state is indistinguishable from an earned one downstream (popup,
// checkout, referrals). Stripe identifiers are never touched here.
// 'exempt' is NOT handled here — it lives in the email-keyed exemption
// store (lib/subscription-exemptions.js), the single concept both the
// env configuration and the admin page write to.
function setSubscriptionStateAdmin(db, userId, state) {
  const existing = getSubscriptionRow(db, userId);
  const foundingAt = existing && existing.founding_at
    ? existing.founding_at : new Date().toISOString();
  if (state === 'free') {
    return upsert(db, userId, { status: 'none', founding: 0, founding_at: null });
  }
  if (state === 'founding') {
    return upsert(db, userId, { status: 'founding', founding: 1, founding_at: foundingAt });
  }
  if (state === 'active') {
    return upsert(db, userId, {
      status: 'active', founding: 1, founding_at: foundingAt,
      subscribed_at: new Date().toISOString(),
    });
  }
  throw new RangeError(`Unknown subscription state: ${state}`);
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

// The coupon for ANY effective discount (Johnny 2026-10-17): referral
// tiers keep their original durable ids; any other percentage — an
// admin-set fee discount from the USERS page, which wins whenever it
// beats the referral tier — gets its own deterministic id, so the
// effective discount (max of the two, lib/admin-controls.js) always
// flows through this same coupon path.
function discountCouponId(pct) {
  const p = Number(pct);
  return REFERRAL_COUPON_PCTS.includes(p) ? referralCouponId(p) : `qf-discount-${p}`;
}

function validDiscountPct(pct) {
  const p = Number(pct);
  return Number.isInteger(p) && p >= 1 && p <= 100 ? p : 0;
}

// ── Free-trial end computation (Johnny 2026-10-18; 10 business days
// since 2026-10-19, marketed as "14 days") ────────────────────────────
// The trial is 10 BUSINESS days — two trading weeks. Counted from
// TODAY in America/Chicago: today counts as day 1 when today is a
// business day (Mon–Fri); the trial ends at 23:59:59 CT on the 10th
// business day. Mon signup → ends Fri of the following week 23:59:59
// CT; Fri signup → ends the Thu two weeks out; Sat/Sun signup → the
// ten days are the next two Mon–Fri weeks, ends the second Fri.
// US market holidays are ignored by design — weekdays only.

// The calendar date (year/month/day) that `date` falls on in the trial
// time zone, via Intl so DST transitions are handled by the platform.
function trialZonedDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TRIAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = t => Number(parts.find(p => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function isBusinessDate(year, month, day) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow >= 1 && dow <= 5; // Mon–Fri
}

// Convert a wall-clock time in the trial time zone to a UTC epoch
// (seconds) by Intl round-trip: format the current guess in the zone,
// compare against the target wall time, correct, repeat until stable.
// This yields the correct offset FOR THE TARGET DATE (CDT vs CST)
// without hardcoding any offset.
function trialZonedEpochSeconds({ year, month, day, hour, minute, second }) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TRIAL_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  let utcMs = target;
  for (let i = 0; i < 4; i++) {
    const parts = fmt.formatToParts(new Date(utcMs));
    const get = t => Number(parts.find(p => p.type === t).value);
    const rendered = Date.UTC(
      get('year'), get('month') - 1, get('day'),
      get('hour') % 24, get('minute'), get('second'));
    const diff = target - rendered;
    if (diff === 0) break;
    utcMs += diff;
  }
  return Math.floor(utcMs / 1000);
}

// Unix timestamp (seconds) for subscription_data.trial_end: 23:59:59
// America/Chicago on the 10th business day counting from today.
function computeTrialEndEpoch(now = new Date()) {
  let { year, month, day } = trialZonedDateParts(now);
  let counted = 0;
  let end = null;
  // Terminates within 14 iterations: 10 business days span at most
  // two calendar weeks.
  for (let i = 0; i < 21 && !end; i++) {
    if (isBusinessDate(year, month, day)) {
      counted += 1;
      if (counted === TRIAL_BUSINESS_DAYS) end = { year, month, day };
    }
    if (!end) {
      const next = new Date(Date.UTC(year, month - 1, day) + 86400000);
      year = next.getUTCFullYear();
      month = next.getUTCMonth() + 1;
      day = next.getUTCDate();
    }
  }
  const epoch = trialZonedEpochSeconds({ ...end, hour: 23, minute: 59, second: 59 });
  // Safety: Stripe rejects a trial_end that is not in the future. The
  // counting rule always lands ≥11 days out, but never hand Stripe a
  // past timestamp if the clock is pathological.
  const nowEpoch = Math.floor(now.getTime() / 1000);
  return epoch > nowEpoch ? epoch : nowEpoch + 86400;
}

function buildCheckoutSessionParams({ successUrl, cancelUrl, userId, customerEmail = null, discountPct = 0, plan = 'monthly', now = new Date() }) {
  const planKey = normalizePlan(plan);
  const planDef = PLANS[planKey];
  const params = {
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(userId),
    metadata: { user_id: String(userId), plan: 'agentic-trading-founding', billing_plan: planKey },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY,
        unit_amount: planDef.cents,
        recurring: { interval: planDef.interval },
        product_data: { name: PRODUCT_NAME },
      },
    }],
    // First 14 days free: explicit trial_end (10 business days,
    // computed above) — Stripe bills the first amount only after it.
    // Card collection stays Stripe's default for trialing
    // subscriptions (collected upfront at checkout).
    subscription_data: {
      trial_end: computeTrialEndEpoch(now),
      metadata: { user_id: String(userId), billing_plan: planKey },
    },
  };
  if (customerEmail) params.customer_email = customerEmail;
  const pct = validDiscountPct(discountPct);
  if (pct) {
    params.discounts = [{ coupon: discountCouponId(pct) }];
  }
  return params;
}

// Ensure a deterministic discount coupon exists in Stripe before a
// checkout references it: read it, and create it on a miss. Any other
// Stripe failure aborts checkout loudly (the route answers "not
// charged, nothing changed") rather than silently billing full price.
async function ensureCouponById({ secretKey, fetchImpl, id, pct, name }) {
  try {
    const existing = await stripeRequest({
      secretKey, fetchImpl, method: 'GET', path: `/coupons/${encodeURIComponent(id)}`,
    });
    if (existing && existing.id) return existing;
  } catch (_) { /* missing — create it below */ }
  return stripeRequest({
    secretKey, fetchImpl, method: 'POST', path: '/coupons',
    params: { id, percent_off: pct, duration: 'forever', name },
  });
}

async function ensureReferralCoupon({ secretKey, fetchImpl, discountPct }) {
  const pct = Number(discountPct);
  if (!REFERRAL_COUPON_PCTS.includes(pct)) return null;
  return ensureCouponById({
    secretKey, fetchImpl, id: referralCouponId(pct), pct,
    name: `Refer & Save — ${pct}% off while referrals stay subscribed`,
  });
}

// Any effective discount 1–100 (referral tier or admin fee override).
async function ensureDiscountCoupon({ secretKey, fetchImpl, discountPct }) {
  const pct = validDiscountPct(discountPct);
  if (!pct) return null;
  if (REFERRAL_COUPON_PCTS.includes(pct)) {
    return ensureReferralCoupon({ secretKey, fetchImpl, discountPct: pct });
  }
  return ensureCouponById({
    secretKey, fetchImpl, id: discountCouponId(pct), pct,
    name: `VixionBot discount — ${pct}% off`,
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

async function createCheckoutSession({ secretKey, fetchImpl, successUrl, cancelUrl, userId, customerEmail, discountPct = 0, plan = 'monthly', now = new Date() }) {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured.');
  if (validDiscountPct(discountPct)) {
    await ensureDiscountCoupon({ secretKey, fetchImpl, discountPct });
  }
  const params = buildCheckoutSessionParams({ successUrl, cancelUrl, userId, customerEmail, discountPct, plan, now });
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
  // A trialing subscription owes $0 at checkout (first 14 days
  // free), so Stripe reports its completed session as
  // payment_status 'no_payment_required' rather than 'paid'; either
  // means the payer finished checkout and the subscription exists.
  return session.payment_status === 'paid'
    || session.payment_status === 'no_payment_required'
    || session.status === 'complete';
}

async function verifyAndMarkSubscribed({ db, secretKey, fetchImpl, sessionId, userId }) {
  const session = await retrieveCheckoutSession({ secretKey, fetchImpl, sessionId });
  if (!sessionBelongsToUser(session, userId)) return { ok: false, reason: 'session-user-mismatch' };
  if (!sessionIsPaid(session)) return { ok: false, reason: 'session-not-paid' };
  const row = markSubscribed(db, userId, {
    customerId: typeof session.customer === 'string' ? session.customer : null,
    subscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
    sessionId: session.id || sessionId,
    plan: session.metadata ? session.metadata.billing_plan : undefined,
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

  post('/api/subscription/trial-dismiss', requireAuth, (req, res) => {
    recordTrialPopupDismissal(db, req.session.userId);
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
      // Billing plan from the unlock popup's chooser (Johnny
      // 2026-10-20): 'annual' bills $539.89/year, anything else —
      // missing, monthly, garbage — falls back to monthly.
      const plan = normalizePlan(req.body && req.body.plan);
      // Refer & Save + admin fee deals: apply the account's EFFECTIVE
      // discount — max(referral discount, admin-set discount) —
      // recomputed live; 0 for most accounts, which adds no calls.
      const discountPct = adminControls.getEffectiveDiscountPct(db, userId, { billingLive: true });
      const session = await createCheckoutSession({
        secretKey,
        fetchImpl,
        userId,
        discountPct,
        plan,
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
  ANNUAL_PRICE_CENTS,
  ANNUAL_PRICE_DISPLAY,
  PLANS,
  normalizePlan,
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
  recordTrialPopupDismissal,
  OWNER_USER_ID,
  isOwnerUser,
  recordFoundingSignup,
  markSubscribed,
  setSubscriptionStateAdmin,
  TRIAL_BUSINESS_DAYS,
  TRIAL_COPY,
  computeTrialEndEpoch,
  buildCheckoutSessionParams,
  encodeStripeForm,
  REFERRAL_COUPON_PCTS,
  referralCouponId,
  discountCouponId,
  validDiscountPct,
  ensureReferralCoupon,
  ensureDiscountCoupon,
  createCheckoutSession,
  retrieveCheckoutSession,
  sessionBelongsToUser,
  sessionIsPaid,
  verifyAndMarkSubscribed,
  mountSubscription,
};
