'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeIntraday } = require('../lib/warrior/indicators');
const {
  detectCandleOverCandle, detectMicroPullback, detectBullFlag, detectABCD,
  detectCupAndHandle, detectInvertedHeadAndShoulders, detectVwapReclaim,
  detectPremarketBreak,
  detectAll,
} = require('../lib/warrior/patterns');

// 2026-09-28 is a Monday; 9:30 ET = 13:30 UTC (EDT).
const T0 = Date.UTC(2026, 8, 28, 13, 30);
const mk = specs => specs.map((s, i) => ({ t: T0 + i * 60000, o: s[0], h: s[1], l: s[2], c: s[3], v: s[4] ?? 1000 }));
const bg = (n, start = 100, step = 0.1) => {
  const out = []; let c = start;
  for (let i = 0; i < n; i += 1) { out.push([c, c + 0.05, c - 0.05, c + step]); c += step; }
  return out;
};
const setup = specs => {
  const candles = mk(specs);
  return { candles, ind: computeIntraday(candles) };
};
const RESULT_KEYS = ['pattern_name', 'pattern_valid', 'pattern_confidence', 'pattern_start_time',
  'pattern_completion_time', 'entry_price', 'stop_price', 'support_level', 'resistance_level',
  'invalidation_price', 'target_price', 'risk_reward', 'pattern_score', 'explanation'];
function assertShape(r) {
  for (const k of RESULT_KEYS) assert.ok(k in r, `missing key ${k}`);
  assert.ok(r.pattern_score >= 0 && r.pattern_score <= 3);
  assert.ok(r.pattern_confidence >= 0 && r.pattern_confidence <= 1);
}

// --- Candle over candle -----------------------------------------------------
const cocPos = () => setup([...bg(45), [104.5, 105.0, 104.3, 104.7], [104.7, 105.6, 104.6, 105.5, 1800]]);

test('CandleOverCandle fires on a high break with volume, VWAP and MACD', () => {
  const { candles, ind } = cocPos();
  const r = detectCandleOverCandle({ candles, ind, levels: { resistances: [111] } });
  assertShape(r);
  assert.equal(r.pattern_name, 'CandleOverCandle');
  assert.equal(r.pattern_valid, true);
  assert.equal(r.entry_price, 105.5);
  assert.equal(r.stop_price, 104.3);
  assert.equal(r.target_price, 111);
  assert.ok(r.risk_reward >= 2);
  assert.ok(r.pattern_start_time < r.pattern_completion_time);
});

test('CandleOverCandle with a far target over a healthy stop is invalid (rr > 5 cap)', () => {
  const { candles, ind } = cocPos();
  // entry 105.5, stop 104.3 → risk 1.2 (1.14%, above the noise floor);
  // resistance at 112 → rr 5.42 exceeds the 5 maximum.
  const r = detectCandleOverCandle({ candles, ind, levels: { resistances: [112] } });
  assert.equal(r.pattern_valid, false);
  assert.match(r.explanation, /exceeds the 5 maximum/);
  assert.ok(r.risk_reward > 5);
});

test('CandleOverCandle with a stop inside the noise floor is invalid', () => {
  // A low sits pennies under B's close: entry 105.5, stop 105.28 → 0.21%
  // stop distance, inside the 0.75% noise floor (the BBD/ITUB failure mode).
  const { candles, ind } = setup([...bg(45), [105.3, 105.4, 105.28, 105.35], [105.35, 105.6, 105.3, 105.5, 1800]]);
  const r = detectCandleOverCandle({ candles, ind, levels: { resistances: [112] } });
  assert.equal(r.pattern_valid, false);
  assert.match(r.explanation, /noise floor/);
});

test('CandleOverCandle returns null when B does not break A high', () => {
  const { candles, ind } = setup([...bg(45), [104.5, 105.0, 104.3, 104.7], [104.7, 104.9, 104.6, 104.8, 1800]]);
  assert.equal(detectCandleOverCandle({ candles, ind, levels: {} }), null);
});

