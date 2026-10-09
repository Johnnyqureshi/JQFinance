'use strict';

// ORB service tests — schema, settings validation, connect/disconnect safety,
// daily-lock gating, candidate/rejected persistence, pruning, route mounting,
// clientId uniqueness, paper-only order refusal, and one full scan-cycle
// entry through the real engine (synthetic bars engineered for exactly one
// winning long setup on AAA, 2026-10-01).
// Mirrors the flipper-service test fixture style (in-memory better-sqlite3,
// real credential vault, fake broker fetch). No network.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const {
  createOrbService, mountOrb, OrbError, DEFAULT_ORB_RULES,
} = require('../lib/orb/service');
const { createCredentialVault } = require('../lib/credential-vault');

const NOW = Date.parse('2026-10-01T14:30:00Z'); // Thu 10:30 ET — entry window
const TRADE_DATE = '2026-10-01';
const clone = value => JSON.parse(JSON.stringify(value));
const iso = ms => new Date(ms).toISOString();

// --- synthetic market data --------------------------------------------------
// Engineered for exactly ONE long entry on AAA, 2026-10-01:
//   daily: 20 sessions, avg vol 1M; yesterday (09-30) range 9.90..10.15
//   (priorHigh 10.15 → ~1% room above the OR high).
//   1m 9:30-9:44 ET: OR 10.00..10.05. 9:45 bar closes 10.055 > OR high
//   (clean wick, tight extension, strong volume). Drift to 10.07 by 10:29.
//   SPY/QQQ/IWM all green → bullish regime. Spread 0.1% (≤ 0.3 max).
function dailyAAA() {
  const bars = [];
  let dayMs = Date.parse('2026-09-01T13:30:00Z');
  for (let i = 0; i < 29; i++) {
    bars.push({ t: iso(dayMs), o: 9.85, h: 9.95, l: 9.75, c: 9.85, v: 1000000 });
    dayMs += 86400000;
  }
  // Prior day 2026-09-30: high $10.15 clears the OR high ($10.05) by ~1.0%
  // (≥ the 0.5% minLevelClearancePct gate).
  bars.push({ t: iso(Date.parse('2026-09-30T13:30:00Z')), o: 10.0, h: 10.15, l: 9.9, c: 10.0, v: 1100000 });
  // Today's still-forming daily bar (production includes the partial day).
  bars.push({ t: iso(Date.parse('2026-10-01T13:30:00Z')), o: 10.0, h: 10.07, l: 10.0, c: 10.07, v: 500000 });
  return bars;
}
function dailyIndex(prevClose, lastClose) {
  return [
    { t: iso(Date.parse('2026-09-29T13:30:00Z')), o: prevClose, h: prevClose * 1.002, l: prevClose * 0.998, c: prevClose, v: 50000000 },
    { t: iso(Date.parse('2026-09-30T13:30:00Z')), o: prevClose * 1.001, h: lastClose * 1.001, l: prevClose * 0.999, c: lastClose, v: 52000000 },
  ];
}
function minuteBarsAAA() {
  const bars = [];
  const base = Date.parse('2026-10-01T13:30:00Z'); // 9:30 ET
  const m1 = (i, o, h, l, c, v) => bars.push({ t: iso(base + i * 60000), o, h, l, c, v });
  // OR window 9:30–9:44 ET: high 10.05, low 10.00
  m1(0, 10.00, 10.02, 10.00, 10.01, 80000);
  m1(1, 10.01, 10.03, 10.005, 10.02, 80000);
  m1(2, 10.02, 10.04, 10.01, 10.03, 80000);
  m1(3, 10.03, 10.05, 10.02, 10.04, 80000);
  for (let i = 4; i < 15; i++) {
    const c = 10.04 - (i - 3) * 0.002;
    m1(i, c + 0.005, Math.min(10.045, c + 0.01), Math.max(10.01, c - 0.01), c, 80000);
  }
  // Breakout bar 9:45 ET: close 10.055 beyond OR high 10.05
  m1(15, 10.03, 10.06, 10.02, 10.055, 150000);
  // Drift up to 10.07 by 10:29 ET — two-sided steps (a one-way grind pins
  // RSI(14) near 90 and would trip the maxRsiLong entry filter).
  let driftClose = 10.055;
  for (let i = 16; i < 60; i++) {
    const j = i - 15;
    driftClose += (j % 3 === 0) ? -0.003 : 0.0018;
    const c = i === 59 ? 10.07 : +driftClose.toFixed(4);
    m1(i, c - 0.003, c + 0.005, c - 0.008, c, 120000);
  }
  return bars;
}

function fixture(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO users(id) VALUES (1);
    CREATE TABLE broker_account_owners(account_id TEXT PRIMARY KEY, user_id INTEGER, scope TEXT, mode TEXT, claimed_at TEXT);
    CREATE TABLE broker_account_quarantine(account_id TEXT PRIMARY KEY, resolved_at TEXT);
  `);
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-987654321');
  const world = { time: NOW, calls: [], orderPosts: [], orderBook: {}, orderSeq: 0, ...options };
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value) });
  async function fakeFetch(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const query = parsed.searchParams;
    world.calls.push({ url, path, method: init.method || 'GET' });
    if (parsed.hostname === 'paper-api.alpaca.markets') {
      if (path === '/v2/account' && (init.method || 'GET') === 'GET') return response({
        id: 'acct-orb-test', status: 'ACTIVE', trading_blocked: false,
        account_blocked: false, trade_suspended_by_user: false,
        equity: '100000', buying_power: '100000', last_equity: '100000',
      });
      if (path === '/v2/calendar') return response([{ date: '2026-10-01', open: '09:30', close: '16:00' }]);
      if (path === '/v2/clock') return response({ timestamp: iso(world.time), is_open: true });
      if (path === '/v2/assets') return response([{
        symbol: 'AAA', class: 'us_equity', status: 'active', tradable: true,
        exchange: 'NASDAQ', name: 'AAA Corp', shortable: true, easy_to_borrow: true,
      }]);
      if (path === '/v2/positions') return response([]);
      if (path === '/v2/orders' && query.get('status') === 'open') return response([]);
      if (path.startsWith('/v2/orders:by_client_order_id')) {
        const id = query.get('client_order_id');
        const order = world.orderBook[id];
        if (!order) return response({ message: 'not found' }, 404);
        // The working limit order fills immediately on the next poll.
        return response({ ...order, status: 'filled', filled_qty: order.qty, filled_avg_price: 10.07 });
      }
      if (path === '/v2/orders' && (init.method || 'GET') === 'POST') {
        const body = JSON.parse(init.body || '{}');
        world.orderPosts.push(body);
        const order = {
          id: `ord-${++world.orderSeq}`, client_order_id: body.client_order_id,
          symbol: body.symbol, qty: body.qty, side: body.side, type: body.type,
          status: 'new', filled_qty: 0, filled_avg_price: null,
        };
        world.orderBook[body.client_order_id] = order;
        return response(order);
      }
      return response({ message: `unexpected ${parsed.hostname}${path}` }, 500);
    }
    if (parsed.hostname === 'data.alpaca.markets') {
      if (path === '/v2/stocks/bars') {
        const symbols = (query.get('symbols') || '').split(',').filter(Boolean);
        const bySymbol = {
          AAA: dailyAAA(),
          SPY: dailyIndex(770, 773.1),
          QQQ: dailyIndex(690, 693.5),
          IWM: dailyIndex(240, 240.85),
          ...(world.dailyBySymbol || {}),
        };
        const bars = query.get('timeframe') === '1Min'
          ? Object.fromEntries(symbols.map(s => [s, (world.minuteBySymbol || {})[s] || (s === 'AAA' ? minuteBarsAAA() : [])]))
          : Object.fromEntries(symbols.map(s => [s, bySymbol[s] || []]));
        return response({ bars, next_page_token: null });
      }
      if (path === '/v2/stocks/bars/latest') {
        return response({ bars: { AAA: { c: 10.07, t: iso(world.time) }, ...(world.latestBySymbol || {}) } });
      }
      if (path === '/v2/stocks/quotes/latest') {
        return response({ quotes: { AAA: { bp: 10.065, ap: 10.075, t: iso(world.time) }, ...(world.quoteBySymbol || {}) } });
      }
      if (path.startsWith('/v1beta1/screener/')) {
        // Market-mode screener. Unconfigured → HTTP 500 (the failure path).
        // world.screener = { actives, gainers, losers, fail: [pathPart],
        // hangOnce: path } shapes the feed per test.
        const scr = world.screener;
        if (!scr) return response({ message: 'screener not configured' }, 500);
        if (scr.hangOnce === path && !world._screenerHung) {
          world._screenerHung = true;
          return new Promise(() => {}); // never resolves — the service timeout fires
        }
        if ((scr.fail || []).some(part => path.includes(part))) return response({ message: 'screener down' }, 500);
        if (path === '/v1beta1/screener/stocks/most-actives') {
          return response({ most_actives: (scr.actives || []).map(symbol => ({ symbol, volume: 1000000 })) });
        }
        if (path === '/v1beta1/screener/stocks/movers') {
          return response({
            gainers: (scr.gainers || []).map(symbol => ({ symbol, percent_change: 5 })),
            losers: (scr.losers || []).map(symbol => ({ symbol, percent_change: -5 })),
          });
        }
        return response({ message: 'unexpected screener path' }, 500);
      }
      return response({ message: `unexpected ${parsed.hostname}${path}` }, 500);
    }
    return response({ message: `unexpected ${parsed.hostname}${path}` }, 500);
  }
  const service = createOrbService({
    db, vault, fetch: fakeFetch, now: () => world.time,
    persistenceReady: () => true, durability: null,
    timeoutMs: world.timeoutMs || 10000,
    exitPoll: { tries: 3, intervalMs: 0 },
  });
  return { db, service, world };
}

// Builds a fixture whose orb_settings row (with the given stored rules)
// already exists BEFORE the service is constructed — the only way the
// constructor's one-shot migrations can see it.
function fixtureWithStoredRules(storedRules) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO users(id) VALUES (1);
    CREATE TABLE broker_account_owners(account_id TEXT PRIMARY KEY, user_id INTEGER, scope TEXT, mode TEXT, claimed_at TEXT);
    CREATE TABLE broker_account_quarantine(account_id TEXT PRIMARY KEY, resolved_at TEXT);
    CREATE TABLE orb_settings (
      user_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'paper', rules TEXT NOT NULL DEFAULT '{}',
      scheduler_status TEXT NOT NULL DEFAULT 'idle', scheduler_reason TEXT,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
  `);
  db.prepare('INSERT INTO orb_settings(user_id, rules) VALUES (1, ?)')
    .run(JSON.stringify(storedRules));
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-987654321');
  const service = createOrbService({
    db, vault,
    fetch: async () => { throw new Error('no network in migration tests'); },
    now: () => NOW,
    persistenceReady: () => true, durability: null,
    exitPoll: { tries: 3, intervalMs: 0 },
  });
  return { db, service };
}

