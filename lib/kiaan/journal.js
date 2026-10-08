'use strict';

// Kiaan Bot — trade journal records. Pure builders, no I/O.
//
// buildTradeRecord assembles the trade object with EXACTLY the TRADE_FIELDS
// below, in field order (mirrors lib/orb/journal.js). Any field not supplied
// defaults to null (never undefined), so records have a stable shape. Extra
// keys are ignored. Timestamps are passed in by the caller (no Date.now()).

const TRADE_FIELDS = Object.freeze([
  'direction',
  'entryTime',
  'symbol',
  'regime',
  'regimeScore',
  'relStrength',
  'rvol',
  'atr',
  'orHigh',
  'orLow',
  'vwap',
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
