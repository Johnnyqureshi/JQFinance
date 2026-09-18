'use strict';

const {
  easternMarketState, evaluateLiquidity, DEFAULT_LIQUIDITY_POLICY,
} = require('./liquidity-policy');

const finite = value => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const milliseconds = value => {
  const numeric = finite(value);
  if (numeric !== null) return numeric < 1e11 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function yahooLiquidityInput(quote, { now = Date.now(), marketState } = {}) {
  const tradeTimestamp = milliseconds(quote?.regularMarketTime);
  return {
    price: finite(quote?.regularMarketPrice),
    volume: finite(quote?.regularMarketVolume),
    bid: finite(quote?.bid),
    ask: finite(quote?.ask),
    changePct: finite(quote?.regularMarketChangePercent),
    now,
    marketState: marketState || easternMarketState(now),
    priceTimestamp: tradeTimestamp,
    volumeTimestamp: tradeTimestamp,
    // Yahoo's regularMarketTime timestamps the last trade, not its bid/ask.
    // Do not mislabel it as quote freshness evidence.
    quoteTimestamp: null,
    provider: 'yahoo',
  };
}

function alpacaLiquidityInput(snapshot, { now = Date.now(), marketState } = {}) {
  const quote = snapshot?.latestQuote || {};
  const trade = snapshot?.latestTrade || {};
  const bid = finite(quote.bp ?? quote.bid_price);
  const ask = finite(quote.ap ?? quote.ask_price);
  const tradePrice = finite(trade.p ?? trade.price);
  const midpoint = bid !== null && ask !== null && bid > 0 && ask >= bid ? (bid + ask) / 2 : null;
  const price = tradePrice !== null && tradePrice > 0 ? tradePrice : midpoint;
  const previousClose = finite(snapshot?.prevDailyBar?.c);
  return {
    price,
    volume: finite(snapshot?.dailyBar?.v),
    bid,
    ask,
    changePct: price !== null && price > 0 && previousClose !== null && previousClose > 0
      ? (price / previousClose - 1) * 100 : null,
    now,
    marketState: marketState || easternMarketState(now),
    priceTimestamp: tradePrice !== null ? (trade.t ?? trade.timestamp) : (quote.t ?? quote.timestamp),
    volumeTimestamp: snapshot?.dailyBar?.t,
    quoteTimestamp: quote.t ?? quote.timestamp,
    provider: 'alpaca',
  };
}

const evaluateYahooLiquidity = (quote, options, policy = DEFAULT_LIQUIDITY_POLICY) =>
  evaluateLiquidity(yahooLiquidityInput(quote, options), policy);
const evaluateAlpacaLiquidity = (snapshot, options, policy = DEFAULT_LIQUIDITY_POLICY) =>
  evaluateLiquidity(alpacaLiquidityInput(snapshot, options), policy);

module.exports = {
  yahooLiquidityInput, alpacaLiquidityInput,
  evaluateYahooLiquidity, evaluateAlpacaLiquidity,
};