'use strict';

// Warrior service tests — proposal approval, 12-gate validation, duplicate
// protection, daily-loss halt, approval idempotency, paper-only default, LIVE
// refusal, and the never-auto-submit invariant. Mirrors the b2-service test
// fixture style (in-memory better-sqlite3, real credential vault, fake fetch).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const {
  createWarriorService, WarriorError, DEFAULT_WARRIOR_RULES,
  PRE_TRADE_CHECKS, assessOrderFlow, preTradeInputs, paceRvol, assessIndicators,
} = require('../lib/warrior/service');
const { createCredentialVault } = require('../lib/credential-vault');

const NOW = Date.parse('2026-09-29T14:00:00Z'); // Tue 10:00 ET — regular session
const TODAY = '2026-09-29';
const clone = value => JSON.parse(JSON.stringify(value));

// --- synthetic market data --------------------------------------------------
// Minute tape engineered to trigger CandleOverCandle on the last bar:
// steady climb (MACD positive, close above VWAP), final bar B breaks A's high
// with >= volume. Daily tape: +4.0% day, 3x relative volume (a qualifying
// day under the 5% chase cap, Johnny 2026-10-12; it read +6.5% when the
// cap was 10).
function minuteBars() {
  const bars = [];
  const base = Date.parse('2026-09-29T13:30:00Z');
  for (let i = 0; i < 58; i++) {
    const c = 9.0 + i * 0.0245;
    bars.push({ t: new Date(base + i * 60000).toISOString(), o: c - 0.01, h: c + 0.02, l: c - 0.02, c, v: 600000 });
  }
  bars.push({ t: new Date(base + 58 * 60000).toISOString(), o: 10.40, h: 10.50, l: 10.30, c: 10.42, v: 900000 }); // A
  bars.push({ t: new Date(base + 59 * 60000).toISOString(), o: 10.40, h: 10.62, l: 10.40, c: 10.55, v: 1200000 }); // B
  return bars;
}
function dailyBars() {
  const bars = [];
  let date = Date.parse('2026-09-29T13:30:00Z');
  for (let i = 0; i < 45; i++) {
    const last = i === 0;
    const c = last ? 10.55 : 10.15 - i * 0.01;
    bars.unshift({
      t: new Date(date).toISOString(), o: c - 0.1, h: c + 0.1, l: c - 0.15,
      c, v: last ? 3000000 : 1000000,
    });
    date -= 86400000;
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
  const world = {
    time: NOW,
    calls: [],
    orders: new Map(), // client_order_id -> order
    positions: [],
    assets: [{ symbol: 'AAA', class: 'us_equity', status: 'active', tradable: true }],
    sequence: 0,
    latestPrice: 100,
    latestStale: false,
    ...options,
  };
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value) });
  async function fakeFetch(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const query = parsed.searchParams;
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { url, path, method: init.method || 'GET', body };
    world.calls.push(call);
    const host = parsed.hostname;
    if (host === 'paper-api.alpaca.markets') {
      if (path === '/v2/account') return response({
        id: 'acct-warrior-test', status: 'ACTIVE', trading_blocked: false,
        account_blocked: false, trade_suspended_by_user: false,
        equity: '100000', buying_power: '100000',
      });
      if (path === '/v2/calendar') return response(world.calendar !== undefined ? world.calendar : [{ date: TODAY, open: '09:30', close: '16:00' }]);
      if (path === '/v2/clock') return response({ is_open: true, timestamp: new Date(world.time).toISOString() });
      if (path === '/v2/assets') return response(world.assets);
      if (path === '/v2/positions') {
        if (world.positionsError) throw new Error('broker positions unavailable');
        return response(world.positions);
      }
      if (path.startsWith('/v2/orders:by_client_order_id')) {
        const clientId = query.get('client_order_id');
        const order = world.orders.get(clientId);
        return order ? response(order) : response({}, 404);
      }
      if (path === '/v2/orders' && (init.method || 'GET') === 'GET') {
        return response([...world.orders.values()].filter(o => !['filled', 'canceled', 'expired', 'rejected'].includes(o.status)));
      }
      if (path === '/v2/orders' && init.method === 'POST') {
        // Mirror Alpaca: sub-penny order prices are rejected (422) on
        // symbols priced $1+ — the rule the OCO tick bug violated live.
        const pxFields = [body.limit_price, body.stop_price, body.take_profit?.limit_price, body.stop_loss?.stop_price];
        if (pxFields.some(px => px != null && Number(px) >= 1 && Math.abs(Number(px) * 100 - Math.round(Number(px) * 100)) > 1e-9)) {
          return response({ message: 'invalid price: sub-penny not allowed' }, 422);
        }
        world.sequence++;
        const order = {
          id: `ord-${world.sequence}`, client_order_id: body.client_order_id,
          symbol: body.symbol, qty: String(body.qty), side: body.side,
          type: body.type, status: 'new', filled_qty: '0',
          limit_price: body.limit_price ?? null, stop_price: body.stop_price ?? null,
        };
        if (body.order_class === 'oco') {
          // The fake broker synthesizes child legs so ocoLegs()/ocoFilledLeg()
          // have something to inspect, like a real OCO parent.
          order.order_class = 'oco';
          order.legs = [
            { id: `ord-${world.sequence}-a`, client_order_id: `${body.client_order_id}:tp`,
              symbol: body.symbol, qty: String(body.qty), side: body.side, type: 'limit',
              status: 'new', filled_qty: '0', limit_price: body.take_profit?.limit_price ?? null },
            { id: `ord-${world.sequence}-b`, client_order_id: `${body.client_order_id}:sl`,
              symbol: body.symbol, qty: String(body.qty), side: body.side, type: 'stop',
              status: 'new', filled_qty: '0', stop_price: body.stop_loss?.stop_price ?? null },
          ];
        }
        if (world.autoFillExits && body.side === 'sell' && body.type === 'market') {
          order.status = 'filled';
          order.filled_qty = String(body.qty);
          order.filled_avg_price = String(world.marketFillPrice ?? 0);
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
      if (path === '/v1beta1/screener/stocks/movers') {
        if (world.moversError) return response({ message: 'screener unavailable' }, 500);
        return response({ gainers: world.gainers || [], losers: [], market_open: true });
      }
      if (path === '/v1beta1/screener/stocks/most-actives') {
        if (world.moversError) return response({ message: 'screener unavailable' }, 500);
        return response({ most_actives: world.mostActives || [] });
      }
      if (path === '/v2/stocks/bars') {
        if (world.sipForbidden && query.get('feed') === 'sip') return response({ message: 'sip entitlement required' }, 403);
        const symbols = (query.get('symbols') || '').split(',');
        const tf = query.get('timeframe');
        if (tf === '1Min' && typeof world.minuteBarsOverride === 'function') {
          return response({ bars: Object.fromEntries(symbols.map(s => [s, world.minuteBarsOverride(s)])), next_page_token: null });
        }
        let bars = tf === '1Min' ? minuteBars() : (world.dailyBarsOverride || dailyBars());
        if (tf === '1Min') {
          // Day-aware: the backtest requests one range per trading day, so
          // land the synthetic tape on the requested date (09:30 ET start).
          const dayMs = Math.floor(Date.parse(query.get('start') || '2026-09-29T04:00:00Z') / 86400000) * 86400000;
          bars = minuteBars().map((b, i) => ({
            ...b, t: new Date(dayMs + (13 * 60 + 30 + i) * 60000).toISOString(),
          }));
        }
        return response({ bars: Object.fromEntries(symbols.map(s => [s, bars])), next_page_token: null });
      }
      if (path === '/v2/stocks/bars/latest') {
        if (world.sipForbidden && query.get('feed') === 'sip') return response({ message: 'sip entitlement required' }, 403);
        const symbols = (query.get('symbols') || '').split(',');
        const t = new Date(world.time - (world.latestStale ? 180000 : 0)).toISOString();
        return response({ bars: Object.fromEntries(symbols.map(s => [s, { t, c: world.latestPrice }])) });
      }
    }
    return response({ message: `unexpected ${host}${path}` }, 500);
  }
  const service = createWarriorService({
    db, vault, fetch: fakeFetch, now: () => world.time,
    persistenceReady: () => true, durability: null,
    exitPoll: { tries: 3, intervalMs: 0 },
  });
  // A fresh service instance over the same db/world — simulates the next
  // process boot (e.g. for one-shot stored-rules upgrades).
  const recreate = () => createWarriorService({
    db, vault, fetch: fakeFetch, now: () => world.time,
    persistenceReady: () => true, durability: null,
    exitPoll: { tries: 3, intervalMs: 0 },
  });
  return { db, service, world, recreate };
}

function insertProposal(db, overrides = {}) {
  const row = {
    proposal_id: 'prop-test-1', user_id: 1, symbol: 'AAA', pattern_name: 'CandleOverCandle',
    score: 13, entry: 100, stop: 95, target: 110, rr: 2.0, shares_recommended: 10,
    reasons: '["valid"]', status: 'pending',
    created_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 30 * 60000).toISOString(),
    ...overrides,
  };
  db.prepare(`INSERT INTO warrior_proposals(proposal_id,user_id,symbol,pattern_name,score,entry,stop,target,rr,
    shares_recommended,reasons,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.proposal_id, row.user_id, row.symbol, row.pattern_name, row.score, row.entry,
      row.stop, row.target, row.rr, row.shares_recommended, row.reasons, row.status,
      row.created_at, row.expires_at);
  return row;
}
function mappedDaily() {
  return dailyBars().map(b => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}
function mappedMinute() {
  return minuteBars().map(b => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}
async function connectAndGet(f) {
  await f.service.connect(1, { key: 'k'.repeat(8), secret: 's'.repeat(8) });
}
function seedOpenPosition(db, overrides = {}) {
  // A locally-open position the broker reconciliation loop will manage.
  const row = {
    position_id: 'pos-test-1', user_id: 1, proposal_id: 'prop-test-1', symbol: 'AAA',
    qty: 10, entry_price: 100, stop_price: 95, target_price: 110,
    pattern_name: 'CandleOverCandle', status: 'open', exit_oco_id: null,
    opened_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
    ...overrides,
  };
  db.prepare(`INSERT INTO warrior_positions(position_id,user_id,proposal_id,symbol,qty,entry_price,
    stop_price,target_price,pattern_name,status,exit_oco_id,opened_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.position_id, row.user_id, row.proposal_id, row.symbol, row.qty, row.entry_price,
      row.stop_price, row.target_price, row.pattern_name, row.status, row.exit_oco_id,
      row.opened_at, row.updated_at);
  return row;
}

test('warrior schema creates every warrior_* table', async () => {
  const { db } = fixture();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'warrior_%' ORDER BY name")
    .all().map(r => r.name);
  for (const expected of ['warrior_settings', 'warrior_credentials', 'warrior_proposals', 'warrior_positions',
    'warrior_trades', 'warrior_scan_runs', 'warrior_alerts',
    'warrior_backtests', 'warrior_backtest_trades', 'warrior_universe', 'warrior_leases',
    'warrior_best_evaluations']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
});

test('connect links a dedicated paper account and enables the scanner', async () => {
  const f = fixture();
  const status = await f.service.connect(1, { key: 'key-abc', secret: 'secret-xyz' });
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'paper');
  assert.equal(status.enabled, true);
  assert.equal(status.accountId, 'acct-warrior-test');
  const owner = f.db.prepare("SELECT * FROM broker_account_owners WHERE scope='warrior'").get();
  assert.equal(owner.account_id, 'acct-warrior-test');
  assert.equal(owner.user_id, 1);
});

test('settings default to PAPER and report order-flow limitation', async () => {
  const f = fixture();
  const view = f.service.getSettings(1);
  assert.equal(view.rules.tradingMode, 'PAPER');
  assert.equal(view.orderFlow.available, false);
  assert.match(view.orderFlow.reason, /Level 2/);
});

test('approveProposal submits exactly one broker order with idempotent client_order_id', async () => {
  const f = fixture();
  await connectAndGet(f);
  const proposal = insertProposal(f.db);
  const result = await f.service.approveProposal(1, proposal.proposal_id);
  assert.equal(result.proposal.status, 'approved');
  assert.equal(result.submitted, true);
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 1, 'exactly one broker order may be submitted');
  assert.equal(posts[0].body.client_order_id, proposal.proposal_id);
  assert.equal(posts[0].body.side, 'buy');
  assert.equal(posts[0].body.qty, 10);
  const position = f.db.prepare("SELECT * FROM warrior_positions WHERE proposal_id=?").get(proposal.proposal_id);
  assert.ok(position, 'position row created');
  assert.equal(position.status, 'pending_entry');
});

