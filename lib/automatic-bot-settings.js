'use strict';

const STRATEGIES = Object.freeze({
  warrior: {
    invalidate(/* db, userId */) {
      // Warrior is paper-only (no live_armed column on warrior_settings);
      // nothing to disarm when another strategy takes the live slot.
    },
  },
  orb: {
    invalidate(/* db, userId */) {
      // ORB is paper-only (no live_armed column on orb_settings);
      // nothing to disarm when another strategy takes the live slot.
    },
  },
  kiaan: {
    invalidate(/* db, userId */) {
      // Kiaan Bot is paper-only BY DESIGN (no live mode exists in its
      // engine or service); nothing to disarm when another strategy
      // takes the live slot.
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