async function connectPaper(f) {
  return f.service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8) });
}

// --- schema -----------------------------------------------------------------
test('orb schema creates every orb_* table', async () => {
  const { db } = fixture();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'orb_%' ORDER BY name")
    .all().map(r => r.name);
  for (const expected of ['orb_settings', 'orb_credentials', 'orb_leases', 'orb_positions',
    'orb_trades', 'orb_alerts', 'orb_rejected', 'orb_backtests', 'orb_backtest_trades',
    'orb_day_state', 'orb_candidates']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
});

test('orb_trades columns are exactly TRADE_FIELDS (all TEXT)', async () => {
  const { db } = fixture();
  const cols = db.prepare('PRAGMA table_info(orb_trades)').all();
  const tradeCols = cols.filter(c => !['trade_id', 'user_id', 'created_at'].includes(c.name));
  const { TRADE_FIELDS } = require('../lib/orb/journal');
  assert.deepEqual(tradeCols.map(c => c.name), [...TRADE_FIELDS]);
  assert.ok(tradeCols.every(c => c.type === 'TEXT'), 'all journal columns are TEXT');
});

test('service exposes the pinned contract surface', async () => {
  const { service } = fixture();
  for (const key of ['strategy', 'start', 'stop', 'drain', 'lifecycleStatus',
    'connect', 'disconnect', 'setSettings', 'getSettings', 'status',
    'dashboard', 'positions', 'trades', 'alerts', 'universe',
    'backtest', 'getBacktests', 'getBacktest', 'pruneDiagnostics', 'DEFAULT_ORB_RULES']) {
    assert.ok(service[key] !== undefined, `missing export ${key}`);
  }
  assert.equal(service.strategy, 'orb');
  assert.deepEqual(service.DEFAULT_ORB_RULES, DEFAULT_ORB_RULES);
});

test('constructor validates its dependencies', async () => {
  const { db } = fixture();
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-987654321');
  assert.throws(() => createOrbService({ vault, fetch: async () => ({}) }), /requires database/);
  assert.throws(() => createOrbService({ db, fetch: async () => ({}) }), /requires database/);
  assert.throws(() => createOrbService({ db, vault }), /requires database/);
});

// --- settings ---------------------------------------------------------------
test('orb ships disabled (enabled defaults to 0, PAPER mode)', async () => {
  const { service } = fixture();
  const view = service.getSettings(1);
  assert.equal(view.enabled, false);
  assert.equal(view.mode, 'paper');
  assert.equal(view.rules.tradingMode, 'PAPER');
});

test('unknown rule is rejected', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.setSettings(1, { rules: { not_a_rule: 1 } }),
    /Unknown setting: not_a_rule/);
});

test('wrong-typed rule is rejected', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.setSettings(1, { rules: { maxPositions: 'three' } }),
    /must be a finite non-negative number/);
  await assert.rejects(
    service.setSettings(1, { rules: { entryMode: 'moon' } }),
    /must be one of/);
});

test('engine validation rejects bad config values', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.setSettings(1, { rules: { minScore: 200 } }),
    /Invalid ORB configuration.*minScore/);
  await assert.rejects(
    service.setSettings(1, { rules: { targets: [{ r: 1, pct: 60 }, { r: 2, pct: 60 }] } }),
    /Invalid ORB configuration.*at most 100/);
  await assert.rejects(
    service.setSettings(1, { rules: { maxRsiLong: 140 } }),
    /Invalid ORB configuration.*maxRsiLong/);
  await assert.rejects(
    service.setSettings(1, { rules: { minPrice: 20, maxPrice: 1 } }),
    /Invalid ORB configuration.*maxPrice/);
});

