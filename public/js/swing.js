/* Swing Bot — a read-only-first research cockpit. The server owns all gates. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c]));
  const num = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const money = value => Number.isFinite(Number(value)) ? `$${num(value)}` : '—';
  let initialized = false, enabled = false, liveArmed = false, readiness = null, settings = {}, candidates = [], selected = null, interval = null;

  async function request(url, opts = {}) {
    const response = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  function root() { return $('page-swing') || $('swingPage') || $('swingContainer'); }
  function ensureMarkup() {
    const host = root(); if (!host || $('swingRoot')) return;
    host.innerHTML = `<section id="swingRoot" class="swing-shell" aria-labelledby="swingTitle">
      <header class="swing-hero"><div><div class="swing-eyebrow">SYSTEMATIC RESEARCH / SWING HORIZON</div><h1 id="swingTitle">Swing Bot <span>control room</span></h1><p>Evidence first. Capital second. Every order is re-checked server-side before submission.</p></div>
        <div class="swing-actions"><button id="swingConnBtn" class="swing-btn swing-btn-quiet">Connect Alpaca</button><button id="swingRefreshBtn" class="swing-btn">Run next scan batch</button></div></header>
      <div id="swingNotice" class="swing-notice" role="status"></div>
      <section class="swing-status-grid" aria-label="Bot status">
        <article class="swing-status-card"><span class="swing-label">Readiness</span><strong id="swingReadiness">Checking</strong><small id="swingReadinessSub">Server gate status</small></article>
        <article class="swing-status-card"><span class="swing-label">Operating mode</span><strong id="swingMode">—</strong><small id="swingModeSub">Broker account</small></article>
        <article class="swing-status-card"><span class="swing-label">Live arm</span><strong id="swingLive">OFF</strong><small id="swingLiveSub">Paper-safe by default</small></article>
        <article class="swing-status-card"><span class="swing-label">Scan coverage</span><strong id="swingCoverage">—</strong><small id="swingCoverageSub">Latest server evaluation</small></article>
      </section>
      <section class="swing-command"><div><span class="swing-label">Automation</span><h2 id="swingAutomationTitle">Swing engine is paused</h2><p id="swingBotStatus">Loading readiness and account permissions.</p></div><div class="swing-command-actions"><label class="swing-switch"><input id="swingEnabled" type="checkbox"><span></span><b>Enable automation</b></label><label class="swing-switch"><input id="swingLiveArm" type="checkbox"><span></span><b>Arm live orders</b></label></div></section>
      <section class="swing-layout"><div class="swing-main">
        <div class="swing-panel"><div class="swing-panel-head"><div><span class="swing-label">Opportunity queue</span><h2>Candidate scan</h2></div><span id="swingScanTime" class="swing-meta">No scan yet</span></div><div id="swingScanBody" class="swing-candidates"><div class="swing-skeleton"></div><div class="swing-skeleton"></div></div></div>
        <div class="swing-panel"><div class="swing-panel-head"><div><span class="swing-label">Selected setup</span><h2 id="swingSelectedTitle">Select a candidate</h2></div><span id="swingSelectedStatus" class="swing-badge">UNAVAILABLE</span></div><div id="swingDetail" class="swing-detail"><p class="swing-empty">Select a row to inspect levels, reasons, and source evidence.</p></div></div>
      </div><aside class="swing-rail">
        <div class="swing-panel swing-settings"><div class="swing-panel-head"><div><span class="swing-label">Guardrails</span><h2>Position sizing</h2></div></div><label class="swing-field">Maximum dollars per position<input id="swingMaxPosition" type="number" min="1" step="50" inputmode="decimal"><small>Only editable strategy control. Server validates the final order.</small></label><button id="swingSaveBtn" class="swing-btn swing-btn-full">Save guardrail</button></div>
        <div class="swing-panel"><div class="swing-panel-head"><div><span class="swing-label">Broker journal</span><h2>Open lifecycle</h2></div><button id="swingReconcileBtn" class="swing-link-btn">Reconcile</button></div><div id="swingTrades" class="swing-list"><p class="swing-empty">Loading journal…</p></div></div>
        <div class="swing-panel"><div class="swing-panel-head"><div><span class="swing-label">Risk desk</span><h2>Alerts</h2></div></div><div id="swingAlerts" class="swing-list"><p class="swing-empty">Loading alerts…</p></div></div>
      </aside></section>
      <section class="swing-lower"><div class="swing-panel"><div class="swing-panel-head"><div><span class="swing-label">Attribution</span><h2>Performance</h2></div></div><div id="swingPerformance" class="swing-stats"><p class="swing-empty">Loading performance…</p></div></div><div class="swing-panel"><div class="swing-panel-head"><div><span class="swing-label">Historical replay</span><h2>SPY backtest</h2></div><button id="swingBacktestBtn" class="swing-link-btn">Run replay</button></div><div id="swingBacktest" class="swing-replay"><p class="swing-empty">No look-ahead replay loaded.</p></div></div></section>
    </section>`;
  }
  function text(id, value) { if ($(id)) $(id).textContent = value; }
  function statusClass(row) { return row?.eligible ? 'good' : row?.direction ? 'wait' : 'bad'; }
  function evidence(row) { return row?.evidence || row?.sources || {}; }
  function renderStatus() {
    const broker = readiness?.broker || {}, usable = readiness?.connected && broker.reachable !== false && !broker.tradingBlocked && !broker.accountBlocked;
    text('swingReadiness', readiness?.ready || readiness?.reconciliationReady || usable ? 'READY' : 'BLOCKED');
    text('swingReadinessSub', readiness?.blockers?.length ? readiness.blockers.join(' · ') : usable ? 'Safety gates available' : 'Broker or evidence gate unavailable');
    text('swingMode', String(readiness?.mode || '—').toUpperCase());
    text('swingModeSub', readiness?.accountId ? `Account ${readiness.accountId}` : readiness?.connected ? 'Credentials saved' : 'No broker connected');
    text('swingLive', liveArmed ? 'ARMED' : 'OFF'); text('swingLiveSub', liveArmed ? 'Live orders require all gates' : 'Paper-safe by default');
    text('swingAutomationTitle', enabled ? 'Swing engine is active' : 'Swing engine is paused');
    text('swingBotStatus', readiness?.blockers?.length ? readiness.blockers.join(' ') : enabled ? 'Scanning is active; execution remains server-authoritative.' : 'Server scans stay read-only while automation is paused.');
    const live = $('swingLive'); if (live) live.className = liveArmed ? 'swing-positive' : '';
    if ($('swingEnabled')) $('swingEnabled').checked = enabled;
    if ($('swingLiveArm')) $('swingLiveArm').checked = liveArmed;
    if ($('swingLiveArm')) $('swingLiveArm').disabled = readiness?.mode !== 'live';
  }
  function renderScan(data) {
    candidates = data?.results || data?.candidates || []; const funnel = data?.funnel || {};
    text('swingCoverage', funnel.scanned != null ? `${funnel.scanned} symbols` : `${candidates.length} candidates`);
    text('swingCoverageSub', funnel.eligible != null ? `${funnel.eligible} eligible · ${funnel.rejected || 0} rejected` : 'Latest server evaluation');
    text('swingScanTime', data?.evaluatedAt ? new Date(data.evaluatedAt).toLocaleTimeString() : 'Just now');
    const body = $('swingScanBody'); if (!body) return;
    if (!candidates.length) { body.innerHTML = '<p class="swing-empty">No candidate data returned. Missing or stale evidence is a no-trade state.</p>'; return; }
    if (!selected || !candidates.some(r => r.symbol === selected.symbol)) selected = candidates[0];
    body.innerHTML = candidates.map((row, i) => `<button class="swing-candidate ${selected?.symbol === row.symbol ? 'is-selected' : ''}" data-swing-index="${i}"><span class="swing-symbol">${esc(row.symbol)}</span><span class="swing-candidate-copy"><b>${esc(row.direction || 'NO TRADE')}</b><small>${esc((row.reasons || row.reason || []).join ? (row.reasons || []).slice(0, 2).join(' · ') : row.reason || 'Evidence summary unavailable')}</small></span><span class="swing-score">${Number.isFinite(Number(row.score)) ? num(row.score, 0) : '—'}<small>SCORE</small></span><span class="swing-badge ${statusClass(row)}">${esc(row.status || (row.eligible ? 'ELIGIBLE' : 'WAITING'))}</span></button>`).join('');
    body.querySelectorAll('[data-swing-index]').forEach(el => el.addEventListener('click', () => { selected = candidates[+el.dataset.swingIndex]; renderScan({ results: candidates }); renderDetail(); }));
    renderDetail();
  }
  function metric(label, value) { return `<div class="swing-metric"><span>${esc(label)}</span><strong>${value}</strong></div>`; }
  function renderDetail() {
    const box = $('swingDetail'); if (!box) return;
    if (!selected) { box.innerHTML = '<p class="swing-empty">Select a row to inspect levels, reasons, and source evidence.</p>'; return; }
    const e = evidence(selected), reasons = selected.reasons || [];
    text('swingSelectedTitle', `${selected.symbol} · ${selected.direction || 'NO TRADE'}`); text('swingSelectedStatus', selected.status || (selected.eligible ? 'ELIGIBLE' : 'WAITING'));
    const trend = e.trend?.state || e.trend || 'UNAVAILABLE';
    const adv = e.liquidity?.value?.averageDollarVolume ?? selected.averageDollarVolume;
    const firstTarget = selected.target ?? selected.targets?.[0]?.price;
    const finalTarget = selected.targets?.[2]?.price;
    const sources = selected.sourceState || {};
    const sourceSummary = ['fundamentals','catalyst','sector','market'].map(key => `${key}: ${sources[key] || 'UNAVAILABLE'}`).join(' · ');
    box.innerHTML = `<div class="swing-detail-grid">${metric('Next-session reference', money(selected.entry))}${metric('Structural stop', money(selected.stop ?? selected.structuralStop))}${metric('TP1 / TP3', `${money(firstTarget)} / ${money(finalTarget)}`)}${metric('Risk / reward', selected.riskReward == null ? 'Unavailable' : `${num(selected.riskReward)}R`)}${metric('Weekly / daily trend', esc(trend))}${metric('Average dollar volume', adv == null ? 'Unavailable' : money(adv))}</div><div class="swing-sources"><b>Optional source state</b><p>${esc(sourceSummary)}</p><small>Unavailable context reduces confidence and is never invented.</small></div><div class="swing-reasons"><b>${reasons.length ? 'Pending or rejected gates' : 'Evidence gates passed'}</b>${reasons.length ? `<ul>${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p>Fresh server evidence is complete. The server scheduler owns order submission.</p>'}</div>${selected.eligible ? '<p class="swing-empty">Queued for the server automation scheduler.</p>' : ''}`;
  }
  function renderList(id, items, empty) {
    const box = $(id); if (!box) return;
    box.innerHTML = items?.length ? items.slice(0, 8).map(item => `<div class="swing-list-row"><div><b>${esc(item.symbol || item.title || item.type || 'Alert')}</b><small>${esc(item.status || item.message || item.reason || item.side || 'Source detail unavailable')}</small></div><strong>${item.pnl == null ? '' : money(item.pnl)}</strong></div>`).join('') : `<p class="swing-empty">${empty}</p>`;
  }
  async function refreshAll() {
    try { readiness = await request('/api/swing/readiness'); enabled = !!readiness.enabled; liveArmed = !!readiness.liveArmed; renderStatus(); } catch (e) { text('swingNotice', `Readiness unavailable: ${e.message}`); }
    try { const saved = await request('/api/swing/settings'); settings = saved || {}; enabled = !!saved.enabled; liveArmed = !!saved.liveArmed; if ($('swingMaxPosition')) $('swingMaxPosition').value = saved.maxPositionDollars ?? ''; renderStatus(); } catch (e) { text('swingNotice', `Settings unavailable: ${e.message}`); }
    try { renderScan(await request('/api/swing/candidates')); } catch (e) { text('swingNotice', `Candidates unavailable: ${e.message}`); }
    try { const d = await request('/api/swing/trades'); renderList('swingTrades', d.trades || d, 'No broker lifecycle records.'); } catch { renderList('swingTrades', [], 'Connect Alpaca to view the broker journal.'); }
    try { const d = await request('/api/swing/alerts'); renderList('swingAlerts', d.alerts || d, 'No active risk alerts.'); } catch { renderList('swingAlerts', [], 'Alerts unavailable.'); }
    try { const d = await request('/api/swing/performance'); const m = d.metrics || d; $('swingPerformance').innerHTML = `<div class="swing-stat"><span>Closed trades</span><strong>${m.trades ?? m.closedTrades ?? '—'}</strong></div><div class="swing-stat"><span>Win rate</span><strong>${m.winRate == null ? 'Unavailable' : `${(Number(m.winRate) * (Number(m.winRate) <= 1 ? 100 : 1)).toFixed(1)}%`}</strong></div><div class="swing-stat"><span>Net P&amp;L</span><strong>${m.netPnl == null ? 'Unavailable' : money(m.netPnl)}</strong></div>`; } catch { text('swingPerformance', 'Performance unavailable.'); }
  }
  async function scan() {
    const button = $('swingRefreshBtn');
    try {
      if (button) { button.disabled = true; button.textContent = 'Scanning completed bars…'; }
      renderScan(await request('/api/swing/scan'));
      text('swingNotice', 'The next stable catalog batch was evaluated with completed daily and weekly bars.');
    } catch (e) { text('swingNotice', `Scan unavailable: ${e.message}`); }
    finally { if (button) { button.disabled = false; button.textContent = 'Run next scan batch'; } }
  }
  async function save() { const button = $('swingSaveBtn'); try { button.disabled = true; const d = await request('/api/swing/settings', { method: 'PUT', body: JSON.stringify({ enabled, liveArmed: $('swingLiveArm').checked, maxPositionDollars: Number($('swingMaxPosition').value) }) }); enabled = !!d.enabled; liveArmed = !!d.liveArmed; settings = d; renderStatus(); text('swingNotice', 'Guardrail saved.'); } catch (e) { text('swingNotice', `Settings not saved: ${e.message}`); } finally { button.disabled = false; } }
  async function reconcile() { try { const d = await request('/api/swing/reconcile', { method: 'POST', body: '{}' }); renderList('swingTrades', d.trades || d, 'No broker lifecycle records.'); } catch (e) { text('swingNotice', `Reconciliation unavailable: ${e.message}`); } }
  async function backtest() { text('swingBacktest', 'Replaying completed historical bars without look-ahead…'); try { const d = await request('/api/swing/backtest?symbol=SPY'); const m = d.metrics || {}; $('swingBacktest').innerHTML = `<b>${d.insufficientEvidence ? 'Insufficient evidence' : 'Historical replay'}</b><p>${esc(d.note || 'Historical outcomes are not guarantees of future performance.')}</p><span>${m.trades || 0} closed samples · win rate ${m.winRate == null ? 'Unavailable' : `${(Number(m.winRate) * 100).toFixed(1)}%`} · expectancy ${m.expectancyR == null ? 'Unavailable' : `${num(m.expectancyR)}R`}</span>`; } catch (e) { text('swingBacktest', `Backtest unavailable: ${e.message}`); } }
  async function init() { if (initialized) return; initialized = true; ensureMarkup(); if (!root()) return;
    $('swingConnBtn')?.addEventListener('click', () => window.alpacaTrader?.openConnectModal('swing'));
    $('swingRefreshBtn')?.addEventListener('click', scan); $('swingSaveBtn')?.addEventListener('click', save); $('swingReconcileBtn')?.addEventListener('click', reconcile); $('swingBacktestBtn')?.addEventListener('click', backtest);
    $('swingEnabled')?.addEventListener('change', e => { enabled = e.target.checked; renderStatus(); save(); }); $('swingLiveArm')?.addEventListener('change', e => { liveArmed = e.target.checked; save(); });
    window.addEventListener('alpaca-connection-changed', e => { if (e.detail?.connection === 'swing') refreshAll(); }); await refreshAll();
  }
  window.swingBot = { async open() { await init(); if (!interval) interval = setInterval(refreshAll, 120000); }, pause() { if (interval) { clearInterval(interval); interval = null; } } };
}());