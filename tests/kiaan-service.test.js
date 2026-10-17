'use strict';

// Kiaan Bot service tests — schema, connect/ownership/mode guards,
// settings validation, regime-first scan cycles through the real engine
// (risk-on entry with OCO protection, risk-off hedge-only,
// chop stand-aside journaled, unknown regime on VIX failure, sub-penny
// price safety, daily locks, EOD flatten).
// Fixture mirrors the other bot-service tests: in-memory better-sqlite3, real
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
// Wide-range daily bars for SQQQ: every TR is exactly 2.0, so the
// daily ATR is 2.0 and the daily-geometry stop (10.30 − 1.5×2.0 = 7.30)
// makes the $50 risk cap bind hard: floor(50/3.0) = 16 shares. That is
// what proves share sizing still comes from the DAILY stop after the
// 15m geometry rebase (the intraday R is only 0.15 — sizing off it
// would allow the full floor($500/$10.30) = 48 shares).
function dailyWideSQQQ() {
  const bars = [];
  let dayMs = Date.parse('2026-09-01T13:30:00Z');
  for (let i = 0; i < 29; i++) {
    bars.push({ t: iso(dayMs), o: 9.9, h: 10.9, l: 8.9, c: 9.9, v: 2000000 });
    dayMs += 86400000;
  }
  bars.push({ t: iso(Date.parse('2026-10-01T13:30:00Z')), o: 10.0, h: 11.0, l: 9.0, c: 10.3, v: 900000 });
  return bars;
}
// 15-minute bars for SQQQ (the hedge15m scenario): two prior sessions
// plus today's first four buckets, closes stepping +0.02 with
// h = c + 0.05 / l = c − 0.05, so every true range is 0.10 and
// ATR(14) on 15m bars is 0.10 at the 10:30 ET decision time.
function bars15SQQQ() {
  const bars = [];
  let close = 9.0;
  for (const day of ['2026-09-29', '2026-09-30', '2026-10-01']) {
    const base = Date.parse(`${day}T13:30:00Z`); // 09:30 ET
    const count = day === '2026-10-01' ? 4 : 26;
    for (let i = 0; i < count; i++) {
      close = +(close + 0.02).toFixed(4);
      bars.push({
        t: iso(base + i * 15 * 60000),
        o: close, h: +(close + 0.05).toFixed(4), l: +(close - 0.05).toFixed(4), c: close, v: 50000,
      });
    }
  }
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
  // Relief-bounce guard day (2026-10-11): same risk-on tape as 'riskon'
  // (score +6), but the absolute levels are blocked — ^TNX last close
  // 5.35% ≥ 5.15 and Brent (BZ=F) last close $104.72 ≥ $100. Ordinary
  // longs must be refused; the confirming hedge (SQQQ) may enter.
  guardday: {
    assets: ['AAA', 'SQQQ'],
    daily: { AAA: dailyAAA(), SQQQ: dailySQQQ(), SPY: dailyIndex(770, 776), QQQ: dailyIndex(690, 694) },
    minutes: {
      AAA: minutesAAA(),
      SQQQ: minutesSQQQ(),
      SPY: driftMinutes({ open: 770.5, last: 776.2, vol: 100000 }),
      QQQ: driftMinutes({ open: 690.5, last: 694.2, vol: 100000 }),
    },
    latest: { AAA: 10.07, SQQQ: 10.3 },
    quotes: { AAA: [10.065, 10.075], SQQQ: [10.29, 10.31] },
    yahoo: { '^VIX': [16, 14], '^TNX': [5.3, 5.35], 'CL=F': [92, 93], 'BZ=F': [103.5, 104.72] },
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

// Intraday exit-geometry scenario (2026-10-11): the riskoff tape, but
// SQQQ carries wide daily bars (daily ATR 2.0 → risk-capped sizing of
// 16 shares) AND a full 15m series (ATR15 = 0.10 → managed stop 10.15,
// targets 10.60 / 10.75 on the intraday R of 0.15).
SCENARIOS.hedge15m = {
  assets: ['AAA', 'SQQQ'],
  daily: { AAA: dailyAAA(), SQQQ: dailyWideSQQQ(), SPY: dailyIndex(770, 758), QQQ: dailyIndex(690, 679) },
  minutes: {
    AAA: minutesAAA(),
    SQQQ: minutesSQQQ(),
    SPY: driftMinutes({ open: 769, last: 758.2, vol: 100000 }),
    QQQ: driftMinutes({ open: 689, last: 679.3, vol: 100000 }),
  },
  latest: { AAA: 10.07, SQQQ: 10.3 },
  quotes: { AAA: [10.065, 10.075], SQQQ: [10.29, 10.31] },
  yahoo: { '^VIX': [24, 28], '^TNX': [5.3, 5.36], 'CL=F': [92, 93] },
  bars15: { SQQQ: bars15SQQQ() },
};

// Liquidity-sort regression scenario (diagnosis 2026-10-09 §5b): 405
// illiquid names (100k avg volume, below the 500k floor) sit BEFORE AAA
// in API order. The retired first-400 slice dropped AAA before any
// liquidity sorting, so AAA could never be evaluated.
SCENARIOS.manylow = (() => {
  const assets = [];
  const daily = {};
  for (let i = 0; i < 405; i++) {
    const sym = `L${String(i).padStart(3, '0')}`;
    assets.push(sym);
    daily[sym] = dailyFlat(5, 100000);
  }
  assets.push('AAA');
  daily.AAA = dailyAAA();
  daily.SPY = dailyIndex(770, 776);
  daily.QQQ = dailyIndex(690, 694);
  return {
    assets,
    daily,
    minutes: {
      AAA: minutesAAA(),
      SPY: driftMinutes({ open: 770.5, last: 776.2, vol: 100000 }),
      QQQ: driftMinutes({ open: 690.5, last: 694.2, vol: 100000 }),
    },
    latest: { AAA: 10.07 },
    quotes: { AAA: [10.065, 10.075] },
    yahoo: { '^VIX': [16, 14], '^TNX': [5.3, 5.35], 'CL=F': [92, 93] },
  };
})();

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
    brokerPositions: [], protectionFills: {}, historyOrders: [], exitPrice: 10.2,
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
    if (parsed.hostname === 'paper-api.alpaca.markets' || parsed.hostname === 'api.alpaca.markets') {
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
        if (pf && pf.raw) return response(clone(pf.raw));
        if (pf) return response({ ...order, status: 'filled', filled_qty: pf.qty ?? order.qty, filled_avg_price: pf.price });
        return response({ ...order });
      }
      if (path === '/v2/orders' && method === 'GET') {
        // Mirror Alpaca: status=closed returns terminal orders, status=open
        // returns working ones; symbols filters by symbol. Orders placed
        // through this mock keep their stored status; explicit fixtures
        // (world.historyOrders) carry their own terminal/working states.
        const terminal = ['filled', 'canceled', 'cancelled', 'expired', 'rejected'];
        let all = [...Object.values(world.orderBook), ...world.historyOrders];
        const statusWanted = query.get('status');
        if (statusWanted === 'closed') all = all.filter(o => terminal.includes(o.status));
        else if (statusWanted === 'open') all = all.filter(o => !terminal.includes(o.status));
        const syms = query.get('symbols');
        if (syms) { const wanted = syms.split(','); all = all.filter(o => wanted.includes(o.symbol)); }
        return response(all);
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
        const tf = query.get('timeframe');
        const source = tf === '1Min' ? sc.minutes : tf === '15Min' ? (sc.bars15 || {}) : sc.daily;
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
  const fetchImpl = options.wrapFetch ? options.wrapFetch(fakeFetch, world) : fakeFetch;
  const service = createKiaanService({
    db, vault, fetch: fetchImpl, now: () => world.time,
    persistenceReady: () => true, durability: options.durability || null,
    timeoutMs: options.timeoutMs,
    retryBaseMs: options.retryBaseMs,
    exitPoll: { tries: 3, intervalMs: 0 },
    ownerUserId: options.ownerUserId ?? null,
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

// --- connect / ownership / modes ---------------------------------------
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

test('live connect is accepted, validated on the LIVE endpoint, and stored live everywhere (2026-10-17)', async () => {
  const f = fixture();
  const out = await f.service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8), mode: 'live' });
  assert.equal(out.ok, true);
  // Validation went to the LIVE Alpaca endpoint, not paper.
  const accountCall = f.world.calls.find(c => c.path === '/v2/account');
  assert.ok(accountCall.url.startsWith('https://api.alpaca.markets'), `live validation hit ${accountCall.url}`);
  // The chosen mode is stored in all three places the guard checks.
  const cred = f.db.prepare('SELECT * FROM kiaan_credentials WHERE user_id=1').get();
  assert.equal(cred.mode, 'live');
  const owner = f.db.prepare('SELECT * FROM broker_account_owners WHERE account_id=?').get('acct-kiaan-test');
  assert.equal(owner.mode, 'live');
  assert.equal(owner.scope, 'kiaan');
  const settings = f.db.prepare('SELECT * FROM kiaan_settings WHERE user_id=1').get();
  assert.equal(settings.mode, 'live');
  // Still ships DISABLED — connecting stores credentials only.
  const st = await f.service.status(1);
  assert.equal(st.enabled, false);
  assert.equal(st.connected, true);
  // Views report the STORED mode, not a hard-coded PAPER string.
  assert.equal(st.tradingMode, 'LIVE');
  const dash = await f.service.dashboard(1);
  assert.equal(dash.status.tradingMode, 'LIVE');
  // Settings may now select LIVE (and still reject unknown keys/values).
  const ok = await f.service.setSettings(1, { rules: { tradingMode: 'LIVE' } });
  assert.equal(ok.tradingMode, 'LIVE');
  assert.equal((await f.service.getSettings(1)).rules.tradingMode, 'LIVE');
  await assert.rejects(() => f.service.setSettings(1, { rules: { tradingMode: 'DEMO' } }), /tradingMode must be one of PAPER, LIVE/);
  await assert.rejects(() => f.service.setSettings(1, { rules: { nope: 1 } }), /Unknown setting: nope/);
  // A bogus connect mode is still refused loudly — no quiet downgrade.
  await assert.rejects(() => f.service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8), mode: 'demo' }), /must be 'paper' or 'live'/);
});

