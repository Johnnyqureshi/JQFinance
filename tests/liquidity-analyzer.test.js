'use strict';
const assert = require('assert');
const { buildLiquidityAnalysis } = require('../lib/liquidity-analyzer');
const now = Date.parse('2026-08-25T15:00:00.000Z');
const quote = (extra = {}) => ({
  source: 'alpaca', price: 100, asOf: '2026-08-25T14:59:58.000Z',
  topOfBook: { bid: 99.9, bidSize: 200, ask: 100.1, askSize: 100, timestamp: '2026-08-25T14:59:58.000Z' },
  recentTrade: { price: 100.1, size: 40, timestamp: '2026-08-25T14:59:57.000Z' }, ...extra,
});
const technical = { vwap: 99, macd: { histogram: 1 } };
function test(name, fn) { fn(); console.log(`✓ ${name}`); }

test('valid Alpaca top-of-book is partial and transparent', () => {
  const r = buildLiquidityAnalysis({ quote: quote(), indicators: technical, relativeVolume: 1.8, now });
  assert.equal(r.available, true); assert.equal(r.partial, true); assert.equal(r.level2.available, false);
  assert.match(r.provider, /IEX/);
  assert.equal(r.topOfBook.bidSize, 200); assert.equal(r.recentTrade.size, 40);
  assert.ok(r.score.components.find(c => c.key === 'quoteImbalance'));
  assert.equal(r.score.components.find(c => c.key === 'executedTrade').available, false);
});
test('Yahoo never creates market depth or direction', () => {
  const r = buildLiquidityAnalysis({ quote: { source: 'yahoo', price: 100 }, indicators: technical, now });
  assert.equal(r.available, false); assert.equal(r.state, 'NEUTRAL_MIXED'); assert.equal(r.topOfBook, null);
});
for (const [name, change] of [
  ['missing sizes', { topOfBook: { bid: 99, ask: 100, timestamp: '2026-08-25T14:59:58.000Z' } }],
  ['zero sizes', { topOfBook: { bid: 99, bidSize: 0, ask: 100, askSize: 2, timestamp: '2026-08-25T14:59:58.000Z' } }],
  ['stale quote', { topOfBook: { bid: 99, bidSize: 2, ask: 100, askSize: 2, timestamp: '2026-08-25T14:50:00.000Z' } }],
  ['crossed quote', { topOfBook: { bid: 101, bidSize: 2, ask: 100, askSize: 2, timestamp: '2026-08-25T14:59:58.000Z' } }],
]) test(`fails closed for ${name}`, () => {
  const r = buildLiquidityAnalysis({ quote: quote(change), indicators: technical, now });
  assert.equal(r.available, false); assert.equal(r.state, 'NEUTRAL_MIXED');
});
test('rate-limit/unavailable boundary represented as no provider data', () => {
  const r = buildLiquidityAnalysis({ quote: null, now });
  assert.equal(r.status, 'UNAVAILABLE'); assert.match(r.warnings[0], /unavailable/i);
});
test('history is bounded and real snapshots only', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    at: new Date(now - (30 - i) * 30_000).toISOString(),
    bid: 99, ask: 100, bidSize: 1, askSize: 1, state: 'NEUTRAL_MIXED',
  }));
  const r = buildLiquidityAnalysis({ quote: quote(), history, now });
  assert.equal(r.history.length, 12); assert.equal(r.shift.available, true);
  assert.ok(r.history.every(point => point.state), 'direction history points must carry a state');
});
test('low relative volume is a reliability warning, not bearish direction', () => {
  const r = buildLiquidityAnalysis({ quote: quote(), indicators: {}, relativeVolume: 0.4, now });
  const volume = r.score.components.find(component => component.key === 'relativeVolume');
  assert.equal(volume.score, 0);
  assert.match(r.warnings.join(' '), /Low volume/i);
  assert.notEqual(r.state, 'BEARISH_PRESSURE');
});
test('quote-size shift names both sides truthfully when both shrink', () => {
  const history = [{
    at: new Date(now - 30_000).toISOString(),
    bid: 99.9, ask: 100.1, bidSize: 2_000, askSize: 2_000, state: 'NEUTRAL_MIXED',
  }];
  const r = buildLiquidityAnalysis({ quote: quote(), indicators: technical, history, now });
  assert.equal(r.shift.direction, 'BID_DOWN_ASK_DOWN');
  assert.equal(r.shift.bidLiquidityChangePct, -90);
  assert.equal(r.shift.askLiquidityChangePct, -95);
});
test('fresh quote midpoint replaces stale trade or bar fallback price', () => {
  const r = buildLiquidityAnalysis({
    quote: quote({
      price: 88,
      asOf: '2026-08-25T14:40:00.000Z',
      recentTrade: { price: 88, size: 10, timestamp: '2026-08-25T14:40:00.000Z' },
    }),
    indicators: technical,
    now,
  });
  assert.equal(r.available, true);
  assert.equal(r.currentPrice, 100);
  assert.equal(r.currentPriceSource, 'VALIDATED_QUOTE_MIDPOINT');
  assert.equal(r.recentTrade, null);
});
console.log('Liquidity analyzer tests passed');