'use strict';

// Flipper Bot — pure 3-candle setup evaluator ("Invisible Wall Reversal",
// SPEC §§4–7, §13; coordinator interpretations #2–#3).
//
// Stage 1 — detectWallTest({ walls, c1, rules }): does C1 (9:30–9:45 ET)
//   test-and-reject one of the four walls? Returns candidate list.
// Stage 2 — confirmC2({ candidate, c2, walls, rules }): is C2 (9:45–10:00 ET)
//   a silent confirmation candle in the opposite direction, without a
//   decisive wall break?
// Stage 3 — checkTrigger({ candidate, c2, price, rules }): has the live price
//   broken the C2 extreme? (Window-agnostic; the service only calls it during
//   10:00–10:15 ET, the backtester only on C3's 1-min bars.)
//
// NO I/O, no Date.now(), no network. Pure + deterministic.

const DEFAULT_FLIPPER_RULES = Object.freeze({
  minPrice: 1, maxPrice: 20,
  minAvgDailyVolume: 500000, minDayVolume: 50000, maxSpreadPct: 0.5,
  includeETFs: true, scanBudget: 100,
  swingLookback: 3, flipGapPct: 1.0, flipLookbackBars: 120,
  wallTolerancePct: 0.15,
  minC1MovePct: 0.75, breakoutCancelPct: 0.25,
  stopMode: 'structure', stopBufferPct: 0.1, stopPercent: 2.0, stopDollars: 0.10,
  targetMode: 'full', partialPct: 50, runnerTrailPct: 1.0, rrTarget: 2.0,
  sizeMode: 'shares', defaultShares: 100, defaultDollars: 2000,
  riskPct: 0.5, maxRiskPerTradePct: 1.0,
  maxPositions: 3, maxTradesPerDay: 5, maxDailyLossPct: 3,
  eodFlattenTime: '15:55', limitOffsetPct: 0.2,
  slippageBps: 5, commissionPerShare: 0.005,
  tradingMode: 'PAPER', liveEnabled: false, liveConfirmed: false,
});

const SETUP_STATES = Object.freeze([
  'no_setup', 'testing_wall', 'waiting_c2', 'waiting_trigger',
  'long_triggered', 'short_triggered', 'cancelled', 'expired',
]);

const validOhlc = c => c
  && Number.isFinite(+c.o) && Number.isFinite(+c.h)
  && Number.isFinite(+c.l) && Number.isFinite(+c.c);

const wallPriceOf = v => (v === null || v === undefined ? NaN : +v);

// Candidate shape: { direction: 'long'|'short',
//                    wallType: 'range_high'|'flip_high'|'range_low'|'flip_low',
//                    wallPrice }
function detectWallTest({ walls, c1, rules = {} }) {
  const r = { ...DEFAULT_FLIPPER_RULES, ...rules };
  if (!walls || !validOhlc(c1)) return [];
  const o = +c1.o; const h = +c1.h; const l = +c1.l; const c = +c1.c;
  if (o <= 0) return [];

  // SPEC §12 / interpretation #3: C1 must show meaningful movement toward the
  // wall — its range must be >= minC1MovePct of its open. Insignificant
  // touches are not setups.
  if (((h - l) / o) * 100 < +r.minC1MovePct) return [];

  const tol = Math.max(0, +r.wallTolerancePct) / 100;
  const cancel = Math.max(0, +r.breakoutCancelPct) / 100;
  const out = [];

  // Support wall test -> long candidate. Touch = C1 low within the tolerance
  // band (from 2*tol below the wall up to tol above it, i.e. dipping slightly
  // through is still a touch). Rejection = C1 did NOT close decisively below
  // the wall (beyond tolerance + breakoutCancelPct) — a wall that is cleanly
  // broken and accepted below is a breakout, not a reversal (SPEC §§7, 13).
  const testSupport = (wallType, rawPrice) => {
    const wallPrice = wallPriceOf(rawPrice);
    if (!Number.isFinite(wallPrice) || wallPrice <= 0) return;
    const touched = l <= wallPrice * (1 + tol) && l >= wallPrice * (1 - 2 * tol);
    if (!touched) return;
    if (c < wallPrice * (1 - tol - cancel)) return; // closed through: breakout
    out.push({ direction: 'long', wallType, wallPrice });
  };

  // Resistance wall test -> short candidate (mirrored).
  const testResistance = (wallType, rawPrice) => {
    const wallPrice = wallPriceOf(rawPrice);
    if (!Number.isFinite(wallPrice) || wallPrice <= 0) return;
    const touched = h >= wallPrice * (1 - tol) && h <= wallPrice * (1 + 2 * tol);
    if (!touched) return;
    if (c > wallPrice * (1 + tol + cancel)) return; // closed through: breakout
    out.push({ direction: 'short', wallType, wallPrice });
  };

  testSupport('range_low', walls.rangeLow);
  testSupport('flip_low', walls.flipLow);
  testResistance('range_high', walls.rangeHigh);
  testResistance('flip_high', walls.flipHigh);
  return out;
}

