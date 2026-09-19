'use strict';

// Authenticated development-browser smoke for Search decision levels.
// Every API response is intercepted with deterministic fixtures.
// Run with a running development app: node tests/search-levels-browser.cjs
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const bars = Array.from({ length: 40 }, (_, index) => ({
  t: Date.UTC(2026, 7, 1 + index),
  o: 190 + index * 0.1,
  h: 191 + index * 0.1,
  l: 189 + index * 0.1,
  c: 190 + index * 0.1,
  v: 1_000_000 + index * 1_000,
}));

const completeLevels = {
  bias: { price: 196.5 },
  support: [{ price: 194 }, { price: 190.5 }],
  resistance: [{ price: 199 }, { price: 203.5 }],
  nextSupport: 190.5,
  nextResistance: 203.5,
};

const provisionalPlan = {
  ok: true,
  symbol: 'AAPL',
  generatedAt: '2026-09-19T14:00:00.000Z',
  snapshot: { price: 196.8, prevClose: 195, open: 195.5, high: 198, low: 194.8, volume: 50_000_000, avgVolume: 45_000_000, changePct: 0.9 },
  indicators: { rsi14: 57, distVwapPct: 0.4 },
  confidence: { overall: 62, parts: {} },
  dataGaps: ['Higher-timeframe volume confirmation unavailable'],
  levels: completeLevels,
  displayLevels: completeLevels,
  searchSignal: {
    signal: { state: 'WAIT', direction: 'NEUTRAL', stage: 'PROVISIONAL' },
    confidence: 62,
    reasons: ['Awaiting complete higher-timeframe confirmation'],
  },
  smartMoney: { available: false, status: 'UNAVAILABLE', reason: 'Fixture does not provide Smart Money data.' },
  provenance: { quote: { provider: 'Search fixture', asOf: '2026-09-19T14:00:00.000Z' }, news: [] },
};

const unavailablePlan = {
  ...provisionalPlan,
  symbol: 'MSFT',
  snapshot: { ...provisionalPlan.snapshot, symbol: 'MSFT' },
  levels: { support: [{ price: 194 }], resistance: [{ price: 199 }] },
  displayLevels: { support: [{ price: 194 }], resistance: [{ price: 199 }] },
  searchSignal: {
    signal: { state: 'WAIT', direction: 'NEUTRAL', stage: 'PROVISIONAL' },
    reasons: ['Completed-session levels are still loading'],
  },
  dataGaps: ['Completed-session history required'],
};

function installMock() {
  const realFetch = window.fetch.bind(window);
  const fixture = __FIXTURE__;
  window.__releaseGameplan = null;
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, options);
    if (url === '/api/auth/me') {
      return new Response(JSON.stringify({ id: 79, username: 'search-levels-smoke' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith('/api/gameplan/AAPL')) {
      return new Promise(resolve => {
        window.__releaseGameplan = () => resolve(new Response(JSON.stringify(fixture.complete), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      });
    }
    if (url.startsWith('/api/gameplan/MSFT')) {
      return new Response(JSON.stringify(fixture.unavailable), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith('/api/bars/')) {
      return new Response(JSON.stringify({ bars: fixture.bars }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

async function main() {
  assert.ok(process.env.REPLIT_DEV_DOMAIN, 'Run against the development workspace, never production.');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'search-levels-ui-test-'));
  const chrome = spawn('chromium', [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chromium startup timed out')), 15_000);
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
        const item = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.exception?.description || 'JavaScript exception');
      }
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => {
        pending.delete(current);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      pending.set(current, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: current, method, params }));
    });
    const js = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || expression);
      return result.result.value;
    };
    const wait = async expression => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (await js(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`UI condition timed out: ${expression}`);
    };
    const assertNoOverflow = async width => {
      const bounds = await js(`(() => {
        const el = document.querySelector('#searchDecisionLevelsTop');
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      })()`);
      const clipped = await js(`(() => Array.from(document.querySelector('#searchDecisionLevelsTop').querySelectorAll('*'))
        .filter(el => el.textContent.trim() && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
        .map(el => ({ className: el.className, text: el.textContent.trim().slice(0, 100), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })))()`);
      assert.ok(bounds.left >= 0 && bounds.right <= width,
        `Search levels exceed ${width}px viewport: ${JSON.stringify(bounds)}`);
      assert.deepEqual(clipped, [], `Search level text is horizontally clipped: ${JSON.stringify(clipped)}`);
      assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true);
    };

    await call('Runtime.enable');
    await call('Page.enable');
    const source = `(${installMock.toString().replace('__FIXTURE__', JSON.stringify({
      complete: provisionalPlan,
      unavailable: unavailablePlan,
      bars,
    }))})();`;
    await call('Page.addScriptToEvaluateOnNewDocument', { source });
    await call('Page.navigate', { url: `https://${process.env.REPLIT_DEV_DOMAIN}/` });
    await wait(`document.querySelector('#authOverlay')?.classList.contains('auth-hidden') && typeof openStock === 'function'`);

    await js(`void openStock('AAPL', ${JSON.stringify(provisionalPlan.snapshot)})`);
    await wait(`document.querySelector('#gpLoading').style.display !== 'none'`);
    assert.match(await js(`document.querySelector('#gpLoading').textContent`), /Analyzing AAPL/);
    await js('window.__releaseGameplan()');
    await wait(`document.querySelector('#searchDecisionLevelsTop').style.display !== 'none'`);
    assert.equal(await js(`document.querySelector('#searchDecisionLevelsTop .gp-levels').querySelectorAll('.gp-lvl-row').length`), 5,
      await js(`document.querySelector('#gpError').textContent || document.querySelector('#gpContent').textContent.slice(0, 200)`));

    assert.equal(await js(`document.querySelector('#searchVerdictTop').compareDocumentPosition(document.querySelector('#searchDecisionLevelsTop')) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false`), true);
    assert.equal(await js(`document.querySelector('#searchVerdictTop').classList.contains('provisional')`), true);
    assert.equal(await js(`document.querySelector('#searchVerdictStage').textContent`), 'ZONE BIAS');
    const levelText = await js(`document.querySelector('#searchDecisionLevelsTop').textContent`);
    assert.match(levelText, /Key bias level/);
    assert.match(levelText, /Support/);
    assert.match(levelText, /Next support after a break below/);
    assert.match(levelText, /Resistance/);
    assert.match(levelText, /Next resistance after a break above/);
    await assertNoOverflow(1280);

    await call('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await js('new Promise(resolve => setTimeout(resolve, 200))');
    await assertNoOverflow(390);

    await js(`void openStock('MSFT', ${JSON.stringify(unavailablePlan.snapshot)})`);
    await wait(`document.querySelector('#searchDecisionLevelsTop').style.display !== 'none' && document.querySelector('#searchDecisionLevelsTop').textContent.includes('UNAVAILABLE')`);
    const unavailableText = await js(`document.querySelector('#searchDecisionLevelsTop').textContent`);
    assert.match(unavailableText, /Key bias level unavailable/);
    assert.match(unavailableText, /Next resistance if price breaks up/);
    assert.match(unavailableText, /Next support if price breaks down/);
    await assertNoOverflow(390);
    assert.deepEqual(exceptions, []);
    console.log('PASS Search levels browser: authenticated loading/provisional/unavailable states, signal ordering, readable desktop/mobile levels, no horizontal overflow, and no browser exceptions.');
  } finally {
    ws?.close();
    chrome.kill('SIGTERM');
    await new Promise(resolve => {
      if (chrome.exitCode !== null) resolve();
      else { chrome.once('exit', resolve); setTimeout(resolve, 2_000).unref(); }
    });
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });