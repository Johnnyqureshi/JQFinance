'use strict';

// Kiaan Bot wiring integration: routes, nav, page, assets, scheduler,
// verify endpoint, settings registry — and the bot ships disabled;
// live-account capability exists in code (2026-10-17) but nothing is
// ever enabled or switched by wiring alone.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const read = p => readFileSync(require.resolve(p), 'utf8');
const html = read('../index.html');
const server = read('../server.js');
const appJs = read('../public/js/app.js');
const kiaanJs = read('../public/js/kiaan.js');

test('Kiaan routes are mounted under /api/kiaan/*', () => {
  const { mountKiaan } = require('../lib/kiaan/service');
  const seen = [];
  const fakeApp = { get: p => seen.push('GET ' + p), post: p => seen.push('POST ' + p), put: p => seen.push('PUT ' + p) };
  const out = mountKiaan({ app: fakeApp, service: {}, requireAuth: (a, b) => [a, b], ensureSessionUserInTradingStore: async () => 1 });
  for (const r of ['GET /api/kiaan/status', 'POST /api/kiaan/connect', 'POST /api/kiaan/disconnect',
    'GET /api/kiaan/settings', 'PUT /api/kiaan/settings', 'GET /api/kiaan/dashboard',
    'GET /api/kiaan/positions', 'GET /api/kiaan/trades', 'GET /api/kiaan/alerts',
    'GET /api/kiaan/journal', 'GET /api/kiaan/universe']) {
    assert.ok(out.routes.includes(r), `mountKiaan exposes ${r}`);
  }
});

test('server.js wires the Kiaan service: create, mount, scheduler, readyz, drain, verify', () => {
  assert.ok(server.includes("require('./lib/kiaan/service')"), 'requires kiaan service');
  assert.ok(server.includes('createKiaanService({'), 'creates kiaanService');
  assert.ok(server.includes('mountKiaan({ app, service: kiaanService'), 'mounts kiaan routes');
  assert.ok(server.includes('kiaanService.start();'), 'starts kiaan scheduler');
  assert.ok(server.includes('kiaanSchedulerStarted'), 'tracks kiaan scheduler state');
  assert.ok(server.includes("kiaan: kiaanSchedulerStarted ? 'started' : 'stopped'"), 'readyz reports kiaan');
  assert.ok(server.includes('kiaanService.drain()'), 'drains kiaan on shutdown');
  assert.ok(server.includes('kiaanService.pruneDiagnostics'), 'prunes kiaan diagnostics at boot');
  assert.ok(server.includes('kiaan_settings'), 'verify endpoint exposes kiaan_settings');
  assert.ok(server.includes('kiaan_alerts'), 'verify endpoint exposes kiaan_alerts');
});

test('index.html has the Kiaan page first and the bumped asset tag', () => {
  assert.ok(html.includes('data-page="kiaan"'), 'desktop/mobile nav has Kiaan');
  assert.ok(html.includes('id="page-kiaan"'), 'page-kiaan container exists');
  assert.ok(html.includes('/js/kiaan.js?v=20261018a'), 'kiaan.js included with the current cache-busting tag');
  assert.ok(!html.includes('data-page="warrior"'), 'no Warrior tab remains (bot deleted 2026-10-16)');
});

test('app.js routes the kiaan page through window.kiaanBot', () => {
  assert.ok(/page==='kiaan'/.test(appJs), 'app.js activates the kiaan page');
  assert.ok(/window\.kiaanBot/.test(appJs), 'app.js drives window.kiaanBot');
  assert.ok(/kiaanBot\.pause\(\)/.test(appJs), 'app.js pauses kiaanBot on other pages');
});

test('kiaan.js drives the real API: status, settings, journal (no connect — brokers page owns keys)', () => {
  for (const path of ['/api/kiaan/status',
    '/api/kiaan/settings', '/api/kiaan/dashboard', '/api/kiaan/trades',
    '/api/kiaan/journal', '/api/kiaan/alerts']) {
    assert.ok(kiaanJs.includes(path), `kiaan.js calls ${path}`);
  }
  assert.ok(/window\.kiaanBot/.test(kiaanJs), 'kiaan.js exposes window.kiaanBot');
});

test('hide-internals (d): the bot page has NO API-key form for any role, and no rule schema in the bundle', () => {
  // The connect/disconnect endpoints still exist server-side (the
  // Brokers page re-hosts them), but the Kiaan page must not surface
  // them: no key/secret inputs, no connect/disconnect calls, no modal.
  for (const bad of ['/api/kiaan/connect', '/api/kiaan/disconnect', 'kiaanKey', 'kiaanSecret',
    'kiaanForm', 'kiaanDisconnect', 'connectionModal', 'kiaanPaperConnect']) {
    assert.ok(!kiaanJs.includes(bad), `kiaan.js must not contain ${bad}`);
  }
  // Rule internals are not in the shared bundle either: the settings
  // schema arrives only inside the owner settings payload (uiSchema).
  for (const bad of ['spyStrongPct', 'hedgeSymbols', 'longUniverse', 'sleeveSymbols', 'guardYieldMin', 'minRvol']) {
    assert.ok(!kiaanJs.includes(bad), `kiaan.js bundle must not contain rule field ${bad}`);
  }
  assert.ok(kiaanJs.includes('uiSchema'), 'kiaan.js renders the owner schema from the settings payload');
  assert.ok(kiaanJs.includes('fixedDollars'), 'kiaan.js keeps the one user-editable field: position size');
  // Sizing + risk only (Johnny 2026-10-16 ~23:25 CT): the user settings
  // render also shows the two read-only risk values from the payload.
  assert.ok(kiaanJs.includes('maxRiskPerTradeDollars') && kiaanJs.includes('maxDailyLossPct'),
    'kiaan.js renders the two user-visible risk values (per-trade cap, daily-loss lock)');
  assert.ok(server.includes('ownerUserId: 1000000005'), 'server.js pins Johnny (…005) as the owner view');
});

test('Kiaan is registered in automatic-bot-settings as a paper-only strategy', () => {
  const { createAutomaticBotSettings } = require('../lib/automatic-bot-settings');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO users(id) VALUES (1)').run();
  const settings = createAutomaticBotSettings(db);
  settings.revoke(1, 'kiaan'); // must not throw 'Unknown automatic trading strategy'
  assert.equal(settings.status(1, 'kiaan', { mode: 'paper', enabled: false, liveArmed: false }).posture, 'paused');
  assert.equal(settings.status(1, 'kiaan', { mode: 'paper', enabled: true, liveArmed: false }).posture, 'active');
});

test('Kiaan modes (2026-10-17): PAPER default, LIVE a real validated mode', () => {
  const { DEFAULT_KIAAN_RULES, mergedKiaanRules, validateConfig } = require('../lib/kiaan/engine');
  assert.equal(DEFAULT_KIAAN_RULES.tradingMode, 'PAPER');
  assert.equal(mergedKiaanRules({ tradingMode: 'LIVE' }).tradingMode, 'LIVE');
  assert.equal(validateConfig({}).ok, true);
  assert.equal(validateConfig({ tradingMode: 'LIVE' }).ok, true);
});
