'use strict';

// Focused development-browser coverage for the verified macro context. All API
// responses in the intercepted browser are fixtures; no account or bot call is
// permitted to reach the application. Run with a running development app:
// node tests/macro-context-browser.cjs
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildVerifiedMacroContext } = require('../lib/verified-macro-context');

const NOW = Date.parse('2025-05-07T15:00:00.000Z');
const fixture = buildVerifiedMacroContext({
  // Deterministic mocked official provider envelopes. These are deliberately
  // source-backed-shaped values, but are never fetched by this test.
  treasury: {
    status: 'available', source: 'U.S. Treasury (mock fixture)',
    url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates',
    asOf: '2025-05-07', fetchedAt: '2025-05-07T14:00:00.000Z',
    data: {
      twoYear: 4.12, tenYear: 4.58, thirtyYear: 4.91,
      previous: { twoYear: 4.02, tenYear: 4.44, thirtyYear: 4.83, asOf: '2025-05-06' },
    },
  },
  fed: {
    status: 'available', source: 'Federal Reserve (mock fixture)',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    asOf: '2025-05-07', fetchedAt: '2025-05-07T14:00:00.000Z',
    data: {
      policy: {
        lower: 4.25, upper: 4.5, asOf: '2025-05-07',
        url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      },
      calendarVerifiedAt: '2025-05-07T14:00:00.000Z',
      events: [
        { date: '2025-05-08', title: 'FOMC meeting (mock fixture)', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' },
        { date: '2025-06-18', title: 'FOMC decision (mock fixture)', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' },
      ],
    },
  },
  inflation: {
    status: 'available', source: 'Bureau of Labor Statistics (mock fixture)',
    url: 'https://www.bls.gov/cpi/', asOf: '2025-04-30', fetchedAt: '2025-05-07T14:00:00.000Z',
    data: { cpiYoY: 3.4, period: 'April 2025' },
  },
  employment: {
    status: 'available', source: 'Bureau of Labor Statistics (mock fixture)',
    url: 'https://www.bls.gov/news.release/empsit.nr0.htm', asOf: '2025-04-30',
    fetchedAt: '2025-05-07T14:00:00.000Z',
    data: { unemploymentRate: 4.1, payrollChangeThousands: 177, period: 'April 2025' },
  },
}, NOW);
fixture.generatedAt = '2025-05-07T15:00:00.000Z';

function installMock() {
  const realFetch = window.fetch.bind(window);
  const macroFixture = __MACRO_FIXTURE__;
  window.__macroRequests = [];
  window.__macroFail = false;
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, options);
    window.__macroRequests.push(url);
    if (url === '/api/verified-macro-context') {
      if (window.__macroFail) return new Response(JSON.stringify({ error: 'fixture refresh rejection' }), { status: 503 });
      return new Response(JSON.stringify(macroFixture), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Scanner and other page modules must never make real API calls here.
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function main() {
  assert.ok(process.env.REPLIT_DEV_DOMAIN, 'Run against the development workspace, never production.');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'macro-ui-test-'));
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
    ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const item = pending.get(message.id); pending.delete(message.id);
        clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.exception?.description || 'JavaScript exception');
      }
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
      for (let i = 0; i < 120; i++) {
        if (await js(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`UI condition timed out: ${expression}`);
    };

    await call('Runtime.enable'); await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `https://${process.env.REPLIT_DEV_DOMAIN}/` });
    await wait('document.readyState === "complete"');
    assert.equal(await js(`fetch('/api/verified-macro-context').then(response => response.status)`), 401,
      'Unauthenticated macro API requests must remain protected before interception.');

    const source = `(${installMock.toString().replace('__MACRO_FIXTURE__', JSON.stringify(fixture))})();`;
    await call('Page.addScriptToEvaluateOnNewDocument', { source });
    await call('Page.reload', { ignoreCache: true });
    await wait('typeof goPage === "function" && !!document.querySelector("#authOverlay")');
    await js(`document.querySelector('#authOverlay').style.display='none'; goPage('scanner')`);
    await wait(`document.querySelector('#macroContent').textContent.includes('MEASURED MACRO RISK')`);
    await wait(`document.querySelector('.macro-score-value strong').textContent.includes('/100')`);
    assert.match(await js(`document.querySelector('#macroContent').textContent`), /2Y/);
    assert.match(await js(`document.querySelector('#macroContent').textContent`), /Schedule retrieved/);
    assert.ok(await js(`document.querySelectorAll('.macro-events li').length >= 2`));
    assert.ok(await js(`document.querySelectorAll('.macro-components li').length >= 5`));
    assert.ok(await js(`document.querySelector('.macro-source').textContent.includes('Observed')`));
    assert.ok(await js(`__macroRequests.includes('/api/verified-macro-context')`));

    await js(`window.__macroFail=true; document.querySelector('#macroRefresh').click()`);
    await wait(`document.querySelector('.macro-score-value').classList.contains('macro-unavailable')`);
    assert.match(await js(`document.querySelector('#macroContent').textContent`), /Refresh failed/);
    assert.equal(await js(`document.querySelector('.macro-yields')`), null);
    assert.equal(await js(`document.querySelectorAll('.macro-events').length`), 0);

    await js(`window.__macroFail=false; document.querySelector('#macroRefresh').click()`);
    await wait(`document.querySelector('.macro-score-value strong').textContent.includes('/100')`);
    assert.ok(await js(`document.querySelector('.macro-yields') !== null`));
    assert.ok(await js(`document.querySelectorAll('.macro-events li').length >= 2`));

    await js(`document.querySelector('#macroContext').scrollIntoView({ block: 'start' })`);
    const desktop = await call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile('/tmp/macro-ui-desktop.png', Buffer.from(desktop.data, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await js(`new Promise(resolve => setTimeout(resolve, 350))`);
    await js(`document.querySelector('#macroContext').scrollIntoView({ block: 'start' })`);
    const mobileBounds = await js(`(() => { const r = document.querySelector('#macroContext').getBoundingClientRect(); return { left:r.left, right:r.right, width:r.width }; })()`);
    const clippedText = await js(`(() => Array.from(document.querySelector('#macroContext').querySelectorAll('*')).filter(el => {
      if (!el.textContent.trim() || el.clientWidth === 0) return false;
      return el.scrollWidth > el.clientWidth + 1;
    }).map(el => ({ tag:el.tagName, className:el.className, text:el.textContent.trim().slice(0,80), scrollWidth:el.scrollWidth, clientWidth:el.clientWidth })) )()`);
    const mobile = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await fs.writeFile('/tmp/macro-ui-mobile.png', Buffer.from(mobile.data, 'base64'));
    assert.ok(mobileBounds.left >= 0 && mobileBounds.right <= 390,
      `macro root exceeds 390px viewport: ${JSON.stringify(mobileBounds)}; clipped descendants: ${JSON.stringify(clippedText)}`);
    assert.deepEqual(clippedText, [], `macro text is horizontally clipped: ${JSON.stringify(clippedText)}`);
    assert.equal(await js(`document.documentElement.scrollWidth <= window.innerWidth`), true);
    assert.deepEqual(exceptions, []);
    console.log('PASS macro context browser: protected API, deterministic verified fixture, score/source timestamps/Fed events/yields/components, rejection clearing, recovery, desktop/mobile screenshots, no macro overflow or JS exceptions.');
  } finally {
    ws?.close();
    chrome.kill('SIGTERM');
    await new Promise(resolve => {
      if (chrome.exitCode !== null) resolve();
      else { chrome.once('exit', resolve); setTimeout(resolve, 2000).unref(); }
    });
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });