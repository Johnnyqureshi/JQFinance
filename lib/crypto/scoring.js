'use strict';

// Crypto Breakout Bot — breakout opportunity score, 0–100. Pure function.
//
// Johnny's weights (spec §4), configurable through `rules.weights`:
//   breakoutQuality 20, volumeConfirmation 20, rvol 15, priceStructure 10,
//   htfTrend 10, momentum 10, vwapEma 5, liquiditySpread 5, regime 5.
//
// Input:
//   breakout: { confirmed, closeAboveResistance, breakoutAtr (breakout size
//               in ATRs), resistanceTests, retest }
//   volume:   { rvol, priceUp, volumeRising }
//   structure:{ trend: 'uptrend'|'range'|'downtrend' }
//   htf:      { trend: 'bullish'|'neutral'|'bearish', aboveEma200, emaAligned }
//   momentum: { rsi, macdPositive, macdHistRising, bearishDivergence }
//   vwapEma:  { aboveVwap, ema9Above20, ema20Above50, priceAboveEma50 }
//   liquidity:{ spreadPct, spreadOk, dollarVolumeOk }
//   regime:   'bullish' | 'neutral' | 'bearish' | 'high_volatility'
//   rules:    { weights, minScore, highQuality }
//   rvolTiers:{ min: 2.0, strong: 3.0, exceptional: 4.0 }
//
// Each bucket computes a 0–1 factor; score = Σ weight × factor, rounded.

const DEFAULT_WEIGHTS = Object.freeze({
  breakoutQuality: 20, volumeConfirmation: 20, rvol: 15,
  priceStructure: 10, htfTrend: 10, momentum: 10,
  vwapEma: 5, liquiditySpread: 5, regime: 5,
});
const DEFAULT_RULES = Object.freeze({
  minScore: 75,
  highQuality: 85,
  weights: DEFAULT_WEIGHTS,
});
const finite = v => Number.isFinite(+v) ? +v : null;
const clamp01 = v => Math.min(1, Math.max(0, v));

