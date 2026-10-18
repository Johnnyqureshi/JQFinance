'use strict';

// Anti-AI-copy block (Johnny 2026-10-18): known AI-training / AI-scraper
// crawlers are refused at the edge, while every real user, search engine,
// and link-preview bot passes untouched. This is defense in depth behind
// /robots.txt (public/robots.txt carries the same list as Disallow rules
// plus the Content-Signal policy); it exists so the block also holds for
// crawlers that ignore robots.txt, until the same list is enforced at
// Cloudflare.
//
// Matching is deliberately dumb and conservative: a case-insensitive
// substring check of the request's User-Agent against the fixed token
// list below — no heuristics, no IP rules, no fingerprinting, no rate
// limiting. A token only lands on this list when it is a documented
// AI-crawler UA token that no real browser, search crawler, or social
// preview bot ever carries (Googlebot, Bingbot, facebookexternalhit,
// Twitterbot, LinkedInBot, Slackbot and all browser UAs pass).
//
// Platform-critical paths are EXEMPT regardless of User-Agent so health
// checks, the robots file itself, and Stripe's server-to-server webhook
// deliveries can never be blocked by this layer.

const AI_BOT_TOKENS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'anthropic-ai',
  'Claude-Web',
  'CCBot',
  'Google-Extended',
  'Meta-ExternalAgent',
  'Bytespider',
  'PerplexityBot',
  'Perplexity-User',
  'cohere-ai',
  'AI2Bot',
  'Diffbot',
  'ImagesiftBot',
  'Omigili',
  'YouBot',
  'MistralAI-User',
  'Amazonbot',
  'Applebot-Extended',
  'DuckAssistBot',
  'Timpibot',
  'Webzio-Extended',
  'ICC-Crawler',
  'PetalBot',
];

const AI_BOT_TOKENS_LOWER = AI_BOT_TOKENS.map(token => token.toLowerCase());

// Paths that always pass, whatever the User-Agent claims to be:
// liveness/readiness probes, the robots file, and Stripe's webhook
// (Stripe's deliveries are authenticated by signature in
// lib/stripe-webhook.js, never by User-Agent).
const EXEMPT_PATHS = new Set([
  '/readyz',
  '/healthz',
  '/robots.txt',
  '/api/stripe/webhook',
]);

function isAiBotUserAgent(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return false;
  const ua = userAgent.toLowerCase();
  return AI_BOT_TOKENS_LOWER.some(token => ua.includes(token));
}

function isExemptPath(path) {
  return EXEMPT_PATHS.has(path);
}

function createAiBotBlockMiddleware() {
  return function aiBotBlock(req, res, next) {
    if (isExemptPath(req.path)) return next();
    const userAgent = typeof req.get === 'function'
      ? req.get('user-agent')
      : (req.headers && req.headers['user-agent']);
    if (isAiBotUserAgent(userAgent)) {
      return res.status(403).type('text/plain').send('Forbidden\n');
    }
    return next();
  };
}

module.exports = {
  AI_BOT_TOKENS,
  EXEMPT_PATHS,
  isAiBotUserAgent,
  isExemptPath,
  createAiBotBlockMiddleware,
};
