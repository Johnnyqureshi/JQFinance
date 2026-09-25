'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Database = require('better-sqlite3');
const { createB2Service, mountB2 } = require('../lib/b2-service');
const { createCredentialVault } = require('../lib/credential-vault');
const realStrategy = require('../lib/b2-strategy');

const TODAY = Date.parse('2026-09-14T15:00:00Z');
const LAST = '2026-09-11';
const clone = value => JSON.parse(JSON.stringify(value));
function dailyBars(end = LAST, count = 120) {
  const bars = [];
  let date = Date.parse(`${end}T04:00:00Z`);
  while (bars.length < count) {
    const day = new Date(date).getUTCDay();
    if (day !== 0 && day !== 6) bars.unshift({ t: new Date(date).toISOString(), o: 9, h: 11, l: 8, c: 10, v: 1000000 });
    date -= 86400000;
  }
  return bars;
}
function fixture(options = {}) {
  const db = options.db || new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO users(id) VALUES (1),(2);');
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-123456789');
  const world = {
    time: TODAY, calls: [], assets: ['AAA', 'BBB', 'ETF', 'INV', 'LEV'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    accounts: new Map(), latest: LAST, open: true, fail: null, before: null,
    acceptThenThrow: false, rejectThenThrow: false, heldPartial: false, fillEntry: false,
    cancelAmbiguous: false, rejectExit: false, stopReplacementUnknown: false,
    missingQuote: false, staleQuote: false, missingBars: false, paginate: false, pages: [],
    buyHttpReject: false, sellHttpReject: false, staleOpenOrders: false,
    weakStop: false, sipDenied: false, dataStatus: null, malformedProbe: false, timeoutProbe: false,
    customBars: null, customSnapshot: null, iexSnapshot: null, fillPrice: '9.50', nextClose: null,
    partialExit: false,
    restoreAcceptedThenThrow: false, hideRestores: false,
    bearishDates: new Set(), eligible: true,
  };
  function account(key) {
    if (!world.accounts.has(key)) world.accounts.set(key, { id: `account-${key}`, orders: new Map(), positions: [], sequence: 0 });
    return world.accounts.get(key);
  }
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value) });
  function snapshot() {
    if (world.customSnapshot) return clone(world.customSnapshot);
    return {
      symbol: 'AAA', eligible: world.eligible,
      latestQuote: world.missingQuote ? null : { ap: 10, bp: 9.99, as: 100, bs: 100, t: new Date(world.time - (world.staleQuote ? 120000 : 0)).toISOString() },
      latestTrade: { p: 10, t: new Date(world.time).toISOString() },
      dailyBar: { t: new Date(world.time).toISOString(), o: 9.8, h: 10.1, l: 9.7, c: 10, v: 1000000 },
      prevDailyBar: { t: new Date(world.time - 86400000).toISOString(), o: 9.7, h: 10, l: 9.6, c: 9.9, v: 1000000 },
    };
  }
  async function fakeFetch(url, init) {
    const parsed = new URL(url);
    const key = init.headers['APCA-API-KEY-ID'];
    const state = account(key);
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { url, path: parsed.pathname, query: parsed.searchParams, method: init.method, body, key };
    world.calls.push(call);
    if (world.before) await world.before(call);
    if (world.timeoutProbe && parsed.hostname === 'data.alpaca.markets' && parsed.pathname.includes('/snapshot') &&
        parsed.searchParams.get('feed') === 'sip') await new Promise(resolve => setTimeout(resolve, 100));
    if (world.fail?.(call)) throw new Error('UPSTREAM-CONTAINS-SECRET-MUST-NOT-LEAK');
    if (world.dataStatus && parsed.hostname === 'data.alpaca.markets' &&
        parsed.searchParams.get('feed') === world.dataStatus.feed) return response({}, world.dataStatus.status);
    if (world.sipDenied && parsed.hostname === 'data.alpaca.markets' && parsed.searchParams.get('feed') === 'sip') return response({}, 403);
    const path = parsed.pathname;
    if (path === '/v2/account') return response({ id: state.id, status: 'ACTIVE', buying_power: '10000' });
    if (path === '/v2/clock') return response({ is_open: world.clockOpen ?? world.open, timestamp: new Date(world.time + (world.clockOffset || 0)).toISOString(),
      next_close: world.nextClose || `${new Date(world.time).toISOString().slice(0, 10)}T20:00:00Z` });
    if (path === '/v2/calendar') {
      const sessions = dailyBars(world.latest, 120).map(b => ({ date: b.t.slice(0, 10), open: '09:30', close: '16:00' }));
      const current = new Date(world.time);
      const date = current.toISOString().slice(0, 10);
      if (![0, 6].includes(current.getUTCDay()) && date > world.latest) sessions.push({ date, open: '09:30', close: '16:00' });
      return response(world.calendar || sessions);
    }
    if (path === '/v2/assets') return response(world.assets);
    if (path.startsWith('/v2/assets/')) return response(world.assets.find(a => a.symbol === decodeURIComponent(path.split('/').at(-1))) || null);
    if (path === '/v2/positions') return response(state.positions);
    if (path === '/v2/stocks/bars') {
      const symbols = parsed.searchParams.get('symbols').split(',');
      const bars = Object.fromEntries(symbols.map(symbol => [symbol, world.missingBars ? [] : world.customBars || dailyBars(world.latest)]));
      if (world.paginate && symbols.length > 1) {
        const page = parsed.searchParams.get('page_token');
        world.pages.push(page);
        return response(page ? { bars: Object.fromEntries(Object.entries(bars).slice(1)), next_page_token: null } :
          { bars: { [symbols[0]]: bars[symbols[0]] }, next_page_token: 'second' });
      }
      return response({ bars, next_page_token: null });
    }
    if (path === '/v2/stocks/snapshots') return response(Object.fromEntries(parsed.searchParams.get('symbols').split(',').map(s => [s, snapshot()])));
    if (/\/v2\/stocks\/.*\/snapshot$/.test(path)) {
      if (world.malformedProbe && parsed.searchParams.get('feed') === 'sip') return response({});
      if (world.iexSnapshot && parsed.searchParams.get('feed') === 'iex') return response(clone(world.iexSnapshot));
      return response(snapshot());
    }
    if (path === '/v2/orders:by_client_order_id') {
      const order = [...state.orders.values()].find(o => o.client_order_id === parsed.searchParams.get('client_order_id'));
      if (world.hideRestores && order?.type === 'stop' && !order.child) return response({}, 404);
      return response(order || {}, order ? 200 : 404);
    }
    if (path === '/v2/orders' && init.method === 'GET') {
      if (world.staleOpenOrders) return response([]);
      return response([...state.orders.values()].filter(o => !['filled', 'canceled', 'rejected', 'expired', 'replaced'].includes(o.status) && !o.child));
    }
    if (path === '/v2/orders' && init.method === 'POST') {
      if (world.buyHttpReject && body.side === 'buy') return response({ message: 'do not leak secret' }, 422);
      if (world.sellHttpReject && body.type === 'market') return response({ message: 'do not leak secret' }, 422);
      if (world.rejectThenThrow && body.side === 'buy') throw new Error('uncertain POST');
      const order = {
        ...body, id: `order-${++state.sequence}`, status: 'new', filled_qty: '0', filled_avg_price: null,
      };
      if (body.side === 'buy') {
        const stop = { id: `stop-${state.sequence}`, symbol: body.symbol, side: 'sell', type: 'stop', qty: body.qty, filled_qty: '0',
          stop_price: world.weakStop ? '8.00' : body.stop_loss.stop_price, status: 'new', child: true, time_in_force: body.time_in_force };
        if (world.fillEntry || world.heldPartial) {
          order.filled_qty = world.heldPartial ? String(Number(body.qty) / 2) : body.qty;
          order.filled_avg_price = world.fillPrice;
          order.status = world.heldPartial ? 'partially_filled' : 'filled';
          state.positions.push({ symbol: body.symbol, qty: order.filled_qty });
          if (world.heldPartial) stop.status = 'held';
        }
        state.orders.set(stop.id, stop);
        order.legs = [stop];
      } else if (body.type === 'market') {
        if (world.rejectExit) order.status = 'rejected';
        else if (world.partialExit) {
          order.status = 'partially_filled'; order.filled_qty = String(Number(body.qty) * .4); order.filled_avg_price = '10.50';
          state.positions = state.positions.map(p => p.symbol === body.symbol ? { ...p, qty: String(Number(p.qty) - Number(order.filled_qty)) } : p);
        }
        else {
          order.status = 'filled'; order.filled_qty = body.qty; order.filled_avg_price = '10.50';
          state.positions = state.positions.filter(p => p.symbol !== body.symbol);
        }
      }
      state.orders.set(order.id, order);
      if (world.restoreAcceptedThenThrow && body.type === 'stop') throw new Error('restore accepted but response lost');
      if (world.acceptedDuplicate422) return response({ message: 'client_order_id already exists' }, 422);
      if (world.acceptThenThrow && body.side === 'buy') throw new Error('accepted but response lost');
      return response(order);
    }
    if (path.startsWith('/v2/orders/')) {
      const order = state.orders.get(decodeURIComponent(path.split('/').at(-1)));
      if (!order) return response({}, 404);
      if (init.method === 'DELETE') {
        if (world.cancelAmbiguous) throw new Error('cancel timeout');
        order.status = 'canceled';
        return response(null, 204);
      }
      if (init.method === 'PATCH') {
        if (world.stopReplacementUnknown) throw new Error('replace timeout');
        const replacement = { ...order, ...body, id: `replace-${++state.sequence}`, status: 'new' };
        order.status = 'replaced'; order.replaced_by = replacement.id;
        state.orders.set(replacement.id, replacement);
        return response(replacement);
      }
      if (order.legs) order.legs = order.legs.map(leg => state.orders.get(leg.id));
      return response(order);
    }
    throw new Error(`Unexpected mocked broker call: ${init.method} ${url}`);
  }
  const strategy = {
    B2_RULES: realStrategy.B2_RULES,
    rankB2Candidates: realStrategy.rankB2Candidates,
    buildB2Entry: realStrategy.buildB2Entry,
    sessionDate: realStrategy.sessionDate,
    evaluateB2({ bars, snapshot: snap, asset, expectedSessionDate }) {
      const bearish = world.bearishDates.has(expectedSessionDate);
      const eligible = !bearish && world.eligible && !!snap?.latestQuote && !world.staleQuote && bars.length >= 100 &&
        asset.tradable === true && asset.status === 'active';
      return { symbol: asset.symbol, eligible, signal: bearish ? 'EXIT' : eligible ? 'BUY' : 'WAIT',
        crossover: bearish ? 'BEARISH' : 'BULLISH', eventId: `${asset.symbol}:${expectedSessionDate}:${bearish ? 'BEARISH' : 'BULLISH'}`,
        signalDate: expectedSessionDate, reasons: [], gates: [], metrics: { fastMA: bars.length >= 65 ? 10 : null, relativeVolume: 3 } };
    },
  };
  const settings = { db, vault, fetch: fakeFetch, now: () => world.time, strategy, batchSize: 2, timeoutMs: 50,
    persistenceReady: options.persistenceReady || (() => true), ...options };
  let service = createB2Service(settings);
  service.start({ schedule: false });
  const connect = (uid = 1, key = 'paper1', mode = 'paper', authorizeLive) => service.setCredentials(uid, { apiKey: key, apiSecret: `secret-${key}`, mode, authorizeLive });
  const buys = () => world.calls.filter(c => c.method === 'POST' && c.body?.side === 'buy');
  const sells = () => world.calls.filter(c => c.method === 'POST' && c.body?.side === 'sell');
  return { db, vault, world, account, connect, buys, sells, settings, get service() { return service; },
    restart() { service.stop(); service = createB2Service(settings); service.start({ schedule: false }); },
    close() { service.stop(); db.close(); } };
}

test('automated entries fail closed when durable PostgreSQL persistence is unavailable', async () => {
  const f = fixture({ persistenceReady: () => false });
  try {
    await assert.rejects(f.connect(), /persistence is unavailable/);
    assert.equal(f.world.calls.length, 0);
    assert.equal(f.service.status(1).entryReadyNow, false);
    assert.match(f.service.status(1).blockers.join(' '), /PostgreSQL schema is unavailable/);
  } finally { f.close(); }
});

test('scheduler lifecycle is idempotent and drain waits for an active tick', async () => {
  const f = fixture();
  let release;
  try {
    assert.deepEqual(f.service.lifecycleStatus(), { running: true, ticking: false, scheduled: false });
    await f.connect();
    const blocked = new Promise(resolve => { release = resolve; });
    let tickStarted = false;
    f.world.before = async call => {
      if (call.path === '/v2/account' && !tickStarted) {
        tickStarted = true;
        await blocked;
      }
    };
    const tick = f.service.tick();
    while (!tickStarted) await new Promise(resolve => setImmediate(resolve));
    let drained = false;
    const drain = f.service.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    release();
    await Promise.all([tick, drain]);
    release = null;
    assert.deepEqual(f.service.lifecycleStatus(), { running: false, ticking: false, scheduled: false });
  } finally { release?.(); f.close(); }
});

test('dedicated encrypted credentials stay paused until explicitly started, without credential disclosure or ownership leakage', async () => {
  const f = fixture();
  try {
    const state = await f.connect();
    assert.equal(state.connected, true);
    assert.equal(state.enabled, false, 'connecting keys must not auto-enable automation');
    assert.equal(state.liveArmed, false);
    const stored = f.db.prepare('SELECT * FROM b2_credentials').get();
    assert(stored.api_key.startsWith('enc:v1:'));
    assert(stored.api_secret.startsWith('enc:v1:'));
    assert.equal(JSON.stringify(state).includes('secret-paper1'), false);
    await assert.rejects(f.connect(2, 'paper1'), /already assigned/);
    f.account('manual').id = 'manual-account';
    f.db.prepare("INSERT INTO broker_account_owners(account_id,user_id,scope,mode) VALUES ('manual-account',1,'manual','paper')").run();
    await assert.rejects(f.connect(2, 'manual'), /already assigned/);
    assert.equal(f.service.status(2).connected, false);
    assert.deepEqual(f.service.trades(2), { trades: [] });
  } finally { f.close(); }
});

test('legacy B2 plaintext credentials migrate before broker use and disconnect clears them', async () => {
  const f = fixture();
  const legacyKey = 'legacy-paper-api-key';
  const legacySecret = 'legacy-paper-api-secret';
  try {
    f.db.prepare(`INSERT INTO b2_credentials(user_id,mode,account_id,api_key,api_secret)
      VALUES (1,'paper','legacy-account',?,?)`).run(legacyKey, legacySecret);
    f.db.prepare(`INSERT INTO broker_account_owners(account_id,user_id,scope,mode)
      VALUES ('legacy-account',1,'b2','paper')`).run();

    const status = f.service.status(1);
    assert.equal(status.connected, true);
    assert.equal(status.accountId, 'legacy-account');
    assert.equal(JSON.stringify(status).includes(legacyKey), false);
    assert.equal(JSON.stringify(status).includes(legacySecret), false);

    const stored = f.db.prepare('SELECT api_key,api_secret FROM b2_credentials WHERE user_id=1 AND mode=?').get('paper');
    assert(stored.api_key.startsWith('enc:v1:'));
    assert(stored.api_secret.startsWith('enc:v1:'));
    assert.notEqual(stored.api_key, legacyKey);
    assert.notEqual(stored.api_secret, legacySecret);

    await f.service.scan(1);
    assert.equal(f.world.calls[0].key, legacyKey);
    await f.service.disconnect(1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM b2_credentials WHERE user_id=1').get().count, 0);
    assert.equal(f.service.status(1).connected, false);
  } finally { f.close(); }
});

test('broker failures do not write credential material to operational logs', async () => {
  const f = fixture();
  const secret = 'secret-that-must-never-be-logged';
  const originalWarn = console.warn;
  const originalError = console.error;
  let output = '';
  console.warn = (...args) => { output += args.join(' '); };
  console.error = (...args) => { output += args.join(' '); };
  try {
    await f.connect(1, 'paper-log-key', 'paper');
    f.world.fail = () => { throw new Error(`upstream echoed ${secret}`); };
    await assert.rejects(f.service.scan(1), /Broker connection or response failed/);
    assert.equal(output.includes(secret), false);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    f.close();
  }
});

test('shared liquidity blocks entries without current session volume but never suppresses EXIT', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.world.customSnapshot = {
      symbol: 'AAA',
      latestQuote: {
        ap: 10, bp: 9.99, as: 100, bs: 100,
        t: new Date(f.world.time).toISOString(),
      },
      latestTrade: { p: 10, t: new Date(f.world.time).toISOString() },
      prevDailyBar: { c: 9.9, v: 1000000 },
      // Deliberately no dailyBar: completed historical volume is not a
      // substitute for current-session liquidity evidence.
    };
    let scan = await f.service.scan(1);
    assert(scan.candidates.every(candidate => candidate.signal === 'WAIT'));
    assert(scan.candidates.every(candidate =>
      candidate.liquidity?.codes?.includes('SHARE_VOLUME_UNAVAILABLE')));
    assert.equal(f.buys().length, 0);

    f.world.bearishDates.add(LAST);
    scan = await f.service.scan(1);
    const exits = scan.candidates.filter(candidate => candidate.crossover === 'BEARISH');
    assert.equal(exits.length, 2);
    assert(exits.every(candidate => candidate.signal === 'EXIT'));
    assert(exits.every(candidate => candidate.liquidity?.eligible === false));
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

test('scheduler records a blocked cycle when its selected broker account is missing', async () => {
  const f = fixture();
  try {
    const result = await f.service.runCycle(1);
    assert.deepEqual(result.status, 'blocked');
    const status = f.service.status(1);
    assert.equal(status.scheduler.status, 'blocked');
    assert.match(status.scheduler.reason, /dedicated B2 broker account is connected/);
    assert.equal(status.entryReadyNow, false);
    assert.equal(status.readiness.connected, false);
  } finally { f.close(); }
});

test('scan failures leave bounded per-symbol error outcomes and fail closed', async () => {
  const f = fixture();
  try {
    await f.connect();
    await f.service.scan(1);
    f.world.fail = () => { throw new Error('upstream failure'); };
    await assert.rejects(f.service.scan(1), /Broker connection or response failed/);
    const failed = f.service.candidates(1).candidates.filter(candidate => candidate.outcome === 'error');
    assert.equal(failed.length, 2, JSON.stringify(f.service.candidates(1).candidates));
    assert(failed.every(candidate => candidate.eligible === false && candidate.signal === 'WAIT'));
    assert(failed.every(candidate => candidate.reasonCode === 'broker_error'));
    assert(failed.every(candidate => candidate.reasons[0].includes('withheld')));
    assert.equal(f.service.status(1).dataFeed, 'sip');
  } finally { f.close(); }
});

test('quarantine rejects connection and blocks existing authorization', async () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO broker_account_quarantine(account_id,reason) VALUES ('account-paper1','test conflict')").run();
    await assert.rejects(f.connect(), /quarantined/);
    f.db.prepare("UPDATE broker_account_quarantine SET resolved_at='resolved'").run();
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    f.db.prepare('UPDATE broker_account_quarantine SET resolved_at=NULL').run();
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    assert(f.service.status(1).blockers.some(b => b.includes('quarantined')));
  } finally { f.close(); }
});

test('Paper stays paused until explicitly started; Live needs fresh explicit authorization; read-only scan never places orders', async () => {
  const f = fixture();
  try {
    await f.connect();
    assert.equal(f.service.status(1).enabled, false, 'connecting paper keys must not auto-enable automation');
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0, 'paused automation must not place paper orders');
    await f.service.scan(1);
    assert.equal(f.buys().length, 0);
    await f.service.setAutomation(1, { action: 'resume' });
    assert.equal(f.service.status(1).enabled, true, 'explicit resume must enable paper automation');
    await f.connect(1, 'live1', 'live');
    await assert.rejects(f.service.setAutomation(1, { action: 'resume' }), /fresh explicit/);
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    await f.service.setAutomation(1, { action: 'resume', authorizeLive: true });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 2);
    assert(f.buys().every(c => c.url.startsWith('https://api.alpaca.markets/')));
  } finally { f.close(); }
});

test('full catalog rotation survives restart and multi-symbol pagination is exhausted', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.world.paginate = true;
    await f.service.scan(1);
    assert.deepEqual(f.world.pages, [null, 'second']);
    assert.equal(f.service.status(1).coverage.cursor, 2);
    f.restart();
    await f.service.scan(1);
    await f.service.scan(1);
    const { candidates, coverage } = f.service.candidates(1);
    assert.equal(coverage.total, 5);
    assert.equal(coverage.scanned, 5);
    assert.deepEqual(candidates.map(c => c.symbol).sort(), ['AAA', 'BBB', 'ETF', 'INV', 'LEV']);
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

test('curated leveraged and inverse ETFs are evaluated every scan cycle', async () => {
  const f = fixture({ batchSize: 2,
    strategy: { ...momentumStrategy({}), LEVERAGED_ETF_SYMBOLS: realStrategy.LEVERAGED_ETF_SYMBOLS } });
  try {
    await f.connect();
    // The catalog holds only regular stocks; the curated ETF list is injected by the service.
    f.world.assets = ['AAA', 'BBB'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true }));
    await f.service.scan(1);
    const symbols = f.service.candidates(1).candidates.map(c => c.symbol);
    for (const etf of realStrategy.LEVERAGED_ETF_SYMBOLS) {
      assert(symbols.includes(etf), `expected curated ETF ${etf} to be scanned`);
    }
    await f.service.scan(1);
    const second = lastScannedSymbols(f);
    for (const etf of realStrategy.LEVERAGED_ETF_SYMBOLS) {
      assert(second.includes(etf), `expected ${etf} to be re-scanned on the second cycle`);
    }
    // The curated list is additive: rotation still advances through the universe.
    assert.equal(f.service.status(1).coverage.cursor, 0);
  } finally { f.close(); }
});

test('rotation skips recently-seen expensive stocks and spends budget on cheaper names', async () => {
  const f = fixture({ batchSize: 1, strategy: momentumStrategy({}) });
  f.settings.strategy.evaluateB2 = ({ bars, asset, expectedSessionDate }) => ({
    symbol: asset.symbol, eligible: false, signal: 'WAIT', crossover: null, eventId: null,
    signalDate: expectedSessionDate, reasons: [], gates: [],
    metrics: { price: asset.symbol === 'AAA' ? 50 : 10, relativeVolume: 3 },
  });
  try {
    await f.connect();
    f.world.assets = ['AAA', 'BBB'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true }));
    await f.service.scan(1); // learns AAA is expensive
    await f.service.scan(1); // completes the first pass on BBB
    f.world.calls.length = 0;
    await f.service.scan(1); // new pass: AAA is skipped, BBB takes the budget
    const symbols = f.world.calls.filter(c => c.path === '/v2/stocks/bars')
      .flatMap(c => c.query.get('symbols').split(','));
    assert(!symbols.includes('AAA'), 'expensive AAA must be skipped while its reading is fresh');
    assert(symbols.includes('BBB'), 'cheap BBB must take the rotation budget');
    const coverage = f.service.candidates(1).coverage;
    assert.equal(coverage.total, 2);
    assert.equal(coverage.scanned, 2);
    assert.equal(coverage.cursor, 0);
  } finally { f.close(); }
});

test('stale expensive readings are re-checked after the recheck window', async () => {
  const f = fixture({ batchSize: 1, strategy: momentumStrategy({}) });
  f.settings.strategy.evaluateB2 = ({ bars, asset, expectedSessionDate }) => ({
    symbol: asset.symbol, eligible: false, signal: 'WAIT', crossover: null, eventId: null,
    signalDate: expectedSessionDate, reasons: [], gates: [],
    metrics: { price: asset.symbol === 'AAA' ? 50 : 10, relativeVolume: 3 },
  });
  try {
    await f.connect();
    f.world.assets = ['AAA', 'BBB'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true }));
    await f.service.scan(1); // learns AAA is expensive
    await f.service.scan(1); // completes the first pass on BBB
    f.world.time += 8 * 86400000; // past the 7-day recheck window
    f.world.calls.length = 0;
    await f.service.scan(1); // AAA's reading is stale, so it is examined again
    const symbols = f.world.calls.filter(c => c.path === '/v2/stocks/bars')
      .flatMap(c => c.query.get('symbols').split(','));
    assert(symbols.includes('AAA'), 'stale expensive AAA must be re-checked after the window');
  } finally { f.close(); }
});

test('a full universe pass covers every symbol once and resets cleanly', async () => {
  const f = fixture({ batchSize: 1, strategy: momentumStrategy({}) });
  f.settings.strategy.evaluateB2 = ({ bars, asset, expectedSessionDate }) => ({
    symbol: asset.symbol, eligible: false, signal: 'WAIT', crossover: null, eventId: null,
    signalDate: expectedSessionDate, reasons: [], gates: [],
    metrics: { price: asset.symbol === 'BBB' ? 60 : 10, relativeVolume: 3 },
  });
  try {
    await f.connect();
    f.world.assets = ['AAA', 'BBB', 'CCC'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true }));
    await f.service.scan(1);
    assert.equal(f.service.status(1).coverage.cursor, 1);
    await f.service.scan(1);
    assert.equal(f.service.status(1).coverage.cursor, 2);
    await f.service.scan(1);
    const coverage = f.service.candidates(1).coverage;
    assert.equal(coverage.total, 3);
    assert.equal(coverage.scanned, 3);
    assert.equal(coverage.cursor, 0);
    assert.deepEqual(f.service.candidates(1).candidates.map(c => c.symbol).sort(), ['AAA', 'BBB', 'CCC']);
  } finally { f.close(); }
});

test('entry is LIMIT GTC OTO with broker-held 5% stop and portfolio cap two', async () => {
  const f = fixture();
  try {
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.setSettings(1, { maxPositionDollars: 250 });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 2);
    for (const { body } of f.buys()) {
      assert.equal(body.order_class, 'oto');
      assert.equal(body.type, 'limit');
      assert.equal(body.time_in_force, 'gtc');
      assert.equal(body.qty, '25');
      assert.equal(body.stop_loss.stop_price, '9.50');
      assert(body.client_order_id.startsWith('b2-'));
    }
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 2);
    await assert.rejects(f.service.disconnect(1), /Resolve/);
    await assert.rejects(f.service.setMode(1, { mode: 'live' }), /Resolve/);
    await assert.rejects(f.connect(), /Resolve/);
  } finally { f.close(); }
});

test('accepted ambiguous POST resolves by deterministic client ID, never duplicated after restart', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.acceptThenThrow = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
    assert.equal(f.service.trades(1).trades[0].status, 'pending');
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
    assert(f.world.calls.some(c => c.path === '/v2/orders:by_client_order_id'));
  } finally { f.close(); }
});

test('unresolved POST is reserved durably, blocks more entries and connection abandonment', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.world.rejectThenThrow = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
    assert.equal(f.service.status(1).ready, false);
    assert(f.service.alerts(1).alerts.some(a => a.type === 'protection'));
    await assert.rejects(f.service.disconnect(1), /Resolve/);
  } finally { f.close(); }
});

test('price-improved fills retain tighter original OTO stop without unsupported replacement', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    const trade = f.service.trades(1).trades[0];
    assert.equal(trade.entryPrice, 9.5);
    assert.equal(trade.stopPrice, 9.5);
    assert.equal(trade.status, 'open');
    assert.equal(trade.pnl, null);
    assert.equal(f.world.calls.filter(c => c.method === 'PATCH').length, 0);
    assert.equal(f.world.calls.filter(c => c.method === 'DELETE').length, 0);
  } finally { f.close(); }
});

test('partial OTO fills held without protection cancel remainder, settle child and restore stop', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.heldPartial = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    const trade = f.service.trades(1).trades[0];
    assert.equal(trade.filledShares, 50);
    assert.equal(f.sells().length, 1);
    assert.equal(f.sells()[0].body.type, 'stop');
    assert.equal(f.sells()[0].body.qty, '50');
    assert.equal(f.sells()[0].body.stop_price, '9.03');
    assert.equal(trade.status, 'open');
    assert.equal(f.db.prepare('SELECT protection FROM b2_trades').get().protection, 'protected');
  } finally { f.close(); }
});

test('OTO stop requiring unsupported tightening is retained, flagged and blocks later entries', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.world.fillEntry = true;
    f.world.weakStop = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
    assert.equal(f.world.calls.filter(c => c.method === 'DELETE').length, 0);
    assert.equal(f.world.calls.filter(c => c.method === 'PATCH').length, 0);
    assert.equal(f.service.status(1).ready, false);
  } finally { f.close(); }
});

test('paused owned long exits missed bearish session despite failed entry gates and missing snapshots', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.fillEntry = true;
    f.world.assets = f.world.assets.slice(0, 1);
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    await f.service.setAutomation(1, { action: 'pause' });
    f.world.time = Date.parse('2026-09-17T15:00:00Z');
    f.world.latest = '2026-09-16';
    f.world.bearishDates.add('2026-09-15'); // Not the latest completed candle.
    f.world.eligible = false;
    f.world.fail = call => call.path.includes('snapshot');
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    const trade = f.service.trades(1).trades[0];
    assert.equal(trade.status, 'closed');
    assert.equal(trade.exitPrice, 10.5);
    assert.equal(trade.pnl, 100);
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
  } finally { f.close(); }
});

test('ambiguous protective cancel never sends sell; rejected close restores broker stop', async () => {
  for (const ambiguous of [true, false]) {
    const f = fixture({ batchSize: 1 });
    try {
      await f.connect();
      f.world.fillEntry = true;
      f.world.assets = f.world.assets.slice(0, 1);
      await f.service.setAutomation(1, { action: 'resume' });
      await f.service.runCycle(1);
      f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
      f.world.bearishDates.add(f.world.latest);
      f.world.cancelAmbiguous = ambiguous;
      f.world.rejectExit = !ambiguous;
      await f.service.runCycle(1);
      if (ambiguous) {
        assert.equal(f.sells().length, 0);
        assert.equal(f.service.status(1).ready, false);
      } else {
        assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
        assert.equal(f.sells().filter(c => c.body.type === 'stop').length, 1);
        assert.equal(f.service.trades(1).trades[0].status, 'exit_retry');
        await f.service.runCycle(1);
        assert.equal(f.sells().length, 2, 'Rejected close and restored stop must not repeat');
      }
    } finally { f.close(); }
  }
});

test('market closed reconciles but never enters; stale/missing market data and API failures withhold orders', async () => {
  for (const scenario of ['closed', 'quote', 'stale', 'bars', 'api']) {
    const f = fixture();
    try {
      await f.connect();
      await f.service.setAutomation(1, { action: 'resume' });
      if (scenario === 'closed') f.world.open = false;
      if (scenario === 'quote') f.world.missingQuote = true;
      if (scenario === 'stale') f.world.staleQuote = true;
      if (scenario === 'bars') f.world.missingBars = true;
      if (scenario === 'api') f.world.fail = c => c.path === '/v2/assets';
      await f.service.runCycle(1);
      assert.equal(f.buys().length, 0, scenario);
      assert(!JSON.stringify(f.service.alerts(1)).includes('UPSTREAM-CONTAINS-SECRET'));
    } finally { f.close(); }
  }
});

test('unrelated broker positions count toward cap and are never canceled or sold', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.account('paper1').positions = [{ symbol: 'EXTERNAL', qty: '10' }, { symbol: 'OTHER', qty: '10' }];
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    assert.equal(f.sells().length, 0);
    assert.equal(f.world.calls.filter(c => c.method === 'DELETE').length, 0);
    await assert.rejects(f.service.disconnect(1), /positions or orders/);
  } finally { f.close(); }
});

test('durable lease serializes mutations and final authorization observes stop/revision changes after awaits', async () => {
  for (const change of ['stop', 'revision', 'lease']) {
    const f = fixture({ batchSize: 1 });
    try {
      await f.connect();
      await f.service.setAutomation(1, { action: 'resume' });
      let changed = false;
      f.world.before = async call => {
        if (!changed && /\/v2\/stocks\/.*\/snapshot$/.test(call.path)) {
          changed = true;
          await assert.rejects(f.service.setSettings(1, { maxPositionDollars: 500 }), /reconciling/);
          if (change === 'stop') f.service.stop();
          if (change === 'revision') f.db.prepare('UPDATE b2_settings SET revision=revision+1,enabled=0').run();
          if (change === 'lease') f.db.prepare('UPDATE b2_leases SET expires_at=0').run();
        }
      };
      await f.service.runCycle(1);
      assert(changed);
      assert.equal(f.buys().length, 0, change);
    } finally { f.close(); }
  }
});

test('credential and mode changes reset live arm; only position dollar strategy setting is editable', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'live1', 'live');
    await f.service.setAutomation(1, { action: 'resume', authorizeLive: true });
    await f.connect(1, 'live2', 'live');
    assert.equal(f.service.status(1).liveArmed, false);
    assert.equal(f.service.status(1).enabled, false);
    await f.service.setAutomation(1, { action: 'resume', authorizeLive: true });
    await f.service.setMode(1, { mode: 'paper' });
    assert.equal(f.service.status(1).liveArmed, false);
    await assert.rejects(f.service.setSettings(1, { fastMA: 5 }), /Only maximum/);
    await assert.rejects(f.service.setSettings(1, { maxPositionDollars: NaN }), /Maximum/);
    await assert.rejects(f.service.setSettings(1, { enabled: 'true' }), /Only maximum/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM broker_account_owners WHERE account_id='account-live1'").get().count, 0);
  } finally { f.close(); }
});

test('all mounted API routes require auth; identity synchronization precedes FK writes', async () => {
  const f = fixture();
  try {
    const routes = [];
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, auth, handler) => routes.push({ method, path, auth, handler })]));
    const auth = () => {};
    let synced = 0;
    const service = mountB2({ app, ...f.settings, requireAuth: auth,
      ensureSessionUserInTradingStore: async () => { synced++; f.db.prepare('INSERT OR IGNORE INTO users(id) VALUES (3)').run(); return 3; } });
    assert.equal(routes.length, 10);
    assert(routes.every(r => r.auth === auth && r.path.startsWith('/api/b2/')));
    assert(routes.some(r => r.method === 'post' && r.path === '/api/b2/automation'));
    assert(routes.some(r => r.method === 'post' && r.path === '/api/b2/mode'));
    const route = routes.find(r => r.path.endsWith('/settings'));
    let result;
    const res = { status(code) { this.code = code; return this; }, json(value) { result = value; } };
    await route.handler({ session: { userId: 3 }, body: { maxPositionDollars: 500 } }, res);
    assert.equal(synced, 1);
    assert.equal(result.maxPositionDollars, 500);
    assert.equal(f.db.prepare('SELECT user_id FROM b2_settings WHERE user_id=3').get().user_id, 3);
    service.stop();
  } finally { f.close(); }
});

test('API rejects unauthenticated access, invalid identities and legacy settings activation fields', async () => {
  const f = fixture();
  let service;
  try {
    const routes = [];
    let synced = 0;
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method,
      (path, auth, handler) => routes.push({ method, path, auth, handler })]));
    const requireAuth = (req, res, next) => req.session?.userId ? next() : res.status(401).json({ error: 'Authentication required.' });
    service = mountB2({ app, ...f.settings, requireAuth,
      ensureSessionUserInTradingStore: async req => { synced++; return Number(req.session?.userId); } });
    const invoke = async (route, body, session) => {
      const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
      await route.auth({ body, session }, res, () => route.handler({ body, session }, res));
      return res;
    };
    for (const route of routes) assert.equal((await invoke(route, {})).code, 401, route.path);
    assert.equal(synced, 0);
    assert.equal(f.world.calls.length, 0);
    const settingsRoute = routes.find(route => route.path.endsWith('/settings'));
    const settingsBefore = f.db.prepare('SELECT * FROM b2_settings').all();
    for (const field of ['enabled', 'liveArmed', 'authorizeLive', 'mode', 'fastMA', 'watchlist', 'stopPercent']) {
      const result = await invoke(settingsRoute, { maxPositionDollars: 500, [field]: true }, { userId: 1 });
      assert.equal(result.code, 400, field);
      assert.match(result.body.error, /Only maximum/);
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM b2_settings').all(), settingsBefore);
    for (const body of [null, [], '500', { maxPositionDollars: null }, { maxPositionDollars: '500' },
      { maxPositionDollars: 0 }, { maxPositionDollars: Infinity }, { maxPositionDollars: 100000001 }]) {
      assert.equal((await invoke(settingsRoute, body, { userId: 1 })).code, 400);
    }
    const statusRoute = routes.find(route => route.path.endsWith('/status'));
    assert.equal((await invoke(statusRoute, {}, { userId: 'not-an-id' })).code, 401);
    const result = await invoke(settingsRoute, { maxPositionDollars: 500 }, { userId: 1 });
    assert.equal(result.code, 200);
    assert.equal(result.body.maxPositionDollars, 500);
    assert.equal(result.body.enabled, false);
    const connectRoute = routes.find(route => route.method === 'put' && route.path.endsWith('/credentials'));
    const connected = await invoke(connectRoute, { mode: 'paper', apiKey: 'paper1', apiSecret: 'secret-paper1' }, { userId: 1 });
    assert.equal(connected.code, 200);
    assert.equal(connected.body.enabled, false, 'connecting keys must not auto-enable automation');
    const automationRoute = routes.find(route => route.path.endsWith('/automation'));
    assert.equal((await invoke(automationRoute, { action: 'pause' }, { userId: 1 })).body.enabled, false);
    assert.equal((await invoke(automationRoute, { action: 'resume' }, { userId: 1 })).body.enabled, true);
    const live = await invoke(connectRoute, { mode: 'live', apiKey: 'live1', apiSecret: 'secret-live1', authorizeLive: true }, { userId: 1 });
    assert.equal(live.body.liveArmed, false);
    const modeRoute = routes.find(route => route.path.endsWith('/mode'));
    const unarmed = await invoke(modeRoute, { mode: 'live' }, { userId: 1 });
    assert.equal(unarmed.code, 200);
    assert.equal(unarmed.body.enabled, false);
    assert.equal((await invoke(automationRoute, { action: 'resume' }, { userId: 1 })).code, 400);
    assert.equal((await invoke(automationRoute, { action: 'resume', authorizeLive: true }, { userId: 1 })).body.liveArmed, true);
  } finally { service?.stop(); f.close(); }
});

test('saved connection map is secret-free and mode selection freshly authorizes only selected identity', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.service.status(1).connections, {
      paper: { connected: false, accountId: null }, live: { connected: false, accountId: null },
    });
    await f.connect();
    await f.connect(1, 'live1', 'live', true);
    assert.equal(f.service.status(1).liveArmed, false);
    await f.service.setAutomation(1, { action: 'resume', authorizeLive: true });
    assert.equal(f.service.status(1).liveArmed, true);
    const connections = {
      paper: { connected: true, accountId: 'account-paper1' },
      live: { connected: true, accountId: 'account-live1' },
    };
    assert.deepEqual(f.service.status(1).connections, connections);
    assert(!JSON.stringify(f.service.status(1)).includes('secret-live1'));
    await f.service.setMode(1, { mode: 'paper' });
    assert.equal(f.service.status(1).enabled, false, 'switching modes must not auto-enable automation');
    assert.equal(f.service.status(1).liveArmed, false);
    await f.service.setMode(1, { mode: 'live' });
    assert.equal(f.service.status(1).enabled, false);
    assert.equal(f.service.status(1).liveArmed, false);
    await f.service.setMode(1, { mode: 'live', authorizeLive: true });
    assert.equal(f.service.status(1).enabled, false);
    assert.equal(f.service.status(1).liveArmed, false);
    await f.service.setAutomation(1, { action: 'resume', authorizeLive: true });
    assert.equal(f.service.status(1).enabled, true);
    assert.equal(f.service.status(1).liveArmed, true);
    await f.service.setMode(1, { mode: 'live' });
    assert.equal(f.service.status(1).enabled, false, 'Same-mode selection must not inherit the prior arm');
    await f.service.setAutomation(1, { action: 'resume', authorizeLive: true });
    await f.service.setAutomation(1, { action: 'pause' });
    await assert.rejects(f.service.setAutomation(1, { action: 'resume' }), /fresh explicit/);
    assert.equal(f.service.status(1).liveArmed, false);
    await f.connect(1, 'live2', 'live', true);
    assert.equal(f.service.status(1).accountId, 'account-live2');
    assert.equal(f.service.status(1).liveArmed, false);
    await f.connect(1, 'live3', 'live');
    assert.equal(f.service.status(1).enabled, false);
    assert.equal(f.service.status(1).liveArmed, false);
    f.account('live3').id = 'changed-identity';
    await assert.rejects(f.service.setAutomation(1, { action: 'resume', authorizeLive: true }), /identity/);
    await assert.rejects(f.service.setMode(1, { mode: 'live', authorizeLive: true }), /identity/);
    assert.equal(f.service.status(1).enabled, false);
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

test('authorization input must be an actual boolean and malformed activation never calls broker', async () => {
  const f = fixture();
  try {
    for (const authorizeLive of ['true', 1, null, {}]) {
      await assert.rejects(f.connect(1, 'live1', 'live', authorizeLive), /boolean/);
      await assert.rejects(f.service.setMode(1, { mode: 'live', authorizeLive }), /boolean/);
      await assert.rejects(f.service.setAutomation(1, { action: 'resume', authorizeLive }), /boolean/);
    }
    for (const input of [null, [], {}, { action: 'enable' }, { action: 'resume', enabled: true }]) {
      await assert.rejects(f.service.setAutomation(1, input), error => error.status === 400);
    }
    await assert.rejects(f.service.setCredentials(1, { mode: 'paper', apiKey: '', apiSecret: 'test' }), error => error.status === 400);
    await assert.rejects(f.service.setMode(1, { mode: 'Paper' }), error => error.status === 400);
    assert.equal(f.world.calls.length, 0);
    assert.equal(f.service.status(1).enabled, false);
  } finally { f.close(); }
});

