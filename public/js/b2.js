/* B2 Bot — evidence-first 20/50 daily crossover controls. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const isNumber = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));
  const money = value => isNumber(value) ? Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—';
  const number = (value, digits = 2) => isNumber(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  let mounted = false, polling = null, status = null, candidates = [], sizingDirty = false, refreshing = false;
  let changing = false, revision = 0;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response. Refresh to verify the current state.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (!data || typeof data !== 'object') throw new Error('Server response is incomplete.');
    return data;
  }
  function notice(message, error) { const el = $('b2Notice'); if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); } }
  function shell() {
    const page = $('page-b2');
    if (!page || $('b2Root')) return;
    page.innerHTML = `<section class="b2-shell" id="b2Root" aria-labelledby="b2Title">
      <header class="b2-hero"><div><span class="b2-eyebrow">AUTOMATED EQUITY / DAILY CONFIRMATION</span><h1 id="b2Title">B2 Bot <em>automatic trading</em></h1><p>Connect Alpaca, choose your position size, and let B2 scan, enter, protect, and exit. No browser tab required.</p></div><span class="b2-auto-label">SERVER-RUN AUTOMATION</span></header>
      <div class="b2-notice" id="b2Notice" role="status" aria-live="polite"></div>
      <section class="b2-status" aria-label="B2 system status">
        <div><span>Connection</span><strong id="b2Connection">CHECKING</strong><small id="b2Account">Dedicated account required</small></div>
        <div><span>Execution</span><strong id="b2Execution">CHECKING</strong><small id="b2ExecutionNote">Waiting for account status</small></div>
        <div><span>Scheduler</span><strong id="b2Scheduler">—</strong><small id="b2SchedulerNote">Server-owned cycle</small></div>
        <div><span>Universe coverage</span><strong id="b2Coverage">—</strong><small id="b2CoverageNote">Awaiting scan rotation</small></div>
      </section>
      <section class="b2-command"><div><span class="b2-eyebrow">AUTOMATIC ENTRY & EXIT</span><h2 id="b2Mandate">Connect an account to begin</h2><p id="b2MandateCopy">Paper starts automatically after verification. Live requires your explicit authorization.</p><p id="b2Blockers" class="b2-blockers"></p></div><button class="b2-button b2-quiet" id="b2Automation" disabled>Checking account</button></section>
      <section class="b2-layout"><main class="b2-main"><article class="b2-panel"><div class="b2-head"><div><span class="b2-eyebrow">CANDIDATE LEDGER</span><h2>Completed crossover evidence</h2></div><span id="b2CandidateMeta">Loading</span></div><div class="b2-table-wrap"><table class="b2-table"><thead><tr><th>Symbol / event</th><th>20 / 50 SMA</th><th>Price</th><th>Volume</th><th>Session gain</th><th>Decision</th></tr></thead><tbody id="b2Candidates"><tr><td colspan="6">Loading broker-confirmed evidence…</td></tr></tbody></table></div></article>
      <article class="b2-panel b2-method"><div class="b2-head"><div><span class="b2-eyebrow">METHOD</span><h2>What B2 will and will not infer</h2></div></div><div><p><b>First:</b> the crossover must exist on completed daily bars: 20-day SMA crossing the 50-day SMA. Partial daily bars never qualify.</p><p><b>Then:</b> current-session price, relative volume (current volume ÷ prior 20 completed sessions), and daily-gain filters must be fresh and pass. SIP consolidated market data is required; B2 never falls back to IEX. Missing or stale broker data is a no-trade decision.</p><p><b>Protection:</b> each entry starts with a broker-held stop 5% below its entry limit, conservatively cent-rounded. It is reconciled to the actual average fill, or an existing tighter stop is retained when Alpaca cannot safely replace an OTO leg.</p><div class="b2-rules"><b>Fixed rules</b><span>Price $1–$20 · RVOL ≥2× · gain ≥10% · volume ≥500k · spread ≤1% · max 2 positions · higher highs/lows · whipsaw filter</span><small>Signals are evidence, not a guarantee of performance.</small></div></div></article></main>
       <aside class="b2-rail"><article class="b2-panel b2-broker"><div class="b2-head"><div><span class="b2-eyebrow">DEDICATED BROKER</span><h2>Alpaca accounts</h2></div></div><div class="b2-account-row"><div><b>Paper</b><small id="b2PaperState">Checking</small></div><button class="b2-button b2-quiet" id="b2PaperConnect">Connect</button></div><div class="b2-account-row"><div><b>Live</b><small id="b2LiveState">Checking</small></div><button class="b2-button b2-quiet" id="b2LiveConnect">Connect</button></div><p class="b2-account-note">One active account at a time. SIP data required. Paper uses simulated capital; Live uses real money.</p></article>
       <article class="b2-panel b2-sizing"><div class="b2-head"><div><span class="b2-eyebrow">ONLY STRATEGY SETTING</span><h2>Position size</h2></div></div><label class="b2-field" for="b2Max">Maximum dollars per position<input id="b2Max" type="number" min="1" max="100000000" step="0.01" inputmode="decimal"><small>New entries only. Buying power and fixed risk limits can reduce the order size. Changing this never resizes an existing position.</small></label><button class="b2-button b2-save" id="b2Save">Save position size</button></article>
      <article class="b2-panel"><div class="b2-head"><div><span class="b2-eyebrow">BROKER JOURNAL</span><h2>Trades & protection</h2></div></div><div class="b2-list" id="b2Trades">Loading trades…</div></article>
      <article class="b2-panel"><div class="b2-head"><div><span class="b2-eyebrow">RISK DESK</span><h2>Alerts</h2></div></div><div class="b2-list" id="b2Alerts">Loading alerts…</div></article></aside></section>
    </section>`;
  }
  function renderStatus() {
    if (!status) return;
    const connected = !!status.connected, live = status.mode === 'live', coverage = status.coverage || {}, scheduler = status.scheduler || {};
    $('b2Connection').textContent = connected ? String(status.mode || 'paper').toUpperCase() + ' CONNECTED' : 'DISCONNECTED';
    $('b2Account').textContent = status.accountId ? `Account ${status.accountId}` : (status.blockers || []).join(' · ') || 'Dedicated B2 account required';
    const authorized = connected && status.enabled && (!live || status.liveArmed);
    $('b2Execution').textContent = !connected ? 'NOT CONNECTED' : !authorized ? 'PAUSED' : !status.ready ? 'BLOCKED' : status.marketOpen === false ? 'MARKET CLOSED' : status.marketOpen === true ? 'AUTOMATIC' : 'AWAITING CHECK';
    $('b2ExecutionNote').textContent = authorized ? 'Scanning, entries, stops and exits are server-run' : connected ? 'New entries paused; existing trades still managed' : 'Connect Paper or authorize Live to start';
    $('b2Scheduler').textContent = String(scheduler.status || 'IDLE').toUpperCase();
    $('b2SchedulerNote').textContent = scheduler.reason || (scheduler.lastCycleAt ? `Last cycle ${new Date(scheduler.lastCycleAt).toLocaleTimeString()}` : 'No completed cycle yet');
    $('b2Coverage').textContent = coverage.total == null ? '—' : `${coverage.scanned || 0} / ${coverage.total}`;
    $('b2CoverageNote').textContent = coverage.updatedAt ? `Full tradable catalog · updated ${new Date(coverage.updatedAt).toLocaleTimeString()}` : 'All active Alpaca US equities & ETFs · rotating batches';
    $('b2CoverageNote').title = coverage.minimumPassCycles
      ? `${coverage.batchSize} symbols per cycle; at least ${coverage.minimumPassCycles} cycles per complete pass. Cycles are scheduled every minute; broker latency and account load can extend this. The catalog is not scanned simultaneously.`
      : 'The full catalog is scanned in rotating batches, not simultaneously. Fixed entry filters still apply to every ticker.';
    $('b2Mandate').textContent = !connected ? 'Connect an account to begin' : authorized ? 'B2 manages the complete trade automatically' : 'New entries are paused';
    $('b2MandateCopy').textContent = authorized ? 'Runs without an open browser. Only verified completed-day crossovers that pass every current filter can enter. Bearish crossovers and protective stops manage exits.' : connected ? 'Existing B2 positions remain under reconciliation and protection. Resume when you are ready for new automatic entries.' : 'Paper starts automatically after verification. Live requires your explicit authorization. Set your position size before connecting.';
    $('b2Blockers').textContent = connected ? (status.blockers || []).join(' · ') : '';
    $('b2Automation').disabled = changing;
    $('b2Automation').textContent = !connected ? 'Connect Alpaca' : authorized ? 'Pause new entries' : 'Resume automatic trading';
    for (const mode of ['paper', 'live']) {
      const prefix = mode === 'paper' ? 'b2Paper' : 'b2Live';
      const saved = !!status.connections?.[mode]?.connected;
      $(prefix + 'State').textContent = saved ? status.mode === mode ? 'Connected · selected' : 'Connected · inactive' : 'Not connected';
      $(prefix + 'Connect').textContent = saved ? 'Manage' : 'Connect';
    }
    if (!sizingDirty) $('b2Max').value = status.maxPositionDollars ?? '';
  }
  function renderCandidates(data) {
    candidates = data.candidates || [];
    const coverage = data.coverage || status?.coverage || {};
    $('b2CandidateMeta').textContent = coverage.total == null ? 'No coverage data' : `${coverage.scanned || 0} scanned in current rotation${candidates.length > 150 ? ` · showing top 150 of ${candidates.length}` : ''}`;
    const body = $('b2Candidates');
    if (!candidates.length) { body.innerHTML = '<tr><td colspan="6" class="b2-empty">No candidates returned. Missing evidence and failed filters are withheld rather than guessed.</td></tr>'; return; }
    body.innerHTML = candidates.slice(0, 150).map(item => {
      const m = item.metrics || {};
      const gates = Array.isArray(item.gates) ? item.gates : [];
      const gateReasons = gates.map(gate => gate.passed ? `${gate.name || 'Filter'}: passed` : `${gate.name || 'Filter'}: blocked${gate.reason ? ` — ${gate.reason}` : ''}`);
      const reasons = [...(item.reasons || []), ...gateReasons].join(' · ') || 'No explanation returned';
      const decision = item.eligible ? 'ELIGIBLE' : item.signal || 'WAIT';
      return `<tr><td><b>${esc(item.symbol)}</b><small>${esc(item.crossover || 'NO CROSS')} · ${esc(item.signalDate || item.eventId || 'no event')}</small></td><td>${number(m.fastMA)}<small>${number(m.previousFastMA)} prior / ${number(m.slowMA)} slow</small></td><td>${money(m.price)}</td><td>${number(m.relativeVolume)}×</td><td>${number(m.dailyGainPct)}%</td><td><span class="b2-decision ${item.eligible ? 'good' : 'wait'}">${esc(decision)}</span><small class="b2-reason">${esc(reasons)}</small></td></tr>`;
    }).join('');
  }
  function renderList(id, items, empty, trade) {
    const el = $(id); if (!el) return;
    el.innerHTML = items?.length ? items.slice(0, 8).map(item => trade
      ? `<div class="b2-row"><div><b>${esc(item.symbol || 'Trade')} <span>${esc(item.status || 'PENDING')}</span></b><small>${item.filledShares == null ? 'Awaiting fill' : `${number(item.filledShares, 0)} shares at ${money(item.entryPrice)}`} · stop ${money(item.stopPrice)}</small></div><strong>${item.pnl == null ? '—' : money(item.pnl)}</strong></div>`
      : `<div class="b2-row"><div><b>${esc(item.type || 'Notice')}</b><small>${esc(item.message || 'No message')}</small></div><strong>${item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ''}</strong></div>`).join('') : `<p class="b2-empty">${empty}</p>`;
  }
  async function refresh() {
    if (!mounted || refreshing || changing) return;
    refreshing = true;
    const startedRevision = revision;
    const results = await Promise.allSettled([api('/api/b2/status'), api('/api/b2/candidates'), api('/api/b2/trades'), api('/api/b2/alerts')]);
    refreshing = false;
    if (!mounted || startedRevision !== revision) return;
    if (results[0].status === 'fulfilled') { status = results[0].value; renderStatus(); } else notice(`Status unavailable: ${results[0].reason.message}`, true);
    if (results[1].status === 'fulfilled') renderCandidates(results[1].value); else $('b2Candidates').innerHTML = `<tr><td colspan="6" class="b2-empty">Candidates unavailable: ${esc(results[1].reason.message)}</td></tr>`;
    if (results[2].status === 'fulfilled') renderList('b2Trades', results[2].value.trades, 'No owned B2 trades are currently recorded.', true);
    else $('b2Trades').innerHTML = `<p class="b2-empty b2-unavailable">Trades unavailable: ${esc(results[2].reason.message)}</p>`;
    if (results[3].status === 'fulfilled') renderList('b2Alerts', results[3].value.alerts, 'No active B2 alerts.');
    else $('b2Alerts').innerHTML = `<p class="b2-empty b2-unavailable">Alerts unavailable: ${esc(results[3].reason.message)}</p>`;
  }
  async function save() {
    if (changing || !$('b2Max').reportValidity()) return;
    changing = true; revision++; $('b2Save').disabled = true;
    try { status = await api('/api/b2/settings', { method: 'PUT', body: JSON.stringify({ maxPositionDollars: Number($('b2Max').value) }) }); sizingDirty = false; renderStatus(); notice('Position size saved for future entries.'); }
    catch (error) { renderStatus(); notice(`Settings not saved: ${error.message}`, true); }
    finally { changing = false; $('b2Save').disabled = false; renderStatus(); }
  }
  async function automation() {
    if (changing) return;
    if (!status?.connected || (!status.enabled && status.mode === 'live')) return connectionModal(status?.mode);
    const action = status.enabled ? 'pause' : 'resume';
    changing = true; revision++; renderStatus();
    try {
      status = await api('/api/b2/automation', { method: 'POST', body: JSON.stringify({ action }) });
      notice(action === 'pause' ? 'New entries paused. Existing positions continue to be managed.' : 'Automatic Paper trading resumed.');
    } catch (error) { notice(`Automation change failed: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  function connectionModal(selectedMode) {
    if (changing) return;
    const old = $('b2Modal'); if (old) old.remove();
    const initialMode = selectedMode === 'live' ? 'live' : 'paper';
    const previousFocus = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="b2-modal" id="b2Modal" role="dialog" aria-modal="true" aria-labelledby="b2ModalTitle"><form class="b2-modal-card" id="b2Form"><button type="button" class="b2-close" id="b2Close" aria-label="Close">×</button><span class="b2-eyebrow">B2 DEDICATED CONNECTION</span><h2 id="b2ModalTitle">Connect Alpaca</h2><p>Use a dedicated account, separate from manual trading and LEAP Options. Real-time SIP consolidated data is required; there is no IEX fallback.</p><div class="b2-tabs"><button type="button" data-mode="paper">Paper</button><button type="button" data-mode="live">Live</button></div><input id="b2Mode" type="hidden"><p id="b2ConnectionHelp"></p><button type="button" class="b2-button b2-saved" id="b2UseSaved" hidden>Use saved account</button><label>API key<input id="b2Key" required autocomplete="off"></label><label>API secret<input id="b2Secret" type="password" required autocomplete="off"></label><label class="b2-consent" id="b2LiveConsent" hidden><input id="b2AuthorizeLive" type="checkbox"><span>I authorize B2 to automatically place real-money trades on this Live account at my saved position size.</span></label><p id="b2ConnectionSize"></p><p id="b2FormError" class="b2-form-error" role="alert"></p><div class="b2-modal-actions"><button type="submit" class="b2-button" id="b2Submit">Connect & start Paper</button><button type="button" class="b2-button b2-quiet" id="b2Disconnect">Disconnect all</button></div></form></div>`);
    const close = () => { if (changing) return; $('b2Modal')?.remove(); previousFocus?.focus(); };
    $('b2Close').onclick = close;
    $('b2Modal').onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const elements = [...$('b2Modal').querySelectorAll('button:not(:disabled), input:not(:disabled):not([type=hidden])')].filter(el => el.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const setBusy = busy => { changing = busy; if (busy) revision++; $('b2Modal')?.querySelectorAll('button,input').forEach(control => { control.disabled = busy; }); };
    const chooseMode = mode => {
      $('b2Mode').value = mode;
      $('b2Key').value = ''; $('b2Secret').value = ''; $('b2AuthorizeLive').checked = false;
      document.querySelectorAll('#b2Modal [data-mode]').forEach(x => { x.classList.toggle('active', x.dataset.mode === mode); x.setAttribute('aria-pressed', String(x.dataset.mode === mode)); });
      $('b2LiveConsent').hidden = mode !== 'live';
      $('b2AuthorizeLive').required = mode === 'live';
      $('b2UseSaved').hidden = !status?.connections?.[mode]?.connected;
      $('b2UseSaved').textContent = mode === 'live' ? 'Authorize & use saved Live account' : 'Use saved Paper & start';
      $('b2Submit').textContent = mode === 'live' ? 'Authorize & start Live' : 'Connect & start Paper';
      $('b2ConnectionHelp').textContent = mode === 'live' ? 'Live uses real money. Fresh authorization is required whenever an account is selected or replaced.' : 'Paper uses simulated capital. Verified connection starts automatic trading with your saved position size.';
      $('b2ConnectionSize').textContent = `Saved position limit: ${money(status?.maxPositionDollars)}. Close this dialog to change it before starting.`;
      $('b2FormError').textContent = '';
    };
    document.querySelectorAll('#b2Modal [data-mode]').forEach(button => button.onclick = () => chooseMode(button.dataset.mode));
    const connect = async saved => {
      if (changing) return;
      const mode = $('b2Mode').value, authorizeLive = mode === 'live' && $('b2AuthorizeLive').checked;
      if (mode === 'live' && !authorizeLive) { $('b2FormError').textContent = 'Confirm the real-money trading authorization first.'; $('b2AuthorizeLive').focus(); return; }
      const input = saved ? { mode, authorizeLive } : { apiKey: $('b2Key').value, apiSecret: $('b2Secret').value, mode, authorizeLive };
      setBusy(true);
      try {
        status = await api(saved ? '/api/b2/mode' : '/api/b2/credentials', { method: saved ? 'POST' : 'PUT', body: JSON.stringify(input) });
        setBusy(false); close(); renderStatus();
        notice(`${mode === 'live' ? 'Live authorized' : 'Paper connected'}. B2 runs automatically on the server; market hours, data and safety checks still apply.`);
        refresh();
      } catch (error) { $('b2FormError').textContent = `Connection blocked: ${error.message}`; }
      finally { setBusy(false); renderStatus(); }
    };
    $('b2Disconnect').onclick = async () => {
      if (!window.confirm('Disconnect both saved B2 accounts? This is blocked while positions or orders remain. No broker orders will be canceled.')) return;
      setBusy(true);
      try { status = await api('/api/b2/credentials', { method: 'DELETE' }); setBusy(false); close(); renderStatus(); notice('B2 accounts disconnected.'); }
      catch (error) { $('b2FormError').textContent = `Disconnect blocked: ${error.message}`; }
      finally { setBusy(false); renderStatus(); }
    };
    $('b2UseSaved').onclick = () => connect(true);
    $('b2Form').onsubmit = event => { event.preventDefault(); connect(false); };
    chooseMode(initialMode); $('b2Close').focus();
  }
  async function open() {
    shell(); mounted = true;
    $('b2PaperConnect').onclick = () => connectionModal('paper'); $('b2LiveConnect').onclick = () => connectionModal('live');
    $('b2Save').onclick = save; $('b2Automation').onclick = automation;
    $('b2Max').oninput = () => { sizingDirty = true; };
    await refresh(); if (!mounted) return; clearInterval(polling); polling = setInterval(refresh, 30000);
  }
  function pause() { mounted = false; clearInterval(polling); polling = null; }
  window.b2Bot = { open, pause };
}());