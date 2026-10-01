'use strict';

// ORB Bot — trade journal records. Pure builders, no I/O.
//
// buildTradeRecord assembles the trade object with EXACTLY the TRADE_FIELDS
// below, in field order. It takes a single params object; any field not
// supplied defaults to null (never undefined), so records have a stable
// shape. Extra keys are ignored. Timestamps are passed in by the caller
// (no Date.now() here).

const TRADE_FIELDS = Object.freeze([
  'direction',
  'entryTime',
  'symbol',
  'orHigh',
  'orLow',
  'orWidth',
  'vwap',
  'rvol',
  'atr',
  'regime',
  'score',
  'scoreBreakdown',
  'size',
  'entryPrice',
  'stopPrice',
  'targets',
  'riskDollars',
  'exitPrice',
  'pnl',
  'rMultiple',
  'entryReason',
  'exitReason',
  'rejectReasons',
  'newsPolicy',
  'createdAt',
  'closedAt',
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
