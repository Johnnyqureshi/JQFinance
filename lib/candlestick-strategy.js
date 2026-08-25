'use strict';

/**
 * Side-effect-free candlestick decision engine.  The final bar supplied to an
 * evaluation is the confirmation bar; the pattern itself is deliberately read
 * from the preceding, completed bar.  This makes it suitable for both live
 * decisions and replay without using a bar's future.
 */

const DEFAULT_CANDLE_CONFIG = Object.freeze({
  minBars: 20,
  lookback: 15,
  volumeLookback: 10,
  minRelativeVolume: 1.2,
  minScore: 65,
  minRewardRisk: 2,
  breakoutStrength: 82,
  supportTolerancePct: 0.6,
  maxOutcomeBars: 12,
});

const finite = value => value !== null && value !== undefined
  && !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value));
const number = value => finite(value) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = value => Number.isFinite(value) ? +value.toFixed(4) : null;

function validBar(bar) {
  if (!bar || ![bar.o, bar.h, bar.l, bar.c, bar.v].every(finite)) return false;
  const [o, h, l, c, v] = [bar.o, bar.h, bar.l, bar.c, bar.v].map(Number);
  return o > 0 && h >= Math.max(o, c) && l <= Math.min(o, c) && l > 0 && v > 0;
}

function cleanBars(bars) {
  return Array.isArray(bars) ? bars.filter(validBar).map(bar => ({
    ...bar, o: +bar.o, h: +bar.h, l: +bar.l, c: +bar.c, v: +bar.v,
  })) : [];
}

function vwapForBars(bars) {
  const clean = cleanBars(bars);
  let volume = 0;
  let priceVolume = 0;
  for (const bar of clean) {
    volume += bar.v;
    priceVolume += ((bar.h + bar.l + bar.c) / 3) * bar.v;
  }
  return volume ? round(priceVolume / volume) : null;
}

function aggregateTimeframeBars(bars, timeframeMs) {
  if (!Number.isFinite(Number(timeframeMs)) || Number(timeframeMs) <= 0) return [];
  const grouped = new Map();
  for (const bar of cleanBars(bars)) {
    const stamp = new Date(bar.t ?? bar.timestamp ?? bar.time).getTime();
    if (!Number.isFinite(stamp)) continue;
    const bucket = Math.floor(stamp / Number(timeframeMs)) * Number(timeframeMs);
    const current = grouped.get(bucket);
    if (!current) grouped.set(bucket, { ...bar, t: new Date(bucket).toISOString() });
    else {
      current.h = Math.max(current.h, bar.h);
      current.l = Math.min(current.l, bar.l);
      current.c = bar.c;
      current.v += bar.v;
    }
  }
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([, bar]) => bar);
}

function candleShape(bar) {
  const range = Math.max(bar.h - bar.l, Number.EPSILON);
  const body = Math.abs(bar.c - bar.o);
  const upper = bar.h - Math.max(bar.o, bar.c);
  const lower = Math.min(bar.o, bar.c) - bar.l;
  return { range, body, bodyRatio: body / range, upper, lower, bullish: bar.c > bar.o, bearish: bar.c < bar.o };
}

