'use strict';

// Outbound email abstraction for Qureshi Finance.
//
// If RESEND_API_KEY is set, verification mail is sent through the Resend HTTP
// API. Otherwise registration does NOT fail — a warning plus the verification
// link is written to the server console so the token flow still works
// end-to-end in development (fail-open for dev, never fail-closed on signup).
//
// Env:
//   RESEND_API_KEY  — enables real sending via Resend
//   EMAIL_FROM      — overrides the default sender
//   SITE_URL        — overrides the default site origin used in links

const DEFAULT_FROM = 'Kiaan <noreply@qureshifinance.com>';
const DEFAULT_SITE_URL = 'https://qureshifinance.com';

function isEmailConfigured() {
  return typeof process.env.RESEND_API_KEY === 'string' && process.env.RESEND_API_KEY.length > 0;
}

function emailFrom() {
  return process.env.EMAIL_FROM || DEFAULT_FROM;
}

function siteUrl() {
  return (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

function verificationLink(rawToken) {
  return `${siteUrl()}/verify-email?token=${encodeURIComponent(rawToken)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendVerificationEmail({ to, username, rawToken }) {
  const link = verificationLink(rawToken);
  const subject = 'Verify your Qureshi Finance account';
  const text =
`Hi ${username},

Welcome to Qureshi Finance. Please confirm your email address by clicking the link below:

${link}

This link expires in 24 hours and can only be used once. If you didn't create this account, you can safely ignore this email.

— Kiaan`;
  const html =
`<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">` +
`<h2 style="margin-bottom:8px">Verify your email</h2>` +
`<p>Hi ${escapeHtml(username)},</p>` +
`<p>Welcome to <strong>Qureshi Finance</strong>. Please confirm your email address:</p>` +
`<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#1dd6a3;color:#06281f;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold">Verify my account</a></p>` +
`<p style="font-size:13px;color:#666">This link expires in 24 hours and can only be used once.<br/>If you didn't create this account, you can safely ignore this email.</p>` +
`<p style="font-size:13px;color:#666">— Kiaan</p></div>`;

  if (!isEmailConfigured()) {
    console.warn('[Email] RESEND_API_KEY is not set — skipping real send. Verification link for', to, ':', link);
    return { sent: false, reason: 'email_not_configured', link };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: emailFrom(), to, subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Email] Resend send failed:', res.status, body.slice(0, 300));
    // Fail-open: registration must not break because the mail provider hiccuped.
    console.warn('[Email] Verification link for', to, ':', link);
    return { sent: false, reason: `resend_${res.status}`, link };
  }
  return { sent: true, link };
}

// Support-form forward (Johnny 2026-10-19): one Resend call to an
// arbitrary inbox (the address in SUPPORT_NOTIFY_EMAIL, read by the
// caller — never hardcoded here). Same fail-open contract as the
// verification sender: a mail-provider hiccup must never lose or break
// a support submission, which is why the caller stores it in the
// database first and treats this purely as a notification.
async function sendSupportNotificationEmail({ to, name, email, topic, message }) {
  const subject = `Support: ${topic} — ${name}`;
  const text =
`New support message via qureshifinance.com/contact

Name: ${name}
Email: ${email}
Topic: ${topic}

${message}`;
  const html =
`<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">` +
`<h2 style="margin-bottom:8px">New support message</h2>` +
`<p><strong>Name:</strong> ${escapeHtml(name)}<br/>` +
`<strong>Email:</strong> ${escapeHtml(email)}<br/>` +
`<strong>Topic:</strong> ${escapeHtml(topic)}</p>` +
`<p style="white-space:pre-wrap">${escapeHtml(message)}</p></div>`;

  if (!isEmailConfigured()) {
    console.warn('[Email] RESEND_API_KEY is not set — skipping support notification send to', to);
    return { sent: false, reason: 'email_not_configured' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: emailFrom(), to, reply_to: email, subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Email] Resend support notification failed:', res.status, body.slice(0, 300));
    return { sent: false, reason: `resend_${res.status}` };
  }
  return { sent: true };
}

module.exports = {
  isEmailConfigured,
  emailFrom,
  siteUrl,
  verificationLink,
  sendVerificationEmail,
  sendSupportNotificationEmail,
};
