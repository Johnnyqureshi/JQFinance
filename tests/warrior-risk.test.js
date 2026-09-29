'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planTrade, checkDailyLimits, validatePreTrade, PRE_TRADE_CHECKS, DEFAULT_DAILY_RULES,
} = require('../lib/warrior/risk');

test('planTrade sizes from the risk budget: floor(budget / riskPerShare)', () => {
  const p = planTrade({ entry: 100, stop: 98, target: 106, equity: 25000 });
  assert.equal(p.sharesRecommended, 62); // floor(125 / 2)
  assert.equal(p.dollarRisk, 124);
  assert.equal(p.riskBudget, 125);
  assert.equal(p.rr, 3);
  assert.equal(p.notional, 6200);
  assert.equal(p.clampedByMax, false);
  assert.equal(p.reward, 372);
});

test('planTrade clamps the budget to maxRiskPerTradePct', () => {
  const p = planTrade({ entry: 100, stop: 98, target: 106, equity: 25000, riskPerTradePct: 2, maxRiskPerTradePct: 1 });
  assert.equal(p.clampedByMax, true);
  assert.equal(p.riskBudget, 250);
  assert.equal(p.sharesRecommended, 125);
});

test('planTrade throws on inverted or missing risk', () => {
  assert.throws(() => planTrade({ entry: 98, stop: 100, target: 106, equity: 25000 }), /entry must be above stop/);
  assert.throws(() => planTrade({ entry: 100, stop: 100, target: 106, equity: 25000 }), /entry must be above stop/);
  assert.throws(() => planTrade({ entry: 100, stop: 98, target: 99, equity: 25000 }), /target must be above entry/);
});

test('checkDailyLimits passes when everything is inside the rails', () => {
  const r = checkDailyLimits({ dayPnl: -100, equity: 25000, consecutiveLosses: 1, openPositions: 1, tradesToday: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.halts, []);
});

test('checkDailyLimits halts on each named limit', () => {
  const cases = [
    [{ dayPnl: -500, equity: 25000 }, 'MAX_DAILY_LOSS'],
    [{ dayPnl: -501, equity: 25000 }, 'MAX_DAILY_LOSS'],
    [{ consecutiveLosses: 3, equity: 25000 }, 'MAX_CONSECUTIVE_LOSSES'],
    [{ openPositions: 3, equity: 25000 }, 'MAX_POSITIONS'],
    [{ tradesToday: 10, equity: 25000 }, 'MAX_TRADES_PER_DAY'],
    [{ minutesSinceLastLoss: 5, equity: 25000 }, 'LOSS_COOLDOWN'],
  ];
  for (const [input, halt] of cases) {
    const r = checkDailyLimits(input);
    assert.equal(r.ok, false, halt);
    assert.ok(r.halts.includes(halt), halt);
    assert.ok(r.reasons.length > 0, halt);
  }
  // Cooldown is skipped when the time since the last loss is unknown.
  assert.equal(checkDailyLimits({ equity: 25000 }).ok, true);
  // Cooldown expires.
  assert.equal(checkDailyLimits({ equity: 25000, minutesSinceLastLoss: 20 }).ok, true);
});

test('validatePreTrade passes when all 12 checks pass', () => {
  const r = validatePreTrade({
    marketOpen: true, dataFresh: true, pattern: { pattern_valid: true },
    indicatorsOk: true, regimeOk: true, entry: 100, stop: 98, target: 104,
    rr: 2, minRR: 2, buyingPower: 50000, notional: 6200,
    duplicatePosition: false, dailyLimitsOk: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.checks.map(c => c.name), [...PRE_TRADE_CHECKS]);
});

test('validatePreTrade: each single failure blocks the trade and names the check', () => {
  const good = {
    marketOpen: true, dataFresh: true, pattern: { pattern_valid: true },
    indicatorsOk: true, regimeOk: true, entry: 100, stop: 98, target: 104,
    rr: 2, minRR: 2, buyingPower: 50000, notional: 6200,
    duplicatePosition: false, dailyLimitsOk: true,
  };
  const mutations = {
    market_open: { marketOpen: false },
    data_fresh: { dataFresh: false },
    pattern_valid: { pattern: { pattern_valid: false } },
    indicators_ok: { indicatorsOk: false },
    regime_ok: { regimeOk: false },
    entry_above_stop: { stop: 100 },
    target_above_entry: { target: 100 },
    min_risk_reward: { rr: 1.5 },
    sufficient_buying_power: { buyingPower: 6199 },
    no_duplicate_position: { duplicatePosition: true },
    daily_limits_ok: { dailyLimitsOk: false },
    position_size_positive: { notional: 0, buyingPower: 50000 },
  };
  assert.deepEqual(Object.keys(mutations).sort(), [...PRE_TRADE_CHECKS].sort());
  for (const [name, patch] of Object.entries(mutations)) {
    const r = validatePreTrade({ ...good, ...patch });
    assert.equal(r.ok, false, name);
    assert.deepEqual(r.failures, [name], name);
  }
});

test('risk module exports the documented rule sets', () => {
  assert.equal(DEFAULT_DAILY_RULES.maxDailyLossPct, 2);
  assert.equal(DEFAULT_DAILY_RULES.maxConsecutiveLosses, 3);
  assert.equal(DEFAULT_DAILY_RULES.maxPositions, 3);
  assert.equal(DEFAULT_DAILY_RULES.maxTradesPerDay, 10);
  assert.equal(DEFAULT_DAILY_RULES.cooldownMinutesAfterLoss, 15);
  assert.equal(PRE_TRADE_CHECKS.length, 12);
});
