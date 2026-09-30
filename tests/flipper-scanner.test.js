'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchUniverse, fetchQuotes, filterLiquid, rankUniverse, DEFAULT_SCAN_RULES,
} = require('../lib/flipper/scanner');

function quotesFor(entries) {
  const q = {};
  for (const [sym, e] of Object.entries(entries)) q[sym] = e;
  return q;
}
const Q = (bid, ask) => ({ bid, ask, price: (bid + ask) / 2 });
const stats = (adv, dayVolume, isEtf = false) => ({ adv, dayVolume, isEtf });

test('DEFAULT_SCAN_RULES match the pinned architecture values', () => {
  assert.equal(DEFAULT_SCAN_RULES.minPrice, 1);
  assert.equal(DEFAULT_SCAN_RULES.maxPrice, 20);
  assert.equal(DEFAULT_SCAN_RULES.minAvgDailyVolume, 500000);
  assert.equal(DEFAULT_SCAN_RULES.minDayVolume, 50000);
  assert.equal(DEFAULT_SCAN_RULES.maxSpreadPct, 0.5);
  assert.equal(DEFAULT_SCAN_RULES.includeETFs, true);
  assert.equal(DEFAULT_SCAN_RULES.scanBudget, 100);
});

test('filterLiquid passes a fully liquid symbol', () => {
  const r = filterLiquid({
    symbols: ['AAA'],
    quotes: quotesFor({ AAA: Q(9.99, 10.01) }),
    dailyStats: { AAA: stats(600000, 80000) },
  });
  assert.deepEqual(r.passed, ['AAA']);
  assert.equal(r.rejectedCount, 0);
  assert.deepEqual(r.rejectionCounts, {});
});

test('filterLiquid enforces the price band, boundaries inclusive', () => {
  const r = filterLiquid({
    symbols: ['LOW', 'MIN', 'MAX', 'HIGH'],
    quotes: quotesFor({ LOW: Q(0.99, 0.992), MIN: Q(1.0, 1.004), MAX: Q(19.97, 20.0), HIGH: Q(20.02, 20.05) }),
    dailyStats: {
      LOW: stats(1e6, 1e5), MIN: stats(1e6, 1e5), MAX: stats(1e6, 1e5), HIGH: stats(1e6, 1e5),
    },
  });
  assert.deepEqual(r.passed.sort(), ['MAX', 'MIN']);
  assert.equal(r.rejectionCounts.price_band, 2);
});

test('filterLiquid enforces ADV and day-volume minimums, boundaries inclusive', () => {
  const r = filterLiquid({
    symbols: ['A', 'B', 'C', 'D'],
    quotes: quotesFor({ A: Q(5, 5.01), B: Q(5, 5.01), C: Q(5, 5.01), D: Q(5, 5.01) }),
    dailyStats: {
      A: stats(499999, 60000),
      B: stats(500000, 49999),
      C: stats(500000, 50000),
      D: stats(1000000, 200000),
    },
  });
  assert.deepEqual(r.passed.sort(), ['C', 'D']);
  assert.equal(r.rejectionCounts.adv, 1);
  assert.equal(r.rejectionCounts.day_volume, 1);
});

test('filterLiquid enforces maxSpreadPct and skips the check with no two-sided quote', () => {
  const r = filterLiquid({
    symbols: ['WIDE', 'EDGE', 'NOQUOTE', 'HALF', 'PRICEONLY'],
    quotes: {
      WIDE: Q(10.0, 10.08), // 0.796% > 0.5
      EDGE: { bid: 10.0, ask: 10.05, price: 10.025 }, // 0.4988% <= 0.5
      HALF: { bid: 10.0, ask: null, price: null }, // one-sided: no price
      PRICEONLY: { bid: null, ask: null, price: 10.05 }, // price, no quote: spread check skipped
    },
    dailyStats: {
      WIDE: stats(1e6, 1e5), EDGE: stats(1e6, 1e5), NOQUOTE: stats(1e6, 1e5),
      HALF: stats(1e6, 1e5), PRICEONLY: stats(1e6, 1e5),
    },
  });
  assert.deepEqual(r.passed.sort(), ['EDGE', 'PRICEONLY']);
  assert.equal(r.rejectionCounts.spread, 1);
  assert.equal(r.rejectionCounts.no_price, 2); // NOQUOTE, HALF
});

