'use strict';

// Singles & Doubles strategy math tests (pure module, zero I/O).
// Mirrors the style of tests/b2-strategy.test.js: a small synchronous
// harness, synthetic bars, no network/database/clock.

const assert = require('node:assert/strict');
const {
  SdError, SD_RULES, GATE_ORDER, classifySpyRegime, scoreCandidate,
  detectSetupA, detectSetupB, evaluateSd, rankSdCandidates, buildSdEntry,
  sizePosition, ema, sma, computeVwapSeries, recentSwingLow, normalizeBars,
} = require('../lib/sd-strategy');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

// ---------------------------------------------------------------------------
// Rules / constants
// ---------------------------------------------------------------------------

test('SD_RULES is frozen and score weights sum to 12', () => {
  assert.ok(Object.isFrozen(SD_RULES));
  const total = Object.values(SD_RULES.scoreWeights).reduce((sum, w) => sum + w, 0);
  assert.equal(total, 12);
  assert.deepEqual(GATE_ORDER, ['price_band', 'liquidity', 'spread', 'momentum', 'vwap', 'quality_score', 'risk']);
});

test('helpers normalize bars, compute SMA/EMA, VWAP series and swing lows', () => {
  assert.deepEqual(normalizeBars(null), []);
  assert.deepEqual(normalizeBars([{ o: 1, h: 0.5, l: 2, c: 1, v: 10 }]), []); // h < l is dropped
  assert.ok(Number.isNaN(sma([], 9)));
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
  const rising = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.ok(ema(rising, 3) > ema(rising, 10)); // short-period EMA reacts faster to a rising series
  const bars = [
    { o: 10, h: 10.1, l: 9.9, c: 10, v: 1000 },
    { o: 10, h: 10.1, l: 9.9, c: 10, v: 0 }, // zero-volume bar carries VWAP forward
    { o: 10, h: 10.2, l: 10, c: 10.1, v: 1000 },
  ];
  const vwap = computeVwapSeries(bars);
  assert.equal(vwap[0], 10);
  assert.equal(vwap[1], 10);
  assert.ok(vwap[2] > 10 && vwap[2] < 10.1);
  assert.equal(recentSwingLow(bars, 3), 9.9);
});

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

test('perfect setup scores 12 and the breakdown sums to the total', () => {
  const result = scoreCandidate({
    aboveVwap: true, vwapReclaimed: true, ema9AboveEma20: true,
    higherHigh: true, higherLow: true, rvol: 2.5, volumeExpanding: true,
    spyBullish: true, relativeStrengthVsSpy: true,
  });
  assert.equal(result.score, 12);
  assert.equal(result.maxScore, 12);
  assert.equal(result.breakdown.reduce((sum, row) => sum + row.earned, 0), result.score);
  assert.equal(result.breakdown.reduce((sum, row) => sum + row.max, 0), result.maxScore);
  assert.equal(result.breakdown.length, 9);
  const rvolRow = result.breakdown.find(row => row.key === 'rvol2x');
  assert.equal(rvolRow.earned, 2);
});

test('partial setup earns only satisfied components', () => {
  const result = scoreCandidate({
    aboveVwap: true, vwapReclaimed: false, ema9AboveEma20: true,
    higherHigh: false, higherLow: false, rvol: 1.2, volumeExpanding: true,
    spyBullish: false, relativeStrengthVsSpy: false,
  });
  // 1 (aboveVwap) + 1 (ema) + 2 (volume expansion) = 4
  assert.equal(result.score, 4);
  assert.equal(result.maxScore, 12);
});

test('rvol exactly at the 2x threshold earns the component', () => {
  assert.equal(scoreCandidate({ rvol: 2.0 }).breakdown.find(r => r.key === 'rvol2x').earned, 2);
  assert.equal(scoreCandidate({ rvol: 1.999 }).breakdown.find(r => r.key === 'rvol2x').earned, 0);
});

// ---------------------------------------------------------------------------
// Setup A: VWAP breakdown -> reclaim -> hold
// ---------------------------------------------------------------------------

function setupABars() {
  return [
    { t: '09:30', o: 10.00, h: 10.05, l: 9.95, c: 10.00, v: 1000 },
    { t: '09:31', o: 10.00, h: 10.05, l: 9.95, c: 10.00, v: 1000 },
    { t: '09:32', o: 10.00, h: 10.05, l: 9.95, c: 10.00, v: 1000 },
    { t: '09:33', o: 9.90, h: 9.95, l: 9.45, c: 9.50, v: 2000 },  // breakdown below VWAP
    { t: '09:34', o: 9.60, h: 9.95, l: 9.55, c: 9.90, v: 4000 },  // reclaim above VWAP
    { t: '09:35', o: 9.90, h: 10.00, l: 9.80, c: 9.95, v: 3000 }, // hold: touches VWAP, closes above
  ];
}

