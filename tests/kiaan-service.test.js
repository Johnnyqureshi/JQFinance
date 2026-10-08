'use strict';

// Kiaan Bot service tests — schema, connect/ownership/paper-only guards,
// settings validation, regime-first scan cycles through the real engine
// (risk-on entry with Warrior-style OCO protection, risk-off hedge-only,
// chop stand-aside journaled, unknown regime on VIX failure, sub-penny
// price safety, daily locks, EOD flatten).
// Fixture mirrors orb-service.test.js: in-memory better-sqlite3, real
// credential vault, fake broker/Yahoo fetch. No network.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const {
  createKiaanService, mountKiaan, KiaanError, DEFAULT_KIAAN_RULES,
} = require('../lib/kiaan/service');
const { createCredentialVault } = require('../lib/credential-vault');

const NOW = Date.parse('2026-10-01T14:30:00Z'); // Thu 10:30 ET — entry window
const TRADE_DATE = '2026-10-01';
const clone = value => JSON.parse(JSON.stringify(value));
const iso = ms => new Date(ms).toISOString();

// --- synthetic market data --------------------------------------------------
// Risk-on day (score +6): SPY +0.78% & trend up, QQQ +0.58% & trend up,
// VIX 14 (calm) and falling 12.5% on the day (Yahoo closes 16 → 14).
// AAA: prev close 9.85, last price 10.07 (+2.23% day, RS +1.45 pts),
// OR (9:30–9:44) high 10.05 broken, pace RVOL ~5x, ATR 0.20, spread 0.1%.
function dailyFlat(close, vol = 1000000, h = null, l = null) {
  const bars = [];
  let dayMs = Date.parse('2026-09-01T13:30:00Z');
  for (let i = 0; i < 29; i++) {
    bars.push({ t: iso(dayMs), o: close, h: h ?? close + 0.1, l: l ?? close - 0.1, c: close, v: vol });
    dayMs += 86400000;
  }
  return bars;
}
function dailyAAA() {
  const bars = dailyFlat(9.85);
  bars.push({ t: iso(Date.parse('2026-10-01T13:30:00Z')), o: 9.9, h: 10.07, l: 9.88, c: 10.07, v: 500000 });
  return bars;
}
function dailyIndex(prevClose, lastClose) {
  return [
    { t: iso(Date.parse('2026-09-30T13:30:00Z')), o: prevClose, h: prevClose * 1.002, l: prevClose * 0.998, c: prevClose, v: 50000000 },
    { t: iso(Date.parse('2026-10-01T13:30:00Z')), o: prevClose, h: lastClose * 1.001, l: prevClose * 0.999, c: lastClose, v: 52000000 },
  ];
}
function driftMinutes({ open, last, count = 60, orHigh = null, orLow = null, vol = 10000, orVol = 20000, breakVol = 30000 }) {
  const bars = [];
  const base = Date.parse('2026-10-01T13:30:00Z'); // 9:30 ET
  for (let i = 0; i < count; i++) {
    const frac = count > 1 ? i / (count - 1) : 0;
    const c = +(open + (last - open) * frac).toFixed(4);
    const isOr = i < 15;
    bars.push({
      t: iso(base + i * 60000),
      o: i === 0 ? open : bars[i - 1].c,
      h: isOr && orHigh != null ? Math.max(c, orHigh - (i === 3 ? 0 : 0.03)) : +(c + 0.01).toFixed(4),
      l: isOr && orLow != null ? Math.min(c, orLow + (i === 2 ? 0 : 0.03)) : +(c - 0.01).toFixed(4),
      c,
      v: isOr ? orVol : (i === 15 ? breakVol : vol),
    });
  }
  return bars;
}
function minutesAAA() {
  return driftMinutes({ open: 9.95, last: 10.07, orHigh: 10.05, orLow: 9.88 });
}
function minutesSQQQ() {
  return driftMinutes({ open: 10.0, last: 10.3, orHigh: 10.05, orLow: 9.9, vol: 20000, orVol: 30000, breakVol: 40000 });
}
function dailySQQQ() {
  const bars = dailyFlat(9.9, 2000000, 10.0, 9.8);
  bars.push({ t: iso(Date.parse('2026-10-01T13:30:00Z')), o: 10.0, h: 10.3, l: 9.95, c: 10.3, v: 900000 });
  return bars;
}
function minutesPEN() {
  return driftMinutes({ open: 0.495, last: 0.5055, orHigh: 0.5, orLow: 0.488, vol: 20000, orVol: 30000, breakVol: 40000 });
}
function dailyPEN() {
  const bars = dailyFlat(0.49, 1000000, 0.5, 0.48);
  bars.push({ t: iso(Date.parse('2026-10-01T13:30:00Z')), o: 0.495, h: 0.5055, l: 0.49, c: 0.5055, v: 600000 });
  return bars;
}

const SCENARIOS = {
  riskon: {
    assets: ['AAA'],
    daily: { AAA: dailyAAA(), SPY: dailyIndex(770, 776), QQQ: dailyIndex(690, 694) },
    minutes: {
      AAA: minutesAAA(),
      SPY: driftMinutes({ open: 770.5, last: 776.2, vol: 100000 }),
      QQQ: driftMinutes({ open: 690.5, last: 694.2, vol: 100000 }),
    },
    latest: { AAA: 10.07 },
    quotes: { AAA: [10.065, 10.075] },
    yahoo: { '^VIX': [16, 14], '^TNX': [5.3, 5.35], 'CL=F': [92, 93] },
  },
  chop: {
    assets: ['AAA'],
    daily: { AAA: dailyAAA(), SPY: dailyIndex(770, 771), QQQ: dailyIndex(690, 690.5) },
    minutes: {
      AAA: minutesAAA(),
      SPY: driftMinutes({ open: 770.5, last: 770.6, vol: 100000 }),
      QQQ: driftMinutes({ open: 690.4, last: 690.45, vol: 100000 }),
    },
    latest: { AAA: 10.07 },
    quotes: { AAA: [10.065, 10.075] },
    yahoo: { '^VIX': [18.2, 18], '^TNX': [5.3, 5.31], 'CL=F': [92, 92.2] },
  },
  riskoff: {
    assets: ['AAA', 'SQQQ'],
    daily: { AAA: dailyAAA(), SQQQ: dailySQQQ(), SPY: dailyIndex(770, 758), QQQ: dailyIndex(690, 679) },
    minutes: {
      AAA: minutesAAA(),
      SQQQ: minutesSQQQ(),
      SPY: driftMinutes({ open: 769, last: 758.2, vol: 100000 }),
      QQQ: driftMinutes({ open: 689, last: 679.3, vol: 100000 }),
    },
    latest: { AAA: 10.07, SQQQ: 10.3 },
    quotes: { AAA: [10.065, 10.075], SQQQ: [10.29, 10.31] },
    yahoo: { '^VIX': [24, 28], '^TNX': [5.3, 5.36], 'CL=F': [92, 93] },
  },
  penny: {
    assets: ['PEN'],
    daily: { PEN: dailyPEN(), SPY: dailyIndex(770, 776), QQQ: dailyIndex(690, 694) },
    minutes: {
      PEN: minutesPEN(),
      SPY: driftMinutes({ open: 770.5, last: 776.2, vol: 100000 }),
      QQQ: driftMinutes({ open: 690.5, last: 694.2, vol: 100000 }),
    },
    latest: { PEN: 0.5055 },
    quotes: { PEN: [0.505, 0.506] },
    yahoo: { '^VIX': [16, 14], '^TNX': [5.3, 5.35], 'CL=F': [92, 93] },
  },
};

function decimalsOf(n) {
  const s = String(n);
  const idx = s.indexOf('.');
  return idx < 0 ? 0 : s.length - idx - 1;
}
function subPennyViolation(body) {
  // Real Alpaca rule: prices ≥ $1 need ≤2 decimals; below $1, ≤4 decimals.
  const fields = [body.limit_price, body.stop_price, body.take_profit?.limit_price, body.stop_loss?.stop_price];
  for (const p of fields) {
    if (p == null) continue;
    const maxDec = p >= 1 ? 2 : 4;
    if (decimalsOf(p) > maxDec) return p;
  }
  return null;
}

function fixture(scenario = 'riskon', options = {}) {
  const sc = SCENARIOS[scenario];
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO users(id) VALUES (1);
    CREATE TABLE broker_account_owners(account_id TEXT PRIMARY KEY, user_id INTEGER, scope TEXT, mode TEXT, claimed_at TEXT);
    CREATE TABLE broker_account_quarantine(account_id TEXT PRIMARY KEY, resolved_at TEXT);
  `);
  const vault = createCredentialVault('test-only-secret-never-a-real-credential-987654321');
  const world = {
    time: NOW, calls: [], orderPosts: [], orderBook: {}, orderSeq: 0,
    brokerPositions: [], protectionFills: {}, exitPrice: 10.2,
    subPennyRejections: 0, macroFails: false, accountId: 'acct-kiaan-test',
    ...options,
  };
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value) });
  const assetRow = s => ({
    symbol: s, class: 'us_equity', status: 'active', tradable: true,
    exchange: 'NASDAQ', name: `${s} Corp`, shortable: true, easy_to_borrow: true,
  });
  async function fakeFetch(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const query = parsed.searchParams;
    const method = init.method || 'GET';
    world.calls.push({ url, path, method });
    if (parsed.hostname === 'query1.finance.yahoo.com') {
      if (world.macroFails) return response({ message: 'yahoo down' }, 500);
      const symbol = decodeURIComponent(path.split('/').pop());
      const closes = sc.yahoo[symbol];
      if (!closes) return response({ message: 'unknown symbol' }, 404);
      return response({ chart: { result: [{ indicators: { quote: [{ close: closes }] } }] } });
    }
    if (parsed.hostname === 'paper-api.alpaca.markets') {
      if (path === '/v2/account' && method === 'GET') return response({
        id: world.accountId, status: 'ACTIVE', trading_blocked: false,
        account_blocked: false, trade_suspended_by_user: false,
        equity: '100000', buying_power: '100000', last_equity: '100000',
      });
      if (path === '/v2/calendar') return response([{ date: TRADE_DATE, open: '09:30', close: '16:00' }]);
      if (path === '/v2/clock') return response({ timestamp: iso(world.time), is_open: true });
      if (path === '/v2/assets') return response(sc.assets.map(assetRow));
      if (path === '/v2/positions') return response(world.brokerPositions);
      if (path.startsWith('/v2/orders:by_client_order_id')) {
        const id = query.get('client_order_id');
        const order = world.orderBook[id];
        if (!order) return response({ code: 40410000, message: 'order not found' }, 404);
        if (order.status === 'canceled') return response({ ...order });
        if (order.side === 'buy') {
          return response({ ...order, status: 'filled', filled_qty: order.qty, filled_avg_price: order.limit_price });
        }
        if (order.type === 'market') {
          return response({ ...order, status: 'filled', filled_qty: order.qty, filled_avg_price: world.exitPrice });
        }
        const pf = world.protectionFills[id];
        if (pf) return response({ ...order, status: 'filled', filled_qty: pf.qty ?? order.qty, filled_avg_price: pf.price });
        return response({ ...order });
      }
      if (path === '/v2/orders' && method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        const bad = subPennyViolation(body);
        if (bad != null) {
          world.subPennyRejections++;
          return response({ code: 42210000, message: `invalid price ${bad}: sub-penny precision not allowed` }, 422);
        }
        world.orderPosts.push(body);
        const order = {
          id: `ord-${++world.orderSeq}`, client_order_id: body.client_order_id,
          symbol: body.symbol, qty: body.qty, side: body.side, type: body.type,
          order_class: body.order_class || 'simple', limit_price: body.limit_price ?? null,
          status: 'new', filled_qty: 0, filled_avg_price: null,
        };
        world.orderBook[body.client_order_id] = order;
        return response(order);
      }
      if (path.startsWith('/v2/orders/') && method === 'DELETE') {
        const id = path.split('/').pop();
        const order = Object.values(world.orderBook).find(o => o.id === id);
        if (order) order.status = 'canceled';
        return response(null, 204);
      }
      return response({ code: 50010000, message: `unexpected ${parsed.hostname}${path}` }, 500);
    }
    if (parsed.hostname === 'data.alpaca.markets') {
      if (path === '/v2/stocks/bars') {
        const symbols = (query.get('symbols') || '').split(',').filter(Boolean);
        const source = query.get('timeframe') === '1Min' ? sc.minutes : sc.daily;
        return response({ bars: Object.fromEntries(symbols.map(s => [s, source[s] || []])), next_page_token: null });
      }
      if (path === '/v2/stocks/bars/latest') {
        const symbols = (query.get('symbols') || '').split(',').filter(Boolean);
        const bars = {};
        for (const s of symbols) if (sc.latest[s] != null) bars[s] = { c: sc.latest[s], t: iso(world.time) };
        return response({ bars });
      }
      if (path === '/v2/stocks/quotes/latest') {
        const symbols = (query.get('symbols') || '').split(',').filter(Boolean);
        const quotes = {};
        for (const s of symbols) if (sc.quotes[s]) quotes[s] = { bp: sc.quotes[s][0], ap: sc.quotes[s][1], t: iso(world.time) };
        return response({ quotes });
      }
      return response({ code: 50010000, message: `unexpected ${parsed.hostname}${path}` }, 500);
    }
    return response({ code: 50010000, message: `unexpected host ${parsed.hostname}` }, 500);
  }
  const service = createKiaanService({
    db, vault, fetch: fakeFetch, now: () => world.time,
    persistenceReady: () => true, durability: null,
    exitPoll: { tries: 3, intervalMs: 0 },
  });
  return { db, service, world };
}

async function connectPaper(f) {
  return f.service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8) });
}
async function connectAndEnable(f) {
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true });
}

// --- schema / contract -------------------------------------------------------
test('kiaan schema creates every kiaan_* table; trades columns are exactly TRADE_FIELDS', async () => {
  const { db } = fixture();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kiaan_%' ORDER BY name")
    .all().map(r => r.name);
  for (const expected of ['kiaan_settings', 'kiaan_credentials', 'kiaan_leases', 'kiaan_positions',
    'kiaan_trades', 'kiaan_alerts', 'kiaan_decisions', 'kiaan_day_state']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  const cols = db.prepare('PRAGMA table_info(kiaan_trades)').all();
  const tradeCols = cols.filter(c => !['trade_id', 'user_id', 'created_at'].includes(c.name));
  const { TRADE_FIELDS } = require('../lib/kiaan/journal');
  assert.deepEqual(tradeCols.map(c => c.name), [...TRADE_FIELDS]);
});

test('service exposes the pinned contract surface', async () => {
  const { service } = fixture();
  for (const key of ['strategy', 'start', 'stop', 'drain', 'lifecycleStatus',
    'connect', 'disconnect', 'setSettings', 'getSettings', 'status',
    'dashboard', 'positions', 'trades', 'alerts', 'journal', 'universe', 'pruneDiagnostics']) {
    assert.ok(key in service, `missing service.${key}`);
  }
  assert.equal(service.strategy, 'kiaan');
});

test('tickPrice rounds to cents at $1+ and 4dp below $1', async () => {
  const { service } = fixture();
  assert.equal(service._tickPrice(10.07), 10.07);
  assert.equal(service._tickPrice(9.7748875), 9.77);
  assert.equal(service._tickPrice(0.47573775), 0.4757);
  assert.equal(service._tickPrice(0.56521725), 0.5652);
});

// --- connect / ownership / paper-only ---------------------------------------
test('connect claims the account for scope kiaan and ships DISABLED', async () => {
  const f = fixture();
  const out = await connectPaper(f);
  assert.equal(out.ok, true);
  const owner = f.db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get('acct-kiaan-test');
  assert.equal(owner.scope, 'kiaan');
  assert.equal(owner.mode, 'paper');
  const st = await f.service.status(1);
  assert.equal(st.connected, true);
  assert.equal(st.enabled, false);
  assert.equal(st.tradingMode, 'PAPER');
  assert.equal(st.accountId, 'acct-kiaan-test');
});

test('connect is refused when another bot already owns the account', async () => {
  const f = fixture();
  f.db.prepare('INSERT INTO broker_account_owners(account_id,user_id,scope,mode,claimed_at) VALUES (?,?,?,?,?)')
    .run('acct-kiaan-test', 1, 'orb', 'paper', iso(NOW));
  await assert.rejects(() => connectPaper(f), /already assigned to another user, mode or trading scope/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_credentials').get().n, 0);
});

test('live connect is refused loudly; settings can never select LIVE', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8), mode: 'live' }), /LIVE trading does not exist/);
  await connectPaper(f);
  await assert.rejects(() => f.service.setSettings(1, { rules: { tradingMode: 'LIVE' } }), /tradingMode must be one of PAPER/);
  await assert.rejects(() => f.service.setSettings(1, { rules: { nope: 1 } }), /Unknown setting: nope/);
  const view = await f.service.getSettings(1);
  assert.equal(view.rules.tradingMode, 'PAPER');
});

test('settings validation runs the engine validateConfig', async () => {
  const f = fixture();
  await connectPaper(f);
  await assert.rejects(
    () => f.service.setSettings(1, { rules: { entryWindowStart: '15:00', entryWindowEnd: '09:45' } }),
    /Invalid Kiaan configuration/,
  );
  const ok = await f.service.setSettings(1, { rules: { minRvol: 2 } });
  assert.equal(ok.enabled, false);
  assert.equal((await f.service.getSettings(1)).rules.minRvol, 2);
});

test('disconnect is blocked while a position is open', async () => {
  const f = fixture();
  await connectPaper(f);
  f.db.prepare(`INSERT INTO kiaan_positions(position_id,user_id,symbol,status,opened_at)
    VALUES ('pos-1',1,'AAA','open',?)`).run(iso(NOW));
  await assert.rejects(() => f.service.disconnect(1), /before disconnecting/);
});

// --- scan cycles --------------------------------------------------------------
test('risk-on scan enters the confirming leader and attaches OCO + stop protection', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].symbol, 'AAA');
  assert.equal(buys[0].qty, 49);
  assert.equal(buys[0].limit_price, 10.07);
  const oco = f.world.orderPosts.find(o => o.order_class === 'oco');
  assert.ok(oco, 'OCO protection posted');
  assert.equal(oco.qty, 24);
  assert.equal(oco.take_profit.limit_price, 10.67); // 2R target 10.6742 (ATR 0.2014 incl. today), tick-rounded with padding
  assert.equal(oco.stop_loss.stop_price, 9.77);
  const stop = f.world.orderPosts.find(o => o.type === 'stop');
  assert.ok(stop, 'stop-only order posted for the remainder tranche');
  assert.equal(stop.qty, 25);
  assert.equal(stop.stop_price, 9.77);
  assert.equal(f.world.subPennyRejections, 0);
  const pos = f.db.prepare('SELECT * FROM kiaan_positions WHERE user_id=1').get();
  assert.equal(pos.status, 'open');
  assert.equal(pos.t1_status, 'protected');
  assert.equal(pos.t2_status, 'protected');
  const trade = f.db.prepare('SELECT * FROM kiaan_trades WHERE user_id=1').get();
  assert.equal(trade.symbol, 'AAA');
  assert.equal(trade.regime, 'risk-on');
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.decision, 'seek-longs');
  assert.equal(session.regime, 'risk-on');
  const cand = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='candidate' AND symbol='AAA'").get();
  assert.equal(cand.decision, 'enter-long');
});

test('chop scan stands aside and journals the session decision; zero orders', async () => {
  const f = fixture('chop');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0);
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.regime, 'chop');
  assert.equal(session.decision, 'stand-aside');
  assert.match(session.why, /stand aside/);
});

test('VIX unreadable → regime unknown, stand aside, CONTEXT_MISSING journaled', async () => {
  const f = fixture('riskon', { macroFails: true });
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0);
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.regime, 'unknown');
  assert.equal(session.decision, 'stand-aside');
  assert.match(session.reasons, /CONTEXT_MISSING/);
});

test('risk-off: ordinary longs blocked outright, confirming hedge ETF enters', async () => {
  const f = fixture('riskoff');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].symbol, 'SQQQ');
  const aaa = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='candidate' AND symbol='AAA'").get();
  assert.equal(aaa.decision, 'no-trade');
  assert.match(aaa.reasons, /REGIME_RISK_OFF/);
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.regime, 'risk-off');
  assert.equal(session.decision, 'seek-hedges');
});

test('sub-penny name: entry + protection prices are tick-rounded, broker never 422s', async () => {
  const f = fixture('penny');
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { minPrice: 0.1 } });
  await f.service._scanCycle(1);
  assert.equal(f.world.subPennyRejections, 0);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy' && o.symbol === 'PEN');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].limit_price, 0.5055);
  const pos = f.db.prepare("SELECT * FROM kiaan_positions WHERE user_id=1 AND symbol='PEN'").get();
  assert.ok(pos, 'PEN position opened');
  assert.equal(pos.t1_status, 'protected');
  const oco = f.world.orderPosts.find(o => o.order_class === 'oco');
  assert.equal(oco.stop_loss.stop_price, 0.4762); // stop 0.4760 (ATR 0.0197 incl. today) × 1.0005, 4dp
  assert.equal(oco.take_profit.limit_price, 0.5642); // 2R target 0.5645 × 0.9995, 4dp
});

test('daily locks halt entries and the lock is journaled on the session row', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  f.db.prepare(`INSERT INTO kiaan_day_state(user_id,trade_date,state,updated_at) VALUES (1,?,?,?)`)
    .run(TRADE_DATE, JSON.stringify({ date: TRADE_DATE, pnl: -50, trades: 3, consecLosses: 3, wins: 0, losses: 3, exposureDollars: 0, tradesBySymbol: {} }), iso(NOW));
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0);
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.decision, 'stand-aside');
  assert.match(session.reasons, /CONSEC_LOSS_HALT/);
  assert.equal(JSON.parse(session.data).locked, true);
});

test('EOD flatten cancels protection and market-closes the position', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_positions').get().n, 1);
  f.world.brokerPositions = [{ symbol: 'AAA', qty: '49' }];
  f.world.exitPrice = 10.2;
  f.world.time = Date.parse('2026-10-01T19:56:00Z'); // 15:56 ET — past flattenTime
  await f.service._scanCycle(1);
  const marketSells = f.world.orderPosts.filter(o => o.side === 'sell' && o.type === 'market');
  assert.equal(marketSells.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_positions').get().n, 0);
  const trade = f.db.prepare('SELECT * FROM kiaan_trades WHERE user_id=1').get();
  assert.ok(trade.closedAt, 'trade closed');
  assert.equal(Number(trade.exitPrice), 10.2);
  assert.ok(Math.abs(Number(trade.pnl) - 6.37) < 0.01, `pnl ${trade.pnl} ≈ 6.37`);
  const dayState = JSON.parse(f.db.prepare('SELECT state FROM kiaan_day_state WHERE trade_date=?').get(TRADE_DATE).state);
  assert.equal(dayState.wins, 1);
});

test('disabled bot idles: no broker order calls, scheduler state idle', async () => {
  const f = fixture('riskon');
  await connectPaper(f);
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0);
  const settings = f.db.prepare('SELECT scheduler_status, scheduler_reason FROM kiaan_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'idle');
});

// --- routes -------------------------------------------------------------------
test('mountKiaan exposes the full route list and maps service 502 → 422', async () => {
  const { mountKiaan: mount, KiaanError: KErr } = require('../lib/kiaan/service');
  const handlers = {};
  const fakeApp = {
    get: (p, ...h) => { handlers[`GET ${p}`] = h[h.length - 1]; },
    post: (p, ...h) => { handlers[`POST ${p}`] = h[h.length - 1]; },
    put: (p, ...h) => { handlers[`PUT ${p}`] = h[h.length - 1]; },
  };
  const stub = { status: async () => { throw new KErr('Broker request failed (HTTP 500) [50010000]: boom', 502); } };
  const out = mount({ app: fakeApp, service: stub, requireAuth: (a, b) => [a, b], ensureSessionUserInTradingStore: async () => 1 });
  for (const r of ['GET /api/kiaan/status', 'POST /api/kiaan/connect', 'POST /api/kiaan/disconnect',
    'GET /api/kiaan/settings', 'PUT /api/kiaan/settings', 'GET /api/kiaan/dashboard',
    'GET /api/kiaan/positions', 'GET /api/kiaan/trades', 'GET /api/kiaan/alerts',
    'GET /api/kiaan/journal', 'GET /api/kiaan/universe']) {
    assert.ok(out.routes.includes(r), `mountKiaan exposes ${r}`);
  }
  // Invoke the status handler: a service-side 502 must surface as HTTP 422
  // with the broker code+message intact (the proxy eats origin 502 bodies).
  let statusCode = null; let payload = null;
  const res = {
    headersSent: false,
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; this.headersSent = true; return this; },
  };
  await handlers['GET /api/kiaan/status']({ session: { userId: 1 } }, res, () => {});
  assert.equal(statusCode, 422);
  assert.match(payload.error, /50010000/);
});

test('DEFAULT_KIAAN_RULES is paper-only and the error keeps broker code+message', async () => {
  assert.equal(DEFAULT_KIAAN_RULES.tradingMode, 'PAPER');
  const err = new KiaanError('Broker request failed (HTTP 422) [42210000]: sub-penny', 502);
  assert.match(err.message, /42210000/);
  assert.match(err.message, /sub-penny/);
});
