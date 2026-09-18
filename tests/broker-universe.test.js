'use strict';

const assert = require('assert');
const {
  buildTradableEquityCatalog,
  resolveInverseSymbol,
  isLikelyCryptoSymbol,
  countOpenBuyEntries,
  calculateEntryCapacity,
  canReserveEntryUnits,
} = require('../lib/broker-universe');

const catalog = buildTradableEquityCatalog([
  // Alpaca's real /v2/assets response names this field `class`.
  { symbol: 'AAPL', status: 'active', tradable: true, class: 'us_equity', name: 'Apple' },
  { symbol: 'SPY', status: 'active', tradable: true, asset_class: 'us_equity', name: 'SPDR S&P 500 ETF Trust' },
  { symbol: 'OLD', status: 'inactive', tradable: true, asset_class: 'us_equity' },
  { symbol: 'HALT', status: 'active', tradable: false, asset_class: 'us_equity' },
  { symbol: 'BTC/USD', status: 'active', tradable: true, class: 'crypto' },
]);

assert.deepStrictEqual([...catalog.keys()], ['AAPL', 'SPY'], 'only active tradable US stocks/ETFs enter broker catalog');
assert.strictEqual(catalog.get('AAPL').assetClass, 'us_equity', 'real Alpaca asset responses using class are accepted');



assert.strictEqual(resolveInverseSymbol('SPY', { SPY: 'SH' }), 'SH');
assert.strictEqual(resolveInverseSymbol('NOT-MAPPED', { SPY: 'SH' }), null, 'unknown downside routes must never silently become SH');

const openOrders = [
  { side: 'buy', type: 'market' },
  { side: 'sell', type: 'stop' },
  { side: 'buy', order_class: 'oto' },
  { side: 'sell', order_class: 'bracket' },
];
assert.strictEqual(countOpenBuyEntries(openOrders), 2, 'every pending buy entry consumes a shared slot');
assert.deepStrictEqual(
  calculateEntryCapacity([{ symbol: 'AAPL' }], openOrders, 3),
  { held: 1, pendingEntries: 2, used: 3, available: 0 },
  'all pending manual buy entries count toward account capacity',
);
assert.strictEqual(isLikelyCryptoSymbol('BTC-USD'), true, 'actual crypto pairs may bypass equity-hours checks');
assert.strictEqual(isLikelyCryptoSymbol('BRK-B'), false, 'a hyphen alone must never bypass fresh equity validation');
assert.strictEqual(isLikelyCryptoSymbol('USD'), false, 'the USD equity ETF must remain subject to fresh equity validation and market hours');
assert.strictEqual(
  canReserveEntryUnits(calculateEntryCapacity([{ symbol: 'AAPL' }], [], 2), 2),
  false,
  'multiple units cannot be reserved when only one entry slot remains',
);
assert.strictEqual(
  canReserveEntryUnits(calculateEntryCapacity([], [], 2), 2),
  true,
  'multiple units require enough available entry slots',
);

console.log('broker-universe tests passed');