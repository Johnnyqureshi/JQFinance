'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  applyBrokerEntryState,
  brokerEntryTransition,
  filledSellOrder,
  isTerminalOrder,
  isTerminalWithoutFill,
  managedFillSummary,
  momentumWorkerHealth,
  needsRescueReplacement,
  reconcileManagedFillLedger,
} = require('../lib/bot-trade-journal');

const fill = filledSellOrder({
  side: 'buy',
  status: 'filled',
  legs: [{ side: 'sell', status: 'filled', filled_avg_price: '12.50', filled_qty: '4' }],
});
assert.equal(fill.filled_avg_price, '12.50');
assert.equal(
  filledSellOrder({
    side: 'sell',
    status: 'canceled',
    filled_avg_price: '9.50',
    filled_qty: '2',
  }).filled_qty,
  '2',
  'a terminal remainder must not erase a partial protective fill'
);
assert.equal(isTerminalWithoutFill({ status: 'canceled', filled_qty: '0' }), true);
assert.equal(isTerminalWithoutFill({ status: 'canceled', filled_qty: '1' }), false);
for (const status of ['replaced', 'done_for_day', 'stopped', 'suspended', 'calculated']) {
  assert.equal(isTerminalOrder({ status }), true, `${status} must terminate broker reconciliation`);
  assert.equal(
    brokerEntryTransition({ status, filled_qty: '2', filled_avg_price: '10.25' }).state,
    'open',
    `${status} with a partial fill must finalize the broker-confirmed lot`
  );
}
assert.deepStrictEqual(
  brokerEntryTransition({ status: 'canceled', filled_qty: '3', filled_avg_price: '10.25' }),
  {
    state: 'open',
    filledQty: 3,
    filledAvgPrice: 10.25,
    terminal: true,
    void: false,
  },
  'a canceled remainder must preserve its broker-confirmed partial entry'
);
assert.equal(
  brokerEntryTransition({ status: 'canceled', filled_qty: '0' }).state,
  'void',
  'only terminal zero-fill entries become void'
);
assert.deepStrictEqual(
  managedFillSummary({
    entryQty: 5,
    entryPrice: 10,
    fills: [{ qty: 2, price: 11 }, { qty: 3, price: 9 }],
  }),
  {
    closed: true,
    filledQty: 5,
    remainingQty: 0,
    exitPrice: 9.8,
    pnl: -1,
  },
  'replacement and manual sell fills must aggregate into one broker-derived result'
);
assert.deepStrictEqual(
  managedFillSummary({
    entryQty: 5,
    entryPrice: 10,
    fills: [{ qty: 2, price: 11 }, { qty: 5, price: 9 }],
  }),
  {
    closed: true,
    filledQty: 5,
    remainingQty: 0,
    exitPrice: 9.8,
    pnl: -1,
  },
  'later manual fills are capped to the quantity left after earlier protective fills'
);
{
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE momentum_exit_fills (
    trade_id INTEGER NOT NULL,
    broker_order_id TEXT NOT NULL,
    filled_qty REAL NOT NULL,
    filled_notional REAL NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (trade_id, broker_order_id)
  )`);
  const transition = brokerEntryTransition({
    status: 'replaced',
    filled_qty: '5',
    filled_avg_price: '10',
  });
  const trade = {
    id: 1,
    entry_price: 8,
    shares: 10,
    entry_filled_qty: 0,
  };
  applyBrokerEntryState(trade, transition);
  assert.strictEqual(trade.entry_price, 10, 'broker entry price replaces the planned browser estimate before exits');
  assert.strictEqual(trade.entry_filled_qty, 5, 'broker entry quantity replaces the planned quantity before exits');
  assert.strictEqual(reconcileManagedFillLedger(db, trade, {
    id: 'replacement-stop',
    status: 'done_for_day',
    filled_qty: '2',
    filled_avg_price: '9',
  }).closed, false);
  const completed = reconcileManagedFillLedger(db, trade, {
    id: 'manual-close',
    status: 'filled',
    filled_qty: '3',
    filled_avg_price: '11',
  });
  assert.deepStrictEqual(completed, {
    closed: true,
    filledQty: 5,
    remainingQty: 0,
    exitPrice: 10.2,
    pnl: 1,
  });
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM momentum_exit_fills').get().count,
    2,
    'the broker-order ledger remains idempotent and order keyed'
  );
  db.close();
}
for (const status of ['canceled', 'rejected', 'expired', 'replaced', 'done_for_day']) {
  assert.equal(
    needsRescueReplacement({ side: 'sell', type: 'stop', status, filled_qty: '0' }, 3),
    true,
    `${status} zero-fill rescue with residual shares must be replaced`
  );
}
assert.equal(
  needsRescueReplacement({ side: 'sell', type: 'stop', status: 'canceled', filled_qty: '0' }, 0),
  false,
  'a flat broker position must not receive a replacement sell stop'
);

const disabled = momentumWorkerHealth({
  enabled: false, connected: true, openTrades: 1,
});
assert.equal(disabled.status, 'disabled');
assert.equal(disabled.monitoringOpenPositions, true);

const outage = momentumWorkerHealth({
  enabled: true, connected: true, lastCycleStatus: 'broker_outage',
  lastCycleReason: 'Alpaca unreachable', lastCycleAt: new Date().toISOString(),
});
assert.equal(outage.status, 'broker_outage');

const running = momentumWorkerHealth({
  enabled: true, connected: true, lastCycleStatus: 'reconciled',
  lastCycleAt: new Date().toISOString(),
});
assert.equal(running.status, 'running');
assert.equal(running.running, true);

console.log('bot trade journal tests passed');