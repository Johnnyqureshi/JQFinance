'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_KIAAN_RULES,
  mergedKiaanRules,
  classifyRegime,
  evaluateSession,
  evaluateCandidate,
  checkDailyLocks,
  atr15OfBars,
  intradayExitGeometry,
  validateConfig,
} = require('../lib/kiaan/engine');

// ---------------------------------------------------------------------------
// Helpers: an ET timestamp inside the entry window (2026-10-08 is a
// Thursday, EDT). Market fixtures are plain injected context — the engine
// never fetches anything.
// ---------------------------------------------------------------------------
function etMs(dateStr, hm) {
  const [h, mi] = hm.split(':').map(Number);
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(`${dateStr}T12:00:00Z`)));
  const off = 12 - localHour;
  return Date.parse(`${dateStr}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00-${String(off).padStart(2, '0')}:00`);
}
const NOW = etMs('2026-10-08', '10:15');

const RISK_ON = {
  spy: { dayChangePct: 1.1, trend: 'up' },
  qqq: { dayChangePct: 1.4, trend: 'up' },
  vix: { level: 14, dayChangePct: -6 },
};
const RISK_OFF = {
  spy: { dayChangePct: -1.1, trend: 'down' },
  qqq: { dayChangePct: -1.3, trend: 'down' },
  vix: { level: 27, dayChangePct: 8 },
};
const CHOP = {
  spy: { dayChangePct: 0.15, trend: 'flat' },
  qqq: { dayChangePct: -0.1, trend: 'flat' },
  vix: { level: 17.5, dayChangePct: 1 },
};

const CLEAN_DAY = { openPositions: 0, tradesToday: 0, dailyPnlPct: 0.4, consecutiveLosses: 0 };
const ctxFor = market => ({ market, nowMs: NOW, dayState: { ...CLEAN_DAY }, accountEquity: 100000 });

// A textbook confirming long: broke its OR high, outperforming SPY,
// volume expanding, not extended. Entry 10.50, ATR stop -> 10.05.
const GOOD_LONG = {
  symbol: 'ACME', price: 10.50, dayChangePct: 3.6,
  vwap: 10.20, orHigh: 10.40, orLow: 9.90,
  brokeOrHigh: true, reclaimedVwap: false,
  rvol: 2.2, atr: 0.30, avgVolume: 2000000, spreadPct: 0.1,
};
// A confirming hedge ETF for a risk-off day (RS vs SPY = +4.5 pts).
const GOOD_HEDGE = {
  symbol: 'SQQQ', price: 12.30, dayChangePct: 3.4,
  vwap: 12.00, orHigh: 12.20, orLow: 11.60,
  brokeOrHigh: true, reclaimedVwap: false,
  rvol: 2.6, atr: 0.28, avgVolume: 30000000, spreadPct: 0.08,
};

const hasReason = (d, code) => (d.reasons || []).some(r => r.startsWith(`${code}:`));

// --- regime classification -------------------------------------------------

test('classifyRegime: risk-on / risk-off / chop from scored votes', () => {
  const on = classifyRegime(RISK_ON);
  assert.equal(on.regime, 'risk-on');
  assert.ok(on.score >= 3);
  assert.equal(on.tradable, true);

  const off = classifyRegime(RISK_OFF);
  assert.equal(off.regime, 'risk-off');
  assert.ok(off.score <= -3);
  assert.equal(off.tradable, true); // hedges may still trade

  const chop = classifyRegime(CHOP);
  assert.equal(chop.regime, 'chop');
  assert.equal(chop.tradable, false);
});

test('classifyRegime: VIX panic hard-forces risk-off even on a green tape', () => {
  const res = classifyRegime({
    spy: { dayChangePct: 1.2, trend: 'up' },
    qqq: { dayChangePct: 1.0, trend: 'up' },
    vix: { level: 38, dayChangePct: 20 },
  });
  assert.equal(res.regime, 'risk-off');
  assert.ok(res.reasons.some(r => r.startsWith('VIX_PANIC:')));
});

test('classifyRegime: optional breadth/oil/rates votes never break classification', () => {
  const res = classifyRegime({
    ...CHOP,
    breadth: { advancersPct: 35 },
    oil: { dayChangePct: 4.2 },
    rates: { tenYearChangeBps: 11 },
  });
  assert.equal(res.regime, 'risk-off'); // 0 -1 (breadth) -1 (oil) -1 (yields) = -3
  assert.ok(res.reasons.some(r => r.startsWith('OIL_SPIKE:')));
});

// --- the core regime gates ---------------------------------------------------

test('risk-off blocks ordinary longs, however good the setup', () => {
  const d = evaluateCandidate(ctxFor(RISK_OFF), { ...GOOD_LONG });
  assert.equal(d.decision, 'no-trade');
  assert.equal(d.regime, 'risk-off');
  assert.ok(hasReason(d, 'REGIME_RISK_OFF'));
  assert.equal(d.entry, null);
  assert.equal(d.size, null);
});

