'use strict';

// Flipper Bot — trade journal records. Pure builders, no I/O.
//
// buildTradeRecord assembles the trade object with EXACTLY the SPEC §18
// fields, in SPEC order. It takes a single params object; any field not
// supplied defaults to null (never undefined), so records have a stable
// shape. It never throws on missing data. Timestamps are passed in by the
// caller (no Date.now() here).

const TRADE_FIELDS = Object.freeze([
  'ticker',
  'direction',
  'entryPrice',
  'wallType',
  'wallPrice',
  'c1High',
  'c1Low',
  'c2High',
  'c2Low',
  'stopPrice',
  'targetPrice',
  'positionSize',
  'entryTimestamp',
  'exitTimestamp',
  'exitPrice',
  'pnl',
  'mfe',
  'mae',
  'entryReason',
  'exitReason',
]);

function buildTradeRecord(fields = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const record = {};
  for (const key of TRADE_FIELDS) {
    record[key] = Object.prototype.hasOwnProperty.call(f, key) ? f[key] : null;
  }
  return record;
}

module.exports = { buildTradeRecord, TRADE_FIELDS };
