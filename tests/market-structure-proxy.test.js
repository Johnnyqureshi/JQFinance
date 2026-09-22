'use strict';

const assert = require('node:assert/strict');
const { buildMarketStructureProxy } = require('../lib/market-structure-proxy');

const dailyBars = Array.from({ length: 220 }, (_, index) => {
  const close = 400 + index * 0.35;
  const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
  return {
    t: date,
    o: close - 0.4,
    h: close + 1.2,
    l: close - 1,
    c: close,
    v: 1_000_000 + index * 1000,
  };
});

const proxy = buildMarketStructureProxy({
  symbol: 'SPY',
  nowMs: Date.parse('2026-09-22T15:00:00Z'),
  snapshot: {
    price: 477,
    prevClose: 476,
    open: 476.2,
    high: 478,
    low: 475.5,
    volume: 2_500_000,
    avgVolume: 1_000_000,
    changePct: 0.21,
  },
  indicators: {
    sma20: 470,
    sma50: 465,
    sma200: 440,
    vwap: 475,
    atr: 4.2,
  },
  dailyBars,
  levels: {
    support: [{ price: 472, label: 'Confirmed swing low', confirmations: 2 }],
    resistance: [{ price: 480, label: 'Prior-session high', confirmations: 2 }],
  },
});

assert.equal(proxy.available, true);
assert.equal(proxy.symbol, 'SPY');
assert.equal(proxy.trend.regime, 'BULLISH');
assert.equal(proxy.activity.state, 'HIGH');
assert.equal(proxy.activity.relativeVolume, 2.5);
assert.equal(proxy.activity.confirmation.state, 'CONFIRMED');
assert.equal(proxy.levels.nearestSupport.type, 'STRUCTURAL SUPPORT');
assert.equal(proxy.levels.nearestResistance.type, 'STRUCTURAL RESISTANCE');
assert.equal(proxy.conditions.breakout.state, 'WATCH');
assert.equal(proxy.conditions.breakdown.state, 'WATCH');
assert.equal(proxy.gamePlanInput.bias, 'BULLISH');
assert.match(proxy.disclaimer, /does not observe Level 2/);

const incomplete = buildMarketStructureProxy({
  symbol: 'SPY',
  snapshot: { price: 100, changePct: 0.5 },
  indicators: { vwap: null },
  dailyBars: dailyBars.slice(-8),
  levels: { support: [], resistance: [] },
});

assert.equal(incomplete.trend.regime, 'MIXED');
assert.equal(incomplete.gamePlanInput.status, 'PROVISIONAL');
assert.equal(incomplete.conditions.breakout.state, 'UNAVAILABLE');
assert.equal(incomplete.activity.confirmation.state, 'UNAVAILABLE');

console.log('Market structure proxy tests passed');