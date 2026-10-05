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
  PRE_TRADE_CHECKS, assessOrderFlow, preTradeInputs,
} = require('../lib/warrior/service');
const { createCredentialVault } = require('../lib/credential-vault');

const NOW = Date.parse('2026-09-29T14:00:00Z'); // Tue 10:00 ET — regular session
const TODAY = '2026-09-29';
const clone = value => JSON.parse(JSON.stringify(value));

// --- synthetic market data --------------------------------------------------
// Minute tape engineered to trigger CandleOverCandle on the last bar:
// steady climb (MACD positive, close above VWAP), final bar B breaks A's high
// with >= volume. Daily tape: +6.5% day, 3x relative volume.
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
    const c = last ? 10.55 : 9.90 - i * 0.01;
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
      if (path === '/v1beta1/screener/stocks/gainers-losers') {
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
    'warrior_backtests', 'warrior_backtest_trades', 'warrior_universe', 'warrior_leases']) {
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

// --- Live movers feed + today's-volume liquidity gates (Johnny 2026-10-01) --
// SSM sat flat all morning, then ran +96% from 1:25 PM ET. Two changes so
// Warrior can catch that class: (1) the screener's top gainers / most
// actives jump the scan rotation; (2) today's actual volume satisfies the
// liquidity gates as an alternative to the 20-day average.

test('scan puts live top gainers at the front of the scan queue', async () => {
  const f = fixture({
    assets: ['AAA', 'BBB', 'CCC', 'ZZZ'].map(symbol => ({ symbol, class: 'us_equity', status: 'active', tradable: true })),
    gainers: [{ symbol: 'ZZZ', percent_change: 42.5, price: 2.1, change: 0.63 }],
  });
  await connectAndGet(f);
  await f.service.setSettings(1, { rules: { scanBudget: 2, autoApprove: false } });
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(f.world.calls.some(c => c.path === '/v1beta1/screener/stocks/gainers-losers'), 'screener was queried');
  const dailyCall = f.world.calls.find(c => c.path === '/v2/stocks/bars'
    && new URL(c.url).searchParams.get('timeframe') === '1Day'
    && !new URL(c.url).searchParams.get('symbols').includes('SPY'));
  assert.ok(dailyCall, 'daily bars were loaded for the scan');
  const scanned = new URL(dailyCall.url).searchParams.get('symbols').split(',');
  assert.equal(scanned.length, 2, 'scan budget respected');
  assert.equal(scanned[0], 'ZZZ', 'the top gainer is scanned first, ahead of the rotation');
});

test('a screener outage never breaks the scan (fail-soft to rotation)', async () => {
  const f = fixture({ moversError: true });
  await connectAndGet(f);
  const result = await f.service.run(1);
  assert.equal(result.ok, true);
  assert.ok(result.scan, 'a scan ran');
  assert.equal(result.scan.funnel.proposals, 1, 'rotation scan still produces its proposal');
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
  // Sleepy history (100k shares/day), prev close $10.00, today closes at
  // the minute tape's $10.55 on today's volume.
  const bars = [];
  let date = Date.parse('2026-09-29T13:30:00Z');
  for (let i = 0; i < 45; i++) {
    const last = i === 0;
    const second = i === 1;
    const c = last ? 10.55 : second ? 10.00 : 9.90;
    bars.unshift({
      t: new Date(date).toISOString(), o: c - 0.1, h: c + 0.1, l: c - 0.15,
      c, v: last ? todayVolume : 100000,
    });
    date -= 86400000;
  }
  return bars.map(b => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

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
