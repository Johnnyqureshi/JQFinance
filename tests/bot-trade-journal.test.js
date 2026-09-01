'use strict';

const assert = require('assert');
const {
  filledSellOrder,
  isTerminalWithoutFill,
  momentumWorkerHealth,
  needsRescueReplacement,
} = require('../lib/bot-trade-journal');

const fill = filledSellOrder({
  side: 'buy',
  status: 'filled',
  legs: [{ side: 'sell', status: 'filled', filled_avg_price: '12.50', filled_qty: '4' }],
});
assert.equal(fill.filled_avg_price, '12.50');
assert.equal(isTerminalWithoutFill({ status: 'canceled', filled_qty: '0' }), true);
assert.equal(isTerminalWithoutFill({ status: 'canceled', filled_qty: '1' }), false);
for (const status of ['canceled', 'rejected', 'expired']) {
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