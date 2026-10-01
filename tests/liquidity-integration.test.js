'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { evaluateLiquidity, DEFAULT_LIQUIDITY_POLICY } = require('../lib/liquidity-policy');
const {
  evaluateYahooLiquidity, evaluateAlpacaLiquidity,
} = require('../lib/liquidity-providers');

const server = readFileSync(require.resolve('../server.js'), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Expected source section ${start}`);
  return source.slice(from, to);
}

test('scanner batch returns only shared-policy passes and full rejected rows', () => {
  const route = section(server, "app.post('/api/scanner-batch'", "// ── GET /api/signal/");
  assert.match(route, /evaluateYahooLiquidity\(quote/);
  assert.match(route, /results:\s*out\.filter\(row => row\.liquidity\.eligible\)/);
  assert.match(route, /rejected:\s*out\.filter\(row => !row\.liquidity\.eligible\)/);
  assert.match(route, /liquidityPolicy:\s*DEFAULT_LIQUIDITY_POLICY/);

  const rejected = {
    sym: 'THIN',
    price: 2,
    volume: 20_000,
    bid: 1.9,
    ask: 2.1,
  };
  rejected.liquidity = evaluateLiquidity({
    price: rejected.price, volume: rejected.volume, bid: rejected.bid, ask: rejected.ask,
  });
  assert.equal(rejected.liquidity.eligible, false);
  assert.ok(rejected.liquidity.codes.includes('LOW_SHARE_VOLUME'));
  assert.equal(rejected.sym, 'THIN');
});

test('catalyst ranking excludes liquidity rejects and exposes their evidence separately', () => {
  const enrich = section(server, 'async function bciEnrichMarkets', 'async function bciGeneratePayload');
  const generate = section(server, 'async function bciGeneratePayload', "app.get('/api/catalyst-intel'");
  assert.match(enrich, /if \(!liquidity\.eligible\) return \{ rejected: base \}/);
  assert.match(enrich, /marketBySymbol\.set\(result\.value\.symbol, result\.value\)/);
  assert.match(generate, /filter\(article => marketBySymbol\.has\(article\.symbol\)\)/);
  assert.match(generate, /liquidityRejected/);
  assert.match(generate, /liquidityPolicy:\s*DEFAULT_LIQUIDITY_POLICY/);

  const unavailable = evaluateLiquidity({});
  assert.equal(unavailable.eligible, false);
  assert.ok(unavailable.codes.includes('SHARE_VOLUME_UNAVAILABLE'));
  assert.ok(unavailable.codes.includes('SPREAD_UNAVAILABLE'));
});

test('liquidity evidence cannot suppress an EXIT and missing session volume blocks entry', () => {
  const missingVolume = evaluateLiquidity({
    price: 10, volume: undefined, bid: 9.99, ask: 10.01, changePct: -5,
  });
  assert.equal(missingVolume.eligible, false);
  assert.ok(missingVolume.codes.includes('SHARE_VOLUME_UNAVAILABLE'));
  assert.ok(missingVolume.codes.includes('DOLLAR_VOLUME_UNAVAILABLE'));

  const bearishStrategyResult = { eligible: false, signal: 'EXIT', crossover: 'BEARISH' };
  const integrated = bearishStrategyResult.signal === 'EXIT'
    || bearishStrategyResult.crossover === 'BEARISH'
    ? { ...bearishStrategyResult, liquidity: missingVolume }
    : { ...bearishStrategyResult, eligible: false, signal: 'WAIT', liquidity: missingVolume };
  assert.equal(integrated.signal, 'EXIT');
  assert.equal(integrated.crossover, 'BEARISH');
  assert.equal(integrated.liquidity.eligible, false);
});

test('Yahoo adapter rejects PRE/CLOSED, stale sessions, and current quotes without a real bid/ask timestamp', () => {
  const now = Date.parse('2026-09-14T15:00:00Z');
  const current = {
    regularMarketPrice: 10, regularMarketVolume: 500000,
    regularMarketChangePercent: 2, regularMarketTime: now / 1000,
    bid: 9.99, ask: 10.01,
  };
  const regular = evaluateYahooLiquidity(current, { now, marketState: 'REGULAR' });
  assert.equal(regular.eligible, false);
  assert.ok(regular.codes.includes('QUOTE_TIMESTAMP_UNAVAILABLE'));
  assert.ok(regular.codes.includes('SPREAD_UNAVAILABLE'));
  assert.equal(regular.evidence.volumeSessionDate, '2026-09-14');

  const priorSession = evaluateYahooLiquidity({
    ...current, regularMarketTime: Date.parse('2026-09-11T19:59:00Z') / 1000,
  }, { now, marketState: 'REGULAR' });
  assert.ok(priorSession.codes.includes('VOLUME_WRONG_SESSION'));
  assert.ok(priorSession.codes.includes('PRICE_WRONG_SESSION'));

  for (const [state, at] of [
    ['PRE', Date.parse('2026-09-14T12:00:00Z')],
    ['CLOSED', Date.parse('2026-09-14T22:00:00Z')],
  ]) {
    const result = evaluateYahooLiquidity({
      ...current, regularMarketTime: at / 1000,
    }, { now: at, marketState: state });
    assert.ok(result.codes.includes('SESSION_NOT_REGULAR'));
  }
});

test('Alpaca adapter rejects a prior-session daily bar even with a fresh quote', () => {
  const now = Date.parse('2026-09-14T15:00:00Z');
  const snapshot = {
    latestQuote: { bp: 9.99, ap: 10.01, t: new Date(now - 1000).toISOString() },
    latestTrade: { p: 10, t: new Date(now - 1000).toISOString() },
    dailyBar: { v: 1000000, t: '2026-09-11T04:00:00Z' },
    prevDailyBar: { c: 9.9, t: '2026-09-10T04:00:00Z' },
  };
  const result = evaluateAlpacaLiquidity(snapshot, {
    now, marketState: 'REGULAR',
  });
  assert.equal(result.eligible, false);
  assert.ok(result.codes.includes('VOLUME_WRONG_SESSION'));
  assert.equal(result.spreadStatus, 'available');

  snapshot.dailyBar.t = '2026-09-14T04:00:00Z';
  assert.equal(evaluateAlpacaLiquidity(snapshot, {
    now, marketState: 'REGULAR',
  }).eligible, true);
});