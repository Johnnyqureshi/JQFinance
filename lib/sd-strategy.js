'use strict';

// SINGLES & DOUBLES (S&D) intraday strategy — pure signal math, ZERO I/O.
// This module never touches the network, the database, the clock, or B2.
// It must stay importable by tests without side effects: no Date.now() at
// module scope, no Alpaca calls, no shared mutable state.
//
// Conventions mirror lib/b2-strategy.js:
//   - evaluate* returns {eligible, signal, gates:[{name, passed, reason}], reasons[], metrics{}}.
//   - build*Entry returns an Alpaca OTO order body (limit buy + stop loss).
//   - Bars use Alpaca shape {t, o, h, l, c, v}.
//   - VWAP is cumulative typical-price ((h+l+c)/3), same semantics as
//     lib/intraday-vwap.js. That module only exports a scalar "VWAP as of
//     now", so this file implements its own per-bar VWAP series
//     (computeVwapSeries) and notes the intentional duplication.

class SdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SdError';
  }
}

const SD_RULES = Object.freeze({
  minPrice: 5,
  maxPrice: 50,
  // Quality-score weights; they sum to 12 (the max score).
  scoreWeights: Object.freeze({
    vwapReclaimHold: 2,
    aboveVwap: 1,
    emaAlignment: 1,
    higherHigh: 1,
    higherLow: 1,
    rvol2x: 2,
    volumeExpansion: 2,
    spyBullish: 1,
    relativeStrength: 1,
  }),
  minScore: 7,
  neutralMinScoreBump: 1,
  bearishMinScoreBump: 2,
  bearishSizeMultiplier: 0.5,
  singleTargetPct: 1.0,   // configurable 0.75–1.25
  doubleTargetPct: 2.0,   // configurable 1.5–3.0
  partialSellPct: 50,
  extensionPct: 1.5,      // skip entry if price is more than this % above VWAP
  vwapBufferPct: 0.2,     // stop = VWAP − bufferPct (alternative to swing low)
  maxSpreadPct: 1.0,
  minAvgDollarVol: 1000000,
  minShareVolume: 100000,
  rvolThreshold: 2.0,
});

// The rejection funnel, in order. The service workstream records per-gate
// counters using these names; keep this list stable.
const GATE_ORDER = ['price_band', 'liquidity', 'spread', 'momentum', 'vwap', 'quality_score', 'risk'];

const finite = value => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value));
const num = value => (finite(value) ? Number(value) : NaN);
const round = (value, places = 6) => Number.isFinite(value) ? +value.toFixed(places) : null;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

function sma(series, n) {
  const values = (Array.isArray(series) ? series : []).map(Number).filter(Number.isFinite);
  if (values.length === 0 || !Number.isFinite(n) || n < 1) return NaN;
  const window = values.slice(-Math.floor(n));
  return mean(window);
}

function ema(series, n) {
  const values = (Array.isArray(series) ? series : []).map(Number).filter(Number.isFinite);
  if (values.length === 0 || !Number.isFinite(n) || n < 1) return NaN;
  const period = Math.floor(n);
  const k = 2 / (period + 1);
  let current = mean(values.slice(0, Math.min(period, values.length)));
  for (let i = Math.min(period, values.length); i < values.length; i += 1) {
    current = values[i] * k + current * (1 - k);
  }
  return current;
}

// Per-bar cumulative typical-price VWAP series, same semantics as
// calculateRegularSessionVwap in lib/intraday-vwap.js (which only exposes a
// scalar, hence this local series builder). Bars with zero/negative volume
// carry the previous VWAP forward; leading bars before any volume read null.
function computeVwapSeries(bars) {
  const input = Array.isArray(bars) ? bars : [];
  const series = new Array(input.length).fill(null);
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (let i = 0; i < input.length; i += 1) {
    const high = num(input[i]?.h);
    const low = num(input[i]?.l);
    const close = num(input[i]?.c);
    const volume = num(input[i]?.v);
    if (Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)
      && Number.isFinite(volume) && volume > 0) {
      cumulativePriceVolume += ((high + low + close) / 3) * volume;
      cumulativeVolume += volume;
    }
    series[i] = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : null;
  }
  return series;
}

// Defensive bar filter: drop bars with missing/invalid OHLCV, never throw.
function normalizeBars(bars) {
  return (Array.isArray(bars) ? bars : []).filter(bar => {
    const o = num(bar?.o); const h = num(bar?.h); const l = num(bar?.l);
    const c = num(bar?.c); const v = num(bar?.v);
    return [o, h, l, c].every(x => Number.isFinite(x) && x > 0)
      && Number.isFinite(v) && v >= 0
      && h >= Math.max(o, c) && l <= Math.min(o, c) && h >= l;
  });
}