test('CandleOverCandle with tight overhead resistance is invalid (rr < 2)', () => {
  const { candles, ind } = cocPos();
  // entry 105.5, stop 104.3 → risk 1.2; resistance at 107.5 → rr 1.67 < 2
  const r = detectCandleOverCandle({ candles, ind, levels: { resistances: [107.5] } });
  assert.equal(r.pattern_valid, false);
  assert.match(r.explanation, /below the 2 minimum/);
  assert.ok(r.risk_reward < 2);
});

// --- Micro pullback ----------------------------------------------------------
const mpPos = () => setup([...bg(45),
  [104.5, 104.95, 104.45, 104.9], [104.9, 105.35, 104.85, 105.3],
  [105.3, 105.75, 105.25, 105.7], [105.7, 106.15, 105.65, 106.1],
  [106.1, 106.15, 105.7, 105.8], [105.8, 105.85, 105.45, 105.5],
  [105.5, 106.5, 105.4, 106.4, 1600],
]);

test('MicroPullback fires on impulse + controlled pullback + continuation', () => {
  const { candles, ind } = mpPos();
  const r = detectMicroPullback({ candles, ind, levels: { resistances: [111] } });
  assertShape(r);
  assert.equal(r.pattern_valid, true);
  assert.equal(r.entry_price, 106.4);
  assert.equal(r.stop_price, 105.45);
  assert.ok(r.risk_reward >= 2);
});

test('MicroPullback returns null when the pullback retraces over 50%', () => {
  const { candles, ind } = setup([...bg(45),
    [104.5, 104.95, 104.45, 104.9], [104.9, 105.35, 104.85, 105.3],
    [105.3, 105.75, 105.25, 105.7], [105.7, 106.15, 105.65, 106.1],
    [106.1, 106.15, 104.9, 105.0], [105.0, 105.05, 104.4, 104.5],
    [105.5, 106.5, 105.4, 106.4, 1600],
  ]);
  assert.equal(detectMicroPullback({ candles, ind, levels: { resistances: [112] } }), null);
});

// --- Bull flag ---------------------------------------------------------------
const bfPos = () => {
  const imp = []; let c = 104.5;
  for (let i = 0; i < 6; i += 1) { imp.push([c, c + 0.6, c - 0.05, c + 0.55]); c += 0.55; }
  return setup([...bg(45), ...imp,
    [107.8, 107.9, 107.3, 107.4], [107.4, 107.7, 107.0, 107.1], [107.1, 107.5, 106.8, 106.9],
    [106.9, 108.2, 106.8, 108.0, 2000],
  ]);
};

test('BullFlag fires on impulse + flag + breakout with measured-move target', () => {
  const { candles, ind } = bfPos();
  const r = detectBullFlag({ candles, ind, levels: {} });
  assertShape(r);
  assert.equal(r.pattern_valid, true);
  assert.equal(r.entry_price, 108);
  assert.equal(r.stop_price, 106.8);
  assert.ok(r.risk_reward >= 2);
});

test('BullFlag returns null when the impulse is too weak', () => {
  const { candles, ind } = setup([...bg(45),
    [104.5, 104.6, 104.4, 104.55], [104.55, 104.65, 104.45, 104.6], [104.6, 104.7, 104.5, 104.65],
    [104.65, 104.75, 104.3, 104.4], [104.4, 104.6, 104.1, 104.2], [104.2, 104.5, 104.0, 104.1],
    [104.1, 104.9, 104.0, 104.8, 2000],
  ]);
  assert.equal(detectBullFlag({ candles, ind, levels: {} }), null);
});

// --- ABCD --------------------------------------------------------------------
const abcdBars = () => [
  [107, 107.5, 106.8, 107.2], [107.2, 108.5, 107, 108], [108, 109.5, 107.8, 109],
  [108.5, 111, 108.3, 110.5], [110.5, 110.8, 110, 110.2],                       // A = 111
  [110.2, 110.4, 109.5, 109.8], [109.8, 110, 109, 109.2], [109.2, 109.4, 108, 108.3],
  [108.3, 108.5, 107, 107.3], [106.5, 107, 105, 105.5], [105.5, 106, 105.2, 105.8], // B = 105
  [105.8, 106.5, 105.6, 106.2], [106.2, 107, 106, 106.6], [106.6, 108, 106.4, 107.5], // C = 108
  [107.5, 107.8, 106.5, 107.0], [107.0, 107.2, 106.2, 106.5], [106.5, 106.7, 105.9, 106.2], // D = 105.9
  [106.2, 106.6, 106.4, 106.5], [106.5, 107.2, 106.6, 107.0],
  [107.0, 108.8, 106.9, 108.5, 2200],                                          // breakout
];