test('approveProposal blocks on data_fresh when the latest bar is genuinely stale', async () => {
  const f = fixture();
  await connectAndGet(f);
  // bars/latest returns the bar object directly per symbol; a 180s-old bar
  // exceeds the 120s freshness window and must still block the approval.
  f.world.latestStale = true;
  const proposal = insertProposal(f.db);
  await assert.rejects(() => f.service.approveProposal(1, proposal.proposal_id), /data_fresh/);
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 0, 'stale-data approval must not reach the broker');
});

// --- indicators_ok bar-count repair (2026-10-14, CORD) ---------------------
// 14-bar PremarketBreak tape: 12 sparse premarket bars topping at $4.00,
// the 09:30 ET bar, and a 09:31 break bar closing $4.18 above the
// premarket high on rising volume. VWAP/EMA9 are finite; EMA20/MACD
// cannot exist yet (<20 / <26 bars) and must not block approval.
function shortPremarketBreakTape() {
  const bars = [];
  const pre = Date.parse('2026-09-29T12:00:00Z'); // 08:00 ET
  for (let i = 0; i < 12; i++) {
    bars.push({ t: new Date(pre + i * 60000).toISOString(), o: 3.95, h: 4.00, l: 3.90, c: 3.96, v: 20000 });
  }
  bars.push({ t: new Date(Date.parse('2026-09-29T13:30:00Z')).toISOString(), o: 3.98, h: 4.05, l: 3.95, c: 4.02, v: 200000 });
  bars.push({ t: new Date(Date.parse('2026-09-29T13:31:00Z')).toISOString(), o: 4.05, h: 4.20, l: 4.03, c: 4.18, v: 400000 });
  return bars;
}
function mappedBars(raw) {
  return raw.map(b => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

test('14-bar PremarketBreak tape passes the approval indicator check', async () => {
  // Unit: EMA20/MACD are null on 14 bars but are not yet computable.
  const gate = assessIndicators(mappedBars(shortPremarketBreakTape()));
  assert.equal(gate.bars, 14);
  assert.equal(gate.lastInd.ema20, null);
  assert.equal(gate.lastInd.macd, null);
  assert.equal(gate.ok, true, `short tape must pass, got ${gate.detail}`);
  // Integration: approval of a PremarketBreak proposal on that tape submits.
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => shortPremarketBreakTape();
  const proposal = insertProposal(f.db, { pattern_name: 'PremarketBreak' });
  const result = await f.service.approveProposal(1, proposal.proposal_id);
  assert.equal(result.submitted, true);
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 1, 'the short-tape approval reaches the broker exactly once');
});

test('>=26-bar tape with a NaN-producing input still blocks and the alert names indicator + bar count', async () => {
  // Unit: a NaN close on the last of 31 bars poisons EMA9/EMA20/MACD —
  // with >=26 bars MACD is computable, so its absence is a real failure.
  const base = Date.parse('2026-09-29T13:30:00Z');
  const long = [];
  for (let i = 0; i < 31; i++) {
    const c = 10 + i * 0.05;
    long.push({ t: base + i * 60000, o: c, h: c + 0.02, l: c - 0.02, c, v: 100000 });
  }
  long[30].c = NaN; long[30].o = NaN; long[30].h = NaN; long[30].l = NaN;
  const gate = assessIndicators(long);
  assert.equal(gate.ok, false);
  assert.equal(gate.bars, 31);
  assert.match(gate.detail, /indicators_ok \((ema9|ema20|macd) null, .*bars=31, last=2026-09-29T14:00:00\.000Z\)/);
  // Integration: a 31-bar tape with zero cumulative volume (VWAP cannot
  // compute) still blocks approval, submits nothing, and the block alert
  // names the failed indicator, the bar count, and the last-bar time.
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => long.map(b => ({
    t: new Date(b.t).toISOString(), o: 10, h: 10.02, l: 9.98, c: 10 + (b.t - base) / 60000 * 0.05, v: 0,
  }));
  const proposal = insertProposal(f.db, { pattern_name: 'PremarketBreak' });
  await assert.rejects(() => f.service.approveProposal(1, proposal.proposal_id), /indicators_ok \(vwap null, bars=31, last=/);
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 0, 'a genuinely failed indicator gate must not reach the broker');
  const alerts = f.service.alerts(1).alerts;
  const block = alerts.find(a => /approval blocked by pre-trade gates/.test(a.message));
  assert.ok(block, `a block alert is recorded: ${JSON.stringify(alerts)}`);
  assert.match(block.message, /indicators_ok \(vwap null, bars=31, last=2026-09-29T14:00:00\.000Z\)/);
});

test('approveProposal is idempotent — a second approval reconciles, never resubmits', async () => {
  const f = fixture();
  await connectAndGet(f);
  const proposal = insertProposal(f.db);
  const first = await f.service.approveProposal(1, proposal.proposal_id);
  assert.equal(first.submitted, true);
  const second = await f.service.approveProposal(1, proposal.proposal_id);
  assert.equal(second.reconciled, true);
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 1, 'no second order may be submitted on re-approval');
});

test('approveProposal adopts a broker-held position instead of duplicating', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '99.5', current_price: '101' }];
  const proposal = insertProposal(f.db);
  const result = await f.service.approveProposal(1, proposal.proposal_id);
  assert.equal(result.adopted, true);
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 0, 'no order may be submitted when the broker already holds the symbol');
});

test('all 12 pre-trade gates fail independently', async () => {
  assert.equal(PRE_TRADE_CHECKS.length, 12);
  const base = {
    marketOpen: true, dataFresh: true, pattern: { name: 'CandleOverCandle', pattern_valid: true },
    indicatorsOk: true, regimeOk: true,
    entry: 100, stop: 95, target: 110, rr: 2.0, minRR: 2.0,
    buyingPower: 100000, notional: 1000, shares: 10,
    duplicatePosition: false, dailyLimitsOk: true,
  };
  assert.equal(preTradeInputs(base).ok, true);
  const flips = {
    market_open: { marketOpen: false },
    data_fresh: { dataFresh: false },
    pattern_valid: { pattern: { name: 'CandleOverCandle', pattern_valid: false } },
    indicators_ok: { indicatorsOk: false },
    regime_ok: { regimeOk: false },
    entry_above_stop: { stop: 105 },
    target_above_entry: { target: 95 },
    min_risk_reward: { rr: 1.5 },
    sufficient_buying_power: { buyingPower: 100 },
    no_duplicate_position: { duplicatePosition: true },
    daily_limits_ok: { dailyLimitsOk: false },
    position_size_positive: { shares: 0, notional: 0 },
  };
  for (const [check, flip] of Object.entries(flips)) {
    const result = preTradeInputs({ ...base, ...flip });
    assert.equal(result.ok, false, `${check} must fail the gate`);
    const entry = result.checks.find(c => c.name === check);
    assert.ok(entry, `gate ${check} is reported`);
    assert.equal(entry.passed, false, `${check} reports passed=false`);
    const others = result.checks.filter(c => c.name !== check);
    assert.ok(others.every(c => c.passed), `only ${check} fails`);
  }
});

test('expired proposals cannot be approved', async () => {
  const f = fixture();
  await connectAndGet(f);
  const proposal = insertProposal(f.db, { expires_at: new Date(NOW - 1000).toISOString() });
  await assert.rejects(() => f.service.approveProposal(1, proposal.proposal_id), /expired/i);
  const row = f.db.prepare('SELECT status FROM warrior_proposals WHERE proposal_id=?').get(proposal.proposal_id);
  assert.equal(row.status, 'expired');
});

test('rejectProposal marks the proposal rejected without a rejection log', async () => {
  const f = fixture();
  await connectAndGet(f);
  const proposal = insertProposal(f.db);
  const result = await f.service.rejectProposal(1, proposal.proposal_id, { reason: 'too late in the day' });
  assert.equal(result.ok, true);
  const row = f.db.prepare('SELECT status FROM warrior_proposals WHERE proposal_id=?').get(proposal.proposal_id);
  assert.equal(row.status, 'rejected');
  // No warrior_rejections table: rejections are funnel counts only.
  const names = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='warrior_rejections'").all();
  assert.equal(names.length, 0);
});

test('daily-loss halt blocks approval and surfaces in status blockers', async () => {
  const f = fixture();
  await connectAndGet(f);
  // -2.5% on a $100k account trips the 2% max daily loss.
  f.db.prepare(`INSERT INTO warrior_trades(user_id,ticker,date,exitedAt,pnl,created_at) VALUES (1,'AAA',?,?,?,?)`)
    .run(TODAY, new Date(NOW - 5 * 60000).toISOString(), '-2500', new Date(NOW).toISOString());
  const status = await f.service.status(1);
  assert.equal(status.ready, false);
  assert.ok(status.blockers.some(b => /Daily loss/i.test(b)), `blockers mention the daily loss: ${status.blockers}`);
  const proposal = insertProposal(f.db);
  await assert.rejects(() => f.service.approveProposal(1, proposal.proposal_id), /daily_limits_ok/);
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 0, 'halted approval must not reach the broker');
});

test('a prior-day loss streak does NOT halt a new day; a same-day streak does', async () => {
  const f = fixture();
  await connectAndGet(f);
  // Four straight losses YESTERDAY (2026-09-28): the streak is a daily limit
  // and must reset overnight, or a halted bot can never trade its way out
  // (live failure 2026-10-06: Monday's losses still had Warrior halted Tuesday).
  const ins = f.db.prepare(`INSERT INTO warrior_trades(user_id,ticker,date,exitedAt,pnl,created_at) VALUES (1,'AAA',?,?,?,?)`);
  for (let i = 0; i < 4; i++) {
    ins.run('2026-09-28', new Date(Date.parse('2026-09-28T19:00:00Z') + i * 60000).toISOString(), '-10', new Date(NOW).toISOString());
  }
  let status = await f.service.status(1);
  assert.ok(!status.blockers.some(b => /consecutive/i.test(b)), `prior-day streak must not block: ${status.blockers}`);
  // Three losses TODAY still trip the guard — the daily limit itself is intact.
  for (let i = 0; i < 3; i++) {
    ins.run(TODAY, new Date(NOW - (10 - i) * 60000).toISOString(), '-10', new Date(NOW).toISOString());
  }
  status = await f.service.status(1);
  assert.ok(status.blockers.some(b => /consecutive/i.test(b)), `same-day streak must block: ${status.blockers}`);
});

test('paper is the default mode; incomplete LIVE authorization is refused loudly', async () => {
  const f = fixture();
  await connectAndGet(f);
  assert.equal((await f.service.status(1)).mode, 'paper');
  await f.service.setSettings(1, { rules: { tradingMode: 'LIVE', liveEnabled: true, liveConfirmed: false } });
  const status = await f.service.status(1);
  assert.ok(status.blockers.some(b => /LIVE/i.test(b)), 'status blockers name the LIVE refusal');
  const proposal = insertProposal(f.db);
  await assert.rejects(
    () => f.service.approveProposal(1, proposal.proposal_id),
    /LIVE orders require tradingMode=LIVE AND liveEnabled AND liveConfirmed/,
  );
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 0, 'LIVE refusal must not reach the broker');
});

test('scoreSymbol duplicate protection blocks repeat proposals and positions', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  const base = {
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily: mappedDaily(),
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  };
  const first = f.service.scoreSymbol(base);
  assert.equal(first.outcome, 'eligible', `synthetic tape must be eligible, got ${JSON.stringify(first).slice(0, 300)}`);
  // A pending proposal for the same symbol+pattern blocks a second one.
  insertProposal(f.db, { symbol: 'AAA', pattern_name: first.pattern });
  const dupProposal = f.service.scoreSymbol(base);
  assert.equal(dupProposal.outcome, 'rejected');
  assert.equal(dupProposal.stage, 'duplicate');
  // An open position also blocks.
  f.db.prepare(`INSERT INTO warrior_positions(position_id,user_id,symbol,qty,status,opened_at) VALUES (?,?,?,?,?,?)`)
    .run('pos-1', 1, 'AAA', 10, 'open', new Date(NOW).toISOString());
  f.db.prepare("UPDATE warrior_proposals SET status='rejected' WHERE proposal_id='prop-test-1'").run();
  const dupPosition = f.service.scoreSymbol(base);
  assert.equal(dupPosition.outcome, 'rejected');
  assert.equal(dupPosition.stage, 'duplicate');
});

