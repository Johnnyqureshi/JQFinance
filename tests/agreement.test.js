'use strict';

// Automated Trading Agreement & Risk Disclosure (Johnny 2026-10-19):
// mandatory server-side consent gate in front of agentic-trading
// ACTIVATION. Proven here:
//  - the canonical terms (9 sections, exact checkbox label) and the
//    sha256 of the stored snapshot;
//  - acceptance rows carry user id, version, timestamp and the
//    EXACT canonical text; accepting twice is idempotent; a stale
//    version never counts as consent;
//  - entitlement (who is even asked): active subscriber, fee-exempt,
//    or the pinned owner — free/founding users are not nagged;
//  - enforcement over real HTTP through mountKiaan exactly as
//    server.js wires it: enable without consent → 403
//    agreement_required and NO state change; with consent → 200;
//  - the safety rail: an already-enabled bot without consent is NOT
//    disabled, paused, or gated by any new path;
//  - the modal markup/CSS contract (scrollable terms region,
//    disabled-until-checked Agree button, theme variables only).
// Fixtures only — no production accounts, no network.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const express = require('express');
const Database = require('better-sqlite3');

const agreement = require('../lib/agreement');
const subscription = require('../lib/subscription');
const exemptions = require('../lib/subscription-exemptions');
const { createKiaanService, mountKiaan, KiaanError } = require('../lib/kiaan/service');
const { createCredentialVault } = require('../lib/credential-vault');

const read = p => readFileSync(require.resolve(p), 'utf8');
const html = read('../index.html');
const agreementCss = read('../public/css/agreement.css');
const agreementJs = read('../public/js/agreement.js');
const kiaanJs = read('../public/js/kiaan.js');
const serverJs = read('../server.js');

const OWNER = 1000000005;

// ── canonical terms ────────────────────────────────────────────────────

test('canonical terms: title, version, exactly the 9 specified sections, exact checkbox label', () => {
  assert.equal(agreement.AGREEMENT_TITLE, 'Automated Trading Agreement & Risk Disclosure');
  assert.equal(agreement.AGREEMENT_VERSION, '2026-10-19-v1');
  assert.equal(
    agreement.AGREEMENT_CHECKBOX_LABEL,
    'I have read and agree to the Automated Trading Agreement and understand the risks of AI-executed trades.',
  );
  assert.deepEqual(agreement.AGREEMENT_SECTIONS.map(s => s.heading), [
    'AUTOMATED TRADING AUTHORIZATION',
    'TRADING RISKS',
    'NO GUARANTEE OF PERFORMANCE',
    'BROKERAGE ACCOUNTS AND CUSTODY',
    'SUBSCRIPTION FEES',
    'SECURITY AND ACCESS',
    'TECHNICAL AND MARKET RISKS',
    'LEGAL RIGHTS AND LIMITATIONS',
    'ELECTRONIC CONSENT',
  ]);
  // Spot-pin the load-bearing sentences verbatim.
  const text = agreement.canonicalText();
  assert.ok(text.startsWith('Automated Trading Agreement & Risk Disclosure\n'));
  assert.ok(text.includes('partial or total loss of invested capital'), 'risk of total loss is stated');
  assert.ok(text.includes('does not guarantee profits'), 'no-guarantee clause present');
  assert.ok(text.includes('does not involve taking custody of my funds'), 'custody clause present');
  assert.ok(text.includes('does not waive rights that cannot legally be waived'), 'non-waiver clause present');
  // Deterministic: the module renders the same bytes every time.
  assert.equal(agreement.canonicalText(), text);
});

test('terms hash matches the stored snapshot hash', () => {
  const db = new Database(':memory:');
  const { acceptance } = agreement.recordAcceptance(db, 42, { ip: '203.0.113.7', userAgent: 'test-agent' });
  assert.equal(acceptance.terms_text, agreement.canonicalText(), 'stored text IS the canonical text');
  assert.equal(acceptance.terms_hash, agreement.termsHash(acceptance.terms_text), 'stored hash matches stored text');
  assert.match(acceptance.terms_hash, /^[0-9a-f]{64}$/);
});

// ── storage ────────────────────────────────────────────────────────────

test('acceptance records user id, version, timestamp, exact text; idempotent per version', () => {
  const db = new Database(':memory:');
  const first = agreement.recordAcceptance(db, 77, { ip: '198.51.100.2', userAgent: 'ua-one' });
  assert.equal(first.alreadyAccepted, false);
  assert.equal(first.acceptance.user_id, 77);
  assert.equal(first.acceptance.version, agreement.AGREEMENT_VERSION);
  assert.ok(first.acceptance.accepted_at, 'timestamp recorded');
  assert.ok(!Number.isNaN(Date.parse(first.acceptance.accepted_at)), 'timestamp is a real instant');
  assert.match(first.acceptance.ip_hash, /^[0-9a-f]{64}$/, 'ip stored hashed, never raw');
  assert.ok(!JSON.stringify(first.acceptance).includes('198.51.100.2'), 'raw ip never stored');
  assert.equal(first.acceptance.user_agent, 'ua-one');

  const second = agreement.recordAcceptance(db, 77, { ip: '198.51.100.9', userAgent: 'ua-two' });
  assert.equal(second.alreadyAccepted, true, 'second accept is a no-op');
  assert.equal(second.acceptance.accepted_at, first.acceptance.accepted_at, 'original timestamp preserved');
  const rows = db.prepare('SELECT * FROM agreement_acceptances WHERE user_id=77').all();
  assert.equal(rows.length, 1, 'exactly one row per user per version');
});

test('hasCurrentConsent: only a current-version row counts', () => {
  const db = new Database(':memory:');
  assert.equal(agreement.hasCurrentConsent(db, 5), false, 'no row → no consent');
  // A stale-version acceptance (hand-written, as a pre-bump row would be).
  db.prepare(`INSERT INTO agreement_acceptances (user_id, version, terms_text, terms_hash, accepted_at)
    VALUES (5, '2026-01-01-v0', 'old text', 'deadbeef', '2026-01-01T00:00:00.000Z')`).run();
  assert.equal(agreement.hasCurrentConsent(db, 5), false, 'stale version does NOT satisfy the gate');
  agreement.recordAcceptance(db, 5, {});
  assert.equal(agreement.hasCurrentConsent(db, 5), true, 'current version satisfies');
  assert.equal(agreement.hasCurrentConsent(db, 6), false, 'consent is per-user');
});

// ── entitlement / state ────────────────────────────────────────────────

function stateFixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT)');
  return db;
}

test('state: free and founding users are NOT required (unlock flow comes first)', () => {
  const db = stateFixture();
  const free = agreement.getAgreementState(db, 1001);
  assert.equal(free.entitled, false);
  assert.equal(free.required, false);
  assert.equal(free.accepted, false);
  subscription.recordFoundingSignup(db, 1002);
  const founding = agreement.getAgreementState(db, 1002);
  assert.equal(founding.entitled, false, 'founding-list is not an activation entitlement');
  assert.equal(founding.required, false);
});

test('state: active subscriber, fee-exempt user, and owner ARE required until they accept', () => {
  const db = stateFixture();
  subscription.markSubscribed(db, 2001, { customerId: 'cus_t', subscriptionId: 'sub_t', sessionId: 'cs_t' });
  assert.equal(agreement.getAgreementState(db, 2001).required, true, 'subscriber required');

  db.prepare('INSERT INTO users(id, email) VALUES (2002, ?)').run('nephew@example.test');
  exemptions.addExemption(db, 'nephew@example.test');
  const exemptState = agreement.getAgreementState(db, 2002);
  assert.equal(exemptState.entitled, true, 'exempt computes entitled');
  assert.equal(exemptState.required, true, 'exempt required until accepted');

  const ownerState = agreement.getAgreementState(db, OWNER);
  assert.equal(ownerState.entitled, true, 'owner entitled without any subscription');
  assert.equal(ownerState.required, true, 'owner is asked like everyone else (his running bot is unaffected — see rail test)');

  agreement.recordAcceptance(db, 2001, {});
  const after = agreement.getAgreementState(db, 2001);
  assert.equal(after.accepted, true);
  assert.equal(after.required, false, 'acceptance ends the requirement');
  assert.ok(after.acceptedAt);
  assert.equal(after.version, agreement.AGREEMENT_VERSION);
  assert.equal(after.sections.length, 9, 'state serves all 9 sections for the modal');
  assert.equal(after.checkboxLabel, agreement.AGREEMENT_CHECKBOX_LABEL);
});

