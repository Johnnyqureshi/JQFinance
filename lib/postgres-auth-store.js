'use strict';

const { Pool } = require('pg');

const MIN_GLOBAL_USER_ID = 1_000_000_000;

function sessionExpiry(sessionData, defaultTtlMs) {
  const explicit = sessionData?.cookie?.expires ? new Date(sessionData.cookie.expires).getTime() : NaN;
  if (Number.isFinite(explicit)) return explicit;
  const maxAge = Number(sessionData?.cookie?.originalMaxAge ?? sessionData?.cookie?.maxAge);
  return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : defaultTtlMs);
}

function createPostgresAuthStore({ databaseUrl, sessionTtlMs }) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for shared authentication storage.');

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 8_000,
  });

  async function init(sqliteDb) {
    const tables = await pool.query(`
      SELECT to_regclass('public.app_auth_users') AS users_table,
             to_regclass('public.app_auth_sessions') AS sessions_table
    `);
    if (!tables.rows[0].users_table || !tables.rows[0].sessions_table) {
      throw new Error('Shared authentication schema is missing. Publish the current database schema before serving sign-ins.');
    }

    // Preserve existing accounts when moving from the single-instance SQLite
    // deployment. PostgreSQL becomes authoritative once an account is present.
    const existingUsers = sqliteDb.prepare(
      'SELECT id, username, password_hash, created_at FROM users'
    ).all();
    for (const user of existingUsers) {
      await pool.query(
        `INSERT INTO app_auth_users (id, username, password_hash, created_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
         ON CONFLICT DO NOTHING`,
        [user.id, user.username, user.password_hash, user.created_at]
      );
    }
  }

  async function retireLegacyUsername(replacementPasswordHash) {
    const legacy = await pool.query(
      'SELECT id FROM app_auth_users WHERE LOWER(username) = LOWER($1) LIMIT 1',
      ['johnnyqureshi']
    );
    if (!legacy.rowCount) return false;
    const userId = legacy.rows[0].id;
    await pool.query(
      'UPDATE app_auth_users SET username=$1, password_hash=$2 WHERE id=$3',
      [`retired-bootstrap-${userId}`, replacementPasswordHash, userId]
    );
    return true;
  }

  async function findUserByUsername(username) {
    const result = await pool.query(
      `SELECT id, username, password_hash, created_at
       FROM app_auth_users
       WHERE LOWER(username) = LOWER($1)
       LIMIT 1`,
      [username]
    );
    return result.rows[0] || null;
  }

  async function findUserById(userId) {
    const result = await pool.query(
      'SELECT id, username, password_hash, created_at FROM app_auth_users WHERE id=$1 LIMIT 1',
      [userId]
    );
    return result.rows[0] || null;
  }

  async function createUser(username, passwordHash) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes ID allocation across autoscaled instances without relying on
      // per-instance SQLite sequences.
      await client.query('SELECT pg_advisory_xact_lock($1)', [872043219]);
      const duplicate = await client.query(
        'SELECT 1 FROM app_auth_users WHERE LOWER(username) = LOWER($1) LIMIT 1',
        [username]
      );
      if (duplicate.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const nextId = await client.query(
        `SELECT GREATEST(COALESCE(MAX(id), 0) + 1, $1::bigint) AS id
         FROM app_auth_users`,
        [MIN_GLOBAL_USER_ID]
      );
      const id = nextId.rows[0].id;
      const inserted = await client.query(
        `INSERT INTO app_auth_users (id, username, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, username, password_hash, created_at`,
        [id, username, passwordHash]
      );
      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function updatePassword(userId, passwordHash) {
    const result = await pool.query(
      'UPDATE app_auth_users SET password_hash=$1 WHERE id=$2',
      [passwordHash, userId]
    );
    return result.rowCount === 1;
  }

  function syncSqliteUser(sqliteDb, user) {
    const createdAt = user.created_at instanceof Date
      ? user.created_at.toISOString()
      : (user.created_at || new Date().toISOString());
    const normalized = {
      id: Number(user.id),
      username: user.username,
      passwordHash: user.password_hash,
      createdAt,
    };
    const byId = sqliteDb.prepare('SELECT id FROM users WHERE id=?').get(normalized.id);
    if (byId) {
      sqliteDb.prepare(
        'UPDATE users SET username=?, password_hash=? WHERE id=?'
      ).run(normalized.username, normalized.passwordHash, normalized.id);
      return;
    }
    const byUsername = sqliteDb.prepare(
      'SELECT id FROM users WHERE LOWER(username)=LOWER(?) LIMIT 1'
    ).get(normalized.username);
    if (!byUsername) {
      sqliteDb.prepare(
        'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)'
      ).run(normalized.id, normalized.username, normalized.passwordHash, normalized.createdAt);
    }
  }

  function createSessionStore(session) {
    return class PostgresSessionStore extends session.Store {
      get(sid, callback) {
        pool.query('SELECT sess, expired FROM app_auth_sessions WHERE sid=$1', [sid])
          .then(result => {
            const row = result.rows[0];
            if (!row || (Number.isFinite(Number(row.expired)) && Number(row.expired) <= Date.now())) {
              if (row) pool.query('DELETE FROM app_auth_sessions WHERE sid=$1', [sid]).catch(() => {});
              callback(null, null);
              return;
            }
            callback(null, JSON.parse(row.sess));
          })
          .catch(callback);
      }

      set(sid, sessionData, callback = () => {}) {
        const expired = sessionExpiry(sessionData, sessionTtlMs);
        pool.query(
          `INSERT INTO app_auth_sessions (sid, expired, sess) VALUES ($1, $2, $3)
           ON CONFLICT (sid) DO UPDATE SET expired=EXCLUDED.expired, sess=EXCLUDED.sess`,
          [sid, expired, JSON.stringify(sessionData)]
        ).then(() => callback(null)).catch(callback);
      }

      touch(sid, sessionData, callback = () => {}) {
        const expired = sessionExpiry(sessionData, sessionTtlMs);
        pool.query(
          `UPDATE app_auth_sessions SET expired=$1, sess=$2 WHERE sid=$3`,
          [expired, JSON.stringify(sessionData), sid]
        ).then(() => callback(null)).catch(callback);
      }

      destroy(sid, callback = () => {}) {
        pool.query('DELETE FROM app_auth_sessions WHERE sid=$1', [sid])
          .then(() => callback(null)).catch(callback);
      }

      clear(callback = () => {}) {
        pool.query('DELETE FROM app_auth_sessions').then(() => callback(null)).catch(callback);
      }

      length(callback) {
        pool.query(
          'DELETE FROM app_auth_sessions WHERE expired IS NOT NULL AND expired <= $1',
          [Date.now()]
        ).then(() => pool.query('SELECT COUNT(*)::int AS count FROM app_auth_sessions'))
          .then(result => callback(null, result.rows[0].count))
          .catch(callback);
      }
    };
  }

  return {
    init,
    retireLegacyUsername,
    findUserByUsername,
    findUserById,
    createUser,
    updatePassword,
    syncSqliteUser,
    createSessionStore,
    close: () => pool.end(),
  };
}

module.exports = { createPostgresAuthStore };