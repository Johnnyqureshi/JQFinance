'use strict';

// Flipper 3-candle setup evaluator tests — long/short happy paths, C2
// confirmation, breakout cancellation, trigger behaviour, and reasons text.
// node:test style.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  detectWallTest, confirmC2, checkTrigger, SETUP_STATES, DEFAULT_FLIPPER_RULES,
} = require('../lib/flipper/signals');

// tol = 0.30%, cancel = 0.25%, minC1MovePct = 0.75% under pinned defaults
// (2026-10-10: band doubled from 0.15% by the diagnosis-design job — the
// explicit-rules tests below still exercise the old 0.15% band).
const WALLS = {
  symbol: 'TEST', tradeDate: '2026-09-29',
  rangeHigh: 10.00, rangeLow: 9.50, flipHigh: 10.20, flipLow: 9.30,
};

// --- long happy path --------------------------------------------------------
// C1 touches rangeLow (l=9.493 within 9.4715..9.50715) and closes back above it.
const LONG_C1 = { o: 9.80, h: 9.85, l: 9.493, c: 9.60 };
const LONG_C2 = { o: 9.60, h: 9.82, l: 9.58, c: 9.75 }; // green

// --- short happy path -------------------------------------------------------
// C1 touches rangeHigh (h=10.007 within 9.985..10.03) and closes back below it.
const SHORT_C1 = { o: 9.70, h: 10.007, l: 9.65, c: 9.80 };
const SHORT_C2 = { o: 9.80, h: 9.85, l: 9.58, c: 9.65 }; // red

test('exports exactly the pinned contract surface', () => {
  assert.equal(typeof detectWallTest, 'function');
  assert.equal(typeof confirmC2, 'function');
  assert.equal(typeof checkTrigger, 'function');
  assert.deepEqual(SETUP_STATES, [
    'no_setup', 'testing_wall', 'waiting_c2', 'waiting_trigger',
    'long_triggered', 'short_triggered', 'cancelled', 'expired',
  ]);
});

test('long happy path: touch + reject (C1), green C2, break of C2 high', () => {
  const candidates = detectWallTest({ walls: WALLS, c1: LONG_C1 });
  assert.deepEqual(candidates, [{ direction: 'long', wallType: 'range_low', wallPrice: 9.50 }]);

  const confirmed = confirmC2({ candidate: candidates[0], c2: LONG_C2, walls: WALLS });
  assert.equal(confirmed.ok, true);
  assert.ok(confirmed.reasons.length > 0);

  const trigger = checkTrigger({ candidate: candidates[0], c2: LONG_C2, price: 9.83 });
  assert.deepEqual(trigger, { triggered: true, entryPrice: 9.83 });
});

test('short happy path: touch + reject (C1), red C2, break of C2 low', () => {
  const candidates = detectWallTest({ walls: WALLS, c1: SHORT_C1 });
  assert.deepEqual(candidates, [{ direction: 'short', wallType: 'range_high', wallPrice: 10.00 }]);

  const confirmed = confirmC2({ candidate: candidates[0], c2: SHORT_C2, walls: WALLS });
  assert.equal(confirmed.ok, true);
  assert.ok(confirmed.reasons.length > 0);

  const trigger = checkTrigger({ candidate: candidates[0], c2: SHORT_C2, price: 9.57 });
  assert.deepEqual(trigger, { triggered: true, entryPrice: 9.57 });
});

test('support walls only ever produce long candidates (one wall, one direction)', () => {
  const candidates = detectWallTest({ walls: WALLS, c1: LONG_C1 });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(cd => cd.direction === 'long'));
  assert.ok(!candidates.some(cd => cd.direction === 'short'));
});

test('a flip wall touch produces a flip_wall candidate', () => {
  const c1 = { o: 9.60, h: 9.65, l: 9.293, c: 9.55 }; // touches flip_low 9.30, not range_low
  const candidates = detectWallTest({ walls: WALLS, c1 });
  assert.deepEqual(candidates, [{ direction: 'long', wallType: 'flip_low', wallPrice: 9.30 }]);
});

test('no-trade area: C1 between the walls with no touch yields no candidates', () => {
  const c1 = { o: 9.70, h: 9.75, l: 9.65, c: 9.70 }; // range 1.03% >= 0.75% but no wall touch
  assert.deepEqual(detectWallTest({ walls: WALLS, c1 }), []);
});