test('scoreSymbol rejects a name that already ran past the chase limit', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  // Same synthetic tape as the eligible case, but the prior close sits far
  // below the current price — today is already +18% (the BBD/ITUB/RXRX
  // failure mode: all entered at +13–20% on the day).
  const daily = mappedDaily();
  const prev = daily[daily.length - 2];
  prev.c = 8.94; prev.o = 8.84; prev.h = 9.04; prev.l = 8.79;
  const r = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily,
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.stage, 'momentum');
  assert.match(r.reason, /chase limit/);
});

test('run() auto-approves proposals at the fixed dollar size when autoApprove is on', async () => {
  const f = fixture();
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(result.scan, 'a scan ran');
  assert.equal(result.scan.funnel.proposals, 1, 'one proposal was created');
  assert.equal(result.scan.proposalIds.length, 1, 'the scan reports the created proposal id');
  const approved = f.service.proposals(1, { status: 'approved' }).proposals;
  assert.equal(approved.length, 1, 'the proposal was auto-approved');
  assert.equal(approved[0].symbol, 'AAA');
  const expectedShares = Math.max(1, Math.floor(500 / approved[0].entry));
  assert.equal(approved[0].shares_recommended, expectedShares, 'shares sized to the $500 default');
  assert.ok(approved[0].reasons.some(r => /Auto-approve/.test(r)), 'reasons note the auto-approve sizing');
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 1, 'exactly one entry order was submitted');
  assert.equal(Number(posts[0].body.qty), expectedShares, 'order qty matches the auto-approve size');
});

// --- Premarket-break early entries (Johnny 2026-10-06) ----------------------
// Tape: a flat premarket range topping at 10.20, regular bars building under
// it, and a 09:59 ET break bar closing 10.35 on heavy volume. NOW is
// 10:00 ET — inside the default 60-minute early-break window.
function pmBreakBars() {
  const bars = [];
  const pre = Date.parse('2026-09-29T12:00:00Z'); // 08:00 ET
  for (let m = 0; m < 90; m++) {
    bars.push({ t: new Date(pre + m * 60000).toISOString(), o: 10.02, h: 10.20, l: 9.98, c: 10.05, v: 20000 });
  }
  const open = Date.parse('2026-09-29T13:30:00Z'); // 09:30 ET
  for (let m = 0; m < 29; m++) {
    bars.push({ t: new Date(open + m * 60000).toISOString(), o: 10.05, h: 10.14, l: 10.00, c: 10.10, v: 600000 });
  }
  bars.push({ t: new Date(open + 29 * 60000).toISOString(), o: 10.12, h: 10.38, l: 10.10, c: 10.35, v: 2400000 });
  return bars;
}
const ONLY_PREMARKET_BREAK = {
  CandleOverCandle: false, MicroPullback: false, BullFlag: false, ABCD: false,
  CupAndHandle: false, InvertedHeadAndShoulders: false, VwapReclaim: false,
  PremarketBreak: true,
};

test('run() proposes a PremarketBreak entry on a fresh break of the premarket high', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => pmBreakBars();
  await f.service.setSettings(1, { rules: { autoApprove: false }, allowedPatterns: ONLY_PREMARKET_BREAK });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 1, 'the break produced exactly one proposal');
  const pending = f.service.proposals(1, { status: 'pending' }).proposals;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].pattern_name, 'PremarketBreak');
  assert.equal(Number(pending[0].entry), 10.35);
  assert.equal(Number(pending[0].stop), 10.20, 'stop at the premarket high');
});

test('the early-break window rule gates the service path', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => pmBreakBars();
  // Break bar is 29 minutes after the open; a 5-minute window must miss it.
  await f.service.setSettings(1, { rules: { autoApprove: false, earlyBreakWindowMinutes: 5 }, allowedPatterns: ONLY_PREMARKET_BREAK });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 0, 'outside the configured window the break is not taken');
});

// --- Second-leg chase exception (Johnny 2026-10-06) ------------------------
// Minute tape: run to a first-leg high of 11.00, pullback to 10.44, base,
// re-break closing 11.12 at 09:59 ET. Daily tape puts the day at +25.8% —
// far past the 10% chase cap, inside the 60% second-leg ceiling.
function secondLegBars() {
  const bars = [];
  const open = Date.parse('2026-09-29T13:30:00Z'); // 09:30 ET
  const push = (m, o, h, l, c, v = 600000) => bars.push({ t: new Date(open + m * 60000).toISOString(), o, h, l, c, v });
  for (let m = 0; m < 20; m++) { const c = 10.00 + m * (0.98 / 19); push(m, c - 0.02, m === 19 ? 11.00 : c + 0.02, c - 0.04, c); }
  [10.88, 10.76, 10.64, 10.55, 10.48, 10.50].forEach((c, j) => push(20 + j, c + 0.02, c + 0.05, j === 4 ? 10.44 : c - 0.03, c));
  [10.53, 10.56, 10.59].forEach((c, j) => push(26 + j, c - 0.01, c + 0.03, c - 0.03, c));
  push(29, 10.60, 11.15, 10.58, 11.12, 2400000);
  return bars;
}
function secondLegDaily(prevClose) {
  const bars = [];
  let date = Date.parse('2026-09-29T13:30:00Z');
  for (let i = 0; i < 45; i++) {
    const last = i === 0;
    const c = last ? 11.12 : (i === 1 ? prevClose : prevClose - i * 0.01);
    bars.unshift({ t: new Date(date).toISOString(), o: c - 0.1, h: c + 0.1, l: c - 0.15, c, v: last ? 3000000 : 1000000 });
    date -= 86400000;
  }
  return bars;
}
const ONLY_SECOND_LEG = { ...ONLY_PREMARKET_BREAK, PremarketBreak: false, SecondLeg: true };

test('second-leg exception: a re-break past the chase cap still proposes', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => secondLegBars();
  f.world.dailyBarsOverride = secondLegDaily(8.84); // +25.8% day
  await f.service.setSettings(1, { rules: { autoApprove: false }, allowedPatterns: ONLY_SECOND_LEG });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 1, 'the re-break opened the chase door exactly once');
  const pending = f.service.proposals(1, { status: 'pending' }).proposals;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].pattern_name, 'SecondLeg');
  assert.equal(Number(pending[0].entry), 11.12);
  assert.equal(Number(pending[0].stop), 11.00, 'stop at the re-broken first-leg high');
});

test('second-leg exception: without the pattern the chase cap still bars the same tape', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => secondLegBars();
  f.world.dailyBarsOverride = secondLegDaily(8.84);
  // Every pattern EXCEPT SecondLeg is enabled — the door must stay shut.
  await f.service.setSettings(1, {
    rules: { autoApprove: false },
    allowedPatterns: { CandleOverCandle: true, MicroPullback: true, BullFlag: true, ABCD: true, CupAndHandle: true, InvertedHeadAndShoulders: true, VwapReclaim: true, PremarketBreak: true, SecondLeg: false },
  });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 0, 'no second-leg structure, no entry past the cap');
});

test('second-leg exception: the ceiling still bars a parabolic day', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => secondLegBars();
  f.world.dailyBarsOverride = secondLegDaily(6.18); // +80% day — past the 60% ceiling
  await f.service.setSettings(1, { rules: { autoApprove: false }, allowedPatterns: ONLY_SECOND_LEG });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 0, 'past the ceiling even a re-break is a lottery ticket');
});

// --- Premarket-break chase exemption (Johnny 2026-10-08) -------------------
// Same break tape as the base PremarketBreak test (premarket high 10.20,
// break closes 10.35 in the early window), but the daily tape puts the day
// at +50% — JZ's shape on 2026-10-08 (+50% at the first close, +116% day):
// the chase guard previously had no door for it at all.
function pmBreakDaily(prevClose) {
  const bars = [];
  let date = Date.parse('2026-09-29T13:30:00Z');
  for (let i = 0; i < 45; i++) {
    const last = i === 0;
    const c = last ? 10.35 : (i === 1 ? prevClose : prevClose - i * 0.01);
    bars.unshift({ t: new Date(date).toISOString(), o: c - 0.1, h: c + 0.1, l: c - 0.15, c, v: last ? 3000000 : 1000000 });
    date -= 86400000;
  }
  return bars;
}

test('premarket-break exemption: an early break past the chase cap still proposes', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => pmBreakBars();
  f.world.dailyBarsOverride = pmBreakDaily(6.90); // +50% day — past the 10% cap, under the 60% PM ceiling
  await f.service.setSettings(1, { rules: { autoApprove: false }, allowedPatterns: ONLY_PREMARKET_BREAK });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 1, 'the early break opened the chase door exactly once');
  const pending = f.service.proposals(1, { status: 'pending' }).proposals;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].pattern_name, 'PremarketBreak');
  assert.equal(Number(pending[0].entry), 10.35);
  assert.equal(Number(pending[0].stop), 10.20, 'stop at the premarket high');
});

test('premarket-break exemption: the ceiling still bars a parabolic day', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => pmBreakBars();
  f.world.dailyBarsOverride = pmBreakDaily(5.18); // +99.8% day — past the 60% PM ceiling
  await f.service.setSettings(1, { rules: { autoApprove: false }, allowedPatterns: ONLY_PREMARKET_BREAK });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 0, 'past the premarket-break ceiling, no entry');
});

test('run() keeps the manual-approval invariant when autoApprove is off', async () => {
  const f = fixture();
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { autoApprove: false } });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(result.scan, 'a scan ran');
  assert.equal(result.scan.funnel.proposals, 1, 'one proposal was created');
  const pending = f.service.proposals(1, { status: 'pending' }).proposals;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');
  assert.equal(pending[0].symbol, 'AAA');
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 0, 'the scan must never submit orders — proposals wait for manual approval');
  const runRow = f.db.prepare('SELECT * FROM warrior_scan_runs ORDER BY started_at DESC LIMIT 1').get();
  assert.ok(runRow, 'scan run recorded');
  assert.equal(runRow.symbols_scanned, 1);
  assert.ok(!runRow.detail_json, 'no per-symbol scan detail persisted (funnel counts only)');
  assert.equal(runRow.proposals_created, 1, 'funnel counts recorded');
});

test('setSettings validates the auto-approve rules', async () => {
  const f = fixture();
  await connectAndGet(f);
  const updated = await f.service.setSettings(1, { rules: { autoApprove: true, autoApproveDollars: 1000 } });
  assert.equal(updated.rules.autoApprove, true);
  assert.equal(updated.rules.autoApproveDollars, 1000);
  await assert.rejects(
    () => f.service.setSettings(1, { rules: { autoApprove: 'yes' } }),
    /autoApprove must be boolean/,
  );
  await assert.rejects(
    () => f.service.setSettings(1, { rules: { autoApproveDollars: -5 } }),
    /autoApproveDollars must be a finite non-negative number/,
  );
});

test('assessOrderFlow reports the Alpaca paper limitation without fabricating data', async () => {
  const flow = assessOrderFlow('AAA');
  assert.equal(flow.available, false);
  assert.match(flow.reason, /unavailable/i);
});

test('backtest fails closed when the broker is not connected', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.backtest(1, { symbols: ['AAA'], days: 5 }),
    error => error instanceof WarriorError && /connect/i.test(error.message),
    'backtests must never fabricate bars or run without a dedicated broker account'
  );
});

test('backtest fetches the requested historical range and persists the report', async () => {
  const f = fixture();
  await connectAndGet(f);
  const result = await f.service.backtest(1, { symbols: ['AAA'], days: 5 });
  assert.ok(result.backtestId, 'backtest id returned');
  assert.ok(result.report && typeof result.report === 'object', 'engine report returned');
  assert.ok(Number.isInteger(result.trades), 'trade count returned');
  assert.deepEqual(result.dataErrors, {}, 'no symbol data errors');

  // The old implementation ignored the requested range and loaded the
  // current day only. Assert per-day 1Min requests across distinct dates.
  const minuteCalls = f.world.calls.filter(c =>
    c.path === '/v2/stocks/bars' && String(c.url).includes('timeframe=1Min'));
  const startDays = new Set(minuteCalls.map(c => {
    const u = new URL(c.url);
    return new Date(Date.parse(u.searchParams.get('start'))).toISOString().slice(0, 10);
  }));
  assert.ok(minuteCalls.length >= 5, `expected >=5 per-day 1Min requests, saw ${minuteCalls.length}`);
  assert.ok(startDays.size >= 5, `expected >=5 distinct requested days, saw ${startDays.size}`);

  // No orders may ever be submitted by a backtest.
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  assert.equal(posts.length, 0, 'backtests never submit broker orders');

  // Persistence round-trip.
  const listed = f.service.getBacktests(1);
  assert.ok(listed.backtests.some(b => b.backtestId === result.backtestId), 'backtest listed');
  const detail = f.service.getBacktest(1, result.backtestId);
  assert.equal(detail.backtestId, result.backtestId);
  assert.ok(detail.report && typeof detail.report === 'object');
  assert.ok(Array.isArray(detail.trades), 'backtest trades persisted');
  assert.deepEqual(detail.params.symbols, ['AAA']);
  assert.equal(detail.params.days, 5);
});

test('backtest clamps its inputs and dedupes symbols', async () => {
  const f = fixture();
  await connectAndGet(f);
  // days=2 clamps to the 5-day floor; duplicate symbols are deduped.
  // (The 90-day ceiling rides the same clamp expression.)
  const result = await f.service.backtest(1, { symbols: ['AAA', 'AAA'], days: 2 });
  const listed = f.service.getBacktests(1);
  const row = listed.backtests.find(b => b.backtestId === result.backtestId);
  assert.deepEqual(row.params.symbols, ['AAA'], 'duplicate symbols are deduped');
  assert.equal(row.params.days, 5, 'days below the floor clamp to 5');
});

test('a confirmed entry fill attaches ONE broker OCO, never two independent legs', async () => {
  const f = fixture();
  await connectAndGet(f);
  const proposal = insertProposal(f.db);
  await f.service.approveProposal(1, proposal.proposal_id);
  // Simulate the broker filling the entry order.
  const entry = f.world.orders.get(proposal.proposal_id);
  entry.status = 'filled'; entry.filled_qty = '10'; entry.filled_avg_price = '100.05';
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100.05', current_price: '101' }];
  await f.service.run(1);
  const posts = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST');
  const ocos = posts.filter(c => c.body?.order_class === 'oco');
  assert.equal(ocos.length, 1, 'exactly one OCO parent is attached after the fill');
  assert.equal(ocos[0].body.side, 'sell');
  assert.equal(ocos[0].body.qty, 10);
  assert.ok(ocos[0].body.take_profit?.limit_price > 0, 'take-profit leg carried');
  assert.ok(ocos[0].body.stop_loss?.stop_price > 0, 'stop leg carried');
  const soloLegs = posts.filter(c => !c.body?.order_class
    && /^(stop|target)-/.test(c.body?.client_order_id || ''));
  assert.equal(soloLegs.length, 0, 'no independent stop/target legs may be submitted');
  const pos = f.db.prepare('SELECT * FROM warrior_positions WHERE proposal_id=?').get(proposal.proposal_id);
  assert.equal(pos.status, 'open');
  assert.ok(pos.exit_oco_id, 'exit_oco_id records the protection parent');
});

test('protection prices land on the penny tick for a $1+ stock (BBD 2026-10-05 regression)', async () => {
  const f = fixture();
  await connectAndGet(f);
  // BBD's live geometry: entry 4.36, stop 4.34, target 4.50. The old 5bps
  // padding at 4 decimals produced 4.3422 / 4.4978 — sub-penny, and Alpaca
  // rejected every protection attach with HTTP 422, leaving fills naked.
  const proposal = insertProposal(f.db, { symbol: 'BBD', entry: 4.36, stop: 4.34, target: 4.50, shares_recommended: 115 });
  await f.service.approveProposal(1, proposal.proposal_id);
  const entry = f.world.orders.get(proposal.proposal_id);
  entry.status = 'filled'; entry.filled_qty = '115'; entry.filled_avg_price = '4.36';
  f.world.positions = [{ symbol: 'BBD', qty: '115', avg_entry_price: '4.36', current_price: '4.37' }];
  await f.service.run(1);
  const ocos = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST' && c.body?.order_class === 'oco');
  assert.equal(ocos.length, 1, 'one OCO parent attached after the fill');
  assert.equal(ocos[0].body.stop_loss.stop_price, 4.34, 'stop leg rounded to the penny tick');
  assert.equal(ocos[0].body.take_profit.limit_price, 4.5, 'target leg rounded to the penny tick');
  const pos = f.db.prepare('SELECT * FROM warrior_positions WHERE proposal_id=?').get(proposal.proposal_id);
  assert.equal(pos.status, 'open');
  assert.ok(pos.exit_oco_id, 'protection parent recorded');
  const riskAlerts = f.db.prepare("SELECT COUNT(*) c FROM warrior_alerts WHERE user_id=1 AND message LIKE '%UNPROTECTED%'").get().c;
  assert.equal(riskAlerts, 0, 'no unprotected-position alert may fire');
});

test('breakeven ratchets the stop only after the broker confirms the replacement OCO', async () => {
  const f = fixture();
  await connectAndGet(f);
  insertProposal(f.db);
  const pos = seedOpenPosition(f.db, { exit_oco_id: 'oco-prop-test-1-init' });
  f.world.orders.set('oco-prop-test-1-init', {
    id: 'oco-1', client_order_id: 'oco-prop-test-1-init', symbol: 'AAA', qty: '10',
    side: 'sell', type: 'limit', order_class: 'oco', status: 'new', legs: [],
  });
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100', current_price: '106' }];
  f.world.latestPrice = 106; // +1.2R on a 5-point risk -> breakeven triggers
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get(pos.position_id);
  assert.equal(row.stop_price, 100, 'local stop moved to entry only via the confirmed OCO');
  assert.equal(row.breakeven_set, 1);
  const ocos = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST' && c.body?.order_class === 'oco');
  assert.equal(ocos.length, 1, 'one replacement OCO submitted');
  assert.ok(Math.abs(ocos[0].body.stop_loss.stop_price - 100.05) < 0.01, 'replacement stop sits at entry');
});

test('an exit without a confirmed fill journals nothing and keeps the position open', async () => {
  const f = fixture();
  await connectAndGet(f);
  insertProposal(f.db);
  const pos = seedOpenPosition(f.db, { exit_oco_id: 'oco-prop-test-1-init' });
  f.world.orders.set('oco-prop-test-1-init', {
    id: 'oco-1', client_order_id: 'oco-prop-test-1-init', symbol: 'AAA', qty: '10',
    side: 'sell', type: 'limit', order_class: 'oco', status: 'new', legs: [],
  });
  // Price below the stop -> the stop-hit backstop fires an exit intent...
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100', current_price: '94' }];
  f.world.latestPrice = 94;
  await f.service.run(1);
  // ...but the fake broker never fills the market exit, so nothing journals.
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get(pos.position_id);
  assert.equal(trade, undefined, 'no trade may be journaled without a confirmed fill');
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get(pos.position_id);
  assert.equal(row.status, 'open', 'the position stays open until the broker confirms');
});

test('a missing broker position with a filled OCO leg journals realized P&L', async () => {
  const f = fixture();
  await connectAndGet(f);
  insertProposal(f.db);
  const pos = seedOpenPosition(f.db, { exit_oco_id: 'oco-prop-test-1-init' });
  f.world.orders.set('oco-prop-test-1-init', {
    id: 'oco-9', client_order_id: 'oco-prop-test-1-init', symbol: 'AAA', qty: '10',
    side: 'sell', type: 'limit', order_class: 'oco', status: 'filled',
    legs: [
      { id: 'leg-a', type: 'limit', status: 'canceled', filled_qty: '0' },
      { id: 'leg-b', type: 'stop', status: 'filled', filled_qty: '10', filled_avg_price: '94.8' },
    ],
  });
  f.world.positions = []; // broker truth: flat
  await f.service.run(1);
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get(pos.position_id);
  assert.ok(trade, 'the exit is journaled');
  assert.equal(trade.exitReason, 'stop', 'the filled stop leg identifies the exit reason');
  assert.equal(Number(trade.exitPrice), 94.8);
  assert.ok(Number(trade.pnl) < 0, 'a realized loss is recorded');
  assert.ok(Math.abs(Number(trade.pnl) - (94.8 - 100) * 10) < 0.01, 'P&L matches the confirmed fill');
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get(pos.position_id);
  assert.equal(row.status, 'closed');
});

test('a failed positions fetch pauses reconciliation without touching local state', async () => {
  const f = fixture();
  await connectAndGet(f);
  insertProposal(f.db);
  const pos = seedOpenPosition(f.db);
  f.world.positionsError = true;
  const result = await f.service.run(1);
  assert.equal(result.reconcile.paused, true, 'reconciliation reports paused');
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get(pos.position_id);
  assert.equal(row.status, 'open', 'local state is untouched on broker uncertainty');
  const trades = f.db.prepare('SELECT COUNT(*) c FROM warrior_trades WHERE user_id=1').get().c;
  assert.equal(trades, 0, 'nothing is journaled');
  const settings = f.db.prepare('SELECT scheduler_status FROM warrior_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'error');
});

test('an empty calendar (weekend/holiday) settles the scheduler idle instead of erroring', async () => {
  const f = fixture({ calendar: [] });
  await connectAndGet(f);
  // Saturday 2026-10-03, noon ET: Alpaca returns a clean empty calendar.
  f.world.time = Date.parse('2026-10-03T16:00:00Z');
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'market-closed');
  const settings = f.db.prepare('SELECT scheduler_status,scheduler_reason FROM warrior_settings WHERE user_id=1').get();
  assert.equal(settings.scheduler_status, 'idle');
  assert.equal(settings.scheduler_reason, 'Market is closed.');
  const alerts = f.db.prepare("SELECT COUNT(*) c FROM warrior_alerts WHERE user_id=1 AND message LIKE '%scan failed%'").get().c;
  assert.equal(alerts, 0, 'a closed day must not raise scan-failed alerts');
});

test('a malformed (non-array) calendar response is still a hard broker-data error', async () => {
  const f = fixture({ calendar: { message: 'unexpected shape' } });
  await connectAndGet(f);
  await assert.rejects(() => f.service.run(1), /Broker calendar is unavailable/);
});

test('approval on a closed day is withheld as window-closed, not a broker failure', async () => {
  const f = fixture({ calendar: [] });
  await connectAndGet(f);
  const sat = Date.parse('2026-10-03T16:00:00Z'); // Saturday noon ET
  f.world.time = sat;
  insertProposal(f.db, {
    created_at: new Date(sat).toISOString(),
    expires_at: new Date(sat + 30 * 60000).toISOString(),
  });
  await assert.rejects(() => f.service.approveProposal(1, 'prop-test-1'), /Market window is closed; approval withheld/);
});

test('a partial exit banks realized P&L and re-protects the exact remainder', async () => {
  const f = fixture();
  await connectAndGet(f);
  insertProposal(f.db);
  const pos = seedOpenPosition(f.db, { target_price: 115, exit_oco_id: 'oco-prop-test-1-init' });
  f.world.orders.set('oco-prop-test-1-init', {
    id: 'oco-1', client_order_id: 'oco-prop-test-1-init', symbol: 'AAA', qty: '10',
    side: 'sell', type: 'limit', order_class: 'oco', status: 'new', legs: [],
  });
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100', current_price: '110' }];
  f.world.latestPrice = 110; // +2R on 5-point risk -> partial triggers; target 115 not hit
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 110;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get(pos.position_id);
  assert.equal(row.qty, 5, 'local quantity updates only after the confirmed partial fill');
  assert.equal(row.partial_taken, 1);
  assert.equal(Number(row.banked_pnl), 50, 'realized partial P&L is banked: (110-100)*5');
  const protections = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST'
    && (c.body?.order_class === 'oco' || c.body?.type === 'stop'));
  const runnerProtection = protections[protections.length - 1];
  assert.equal(runnerProtection.body.qty, 5, 'the replacement protection covers exactly the remaining shares');
  // holdRunners defaults ON (Johnny 2026-10-01): the runner is re-protected
  // STOP-ONLY — no OCO take-profit leg that would dump it at the target.
  assert.equal(runnerProtection.body.type, 'stop', 'the runner protection is a stop order');
  assert.equal(runnerProtection.body.order_class, undefined, 'no fixed-target OCO leg on a held runner');
});