function classifyMarketRegime(bars) {
  const clean = cleanBars(bars);
  if (clean.length < 6) return { regime: 'UNKNOWN', trend: 'UNKNOWN', structure: 'UNKNOWN', strength: 0 };
  const closes = clean.map(bar => bar.c);
  const half = Math.floor(closes.length / 2);
  const change = (closes.at(-1) - closes[0]) / closes[0];
  const recentChange = (closes.at(-1) - closes[half]) / closes[half];
  const ranges = clean.map(bar => bar.h - bar.l);
  const averageRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const direction = change > 0.004 && recentChange > 0 ? 'BULLISH' : change < -0.004 && recentChange < 0 ? 'BEARISH' : 'NEUTRAL';
  let higherHighs = 0; let higherLows = 0; let lowerHighs = 0; let lowerLows = 0;
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].h > clean[i - 1].h) higherHighs++;
    if (clean[i].l > clean[i - 1].l) higherLows++;
    if (clean[i].h < clean[i - 1].h) lowerHighs++;
    if (clean[i].l < clean[i - 1].l) lowerLows++;
  }
  const structure = higherHighs + higherLows >= clean.length ? 'HIGHER_HIGHS_HIGHER_LOWS'
    : lowerHighs + lowerLows >= clean.length ? 'LOWER_HIGHS_LOWER_LOWS' : 'MIXED';
  const dispersion = Math.max(...closes) - Math.min(...closes);
  const choppy = Math.abs(change) < 0.006 && dispersion <= averageRange * 3.2;
  const strength = clamp(Math.round((Math.abs(change) * 100 * 10) + (Math.abs(recentChange) * 100 * 7)), 0, 100);
  return {
    regime: choppy ? 'CHOPPY' : direction,
    trend: direction,
    structure,
    strength,
    changePct: round(change * 100),
    averageRange: round(averageRange),
  };
}

function suppliedLevel(value) {
  if (finite(value)) return +value;
  if (finite(value?.price)) return +value.price;
  return null;
}

function timeframeEvidence(input, primaryBars) {
  const frames = input.timeframes && typeof input.timeframes === 'object' ? input.timeframes : null;
  if (frames) {
    const entries = Object.values(frames);
    return entries.map(frame => ({
      bars: cleanBars(frame?.bars || []).length,
      fresh: frame?.fresh === true || frame?.freshness?.fresh === true,
    }));
  }
  const higher = cleanBars(input.higherTimeframeBars || input.higherBars || []);
  const fresh = input.freshness || {};
  return [
    { bars: primaryBars.length, fresh: fresh.primary === true || fresh.bars === true || fresh.fresh === true },
    { bars: higher.length, fresh: fresh.higher === true || fresh.higherTimeframe === true || fresh.multiTimeframe === true },
  ];
}