test('setup A detects breakdown, reclaim and hold with volume expansion', () => {
  const { detected, detail } = detectSetupA({ bars1m: setupABars() });
  assert.equal(detected, true);
  assert.equal(detail.crossBelowIdx, 3);
  assert.equal(detail.reclaimIdx, 4);
  assert.ok(detail.retestHolds >= 1);
  assert.ok(detail.volumeExpansion > 1);
});

test('setup A rejects when there is no reclaim (stays below VWAP)', () => {
  const bars = setupABars();
  bars[4] = { t: '09:34', o: 9.55, h: 9.60, l: 9.40, c: 9.50, v: 4000 };
  bars[5] = { t: '09:35', o: 9.50, h: 9.55, l: 9.35, c: 9.40, v: 3000 };
  assert.equal(detectSetupA({ bars1m: bars }).detected, false);
});

test('setup A rejects when the reclaim has no volume expansion', () => {
  const bars = setupABars();
  bars[4].v = 100; // thin reclaim volume
  bars[5].v = 100;
  assert.equal(detectSetupA({ bars1m: bars }).detected, false);
});

// ---------------------------------------------------------------------------
// Setup B: momentum continuation with an extension filter
// ---------------------------------------------------------------------------

function risingBars({ bars = 12, jumpLast = 0 } = {}) {
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    const c = 10 + 0.02 * i + (i === bars - 1 ? jumpLast : 0);
    out.push({ t: `09:${30 + i}`, o: c - 0.005, h: c + 0.01, l: c - 0.01, c, v: 1000 });
  }
  return out;
}

test('setup B detects a healthy continuation above VWAP', () => {
  const { detected, detail } = detectSetupB({ bars1m: risingBars() });
  assert.equal(detected, true);
  assert.deepEqual(detail, { higherHigh: true, higherLow: true, extensionOk: true });
});

test('setup B rejects an overextended candle (extension filter)', () => {
  const { detected, detail } = detectSetupB({ bars1m: risingBars({ jumpLast: 0.25 }) });
  assert.equal(detected, false);
  assert.equal(detail.extensionOk, false); // last close > 1.5% above VWAP
  assert.equal(detail.higherHigh, true);  // trend is intact; only extension fails
});

test('setup B rejects a broken trend', () => {
  const bars = risingBars();
  for (let i = 6; i < bars.length; i += 1) { // roll over: lower highs and lows
    bars[i] = { t: `09:${30 + i}`, o: 10.10 - 0.03 * i, h: 10.12 - 0.03 * i, l: 10.08 - 0.03 * i, c: 10.10 - 0.03 * i, v: 1000 };
  }
  const { detected, detail } = detectSetupB({ bars1m: bars });
  assert.equal(detected, false);
  assert.equal(detail.higherHigh, false);
});

// ---------------------------------------------------------------------------
// SPY regime classification
// ---------------------------------------------------------------------------

test('SPY regime classification covers bullish, bearish and neutral', () => {
  assert.equal(classifySpyRegime({ spyDayChangePct: 1.2, spyAboveVwap: true }), 'BULLISH');
  assert.equal(classifySpyRegime({ spyDayChangePct: -1.2, spyAboveVwap: false }), 'BEARISH');
  assert.equal(classifySpyRegime({ spyDayChangePct: 0, spyAboveVwap: true }), 'NEUTRAL');
  assert.equal(classifySpyRegime({ spyDayChangePct: 1.2, spyAboveVwap: false }), 'NEUTRAL');
  assert.equal(classifySpyRegime({ spyDayChangePct: -1.2, spyAboveVwap: true }), 'NEUTRAL');
});

test('SPY regime fails closed to NEUTRAL on bad data', () => {
  assert.equal(classifySpyRegime({}), 'NEUTRAL');
  assert.equal(classifySpyRegime({ spyDayChangePct: 'garbage', spyAboveVwap: true }), 'NEUTRAL');
  assert.equal(classifySpyRegime({ spyDayChangePct: 2.5, spyAboveVwap: undefined }), 'NEUTRAL');
  assert.equal(classifySpyRegime(), 'NEUTRAL');
});