test('a halted account reconciles but scans no new proposals', async () => {
  const f = fixture();
  await connectAndGet(f);
  // A -$2,500 day on $100k equity trips the 2% max-daily-loss halt.
  f.db.prepare(`INSERT INTO warrior_trades(user_id,tradeId,ticker,date,pnl,exitedAt,created_at)
    VALUES (1,'t-halt','AAA','2026-09-29','-2500',?,?)`)
    .run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
  const result = await f.service.run(1);
  assert.equal(result.halted, true);
  assert.equal(result.scan.skipped, 'halted');
  const proposals = f.db.prepare('SELECT COUNT(*) c FROM warrior_proposals WHERE user_id=1').get().c;
  assert.equal(proposals, 0, 'no proposals may pile up behind a daily-loss halt');
});

test('a partial followed by EOD flatten in one cycle exits only the remainder', async () => {
  const f = fixture();
  await connectAndGet(f);
  insertProposal(f.db);
  seedOpenPosition(f.db, { target_price: 115, exit_oco_id: 'oco-prop-test-1-init' });
  f.world.orders.set('oco-prop-test-1-init', {
    id: 'oco-1', client_order_id: 'oco-prop-test-1-init', symbol: 'AAA', qty: '10',
    side: 'sell', type: 'limit', order_class: 'oco', status: 'new', legs: [],
  });
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100', current_price: '110' }];
  f.world.latestPrice = 110;
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 110;
  f.world.time = Date.parse('2026-09-29T19:56:00Z'); // 15:56 ET -> EOD flatten fires
  await f.service.run(1);
  const eodExits = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST'
    && c.body?.side === 'sell' && c.body?.type === 'market'
    && /^exit-eod_flatten-/.test(c.body.client_order_id || ''));
  assert.equal(eodExits.length, 1, 'one EOD exit is submitted');
  assert.equal(eodExits[0].body.qty, 5, 'the EOD exit covers only the post-partial remainder, never the pre-partial lot');
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.ok(trade, 'the flattened exit is journaled');
  assert.equal(Number(trade.pnl), 100, 'P&L includes the banked partial: (110-100)*5 + 50');
});

test('SIP 403 falls back to IEX for market data (regression)', async () => {
  const f = fixture({ sipForbidden: true });
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true, 'scan succeeds via the IEX fallback');
  const sipCalls = f.world.calls.filter(c => c.url.includes('feed=sip'));
  const iexCalls = f.world.calls.filter(c => c.url.includes('feed=iex'));
  assert.ok(sipCalls.length > 0, 'SIP was attempted first');
  assert.ok(iexCalls.length > 0, 'IEX fallback was used after the 403');
  const runRow = f.db.prepare('SELECT * FROM warrior_scan_runs ORDER BY started_at DESC LIMIT 1').get();
  assert.ok(runRow, 'scan run recorded despite the SIP 403');
});

// Builds a daily tape like dailyBars() but with a chosen per-session volume.
function flatVolumeDailyBars(volume) {
  const bars = [];
  let date = Date.parse('2026-09-29T13:30:00Z');
  for (let i = 0; i < 45; i++) {
    const last = i === 0;
    const c = last ? 10.55 : 10.15 - i * 0.01;
    bars.unshift({
      t: new Date(date).toISOString(), o: c - 0.1, h: c + 0.1, l: c - 0.15,
      c, v: volume,
    });
    date -= 86400000;
  }
  return bars;
}

test('SIP 403 does not latch: after SIP recovers, later requests ask for SIP first (regression)', async () => {
  const f = fixture({ sipForbidden: true });
  await connectAndGet(f);
  const first = await f.service.run(1);
  assert.equal(first.ok, true, 'first scan succeeds via per-request IEX retries');
  assert.ok(f.world.calls.some(c => c.url.includes('feed=iex')), 'first scan used the IEX retry');
  const offset = f.world.calls.length;
  f.world.sipForbidden = false; // the SIP entitlement appears
  const second = await f.service.run(1);
  assert.equal(second.ok, true, 'second scan succeeds');
  const later = f.world.calls.slice(offset);
  assert.ok(later.some(c => c.url.includes('feed=sip')), 'later requests ask for SIP first again — no latch');
  assert.ok(!later.some(c => c.url.includes('feed=iex')), 'no later request is silently rewritten to IEX');
});

test('liquidity gate judges IEX bars against a feed-aware floor (TCRT-shaped, regression)', async () => {
  // IEX ADV of 45,000 ≈ 560K consolidated at the ~8% IEX share — above the
  // rules' 500,000 consolidated floor, so the name must clear the universe
  // liquidity gate even though every bar arrived on the IEX feed. On the
  // old latch the raw 45,000 was judged against 500,000 and died there
  // (the TCRT kill: ADV read 8,928 against ~111-135K consolidated).
  const f = fixture({ sipForbidden: true, dailyBarsOverride: flatVolumeDailyBars(45000) });
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  const rows = f.db.prepare('SELECT data FROM warrior_best_evaluations WHERE symbol=?').all('AAA');
  const liquidityKills = rows.filter(r => /daily volume|dollar volume/i.test(JSON.parse(r.data).reason || ''));
  assert.equal(liquidityKills.length, 0,
    `no liquidity-gate rejection for AAA on IEX bars: ${JSON.stringify(rows.map(r => JSON.parse(r.data).reason))}`);
});

test('liquidity gate still rejects a genuinely illiquid name on IEX bars (regression)', async () => {
  // IEX ADV of 30,000 ≈ 375K consolidated — below the 500,000 floor even
  // after feed-aware scaling (effective IEX floor 40,000), so the gate
  // still bites, and the journal names the feed-aware floor it applied.
  const f = fixture({ sipForbidden: true, dailyBarsOverride: flatVolumeDailyBars(30000) });
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  const rows = f.db.prepare('SELECT data FROM warrior_best_evaluations WHERE symbol=?').all('AAA');
  const kill = rows.map(r => JSON.parse(r.data)).find(e => /Average daily volume 30000/.test(e.reason || ''));
  assert.ok(kill, `AAA rejected at the liquidity gate: ${JSON.stringify(rows.map(r => JSON.parse(r.data).reason))}`);
  assert.match(kill.reason, /below 40000/, 'journal shows the feed-aware floor (500000 consolidated x 8% IEX share)');
  assert.match(kill.reason, /IEX-feed floor/, 'journal names the feed the floor was scaled for');
});

