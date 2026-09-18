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

module.exports = { brokerOrderMatchesIntent };
