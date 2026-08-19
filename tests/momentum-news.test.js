/**
 * Targeted unit tests for news-catalyst scoring and 24-hour article filtering.
 * Run with:  node tests/momentum-news.test.js
 *
 * No external dependencies — uses Node.js built-in assert only.
 */
'use strict';

const assert = require('assert');

// ── Helpers ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

// ── Inline port of calcScore from momentum.js ────────────────────────────────
// Mirrors MomentumScanner.calcScore() exactly so tests run in Node without a browser.
function calcScore(r, minScore = 0, hasCatalyst = false) {
  let score = 0;
  const reasons = [];
  const gain  = r.change ?? 0;
  const rvol  = r.relVol ?? 0;
  const price = r.price  ?? 0;

  if (gain >= 10) { score += 2; reasons.push('Strong momentum (+10%)'); }
  if (gain >= 20) { score += 1; reasons.push('Very strong momentum (+20%)'); }
  if (rvol >= 2)  { score += 1; reasons.push('Relative volume > 2×'); }
  if (rvol >= 5)  { score += 1; reasons.push('Relative volume > 5×'); }
  if (price >= 2 && price <= 20) { score += 1; reasons.push('Momentum price range ($2–$20)'); }
  if (hasCatalyst) { score += 1; reasons.push('News catalyst (24h)'); }

  return { score, reasons, qualified: score >= minScore };
}

// ── Inline port of getSignal from momentum.js ────────────────────────────────
function getSignal(score) {
  if (score >= 5) return 'STRONG BUY';
  if (score >= 3) return 'BUY';
  if (score >= 2) return 'WATCH';
  return 'AVOID';
}

// ── Inline port of 24-hour article filter from server.js ────────────────────
function filterArticles(rawArticles, cutoffMs) {
  return rawArticles.filter(a => {
    if (!a.title || a.title === '[Removed]') return false;
    if (a.publishedAt) {
      const pub = new Date(a.publishedAt).getTime();
      if (!isNaN(pub) && pub < cutoffMs) return false;
    }
    return true;
  });
}

// ── SECTION 1: Catalyst scoring ──────────────────────────────────────────────
console.log('\nSection 1 — calcScore() with/without catalyst\n');

test('Base stock (no catalyst) scores 5/7 — gain 10%, rvol 5×, price $8', () => {
  const r = { change: 15, relVol: 5.5, price: 8 };
  const { score, reasons } = calcScore(r, 0, false);
  assert.strictEqual(score, 5);
  assert(!reasons.includes('News catalyst (24h)'), 'catalyst reason should not be present');
});

test('Same stock with catalyst scores 6/7 and adds catalyst reason', () => {
  const r = { change: 15, relVol: 5.5, price: 8 };
  const { score, reasons } = calcScore(r, 0, true);
  assert.strictEqual(score, 6);
  assert(reasons.includes('News catalyst (24h)'));
});

test('Catalyst nudges BUY (score 4) → STRONG BUY (score 5)', () => {
  // gain ≥10% (+2), rvol ≥2× (+1), price ok (+1) = 4 without catalyst
  const r = { change: 12, relVol: 3, price: 10 };
  const withoutCatalyst = calcScore(r, 0, false);
  const withCatalyst    = calcScore(r, 0, true);
  assert.strictEqual(withoutCatalyst.score, 4);
  assert.strictEqual(withCatalyst.score, 5);
  assert.strictEqual(getSignal(withoutCatalyst.score), 'BUY');
  assert.strictEqual(getSignal(withCatalyst.score), 'STRONG BUY');
});

test('Catalyst nudges WATCH (score 2) → BUY (score 3)', () => {
  // gain < 10%, rvol ≥2× (+1), price ok (+1) = 2 without catalyst
  const r = { change: 5, relVol: 2.5, price: 7 };
  const withoutCatalyst = calcScore(r, 0, false);
  const withCatalyst    = calcScore(r, 0, true);
  assert.strictEqual(withoutCatalyst.score, 2);
  assert.strictEqual(withCatalyst.score, 3);
  assert.strictEqual(getSignal(withoutCatalyst.score), 'WATCH');
  assert.strictEqual(getSignal(withCatalyst.score), 'BUY');
});

test('Max score without catalyst is 6 (gain 20%, rvol 5×, price ok)', () => {
  const r = { change: 25, relVol: 6, price: 5 };
  const { score } = calcScore(r, 0, false);
  assert.strictEqual(score, 6);
});

test('Max score with catalyst is 7', () => {
  const r = { change: 25, relVol: 6, price: 5 };
  const { score } = calcScore(r, 0, true);
  assert.strictEqual(score, 7);
});

test('minScore qualification works with catalyst (score 5, minScore 5 → qualified)', () => {
  const r = { change: 12, relVol: 3, price: 10 }; // base score 4
  const { qualified } = calcScore(r, 5, true); // catalyst brings it to 5
  assert.strictEqual(qualified, true);
});

// ── SECTION 2: 24-hour article filtering ─────────────────────────────────────
console.log('\nSection 2 — 24-hour article filter\n');

const NOW = Date.now();
const CUTOFF = NOW - 24 * 60 * 60 * 1000;

test('Article published 1 hour ago passes the filter', () => {
  const articles = [{ title: 'Fresh news', publishedAt: new Date(NOW - 1 * 60 * 60 * 1000).toISOString() }];
  assert.strictEqual(filterArticles(articles, CUTOFF).length, 1);
});

test('Article published 23 hours ago passes the filter', () => {
  const articles = [{ title: 'Almost 24h news', publishedAt: new Date(NOW - 23 * 60 * 60 * 1000).toISOString() }];
  assert.strictEqual(filterArticles(articles, CUTOFF).length, 1);
});

test('Article published exactly 25 hours ago is rejected', () => {
  const articles = [{ title: 'Stale news', publishedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }];
  assert.strictEqual(filterArticles(articles, CUTOFF).length, 0);
});

test('Article published 48 hours ago is rejected', () => {
  const articles = [{ title: 'Old news', publishedAt: new Date(NOW - 48 * 60 * 60 * 1000).toISOString() }];
  assert.strictEqual(filterArticles(articles, CUTOFF).length, 0);
});

test('[Removed] articles are always rejected', () => {
  const articles = [{ title: '[Removed]', publishedAt: new Date(NOW - 1 * 60 * 60 * 1000).toISOString() }];
  assert.strictEqual(filterArticles(articles, CUTOFF).length, 0);
});

test('Null/missing title is rejected', () => {
  const articles = [{ title: null, publishedAt: new Date(NOW - 1 * 60 * 60 * 1000).toISOString() }];
  assert.strictEqual(filterArticles(articles, CUTOFF).length, 0);
});

test('Article with no publishedAt passes through (cannot verify age)', () => {
  const articles = [{ title: 'No date article', publishedAt: null }];
  assert.strictEqual(filterArticles(articles, CUTOFF).length, 1);
});

test('Mixed batch: only recent articles pass', () => {
  const articles = [
    { title: 'Fresh',  publishedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
    { title: 'Old',    publishedAt: new Date(NOW - 26 * 60 * 60 * 1000).toISOString() },
    { title: 'Recent', publishedAt: new Date(NOW - 12 * 60 * 60 * 1000).toISOString() },
  ];
  const result = filterArticles(articles, CUTOFF);
  assert.strictEqual(result.length, 2);
  assert(result.every(a => ['Fresh', 'Recent'].includes(a.title)));
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nSome tests failed.');
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
