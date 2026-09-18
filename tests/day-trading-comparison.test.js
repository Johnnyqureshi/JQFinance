'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  buildDayTradingComparison,
} = require('../lib/day-trading-comparison');

const policy = {
  startingCapital: 10_000,
  maxRiskPerTradePct: 1,
  maxPositionPct: 25,
  minimumTradingDays: 2,
  minimumClosedTrades: 2,
  minimumScoreMargin: 1,
};

function trade(strategy, id, day, overrides = {}) {
  return {
    strategy,
    tradeId: `${strategy}-${id}`,
    symbol: 'TEST',
    mode: 'shadow',
    openedAt: `2026-09-${day}T14:30:00.000Z`,
    closedAt: `2026-09-${day}T15:30:00.000Z`,
    requestedQuantity: 20,
    quantity: 20,
    expectedEntryPrice: 100,
    entryPrice: 100.05,
    exitPrice: 102,
    stopPrice: 98,
    fees: 1,
    entryFillConfirmed: true,
    exitFillConfirmed: true,
    protectiveOrderConfirmed: true,
    protectiveExitRequired: false,
    protectiveExitConfirmed: false,
    exitEvidenceMissing: false,
    ...overrides,
  };
}

const qualified = buildDayTradingComparison({
  policy,
  evidence: {
    pmh: [trade('pmh', 1, '10'), trade('pmh', 2, '11', { exitPrice: 103 })],
    ultrabot3: [
      trade('ultrabot3', 1, '10', { exitPrice: 99 }),
      trade('ultrabot3', 2, '11', { exitPrice: 100.5, protectiveExitRequired: true, protectiveExitConfirmed: true }),
    ],
  },
});
assert.equal(qualified.dataQuality.status, 'QUALIFIED');
assert.equal(qualified.decision.status, 'WINNER_SELECTED');
assert.equal(qualified.decision.winner, 'pmh');
assert.equal(qualified.decision.retire, 'ultrabot3');
assert.equal(qualified.arms[0].metrics.closedTrades, 2);
assert.equal(qualified.arms[0].metrics.tradingDays, 2);
assert.equal(qualified.arms[0].metrics.confirmedFillRatePct, 100);
assert.equal(qualified.arms[1].metrics.protectiveExitReliabilityPct, 100);
assert(Number.isFinite(qualified.arms[0].metrics.returnPct));
assert(Number.isFinite(qualified.arms[0].metrics.maxDrawdownPct));
assert(Number.isFinite(qualified.arms[0].metrics.averageEntrySlippageBps));
assert(Number.isFinite(qualified.arms[0].metrics.profitableSessionPct));

const empty = buildDayTradingComparison({ policy });
assert.equal(empty.decision.status, 'INSUFFICIENT_EVIDENCE');
assert.equal(empty.decision.winner, null);
assert(empty.dataQuality.blockers.some(blocker => /pmh needs 2 trading days/.test(blocker)));

assert.throws(() => buildDayTradingComparison({
  policy,
  evidence: { pmh: [trade('pmh', 1, '10', { mode: 'live' })], ultrabot3: [] },
}), /Paper or shadow/);
assert.throws(() => buildDayTradingComparison({
  policy,
  evidence: { pmh: [trade('pmh', 1, '10', { entryFillConfirmed: false })], ultrabot3: [] },
}), /confirmed entry and exit fills/);
assert.throws(() => buildDayTradingComparison({
  policy,
  evidence: { pmh: [trade('pmh', 1, '10', { closedAt: '2026-09-10T13:00:00.000Z' })], ultrabot3: [] },
}), /chronological/);
assert.throws(() => buildDayTradingComparison({
  policy,
  evidence: { pmh: [trade('pmh', 1, '10', { quantity: 200, requestedQuantity: 200 })], ultrabot3: [] },
}), /shared comparison risk policy/);
assert.throws(() => buildDayTradingComparison({
  policy,
  evidence: { pmh: [trade('pmh', 1, '10'), trade('pmh', 1, '11')], ultrabot3: [] },
}), /duplicate tradeId/);
for (const fees of [-1, 'not-a-number']) {
  assert.throws(() => buildDayTradingComparison({
    policy,
    evidence: { pmh: [trade('pmh', 1, '10', { fees })], ultrabot3: [] },
  }), /invalid fee evidence/);
}
assert.throws(() => buildDayTradingComparison({
  policy,
  evidence: { pmh: [trade('pmh', 1, '10', { entryPrice: 1, stopPrice: 0.9 })], ultrabot3: [] },
}), /slippage-quality limit/);
assert.throws(() => buildDayTradingComparison({
  policy: { ...policy, maxPositionPct: 60 },
  evidence: {
    pmh: [
      trade('pmh', 1, '10', { quantity: 50, requestedQuantity: 50, stopPrice: 99 }),
      trade('pmh', 2, '10', {
        quantity: 50, requestedQuantity: 50, stopPrice: 99,
        openedAt: '2026-09-10T14:31:00.000Z',
      }),
      trade('pmh', 3, '10', {
        quantity: 50, requestedQuantity: 50, stopPrice: 99,
        openedAt: '2026-09-10T14:32:00.000Z',
      }),
    ],
    ultrabot3: [],
  },
}), /shared concurrent capital/);
assert.throws(() => buildDayTradingComparison({
  policy: {
    ...policy, maxPositionPct: 60, maxRiskPerTradePct: 1.1,
    maximumGrossExposurePct: 200, maximumConcurrentRiskPct: 1.5,
  },
  evidence: {
    pmh: [
      trade('pmh', 1, '10', { quantity: 50, requestedQuantity: 50, stopPrice: 98 }),
      trade('pmh', 2, '10', {
        quantity: 50, requestedQuantity: 50, stopPrice: 98,
        openedAt: '2026-09-10T14:31:00.000Z',
      }),
    ],
    ultrabot3: [],
  },
}), /shared concurrent risk/);

const closeOrdered = buildDayTradingComparison({
  policy: { ...policy, minimumClosedTrades: 3 },
  evidence: {
    pmh: [
      trade('pmh', 1, '10', {
        closedAt: '2026-09-13T16:00:00.000Z',
        exitPrice: 110.05,
      }),
      trade('pmh', 2, '11', {
        closedAt: '2026-09-11T16:00:00.000Z',
        exitPrice: 95.05,
      }),
      trade('pmh', 3, '12', {
        closedAt: '2026-09-12T16:00:00.000Z',
        exitPrice: 95.05,
      }),
    ],
    ultrabot3: [
      trade('ultrabot3', 1, '10'),
      trade('ultrabot3', 2, '11'),
      trade('ultrabot3', 3, '12'),
    ],
  },
});
const pmhArm = closeOrdered.arms.find(arm => arm.strategy === 'pmh');
assert.equal(pmhArm.period.end, '2026-09-13T16:00:00.000Z');
assert.equal(pmhArm.metrics.maxDrawdownDollars, 202);

const source = fs.readFileSync(require.resolve('../server'), 'utf8');
assert.match(source, /app\.get\('\/api\/strategy-comparison\/day-trading'/);
assert.doesNotMatch(source, /app\.(?:post|put|delete)\('\/api\/strategy-comparison\/day-trading'/);
assert.doesNotMatch(source, /\/api\/(?:pmh|opening-momentum|candlestick|ultrabot3)(?:\/|')/);
assert(!fs.readFileSync(require.resolve('../lib/day-trading-comparison'), 'utf8').includes('alpaca'));

console.log('day-trading Paper/shadow comparison tests passed');