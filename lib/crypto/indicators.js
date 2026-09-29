'use strict';

// Crypto Breakout Bot — pure indicator engine.
// Candle shape: { t, o, h, l, c, v } with t = ms epoch (ISO strings tolerated).
// NO I/O. Every series is NO-LOOK-AHEAD: the value at index i is computed
// from candles[0..i] only, so recompute(prefix) === full(prefix) exactly.
//
// Crypto sessions: unlike equities there is no open/close. The "session"
// VWAP resets on the UTC calendar day (00:00 UTC), the natural session
// boundary for a 24/7 market.

function ms(t) {
  if (typeof t === 'number') return t;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? parsed : NaN;
}
// UTC calendar date key — the crypto session boundary.
function utcDateKey(t) {
  const m = ms(t);
  return Number.isFinite(m) ? new Date(m).toISOString().slice(0, 10) : null;
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
    if (i === p - 1) { sum += v; out[i] = sum / p; continue; }
    const prev = out[i - 1];
    if (prev === null) {
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

// Wilder's RSI(14): first value at index `period` from the first `period`
// diffs, then Wilder smoothing. Null before.
function rsiSeries(closes, period = 14) {
  const p = Math.max(1, Math.floor(period));
  const out = new Array(closes.length).fill(null);
  if (closes.length < p + 1) return out;
  let gain = 0; let loss = 0;
  for (let i = 1; i <= p; i += 1) {
    const d = num(closes[i]) - num(closes[i - 1]);
    if (!Number.isFinite(d)) return out;
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / p; let avgLoss = loss / p;
  out[p] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = p + 1; i < closes.length; i += 1) {
    const d = num(closes[i]) - num(closes[i - 1]);
    if (!Number.isFinite(d)) { out[i] = null; continue; }
    const g = d > 0 ? d : 0; const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
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
  const first = macd.findIndex(v => v !== null);
  if (first >= 0) {
    const k = 2 / (Math.max(1, Math.floor(signal)) + 1);
    let prev = null; let seeded = false; let seedSum = 0; let seedCount = 0;
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

// Session VWAP for a 24/7 market: cumulative typical-price*volume /
// cumulative volume, resetting at each UTC calendar day.
function sessionVwap(candles) {
  const out = new Array(candles.length).fill(null);
  let pv = 0; let vol = 0; let day = null;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const key = utcDateKey(c.t);
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
// Simple moving average of volume over the full series (no look-ahead:
// value at i uses volumes[0..i]).
function volumeMaSeries(volumes, period = 20) {
  const p = Math.max(1, Math.floor(period));
  const out = new Array(volumes.length).fill(null);
  let sum = 0; let count = 0;
  for (let i = 0; i < volumes.length; i += 1) {
    const v = num(volumes[i]);
    if (Number.isFinite(v)) { sum += v; count += 1; }
    if (i >= p) {
      const old = num(volumes[i - p]);
      if (Number.isFinite(old)) { sum -= old; count -= 1; }
    }
    out[i] = count > 0 ? sum / Math.min(count, p) : null;
  }
  return out;
}
function rvol(cur, avg) {
  const c = num(cur); const a = num(avg);
  if (!Number.isFinite(c)) return 1;
  return a > 0 ? c / a : 1;
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

// Higher-high / higher-low structure from the last two swing points on each
// side. trend: 'uptrend' | 'downtrend' | 'range'.
function marketStructure(candles, left = 3, right = 3) {
  const { highs, lows } = swingPoints(candles, left, right);
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const prevHigh = highs.length > 1 ? highs[highs.length - 2] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  const prevLow = lows.length > 1 ? lows[lows.length - 2] : null;
  const higherHigh = !!(lastHigh && prevHigh && lastHigh.price > prevHigh.price);
  const lowerHigh = !!(lastHigh && prevHigh && lastHigh.price < prevHigh.price);
  const higherLow = !!(lastLow && prevLow && lastLow.price > prevLow.price);
  const lowerLow = !!(lastLow && prevLow && lastLow.price < prevLow.price);
  let trend = 'range';
  if (higherHigh && higherLow) trend = 'uptrend';
  else if (lowerHigh && lowerLow) trend = 'downtrend';
  return { trend, higherHigh, lowerHigh, higherLow, lowerLow, lastHigh, prevHigh, lastLow, prevLow };
}

// Rolling highest high / lowest low of the last `period` bars.
function rollingHigh(candles, period = 20) {
  const p = Math.max(1, Math.floor(period));
  const tail = candles.slice(-p).filter(validCandle);
  if (!tail.length) return null;
  return Math.max(...tail.map(c => +c.h));
}
function rollingLow(candles, period = 20) {
  const p = Math.max(1, Math.floor(period));
  const tail = candles.slice(-p).filter(validCandle);
  if (!tail.length) return null;
  return Math.min(...tail.map(c => +c.l));
}

// Full crypto intraday indicator row per bar — 9/20/50/200 EMAs, session
// VWAP (UTC day), RSI(14), MACD(12,26,9), ATR(14), volume MAs and RVOL.
// No-look-ahead by construction.
function computeCryptoIntraday(candles) {
  const rows = Array.isArray(candles) ? candles : [];
  const closes = rows.map(c => num(c.c));
  const volumes = rows.map(c => num(c.v));
  const e9 = emaSeries(closes, 9);
  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const e200 = emaSeries(closes, 200);
  const vw = sessionVwap(rows);
  const rsi = rsiSeries(closes, 14);
  const m = macdSeries(closes, 12, 26, 9);
  const atr = atrSeries(rows, 14);
  const vma20 = volumeMaSeries(volumes, 20);
  const vma50 = volumeMaSeries(volumes, 50);
  return rows.map((c, i) => {
    const avg = avgVolume(volumes.slice(0, i + 1), 20);
    const v = num(c.v);
    return {
      ema9: e9[i], ema20: e20[i], ema50: e50[i], ema200: e200[i],
      vwap: vw[i], rsi14: rsi[i],
      macd: m.macd[i], macdSignal: m.signal[i], macdHist: m.hist[i],
      atr14: atr[i], avgVol20: avg,
      volMa20: vma20[i], volMa50: vma50[i],
      rvol: Number.isFinite(v) && avg > 0 ? v / avg : 1,
    };
  });
}

module.exports = {
  emaSeries, rsiSeries, macdSeries, atrSeries, sessionVwap,
  avgVolume, volumeMaSeries, rvol,
  swingPoints, marketStructure, rollingHigh, rollingLow,
  computeCryptoIntraday, utcDateKey,
};
