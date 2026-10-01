'use strict';

// ORB bot wiring integration: routes, nav, page, assets, scheduler, and
// homepage card are all present and the bot ships disabled/paper-first.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

const read = p => readFileSync(require.resolve(p), 'utf8');
const html = read('../index.html');
const server = read('../server.js');
const appJs = read('../public/js/app.js');
const homePulse = read('../public/js/home-pulse.js');

test('ORB routes are mounted under /api/orb/*', () => {
  const { mountOrb } = require('../lib/orb/service');
  const seen = [];
  const fakeApp = { get: p => seen.push('GET ' + p), post: p => seen.push('POST ' + p), put: p => seen.push('PUT ' + p) };
  const out = mountOrb({ app: fakeApp, service: {}, requireAuth: (a, b) => [a, b], ensureSessionUserInTradingStore: async () => 1 });
  for (const r of ['GET /api/orb/status', 'POST /api/orb/connect', 'POST /api/orb/disconnect',
    'GET /api/orb/settings', 'PUT /api/orb/settings', 'GET /api/orb/dashboard',
    'GET /api/orb/positions', 'GET /api/orb/trades', 'GET /api/orb/backtests']) {
    assert.ok(out.routes.includes(r), `mountOrb exposes ${r}`);
  }
});

test('server.js wires the ORB service: create, mount, scheduler, readyz, drain', () => {
  assert.ok(server.includes("require('./lib/orb/service')"), 'requires orb service');
  assert.ok(server.includes('createOrbService({'), 'creates orbService');
  assert.ok(server.includes('mountOrb({ app, service: orbService'), 'mounts orb routes');
  assert.ok(server.includes('orbService.start();'), 'starts orb scheduler');
  assert.ok(server.includes('orbSchedulerStarted'), 'tracks orb scheduler state');
  assert.ok(server.includes("orb: orbSchedulerStarted ? 'started' : 'stopped'"), 'readyz reports orb');
  assert.ok(server.includes('orbService.drain()'), 'drains orb on shutdown');
  assert.ok(server.includes('orbService.pruneDiagnostics'), 'prunes orb diagnostics at boot');
});

test('index.html has ORB nav, page, assets, and homepage card', () => {
  assert.ok(html.includes('data-page="orb"'), 'desktop/mobile nav has ORB');
  assert.ok(html.includes('id="page-orb"'), 'page-orb container exists');
  assert.ok(html.includes('/js/orb.js?v='), 'orb.js included with cache-busting tag');
  assert.ok(html.includes('/public/css/orb.css?v='), 'orb.css included with cache-busting tag');
  for (const id of ['hpOrbPill', 'hpOrbBlocker', 'hpOrbPnl', 'hpOrbOpen', 'hpOrbView']) {
    assert.ok(html.includes(`id="${id}"`), `homepage card has ${id}`);
  }
});

test('app.js routes the orb page through window.orbBot', () => {
  assert.ok(/page==='orb'/.test(appJs), 'app.js activates the orb page');
  assert.ok(/window\.orbBot/.test(appJs), 'app.js drives window.orbBot');
  assert.ok(/orbBot\.pause\(\)/.test(appJs), 'app.js pauses orbBot on other pages');
});

test('home-pulse.js fetches ORB status/trades and links the card', () => {
  assert.ok(homePulse.includes('/api/orb/status'), 'polls orb status');
  assert.ok(homePulse.includes('/api/orb/trades'), 'polls orb trades');
  assert.ok(homePulse.includes("goPage('orb')"), 'card links to orb page');
});

test('ORB ships disabled and paper-first', () => {
  const { DEFAULT_ORB_RULES } = require('../lib/orb/service');
  assert.equal(DEFAULT_ORB_RULES.tradingMode, 'PAPER');
  assert.equal(DEFAULT_ORB_RULES.liveEnabled, false);
  assert.equal(DEFAULT_ORB_RULES.liveConfirmed, false);
});
