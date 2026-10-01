'use strict';

// Warrior Bot — pure intraday indicator engine.
// Candle shape: { t, o, h, l, c, v } with t = ms epoch (ISO strings tolerated).
// NO I/O. Every series is NO-LOOK-AHEAD: the value at index i is computed
// from candles[0..i] only, so recompute(prefix) === full(prefix) exactly.

const ET = 'America/New_York';
const etDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
});
const etTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, hour: '2-digit', minute: '2-digit', hour12: false,
});

function ms(t) {
  if (typeof t === 'number') return t;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? parsed : NaN;
}
function etDateKey(t) {
  const m = ms(t);
  return Number.isFinite(m) ? etDateFmt.format(new Date(m)) : null;
}
// Minutes since ET midnight for a timestamp.
function etMinutes(t) {
  const m = ms(t);
  if (!Number.isFinite(m)) return NaN;
  const parts = etTimeFmt.formatToParts(new Date(m));
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? NaN) % 24;
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? NaN);
  return hour * 60 + minute;
}
const num = v => Number.isFinite(+v) ? +v : NaN;
const validCandle = c => c && [c.o, c.h, c.l, c.c].every(v => Number.isFinite(+v));

// EMA: seed = SMA of the first `period` values at index period-1, then the
// standard k = 2/(period+1) recursion. Null until period-1.
function emaSeries(values, period) {
  const p = Math.max(1, Math.floor(period));
  const out = new Array(values.length).fill(null);
  if (values.length < p) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = num(values[i]);
    if (!Number.isFinite(v)) { out[i] = null; continue; }
    if (i < p - 1) { sum += v; continue; }
    if (i === p - 1) {
      sum += v;
      out[i] = sum / p;
      continue;
    }
    const prev = out[i - 1];
    if (prev === null) { // a NaN hole: re-seed from the last p finite values
      const window = [];
      for (let j = i; j >= 0 && window.length < p; j -= 1) {
        const w = num(values[j]);
        if (Number.isFinite(w)) window.unshift(w);
      }
      out[i] = window.length === p ? window.reduce((a, b) => a + b, 0) / p : null;
      continue;
    }
    const k = 2 / (p + 1);
    out[i] = v * k + prev * (1 - k);
  }
  return out;
}

// MACD line = EMA(fast) - EMA(slow); signal = EMA(macdLine, signalPeriod);
// hist = macd - signal. Null until the slow EMA exists.
function macdSeries(closes, fast = 12, slow = 26, signal = 9) {
  const n = closes.length;
  const macd = new Array(n).fill(null);
  const signalLine = new Array(n).fill(null);
  const hist = new Array(n).fill(null);
  const fastEma = emaSeries(closes, fast);
  const slowEma = emaSeries(closes, slow);
  for (let i = 0; i < n; i += 1) {
    if (fastEma[i] !== null && slowEma[i] !== null) macd[i] = fastEma[i] - slowEma[i];
  }
  // Signal EMA over the macd line, seeded at the first non-null macd value.
  let first = macd.findIndex(v => v !== null);
  if (first >= 0) {
    const k = 2 / (Math.max(1, Math.floor(signal)) + 1);
    let prev = null;
    let seeded = false;
    let seedSum = 0; let seedCount = 0;
    for (let i = first; i < n; i += 1) {
      if (macd[i] === null) { signalLine[i] = null; continue; }
      if (!seeded) {
        seedSum += macd[i]; seedCount += 1;
        if (seedCount >= signal) { prev = seedSum / seedCount; seeded = true; }
        else continue;
      } else {
        prev = macd[i] * k + prev * (1 - k);
      }
      signalLine[i] = prev;
      hist[i] = macd[i] - prev;
    }
  }
  return { macd, signal: signalLine, hist };
}

// Wilder's ATR: first value = mean of the first `period` true ranges at
// index period-1, then atr = (prev*(p-1) + tr)/p. Null until period-1.
function trueRange(candles, i) {
  const c = candles[i];
  const hl = c.h - c.l;
  if (i === 0) return hl;
  const prevClose = candles[i - 1].c;
  return Math.max(hl, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
}
function atrSeries(candles, period = 14) {
  const p = Math.max(1, Math.floor(period));
  const out = new Array(candles.length).fill(null);
  if (candles.length < p) return out;
  let acc = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const tr = trueRange(candles, i);
    if (i < p - 1) { acc += tr; continue; }
    if (i === p - 1) { acc += tr; out[i] = acc / p; continue; }
    out[i] = (out[i - 1] * (p - 1) + tr) / p;
  }
  return out;
}

// Session VWAP: cumulative typical-price*volume / cumulative volume,
// resetting whenever the ET calendar date changes.
function sessionVwap(candles) {
  const out = new Array(candles.length).fill(null);
  let pv = 0; let vol = 0; let day = null;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const key = etDateKey(c.t);
    if (key !== day) { day = key; pv = 0; vol = 0; }
    const tp = (num(c.h) + num(c.l) + num(c.c)) / 3;
    const v = num(c.v);
    if (Number.isFinite(tp) && Number.isFinite(v) && v > 0) { pv += tp * v; vol += v; }
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

// Mean of the last `period` volumes (or all available when shorter).
function avgVolume(volumes, period = 20) {
  const p = Math.max(1, Math.floor(period));
  const tail = volumes.slice(-p).map(num).filter(Number.isFinite);
  if (tail.length === 0) return 0;
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}
function rvol(cur, avg) {
  const c = num(cur); const a = num(avg);
  if (!Number.isFinite(c)) return 1;
  return a > 0 ? c / a : 1;
}

// First `minutes` of the regular session (09:30 ET) of the latest session
// present in the candles.
function openingRange(candles, minutes = 30) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const lastDay = etDateKey(candles[candles.length - 1].t);
  const start = 9 * 60 + 30;
  const inRange = candles.filter(c =>
    etDateKey(c.t) === lastDay && validCandle(c)
    && etMinutes(c.t) >= start && etMinutes(c.t) < start + minutes);
  if (inRange.length === 0) return null;
  return {
    high: Math.max(...inRange.map(c => +c.h)),
    low: Math.min(...inRange.map(c => +c.l)),
  };
}

