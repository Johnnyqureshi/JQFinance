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
const exemptions = require('../lib/subscription-exemptions');
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
  assert.equal(item.price_data.product_data.name, 'VixionBot Agentic Trading');
  assert.equal(p.client_reference_id, '7');
});

// ── Free trial: marketed as "14 days free" = 10 BUSINESS days (Johnny
// 2026-10-18 at 5 business days; extended 2026-10-19). Stripe gets an
// explicit subscription_data.trial_end = 23:59:59 America/Chicago on
// the 10th business day, today counting as day 1 when it is a
// business day.
function chicagoParts(epochSeconds) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = t => parts.find(p => p.type === t).value;
  return {
    weekday: get('weekday'), year: get('year'), month: get('month'), day: get('day'),
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

test('trial end: Monday signup (CDT) ends Friday 23:59:59 CT of the following week', () => {
  const now = new Date('2026-10-19T15:00:00Z'); // Mon Oct 19, 10:00 CDT
  const end = sub.computeTrialEndEpoch(now);
  const p = chicagoParts(end);
  assert.equal(p.weekday, 'Fri');
  assert.equal(`${p.year}-${p.month}-${p.day}`, '2026-10-30');
  assert.equal(p.time, '23:59:59');
  assert.equal(end, Math.floor(Date.UTC(2026, 9, 31, 4, 59, 59) / 1000), 'CDT is UTC-5');
  assert.ok(end > Math.floor(now.getTime() / 1000), 'trial_end is in the future');
});

test('trial end: Friday signup counts Fri as day 1 and ends the Thursday two weeks out', () => {
  const now = new Date('2026-10-23T15:00:00Z'); // Fri Oct 23, 10:00 CDT
  const end = sub.computeTrialEndEpoch(now);
  const p = chicagoParts(end);
  assert.equal(p.weekday, 'Thu');
  assert.equal(`${p.year}-${p.month}-${p.day}`, '2026-11-05');
  assert.equal(p.time, '23:59:59');
  assert.ok(end > Math.floor(now.getTime() / 1000), 'trial_end is in the future');
});

test('trial end: Saturday signup — the ten business days are the next two Mon–Fri weeks, ends the second Friday', () => {
  const now = new Date('2026-10-24T15:00:00Z'); // Sat Oct 24, 10:00 CDT
  const end = sub.computeTrialEndEpoch(now);
  const p = chicagoParts(end);
  assert.equal(p.weekday, 'Fri');
  assert.equal(`${p.year}-${p.month}-${p.day}`, '2026-11-06');
  assert.equal(p.time, '23:59:59');
  const sun = sub.computeTrialEndEpoch(new Date('2026-10-25T15:00:00Z'));
  assert.equal(sun, end, 'Sunday signup lands on the same Friday');
  // Independently computed: Fri Nov 6 2026, 23:59:59 CST (UTC-6) =
  // 2026-11-07T05:59:59Z.
  assert.equal(end, 1794031199, 'Sunday/Saturday signup trial_end epoch');
});

test('trial end: the CT offset follows the target date across the DST boundary (CST)', () => {
  const now = new Date('2026-11-02T16:00:00Z'); // Mon Nov 2, 10:00 CST
  const end = sub.computeTrialEndEpoch(now);
  const p = chicagoParts(end);
  assert.equal(p.weekday, 'Fri');
  assert.equal(`${p.year}-${p.month}-${p.day}`, '2026-11-13');
  assert.equal(p.time, '23:59:59');
  assert.equal(end, Math.floor(Date.UTC(2026, 10, 14, 5, 59, 59) / 1000), 'CST is UTC-6');
});

test('checkout params: subscription_data carries the computed trial_end, no trial_period_days', () => {
  const now = new Date('2026-10-19T15:00:00Z'); // Monday
  const p = sub.buildCheckoutSessionParams({
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no', userId: 7, now,
  });
  assert.equal(p.subscription_data.trial_end, sub.computeTrialEndEpoch(now));
  assert.equal(p.subscription_data.trial_period_days, undefined, 'business-day trial is an explicit end, not a day count');
  assert.equal(p.subscription_data.metadata.user_id, '7', 'subscription metadata unchanged');
  assert.equal(p.payment_method_collection, undefined, 'card collection stays Stripe default');
});

test('checkout-session creation posts subscription_data[trial_end] to Stripe', async () => {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true, status: 200,
      json: async () => ({ id: 'cs_test_trial', url: 'https://checkout.stripe.com/c/cs_test_trial' }),
    };
  };
  const now = new Date('2026-10-19T15:00:00Z'); // Monday
  await sub.createCheckoutSession({
    secretKey: 'sk_test_stubbed',
    fetchImpl: fetchStub,
    successUrl: 'https://example.test/ok',
    cancelUrl: 'https://example.test/no',
    userId: 7,
    now,
  });
  assert.equal(calls.length, 1);
  const body = decodeURIComponent(calls[0].options.body);
  assert.ok(body.includes(`[trial_end]=${sub.computeTrialEndEpoch(now)}`), 'trial_end sent in subscription_data');
  assert.ok(!body.includes('trial_period_days'), 'no calendar-day trial sent');
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
  assert.ok(body.includes('VixionBot Agentic Trading'), 'product name sent');
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

// ── Trial promo popup (Johnny 2026-10-18): audience is exactly the
// accounts that could convert; dismissal is a server-side flag.
test('trial popup audience: free users only — not active, founding, exempt, or the owner', () => {
  const free = sub.computePopupState(null, {});
  assert.equal(free.showTrialPopup, true, 'fresh free account sees the trial promo');
  const active = sub.computePopupState({ status: 'active', founding: 1 }, {});
  assert.equal(active.showTrialPopup, false, 'subscribers never see it');
  const founding = sub.computePopupState({ status: 'founding', founding: 1 }, {});
  assert.equal(founding.showTrialPopup, false, 'founding-list accounts never see it');
  const exempt = sub.computePopupState(null, { exempt: true });
  assert.equal(exempt.showTrialPopup, false, 'exempt accounts never see it');
  const owner = sub.computePopupState(null, { isOwner: true });
  assert.equal(owner.showTrialPopup, false, 'the owner is not nagged');
  const dismissed = sub.computePopupState(
    { status: 'none', trial_popup_dismissed_at: '2026-10-18T00:00:00.000Z' }, {});
  assert.equal(dismissed.showTrialPopup, false, 'dismissed accounts never see it again');
  assert.equal(dismissed.trialDismissed, true);
});

test('trial popup: owner pin applies through getPopupState without an explicit flag', () => {
  const db = freshDb();
  assert.equal(sub.getPopupState(db, 7, {}).showTrialPopup, true, 'regular free user is in the audience');
  assert.equal(sub.getPopupState(db, sub.OWNER_USER_ID, {}).showTrialPopup, false, 'owner id is excluded by default');
});

test('trial popup dismissal persists server-side per account', () => {
  const db = freshDb();
  assert.equal(sub.getPopupState(db, 7, {}).showTrialPopup, true);
  const row = sub.recordTrialPopupDismissal(db, 7);
  assert.ok(row.trial_popup_dismissed_at, 'dismissal timestamp recorded');
  const after = sub.getPopupState(db, 7, {});
  assert.equal(after.showTrialPopup, false, 'never shows again after dismissal');
  assert.equal(after.status, 'none', 'dismissal alone does not change subscription status');
  assert.equal(after.shouldShowPopup, true, 'unlock popup state is independent of the trial flag');
});

test('trial-dismiss route records the dismissal and echoes the closed state', async () => {
  const db = freshDb();
  const app = fakeApp();
  const out = sub.mountSubscription({
    app, db, requireAuth: requireAuthStub,
    getStripeSecretKey: () => null,
    fetchImpl: async () => { throw new Error('Stripe must not be called'); },
  });
  assert.ok(out.routes.includes('POST /api/subscription/trial-dismiss'), 'trial-dismiss route mounted');
  const res = fakeRes();
  await app.handlers.get('POST /api/subscription/trial-dismiss')({ session: { userId: 7 } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.showTrialPopup, false);
  assert.ok(sub.getSubscriptionRow(db, 7).trial_popup_dismissed_at);
});

test('index.html carries the trial popup markup and the trial copy (muted theme classes)', () => {
  assert.ok(html.includes('id="trialOverlay"'), 'trial overlay present');
  assert.ok(html.includes('id="trialCta"'), 'trial CTA present');
  assert.ok(html.includes('Your first 14 days are free'), 'headline present');
  assert.ok(html.includes('14 days of VixionBot Agentic trading — then $49.99/mo. Cancel anytime.'), 'body copy present');
  assert.ok(html.includes('Start my free trial'), 'primary button label present');
  assert.ok(html.includes('First 14 days free, then'), 'plan block trial line present');
  assert.ok(!/guarantee|guaranteed|profit/i.test(html.slice(html.indexOf('id="trialOverlay"'), html.indexOf('id="trialOverlay"') + 1200)), 'no profit promises in the trial popup');
});

test('client wiring: trial popup is server-gated, dismisses via its endpoint, never stacks', () => {
  assert.ok(subJs.includes('/api/subscription/trial-dismiss'), 'client posts trial dismissal to the server');
  assert.ok(subJs.includes('state.showTrialPopup'), 'client renders only when the server says so');
  assert.ok(subJs.includes("showTrialModal"), 'trial modal renderer present');
  assert.ok(subJs.includes("$('subscriptionOverlay')?.classList.contains('open')"), 'no-stack guard checks the unlock overlay');
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
  assert.ok(html.includes('/js/subscription.js?v=20261020a'), 'subscription.js tag bumped');
  assert.ok(html.includes('/public/css/subscription.css?v=20261020a'), 'subscription.css tag bumped');
  assert.ok(html.includes('/js/app.js?v=20261020b'), 'app.js tag bumped for the login hook');
  assert.ok(!/paypal/i.test(html), 'no PayPal in this build (phase 2)');
});

// ── Annual plan (Johnny 2026-10-20): $539.89/year = exactly 10% off
// 12 × $49.99 ($599.88). Monthly stays the default and the fallback;
// the trial computation and the percent coupons are interval-blind.
test('annual plan constants: 53989 is exactly 10% off a year of monthly; plan normalization', () => {
  assert.equal(sub.ANNUAL_PRICE_CENTS, 53989);
  assert.equal(sub.ANNUAL_PRICE_CENTS, Math.round(sub.PRICE_CENTS * 12 * 0.9));
  assert.equal(sub.ANNUAL_PRICE_DISPLAY, '$539.89');
  assert.equal(sub.normalizePlan('annual'), 'annual');
  assert.equal(sub.normalizePlan('monthly'), 'monthly');
  assert.equal(sub.normalizePlan('bogus'), 'monthly', 'unknown plan falls back to monthly');
  assert.equal(sub.normalizePlan(undefined), 'monthly', 'missing plan falls back to monthly');
});

test('annual checkout params: 53989 USD, yearly interval, same product, identical trial_end', () => {
  const now = new Date('2026-10-19T15:00:00Z'); // Monday
  const base = { successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no', userId: 7, now };
  const annual = sub.buildCheckoutSessionParams({ ...base, plan: 'annual' });
  const monthly = sub.buildCheckoutSessionParams({ ...base, plan: 'monthly' });
  const item = annual.line_items[0];
  assert.equal(annual.mode, 'subscription');
  assert.equal(item.price_data.unit_amount, 53989);
  assert.equal(item.price_data.currency, 'usd');
  assert.equal(item.price_data.recurring.interval, 'year');
  assert.equal(item.price_data.product_data.name, 'VixionBot Agentic Trading');
  assert.equal(annual.subscription_data.trial_end, monthly.subscription_data.trial_end,
    'trial_end computation is identical for the annual plan');
  assert.equal(annual.metadata.billing_plan, 'annual');
  assert.equal(annual.subscription_data.metadata.billing_plan, 'annual');
});

test('plan fallback: unknown or missing plan bills the monthly amount and interval', () => {
  const base = { successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no', userId: 7 };
  for (const plan of [undefined, 'monthly', 'yearly', 'ANNUAL', 42]) {
    const p = sub.buildCheckoutSessionParams({ ...base, plan });
    assert.equal(p.line_items[0].price_data.unit_amount, 4999, `plan ${String(plan)} bills monthly`);
    assert.equal(p.line_items[0].price_data.recurring.interval, 'month');
    assert.equal(p.metadata.billing_plan, 'monthly');
  }
});

test('annual checkout-session creation posts 53989 + interval year + trial_end to Stripe', async () => {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true, status: 200,
      json: async () => ({ id: 'cs_test_annual', url: 'https://checkout.stripe.com/c/cs_test_annual' }),
    };
  };
  const now = new Date('2026-10-19T15:00:00Z'); // Monday
  const session = await sub.createCheckoutSession({
    secretKey: 'sk_test_stubbed', fetchImpl: fetchStub,
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no',
    userId: 7, plan: 'annual', now,
  });
  assert.equal(session.id, 'cs_test_annual');
  assert.equal(calls.length, 1);
  const body = decodeURIComponent(calls[0].options.body);
  assert.ok(body.includes('[unit_amount]=53989'), 'annual amount sent');
  assert.ok(body.includes('[recurring][interval]=year'), 'yearly interval sent');
  assert.ok(body.includes(`[trial_end]=${sub.computeTrialEndEpoch(now)}`), 'trial_end sent for annual');
  assert.ok(body.includes('[billing_plan]=annual'), 'billing plan metadata sent');
});

test('annual checkout applies the referral coupon identically', async () => {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/coupons/qf-referral-20')) {
      return { ok: false, status: 404, json: async () => ({ error: { message: 'No such coupon' } }) };
    }
    if (url.endsWith('/coupons')) {
      return { ok: true, status: 200, json: async () => ({ id: 'qf-referral-20', percent_off: 20 }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ id: 'cs_test_ann_disc', url: 'https://checkout.stripe.com/c/cs_test_ann_disc' }),
    };
  };
  await sub.createCheckoutSession({
    secretKey: 'sk_test_stubbed', fetchImpl: fetchStub,
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no',
    userId: 7, plan: 'annual', discountPct: 20,
  });
  assert.ok(calls.some(c => c.url.endsWith('/coupons')), 'coupon ensured before checkout');
  const sessionCall = calls.find(c => c.url.endsWith('/checkout/sessions'));
  const body = decodeURIComponent(sessionCall.options.body);
  assert.ok(body.includes('[unit_amount]=53989'), 'annual amount with coupon');
  assert.ok(body.includes('[recurring][interval]=year'), 'annual interval with coupon');
  assert.ok(body.includes('qf-referral-20'), 'referral coupon applied to the annual session');
});

