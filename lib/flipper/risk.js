'use strict';

// Flipper Bot — risk engine. Pure functions only: sizing, stops, targets,
// priority scoring, and the wall-rejection wick metric. No Date.now(); any
// timestamps the caller needs are passed in. Long AND short aware.

// Pinned DEFAULT_FLIPPER_RULES subset used by the risk engine (ARCHITECTURE.md).
const DEFAULT_RISK_RULES = Object.freeze({
  stopMode: 'structure',
  stopBufferPct: 0.1,
  stopPercent: 2.0,
  stopDollars: 0.10,
  targetMode: 'full',
  partialPct: 50,
  runnerTrailPct: 1.0,
  rrTarget: 2.0,
  sizeMode: 'shares',
  defaultShares: 100,
  defaultDollars: 2000,
  riskPct: 0.5,
  maxRiskPerTradePct: 1.0,
});

function mergedRules(rules) {
  return { ...DEFAULT_RISK_RULES, ...(rules || {}) };
}

function normalizeDirection(direction) {
  return String(direction || '').toLowerCase() === 'short' ? 'short' : 'long';
}

// Position sizing. sizeMode: 'shares' | 'dollars' | 'risk_pct'.
// Returns integer shares >= 0 (never throws; invalid inputs yield 0).
function sizePosition({ rules = {}, entryPrice, stopPrice, equity } = {}) {
  const r = mergedRules(rules);
  const entry = +entryPrice;
  const eq = +equity;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(eq) || eq <= 0) return 0;
  const mode = String(r.sizeMode || 'shares').toLowerCase();

  if (mode === 'dollars') {
    const dollars = +r.defaultDollars;
    if (!Number.isFinite(dollars) || dollars <= 0) return 0;
    return Math.max(0, Math.floor(dollars / entry));
  }

  if (mode === 'risk_pct' || mode === 'risk' || mode === 'riskpct') {
    const riskPct = +r.riskPct;
    if (!Number.isFinite(riskPct) || riskPct <= 0) return 0;
    const stop = +stopPrice;
    const perShareRisk = Number.isFinite(stop) ? Math.abs(entry - stop) : NaN;
    // Division-by-zero / inverted-stop guard: no measurable risk, no size.
    if (!Number.isFinite(perShareRisk) || perShareRisk <= 0) return 0;
    let shares = Math.floor((eq * riskPct / 100) / perShareRisk);
    const capPct = +r.maxRiskPerTradePct;
    if (Number.isFinite(capPct) && capPct > 0) {
      const maxNotional = eq * capPct / 100;
      shares = Math.min(shares, Math.floor(maxNotional / entry));
    }
    return Math.max(0, shares);
  }

  // 'shares' (default): fixed share count.
  const shares = +r.defaultShares;
  if (!Number.isFinite(shares) || shares <= 0) return 0;
  return Math.max(0, Math.floor(shares));
}

// Stop-loss price. stopMode: 'structure' | 'percent' | 'dollar'.
function computeStop({ direction = 'long', c1 = {}, entryPrice, rules = {} } = {}) {
  const r = mergedRules(rules);
  const entry = +entryPrice;
  const dir = normalizeDirection(direction);
  const mode = String(r.stopMode || 'structure').toLowerCase();

  if (mode === 'percent') {
    const pct = +r.stopPercent / 100;
    return dir === 'long' ? entry * (1 - pct) : entry * (1 + pct);
  }
  if (mode === 'dollar') {
    const dollars = +r.stopDollars;
    return dir === 'long' ? entry - dollars : entry + dollars;
  }
  // 'structure': just beyond the C1 extreme, with a noise buffer.
  const buffer = +r.stopBufferPct / 100;
  if (dir === 'long') {
    const low = +c1.l;
    return Number.isFinite(low) ? low * (1 - buffer) : NaN;
  }
  const high = +c1.h;
  return Number.isFinite(high) ? high * (1 + buffer) : NaN;
}

// Take-profit target. Primary target is the opposite range wall; targetMode
// ('full' | 'partial_runner' | 'rr') selects the exit plan. When the primary
// wall sits on the wrong side of the entry (bad wall data), falls back to the
// rr-based target and notes it.
function computeTarget({ direction = 'long', walls = {}, entryPrice, stopPrice, rules = {} } = {}) {
  const r = mergedRules(rules);
  const entry = +entryPrice;
  const stop = +stopPrice;
  const dir = normalizeDirection(direction);

  const risk = Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) : NaN;
  const rr = +r.rrTarget;
  const rrTarget = Number.isFinite(risk) && risk > 0 && Number.isFinite(rr) && rr > 0
    ? (dir === 'long' ? entry + rr * risk : entry - rr * risk)
    : NaN;

  const primary = dir === 'long' ? +walls.rangeHigh : +walls.rangeLow;
  const wrongSide = !Number.isFinite(primary)
    || (dir === 'long' ? primary <= entry : primary >= entry);

  let target = primary;
  let fallback = false;
  let note = null;
  if (wrongSide) {
    target = rrTarget;
    fallback = true;
    note = `Primary wall target ${primary} is on the wrong side of entry ${entry}; fell back to ${rr}x-risk target.`;
  }

  const mode = String(r.targetMode || 'full').toLowerCase();
  const plan = mode === 'partial_runner' ? 'partial_runner' : mode === 'rr' ? 'rr' : 'full';
  if (plan === 'rr') {
    target = rrTarget;
    if (!Number.isFinite(target)) { fallback = true; note = 'RR target undefined (no measurable risk); target unresolved.'; }
  }

  const out = { target, plan, fallback, note };
  if (plan === 'partial_runner') {
    out.partialPct = +r.partialPct;
    out.runnerTrailPct = +r.runnerTrailPct;
  }
  return out;
}

function clamp01(value) {
  const n = +value;
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Signal priority score, 0..1, pinned weights (ARCHITECTURE.md §interpretation 8):
// 0.4*rejectionStrength + 0.2*rvol + 0.2*rr + 0.1*liquidity + 0.1*spreadTightness.
function priorityScore({ rejectionStrength = 0, rvol = 0, rr = 0, liquidity = 0, spreadTightness = 0 } = {}) {
  const parts = [rejectionStrength, rvol, rr, liquidity, spreadTightness].map(clamp01);
  const score = parts[0] * 0.4 + parts[1] * 0.2 + parts[2] * 0.2 + parts[3] * 0.1 + parts[4] * 0.1;
  return +Math.min(1, Math.max(0, score)).toFixed(4);
}

// Wall-rejection strength as a wick ratio, 0..1.
// Long: how much of C1's range is a lower wick (body sits above the low).
// Short: mirrored (upper wick). 0 when the candle has no range or bad data.
function rejectionStrength({ direction = 'long', c1 = {}, wallPrice, rules = {} } = {}) {
  void wallPrice; void rules;
  const o = +c1.o; const h = +c1.h; const l = +c1.l; const c = +c1.c;
  if (![o, h, l, c].every(Number.isFinite) || h <= l) return 0;
  const dir = normalizeDirection(direction);
  const wick = dir === 'long' ? Math.min(o, c) - l : h - Math.max(o, c);
  return clamp01(wick / (h - l));
}

module.exports = {
  sizePosition,
  computeStop,
  computeTarget,
  priorityScore,
  rejectionStrength,
  DEFAULT_RISK_RULES,
};