test('risk-off allows a confirming inverse ETF from the hedge list', () => {
  const d = evaluateCandidate(ctxFor(RISK_OFF), { ...GOOD_HEDGE });
  assert.equal(d.decision, 'enter-long');
  assert.equal(d.symbol, 'SQQQ');
  assert.equal(d.entry, 12.30);
  assert.equal(d.stop, 11.88); // 12.30 - 1.5 x 0.28
  assert.ok(d.size.shares > 0);
  assert.ok(hasReason(d, 'HEDGE_CONFIRM_PATH'));
});

test('risk-off: hedge list is exempt from the $20 maxPrice cap (diagnosis 2026-10-09 §5a)', () => {
  // SQQQ at Thursday 2026-10-08's stack-trigger price — above the cap
  // that made 4 of 6 hedges untradeable.
  const d = evaluateCandidate(ctxFor(RISK_OFF), {
    ...GOOD_HEDGE, price: 32.62, vwap: 32.00, orHigh: 32.20, orLow: 31.60, atr: 0.90,
  });
  assert.equal(d.decision, 'enter-long', `hedge over $20 must trade on confirmation, got ${JSON.stringify(d.reasons)}`);
  assert.equal(d.entry, 32.62);
  assert.ok(hasReason(d, 'HEDGE_PRICE_BAND_EXEMPT'));
  // The floor still applies to hedges.
  const floored = evaluateCandidate(ctxFor(RISK_OFF), { ...GOOD_HEDGE, price: 0.50 });
  assert.equal(floored.decision, 'no-trade');
  assert.ok(hasReason(floored, 'PRICE_BAND'));
});

test('the $20 maxPrice cap still binds ordinary longs', () => {
  // hedgeOnly off: this test pins the long-side band behavior (with the
  // mode on, the same candidate is refused earlier with HEDGE_ONLY_MODE).
  const d = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_LONG, price: 25.00, vwap: 24.50, orHigh: 24.80, orLow: 24.00,
  }, { hedgeOnly: false });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'PRICE_BAND'));
});

test('risk-off still blocks a hedge ETF that does not confirm', () => {
  const d = evaluateCandidate(ctxFor(RISK_OFF), { ...GOOD_HEDGE, rvol: 0.9 });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'WEAK_VOLUME'));
});

test('risk-on refuses to buy hedge ETFs long (no fighting the tape)', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_HEDGE, dayChangePct: 2.8 });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'REGIME_RISK_ON_HEDGE'));
});

test('chop means stand aside — for candidates and for the session', () => {
  const d = evaluateCandidate(ctxFor(CHOP), { ...GOOD_LONG });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'REGIME_CHOP'));

  const s = evaluateSession({ market: CHOP, dayState: { ...CLEAN_DAY } });
  assert.equal(s.regime, 'chop');
  assert.equal(s.stance, 'stand-aside');
  assert.ok(s.reasons.length > 0);
  assert.match(s.why, /stand aside/i);
});

// --- the happy path -----------------------------------------------------------

test('risk-on breakout with relative strength and volume passes end to end', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG }, { hedgeOnly: false });
  assert.equal(d.decision, 'enter-long');
  assert.equal(d.side, 'long');
  assert.equal(d.entry, 10.50);
  assert.equal(d.stop, 10.05); // 10.50 - 1.5 x 0.30 ATR
  assert.deepEqual(d.targets.map(t => t.price), [11.40, 11.85]); // 2R, 3R
  assert.equal(d.rr, 2);
  assert.equal(d.size.shares, 47); // floor($500 / $10.50)
  assert.equal(d.size.notional, 493.5);
  assert.equal(d.size.riskDollars, 21.15); // 47 x $0.45
  assert.ok(hasReason(d, 'STRUCTURE_BREAK'));
  assert.ok(hasReason(d, 'RS_OK'));
  assert.ok(hasReason(d, 'VOLUME_OK'));
});

test('VWAP reclaim is an accepted structure when there is no OR break', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_LONG, brokeOrHigh: false, reclaimedVwap: true, price: 10.32, vwap: 10.20,
  }, { hedgeOnly: false });
  assert.equal(d.decision, 'enter-long');
  assert.ok(hasReason(d, 'STRUCTURE_RECLAIM'));
});

test('weak relative strength and missing structure are each rejected plainly', () => {
  const weak = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, dayChangePct: 1.3 }, { hedgeOnly: false }); // RS +0.2
  assert.equal(weak.decision, 'no-trade');
  assert.ok(hasReason(weak, 'WEAK_RS'));

  const noStruct = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, brokeOrHigh: false, price: 10.10 }, { hedgeOnly: false });
  assert.equal(noStruct.decision, 'no-trade');
  assert.ok(hasReason(noStruct, 'NO_STRUCTURE'));
});

// --- anti-chase -----------------------------------------------------------------

test('anti-chase rejects a name already extended past the trigger', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_LONG, price: 11.30, dayChangePct: 5.5, vwap: 10.60, rvol: 2.5,
  }, { hedgeOnly: false }); // (11.30 - 10.40) / 0.30 = 3.0 ATR beyond the OR high > 2 ATR cap
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'CHASE_EXTENDED'));
});

test('anti-chase rejects a name already up more than the day-gain cap', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_LONG, dayChangePct: 24, relStrengthPct: 22.9, price: 10.55,
  }, { hedgeOnly: false });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'CHASE_DAY_GAIN'));
});

// --- fail closed ------------------------------------------------------------------

