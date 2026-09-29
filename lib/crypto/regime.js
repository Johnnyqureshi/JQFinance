'use strict';

// Crypto Breakout Bot — BTC regime classifier. Pure function.
// BTC is the primary market indicator for the whole crypto book (spec §10).
//
// bullish:        BTC above its 20 EMA, 20 EMA above 50 EMA, green on the day.
// bearish:        BTC below its 20 EMA, 20 EMA below 50 EMA, down over 0.5%.
// high_volatility: daily ATR% above threshold OR an extreme single-day move —
//                 overrides everything, even a green tape.
// neutral:       anything in between.
//
// Strongly bearish BTC: the engine reduces new altcoin longs, raises the
// required score, and demands stronger volume. Strongly bullish BTC: qualified
// altcoin continuations are allowed. Never blindly buy an altcoin on its
// individual chart alone.

const DEFAULT_THRESHOLDS = Object.freeze({
  highVolAtrPct: 8,      // daily ATR as % of price that counts as high volatility
  extremeDayMovePct: 10, // single-day move that forces high_volatility
  bearishDayDropPct: 0.5,
});

function classifyBtcRegime({ btc = {}, thresholds = {} } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const reasons = [];
  const f = v => Number.isFinite(+v) ? +v : null;
  const price = f(btc.price);
  const ema20 = f(btc.ema20);
  const ema50 = f(btc.ema50);
  const chg = f(btc.dayChangePct);
  const atrPct = f(btc.atrPct);

  if (price === null) {
    reasons.push('BTC price unavailable — regime unknown, defaulting to neutral.');
    return { regime: 'neutral', reasons };
  }
  // Volatility override first: an extreme tape is not a bullish tape.
  if ((atrPct !== null && atrPct >= t.highVolAtrPct) ||
      (chg !== null && Math.abs(chg) >= t.extremeDayMovePct)) {
    reasons.push(`High volatility: daily ATR ${atrPct === null ? 'n/a' : atrPct.toFixed(2) + '%'}${chg === null ? '' : `, day move ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`}.`);
    return { regime: 'high_volatility', reasons };
  }
  const above20 = ema20 !== null && price > ema20;
  const below20 = ema20 !== null && price < ema20;
  const emaStackUp = ema20 !== null && ema50 !== null && ema20 > ema50;
  const emaStackDown = ema20 !== null && ema50 !== null && ema20 < ema50;

  if (above20 && emaStackUp && chg !== null && chg > 0) {
    reasons.push(`BTC ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% above 20 EMA (${ema20.toFixed(2)}) with 20 > 50 EMA — bullish.`);
    return { regime: 'bullish', reasons };
  }
  if (below20 && emaStackDown && chg !== null && chg < -t.bearishDayDropPct) {
    reasons.push(`BTC ${chg.toFixed(2)}% below 20 EMA (${ema20.toFixed(2)}) with 20 < 50 EMA — bearish.`);
    return { regime: 'bearish', reasons };
  }
  reasons.push('Mixed BTC signals — no clear directional edge; neutral.');
  return { regime: 'neutral', reasons };
}

// Whether fresh altcoin longs are welcome in this regime. Bearish and
// high-volatility regimes suppress new altcoin longs (only the strongest
// setups survive via the raised score bar).
function altcoinLongsAllowed(regime) {
  return regime === 'bullish' || regime === 'neutral';
}

module.exports = { classifyBtcRegime, altcoinLongsAllowed, DEFAULT_THRESHOLDS };
