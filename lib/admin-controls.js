'use strict';

// Admin controls behind the owner-only USERS page (Johnny 2026-10-17):
// account suspension, per-account admin fee discount, and the audit
// log of every admin mutation. State lives in the main user database
// (jqf.db) next to agentic_subscriptions.
//
// Suspension is enforced in two places that read THIS module:
//   • server.js requireAuth — a suspended account's existing sessions
//     stop working on their next authenticated request (401, session
//     destroyed), and the login route refuses a fresh sign-in.
//   • lib/kiaan/service.js — the separate admin_hold flag on the bot
//     (set through the service by the admin routes, never from here:
//     the bot's state lives in its own store). Suspending sets the
//     hold; reactivating lifts it. The user's own Pause/Resume writes
//     a different column and can never override the hold.
//
// The admin discount is a percentage (0–100) stored per account. The
// EFFECTIVE discount for billing is max(referral discount, admin
// discount): an admin deal can beat what a user earned, never undercut
// it. In founding mode this is entitlement bookkeeping only; with a
// Stripe key present it flows through the deterministic-coupon
// checkout path in lib/subscription.js.

const referrals = require('./referrals');

function ensureAdminSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_user_controls (
      user_id INTEGER PRIMARY KEY,
      suspended INTEGER NOT NULL DEFAULT 0,
      admin_discount_pct INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_user_id INTEGER NOT NULL,
      target_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT
    );
  `);
}

function getControlsRow(db, userId) {
  ensureAdminSchema(db);
  return db.prepare('SELECT * FROM admin_user_controls WHERE user_id=?')
    .get(Number(userId)) || null;
}

function isSuspended(db, userId) {
  const row = getControlsRow(db, userId);
  return !!row && Number(row.suspended) === 1;
}

// Returns the previous suspended flag so callers can audit old → new.
function setSuspended(db, userId, suspended) {
  ensureAdminSchema(db);
  const uid = Number(userId);
  const before = isSuspended(db, uid);
  db.prepare(`
    INSERT INTO admin_user_controls (user_id, suspended) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET suspended=excluded.suspended, updated_at=datetime('now')
  `).run(uid, suspended ? 1 : 0);
  return before;
}

function getAdminDiscountPct(db, userId) {
  const row = getControlsRow(db, userId);
  if (!row || row.admin_discount_pct == null) return null;
  const pct = Number(row.admin_discount_pct);
  return Number.isFinite(pct) ? pct : null;
}

// pct: integer 0–100, or null to clear the override. Returns the
// previous value (null when none was set).
function setAdminDiscountPct(db, userId, pct) {
  if (pct !== null) {
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      throw new RangeError('Admin discount must be a whole percentage between 0 and 100, or null to clear.');
    }
  }
  ensureAdminSchema(db);
  const uid = Number(userId);
  const before = getAdminDiscountPct(db, uid);
  db.prepare(`
    INSERT INTO admin_user_controls (user_id, admin_discount_pct) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET admin_discount_pct=excluded.admin_discount_pct, updated_at=datetime('now')
  `).run(uid, pct);
  return before;
}

// The one effective-discount computation billing uses: the better of
// the earned referral discount and the admin-set discount.
function getEffectiveDiscountPct(db, userId, opts = {}) {
  const referralPct = referrals.getReferralDiscountPct(db, userId, opts);
  const adminPct = getAdminDiscountPct(db, userId) || 0;
  return Math.max(referralPct, adminPct);
}

function recordAudit(db, { actorUserId, targetUserId, action, oldValue = null, newValue = null } = {}) {
  ensureAdminSchema(db);
  const result = db.prepare(`
    INSERT INTO admin_audit (actor_user_id, target_user_id, action, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Number(actorUserId),
    Number(targetUserId),
    String(action),
    oldValue == null ? null : String(oldValue),
    newValue == null ? null : String(newValue),
  );
  return Number(result.lastInsertRowid);
}

function listAudit(db, limit = 20) {
  ensureAdminSchema(db);
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  return db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').all(n);
}

module.exports = {
  ensureAdminSchema,
  getControlsRow,
  isSuspended,
  setSuspended,
  getAdminDiscountPct,
  setAdminDiscountPct,
  getEffectiveDiscountPct,
  recordAudit,
  listAudit,
};
