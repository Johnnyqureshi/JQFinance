'use strict';

const assert = require('node:assert/strict');
const { evaluateB2, rankB2Candidates, buildB2Entry, B2_RULES } = require('../lib/b2-strategy');
const now = Date.parse('2026-09-18T15:00:00Z');
const dates = [];
for (const d = new Date('2026-09-17T12:00:00Z'); dates.length < 80; d.setUTCDate(d.getUTCDate() - 1)) {
  if (![0, 6].includes(d.getUTCDay())) dates.unshift(d.toISOString().slice(0, 10));
}
function fixture() {
  const bars = dates.map((date, i) => {
    const c = i < 45 ? 10 : i < 65 ? 8 : 8 + 2.67 * (i - 65) / 14;
    return { t: `${date}T04:00:00Z`, o: c * .99, h: c * 1.01, l: c * .98, c, v: 300000 };
  });
  const price = bars.at(-1).c * 1.11;
  return {
    bars, now, expectedSessionDate: '2026-09-17',
    asset: { symbol: 'TEST', tradable: true, status: 'active', class: 'us_equity' },
    snapshot: {
      latestTrade: { p: price, t: new Date(now).toISOString() },
      latestQuote: { bp: price - .01, ap: price + .01, bs: 10, as: 10, t: new Date(now).toISOString() },
      dailyBar: { t: '2026-09-18T04:00:00Z', v: 900000 },
      prevDailyBar: { t: '2026-09-17T04:00:00Z', c: bars.at(-1).c },
    },
  };
}
function withCalendar(f = fixture()) {
  f.completedSessionDates = [...dates];
  return f;
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

test('new daily crossover with all gates passes', () => {
  const r = evaluateB2(fixture());
  assert.equal(r.signal, 'BUY');
  assert.equal(r.eligible, true);
  assert.equal(r.crossover, 'BULLISH');
  assert.equal(r.eventId, 'TEST:2026-09-17:BULLISH');
  assert.ok(r.metrics.previousFastMA <= r.metrics.previousSlowMA);
  assert.ok(r.metrics.fastMA > r.metrics.slowMA);
  assert.equal(r.metrics.relativeVolume, 3);
  assert.equal(r.metrics.dailyGainPct, 11);
  assert.ok(r.gates.every(g => g.passed));
});
test('same evidence produces stable reservation identity', () => {
  assert.equal(evaluateB2(fixture()).eventId, evaluateB2(fixture()).eventId);
});
test('MA remains above does not generate repeated buy', () => {
  const f = fixture();
  f.bars = f.bars.map((b, i) => {
    const c = 5 + i / 10;
    return { ...b, o: c, c, h: c + .1, l: c - .1 };
  });
  const r = evaluateB2(f);
  assert.equal(r.crossover, null);
  assert.equal(r.eligible, false);
  assert.equal(r.signal, 'WAIT');
});
test('unfinished daily candle cannot invent a crossover', () => {
  const f = fixture();
  const original = evaluateB2(f);
  f.bars.push({ t: '2026-09-18T04:00:00Z', o: 1, h: 99, l: 1, c: 99, v: 9999999 });
  assert.deepEqual(evaluateB2(f), original);
});
test('bearish crossover exits independently of all entry filters', () => {
  const f = fixture();
  f.bars = f.bars.map(b => ({ ...b, o: 20 - b.o, h: 20 - b.l, l: 20 - b.h, c: 20 - b.c }));
  f.snapshot = {};
  f.asset = { symbol: 'TEST', tradable: false };
  const r = evaluateB2(f);
  assert.equal(r.crossover, 'BEARISH');
  assert.equal(r.signal, 'EXIT');
  assert.equal(r.eligible, false);
});
test('verified calendar rejects a missing weekday session', () => {
  const f = withCalendar();
  f.completedSessionDates.splice(-3, 1);
  const r = evaluateB2(f);
  assert.equal(r.signal, 'WAIT');
  assert.equal(r.eligible, false);
  assert.match(r.reasons[0], /last 65 completed exchange sessions/);
});
test('verified calendar allows an absent exchange holiday', () => {
  const f = withCalendar();
  const holiday = dates.at(-3);
  const calendar = f.completedSessionDates.filter(date => date !== holiday);
  // Keep every qualifying close in the fixture. The older replacement session
  // gives the same number of accepted bars while the verified calendar
  // correctly omits the exchange holiday.
  const replacement = new Date(`${calendar[0]}T12:00:00Z`);
  do {
    replacement.setUTCDate(replacement.getUTCDate() - 1);
  } while ([0, 6].includes(replacement.getUTCDay()));
  calendar.unshift(replacement.toISOString().slice(0, 10));
  f.completedSessionDates = calendar;
  f.bars = f.bars.map((bar, index) => ({
    ...bar, t: `${calendar[index]}T04:00:00Z`,
  }));
  assert.equal(evaluateB2(f).signal, 'BUY');
});
for (const [name, calendar] of [
  ['malformed', [...dates.slice(0, -1), 'not-a-date']],
  ['invalid calendar date', [...dates.slice(0, -1), '2026-99-99']],
  ['incomplete', dates.slice(-64)],
  ['out of order', [...dates.slice(0, -2), dates.at(-1), dates.at(-2)]],
]) {
  test(`verified calendar rejects ${name} input`, () => {
    const f = fixture();
    f.completedSessionDates = calendar;
    const r = evaluateB2(f);
    assert.equal(r.signal, 'WAIT');
    assert.equal(r.eligible, false);
  });
}
test('bearish crossover cannot exit with a missing verified session', () => {
  const f = withCalendar();
  f.bars = f.bars.map(b => ({ ...b, o: 20 - b.o, h: 20 - b.l, l: 20 - b.h, c: 20 - b.c }));
  f.completedSessionDates.splice(-3, 1);
  f.snapshot = {};
  f.asset = { symbol: 'TEST', tradable: false };
  const r = evaluateB2(f);
  assert.equal(r.signal, 'WAIT');
  assert.equal(r.crossover, null);
});
for (const [name, mutate, expectedGate] of [
  ['relative volume below 2', f => { f.snapshot.dailyBar.v = 599999; }, 'Relative volume ≥2x'],
  ['gain below 10%', f => { f.snapshot.latestTrade.p = f.snapshot.prevDailyBar.c * 1.099; }, 'Daily gain ≥10%'],
  ['trade above $20', f => { f.snapshot.latestTrade.p = 20.01; }, 'Price $1–$20'],
  ['ask above $20', f => { f.snapshot.latestQuote.ap = 20.01; }, 'Price $1–$20'],
  ['trade below $1', f => { f.snapshot.latestTrade.p = .99; }, 'Price $1–$20'],
  ['stale quote', f => { f.snapshot.latestQuote.t = new Date(now - 61000).toISOString(); }, 'Halt and quote safety'],
  ['future quote', f => { f.snapshot.latestQuote.t = new Date(now + 60000).toISOString(); }, 'Halt and quote safety'],
  ['stale trade', f => { f.snapshot.latestTrade.t = new Date(now - 91000).toISOString(); }, 'Halt and quote safety'],
  ['wide spread', f => { f.snapshot.latestQuote.bp -= 1; }, 'Liquidity'],
  ['crossed quote', f => { f.snapshot.latestQuote.bp = 15; }, 'Halt and quote safety'],
  ['halted', f => { f.asset.halted = true; }, 'Halt and quote safety'],
  ['missing depth', f => { delete f.snapshot.latestQuote.as; }, 'Halt and quote safety'],
  ['inactive', f => { f.asset.status = 'inactive'; }, 'Tradable equity'],
  ['untradable', f => { f.asset.tradable = false; }, 'Tradable equity'],
  ['not equity', f => { f.asset.class = 'crypto'; }, 'Tradable equity'],
  ['old daily snapshot', f => { f.snapshot.dailyBar.t = '2026-09-17T04:00:00Z'; }, 'Current session snapshot'],
  ['previous-close mismatch', f => { f.snapshot.prevDailyBar.c *= .5; }, 'Current session snapshot'],
  ['previous-close wrong session', f => { f.snapshot.prevDailyBar.t = '2026-09-16T04:00:00Z'; }, 'Current session snapshot'],
  ['insufficient current volume', f => { f.snapshot.dailyBar.v = 499999; }, 'High volume'],
]) {
  test(`${name} fails closed`, () => {
    const f = fixture(); mutate(f);
    const r = evaluateB2(f);
    assert.equal(r.eligible, false);
    assert.equal(r.gates.find(g => g.name === expectedGate)?.passed, false);
  });
}
for (const [name, mutate] of [
  ['short history', f => { f.bars = f.bars.slice(-50); }],
  ['stale daily history', f => { f.bars.pop(); }],
  ['missing OHLCV', f => { delete f.bars[60].v; }],
  ['invalid candle', f => { f.bars[60].l = 0; }],
  ['duplicate daily session', f => { f.bars[60].t = f.bars[59].t; }],
  ['out of order', f => { [f.bars[59], f.bars[60]] = [f.bars[60], f.bars[59]]; }],
  ['missing calendar', f => { delete f.expectedSessionDate; }],
]) {
  test(`${name} cannot generate buy or exit`, () => {
    const f = fixture(); mutate(f);
    const r = evaluateB2(f);
    assert.equal(r.eligible, false); assert.equal(r.signal, 'WAIT'); assert.equal(r.crossover, null);
  });
}
test('full-day volume baseline and exact 2x/10% boundaries', () => {
  const f = fixture();
  f.snapshot.dailyBar.v = 600000;
  f.snapshot.latestTrade.p = f.snapshot.prevDailyBar.c * 1.1;
  assert.equal(evaluateB2(f).eligible, true);
});
test('ranking is lexicographic, prioritizing RVOL before gain', () => {
  const a = { symbol: 'A', eligible: true, metrics: { relativeVolume: 3, dailyGainPct: 10 } };
  const b = { symbol: 'B', eligible: true, metrics: { relativeVolume: 2, dailyGainPct: 100 } };
  assert.ok(rankB2Candidates(a, b) < 0);
  assert.ok(rankB2Candidates({ ...a, eligible: false }, b) > 0);
});
test('entry is a sized limit long with broker-held OTO stop', () => {
  const order = buildB2Entry({ symbol: 'TEST', ask: 10, maxPositionDollars: 1000, buyingPower: 555, clientOrderId: 'b2_test-event' });
  assert.equal(order.qty, '55'); assert.equal(order.side, 'buy');
  assert.equal(order.type, 'limit'); assert.equal(order.time_in_force, 'gtc');
  assert.equal(order.order_class, 'oto');
  assert.equal(order.stop_loss.stop_price, '9.50');
});
test('stop rounds safely and size never exceeds budget', () => {
  const order = buildB2Entry({ symbol: 'TEST', ask: 1.015, maxPositionDollars: 100, buyingPower: 100, clientOrderId: 'b2_test' });
  assert.ok(Number(order.qty) * Number(order.limit_price) <= 100);
  assert.ok(Number(order.stop_loss.stop_price) >= Number(order.limit_price) * .95 - 1e-9);
  assert.ok(Number(order.stop_loss.stop_price) < Number(order.limit_price));
});
test('invalid or empty sizing and absent durable ID cannot place order', () => {
  const valid = { symbol: 'TEST', ask: 10, maxPositionDollars: 100, buyingPower: 100, clientOrderId: 'b2_test' };
  for (const override of [{ ask: null }, { ask: 21 }, { buyingPower: 0 }, { maxPositionDollars: 1 }, { clientOrderId: '' }]) {
    assert.throws(() => buildB2Entry({ ...valid, ...override }));
  }
  assert.equal(B2_RULES.stopLossPct, 5);
  assert.equal(B2_RULES.maxPositions, 2);
});
// --- Crossover window + leveraged-ETF universe (2026-09-25) ---
// Fixture with the 20/50 bullish crossover at a known bar: 82 sessions,
// flat 10 -> flat 6 -> linear rise, crossing exactly at bar 79.
// extraTail appends gently-rising sessions after the cross to age it.
function windowFixture(symbol = 'TEST', priceScale = 1, extraTail = 0) {
  const total = 82 + extraTail;
  const end = new Date('2026-09-21T12:00:00Z');
  for (let added = 0; added < extraTail; end.setUTCDate(end.getUTCDate() + 1)) {
    if (![0, 6].includes(end.getUTCDay())) added++;
  }
  const endDate = end.toISOString().slice(0, 10);
  const dates = [];
  for (const d = new Date(end); dates.length < total; d.setUTCDate(d.getUTCDate() - 1)) {
    if (![0, 6].includes(d.getUTCDay())) dates.unshift(d.toISOString().slice(0, 10));
  }
  const nextSession = new Date(end);
  do { nextSession.setUTCDate(nextSession.getUTCDate() + 1); } while ([0, 6].includes(nextSession.getUTCDay()));
  const nowDate = nextSession.toISOString().slice(0, 10);
  const nowMs = Date.parse(`${nowDate}T15:00:00Z`);
  const bars = dates.map((date, i) => {
    let c = i < 40 ? 10 : i < 70 ? 6 : 7 + 6 * Math.min(i - 70, 11) / 11;
    if (i > 81) c += 0.15 * (i - 81);
    c *= priceScale;
    return { t: `${date}T04:00:00Z`, o: c * .99, h: c * 1.01, l: c * .98, c, v: 300000 };
  });
  const price = bars.at(-1).c * 1.11;
  return { bars, now: nowMs, expectedSessionDate: endDate,
    asset: { symbol, tradable: true, status: 'active', class: 'us_equity' },
    snapshot: {
      latestTrade: { p: price, t: new Date(nowMs).toISOString() },
      latestQuote: { bp: price - .01, ap: price + .01, bs: 10, as: 10, t: new Date(nowMs).toISOString() },
      dailyBar: { t: `${nowDate}T04:00:00Z`, v: 900000 },
      prevDailyBar: { t: `${endDate}T04:00:00Z`, c: bars.at(-1).c },
    } };
}
test('bullish crossover two sessions back still buys with stable identity', () => {
  const r = evaluateB2(windowFixture());
  assert.equal(r.signal, 'BUY');
  assert.equal(r.eligible, true);
  assert.equal(r.crossover, 'BULLISH');
  // Identity is pinned to the crossover session, not the evaluation day.
  assert.equal(r.eventId, 'TEST:2026-09-17:BULLISH');
  assert.equal(r.signalDate, '2026-09-17');
});
test('crossover older than the window does not buy', () => {
  const r = evaluateB2(windowFixture('TEST', 1, 4));
  assert.equal(r.signal, 'WAIT');
  assert.equal(r.crossover, null);
  assert.ok(r.reasons.some(reason => reason.includes('No bullish 20-day / 50-day SMA crossover')));
});
test('fresher bearish crossover overrides an older bullish one', () => {
  const dates = [];
  for (const d = new Date('2026-09-21T12:00:00Z'); dates.length < 80; d.setUTCDate(d.getUTCDate() - 1)) {
    if (![0, 6].includes(d.getUTCDay())) dates.unshift(d.toISOString().slice(0, 10));
  }
  const nowMs = Date.parse('2026-09-22T15:00:00Z');
  const bars = dates.map((date, i) => {
    const c = i < 77 ? 10 : i === 77 ? 10.3 : 9.7;
    return { t: `${date}T04:00:00Z`, o: c * .99, h: c * 1.01, l: c * .98, c, v: 300000 };
  });
  const r = evaluateB2({ bars, now: nowMs, expectedSessionDate: dates.at(-1),
    asset: { symbol: 'TEST', tradable: true, status: 'active', class: 'us_equity' }, snapshot: {} });
  assert.equal(r.crossover, 'BEARISH');
  assert.equal(r.signal, 'EXIT');
});
test('leveraged ETF trades above the $20 stock cap', () => {
  const r = evaluateB2(windowFixture('TQQQ', 60 / 13));
  assert.equal(r.signal, 'BUY');
  assert.equal(r.eligible, true);
  assert.ok(r.metrics.price > 20);
});
test('common stock above $20 still fails the price gate', () => {
  const r = evaluateB2(windowFixture('TEST', 60 / 13));
  assert.equal(r.signal, 'WAIT');
  assert.equal(r.eligible, false);
  assert.ok(r.gates.find(g => g.name.startsWith('Price $1')).passed === false);
});
test('buildB2Entry honors the leveraged-ETF price band', () => {
  const order = buildB2Entry({ symbol: 'TQQQ', ask: 60, maxPositionDollars: 1000, buyingPower: 10000, clientOrderId: 'b2_tqqq' });
  assert.equal(order.symbol, 'TQQQ');
  assert.equal(order.qty, '16');
  assert.throws(() => buildB2Entry({ symbol: 'TEST', ask: 60, maxPositionDollars: 1000, buyingPower: 10000, clientOrderId: 'b2_test' }));
});
console.log(`B2 strategy: ${passed} checks passed.`);