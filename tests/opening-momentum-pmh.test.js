'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const {
  evaluatePmhBreak,
  evaluatePmhRunnerExit,
  pmhRegularSessionOpenAt,
  calculatePmhBoundedEntry,
  reservePmhEntryIntent,
  summarizePmhTerminalExit,
  managePmhRunnerExit,
  preparePmhManagedCycle,
} = require('../lib/opening-momentum-pmh');
let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function valid(overrides = {}) {
  return {
    symbol: 'TEST', freshness: { bars: true, quote: true },
    premarket: { frozen: true, high: 10.5, low: 9.9, volume: 900000 },
    previousDay: { close: 9.8, high: 10.0, low: 9.2 }, openingPrice: 10.1,
    candle: { open: 10.52, high: 10.85, low: 10.5, close: 10.82, volume: 12000 },
    volumeBaseline: { mean: 4000, stdDev: 3000, samples: 10 },
    quote: { price: 10.82, bid: 10.81, ask: 10.83 }, resistance: 11.8,
    market: { available: true, bullish: true }, sector: { available: true, bullish: true },
    relativeStrength: true, atr: .4, ema9: 10.55, ...overrides,
  };
}
console.log('\nOpening Momentum PMH evaluator\n');
test('requires a closed candle above frozen PMH, not a wick', () => {
  const r = evaluatePmhBreak(valid({ candle: { open: 10.45, high: 10.8, low: 10.4, close: 10.49, volume: 12000 } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /Wick-only/.test(x)));
});
test('rejects red rejection candle', () => {
  const r = evaluatePmhBreak(valid({ candle: { open: 10.8, high: 10.85, low: 10.5, close: 10.55, volume: 12000 } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /red/.test(x)));
});
test('blocks stale required evidence', () => {
  const r = evaluatePmhBreak(valid({ freshness: { bars: false, quote: false } }));
  assert.strictEqual(r.status, 'BLOCKED'); assert.strictEqual(r.eligible, false);
});
test('blocks without same-time volume history', () => {
  const r = evaluatePmhBreak(valid({ volumeBaseline: { mean: 4000, stdDev: 1000, samples: 2 } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /baseline/.test(x)));
});
test('blocks a candle with missing volume instead of treating it as zero', () => {
  const r = evaluatePmhBreak(valid({ candle: { open: 10.52, high: 10.85, low: 10.5, close: 10.82, volume: null } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /volume baseline/.test(x)));
});
test('enforces strict opening above previous close and high', () => {
  const r = evaluatePmhBreak(valid({ openingPrice: 10.0 }));
  assert.strictEqual(r.opening.eligible, false); assert.strictEqual(r.eligible, false);
});
test('keeps the frozen PMH opening gate authoritative over supplemental setup context', () => {
  const r = evaluatePmhBreak(valid({
    openingPrice: 10.0,
    priceAction: { eligible: true, setup: { type: 'BREAKOUT_CONTINUATION' } },
  }));
  assert.strictEqual(r.eligible, false);
  assert(r.reasons.some(x => /Opening price must be above/.test(x)));
});
test('uses dollar risk divided by breakout-low distance', () => {
  const r = evaluatePmhBreak(valid());
  assert.strictEqual(r.sizing.method, 'risk'); assert.strictEqual(r.sizing.shares, Math.floor(100 / .32));
});
test('caps risk-sized shares at the configured position limit', () => {
  const r = evaluatePmhBreak(valid(), { maxPositionDollars: 100 });
  assert.strictEqual(r.sizing.shares, Math.floor(100 / 10.82));
  assert(r.sizing.estimatedNotional <= 100);
});
test('score is bounded and resistance can block trade', () => {
  const r = evaluatePmhBreak(valid({ resistance: 10.95 }));
  assert(r.score >= 0 && r.score <= 100); assert.strictEqual(r.eligible, false);
});
test('applies the configured maximum trade price as a hard eligibility gate', () => {
  const r = evaluatePmhBreak(valid({ quote: { price: 15.01, bid: 15, ask: 15.02 } }));
  assert.strictEqual(r.eligible, false); assert(r.reasons.some(x => /trade ceiling/.test(x)));
});
test('runner exits only after a completed failure condition', () => {
  assert.strictEqual(evaluatePmhRunnerExit({ candle: { close: 10.4 }, pmh: 10.5, ema9: 10.45 }).exit, true);
  assert.strictEqual(evaluatePmhRunnerExit({ candle: { close: 10.7 }, pmh: 10.5, ema9: 10.6 }).exit, false);
});
test('cannot freeze the pre-market range before the 09:30 ET regular open', () => {
  assert.strictEqual(pmhRegularSessionOpenAt('2026-09-01T13:29:59.000Z'), false);
  assert.strictEqual(pmhRegularSessionOpenAt('2026-09-01T13:30:00.000Z'), true);
  assert.strictEqual(pmhRegularSessionOpenAt('2026-09-05T14:00:00.000Z'), false);
});
test('a fast quote gap re-sizes against the executable limit without exceeding risk', () => {
  const now = new Date('2026-09-01T14:00:00.000Z');
  const result = calculatePmhBoundedEntry({
    ask: 10.50,
    quoteAt: now,
    now,
    stop: 10,
    resistance: 12,
    config: { maxRiskDollars: 100, maxPositionDollars: 5000 },
    maxTradePrice: 15,
  });
  assert.strictEqual(result.eligible, true);
  assert(result.entry <= 10.50 * 1.0025);
  assert(result.shares < Math.floor(100 / (10.20 - 10)));
  assert(result.shares * result.riskPerShare <= 100 + 1e-9);
  assert(result.shares * result.entry <= 5000 + 1e-9);
});
test('a quote gap blocks when the new executable price invalidates room to resistance', () => {
  const now = new Date('2026-09-01T14:00:00.000Z');
  const result = calculatePmhBoundedEntry({
    ask: 11.40,
    quoteAt: now,
    now,
    stop: 10,
    resistance: 12,
    config: { maxRiskDollars: 100, maxPositionDollars: 5000 },
    maxTradePrice: 15,
  });
  assert.strictEqual(result.eligible, false);
  assert(result.reasons.some(reason => /resistance-risk/.test(reason)));
});
test('concurrent reservations create one symbol/session intent', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pmh_entry_intents (
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    session_date TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    PRIMARY KEY (user_id, symbol, session_date)
  )`);
  let submissions = 0;
  const execute = async () => {
    await Promise.resolve();
    reservePmhEntryIntent(db, {
      userId: 7,
      symbol: 'test',
      sessionDate: '2026-09-01',
      detail: 'mock execute',
    });
    submissions += 1;
  };
  const results = await Promise.allSettled([execute(), execute()]);
  assert.strictEqual(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.strictEqual(submissions, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM pmh_entry_intents').get().count, 1);
  db.close();
});
test('a stop-cancel fill race reconciles without submitting another sell', async () => {
  let exitSubmissions = 0;
  const result = await managePmhRunnerExit({
    symbol: 'TEST',
    entryOrderId: 'entry-1',
    entryClientOrderId: 'pmh-entry-1',
    exitClientOrderId: 'pmh-exit-1',
    maxQty: 5,
    stopPrice: 10,
    parent: { client_order_id: 'pmh-entry-1', legs: [{ id: 'stop-1', type: 'stop', status: 'new' }] },
    broker: {
      cancelOrder: async () => ({ ok: true }),
      getOrder: async () => ({ id: 'stop-1', type: 'stop', status: 'filled' }),
      getNestedOrder: async () => {
        throw new Error('should not fetch after an unsettled cancellation');
      },
      getPosition: async () => ({ qty: '0' }),
      submitMarketExit: async () => { exitSubmissions += 1; },
      submitProtectiveStop: async () => ({ id: 'rescue-1' }),
      isOwned: () => true,
    },
  });
  assert.strictEqual(result.action, 'reconcile_only');
  assert.strictEqual(exitSubmissions, 0);
});
test('a PMH exit never cancels a foreign strategy stop on the same symbol', async () => {
  let cancellations = 0;
  let exitSubmissions = 0;
  const result = await managePmhRunnerExit({
    symbol: 'TEST',
    entryOrderId: 'foreign-entry',
    entryClientOrderId: 'pmh-entry-1',
    exitClientOrderId: 'pmh-exit-1',
    maxQty: 5,
    stopPrice: 10,
    parent: {
      client_order_id: 'mt-entry-1',
      legs: [{ id: 'momentum-stop', type: 'stop', status: 'new' }],
    },
    broker: {
      cancelOrder: async () => { cancellations += 1; },
      submitMarketExit: async () => { exitSubmissions += 1; },
      isOwned: (order, expected) => order.client_order_id === expected,
    },
  });
  assert.strictEqual(result.action, 'reconcile_only');
  assert.strictEqual(cancellations, 0);
  assert.strictEqual(exitSubmissions, 0);
});
test('a failed runner exit attempts to restore broker stop protection', async () => {
  let exitSubmissions = 0;
  let rescueSubmissions = 0;
  const result = await managePmhRunnerExit({
    symbol: 'TEST',
    entryOrderId: 'entry-1',
    entryClientOrderId: 'pmh-entry-1',
    exitClientOrderId: 'pmh-exit-1',
    maxQty: 5,
    stopPrice: 10,
    parent: { client_order_id: 'pmh-entry-1', legs: [{ id: 'stop-1', type: 'stop', status: 'new' }] },
    broker: {
      cancelOrder: async () => ({ ok: true }),
      getOrder: async () => ({ id: 'stop-1', type: 'stop', status: 'canceled' }),
      getNestedOrder: async () => ({
        client_order_id: 'pmh-entry-1',
        legs: [{ id: 'stop-1', type: 'stop', status: 'canceled' }],
      }),
      getPosition: async () => ({ qty: '5' }),
      submitMarketExit: async () => {
        exitSubmissions += 1;
        const error = new Error('mock broker rejection');
        error.alpacaStatus = 422;
        throw error;
      },
      submitProtectiveStop: async body => {
        rescueSubmissions += 1;
        assert.strictEqual(body.qty, '5');
        assert.strictEqual(body.stop_price, '10.00');
        return { id: 'rescue-1' };
      },
      isOwned: (order, expected) => order.client_order_id === expected,
      isDefinitiveExitFailure: error => error.alpacaStatus === 422,
    },
  });
  assert.strictEqual(result.action, 'protected_after_exit_failure');
  assert.strictEqual(exitSubmissions, 1);
  assert.strictEqual(rescueSubmissions, 1);
  assert.strictEqual(result.rescueOrder.id, 'rescue-1');
});
test('an ambiguous runner-exit timeout never submits a competing rescue stop', async () => {
  let rescueSubmissions = 0;
  const result = await managePmhRunnerExit({
    symbol: 'TEST',
    entryOrderId: 'entry-1',
    entryClientOrderId: 'pmh-entry-1',
    exitClientOrderId: 'pmh-exit-1',
    maxQty: 5,
    stopPrice: 10,
    parent: { client_order_id: 'pmh-entry-1', legs: [{ id: 'stop-1', type: 'stop', status: 'canceled' }] },
    broker: {
      getNestedOrder: async () => ({
        client_order_id: 'pmh-entry-1',
        legs: [{ id: 'stop-1', type: 'stop', status: 'canceled' }],
      }),
      getPosition: async () => ({ qty: '5' }),
      submitMarketExit: async () => {
        const error = new Error('mock timeout after possible acceptance');
        error.alpacaTransient = true;
        throw error;
      },
      submitProtectiveStop: async () => {
        rescueSubmissions += 1;
        return { id: 'must-not-submit' };
      },
      isOwned: (order, expected) => order.client_order_id === expected,
      isDefinitiveExitFailure: () => false,
    },
  });
  assert.strictEqual(result.action, 'exit_unknown');
  assert.strictEqual(rescueSubmissions, 0);
});
test('a rescue timeout preserves its durable intent for exact reconciliation', async () => {
  let reservedRescue = false;
  let exitSubmissions = 0;
  let rescueSubmissions = 0;
  const result = await managePmhRunnerExit({
    symbol: 'TEST',
    entryOrderId: 'entry-1',
    entryClientOrderId: 'pmh-entry-1',
    exitClientOrderId: 'pmh-exit-1',
    maxQty: 5,
    stopPrice: 10,
    parent: { client_order_id: 'pmh-entry-1', legs: [{ id: 'stop-1', type: 'stop', status: 'canceled' }] },
    broker: {
      getNestedOrder: async () => ({
        client_order_id: 'pmh-entry-1',
        legs: [{ id: 'stop-1', type: 'stop', status: 'canceled' }],
      }),
      getPosition: async () => ({ qty: '5' }),
      submitMarketExit: async () => {
        exitSubmissions += 1;
        const error = new Error('definitive broker rejection');
        error.alpacaStatus = 422;
        throw error;
      },
      beforeProtectiveStop: async () => {
        reservedRescue = true;
      },
      submitProtectiveStop: async () => {
        assert.strictEqual(reservedRescue, true);
        rescueSubmissions += 1;
        throw new Error('rescue response timed out');
      },
      isOwned: (order, expected) => order.client_order_id === expected,
      isDefinitiveExitFailure: error => error.alpacaStatus === 422,
    },
  });
  assert.strictEqual(result.action, 'exit_failed');
  assert.strictEqual(exitSubmissions, 1);
  assert.strictEqual(rescueSubmissions, 1);
  assert.strictEqual(reservedRescue, true);
  assert.match(result.rescueError, /timed out/);
});
test('a terminal partial runner exit protects only residual runner shares', () => {
  const terminal = summarizePmhTerminalExit({
    runnerQty: 5,
    filledQty: 2,
    filledAvgPrice: 11,
    entryPrice: 10,
    accountPositionQty: 8,
  });
  assert.strictEqual(terminal.confirmedFilledQty, 2);
  assert.strictEqual(terminal.remainingRunnerQty, 3);
  assert.strictEqual(terminal.protectionQty, 3);
  assert.strictEqual(terminal.realizedPnl, 2);
  const independentlyProtectedPartialQty = 5;
  assert(terminal.protectionQty + independentlyProtectedPartialQty <= terminal.availablePositionQty);
});
test('live entry pause reconciles existing PMH state before suppressing new entries', async () => {
  const calls = [];
  const result = await preparePmhManagedCycle({
    reconcile: async () => {
      calls.push('reconcile');
      return { reconciled: [{ id: 1, status: 'open' }] };
    },
    botEnabled: true,
    settingsEnabled: true,
    mode: 'live',
    liveArmed: true,
    livePaused: true,
    marketOpen: true,
  });
  assert.deepStrictEqual(calls, ['reconcile']);
  assert.strictEqual(result.allowEntry, false);
  assert.strictEqual(result.status, 'reconciled_live_paused');
  assert.strictEqual(result.reconciled, 1);
});
test('disabled PMH entry still reconciles unresolved broker state', async () => {
  let reconciled = false;
  const result = await preparePmhManagedCycle({
    reconcile: async () => { reconciled = true; return { reconciled: [] }; },
    botEnabled: false,
    settingsEnabled: false,
    mode: 'paper',
    liveArmed: false,
    livePaused: true,
    marketOpen: true,
  });
  assert.strictEqual(reconciled, true);
  assert.strictEqual(result.allowEntry, false);
  assert.strictEqual(result.status, 'reconciled_paused');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (error) {
      console.error(`  ✗ ${name}\n    ${error.message}`);
      failed++;
    }
  }
  if (failed) process.exitCode = 1;
  console.log(`\n${passed} passed, ${failed} failed`);
})();