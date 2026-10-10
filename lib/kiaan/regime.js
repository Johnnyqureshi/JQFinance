'use strict';

// Kiaan Bot — market regime classifier.
//
// Pure functions only: no I/O, no Date.now(), no imports from any other
// bot. The regime is decided BEFORE any symbol is looked at: given the
// market context (index trend/change, VIX, and — when available — rates,
// oil and breadth), classify the session as 'risk-on', 'risk-off',
// 'chop', or 'unknown' (core context missing — fail closed, never guess).
//
// Every vote is recorded as a "CODE: human detail" reason string, so the
// journal can show exactly why the day was called the way it was. A
// zero-trade day must be explainable from the bot's own records.

// ---------------------------------------------------------------------------
// Regime thresholds — defaults. engine.js carries the same keys in
// DEFAULT_KIAAN_RULES and passes its merged rules through; anything absent
// falls back to these. Frozen: never mutate.
// ---------------------------------------------------------------------------
const DEFAULT_REGIME_THRESHOLDS = Object.freeze({
  spyStrongPct: 0.75, // SPY day change at/above this votes strongly up
  spyWeakPct: -0.75, // SPY day change at/below this votes strongly down
  qqqStrongPct: 0.75,
  qqqWeakPct: -0.75,
  vixCalm: 15, // VIX at/below this votes calm
  vixElevated: 20, // VIX at/above this starts subtracting
  vixHigh: 25, // VIX at/above this subtracts heavily
  vixPanic: 35, // VIX at/above this hard-forces risk-off
  vixSpikePct: 10, // VIX day change magnitude that votes as a spike/drop
  hardDownPct: -1.5, // SPY AND QQQ both at/below this hard-force risk-off
  breadthStrongPct: 60, // % advancing at/above this confirms risk-on
  breadthWeakPct: 40, // % advancing at/below this confirms risk-off
  oilSpikePct: 3, // oil day change at/above this is macro stress
  yieldSpikeBps: 8, // 10Y yield rise (bps) at/above this is macro stress
  riskOnScore: 2, // score at/above this => risk-on (lowered from 3, 2026-10-10: at ±3 the regime reached tradeable on 0 of 5 days in the diagnosis week)
  riskOffScore: -2, // score at/below this => risk-off (lowered from -3, 2026-10-10)
});

const finite = v => (v === null || v === undefined || v === '')
  ? null
  : (Number.isFinite(+v) ? +v : null);

const trendOf = v => {
  const s = String(v || '').toLowerCase();
  return s === 'up' || s === 'down' || s === 'flat' ? s : null;
};

