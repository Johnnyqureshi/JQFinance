/**
 * Deterministic checks for compatible long-side price-action recognition.
 */
'use strict';

const assert = require('assert');
const {
  evaluatePriceActionSetup,
  summarizePriceActionResult,
} = require('../lib/price-action-setups');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); failed++; }
}

function barsFrom(closes, volumes = []) {
  return closes.map((close, index) => {
    const previous = index ? closes[index - 1] : close - 0.1;
    const open = close >= previous ? close - 0.12 : close + 0.08;
    return { o: open, h: Math.max(open, close) + 0.04, l: Math.min(open, close) - 0.04, c: close, v: volumes[index] ?? 1_000, t: new Date(Date.now() - (closes.length - index) * 300_000).toISOString() };
  });
}
function base(closes, extra = {}) {
  return {
    symbol: 'TEST',
    bars: barsFrom(closes),
    price: closes.at(-1),
    vwap: 10.5,
    market: { trend: 'BULLISH' },
    relativeStrength: true,
    freshness: { fresh: true },
    ...extra,
  };
}

console.log('\nCompatible price-action setups\n');

test('research liquidity blocks an otherwise confirmed breakout before review', () => {
  const now = Date.parse('2026-09-14T15:00:00Z');
  const evidence = {
    now, marketState: 'REGULAR', priceTimestamp: now - 1000,
    volumeTimestamp: now - 1000, quoteTimestamp: now - 1000,
  };
  const closes = Array.from({ length: 20 }, (_, i) => 10 + i * 0.02).concat([10.55]);
  const bars = barsFrom(closes, Array(20).fill(1000).concat([2000]));
  const research = base(closes, { bars, liquidity: { ...evidence, volume: 100, bid: 10.54, ask: 10.56 } });
  const blocked = evaluatePriceActionSetup(research);
  assert.strictEqual(blocked.eligible, false);
  assert.strictEqual(blocked.setup, null);
  assert(blocked.noTradeReasons.some(reason => /dollar volume/.test(reason)));
  const missingSpread = evaluatePriceActionSetup({ ...research, liquidity: { ...evidence, volume: 1000000 } });
  assert.strictEqual(missingSpread.eligible, false);
  assert.strictEqual(missingSpread.evidence.liquidity.spreadStatus, 'unavailable');
  const eligible = evaluatePriceActionSetup({ ...research, liquidity: { ...evidence, volume: 1000000, bid: 10.54, ask: 10.56 } });
  assert.strictEqual(eligible.eligible, true);
  const pumpLike = evaluatePriceActionSetup({ ...research, liquidity: { ...evidence, volume: 100000, bid: 10.54, ask: 10.56, changePct: 30 } });
  assert.strictEqual(pumpLike.eligible, false);
  assert(pumpLike.noTradeReasons.some(reason => /Pump-like risk/.test(reason)));
});

test('recognizes a volume-backed long breakout', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 10 + i * 0.02).concat([10.55]);
  const volumes = Array(20).fill(1_000).concat([2_000]);
  const result = evaluatePriceActionSetup(base(closes, { bars: barsFrom(closes, volumes) }));
  assert.strictEqual(result.setup.type, 'BREAKOUT_CONTINUATION');
  assert.strictEqual(result.eligible, true);
  assert(result.invalidation < result.price || result.invalidation < closes.at(-1));
});

test('recognizes a failed-break reclaim instead of treating the dip as a breakout', () => {
  const closes = [10, 10.03, 10.06, 10.08, 10.1, 10.12, 10.14, 10.16, 10.18, 10.2,
    10.23, 10.25, 10.28, 10.3, 10.32, 10.34, 10.36, 10.38, 10.42, 10.15, 10.2, 10.55];
  const volumes = Array(21).fill(1_000).concat([1_600]);
  const result = evaluatePriceActionSetup(base(closes, { bars: barsFrom(closes, volumes), resistance: 10.45 }));
  assert.strictEqual(result.setup.type, 'FAILED_BREAK_RECLAIM');
  assert.strictEqual(result.eligible, true);
  assert(result.evidence.priorFailedBreak);
});

test('rejects an extended chase even when the last candle breaks higher', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 10 + i * 0.01).concat([10.7]);
  const volumes = Array(20).fill(1_000).concat([2_000]);
  const result = evaluatePriceActionSetup(base(closes, { bars: barsFrom(closes, volumes), vwap: 10.1 }));
  assert.strictEqual(result.eligible, false);
  assert(result.reasons.some(reason => /chase|extended/i.test(reason)));
});

test('fails closed for stale data and contradictory market context', () => {
  const closes = Array.from({ length: 21 }, (_, i) => 10 + i * 0.02);
  const stale = evaluatePriceActionSetup(base(closes, { freshness: { fresh: false } }));
  assert.strictEqual(stale.eligible, false);
  assert.strictEqual(stale.setupType, 'UNAVAILABLE');
  assert(stale.reasons.some(reason => /stale/i.test(reason)));
  const contradictory = evaluatePriceActionSetup(base(closes, {
    market: { trend: 'BEARISH' }, relativeStrength: false,
  }));
  assert.strictEqual(contradictory.eligible, false);
  assert(contradictory.reasons.some(reason => /bearish|underperforming/i.test(reason)));
});

test('fails closed when a final candle has a missing open', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 10 + i * 0.02).concat([10.55]);
  const volumes = Array(20).fill(1_000).concat([2_000]);
  const bars = barsFrom(closes, volumes);
  bars.at(-1).o = null;
  const result = evaluatePriceActionSetup(base(closes, { bars }));
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.setupType, 'UNAVAILABLE');
  assert(result.reasons.some(reason => /incomplete|malformed/i.test(reason)));
});

test('fails closed when historical volume is missing instead of treating it as zero', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 10 + i * 0.02).concat([10.55]);
  const volumes = Array(20).fill(1_000).concat([2_000]);
  const bars = barsFrom(closes, volumes);
  bars[5].v = null;
  const result = evaluatePriceActionSetup(base(closes, { bars }));
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.setupType, 'UNAVAILABLE');
  assert(result.reasons.some(reason => /incomplete|malformed/i.test(reason)));
});

test('never emits a short or inverse-ETF instruction', () => {
  const closes = Array.from({ length: 21 }, (_, i) => 12 - i * 0.05);
  const result = evaluatePriceActionSetup(base(closes));
  assert.strictEqual(result.direction, 'LONG_ONLY');
  assert(!JSON.stringify(result).toLowerCase().includes('short'));
  assert(!JSON.stringify(result).toLowerCase().includes('inverse'));
});

test('normalizes setup, invalidation, and no-trade reason for evidence reports', () => {
  const blocked = summarizePriceActionResult({
    strategy: 'smb-compatible-long-v1',
    direction: 'LONG_ONLY',
    status: 'SETUP CONFIRMED — WAIT',
    eligible: false,
    setup: { type: 'CONTROLLED_PULLBACK', label: 'Controlled pullback' },
    invalidation: 9.75,
    reasons: ['Relative strength is unavailable.'],
  });
  assert.strictEqual(blocked.setupType, 'CONTROLLED_PULLBACK');
  assert.strictEqual(blocked.invalidation, 9.75);
  assert.strictEqual(blocked.noTradeReason, 'Relative strength is unavailable.');
  assert.strictEqual(blocked.eligible, false);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);