test('ABCD fires when D holds above B and price breaks C resistance', () => {
  const { candles, ind } = setup([...bg(45), ...abcdBars()]);
  const r = detectABCD({ candles, ind, levels: {} });
  assertShape(r);
  assert.equal(r.pattern_valid, true);
  assert.equal(r.entry_price, 108.5);
  assert.equal(r.stop_price, 105.9);
  assert.equal(r.target_price, 114.5); // AB=CD projection
  assert.ok(r.risk_reward >= 2);
});

test('ABCD is invalidated (not null) when D undercuts B', () => {
  const bars = abcdBars();
  bars[16] = [106.5, 106.7, 104.9, 105.2]; // D = 104.9 < B = 105
  const { candles, ind } = setup([...bg(45), ...bars]);
  const r = detectABCD({ candles, ind, levels: {} });
  assert.equal(r.pattern_valid, false);
  assert.match(r.explanation, /undercut B/);
  assert.match(r.explanation, /INVALID/);
});

// --- Cup and handle ----------------------------------------------------------
const chBars = deepHandle => {
  const cup = [
    [102, 103, 101.8, 102.8], [102.8, 104.5, 102.6, 104.2], [104.2, 106, 104, 105.8],
    [105.8, 108, 105.5, 107.5], [107.5, 108.2, 107, 107.8],
    [107.8, 107.9, 106.5, 107], [107, 107.2, 105.8, 106], [106, 106.3, 104.8, 105],
    [105, 105.4, 103.8, 104], [104, 104.3, 103, 103.2],
    [103.2, 103.5, 102.2, 102.5], [102.5, 102.8, 102, 102.3], [102.3, 102.9, 102, 102.6],
    [102.6, 103.5, 102.4, 103.2], [103.2, 104.2, 103, 104],
    [104, 105, 103.8, 104.8], [104.8, 106, 104.5, 105.8], [105.8, 107, 105.5, 106.8],
    [106.8, 108, 106.5, 107.6], [107.6, 108.1, 107.3, 107.9],
    [107.9, 107.9, 107.2, 107.4], [107.4, 107.6, 106.9, 107.1],
    [107.1, 107.3, 106.8, 107.0], [107.0, 107.2, 106.7, 106.9],
  ];
  const handle = deepHandle
    ? [[107, 107.5, 105.5, 106.5], [106.5, 107, 105.8, 106.2], [106.2, 106.8, 105.6, 106.0], [106.0, 106.9, 105.7, 106.5]]
    : [[106.9, 107.0, 106.6, 106.8], [106.8, 107.0, 106.5, 106.9], [106.7, 106.9, 106.4, 106.8], [106.8, 107.0, 106.5, 106.9]];
  return [...cup, ...handle, [106.9, 108.6, 106.8, 108.4, 2500]];
};

test('CupAndHandle fires on a rounded cup, small handle and rim breakout', () => {
  const { candles, ind } = setup([...bg(20), ...chBars(false)]);
  const r = detectCupAndHandle({ candles, ind, levels: {} });
  assertShape(r);
  assert.equal(r.pattern_valid, true);
  assert.equal(r.entry_price, 108.4);
  assert.ok(r.risk_reward >= 2);
});

test('CupAndHandle returns null when the handle is too deep', () => {
  const { candles, ind } = setup([...bg(20), ...chBars(true)]);
  assert.equal(detectCupAndHandle({ candles, ind, levels: {} }), null);
});