test('pause bypasses cycle lease and blocks an in-flight unsubmitted entry', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    const revision = f.db.prepare('SELECT revision FROM b2_settings WHERE user_id=1').get().revision;
    let paused = false;
    f.world.before = async call => {
      if (!paused && /\/v2\/stocks\/.*\/snapshot$/.test(call.path)) {
        paused = true;
        const state = await f.service.setAutomation(1, { action: 'pause' });
        assert.equal(state.enabled, false);
        assert.equal(state.liveArmed, false);
        assert.equal(f.db.prepare('SELECT revision FROM b2_settings WHERE user_id=1').get().revision, revision);
      }
    };
    await f.service.runCycle(1);
    assert(paused);
    assert.equal(f.buys().length, 0);
    assert.equal(f.service.status(1).enabled, false);
  } finally { f.close(); }
});

test('pause during confirmed stop cancellation does not invalidate residual protective restoration', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    f.world.fillEntry = true;
    await f.service.runCycle(1);
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    f.world.bearishDates.add(f.world.latest);
    f.world.rejectExit = true;
    let paused = false;
    const revision = f.db.prepare('SELECT revision FROM b2_settings WHERE user_id=1').get().revision;
    f.world.before = async call => {
      if (!paused && call.method === 'DELETE' && call.path.startsWith('/v2/orders/stop-')) {
        paused = true;
        await f.service.setAutomation(1, { action: 'pause' });
      }
    };
    await f.service.runCycle(1);
    assert(paused);
    assert.equal(f.service.status(1).enabled, false);
    assert.equal(f.db.prepare('SELECT revision FROM b2_settings WHERE user_id=1').get().revision, revision);
    assert.equal(f.buys().length, 1);
    assert(f.sells().some(call => call.body.type === 'stop' && call.body.time_in_force === 'gtc'));
    assert.equal(f.db.prepare('SELECT protection FROM b2_trades').get().protection, 'protected');
  } finally { f.close(); }
});

test('pause revokes pending connection and resume authorizations without blocking protective context revision', async () => {
  for (const action of ['connection', 'resume', 'mode']) {
    const f = fixture();
    try {
      await f.connect(1, 'live1', 'live');
      let paused = false;
      f.world.before = async call => {
        if (!paused && call.path === '/v2/account') {
          paused = true;
          await f.service.setAutomation(1, { action: 'pause' });
        }
      };
      const pending = action === 'connection' ? f.connect(1, 'live2', 'live', true) :
        action === 'mode' ? f.service.setMode(1, { mode: 'live', authorizeLive: true }) :
          f.service.setAutomation(1, { action: 'resume', authorizeLive: true });
      await assert.rejects(pending, /activation withheld/);
      assert(paused);
      assert.equal(f.service.status(1).enabled, false);
      assert.equal(f.service.status(1).liveArmed, false);
      assert.equal(f.service.status(1).accountId, 'account-live1');
    } finally { f.close(); }
  }
});

test('persisted automation survives database reopen without activating dormant connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'b2-restart-'));
  const file = join(directory, 'trading.sqlite');
  let f;
  try {
    f = fixture({ db: new Database(file) });
    await f.connect(1, 'active-paper');
    await f.service.setAutomation(1, { action: 'resume' });
    await f.connect(2, 'dormant-paper');
    f.db.prepare('INSERT INTO users(id) VALUES (3),(4)').run();
    await f.connect(3, 'active-live', 'live', true);
    await f.service.setAutomation(3, { action: 'resume', authorizeLive: true });
    await f.connect(4, 'dormant-live', 'live');
    // Simulate a preexisting dormant connection, not an explicit new connect.
    f.db.prepare('UPDATE b2_settings SET enabled=0,live_armed=0 WHERE user_id=2').run();
    f.close();
    f = fixture({ db: new Database(file) });
    assert.equal(f.service.status(1).enabled, true);
    assert.equal(f.service.status(2).enabled, false);
    assert.equal(f.service.status(3).enabled, true);
    assert.equal(f.service.status(3).liveArmed, true);
    assert.equal(f.service.status(4).enabled, false);
    assert.equal(f.service.status(4).liveArmed, false);
    await f.service.tick();
    assert.equal(f.buys().filter(call => call.key === 'active-paper').length, 2);
    assert.equal(f.buys().filter(call => call.key === 'dormant-paper').length, 0);
    assert.equal(f.buys().filter(call => call.key === 'active-live').length, 2);
    assert.equal(f.buys().filter(call => call.key === 'dormant-live').length, 0);
    await f.service.setAutomation(1, { action: 'pause' });
    f.close();
    f = fixture({ db: new Database(file) });
    assert.equal(f.service.status(1).enabled, false);
    assert.equal(f.service.status(2).enabled, false);
    assert.equal(f.service.trades(1).trades.length, 2);
  } finally { if (f?.db.open) f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('marketOpen reflects only a valid fresh broker clock and resets across connection changes', async () => {
  const f = fixture();
  try {
    await f.connect();
    assert.equal(f.service.status(1).marketOpen, null);
    f.world.open = false;
    await f.service.runCycle(1);
    assert.equal(f.service.status(1).marketOpen, false);
    f.world.time += 120001;
    assert.equal(f.service.status(1).marketOpen, null);
    f.world.open = true;
    await f.service.scan(1);
    assert.equal(f.service.status(1).marketOpen, true);
    for (const clockOffset of [-120001, 5001]) {
      f.world.clockOffset = clockOffset;
      await assert.rejects(f.service.scan(1), /clock/);
      assert.equal(f.service.status(1).marketOpen, null);
    }
    f.world.clockOffset = 0;
    f.world.clockOpen = 'true';
    await assert.rejects(f.service.scan(1), /clock/);
    assert.equal(f.service.status(1).marketOpen, null);
    delete f.world.clockOpen;
    await f.service.scan(1);
    f.world.fail = call => call.path === '/v2/clock';
    await assert.rejects(f.service.scan(1), /connection/);
    assert.equal(f.service.status(1).marketOpen, null);
    f.world.fail = null;
    await f.service.scan(1);
    await f.connect(1, 'live1', 'live');
    assert.equal(f.service.status(1).marketOpen, null);
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

test('bounded fair scheduler progresses other accounts while one broker request is slow', async () => {
  const f = fixture({ timeoutMs: 2000, batchSize: 1 });
  let release;
  try {
    f.db.prepare('INSERT INTO users(id) VALUES (3),(4)').run();
    for (let uid = 1; uid <= 4; uid++) await f.connect(uid, `paper${uid}`);
    for (let uid = 1; uid <= 4; uid++) await f.service.setAutomation(uid, { action: 'resume' });
    const blocked = new Promise(resolve => { release = resolve; });
    let slowStarted = false;
    const concurrent = new Set();
    let peak = 0;
    f.world.before = async call => {
      if (call.path === '/v2/account') {
        concurrent.add(call.key);
        peak = Math.max(peak, concurrent.size);
        if (call.key === 'paper1' && !slowStarted) {
          slowStarted = true;
          await blocked;
        }
      }
      if (call.path === '/v2/clock') concurrent.delete(call.key);
    };
    const tick = f.service.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert(slowStarted);
    assert(f.buys().some(call => call.key === 'paper2'));
    assert(f.buys().some(call => call.key === 'paper4'), 'Released workers must advance to later accounts');
    assert.equal(f.buys().filter(call => call.key === 'paper1').length, 0);
    assert(peak <= 3);
    await assert.rejects(f.service.runCycle(1), /reconciling/);
    await f.service.tick();
    release();
    await tick;
    assert.equal(f.buys().filter(call => call.key === 'paper1').length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM b2_leases').get().count, 0);
  } finally { release?.(); f.close(); }
});

test('catalog membership changes reset honest progress and retain leveraged, inverse and hyphenated equities', async () => {
  const f = fixture();
  try {
    await f.connect();
    await f.service.scan(1);
    await f.service.scan(1);
    assert.equal(f.service.status(1).coverage.scanned, 4);
    f.world.assets.push({ symbol: 'BRK-B', class: 'us_equity', status: 'active', tradable: true });
    f.world.assets.push(clone(f.world.assets[0])); // Duplicate upstream row must not inflate coverage.
    f.world.assets.push({ symbol: 'CRYPTO', class: 'crypto', status: 'active', tradable: true });
    f.world.assets.push({ symbol: 'INACTIVE', class: 'us_equity', status: 'inactive', tradable: true });
    f.db.prepare('UPDATE b2_coverage SET catalog_at=0').run();
    await f.service.scan(1);
    const coverage = f.service.status(1).coverage;
    assert.equal(coverage.scanned, 2);
    assert.equal(coverage.total, 6);
    assert.equal(coverage.minimumPassCycles, 3);
    await f.service.scan(1);
    await f.service.scan(1);
    assert.deepEqual(f.service.candidates(1).candidates.map(candidate => candidate.symbol).sort(), ['AAA', 'BBB', 'BRK-B', 'ETF', 'INV', 'LEV']);
    const calls = f.world.calls.filter(call => call.path === '/v2/assets');
    assert(calls.every(call => call.query.get('status') === 'active' && call.query.get('asset_class') === 'us_equity'));
  } finally { f.close(); }
});

test('service rejects a regressed DAY entry builder before reserving or submitting orders', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    f.settings.strategy.buildB2Entry = input => ({ ...realStrategy.buildB2Entry(input), time_in_force: 'day' });
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    assert.equal(f.service.trades(1).trades.length, 0);
    assert.match(f.service.status(1).scheduler.reason, /GTC protected entry/);
  } finally { f.close(); }
});

test('calendar evidence rejects missing internal daily sessions with the real evaluator', async () => {
  const f = fixture({ batchSize: 1, strategy: realStrategy });
  try {
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    f.world.assets = f.world.assets.slice(0, 1);
    const bars = dailyBars(LAST, 120).map((bar, index) => {
      const c = index < 85 ? 10 : index < 105 ? 8 : 8 + 2.67 * (index - 105) / 14;
      return { ...bar, o: c * .99, h: c * 1.01, l: c * .98, c, v: 300000 };
    });
    const price = bars.at(-1).c * 1.11;
    f.world.customSnapshot = {
      latestTrade: { p: price, t: new Date(f.world.time).toISOString() },
      latestQuote: { bp: price - .01, ap: price + .01, bs: 100, as: 100, t: new Date(f.world.time).toISOString() },
      dailyBar: { t: '2026-09-14T04:00:00Z', v: 900000 },
      prevDailyBar: { t: `${LAST}T04:00:00Z`, c: bars.at(-1).c },
    };
    f.world.customBars = bars.filter((_, index) => index !== 110);
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    const candidate = f.service.candidates(1).candidates[0];
    assert.equal(candidate.eligible, false);
    assert.match(candidate.reasons.join(' '), /session|calendar/i);
    f.world.customBars = bars;
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1, 'Restored complete evidence permits the legitimate setup');
    const calendar = f.world.calls.find(call => call.path === '/v2/calendar');
    assert(Date.parse(calendar.query.get('start')) <= TODAY - 300 * 86400000);
  } finally { f.close(); }
});

test('calendar failure preserves protection and long-held replay extends both history requests', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    f.world.fillEntry = true;
    await f.service.runCycle(1);
    await f.service.setAutomation(1, { action: 'pause' });
    f.db.prepare("UPDATE b2_trades SET last_exit_session='2024-01-02'").run();
    const priorCalls = f.world.calls.length;
    await f.service.runCycle(1);
    const newCalls = f.world.calls.slice(priorCalls);
    const calendar = newCalls.find(call => call.path === '/v2/calendar');
    const bars = newCalls.find(call => call.path === '/v2/stocks/bars');
    const oldestRequired = Date.parse('2024-01-02T00:00:00Z') - 300 * 86400000;
    assert(Date.parse(calendar.query.get('start')) <= oldestRequired);
    assert(Date.parse(bars.query.get('start')) <= oldestRequired);
    f.world.calendar = dailyBars(LAST, 10).map(bar => ({ date: bar.t.slice(0, 10), open: '09:30', close: '16:00' }));
    await f.service.runCycle(1);
    assert.match(f.service.status(1).scheduler.reason, /calendar/);
    assert.equal(f.db.prepare('SELECT protection FROM b2_trades').get().protection, 'protected');
    assert.equal(f.buys().length, 1);
  } finally { f.close(); }
});

test('durable pending parent reservations enforce cap even if broker open-orders list lags', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.world.staleOpenOrders = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    await f.service.runCycle(1);
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 2);
  } finally { f.close(); }
});

test('broker 422 entry rejection is terminal and consumed signal is not retried', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.buyHttpReject = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.service.trades(1).trades[0].status, 'rejected');
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
    assert(!JSON.stringify(f.service.alerts(1)).includes('do not leak secret'));
    await f.service.disconnect(1);
    assert.equal(f.service.status(1).connected, false);
  } finally { f.close(); }
});

test('definitive HTTP rejection restores protection without resubmitting close during cooldown', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    f.world.bearishDates.add(f.world.latest);
    f.world.sellHttpReject = true;
    await f.service.runCycle(1);
    assert.equal(f.service.trades(1).trades[0].status, 'exit_retry');
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    assert.equal(f.sells().filter(c => c.body.type === 'stop').length, 1);
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.sells().length, 2);
  } finally { f.close(); }
});

test('restart after confirmed stop cancel resumes durable close intent instead of stranding a long', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    const record = f.db.prepare('SELECT * FROM b2_trades').get();
    f.account('paper1').orders.get(record.stop_id).status = 'canceled';
    f.db.prepare("UPDATE b2_trades SET exit_requested=1,protection='unknown'").run();
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    assert.equal(f.service.trades(1).trades[0].status, 'closed');
  } finally { f.close(); }
});

test('bounded broker calls abort without exposing secrets or allowing an order', async () => {
  const f = fixture({ timeoutMs: 5 });
  try {
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    f.world.before = async call => {
      if (call.path === '/v2/assets') await new Promise(resolve => setTimeout(resolve, 20));
    };
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    assert(f.service.alerts(1).alerts.some(a => /timed out/.test(a.message)));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

test('final quote/snapshot validation can reject a previously ranked setup', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    let checked = false;
    f.world.before = async call => {
      if (/\/v2\/stocks\/.*\/snapshot$/.test(call.path)) { checked = true; f.world.missingQuote = true; }
    };
    await f.service.runCycle(1);
    assert(checked);
    assert.equal(f.buys().length, 0);
  } finally { f.close(); }
});

test('paused market-closed service continues actual stop-fill reconciliation with authentic P&L', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    const record = f.db.prepare('SELECT * FROM b2_trades').get();
    const state = f.account('paper1');
    const stop = state.orders.get(record.stop_id);
    stop.status = 'filled'; stop.filled_qty = '100'; stop.filled_avg_price = '8.99';
    state.positions = [];
    await f.service.setAutomation(1, { action: 'pause' });
    f.world.open = false;
    await f.service.runCycle(1);
    const trade = f.service.trades(1).trades[0];
    assert.equal(trade.status, 'closed');
    assert.equal(trade.exitPrice, 8.99);
    assert.equal(Math.round(trade.pnl), -51);
    assert.equal(f.sells().length, 0);
  } finally { f.close(); }
});

test('GTC unfilled entries expire on market close or signal-session rollover, filled stops survive', async () => {
  for (const filled of [false, true]) {
    const f = fixture({ batchSize: 1 });
    try {
      await f.connect();
      f.world.assets = f.world.assets.slice(0, 1);
      f.world.fillEntry = filled;
      await f.service.setAutomation(1, { action: 'resume' });
      await f.service.runCycle(1);
      f.world.open = false;
      await f.service.runCycle(1);
      const trade = f.service.trades(1).trades[0];
      assert.equal(trade.status, filled ? 'open' : 'canceled');
      assert.equal(f.world.calls.filter(c => c.method === 'DELETE').length, filled ? 0 : 2);
      if (filled) {
        const stored = f.db.prepare('SELECT * FROM b2_trades').get();
        assert.equal(f.account('paper1').orders.get(stored.stop_id).time_in_force, 'gtc');
      }
    } finally { f.close(); }
  }
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    await f.service.setAutomation(1, { action: 'pause' });
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    await f.service.runCycle(1);
    assert.equal(f.service.trades(1).trades[0].status, 'canceled');
  } finally { f.close(); }
});

test('candidate freshness expires and coverage resets on each new complete-universe pass', async () => {
  const f = fixture();
  try {
    await f.connect();
    await f.service.scan(1); await f.service.scan(1); await f.service.scan(1);
    assert.equal(f.service.candidates(1).coverage.scanned, 5);
    const candidate = f.service.candidates(1).candidates[0];
    assert(candidate.eligible && candidate.evaluatedAt);
    f.world.time += 121000;
    assert(f.service.candidates(1).candidates.every(c => !c.eligible && c.signal === 'WAIT' && c.evaluatedAt));
    await f.service.scan(1);
    assert.equal(f.service.candidates(1).coverage.scanned, 2);
  } finally { f.close(); }
});

test('Paper SIP entitlement failure selects IEX and proceeds without mixing feeds', async () => {
  const f = fixture();
  try {
    await f.connect();
    await f.service.setAutomation(1, { action: 'resume' });
    f.world.sipDenied = true;
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 2);
    assert.equal(f.service.status(1).dataFeed, 'iex');
    const strategyCalls = f.world.calls.filter(c => c.url.includes('data.alpaca') && c.query.has('feed'));
    assert(strategyCalls.some(c => c.query.get('feed') === 'sip'));
    assert(strategyCalls.filter(c => c.query.get('feed') !== 'sip').every(c => c.query.get('feed') === 'iex'));
    await f.service.scan(1);
    assert(f.world.calls.filter(c => c.url.includes('data.alpaca') && c.query.has('feed')).slice(-4)
      .every(c => c.query.get('feed') === 'iex'));
  } finally { f.close(); }
});

test('Live SIP 403 blocks strategy data and never probes IEX', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'live1', 'live', true);
    f.world.dataStatus = { feed: 'sip', status: 403 };
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    assert.equal(f.service.status(1).dataFeed, 'sip');
    assert(f.world.calls.filter(c => c.url.includes('data.alpaca')).every(c => c.query.get('feed') !== 'iex'));
  } finally { f.close(); }
});

test('Paper non-entitlement SIP failures and malformed probes remain fail-closed', async () => {
  for (const setup of [
    world => { world.dataStatus = { feed: 'sip', status: 401 }; },
    world => { world.dataStatus = { feed: 'sip', status: 422 }; },
    world => { world.timeoutProbe = true; },
    world => { world.malformedProbe = true; },
  ]) {
    const f = fixture();
    try {
      await f.connect();
      setup(f.world);
      await f.service.runCycle(1);
      assert.equal(f.buys().length, 0);
      assert.equal(f.service.status(1).dataFeed, 'sip');
      assert(f.world.calls.filter(c => c.url.includes('data.alpaca')).every(c => c.query.get('feed') !== 'iex'));
    } finally { f.close(); }
  }
});

test('Paper 403 persists IEX only after a valid IEX probe', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.world.sipDenied = true;
    f.world.dataStatus = { feed: 'iex', status: 403 };
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    assert.equal(f.service.status(1).dataFeed, 'sip');
    assert(f.world.calls.some(c => c.query.get('feed') === 'iex'));
  } finally { f.close(); }
});

test('Reconnect resets a cached IEX selection and retries SIP entitlement', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.world.sipDenied = true;
    await f.service.scan(1);
    assert.equal(f.service.status(1).dataFeed, 'iex');
    f.world.sipDenied = false;
    await f.connect(1, 'paper1', 'paper');
    assert.equal(f.service.status(1).dataFeed, 'sip');
    const before = f.world.calls.length;
    await f.service.runCycle(1);
    assert(f.world.calls.slice(before).some(c => c.query.get('feed') === 'sip'));
  } finally { f.close(); }
});

test('Restarted Live mode discards stale persisted IEX and remains SIP-only', async () => {
  const f = fixture();
  try {
    await f.connect(1, 'live1', 'live', true);
    f.db.prepare("UPDATE b2_settings SET data_feed='iex' WHERE user_id=1").run();
    f.restart();
    f.world.dataStatus = { feed: 'sip', status: 403 };
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 0);
    assert.equal(f.service.status(1).dataFeed, 'sip');
    assert(f.world.calls.filter(c => c.url.includes('data.alpaca')).every(c => c.query.get('feed') !== 'iex'));
  } finally { f.close(); }
});

test('IEX probe rejects empty, crossed, undersized, stale, future and invalid quotes', async () => {
  const now = new Date(TODAY).toISOString();
  const cases = [
    {},
    { bp: 0, ap: 10, bs: 100, as: 100, t: now },
    { bp: 10, ap: 9, bs: 100, as: 100, t: now },
    { bp: 9, ap: 10, bs: 0, as: 100, t: now },
    { bp: 9, ap: 10, bs: 100, as: 100, t: new Date(TODAY - 61000).toISOString() },
    { bp: 9, ap: 10, bs: 100, as: 100, t: new Date(TODAY + 1000).toISOString() },
    { bp: 9, ap: 10, bs: 100, as: 100, t: 'not-a-time' },
  ];
  for (const quote of cases) {
    const f = fixture();
    try {
      await f.connect();
      f.world.sipDenied = true;
      f.world.iexSnapshot = { latestQuote: quote };
      await f.service.runCycle(1);
      assert.equal(f.buys().length, 0);
      assert.equal(f.service.status(1).dataFeed, 'sip');
    } finally { f.close(); }
  }
});

test('final portfolio and clock refresh observe changes after historical data awaits', async () => {
  for (const mutation of ['capacity', 'closed', 'account']) {
    const f = fixture({ batchSize: 1 });
    try {
      await f.connect();
      await f.service.setAutomation(1, { action: 'resume' });
      let snapshotSeen = false;
      f.world.before = async call => {
        if (/\/v2\/stocks\/.*\/snapshot$/.test(call.path)) snapshotSeen = true;
        if (snapshotSeen && call.path === '/v2/stocks/bars') {
          if (mutation === 'capacity') f.account('paper1').positions = [{ symbol: 'OTHER', qty: '1' }, { symbol: 'EXTERNAL', qty: '1' }];
          if (mutation === 'closed') f.world.open = false;
          if (mutation === 'account') f.account('paper1').id = 'unexpected-account';
        }
      };
      await f.service.runCycle(1);
      assert(snapshotSeen);
      assert.equal(f.buys().length, 0, mutation);
    } finally { f.close(); }
  }
});

test('HTTP 422 duplicate-client response resolves accepted entry before declaring rejection', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.acceptedDuplicate422 = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.service.trades(1).trades[0].status, 'pending');
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
  } finally { f.close(); }
});

test('restored partial-fill stop receives a new durable generation after later failed bearish close', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.heldPartial = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    const firstRestore = f.sells()[0].body.client_order_id;
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    f.world.bearishDates.add(f.world.latest);
    f.world.rejectExit = true;
    await f.service.runCycle(1);
    const stops = f.sells().filter(c => c.body.type === 'stop');
    assert.equal(stops.length, 2);
    assert.notEqual(stops[1].body.client_order_id, firstRestore);
    assert.equal(f.db.prepare('SELECT protection FROM b2_trades').get().protection, 'protected');
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'stop').length, 2);
  } finally { f.close(); }
});

test('expired GTC protection is restored repeatedly using unique durable generations', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    await f.service.setAutomation(1, { action: 'pause' });
    for (let i = 0; i < 2; i++) {
      const trade = f.db.prepare('SELECT * FROM b2_trades').get();
      f.account('paper1').orders.get(trade.stop_id).status = 'expired';
      await f.service.runCycle(1);
      assert.equal(f.db.prepare('SELECT protection FROM b2_trades').get().protection, 'protected');
    }
    const stops = f.sells().filter(c => c.body.type === 'stop');
    assert.equal(stops.length, 2);
    assert.notEqual(stops[0].body.client_order_id, stops[1].body.client_order_id);
  } finally { f.close(); }
});

test('failed position read after confirmed stop removal restores protection before returning', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    f.world.bearishDates.add(f.world.latest);
    let canceled = false;
    let failed = false;
    f.world.before = async call => { if (call.method === 'DELETE') canceled = true; };
    f.world.fail = call => {
      if (canceled && !failed && call.path === '/v2/positions') { failed = true; return true; }
      return false;
    };
    await f.service.runCycle(1);
    assert(failed);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 0);
    assert.equal(f.sells().filter(c => c.body.type === 'stop').length, 1);
    assert.equal(f.db.prepare('SELECT protection FROM b2_trades').get().protection, 'protected');
  } finally { f.close(); }
});

test('definitive bearish close rejection retries using a fresh durable generation after cooldown', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    f.world.bearishDates.add(f.world.latest); f.world.rejectExit = true;
    await f.service.runCycle(1);
    assert.equal(f.service.trades(1).trades[0].status, 'exit_retry');
    const firstId = f.sells().find(c => c.body.type === 'market').body.client_order_id;
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM b2_close_attempts').get().count, 1);
    f.restart();
    f.world.rejectExit = false;
    f.world.time += 61000;
    await f.service.runCycle(1);
    const attempts = f.sells().filter(c => c.body.type === 'market');
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[1].body.client_order_id, firstId);
    assert.equal(f.service.trades(1).trades[0].status, 'closed');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM b2_close_attempts').get().count, 2);
  } finally { f.close(); }
});

test('close-window safeguard retains stop before bell and restores GTC if clock closes after cancellation', async () => {
  for (const crossing of [false, true]) {
    const f = fixture({ batchSize: 1 });
    try {
      await f.connect();
      f.world.assets = f.world.assets.slice(0, 1);
      f.world.fillEntry = true;
      await f.service.setAutomation(1, { action: 'resume' });
      await f.service.runCycle(1);
      f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
      f.world.bearishDates.add(f.world.latest);
      if (!crossing) f.world.nextClose = new Date(f.world.time + 60000).toISOString();
      else f.world.before = async call => { if (call.method === 'DELETE') f.world.open = false; };
      await f.service.runCycle(1);
      assert.equal(f.sells().filter(c => c.body.type === 'market').length, 0);
      assert.equal(f.db.prepare('SELECT protection FROM b2_trades').get().protection, 'protected');
      if (crossing) {
        assert.equal(f.sells().filter(c => c.body.type === 'stop').length, 1);
        assert.equal(f.sells()[0].body.time_in_force, 'gtc');
      } else assert.equal(f.world.calls.filter(c => c.method === 'DELETE').length, 0);
    } finally { f.close(); }
  }
});

test('real evaluator integration: 120 completed OHLCV bars enter then replay missed bearish crossover without snapshots', async () => {
  const f = fixture({ batchSize: 1, strategy: { ...realStrategy, evaluateB2(input) {
    assert(Array.isArray(input.completedSessionDates));
    assert(input.completedSessionDates.length >= 65);
    assert.equal(input.completedSessionDates.at(-1), input.expectedSessionDate);
    return realStrategy.evaluateB2(input);
  } } });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    const bars = dailyBars(LAST, 120).map((bar, i) => {
      const c = i < 85 ? 10 : i < 105 ? 8 : 8 + 2.67 * (i - 105) / 14;
      return { ...bar, o: c * .99, h: c * 1.01, l: c * .98, c, v: 300000 };
    });
    const price = bars.at(-1).c * 1.11;
    f.world.customBars = bars;
    f.world.customSnapshot = {
      latestTrade: { p: price, t: new Date(f.world.time).toISOString() },
      latestQuote: { bp: price - .01, ap: price + .01, bs: 100, as: 100, t: new Date(f.world.time).toISOString() },
      dailyBar: { t: '2026-09-14T04:00:00Z', v: 900000 },
      prevDailyBar: { t: `${LAST}T04:00:00Z`, c: bars.at(-1).c },
    };
    assert.equal(realStrategy.evaluateB2({ bars, snapshot: f.world.customSnapshot, asset: f.world.assets[0],
      now: f.world.time, expectedSessionDate: LAST }).signal, 'BUY');
    f.world.fillEntry = true; f.world.fillPrice = '11.85';
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.buys().length, 1);
    assert.equal(f.service.trades(1).trades[0].status, 'open');
    const shares = Number(f.buys()[0].body.qty);
    bars.push({ t: '2026-09-14T04:00:00Z', o: 1, h: 1.1, l: .9, c: 1, v: 300000 });
    assert.equal(realStrategy.evaluateB2({ bars, asset: { symbol: 'AAA' }, now: f.world.time,
      expectedSessionDate: '2026-09-14' }).signal, 'EXIT');
    bars.push({ t: '2026-09-15T04:00:00Z', o: 1, h: 1.1, l: .9, c: 1, v: 300000 });
    f.world.time = Date.parse('2026-09-16T15:00:00Z'); f.world.latest = '2026-09-15';
    // The 09-14 cross is inside the crossover window as of 09-15, so the
    // exit signal persists for a few sessions instead of expiring overnight.
    assert.equal(realStrategy.evaluateB2({ bars, asset: { symbol: 'AAA' }, now: f.world.time,
      expectedSessionDate: '2026-09-15' }).signal, 'EXIT');
    // Once the cross ages out of the window the direct signal goes quiet,
    // but the per-session replay below must still close the position.
    bars.push({ t: '2026-09-16T04:00:00Z', o: 1, h: 1.1, l: .9, c: 1, v: 300000 });
    bars.push({ t: '2026-09-17T04:00:00Z', o: 1, h: 1.1, l: .9, c: 1, v: 300000 });
    f.world.time = Date.parse('2026-09-18T15:00:00Z'); f.world.latest = '2026-09-17';
    assert.notEqual(realStrategy.evaluateB2({ bars, asset: { symbol: 'AAA' }, now: f.world.time,
      expectedSessionDate: '2026-09-17' }).signal, 'EXIT');
    await f.service.setAutomation(1, { action: 'pause' });
    f.world.fail = call => call.path.includes('snapshot');
    f.restart();
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    const result = f.service.trades(1).trades[0];
    assert.equal(result.status, 'closed');
    assert.equal(result.filledShares, shares);
    assert(Math.abs(result.pnl - (10.5 - 11.85) * shares) < .000001);
  } finally { f.close(); }
});

test('partial bearish sell is canceled at bell, residual gets GTC protection and retry uses only remaining shares', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    f.world.bearishDates.add(f.world.latest); f.world.partialExit = true;
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    assert.equal(f.account('paper1').positions[0].qty, '60');
    f.world.open = false;
    await f.service.runCycle(1);
    const stop = f.sells().find(c => c.body.type === 'stop');
    assert.equal(stop.body.qty, '60');
    assert.equal(stop.body.time_in_force, 'gtc');
    assert.equal(f.service.trades(1).trades[0].status, 'exit_retry');
    f.restart();
    f.world.open = true; f.world.partialExit = false; f.world.time += 61000;
    await f.service.runCycle(1);
    const exits = f.sells().filter(c => c.body.type === 'market');
    assert.equal(exits.length, 2);
    assert.equal(exits[1].body.qty, '60');
    assert.equal(f.service.trades(1).trades[0].status, 'closed');
    assert.equal(f.service.trades(1).trades[0].pnl, 100);
  } finally { f.close(); }
});