test('valid settings round-trip through getSettings', async () => {
  const { service } = fixture();
  await service.setSettings(1, { enabled: true, rules: { minScore: 80, maxPositions: 2 } });
  const view = service.getSettings(1);
  assert.equal(view.enabled, true);
  assert.equal(view.rules.minScore, 80);
  assert.equal(view.rules.maxPositions, 2);
  assert.equal(view.revision, 1);
});

test('maxRsiLong round-trips and the new exit defaults are the factory profile', async () => {
  const { service } = fixture();
  const fresh = service.getSettings(1);
  assert.deepEqual(fresh.rules.targets, [{ r: 2, pct: 25 }]);
  assert.equal(fresh.rules.trailMode, 'atr');
  assert.equal(fresh.rules.orWidthTargets, false);
  assert.equal(fresh.rules.maxRsiLong, 75);
  await service.setSettings(1, { rules: { maxRsiLong: 80 } });
  assert.equal(service.getSettings(1).rules.maxRsiLong, 80);
  await service.setSettings(1, { rules: { maxRsiLong: 0 } }); // 0 = filter off
  assert.equal(service.getSettings(1).rules.maxRsiLong, 0);
});

// --- factory-exit migration (Johnny 2026-10-01) -----------------------------
test('factory-exit migration patches stored factory exits, preserves the rest', async () => {
  const { service } = fixtureWithStoredRules({
    targets: [{ r: 1.5, pct: 50 }, { r: 3, pct: 50 }],
    trailMode: 'none', orWidthTargets: true, minScore: 80,
  });
  const rules = service.getSettings(1).rules;
  assert.deepEqual(rules.targets, [{ r: 2, pct: 25 }]);
  assert.equal(rules.trailMode, 'atr');
  assert.equal(rules.orWidthTargets, false);
  assert.equal(rules.minScore, 80); // unrelated customization preserved
});

test('factory-exit migration leaves deliberate customizations untouched', async () => {
  // Custom targets (even with trailMode still 'none') → untouched.
  const a = fixtureWithStoredRules({ targets: [{ r: 1, pct: 100 }], trailMode: 'none' });
  assert.deepEqual(a.service.getSettings(1).rules.targets, [{ r: 1, pct: 100 }]);
  assert.equal(a.service.getSettings(1).rules.trailMode, 'none');
  // Factory targets but a trail mode already chosen → untouched.
  const b = fixtureWithStoredRules({
    targets: [{ r: 1.5, pct: 50 }, { r: 3, pct: 50 }], trailMode: 'vwap',
  });
  assert.deepEqual(b.service.getSettings(1).rules.targets, [{ r: 1.5, pct: 50 }, { r: 3, pct: 50 }]);
  assert.equal(b.service.getSettings(1).rules.trailMode, 'vwap');
});

// --- connect / disconnect ---------------------------------------------------
test('paper connect succeeds and stays disabled', async () => {
  const { service } = fixture();
  const result = await connectPaper({ service });
  assert.equal(result.ok, true);
  assert.equal(result.accountId, 'acct-orb-test');
  const status = await service.status(1);
  assert.equal(status.connected, true);
  assert.equal(status.enabled, false, 'connecting must not enable the bot');
});

test('live connect is refused loudly', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8), mode: 'live' }),
    /LIVE/);
});

test('disconnect is refused while a position is open', async () => {
  const f = fixture();
  await connectPaper(f);
  f.db.prepare(`INSERT INTO orb_positions(position_id,user_id,symbol,direction,entry_client_order_id,
    entry_price,shares,stop_price,targets_json,status,opened_at,updated_at)
    VALUES ('pos-1',1,'AAA','long','cid-1',10.07,49,9.76,'[]','open',?,?)`)
    .run(iso(NOW), iso(NOW));
  await assert.rejects(f.service.disconnect(1), /before disconnecting/);
  f.db.prepare("DELETE FROM orb_positions WHERE position_id='pos-1'").run();
  const result = await f.service.disconnect(1);
  assert.equal(result.ok, true);
  assert.equal((await f.service.status(1)).connected, false);
});

// --- scan cycle: one engineered entry ----------------------------------------
test('scan cycle takes the engineered long entry end to end', async () => {
  const f = fixture();
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: '' } });
  await f.service._scanCycle(1);

  assert.equal(f.world.orderPosts.length, 1, 'exactly one entry order');
  const order = f.world.orderPosts[0];
  assert.equal(order.symbol, 'AAA');
  assert.equal(order.side, 'buy');
  assert.equal(order.type, 'limit');
  assert.equal(order.qty, 49);
  assert.ok(String(order.client_order_id).startsWith('orb-'), 'orb- client order id prefix');

  const positions = f.db.prepare('SELECT * FROM orb_positions').all();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].status, 'open');
  assert.equal(positions[0].direction, 'long');

  const trades = f.db.prepare('SELECT * FROM orb_trades').all();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].symbol, 'AAA');
  assert.equal(trades[0].direction, 'long');
  assert.equal(+trades[0].entryPrice, 10.07);
  assert.ok(+trades[0].score >= 75, `score ${trades[0].score} meets the 75 minimum`);
  assert.ok(String(trades[0].entryReason).includes('ENTER-LONG'), 'why-this-trade recorded');
  assert.ok(String(trades[0].entryReason).includes('news unavailable'), 'news unavailability recorded');

  const candidates = f.db.prepare('SELECT * FROM orb_candidates WHERE trade_date=?').all(TRADE_DATE);
  assert.equal(candidates.length, 1);
  const data = JSON.parse(candidates[0].data);
  assert.equal(data.decision, 'enter-long');
  assert.ok(data.score >= 75);
  assert.equal(data.or.high, 10.05);
  assert.equal(data.newsUnavailable, true);

  const sched = f.db.prepare('SELECT scheduler_status FROM orb_settings WHERE user_id=1').get();
  assert.equal(sched.scheduler_status, 'ok');
});

