'use strict';

const finite = value => value !== null && value !== undefined
  && !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value));
const round = value => Number.isFinite(value) ? +value.toFixed(4) : null;
const clamp = value => Math.max(0, Math.min(100, Math.round(value)));

function normalizeBars(source) {
  if (!Array.isArray(source)) return null;
  const bars = source.map(bar => {
    if (!bar || ![bar.o, bar.h, bar.l, bar.c, bar.v].every(finite)) return null;
    const normalized = { ...bar, o:+bar.o, h:+bar.h, l:+bar.l, c:+bar.c, v:+bar.v };
    return normalized.o > 0 && normalized.l > 0 && normalized.v > 0
      && normalized.h >= Math.max(normalized.o, normalized.c)
      && normalized.l <= Math.min(normalized.o, normalized.c) ? normalized : null;
  });
  return bars.every(Boolean) ? bars : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function candleOverCandle(bars) {
  if (bars.length < 3) return { detected:false, state:'UNAVAILABLE', score:0 };
  const prior = bars.at(-2);
  const current = bars.at(-1);
  const priorRange = Math.max(prior.h - prior.l, Number.EPSILON);
  const currentRange = Math.max(current.h - current.l, Number.EPSILON);
  const priorStrong = prior.c > prior.o && (prior.c - prior.o) / priorRange >= .5;
  const followThrough = current.c > current.o && current.h > prior.h && current.l > prior.l;
  const volumeExpansion = current.v > prior.v * 1.05;
  const breakout = current.c > prior.h;
  const score = clamp((priorStrong ? 30 : 0) + (followThrough ? 30 : 0)
    + (volumeExpansion ? 20 : 0) + (breakout ? 20 : 0));
  return {
    detected: priorStrong && followThrough && breakout,
    state: priorStrong && followThrough && breakout ? 'CONFIRMED' : priorStrong ? 'FORMING' : 'NONE',
    score,
    trigger: round(prior.h),
    invalidation: round(Math.min(prior.l, current.l)),
    evidence: { priorStrong, followThrough, volumeExpansion, breakout, currentBodyRatio:round((current.c-current.o)/currentRange) },
  };
}

function bullFlag(bars) {
  if (bars.length < 6) return { detected:false, state:'UNAVAILABLE', score:0 };
  const window = bars.slice(-7);
  const breakoutBar = window.at(-1);
  const impulse = window.slice(0, 2);
  const flag = window.slice(2, -1);
  if (flag.length < 3) return { detected:false, state:'UNAVAILABLE', score:0 };
  const impulseStart = impulse[0].o;
  const impulseHigh = Math.max(...impulse.map(bar => bar.h));
  const impulsePct = (impulseHigh - impulseStart) / impulseStart * 100;
  const flagLow = Math.min(...flag.map(bar => bar.l));
  const flagHigh = Math.max(...flag.map(bar => bar.h));
  const retrace = impulseHigh > impulseStart ? (impulseHigh - flagLow) / (impulseHigh - impulseStart) : 1;
  const impulseVolume = average(impulse.map(bar => bar.v));
  const flagVolume = average(flag.map(bar => bar.v));
  const strongImpulse = impulsePct >= 1.5 && impulse[1].c > impulse[0].c;
  const controlled = retrace >= 0 && retrace <= .55 && flagLow > impulseStart;
  const contracted = flagVolume < impulseVolume;
  const breakout = breakoutBar.c > flagHigh && breakoutBar.c > breakoutBar.o;
  const expansion = breakoutBar.v >= flagVolume * 1.25;
  const failed = breakoutBar.h > flagHigh && breakoutBar.c < flagLow;
  const detected = strongImpulse && controlled && breakout && expansion;
  const state = failed ? 'FAILED' : detected ? 'BREAKOUT'
    : strongImpulse && controlled && contracted ? 'FORMING' : strongImpulse && controlled ? 'EARLY' : 'NONE';
  const score = clamp((strongImpulse ? 25 : 0) + (controlled ? 20 : 0) + (contracted ? 15 : 0)
    + (breakout ? 20 : 0) + (expansion ? 20 : 0));
  return {
    detected, state, score, trigger:round(flagHigh), invalidation:round(flagLow),
    evidence: { impulsePct:round(impulsePct), retracePct:round(retrace * 100), contractedVolume:contracted, breakout, volumeExpansion:expansion },
  };
}

function abcd(bars) {
  if (bars.length < 8) return { detected:false, state:'UNAVAILABLE', score:0 };
  const window = bars.slice(-9);
  const d = window.at(-1);
  const structure = window.slice(0, -1);
  const first = structure.slice(0, 3);
  const middle = structure.slice(3, 5);
  const recent = structure.slice(5);
  if (!middle.length || !recent.length) return { detected:false, state:'UNAVAILABLE', score:0 };
  const a = Math.max(...first.map(bar => bar.h));
  const b = Math.min(...middle.map(bar => bar.l));
  const c = Math.min(...recent.map(bar => bar.l));
  const trigger = Math.max(a, ...recent.map(bar => bar.h));
  const impulse = (a - first[0].o) / first[0].o * 100;
  const healthyPullback = b > first[0].o && b < a;
  const higherLow = c > b;
  const breakout = d.c > trigger && d.c > d.o;
  const baseVolume = average(structure.slice(-4).map(bar => bar.v));
  const volumeExpansion = d.v >= baseVolume * 1.2;
  const detected = impulse >= 1.5 && healthyPullback && higherLow && breakout && volumeExpansion;
  const state = detected ? 'BREAKOUT' : impulse >= 1.5 && healthyPullback && higherLow ? 'FORMING' : 'NONE';
  const score = clamp((impulse >= 1.5 ? 25 : 0) + (healthyPullback ? 20 : 0) + (higherLow ? 20 : 0)
    + (breakout ? 20 : 0) + (volumeExpansion ? 15 : 0));
  return {
    detected, state, score, a:round(a), b:round(b), c:round(c), dTrigger:round(trigger),
    current:round(d.c), invalidation:round(c), target:round(trigger + Math.max(trigger-c, 0)),
    evidence: { impulsePct:round(impulse), healthyPullback, higherLow, breakout, volumeExpansion },
  };
}

function analyzeMomentumPatterns(source) {
  const bars = normalizeBars(source);
  if (!bars) return { available:false, score:0, best:null, reasons:['Completed OHLCV pattern evidence is incomplete or malformed.'], patterns:{} };
  if (bars.length < 8) return { available:false, score:0, best:null, reasons:['At least 8 completed bars are required for pattern analysis.'], patterns:{} };
  const patterns = {
    candleOverCandle: candleOverCandle(bars),
    bullFlag: bullFlag(bars),
    abcd: abcd(bars),
  };
  const labels = { candleOverCandle:'CANDLE_OVER_CANDLE', bullFlag:'BULL_FLAG', abcd:'ABCD' };
  const ranked = Object.entries(patterns).sort((a, b) => b[1].score - a[1].score);
  const [key, value] = ranked[0];
  return {
    available:true,
    score:value.score,
    best:value.score >= 50 ? { type:labels[key], state:value.state, score:value.score } : null,
    confirmed:Object.entries(patterns).filter(([, pattern]) => pattern.detected).map(([name]) => labels[name]),
    reasons:[],
    patterns,
  };
}

module.exports = { analyzeMomentumPatterns };