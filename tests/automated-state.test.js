'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  createAutomatedState,
  restoreAutomatedSnapshot,
  checksum,
  SNAPSHOT_SCHEMA_VERSION,
} = require('../lib/automated-state');

function fakePool({ image, sha256, schemaVersion = SNAPSHOT_SCHEMA_VERSION } = {}) {
  sha256 = sha256 || (image ? checksum(image) : null);
  let generation = 0;
  let owner = null;
  let epoch = 0;
  let leaseUntil = 0;
  const snapshots = image ? { generation: 1, schema_version: schemaVersion, sha256, image } : null;
  return {
    on() {},
    async query(sql, params = []) {
      if (/to_regclass/.test(sql)) {
        return { rows: [{ snapshots: 'automated_trading_snapshots', fences: 'automated_trading_fences' }] };
      }
      if (/INSERT INTO automated_trading_fences/.test(sql)) {
        const nextOwner = params[0];
        if (owner && leaseUntil > Date.now() && owner !== nextOwner) return { rowCount: 0, rows: [] };
        owner = nextOwner; epoch += 1; leaseUntil = Date.now() + 30_000;
        return { rowCount: 1, rows: [{ epoch }] };
      }
      if (/UPDATE automated_trading_fences/.test(sql)) {
        if (/lease_until=NOW\(\)/.test(sql)) { leaseUntil = 0; return { rowCount: 1, rows: [] }; }
        return { rowCount: owner === params[1] && epoch === params[2] ? 1 : 0, rows: [] };
      }
      if (/^\s*SELECT 1\s+FROM automated_trading_fences/.test(sql)) {
        return { rowCount: owner === params[0] && epoch === params[1] && leaseUntil > Date.now() ? 1 : 0, rows: [] };
      }
      if (/INSERT INTO automated_trading_snapshots/.test(sql)) {
        if (owner !== params[6] || epoch !== params[5] || leaseUntil <= Date.now()) return { rowCount: 0, rows: [] };
        generation = params[1];
        return { rowCount: 1, rows: [{ generation }] };
      }
      if (/SELECT generation, schema_version/.test(sql)) {
        return snapshots ? { rowCount: 1, rows: [snapshots] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT generation FROM automated_trading_snapshots/.test(sql)) {
        return snapshots
          ? { rowCount: 1, rows: [{ generation: snapshots.generation }] }
          : { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected SQL in fake pool: ${sql.slice(0, 70)}`);
    },
    async end() {},
  };
}

test('fenced checkpoint serializes the dedicated SQLite image and releases ownership', async () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('durable')");
  const state = createAutomatedState({ db, injectedPool: fakePool(), ownerId: 'test-owner' });
  await state.init();
  assert.equal(await state.acquireFence(), 1);
  assert.deepEqual(await state.health(), { ready: true });
  const result = await state.flush('test');
  assert.equal(result.generation, 1);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  await state.releaseFence();
  assert.deepEqual(await state.health(), { ready: false });
  await state.close();
  db.close();
});

test('restore refuses a corrupt durable image and never falls back silently', async () => {
  const image = Buffer.from('not-a-valid-sqlite-image');
  const pool = fakePool({ image, sha256: '0'.repeat(64) });
  const dir = mkdtempSync(join(tmpdir(), 'automated-state-'));
  const path = join(dir, 'automated-trading.db');
  await assert.rejects(
    restoreAutomatedSnapshot({ injectedPool: pool, dbPath: path }),
    /checksum or schema validation failed/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('restore writes the validated highest image before service startup', async () => {
  const source = new Database(':memory:');
  source.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('restored')");
  const image = source.serialize();
  source.close();
  const dir = mkdtempSync(join(tmpdir(), 'automated-state-'));
  const path = join(dir, 'automated-trading.db');
  await restoreAutomatedSnapshot({ injectedPool: fakePool({ image }), dbPath: path });
  const restored = new Database(path, { readonly: true });
  assert.equal(restored.prepare('SELECT value FROM marker').get().value, 'restored');
  restored.close();
  rmSync(dir, { recursive: true, force: true });
});
test('checkpoint refuses to overwrite a durable snapshot with an empty local image', async () => {
  const source = new Database(':memory:');
  source.exec("CREATE TABLE warrior_settings(user_id TEXT); INSERT INTO warrior_settings VALUES ('u1')");
  const image = source.serialize();
  source.close();
  // Local DB is fresh/empty (restore never ran); a durable snapshot exists.
  const db = new Database(':memory:');
  const state = createAutomatedState({ db, injectedPool: fakePool({ image }), ownerId: 'test-owner' });
  await state.init();
  await state.acquireFence();
  await assert.rejects(state.flush('startup'), /refusing to overwrite/);
  await state.close();
  db.close();
});

test('checkpoint commits once the local image carries bot identity', async () => {
  const source = new Database(':memory:');
  source.exec("CREATE TABLE warrior_settings(user_id TEXT); INSERT INTO warrior_settings VALUES ('u1')");
  const image = source.serialize();
  source.close();
  const db = new Database(':memory:');
  db.exec("CREATE TABLE warrior_settings(user_id TEXT); INSERT INTO warrior_settings VALUES ('u1')");
  const state = createAutomatedState({ db, injectedPool: fakePool({ image }), ownerId: 'test-owner' });
  await state.init();
  await state.acquireFence();
  const result = await state.flush('startup');
  assert.equal(result.generation, 2);
  await state.close();
  db.close();
});

test('checkpoint allows an empty image when this boot restored the snapshot', async () => {
  const source = new Database(':memory:');
  source.exec("CREATE TABLE warrior_settings(user_id TEXT); INSERT INTO warrior_settings VALUES ('u1')");
  const image = source.serialize();
  source.close();
  // Restore ran (scripts/boot.js sets this); the local image IS the snapshot.
  process.env.AUTOMATED_STATE_RESTORED = 'true';
  try {
    const db = new Database(':memory:');
    const state = createAutomatedState({ db, injectedPool: fakePool({ image }), ownerId: 'test-owner' });
    await state.init();
    await state.acquireFence();
    const result = await state.flush('startup');
    assert.equal(result.generation, 2);
    await state.close();
    db.close();
  } finally {
    delete process.env.AUTOMATED_STATE_RESTORED;
  }
});

// ---------------------------------------------------------------------------
// 2026-10-01 disk-full recovery: one-shot snapshot truncate + checkpoint
// throttle. The fake below tracks the snapshot row so tests can observe
// truncate/checkpoint ordering, insert counts, reasons, and stored images.
// ---------------------------------------------------------------------------

function instrumentedPool({ snapshot = null, failTruncate = false } = {}) {
  const control = {
    snapshot, // { generation, schema_version, sha256, image } | null
    insertCount: 0,
    truncateAttempts: 0,
    reasons: [],
    failTruncate,
  };
  let owner = null;
  let epoch = 0;
  let leaseUntil = 0;
  const pool = {
    on() {},
    async query(sql, params = []) {
      if (/to_regclass/.test(sql)) {
        return { rows: [{ snapshots: 'automated_trading_snapshots', fences: 'automated_trading_fences' }] };
      }
      if (/TRUNCATE automated_trading_snapshots/.test(sql)) {
        control.truncateAttempts += 1;
        if (control.failTruncate) throw new Error('No space left on device');
        control.snapshot = null;
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO automated_trading_fences/.test(sql)) {
        const nextOwner = params[0];
        if (owner && leaseUntil > Date.now() && owner !== nextOwner) return { rowCount: 0, rows: [] };
        owner = nextOwner; epoch += 1; leaseUntil = Date.now() + 30_000;
        return { rowCount: 1, rows: [{ epoch }] };
      }
      if (/UPDATE automated_trading_fences/.test(sql)) {
        if (/lease_until=NOW\(\)/.test(sql)) { leaseUntil = 0; return { rowCount: 1, rows: [] }; }
        return { rowCount: owner === params[1] && epoch === params[2] ? 1 : 0, rows: [] };
      }
      if (/^\s*SELECT 1\s+FROM automated_trading_fences/.test(sql)) {
        return { rowCount: owner === params[0] && epoch === params[1] && leaseUntil > Date.now() ? 1 : 0, rows: [] };
      }
      if (/INSERT INTO automated_trading_snapshots/.test(sql)) {
        if (owner !== params[6] || epoch !== params[5] || leaseUntil <= Date.now()) return { rowCount: 0, rows: [] };
        control.insertCount += 1;
        control.reasons.push(params[7]);
        control.snapshot = {
          generation: params[1], schema_version: params[2], sha256: params[3], image: params[4],
        };
        return { rowCount: 1, rows: [{ generation: params[1] }] };
      }
      if (/SELECT generation, schema_version, sha256, image/.test(sql)) {
        return control.snapshot ? { rowCount: 1, rows: [control.snapshot] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT generation, schema_version/.test(sql)) {
        return control.snapshot ? { rowCount: 1, rows: [control.snapshot] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT generation FROM automated_trading_snapshots/.test(sql)) {
        return control.snapshot
          ? { rowCount: 1, rows: [{ generation: control.snapshot.generation }] }
          : { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected SQL in instrumented pool: ${sql.slice(0, 70)}`);
    },
    async end() {},
  };
  pool.control = control;
  return pool;
}

function seededSnapshot(generation, markerValue = 'restored') {
  const source = new Database(':memory:');
  source.exec(`CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('${markerValue}')`);
  const image = source.serialize();
  source.close();
  return { generation, schema_version: SNAPSHOT_SCHEMA_VERSION, sha256: checksum(image), image };
}

test('one-shot truncate runs after restore + fence, before the startup checkpoint, exactly once', async () => {
  const pool = instrumentedPool({ snapshot: seededSnapshot(5) });
  const db = new Database(':memory:');
  db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('restored')");
  db.exec("CREATE TABLE warrior_settings(user_id TEXT); INSERT INTO warrior_settings VALUES ('u1')");
  const state = createAutomatedState({ db, injectedPool: pool, ownerId: 'test-owner' });
  await state.init();
  assert.equal(state.generation(), 5);
  await state.acquireFence();
  await state.refreshGeneration();

  const first = await state.truncateSnapshotsOnce();
  assert.deepEqual(first, { truncated: true });
  assert.equal(pool.control.truncateAttempts, 1);
  assert.equal(pool.control.snapshot, null);
  assert.equal(state.generation(), 0);
  // No checkpoint may land between the truncate and the startup flush.
  assert.equal(pool.control.insertCount, 0);

  const result = await state.flush('startup');
  assert.equal(result.generation, 1);
  assert.equal(pool.control.insertCount, 1);

  const second = await state.truncateSnapshotsOnce();
  assert.deepEqual(second, { skipped: true });
  assert.equal(pool.control.truncateAttempts, 1);

  await state.releaseFence();
  await state.close();
  db.close();
});

test('boot survives a throwing TRUNCATE and the one-shot retries on the next boot', async () => {
  const pool = instrumentedPool({ snapshot: seededSnapshot(3), failTruncate: true });
  const db = new Database(':memory:');
  db.exec("CREATE TABLE warrior_settings(user_id TEXT); INSERT INTO warrior_settings VALUES ('u1')");
  const state = createAutomatedState({ db, injectedPool: pool, ownerId: 'test-owner' });
  await state.init();
  await state.acquireFence();
  await state.refreshGeneration();

  const failed = await state.truncateSnapshotsOnce();
  assert.equal(failed.truncated, false);
  assert.match(failed.error, /No space left/);
  assert.equal(pool.control.truncateAttempts, 1);
  // Boot continues: the startup checkpoint still lands against the old row.
  const result = await state.flush('startup');
  assert.equal(result.generation, 4);

  pool.control.failTruncate = false;
  const retried = await state.truncateSnapshotsOnce();
  assert.deepEqual(retried, { truncated: true });
  assert.equal(pool.control.truncateAttempts, 2);
  assert.equal(state.generation(), 0);

  await state.releaseFence();
  await state.close();
  db.close();
});

test('throttle coalesces rapid mutation checkpoints and lands the latest state', async () => {
  const pool = instrumentedPool();
  const db = new Database(':memory:');
  db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('v1')");
  db.exec("CREATE TABLE warrior_settings(user_id TEXT); INSERT INTO warrior_settings VALUES ('u1')");
  const state = createAutomatedState({ db, injectedPool: pool, ownerId: 'test-owner', checkpointMinIntervalMs: 60 });
  await state.init();
  await state.acquireFence();

  const first = await state.flush('warrior-operation');
  assert.equal(first.generation, 1);
  assert.equal(pool.control.insertCount, 1);

  db.exec("UPDATE marker SET value='v2'");
  const pending = [
    state.flush('warrior-operation'),
    state.flush('warrior-tick'),
    state.flush('flipper-operation'),
  ];
  // Coalesced: nothing new has been written yet.
  assert.equal(pool.control.insertCount, 1);
  const results = await Promise.all(pending);
  assert.equal(pool.control.insertCount, 2);
  assert.deepEqual(pool.control.reasons, ['warrior-operation', 'flipper-operation']);
  for (const result of results) assert.equal(result.generation, 2);

  // The landed image is the latest state (v2), restorable end to end.
  const dir = mkdtempSync(join(tmpdir(), 'automated-state-'));
  const path = join(dir, 'automated-trading.db');
  await restoreAutomatedSnapshot({ injectedPool: pool, dbPath: path });
  const restored = new Database(path, { readonly: true });
  assert.equal(restored.prepare('SELECT value FROM marker').get().value, 'v2');
  restored.close();
  rmSync(dir, { recursive: true, force: true });

  await state.releaseFence();
  await state.close();
  db.close();
});

test('startup bypasses the throttle and the shutdown checkpoint settles a pending mutation flush', async () => {
  const pool = instrumentedPool();
  const db = new Database(':memory:');
  db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('v1')");
  db.exec("CREATE TABLE warrior_settings(user_id TEXT); INSERT INTO warrior_settings VALUES ('u1')");
  const state = createAutomatedState({ db, injectedPool: pool, ownerId: 'test-owner', checkpointMinIntervalMs: 60_000 });
  await state.init();
  await state.acquireFence();

  await state.flush('mutation-a');
  assert.equal(pool.control.insertCount, 1);

  const pending = state.flush('mutation-b'); // throttled for ~60s
  assert.equal(pool.control.insertCount, 1);

  const startup = await state.flush('startup'); // bypass: lands immediately
  assert.equal(startup.generation, 2);
  assert.equal(pool.control.insertCount, 2);

  await state.releaseFence(); // shutdown-final bypass settles the waiter
  const settled = await pending;
  assert.equal(settled.generation, 3);
  assert.deepEqual(pool.control.reasons, ['mutation-a', 'startup', 'shutdown-final']);

  await state.close();
  db.close();
});

