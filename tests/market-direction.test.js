'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  evaluateMarketDirection,
  canUseInverseFallback,
  hasCompleteMomentumQuote,
} = require('../lib/market-direction');
const { createMomentumInverseCycleStore } = require('../lib/momentum-inverse-cycle');

const now = new Date('2026-08-31T15:02:00.000Z');
function bars(symbol, falling) {
  return Array.from({ length: 10 }, (_, index) => {
    const open = 100 - (falling ? index * 0.12 : 0);
    const close = falling ? open - 0.12 : open + 0.03;
    return {
      symbol,
      t: new Date(Date.parse('2026-08-31T14:10:00.000Z') + index * 300000).toISOString(),
      o: open, h: open + 0.05, l: close - 0.05, c: close, v: 1000,
    };
  });
}

const down = evaluateMarketDirection({ SPY: bars('SPY', true), QQQ: bars('QQQ', true) }, now);
assert.strictEqual(down.dropping, true);
assert.strictEqual(down.inverseMode, true);
assert.ok(['SH', 'QID'].includes(down.inverseSymbol));

const mixed = evaluateMarketDirection({ SPY: bars('SPY', true), QQQ: bars('QQQ', false) }, now);
assert.strictEqual(mixed.dropping, false);
assert.strictEqual(mixed.inverseSymbol, null);

const stale = evaluateMarketDirection({ SPY: [], QQQ: [] }, now);
assert.strictEqual(stale.direction, 'UNAVAILABLE');
assert.strictEqual(stale.dropping, false);

const missingLatest = evaluateMarketDirection(
  { SPY: bars('SPY', true), QQQ: bars('QQQ', true) },
  new Date('2026-08-31T15:03:00.000Z')
);
assert.strictEqual(missingLatest.direction, 'UNAVAILABLE');
assert.strictEqual(missingLatest.dropping, false);

assert.strictEqual(canUseInverseFallback({
  scannedSymbols: 80,
  completedQuotes: 79,
  quoteFailures: 1,
  shortlisted: 0,
  completedCandidates: 0,
  candidateFailures: 0,
  eligibleLongs: 0,
}).allowed, false);

assert.strictEqual(canUseInverseFallback({
  scannedSymbols: 80,
  completedQuotes: 80,
  quoteFailures: 0,
  shortlisted: 4,
  completedCandidates: 3,
  candidateFailures: 1,
  eligibleLongs: 0,
}).allowed, false);

assert.strictEqual(canUseInverseFallback({
  scannedSymbols: 80,
  completedQuotes: 80,
  quoteFailures: 0,
  shortlisted: 4,
  completedCandidates: 4,
  candidateFailures: 0,
  eligibleLongs: 0,
}).allowed, true);

assert.strictEqual(hasCompleteMomentumQuote({
  regularMarketPrice: 25,
  regularMarketChangePercent: -1,
  regularMarketVolume: 100000,
  averageDailyVolume3Month: 50000,
}), true);
assert.strictEqual(hasCompleteMomentumQuote({ regularMarketPrice: 25 }), false);
assert.strictEqual(hasCompleteMomentumQuote({
  regularMarketPrice: 25,
  regularMarketChangePercent: null,
  regularMarketVolume: 100000,
  averageDailyVolume3Month: 50000,
}), false);
assert.strictEqual(hasCompleteMomentumQuote({
  regularMarketPrice: 25,
  regularMarketChangePercent: '',
  regularMarketVolume: 100000,
  averageDailyVolume3Month: 50000,
}), false);
assert.strictEqual(hasCompleteMomentumQuote({
  regularMarketPrice: Infinity,
  regularMarketChangePercent: -1,
  regularMarketVolume: 100000,
  averageDailyVolume3Month: 50000,
}), false);
assert.strictEqual(hasCompleteMomentumQuote({
  regularMarketPrice: 25,
  regularMarketChangePercent: -1,
  regularMarketVolume: Infinity,
  averageDailyVolume3Month: 50000,
}), false);

const db = new Database(':memory:');
db.exec(`CREATE TABLE momentum_settings (
  user_id INTEGER PRIMARY KEY,
  last_inverse_at TEXT,
  last_inverse_status TEXT,
  last_inverse_reason TEXT,
  last_inverse_symbol TEXT
)`);
db.prepare('INSERT INTO momentum_settings (user_id) VALUES (?)').run(7);
const inverseCycleStore = createMomentumInverseCycleStore(db);
inverseCycleStore.update(7, 'withheld', 'Inverse fallback blocked: ordinary-long quote coverage was incomplete.', null);
const withheld = inverseCycleStore.get(7);
assert.strictEqual(withheld.status, 'withheld');
assert.match(withheld.reason, /quote coverage was incomplete/);
assert.strictEqual(withheld.symbol, null);
assert.ok(withheld.at);
db.close();

console.log('market direction tests passed');