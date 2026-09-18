/* Deterministic DOM-lite coverage for scanner liquidity visibility. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element(id, active = false) {
  return {
    id, innerHTML: '', textContent: '', hidden: false, disabled: false, style: {},
    tagName: 'DIV', value: '', selectedIndex: 0,
    classList: { contains: value => active && value === 'active', remove() {}, add() {}, toggle() {} },
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
  };
}

async function boot() {
  const ids = [
    'page-scanner', 'nscBody', 'nscCount', 'nscLoading', 'nscStatus', 'nscCountdown',
    'nscLiquidityPolicy', 'nscRejectedSection', 'nscRejectedSummary', 'nscRejectedList',
    'bciGrid', 'bciMeta', 'bciState', 'bciRefresh', 'bciLiquidityRejected',
    'bciLiquidityRejectedList',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, element(id, id === 'page-scanner')]));
  const scannerPayload = {
    results: [{
      sym: '<ELIG>', name: '<Eligible & Co>', price: 10, change: 2, volume: 200000,
      liquidity: { eligible: true, shareVolume: 200000, dollarVolume: 2000000, spreadPct: null },
    }],
    rejected: [{
      sym: '<BAD>', liquidity: {
        eligible: false, shareVolume: 500, dollarVolume: 5000, spreadPct: 4.25,
        reasons: ['Volume < required', '<unsafe reason>'],
      },
    }],
    liquidityPolicy: { minDollarVolume: 1000000, minShareVolume: 100000, maxSpreadPct: 1 },
  };
  const catalystPayload = {
    events: [],
    liquidityRejected: [{ symbol: '<CAT>', liquidity: { reasons: ['Spread > 1%', '<unsafe catalyst>'] } }],
  };
  const fetch = async url => ({
    ok: true, status: 200,
    json: async () => String(url).includes('catalyst-intel') ? catalystPayload : scannerPayload,
  });
  const document = {
    readyState: 'complete', visibilityState: 'visible',
    getElementById: id => elements[id] || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { location: { origin: 'https://app.test' }, openStock() {} };
  window.window = window;
  vm.runInNewContext(fs.readFileSync('public/js/scanner.js', 'utf8'), {
    window, document, fetch, URL, Date, console,
    setInterval: () => 1, clearInterval() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  return elements;
}

(async () => {
  const el = await boot();
  assert.match(el.nscLiquidityPolicy.textContent, /100K shares\/session/);
  assert.match(el.nscLiquidityPolicy.textContent, /\$1,000,000\.00 estimated dollar volume\/session/);
  assert.match(el.nscLiquidityPolicy.textContent, /≤ 1% spread/);

  assert.equal(el.nscRejectedSection.hidden, false);
  assert.match(el.nscRejectedSummary.textContent, /1 candidate excluded/);
  assert.match(el.nscRejectedList.innerHTML, /&lt;BAD&gt;/);
  assert.match(el.nscRejectedList.innerHTML, /&lt;unsafe reason&gt;/);
  assert.doesNotMatch(el.nscRejectedList.innerHTML, /<BAD>|<unsafe reason>/);

  assert.match(el.nscBody.innerHTML, /Est\. \$ vol \$2,000,000\.00/);
  assert.match(el.nscBody.innerHTML, /Spread unavailable/);
  assert.match(el.nscBody.innerHTML, /&lt;ELIG&gt;/);
  assert.doesNotMatch(el.nscBody.innerHTML, /<ELIG>|<Eligible/);

  assert.equal(el.bciLiquidityRejected.hidden, false);
  assert.match(el.bciLiquidityRejectedList.innerHTML, /&lt;CAT&gt;/);
  assert.match(el.bciLiquidityRejectedList.innerHTML, /&lt;unsafe catalyst&gt;/);
  assert.doesNotMatch(el.bciLiquidityRejectedList.innerHTML, /<CAT>|<unsafe catalyst>/);
  console.log('liquidity-scanner-ui tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });