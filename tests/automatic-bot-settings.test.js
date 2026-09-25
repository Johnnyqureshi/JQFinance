'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAutomaticBotSettings } = require('../lib/automatic-bot-settings');

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY);
  INSERT INTO users(id) VALUES (1),(2);
  CREATE TABLE b2_settings(user_id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,live_armed INTEGER NOT NULL DEFAULT 0,automation_revision INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE options_settings(user_id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,live_armed INTEGER NOT NULL DEFAULT 0,activation_revision INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE sd_settings(user_id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,live_armed INTEGER NOT NULL DEFAULT 0,automation_revision INTEGER NOT NULL DEFAULT 0);
  INSERT INTO b2_settings(user_id) VALUES (1),(2);
  INSERT INTO options_settings(user_id) VALUES (1),(2);
  INSERT INTO sd_settings(user_id,enabled) VALUES (1,1),(2,0);
`);

const settings = createAutomaticBotSettings(db);
settings.arm(1, 'b2', () => db.prepare('UPDATE b2_settings SET enabled=1,live_armed=1 WHERE user_id=1').run());
assert.deepEqual(settings.owner(1).strategy, 'b2');
assert.equal(settings.status(1, 'b2', { mode: 'live', enabled: true, liveArmed: true }).posture, 'live-armed');
// A B2 Live claim invalidates the Singles & Doubles arm as well.
assert.equal(db.prepare('SELECT enabled FROM sd_settings WHERE user_id=1').get().enabled, 0);
assert.equal(db.prepare('SELECT automation_revision FROM sd_settings WHERE user_id=1').get().automation_revision, 1);

settings.arm(1, 'options', () => db.prepare('UPDATE options_settings SET enabled=1,live_armed=1 WHERE user_id=1').run());
assert.equal(db.prepare('SELECT enabled FROM b2_settings WHERE user_id=1').get().enabled, 0);
assert.equal(db.prepare('SELECT live_armed FROM b2_settings WHERE user_id=1').get().live_armed, 0);
assert.equal(settings.owner(1).strategy, 'options');
assert.equal(settings.status(1, 'b2', { mode: 'live', enabled: false, liveArmed: false }).posture, 'shadowing');

db.prepare('UPDATE b2_settings SET enabled=1,live_armed=0 WHERE user_id=2').run();
db.prepare('UPDATE options_settings SET enabled=1,live_armed=0 WHERE user_id=2').run();
assert.equal(settings.status(2, 'b2', { mode: 'paper', enabled: true, liveArmed: false }).posture, 'active');
assert.equal(settings.status(2, 'options', { mode: 'paper', enabled: true, liveArmed: false }).posture, 'active');

settings.revoke(1, 'options');
assert.equal(settings.owner(1), null);

async function delayedArmIsRejectedAfterNewerAction(change) {
  const expectedRevision = db.prepare('SELECT activation_revision FROM options_settings WHERE user_id=1').get().activation_revision;
  const expectedIdentity = 'live:account-a';
  let currentIdentity = expectedIdentity;
  let release;
  const brokerResponse = new Promise(resolve => { release = resolve; });
  const pending = (async () => {
    await brokerResponse;
    return settings.arm(1, 'options', () => {
      db.prepare('UPDATE options_settings SET enabled=1,live_armed=1,activation_revision=activation_revision+1 WHERE user_id=1').run();
    }, () => db.prepare('SELECT activation_revision FROM options_settings WHERE user_id=1').get().activation_revision === expectedRevision
      && currentIdentity === expectedIdentity);
  })();
  currentIdentity = change();
  release();
  await assert.rejects(pending, /authorization changed/);
  assert.notEqual(settings.owner(1)?.strategy, 'options');
}

async function delayedB2ArmCannotOverrideNewerOptionsArm() {
  const expected = db.prepare('SELECT automation_revision FROM b2_settings WHERE user_id=1').get().automation_revision;
  let release;
  const brokerResponse = new Promise(resolve => { release = resolve; });
  const pending = (async () => {
    await brokerResponse;
    return settings.arm(1, 'b2', () => {
      db.prepare('UPDATE b2_settings SET enabled=1,live_armed=1 WHERE user_id=1').run();
    }, () => db.prepare('SELECT automation_revision FROM b2_settings WHERE user_id=1').get().automation_revision === expected);
  })();
  settings.arm(1, 'options', () => {
    db.prepare('UPDATE options_settings SET enabled=1,live_armed=1 WHERE user_id=1').run();
  });
  release();
  await assert.rejects(pending, /authorization changed/);
  assert.equal(settings.owner(1).strategy, 'options');
}

(async () => {
  await delayedArmIsRejectedAfterNewerAction(() => {
    db.prepare('UPDATE options_settings SET enabled=0,live_armed=0,activation_revision=activation_revision+1 WHERE user_id=1').run();
    return 'live:account-a';
  });
  await delayedArmIsRejectedAfterNewerAction(() => {
    return 'live:account-b';
  });
  await delayedB2ArmCannotOverrideNewerOptionsArm();
  const optionsRevision = db.prepare('SELECT activation_revision FROM options_settings WHERE user_id=1').get().activation_revision;
  settings.arm(1, 'b2', () => db.prepare('UPDATE b2_settings SET enabled=1,live_armed=1 WHERE user_id=1').run());
  assert.ok(db.prepare('SELECT activation_revision FROM options_settings WHERE user_id=1').get().activation_revision > optionsRevision,
    'A B2 Live claim invalidates a pending Options arm');
  assert.equal(settings.owner(1).strategy, 'b2');
  db.close();
  console.log('automatic bot Live exclusivity tests passed');
})().catch(error => {
  db.close();
  throw error;
});