'use strict';

// Automated Trading Agreement & Risk Disclosure (Johnny 2026-10-19):
// a mandatory consent gate in front of agentic-trading ACTIVATION.
//
// This module is the SINGLE source of truth for the agreement text.
// The client modal renders exactly what GET /api/agreement/state
// serves from here, and an acceptance row stores exactly what this
// module's canonicalText() produced at acceptance time (plus its
// sha256), so the displayed text IS the recorded text — a frontend
// checkbox alone is never treated as proof of consent.
//
// Enforcement is server-side: lib/kiaan/service.js refuses the
// disabled→enabled transition (setSettings) with 403
// agreement_required when the caller has no acceptance row for the
// CURRENT version. Bumping AGREEMENT_VERSION therefore re-requires
// consent from every activator. The gate fires ONLY on that
// transition — an already-enabled bot is never disabled, paused, or
// altered by this module, and nothing here touches the dispatch
// loop, reconciliation, position management, or EOD flatten.
//
// NOTE (per Johnny's own instruction): this agreement is a consent
// record, not a liability shield. It does not claim to eliminate
// liability or guarantee legal/regulatory compliance; section 8 of
// the terms says so in as many words. Legal review of the terms
// themselves remains an owner/attorney task.

const crypto = require('node:crypto');
const subscription = require('./subscription');

// v2 (2026-10-20): company rebranded Qureshi Finance → VixionBot
// (Johnny's order). The terms text itself names no company — the
// sections speak of "the platform" throughout — so the ONLY change
// in the canonical text is this version line; the bump marks the
// rebrand and re-requires consent under the new company name.
const AGREEMENT_VERSION = '2026-10-20-v2';
const AGREEMENT_TITLE = 'Automated Trading Agreement & Risk Disclosure';
const AGREEMENT_CHECKBOX_LABEL =
  'I have read and agree to the Automated Trading Agreement and understand the risks of AI-executed trades.';

// The terms, verbatim (Johnny 2026-10-19). Headings and bodies are
// stored/rendered from this one list — edit them ONLY together with
// an AGREEMENT_VERSION bump, or existing acceptances would silently
// cover text their signers never saw.
const AGREEMENT_SECTIONS = [
  {
    heading: 'AUTOMATED TRADING AUTHORIZATION',
    body: 'I authorize the platform, subject to the permissions I grant, to connect to my designated brokerage account through an authorized API and submit, modify, or cancel trades using its automated trading functionality.',
  },
  {
    heading: 'TRADING RISKS',
    body: 'I understand that trading involves risk, including partial or total loss of invested capital. AI-generated decisions may be incorrect or delayed and may be affected by market volatility, technical failures, data errors, or unexpected market conditions.',
  },
  {
    heading: 'NO GUARANTEE OF PERFORMANCE',
    body: 'The platform does not guarantee profits, returns, execution prices, or successful trade execution. Past performance does not guarantee future results.',
  },
  {
    heading: 'BROKERAGE ACCOUNTS AND CUSTODY',
    body: 'My assets remain in my brokerage account. The platform’s stated operating model does not involve taking custody of my funds. Brokerage rules, API permissions, and applicable law govern account access and trade execution.',
  },
  {
    heading: 'SUBSCRIPTION FEES',
    body: 'I agree to the subscription price and billing frequency disclosed at checkout. Subscription fees do not guarantee profits or successful trades.',
  },
  {
    heading: 'SECURITY AND ACCESS',
    body: 'I am responsible for securing my brokerage account and reviewing API permissions. I may revoke platform access through the available controls and applicable brokerage procedures.',
  },
  {
    heading: 'TECHNICAL AND MARKET RISKS',
    body: 'I understand that internet outages, API failures, market closures, order rejections, slippage, and software errors may affect trading. I should not assume that the platform will always operate without interruption.',
  },
  {
    heading: 'LEGAL RIGHTS AND LIMITATIONS',
    body: 'This agreement does not waive rights that cannot legally be waived, excuse unlawful conduct, or guarantee that the platform is exempt from registration or other regulatory requirements. Applicable terms, disclosures, and required regulatory documents remain in effect.',
  },
  {
    heading: 'ELECTRONIC CONSENT',
    body: 'By checking the agreement checkbox and clicking “Agree & Continue,” I acknowledge that I have read and agreed to these terms and understand the risks of automated AI trading.',
  },
];

// Deterministic plain-text rendering of the agreement — this exact
// string is what gets stored (and hashed) in an acceptance row.
function canonicalText(version = AGREEMENT_VERSION) {
  const parts = [AGREEMENT_TITLE, `Version: ${version}`, ''];
  AGREEMENT_SECTIONS.forEach((section, i) => {
    parts.push(`${i + 1}. ${section.heading}`, section.body, '');
  });
  return parts.join('\n').trimEnd() + '\n';
}

