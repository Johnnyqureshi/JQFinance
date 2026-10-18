'use strict';

// Anti-AI-copy block (Johnny 2026-10-18): known AI-training/scraper
// crawlers are disallowed in /robots.txt and refused (403) at the edge,
// with a HARD constraint of zero impact on real users — browsers,
// search engines, and social link previews must behave exactly as
// before, and platform paths (/readyz, /robots.txt, the Stripe
// webhook) stay reachable under any User-Agent.
//
// The middleware is exercised over real HTTP through a minimal Express
// app mounted exactly as server.js mounts it (globally, before routes),
// so the dispatch behavior proven here is the production behavior.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test, before, after } = require('node:test');
const express = require('express');

const block = require('../lib/ai-bot-block');
const read = p => readFileSync(require.resolve(p), 'utf8');
const serverSrc = read('../server.js');
const robotsTxt = read('../public/robots.txt');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BINGBOT_UA = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const FACEBOOK_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const TWITTERBOT_UA = 'Twitterbot/1.0';
const LINKEDIN_UA = 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)';
const SLACKBOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const APPLEBOT_SEARCH_UA = 'Mozilla/5.0 (compatible; Applebot/1.0; +http://www.apple.com/go/applebot)';

const HUMAN_UAS = [
  CHROME_UA, SAFARI_IOS_UA, FIREFOX_UA, GOOGLEBOT_UA, BINGBOT_UA,
  FACEBOOK_UA, TWITTERBOT_UA, LINKEDIN_UA, SLACKBOT_UA, APPLEBOT_SEARCH_UA,
];

const AI_UAS = [
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'Mozilla/5.0 (compatible; ClaudeBot/1.0; noreply@muse.dev)',
  'CCBot/2.0 (https://commoncrawl.org/faq/)',
  'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 Bytespider; spider-feedback@bytedance.com',
  'Mozilla/5.0 (compatible; Meta-ExternalAgent/1.1; +https://developers.facebook.com/docs/sharing/webmasters/web-crawlers)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 (compatible; ChatGPT-User/1.0)',
  'Mozilla/5.0 (compatible; Google-Extended/1.0)',
];

// ── Unit: the matcher ──────────────────────────────────────────────────

test('matcher: every listed token matches its crawler UA, case-insensitively', () => {
  for (const token of block.AI_BOT_TOKENS) {
    assert.equal(block.isAiBotUserAgent(`some-crawler ${token}/1.0`), true, token);
    assert.equal(block.isAiBotUserAgent(`some-crawler ${token.toLowerCase()}/1.0`), true, token);
  }
});

test('matcher: browsers, search engines, and preview bots never match', () => {
  for (const ua of HUMAN_UAS) {
    assert.equal(block.isAiBotUserAgent(ua), false, ua);
  }
  assert.equal(block.isAiBotUserAgent(''), false);
  assert.equal(block.isAiBotUserAgent(undefined), false);
  assert.equal(block.isAiBotUserAgent(null), false);
});

test('matcher: plain Applebot (search) passes — only Applebot-Extended is blocked', () => {
  assert.equal(block.isAiBotUserAgent(APPLEBOT_SEARCH_UA), false);
  assert.equal(block.isAiBotUserAgent('Mozilla/5.0 (compatible; Applebot-Extended/1.0)'), true);
});

// ── HTTP: production-shaped dispatch ───────────────────────────────────

let server;
let base;

before(async () => {
  const app = express();
  app.use(block.createAiBotBlockMiddleware());
  app.get('/', (_req, res) => res.status(200).type('text/plain').send('home'));
  app.get('/api/subscription/status', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/readyz', (_req, res) => res.status(200).json({ status: 'ready' }));
  app.get('/robots.txt', (_req, res) => res.status(200).type('text/plain').send(robotsTxt));
  app.post('/api/stripe/webhook', (_req, res) => res.status(200).json({ received: true }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => server.close(resolve)));

async function hit(path, ua, method = 'GET') {
  const res = await fetch(`${base}${path}`, { method, headers: { 'user-agent': ua } });
  return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() };
}

test('http: AI crawler UAs get 403 on / and on an API GET', async () => {
  for (const ua of AI_UAS) {
    assert.equal((await hit('/', ua)).status, 403, ua);
    assert.equal((await hit('/api/subscription/status', ua)).status, 403, ua);
  }
  const blocked = await hit('/', AI_UAS[0]);
  assert.match(blocked.type, /text\/plain/);
  assert.equal(blocked.body, 'Forbidden\n');
});

test('http: human, search, and preview UAs get normal responses everywhere', async () => {
  for (const ua of HUMAN_UAS) {
    assert.equal((await hit('/', ua)).status, 200, ua);
    assert.equal((await hit('/api/subscription/status', ua)).status, 200, ua);
  }
});

test('http: exempt paths stay reachable under an AI crawler UA', async () => {
  const ua = AI_UAS[0];
  assert.equal((await hit('/readyz', ua)).status, 200);
  assert.equal((await hit('/robots.txt', ua)).status, 200);
  assert.equal((await hit('/api/stripe/webhook', ua, 'POST')).status, 200);
});

test('http: robots.txt serves 200 text/plain with the policy', async () => {
  const res = await hit('/robots.txt', CHROME_UA);
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/plain/);
  assert.equal(res.body, robotsTxt);
});

// ── robots.txt contents ────────────────────────────────────────────────

test('robots.txt: default allow-all, AI group disallowed, signals stated', () => {
  assert.match(robotsTxt, /User-agent: \*\nAllow: \/\n/);
  assert.match(robotsTxt, /#\s+ai-train=no/);
  assert.match(robotsTxt, /#\s+ai-input=no/);
  assert.match(robotsTxt, /#\s+search=yes/);
  for (const token of block.AI_BOT_TOKENS) {
    assert.match(robotsTxt, new RegExp(`User-agent: ${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`), token);
  }
  assert.match(robotsTxt, /Disallow: \/\n/);
  assert.match(robotsTxt, /Sitemap: https:\/\/qureshifinance\.com\/sitemap\.xml/);
});

test('robots.txt: good bots are never in the disallow group', () => {
  const disallowGroup = robotsTxt.split('Disallow: /')[0].split('User-agent: *')[1] || '';
  for (const good of ['Googlebot', 'Bingbot', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot']) {
    assert.ok(!disallowGroup.includes(`User-agent: ${good}`), good);
  }
});

// ── server.js wiring ───────────────────────────────────────────────────

test('wiring: server mounts the block early, before static and the webhook', () => {
  assert.match(serverSrc, /require\('\.\/lib\/ai-bot-block'\)/);
  const mountedAt = serverSrc.indexOf('app.use(createAiBotBlockMiddleware())');
  assert.ok(mountedAt > -1, 'middleware mounted');
  assert.ok(mountedAt < serverSrc.indexOf('mountStripeWebhook({'), 'before webhook mount');
  assert.ok(mountedAt < serverSrc.indexOf('express.static'), 'before static');
  assert.ok(block.EXEMPT_PATHS.has('/api/stripe/webhook'));
  assert.ok(block.EXEMPT_PATHS.has('/readyz'));
  assert.ok(block.EXEMPT_PATHS.has('/robots.txt'));
});
