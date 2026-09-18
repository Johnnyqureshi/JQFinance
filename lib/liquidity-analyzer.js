'use strict';

// This module deliberately consumes provider-normalized snapshots only. It
// never turns OHLCV or a quote into a pretend order book.
const SCHEMA_VERSION = 'liquidity.v1';
const MAX_HISTORY = 12;
const MAX_AGE_MS = 45 * 1000;
const MAX_HISTORY_AGE_MS = 30 * 60 * 1000;

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function timestamp(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
function validTime(value, now, maxAge = MAX_AGE_MS) {
  const t = timestamp(value);
  return t != null && t <= now + 5000 && now - t <= maxAge;
}
function unavailable(provider, reason, limitations = []) {
  return {
    schemaVersion: SCHEMA_VERSION, provider, status: 'UNAVAILABLE', available: false, partial: false,
    currentPrice: null, topOfBook: null, spread: null, imbalance: null, recentTrade: null,
    level2: { available: false, reason: 'Current provider does not expose Level 2 market depth.' },
    walls: { available: false, status: 'UNAVAILABLE', reason: 'Top-of-book data cannot establish liquidity walls.' },
    absorption: { available: false, status: 'UNAVAILABLE', reason: 'Executed-flow history is unavailable.' },
    shift: { available: false, status: 'UNAVAILABLE', reason: 'Fewer than two valid real snapshots are available.' },
    history: [], score: { total: null, max: null, components: [] }, state: 'NEUTRAL_MIXED',
    warnings: [reason], limitations: [...limitations, 'No directional conclusion is issued without valid market-depth evidence.'],
    summary: 'Heatmap data unavailable from current market-data provider.',
  };
}

function buildLiquidityAnalysis({ quote, indicators = {}, relativeVolume = null, levels = {}, history = [], now = Date.now() } = {}) {
  const isAlpaca = quote?.source === 'alpaca';
  const provider = isAlpaca ? 'Alpaca IEX top-of-book snapshot' : 'Yahoo Finance';
  const baseLimitations = isAlpaca
    ? ['Alpaca IEX snapshot is venue-limited top-of-book, not full-market NBBO or Level 2 depth.']
    : ['Yahoo Finance does not provide bid/ask sizes or Level 2 market depth.'];
  if (!quote || !isAlpaca) return unavailable(provider, 'Heatmap data unavailable from current market-data provider.', baseLimitations);

  const rawBook = quote.topOfBook || quote.latestQuote || {};
  const bid = finite(rawBook.bid ?? rawBook.bp), ask = finite(rawBook.ask ?? rawBook.ap);
  const bidSize = finite(rawBook.bidSize ?? rawBook.bs), askSize = finite(rawBook.askSize ?? rawBook.as);
  const bookTime = rawBook.timestamp ?? rawBook.t ?? quote.asOf;
  if (!(bid > 0) || !(ask > 0) || !(bid <= ask) ||
      !(bidSize > 0) || !(askSize > 0) || !validTime(bookTime, now)) {
    const reason = bid != null && ask != null && bid > ask
      ? 'Heatmap data unavailable: crossed bid/ask quote.'
      : 'Heatmap data unavailable: bid/ask sizes are missing, zero, malformed, or stale.';
    return unavailable(provider, reason, baseLimitations);
  }
  const mid = (bid + ask) / 2;
  // The normalized quote price may fall back to an older trade or bar. Use the
  // timestamp-validated quote midpoint for all liquidity display/scoring.
  const price = mid;
  const spreadAbs = ask - bid;
  const spreadPct = mid ? spreadAbs / mid * 100 : null;
  const bidNotional = bid * bidSize, askNotional = ask * askSize;
  const imbalancePct = (bidNotional + askNotional)
    ? (bidNotional - askNotional) / (bidNotional + askNotional) * 100 : null;
  const rawTrade = quote.recentTrade || quote.latestTrade || {};
  const tradePrice = finite(rawTrade.price ?? rawTrade.p);
  const tradeSize = finite(rawTrade.size ?? rawTrade.s);
  const tradeAt = rawTrade.timestamp ?? rawTrade.t;
  const trade = tradePrice > 0 && tradeSize > 0 && validTime(tradeAt, now)
    ? { price: tradePrice, size: tradeSize, timestamp: new Date(timestamp(tradeAt)).toISOString() } : null;

  const cleanHistory = Array.isArray(history) ? history.slice(-MAX_HISTORY).filter(item =>
    item && Number.isFinite(item.bid) && Number.isFinite(item.ask)
    && item.bid > 0 && item.ask >= item.bid && item.bidSize > 0 && item.askSize > 0
    && validTime(item.at, now, MAX_HISTORY_AGE_MS)
  ) : [];
  const prior = cleanHistory.at(-1);
  let shift = { available: false, status: 'UNAVAILABLE', reason: 'Fewer than two valid real snapshots are available.' };
  if (prior) {
    const bidChange = +((bidSize / prior.bidSize - 1) * 100).toFixed(1);
    const askChange = +((askSize / prior.askSize - 1) * 100).toFixed(1);
    const sign = value => value > 2 ? 'UP' : value < -2 ? 'DOWN' : 'FLAT';
    shift = {
      available: true, status: 'AVAILABLE',
      bidLiquidityChangePct: bidChange,
      askLiquidityChangePct: askChange,
      direction: `BID_${sign(bidChange)}_ASK_${sign(askChange)}`,
    };
  }

  const components = [];
  const add = (key, label, score, max, reason, available = true) =>
    components.push({ key, label, score: available ? score : null, max, available, reason });
  const vwap = finite(indicators.vwap);
  if (vwap != null && price > vwap) add('vwap', 'Price vs VWAP', 1.5, 1.5, 'Price is above VWAP.');
  else if (vwap != null) add('vwap', 'Price vs VWAP', -1.5, 1.5, 'Price is below VWAP.');
  else add('vwap', 'Price vs VWAP', null, 1.5, 'VWAP unavailable.', false);
  const macd = finite(indicators.macd?.histogram ?? indicators.macdHistogram);
  if (macd != null) add('momentum', 'MACD momentum', macd > 0 ? 1.5 : macd < 0 ? -1.5 : 0, 1.5, macd > 0 ? 'MACD histogram is positive.' : macd < 0 ? 'MACD histogram is negative.' : 'MACD histogram is near zero.');
  else add('momentum', 'MACD momentum', null, 1.5, 'MACD unavailable.', false);
  const rv = finite(relativeVolume ?? quote.relativeVolume);
  if (rv != null) add('relativeVolume', 'Relative volume', rv >= 1.5 ? 1 : 0, 1,
    rv >= 1.5 ? `Relative volume ${rv.toFixed(2)}× confirms participation.` : `Relative volume ${rv.toFixed(2)}× does not add direction.`);
  else add('relativeVolume', 'Relative volume', null, 1, 'Relative volume unavailable.', false);
  const supports = Array.isArray(levels?.support) ? levels.support : [];
  const resistances = Array.isArray(levels?.resistance) ? levels.resistance : [];
  const nearestSupport = supports.find(level => finite(level?.price) < price)?.price ?? null;
  const nearestResistance = resistances.find(level => finite(level?.price) > price)?.price ?? null;
  if (nearestSupport != null || nearestResistance != null) {
    const nearSupport = nearestSupport != null && (price - nearestSupport) / price < 0.02;
    const nearResistance = nearestResistance != null && (nearestResistance - price) / price < 0.02;
    add('levels', 'Technical support/resistance', nearSupport && !nearResistance ? 0.5 : nearResistance && !nearSupport ? -0.5 : 0, 0.5,
      nearSupport && !nearResistance ? 'Price is near a completed-session support level.'
        : nearResistance && !nearSupport ? 'Price is near a completed-session resistance level.'
          : 'Completed-session support and resistance are mixed.');
  } else add('levels', 'Technical support/resistance', null, 0.5, 'Support and resistance unavailable.', false);
  add('quoteImbalance', 'Top-of-book imbalance', Math.max(-1, Math.min(1, (imbalancePct / 50))), 1, `${imbalancePct.toFixed(1)}% bid-side notional imbalance; low-weight resting liquidity evidence.`);
  add('executedTrade', 'Recent executed trade', null, 1,
    trade
      ? 'Displayed for context only; an asynchronous trade/quote snapshot cannot establish aggressor side.'
      : 'Recent executed trade is unavailable or stale.',
    false);
  const usable = components.filter(c => c.available);
  const technical = components.filter(c => ['vwap', 'momentum', 'relativeVolume'].includes(c.key) && c.available);
  const total = usable.reduce((sum, c) => sum + c.score, 0);
  const hasTechnicalDirection = technical.some(c => Math.abs(c.score) >= 1);
  const state = hasTechnicalDirection && total >= 2.5 ? 'BULLISH_PRESSURE'
    : hasTechnicalDirection && total <= -2.5 ? 'BEARISH_PRESSURE' : 'NEUTRAL_MIXED';
  const currentPoint = {
    at: new Date(timestamp(bookTime)).toISOString(), bid, ask, bidSize, askSize,
    state, score: +total.toFixed(2),
  };
  const warnings = [];
  if (spreadPct > 1) warnings.push('Wide spread — top-of-book direction may be unreliable.');
  if (rv != null && rv < 0.75) warnings.push('Low volume — heatmap signal may be unreliable.');
  if (shift.available && shift.direction !== 'MIXED') warnings.push('Liquidity is changing; resting quotes can disappear or move.');
  if (!trade) warnings.push('Executed-flow evidence is unavailable; resting quote imbalance is low confidence.');
  return {
    schemaVersion: SCHEMA_VERSION, provider, status: 'PARTIAL', available: true, partial: true,
    provenance: { quote: provider, quoteTimestamp: new Date(timestamp(bookTime)).toISOString(), generatedAt: new Date(now).toISOString() },
    currentPrice: price, currentPriceSource: 'VALIDATED_QUOTE_MIDPOINT',
    topOfBook: { bid, bidSize, ask, askSize, midpoint: +mid.toFixed(6), timestamp: new Date(timestamp(bookTime)).toISOString() },
    spread: { absolute: +spreadAbs.toFixed(6), percent: +spreadPct.toFixed(4) },
    imbalance: { bidNotional: +bidNotional.toFixed(4), askNotional: +askNotional.toFixed(4), percent: +imbalancePct.toFixed(2) },
    recentTrade: trade, minuteBarVolume: finite(quote.minuteBarVolume),
    technicalContext: { support: nearestSupport, resistance: nearestResistance, relativeVolume: rv },
    level2: { available: false, reason: 'Current Alpaca snapshot exposes top-of-book, not full Level 2 depth.' },
    walls: { available: false, status: 'UNAVAILABLE', reason: 'Top-of-book data cannot establish liquidity walls.' },
    absorption: { available: false, status: 'UNAVAILABLE', reason: 'Sufficient executed-flow history is unavailable.' },
    shift, history: [...cleanHistory, currentPoint].slice(-MAX_HISTORY),
    score: {
      total: +total.toFixed(2), max: usable.reduce((sum, c) => sum + c.max, 0),
      bullishThreshold: 2.5, bearishThreshold: -2.5, components,
    },
    state, warnings, limitations: baseLimitations.concat(['Walls, absorption, and full volume concentration require Level 2/trade history.']),
    summary: state === 'BULLISH_PRESSURE' ? 'Current market structure suggests bullish pressure.'
      : state === 'BEARISH_PRESSURE' ? 'Current market structure suggests bearish pressure.'
      : 'Signals are mixed; directional conviction is low.',
  };
}

module.exports = { SCHEMA_VERSION, MAX_HISTORY, MAX_AGE_MS, buildLiquidityAnalysis };