test('order-path mode guard: settings mode diverging from the credential fails closed with zero orders', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  await f.service.setSettings(1, { rules: { hedgeOnly: false } });
  // Tamper: settings claim 'live' while the credential + claim are paper.
  f.db.prepare("UPDATE kiaan_settings SET mode='live' WHERE user_id=1").run();
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0, 'mode mismatch placed no orders');
  // The order write was attempted and withheld BY THE GUARD: the scan
  // journals the exact mismatch instead of reaching the broker.
  const alerts = f.db.prepare('SELECT message FROM kiaan_alerts WHERE user_id=1').all().map(r => r.message).join('\n');
  assert.match(alerts, /mode mismatch: credential, account claim and settings modes do not agree/);
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
  // Long-side mechanics test: hedge-only OFF + daily exit geometry
  // restore the pre-2026-10-11 behavior this test pins exactly.
  await f.service.setSettings(1, { rules: { hedgeOnly: false, exitAtrTimeframe: 'daily' } });
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

test('universe is liquidity-sorted before the cap: a liquid name past API position 400 is evaluated', async () => {
  const f = fixture('manylow');
  await connectAndEnable(f);
  await f.service.setSettings(1, { rules: { hedgeOnly: false } });
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy');
  assert.equal(buys.length, 1, `AAA (API position 406) must be reached, got ${buys.length} buys`);
  assert.equal(buys[0].symbol, 'AAA');
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

test('relief-bounce guard day: risk-on score with blocked levels → long refused, hedge enters', async () => {
  const f = fixture('guardday');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].symbol, 'SQQQ');
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.regime, 'risk-on'); // the score still reads risk-on
  assert.equal(session.decision, 'seek-hedges'); // but the day trades hedge-only
  assert.match(session.reasons, /RELIEF_BOUNCE_GUARD/);
  const sdata = JSON.parse(session.data);
  assert.equal(sdata.guardActive, true);
  assert.equal(sdata.inputs.tenYearLevel, 5.35);
  assert.equal(sdata.inputs.brentLevel, 104.72); // BZ=F reached the classifier
  const aaa = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='candidate' AND symbol='AAA'").get();
  assert.equal(aaa.decision, 'no-trade');
  assert.match(aaa.reasons, /RELIEF_BOUNCE_GUARD/);
  const sq = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='candidate' AND symbol='SQQQ'").get();
  assert.equal(sq.decision, 'enter-long');
});

test('sub-penny name: entry + protection prices are tick-rounded, broker never 422s', async () => {
  const f = fixture('penny');
  await connectPaper(f);
  await f.service.setSettings(1, { enabled: true, rules: { minPrice: 0.1, hedgeOnly: false, exitAtrTimeframe: 'daily' } });
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
  await f.service.setSettings(1, { rules: { hedgeOnly: false, exitAtrTimeframe: 'daily' } });
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

test('regression: a hanging durability flush must not hold the kiaan lease (disabled cycle)', async () => {
  // flush() with a non-exempt reason resolves only at the next throttled
  // mutation checkpoint in production (up to 60s+; 2026-10-05 fleet
  // lesson). Simulate the worst case — a flush promise that NEVER
  // resolves — and prove the disabled scan cycle still completes promptly
  // and frees the op-lease, so the user's next Resume (setSettings) is
  // not blocked with a "reconciling this account" error.
  const hangingDurability = { flush: () => new Promise(() => {}) };
  const f = fixture('riskon', { durability: hangingDurability });
  await connectPaper(f);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('scanCycle hung on the prune flush')), 2000);
    timer.unref?.();
  });
  try {
    await Promise.race([f.service._scanCycle(1), timeout]);
  } finally { clearTimeout(timer); }
  // Lease must be free immediately after the cycle.
  const view = await f.service.setSettings(1, { enabled: true });
  assert.equal(view.enabled, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_leases').get().n, 0);
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

test('DEFAULT_KIAAN_RULES defaults to PAPER and the error keeps broker code+message', async () => {
  assert.equal(DEFAULT_KIAAN_RULES.tradingMode, 'PAPER');
  const err = new KiaanError('Broker request failed (HTTP 422) [42210000]: sub-penny', 502);
  assert.match(err.message, /42210000/);
  assert.match(err.message, /sub-penny/);
});

// --- day-scoped caching + GET timeout retry (2026-10-08 timeout fix) --------
test('second scan cycle on the same trade date reuses the cached assets catalog and daily bars', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  f.world.calls.length = 0;
  await f.service._scanCycle(1);
  const assetsCalls = f.world.calls.filter(c => c.path === '/v2/assets');
  const dailyCalls = f.world.calls.filter(c => c.path === '/v2/stocks/bars' && c.url.includes('timeframe=1Day'));
  assert.equal(assetsCalls.length, 0, 'assets catalog must be cached per trade date');
  assert.equal(dailyCalls.length, 0, 'daily bars must be cached per trade date');
  // Fresh work still happens every cycle: minute bars are re-fetched.
  const minuteCalls = f.world.calls.filter(c => c.path === '/v2/stocks/bars' && c.url.includes('timeframe=1Min'));
  assert.ok(minuteCalls.length >= 1, 'minute bars stay fresh each cycle');
});

test('a timed-out GET retries with backoff and can succeed on the third attempt (connect account read)', async () => {
  let accountGets = 0;
  const f = fixture('riskon', {
    timeoutMs: 50, retryBaseMs: 1,
    wrapFetch: inner => async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'paper-api.alpaca.markets' && parsed.pathname === '/v2/account'
        && (init.method || 'GET') === 'GET') {
        accountGets++;
        if (accountGets <= 2) return new Promise(() => {}); // hang → 50ms timeout, twice
      }
      return inner(url, init);
    },
  });
  const out = await connectPaper(f);
  assert.equal(out.ok, true);
  assert.equal(accountGets, 3, 'two timed-out GETs, the third attempt succeeded');
});

test('a timed-out POST (order) is NEVER retried — reconciliation semantics preserved', async () => {
  let orderPosts = 0;
  const f = fixture('riskon', {
    timeoutMs: 50,
    wrapFetch: inner => async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'paper-api.alpaca.markets' && parsed.pathname === '/v2/orders' && init.method === 'POST') {
        orderPosts++;
        return new Promise(() => {}); // hang → timeout, outcome unknown
      }
      return inner(url, init);
    },
  });
  await connectAndEnable(f);
  await f.service.setSettings(1, { rules: { hedgeOnly: false } });
  await f.service._scanCycle(1);
  assert.equal(orderPosts, 1, 'a timed-out entry POST must not be re-sent');
  assert.equal(f.world.orderPosts.length, 0, 'the broker never recorded the order');
  const alert = f.db.prepare("SELECT * FROM kiaan_alerts WHERE user_id=1 AND message LIKE '%AAA%'").get();
  assert.ok(alert, 'the withheld entry is alerted, not silently dropped');
});

