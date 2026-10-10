'use strict';

// Flipper backtest engine tests (node:test).
//
// NOTE ON STUBS: the walls / signals / risk / journal workstreams build in
// parallel, and their modules currently deviate from the pinned
// ARCHITECTURE.md contracts (see the note above loadPinnedModule for the
// full list). The blocks marked [PINNED-CONTRACT STUB] below are thin
// stand-ins that implement ONLY the pinned contracts, and they are ALWAYS
// installed into require.cache for these tests so `require('../lib/flipper/
// backtest.js')` resolves its sibling imports to the pinned shapes. The
// coordinator reconciles the real modules to the pinned contracts and can
// then drop these stubs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------------------------------------------------------------------------
// ET time helpers (same approach as the engine under test).
// ---------------------------------------------------------------------------
const ET_TZ = 'America/New_York';
const dFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const tFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});
function etDateKey(t) { return dFmt.format(new Date(t)); }
function etMinutes(t) {
  const p = tFmt.formatToParts(new Date(t));
  return (Number(p.find(x => x.type === 'hour').value) % 24) * 60
    + Number(p.find(x => x.type === 'minute').value);
}
// Epoch ms for an ET wall-clock time, robust across DST boundaries.
function etBarMs(dateKey, mins) {
  const [Y, M, D] = dateKey.split('-').map(Number);
  let t = Date.UTC(Y, M - 1, D, 0, 0, 0) + mins * 60000;
  for (let k = 0; k < 4; k++) {
    const key = etDateKey(t);
    const m = etMinutes(t);
    if (key === dateKey && m === mins) return t;
    const target = Date.UTC(Y, M - 1, D) / 60000 + mins;
    const [gy, gm, gd] = key.split('-').map(Number);
    const got = Date.UTC(gy, gm - 1, gd) / 60000 + m;
    t += Math.round((target - got) * 60000);
  }
  throw new Error(`etBarMs failed for ${dateKey} ${mins}`);
}
function addDays(dateKey, n) {
  const [Y, M, D] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D) + n * 86400000).toISOString().slice(0, 10);
}
const C = (dk, mins, o, h, l, c, v = 1000) => ({ t: etBarMs(dk, mins), o, h, l, c, v });
const DC = (dk, o, h, l, c, v = 1e6) => ({ t: etBarMs(dk, 16 * 60), o, h, l, c, v });

// ---------------------------------------------------------------------------
// [PINNED-CONTRACT STUB] lib/flipper/walls.js — computeWalls
// Yesterday's range = last daily bar; flip swings from the remaining bars.
// DELIBERATELY future-sensitive: if the engine leaked post-D bars into
// dailyBars, flipHigh/flipLow would change — the no-future-data test exploits
// this to prove the engine filters by construction.
// ---------------------------------------------------------------------------
const wallCalls = []; // instrumented: every computeWalls invocation
function stubComputeWalls({ symbol, tradeDate, dailyBars, rules }) {
  const bars = [...dailyBars].sort((a, b) => a.t - b.t);
  if (bars.length === 0) throw new Error('stub: no daily bars');
  const y = bars[bars.length - 1];
  const rangeHigh = y.h;
  const rangeLow = y.l;
  const prior = bars.slice(0, -1);
  const gap = (rules && rules.flipGapPct) || 1.0;
  let flipHigh = null;
  let flipLow = null;
  for (const b of prior) {
    if (b.h > rangeHigh * (1 + gap / 100) && (flipHigh === null || b.h > flipHigh)) flipHigh = b.h;
    if (b.l < rangeLow * (1 - gap / 100) && (flipLow === null || b.l < flipLow)) flipLow = b.l;
  }
  const walls = { symbol, tradeDate, rangeHigh, rangeLow, flipHigh, flipLow };
  wallCalls.push({ symbol, tradeDate, dailyN: bars.length, dailyT: bars.map(b => b.t), walls });
  return walls;
}

