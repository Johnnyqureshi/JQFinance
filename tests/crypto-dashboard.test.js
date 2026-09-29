'use strict';

// Crypto Breakout Bot UI wiring test — nav, page container, asset tags,
// app.js routing, and the window.cryptoBot surface (static checks; the
// backend endpoints are built by other crews).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

test('crypto UI files exist and reference nothing outside their own scope', () => {
  assert.ok(existsSync(join(ROOT, 'public/js/crypto.js')), 'public/js/crypto.js exists');
  assert.ok(existsSync(join(ROOT, 'public/css/crypto.css')), 'public/css/crypto.css exists');
  const js = read('public/js/crypto.js');
  assert.ok(!/warriorBot|b2Bot|optionsBot/.test(js), 'crypto.js does not touch other bots');
  const css = read('public/css/crypto.css');
  assert.ok(!/\.war-/.test(css), 'crypto.css defines its own namespace (no war- classes)');
});

test('crypto.js exposes the window.cryptoBot { open, pause } surface', () => {
  const js = read('public/js/crypto.js');
  assert.ok(/window\.cryptoBot\s*=\s*\{\s*open\s*,\s*pause\s*\}/.test(js), 'exposes window.cryptoBot = { open, pause }');
  assert.ok(/async function open\(\)/.test(js), 'open() is defined');
  assert.ok(/function pause\(\)/.test(js), 'pause() is defined');
  assert.ok(js.includes('page-crypto'), 'renders into #page-crypto');
});

test('crypto dashboard covers the spec section-20 panels', () => {
  const js = read('public/js/crypto.js');
  for (const endpoint of ['/api/crypto/status', '/api/crypto/connect', '/api/crypto/disconnect', '/api/crypto/universe',
    '/api/crypto/opportunities', '/api/crypto/positions', '/api/crypto/trades', '/api/crypto/alerts',
    '/api/crypto/settings', '/api/crypto/backtest', '/api/crypto/emergency-stop']) {
    assert.ok(js.includes(endpoint), `calls ${endpoint}`);
  }
  for (const marker of ['cryMarketGrid', 'cryWatchRows', 'cryPositions', 'cryTrades', 'cryBtForm', 'cryPerf', 'crySettings', 'cryAlerts', 'cryEmergencyStop']) {
    assert.ok(js.includes(marker), `renders panel ${marker}`);
  }
  assert.ok(/unavailable:/.test(js), 'per-panel graceful degradation ("unavailable: <error>")');
  assert.ok(!/console\.log\(.*key/i.test(js) && !/localStorage/.test(js), 'never logs or persists keys client-side');
});

test('Crypto nav tab sits after LEAP in desktop and mobile nav', () => {
  const html = read('index.html');
  const desktopCrypto = html.indexOf('data-page="crypto"');
  const desktopOptions = html.indexOf('data-page="options"');
  assert.ok(desktopCrypto !== -1, 'desktop nav has a Crypto entry');
  assert.ok(desktopCrypto > desktopOptions, 'Crypto sorts after LEAP in the desktop nav');
  const mobileSection = html.slice(html.indexOf('id="mobileNav"'));
  const mobileCrypto = mobileSection.indexOf('data-page="crypto"');
  const mobileOptions = mobileSection.indexOf('data-page="options"');
  assert.ok(mobileCrypto !== -1 && mobileOptions !== -1, 'mobile nav has Crypto and LEAP entries');
  assert.ok(mobileCrypto > mobileOptions, 'Crypto sorts after LEAP in the mobile nav');
  assert.ok(html.includes('id="page-crypto"'), 'crypto page container exists');
});

test('crypto asset tags use v=20260929d and no stale tag remains', () => {
  const html = read('index.html');
  assert.ok(html.includes('/js/crypto.js?v=20260929d'), 'Crypto script uses the v=20260929d asset tag');
  assert.ok(html.includes('/public/css/crypto.css?v=20260929d'), 'Crypto stylesheet uses the v=20260929d asset tag');
  assert.ok(!html.includes('v=20260929c'), 'no stale v=20260929c tag remains in index.html');
});

test('app.js routes the crypto page through window.cryptoBot', () => {
  const app = read('public/js/app.js');
  assert.ok(/page==='crypto'/.test(app), 'app.js activates the crypto page');
  assert.ok(/window\.cryptoBot/.test(app), 'app.js drives window.cryptoBot');
  assert.ok(/cryptoBot\.pause\(\)/.test(app), 'app.js pauses cryptoBot on other pages');
  assert.ok(/page==='warrior'/.test(app) && /page==='b2'/.test(app) && /page==='options'/.test(app), 'warrior/b2/options branches untouched');
});

test('crypto.css degrades below 620px without touching shared classes', () => {
  const css = read('public/css/crypto.css');
  assert.ok(css.includes('@media(max-width:620px)'), 'has a small-screen breakpoint');
  assert.ok(!/\.(nav-link|mobile-nav|page|hero)\b/.test(css), 'does not restyle shared nav/page classes');
});