// Lowest low over the last `lookback` bars (including the latest bar).
function recentSwingLow(bars, lookback = 10) {
  const input = normalizeBars(bars);
  if (input.length === 0) return NaN;
  const window = input.slice(-Math.max(1, Math.floor(lookback) || 1));
  return Math.min(...window.map(bar => Number(bar.l)));
}

function closesOf(bars) {
  return normalizeBars(bars).map(bar => Number(bar.c));
}

function higherHighs(bars, recent = 5) {
  const input = normalizeBars(bars);
  const n = Math.max(1, Math.floor(recent) || 1);
  if (input.length < n + 1) return false;
  const recentBars = input.slice(-n);
  const earlierBars = input.slice(-2 * n, -n);
  if (earlierBars.length === 0) return false;
  return Math.max(...recentBars.map(b => Number(b.h)))
    > Math.max(...earlierBars.map(b => Number(b.h)));
}

function higherLows(bars, recent = 5) {
  const input = normalizeBars(bars);
  const n = Math.max(1, Math.floor(recent) || 1);
  if (input.length < n + 1) return false;
  const recentBars = input.slice(-n);
  const earlierBars = input.slice(-2 * n, -n);
  if (earlierBars.length === 0) return false;
  return Math.min(...recentBars.map(b => Number(b.l)))
    > Math.min(...earlierBars.map(b => Number(b.l)));
}

// ---------------------------------------------------------------------------
// SPY regime classification
// ---------------------------------------------------------------------------

function classifySpyRegime({ spyDayChangePct, spyAboveVwap } = {}) {
  const change = num(spyDayChangePct);
  const above = spyAboveVwap === true;
  const below = spyAboveVwap === false;
  if (Number.isFinite(change) && change > 0 && above) return 'BULLISH';
  if (Number.isFinite(change) && change < 0 && below) return 'BEARISH';
  return 'NEUTRAL';
}

// ---------------------------------------------------------------------------
// Quality score (max 12)
// ---------------------------------------------------------------------------

const SCORE_LABELS = {
  vwapReclaimHold: 'VWAP reclaim & hold',
  aboveVwap: 'Above VWAP',
  emaAlignment: '9 EMA above 20 EMA',
  higherHigh: 'Higher highs',
  higherLow: 'Higher lows',
  rvol2x: 'Relative volume ≥ 2×',
  volumeExpansion: 'Volume expansion',
  spyBullish: 'SPY bullish regime',
  relativeStrength: 'Relative strength vs SPY',
};

function scoreCandidate({
  aboveVwap = false, vwapReclaimed = false, ema9AboveEma20 = false,
  higherHigh = false, higherLow = false, rvol = NaN, volumeExpanding = false,
  spyBullish = false, relativeStrengthVsSpy = false, weights = SD_RULES.scoreWeights,
} = {}) {
  const w = { ...SD_RULES.scoreWeights, ...(weights || {}) };
  const earned = {
    vwapReclaimHold: vwapReclaimed === true ? w.vwapReclaimHold : 0,
    aboveVwap: aboveVwap === true ? w.aboveVwap : 0,
    emaAlignment: ema9AboveEma20 === true ? w.emaAlignment : 0,
    higherHigh: higherHigh === true ? w.higherHigh : 0,
    higherLow: higherLow === true ? w.higherLow : 0,
    rvol2x: (Number.isFinite(num(rvol)) && num(rvol) >= SD_RULES.rvolThreshold) ? w.rvol2x : 0,
    volumeExpansion: volumeExpanding === true ? w.volumeExpansion : 0,
    spyBullish: spyBullish === true ? w.spyBullish : 0,
    relativeStrength: relativeStrengthVsSpy === true ? w.relativeStrength : 0,
  };
  const breakdown = Object.keys(SCORE_LABELS).map(key => ({
    key,
    label: SCORE_LABELS[key],
    earned: earned[key],
    max: w[key],
  }));
  const score = breakdown.reduce((sum, row) => sum + row.earned, 0);
  const maxScore = breakdown.reduce((sum, row) => sum + row.max, 0);
  return { score, maxScore, breakdown };
}

// ---------------------------------------------------------------------------
// Setup detectors
// ---------------------------------------------------------------------------