// ---------------------------------------------------------------------------
// [PINNED-CONTRACT STUB] lib/flipper/signals.js
// detectWallTest / confirmC2 / checkTrigger per the pinned shapes.
// ---------------------------------------------------------------------------
function stubDetectWallTest({ walls, c1, rules }) {
  const tol = ((rules && rules.wallTolerancePct) || 0.15) / 100;
  const out = [];
  const sides = [
    ['range_low', walls.rangeLow, 'long'],
    ['flip_low', walls.flipLow, 'long'],
    ['range_high', walls.rangeHigh, 'short'],
    ['flip_high', walls.flipHigh, 'short'],
  ];
  for (const [wallType, wall, direction] of sides) {
    if (wall === null || wall === undefined) continue;
    const extreme = direction === 'long' ? c1.l : c1.h;
    if (Math.abs(extreme - wall) / wall > tol) continue; // no touch
    const rejected = direction === 'long' ? c1.c > wall : c1.c < wall; // close back on the right side
    if (!rejected) continue;
    out.push({
      wallType, wallPrice: wall, direction, c1,
      rejectionStrength: 0.8, priorityScore: 0.9,
      reasons: [`stub: C1 tested ${wallType} @ ${wall}`],
    });
  }
  return out;
}
function stubConfirmC2({ candidate, c2, walls, rules }) {
  void walls; void rules;
  const green = c2.c > c2.o;
  const ok = candidate.direction === 'long' ? green : !green;
  if (!ok) return { state: 'no_setup', reasons: ['stub: C2 moved the wrong way'] };
  return {
    state: 'waiting_trigger',
    direction: candidate.direction,
    wallType: candidate.wallType,
    wallPrice: candidate.wallPrice,
    c1: candidate.c1,
    c2,
    triggerPrice: candidate.direction === 'long' ? c2.h : c2.l,
    priorityScore: candidate.priorityScore ?? 0.9,
    reasons: ['stub: C2 confirms the reversal'],
  };
}
function stubCheckTrigger({ candidate, c2, price }) {
  const dir = candidate.direction;
  if (dir === 'long') {
    return price > c2.h
      ? { state: 'long_triggered', direction: 'long', triggerPrice: c2.h, reasons: ['stub: broke C2 high'] }
      : { state: 'waiting_trigger', direction: 'long', triggerPrice: c2.h, reasons: ['stub: no break'] };
  }
  return price < c2.l
    ? { state: 'short_triggered', direction: 'short', triggerPrice: c2.l, reasons: ['stub: broke C2 low'] }
    : { state: 'waiting_trigger', direction: 'short', triggerPrice: c2.l, reasons: ['stub: no break'] };
}

// ---------------------------------------------------------------------------
// [PINNED-CONTRACT STUB] lib/flipper/risk.js
// ---------------------------------------------------------------------------
function stubComputeStop({ direction, c1, rules }) {
  const buf = ((rules && rules.stopBufferPct) || 0.1) / 100;
  return direction === 'long' ? c1.l * (1 - buf) : c1.h * (1 + buf);
}
function stubComputeTarget({ direction, walls, rules }) {
  void rules;
  return direction === 'long' ? walls.rangeHigh : walls.rangeLow;
}
function stubSizePosition({ entryPrice, stopPrice, targetPrice, equity, rules }) {
  void entryPrice; void stopPrice; void targetPrice; void equity;
  return { shares: Math.max(1, Math.floor((rules && rules.defaultShares) || 100)) };
}

// ---------------------------------------------------------------------------
// [PINNED-CONTRACT STUB] lib/flipper/journal.js — pass-through record builder.
// ---------------------------------------------------------------------------
function stubBuildTradeRecord(fields = {}) {
  const rec = { ...fields };
  if (!rec.tradeId && rec.ticker && rec.entryAt !== null && rec.entryAt !== undefined) {
    rec.tradeId = `${String(rec.ticker).toUpperCase()}-${rec.entryAt}`;
  }
  return rec;
}

