'use strict';

const assert = require('assert');
const {
  classifyExitIntent,
  decideLeapExitAction,
  closingOrdersToCancelOnPositionLoss,
} = require('../lib/leap-options-order-lifecycle');

const missing = classifyExitIntent({ clientOrderId: 'jqf-leap-x', lookupMissing: true });
assert.equal(missing.state, 'UNRESOLVED');
assert.equal(decideLeapExitAction({
  remaining: 2, thesisInvalidated: false, target: missing,
}).action, 'WAIT');

const cancelPending = classifyExitIntent({
  clientOrderId: 'jqf-leap-x', order: { status: 'pending_cancel' },
});
assert.equal(cancelPending.state, 'CANCEL_PENDING');
assert.equal(decideLeapExitAction({
  remaining: 2, thesisInvalidated: true, target: cancelPending,
}).action, 'WAIT');

const active = classifyExitIntent({
  clientOrderId: 'jqf-leap-x', order: { status: 'new' },
});
assert.equal(decideLeapExitAction({
  remaining: 2, thesisInvalidated: true, target: active, targetRemaining: 2,
}).action, 'CANCEL_TARGET');
assert.equal(decideLeapExitAction({
  remaining: 2, thesisInvalidated: false, target: active, targetRemaining: 1,
}).action, 'CANCEL_TARGET');

const canceled = classifyExitIntent({
  clientOrderId: 'jqf-leap-x', order: { status: 'canceled' },
});
assert.equal(decideLeapExitAction({
  remaining: 2, thesisInvalidated: true, target: canceled,
}).action, 'SUBMIT_THESIS_EXIT');
assert.equal(decideLeapExitAction({
  remaining: 2, thesisInvalidated: false, target: canceled,
}).action, 'SUBMIT_TARGET');

const reservedThesis = classifyExitIntent({
  clientOrderId: 'jqf-leap-thesis', lookupMissing: true,
});
assert.equal(decideLeapExitAction({
  remaining: 2, thesisInvalidated: true, target: canceled, thesisExit: reservedThesis,
}).action, 'WAIT');

const cancelOnPositionLoss = closingOrdersToCancelOnPositionLoss([
  { purpose: 'target', clientOrderId: 'target', order: { id: 't1', status: 'new' } },
  { purpose: 'thesis', clientOrderId: 'thesis', order: { id: 'x1', status: 'accepted' } },
  { purpose: 'already-canceling', clientOrderId: 'other', order: { id: 'x2', status: 'pending_cancel' } },
  { purpose: 'missing', clientOrderId: 'missing', order: null, lookupMissing: true },
]);
assert.deepStrictEqual(cancelOnPositionLoss.map(item => item.purpose), ['target', 'thesis']);

console.log(' ✓ LEAP options order lifecycle');