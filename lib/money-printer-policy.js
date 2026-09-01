'use strict';

const crypto = require('crypto');

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  liveArmed: false,
  maxPositionDollars: 1000,
  takeProfitPct: 3,
  stopLossPct: 1.5,
});

function finite(value) {
  return value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value));
}

function bounded(value, name, minimum, maximum) {
  if (!finite(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`${name} must be a finite number from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function sanitizeMoneyPrinterSettings(input = {}, prior = DEFAULT_SETTINGS) {
  const allowed = new Set(['enabled', 'liveArmed', 'maxPositionDollars', 'takeProfitPct', 'stopLossPct']);
  const unknown = Object.keys(input || {}).filter(key => !allowed.has(key));
  if (unknown.length) throw new RangeError(`Unsupported Money Printer setting: ${unknown[0]}.`);
  return {
    enabled: input.enabled === undefined ? prior.enabled === true : input.enabled === true,
    liveArmed: input.liveArmed === undefined ? prior.liveArmed === true : input.liveArmed === true,
    maxPositionDollars: bounded(
      input.maxPositionDollars ?? prior.maxPositionDollars,
      'maxPositionDollars', 1, 100000,
    ),
    takeProfitPct: bounded(input.takeProfitPct ?? prior.takeProfitPct, 'takeProfitPct', 0.1, 50),
    stopLossPct: bounded(input.stopLossPct ?? prior.stopLossPct, 'stopLossPct', 0.1, 25),
  };
}

function evaluateMoneyPrinterPlan(plan, nowMs = Date.now(), maxAgeMs = 6 * 60 * 1000) {
  const signal = plan?.searchSignal?.signal || {};
  const confluence = plan?.confluence || {};
  const levels = plan?.tradeLevels || {};
  const generatedMs = Date.parse(plan?.generatedAt);
  const direction = signal.label === 'BUY' ? 'LONG' : signal.label === 'SELL' ? 'SHORT' : null;
  const blockers = [];
  if (!plan?.ok) blockers.push('Search gameplan is unavailable');
  if (!direction) blockers.push('Search signal is not BUY or SELL');
  if (signal.stage !== 'CONFIRMED') blockers.push('Search signal is not CONFIRMED');
  if (confluence.dataQuality?.entryEligible !== true) blockers.push('Technical confluence is not entry eligible');
  if (confluence.dataQuality?.fresh !== true) blockers.push('Technical confluence is stale');
  if (levels.status !== 'VERIFIED') blockers.push('Search trade levels are not verified');
  if (!Number.isFinite(generatedMs) || nowMs - generatedMs > maxAgeMs || generatedMs > nowMs + 30000) {
    blockers.push('Search gameplan is stale');
  }
  // These fields prove the shared deterministic Search builder evaluated every
  // required family. Their directional result is server-owned, not configurable.
  for (const [field, label] of [
    ['levels', 'completed-session levels'],
    ['patternAnalysis', 'chart patterns'],
    ['fibonacci', 'Fibonacci'],
    ['smartMoney', 'Smart Money'],
    ['gapAnalysis', 'gaps'],
    ['news', 'news/catalysts'],
    ['marketContext', 'SPY/sector context'],
  ]) {
    if (plan?.[field] == null) blockers.push(`Missing ${label}`);
  }
  return { eligible: blockers.length === 0, direction, blockers };
}

function executablePrice(snapshot, direction, nowMs = Date.now(), maxAgeMs = 90 * 1000) {
  const quote = snapshot?.latestQuote || snapshot?.latest_quote || {};
  const value = direction === 'SHORT' ? quote.bp : quote.ap;
  if (!finite(value) || Number(value) <= 0) throw new RangeError('A fresh executable Alpaca quote is unavailable.');
  const quoteMs = Date.parse(quote.t || quote.timestamp || '');
  if (!Number.isFinite(quoteMs) || quoteMs > nowMs + 30 * 1000 || nowMs - quoteMs > maxAgeMs) {
    throw new RangeError('The executable Alpaca quote is stale.');
  }
  return Number(value);
}

function buildMoneyPrinterBracket({ symbol, direction, executablePrice: price, settings, clientOrderId }) {
  const entry = bounded(price, 'executablePrice', 0.01, 1000000);
  const qty = Math.floor(settings.maxPositionDollars / entry);
  if (qty < 1) throw new RangeError('maxPositionDollars is below the executable share price.');
  const long = direction === 'LONG';
  if (!long && direction !== 'SHORT') throw new RangeError('direction must be LONG or SHORT.');
  const target = entry * (1 + (long ? 1 : -1) * settings.takeProfitPct / 100);
  const stop = entry * (1 + (long ? -1 : 1) * settings.stopLossPct / 100);
  if (!(long ? target > entry && stop < entry : target < entry && stop > entry)) {
    throw new RangeError('Bracket prices are not correctly ordered.');
  }
  return {
    qty,
    entryPrice: entry,
    targetPrice: +target.toFixed(2),
    stopPrice: +stop.toFixed(2),
    order: {
      symbol,
      qty: String(qty),
      side: long ? 'buy' : 'sell',
      type: 'market',
      time_in_force: 'day',
      client_order_id: clientOrderId,
      order_class: 'bracket',
      take_profit: { limit_price: target.toFixed(2) },
      stop_loss: { stop_price: stop.toFixed(2) },
    },
  };
}

function moneyPrinterClientOrderId({ userId, accountId, symbol, direction, bucketMs }) {
  const digest = crypto.createHash('sha256')
    .update(`${userId}|${accountId}|${symbol}|${direction}|${bucketMs}`)
    .digest('hex').slice(0, 20);
  return `mp-${String(symbol).toLowerCase().slice(0, 8)}-${digest}`;
}

function finalMoneyPrinterAuthorization({ captured, current, settings }) {
  if (!captured?.account_id || !['paper', 'live'].includes(captured.mode)) {
    return { authorized: false, reason: 'Captured broker identity is unavailable.' };
  }
  if (!current || current.account_id !== captured.account_id || current.mode !== captured.mode
    || current.api_key !== captured.api_key || current.api_secret !== captured.api_secret) {
    return { authorized: false, reason: 'Broker mode or account changed during this cycle.' };
  }
  if (!settings?.enabled) return { authorized: false, reason: 'Automation was paused during this cycle.' };
  if (captured.mode === 'live' && !settings.liveArmed) {
    return { authorized: false, reason: 'Live trading was disarmed during this cycle.' };
  }
  return { authorized: true };
}

function ownedBracketProtection({ direction, filledQty, positionQty, parent, children = [] }) {
  const quantity = Math.max(Number(filledQty) || 0, Math.abs(Number(positionQty) || 0));
  const terminal = new Set(['filled', 'canceled', 'rejected', 'expired', 'replaced']);
  const parentStatus = String(parent?.status || '').toLowerCase();
  const activeChildren = children.filter(order => !terminal.has(String(order?.status || '').toLowerCase()));
  const exitSide = direction === 'SHORT' ? 'buy' : 'sell';
  const covers = order => String(order?.side || '').toLowerCase() === exitSide
    && Number(order?.qty || 0) >= quantity;
  const stop = activeChildren.find(order => covers(order)
    && ['stop', 'stop_limit', 'trailing_stop'].includes(String(order?.type || '').toLowerCase()));
  const target = activeChildren.find(order => covers(order)
    && ['limit'].includes(String(order?.type || '').toLowerCase()));
  const positionPresent = Math.abs(Number(positionQty) || 0) > 0;
  const allTerminal = [parent, ...children].filter(Boolean)
    .every(order => terminal.has(String(order.status || '').toLowerCase()));
  // A bracket fill is only conclusively complete after its two owned exit legs
  // are visible and terminal. An omitted nested-leg response must not erase a
  // partially filled parent from the journal.
  const terminalLegsProven = quantity <= 0 || children.length >= 2;
  const canClose = !positionPresent && allTerminal && terminalLegsProven;
  const requiresManagement = !canClose && (quantity > 0 || positionPresent);
  return {
    requiresManagement,
    protected: !requiresManagement || (!!stop && !!target),
    parentTerminal: terminal.has(parentStatus),
    allTerminal,
    canClose,
    reason: !requiresManagement ? null
      : !stop || !target ? 'Broker-held stop-loss and take-profit protection is missing or undersized.'
        : null,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  sanitizeMoneyPrinterSettings,
  evaluateMoneyPrinterPlan,
  executablePrice,
  buildMoneyPrinterBracket,
  moneyPrinterClientOrderId,
  finalMoneyPrinterAuthorization,
  ownedBracketProtection,
};