function evaluateCandlestickSetup(input = {}, suppliedConfig = {}) {
  const config = { ...DEFAULT_CANDLE_CONFIG, ...(suppliedConfig || {}) };
  config.minScore = clamp(Number(config.minScore) || DEFAULT_CANDLE_CONFIG.minScore, 0, 100);
  const source = Array.isArray(input.bars) ? input.bars : [];
  const bars = cleanBars(source);
  const reasons = [];
  if (!String(input.symbol || '').trim()) reasons.push('Symbol is unavailable.');
  if (bars.length !== source.length) reasons.push('Completed OHLCV bars are incomplete or malformed.');
  if (bars.length < config.minBars) reasons.push(`At least ${config.minBars} completed bars are required.`);
  const frames = timeframeEvidence(input, bars);
  if (frames.length < 2 || frames.some(frame => !frame.fresh || frame.bars < 2)) reasons.push('Fresh multi-timeframe data is required.');
  if (reasons.length) return unavailable(reasons, bars, config);

  const signal = bars.at(-2);
  const trigger = bars.at(-1);
  const prior = bars.slice(0, -2);
  const window = prior.slice(-config.lookback);
  const previous = prior.at(-1);
  const shape = candleShape(signal);
  const priorShape = candleShape(previous);
  const signalVwap = vwapForBars(bars.slice(0, -1));
  const support = suppliedLevel(input.support) ?? Math.min(...window.map(bar => bar.l));
  const resistance = suppliedLevel(input.resistance) ?? Math.max(...window.map(bar => bar.h));
  const volumeBase = prior.slice(-config.volumeLookback).reduce((sum, bar) => sum + bar.v, 0) / Math.min(prior.length, config.volumeLookback);
  const relativeVolume = volumeBase > 0 ? signal.v / volumeBase : null;
  const nearSupport = Math.abs(signal.l - support) / support * 100 <= config.supportTolerancePct;
  const nearResistance = Math.abs(signal.h - resistance) / resistance * 100 <= config.supportTolerancePct;
  const bullishEngulfing = previous.c < previous.o && shape.bullish && signal.o <= previous.c && signal.c >= previous.o;
  const bearishEngulfing = previous.c > previous.o && shape.bearish && signal.o >= previous.c && signal.c <= previous.o;
  const hammer = shape.bullish && shape.lower >= shape.body * 2 && shape.upper <= Math.max(shape.body, shape.range * 0.2);
  const shootingStar = shape.bearish && shape.upper >= shape.body * 2 && shape.lower <= Math.max(shape.body, shape.range * 0.2);
  const three = bars.slice(-4, -1);
  const morningStar = three.length === 3 && three[0].c < three[0].o
    && candleShape(three[1]).bodyRatio <= .35 && signal.c > (three[0].o + three[0].c) / 2;
  const eveningStar = three.length === 3 && three[0].c > three[0].o
    && candleShape(three[1]).bodyRatio <= .35 && signal.c < (three[0].o + three[0].c) / 2;
  const strongBull = shape.bullish && shape.bodyRatio >= .65 && signal.c >= signal.l + shape.range * .8;
  const strongBear = shape.bearish && shape.bodyRatio >= .65 && signal.c <= signal.h - shape.range * .8;
  const supportReversal = nearSupport && (hammer || bullishEngulfing || morningStar);
  const resistanceReversal = nearResistance && (shootingStar || bearishEngulfing || eveningStar);
  const breakout = signal.c > resistance && strongBull;
  const breakdown = signal.c < support && strongBear;
  const failedBreakout = signal.h > resistance && signal.c < resistance;
  const failedBreakdown = signal.l < support && signal.c > support;
  const regime = classifyMarketRegime(prior);
  const longPatterns = { bullishEngulfing, hammer, morningStar, strongMomentum: strongBull, supportReversal, breakout, failedBreakdown };
  const shortPatterns = { bearishEngulfing, shootingStar, eveningStar, strongMomentum: strongBear, resistanceReversal, breakdown, failedBreakout };
  const longPoints = Object.values(longPatterns).filter(Boolean).length;
  const shortPoints = Object.values(shortPatterns).filter(Boolean).length;
  const direction = longPoints > shortPoints ? 'LONG' : shortPoints > longPoints ? 'SHORT' : null;
  const isLong = direction === 'LONG';
  const confirmation = isLong ? trigger.c > signal.h : direction === 'SHORT' ? trigger.c < signal.l : false;
  const trendAligned = isLong ? regime.trend === 'BULLISH' : direction === 'SHORT' ? regime.trend === 'BEARISH' : false;
  const highStrengthBreak = (breakout || breakdown) && shape.bodyRatio >= .75 && (relativeVolume ?? 0) >= 1.5;
  const patternCount = Math.max(longPoints, shortPoints);
  const score = clamp(
    patternCount * 18 + (confirmation ? 18 : 0) + (trendAligned ? 12 : 0)
      + ((relativeVolume ?? 0) >= config.minRelativeVolume ? 10 : 0)
      + ((isLong ? signal.c > signalVwap : direction === 'SHORT' ? signal.c < signalVwap : false) ? 8 : 0)
      + (highStrengthBreak ? 12 : 0),
    0, 100
  );
  const entry = trigger.c;
  const stop = direction === 'LONG' ? Math.min(signal.l, trigger.l) : direction === 'SHORT' ? Math.max(signal.h, trigger.h) : null;
  const risk = direction === 'LONG' ? entry - stop : direction === 'SHORT' ? stop - entry : null;
  const candidateTarget = direction === 'LONG'
    ? (suppliedLevel(input.target) ?? suppliedLevel(input.resistanceTarget))
    : (suppliedLevel(input.target) ?? suppliedLevel(input.supportTarget));
  const target = risk > 0 ? (candidateTarget != null && (direction === 'LONG' ? candidateTarget > entry : candidateTarget < entry)
    ? candidateTarget : entry + (direction === 'LONG' ? 1 : -1) * risk * config.minRewardRisk) : null;
  const reward = direction === 'LONG' ? target - entry : stop - target;
  const riskReward = risk > 0 && reward > 0 ? reward / risk : null;
  if (!direction) reasons.push('No directional candlestick pattern is present.');
  if (!confirmation) reasons.push('Awaiting confirmed next-candle trigger.');
  if (relativeVolume == null || relativeVolume < config.minRelativeVolume) reasons.push('Relative volume is insufficient.');
  if (regime.regime === 'CHOPPY' || regime.regime === 'NEUTRAL') {
    if (!highStrengthBreak) reasons.push('Choppy or neutral market regime rejects this setup.');
  }
  if (!(riskReward >= config.minRewardRisk)) reasons.push(`Reward must be at least ${config.minRewardRisk}R.`);
  if (score < config.minScore) reasons.push(`Score ${score} is below minimum ${config.minScore}.`);
  const eligible = reasons.length === 0;
  return {
    strategy: 'candlestick-automation-v1', symbol: String(input.symbol || '').toUpperCase(), direction,
    status: eligible ? 'TRADE ELIGIBLE' : direction ? 'SETUP CONFIRMED — WAIT' : 'NO TRADE',
    eligible, score, config, reasons: [...new Set(reasons)],
    entry: round(entry), stop: round(stop), target: round(target), riskReward: round(riskReward),
    evidence: { vwap: signalVwap, relativeVolume: round(relativeVolume), support: round(support), resistance: round(resistance),
      regime, trendAligned, confirmation, breakout, breakdown, failedBreakout, failedBreakdown,
      patterns: direction === 'SHORT' ? shortPatterns : longPatterns },
  };
}

