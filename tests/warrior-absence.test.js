'use strict';

// Warrior absence/integration test — the deleted S&D bot stays deleted,
// Warrior is wired into nav/page/command-center, and B2's UI is untouched.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

// Every file the retired Singles & Doubles bot owned. None may exist.
const RETIRED_SD_FILES = [
  'lib/sd-service.js',
  'lib/sd-strategy.js',
  'public/css/sd.css',
  'public/js/sd.js',
  'scripts/sd-validate.mjs',
  'tests/sd-service.test.js',
  'tests/sd-strategy.test.js',
];

test('no retired S&D file exists anywhere under lib/public/tests/scripts', () => {
  for (const rel of RETIRED_SD_FILES) {
    assert.ok(!existsSync(join(ROOT, rel)), `retired S&D file must not exist: ${rel}`);
  }
  for (const dir of ['lib', 'public/js', 'public/css', 'tests']) {
    const entries = readdirSync(join(ROOT, dir));
    const strays = entries.filter(name => /(^|[._-])sd([._-]|$)/i.test(name) && !name.includes('warrior'));
    assert.deepEqual(strays, [], `stray S&D-named files in ${dir}: ${strays.join(', ')}`);
  }
});

test('no /api/sd route is registered in server.js', () => {
  const server = read('server.js');
  assert.ok(!/\/api\/sd(\/|["'])/.test(server), 'server.js must not register /api/sd routes');
  assert.ok(!/mountSd|sdService|createSdService/i.test(server), 'server.js must not reference an S&D service');
});

test('no sd_ table DDL remains in lib or server.js', () => {
  for (const rel of ['server.js', 'lib/b2-service.js', 'lib/warrior/service.js', 'lib/automated-state.js']) {
    const source = read(rel);
    assert.ok(!/CREATE TABLE[^;]*\bsd_/i.test(source), `${rel} must not create sd_ tables`);
  }
});

test('Warrior is first in desktop nav, mobile nav, and the Command Center', () => {
  const html = read('index.html');
  const desktopWarrior = html.indexOf('data-page="warrior"');
  const desktopB2 = html.indexOf('data-page="b2"');
  assert.ok(desktopWarrior !== -1, 'desktop nav has a Warrior entry');
  assert.ok(desktopB2 !== -1, 'desktop nav keeps its B2 entry');
  assert.ok(desktopWarrior < desktopB2, 'Warrior sorts before B2 in the desktop nav');
  const mobileSection = html.slice(html.indexOf('id="mobileNav"'));
  const mobileWarrior = mobileSection.indexOf('data-page="warrior"');
  const mobileB2 = mobileSection.indexOf('data-page="b2"');
  assert.ok(mobileWarrior !== -1 && mobileB2 !== -1, 'mobile nav has Warrior and B2 entries');
  assert.ok(mobileWarrior < mobileB2, 'Warrior sorts before B2 in the mobile nav');
  const cardSection = html.slice(html.indexOf('hp-bot-grid'));
  const warriorCard = cardSection.indexOf('id="hpWarriorPill"');
  const b2Card = cardSection.indexOf('id="hpB2Pill"');
  assert.ok(warriorCard !== -1 && b2Card !== -1, 'Command Center has Warrior and B2 cards');
  assert.ok(warriorCard < b2Card, 'Warrior card sorts before the B2 card');
  assert.ok(html.includes('id="page-warrior"'), 'Warrior page container exists');
  assert.ok(html.includes('/js/warrior.js?v=20260929e'), 'Warrior script uses the v=20260929e asset tag');
  assert.ok(html.includes('/public/css/warrior.css?v=20260929d'), 'Warrior stylesheet uses the v=20260929d asset tag');
});

test('B2 UI is still present and untouched by the Warrior integration', () => {
  const html = read('index.html');
  assert.ok(html.includes('data-page="b2"'), 'B2 desktop nav entry present');
  assert.ok(html.includes('id="page-b2"'), 'B2 page container present');
  assert.ok(html.includes('id="hpB2Pill"'), 'B2 Command Center card present');
  assert.ok(html.includes('/js/b2.js?v=20260929d'), 'B2 script tag keeps its own asset tag');
  assert.ok(html.includes('/public/css/b2.css?v=20260929d'), 'B2 stylesheet tag keeps its own asset tag');
});

test('app.js routes the warrior page through window.warriorBot', () => {
  const app = read('public/js/app.js');
  assert.ok(/page==='warrior'/.test(app), 'app.js activates the warrior page');
  assert.ok(/window\.warriorBot/.test(app), 'app.js drives window.warriorBot');
  assert.ok(/page==='b2'/.test(app), 'app.js still activates the B2 page');
});

test('home-pulse.js refreshes the Warrior card first, B2 second', () => {
  const pulse = read('public/js/home-pulse.js');
  const warrior = pulse.indexOf("prefix: 'hpWarrior'");
  const b2 = pulse.indexOf("prefix: 'hpB2'");
  assert.ok(warrior !== -1 && b2 !== -1, 'home-pulse refreshes Warrior and B2 cards');
  assert.ok(warrior < b2, 'Warrior card refreshes before B2');
  assert.ok(pulse.includes("goPage('warrior')"), 'Warrior card links to the warrior page');
});
