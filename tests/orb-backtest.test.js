'use strict';

// ORB backtester tests (node:test).
//
// Fixtures use real 2026 calendar days: 2026-09-28 is a Monday, 2026-09-29 a
// Tuesday, 2026-09-30 a Wednesday (all EDT, UTC-4). 2026-09-29 serves as the
// strictly-prior history day (volume profile, ATR, prior high/low/close);
// 2026-09-30 is the evaluated trade date (startDate/endDate filter the
// evaluated dates, history is still drawn from earlier bars).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runBacktest, DEFAULT_BACKTEST_CONFIG } = require('../lib/orb/backtest');

// ---------------------------------------------------------------------------
// ET bar builders.
// ---------------------------------------------------------------------------
function etMs(dateStr, hm) {
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(`${dateStr}T12:00:00Z`)));
  const off = 12 - localHour; // 4 for EDT
  return Date.parse(`${dateStr}T${hm}:00-${String(off).padStart(2, '0')}:00`);
}
function hm(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
function bar(dateStr, minutes, o, h, l, c, v) {
  return { t: etMs(dateStr, hm(minutes)), o, h, l, c, v };
}
function flatRange(dateStr, fromMin, toMin, o, h, l, c, v) {
  const out = [];
  for (let m = fromMin; m <= toMin; m++) out.push(bar(dateStr, m, o, h, l, c, v));
  return out;
}

// Prior-day history: flat $10 area, 10k/min volume.
function historyDay(dateStr) {
  return flatRange(dateStr, 570, 960, 10.00, 10.10, 9.95, 10.05, 10000);
}

// Bullish prior-day regime: SPY/QQQ/IWM all up, VIX 18 and falling.
const IDX = {
  spy: [{ t: etMs('2026-09-28', '16:00'), c: 770 }, { t: etMs('2026-09-29', '16:00'), c: 775 }],
  qqq: [{ t: etMs('2026-09-28', '16:00'), c: 690 }, { t: etMs('2026-09-29', '16:00'), c: 693.5 }],
  iwm: [{ t: etMs('2026-09-28', '16:00'), c: 240 }, { t: etMs('2026-09-29', '16:00'), c: 241 }],
  vix: [{ t: etMs('2026-09-28', '16:00'), c: 19 }, { t: etMs('2026-09-29', '16:00'), c: 18 }],
};

// Hand-computable rules: fixed 100-share sizing, 1% stop, single 2R target,
// no slippage/commission (set on the runBacktest call), permissive gates.
const METRICS_RULES = {
  orMinutes: 15,
  entryMode: 'direct',
  minScore: 0,
  minRvol: 1, preferredRvol: 1, strongRvol: 2,
  minAvgVolume: 1,
  maxSpreadPct: 100,
  requireVwapAgree: false,
  minLevelClearancePct: 0,
  minRR: 1,
  maxWickPct: 100,
  maxExtensionAtrs: 100,
  stopMode: 'pct', stopPct: 1.0,
  targets: [{ r: 2, pct: 100 }],
  orWidthTargets: false,
  breakevenR: 100,
  trailMode: 'none',
  maxTradesPerDay: 10, maxConsecLosses: 100, maxDailyLossDollars: 1e9,
  maxTradesPerSymbol: 10, maxAttemptsPerSymbol: 2, cooldownMinutes: 2,
  maxPositions: 10, maxExposureDollars: 1e12,
  sizingMode: 'shares', fixedShares: 100,
  newsPolicy: 'allow',
  allowLong: true, allowShort: false,
};

// Trade date for AAA: OR 9:30-9:44 = $10.00-$10.10.
//   9:45 breaks out (close $10.25, heavy volume) -> long 100 @ $10.25,
//        stop $10.1475 (1%), target $10.455 (2R).
//   9:46 tags the target -> +$20.50 (+2R).
//   9:47 re-breakout -> long 100 @ $10.35, stop $10.2465, target $10.557.
//   9:48 stop hit -> -$10.35 (-1R).
//   9:49+ flat: maxAttemptsPerSymbol=2 blocks further entries.
function aaaDay() {
  return [
    ...flatRange('2026-09-30', 570, 584, 10.00, 10.10, 9.95, 10.05, 10000),
    bar('2026-09-30', 585, 10.05, 10.35, 10.04, 10.25, 100000),
    bar('2026-09-30', 586, 10.25, 10.50, 10.24, 10.48, 20000),
    bar('2026-09-30', 587, 10.48, 10.49, 10.30, 10.35, 20000),
    bar('2026-09-30', 588, 10.35, 10.36, 10.20, 10.22, 20000),
    ...flatRange('2026-09-30', 589, 960, 10.22, 10.25, 10.20, 10.22, 5000),
  ];
}

// WEAK: identical price action, but the breakout bar's volume collapses
// (500 vs 10k prior-bar average) -> VOLUME_FADING / WEAK_VOLUME rejection.
function weakDay() {
  return [
    ...flatRange('2026-09-30', 570, 584, 10.00, 10.10, 9.95, 10.05, 10000),
    bar('2026-09-30', 585, 10.05, 10.35, 10.04, 10.25, 500),
    bar('2026-09-30', 586, 10.25, 10.50, 10.24, 10.48, 20000),
    bar('2026-09-30', 587, 10.48, 10.49, 10.30, 10.35, 20000),
    bar('2026-09-30', 588, 10.35, 10.36, 10.20, 10.22, 20000),
    ...flatRange('2026-09-30', 589, 960, 10.22, 10.25, 10.20, 10.22, 5000),
  ];
}

function runMetrics(extraRules = {}) {
  return runBacktest({
    barsBySymbol: {
      AAA: [...historyDay('2026-09-29'), ...aaaDay()],
      WEAK: [...historyDay('2026-09-29'), ...weakDay()],
    },
    indexData: IDX,
    startDate: '2026-09-30',
    endDate: '2026-09-30',
    rules: { ...METRICS_RULES, ...extraRules },
    slippageBps: 0,
    commissionPerShare: 0,
  });
}

describe('orb backtester', () => {
  it('exports the default backtest config', () => {
    assert.deepStrictEqual(DEFAULT_BACKTEST_CONFIG, {
      initialEquity: 100000,
      slippageBps: 5,
      commissionPerShare: 0.005,
    });
  });

  it('takes a valid breakout trade and rejects the weak-volume setup', () => {
    const res = runMetrics();
    assert.strictEqual(res.trades.length, 2);
    for (const t of res.trades) assert.strictEqual(t.symbol, 'AAA');
    assert.ok(!res.trades.some(t => t.symbol === 'WEAK'),
      'the fading-volume setup must not produce a trade');

    const [t1, t2] = res.trades;
    assert.strictEqual(t1.direction, 'long');
    assert.strictEqual(t1.entryTime, etMs('2026-09-30', '09:45'));
    assert.strictEqual(t1.exitTime, etMs('2026-09-30', '09:46'));
    assert.strictEqual(t1.entryPrice, 10.25);
    assert.strictEqual(t1.exitPrice, 10.455);
    assert.strictEqual(t1.shares, 100);
    assert.strictEqual(t1.pnl, 20.5);
    assert.strictEqual(t1.rMultiple, 2);
    assert.strictEqual(t1.exitReason, 'target');
    assert.strictEqual(t1.orMinutes, 15);
    assert.strictEqual(t1.entryTimeBucket, '9:45-10:30');
    assert.strictEqual(t1.regime, 'bullish');
    assert.ok(typeof t1.entryReason === 'string' && t1.entryReason.includes('ENTER-LONG'));

    assert.strictEqual(t2.direction, 'long');
    assert.strictEqual(t2.entryTime, etMs('2026-09-30', '09:47'));
    assert.strictEqual(t2.exitTime, etMs('2026-09-30', '09:48'));
    assert.strictEqual(t2.entryPrice, 10.35);
    assert.strictEqual(t2.exitPrice, 10.2465);
    assert.strictEqual(t2.pnl, -10.35);
    assert.strictEqual(t2.rMultiple, -1);
    assert.strictEqual(t2.exitReason, 'stop');
  });

  it('no-look-ahead: a post-window favorable move is not traded', () => {
    // Chops inside the OR all morning; rockets +19% at 13:00 ET, after the
    // 9:45-11:30 entry window closes. The backtester must not touch it.
    const day = [
      ...flatRange('2026-09-30', 570, 584, 10.00, 10.07, 9.97, 10.02, 10000),
      ...flatRange('2026-09-30', 585, 779, 10.00, 10.06, 9.98, 10.02, 10000),
      bar('2026-09-30', 780, 10.05, 12.00, 10.04, 11.90, 500000),
      ...flatRange('2026-09-30', 781, 960, 11.90, 11.95, 11.85, 11.90, 10000),
    ];
    const res = runBacktest({
      barsBySymbol: { LATE: [...historyDay('2026-09-29'), ...day] },
      indexData: IDX,
      startDate: '2026-09-30',
      endDate: '2026-09-30',
      rules: METRICS_RULES,
      slippageBps: 0,
      commissionPerShare: 0,
    });
    assert.strictEqual(res.trades.length, 0);
    assert.strictEqual(res.summary.trades, 0);
    assert.strictEqual(res.summary.totalPnl, 0);
  });

  it('no-look-ahead: no entries before the opening range completes', () => {
    // The 9:44 bar closes at $10.65, above the partial 9:30-9:43 range high
    // ($10.10) — but the OR is not complete until 9:45, and its true high
    // ($10.70, set by that same 9:44 bar) is never broken afterwards.
    const day = [
      ...flatRange('2026-09-30', 570, 583, 10.00, 10.10, 9.95, 10.05, 10000),
      bar('2026-09-30', 584, 10.05, 10.70, 10.04, 10.65, 80000),
      ...flatRange('2026-09-30', 585, 960, 10.65, 10.68, 10.60, 10.64, 8000),
    ];
    const res = runBacktest({
      barsBySymbol: { EARLY: [...historyDay('2026-09-29'), ...day] },
      indexData: IDX,
      startDate: '2026-09-30',
      endDate: '2026-09-30',
      rules: METRICS_RULES,
      slippageBps: 0,
      commissionPerShare: 0,
    });
    assert.strictEqual(res.trades.length, 0);
    for (const t of res.trades) {
      assert.ok(t.entryTime >= etMs('2026-09-30', '09:45'),
        'no entry may precede OR completion');
    }
  });

  it('metrics math matches a hand-computed 2-trade scenario', () => {
    const res = runMetrics();
    const s = res.summary;
    // Trade 1: +100 x ($10.455 - $10.25) = +$20.50 (+2R).
    // Trade 2: +100 x ($10.2465 - $10.35) = -$10.35 (-1R).
    assert.strictEqual(s.startDate, '2026-09-30');
    assert.strictEqual(s.endDate, '2026-09-30');
    assert.strictEqual(s.initialEquity, 100000);
    assert.strictEqual(s.finalEquity, 100010.15);
    assert.strictEqual(s.totalPnl, 10.15);
    assert.strictEqual(s.trades, 2);
    assert.strictEqual(s.wins, 1);
    assert.strictEqual(s.losses, 1);
    assert.strictEqual(s.winRate, 0.5);
    assert.strictEqual(s.avgR, 0.5);
    assert.strictEqual(s.avgWinR, 2);
    assert.strictEqual(s.avgLossR, -1);
    assert.strictEqual(s.profitFactor, 1.9807); // 20.50 / 10.35
    assert.strictEqual(s.maxDrawdown, 10.35);
    assert.strictEqual(s.maxDrawdownPct, 0.0103); // 10.35 / 100020.50 * 100

    // Equity curve: start + one point per closed trade + flat final point.
    assert.ok(res.equityCurve.length >= 3);
    assert.strictEqual(res.equityCurve[0].equity, 100000);
    assert.strictEqual(
      res.equityCurve[res.equityCurve.length - 1].equity, 100010.15);
  });

  it('breakdown rows use the exact {key, trades, winRate, avgR, totalPnl} shape', () => {
    const res = runMetrics();
    const keys = ['byDirection', 'byOrDuration', 'byScoreBucket',
      'byRvolBucket', 'byRegime', 'byTimeOfDay'];
    for (const k of keys) {
      assert.ok(Array.isArray(res[k]), `${k} must be an array`);
      assert.ok(res[k].length > 0, `${k} must not be empty`);
      for (const row of res[k]) {
        assert.deepStrictEqual(Object.keys(row).sort(),
          ['avgR', 'key', 'totalPnl', 'trades', 'winRate']);
      }
      const total = res[k].reduce((a, r) => a + r.trades, 0);
      assert.strictEqual(total, 2, `${k} trade counts must sum to 2`);
    }
    const find = (arr, key) => arr.find(r => r.key === key);
    assert.strictEqual(find(res.byDirection, 'long').trades, 2);
    assert.strictEqual(find(res.byOrDuration, '15-min').trades, 2);
    assert.strictEqual(find(res.byRegime, 'bullish').trades, 2);
    assert.strictEqual(find(res.byTimeOfDay, '9:45-10:30').trades, 2);
    assert.strictEqual(find(res.byRvolBucket, '1.5-2').trades, 2);
    const sb = res.byScoreBucket[0];
    assert.ok(['75-79', '80-84', '85-89', '90-100'].includes(sb.key));
    assert.strictEqual(find(res.byDirection, 'long').totalPnl, 10.15);
  });

  it('is deterministic: identical inputs produce identical outputs', () => {
    const a = runMetrics();
    const b = runMetrics();
    assert.deepStrictEqual(a, b);
  });

  it('daily locks: maxTradesPerDay stops further entries that day', () => {
    const res = runMetrics({ maxTradesPerDay: 1 });
    assert.strictEqual(res.trades.length, 1);
    assert.strictEqual(res.trades[0].entryTime, etMs('2026-09-30', '09:45'));
    assert.strictEqual(res.trades[0].pnl, 20.5);
    assert.strictEqual(res.summary.trades, 1);
  });

  it('rejects an invalid orMinutes', () => {
    assert.throws(
      () => runBacktest({ barsBySymbol: {}, orMinutes: 7 }),
      /orMinutes must be 5, 15, or 30/
    );
  });

  it('handles empty input without throwing', () => {
    const res = runBacktest({ barsBySymbol: {} });
    assert.strictEqual(res.summary.trades, 0);
    assert.strictEqual(res.summary.totalPnl, 0);
    assert.strictEqual(res.summary.finalEquity, 100000);
    assert.deepStrictEqual(res.trades, []);
    assert.deepStrictEqual(res.equityCurve, []);
  });
});
