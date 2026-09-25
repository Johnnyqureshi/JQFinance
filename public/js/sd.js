/* Singles & Doubles — intraday VWAP momentum bot controls.
 * Mirrors the B2 page's structure/patterns but talks only to /api/sd/*.
 * B2 numbers are never mixed in here. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const isNumber = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));
  const money = value => isNumber(value) ? Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—';
  const number = (value, digits = 2) => isNumber(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const when = value => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };
  let mounted = false, polling = null, status = null, changing = false, revision = 0, settingsDirty = false, refreshing = false;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response. Refresh to verify the current state.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (!data || typeof data !== 'object') throw new Error('Server response is incomplete.');
    return data;
  }
  function notice(message, error) { const el = $('sdNotice'); if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); } }
  function isConnected(st) {
    if (!st) return false;
    const paper = st.paper === true || st.paper?.connected === true;
    const live = st.live === true || st.live?.connected === true;
    return paper || live || !!st.connected;
  }
  function modeLabel(st) { return st?.mode === 'live' ? 'LIVE' : 'PAPER'; }

  function shell() {
    const page = $('page-sd');
    if (!page || $('sdRoot')) return;
    page.innerHTML = `<section class="sd-shell" id="sdRoot" aria-labelledby="sdTitle">
      <header class="sd-hero"><div><span class="sd-eyebrow">INTRADAY VWAP MOMENTUM</span><h1 id="sdTitle">Singles &amp; Doubles <em>intraday momentum</em><span class="sd-mode-badge" id="sdModeBadge">PAPER</span></h1><p>Connect Alpaca, set risk limits, and let S&amp;D hunt singles (~+1%) and doubles (~+2%) off VWAP with a quality-scored entry filter. No browser tab required.</p></div><span class="sd-auto-label">SERVER-RUN AUTOMATION</span></header>
      <div class="sd-notice" id="sdNotice" role="status" aria-live="polite"></div>
      <section class="sd-status" aria-label="S&amp;D system status">
        <div><span>Connection</span><strong id="sdConnection">CHECKING</strong><small id="sdAccount">Dedicated account required</small></div>
        <div><span>Execution</span><strong id="sdExecution">CHECKING</strong><small id="sdExecutionNote">Waiting for account status</small></div>
        <div><span>Scheduler</span><strong id="sdScheduler">—</strong><small id="sdSchedulerNote">Server-owned cycle</small></div>
        <div><span>Scan coverage</span><strong id="sdCoverage">—</strong><small id="sdCoverageNote">Awaiting scan</small></div>
      </section>
      <section class="sd-command"><div><span class="sd-eyebrow">AUTOMATIC ENTRY &amp; EXIT</span><h2 id="sdMandate">Connect an account to begin</h2><p id="sdMandateCopy">Paper stays paused until you start automation. Live requires your explicit authorization.</p><p id="sdBlockers" class="sd-blockers"></p></div><button class="sd-button sd-quiet" id="sdAutomation" disabled>Checking account</button></section>
      <section class="sd-layout"><main class="sd-main">
      <article class="sd-panel"><div class="sd-head"><div><span class="sd-eyebrow">WHY ISN'T IT TRADING</span><h2>Signal funnel</h2></div><span id="sdFunnelMeta">No scan yet</span></div><div class="sd-funnel-stages" id="sdFunnelStages"><p class="sd-empty">No scan yet — run a scan to see where signals pass or drop out.</p></div><div class="sd-funnel-meta"><span id="sdFunnelRun">—</span><span><button class="sd-button sd-quiet" id="sdScanBtn" type="button">Run scan</button></span></div><div class="sd-reject-title">Top rejection reasons</div><ul class="sd-reject-list" id="sdRejections"><li>No rejection data yet.</li></ul></article>
      <article class="sd-panel"><div class="sd-head"><div><span class="sd-eyebrow">OPEN NOW</span><h2>Open positions</h2></div><span id="sdPositionMeta">—</span></div><div class="sd-list" id="sdPositions"><p class="sd-empty">No open positions.</p></div></article>
      <article class="sd-panel"><div class="sd-head"><div><span class="sd-eyebrow">TRADE JOURNAL</span><h2>Trades</h2></div><span id="sdJournalMeta">—</span></div><div class="sd-journal-wrap"><table class="sd-journal"><thead><tr><th>Signal time</th><th>Symbol / setup</th><th>Quality</th><th>Entry</th><th>Shares</th><th>Stop</th><th>T1 single</th><th>T2 double</th><th>Partial</th><th>Exit</th><th>P&amp;L</th><th>Exit reason</th><th>Status</th></tr></thead><tbody id="sdJournal"><tr><td colspan="13" class="sd-empty">No trades yet.</td></tr></tbody></table></div></article>
      <article class="sd-panel sd-method"><div class="sd-head"><div><span class="sd-eyebrow">METHOD</span><h2>What S&amp;D will and will not infer</h2></div></div><div><p><b>Singles:</b> intraday momentum breaks above VWAP with volume expansion and a quality score ≥ the minimum — partial profits at the single target (~+0.75–1.25%), then the runner works toward the double target (~+1.5–3%) with a protective stop.</p><p><b>Doubles:</b> the same entry setup; after partial profits are taken, the remaining shares ride toward the double target. Any break of the stop exits the full position. Strict per-trade and daily risk limits bound every entry.</p><div class="sd-rules" id="sdRules"><b>Strategy rules</b><span>Loading rules from the server…</span></div></div></article>
      </main>
       <aside class="sd-rail">
       <article class="sd-panel sd-broker"><div class="sd-head"><div><span class="sd-eyebrow">DEDICATED BROKER</span><h2>Alpaca accounts</h2></div></div><div class="sd-account-row"><div><b>Paper</b><small id="sdPaperState">Checking</small></div><button class="sd-button sd-quiet" id="sdPaperConnect">Connect</button></div><div class="sd-account-row"><div><b>Live</b><small id="sdLiveState">Checking</small></div><button class="sd-button sd-quiet" id="sdLiveConnect">Connect</button></div><p class="sd-account-note">Only one strategy can be Live-armed per user. S&amp;D never shares signals, positions, stops, P&amp;L, counters, cooldowns, or locks with B2.</p></article>
       <article class="sd-panel"><div class="sd-head"><div><span class="sd-eyebrow">PERFORMANCE</span><h2>Stats <span class="sd-mode-badge" id="sdStatsLabel">PAPER</span></h2></div></div><div class="sd-stats-grid" id="sdStats"><div class="sd-stat" style="grid-column:span 4"><span>Loading</span><strong>Waiting for the server…</strong></div></div></article>
       <article class="sd-panel sd-sizing"><div class="sd-head"><div><span class="sd-eyebrow">STRATEGY SETTINGS</span><h2>Risk &amp; targets</h2></div></div><div class="sd-settings-grid" id="sdSettings">
        <label class="sd-field">Single target %<input id="sdS_single" type="number" min="0.75" max="1.25" step="0.01"><small>Partial-profit target: 0.75–1.25</small></label>
        <label class="sd-field">Double target %<input id="sdS_double" type="number" min="1.5" max="3.0" step="0.01"><small>Runner target: 1.5–3.0</small></label>
        <label class="sd-field">Partial sell %<input id="sdS_partial" type="number" min="1" max="100" step="1"><small>% of position sold at the single</small></label>
        <label class="sd-field">Min quality score<input id="sdS_quality" type="number" min="1" max="12" step="1"><small>Min entry score (1–12, default 7)</small></label>
        <label class="sd-field">Max risk / trade $<input id="sdS_risk" type="number" min="1" step="0.01"><small>Dollars risked per entry</small></label>
        <label class="sd-field">Max daily loss $<input id="sdS_dailyloss" type="number" min="1" step="0.01"><small>Day stops after this loss</small></label>
        <label class="sd-field">Max open positions<input id="sdS_maxpos" type="number" min="1" max="20" step="1"><small>Concurrent S&amp;D positions</small></label>
        <label class="sd-field">Max total exposure $<input id="sdS_exposure" type="number" min="1" step="0.01"><small>Total dollars in S&amp;D positions</small></label>
        <label class="sd-field">Max trades / day<input id="sdS_maxtrades" type="number" min="1" max="50" step="1"><small>Entries allowed per session</small></label>
        <label class="sd-field">Max $ / position<input id="sdS_maxdollars" type="number" min="1" step="0.01"><small>Dollars per position</small></label>
       </div>
       <label class="sd-field-check" style="margin:0 18px"><input id="sdS_eod" type="checkbox"><span>Flatten all positions before market close (EOD flatten)</span></label>
       <div class="sd-settings-actions"><button class="sd-button" id="sdSaveSettings" type="button">Save settings</button></div></article>
      <article class="sd-panel"><div class="sd-head"><div><span class="sd-eyebrow">RISK DESK</span><h2>Alerts</h2></div></div><div class="sd-list" id="sdAlerts">Loading alerts…</div></article></aside></section>
    </section>`;
  }

  function renderStatus() {
    if (!status || !$('sdConnection')) return;
    const connected = isConnected(status), live = status.mode === 'live';
    const coverage = status.coverage || {}, scheduler = status.scheduler || {};
    const blockers = Array.isArray(status.blockers) ? status.blockers.filter(Boolean) : [];
    $('sdConnection').textContent = connected ? modeLabel(status) + ' CONNECTED' : 'DISCONNECTED';
    $('sdAccount').textContent = status.accountId ? `Account ${status.accountId}` : blockers[0] || 'Dedicated S&D account required';
    const badge = $('sdModeBadge');
    if (badge) { badge.textContent = modeLabel(status); badge.classList.toggle('live', live); }
    const statsBadge = $('sdStatsLabel');
    if (statsBadge) { statsBadge.textContent = modeLabel(status); statsBadge.classList.toggle('live', live); }
    const exec = connected ? (blockers.length ? 'BLOCKED' : !status.enabled ? 'PAUSED' : (status.posture || 'AUTOMATIC')).toString().toUpperCase() : 'NOT CONNECTED';
    $('sdExecution').textContent = exec;
    $('sdExecutionNote').textContent = !connected ? 'Connect Paper or authorize Live to start'
      : status.enabled ? 'Scanning, entries, stops and exits are server-run'
      : 'Paper stays paused until you start automation';
    $('sdScheduler').textContent = scheduler.running === true ? 'RUNNING' : scheduler.running === false ? 'PAUSED' : '—';
    $('sdSchedulerNote').textContent = scheduler.lastTickAt ? `Last tick ${new Date(scheduler.lastTickAt).toLocaleTimeString()}` : 'No completed cycle yet';
    $('sdCoverage').textContent = coverage.symbolsScanned == null ? '—' : `${number(coverage.symbolsScanned, 0)} scanned`;
    $('sdCoverageNote').textContent = coverage.cursor != null ? `Cursor: ${coverage.cursor}` : 'Awaiting scan rotation';
    $('sdMandate').textContent = !connected ? 'Connect an account to begin' : status.enabled ? 'S&D manages the complete trade automatically' : 'S&D is paused';
    $('sdMandateCopy').textContent = !connected
      ? 'Paper stays paused until you start automation. Live requires your explicit authorization.'
      : status.enabled ? 'Runs without an open browser. Only VWAP setups that clear every filter can enter; stops and targets manage exits.' : 'Existing S&D positions remain managed. New entries stay paused until you resume automation.';
    $('sdBlockers').textContent = connected && blockers.length ? 'Blockers: ' + blockers.join(' · ') : '';
    const btn = $('sdAutomation');
    btn.disabled = changing;
    btn.textContent = !connected ? 'Connect Alpaca' : status.enabled ? 'Pause automatic trading' : 'Resume automatic trading';
    for (const mode of ['paper', 'live']) {
      const prefix = mode === 'paper' ? 'sdPaper' : 'sdLive';
      const conn = status[mode];
      const saved = conn === true || conn?.connected === true;
      const el = $(prefix + 'State'), but = $(prefix + 'Connect');
      if (el) el.textContent = saved ? status.mode === mode ? `Connected · ${status.posture || 'selected'}` : 'Connected · inactive' : 'Not connected';
      if (but) but.textContent = saved ? 'Manage' : 'Connect';
    }
    if (!settingsDirty) fillSettings(status.rules || {});
    renderRules(status.rules || {});
  }
  function renderRules(rules) {
    const el = $('sdRules'); if (!el) return;
    const bits = [];
    if (rules.single_target_pct != null) bits.push(`Single ${rules.single_target_pct}%`);
    if (rules.double_target_pct != null) bits.push(`Double ${rules.double_target_pct}%`);
    if (rules.partial_sell_pct != null) bits.push(`Partial sell ${rules.partial_sell_pct}%`);
    if (rules.min_quality_score != null) bits.push(`Min quality ${rules.min_quality_score}/12`);
    if (rules.max_risk_per_trade != null) bits.push(`Max risk/trade ${money(rules.max_risk_per_trade)}`);
    if (rules.max_daily_loss != null) bits.push(`Max daily loss ${money(rules.max_daily_loss)}`);
    if (rules.max_open_positions != null) bits.push(`Max positions ${rules.max_open_positions}`);
    if (rules.max_total_exposure != null) bits.push(`Max exposure ${money(rules.max_total_exposure)}`);
    if (rules.max_trades_per_day != null) bits.push(`Max trades/day ${rules.max_trades_per_day}`);
    if (rules.max_position_dollars != null) bits.push(`Max $/position ${money(rules.max_position_dollars)}`);
    if (rules.eod_flatten != null) bits.push(`EOD flatten ${rules.eod_flatten ? 'on' : 'off'}`);
    el.innerHTML = `<b>Fixed rules</b><span>${bits.length ? esc(bits.join(' · ')) : 'Rules not yet reported by the server.'}</span><small>Signals are evidence, not a guarantee of performance. S&amp;D and B2 run independently and never share strategy state.</small>`;
  }
  const FUNNEL_STAGES = [
    ['symbols_scanned', 'Symbols scanned', 0],
    ['liquidity_pass', 'Liquidity pass', 1],
    ['momentum_pass', 'Momentum pass', 1],
    ['vwap_pass', 'VWAP pass', 1],
    ['quality_score_pass', 'Quality score pass', 1],
    ['risk_pass', 'Risk pass', 1],
    ['orders_attempted', 'Orders attempted', 0],
    ['orders_accepted', 'Orders accepted', 1],
    ['orders_filled', 'Orders filled', 1]
  ];
  function renderFunnel(data) {
    const stagesEl = $('sdFunnelStages'), meta = $('sdFunnelMeta'), runEl = $('sdFunnelRun'), rej = $('sdRejections');
    const fallback = status?.funnel && typeof status.funnel === 'object' ? { run: status.funnel, topRejections: [] } : null;
    const payload = data || fallback;
    const run = payload?.run || null;
    if (!run) {
      if (stagesEl) stagesEl.innerHTML = '<p class="sd-empty">No scan yet — run a scan to see where signals pass or drop out.</p>';
      if (meta) meta.textContent = 'No scan yet';
      if (runEl) runEl.textContent = '—';
      if (rej) rej.innerHTML = '<li>No rejection data yet.</li>';
      return;
    }
    const max = Math.max(1, ...FUNNEL_STAGES.map(([key]) => Number(run[key]) || 0));
    let prev = null;
    stagesEl.innerHTML = FUNNEL_STAGES.map(([key, label, dim]) => {
      const count = Number(run[key]);
      const has = run[key] != null && Number.isFinite(count);
      const width = has ? Math.max(1, Math.round(count / max * 100)) : 0;
      const delta = has && prev != null && prev.has ? count - prev.count : null;
      if (has) prev = { count, has };
      return `<div class="sd-stage"><span class="sd-stage-label" title="${esc(key)}">${esc(label)}</span><span class="sd-stage-track"><span class="sd-stage-fill${dim ? ' dim' : ''}" style="width:${width}%"></span></span><span class="sd-stage-count">${has ? number(count, 0) : '—'}${delta != null && delta < 0 ? `<span class="sd-stage-delta">${delta} out</span>` : ''}</span></div>`;
    }).join('');
    if (meta) meta.textContent = run.run_id ? `Run ${run.run_id}` : 'Latest run';
    if (runEl) runEl.textContent = `Run ${esc(run.run_id || '—')} · started ${esc(when(run.started_at || run.startedAt))}`;
    const rejections = Array.isArray(payload.topRejections) ? payload.topRejections : [];
    rej.innerHTML = rejections.length
      ? rejections.slice(0, 12).map(r => `<li><span class="sd-reject-stage">${esc(r.stage || '—')}</span><span>${esc(r.reason || 'No reason given')}</span><span class="sd-reject-count">×${number(r.count, 0)}</span></li>`).join('')
      : '<li>No rejections recorded — every signal passed every filter.</li>';
  }

  function qualityClass(score) {
    if (!isNumber(score)) return '';
    const q = Number(score);
    return q >= 9 ? 'q-high' : q >= 7 ? 'q-mid' : 'q-low';
  }
  function statusClass(st) {
    const s = String(st || '').toLowerCase();
    if (['open', 'partial', 'holding'].includes(s)) return 'open';
    if (['rejected', 'canceled', 'cancelled', 'expired'].includes(s)) return 'rejected';
    if (['pending', 'working', 'submitted', 'accepted'].includes(s)) return 'pending';
    return 'closed';
  }
  const SNAPSHOT_KEYS = ['vwap', 'rvol', 'relative_volume', 'volume', 'ema_fast', 'ema_slow', 'sma_20', 'spy_regime', 'entry_reason', 'order_status', 'filled_price', 'avg_fill_price', 'signal_time'];
  function snapshotLine(t) {
    const bits = [];
    for (const key of SNAPSHOT_KEYS) {
      if (t[key] != null && t[key] !== '') bits.push(`${key.replace(/_/g, ' ')}: ${t[key]}`);
    }
    return bits.length ? `<small class="sd-snap">${esc(bits.join(' · '))}</small>` : '';
  }
  function journalRow(t) {
    const pnl = Number(t.pnl);
    const pnlHtml = t.pnl == null || !isNumber(t.pnl) ? '—' : `<span class="${pnl >= 0 ? 'sd-pnl-pos' : 'sd-pnl-neg'}">${money(pnl)}</span>`;
    return `<tr><td>${esc(when(t.signal_date || t.signal_time || t.created_at))}</td>
      <td><b>${esc(t.symbol || '—')}</b>${t.setup ? `<small>${esc(t.setup)}</small>` : ''}${snapshotLine(t)}</td>
      <td>${t.quality_score == null ? '—' : `<span class="sd-quality ${qualityClass(t.quality_score)}">${esc(t.quality_score)}/12</span>`}</td>
      <td>${money(t.entry_price)}</td><td>${t.filled_shares == null ? '—' : number(t.filled_shares, 0)}</td>
      <td>${money(t.stop_price)}</td><td>${t.single_target == null ? '—' : money(t.single_target)}</td><td>${t.double_target == null ? '—' : money(t.double_target)}</td>
      <td>${t.partial_taken == null ? '—' : (t.partial_taken === true || t.partial_taken === 1 ? 'Yes' : String(t.partial_taken))}</td>
      <td>${t.exit_price == null ? '—' : money(t.exit_price)}</td><td>${pnlHtml}</td>
      <td>${t.exit_reason == null ? '—' : `<span class="sd-exit-reason">${esc(t.exit_reason)}</span>`}</td>
      <td><span class="sd-status-tag ${statusClass(t.status)}">${esc(t.status || '—')}</span></td></tr>`;
  }
  function renderTrades(data) {
    const trades = Array.isArray(data?.trades) ? data.trades : [];
    const open = trades.filter(t => ['open', 'partial', 'holding'].includes(String(t.status || '').toLowerCase()));
    const posEl = $('sdPositions'), posMeta = $('sdPositionMeta');
    if (posMeta) posMeta.textContent = open.length ? `${open.length} open` : 'None open';
    if (posEl) posEl.innerHTML = open.length ? open.slice(0, 12).map(t => {
      const unreal = isNumber(t.pnl) ? `<span class="${Number(t.pnl) >= 0 ? 'sd-pnl-pos' : 'sd-pnl-neg'}">${money(t.pnl)}</span>` : money(t.pnl);
      return `<div class="sd-row"><div><b>${esc(t.symbol || 'Trade')} <span>${esc(t.status || 'OPEN').toUpperCase()}</span></b><small>${t.filled_shares == null ? 'Awaiting fill' : `${number(t.filled_shares, 0)} shares at ${money(t.entry_price)}`} · stop ${money(t.stop_price)} · T1 ${money(t.single_target)} · T2 ${money(t.double_target)}${t.quality_score != null ? ` · quality ${esc(t.quality_score)}/12` : ''}</small></div><strong>${unreal}</strong></div>`;
    }).join('') : '<p class="sd-empty">No open positions. Run a scan or resume automation to find setups.</p>';
    const body = $('sdJournal'), meta = $('sdJournalMeta');
    if (meta) meta.textContent = trades.length ? `${trades.length} trade${trades.length === 1 ? '' : 's'}` : 'No trades yet';
    if (body) body.innerHTML = trades.length ? trades.slice(0, 200).map(journalRow).join('') : '<tr><td colspan="13" class="sd-empty">No trades yet — nothing has been entered.</td></tr>';
  }
  const STAT_DEFS = [
    ['trades', 'Trades', v => isNumber(v) ? number(v, 0) : '—'],
    ['winRate', 'Win rate', v => isNumber(v) ? number(v, 1) + '%' : '—'],
    ['avgWinner', 'Avg winner', money],
    ['avgLoser', 'Avg loser', money],
    ['profitFactor', 'Profit factor', v => isNumber(v) ? number(v, 2) : '—'],
    ['totalRealizedPnl', 'Total realized P&L', money],
    ['avgPnlPerTrade', 'Avg P&L / trade', money],
    ['largestWin', 'Largest win', money],
    ['largestLoss', 'Largest loss', money],
    ['avgHoldingMinutes', 'Avg holding time', v => isNumber(v) ? `${number(v, 0)} min` : '—'],
    ['singlesHit', 'Singles hit', v => isNumber(v) ? number(v, 0) : '—'],
    ['doublesHit', 'Doubles hit', v => isNumber(v) ? number(v, 0) : '—'],
    ['stopOuts', 'Stop-outs', v => isNumber(v) ? number(v, 0) : '—'],
    ['rejectedSignals', 'Rejected signals', v => isNumber(v) ? number(v, 0) : '—'],
    ['ordersRejected', 'Orders rejected', v => isNumber(v) ? number(v, 0) : '—'],
    ['openPositions', 'Open positions', v => isNumber(v) ? number(v, 0) : '—']
  ];
  function renderStats(data) {
    const el = $('sdStats'); if (!el) return;
    if (!data || typeof data !== 'object') { el.innerHTML = '<div class="sd-stat" style="grid-column:span 4"><span>Unavailable</span><strong>Stats not reported yet</strong></div>'; return; }
    el.innerHTML = STAT_DEFS.map(([key, label, fmt]) => `<div class="sd-stat"><span>${esc(label)}</span><strong>${esc(fmt(data[key]))}</strong></div>`).join('');
  }
  function renderAlerts(data) {
    const el = $('sdAlerts'); if (!el) return;
    const items = Array.isArray(data?.alerts) ? data.alerts : [];
    el.innerHTML = items.length ? items.slice(0, 8).map(item => `<div class="sd-row"><div><b>${esc(item.type || 'Notice')}</b><small>${esc(item.message || 'No message')}</small></div><strong>${item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ''}</strong></div>`).join('') : '<p class="sd-empty">No active S&D alerts.</p>';
  }

  const SETTING_FIELDS = [
    ['sdS_single', 'single_target_pct'], ['sdS_double', 'double_target_pct'], ['sdS_partial', 'partial_sell_pct'],
    ['sdS_quality', 'min_quality_score'], ['sdS_risk', 'max_risk_per_trade'], ['sdS_dailyloss', 'max_daily_loss'],
    ['sdS_maxpos', 'max_open_positions'], ['sdS_exposure', 'max_total_exposure'], ['sdS_maxtrades', 'max_trades_per_day'],
    ['sdS_maxdollars', 'max_position_dollars']
  ];
  function fillSettings(rules) {
    for (const [id, key] of SETTING_FIELDS) {
      const el = $(id); if (!el) continue;
      el.value = rules[key] != null ? rules[key] : '';
    }
    const eod = $('sdS_eod'); if (eod) eod.checked = !!rules.eod_flatten;
  }
  function readSettings() {
    const values = {};
    const errors = [];
    const get = id => { const v = $(id)?.value; return v === '' || v == null ? null : Number(v); };
    const range = (id, key, label, min, max) => {
      const v = get(id);
      if (v == null) return;
      if (!Number.isFinite(v) || v < min || v > max) { errors.push(`${label} must be between ${min} and ${max}.`); return; }
      values[key] = v;
    };
    range('sdS_single', 'single_target_pct', 'Single target %', 0.75, 1.25);
    range('sdS_double', 'double_target_pct', 'Double target %', 1.5, 3.0);
    range('sdS_partial', 'partial_sell_pct', 'Partial sell %', 1, 100);
    range('sdS_quality', 'min_quality_score', 'Min quality score', 1, 12);
    range('sdS_risk', 'max_risk_per_trade', 'Max risk per trade', 0.01, 100000000);
    range('sdS_dailyloss', 'max_daily_loss', 'Max daily loss', 0.01, 100000000);
    range('sdS_maxpos', 'max_open_positions', 'Max open positions', 1, 20);
    range('sdS_exposure', 'max_total_exposure', 'Max total exposure', 0.01, 1000000000);
    range('sdS_maxtrades', 'max_trades_per_day', 'Max trades per day', 1, 50);
    range('sdS_maxdollars', 'max_position_dollars', 'Max dollars per position', 0.01, 1000000000);
    const eod = $('sdS_eod');
    if (settingsDirty && eod) values.eod_flatten = eod.checked;
    return { values, errors };
  }
  async function saveSettings() {
    if (changing) return;
    const { values, errors } = readSettings();
    if (errors.length) { notice('Settings not saved: ' + errors[0], true); return; }
    if (!Object.keys(values).length) { notice('No settings changed.'); return; }
    changing = true; revision++;
    const btn = $('sdSaveSettings'); if (btn) btn.disabled = true;
    try {
      status = await api('/api/sd/settings', { method: 'PUT', body: JSON.stringify(values) });
      settingsDirty = false; renderStatus(); notice('S&D settings saved for future entries.');
    } catch (error) { renderStatus(); notice(`Settings not saved: ${error.message}`, true); }
    finally { changing = false; if (btn) btn.disabled = false; renderStatus(); }
  }
  async function runScan() {
    if (changing) return;
    changing = true; revision++;
    const btn = $('sdScanBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
    try {
      const result = await api('/api/sd/scan', { method: 'POST', body: JSON.stringify({}) });
      notice(`Scan started${result.run_id ? ` (run ${result.run_id})` : ''}. The funnel updates as it completes.`);
      setTimeout(() => { if (mounted) refresh(); }, 8000);
    } catch (error) { notice(`Scan failed: ${error.message}`, true); }
    finally { changing = false; if (btn) { btn.disabled = false; btn.textContent = 'Run scan'; } }
  }
  async function automation() {
    if (changing) return;
    if (!isConnected(status) || (!status.enabled && status.mode === 'live')) return connectionModal(status?.mode);
    const action = status.enabled ? 'pause' : 'resume';
    changing = true; revision++; renderStatus();
    try {
      status = await api('/api/sd/automation', { method: 'POST', body: JSON.stringify({ action }) });
      notice(action === 'pause' ? 'Automation paused. Existing positions continue to be managed.' : 'Automatic Paper trading resumed.');
    } catch (error) { notice(`Automation change failed: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  function connectionModal(selectedMode) {
    if (changing) return;
    const old = $('sdModal'); if (old) old.remove();
    const initialMode = selectedMode === 'live' ? 'live' : 'paper';
    const previousFocus = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="sd-modal" id="sdModal" role="dialog" aria-modal="true" aria-labelledby="sdModalTitle"><form class="sd-modal-card" id="sdForm"><button type="button" class="sd-close" id="sdClose" aria-label="Close">×</button><div class="sd-modal-scroll"><span class="sd-eyebrow">S&amp;D DEDICATED CONNECTION</span><h2 id="sdModalTitle">Connect Alpaca</h2><p>Use a dedicated account, separate from B2 and manual trading. S&amp;D tracks only its own positions — it never touches B2's. Live requires real-time SIP consolidated data; Paper can use Alpaca IEX.</p><div class="sd-tabs"><button type="button" data-mode="paper">Paper</button><button type="button" data-mode="live">Live</button></div><input id="sdMode" type="hidden"><p id="sdConnectionHelp"></p><button type="button" class="sd-button sd-saved" id="sdUseSaved" hidden>Use saved account</button><label>API key<input id="sdKey" required autocomplete="off"></label><label>API secret<input id="sdSecret" type="password" required autocomplete="off"></label><label class="sd-consent" id="sdLiveConsent" hidden><input id="sdAuthorizeLive" type="checkbox"><span>I authorize S&amp;D to automatically place real-money trades on this Live account at my saved risk limits.</span></label><p id="sdConnectionSize"></p><p id="sdFormError" class="sd-form-error" role="alert"></p></div><div class="sd-modal-actions"><button type="submit" class="sd-button" id="sdSubmit">Connect Paper</button><button type="button" class="sd-button sd-quiet" id="sdDisconnect">Disconnect all</button></div></form></div>`);
    const close = () => { if (changing) return; $('sdModal')?.remove(); previousFocus?.focus(); };
    $('sdClose').onclick = close;
    $('sdModal').onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const elements = [...$('sdModal').querySelectorAll('button:not(:disabled), input:not(:disabled):not([type=hidden])')].filter(el => el.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const setBusy = busy => { changing = busy; if (busy) revision++; $('sdModal')?.querySelectorAll('button,input').forEach(control => { control.disabled = busy; }); };
    const savedConnected = mode => { const c = status?.[mode]; return c === true || c?.connected === true; };
    const chooseMode = mode => {
      $('sdMode').value = mode;
      $('sdKey').value = ''; $('sdSecret').value = ''; $('sdAuthorizeLive').checked = false;
      document.querySelectorAll('#sdModal [data-mode]').forEach(x => { x.classList.toggle('active', x.dataset.mode === mode); x.setAttribute('aria-pressed', String(x.dataset.mode === mode)); });
      $('sdLiveConsent').hidden = mode !== 'live';
      $('sdAuthorizeLive').required = mode === 'live';
      $('sdUseSaved').hidden = !savedConnected(mode);
      $('sdUseSaved').textContent = mode === 'live' ? 'Authorize & use saved Live account' : 'Use saved Paper & start';
      $('sdSubmit').textContent = mode === 'live' ? 'Authorize & start Live' : 'Connect & start Paper';
      $('sdConnectionHelp').textContent = mode === 'live' ? 'Live uses real money. Fresh authorization is required whenever an account is selected or replaced.' : 'Paper uses simulated capital. Verified connection can start automatic trading at your saved risk limits.';
      const rules = status?.rules || {};
      $('sdConnectionSize').textContent = `Saved limits: max ${money(rules.max_position_dollars)} per position · max ${rules.max_open_positions ?? '—'} positions. Close this dialog to change them before starting.`;
      $('sdFormError').textContent = '';
    };
    document.querySelectorAll('#sdModal [data-mode]').forEach(button => button.onclick = () => chooseMode(button.dataset.mode));
    const afterMutation = async () => { setBusy(false); close(); notice('Broker connection updated; refreshing state…'); await refresh(); };
    const connect = async saved => {
      if (changing) return;
      const mode = $('sdMode').value, authorizeLive = mode === 'live' && $('sdAuthorizeLive').checked;
      if (mode === 'live' && !authorizeLive) { $('sdFormError').textContent = 'Confirm the real-money trading authorization first.'; $('sdAuthorizeLive').focus(); return; }
      setBusy(true);
      try {
        if (saved) {
          await api('/api/sd/mode', { method: 'POST', body: JSON.stringify({ mode }) });
        } else {
          await api('/api/sd/credentials', { method: 'PUT', body: JSON.stringify({ key: $('sdKey').value.trim(), secret: $('sdSecret').value, mode }) });
        }
        if (mode === 'live' && authorizeLive) status = await api('/api/sd/automation', { method: 'POST', body: JSON.stringify({ action: 'resume' }) });
        else status = await api('/api/sd/status');
        await afterMutation();
        notice(`${mode === 'live' ? 'Live authorized. S&D runs automatically on the server' : 'Paper connected. Start automation when ready — S&D runs on the server'}; market hours, data and safety checks still apply.`);
      } catch (error) { $('sdFormError').textContent = `Connection blocked: ${error.message}`; }
      finally { setBusy(false); renderStatus(); }
    };
    $('sdDisconnect').onclick = async () => {
      if (!window.confirm('Disconnect both saved S&D accounts? This is blocked while positions or orders remain. No broker orders will be canceled.')) return;
      setBusy(true);
      try { await api('/api/sd/credentials', { method: 'DELETE' }); await afterMutation(); notice('S&D accounts disconnected.'); }
      catch (error) { $('sdFormError').textContent = `Disconnect blocked: ${error.message}`; }
      finally { setBusy(false); renderStatus(); }
    };
    $('sdUseSaved').onclick = () => connect(true);
    $('sdForm').onsubmit = event => { event.preventDefault(); connect(false); };
    chooseMode(initialMode); $('sdClose').focus();
  }
  async function refresh() {
    if (!mounted || refreshing || changing) return;
    refreshing = true;
    const startedRevision = revision;
    const results = await Promise.allSettled([api('/api/sd/status'), api('/api/sd/funnel'), api('/api/sd/trades'), api('/api/sd/stats')]);
    refreshing = false;
    if (!mounted || startedRevision !== revision) return;
    if (results[0].status === 'fulfilled') { status = results[0].value; renderStatus(); renderAlerts(results[0].value); } else notice(`Status unavailable: ${results[0].reason.message}`, true);
    if (results[1].status === 'fulfilled') renderFunnel(results[1].value);
    else { const el = $('sdFunnelStages'); if (el) el.innerHTML = `<p class="sd-empty sd-unavailable">Funnel unavailable: ${esc(results[1].reason.message)}</p>`; }
    if (results[2].status === 'fulfilled') renderTrades(results[2].value);
    else { const body = $('sdJournal'); if (body) body.innerHTML = `<tr><td colspan="13" class="sd-empty sd-unavailable">Trades unavailable: ${esc(results[2].reason.message)}</td></tr>`; }
    if (results[3].status === 'fulfilled') renderStats(results[3].value);
    else renderStats(null);
  }
  async function open() {
    shell(); mounted = true;
    const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    bind('sdPaperConnect', () => connectionModal('paper')); bind('sdLiveConnect', () => connectionModal('live'));
    bind('sdSaveSettings', saveSettings); bind('sdAutomation', automation); bind('sdScanBtn', runScan);
    const dirty = () => { settingsDirty = true; };
    for (const [id] of SETTING_FIELDS) { const el = $(id); if (el) el.oninput = dirty; }
    const eod = $('sdS_eod'); if (eod) eod.onchange = dirty;
    await refresh(); if (!mounted) return; clearInterval(polling); polling = setInterval(refresh, 30000);
  }
  function pause() { mounted = false; clearInterval(polling); polling = null; }
  window.sdBot = { open, pause };
  document.addEventListener('pageChanged', event => {
    const page = event?.detail?.page;
    if (page === 'sd') window.sdBot.open();
    else window.sdBot.pause();
  });
}());
