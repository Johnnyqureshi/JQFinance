'use strict';

// Authenticated development-browser smoke for Search Smart Money interactions.
// Every market-data response is intercepted with deterministic AAPL fixtures.
// Run with a running development app: node tests/smart-money-browser.cjs
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const timeframes = ['1H', '4H', '1D', '1W', '1M'];
const chartBars = Array.from({ length: 60 }, (_, index) => {
  const close = 190 + index * 0.12 + (index % 7 === 0 ? -0.35 : 0);
  return {
    t: Date.UTC(2026, 7, 1, 14) + index * 60 * 60 * 1000,
    o: close - 0.08, h: close + 0.45, l: close - 0.42, c: close, v: 100000 + index * 1000,
  };
});

function mapFixture(timeframe) {
  const offset = timeframes.indexOf(timeframe) * 0.15;
  const zones = [
    { id: `${timeframe}-d1`, type: 'DEMAND', low: 193 + offset, high: 194 + offset, midpoint: 193.5 + offset, score: 88, confidence: 'HIGH', status: 'FRESH', timeframe, distancePct: 1, touches: 2, freshness: 'FRESH', factors: ['Displacement'], invalidation: { reference: 192.5, rule: 'Close below reference' }, origin: { t: chartBars[20].t } },
    { id: `${timeframe}-s1`, type: 'SUPPLY', low: 198 + offset, high: 199 + offset, midpoint: 198.5 + offset, score: 84, confidence: 'HIGH', status: 'FRESH', timeframe, distancePct: 1.4, touches: 2, freshness: 'FRESH', factors: ['Volume expansion'], invalidation: { reference: 199.5, rule: 'Close above reference' }, origin: { t: chartBars[30].t } },
    { id: `${timeframe}-d2`, type: 'DEMAND', low: 190 + offset, high: 191 + offset, midpoint: 190.5 + offset, score: 72, confidence: 'MEDIUM', status: 'TESTED', timeframe, distancePct: 3, touches: 1, freshness: 'TESTED', factors: ['Structure'], invalidation: { reference: 189.5, rule: 'Close below reference' }, origin: { t: chartBars[10].t } },
    { id: `${timeframe}-s2`, type: 'SUPPLY', low: 201 + offset, high: 202 + offset, midpoint: 201.5 + offset, score: 68, confidence: 'MEDIUM', status: 'FRESH', timeframe, distancePct: 4, touches: 1, freshness: 'FRESH', factors: ['Swing rejection'], invalidation: { reference: 202.5, rule: 'Close above reference' }, origin: { t: chartBars[40].t } },
  ];
  return {
    ok: true, symbol: 'AAPL', available: true, status: 'AVAILABLE', timeframe,
    availableTimeframes: timeframes, currentPrice: 196.8, confidence: 82, bias: 'BALANCED',
    zones, demand: zones.filter(zone => zone.type === 'DEMAND'), supply: zones.filter(zone => zone.type === 'SUPPLY'),
    nearest: { demand: zones[0], supply: zones[1] },
    range: { positionPct: 58, label: 'MIDDLE' },
    structure: { state: 'BULLISH', swingHigh: { price: 200, t: '2026-08-28' }, swingLow: { price: 188, t: '2026-08-01' } },
    indicators: { atr: 2.1, rsi14: 57 }, dataQuality: { history: 'COMPLETE', volumeAvailable: true },
    liquidity: { above: [], below: [] }, supportResistance: { support: zones[0], resistance: zones[1] },
    fairValueGaps: [], liquiditySweeps: [], chartBars,
    overlay: { liquidity: [], swings: [] },
    methodology: 'Deterministic fixture map from completed OHLCV bars.',
    disclaimer: 'Potential zones are supporting context and do not show actual institutional orders.',
  };
}

const maps = Object.fromEntries(timeframes.map(timeframe => [timeframe, mapFixture(timeframe)]));
maps['1M'] = {
  ok: true, symbol: 'AAPL', available: false, status: 'INSUFFICIENT_HISTORY', timeframe: '1M',
  availableTimeframes: timeframes, reason: 'At least 30 completed 1 month bars are required.',
};

