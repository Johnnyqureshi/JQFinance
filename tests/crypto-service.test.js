'use strict';

// Crypto breakout bot service tests — schema, connect/disconnect, paper-only
// live refusal, SIP→IEX fallback, fully-automated entries, tiered
// protection, partial-profit banking, reconciliation pause, emergency stop,
// backtest fail-closed, and route mounting. Mirrors the warrior-service test
// fixture style (in-memory better-sqlite3, real credential vault, fake fetch).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const {
  createCryptoService, CryptoError, DEFAULT_CRYPTO_RULES, EXIT_REASONS,
} = require('../lib/crypto/service');
const { createCredentialVault } = require('../lib/credential-vault');

const NOW = Date.parse('2026-09-29T14:00:00Z'); // Tue 10:00 ET — crypto trades 24/7
const TODAY = '2026-09-29';
const clone = value => JSON.parse(JSON.stringify(value));
const BREAKOUT_SYMBOL = 'ETH/USD';

// --- synthetic market data --------------------------------------------------
// 5m tape: choppy rally (rising swing structure, RSI stays in the 55-75
// sweet spot), then a final bar that CLOSES above the recent resistance by
// ~0.5 ATR with 3.5x volume — a clean, non-extended breakout.
function fiveMinuteBars() {
  const { rollingHigh, swingPoints, computeCryptoIntraday } = require('../lib/crypto/indicators');
  const bars = [];
  const base = Date.parse('2026-09-29T00:00:00Z');
  for (let i = 0; i < 199; i++) {
    const c = 90 + i * 0.03 + Math.sin(i / 4) * 0.6;
    bars.push({
      t: new Date(base + i * 300000).toISOString(),
      o: c - 0.05, h: c + 0.12, l: c - 0.12, c, v: 100000,
    });
  }
  // Anchor the breakout to the SAME resistance the service will compute:
  // swing highs + 50-bar rolling high on completed history, above prev close.
  const history = bars.slice();
  const { highs } = swingPoints(history, 3, 3);
  const prevC = history[history.length - 1].c;
  const candidates = [...highs.map(h => h.price), rollingHigh(history, 50)]
    .filter(x => Number.isFinite(x) && x > prevC * 1.0005);
  const resistance = candidates.length ? Math.min(...candidates) : prevC * 1.002;
  const ind = computeCryptoIntraday(history);
  const atr = ind[ind.length - 1].atr14 || 0.5;
  bars.push({
    t: new Date(base + 199 * 300000).toISOString(),
    o: prevC, h: resistance + 0.7 * atr, l: prevC - 0.1,
    c: resistance + 0.5 * atr, v: 350000,
  });
  return bars;
}
function flatFiveMinuteBars(price = 50000) {
  const bars = [];
  const base = Date.parse('2026-09-29T00:00:00Z');
  for (let i = 0; i < 200; i++) {
    const c = price + Math.sin(i / 9) * price * 0.001;
    bars.push({ t: new Date(base + i * 300000).toISOString(), o: c, h: c * 1.0005, l: c * 0.9995, c, v: 50000 });
  }
  return bars;
}
// Bullish daily tape: price above rising 20/50 EMAs, green on the day.
function dailyBars(startPrice = 100, drift = 0.8) {
  const bars = [];
  const base = Date.parse('2026-09-29T00:00:00Z');
  for (let i = 0; i < 70; i++) {
    const c = startPrice + i * drift;
    const t = new Date(base - (69 - i) * 86400000).toISOString();
    bars.push({ t, o: c - drift * 0.4, h: c + drift * 0.3, l: c - drift * 0.6, c, v: 1000000 });
  }
  return bars;
}
function hourlyBars(price = 100) {
  const bars = [];
  const base = NOW - 24 * 3600000;
  for (let i = 0; i < 24; i++) {
    bars.push({ t: new Date(base + i * 3600000).toISOString(), o: price, h: price * 1.002, l: price * 0.998, c: price, v: 500000 });
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
    CREATE TABLE automated_action_intents(id INTEGER PRIMARY KEY AUTOINCREMENT, strategy TEXT, user_id INTEGER,
      account_id TEXT, mode TEXT, method TEXT, path TEXT, purpose TEXT, client_order_id TEXT,
      request_json TEXT, state TEXT, broker_order_id TEXT, last_error TEXT, updated_at TEXT);
  `);
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-123456789');
  const world = {
    time: NOW,
    calls: [],
    orders: new Map(), // client_order_id -> order
    positions: [],
    assets: [
      { symbol: 'BTC/USD', class: 'crypto', status: 'active', tradable: true },
      { symbol: 'ETH/USD', class: 'crypto', status: 'active', tradable: true },
      { symbol: 'SOL/USD', class: 'crypto', status: 'active', tradable: true },
      { symbol: 'USDC/USD', class: 'crypto', status: 'active', tradable: true }, // stablecoin — excluded by default
      { symbol: 'PAXG/USD', class: 'crypto', status: 'active', tradable: true }, // excluded by default
      { symbol: 'DOGE', class: 'crypto', status: 'active', tradable: true },    // no /USD suffix — excluded
    ],
    sequence: 0,
    entryPrice: 101.5,
    autoFillEntries: true,
    autoFillExits: false,
    marketFillPrice: 0,
    ...options,
  };
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value) });
  // REAL Alpaca behavior (verified live 2026-10-05): the v1beta3 crypto
  // endpoints reject ANY feed query parameter with HTTP 400. The mock
  // mirrors that exactly so a feed parameter can never sneak back in
  // behind a mock that tolerates it (the Warrior .DailyBar lesson).
  const feedRejected = url => {
    try { return new URL(url).searchParams.has('feed'); } catch (_) { return false; }
  };
  async function fakeFetch(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const query = parsed.searchParams;
    const body = init.body ? JSON.parse(init.body) : null;
    world.calls.push({ url, path, method: init.method || 'GET', body });
    const host = parsed.hostname;
    if (host === 'paper-api.alpaca.markets') {
      if (path === '/v2/account') return response({
        id: 'acct-crypto-test', status: 'ACTIVE', trading_blocked: false,
        account_blocked: false, trade_suspended_by_user: false,
        equity: '100000', buying_power: '100000',
      });
      if (path === '/v2/assets') return response(world.assets);
      if (path === '/v2/positions') {
        if (world.positionsError) throw new Error('broker positions unavailable');
        return response(world.positions);
      }
      if (path.startsWith('/v2/orders:by_client_order_id')) {
        const order = world.orders.get(query.get('client_order_id'));
        return order ? response(order) : response({}, 404);
      }
      if (path === '/v2/orders' && (init.method || 'GET') === 'GET') {
        // Mirror Alpaca: status=closed returns terminal orders, anything
        // else returns the open list.
        if (query.get('status') === 'closed')
          return response([...world.orders.values()].filter(o => ['filled', 'canceled', 'expired', 'rejected'].includes(o.status)));
        return response([...world.orders.values()].filter(o => !['filled', 'canceled', 'expired', 'rejected'].includes(o.status)));
      }
      if (path === '/v2/orders' && init.method === 'POST') {
        world.sequence++;
        const order = {
          id: `ord-${world.sequence}`, client_order_id: body.client_order_id,
          symbol: body.symbol, qty: body.qty != null ? String(body.qty) : undefined,
          notional: body.notional != null ? String(body.notional) : undefined,
          side: body.side, type: body.type, time_in_force: body.time_in_force,
          status: 'new', filled_qty: '0',
          limit_price: body.limit_price ?? null,
          stop_price: body.stop_price ?? null,
        };
        if (world.autoFillEntries && body.side === 'buy' && body.type === 'market' && body.notional) {
          const fillPrice = world.entryPrice;
          order.status = 'filled';
          order.filled_qty = String(Number(body.notional) / fillPrice);
          order.filled_avg_price = String(fillPrice);
        }
        if (world.autoFillExits && body.side === 'sell' && body.type === 'market') {
          order.status = 'filled';
          order.filled_qty = String(body.qty);
          order.filled_avg_price = String(world.marketFillPrice || world.entryPrice);
        }
        world.orders.set(body.client_order_id, order);
        return response(order);
      }
      if (path.startsWith('/v2/orders/') && init.method === 'DELETE') {
        for (const o of world.orders.values()) if (o.id === path.split('/').pop()) o.status = 'canceled';
        return response(null, 204);
      }
    }
    if (host === 'data.alpaca.markets') {
      if (feedRejected(url)) return response({ message: 'unexpected query parameter(s): feed' }, 400);
      if (path === '/v1beta3/crypto/us/bars') {
        const symbols = (query.get('symbols') || '').split(',').filter(Boolean);
        const tf = query.get('timeframe');
        const bars = {};
        for (const s of symbols) {
          if (tf === '5Min') bars[s] = s === BREAKOUT_SYMBOL ? fiveMinuteBars() : flatFiveMinuteBars(s === 'BTC/USD' ? 67000 : 100);
          else if (tf === '1Hour') bars[s] = hourlyBars(s === 'BTC/USD' ? 67000 : 100);
          else bars[s] = dailyBars(s === 'BTC/USD' ? 60000 : 90, s === 'BTC/USD' ? 400 : 0.8);
        }
        return response({ bars, next_page_token: null });
      }
      if (path === '/v1beta3/crypto/us/latest/quotes') {
        const symbols = (query.get('symbols') || '').split(',').filter(Boolean);
        const quotes = {};
        for (const s of symbols) {
          const mid = s === BREAKOUT_SYMBOL ? world.entryPrice : s === 'BTC/USD' ? 67000 : 100;
          const t = new Date(world.time).toISOString();
          // Real response shape (live-verified): numeric bp/ap + bs/as + t.
          quotes[s] = { bp: +(mid * 0.9995).toFixed(6), bs: 0.01, ap: +(mid * 1.0005).toFixed(6), as: 0.01, t };
        }
        return response({ quotes });
      }
    }
    return response({ message: `unexpected ${host}${path}` }, 500);
  }
  const service = createCryptoService({
    db, vault, fetch: fakeFetch, now: () => world.time,
    persistenceReady: () => true, durability: null,
    exitPoll: { tries: 3, intervalMs: 0 },
  });
  return { db, service, world };
}

async function connectAndGet(f) {
  await f.service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8) });
}
function seedOpenPosition(db, overrides = {}) {
  const row = {
    position_id: 'pos-test-1', user_id: 1, symbol: BREAKOUT_SYMBOL,
    qty: 4.9, entry_price: 101.5, stop_price: 98.5,
    entry_atr: 1.5, entry_rvol: 3.0, entry_score: 83, regime_at_entry: 'bullish',
    breakout_level: 100.2, highest_price: 101.5, trailing_mult: 2.5,
    status: 'open', opened_at: new Date(NOW - 3600000).toISOString(),
    updated_at: new Date(NOW).toISOString(), entry_order_id: 'ord-1',
    ...overrides,
  };
  db.prepare(`INSERT INTO crypto_positions(position_id,user_id,symbol,qty,entry_price,stop_price,
    entry_atr,entry_rvol,entry_score,regime_at_entry,breakout_level,highest_price,
    trailing_mult,status,opened_at,updated_at,entry_order_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.position_id, row.user_id, row.symbol, row.qty, row.entry_price, row.stop_price,
      row.entry_atr, row.entry_rvol, row.entry_score, row.regime_at_entry, row.breakout_level,
      row.highest_price, row.trailing_mult, row.status, row.opened_at, row.updated_at, row.entry_order_id);
  return row;
}

test('crypto schema creates every crypto_* table', () => {
  const { db } = fixture();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'crypto_%' ORDER BY name")
    .all().map(r => r.name);
  for (const expected of ['crypto_settings', 'crypto_credentials', 'crypto_universe', 'crypto_breakouts',
    'crypto_opportunities', 'crypto_scan_runs', 'crypto_positions', 'crypto_trades', 'crypto_alerts',
    'crypto_backtests', 'crypto_backtest_trades', 'crypto_leases']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
});

test('connect links a dedicated paper account with the crypto scope and enables the scanner', async () => {
  const f = fixture();
  const status = await f.service.connect(1, { key: 'key-abc', secret: 'secret-xyz' });
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'paper');
  assert.equal(status.enabled, true);
  assert.equal(status.accountId, 'acct-crypto-test');
  const owner = f.db.prepare("SELECT * FROM broker_account_owners WHERE scope='crypto'").get();
  assert.equal(owner.account_id, 'acct-crypto-test');
  assert.equal(owner.user_id, 1);
  assert.equal(owner.mode, 'paper');
});

test('connect rejects an account already claimed by another user', async () => {
  const f = fixture();
  await connectAndGet(f);
  // The same Alpaca account is claimed by another user under the crypto
  // scope — user 1 reconnecting must fail loudly, never steal the claim.
  f.db.prepare("INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at) VALUES (?,?,?,?,?)")
    .run('acct-claimed', 2, 'crypto', 'paper', new Date(NOW).toISOString());
  const originalAssets = f.world.assets;
  f.world.assets = [{ symbol: 'BTC/USD', class: 'crypto', status: 'active', tradable: true }];
  // Point this fixture's account endpoint at the claimed account id.
  const svc = createCryptoService({
    db: f.db,
    vault: createCredentialVault('test-only-secret-never-a-real-credential-123456789'),
    fetch: async (url, init) => {
      if (String(url).includes('/v2/account')) {
        return { ok: true, status: 200, json: async () => ({
          id: 'acct-claimed', status: 'ACTIVE', trading_blocked: false,
          account_blocked: false, trade_suspended_by_user: false,
          equity: '100000', buying_power: '100000',
        }) };
      }
      throw new Error('unexpected broker call in collision test: ' + url);
    },
    now: () => NOW,
    persistenceReady: () => true,
    durability: null,
    exitPoll: { tries: 1, intervalMs: 0 },
  });
  await assert.rejects(
    svc.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8) }),
    /already assigned/i,
    'a claimed account must never be silently re-claimed',
  );
  f.world.assets = originalAssets;
});

