'use strict';

const {
  calculateRegularSessionVwap,
  isFreshQuoteTimestamp,
  regularSessionWindow,
} = require('./intraday-vwap');

function evaluateVwapSupport({ price, vwap, priceFresh }) {
  const currentPrice = Number(price);
  const sessionVwap = Number(vwap);
  if (!priceFresh
    || !Number.isFinite(currentPrice) || currentPrice <= 0
    || !Number.isFinite(sessionVwap) || sessionVwap <= 0) {
    return {
      eligible: false,
      reason: 'Fresh VWAP or quote data unavailable — cannot verify price support',
    };
  }
  if (currentPrice <= sessionVwap) {
    return {
      eligible: false,
      reason: currentPrice < sessionVwap
        ? 'SKIP — price below VWAP (potential reversal)'
        : 'SKIP — price at VWAP (confirmation requires above)',
    };
  }
  return { eligible: true, reason: null };
}

function evaluateSessionVwapContext({ bars, snapshot, now = new Date() }) {
  const { start, end } = regularSessionWindow(now);
  const vwap = calculateRegularSessionVwap(bars, now);
  const ask = Number(snapshot?.latestQuote?.ap);
  const priceTimestamp = snapshot?.latestQuote?.t ?? null;
  const priceFresh = now >= start
    && now < end
    && Number.isFinite(ask)
    && ask > 0
    && isFreshQuoteTimestamp(priceTimestamp, now);

  if (now < start || now >= end) {
    return {
      eligible: false,
      reason: 'VWAP confirmation is only available during the regular trading session',
      price: Number.isFinite(ask) && ask > 0 ? ask : null,
      priceTimestamp,
      priceFresh: false,
      vwap,
      vwapSession: 'regular',
    };
  }

  return {
    ...evaluateVwapSupport({ price: ask, vwap, priceFresh }),
    price: Number.isFinite(ask) && ask > 0 ? ask : null,
    priceTimestamp,
    priceFresh,
    vwap,
    vwapSession: 'regular',
  };
}

module.exports = { evaluateVwapSupport, evaluateSessionVwapContext };