// Install the pinned-contract stubs into require.cache so the engine's
// sibling imports (./walls, ./signals, ./risk, ./journal) resolve to them.
// NOTE (2026-09-29): the real lib/flipper/{walls,signals,risk,journal}.js
// files now exist but DEVIATE from the pinned ARCHITECTURE.md contracts, so
// the tests pin to the contracts via these stubs. Deviations found (for the
// coordinator's reconciliation):
//   - signals.confirmC2 returns { ok, reasons[] }, pinned: { state, ... }
//     with state 'waiting_trigger' marking a confirmed setup.
//   - signals.checkTrigger returns { triggered, entryPrice }, pinned:
//     { state: 'long_triggered'|'short_triggered', triggerPrice }.
//   - signals.detectWallTest candidates lack the pinned c1/priorityScore/
//     reasons fields (engine only needs direction/wallType/wallPrice).
//   - risk.sizePosition returns a bare number of shares, pinned: { shares }.
//   - risk.computeTarget returns { target, plan, fallback, note }, pinned: a
//     target price number.
//   - journal.buildTradeRecord keeps EXACTLY the 20 SPEC §18 fields and drops
//     everything else (notably date/enteredAt/exitedAt/shares, which the
//     engine passes and the report reads); pinned behaviour is pass-through
//     like lib/warrior/journal.js.
// The engine (lib/flipper/backtest.js) is coded to the pinned contracts per
// the coordinator's instruction ("code against these pinned imports; the
// coordinator reconciles"). Once the siblings are reconciled to the pinned
// contracts, these stubs can be dropped and the real modules used directly.
function loadPinnedModule(name, stubExports) {
  const cacheKey = path.resolve(__dirname, '../lib/flipper', `${name}.js`);
  require.cache[cacheKey] = { id: cacheKey, filename: cacheKey, loaded: true, exports: stubExports };
}
loadPinnedModule('walls', { computeWalls: stubComputeWalls });
loadPinnedModule('signals', {
  detectWallTest: stubDetectWallTest, confirmC2: stubConfirmC2, checkTrigger: stubCheckTrigger,
});
loadPinnedModule('risk', {
  sizePosition: stubSizePosition, computeStop: stubComputeStop, computeTarget: stubComputeTarget,
});
loadPinnedModule('journal', { buildTradeRecord: stubBuildTradeRecord });

const { runBacktest } = require('../lib/flipper/backtest.js');

// ---------------------------------------------------------------------------
// Synthetic fixtures.
// Trade date D = 2026-09-29 (Tuesday). Yesterday (2026-09-28): range 100–105.
// Flip levels: flipHigh = 108 (2026-09-23), flipLow = 98 (2026-09-24).
// ---------------------------------------------------------------------------
const D = '2026-09-29';
function dailyBars() {
  return [
    DC('2026-09-21', 100, 101, 99, 100.5),
    DC('2026-09-22', 100.5, 102, 99.5, 101),
    DC('2026-09-23', 101, 108, 100, 107),
    DC('2026-09-24', 107, 107.5, 98, 99),
    DC('2026-09-25', 99, 101, 98.5, 100),
    DC('2026-09-28', 102, 105, 100, 104),
  ];
}
// C1 touches range low (99.95 within 0.15% of 100) and rejects (close 101.5).
// C2 is green. Trigger level = C2 high = 103.
function sessionM15() {
  return [
    C(D, 570, 102, 102.5, 99.95, 101.5),   // C1
    C(D, 585, 101.5, 103, 101.2, 102.8),   // C2
    C(D, 600, 102.8, 103.2, 102.5, 103),   // C3
  ];
}
// Winner: 10:00 bar breaks C2 high (103.5 > 103) → fill 10:01 open 103.4 →
// price climbs through the range-high target 105.
function winnerM1() {
  return [
    C(D, 600, 102.9, 103.5, 102.8, 103.2),
    C(D, 601, 103.4, 103.6, 103.2, 103.5),
    C(D, 602, 103.5, 104.0, 103.4, 103.9),
    C(D, 603, 103.9, 104.5, 103.8, 104.4),
    C(D, 604, 104.4, 105.3, 104.3, 105.0),
    C(D, 605, 105.0, 105.2, 104.9, 105.1),
    C(D, 606, 105.1, 105.3, 105.0, 105.2),
  ];
}
function flatM1(fromMin, toMin, o = 103.5, h = 103.7, l = 103.3, c = 103.5) {
  const out = [];
  for (let m = fromMin; m <= toMin; m++) out.push(C(D, m, o, h, l, c));
  return out;
}

describe('flipper backtest — point-in-time discipline', () => {
  it('no-future-data: identical walls, trades and report with/without 60 future daily bars', () => {
    const base = { daily: dailyBars(), m15: sessionM15(), m1: winnerM1() };
    wallCalls.length = 0;
    const runA = runBacktest({ barsBySymbol: { SYM: base }, config: { targetMode: 'full' } });
    const callsA = JSON.parse(JSON.stringify(wallCalls));

    const future = [];
    for (let i = 1; i <= 60; i++) {
      const dk = addDays(D, i);
      // An extreme future high that WOULD corrupt flipHigh if it leaked in.
      future.push(i === 10 ? DC(dk, 110, 250, 99, 240) : DC(dk, 100 + i, 101 + i, 99 + i, 100 + i));
    }
    wallCalls.length = 0;
    const runB = runBacktest({
      barsBySymbol: { SYM: { daily: [...dailyBars(), ...future], m15: sessionM15(), m1: winnerM1() } },
      config: { targetMode: 'full' },
    });
    const callsB = JSON.parse(JSON.stringify(wallCalls));

    assert.equal(callsA.length, 1, 'walls computed once for D');
    assert.deepEqual(callsB, callsA, 'computeWalls received byte-identical inputs');
    assert.equal(callsA[0].walls.flipHigh, 108, 'flipHigh from pre-D data only');
    assert.equal(callsA[0].walls.flipLow, 98, 'flipLow from pre-D data only');
    assert.deepEqual(runB.trades, runA.trades, 'identical trades');
    assert.deepEqual(runB.report, runA.report, 'identical report');
  });

  it('no repaint: a triggered signal keeps the same entry bar index across runs', () => {
    const input = { barsBySymbol: { SYM: { daily: dailyBars(), m15: sessionM15(), m1: winnerM1() } }, config: { targetMode: 'full' } };
    const r1 = runBacktest(input);
    const r2 = runBacktest(input);
    assert.equal(r1.trades.length, 1);
    assert.equal(r2.trades.length, 1);
    assert.equal(r1.trades[0].entryTimestamp, r2.trades[0].entryTimestamp, 'same entry timestamp');
    const m1 = input.barsBySymbol.SYM.m1;
    const idx1 = m1.findIndex(b => b.t === r1.trades[0].entryTimestamp);
    const idx2 = m1.findIndex(b => b.t === r2.trades[0].entryTimestamp);
    assert.ok(idx1 >= 0 && idx1 === idx2, `same entry bar index (${idx1})`);
    assert.deepEqual(r2.report, r1.report, 'same report');
  });
});

describe('flipper backtest — execution model', () => {
  it('stop-before-target: a bar touching both exits at the stop (conservative)', () => {
    const m1 = [
      C(D, 600, 102.9, 103.5, 102.8, 103.2), // trigger
      C(D, 601, 103.4, 103.6, 103.2, 103.5), // fill @ 103.4 open
      C(D, 602, 103.4, 106.0, 99.5, 104.0),  // touches target (105) AND stop (~99.85)
    ];
    const { trades } = runBacktest({
      barsBySymbol: { SYM: { daily: dailyBars(), m15: sessionM15(), m1 } },
      config: { targetMode: 'full' },
    });
    assert.equal(trades.length, 1);
    assert.equal(trades[0].exitReason, 'stop', 'stop wins when both are touched');
    assert.ok(trades[0].exitPrice < 100, `exit near the stop, got ${trades[0].exitPrice}`);
    assert.ok(trades[0].pnl < 0, 'losing trade');
  });

  it('EOD flatten: an open position is closed at the eodFlattenTime bar open', () => {
    const m1 = [
      C(D, 600, 102.9, 103.5, 102.8, 103.2), // trigger
      C(D, 601, 103.4, 103.6, 103.2, 103.5), // fill
      ...flatM1(602, 954),                    // drift — never hits stop or target
      C(D, 955, 103.5, 103.6, 103.4, 103.5), // 15:55 ET bar
      C(D, 956, 103.5, 103.6, 103.4, 103.5),
    ];
    const { trades } = runBacktest({
      barsBySymbol: { SYM: { daily: dailyBars(), m15: sessionM15(), m1 } },
      config: { targetMode: 'full' },
    });
    assert.equal(trades.length, 1);
    assert.equal(trades[0].exitReason, 'eod');
    assert.equal(trades[0].exitTimestamp, etBarMs(D, 955), 'flattened on the 15:55 bar');
    assert.equal(etMinutes(trades[0].exitTimestamp), 955);
  });

  it('commissions + slippage reduce PnL versus a zero-cost run', () => {
    const input = () => ({
      barsBySymbol: { SYM: { daily: dailyBars(), m15: sessionM15(), m1: winnerM1() } },
      config: { targetMode: 'full' },
    });
    const withCosts = runBacktest({ ...input(), config: { targetMode: 'full', slippageBps: 5, commissionPerShare: 0.005 } });
    const zeroCost = runBacktest({ ...input(), config: { targetMode: 'full', slippageBps: 0, commissionPerShare: 0 } });
    assert.equal(withCosts.trades.length, 1);
    assert.equal(zeroCost.trades.length, 1);
    assert.ok(withCosts.trades[0].pnl < zeroCost.trades[0].pnl, 'costs reduce PnL');
    assert.ok(withCosts.trades[0].slippageCost > 0, 'slippage recorded');
    assert.ok(withCosts.trades[0].commissionCost > 0, 'commission recorded');
    assert.equal(zeroCost.trades[0].slippageCost, 0);
    assert.equal(zeroCost.trades[0].commissionCost, 0);
  });
});

describe('flipper backtest — report and happy path', () => {
  it('report contains every SPEC §20 field plus start/end equity', () => {
    const { report } = runBacktest({
      barsBySymbol: { SYM: { daily: dailyBars(), m15: sessionM15(), m1: winnerM1() } },
      config: { targetMode: 'full' },
    });
    for (const key of [
      'totalTrades', 'winningTrades', 'losingTrades', 'winRate',
      'averageWinner', 'averageLoser', 'profitFactor', 'maxDrawdown',
      'averageTrade', 'largestWin', 'largestLoss', 'totalReturn',
      'consecutiveWins', 'consecutiveLosses',
      'startEquity', 'endEquity',
    ]) {
      assert.ok(key in report, `report has ${key}`);
      // profitFactor is legitimately Infinity when there are no losing trades.
      const okFinite = key === 'profitFactor'
        ? (Number.isFinite(report[key]) || report[key] === Infinity)
        : Number.isFinite(report[key]);
      assert.ok(okFinite, `${key} is a number (got ${report[key]})`);
    }
  });

  it('synthetic long winner: 1 winning trade, target = range high', () => {
    const { report, trades } = runBacktest({
      barsBySymbol: { SYM: { daily: dailyBars(), m15: sessionM15(), m1: winnerM1() } },
      config: { targetMode: 'full' },
    });
    assert.equal(trades.length, 1, 'exactly one trade');
    const t = trades[0];
    assert.equal(t.direction, 'long');
    assert.equal(t.wallType, 'range_low');
    assert.equal(t.wallPrice, 100);
    assert.equal(t.targetPrice, 105, 'primary target is the range high');
    assert.equal(t.exitReason, 'target');
    assert.ok(t.pnl > 0, `winning trade, pnl=${t.pnl}`);
    assert.equal(report.totalTrades, 1);
    assert.equal(report.winningTrades, 1);
    assert.equal(report.losingTrades, 0);
    assert.equal(report.winRate, 1);
    assert.ok(report.averageWinner > 0);
    assert.equal(report.largestWin, report.averageWinner);
    assert.ok(report.endEquity > report.startEquity);
    assert.equal(report.totalReturn, +((report.endEquity - report.startEquity) / report.startEquity).toFixed(6));
  });

  it('partial_runner: exits partialPct at target, then trails the runner', () => {
    const m1 = [
      C(D, 600, 102.9, 103.5, 102.8, 103.2), // trigger
      C(D, 601, 103.4, 103.6, 103.2, 103.5), // fill
      C(D, 602, 103.5, 105.3, 103.4, 105.0), // target hit → partial
      C(D, 603, 105.0, 107.0, 104.9, 106.9), // runner trails up (1% trail = 105.93)
      C(D, 604, 106.9, 107.1, 104.5, 104.6), // pulls back through the trail → runner stopped
      C(D, 605, 104.6, 104.8, 104.4, 104.5),
    ];
    const { trades } = runBacktest({
      barsBySymbol: { SYM: { daily: dailyBars(), m15: sessionM15(), m1 } },
      config: { targetMode: 'partial', partialPct: 50, runnerTrailPct: 1.0 },
    });
    assert.equal(trades.length, 1);
    const t = trades[0];
    assert.equal(t.partialTaken, true, 'partial was taken at the target');
    assert.equal(t.exitReason, 'stop', 'runner exited via the trailing stop');
    assert.equal(t.stopKind, 'trail');
    assert.ok(t.exitPrice > 105, `trail exit above the target, got ${t.exitPrice}`);
    assert.ok(t.pnl > 0, 'net winner');
  });
});