test('mountWarrior serializes handler results with res.json (regression)', async () => {  const { mountWarrior } = require('../lib/warrior/service');
  const routes = {};
  const fakeApp = {
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
    put: (p, ...h) => { routes[`PUT ${p}`] = h; },
    delete: (p, ...h) => { routes[`DELETE ${p}`] = h; },
  };
  const service = { status: async uid => ({ ok: true, uid }) };
  mountWarrior({ app: fakeApp, service, requireAuth: (req, res, next) => next() });
  const handlers = routes['GET /api/warrior/status'];
  assert.ok(handlers && handlers.length >= 2, 'the status route is mounted');
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

// --- Gainers-anchored scanning (Johnny 2026-10-12) -------------------------
// "On the Warrior bot screen from the top gainers and lookout for
// breakouts there. Don't just be all over the place." The candidate set
// comes from the screener's top-gainers list; a name that appears there
// joins the day's watched set and keeps being scanned; plain catalog
// rotation is only the last-resort fallback when the screener fails AND
// nothing is watched. (Supersedes the 2026-10-01 movers-front-half
// rotation behavior; the today's-volume liquidity gates from that day
// are unchanged and tested below.)

function scannedSymbols(f, fromCall = 0) {
  const dailyCall = f.world.calls.slice(fromCall).find(c => c.path === '/v2/stocks/bars'
    && new URL(c.url).searchParams.get('timeframe') === '1Day'
    && !new URL(c.url).searchParams.get('symbols').includes('SPY'));
  assert.ok(dailyCall, 'daily bars were loaded for the scan');
  return new URL(dailyCall.url).searchParams.get('symbols').split(',');
}

test('scan works the top gainers screen only — rotation contributes nothing', async () => {
  const f = fixture({
    assets: ['AAA', 'BBB', 'CCC', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'ZZZ', percent_change: 42.5, price: 2.1, change: 0.63 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { scanBudget: 2, autoApprove: false } });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(f.world.calls.some(c => c.path === '/v1beta1/screener/stocks/movers'), 'screener was queried');
  assert.ok(!f.world.calls.some(c => c.path === '/v1beta1/screener/stocks/most-actives'), 'most-actives is no longer a candidate source');
  assert.deepEqual(scannedSymbols(f), ['ZZZ'], 'only the gainer is scanned — the catalog is not rotated into the cycle');
  assert.equal(result.scan.funnel.fromScreen, 1);
  assert.equal(result.scan.funnel.fromWatched, 0);
  assert.equal(result.scan.funnel.fromRotation, 0);
});

test('a most-active name that is not a top gainer does not qualify on its own', async () => {
  const f = fixture({
    assets: ['AAA', 'BBB', 'CCC', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [],
    mostActives: [{ symbol: 'ZZZ', volume: 99000000, trade_count: 123456 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { scanBudget: 2, autoApprove: false } });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(!scannedSymbols(f).includes('ZZZ'), 'most-active alone never reaches the scan');
  assert.equal(result.scan.funnel.fromScreen, 0);
  assert.equal(result.scan.funnel.fromRotation, 2, 'empty screen + empty watched set falls back to rotation for that cycle');
});

test('a name that leaves the gainers screen stays watched for the rest of the day', async () => {
  const f = fixture({
    assets: ['AAA', 'BBB', 'CCC', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'ZZZ', percent_change: 42.5, price: 2.1, change: 0.63 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { autoApprove: false } });
  const first = await f.service.run(1);
  assert.equal(first.scan.funnel.fromScreen, 1);
  const callsAfterFirst = f.world.calls.length;
  f.world.gainers = []; // ZZZ slips off the screen
  const second = await f.service.run(1);
  assert.deepEqual(scannedSymbols(f, callsAfterFirst), ['ZZZ'], 'the watched name keeps being scanned for its breakout');
  assert.equal(second.scan.funnel.fromScreen, 0);
  assert.equal(second.scan.funnel.fromWatched, 1);
  assert.equal(second.scan.funnel.fromRotation, 0);
});

test('a screener outage falls back to the watched set before rotation', async () => {
  const f = fixture({
    assets: ['AAA', 'BBB', 'CCC', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'ZZZ', percent_change: 42.5, price: 2.1, change: 0.63 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { autoApprove: false } });
  await f.service.run(1);
  const callsAfterFirst = f.world.calls.length;
  f.world.moversError = true; // screener now 500s
  const second = await f.service.run(1);
  assert.equal(second.ok, true);
  assert.deepEqual(scannedSymbols(f, callsAfterFirst), ['ZZZ'], 'watched set carries the scan through the outage');
  assert.equal(second.scan.funnel.fromWatched, 1);
  assert.equal(second.scan.funnel.fromRotation, 0);
});

test('a screener outage never breaks the scan (fail-soft to rotation)', async () => {
  const f = fixture({ moversError: true });
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(result.scan, 'a scan ran');
  assert.equal(result.scan.funnel.proposals, 1, 'rotation scan still produces its proposal');
  assert.ok(result.scan.funnel.fromRotation >= 1, 'the fallback is visible in the funnel');
});

test('a screener failure is diagnosed in the log, not swallowed silently', async () => {
  const f = fixture({ moversError: true });
  await connectAndGet(f);
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const result = await f.service.run(1);
    assert.equal(result.ok, true);
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.some(line => line.includes('gainers screen') && line.includes('fetch failed')),
    `the outage left a diagnostic line, got: ${JSON.stringify(logged)}`);
});

test('an in-band gainer through the screen path reaches a proposal with all gates intact', async () => {
  const f = fixture({
    gainers: [{ symbol: 'AAA', percent_change: 6.5, price: 10.55, change: 0.65 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { autoApprove: false } });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.fromScreen, 1);
  assert.equal(result.scan.funnel.proposals, 1, 'the valid pattern + pace on a gainer produces its proposal exactly as before');
});

function sleepyDailyBars(todayVolume) {
  // $2 stock: 20-day average is 2M shares (~$4M/day — below the $5M dollar
  // gate) but liquid on share count; today's bar carries today's volume.
  const bars = [];
  let date = Date.parse('2026-09-29T13:30:00Z');
  for (let i = 0; i < 45; i++) {
    const last = i === 0;
    const c = last ? 2.00 : 1.90;
    bars.unshift({
      t: new Date(date).toISOString(), o: c - 0.05, h: c + 0.05, l: c - 0.05,
      c, v: last ? todayVolume : 2000000,
    });
    date -= 86400000;
  }
  return bars;
}

test("phase 1 admits a name whose TODAY dollar volume clears the gate", async () => {
  const f = fixture({ dailyBarsOverride: sleepyDailyBars(10000000) }); // today: 10M sh × $2 = $20M
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  const runRow = f.db.prepare('SELECT * FROM warrior_scan_runs ORDER BY started_at DESC LIMIT 1').get();
  assert.equal(runRow.universe_pass, 1, "today's $20M dollar volume passes the $5M gate despite a $4M average");
});

test('phase 1 still rejects when average AND today are both illiquid', async () => {
  const f = fixture({ dailyBarsOverride: sleepyDailyBars(1000000) }); // today: 1M sh × $2 = $2M
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  const runRow = f.db.prepare('SELECT * FROM warrior_scan_runs ORDER BY started_at DESC LIMIT 1').get();
  assert.equal(runRow.universe_pass, 0, 'both averages and today below the gate — rejected');
});

function wakingDailyBars(todayVolume) {
  // Sleepy history (100k shares/day), prev close $10.15, today closes at
  // the minute tape's $10.55 on today's volume (+3.9% day — inside the
  // 5% chase cap, so the liquidity gates are what decide this test).
  const bars = [];
  let date = Date.parse('2026-09-29T13:30:00Z');
  for (let i = 0; i < 45; i++) {
    const last = i === 0;
    const second = i === 1;
    const c = last ? 10.55 : second ? 10.15 : 9.90;
    bars.unshift({
      t: new Date(date).toISOString(), o: c - 0.1, h: c + 0.1, l: c - 0.15,
      c, v: last ? todayVolume : 100000,
    });
    date -= 86400000;
  }
  return bars.map(b => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

test('paceRvol is time-of-day scaled: normal pace reads 1.0x at any time of day', () => {
  // Average day = 390,000 shares = 1,000/min over a 390-minute session.
  const at1000 = Date.parse('2026-09-29T14:00:00Z'); // 10:00 ET, 30 min elapsed
  assert.equal(paceRvol(45000, 390000, at1000), 1.5); // 1,500/min = 1.5x pace
  assert.equal(paceRvol(30000, 390000, at1000), 1.0); // exactly normal pace
  // The same 45,000 shares under the retired full-day ratio read 0.12x.
  assert.ok(45000 / 390000 < 1.5);
  // Elapsed clamps: 1 minute floor at the open, 390 cap at/after the close.
  assert.equal(paceRvol(1000, 390000, Date.parse('2026-09-29T13:30:00Z')), 1.0);
  assert.equal(paceRvol(390000, 390000, Date.parse('2026-09-29T20:00:00Z')), 1.0);
  assert.equal(paceRvol(100, 0, at1000), null);
  assert.equal(paceRvol(100, null, at1000), null);
});

test('scoreSymbol pace gate: a strong morning pace passes even when the full-day ratio cannot', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  // Today 400k shares vs 1M average day: full-day RVOL 0.40x (the retired
  // gate killed this shape all week). At the last bar (10:29 ET, 59 min
  // elapsed) the pace is (400k/59)/(1M/390) = 2.64x — eligible.
  const daily = mappedDaily();
  daily[daily.length - 1].v = 400000;
  const paced = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily,
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(paced.outcome, 'eligible', `strong pace must pass, got ${JSON.stringify(paced).slice(0, 300)}`);
  // Today 50k shares: pace (50k/59)/(1M/390) = 0.33x — still rejected,
  // at the momentum stage, by the pace gate.
  const slowDaily = mappedDaily();
  slowDaily[slowDaily.length - 1].v = 50000;
  const slow = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily: slowDaily,
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(slow.outcome, 'rejected');
  assert.equal(slow.stage, 'momentum');
  assert.match(slow.reason, /pace relative volume/i);
});

test("scoreSymbol admits a waking name on today's volume alone", async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  const waking = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily: wakingDailyBars(3000000),
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(waking.outcome, 'eligible', `today's volume must carry the liquidity gates, got ${JSON.stringify(waking).slice(0, 300)}`);
  const stillSleepy = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily: wakingDailyBars(100000),
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(stillSleepy.outcome, 'rejected');
  assert.equal(stillSleepy.stage, 'universe', 'average and today both illiquid — still rejected');
});

// --- Premarket scanning + hold-the-runner (Johnny 2026-10-01) ---------------
// (1) Scanning starts in the premarket (04:00 ET): ticks scan + score and
// premarket movers carry priority into the regular session, but NO entry
// order may leave before 09:30 ET. (2) After the partial banks, the
// runner is held until volume fades — the stop always stays live.

const PREMARKET_TIME = Date.parse('2026-09-29T12:00:00Z'); // 08:00 ET

test('premarket tick scans and scores but places no entries before 09:30 ET', async () => {
  const f = fixture();
  f.world.time = PREMARKET_TIME;
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(result.scan, 'a scan ran during the premarket window');
  const proposals = f.db.prepare('SELECT * FROM warrior_proposals WHERE user_id=1').all();
  assert.ok(proposals.length >= 1, 'the premarket scan produced scored proposals');
  assert.ok(proposals.every(p => p.status === 'pending'), 'no premarket proposal was approved');
  const entries = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST' && c.body?.side === 'buy');
  assert.equal(entries.length, 0, 'zero entry orders before the open');
  // Enforced in the order path itself, not just the scheduler loop:
  await assert.rejects(() => f.service.approveProposal(1, proposals[0].proposal_id), /scan-only/);
});

test('premarketScanOnly=false is honored: entries are allowed premarket when explicitly switched off', async () => {
  const f = fixture();
  f.world.time = PREMARKET_TIME;
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { premarketScanOnly: false } });
  const proposal = insertProposal(f.db);
  const approved = await f.service.approveProposal(1, proposal.proposal_id);
  assert.equal(approved.proposal.status, 'approved');
  const entries = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST' && c.body?.side === 'buy');
  assert.equal(entries.length, 1, 'exactly one premarket entry order with scan-only off');
});

test('premarket movers are boosted to the front of the regular-session rotation', async () => {
  const f = fixture({
    assets: ['AAA', 'BBB', 'CCC', 'DDD', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'ZZZ', percent_change: 42.5, price: 2.1, change: 0.63 }],
  });
  f.world.time = PREMARKET_TIME;
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { scanBudget: 2, autoApprove: false } });
  await f.service.run(1);
  const rows = f.db.prepare('SELECT symbol, priority FROM warrior_universe').all();
  const zzz = rows.find(r => r.symbol === 'ZZZ');
  assert.ok(zzz.priority >= 5, `premarket mover boosted (priority ${zzz.priority})`);
  for (const row of rows) {
    if (row.symbol !== 'ZZZ') assert.ok(zzz.priority > row.priority, `${row.symbol} must not outrank the premarket mover`);
  }
});

test('premarket phase-1 survivors join the watched set and are still watched at the open', async () => {
  // Screener returns nothing premarket (gainers: [] by default): the
  // fallback rotation scans, and the name that passes phase 1 must not be
  // forgotten — it is watched at the open even with the screen still empty.
  const f = fixture();
  f.world.time = PREMARKET_TIME;
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { autoApprove: false } });
  const pre = await f.service.run(1);
  assert.equal(pre.ok, true);
  assert.equal(pre.scan.funnel.fromRotation, 1, 'premarket cycle fell back to rotation with an empty screen');
  const watched = f.db.prepare("SELECT watched_on FROM warrior_universe WHERE symbol='AAA'").get();
  assert.equal(watched.watched_on, TODAY, 'the premarket phase-1 survivor is in the day\'s watched set');
  const callsAfterPre = f.world.calls.length;
  f.world.time = NOW; // the open — screen still returning nothing
  const open = await f.service.run(1);
  assert.equal(open.ok, true);
  assert.deepEqual(scannedSymbols(f, callsAfterPre), ['AAA'], 'the premarket survivor is scanned at the open');
  assert.equal(open.scan.funnel.fromWatched, 1, 'it arrived via the watched set, not a fresh rotation');
  assert.equal(open.scan.funnel.fromRotation, 0);
});

test('premarket gainers from the screen are candidates and watched immediately', async () => {
  const f = fixture({
    assets: ['AAA', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'ZZZ', percent_change: 18.0, price: 3.4, change: 0.52 }],
  });
  f.world.time = PREMARKET_TIME;
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { autoApprove: false } });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.fromScreen, 1, 'the premarket screen name is a candidate in the premarket cycle itself');
  assert.deepEqual(scannedSymbols(f), ['ZZZ']);
  const watched = f.db.prepare("SELECT watched_on FROM warrior_universe WHERE symbol='ZZZ'").get();
  assert.equal(watched.watched_on, TODAY, 'the premarket gainer is watched from that moment on');
});

test('stored rules from before the premarket feature get scanning switched on once, never re-forced', async () => {
  const f = fixture();
  await connectAndGet(f);
  const legacy = { ...DEFAULT_WARRIOR_RULES, premarketEnabled: false };
  f.db.prepare('UPDATE warrior_settings SET rules=? WHERE user_id=1').run(JSON.stringify(legacy));
  f.recreate(); // next boot applies the one-shot upgrade
  let stored = JSON.parse(f.db.prepare('SELECT rules FROM warrior_settings WHERE user_id=1').get().rules);
  assert.equal(stored.premarketEnabled, true, "Johnny's order reaches existing stored rules");
  // Johnny later turns it off in settings — the upgrade must never undo that.
  stored.premarketEnabled = false;
  f.db.prepare('UPDATE warrior_settings SET rules=? WHERE user_id=1').run(JSON.stringify(stored));
  f.recreate();
  stored = JSON.parse(f.db.prepare('SELECT rules FROM warrior_settings WHERE user_id=1').get().rules);
  assert.equal(stored.premarketEnabled, false, 'a later explicit choice is never overridden');
});

function seedRunner(f, overrides = {}) {
  insertProposal(f.db);
  const pos = seedOpenPosition(f.db, { qty: 5, target_price: 115, ...overrides });
  f.db.prepare('UPDATE warrior_positions SET partial_taken=1, breakeven_set=1 WHERE position_id=?')
    .run(pos.position_id);
  return pos;
}

test('holdRunners holds the remainder past the old fixed target while volume is strong', async () => {
  const f = fixture();
  await connectAndGet(f);
  // Isolate the target-suppression behavior: the default tape's RSI is
  // 100, so the RSI take-profit (Johnny 2026-10-12) is switched off here
  // — it has its own tests below.
  await f.service.setSettings(1, { rules: { takeProfitRsi: 0 } });
  seedRunner(f);
  f.world.positions = [{ symbol: 'AAA', qty: '5', avg_entry_price: '100', current_price: '120' }];
  f.world.latestPrice = 120; // beyond the 115 target — the old engine dumped here
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 120;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get('pos-test-1');
  assert.equal(row.status, 'open', 'the runner is still held past the fixed target');
  const marketSells = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST'
    && c.body?.side === 'sell' && c.body?.type === 'market');
  assert.equal(marketSells.length, 0, 'no exit order was submitted');
  const stopProtection = f.world.calls.filter(c => c.path === '/v2/orders' && c.method === 'POST'
    && c.body?.type === 'stop' && c.body?.symbol === 'AAA');
  assert.ok(stopProtection.length >= 1, 'the runner is protected stop-only');
  assert.equal(stopProtection[stopProtection.length - 1].body.qty, 5);
});

