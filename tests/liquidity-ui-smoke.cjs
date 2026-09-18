'use strict';

// Isolated renderer smoke. It loads only the real heatmap module against
// deterministic provider contracts; it never calls the application or a market
// data provider.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'public/js/liquidity-heatmap.js'), 'utf8');
const valid = {
  schemaVersion: 'liquidity.v1',
  provider: 'Alpaca IEX top-of-book snapshot',
  status: 'PARTIAL',
  available: true,
  partial: true,
  currentPrice: 100,
  topOfBook: { bid: 99.9, bidSize: 200, ask: 100.1, askSize: 100, midpoint: 100, timestamp: '2026-08-25T14:59:58.000Z' },
  spread: { absolute: 0.2, percent: 0.2 },
  imbalance: { bidNotional: 19980, askNotional: 10010, percent: 33.22 },
  recentTrade: { price: 100.1, size: 40, timestamp: '2026-08-25T14:59:57.000Z' },
  technicalContext: { support: 98, resistance: 102, relativeVolume: 1.8 },
  level2: { available: false, reason: 'Current Alpaca snapshot exposes top-of-book, not full Level 2 depth.' },
  walls: { available: false, reason: 'Top-of-book data cannot establish liquidity walls.' },
  absorption: { available: false, reason: 'Sufficient executed-flow history is unavailable.' },
  shift: { available: true, direction: 'BID_UP_ASK_DOWN', bidLiquidityChangePct: 10, askLiquidityChangePct: -5 },
  history: [
    { at: '2026-08-25T14:58:58.000Z', bid: 99.9, ask: 100.1, state: 'NEUTRAL_MIXED' },
    { at: '2026-08-25T14:59:58.000Z', bid: 99.9, ask: 100.1, state: 'BULLISH_PRESSURE' },
  ],
  score: {
    total: 3.5,
    max: 7,
    bullishThreshold: 2.5,
    bearishThreshold: -2.5,
    components: [
      { key: 'vwap', label: 'Price vs VWAP', score: 1.5, max: 1.5, reason: 'Price is above VWAP.' },
      { key: 'relativeVolume', label: 'Relative volume', score: 1, max: 1, reason: 'Relative volume 1.80× confirms participation.' },
    ],
  },
  state: 'BULLISH_PRESSURE',
  summary: 'Current market structure suggests bullish pressure.',
  warnings: ['Liquidity is changing; resting quotes can disappear or move.'],
};
const unavailable = {
  schemaVersion: 'liquidity.v1',
  provider: 'Yahoo Finance',
  status: 'UNAVAILABLE',
  available: false,
  summary: 'Heatmap data unavailable from current market-data provider.',
  warnings: ['Heatmap data unavailable from current market-data provider.'],
  level2: { available: false, reason: 'Current provider does not expose Level 2 market depth.' },
};

async function main() {
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'liquidity-ui-'));
  const chrome = spawn('chromium', [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chromium startup timed out')), 15000);
      let log = '';
      chrome.on('error', error => { clearTimeout(timeout); reject(error); });
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
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
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
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      *{box-sizing:border-box}body{margin:0;background:#0a0d18;color:#dce8fa;font:14px sans-serif}
      #liquidityHeatmap{width:100%;max-width:100%;overflow:hidden}.lh-book{display:grid;grid-template-columns:1fr}
    </style><section id="liquidityHeatmap" hidden></section>`;
    await call('Page.navigate', { url: `data:text/html,${encodeURIComponent(html)}` });
    await new Promise(resolve => setTimeout(resolve, 100));
    await js(`eval(${JSON.stringify(renderer)})`);
    await js(`window.liquidityHeatmap.render(${JSON.stringify(valid)}, 'NVDA')`);

    assert.match(await js(`document.querySelector('h2').textContent`), /🔥 Liquidity & Direction Heatmap/);
    assert.match(await js(`document.querySelector('.lh-side.bid').textContent`), /\$99\.90/);
    assert.match(await js(`document.querySelector('.lh-side.bid').textContent`), /200 shares/);
    assert.match(await js(`document.querySelector('.lh-side.ask').textContent`), /\$100\.10/);
    assert.match(await js(`document.querySelector('.lh-side.ask').textContent`), /100 shares/);
    assert.match(await js(`document.querySelector('.lh-state').textContent`), /BULLISH PRESSURE/);
    assert.match(await js(`document.querySelector('.lh-provenance').textContent`), /Alpaca IEX top-of-book snapshot/);
    assert.match(await js(`document.querySelector('.lh-mid').textContent`), /IEX TOP OF BOOK/);
    assert.match(await js(`document.querySelector('.lh-card:nth-child(3)').textContent`), /BID UP ASK DOWN/);
    assert.match(await js(`document.querySelector('.lh-columns h3').textContent`), /3\.50 \/ 7\.00/);
    assert.match(await js(`document.querySelector('.lh-threshold').textContent`), /Bullish ≥ 2\.5.*Bearish ≤ -2\.5/);
    assert.match(await js(`document.querySelector('.lh-score').textContent`), /Price vs VWAP/);
    assert.match(await js(`document.querySelector('.lh-limitations').textContent`), /Top-of-book is not Level 2/);
    assert.equal(await js(`document.documentElement.scrollWidth <= window.innerWidth`), true);
    assert.equal(await js(`document.querySelector('.lh-state').getBoundingClientRect().top < window.innerHeight`), true);
    assert.equal(await js(`document.querySelector('.lh-topline').getBoundingClientRect().top < window.innerHeight`), true);

    await js(`window.liquidityHeatmap.render(${JSON.stringify({ ...valid, state: 'BEARISH_PRESSURE', summary: 'Second symbol.' })}, 'AMD')`);
    assert.equal(await js(`document.querySelector('h2').textContent.includes('NVDA')`), false);
    assert.equal(await js(`document.querySelector('.lh-kicker').textContent.includes('AMD')`), true);
    assert.equal(await js(`document.querySelectorAll('.lh-book').length`), 1);

    await js(`window.liquidityHeatmap.render(${JSON.stringify(unavailable)}, 'AMD')`);
    assert.match(await js(`document.querySelector('.lh-unavailable').textContent`), /Heatmap data unavailable from current market-data provider\./);
    assert.equal(await js(`document.querySelectorAll('.lh-book').length`), 0);
    console.log('PASS liquidity UI smoke: valid Alpaca top-of-book, unavailable Yahoo, symbol replacement, score reasons, and 390px responsive visibility.');
  } finally {
    ws?.close();
    chrome.kill('SIGTERM');
    await new Promise(resolve => {
      if (chrome.exitCode !== null) resolve();
      else { chrome.once('exit', resolve); setTimeout(resolve, 2000).unref(); }
    });
    await fs.promises.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });