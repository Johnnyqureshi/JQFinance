/* Warrior Bot — manual-approval intraday trading controls.
 * The scanner only ever creates PROPOSALS. Nothing reaches the broker until
 * you press Approve on a specific proposal; from the fill onward management
 * is automatic (breakeven, partials, trailing, exits, EOD flatten).
 * PAPER is the only working mode. All panels render real API data; empty
 * states say "no data yet".
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
  let mounted = false, polling = null, status = null, refreshing = false, changing = false, revision = 0;
  let settingsView = null, activeBacktest = null;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response. Refresh to verify the current state.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (!data || typeof data !== 'object') throw new Error('Server response is incomplete.');
    return data;
  }
  function notice(message, error) { const el = $('warNotice'); if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); } }

  const RULE_SCHEMA = [
    { group: 'Setup scoring', fields: [
      ['minScoreBull', 'Min score — bull regime', 'number', 1], ['minScoreNeutral', 'Min score — neutral regime', 'number', 1],
      ['minScoreBear', 'Min score — bear regime', 'number', 1], ['highQuality', 'High-quality score (alerts)', 'number', 1],
      ['minRR', 'Minimum R:R', 'number', 0.1], ['strongRvol', 'Strong RVOL (x)', 'number', 0.1],
      ['veryStrongRvol', 'Very strong RVOL (x)', 'number', 0.1],
      ['earlyBreakWindowMinutes', 'Early-break window after open (min)', 'number', 5],
      ['secondLegMaxChasePct', 'Second-leg chase ceiling (%)', 'number', 5],
      ['premarketBreakMaxChasePct', 'Premarket-break chase ceiling (%)', 'number', 5] ] },
    { group: 'Position sizing', fields: [
      ['riskPerTradePct', 'Risk per trade (%)', 'number', 0.1], ['maxRiskPerTradePct', 'Max risk per trade (%)', 'number', 0.1],
      ['autoApprove', 'Auto-approve proposals (skip manual size approval)', 'checkbox'],
      ['autoApproveDollars', 'Auto-approve size ($ per trade)', 'number', 50] ] },
    { group: 'Daily guards', fields: [
      ['maxDailyLossPct', 'Max daily loss (%)', 'number', 0.1], ['maxConsecutiveLosses', 'Max consecutive losses', 'number', 1],
      ['maxPositions', 'Max open positions', 'number', 1], ['maxTradesPerDay', 'Max trades per day', 'number', 1],
      ['cooldownMinutesAfterLoss', 'Cooldown after loss (min)', 'number', 1] ] },
    { group: 'Position management', fields: [
      ['breakevenAction', 'Breakeven action', 'select', ['breakeven', 'ema9', 'none']],
      ['trailingMethod', 'Trailing stop', 'select', ['ema9', 'atr', 'swing', 'vwap', 'fixedPct']],
      ['partialAtR', 'Partial at R', 'number', 0.5], ['partialPct', 'Partial size (fraction)', 'number', 0.1],
      ['holdRunners', 'Hold runners until volume fades (no fixed target after partial)', 'checkbox'],
      ['fadeVolumeFraction', 'Fade: recent volume below × baseline', 'number', 0.05],
      ['fadeStallBars', 'Fade: recent bars counted', 'number', 1], ['fadeBaselineBars', 'Fade: baseline bars', 'number', 1],
      ['maxHoldCandles', 'Max hold (1m candles)', 'number', 1], ['eodFlatten', 'Flatten at 15:55 ET', 'checkbox'],
      ['takeProfitRsi', 'Take profit at RSI (0 = off)', 'number', 1] ] },
    { group: 'Sessions', fields: [
      ['premarketEnabled', 'Premarket scanning 04:00–09:30 ET', 'checkbox'],
      ['premarketScanOnly', 'Premarket scan-only (no entries before 09:30 ET)', 'checkbox'],
      ['afterHoursEnabled', 'After-hours 16:00–20:00 ET', 'checkbox'] ] },
    { group: 'Universe filters', fields: [
      ['minPrice', 'Min price ($)', 'number', 0.1], ['maxPrice', 'Max price ($)', 'number', 1],
      ['minAvgDailyVolume', 'Min avg daily volume', 'number', 100000], ['minDollarVolume', 'Min avg dollar volume ($)', 'number', 1000000],
      ['minRvol', 'Min relative volume (x)', 'number', 0.1], ['minPctGain', 'Min day gain (%)', 'number', 0.5],
      ['maxSpread', 'Max spread (fraction)', 'number', 0.001], ['minMarketCap', 'Min market cap ($) — inert on paper', 'number', 100000000],
      ['scanBudget', 'Scan budget (symbols/cycle)', 'number', 10] ] },
    { group: 'Trading mode', fields: [
      ['tradingMode', 'Mode', 'select', ['PAPER', 'LIVE']],
      ['liveEnabled', 'Live switch 1 — enabled', 'checkbox'], ['liveConfirmed', 'Live switch 2 — confirmed', 'checkbox'] ] },
  ];

  function shell() {
    const page = $('page-warrior');
    if (!page || $('warRoot')) return;
    page.innerHTML = `<section class="war-shell" id="warRoot" aria-labelledby="warTitle">
      <header class="war-hero"><div><span class="war-eyebrow">MANUAL-APPROVAL INTRADAY</span><h1 id="warTitle">Warrior Bot <em>you approve every trade</em></h1><p>The server scans every minute and proposes setups. Nothing reaches the broker until you press <b>Approve</b> on a specific proposal — then management is automatic: breakeven, partials, trailing, exits, EOD flatten.</p></div><span class="war-auto-label">PAPER ONLY</span></header>
      <div class="war-notice" id="warNotice" role="status" aria-live="polite"></div>
      <section class="war-status" aria-label="Warrior system status">
        <div><span>Connection</span><strong id="warConnection">CHECKING</strong><small id="warAccount">Dedicated account required</small></div>
        <div><span>Today&rsquo;s P&amp;L</span><strong id="warPnl">—</strong><small id="warPnlNote">Closed trades today</small></div>
        <div><span>Open positions</span><strong id="warOpen">—</strong><small id="warRegime">Regime —</small></div>
        <div><span>Scheduler</span><strong id="warScheduler">—</strong><small id="warSchedulerNote">Server-owned cycle</small></div>
      </section>
      <section class="war-command"><div><span class="war-eyebrow">PROPOSAL QUEUE</span><h2 id="warMandate">Connect an account to begin</h2><p id="warMandateCopy">Approve a proposal to send one limit order. Reject to clear it. Proposals expire after 30 minutes.</p><p id="warBlockers" class="war-blockers"></p></div><button class="war-button war-quiet" id="warScannerToggle" disabled>Checking account</button></section>
      <section class="war-layout"><main class="war-main">
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">AWAITING YOUR APPROVAL</span><h2>Proposals</h2></div><span id="warProposalMeta">Loading</span></div><div class="war-list" id="warProposals"><p class="war-empty">Loading proposals…</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">REJECTION FUNNEL</span><h2>Latest scan</h2></div><span id="warScanMeta">Loading</span></div><div class="war-list" id="warScanFunnel"><p class="war-empty">No scan data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">UNDER MANAGEMENT</span><h2>Positions</h2></div><span id="warPositionMeta">Loading</span></div><div class="war-list" id="warPositions"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">TRADE JOURNAL</span><h2>Trades</h2></div><span id="warTradeMeta">Loading</span></div><div class="war-list" id="warTrades"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">VALIDATION</span><h2>Backtests</h2></div></div>
          <form class="war-bt-form" id="warBtForm"><label>Symbols (comma separated)<input id="warBtSymbols" value="SPY" maxlength="120"></label><label>Days (7–365)<input id="warBtDays" type="number" min="7" max="365" value="90"></label><button class="war-button" type="submit" id="warBtRun">Run backtest</button></form>
          <p class="war-note">Backtests use the same detect → score pipeline as live scanning. Live scanning evaluates candles incrementally as they form; the backtest uses the engine&rsquo;s precomputed per-bar path — fills still see only bars up to the current index (no look-ahead on prices).</p>
          <div class="war-list" id="warBacktests"><p class="war-empty">No backtests yet.</p></div>
          <div id="warBacktestDetail"></div>
        </article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">TRACK RECORD</span><h2>Performance</h2></div></div><div class="war-perf" id="warPerf"><p class="war-empty">No data yet.</p></div></article>
      </main>
      <aside class="war-rail">
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">DEDICATED BROKER</span><h2>Alpaca paper</h2></div></div><div class="war-account-row"><div><b>Paper</b><small id="warPaperState">Checking</small></div><button class="war-button war-quiet" id="warPaperConnect">Connect</button></div><p class="war-account-note">Warrior runs on its own dedicated Alpaca paper account — never shared with other bots or manual trading. Live trading is not available: live orders require <b>both</b> live switches and are refused loudly otherwise. Level 2 order flow is unavailable on the Alpaca paper plan — Warrior confirms with price and volume only.</p></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">FULL CONFIG</span><h2>Settings</h2></div></div><div id="warSettings"><p class="war-empty">Loading settings…</p></div><button class="war-button war-save" id="warSave">Save settings</button></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">RISK DESK</span><h2>Alerts</h2></div></div><div class="war-list" id="warAlerts"><p class="war-empty">No data yet.</p></div></article>
      </aside></section>
    </section>`;
  }

  function renderStatus() {
    if (!status) return;
    const connected = !!status.connected, scheduler = status.scheduler || {};
    $('warConnection').textContent = connected ? 'PAPER CONNECTED' : 'DISCONNECTED';
    $('warConnection').className = connected ? 'war-good' : 'war-bad';
    $('warAccount').textContent = status.accountId ? `Account ${status.accountId}` : (status.blockers || []).join(' · ') || 'Dedicated Warrior account required';
    const pnl = status.todayPnl;
    $('warPnl').textContent = isNumber(pnl) ? money(pnl) : '—';
    $('warPnl').className = isNumber(pnl) ? (pnl >= 0 ? 'war-good' : 'war-bad') : '';
    $('warPnlNote').textContent = `Win rate ${status.winRate == null ? '—' : pct(status.winRate * 100)} · ${status.tradeCount || 0} trades`;
    $('warOpen').textContent = String(status.openPositions ?? '—');
    $('warRegime').textContent = `Regime ${status.regime || '—'}`;
    $('warScheduler').textContent = String(scheduler.status || 'IDLE').toUpperCase();
    $('warSchedulerNote').textContent = scheduler.reason || (scheduler.lastCycleAt ? `Last cycle ${time(scheduler.lastCycleAt)}` : 'No completed cycle yet');
    $('warMandate').textContent = !connected ? 'Connect an account to begin' : !status.enabled ? 'Scanner is paused' : status.ready ? 'Scanning — approve a proposal to trade' : 'Warrior is standing aside';
    $('warMandateCopy').textContent = !connected ? 'Connect a dedicated Alpaca paper account. The scanner starts proposing setups immediately; nothing trades without your approval.' : status.ready ? 'The server scans every minute. Approve a proposal to send one limit order; management from the fill onward is automatic.' : 'Existing positions remain under automatic management. New proposals stay withheld until the server reports ready.';
    $('warBlockers').textContent = (status.blockers || []).join(' · ');
    const toggle = $('warScannerToggle');
    toggle.disabled = !connected || changing;
    toggle.textContent = !connected ? 'Connect Alpaca' : status.enabled ? 'Pause scanner' : 'Resume scanner';
    $('warPaperState').textContent = connected ? 'Connected' : 'Not connected';
    $('warPaperConnect').textContent = connected ? 'Manage' : 'Connect';
  }

  function renderProposals(items) {
    const el = $('warProposals');
    $('warProposalMeta').textContent = items?.length ? `${items.length} awaiting approval` : 'Queue empty';
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No proposals — no data yet. The scanner proposes setups during market hours.</p>'; return; }
    el.innerHTML = items.map(p => `
      <div class="war-row war-proposal" data-id="${esc(p.proposal_id)}">
        <div><b>${esc(p.symbol)}</b> <span class="war-tag">${esc(p.pattern_name)}</span> <span class="war-tag war-score">score ${esc(p.score)}</span>
        <small>Entry ${money(p.entry)} · Stop ${money(p.stop)} · Target ${money(p.target)} · R:R ${number(p.rr)} · ${esc(p.shares_recommended)} sh · expires ${time(p.expires_at)}</small>
        <small class="war-reason">${esc((p.reasons || []).join(' · '))}</small></div>
        <div class="war-actions"><input class="war-reject-reason" placeholder="Reject reason (optional)" maxlength="200" aria-label="Reject reason"><button class="war-button war-approve" data-act="approve">Approve</button><button class="war-button war-quiet" data-act="reject">Reject</button></div>
      </div>`).join('');
    el.querySelectorAll('.war-proposal').forEach(row => {
      const id = row.dataset.id;
      row.querySelector('[data-act="approve"]').onclick = () => approve(id);
      row.querySelector('[data-act="reject"]').onclick = () => reject(id, row.querySelector('.war-reject-reason').value);
    });
  }

  function renderScan(data) {
    const run = data?.run;
    $('warScanMeta').textContent = run ? `${run.symbols_scanned || 0} scanned · ${run.proposals_created || 0} proposals · ${time(run.started_at)}` : 'No scan data yet';
    const el = $('warScanFunnel');
    if (!run) { el.innerHTML = '<p class="war-empty">No scan data yet.</p>'; return; }
    const stages = [
      ['Symbols scanned', run.symbols_scanned],
      ['Passed universe filters', run.universe_pass],
      ['Passed momentum filters', run.momentum_pass],
      ['Passed pattern + scoring', run.pattern_pass],
      ['Proposals created', run.proposals_created],
    ];
    el.innerHTML = stages.map(([label, n]) =>
      `<div class="war-row"><div>${esc(label)}</div><strong>${number(n || 0, 0)}</strong></div>`).join('')
      + (run.errors ? `<div class="war-row"><div>Scan errors</div><strong class="war-bad">${number(run.errors, 0)}</strong></div>` : '');
  }

  function renderPositions(items) {
    const el = $('warPositions');
    $('warPositionMeta').textContent = items?.length ? `${items.length} open` : 'Flat';
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No open positions — no data yet.</p>'; return; }
    el.innerHTML = items.map(p => {
      const risk = (p.entry_price || 0) - (p.stop_price || 0);
      const riskDollars = risk > 0 && p.qty ? risk * p.qty : null;
      return `<div class="war-row"><div><b>${esc(p.symbol)}</b> <span class="war-tag">${esc(p.pattern_name || '')}</span> <span class="war-tag">${esc(p.status)}</span>
        <small>${number(p.qty, 0)} sh @ ${money(p.entry_price)} · stop ${money(p.stop_price)} · target ${money(p.target_price)}${p.partial_taken ? ' · partial taken' : ''}${p.breakeven_set ? ' · breakeven' : ''}</small></div>
        <strong>${isNumber(riskDollars) ? money(riskDollars) + ' risk' : '—'}</strong></div>`;
    }).join('');
  }

  function renderTrades(items) {
    const el = $('warTrades');
    $('warTradeMeta').textContent = items?.length ? `${items.length} records` : 'No records';
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No trades recorded — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 60).map(t => `
      <div class="war-row"><div><b>${esc(t.ticker || t.symbol || '—')}</b> <span class="war-tag">${esc(t.pattern || t.pattern_name || '')}</span> <span class="war-tag">${esc(t.status || (t.exitedAt ? 'closed' : 'open'))}</span>
      <small>${t.enteredAt ? new Date(t.enteredAt).toLocaleDateString() : ''} · ${number(t.shares, 0)} sh @ ${money(t.entryPrice ?? t.entry_price)} → ${money(t.exitPrice)} · exit ${esc(t.exitReason || '—')}${isNumber(t.rMultiple) ? ` · ${number(t.rMultiple)}R` : ''}</small></div>
      <strong class="${isNumber(t.pnl) ? (t.pnl >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(t.pnl) ? money(t.pnl) : '—'}</strong></div>`).join('');
  }


  function renderAlerts(items) {
    const el = $('warAlerts');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No alerts — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 30).map(a => `<div class="war-row"><div><b>${esc(a.kind)}</b><small>${esc(a.message)}</small></div><strong>${time(a.createdAt)}</strong></div>`).join('');
  }

  function renderPerf(trades) {
    const el = $('warPerf');
    const closed = (trades || []).filter(t => t.exitedAt && isNumber(t.pnl));
    if (!closed.length) { el.innerHTML = '<p class="war-empty">No closed trades — no data yet.</p>'; return; }
    const wins = closed.filter(t => t.pnl > 0), losses = closed.filter(t => t.pnl <= 0);
    const totalPnl = closed.reduce((s, t) => s + Number(t.pnl), 0);
    const rVals = closed.map(t => Number(t.rMultiple)).filter(Number.isFinite);
    el.innerHTML = `<div class="war-perf-grid">
      <div><span>Closed trades</span><strong>${closed.length}</strong></div>
      <div><span>Win rate</span><strong>${pct(wins.length / closed.length * 100)}</strong></div>
      <div><span>Total P&amp;L</span><strong class="${totalPnl >= 0 ? 'war-good' : 'war-bad'}">${money(totalPnl)}</strong></div>
      <div><span>Avg R</span><strong>${rVals.length ? number(rVals.reduce((a, b) => a + b, 0) / rVals.length) + 'R' : '—'}</strong></div>
      <div><span>Winners</span><strong class="war-good">${wins.length}</strong></div>
      <div><span>Losers</span><strong class="war-bad">${losses.length}</strong></div>
    </div>`;
  }

  function renderSettings() {
    const el = $('warSettings');
    const rules = settingsView?.rules;
    if (!rules) { el.innerHTML = '<p class="war-empty">Settings unavailable.</p>'; return; }
    const field = (key, label, type, stepOrOptions) => {
      const value = rules[key];
      const id = `warRule_${key}`;
      if (type === 'checkbox') return `<label class="war-field war-check" for="${id}"><input id="${id}" type="checkbox" data-rule="${key}" ${value ? 'checked' : ''}><span>${esc(label)}</span></label>`;
      if (type === 'select') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><select id="${id}" data-rule="${key}">${stepOrOptions.map(o => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="number" step="${stepOrOptions}" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
    };
    el.innerHTML = RULE_SCHEMA.map(group => `
      <fieldset class="war-fieldset"><legend>${esc(group.group)}</legend>
      ${group.fields.map(([key, label, type, extra]) => field(key, label, type, extra)).join('')}
      </fieldset>`).join('') + `
      <fieldset class="war-fieldset"><legend>Pattern allow-list</legend>
      ${Object.entries(rules.allowedPatterns || {}).map(([name, on]) => `<label class="war-field war-check" for="warPat_${esc(name)}"><input id="warPat_${esc(name)}" type="checkbox" data-pattern="${esc(name)}" ${on ? 'checked' : ''}><span>${esc(name)}</span></label>`).join('')}
      </fieldset>
      <p class="war-note">Level 2 order flow is unavailable on the Alpaca paper plan — Warrior confirms with price and volume only. Market-cap filtering is inert for the same reason. Live orders require <b>both</b> live switches; anything less is refused loudly.</p>`;
  }

  function renderBacktests(items) {
    const el = $('warBacktests');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No backtests yet.</p>'; return; }
    el.innerHTML = items.map(b => `<div class="war-row"><div><b>${esc(b.backtestId.slice(0, 8))}…</b>
      <small>${esc((b.params.symbols || []).join(', '))} · ${esc(b.params.days)}d · ${time(b.createdAt)}</small></div>
      <button class="war-button war-quiet" data-bt="${esc(b.backtestId)}">View</button></div>`).join('');
    el.querySelectorAll('[data-bt]').forEach(btn => btn.onclick = () => viewBacktest(btn.dataset.bt));
  }

  function renderBacktestDetail(detail) {
    const el = $('warBacktestDetail');
    if (!detail) { el.innerHTML = ''; return; }
    const r = detail.report || {};
    const pct4 = v => isNumber(v) ? `${number(v * 100)}%` : '—';
    el.innerHTML = `<div class="war-bt-detail"><h3>Backtest ${esc(detail.backtestId.slice(0, 8))}…</h3>
      <div class="war-perf-grid">
        <div><span>Trades</span><strong>${r.totalTrades ?? '—'}</strong></div>
        <div><span>Win rate</span><strong>${pct4(r.winRate)}</strong></div>
        <div><span>Profit factor</span><strong>${isNumber(r.profitFactor) ? number(r.profitFactor) : '—'}</strong></div>
        <div><span>Expectancy</span><strong>${money(r.expectancy)}</strong></div>
        <div><span>Total return</span><strong>${pct4(r.totalReturn)}</strong></div>
        <div><span>Max drawdown</span><strong>${pct4(r.maxDrawdown)}</strong></div>
        <div><span>Sharpe</span><strong>${isNumber(r.sharpe) ? number(r.sharpe) : '—'}</strong></div>
        <div><span>Avg R</span><strong>${isNumber(r.avgR) ? number(r.avgR) + 'R' : '—'}</strong></div>
      </div>
      <h4>By pattern</h4><div class="war-table-wrap"><table class="war-table"><thead><tr><th>Pattern</th><th>Trades</th><th>Win rate</th><th>P&amp;L</th></tr></thead><tbody>
      ${Object.entries(r.byPattern || {}).map(([k, b]) => `<tr><td>${esc(k)}</td><td>${b.trades}</td><td>${pct4(b.winRate)}</td><td>${money(b.pnl)}</td></tr>`).join('') || '<tr><td colspan="4" class="war-empty">No data yet.</td></tr>'}
      </tbody></table></div>
      <h4>Trades (${(detail.trades || []).length})</h4><div class="war-list">
      ${(detail.trades || []).slice(0, 50).map(t => `<div class="war-row"><div><b>${esc(t.ticker || t.symbol || '—')}</b> <span class="war-tag">${esc(t.pattern || '')}</span><small>${esc(t.date || '')} · ${esc(t.exitReason || '—')}${isNumber(t.rMultiple) ? ` · ${number(t.rMultiple)}R` : ''}</small></div><strong class="${isNumber(t.pnl) ? (t.pnl >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(t.pnl) ? money(t.pnl) : '—'}</strong></div>`).join('') || '<p class="war-empty">No data yet.</p>'}
      </div></div>`;
  }

  async function approve(id) {
    if (changing) return;
    changing = true; revision++;
    try {
      const result = await api(`/api/warrior/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST' });
      notice(result.reconciled ? 'Proposal already approved — reconciled with the broker. No duplicate order sent.'
        : result.adopted ? 'Broker already held this position — adopted. No duplicate order sent.'
        : 'Entry order submitted. Management from the fill onward is automatic.');
      await refresh();
    } catch (error) { notice(`Approval blocked: ${error.message}`, true); }
    finally { changing = false; }
  }
  async function reject(id, reason) {
    if (changing) return;
    changing = true; revision++;
    try {
      await api(`/api/warrior/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) });
      notice('Proposal rejected.');
      await refresh();
    } catch (error) { notice(`Reject failed: ${error.message}`, true); }
    finally { changing = false; }
  }
  async function toggleScanner() {
    if (changing || !status?.connected) { if (!status?.connected) connectionModal(); return; }
    changing = true; revision++;
    try {
      status = await api('/api/warrior/settings', { method: 'PUT', body: JSON.stringify({ enabled: !status.enabled }) });
      settingsView = await api('/api/warrior/settings');
      renderStatus(); renderSettings();
      notice(status.enabled ? 'Scanner resumed — proposals will appear during market hours.' : 'Scanner paused. Existing positions remain under automatic management.');
    } catch (error) { notice(`Scanner toggle failed: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  async function saveSettings() {
    if (changing) return;
    const rules = {};
    document.querySelectorAll('#warSettings [data-rule]').forEach(input => {
      const key = input.dataset.rule;
      if (input.type === 'checkbox') rules[key] = input.checked;
      else if (input.tagName === 'SELECT') rules[key] = input.value;
      else if (input.value !== '') rules[key] = Number(input.value);
    });
    const allowedPatterns = {};
    document.querySelectorAll('#warSettings [data-pattern]').forEach(input => { allowedPatterns[input.dataset.pattern] = input.checked; });
    changing = true; revision++;
    try {
      status = await api('/api/warrior/settings', { method: 'PUT', body: JSON.stringify({ rules, allowedPatterns }) });
      settingsView = await api('/api/warrior/settings');
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
      const symbols = $('warBtSymbols').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
      const days = Math.min(Math.max(Number($('warBtDays').value) || 90, 7), 365);
      notice('Running backtest — this can take a minute on long histories…');
      const result = await api('/api/warrior/backtest', { method: 'POST', body: JSON.stringify({ symbols, days }) });
      notice(`Backtest complete: ${result.report.totalTrades} trades, win rate ${isNumber(result.report.winRate) ? pct(result.report.winRate * 100) : '—'}.`);
      await viewBacktest(result.backtestId);
      const list = await api('/api/warrior/backtests');
      renderBacktests(list.backtests);
    } catch (error) { notice(`Backtest failed: ${error.message}`, true); }
    finally { changing = false; }
  }
  async function viewBacktest(id) {
    try { activeBacktest = await api(`/api/warrior/backtests/${encodeURIComponent(id)}`); renderBacktestDetail(activeBacktest); }
    catch (error) { notice(`Backtest unavailable: ${error.message}`, true); }
  }
  function connectionModal() {
    if (changing) return;
    const old = $('warModal'); if (old) old.remove();
    const previousFocus = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="war-modal" id="warModal" role="dialog" aria-modal="true" aria-labelledby="warModalTitle"><form class="war-modal-card" id="warForm"><button type="button" class="war-close" id="warClose" aria-label="Close">×</button><div class="war-modal-scroll"><span class="war-eyebrow">WARRIOR DEDICATED CONNECTION</span><h2 id="warModalTitle">Connect Alpaca Paper</h2><p>Use a dedicated paper account, separate from other bots and manual trading. Warrior only creates <b>proposals</b> — every trade needs your approval. Paper only; live trading is not available.</p><label>API key<input id="warKey" required autocomplete="off"></label><label>API secret<input id="warSecret" type="password" required autocomplete="off"></label><p id="warFormError" class="war-form-error" role="alert"></p></div><div class="war-modal-actions"><button type="submit" class="war-button" id="warSubmit">Connect Paper</button><button type="button" class="war-button war-quiet" id="warDisconnect">Disconnect</button></div></form></div>`);
    const close = () => { if (changing) return; $('warModal')?.remove(); previousFocus?.focus(); };
    $('warClose').onclick = close;
    $('warModal').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    $('warForm').onsubmit = async event => {
      event.preventDefault();
      if (changing) return;
      changing = true; revision++;
      $('warModal').querySelectorAll('button,input').forEach(control => { control.disabled = true; });
      try {
        status = await api('/api/warrior/connect', { method: 'POST', body: JSON.stringify({ key: $('warKey').value, secret: $('warSecret').value }) });
        settingsView = await api('/api/warrior/settings');
        close(); renderStatus(); renderSettings();
        notice('Paper connected — the scanner is proposing setups. Approve a proposal to trade.');
        refresh();
      } catch (error) { $('warFormError').textContent = `Connection blocked: ${error.message}`; }
      finally { changing = false; $('warModal')?.querySelectorAll('button,input').forEach(control => { control.disabled = false; }); renderStatus(); }
    };
    $('warDisconnect').onclick = async () => {
      if (!window.confirm('Disconnect the Warrior paper account? Blocked while positions remain open.')) return;
      if (changing) return;
      changing = true; revision++;
      try { status = await api('/api/warrior/disconnect', { method: 'POST' }); close(); renderStatus(); notice('Warrior disconnected.'); refresh(); }
      catch (error) { $('warFormError').textContent = `Disconnect blocked: ${error.message}`; }
      finally { changing = false; renderStatus(); }
    };
    $('warClose').focus();
  }

  async function refresh() {
    if (!mounted || refreshing || changing) return;
    refreshing = true;
    const startedRevision = revision;
    const results = await Promise.allSettled([
      api('/api/warrior/status'), api('/api/warrior/proposals?status=pending'),
      api('/api/warrior/scan'), api('/api/warrior/positions'), api('/api/warrior/trades'),
      api('/api/warrior/backtests'), api('/api/warrior/alerts'),
    ]);
    refreshing = false;
    if (!mounted || startedRevision !== revision) return;
    const get = i => results[i].status === 'fulfilled' ? results[i].value : null;
    const fail = i => results[i].status === 'rejected' ? results[i].reason.message : null;
    if (get(0)) { status = get(0); renderStatus(); } else notice(`Status unavailable: ${fail(0)}`, true);
    if (get(1)) renderProposals(get(1).proposals); else $('warProposals').innerHTML = `<p class="war-empty war-unavailable">Proposals unavailable: ${esc(fail(1))}</p>`;
    if (get(2)) renderScan(get(2)); else $('warScanFunnel').innerHTML = `<p class="war-empty war-unavailable">Scan unavailable: ${esc(fail(2))}</p>`;
    if (get(3)) renderPositions(get(3).positions); else $('warPositions').innerHTML = `<p class="war-empty war-unavailable">Positions unavailable: ${esc(fail(3))}</p>`;
    if (get(4)) { renderTrades(get(4).trades); renderPerf(get(4).trades); } else { $('warTrades').innerHTML = `<p class="war-empty war-unavailable">Trades unavailable: ${esc(fail(4))}</p>`; renderPerf(null); }
    if (get(5)) renderBacktests(get(5).backtests);
    if (get(6)) renderAlerts(get(6).alerts); else $('warAlerts').innerHTML = `<p class="war-empty war-unavailable">Alerts unavailable: ${esc(fail(6))}</p>`;
    if (!settingsView) { try { settingsView = await api('/api/warrior/settings'); renderSettings(); } catch (_) { /* settings panel keeps its empty state */ } }
  }

  async function open() {
    shell(); mounted = true;
    $('warPaperConnect').onclick = connectionModal;
    $('warScannerToggle').onclick = toggleScanner;
    $('warSave').onclick = saveSettings;
    $('warBtForm').onsubmit = runBacktest;
    try { settingsView = await api('/api/warrior/settings'); renderSettings(); } catch (_) {}
    await refresh(); if (!mounted) return; clearInterval(polling); polling = setInterval(refresh, 30000);
  }
  function pause() { mounted = false; clearInterval(polling); polling = null; }
  window.warriorBot = { open, pause };
}());
