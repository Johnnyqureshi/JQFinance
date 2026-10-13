'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  emaSeries, macdSeries, atrSeries, rsiSeries, sessionVwap,
  avgVolume, rvol, openingRange, premarketLevels, prevDayLevels,
  swingPoints, computeIntraday,
} = require('../lib/warrior/indicators');

// 2026-09-28 is a Monday; 9:30 ET = 13:30 UTC (EDT).
const T0 = Date.UTC(2026, 8, 28, 13, 30);
const bar = (i, o, h, l, c, v = 1000) => ({ t: T0 + i * 60000, o, h, l, c, v });
const drift = (n, start = 100, step = 0.1) => {
  const out = [];
  let c = start;
  for (let i = 0; i < n; i += 1) {
    out.push(bar(i, c, c + 0.05, c - 0.05, c + step));
    c += step;
  }
  return out;
};

test('emaSeries seeds with the SMA and recurses with k=2/(p+1)', () => {
  assert.deepEqual(emaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('emaSeries returns all null when the period exceeds the data', () => {
  assert.deepEqual(emaSeries([1, 2, 3], 5), [null, null, null]);
});

test('macdSeries is ~zero on a flat series and positive on a rising one', () => {
  const flat = new Array(60).fill(100);
  const rising = flat.map((_, i) => 100 + i * 0.5);
  const f = macdSeries(flat);
  const r = macdSeries(rising);
  assert.ok(f.macd.at(-1) !== null && Math.abs(f.macd.at(-1)) < 1e-9);
  assert.ok(r.macd.at(-1) > 0);
  assert.ok(r.hist.at(-1) !== null);
  assert.equal(f.macd.length, 60);
  // Null until the slow EMA exists.
  assert.equal(macdSeries([1, 2, 3]).macd.filter(v => v !== null).length, 0);
});

test('atrSeries uses Wilder smoothing: constant range settles at the range', () => {
  const candles = [0, 1, 2, 3, 4, 5].map(i => bar(i, 10, 11, 9, 10));
  const atr = atrSeries(candles, 3);
  assert.deepEqual(atr.slice(0, 2), [null, null]);
  assert.ok(atr.slice(2).every(v => Math.abs(v - 2) < 1e-9));
});

test('sessionVwap accumulates typical price x volume and resets per ET day', () => {
  const day1 = [bar(0, 100, 102, 98, 100, 1000), bar(1, 100, 104, 100, 102, 1000)];
  // Next ET day: 2026-09-29 09:30 ET.
  const t1 = Date.UTC(2026, 8, 29, 13, 30);
  const day2 = [{ t: t1, o: 50, h: 52, l: 48, c: 50, v: 2000 }];
  const vw = sessionVwap([...day1, ...day2]);
  const tp1 = (102 + 98 + 100) / 3; const tp2 = (104 + 100 + 102) / 3;
  assert.ok(Math.abs(vw[1] - (tp1 * 1000 + tp2 * 1000) / 2000) < 1e-9);
  assert.ok(Math.abs(vw[2] - 50) < 1e-9); // reset: only day-2 volume counts
});

test('avgVolume averages the last N volumes; rvol guards a zero baseline', () => {
  assert.equal(avgVolume([1, 2, 3, 4], 2), 3.5);
  assert.equal(avgVolume([5], 20), 5);
  assert.equal(rvol(200, 100), 2);
  assert.equal(rvol(200, 0), 1);
});

test('openingRange covers the first 30 minutes of the regular session', () => {
  const bars = [0, 1, 2, 29, 30, 31].map(i => bar(i, 100, 100 + i, 100 - i, 100));
  const or = openingRange(bars, 30);
  assert.equal(or.high, 129);
  assert.equal(or.low, 71);
  assert.equal(openingRange([], 30), null);
});

test('premarketLevels uses bars before 9:30 ET on the latest session', () => {
  const pre = { t: T0 - 30 * 60000, o: 99, h: 99.5, l: 98.5, c: 99, v: 500 };
  const bars = [pre, bar(0, 100, 101, 99, 100), bar(1, 100, 102, 99, 101)];
  assert.deepEqual(premarketLevels(bars), { high: 99.5, low: 98.5 });
  assert.equal(premarketLevels([bar(0, 100, 101, 99, 100)]), null);
});

test('prevDayLevels returns the high/low of the day before the last daily bar', () => {
  const dailies = [
    { t: 'x', o: 1, h: 5, l: 1, c: 4, v: 10 },
    { t: 'y', o: 4, h: 6, l: 2, c: 5, v: 10 },
  ];
  assert.deepEqual(prevDayLevels(dailies), { high: 5, low: 1 });
  assert.equal(prevDayLevels(dailies.slice(0, 1)), null);
});

test('swingPoints finds strict fractal highs and lows', () => {
  const hs = [3, 2, 1, 2, 5, 2, 1, 2, 3];
  const candles = hs.map((h, i) => bar(i, h, h, h - 1, h));
  const { highs, lows } = swingPoints(candles, 1, 1);
  assert.deepEqual(highs, [{ idx: 4, price: 5 }]);
  assert.deepEqual(lows.map(l => l.idx), [2, 6]);
});

test('computeIntraday rows are no-look-ahead: prefix recompute matches', () => {
  const candles = drift(60);
  const full = computeIntraday(candles);
  assert.equal(full.length, 60);
  assert.deepEqual(Object.keys(full[0]).sort(),
    ['atr', 'avgVol20', 'ema20', 'ema9', 'macd', 'macdHist', 'macdSignal', 'rsi', 'rvol', 'vwap']);
  for (const i of [9, 25, 33, 59]) {
    const prefix = computeIntraday(candles.slice(0, i + 1));
    assert.deepEqual(prefix[i], full[i]);
  }
  // Warmup: early bars are null, later bars are populated.
  assert.equal(full[0].ema9, null);
  assert.ok(Number.isFinite(full[59].ema9));
  assert.ok(Number.isFinite(full[59].macdHist));
});

// --- Volume fade (Johnny 2026-10-01: hold runners until volume falls off) --
const { volumeFadeDetected } = require('../lib/warrior/indicators');

function fadeTape({ bars = 40, baseVol = 20000, recentVol = 20000, stall = false } = {}) {
  const out = [];
  for (let i = 0; i < bars; i++) {
    const recent = i >= bars - 2;
    const c = 100 + i * 0.1;
    out.push({ t: T0 + i * 60000, o: c - 0.02, h: c + 0.05, l: c - 0.05, c, v: recent ? recentVol : baseVol });
  }
  if (stall) {
    // Final close breaks the prior bar's low.
    const last = out[out.length - 1];
    last.c = out[out.length - 2].l - 0.2;
    last.l = last.c - 0.05;
  }
  return out;
}

test('volumeFadeDetected: strong volume never fades, even on a stall', () => {
  assert.equal(volumeFadeDetected(fadeTape({ recentVol: 20000, stall: true })), false);
});

test('volumeFadeDetected: collapsed volume without a stall is not a fade', () => {
  assert.equal(volumeFadeDetected(fadeTape({ recentVol: 2000, stall: false })), false);
});

test('volumeFadeDetected: collapsed volume AND a stall is a fade', () => {
  assert.equal(volumeFadeDetected(fadeTape({ recentVol: 2000, stall: true })), true);
});

test('volumeFadeDetected: too little history never fades', () => {
  assert.equal(volumeFadeDetected(fadeTape({ bars: 10, recentVol: 1, stall: true })), false);
  assert.equal(volumeFadeDetected([]), false);
  assert.equal(volumeFadeDetected(null), false);
});

test('volumeFadeDetected: the fade fraction is configurable', () => {
  const tape = fadeTape({ recentVol: 9000, stall: true }); // 0.45x of baseline
  assert.equal(volumeFadeDetected(tape, { fadeVolumeFraction: 0.6 }), true);
  assert.equal(volumeFadeDetected(tape, { fadeVolumeFraction: 0.4 }), false);
});

// --- RSI (Johnny 2026-10-12: take profit at 75 RSI) -------------------------
test('rsiSeries is Wilder RSI: null until 15 closes, then seeded at index 14', () => {
  const short = rsiSeries([100, 101, 102], 14);
  assert.deepEqual(short, [null, null, null], 'fewer than period+1 closes read null');
  const closes = [100];
  for (let i = 1; i < 40; i++) closes.push(+(closes[i - 1] + 0.15).toFixed(2));
  const rsi = rsiSeries(closes, 14);
  assert.equal(rsi[13], null);
  assert.equal(rsi[14], 100, 'an all-gains seed reads 100');
  assert.equal(rsi[39], 100, 'an all-gains series stays 100');
});

test('rsiSeries extremes: all losses read 0, perfectly flat reads 50', () => {
  const down = [100];
  for (let i = 1; i < 30; i++) down.push(+(down[i - 1] - 0.2).toFixed(2));
  assert.equal(rsiSeries(down, 14)[29], 0);
  const flat = new Array(30).fill(100);
  assert.equal(rsiSeries(flat, 14)[29], 50);
});

test('rsiSeries matches the engineered borderline tape (74.80)', () => {
  const closes = [100];
  for (let i = 1; i < 40; i++) {
    const step = i % 3 === 0 ? -0.195 : 0.31;
    closes.push(Math.round((closes[i - 1] + step) * 100) / 100);
  }
  const rsi = rsiSeries(closes, 14);
  assert.ok(Math.abs(rsi[39] - 74.8) < 0.05, `expected ~74.80, got ${rsi[39]}`);
  // computeIntraday carries the same value on its rows.
  const bars = closes.map((c, i) => bar(i, i ? closes[i - 1] : c, c + 0.02, c - 0.02, c, 20000));
  const rows = computeIntraday(bars);
  assert.equal(rows[39].rsi, rsi[39]);
});
