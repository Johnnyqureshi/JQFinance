'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRegime } = require('../lib/warrior/regime');

test('bullish when SPY and QQQ are above the 20 EMA and green', () => {
  const r = classifyRegime({
    spy: { price: 800, ema20: 790, dayChangePct: 0.8 },
    qqq: { price: 700, ema20: 690, dayChangePct: 1.1 },
  });
  assert.equal(r.regime, 'BULLISH');
  assert.ok(r.reasons.length > 0);
});

test('not bullish when one index is red on the day', () => {
  const r = classifyRegime({
    spy: { price: 800, ema20: 790, dayChangePct: -0.2 },
    qqq: { price: 700, ema20: 690, dayChangePct: 1.1 },
  });
  assert.equal(r.regime, 'NEUTRAL');
});

test('bearish when both indexes are below the 20 EMA and down over 0.5%', () => {
  const r = classifyRegime({
    spy: { price: 780, ema20: 790, dayChangePct: -1.2 },
    qqq: { price: 680, ema20: 690, dayChangePct: -0.9 },
  });
  assert.equal(r.regime, 'BEARISH');
});

test('bearish on a VIX spike even without deep index damage', () => {
  const r = classifyRegime({
    spy: { price: 795, ema20: 790, dayChangePct: 0.3 },
    qqq: { price: 695, ema20: 690, dayChangePct: 0.4 },
    vixChangePct: 22,
  });
  assert.equal(r.regime, 'BEARISH');
  assert.match(r.reasons.join(' '), /VIX/);
});

test('neutral on mixed signals', () => {
  const r = classifyRegime({
    spy: { price: 800, ema20: 790, dayChangePct: 0.8 },
    qqq: { price: 680, ema20: 690, dayChangePct: -0.9 },
  });
  assert.equal(r.regime, 'NEUTRAL');
});

test('neutral with a reason when index data is missing', () => {
  const r = classifyRegime({});
  assert.equal(r.regime, 'NEUTRAL');
  assert.ok(r.reasons.length > 0);
});