test('missing market context fails closed: unknown regime, no trade', () => {
  const cls = classifyRegime({});
  assert.equal(cls.regime, 'unknown');
  assert.equal(cls.tradable, false);
  assert.ok(cls.reasons.some(r => r.startsWith('CONTEXT_MISSING:')));

  const d = evaluateCandidate({ market: {}, nowMs: NOW, dayState: { ...CLEAN_DAY } }, { ...GOOD_LONG });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'REGIME_UNKNOWN'));
});

test('missing candidate data fails closed (ATR, spread, volume)', () => {
  const noAtr = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, atr: null }, { hedgeOnly: false });
  assert.equal(noAtr.decision, 'no-trade');
  assert.ok(hasReason(noAtr, 'ATR_MISSING'));

  const noSpread = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, spreadPct: null }, { hedgeOnly: false });
  assert.equal(noSpread.decision, 'no-trade');
  assert.ok(hasReason(noSpread, 'SPREAD_UNKNOWN'));
});

// --- daily locks --------------------------------------------------------------------

test('daily locks halt everything: loss limit, loss streak, position cap', () => {
  const halted = evaluateCandidate(
    { market: RISK_ON, nowMs: NOW, dayState: { ...CLEAN_DAY, dailyPnlPct: -2.4 } },
    { ...GOOD_LONG },
  );
  assert.equal(halted.decision, 'no-trade');
  assert.ok(hasReason(halted, 'DAILY_LOSS_HALT'));
  assert.ok(hasReason(halted, 'DAY_LOCKED'));

  assert.equal(checkDailyLocks({ consecutiveLosses: 3 }).locked, true);
  assert.equal(checkDailyLocks({ openPositions: 3 }).locked, true);
  assert.equal(checkDailyLocks({ ...CLEAN_DAY }).locked, false);

  const s = evaluateSession({ market: RISK_ON, dayState: { ...CLEAN_DAY, dailyPnlPct: -3 } });
  assert.equal(s.stance, 'stand-aside');
  assert.equal(s.locked, true);
});

// --- journal completeness ---------------------------------------------------------------

test('every decision carries journal-ready explanation fields', () => {
  const scenarios = [
    evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG }, { hedgeOnly: false }), // enter
    evaluateCandidate(ctxFor(RISK_OFF), { ...GOOD_LONG }), // regime block
    evaluateCandidate(ctxFor(CHOP), { ...GOOD_LONG }), // chop
    evaluateCandidate({ market: {}, nowMs: NOW, dayState: {} }, { ...GOOD_LONG }), // unknown
    evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, price: 11.30, dayChangePct: 5.5, vwap: 10.60 }, { hedgeOnly: false }), // chase
  ];
  for (const d of scenarios) {
    assert.ok(d.decision === 'enter-long' || d.decision === 'no-trade');
    assert.equal(typeof d.symbol, 'string');
    assert.equal(typeof d.regime, 'string');
    assert.ok(Array.isArray(d.reasons) && d.reasons.length > 0, 'reasons present');
    assert.ok(d.reasons.every(r => typeof r === 'string' && r.includes(': ')), 'reasons are CODE: detail strings');
    assert.equal(typeof d.why, 'string');
    assert.ok(d.why.length > 10, 'why is a real explanation');
    if (d.decision === 'enter-long') {
      assert.ok(Number.isFinite(d.entry) && Number.isFinite(d.stop) && d.stop < d.entry);
      assert.ok(Array.isArray(d.targets) && d.targets.length > 0);
      assert.ok(d.size && d.size.shares > 0);
    } else {
      assert.equal(d.entry, null);
      assert.equal(d.targets, null);
      assert.equal(d.size, null);
    }
  }
});

// --- paper-only & config -----------------------------------------------------------------

test('paper-only is forced: no override can move the bot toward live', () => {
  const r = mergedKiaanRules({ tradingMode: 'LIVE', liveEnabled: true, liveConfirmed: true });
  assert.equal(r.tradingMode, 'PAPER');
  assert.equal(DEFAULT_KIAAN_RULES.tradingMode, 'PAPER');
});

test('validateConfig accepts the defaults and rejects nonsense', () => {
  assert.deepEqual(validateConfig({}), { ok: true, errors: [] });
  const bad = validateConfig({ maxPositions: 0, atrStopMult: -1 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.startsWith('maxPositions:')));
  assert.ok(bad.errors.some(e => e.startsWith('atrStopMult:')));
});

// --- regime reach ±2 + real breadth vote (2026-10-10) -------------------------
// A market whose scored votes sum to exactly +1 before breadth: SPY trend
// up (+1), everything else inside its band.
const PLUS_ONE = {
  spy: { dayChangePct: 0.2, trend: 'up' },
  qqq: { dayChangePct: 0.1, trend: 'flat' },
  vix: { level: 17.5, dayChangePct: 1 },
};
const MINUS_ONE = {
  spy: { dayChangePct: -0.2, trend: 'down' },
  qqq: { dayChangePct: -0.1, trend: 'flat' },
  vix: { level: 17.5, dayChangePct: 1 },
};

