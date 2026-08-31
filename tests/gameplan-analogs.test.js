'use strict';

const assert = require('assert');
const {
  buildIntradayAnalogs,
  marketParts,
  selectCurrentRegularSnapshot,
} = require('../lib/gameplan-analogs');

const unix = iso => Date.parse(iso) / 1000;
const daily = [
  { t: '2026-08-03', o: 100, h: 101, l: 99, c: 100 },
  { t: '2026-08-04', o: 96, h: 98, l: 90, c: 96 },
  { t: '2026-08-05', o: 97, h: 101, l: 96, c: 100 },
  { t: '2026-08-06', o: 100, h: 101, l: 99, c: 100 },
];
const intraday = [
  { t: unix('2026-08-04T14:25:00Z'), c: 96, h: 96, l: 95 },
  { t: unix('2026-08-04T14:30:00Z'), c: 92, h: 93, l: 91 },
  { t: unix('2026-08-04T14:35:00Z'), c: 93, h: 94, l: 90 },
  { t: unix('2026-08-04T19:55:00Z'), c: 96, h: 98, l: 95 },
];

const result = buildIntradayAnalogs({
  daily,
  intraday,
  thresholdPct: 5,
  currentDropPct: 8,
  currentBar: { t: unix('2026-08-31T14:30:00Z'), c: 90 },
});

assert.ok(result);
assert.equal(result.sampleSize, 1);
assert.equal(result.lowConfidence, true);
assert.equal(result.comparableTime, '10:30 ET');
assert.equal(result.bounced3Pct, 100);
assert.equal(result.methodology, 'intraday-time-matched');
assert.equal(result.minDropPct, 6.4);
assert.equal(result.maxDropPct, 9.6);

const noMatch = buildIntradayAnalogs({
  daily,
  intraday: [{ t: unix('2026-08-04T18:00:00Z'), c: 90, h: 91, l: 89 }],
  thresholdPct: 5,
  currentDropPct: 8,
  currentBar: { t: unix('2026-08-31T14:30:00Z'), c: 90 },
});
assert.equal(noMatch, null);

const wrongMagnitude = buildIntradayAnalogs({
  daily,
  intraday: intraday.map(bar => ({ ...bar, c: 70, h: 71, l: 69 })),
  thresholdPct: 5,
  currentDropPct: 8,
  currentBar: { t: unix('2026-08-31T14:30:00Z'), c: 90 },
});
assert.equal(wrongMagnitude, null);

const postMarket = buildIntradayAnalogs({
  daily,
  intraday,
  thresholdPct: 5,
  currentDropPct: 8,
  currentBar: { t: unix('2026-08-31T20:30:00Z'), c: 90 },
});
assert.equal(postMarket, null);

assert.deepEqual(marketParts(unix('2026-01-05T15:30:00Z')), {
  date: '2026-01-05',
  minuteOfDay: 630,
});

const regularSnapshot = selectCurrentRegularSnapshot([
  { t: unix('2026-08-31T14:30:00Z'), c: 92, session: 'reg' },
], 100, { marketState: 'REGULAR', nowMs: Date.parse('2026-08-31T14:35:00Z') });
assert.equal(regularSnapshot.dropMagnitudePct, 8);

assert.equal(selectCurrentRegularSnapshot([
  { t: unix('2026-08-28T19:55:00Z'), c: 92, session: 'reg' },
  { t: unix('2026-08-31T12:00:00Z'), c: 88, session: 'pre' },
], 100, { marketState: 'PRE', nowMs: Date.parse('2026-08-31T12:05:00Z') }), null);

assert.equal(selectCurrentRegularSnapshot([
  { t: unix('2026-08-31T19:55:00Z'), c: 92, session: 'reg' },
  { t: unix('2026-08-31T20:30:00Z'), c: 88, session: 'post' },
], 100, { marketState: 'POST', nowMs: Date.parse('2026-08-31T20:35:00Z') }), null);

assert.equal(selectCurrentRegularSnapshot([
  { t: unix('2026-08-28T19:55:00Z'), c: 92, session: 'reg' },
], 100, { marketState: 'CLOSED', nowMs: Date.parse('2026-08-30T15:00:00Z') }), null);

assert.equal(selectCurrentRegularSnapshot([
  { t: unix('2026-08-31T19:55:00Z'), c: 92, session: 'reg' },
], 100, { marketState: 'POST', nowMs: Date.parse('2026-08-31T20:30:00Z') }), null);

console.log('Game-plan intraday analog tests passed');