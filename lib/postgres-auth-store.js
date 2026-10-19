'use strict';

const { Pool } = require('pg');

const MIN_GLOBAL_USER_ID = 1_000_000_000;

function isPostgresConnectivityError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|57P01|57P02|57P03|08000|08001|08003|08006|08007|08P01)$/.test(code)) {
    return true;
  }
  return /connection\s+(?:terminated|timeout|refused|reset)|connect(?:ion)?\s+tim(?:e|ed)\s*out|timeout expired|server closed the connection/i
    .test(String(error?.message || ''));
}

// Login accepts EITHER the username OR the account email as the identifier
// (Johnny 2026-10-18: a live demo login failed with "invalid username or
// password" because the sign-in form only ever resolved the username column —
// typing the account's email address could never match). Usernames cannot
// contain '@' (registration regex), so the identifier kind is unambiguous.
function classifyLoginIdentifier(identifier) {
  const value = String(identifier ?? '').trim();
  return value.includes('@')
    ? { kind: 'email', value }
    : { kind: 'username', value };
}

async function resolveLoginUser(identifier, { findByEmail, findByUsername }) {
  const { kind, value } = classifyLoginIdentifier(identifier);
  if (!value) return null;
  return kind === 'email' ? findByEmail(value) : findByUsername(value);
}