test('settings default to paper-only with no live_armed column', () => {
  const f = fixture();
  const view = f.service.settings(1);
  assert.equal(view.rules.tradingMode, undefined, 'no tradingMode key exists');
  assert.match(view.paperNote, /paper-only/);
  const sql = f.db.prepare("SELECT sql FROM sqlite_master WHERE name='crypto_settings'").get().sql;
  assert.ok(!/live_armed/i.test(sql), 'crypto_settings must have no live_armed column');
  assert.deepEqual(view.exitReasons, [...EXIT_REASONS]);
});

test('any live activation attempt is refused loudly (paper-only)', async () => {
  const f = fixture();
  await connectAndGet(f);
  await assert.rejects(
    f.service.updateSettings(1, { rules: { tradingMode: 'LIVE' } }),
    /paper-only/i,
    'setting tradingMode=LIVE must throw loudly',
  );
  await assert.rejects(
    f.service.updateSettings(1, { rules: { liveEnabled: true, liveConfirmed: true } }),
    /paper-only/i,
  );
  const status = await f.service.status(1);
  assert.equal(status.mode, 'paper');
  assert.ok(!status.blockers.some(b => /LIVE/i.test(b)), 'no LIVE blockers — live was never a mode');
});

test('run() scans 24/7 with no market-hours gate and auto-enters the breakout', async () => {
  const f = fixture();
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(result.scan, 'a scan ran');
  assert.equal(result.scan.funnel.opportunities, 1, 'one breakout opportunity found');
  assert.equal(result.entry.entered, 1, 'the entry was fully automated — no approval step');
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  const entries = posts.filter(c => c.body?.side === 'buy' && c.body?.type === 'market');
  assert.equal(entries.length, 1, 'exactly one entry order submitted');
  assert.ok(entries[0].body.notional > 0, 'crypto entries use notional (fractional) sizing');
  assert.equal(entries[0].body.symbol, BREAKOUT_SYMBOL);
  const ocos = posts.filter(c => c.body?.order_class === 'oco' || c.body?.order_class === 'bracket');
  assert.equal(ocos.length, 0, 'Alpaca crypto rejects OCO/bracket (42210000) — protection is software-managed');
  const plainStops = posts.filter(c => c.body?.type === 'stop');
  assert.equal(plainStops.length, 0, 'plain stop orders are unsupported for Alpaca crypto — the runner is a stop_limit');
  const tps = posts.filter(c => c.body?.type === 'limit' && c.body?.side === 'sell' && /^tp-/.test(c.body?.client_order_id || ''));
  assert.equal(tps.length, 3, 'one limit take-profit per scale-out tier (3 tiers)');
  const runner = posts.filter(c => c.body?.type === 'stop_limit' && /^sl-/.test(c.body?.client_order_id || ''));
  assert.equal(runner.length, 1, 'one stop_limit runner for the remainder (the only broker-side stop crypto supports)');
  for (const p of posts) {
    assert.equal(p.body.time_in_force, 'gtc', `crypto orders use gtc TIF (got ${p.body.time_in_force})`);
  }
  const pos = f.db.prepare("SELECT * FROM crypto_positions WHERE symbol=? AND status='open'").get(BREAKOUT_SYMBOL);
  assert.ok(pos, 'position row is open');
  assert.ok(Number(pos.entry_price) > 0 && Number(pos.stop_price) < Number(pos.entry_price), 'stop sits below entry');
  const opp = f.db.prepare("SELECT * FROM crypto_opportunities WHERE symbol=?").get(BREAKOUT_SYMBOL);
  assert.equal(opp.status, 'entered');
  assert.ok(Number(opp.score) >= 75, `opportunity score ${opp.score} meets the 75 minimum`);
});

