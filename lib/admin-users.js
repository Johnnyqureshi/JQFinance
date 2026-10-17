'use strict';

// USERS admin page (Johnny 2026-10-17): an owner-only page on Johnny's
// login so he can track registered users — emails, subscription state,
// referral standing, and each connected bot's account size.
//
// ACCESS RULE (the whole point): this page and its data API exist ONLY
// for the owner account (the same owner identity the Kiaan hide-internals
// build pins: user 1000000005, god level). The gate is enforced HERE,
// server-side, on both routes: anyone who is not the owner — logged in
// or not — gets a 404, exactly as if the page did not exist, and the nav
// entry is rendered client-side only for the owner. No other user can
// ever see another user's email or account data through this module.
//
// The page is READ-ONLY: it assembles rows from the user store (jqf.db),
// the subscription-state layer (lib/subscription.js + the email-keyed
// exemption in lib/subscription-exemptions.js), the referrals module
// (pure-read standing: attribution counts + isActiveSubscriber, never
// the code-minting summary), and the Kiaan service's stored roster
// (lib/kiaan/service.js adminBotRoster — stored settings/credentials/
// positions plus the last captured account snapshot; it never triggers a
// broker call). The "Exempt" label is computed here and appears ONLY in
// this owner payload — every user-facing surface calls the same accounts
// simply "Active".

const subscription = require('./subscription');
const referrals = require('./referrals');
const exemptions = require('./subscription-exemptions');

// Same owner identity server.js pins for the Kiaan owner view.
const OWNER_USER_ID = 1000000005;

function isOwnerUser(userId) {
  return Number(userId) === OWNER_USER_ID;
}

// Plain-words subscription state for the admin table. Exempt wins over
// every stored status: the account never pays, whatever its row says.
// Resolved through the subscription module's own state computation so
// this page can never drift from what the popup/checkout layer believes.
function subscriptionStateLabel(db, user) {
  if (exemptions.isExemptEmail(db, user && user.email)) return 'Exempt';
  const row = subscription.getSubscriptionRow(db, user.id);
  const state = subscription.computePopupState(row, { exempt: false });
  if (state.status === 'active') return 'Active';
  if (state.status === 'founding') return 'Founding';
  return 'Free';
}

// Referral standing with pure reads only: the admin page must not mint
// referral codes or write anything while rendering.
function referralStanding(db, userId, { billingLive = false } = {}) {
  referrals.ensureReferralSchema(db);
  const uid = Number(userId);
  const referred = db.prepare(
    'SELECT referred_user_id FROM referral_attributions WHERE referrer_user_id=?'
  ).all(uid).map(r => Number(r.referred_user_id));
  const activeCount = referred
    .filter(id => referrals.isActiveSubscriber(db, id, { billingLive })).length;
  return {
    joined: referred.length,
    active: activeCount,
    discountPct: referrals.computeDiscountPct(activeCount),
  };
}

function buildAdminUsersPayload({ db, kiaanService, billingLive = false } = {}) {
  const users = db.prepare(
    'SELECT id, email, username, created_at, email_verified FROM users ORDER BY id DESC'
  ).all();
  const roster = new Map();
  if (kiaanService && typeof kiaanService.adminBotRoster === 'function') {
    for (const row of kiaanService.adminBotRoster()) roster.set(Number(row.userId), row);
  }
  let founding = 0;
  let activeSubscribers = 0;
  let botsConnected = 0;
  const rows = users.map(user => {
    const label = subscriptionStateLabel(db, user);
    if (label === 'Founding') founding += 1;
    if (label === 'Active' || label === 'Exempt') activeSubscribers += 1;
    const botRow = roster.get(Number(user.id)) || null;
    const bot = botRow && botRow.connected ? {
      connected: true,
      mode: botRow.mode || 'PAPER',
      enabled: !!botRow.enabled,
      openPositions: botRow.openPositions || 0,
      equity: botRow.equity != null ? Number(botRow.equity) : null,
      buyingPower: botRow.buyingPower != null ? Number(botRow.buyingPower) : null,
      equityAsOf: botRow.equityAsOf || null,
    } : null;
    if (bot) botsConnected += 1;
    return {
      id: Number(user.id),
      email: user.email || '',
      username: user.username || '',
      joinedAt: user.created_at || null,
      emailVerified: Number(user.email_verified) === 1,
      subscription: label,
      referrals: referralStanding(db, user.id, { billingLive }),
      bot,
    };
  });
  return {
    totals: {
      users: users.length,
      founding,
      activeSubscribers,
      botsConnected,
    },
    users: rows,
  };
}

const NOT_FOUND_HTML = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
  + '<title>Not found — Qureshi Finance</title></head>'
  + '<body><h1>Not found</h1><p>The page you requested does not exist.</p></body></html>';

function mountAdminUsers({ app, db, kiaanService, getStripeSecretKey, ownerUserId = OWNER_USER_ID }) {
  const routes = [];
  const isOwnerReq = req => !!(req.session && req.session.userId)
    && Number(req.session.userId) === Number(ownerUserId);

  // Page route: the SPA shell deep link. Owner only — everyone else,
  // logged in or not, gets a 404 as if the page did not exist.
  app.get('/users', (req, res) => {
    if (!isOwnerReq(req)) return res.status(404).type('html').send(NOT_FOUND_HTML);
    return res.redirect('/#users');
  });
  routes.push('GET /users');

  // Data API: same gate, enforced here (no requireAuth pass-through —
  // a logged-out or non-owner request must read as 404, never 401/403).
  app.get('/api/admin/users', (req, res) => {
    if (!isOwnerReq(req)) return res.status(404).json({ error: 'Not found' });
    const billingLive = typeof getStripeSecretKey === 'function' ? !!getStripeSecretKey() : false;
    const payload = buildAdminUsersPayload({ db, kiaanService, billingLive });
    return res.json({ ok: true, ...payload });
  });
  routes.push('GET /api/admin/users');

  return { routes };
}

module.exports = {
  OWNER_USER_ID,
  isOwnerUser,
  subscriptionStateLabel,
  referralStanding,
  buildAdminUsersPayload,
  mountAdminUsers,
};
