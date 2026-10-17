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
// The page assembles rows from the user store (jqf.db), the
// subscription-state layer (lib/subscription.js + the email-keyed
// exemption in lib/subscription-exemptions.js), the referrals module
// (pure-read standing: attribution counts + isActiveSubscriber, never
// the code-minting summary), and the Kiaan service's stored roster
// (lib/kiaan/service.js adminBotRoster — stored settings/credentials/
// positions plus the last captured account snapshot; it never triggers a
// broker call). The "Exempt" label is computed here and appears ONLY in
// this owner payload — every user-facing surface calls the same accounts
// simply "Active".
//
// ADMIN CONTROLS (Johnny 2026-10-17): behind the SAME owner gate, the
// page can also mutate — suspend/reactivate an account (login/session
// enforcement lives in server.js requireAuth + the Kiaan admin_hold,
// both driven from the state set here), set a subscription state
// (Free/Founding/Active through lib/subscription.js, Exempt through
// the same email-keyed exemption store the env configuration uses),
// and set a per-account fee discount (effective discount =
// max(referral, admin), lib/admin-controls.js). Every mutation writes
// an audit row. HARD RAIL: the owner account itself can never be a
// mutation target — the API refuses and the UI renders no controls on
// the owner's row.

const subscription = require('./subscription');
const referrals = require('./referrals');
const exemptions = require('./subscription-exemptions');
const adminControls = require('./admin-controls');

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

function buildAdminUserRow(db, user, botRow, { billingLive = false } = {}) {
  const label = subscriptionStateLabel(db, user);
  const bot = botRow && botRow.connected ? {
    connected: true,
    mode: botRow.mode || 'PAPER',
    enabled: !!botRow.enabled,
    adminHold: !!botRow.adminHold,
    openPositions: botRow.openPositions || 0,
    equity: botRow.equity != null ? Number(botRow.equity) : null,
    buyingPower: botRow.buyingPower != null ? Number(botRow.buyingPower) : null,
    equityAsOf: botRow.equityAsOf || null,
  } : null;
  const standing = referralStanding(db, user.id, { billingLive });
  const controls = adminControls.getControlsRow(db, user.id);
  const adminDiscountPct = controls && controls.admin_discount_pct != null
    ? Number(controls.admin_discount_pct) : null;
  return {
    id: Number(user.id),
    email: user.email || '',
    username: user.username || '',
    joinedAt: user.created_at || null,
    emailVerified: Number(user.email_verified) === 1,
    subscription: label,
    suspended: !!controls && Number(controls.suspended) === 1,
    adminDiscountPct,
    effectiveDiscountPct: Math.max(standing.discountPct, adminDiscountPct || 0),
    isOwnerRow: isOwnerUser(user.id),
    referrals: standing,
    bot,
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
    const row = buildAdminUserRow(db, user, roster.get(Number(user.id)) || null, { billingLive });
    if (row.subscription === 'Founding') founding += 1;
    if (row.subscription === 'Active' || row.subscription === 'Exempt') activeSubscribers += 1;
    if (row.bot) botsConnected += 1;
    return row;
  });
  const emailById = new Map(users.map(u => [Number(u.id), u.email || '']));
  const audit = adminControls.listAudit(db, 20).map(row => ({
    id: Number(row.id),
    at: row.created_at,
    actorUserId: Number(row.actor_user_id),
    targetUserId: Number(row.target_user_id),
    targetEmail: emailById.get(Number(row.target_user_id)) || '',
    action: row.action,
    oldValue: row.old_value,
    newValue: row.new_value,
  }));
  return {
    totals: {
      users: users.length,
      founding,
      activeSubscribers,
      botsConnected,
    },
    users: rows,
    audit,
  };
}

const NOT_FOUND_HTML = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
  + '<title>Not found — Qureshi Finance</title></head>'
  + '<body><h1>Not found</h1><p>The page you requested does not exist.</p></body></html>';

