'use strict';
const assert = require('assert');
const {
  evaluateSwingSetup, simulateSwingBacktest, aggregateSwingWeeklyBars,
  weeklyBarsAvailableAt, conservativeSwingOutcome,
} = require('../lib/swing-strategy');

let failed = 0;
function test(name, fn) { try { fn(); console.log(` ✓ ${name}`); } catch (error) { failed++; console.error(` ✗ ${name}: ${error.message}`); } }
let day = Date.UTC(2024, 0, 1);
function bar(o, c, v = 100000) { day += 86400000; return { o, c, h: Math.max(o, c) + .2, l: Math.min(o, c) - .2, v, t: new Date(day).toISOString(), completed: true }; }
function series() {
  const daily = Array.from({ length: 260 }, (_, i) => {
    const price = i < 220 ? 100 + i * .55 : 221 - (i - 220) * .15;
    return bar(price, price + .4, 100000);
  });
  daily.splice(-3, 3, bar(215, 213.8, 100000), bar(213.8, 212.9, 100000), bar(212.7, 215, 200000));
  const weekly = Array.from({ length: 60 }, (_, i) => ({ o: 100 + i * 1.7, c: 101 + i * 1.7, h: 103 + i * 1.7, l: 99 + i * 1.7, v: 500000, completed: true, t: new Date(Date.UTC(2022, 0, 3) + i * 604800000).toISOString() }));
  return { daily, weekly };
}
test('fails closed when completed higher timeframe bars are absent', () => {
  const { daily } = series();
  const result = evaluateSwingSetup({ symbol: 'X', dailyBars: daily, freshness: { daily: true } });
  assert.equal(result.eligible, false);
  assert(result.reasons.some(x => /weekly/i.test(x)));
});
test('reports optional evidence as explicitly unavailable', () => {
  const { daily, weekly } = series();
  const result = evaluateSwingSetup({ symbol: 'X', dailyBars: daily, weeklyBars: weekly, freshness: { daily: true, weekly: true } });
  assert.equal(result.evidence.quality.state, 'UNAVAILABLE');
  assert.equal(result.evidence.catalyst.state, 'UNAVAILABLE');
});
test('an explicit stale completed-bar state cannot be bypassed by a recent timestamp', () => {
  const { daily, weekly } = series();
  const result = evaluateSwingSetup({
    symbol: 'X', dailyBars: daily, weeklyBars: weekly,
    freshness: { daily: false, weekly: true },
  });
  assert.equal(result.eligible, false);
  assert(result.reasons.some(x => /daily bars are stale/i.test(x)));
});
test('blocks unresolved bearish catalysts', () => {
  const { daily, weekly } = series();
  const result = evaluateSwingSetup({ symbol: 'X', dailyBars: daily, weeklyBars: weekly, freshness: { daily: true, weekly: true }, relativeStrength: 1, catalyst: { bearishUnresolved: true } });
  assert.equal(result.eligible, false);
  assert(result.reasons.some(x => /bearish catalyst/i.test(x)));
});
test('RSI or a moving-average touch alone cannot trigger an entry', () => {
  const { daily, weekly } = series();
  daily.at(-1).o = daily.at(-1).c + 1;
  daily.at(-1).h = daily.at(-1).o + .2;
  const result = evaluateSwingSetup({ symbol: 'X', dailyBars: daily, weeklyBars: weekly, freshness: { daily: true, weekly: true } });
  assert.equal(result.eligible, false);
  assert(result.reasons.some(x => /alone is insufficient/i.test(x)));
});
test('falling knives with broken long-term structure are rejected', () => {
  const { daily, weekly } = series();
  for (let i = daily.length - 45; i < daily.length; i++) {
    daily[i].o *= .55; daily[i].c *= .55; daily[i].h *= .55; daily[i].l *= .55;
  }
  const result = evaluateSwingSetup({ symbol: 'X', dailyBars: daily, weeklyBars: weekly, freshness: { daily: true, weekly: true } });
  assert.equal(result.eligible, false);
  assert(result.reasons.some(x => /structure is broken|falling knife/i.test(x)));
});
test('illiquid setups fail closed', () => {
  const { daily, weekly } = series();
  daily.forEach(item => { item.v = 10; });
  const result = evaluateSwingSetup({ symbol: 'X', dailyBars: daily, weeklyBars: weekly, freshness: { daily: true, weekly: true } });
  assert.equal(result.eligible, false);
  assert(result.reasons.some(x => /liquidity/i.test(x)));
});
test('targets are capped by historical resistance', () => {
  const { daily, weekly } = series();
  const result = evaluateSwingSetup({ symbol: 'X', dailyBars: daily, weeklyBars: weekly, freshness: { daily: true, weekly: true } });
  assert(result.riskReward <= 3);
  if (result.targets.length) assert.equal(result.targets[2].r, result.riskReward);
});
test('a weekly aggregate is unavailable until its final constituent bar closes', () => {
  const decision = { t: '2026-08-25T20:00:00Z' };
  const bars = [
    { t: '2026-08-24', completedAt: '2026-08-28T20:00:00Z' },
    { t: '2026-08-17', completedAt: '2026-08-21T20:00:00Z' },
  ];
  assert.deepStrictEqual(weeklyBarsAvailableAt(bars, decision), [bars[1]]);
});
test('production weekly aggregation carries its real final constituent timestamp', () => {
  const source = [
    { t:'2026-08-24T04:00:00Z',o:10,h:11,l:9,c:10.5,v:100,completed:true },
    { t:'2026-08-25T04:00:00Z',o:10.5,h:12,l:10,c:11.5,v:120,completed:true },
    { t:'2026-08-28T04:00:00Z',o:11.5,h:13,l:11,c:12.5,v:130,completed:true },
  ];
  const weekly=aggregateSwingWeeklyBars(source);
  assert.equal(weekly.length,1);
  assert.equal(weekly[0].t,'2026-08-24');
  assert.equal(weekly[0].completedAt,'2026-08-28T04:00:00Z');
  assert.equal(weeklyBarsAvailableAt(weekly,{t:'2026-08-25T20:00:00Z'}).length,0);
  assert.equal(weeklyBarsAvailableAt(weekly,{t:'2026-08-31T20:00:00Z'}).length,1);
});
test('same-bar stop wins and a gap through the stop exits at the worse open', () => {
  const both = conservativeSwingOutcome({ o: 10, h: 13, l: 8, c: 11, v: 100, completed: true }, 9, 12, 0);
  assert.equal(both.outcome, 'STOP');
  const gap = conservativeSwingOutcome({ o: 8, h: 9, l: 7, c: 8.5, v: 100, completed: true }, 9, 12, 10);
  assert.equal(gap.outcome, 'STOP');
  assert(gap.exitPrice < 8);
});
test('backtest enters no earlier than the following completed session', () => {
  const { daily, weekly } = series(); daily.push(bar(159, 160, 200000));
  const result = simulateSwingBacktest({ symbol: 'X', dailyBars: daily, weeklyBars: weekly, relativeStrength: 1 });
  result.records.forEach(record => assert.equal(record.entryIndex, record.decisionIndex + 1));
});
if (failed) process.exit(1);