function scoreBreakout({
  breakout = {}, volume = {}, structure = {}, htf = {},
  momentum = {}, vwapEma = {}, liquidity = {},
  regime = 'neutral', rvolTiers = null,
} = {}, rules = {}) {
  const r = { ...DEFAULT_RULES, ...rules, weights: { ...DEFAULT_WEIGHTS, ...(rules.weights || {}) } };
  const tiers = { min: 2.0, strong: 3.0, exceptional: 4.0, ...(rules.rvolTiers || {}), ...(rvolTiers || {}) };
  const reasons = [];
  const factors = {};
  const award = (key, factor, reason) => {
    factors[key] = clamp01(factor);
    reasons.push(reason);
  };

  // Breakout quality (20): the core setup — close above resistance matters
  // most (a wick alone never qualifies), then breakout size in ATRs,
  // resistance tests, and a retest bonus.
  {
    let f = 0;
    if (breakout.closeAboveResistance === true) f += 0.45;
    if (breakout.confirmed === true) f += 0.15;
    const atrSize = finite(breakout.breakoutAtr);
    if (atrSize !== null) f += clamp01(atrSize / 1.5) * 0.2; // ~1.5 ATR = full marks
    const tests = finite(breakout.resistanceTests);
    if (tests !== null) f += clamp01(tests / 3) * 0.1;
    if (breakout.retest === true) f += 0.1;
    award('breakoutQuality', f,
      `breakout quality ${(f * 100).toFixed(0)}%: close-above=${!!breakout.closeAboveResistance}, ATR-size=${atrSize ?? 'n/a'}, tests=${tests ?? 'n/a'}, retest=${!!breakout.retest}`);
  }
  // Volume confirmation (20): prefer price↑ + volume↑ + RVOL↑ + momentum↑.
  // Downgrade price↑ + volume↓ + RVOL↓ unless a continuation/retest setup.
  {
    const rv = finite(volume.rvol);
    const rvolScore = rv === null ? 0 : rv >= tiers.exceptional ? 1 : rv >= tiers.strong ? 0.75 : rv >= tiers.min ? 0.5 : clamp01(rv / tiers.min) * 0.5;
    let f = rvolScore * 0.6;
    if (volume.volumeRising === true) f += 0.2;
    if (volume.priceUp === true) f += 0.2;
    if (breakout.retest === true && volume.priceUp === true && f < 0.35) f = 0.35; // retest continuation gets a floor, not a pass
    award('volumeConfirmation', f,
      `volume confirmation ${(f * 100).toFixed(0)}%: RVOL=${rv === null ? 'n/a' : rv.toFixed(2) + 'x'}, volumeRising=${!!volume.volumeRising}, priceUp=${!!volume.priceUp}`);
  }
  // RVOL tier (15): 2.0 = half marks, 3.0 = strong, 4.0+ = exceptional.
  {
    const rv = finite(volume.rvol);
    const f = rv === null ? 0 : rv >= tiers.exceptional ? 1 : rv >= tiers.strong ? 0.75 : rv >= tiers.min ? 0.5 : clamp01(rv / tiers.min) * 0.5;
    award('rvol', f, `RVOL tier ${(f * 100).toFixed(0)}%: ${rv === null ? 'n/a' : rv.toFixed(2) + 'x'} (tiers ${tiers.min}/${tiers.strong}/${tiers.exceptional})`);
  }
  // Price structure (10): higher-high / higher-low structure preferred.
  {
    const t = structure.trend;
    let f = t === 'uptrend' ? 1 : t === 'range' ? 0.5 : t === 'downtrend' ? 0.15 : 0.4;
    award('priceStructure', f, `price structure ${(f * 100).toFixed(0)}%: ${t || 'unknown'}`);
  }
  // Higher-timeframe trend (10): never blindly buy on one chart alone.
  {
    let f = htf.trend === 'bullish' ? 0.7 : htf.trend === 'neutral' ? 0.4 : htf.trend === 'bearish' ? 0.1 : 0.3;
    if (htf.aboveEma200 === true) f += 0.15;
    if (htf.emaAligned === true) f += 0.15;
    award('htfTrend', f, `HTF trend ${(f * 100).toFixed(0)}%: ${htf.trend || 'unknown'}, aboveEMA200=${!!htf.aboveEma200}, emaAligned=${!!htf.emaAligned}`);
  }
  // Momentum (10): RSI sweet spot, MACD confirmation, divergence penalty.
  {
    const rsi = finite(momentum.rsi);
    let f;
    if (rsi === null) f = 0.25;
    else if (rsi >= 55 && rsi <= 75) f = 0.5;
    else if (rsi >= 45 && rsi < 55) f = 0.35;
    else if (rsi > 75 && rsi <= 85) f = 0.35;
    else if (rsi < 45) f = 0.1;
    else f = 0.15; // > 85: overbought — don't predict the top, but don't chase either
    if (momentum.macdPositive === true) f += 0.25;
    if (momentum.macdHistRising === true) f += 0.25;
    if (momentum.bearishDivergence === true) f = Math.max(0, f - 0.4);
    award('momentum', f, `momentum ${(f * 100).toFixed(0)}%: RSI=${rsi === null ? 'n/a' : rsi.toFixed(1)}, MACD+=${!!momentum.macdPositive}, histRising=${!!momentum.macdHistRising}, bearDiv=${!!momentum.bearishDivergence}`);
  }
  // VWAP/EMA (5): price above VWAP and stacked EMAs (9 > 20 > 50).
  {
    let f = 0;
    if (vwapEma.aboveVwap === true) f += 0.4;
    if (vwapEma.ema9Above20 === true) f += 0.25;
    if (vwapEma.ema20Above50 === true) f += 0.2;
    if (vwapEma.priceAboveEma50 === true) f += 0.15;
    award('vwapEma', f, `VWAP/EMA ${(f * 100).toFixed(0)}%: aboveVWAP=${!!vwapEma.aboveVwap}, 9>20=${!!vwapEma.ema9Above20}, 20>50=${!!vwapEma.ema20Above50}`);
  }
  // Liquidity/spread (5): tradeable only when the spread is sane.
  {
    let f = 0;
    if (liquidity.spreadOk === true) f += 0.5;
    if (liquidity.dollarVolumeOk === true) f += 0.5;
    award('liquiditySpread', f, `liquidity/spread ${(f * 100).toFixed(0)}%: spread=${liquidity.spreadPct == null ? 'n/a' : (+liquidity.spreadPct).toFixed(3) + '%'}, ok=${!!liquidity.spreadOk}, dollarVolOk=${!!liquidity.dollarVolumeOk}`);
  }
  // Regime (5): BTC regime gates altcoin breakouts.
  {
    const f = regime === 'bullish' ? 1 : regime === 'neutral' ? 0.6 : regime === 'high_volatility' ? 0.3 : regime === 'bearish' ? 0.2 : 0.5;
    award('regime', f, `regime ${(f * 100).toFixed(0)}%: ${regime}`);
  }

  const breakdown = {};
  let score = 0;
  for (const [key, weight] of Object.entries(r.weights)) {
    const pts = Math.round((factors[key] ?? 0) * weight * 10) / 10;
    breakdown[key] = pts;
    score += pts;
  }
  score = Math.round(score * 10) / 10;
  const minRequired = minScoreForRegime(regime, r.minScore);
  return {
    score,
    breakdown,
    reasons,
    minRequired,
    meetsMinimum: score >= minRequired,
    highQuality: score >= r.highQuality,
  };
}

// Score-threshold adjustments per BTC regime (spec §10): bearish and
// high-volatility regimes raise the bar; bullish keeps the base.
function minScoreForRegime(regime, base = 75) {
  if (regime === 'high_volatility') return base + 15;
  if (regime === 'bearish') return base + 10;
  return base;
}
// Volume requirement multiplier per regime: bearish regimes demand
// stronger volume confirmation on altcoin breakouts.
function rvolRequirementMultiplier(regime) {
  if (regime === 'high_volatility') return 1.5;
  if (regime === 'bearish') return 1.25;
  return 1;
}

module.exports = {
  DEFAULT_WEIGHTS, DEFAULT_RULES, scoreBreakout,
  minScoreForRegime, rvolRequirementMultiplier,
};