// Setup A — VWAP reclaim: price crossed below VWAP earlier in the session,
// reclaimed it, then held/retested (at least one subsequent bar touching or
// holding above VWAP), with volume expansion on the reclaim bars versus the
// breakdown bars.
function detectSetupA({ bars1m, vwapSeries } = {}) {
  const bars = normalizeBars(bars1m);
  const empty = detected => ({
    detected, detail: { crossBelowIdx: null, reclaimIdx: null, retestHolds: 0, volumeExpansion: null },
  });
  if (bars.length < 6) return empty(false);
  let vwap = Array.isArray(vwapSeries) && vwapSeries.length === bars.length
    ? vwapSeries : computeVwapSeries(bars);
  const above = idx => Number.isFinite(vwap[idx]) && Number(bars[idx].c) >= vwap[idx];
  const below = idx => Number.isFinite(vwap[idx]) && Number(bars[idx].c) < vwap[idx];

  let crossBelowIdx = null;
  for (let i = 1; i < bars.length; i += 1) {
    if (above(i - 1) && below(i)) { crossBelowIdx = i; break; }
  }
  if (crossBelowIdx === null) return empty(false);

  let reclaimIdx = null;
  for (let j = crossBelowIdx + 1; j < bars.length; j += 1) {
    if (below(j - 1) && above(j)) { reclaimIdx = j; break; }
  }
  if (reclaimIdx === null) return empty(false);

  let retestHolds = 0;
  for (let k = reclaimIdx + 1; k < bars.length; k += 1) {
    if (!Number.isFinite(vwap[k])) continue;
    const touchesOrHolds = Number(bars[k].l) <= vwap[k] && Number(bars[k].c) >= vwap[k];
    const staysAbove = Number(bars[k].l) >= vwap[k];
    if (touchesOrHolds || staysAbove) retestHolds += 1;
  }
  if (retestHolds < 1) return empty(false);

  const meanVolume = (from, to) => {
    const slice = bars.slice(Math.max(0, from), Math.min(bars.length, to));
    return slice.length > 0 ? mean(slice.map(b => Number(b.v))) : 0;
  };
  const reclaimVolume = meanVolume(reclaimIdx, reclaimIdx + 3);
  const breakdownVolume = meanVolume(crossBelowIdx - 2, crossBelowIdx + 1);
  const volumeExpansion = breakdownVolume > 0 ? reclaimVolume / breakdownVolume : null;
  if (!(volumeExpansion !== null && volumeExpansion > 1)) return empty(false);

  return {
    detected: true,
    detail: {
      crossBelowIdx, reclaimIdx, retestHolds,
      volumeExpansion: round(volumeExpansion, 3),
    },
  };
}

// Setup B — momentum continuation: price above VWAP with higher highs and
// higher lows over recent bars, short-term trend intact (9 EMA > 20 EMA),
// and not excessively extended above VWAP.
function detectSetupB({ bars1m, vwapSeries, extensionPct = SD_RULES.extensionPct } = {}) {
  const bars = normalizeBars(bars1m);
  const notDetected = (higherHigh, higherLow, extensionOk) => ({
    detected: false, detail: { higherHigh: !!higherHigh, higherLow: !!higherLow, extensionOk: !!extensionOk },
  });
  if (bars.length < 6) return notDetected(false, false, false);
  let vwap = Array.isArray(vwapSeries) && vwapSeries.length === bars.length
    ? vwapSeries : computeVwapSeries(bars);
  const lastIdx = bars.length - 1;
  const vwapNow = vwap[lastIdx];
  if (!Number.isFinite(vwapNow)) return notDetected(false, false, false);

  const higherHigh = higherHighs(bars, 5);
  const higherLow = higherLows(bars, 5);
  const closes = bars.map(b => Number(b.c));
  const trendIntact = ema(closes, 9) > ema(closes, 20);
  const ext = finite(extensionPct) ? Number(extensionPct) : SD_RULES.extensionPct;
  const extensionOk = closes[lastIdx] <= vwapNow * (1 + ext / 100);
  const aboveVwap = closes[lastIdx] >= vwapNow;

  const detected = aboveVwap && higherHigh && higherLow && trendIntact && extensionOk;
  return {
    detected,
    detail: { higherHigh, higherLow, extensionOk },
  };
}

// ---------------------------------------------------------------------------
// Full evaluation (the rejection funnel)
// ---------------------------------------------------------------------------