const gameplan = {
  ok: true, symbol: 'AAPL', generatedAt: '2026-09-19T14:00:00.000Z',
  snapshot: { price: 196.8, prevClose: 195, open: 195.5, high: 198, low: 194.8, volume: 50000000, avgVolume: 45000000, changePct: 0.9 },
  indicators: { rsi14: 57, distVwapPct: 0.4 },
  confidence: { overall: 82, parts: {} }, dataGaps: [],
  levels: { support: [{ price: 194 }], resistance: [{ price: 199 }] },
  displayLevels: { support: [{ price: 194 }], resistance: [{ price: 199 }] },
  smartMoney: maps['1D'],
  provenance: { quote: { provider: 'AAPL fixture', asOf: '2026-09-19T14:00:00.000Z' }, news: [] },
  marketStructureProxy: {
    available: true, symbol: 'AAPL', status: 'AVAILABLE', source: 'AAPL fixture',
    dataQuality: { dailyBars: 60, complete: true, missing: [] },
    current: { price: 196.8, changePct: 0.9, open: 195.5, high: 198, low: 194.8, volume: 50000000, marketState: 'REGULAR' },
    trend: {
      regime: 'BULLISH', structure: 'BULLISH',
      checks: [{ label: 'Price vs 20 SMA', bullish: true }, { label: 'Higher highs / higher lows', bullish: true }],
      reason: 'Fixture trend checks agree.',
    },
    indicators: { sma20: 194, sma50: 191, sma200: 178, vwap: 196, atr: 2.1, atrPct: 1.1, relativeVolume: 1.4 },
    activity: {
      state: 'NORMAL', label: 'Normal participation',
      confirmation: { state: 'CONFIRMED', direction: 'BULLISH', reason: 'Fixture price and volume confirmation.' },
    },
    levels: {
      support: [{ price: 194, label: 'Confirmed swing low', confirmations: 2, type: 'STRUCTURAL SUPPORT', source: 'AAPL fixture' }],
      resistance: [{ price: 199, label: 'Prior-session high', confirmations: 2, type: 'STRUCTURAL RESISTANCE', source: 'AAPL fixture' }],
    },
    conditions: {
      breakout: { state: 'WATCH', trigger: 199, reason: 'Fixture breakout condition.' },
      breakdown: { state: 'WATCH', trigger: 194, reason: 'Fixture breakdown condition.' },
    },
    volumeConcentration: { available: true, low: 195, high: 197, sharePct: 24, method: 'Fixture' },
    gamePlanInput: {
      bias: 'BULLISH', status: 'VERIFIED_INPUTS', reason: 'Fixture verified inputs.',
      bullishCondition: 'Close above $199 with volume.', bearishCondition: 'Close below $194 with volume.',
      invalidation: 'Below $194.', nextLevels: { upside: 199, downside: 194 },
    },
    methodology: 'Fixture OHLCV method.',
    disclaimer: 'Fixture context only; no Level 2 or order-book data.',
  },
  moneyFlow: {
    available: true, symbol: 'AAPL', assetType: 'EQUITY', status: 'PARTIAL',
    source: 'AAPL fixture', generatedAt: '2026-09-19T14:00:00.000Z',
    summary: {
      status: 'INFLOW', score: 68, scoreLabel: 'OHLCV participation proxy score',
      direction: 'UP', reason: 'Fixture participation context.',
    },
    participation: {
      relativeVolume: 1.4, confirmation: 'CONFIRMED', note: 'Volume confirms move',
      source: 'AAPL fixture',
    },
    etfExposure: {
      available: false, reason: 'Fixture has no verified ETF net-flow source.',
      source: 'AAPL fixture',
    },
    etfActivity: [{ symbol: 'SPY', label: 'Broad market', changePct: 0.4, relativeVolume: 1.1 }],
    flowTrend: {
      label: 'Observed participation trend — OHLCV proxy, not ETF net flow',
      source: 'AAPL fixture',
      '5D': { available: true, points: [0, 1, 2, 3, 4].map((index) => ({ t: `2026-09-${15 + index}`, price: 195 + index, priceNormalized: 20 + index * 15, flow: index * 100, flowNormalized: 25 + index * 14 })) },
      '20D': { available: true, points: Array.from({ length: 20 }, (_, index) => ({ t: `2026-08-${String(index + 1).padStart(2, '0')}`, price: 190 + index, priceNormalized: index * 5, flow: index * 100, flowNormalized: index * 5 })) },
    },
    priceFlow: {
      note: 'Fixture signed-volume comparison only.',
      periods: {
        '5D': { available: true, points: [0, 1, 2, 3, 4].map((index) => ({ t: `2026-09-${15 + index}`, price: 195 + index, priceNormalized: 20 + index * 15, flow: index * 100, flowNormalized: 25 + index * 14 })) },
        '20D': { available: true, points: Array.from({ length: 20 }, (_, index) => ({ t: `2026-08-${String(index + 1).padStart(2, '0')}`, price: 190 + index, priceNormalized: index * 5, flow: index * 100, flowNormalized: index * 5 })) },
      },
    },
    positioning: {
      available: true, status: 'AVAILABLE', source: 'AAPL fixture',
      metrics: [
        { label: 'Short interest', value: 1000000, unit: 'shares', direction: 'UP' },
        { label: 'Short interest % float', value: 2.5, unit: '%', direction: 'UP' },
        { label: 'Days to cover', value: 1.2, unit: 'days', direction: 'NEUTRAL' },
        { label: 'Short volume', value: null, unit: '', direction: 'UNAVAILABLE' },
        { label: 'Relative volume', value: 1.4, unit: 'x', direction: 'NEUTRAL' },
      ],
      note: 'Fixture short-interest context.',
    },
    primaryDriver: { label: 'ELEVATED VOLUME', reason: 'Fixture volume context.' },
    dataQuality: { missing: ['ETF net flow exposure'] },
    timestamps: { source: 'AAPL fixture' },
    disclaimer: 'Fixture money-flow context only.',
  },
};

