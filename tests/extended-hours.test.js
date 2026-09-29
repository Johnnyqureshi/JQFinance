'use strict';

// Extended-hours price resolution tests (pure logic, no network).

const assert = require('node:assert/strict');
const {
  resolveExtendedHours,
  OVERNIGHT_FUTURES,
  isOvernightWindow,
  overnightAnchorYmd,
  deriveOvernightPrice,
} = require('../lib/extended-hours');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

// Sunday 2026-09-27, real Yahoo values: the case Johnny reported — Robinhood's
// $772.04 is Friday's after-hours price, reported with marketState CLOSED.
test('CLOSED weekend with moved AH price surfaces AH', () => {
  const r = resolveExtendedHours({
    marketState: 'CLOSED',
    regularMarketPrice: 771.35,
    postMarketPrice: 772.04,
  });
  assert.equal(r.extendedPrice, 772.04);
  assert.equal(r.extendedType, 'AH');
});

test('CLOSED weekend with flat AH price stays quiet', () => {
  const r = resolveExtendedHours({
    marketState: 'CLOSED',
    regularMarketPrice: 771.35,
    postMarketPrice: 771.35,
  });
  assert.equal(r.extendedPrice, null);
  assert.equal(r.extendedType, null);
});

test('CLOSED weekend with no AH price stays quiet', () => {
  const r = resolveExtendedHours({
    marketState: 'CLOSED',
    regularMarketPrice: 771.35,
  });
  assert.equal(r.extendedPrice, null);
  assert.equal(r.extendedType, null);
});

test('missing marketState defaults to CLOSED and surfaces moved AH', () => {
  const r = resolveExtendedHours({
    regularMarketPrice: 100,
    postMarketPrice: 101,
  });
  assert.equal(r.extendedPrice, 101);
  assert.equal(r.extendedType, 'AH');
});

test('POST session surfaces AH price', () => {
  const r = resolveExtendedHours({
    marketState: 'POST',
    regularMarketPrice: 771.35,
    postMarketPrice: 772.04,
  });
  assert.equal(r.extendedPrice, 772.04);
  assert.equal(r.extendedType, 'AH');
});

test('POST session with no AH price stays quiet', () => {
  const r = resolveExtendedHours({
    marketState: 'POST',
    regularMarketPrice: 771.35,
  });
  assert.equal(r.extendedPrice, null);
  assert.equal(r.extendedType, null);
});

test('PRE session surfaces pre-market price', () => {
  const r = resolveExtendedHours({
    marketState: 'PRE',
    regularMarketPrice: 771.35,
    preMarketPrice: 773.10,
    postMarketPrice: 772.04,
  });
  assert.equal(r.extendedPrice, 773.10);
  assert.equal(r.extendedType, 'PRE');
});

test('PREPRE with no pre-market data falls back to last AH price', () => {
  const r = resolveExtendedHours({
    marketState: 'PREPRE',
    regularMarketPrice: 771.35,
    postMarketPrice: 772.04,
  });
  assert.equal(r.extendedPrice, 772.04);
  assert.equal(r.extendedType, 'AH');
});

test('REGULAR session never surfaces extended price', () => {
  const r = resolveExtendedHours({
    marketState: 'REGULAR',
    regularMarketPrice: 771.35,
    postMarketPrice: 772.04,
    preMarketPrice: 773.10,
  });
  assert.equal(r.extendedPrice, null);
  assert.equal(r.extendedType, null);
});

console.log(`\nextended-hours: ${passed} passed`);

// ── Overnight (24h-market) window ────────────────────────────────────────────

test('overnight futures map covers the four index ETFs', () => {
  assert.deepEqual(OVERNIGHT_FUTURES, { SPY: 'ES=F', QQQ: 'NQ=F', DIA: 'YM=F', IWM: 'RTY=F' });
});

test('isOvernightWindow: Sunday night (futures open) → true', () => {
  // Sun 2026-09-27 22:08 ET — the moment Johnny reported the stale AH line.
  assert.equal(isOvernightWindow(new Date('2026-09-27T22:08:00-04:00')), true);
});

test('isOvernightWindow: Sunday afternoon (futures closed) → false', () => {
  assert.equal(isOvernightWindow(new Date('2026-09-27T15:00:00-04:00')), false);
});

test('isOvernightWindow: Saturday → false', () => {
  assert.equal(isOvernightWindow(new Date('2026-09-26T14:00:00-04:00')), false);
});

test('isOvernightWindow: Friday evening (futures closed) → false', () => {
  assert.equal(isOvernightWindow(new Date('2026-09-25T18:00:00-04:00')), false);
});

test('isOvernightWindow: Tuesday night → true', () => {
  assert.equal(isOvernightWindow(new Date('2026-09-29T23:00:00-04:00')), true);
});

test('isOvernightWindow: Monday 3am ET → true', () => {
  assert.equal(isOvernightWindow(new Date('2026-09-28T03:00:00-04:00')), true);
});

test('overnightAnchorYmd: Sunday → Friday', () => {
  assert.equal(overnightAnchorYmd(new Date('2026-09-27T22:08:00-04:00')), '2026-09-25');
});

test('overnightAnchorYmd: Saturday → Friday', () => {
  assert.equal(overnightAnchorYmd(new Date('2026-09-26T14:00:00-04:00')), '2026-09-25');
});

test('overnightAnchorYmd: Tuesday night → Tuesday', () => {
  assert.equal(overnightAnchorYmd(new Date('2026-09-29T23:00:00-04:00')), '2026-09-29');
});

test('deriveOvernightPrice: real Sunday numbers track the overnight move', () => {
  // ES=F live 7781.5, ES=F Fri 16:00 ET bar 7804.5, SPY Fri close 771.35.
  // Robinhood's live overnight print was $768.67 — the derived price must be
  // far closer to it than Friday's stale AH close ($772.04).
  const implied = deriveOvernightPrice({ futureLive: 7781.5, futureAnchor: 7804.5, etfClose: 771.35 });
  assert.ok(Math.abs(implied - 768.67) < 1.0, `implied ${implied} too far from 768.67`);
  assert.ok(Math.abs(implied - 768.67) < Math.abs(772.04 - 768.67), 'must beat stale AH');
});

test('deriveOvernightPrice: null-safe', () => {
  assert.equal(deriveOvernightPrice({ futureLive: null, futureAnchor: 7804.5, etfClose: 771.35 }), null);
  assert.equal(deriveOvernightPrice({ futureLive: 7781.5, futureAnchor: 0, etfClose: 771.35 }), null);
  assert.equal(deriveOvernightPrice({ futureLive: 7781.5, futureAnchor: 7804.5, etfClose: null }), null);
});

console.log(`\nextended-hours: ${passed} passed`);
