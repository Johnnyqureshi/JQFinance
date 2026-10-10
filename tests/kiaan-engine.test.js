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
  const d = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_LONG, price: 25.00, vwap: 24.50, orHigh: 24.80, orLow: 24.00,
  });
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
  const d = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG });
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
  });
  assert.equal(d.decision, 'enter-long');
  assert.ok(hasReason(d, 'STRUCTURE_RECLAIM'));
});

test('weak relative strength and missing structure are each rejected plainly', () => {
  const weak = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, dayChangePct: 1.3 }); // RS +0.2
  assert.equal(weak.decision, 'no-trade');
  assert.ok(hasReason(weak, 'WEAK_RS'));

  const noStruct = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, brokeOrHigh: false, price: 10.10 });
  assert.equal(noStruct.decision, 'no-trade');
  assert.ok(hasReason(noStruct, 'NO_STRUCTURE'));
});

// --- anti-chase -----------------------------------------------------------------

test('anti-chase rejects a name already extended past the trigger', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_LONG, price: 11.30, dayChangePct: 5.5, vwap: 10.60, rvol: 2.5,
  }); // (11.30 - 10.40) / 0.30 = 3.0 ATR beyond the OR high > 2 ATR cap
  assert.equal(d.decision, 'no-trade');
  assert.ok(hasReason(d, 'CHASE_EXTENDED'));
});

test('anti-chase rejects a name already up more than the day-gain cap', () => {
  const d = evaluateCandidate(ctxFor(RISK_ON), {
    ...GOOD_LONG, dayChangePct: 24, relStrengthPct: 22.9, price: 10.55,
  });
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
  const noAtr = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, atr: null });
  assert.equal(noAtr.decision, 'no-trade');
  assert.ok(hasReason(noAtr, 'ATR_MISSING'));

  const noSpread = evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, spreadPct: null });
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
    evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG }), // enter
    evaluateCandidate(ctxFor(RISK_OFF), { ...GOOD_LONG }), // regime block
    evaluateCandidate(ctxFor(CHOP), { ...GOOD_LONG }), // chop
    evaluateCandidate({ market: {}, nowMs: NOW, dayState: {} }, { ...GOOD_LONG }), // unknown
    evaluateCandidate(ctxFor(RISK_ON), { ...GOOD_LONG, price: 11.30, dayChangePct: 5.5, vwap: 10.60 }), // chase
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
