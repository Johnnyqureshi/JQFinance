'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMarketArticle, selectMarketAlerts } = require('../lib/market-alerts');

const nowMs = Date.parse('2026-09-01T18:00:00.000Z');

test('accepts a recent market-moving headline with a verifiable timestamp', () => {
  const alert = normalizeMarketArticle({
    title: 'Futures dip as bond yields hit highest levels in decades',
    description: 'Treasury yields climbed sharply in afternoon trading.',
    source: { name: 'Sherwood News' },
    url: 'https://example.com/markets',
    publishedAt: '2026-09-01T17:30:00.000Z',
  }, nowMs);

  assert.equal(alert.headline, 'Futures dip as bond yields hit highest levels in decades');
  assert.equal(alert.source, 'Sherwood News');
  assert.equal(alert.url, 'https://example.com/markets');
  assert.ok(alert.score >= 4);
});

test('rejects ordinary stock news and stale or undated articles', () => {
  assert.equal(normalizeMarketArticle({
    title: 'Company launches a new product',
    publishedAt: '2026-09-01T17:30:00.000Z',
  }, nowMs), null);
  assert.equal(normalizeMarketArticle({
    title: 'Stocks plunge after unexpected rate decision',
    publishedAt: '2026-08-31T17:30:00.000Z',
  }, nowMs), null);
  assert.equal(normalizeMarketArticle({
    title: 'Stocks plunge after unexpected rate decision',
  }, nowMs), null);
});

test('deduplicates headlines and limits the band to the newest high-impact items', () => {
  const alerts = selectMarketAlerts([
    { title: 'Markets rally after Fed decision', publishedAt: '2026-09-01T17:59:00.000Z' },
    { title: 'Markets rally after Fed decision', publishedAt: '2026-09-01T17:58:00.000Z' },
    { title: 'Oil prices plunge on demand fears', publishedAt: '2026-09-01T17:57:00.000Z' },
    { title: 'Treasury yields hit a record high', publishedAt: '2026-09-01T17:56:00.000Z' },
  ], { nowMs, limit: 2 });

  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].headline, 'Markets rally after Fed decision');
  assert.equal(alerts[1].headline, 'Oil prices plunge on demand fears');
});