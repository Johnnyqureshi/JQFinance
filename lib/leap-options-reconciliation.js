'use strict';
const ACTIVE_ORDER_STATUSES = new Set(['new','accepted','pending_new','partially_filled','held','open','pending_replace','pending_cancel']);
const active = order => !!order?.id && ACTIVE_ORDER_STATUSES.has(String(order.status || '').toLowerCase());
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
function assertLeapOwnedOrder(order, intent = {}) {
  if (!order || String(order.client_order_id) !== String(intent.clientOrderId)
    || String(order.symbol).toUpperCase() !== String(intent.contractSymbol ?? intent.symbol).toUpperCase()
    || String(order.side).toLowerCase() !== String(intent.side || 'buy').toLowerCase()
    || n(order.qty) !== n(intent.quantity)) throw new Error('Broker order does not exactly match the immutable LEAP intent.');
  return true;
}
function summarizeLeapFills(entryOrder, targetOrders = []) {
  const filledQuantity=Math.max(0,n(entryOrder?.filled_qty)), targetFilled=targetOrders.reduce((sum,order)=>sum+Math.max(0,n(order.filled_qty)),0);
  const remainingQuantity=Math.max(0,filledQuantity-targetFilled);
  const activeTargetQuantity=targetOrders.filter(active).reduce((sum,order)=>sum+Math.max(0,n(order.qty)-n(order.filled_qty)),0);
  return { filledQuantity, exitedQuantity:targetFilled, remainingQuantity, activeTargetQuantity,
    targetCovered:remainingQuantity === 0 || activeTargetQuantity === remainingQuantity };
}
function remediateLeapTarget({ entryOrder, targetOrders = [], intent } = {}) {
  const summary=summarizeLeapFills(entryOrder,targetOrders);
  if (!summary.remainingQuantity || summary.targetCovered) return { action:'NONE', summary };
  if (!(n(entryOrder?.filled_avg_price) > 0)) return { action:'WAIT_FOR_CONFIRMED_AVERAGE_ENTRY', summary };
  return { action:'CREATE_TARGET', summary, order:{ symbol:String(intent?.contractSymbol ?? entryOrder.symbol), qty:String(summary.remainingQuantity),
    side:'sell', type:'limit', limit_price:(n(entryOrder.filled_avg_price)*2).toFixed(2), time_in_force:'gtc',
    client_order_id:String(intent?.targetClientOrderId || '') } };
}
function leapThesisExitPolicy(thesis) {
  const invalidated=typeof thesis === 'boolean' ? thesis : !!thesis?.invalidated;
  return invalidated ? { exit:true, reason:'Weekly EMA thesis invalidated.' } : { exit:false, reason:'RSI recovery is not an exit.' };
}
module.exports = { ACTIVE_ORDER_STATUSES, isActiveLeapOrder:active, assertLeapOwnedOrder, assertLeapOwnedBrokerOrder:assertLeapOwnedOrder,
  summarizeLeapFills, summarizeLeapPosition:summarizeLeapFills, remediateLeapTarget, leapThesisExitPolicy };