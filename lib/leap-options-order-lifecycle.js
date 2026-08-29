'use strict';

const ACTIVE_EXIT_STATUSES = new Set([
  'new', 'accepted', 'pending_new', 'partially_filled', 'held', 'open',
]);
const CANCEL_UNRESOLVED_STATUSES = new Set(['pending_cancel', 'pending_replace']);
const TERMINAL_EXIT_STATUSES = new Set(['canceled', 'rejected', 'expired']);

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function classifyExitIntent({ clientOrderId, order = null, lookupMissing = false } = {}) {
  if (!clientOrderId) return Object.freeze({ exists: false, state: 'NONE', status: null });
  if (lookupMissing || !order) {
    return Object.freeze({ exists: true, state: 'UNRESOLVED', status: null });
  }
  const status = normalizeStatus(order.status);
  if (CANCEL_UNRESOLVED_STATUSES.has(status)) {
    return Object.freeze({ exists: true, state: 'CANCEL_PENDING', status });
  }
  if (ACTIVE_EXIT_STATUSES.has(status)) {
    return Object.freeze({ exists: true, state: 'ACTIVE', status });
  }
  if (TERMINAL_EXIT_STATUSES.has(status)) {
    return Object.freeze({ exists: true, state: 'TERMINAL', status });
  }
  if (status === 'filled') {
    return Object.freeze({ exists: true, state: 'FILLED', status });
  }
  return Object.freeze({ exists: true, state: 'UNRESOLVED', status });
}

function decideLeapExitAction({
  remaining,
  thesisInvalidated,
  target,
  thesisExit,
  targetRemaining = null,
} = {}) {
  const quantity = Math.max(0, Math.floor(Number(remaining) || 0));
  if (!quantity) return Object.freeze({ action: 'NONE', reason: 'NO_REMAINING_POSITION' });
  if (thesisExit?.exists) {
    return Object.freeze({ action: 'WAIT', reason: 'THESIS_EXIT_ALREADY_RESERVED_OR_SUBMITTED' });
  }
  if (thesisInvalidated) {
    if (target?.state === 'ACTIVE') {
      return Object.freeze({ action: 'CANCEL_TARGET', reason: 'THESIS_INVALIDATED' });
    }
    if (target?.state === 'CANCEL_PENDING' || target?.state === 'UNRESOLVED') {
      return Object.freeze({ action: 'WAIT', reason: 'TARGET_CANCELLATION_OR_LOOKUP_UNRESOLVED' });
    }
    if (target?.state === 'FILLED') {
      return Object.freeze({ action: 'WAIT', reason: 'TARGET_FILL_AWAITS_POSITION_RECONCILIATION' });
    }
    return Object.freeze({ action: 'SUBMIT_THESIS_EXIT', reason: 'TARGET_CONFIRMED_ABSENT' });
  }
  if (!target?.exists || target?.state === 'TERMINAL') {
    return Object.freeze({ action: 'SUBMIT_TARGET', reason: 'TARGET_CONFIRMED_ABSENT' });
  }
  if (target.state === 'ACTIVE' && Number(targetRemaining) !== quantity) {
    return Object.freeze({ action: 'CANCEL_TARGET', reason: 'TARGET_QUANTITY_MISMATCH' });
  }
  if (target.state === 'ACTIVE') {
    return Object.freeze({ action: 'WAIT', reason: 'TARGET_COVERS_POSITION' });
  }
  return Object.freeze({ action: 'WAIT', reason: 'TARGET_STATE_UNRESOLVED' });
}

function closingOrdersToCancelOnPositionLoss(ownedExits = []) {
  if (!Array.isArray(ownedExits)) return [];
  return ownedExits.filter(item => item?.order?.id
    && classifyExitIntent({
      clientOrderId: item.clientOrderId,
      order: item.order,
      lookupMissing: item.lookupMissing,
    }).state === 'ACTIVE');
}

module.exports = {
  ACTIVE_EXIT_STATUSES,
  CANCEL_UNRESOLVED_STATUSES,
  TERMINAL_EXIT_STATUSES,
  classifyExitIntent,
  decideLeapExitAction,
  closingOrdersToCancelOnPositionLoss,
};