test('holdRunners=false restores the fixed-target full exit', async () => {
  const f = fixture();
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { holdRunners: false } });
  seedRunner(f);
  f.world.positions = [{ symbol: 'AAA', qty: '5', avg_entry_price: '100', current_price: '120' }];
  f.world.latestPrice = 120;
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 120;
  await f.service.run(1);
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.ok(trade, 'the target exit is journaled');
  assert.equal(trade.exitReason, 'target');
});

function fadingTape() {
  // 40 one-minute bars from 13:20Z: 20k-share bars while price grinds
  // 110 -> 112, then volume collapses to 4k and the final close breaks
  // the prior bar's low — the volume-fade signature.
  const bars = [];
  const start = Date.parse('2026-09-29T13:20:00Z');
  for (let i = 0; i < 40; i++) {
    let c; let v;
    if (i < 37) { c = 110 + i * (2 / 36); v = 20000; }
    else if (i === 37) { c = 112; v = 4000; }
    else if (i === 38) { c = 111.9; v = 4000; }
    else { c = 111.5; v = 4000; }
    bars.push({ t: new Date(start + i * 60000).toISOString(), o: c - 0.05, h: c + 0.1, l: c - 0.05, c, v });
  }
  bars[38].l = 111.85; bars[38].o = 111.95; bars[38].h = 112.0;
  return bars;
}

test('holdRunners exits the remainder when volume fades and price stalls', async () => {
  const f = fixture();
  await connectAndGet(f);
  seedRunner(f);
  f.world.minuteBarsOverride = () => fadingTape();
  f.world.positions = [{ symbol: 'AAA', qty: '5', avg_entry_price: '100', current_price: '111.5' }];
  f.world.latestPrice = 111.5;
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 111.5;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get('pos-test-1');
  assert.equal(row.status, 'closed', 'the faded runner was exited');
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.ok(trade, 'the fade exit is journaled');
  assert.equal(trade.exitReason, 'volume_fade');
});

test('the stop-loss still fires under holdRunners', async () => {
  const f = fixture();
  await connectAndGet(f);
  seedRunner(f);
  f.world.positions = [{ symbol: 'AAA', qty: '5', avg_entry_price: '100', current_price: '94' }];
  f.world.latestPrice = 94; // below the 95 stop
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 94;
  await f.service.run(1);
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.ok(trade, 'the stop exit is journaled');
  assert.equal(trade.exitReason, 'stop');
});

test('EOD flatten still flattens a held runner at 15:55 ET', async () => {
  const f = fixture();
  await connectAndGet(f);
  seedRunner(f);
  f.db.prepare('UPDATE warrior_positions SET banked_pnl=50 WHERE position_id=?').run('pos-test-1');
  f.world.positions = [{ symbol: 'AAA', qty: '5', avg_entry_price: '100', current_price: '120' }];
  f.world.latestPrice = 120; // far beyond the old target — held as a runner
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 120;
  f.world.time = Date.parse('2026-09-29T19:56:00Z'); // 15:56 ET
  await f.service.run(1);
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.ok(trade, 'the EOD exit is journaled');
  assert.equal(trade.exitReason, 'eod_flatten');
  assert.equal(Number(trade.pnl), 150, 'P&L is the runner leg (120-100)*5 plus the banked partial 50');
});

// --- Best-evaluation journal (Johnny 2026-10-12) ----------------------------
// Warrior had NO per-symbol rejection record, so a zero-trade day could not
// name the gate that killed each name. warrior_best_evaluations now keeps
// exactly one row per symbol/day — the furthest-progress evaluation, with
// the killing gate and its measured values. Record-keeping only: no trading
// path reads the table, and a journal failure must never break a scan.

test('journal records a chase-killed evaluation with its measured day-change', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  const daily = mappedDaily();
  const prev = daily[daily.length - 2];
  prev.c = 8.94; prev.o = 8.84; prev.h = 9.04; prev.l = 8.79; // day is +18.0%
  const r = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily,
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.stage, 'momentum');
  const rows = f.service.bestEvaluations(1, TODAY);
  assert.equal(rows.length, 1, 'exactly one journal row for the symbol/day');
  const row = rows[0];
  assert.equal(row.symbol, 'AAA');
  assert.equal(row.stage, 'momentum');
  assert.equal(row.gate, 'momentum');
  assert.match(row.reason, /chase limit/);
  assert.ok(Math.abs(row.dayChangePct - 18.0) < 0.2, `measured day-change recorded, got ${row.dayChangePct}`);
  assert.ok(row.evaluatedAt, 'evaluation timestamp recorded');
  assert.ok(Number.isFinite(row.price), 'price at evaluation recorded');
});

test('journal records a pace-RVOL kill with its measured pace', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  const daily = mappedDaily();
  daily[daily.length - 1].v = 50000; // pace (50k/59min)/(1M/390min) = 0.33x
  const r = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily,
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.stage, 'momentum');
  assert.match(r.reason, /pace relative volume/i);
  const rows = f.service.bestEvaluations(1, TODAY);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.stage, 'momentum');
  assert.ok(row.paceRvol != null && row.paceRvol > 0.2 && row.paceRvol < 0.5,
    `measured pace recorded, got ${row.paceRvol}`);
  assert.match(row.reason, /0\.33x/, 'the reason carries the measured pace');
});

test('journal records a pattern-pass/score-kill with its score and pattern name', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  // The synthetic tape fires CandleOverCandle; an unreachable score minimum
  // isolates the score gate as the killer.
  const rules = { ...DEFAULT_WARRIOR_RULES, minScoreBull: 99, minScoreNeutral: 99, minScoreBear: 99 };
  const r = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily: mappedDaily(),
    rules, account: { equity: '100000' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.stage, 'score');
  const rows = f.service.bestEvaluations(1, TODAY);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.stage, 'score');
  assert.equal(row.gate, 'score');
  assert.equal(row.pattern, 'CandleOverCandle', 'the fired pattern is named');
  assert.equal(row.score, r.score, 'the measured score is recorded');
  assert.match(row.reason, /below BULLISH minimum 99/);
});

test('best-evaluation upsert keeps the furthest stage, one row per symbol/day', async () => {
  const f = fixture();
  const record = f.service._recordBestEvaluation;
  record(1, { symbol: 'AAA', stage: 'momentum', reason: 'chase', dayChangePct: 18, tradeDate: TODAY });
  record(1, { symbol: 'AAA', stage: 'pattern', reason: 'No enabled pattern detected a valid setup.', tradeDate: TODAY });
  record(1, { symbol: 'AAA', stage: 'universe', reason: 'price band', tradeDate: TODAY });
  let rows = f.db.prepare('SELECT * FROM warrior_best_evaluations WHERE symbol=?').all('AAA');
  assert.equal(rows.length, 1, 'one row per symbol/day — no per-tick history');
  let best = JSON.parse(rows[0].data);
  assert.equal(best.stage, 'pattern', 'a weaker later evaluation never replaces the best');
  assert.equal(best.pattern, 'NO_PATTERN', 'a pattern-stage kill with no pattern reads NO_PATTERN');
  record(1, { symbol: 'AAA', stage: 'score', reason: 'Score 7 below BULLISH minimum 9.', pattern: 'BullFlag', score: 7, tradeDate: TODAY });
  record(1, { symbol: 'AAA', stage: 'pattern', reason: 'No enabled pattern detected a valid setup.', tradeDate: TODAY });
  rows = f.db.prepare('SELECT * FROM warrior_best_evaluations WHERE symbol=?').all('AAA');
  assert.equal(rows.length, 1);
  best = JSON.parse(rows[0].data);
  assert.equal(best.stage, 'score', 'a strictly further evaluation replaces the best');
  assert.equal(best.score, 7);
  assert.equal(best.pattern, 'BullFlag');
  // Ranking sanity: stages are strictly ordered along the gate stack.
  const rank = f.service._bestStageRank;
  assert.ok(rank({ stage: 'score', score: 7 }) > rank({ stage: 'pattern' }));
  assert.ok(rank({ stage: 'pattern' }) > rank({ stage: 'momentum' }));
  assert.ok(rank({ stage: 'momentum' }) > rank({ stage: 'universe' }));
  assert.ok(rank({ stage: 'eligible', score: 1 }) > rank({ stage: 'score', score: 99 - 83 }),
    'an eligible evaluation outranks every kill');
});

test('pruning the journal keeps today and the prior day only', async () => {
  const f = fixture();
  const record = f.service._recordBestEvaluation;
  record(1, { symbol: 'NEW', stage: 'pattern', reason: 'x', tradeDate: '2026-09-29' }); // today (NOW)
  record(1, { symbol: 'PRIOR', stage: 'pattern', reason: 'x', tradeDate: '2026-09-28' }); // prior day — kept
  record(1, { symbol: 'OLD', stage: 'pattern', reason: 'x', tradeDate: '2026-09-27' }); // older — pruned
  f.service.pruneDiagnostics(1);
  const kept = f.db.prepare('SELECT symbol FROM warrior_best_evaluations ORDER BY symbol').all().map(r => r.symbol);
  assert.deepEqual(kept, ['NEW', 'PRIOR'], 'today + prior day survive; anything older is pruned');
});

test('a journal failure does not break the scan cycle', async () => {
  const f = fixture();
  await connectAndGet(f);
  // Simulate a broken journal: every record write will fail inside the
  // recorder. The scan must still run, propose, and report its funnel.
  f.db.exec('DROP TABLE warrior_best_evaluations');
  const result = await f.service.run(1);
  assert.equal(result.ok, true, 'the scan cycle completes despite the journal failure');
  assert.ok(result.scan, 'a scan ran');
  assert.equal(result.scan.funnel.proposals, 1, 'the proposal path is unaffected');
});