// --- hedge-only rebuild + intraday exit geometry (2026-10-11) ----------------
test('hedge-only + long universe is the shipped default: a risk-on day refuses a non-universe long but seeks universe longs', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  // No rule overrides — DEFAULT_KIAAN_RULES as shipped (hedgeOnly ON,
  // longUniverse = ORB's 87 names since 2026-10-12). AAA is NOT on the
  // list, so it is refused distinctly and no order is placed.
  const view = await f.service.getSettings(1);
  assert.equal(view.rules.hedgeOnly, true);
  assert.equal(view.rules.exitAtrTimeframe, '15m');
  assert.equal(view.rules.longUniverse.split(',').length, 87);
  await f.service._scanCycle(1);
  assert.equal(f.world.orderPosts.length, 0, 'no orders for a non-universe name');
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.regime, 'risk-on'); // the score still reads risk-on
  assert.equal(session.decision, 'seek-longs'); // longs sought ONLY in the long universe
  assert.match(session.reasons, /HEDGE_ONLY_MODE/);
  assert.match(session.reasons, /LONG_UNIVERSE_MODE/);
  const sdata = JSON.parse(session.data);
  assert.equal(sdata.hedgeOnly, true);
  assert.equal(sdata.longUniverseSize, 87);
  const aaa = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='candidate' AND symbol='AAA'").get();
  assert.equal(aaa.decision, 'no-trade');
  assert.match(aaa.reasons, /LONG_NOT_IN_UNIVERSE/);
});

test('settings: hedgeOnly must be a boolean and exitAtrTimeframe one of 15m/daily', async () => {
  const f = fixture();
  await connectPaper(f);
  await assert.rejects(() => f.service.setSettings(1, { rules: { hedgeOnly: 'yes' } }), /hedgeOnly must be a boolean/);
  await assert.rejects(() => f.service.setSettings(1, { rules: { exitAtrTimeframe: '1h' } }), /exitAtrTimeframe must be one of 15m, daily/);
  await f.service.setSettings(1, { rules: { hedgeOnly: false, exitAtrTimeframe: 'daily' } });
  const view = await f.service.getSettings(1);
  assert.equal(view.rules.hedgeOnly, false);
  assert.equal(view.rules.exitAtrTimeframe, 'daily');
});

test('15m exit geometry: hedge entry is managed on ATR(14) 15m while sizing stays daily-ATR', async () => {
  const f = fixture('hedge15m');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].symbol, 'SQQQ');
  // Sizing proof: the daily stop (10.30 − 1.5×2.0 = 7.30, R $3.00) caps
  // the position at floor($50/$3.00) = 16 shares. Sizing off the
  // intraday stop (R $0.15) would have allowed 48.
  assert.equal(buys[0].qty, 16);
  const pos = f.db.prepare("SELECT * FROM kiaan_positions WHERE user_id=1 AND symbol='SQQQ'").get();
  assert.ok(pos, 'SQQQ position opened');
  assert.equal(pos.status, 'open');
  assert.equal(pos.stop_price, 10.15); // 10.30 − 1.5 × ATR15 0.10
  assert.equal(pos.initial_stop_price, 10.15);
  assert.deepEqual(JSON.parse(pos.targets_json).map(t => t.price), [10.6, 10.75]); // +2R / +3R on R 0.15
  // Broker protection carries the intraday geometry, tick-rounded.
  const oco = f.world.orderPosts.find(o => o.order_class === 'oco');
  assert.ok(oco, 'OCO protection posted');
  assert.equal(oco.stop_loss.stop_price, 10.16); // tickPrice(10.15 × 1.0005)
  assert.equal(oco.take_profit.limit_price, 10.59); // tickPrice(10.60 × 0.9995)
  assert.equal(f.world.subPennyRejections, 0);
  // The journaled candidate decision carries the managed geometry.
  const cand = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='candidate' AND symbol='SQQQ'").get();
  assert.equal(cand.decision, 'enter-long');
  assert.match(cand.reasons, /EXIT_GEOMETRY_15M/);
  const data = JSON.parse(cand.data);
  assert.equal(data.stop, 10.15);
  assert.equal(data.size.shares, 16);
  assert.equal(data.exitGeometry.source, '15m');
  assert.equal(data.exitGeometry.atr15, 0.1);
});

test('15m exit geometry fallback: no 15m bars → daily-ATR geometry stands, fallback journaled', async () => {
  const f = fixture('riskoff'); // scenario carries no bars15 — the 15Min read returns empty
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const pos = f.db.prepare("SELECT * FROM kiaan_positions WHERE user_id=1 AND symbol='SQQQ'").get();
  assert.ok(pos, 'SQQQ position opened');
  assert.equal(pos.stop_price, 9.9786); // daily geometry: 10.30 − 1.5 × ATR(14) daily 0.2143
  const cand = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='candidate' AND symbol='SQQQ'").get();
  assert.equal(cand.decision, 'enter-long');
  assert.match(cand.reasons, /EXIT_GEOMETRY_FALLBACK/);
  assert.equal(JSON.parse(cand.data).exitGeometry.source, 'daily-fallback');
});

// --- breadth wiring (2026-10-10) ----------------------------------------------
test('breadth vote is computed from the bot universe and journaled on the session row', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.regime, 'risk-on');
  const data = JSON.parse(session.data);
  // AAA is the only universe symbol with a usable prior close + live price
  // in this scenario, and it is advancing: breadth = 100%.
  assert.equal(data.inputs.breadthAdvancersPct, 100);
  assert.match(session.reasons, /BREADTH_STRONG/);
});

// --- missing-position reconciliation (2026-10-12 SQQQ/SOXS repair) ----------
// Live defect: SQQQ entered 14 sh @ $33.55; the t2 stop-only parent filled
// @ $33.56 and booked (+$0.07), but the t1 OCO stop LEG also filled — an
// OCO parent is not itself 'filled' when a leg fills — so 7 sh stayed
// tracked against a flat broker account and the bot alerted
// "reconciliation required" every tick for hours. SOXS compounded it: an
// EOD market sell accepted after the close stayed held at the broker and
// every later tick stacked a fresh sell that Alpaca rejected 403
// (insufficient qty available). The tests below pin all three repairs.

