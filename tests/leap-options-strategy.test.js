'use strict';
const assert=require('assert');
const { evaluateLeapOptionsSignal, leapThesisInvalidated, simulateLeapOptionsStrategy }=require('../lib/leap-options-strategy');
function weekly(values) { return values.map((c,i)=>({o:c,h:c+1,l:c-1,c,t:new Date(Date.UTC(2024,0,5)+i*604800000).toISOString(),completed:true})); }
// Rising long-term trend followed by a sufficiently sharp completed-week pullback.
const closes=[...Array.from({length:37},(_,i)=>100+i*2),...Array.from({length:14},(_,i)=>172-(i+1)*.01)];
const bars=weekly(closes);
let result=evaluateLeapOptionsSignal({symbol:'QQQ',weeklyBars:bars,freshness:{weekly:true}});
assert.equal(result.eligible,true);
assert.equal(evaluateLeapOptionsSignal({symbol:'SPY',weeklyBars:bars,freshness:{weekly:true}}).eligible,false);
assert.equal(evaluateLeapOptionsSignal({symbol:'QQQ',weeklyBars:bars.map(x=>({...x,completed:false})),freshness:{weekly:true}}).eligible,false);
assert.equal(evaluateLeapOptionsSignal({symbol:'QQQ',weeklyBars:bars,freshness:{weekly:false}}).eligible,false);
const invalid=weekly([...Array.from({length:51},(_,i)=>200-i)]);
assert.equal(leapThesisInvalidated({weeklyBars:invalid}).invalidated,true);
assert.equal(leapThesisInvalidated({weeklyBars:bars}).invalidated,false);
const simulated=simulateLeapOptionsStrategy({symbol:'QQQ',weeklyBars:[...bars,...weekly([90,89]).map((x,i)=>({...x,t:new Date(Date.UTC(2025,0,5)+i*604800000).toISOString()}))]});
assert.equal(simulated.summary.historicalOptionResults,'UNAVAILABLE');
simulated.records.forEach(x=>assert.equal(x.historicalOptionResult,'UNAVAILABLE'));
console.log(' ✓ LEAP options strategy');