function mountAdminUsers({ app, db, kiaanService, getStripeSecretKey, ownerUserId = OWNER_USER_ID }) {
  const routes = [];
  const isOwnerReq = req => !!(req.session && req.session.userId)
    && Number(req.session.userId) === Number(ownerUserId);
  const billingLiveNow = () => (typeof getStripeSecretKey === 'function' ? !!getStripeSecretKey() : false);

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
    const payload = buildAdminUsersPayload({ db, kiaanService, billingLive: billingLiveNow() });
    return res.json({ ok: true, ...payload });
  });
  routes.push('GET /api/admin/users');

  // ── Mutations (owner-only, same 404 gate) ──────────────────────────
  // Shared target resolution: non-owner → 404; the OWNER as target →
  // 400 with a clear refusal (the page never turns on him); a missing
  // account → 404.
  function targetUser(req, res) {
    if (!isOwnerReq(req)) { res.status(404).json({ error: 'Not found' }); return null; }
    const targetId = Number(req.params && req.params.userId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
    if (targetId === Number(ownerUserId)) {
      res.status(400).json({ error: 'The owner account cannot be suspended or modified from this page.' });
      return null;
    }
    const user = db.prepare(
      'SELECT id, email, username, created_at, email_verified FROM users WHERE id=?'
    ).get(targetId);
    if (!user) { res.status(404).json({ error: 'Not found' }); return null; }
    return user;
  }

  function refreshedRow(userId) {
    const user = db.prepare(
      'SELECT id, email, username, created_at, email_verified FROM users WHERE id=?'
    ).get(Number(userId));
    if (!user) return null;
    let botRow = null;
    if (kiaanService && typeof kiaanService.adminBotRoster === 'function') {
      botRow = kiaanService.adminBotRoster()
        .find(r => Number(r.userId) === Number(userId)) || null;
    }
    return buildAdminUserRow(db, user, botRow, { billingLive: billingLiveNow() });
  }

  function mutate(path, handler) {
    app.post(path, (req, res) => {
      try {
        return handler(req, res);
      } catch (error) {
        console.error('[AdminUsers] mutation failed:', error.message);
        return res.status(500).json({ error: 'The admin action could not be completed.' });
      }
    });
    routes.push(`POST ${path}`);
  }

  // Suspend / reactivate. Suspension lands in admin_user_controls
  // (login + session enforcement reads it in server.js) AND on the
  // bot's admin_hold (set through the Kiaan service, a flag the
  // user's own Pause/Resume can never touch).
  mutate('/api/admin/users/:userId/suspension', (req, res) => {
    const user = targetUser(req, res);
    if (!user) return undefined;
    const suspended = (req.body || {}).suspended;
    if (typeof suspended !== 'boolean') {
      return res.status(400).json({ error: 'suspended must be true or false.' });
    }
    const before = adminControls.setSuspended(db, user.id, suspended);
    if (kiaanService && typeof kiaanService.setAdminHold === 'function') {
      kiaanService.setAdminHold(user.id, suspended);
    }
    if (before !== suspended) {
      adminControls.recordAudit(db, {
        actorUserId: Number(req.session.userId),
        targetUserId: Number(user.id),
        action: suspended ? 'suspend' : 'reactivate',
        oldValue: before ? 'suspended' : 'active',
        newValue: suspended ? 'suspended' : 'active',
      });
    }
    return res.json({ ok: true, user: refreshedRow(user.id) });
  });

  // Set subscription state: Free / Founding / Active write through the
  // subscription module's own row; Exempt goes to the email-keyed
  // exemption store with the admin source, identical in effect to the
  // env-configured list. Leaving Exempt removes the admin row — an
  // env-configured exemption survives removal (the store refuses) and
  // the label keeps reading Exempt, truthfully.
  mutate('/api/admin/users/:userId/subscription', (req, res) => {
    const user = targetUser(req, res);
    if (!user) return undefined;
    const state = String((req.body || {}).state || '').toLowerCase();
    if (!['free', 'founding', 'active', 'exempt'].includes(state)) {
      return res.status(400).json({ error: 'state must be one of: free, founding, active, exempt.' });
    }
    const oldLabel = subscriptionStateLabel(db, user);
    if (state === 'exempt') {
      exemptions.addExemption(db, user.email, exemptions.ADMIN_EXEMPTION_NOTE);
    } else {
      exemptions.removeExemption(db, user.email);
      subscription.setSubscriptionStateAdmin(db, user.id, state);
    }
    const newLabel = subscriptionStateLabel(db, user);
    if (newLabel !== oldLabel) {
      adminControls.recordAudit(db, {
        actorUserId: Number(req.session.userId),
        targetUserId: Number(user.id),
        action: 'subscription',
        oldValue: oldLabel,
        newValue: newLabel,
      });
    }
    return res.json({ ok: true, user: refreshedRow(user.id) });
  });

  // Per-account fee discount: a whole percentage 0–100, or null to
  // clear. The effective discount billed is max(referral, admin) —
  // computed at checkout and mirrored in the roster payload.
  mutate('/api/admin/users/:userId/discount', (req, res) => {
    const user = targetUser(req, res);
    if (!user) return undefined;
    const raw = (req.body || {}).pct;
    let pct = null;
    if (raw !== null && raw !== undefined) {
      pct = Number(raw);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ error: 'pct must be a whole number between 0 and 100, or null to clear.' });
      }
    }
    const before = adminControls.setAdminDiscountPct(db, user.id, pct);
    if (before !== pct) {
      adminControls.recordAudit(db, {
        actorUserId: Number(req.session.userId),
        targetUserId: Number(user.id),
        action: 'discount',
        oldValue: before == null ? 'none' : `${before}%`,
        newValue: pct == null ? 'none' : `${pct}%`,
      });
    }
    return res.json({ ok: true, user: refreshedRow(user.id) });
  });

  return { routes };
}

module.exports = {
  OWNER_USER_ID,
  isOwnerUser,
  subscriptionStateLabel,
  referralStanding,
  buildAdminUserRow,
  buildAdminUsersPayload,
  mountAdminUsers,
};