function unavailable(reasons, bars, config) {
  return { strategy: 'candlestick-automation-v1', direction: null, status: 'NO TRADE', eligible: false,
    score: 0, config, reasons: [...new Set(reasons)], entry: null, stop: null, target: null, riskReward: null,
    evidence: { bars: bars.length } };
}

function simulateCandlestickBacktest(input = {}, suppliedConfig = {}) {
  const bars = cleanBars(input.bars);
  const config = { ...DEFAULT_CANDLE_CONFIG, ...(suppliedConfig || {}) };
  const records = [];
  for (let decisionIndex = config.minBars - 1; decisionIndex < bars.length - 1; decisionIndex++) {
    const decisionBars = bars.slice(0, decisionIndex + 1);
    const setup = evaluateCandlestickSetup({
      ...input, bars: decisionBars,
      // Rebuild both frames from the decision slice.  In particular, never
      // pass caller-provided full-history timeframe arrays into a replay.
      timeframes: {
        primary: { bars: decisionBars, fresh: true },
        higher: { bars: aggregateTimeframeBars(decisionBars, input.higherTimeframeMs || 900000), fresh: true },
      },
      freshness: { ...(input.freshness || {}), primary: true, higher: true },
    }, config);
    if (!setup.eligible) continue;
    const future = bars.slice(decisionIndex + 1, decisionIndex + 1 + config.maxOutcomeBars);
    let outcome = 'OPEN'; let exitIndex = null;
    for (let offset = 0; offset < future.length; offset++) {
      const bar = future[offset];
      const stopHit = setup.direction === 'LONG' ? bar.l <= setup.stop : bar.h >= setup.stop;
      const targetHit = setup.direction === 'LONG' ? bar.h >= setup.target : bar.l <= setup.target;
      if (stopHit || targetHit) { outcome = stopHit ? 'STOP' : 'TARGET'; exitIndex = decisionIndex + 1 + offset; break; }
    }
    records.push({ decisionIndex, decisionBarCount: decisionBars.length, outcomeStartIndex: decisionIndex + 1,
      exitIndex, outcome, setup });
  }
  return { strategy: 'candlestick-automation-v1', records,
    summary: { trades: records.length, targets: records.filter(r => r.outcome === 'TARGET').length, stops: records.filter(r => r.outcome === 'STOP').length } };
}

module.exports = { DEFAULT_CANDLE_CONFIG, evaluateCandlestickSetup, aggregateTimeframeBars, vwapForBars, classifyMarketRegime, simulateCandlestickBacktest };