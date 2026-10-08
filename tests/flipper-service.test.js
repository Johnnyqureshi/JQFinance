'use strict';

// Flipper service tests — schema, settings validation + enum aliases,
// connect/disconnect safety, pruning, route mounting, and a real-module
// synthetic backtest smoke (one winning long trade through the actual
// walls/signals/risk/journal/backtest engine).
// Mirrors the warrior-service test fixture style (in-memory better-sqlite3,
// real credential vault, fake broker fetch).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const {
  createFlipperService, mountFlipper, FlipperError, DEFAULT_FLIPPER_RULES,
} = require('../lib/flipper/service');
const { createCredentialVault } = require('../lib/credential-vault');

const NOW = Date.parse('2026-09-30T14:00:00Z'); // Wed 10:00 ET — trigger window
const TRADE_DATE = '2026-09-30';
const clone = value => JSON.parse(JSON.stringify(value));
const iso = ms => new Date(ms).toISOString();

// --- synthetic market data --------------------------------------------------
// Engineered for exactly ONE winning long trade on AAA, 2026-09-30:
//   daily: yesterday (09-29) range 100..105; history flat at 101..103 so both
//   flip walls are null (no qualifying swing beyond the range walls).
//   C1 (9:30-9:45): o=101.0 h=101.6 l=99.90 c=101.3 — tests range_low @100,
//   rejects (tolerance ±0.15%, range 1.68% >= minC1MovePct 0.75%).
//   C2 (9:45-10:00): o=101.3 h=102.5 l=101.0 c=102.2 — green, holds the wall.
//   C3 (10:00-10:15): 10:05 bar high 102.7 breaks the C2 high 102.5 ->
//   trigger @102.7; fills 10:06 open 102.65; stop = C1 low - buffer = 99.80;
//   target = range high = 105; 10:10 bar high 105.3 -> target exit.
function dailyBars() {
  const bars = [];
  let dayMs = Date.parse('2026-05-23T13:30:00Z');
  for (let i = 0; i < 129; i++) {
    bars.push({ t: iso(dayMs), o: 102, h: 103, l: 101, c: 102, v: 1000000 });
    dayMs += 86400000;
  }
  // Yesterday: the range walls.
  bars.push({ t: iso(Date.parse('2026-09-29T13:30:00Z')), o: 102, h: 105, l: 100, c: 103, v: 2000000 });
  return bars;
}
function m1(t, o, h, l, c, v = 100000) {
  return { t: iso(Date.parse(t)), o, h, l, c, v };
}
function minuteBars() {
  const bars = [
    // C1: 9:30-9:45 ET (13:30-13:44 UTC)
    m1('2026-09-30T13:30:00Z', 101.0, 101.3, 100.9, 101.2),
    m1('2026-09-30T13:31:00Z', 101.2, 101.6, 101.0, 101.4),
    m1('2026-09-30T13:32:00Z', 101.4, 101.5, 100.8, 101.0),
    m1('2026-09-30T13:33:00Z', 101.0, 101.1, 100.4, 100.6),
    m1('2026-09-30T13:34:00Z', 100.6, 100.8, 100.1, 100.3),
    m1('2026-09-30T13:35:00Z', 100.3, 100.5, 99.95, 100.1),
    m1('2026-09-30T13:36:00Z', 100.1, 100.3, 99.90, 100.2),
    m1('2026-09-30T13:37:00Z', 100.2, 100.6, 100.0, 100.5),
    m1('2026-09-30T13:38:00Z', 100.5, 100.9, 100.3, 100.8),
    m1('2026-09-30T13:39:00Z', 100.8, 101.0, 100.6, 100.9),
    m1('2026-09-30T13:40:00Z', 100.9, 101.1, 100.7, 101.0),
    m1('2026-09-30T13:41:00Z', 101.0, 101.2, 100.8, 101.1),
    m1('2026-09-30T13:42:00Z', 101.1, 101.3, 100.9, 101.2),
    m1('2026-09-30T13:43:00Z', 101.2, 101.4, 101.0, 101.3),
    m1('2026-09-30T13:44:00Z', 101.3, 101.4, 101.1, 101.3),
    // C2: 9:45-10:00 ET (13:45-13:59 UTC)
    m1('2026-09-30T13:45:00Z', 101.3, 101.6, 101.0, 101.5),
    m1('2026-09-30T13:46:00Z', 101.5, 101.7, 101.3, 101.6),
    m1('2026-09-30T13:47:00Z', 101.6, 101.8, 101.4, 101.7),
    m1('2026-09-30T13:48:00Z', 101.7, 101.9, 101.5, 101.8),
    m1('2026-09-30T13:49:00Z', 101.8, 102.0, 101.6, 101.9),
    m1('2026-09-30T13:50:00Z', 101.9, 102.1, 101.7, 102.0),
    m1('2026-09-30T13:51:00Z', 102.0, 102.2, 101.8, 102.1),
    m1('2026-09-30T13:52:00Z', 102.1, 102.2, 101.9, 102.1),
    m1('2026-09-30T13:53:00Z', 102.1, 102.3, 102.0, 102.2),
    m1('2026-09-30T13:54:00Z', 102.2, 102.3, 102.0, 102.2),
    m1('2026-09-30T13:55:00Z', 102.2, 102.4, 102.1, 102.3),
    m1('2026-09-30T13:56:00Z', 102.3, 102.4, 102.1, 102.3),
    m1('2026-09-30T13:57:00Z', 102.3, 102.4, 102.2, 102.3),
    m1('2026-09-30T13:58:00Z', 102.3, 102.5, 102.2, 102.4),
    m1('2026-09-30T13:59:00Z', 102.4, 102.4, 102.2, 102.2),
    // C3: 10:00-10:15 ET (14:00-14:14 UTC)
    m1('2026-09-30T14:00:00Z', 102.2, 102.4, 102.0, 102.3),
    m1('2026-09-30T14:01:00Z', 102.3, 102.4, 102.1, 102.2),
    m1('2026-09-30T14:02:00Z', 102.2, 102.5, 102.1, 102.4), // touches, not a break
    m1('2026-09-30T14:03:00Z', 102.4, 102.4, 102.2, 102.3),
    m1('2026-09-30T14:04:00Z', 102.3, 102.5, 102.2, 102.4),
    m1('2026-09-30T14:05:00Z', 102.4, 102.7, 102.3, 102.6), // TRIGGER @102.7
    m1('2026-09-30T14:06:00Z', 102.65, 102.8, 102.6, 102.75), // fill bar
    m1('2026-09-30T14:07:00Z', 102.75, 103.1, 102.7, 103.0),
    m1('2026-09-30T14:08:00Z', 103.0, 103.6, 102.9, 103.5),
    m1('2026-09-30T14:09:00Z', 103.5, 104.1, 103.4, 104.0),
    m1('2026-09-30T14:10:00Z', 104.0, 105.3, 103.9, 105.1), // target 105 hit
    m1('2026-09-30T14:11:00Z', 105.1, 105.4, 105.0, 105.2),
    m1('2026-09-30T14:12:00Z', 105.2, 105.5, 105.1, 105.3),
    m1('2026-09-30T14:13:00Z', 105.3, 105.5, 105.2, 105.4),
    m1('2026-09-30T14:14:00Z', 105.4, 105.6, 105.3, 105.5),
  ];
  // Filler to end of session (post-exit; keeps the tape realistic).
  for (let mins = 14 * 60 + 15; mins < 19 * 60 + 55; mins++) {
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const c = 105.4 + ((mins % 7) - 3) * 0.05;
    bars.push(m1(`2026-09-30T${hh}:${mm}:00Z`, c - 0.05, c + 0.1, c - 0.1, c));
  }
  return bars;
}

