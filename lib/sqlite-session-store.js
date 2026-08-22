'use strict';

/**
 * Persistent express-session store using the established connect-sqlite3
 * schema. Keeping the sid/expired/sess columns makes this a transparent,
 * dependency-safe replacement that preserves existing signed-in sessions.
 */
module.exports = function createSqliteSessionStore(session, db, defaultTtlMs) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      expired INTEGER,
      sess TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
  `);

  const getRow = db.prepare('SELECT sess, expired FROM sessions WHERE sid=?');
  const write = db.prepare(`
    INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET expired=excluded.expired, sess=excluded.sess
  `);
  const destroy = db.prepare('DELETE FROM sessions WHERE sid=?');
  const touch = db.prepare('UPDATE sessions SET expired=?, sess=? WHERE sid=?');
  const prune = db.prepare('DELETE FROM sessions WHERE expired IS NOT NULL AND expired <= ?');

  function expiryFor(sess) {
    const explicit = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    if (Number.isFinite(explicit)) return explicit;
    const maxAge = Number(sess?.cookie?.originalMaxAge ?? sess?.cookie?.maxAge);
    return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : defaultTtlMs);
  }

  return class SqliteSessionStore extends session.Store {
    get(sid, callback) {
      try {
        const row = getRow.get(sid);
        if (!row || (Number.isFinite(Number(row.expired)) && Number(row.expired) <= Date.now())) {
          if (row) destroy.run(sid);
          return callback(null, null);
        }
        callback(null, JSON.parse(row.sess));
      } catch (error) {
        callback(error);
      }
    }

    set(sid, sess, callback = () => {}) {
      try {
        write.run(sid, expiryFor(sess), JSON.stringify(sess));
        callback(null);
      } catch (error) {
        callback(error);
      }
    }

    touch(sid, sess, callback = () => {}) {
      try {
        touch.run(expiryFor(sess), JSON.stringify(sess), sid);
        callback(null);
      } catch (error) {
        callback(error);
      }
    }

    destroy(sid, callback = () => {}) {
      try {
        destroy.run(sid);
        callback(null);
      } catch (error) {
        callback(error);
      }
    }

    clear(callback = () => {}) {
      try {
        db.prepare('DELETE FROM sessions').run();
        callback(null);
      } catch (error) {
        callback(error);
      }
    }

    length(callback) {
      try {
        prune.run(Date.now());
        callback(null, db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count);
      } catch (error) {
        callback(error);
      }
    }
  };
};