'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ORB_RULES,
  parseWatchlist,
  computeOpeningRange,
  computeRsi,
  classifyRegime,
  scoreSetup,
  evaluateEntry,
  planExit,
  sizePosition,
  checkDailyLocks,
  recordTradeResult,
  validateConfig,
} = require('../lib/orb/engine');
const { TRADE_FIELDS, buildTradeRecord } = require('../lib/orb/journal');

// ---------------------------------------------------------------------------
// Test helpers: synthetic ET bars. All dates are real 2026 calendar days;
// 2026-09-30 is a Wednesday (EDT, UTC-4).
// ---------------------------------------------------------------------------
const D = '2026-09-30';

function etMs(dateStr, hm) {
  const [h, mi] = hm.split(':').map(Number);
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(`${dateStr}T12:00:00Z`)));
  const off = 12 - localHour;
  return Date.parse(`${dateStr}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00-${String(off).padStart(2, '0')}:00`);
}

function bar(hm, o, h, l, c, v, dateStr = D) {
  return { t: etMs(dateStr, hm), o, h, l, c, v };
}

function minuteBars(startHm, count, fn, dateStr = D) {
  const [h0, m0] = startHm.split(':').map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    const m = m0 + i;
    const hh = h0 + Math.floor(m / 60);
    const mm = m % 60;
    const hm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    out.push(fn(etMs(dateStr, hm), i, hm));
  }
  return out;
}

// Canonical 15-min OR: high 100.50 (bar 4), low 99.50 (bar 9). Closes carry
// small two-sided variance (a perfectly flat close series makes RSI(14)
// degenerate — any uptick reads 100 — which would trip the maxRsiLong
// entry filter in every fixture). Highs/lows are unchanged, so the OR
// levels and all stop/target math are identical to the flat version.
const OR_CLOSES = [100.00, 99.85, 100.12, 99.88, 100.10, 99.86, 100.08, 99.90, 100.06, 99.92, 100.04, 99.94, 100.02, 99.96, 100.00];
function orBars() {
  return minuteBars('09:30', 15, (t, i) => ({
    t,
    o: 99.90,
    h: i === 4 ? 100.50 : 100.10 + (i % 5) * 0.05,
    l: i === 9 ? 99.50 : 99.80 - (i % 3) * 0.05,
    c: OR_CLOSES[i],
    v: 20000,
  }));
}

// Canonical happy-path LONG ctx: breakout 09:47, holds above, 09:50 close 100.75.
function goodLongCtx(overrides = {}) {
  const post = [
    bar('09:45', 100.00, 100.20, 99.90, 100.10, 22000),
    bar('09:46', 100.10, 100.30, 100.00, 100.20, 25000),
    bar('09:47', 100.20, 100.80, 100.15, 100.70, 60000), // breakout bar
    bar('09:48', 100.70, 100.85, 100.60, 100.78, 30000),
    bar('09:49', 100.78, 100.90, 100.65, 100.72, 28000),
    bar('09:50', 100.72, 100.85, 100.62, 100.75, 26000),
  ];
  const bars = orBars().concat(post);
  // These canonical fixtures were written for the scored gate stack;
  // two-break behavior has its own dedicated tests below.
  const { rules: ruleOverrides, ...rest } = overrides;
  return {
    symbol: 'AAPL',
    direction: 'long',
    bars,
    or: computeOpeningRange(bars, 15),
    vwap: 100.20,
    rvol: 2.5,
    avgVolume: 2000000,
    spreadPct: 0.10,
    relStrengthVsSpy: 0.8,
    regime: 'bullish',
    atr: 0.40,
    premarket: { trend: 'up', gapPct: 0.5 },
    levels: { priorHigh: 102.50, priorLow: 98.00 },
    lastAttempts: [],
    accountEquity: 25000,
    trendAligned: true,
    ...rest,
    rules: { triggerMode: 'scored', ...(ruleOverrides || {}) },
  };
}

// Canonical happy-path SHORT ctx (mirror of the long).
function goodShortCtx(overrides = {}) {
  const post = [
    bar('09:45', 100.00, 100.10, 99.90, 99.95, 22000),
    bar('09:46', 99.95, 100.00, 99.70, 99.80, 25000),
    bar('09:47', 99.80, 99.85, 99.20, 99.30, 60000), // breakdown bar
    bar('09:48', 99.30, 99.40, 99.15, 99.22, 30000),
    bar('09:49', 99.22, 99.35, 99.10, 99.28, 28000),
    bar('09:50', 99.28, 99.38, 99.12, 99.25, 26000),
  ];
  const bars = orBars().concat(post);
  const { rules: ruleOverrides, ...rest } = overrides;
  return {
    symbol: 'AAPL',
    direction: 'short',
    bars,
    or: computeOpeningRange(bars, 15),
    vwap: 99.80,
    rvol: 2.5,
    avgVolume: 2000000,
    spreadPct: 0.10,
    relStrengthVsSpy: -0.8,
    regime: 'bearish',
    atr: 0.40,
    premarket: { trend: 'down', gapPct: -0.5 },
    levels: { priorHigh: 102.50, priorLow: 98.00 },
    lastAttempts: [],
    accountEquity: 25000,
    trendAligned: true,
    ...rest,
    rules: { triggerMode: 'scored', ...(ruleOverrides || {}) },
  };
}

