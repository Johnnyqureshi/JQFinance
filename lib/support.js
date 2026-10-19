'use strict';

// Contact / Support (Johnny 2026-10-19): a public /contact page with a
// support form, so customers — including people locked out of their
// accounts, who need support most — can always reach us.
//
// SYSTEM OF RECORD: every accepted submission is stored in the
// support_messages table (jqf.db) and surfaced to the owner in the
// "Support messages" section of his USERS page (lib/admin-users.js
// includes listSupportMessages in its owner-only payload). No mail
// dependency: if SUPPORT_NOTIFY_EMAIL is set in the app environment,
// each submission is ALSO forwarded there through the Resend transport
// (lib/email.js) as a notification — the database row is written first
// and a failed forward never loses the message.
//
// SPAM HYGIENE (public form, no login): a honeypot field real visitors
// never see or fill (bots do → the submission is accepted-looking and
// silently dropped), plus a light per-IP rate limit (5/hour) in the
// same in-memory style as server.js rateLimitAuth. Stored IPs are
// sha256 hashes, never raw addresses.

const crypto = require('node:crypto');
const path = require('node:path');
const { isValidEmail } = require('./email-verification');
const emailSender = require('./email');

const SUPPORT_EMAIL = 'support@qureshifinance.com';
const TOPICS = [
  'Account & login',
  'Billing & subscription',
  'Connecting a broker',
  'The trading bot',
  'Something else',
];
const NAME_MAX = 80;
const EMAIL_MAX = 254;
const MESSAGE_MAX = 4000;
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CONTACT_PAGE_PATH = path.join(__dirname, '..', 'public', 'contact.html');

function ensureSupportSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      topic TEXT NOT NULL,
      message TEXT NOT NULL,
      user_id INTEGER,
      ip_hash TEXT
    );
  `);
}

function hashIp(ip) {
  if (ip == null || ip === '') return null;
  return crypto.createHash('sha256').update(String(ip), 'utf8').digest('hex');
}

// Returns { ok: true, value } or { ok: false, error }. Caps and the
// topic whitelist are enforced here, server-side — the client form's
// own limits are convenience only.
function validateSubmission(body) {
  const b = body && typeof body === 'object' ? body : {};
  const clean = v => (typeof v === 'string' ? v.trim() : '');
  const name = clean(b.name);
  const email = clean(b.email);
  const topic = clean(b.topic);
  const message = clean(b.message);
  if (!name) return { ok: false, error: 'Please enter your name.' };
  if (name.length > NAME_MAX) {
    return { ok: false, error: `Name must be ${NAME_MAX} characters or fewer.` };
  }
  if (!email || email.length > EMAIL_MAX || !isValidEmail(email)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  if (!TOPICS.includes(topic)) return { ok: false, error: 'Please choose a topic.' };
  if (!message) return { ok: false, error: 'Please write a message.' };
  if (message.length > MESSAGE_MAX) {
    return { ok: false, error: `Message must be ${MESSAGE_MAX} characters or fewer.` };
  }
  return { ok: true, value: { name, email, topic, message } };
}

function storeSupportMessage(db, { name, email, topic, message, userId = null, ip = null }) {
  ensureSupportSchema(db);
  const info = db.prepare(`
    INSERT INTO support_messages (name, email, topic, message, user_id, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, email, topic, message, userId != null ? Number(userId) : null, hashIp(ip));
  return Number(info.lastInsertRowid);
}

// Owner inbox read (USERS page): newest first, capped — read-only in v1.
function listSupportMessages(db, limit = 50) {
  ensureSupportSchema(db);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare(`
    SELECT id, created_at, name, email, topic, message, user_id
    FROM support_messages ORDER BY id DESC LIMIT ?
  `).all(n).map(row => ({
    id: Number(row.id),
    at: row.created_at,
    name: row.name,
    email: row.email,
    topic: row.topic,
    message: row.message,
    userId: row.user_id != null ? Number(row.user_id) : null,
  }));
}

// Light per-IP limiter in the rateLimitAuth style (in-memory window
// map). The cleanup timer is unref'd so tests and short-lived processes
// are never held open by it.
function createSupportRateLimiter({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (now > entry.resetAt) hits.delete(key);
  }, windowMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    allow(ip) {
      const key = String(ip || 'unknown');
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= limit;
    },
  };
}

function mountSupport({
  app,
  db,
  getNotifyEmail,
  sendNotification,
  contactPagePath = CONTACT_PAGE_PATH,
} = {}) {
  ensureSupportSchema(db);
  const limiter = createSupportRateLimiter();
  const notifyTo = typeof getNotifyEmail === 'function'
    ? getNotifyEmail
    : () => process.env.SUPPORT_NOTIFY_EMAIL || null;
  const notify = typeof sendNotification === 'function'
    ? sendNotification
    : emailSender.sendSupportNotificationEmail;
  const routes = [];

  // Public page — deliberately OUTSIDE the login-gated SPA shell
  // (same pattern as /verify-email): a visitor who cannot sign in
  // still has to be able to reach support.
  app.get('/contact', (req, res) => res.sendFile(contactPagePath));
  routes.push('GET /contact');

  app.post('/api/support', async (req, res) => {
    const body = req.body || {};
    // Honeypot: the form carries a field real visitors never fill.
    // A filled honeypot reads as a bot — answer success, store nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return res.json({ ok: true });
    }
    const check = validateSubmission(body);
    if (!check.ok) return res.status(400).json({ error: check.error });
    // Only well-formed submissions spend rate-limit quota: a visitor
    // fixing typos is never locked out, while real message spam is
    // capped at 5/hour per IP.
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!limiter.allow(ip)) {
      return res.status(429).json({ error: 'Too many messages from this connection. Please try again later.' });
    }
    const userId = req.session && req.session.userId ? Number(req.session.userId) : null;
    try {
      storeSupportMessage(db, { ...check.value, userId, ip });
    } catch (error) {
      console.error('[Support] store failed:', error.message);
      return res.status(500).json({ error: 'Your message could not be saved. Please email us instead.' });
    }
    // Optional notification forward — never blocks or fails the
    // submission; the stored row above is the system of record.
    try {
      const to = notifyTo();
      if (to) await notify({ to, ...check.value });
    } catch (error) {
      console.error('[Support] notification forward failed:', error.message);
    }
    return res.json({ ok: true });
  });
  routes.push('POST /api/support');

  return { routes };
}

module.exports = {
  SUPPORT_EMAIL,
  TOPICS,
  NAME_MAX,
  EMAIL_MAX,
  MESSAGE_MAX,
  RATE_LIMIT,
  ensureSupportSchema,
  hashIp,
  validateSubmission,
  storeSupportMessage,
  listSupportMessages,
  createSupportRateLimiter,
  mountSupport,
};
