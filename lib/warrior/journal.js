'use strict';

// Warrior Bot — trade journal records. Pure builders, no I/O.
//
// buildTradeRecord assembles the full §31 trade object. Any field not
// supplied defaults to null (never undefined), so records have a stable
// shape. tradeId defaults to `${ticker}-${enteredAt}` (deterministic).
//
// buildRejection explains a rejected setup — never a bare "NO TRADE".

const TRADE_FIELDS = Object.freeze([
  'tradeId', 'ticker', 'date', 'enteredAt', 'exitedAt',
  'pattern', 'patternName', 'patternScore', 'patternConfidence',
  'regime', 'spyTrend', 'qqqTrend', 'sectorTrend',
  'entryPrice', 'stopPrice', 'targetPrice', 'shares', 'notional',
  'score', 'scoreBreakdown', 'indicators', 'dayChangePct',
  'entryReason', 'exitReason', 'exitPrice',
  'pnl', 'pnlPct', 'rMultiple', 'mae', 'mfe', 'maeR', 'mfeR',
  'holdMinutes', 'slippageCost', 'commissionCost', 'orderStatus',
  'riskReward', 'entryTime', 'exitTime',
]);

function buildTradeRecord(fields = {}) {
  const f = { ...fields };
  const record = {};
  for (const key of TRADE_FIELDS) record[key] = key in f ? f[key] : null;
  if (!record.tradeId && record.ticker && record.enteredAt !== null && record.enteredAt !== undefined) {
    record.tradeId = `${String(record.ticker).toUpperCase()}-${record.enteredAt}`;
  }
  // entryTime/exitTime mirror the canonical timestamps when not set directly.
  if (record.entryTime === null) record.entryTime = record.enteredAt;
  if (record.exitTime === null) record.exitTime = record.exitedAt;
  return record;
}

function buildRejection({ symbol, pattern = null, score = null, reasons = [], at = Date.now() } = {}) {
  const list = Array.isArray(reasons) ? reasons.filter(r => typeof r === 'string' && r.length > 0) : [];
  return {
    rejected: true,
    symbol: symbol !== undefined ? symbol : null,
    pattern: pattern !== undefined ? pattern : null,
    score: score !== undefined ? score : null,
    reasons: list.length > 0 ? list : ['No reason recorded — rejection requires an explanation.'],
    at,
  };
}

module.exports = { buildTradeRecord, buildRejection, TRADE_FIELDS };
