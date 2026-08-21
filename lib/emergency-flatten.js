'use strict';

class EmergencyFlattenError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EmergencyFlattenError';
    this.details = details;
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Cancels outstanding orders before liquidating positions, then waits for the
 * broker to confirm the account is completely flat. Broker functions are
 * injected so this safety-critical sequence can be tested without live orders.
 */
async function runEmergencyFlatten({
  waitForOrderRequests,
  listOpenOrders,
  cancelOpenOrders,
  closeAllPositions,
  listPositions,
  wait = pause,
  attempts = 32,
  intervalMs = 250,
}) {
  await waitForOrderRequests();

  const cancellationAttempts = [];
  let openOrders = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    openOrders = await listOpenOrders();
    if (!openOrders.length) break;

    try {
      const results = await cancelOpenOrders(openOrders);
      cancellationAttempts.push({
        orderIds: openOrders.map(order => order.id),
        results: Array.isArray(results) ? results : [],
      });
    } catch (error) {
      cancellationAttempts.push({
        orderIds: openOrders.map(order => order.id),
        error: error.message,
      });
    }
    await wait(intervalMs);
  }

  openOrders = await listOpenOrders();
  if (openOrders.length) {
    throw new EmergencyFlattenError('Could not cancel every open order before liquidating positions.', {
      openOrderIds: openOrders.map(order => order.id),
      cancellationAttempts,
    });
  }

  const closeResult = await closeAllPositions();

  for (let attempt = 0; attempt < attempts; attempt++) {
    const [positions, remainingOrders] = await Promise.all([
      listPositions(),
      listOpenOrders(),
    ]);
    if (!positions.length && !remainingOrders.length) {
      return {
        closeResult,
        cancellationAttempts,
        verified: true,
      };
    }
    await wait(intervalMs);
  }

  const [remainingPositions, remainingOrders] = await Promise.all([
    listPositions(),
    listOpenOrders(),
  ]);
  throw new EmergencyFlattenError('Broker did not confirm a flat account before the emergency exit timed out.', {
    remainingPositionSymbols: remainingPositions.map(position => position.symbol),
    remainingOpenOrderIds: remainingOrders.map(order => order.id),
    cancellationAttempts,
  });
}

module.exports = { EmergencyFlattenError, runEmergencyFlatten };