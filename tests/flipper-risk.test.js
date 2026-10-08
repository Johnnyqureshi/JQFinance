'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sizePosition, computeStop, computeTarget, priorityScore, rejectionStrength, DEFAULT_RISK_RULES, tickPrice,
} = require('../lib/flipper/risk');

test('DEFAULT_RISK_RULES match the pinned architecture values', () => {
  assert.equal(DEFAULT_RISK_RULES.stopMode, 'structure');
  assert.equal(DEFAULT_RISK_RULES.stopBufferPct, 0.1);
  assert.equal(DEFAULT_RISK_RULES.stopPercent, 2.0);
  assert.equal(DEFAULT_RISK_RULES.stopDollars, 0.10);
  assert.equal(DEFAULT_RISK_RULES.targetMode, 'full');
  assert.equal(DEFAULT_RISK_RULES.partialPct, 50);
  assert.equal(DEFAULT_RISK_RULES.runnerTrailPct, 1.0);
  assert.equal(DEFAULT_RISK_RULES.rrTarget, 2.0);
  assert.equal(DEFAULT_RISK_RULES.sizeMode, 'dollars');
  assert.equal(DEFAULT_RISK_RULES.defaultShares, 100);
  assert.equal(DEFAULT_RISK_RULES.defaultDollars, 2000);
  assert.equal(DEFAULT_RISK_RULES.riskPct, 0.5);
  assert.equal(DEFAULT_RISK_RULES.maxRiskPerTradePct, 1.0);
});

// --- sizePosition ---

test('sizePosition shares mode returns defaultShares', () => {
  assert.equal(sizePosition({ entryPrice: 10, stopPrice: 9.5, equity: 25000 }), 200); // dollars default: 2000/10
  assert.equal(sizePosition({ rules: { sizeMode: 'shares', defaultShares: 37 }, entryPrice: 10, stopPrice: 9.5, equity: 25000 }), 37);
});

test('sizePosition dollars mode floors defaultDollars / entryPrice', () => {
  assert.equal(
    sizePosition({ rules: { sizeMode: 'dollars', defaultDollars: 2000 }, entryPrice: 9.99, stopPrice: 9, equity: 25000 }),
    200 // floor(2000 / 9.99)
  );
  assert.equal(
    sizePosition({ rules: { sizeMode: 'dollars', defaultDollars: 2000 }, entryPrice: 10.01, stopPrice: 9, equity: 25000 }),
    199
  );
});

test('sizePosition risk_pct mode sizes from the risk budget', () => {
  // risk$ = 25000*0.5/100 = 125; perShare = |10-9.5| = 0.5 -> 250 shares,
  // then notional cap: 25000*1.0/100 = 250 -> floor(250/10) = 25.
  const shares = sizePosition({
    rules: { sizeMode: 'risk_pct' }, entryPrice: 10, stopPrice: 9.5, equity: 25000,
  });
  assert.equal(shares, 25);
});

test('sizePosition risk_pct mode without a binding cap uses full risk budget', () => {
  const shares = sizePosition({
    rules: { sizeMode: 'risk_pct', riskPct: 0.5, maxRiskPerTradePct: 100 },
    entryPrice: 10, stopPrice: 9.5, equity: 25000,
  });
  assert.equal(shares, 250); // floor(125 / 0.5)
});

test('sizePosition returns 0 on zero per-share risk (division-by-zero guard)', () => {
  assert.equal(sizePosition({ rules: { sizeMode: 'risk_pct' }, entryPrice: 10, stopPrice: 10, equity: 25000 }), 0);
});

test('sizePosition returns 0 on invalid inputs', () => {
  assert.equal(sizePosition({ entryPrice: 0, stopPrice: 9.5, equity: 25000 }), 0);
  assert.equal(sizePosition({ entryPrice: -5, stopPrice: 9.5, equity: 25000 }), 0);
  assert.equal(sizePosition({ entryPrice: 10, stopPrice: 9.5, equity: 0 }), 0);
  assert.equal(sizePosition({ entryPrice: NaN, stopPrice: 9.5, equity: 25000 }), 0);
  assert.equal(sizePosition({ rules: { sizeMode: 'dollars', defaultDollars: 0 }, entryPrice: 10, stopPrice: 9, equity: 25000 }), 0);
  assert.equal(sizePosition({ rules: { sizeMode: 'risk_pct', riskPct: 0 }, entryPrice: 10, stopPrice: 9, equity: 25000 }), 0);
  assert.equal(sizePosition({}), 0, 'missing everything yields 0, never throws');
});

