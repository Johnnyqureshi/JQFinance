'use strict';

// Contact / Support (Johnny 2026-10-19): a public /contact page + form
// (POST /api/support) whose submissions land in support_messages and
// surface ONLY in the owner's USERS-page payload. Proven here over
// real HTTP through an Express app mounted exactly as server.js mounts
// lib/support.js, plus the admin payload/route composition from
// lib/admin-users.js. Fixtures only — no production accounts.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test, before, after } = require('node:test');
const express = require('express');
const Database = require('better-sqlite3');

const support = require('../lib/support');
const admin = require('../lib/admin-users');
const sub = require('../lib/subscription');
const refs = require('../lib/referrals');
const exemptions = require('../lib/subscription-exemptions');

const read = p => readFileSync(require.resolve(p), 'utf8');
const contactHtml = read('../public/contact.html');
const contactJs = read('../public/js/contact.js');
const html = read('../index.html');
const serverJs = read('../server.js');
const usersJs = read('../public/js/users.js');
const brokersJs = read('../public/js/brokers.js');

const VALID = {
  name: 'Jamie Visitor',
  email: 'jamie@example.test',
  topic: 'Connecting a broker',
  message: 'The connect form says my keys were rejected and I do not know why.',
};

// ── HTTP harness ───────────────────────────────────────────────────────

function buildApp({ notifyEmail = null, notifySpy = null } = {}) {
  const db = new Database(':memory:');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50kb' }));
  // Session stand-in: tests log in by sending x-test-user-id, mirroring
  // how server.js's session middleware populates req.session.userId.
  app.use((req, res, next) => {
    const uid = req.get('x-test-user-id');
    req.session = uid ? { userId: Number(uid) } : {};
    next();
  });
  support.mountSupport({
    app,
    db,
    getNotifyEmail: () => notifyEmail,
    sendNotification: notifySpy || (async () => ({ sent: true })),
  });
  return { app, db };
}

async function serve(app) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function post(base, body, headers = {}) {
  const res = await fetch(`${base}/api/support`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function rowCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM support_messages').get().n;
}

// ── The page ───────────────────────────────────────────────────────────

let main;
before(async () => { main = await serve(buildApp().app); });
after(() => main.server.close());

test('GET /contact serves 200 with the support address and the full form', async () => {
  const res = await fetch(`${main.base}/contact`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('support@qureshifinance.com'), 'support address shown');
  assert.ok(body.includes('mailto:support@qureshifinance.com'), 'address is a mailto link');
  assert.ok(body.includes('Contact us'), 'headline present');
  assert.ok(body.includes('Questions about your account, billing, or the bot'), 'intro line present');
  assert.ok(body.includes('We aim to reply within one business day'), 'reply aim stated, not promised');
  for (const field of ['id="ctcName"', 'id="ctcEmail"', 'id="ctcTopic"', 'id="ctcMessage"']) {
    assert.ok(body.includes(field), `form field ${field} present`);
  }
  for (const topic of support.TOPICS) {
    assert.ok(body.includes(topic.replace(/&/g, '&amp;')), `topic option "${topic}" present`);
  }
  assert.ok(body.includes('Your account email') && body.includes('What you were doing')
    && body.includes('What happened'), 'what-to-include list present');
  assert.ok(body.includes('Message received'), 'confirmation state present in the page');
});

test('the /contact surfaces carry no profit-promise language', () => {
  const surfaces = (contactHtml + '\n' + contactJs).toLowerCase();
  for (const bad of ['guaranteed', 'guarantee profit', 'risk-free']) {
    assert.ok(!surfaces.includes(bad), `must not contain "${bad}"`);
  }
});

// ── POST /api/support ──────────────────────────────────────────────────

test('valid POST stores exactly one row and returns success', async () => {
  const { app, db } = buildApp();
  const { server, base } = await serve(app);
  try {
    const res = await post(base, VALID);
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(rowCount(db), 1);
    const row = db.prepare('SELECT * FROM support_messages').get();
    assert.equal(row.name, VALID.name);
    assert.equal(row.email, VALID.email);
    assert.equal(row.topic, VALID.topic);
    assert.equal(row.message, VALID.message);
    assert.equal(row.user_id, null, 'anonymous submission has no user id');
    assert.ok(row.created_at, 'created_at stamped');
    assert.match(row.ip_hash, /^[a-f0-9]{64}$/, 'IP stored as a sha256 hash, never raw');
  } finally { server.close(); }
});

test('a signed-in submission records the account user id', async () => {
  const { app, db } = buildApp();
  const { server, base } = await serve(app);
  try {
    const res = await post(base, VALID, { 'x-test-user-id': '1000000042' });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT user_id FROM support_messages').get();
    assert.equal(row.user_id, 1000000042);
  } finally { server.close(); }
});

test('invalid POSTs return 400 and store nothing', async () => {
  const { app, db } = buildApp();
  const { server, base } = await serve(app);
  try {
    const cases = [
      ['missing name', { ...VALID, name: '' }],
      ['missing email', { ...VALID, email: '' }],
      ['malformed email', { ...VALID, email: 'not-an-email' }],
      ['missing topic', { ...VALID, topic: '' }],
      ['off-list topic', { ...VALID, topic: 'Free money please' }],
      ['missing message', { ...VALID, message: '   ' }],
      ['overlong name', { ...VALID, name: 'n'.repeat(support.NAME_MAX + 1) }],
      ['overlong message', { ...VALID, message: 'm'.repeat(support.MESSAGE_MAX + 1) }],
      ['non-string field', { ...VALID, name: 42 }],
    ];
    for (const [label, body] of cases) {
      const res = await post(base, body);
      assert.equal(res.status, 400, label);
      assert.ok(res.data.error, `${label}: an error message comes back`);
    }
    assert.equal(rowCount(db), 0, 'nothing was stored');
  } finally { server.close(); }
});

test('honeypot submission returns success but stores nothing', async () => {
  const { app, db } = buildApp();
  const { server, base } = await serve(app);
  try {
    const res = await post(base, { ...VALID, website: 'http://spam.example/' });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true, 'bots see a normal-looking success');
    assert.equal(rowCount(db), 0);
  } finally { server.close(); }
});

test('the per-IP rate limit trips after 5 submissions in the window', async () => {
  const { app, db } = buildApp();
  const { server, base } = await serve(app);
  try {
    for (let i = 0; i < support.RATE_LIMIT; i += 1) {
      const res = await post(base, VALID);
      assert.equal(res.status, 200, `submission ${i + 1} within the limit`);
    }
    const sixth = await post(base, VALID);
    assert.equal(sixth.status, 429, 'the 6th submission in the hour is refused');
    assert.equal(rowCount(db), support.RATE_LIMIT, 'the refused submission stored nothing');
  } finally { server.close(); }
});

test('mail forward: fires only when SUPPORT_NOTIFY_EMAIL is set, and never breaks the submission', async () => {
  const calls = [];
  const spy = async args => { calls.push(args); return { sent: true }; };
  const withNotify = buildApp({ notifyEmail: 'inbox@example.test', notifySpy: spy });
  const a = await serve(withNotify.app);
  try {
    const res = await post(a.base, VALID);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, 'forward sent once');
    assert.equal(calls[0].to, 'inbox@example.test');
    assert.equal(calls[0].message, VALID.message);
    assert.equal(rowCount(withNotify.db), 1, 'the row is stored regardless');
  } finally { a.server.close(); }

  const calls2 = [];
  const noNotify = buildApp({ notifyEmail: null, notifySpy: async args => { calls2.push(args); } });
  const b = await serve(noNotify.app);
  try {
    const res = await post(b.base, VALID);
    assert.equal(res.status, 200);
    assert.equal(calls2.length, 0, 'no forward when the env var is unset');
    assert.equal(rowCount(noNotify.db), 1);
  } finally { b.server.close(); }

  const failing = buildApp({
    notifyEmail: 'inbox@example.test',
    notifySpy: async () => { throw new Error('provider down'); },
  });
  const c = await serve(failing.app);
  try {
    const res = await post(c.base, VALID);
    assert.equal(res.status, 200, 'a failed forward never fails the submission');
    assert.equal(rowCount(failing.db), 1);
  } finally { c.server.close(); }
});

// ── Owner visibility (USERS page payload + route gate) ────────────────

function adminFixtureDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users(
    id INTEGER PRIMARY KEY, username TEXT, email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT)`);
  sub.ensureSubscriptionSchema(db);
  refs.ensureReferralSchema(db);
  exemptions.ensureExemptionSchema(db);
  db.prepare('INSERT INTO users(id, username, email, email_verified, created_at) VALUES (?,?,?,?,?)')
    .run(admin.OWNER_USER_ID, 'owner', 'owner@example.test', 1, '2026-09-25 09:00:00');
  db.prepare('INSERT INTO users(id, username, email, email_verified, created_at) VALUES (?,?,?,?,?)')
    .run(21, 'user21', 'user21@example.test', 1, '2026-10-16 10:00:00');
  support.storeSupportMessage(db, { ...VALID, userId: null, ip: '203.0.113.9' });
  support.storeSupportMessage(db, {
    name: 'Second Sender', email: 'second@example.test',
    topic: 'Something else', message: 'A newer message.', userId: 21, ip: '203.0.113.9',
  });
  return db;
}

test('owner payload carries support messages, newest first', () => {
  const db = adminFixtureDb();
  const payload = admin.buildAdminUsersPayload({ db, kiaanService: null });
  assert.equal(payload.supportMessages.length, 2);
  assert.equal(payload.supportMessages[0].name, 'Second Sender', 'newest first');
  assert.equal(payload.supportMessages[0].topic, 'Something else');
  assert.equal(payload.supportMessages[0].userId, 21);
  assert.equal(payload.supportMessages[1].message, VALID.message);
  assert.equal(payload.supportMessages[1].userId, null);
  assert.ok(payload.supportMessages[0].at, 'timestamp carried through');
});

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
    body: null, statusCode: 200, redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    type() { return this; },
    send(payload) { this.body = payload; return this; },
    redirect(url) { this.statusCode = 302; this.redirectedTo = url; return this; },
  };
}

test('support-messages API: owner gets the messages; non-owner and anonymous get 404 with no leak', async () => {
  const db = adminFixtureDb();
  const app = fakeApp();
  admin.mountAdminUsers({ app, db, kiaanService: null, getStripeSecretKey: () => null });
  const handler = app.handlers.get('GET /api/admin/users');
  assert.ok(handler, 'route mounted');

  const ownerRes = fakeRes();
  await handler({ session: { userId: admin.OWNER_USER_ID } }, ownerRes);
  assert.equal(ownerRes.statusCode, 200);
  assert.equal(ownerRes.body.supportMessages.length, 2);
  assert.equal(ownerRes.body.supportMessages[1].message, VALID.message);

  const otherRes = fakeRes();
  await handler({ session: { userId: 21 } }, otherRes);
  assert.equal(otherRes.statusCode, 404);
  assert.ok(!JSON.stringify(otherRes.body).includes('keys were rejected'), 'no message content leaks');
  assert.ok(!JSON.stringify(otherRes.body).includes('jamie@example.test'), 'no sender email leaks');

  const anonRes = fakeRes();
  await handler({}, anonRes);
  assert.equal(anonRes.statusCode, 404);
});

// ── Wiring pins ────────────────────────────────────────────────────────

test('wiring: server mounts support; footer, USERS section, and broker help link are in place', () => {
  assert.ok(serverJs.includes("require('./lib/support')"), 'server requires lib/support');
  assert.ok(serverJs.includes('mountSupport({ app, db })'), 'server mounts the support routes');
  assert.ok(html.includes('<footer class="site-footer">'), 'site footer rendered by the shell');
  assert.ok(html.includes('<a href="/contact">Contact</a>'), 'footer carries the Contact link');
  assert.ok(html.includes('support@qureshifinance.com'), 'footer shows the support address');
  assert.ok(html.includes('/public/css/contact.css?v=20261019a'), 'contact.css linked with a cache-busting tag');
  assert.ok(usersJs.includes('Support messages'), 'USERS page renders the support section');
  assert.ok(usersJs.includes('supportMessages'), 'USERS page reads the payload supportMessages');
  assert.ok(brokersJs.includes('href="/contact"'), 'brokers help area links to /contact');
  assert.ok(contactJs.includes("fetch('/api/support'"), 'contact form posts to the support API');
  assert.ok(contactHtml.includes('Message received — we\'ll get back to you'),
    'the confirmation state reads exactly as specified');
});