test('checkout route: plan annual in the request body creates an annual Stripe session', async () => {
  const db = freshDb();
  const app = fakeApp();
  const bodies = [];
  sub.mountSubscription({
    app, db, requireAuth: requireAuthStub,
    getStripeSecretKey: () => 'sk_test_stubbed',
    fetchImpl: async (url, options) => {
      bodies.push(decodeURIComponent(options.body || ''));
      return {
        ok: true, status: 200,
        json: async () => ({ id: 'cs_test_route_ann', url: 'https://checkout.stripe.com/c/cs_test_route_ann' }),
      };
    },
  });
  const res = fakeRes();
  await app.handlers.get('POST /api/subscription/checkout')(
    { session: { userId: 7 }, protocol: 'https', get: () => 'example.test', body: { plan: 'annual' } }, res);
  assert.equal(res.body.mode, 'stripe');
  assert.equal(res.body.url, 'https://checkout.stripe.com/c/cs_test_route_ann');
  assert.ok(bodies.join(' ').includes('[unit_amount]=53989'), 'route passed the annual plan through');
  assert.ok(bodies.join(' ').includes('[recurring][interval]=year'), 'annual interval reached Stripe');
});

test('checkout route: exempt account creates zero Stripe sessions on either plan', async () => {
  for (const plan of ['monthly', 'annual']) {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT)');
    db.prepare('INSERT INTO users(id, email) VALUES (7, ?)').run('kin@example.test');
    sub.ensureSubscriptionSchema(db);
    exemptions.addExemption(db, 'kin@example.test');
    let stripeCalls = 0;
    const app = fakeApp();
    sub.mountSubscription({
      app, db, requireAuth: requireAuthStub,
      getStripeSecretKey: () => 'sk_test_stubbed',
      fetchImpl: async () => { stripeCalls += 1; throw new Error('Stripe must not be called for exempt accounts'); },
    });
    const res = fakeRes();
    await app.handlers.get('POST /api/subscription/checkout')(
      { session: { userId: 7 }, protocol: 'https', get: () => 'example.test', body: { plan } }, res);
    assert.equal(res.body.mode, 'exempt', `${plan}: exempt short-circuit answers without Stripe`);
    assert.equal(stripeCalls, 0, `${plan}: zero Stripe calls for an exempt account`);
    db.close();
  }
});

