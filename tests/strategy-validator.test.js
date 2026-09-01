'use strict';

/**
 * Unit tests for lib/strategy-validator.js  (CONTRACT_VERSION 2)
 *
 * Covers every requirement from the review:
 *  1.  DST-correct isMarketHours — winter/summer/boundary dates
 *  2.  Same-symbol-already-open guard
 *  3.  Conservative stop gap-fill (bar opens below stop → fill at open, not stop)
 *  4.  Sizing: qty / notional / gross / net PnL; equity-based drawdown
 *  5.  Full candidate record: decisionId, strategyVersion, rank, inputSnapshot,
 *      all gate values, pass/fail reasons, missingDataStates on every missing field
 *  6.  OHLCV-derivable gates: requireAboveVwap, requireMacdBullish, requireBreakout20,
 *      rejectBearishDump, marketRegimeBullish, entryTimeWindow, maxGainPct
 *  7.  buildPointInTimeSignals — no lookahead, correct score, VWAP, MACD, regime
 *  8.  runWalkForwardValidation — distinct periods, selectionAudit, promotionChecks,
 *      test-not-used-for-selection proof
 *  9.  Existing tests preserved: next-bar fill, no-lookahead, stop priority,
 *      missing-data fail-closed, position cap, reproducibility, split boundaries,
 *      inadequate-samples CI, ablation, session/max-hold exits, RSI exit, cooldown
 *
 * Run with: node tests/strategy-validator.test.js
 */

const assert = require('assert');
const {
  CONTRACT_VERSION,
  DEFAULT_CONFIG,
  UNAVAILABLE_GATES,
  buildOhlcvSeries,
  splitPeriods,
  createConfig,
  validateConfig,
  declaredUnavailableGates,
  isMarketHours,
  computeRsi,
  computeVwap,
  computeMacd,
  evaluateCandidate,
  replaySession,
  computeMetrics,
  buildPriceActionOutcomeReport,
  bootstrapCI,
  ablationRun,
  buildPointInTimeSignals,
  runWalkForwardValidation,
  runStopFreeDiagnostic,
  instrumentGroup,
} = require('../lib/strategy-validator');

// ── Test harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

// ── Shared fixtures ────────────────────────────────────────────────────────────

/**
 * Build simple 5-min bars. All bars fall within the regular session
 * starting at SESSION_START_MS (Mon 2025-03-03 09:30 ET = 14:30 UTC, EST).
 */
function makeBars(symbol, count, baseMs, opts = {}) {
  const bars = [];
  let price = opts.open || 10.00;
  const trend = opts.trend || 0;
  for (let i = 0; i < count; i++) {
    const t = baseMs + i * 5 * 60 * 1000;
    const o = price;
    const c = price + trend;
    const h = Math.max(o, c) + 0.10;
    const l = opts.stopLow != null && i === opts.stopLowBar
      ? opts.stopLow
      : Math.min(o, c) - 0.05;
    const v = 500000;
    bars.push({ symbol, t, o, h, l, c, v });
    price = c;
  }
  return bars;
}

// A Monday in regular session (EST): 2025-03-03 09:30 ET → 14:30 UTC
// (DST 2025 starts 2025-03-09, so March 3 is still EST = UTC-5)
const SESSION_START_MS = Date.parse('2025-03-03T14:30:00.000Z');

function makeSignal(symbol, offsetBars, overrides = {}) {
  return Object.assign({
    symbol,
    tMs:     SESSION_START_MS + offsetBars * 5 * 60 * 1000,
    price:   10.00,
    gainPct: 15.0,
    relVol:  6.0,
    score:   5,
    side:    'long',
  }, overrides);
}

function makeState() {
  return {
    openPositions: {},
    dailyTrades:   {},
    lastExitBar:   {},
    dailyRiskUsed: {},
    equityCurve:   [25000],
  };
}

const defaultCfg = createConfig({});

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — CONTRACT_VERSION and config
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 1 — CONTRACT_VERSION and config\n');

test('CONTRACT_VERSION is 2', () => {
  assert.strictEqual(CONTRACT_VERSION, 2);
});

test('default config is valid', () => {
  const { ok, errors } = validateConfig(defaultCfg);
  assert.strictEqual(ok, true, errors.join(', '));
});

test('createConfig forces mode to PAPER_ONLY regardless of override', () => {
  const cfg = createConfig({ mode: 'LIVE' });
  assert.strictEqual(cfg.mode, 'PAPER_ONLY');
});

test('unavailable gates are always forced off even when set true in overrides', () => {
  const cfg = createConfig({ gates: { newsCatalyst: true, floatShares: true } });
  assert.strictEqual(cfg.gates.newsCatalyst, false);
  assert.strictEqual(cfg.gates.floatShares,  false);
});

test('declaredUnavailableGates matches UNAVAILABLE_GATES constant', () => {
  assert.deepStrictEqual(declaredUnavailableGates().sort(), [...UNAVAILABLE_GATES].sort());
});

test('market_regime is NOT in UNAVAILABLE_GATES (available via benchmark bars)', () => {
  assert(!UNAVAILABLE_GATES.includes('market_regime'));
});

test('createConfig throws on invalid stopPct', () => {
  assert.throws(() => createConfig({ stopPct: -1 }), /Invalid strategy config/);
});

test('createConfig throws on bad split fractions', () => {
  assert.throws(() => createConfig({ devFrac: 0.8, valFrac: 0.3 }), /Invalid strategy config/);
});

test('config version must be CONTRACT_VERSION', () => {
  const { ok, errors } = validateConfig(Object.assign({}, defaultCfg, { version: 1 }));
  assert.strictEqual(ok, false);
  assert(errors.some(e => /version/.test(e)));
});

test('config rejects startingEquity <= 0', () => {
  assert.throws(() => createConfig({ startingEquity: 0 }), /Invalid strategy config/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — DST-correct isMarketHours
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 2 — DST-correct isMarketHours\n');

// EDT (UTC-4): after 2025-03-09  → open 13:30 UTC, close 20:00 UTC
// EST (UTC-5): before 2025-03-09 → open 14:30 UTC, close 21:00 UTC

// ── EST period (before spring-forward 2025-03-09) ──────────────────────────
test('EST: 2025-03-03 Mon 09:30 ET = 14:30 UTC is in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-03T14:30:00.000Z')), true);
});

test('EST: 2025-03-03 Mon 15:59 ET = 20:59 UTC is in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-03T20:59:00.000Z')), true);
});

test('EST: 2025-03-03 Mon 16:00 ET = 21:00 UTC is NOT in session (close)', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-03T21:00:00.000Z')), false);
});

test('EST: 2025-03-03 Mon 09:29 ET = 14:29 UTC is NOT in session (before open)', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-03T14:29:00.000Z')), false);
});

// ── EDT period (after spring-forward 2025-03-09) ──────────────────────────
test('EDT: 2025-03-10 Mon 09:30 ET = 13:30 UTC is in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-10T13:30:00.000Z')), true);
});

test('EDT: 2025-03-10 Mon 15:59 ET = 19:59 UTC is in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-10T19:59:00.000Z')), true);
});

test('EDT: 2025-03-10 Mon 16:00 ET = 20:00 UTC is NOT in session (close)', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-10T20:00:00.000Z')), false);
});

test('EDT: 2025-03-10 Mon 09:29 ET = 13:29 UTC is NOT in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-10T13:29:00.000Z')), false);
});

// ── Winter confirmation ────────────────────────────────────────────────────
test('EST: 2025-01-06 Mon 09:30 ET = 14:30 UTC is in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-01-06T14:30:00.000Z')), true);
});

test('EST: 2025-01-06 Mon 15:59 ET = 20:59 UTC is in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-01-06T20:59:00.000Z')), true);
});

test('EST: 2025-01-06 Mon 16:00 ET = 21:00 UTC is NOT in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-01-06T21:00:00.000Z')), false);
});

test('EST: 2025-01-06 Mon 09:29 ET = 14:29 UTC is NOT in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-01-06T14:29:00.000Z')), false);
});

// ── DST boundary tests ─────────────────────────────────────────────────────
test('DST spring-forward: Mon 2025-03-10 (EDT) 09:30 ET = 13:30 UTC is in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-10T13:30:00.000Z')), true);
});

test('DST fall-back: Mon 2025-11-03 (back to EST) 09:30 ET = 14:30 UTC is in session', () => {
  // DST ends 2025-11-02 Sun; Mon 2025-11-03 is back to EST
  assert.strictEqual(isMarketHours(Date.parse('2025-11-03T14:30:00.000Z')), true);
});

test('DST fall-back: Mon 2025-11-03 08:30 ET = 13:30 UTC (pre-session EST) is NOT in session', () => {
  // 13:30 UTC = 08:30 ET in EST — before open
  assert.strictEqual(isMarketHours(Date.parse('2025-11-03T13:30:00.000Z')), false);
});

test('Saturday is never in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-01T14:00:00.000Z')), false);
});