function mergedThresholds(rules) {
  const src = rules && typeof rules === 'object' ? rules : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_REGIME_THRESHOLDS)) {
    const v = finite(src[k]);
    out[k] = v === null ? DEFAULT_REGIME_THRESHOLDS[k] : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// classifyRegime(context, rules)
//
// context: {
//   spy:  { dayChangePct, trend? },          // core, required
//   qqq:  { dayChangePct, trend? },          // core, required
//   vix:  { level, dayChangePct? },          // core level, required
//   rates?: { tenYearChangeBps },
//   oil?:   { dayChangePct },
//   breadth?: { advancersPct },
// }
//
// Returns { regime: 'risk-on'|'risk-off'|'chop'|'unknown', score,
//   tradable, reasons: [...], inputs: {...validated echo...} }.
// 'chop' and 'unknown' are both untradable for fresh entries; 'unknown'
// additionally means the context itself could not be trusted.
// ---------------------------------------------------------------------------
function classifyRegime(context = {}, rules = {}) {
  const t = mergedThresholds(rules);
  const ctx = context && typeof context === 'object' ? context : {};
  const reasons = [];
  const say = (code, detail) => reasons.push(`${code}: ${detail}`);

  const spyChg = finite(ctx.spy && ctx.spy.dayChangePct);
  const spyTrend = trendOf(ctx.spy && ctx.spy.trend);
  const qqqChg = finite(ctx.qqq && ctx.qqq.dayChangePct);
  const qqqTrend = trendOf(ctx.qqq && ctx.qqq.trend);
  const vixLevel = finite(ctx.vix && ctx.vix.level);
  const vixChg = finite(ctx.vix && ctx.vix.dayChangePct);
  const tnxBps = finite(ctx.rates && ctx.rates.tenYearChangeBps);
  const oilChg = finite(ctx.oil && ctx.oil.dayChangePct);
  const breadth = finite(ctx.breadth && ctx.breadth.advancersPct);

  const inputs = {
    spyDayChangePct: spyChg, spyTrend,
    qqqDayChangePct: qqqChg, qqqTrend,
    vixLevel, vixDayChangePct: vixChg,
    tenYearChangeBps: tnxBps, oilDayChangePct: oilChg,
    breadthAdvancersPct: breadth,
  };

  // --- core context is mandatory: missing core input fails closed -------
  const missing = [];
  if (spyChg === null) missing.push('SPY day change');
  if (qqqChg === null) missing.push('QQQ day change');
  if (vixLevel === null) missing.push('VIX level');
  if (missing.length) {
    say('CONTEXT_MISSING', `${missing.join(', ')} unavailable — regime unknown, fail closed`);
    return { regime: 'unknown', score: 0, tradable: false, reasons, inputs };
  }

  // --- hard overrides ----------------------------------------------------
  if (vixLevel >= t.vixPanic) {
    say('VIX_PANIC', `VIX ${vixLevel.toFixed(1)} ≥ panic ${t.vixPanic} — risk-off regardless of score`);
    return { regime: 'risk-off', score: t.riskOffScore, tradable: true, reasons, inputs };
  }
  if (spyChg <= t.hardDownPct && qqqChg <= t.hardDownPct) {
    say('INDEXES_HARD_DOWN', `SPY ${spyChg.toFixed(2)}% and QQQ ${qqqChg.toFixed(2)}% both ≤ ${t.hardDownPct}% — risk-off regardless of score`);
    return { regime: 'risk-off', score: t.riskOffScore, tradable: true, reasons, inputs };
  }

  // --- scored votes --------------------------------------------------------
  let score = 0;
  const vote = (pts, code, detail) => { score += pts; say(code, `${detail} (${pts > 0 ? '+' : ''}${pts})`); };

  if (spyChg >= t.spyStrongPct) vote(2, 'SPY_STRONG', `SPY +${spyChg.toFixed(2)}% ≥ +${t.spyStrongPct}%`);
  else if (spyChg <= t.spyWeakPct) vote(-2, 'SPY_WEAK', `SPY ${spyChg.toFixed(2)}% ≤ ${t.spyWeakPct}%`);
  else say('SPY_FLAT', `SPY ${spyChg >= 0 ? '+' : ''}${spyChg.toFixed(2)}% inside the ±${t.spyStrongPct}% band (0)`);
  if (spyTrend === 'up') vote(1, 'SPY_TREND_UP', 'SPY trend up');
  else if (spyTrend === 'down') vote(-1, 'SPY_TREND_DOWN', 'SPY trend down');

  if (qqqChg >= t.qqqStrongPct) vote(1, 'QQQ_STRONG', `QQQ +${qqqChg.toFixed(2)}% ≥ +${t.qqqStrongPct}%`);
  else if (qqqChg <= t.qqqWeakPct) vote(-1, 'QQQ_WEAK', `QQQ ${qqqChg.toFixed(2)}% ≤ ${t.qqqWeakPct}%`);
  else say('QQQ_FLAT', `QQQ ${qqqChg >= 0 ? '+' : ''}${qqqChg.toFixed(2)}% inside the ±${t.qqqStrongPct}% band (0)`);
  if (qqqTrend === 'up') vote(1, 'QQQ_TREND_UP', 'QQQ trend up');
  else if (qqqTrend === 'down') vote(-1, 'QQQ_TREND_DOWN', 'QQQ trend down');

  if (vixLevel >= t.vixHigh) vote(-2, 'VIX_HIGH', `VIX ${vixLevel.toFixed(1)} ≥ ${t.vixHigh}`);
  else if (vixLevel >= t.vixElevated) vote(-1, 'VIX_ELEVATED', `VIX ${vixLevel.toFixed(1)} ≥ ${t.vixElevated}`);
  else if (vixLevel <= t.vixCalm) vote(1, 'VIX_CALM', `VIX ${vixLevel.toFixed(1)} ≤ ${t.vixCalm}`);
  else say('VIX_NEUTRAL', `VIX ${vixLevel.toFixed(1)} between ${t.vixCalm} and ${t.vixElevated} (0)`);
  if (vixChg !== null && vixChg >= t.vixSpikePct) vote(-2, 'VIX_SPIKING', `VIX +${vixChg.toFixed(1)}% on the day ≥ +${t.vixSpikePct}%`);
  else if (vixChg !== null && vixChg <= -t.vixSpikePct) vote(1, 'VIX_FALLING', `VIX ${vixChg.toFixed(1)}% on the day ≤ −${t.vixSpikePct}%`);

  if (breadth !== null) {
    if (breadth >= t.breadthStrongPct) vote(1, 'BREADTH_STRONG', `${breadth.toFixed(0)}% advancing ≥ ${t.breadthStrongPct}%`);
    else if (breadth <= t.breadthWeakPct) vote(-1, 'BREADTH_WEAK', `${breadth.toFixed(0)}% advancing ≤ ${t.breadthWeakPct}%`);
    else say('BREADTH_MIXED', `${breadth.toFixed(0)}% advancing — neither confirms (0)`);
  }

  // Macro stress only subtracts; calm macro is the absence of a signal,
  // not a positive one.
  if (oilChg !== null && oilChg >= t.oilSpikePct) vote(-1, 'OIL_SPIKE', `oil +${oilChg.toFixed(1)}% ≥ +${t.oilSpikePct}% — macro stress`);
  if (tnxBps !== null && tnxBps >= t.yieldSpikeBps) vote(-1, 'YIELDS_SPIKE', `10Y yield +${tnxBps.toFixed(0)} bps ≥ +${t.yieldSpikeBps} bps — macro stress`);

  let regime;
  if (score >= t.riskOnScore) regime = 'risk-on';
  else if (score <= t.riskOffScore) regime = 'risk-off';
  else regime = 'chop';
  say('REGIME_SCORE', `score ${score > 0 ? '+' : ''}${score} → ${regime} (risk-on ≥ +${t.riskOnScore}, risk-off ≤ ${t.riskOffScore})`);

  return { regime, score, tradable: regime !== 'chop', reasons, inputs };
}

module.exports = { DEFAULT_REGIME_THRESHOLDS, classifyRegime };
