'use strict';

// Brokers page (Johnny 2026-10-16): a dedicated page is THE place broker
// API keys are entered. The Alpaca card re-hosts the existing Kiaan
// connect form — same /api/kiaan/connect + /api/kiaan/disconnect
// endpoints and credential store, no parallel store — with an explicit
// Paper account / Live account choice. IBKR and Tradier are
// "In development" placeholders with no credential capture. Connect
// endpoint behavior itself is unchanged and covered by
// kiaan-service.test.js (paper and live connects, stored per mode).

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

const read = p => readFileSync(require.resolve(p), 'utf8');
const html = read('../index.html');
const appJs = read('../public/js/app.js');
const brokersJs = read('../public/js/brokers.js');
const brokersCss = read('../public/css/brokers.css');
const kiaanJs = read('../public/js/kiaan.js');
const service = read('../lib/kiaan/service.js');

test('index.html has the Brokers nav entry (desktop + mobile), page container, and bumped assets', () => {
  assert.ok((html.match(/data-page="brokers"/g) || []).length >= 2, 'desktop and mobile nav both carry Brokers');
  assert.ok(html.includes('id="page-brokers"'), 'page-brokers container exists');
  assert.ok(html.includes('/js/brokers.js?v=20261020b'), 'brokers.js included with a cache-busting tag');
  assert.ok(html.includes('/public/css/brokers.css?v=20261018b'), 'brokers.css included with a cache-busting tag');
  assert.ok(html.includes('/js/app.js?v=20261020b'), 'app.js tag bumped for the routing change');
});

test('app.js routes the brokers page through window.brokersPage', () => {
  assert.ok(/page==='brokers'/.test(appJs), 'app.js activates the brokers page');
  assert.ok(/window\.brokersPage/.test(appJs), 'app.js drives window.brokersPage');
  assert.ok(/brokersPage\.pause\(\)/.test(appJs), 'app.js pauses brokersPage on other pages');
});

test('brokers.js hosts the Alpaca key interface on the EXISTING kiaan connect endpoints', () => {
  for (const path of ['/api/kiaan/status', '/api/kiaan/connect', '/api/kiaan/disconnect']) {
    assert.ok(brokersJs.includes(path), `brokers.js calls ${path}`);
  }
  assert.ok(brokersJs.includes('API Key ID'), 'key field present');
  assert.ok(brokersJs.includes('API Secret Key'), 'secret field present');
  assert.ok(brokersJs.includes('Paper account'), 'explicit Paper account choice, plainly labelled');
  assert.ok(brokersJs.includes('Live account'), 'explicit Live account choice, plainly labelled');
  assert.ok(/name="brkMode" value="paper"/.test(brokersJs), 'paper radio posts mode paper');
  assert.ok(/name="brkMode" value="live"/.test(brokersJs), 'live radio posts mode live');
  assert.ok(/window\.brokersPage/.test(brokersJs), 'brokers.js exposes window.brokersPage');
});

test('the key interface exists ONLY on the brokers page (bot page stays key-free)', () => {
  for (const bad of ['/api/kiaan/connect', '/api/kiaan/disconnect', 'brkKey', 'brkSecret']) {
    assert.ok(!kiaanJs.includes(bad), `kiaan.js must not contain ${bad}`);
  }
});

test('broker cards: Alpaca available, IBKR + Tradier in development with no capture, RH/Fidelity note', () => {
  assert.ok(brokersJs.includes('Available now'), 'Alpaca marked available');
  assert.ok(brokersJs.includes('Interactive Brokers'), 'IBKR card present');
  assert.ok(brokersJs.includes('Tradier'), 'Tradier card present');
  assert.ok((brokersJs.match(/In development/g) || []).length >= 2, 'IBKR and Tradier both marked In development');
  assert.ok(brokersJs.includes('Robinhood and Fidelity do not offer an official trading API'), 'honest no-API note present');
  assert.ok(brokersJs.includes('Alpaca Broker API'), 'in-app account-opening (Broker API) noted as planned');
  assert.ok(brokersJs.includes('Connect a brokerage once; VixionBot Agentic trades only the account you connect; you can disconnect anytime.'), 'plain-language intro line present');
  // No credential capture or connect path for the in-development brokers.
  for (const bad of ['/api/ibkr', '/api/interactive', '/api/tradier', 'ibkrKey', 'tradierKey']) {
    assert.ok(!brokersJs.includes(bad), `brokers.js must not contain ${bad}`);
  }
});

