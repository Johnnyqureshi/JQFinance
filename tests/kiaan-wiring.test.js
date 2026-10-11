'use strict';

// Kiaan Bot wiring integration: routes, nav, page, assets, scheduler,
// verify endpoint, settings registry — and the bot ships disabled and
// paper-only BY DESIGN (there is no live mode to flip on).

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
  assert.ok(html.includes('/js/kiaan.js?v=20261011a'), 'kiaan.js included with the stage-2 cache-busting tag');
  assert.ok(html.indexOf('data-page="kiaan"') < html.indexOf('data-page="warrior"'), 'Kiaan tab stays first');
});

test('app.js routes the kiaan page through window.kiaanBot', () => {
  assert.ok(/page==='kiaan'/.test(appJs), 'app.js activates the kiaan page');
  assert.ok(/window\.kiaanBot/.test(appJs), 'app.js drives window.kiaanBot');
  assert.ok(/kiaanBot\.pause\(\)/.test(appJs), 'app.js pauses kiaanBot on other pages');
});

test('kiaan.js drives the real API: status, connect, settings, journal', () => {
  for (const path of ['/api/kiaan/status', '/api/kiaan/connect', '/api/kiaan/disconnect',
    '/api/kiaan/settings', '/api/kiaan/dashboard', '/api/kiaan/trades',
    '/api/kiaan/journal', '/api/kiaan/alerts']) {
    assert.ok(kiaanJs.includes(path), `kiaan.js calls ${path}`);
  }
  assert.ok(/window\.kiaanBot/.test(kiaanJs), 'kiaan.js exposes window.kiaanBot');
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

test('Kiaan ships paper-only: merged rules force PAPER against any override', () => {
  const { DEFAULT_KIAAN_RULES, mergedKiaanRules, validateConfig } = require('../lib/kiaan/engine');
  assert.equal(DEFAULT_KIAAN_RULES.tradingMode, 'PAPER');
  assert.equal(mergedKiaanRules({ tradingMode: 'LIVE' }).tradingMode, 'PAPER');
  assert.equal(validateConfig({}).ok, true);
});