test('universe excludes stablecoins and PAXG by default, auto-adds valid assets', async () => {
  const f = fixture();
  await connectAndGet(f);
  await f.service.run(1);
  const symbols = f.db.prepare('SELECT symbol FROM crypto_universe ORDER BY symbol').all().map(r => r.symbol);
  assert.ok(symbols.includes('BTC/USD'), 'BTC/USD in universe');
  assert.ok(symbols.includes('ETH/USD'), 'ETH/USD in universe');
  assert.ok(symbols.includes('SOL/USD'), 'SOL/USD in universe');
  assert.ok(!symbols.includes('USDC/USD'), 'USDC excluded by default');
  assert.ok(!symbols.includes('PAXG/USD'), 'PAXG excluded by default');
  assert.ok(!symbols.includes('DOGE'), 'non /USD symbols excluded');
  // Enabling the toggles admits them on the next refresh.
  await f.service.updateSettings(1, { rules: { stablecoinsEnabled: true, paxgEnabled: true } });
  f.db.prepare('UPDATE crypto_universe SET last_validated=?').run(new Date(NOW - 7 * 3600000).toISOString());
  await f.service.run(1);
  const after = f.db.prepare('SELECT symbol FROM crypto_universe ORDER BY symbol').all().map(r => r.symbol);
  assert.ok(after.includes('USDC/USD'), 'USDC admitted when stablecoinsEnabled');
  assert.ok(after.includes('PAXG/USD'), 'PAXG admitted when paxgEnabled');
});