test('regime defaults: the bar is ±2 (was ±3)', () => {
  assert.equal(DEFAULT_KIAAN_RULES.riskOnScore, 2);
  assert.equal(DEFAULT_KIAAN_RULES.riskOffScore, -2);
  // Rules set back to ±3 restore the old reach exactly.
  const on = classifyRegime(PLUS_ONE, { riskOnScore: 3, riskOffScore: -3 });
  assert.equal(on.regime, 'chop');
});

test('breadth vote moves a +1 day to risk-on at the new ±2 bar', () => {
  const bare = classifyRegime(PLUS_ONE);
  assert.equal(bare.score, 1);
  assert.equal(bare.regime, 'chop'); // +1 alone still does not reach ±2
  const withBreadth = classifyRegime({ ...PLUS_ONE, breadth: { advancersPct: 65 } });
  assert.equal(withBreadth.score, 2);
  assert.equal(withBreadth.regime, 'risk-on');
  assert.equal(withBreadth.tradable, true);
  assert.equal(withBreadth.inputs.breadthAdvancersPct, 65);
  assert.ok(withBreadth.reasons.some(r => r.startsWith('BREADTH_STRONG:')));
  // And the session/candidate gates follow the classification.
  // (hedgeOnly off: with the 2026-10-11 default ON, a risk-on day is
  // stand-aside by design — covered in the hedge-only block below.)
  const s = evaluateSession({ market: { ...PLUS_ONE, breadth: { advancersPct: 65 } }, dayState: { ...CLEAN_DAY } }, { hedgeOnly: false });
  assert.equal(s.stance, 'seek-longs');
  const d = evaluateCandidate(
    ctxFor({ ...PLUS_ONE, breadth: { advancersPct: 65 } }), { ...GOOD_LONG }, { hedgeOnly: false });
  assert.equal(d.decision, 'enter-long');
});

test('breadth vote moves a −1 day to risk-off at the new ±2 bar', () => {
  const bare = classifyRegime(MINUS_ONE);
  assert.equal(bare.score, -1);
  assert.equal(bare.regime, 'chop');
  const withBreadth = classifyRegime({ ...MINUS_ONE, breadth: { advancersPct: 35 } });
  assert.equal(withBreadth.score, -2);
  assert.equal(withBreadth.regime, 'risk-off');
  assert.ok(withBreadth.reasons.some(r => r.startsWith('BREADTH_WEAK:')));
});

test('missing breadth leaves classification working (vote 0, never unknown)', () => {
  const res = classifyRegime({ ...PLUS_ONE, breadth: undefined });
  assert.equal(res.score, 1);
  assert.equal(res.regime, 'chop');
  assert.equal(res.inputs.breadthAdvancersPct, null);
  assert.ok(!res.reasons.some(r => r.startsWith('CONTEXT_MISSING:')));
  const on = classifyRegime(RISK_ON); // no breadth key at all
  assert.equal(on.regime, 'risk-on');
  // A mixed breadth (between 40 and 60) also votes 0 and is journaled.
  const mixed = classifyRegime({ ...PLUS_ONE, breadth: { advancersPct: 50 } });
  assert.equal(mixed.score, 1);
  assert.ok(mixed.reasons.some(r => r.startsWith('BREADTH_MIXED:')));
});

test('hard overrides still force risk-off at the new bar', () => {
  const panic = classifyRegime({
    spy: { dayChangePct: 1.2, trend: 'up' },
    qqq: { dayChangePct: 1.0, trend: 'up' },
    vix: { level: 38, dayChangePct: 20 },
    breadth: { advancersPct: 90 },
  });
  assert.equal(panic.regime, 'risk-off');
  assert.ok(panic.reasons.some(r => r.startsWith('VIX_PANIC:')));
  const hardDown = classifyRegime({
    spy: { dayChangePct: -1.6, trend: 'down' },
    qqq: { dayChangePct: -1.7, trend: 'down' },
    vix: { level: 18, dayChangePct: 0 },
    breadth: { advancersPct: 90 },
  });
  assert.equal(hardDown.regime, 'risk-off');
  assert.ok(hardDown.reasons.some(r => r.startsWith('INDEXES_HARD_DOWN:')));
});

// --- relief-bounce guard (Johnny, approved 2026-10-11) ----------------------
// The score tape is RISK_ON (+6), but BOTH absolute levels are still
// blocked: 10Y 5.24% ≥ guardYieldMin 5.15% and Brent $104.72 ≥
// guardBrentMin $100. The regime still computes risk-on; the guard is a
// stance layer that makes the day hedge-only.
const GUARD_DAY = {
  spy: { dayChangePct: 1.1, trend: 'up' },
  qqq: { dayChangePct: 1.4, trend: 'up' },
  vix: { level: 14, dayChangePct: -6 },
  rates: { tenYearChangeBps: 2, tenYearLevel: 5.24 },
  oil: { dayChangePct: 0.8, brentLevel: 104.72 },
};

test('relief-bounce guard: thresholds ship as named rule defaults', () => {
  assert.equal(DEFAULT_KIAAN_RULES.guardYieldMin, 5.15);
  assert.equal(DEFAULT_KIAAN_RULES.guardBrentMin, 100);
});

