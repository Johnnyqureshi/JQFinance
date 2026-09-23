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

const snapshotFixture = {
  price: 120,
  prevClose: 118,
  changePct: 1.7,
  volume: 3_000_000,
  avgVolume: 1_500_000,
};

const marketFixture = {
  spy: 0.8,
  qqq: 1.1,
  iwm: 0.2,
  sectorEtf: 'SMH',
  sectorChangePct: 1.4,
  etfActivity: [{ symbol: 'QQQ', label: 'Nasdaq 100', changePct: 1.1, volume: 2_000_000, averageVolume: 1_000_000 }],
};

const equity = buildMoneyFlowData({
  symbol: 'NVDA',
  assetType: 'EQUITY',
  instrumentType: 'STOCK',
  generatedAt: Date.parse('2026-09-23T15:00:00Z'),
  snapshot: snapshotFixture,
  indicators: { vwap: 118 },
  dailyBars: bars,
  market: marketFixture,
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
assert.equal(equity.instrumentType, 'STOCK');
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
    instrumentType: 'STOCK',
    snapshot: snapshotFixture,
    indicators: { vwap: 118 },
    dailyBars: bars,
    market: marketFixture,
  });
  assert.equal(symbolSnapshot.symbol, symbol);
  assert.equal(symbolSnapshot.assetType, 'EQUITY');
  assert.equal(symbolSnapshot.instrumentType, 'STOCK');
  assert.ok(symbolSnapshot.flowTrend['5D'].points.length > 0);
}

for (const symbol of ['SPY', 'QQQ', 'IWM', 'XLK', 'TQQQ', 'SQQQ']) {
  const etf = buildMoneyFlowData({
    symbol,
    assetType: 'EQUITY',
    instrumentType: 'ETF',
    snapshot: snapshotFixture,
    indicators: { vwap: 118 },
    dailyBars: bars,
    market: marketFixture,
  });
  assert.equal(etf.symbol, symbol);
  assert.equal(etf.instrumentType, 'ETF');
  assert.equal(etf.etfExposure.label, 'ETF Net Flow');
  assert.equal(etf.etfExposure.available, false);
  assert.equal(etf.positioning.status, 'DATA UNAVAILABLE');
  assert.ok(etf.flowTrend['20D'].available);
}

const crypto = buildMoneyFlowData({
  symbol: 'BTC-USD',
  assetType: 'CRYPTO',
  instrumentType: 'CRYPTO',
  snapshot: { price: 65_000, changePct: -2.1, volume: 2_000_000, avgVolume: 1_000_000 },
  indicators: { vwap: 65_500 },
  dailyBars: bars,
  market: {},
});

assert.equal(crypto.assetType, 'CRYPTO');
assert.equal(crypto.instrumentType, 'CRYPTO');
assert.equal(crypto.positioning.available, false);
assert.equal(crypto.liquidation.available, false);
assert.match(crypto.dataQuality.note, /venue-aggregated/i);
assert.match(crypto.disclaimer, /does not prove/i);

const unavailable = buildMoneyFlowData({
  symbol: 'GPRO',
  assetType: 'EQUITY',
  instrumentType: 'STOCK',
  snapshot: { price: 1.2 },
  dailyBars: bars.map(bar => ({ ...bar, v: null })),
  market: {},
});

assert.equal(unavailable.summary.score, null);
assert.equal(unavailable.summary.status, 'INSUFFICIENT DATA');
assert.equal(unavailable.participation.relativeVolume, null);
assert.equal(unavailable.flowTrend['5D'].available, false);

console.log('Money Flow tests passed');