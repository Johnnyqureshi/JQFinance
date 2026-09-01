'use strict';

/**
 * A broker order is safe to reconcile only when its immutable client order ID
 * matches the intent stored in that strategy's journal. Account separation is
 * helpful, but it is not a substitute for rejecting an unexpected response.
 */
function brokerOrderMatchesIntent(order, expectedClientOrderId) {
  const expected = String(expectedClientOrderId || '').trim();
  const actual = String(order?.client_order_id || '').trim();
  return !!expected && !!actual && actual === expected;
}

function activeProtectiveLegsForIntent(parent, expectedClientOrderId) {
  if (!brokerOrderMatchesIntent(parent, expectedClientOrderId)) return [];
  return (Array.isArray(parent?.legs) ? parent.legs : []).filter(order =>
    String(order?.side || '').toLowerCase() === 'sell'
    && !['filled', 'canceled', 'cancelled', 'rejected', 'expired'].includes(
      String(order?.status || '').toLowerCase()
    )
  );
}

function protectiveCancellationSettled(parent, expectedClientOrderId) {
  return brokerOrderMatchesIntent(parent, expectedClientOrderId)
    && activeProtectiveLegsForIntent(parent, expectedClientOrderId).length === 0;
}

module.exports = {
  activeProtectiveLegsForIntent,
  brokerOrderMatchesIntent,
  protectiveCancellationSettled,
};