// ---------------------------------------------------------------------------
// Full evaluation: funnel, regime sizing, stop/targets
// ---------------------------------------------------------------------------

// A strong-but-realistic bullish candidate: gentle uptrend, expanding volume,
// tight spread, liquid. Expected score: 8 (all but reclaim-hold and 2x rvol).
function eligibleFixture() {
  const intradayBars = [];
  for (let i = 0; i < 25; i += 1) {
    const c = 9.90 + 0.01 * i; // gentle slope: price stays within 1.5% of VWAP
    intradayBars.push({
      t: `09:${String(30 + i).padStart(2, '0')}`,
      o: c - 0.01, h: c + 0.015, l: c - 0.015, c,
      v: i >= 22 ? 15000 : 5000, // volume expansion on the last 3 bars
    });
  }
  const dailyBars = [];
  for (let i = 0; i < 21; i += 1) {
    dailyBars.push({ t: `day-${i}`, o: 9.8, h: 10.1, l: 9.7, c: 10.0, v: 100000 });
  }
  return {
    intradayBars,
    dailyBars,
    snapshot: {
      symbol: 'TEST', volume: 200000, ask: 10.16, bid: 10.15,
      latestQuote: { ap: 10.16, bp: 10.15 },
    },
    spyRegime: 'BULLISH',
    spreadPct: 0.1,
    avgDollarVol: 1500000,
    settings: {},
  };
}

test('bullish evaluation is eligible with all 7 gates passing', () => {
  const r = evaluateSd(eligibleFixture());
  assert.equal(r.eligible, true);
  assert.equal(r.signal, 'BUY');
  assert.equal(r.setup, 'B');
  assert.equal(r.score, 8);
  assert.equal(r.maxScore, 12);
  assert.equal(r.effectiveMinScore, 7);
  assert.equal(r.sizeMultiplier, 1);
  assert.deepEqual(r.gates.map(g => g.name), GATE_ORDER);
  assert.ok(r.gates.every(g => g.passed));
  assert.ok(r.stopPrice > 0 && r.stopPrice < 10.16);
  assert.equal(r.singleTarget, 10.26);  // 10.16 * 1.01
  assert.equal(r.doubleTarget, 10.36);  // 10.16 * 1.02
  assert.ok(r.riskPerShare > 0);
  assert.ok(r.metrics.scoreBreakdown.length === 9);
});

test('neutral regime bumps the minimum score by 1 without shrinking size', () => {
  const r = evaluateSd({ ...eligibleFixture(), spyRegime: 'NEUTRAL' });
  assert.equal(r.effectiveMinScore, 8);
  assert.equal(r.sizeMultiplier, 1);
  // Neutral loses the 1-point bullish-regime component too, so the same
  // tape no longer clears the bumped bar.
  assert.equal(r.score, 7);
  assert.equal(r.eligible, false);
});

test('bearish regime bumps the minimum score by 2 and halves position size', () => {
  const r = evaluateSd({ ...eligibleFixture(), spyRegime: 'BEARISH' });
  assert.equal(r.effectiveMinScore, 9);
  assert.equal(r.sizeMultiplier, 0.5);
  assert.equal(r.eligible, false); // 8 < 9
  const qualityGate = r.gates.find(g => g.name === 'quality_score');
  assert.equal(qualityGate.passed, false);
});

test('rejection names the first failed gate and keeps every gate entry', () => {
  const r = evaluateSd({ ...eligibleFixture(), spreadPct: 5 }); // wide spread
  assert.equal(r.eligible, false);
  assert.equal(r.signal, 'WAIT');
  assert.equal(r.gates.length, 7);
  const spreadGate = r.gates.find(g => g.name === 'spread');
  assert.equal(spreadGate.passed, false);
  assert.ok(r.reasons.some(reason => reason.includes('spread')));
});

test('price outside the $5-$50 band is rejected', () => {
  const fixture = eligibleFixture();
  fixture.snapshot = { ...fixture.snapshot, ask: 60, bid: 59.99 };
  const r = evaluateSd(fixture);
  assert.equal(r.eligible, false);
  assert.equal(r.gates.find(g => g.name === 'price_band').passed, false);
});

test('configurable targets clamp to their bands', () => {
  const fixture = eligibleFixture();
  fixture.settings = { singleTargetPct: 99, doubleTargetPct: 0.01 };
  const r = evaluateSd(fixture);
  assert.equal(r.singleTarget, 10.29);  // 10.16 * 1.0125 (clamped to 1.25%)
  assert.equal(r.doubleTarget, 10.31); // 10.16 * 1.015 (clamped to 1.5%)
});

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------

