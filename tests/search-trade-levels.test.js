'use strict';

const assert = require('assert');
const { buildSearchTradeLevels } = require('../lib/search-trade-levels');

const base = {
  currentPrice: 100,
  levels: {
    atr: 2,
    support: [{ price: 96, label: 'Confirmed swing low' }],
    resistance: [{ price: 104, label: 'Confirmed swing high' }],
  },
  confluence: {
    available: true,
    dataQuality: { fresh: true, entryEligible: true, missingCriticalInputs: [] },
    levels: {
      criticalSupport: { price: 96, label: 'Confirmed swing low' },
      criticalResistance: { price: 104, label: 'Confirmed swing high' },
    },
    vwap: { value: 99, slope: 'RISING' },
    priceAction: { available: true },
  },
  fibonacci: {
    available: true,
    setup: 'BULLISH SWING HOLDING 61.8%',
    nearestSupport: { price: 96.2 },
    nearestResistance: { price: 104.1 },
  },
  smartMoney: {
    available: true,
    status: 'FRESH',
    nearest: {
      demand: { midpoint: 96.1, confidence: 'HIGH' },
      supply: { midpoint: 104.2, confidence: 'HIGH' },
    },
  },
  searchSignal: {
    signal: { stage: 'CONFIRMED' },
    newsImpact: { appliedDirection: 'BULLISH' },
  },
};

{
  const result = buildSearchTradeLevels(base);
  assert.strictEqual(result.status, 'VERIFIED');
  assert.strictEqual(result.buy.price, 96);
  assert.strictEqual(result.sell.price, 104);
  assert.strictEqual(result.buy.alignment, 'HIGH');
  assert.strictEqual(result.sell.alignment, 'HIGH');
  assert(result.considered.includes('Completed-bar price action'));
}

{
  const result = buildSearchTradeLevels({
    ...base,
    confluence: {
      ...base.confluence,
      levels: {
        criticalSupport: { price: 90, label: 'Alternative technical support' },
        criticalResistance: { price: 110, label: 'Alternative technical resistance' },
      },
    },
    fibonacci: {
      ...base.fibonacci,
      nearestSupport: { price: 90.1 },
      nearestResistance: { price: 109.9 },
    },
    smartMoney: {
      ...base.smartMoney,
      nearest: {
        demand: { midpoint: 90.2, confidence: 'HIGH' },
        supply: { midpoint: 109.8, confidence: 'HIGH' },
      },
    },
  });
  assert.strictEqual(result.buy.price, 96);
  assert.strictEqual(result.sell.price, 104);
}

{
  const result = buildSearchTradeLevels({
    ...base,
    confluence: { ...base.confluence, dataQuality: { ...base.confluence.dataQuality, fresh: false } },
  });
  assert.strictEqual(result.status, 'PROVISIONAL');
  assert.strictEqual(result.buy.price, 96);
  assert.strictEqual(result.sell.price, 104);
}

{
  const result = buildSearchTradeLevels({
    currentPrice: 100,
    levels: { support: [{ price: 96 }] },
    confluence: { available: true, dataQuality: { fresh: true } },
  });
  assert.strictEqual(result.status, 'WAITING');
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.buy.price, 96);
  assert.strictEqual(result.sell, null);
}

console.log('search trade level tests passed');