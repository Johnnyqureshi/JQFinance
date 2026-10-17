'use strict';

// Subscription fee exemptions (Johnny 2026-10-17, PRIVATE): a small
// set of designated accounts never pay subscription fees. An exempt
// account is treated everywhere as a full active subscriber:
// "Agentic Trading: Active", no popup, never routed to checkout, never
// charged, and it counts as an active subscriber inside the Refer &
// Save isActiveSubscriber switch. That holds in BOTH phases: the
// founding-list phase running today and the billing phase that starts
// when the LLC + Stripe account go live.
//
// PRIVACY: the exempt addresses are NEVER written into this repo — no
// code, no config, no docs. They are configured only through the
// SUBSCRIPTION_EXEMPT_EMAILS environment variable on the app service
// (comma-separated), and exist at runtime in the server's environment
// and the subscription_exemptions table (keyed on normalized email,
// in the private app database). Nothing about the list is exposed on
// any shared surface: an exempt account's own pages simply read
// "Active", exactly like a paying subscriber's.
//
// Matching is by the account's registered EMAIL address (normalized:
// trimmed, lowercased), resolved fresh at the subscription-state
// layer — so the exemption applies to an account that already exists
// and to an account that registers with a configured email later,
// with no further wiring. Empty/unset env var = nobody is exempt.
//
// This module is standalone (requires nothing) so both
// lib/subscription.js and lib/referrals.js can consult it without a
// require cycle.

const ENV_VAR = 'SUBSCRIPTION_EXEMPT_EMAILS';

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Parse the configured list: comma-separated, whitespace-tolerant,
// case-insensitive (everything is normalized before comparison).
function getConfiguredExemptEmails(env = process.env) {
  const raw = env && typeof env[ENV_VAR] === 'string' ? env[ENV_VAR] : '';
  if (!raw) return [];
  return [...new Set(raw.split(',').map(normalizeEmail).filter(Boolean))];
}

function ensureExemptionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_exemptions (
      email TEXT PRIMARY KEY,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Sync the env-configured addresses into the table so every state
  // lookup is a single keyed read. INSERT OR IGNORE: idempotent, and
  // rows added by hand (addExemption) are never clobbered.
  const insert = db.prepare(
    'INSERT OR IGNORE INTO subscription_exemptions (email, note) VALUES (?, ?)');
  for (const email of getConfiguredExemptEmails()) {
    insert.run(email, `Configured via ${ENV_VAR}`);
  }
}

function isExemptEmail(db, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (getConfiguredExemptEmails().includes(normalized)) return true;
  ensureExemptionSchema(db);
  const row = db.prepare('SELECT 1 FROM subscription_exemptions WHERE email=?')
    .get(normalized);
  return !!row;
}

function getUserEmail(db, userId) {
  try {
    const row = db.prepare('SELECT email FROM users WHERE id=?').get(Number(userId));
    return row ? normalizeEmail(row.email) : '';
  } catch (_) {
    return ''; // users table/email column unavailable — fail closed
  }
}

// The single exemption check used by the subscription-state layer and
// the referrals switch: is THIS account's registered email exempt?
function isExemptUser(db, userId) {
  const email = getUserEmail(db, userId);
  if (!email) return false;
  return isExemptEmail(db, email);
}

function addExemption(db, email, note = null) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  ensureExemptionSchema(db);
  db.prepare('INSERT OR REPLACE INTO subscription_exemptions (email, note) VALUES (?, ?)')
    .run(normalized, note);
  return true;
}

module.exports = {
  ENV_VAR,
  normalizeEmail,
  getConfiguredExemptEmails,
  ensureExemptionSchema,
  isExemptEmail,
  getUserEmail,
  isExemptUser,
  addExemption,
};