// --- computeStop ---

test('computeStop structure: long below C1 low, short above C1 high, with buffer', () => {
  const c1 = { o: 10, h: 10.3, l: 9.8, c: 10.1 };
  // Raw stops are 9.8*0.999 = 9.7902 and 10.3*1.001 = 10.3103 — sub-penny,
  // so the tick-clean outputs land on the whole cent (see tickPrice tests).
  const longStop = computeStop({ direction: 'long', c1, entryPrice: 10.15 });
  assert.equal(longStop, 9.79);
  const shortStop = computeStop({ direction: 'short', c1, entryPrice: 9.9 });
  assert.equal(shortStop, 10.31);
});

// --- tickPrice / penny-tick rounding (Alpaca 422 regression) ---

test('tickPrice rounds to 2dp at $1+ and 4dp below $1 (Warrior parity)', () => {
  assert.equal(tickPrice(9.88974), 9.89);
  assert.equal(tickPrice(9.84015), 9.84);
  assert.equal(tickPrice(10.5), 10.5);
  assert.equal(tickPrice(0.8514477), 0.8514);
  assert.ok(Number.isNaN(tickPrice(NaN)));
});

test('computeStop structure: the $9.85 C1-low case rounds to the penny tick', () => {
  // Johnny's live case: C1 low $9.85, 0.1% structure buffer -> raw stop
  // 9.85 * 0.999 = 9.84015. Alpaca rejects that at $1+ (HTTP 422); the
  // stop that reaches the broker must be 9.84.
  const stop = computeStop({ direction: 'long', c1: { o: 9.95, h: 10, l: 9.85, c: 9.93 }, entryPrice: 9.87 });
  assert.equal(stop, 9.84);
});

test('computeStop percent mode and sub-$1 stops are tick-clean too', () => {
  // 9.87 * 0.98 = 9.6726 raw -> 9.67 on the penny tick.
  assert.equal(
    computeStop({ direction: 'long', c1: {}, entryPrice: 9.87, rules: { stopMode: 'percent' } }), 9.67);
  // Below $1 sub-penny is allowed to 4dp: 0.8523 * 0.999 = 0.8514477 -> 0.8514.
  assert.equal(
    computeStop({ direction: 'long', c1: { o: 0.86, h: 0.87, l: 0.8523, c: 0.865 }, entryPrice: 0.87 }), 0.8514);
});

test('computeStop percent and dollar modes, long and short', () => {
  const c1 = { o: 10, h: 10.3, l: 9.8, c: 10.1 };
  assert.equal(computeStop({ direction: 'long', c1, entryPrice: 10, rules: { stopMode: 'percent' } }), 9.8);
  assert.equal(computeStop({ direction: 'short', c1, entryPrice: 10, rules: { stopMode: 'percent' } }), 10.2);
  assert.equal(computeStop({ direction: 'long', c1, entryPrice: 10, rules: { stopMode: 'dollar' } }), 9.9);
  assert.equal(computeStop({ direction: 'short', c1, entryPrice: 10, rules: { stopMode: 'dollar' } }), 10.1);
});

test('computeStop structure with missing C1 extreme yields NaN, not a crash', () => {
  assert.ok(Number.isNaN(computeStop({ direction: 'long', c1: {}, entryPrice: 10 })));
  assert.ok(Number.isNaN(computeStop({ direction: 'short', c1: { l: 9.8 }, entryPrice: 10 })));
});

// --- computeTarget ---

test('computeTarget full: long targets rangeHigh, short targets rangeLow', () => {
  const walls = { rangeHigh: 12, rangeLow: 9.5 };
  const longT = computeTarget({ direction: 'long', walls, entryPrice: 10, stopPrice: 9.6 });
  assert.deepEqual(longT, { target: 12, plan: 'full', fallback: false, note: null });
  const shortT = computeTarget({ direction: 'short', walls, entryPrice: 10.5, stopPrice: 11 });
  assert.deepEqual(shortT, { target: 9.5, plan: 'full', fallback: false, note: null });
});

