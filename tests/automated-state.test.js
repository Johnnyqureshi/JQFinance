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