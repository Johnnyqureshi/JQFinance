'use strict';
const assert = require('assert');
const { analyzeMomentumPatterns } = require('../lib/momentum-patterns');
let passed=0; let failed=0;
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); failed++; } }
function bar(o,c,v=1000,w=.04) { return { o, c, h:Math.max(o,c)+w, l:Math.min(o,c)-w, v }; }
console.log('\nMomentum continuation patterns\n');
test('confirms candle-over-candle only with higher structure and volume', () => {
  const bars=Array.from({length:8},(_,i)=>bar(10+i*.02,10.01+i*.02,1000));
  bars.push(bar(10.15,10.45,1300), bar(10.5,10.72,1700));
  const result=analyzeMomentumPatterns(bars);
  assert(result.patterns.candleOverCandle.detected);
  assert(result.confirmed.includes('CANDLE_OVER_CANDLE'));
});
test('recognizes a volume-contracted bull flag breakout', () => {
  const bars=[bar(10,10.3,2200),bar(10.3,10.65,2400),bar(10.62,10.56,1000),bar(10.56,10.5,900),bar(10.5,10.55,800),bar(10.54,10.72,1800)];
  const result=analyzeMomentumPatterns([bar(9.9,9.95),bar(9.95,10),...bars]);
  assert.strictEqual(result.patterns.bullFlag.state,'BREAKOUT');
  assert(result.patterns.bullFlag.detected);
});
test('recognizes an ABCD breakout with a higher-low retest', () => {
  const bars=[bar(10,10.35,1800),bar(10.35,10.6,2200),bar(10.58,10.7,2000),bar(10.65,10.4,1100),bar(10.42,10.45,900),bar(10.5,10.62,900),bar(10.48,10.66,950),bar(10.58,10.68,1000),bar(10.7,10.9,1700)];
  const result=analyzeMomentumPatterns(bars);
  assert.strictEqual(result.patterns.abcd.state,'BREAKOUT');
  assert(result.patterns.abcd.detected);
  assert(result.patterns.abcd.c > result.patterns.abcd.b);
});
test('fails closed on malformed or insufficient evidence', () => {
  const malformed=Array.from({length:8},()=>bar(10,10.1)); malformed[4].v=null;
  assert.strictEqual(analyzeMomentumPatterns(malformed).available,false);
  assert.strictEqual(analyzeMomentumPatterns([bar(10,10.1)]).available,false);
});
test('does not confirm a low-volume breakout', () => {
  const bars=[bar(10,10.3,2200),bar(10.3,10.65,2400),bar(10.62,10.56,1000),bar(10.56,10.5,900),bar(10.5,10.55,800),bar(10.54,10.72,700)];
  const result=analyzeMomentumPatterns([bar(9.9,9.95),bar(9.95,10),...bars]);
  assert.strictEqual(result.patterns.bullFlag.detected,false);
});
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);