'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runBacktest, DEFAULT_CONFIG } = require('../lib/warrior/backtest');
const { TRADE_FIELDS } = require('../lib/warrior/journal');

// 2026-09-28 is a Monday; 9:30 ET = 13:30 UTC (EDT).
const T0 = Date.UTC(2026, 8, 28, 13, 30);
const mkBar = (i, o, h, l, c, v = 1000) => ({ t: T0 + i * 60000, o, h, l, c, v });
const etMinutes = ms => {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  return (Number(p.find(x => x.type === 'hour').value) % 24) * 60
    + Number(p.find(x => x.type === 'minute').value);
};

// Flat at 100, then a steady climb starting after bar 60.
function climbBars() {
  const bars = [];
  for (let i = 0; i < 390; i += 1) {
    const c = i <= 60 ? 100 : 100 + Math.min(i - 60, 25) * 0.15;
    bars.push(mkBar(i, i === 0 ? 100 : bars[i - 1].c, c + 0.05, c - 0.05, c));
  }
  return bars;
}
const winStrategy = (symbol, ctx) =>
  (ctx.barIndex === 60 ? { entry: 100, stop: 99, target: 102, pattern_name: 'test' } : null);

test('a signal fills at the next bar open and exits at the target', () => {
  const { report, trades } = runBacktest({
    barsBySymbol: { TEST: { daily: [], m5: [], m1: climbBars() } },
    strategy: winStrategy, config: { equity: 25000 },
  });
  assert.equal(report.totalTrades, 1);
  assert.equal(report.wins, 1);
  assert.equal(report.losses, 0);
  assert.equal(trades[0].exitReason, 'target');
  assert.ok(trades[0].pnl > 0);
  assert.ok(trades[0].rMultiple > 0);
  assert.equal(trades[0].ticker, 'TEST');
  assert.equal(trades[0].orderStatus, 'filled');
  assert.ok(trades[0].holdMinutes > 0);
  // Report carries every specified field.
  for (const k of ['totalTrades', 'wins', 'losses', 'winRate', 'avgWinner', 'avgLoser',
    'profitFactor', 'expectancy', 'totalReturn', 'maxDrawdown', 'sharpe', 'avgR',
    'largestWinner', 'largestLoser', 'avgHoldMinutes', 'maxConsecWins', 'maxConsecLosses',
    'byPattern', 'byRegime', 'byHour', 'bySymbol', 'byMonth']) {
    assert.ok(k in report, `report missing ${k}`);
  }
  assert.equal(report.byPattern.test.trades, 1);
  assert.equal(report.bySymbol.TEST.trades, 1);
});

test('backtest is deterministic: same input, same report and journal', () => {
  const input = {
    barsBySymbol: { TEST: { daily: [], m5: [], m1: climbBars() } },
    strategy: winStrategy, config: { equity: 25000 },
  };
  const a = runBacktest(input);
  const b = runBacktest(input);
  assert.deepEqual(a.report, b.report);
  assert.deepEqual(a.trades, b.trades);
});

test('no look-ahead: a strategy that buys when the NEXT bar is up gets zero edge', () => {
  let sliceInvariant = true;
  const bars = [];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let c = 100;
  for (let i = 0; i < 200; i += 1) {
    c += (rnd() - 0.48) * 0.6;
    bars.push(mkBar(i, c, c + 0.2, c - 0.2, c));
  }
  const cheat = (symbol, ctx) => {
    // The engine slices history at the current bar: the future is unreachable.
    if (ctx.history.m1.length !== ctx.barIndex + 1) sliceInvariant = false;
    if (ctx.indicators.length !== ctx.barIndex + 1) sliceInvariant = false;
    const next = ctx.history.m1[ctx.barIndex + 1]; // always undefined
    if (next && next.c > ctx.bar.c) {
      return { entry: ctx.bar.c, stop: ctx.bar.c - 1, target: ctx.bar.c + 2, pattern_name: 'cheat' };
    }
    return null;
  };
  const { report } = runBacktest({
    barsBySymbol: { TEST: { daily: [], m5: [], m1: bars } },
    strategy: cheat, config: { equity: 25000 },
  });
  assert.equal(sliceInvariant, true);
  assert.equal(report.totalTrades, 0);
  assert.equal(report.expectancy, 0);
});

test('positions are flattened at 15:55 ET and never held overnight', () => {
  const bars = [];
  for (let i = 0; i < 390; i += 1) bars.push(mkBar(i, 100, 100.02, 99.98, 100));
  const strat = (s, ctx) => (ctx.barIndex === 30 ? { entry: 100, stop: 50, target: 200, pattern_name: 'eod' } : null);
  const { report, trades } = runBacktest({
    barsBySymbol: { TEST: { daily: [], m5: [], m1: bars } },
    strategy: strat, config: { equity: 25000 },
  });
  assert.equal(report.totalTrades, 1);
  assert.equal(trades[0].exitReason, 'eod');
  assert.equal(etMinutes(trades[0].exitedAt), 15 * 60 + 55);
  assert.ok(trades[0].holdMinutes < 400);
});

test('daily-loss halt stops new entries after the limit is breached', () => {
  const bars = [];
  for (let i = 0; i < 390; i += 1) {
    let o = 100; let h = 100.05; let l = 99.95; let cc = 100;
    if (i === 31) { o = 100; h = 100; l = 94; cc = 95; }   // gaps through any stop
    if (i > 31) { o = 95; h = 95.05; l = 94.95; cc = 95; }
    bars.push(mkBar(i, o, h, l, cc));
  }
  // Signals on every bar from 10:00 — only the first may trade.
  const strat = (s, ctx) => (ctx.barIndex >= 30
    ? { entry: ctx.bar.c, stop: ctx.bar.c - 0.5, target: ctx.bar.c + 1, pattern_name: 'halt' } : null);
  const { report } = runBacktest({
    barsBySymbol: { TEST: { daily: [], m5: [], m1: bars } },
    strategy: strat,
    config: { equity: 10000, riskPerTradePct: 0.5, maxDailyLossPct: 0.5 },
  });
  assert.equal(report.totalTrades, 1);
  assert.equal(report.losses, 1);
});

test('a stop-out is conservative: stop wins when a bar touches both', () => {
  const bars = [];
  for (let i = 0; i < 390; i += 1) {
    let o = 100; let h = 100.05; let l = 99.95; let cc = 100;
    if (i === 61) { o = 100; h = 103; l = 98; cc = 101; } // touches stop 99 AND target 102
    bars.push(mkBar(i, o, h, l, cc));
  }
  const strat = (s, ctx) => (ctx.barIndex === 60 ? { entry: 100, stop: 99, target: 102, pattern_name: 'both' } : null);
  const { trades } = runBacktest({
    barsBySymbol: { TEST: { daily: [], m5: [], m1: bars } },
    strategy: strat, config: { equity: 25000, partialAtR: 99 }, // disable partial for clarity
  });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, 'stop');
  assert.ok(trades[0].pnl < 0);
});

test('DEFAULT_CONFIG carries the spec execution settings', () => {
  assert.equal(DEFAULT_CONFIG.slippageBps, 5);
  assert.equal(DEFAULT_CONFIG.commissionPerShare, 0.005);
  assert.equal(DEFAULT_CONFIG.riskPerTradePct, 0.5);
  assert.equal(DEFAULT_CONFIG.maxDailyLossPct, 2);
  assert.equal(DEFAULT_CONFIG.maxPositions, 3);
  assert.equal(DEFAULT_CONFIG.minRR, 2.0);
  assert.equal(DEFAULT_CONFIG.partialAtR, 2);
  assert.equal(DEFAULT_CONFIG.partialPct, 0.5);
  assert.equal(DEFAULT_CONFIG.trailMethod, 'ema9');
});