test('insignificant C1 move (below minC1MovePct) yields no candidates even at the wall', () => {
  const c1 = { o: 9.50, h: 9.507, l: 9.495, c: 9.50 }; // range 0.13% < 0.75%
  assert.deepEqual(detectWallTest({ walls: WALLS, c1 }), []);
});

test('C1 that closes decisively through the wall is a breakout, not a reversal', () => {
  const c1 = { o: 9.80, h: 9.85, l: 9.49, c: 9.44 }; // touched, but closed below 9.50*(1-0.0055)=9.4478
  assert.deepEqual(detectWallTest({ walls: WALLS, c1 }), []);
  const shortC1 = { o: 9.70, h: 10.03, l: 9.65, c: 10.06 }; // closed above 10*(1+0.0055)=10.055
  assert.deepEqual(detectWallTest({ walls: WALLS, c1: shortC1 }), []);
});

test('C2 of the wrong colour rejects the setup with a non-empty reasons[]', () => {
  const [candidate] = detectWallTest({ walls: WALLS, c1: LONG_C1 });
  const red = confirmC2({ candidate, c2: { o: 9.75, h: 9.78, l: 9.55, c: 9.60 }, walls: WALLS });
  assert.equal(red.ok, false);
  assert.ok(red.reasons.length > 0);
  assert.match(red.reasons.join(' '), /green/i);

  const [short] = detectWallTest({ walls: WALLS, c1: SHORT_C1 });
  const green = confirmC2({ candidate: short, c2: { o: 9.60, h: 9.80, l: 9.58, c: 9.75 }, walls: WALLS });
  assert.equal(green.ok, false);
  assert.ok(green.reasons.length > 0);
  assert.match(green.reasons.join(' '), /red/i);
});

test('C2 that closes through the wall cancels the setup (breakout protection)', () => {
  const [candidate] = detectWallTest({ walls: WALLS, c1: LONG_C1 });
  const broken = confirmC2({
    candidate, c2: { o: 9.40, h: 9.48, l: 9.38, c: 9.44 }, walls: WALLS,
  }); // green, but closed below range_low*(1-0.0055)=9.4478
  assert.equal(broken.ok, false);
  assert.ok(broken.reasons.length > 0);
  assert.match(broken.reasons.join(' '), /decisively broken/i);

  const [short] = detectWallTest({ walls: WALLS, c1: SHORT_C1 });
  const shortBroken = confirmC2({
    candidate: short, c2: { o: 10.10, h: 10.12, l: 10.05, c: 10.06 }, walls: WALLS,
  }); // red, but closed above range_high*(1+0.0055)=10.055
  assert.equal(shortBroken.ok, false);
  assert.ok(shortBroken.reasons.length > 0);
  assert.match(shortBroken.reasons.join(' '), /decisively broken/i);
});

test('price that never breaks the C2 extreme does not trigger (touching is not breaking)', () => {
  const [candidate] = detectWallTest({ walls: WALLS, c1: LONG_C1 });
  assert.deepEqual(checkTrigger({ candidate, c2: LONG_C2, price: 9.70 }), { triggered: false, entryPrice: null });
  // Exactly equal to the C2 high is not a break (strict inequality).
  assert.deepEqual(checkTrigger({ candidate, c2: LONG_C2, price: 9.82 }), { triggered: false, entryPrice: null });

  const [short] = detectWallTest({ walls: WALLS, c1: SHORT_C1 });
  assert.deepEqual(checkTrigger({ candidate: short, c2: SHORT_C2, price: 9.58 }), { triggered: false, entryPrice: null });
});

test('trigger is refused when the price has pushed decisively through the wall', () => {
  const [candidate] = detectWallTest({ walls: WALLS, c1: LONG_C1 });
  // C2 high sits below the wall and the "break" is really a breakdown past
  // the wall (9.445 < 9.50*(1-0.0055)=9.4478, yet above the C2 high 9.44)
  // — reversal protection, no entry.
  const c2 = { o: 9.42, h: 9.44, l: 9.39, c: 9.43 };
  assert.deepEqual(checkTrigger({ candidate, c2, price: 9.445 }), { triggered: false, entryPrice: null });
});

test('checkTrigger entryPrice is the exact triggering price', () => {
  const [candidate] = detectWallTest({ walls: WALLS, c1: LONG_C1 });
  const { triggered, entryPrice } = checkTrigger({ candidate, c2: LONG_C2, price: 9.8201 });
  assert.equal(triggered, true);
  assert.equal(entryPrice, 9.8201);
});