function termsHash(text = canonicalText()) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function ensureAgreementSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agreement_acceptances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      version TEXT NOT NULL,
      terms_text TEXT NOT NULL,
      terms_hash TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      ip_hash TEXT,
      user_agent TEXT,
      UNIQUE(user_id, version)
    );
  `);
}

function hashIp(ip) {
  if (ip == null || ip === '') return null;
  return crypto.createHash('sha256').update(String(ip), 'utf8').digest('hex');
}

function getAcceptance(db, userId, version = AGREEMENT_VERSION) {
  ensureAgreementSchema(db);
  return db.prepare('SELECT * FROM agreement_acceptances WHERE user_id=? AND version=?')
    .get(Number(userId), version) || null;
}

// "Current consent" = an acceptance row for the CURRENT version.
// Older-version rows are history, never consent.
function hasCurrentConsent(db, userId) {
  return !!getAcceptance(db, userId, AGREEMENT_VERSION);
}

// Idempotent: a second accept for the same version returns the
// existing row untouched (original timestamp/text preserved).
function recordAcceptance(db, userId, { ip = null, userAgent = null } = {}) {
  ensureAgreementSchema(db);
  const uid = Number(userId);
  const text = canonicalText();
  const acceptedAt = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO agreement_acceptances
      (user_id, version, terms_text, terms_hash, accepted_at, ip_hash, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, version) DO NOTHING
  `).run(uid, AGREEMENT_VERSION, text, termsHash(text), acceptedAt,
    hashIp(ip), userAgent ? String(userAgent).slice(0, 512) : null);
  return {
    acceptance: getAcceptance(db, uid),
    alreadyAccepted: info.changes === 0,
  };
}

// Who may activate at all (their unlock flow comes first for everyone
// else): an active subscription (fee-exempt accounts compute active
// in the subscription layer) or the pinned owner account (Johnny
// 2026-10-16: owner access never depends on subscription state).
function isEntitledToActivate(db, userId) {
  if (subscription.isOwnerUser(userId)) return true;
  return !!subscription.getPopupState(db, userId).subscribed;
}

function getAgreementState(db, userId, opts = {}) {
  const entitled = opts.entitled !== undefined
    ? !!opts.entitled
    : isEntitledToActivate(db, userId);
  const acceptance = getAcceptance(db, userId);
  return {
    version: AGREEMENT_VERSION,
    title: AGREEMENT_TITLE,
    sections: AGREEMENT_SECTIONS.map((s, i) => ({ n: i + 1, heading: s.heading, body: s.body })),
    checkboxLabel: AGREEMENT_CHECKBOX_LABEL,
    entitled,
    accepted: !!acceptance,
    acceptedAt: acceptance ? acceptance.accepted_at : null,
    // The popup is owed exactly by users who could activate but have
    // not consented to the current version. Everyone else is never
    // nagged (free/founding users meet their unlock flow first).
    required: entitled && !acceptance,
  };
}

function mountAgreement({ app, db, requireAuth }) {
  if (!app || !db || typeof requireAuth !== 'function') {
    throw new Error('Agreement requires an app, a database and requireAuth.');
  }
  ensureAgreementSchema(db);
  const routes = [];

  app.get('/api/agreement/state', requireAuth, (req, res) => {
    res.json({ ok: true, ...getAgreementState(db, req.session.userId) });
  });
  routes.push('GET /api/agreement/state');

  app.post('/api/agreement/accept', requireAuth, (req, res) => {
    const userId = req.session.userId;
    // The row is always written from the SERVER's canonical text. A
    // client may assert the version it was shown; a stale assertion
    // records NOTHING and returns the current state so the UI
    // re-renders the current terms for a fresh, informed consent.
    const asserted = req.body && typeof req.body.version === 'string'
      ? req.body.version : null;
    if (asserted && asserted !== AGREEMENT_VERSION) {
      return res.status(409).json({
        ok: false,
        error: 'agreement_version_changed',
        ...getAgreementState(db, userId),
      });
    }
    const { acceptance, alreadyAccepted } = recordAcceptance(db, userId, {
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : null,
    });
    return res.json({
      ok: true,
      ...getAgreementState(db, userId),
      acceptance: {
        version: acceptance.version,
        acceptedAt: acceptance.accepted_at,
        termsHash: acceptance.terms_hash,
      },
      alreadyAccepted,
    });
  });
  routes.push('POST /api/agreement/accept');

  return { routes };
}

module.exports = {
  AGREEMENT_VERSION,
  AGREEMENT_TITLE,
  AGREEMENT_SECTIONS,
  AGREEMENT_CHECKBOX_LABEL,
  canonicalText,
  termsHash,
  ensureAgreementSchema,
  getAcceptance,
  hasCurrentConsent,
  recordAcceptance,
  isEntitledToActivate,
  getAgreementState,
  mountAgreement,
};
