'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/gameplan.js'), 'utf8');

function plan(snapshotPrice = 100) {
  return {
    ok: true,
    symbol: 'NVDA',
    generatedAt: '2026-09-18T14:00:00.000Z',
    snapshot: { price: snapshotPrice, high: 103, low: 97, changePct: 0, relVol: 1 },
    indicators: {},
    confidence: { overall: 100, parts: {} },
    dataGaps: [],
    levels: { breakdown: 99.5 },
    displayLevels: {
      bias: { price: 100.5 },
      support: [{ price: 99 }],
      resistance: [{ price: 101 }],
    },
    confluence: {
      levels: { criticalSupport: 98.5, criticalResistance: 101.5 },
    },
    provenance: {},
  };
}

function createHarness() {
  const content = {
    style: {},
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const elements = new Map([['gpContent', content]]);
  const forceRequests = [];
  let pendingForce = null;

  const context = {
    console,
    document: {
      visibilityState: 'visible',
      getElementById: id => elements.get(id) || null,
      addEventListener: () => {},
    },
    window: {
      searchContext: {
        load(symbol, options = {}) {
          if (!options.force) throw new Error(`Unexpected ordinary request for ${symbol}`);
          forceRequests.push({ symbol, options });
          pendingForce = {};
          pendingForce.promise = new Promise(resolve => { pendingForce.resolve = resolve; });
          return pendingForce.promise;
        },
      },
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.window.document = context.document;
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__gamePlan = gamePlan;`, context, { filename: 'gameplan.js' });

  return {
    gamePlan: context.__gamePlan,
    forceRequests,
    render: async payload => {
      context.__gamePlan.load('NVDA', Promise.resolve(payload));
      await new Promise(resolve => setImmediate(resolve));
    },
    resolveForcedRefresh: async payload => {
      assert.ok(pendingForce, 'Expected a forced refresh to be pending');
      pendingForce.resolve(payload);
      pendingForce = null;
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

async function main() {
  const harness = createHarness();
  const { gamePlan, forceRequests } = harness;

  await harness.render(plan());
  gamePlan.onQuote('NVDA', 100.49);
  assert.equal(forceRequests.length, 0, 'Quiet movement must not force a refresh');

  gamePlan.onQuote('NVDA', 101.5);
  assert.equal(forceRequests.length, 1, 'A 1.5% move must force a refresh');
  gamePlan.onQuote('NVDA', 103);
  gamePlan.onQuote('NVDA', 98);
  assert.equal(forceRequests.length, 1, 'A rendered plan may force at most one early refresh');

  await harness.resolveForcedRefresh(plan(101.5));
  gamePlan.onQuote('NVDA', 103.1);
  assert.equal(forceRequests.length, 2, 'Rendering the refreshed plan must reset the one-shot watch');

  for (const [label, price] of [
    ['support', 98.9],
    ['resistance', 101.1],
    ['breakdown', 99.4],
  ]) {
    await harness.render(plan());
    const before = forceRequests.length;
    gamePlan.onQuote('NVDA', price);
    assert.equal(forceRequests.length, before + 1, `${label} crossing must force a refresh`);
  }

  await harness.render(plan());
  const beforeIgnored = forceRequests.length;
  for (const [symbol, price] of [
    ['AMD', 102],
    ['NVDA', 0],
    ['NVDA', -1],
    ['NVDA', Number.NaN],
    ['NVDA', Number.POSITIVE_INFINITY],
    ['NVDA', 'not-a-price'],
  ]) gamePlan.onQuote(symbol, price);
  assert.equal(forceRequests.length, beforeIgnored, 'Other symbols and invalid prices must be ignored');

  console.log('PASS game-plan stale refresh: quiet quotes, 1.5% moves, decision-level crossings, one-shot reset, and invalid quote isolation.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});