test('relief-bounce guard: both levels blocked on a risk-on score → hedge-only day', () => {
  const cls = classifyRegime(GUARD_DAY);
  assert.equal(cls.regime, 'risk-on'); // score/regime computation untouched
  assert.ok(cls.score >= 2);
  assert.equal(cls.guardActive, true);
  assert.equal(cls.guard.tenYearLevel, 5.24);
  assert.equal(cls.guard.brentLevel, 104.72);
  assert.equal(cls.inputs.tenYearLevel, 5.24);
  assert.equal(cls.inputs.brentLevel, 104.72);
  assert.ok(hasReason(cls, 'RELIEF_BOUNCE_GUARD'));

  const s = evaluateSession({ market: GUARD_DAY, dayState: { ...CLEAN_DAY } });
  assert.equal(s.stance, 'seek-hedges');
  assert.equal(s.guardActive, true);
  assert.ok(hasReason(s, 'HEDGES_ONLY_GUARD'));
  assert.match(s.why, /relief-bounce guard/);

  // Ordinary longs are refused with the guard reason, levels included.
  const long = evaluateCandidate(ctxFor(GUARD_DAY), { ...GOOD_LONG });
  assert.equal(long.decision, 'no-trade');
  assert.ok(hasReason(long, 'RELIEF_BOUNCE_GUARD'));
  assert.match(long.reasons.find(r => r.startsWith('RELIEF_BOUNCE_GUARD:')), /5\.24/);
  assert.match(long.reasons.find(r => r.startsWith('RELIEF_BOUNCE_GUARD:')), /104\.72/);

  // A hedge-list name passing the full confirmation stack may trade.
  const hedge = evaluateCandidate(ctxFor(GUARD_DAY), { ...GOOD_HEDGE });
  assert.equal(hedge.decision, 'enter-long');
  assert.equal(hedge.guardActive, true);
  assert.ok(hasReason(hedge, 'HEDGE_CONFIRM_PATH'));
  assert.match(hedge.why, /relief-bounce guard day/);
});

test('relief-bounce guard: a hedge failing any stack leg on a guard day is still refused', () => {
  const weakVol = evaluateCandidate(ctxFor(GUARD_DAY), { ...GOOD_HEDGE, rvol: 1.0 });
  assert.equal(weakVol.decision, 'no-trade');
  assert.ok(hasReason(weakVol, 'WEAK_VOLUME'));
  const weakRs = evaluateCandidate(ctxFor(GUARD_DAY), { ...GOOD_HEDGE, relStrengthPct: 0.2 });
  assert.equal(weakRs.decision, 'no-trade');
  assert.ok(hasReason(weakRs, 'WEAK_RS'));
});

test('relief-bounce guard: only one level blocked → normal risk-on, longs allowed', () => {
  const brentClear = { ...GUARD_DAY, oil: { dayChangePct: 0.8, brentLevel: 95 } };
  const clsB = classifyRegime(brentClear);
  assert.equal(clsB.regime, 'risk-on');
  assert.equal(clsB.guardActive, false);
  assert.ok(!hasReason(clsB, 'RELIEF_BOUNCE_GUARD'));
  const yieldClear = { ...GUARD_DAY, rates: { tenYearChangeBps: 2, tenYearLevel: 5.10 } };
  assert.equal(classifyRegime(yieldClear).guardActive, false);

  const s = evaluateSession({ market: brentClear, dayState: { ...CLEAN_DAY } }, { hedgeOnly: false });
  assert.equal(s.stance, 'seek-longs');
  const long = evaluateCandidate(ctxFor(brentClear), { ...GOOD_LONG }, { hedgeOnly: false });
  assert.equal(long.decision, 'enter-long');
  const hedge = evaluateCandidate(ctxFor(brentClear), { ...GOOD_HEDGE });
  assert.equal(hedge.decision, 'no-trade');
  assert.ok(hasReason(hedge, 'REGIME_RISK_ON_HEDGE'));
});

test('relief-bounce guard: missing Brent or missing yield level → guard unevaluated, day unchanged', () => {
  const noBrent = { ...GUARD_DAY, oil: { dayChangePct: 0.8 } };
  const cls = classifyRegime(noBrent);
  assert.equal(cls.regime, 'risk-on');
  assert.equal(cls.guardActive, false);
  assert.ok(hasReason(cls, 'RELIEF_BOUNCE_GUARD_UNEVALUATED'));
  assert.match(cls.reasons.find(r => r.startsWith('RELIEF_BOUNCE_GUARD_UNEVALUATED:')), /Brent/);
  assert.equal(evaluateCandidate(ctxFor(noBrent), { ...GOOD_LONG }, { hedgeOnly: false }).decision, 'enter-long');

  const noYield = { ...GUARD_DAY, rates: { tenYearChangeBps: 2 } };
  const clsY = classifyRegime(noYield);
  assert.equal(clsY.guardActive, false);
  assert.ok(hasReason(clsY, 'RELIEF_BOUNCE_GUARD_UNEVALUATED'));
  assert.match(clsY.reasons.find(r => r.startsWith('RELIEF_BOUNCE_GUARD_UNEVALUATED:')), /10Y/);
  assert.equal(evaluateCandidate(ctxFor(noYield), { ...GOOD_LONG }, { hedgeOnly: false }).decision, 'enter-long');
});