test('computeTarget partial_runner carries partialPct and runnerTrailPct', () => {
  const t = computeTarget({
    direction: 'long', walls: { rangeHigh: 12 }, entryPrice: 10, stopPrice: 9.6,
    rules: { targetMode: 'partial_runner' },
  });
  assert.equal(t.plan, 'partial_runner');
  assert.equal(t.target, 12);
  assert.equal(t.partialPct, 50);
  assert.equal(t.runnerTrailPct, 1.0);
});

test('computeTarget rr mode uses entry ± rr*risk', () => {
  const longT = computeTarget({
    direction: 'long', walls: { rangeHigh: 12 }, entryPrice: 10, stopPrice: 9.6,
    rules: { targetMode: 'rr' },
  });
  assert.equal(longT.plan, 'rr');
  assert.ok(Math.abs(longT.target - 10.8) < 1e-9); // 10 + 2*0.4
  const shortT = computeTarget({
    direction: 'short', walls: { rangeLow: 9 }, entryPrice: 10.5, stopPrice: 11,
    rules: { targetMode: 'rr' },
  });
  assert.ok(Math.abs(shortT.target - 9.5) < 1e-9); // 10.5 - 2*0.5
});

test('computeTarget falls back to rr target when the wall is on the wrong side', () => {
  const t = computeTarget({
    direction: 'long', walls: { rangeHigh: 9.9 }, entryPrice: 10, stopPrice: 9.6,
  });
  assert.equal(t.fallback, true);
  assert.ok(typeof t.note === 'string' && t.note.length > 0);
  assert.ok(Math.abs(t.target - 10.8) < 1e-9); // 10 + 2*0.4
});

// --- priorityScore ---

test('priorityScore applies the pinned 0.4/0.2/0.2/0.1/0.1 weights', () => {
  assert.equal(priorityScore({ rejectionStrength: 1, rvol: 1, rr: 1, liquidity: 1, spreadTightness: 1 }), 1);
  assert.equal(priorityScore({ rejectionStrength: 1 }), 0.4);
  assert.equal(priorityScore({ rvol: 1 }), 0.2);
  assert.equal(priorityScore({ rr: 1 }), 0.2);
  assert.equal(priorityScore({ liquidity: 1 }), 0.1);
  assert.equal(priorityScore({ spreadTightness: 1 }), 0.1);
  assert.equal(priorityScore({ rejectionStrength: 0.5, rvol: 0.5, rr: 0.5, liquidity: 0.5, spreadTightness: 0.5 }), 0.5);
});

test('priorityScore clamps inputs to 0..1 and treats NaN as 0', () => {
  assert.equal(priorityScore({ rejectionStrength: 5 }), 0.4, 'clamped to 1');
  assert.equal(priorityScore({ rejectionStrength: -3 }), 0, 'clamped to 0');
  assert.equal(priorityScore({ rejectionStrength: NaN, rvol: NaN, rr: NaN, liquidity: NaN, spreadTightness: NaN }), 0);
  assert.equal(priorityScore({}), 0);
});

// --- rejectionStrength ---

test('rejectionStrength measures the C1 wick ratio: long uses lower wick', () => {
  // o=10.1, h=10.3, l=9.7, c=10.2 -> lower wick = min(10.1,10.2)-9.7 = 0.4; range 0.6 -> 0.6667
  const s = rejectionStrength({ direction: 'long', c1: { o: 10.1, h: 10.3, l: 9.7, c: 10.2 } });
  assert.ok(Math.abs(s - 0.4 / 0.6) < 1e-9);
});

test('rejectionStrength short uses the upper wick', () => {
  // o=9.9, h=10.3, l=9.7, c=9.8 -> upper wick = 10.3-max(9.9,9.8) = 0.4; range 0.6
  const s = rejectionStrength({ direction: 'short', c1: { o: 9.9, h: 10.3, l: 9.7, c: 9.8 } });
  assert.ok(Math.abs(s - 0.4 / 0.6) < 1e-9);
});

test('rejectionStrength is 0 with no range or no wick', () => {
  assert.equal(rejectionStrength({ direction: 'long', c1: { o: 10, h: 10, l: 10, c: 10 } }), 0);
  // no lower wick: low == min(o,c)
  assert.equal(rejectionStrength({ direction: 'long', c1: { o: 9.7, h: 10.3, l: 9.7, c: 10.2 } }), 0);
  // bad data
  assert.equal(rejectionStrength({ direction: 'long', c1: {} }), 0);
  assert.equal(rejectionStrength({}), 0);
});
