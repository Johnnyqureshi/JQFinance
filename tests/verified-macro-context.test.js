'use strict';
const assert = require('node:assert/strict');
const { buildVerifiedMacroContext: build, createMacroContextService } = require('../lib/verified-macro-context');
const now = Date.parse('2026-09-16T18:00:00Z');
const envelope = (data, asOf = '2026-09-15') => ({ status: 'available', source: 'Official fixture', url: 'https://example.gov', asOf, fetchedAt: new Date(now).toISOString(), data });
function fixture() {
  return {
    treasury: envelope({ twoYear: 4.5, tenYear: 3.9, thirtyYear: 4.4, previous: { asOf: '2026-09-14', twoYear: 4.5, tenYear: 3.8, thirtyYear: 4.3 } }),
    fed: envelope({ calendarVerifiedAt: new Date(now).toISOString(), events: [{ date: '2026-09-17', title: 'FOMC' }], policy: { lower: 4.25, upper: 4.5, asOf: '2026-08-01' } }, '2026-08-01'),
    inflation: envelope({ cpiYoY: 3.5, period: '2026-08' }, '2026-08-31'),
    employment: envelope({ unemploymentRate: 4.2, payrollChangeThousands: 100, period: '2026-08' }, '2026-08-31'),
  };
}
async function main() {
  const r = build(fixture(), now);
  assert.equal(r.score.value, 77);
  assert.equal(r.score.regime, 'elevated');
  assert.equal(r.inputs.treasury.data.curve2s10sBps, -60);
  assert.equal(r.inputs.treasury.data.curveChangeBps, 10);
  assert.equal(r.executionImpact, 'none');
  assert.equal(r.inputs.geopolitical.status, 'unavailable');
  assert.equal(r.score.components.reduce((n, c) => n + c.maxPoints, 0), 100);
  assert.equal(build({}, now).score.value, null);
  for (const key of Object.keys(fixture())) {
    const raw = fixture();
    delete raw[key];
    assert.equal(build(raw, now).score.value, null, `${key} partial provider must suppress score`);
    raw[key] = { ...fixture()[key], asOf: '2025-01-01' };
    const stale = build(raw, now);
    assert.equal(stale.inputs[key].status, 'stale');
    assert.equal(stale.inputs[key].data, null);
    assert.equal(stale.score.value, null);
    raw[key] = { ...fixture()[key], fetchedAt: '2026-09-15T01:00:00Z' };
    assert.equal(build(raw, now).score.value, null);
    raw[key] = { ...fixture()[key], asOf: '2026-09-20' };
    assert.equal(build(raw, now).inputs[key].status, 'unavailable');
  }
  let raw = fixture();
  raw.fed.asOf = null;
  raw.fed.data.policy = null;
  assert.equal(build(raw, now).inputs.fed.data.events.length, 1, 'verified calendar survives unavailable policy');
  assert.equal(build(raw, now).score.value, null);
  raw = fixture();
  raw.fed.data.calendarVerifiedAt = null;
  assert.equal(build(raw, now).inputs.fed.data.events.length, 0);
  assert.equal(build(raw, now).score.value, null);
  raw = fixture();
  raw.fed.data.policy.lower = 6;
  assert.equal(build(raw, now).score.value, null, 'contradictory target range');
  raw = fixture();
  raw.treasury.data.twoYear = null;
  assert.equal(build(raw, now).inputs.treasury.status, 'unavailable', 'null is not zero');
  raw = fixture();
  raw.treasury.data.previous.asOf = raw.treasury.asOf;
  assert.equal(build(raw, now).score.value, null, 'same date cannot masquerade as prior session');
  assert.equal(build(raw, now).inputs.treasury.status, 'available', 'current levels remain useful');
  raw = fixture();
  raw.employment.data.payrollChangeThousands = null;
  assert.equal(build(raw, now).score.value, null);
  raw = fixture();
  raw.fed.data.events = [];
  assert.equal(build(raw, now).score.value, null, 'no verified future event');
  raw = fixture();
  raw.employment.data.unemploymentRate = 5.5;
  raw.treasury.data.previous.tenYear = 4;
  const mixed = build(raw, now);
  assert.equal(mixed.score.contradictions.length, 2);
  assert.ok(mixed.score.value > 0, 'contradictory directions must not cancel risk');
  assert.equal(mixed.score.components.find(c => c.key === 'yieldChange').points, 0);
  assert.equal(build(fixture(), now + 5 * 86400000).inputs.treasury.status, 'stale');
  let clock = now;
  let calls = 0;
  const service = createMacroContextService({ clock: () => clock, loadProviders: async () => { calls++; return fixture(); } });
  await Promise.all([service(), service(), service()]);
  assert.equal(calls, 1, 'coalesce requests');
  clock += 60000;
  await service();
  assert.equal(calls, 1);
  clock += 300000;
  await service();
  assert.equal(calls, 2);
  const failure = createMacroContextService({ clock: () => now, loadProviders: async () => { throw new Error('offline'); } });
  assert.equal((await failure()).score.value, null);
  let fails = false;
  clock = now;
  const expires = createMacroContextService({ clock: () => clock, loadProviders: async () => {
    if (fails) throw new Error('offline');
    return fixture();
  } });
  assert.equal((await expires()).score.value, 77);
  fails = true;
  clock += 300001;
  assert.equal((await expires()).score.value, null, 'failed refresh cannot reuse stale success');
  console.log('Verified macro context: scoring, freshness, partial/conflicting evidence, failure and cache tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });