'use strict';

const STRATEGIES = Object.freeze({
  b2: {
    invalidate(db, userId) {
      db.prepare(`UPDATE b2_settings SET
        enabled=CASE WHEN live_armed=1 THEN 0 ELSE enabled END,
        live_armed=0,automation_revision=automation_revision+1
        WHERE user_id=?`).run(userId);
    },
  },
  options: {
    invalidate(db, userId) {
      db.prepare(`UPDATE options_settings SET
        enabled=CASE WHEN live_armed=1 THEN 0 ELSE enabled END,
        live_armed=0,activation_revision=activation_revision+1
        WHERE user_id=?`).run(userId);
    },
  },
});

function createAutomaticBotSettings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automatic_live_bot_arms (
      user_id INTEGER PRIMARY KEY,
      strategy TEXT NOT NULL,
      armed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  const known = strategy => {
    if (!STRATEGIES[strategy]) throw new Error('Unknown automatic trading strategy.');
    return STRATEGIES[strategy];
  };

  function owner(userId) {
    return db.prepare('SELECT strategy,armed_at FROM automatic_live_bot_arms WHERE user_id=?').get(userId) || null;
  }

  function revoke(userId, strategy) {
    known(strategy);
    db.prepare('DELETE FROM automatic_live_bot_arms WHERE user_id=? AND strategy=?').run(userId, strategy);
  }

  function arm(userId, strategy, activate, isCurrent = () => true) {
    known(strategy);
    if (typeof activate !== 'function') throw new Error('Live activation callback is required.');
    if (typeof isCurrent !== 'function') throw new Error('Live activation freshness callback is required.');
    return db.transaction(() => {
      if (!isCurrent()) {
        const error = new Error('Live authorization changed while broker verification was pending.');
        error.status = 409;
        throw error;
      }
      for (const [other, config] of Object.entries(STRATEGIES)) {
        if (other === strategy) continue;
        config.invalidate(db, userId);
      }
      activate();
      db.prepare(`INSERT INTO automatic_live_bot_arms(user_id,strategy,armed_at)
        VALUES (?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET
        strategy=excluded.strategy,armed_at=excluded.armed_at`).run(userId, strategy);
      return owner(userId);
    })();
  }

  function status(userId, strategy, { mode, enabled, liveArmed }) {
    known(strategy);
    const liveOwner = owner(userId);
    let posture = 'paused';
    if (enabled && mode === 'paper') posture = 'active';
    else if (enabled && mode === 'live' && liveArmed && liveOwner?.strategy === strategy) posture = 'live-armed';
    else if (mode === 'live' && liveOwner?.strategy && liveOwner.strategy !== strategy) posture = 'shadowing';
    return { posture, liveOwner: liveOwner?.strategy || null };
  }

  return { arm, revoke, owner, status };
}

module.exports = { createAutomaticBotSettings };