test('filterLiquid honors includeETFs=false and rejects symbols with no price', () => {
  const r = filterLiquid({
    symbols: ['ETF', 'STOCK', 'NOPRICE'],
    quotes: quotesFor({ ETF: Q(5, 5.01), STOCK: Q(5, 5.01) }),
    dailyStats: { ETF: stats(1e6, 1e5, true), STOCK: stats(1e6, 1e5), NOPRICE: stats(1e6, 1e5) },
    rules: { includeETFs: false },
  });
  assert.deepEqual(r.passed, ['STOCK']);
  assert.equal(r.rejectionCounts.etf_excluded, 1);
  assert.equal(r.rejectionCounts.no_price, 1);

  // Default: ETFs pass.
  const r2 = filterLiquid({
    symbols: ['ETF'],
    quotes: quotesFor({ ETF: Q(5, 5.01) }),
    dailyStats: { ETF: stats(1e6, 1e5, true) },
  });
  assert.deepEqual(r2.passed, ['ETF']);
});

test('filterLiquid returns aggregate-safe data only (no per-symbol rejection list)', () => {
  const r = filterLiquid({
    symbols: ['A', 'B'],
    quotes: quotesFor({ A: Q(5, 5.01), B: Q(50, 50.01) }),
    dailyStats: { A: stats(1e6, 1e5), B: stats(1e6, 1e5) },
  });
  assert.ok(!('rejected' in r) || !Array.isArray(r.rejected), 'no symbol-level rejection list');
  assert.equal(r.total, 2);
  assert.equal(r.passedCount, 1);
  assert.equal(r.rejectedCount, 1);
  assert.equal(r.rejectionCounts.price_band, 1);
});

test('rankUniverse caps at scanBudget and sorts by day volume desc', () => {
  const ranked = rankUniverse({
    symbols: ['A', 'B', 'C', 'D'],
    dayVolumes: { A: 100, B: 500, C: 300, D: 200 },
    rules: { scanBudget: 3 },
  });
  assert.deepEqual(ranked, ['B', 'C', 'D']);
});

test('rankUniverse treats missing volumes as zero and breaks ties deterministically', () => {
  const ranked = rankUniverse({
    symbols: ['B', 'A', 'C'],
    dayVolumes: { A: 100 },
  });
  assert.deepEqual(ranked, ['A', 'B', 'C']); // B, C tie at 0, alphabetical
});

test('fetchUniverse filters through broker-universe catalog rules', async () => {
  const calls = [];
  const stubFetch = async path => {
    calls.push(path);
    return {
      ok: true,
      status: 200,
      json: async () => [
        { symbol: 'AAA', name: 'A Corp', status: 'active', tradable: true, class: 'us_equity', fractionable: true },
        { symbol: 'BBB', name: 'B Corp', status: 'active', tradable: true, class: 'us_equity', fractionable: false }, // dropped: not fractionable
        { symbol: 'CCC', name: 'C Corp', status: 'inactive', tradable: true, class: 'us_equity', fractionable: true }, // dropped: inactive
        { symbol: 'DDD', name: 'D Corp', status: 'active', tradable: false, class: 'us_equity', fractionable: true }, // dropped: not tradable
        { symbol: 'BTC/USD', name: 'Bitcoin', status: 'active', tradable: true, class: 'crypto', fractionable: true }, // dropped: not us_equity
      ],
    };
  };
  const universe = await fetchUniverse({ fetch: stubFetch });
  assert.ok(calls[0].startsWith('/v2/assets'), 'hits the assets path');
  assert.deepEqual(universe, [{ symbol: 'AAA', name: 'A Corp', assetClass: 'us_equity' }]);
});

test('fetchUniverse throws on broker failure', async () => {
  await assert.rejects(
    () => fetchUniverse({ fetch: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/
  );
  await assert.rejects(() => fetchUniverse({}), /fetch is required/);
});

test('fetchQuotes batches symbols and shapes bid/ask/midpoint', async () => {
  const calls = [];
  const stubFetch = async path => {
    calls.push(path);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        quotes: {
          AAA: { ap: 10.02, bp: 10.0, t: '2026-09-29T13:30:00Z' },
          BBB: { ap: 5.05, bp: null, t: '2026-09-29T13:30:00Z' },
        },
      }),
    };
  };
  const out = await fetchQuotes({ fetch: stubFetch, symbols: ['AAA', 'BBB', 'CCC'] });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('symbols=AAA,BBB,CCC'), 'batches symbols into one request');
  assert.deepEqual(out.AAA, { bid: 10.0, ask: 10.02, price: 10.01, t: '2026-09-29T13:30:00Z' });
  assert.equal(out.BBB.price, null, 'no midpoint without two-sided quote');
  assert.ok(!('CCC' in out), 'missing quote entries omitted');
});

test('fetchQuotes chunks large symbol lists', async () => {
  let calls = 0;
  const stubFetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ quotes: {} }) };
  };
  const symbols = Array.from({ length: 450 }, (_, i) => `S${i}`);
  await fetchQuotes({ fetch: stubFetch, symbols }, { chunkSize: 200 });
  assert.equal(calls, 3);
});
