/* Flipper Bot — "Invisible Wall Reversal" trading controls.
 * The bot watches four pre-market walls (yesterday's range high/low + the
 * nearest significant prior swing high/low) and trades 3-candle reversals
 * when price tests a wall in one of the first two 15-minute candles after
 * the 9:30 ET open (the confirmation candle follows the touch candle).
 * PAPER is the default; live orders require all three live gates
 * (tradingMode=LIVE + both live switches) and are refused loudly otherwise.
 * Reuses the shared warrior skin classes (war-*) — warrior.css is global.
 * All panels render real API data; empty states say "no data yet".
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const isNumber = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));
  const money = value => isNumber(value) ? Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—';
  const number = (value, digits = 2) => isNumber(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const pct = value => isNumber(value) ? `${number(value)}%` : '—';
  const time = value => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d) ? d.toLocaleTimeString() : '—'; };
  const day = value => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d) ? d.toLocaleDateString() : '—'; };
  const pick = (obj, ...keys) => { for (const k of keys) { if (obj && obj[k] != null) return obj[k]; } return null; };
  let mounted = false, polling = null, status = null, refreshing = false, changing = false, revision = 0;
  let settingsView = null, activeBacktest = null;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response. Refresh to verify the current state.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (!data || typeof data !== 'object') throw new Error('Server response is incomplete.');
    return data;
  }
  function notice(message, error) { const el = $('flpNotice'); if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); } }

  /* Every DEFAULT_FLIPPER_RULES key, grouped for the settings form. */
  const RULE_SCHEMA = [
    { group: 'Universe & liquidity', fields: [
      ['minPrice', 'Min price ($)', 'number', 0.1], ['maxPrice', 'Max price ($)', 'number', 1],
      ['minAvgDailyVolume', 'Min avg daily volume (shares)', 'number', 100000],
      ['minDayVolume', 'Min current-day volume (shares)', 'number', 10000],
      ['maxSpreadPct', 'Max bid/ask spread (%)', 'number', 0.05],
      ['includeETFs', 'Include ETFs', 'checkbox'],
      ['scanBudget', 'Scan budget (symbols/cycle)', 'number', 10] ] },
    { group: 'Invisible walls (pre-market)', fields: [
      ['swingLookback', 'Swing lookback N (2N+1 fractal)', 'number', 1],
      ['flipGapPct', 'Flip-wall min gap from range wall (%)', 'number', 0.1],
      ['flipLookbackBars', 'Flip swing search (daily bars)', 'number', 10],
      ['wallTolerancePct', 'Wall touch tolerance (%)', 'number', 0.05],
      ['touchWindowCandles', 'Touch window (15-min candles after 9:30)', 'number', 1] ] },
    { group: 'Entry filters', fields: [
      ['minC1MovePct', 'Min Candle-1 move (%)', 'number', 0.25],
      ['breakoutCancelPct', 'Breakout cancel beyond wall (%)', 'number', 0.05] ] },
    { group: 'Stop loss', fields: [
      ['stopMode', 'Stop mode', 'select', ['structure', 'percent', 'dollars']],
      ['stopBufferPct', 'Buffer beyond Candle-1 extreme (%)', 'number', 0.05],
      ['stopPercent', 'Fixed stop (%)', 'number', 0.1],
      ['stopDollars', 'Fixed stop ($)', 'number', 0.01] ] },
    { group: 'Take profit', fields: [
      ['targetMode', 'Target mode', 'select', ['full', 'partial_runner', 'rr']],
      ['partialPct', 'Partial size at first target (%)', 'number', 5],
      ['runnerTrailPct', 'Runner trail (%)', 'number', 0.1],
      ['rrTarget', 'Risk/reward target (R)', 'number', 0.5] ] },
    { group: 'Position sizing', fields: [
      ['sizeMode', 'Sizing mode', 'select', ['shares', 'dollars', 'risk']],
      ['defaultShares', 'Default shares', 'number', 10],
      ['defaultDollars', 'Default dollar size ($)', 'number', 100],
      ['riskPct', 'Risk per trade (%)', 'number', 0.1],
      ['maxRiskPerTradePct', 'Max risk per trade (%)', 'number', 0.1] ] },
    { group: 'Daily guards', fields: [
      ['maxPositions', 'Max open positions', 'number', 1],
      ['maxTradesPerDay', 'Max trades per day', 'number', 1],
      ['maxDailyLossPct', 'Max daily loss (%)', 'number', 0.5],
      ['eodFlattenTime', 'EOD flatten time (ET)', 'text'] ] },
    { group: 'Execution', fields: [
      ['limitOffsetPct', 'Limit offset from trigger (%)', 'number', 0.05],
      ['slippageBps', 'Backtest slippage (bps)', 'number', 1],
      ['commissionPerShare', 'Commission per share ($)', 'number', 0.001] ] },
    { group: 'Trading mode', fields: [
      ['tradingMode', 'Mode', 'select', ['PAPER', 'LIVE']],
      ['liveEnabled', 'Live switch 1 — enabled', 'checkbox'],
      ['liveConfirmed', 'Live switch 2 — confirmed', 'checkbox'] ] },
  ];

  /* SPEC §19 setup states: the 8 pinned state-machine states plus the
   * trade-lifecycle states the dashboard also surfaces. */
  const STATE_LABEL = {
    no_setup: 'No Setup', testing_wall: 'Testing Wall', waiting_c2: 'Waiting for Candle 2',
    waiting_trigger: 'Waiting for Trigger', long_triggered: 'Long Triggered',
    short_triggered: 'Short Triggered', trade_active: 'Trade Active',
    target_hit: 'Target Hit', stop_hit: 'Stop Hit', cancelled: 'Cancelled', expired: 'Expired',
  };
  const stateLabel = s => STATE_LABEL[s] || String(s || '—').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const WALL_LABEL = { range_high: 'Range High', flip_high: 'Flip High', range_low: 'Range Low', flip_low: 'Flip Low' };
  const wallLabel = w => WALL_LABEL[w] || String(w || '—').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  function pillState() {
    if (!status) return ['CHECKING', ''];
    const sched = String(status.schedulerStatus || '').toLowerCase();
    if (sched === 'error') return ['ERROR', 'war-bad'];
    if (!status.enabled) return ['DISABLED', ''];
    if (!status.connected) return ['PAPER–IDLE', ''];
    if (sched.includes('scan') || sched.includes('run') || sched.includes('active') || sched.includes('watch')) return ['PAPER–ACTIVE', 'war-good'];
    return ['PAPER–IDLE', ''];
  }

  function shell() {
    const page = $('page-flipper');
    if (!page || $('flpRoot')) return;
    page.innerHTML = `<section class="war-shell" id="flpRoot" aria-labelledby="flpTitle">
      <header class="war-hero"><div><span class="war-eyebrow">INVISIBLE WALL REVERSAL</span><h1 id="flpTitle">Flipper Bot <em>wait for the wall</em></h1><p>Four pre-market walls — yesterday&rsquo;s range high/low plus the nearest significant prior swing high/low. The bot waits for price to reach a wall in one of the first two 15-minute candles after the 9:30 ET open, confirms rejection on the next candle, and enters only on the confirmation-candle trigger break. No wall touch, no trade.</p></div><span class="war-auto-label" id="flpModeBadge">PAPER ONLY</span></header>
      <div class="war-notice" id="flpNotice" role="status" aria-live="polite"></div>
      <section class="war-status" aria-label="Flipper system status">
        <div><span>Status</span><strong id="flpPill">CHECKING</strong><small id="flpTradeDate">Trade date —</small></div>
        <div><span>Connection</span><strong id="flpConnection">CHECKING</strong><small id="flpAccount">Dedicated account required</small></div>
        <div><span>Open positions</span><strong id="flpOpen">—</strong><small id="flpPositionsNote">Under management</small></div>
        <div><span>Scheduler</span><strong id="flpScheduler">—</strong><small id="flpSchedulerNote">Server-owned cycle</small></div>
      </section>
      <section class="war-command"><div><span class="war-eyebrow">BOT CONTROL</span><h2 id="flpMandate">Connect an account to begin</h2><p id="flpMandateCopy">Connect a dedicated Alpaca paper account. Trading starts disabled — you enable it.</p><p id="flpBlockers" class="war-blockers"></p></div><button class="war-button war-quiet" id="flpEnabledToggle" disabled>Checking account</button></section>
      <section class="war-layout"><main class="war-main">
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">SETUP STATE MACHINE</span><h2>Today&rsquo;s setups</h2></div><span id="flpSetupMeta">Loading</span></div><div class="war-list" id="flpSetups"><p class="war-empty">Loading setups…</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">UNDER MANAGEMENT</span><h2>Positions</h2></div><span id="flpPositionMeta">Loading</span></div><div class="war-list" id="flpPositions"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">TRADE LOG</span><h2>Today&rsquo;s trades</h2></div><span id="flpTradeMeta">Loading</span></div><div class="war-list" id="flpTrades"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">VALIDATION</span><h2>Backtests</h2></div></div>
          <form class="war-bt-form" id="flpBtForm">
            <label>Symbols (comma separated)<input id="flpBtSymbols" value="SPY" maxlength="120"></label>
            <label>From<input id="flpBtFrom" type="date"></label>
            <label>To<input id="flpBtTo" type="date"></label>
            <button class="war-button" type="submit" id="flpBtRun">Run backtest</button>
          </form>
          <p class="war-note">Point-in-time backtests: walls for each date are computed only from bars strictly before that date — no future data, no repainted signals. Fills at the next 1-minute open plus slippage; stop is checked before target on the same bar; positions flatten at EOD.</p>
          <div class="war-list" id="flpBacktests"><p class="war-empty">No backtests yet.</p></div>
          <div id="flpBacktestDetail"></div>
        </article>
      </main>
      <aside class="war-rail">
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">DEDICATED BROKER</span><h2>Alpaca paper</h2></div></div><div class="war-account-row"><div><b>Paper</b><small id="flpPaperState">Checking</small></div><button class="war-button war-quiet" id="flpPaperConnect">Connect</button></div><p class="war-account-note">Flipper runs on its own dedicated Alpaca paper account — never shared with other bots or manual trading. Key and secret are never displayed back. Live connect is refused loudly: paper is the only working mode.</p></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">FULL CONFIG</span><h2>Settings</h2></div></div><div id="flpSettings"><p class="war-empty">Loading settings…</p></div><button class="war-button war-save" id="flpSave">Save settings</button></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">RISK DESK</span><h2>Alerts</h2></div></div><div class="war-list" id="flpAlerts"><p class="war-empty">No data yet.</p></div></article>
      </aside></section>
    </section>`;
    const today = new Date();
    const iso = d => d.toISOString().slice(0, 10);
    const to = $('flpBtTo'); const from = $('flpBtFrom');
    to.value = iso(today);
    const past = new Date(today); past.setDate(past.getDate() - 90);
    from.value = iso(past);
  }

  function renderStatus(tradeDate) {
    if (!status) return;
    const connected = !!status.connected;
    const [pillText, pillClass] = pillState();
    $('flpPill').textContent = pillText;
    $('flpPill').className = pillClass;
    $('flpModeBadge').textContent = `${String(status.mode || 'PAPER').toUpperCase()} ONLY`;
    $('flpTradeDate').textContent = tradeDate ? `Trade date ${esc(tradeDate)}` : 'Trade date —';
    $('flpConnection').textContent = connected ? 'PAPER CONNECTED' : 'DISCONNECTED';
    $('flpConnection').className = connected ? 'war-good' : 'war-bad';
    $('flpAccount').textContent = status.accountId ? `Account ${status.accountId}` : 'Dedicated Flipper account required';
    $('flpScheduler').textContent = String(status.schedulerStatus || 'IDLE').toUpperCase();
    $('flpSchedulerNote').textContent = status.schedulerReason || (status.lastCycleAt ? `Last cycle ${time(status.lastCycleAt)}` : 'No completed cycle yet');
    $('flpMandate').textContent = !connected ? 'Connect an account to begin' : !status.enabled ? 'Trading is paused' : 'Watching the walls';
    $('flpMandateCopy').textContent = !connected
      ? 'Connect a dedicated Alpaca paper account. Flipper ships disabled — enable trading when you are ready.'
      : status.enabled
        ? 'The server watches the four walls during the 9:30–10:30 ET setup window and manages open positions the rest of the session.'
        : 'Trading is paused. Existing positions remain under automatic management. New entries stay withheld until you resume.';
    $('flpBlockers').textContent = (status.blockers || []).join(' · ');
    const toggle = $('flpEnabledToggle');
    toggle.disabled = !connected || changing;
    toggle.textContent = !connected ? 'Connect Alpaca' : status.enabled ? 'Pause trading' : 'Resume trading';
    $('flpPaperState').textContent = connected ? 'Connected' : 'Not connected';
    $('flpPaperConnect').textContent = connected ? 'Manage' : 'Connect';
  }

  function renderSetups(data) {
    const el = $('flpSetups');
    const items = data?.setups || [];
    const meta = data?.tradeDate ? `${esc(data.tradeDate)} · ` : '';
    const statusText = typeof data?.status === 'string' && data.status ? ` · ${esc(data.status)}` : '';
    $('flpSetupMeta').textContent = items.length ? `${meta}${items.length} tracked` : 'No setups yet';
    if (data?.tradeDate) $('flpTradeDate').textContent = `Trade date ${data.tradeDate}${statusText ? ' · ' + data.status : ''}`;
    if (!items.length) { el.innerHTML = '<p class="war-empty">No setups — no data yet. The scanner builds walls pre-market and tracks each liquid symbol through the 9:30–10:30 ET window.</p>'; return; }
    el.innerHTML = items.map(s => {
      const dir = String(s.direction || '').toLowerCase();
      const dirClass = dir === 'long' ? 'war-good' : dir === 'short' ? 'war-bad' : '';
      const walls = s.walls || s.Walls || null;
      const wallsHtml = walls ? `<small>Range High ${money(pick(walls, 'rangeHigh', 'range_high'))} · Flip High ${money(pick(walls, 'flipHigh', 'flip_high'))} · Range Low ${money(pick(walls, 'rangeLow', 'range_low'))} · Flip Low ${money(pick(walls, 'flipLow', 'flip_low'))}</small>` : '';
      return `<div class="war-row"><div><b>${esc(s.symbol)}</b> <span class="war-tag ${dirClass}">${esc(dir ? dir.toUpperCase() : '—')}</span> <span class="war-tag">${esc(stateLabel(s.state))}</span>
        <small>${esc(wallLabel(s.wallType))} @ ${money(s.wallPrice)} · now ${money(s.currentPrice)} · ${isNumber(s.distancePct) ? `${number(s.distancePct)}% from wall` : 'distance —'}</small>
        ${wallsHtml}
        <small class="war-reason">${esc(s.why || 'No explanation recorded.')}</small></div></div>`;
    }).join('');
  }

  function renderPositions(items) {
    const el = $('flpPositions');
    $('flpPositionMeta').textContent = items?.length ? `${items.length} open` : 'Flat';
    $('flpOpen').textContent = String(items?.length ?? '—');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No open positions — no data yet.</p>'; return; }
    el.innerHTML = items.map(p => {
      const dir = String(pick(p, 'direction') || '').toLowerCase();
      const dirClass = dir === 'long' ? 'war-good' : dir === 'short' ? 'war-bad' : '';
      const entry = pick(p, 'entryPrice', 'entry_price'), stop = pick(p, 'stopPrice', 'stop_price'), target = pick(p, 'targetPrice', 'target_price');
      return `<div class="war-row"><div><b>${esc(pick(p, 'symbol'))}</b> <span class="war-tag ${dirClass}">${esc(dir ? dir.toUpperCase() : '')}</span> <span class="war-tag">${esc(pick(p, 'status') || 'open')}</span>
        <small>${esc(wallLabel(pick(p, 'wallType', 'wall_type')))} @ ${money(pick(p, 'wallPrice', 'wall_price'))} · ${number(pick(p, 'shares'), 0)} sh @ ${money(entry)} · stop ${money(stop)} · target ${money(target)} · entered ${time(pick(p, 'entryAt', 'entry_at'))}</small></div></div>`;
    }).join('');
  }

  function renderTrades(items) {
    const el = $('flpTrades');
    $('flpTradeMeta').textContent = items?.length ? `${items.length} records` : 'No records';
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No trades recorded — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 60).map(t => {
      const dir = String(pick(t, 'direction') || '').toLowerCase();
      const dirClass = dir === 'long' ? 'war-good' : dir === 'short' ? 'war-bad' : '';
      const pnl = pick(t, 'pnl');
      const closed = !!pick(t, 'exitAt', 'exit_at');
      return `<div class="war-row"><div><b>${esc(pick(t, 'symbol') || '—')}</b> <span class="war-tag ${dirClass}">${esc(dir ? dir.toUpperCase() : '')}</span> <span class="war-tag">${esc(closed ? 'closed' : 'open')}</span>
        <small>Wall ${esc(wallLabel(pick(t, 'wallType', 'wall_type')))} @ ${money(pick(t, 'wallPrice', 'wall_price'))} · entry ${money(pick(t, 'entryPrice', 'entry_price'))} → exit ${money(pick(t, 'exitPrice', 'exit_price'))} · ${number(pick(t, 'shares'), 0)} sh</small>
        <small>C1 ${money(pick(t, 'c1High', 'c1_high'))}/${money(pick(t, 'c1Low', 'c1_low'))} · C2 ${money(pick(t, 'c2High', 'c2_high'))}/${money(pick(t, 'c2Low', 'c2_low'))} · stop ${money(pick(t, 'stopPrice', 'stop_price'))} · target ${money(pick(t, 'targetPrice', 'target_price'))} · MFE ${money(pick(t, 'mfe'))} / MAE ${money(pick(t, 'mae'))}</small>
        <small>Entry: ${esc(pick(t, 'entryReason', 'entry_reason') || '—')} · Exit: ${esc(pick(t, 'exitReason', 'exit_reason') || '—')} · ${day(pick(t, 'entryAt', 'entry_at'))} ${time(pick(t, 'entryAt', 'entry_at'))}</small></div>
        <strong class="${isNumber(pnl) ? (pnl >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(pnl) ? money(pnl) : '—'}</strong></div>`;
    }).join('');
  }

  function renderAlerts(items) {
    const el = $('flpAlerts');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No alerts — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 30).map(a => `<div class="war-row"><div><b>${esc(pick(a, 'kind'))}</b><small>${esc(pick(a, 'message'))}</small></div><strong>${time(pick(a, 'createdAt', 'created_at'))}</strong></div>`).join('');
  }

  function renderSettings() {
    const el = $('flpSettings');
    const rules = settingsView?.rules;
    if (!rules) { el.innerHTML = '<p class="war-empty">Settings unavailable.</p>'; return; }
    const field = (key, label, type, stepOrOptions) => {
      const value = rules[key];
      const id = `flpRule_${key}`;
      if (type === 'checkbox') return `<label class="war-field war-check" for="${id}"><input id="${id}" type="checkbox" data-rule="${key}" ${value ? 'checked' : ''}><span>${esc(label)}</span></label>`;
      if (type === 'select') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><select id="${id}" data-rule="${key}">${stepOrOptions.map(o => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      if (type === 'text') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="text" maxlength="5" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
      return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="number" step="${stepOrOptions}" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
    };
    el.innerHTML = `
      <fieldset class="war-fieldset"><legend>Master switch</legend>
      <label class="war-field war-check" for="flpEnabled"><input id="flpEnabled" type="checkbox" data-enabled ${settingsView?.enabled ? 'checked' : ''}><span>Trading enabled</span></label>
      </fieldset>` +
      RULE_SCHEMA.map(group => `
      <fieldset class="war-fieldset"><legend>${esc(group.group)}</legend>
      ${group.fields.map(([key, label, type, extra]) => field(key, label, type, extra)).join('')}
      </fieldset>`).join('') +
      `<p class="war-note">Live orders require <b>all three</b>: Mode = LIVE <b>and</b> both live switches checked. Anything less is refused loudly by the server. Paper is the only working mode right now.${settingsView?.liveNote ? ` ${esc(settingsView.liveNote)}` : ''}</p>`;
  }

  function renderBacktests(items) {
    const el = $('flpBacktests');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No backtests yet.</p>'; return; }
    el.innerHTML = items.map(b => {
      const id = pick(b, 'backtestId', 'backtest_id');
      const params = b.params || {};
      const syms = (params.symbols || []).join(', ');
      const range = params.from && params.to ? `${params.from} → ${params.to}` : (params.days ? `${params.days}d` : '');
      return `<div class="war-row"><div><b>${esc(String(id || '').slice(0, 8))}…</b>
        <small>${esc(syms)} · ${esc(range)} · ${day(pick(b, 'createdAt', 'created_at'))}</small></div>
        <button class="war-button war-quiet" data-bt="${esc(id)}">View</button></div>`;
    }).join('');
    el.querySelectorAll('[data-bt]').forEach(btn => btn.onclick = () => viewBacktest(btn.dataset.bt));
  }

  function renderBacktestDetail(detail) {
    const el = $('flpBacktestDetail');
    if (!detail) { el.innerHTML = ''; return; }
    const r = detail.report || {};
    const cell = v => (v == null ? '—' : isNumber(v) ? String(number(Number(v))) : esc(v));
    const stat = (label, value) => `<div><span>${esc(label)}</span><strong>${cell(value)}</strong></div>`;
    el.innerHTML = `<div class="war-bt-detail"><h3>Backtest ${esc(String(pick(detail, 'backtestId', 'backtest_id') || '').slice(0, 8))}…</h3>
      <div class="war-perf-grid">
        ${stat('Total trades', pick(r, 'totalTrades', 'total_trades'))}
        ${stat('Winning trades', pick(r, 'winningTrades', 'winning_trades'))}
        ${stat('Losing trades', pick(r, 'losingTrades', 'losing_trades'))}
        ${stat('Win rate', pick(r, 'winRate', 'win_rate'))}
        ${stat('Average winner', pick(r, 'avgWinner', 'avg_winner'))}
        ${stat('Average loser', pick(r, 'avgLoser', 'avg_loser'))}
        ${stat('Profit factor', pick(r, 'profitFactor', 'profit_factor'))}
        ${stat('Max drawdown', pick(r, 'maxDrawdown', 'max_drawdown'))}
        ${stat('Average trade', pick(r, 'avgTrade', 'avg_trade'))}
        ${stat('Largest loss', pick(r, 'largestLoss', 'largest_loss'))}
        ${stat('Largest win', pick(r, 'largestWin', 'largest_win'))}
        ${stat('Total return', pick(r, 'totalReturn', 'total_return'))}
        ${stat('Consecutive losses', pick(r, 'consecutiveLosses', 'consecutive_losses', 'maxConsecutiveLosses'))}
        ${stat('Consecutive wins', pick(r, 'consecutiveWins', 'consecutive_wins', 'maxConsecutiveWins'))}
      </div>
      <h4>Trades (${(detail.trades || []).length})</h4><div class="war-list">
      ${(detail.trades || []).slice(0, 50).map(t => {
        const pnl = pick(t, 'pnl');
        return `<div class="war-row"><div><b>${esc(pick(t, 'symbol', 'ticker') || '—')}</b> <span class="war-tag">${esc(String(pick(t, 'direction') || '').toUpperCase())}</span> <span class="war-tag">${esc(wallLabel(pick(t, 'wallType', 'wall_type')))}</span><small>${esc(pick(t, 'date') || '')} · ${esc(pick(t, 'exitReason', 'exit_reason') || '—')}</small></div><strong class="${isNumber(pnl) ? (pnl >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(pnl) ? money(pnl) : '—'}</strong></div>`;
      }).join('') || '<p class="war-empty">No data yet.</p>'}
      </div></div>`;
  }

  async function toggleEnabled() {
    if (changing || !status?.connected) { if (!status?.connected) connectionModal(); return; }
    changing = true; revision++;
    try {
      await api('/api/flipper/settings', { method: 'PUT', body: JSON.stringify({ enabled: !status.enabled }) });
      settingsView = await api('/api/flipper/settings');
      status = await api('/api/flipper/status');
      renderStatus(); renderSettings();
      notice(status.enabled ? 'Flipper trading resumed — the 9:30–10:30 ET window is watched when the market opens.' : 'Flipper trading paused. Existing positions remain under automatic management.');
    } catch (error) { notice(`Toggle failed: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  async function saveSettings() {
    if (changing) return;
    const rules = {};
    document.querySelectorAll('#flpSettings [data-rule]').forEach(input => {
      const key = input.dataset.rule;
      if (input.type === 'checkbox') rules[key] = input.checked;
      else if (input.tagName === 'SELECT') rules[key] = input.value;
      else if (input.type === 'text') { if (input.value.trim() !== '') rules[key] = input.value.trim(); }
      else if (input.value !== '') rules[key] = Number(input.value);
    });
    const enabledInput = document.querySelector('#flpSettings [data-enabled]');
    changing = true; revision++;
    try {
      await api('/api/flipper/settings', { method: 'PUT', body: JSON.stringify({ rules, ...(enabledInput ? { enabled: enabledInput.checked } : {}) }) });
      settingsView = await api('/api/flipper/settings');
      status = await api('/api/flipper/status');
      renderStatus(); renderSettings();
      notice('Settings saved.');
    } catch (error) { notice(`Settings not saved: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  async function runBacktest(event) {
    event.preventDefault();
    if (changing) return;
    changing = true; revision++;
    try {
      const symbols = $('flpBtSymbols').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
      const from = $('flpBtFrom').value, to = $('flpBtTo').value;
      if (!symbols.length) throw new Error('Enter at least one symbol.');
      if (!from || !to || from > to) throw new Error('Pick a valid date range (from ≤ to).');
      notice('Running backtest — this can take a minute on long histories…');
      const result = await api('/api/flipper/backtest', { method: 'POST', body: JSON.stringify({ symbols, from, to, params: {} }) });
      const trades = pick(result.report || {}, 'totalTrades', 'total_trades');
      notice(`Backtest complete: ${trades ?? '—'} trades.`);
      await viewBacktest(pick(result, 'backtestId', 'backtest_id'));
      const list = await api('/api/flipper/backtests');
      renderBacktests(list.backtests || list);
    } catch (error) { notice(`Backtest failed: ${error.message}`, true); }
    finally { changing = false; }
  }
  async function viewBacktest(id) {
    try { activeBacktest = await api(`/api/flipper/backtests/${encodeURIComponent(id)}`); renderBacktestDetail(activeBacktest); }
    catch (error) { notice(`Backtest unavailable: ${error.message}`, true); }
  }
  function connectionModal() {
    if (changing) return;
    const old = $('flpModal'); if (old) old.remove();
    const previousFocus = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="war-modal" id="flpModal" role="dialog" aria-modal="true" aria-labelledby="flpModalTitle"><form class="war-modal-card" id="flpForm"><button type="button" class="war-close" id="flpClose" aria-label="Close">×</button><div class="war-modal-scroll"><span class="war-eyebrow">FLIPPER DEDICATED CONNECTION</span><h2 id="flpModalTitle">Connect Alpaca Paper</h2><p>Use a dedicated paper account, separate from other bots and manual trading. Keys are stored encrypted and are never displayed back. Paper only — a live connect is refused loudly by the server.</p><label>API key<input id="flpKey" required autocomplete="off"></label><label>API secret<input id="flpSecret" type="password" required autocomplete="off"></label><label>Mode<select id="flpMode"><option value="paper" selected>paper</option><option value="live">live</option></select></label><p id="flpFormError" class="war-form-error" role="alert"></p></div><div class="war-modal-actions"><button type="submit" class="war-button" id="flpSubmit">Connect</button><button type="button" class="war-button war-quiet" id="flpDisconnect">Disconnect</button></div></form></div>`);
    const close = () => { if (changing) return; $('flpModal')?.remove(); previousFocus?.focus(); };
    $('flpClose').onclick = close;
    $('flpModal').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    $('flpForm').onsubmit = async event => {
      event.preventDefault();
      if (changing) return;
      changing = true; revision++;
      $('flpModal').querySelectorAll('button,input,select').forEach(control => { control.disabled = true; });
      try {
        status = await api('/api/flipper/connect', { method: 'POST', body: JSON.stringify({ key: $('flpKey').value, secret: $('flpSecret').value, mode: $('flpMode').value }) });
        settingsView = await api('/api/flipper/settings');
        close(); renderStatus(); renderSettings();
        notice('Paper connected. Trading is still disabled — resume it when ready.');
        refresh();
      } catch (error) { $('flpFormError').textContent = `Connection blocked: ${error.message}`; }
      finally { changing = false; $('flpModal')?.querySelectorAll('button,input,select').forEach(control => { control.disabled = false; }); renderStatus(); }
    };
    $('flpDisconnect').onclick = async () => {
      if (!window.confirm('Disconnect the Flipper paper account? Blocked while positions remain open.')) return;
      if (changing) return;
      changing = true; revision++;
      try { status = await api('/api/flipper/disconnect', { method: 'POST' }); close(); renderStatus(); notice('Flipper disconnected.'); refresh(); }
      catch (error) { $('flpFormError').textContent = `Disconnect blocked: ${error.message}`; }
      finally { changing = false; renderStatus(); }
    };
    $('flpClose').focus();
  }

  async function refresh() {
    if (!mounted || refreshing || changing) return;
    refreshing = true;
    const startedRevision = revision;
    const results = await Promise.allSettled([
      api('/api/flipper/status'), api('/api/flipper/dashboard'),
      api('/api/flipper/backtests'), api('/api/flipper/alerts'),
    ]);
    refreshing = false;
    if (!mounted || startedRevision !== revision) return;
    const get = i => results[i].status === 'fulfilled' ? results[i].value : null;
    const fail = i => results[i].status === 'rejected' ? results[i].reason.message : null;
    if (get(0)) { status = get(0); }
    const dash = get(1);
    renderStatus(dash?.tradeDate || dash?.trade_date);
    if (!get(0)) notice(`Status unavailable: ${esc(fail(0))}`, true);
    if (dash) {
      renderSetups(dash);
      renderPositions(dash.positions);
      renderTrades(dash.todaysTrades || dash.todays_trades || dash.trades);
    } else {
      $('flpSetups').innerHTML = `<p class="war-empty war-unavailable">Dashboard unavailable: ${esc(fail(1))}</p>`;
      $('flpPositions').innerHTML = `<p class="war-empty war-unavailable">Positions unavailable: ${esc(fail(1))}</p>`;
      $('flpTrades').innerHTML = `<p class="war-empty war-unavailable">Trades unavailable: ${esc(fail(1))}</p>`;
    }
    if (get(2)) renderBacktests(get(2).backtests || get(2));
    if (get(3)) renderAlerts(get(3).alerts || get(3)); else $('flpAlerts').innerHTML = `<p class="war-empty war-unavailable">Alerts unavailable: ${esc(fail(3))}</p>`;
    if (!settingsView) { try { settingsView = await api('/api/flipper/settings'); renderSettings(); } catch (_) { /* settings panel keeps its empty state */ } }
  }

  async function open() {
    shell(); mounted = true;
    $('flpPaperConnect').onclick = connectionModal;
    $('flpEnabledToggle').onclick = toggleEnabled;
    $('flpSave').onclick = saveSettings;
    $('flpBtForm').onsubmit = runBacktest;
    try { settingsView = await api('/api/flipper/settings'); renderSettings(); } catch (_) {}
    await refresh(); if (!mounted) return; clearInterval(polling); polling = setInterval(refresh, 60000);
  }
  function pause() { mounted = false; clearInterval(polling); polling = null; }
  window.flipperBot = { open, pause };
}());