// ── HTTP harness: agreement endpoints + the real K1 gate ──────────────

function buildGateApp() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT)');
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-987654321');
  const service = createKiaanService({
    db, vault,
    fetch: async () => { throw new Error('offline fixture'); },
    // Wired exactly as server.js wires production.
    hasAgreementConsent: uid => agreement.hasCurrentConsent(db, uid),
    agreementVersion: agreement.AGREEMENT_VERSION,
  });
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    const uid = req.get('x-test-user-id');
    req.session = uid ? { userId: Number(uid) } : {};
    next();
  });
  const requireAuth = (req, res, next) => (req.session?.userId
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));
  agreement.mountAgreement({ app, db, requireAuth });
  mountKiaan({ app, service, requireAuth, ensureSessionUserInTradingStore: async req => Number(req.session.userId) });
  return { app, db, service };
}

async function serve(app) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const asUser = uid => ({ 'Content-Type': 'application/json', 'x-test-user-id': String(uid) });

test('HTTP: agreement endpoints require auth (401 logged out)', async () => {
  const { app } = buildGateApp();
  const { server, base } = await serve(app);
  try {
    assert.equal((await fetch(`${base}/api/agreement/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/agreement/accept`, { method: 'POST' })).status, 401);
  } finally { server.close(); }
});

test('HTTP: enable without consent → 403 agreement_required, NO state change; after accept → enables', async () => {
  const { app, db } = buildGateApp();
  subscription.markSubscribed(db, 3001, { customerId: 'cus_t', subscriptionId: 'sub_t', sessionId: 'cs_t' });
  const { server, base } = await serve(app);
  try {
    // State endpoint: required, full terms payload.
    const stateRes = await fetch(`${base}/api/agreement/state`, { headers: asUser(3001) });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.required, true);
    assert.equal(state.sections.length, 9);
    assert.equal(state.checkboxLabel, agreement.AGREEMENT_CHECKBOX_LABEL);

    // The enable attempt is refused BEFORE any state change.
    const put = await fetch(`${base}/api/kiaan/settings`, {
      method: 'PUT', headers: asUser(3001), body: JSON.stringify({ enabled: true }),
    });
    assert.equal(put.status, 403, 'enable without consent is a 403');
    const putBody = await put.json();
    assert.equal(putBody.error, 'agreement_required');
    assert.equal(putBody.agreement.version, agreement.AGREEMENT_VERSION);
    const row = db.prepare('SELECT enabled FROM kiaan_settings WHERE user_id=3001').get();
    assert.ok(!row || Number(row.enabled) === 0, 'no state change: still disabled');

    // A stale-version assertion records nothing.
    const stale = await fetch(`${base}/api/agreement/accept`, {
      method: 'POST', headers: asUser(3001), body: JSON.stringify({ version: '1999-01-01-v0' }),
    });
    assert.equal(stale.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agreement_acceptances').get().n, 0, 'stale assertion stored nothing');

    // Accept (server-canonical text) then the same enable succeeds.
    const accept = await fetch(`${base}/api/agreement/accept`, {
      method: 'POST', headers: asUser(3001), body: JSON.stringify({ version: agreement.AGREEMENT_VERSION }),
    });
    assert.equal(accept.status, 200);
    const acceptBody = await accept.json();
    assert.equal(acceptBody.accepted, true);
    assert.equal(acceptBody.required, false);
    const stored = db.prepare('SELECT * FROM agreement_acceptances WHERE user_id=3001').get();
    assert.equal(stored.terms_text, agreement.canonicalText(), 'stored text is canonical');
    assert.equal(stored.terms_hash, agreement.termsHash());

    const put2 = await fetch(`${base}/api/kiaan/settings`, {
      method: 'PUT', headers: asUser(3001), body: JSON.stringify({ enabled: true }),
    });
    assert.equal(put2.status, 200, 'enable with consent succeeds');
    assert.equal(Number(db.prepare('SELECT enabled FROM kiaan_settings WHERE user_id=3001').get().enabled), 1);
  } finally { server.close(); }
});

