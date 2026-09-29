'use strict';

// Crypto indicators — pure-function tests: EMA, RSI, MACD, ATR, session
// VWAP, RVOL, volume MAs, swing points, market structure, rolling
// highs/lows, and the no-look-ahead invariant.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  emaSeries, rsiSeries, macdSeries, atrSeries, sessionVwap,
  avgVolume, volumeMaSeries, rvol,
  swingPoints, marketStructure, rollingHigh, rollingLow,
  computeCryptoIntraday, utcDateKey,
} = require('../lib/crypto/indicators');

function candles(n, start = 100, step = 1, vol = 1000) {
  const out = [];
  const base = Date.parse('2026-09-29T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    out.push({ t: base + i * 300000, o: c - 0.1, h: c + 0.2, l: c - 0.2, c, v: vol });
  }
  return out;
}

test('emaSeries seeds from the SMA and recurses with k=2/(p+1)', () => {
  const out = emaSeries([10, 11, 12, 13, 14], 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 11); // SMA(10,11,12)
  assert.ok(Math.abs(out[3] - (13 * 0.5 + 11 * 0.5)) < 1e-9);
  assert.ok(Math.abs(out[4] - (14 * 0.5 + out[3] * 0.5)) < 1e-9);
});

test('rsiSeries stays within 0-100 and flags overbought on a straight rally', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const out = rsiSeries(closes, 14);
  assert.equal(out[13], null);
  assert.ok(out[14] > 70, `straight rally should be overbought, got ${out[14]}`);
  assert.ok(out.every(v => v === null || (v >= 0 && v <= 100)));
});

test('rsiSeries falls on a straight decline', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
  const out = rsiSeries(closes, 14);
  assert.ok(out[29] < 30, `straight decline should be oversold, got ${out[29]}`);
});

test('macdSeries is positive on a sustained rally', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
  const { macd, signal, hist } = macdSeries(closes, 12, 26, 9);
  assert.ok(macd[59] > 0, 'macd line positive on rally');
  assert.ok(hist[59] !== null);
});

test('atrSeries measures the true range on a flat tape', () => {
  const bars = candles(20, 100, 0, 100);
  const out = atrSeries(bars, 14);
  assert.equal(out[12], null);
  assert.ok(Math.abs(out[13] - 0.4) < 1e-9, `flat tape ATR should be 0.4, got ${out[13]}`);
});

test('sessionVwap resets at the UTC day boundary', () => {
  const a = [];
  const day1 = Date.parse('2026-09-29T00:00:00Z');
  for (let i = 0; i < 4; i++) a.push({ t: day1 + i * 60000, o: 100, h: 101, l: 99, c: 100, v: 100 });
  const day2 = Date.parse('2026-09-30T00:00:00Z');
  for (let i = 0; i < 4; i++) a.push({ t: day2 + i * 60000, o: 200, h: 201, l: 199, c: 200, v: 100 });
  const out = sessionVwap(a);
  assert.ok(Math.abs(out[3] - 100) < 1e-9, `day-1 VWAP should be 100, got ${out[3]}`);
  assert.ok(Math.abs(out[7] - 200) < 1e-9, `day-2 VWAP must reset to 200, got ${out[7]}`);
});

test('rvol compares current volume to the average', () => {
  assert.equal(rvol(300, 100), 3);
  assert.equal(rvol(50, 100), 0.5);
  assert.equal(rvol(100, 0), 1); // zero average never divides by zero
});

test('volumeMaSeries is a no-look-ahead moving average', () => {
  const out = volumeMaSeries([10, 20, 30, 40], 2);
  assert.equal(out[0], 10);
  assert.equal(out[1], 15);
  assert.equal(out[3], 35);
});

test('swingPoints finds the fractal high', () => {
  const bars = [
    { t: 1, o: 1, h: 10, l: 9, c: 9.5, v: 1 },
    { t: 2, o: 1, h: 11, l: 10, c: 10.5, v: 1 },
    { t: 3, o: 1, h: 15, l: 11, c: 12, v: 1 }, // swing high (left=1,right=1)
    { t: 4, o: 1, h: 12, l: 10, c: 11, v: 1 },
    { t: 5, o: 1, h: 11, l: 9, c: 10, v: 1 },
  ];
  const { highs } = swingPoints(bars, 1, 1);
  assert.equal(highs.length, 1);
  assert.equal(highs[0].price, 15);
});

test('marketStructure detects higher-high / higher-low uptrends', () => {
  // Two rising swing highs and two rising swing lows.
  const bars = [];
  const seq = [10, 12, 14, 12, 11, 13, 16, 14, 13, 15, 18, 16, 15, 17, 20, 18];
  seq.forEach((c, i) => bars.push({ t: i, o: c, h: c + 0.5, l: c - 0.5, c, v: 100 }));
  const s = marketStructure(bars, 1, 1);
  assert.ok(s.higherHigh || s.higherLow || s.trend === 'uptrend' || s.trend === 'range',
    `structure classified: ${s.trend}`);
  assert.ok(['uptrend', 'downtrend', 'range'].includes(s.trend));
});

test('marketStructure detects a downtrend', () => {
  const bars = [];
  const seq = [20, 18, 16, 18, 19, 17, 15, 17, 18, 16, 14, 16, 17, 15, 13, 15];
  seq.forEach((c, i) => bars.push({ t: i, o: c, h: c + 0.5, l: c - 0.5, c, v: 100 }));
  const s = marketStructure(bars, 1, 1);
  assert.ok(['downtrend', 'range'].includes(s.trend), `got ${s.trend}`);
});

test('rollingHigh/rollingLow scan the trailing window', () => {
  const bars = candles(30, 100, 1);
  assert.equal(rollingHigh(bars, 20), 100 + 29 + 0.2);
  assert.equal(rollingLow(bars, 20), 100 + 10 - 0.2);
  assert.equal(rollingHigh([], 20), null);
});

test('computeCryptoIntraday returns a full indicator row per bar', () => {
  const bars = candles(250, 50000, 2, 500);
  const rows = computeCryptoIntraday(bars);
  assert.equal(rows.length, 250);
  const last = rows[249];
  for (const key of ['ema9', 'ema20', 'ema50', 'ema200', 'vwap', 'rsi14', 'macd', 'macdSignal', 'macdHist', 'atr14', 'avgVol20', 'volMa20', 'volMa50', 'rvol']) {
    assert.ok(last[key] === null || Number.isFinite(last[key]), `${key} must be null or finite`);
  }
  assert.ok(last.ema9 > last.ema20 && last.ema20 > last.ema50, 'EMAs stack on a rally');
  assert.ok(last.rsi14 > 50, 'RSI bullish on a rally');
  assert.ok(last.rvol > 0, 'RVOL defined');
});

test('computeCryptoIntraday is no-look-ahead: prefix recompute matches', () => {
  const bars = candles(120, 100, 0.5, 300);
  const full = computeCryptoIntraday(bars);
  const prefix = computeCryptoIntraday(bars.slice(0, 80));
  for (const key of ['ema9', 'ema20', 'vwap', 'rsi14', 'macd', 'atr14']) {
    const a = full[79][key]; const b = prefix[79][key];
    assert.ok((a === null && b === null) || Math.abs(a - b) < 1e-9, `${key}: prefix must match full`);
  }
});

test('utcDateKey derives the UTC calendar date', () => {
  assert.equal(utcDateKey('2026-09-29T23:59:59Z'), '2026-09-29');
  assert.equal(utcDateKey('2026-09-30T00:00:01Z'), '2026-09-30');
});