// Minute tape for the $9.85 C1-low penny-tick regression (2026-10-08):
//   C1 (13:30-13:44Z): low prints exactly $9.85 — the structure stop's raw
//     value is 9.85 * 0.999 = 9.84015, sub-penny at $1+.
//   C2 (13:45-13:59Z): green confirmation, high $9.86.
//   C3 (14:00Z): closes $9.87, breaking the C2 high — the entry limit's raw
//     value is 9.87 * 1.002 = 9.88974, also sub-penny.
// Both raw prices must reach the mock broker (which 422s sub-penny at $1+,
// like Alpaca) tick-clean: stop 9.84, entry limit 9.89.
function pennyMinuteBars() {
  return [
    m1('2026-09-30T13:30:00Z', 9.95, 10.00, 9.90, 9.92, 100000),
    m1('2026-09-30T13:36:00Z', 9.90, 9.92, 9.85, 9.88, 100000),
    m1('2026-09-30T13:44:00Z', 9.88, 9.94, 9.87, 9.93, 100000),
    m1('2026-09-30T13:45:00Z', 9.80, 9.84, 9.78, 9.82, 100000),
    m1('2026-09-30T13:59:00Z', 9.83, 9.86, 9.82, 9.85, 100000),
    m1('2026-09-30T14:00:00Z', 9.82, 9.87, 9.81, 9.87, 60000),
  ];
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
  const world = { time: NOW, calls: [], orders: new Map(), positions: [], sequence: 0, ...options };
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value) });
  async function fakeFetch(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const query = parsed.searchParams;
    const body = init.body ? JSON.parse(init.body) : null;
    world.calls.push({ url, path, method: init.method || 'GET', body });
    if (parsed.hostname === 'paper-api.alpaca.markets') {
      if (path === '/v2/account') return response({
        id: 'acct-flipper-test', status: 'ACTIVE', trading_blocked: false,
        account_blocked: false, trade_suspended_by_user: false,
        equity: '100000', buying_power: '100000', last_equity: '100000',
      });
      if (path === '/v2/calendar') return response([{ date: TRADE_DATE, open: '09:30', close: '16:00' }]);
      if (path === '/v2/clock') return response({ timestamp: iso(world.time), is_open: true });
      if (path === '/v2/positions') return response(world.positions);
      if (path.startsWith('/v2/orders:by_client_order_id')) {
        const order = world.orders.get(query.get('client_order_id'));
        return order ? response(order) : response({}, 404);
      }
      if (path === '/v2/orders' && (init.method || 'GET') === 'GET') {
        return response([...world.orders.values()]
          .filter(o => !['filled', 'canceled', 'expired', 'rejected', 'replaced'].includes(o.status)));
      }
      if (path === '/v2/orders' && init.method === 'POST') {
        // Mirror Alpaca: sub-penny order prices are rejected (422) on
        // symbols priced $1+ — the rule the Flipper tick bug violated live.
        const pxFields = [body.limit_price, body.stop_price,
          body.take_profit?.limit_price, body.stop_loss?.stop_price,
          ...((body.legs || []).flatMap(leg => [leg.limit_price, leg.stop_price]))];
        if (pxFields.some(px => px != null && Number(px) >= 1 && Math.abs(Number(px) * 100 - Math.round(Number(px) * 100)) > 1e-9)) {
          return response({ message: 'invalid price: sub-penny not allowed' }, 422);
        }
        world.sequence++;
        const order = {
          id: `ord-${world.sequence}`, client_order_id: body.client_order_id,
          symbol: body.symbol, qty: String(body.qty), side: body.side,
          type: body.type, order_class: body.order_class || 'simple', status: 'new',
          filled_qty: '0', limit_price: body.limit_price ?? null, stop_price: body.stop_price ?? null,
          legs: body.legs || null,
        };
        if (!body.order_class) {
          // Simple orders fill immediately at the limit (or last) price and
          // move the fake broker's held position, like a real fill would.
          const held = world.positions.find(p => p.symbol === body.symbol);
          const fillPrice = body.limit_price ?? (held ? Number(held.current_price) : 10);
          order.status = 'filled';
          order.filled_qty = String(body.qty);
          order.filled_avg_price = String(fillPrice);
          order.filled_at = iso(world.time);
          const delta = body.side === 'buy' ? Number(body.qty) : -Number(body.qty);
          if (held) held.qty = String(Number(held.qty) + delta);
          else if (delta > 0) world.positions.push({ symbol: body.symbol, qty: String(delta), avg_entry_price: String(fillPrice), current_price: String(fillPrice) });
        }
        world.orders.set(body.client_order_id, order);
        return response(order);
      }
      if (path.startsWith('/v2/orders/') && init.method === 'GET') {
        const order = [...world.orders.values()].find(o => o.id === path.split('/').pop());
        return order ? response(order) : response({}, 404);
      }
      if (path.startsWith('/v2/orders/') && init.method === 'DELETE') {
        for (const o of world.orders.values()) if (o.id === path.split('/').pop()) o.status = 'canceled';
        return response(null, 204);
      }
    }
    if (parsed.hostname === 'data.alpaca.markets' && path === '/v2/stocks/bars') {
      const symbols = (query.get('symbols') || '').split(',').filter(Boolean);
      const bars = query.get('timeframe') === '1Min'
        ? (world.customMinuteBars || minuteBars()) : (world.customDailyBars || dailyBars());
      return response({ bars: Object.fromEntries(symbols.map(s => [s, bars])), next_page_token: null });
    }
    return response({ message: `unexpected ${parsed.hostname}${path}` }, 500);
  }
  const service = createFlipperService({
    db, vault, fetch: fakeFetch, now: () => world.time,
    persistenceReady: () => true, durability: null,
    exitPoll: { tries: 3, intervalMs: 0 },
  });
  return { db, service, world };
}

