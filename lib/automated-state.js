'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');

const SNAPSHOT_SCHEMA_VERSION = 1;
const FENCE_LEASE_MS = 30_000;

// Singles & Doubles was deleted 2026-09-29. Its tables must never come back:
// drop them at boot (after the durable snapshot is restored) so the local
// image — and therefore the next startup checkpoint — converges to a post-S&D
// state. broker_account_owners rows for the retired scope are removed first so
// no dangling scope references survive.
const RETIRED_SD_TABLES = Object.freeze([
  'sd_settings', 'sd_credentials', 'sd_trades', 'sd_exit_fills',
  'sd_close_attempts', 'sd_scan_runs', 'sd_rejections', 'sd_candidates',
  'sd_universe', 'sd_coverage', 'sd_leases', 'sd_alerts',
]);
const RETIRED_SD_SCOPE = 'singles_doubles';

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

  // Re-reads the snapshot generation. The previous fence holder checkpoints
  // during its graceful drain, which can land after init() read the
  // generation — call this after acquiring the fence (when this instance is
  // the sole writer) so the next checkpoint's optimistic generation check
  // sees the latest value.
  async function refreshGeneration() {
    const snapshot = await query(
      `SELECT generation FROM automated_trading_snapshots WHERE singleton=TRUE`
    );
    if (snapshot.rowCount) generation = Number(snapshot.rows[0].generation);
    return generation;
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

  // Defense in depth: never let a fresh/empty local database overwrite an
  // existing durable snapshot. If the snapshot restore was skipped or failed
  // (e.g. wrong start command), the local bot tables are empty and a
  // checkpoint here would permanently destroy the good snapshot.
  function localIdentityRowCount() {
    try {
      let n = 0;
      // B2, Warrior and Flipper identity tables: a Flipper-only database must
      // not be mistaken for an empty image. Durable coverage enumerates every
      // flipper_* table created by lib/flipper/service.js — the full SQLite
      // image is snapshotted (nothing is filtered out):
      //   flipper_settings, flipper_credentials (identity)
      //   flipper_walls, flipper_setups, flipper_positions (live state)
      //   flipper_trades, flipper_scan_runs, flipper_alerts,
      //   flipper_backtests, flipper_backtest_trades (history/diagnostics)
      //   flipper_leases (op leases)
      for (const t of ['warrior_credentials', 'warrior_settings',
        'flipper_credentials', 'flipper_settings']) {
        try { n += Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n || 0); }
        catch (_) { /* table not created yet; ignore */ }
      }
      return n;
    } catch (_) { return -1; } // unknown state: do not block the checkpoint
  }

  async function checkpoint(reason = 'mutation') {
    assertFence();
    const prior = await query(`SELECT generation FROM automated_trading_snapshots WHERE singleton=TRUE`);
    // Refuse only when this boot did NOT restore the snapshot (scripts/boot.js
    // sets AUTOMATED_STATE_RESTORED=true after a successful restore). If the
    // restore ran, the local image IS the snapshot's content — even when empty
    // — and checkpointing it is correct.
    if (prior.rowCount && localIdentityRowCount() === 0 && process.env.AUTOMATED_STATE_RESTORED !== 'true') {
      throw new Error('Automated-state checkpoint refused: local bot database holds no credentials or settings while a durable snapshot exists; refusing to overwrite it with an empty image.');
    }
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

  // Boot-time migration for the deleted Singles & Doubles bot: drops every
  // sd_* table and removes its broker_account_owners scope rows. Idempotent —
  // DROP TABLE IF EXISTS is a no-op once the tables are gone. Called from the
  // server startup chain after fence acquisition and before the startup
  // checkpoint, so the drop propagates into the durable snapshot.
  function dropRetiredSdTables() {
    db.transaction(() => {
      const registry = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_account_owners'").get();
      if (registry) db.prepare('DELETE FROM broker_account_owners WHERE scope=?').run(RETIRED_SD_SCOPE);
      for (const table of RETIRED_SD_TABLES) db.exec(`DROP TABLE IF EXISTS "${table}"`);
    })();
    return { dropped: RETIRED_SD_TABLES.length };
  }

  // Warrior rejection log was retired 2026-09-29 (Johnny: no zombie data).
  // Rejections are funnel counts only; the old per-symbol table is dropped.
  function dropRetiredWarriorRejectionTable() {
    db.exec('DROP TABLE IF EXISTS "warrior_rejections"');
    return { dropped: 1 };
  }

  // All bots paused 2026-09-29 on Johnny's order ("pause all bots").
  // One-shot: records itself in boot_migrations so a later re-enable by
  // Johnny is never undone by a subsequent redeploy. Mirrors the paused
  // state each bot's own settings flow writes.
  function pauseAllBotsOnce() {
    db.exec(`CREATE TABLE IF NOT EXISTS boot_migrations (
      name TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const done = db.prepare(`SELECT 1 FROM boot_migrations WHERE name='pause-all-bots-20260929'`).get();
    if (done) return { skipped: true };
    db.transaction(() => {
      // B2 deleted 2026-10-01: its settings table no longer exists.
      db.prepare(`UPDATE warrior_settings
        SET enabled=0, scheduler_status='idle', scheduler_reason=NULL`).run();
      db.prepare(`UPDATE crypto_settings
        SET enabled=0, scheduler_status='idle', scheduler_reason=NULL`).run();
      db.prepare(`INSERT INTO boot_migrations(name) VALUES('pause-all-bots-20260929')`).run();
    })();
    return { paused: true };
  }

  // b2_close_attempts retired 2026-09-29 (Johnny: no zombie data).
  // Write-only diagnostic with zero readers anywhere.
  function dropRetiredB2CloseAttempts() {
    db.exec('DROP TABLE IF EXISTS "b2_close_attempts"');
    return { dropped: 1 };
  }

  // crypto_journal retired 2026-09-29 (Johnny: no zombie data).
  // Dead table: no API route or UI ever consumed it.
  function dropRetiredCryptoJournal() {
    db.exec('DROP TABLE IF EXISTS "crypto_journal"');
    return { dropped: 1 };
  }

  // Warrior price band 2026-09-29 (Johnny: $0.10 min / $20 max).
  // Patches stored rules still on the old 0.50/50.00 defaults; rows with a
  // deliberate custom price band are left alone. One-shot via boot_migrations.
  function applyWarriorPriceBand() {
    const done = db.prepare(`SELECT 1 FROM boot_migrations WHERE name='warrior-price-band-20260929'`).get();
    if (done) return { skipped: true };
    const rows = db.prepare(`SELECT user_id, rules FROM warrior_settings`).all();
    for (const row of rows) {
      let stored = {};
      try { stored = JSON.parse(row.rules || '{}'); } catch (_) { stored = {}; }
      let changed = false;
      if (stored.minPrice === 0.5) { stored.minPrice = 0.1; changed = true; }
      if (stored.maxPrice === 50) { stored.maxPrice = 20; changed = true; }
      if (changed) db.prepare(`UPDATE warrior_settings SET rules=? WHERE user_id=?`)
        .run(JSON.stringify(stored), row.user_id);
    }
    db.prepare(`INSERT INTO boot_migrations(name) VALUES('warrior-price-band-20260929')`).run();
    return { patched: true };
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
    init, acquireFence, refreshGeneration, heartbeat, health, assertFence, checkpoint, flush, releaseFence,
    dropRetiredSdTables, dropRetiredWarriorRejectionTable, pauseAllBotsOnce,
    dropRetiredB2CloseAttempts, dropRetiredCryptoJournal, applyWarriorPriceBand,
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
  RETIRED_SD_TABLES,
  RETIRED_SD_SCOPE,
  createAutomatedState,
  restoreAutomatedSnapshot,
  checksum,
};