describe('flipper backtest — two-candle touch window (2026-10-10)', () => {
  // C1 (570) never touches a wall. The SECOND candle (585) touches range
  // low 100 (low 99.95), the third candle (600) confirms green, and the
  // trigger window follows the confirmation: 615–630 ET 1-min bars, where
  // the 615 bar breaks the confirmation high (103) and 616 fills.
  function candle2SessionM15() {
    return [
      C(D, 570, 102, 102.5, 101.0, 101.8),  // C1 — no wall touch
      C(D, 585, 102, 102.5, 99.95, 101.5),  // C2 — touches range low, rejects
      C(D, 600, 101.5, 103, 101.2, 102.8),  // C3 — green confirmation
      C(D, 615, 102.8, 103.2, 102.5, 103),  // C4 — trigger-window candle
    ];
  }
  function candle2WinnerM1() {
    return [
      C(D, 615, 102.9, 103.5, 102.8, 103.2), // trigger: high breaks 103
      C(D, 616, 103.4, 103.6, 103.2, 103.5), // fill @ 103.4 open
      C(D, 617, 103.5, 104.0, 103.4, 103.9),
      C(D, 618, 103.9, 105.3, 103.8, 105.0), // target 105 hit
    ];
  }
  it('touch in candle 2 confirms on candle 3 and triggers in the following window', () => {
    const { report, trades } = runBacktest({
      barsBySymbol: { SYM: { daily: dailyBars(), m15: candle2SessionM15(), m1: candle2WinnerM1() } },
      config: { targetMode: 'full' },
    });
    assert.equal(trades.length, 1, `expected 1 trade, got ${trades.length}`);
    assert.equal(trades[0].direction, 'long');
    assert.equal(trades[0].wallType, 'range_low');
    assert.equal(trades[0].entryTimestamp, etBarMs(D, 616), 'filled on the bar after the 615 trigger bar');
    assert.equal(trades[0].exitReason, 'target');
    assert.ok(trades[0].pnl > 0);
    assert.equal(report.totalTrades, 1);
  });

  it('old behaviour preserved with touchWindowCandles set back to 1: the candle-2 touch is ignored', () => {
    const { trades } = runBacktest({
      barsBySymbol: { SYM: { daily: dailyBars(), m15: candle2SessionM15(), m1: candle2WinnerM1() } },
      config: { targetMode: 'full', rules: { touchWindowCandles: 1 } },
    });
    assert.equal(trades.length, 0);
  });
});