// High/low of bars before 09:30 ET on the latest session in the candles.
function premarketLevels(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const lastDay = etDateKey(candles[candles.length - 1].t);
  const pre = candles.filter(c =>
    etDateKey(c.t) === lastDay && validCandle(c) && etMinutes(c.t) < 9 * 60 + 30);
  if (pre.length === 0) return null;
  return {
    high: Math.max(...pre.map(c => +c.h)),
    low: Math.min(...pre.map(c => +c.l)),
  };
}

// High/low of the trading day before the last daily candle.
function prevDayLevels(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 2) return null;
  const prev = dailyCandles[dailyCandles.length - 2];
  if (!validCandle(prev)) return null;
  return { high: +prev.h, low: +prev.l };
}

// Fractal swing points: bar i is a swing high when h[i] is strictly the
// maximum of h[i-left .. i+right] (mirror for lows).
function swingPoints(candles, left = 3, right = 3) {
  const highs = []; const lows = [];
  const L = Math.max(1, Math.floor(left)); const R = Math.max(1, Math.floor(right));
  for (let i = L; i < candles.length - R; i += 1) {
    const c = candles[i];
    if (!validCandle(c)) continue;
    let isHigh = true; let isLow = true;
    for (let j = i - L; j <= i + R; j += 1) {
      if (j === i) continue;
      const o = candles[j];
      if (!validCandle(o)) continue;
      if (+o.h >= +c.h) isHigh = false;
      if (+o.l <= +c.l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ idx: i, price: +c.h });
    if (isLow) lows.push({ idx: i, price: +c.l });
  }
  return { highs, lows };
}

// Full intraday indicator row per bar. Every series is no-look-ahead by
// construction (value at i uses candles[0..i] only), so the row at index i
// is exactly what a live engine would have seen at that bar.
function computeIntraday(candles1m) {
  const candles = Array.isArray(candles1m) ? candles1m : [];
  const closes = candles.map(c => num(c.c));
  const volumes = candles.map(c => num(c.v));
  const e9 = emaSeries(closes, 9);
  const e20 = emaSeries(closes, 20);
  const vw = sessionVwap(candles);
  const m = macdSeries(closes, 12, 26, 9);
  const atr = atrSeries(candles, 14);
  return candles.map((c, i) => {
    const avg = avgVolume(volumes.slice(0, i + 1), 20);
    const v = num(c.v);
    return {
      ema9: e9[i], ema20: e20[i], vwap: vw[i],
      macd: m.macd[i], macdSignal: m.signal[i], macdHist: m.hist[i],
      atr: atr[i], avgVol20: avg,
      rvol: Number.isFinite(v) && avg > 0 ? v / avg : 1,
    };
  });
}

// Volume-fade exit for held runners (Johnny 2026-10-01: "hold onto the
// runners until the volume falls off"). Pure and point-in-time: it reads
// only the bars passed in. Shared verbatim by the live reconcile loop and
// the backtester so both engines fade a runner on exactly the same signal.
// A fade requires BOTH:
//   • volume — the average volume of the last `fadeStallBars` bars drops
//     below `fadeVolumeFraction` × the average of the `fadeBaselineBars`
//     bars immediately before them, AND
//   • stall — the last close breaks the prior bar's low OR closes below
//     the session VWAP (buyers are no longer carrying price).
// Volume alone is not enough (a quiet bar inside a strong trend is
// normal); a stall alone is not enough either (the trailing stop owns
// pullbacks that happen while volume is still strong).
function volumeFadeDetected(bars, opts = {}) {
  const list = Array.isArray(bars) ? bars : [];
  const stallBars = Math.max(1, Math.floor(opts.fadeStallBars ?? 2));
  const baselineBars = Math.max(stallBars + 1, Math.floor(opts.fadeBaselineBars ?? 20));
  const frac = Number.isFinite(opts.fadeVolumeFraction) ? opts.fadeVolumeFraction : 0.6;
  if (list.length < baselineBars + stallBars) return false;
  const avgVol = rows => rows.reduce((s, b) => s + num(b.v), 0) / rows.length;
  const recentAvg = avgVol(list.slice(-stallBars));
  const baseAvg = avgVol(list.slice(-(baselineBars + stallBars), -stallBars));
  if (!(baseAvg > 0) || !(recentAvg < frac * baseAvg)) return false;
  const last = list[list.length - 1];
  const prev = list[list.length - 2];
  if (prev && num(last.c) < num(prev.l)) return true;
  const ind = computeIntraday(list);
  const vwap = ind.length ? ind[ind.length - 1].vwap : null;
  return Number.isFinite(vwap) && num(last.c) < vwap;
}

module.exports = {
  emaSeries, macdSeries, atrSeries, sessionVwap,
  avgVolume, rvol, openingRange, premarketLevels, prevDayLevels,
  swingPoints, computeIntraday, etDateKey, etMinutes, volumeFadeDetected,
};