test('sizePosition is risk-first: the risk budget binds before buying power', () => {
  const { qty, riskAmount } = sizePosition({
    equity: 10000, buyingPower: 5000, entryPrice: 10, stopPrice: 9.5,
    maxRiskPerTrade: 250, maxPositionDollars: 2000,
  });
  assert.equal(qty, 500);        // 250 / 0.50
  assert.equal(riskAmount, 250); // 500 * 0.50
});

test('sizePosition respects the per-position dollar cap when it binds', () => {
  const { qty } = sizePosition({
    equity: 100000, buyingPower: 100000, entryPrice: 10, stopPrice: 9.0,
    maxRiskPerTrade: 100000, maxPositionDollars: 2000,
  });
  assert.equal(qty, 2000); // 2000 / 1.00; risk budget is not the binding one
});

test('sizePosition returns zero quantity on invalid or missing inputs', () => {
  assert.deepEqual(sizePosition({ entryPrice: 10, stopPrice: 10.5, maxRiskPerTrade: 250, maxPositionDollars: 2000, buyingPower: 5000 }).qty, 0); // stop above entry
  assert.deepEqual(sizePosition({ entryPrice: 10, stopPrice: NaN, maxRiskPerTrade: 250, maxPositionDollars: 2000, buyingPower: 5000 }).qty, 0);
  assert.deepEqual(sizePosition({ entryPrice: 10, stopPrice: 9.5, maxRiskPerTrade: 250, buyingPower: 5000 }).qty, 0); // missing dollar cap
  assert.deepEqual(sizePosition({}).qty, 0);
});

// ---------------------------------------------------------------------------
// Order construction
// ---------------------------------------------------------------------------

test('buildSdEntry produces a protected OTO limit-buy order', () => {
  const order = buildSdEntry({
    symbol: 'TEST', bid: 10.39, ask: 10.40, qty: 100,
    stopPrice: 10.10, clientOrderId: 'sd-abc123',
  });
  assert.deepEqual(order, {
    symbol: 'TEST', qty: 100, side: 'buy', type: 'limit',
    limit_price: '10.40', time_in_force: 'gtc', order_class: 'oto',
    stop_loss: { stop_price: '10.10' }, client_order_id: 'sd-abc123',
  });
});

test('buildSdEntry throws SdError on bad input', () => {
  const good = { symbol: 'TEST', bid: 10.39, ask: 10.40, qty: 100, stopPrice: 10.10, clientOrderId: 'sd-abc123' };
  assert.throws(() => buildSdEntry({ ...good, symbol: 'aapl' }), SdError);          // lowercase
  assert.throws(() => buildSdEntry({ ...good, symbol: 'TEST!' }), SdError);          // illegal char
  assert.throws(() => buildSdEntry({ ...good, qty: 0 }), SdError);                   // zero qty
  assert.throws(() => buildSdEntry({ ...good, qty: 1.5 }), SdError);                 // fractional qty
  assert.throws(() => buildSdEntry({ ...good, stopPrice: 10.40 }), SdError);         // stop not below limit
  assert.throws(() => buildSdEntry({ ...good, stopPrice: 10.50 }), SdError);         // stop above limit
  assert.throws(() => buildSdEntry({ ...good, clientOrderId: '' }), SdError);        // missing client id
  assert.throws(() => buildSdEntry({ ...good, ask: NaN }), SdError);                  // invalid price
  assert.throws(() => buildSdEntry({}), SdError);
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test('rankSdCandidates orders eligible, then score, then rvol, then symbol', () => {
  const rows = [
    { symbol: 'ZZZ', eligible: true, score: 9, metrics: { rvol: 1.0 } },
    { symbol: 'AAA', eligible: true, score: 9, metrics: { rvol: 2.0 } },
    { symbol: 'MMM', eligible: false, score: 12, metrics: { rvol: 9.0 } },
    { symbol: 'BBB', eligible: true, score: 10, metrics: { rvol: 1.0 } },
    { symbol: 'CCC', eligible: true, score: 10, metrics: { rvol: 3.0 } },
  ];
  const sorted = [...rows].sort(rankSdCandidates).map(r => r.symbol);
  assert.deepEqual(sorted, ['CCC', 'BBB', 'AAA', 'ZZZ', 'MMM']);
});

console.log(`\nsd-strategy: ${passed} tests passed`);
