'use strict';
const { analyzeMomentumPatterns } = require('./momentum-patterns');

/**
 * Deterministic, long-only price-action setup recognition.
 *
 * This is a conservative translation of compatible SMB-style concepts:
 * breakout/continuation, controlled pullback, failed-break reclaim, and
 * confirmed extreme-move reversal. It deliberately does not infer tape,
 * Level 2, short, inverse-ETF, or RSI-only signals.
 */

// Do not let JavaScript coerce null or an empty string to zero. Price-action
// evidence must be explicitly present; silently treating a missing OHLCV field
// as zero can create a fake bullish candle or inflate its volume ratio.
const finite = value => value !== null
  && value !== undefined
  && !(typeof value === 'string' && value.trim() === '')
  && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function validCandle(bar) {
  if (!bar || ![bar.o, bar.h, bar.l, bar.c, bar.v].every(finite)) return false;
  const [o, h, l, c, v] = [bar.o, bar.h, bar.l, bar.c, bar.v].map(Number);
  return o > 0 && h > 0 && l > 0 && c > 0 && v > 0
    && h >= l && h >= o && h >= c && l <= o && l <= c;
}

function ema(values, period) {
  const clean = values.map(num).filter(value => value != null);
  if (clean.length < period) return null;
  const k = 2 / (period + 1);
  let result = clean.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < clean.length; i++) result = clean[i] * k + result * (1 - k);
  return result;
}

function vwapForBars(bars) {
  let pv = 0;
  let volume = 0;
  for (const bar of bars) {
    if (![bar.h, bar.l, bar.c, bar.v].every(finite) || Number(bar.v) <= 0) continue;
    pv += ((Number(bar.h) + Number(bar.l) + Number(bar.c)) / 3) * Number(bar.v);
    volume += Number(bar.v);
  }
  return volume > 0 ? pv / volume : null;
}