test('clock-race restore accepted with lost response and temporary 404 cannot compete with reopened bearish close', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.assets = f.world.assets.slice(0, 1);
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    const originalStop = f.db.prepare('SELECT stop_id FROM b2_trades').get().stop_id;
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    f.world.bearishDates.add(f.world.latest);
    f.world.restoreAcceptedThenThrow = true;
    f.world.hideRestores = true;
    f.world.before = async call => { if (call.method === 'DELETE') f.world.open = false; };
    await f.service.runCycle(1);
    const unresolved = f.db.prepare('SELECT * FROM b2_trades').get();
    const restoreClient = unresolved.restore_client_id;
    const actualRestore = [...f.account('paper1').orders.values()].find(o => o.client_order_id === restoreClient);
    assert(restoreClient && actualRestore);
    assert.equal(actualRestore.status, 'new');
    assert.equal(unresolved.stop_id, originalStop, 'Lost acknowledgement leaves the predecessor stop ID behind');
    assert.equal(unresolved.protection, 'restore_unknown');
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 0);

    f.restart();
    f.world.open = true;
    f.world.before = null;
    await f.service.runCycle(1);
    assert.equal(f.db.prepare('SELECT restore_client_id FROM b2_trades').get().restore_client_id, restoreClient);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 0, 'Unknown restored sell must block competing close after restart');
    assert.equal(f.sells().filter(c => c.body.type === 'stop').length, 1, 'Unknown restore must not be resubmitted');
    assert.equal(actualRestore.status, 'new');
    assert(!f.world.calls.some(c => c.method === 'DELETE' && c.path.endsWith(`/${actualRestore.id}`)));

    // Acceptance becomes visible, but cancellation itself is still ambiguous.
    f.world.hideRestores = false;
    f.world.cancelAmbiguous = true;
    await f.service.runCycle(1);
    const adopted = f.db.prepare('SELECT * FROM b2_trades').get();
    assert.equal(adopted.stop_id, actualRestore.id);
    assert.equal(adopted.restore_client_id, restoreClient, 'Do not release restore ID until actual replacement settles');
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 0);

    f.world.cancelAmbiguous = false;
    const begin = f.world.calls.length;
    await f.service.runCycle(1);
    const recovery = f.world.calls.slice(begin);
    const cancellation = recovery.findIndex(c => c.method === 'DELETE' && c.path.endsWith(`/${actualRestore.id}`));
    const close = recovery.findIndex(c => c.method === 'POST' && c.body?.type === 'market');
    assert(cancellation >= 0 && close > cancellation);
    assert.equal(actualRestore.status, 'canceled');
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    assert.equal(f.db.prepare('SELECT restore_client_id FROM b2_trades').get().restore_client_id, null);
    assert.equal(f.service.trades(1).trades[0].status, 'closed');
  } finally { f.close(); }
});
// ── Universe pre-filter (hot list) ──────────────────────────────────────────
function momentumStrategy(gains) {
  return {
    B2_RULES: realStrategy.B2_RULES,
    rankB2Candidates: realStrategy.rankB2Candidates,
    buildB2Entry: realStrategy.buildB2Entry,
    sessionDate: realStrategy.sessionDate,
    evaluateB2({ asset, expectedSessionDate }) {
      return { symbol: asset.symbol, eligible: false, signal: 'WAIT', crossover: null,
        eventId: `${asset.symbol}:${expectedSessionDate}:WAIT`, signalDate: expectedSessionDate,
        reasons: [], gates: [],
        metrics: { price: 10, dailyGainPct: gains[asset.symbol] ?? 0, relativeVolume: 3 } };
    },
  };
}
const lastScannedSymbols = f => {
  const bars = [...f.world.calls].reverse().find(c => c.path === '/v2/stocks/bars');
  return bars.query.get('symbols').split(',');
};
const priorityRows = f => f.db.prepare('SELECT symbol,score FROM b2_priority ORDER BY score DESC').all();

test('momentum names enter the hot list and are scanned first every cycle', async () => {
  const f = fixture({ batchSize: 2, strategy: momentumStrategy({ AAA: 12 }) });
  try {
    await f.connect();
    await f.service.scan(1); // rotation scans AAA, BBB — AAA goes hot
    assert.deepEqual(priorityRows(f).map(r => r.symbol), ['AAA']);
    await f.service.scan(1); // AAA first (priority), then ETF (rotation)
    assert.deepEqual(lastScannedSymbols(f), ['AAA', 'ETF']);
    const coverage = f.service.status(1).coverage;
    assert.equal(coverage.priority, 1);
    assert.equal(coverage.cursor, 3); // rotation advanced by 1, not 2
    assert.equal(coverage.scanned, 3);
    await f.service.scan(1); // AAA still first while its momentum persists
    assert.deepEqual(lastScannedSymbols(f), ['AAA', 'INV']);
  } finally { f.close(); }
});

test('priority scan never exceeds the per-cycle market-data budget', async () => {
  const f = fixture({ batchSize: 2, strategy: momentumStrategy({ AAA: 12, BBB: 11, ETF: 9 }) });
  try {
    await f.connect();
    await f.service.scan(1); // AAA, BBB scanned — both go hot
    assert.deepEqual(priorityRows(f).map(r => r.symbol), ['AAA', 'BBB']);
    await f.service.scan(1); // both priority slots taken, rotation gets nothing
    assert.deepEqual(lastScannedSymbols(f), ['AAA', 'BBB']); // ordered by score desc
    const coverage = f.service.status(1).coverage;
    assert.equal(coverage.cursor, 2); // rotation did not advance
    assert.equal(coverage.scanned, 2); // rotation progress only; priority re-scans do not inflate it
  } finally { f.close(); }
});

test('hot-list entries drop out when momentum fades', async () => {
  const gains = { AAA: 12 };
  const f = fixture({ batchSize: 2, strategy: momentumStrategy(gains) });
  try {
    await f.connect();
    await f.service.scan(1);
    assert.deepEqual(priorityRows(f).map(r => r.symbol), ['AAA']);
    gains.AAA = 1; // fades below the 5% hot-list threshold
    await f.service.scan(1); // AAA re-scanned via priority, then dropped
    assert.deepEqual(priorityRows(f), []);
    await f.service.scan(1); // back to pure rotation
    assert.deepEqual(lastScannedSymbols(f), ['INV', 'LEV']);
  } finally { f.close(); }
});

test('stale hot-list entries are pruned and never selected', async () => {
  const f = fixture({ batchSize: 2, strategy: momentumStrategy({}) });
  try {
    await f.connect();
    await f.service.scan(1);
    const account = f.db.prepare('SELECT account_id FROM b2_coverage').get().account_id;
    const stale = new Date(f.world.time - 10 * 86400000).toISOString();
    f.db.prepare(`INSERT INTO b2_priority(account_id,symbol,score,relative_volume,updated_at)
      VALUES (?,?,?,?,?)`).run(account, 'AAA', 20, 3, stale);
    await f.service.scan(1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM b2_priority WHERE symbol='AAA'").get().n, 0);
    assert.deepEqual(lastScannedSymbols(f), ['ETF', 'INV']); // pure rotation
  } finally { f.close(); }
});

test('symbols with unresolved trades are excluded from the hot-list scan', async () => {
  const f = fixture({ batchSize: 2, strategy: momentumStrategy({ AAA: 12 }) });
  try {
    await f.connect();
    await f.service.scan(1); // AAA goes hot
    const account = f.db.prepare('SELECT account_id FROM b2_coverage').get().account_id;
    const at = new Date().toISOString();
    f.db.prepare(`INSERT INTO b2_trades(user_id,account_id,mode,symbol,event_id,client_id,status,
      protection,created_at,updated_at) VALUES (1,?, 'paper','AAA','e1','c1','open','unknown',?,?)`)
      .run(account, at, at);
    await f.service.scan(1); // AAA held: priority skipped, rotation only
    assert.deepEqual(lastScannedSymbols(f), ['ETF', 'INV']);
    assert.deepEqual(priorityRows(f).map(r => r.symbol), ['AAA']); // row kept for later
  } finally { f.close(); }
});

test('a failed scan preserves the hot list instead of wiping it', async () => {
  const f = fixture({ batchSize: 2, strategy: momentumStrategy({ AAA: 12 }) });
  try {
    await f.connect();
    await f.service.scan(1);
    assert.deepEqual(priorityRows(f).map(r => r.symbol), ['AAA']);
    f.world.fail = call => call.path === '/v2/stocks/bars';
    await assert.rejects(f.service.scan(1));
    assert.deepEqual(priorityRows(f).map(r => r.symbol), ['AAA']);
  } finally { f.close(); }
});

test('priority rules are exposed as strategy configuration', async () => {
  assert.equal(realStrategy.B2_RULES.priorityBatchSize, 25);
  assert.equal(realStrategy.B2_RULES.priorityMinDailyGainPct, 5);
  assert.equal(realStrategy.B2_RULES.priorityMinRelativeVolume, 1);
  assert.equal(realStrategy.B2_RULES.priorityMaxAgeDays, 3);
});

test('take-profit closes an open position at the +15% target', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    assert.equal(f.service.trades(1).trades[0].status, 'open');
    f.world.assets = f.world.assets.slice(0, 1);
    f.account('paper1').positions.find(p => p.symbol === 'AAA').unrealized_plpc = '0.20';
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    assert.equal(f.service.trades(1).trades[0].exitReason, 'take_profit');
  } finally { f.close(); }
});

test('no take-profit below the target; no position data skips the check safely', async () => {
  for (const [plpc, extra] of [['0.10', {}], ['0.20', { qty: '0' }], ['0.20', { unrealized_plpc: undefined, current_price: undefined }]]) {
    const f = fixture({ batchSize: 1 });
    try {
      await f.connect();
      f.world.fillEntry = true;
      await f.service.setAutomation(1, { action: 'resume' });
      await f.service.runCycle(1);
      f.world.assets = f.world.assets.slice(0, 1);
      const position = f.account('paper1').positions.find(p => p.symbol === 'AAA');
      position.unrealized_plpc = plpc;
      Object.assign(position, extra);
      await f.service.runCycle(1);
      assert.equal(f.sells().length, 0, `plpc=${plpc} extra=${JSON.stringify(extra)}`);
      assert.equal(f.service.trades(1).trades[0].exitRequested, 0);
    } finally { f.close(); }
  }
});

test('take-profit falls back to current vs average-entry price without plpc', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.fillEntry = true;
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    f.world.assets = f.world.assets.slice(0, 1);
    const position = f.account('paper1').positions.find(p => p.symbol === 'AAA');
    delete position.unrealized_plpc;
    position.current_price = '11.40'; // +20% vs the 9.50 fill price
    position.avg_entry_price = '9.50';
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    assert.equal(f.service.trades(1).trades[0].exitReason, 'take_profit');
  } finally { f.close(); }
});

test('bearish crossover exit records a bearish reason', async () => {
  const f = fixture({ batchSize: 1 });
  try {
    await f.connect();
    f.world.fillEntry = true;
    f.world.assets = f.world.assets.slice(0, 1);
    await f.service.setAutomation(1, { action: 'resume' });
    await f.service.runCycle(1);
    f.world.time = Date.parse('2026-09-15T15:00:00Z'); f.world.latest = '2026-09-14';
    f.world.bearishDates.add(f.world.latest);
    await f.service.runCycle(1);
    assert.equal(f.sells().filter(c => c.body.type === 'market').length, 1);
    assert.equal(f.service.trades(1).trades[0].exitReason, 'bearish');
  } finally { f.close(); }
});

test('take-profit target is exposed as strategy configuration', async () => {
  assert.equal(realStrategy.B2_RULES.takeProfitPct, 15);
});