test('scan cycle withholds entries when nothing qualifies', async () => {
  const f = fixture({ time: Date.parse('2026-10-01T11:00:00Z') }); // 07:00 ET — pre-market
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: '' } });
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0, 'no entries before the regular session');
});

test('daily-lock gating blocks entries (max daily loss)', async () => {
  const f = fixture();
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true });
  // Seed a locked day: -$250 day P&L against the $200 default cap.
  f.db.prepare('INSERT INTO orb_day_state(user_id,trade_date,state,updated_at) VALUES (?,?,?,?)')
    .run(1, TRADE_DATE, JSON.stringify({
      date: TRADE_DATE, pnl: -250, trades: 0, consecLosses: 0,
      openPositions: 0, exposureDollars: 0, tradesBySymbol: {}, attempts: {},
    }), iso(NOW));
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0, 'locked day places no orders');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orb_trades').get().n, 0, 'no trade records');
  const alert = f.db.prepare("SELECT * FROM orb_alerts WHERE kind='risk' ORDER BY id DESC LIMIT 1").get();
  assert.ok(alert && /daily locks/i.test(alert.message), 'lock engagement is alerted');
});

// --- client order ids ---------------------------------------------------------
test('clientId is unique per setup and deterministic per attempt', async () => {
  const { service } = fixture();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const id = service._clientId(1, TRADE_DATE, 'AAA', 'enter-long', '100700', String(NOW + i));
    assert.ok(/^orb-[0-9a-f]{40}$/.test(id), `shape: ${id}`);
    assert.ok(!seen.has(id), `collision: ${id}`);
    seen.add(id);
  }
  assert.equal(
    service._clientId(1, TRADE_DATE, 'AAA', 'enter-long', '100700', String(NOW)),
    service._clientId(1, TRADE_DATE, 'AAA', 'enter-long', '100700', String(NOW)),
    'same attempt inputs reuse the id (idempotent retries)');
});

// --- paper-only refusal -------------------------------------------------------
test('LIVE orders are refused loudly even with both live switches on', async () => {
  const f = fixture();
  await connectPaper(f);
  await f.service.setSettings(1, {
    enabled: true,
    rules: { watchlist: '', tradingMode: 'LIVE', liveEnabled: true, liveConfirmed: true },
  });
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0, 'no live orders ever reach the broker');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orb_trades').get().n, 0);
  const alert = f.db.prepare("SELECT * FROM orb_alerts WHERE kind='system' ORDER BY id DESC LIMIT 1").get();
  assert.ok(alert && /LIVE order refused/.test(alert.message), 'loud refusal is alerted');
});

// --- news policy --------------------------------------------------------------
test('news check reports unavailable without blocking trading', async () => {
  const { service } = fixture();
  const news = service._checkNews();
  assert.deepEqual(news, { available: false, material: null });
  const dash = await service.dashboard(1);
  assert.equal(dash.news.available, false);
  assert.ok(/unavailable/i.test(dash.news.note));
});

// --- dashboard / trades / universe --------------------------------------------
test('dashboard returns the full pinned shape', async () => {
  const { service } = fixture();
  const dash = await service.dashboard(1);
  for (const key of ['tradeDate', 'status', 'regime', 'indices', 'news', 'candidates',
    'rejected', 'dayState', 'locks', 'positions', 'todaysTrades']) {
    assert.ok(key in dash, `missing dashboard key ${key}`);
  }
  assert.equal(dash.tradeDate, TRADE_DATE);
  assert.equal(dash.dayState.date, TRADE_DATE);
  assert.equal(dash.locks.locked, false);
  assert.deepEqual(dash.positions, []);
});

test('dashboard reflects the entry after a scan cycle', async () => {
  const f = fixture();
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: '' } });
  await f.service._scanCycle(1);
  const dash = await f.service.dashboard(1);
  assert.equal(dash.candidates.length, 1);
  assert.equal(dash.candidates[0].decision, 'enter-long');
  assert.equal(dash.positions.length, 1);
  assert.equal(dash.todaysTrades.length, 1);
  assert.ok(dash.regime && dash.regime.regime === 'bullish', 'regime computed from index bars');
});

test('trades() lists the open position as a journal-shaped row', async () => {
  const f = fixture();
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: '' } });
  await f.service._scanCycle(1);
  const { trades } = f.service.trades(1);
  assert.equal(trades.length, 2, 'one open ride-along row + one journal row');
  const open = trades.find(t => t.status === 'open');
  assert.equal(open.symbol, 'AAA');
});

test('universe() returns today\'s scanned candidates', async () => {
  const f = fixture();
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: '' } });
  await f.service._scanCycle(1);
  const { universe, total, tradeDate } = f.service.universe(1);
  assert.equal(total, 1);
  assert.equal(tradeDate, TRADE_DATE);
  assert.equal(universe[0].symbol, 'AAA');
});

// --- pruneDiagnostics -----------------------------------------------------------
test('pruneDiagnostics enforces retention windows', async () => {
  const f = fixture();
  const old = iso(NOW - 8 * 86400000);
  const older = iso(NOW - 31 * 86400000);
  f.db.prepare('INSERT INTO orb_alerts(user_id,kind,message,created_at) VALUES (1,?,?,?)')
    .run('system', 'old alert', old);
  f.db.prepare('INSERT INTO orb_alerts(user_id,kind,message,created_at) VALUES (1,?,?,?)')
    .run('system', 'new alert', iso(NOW));
  f.db.prepare('INSERT INTO orb_rejected(user_id,symbol,trade_date,score,reject_reasons,context,created_at) VALUES (1,?,?,?,?,?,?)')
    .run('OLD', '2026-08-01', 10, '[]', '{}', older);
  f.db.prepare('INSERT INTO orb_rejected(user_id,symbol,trade_date,score,reject_reasons,context,created_at) VALUES (1,?,?,?,?,?,?)')
    .run('NEW', TRADE_DATE, 10, '[]', '{}', iso(NOW));
  const insertBt = f.db.prepare('INSERT INTO orb_backtests(id,user_id,params,report,created_at) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 21; i++) {
    const id = `bt-${i}`;
    insertBt.run(id, 1, '{}', '{}', iso(NOW - i * 60000));
    f.db.prepare('INSERT INTO orb_backtest_trades(backtest_id,seq,trade_json) VALUES (?,?,?)')
      .run(id, 0, '{}');
  }
  f.db.prepare('INSERT INTO orb_candidates(user_id,symbol,trade_date,data,updated_at) VALUES (?,?,?,?,?)')
    .run(1, 'OLD', '2026-09-30', '{}', old);
  f.db.prepare('INSERT INTO orb_candidates(user_id,symbol,trade_date,data,updated_at) VALUES (?,?,?,?,?)')
    .run(1, 'NEW', TRADE_DATE, '{}', iso(NOW));
  f.db.prepare('INSERT INTO orb_day_state(user_id,trade_date,state,updated_at) VALUES (?,?,?,?)')
    .run(1, '2026-08-01', '{}', older);
  await f.service.pruneDiagnostics(1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orb_alerts WHERE message='old alert'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orb_alerts WHERE message='new alert'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orb_rejected WHERE symbol='OLD'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orb_rejected WHERE symbol='NEW'").get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orb_backtests').get().n, 20);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orb_backtest_trades').get().n, 20, 'orphan backtest trades removed');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orb_candidates WHERE symbol='OLD'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orb_candidates WHERE symbol='NEW'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orb_day_state WHERE trade_date='2026-08-01'").get().n, 0);
});

// --- backtest (point-in-time engine in lib/orb/backtest.js) ----------------------
test('backtest requires a connected broker account', async () => {
  const { service } = fixture();
  const error = await service.backtest(1, { startDate: '2026-10-01', endDate: '2026-10-01' })
    .then(() => null, e => e);
  assert.ok(error instanceof OrbError, 'OrbError');
  assert.equal(error.status, 400);
});

test('backtest runs the point-in-time engine and persists results', async () => {
  const f = fixture();
  await connectPaper(f);
  // catalog path: backtest merges input.rules over defaults
  const result = await f.service.backtest(1, { startDate: '2026-10-01', endDate: '2026-10-01', rules: { watchlist: '' } });
  assert.ok(result.backtestId, 'backtest id returned');
  assert.ok(result.report && typeof result.report === 'object', 'report object');
  assert.ok(result.report.summary && typeof result.report.summary === 'object', 'report.summary');
  assert.equal(result.report.summary.startDate, '2026-10-01');
  assert.ok(Array.isArray(result.trades), 'trades array');
  const listed = f.service.getBacktests(1);
  assert.equal(listed.backtests.length, 1, 'one persisted backtest');
  assert.equal(listed.backtests[0].backtestId, result.backtestId);
  const one = f.service.getBacktest(1, result.backtestId);
  assert.deepEqual(one.trades, result.trades, 'trades round-trip through orb_backtest_trades');
  assert.equal(one.report.summary.endDate, '2026-10-01');
  let missing = null;
  try { f.service.getBacktest(1, 'does-not-exist'); } catch (e) { missing = e; }
  assert.ok(missing instanceof OrbError && missing.status === 404, 'unknown backtest id → 404');
});