// confirmC2({ candidate, c2, walls, rules }) -> { ok, reasons[] }.
// Long requires a green (bullish) C2; short requires a red (bearish) C2 — the
// silent candle must move opposite to C1's push into the wall (SPEC §§5, 6).
// Breakout protection: C2 must not close through the wall beyond
// tolerance + breakoutCancelPct (SPEC §13). reasons[] explains the verdict in
// plain words for the dashboard "WHY" (SPEC §19).
function confirmC2({ candidate, c2, walls, rules = {} }) {
  const r = { ...DEFAULT_FLIPPER_RULES, ...rules };
  const reasons = [];
  if (!candidate || !validOhlc(c2)) {
    reasons.push('Missing candidate or C2 candle — cannot confirm the setup.');
    return { ok: false, reasons };
  }
  const o = +c2.o; const c = +c2.c;
  const wallPrice = wallPriceOf(candidate.wallPrice);
  const tol = Math.max(0, +r.wallTolerancePct) / 100;
  const cancel = Math.max(0, +r.breakoutCancelPct) / 100;
  const wallName = candidate.wallType.replace(/_/g, ' ');

  if (candidate.direction === 'long') {
    if (!(c > o)) {
      reasons.push(
        `C2 closed ${c === o ? 'flat' : 'red'} (open ${o}, close ${c}); ` +
        'a long setup needs a green confirmation candle moving opposite to C1.'
      );
      return { ok: false, reasons };
    }
    if (Number.isFinite(wallPrice) && c < wallPrice * (1 - tol - cancel)) {
      reasons.push(
        `C2 closed below the ${wallName} wall (${wallPrice}) beyond tolerance — ` +
        'the wall is decisively broken, so the reversal setup is cancelled.'
      );
      return { ok: false, reasons };
    }
    reasons.push(
      `C2 green (open ${o} → close ${c}), holding above the ${wallName} wall (${wallPrice}); ` +
      'selling pressure is weakening — waiting for the C2-high trigger.'
    );
    return { ok: true, reasons };
  }

  if (candidate.direction === 'short') {
    if (!(c < o)) {
      reasons.push(
        `C2 closed ${c === o ? 'flat' : 'green'} (open ${o}, close ${c}); ` +
        'a short setup needs a red confirmation candle moving opposite to C1.'
      );
      return { ok: false, reasons };
    }
    if (Number.isFinite(wallPrice) && c > wallPrice * (1 + tol + cancel)) {
      reasons.push(
        `C2 closed above the ${wallName} wall (${wallPrice}) beyond tolerance — ` +
        'the wall is decisively broken, so the reversal setup is cancelled.'
      );
      return { ok: false, reasons };
    }
    reasons.push(
      `C2 red (open ${o} → close ${c}), holding below the ${wallName} wall (${wallPrice}); ` +
      'buying pressure is weakening — waiting for the C2-low trigger.'
    );
    return { ok: true, reasons };
  }

  reasons.push(`Unknown candidate direction '${candidate.direction}'.`);
  return { ok: false, reasons };
}

// checkTrigger({ candidate, c2, price, rules }) -> { triggered, entryPrice }.
// Long: price > C2 high -> enter at the price that printed. Short: price < C2
// low. Strict inequality — merely touching the C2 extreme is not a break
// (SPEC §§5, 6: "Do not enter merely because Candle 3 is green").
// Breakout protection also applies at the trigger tick: never trigger into a
// price that has pushed decisively through the wall (SPEC §13).
function checkTrigger({ candidate, c2, price, rules = {} }) {
  const r = { ...DEFAULT_FLIPPER_RULES, ...rules };
  const px = +price;
  if (!candidate || !validOhlc(c2) || !Number.isFinite(px) || px <= 0) {
    return { triggered: false, entryPrice: null };
  }
  const tol = Math.max(0, +r.wallTolerancePct) / 100;
  const cancel = Math.max(0, +r.breakoutCancelPct) / 100;
  const wallPrice = wallPriceOf(candidate.wallPrice);
  if (Number.isFinite(wallPrice) && wallPrice > 0) {
    if (candidate.direction === 'long' && px < wallPrice * (1 - tol - cancel)) {
      return { triggered: false, entryPrice: null }; // into a decisive breakdown
    }
    if (candidate.direction === 'short' && px > wallPrice * (1 + tol + cancel)) {
      return { triggered: false, entryPrice: null }; // into a decisive breakout
    }
  }
  if (candidate.direction === 'long') {
    if (px > +c2.h) return { triggered: true, entryPrice: px };
  } else if (candidate.direction === 'short') {
    if (px < +c2.l) return { triggered: true, entryPrice: px };
  }
  return { triggered: false, entryPrice: null };
}

module.exports = {
  detectWallTest,
  confirmC2,
  checkTrigger,
  SETUP_STATES,
  DEFAULT_FLIPPER_RULES,
};
