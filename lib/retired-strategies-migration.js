'use strict';

// Explicit allowlist only: future strategies (including B2) own their own state.
const RETIRED_SCOPES = Object.freeze([
  'momentum', 'pmh', 'opening-momentum', 'candlestick', 'ultrabot3',
  'swing', 'money-printer', 'countertrend', 'auto-trade',
  'singles_doubles',
]);
const RETIRED_TABLES = Object.freeze([
  'paper_shadow_positions', 'paper_shadow_decisions', 'momentum_exit_fills',
  'managed_symbol_entry_leases', 'bot_trade_log', 'momentum_settings',
  'bot_toggles', 'bot_alpaca_active_mode', 'bot_alpaca_creds',
  'auto_trade_log', 'auto_trade_settings', 've_auto_settings', 'orb_session_log',
  'ee_auto_settings', 'ct_auto_settings',
  'pmh_entry_intents', 'pmh_session_snapshots', 'pmh_settings',
  'candlestick_exit_fills', 'candlestick_signal_reservations',
  'candlestick_execution_leases', 'candlestick_candidates', 'candlestick_trade_log',
  'candlestick_settings', 'candlestick_alpaca_active_mode', 'candlestick_alpaca_creds',
  'swing_exit_fills', 'swing_fills', 'swing_entry_reservations', 'swing_events',
  'swing_alerts', 'swing_execution_leases', 'swing_candidates', 'swing_trades',
  'swing_settings', 'swing_auto_settings', 'swing_alpaca_active_mode', 'swing_alpaca_creds',
  'money_printer_execution_leases', 'money_printer_candidates', 'money_printer_trades',
  'money_printer_settings', 'money_printer_alpaca_active_mode', 'money_printer_alpaca_creds',
]);

function retireRemovedStrategies(db) {
  db.transaction(() => {
    const registry = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_account_owners'").get();
    if (registry) {
      const remove = db.prepare('DELETE FROM broker_account_owners WHERE scope=?');
      for (const scope of RETIRED_SCOPES) remove.run(scope);
    }
    // Child tables precede parents. No credentials are read, and no broker calls
    // or cancellations occur. Unknown quarantine reasons remain untouched.
    for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  })();
}

module.exports = { RETIRED_SCOPES, RETIRED_TABLES, retireRemovedStrategies };