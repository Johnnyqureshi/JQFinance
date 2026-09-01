'use strict';

const TERMINAL_WITHOUT_FILL = new Set([
  'canceled',
  'cancelled',
  'rejected',
  'expired',
  'replaced',
  'done_for_day',
  'stopped',
  'suspended',
  'calculated',
]);
const TERMINAL_ORDER_STATUSES = new Set(['filled', ...TERMINAL_WITHOUT_FILL]);

function orderStatus(order) {
  return String(order?.status || '').toLowerCase();
}

function isTerminalWithoutFill(order) {
  return TERMINAL_WITHOUT_FILL.has(orderStatus(order)) && !(Number(order?.filled_qty) > 0);
}

function isTerminalOrder(order) {
  return TERMINAL_ORDER_STATUSES.has(orderStatus(order));
}

function brokerEntryTransition(order) {
  const status = orderStatus(order);
  const filledQty = Math.max(0, Number(order?.filled_qty) || 0);
  const filledAvgPrice = Number(order?.filled_avg_price);
  const terminal = TERMINAL_ORDER_STATUSES.has(status);
  if (filledQty > 0 && filledAvgPrice > 0) {
    return {
      state: terminal ? 'open' : 'pending_entry',
      filledQty,
      filledAvgPrice,
      terminal,
      void: false,
    };
  }
  return {
    state: terminal ? 'void' : 'pending_entry',
    filledQty: 0,
    filledAvgPrice: null,
    terminal,
    void: terminal,
  };
}

function applyBrokerEntryState(trade, transition) {
  if (!trade || !(Number(transition?.filledQty) > 0) || !(Number(transition?.filledAvgPrice) > 0)) {
    return trade;
  }
  trade.entry_price = Number(transition.filledAvgPrice);
  trade.shares = Number(transition.filledQty);
  trade.entry_filled_qty = Number(transition.filledQty);
  trade.entry_fill_finalized = transition.terminal ? 1 : 0;
  trade.status = transition.state;
  return trade;
}

function managedFillSummary({ entryQty, entryPrice, fills } = {}) {
  const expectedQty = Number(entryQty);
  const basis = Number(entryPrice);
  if (!(expectedQty > 0) || !(basis > 0)) return null;
  let filledQty = 0;
  let filledNotional = 0;
  for (const fill of Array.isArray(fills) ? fills : []) {
    const qty = Math.max(0, Number(fill?.qty ?? fill?.filled_qty) || 0);
    const price = Number(fill?.price ?? fill?.filled_avg_price);
    if (!(qty > 0) || !(price > 0)) continue;
    const appliedQty = Math.min(qty, Math.max(0, expectedQty - filledQty));
    filledQty += appliedQty;
    filledNotional += appliedQty * price;
    if (filledQty >= expectedQty) break;
  }
  if (!(filledQty > 0)) {
    return { closed: false, filledQty: 0, remainingQty: expectedQty, exitPrice: null, pnl: 0 };
  }
  const exitPrice = filledNotional / filledQty;
  return {
    closed: filledQty + 1e-8 >= expectedQty,
    filledQty,
    remainingQty: Math.max(0, expectedQty - filledQty),
    exitPrice,
    pnl: +((filledNotional - basis * filledQty).toFixed(6)),
  };
}

function reconcileManagedFillLedger(db, trade, exitOrder) {
  const orderId = String(exitOrder?.id || '');
  const filledQty = Number(exitOrder?.filled_qty);
  const filledPrice = Number(exitOrder?.filled_avg_price);
  if (!db || !orderId || !(filledQty > 0) || !(filledPrice > 0)) return null;
  db.prepare(`INSERT INTO momentum_exit_fills
    (trade_id,broker_order_id,filled_qty,filled_notional,updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(trade_id,broker_order_id) DO UPDATE SET
      filled_qty=excluded.filled_qty,
      filled_notional=excluded.filled_notional,
      updated_at=datetime('now')`)
    .run(trade.id, orderId, filledQty, filledQty * filledPrice);
  const fills = db.prepare(`SELECT filled_qty AS qty,
    CASE WHEN filled_qty > 0 THEN filled_notional / filled_qty END AS price
    FROM momentum_exit_fills WHERE trade_id=? ORDER BY updated_at,broker_order_id`)
    .all(trade.id);
  return managedFillSummary({
    entryQty: trade.entry_filled_qty,
    entryPrice: trade.entry_price,
    fills,
  });
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
  applyBrokerEntryState,
  brokerEntryTransition,
  filledSellOrder,
  isTerminalOrder,
  isTerminalWithoutFill,
  managedFillSummary,
  momentumWorkerHealth,
  needsRescueReplacement,
  reconcileManagedFillLedger,
};