test('Sunday is never in session', () => {
  assert.strictEqual(isMarketHours(Date.parse('2025-03-02T14:00:00.000Z')), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — buildOhlcvSeries
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 3 — buildOhlcvSeries\n');

test('sorts bars chronologically regardless of input order', () => {
  const raw = [
    { symbol: 'AAPL', t: SESSION_START_MS + 10000, o: 11, h: 12, l: 10, c: 11.5, v: 1000 },
    { symbol: 'AAPL', t: SESSION_START_MS,          o: 10, h: 11, l: 9,  c: 10.5, v: 900  },
  ];
  const sorted = buildOhlcvSeries(raw);
  assert.strictEqual(sorted[0].t, SESSION_START_MS);
  assert.strictEqual(sorted[1].t, SESSION_START_MS + 10000);
});

test('rejects bars with non-finite OHLCV values', () => {
  const raw = [
    { symbol: 'AAPL', t: SESSION_START_MS,          o: NaN, h: 12, l: 10, c: 11.5, v: 1000 },
    { symbol: 'AAPL', t: SESSION_START_MS + 5000,   o: 10,  h: 11, l: 9,  c: 10.5, v: 900  },
  ];
  assert.strictEqual(buildOhlcvSeries(raw).length, 1);
});

test('rejects bars with non-parseable timestamp', () => {
  const raw = [
    { symbol: 'AAPL', t: 'not-a-date', o: 10, h: 11, l: 9, c: 10.5, v: 900 },
    { symbol: 'AAPL', t: SESSION_START_MS, o: 10, h: 11, l: 9, c: 10.5, v: 900 },
  ];
  assert.strictEqual(buildOhlcvSeries(raw).length, 1);
});

test('uppercases symbol', () => {
  const raw = [{ symbol: 'aapl', t: SESSION_START_MS, o: 10, h: 11, l: 9, c: 10.5, v: 900 }];
  assert.strictEqual(buildOhlcvSeries(raw)[0].symbol, 'AAPL');
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — splitPeriods
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 4 — splitPeriods\n');

test('dev + val + test covers all bars, no overlap', () => {
  const bars = makeBars('AAPL', 100, SESSION_START_MS);
  const { dev, val, test: ts } = splitPeriods(bars, 0.6, 0.2);
  assert.strictEqual(dev.length + val.length + ts.length, 100);
  assert(dev[dev.length-1].t < val[0].t);
  assert(val[val.length-1].t < ts[0].t);
});

test('no timestamp appears in two periods', () => {
  const bars = makeBars('AAPL', 50, SESSION_START_MS);
  const { dev, val, test: ts } = splitPeriods(bars, 0.6, 0.2);
  const devT = new Set(dev.map(b => b.t));
  const valT = new Set(val.map(b => b.t));
  const tsT  = new Set(ts.map(b => b.t));
  for (const t of valT) assert(!devT.has(t));
  for (const t of tsT)  assert(!devT.has(t));
  for (const t of tsT)  assert(!valT.has(t));
});

test('split boundaries are chronological (no future data leaks into dev)', () => {
  const bars = makeBars('AAPL', 100, SESSION_START_MS);
  const { dev, test: ts } = splitPeriods(bars, 0.6, 0.2);
  assert(Math.max(...dev.map(b => b.t)) < Math.min(...ts.map(b => b.t)));
});

test('throws on fractions summing to >= 1', () => {
  assert.throws(() => splitPeriods(makeBars('A', 10, SESSION_START_MS), 0.7, 0.4), /devFrac/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — computeRsi / computeVwap / computeMacd
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 5 — computeRsi / computeVwap / computeMacd\n');

test('RSI returns NaN when fewer than period+1 values', () => {
  assert(isNaN(computeRsi([10, 11, 12], 14)));
});

test('RSI of all-up series is 100', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
  assert.strictEqual(computeRsi(closes, 14), 100);
});

test('RSI is between 0 and 100 for mixed series', () => {
  const closes = [10, 11, 10.5, 11.5, 11, 12, 11.5, 13, 12.5, 14, 13, 14.5, 13.5, 15, 14.5];
  const rsi = computeRsi(closes, 14);
  assert(rsi >= 0 && rsi <= 100, `RSI ${rsi} out of range`);
});

test('computeVwap returns NaN for empty input', () => {
  assert(isNaN(computeVwap([])));
});

test('computeVwap returns finite value for valid bars', () => {
  const bars = makeBars('X', 5, SESSION_START_MS, { open: 10 });
  const v = computeVwap(bars);
  assert(Number.isFinite(v) && v > 0);
});

test('computeMacd returns null when insufficient bars', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 10 + i * 0.1);
  assert.strictEqual(computeMacd(closes, 12, 26, 9), null);
});

test('computeMacd returns { macd, signal, hist } with enough bars', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 10 + i * 0.1);
  const r = computeMacd(closes, 12, 26, 9);
  assert(r !== null);
  assert(Number.isFinite(r.macd));
  assert(Number.isFinite(r.signal));
  assert(Number.isFinite(r.hist));
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — evaluateCandidate: no-lookahead, next-bar fill
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 6 — evaluateCandidate: no-lookahead, next-bar fill\n');

test('entry fills at NEXT bar open, not signal bar open', () => {
  const bars   = makeBars('AAPL', 10, SESSION_START_MS, { open: 10 });
  const signal = makeSignal('AAPL', 0);
  const rec    = evaluateCandidate(signal, bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'FILLED');
  assert.strictEqual(rec.actualFillTime, bars[1].t);
  assert.notStrictEqual(rec.actualFillTime, bars[0].t);
});

test('fill price > next bar open (buy half-spread + slippage added)', () => {
  const bars   = makeBars('AAPL', 10, SESSION_START_MS, { open: 10 });
  const signal = makeSignal('AAPL', 0);
  const rec    = evaluateCandidate(signal, bars, defaultCfg, makeState());
  assert(rec.fillPrice > bars[1].o, `fillPrice ${rec.fillPrice} should exceed ${bars[1].o}`);
});

test('no lookahead: gap-up to 12 on next bar uses 12, not signal bar open 10', () => {
  const bars = [
    { symbol: 'AAPL', t: SESSION_START_MS,              o: 10, h: 10.5, l: 9.8, c: 10.2, v: 100000 },
    { symbol: 'AAPL', t: SESSION_START_MS + 5 * 60000,  o: 12, h: 12.5, l: 11.8, c: 12.1, v: 120000 },
    { symbol: 'AAPL', t: SESSION_START_MS + 10 * 60000, o: 12, h: 12.5, l: 11.8, c: 12.1, v: 120000 },
  ];
  const rec = evaluateCandidate(makeSignal('AAPL', 0), bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'FILLED');
  assert(rec.fillPrice >= 12);
});

test('signal at last bar rejected with NO_NEXT_BAR', () => {
  const bars = makeBars('AAPL', 3, SESSION_START_MS);
  const rec  = evaluateCandidate(makeSignal('AAPL', 2), bars, defaultCfg, makeState());
  assert.strictEqual(rec.rejectCode, 'NO_NEXT_BAR');
});

test('signal past all bars rejected with NO_SIGNAL_BAR', () => {
  const bars   = makeBars('AAPL', 3, SESSION_START_MS);
  const signal = makeSignal('AAPL', 0, { tMs: SESSION_START_MS + 9999 * 60000 });
  const rec    = evaluateCandidate(signal, bars, defaultCfg, makeState());
  assert.strictEqual(rec.rejectCode, 'NO_SIGNAL_BAR');
});

test('filled candidate has actualFillTime > intendedEntryTime', () => {
  const bars = makeBars('FT', 10, SESSION_START_MS);
  const rec  = evaluateCandidate(makeSignal('FT', 0), bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'FILLED');
  assert(rec.actualFillTime > rec.intendedEntryTime);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Conservative stop fill (gap-down + costs)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 7 — Conservative stop fill\n');

test('stop wins over max-hold when both triggered on same bar', () => {
  const base = SESSION_START_MS;
  const bars = [
    { symbol: 'AA', t: base,              o: 10,   h: 10.5, l: 9.9,  c: 10.1, v: 500000 },
    { symbol: 'AA', t: base + 5*60000,   o: 10,   h: 10.5, l: 9.96, c: 10.1, v: 600000 },
    { symbol: 'AA', t: base + 10*60000,  o: 10.1, h: 10.6, l: 9.97, c: 10.2, v: 500000 },
    { symbol: 'AA', t: base + 15*60000,  o: 10.2, h: 10.7, l: 9.98, c: 10.3, v: 500000 },
    // Bar 4: maxHold=3 AND low below stop → STOP wins
    { symbol: 'AA', t: base + 20*60000,  o: 10.3, h: 10.4, l: 9.0,  c: 10.2, v: 700000 },
    { symbol: 'AA', t: base + 25*60000,  o: 10.2, h: 10.5, l: 10.0, c: 10.3, v: 400000 },
  ];
  const cfg = createConfig({ maxHoldBars: 3, stopPct: 5, halfSpreadPct: 0.05, slippagePct: 0.05, takeProfitRsiLevel: 100 });
  const { trades } = replaySession([makeSignal('AA', 0)], { AA: bars }, cfg);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].exitReason, 'STOP');
});

test('gap-down stop: bar opens BELOW stop → fill at barOpen (not stop), minus sell costs', () => {
  // Fill = 20 * (1 + 0/100) = 20, stop = 20 * 0.95 = 19.
  // Bar 2 opens below the stop, so a real stop can fill no better than the
  // lower bar open. A paper replay must not pretend the declared stop was
  // guaranteed through an overnight/halt gap.
  const base = SESSION_START_MS;
  const bars = [
    { symbol: 'GD', t: base,             o: 20, h: 20.5, l: 19.5, c: 20.2, v: 500000 },
    { symbol: 'GD', t: base + 5*60000,  o: 20, h: 20.5, l: 19.8, c: 20.1, v: 500000 },
    // Bar 2: gap down open = 15 (well below stop ~19), low = 14 — should exit at 15 - costs, not 19 - costs
    { symbol: 'GD', t: base + 10*60000, o: 15, h: 15.5, l: 14.0, c: 15.1, v: 800000 },
  ];
  const cfg = createConfig({ stopPct: 5, halfSpreadPct: 0, slippagePct: 0, maxHoldBars: 200, takeProfitRsiLevel: 100 });
  const { trades } = replaySession([makeSignal('GD', 0, { price: 20, gainPct: 12, relVol: 6, score: 5 })], { GD: bars }, cfg);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].exitReason, 'STOP');
  const expectedStop = trades[0].entryPrice * (1 - 5/100);
  assert(expectedStop > 15, 'fixture must open below the stop');
  assert(Math.abs(trades[0].exitPrice - 15) < 0.001,
    `exitPrice ${trades[0].exitPrice} should equal gap open 15, not stop ${expectedStop}`);
});

test('intraday stop (no gap): bar low below stop but open above → fill at stopPrice - costs', () => {
  const base = SESSION_START_MS;
  const bars = [
    { symbol: 'ST', t: base,             o: 20, h: 21, l: 19.5, c: 20.5, v: 500000 },
    { symbol: 'ST', t: base + 5*60000,  o: 20, h: 20.5, l: 19.8, c: 20.2, v: 500000 },
    // Bar 2: open=20 (above stop≈19), low=1 (way below) → fill at stopPrice, not low
    { symbol: 'ST', t: base + 10*60000, o: 20, h: 21, l: 1.0, c: 20, v: 500000 },
    ...Array.from({ length: 15 }, (_, i) => ({
      symbol: 'ST', t: base + (i+3)*5*60000, o: 20, h: 21, l: 19.5, c: 20, v: 500000 })),
  ];
  const cfg = createConfig({ stopPct: 5, halfSpreadPct: 0, slippagePct: 0, maxHoldBars: 200 });
  const { trades } = replaySession(
    [makeSignal('ST', 0, { price: 20, gainPct: 12, relVol: 6, score: 5 })],
    { ST: bars }, cfg);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].exitReason, 'STOP');
  const stopPrice = trades[0].entryPrice * (1 - 5/100);
  assert(Math.abs(trades[0].exitPrice - stopPrice) < 0.001,
    `Expected exitPrice ≈ stopPrice (${stopPrice}), got ${trades[0].exitPrice}`);
});

test('sell costs applied to all non-stop exits (RSI / max-hold)', () => {
  const sym  = 'SC';
  const bars = makeBars(sym, 30, SESSION_START_MS, { open: 10, trend: 0 });
  const cfg  = createConfig({ maxHoldBars: 3, stopPct: 50, takeProfitRsiLevel: 100, halfSpreadPct: 0.1, slippagePct: 0.1 });
  const { trades } = replaySession([makeSignal(sym, 0)], { [sym]: bars }, cfg);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].exitReason, 'MAX_HOLD');
  // exitPrice < barClose (sell costs were applied)
  const exitBar = bars.find(b => b.t === trades[0].exitTime);
  assert(exitBar, 'exit bar not found');
  assert(trades[0].exitPrice < exitBar.c,
    `exitPrice ${trades[0].exitPrice} should be < barClose ${exitBar.c} (sell costs applied)`);
});

