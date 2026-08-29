'use strict';

const finite = value => Number.isFinite(Number(value));
const asNumber = value => finite(value) ? Number(value) : null;

/**
 * The only sizing preference accepted from a caller is a dollar cap.  Risk,
 * symbol, and position-count limits are deliberately owned by the server and
 * are copied only from the supplied immutable ceilings.
 */
function sanitizeSwingExecutionConfig(request = {}, serverCeilings = {}) {
  const ceiling = finite(serverCeilings.maxPositionDollars)
    ? Math.max(1, Number(serverCeilings.maxPositionDollars)) : 1000;
  const requested = asNumber(request.maxPositionDollars);
  return {
    ...serverCeilings,
    maxPositionDollars: Math.max(1, Math.min(ceiling, requested == null ? ceiling : requested)),
  };
}

function calculateLongQuantity({ entry, stop, maxPositionDollars, maxRiskDollars } = {}) {
  const price = asNumber(entry); const stopPrice = asNumber(stop);
  const dollarCap = asNumber(maxPositionDollars); const riskCap = asNumber(maxRiskDollars);
  if (!(price > 0) || !(stopPrice > 0) || !(stopPrice < price) || !(dollarCap > 0)) return 0;
  const byValue = Math.floor(dollarCap / price);
  const byRisk = riskCap > 0 ? Math.floor(riskCap / (price - stopPrice)) : byValue;
  return Math.max(0, Math.min(byValue, byRisk));
}

function buildSwingEntryOrder({ symbol, qty, clientOrderId, limitPrice, stop, target } = {}) {
  if (!String(symbol || '').trim() || !(Number(qty) > 0) || !(Number(limitPrice) > 0)
      || !(Number(stop) > 0) || !(Number(target) > Number(limitPrice))) {
    throw new Error('A symbol, positive quantity, bounded entry, stop, and higher target are required for a swing entry.');
  }
  return {
    symbol: String(symbol).trim().toUpperCase(), qty: String(Math.floor(Number(qty))), side: 'buy',
    // A marketable limit caps actual notional while GTC keeps the activated
    // structural stop broker-visible across sessions.
    type: 'limit', limit_price: Number(limitPrice).toFixed(2),
    time_in_force: 'gtc', order_class: 'bracket', client_order_id: clientOrderId,
    take_profit: { limit_price: Number(target).toFixed(2) },
    stop_loss: { stop_price: Number(stop).toFixed(2) },
  };
}

module.exports = { sanitizeSwingExecutionConfig, calculateLongQuantity, buildSwingEntryOrder };