test('entry is idempotent — a working entry order is adopted, never duplicated', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.autoFillEntries = false; // leave the entry working
  await f.service.run(1);
  const first = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST' && c.body?.side === 'buy');
  assert.equal(first.length, 1);
  // The entry stays working (never filled) — the unconfirmed fill leaves no
  // position row, and a second cycle adopts the working order instead of
  // resubmitting it.
  await f.service.run(1);
  const second = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST' && c.body?.side === 'buy');
  assert.equal(second.length, 1, 'no duplicate entry while the first is working');
});

test('a filled tier take-profit banks PARTIAL_PROFIT and resizes the runner', async () => {
  const f = fixture();
  await connectAndGet(f);
  await f.service.run(1); // entry + protection attached
  const pos = f.db.prepare("SELECT * FROM crypto_positions WHERE symbol=? AND status='open'").get(BREAKOUT_SYMBOL);
  assert.ok(pos, 'position open after entry');
  const tpId = `tp-${pos.position_id}-t0`;
  const tp = f.world.orders.get(tpId);
  assert.ok(tp, 'tier-0 take-profit exists');
  assert.equal(tp.type, 'limit', 'take-profits are standalone limit sells (no OCO)');
  assert.equal(tp.time_in_force, 'gtc');
  // The broker fills the take-profit.
  tp.status = 'filled';
  tp.filled_qty = tp.qty;
  tp.filled_avg_price = String(Number(pos.entry_price) * 1.02);
  f.world.positions = [{ symbol: BREAKOUT_SYMBOL, qty: String(pos.qty), avg_entry_price: String(pos.entry_price), current_price: String(pos.entry_price) }];
  await f.service.run(1);
  const trade = f.db.prepare("SELECT * FROM crypto_trades WHERE exitReason='PARTIAL_PROFIT'").get();
  assert.ok(trade, 'partial profit journaled');
  assert.ok(Number(trade.pnl) > 0, 'banked P&L is positive');
  const row = f.db.prepare('SELECT * FROM crypto_positions WHERE position_id=?').get(pos.position_id);
  assert.equal(row.status, 'open', 'runner stays open');
  assert.ok(Number(row.banked_pnl) > 0, 'banked P&L recorded on the position');
  assert.ok(Number(row.qty) < Number(pos.qty), 'position quantity reduced by the tier');
  // The runner stop was cancel-and-replaced for the smaller quantity:
  // exactly one live runner, and total open sells never exceed the position.
  const live = [...f.world.orders.values()].filter(o => !['filled', 'canceled', 'expired', 'rejected'].includes(o.status));
  const runners = live.filter(o => /^sl-/.test(o.client_order_id || ''));
  assert.equal(runners.length, 1, 'exactly one live runner stop after the resize');
  const liveTps = live.filter(o => /^tp-/.test(o.client_order_id || ''));
  const totalSell = liveTps.reduce((s, o) => s + Number(o.qty), 0) + Number(runners[0].qty);
  assert.ok(totalSell <= Number(row.qty) + 1e-6,
    `open sells (${totalSell}) must not exceed the position (${row.qty})`);
});

