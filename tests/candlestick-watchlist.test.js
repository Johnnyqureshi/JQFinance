'use strict';

const assert = require('assert');
const {
  CANDLESTICK_WATCHLIST,
  ULTRABOT_SCREENSHOT_SYMBOLS,
  nextCandlestickWatchlistBatch,
} = require('../lib/candlestick-watchlist');

const uniqueScreenshots = [...new Set(ULTRABOT_SCREENSHOT_SYMBOLS)];
assert.strictEqual(uniqueScreenshots.length, ULTRABOT_SCREENSHOT_SYMBOLS.length);
assert(uniqueScreenshots.every(symbol => CANDLESTICK_WATCHLIST.includes(symbol)));
assert(CANDLESTICK_WATCHLIST.length > uniqueScreenshots.length);

const state = new Map();
const seen = new Set();
const batches = [];
for (let i = 0; i < Math.ceil(CANDLESTICK_WATCHLIST.length / 16); i++) {
  const batch = nextCandlestickWatchlistBatch(CANDLESTICK_WATCHLIST, state, 'user-1', 16);
  batches.push(batch);
  batch.symbols.forEach(symbol => {
    assert(!seen.has(symbol), `symbol repeated before a full rotation: ${symbol}`);
    seen.add(symbol);
  });
}
assert.deepStrictEqual([...seen].sort(), [...new Set(CANDLESTICK_WATCHLIST)].sort());
assert.strictEqual(batches[0].totalBatches, Math.ceil(CANDLESTICK_WATCHLIST.length / 16));

const explicit = nextCandlestickWatchlistBatch(CANDLESTICK_WATCHLIST, new Map(), 'user-2', 30);
assert.strictEqual(explicit.symbols.length, 30);
assert.strictEqual(explicit.batch, 1);

console.log(`UltraBot3 watchlist coverage passed (${seen.size} unique symbols across ${batches.length} batches)`);