test('reconcile: OCO leg fill (parent not filled) books the t1 exit and closes a broker-flat position', async () => {
  const f = fixture('hedge15m');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const pos = f.db.prepare("SELECT * FROM kiaan_positions WHERE user_id=1 AND symbol='SQQQ'").get();
  assert.ok(pos, 'SQQQ position opened');
  assert.equal(pos.shares, 16);
  assert.equal(pos.t1_qty, 8);
  assert.equal(pos.t2_qty, 8);
  // t2 stop-only parent reports 'filled' (the path that always worked).
  f.world.protectionFills[pos.stop_order_id] = { qty: 8, price: 10.05 };
  // t1 OCO: the STOP LEG filled @ 10.02; the parent itself is canceled
  // with zero parent fill — exactly how Alpaca reports an OCO leg fill.
  f.world.protectionFills[pos.oco_id] = { raw: {
    id: 'ord-oco-parent', client_order_id: pos.oco_id, symbol: 'SQQQ',
    side: 'sell', type: 'limit', order_class: 'oco', status: 'canceled',
    filled_qty: 0, filled_avg_price: null,
    legs: [
      { type: 'limit', side: 'sell', status: 'canceled', filled_qty: 0, filled_avg_price: null },
      { type: 'stop', side: 'sell', status: 'filled', filled_qty: '8', filled_avg_price: '10.02' },
    ],
  } };
  f.world.brokerPositions = []; // broker is flat — both tranches exited
  f.world.time = Date.parse('2026-10-01T19:56:00Z'); // 15:56 ET — manage, no new entries
  await f.service._scanCycle(1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_positions').get().n, 0, 'phantom position resolved');
  const trade = f.db.prepare('SELECT * FROM kiaan_trades WHERE user_id=1').get();
  assert.ok(trade.closedAt, 'trade closed');
  // Blended exit (8 @ 10.02 + 8 @ 10.05) / 16 = 10.035; P&L −4.24.
  assert.ok(Math.abs(Number(trade.exitPrice) - 10.035) < 0.001, `exitPrice ${trade.exitPrice} ≈ 10.035`);
  assert.ok(Math.abs(Number(trade.pnl) - -4.24) < 0.01, `pnl ${trade.pnl} ≈ -4.24`);
  assert.match(trade.exitReason, /broker_protection/);
  const dayState = JSON.parse(f.db.prepare('SELECT state FROM kiaan_day_state WHERE trade_date=?').get(TRADE_DATE).state);
  assert.ok(Math.abs(dayState.pnl - -4.24) < 0.01, `day pnl ${dayState.pnl} ≈ -4.24`);
  assert.equal(dayState.losses, 1);
  const stuck = f.db.prepare("SELECT * FROM kiaan_alerts WHERE message LIKE '%no broker position found%'").get();
  assert.equal(stuck, undefined, 'no reconciliation-required alert loop');
});

test('reconcile: broker-flat position with no protection fill is recovered from closed order history', async () => {
  const f = fixture('riskoff');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const pos = f.db.prepare("SELECT * FROM kiaan_positions WHERE user_id=1 AND symbol='SQQQ'").get();
  assert.ok(pos, 'SQQQ position opened');
  assert.equal(pos.shares, 48);
  // Neither protection order reports a fill (both lookups come back
  // 'new'), but the closed-order history holds a filled market sell for
  // the full quantity (e.g. the position was closed outside the bot).
  f.world.historyOrders = [{
    id: 'ord-ext-1', client_order_id: 'external-close-1', symbol: 'SQQQ',
    side: 'sell', type: 'market', status: 'filled',
    filled_qty: '48', filled_avg_price: '10.55',
  }];
  f.world.brokerPositions = [];
  f.world.time = Date.parse('2026-10-01T19:56:00Z');
  await f.service._scanCycle(1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_positions').get().n, 0, 'position resolved from history');
  const trade = f.db.prepare('SELECT * FROM kiaan_trades WHERE user_id=1').get();
  assert.ok(trade.closedAt, 'trade closed');
  assert.equal(Number(trade.exitPrice), 10.55);
  assert.ok(Math.abs(Number(trade.pnl) - 12) < 0.01, `pnl ${trade.pnl} ≈ +12.00`);
  assert.match(trade.exitReason, /eod_flatten/);
  const dayState = JSON.parse(f.db.prepare('SELECT state FROM kiaan_day_state WHERE trade_date=?').get(TRADE_DATE).state);
  assert.equal(dayState.wins, 1);
  const stuck = f.db.prepare("SELECT * FROM kiaan_alerts WHERE message LIKE '%no broker position found%'").get();
  assert.equal(stuck, undefined, 'no reconciliation-required alert loop');
});

test('reconcile: a never-filled entry tracked as open is voided when the broker is flat', async () => {
  const f = fixture('riskoff');
  await connectAndEnable(f);
  // A tracked 'open' row whose entry order died with zero fill.
  f.world.orderBook['kiaan-void-entry'] = {
    id: 'ord-void', client_order_id: 'kiaan-void-entry', symbol: 'SQQQ',
    side: 'buy', type: 'limit', limit_price: 20, qty: 10,
    status: 'canceled', filled_qty: 0, filled_avg_price: null,
  };
  f.db.prepare(`INSERT INTO kiaan_positions(position_id,user_id,trade_id,symbol,direction,entry_client_order_id,
    entry_price,shares,entry_shares,stop_price,initial_stop_price,targets_json,status,opened_at,updated_at)
    VALUES ('pos-void',1,NULL,'SQQQ','long','kiaan-void-entry',20,10,10,19,19,'[]','open',?,?)`)
    .run(iso(NOW), iso(NOW));
  f.world.brokerPositions = [];
  await f.service._scanCycle(1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM kiaan_positions WHERE position_id='pos-void'").get().n, 0, 'phantom row voided');
  const voidAlert = f.db.prepare("SELECT * FROM kiaan_alerts WHERE message LIKE '%never filled at the broker%'").get();
  assert.ok(voidAlert, 'void is alerted with its reason');
  const stuck = f.db.prepare("SELECT * FROM kiaan_alerts WHERE message LIKE '%no broker position found%'").get();
  assert.equal(stuck, undefined, 'no reconciliation-required alert loop');
});

test('exit dedupe: a held broker exit order blocks stacking a second EOD sell (SOXS pattern)', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  await f.service.setSettings(1, { rules: { hedgeOnly: false, exitAtrTimeframe: 'daily' } });
  await f.service._scanCycle(1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_positions').get().n, 1);
  f.world.brokerPositions = [{ symbol: 'AAA', qty: '49' }];
  // The first EOD sell was accepted after the close and is HELD by the
  // broker (working, unfilled) — it already holds all 49 shares.
  f.world.orderBook['kiaan-held-exit'] = {
    id: 'ord-held-exit', client_order_id: 'kiaan-held-exit', symbol: 'AAA',
    side: 'sell', type: 'market', qty: 49, status: 'accepted',
    filled_qty: 0, filled_avg_price: null,
  };
  f.world.time = Date.parse('2026-10-01T19:56:00Z'); // 15:56 ET — EOD flatten window
  await f.service._scanCycle(1);
  const marketSells = f.world.orderPosts.filter(o => o.side === 'sell' && o.type === 'market');
  assert.equal(marketSells.length, 0, 'no duplicate exit stacked on the held order');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_positions').get().n, 1, 'position kept while its exit works');
  const alert = f.db.prepare("SELECT * FROM kiaan_alerts WHERE message LIKE '%already working at the broker%'").get();
  assert.ok(alert, 'the withheld duplicate is alerted with its reason');
});

// --- long-universe expansion (2026-10-12) ------------------------------------
SCENARIOS.riskonUniverse = {
  assets: ['SOC'],
  daily: { SOC: dailyAAA(), SPY: dailyIndex(770, 776), QQQ: dailyIndex(690, 694) },
  minutes: {
    SOC: minutesAAA(),
    SPY: driftMinutes({ open: 770.5, last: 776.2, vol: 100000 }),
    QQQ: driftMinutes({ open: 690.5, last: 694.2, vol: 100000 }),
  },
  latest: { SOC: 10.07 },
  quotes: { SOC: [10.065, 10.075] },
  yahoo: { '^VIX': [16, 14], '^TNX': [5.3, 5.35], 'CL=F': [92, 93] },
};

test('long universe: a confirming ORB-list name (SOC) enters on a risk-on day under default rules', async () => {
  const f = fixture('riskonUniverse');
  await connectAndEnable(f);
  // No hedgeOnly override — the shipped default (hedge-only + universe).
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy');
  assert.equal(buys.length, 1, JSON.stringify(f.world.orderPosts));
  assert.equal(buys[0].symbol, 'SOC');
  const session = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='session'").get();
  assert.equal(session.decision, 'seek-longs');
  const cand = f.db.prepare("SELECT * FROM kiaan_decisions WHERE kind='candidate' AND symbol='SOC'").get();
  assert.equal(cand.decision, 'enter-long');
  assert.match(cand.reasons, /LONG_UNIVERSE_OK/);
  const pos = f.db.prepare("SELECT * FROM kiaan_positions WHERE user_id=1 AND symbol='SOC'").get();
  assert.ok(pos, 'SOC position opened');
  assert.equal(pos.status, 'open');
});

test('migration seeds longUniverse into stored rules that predate it, and never overwrites a set value', async () => {
  const f = fixture();
  // A stored row from before the expansion (no longUniverse key).
  f.db.prepare('INSERT INTO kiaan_settings(user_id, rules) VALUES (7, ?)')
    .run(JSON.stringify({ hedgeOnly: true, minRvol: 2 }));
  // A row that deliberately emptied the universe (pure hedge-only).
  f.db.prepare('INSERT INTO kiaan_settings(user_id, rules) VALUES (8, ?)')
    .run(JSON.stringify({ longUniverse: '' }));
  // Re-constructing the service on the same db runs the one-shot seed.
  const { createCredentialVault: mkVault } = require('../lib/credential-vault');
  createKiaanService({
    db: f.db, vault: mkVault('test-only-secret-never-a-real-credential-987654321'),
    fetch: async () => { throw new Error('no network in migration test'); },
    persistenceReady: () => true, exitPoll: { tries: 1, intervalMs: 0 },
  });
  const seeded = JSON.parse(f.db.prepare('SELECT rules FROM kiaan_settings WHERE user_id=7').get().rules);
  assert.equal(seeded.longUniverse.split(',').length, 87);
  assert.equal(seeded.longUniverse, DEFAULT_KIAAN_RULES.longUniverse);
  assert.equal(seeded.minRvol, 2, 'existing stored rules are preserved');
  const emptied = JSON.parse(f.db.prepare('SELECT rules FROM kiaan_settings WHERE user_id=8').get().rules);
  assert.equal(emptied.longUniverse, '', 'a deliberately emptied universe is untouched');
  // Idempotent: a second construction changes nothing.
  createKiaanService({
    db: f.db, vault: mkVault('test-only-secret-never-a-real-credential-987654321'),
    fetch: async () => { throw new Error('no network in migration test'); },
    persistenceReady: () => true, exitPoll: { tries: 1, intervalMs: 0 },
  });
  const again = JSON.parse(f.db.prepare('SELECT rules FROM kiaan_settings WHERE user_id=7').get().rules);
  assert.equal(again.longUniverse, seeded.longUniverse);
});

test('settings: longUniverse is a settable text rule and round-trips through getSettings', async () => {
  const f = fixture();
  await connectPaper(f);
  await assert.rejects(() => f.service.setSettings(1, { rules: { longUniverse: 42 } }), /longUniverse must be a short string/);
  await f.service.setSettings(1, { rules: { longUniverse: 'SOC,SMR' } });
  const view = await f.service.getSettings(1);
  assert.equal(view.rules.longUniverse, 'SOC,SMR');
});

test('SIP 403 downgrade is per-request, never latched (regression)', async () => {
  const seen = [];
  let sipForbidden = true;
  const f = fixture('chop', {
    wrapFetch: inner => async (url, init) => {
      seen.push(String(url));
      if (sipForbidden && String(url).includes('data.alpaca.markets') && String(url).includes('feed=sip')) {
        return { ok: false, status: 403, json: async () => ({ code: 40310000, message: 'sip entitlement required' }) };
      }
      return inner(url, init);
    },
  });
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  assert.ok(seen.some(u => u.includes('feed=iex')), 'first cycle was served via per-request IEX retries');
  const offset = seen.length;
  sipForbidden = false; // the SIP entitlement appears
  await f.service._scanCycle(1);
  const later = seen.slice(offset);
  assert.ok(later.some(u => u.includes('feed=sip')), 'later requests ask for SIP first again — no latch');
  assert.ok(!later.some(u => u.includes('feed=iex')), 'no later request is silently rewritten to IEX');
});

// --- single-stock inverse sleeve (2026-10-16, strategy-lab Test 10) --------
// Risk-off tape. NVD (a sleeve name) confirms exactly like SQQQ does:
// prev close 3.70 -> 3.85 (+4.05%, RS +5.6 pts vs SPY -1.53%), OR high
// 3.80 broken, pace RVOL ~4.5x, ATR 0.20, spread 0.26%.
function dailySleeveLike(prev, last, vol = 2000000) {
  const bars = dailyFlat(prev, vol, prev + 0.1, prev - 0.1);
  bars.push({ t: iso(Date.parse('2026-10-01T13:30:00Z')), o: prev + 0.05, h: last + 0.02, l: prev - 0.05, c: last, v: Math.round(vol / 2) });
  return bars;
}
function minutesSleeveLike(open, last, orHigh, orLow) {
  return driftMinutes({ open, last, orHigh, orLow, vol: 20000, orVol: 30000, breakVol: 40000 });
}
// SPY after a hard morning drop that BOUNCES into the decision time:
// last close 758.2 is far above the running low (~750), so SPY is below
// VWAP but NOT breaking down — the sleeve gate's proximity leg fails.
function minutesSPYBounce() {
  const bars = [];
  const base = Date.parse('2026-10-01T13:30:00Z');
  for (let i = 0; i < 60; i++) {
    let c;
    if (i < 45) c = 769 + (750 - 769) * (i / 44);
    else c = 750 + (758.2 - 750) * ((i - 44) / 15);
    c = +c.toFixed(4);
    bars.push({ t: iso(base + i * 60000), o: i === 0 ? 769 : bars[i - 1].c, h: +(c + 0.01).toFixed(4), l: +(c - 0.01).toFixed(4), c, v: 100000 });
  }
  return bars;
}
const SLEEVE_YAHOO = { '^VIX': [24, 28], '^TNX': [5.3, 5.36], 'CL=F': [92, 93] };
SCENARIOS.sleeveBD = {
  assets: ['SQQQ', 'NVD'],
  daily: { SQQQ: dailySQQQ(), NVD: dailySleeveLike(3.7, 3.85), SPY: dailyIndex(770, 758), QQQ: dailyIndex(690, 679) },
  minutes: {
    SQQQ: minutesSQQQ(),
    NVD: minutesSleeveLike(3.75, 3.85, 3.80, 3.72),
    SPY: driftMinutes({ open: 769, last: 758.2, vol: 100000 }),
    QQQ: driftMinutes({ open: 689, last: 679.3, vol: 100000 }),
  },
  latest: { SQQQ: 10.3, NVD: 3.85 },
  quotes: { SQQQ: [10.29, 10.31], NVD: [3.845, 3.855] },
  yahoo: SLEEVE_YAHOO,
};
SCENARIOS.sleeveNoBD = {
  ...SCENARIOS.sleeveBD,
  minutes: { ...SCENARIOS.sleeveBD.minutes, SPY: minutesSPYBounce() },
};
SCENARIOS.sleeveCap = {
  assets: ['SQQQ', 'NVD', 'TSLQ'],
  daily: {
    SQQQ: dailySQQQ(), NVD: dailySleeveLike(3.7, 3.85), TSLQ: dailySleeveLike(16.5, 16.9, 4000000),
    SPY: dailyIndex(770, 758), QQQ: dailyIndex(690, 679),
  },
  minutes: {
    SQQQ: minutesSQQQ(),
    NVD: minutesSleeveLike(3.75, 3.85, 3.80, 3.72),
    TSLQ: minutesSleeveLike(16.55, 16.9, 16.75, 16.5),
    SPY: driftMinutes({ open: 769, last: 758.2, vol: 100000 }),
    QQQ: driftMinutes({ open: 689, last: 679.3, vol: 100000 }),
  },
  latest: { SQQQ: 10.3, NVD: 3.85, TSLQ: 16.9 },
  quotes: { SQQQ: [10.29, 10.31], NVD: [3.845, 3.855], TSLQ: [16.89, 16.91] },
  yahoo: SLEEVE_YAHOO,
};
SCENARIOS.sleeveFull = {
  assets: ['SQQQ', 'SPXS', 'SOXS', 'TECS', 'NVD'],
  daily: {
    SQQQ: dailySQQQ(),
    SPXS: dailySleeveLike(8.8, 9.05), SOXS: dailySleeveLike(37.0, 37.9), TECS: dailySleeveLike(5.2, 5.35),
    NVD: dailySleeveLike(3.7, 3.85),
    SPY: dailyIndex(770, 758), QQQ: dailyIndex(690, 679),
  },
  minutes: {
    SQQQ: minutesSQQQ(),
    SPXS: minutesSleeveLike(8.85, 9.05, 8.95, 8.82),
    SOXS: minutesSleeveLike(37.2, 37.9, 37.35, 37.1),
    TECS: minutesSleeveLike(5.24, 5.35, 5.30, 5.22),
    NVD: minutesSleeveLike(3.75, 3.85, 3.80, 3.72),
    SPY: driftMinutes({ open: 769, last: 758.2, vol: 100000 }),
    QQQ: driftMinutes({ open: 689, last: 679.3, vol: 100000 }),
  },
  latest: { SQQQ: 10.3, SPXS: 9.05, SOXS: 37.9, TECS: 5.35, NVD: 3.85 },
  quotes: { SQQQ: [10.29, 10.31], SPXS: [9.04, 9.06], SOXS: [37.85, 37.95], TECS: [5.345, 5.355], NVD: [3.845, 3.855] },
  yahoo: SLEEVE_YAHOO,
};

test('sleeve: SPY breaking down + confirming sleeve name enters in its own slot, tagged', async () => {
  const f = fixture('sleeveBD');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy').map(o => o.symbol).sort();
  assert.deepEqual(buys, ['NVD', 'SQQQ'], 'incumbent hedge and sleeve name both enter');
  const nvd = f.db.prepare("SELECT * FROM kiaan_positions WHERE symbol='NVD'").get();
  assert.equal(nvd.status, 'open');
  assert.equal(nvd.sleeve, 1, 'sleeve position carries the sleeve flag');
  const sqqq = f.db.prepare("SELECT * FROM kiaan_positions WHERE symbol='SQQQ'").get();
  assert.equal(sqqq.sleeve, 0, 'incumbent position is not a sleeve position');
  const trade = f.db.prepare("SELECT * FROM kiaan_trades WHERE symbol='NVD'").get();
  assert.ok(trade.entryReason.startsWith('SLEEVE: '), `sleeve trade tagged: ${trade.entryReason}`);
  const sleeveDecision = f.db.prepare("SELECT * FROM kiaan_decisions WHERE dkey='CAND:SLEEVE:NVD'").get();
  assert.equal(sleeveDecision.decision, 'enter-long');
  assert.equal(JSON.parse(sleeveDecision.data).sleeve, true);
  assert.ok(JSON.parse(sleeveDecision.reasons).some(r => r.startsWith('SLEEVE_SPY_GATE_OK:')));
  // The incumbent pass judged NVD as what it is there — a universe name
  // on a risk-off day — and refused it; the two books' journals coexist.
  const incumbentDecision = f.db.prepare("SELECT * FROM kiaan_decisions WHERE dkey='CAND:NVD'").get();
  assert.equal(incumbentDecision.decision, 'no-trade');
  assert.ok(JSON.parse(incumbentDecision.reasons).some(r => r.startsWith('REGIME_RISK_OFF:')));
  const ds = JSON.parse(f.db.prepare('SELECT state FROM kiaan_day_state').get().state);
  assert.equal(ds.sleeveTrades, 1);
  assert.equal(ds.trades, 2);
});

test('sleeve: no entry when SPY is not breaking down, even with a full confirmation', async () => {
  const f = fixture('sleeveNoBD');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy').map(o => o.symbol);
  assert.deepEqual(buys, ['SQQQ'], 'incumbent hedge trades; the sleeve stays out');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM kiaan_positions WHERE symbol='NVD'").get().n, 0);
  const sleeveDecision = f.db.prepare("SELECT * FROM kiaan_decisions WHERE dkey='CAND:SLEEVE:NVD'").get();
  assert.equal(sleeveDecision.decision, 'no-trade');
  assert.ok(JSON.parse(sleeveDecision.reasons).some(r => r.startsWith('SLEEVE_SPY_GATE:')),
    JSON.stringify(JSON.parse(sleeveDecision.reasons)));
});

test('sleeve: its own 1-position cap binds — a second confirming sleeve name is refused', async () => {
  const f = fixture('sleeveCap');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy').map(o => o.symbol).sort();
  assert.deepEqual(buys, ['NVD', 'SQQQ'], 'one sleeve entry (NVD, first in list order) plus the incumbent');
  const tslq = f.db.prepare("SELECT * FROM kiaan_decisions WHERE dkey='CAND:SLEEVE:TSLQ'").get();
  assert.equal(tslq.decision, 'no-trade');
  assert.ok(JSON.parse(tslq.reasons).some(r => r.startsWith('MAX_POSITIONS:')),
    JSON.stringify(JSON.parse(tslq.reasons)));
});

test('sleeve: a full incumbent book (3/3) neither blocks nor is consumed by the sleeve', async () => {
  const f = fixture('sleeveFull');
  await connectAndEnable(f);
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy').map(o => o.symbol);
  assert.equal(buys.length, 4, `3 incumbent hedges + 1 sleeve entry, got ${JSON.stringify(buys)}`);
  assert.ok(buys.includes('NVD'), 'sleeve enters despite the full incumbent book');
  const hedgeBuys = buys.filter(s => ['SQQQ', 'SPXS', 'SOXS', 'TECS'].includes(s));
  assert.equal(hedgeBuys.length, 3, 'incumbent cap held at 3');
  const blockedHedge = ['SQQQ', 'SPXS', 'SOXS', 'TECS'].find(s => !hedgeBuys.includes(s));
  const blockedDecision = f.db.prepare('SELECT * FROM kiaan_decisions WHERE dkey=?').get(`CAND:${blockedHedge}`);
  assert.equal(blockedDecision.decision, 'no-trade');
  assert.ok(JSON.parse(blockedDecision.reasons).some(r => r.startsWith('MAX_POSITIONS:')),
    `${blockedHedge}: ${blockedDecision.reasons}`);
  const sleevePositions = f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_positions WHERE sleeve=1').get().n;
  const incumbentPositions = f.db.prepare('SELECT COUNT(*) AS n FROM kiaan_positions WHERE sleeve=0').get().n;
  assert.equal(sleevePositions, 1);
  assert.equal(incumbentPositions, 3);
});

test('sleeve: sleeveEnabled=false turns the sleeve off; incumbents trade on', async () => {
  const f = fixture('sleeveBD');
  await connectAndEnable(f);
  await f.service.setSettings(1, { rules: { sleeveEnabled: false } });
  await f.service._scanCycle(1);
  const buys = f.world.orderPosts.filter(o => o.side === 'buy').map(o => o.symbol);
  assert.deepEqual(buys, ['SQQQ']);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM kiaan_decisions WHERE dkey LIKE 'CAND:SLEEVE:%'").get().n, 0);
});

test('sleeve: settings carry the sleeve rules (31 names, cap 1, toggleable)', async () => {
  const f = fixture();
  await connectPaper(f);
  const view = await f.service.getSettings(1);
  assert.equal(view.rules.sleeveEnabled, true);
  assert.equal(view.rules.sleeveSymbols.split(',').length, 31);
  assert.equal(view.rules.sleeveMaxPositions, 1);
  const updated = await f.service.setSettings(1, { rules: { sleeveMaxPositions: 2 } });
  assert.ok(updated);
  assert.equal((await f.service.getSettings(1)).rules.sleeveMaxPositions, 2);
});

// --- broker-timeout hardening (2026-10-16: retries, 5xx, latch auto-clear) ---
test('broker hardening: a GET answered 500 is retried and can succeed', async () => {
  let accountGets = 0;
  const f = fixture('riskon', {
    retryBaseMs: 1,
    wrapFetch: inner => async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'paper-api.alpaca.markets' && parsed.pathname === '/v2/account'
        && (init.method || 'GET') === 'GET') {
        accountGets++;
        if (accountGets === 1) return { ok: false, status: 500, json: async () => ({ code: 50010000, message: 'broker busy' }) };
      }
      return inner(url, init);
    },
  });
  const out = await connectPaper(f);
  assert.equal(out.ok, true);
  assert.equal(accountGets, 2, 'first GET drew a 500, the retry succeeded');
});

test('broker hardening: a GET answered 500 on every attempt fails after 3 tries', async () => {
  let accountGets = 0;
  const f = fixture('riskon', {
    retryBaseMs: 1,
    wrapFetch: inner => async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'paper-api.alpaca.markets' && parsed.pathname === '/v2/account'
        && (init.method || 'GET') === 'GET') {
        accountGets++;
        return { ok: false, status: 500, json: async () => ({ code: 50010000, message: 'broker busy' }) };
      }
      return inner(url, init);
    },
  });
  await assert.rejects(() => connectPaper(f), /HTTP 500/);
  assert.equal(accountGets, 3, 'all 3 attempts were made before failing');
});

