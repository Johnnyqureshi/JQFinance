'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const SNAPSHOT_SCHEMA_VERSION = 1;
const FENCE_LEASE_MS = 30_000;
const QUERY_TIMEOUT_MS = 10_000;

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
  return code === 'QUERY_TIMEOUT'
    || /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|57P0|57014|08)/.test(code)
    || /connection\s+(?:terminated|timeout|refused|reset)|timed?\s*out|query read timeout|statement timeout/i.test(String(error?.message || ''));
}

function createPool(databaseUrl, injectedPool) {
  if (injectedPool) return injectedPool;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for automated-state durability.');
  return new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 8_000,
    // A platform stall that freezes Postgres mid-query must not wedge a
    // pool client forever: pg aborts the query and destroys the wedged
    // connection when the read timeout fires, so later queries get a
    // fresh connection. query() below enforces the same bound itself.
    query_timeout: QUERY_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    maxLifetimeSeconds: 300,
  });
}

function createAutomatedState({ databaseUrl, db, injectedPool, ownerId = process.env.AUTOMATED_STATE_OWNER_ID || crypto.randomUUID(), checkpointMinIntervalMs = 60_000, queryTimeoutMs = QUERY_TIMEOUT_MS }) {
  if (!db) throw new Error('A dedicated automated SQLite database is required.');
  const pool = createPool(databaseUrl, injectedPool);
  let ready = false;
  let initialized = false;
  let fenced = false;
  let epoch = null;
  let generation = 0;
  let queue = Promise.resolve();
  let stopping = false;
  let draining = false;
  // Checkpoint throttle: mutation checkpoints used to rewrite the full
  // durable image on every state change, bloating the snapshot table's file
  // until Postgres ran out of disk (2026-10-01). Mutation flushes now
  // coalesce to one checkpoint per checkpointMinIntervalMs; a dirty flag +
  // trailing run guarantee the latest state still lands. Startup and
  // shutdown checkpoints bypass the throttle entirely.
  let lastCheckpointAt = 0;
  let mutationDirty = false;
  let mutationReason = 'mutation';
  let mutationTimer = null;
  let mutationWaiters = [];

  pool.on?.('error', error => {
    console.error('[AutomatedState] PostgreSQL pool error:', error.message);
  });

  // Bound every query: when Postgres is frozen by a platform stall, a
  // query on a dead socket otherwise never settles, wedging the heartbeat,
  // the checkpoint queue, and the readiness probe behind it. The timeout
  // error is connectivity-class, so the retry below re-runs the query on
  // a fresh connection (the pool's own query_timeout destroys the wedged
  // one). Recovery from the interruption itself lives in recoverFence().
  function queryWithTimeout(sql, params) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Automated state PostgreSQL query timed out after ${queryTimeoutMs}ms.`);
        error.code = 'QUERY_TIMEOUT';
        reject(error);
      }, queryTimeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([pool.query(sql, params), timeout])
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  async function query(sql, params = []) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await queryWithTimeout(sql, params);
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
    initialized = true;
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
    if (!initialized) throw new Error('Automated-state persistence is unavailable.');
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
      // The lease lapsed while Postgres was unreachable (a stall longer
      // than the 30s lease). Losing the fence must fail closed, but it
      // must NOT latch the state store shut: `ready` stays true so
      // recoverFence() can re-acquire through the same lease protocol
      // once Postgres answers again. (Before 2026-10-04 this also set
      // ready=false, and nothing ever re-acquired — a transient stall
      // became a permanent outage that only a manual redeploy cleared.)
      fenced = false;
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

  let serializeCounter = 0;
  function serialize() {
    // Compact before storing: VACUUM INTO writes a defragmented copy, so the
    // durable image carries no SQLite free pages. Any failure falls back to
    // the raw in-memory image — compaction must never block a checkpoint.
    try {
      const tmp = path.join(os.tmpdir(), `jqf-automated-state-${process.pid}-${(serializeCounter += 1)}.db`);
      try {
        db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        const compacted = fs.readFileSync(tmp);
        if (Buffer.isBuffer(compacted) && compacted.length) return compacted;
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) { /* best effort cleanup */ }
      }
    } catch (_) { /* fall through to the raw image */ }
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
      // Warrior identity tables: the full SQLite image is snapshotted
      // (nothing is filtered out), and these rows are the guard against
      // mistaking a fresh/empty local database for a live image. (B2 was
      // deleted 2026-10-01, crypto 2026-10-07, Flipper 2026-10-12, ORB
      // 2026-10-14.)
      for (const t of ['warrior_credentials', 'warrior_settings']) {
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
    lastCheckpointAt = Date.now();
    return { generation, sha256: digest };
  }

  function runMutationCheckpoint() {
    if (!mutationDirty) return;
    mutationDirty = false;
    const reason = mutationReason;
    const waiters = mutationWaiters;
    mutationWaiters = [];
    const operation = queue.then(() => checkpoint(reason));
    queue = operation.catch(() => {});
    operation.then(
      result => waiters.forEach(waiter => waiter.resolve(result)),
      error => waiters.forEach(waiter => waiter.reject(error)),
    );
  }

  function armMutationTimer() {
    if (mutationTimer) return;
    const elapsed = lastCheckpointAt ? Date.now() - lastCheckpointAt : Infinity;
    const wait = Math.max(0, checkpointMinIntervalMs - elapsed);
    if (wait === 0) { runMutationCheckpoint(); return; }
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      runMutationCheckpoint();
    }, wait);
    if (mutationTimer.unref) mutationTimer.unref();
  }

  function flush(reason) {
    if (stopping) return Promise.reject(new Error('Automated state is shutting down; new work is withheld.'));
    // Startup, shutdown, and fence-recovery checkpoints are exempt: they always run now.
    if (reason === 'startup' || reason === 'shutdown-final' || reason === 'fence-recovery' || !(checkpointMinIntervalMs > 0)) {
      const operation = queue.then(() => checkpoint(reason));
      queue = operation.catch(() => {});
      return operation;
    }
    mutationDirty = true;
    mutationReason = reason;
    const operation = new Promise((resolve, reject) => {
      mutationWaiters.push({ resolve, reject });
    });
    armMutationTimer();
    return operation;
  }

  // Self-healing after a persistence interruption (2026-10-04): when the
  // heartbeat finds the fence lease lapsed — twice in production, a
  // Railway platform stall froze the Postgres container for 74 minutes
  // and then ~2h10m, far beyond the 30s lease — re-acquire the fence
  // through the exact same lease protocol as boot. The conditional
  // INSERT only wins a free, expired, or self-owned lease, so a second
  // live dispatcher can never be displaced and single-dispatcher
  // semantics are preserved exactly. Readiness counts as restored only
  // after a checkpoint lands under the re-acquired fence, which
  // re-validates sole-writer state end to end. Any failure leaves the
  // state fail-closed (fenced=false) for the next attempt. Returns true
  // only when a recovery was actually performed and verified.
  let fenceRecovery = null;
  function recoverFence() {
    if (fenced || stopping || draining || !initialized) return Promise.resolve(false);
    if (fenceRecovery) return fenceRecovery;
    fenceRecovery = (async () => {
      try {
        await acquireFence();
        // Sole writer now, like boot: re-read the generation the previous
        // holder's drain may have advanced, then prove the fence with a
        // real checkpoint before anyone trades on it.
        await refreshGeneration();
        await flush('fence-recovery');
        console.log('[AutomatedState] Dispatch fence re-acquired after a persistence interruption; recovery checkpoint committed.');
        return true;
      } catch (error) {
        fenced = false;
        console.error('[AutomatedState] Fence recovery attempt failed; automated actions remain withheld:', error.message);
        return false;
      } finally {
        fenceRecovery = null;
      }
    })();
    return fenceRecovery;
  }

  // Disk-full recovery (Johnny 2026-10-01): ~17,828 full-image checkpoint
  // rewrites bloated the singleton snapshot row's file past 3 GB until
  // Postgres ran out of disk and every checkpoint failed. One-shot: called
  // from the server startup chain AFTER the local image was restored and
  // the fence acquired + generation refreshed, BEFORE the startup
  // checkpoint. Truncating empties the table (instantly reclaiming the
  // bloated file); the startup checkpoint that follows writes a fresh
  // snapshot from the just-restored local database, so live bot state is
  // preserved. The marker lives in the local boot_migrations table, which
  // the truncate does not touch and the fresh checkpoint carries forward.
  // A failure here must never brick the site: log loudly and continue.
  async function truncateSnapshotsOnce() {
    db.exec(`CREATE TABLE IF NOT EXISTS boot_migrations (
      name TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const done = db.prepare(`SELECT 1 FROM boot_migrations WHERE name='snapshot-truncate-20261001'`).get();
    if (done) return { skipped: true };
    try {
      assertFence();
      await query('TRUNCATE automated_trading_snapshots');
      const snap = await query('SELECT generation FROM automated_trading_snapshots WHERE singleton=TRUE');
      generation = snap.rowCount ? Number(snap.rows[0].generation) : 0;
    } catch (error) {
      console.error('[AutomatedState] One-shot snapshot truncate failed; continuing boot:', error.message);
      return { truncated: false, error: error.message };
    }
    db.prepare(`INSERT INTO boot_migrations(name) VALUES('snapshot-truncate-20261001')`).run();
    return { truncated: true };
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

  // Warrior chase cap 2026-10-12 (Johnny: "Make that +5%. We need to
  // catch these early."). Patches stored rules still on the old 10%
  // default to 5; a deliberate custom cap is left alone. One-shot via
  // boot_migrations, same shape as the 2026-09-29 price-band migration.
  function applyWarriorChaseCap5() {
    db.exec(`CREATE TABLE IF NOT EXISTS boot_migrations (
      name TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const done = db.prepare(`SELECT 1 FROM boot_migrations WHERE name='warrior-chase-cap-5-20261012'`).get();
    if (done) return { skipped: true };
    const has = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (has('warrior_settings')) {
      const rows = db.prepare(`SELECT user_id, rules FROM warrior_settings`).all();
      for (const row of rows) {
        let stored = {};
        try { stored = JSON.parse(row.rules || '{}'); } catch (_) { stored = {}; }
        if (stored.maxChasePct === 10) {
          stored.maxChasePct = 5;
          db.prepare(`UPDATE warrior_settings SET rules=? WHERE user_id=?`)
            .run(JSON.stringify(stored), row.user_id);
        }
      }
    }
    db.prepare(`INSERT INTO boot_migrations(name) VALUES('warrior-chase-cap-5-20261012')`).run();
    return { patched: true };
  }

  // Crypto bot DELETED 2026-10-07 on Johnny's order ("gut the crypto bot
  // and all its files, make it disappear"). Drop every crypto_* table and
  // release the bot's broker-account claim so nothing of it remains in the
  // durable state. Idempotent; runs before the startup checkpoint so the
  // removal propagates into the snapshot.
  function dropCryptoBot() {
    const tables = ['crypto_settings', 'crypto_credentials', 'crypto_positions',
      'crypto_opportunities', 'crypto_trades', 'crypto_alerts', 'crypto_scan_runs'];
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
    const has = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (has('broker_account_owners') && has('broker_account_quarantine')) {
      db.prepare(`DELETE FROM broker_account_quarantine
        WHERE account_id IN (SELECT account_id FROM broker_account_owners WHERE scope='crypto')`).run();
    }
    if (has('broker_account_owners')) db.prepare("DELETE FROM broker_account_owners WHERE scope='crypto'").run();
    if (has('automated_action_intents')) db.prepare("DELETE FROM automated_action_intents WHERE strategy='crypto'").run();
    return { dropped: tables.length };
  }

  // Flipper bot DELETED 2026-10-12 on Johnny's order ("delete one.. pick
  // whichever one you think is the worst") — Flipper was the pick: worst in
  // the fleet on the 2026-10-11 uniform replay (15 trades, 2W/13L,
  // -$243.17, expectancy -$16.21/trade), its one repair cycle had already
  // shipped and the repaired design still lost, and its final live test on
  // 2026-10-12 produced zero trades. Drop every flipper_* table and
  // release the bot's broker-account claim so nothing of it remains in the
  // durable state. Idempotent; runs before the startup checkpoint so the
  // removal propagates into the snapshot.
  function dropFlipperBot() {
    const tables = ['flipper_settings', 'flipper_credentials', 'flipper_walls',
      'flipper_setups', 'flipper_positions', 'flipper_trades', 'flipper_alerts',
      'flipper_backtests', 'flipper_backtest_trades', 'flipper_scan_runs',
      'flipper_leases'];
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
    const has = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (has('broker_account_owners') && has('broker_account_quarantine')) {
      db.prepare(`DELETE FROM broker_account_quarantine
        WHERE account_id IN (SELECT account_id FROM broker_account_owners WHERE scope='flipper')`).run();
    }
    if (has('broker_account_owners')) db.prepare("DELETE FROM broker_account_owners WHERE scope='flipper'").run();
    if (has('automated_action_intents')) db.prepare("DELETE FROM automated_action_intents WHERE strategy='flipper'").run();
    return { dropped: tables.length };
  }

  // ORB bot DELETED 2026-10-14 on Johnny's order ("get rid of ORB and all
  // of its files and history"). ORB sat out its final week on a dead stored
  // key (HTTP 401 since 2026-10-07); the fleet continues as Warrior + Kiaan.
  // Drop every orb_* table and release the bot's broker-account claim
  // (scope 'orb', account ending 76d5) so nothing of it remains in the
  // durable state. Idempotent; runs before the startup checkpoint so the
  // removal propagates into the snapshot.
  function dropOrbBot() {
    const tables = ['orb_settings', 'orb_credentials', 'orb_positions',
      'orb_trades', 'orb_alerts', 'orb_candidates', 'orb_candidates_best',
      'orb_rejected', 'orb_backtests', 'orb_backtest_trades', 'orb_day_state',
      'orb_leases'];
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
    const has = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (has('broker_account_owners') && has('broker_account_quarantine')) {
      db.prepare(`DELETE FROM broker_account_quarantine
        WHERE account_id IN (SELECT account_id FROM broker_account_owners WHERE scope='orb')`).run();
    }
    if (has('broker_account_owners')) db.prepare("DELETE FROM broker_account_owners WHERE scope='orb'").run();
    if (has('automated_action_intents')) db.prepare("DELETE FROM automated_action_intents WHERE strategy='orb'").run();
    return { dropped: tables.length };
  }

  async function releaseFence() {
    stopping = true;
    draining = true;
    try {
      await queue;
      // A throttled mutation checkpoint may still be armed. The shutdown
      // checkpoint below serializes the current image, so it lands any
      // pending state itself — cancel the timer and settle its waiters
      // with the shutdown result instead of letting it fire after stop.
      if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
      const waiters = mutationWaiters;
      mutationWaiters = [];
      mutationDirty = false;
      try {
        // Do not surrender ownership or report a clean shutdown unless the last
        // local image is durably committed under the active fence.
        if (fenced) {
          const result = await checkpoint('shutdown-final');
          waiters.forEach(waiter => waiter.resolve(result));
          await query(
            'UPDATE automated_trading_fences SET lease_until=NOW(), updated_at=NOW() WHERE singleton=TRUE AND owner_id=$1 AND epoch=$2',
            [ownerId, epoch],
          );
        } else if (waiters.length) {
          const error = new Error('Automated state fence is not active; throttled checkpoint discarded at shutdown.');
          waiters.forEach(waiter => waiter.reject(error));
        }
        fenced = false;
      } catch (error) {
        waiters.forEach(waiter => waiter.reject(error));
        throw error;
      }
    } finally {
      draining = false;
    }
  }

  return {
    init, acquireFence, refreshGeneration, heartbeat, health, assertFence, checkpoint, flush, releaseFence, recoverFence,
    truncateSnapshotsOnce,
    dropRetiredSdTables, dropRetiredWarriorRejectionTable, pauseAllBotsOnce,
    dropRetiredB2CloseAttempts, dropRetiredCryptoJournal, applyWarriorPriceBand, applyWarriorChaseCap5, dropCryptoBot, dropFlipperBot, dropOrbBot,
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