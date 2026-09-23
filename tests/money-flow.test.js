'use strict';

const assert = require('node:assert/strict');
const { buildMoneyFlowData } = require('../lib/money-flow');

const bars = Array.from({ length: 25 }, (_, index) => {
  const close = 100 + index * 0.8;
  return {
    t: `2026-08-${String(index + 1).padStart(2, '0')}`,
    o: close - 0.25,
    h: close + 0.7,
    l: close - 0.5,
    c: close,
    v: 1_000_000 + index * 10_000,
  };
});

const equity = buildMoneyFlowData({
  symbol: 'NVDA',
  assetType: 'EQUITY',
  generatedAt: Date.parse('2026-09-23T15:00:00Z'),
  snapshot: {
    price: 120,
    prevClose: 118,
    changePct: 1.7,
    volume: 3_000_000,
    avgVolume: 1_500_000,
  },
  indicators: { vwap: 118 },
  dailyBars: bars,
  market: {
    spy: 0.8,
    qqq: 1.1,
    iwm: 0.2,
    sectorEtf: 'SMH',
    sectorChangePct: 1.4,
    etfActivity: [{ symbol: 'QQQ', label: 'Nasdaq 100', changePct: 1.1, volume: 2_000_000, averageVolume: 1_000_000 }],
  },
  quoteSummary: {
    defaultKeyStatistics: {
      sharesShort: 10_000_000,
      sharesShortPriorMonth: 8_000_000,
      shortRatio: 1.8,
      shortPercentOfFloat: 0.025,
      dateShortInterest: 1_758_000_000,
    },
  },
});

assert.equal(equity.assetType, 'EQUITY');
assert.equal(equity.summary.status, 'STRONG INFLOW');
assert.equal(equity.participation.relativeVolume, 2);
assert.equal(equity.participation.confirmation, 'CONFIRMED');
assert.equal(equity.etfExposure.available, false);
assert.match(equity.etfExposure.reason, /net flow/i);
assert.equal(equity.positioning.available, true);
assert.equal(equity.positioning.metrics[0].direction, 'UP');
assert.equal(equity.flowTrend['5D'].available, true);
assert.equal(equity.flowTrend['20D'].points.length, 20);
assert.equal(equity.liquidation, null);

for (const symbol of ['GPRO', 'AAPL', 'TSLA']) {
  const symbolSnapshot = buildMoneyFlowData({
    symbol,
    assetType: 'EQUITY',
    snapshot: equity.snapshot,
    indicators: equity.indicators,
    dailyBars: bars,
    market: equity.market,
  });
  assert.equal(symbolSnapshot.symbol, symbol);
  assert.equal(symbolSnapshot.assetType, 'EQUITY');
  assert.ok(symbolSnapshot.flowTrend['5D'].points.length > 0);
}

const crypto = buildMoneyFlowData({
  symbol: 'BTC-USD',
  assetType: 'CRYPTO',
  snapshot: { price: 65_000, changePct: -2.1, volume: 2_000_000, avgVolume: 1_000_000 },
  indicators: { vwap: 65_500 },
  dailyBars: bars,
  market: {},
});

assert.equal(crypto.assetType, 'CRYPTO');
assert.equal(crypto.positioning.available, false);
assert.equal(crypto.liquidation.available, false);
assert.match(crypto.dataQuality.note, /venue-aggregated/i);
assert.match(crypto.disclaimer, /does not prove/i);

const unavailable = buildMoneyFlowData({
  symbol: 'GPRO',
  assetType: 'EQUITY',
  snapshot: { price: 1.2 },
  dailyBars: bars.map(bar => ({ ...bar, v: null })),
  market: {},
});

assert.equal(unavailable.summary.score, null);
assert.equal(unavailable.summary.status, 'INSUFFICIENT DATA');
assert.equal(unavailable.participation.relativeVolume, null);
assert.equal(unavailable.flowTrend['5D'].available, false);

console.log('Money Flow tests passed');