function installMock() {
  const realFetch = window.fetch.bind(window);
  const fixture = __FIXTURE__;
  window.__smartMoneyRequests = [];
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, options);
    if (url === '/api/auth/me') {
      return new Response(JSON.stringify({ id: 75, username: 'smart-money-smoke' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('/api/gameplan/AAPL')) {
      return new Response(JSON.stringify(fixture.gameplan), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('/api/smart-money/AAPL')) {
      const timeframe = new URL(url, location.origin).searchParams.get('timeframe');
      window.__smartMoneyRequests.push(timeframe);
      if (timeframe === '1W') {
        return new Response(JSON.stringify({ ok: false, error: 'Fixture provider unavailable for 1W' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(fixture.maps[timeframe]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('/api/bars/AAPL')) {
      return new Response(JSON.stringify({ bars: fixture.chartBars }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('/api/stock/AAPL') || url.startsWith('/api/valuation/AAPL')) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function main() {
  assert.ok(process.env.REPLIT_DEV_DOMAIN, 'Run against the development workspace, never production.');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-money-ui-test-'));
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
        const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
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
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (await js(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`UI condition timed out: ${expression}`);
    };

    await call('Runtime.enable'); await call('Page.enable');
    const source = `(${installMock.toString().replace('__FIXTURE__', JSON.stringify({ gameplan, maps, chartBars }))})();`;
    await call('Page.addScriptToEvaluateOnNewDocument', { source });
    await call('Page.navigate', { url: `https://${process.env.REPLIT_DEV_DOMAIN}/` });
    await wait(`document.querySelector('#authOverlay')?.classList.contains('auth-hidden') && typeof openStock === 'function'`);
    await js(`openStock('AAPL', ${JSON.stringify(gameplan.snapshot)})`);
    await wait(`document.querySelector('#gpSmartMoneyWrap [data-sm-timeframe="1D"].active')`);
    await wait(`document.querySelector('#moneyFlowModule')`);
    assert.match(await js(`document.querySelector('#moneyFlowModule').textContent`), /MONEY FLOW/);
    assert.match(await js(`document.querySelector('#moneyFlowModule').textContent`), /ETF FLOW EXPOSURE — ESTIMATED/);
    assert.match(await js(`document.querySelector('#moneyFlowModule').textContent`), /DATA UNAVAILABLE/);
    await js(`document.querySelector('#moneyFlowModule [data-moneyflow-period="20D"]').click()`);
    assert.equal(await js(`document.querySelector('#mfmTrendChart').dataset.period`), '20D');
    assert.equal(await js(`document.querySelectorAll('#searchVerdictTop').length`), 1);
    await wait(`document.querySelector('#gpMarketStructureProxy') && document.querySelector('#gpGamePlanStructureInput')`);
    const proxyText = await js(`document.querySelector('#gpMarketStructureProxy').textContent`);
    assert.match(proxyText, /AAPL MARKET STRUCTURE & LIQUIDITY PROXY/);
    assert.match(proxyText, /MARKET STRUCTURE INPUT TO GAME PLAN/);
    assert.doesNotMatch(proxyText, /LIQUIDITY & DIRECTION HEATMAP|Heatmap Input to Game Plan/i);
    const verdict = await js(`document.querySelector('#searchVerdictTop').textContent`);

    for (const timeframe of timeframes) {
      await js(`document.querySelector('#gpSmartMoneyWrap [data-sm-timeframe="${timeframe}"]').click()`);
      if (timeframe === '1W') {
        await wait(`document.querySelector('#smartMoneyMap.unavailable')?.textContent.includes('Fixture provider unavailable for 1W')`);
      } else if (timeframe === '1M') {
        await wait(`document.querySelector('#smartMoneyMap.unavailable')?.textContent.includes('At least 30 completed 1 month bars')`);
      } else {
        await wait(`document.querySelector('#smartMoneyMap:not(.unavailable) [data-sm-timeframe="${timeframe}"].active')`);
        assert.match(await js(`document.querySelector('.sm-card-price small').textContent`), new RegExp(timeframe));
      }
      assert.equal(await js(`document.querySelectorAll('#searchVerdictTop').length`), 1);
      assert.equal(await js(`document.querySelector('#searchVerdictTop').textContent`), verdict);
    }

    await js(`document.querySelector('#gpSmartMoneyWrap [data-sm-timeframe="1D"]').click()`);
    await wait(`document.querySelector('#smartMoneyMap:not(.unavailable) [data-sm-timeframe="1D"].active')`);
    assert.ok(await js(`document.querySelectorAll('.sm-zone-extra').length > 0`));
    await js(`document.querySelector('[data-sm-show-all]').click()`);
    assert.equal(await js(`document.querySelector('#smartMoneyMap').classList.contains('show-all')`), true);
    assert.equal(await js(`document.querySelector('[data-sm-show-all]').textContent`), 'Show primary only');

    await js(`document.querySelector('.stock-tab[data-tab="chart"]').click()`);
    await wait(`document.querySelector('#tab-chart.active #mainCanvas') && document.querySelector('#smChartToggle')`);
    await js(`document.querySelector('#smChartToggle').click(); document.querySelector('#smChartAll').click()`);
    assert.equal(await js(`document.querySelector('#smChartToggle').textContent`), 'Zones off');
    assert.equal(await js(`document.querySelector('#smChartAll').textContent`), 'All zones');
    assert.match(await js(`document.querySelector('#smChartStatus').textContent`), /Smart Money 1D zones/);
    assert.deepEqual(await js(`__smartMoneyRequests`), ['1H', '4H', '1D', '1W', '1M', '1D']);
    assert.deepEqual(exceptions, []);
    console.log('PASS Smart Money browser: authenticated AAPL Search fixture, 1H/4H/1D switching, explicit 1W provider error and 1M insufficient history, one verdict, map show-all, chart overlays, no browser exceptions.');
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