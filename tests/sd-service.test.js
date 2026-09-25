'use strict';

// Singles & Doubles service tests: mocked Alpaca fetch, in-memory SQLite,
// mock strategy. Mirrors the fixture style of tests/b2-service.test.js.
// B2 code is never imported and no b2_* table may be created or written.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { createSdService, mountSd } = require('../lib/sd-service');
const { createCredentialVault } = require('../lib/credential-vault');
const realStrategy = require('../lib/sd-strategy');

const TODAY = Date.parse('2026-09-14T15:00:00Z'); // Monday 11:00 ET: regular session
const iso = ms => new Date(ms).toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const GATE_ORDER = ['price_band', 'liquidity', 'spread', 'momentum', 'vwap', 'quality_score', 'risk'];

function eligibleEvaluation(symbol) {
  return {
    symbol, eligible: true, signal: 'BUY', setup: 'B', score: 9, maxScore: 12,
    effectiveMinScore: 7, sizeMultiplier: 1, stopPrice: 9.80,
    singleTarget: 10.30, doubleTarget: 10.61, riskPerShare: 0.60, entryPrice: 10.40,
    reasons: [`${symbol} eligible`],
    gates: GATE_ORDER.map(name => ({ name, passed: true, reason: `${name} ok` })),
    metrics: { rvol: 2.5 },
  };
}
function rejectedEvaluation(symbol, failedGate, reason) {
  return {
    symbol, eligible: false, signal: 'WAIT', setup: null, score: 3, maxScore: 12,
    effectiveMinScore: 7, sizeMultiplier: 1, stopPrice: null,
    singleTarget: null, doubleTarget: null, riskPerShare: null, entryPrice: 10.40,
    reasons: [reason],
    gates: GATE_ORDER.map(name => ({ name, passed: name !== failedGate, reason: name === failedGate ? reason : `${name} ok` })),
    metrics: { rvol: 1.0 },
  };
}

function fixture(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO users(id) VALUES (1),(2);');
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-123456789');
  const world = {
    time: TODAY, calls: [],
    assets: ['AAA', 'BBB'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true, name: `${symbol} Inc` })),
    accounts: new Map(), open: true,
    scenario: {}, thinSymbols: new Set(), defaultEvaluation: null,
    fillEntry: false, fillPrice: '10.40', positionPrice: '10.30',
    buyTimeout: false, entryQty: 10, exitFillPrice: '10.50', exitReject: false, cancelFails: false,
    seedOrders: new Map(),
  };
  function account(key) {
    if (!world.accounts.has(key)) world.accounts.set(key, { id: `account-${key}`, orders: new Map(), positions: [], sequence: 0 });
    return world.accounts.get(key);
  }
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value) });
  function snapshot(symbol) {
    const thin = world.thinSymbols.has(symbol);
    return {
      symbol,
      latestQuote: { ap: 10.40, bp: 10.39, as: 100, bs: 100, t: iso(world.time) },
      latestTrade: { p: 10.40, t: iso(world.time) },
      dailyBar: { t: iso(world.time), o: 10.0, h: 10.5, l: 9.9, c: 10.40, v: thin ? 1000 : 500000 },
      prevDailyBar: { t: iso(world.time - 86400000), o: 10.0, h: 10.2, l: 9.8, c: 10.00, v: 400000 },
    };
  }
  function spySnapshot() {
    return {
      symbol: 'SPY',
      latestQuote: { bp: 500, ap: 500.05, bs: 100, as: 100, t: iso(world.time) },
      latestTrade: { p: 501, t: iso(world.time) },
      dailyBar: { t: iso(world.time), c: 501, v: 1000000 },
      prevDailyBar: { t: iso(world.time - 86400000), c: 495, v: 900000 },
    };
  }
  function spyBars() {
    const bars = [];
    for (let i = 0; i < 30; i += 1) {
      const c = 500 + 0.01 * i; // 09:31-10:00 ET, VWAP ~500.15 < trade price 501
      bars.push({ t: iso(Date.parse('2026-09-14T13:31:00Z') + i * 60000), o: c - 0.05, h: c + 0.05, l: c - 0.05, c, v: 10000 });
    }
    return bars;
  }
  function seedOrder(id) {
    const seed = world.seedOrders.get(id);
    if (!seed) return null;
    const parent = { id: seed.orderId, symbol: seed.symbol, side: 'buy', type: 'limit', qty: '10',
      status: 'filled', filled_qty: '10', filled_avg_price: '10.00', order_class: 'oto',
      client_order_id: seed.clientId, time_in_force: 'gtc',
      legs: [{ id: seed.stopId, symbol: seed.symbol, side: 'sell', type: 'stop', qty: '10',
        filled_qty: '0', stop_price: '9.80', status: 'new', client_order_id: `${seed.clientId}-stop` }] };
    if (id === seed.stopId) return parent.legs[0];
    return parent;
  }
  async function fakeFetch(url, init) {
    const parsed = new URL(url);
    const key = init.headers['APCA-API-KEY-ID'];
    const state = account(key);
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { url, path: parsed.pathname, query: parsed.searchParams, method: init.method, body, key };
    world.calls.push(call);
    const path = parsed.pathname;
    const data = parsed.hostname === 'data.alpaca.markets';
    if (!data && path === '/v2/account') {
      return response({ id: state.id, status: 'ACTIVE', buying_power: '10000', equity: '10000',
        trading_blocked: false, account_blocked: false, trade_suspended_by_user: false });
    }
    if (!data && path === '/v2/clock') {
      return response({ is_open: world.open, timestamp: iso(world.time), next_close: '2026-09-14T20:00:00Z' });
    }
    if (!data && path === '/v2/assets') return response(world.assets);
    if (!data && path.startsWith('/v2/assets/')) {
      return response(world.assets.find(a => a.symbol === decodeURIComponent(path.split('/').at(-1))) || null);
    }
    if (!data && path === '/v2/positions') return response(state.positions);
    if (!data && path === '/v2/orders' && init.method === 'GET') {
      return response([...state.orders.values()].filter(o => !['filled', 'canceled', 'rejected', 'expired', 'replaced'].includes(o.status) && !o.child));
    }
    if (!data && path === '/v2/orders:by_client_order_id') {
      const wanted = parsed.searchParams.get('client_order_id');
      const order = [...state.orders.values()].find(o => o.client_order_id === wanted);
      if (order) return response(order);
      for (const seed of world.seedOrders.values()) {
        if (seed.clientId === wanted) return response(seedOrder(seed.orderId));
      }
      return response({}, 404);
    }
    if (!data && path === '/v2/orders' && init.method === 'POST') {
      if (body.side === 'buy') {
        if (world.buyTimeout) throw new Error('order timeout');
        const order = { ...body, id: `order-${++state.sequence}`, status: 'new', filled_qty: '0', filled_avg_price: null };
        const stop = { id: `stop-${state.sequence}`, symbol: body.symbol, side: 'sell', type: 'stop', qty: body.qty,
          filled_qty: '0', stop_price: body.stop_loss.stop_price, status: 'new', child: true,
          time_in_force: body.time_in_force, client_order_id: `child-${order.id}` };
        state.orders.set(stop.id, stop);
        order.legs = [stop];
        if (world.fillEntry) {
          order.filled_qty = body.qty; order.filled_avg_price = world.fillPrice; order.status = 'filled';
          state.positions.push({ symbol: body.symbol, qty: body.qty, current_price: world.positionPrice });
        }
        state.orders.set(order.id, order);
        return response(order);
      }
      if (body.type === 'market') {
        const order = { ...body, id: `order-${++state.sequence}`, status: world.exitReject ? 'rejected' : 'filled',
          filled_qty: world.exitReject ? '0' : body.qty, filled_avg_price: world.exitFillPrice };
        if (!world.exitReject) {
          state.positions = state.positions
            .map(p => p.symbol === body.symbol ? { ...p, qty: String(Number(p.qty) - Number(body.qty)) } : p)
            .filter(p => Number(p.qty) > 0);
        }
        state.orders.set(order.id, order);
        return response(order);
      }
      if (body.type === 'stop') {
        const order = { ...body, id: `order-${++state.sequence}`, status: 'new', filled_qty: '0', filled_avg_price: null };
        state.orders.set(order.id, order);
        return response(order);
      }
      throw new Error(`Unexpected mocked order body: ${init.method} ${url}`);
    }
    if (!data && path.startsWith('/v2/orders/')) {
      const id = decodeURIComponent(path.split('/').at(-1));
      const seed = seedOrder(id);
      const order = seed || state.orders.get(id);
      if (!order) return response({}, 404);
      if (init.method === 'DELETE') {
        if (world.cancelFails) throw new Error('cancel timeout');
        if (!seed) order.status = 'canceled';
        return response(null, 204);
      }
      if (order.legs && !seed) order.legs = order.legs.map(leg => state.orders.get(leg.id));
      return response(order);
    }
    if (data && path === '/v2/stocks/SPY/snapshot') return response(spySnapshot());
    if (data && path === '/v2/stocks/bars') {
      const symbols = parsed.searchParams.get('symbols').split(',');
      return response({ bars: Object.fromEntries(symbols.map(s => [s, s === 'SPY' ? spyBars() : []])), next_page_token: null });
    }
    if (data && path === '/v2/stocks/snapshots') {
      const symbols = parsed.searchParams.get('symbols').split(',');
      return response(Object.fromEntries(symbols.map(s => [s, snapshot(s)])));
    }
    if (data && /\/v2\/stocks\/.*\/snapshot$/.test(path)) {
      return response(snapshot(decodeURIComponent(path.split('/')[3])));
    }
    throw new Error(`Unexpected mocked broker call: ${init.method} ${url}`);
  }
  const strategy = {
    SD_RULES: realStrategy.SD_RULES,
    classifySpyRegime: realStrategy.classifySpyRegime,
    rankSdCandidates: (a, b) => String(a?.symbol || '').localeCompare(String(b?.symbol || '')),
    buildSdEntry: realStrategy.buildSdEntry,
    sizePosition: () => ({ qty: world.entryQty, riskAmount: 60, limitPrice: 10.40 }),
    evaluateSd: input => {
      const symbol = input?.snapshot?.symbol;
      if (symbol && world.scenario[symbol]) return world.scenario[symbol](input);
      if (world.defaultEvaluation) return world.defaultEvaluation(symbol || 'UNKNOWN', input);
      return rejectedEvaluation(symbol || 'UNKNOWN', 'vwap', 'No setup in the default scenario.');
    },
  };
  const settings = { db, vault, fetch: fakeFetch, now: () => world.time, strategy,
    batchSize: 40, timeoutMs: 50, persistenceReady: options.persistenceReady || (() => true), ...options };
  const service = createSdService(settings);
  service.start({ schedule: false });
  const connect = (uid = 1, key = 'paper1', mode = 'paper') =>
    service.setCredentials(uid, { apiKey: key, apiSecret: `secret-${key}`, mode });
  const buys = () => world.calls.filter(c => c.method === 'POST' && c.path === '/v2/orders' && c.body?.side === 'buy');
  const sells = () => world.calls.filter(c => c.method === 'POST' && c.path === '/v2/orders' && c.body?.side === 'sell');
  // Seed an open SD trade whose mock broker orders reconcile cleanly.
  const seedOpenTrade = (accountId, symbol, overrides = {}) => {
    const tag = `${symbol.toLowerCase()}-seed`;
    const seed = { symbol, clientId: `sd-seed-${tag}`, orderId: `seed-order-${tag}`, stopId: `seed-stop-${tag}` };
    world.seedOrders.set(seed.orderId, seed);
    world.seedOrders.set(seed.stopId, seed);
    const st = account('paper1');
    st.positions.push({ symbol, qty: '10', current_price: '10.10' });
    db.prepare(`INSERT INTO sd_trades(account_id,symbol,event_id,side,status,setup,quality_score,entry_price,
        filled_shares,stop_price,single_target,double_target,partial_taken,client_id,order_id,stop_id,
        protection,signal_date,created_at,updated_at)
      VALUES (?,?,?,'long','open','B',9,10.00,10,9.80,10.30,10.61,0,?,?,?,'protected',?,?,?)`)
      .run(accountId, symbol, `${symbol}:2026-09-14:SD`, seed.clientId, seed.orderId, seed.stopId,
        '2026-09-14', iso(world.time), iso(world.time));
    return seed;
  };
  return { db, vault, world, account, connect, buys, sells, settings, seedOpenTrade,
    get service() { return service; },
    close() { service.stop(); db.close(); } };
}

// ---------------------------------------------------------------------------
// Defaults, live gating, mode switching
// ---------------------------------------------------------------------------

test('SD defaults: new users start paused in paper mode', async () => {
  const f = fixture();
  try {
    const status = f.service.status(7);
    assert.equal(status.enabled, false);
    assert.equal(status.mode, 'paper');
    assert.ok(status.blockers.some(b => /paused/i.test(b)));
    const row = f.db.prepare('SELECT * FROM sd_settings WHERE user_id=7').get();
    assert.equal(row, undefined); // status() does not create rows
  } finally { f.close(); }
});

test('live automation cannot resume without explicit arming', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'live1', 'live');
    await assert.rejects(f.service.setAutomation(1, { action: 'resume' }),
      /Live automation requires fresh explicit authorization/);
    assert.equal(f.service.status(1).enabled, false);
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

test('setMode refuses while positions are open and always resets enabled', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    await f.service.setAutomation(1, { action: 'resume' });
    assert.equal(f.service.status(1).enabled, true);
    // An unresolved SD trade blocks the mode switch.
    f.db.prepare(`INSERT INTO sd_trades(account_id,symbol,event_id,status,client_id,signal_date)
      VALUES (?,?,?,?,?,?)`).run('account-paper1', 'AAA', 'AAA:2026-09-14:SD', 'open', 'sd-seed', '2026-09-14');
    await assert.rejects(f.service.setMode(1, { mode: 'live' }), /Resolve all Singles & Doubles orders and positions/);
    f.db.prepare("UPDATE sd_trades SET status='closed' WHERE account_id='account-paper1'").run();
    const switched = await f.service.setMode(1, { mode: 'paper' });
    assert.equal(switched.mode, 'paper');
    assert.equal(f.service.status(1).enabled, false); // never auto-enables
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Reservation idempotency
// ---------------------------------------------------------------------------

test('entry reservations are idempotent per event (INSERT OR IGNORE)', async () => {
  const f = fixture();
  try {
    const sql = `INSERT OR IGNORE INTO sd_trades
      (account_id,symbol,event_id,side,status,setup,quality_score,stop_price,single_target,double_target,
       client_id,signal_date,created_at,updated_at)
      VALUES (?,?,?,'long','submission_unknown','B',9,9.80,10.30,10.61,?,?,?,?)`;
    const args = ['acct-x', 'AAA', 'AAA:2026-09-14:SD', 'sd-dupe', '2026-09-14', iso(TODAY), iso(TODAY)];
    assert.equal(f.db.prepare(sql).run(...args).changes, 1);
    assert.equal(f.db.prepare(sql).run(...args).changes, 0); // duplicate ignored
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sd_trades WHERE account_id='acct-x'").get().n, 1);

    // End to end: two cycles with the same session produce one entry, one POST.
    await f.connect(1, 'paper1', 'paper');
    f.world.fillEntry = true;
    f.world.positionPrice = '10.20'; // below the single target: no partial on cycle 2
    f.world.scenario = { AAA: () => eligibleEvaluation('AAA'), BBB: () => rejectedEvaluation('BBB', 'vwap', 'No setup.') };
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sd_trades WHERE account_id='account-paper1'").get().n, 1);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Full entry cycle + P&L isolation
// ---------------------------------------------------------------------------

test('a full cycle scans, enters, and journals a protected OTO order', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    f.world.fillEntry = true;
    f.world.scenario = { AAA: () => eligibleEvaluation('AAA'), BBB: () => rejectedEvaluation('BBB', 'quality_score', 'Quality score 3/12 is below the minimum.') };
    await f.service.setAutomation(1, { action: 'resume' });
    const cycle = await f.service.runCycle(1);
    assert.equal(cycle.status, 'ok');

    const trades = f.db.prepare('SELECT * FROM sd_trades WHERE account_id=?').all('account-paper1');
    assert.equal(trades.length, 1);
    const trade = trades[0];
    assert.equal(trade.symbol, 'AAA');
    assert.equal(trade.status, 'open');
    assert.equal(trade.protection, 'protected');
    assert.equal(trade.filled_shares, 10);
    assert.equal(trade.entry_price, 10.40);
    assert.ok(trade.client_id.startsWith('sd-'));
    assert.ok(trade.order_id);
    assert.ok(trade.stop_id);

    assert.equal(f.buys().length, 1);
    const buy = f.buys()[0].body;
    assert.equal(buy.order_class, 'oto');
    assert.equal(buy.side, 'buy');
    assert.equal(buy.type, 'limit');
    assert.equal(buy.time_in_force, 'gtc');
    assert.equal(buy.stop_loss.stop_price, '9.80');
    assert.equal(buy.client_order_id, trade.client_id);

    // Read endpoints reflect the new position.
    assert.equal(f.service.trades(1).trades.length, 1);
    assert.equal(f.service.stats(1).openPositions, 1);

    // P&L isolation: the SD service creates and writes no b2_* tables.
    const b2Tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'b2_%'").all();
    assert.deepEqual(b2Tables, []);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Daily guards halt entries
// ---------------------------------------------------------------------------

test('daily loss guard halts entries', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    f.db.prepare(`INSERT INTO sd_trades(account_id,symbol,event_id,status,pnl,updated_at,created_at,client_id,signal_date)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('account-paper1', 'AAA', 'AAA:2026-09-14:SD', 'closed', -600, iso(TODAY), iso(TODAY), 'sd-x', '2026-09-14');
    f.world.scenario = { AAA: () => eligibleEvaluation('AAA') };
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    assert.equal(f.sells().length, 0);
  } finally { f.close(); }
});

test('max trades per day guard halts entries', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    const insert = f.db.prepare(`INSERT INTO sd_trades(account_id,symbol,event_id,status,created_at,client_id,signal_date)
      VALUES (?,?,?,?,?,?,?)`);
    for (let i = 0; i < 10; i += 1) {
      insert.run('account-paper1', `S${i}`, `S${i}:2026-09-14:SD`, 'rejected', iso(TODAY), `sd-${i}`, '2026-09-14');
    }
    f.world.scenario = { AAA: () => eligibleEvaluation('AAA') };
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

test('max open positions guard halts entries', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    f.seedOpenTrade('account-paper1', 'AAA');
    f.seedOpenTrade('account-paper1', 'BBB');
    f.seedOpenTrade('account-paper1', 'CCC');
    f.world.defaultEvaluation = symbol => eligibleEvaluation(symbol);
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    const mutating = f.world.calls.filter(c => ['POST', 'DELETE', 'PATCH'].includes(c.method) && c.path === '/v2/orders');
    assert.equal(mutating.length, 0);
    assert.equal(f.buys().length, 0);
    // The three seeded positions reconcile cleanly and stay protected.
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sd_trades WHERE protection='protected'").get().n, 3);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Scan funnel
// ---------------------------------------------------------------------------

test('scan writes funnel counters and per-gate rejections', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    f.world.scenario = {
      AAA: () => eligibleEvaluation('AAA'),
      BBB: () => rejectedEvaluation('BBB', 'quality_score', 'Quality score 3/12 is below the effective minimum of 7.'),
    };
    const scan = await f.service.scan(1);
    assert.equal(scan.ok, true);

    const run = f.db.prepare('SELECT * FROM sd_scan_runs WHERE run_id=?').get(scan.run_id);
    assert.equal(run.symbols_scanned, 2);
    assert.equal(run.liquidity_pass, 2);
    assert.equal(run.momentum_pass, 2);
    assert.equal(run.vwap_pass, 2);
    assert.equal(run.quality_score_pass, 1);
    assert.equal(run.risk_pass, 2);

    const rejections = f.db.prepare('SELECT * FROM sd_rejections WHERE run_id=?').all(scan.run_id);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].symbol, 'BBB');
    assert.equal(rejections[0].stage, 'quality_score');
    assert.match(rejections[0].reason, /Quality score/);

    const candidates = f.db.prepare('SELECT symbol,outcome,score FROM sd_candidates ORDER BY symbol').all();
    assert.deepEqual(candidates.map(c => [c.symbol, c.outcome]), [['AAA', 'eligible'], ['BBB', 'rejected']]);
    assert.equal(candidates[0].score, 9);

    const funnel = f.service.funnel();
    assert.equal(funnel.run.run_id, scan.run_id);
    assert.equal(funnel.topRejections.length, 1);
    assert.equal(funnel.topRejections[0].stage, 'quality_score');
  } finally { f.close(); }
});

test('shared liquidity screen withholds entries without touching strategy gates', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    f.world.thinSymbols.add('AAA'); // 1k shares: fails the shared liquidity policy
    f.world.scenario = { AAA: () => eligibleEvaluation('AAA'), BBB: () => rejectedEvaluation('BBB', 'vwap', 'No setup.') };
    await f.service.scan(1);
    const row = f.db.prepare('SELECT outcome,gates FROM sd_candidates WHERE symbol=?').get('AAA');
    assert.equal(row.outcome, 'rejected');
    const gates = JSON.parse(row.gates);
    const liquidityGate = gates.find(g => g.name === 'Shared liquidity policy');
    assert.ok(liquidityGate);
    assert.equal(liquidityGate.passed, false);
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Partial profit + stop discipline
// ---------------------------------------------------------------------------

test('partial profit sells half and tightens the stop to breakeven', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    f.world.fillEntry = true;
    f.world.positionPrice = '10.45'; // above the 10.30 single target, below the 10.61 double
    f.world.scenario = { AAA: () => eligibleEvaluation('AAA'), BBB: () => rejectedEvaluation('BBB', 'vwap', 'No setup.') };
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);

    const before = f.db.prepare("SELECT stop_price FROM sd_trades WHERE account_id='account-paper1'").get();
    assert.equal(before.stop_price, 9.80);

    await f.service.runCycle(1);
    const trade = f.db.prepare("SELECT * FROM sd_trades WHERE account_id='account-paper1'").get();
    assert.equal(trade.partial_taken, 1);
    assert.equal(trade.status, 'partial');
    assert.equal(trade.protection, 'protected');
    assert.ok(trade.stop_price >= before.stop_price, 'stop never widens');
    assert.equal(trade.stop_price, 10.40); // breakeven on the runner

    const marketSells = f.sells().filter(c => c.body?.type === 'market');
    assert.equal(marketSells.length, 1);
    assert.equal(marketSells[0].body.qty, '5'); // 50% of 10 shares
    assert.equal(marketSells[0].body.side, 'sell');

    const fills = f.db.prepare('SELECT * FROM sd_exit_fills WHERE trade_id=?').all(trade.id);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].fill_qty, 5);
    assert.equal(fills[0].fill_price, 10.50);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Order safety: ambiguous POST
// ---------------------------------------------------------------------------

test('ambiguous entry POST stays submission_unknown with no duplicate POST', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'paper1', 'paper');
    f.world.buyTimeout = true; // the POST throws; the broker never confirms
    f.world.scenario = { AAA: () => eligibleEvaluation('AAA'), BBB: () => rejectedEvaluation('BBB', 'vwap', 'No setup.') };
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);

    let trade = f.db.prepare("SELECT * FROM sd_trades WHERE account_id='account-paper1'").get();
    assert.ok(trade);
    assert.equal(trade.status, 'submission_unknown');
    assert.equal(f.buys().length, 1);

    await f.service.runCycle(1); // reconcile must not re-POST
    trade = f.db.prepare("SELECT * FROM sd_trades WHERE account_id='account-paper1'").get();
    assert.equal(trade.status, 'submission_unknown');
    assert.equal(f.buys().length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sd_trades WHERE account_id='account-paper1'").get().n, 1);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Route wiring
// ---------------------------------------------------------------------------

test('mountSd wires the ten SD API routes', async () => {
  const f = fixture();
  let mounted;
  try {
    const app = express();
    mounted = mountSd({ app, ...f.settings,
      requireAuth: (req, res, next) => next(),
      ensureSessionUserInTradingStore: async () => 1,
    });
    const stack = app.router?.stack || app._router?.stack || []; // Express 5: app.router
    const routes = [];
    for (const layer of stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) routes.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    }
    const expected = [
      ['GET', '/api/sd/status'], ['GET', '/api/sd/funnel'], ['GET', '/api/sd/trades'], ['GET', '/api/sd/stats'],
      ['POST', '/api/sd/scan'], ['PUT', '/api/sd/settings'], ['POST', '/api/sd/automation'],
      ['PUT', '/api/sd/credentials'], ['DELETE', '/api/sd/credentials'], ['POST', '/api/sd/mode'],
    ];
    for (const [method, path] of expected) {
      assert.ok(routes.some(r => r.method === method && r.path === path), `${method} ${path} is mounted`);
    }
    assert.equal(routes.filter(r => r.path.startsWith('/api/sd/')).length, 10);

    // Smoke-call the status handler through the mounted stack.
    const statusLayer = stack.find(l => l.route && l.route.path === '/api/sd/status');
    const handler = statusLayer.route.stack.at(-1).handle;
    let body; const res = { status(code) { this.code = code; return this; }, json(value) { body = value; } };
    await handler({ session: { userId: 1 } }, res);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'paper');
    mounted.stop();
  } finally { f.close(); }
});
