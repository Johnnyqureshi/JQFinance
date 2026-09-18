const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOURCE_NAMES,
  buildAutomaticBotContext,
  consumeAutomaticBotContext,
} = require('../lib/automatic-bot-context');

const NOW = Date.parse('2026-09-18T16:00:00.000Z');

test('normalizes every shared source with deterministic freshness metadata', () => {
  const raw = Object.fromEntries(SOURCE_NAMES.map(name => [name, {
    data: { name }, asOf: NOW - 1000, maxAgeMs: 1000,
  }]));
  const context = buildAutomaticBotContext(raw, { now: NOW, generation: 'cycle-1' });
  assert.equal(context.version, 1);
  assert.equal(context.generation, 'cycle-1');
  assert.equal(context.freshness.complete, true);
  assert.equal(context.sources.news.fresh, true);
  assert.equal(context.sources.news.ageMs, 1000);
  assert.deepEqual(context.sources.news.data, { name: 'news' });
  assert.equal(context.strategyAuthority, 'advisory-only');
});

test('stale and missing values fail closed without leaking stale data', () => {
  const context = buildAutomaticBotContext({
    news: { data: { headline: 'old' }, asOf: NOW - 1001, maxAgeMs: 1000 },
    macro: { data: null, asOf: NOW, maxAgeMs: 1000 },
  }, { now: NOW });
  assert.equal(context.sources.news.status, 'stale');
  assert.equal(context.sources.news.data, null);
  assert.equal(context.sources.macro.status, 'unavailable');
  assert.equal(context.sources.macro.data, null);
  assert.ok(context.freshness.staleSources.includes('news'));
  assert.ok(context.freshness.missingSources.includes('macro'));
});

test('strategy policy controls fail-safe behavior without rewriting strategy rules', () => {
  const context = buildAutomaticBotContext({
    seasonality: { data: { bias: 'bearish', sizeMult: 0.5 }, asOf: NOW, maxAgeMs: 1000 },
  }, { now: NOW });
  const advisory = consumeAutomaticBotContext(context, { name: 'b2-advisory' });
  const strict = consumeAutomaticBotContext(context, { name: 'strict', requiredSources: ['macro'] });
  assert.equal(advisory.entryAllowed, true);
  assert.deepEqual(advisory.blockers, []);
  assert.equal(strict.entryAllowed, false);
  assert.equal(strict.blockers.length, 1);
  assert.equal(advisory.preservesStrategyRules, true);
  assert.equal(context.sources.seasonality.data.sizeMult, 0.5);
});