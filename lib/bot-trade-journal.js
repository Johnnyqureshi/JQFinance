'use strict';

const TERMINAL_WITHOUT_FILL = new Set(['canceled', 'cancelled', 'rejected', 'expired']);

function orderStatus(order) {
  return String(order?.status || '').toLowerCase();
}

function isTerminalWithoutFill(order) {
  return TERMINAL_WITHOUT_FILL.has(orderStatus(order)) && !(Number(order?.filled_qty) > 0);
}

function filledSellOrder(order) {
  const orders = [order, ...(Array.isArray(order?.legs) ? order.legs : [])];
  return orders.find(candidate =>
    String(candidate?.side || '').toLowerCase() === 'sell'
    && Number(candidate?.filled_avg_price) > 0
    && Number(candidate?.filled_qty) > 0
  ) || null;
}

function needsRescueReplacement(order, residualQty) {
  return Number(residualQty) > 0 && isTerminalWithoutFill(order);
}

function momentumWorkerHealth({
  enabled,
  connected,
  openTrades = 0,
  lastCycleAt,
  lastCycleStatus,
  lastCycleReason,
  now = Date.now(),
  staleAfterMs = 3 * 60 * 1000,
}) {
  const status = String(lastCycleStatus || '').toLowerCase();
  const cycleAt = lastCycleAt ? Date.parse(lastCycleAt) : NaN;
  const stale = !Number.isFinite(cycleAt) || now - cycleAt > staleAfterMs;
  const outage = !connected || ['broker_outage', 'mode_mismatch', 'error'].includes(status);

  if (!enabled) {
    return {
      status: 'disabled',
      running: false,
      monitoringOpenPositions: openTrades > 0,
      reason: openTrades > 0
        ? 'Automation is explicitly disabled; the worker still reconciles existing Momentum positions.'
        : 'Automation is explicitly disabled.',
    };
  }
  if (outage) {
    return {
      status: 'broker_outage',
      running: false,
      monitoringOpenPositions: openTrades > 0,
      reason: lastCycleReason || (connected
        ? 'The Momentum worker cannot currently reach or verify the active broker account.'
        : 'The dedicated Momentum broker account is not connected.'),
    };
  }
  if (stale) {
    return {
      status: 'starting',
      running: false,
      monitoringOpenPositions: openTrades > 0,
      reason: 'Waiting for the server worker heartbeat.',
    };
  }
  return {
    status: 'running',
    running: true,
    monitoringOpenPositions: openTrades > 0,
    reason: lastCycleReason || 'The server worker is running.',
  };
}

module.exports = {
  filledSellOrder,
  isTerminalWithoutFill,
  momentumWorkerHealth,
  needsRescueReplacement,
};