function average(values) {
  const valid = values.map(num).filter(value => value != null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function pctDistance(price, level) {
  return finite(price) && finite(level) && Number(level) !== 0
    ? Math.abs((Number(price) - Number(level)) / Number(level)) * 100
    : null;
}

function levelFromInput(value) {
  if (finite(value)) return Number(value);
  if (finite(value?.price)) return Number(value.price);
  return null;
}

function unavailable(reasons, evidence = {}) {
  return {
    strategy: 'smb-compatible-long-v1',
    direction: 'LONG_ONLY',
    status: 'NO TRADE',
    eligible: false,
    setup: null,
    thesis: null,
    invalidation: null,
    target: null,
    reasons: [...new Set(reasons)],
    evidence,
  };
}

function evaluatePriceActionSetup({
  symbol = '',
  bars = [],
  price = null,
  vwap = null,
  market = {},
  relativeStrength = null,
  freshness = null,
  support = null,
  resistance = null,
  minBars = 20,
} = {}) {
  const sourceBars = Array.isArray(bars) ? bars : [];
  const cleanBars = sourceBars
    .filter(validCandle)
    .map(bar => ({ ...bar, o: Number(bar.o), h: Number(bar.h), l: Number(bar.l), c: Number(bar.c), v: Number(bar.v) }))
    .filter(validCandle);
  const currentPrice = num(price) ?? cleanBars.at(-1)?.c ?? null;
  const baseEvidence = { bars: cleanBars.length, currentPrice };
  const reasons = [];
  if (!String(symbol).trim()) reasons.push('Symbol is unavailable.');
  if (cleanBars.length !== sourceBars.length) reasons.push('5-minute candle evidence is incomplete or malformed.');
  if (cleanBars.length < minBars) reasons.push(`At least ${minBars} completed 5-minute bars are required.`);
  if (freshness?.fresh !== true) reasons.push('5-minute price-action data is stale or unavailable.');
  if (!finite(currentPrice) || currentPrice <= 0) reasons.push('Current price is unavailable.');
  if (reasons.length) return unavailable(reasons, baseEvidence);

  const last = cleanBars.at(-1);
  const prior = cleanBars.slice(0, -1);
  const closes = cleanBars.map(bar => bar.c);
  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const suppliedVwap = num(vwap);
  const currentVwap = suppliedVwap ?? vwapForBars(cleanBars);
  const referenceHigh = Math.max(...prior.slice(-20).map(bar => bar.h));
  const referenceLow = Math.min(...prior.slice(-20).map(bar => bar.l));
  const priorVolumes = prior.slice(-10).map(bar => bar.v);
  const averagePriorVolume = average(priorVolumes);
  const volumeRatio = averagePriorVolume > 0 ? last.v / averagePriorVolume : null;
  const lastRange = Math.max(last.h - last.l, Number.EPSILON);
  const bullishClose = last.c > last.o && (last.c - last.l) / lastRange >= 0.6;
  const bodyRatio = Math.abs(last.c - last.o) / lastRange;
  const maxRecentHigh = Math.max(...prior.slice(-5).map(bar => bar.h));
  const minRecentLow = Math.min(...prior.slice(-5).map(bar => bar.l));
  const supportLevel = levelFromInput(support);
  const resistanceLevel = levelFromInput(resistance);
  const breakoutLevel = resistanceLevel != null && resistanceLevel < currentPrice * 1.02
    ? resistanceLevel
    : referenceHigh;
  const reclaimLevel = resistanceLevel ?? referenceHigh;
  const near = (a, b, pct = 1.2) => finite(a) && finite(b) && pctDistance(a, b) <= pct;
  const strongVolume = volumeRatio != null && volumeRatio >= 1.35;
  const expandingVolume = volumeRatio != null && volumeRatio >= 1.5;
  const marketTrend = String(market.trend || market.regime || 'UNKNOWN').toUpperCase();
  const marketContradiction = marketTrend === 'BEARISH' && relativeStrength !== true;

  const evidence = {
    ...baseEvidence,
    ema9: ema9 == null ? null : +ema9.toFixed(4),
    ema20: ema20 == null ? null : +ema20.toFixed(4),
    vwap: currentVwap == null ? null : +currentVwap.toFixed(4),
    referenceHigh: +referenceHigh.toFixed(4),
    referenceLow: +referenceLow.toFixed(4),
    breakoutLevel: +breakoutLevel.toFixed(4),
    volumeRatio: volumeRatio == null ? null : +volumeRatio.toFixed(2),
    marketTrend,
    relativeStrength: relativeStrength ?? null,
    patternAnalysis: analyzeMomentumPatterns(cleanBars),
  };

  if (currentVwap == null) reasons.push('VWAP is unavailable.');
  if (ema9 == null || ema20 == null) reasons.push('Short-term moving averages are unavailable.');
  if (volumeRatio == null) reasons.push('Recent volume baseline is unavailable.');
  if (marketContradiction) reasons.push('Market context is bearish without confirmed relative strength.');
  if (relativeStrength !== true) reasons.push(relativeStrength === false
    ? 'The stock is underperforming its comparison market.'
    : 'Relative strength is unavailable; do not infer a long-side edge.');

  // Reject chasing before selecting a setup. This keeps a valid historical
  // breakout from becoming a late market order several percent above its level.
  const chaseReference = Math.max(breakoutLevel, currentVwap ?? 0, ema9 ?? 0);
  const chasePct = pctDistance(currentPrice, chaseReference);
  const extended = chasePct != null && chasePct > 3;

  let selected = null;
  const priorWindow = prior.slice(-8);
  const hadFailedBreak = priorWindow.some((bar, index) =>
    index >= 2 && bar.h > reclaimLevel && bar.c < reclaimLevel
  );
  const reclaim = hadFailedBreak && last.c > reclaimLevel && bullishClose && strongVolume;

  const pullbackTouch = prior.slice(-6).some(bar =>
    near(bar.l, ema9, 1.25) || near(bar.l, currentVwap, 1.25) || near(bar.l, supportLevel, 1.25)
  );
  const pullbackVolume = average(prior.slice(-5, -1).map(bar => bar.v));
  const pullbackContracted = pullbackVolume != null && averagePriorVolume != null
    && pullbackVolume <= averagePriorVolume * 1.1;
  const pullback = ema9 != null && ema20 != null && ema9 > ema20
    && pullbackTouch && pullbackContracted && bullishClose && strongVolume
    && currentPrice > ema9;

  const breakout = currentPrice > breakoutLevel * 1.001
    && bullishClose && bodyRatio >= 0.35 && expandingVolume;

  const priorExtremeLow = Math.min(...prior.slice(-8).map(bar => bar.l));
  const extremeMovePct = ema20 ? (ema20 - priorExtremeLow) / ema20 * 100 : 0;
  const reversal = extremeMovePct >= 2.5 && bullishClose && strongVolume
    && currentPrice > (currentVwap ?? ema9 ?? 0)
    && currentPrice > (ema9 ?? 0);

  if (!extended && reclaim) {
    selected = { type: 'FAILED_BREAK_RECLAIM', label: 'Failed-break reclaim', trigger: reclaimLevel };
  } else if (!extended && breakout) {
    selected = { type: 'BREAKOUT_CONTINUATION', label: 'Breakout continuation', trigger: breakoutLevel };
  } else if (!extended && pullback) {
    selected = { type: 'CONTROLLED_PULLBACK', label: 'Controlled pullback', trigger: ema9 ?? currentVwap };
  } else if (!extended && reversal) {
    selected = { type: 'EXTREME_MOVE_REVERSAL', label: 'Confirmed extreme-move reversal', trigger: currentPrice };
  }

  if (extended) reasons.push(`Price is extended ${chasePct.toFixed(1)}% above the active reference; do not chase.`);
  if (!selected) reasons.push('No confirmed compatible long-side price-action setup is present.');

  const setupLow = selected?.type === 'BREAKOUT_CONTINUATION'
    ? Math.min(last.l, ...prior.slice(-3).map(bar => bar.l))
    : selected?.type === 'FAILED_BREAK_RECLAIM'
      ? Math.min(last.l, ...priorWindow.slice(-3).map(bar => bar.l))
      : selected?.type === 'CONTROLLED_PULLBACK'
        ? Math.min(...prior.slice(-6).map(bar => bar.l))
        : selected?.type === 'EXTREME_MOVE_REVERSAL'
          ? Math.min(last.l, priorExtremeLow)
          : null;
  const invalidation = finite(setupLow) ? +(setupLow - Math.max(setupLow * 0.002, (last.h - last.l) * 0.25)).toFixed(4) : null;
  const targetLevel = resistanceLevel != null && resistanceLevel > currentPrice
    ? resistanceLevel
    : currentPrice + (invalidation != null ? currentPrice - invalidation : currentPrice * 0.015) * 2;
  const risk = invalidation != null ? currentPrice - invalidation : null;
  const reward = targetLevel - currentPrice;
  const riskReward = risk > 0 && reward > 0 ? +(reward / risk).toFixed(2) : null;

  const blockedByContext = currentVwap == null || ema9 == null || ema20 == null || volumeRatio == null
    || marketContradiction || relativeStrength !== true;
  const eligible = !blockedByContext && !!selected && invalidation != null && risk > 0 && riskReward != null && riskReward >= 1.5;
  if (selected && riskReward != null && riskReward < 1.5) reasons.push(`Defined target offers only ${riskReward.toFixed(2)}R; minimum is 1.50R.`);
  if (selected && invalidation == null) reasons.push('Structural invalidation level is unavailable.');

  return {
    strategy: 'smb-compatible-long-v1',
    direction: 'LONG_ONLY',
    status: eligible ? 'TRADE ELIGIBLE' : selected ? 'SETUP CONFIRMED — WAIT' : 'NO TRADE',
    eligible,
    setup: selected,
    thesis: selected
      ? `${selected.label}${evidence.patternAnalysis.best ? ` with ${evidence.patternAnalysis.best.type.replaceAll('_', ' ').toLowerCase()} confluence` : ''}, ${expandingVolume ? 'expanding' : 'supportive'} volume, VWAP context, and structural risk below the setup.`
      : null,
    invalidation,
    target: finite(targetLevel) ? +targetLevel.toFixed(4) : null,
    riskReward,
    reasons: [...new Set(reasons)],
    evidence: {
      ...evidence,
      bullishClose,
      bodyRatio: +bodyRatio.toFixed(3),
      strongVolume,
      expandingVolume,
      chasePct: chasePct == null ? null : +chasePct.toFixed(2),
      extremeMovePct: +extremeMovePct.toFixed(2),
      priorFailedBreak: hadFailedBreak,
      pullbackContracted,
    },
  };
}

module.exports = { evaluatePriceActionSetup };