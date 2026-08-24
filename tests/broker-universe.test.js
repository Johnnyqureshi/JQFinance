'use strict';

const assert = require('assert');
const {
  buildTradableEquityCatalog,
  selectTradableEquityCandidates,
  selectCatalogRotation,
  resolveInverseSymbol,
  isLikelyCryptoSymbol,
  countOpenBuyEntries,
  calculateEntryCapacity,
  canReserveEntryUnits,
} = require('../lib/broker-universe');

const catalog = buildTradableEquityCatalog([
  { symbol: 'AAPL', status: 'active', tradable: true, asset_class: 'us_equity', name: 'Apple' },
  { symbol: 'SPY', status: 'active', tradable: true, asset_class: 'us_equity', name: 'SPDR S&P 500 ETF Trust' },
  { symbol: 'OLD', status: 'inactive', tradable: true, asset_class: 'us_equity' },
  { symbol: 'HALT', status: 'active', tradable: false, asset_class: 'us_equity' },
  { symbol: 'BTC/USD', status: 'active', tradable: true, asset_class: 'crypto' },
]);

assert.deepStrictEqual([...catalog.keys()], ['AAPL', 'SPY'], 'only active tradable US stocks/ETFs enter broker catalog');

const selection = selectTradableEquityCandidates(
  ['aapl', 'AAPL', 'SPY', 'BTC-USD', 'HALT', 'UNKNOWN'],
  catalog,
);
assert.deepStrictEqual(selection.symbols, ['AAPL', 'SPY'], 'candidate scan must only use broker-eligible equities');
assert.strictEqual(selection.rejected.duplicate, 1);
assert.strictEqual(selection.rejected.invalidOrCrypto, 1);
assert.strictEqual(selection.rejected.unavailableAtBroker, 2);

const rotationCatalog = new Map([
  ['AAPL', { symbol: 'AAPL' }],
  ['SPY', { symbol: 'SPY' }],
  ['ZETA', { symbol: 'ZETA' }],
]);
const firstCatalogBatch = selectCatalogRotation(rotationCatalog, {
  prioritySymbols: ['AAPL'], limit: 2, priorityLimit: 1, rotationLimit: 1, rotationOffset: 0,
});
const secondCatalogBatch = selectCatalogRotation(rotationCatalog, {
  // A changed market-mover list cannot change the stable catalog sequence.
  prioritySymbols: ['SPY'], limit: 2, priorityLimit: 1, rotationLimit: 1, rotationOffset: firstCatalogBatch.nextOffset,
});
const thirdCatalogBatch = selectCatalogRotation(rotationCatalog, {
  prioritySymbols: ['AAPL'], limit: 2, priorityLimit: 1, rotationLimit: 1, rotationOffset: secondCatalogBatch.nextOffset,
});
assert.deepStrictEqual(firstCatalogBatch.symbols, ['AAPL']);
assert.deepStrictEqual(secondCatalogBatch.symbols, ['SPY']);
assert.deepStrictEqual(thirdCatalogBatch.symbols, ['AAPL', 'ZETA'],
  'an active/tradable symbol absent from market movers and the curated list still reaches a later bot scan batch');

const capacityCatalog = new Map([
  ['AAPL', { symbol: 'AAPL' }],
  ['BRAVO', { symbol: 'BRAVO' }],
  ['CHARLIE', { symbol: 'CHARLIE' }],
  ['DELTA', { symbol: 'DELTA' }],
  ['ZETA', { symbol: 'ZETA' }],
]);
const filledDefaultBatch = selectCatalogRotation(capacityCatalog, {
  prioritySymbols: ['ZETA'], limit: 5, priorityLimit: 3, rotationOffset: 0,
});
assert.strictEqual(filledDefaultBatch.symbols.length, 5,
  'unused mover-priority slots must be filled by the stable catalog rotation');

const pmhFirstBatch = selectCatalogRotation(rotationCatalog, {
  prioritySymbols: ['AAPL'], limit: 25, priorityLimit: 13, rotationLimit: 1, rotationOffset: 0,
});
const pmhSecondBatch = selectCatalogRotation(rotationCatalog, {
  prioritySymbols: ['SPY'], limit: 25, priorityLimit: 13, rotationLimit: 1, rotationOffset: pmhFirstBatch.nextOffset,
});
const pmhThirdBatch = selectCatalogRotation(rotationCatalog, {
  prioritySymbols: ['AAPL'], limit: 25, priorityLimit: 13, rotationLimit: 1, rotationOffset: pmhSecondBatch.nextOffset,
});
assert.ok(pmhThirdBatch.symbols.includes('ZETA'),
  'the smaller PMH scan budget also reaches catalog-only symbols over its own rotation cycle');

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
  'manual, Momentum, and PMH buy entries share the same hard capacity',
);
assert.strictEqual(isLikelyCryptoSymbol('BTC-USD'), true, 'actual crypto pairs may bypass equity-hours checks');
assert.strictEqual(isLikelyCryptoSymbol('BRK-B'), false, 'a hyphen alone must never bypass fresh equity validation');
assert.strictEqual(isLikelyCryptoSymbol('USD'), false, 'the USD equity ETF must remain subject to fresh equity validation and market hours');
assert.strictEqual(
  canReserveEntryUnits(calculateEntryCapacity([{ symbol: 'AAPL' }], [], 2), 2),
  false,
  'PMH cannot submit its two protected buy lots when only one shared entry slot remains',
);
assert.strictEqual(
  canReserveEntryUnits(calculateEntryCapacity([], [], 2), 2),
  true,
  'PMH can reserve both protected lots only when both shared entry slots are available',
);

console.log('broker-universe tests passed');