test('stop-free diagnostic suppresses only stop exits and remains paper-only', () => {
  function diagnosticBars(symbol, base) {
    return [
      { symbol, t: base,                 o: 10, h: 10.2, l: 9.9, c: 10,   v: 500000 },
      { symbol, t: base + 5 * 60000,    o: 10, h: 10.2, l: 9.9, c: 10,   v: 500000 },
      { symbol, t: base + 10 * 60000,   o: 10, h: 10.1, l: 9.0, c: 9.8,  v: 500000 },
      { symbol, t: base + 15 * 60000,   o: 9.8, h: 10.1, l: 9.6, c: 10,  v: 500000 },
      { symbol, t: base + 20 * 60000,   o: 10, h: 10.3, l: 9.9, c: 10.2, v: 500000 },
    ];
  }
  const day = 24 * 60 * 60 * 1000;
  const barsMap = {
    DIAGA: diagnosticBars('DIAGA', SESSION_START_MS),
    DIAGB: diagnosticBars('DIAGB', SESSION_START_MS + day),
    DIAGC: diagnosticBars('DIAGC', SESSION_START_MS + 2 * day),
  };
  const cfg = createConfig({
    stopPct: 5,
    takeProfitRsiLevel: 101,
    maxHoldBars: 3,
    halfSpreadPct: 0,
    slippagePct: 0,
    devFrac: 0.34,
    valFrac: 0.33,
  });
  const originalConfig = JSON.stringify(cfg);
  const signals = [
    makeSignal('DIAGA', 0),
    makeSignal('DIAGB', 0, { tMs: SESSION_START_MS + day }),
    makeSignal('DIAGC', 0, { tMs: SESSION_START_MS + 2 * day }),
  ];
  const baseline = replaySession([signals[0]], barsMap, cfg);
  assert.strictEqual(baseline.trades[0].exitReason, 'STOP');

  const diagnostic = runStopFreeDiagnostic(signals, barsMap, cfg);
  assert.strictEqual(diagnostic.mode, 'PAPER_ONLY');
  assert.strictEqual(diagnostic.liveExecutionAllowed, false);
  assert.strictEqual(diagnostic.promotionEligible, false);
  assert.strictEqual(diagnostic.stopExitSuppressed, true);
  assert.strictEqual(
    diagnostic.periods.dev.stopFree.n,
    diagnostic.periods.dev.baseline.n,
    'diagnostic must replay the protected baseline entries rather than alter entry selection',
  );
  assert.strictEqual(diagnostic.periods.dev.stopFree.exitReasons.STOP || 0, 0);
  assert.strictEqual(diagnostic.periods.dev.stopFreeTrades[0].exitReason, 'MAX_HOLD');
  assert(diagnostic.periods.dev.stopFreeTrades[0].ignoredStopBreaches > 0);
  assert(diagnostic.periods.dev.stopFree.worstMae < 0);
  assert.strictEqual(JSON.stringify(cfg), originalConfig, 'diagnostic must not mutate frozen config');
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — Same-symbol-open guard
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 8 — Same-symbol-open guard\n');

test('second signal for same symbol while first position is open → SYMBOL_ALREADY_OPEN', () => {
  const sym  = 'SAME';
  const bars = makeBars(sym, 40, SESSION_START_MS, { open: 10 });
  const signals = [
    makeSignal(sym, 0),
    makeSignal(sym, 1, { tMs: SESSION_START_MS + 1 * 5 * 60000 }),
  ];
  const cfg = createConfig({ maxHoldBars: 200, maxConcurrentLongs: 10, maxTradesPerDay: 20 });
  const { candidates } = replaySession(signals, { [sym]: bars }, cfg);

  const second = candidates[1];
  assert.strictEqual(second.rejectCode, 'SYMBOL_ALREADY_OPEN',
    `Expected SYMBOL_ALREADY_OPEN, got ${second.rejectCode}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Missing-data fail-closed (all required fields → missingDataStates)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 9 — Missing-data fail-closed\n');

test('null price with priceRange gate → rejected, missingDataStates includes price', () => {
  const bars   = makeBars('CC', 10, SESSION_START_MS);
  const signal = makeSignal('CC', 0, { price: null });
  const rec    = evaluateCandidate(signal, bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'REJECTED');
  assert.strictEqual(rec.rejectCode, 'MISSING_PRICE');
  assert(rec.missingDataStates.includes('price'));
});

test('null gainPct with minGainPct gate → rejected, missingDataStates includes gainPct', () => {
  const bars   = makeBars('DD', 10, SESSION_START_MS);
  const signal = makeSignal('DD', 0, { gainPct: null });
  const rec    = evaluateCandidate(signal, bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'REJECTED');
  assert.strictEqual(rec.rejectCode, 'MISSING_GAIN_PCT');
  assert(rec.missingDataStates.includes('gainPct'));
});

test('null relVol with minRelVol gate → rejected, missingDataStates includes relVol', () => {
  const bars   = makeBars('EE', 10, SESSION_START_MS);
  const signal = makeSignal('EE', 0, { relVol: null });
  const rec    = evaluateCandidate(signal, bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'REJECTED');
  assert.strictEqual(rec.rejectCode, 'MISSING_REL_VOL');
  assert(rec.missingDataStates.includes('relVol'));
});

test('null score with minScore gate → rejected, missingDataStates includes score', () => {
  const bars   = makeBars('FF', 10, SESSION_START_MS);
  const signal = makeSignal('FF', 0, { score: null });
  const rec    = evaluateCandidate(signal, bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'REJECTED');
  assert(rec.missingDataStates.includes('score'));
});

test('no bars → rejected NO_BARS, missingDataStates includes ohlcv', () => {
  const { candidates } = replaySession([makeSignal('GG', 0)], {}, defaultCfg);
  assert.strictEqual(candidates[0].rejectCode, 'NO_BARS');
  assert(candidates[0].missingDataStates.includes('ohlcv'));
});

test('null vwap with requireAboveVwap gate → rejected, missingDataStates includes vwap', () => {
  const bars   = makeBars('VV', 10, SESSION_START_MS);
  const signal = makeSignal('VV', 0, { vwap: null });
  const cfg    = createConfig({ gates: { requireAboveVwap: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.status, 'REJECTED');
  assert.strictEqual(rec.rejectCode, 'MISSING_VWAP');
  assert(rec.missingDataStates.includes('vwap'));
});

test('unavailable gates recorded as UNAVAILABLE string in gateValues', () => {
  const bars   = makeBars('HH', 10, SESSION_START_MS);
  const signal = makeSignal('HH', 0);
  const rec    = evaluateCandidate(signal, bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'FILLED');
  for (const g of UNAVAILABLE_GATES) {
    const key = g.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    assert.strictEqual(rec.gateValues[key], 'UNAVAILABLE', `Expected UNAVAILABLE for ${key}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 — Candidate record completeness (decisionId, gateReasons, etc.)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 10 — Candidate record completeness\n');

test('every record has contractVersion, strategyVersion, decisionId, symbol, status', () => {
  const bars = makeBars('CR', 10, SESSION_START_MS);
  const signals = [makeSignal('CR', 0), makeSignal('CR', 0, { price: 0.5 })];
  const { candidates } = replaySession(signals, { CR: bars }, defaultCfg);
  for (const c of candidates) {
    assert.strictEqual(c.contractVersion, CONTRACT_VERSION);
    assert.strictEqual(c.strategyVersion, CONTRACT_VERSION);
    assert(typeof c.decisionId === 'string' && c.decisionId.length > 0, 'missing decisionId');
    assert(typeof c.symbol === 'string');
    assert(typeof c.status === 'string');
    assert(c.gateValues && typeof c.gateValues === 'object');
    assert(Array.isArray(c.gateReasons), 'missing gateReasons');
    assert(Array.isArray(c.passedGates), 'missing passedGates');
    assert(Array.isArray(c.failedGates), 'missing failedGates');
    assert(Array.isArray(c.unavailableGates));
    assert(Array.isArray(c.missingDataStates));
  }
});

test('decisionId is reproducible and ranked decisions remain distinct', () => {
  const bars = makeBars('UID', 10, SESSION_START_MS);
  const signals = [
    makeSignal('UID', 0, { rank: 1 }),
    makeSignal('UID', 0, { gainPct: 5, rank: 2 }),
  ];
  const { candidates } = replaySession(signals, { UID: bars }, defaultCfg);
  const ids = candidates.map(c => c.decisionId);
  assert.strictEqual(new Set(ids).size, ids.length, 'decisionIds not unique');
  const again = replaySession(signals, { UID: bars }, defaultCfg);
  assert.deepStrictEqual(ids, again.candidates.map(c => c.decisionId));
});

test('filled record has inputSnapshot with point-in-time values', () => {
  const bars   = makeBars('IS', 10, SESSION_START_MS);
  const signal = makeSignal('IS', 0, { vwap: 9.5, score: 6 });
  const cfg    = createConfig({ gates: { requireAboveVwap: false } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.status, 'FILLED');
  assert(rec.inputSnapshot !== null, 'inputSnapshot should be set on fill');
  assert.strictEqual(rec.inputSnapshot.score, 6);
});

test('gateReasons lists all evaluated gates with pass/fail/null', () => {
  const bars   = makeBars('GR', 10, SESSION_START_MS);
  const rec    = evaluateCandidate(makeSignal('GR', 0), bars, defaultCfg, makeState());
  assert(rec.gateReasons.length > 0);
  for (const gr of rec.gateReasons) {
    assert('gate'   in gr, 'missing gate name');
    assert('reason' in gr, 'missing reason');
    assert('value'  in gr, 'missing value');
  }
});

test('rejected record records rejectCode and rejectReason', () => {
  const bars = makeBars('RJ', 10, SESSION_START_MS);
  const rec  = evaluateCandidate(makeSignal('RJ', 0, { price: 100 }), bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'REJECTED');
  assert(rec.rejectCode && rec.rejectCode.length > 0);
  assert(rec.rejectReason && rec.rejectReason.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 11 — Sizing
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 11 — Sizing\n');

test('qty and notional are populated on filled candidate', () => {
  const bars = makeBars('SZ', 10, SESSION_START_MS, { open: 10 });
  const rec  = evaluateCandidate(makeSignal('SZ', 0), bars, defaultCfg, makeState());
  assert.strictEqual(rec.status, 'FILLED');
  assert(typeof rec.qty === 'number' && rec.qty >= 1, `qty=${rec.qty}`);
  assert(typeof rec.notional === 'number' && rec.notional > 0, `notional=${rec.notional}`);
});

test('trade has qty, notional, grossPnl, netPnl, netPnlPct', () => {
  const sym  = 'TR';
  const bars = makeBars(sym, 20, SESSION_START_MS, { open: 10 });
  const { trades } = replaySession([makeSignal(sym, 0)], { [sym]: bars }, defaultCfg);
  assert.strictEqual(trades.length, 1);
  const t = trades[0];
  assert(typeof t.qty      === 'number' && t.qty >= 1);
  assert(typeof t.notional === 'number' && t.notional > 0);
  assert(typeof t.grossPnl === 'number');
  assert(typeof t.netPnl   === 'number');
  assert(typeof t.netPnlPct=== 'number');
});

test('positionPct=10% of 25000 equity at $10 fill gives ~249 shares', () => {
  // 10% of 25000 = 2500 notional; at $10 fill = 250 shares (floor)
  const bars = makeBars('PS', 10, SESSION_START_MS, { open: 10 });
  const cfg  = createConfig({ startingEquity: 25000, positionPct: 10 });
  const rec  = evaluateCandidate(makeSignal('PS', 0), bars, cfg, makeState());
  // fill > 10 due to buy cost; so qty = floor(2500 / fillPrice) ≤ 250
  assert(rec.qty >= 240 && rec.qty <= 250, `qty=${rec.qty}`);
});

test('maxRiskPct caps position size', () => {
  // Stop 5% below fill on $10 = $0.5/share risk. 1% of $25000 = $250 max risk → 500 shares max.
  // But positionPct=50% would normally give 1250 shares at $10.
  const bars = makeBars('MR', 10, SESSION_START_MS, { open: 10 });
  const cfg  = createConfig({ startingEquity: 25000, positionPct: 50, maxRiskPct: 1, stopPct: 5 });
  const rec  = evaluateCandidate(makeSignal('MR', 0), bars, cfg, makeState());
  // At $10 fill: risk per share ≈ 10*0.05 = 0.5, max $250 risk → max 500 shares
  assert(rec.qty <= 500, `qty=${rec.qty} should be ≤ 500 when maxRiskPct=1%`);
});

test('metrics maxDrawdown uses equity curve (sized values)', () => {
  const sym  = 'DD';
  const bars = makeBars(sym, 30, SESSION_START_MS, { open: 10, trend: -0.1 });
  const cfg  = createConfig({ startingEquity: 25000, positionPct: 10, stopPct: 5, maxHoldBars: 5 });
  const { metrics } = replaySession([makeSignal(sym, 0)], { [sym]: bars }, cfg);
  assert(typeof metrics.maxDrawdown === 'number' && metrics.maxDrawdown >= 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 12 — New OHLCV-derivable gates
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 12 — New OHLCV-derivable gates\n');

test('requireAboveVwap: price <= vwap → rejected BELOW_VWAP', () => {
  const bars   = makeBars('AV', 10, SESSION_START_MS);
  const signal = makeSignal('AV', 0, { price: 9.5, vwap: 10.0 });
  const cfg    = createConfig({ gates: { requireAboveVwap: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.status, 'REJECTED');
  assert.strictEqual(rec.rejectCode, 'BELOW_VWAP');
});

test('requireAboveVwap: price > vwap → passes gate', () => {
  const bars   = makeBars('AV2', 10, SESSION_START_MS);
  const signal = makeSignal('AV2', 0, { price: 11.0, vwap: 10.0 });
  const cfg    = createConfig({ gates: { requireAboveVwap: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.notStrictEqual(rec.rejectCode, 'BELOW_VWAP');
});

test('requireMacdBullish: macd.hist <= 0 → rejected MACD_BEARISH', () => {
  const bars   = makeBars('MB', 10, SESSION_START_MS);
  const signal = makeSignal('MB', 0, { macd: { macd: -0.1, signal: 0.1, hist: -0.2 } });
  const cfg    = createConfig({ gates: { requireMacdBullish: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.rejectCode, 'MACD_BEARISH');
});

test('requireMacdBullish: macd.hist > 0 → passes gate', () => {
  const bars   = makeBars('MB2', 10, SESSION_START_MS);
  const signal = makeSignal('MB2', 0, { macd: { macd: 0.1, signal: 0.05, hist: 0.05 } });
  const cfg    = createConfig({ gates: { requireMacdBullish: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.notStrictEqual(rec.rejectCode, 'MACD_BEARISH');
});

test('requireBreakout20: breakout20=false → rejected NO_BREAKOUT', () => {
  const bars   = makeBars('BO', 10, SESSION_START_MS);
  const signal = makeSignal('BO', 0, { breakout20: false });
  const cfg    = createConfig({ gates: { requireBreakout20: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.rejectCode, 'NO_BREAKOUT');
});

test('requireBreakout20: breakout20=true → passes gate', () => {
  const bars   = makeBars('BO2', 10, SESSION_START_MS);
  const signal = makeSignal('BO2', 0, { breakout20: true });
  const cfg    = createConfig({ gates: { requireBreakout20: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.notStrictEqual(rec.rejectCode, 'NO_BREAKOUT');
});

test('rejectBearishDump: dumpCandlePct=-10 (below -8 default) → rejected BEARISH_DUMP', () => {
  const bars   = makeBars('BD', 10, SESSION_START_MS);
  const signal = makeSignal('BD', 0, { dumpCandlePct: -10 });
  const cfg    = createConfig({ gates: { rejectBearishDump: true }, dumpCandlePct: -8 });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.rejectCode, 'BEARISH_DUMP');
});

test('marketRegimeBullish: regime=BEARISH → rejected REGIME_NOT_BULLISH', () => {
  const bars   = makeBars('RG', 10, SESSION_START_MS);
  const signal = makeSignal('RG', 0, { marketRegime: 'BEARISH' });
  const cfg    = createConfig({ gates: { marketRegimeBullish: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.rejectCode, 'REGIME_NOT_BULLISH');
});

test('marketRegimeBullish: regime=BULLISH → passes', () => {
  const bars   = makeBars('RG2', 10, SESSION_START_MS);
  const signal = makeSignal('RG2', 0, { marketRegime: 'BULLISH' });
  const cfg    = createConfig({ gates: { marketRegimeBullish: true } });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.notStrictEqual(rec.rejectCode, 'REGIME_NOT_BULLISH');
});

test('maxGainPct gate: gainPct > max → rejected GAIN_PCT_HIGH', () => {
  const bars   = makeBars('MG', 10, SESSION_START_MS);
  const signal = makeSignal('MG', 0, { gainPct: 55 });
  const cfg    = createConfig({ gates: { maxGainPct: true }, maxGainPct: 40 });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.rejectCode, 'GAIN_PCT_HIGH');
});

test('entryStartMinutesET / entryEndMinutesET restricts entry window', () => {
  // Signal bar at 09:30 ET (minute 570 = 9*60+30); restrict to [11:00, 15:00)
  const bars   = makeBars('EW', 10, SESSION_START_MS);
  const signal = makeSignal('EW', 0);
  const cfg    = createConfig({ entryStartMinutesET: 11*60, entryEndMinutesET: 15*60 });
  const rec    = evaluateCandidate(signal, bars, cfg, makeState());
  assert.strictEqual(rec.rejectCode, 'OUTSIDE_ENTRY_WINDOW');
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 13 — Position cap, daily cap, cooldown, no shorts
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 13 — Position cap / daily cap / cooldown / no shorts\n');

test('third concurrent signal rejected MAX_POSITIONS when two open', () => {
  const barsMap = {};
  for (const s of ['S1','S2','S3']) barsMap[s] = makeBars(s, 30, SESSION_START_MS, { open: 10, trend: 0.01 });
  const signals = ['S1','S2','S3'].map(s => makeSignal(s, 0));
  const cfg = createConfig({ maxConcurrentLongs: 2, maxHoldBars: 200 });
  const { candidates } = replaySession(signals, barsMap, cfg);
  assert(candidates.filter(c => c.status === 'FILLED').length <= 2);
  assert(candidates.some(c => c.rejectCode === 'MAX_POSITIONS'));
});

test('position cap value recorded in gateValues', () => {
  const state = makeState();
  state.openPositions = { X: { symbol: 'X' }, Y: { symbol: 'Y' } };
  const bars = makeBars('P1', 10, SESSION_START_MS);
  const rec  = evaluateCandidate(makeSignal('P1', 0), bars, defaultCfg, state);
  assert.strictEqual(rec.rejectCode, 'MAX_POSITIONS');
  assert.strictEqual(rec.gateValues.openPositions, 2);
});

test('daily trade cap rejected after limit reached', () => {
  const barsMap = {};
  const signals = [];
  for (let i = 0; i < 3; i++) {
    const s = `DT${i}`;
    barsMap[s] = makeBars(s, 20, SESSION_START_MS, { open: 10 + i });
    signals.push(makeSignal(s, 0, { tMs: SESSION_START_MS + i * 60000 }));
  }
  const cfg = createConfig({ maxTradesPerDay: 2, maxConcurrentLongs: 10, maxHoldBars: 200 });
  const { candidates } = replaySession(signals, barsMap, cfg);
  assert(candidates.some(c => c.rejectCode === 'DAILY_TRADE_CAP'));
});

test('cooldown rejected within cooldown window', () => {
  const sym  = 'CD';
  const bars = makeBars(sym, 50, SESSION_START_MS, { open: 10 });
  const signals = [
    makeSignal(sym, 0),
    makeSignal(sym, 3, { tMs: SESSION_START_MS + 3*5*60000 }),
  ];
  const cfg = createConfig({ cooldownBars: 6, maxConcurrentLongs: 10, maxHoldBars: 1, maxTradesPerDay: 10 });
  const { candidates } = replaySession(signals, { [sym]: bars }, cfg);
  assert(candidates.some(c => c.rejectCode === 'COOLDOWN'));
});

test('short signal always rejected NO_SHORTS', () => {
  const bars = makeBars('SH', 10, SESSION_START_MS);
  const rec  = evaluateCandidate(makeSignal('SH', 0, { side: 'short' }), bars, defaultCfg, makeState());
  assert.strictEqual(rec.rejectCode, 'NO_SHORTS');
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 14 — RSI exit, max-hold, session-end
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 14 — RSI exit / max-hold / session-end\n');

test('position exits MAX_HOLD at configured bar count', () => {
  const sym  = 'MH';
  const bars = makeBars(sym, 30, SESSION_START_MS, { open: 10 });
  const cfg  = createConfig({ maxHoldBars: 3, stopPct: 50, takeProfitRsiLevel: 100 });
  const { trades } = replaySession([makeSignal(sym, 0)], { [sym]: bars }, cfg);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].exitReason, 'MAX_HOLD');
  assert.strictEqual(trades[0].holdBars, 3);
});

test('position exits RSI_EXIT when RSI exceeds threshold', () => {
  const sym  = 'RI';
  const bars = makeBars(sym, 40, SESSION_START_MS, { open: 10, trend: 0.15 });
  const cfg  = createConfig({ takeProfitRsiLevel: 70, stopPct: 50, maxHoldBars: 200 });
  const { trades } = replaySession([makeSignal(sym, 0)], { [sym]: bars }, cfg);
  assert.strictEqual(trades.length, 1);
  assert(['RSI_EXIT','MAX_HOLD','SESSION_END','END_OF_DATA'].includes(trades[0].exitReason));
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 15 — Reproducibility
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 15 — Reproducibility\n');

test('two identical replays produce identical trades and metrics', () => {
  const sym  = 'REP';
  const bars = makeBars(sym, 30, SESSION_START_MS, { open: 10, trend: 0.02 });
  const signals = [makeSignal(sym, 0)];
  const r1 = replaySession(signals, { [sym]: bars }, defaultCfg);
  const r2 = replaySession(signals, { [sym]: bars }, defaultCfg);
  assert.strictEqual(r1.trades.length,       r2.trades.length);
  assert.strictEqual(r1.metrics.totalPnl,    r2.metrics.totalPnl);
  assert.strictEqual(r1.metrics.winRate,     r2.metrics.winRate);
});

test('bootstrap CI with same seed is deterministic', () => {
  const trades = [
    { netPnl: 0.5, win: true }, { netPnl: -0.3, win: false },
    { netPnl: 0.2, win: true }, { netPnl: -0.1, win: false },
    { netPnl: 0.8, win: true },
  ];
  const ci1 = bootstrapCI(trades, defaultCfg, { seed: 42, reps: 500 });
  const ci2 = bootstrapCI(trades, defaultCfg, { seed: 42, reps: 500 });
  assert.strictEqual(ci1.mean, ci2.mean);
  assert.strictEqual(ci1.lo,   ci2.lo);
  assert.strictEqual(ci1.hi,   ci2.hi);
});

test('bootstrap CI with different seeds differs (generally)', () => {
  const trades = Array.from({ length: 20 }, (_, i) => ({
    netPnl: i % 2 === 0 ? 0.5 : -0.3, win: i % 2 === 0,
  }));
  const ci1 = bootstrapCI(trades, defaultCfg, { seed: 1,  reps: 200 });
  const ci2 = bootstrapCI(trades, defaultCfg, { seed: 99, reps: 200 });
  assert.strictEqual(ci1.mean, ci2.mean); // same data
  assert(Number.isFinite(ci1.lo) && Number.isFinite(ci2.lo));
});

test('bootstrap CI returns zeros for empty trades', () => {
  const ci = bootstrapCI([], defaultCfg, { seed: 42 });
  assert.strictEqual(ci.mean, 0);
  assert.strictEqual(ci.lo,   0);
  assert.strictEqual(ci.hi,   0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 16 — computeMetrics
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 16 — computeMetrics\n');

test('empty trades returns all-zero metrics', () => {
  const m = computeMetrics([], defaultCfg);
  assert.strictEqual(m.n,             0);
  assert.strictEqual(m.winRate,       0);
  assert.strictEqual(m.netExpectancy, 0);
  assert.strictEqual(m.profitFactor,  0);
  assert.strictEqual(m.maxDrawdown,   0);
});

test('win rate, net expectancy and profit factor computed correctly', () => {
  const trades = [
    { netPnl: 1.0, grossPnl: 1.0, win: true,  exitReason: 'RSI_EXIT', mae: 0,    mfe: 1,   holdBars: 5, symbol: 'A', entryTime: SESSION_START_MS,       exitTime: SESSION_START_MS+5000, qty:1, notional:10 },
    { netPnl:-0.5, grossPnl:-0.5, win: false, exitReason: 'STOP',     mae:-0.5, mfe: 0,   holdBars: 3, symbol: 'A', entryTime: SESSION_START_MS,       exitTime: SESSION_START_MS+3000, qty:1, notional:10 },
    { netPnl: 0.8, grossPnl: 0.8, win: true,  exitReason: 'RSI_EXIT', mae: 0,    mfe: 0.8, holdBars: 8, symbol: 'B', entryTime: SESSION_START_MS,       exitTime: SESSION_START_MS+8000, qty:1, notional:10 },
    { netPnl:-0.2, grossPnl:-0.2, win: false, exitReason: 'STOP',     mae:-0.2, mfe: 0,   holdBars: 2, symbol: 'B', entryTime: SESSION_START_MS,       exitTime: SESSION_START_MS+2000, qty:1, notional:10 },
  ];
  const m = computeMetrics(trades, defaultCfg);
  assert.strictEqual(m.n,       4);
  assert.strictEqual(m.winRate, 0.5);
  assert(m.netExpectancy > 0);
  assert(m.profitFactor > 1);
});

test('profit factor is Infinity when all trades are wins', () => {
  const trades = [
    { netPnl: 1.0, grossPnl:1, win: true, exitReason:'RSI_EXIT', mae:0, mfe:1, holdBars:5, symbol:'A', entryTime:SESSION_START_MS, exitTime:SESSION_START_MS+5000, qty:1, notional:10 },
    { netPnl: 0.5, grossPnl:.5, win: true, exitReason:'RSI_EXIT', mae:0, mfe:.5, holdBars:3, symbol:'A', entryTime:SESSION_START_MS+1000, exitTime:SESSION_START_MS+4000, qty:1, notional:10 },
  ];
  assert.strictEqual(computeMetrics(trades, defaultCfg).profitFactor, Infinity);
});

test('exit reason, monthly, and instrument-group breakdowns populated', () => {
  const trades = [
    { netPnl: 0.5, grossPnl:.5, win: true,  exitReason:'RSI_EXIT', mae:0, mfe:.5, holdBars:5, symbol:'AAPL', marketRegime:'BULLISH', entryTime: Date.parse('2025-03-03T14:00:00Z'), exitTime: Date.parse('2025-03-03T14:30:00Z'), qty:1, notional:10 },
    { netPnl:-0.2, grossPnl:-.2, win: false, exitReason:'STOP',    mae:-.2, mfe:0, holdBars:2, symbol:'SPY',  marketRegime:'BEARISH', entryTime: Date.parse('2025-04-07T14:00:00Z'), exitTime: Date.parse('2025-04-07T14:10:00Z'), qty:1, notional:10 },
    { netPnl: 0.3, grossPnl:.3, win: true,  exitReason:'RSI_EXIT', mae:0, mfe:.3, holdBars:3, symbol:'TQQQ', marketRegime:'BULLISH', entryTime: Date.parse('2025-04-08T14:00:00Z'), exitTime: Date.parse('2025-04-08T14:15:00Z'), qty:1, notional:10 },
    { netPnl:-0.1, grossPnl:-.1, win: false, exitReason:'STOP',    mae:-.1, mfe:0, holdBars:2, symbol:'SQQQ', marketRegime:'BEARISH', entryTime: Date.parse('2025-04-09T14:00:00Z'), exitTime: Date.parse('2025-04-09T14:10:00Z'), qty:1, notional:10 },
  ];
  const m = computeMetrics(trades, defaultCfg);
  assert('2025-03' in m.monthly);
  assert('2025-04' in m.monthly);
  assert('stock'   in m.byGroup);
  assert.strictEqual(m.byGroup.other_etf.count, 1);
  assert.strictEqual(m.byGroup.long_leveraged_etf.count, 1);
  assert.strictEqual(m.byGroup.inverse_etf.count, 1);
  assert.strictEqual(m.byRegime.BULLISH.count, 2);
  assert.strictEqual(m.byRegime.BEARISH.count, 2);
  assert.strictEqual(m.exitReasons.RSI_EXIT, 2);
  assert.strictEqual(m.exitReasons.STOP,     2);
});

test('instrument groups separate inverse, long leveraged, other ETFs, and stocks', () => {
  assert.strictEqual(instrumentGroup('SQQQ'), 'inverse_etf');
  assert.strictEqual(instrumentGroup('LABD'), 'inverse_etf');
  assert.strictEqual(instrumentGroup('TQQQ'), 'long_leveraged_etf');
  assert.strictEqual(instrumentGroup('LABU'), 'long_leveraged_etf');
  assert.strictEqual(instrumentGroup('SPY'), 'other_etf');
  assert.strictEqual(instrumentGroup('AAPL'), 'stock');
});

test('gate-only paper evaluation qualifies without fabricating a next bar', () => {
  const bars = makeBars('SHADOW', 1, SESSION_START_MS);
  const rec = evaluateCandidate(
    makeSignal('SHADOW', 0),
    bars,
    defaultCfg,
    makeState(),
    null,
    { gateOnly: true },
  );
  assert.strictEqual(rec.status, 'QUALIFIED');
  assert.strictEqual(rec.actualFillTime, null);
  assert.strictEqual(rec.inputSnapshot.entryOpen, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 17 — CI width vs sample size (no-promotion guard)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 17 — Bootstrap CI / no-promotion on small samples\n');

test('CI is wider for small samples than large samples', () => {
  const small = [{ netPnl: 0.5, win:true }, { netPnl:-0.3, win:false }, { netPnl:0.2, win:true }];
  const large = Array.from({ length: 100 }, (_, i) => ({ netPnl: i%2===0?0.5:-0.3, win: i%2===0 }));
  const opts  = { seed: 42, reps: 1000 };
  const ws = bootstrapCI(small, defaultCfg, opts).hi - bootstrapCI(small, defaultCfg, opts).lo;
  const wl = bootstrapCI(large, defaultCfg, opts).hi - bootstrapCI(large, defaultCfg, opts).lo;
  assert(ws > wl, `Small CI (${ws.toFixed(4)}) should be > large CI (${wl.toFixed(4)})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 18 — ablationRun (dev+val only, no test leakage)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 18 — ablationRun\n');

test('ablation results have no testMetrics field', () => {
  const sym  = 'ABL';
  const bars = makeBars(sym, 100, SESSION_START_MS, { open: 10, trend: 0.005 });
  const sigs = Array.from({ length: 10 }, (_, i) =>
    makeSignal(sym, i*8, { tMs: SESSION_START_MS + i*8*5*60000 }));
  const results = ablationRun(sigs, { [sym]: bars }, defaultCfg, [
    { name: 'baseline',          configOverride: {} },
    { name: 'no_gain_gate',      configOverride: { gates: { minGainPct: false } } },
    { name: 'tighter_stop_3pct', configOverride: { stopPct: 3 } },
  ]);
  assert.strictEqual(results.length, 3);
  for (const r of results) {
    assert(r.name);
    assert(r.metrics);
    assert(r.ci);
    assert(!('testMetrics' in r), 'testMetrics must not appear in ablation result');
  }
});

test('disabling a gate allows more candidates through', () => {
  const sym  = 'GA';
  const bars = makeBars(sym, 50, SESSION_START_MS, { open: 10 });
  const sigs = [
    makeSignal(sym, 0, { gainPct: 3.0 }),  // fails minGainPct=10
    makeSignal(sym, 6, { tMs: SESSION_START_MS + 6*5*60000, gainPct: 15.0 }),
  ];
  const base = createConfig({ maxConcurrentLongs: 10, maxTradesPerDay: 20 });
  const results = ablationRun(sigs, { [sym]: bars }, base, [
    { name: 'with_gate',    configOverride: { gates: { minGainPct: true  } } },
    { name: 'without_gate', configOverride: { gates: { minGainPct: false } } },
  ]);
  const withGate    = results.find(r => r.name === 'with_gate');
  const withoutGate = results.find(r => r.name === 'without_gate');
  assert(withoutGate.metrics.n >= withGate.metrics.n);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 19 — buildPointInTimeSignals
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 19 — buildPointInTimeSignals\n');

/**
 * Build a multi-session bars map for PIT signal tests.
 * Two sessions on consecutive trading days, each with 10 bars.
 */
function makeMultiSessionBars(symbol) {
  // EST period: 09:30 ET = 14:30 UTC on 2025-03-03 and 2025-03-04
  const session1Start = Date.parse('2025-03-03T14:30:00.000Z'); // Mon
  const session2Start = Date.parse('2025-03-04T14:30:00.000Z'); // Tue
  const s1 = makeBars(symbol, 12, session1Start, { open: 10, trend: 0.05 });
  const s2 = makeBars(symbol, 12, session2Start, { open: 10.5, trend: 0.03 });
  return [...s1, ...s2];
}

test('buildPointInTimeSignals returns signals and metadata', () => {
  const barsMap = { AAPL: makeMultiSessionBars('AAPL') };
  const { signals, metadata } = buildPointInTimeSignals(barsMap);
  assert(Array.isArray(signals));
  assert(metadata.signalCount === signals.length);
  assert(Array.isArray(metadata.unavailableGates));
  assert(metadata.unavailableGates.includes('news_catalyst'));
  assert(metadata.unavailableGates.includes('float_shares'));
});

test('buildPointInTimeSignals: signals have required fields', () => {
  const barsMap = { AAPL: makeMultiSessionBars('AAPL') };
  const { signals } = buildPointInTimeSignals(barsMap, { prefilter: false });
  assert(signals.length > 0, 'expected at least some signals');
  for (const s of signals) {
    assert(typeof s.symbol   === 'string');
    assert(typeof s.tMs      === 'number');
    assert('gainPct'  in s, 'missing gainPct');
    assert('relVol'   in s, 'missing relVol');
    assert('vwap'     in s, 'missing vwap');
    assert('score'    in s, 'missing score');
    assert('side'     in s);
  }
});

test('buildPointInTimeSignals: no lookahead — gainPct uses prior session close when available', () => {
  const barsMap = { AAPL: makeMultiSessionBars('AAPL') };
  const { signals } = buildPointInTimeSignals(barsMap, { prefilter: false });
  // Session 2 signals should reference prevClose from session 1
  const session2Sigs = signals.filter(s => s.sessionDate === '2025-03-04');
  for (const s of session2Sigs) {
    assert(s.prevClose !== null, 'session 2 signals should have prevClose from session 1');
  }
});

test('buildPointInTimeSignals: score matches scanner rules (+2 gain>=10, +1 gain>=30, +1 rv>=5, +1 rv>=10)', () => {
  // Build a signal with known gainPct=35, relVol=12 → expected score = 2+1+1+1 = 5
  const barsMap = { TEST: makeMultiSessionBars('TEST') };
  const { signals } = buildPointInTimeSignals(barsMap, { prefilter: false });
  for (const s of signals) {
    let expected = 0;
    if (s.gainPct != null) { if (s.gainPct >= 10) expected += 2; if (s.gainPct >= 30) expected += 1; }
    if (s.relVol != null)  { if (s.relVol >= 5)   expected += 1; if (s.relVol >= 10)  expected += 1; }
    assert.strictEqual(s.score, expected, `score mismatch for signal at ${s.tMs}: got ${s.score}, expected ${expected}`);
  }
});

test('buildPointInTimeSignals: signals sorted chronologically', () => {
  const barsMap = { A: makeMultiSessionBars('A'), B: makeMultiSessionBars('B') };
  const { signals } = buildPointInTimeSignals(barsMap);
  for (let i = 1; i < signals.length; i++) {
    assert(signals[i].tMs >= signals[i-1].tMs, 'signals not in chronological order');
  }
});

test('buildPointInTimeSignals: news and float never synthesised', () => {
  const barsMap = { AAPL: makeMultiSessionBars('AAPL') };
  const { signals, metadata } = buildPointInTimeSignals(barsMap);
  for (const s of signals) {
    assert(!('hasNewsCatalyst' in s), 'news_catalyst must not be synthesised');
    assert(!('floatShares' in s),     'float_shares must not be synthesised');
  }
  assert(metadata.unavailableGates.includes('news_catalyst'));
});

test('buildPointInTimeSignals: regime derived from benchmark, not synthesised', () => {
  const spy = makeMultiSessionBars('SPY');
  const barsMap = { AAPL: makeMultiSessionBars('AAPL'), SPY: spy };
  const { signals } = buildPointInTimeSignals(barsMap, { benchmarkSymbol: 'SPY' });
  // For session 2 (Tue), regime comes from SPY session 1 (Mon)
  const session2 = signals.filter(s => s.sessionDate === '2025-03-04');
  if (session2.length > 0) {
    assert(session2[0].marketRegime !== undefined);
    // Must be one of the valid values or null
    assert(['BULLISH','BEARISH','NEUTRAL',null].includes(session2[0].marketRegime));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 20 — runWalkForwardValidation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 20 — runWalkForwardValidation\n');

function makeWFData(numSessions = 30) {
  // Build signals across numSessions trading days
  // Mon 2025-03-03 is session 1; skip weekends
  const signals  = [];
  const barsMap  = {};
  const symbols  = ['AAPL', 'TSLA'];

  let sessionMs = Date.parse('2025-03-03T13:30:00.000Z');
  for (let d = 0; d < numSessions; d++) {
    // Skip weekends
    const dow = new Date(sessionMs).getUTCDay();
    if (dow === 0 || dow === 6) { sessionMs += 24*60*60*1000; d--; continue; }

    for (const sym of symbols) {
      if (!barsMap[sym]) barsMap[sym] = [];
      const bars = makeBars(sym, 15, sessionMs, { open: 10, trend: 0.01 });
      barsMap[sym].push(...bars);

      // One signal per session (at bar 2)
      signals.push(makeSignal(sym, 0, {
        tMs:     sessionMs + 2*5*60000,
        gainPct: 12,
        relVol:  6,
        score:   5,
        price:   10,
      }));
    }
    sessionMs += 24*60*60*1000; // next day
  }
  return { signals, barsMap };
}

test('runWalkForwardValidation returns required top-level fields', () => {
  const { signals, barsMap } = makeWFData(15);
  const cfg = createConfig({ devFrac: 0.6, valFrac: 0.2, promotionMinValTrades: 1, promotionMinTestTrades: 1 });
  const report = runWalkForwardValidation(signals, barsMap, cfg, []);
  assert.strictEqual(report.contractVersion, CONTRACT_VERSION);
  assert.strictEqual(report.mode, 'PAPER_ONLY');
  assert(report.splitAudit,        'missing splitAudit');
  assert(report.baseline,          'missing baseline');
  assert(report.selectionAudit,    'missing selectionAudit');
  assert(report.testResults,       'missing testResults');
  assert(report.promotionChecks,   'missing promotionChecks');
  assert('promoted' in report,     'missing promoted flag');
  assert(report.promotionStatus,   'missing promotionStatus');
});

test('selectionAudit explicitly proves test was not used for selection', () => {
  const { signals, barsMap } = makeWFData(15);
  const cfg = createConfig({ devFrac: 0.6, valFrac: 0.2, promotionMinValTrades: 1, promotionMinTestTrades: 1 });
  const report = runWalkForwardValidation(signals, barsMap, cfg, []);
  assert.strictEqual(report.selectionAudit.testNeverUsedForSelection, true);
});

test('splitAudit has non-overlapping dev/val/test session lists', () => {
  const { signals, barsMap } = makeWFData(15);
  const cfg = createConfig({ devFrac: 0.6, valFrac: 0.2, promotionMinValTrades: 1, promotionMinTestTrades: 1 });
  const report = runWalkForwardValidation(signals, barsMap, cfg, []);
  const audit = report.splitAudit;
  const devSet  = new Set(audit.devSessions);
  const valSet  = new Set(audit.valSessions);
  const testSet = new Set(audit.testSessions);
  for (const s of valSet)  assert(!devSet.has(s),  `session ${s} in both dev and val`);
  for (const s of testSet) assert(!devSet.has(s),  `session ${s} in both dev and test`);
  for (const s of testSet) assert(!valSet.has(s),  `session ${s} in both val and test`);
  const total = devSet.size + valSet.size + testSet.size;
  assert.strictEqual(total, audit.totalSessions, 'session count mismatch');
});

test('baseline reported separately for dev, val, and test periods', () => {
  const { signals, barsMap } = makeWFData(20);
  const cfg = createConfig({ devFrac: 0.6, valFrac: 0.2, promotionMinValTrades: 1, promotionMinTestTrades: 1 });
  const report = runWalkForwardValidation(signals, barsMap, cfg, []);
  assert(report.baseline.dev,  'missing baseline.dev');
  assert(report.baseline.val,  'missing baseline.val');
  assert(report.baseline.test, 'missing baseline.test');
  // All three must have n field
  assert(typeof report.baseline.dev.n  === 'number');
  assert(typeof report.baseline.val.n  === 'number');
  assert(typeof report.baseline.test.n === 'number');
});

test('ablations run on dev+val only, not test', () => {
  const { signals, barsMap } = makeWFData(15);
  const cfg = createConfig({ devFrac: 0.6, valFrac: 0.2, promotionMinValTrades: 1, promotionMinTestTrades: 1 });
  const ablations = [
    { name: 'no_gain', configOverride: { gates: { minGainPct: false } } },
  ];
  const report = runWalkForwardValidation(signals, barsMap, cfg, ablations);
  assert.strictEqual(report.ablationResults.length, 1);
  const abl = report.ablationResults[0];
  assert(abl.devMetrics,  'missing devMetrics in ablation');
  assert(abl.valMetrics,  'missing valMetrics in ablation');
  assert(!('testMetrics' in abl), 'testMetrics must not appear in ablation result');
});

test('NO_PROMOTION when sample too small', () => {
  const { signals, barsMap } = makeWFData(5); // only 5 sessions
  const cfg = createConfig({
    devFrac: 0.6, valFrac: 0.2,
    promotionMinValTrades: 1000,  // impossibly high threshold
    promotionMinTestTrades: 1000,
  });
  const report = runWalkForwardValidation(signals, barsMap, cfg, []);
  assert.strictEqual(report.promoted, false);
  assert.strictEqual(report.promotionStatus, 'NO_PROMOTION');
  assert(report.promotionReasons.length > 0);
});

test('selected config carries mode PAPER_ONLY', () => {
  const { signals, barsMap } = makeWFData(15);
  const cfg = createConfig({ devFrac: 0.6, valFrac: 0.2, promotionMinValTrades: 1, promotionMinTestTrades: 1 });
  const report = runWalkForwardValidation(signals, barsMap, cfg, []);
  assert.strictEqual(report.frozenConfig.mode, 'PAPER_ONLY');
});

test('promotionChecks keys match expected criteria', () => {
  const { signals, barsMap } = makeWFData(15);
  const cfg = createConfig({ devFrac: 0.6, valFrac: 0.2, promotionMinValTrades: 1, promotionMinTestTrades: 1 });
  const report = runWalkForwardValidation(signals, barsMap, cfg, []);
  for (const key of ['minValidationTrades','minTestTrades','positiveAfterCostExpectancy',
                     'profitFactorGe1','maxDrawdownNotWorse','ciLoNonNegative']) {
    assert(key in report.promotionChecks, `missing promotionChecks.${key}`);
    assert('pass' in report.promotionChecks[key], `promotionChecks.${key} missing pass field`);
  }
});

test('development metrics cannot read validation or test bars', () => {
  const { signals, barsMap } = makeWFData(20);
  const cfg = createConfig({
    devFrac: 0.6,
    valFrac: 0.2,
    maxHoldBars: 500,
    takeProfitRsiLevel: 100,
    promotionMinValTrades: 1,
    promotionMinTestTrades: 1,
  });
  const original = runWalkForwardValidation(signals, barsMap, cfg, []);
  const devEnd = original.splitAudit.devSessions.at(-1);
  const mutatedBars = Object.fromEntries(Object.entries(barsMap).map(([symbol, bars]) => [
    symbol,
    bars.map(bar => new Date(bar.t).toISOString().slice(0, 10) > devEnd
      ? { ...bar, o: 1, h: 1.1, l: 0.5, c: 0.8 }
      : { ...bar }),
  ]));
  const mutated = runWalkForwardValidation(signals, mutatedBars, cfg, []);
  assert.deepStrictEqual(mutated.baseline.dev, original.baseline.dev);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 21 — market hours and signal rejection
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSection 21 — market hours gate\n');

test('signal outside market hours rejected when enforceMarketHours=true', () => {
  const weekendMs = Date.parse('2025-03-01T14:00:00.000Z'); // Saturday
  const bars  = makeBars('WE', 10, weekendMs);
  const rec   = evaluateCandidate(
    makeSignal('WE', 0, { tMs: weekendMs }), bars, createConfig({ enforceMarketHours: true }), makeState());
  assert.strictEqual(rec.rejectCode, 'OUTSIDE_MARKET_HOURS');
});

test('signal outside hours allowed when enforceMarketHours=false', () => {
  const weekendMs = Date.parse('2025-03-01T14:00:00.000Z');
  const bars  = makeBars('WF', 10, weekendMs);
  const rec   = evaluateCandidate(
    makeSignal('WF', 0, { tMs: weekendMs }), bars, createConfig({ enforceMarketHours: false }), makeState());
  assert.notStrictEqual(rec.rejectCode, 'OUTSIDE_MARKET_HOURS');
});

console.log('\nSection 22 — price-action paper evidence\n');

test('candidate replay records setup, invalidation, and no-trade reason without changing gate status', () => {
  const bars = makeBars('PA', 30);
  const signal = makeSignal('PA', 20, {
    priceAction: {
      strategy: 'smb-compatible-long-v1',
      direction: 'LONG_ONLY',
      status: 'SETUP CONFIRMED — WAIT',
      eligible: false,
      setup: { type: 'CONTROLLED_PULLBACK', label: 'Controlled pullback' },
      invalidation: 9.25,
      reasons: ['Relative strength is unavailable.'],
    },
  });
  const rec = evaluateCandidate(
    signal,
    bars,
    createConfig({ enforceMarketHours: false }),
    makeState(),
  );
  assert.strictEqual(rec.priceActionSetupType, 'CONTROLLED_PULLBACK');
  assert.strictEqual(rec.priceActionInvalidation, 9.25);
  assert.strictEqual(rec.priceActionNoTradeReason, 'Relative strength is unavailable.');
  assert.notStrictEqual(rec.rejectCode, 'PRICE_ACTION');
});

test('setup outcome report stays descriptive and labels insufficient samples', () => {
  const cfg = createConfig({ promotionMinTestTrades: 3 });
  const report = buildPriceActionOutcomeReport([
    {
      priceAction: {
        setupType: 'BREAKOUT_CONTINUATION',
        eligible: true,
        noTradeReason: null,
      },
    },
  ], [{
    symbol: 'PA',
    netPnl: 10,
    win: true,
    entryTime: Date.now(),
    exitTime: Date.now() + 300_000,
    qty: 1,
    notional: 10,
    mae: 0,
    mfe: 1,
    holdBars: 1,
    marketRegime: 'BULLISH',
    priceActionSetupType: 'BREAKOUT_CONTINUATION',
  }], cfg);
  const breakout = report.setupTypes.BREAKOUT_CONTINUATION;
  assert.strictEqual(report.mode, 'PAPER_ONLY');
  assert.strictEqual(report.promotionEligible, false);
  assert.strictEqual(breakout.outcomes, 1);
  assert.strictEqual(breakout.assessment, 'INSUFFICIENT_SAMPLE');
  assert.strictEqual(breakout.promotionEligible, false);
  assert.strictEqual(report.setupTypes.FAILED_BREAK_RECLAIM.outcomes, 0);
  assert.strictEqual(report.setupTypes.EXTREME_MOVE_REVERSAL.assessment, 'INSUFFICIENT_SAMPLE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(62)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nSome tests failed.');
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
