'use strict';

// Development-only browser smoke. Every B2 API call is intercepted in this
// isolated browser; these fixtures can never reach an Alpaca account.
// Run with a running application: node tests/b2-ui-smoke.cjs
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function installMock() {
  const realFetch = window.fetch.bind(window);
  const s = {
    connected: false, mode: 'paper', enabled: false, liveArmed: false,
    accountId: null, maxPositionDollars: 1000, marketOpen: false,
    coverage: { total: 12000, scanned: 100, updatedAt: new Date().toISOString() },
    scheduler: { status: 'market_closed', reason: 'Market closed; reconciled only.' },
    connections: { paper: { connected: false }, live: { connected: false } },
  };
  window.__b2Requests = [];
  window.__b2Mock = s;
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/b2/')) return realFetch(input, options);
    const body = JSON.parse(options.body || '{}'), method = options.method || 'GET';
    window.__b2Requests.push({ url, method, fields: Object.keys(body) });
    let output, code = 200;
    if (url.endsWith('/settings')) {
      if (Object.keys(body).join(',') !== 'maxPositionDollars') {
        output = { error: 'Only position size may be changed.' }; code = 400;
      } else s.maxPositionDollars = body.maxPositionDollars;
    } else if (url.endsWith('/credentials') && method === 'PUT') {
      s.connected = true; s.mode = body.mode; s.accountId = `mock-${body.mode}`;
      s.enabled = body.mode === 'paper';
      s.liveArmed = false;
      s.connections[body.mode] = { connected: true, accountId: s.accountId };
    } else if (url.endsWith('/credentials') && method === 'DELETE') {
      s.connected = s.enabled = s.liveArmed = false; s.accountId = null;
      s.connections = { paper: { connected: false }, live: { connected: false } };
    } else if (url.endsWith('/mode')) {
      s.mode = body.mode; s.connected = s.connections[body.mode].connected;
      s.accountId = s.connections[body.mode].accountId;
      s.enabled = body.mode === 'paper';
      s.liveArmed = false;
    } else if (url.endsWith('/automation')) {
      s.enabled = body.action === 'resume';
      s.liveArmed = s.enabled && s.mode === 'live' && body.authorizeLive === true;
    } else if (url.endsWith('/candidates')) output = { candidates: [], coverage: s.coverage };
    else if (url.endsWith('/trades')) output = { trades: [] };
    else if (url.endsWith('/alerts')) output = { alerts: [] };
    s.ready = s.connected && s.enabled;
    s.blockers = s.connected ? s.enabled ? [] : ['Automation is paused.'] : ['Connect a dedicated account.'];
    return new Response(JSON.stringify(output || s), { status: code, headers: { 'Content-Type': 'application/json' } });
  };
}