test('relief-bounce guard: a true risk-off day is untouched (score ≤ −2 still risk-off)', () => {
  const off = {
    ...RISK_OFF,
    rates: { tenYearChangeBps: 5, tenYearLevel: 5.30 },
    oil: { dayChangePct: 1.2, brentLevel: 105 },
  };
  const cls = classifyRegime(off);
  assert.equal(cls.regime, 'risk-off');
  assert.equal(cls.guardActive, false);
  const s = evaluateSession({ market: off, dayState: { ...CLEAN_DAY } });
  assert.equal(s.stance, 'seek-hedges');
  assert.ok(hasReason(s, 'HEDGES_ONLY'));
  assert.ok(!hasReason(s, 'HEDGES_ONLY_GUARD'));
  assert.equal(evaluateCandidate(ctxFor(off), { ...GOOD_HEDGE }).decision, 'enter-long');
});

test('relief-bounce guard: true chop stays stand-aside — the guard opens no hedges there', () => {
  const chop = {
    ...CHOP,
    rates: { tenYearChangeBps: 1, tenYearLevel: 5.24 },
    oil: { dayChangePct: 0.5, brentLevel: 104.72 },
  };
  const cls = classifyRegime(chop);
  assert.equal(cls.regime, 'chop');
  assert.equal(cls.guardActive, false);
  const s = evaluateSession({ market: chop, dayState: { ...CLEAN_DAY } });
  assert.equal(s.stance, 'stand-aside');
  const hedge = evaluateCandidate(ctxFor(chop), { ...GOOD_HEDGE });
  assert.equal(hedge.decision, 'no-trade');
  assert.ok(hasReason(hedge, 'REGIME_CHOP'));
});

test('relief-bounce guard: hard overrides are unaffected by blocked levels', () => {
  const panic = classifyRegime({
    spy: { dayChangePct: 1.2, trend: 'up' },
    qqq: { dayChangePct: 1.0, trend: 'up' },
    vix: { level: 38, dayChangePct: 20 },
    rates: { tenYearChangeBps: 3, tenYearLevel: 5.30 },
    oil: { dayChangePct: 1.0, brentLevel: 106 },
  });
  assert.equal(panic.regime, 'risk-off');
  assert.equal(panic.guardActive, false);
  assert.ok(hasReason(panic, 'VIX_PANIC'));
  const hardDown = classifyRegime({
    spy: { dayChangePct: -1.6, trend: 'down' },
    qqq: { dayChangePct: -1.7, trend: 'down' },
    vix: { level: 18, dayChangePct: 0 },
    rates: { tenYearChangeBps: 3, tenYearLevel: 5.30 },
    oil: { dayChangePct: 1.0, brentLevel: 106 },
  });
  assert.equal(hardDown.regime, 'risk-off');
  assert.equal(hardDown.guardActive, false);
  assert.ok(hasReason(hardDown, 'INDEXES_HARD_DOWN'));
});

test('relief-bounce guard: thresholds are rules — raising them disarms the guard', () => {
  assert.equal(classifyRegime(GUARD_DAY, { guardYieldMin: 5.30 }).guardActive, false);
  assert.equal(classifyRegime(GUARD_DAY, { guardBrentMin: 110 }).guardActive, false);
  assert.equal(classifyRegime(GUARD_DAY, { guardYieldMin: 5.20, guardBrentMin: 104 }).guardActive, true);
});

// --- hedge-only mode + intraday exit geometry (2026-10-11 rebuild) ----------
// Strategy-lab Test 3 is the design now shipped: hedge-only entries +
// 15m-ATR managed geometry. The lab numbers: 19 trades, +$10.72,
// expectancy +$0.56, 4.29 profitable/week — vs −$120.23 for the full
// design and −$49.91 for exit-repair alone.

test('hedge-only rebuild: the shipped defaults are hedgeOnly ON and exitAtrTimeframe 15m', () => {
  assert.equal(DEFAULT_KIAAN_RULES.hedgeOnly, true);
  assert.equal(DEFAULT_KIAAN_RULES.exitAtrTimeframe, '15m');
  assert.equal(mergedKiaanRules({}).hedgeOnly, true);
  assert.equal(mergedKiaanRules({ hedgeOnly: false }).hedgeOnly, false);
  assert.equal(mergedKiaanRules({ hedgeOnly: true }).hedgeOnly, true);
  assert.equal(mergedKiaanRules({}).exitAtrTimeframe, '15m');
  assert.equal(mergedKiaanRules({ exitAtrTimeframe: 'daily' }).exitAtrTimeframe, 'daily');
  const bad = validateConfig({ exitAtrTimeframe: '1h' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.startsWith('exitAtrTimeframe:')));
});

test('hedge-only ON: a passing ordinary long NOT on the long universe is refused on a risk-on day (LONG_NOT_IN_UNIVERSE)', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG }); // ACME is not on the 87-name list
  assert.equal(d.decision, 'no-trade');
  assert.equal(d.hedgeOnly, true);
  assert.equal(d.inLongUniverse, false);
  assert.ok(hasReason(d, 'LONG_NOT_IN_UNIVERSE'));
  assert.equal(d.entry, null);
  assert.equal(d.size, null);

  // The session explains the day: risk-on score, longs sought ONLY in
  // the long universe (2026-10-12 expansion).
  const s = evaluateSession({ market: RISK_ON, dayState: { ...CLEAN_DAY } });
  assert.equal(s.regime, 'risk-on');
  assert.equal(s.stance, 'seek-longs');
  assert.equal(s.hedgeOnly, true);
  assert.equal(s.longUniverseSize, 87);
  assert.ok(hasReason(s, 'HEDGE_ONLY_MODE'));
  assert.ok(hasReason(s, 'LONG_UNIVERSE_MODE'));
  assert.match(s.why, /long universe/);
});

test('pure hedge-only restored: an EMPTY longUniverse stands aside on risk-on and refuses with HEDGE_ONLY_MODE', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG }, { longUniverse: '' });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'HEDGE_ONLY_MODE'));
  const uni = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, symbol: 'SOC' }, { longUniverse: '' });
  assert.equal(uni.decision, 'no-trade');
  assert.ok(hasReason(uni, 'HEDGE_ONLY_MODE'));
  const s = evaluateSession({ market: RISK_ON, dayState: { ...CLEAN_DAY } }, { longUniverse: '' });
  assert.equal(s.stance, 'stand-aside');
  assert.equal(s.longUniverseSize, 0);
  assert.match(s.why, /hedge-only mode is ON/);
});

test('hedge-only ON: hedges still enter on risk-off days and on guard days', () => {
  const off = evaluateCandidate(ctxFor(RISK_OFF), { ...GOOD_HEDGE });
  assert.equal(off.decision, 'enter-long');
  const guard = evaluateCandidate(ctxFor(GUARD_DAY), { ...GOOD_HEDGE });
  assert.equal(guard.decision, 'enter-long');
  const s = evaluateSession({ market: RISK_OFF, dayState: { ...CLEAN_DAY } });
  assert.equal(s.stance, 'seek-hedges');
  assert.ok(hasReason(s, 'HEDGE_ONLY_MODE'));
  assert.ok(hasReason(s, 'HEDGES_ONLY'));
  // Chop still stands aside entirely — hedge-only opens nothing there.
  const chop = evaluateCandidate(ctxFor(CHOP), { ...GOOD_HEDGE });
  assert.equal(chop.decision, 'no-trade');
  assert.ok(hasReason(chop, 'REGIME_CHOP'));
});

test('hedgeOnly:false restores the previous long-side behavior exactly', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG }, { hedgeOnly: false });
  assert.equal(d.decision, 'enter-long');
  assert.equal(d.hedgeOnly, false);
  assert.equal(d.entry, 10.50);
  assert.equal(d.stop, 10.05); // the pre-rebuild daily-ATR geometry
  assert.deepEqual(d.targets.map(t => t.price), [11.40, 11.85]);
  assert.equal(d.size.shares, 47);
  const s = evaluateSession({ market: RISK_ON, dayState: { ...CLEAN_DAY } }, { hedgeOnly: false });
  assert.equal(s.stance, 'seek-longs');
  assert.ok(!hasReason(s, 'HEDGE_ONLY_MODE'));
});

// 15m bar series with binary-exact arithmetic: closes step +0.25,
// h = c + 0.5, l = c − 0.5 → every TR is exactly max(1.0, 0.75, 0.25)
// = 1.0, so ATR(14) on 15m bars is exactly 1.0.
function bars15Exact({ days = ['2026-10-06', '2026-10-07'], perDay = 26, startClose = 10 } = {}) {
  const bars = [];
  let close = startClose;
  for (const day of days) {
    const base = etMs(day, '09:30');
    for (let i = 0; i < perDay; i++) {
      close += 0.25;
      bars.push({ t: base + i * 15 * 60000, o: close, h: close + 0.5, l: close - 0.5, c: close, v: 1000 });
    }
  }
  return bars;
}

test('atr15OfBars: ATR(14) over completed regular-session 15m bars only', () => {
  const bars = bars15Exact();
  const afterClose = etMs('2026-10-07', '16:00');
  assert.equal(atr15OfBars(bars, afterClose), 1.0);
  // A still-forming bar (ends after the decision time) with wild values
  // must not move the ATR.
  const forming = { t: etMs('2026-10-08', '09:30'), o: 50, h: 500, l: 1, c: 50, v: 1 };
  assert.equal(atr15OfBars([...bars, forming], etMs('2026-10-08', '09:40')), 1.0);
  // A premarket bar is outside the regular-session series entirely.
  const premarket = { t: etMs('2026-10-07', '08:00'), o: 50, h: 500, l: 1, c: 50, v: 1 };
  assert.equal(atr15OfBars([premarket, ...bars], afterClose), 1.0);
  // Fewer than 15 completed bars (< 14 TRs) → null (the fallback case).
  assert.equal(atr15OfBars(bars15Exact({ days: ['2026-10-07'], perDay: 14 }), afterClose), null);
  assert.equal(atr15OfBars([], afterClose), null);
  assert.equal(atr15OfBars(bars, null), null);
});