test('annual activation: success marking records plan_amount_cents 53989; monthly default unchanged', async () => {
  const db = freshDb();
  const ok = await sub.verifyAndMarkSubscribed({
    db, secretKey: 'sk_test_stubbed',
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({
        id: 'cs_ann', status: 'complete', payment_status: 'paid',
        client_reference_id: '7', customer: 'cus_9', subscription: 'sub_9',
        metadata: { user_id: '7', billing_plan: 'annual' },
      }),
    }),
    sessionId: 'cs_ann', userId: 7,
  });
  assert.equal(ok.ok, true);
  assert.equal(Number(sub.getSubscriptionRow(db, 7).plan_amount_cents), 53989, 'annual amount recorded');
  const monthlyRow = sub.markSubscribed(freshDb(), 7, {});
  assert.equal(Number(monthlyRow.plan_amount_cents), 4999, 'monthly stays the default recorded amount');
});

test('annual option markup + wiring: chooser in the unlock popup, monthly preselected, plan submitted', () => {
  assert.ok(html.includes('data-plan-option="monthly"'), 'monthly option present');
  assert.ok(html.includes('data-plan-option="annual"'), 'annual option present');
  assert.ok(html.includes('name="subPlan"'), 'plan radio group present');
  assert.ok(html.includes('value="monthly" checked'), 'monthly preselected');
  assert.ok(html.includes('$539.89'), 'annual price shown');
  assert.ok(html.includes('SAVE 10%'), 'save tag shown');
  assert.ok(html.includes('First 14 days free, then $49.99/mo — or $539.89/year, 10% off'),
    'plan line and K1 strip carry the annual alternative');
  assert.ok(subJs.includes('selectedPlan()'), 'client reads the chooser');
  assert.ok(subJs.includes('JSON.stringify({ plan: selectedPlan() })'), 'checkout posts the chosen plan');
  assert.ok(subJs.includes('input[name="subPlan"]'), 'chooser change wiring present');
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