test('broker hardening: a GET answered 4xx is definitive — never retried', async () => {
  let accountGets = 0;
  const f = fixture('riskon', {
    retryBaseMs: 1,
    wrapFetch: inner => async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'paper-api.alpaca.markets' && parsed.pathname === '/v2/account'
        && (init.method || 'GET') === 'GET') {
        accountGets++;
        return { ok: false, status: 403, json: async () => ({ code: 40310000, message: 'forbidden' }) };
      }
      return inner(url, init);
    },
  });
  await assert.rejects(() => connectPaper(f), /HTTP 403/);
  assert.equal(accountGets, 1, 'a 4xx answer is not retried');
});

test('broker hardening: retry-exhausted GET still fails closed — error latch set, zero orders', async () => {
  const f = fixture('riskon', {
    timeoutMs: 50, retryBaseMs: 1,
    wrapFetch: (inner, world) => async (url, init = {}) => {
      const parsed = new URL(url);
      if (world.failAccountGets && parsed.hostname === 'paper-api.alpaca.markets'
        && parsed.pathname === '/v2/account' && (init.method || 'GET') === 'GET') {
        world.accountGetAttempts = (world.accountGetAttempts || 0) + 1;
        return new Promise(() => {}); // hang → timeout on every attempt
      }
      return inner(url, init);
    },
  });
  await connectAndEnable(f);
  f.world.failAccountGets = true;
  await f.service._scanCycle(1);
  assert.equal(f.world.accountGetAttempts, 3, 'account GET exhausted all 3 attempts');
  const settings = f.db.prepare('SELECT scheduler_status, scheduler_reason FROM kiaan_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'error');
  assert.match(settings.scheduler_reason, /timed out; reconciliation required/);
  assert.equal(f.world.orderPosts.length, 0, 'no orders while the broker is unreachable');
});

test('broker hardening: an order POST answered 500 is NEVER retried (writes stay single-attempt)', async () => {
  let orderAttempts = 0;
  const f = fixture('riskon', {
    retryBaseMs: 1,
    wrapFetch: inner => async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'paper-api.alpaca.markets' && parsed.pathname === '/v2/orders' && init.method === 'POST') {
        orderAttempts++;
        return { ok: false, status: 500, json: async () => ({ code: 50010000, message: 'broker busy' }) };
      }
      return inner(url, init);
    },
  });
  await connectAndEnable(f);
  await f.service.setSettings(1, { rules: { hedgeOnly: false } });
  await f.service._scanCycle(1);
  assert.equal(orderAttempts, 1, 'a failed entry POST must not be re-sent');
  assert.equal(f.world.orderPosts.length, 0, 'the broker never recorded the order');
});

