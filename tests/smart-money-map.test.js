'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateBars,
  aggregateCalendarBars,
  aggregateRegularSessionHours,
  buildSmartMoneyMap,
  normalizeBars,
} = require('../lib/smart-money-map');

function syntheticBars({
  count = 80,
  start = 100,
  intervalMs = 60 * 60 * 1000,
  nowMs = Date.UTC(2026, 7, 31, 20),
  volume = true,
} = {}) {
  const bars = [];
  let price = start;
  for (let index = 0; index < count; index += 1) {
    let open = price;
    let close = open + (index % 9 === 0 ? -0.35 : 0.16);
    if (index === 34) {
      open = price;
      close = open + 0.04;
    }
    if (index === 35) {
      open = price + 0.05;
      close = open + 2.2;
    }
    const high = Math.max(open, close) + 0.22;
    const low = Math.min(open, close) - 0.22;
    bars.push({
      t: nowMs - (count - index + 2) * intervalMs,
      o: open,
      h: high,
      l: low,
      c: close,
      v: volume ? (index === 35 ? 4000 : 1000 + index * 4) : null,
    });
    price = close;
  }
  return bars;
}

test('builds deterministic zones only from completed OHLCV bars', () => {
  const nowMs = Date.UTC(2026, 7, 31, 20);
  const bars = syntheticBars({ nowMs });
  const result = buildSmartMoneyMap({
    bars,
    timeframe: '1H',
    currentPrice: bars.at(-1).c,
    nowMs,
  });
  assert.equal(result.available, true);
  assert.equal(result.timeframe, '1H');
  assert.ok(result.zones.length > 0);
  assert.ok(result.zones.every(zone => zone.low <= zone.high));
  assert.ok(result.zones.every(zone => zone.score >= 52 && zone.score <= 100));
  assert.ok(result.zones.every(zone => zone.type === 'DEMAND'
    ? zone.invalidation.reference < zone.low
    : zone.invalidation.reference > zone.high));
  for (const nearest of Object.values(result.nearest)) {
    if (nearest) assert.equal(result.zones.find(zone => zone.id === nearest.id)?.score, nearest.score);
  }
  assert.match(result.disclaimer, /does not show actual institutional orders/i);
  assert.ok(result.chartBars.every(bar => Number(bar.t) + 60 * 60 * 1000 <= nowMs));
});

test('does not invent volume when a provider omits it', () => {
  const nowMs = Date.UTC(2026, 7, 31, 20);
  const bars = syntheticBars({ nowMs, volume: false });
  const result = buildSmartMoneyMap({
    bars,
    timeframe: '1H',
    currentPrice: bars.at(-1).c,
    nowMs,
  });
  assert.equal(result.available, true);
  assert.equal(result.dataQuality.volumeAvailable, false);
  assert.equal(result.indicators.vwap, null);
  assert.ok(result.zones.every(zone => zone.evidence.relativeVolume === null));
});

test('withholds the map when completed history is insufficient', () => {
  const nowMs = Date.UTC(2026, 7, 31, 20);
  const result = buildSmartMoneyMap({
    bars: syntheticBars({ count: 10, nowMs, intervalMs: 24 * 60 * 60 * 1000 }),
    timeframe: '1D',
    nowMs,
  });
  assert.equal(result.available, false);
  assert.equal(result.dataQuality.history, 'INSUFFICIENT');
  assert.match(result.reason, /At least 30 completed 1 day bars/);
});

test('drops a still-forming bar and aggregates real input values', () => {
  const nowMs = Date.UTC(2026, 7, 31, 20);
  const bars = syntheticBars({ count: 8, nowMs });
  bars.push({ ...bars.at(-1), t: nowMs - 10 * 60 * 1000, c: 999 });
  const completed = normalizeBars(bars, { timeframe: '1H', nowMs });
  assert.notEqual(completed.at(-1).c, 999);
  const aggregated = aggregateBars(bars.slice(0, 4), 4);
  assert.equal(aggregated[0].o, bars[0].o);
  assert.equal(aggregated[0].c, bars[3].c);
  assert.equal(aggregated[0].h, Math.max(...bars.slice(0, 4).map(bar => bar.h)));
  assert.equal(aggregated[0].v, bars.slice(0, 4).reduce((sum, bar) => sum + bar.v, 0));
});

test('builds one true four-hour bar per regular session and rejects the partial remainder', () => {
  const start = Date.UTC(2026, 7, 28, 13, 30);
  const bars = Array.from({ length: 7 }, (_, index) => ({
    t: start + index * 60 * 60 * 1000,
    o: 100 + index,
    h: 101 + index,
    l: 99 + index,
    c: 100.5 + index,
    v: 1000,
    session: 'reg',
  }));
  const result = aggregateRegularSessionHours(bars);
  assert.equal(result.length, 1);
  assert.equal(result[0].o, bars[0].o);
  assert.equal(result[0].c, bars[3].c);
  assert.equal(result[0].completeAt, bars[3].t + 60 * 60 * 1000);
});

test('withholds a still-forming calendar month until the next month boundary', () => {
  const daily = [
    { t: '2026-07-01', o: 100, h: 102, l: 99, c: 101, v: 1000 },
    { t: '2026-07-31', o: 101, h: 103, l: 100, c: 102, v: 1000 },
    { t: '2026-08-03', o: 102, h: 104, l: 101, c: 103, v: 1000 },
    { t: '2026-08-31', o: 103, h: 105, l: 102, c: 104, v: 1000 },
  ];
  const monthly = aggregateCalendarBars(daily, '1M');
  const beforeBoundary = normalizeBars(monthly, {
    timeframe: '1M',
    nowMs: Date.UTC(2026, 7, 31, 23, 59),
  });
  const afterBoundary = normalizeBars(monthly, {
    timeframe: '1M',
    nowMs: Date.UTC(2026, 8, 1, 0, 1),
  });
  assert.equal(beforeBoundary.length, 1);
  assert.equal(afterBoundary.length, 2);
});

test('invalidated zones cannot boost multi-timeframe confluence', () => {
  const nowMs = Date.UTC(2026, 7, 31, 20);
  const bars = syntheticBars({ nowMs });
  const baseline = buildSmartMoneyMap({ bars, timeframe: '1H', nowMs });
  const target = baseline.zones[0];
  assert.ok(target);
  const invalidated = buildSmartMoneyMap({
    bars,
    timeframe: '1H',
    nowMs,
    confluenceTimeframes: [{ ...target, timeframe: '1D', status: 'INVALIDATED' }],
  });
  const valid = buildSmartMoneyMap({
    bars,
    timeframe: '1H',
    nowMs,
    confluenceTimeframes: [{ ...target, timeframe: '1D', status: 'FRESH' }],
  });
  assert.equal(invalidated.zones.find(zone => zone.id === target.id).score, target.score);
  assert.ok(valid.zones.find(zone => zone.id === target.id).score > target.score);
});