'use strict';

// Refer & Save referral program (Johnny 2026-10-17): 20% off the flat
// $49.99/mo subscription for each referred friend who subscribes,
// stacking to a 60% cap, in effect while each referred friend stays
// subscribed. The discount is always computed from CURRENT active
// referrals — never banked — so it steps down on its own when a
// referred account stops being active.
//
// Attribution: every account gets a stable personal referral code; the
// link is https://qureshifinance.com/?ref=<code>. A visitor who arrives
// with a code has it carried through signup (client stores it, register
// posts it back) and the server records referred_by exactly once, at
// registration, in referral_attributions (referred_user_id is the PK and
// the insert is OR IGNORE, so attribution can never be rewritten). No
// self-referral: a code can never attribute its own owner, and the
// same-email signup is refused attribution as well.
//
// State lives in the main user database (jqf.db) next to
// agentic_subscriptions. While STRIPE_SECRET_KEY is absent the program
// runs in founding phase: referrals are tracked and discounts recorded
// as entitlements only — nothing is charged anywhere. When billing goes
// live the checkout applies the current discount via a Stripe coupon
// (see lib/subscription.js), and isActiveSubscriber below — the ONE
// switch — starts counting only paying subscribers.

const crypto = require('node:crypto');

// Keep in step with PRICE_CENTS in lib/subscription.js (the flat plan).
const PLAN_PRICE_CENTS = 4999;
const PER_REFERRAL_PCT = 20;
const MAX_DISCOUNT_PCT = 60;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes
const CODE_LENGTH = 8;
const RULE_TEXT = '20% off for each friend who subscribes, up to 60% off, while they stay subscribed.';

function ensureReferralSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      user_id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS referral_attributions (
      referred_user_id INTEGER PRIMARY KEY,
      referrer_user_id INTEGER NOT NULL,
      code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_referral_attributions_referrer
      ON referral_attributions (referrer_user_id);
  `);
}

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

function normalizeCode(code) {
  if (typeof code !== 'string') return '';
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Every account has exactly one stable code; created lazily the first
// time the account's referral surface (or a summary) is requested.
function getOrCreateReferralCode(db, userId) {
  ensureReferralSchema(db);
  const uid = Number(userId);
  const existing = db.prepare('SELECT code FROM referral_codes WHERE user_id=?').get(uid);
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateCode();
    try {
      db.prepare('INSERT INTO referral_codes (user_id, code) VALUES (?, ?)').run(uid, code);
      return code;
    } catch (error) {
      // UNIQUE collision on the code (astronomically unlikely) — retry
      // with a fresh one; a user_id conflict means a concurrent create
      // won the race, so read the stored code back.
      const row = db.prepare('SELECT code FROM referral_codes WHERE user_id=?').get(uid);
      if (row) return row.code;
      if (attempt === 7) throw error;
    }
  }
  throw new Error('Could not allocate a referral code.');
}

function resolveReferralCode(db, code) {
  ensureReferralSchema(db);
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const row = db.prepare('SELECT user_id FROM referral_codes WHERE code=?').get(normalized);
  return row ? Number(row.user_id) : null;
}

function getAttribution(db, referredUserId) {
  ensureReferralSchema(db);
  return db.prepare('SELECT * FROM referral_attributions WHERE referred_user_id=?')
    .get(Number(referredUserId)) || null;
}

// Record referred_by for a brand-new account. Set-once by construction:
// the PK + INSERT OR IGNORE means an existing attribution is returned
// as 'already-attributed' and never overwritten. Self-referral and the
// same-email case are refused. Returns { ok, reason? }.
function recordAttribution(db, {
  referredUserId, referrerUserId, code = null, referredEmail = null, referrerEmail = null,
} = {}) {
  ensureReferralSchema(db);
  const referred = Number(referredUserId);
  const referrer = Number(referrerUserId);
  if (!Number.isFinite(referred) || !Number.isFinite(referrer) || referred <= 0 || referrer <= 0) {
    return { ok: false, reason: 'invalid-user' };
  }
  if (referrer === referred) return { ok: false, reason: 'self-referral' };
  const a = typeof referredEmail === 'string' ? referredEmail.trim().toLowerCase() : '';
  const b = typeof referrerEmail === 'string' ? referrerEmail.trim().toLowerCase() : '';
  if (a && b && a === b) return { ok: false, reason: 'same-email' };
  const result = db.prepare(`
    INSERT OR IGNORE INTO referral_attributions (referred_user_id, referrer_user_id, code)
    VALUES (?, ?, ?)
  `).run(referred, referrer, code ? normalizeCode(code) || null : null);
  if (!result.changes) return { ok: false, reason: 'already-attributed' };
  return { ok: true };
}

// ── THE active-subscriber switch ──────────────────────────────────────
// This one function decides whether a referred account counts toward a
// referrer's discount, and it is the only place that knows which phase
// the program is in:
//   • Founding phase (billingLive=false, the state until the LLC +
//     Stripe account are ready): an account counts when it is on the
//     founding list (or already marked active) AND its email is
//     verified in the main users table.
//   • Billing live (billingLive=true, passed by callers whenever
//     STRIPE_SECRET_KEY is configured): only a paying subscription
//     (agentic_subscriptions.status = 'active') counts.
// When billing activates, callers flip the flag — nothing else in this
// module changes.
function isActiveSubscriber(db, userId, { billingLive = false } = {}) {
  const uid = Number(userId);
  let row = null;
  try {
    row = db.prepare('SELECT status, founding FROM agentic_subscriptions WHERE user_id=?').get(uid);
  } catch (_) { row = null; } // table not created yet — nobody is active
  if (!row) return false;
  if (row.status === 'active') return true;
  if (billingLive) return false;
  if (Number(row.founding) === 1) {
    try {
      const user = db.prepare('SELECT email_verified FROM users WHERE id=?').get(uid);
      return !!user && Number(user.email_verified) === 1;
    } catch (_) { return false; }
  }
  return false;
}

function computeDiscountPct(activeCount) {
  const n = Math.max(0, Math.floor(Number(activeCount) || 0));
  return Math.min(MAX_DISCOUNT_PCT, n * PER_REFERRAL_PCT);
}

// Floor, not round: 20% → 3999 ($39.99), 40% → 2999 ($29.99),
// 60% → 1999 ($19.99) — the prices Johnny quoted.
function priceAfterDiscountCents(pct) {
  const p = Math.min(MAX_DISCOUNT_PCT, Math.max(0, Number(pct) || 0));
  return Math.floor(PLAN_PRICE_CENTS * (100 - p) / 100);
}

function formatCents(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function getReferralSummary(db, userId, { billingLive = false } = {}) {
  ensureReferralSchema(db);
  const uid = Number(userId);
  const code = getOrCreateReferralCode(db, uid);
  const referred = db.prepare(
    'SELECT referred_user_id FROM referral_attributions WHERE referrer_user_id=? ORDER BY created_at, referred_user_id'
  ).all(uid).map(r => Number(r.referred_user_id));
  const activeCount = referred
    .filter(id => isActiveSubscriber(db, id, { billingLive })).length;
  const discountPct = computeDiscountPct(activeCount);
  const discountedCents = priceAfterDiscountCents(discountPct);
  return {
    code,
    linkPath: `/?ref=${code}`,
    joinedCount: referred.length,
    activeCount,
    discountPct,
    priceCents: PLAN_PRICE_CENTS,
    priceDisplay: formatCents(PLAN_PRICE_CENTS),
    discountedPriceCents: discountedCents,
    discountedPriceDisplay: formatCents(discountedCents),
    perReferralPct: PER_REFERRAL_PCT,
    maxDiscountPct: MAX_DISCOUNT_PCT,
    rule: RULE_TEXT,
  };
}

// The checkout hook: the account's CURRENT discount percentage.
function getReferralDiscountPct(db, userId, opts) {
  return getReferralSummary(db, userId, opts).discountPct;
}

function mountReferrals({ app, db, requireAuth, getStripeSecretKey }) {
  ensureReferralSchema(db);
  const routes = [];
  const get = (p, ...h) => { app.get(p, ...h); routes.push(`GET ${p}`); };

  get('/api/referrals/me', requireAuth, (req, res) => {
    const summary = getReferralSummary(db, req.session.userId, {
      billingLive: typeof getStripeSecretKey === 'function' ? !!getStripeSecretKey() : false,
    });
    res.json({ ok: true, ...summary });
  });

  return { routes };
}

module.exports = {
  PLAN_PRICE_CENTS,
  PER_REFERRAL_PCT,
  MAX_DISCOUNT_PCT,
  RULE_TEXT,
  ensureReferralSchema,
  generateCode,
  normalizeCode,
  getOrCreateReferralCode,
  resolveReferralCode,
  getAttribution,
  recordAttribution,
  isActiveSubscriber,
  computeDiscountPct,
  priceAfterDiscountCents,
  formatCents,
  getReferralSummary,
  getReferralDiscountPct,
  mountReferrals,
};