test('how-to-connect instructions module sits in the Alpaca card for every user (Johnny 2026-10-18)', () => {
  assert.ok(brokersJs.includes('<details class="brk-help">'), 'collapsible instructions module present');
  assert.ok(brokersJs.includes('How to connect your API keys'), 'module title present');
  // Placed inside the Alpaca card, between the status row and the form.
  const stateIdx = brokersJs.indexOf('id="brkAlpacaState"');
  const helpIdx = brokersJs.indexOf('brk-help');
  const formIdx = brokersJs.indexOf('id="brkForm"');
  assert.ok(stateIdx > -1 && helpIdx > stateIdx && helpIdx < formIdx, 'module sits between status and the connect form');
  // The five steps, accurate to the real flow.
  assert.ok(brokersJs.includes('pick <b>Paper</b> or <b>Live</b> trading inside Alpaca first'), 'step 1: choose the environment inside Alpaca first');
  assert.ok(brokersJs.includes('API Keys → Generate New Key'), 'step 2: generate the pair in Alpaca');
  assert.ok(brokersJs.includes('the secret is shown only once, and generating a new pair replaces the old one'), 'step 2: secret shown once, new pair replaces the old');
  assert.ok(brokersJs.includes('to match where the keys came from, paste both, and tap <b>Connect</b>'), 'step 3: match Paper/Live here and connect');
  assert.ok(brokersJs.includes('We verify the keys with Alpaca before saving anything'), 'step 4: verified before anything is saved');
  assert.ok(brokersJs.includes("the pair doesn't match or the Paper/Live choice is wrong"), 'step 4: rejection means mismatched pair or wrong choice');
  assert.ok(brokersJs.includes('Keys are stored encrypted and never shown again'), 'step 5: encrypted, never shown again');
  assert.ok(brokersJs.includes("Connecting doesn't turn trading on — enable the bot on the VixionBot Agentic page"), 'step 5: connecting does not enable trading');
  // Muted design language: styled from brokers.css theme vars, no gradient.
  assert.ok(/\.brk-help\{[^}]*var\(--line\)/.test(brokersCss), 'module styled with the page theme vars');
  assert.ok(!/\.brk-help[^{]*\{[^}]*gradient/.test(brokersCss), 'module uses no gradient');
  // No bot internals in the module copy.
  for (const bad of ['fixedDollars', 'longUniverse', 'hedgeSymbols', 'ATR', 'regime score']) {
    assert.ok(!brokersJs.includes(bad), `instructions must not contain internals: ${bad}`);
  }
});

test('connect endpoint behavior: paper + live accepted and stored per mode, bogus modes refused loudly (no parallel store)', () => {
  assert.ok(service.includes("mode !== 'paper' && mode !== 'live'"), 'connect accepts exactly paper or live');
  assert.ok(service.includes("Connect mode must be 'paper' or 'live'"), 'bogus mode refusal is loud, not a quiet downgrade');
  assert.ok(service.includes('mode mismatch'), 'order-path mode guard present in the service');
  assert.ok(service.includes("app.post('/api/kiaan/connect'"), 'connect route unchanged');
  assert.ok(service.includes("app.post('/api/kiaan/disconnect'"), 'disconnect route unchanged');
  assert.ok(brokersJs.includes('Live account — real money'), 'live option carries the plain real-money warning');
  assert.ok(!brokersJs.includes('not accepted yet'), 'stale paper-only note is gone');
});
