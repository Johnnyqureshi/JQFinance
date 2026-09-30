'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTradeRecord, TRADE_FIELDS } = require('../lib/flipper/journal');

const EXPECTED_FIELDS = [
  'ticker', 'direction', 'entryPrice', 'wallType', 'wallPrice',
  'c1High', 'c1Low', 'c2High', 'c2Low',
  'stopPrice', 'targetPrice', 'positionSize',
  'entryTimestamp', 'exitTimestamp', 'exitPrice',
  'pnl', 'mfe', 'mae', 'entryReason', 'exitReason',
];

test('TRADE_FIELDS are exactly the SPEC §18 fields, in SPEC order', () => {
  assert.deepEqual([...TRADE_FIELDS], EXPECTED_FIELDS);
  assert.equal(TRADE_FIELDS.length, 20);
});

test('buildTradeRecord keeps supplied values under the exact SPEC field names', () => {
  const record = buildTradeRecord({
    ticker: 'AAPL',
    direction: 'long',
    entryPrice: 10.05,
    wallType: 'range_low',
    wallPrice: 9.98,
    c1High: 10.1,
    c1Low: 9.95,
    c2High: 10.12,
    c2Low: 9.99,
    stopPrice: 9.94,
    targetPrice: 10.5,
    positionSize: 100,
    entryTimestamp: 1759176600000,
    exitTimestamp: 1759180200000,
    exitPrice: 10.42,
    pnl: 37.0,
    mfe: 45.0,
    mae: -3.5,
    entryReason: 'Break above Candle 2 High',
    exitReason: 'Target: Range High',
  });
  assert.equal(record.ticker, 'AAPL');
  assert.equal(record.direction, 'long');
  assert.equal(record.entryPrice, 10.05);
  assert.equal(record.wallType, 'range_low');
  assert.equal(record.wallPrice, 9.98);
  assert.equal(record.c1High, 10.1);
  assert.equal(record.c1Low, 9.95);
  assert.equal(record.c2High, 10.12);
  assert.equal(record.c2Low, 9.99);
  assert.equal(record.stopPrice, 9.94);
  assert.equal(record.targetPrice, 10.5);
  assert.equal(record.positionSize, 100);
  assert.equal(record.entryTimestamp, 1759176600000);
  assert.equal(record.exitTimestamp, 1759180200000);
  assert.equal(record.exitPrice, 10.42);
  assert.equal(record.pnl, 37.0);
  assert.equal(record.mfe, 45.0);
  assert.equal(record.mae, -3.5);
  assert.equal(record.entryReason, 'Break above Candle 2 High');
  assert.equal(record.exitReason, 'Target: Range High');
  assert.deepEqual(Object.keys(record), EXPECTED_FIELDS, 'exactly the 20 SPEC fields, no extras');
});

test('buildTradeRecord fills missing optional fields with null and never throws', () => {
  const open = buildTradeRecord({ ticker: 'XYZ', direction: 'short', entryPrice: 8.5 });
  assert.equal(open.ticker, 'XYZ');
  assert.equal(open.direction, 'short');
  assert.equal(open.entryPrice, 8.5);
  assert.equal(open.exitTimestamp, null);
  assert.equal(open.exitPrice, null);
  assert.equal(open.pnl, null);
  assert.equal(open.exitReason, null);

  const empty = buildTradeRecord({});
  assert.deepEqual(Object.keys(empty), EXPECTED_FIELDS);
  for (const key of EXPECTED_FIELDS) assert.equal(empty[key], null);

  assert.doesNotThrow(() => buildTradeRecord());
  assert.doesNotThrow(() => buildTradeRecord(null));
  assert.doesNotThrow(() => buildTradeRecord(undefined));
  const fromNull = buildTradeRecord(null);
  for (const key of EXPECTED_FIELDS) assert.equal(fromNull[key], null);
});

test('buildTradeRecord does not mutate the input object', () => {
  const input = { ticker: 'AAPL', entryPrice: 10 };
  buildTradeRecord(input);
  assert.deepEqual(input, { ticker: 'AAPL', entryPrice: 10 });
});