async function connectPaper(f) {
  return f.service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8) });
}

function seedOpenPosition(db, overrides = {}) {
  const row = {
    position_id: 'pos-flipper-1', user_id: 1, symbol: 'AAA', direction: 'long',
    entry_price: 100, shares: 10, stop_price: 95, target_price: 110,
    wall_type: 'range_low', wall_price: 100, setup_json: null,
    entry_at: iso(NOW), status: 'open', ...overrides,
  };
  db.prepare(`INSERT INTO flipper_positions(position_id,user_id,symbol,direction,entry_price,shares,
    stop_price,target_price,wall_type,wall_price,setup_json,entry_at,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.position_id, row.user_id, row.symbol, row.direction, row.entry_price, row.shares,
      row.stop_price, row.target_price, row.wall_type, row.wall_price, row.setup_json,
      row.entry_at, row.status);
  return row;
}

// --- schema -----------------------------------------------------------------
test('flipper schema creates every flipper_* table', async () => {
  const { db } = fixture();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'flipper_%' ORDER BY name")
    .all().map(r => r.name);
  for (const expected of ['flipper_settings', 'flipper_credentials', 'flipper_walls',
    'flipper_setups', 'flipper_positions', 'flipper_trades', 'flipper_alerts',
    'flipper_backtests', 'flipper_backtest_trades', 'flipper_scan_runs', 'flipper_leases']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
});

test('service exposes the pinned contract surface', async () => {
  const { service } = fixture();
  for (const key of ['strategy', 'start', 'stop', 'drain', 'lifecycleStatus',
    'connect', 'disconnect', 'setSettings', 'getSettings', 'status',
    'dashboard', 'positions', 'trades', 'alerts', 'universe',
    'backtest', 'getBacktests', 'getBacktest', 'pruneDiagnostics', 'DEFAULT_FLIPPER_RULES']) {
    assert.ok(service[key] !== undefined, `missing export ${key}`);
  }
  assert.equal(service.strategy, 'flipper');
  assert.deepEqual(service.DEFAULT_FLIPPER_RULES, DEFAULT_FLIPPER_RULES);
});

// --- settings ---------------------------------------------------------------
test('flipper ships disabled (enabled defaults to 0)', async () => {
  const { service } = fixture();
  const view = service.getSettings(1);
  assert.equal(view.enabled, false);
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
    service.setSettings(1, { rules: { targetMode: 'moon' } }),
    /must be one of/);
});

test("alias rr_target is normalized to rr", async () => {
  const { service } = fixture();
  await service.setSettings(1, { rules: { targetMode: 'rr_target' } });
  assert.equal(service.getSettings(1).rules.targetMode, 'rr');
});

test('alias dollar is normalized to dollars', async () => {
  const { service } = fixture();
  await service.setSettings(1, { rules: { stopMode: 'dollar' } });
  assert.equal(service.getSettings(1).rules.stopMode, 'dollars');
});

test('inverted price band is rejected', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.setSettings(1, { rules: { minPrice: 20, maxPrice: 1 } }),
    /minPrice cannot exceed maxPrice/);
});

// --- connect / disconnect ---------------------------------------------------
test('paper connect succeeds and stays disabled', async () => {
  const { service } = fixture();
  const result = await connectPaper({ service });
  assert.equal(result.ok, true);
  assert.equal(result.accountId, 'acct-flipper-test');
  const status = await service.status(1);
  assert.equal(status.connected, true);
  assert.equal(status.enabled, false, 'connecting must not enable the bot');
});

test('live connect is refused loudly', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8), mode: 'live' }),
    /LIVE/);
  await assert.rejects(
    service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8), mode: 'LIVE' }),
    /LIVE/);
});

test('disconnect is refused while a position is open', async () => {
  const f = fixture();
  await connectPaper(f);
  seedOpenPosition(f.db);
  await assert.rejects(f.service.disconnect(1), /before disconnecting/);
  // After the position closes locally, disconnect succeeds.
  f.db.prepare("UPDATE flipper_positions SET status='closed' WHERE position_id='pos-flipper-1'").run();
  const result = await f.service.disconnect(1);
  assert.equal(result.ok, true);
});

// --- pruning ----------------------------------------------------------------
test('pruneDiagnostics keeps the newest 20 backtests and drops orphans', async () => {
  const f = fixture();
  const base = NOW - 30 * 86400000;
  for (let i = 0; i < 21; i++) {
    const id = `bt-${i}`;
    f.db.prepare('INSERT INTO flipper_backtests(backtest_id,user_id,params,report,created_at) VALUES (?,?,?,?,?)')
      .run(id, 1, '{}', '{}', iso(base + i * 60000));
    f.db.prepare('INSERT INTO flipper_backtest_trades(backtest_id,seq,trade_json) VALUES (?,?,?)')
      .run(id, 0, '{"ticker":"AAA"}');
  }
  await f.service.pruneDiagnostics(1);
  const remaining = f.db.prepare('SELECT COUNT(*) AS n FROM flipper_backtests').get().n;
  assert.equal(remaining, 20);
  const orphaned = f.db.prepare("SELECT COUNT(*) AS n FROM flipper_backtest_trades WHERE backtest_id='bt-0'").get().n;
  assert.equal(orphaned, 0, 'orphan trade rows of the pruned run must go');
  const kept = f.db.prepare("SELECT COUNT(*) AS n FROM flipper_backtest_trades WHERE backtest_id='bt-20'").get().n;
  assert.equal(kept, 1);
});

test('pruneDiagnostics removes alerts older than 7 days', async () => {
  const f = fixture();
  f.db.prepare('INSERT INTO flipper_alerts(user_id,created_at,kind,message) VALUES (?,?,?,?)')
    .run(1, iso(NOW - 8 * 86400000), 'system', 'old');
  f.db.prepare('INSERT INTO flipper_alerts(user_id,created_at,kind,message) VALUES (?,?,?,?)')
    .run(1, iso(NOW - 60000), 'system', 'fresh');
  await f.service.pruneDiagnostics(1);
  const rows = f.db.prepare('SELECT message FROM flipper_alerts').all().map(r => r.message);
  assert.deepEqual(rows, ['fresh']);
});

test('pruneDiagnostics removes terminal setups older than 7 days', async () => {
  const f = fixture();
  const ins = f.db.prepare(`INSERT INTO flipper_setups
    (setup_id,user_id,symbol,trade_date,direction,wall_type,wall_price,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('s-old', 1, 'AAA', '2026-09-20', 'long', 'range_low', 5, 'expired', iso(NOW));
  ins.run('s-live', 1, 'BBB', '2026-09-29', 'short', 'range_high', 6, 'waiting_c2', iso(NOW));
  ins.run('s-fresh', 1, 'CCC', '2026-09-30', 'long', 'range_low', 5, 'cancelled', iso(NOW));
  await f.service.pruneDiagnostics(1);
  const rows = f.db.prepare('SELECT setup_id FROM flipper_setups').all().map(r => r.setup_id).sort();
  assert.deepEqual(rows, ['s-fresh', 's-live']);
});

test('recordSetup inserts a complete C1 setup row (column/placeholder arity)', async () => {
  // Regression cover for 2026-09-30: the C1 INSERT was missing the wall_price
  // placeholder, so every live tick at/after 9:45 ET threw
  // "Unexpected Flipper scheduler error" and no setups were ever recorded.
  const f = fixture();
  const c1 = { o: 101, h: 101.6, l: 99.9, c: 101.3 };
  f.service._recordSetup(1, TRADE_DATE, 'AAA',
    { direction: 'long', wallType: 'range_low', wallPrice: 100 }, c1);
  const row = f.db.prepare('SELECT * FROM flipper_setups WHERE user_id=1 AND symbol=?').get('AAA');
  assert.ok(row, 'setup row was inserted');
  assert.equal(row.trade_date, TRADE_DATE);
  assert.equal(row.direction, 'long');
  assert.equal(row.wall_type, 'range_low');
  assert.equal(row.wall_price, 100);
  assert.equal(row.state, 'testing_wall');
  assert.deepEqual(JSON.parse(row.c1_json), c1);
  assert.equal(row.c2_json, null);
  assert.equal(row.trigger_price, null);
  assert.ok(row.why.includes('range low wall'));
});

// --- route mounting ----------------------------------------------------------
test('mountFlipper registers all 13 routes', async () => {
  const { service } = fixture();
  const registered = [];
  const app = {
    get: (path, ...middleware) => registered.push(['GET', path]),
    post: (path, ...middleware) => registered.push(['POST', path]),
    put: (path, ...middleware) => registered.push(['PUT', path]),
  };
  const mounted = mountFlipper({ app, service, requireAuth: (req, res, next) => next() });
  const expected = [
    ['GET', '/api/flipper/status'],
    ['POST', '/api/flipper/connect'],
    ['POST', '/api/flipper/disconnect'],
    ['GET', '/api/flipper/settings'],
    ['PUT', '/api/flipper/settings'],
    ['GET', '/api/flipper/dashboard'],
    ['GET', '/api/flipper/positions'],
    ['GET', '/api/flipper/trades'],
    ['GET', '/api/flipper/alerts'],
    ['GET', '/api/flipper/universe'],
    ['POST', '/api/flipper/backtest'],
    ['GET', '/api/flipper/backtests'],
    ['GET', '/api/flipper/backtests/:id'],
  ];
  assert.equal(registered.length, 13, `expected 13 routes, got ${registered.length}`);
  for (const route of expected) {
    assert.ok(registered.some(r => r[0] === route[0] && r[1] === route[1]), `missing route ${route[0]} ${route[1]}`);
  }
  assert.equal(mounted.routes.length, 13);
  assert.throws(() => mountFlipper({ app, service }), /requireAuth/);
});

// --- real-module backtest smoke ----------------------------------------------
test('synthetic backtest smoke: one winning long trade through the real engine', async () => {
  const f = fixture();
  await connectPaper(f);
  const { backtestId, report, trades } = await f.service.backtest(1, {
    symbols: ['AAA'], from: TRADE_DATE, to: TRADE_DATE,
  });
  assert.ok(backtestId, 'backtest id returned');
  assert.equal(report.totalTrades, 1, `expected 1 trade, got ${report.totalTrades}`);
  assert.equal(report.winningTrades, 1);
  const trade = trades[0];
  assert.equal(trade.ticker, 'AAA');
  assert.equal(trade.direction, 'long');
  assert.equal(trade.wallType, 'range_low');
  assert.equal(trade.wallPrice, 100);
  assert.equal(trade.exitReason, 'target');
  assert.ok(trade.pnl > 0, `expected winning trade, got pnl=${trade.pnl}`);
  assert.ok(trade.entryPrice > 102.5 && trade.entryPrice < 103, `entry near trigger, got ${trade.entryPrice}`);
  assert.equal(trade.exitPrice, 104.9475);
  assert.equal(trade.positionSize, 100);
  // Persisted: one backtest row + one trade row, retrievable by id.
  const fetched = f.service.getBacktest(1, backtestId);
  assert.equal(fetched.trades.length, 1);
  assert.equal(f.service.getBacktests(1).backtests.length, 1);
});

// --- penny-tick regression (2026-10-08) --------------------------------------
test('live entry from a $9.85 C1 low reaches the broker tick-clean (no sub-penny 422)', async () => {
  const f = fixture({ customMinuteBars: pennyMinuteBars() });
  await connectPaper(f);
  // Today's walls: range low $9.85 (the wall C1 tested), range high $10.50
  // (the full target). Walls are pre-market state, seeded directly.
  f.db.prepare(`INSERT INTO flipper_walls(user_id,symbol,trade_date,range_high,range_low,flip_high,flip_low,created_at)
    VALUES (1,'AAA',?,?,?,?,?,?)`).run(TRADE_DATE, 10.5, 9.85, null, null, iso(NOW));
  // A C1 wall-test setup awaiting C2 confirmation; the live tick computes
  // its stop from the session C1 low (9.85) and then triggers the entry.
  f.service._recordSetup(1, TRADE_DATE, 'AAA',
    { direction: 'long', wallType: 'range_low', wallPrice: 9.85 },
    { o: 9.95, h: 10.00, l: 9.85, c: 9.93 });
  await f.service.setSettings(1, { enabled: true });
  await f.service._scanCycle(1);

  const settings = f.db.prepare('SELECT scheduler_status FROM flipper_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'ok', 'scan cycle completes without a broker rejection');

  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 2, 'exactly the entry order and one OCO protection order are posted');

  // Entry: raw limit 9.87 * 1.002 = 9.88974 must be posted as 9.89.
  const entry = posts.find(c => c.body?.type === 'limit' && !c.body?.order_class);
  assert.ok(entry, 'entry limit order posted');
  assert.equal(entry.body.limit_price, 9.89);

  // Protection: raw stop 9.85 * 0.999 = 9.84015 must be posted as 9.84;
  // the $10.50 wall target stays 10.5.
  const oco = posts.find(c => c.body?.order_class === 'oco');
  assert.ok(oco, 'OCO protection order posted');
  const stopLeg = oco.body.legs.find(leg => leg.type === 'stop');
  const targetLeg = oco.body.legs.find(leg => leg.type === 'limit');
  assert.equal(stopLeg.stop_price, 9.84);
  assert.equal(targetLeg.limit_price, 10.5);

  // The position survives protection attach: a 422 here would have run the
  // protection-rejected path and flattened it instantly.
  const position = f.db.prepare('SELECT * FROM flipper_positions WHERE user_id=1').get();
  assert.ok(position, 'position row exists');
  assert.equal(position.status, 'open');
  assert.equal(position.entry_price, 9.89);
  assert.equal(position.stop_price, 9.84);
  assert.equal(position.target_price, 10.5);
  const rejected = f.db.prepare("SELECT COUNT(*) AS n FROM flipper_alerts WHERE user_id=1 AND message LIKE '%REJECTED%'").get().n;
  assert.equal(rejected, 0, 'no protection-rejected alert may fire');
  const setup = f.db.prepare('SELECT state FROM flipper_setups WHERE user_id=1').get();
  assert.equal(setup.state, 'entered');
});