test('broker hardening: reconciliation latch auto-clears on the next cycle whose full broker fetch succeeds', async () => {
  const f = fixture('riskon', {
    timeoutMs: 50, retryBaseMs: 1,
    wrapFetch: (inner, world) => async (url, init = {}) => {
      const parsed = new URL(url);
      if (world.failAccountGets && parsed.hostname === 'paper-api.alpaca.markets'
        && parsed.pathname === '/v2/account' && (init.method || 'GET') === 'GET') {
        return new Promise(() => {}); // hang → timeout
      }
      return inner(url, init);
    },
  });
  await connectAndEnable(f);
  await f.service.setSettings(1, { rules: { hedgeOnly: false } });
  f.world.failAccountGets = true;
  await f.service._scanCycle(1);
  let settings = f.db.prepare('SELECT scheduler_status, scheduler_reason FROM kiaan_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'error');
  assert.match(settings.scheduler_reason, /reconciliation required/);
  assert.equal(f.world.orderPosts.length, 0, 'latched cycle placed no orders');
  f.world.failAccountGets = false;
  await f.service._scanCycle(1);
  settings = f.db.prepare('SELECT scheduler_status, scheduler_reason FROM kiaan_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'ok', 'latch cleared without a restart');
  assert.equal(settings.scheduler_reason, null);
  assert.ok(f.world.orderPosts.length >= 1, 'the recovered cycle trades again');
});

test('broker hardening: latch clears mid-cycle — a later scan-stage failure records its own reason, not the stale latch', async () => {
  const f = fixture('riskon', {
    timeoutMs: 50, retryBaseMs: 1,
    wrapFetch: (inner, world) => async (url, init = {}) => {
      const parsed = new URL(url);
      if (world.failAccountGets && parsed.hostname === 'paper-api.alpaca.markets'
        && parsed.pathname === '/v2/account' && (init.method || 'GET') === 'GET') {
        return new Promise(() => {}); // hang → timeout
      }
      if (world.failBars && parsed.hostname === 'data.alpaca.markets' && parsed.pathname === '/v2/stocks/bars') {
        return { ok: false, status: 500, json: async () => ({ code: 50010000, message: 'bars down' }) };
      }
      return inner(url, init);
    },
  });
  await connectAndEnable(f);
  f.world.failAccountGets = true;
  await f.service._scanCycle(1);
  let settings = f.db.prepare('SELECT scheduler_status, scheduler_reason FROM kiaan_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'error');
  assert.match(settings.scheduler_reason, /reconciliation required/);
  // Broker account/session reads recover; only the scan-stage bars read
  // still fails. The stale reconciliation latch must be gone — the
  // stored reason is the fresh bars failure, proving the clear happened
  // mid-cycle (after reconciliation, before the scan completed).
  f.world.failAccountGets = false;
  f.world.failBars = true;
  await f.service._scanCycle(1);
  settings = f.db.prepare('SELECT scheduler_status, scheduler_reason FROM kiaan_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'error');
  assert.match(settings.scheduler_reason, /HTTP 500/);
  assert.doesNotMatch(settings.scheduler_reason, /reconciliation required/);
});

test('broker hardening: a successful status() account read clears a stored reconciliation latch', async () => {
  const f = fixture('riskon');
  await connectAndEnable(f);
  f.db.prepare("UPDATE kiaan_settings SET scheduler_status='error', scheduler_reason='Broker request timed out; reconciliation required.' WHERE user_id=1").run();
  const st = await f.service.status(1);
  assert.equal(st.schedulerStatus, 'ok');
  assert.equal(st.schedulerReason, null);
  const settings = f.db.prepare('SELECT scheduler_status FROM kiaan_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'ok', 'the stored latch is cleared, not just the response');
});

// --- hide-internals: owner vs user view (Johnny 2026-10-16) -----------------
// Seed a non-owner (uid 2) with distinctive internal rule values, a
// position, a closed trade and journal rows, so any leak of a rule
// field name OR value into a non-owner payload is detectable.
function seedNonOwner(f) {
  const rules = {
    fixedDollars: 250, spyStrongPct: 0.98765, minRvol: 7.77,
    maxRiskPerTradeDollars: 42.5, maxDailyLossPct: 3.25,
    hedgeSymbols: 'SECRETQ,SECRETR', sleeveSymbols: 'SLEEVESYM',
    guardYieldMin: 9.99, flattenTime: '15:57',
  };
  f.db.prepare('INSERT INTO kiaan_settings(user_id,enabled,mode,rules) VALUES (2,1,?,?)')
    .run('paper', JSON.stringify(rules));
  f.db.prepare(`INSERT INTO kiaan_positions(position_id,user_id,symbol,direction,entry_price,shares,entry_shares,stop_price,initial_stop_price,targets_json,status,opened_at,updated_at)
    VALUES ('pos-u2',2,'SQQQ','long',30,10,10,28.5,28.5,'[{"r":2,"pct":50,"price":33}]','open',?,?)`).run(iso(NOW), iso(NOW));
  f.db.prepare(`INSERT INTO kiaan_trades(trade_id,user_id,symbol,direction,entryTime,regime,regimeScore,relStrength,rvol,atr,stopPrice,targets,riskDollars,entryPrice,exitPrice,pnl,entryReason,closedAt,created_at)
    VALUES ('tr-u2',2,'SQQQ','long',?,'risk-off',-4,3.3,5.5,0.4,28.5,'[]',15,30,31,10,'ENTER-LONG secret why',?,?)`).run(iso(NOW), iso(NOW), iso(NOW));
  const data = JSON.stringify({ score: -4, locked: false, guardActive: false, inputs: { spyDayChangePct: -1.2, vixLevel: 28 } });
  f.db.prepare(`INSERT INTO kiaan_decisions(user_id,dkey,trade_date,kind,symbol,decision,regime,reasons,why,data,created_at,updated_at)
    VALUES (2,'SESSION:risk-off:seek-hedges',?,'session','SESSION','seek-hedges','risk-off',?,'KIAAN SESSION secret score why',?,?,?)`)
    .run(TRADE_DATE, JSON.stringify(['SPY_WEAK: secret vote', 'VIX_HIGH: secret vote']), data, iso(NOW), iso(NOW));
  f.db.prepare(`INSERT INTO kiaan_decisions(user_id,dkey,trade_date,kind,symbol,decision,regime,reasons,why,data,created_at,updated_at)
    VALUES (2,'CAND:SQQQ',?,'candidate','SQQQ','enter-long','risk-off',?,'ENTER-LONG SQQQ stop $28.50 targets secret',?,?,?)`)
    .run(TRADE_DATE, JSON.stringify(['VOLUME_OK: rvol 5.5 secret']), JSON.stringify({ features: { rvol: 5.5, atr: 0.4 }, stop: 28.5 }), iso(NOW), iso(NOW));
}
const FORBIDDEN_IN_USER_PAYLOAD = [
  'spyStrongPct', 'spyWeakPct', 'qqqStrongPct', 'vixCalm', 'vixPanic', 'guardYieldMin', 'guardBrentMin',
  'riskOnScore', 'riskOffScore', 'hedgeSymbols', 'longUniverse', 'sleeveSymbols', 'sleeveEnabled',
  'exitAtrTimeframe', 'entryWindowStart', 'entryWindowEnd', 'flattenTime', 'minRvol', 'maxSpreadPct',
  'minAvgVolume', 'atrStopMult', 'breakevenR', 'maxConsecutiveLosses', 'maxTradesPerDay',
  'maxPositions', 'minRelStrengthPct', 'maxExtensionAtrs', 'sizingMode',
  'regimeScore', 'relStrength', 'stop_price', 'stopPrice', 'targets_json', 'targets', 'riskDollars',
  'SECRETQ', 'SLEEVESYM', '0.98765', 'SPY_WEAK', 'VIX_HIGH', 'uiSchema',
];

test('hide-internals (a): non-owner GET payloads contain no internal rule fields or values', async () => {
  const f = fixture('riskon', { ownerUserId: 1 });
  seedNonOwner(f);
  const payloads = {
    settings: await f.service.getSettings(2),
    status: await f.service.status(2),
    dashboard: await f.service.dashboard(2),
    positions: await f.service.positions(2),
    trades: await f.service.trades(2),
    journal: await f.service.journal(2),
  };
  for (const [name, payload] of Object.entries(payloads)) {
    const text = JSON.stringify(payload);
    for (const bad of FORBIDDEN_IN_USER_PAYLOAD) {
      assert.ok(!text.includes(bad), `${name} payload leaked "${bad}": ${text.slice(0, 400)}`);
    }
  }
  // The user view still carries what Johnny allows (tightened 2026-10-16
  // ~23:25 CT): sizing + risk ONLY — position size (editable) plus the
  // per-trade risk cap and daily-loss lock (read-only) — one plain
  // regime, positions, trades, P&L, plain journal. The two risk keys are
  // deliberately NOT in FORBIDDEN_IN_USER_PAYLOAD: they are the
  // sanctioned-visible risk values now; every OTHER internal is.
  assert.deepEqual(payloads.settings.rules, { fixedDollars: 250, maxRiskPerTradeDollars: 42.5, maxDailyLossPct: 3.25 });
  assert.deepEqual(Object.keys(payloads.settings.rules).sort(), ['fixedDollars', 'maxDailyLossPct', 'maxRiskPerTradeDollars']);
  assert.equal(payloads.settings.viewer, 'user');
  assert.equal(payloads.dashboard.session.regime, 'risk-off');
  assert.deepEqual(Object.keys(payloads.dashboard.session).sort(), ['regime', 'stance', 'updatedAt']);
  assert.equal(payloads.dashboard.positions[0].symbol, 'SQQQ');
  assert.equal(Number(payloads.trades.trades.find(t => t.status === 'closed')?.pnl), 10);
  const sessionRow = payloads.journal.decisions.find(d => d.kind === 'session');
  assert.equal(sessionRow.why, "Today's regime is Risk-off.");
  assert.ok(!('reasons' in sessionRow) && !('data' in sessionRow), 'journal rows carry no reasons/data for non-owners');
  assert.equal(payloads.status.broker, 'Alpaca');
  assert.equal(payloads.status.connected, false);
  assert.ok(!('accountId' in payloads.status), 'no account id for non-owners');
});

test('hide-internals (b): non-owner settings update applies ONLY position size', async () => {
  const f = fixture('riskon', { ownerUserId: 1 });
  seedNonOwner(f);
  await f.service.setSettings(2, {
    enabled: false,
    rules: { fixedDollars: 300, spyStrongPct: 1.23, hedgeSymbols: 'HACK,XXX', minRvol: 9, flattenTime: '10:00', maxRiskPerTradeDollars: 1, maxDailyLossPct: 99 },
  });
  const stored = JSON.parse(f.db.prepare('SELECT rules FROM kiaan_settings WHERE user_id=2').get().rules);
  assert.equal(stored.fixedDollars, 300, 'position size is the one writable field');
  assert.equal(stored.spyStrongPct, 0.98765, 'regime threshold unchanged');
  assert.equal(stored.hedgeSymbols, 'SECRETQ,SECRETR', 'symbol list unchanged');
  assert.equal(stored.minRvol, 7.77, 'RVOL gate unchanged');
  assert.equal(stored.flattenTime, '15:57', 'flatten time unchanged');
  // The risk values are VISIBLE to non-owners but never writable:
  // visible must not widen edit rights beyond fixedDollars.
  assert.equal(stored.maxRiskPerTradeDollars, 42.5, 'risk cap is read-only for non-owners');
  assert.equal(stored.maxDailyLossPct, 3.25, 'daily-loss lock is read-only for non-owners');
  const view = await f.service.getSettings(2);
  assert.deepEqual(view.rules, { fixedDollars: 300, maxRiskPerTradeDollars: 42.5, maxDailyLossPct: 3.25 });
  assert.equal(view.enabled, false, 'pause/resume (enabled) still works for non-owners');
  await assert.rejects(() => f.service.setSettings(2, { rules: { fixedDollars: 'lots' } }), /fixedDollars must be a finite number/);
});

test('hide-internals (c): owner payload keeps full rules and regime detail', async () => {
  const f = fixture('riskon', { ownerUserId: 1 });
  await connectPaper(f);
  const { mergedKiaanRules } = require('../lib/kiaan/engine');
  const view = await f.service.getSettings(1);
  assert.equal(view.viewer, 'owner');
  assert.deepEqual(view.rules, mergedKiaanRules({}), 'owner rules payload is the full merged rules, unchanged');
  assert.ok(Array.isArray(view.uiSchema) && JSON.stringify(view.uiSchema).includes('spyStrongPct'), 'owner receives the settings-form schema');
  const st = await f.service.status(1);
  assert.equal(st.accountId, 'acct-kiaan-test', 'owner status keeps the account id');
  // Owner journal/dashboard keep score + reasons (seeded via a scan is
  // covered elsewhere; here the settings surface is the pinned check).
  seedNonOwner(f);
  const ownerJournal = await f.service.journal(1);
  assert.ok(Array.isArray(ownerJournal.decisions), 'owner journal shape unchanged');
});

test('hide-internals (e): non-owner settings payload is exactly sizing + risk, every other rule key absent', async () => {
  // Johnny 2026-10-16 ~23:25 CT: "users see sizing and risk only."
  // Exhaustive sweep: EVERY key of the full merged rule set must be
  // absent from the non-owner settings payload except the three
  // sanctioned keys — position size + the two read-only risk values.
  const f = fixture('riskon', { ownerUserId: 1 });
  seedNonOwner(f);
  const { mergedKiaanRules } = require('../lib/kiaan/engine');
  const view = await f.service.getSettings(2);
  const allowed = ['fixedDollars', 'maxRiskPerTradeDollars', 'maxDailyLossPct'];
  assert.deepEqual(Object.keys(view.rules).sort(), [...allowed].sort(),
    'non-owner settings rules carry exactly the sizing + risk keys');
  for (const key of Object.keys(mergedKiaanRules({}))) {
    if (allowed.includes(key)) continue;
    assert.ok(!(key in view.rules), `internal rule key "${key}" must be absent from the non-owner settings payload`);
  }
  // Named absence checks for the categories Johnny circled: regime
  // thresholds, vote thresholds, guard levels, confirmation legs,
  // windows, ATR/exit geometry, sleeve params, symbol lists.
  for (const key of ['riskOnScore', 'riskOffScore', 'spyStrongPct', 'spyWeakPct', 'qqqStrongPct', 'qqqWeakPct',
    'vixCalm', 'vixElevated', 'vixHigh', 'vixPanic', 'vixSpikePct', 'breadthStrongPct', 'breadthWeakPct',
    'oilSpikePct', 'yieldSpikeBps', 'hardDownPct', 'guardYieldMin', 'guardBrentMin',
    'minRelStrengthPct', 'minRvol', 'maxSpreadPct', 'maxExtensionAtrs', 'maxDayGainPct',
    'orMinutes', 'entryWindowStart', 'entryWindowEnd', 'flattenTime', 'exitAtrTimeframe',
    'atrStopMult', 'targets', 'breakevenR', 'sleeveEnabled', 'sleeveSymbols', 'sleeveMaxPositions',
    'hedgeSymbols', 'longUniverse', 'hedgeOnly', 'sizingMode', 'maxPositions',
    'maxConsecutiveLosses', 'maxTradesPerDay', 'minPrice', 'maxPrice', 'minAvgVolume', 'tradingMode']) {
    assert.ok(!(key in view.rules), `non-owner settings payload must not contain "${key}"`);
  }
  // Presence: sizing (editable) + both risk values at their configured
  // (seeded) values.
  assert.equal(view.rules.fixedDollars, 250, 'position size present');
  assert.equal(view.rules.maxRiskPerTradeDollars, 42.5, 'per-trade risk cap present, read-only');
  assert.equal(view.rules.maxDailyLossPct, 3.25, 'daily-loss lock present, read-only');
  assert.ok(!('uiSchema' in view) && !('liveNote' in view), 'no owner-only extras in the user settings payload');
});