async function main() {
  assert.ok(process.env.REPLIT_DEV_DOMAIN, 'Run against the development workspace, never production.');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-ui-test-'));
  const chrome = spawn('chromium', [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chromium startup timed out')), 15000);
      chrome.on('error', error => { clearTimeout(timeout); reject(error); });
      let log = '';
      chrome.stderr.on('data', data => {
        log += data.toString();
        const match = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map(), exceptions = [];
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const item = pending.get(message.id); pending.delete(message.id);
        clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(current, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: current, method, params }));
    });
    const js = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || expression);
      return result.result.value;
    };
    const wait = async expression => {
      for (let i = 0; i < 100; i++) {
        if (await js(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`UI condition timed out: ${expression}`);
    };
    await call('Runtime.enable'); await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installMock.toString()})();` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `https://${process.env.REPLIT_DEV_DOMAIN}/` });
    await wait('typeof goPage === "function" && !!document.querySelector("#authOverlay")');
    await js(`document.querySelector('#authOverlay').style.display='none'; goPage('b2')`);
    await wait(`document.querySelector('#b2Execution').textContent === 'NOT CONNECTED'`);
    assert.equal(await js(`document.querySelectorAll('#b2Enabled,#b2LiveArm,#b2Scan').length`), 0);

    await js(`document.querySelector('#b2Max').value='750'; document.querySelector('#b2Max').dispatchEvent(new Event('input')); document.querySelector('#b2Save').click()`);
    await wait(`document.querySelector('#b2Notice').textContent.includes('Position size saved')`);
    assert.deepEqual(await js(`__b2Requests.find(r=>r.url.endsWith('/settings')).fields`), ['maxPositionDollars']);
    await js(`document.querySelector('#b2PaperConnect').click()`);
    assert.equal(await js(`document.querySelector('#b2LiveConsent').hidden`), true);
    await js(`document.querySelector('#b2Key').value='MOCK_ONLY'; document.querySelector('#b2Secret').value='MOCK_ONLY'; document.querySelector('#b2Form').requestSubmit()`);
    await wait(`!document.querySelector('#b2Modal') && document.querySelector('#b2Execution').textContent === 'STANDING ASIDE'`);
    assert.equal(await js(`__b2Mock.enabled`), true);
    await js(`document.querySelector('#b2Automation').click()`);
    await wait(`document.querySelector('#b2Execution').textContent === 'PAUSED'`);
    await js(`document.querySelector('#b2Automation').click()`);
    await wait(`__b2Mock.enabled === true`);

    await js(`document.querySelector('#b2LiveConnect').click()`);
    assert.equal(await js(`__b2Mock.mode`), 'paper', 'Opening a Live tab must not switch the account');
    assert.equal(await js(`document.querySelector('#b2AuthorizeLive').required`), true);
    await js(`document.querySelector('#b2Key').value='MOCK_ONLY'; document.querySelector('#b2Secret').value='MOCK_ONLY'; document.querySelector('#b2Form').requestSubmit()`);
    assert.equal(await js(`__b2Mock.mode`), 'paper', 'Unconfirmed Live form must not submit');
    await js(`document.querySelector('#b2AuthorizeLive').click(); document.querySelector('#b2Form').requestSubmit()`);
    await wait(`__b2Mock.mode === 'live' && !document.querySelector('#b2Modal')`);
    assert.equal(await js(`__b2Mock.liveArmed`), true);
    await js(`document.querySelector('#b2PaperConnect').click(); document.querySelector('#b2UseSaved').click()`);
    await wait(`__b2Mock.mode === 'paper' && !document.querySelector('#b2Modal')`);
    assert.equal(await js(`__b2Mock.liveArmed`), false);
    assert.equal(await js(`__b2Mock.maxPositionDollars`), 750);
    assert.equal(await js(`__b2Requests.some(r=>r.url.endsWith('/scan'))`), false);
    const desktop = await call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(os.tmpdir(), 'b2-ui-desktop.png'), Buffer.from(desktop.data, 'base64'));

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await js(`window.scrollTo(0,0)`);
    assert.equal(await js(`document.documentElement.scrollWidth <= window.innerWidth`), true);
    assert.equal(await js(`document.querySelector('.b2-broker').getBoundingClientRect().top < document.querySelector('.b2-main').getBoundingClientRect().top`), true);
    const mobile = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await fs.writeFile(path.join(os.tmpdir(), 'b2-ui-mobile.png'), Buffer.from(mobile.data, 'base64'));
    await js(`document.querySelector('#b2LiveConnect').click()`);
    assert.equal(await js(`document.querySelector('#b2Modal').getBoundingClientRect().width <= 390`), true);
    await call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 620, deviceScaleFactor: 1, mobile: false });
    assert.equal(await js(`document.querySelector('#b2Submit').getBoundingClientRect().bottom <= window.innerHeight`), true);
    assert.equal(await js(`document.querySelector('#b2Submit').getBoundingClientRect().top >= 0`), true);
    assert.equal(await js(`getComputedStyle(document.querySelector('#b2Submit')).display !== 'none'`), true);
    assert.equal(await js(`document.querySelector('.b2-modal-scroll').scrollHeight >= document.querySelector('.b2-modal-scroll').clientHeight`), true);
    assert.deepEqual(exceptions, []);
    console.log('PASS B2 UI: size-only settings, automatic Paper, explicit Live consent, saved account selection, safety pause/resume, no manual scans, desktop/mobile, short-height visible connect action. All B2 broker calls mocked.');
  } finally {
    ws?.close();
    chrome.kill('SIGTERM');
    await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else { chrome.once('exit', resolve); setTimeout(resolve, 2000).unref(); } });
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });