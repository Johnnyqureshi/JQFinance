'use strict';

const TERMINAL = new Set(['filled', 'canceled', 'rejected', 'expired', 'stopped']);
const ACTIVE = new Set([
  'new', 'accepted', 'pending_new', 'partially_filled', 'held', 'open',
  'pending_cancel', 'pending_replace', 'accepted_for_bidding', 'suspended', 'calculated',
]);

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isStopLeg(order) {
  return ['stop', 'stop_limit', 'trailing_stop'].includes(String(order?.type || '').toLowerCase());
}

function isTargetLeg(order) {
  return String(order?.type || '').toLowerCase() === 'limit';
}

function isActive(order) {
  return ACTIVE.has(normalizedStatus(order?.status));
}

function filledLeg(order) {
  return Number(order?.filled_qty) > 0 && Number(order?.filled_avg_price) > 0;
}

function matchesProtection(order, { parentId, symbol, side, priceField, price, quantity }) {
  if (!isActive(order)) return false;
  if (!parentId || !order?.parent_order_id || String(order.parent_order_id) !== String(parentId)) return false;
  if (symbol && String(order?.symbol || '').toUpperCase() !== String(symbol).toUpperCase()) return false;
  if (side && String(order?.side || '').toLowerCase() !== side) return false;
  const actualPrice = Number(order?.[priceField]);
  const actualQuantity = Number(order?.qty ?? order?.remaining_qty);
  return Number.isFinite(actualPrice) && Math.abs(actualPrice - Number(price)) < 0.011
    && Number.isFinite(actualQuantity) && actualQuantity + 1e-8 >= Number(quantity);
}

/**
 * Interpret only broker-confirmed order facts. The caller decides whether to
 * cancel/close; this module never guesses a fill from a parent status.
 */
function summarizeCandlestickBrokerOrder(parent, expected = {}) {
  const legs = Array.isArray(parent?.legs) ? parent.legs : [];
  const status = normalizedStatus(parent?.status);
  const filledQty = Number(parent?.filled_qty);
  const filledAveragePrice = Number(parent?.filled_avg_price);
  const expectedSide = expected.direction === 'SHORT' ? 'buy' : 'sell';
  const target = legs.find(isTargetLeg);
  const stop = legs.find(isStopLeg);
  const expectedLeg = {
    parentId: parent?.id,
    symbol: expected.symbol,
    side: expectedSide,
    quantity: Number.isFinite(Number(expected.remainingQuantity)) && Number(expected.remainingQuantity) > 0
      ? Number(expected.remainingQuantity) : filledQty,
  };
  return {
    parentStatus: status,
    parentTerminal: TERMINAL.has(status),
    parentActive: ACTIVE.has(status),
    hasEntryFill: filledQty > 0 && filledAveragePrice > 0,
    filledQty: filledQty > 0 ? filledQty : 0,
    filledAveragePrice: filledAveragePrice > 0 ? filledAveragePrice : null,
    activeLegs: legs.filter(isActive),
    exitFills: legs.filter(filledLeg),
    protection: {
      targetActive: matchesProtection(target, { ...expectedLeg, priceField:'limit_price', price:expected.targetPrice }),
      stopActive: matchesProtection(stop, { ...expectedLeg, priceField:'stop_price', price:expected.stopPrice }),
      complete: matchesProtection(target, { ...expectedLeg, priceField:'limit_price', price:expected.targetPrice })
        && matchesProtection(stop, { ...expectedLeg, priceField:'stop_price', price:expected.stopPrice }),
    },
  };
}

function needsUnprotectedExit(summary, graceDeadline, now = Date.now()) {
  if (!summary?.hasEntryFill || summary.exitFills?.length || summary.protection?.complete) return false;
  const graceAt = Date.parse(graceDeadline || '');
  return summary.parentTerminal || (Number.isFinite(graceAt) && now >= graceAt);
}

function cancellationAction(summary, tradeStatus) {
  const hasLiveConflictingOrder = Boolean(summary?.parentActive || summary?.activeLegs?.length);
  if (hasLiveConflictingOrder) {
    // A saved intent means DELETE did not return successfully, so it is safe
    // to retry cancellation. Pending means the broker accepted it; wait until
    // the parent and every live child are terminal before a rescue can submit.
    return tradeStatus === 'rescue_cancel_pending' ? 'await_terminal_parent' : 'submit_or_retry_cancel';
  }
  return summary?.parentTerminal ? 'parent_terminal' : 'await_terminal_parent';
}

module.exports = { summarizeCandlestickBrokerOrder, needsUnprotectedExit, cancellationAction };