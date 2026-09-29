'use strict';

/**
 * Retire the source-disclosed bootstrap account without deleting its historical
 * strategy records. Broker access and active sessions are removed so the
 * account cannot be used after the migration.
 */
function retireLegacyAccount({
  db, sessionDb, username, replacementPasswordHash,
  botNames = ['countertrend', 'pmh'],
}) {
  // One-way AND one-shot: if a retired row already exists, this migration has
  // run. Never touch the username again, so the owner can safely re-register
  // it afterwards without a later boot re-retiring the fresh account.
  const alreadyRetired = db.prepare(
    "SELECT id FROM users WHERE username LIKE 'retired-bootstrap-%' LIMIT 1"
  ).get();
  if (alreadyRetired) return false;

  const account = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(username);
  if (!account) return false;

  const retiredUsername = `retired-bootstrap-${account.id}`;
  const hasTable = name => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  const retire = db.transaction(() => {
    db.prepare('UPDATE users SET username=?, password_hash=? WHERE id=?')
      .run(retiredUsername, replacementPasswordHash, account.id);
    for (const table of ['alpaca_creds', 'alpaca_active_mode', 'options_alpaca_creds', 'options_alpaca_active_mode', 'broker_account_owners']) {
      if (hasTable(table)) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(account.id);
    }
    for (const table of ['auto_trade_settings', 'pmh_settings', 've_auto_settings', 'options_settings']) {
      if (hasTable(table)) db.prepare(`UPDATE ${table} SET enabled=0 WHERE user_id=?`).run(account.id);
    }
    if (hasTable('bot_toggles')) {
      const disableBot = db.prepare(`
      INSERT INTO bot_toggles (user_id, bot_name, enabled) VALUES (?, ?, 0)
      ON CONFLICT(user_id, bot_name) DO UPDATE SET enabled=0
    `);
      for (const botName of botNames) disableBot.run(account.id, botName);
    }
  });
  retire();

  const sessionTable = sessionDb.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'"
  ).get();
  if (sessionTable) {
    sessionDb.prepare("DELETE FROM sessions WHERE sess LIKE ? OR sess LIKE ?")
      .run(`%"userId":${account.id}%`, `%"userId": ${account.id}%`);
  }
  return true;
}

module.exports = { retireLegacyAccount };