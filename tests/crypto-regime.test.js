'use strict';

// Crypto BTC-regime classifier — bullish / neutral / bearish /
// high_volatility, with the volatility override.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifyBtcRegime, altcoinLongsAllowed } = require('../lib/crypto/regime');

test('bullish: price above 20 EMA, 20 above 50, green on the day', () => {
  const r = classifyBtcRegime({ btc: { price: 105, ema20: 100, ema50: 95, dayChangePct: 2, atrPct: 3 } });
  assert.equal(r.regime, 'bullish');
  assert.ok(r.reasons.length > 0);
});

test('bearish: price below 20 EMA, 20 below 50, down over 0.5%', () => {
  const r = classifyBtcRegime({ btc: { price: 90, ema20: 100, ema50: 105, dayChangePct: -3, atrPct: 4 } });
  assert.equal(r.regime, 'bearish');
});

test('high_volatility overrides a green tape via daily ATR%', () => {
  const r = classifyBtcRegime({ btc: { price: 105, ema20: 100, ema50: 95, dayChangePct: 4, atrPct: 12 } });
  assert.equal(r.regime, 'high_volatility');
  assert.match(r.reasons.join(' '), /volatility/i);
});

test('high_volatility triggers on an extreme single-day move', () => {
  const r = classifyBtcRegime({ btc: { price: 112, ema20: 100, ema50: 95, dayChangePct: 12, atrPct: 5 } });
  assert.equal(r.regime, 'high_volatility');
});

test('mixed signals classify neutral', () => {
  const r = classifyBtcRegime({ btc: { price: 101, ema20: 100, ema50: 102, dayChangePct: 0.3, atrPct: 3 } });
  assert.equal(r.regime, 'neutral');
});

test('a mild down day above the EMAs is not bearish', () => {
  const r = classifyBtcRegime({ btc: { price: 102, ema20: 100, ema50: 95, dayChangePct: -0.3, atrPct: 3 } });
  assert.equal(r.regime, 'neutral');
});

test('missing BTC price defaults to neutral, never crashes', () => {
  const r = classifyBtcRegime({ btc: {} });
  assert.equal(r.regime, 'neutral');
  const empty = classifyBtcRegime();
  assert.equal(empty.regime, 'neutral');
});

test('thresholds are configurable', () => {
  const strict = classifyBtcRegime({
    btc: { price: 105, ema20: 100, ema50: 95, dayChangePct: 4, atrPct: 6 },
    thresholds: { highVolAtrPct: 5 },
  });
  assert.equal(strict.regime, 'high_volatility');
});

test('altcoinLongsAllowed suppresses new longs in bearish and high-volatility regimes', () => {
  assert.equal(altcoinLongsAllowed('bullish'), true);
  assert.equal(altcoinLongsAllowed('neutral'), true);
  assert.equal(altcoinLongsAllowed('bearish'), false);
  assert.equal(altcoinLongsAllowed('high_volatility'), false);
});