// --- Inverted head and shoulders ----------------------------------------------
const ihsBars = () => [
  [103, 103.5, 102.8, 103.2], [103.2, 103.6, 102.5, 102.8], [102.8, 103, 102, 102.3],
  [102.3, 102.5, 101.5, 101.8], [101.8, 102, 101, 101.3],   // LS = 101
  [101.3, 101.8, 101.2, 101.6], [101.6, 102.5, 101.5, 102.2], [102.2, 103.5, 102, 103.2],
  [103.2, 103.4, 102, 102.5], [102.5, 102.7, 98, 98.5], [98.5, 99.5, 98.2, 99.2], [99.2, 100, 99, 99.5], // H = 98
  [100.5, 102, 100.3, 101.8], [101.8, 104, 101.5, 103.6],   // H2 = 104
  [103.6, 103.7, 103.2, 103.7], [103.7, 103.8, 103.3, 103.8], [103.8, 103.9, 102.5, 103.0], // RS = 102.5
  [103.0, 103.4, 102.9, 103.2], [103.2, 103.6, 103.0, 103.4],
  [103.4, 104.8, 103.3, 104.6, 2300],                       // neckline breakout
];

test('InvertedHeadAndShoulders fires on LS/H/RS with a neckline breakout', () => {
  const { candles, ind } = setup([...bg(30), ...ihsBars()]);
  const r = detectInvertedHeadAndShoulders({ candles, ind, levels: {} });
  assertShape(r);
  assert.equal(r.pattern_valid, true);
  assert.equal(r.entry_price, 104.6);
  assert.equal(r.stop_price, 102.5);
  assert.ok(r.risk_reward >= 2);
});

test('InvertedHeadAndShoulders returns null when the head is not the lowest', () => {
  const bars = ihsBars();
  bars[9] = [102.5, 102.7, 101.8, 102.2];
  bars[10] = [102.2, 102.6, 101.5, 102.0];
  bars[11] = [102.0, 102.8, 101.9, 102.5];
  bars[12] = [102.5, 103, 102.2, 102.8];
  const { candles, ind } = setup([...bg(30), ...bars]);
  assert.equal(detectInvertedHeadAndShoulders({ candles, ind, levels: {} }), null);
});

// --- VWAP reclaim ---------------------------------------------------------------
const vrBars = (vol = 3500, withConf = true) => {
  const dip = [[103.5, 103.6, 102.8, 103], [103, 103.2, 101.6, 101.8], [101.8, 102, 101.2, 101.4]];
  const x = [[101.4, 102.9, 101.3, 102.7, vol]];
  const conf = [[102.7, 103.4, 102.5, 103.2], [103.2, 104.2, 103.0, 104.0]];
  return withConf ? [...dip, ...x, ...conf] : [...dip, ...x];
};

test('VwapReclaim fires on dip + expanding cross + confirmation, never the cross alone', () => {
  const { candles, ind } = setup([...bg(40), ...vrBars()]);
  const r = detectVwapReclaim({ candles, ind, levels: { resistances: [110] } });
  assertShape(r);
  assert.equal(r.pattern_name, 'VwapReclaim');
  assert.equal(r.pattern_valid, true);
  assert.equal(r.entry_price, 104);
  assert.equal(r.stop_price, 101.2);
  assert.ok(r.risk_reward >= 2);
});

test('VwapReclaim returns null without volume expansion on the cross', () => {
  const { candles, ind } = setup([...bg(40), ...vrBars(900)]);
  assert.equal(detectVwapReclaim({ candles, ind, levels: { resistances: [110] } }), null);
});

test('VwapReclaim returns null on the cross alone (no confirmation bars)', () => {
  const { candles, ind } = setup([...bg(40), ...vrBars(3500, false)]);
  assert.equal(detectVwapReclaim({ candles, ind, levels: { resistances: [110] } }), null);
});

// --- detectAll ------------------------------------------------------------------
test('detectAll returns only valid patterns sorted by score desc', () => {
  const { candles, ind } = setup([...bg(40), ...vrBars()]);
  const all = detectAll({ candles, ind, levels: { resistances: [110] } });
  assert.ok(all.length >= 1);
  assert.ok(all.every(p => p.pattern_valid));
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(all[i - 1].pattern_score >= all[i].pattern_score);
  }
});

test('detectAll excludes patterns invalidated by the risk:reward gate', () => {
  const { candles, ind } = cocPos();
  const all = detectAll({ candles, ind, levels: { resistances: [107.5] } });
  assert.ok(all.every(p => p.pattern_name !== 'CandleOverCandle'));
});

test('detectors are deterministic: same input, same output', () => {
  const { candles, ind } = cocPos();
  const a = detectAll({ candles, ind, levels: { resistances: [112] } });
  const b = detectAll({ candles, ind, levels: { resistances: [112] } });
  assert.deepEqual(a, b);
});