test('intradayExitGeometry: stop/targets equal entry ∓ 1.5×ATR15 / +2R / +3R', () => {
  const g = intradayExitGeometry({ entry: 20, atr15: 1, rules: {} });
  assert.equal(g.stop, 18.5); // 20 − 1.5 × 1.0
  assert.equal(g.risk, 1.5);
  assert.deepEqual(g.targets, [
    { r: 2, pct: 50, price: 23 }, // +2R
    { r: 3, pct: 50, price: 24.5 }, // +3R
  ]);
  assert.equal(g.atr15, 1);
  // The rules' own target tranches and stop multiplier are honored.
  const custom = intradayExitGeometry({ entry: 20, atr15: 1, rules: { atrStopMult: 2, targets: [{ r: 1.5, pct: 100 }] } });
  assert.equal(custom.stop, 18);
  assert.deepEqual(custom.targets, [{ r: 1.5, pct: 100, price: 23 }]);
  // Unusable inputs produce no geometry — the caller falls back to daily.
  assert.equal(intradayExitGeometry({ entry: 20, atr15: null, rules: {} }), null);
  assert.equal(intradayExitGeometry({ entry: 20, atr15: 0, rules: {} }), null);
  assert.equal(intradayExitGeometry({ entry: 0.1, atr15: 1, rules: {} }), null); // stop would be ≤ 0
});

// --- long-universe expansion (Johnny 2026-10-12: "the same ones as ORB") ----
// SOC is on ORB's 87-name watchlist and is NOT a hedge-list symbol.
const GOOD_UNIVERSE = { ...GOOD_LONG, symbol: 'SOC' };

test('longUniverse default is exactly ORB\'s 87-name watchlist, verbatim', () => {
  const { DEFAULT_ORB_RULES, parseWatchlist } = require('../lib/orb/engine');
  const orbList = parseWatchlist(DEFAULT_ORB_RULES);
  assert.equal(orbList.length, 87);
  const kiaanList = mergedKiaanRules({}).longUniverse.split(',').filter(Boolean);
  assert.deepEqual(kiaanList, orbList);
  assert.equal(mergedKiaanRules({}).longUniverse, DEFAULT_KIAAN_RULES.longUniverse);
  // The hedge list is unchanged by the expansion.
  assert.equal(mergedKiaanRules({}).hedgeSymbols, 'SQQQ,SPXS,TSDD,SOXS,TECS,LABD');
});

test('risk-on + watchlist symbol enters through the full confirmation stack (default rules)', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_UNIVERSE });
  assert.equal(d.decision, 'enter-long', JSON.stringify(d.reasons));
  assert.equal(d.inLongUniverse, true);
  assert.equal(d.entry, 10.50);
  assert.equal(d.stop, 10.05);
  assert.ok(hasReason(d, 'LONG_UNIVERSE_OK'));
  assert.ok(hasReason(d, 'STRUCTURE_BREAK'));
  assert.ok(hasReason(d, 'RS_OK'));
  assert.ok(hasReason(d, 'VOLUME_OK'));
});

test('guard day + watchlist symbol is refused — guard days stay hedge-only', () => {
  const d = evaluateCandidate(ctxFor(GUARD_DAY), { ...GOOD_UNIVERSE });
  assert.equal(d.decision, 'no-trade');
  assert.equal(d.inLongUniverse, true);
  assert.ok(hasReason(d, 'RELIEF_BOUNCE_GUARD'));
  const s = evaluateSession({ market: GUARD_DAY, dayState: { ...CLEAN_DAY } });
  assert.equal(s.stance, 'seek-hedges');
});

test('risk-off + watchlist symbol is refused — wrong stance, distinct code', () => {
  const d = evaluateCandidate(ctxFor(RISK_OFF), { ...GOOD_UNIVERSE });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'REGIME_RISK_OFF'));
  assert.ok(!hasReason(d, 'LONG_NOT_IN_UNIVERSE'));
  assert.ok(!hasReason(d, 'RELIEF_BOUNCE_GUARD'));
});

test('chop + watchlist symbol still stands aside', () => {
  const d = evaluateCandidate(ctxFor(CHOP), { ...GOOD_UNIVERSE });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'REGIME_CHOP'));
});

test('watchlist name above $20 is cap-exempt and evaluable, but a failing confirmation gate still blocks it', () => {
  const weak = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_UNIVERSE, price: 32.50, vwap: 32.00, orHigh: 32.20, orLow: 31.60, atr: 0.90, rvol: 0.9,
  });
  assert.equal(weak.decision, 'no-trade');
  assert.ok(hasReason(weak, 'WEAK_VOLUME'), JSON.stringify(weak.reasons));
  assert.ok(!hasReason(weak, 'PRICE_BAND'));
  // The same name with the full stack passing enters above $20.
  const strong = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_UNIVERSE, price: 32.50, vwap: 32.00, orHigh: 32.20, orLow: 31.60, atr: 0.90,
  });
  assert.equal(strong.decision, 'enter-long', JSON.stringify(strong.reasons));
  assert.equal(strong.entry, 32.50);
  assert.ok(hasReason(strong, 'LONG_UNIVERSE_PRICE_BAND_EXEMPT'));
});

test('a symbol on BOTH lists (SQQQ) is a hedge first: risk-on still refuses it', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_HEDGE, dayChangePct: 2.8 });
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'REGIME_RISK_ON_HEDGE'));
  assert.ok(!hasReason(d, 'LONG_UNIVERSE_OK'));
});