// --- fixed watchlist (Johnny 2026-10-01) ----------------------------------------
test('setSettings stores a normalized watchlist', async () => {
  const { service } = fixture();
  await service.setSettings(1, { rules: { watchlist: ' aaa,AAA,, soun ' } });
  assert.equal(service.getSettings(1).rules.watchlist, 'AAA,SOUN', 'uppercased, deduped, comma-joined');
  await service.setSettings(1, { rules: { watchlist: '' } });
  assert.equal(service.getSettings(1).rules.watchlist, '', 'explicit clear survives');
});

test('watchlist scan skips the asset catalog and trades the list', async () => {
  const f = fixture();
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: 'AAA' } });
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 1, 'engineered AAA entry still fires on the watchlist');
  assert.equal(f.world.orderPosts[0].symbol, 'AAA');
  assert.ok(!f.world.calls.some(c => c.path === '/v2/assets'), 'no /v2/assets catalog call in watchlist mode');
});

test('price band is bypassed for watchlist symbols', async () => {
  const f = fixture();
  await connectPaper(f);
  // AAA's latest is $10.07 — above maxPrice 5, so the catalog path would drop it.
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: 'AAA', maxPrice: 5 } });
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 1, 'watchlist symbol trades despite the price band');
});

test('price band still applies when the watchlist is empty', async () => {
  const f = fixture();
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: '', maxPrice: 5 } });
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0, 'AAA ($10.07) is filtered by the price band on the catalog path');
  assert.ok(f.world.calls.some(c => c.path === '/v2/assets'), 'catalog IS consulted when watchlist is empty');
});

test('backtest uses the watchlist universe and bypasses the price band', async () => {
  const f = fixture();
  await connectPaper(f);
  const result = await f.service.backtest(1, {
    startDate: '2026-10-01', endDate: '2026-10-01', rules: { watchlist: 'AAA', maxPrice: 5 },
  });
  assert.ok(result.report && result.report.summary, 'report produced on the watchlist');
  assert.equal(result.report.summary.startDate, '2026-10-01');
  assert.ok(!f.world.calls.some(c => c.path === '/v2/assets'), 'no /v2/assets catalog call in watchlist backtest');
});

// --- mountOrb ---------------------------------------------------------------------
test('mountOrb registers all 13 routes', async () => {
  const { service } = fixture();
  const registered = [];
  const app = {
    get: (path, ...middleware) => registered.push(['GET', path]),
    post: (path, ...middleware) => registered.push(['POST', path]),
    put: (path, ...middleware) => registered.push(['PUT', path]),
  };
  const mounted = mountOrb({ app, service, requireAuth: (req, res, next) => next() });
  const expected = [
    ['GET', '/api/orb/status'],
    ['POST', '/api/orb/connect'],
    ['POST', '/api/orb/disconnect'],
    ['GET', '/api/orb/settings'],
    ['PUT', '/api/orb/settings'],
    ['GET', '/api/orb/dashboard'],
    ['GET', '/api/orb/positions'],
    ['GET', '/api/orb/trades'],
    ['GET', '/api/orb/alerts'],
    ['GET', '/api/orb/universe'],
    ['POST', '/api/orb/backtest'],
    ['GET', '/api/orb/backtests'],
    ['GET', '/api/orb/backtests/:id'],
  ];
  assert.equal(registered.length, 13, `expected 13 routes, got ${registered.length}`);
  for (const route of expected) {
    assert.ok(registered.some(r => r[0] === route[0] && r[1] === route[1]), `missing route ${route[0]} ${route[1]}`);
  }
  assert.equal(mounted.routes.length, 13);
  assert.throws(() => mountOrb({ app, service }), /requireAuth/);
});

// --- market universe (Johnny 2026-10-09: ORB opens to the full market) -------
test('universeMode defaults to market, round-trips, and rejects junk', async () => {
  const { service } = fixture();
  assert.equal(service.getSettings(1).rules.universeMode, 'market');
  assert.equal(DEFAULT_ORB_RULES.universeMode, 'market');
  await service.setSettings(1, { rules: { universeMode: 'watchlist' } });
  assert.equal(service.getSettings(1).rules.universeMode, 'watchlist');
  await assert.rejects(
    service.setSettings(1, { rules: { universeMode: 'everything' } }),
    /must be one of/);
});

test('universe migration persists market mode on stored rows, preserves a watchlist choice', async () => {
  const a = fixtureWithStoredRules({ minScore: 80 });
  const storedA = JSON.parse(a.db.prepare('SELECT rules FROM orb_settings WHERE user_id=1').get().rules);
  assert.equal(storedA.universeMode, 'market', 'the stored row itself flips to market');
  assert.equal(storedA.minScore, 80, 'unrelated rules preserved');
  assert.equal(a.service.getSettings(1).rules.universeMode, 'market');
  const b = fixtureWithStoredRules({ universeMode: 'watchlist' });
  const storedB = JSON.parse(b.db.prepare('SELECT rules FROM orb_settings WHERE user_id=1').get().rules);
  assert.equal(storedB.universeMode, 'watchlist', 'a deliberate watchlist choice is untouched');
});

test('mergeUniverseSymbols: watchlist first, deduped, capped, screener rows accepted', async () => {
  const { service } = fixture();
  const merge = service._mergeUniverseSymbols;
  assert.deepEqual(
    merge(['BBB', 'AAA'], ['AAA', 'CCC', { symbol: 'DDD' }, 'bbb']),
    ['BBB', 'AAA', 'CCC', 'DDD']);
  assert.deepEqual(merge(['BBB'], ['CCC', 'DDD'], 2), ['BBB', 'CCC'],
    'cap enforced — the watchlist wins the slots');
  const many = Array.from({ length: 250 }, (_, i) => `S${i}`);
  const capped = merge(['W1', 'W2'], many);
  assert.equal(capped.length, 200, 'default cap is 200');
  assert.deepEqual(capped.slice(0, 2), ['W1', 'W2'], 'watchlist always present at the front');
});

test('screener failure degrades to watchlist-only and the cycle still trades the watchlist', async () => {
  const f = fixture(); // no screener configured → the data API 500s on screener paths
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: 'AAA' } });
  await f.service._scanCycle(1);
  assert.ok(f.world.calls.some(c => c.path.includes('/v1beta1/screener/')), 'screener was attempted');
  const alertRow = f.db.prepare("SELECT * FROM orb_alerts WHERE kind='system' ORDER BY id DESC LIMIT 1").get();
  assert.ok(alertRow && /screener unavailable/i.test(alertRow.message), 'degradation is alerted');
  assert.equal(f.world.orderPosts.length, 1, 'watchlist entry still fires without the screener');
  assert.equal(f.world.orderPosts[0].symbol, 'AAA');
  const sched = f.db.prepare('SELECT scheduler_status FROM orb_settings WHERE user_id=1').get();
  assert.equal(sched.scheduler_status, 'ok', 'cycle completes healthy');
});

test('market mode: a two-break entry fires on a screener symbol that is not on the watchlist', async () => {
  const quote = { bp: 10.065, ap: 10.075, t: iso(NOW) };
  const latest = { c: 10.07, t: iso(NOW) };
  const f = fixture({
    screener: { actives: ['MKT'], gainers: ['GGG'], losers: ['LLL'] },
    dailyBySymbol: { MKT: dailyAAA(), GGG: dailyAAA(), LLL: dailyAAA() },
    minuteBySymbol: { MKT: minuteBarsAAA() },
    latestBySymbol: { MKT: latest, GGG: latest, LLL: latest },
    quoteBySymbol: { MKT: quote, GGG: quote, LLL: quote },
  });
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: 'ZZZ' } });
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 1, 'exactly one entry — the screener name');
  assert.equal(f.world.orderPosts[0].symbol, 'MKT');
  const positions = f.db.prepare('SELECT * FROM orb_positions').all();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].symbol, 'MKT');
  assert.equal(positions[0].status, 'open');
  const candidates = f.db.prepare('SELECT symbol FROM orb_candidates WHERE trade_date=?').all(TRADE_DATE).map(r => r.symbol);
  assert.ok(candidates.includes('MKT'), 'most-active scanned');
  assert.ok(candidates.includes('GGG'), 'gainer scanned');
  assert.ok(candidates.includes('LLL'), 'loser scanned — both mover directions join the universe');
  assert.ok(!candidates.includes('ZZZ'), 'watchlist name without data is filtered before evaluation');
});

test('screener universe is cached within the TTL — one fetch across two cycles', async () => {
  const f = fixture({ screener: { actives: ['MKT'], gainers: [], losers: [] } });
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: 'ZZZ' } });
  await f.service._scanCycle(1);
  await f.service._scanCycle(1);
  const screenerCalls = f.world.calls.filter(c => c.path.includes('/v1beta1/screener/'));
  assert.equal(screenerCalls.length, 2, 'most-actives + movers fetched once, then served from cache');
});

test('a timed-out screener GET is retried exactly once and recovers', async () => {
  const f = fixture({
    timeoutMs: 50,
    screener: {
      actives: ['MKT'], gainers: ['GGG'], losers: [],
      hangOnce: '/v1beta1/screener/stocks/most-actives',
    },
  });
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { watchlist: 'ZZZ' } });
  await f.service._scanCycle(1);
  const activesCalls = f.world.calls.filter(c => c.path === '/v1beta1/screener/stocks/most-actives');
  assert.equal(activesCalls.length, 2, 'one original attempt + exactly one retry');
  const alertRow = f.db.prepare(
    "SELECT * FROM orb_alerts WHERE kind='system' AND message LIKE '%screener unavailable%'").get();
  assert.equal(alertRow, undefined, 'retry recovered — no degradation alert');
});
