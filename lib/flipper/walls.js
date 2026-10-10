'use strict';

// Flipper Bot — pure wall calculator ("Invisible Wall Reversal", SPEC §2).
//
// Computes the four invisible walls for a trade date from daily bars:
//   RANGE HIGH — yesterday's regular-session high
//   RANGE LOW  — yesterday's regular-session low
//   FLIP HIGH  — nearest fractal swing high above Range High with >=
//                flipGapPct separation (null when none qualifies)
//   FLIP LOW   — nearest fractal swing low below Range Low with >=
//                flipGapPct separation (null when none qualifies)
//
// NO I/O, no Date.now(), no network. Pure + deterministic: identical inputs
// always produce identical walls. Walls are fixed intraday by construction —
// the service computes them once pre-market and caches them; this function
// never re-derives them from intraday data.

const { etDateKey } = require('../warrior/indicators');

// Local copy of the pinned DEFAULT_FLIPPER_RULES (ARCHITECTURE.md).
// The service workstream owns the canonical copy; these values must match it.
const DEFAULT_FLIPPER_RULES = Object.freeze({
  minPrice: 1, maxPrice: 20,
  minAvgDailyVolume: 500000, minDayVolume: 50000, maxSpreadPct: 0.5,
  includeETFs: true, scanBudget: 100,
  swingLookback: 3, flipGapPct: 1.0, flipLookbackBars: 120,
  wallTolerancePct: 0.30,
  touchWindowCandles: 2,
  minC1MovePct: 0.75, breakoutCancelPct: 0.25,
  stopMode: 'structure', stopBufferPct: 0.1, stopPercent: 2.0, stopDollars: 0.10,
  targetMode: 'full', partialPct: 50, runnerTrailPct: 1.0, rrTarget: 2.0,
  sizeMode: 'shares', defaultShares: 100, defaultDollars: 2000,
  riskPct: 0.5, maxRiskPerTradePct: 1.0,
  maxPositions: 3, maxTradesPerDay: 5, maxDailyLossPct: 3,
  eodFlattenTime: '15:55', limitOffsetPct: 0.2,
  slippageBps: 5, commissionPerShare: 0.005,
  tradingMode: 'PAPER', liveEnabled: false, liveConfirmed: false,
});

const finiteNum = v => (Number.isFinite(+v) ? +v : NaN);

// Fractal swing test on `bars` (array of daily candles): index i is a swing
// extreme when its extreme strictly exceeds the extremes of the N bars on each
// side (N = rules.swingLookback). Requires the full 2N+1 window inside `bars`.
function isFractalSwing(bars, i, n, side) {
  const extreme = side === 'high' ? finiteNum(bars[i].h) : finiteNum(bars[i].l);
  if (!Number.isFinite(extreme)) return false;
  for (let d = 1; d <= n; d += 1) {
    const left = bars[i - d];
    const right = bars[i + d];
    if (!left || !right) return false; // full window required
    const le = side === 'high' ? finiteNum(left.h) : finiteNum(left.l);
    const re = side === 'high' ? finiteNum(right.h) : finiteNum(right.l);
    // A swing high must strictly exceed its neighbours; a swing low must sit
    // strictly below them. NaN neighbours fail the comparison -> not a swing.
    const isExtreme = side === 'high'
      ? (extreme > le && extreme > re)
      : (extreme < le && extreme < re);
    if (!isExtreme) return false;
  }
  return true;
}

// Nearest-first search of `window` (daily bars strictly before yesterday, most
// recent last). Returns the first fractal swing extreme on `side` ('high' above
// `anchor`, 'low' below `anchor`) that clears the minimum separation gap, or
// null when no swing qualifies. A nearer swing that fails the gap is skipped in
// favour of the next one out (coordinator interpretation #1).
function nearestFlipSwing(window, n, gapPct, side, anchor) {
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (!isFractalSwing(window, i, n, side)) continue;
    const extreme = +window[i][side === 'high' ? 'h' : 'l'];
    if (side === 'high') {
      if (!(extreme > anchor)) continue; // must sit above the range wall
      if ((extreme - anchor) / anchor < gapPct) continue; // too close: try next
      return extreme;
    }
    if (!(extreme < anchor)) continue; // must sit below the range wall
    if ((anchor - extreme) / anchor < gapPct) continue; // too close: try next
    return extreme;
  }
  return null;
}

// computeWalls({ symbol, tradeDate, dailyBars, rules })
//   dailyBars: [{t,o,h,l,c,v}], t = ms epoch, oldest -> newest.
//   tradeDate: 'YYYY-MM-DD' in ET (America/New_York).
// Returns { symbol, tradeDate, rangeHigh, rangeLow, flipHigh, flipLow } where
// flipHigh/flipLow are null when no qualifying swing exists (that side then
// trades the range wall only).
function computeWalls({ symbol, tradeDate, dailyBars, rules = {} }) {
  const r = { ...DEFAULT_FLIPPER_RULES, ...rules };
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    throw new Error('[flipper] computeWalls: dailyBars must be a non-empty array');
  }
  if (typeof tradeDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error('[flipper] computeWalls: tradeDate must be YYYY-MM-DD');
  }

  // Yesterday = the last daily bar with an ET date strictly before tradeDate.
  let yIdx = -1;
  for (let i = dailyBars.length - 1; i >= 0; i -= 1) {
    const key = etDateKey(dailyBars[i] && dailyBars[i].t);
    if (key !== null && key < tradeDate) { yIdx = i; break; }
  }
  if (yIdx < 0) {
    throw new Error(`[flipper] computeWalls: no daily bar before tradeDate ${tradeDate}`);
  }
  const yBar = dailyBars[yIdx];
  const yKey = etDateKey(yBar.t);
  const rangeHigh = finiteNum(yBar.h);
  const rangeLow = finiteNum(yBar.l);
  if (!Number.isFinite(rangeHigh) || !Number.isFinite(rangeLow) || rangeHigh <= 0 || rangeLow <= 0) {
    throw new Error('[flipper] computeWalls: yesterday bar has invalid high/low');
  }

  // History = daily bars strictly before yesterday's ET date (ordered oldest
  // first), capped at flipLookbackBars bars immediately preceding yesterday.
  const history = [];
  for (let i = 0; i < yIdx; i += 1) {
    const key = etDateKey(dailyBars[i] && dailyBars[i].t);
    if (key !== null && key < yKey) history.push(dailyBars[i]);
  }
  const lookback = Math.max(1, Math.floor(+r.flipLookbackBars) || 120);
  const window = history.slice(-lookback);
  const n = Math.max(1, Math.floor(+r.swingLookback) || 3);
  const gapPct = Math.max(0, +r.flipGapPct) / 100;

  const flipHigh = nearestFlipSwing(window, n, gapPct, 'high', rangeHigh);
  const flipLow = nearestFlipSwing(window, n, gapPct, 'low', rangeLow);

  return { symbol, tradeDate, rangeHigh, rangeLow, flipHigh, flipLow };
}

module.exports = {
  computeWalls,
  DEFAULT_FLIPPER_RULES,
};
