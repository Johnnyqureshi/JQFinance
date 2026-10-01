'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAutomaticBotSettings } = require('../lib/automatic-bot-settings');

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY);
  INSERT INTO users(id) VALUES (1),(2);
`);

const settings = createAutomaticBotSettings(db);

// B2 and LEAP/options were deleted 2026-10-01: they are no longer known strategies.
for (const dead of ['b2', 'options']) {
  assert.throws(() => settings.arm(1, dead, () => {}), /Unknown automatic trading strategy/);
  assert.throws(() => settings.revoke(1, dead), /Unknown automatic trading strategy/);
  assert.throws(() => settings.status(1, dead, { mode: 'paper', enabled: true, liveArmed: false }), /Unknown automatic trading strategy/);
}

// Warrior / crypto / flipper are registered paper-only strategies.
settings.arm(1, 'warrior', () => {});
assert.deepEqual(settings.owner(1).strategy, 'warrior');

// Revoking another strategy must not clear the live-arm owner.
settings.revoke(1, 'crypto');
assert.deepEqual(settings.owner(1).strategy, 'warrior',
  "Revoking crypto must not clear another strategy's live arm");
assert.equal(settings.status(1, 'crypto', { mode: 'paper', enabled: true, liveArmed: false }).posture, 'active');
assert.equal(settings.status(1, 'crypto', { mode: 'paper', enabled: false, liveArmed: false }).posture, 'paused');

settings.arm(1, 'crypto', () => {});
assert.deepEqual(settings.owner(1).strategy, 'crypto');
settings.revoke(1, 'crypto');
assert.equal(settings.owner(1), null);

settings.arm(1, 'flipper', () => {});
assert.deepEqual(settings.owner(1).strategy, 'flipper');
assert.equal(settings.status(1, 'flipper', { mode: 'paper', enabled: true, liveArmed: false }).posture, 'active');
settings.revoke(1, 'flipper');
assert.equal(settings.owner(1), null);

// Paper-only strategies have no-op invalidate: arming one never throws and
// never disturbs another user's stored arm.
settings.arm(1, 'warrior', () => {});
settings.arm(2, 'crypto', () => {});
assert.deepEqual(settings.owner(1).strategy, 'warrior');
assert.deepEqual(settings.owner(2).strategy, 'crypto');

async function delayedArmIsRejectedAfterNewerAction() {
  db.exec(`INSERT OR IGNORE INTO users(id) VALUES (3)`);
  let release;
  const brokerResponse = new Promise(resolve => { release = resolve; });
  let fresh = true;
  const pending = (async () => {
    await brokerResponse;
    return settings.arm(3, 'warrior', () => {}, () => fresh);
  })();
  fresh = false;
  release();
  await assert.rejects(pending, /authorization changed/);
  assert.equal(settings.owner(3), null, 'rejected arm must not take ownership');
}

(async () => {
  await delayedArmIsRejectedAfterNewerAction();
  db.close();
  console.log('automatic bot settings tests passed');
})().catch(error => {
  db.close();
  throw error;
});