test('a trailing ratchet cancel-and-replaces the runner stop (broker-truth-safe)', async () => {
  const f = fixture();
  await connectAndGet(f);
  await f.service.run(1);
  const pos = f.db.prepare("SELECT * FROM crypto_positions WHERE symbol=? AND status='open'").get(BREAKOUT_SYMBOL);
  assert.ok(pos, 'position open after entry');
  const oldRunnerId = `sl-${pos.position_id}-g1`;
  assert.ok(f.world.orders.get(oldRunnerId), 'initial runner stop exists');
  // Price runs: the quote mid jumps, so the ATR trailing line ratchets up.
  f.world.positions = [{ symbol: BREAKOUT_SYMBOL, qty: String(pos.qty), avg_entry_price: String(pos.entry_price), current_price: '110' }];
  f.world.entryPrice = 110;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM crypto_positions WHERE position_id=?').get(pos.position_id);
  assert.ok(Number(row.stop_price) > Number(pos.stop_price), 'local stop ratcheted up');
  assert.equal(f.world.orders.get(oldRunnerId).status, 'canceled', 'the stale runner was canceled first');
  const live = [...f.world.orders.values()].filter(o => !['filled', 'canceled', 'expired', 'rejected'].includes(o.status));
  const runners = live.filter(o => /^sl-/.test(o.client_order_id || ''));
  assert.equal(runners.length, 1, 'exactly one live runner — never two');
  assert.ok(Math.abs(Number(runners[0].stop_price) - Number(row.stop_price)) < 1e-6,
    'the live runner carries the new stop');
  assert.equal(runners[0].time_in_force, 'gtc');
});

test('a filled runner stop closes the position as a stop exit', async () => {
  const f = fixture();
  await connectAndGet(f);
  await f.service.run(1);
  const pos = f.db.prepare("SELECT * FROM crypto_positions WHERE symbol=? AND status='open'").get(BREAKOUT_SYMBOL);
  assert.ok(pos, 'position open after entry');
  // The broker fills the runner stop.
  const runner = f.world.orders.get(`sl-${pos.position_id}-g1`);
  assert.ok(runner, 'runner stop exists');
  runner.status = 'filled';
  runner.filled_qty = runner.qty;
  runner.filled_avg_price = String(Number(pos.stop_price));
  f.world.positions = [{ symbol: BREAKOUT_SYMBOL, qty: String(pos.qty), avg_entry_price: String(pos.entry_price), current_price: String(pos.stop_price) }];
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM crypto_positions WHERE position_id=?').get(pos.position_id);
  assert.equal(row.status, 'closed', 'position closed');
  const trade = f.db.prepare("SELECT * FROM crypto_trades WHERE symbol=? AND exitReason IN ('STOP_LOSS','TRAILING_STOP')").get(BREAKOUT_SYMBOL);
  assert.ok(trade, 'exit journaled');
  assert.ok(['STOP_LOSS', 'TRAILING_STOP'].includes(trade.exitReason), `stop exit reason (got ${trade.exitReason})`);
  assert.ok(Number(trade.exitPrice) > 0, 'exit price came from the broker fill — never fabricated');
});

test('a failed positions fetch pauses reconciliation without touching local state', async () => {
  const f = fixture();
  await connectAndGet(f);
  seedOpenPosition(f.db);
  f.world.positionsError = true;
  const result = await f.service.run(1);
  assert.equal(result.reconcile.paused, true);
  const row = f.db.prepare('SELECT status FROM crypto_positions WHERE position_id=?').get('pos-test-1');
  assert.equal(row.status, 'open');
  assert.equal(f.db.prepare('SELECT COUNT(*) c FROM crypto_trades').get().c, 0);
  const settings = f.db.prepare('SELECT scheduler_status FROM crypto_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'error');
});

test('emergency stop flattens positions with MANUAL_EXIT and halts new entries', async () => {
  const f = fixture();
  await connectAndGet(f);
  seedOpenPosition(f.db);
  f.world.positions = [{ symbol: BREAKOUT_SYMBOL, qty: '4.9', avg_entry_price: '101.5', current_price: '102' }];
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 102;
  const stopped = await f.service.emergencyStop(1);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.emergencyStop, true);
  assert.deepEqual(stopped.flattened, [BREAKOUT_SYMBOL]);
  const trade = f.db.prepare("SELECT * FROM crypto_trades WHERE exitReason='MANUAL_EXIT'").get();
  assert.ok(trade, 'flatten journaled as MANUAL_EXIT');
  assert.ok(Number(trade.pnl) > 0, 'profitable flatten recorded');
  const status = await f.service.status(1);
  assert.equal(status.emergencyStop, true);
  assert.ok(status.blockers.some(b => /Emergency stop/i.test(b)));
  // New entries are halted while the stop is active.
  const callsBefore = f.world.calls.length;
  const result = await f.service.run(1);
  assert.equal(result.halted, true);
  const buys = f.world.calls.slice(callsBefore).filter(c => c.path === '/v2/orders' && c.method === 'POST' && c.body?.side === 'buy');
  assert.equal(buys.length, 0, 'no entries while the emergency stop is active');
  // Recovery: clearing the flag re-arms the scanner.
  await f.service.updateSettings(1, { rules: { emergencyStop: false } });
  assert.equal((await f.service.status(1)).emergencyStop, false);
});

test('crypto data requests are feed-less (regression: Alpaca 400s any feed param on v1beta3 crypto)', async () => {
  const f = fixture();
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true, 'full scan/entry cycle succeeds against the real-shaped API');
  assert.equal(result.entry.entered, 1, 'the entry fired with feed-less data requests');
  const dataCalls = f.world.calls.filter(c => c.url.startsWith('https://data.alpaca.markets'));
  assert.ok(dataCalls.length > 0, 'data endpoints were exercised');
  for (const c of dataCalls) {
    assert.ok(!new URL(c.url).searchParams.has('feed'),
      `crypto data request must not carry a feed parameter: ${c.url}`);
  }
});

