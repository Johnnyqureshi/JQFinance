'use strict';

// Every non-PMH stock/ETF buy shares the compatible Momentum setup and
// protective-stop boundary. PMH has its own frozen-opening execution contract;
// price action remains informational there and must never alter PMH eligibility.
function requiresPriceActionForEntry({ side, isCrypto, strategy = 'generic' }) {
  return String(side || '').toLowerCase() === 'buy' && !isCrypto && strategy !== 'pmh';
}

const ACTIVE_MANAGED_STATUSES = new Set([
  'open',
  'pending_entry',
  'exit_reserving',
  'pending_exit',
  'stop_cancel_unknown',
  'protected_after_exit_failure',
  'protection_unresolved',
]);

function strategyOwner(strategy) {
  const value = String(strategy || '').trim().toLowerCase();
  if (value === 'momentum') return 'momentum';
  if (value === 'pmh') return 'pmh';
  if (value.startsWith('opening-momentum-pmh')) return 'pmh';
  return null;
}

function managedSymbolOwnership(rows, { accountId, symbol } = {}) {
  const normalizedAccount = String(accountId || '').trim();
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedAccount || !normalizedSymbol) return [];
  return (Array.isArray(rows) ? rows : [])
    .filter(row =>
      (
        !String(row?.broker_account_id || '').trim()
        || String(row.broker_account_id).trim() === normalizedAccount
      )
      && String(row?.symbol || '').trim().toUpperCase() === normalizedSymbol
      && ACTIVE_MANAGED_STATUSES.has(String(row?.status || '').trim().toLowerCase())
      && strategyOwner(row?.strategy)
    )
    .map(row => ({ ...row, owner: strategyOwner(row.strategy) }));
}

function entryOwnershipConflict(rows, { accountId, symbol, requestedOwner } = {}) {
  const owner = strategyOwner(requestedOwner) || (requestedOwner === 'manual' ? 'manual' : null);
  const managed = managedSymbolOwnership(rows, { accountId, symbol });
  if (!managed.length) return null;
  const foreign = managed.find(row => row.owner !== owner);
  if (foreign) return foreign;
  return owner === 'manual' ? managed[0] : null;
}

function boundedManagedExitQuantity(trade, brokerPosition) {
  const positionQty = Number(brokerPosition?.qty);
  const journalQty = Number(trade?.entry_filled_qty) > 0
    ? Number(trade.entry_filled_qty)
    : Number(trade?.shares);
  if (!(positionQty > 0) || !(journalQty > 0)) return 0;
  return Math.min(positionQty, journalQty);
}

function managedExitFillSummary({ filledQty, filledNotional, expectedQty, entryPrice } = {}) {
  const quantity = Number(filledQty);
  const notional = Number(filledNotional);
  const expected = Number(expectedQty);
  const basis = Number(entryPrice);
  if (!(quantity > 0) || !(notional > 0) || !(expected > 0) || !(basis > 0)) return null;
  const completedQty = Math.min(quantity, expected);
  const averagePrice = notional / quantity;
  return {
    closed: quantity + 1e-8 >= expected,
    completedQty,
    remainingQty: Math.max(0, expected - quantity),
    exitPrice: averagePrice,
    pnl: +((averagePrice - basis) * completedQty).toFixed(6),
  };
}

function migrateLegacyMomentumOwnership(db) {
  if (!db) throw new Error('A database is required for Momentum ownership migration.');
  return db.prepare(`
    UPDATE bot_trade_log
    SET strategy='momentum',
        broker_account_id=COALESCE(
          broker_account_id,
          (
            SELECT account_id
            FROM bot_alpaca_creds
            WHERE bot_alpaca_creds.user_id=bot_trade_log.user_id
              AND bot_alpaca_creds.bot='momentum'
              AND bot_alpaca_creds.mode=bot_trade_log.mode
              AND bot_alpaca_creds.account_id IS NOT NULL
            LIMIT 1
          )
        )
    WHERE strategy IS NULL
      AND (
        entry_order_id GLOB 'mt-*'
        OR entry_client_order_id GLOB 'mt-*'
      )
  `).run();
}

module.exports = {
  boundedManagedExitQuantity,
  entryOwnershipConflict,
  managedExitFillSummary,
  managedSymbolOwnership,
  migrateLegacyMomentumOwnership,
  requiresPriceActionForEntry,
  strategyOwner,
};