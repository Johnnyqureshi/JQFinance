'use strict';
const assert = require('assert');
const {
  DEFAULT_SETTINGS, sanitizeMoneyPrinterSettings, evaluateMoneyPrinterPlan,
  executablePrice, buildMoneyPrinterBracket, moneyPrinterClientOrderId,
  finalMoneyPrinterAuthorization, ownedBracketProtection,
} = require('../lib/money-printer-policy');

const now = Date.parse('2026-08-28T15:00:00Z');
const basePlan = {
  ok: true, generatedAt: new Date(now).toISOString(),
  searchSignal: { signal: { label: 'SELL', stage: 'CONFIRMED' } },
  confluence: { dataQuality: { entryEligible: true, fresh: true } },
  tradeLevels: { status: 'VERIFIED' },
  levels: {}, patternAnalysis: {}, fibonacci: {}, smartMoney: {},
  gapAnalysis: {}, news: [], marketContext: {},
};

assert.throws(() => sanitizeMoneyPrinterSettings({ trigger: 'anything' }), /Unsupported/);
assert.throws(() => sanitizeMoneyPrinterSettings({ stopLossPct: Infinity }), /finite/);
assert.deepStrictEqual(sanitizeMoneyPrinterSettings({}, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
assert.deepStrictEqual(evaluateMoneyPrinterPlan(basePlan, now), { eligible: true, direction: 'SHORT', blockers: [] });
assert.strictEqual(evaluateMoneyPrinterPlan({ ...basePlan, generatedAt: new Date(now - 7 * 60000).toISOString() }, now).eligible, false);
assert.strictEqual(executablePrice({ latestQuote: { ap: 10.1, bp: 9.9, t: new Date(now).toISOString() } }, 'LONG', now), 10.1);
assert.strictEqual(executablePrice({ latestQuote: { ap: 10.1, bp: 9.9, t: new Date(now).toISOString() } }, 'SHORT', now), 9.9);
assert.throws(
  () => executablePrice({ latestQuote: { ap: 10.1, bp: 9.9, t: new Date(now - 91000).toISOString() } }, 'LONG', now),
  /stale/,
);
const bracket = buildMoneyPrinterBracket({
  symbol: 'SPY', direction: 'SHORT', executablePrice: 100,
  settings: { maxPositionDollars: 1050, takeProfitPct: 3, stopLossPct: 1.5 },
  clientOrderId: 'mp-test',
});
assert.strictEqual(bracket.qty, 10);
assert.strictEqual(bracket.order.side, 'sell');
assert.strictEqual(bracket.order.take_profit.limit_price, '97.00');
assert.strictEqual(bracket.order.stop_loss.stop_price, '101.50');
assert.strictEqual(
  moneyPrinterClientOrderId({ userId: 1, accountId: 'a', symbol: 'SPY', direction: 'LONG', bucketMs: 1 }),
  moneyPrinterClientOrderId({ userId: 1, accountId: 'a', symbol: 'SPY', direction: 'LONG', bucketMs: 1 }),
);
const paper = { mode: 'paper', account_id: 'paper-account', api_key: 'paper-key', api_secret: 'paper-secret' };
assert.strictEqual(finalMoneyPrinterAuthorization({
  captured: paper,
  current: { ...paper, mode: 'live', account_id: 'live-account' },
  settings: { enabled: true, liveArmed: true },
}).authorized, false, 'a paper cycle cannot redirect its POST to newly-active live credentials');
assert.strictEqual(finalMoneyPrinterAuthorization({
  captured: paper, current: paper, settings: { enabled: false, liveArmed: false },
}).authorized, false, 'a pause blocks final authorization');
const live = { ...paper, mode: 'live' };
assert.strictEqual(finalMoneyPrinterAuthorization({
  captured: live, current: live, settings: { enabled: true, liveArmed: false },
}).authorized, false, 'a live disarm blocks final authorization');
const partialCanceled = ownedBracketProtection({
  direction: 'LONG', filledQty: 4, positionQty: 4,
  parent: { status: 'canceled' }, children: [],
});
assert.strictEqual(partialCanceled.requiresManagement, true);
assert.strictEqual(partialCanceled.protected, false);
const undersized = ownedBracketProtection({
  direction: 'SHORT', filledQty: 5, positionQty: -5, parent: { status: 'filled' },
  children: [{ status: 'new', side: 'buy', type: 'stop', qty: '4' }, { status: 'new', side: 'buy', type: 'limit', qty: '5' }],
});
assert.strictEqual(undersized.protected, false, 'undersized stop is unresolved');
const protectedOpen = ownedBracketProtection({
  direction: 'LONG', filledQty: 5, positionQty: 5, parent: { status: 'filled' },
  children: [{ status: 'new', side: 'sell', type: 'stop', qty: '5' }, { status: 'new', side: 'sell', type: 'limit', qty: '5' }],
});
assert.strictEqual(protectedOpen.protected, true);
assert.strictEqual(protectedOpen.canClose, false);
const fullySettled = ownedBracketProtection({
  direction: 'LONG', filledQty: 5, positionQty: 0, parent: { status: 'filled' },
  children: [{ status: 'canceled', side: 'sell', type: 'stop', qty: '5' }, { status: 'filled', side: 'sell', type: 'limit', qty: '5' }],
});
assert.strictEqual(fullySettled.canClose, true, 'only absent position plus terminal owned legs closes');
const unknownPosition = ownedBracketProtection({
  direction: 'LONG', filledQty: 0, positionQty: 0, positionKnown: false,
  parent: { status: 'canceled' }, children: [],
});
assert.strictEqual(unknownPosition.canClose, false, 'unknown broker position state cannot close a journal row');
assert.strictEqual(unknownPosition.requiresManagement, true);
console.log('Money Printer policy tests passed');
