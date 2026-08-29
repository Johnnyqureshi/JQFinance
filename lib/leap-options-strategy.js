'use strict';

const ALLOWED_UNDERLYINGS = Object.freeze(['QQQ', 'TQQQ', 'SOXL']);
const DAY = 86400000;
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => number(value) == null ? null : +Number(value).toFixed(6);
const stamp = bar => {
  const value = new Date(bar && (bar.completedAt ?? bar.t ?? bar.timestamp ?? bar.time)).getTime();
  return Number.isFinite(value) ? value : null;
};
function validWeeklyBar(bar) {
  if (!bar || bar.completed === false || bar.isComplete === false) return false;
  const values = ['o', 'h', 'l', 'c'].map(key => number(bar[key]));
  return values.every(value => value != null && value > 0)
    && values[1] >= Math.max(values[0], values[3]) && values[2] <= Math.min(values[0], values[3])
    && stamp(bar) != null;
}
function ema(values, period) {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const alpha = 2 / (period + 1);
  for (const item of values.slice(period)) value = item * alpha + value * (1 - alpha);
  return value;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0; let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(0, change); losses += Math.max(0, -change);
  }
  if (!losses) return 100;
  return 100 - (100 / (1 + gains / losses));
}
function completedWeeklyBars(source) {
  if (!Array.isArray(source) || source.some(bar => !validWeeklyBar(bar))) return null;
  return source.map(bar => ({ ...bar, o:+bar.o, h:+bar.h, l:+bar.l, c:+bar.c }))
    .sort((left, right) => stamp(left) - stamp(right));
}

function evaluateLeapOptionsSignal(input = {}, suppliedConfig = {}) {
  const config = { minDte: 360, maxWeeklyAgeMs: 12 * DAY, ...suppliedConfig };
  const symbol = String(input.symbol || input.underlying || '').trim().toUpperCase();
  const bars = completedWeeklyBars(input.weeklyBars || input.bars);
  const reasons = [];
  if (!ALLOWED_UNDERLYINGS.includes(symbol)) reasons.push('Only QQQ, TQQQ, and SOXL are supported.');
  if (!bars) reasons.push('Completed weekly OHLC bars are missing or malformed.');
  if (bars && bars.length < 51) reasons.push('At least 51 completed weekly bars are required.');
  const last = bars?.at(-1); const now = number(input.now) ?? Date.now();
  if (bars && (input.freshness?.weekly === false || input.weeklyFresh === false
      || (!input.freshness?.weekly && input.weeklyFresh !== true && now - stamp(last) > config.maxWeeklyAgeMs))) {
    reasons.push('Completed weekly bars are stale or freshness is unavailable.');
  }
  if (reasons.length) return { strategy:'leap-options-v1', symbol, eligible:false, status:'NO TRADE', reasons, evidence:null, config };
  const closes = bars.map(bar => bar.c);
  const currentRsi = rsi(closes, 14);
  const currentEma20 = ema(closes, 20), priorEma20 = ema(closes.slice(0, -1), 20);
  const currentEma50 = ema(closes, 50), priorEma50 = ema(closes.slice(0, -1), 50);
  const ema20Rising = currentEma20 > priorEma20, ema50Rising = currentEma50 > priorEma50;
  if (!(currentRsi < 30)) reasons.push('Completed weekly RSI(14) is not below 30.');
  if (!(currentEma20 > currentEma50)) reasons.push('Weekly EMA20 is not above EMA50.');
  if (!ema20Rising || !ema50Rising) reasons.push('Weekly EMA20 and EMA50 must both be rising.');
  return {
    strategy:'leap-options-v1', symbol, direction:'LONG_CALL', eligible:!reasons.length,
    status:reasons.length ? 'NO TRADE' : 'TRADE ELIGIBLE', reasons,
    config, evidence:{ close:round(last.c), rsi14:round(currentRsi), ema20:round(currentEma20),
      ema50:round(currentEma50), ema20Rising, ema50Rising, completedWeeks:bars.length },
  };
}

function leapThesisInvalidated(input = {}) {
  const bars = completedWeeklyBars(input.weeklyBars || input.bars);
  if (!bars || bars.length < 51) return { invalidated:true, reason:'Completed weekly evidence is unavailable.' };
  const closes = bars.map(bar => bar.c), close = closes.at(-1);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const rising20 = e20 > ema(closes.slice(0, -1), 20), rising50 = e50 > ema(closes.slice(0, -1), 50);
  const invalidated = e20 <= e50 || ((!rising20 || !rising50) && close < e50);
  return { invalidated, reason:invalidated ? 'Weekly EMA thesis is invalidated.' : null,
    evidence:{ close:round(close), ema20:round(e20), ema50:round(e50), ema20Rising:rising20, ema50Rising:rising50 } };
}

// This deliberately produces signals from only information available at each
// completed week. It never invents option prices: realized results require
// separately supplied, completed option bars.
function simulateLeapOptionsStrategy(input = {}, config = {}) {
  const bars = completedWeeklyBars(input.weeklyBars || input.bars);
  if (!bars) return { strategy:'leap-options-v1', records:[], summary:{ signals:0, historicalOptionResults:'UNAVAILABLE' }, reasons:['Verified completed weekly bars are required.'] };
  const records = [];
  for (let index = 50; index < bars.length; index++) {
    const setup = evaluateLeapOptionsSignal({ ...input, weeklyBars:bars.slice(0, index + 1), freshness:{ weekly:true } }, config);
    if (setup.eligible) records.push({ decisionIndex:index, decisionAt:bars[index].completedAt ?? bars[index].t, setup,
      historicalOptionResult:'UNAVAILABLE', reason:'Verified chronological option bars were not supplied.' });
  }
  const verified = Array.isArray(input.optionBars) && input.optionBars.length
    && input.optionBars.every(validWeeklyBar);
  if (verified) records.forEach(record => { record.historicalOptionResult = 'VERIFIED_BARS_SUPPLIED'; });
  return { strategy:'leap-options-v1', records,
    summary:{ signals:records.length, historicalOptionResults:verified ? 'VERIFIED_BARS_SUPPLIED' : 'UNAVAILABLE' } };
}

module.exports = { ALLOWED_UNDERLYINGS, validLeapWeeklyBar:validWeeklyBar, completedWeeklyBars, ema, rsi,
  evaluateLeapOptionsSignal, analyzeLeapOptionsSignal:evaluateLeapOptionsSignal,
  leapThesisInvalidated, isLeapThesisInvalidated:leapThesisInvalidated,
  simulateLeapOptionsStrategy, backtestLeapOptionsStrategy:simulateLeapOptionsStrategy };