function evaluateSd({
  intradayBars, dailyBars = [], snapshot = {}, spyRegime = 'NEUTRAL',
  spreadPct = NaN, avgDollarVol = NaN, minScore = SD_RULES.minScore,
  settings = {},
} = {}) {
  const symbol = String(snapshot?.symbol || settings?.symbol || '').trim().toUpperCase() || null;
  const result = {
    symbol, eligible: false, signal: 'WAIT', setup: null,
    score: 0, maxScore: 12, effectiveMinScore: null, sizeMultiplier: 1,
    stopPrice: null, singleTarget: null, doubleTarget: null,
    riskPerShare: null, entryPrice: null,
    reasons: [], gates: [], metrics: {},
  };
  const gate = (name, passed, reason) => {
    const ok = passed === true;
    result.gates.push({ name, passed: ok, reason });
    if (!ok) result.reasons.push(reason);
  };

  const regime = ['BULLISH', 'NEUTRAL', 'BEARISH'].includes(spyRegime) ? spyRegime : 'NEUTRAL';
  const baseMin = finite(minScore) ? Number(minScore) : SD_RULES.minScore;
  const effectiveMinScore = baseMin
    + (regime === 'BEARISH' ? SD_RULES.bearishMinScoreBump
      : regime === 'NEUTRAL' ? SD_RULES.neutralMinScoreBump : 0);
  const sizeMultiplier = regime === 'BEARISH' ? SD_RULES.bearishSizeMultiplier : 1;
  result.effectiveMinScore = effectiveMinScore;
  result.sizeMultiplier = sizeMultiplier;

  const bars = normalizeBars(intradayBars);
  const closes = bars.map(b => Number(b.c));
  const lastClose = closes.length > 0 ? closes[closes.length - 1] : NaN;
  const ask = num(snapshot?.ask ?? snapshot?.latestQuote?.ap);
  const entryPrice = Number.isFinite(ask) ? ask : lastClose;
  result.entryPrice = round(entryPrice, 2);

  // Target percentages are configurable within their bands; clamp defensively.
  const singleTargetPct = clamp(finite(settings?.singleTargetPct) ? Number(settings.singleTargetPct) : SD_RULES.singleTargetPct, 0.75, 1.25);
  const doubleTargetPct = clamp(finite(settings?.doubleTargetPct) ? Number(settings.doubleTargetPct) : SD_RULES.doubleTargetPct, 1.5, 3.0);

  // ---- Shared measurements (computed once, used by gates and scoring) ----
  const vwapSeries = computeVwapSeries(bars);
  const vwapNow = vwapSeries.length > 0 ? vwapSeries[vwapSeries.length - 1] : null;

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const emaAligned = Number.isFinite(ema9) && Number.isFinite(ema20) && ema9 > ema20;
  const momentumPct5 = closes.length >= 6
    ? (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100 : NaN;
  const momentumOk = emaAligned
    || (Number.isFinite(momentumPct5) && momentumPct5 > 0);

  const daily = normalizeBars(dailyBars);
  // Exclude a possibly-still-forming latest daily bar from the baseline.
  const baseline = daily.length > 1 ? daily.slice(0, -1).slice(-20) : [];
  const meanDailyVolume = baseline.length > 0 ? mean(baseline.map(b => Number(b.v))) : NaN;
  const meanDailyDollarVol = baseline.length > 0
    ? mean(baseline.map(b => Number(b.c) * Number(b.v))) : NaN;
  const sessionVolume = bars.reduce((sum, b) => sum + Number(b.v), 0);
  const rvol = Number.isFinite(meanDailyVolume) && meanDailyVolume > 0
    ? sessionVolume / meanDailyVolume : NaN;

  const shareVolume = finite(snapshot?.volume) ? Number(snapshot.volume)
    : finite(snapshot?.dailyBar?.v) ? Number(snapshot.dailyBar.v)
      : sessionVolume;
  const dollarVol = finite(avgDollarVol) ? Number(avgDollarVol) : meanDailyDollarVol;

  const setupA = detectSetupA({ bars1m: bars, vwapSeries });
  const setupB = detectSetupB({ bars1m: bars, vwapSeries });
  // Setup A (VWAP reclaim) is the higher-conviction pattern when both fire.
  const setup = setupA.detected ? 'A' : (setupB.detected ? 'B' : null);
  result.setup = setup;

  const recentVol = bars.length >= 3 ? mean(bars.slice(-3).map(b => Number(b.v))) : NaN;
  const priorVol = bars.length >= 6 ? mean(bars.slice(-6, -3).map(b => Number(b.v))) : NaN;
  const volumeExpanding = Number.isFinite(recentVol) && Number.isFinite(priorVol)
    && priorVol > 0 && recentVol > priorVol;

  const scored = scoreCandidate({
    aboveVwap: Number.isFinite(vwapNow) && Number.isFinite(lastClose) && lastClose >= vwapNow,
    vwapReclaimed: setupA.detected,
    ema9AboveEma20: emaAligned,
    higherHigh: higherHighs(bars, 5),
    higherLow: higherLows(bars, 5),
    rvol,
    volumeExpanding,
    spyBullish: regime === 'BULLISH',
    // With only the regime available (not SPY's exact day change), credit
    // relative strength when the stock's own short-term momentum is positive
    // outside a bearish tape.
    relativeStrengthVsSpy: Number.isFinite(momentumPct5) && momentumPct5 > 0 && regime !== 'BEARISH',
  });
  result.score = scored.score;
  result.maxScore = scored.maxScore;

  const swingLow = recentSwingLow(bars, 10);
  const vwapStop = Number.isFinite(vwapNow)
    ? vwapNow * (1 - SD_RULES.vwapBufferPct / 100) : NaN;
  // Initial stop is the LOWER of swing low and the VWAP buffer stop.
  // This function only ever computes the initial stop; it never widens one.
  const stopCandidates = [swingLow, vwapStop]
    .filter(x => Number.isFinite(x) && x > 0);
  const stopPrice = stopCandidates.length > 0 ? Math.min(...stopCandidates) : NaN;
  result.stopPrice = Number.isFinite(stopPrice) ? round(stopPrice, 2) : null;

  const riskPerShare = Number.isFinite(entryPrice) && Number.isFinite(stopPrice)
    ? entryPrice - stopPrice : NaN;
  result.riskPerShare = Number.isFinite(riskPerShare) ? round(riskPerShare, 2) : null;
  result.singleTarget = Number.isFinite(entryPrice)
    ? round(entryPrice * (1 + singleTargetPct / 100), 2) : null;
  result.doubleTarget = Number.isFinite(entryPrice)
    ? round(entryPrice * (1 + doubleTargetPct / 100), 2) : null;

  result.metrics = {
    vwapNow: round(vwapNow), ema9: round(ema9), ema20: round(ema20),
    momentumPct5: round(momentumPct5), rvol: round(rvol),
    sessionVolume: round(sessionVolume), shareVolume: round(shareVolume),
    avgDollarVol: round(dollarVol), spreadPct: round(num(spreadPct)),
    swingLow: round(swingLow), vwapStop: round(vwapStop),
    setupADetail: setupA.detail, setupBDetail: setupB.detail,
    scoreBreakdown: scored.breakdown,
    singleTargetPct: round(singleTargetPct, 3), doubleTargetPct: round(doubleTargetPct, 3),
    spyRegime: regime, intradayBars: bars.length,
  };

  // ---- Gates (every candidate gets every gate entry: the rejection funnel) ----
  gate('price_band',
    Number.isFinite(entryPrice) && entryPrice >= SD_RULES.minPrice && entryPrice <= SD_RULES.maxPrice,
    `Entry price ${Number.isFinite(entryPrice) ? `$${entryPrice.toFixed(2)}` : 'unavailable'} is outside the $${SD_RULES.minPrice}–$${SD_RULES.maxPrice} band.`);
  gate('liquidity',
    Number.isFinite(dollarVol) && dollarVol >= SD_RULES.minAvgDollarVol
    && Number.isFinite(shareVolume) && shareVolume >= SD_RULES.minShareVolume,
    'Average dollar volume is below $1m or fewer than 100,000 shares have traded.');
  gate('spread',
    Number.isFinite(num(spreadPct)) && num(spreadPct) >= 0 && num(spreadPct) <= SD_RULES.maxSpreadPct,
    `Bid/ask spread ${Number.isFinite(num(spreadPct)) ? `${num(spreadPct).toFixed(2)}%` : 'unavailable'} exceeds ${SD_RULES.maxSpreadPct}%.`);
  gate('momentum', momentumOk === true,
    'No positive short-term momentum: 9 EMA is not above 20 EMA and 5-bar momentum is not rising.');
  gate('vwap', setup !== null,
    'No S&D setup: neither a VWAP reclaim (A) nor momentum continuation (B) was detected.');
  gate('quality_score', scored.score >= effectiveMinScore,
    `Quality score ${scored.score}/${scored.maxScore} is below the effective minimum of ${effectiveMinScore} (SPY regime: ${regime}).`);
  gate('risk',
    Number.isFinite(stopPrice) && stopPrice > 0
    && Number.isFinite(riskPerShare) && riskPerShare > 0
    && Number.isFinite(entryPrice) && riskPerShare / entryPrice <= 0.10,
    'Initial stop is not computable or risk per share is non-positive/outside sane bounds.');

  result.eligible = result.gates.every(g => g.passed);
  if (result.eligible) {
    result.signal = 'BUY';
    result.reasons = [
      `SINGLES & DOUBLES setup ${setup} confirmed: quality score ${scored.score}/${scored.maxScore} (min ${effectiveMinScore}, SPY ${regime}), entry $${entryPrice.toFixed(2)}, stop $${stopPrice.toFixed(2)}, singles target $${result.singleTarget.toFixed(2)}, doubles target $${result.doubleTarget.toFixed(2)}.`,
    ];
  } else {
    const passed = result.gates.filter(g => g.passed).length;
    result.reasons.unshift(
      `S&D evaluation rejected: ${passed} of ${result.gates.length} gates passed (setup ${setup || 'none'}, score ${scored.score}/${scored.maxScore}).`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Candidate ranking
// ---------------------------------------------------------------------------

function rankSdCandidates(a, b) {
  if (!!a?.eligible !== !!b?.eligible) return a?.eligible ? -1 : 1;
  const scoreOf = row => finite(row?.score) ? Number(row.score) : -Infinity;
  if (scoreOf(a) !== scoreOf(b)) return scoreOf(b) - scoreOf(a);
  const rvolOf = row => finite(row?.metrics?.rvol) ? Number(row.metrics.rvol)
    : finite(row?.rvol) ? Number(row.rvol) : -Infinity;
  if (rvolOf(a) !== rvolOf(b)) return rvolOf(b) - rvolOf(a);
  return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
}

// ---------------------------------------------------------------------------
// Order construction and position sizing
// ---------------------------------------------------------------------------

function buildSdEntry({ symbol, bid, ask, qty, stopPrice, clientOrderId } = {}) {
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol || '')) {
    throw new SdError('Invalid S&D equity symbol.');
  }
  const shares = Number(qty);
  if (!Number.isInteger(shares) || shares < 1) {
    throw new SdError('S&D qty must be a positive integer (at least 1 share).');
  }
  if (!finite(ask) || Number(ask) <= 0 || !finite(stopPrice) || Number(stopPrice) <= 0) {
    throw new SdError('S&D entry price or stop price is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(clientOrderId || '')) {
    throw new SdError('Durable S&D client order ID required.');
  }
  const limitPrice = Math.round(Number(ask) * 100) / 100;
  const stop = Math.round(Number(stopPrice) * 100) / 100;
  if (!(stop < limitPrice)) {
    throw new SdError('S&D stop price must be below the limit price.');
  }
  return {
    symbol,
    qty: shares,
    side: 'buy',
    type: 'limit',
    limit_price: limitPrice.toFixed(2),
    time_in_force: 'gtc',
    order_class: 'oto',
    stop_loss: { stop_price: stop.toFixed(2) },
    client_order_id: clientOrderId,
  };
}

function sizePosition({ equity, buyingPower, entryPrice, stopPrice, maxRiskPerTrade, maxPositionDollars } = {}) {
  const entry = num(entryPrice);
  const stop = num(stopPrice);
  const riskPerShare = Number.isFinite(entry) && Number.isFinite(stop) ? entry - stop : NaN;
  if (!(riskPerShare > 0)) return { qty: 0, riskAmount: 0 };
  const capacity = [maxRiskPerTrade, maxPositionDollars, buyingPower]
    .map(Number).filter(x => Number.isFinite(x) && x > 0);
  if (capacity.length < 3) return { qty: 0, riskAmount: 0, limitPrice: round(entry, 2) };
  const qty = Math.floor(Math.min(...capacity) / riskPerShare);
  if (qty < 1) return { qty: 0, riskAmount: 0, limitPrice: round(entry, 2) };
  return { qty, riskAmount: round(qty * riskPerShare, 2), limitPrice: round(entry, 2) };
}

module.exports = {
  SdError,
  SD_RULES,
  GATE_ORDER,
  classifySpyRegime,
  scoreCandidate,
  detectSetupA,
  detectSetupB,
  evaluateSd,
  rankSdCandidates,
  buildSdEntry,
  sizePosition,
  // Pure helpers (exported for tests and the service workstream).
  ema,
  sma,
  computeVwapSeries,
  recentSwingLow,
  normalizeBars,
};
