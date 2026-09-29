'use strict';

// Warrior Bot — risk engine. Pure functions, long-only.

// Position sizing: risk a fixed % of equity per trade, clamped to a max %.
function planTrade({ entry, stop, target, equity, riskPerTradePct = 0.5, maxRiskPerTradePct = 1 } = {}) {
  const e = +entry; const s = +stop; const t = +target; const eq = +equity;
  if (![e, s, t, eq].every(Number.isFinite) || e <= 0 || s <= 0 || eq <= 0) {
    throw new Error('planTrade: entry, stop, target and equity must be finite positive numbers.');
  }
  const riskPerShare = e - s;
  if (!(riskPerShare > 0)) throw new Error('planTrade: entry must be above stop (long-only).');
  if (!(t > e)) throw new Error('planTrade: target must be above entry (long-only).');
  const budget = eq * (+riskPerTradePct) / 100;
  const maxBudget = eq * (+maxRiskPerTradePct) / 100;
  const clampedByMax = budget > maxBudget;
  const dollarRisk = Math.min(budget, maxBudget);
  const sharesRecommended = Math.floor(dollarRisk / riskPerShare);
  return {
    sharesRecommended,
    dollarRisk: +(sharesRecommended * riskPerShare).toFixed(2),
    riskBudget: +dollarRisk.toFixed(2),
    riskPerShare: +riskPerShare.toFixed(4),
    reward: +(sharesRecommended * (t - e)).toFixed(2),
    rr: +((t - e) / riskPerShare).toFixed(4),
    notional: +(sharesRecommended * e).toFixed(2),
    clampedByMax,
  };
}

const DEFAULT_DAILY_RULES = Object.freeze({
  maxDailyLossPct: 2,
  maxConsecutiveLosses: 3,
  maxPositions: 3,
  maxTradesPerDay: 10,
  cooldownMinutesAfterLoss: 15,
});

// Portfolio-level daily guards. minutesSinceLastLoss is optional; when
// omitted (or null) the cooldown check is skipped.
function checkDailyLimits({
  dayPnl = 0, equity = 0, consecutiveLosses = 0, openPositions = 0,
  tradesToday = 0, minutesSinceLastLoss = null, rules = {},
} = {}) {
  const r = { ...DEFAULT_DAILY_RULES, ...rules };
  const halts = []; const reasons = [];
  const maxLoss = (+equity * r.maxDailyLossPct) / 100;
  if (+dayPnl <= -maxLoss) {
    halts.push('MAX_DAILY_LOSS');
    reasons.push(`Daily loss ${(+dayPnl).toFixed(2)} hit the ${r.maxDailyLossPct}% limit (${maxLoss.toFixed(2)}).`);
  }
  if (+consecutiveLosses >= r.maxConsecutiveLosses) {
    halts.push('MAX_CONSECUTIVE_LOSSES');
    reasons.push(`${consecutiveLosses} consecutive losses hit the ${r.maxConsecutiveLosses} limit.`);
  }
  if (+openPositions >= r.maxPositions) {
    halts.push('MAX_POSITIONS');
    reasons.push(`${openPositions} open positions hit the ${r.maxPositions} cap.`);
  }
  if (+tradesToday >= r.maxTradesPerDay) {
    halts.push('MAX_TRADES_PER_DAY');
    reasons.push(`${tradesToday} trades today hit the ${r.maxTradesPerDay} cap.`);
  }
  if (minutesSinceLastLoss !== null && minutesSinceLastLoss !== undefined
    && +minutesSinceLastLoss < r.cooldownMinutesAfterLoss) {
    halts.push('LOSS_COOLDOWN');
    reasons.push(`Cooling down ${r.cooldownMinutesAfterLoss - Math.floor(+minutesSinceLastLoss)} more minute(s) after a loss.`);
  }
  return { ok: halts.length === 0, halts, reasons };
}

// Pre-trade gate: all 12 named checks must pass or the trade is rejected.
const PRE_TRADE_CHECKS = Object.freeze([
  'market_open', 'data_fresh', 'pattern_valid', 'indicators_ok', 'regime_ok',
  'entry_above_stop', 'target_above_entry', 'min_risk_reward',
  'sufficient_buying_power', 'no_duplicate_position', 'daily_limits_ok',
  'position_size_positive',
]);
function validatePreTrade({
  marketOpen = false, dataFresh = false, pattern = null,
  indicatorsOk = false, regimeOk = false,
  entry, stop, target, rr, minRR = 2.0,
  buyingPower = 0, notional = 0,
  duplicatePosition = false, dailyLimitsOk = false,
} = {}) {
  const e = +entry; const s = +stop; const t = +target;
  const r = +rr; const m = +minRR; const bp = +buyingPower; const n = +notional;
  const results = [
    { name: 'market_open', passed: marketOpen === true, reason: 'Market is not open.' },
    { name: 'data_fresh', passed: dataFresh === true, reason: 'Market data is stale.' },
    { name: 'pattern_valid', passed: pattern?.pattern_valid === true, reason: 'No valid pattern.' },
    { name: 'indicators_ok', passed: indicatorsOk === true, reason: 'Indicator preconditions failed.' },
    { name: 'regime_ok', passed: regimeOk === true, reason: 'Regime filter rejected the setup.' },
    { name: 'entry_above_stop', passed: [e, s].every(Number.isFinite) && e > s && s > 0, reason: 'Entry must be above a positive stop.' },
    { name: 'target_above_entry', passed: [e, t].every(Number.isFinite) && t > e, reason: 'Target must be above entry.' },
    { name: 'min_risk_reward', passed: Number.isFinite(r) && Number.isFinite(m) && r >= m, reason: `Reward:risk ${r} is below the ${m} minimum.` },
    { name: 'sufficient_buying_power', passed: Number.isFinite(bp) && Number.isFinite(n) && bp >= n, reason: 'Insufficient buying power for the planned notional.' },
    { name: 'no_duplicate_position', passed: duplicatePosition !== true, reason: 'A position in this symbol is already open.' },
    { name: 'daily_limits_ok', passed: dailyLimitsOk === true, reason: 'A daily risk limit is halting new trades.' },
    { name: 'position_size_positive', passed: Number.isFinite(n) && n > 0, reason: 'Position size must be positive.' },
  ];
  const failures = results.filter(c => !c.passed).map(c => c.name);
  return { ok: failures.length === 0, checks: results, failures };
}

module.exports = { planTrade, checkDailyLimits, validatePreTrade, DEFAULT_DAILY_RULES, PRE_TRADE_CHECKS };
