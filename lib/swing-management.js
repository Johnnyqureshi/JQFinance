'use strict';

const finite = value => Number.isFinite(Number(value));
const round = value => finite(value) ? +Number(value).toFixed(4) : null;

// Percentages are applied to the original fill and floored.  The remainder is
// intentionally reserved for the final target, so integer orders cannot
// over-sell a partially filled position.
function calculateSwingAllocations(filledQuantity) {
  const filled = Math.max(0, Math.floor(Number(filledQuantity) || 0));
  const first = Math.floor(filled * .25);
  const second = Math.floor(filled * .25);
  const third = Math.floor(filled * .25);
  return { filledQuantity: filled, target1: first, target2: second, target3: third, final: filled - first - second - third };
}

function ratchetSwingStop(currentStop, proposedStop) {
  const current = finite(currentStop) ? Number(currentStop) : null;
  const proposed = finite(proposedStop) ? Number(proposedStop) : null;
  if (proposed == null) return round(current);
  return round(current == null ? proposed : Math.max(current, proposed));
}

function buildSwingClientOrderId({ symbol, tradeId, purpose, sequence } = {}) {
  const clean = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 18);
  const ticker = clean(symbol);
  const trade = clean(tradeId);
  const use = clean(purpose) || 'ORDER';
  const seq = Math.max(0, Math.floor(Number(sequence) || 0));
  if (!ticker || !trade) throw new Error('symbol and tradeId are required for a strategy-owned client ID.');
  // Alpaca client IDs are bounded; this deterministic namespace also makes
  // ownership distinguishable from manual/bot orders.
  return `swing-${ticker}-${trade}-${use}-${seq}`.slice(0, 48);
}

module.exports = { calculateSwingAllocations, ratchetSwingStop, buildSwingClientOrderId };