// --- Premarket break (Johnny 2026-10-06) ------------------------------------
// Premarket range 08:00–09:29 ET tops at 10.20; regular bars build under it,
// then a break bar closes above it on heavy volume. 2026-09-28 is EDT:
// 08:00 ET = 12:00 UTC, 09:30 ET = 13:30 UTC.
function pmTape({ crossAtMin = 15, stale = false, cross = true } = {}) {
  const bars = [];
  const preStart = Date.UTC(2026, 8, 28, 12, 0);
  for (let m = 0; m < 90; m += 1) {
    bars.push({ t: preStart + m * 60000, o: 10.02, h: 10.20, l: 9.98, c: 10.05, v: 2000 });
  }
  const open = Date.UTC(2026, 8, 28, 13, 30);
  for (let m = 0; m < crossAtMin; m += 1) {
    bars.push({ t: open + m * 60000, o: 10.05, h: 10.14, l: 10.00, c: 10.10, v: 20000 });
  }
  if (cross) bars.push({ t: open + crossAtMin * 60000, o: 10.12, h: 10.38, l: 10.10, c: 10.35, v: 90000 });
  if (stale) bars.push({ t: open + (crossAtMin + 1) * 60000, o: 10.35, h: 10.45, l: 10.30, c: 10.42, v: 95000 });
  return { candles: bars, ind: computeIntraday(bars) };
}
const PM_LEVELS = { premarketHigh: 10.20, resistances: [10.95] };

test('PremarketBreak fires on a fresh break of the premarket high in the early window', () => {
  const { candles, ind } = pmTape();
  const r = detectPremarketBreak({ candles, ind, levels: PM_LEVELS });
  assertShape(r);
  assert.equal(r.pattern_name, 'PremarketBreak');
  assert.equal(r.pattern_valid, true);
  assert.equal(r.entry_price, 10.35);
  assert.equal(r.stop_price, 10.20, 'stop sits at the premarket high — the break fails if the level is lost');
  assert.equal(r.target_price, 10.95);
  assert.equal(r.risk_reward, 4);
  const all = detectAll({ candles, ind, levels: PM_LEVELS });
  assert.ok(all.some(p => p.pattern_name === 'PremarketBreak'), 'detectAll surfaces the new detector');
});

test('PremarketBreak ignores the still-forming opening-range high as its target', () => {
  // Service buildLevels passes openingRangeHigh from the first 30 minutes,
  // which mid-formation IS the break bar's own high (10.38) — 3 cents over
  // entry. The detector must not target it; the 2R fallback applies instead.
  const { candles, ind } = pmTape();
  const r = detectPremarketBreak({ candles, ind, levels: { premarketHigh: 10.20, openingRangeHigh: 10.38 } });
  assert.ok(r && r.pattern_valid);
  assert.equal(r.target_price, 10.65, 'fallback target entry + 2R, not the forming OR high');
  assert.equal(r.risk_reward, 2);
});

test('PremarketBreak is silent after the early window closes', () => {
  const { candles, ind } = pmTape({ crossAtMin: 135 }); // break at 11:45 ET
  assert.equal(detectPremarketBreak({ candles, ind, levels: PM_LEVELS }), null);
  // ...and fires on the same tape when the window is widened past it.
  const r = detectPremarketBreak({ candles, ind, levels: PM_LEVELS }, { earlyBreakWindowMinutes: 180 });
  assert.ok(r && r.pattern_valid, 'the window is rule-driven, not hardcoded');
});

test('PremarketBreak needs a premarket level and a fresh cross', () => {
  const noLevel = pmTape();
  assert.equal(detectPremarketBreak({ candles: noLevel.candles, ind: noLevel.ind, levels: {} }), null,
    'no premarket high, no break trade');
  const noCross = pmTape({ cross: false });
  assert.equal(detectPremarketBreak({ candles: noCross.candles, ind: noCross.ind, levels: PM_LEVELS }), null,
    'still under the level, no break');
  const stale = pmTape({ stale: true });
  assert.equal(detectPremarketBreak({ candles: stale.candles, ind: stale.ind, levels: PM_LEVELS }), null,
    'previous bar already closed above the level — an extension, not a break');
});
