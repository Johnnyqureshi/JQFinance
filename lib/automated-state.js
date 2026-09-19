'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');

const SNAPSHOT_SCHEMA_VERSION = 1;
const FENCE_LEASE_MS = 30_000;

function checksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function connectivityError(error) {
  const code = String(error?.code || '').toUpperCase();
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|57P0|08)/.test(code)
    || /connection\s+(?:terminated|timeout|refused|reset)|timed?\s*out/i.test(String(error?.message || ''));
}

function createPool(databaseUrl, injectedPool) {
  if (injectedPool) return injectedPool;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for automated-state durability.');
  return new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 8_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    maxLifetimeSeconds: 300,
  });
}

function createAutomatedState({ databaseUrl, db, injectedPool, ownerId = process.env.AUTOMATED_STATE_OWNER_ID || crypto.randomUUID() }) {
  if (!db) throw new Error('A dedicated automated SQLite database is required.');
  const pool = createPool(databaseUrl, injectedPool);
  let ready = false;
  let fenced = false;
  let epoch = null;
  let generation = 0;
  let queue = Promise.resolve();
  let stopping = false;
  let draining = false;

  pool.on?.('error', error => {
    console.error('[AutomatedState] PostgreSQL pool error:', error.message);
  });

  async function query(sql, params = []) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await pool.query(sql, params);
      } catch (error) {
        if (!connectivityError(error) || attempt) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    throw new Error('Automated state PostgreSQL query failed.');
  }

  async function init() {
    const result = await query(`
      SELECT to_regclass('public.automated_trading_snapshots') AS snapshots,
             to_regclass('public.automated_trading_fences') AS fences
    `);
    if (!result.rows[0]?.snapshots || !result.rows[0]?.fences) {
      throw new Error('Automated-state PostgreSQL schema is missing; apply it through development schema flow and Publish.');
    }
    const snapshot = await query(`
      SELECT generation, schema_version, sha256
      FROM automated_trading_snapshots WHERE singleton=TRUE
    `);
    if (snapshot.rowCount) {
      if (Number(snapshot.rows[0].schema_version) !== SNAPSHOT_SCHEMA_VERSION
          || !/^[0-9a-f]{64}$/.test(snapshot.rows[0].sha256)) {
        throw new Error('Automated-state snapshot metadata is invalid; refusing startup.');
      }
      generation = Number(snapshot.rows[0].generation);
    }
    ready = true;
    return { ready: true };
  }

  async function acquireFence() {
    if (!ready) throw new Error('Automated-state persistence is unavailable.');
    const result = await query(`
      INSERT INTO automated_trading_fences(owner_id, epoch, lease_until, updated_at)
      VALUES ($1, 1, NOW() + ($2 || ' milliseconds')::interval, NOW())
      ON CONFLICT (singleton) DO UPDATE
      SET owner_id = EXCLUDED.owner_id, epoch = automated_trading_fences.epoch + 1,
          lease_until = EXCLUDED.lease_until, updated_at = NOW()
       WHERE automated_trading_fences.owner_id IS NULL
          OR automated_trading_fences.lease_until IS NULL
          OR automated_trading_fences.lease_until < NOW()
         OR automated_trading_fences.owner_id = EXCLUDED.owner_id
      RETURNING epoch
    `, [ownerId, FENCE_LEASE_MS]);
    if (!result.rowCount) throw new Error('Another automated trading VM currently owns the dispatch fence.');
    epoch = Number(result.rows[0].epoch);
    fenced = true;
    return epoch;
  }

  async function heartbeat() {
    if (!fenced || epoch == null) return false;
    const result = await query(`
      UPDATE automated_trading_fences
      SET lease_until = NOW() + ($1 || ' milliseconds')::interval, updated_at = NOW()
      WHERE singleton=TRUE AND owner_id=$2 AND epoch=$3 AND lease_until > NOW()
      RETURNING epoch
    `, [FENCE_LEASE_MS, ownerId, epoch]);
    if (!result.rowCount) {
      fenced = false;
      ready = false;
    }
    return !!result.rowCount;
  }

  async function health() {
    if (!ready || !fenced || epoch == null || stopping) return { ready: false };
    const result = await query(`
      SELECT 1
      FROM automated_trading_fences
      WHERE singleton=TRUE AND owner_id=$1 AND epoch=$2 AND lease_until > NOW()
    `, [ownerId, epoch]);
    return { ready: result.rowCount === 1 };
  }

  function assertFence() {
    if (!ready || !fenced || epoch == null || (stopping && !draining)) {
      throw new Error('Automated trading fence is not active; broker action withheld.');
    }
  }

  function serialize() {
    const image = db.serialize({ attached: 'main' });
    if (!Buffer.isBuffer(image) || !image.length) throw new Error('Automated SQLite serialization returned an empty image.');
    return image;
  }

  async function checkpoint(reason = 'mutation') {
    assertFence();
    const image = serialize();
    const digest = checksum(image);
    const nextGeneration = generation + 1;
    const expectedGeneration = generation;
    const result = await query(`
      INSERT INTO automated_trading_snapshots
        (singleton, generation, schema_version, sha256, image, fence_epoch, fence_owner, reason, committed_at)
      SELECT TRUE, $2, $3, $4, $5, $6, $7, $8, NOW()
      WHERE COALESCE((SELECT generation FROM automated_trading_snapshots WHERE singleton=TRUE), 0) = $1
        AND EXISTS (
        SELECT 1 FROM automated_trading_fences
        WHERE singleton=TRUE AND owner_id=$7 AND epoch=$6 AND lease_until > NOW()
      )
      ON CONFLICT (singleton) DO UPDATE
      SET generation=EXCLUDED.generation, schema_version=EXCLUDED.schema_version,
          sha256=EXCLUDED.sha256, image=EXCLUDED.image, fence_epoch=EXCLUDED.fence_epoch,
          fence_owner=EXCLUDED.fence_owner, reason=EXCLUDED.reason, committed_at=NOW()
      WHERE automated_trading_snapshots.fence_epoch <= EXCLUDED.fence_epoch
      RETURNING generation
    `, [expectedGeneration, nextGeneration, SNAPSHOT_SCHEMA_VERSION, digest, image, epoch, ownerId, String(reason).slice(0, 120)]);
    if (!result.rowCount) {
      fenced = false;
      throw new Error('Automated-state checkpoint lost the active fence; broker action withheld.');
    }
    generation = Number(result.rows[0].generation);
    return { generation, sha256: digest };
  }

  function flush(reason) {
    if (stopping) return Promise.reject(new Error('Automated state is shutting down; new work is withheld.'));
    const operation = queue.then(() => checkpoint(reason));
    queue = operation.catch(() => {});
    return operation;
  }

  async function releaseFence() {
    stopping = true;
    draining = true;
    try {
      await queue;
      // Do not surrender ownership or report a clean shutdown unless the last
      // local image is durably committed under the active fence.
      if (fenced) await checkpoint('shutdown-final');
      if (fenced) {
        await query(
          'UPDATE automated_trading_fences SET lease_until=NOW(), updated_at=NOW() WHERE singleton=TRUE AND owner_id=$1 AND epoch=$2',
          [ownerId, epoch],
        );
      }
      fenced = false;
    } finally {
      draining = false;
    }
  }

  return {
    init, acquireFence, heartbeat, health, assertFence, checkpoint, flush, releaseFence,
    isReady: () => ready && fenced && !stopping,
    ownerId: () => ownerId,
    epoch: () => epoch,
    generation: () => generation,
    stop: releaseFence,
    close: () => injectedPool ? Promise.resolve() : pool.end(),
    checksum,
  };
}

async function restoreAutomatedSnapshot({ databaseUrl, dbPath, injectedPool } = {}) {
  const pool = createPool(databaseUrl, injectedPool);
  try {
    const result = await pool.query(`
      SELECT generation, schema_version, sha256, image
      FROM automated_trading_snapshots
      WHERE singleton=TRUE
      LIMIT 1
    `);
    if (!result.rowCount) return { restored: false, reason: 'no-snapshot' };
    const row = result.rows[0];
    const image = Buffer.isBuffer(row.image) ? row.image : Buffer.from(row.image, 'base64');
    if (Number(row.schema_version) !== SNAPSHOT_SCHEMA_VERSION || checksum(image) !== row.sha256) {
      throw new Error('Automated trading snapshot checksum or schema validation failed; refusing startup.');
    }
    const temp = `${dbPath}.restore-${process.pid}`;
    fs.writeFileSync(temp, image, { mode: 0o600 });
    fs.renameSync(temp, dbPath);
    return { restored: true, generation: Number(row.generation) };
  } finally {
    if (!injectedPool) await pool.end();
  }
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  createAutomatedState,
  restoreAutomatedSnapshot,
  checksum,
};