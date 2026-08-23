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
  const account = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(username);
  if (!account) return false;

  const retiredUsername = `retired-bootstrap-${account.id}`;
  const retire = db.transaction(() => {
    db.prepare('UPDATE users SET username=?, password_hash=? WHERE id=?')
      .run(retiredUsername, replacementPasswordHash, account.id);
    db.prepare('DELETE FROM alpaca_creds WHERE user_id=?').run(account.id);
    db.prepare('DELETE FROM alpaca_active_mode WHERE user_id=?').run(account.id);
    db.prepare('UPDATE auto_trade_settings SET enabled=0 WHERE user_id=?').run(account.id);
    db.prepare('UPDATE pmh_settings SET enabled=0 WHERE user_id=?').run(account.id);
    db.prepare('UPDATE ve_auto_settings SET enabled=0 WHERE user_id=?').run(account.id);
    const disableBot = db.prepare(`
      INSERT INTO bot_toggles (user_id, bot_name, enabled) VALUES (?, ?, 0)
      ON CONFLICT(user_id, bot_name) DO UPDATE SET enabled=0
    `);
    for (const botName of botNames) disableBot.run(account.id, botName);
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