test('HTTP: a rules-only save and a pause are never gated, even without consent', async () => {
  const { app, db } = buildGateApp();
  subscription.markSubscribed(db, 3002, { customerId: 'cus_t', subscriptionId: 'sub_t', sessionId: 'cs_t' });
  const { server, base } = await serve(app);
  try {
    const rulesOnly = await fetch(`${base}/api/kiaan/settings`, {
      method: 'PUT', headers: asUser(3002), body: JSON.stringify({ rules: { fixedDollars: 250 } }),
    });
    assert.equal(rulesOnly.status, 200, 'position-size save is not an activation');
    const pause = await fetch(`${base}/api/kiaan/settings`, {
      method: 'PUT', headers: asUser(3002), body: JSON.stringify({ enabled: false }),
    });
    assert.equal(pause.status, 200, 'pausing is never gated');
  } finally { server.close(); }
});

test('service: gate error is a KiaanError 403 agreement_required; ungated factory stays ungated', async () => {
  const db = new Database(':memory:');
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-987654321');
  const gated = createKiaanService({
    db, vault, fetch: async () => { throw new Error('offline fixture'); },
    hasAgreementConsent: () => false, agreementVersion: agreement.AGREEMENT_VERSION,
  });
  await assert.rejects(
    () => gated.setSettings(4001, { enabled: true }),
    err => err instanceof KiaanError && err.status === 403
      && err.message === 'agreement_required'
      && err.body?.agreement?.version === agreement.AGREEMENT_VERSION,
  );
  const otherDb = new Database(':memory:');
  const ungated = createKiaanService({
    db: otherDb, vault, fetch: async () => { throw new Error('offline fixture'); },
  });
  const view = await ungated.setSettings(4002, { enabled: true });
  assert.equal(view.enabled, true, 'fixtures without the probe keep the pre-gate behaviour');
});

test('SAFETY RAIL: an already-enabled bot without consent is never disabled, paused, or gated', async () => {
  const { app, db, service } = buildGateApp();
  // Simulate the owner's live bot: enabled BEFORE the gate existed,
  // no acceptance on file. Direct row write mirrors production state.
  await service.getSettings(OWNER);
  db.prepare('UPDATE kiaan_settings SET enabled=1, mode=? WHERE user_id=?').run('live', OWNER);
  assert.equal(agreement.hasCurrentConsent(db, OWNER), false, 'fixture premise: no consent on file');
  const { server, base } = await serve(app);
  try {
    // Re-saving settings while enabled (enabled:true, no transition) passes.
    const resave = await fetch(`${base}/api/kiaan/settings`, {
      method: 'PUT', headers: asUser(OWNER), body: JSON.stringify({ enabled: true, rules: { fixedDollars: 400 } }),
    });
    assert.equal(resave.status, 200, 'already-enabled re-save is not a gated transition');
    // A rules-only save passes.
    const rulesOnly = await fetch(`${base}/api/kiaan/settings`, {
      method: 'PUT', headers: asUser(OWNER), body: JSON.stringify({ rules: { fixedDollars: 401 } }),
    });
    assert.equal(rulesOnly.status, 200);
    // And nothing anywhere flipped the bot off.
    const after = await service.status(OWNER);
    assert.equal(after.enabled, true, 'still enabled after every gated-surface call');
    assert.equal(Number(db.prepare('SELECT enabled FROM kiaan_settings WHERE user_id=?').get(OWNER).enabled), 1);
  } finally { server.close(); }
});