function baseDayState(overrides = {}) {
  return {
    date: D, pnl: 0, trades: 0, consecLosses: 0,
    openPositions: 0, exposureDollars: 0, tradesBySymbol: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DEFAULT_ORB_RULES
// ---------------------------------------------------------------------------
test('DEFAULT_ORB_RULES carries every spec setting with spec defaults', () => {
  const r = DEFAULT_ORB_RULES;
  assert.equal(r.orMinutes, 15);
  assert.equal(r.entryWindowStart, '09:45');
  assert.equal(r.entryWindowEnd, '11:30');
  assert.equal(r.secondWindowEnabled, false);
  assert.equal(r.secondWindowStart, '14:00');
  assert.equal(r.secondWindowEnd, '15:30');
  assert.equal(r.minScore, 75);
  assert.deepEqual({ ...r.weights }, {
    regime: 15, volume: 15, relStrength: 15, vwap: 10, breakoutQuality: 15,
    levelClearance: 10, trendAlign: 10, volatility: 5, premarket: 5,
  });
  assert.equal(r.minRvol, 1.5);
  assert.equal(r.preferredRvol, 2);
  assert.equal(r.strongRvol, 3);
  assert.equal(r.allowLong, true);
  assert.equal(r.allowShort, true);
  assert.equal(r.entryMode, 'either');
  assert.equal(r.maxAttemptsPerSymbol, 2);
  assert.equal(r.cooldownMinutes, 15);
  assert.equal(r.sizingMode, 'dollars');
  assert.equal(r.fixedDollars, 500);
  assert.equal(r.fixedShares, 100);
  assert.equal(r.acctPct, 2);
  assert.equal(r.riskPct, 0.5);
  assert.equal(r.stopPct, 1.5);
  assert.equal(r.atrStopMult, 1.5);
  assert.equal(r.dollarRisk, 25);
  assert.deepEqual(r.targets.map(t => ({ ...t })), [{ r: 2, pct: 25 }]);
  assert.equal(r.breakevenR, 1);
  assert.equal(r.trailMode, 'atr');
  assert.equal(r.orWidthTargets, false);
  assert.equal(r.maxRsiLong, 75);
  assert.equal(r.maxDailyLossDollars, 200);
  assert.equal(r.maxTradesPerDay, 10);
  assert.equal(r.maxConsecLosses, 3);
  assert.equal(r.maxPositions, 3);
  assert.equal(r.maxExposureDollars, 5000);
  assert.equal(r.maxTradesPerSymbol, 2);
  assert.equal(r.requireVwapAgree, true);
  assert.equal(r.minLevelClearancePct, 0.5);
  assert.equal(r.minRR, 1.5);
  assert.equal(r.maxWickPct, 40);
  assert.equal(r.maxExtensionAtrs, 2);
  assert.equal(r.newsPolicy, 'block');
  assert.equal(r.tradingMode, 'PAPER');
  assert.equal(r.liveEnabled, false);
  assert.equal(r.liveConfirmed, false);
});

test('DEFAULT_ORB_RULES is frozen and weights sum to 100', () => {
  assert.ok(Object.isFrozen(DEFAULT_ORB_RULES));
  assert.ok(Object.isFrozen(DEFAULT_ORB_RULES.weights));
  const sum = Object.values(DEFAULT_ORB_RULES.weights).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
});

// ---------------------------------------------------------------------------
// computeOpeningRange
// ---------------------------------------------------------------------------
test('computeOpeningRange: 15-min default over synthetic bars', () => {
  const or = computeOpeningRange(orBars(), 15);
  assert.ok(!or.error, or.error);
  assert.equal(or.high, 100.50);
  assert.equal(or.low, 99.50);
  assert.equal(or.mid, 100.00);
  assert.equal(or.width, 1.00);
  assert.equal(or.barCount, 15);
  assert.equal(or.startMs, etMs(D, '09:30'));
  assert.equal(or.endMs, etMs(D, '09:45'));
});

test('computeOpeningRange: 5-min and 30-min variants', () => {
  const bars = orBars().concat([
    bar('09:45', 100.00, 100.20, 99.90, 100.10, 22000),
    bar('09:46', 100.10, 100.30, 100.00, 100.20, 25000),
  ]);
  const or5 = computeOpeningRange(bars, 5);
  assert.equal(or5.barCount, 5);
  assert.equal(or5.high, 100.50); // bar idx 4 (09:34) is inside
  assert.equal(or5.low, 99.70);
  assert.equal(or5.endMs, etMs(D, '09:35'));
  const or30 = computeOpeningRange(bars, 30);
  assert.equal(or30.endMs, etMs(D, '10:00'));
  assert.equal(or30.barCount, 17);
  assert.equal(or30.high, 100.50);
  assert.equal(or30.low, 99.50);
});

test('computeOpeningRange: default orMinutes is 15', () => {
  const or = computeOpeningRange(orBars());
  assert.equal(or.endMs, etMs(D, '09:45'));
});

test('computeOpeningRange: ignores pre-market and post-window bars', () => {
  const bars = [
    bar('09:00', 50, 200, 10, 60, 999999), // premarket spike must not leak in
    ...orBars(),
    bar('12:00', 50, 300, 5, 60, 999999), // midday spike must not leak in
  ];
  const or = computeOpeningRange(bars, 15);
  assert.equal(or.high, 100.50);
  assert.equal(or.low, 99.50);
  assert.equal(or.barCount, 15);
});

test('computeOpeningRange: insufficient bars -> {error}', () => {
  assert.ok(computeOpeningRange([], 15).error);
  assert.ok(computeOpeningRange(null, 15).error);
  const preOnly = [bar('08:00', 1, 2, 0.5, 1.5, 100), bar('09:00', 1, 2, 0.5, 1.5, 100)];
  const r = computeOpeningRange(preOnly, 15);
  assert.ok(r.error && r.error.startsWith('NO_OR_BARS'), r.error);
});

test('computeOpeningRange: invalid orMinutes -> {error}', () => {
  assert.ok(computeOpeningRange(orBars(), 10).error.startsWith('INVALID_OR_MINUTES'));
});

// ---------------------------------------------------------------------------
// classifyRegime
// ---------------------------------------------------------------------------
test('classifyRegime: bullish / bearish / neutral', () => {
  const bull = classifyRegime({ spyChangePct: 0.8, qqqChangePct: 1.0, iwmChangePct: 0.6, vix: 18, vixChangePct: 2 });
  assert.equal(bull.regime, 'bullish');
  assert.equal(bull.score, 1);
  assert.ok(bull.reasons.length > 0);

  const strongBull = classifyRegime({ spyChangePct: 1.2, qqqChangePct: 1.5, iwmChangePct: 1.1, vix: 16, vixChangePct: -3 });
  assert.equal(strongBull.regime, 'bullish');
  assert.equal(strongBull.score, 2);

  const bear = classifyRegime({ spyChangePct: -0.8, qqqChangePct: -1.0, iwmChangePct: -0.6, vix: 19, vixChangePct: 3 });
  assert.equal(bear.regime, 'bearish');
  assert.equal(bear.score, -1);

  const strongBear = classifyRegime({ spyChangePct: -1.2, qqqChangePct: -1.5, iwmChangePct: -1.1, vix: 22, vixChangePct: 5 });
  assert.equal(strongBear.regime, 'bearish');
  assert.equal(strongBear.score, -2);

  const neutral = classifyRegime({ spyChangePct: 0.5, qqqChangePct: -0.2, iwmChangePct: 0.1, vix: 17, vixChangePct: 0 });
  assert.equal(neutral.regime, 'neutral');
  assert.equal(neutral.score, 0);
});

test('classifyRegime: high-volatility on VIX > 30 or VIX up > 20%', () => {
  const byLevel = classifyRegime({ spyChangePct: 1.0, qqqChangePct: 1.0, iwmChangePct: 1.0, vix: 32, vixChangePct: 1 });
  assert.equal(byLevel.regime, 'high-volatility');
  assert.equal(byLevel.score, -2);

  const bySpike = classifyRegime({ spyChangePct: -0.5, qqqChangePct: -0.5, iwmChangePct: -0.5, vix: 22, vixChangePct: 25 });
  assert.equal(bySpike.regime, 'high-volatility');
  assert.equal(bySpike.score, -2);

  // VIX 30 exactly is not "above 30"
  const edge = classifyRegime({ spyChangePct: 0.8, qqqChangePct: 0.9, iwmChangePct: 0.7, vix: 30, vixChangePct: 20 });
  assert.equal(edge.regime, 'bullish');
});

test('classifyRegime: missing index data -> neutral', () => {
  const r = classifyRegime({ vix: 18 });
  assert.equal(r.regime, 'neutral');
  assert.equal(r.score, 0);
});

// ---------------------------------------------------------------------------
// scoreSetup
// ---------------------------------------------------------------------------
test('scoreSetup: perfect long setup scores 100 and passes minScore', () => {
  const s = scoreSetup({
    direction: 'long',
    regime: 'bullish',
    rvol: 3.5,
    relStrengthVsSpy: 1.5,
    vwapPosition: 'above',
    breakoutQuality: { closeBeyond: true, wickPct: 10, extensionAtrs: 0.5, retestHold: true },
    levelClearancePct: 3,
    trendAligned: true,
    atrPct: 2,
    premarketTrend: 'up',
    gapPct: 0.5,
  });
  assert.equal(s.score, 100);
  assert.equal(s.maxScore, 100);
  assert.equal(s.meetsMinimum, true);
  assert.deepEqual(Object.keys(s.breakdown).sort(), [
    'breakoutQuality', 'levelClearance', 'premarket', 'regime', 'relStrength',
    'trendAlign', 'volatility', 'volume', 'vwap',
  ].sort());
  assert.equal(Object.values(s.breakdown).reduce((a, b) => a + b, 0), s.score);
  assert.equal(s.reasons.length, 9);
  assert.ok(s.reasons.every(x => typeof x === 'string' && x.includes('+')));
});

test('scoreSetup: every component is capped at its weight', () => {
  const s = scoreSetup({
    direction: 'short', regime: 'bearish', rvol: 99, relStrengthVsSpy: -9,
    vwapPosition: 'below',
    breakoutQuality: { closeBeyond: true, wickPct: 0, extensionAtrs: 0, retestHold: true },
    levelClearancePct: 99, trendAligned: true, atrPct: 2,
    premarketTrend: 'down', gapPct: 0,
  });
  for (const [k, v] of Object.entries(s.breakdown)) {
    assert.ok(v <= DEFAULT_ORB_RULES.weights[k], `${k}: ${v} > weight ${DEFAULT_ORB_RULES.weights[k]}`);
  }
  assert.equal(s.score, 100);
});

test('scoreSetup: weak setup fails minScore gating', () => {
  const s = scoreSetup({
    direction: 'long', regime: 'neutral', rvol: 1.5, relStrengthVsSpy: 0.1,
    vwapPosition: 'above',
    breakoutQuality: { closeBeyond: true, wickPct: 8, extensionAtrs: 0.5, retestHold: false },
    levelClearancePct: 1.0, trendAligned: false, atrPct: 0.4,
    premarketTrend: 'flat', gapPct: 0,
  });
  assert.ok(s.score < 75, `expected < 75, got ${s.score}`);
  assert.equal(s.meetsMinimum, false);
  assert.equal(s.minScore, 75);
});

test('scoreSetup: direction-aware regime and VWAP', () => {
  const longBear = scoreSetup({
    direction: 'long', regime: 'bearish', rvol: 3, relStrengthVsSpy: 1.5,
    vwapPosition: 'below',
    breakoutQuality: { closeBeyond: true, wickPct: 5, extensionAtrs: 0.5 },
    levelClearancePct: 3, trendAligned: true, atrPct: 2, premarketTrend: 'up',
  });
  assert.equal(longBear.breakdown.regime, 0);
  assert.equal(longBear.breakdown.vwap, 0);
  const shortBear = scoreSetup({
    direction: 'short', regime: 'bearish', rvol: 3, relStrengthVsSpy: -1.5,
    vwapPosition: 'below',
    breakoutQuality: { closeBeyond: true, wickPct: 5, extensionAtrs: 0.5 },
    levelClearancePct: 3, trendAligned: true, atrPct: 2, premarketTrend: 'down',
  });
  assert.equal(shortBear.breakdown.regime, 15);
  assert.equal(shortBear.breakdown.vwap, 10);
});

test('scoreSetup: custom weights are honored', () => {
  const s = scoreSetup(
    {
      direction: 'long', regime: 'bullish', rvol: 3, relStrengthVsSpy: 1.5,
      vwapPosition: 'above',
      breakoutQuality: { closeBeyond: true, wickPct: 5, extensionAtrs: 0.5 },
      levelClearancePct: 3, trendAligned: true, atrPct: 2, premarketTrend: 'up',
    },
    { weights: { regime: 50, volume: 5, relStrength: 5, vwap: 5, breakoutQuality: 5, levelClearance: 5, trendAlign: 5, volatility: 10, premarket: 10 } },
  );
  assert.equal(s.breakdown.regime, 50);
  assert.equal(s.score, 100);
});

// ---------------------------------------------------------------------------
// evaluateEntry — happy paths
// ---------------------------------------------------------------------------
test('evaluateEntry: happy-path long enters with full plan and WHY', () => {
  const res = evaluateEntry(goodLongCtx());
  assert.equal(res.decision, 'enter-long');
  assert.equal(res.score, 87);
  assert.ok(res.score >= 75);
  assert.deepEqual(Object.keys(res.breakdown).sort(), Object.keys(DEFAULT_ORB_RULES.weights).sort());
  assert.deepEqual(res.rejectReasons, []);
  assert.equal(res.entry, 100.75);
  assert.equal(res.stop, 100.15); // ATR 1.5x: 100.75 - 1.5*0.40
  // Let-winners-run exits (Johnny 2026-10-01): one 25% partial at 2R, no
  // OR-width targets by default — the rest rides breakeven + ATR trail.
  assert.ok(Array.isArray(res.targets) && res.targets.length === 1);
  assert.deepEqual(res.targets[0], { r: 2, pct: 25, price: 101.95, type: 'rr' });
  assert.equal(res.rr, 2);
  assert.deepEqual(res.size, { shares: 4, notional: 403.00, riskDollars: 2.40 });
  assert.ok(res.why.includes('ENTER-LONG') && res.why.includes('AAPL'), res.why);
  assert.ok(res.why.includes('87/100'), res.why);
});

test('evaluateEntry: happy-path short mirrors the long', () => {
  const res = evaluateEntry(goodShortCtx());
  assert.equal(res.decision, 'enter-short');
  assert.equal(res.score, 87);
  assert.equal(res.entry, 99.25);
  assert.equal(res.stop, 99.85); // 99.25 + 1.5*0.40
  assert.ok(res.targets.every(t => t.type === 'rr')); // no OR-width targets by default
  assert.deepEqual(res.targets[0], { r: 2, pct: 25, price: 98.05, type: 'rr' });
  assert.equal(res.rr, 2);
  assert.ok(res.why.includes('ENTER-SHORT'));
});

// ---------------------------------------------------------------------------
// evaluateEntry — simple two-break trigger (Johnny 2026-10-08)
// ---------------------------------------------------------------------------
test('two-break: default rules enter after two conviction closes beyond the OR high', () => {
  const ctx = goodLongCtx();
  ctx.rules = {}; // factory default is now two-break
  const res = evaluateEntry(ctx);
  assert.equal(res.decision, 'enter-long');
  assert.equal(res.entry, 100.75);
  assert.equal(res.stop, 100.15); // same ATR stop machinery as scored mode
  assert.ok(res.why.includes('2 closes beyond the OR high'), res.why);
});

test('two-break: scored gates no longer block (bearish regime, tiny intraday RVOL)', () => {
  const res = evaluateEntry(goodLongCtx({
    regime: 'bearish', rvol: 0.01,
    rules: { triggerMode: 'two-break' },
  }));
  assert.equal(res.decision, 'enter-long');
});

test('two-break: one conviction close is not enough', () => {
  const ctx = goodLongCtx({ rules: { triggerMode: 'two-break' } });
  ctx.bars = ctx.bars.slice(0, 18); // through the first breakout bar only
  const res = evaluateEntry(ctx);
  assert.equal(res.decision, 'wait');
  assert.ok(res.rejectReasons.some(r => r.startsWith('FIRST_BREAK_ONLY:')),
    `expected FIRST_BREAK_ONLY, got: ${JSON.stringify(res.rejectReasons)}`);
});

test('two-break: closes beyond the line without conviction volume do not count', () => {
  const ctx = goodLongCtx({ rules: { triggerMode: 'two-break' } });
  ctx.bars = ctx.bars.map((b, i) => (i >= 15 ? { ...b, v: 20000 } : b)); // post-OR volume = OR average
  const res = evaluateEntry(ctx);
  assert.equal(res.decision, 'wait');
  assert.ok(res.rejectReasons.some(r => r.startsWith('NO_CONVICTION_BREAK:')),
    `expected NO_CONVICTION_BREAK, got: ${JSON.stringify(res.rejectReasons)}`);
});

test('two-break: short side mirrors — two conviction closes below the OR low', () => {
  const res = evaluateEntry(goodShortCtx({ rules: { triggerMode: 'two-break' } }));
  assert.equal(res.decision, 'enter-short');
  assert.equal(res.entry, 99.25);
  assert.equal(res.stop, 99.85);
  assert.ok(res.why.includes('2 closes beyond the OR low'), res.why);
});

test('evaluateEntry: targets sorted nearest-first, OR-width included', () => {
  const res = evaluateEntry(goodLongCtx());
  const rs = res.targets.map(t => t.r);
  assert.deepEqual(rs, [...rs].sort((a, b) => a - b));
});

// ---------------------------------------------------------------------------
// evaluateEntry — every reject reason
// ---------------------------------------------------------------------------
function expectReject(ctx, code) {
  const res = evaluateEntry(ctx);
  assert.equal(res.decision, 'wait', `expected wait, got ${res.decision}: ${res.why}`);
  assert.ok(res.rejectReasons.some(r => r.startsWith(code + ':')),
    `expected ${code}, got: ${JSON.stringify(res.rejectReasons)}`);
  assert.equal(res.entry, null);
  return res;
}

test('evaluateEntry rejects: weak volume', () => {
  expectReject(goodLongCtx({ rvol: 1.0 }), 'WEAK_VOLUME');
  expectReject(goodLongCtx({ rvol: null }), 'RVOL_MISSING');
});

test('evaluateEntry rejects: no entries before OR completion', () => {
  const bars = orBars(); // ends 09:44, OR ends 09:45
  const ctx = goodLongCtx({ bars, or: computeOpeningRange(bars, 15) });
  expectReject(ctx, 'OR_INCOMPLETE');
});

test('evaluateEntry rejects: outside entry window', () => {
  expectReject(goodLongCtx({ nowMs: etMs(D, '12:00') }), 'OUTSIDE_ENTRY_WINDOW');
  // second window honored when enabled
  const res = evaluateEntry(goodLongCtx({
    nowMs: etMs(D, '14:30'),
    rules: { secondWindowEnabled: true },
  }));
  assert.equal(res.decision, 'enter-long');
});

test('evaluateEntry rejects: max attempts and cooldown', () => {
  const t1 = etMs(D, '09:46');
  const t2 = etMs(D, '09:48');
  expectReject(goodLongCtx({ lastAttempts: [{ t: t1, result: 'rejected' }, { t: t2, result: 'rejected' }] }), 'MAX_ATTEMPTS');
  expectReject(goodLongCtx({ lastAttempts: [{ t: etMs(D, '09:49'), result: 'stopped' }] }), 'COOLDOWN');
  // yesterday's attempts do not count
  const res = evaluateEntry(goodLongCtx({ lastAttempts: [{ t: etMs('2026-09-29', '10:00'), result: 'rejected' }, { t: etMs('2026-09-29', '10:05'), result: 'rejected' }] }));
  assert.equal(res.decision, 'enter-long');
});

test('evaluateEntry rejects: extreme wick on the breakout bar', () => {
  const ctx = goodLongCtx();
  ctx.bars = ctx.bars.map(b => (b.t === etMs(D, '09:47') ? { ...b, o: 100.70, h: 100.85, l: 99.90, c: 100.70 } : b));
  expectReject(ctx, 'EXTREME_WICK');
});

test('evaluateEntry rejects: over-extended beyond maxExtensionAtrs', () => {
  const ctx = goodLongCtx();
  const far = (hm, c) => ({ t: etMs(D, hm), o: 100.60, h: c + 0.05, l: 100.55, c, v: 60000 });
  ctx.bars = orBars().concat([
    bar('09:45', 100.00, 100.20, 99.90, 100.10, 22000),
    bar('09:46', 100.10, 100.30, 100.00, 100.20, 25000),
    far('09:47', 101.60), // 2.75 ATRs past 100.50
    far('09:48', 101.62),
    far('09:49', 101.58),
    far('09:50', 101.61),
  ]);
  expectReject(ctx, 'OVER_EXTENDED');
});

test('evaluateEntry rejects: VWAP failure', () => {
  expectReject(goodLongCtx({ vwap: 101.00 }), 'VWAP_FAILURE');
});

test('evaluateEntry rejects: opposing regime (SPY reversal)', () => {
  expectReject(goodLongCtx({ regime: 'bearish' }), 'REGIME_OPPOSED');
  expectReject(goodShortCtx({ regime: 'bullish' }), 'REGIME_OPPOSED');
});

test('evaluateEntry rejects: widened spreads and thin liquidity', () => {
  expectReject(goodLongCtx({ spreadPct: 1.0 }), 'WIDE_SPREAD');
  expectReject(goodLongCtx({ avgVolume: 100000 }), 'LOW_LIQUIDITY');
});

test('evaluateEntry rejects: disappearing volume', () => {
  const ctx = goodLongCtx();
  ctx.bars = ctx.bars.map(b => (b.t === etMs(D, '09:47') ? { ...b, v: 5000 } : b));
  expectReject(ctx, 'VOLUME_FADING');
});

test('evaluateEntry rejects: nearby level', () => {
  expectReject(goodLongCtx({ levels: { priorHigh: 100.60, priorLow: 98.00 } }), 'NEARBY_LEVEL');
});

test('evaluateEntry rejects: low score', () => {
  const res = expectReject(goodLongCtx({
    rvol: 1.5, relStrengthVsSpy: 0.1, regime: 'neutral',
    premarket: { trend: 'flat', gapPct: 0 }, trendAligned: false,
  }), 'LOW_SCORE');
  assert.ok(res.why.includes('LOW_SCORE'));
});

test('evaluateEntry rejects: insufficient R:R', () => {
  expectReject(goodLongCtx({ rules: { targets: [{ r: 1.0, pct: 100 }] } }), 'LOW_RR');
});

test('evaluateEntry rejects: direction disabled', () => {
  expectReject(goodShortCtx({ rules: { allowShort: false } }), 'DIRECTION_DISABLED');
  expectReject(goodLongCtx({ rules: { allowLong: false } }), 'DIRECTION_DISABLED');
});

test('evaluateEntry rejects: no breakout at all', () => {
  const bars = orBars().concat([
    bar('09:45', 100.00, 100.10, 99.90, 100.00, 20000),
    bar('09:46', 100.00, 100.10, 99.90, 100.00, 20000),
    bar('09:47', 100.00, 100.10, 99.90, 100.00, 20000),
  ]);
  expectReject(goodLongCtx({ bars }), 'NO_BREAKOUT');
});

test('evaluateEntry rejects: missing data fail-closes', () => {
  expectReject(goodLongCtx({ atr: null }), 'ATR_MISSING');
  expectReject(goodLongCtx({ spreadPct: null }), 'SPREAD_UNKNOWN');
  expectReject(goodLongCtx({ levels: {} }), 'LEVELS_MISSING');
  expectReject(goodLongCtx({ accountEquity: null }), 'ACCOUNT_EQUITY_MISSING');
});

test('evaluateEntry rejects: news blocked by policy', () => {
  expectReject(goodLongCtx({ hasMaterialNews: true }), 'NEWS_BLOCKED');
  const reduced = evaluateEntry(goodLongCtx({ hasMaterialNews: true, rules: { newsPolicy: 'reduce' } }));
  assert.equal(reduced.decision, 'enter-long');
  assert.equal(reduced.size.shares, 2);
  assert.equal(reduced.size.reducedForNews, true);
});

test('evaluateEntry: empty bars -> wait', () => {
  const res = evaluateEntry(goodLongCtx({ bars: [] }));
  assert.equal(res.decision, 'wait');
  assert.ok(res.rejectReasons[0].startsWith('NO_BARS'));
});

// ---------------------------------------------------------------------------
// evaluateEntry — entry modes
// ---------------------------------------------------------------------------
test('evaluateEntry: entryMode=retest requires a held retest', () => {
  expectReject(goodLongCtx({ rules: { entryMode: 'retest' } }), 'NO_RETEST');

  // Add a held retest at 09:48: touches 100.50+buffer, closes above.
  const ctx = goodLongCtx({ rules: { entryMode: 'retest' } });
  ctx.bars = ctx.bars.map(b => (b.t === etMs(D, '09:48')
    ? { ...b, o: 100.70, h: 100.75, l: 100.45, c: 100.62, v: 28000 }
    : b));
  const res = evaluateEntry(ctx);
  assert.equal(res.decision, 'enter-long');
  assert.ok(res.why.includes('retest'), res.why);
});

test('evaluateEntry: entryMode=direct works on the fresh breakout', () => {
  const res = evaluateEntry(goodLongCtx({ rules: { entryMode: 'direct' } }));
  assert.equal(res.decision, 'enter-long');
  assert.ok(res.why.includes('direct'), res.why);
});

// ---------------------------------------------------------------------------
// evaluateEntry — reversal setups
// ---------------------------------------------------------------------------
function failedBreakoutLongCtx(overrides = {}) {
  const fade = [
    bar('09:51', 100.75, 100.80, 100.40, 100.45, 30000),
    bar('09:52', 100.45, 100.50, 100.10, 100.15, 32000),
    bar('09:53', 100.15, 100.20, 99.85, 99.95, 35000),
    bar('09:54', 99.95, 100.05, 99.80, 99.92, 30000),
    bar('09:55', 99.92, 99.98, 99.82, 99.90, 28000), // closes below OR mid 100.00
  ];
  const ctx = goodLongCtx(overrides);
  ctx.bars = ctx.bars.concat(fade);
  return ctx;
}

test('evaluateEntry: failed upside breakout becomes a reversal-short', () => {
  const res = evaluateEntry(failedBreakoutLongCtx({
    regime: 'bearish',
    relStrengthVsSpy: -0.8,
    vwap: 100.30,
    premarket: { trend: 'down', gapPct: -0.5 },
  }));
  assert.equal(res.decision, 'reversal-short');
  assert.ok(res.rejectReasons.some(r => r.startsWith('RETURN_INSIDE_OR')), JSON.stringify(res.rejectReasons));
  assert.ok(res.score >= 75, `score ${res.score}`);
  assert.equal(res.entry, 99.90);
  assert.equal(res.stop, 100.50); // ATR stop above entry
  assert.ok(res.why.includes('REVERSAL-SHORT'), res.why);
});

test('evaluateEntry: failed breakout with weak reversal score stays out', () => {
  const res = evaluateEntry(failedBreakoutLongCtx({
    regime: 'bearish',
    relStrengthVsSpy: -0.1,
    rvol: 1.5,
    vwap: 100.30,
    premarket: { trend: 'flat', gapPct: 0 },
    trendAligned: false,
  }));
  assert.equal(res.decision, 'wait');
  assert.ok(res.rejectReasons.some(r => r.startsWith('RETURN_INSIDE_OR')));
  assert.ok(res.rejectReasons.some(r => r.startsWith('LOW_SCORE')));
});

test('evaluateEntry: failed downside breakout becomes a reversal-long', () => {
  const ctx = goodShortCtx({
    regime: 'bullish',
    relStrengthVsSpy: 0.8,
    vwap: 99.00,
    premarket: { trend: 'up', gapPct: 0.5 },
  });
  const rally = [
    bar('09:51', 99.25, 99.60, 99.20, 99.55, 30000),
    bar('09:52', 99.55, 99.90, 99.50, 99.85, 32000),
    bar('09:53', 99.85, 100.15, 99.80, 100.05, 35000),
    bar('09:54', 100.05, 100.20, 99.95, 100.08, 30000),
    bar('09:55', 100.08, 100.18, 100.02, 100.10, 28000), // closes above OR mid 100.00
  ];
  ctx.bars = ctx.bars.concat(rally);
  const res = evaluateEntry(ctx);
  assert.equal(res.decision, 'reversal-long');
  assert.ok(res.rejectReasons.some(r => r.startsWith('RETURN_INSIDE_OR')));
});

// ---------------------------------------------------------------------------
// evaluateEntry — all stop modes
// ---------------------------------------------------------------------------
test('evaluateEntry: pct stop', () => {
  const res = evaluateEntry(goodLongCtx({ rules: { stopMode: 'pct' } }));
  assert.equal(res.decision, 'enter-long');
  assert.ok(Math.abs(res.stop - 100.75 * 0.985) < 1e-4, res.stop);
});

test('evaluateEntry: orOpposite stop', () => {
  const res = evaluateEntry(goodLongCtx({ rules: { stopMode: 'orOpposite' } }));
  assert.equal(res.stop, 99.50);
});

test('evaluateEntry: breakoutLevel stop', () => {
  const res = evaluateEntry(goodLongCtx({ rules: { stopMode: 'breakoutLevel' } }));
  assert.ok(Math.abs(res.stop - (100.50 - 0.1 * 0.40)) < 1e-9, res.stop);
});

test('evaluateEntry: retestExtreme stop uses the held retest low', () => {
  const ctx = goodLongCtx({ rules: { stopMode: 'retestExtreme', entryMode: 'retest' } });
  ctx.bars = ctx.bars.map(b => (b.t === etMs(D, '09:48')
    ? { ...b, o: 100.70, h: 100.75, l: 100.45, c: 100.62, v: 28000 }
    : b));
  const res = evaluateEntry(ctx);
  assert.equal(res.decision, 'enter-long');
  assert.ok(Math.abs(res.stop - (100.45 - 0.1 * 0.40)) < 1e-9, res.stop);
});

test('evaluateEntry: dollarRisk stop spreads $25 over the share count', () => {
  const res = evaluateEntry(goodLongCtx({ rules: { stopMode: 'dollarRisk' } }));
  assert.equal(res.decision, 'enter-long');
  assert.equal(res.stop, 94.50); // 100.75 - 25/4
  assert.ok(res.why.includes('$25'), res.why);
});

// ---------------------------------------------------------------------------
// sizePosition — all four sizing modes
// ---------------------------------------------------------------------------
test('sizePosition: fixed dollars', () => {
  const s = sizePosition({ mode: 'dollars', entry: 100.75, stop: 100.15, accountEquity: 25000, fixedDollars: 500 });
  assert.deepEqual(s, { shares: 4, notional: 403.00, riskDollars: 2.40 });
});

test('sizePosition: fixed shares', () => {
  const s = sizePosition({ mode: 'shares', entry: 10, stop: 9.5, accountEquity: 25000, fixedShares: 37 });
  assert.equal(s.shares, 37);
  assert.equal(s.notional, 370.00);
  assert.equal(s.riskDollars, 18.50);
});

test('sizePosition: account percent', () => {
  const s = sizePosition({ mode: 'acctPct', entry: 100.75, stop: 100.15, accountEquity: 25000, acctPct: 2 });
  assert.equal(s.shares, 4); // floor(500 / 100.75)
});

test('sizePosition: risk-based', () => {
  const s = sizePosition({ mode: 'risk', entry: 100.75, stop: 100.15, accountEquity: 25000, riskPct: 0.5 });
  assert.equal(s.shares, 208); // floor(125 / 0.60)
  assert.ok(s.riskDollars <= 125.01);
});

test('sizePosition: invalid input yields zero shares, never throws', () => {
  assert.deepEqual(sizePosition({ mode: 'risk', entry: 100, stop: 100, accountEquity: 25000, riskPct: 0.5 }), { shares: 0, notional: 0, riskDollars: 0 });
  assert.deepEqual(sizePosition({ mode: 'dollars', entry: 0, accountEquity: 25000, fixedDollars: 500 }), { shares: 0, notional: 0, riskDollars: 0 });
  assert.deepEqual(sizePosition({}), { shares: 0, notional: 0, riskDollars: 0 });
  assert.deepEqual(sizePosition({ mode: 'bogus', entry: 10, accountEquity: 1000, fixedDollars: 100 }), { shares: 10, notional: 100, riskDollars: 0 });
});

// ---------------------------------------------------------------------------
// planExit
// ---------------------------------------------------------------------------
function longPos(overrides = {}) {
  return {
    direction: 'long',
    entry: 100,
    stop: 99,
    targets: [
      { r: 1.5, pct: 50, price: 101.50, type: 'rr' },
      { r: 3, pct: 50, price: 103.00, type: 'rr' },
    ],
    size: 100,
    breakevenAt: false,
    partialsTaken: [],
    breakevenR: 1,
    trailMode: 'none',
    ...overrides,
  };
}

test('planExit: hold when nothing triggers', () => {
  const p = planExit(longPos(), { price: 100.40 });
  assert.equal(p.action, 'hold');
  assert.equal(p.newStop, 99);
  assert.ok(p.reason.includes('HOLD'));
});

test('planExit: breakeven at breakevenR', () => {
  const p = planExit(longPos(), { price: 101.00 }); // exactly 1R
  assert.equal(p.action, 'breakeven');
  assert.equal(p.newStop, 100);
});

test('planExit: partial at target R', () => {
  const p = planExit(longPos(), { price: 101.60 }); // 1.6R tags 1.5R
  assert.equal(p.action, 'partial');
  assert.equal(p.target.r, 1.5);
  assert.ok(p.reason.includes('1.5R'));
});

test('planExit: already-taken partials are not re-fired', () => {
  const p = planExit(longPos({ partialsTaken: [1.5], breakevenAt: true }), { price: 101.60 });
  assert.equal(p.action, 'hold');
});

test('planExit: stop hit exits', () => {
  const p = planExit(longPos(), { price: 98.90 });
  assert.equal(p.action, 'exit');
  assert.ok(p.reason.includes('-1.10R'));
});

test('planExit: ATR trailing tightens the stop', () => {
  const p = planExit(longPos({ trailMode: 'atr', breakevenAt: true, partialsTaken: [1.5] }), { price: 102, atr: 0.5 });
  assert.equal(p.action, 'trail');
  assert.equal(p.newStop, 101.25); // 102 - 1.5*0.5
});

test('planExit: ATR trail never loosens the stop', () => {
  const p = planExit(longPos({ trailMode: 'atr', breakevenAt: true, partialsTaken: [1.5] }), { price: 100.10, atr: 0.5 });
  assert.equal(p.action, 'hold'); // candidate 99.35 < entry 100
});

test('planExit: VWAP trailing', () => {
  const p = planExit(longPos({ trailMode: 'vwap', breakevenAt: true, partialsTaken: [1.5] }), { price: 102, vwap: 101.50 });
  assert.equal(p.action, 'trail');
  assert.equal(p.newStop, 101.50);
});

test('planExit: OR-width projections fire partials', () => {
  const pos = longPos({
    targets: [{ r: 1.25, pct: 50, price: 101.50, type: 'or-width' }],
  });
  const p = planExit(pos, { price: 101.30 }); // 1.3R tags the 1.25R projection
  assert.equal(p.action, 'partial');
  assert.ok(p.reason.includes('OR-width'), p.reason);
});

test('planExit: short side mirrors long', () => {
  const pos = {
    direction: 'short', entry: 100, stop: 101,
    targets: [{ r: 1.5, pct: 100, price: 98.50, type: 'rr' }],
    breakevenR: 1, trailMode: 'none',
  };
  assert.equal(planExit(pos, { price: 99.70 }).action, 'hold'); // 0.3R
  const be = planExit(pos, { price: 99.00 }); // 1R
  assert.equal(be.action, 'breakeven');
  assert.equal(be.newStop, 100);
  assert.equal(planExit(pos, { price: 101.10 }).action, 'exit');
  const part = planExit(pos, { price: 98.40 }); // 1.6R
  assert.equal(part.action, 'partial');
});

test('planExit: missing data holds safely', () => {
  const p = planExit({}, {});
  assert.equal(p.action, 'hold');
});

test('planExit: let-winners-run profile — 25% at 2R only, runner rides the ATR trail', () => {
  // New factory exits (Johnny 2026-10-01): targets [{r:2,pct:25}],
  // trailMode 'atr', breakevenR 1. 1R = $1 (entry 100, stop 99).
  const pos = {
    direction: 'long', entry: 100, stop: 99,
    targets: [{ r: 2, pct: 25 }], partialsTaken: [], breakevenR: 1,
    trailMode: 'atr', trailAtrMult: 1.5,
  };
  // At +1.5R the only action is the breakeven move — no partial before 2R.
  const at15 = planExit(pos, { price: 101.50, atr: 0.40 });
  assert.equal(at15.action, 'breakeven');
  // At +2R exactly one partial fires, for exactly 25%.
  const at2 = planExit(pos, { price: 102.00, atr: 0.40 });
  assert.equal(at2.action, 'partial');
  assert.equal(at2.target.r, 2);
  assert.equal(at2.target.pct, 25);
  // At +3R (the OLD second target) nothing is sold: with the partial taken
  // and breakeven set, the runner only trails (103.50 − 1.5×0.40 = 102.90).
  const at3 = planExit({ ...pos, partialsTaken: [2], breakevenAt: true }, { price: 103.50, atr: 0.40 });
  assert.equal(at3.action, 'trail');
  assert.equal(at3.newStop, 102.90);
  // When volume/price fades into the trailed stop, the runner exits there.
  const faded = planExit(
    { ...pos, partialsTaken: [2], breakevenAt: true, stop: 102.90 },
    { price: 102.85, atr: 0.40 },
  );
  assert.equal(faded.action, 'exit');
});

// ---------------------------------------------------------------------------
// computeRsi + the maxRsiLong entry filter (Johnny 2026-10-01)
// ---------------------------------------------------------------------------
test('computeRsi: Wilder RSI values, edges, and uncomputable input', () => {
  // 15 closes → 14 changes: 11 gains of +1, 3 losses of −1 → RS 11/3 → 78.57.
  const up = [100, 101, 102, 101, 102, 103, 102, 103, 104, 105, 104, 105, 106, 107, 108];
  assert.ok(Math.abs(computeRsi(up) - 78.57) < 0.01, `got ${computeRsi(up)}`);
  // 10 gains, 4 losses → RS 2.5 → 71.43 (allowed under the 75 cap).
  const mixed = [100, 101, 100, 101, 102, 101, 102, 103, 102, 103, 104, 103, 104, 105, 106];
  assert.ok(Math.abs(computeRsi(mixed) - 71.43) < 0.01, `got ${computeRsi(mixed)}`);
  // Monotonic series pin the extremes; flat reads 50.
  assert.equal(computeRsi(Array.from({ length: 20 }, (_, i) => 100 + i)), 100);
  assert.equal(computeRsi(Array.from({ length: 20 }, (_, i) => 100 - i)), 0);
  assert.equal(computeRsi(Array.from({ length: 20 }, () => 100)), 50);
  // Fewer than 15 closes → null (filter skips, never blocks).
  assert.equal(computeRsi([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]), null);
  assert.equal(computeRsi([]), null);
  assert.equal(computeRsi(null), null);
});

// Strictly rising closes all morning → RSI(14) = 100 at the decision bar.
function risingCtx(overrides = {}) {
  const orPart = minuteBars('09:30', 15, (t, i) => {
    const c = 99.30 + i * 0.05;
    return {
      t, o: c - 0.02,
      h: i === 4 ? 100.50 : c + 0.10,
      l: i === 9 ? 99.50 : c - 0.10,
      c, v: 20000,
    };
  });
  const post = [
    bar('09:45', 100.03, 100.15, 99.98, 100.10, 22000),
    bar('09:46', 100.12, 100.25, 100.05, 100.20, 25000),
    bar('09:47', 100.65, 100.75, 100.64, 100.70, 60000), // breakout bar
    bar('09:48', 100.72, 100.82, 100.68, 100.78, 30000),
    bar('09:49', 100.80, 100.90, 100.76, 100.85, 28000),
    bar('09:50', 100.87, 100.95, 100.83, 100.90, 26000),
  ];
  const bars = orPart.concat(post);
  const { rules: ruleOverrides, ...rest } = overrides;
  return {
    symbol: 'AAPL', direction: 'long', bars,
    or: computeOpeningRange(bars, 15),
    vwap: 100.20, rvol: 2.5, avgVolume: 2000000, spreadPct: 0.10,
    relStrengthVsSpy: 0.8, regime: 'bullish', atr: 0.40,
    premarket: { trend: 'up', gapPct: 0.5 },
    levels: { priorHigh: 102.50, priorLow: 98.00 },
    lastAttempts: [], accountEquity: 25000, trendAligned: true,
    ...rest,
    rules: { triggerMode: 'scored', ...(ruleOverrides || {}) },
  };
}

test('evaluateEntry: RSI filter blocks an overbought long with rsi_overbought', () => {
  const res = evaluateEntry(risingCtx());
  assert.equal(res.decision, 'wait');
  assert.ok(res.rejectReasons.some(r => r.startsWith('rsi_overbought:')),
    `expected rsi_overbought, got: ${JSON.stringify(res.rejectReasons)}`);
});

test('evaluateEntry: RSI filter honors the cap, the disable switch, and longs-only', () => {
  // Canonical long runs RSI ≈ 64: allowed at the default 75 cap…
  assert.equal(evaluateEntry(goodLongCtx()).decision, 'enter-long');
  // …blocked when the cap is tightened below it, with the journal reason.
  expectReject(goodLongCtx({ rules: { maxRsiLong: 60 } }), 'rsi_overbought');
  // Disabled (0) lets even a RSI-100 grind enter.
  const off = evaluateEntry(risingCtx({ rules: { maxRsiLong: 0 } }));
  assert.equal(off.decision, 'enter-long', off.why);
  assert.ok(!off.rejectReasons.some(r => r.startsWith('rsi_overbought')));
  // Shorts are never touched by the rule, even with the cap at 1.
  const short = evaluateEntry(goodShortCtx({ rules: { maxRsiLong: 1 } }));
  assert.equal(short.decision, 'enter-short', short.why);
});

// ---------------------------------------------------------------------------
// checkDailyLocks
// ---------------------------------------------------------------------------
test('checkDailyLocks: clean day is not locked', () => {
  const r = checkDailyLocks(baseDayState());
  assert.equal(r.locked, false);
  assert.deepEqual(r.reasons, []);
});

test('checkDailyLocks: daily loss lock', () => {
  assert.equal(checkDailyLocks(baseDayState({ pnl: -200 })).locked, true);
  assert.ok(checkDailyLocks(baseDayState({ pnl: -200 })).reasons[0].startsWith('MAX_DAILY_LOSS'));
  assert.equal(checkDailyLocks(baseDayState({ pnl: -199.99 })).locked, false);
});

test('checkDailyLocks: max trades lock', () => {
  assert.ok(checkDailyLocks(baseDayState({ trades: 10 })).reasons[0].startsWith('MAX_TRADES_PER_DAY'));
  assert.equal(checkDailyLocks(baseDayState({ trades: 9 })).locked, false);
});

test('checkDailyLocks: consecutive losses lock', () => {
  assert.ok(checkDailyLocks(baseDayState({ consecLosses: 3 })).reasons[0].startsWith('MAX_CONSEC_LOSSES'));
  assert.equal(checkDailyLocks(baseDayState({ consecLosses: 2 })).locked, false);
});

test('checkDailyLocks: max positions lock', () => {
  assert.ok(checkDailyLocks(baseDayState({ openPositions: 3 })).reasons[0].startsWith('MAX_POSITIONS'));
});

test('checkDailyLocks: max exposure lock', () => {
  assert.ok(checkDailyLocks(baseDayState({ exposureDollars: 5000 })).reasons[0].startsWith('MAX_EXPOSURE'));
  assert.equal(checkDailyLocks(baseDayState({ exposureDollars: 4999.99 })).locked, false);
});

test('checkDailyLocks: per-symbol trade cap', () => {
  const r = checkDailyLocks(baseDayState({ tradesBySymbol: { AAPL: 2, MSFT: 1 } }));
  assert.equal(r.locked, true);
  assert.ok(r.reasons.some(x => x.includes('AAPL') && x.startsWith('MAX_TRADES_PER_SYMBOL')));
  assert.equal(checkDailyLocks(baseDayState({ tradesBySymbol: { AAPL: 1 } })).locked, false);
});

test('checkDailyLocks: locks never reset intraday — same state, same verdict', () => {
  const s = baseDayState({ pnl: -250, trades: 4 });
  const a = checkDailyLocks(s);
  const b = checkDailyLocks(s);
  assert.equal(a.locked, true);
  assert.deepEqual(a, b);
});

test('checkDailyLocks: multiple locks all reported', () => {
  const r = checkDailyLocks(baseDayState({ pnl: -300, trades: 10, consecLosses: 5 }));
  assert.equal(r.reasons.length, 3);
});

// ---------------------------------------------------------------------------
// recordTradeResult
// ---------------------------------------------------------------------------
test('recordTradeResult: pure immutable state transition', () => {
  const before = baseDayState();
  const after = recordTradeResult(before, { pnl: -50, symbol: 'AAPL' });
  assert.equal(after.pnl, -50);
  assert.equal(after.trades, 1);
  assert.equal(after.consecLosses, 1);
  assert.deepEqual(after.tradesBySymbol, { AAPL: 1 });
  // input untouched
  assert.equal(before.pnl, 0);
  assert.equal(before.trades, 0);
  assert.deepEqual(before.tradesBySymbol, {});

  const win = recordTradeResult(after, { pnl: 30, symbol: 'AAPL' });
  assert.equal(win.pnl, -20);
  assert.equal(win.trades, 2);
  assert.equal(win.consecLosses, 0); // winner resets the streak
  assert.deepEqual(win.tradesBySymbol, { AAPL: 2 });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------
test('validateConfig: defaults are valid', () => {
  const r = validateConfig(DEFAULT_ORB_RULES);
  assert.deepEqual(r, { ok: true, errors: [] });
  const partial = validateConfig({ minScore: 80 });
  assert.equal(partial.ok, true);
});

test('validateConfig: catches every class of misconfiguration', () => {
  const bad = validateConfig({
    orMinutes: 10,
    entryWindowStart: '12:00', entryWindowEnd: '11:30',
    minScore: 120,
    weights: { regime: 10, volume: 10, relStrength: 10, vwap: 10, breakoutQuality: 10, levelClearance: 10, trendAlign: 10, volatility: 10, premarket: 10 },
    minRvol: 3, preferredRvol: 2, strongRvol: 1,
    minPrice: 20, maxPrice: 1,
    allowLong: false, allowShort: false,
    entryMode: 'yolo',
    sizingMode: 'vibes',
    stopMode: 'hope',
    targets: [{ r: 1, pct: 60 }, { r: 2, pct: 60 }], // pct allocations sum to 120 > 100
    trailMode: 'moon',
    maxTradesPerDay: 0,
    maxWickPct: 150,
    newsPolicy: 'ignore',
    tradingMode: 'LIVE',
  });
  assert.equal(bad.ok, false);
  const fields = bad.errors.map(e => e.split(':')[0]);
  for (const f of ['orMinutes', 'entry window', 'minScore', 'weights', 'preferredRvol', 'maxPrice',
    'direction', 'entryMode', 'sizingMode', 'stopMode', 'targets', 'trailMode',
    'maxTradesPerDay', 'maxWickPct', 'newsPolicy', 'tradingMode']) {
    assert.ok(fields.includes(f), `missing error for ${f}: ${JSON.stringify(bad.errors)}`);
  }
});

test('validateConfig: LIVE requires both live switches', () => {
  assert.ok(validateConfig({ tradingMode: 'LIVE', liveEnabled: true, liveConfirmed: true }).ok);
  assert.ok(!validateConfig({ tradingMode: 'LIVE', liveEnabled: true }).ok);
});

// ---------------------------------------------------------------------------
// Determinism (backtest-relevant)
// ---------------------------------------------------------------------------
test('determinism: same input -> same output', () => {
  const a = JSON.stringify(evaluateEntry(goodLongCtx()));
  const b = JSON.stringify(evaluateEntry(goodLongCtx()));
  assert.equal(a, b);

  const sa = JSON.stringify(scoreSetup({ direction: 'long', regime: 'bullish', rvol: 2.5 }));
  const sb = JSON.stringify(scoreSetup({ direction: 'long', regime: 'bullish', rvol: 2.5 }));
  assert.equal(sa, sb);

  const oa = JSON.stringify(computeOpeningRange(orBars(), 15));
  const ob = JSON.stringify(computeOpeningRange(orBars(), 15));
  assert.equal(oa, ob);

  const pa = JSON.stringify(planExit(longPos(), { price: 101.60 }));
  const pb = JSON.stringify(planExit(longPos(), { price: 101.60 }));
  assert.equal(pa, pb);
});

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------
test('journal: TRADE_FIELDS match the spec list exactly', () => {
  assert.deepEqual([...TRADE_FIELDS], [
    'direction', 'entryTime', 'symbol', 'orHigh', 'orLow', 'orWidth', 'vwap',
    'rvol', 'atr', 'regime', 'score', 'scoreBreakdown', 'size', 'entryPrice',
    'stopPrice', 'targets', 'riskDollars', 'exitPrice', 'pnl', 'rMultiple',
    'entryReason', 'exitReason', 'rejectReasons', 'newsPolicy', 'createdAt', 'closedAt',
  ]);
  assert.ok(Object.isFrozen(TRADE_FIELDS));
});

test('journal: buildTradeRecord has exactly TRADE_FIELDS, nulls for missing, ignores extras', () => {
  const rec = buildTradeRecord({ symbol: 'AAPL', direction: 'long', bogus: 1 });
  assert.deepEqual(Object.keys(rec), [...TRADE_FIELDS]);
  assert.equal(rec.symbol, 'AAPL');
  assert.equal(rec.direction, 'long');
  assert.equal(rec.pnl, null);
  assert.ok(!('bogus' in rec));
  assert.deepEqual(Object.keys(buildTradeRecord()), [...TRADE_FIELDS]);
});

// ---------------------------------------------------------------------------
// Exported API surface (wave 2 builds against this)
// ---------------------------------------------------------------------------
test('engine exports the full wave-1 API', () => {
  const eng = require('../lib/orb/engine');
  for (const fn of ['computeOpeningRange', 'classifyRegime', 'scoreSetup', 'evaluateEntry',
    'planExit', 'sizePosition', 'checkDailyLocks', 'recordTradeResult', 'validateConfig']) {
    assert.equal(typeof eng[fn], 'function', fn);
  }
  assert.equal(typeof eng.DEFAULT_ORB_RULES, 'object');
});

// ---------------------------------------------------------------------------
// Watchlist parsing (engine-level, shared by paper / live / backtest).
// ---------------------------------------------------------------------------
test('parseWatchlist normalizes, uppercases, dedupes, drops empties', () => {
  assert.deepEqual(parseWatchlist({ watchlist: ' aaa, AAA ,, SOUN ' }), ['AAA', 'SOUN']);
});
test('parseWatchlist accepts an array and an empty/absent list', () => {
  assert.deepEqual(parseWatchlist({ watchlist: ['aaa', 'BBB'] }), ['AAA', 'BBB']);
  assert.deepEqual(parseWatchlist({ watchlist: '' }), []);
  assert.deepEqual(parseWatchlist({}), []);
  assert.deepEqual(parseWatchlist(null), []);
});
test('validateConfig accepts the default 87-symbol watchlist and rejects junk types', () => {
  const ok = validateConfig({ watchlist: DEFAULT_ORB_RULES.watchlist });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(parseWatchlist(DEFAULT_ORB_RULES).length, 87, 'default holds Johnny\'s 87');
  assert.ok(parseWatchlist(DEFAULT_ORB_RULES).includes('TSDD'), 'TSDD added 2026-10-08');
  const bad = validateConfig({ watchlist: 123 });
  assert.equal(bad.ok, false, 'numeric watchlist is invalid');
  assert.ok(bad.errors.some(e => e.startsWith('watchlist:')), 'error names the field');
});
