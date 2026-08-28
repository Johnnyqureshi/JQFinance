'use strict';

// These are server-owned execution constraints. UI inputs are merely requests;
// no stored or browser-provided value may relax the automated trade floor.
function sanitizeCandlestickExecutionConfig(input = {}, defaults = {}) {
  const source = { ...defaults, ...(input || {}) };
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const integer = (value, fallback) => Math.floor(number(value, fallback));
  return {
    ...source,
    minBars: Math.max(20, Math.min(200, integer(source.minBars, defaults.minBars || 20))),
    lookback: Math.max(5, Math.min(60, integer(source.lookback, defaults.lookback || 15))),
    volumeLookback: Math.max(5, Math.min(60, integer(source.volumeLookback, defaults.volumeLookback || 10))),
    minRelativeVolume: Math.max(1, Math.min(10, number(source.minRelativeVolume, defaults.minRelativeVolume || 1.2))),
    minScore: Math.max(0, Math.min(100, number(source.minScore, defaults.minScore || 65))),
    // This is deliberately not configurable below two. A lower value invalidates
    // the stated strategy contract and is never accepted from persistence/UI.
    minRewardRisk: Math.max(2, Math.min(10, number(source.minRewardRisk, defaults.minRewardRisk || 2))),
    breakoutStrength: Math.max(70, Math.min(100, number(source.breakoutStrength, defaults.breakoutStrength || 82))),
    supportTolerancePct: Math.max(0.1, Math.min(5, number(source.supportTolerancePct, defaults.supportTolerancePct || 0.6))),
    maxOutcomeBars: Math.max(1, Math.min(100, integer(source.maxOutcomeBars, defaults.maxOutcomeBars || 12))),
    maxPositionDollars: Math.max(1, Math.min(100000, number(source.maxPositionDollars, defaults.maxPositionDollars || 1000))),
    maxRiskDollars: Math.max(1, Math.min(10000, number(source.maxRiskDollars, defaults.maxRiskDollars || 100))),
    maxPositions: Math.max(1, Math.min(2, integer(source.maxPositions, defaults.maxPositions || 1))),
    maxSymbols: Math.max(1, Math.min(30, integer(source.maxSymbols, defaults.maxSymbols || 16))),
  };
}

function candlestickEntrySide(direction) {
  // Alpaca represents a short stock entry with side=sell. `sell_short` is an
  // internal description, not a valid Alpaca order side.
  return String(direction || '').toUpperCase() === 'SHORT' ? 'sell' : 'buy';
}

function buildCandlestickBracketOrder({ symbol, qty, direction, clientOrderId, target, stop }) {
  const side = candlestickEntrySide(direction);
  return {
    symbol,
    qty: String(qty),
    side,
    type: 'market',
    // Alpaca equity market orders use day. GTC is reserved for order types
    // that support resting orders and can reject an otherwise valid bracket.
    time_in_force: 'day',
    client_order_id: clientOrderId,
    order_class: 'bracket',
    take_profit: { limit_price: Number(target).toFixed(2) },
    stop_loss: { stop_price: Number(stop).toFixed(2) },
  };
}

function calculateCandlestickEntryCapacity(positions, openOrders, pendingJournal) {
  const entryOrders = (Array.isArray(openOrders) ? openOrders : []).filter(order =>
    !order?.parent_order_id && ['buy', 'sell'].includes(String(order?.side || '').toLowerCase())
  );
  const brokerKeys = new Set(entryOrders.flatMap(order => [order.id, order.client_order_id]).filter(Boolean).map(String));
  const heldSymbols = new Set((Array.isArray(positions) ? positions : []).map(position => String(position?.symbol || '').toUpperCase()).filter(Boolean));
  const unresolved = (Array.isArray(pendingJournal) ? pendingJournal : []).filter(trade => {
    const keys = [trade?.entry_order_id, trade?.entry_client_order_id].filter(Boolean).map(String);
    return !keys.some(key => brokerKeys.has(key)) && !heldSymbols.has(String(trade?.symbol || '').toUpperCase());
  });
  const held = Array.isArray(positions) ? positions.length : 0;
  const pendingEntries = entryOrders.length + unresolved.length;
  return { held, pendingEntries, used: held + pendingEntries };
}

module.exports = {
  sanitizeCandlestickExecutionConfig,
  candlestickEntrySide,
  buildCandlestickBracketOrder,
  calculateCandlestickEntryCapacity,
};