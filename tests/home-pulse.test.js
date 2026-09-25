'use strict';

// HomePulse home-page module tests (pure logic, zero I/O).
// home-pulse.js exposes its DOM-free helpers via module.exports in node.

const assert = require('node:assert/strict');
const HomePulse = require('../public/js/home-pulse');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

// ── Regime classification ───────────────────────────────────────────────────

test('Risk-On: VIX<20 and SPY up', () => {
  const r = HomePulse.classifyRegime(0.8, 16);
  assert.equal(r.label, 'Risk-On');
  assert.equal(r.tone, 'on');
  assert.match(r.reason, /buying risk/);
});

test('Risk-On at the boundary: VIX 19.9, SPY +0.01', () => {
  assert.equal(HomePulse.classifyRegime(0.01, 19.9).label, 'Risk-On');
});

test('Risk-Off: VIX>28', () => {
  const r = HomePulse.classifyRegime(0.5, 31);
  assert.equal(r.label, 'Risk-Off');
  assert.equal(r.tone, 'off');
  assert.match(r.reason, /de-risking/);
});

test('Risk-Off: SPY down more than 1%', () => {
  const r = HomePulse.classifyRegime(-1.4, 18);
  assert.equal(r.label, 'Risk-Off');
  assert.match(r.reason, /selling pressure/);
});

test('Risk-Off wins when VIX is high even if SPY is up', () => {
  assert.equal(HomePulse.classifyRegime(1.2, 33).label, 'Risk-Off');
});

test('Chop: calm VIX but flat SPY', () => {
  const r = HomePulse.classifyRegime(0.2, 22);
  assert.equal(r.label, 'Chop');
  assert.equal(r.tone, 'chop');
});

test('Chop: low VIX but SPY down (not Risk-On, not Risk-Off)', () => {
  assert.equal(HomePulse.classifyRegime(-0.5, 15).label, 'Chop');
});

test('SPY exactly 0 is not "up": Chop', () => {
  assert.equal(HomePulse.classifyRegime(0, 15).label, 'Chop');
});

test('VIX exactly 20 is not <20: Chop', () => {
  assert.equal(HomePulse.classifyRegime(0.6, 20).label, 'Chop');
});

test('SPY exactly -1 is not "down more than 1%": Chop', () => {
  assert.equal(HomePulse.classifyRegime(-1, 15).label, 'Chop');
});

test('SPY-only Risk-Off fires when VIX is missing', () => {
  assert.equal(HomePulse.classifyRegime(-2.5, null).label, 'Risk-Off');
});

test('Missing VIX degrades to Chop, never Risk-On', () => {
  assert.equal(HomePulse.classifyRegime(0.9, null).label, 'Chop');
});

test('Missing both inputs waits for data', () => {
  const r = HomePulse.classifyRegime(null, undefined);
  assert.equal(r.label, 'Waiting');
  assert.equal(r.tone, 'neutral');
});

test('VIX-only input without SPY degrades to Chop', () => {
  assert.equal(HomePulse.classifyRegime(null, 16).label, 'Chop');
});

// ── Trade summarizers ───────────────────────────────────────────────────────

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

test('todayRealizedPnl sums only closed trades from today (B2 camelCase)', () => {
  const today = todayIso();
  const trades = [
    { status: 'closed', pnl: 120.5, createdAt: today + 'T10:00:00' },
    { status: 'closed', pnl: -40, createdAt: today + 'T11:00:00' },
    { status: 'open', pnl: 999, createdAt: today + 'T12:00:00' },   // unrealized, excluded
    { status: 'closed', pnl: 500, createdAt: '2020-01-01T10:00:00' }, // old, excluded
  ];
  const r = HomePulse.todayRealizedPnl(trades);
  assert.equal(r.pnl, 80.5);
  assert.equal(r.trades, 2);
});

test('todayRealizedPnl handles SD snake_case rows', () => {
  const today = todayIso();
  const r = HomePulse.todayRealizedPnl([
    { status: 'closed', pnl: 75, created_at: today + ' 14:30:00' },
    { status: 'partial', pnl: 10, created_at: today + ' 14:00:00' }, // still open, excluded
  ]);
  assert.equal(r.pnl, 75);
  assert.equal(r.trades, 1);
});

test('todayRealizedPnl is zero-safe on empty/bad input', () => {
  assert.deepEqual(HomePulse.todayRealizedPnl([]), { pnl: 0, trades: 0 });
  assert.deepEqual(HomePulse.todayRealizedPnl(null), { pnl: 0, trades: 0 });
  assert.deepEqual(HomePulse.todayRealizedPnl([{ status: 'closed' }]), { pnl: 0, trades: 0 });
});

test('openPositionCount counts open/partial only', () => {
  const trades = [
    { status: 'open' }, { status: 'partial' },
    { status: 'closed' }, { status: 'pending' }, { status: 'rejected' }, {},
  ];
  assert.equal(HomePulse.openPositionCount(trades), 2);
  assert.equal(HomePulse.openPositionCount(null), 0);
});

// ── Status pill ─────────────────────────────────────────────────────────────

test('pillFor: disabled -> Paused, live -> Live, paper -> Paper', () => {
  assert.deepEqual(HomePulse.pillFor({ enabled: false, mode: 'paper' }), { text: 'Paused', cls: 'hp-pill-paused' });
  assert.deepEqual(HomePulse.pillFor(null), { text: 'Paused', cls: 'hp-pill-paused' });
  assert.deepEqual(HomePulse.pillFor({ enabled: true, mode: 'live' }), { text: 'Live', cls: 'hp-pill-live' });
  assert.deepEqual(HomePulse.pillFor({ enabled: true, mode: 'paper' }), { text: 'Paper', cls: 'hp-pill-paper' });
});

// ── Formatters ──────────────────────────────────────────────────────────────

test('formatters handle values and unknowns', () => {
  assert.equal(HomePulse.fmtPct(0.8), '+0.80%');
  assert.equal(HomePulse.fmtPct(-1.234), '-1.23%');
  assert.equal(HomePulse.fmtPct(null), '—');
  assert.equal(HomePulse.fmtPrice(110432.5), '110,433');
  assert.equal(HomePulse.fmtPrice(4.152), '4.15');
  assert.equal(HomePulse.fmtPrice(null), '—');
  assert.equal(HomePulse.fmtMoney(120.6), '+$121');
  assert.equal(HomePulse.fmtMoney(-45.2), '−$45');
  assert.equal(HomePulse.fmtMoney(0), '$0');
});

test('refresh is exposed', () => {
  assert.equal(typeof HomePulse.refresh, 'function');
});

console.log(`\n${passed} home-pulse tests passed`);