test('null flip walls are skipped; invalid inputs return safe empties', () => {
  const noFlip = { ...WALLS, flipHigh: null, flipLow: null };
  assert.deepEqual(detectWallTest({ walls: noFlip, c1: LONG_C1 }),
    [{ direction: 'long', wallType: 'range_low', wallPrice: 9.50 }]);
  assert.deepEqual(detectWallTest({ walls: WALLS, c1: null }), []);
  assert.deepEqual(detectWallTest({ walls: null, c1: LONG_C1 }), []);
  const bad = confirmC2({ candidate: null, c2: LONG_C2, walls: WALLS });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.length > 0);
  assert.deepEqual(checkTrigger({ candidate: null, c2: LONG_C2, price: 9.9 }),
    { triggered: false, entryPrice: null });
});

test('local DEFAULT_FLIPPER_RULES matches the pinned contract values', () => {
  assert.equal(DEFAULT_FLIPPER_RULES.wallTolerancePct, 0.30);
  assert.equal(DEFAULT_FLIPPER_RULES.touchWindowCandles, 2);
  assert.equal(DEFAULT_FLIPPER_RULES.minC1MovePct, 0.75);
  assert.equal(DEFAULT_FLIPPER_RULES.breakoutCancelPct, 0.25);
  assert.equal(DEFAULT_FLIPPER_RULES.stopMode, 'structure');
  assert.equal(DEFAULT_FLIPPER_RULES.targetMode, 'full');
  assert.equal(DEFAULT_FLIPPER_RULES.tradingMode, 'PAPER');
  assert.equal(DEFAULT_FLIPPER_RULES.liveEnabled, false);
  assert.equal(DEFAULT_FLIPPER_RULES.maxPositions, 3);
});

// --- 2026-10-10 design changes: doubled touch band + two-candle window ------
test('widened band (default 0.30%) counts a touch the old 0.15% band rejected', () => {
  // Support wall 9.50: old band floor = 9.50*(1-2*0.0015) = 9.4715; the low
  // 9.4575 sits below it (old: no touch) but inside the new band floor
  // 9.50*(1-2*0.003) = 9.443 (new: touch). Range 3.5% ≥ minC1MovePct and
  // the close holds the wall under both cancel bounds.
  const deepTouch = { o: 9.80, h: 9.85, l: 9.4575, c: 9.60 };
  assert.deepEqual(detectWallTest({ walls: WALLS, c1: deepTouch, rules: { wallTolerancePct: 0.15 } }), []);
  assert.deepEqual(detectWallTest({ walls: WALLS, c1: deepTouch }),
    [{ direction: 'long', wallType: 'range_low', wallPrice: 9.50 }]);
  // Resistance mirror: old band ceiling = 10*(1+2*0.0015) = 10.03; the high
  // 10.045 exceeds it (old: no touch) but is inside the new ceiling 10.06.
  const deepTouchShort = { o: 9.70, h: 10.045, l: 9.65, c: 9.80 };
  assert.deepEqual(detectWallTest({ walls: WALLS, c1: deepTouchShort, rules: { wallTolerancePct: 0.15 } }), []);
  assert.deepEqual(detectWallTest({ walls: WALLS, c1: deepTouchShort }),
    [{ direction: 'short', wallType: 'range_high', wallPrice: 10.00 }]);
});

test('old behaviour is preserved when the rules are set back (0.15% / 1 candle)', () => {
  const back = { wallTolerancePct: 0.15, touchWindowCandles: 1 };
  // The original happy paths still produce exactly the original candidates.
  assert.deepEqual(detectWallTest({ walls: WALLS, c1: LONG_C1, rules: back }),
    [{ direction: 'long', wallType: 'range_low', wallPrice: 9.50 }]);
  assert.deepEqual(detectWallTest({ walls: WALLS, c1: SHORT_C1, rules: back }),
    [{ direction: 'short', wallType: 'range_high', wallPrice: 10.00 }]);
  const [candidate] = detectWallTest({ walls: WALLS, c1: LONG_C1, rules: back });
  assert.equal(confirmC2({ candidate, c2: LONG_C2, walls: WALLS, rules: back }).ok, true);
  assert.deepEqual(checkTrigger({ candidate, c2: LONG_C2, price: 9.83, rules: back }),
    { triggered: true, entryPrice: 9.83 });
});
