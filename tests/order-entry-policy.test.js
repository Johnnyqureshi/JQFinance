'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  boundedManagedExitQuantity,
  entryOwnershipConflict,
  managedExitFillSummary,
  managedSymbolOwnership,
  migrateLegacyMomentumOwnership,
  requiresPriceActionForEntry,
} = require('../lib/order-entry-policy');

assert.strictEqual(requiresPriceActionForEntry({ side: 'buy', isCrypto: false }), true);
assert.strictEqual(requiresPriceActionForEntry({ side: 'BUY', isCrypto: false }), true);
assert.strictEqual(requiresPriceActionForEntry({ side: 'sell', isCrypto: false }), false);
assert.strictEqual(requiresPriceActionForEntry({ side: 'buy', isCrypto: true }), false);
assert.strictEqual(requiresPriceActionForEntry({ side: 'buy', isCrypto: false, strategy: 'pmh' }), false);

const rows = [
  { id: 1, symbol: 'TEST', strategy: 'momentum', status: 'open', broker_account_id: 'acct-1' },
  { id: 2, symbol: 'TEST', strategy: 'opening-momentum-pmh-partial', status: 'closed', broker_account_id: 'acct-1' },
  { id: 3, symbol: 'OTHER', strategy: 'opening-momentum-pmh-runner', status: 'open', broker_account_id: 'acct-1' },
  { id: 4, symbol: 'TEST', strategy: null, status: 'open', broker_account_id: 'acct-1' },
];
assert.deepStrictEqual(managedSymbolOwnership(rows, { accountId: 'acct-1', symbol: 'test' }).map(row => row.id), [1]);
assert.deepStrictEqual(managedSymbolOwnership([
  { id: 5, symbol: 'TEST', strategy: 'momentum', status: 'open', broker_account_id: null },
], { accountId: 'different-account', symbol: 'TEST' }).map(row => row.id), [5]);
assert.strictEqual(entryOwnershipConflict(rows, {
  accountId: 'acct-1', symbol: 'TEST', requestedOwner: 'pmh',
}).owner, 'momentum');
assert.strictEqual(entryOwnershipConflict(rows, {
  accountId: 'acct-1', symbol: 'TEST', requestedOwner: 'manual',
}).owner, 'momentum');
assert.strictEqual(entryOwnershipConflict(rows, {
  accountId: 'acct-1', symbol: 'TEST', requestedOwner: 'momentum',
}), null);
assert.strictEqual(boundedManagedExitQuantity({ shares: 4 }, { qty: '9' }), 4);
assert.strictEqual(boundedManagedExitQuantity({ shares: 9, entry_filled_qty: 3 }, { qty: '9' }), 3);
assert.deepStrictEqual(managedExitFillSummary({
  filledQty: 4,
  filledNotional: 44,
  expectedQty: 4,
  entryPrice: 10,
}), {
  closed: true,
  completedQty: 4,
  remainingQty: 0,
  exitPrice: 11,
  pnl: 4,
});
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE bot_trade_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    strategy TEXT,
    entry_order_id TEXT,
    entry_client_order_id TEXT,
    broker_account_id TEXT
  );
  CREATE TABLE bot_alpaca_creds (
    user_id INTEGER NOT NULL,
    bot TEXT NOT NULL,
    mode TEXT NOT NULL,
    account_id TEXT
  );
  INSERT INTO bot_alpaca_creds VALUES (7, 'momentum', 'paper', 'acct-momentum');
  INSERT INTO bot_trade_log VALUES (1, 7, 'paper', NULL, 'mt-legacy-1', NULL, NULL);
  INSERT INTO bot_trade_log VALUES (2, 7, 'paper', NULL, 'pmh_legacy_1', NULL, NULL);
  INSERT INTO bot_trade_log VALUES (3, 7, 'paper', NULL, NULL, NULL, NULL);
`);
assert.strictEqual(migrateLegacyMomentumOwnership(db).changes, 1);
assert.deepStrictEqual(
  db.prepare('SELECT strategy,broker_account_id FROM bot_trade_log WHERE id=1').get(),
  { strategy: 'momentum', broker_account_id: 'acct-momentum' }
);
assert.strictEqual(db.prepare('SELECT strategy FROM bot_trade_log WHERE id=2').get().strategy, null);
assert.strictEqual(db.prepare('SELECT strategy FROM bot_trade_log WHERE id=3').get().strategy, null);
db.close();
console.log('order entry policy tests passed');