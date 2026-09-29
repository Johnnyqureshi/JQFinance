'use strict';

// Warrior Bot — market regime classifier. Pure function.
// Bullish: SPY & QQQ both above their 20 EMA and both dayChangePct > 0.
// Bearish: both below their 20 EMA and both dayChangePct < -0.5,
//          OR VIX spiking (vixChangePct > 15).
// Otherwise neutral.

function classifyRegime({ spy = {}, qqq = {}, vix = null, vixChangePct = null } = {}) {
  const reasons = [];
  const f = v => Number.isFinite(+v) ? +v : null;
  const sPrice = f(spy.price); const sEma = f(spy.ema20); const sChg = f(spy.dayChangePct);
  const qPrice = f(qqq.price); const qEma = f(qqq.ema20); const qChg = f(qqq.dayChangePct);
  const vChg = f(vixChangePct);

  const spyAbove = sPrice !== null && sEma !== null && sPrice > sEma;
  const qqqAbove = qPrice !== null && qEma !== null && qPrice > qEma;
  const spyBelow = sPrice !== null && sEma !== null && sPrice < sEma;
  const qqqBelow = qPrice !== null && qEma !== null && qPrice < qEma;

  // A VIX spike is an explicit risk-off override, even on a green tape.
  const vixSpike = vChg !== null && vChg > 15;
  if (vixSpike) {
    reasons.push(`VIX spiking +${vChg.toFixed(1)}% — risk-off.`);
    return { regime: 'BEARISH', reasons };
  }
  if (spyAbove && qqqAbove && sChg !== null && qChg !== null && sChg > 0 && qChg > 0) {
    reasons.push(`SPY ${sChg.toFixed(2)}% and QQQ ${qChg.toFixed(2)}% both above 20 EMA and green on the day.`);
    return { regime: 'BULLISH', reasons };
  }
  if (spyBelow && qqqBelow && sChg !== null && qChg !== null && sChg < -0.5 && qChg < -0.5) {
    reasons.push(`SPY ${sChg.toFixed(2)}% and QQQ ${qChg.toFixed(2)}% both below 20 EMA and down over 0.5%.`);
    return { regime: 'BEARISH', reasons };
  }
  if (sPrice === null || qPrice === null) {
    reasons.push('Index data incomplete — defaulting to neutral.');
  } else {
    reasons.push('Mixed index signals — no clear directional edge.');
  }
  return { regime: 'NEUTRAL', reasons };
}

module.exports = { classifyRegime };