// ── cancel path / modal contract ───────────────────────────────────────

test('reading state never records anything (the Cancel path is write-free)', async () => {
  const { app, db } = buildGateApp();
  subscription.markSubscribed(db, 5001, { customerId: 'cus_t', subscriptionId: 'sub_t', sessionId: 'cs_t' });
  const { server, base } = await serve(app);
  try {
    await fetch(`${base}/api/agreement/state`, { headers: asUser(5001) });
    await fetch(`${base}/api/agreement/state`, { headers: asUser(5001) });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agreement_acceptances').get().n, 0,
      'opening/closing the modal without Agree stores nothing');
  } finally { server.close(); }
});

test('modal markup: dialog, scrollable terms region, unchecked checkbox, disabled Agree, Cancel', () => {
  assert.ok(html.includes('id="agreementOverlay"'), 'overlay present');
  assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'), 'accessible dialog semantics');
  assert.ok(html.includes('id="agreementTerms"'), 'terms region present');
  assert.ok(html.includes('id="agreementCheckbox"'), 'checkbox present');
  assert.ok(!/id="agreementCheckbox"[^>]*checked/.test(html), 'checkbox ships UNCHECKED');
  assert.ok(/id="agreementAgree"[^>]*disabled/.test(html), 'Agree & Continue ships disabled');
  assert.ok(html.includes('id="agreementCancel"'), 'Cancel button present');
  assert.ok(html.includes(agreement.AGREEMENT_CHECKBOX_LABEL), 'exact checkbox label in the page');
  assert.ok(html.includes('/public/css/agreement.css?v=20261019a'), 'agreement css tag');
  assert.ok(html.includes('/js/agreement.js?v=20261019a'), 'agreement js tag');
  assert.ok(html.includes('/js/kiaan.js?v=20261019a'), 'kiaan.js tag bumped for the gate wiring');
});

test('modal CSS: scrollable terms + theme variables ONLY (no hardcoded palette, follows light/dark)', () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(agreementCss), 'agreement.css contains no hex colors at all');
  for (const token of ['var(--card)', 'var(--border)', 'var(--text)', 'var(--teal)']) {
    assert.ok(agreementCss.includes(token), `agreement.css uses ${token}`);
  }
  assert.ok(/\.agr-terms\s*\{[^}]*overflow-y:\s*auto/.test(agreementCss), 'terms region scrolls');
  assert.ok(/\.agr-modal\s*\{[^}]*max-height/.test(agreementCss), 'modal is height-capped (responsive)');
  assert.ok(agreementCss.includes('@media'), 'mobile breakpoint present');
});

test('client wiring: kiaan.js surfaces the modal on agreement_required; agreement.js records via the API only', () => {
  assert.ok(kiaanJs.includes("agreement_required"), 'kiaan.js recognises the refusal code');
  assert.ok(kiaanJs.includes('agreementGate.requireFor'), 'enable retries through the gate after acceptance');
  assert.ok(kiaanJs.includes('agreementGate?.checkOnLoad'), 'K1 page load offers the modal to entitled non-consenters');
  assert.ok(agreementJs.includes("'/api/agreement/state'"), 'client renders the server-served terms');
  assert.ok(agreementJs.includes("'/api/agreement/accept'"), 'acceptance posts to the server');
  const acceptCalls = agreementJs.match(/api\('\/api\/agreement\/accept'/g) || [];
  assert.equal(acceptCalls.length, 1, 'exactly one accept call site (the Agree button path — Cancel cannot record)');
  assert.ok(agreementJs.includes("e.key === 'Escape'"), 'Escape is wired (treated as Cancel)');
  assert.ok(serverJs.includes('mountAgreement({ app, db, requireAuth })'), 'server mounts the agreement endpoints');
  assert.ok(serverJs.includes('hasAgreementConsent'), 'server wires the consent probe into the K1 service');
});
