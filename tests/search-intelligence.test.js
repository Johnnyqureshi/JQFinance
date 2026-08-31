'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMacroPressure,
  classifySearchQuery,
  detectPredictionPriceDivergence,
  normalizeKalshiMarket,
  selectRelevantKalshiMarkets,
} = require('../lib/search-intelligence');

test('classifies macro, asset, and mixed natural-language searches', () => {
  assert.equal(classifySearchQuery('Fed rates').type, 'MACRO');
  assert.equal(classifySearchQuery('NVDA').symbol, 'NVDA');
  assert.equal(classifySearchQuery('Is the Fed bullish for NVDA?').type, 'ASSET_MACRO');
  assert.equal(classifySearchQuery('Is the Fed bullish for NVDA?').symbol, 'NVDA');
});

test('normalizes only actual Kalshi price fields', () => {
  const market = normalizeKalshiMarket({
    ticker: 'KXFED-TEST',
    title: 'Will the Fed cut rates?',
    yes_bid_dollars: '0.61',
    yes_ask_dollars: '0.65',
    previous_price_dollars: '0.55',
    volume_fp: '1200',
    status: 'active',
  });
  assert.equal(market.yesProbability, 63);
  assert.equal(market.noProbability, 37);
  assert.equal(market.probabilityChange, 8);
  assert.equal(market.source, 'Kalshi');
});

test('does not force unrelated prediction markets into results', () => {
  const markets = [
    { ticker: 'KXFED', title: 'Will the Federal Reserve cut interest rates?', last_price_dollars: '0.60' },
    { ticker: 'KXBASEBALL', title: 'Will San Francisco win tonight?', last_price_dollars: '0.52' },
  ];
  const result = selectRelevantKalshiMarkets(markets, 'Fed rates');
  assert.deepEqual(result.map(market => market.ticker), ['KXFED']);
});

test('macro pressure uses only supplied live indicators', () => {
  const pressure = buildMacroPressure({
    tenYear: { changePct: 0.8 },
    vix: { changePct: 3 },
    oil: { changePct: -1.5 },
    spy: { changePct: 0.5 },
    qqq: { changePct: 0.7 },
  }, { symbol: 'NVDA', sector: 'Technology' });
  assert.equal(pressure.find(item => item.key === 'rates').state, 'BEARISH');
  assert.equal(pressure.find(item => item.key === 'risk').state, 'BEARISH');
  assert.equal(pressure.find(item => item.key === 'market').state, 'BULLISH');
});

test('reports divergence only from measured probability and price changes', () => {
  const divergence = detectPredictionPriceDivergence([{
    ticker: 'KXFEDHIKE',
    title: 'Will the Fed hike rates?',
    yesLabel: 'Yes',
    probabilityChange: 15,
  }], 1.2);
  assert.equal(divergence.detected, true);
  assert.equal(detectPredictionPriceDivergence([], 1.2), null);
});