test('backtest fails closed when the broker is not connected', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.backtest(1, { symbols: [BREAKOUT_SYMBOL], days: 5 }),
    error => error instanceof CryptoError && /connect/i.test(error.message),
    'backtests must never fabricate bars or run without a dedicated broker account',
  );
});

test('backtest replays real historical bars and persists the report', async () => {
  const f = fixture();
  await connectAndGet(f);
  const result = await f.service.backtest(1, { symbols: [BREAKOUT_SYMBOL], days: 5 });
  assert.ok(result.backtestId, 'backtest id returned');
  assert.ok(result.report && typeof result.report === 'object', 'engine report returned');
  assert.ok(result.report.trades >= 1, `expected >=1 backtest trade, got ${result.report.trades}`);
  assert.ok(result.report.byExitReason && typeof result.report.byExitReason === 'object', 'exit reasons tallied');
  assert.deepEqual(result.dataErrors, {}, 'no symbol data errors');
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 0, 'backtests never submit broker orders');
  const listed = f.service.getBacktests(1);
  assert.ok(listed.backtests.some(b => b.backtestId === result.backtestId), 'backtest listed');
  const detail = f.service.getBacktest(1, result.backtestId);
  assert.equal(detail.backtestId, result.backtestId);
  assert.ok(Array.isArray(detail.trades), 'backtest trades persisted');
  assert.deepEqual(detail.params.symbols, [BREAKOUT_SYMBOL]);
});

test('backtest clamps its inputs and dedupes symbols', async () => {
  const f = fixture();
  await connectAndGet(f);
  const result = await f.service.backtest(1, { symbols: [BREAKOUT_SYMBOL, BREAKOUT_SYMBOL], days: 2 });
  const listed = f.service.getBacktests(1);
  const row = listed.backtests.find(b => b.backtestId === result.backtestId);
  assert.deepEqual(row.params.symbols, [BREAKOUT_SYMBOL], 'duplicate symbols are deduped');
  assert.equal(row.params.days, 5, 'days below the floor clamp to 5');
});

test('paper stats report win rate, profit factor and drawdown', async () => {
  const f = fixture();
  await connectAndGet(f);
  const mk = (id, pnl, at) => f.db.prepare(`INSERT INTO crypto_trades(user_id,tradeId,symbol,date,enteredAt,exitedAt,pnl,created_at)
    VALUES (1,?,?,?,'2026-09-29T10:00:00Z',?,?,?)`)
    .run(id, BREAKOUT_SYMBOL, TODAY, at, String(pnl), new Date(NOW).toISOString());
  mk('t1', 100, '2026-09-29T11:00:00Z');
  mk('t2', -40, '2026-09-29T12:00:00Z');
  mk('t3', 60, '2026-09-29T13:00:00Z');
  const status = await f.service.status(1);
  assert.equal(status.paper.tradeCount, 3);
  assert.ok(Math.abs(status.paper.winRate - 2 / 3) < 1e-9, 'win rate 2/3');
  assert.ok(Math.abs(status.paper.profitFactor - 4) < 1e-9, 'profit factor 160/40 = 4');
  assert.equal(status.paper.netPnl, 120);
  assert.ok(status.paper.maxDrawdown >= 40, 'drawdown captures the 100→60 dip');
});

test('exit reasons are the explicit 12-reason set', () => {
  assert.deepEqual([...EXIT_REASONS], [
    'TAKE_PROFIT', 'PARTIAL_PROFIT', 'VOLUME_FADE', 'MOMENTUM_EXHAUSTION',
    'TRAILING_STOP', 'STOP_LOSS', 'BREAKOUT_FAILURE', 'VWAP_LOSS',
    'EMA_BREAKDOWN', 'BEARISH_REVERSAL', 'MARKET_REGIME_CHANGE', 'MANUAL_EXIT',
  ]);
});

test('mountCrypto exposes exactly the contracted routes under /api/crypto', async () => {
  const { mountCrypto } = require('../lib/crypto/service');
  const routes = {};
  const fakeApp = {
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
    put: (p, ...h) => { routes[`PUT ${p}`] = h; },
    delete: (p, ...h) => { routes[`DELETE ${p}`] = h; },
  };
  const service = { status: async uid => ({ ok: true, uid }) };
  mountCrypto({ app: fakeApp, service, requireAuth: (req, res, next) => next() });
  for (const expected of [
    'GET /api/crypto/status', 'POST /api/crypto/connect', 'POST /api/crypto/disconnect',
    'GET /api/crypto/universe', 'GET /api/crypto/opportunities', 'GET /api/crypto/positions',
    'GET /api/crypto/trades', 'GET /api/crypto/alerts', 'GET /api/crypto/settings',
    'PUT /api/crypto/settings', 'POST /api/crypto/backtest', 'POST /api/crypto/emergency-stop',
  ]) {
    assert.ok(routes[expected], `route mounted: ${expected}`);
  }
  const handlers = routes['GET /api/crypto/status'];
  const wrapped = handlers[handlers.length - 1];
  let jsonBody = Symbol('unset');
  const res = {
    headersSent: false,
    json(body) { jsonBody = body; this.headersSent = true; return this; },
    status() { return this; },
  };
  await wrapped({ session: { userId: 7 } }, res, () => {});
  assert.deepEqual(jsonBody, { ok: true, uid: 7 }, 'the handler result reaches res.json');
});

test('disconnect is blocked while a position is open', async () => {
  const f = fixture();
  await connectAndGet(f);
  seedOpenPosition(f.db);
  await assert.rejects(() => f.service.disconnect(1), /flatten/i);
});

test('entryGates: bearish-regime pump carve-out (2026-10-07)', async () => {
  const f = fixture();
  await connectAndGet(f);
  const base = {
    uid: 1, rules: DEFAULT_CRYPTO_RULES,
    stats: { dayPnl: 0, consecutiveLosses: 0, openPositions: 0, tradesLastHour: 0, equity: 100000 },
    account: { equity: 100000 }, quote: { mid: 50, bid: 49.99, ask: 50.01 },
    symbol: 'SOL/USD', notional: 750, spreadPct: 0.1,
  };
  // Ordinary alt setup in a bearish regime: still withheld.
  const plain = f.service.entryGates({ ...base, regime: 'bearish', score: 70, rvol: 1.8 });
  assert.ok(plain.reasons.some(r => /altcoin longs withheld/.test(r)));
  // Exceptional pump (score >= highQuality, rvol >= rvolStrong): allowed.
  const pump = f.service.entryGates({ ...base, regime: 'bearish', score: 90, rvol: 3.5 });
  assert.ok(!pump.reasons.some(r => /altcoin longs withheld/.test(r)));
  // High volatility stays fully blocked, even for an exceptional setup.
  const chaos = f.service.entryGates({ ...base, regime: 'high_volatility', score: 95, rvol: 5 });
  assert.ok(chaos.reasons.some(r => /altcoin longs withheld/.test(r)));
  // BTC itself is never regime-blocked.
  const btc = f.service.entryGates({ ...base, symbol: 'BTC/USD', regime: 'bearish', score: 70, rvol: 1.8 });
  assert.ok(!btc.reasons.some(r => /altcoin longs withheld/.test(r)));
});

test('broker errors surface the Alpaca code and message (2026-10-07)', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO users(id) VALUES (1);
    CREATE TABLE broker_account_owners(account_id TEXT PRIMARY KEY, user_id INTEGER, scope TEXT, mode TEXT, claimed_at TEXT);
    CREATE TABLE broker_account_quarantine(account_id TEXT PRIMARY KEY, resolved_at TEXT);
    CREATE TABLE automated_action_intents(id INTEGER PRIMARY KEY AUTOINCREMENT, strategy TEXT, user_id INTEGER,
      account_id TEXT, mode TEXT, method TEXT, path TEXT, purpose TEXT, client_order_id TEXT,
      request_json TEXT, state TEXT, broker_order_id TEXT, last_error TEXT, updated_at TEXT);
  `);
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-123456789');
  const service = createCryptoService({
    db, vault,
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ code: 40310000, message: 'crypto trading is not permitted for this account' }) }),
    persistenceReady: () => true, durability: null,
  });
  await assert.rejects(
    () => service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8) }),
    /HTTP 403.*crypto trading is not permitted for this account \(code 40310000\)/);
});

test('reconcile recovers a vanished position exit from broker order history', async () => {
  const f = fixture();
  await connectAndGet(f);
  const pos = seedOpenPosition(f.db);
  f.world.positions = []; // broker is flat — the position vanished
  // A filled sell for the full quantity sits in order history under a
  // foreign client id (e.g. the position was closed outside the bot).
  f.world.orders.set('external-close-1', {
    id: 'ord-ext-1', client_order_id: 'external-close-1', symbol: BREAKOUT_SYMBOL,
    side: 'sell', type: 'market', status: 'filled',
    filled_qty: String(pos.qty), filled_avg_price: '99.25',
  });
  await f.service.run(1);
  const trades = f.service.trades(1).trades;
  assert.equal(trades.length, 1);
  assert.equal(Number(trades[0].exitPrice), 99.25);
  assert.equal(trades[0].exitReason, 'MANUAL_EXIT');
  assert.ok(/recovered from broker order history/.test(trades[0].exitDetail || ''));
});
