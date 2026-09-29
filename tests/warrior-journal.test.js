'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTradeRecord, buildRejection, TRADE_FIELDS } = require('../lib/warrior/journal');

test('buildTradeRecord returns every §31 field with a stable shape', () => {
  const r = buildTradeRecord({
    ticker: 'AAPL', enteredAt: 1727450000000, exitedAt: 1727453600000,
    patternName: 'BullFlag', regime: 'BULLISH', entryPrice: 100, stopPrice: 98,
    targetPrice: 104, shares: 62, exitReason: 'target', exitPrice: 104,
    pnl: 248, rMultiple: 2, mae: -0.5, mfe: 4.2, holdMinutes: 60,
    slippageCost: 1.5, commissionCost: 0.62, orderStatus: 'filled',
  });
  assert.deepEqual(Object.keys(r).sort(), [...TRADE_FIELDS].sort());
  for (const k of ['tradeId', 'ticker', 'date', 'enteredAt', 'exitedAt', 'pattern',
    'regime', 'entryPrice', 'stopPrice', 'targetPrice', 'shares', 'score',
    'indicators', 'entryReason', 'exitReason', 'exitPrice', 'pnl', 'rMultiple',
    'mae', 'mfe', 'holdMinutes', 'slippageCost', 'orderStatus']) {
    assert.ok(k in r, `missing ${k}`);
  }
  // Unset fields default to null, never undefined.
  assert.equal(r.spyTrend, null);
  assert.equal(r.sectorTrend, null);
  assert.ok(Object.values(r).every(v => v !== undefined));
});

test('buildTradeRecord derives a deterministic tradeId when omitted', () => {
  const a = buildTradeRecord({ ticker: 'aapl', enteredAt: 1727450000000 });
  const b = buildTradeRecord({ ticker: 'AAPL', enteredAt: 1727450000000 });
  assert.equal(a.tradeId, 'AAPL-1727450000000');
  assert.equal(a.tradeId, b.tradeId);
  const explicit = buildTradeRecord({ ticker: 'AAPL', enteredAt: 1, tradeId: 'custom-1' });
  assert.equal(explicit.tradeId, 'custom-1');
});

test('buildRejection explains the rejection — never a bare NO TRADE', () => {
  const r = buildRejection({
    symbol: 'TSLA', pattern: 'BullFlag', score: 6,
    reasons: ['score 6 below the 9 minimum', 'no valid pattern'],
    at: 1727450000000,
  });
  assert.equal(r.rejected, true);
  assert.equal(r.symbol, 'TSLA');
  assert.equal(r.pattern, 'BullFlag');
  assert.equal(r.score, 6);
  assert.deepEqual(r.reasons, ['score 6 below the 9 minimum', 'no valid pattern']);
  assert.equal(r.at, 1727450000000);
});

test('buildRejection without reasons still records an explanation', () => {
  const r = buildRejection({ symbol: 'TSLA' });
  assert.equal(r.rejected, true);
  assert.ok(r.reasons.length > 0);
});