// Safe per-account inspection for operator logs: identity + verification +
// session facts only. The password hash is NEVER copied — only its format
// class ('bcrypt' vs 'other'), which is what an operator needs to spot an
// account whose credential was stored by a non-bcrypt path.
function summarizeAuthUserRow(row, extras = {}) {
  const hash = String(row?.password_hash || '');
  const hashFormat = /^\$2[aby]\$\d{2}\$/.test(hash) && hash.length === 60 ? 'bcrypt' : 'other';
  return {
    id: Number(row.id),
    username: row.username,
    email_stored: row.email ?? null,
    email_verified: row.email_verified === true,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at ?? null),
    hash_format: hashFormat,
    ...extras,
  };
}

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
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    maxLifetimeSeconds: 300,
  });
  // A managed PostgreSQL restart can terminate an idle client. pg emits that
  // error on the pool; without a listener Node treats it as uncaught and the
  // entire application exits.
  let lastPoolError = '';
  let lastPoolErrorAt = 0;
  pool.on('error', error => {
    // A managed database can close several idle clients together. Keep the
    // process alive and avoid turning a burst into an outage-shaped log storm.
    const now = Date.now();
    if (error.message !== lastPoolError || now - lastPoolErrorAt >= 30_000) {
      console.error('[Auth] PostgreSQL pool connection error:', error.message);
      lastPoolError = error.message;
      lastPoolErrorAt = now;
    }
  });

  async function queryWithRetry(text, values) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await pool.query(text, values);
      } catch (error) {
        if (!isPostgresConnectivityError(error) || attempt === 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    throw new Error('PostgreSQL query failed.');
  }

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
    // One-way AND one-shot: if a retired row already exists, this migration
    // has run. Never touch the username again, so the owner can safely
    // re-register it afterwards without a later boot re-retiring the fresh
    // account.
    const already = await pool.query(
      `SELECT 1 FROM app_auth_users WHERE username LIKE 'retired-bootstrap-%' LIMIT 1`
    );
    if (already.rowCount) return false;
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
    // A retired account must not keep working on a stale cookie: kill every
    // session that carries its userId. (The SQLite-side retirement already
    // did this for sessions.db; production sessions live in Postgres.)
    await pool.query(
      `DELETE FROM app_auth_sessions WHERE sess LIKE $1 OR sess LIKE $2`,
      [`%"userId":${userId}%`, `%"userId": ${userId}%`]
    );
    return true;
  }

  // Frees an email held by the retired bootstrap row so the owner can
  // re-register. The retired row is dead (random password, no sessions, no
  // broker creds), so its email is just a leftover — but it would otherwise
  // make the "create a new account" recovery path impossible with
  // EMAIL_TAKEN. A no-op unless a retired row actually holds the email.
  async function releaseRetiredEmail(email) {
    if (!email) return;
    await pool.query(
      `UPDATE app_auth_users SET email = NULL
       WHERE LOWER(email) = LOWER($1) AND username LIKE 'retired-bootstrap-%'`,
      [email]
    );
  }

  async function findUserByUsername(username) {
    // Case-insensitive AND whitespace-tolerant on the stored side too (a
    // legacy/migrated row must match the same identifier the user types),
    // oldest row wins if legacy duplicates ever exist.
    const result = await pool.query(
      `SELECT id, username, password_hash, created_at, email, email_verified
       FROM app_auth_users
       WHERE LOWER(TRIM(username)) = LOWER($1)
       ORDER BY id ASC
       LIMIT 1`,
      [username]
    );
    return result.rows[0] || null;
  }

  async function findUserById(userId) {
    const result = await pool.query(
      'SELECT id, username, password_hash, created_at, email, email_verified FROM app_auth_users WHERE id=$1 LIMIT 1',
      [userId]
    );
    return result.rows[0] || null;
  }

  async function findUserByEmail(email) {
    const result = await pool.query(
      `SELECT id, username, password_hash, created_at, email, email_verified
       FROM app_auth_users
       WHERE LOWER(TRIM(email)) = LOWER($1)
       ORDER BY id ASC
       LIMIT 1`,
      [email]
    );
    return result.rows[0] || null;
  }

  // Sign-in lookup: the identifier may be the username OR the account email.
  async function findUserByLoginIdentifier(identifier) {
    return resolveLoginUser(identifier, { findByEmail: findUserByEmail, findByUsername: findUserByUsername });
  }

  // Adds the email-verification columns to the managed auth schema. Safe to
  // run on every startup (IF NOT EXISTS).
  async function ensureEmailVerificationColumns() {
    await pool.query('ALTER TABLE app_auth_users ADD COLUMN IF NOT EXISTS email TEXT');
    await pool.query('ALTER TABLE app_auth_users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE');
  }

  async function markEmailVerified(userId) {
    await pool.query('UPDATE app_auth_users SET email_verified=TRUE WHERE id=$1', [userId]);
  }

  // One-time: mark every pre-existing account verified so nobody is locked
  // out. Sentinel row makes this run exactly once.
  async function grandfatherAllUsers() {
    await pool.query('CREATE TABLE IF NOT EXISTS auth_schema_meta (key TEXT PRIMARY KEY, value TEXT)');
    const done = await pool.query(
      "SELECT 1 FROM auth_schema_meta WHERE key='email_verification_grandfathered'"
    );
    if (done.rowCount) return 0;
    const res = await pool.query(
      'UPDATE app_auth_users SET email_verified=TRUE WHERE COALESCE(email_verified, FALSE) = FALSE'
    );
    await pool.query(
      "INSERT INTO auth_schema_meta (key, value) VALUES ('email_verification_grandfathered', NOW()::text)"
    );
    return res.rowCount;
  }

  // One-shot, owner-requested force-logout (Johnny 2026-10-18): purge every
  // web session belonging to the account(s) registered under `email`, exactly
  // once (sentinel row in auth_schema_meta, claimed under an advisory lock so
  // overlapping rolling-deploy instances cannot race it). This is a LOGOUT,
  // not a suspension: the user row, password, subscription and bot state are
  // untouched, and the account can sign straight back in. Returns a safe
  // inspection summary (see summarizeAuthUserRow — never any hash or session
  // content) including session counts before/after, so the operator can prove
  // the purge from the boot log.
  async function forceLogoutByEmailOnce(email, sentinelKey) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [872043220]);
      await client.query('CREATE TABLE IF NOT EXISTS auth_schema_meta (key TEXT PRIMARY KEY, value TEXT)');
      const done = await client.query('SELECT 1 FROM auth_schema_meta WHERE key=$1', [sentinelKey]);
      if (done.rowCount) {
        await client.query('COMMIT');
        return { alreadyDone: true };
      }
      const rows = (await client.query(
        `SELECT id, username, password_hash, created_at, email, email_verified
         FROM app_auth_users
         WHERE LOWER(TRIM(email)) = LOWER($1)
         ORDER BY id ASC`,
        [email]
      )).rows;
      const accounts = [];
      for (const row of rows) {
        const uid = Number(row.id);
        const patterns = [`%"userId":${uid}%`, `%"userId": ${uid}%`];
        const dup = await client.query(
          'SELECT COUNT(*)::int AS n FROM app_auth_users WHERE LOWER(TRIM(username)) = LOWER($1)',
          [row.username]
        );
        const before = await client.query(
          'SELECT COUNT(*)::int AS n FROM app_auth_sessions WHERE sess LIKE $1 OR sess LIKE $2',
          patterns
        );
        const deleted = await client.query(
          'DELETE FROM app_auth_sessions WHERE sess LIKE $1 OR sess LIKE $2',
          patterns
        );
        const after = await client.query(
          'SELECT COUNT(*)::int AS n FROM app_auth_sessions WHERE sess LIKE $1 OR sess LIKE $2',
          patterns
        );
        accounts.push(summarizeAuthUserRow(row, {
          duplicate_username_rows: dup.rows[0].n,
          sessions_before: before.rows[0].n,
          sessions_deleted: deleted.rowCount || 0,
          sessions_after: after.rows[0].n,
        }));
      }
      const summary = { alreadyDone: false, email_queried: email, found: rows.length > 0, accounts };
      await client.query(
        'INSERT INTO auth_schema_meta (key, value) VALUES ($1, $2)',
        [sentinelKey, JSON.stringify(summary)]
      );
      await client.query('COMMIT');
      return summary;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function createUser(username, passwordHash, email = null) {
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
      if (email) {
        const emailTaken = await client.query(
          'SELECT 1 FROM app_auth_users WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [email]
        );
        if (emailTaken.rowCount) {
          await client.query('ROLLBACK');
          const err = new Error('Email already registered.');
          err.code = 'EMAIL_TAKEN';
          throw err;
        }
      }
      const nextId = await client.query(
        `SELECT GREATEST(COALESCE(MAX(id), 0) + 1, $1::bigint) AS id
         FROM app_auth_users`,
        [MIN_GLOBAL_USER_ID]
      );
      const id = nextId.rows[0].id;
      const inserted = await client.query(
        `INSERT INTO app_auth_users (id, username, password_hash, email, email_verified)
         VALUES ($1, $2, $3, $4, FALSE)
         RETURNING id, username, password_hash, created_at, email, email_verified`,
        [id, username, passwordHash, email]
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
      email: typeof user.email === 'string' ? user.email : null,
      emailVerified: user.email_verified === true || user.email_verified === 1 || user.email_verified === 't' ? 1 : 0,
    };
    // Older SQLite mirrors may not have the email columns yet; only sync the
    // fields the local schema actually has.
    let hasEmailCols = false;
    try {
      const cols = sqliteDb.prepare('PRAGMA table_info(users)').all().map(c => c.name);
      hasEmailCols = cols.includes('email') && cols.includes('email_verified');
    } catch (_) { /* fall through to username/password-only sync */ }
    const byId = sqliteDb.prepare('SELECT id FROM users WHERE id=?').get(normalized.id);
    if (byId) {
      const localById = sqliteDb.prepare(
        'SELECT id, username FROM users WHERE id=? LIMIT 1'
      ).get(normalized.id);
      if (localById && localById.username.toLowerCase() !== normalized.username.toLowerCase()) {
        // Postgres is the authoritative identity store (the session was already
        // validated against it before this sync runs). A stale local mirror row
        // must follow it, not block authenticated requests.
        try { console.warn(`[Auth] Local user mirror id=${normalized.id} had stale username "${localById.username}"; updating to "${normalized.username}".`); } catch (_) {}
      }
      sqliteDb.prepare(
        hasEmailCols
          ? 'UPDATE users SET username=?, password_hash=?, email=?, email_verified=? WHERE id=?'
          : 'UPDATE users SET username=?, password_hash=? WHERE id=?'
      ).run(
        ...(hasEmailCols
          ? [normalized.username, normalized.passwordHash, normalized.email, normalized.emailVerified, normalized.id]
          : [normalized.username, normalized.passwordHash, normalized.id])
      );
      return;
    }
    const byUsername = sqliteDb.prepare(
      'SELECT id, username FROM users WHERE LOWER(username)=LOWER(?) LIMIT 1'
    ).get(normalized.username);
    if (byUsername && Number(byUsername.id) !== normalized.id) {
      throw new Error('Shared auth identity collision: local username belongs to a different user ID.');
    }
    if (!byUsername) {
      sqliteDb.prepare(
        hasEmailCols
          ? 'INSERT INTO users (id, username, password_hash, created_at, email, email_verified) VALUES (?, ?, ?, ?, ?, ?)'
          : 'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)'
      ).run(
        ...(hasEmailCols
          ? [normalized.id, normalized.username, normalized.passwordHash, normalized.createdAt, normalized.email, normalized.emailVerified]
          : [normalized.id, normalized.username, normalized.passwordHash, normalized.createdAt])
      );
    }
  }

  function createSessionStore(session) {
    return class PostgresSessionStore extends session.Store {
      get(sid, callback) {
        queryWithRetry('SELECT sess, expired FROM app_auth_sessions WHERE sid=$1', [sid])
          .then(result => {
            const row = result.rows[0];
            if (!row || (Number.isFinite(Number(row.expired)) && Number(row.expired) <= Date.now())) {
              if (row) queryWithRetry('DELETE FROM app_auth_sessions WHERE sid=$1', [sid]).catch(() => {});
              callback(null, null);
              return;
            }
            callback(null, JSON.parse(row.sess));
          })
          .catch(callback);
      }

      set(sid, sessionData, callback = () => {}) {
        const expired = sessionExpiry(sessionData, sessionTtlMs);
        queryWithRetry(
          `INSERT INTO app_auth_sessions (sid, expired, sess) VALUES ($1, $2, $3)
           ON CONFLICT (sid) DO UPDATE SET expired=EXCLUDED.expired, sess=EXCLUDED.sess`,
          [sid, expired, JSON.stringify(sessionData)]
        ).then(() => callback(null)).catch(callback);
      }

      touch(sid, sessionData, callback = () => {}) {
        const expired = sessionExpiry(sessionData, sessionTtlMs);
        queryWithRetry(
          `UPDATE app_auth_sessions SET expired=$1, sess=$2 WHERE sid=$3`,
          [expired, JSON.stringify(sessionData), sid]
        ).then(() => callback(null)).catch(callback);
      }

      destroy(sid, callback = () => {}) {
        queryWithRetry('DELETE FROM app_auth_sessions WHERE sid=$1', [sid])
          .then(() => callback(null)).catch(callback);
      }

      clear(callback = () => {}) {
        queryWithRetry('DELETE FROM app_auth_sessions').then(() => callback(null)).catch(callback);
      }

      length(callback) {
        queryWithRetry(
          'DELETE FROM app_auth_sessions WHERE expired IS NOT NULL AND expired <= $1',
          [Date.now()]
        ).then(() => queryWithRetry('SELECT COUNT(*)::int AS count FROM app_auth_sessions'))
          .then(result => callback(null, result.rows[0].count))
          .catch(callback);
      }
    };
  }

  return {
    init,
    retireLegacyUsername,
    releaseRetiredEmail,
    // Retired-account session hygiene: the bootstrap retirement renames the
    // user row but any session minted before it survives in Postgres. These
    // let the server enumerate retired ids and purge their sessions (run at
    // boot; idempotent).
    listRetiredUserIds: async () => {
      const r = await queryWithRetry(
        `SELECT id FROM app_auth_users WHERE username LIKE 'retired-bootstrap-%'`
      );
      return r.rows.map(x => Number(x.id));
    },
    deleteSessionsForUserIds: async (ids) => {
      let total = 0;
      for (const id of ids) {
        const r = await queryWithRetry(
          `DELETE FROM app_auth_sessions WHERE sess LIKE $1 OR sess LIKE $2`,
          [`%"userId":${Number(id)}%`, `%"userId": ${Number(id)}%`]
        );
        total += r.rowCount || 0;
      }
      return total;
    },
    findUserByUsername,
    findUserById,
    findUserByEmail,
    findUserByLoginIdentifier,
    forceLogoutByEmailOnce,
    createUser,
    updatePassword,
    ensureEmailVerificationColumns,
    markEmailVerified,
    grandfatherAllUsers,
    syncSqliteUser,
    createSessionStore,
    isPostgresConnectivityError,
    close: () => pool.end(),
  };
}

module.exports = {
  createPostgresAuthStore,
  isPostgresConnectivityError,
  classifyLoginIdentifier,
  resolveLoginUser,
  summarizeAuthUserRow,
};