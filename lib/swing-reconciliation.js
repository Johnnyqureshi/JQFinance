'use strict';

const ACTIVE_ORDER_STATUSES = new Set([
  'new', 'accepted', 'pending_new', 'partially_filled', 'held',
  'pending_replace', 'pending_cancel', 'open', 'accepted_for_bidding', 'calculated',
]);

function isActiveSwingOrder(order) {
  return !!order?.id && ACTIVE_ORDER_STATUSES.has(String(order.status || '').toLowerCase());
}

function summarizeSwingLotProtection(parent, exitedQuantity = 0) {
  const filled = Math.max(0, Number(parent?.filled_qty || 0));
  const exited = Math.max(0, Number(exitedQuantity || 0));
  const remaining = Math.max(0, filled - exited);
  const legs = Array.isArray(parent?.legs) ? parent.legs : [];
  const activeStops = legs.filter(leg =>
    isActiveSwingOrder(leg)
    && ['stop', 'stop_limit', 'trailing_stop'].includes(String(leg.type || '').toLowerCase())
  );
  const protectedQuantity = activeStops.reduce((sum, order) =>
    sum + Math.max(0, Number(order.qty || 0) - Number(order.filled_qty || 0)), 0);
  const activeOrders = [
    ...(isActiveSwingOrder(parent) ? [parent] : []),
    ...legs.filter(isActiveSwingOrder),
  ];
  return {
    filledQuantity: filled,
    exitedQuantity: exited,
    remainingQuantity: remaining,
    protectedQuantity,
    activeStops,
    activeOrders,
    protected: remaining <= 0 || protectedQuantity >= remaining,
    requiresFailSafeExit: remaining > 0 && protectedQuantity < remaining,
  };
}

function assertSwingOwnedBrokerTree(parent, intent) {
  const symbol = String(intent?.symbol || '').toUpperCase();
  if (!parent || String(parent.client_order_id || '') !== String(intent?.clientOrderId || '')
      || String(parent.symbol || '').toUpperCase() !== symbol
      || String(parent.side || '').toLowerCase() !== 'buy'
      || Number(parent.qty) !== Number(intent?.quantity)) {
    throw new Error('Broker parent order does not match the immutable Swing entry intent.');
  }
  for (const leg of Array.isArray(parent.legs) ? parent.legs : []) {
    const attached = String(leg.parent_order_id || '') === String(parent.id || '');
    const sameSymbol = String(leg.symbol || '').toUpperCase() === symbol;
    const closingSide = String(leg.side || '').toLowerCase() === 'sell';
    const supportedType = ['limit', 'stop', 'stop_limit', 'trailing_stop']
      .includes(String(leg.type || '').toLowerCase());
    if (!attached || !sameSymbol || !closingSide || !supportedType) {
      throw new Error('A nested broker leg failed Swing ownership validation.');
    }
  }
  return true;
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  isActiveSwingOrder,
  summarizeSwingLotProtection,
  assertSwingOwnedBrokerTree,
};