test('day funnel totals and watched-set size are computed for a fixture day', async () => {
  const f = fixture({
    assets: ['AAA', 'BBB', 'CCC', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'ZZZ', percent_change: 42.5, price: 2.1, change: 0.63 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { scanBudget: 2, autoApprove: false } });
  const first = await f.service.run(1);
  assert.equal(first.scan.funnel.fromScreen, 1);
  f.world.gainers = []; // ZZZ slips off the screen — it stays watched
  const second = await f.service.run(1);
  assert.equal(second.scan.funnel.fromWatched, 1);
  const totals = f.service.dayFunnelTotals(1, TODAY);
  assert.equal(totals.fromScreen, 1, 'screen counts sum across the day\'s runs');
  assert.equal(totals.fromWatched, 1, 'watched counts sum across the day\'s runs');
  assert.equal(totals.fromRotation, 0);
  assert.equal(totals.runs, 2);
  assert.equal(totals.watchedCount, 1, 'one distinct name in the day\'s watched set');
  const section = f.service.nearMissSection(1, TODAY);
  assert.equal(section.tradeDate, TODAY);
  assert.equal(section.funnel.fromScreen, 1);
  assert.equal(section.funnel.fromWatched, 1);
  assert.equal(section.watchedCount, 1);
  assert.ok(Array.isArray(section.nearMisses), 'the section carries the near-miss records');
});

// --- Funnel persistence (step-0 diagnostic, Johnny 2026-10-12) -------------
// Monday's production funnel summed fromScreen/fromWatched/fromRotation
// 0/0/0 across 708 runs and 19,590 symbols scanned. These tests drive a
// real scanCycle through run() with the broker stubbed and assert the
// PERSISTED warrior_scan_runs row — not just the in-memory funnel the
// cycle returns. (Git history: commit 49d6001 counted the sources only
// in memory and its persisted UPDATE omitted the from_* columns; the
// columns + persisted write landed in a6c323c, after Monday's close.)

test('funnel persistence: a gainers-screen cycle persists from_screen > 0 on the scan-run row', async () => {
  const f = fixture({
    assets: ['AAA', 'BBB', 'CCC', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'ZZZ', percent_change: 42.5, price: 2.1, change: 0.63 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { scanBudget: 2, autoApprove: false } });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.fromScreen, 1, 'the in-memory funnel counts the screen name');
  const row = f.db.prepare('SELECT * FROM warrior_scan_runs ORDER BY started_at DESC LIMIT 1').get();
  assert.ok(row, 'a scan-run row was persisted');
  assert.ok(row.from_screen > 0, `the persisted row carries from_screen > 0, got ${row.from_screen}`);
  assert.equal(row.from_screen, 1);
  assert.ok(row.symbols_scanned > 0, `the persisted row carries symbols_scanned > 0, got ${row.symbols_scanned}`);
  assert.equal(row.symbols_scanned, 1);
});

test('funnel persistence: an empty screener persists from_watched or from_rotation > 0 on the scan-run row', async () => {
  const f = fixture(); // gainers default [] — screen empty, watched set empty → rotation
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  const row = f.db.prepare('SELECT * FROM warrior_scan_runs ORDER BY started_at DESC LIMIT 1').get();
  assert.ok(row, 'a scan-run row was persisted');
  assert.ok(row.symbols_scanned > 0, `the persisted row carries symbols_scanned > 0, got ${row.symbols_scanned}`);
  assert.ok((row.from_watched || 0) + (row.from_rotation || 0) > 0,
    `the persisted row stamps a fallback source, got watched=${row.from_watched} rotation=${row.from_rotation}`);
  assert.ok(row.from_rotation > 0, 'with an empty watched set the rotation fallback is the stamped source');
});

// --- Gainers screen endpoint + off-catalog gainers (2026-10-13) ------------
// Production root cause of Tuesday's 0/0/28,200 funnel: loadGainers called
// /v1beta1/screener/stocks/gainers-losers, a path Alpaca does not expose —
// it 404s, request() throws, and the loader returned null on EVERY cycle,
// so the fail-soft rotation carried every scan while the tests stubbed the
// wrong path and stayed green. The real screener endpoint is stocks/movers
// (the call ORB's market universe uses), and a gainer must be able to enter
// the scan even when the assets catalog never carried it.

test('funnel persistence: a gainer missing from the assets catalog still scans from the screen and joins the watched set', async () => {
  const f = fixture({
    // NEWG is deliberately NOT in the catalog the universe is built from.
    assets: ['AAA', 'BBB'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'NEWG', percent_change: 55.0, price: 3.1, change: 1.1 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { autoApprove: false } });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(f.world.calls.some(c => c.path === '/v1beta1/screener/stocks/movers'), 'the real movers endpoint was queried');
  assert.equal(result.scan.funnel.fromScreen, 1, 'the off-catalog gainer counts as a screen candidate');
  assert.equal(result.scan.funnel.fromRotation, 0, 'rotation contributes nothing when the screen answers');
  assert.deepEqual(scannedSymbols(f), ['NEWG'], 'the off-catalog gainer is the scanned symbol');
  const row = f.db.prepare('SELECT * FROM warrior_scan_runs ORDER BY started_at DESC LIMIT 1').get();
  assert.ok(row.from_screen > 0, `the persisted row carries from_screen > 0, got ${row.from_screen}`);
  assert.equal(row.from_screen, 1);
  const watched = f.db.prepare("SELECT watched_on FROM warrior_universe WHERE symbol='NEWG'").get();
  assert.ok(watched, 'the off-catalog gainer landed in warrior_universe');
  assert.equal(watched.watched_on, TODAY, 'the off-catalog gainer is in the day\'s watched set');
});

// --- Chase cap 5 + RSI take-profit (Johnny 2026-10-12) ---------------------
// "Make that +5%. We need to catch these early." and "high volume, up 5%,
// top gainers.. take profit at 75 RSI."

test('chase cap defaults: 5% cap, RSI take-profit 75, exemption ceilings still 60, min gain still 2', () => {
  assert.equal(DEFAULT_WARRIOR_RULES.maxChasePct, 5);
  assert.equal(DEFAULT_WARRIOR_RULES.takeProfitRsi, 75);
  assert.equal(DEFAULT_WARRIOR_RULES.secondLegMaxChasePct, 60);
  assert.equal(DEFAULT_WARRIOR_RULES.premarketBreakMaxChasePct, 60);
  assert.equal(DEFAULT_WARRIOR_RULES.minPctGain, 2);
});

test('chase cap 5: a +7% day is refused with the 5% reason', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  const daily = mappedDaily();
  const prev = daily[daily.length - 2];
  prev.c = 9.86; prev.o = 9.76; prev.h = 9.96; prev.l = 9.71; // day is +7.0%
  const r = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily,
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.stage, 'momentum');
  assert.match(r.reason, /above 5% chase limit/, `the refusal names the new cap, got: ${r.reason}`);
  assert.match(r.reason, /7\.00%/, 'the refusal carries the measured day change');
});

test('chase cap 5: a +4% day proceeds past the chase gate', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.db.prepare('INSERT INTO warrior_leases(user_id,token,expires_at) VALUES (1,?,?)').run('t', NOW + 3600000);
  // The standard fixture day is +4.0% (prev close 10.14 → 10.55).
  const r = f.service.scoreSymbol({
    uid: 1, symbol: 'AAA', m1: mappedMinute(), daily: mappedDaily(),
    rules: DEFAULT_WARRIOR_RULES, account: { equity: '100000' },
  });
  assert.equal(r.outcome, 'eligible', `a +4% day with a valid pattern passes every gate, got ${JSON.stringify(r).slice(0, 300)}`);
});

test('chase cap 5: the second-leg exemption still bypasses at +7% (under its 60% ceiling)', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => secondLegBars();
  f.world.dailyBarsOverride = secondLegDaily(10.39); // +7.0% day — past the 5% cap, under the 60% ceiling
  await f.service.setSettings(1, { rules: { autoApprove: false }, allowedPatterns: ONLY_SECOND_LEG });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 1, 'the re-break still opens the chase door at +7%');
  const pending = f.service.proposals(1, { status: 'pending' }).proposals;
  assert.equal(pending[0].pattern_name, 'SecondLeg');
});

test('chase cap 5: the premarket-break exemption still bypasses at +7% (under its 60% ceiling)', async () => {
  const f = fixture();
  await connectAndGet(f);
  f.world.minuteBarsOverride = () => pmBreakBars();
  f.world.dailyBarsOverride = pmBreakDaily(9.67); // +7.0% day — past the 5% cap, under the 60% ceiling
  await f.service.setSettings(1, { rules: { autoApprove: false }, allowedPatterns: ONLY_PREMARKET_BREAK });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.equal(result.scan.funnel.proposals, 1, 'the early break still opens the chase door at +7%');
  const pending = f.service.proposals(1, { status: 'pending' }).proposals;
  assert.equal(pending[0].pattern_name, 'PremarketBreak');
});

// RSI tapes: closes engineered against indicators.rsiSeries (Wilder).
// Tape A climbs +0.15/bar with no down bar → RSI(14) = 100, last 105.85.
// Tape B repeats +0.31/+0.31/−0.195 → RSI(14) = 74.80, last 105.59.
const { rsiSeries } = require('../lib/warrior/indicators');
function rsiTape(closes) {
  const start = Date.parse('2026-09-29T13:30:00Z');
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: new Date(start + i * 60000).toISOString(), o, h: Math.max(o, c) + 0.02, l: Math.min(o, c) - 0.02, c, v: 20000 };
  });
}
function climbCloses() {
  const closes = [100];
  for (let i = 1; i < 40; i++) closes.push(+(closes[i - 1] + 0.15).toFixed(2));
  return closes;
}
function borderlineCloses() {
  const closes = [100];
  for (let i = 1; i < 40; i++) {
    const step = i % 3 === 0 ? -0.195 : 0.31;
    closes.push(Math.round((closes[i - 1] + step) * 100) / 100);
  }
  return closes;
}
function seedManagedPosition(f, overrides = {}) {
  insertProposal(f.db);
  const pos = seedOpenPosition(f.db, overrides);
  f.db.prepare('UPDATE warrior_positions SET breakeven_set=1 WHERE position_id=?').run(pos.position_id);
  return pos;
}

test('RSI take-profit fires at RSI >= 75 and closes the full position, journaled with the measured RSI', async () => {
  const f = fixture();
  await connectAndGet(f);
  const closes = climbCloses();
  assert.equal(rsiSeries(closes, 14)[closes.length - 1], 100, 'tape A is a max-RSI tape');
  seedManagedPosition(f); // 10 shares, entry 100, stop 95, target 110
  f.world.minuteBarsOverride = () => rsiTape(closes);
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100', current_price: '105.85' }];
  f.world.latestPrice = 105.85;
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 105.85;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get('pos-test-1');
  assert.equal(row.status, 'closed', 'the RSI exit closed the position');
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.ok(trade, 'the RSI exit is journaled');
  assert.equal(trade.exitReason, 'RSI_TAKE_PROFIT');
  assert.equal(Number(trade.shares), 10, 'the FULL position exited');
  assert.equal(Number(trade.exitPrice), 105.85);
  assert.equal(Number(trade.pnl), 58.5, 'realized P&L is journaled: (105.85-100) x 10');
  const ind = JSON.parse(trade.indicators || '{}');
  assert.equal(ind.rsi14, 100, 'the measured RSI is journaled with the exit');
});

test('RSI take-profit does not fire just below 75 (RSI 74.8 tape)', async () => {
  const f = fixture();
  await connectAndGet(f);
  const closes = borderlineCloses();
  const rsi = rsiSeries(closes, 14)[closes.length - 1];
  assert.ok(rsi < 75 && rsi > 74.5, `tape B sits just under the line, RSI=${rsi && rsi.toFixed(2)}`);
  seedManagedPosition(f);
  f.world.minuteBarsOverride = () => rsiTape(closes);
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100', current_price: '105.59' }];
  f.world.latestPrice = 105.59;
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 105.59;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get('pos-test-1');
  assert.equal(row.status, 'open', 'no RSI exit below 75 — the position is still managed');
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.equal(trade, undefined, 'nothing is journaled');
});

test('RSI take-profit after a partial target closes only the remainder', async () => {
  const f = fixture();
  await connectAndGet(f);
  seedRunner(f); // 5 shares remain of 10, partial_taken=1, breakeven_set=1
  f.db.prepare('UPDATE warrior_positions SET banked_pnl=50 WHERE position_id=?').run('pos-test-1');
  f.world.minuteBarsOverride = () => rsiTape(climbCloses());
  f.world.positions = [{ symbol: 'AAA', qty: '5', avg_entry_price: '100', current_price: '105.85' }];
  f.world.latestPrice = 105.85;
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 105.85;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get('pos-test-1');
  assert.equal(row.status, 'closed', 'the RSI exit closed the runner remainder');
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.ok(trade, 'the RSI exit is journaled');
  assert.equal(trade.exitReason, 'RSI_TAKE_PROFIT');
  assert.equal(Number(trade.shares), 5, 'only the remaining 5 shares exit — the banked partial is untouched');
  assert.equal(Number(trade.pnl), 79.25, 'P&L is the remainder leg (105.85-100) x 5 plus the banked partial 50');
});

test('RSI take-profit never fires when the rule is disabled (0)', async () => {
  const f = fixture();
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { takeProfitRsi: 0 } });
  seedManagedPosition(f);
  f.world.minuteBarsOverride = () => rsiTape(climbCloses()); // RSI 100 tape
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100', current_price: '105.85' }];
  f.world.latestPrice = 105.85;
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 105.85;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get('pos-test-1');
  assert.equal(row.status, 'open', 'a disabled RSI rule never exits');
  const trade = f.db.prepare('SELECT * FROM warrior_trades WHERE tradeId=?').get('pos-test-1');
  assert.equal(trade, undefined, 'nothing is journaled');
});

test('RSI unavailable (insufficient bars) takes no action and leaves one throttled note', async () => {
  const f = fixture();
  await connectAndGet(f);
  seedManagedPosition(f);
  f.world.minuteBarsOverride = () => rsiTape(climbCloses().slice(0, 10)); // 10 bars < the 15 RSI needs
  f.world.positions = [{ symbol: 'AAA', qty: '10', avg_entry_price: '100', current_price: '101.35' }];
  f.world.latestPrice = 101.35;
  f.world.autoFillExits = true;
  f.world.marketFillPrice = 101.35;
  await f.service.run(1);
  const row = f.db.prepare('SELECT * FROM warrior_positions WHERE position_id=?').get('pos-test-1');
  assert.equal(row.status, 'open', 'no RSI action on insufficient bars');
  const notes = f.db.prepare("SELECT * FROM warrior_alerts WHERE message LIKE '%RSI unavailable%'").all();
  assert.equal(notes.length, 1, 'exactly one throttled RSI-unavailable note is journaled');
});
