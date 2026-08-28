/* Opening Momentum — PMH Break page. This page never derives a trade locally:
 * the authenticated server returns the frozen levels, freshness verdict, score,
 * risk sizing, and eligibility from the shared deterministic contract. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fmt = (n, d = 2) => Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const money = n => Number.isFinite(Number(n)) ? `$${fmt(n)}` : '—';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c]));
  const input = id => Number($(id)?.value);
  const watchlist = 'AAPL,NVDA,AMD,TSLA,PLTR,SOFI,HOOD,MARA,IONQ,SMCI,COIN,QQQ,SPY,OKLL,SKHL,AVS,SPCH,SNDC,MSTZ,RGTZ,RAM,APRE,CDTG,INTW,HODU,TSLG,PATX,MUU,SNXX,SKHX,GLL,TSXD,TSLZ,NVDQ,TSDD,CORD,DAMD,PLTD,SMCZ,QQQD,ORCZ,NVD,ORCU,SOFX,KEEL,CIFG,AFRU,IRE,AMAU,NVDL,SMCX,PLTG,ADBG,NOWL,VYX,UECG,NUVB,NVDY,TSLL,SATL,USAS,EXK,MTA,BTG,DNN,CRML,TMQ,ASM,PLG,IAUX';
  const defaults = {
    minScore:80, minRelativeVolume:2, minVolumeZScore:1.5, minBodyRatio:.55,
    maxUpperWickRatio:.28, minRoomRiskMultiple:2, maxRiskDollars:100, maxPositionDollars:5000,
    maxRiskPerSharePct:8, maxTradePrice:15, maxTradesPerDay:3, maxDailyLoss:500, partialTargetR:2, partialPercent:50,
    requireMarketStrength:true, requireRelativeStrength:true, requireSectorStrength:false,
  };
  let config = { ...defaults }, enabled = false, liveAutomationPaused = false, results = [], selected = null, interval = null, initialized = false, scanning = false;
  let connectionBound = false;

  function readConfig() {
    return {
      ...config,
      minScore:input('pmhMinScore'), minRelativeVolume:input('pmhRelVol'), minVolumeZScore:input('pmhVolZ'),
      minBodyRatio:input('pmhBody'), maxUpperWickRatio:input('pmhWick'), minRoomRiskMultiple:input('pmhResistance'),
      maxRiskDollars:input('pmhRisk'), maxPositionDollars:input('pmhMaxPosition'), maxTradePrice:input('pmhMaxPrice'), maxTradesPerDay:input('pmhMaxTrades'), maxDailyLoss:input('pmhMaxLoss'), maxRiskPerSharePct:input('pmhMaxStop'),
      partialTargetR:input('pmhPartialR'), partialPercent:input('pmhPartialPct'),
      requireMarketStrength:$('pmhRequireMarket')?.checked === true,
      requireRelativeStrength:$('pmhRequireRS')?.checked === true,
      requireSectorStrength:false,
    };
  }
  function putConfig(c) {
    config = { ...defaults, ...(c || {}) };
    const pairs = { pmhMinScore:'minScore', pmhRelVol:'minRelativeVolume', pmhVolZ:'minVolumeZScore', pmhBody:'minBodyRatio', pmhWick:'maxUpperWickRatio', pmhResistance:'minRoomRiskMultiple', pmhRisk:'maxRiskDollars', pmhMaxPosition:'maxPositionDollars', pmhMaxPrice:'maxTradePrice', pmhMaxStop:'maxRiskPerSharePct', pmhPartialR:'partialTargetR', pmhPartialPct:'partialPercent', pmhMaxTrades:'maxTradesPerDay', pmhMaxLoss:'maxDailyLoss' };
    Object.entries(pairs).forEach(([id,key]) => { if ($(id)) $(id).value = config[key]; });
    if ($('pmhRequireMarket')) $('pmhRequireMarket').checked = config.requireMarketStrength !== false;
    if ($('pmhRequireRS')) $('pmhRequireRS').checked = config.requireRelativeStrength !== false;
  }
  async function request(url, opts = {}) {
    const response = await fetch(url, { credentials:'include', headers: { 'Content-Type':'application/json', ...(opts.headers || {}) }, ...opts });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  async function refreshBrokerStatus() {
    const dot = $('pmhConnDot'), text = $('pmhConnText'), button = $('pmhConnBtn');
    if (!dot || !text || !button) return;
    try {
      const status = await request('/api/alpaca/credentials?connection=pmh');
      const connected = status.connected === true;
      dot.className = `at-conn-dot ${connected ? 'dot-green' : 'dot-red'}`;
      text.textContent = connected
        ? `Connected · ${String(status.mode || 'paper').toUpperCase()} · Account ${status.accountId || 'verifying…'}`
        : 'Not connected';
      button.textContent = connected ? 'Account Settings' : 'Connect Alpaca';
    } catch (e) {
      dot.className = 'at-conn-dot dot-red';
      text.textContent = e.message === 'session_expired' ? 'Sign in required' : 'Not connected';
      button.textContent = 'Connect Alpaca';
    }
  }
  async function saveSettings(nextEnabled = enabled) {
    config = readConfig();
    const saved = await request('/api/opening-momentum/settings', { method:'PUT', body:JSON.stringify({ enabled:nextEnabled, config }) });
    enabled = saved.enabled; putConfig(saved.config);
    await request('/api/bots/toggle', { method:'POST', body:JSON.stringify({ bot:'pmh', enabled }) });
    renderBot();
  }
  function renderBot() {
    const btn = $('pmhBotToggle'), bar = $('pmhBotBar');
    if (!btn || !bar) return;
    btn.textContent = enabled ? '■ PAUSE AUTOMATION' : '▶ ENABLE AUTOMATION';
    btn.classList.toggle('mt-bot-toggle--off', !enabled);
    bar.classList.toggle('mt-bot-bar--on', enabled);
    $('pmhBotStatus').textContent = enabled
      ? (liveAutomationPaused
        ? 'Paper automation is available. PMH live submissions are paused for safety validation.'
        : 'Automation is active: only server-confirmed TRADE ELIGIBLE setups can submit.')
      : 'Automation is off. Scans remain read-only.';
  }
  function statusClass(status) {
    if (status === 'TRADE ELIGIBLE') return 'eligible';
    if (status === 'BREAKOUT CONFIRMED') return 'confirmed';
    if (status === 'BREAKOUT FAILED') return 'failed';
    if (status === 'BLOCKED') return 'blocked';
    if (status === 'BREAKOUT TEST') return 'test';
    return 'waiting';
  }
  function renderRows() {
    const body = $('pmhScanBody'); if (!body) return;
    if (!results.length) { body.innerHTML = '<tr><td colspan="7" class="mt-empty-row">No candidate data returned. A missing or stale Alpaca feed remains a no-trade state.</td></tr>'; return; }
    body.innerHTML = results.map((r, i) => `<tr class="pmh-row ${selected?.symbol === r.symbol ? 'active':''}" data-pmh-index="${i}">
      <td><strong>${esc(r.symbol)}</strong><br><span class="mt-panel-sub">${r.premarket?.frozen ? 'PMH frozen' : 'no PMH'}</span></td>
      <td class="mt-r">${money(r.opening?.price)}<br><span class="mt-panel-sub">${money(r.premarket?.high)}</span></td>
      <td class="mt-r">${money(r.candle?.close)}</td>
      <td class="mt-r">${r.volume?.available ? `${fmt(r.volume.relativeVolume,1)}× / ${fmt(r.volume.zScore,1)}` : 'unavailable'}</td>
      <td class="mt-r">${money(r.levels?.riskPerShare)}</td>
      <td class="mt-r"><strong>${fmt(r.score,0)}</strong></td>
      <td class="mt-r"><span class="pmh-status pmh-status--${statusClass(r.status)}">${esc(r.status)}</span></td>
    </tr>`).join('');
    body.querySelectorAll('[data-pmh-index]').forEach(row => row.addEventListener('click', () => {
      selected = results[Number(row.dataset.pmhIndex)]; renderRows(); renderDetail();
    }));
  }
  function metric(label, value) { return `<div class="pmh-metric"><span>${esc(label)}</span><strong>${value}</strong></div>`; }
  function renderDetail() {
    const body = $('pmhDetailBody'); if (!body) return;
    const r = selected;
    if (!r) { body.innerHTML = '<span class="mt-na">Select a candidate to see its fixed level, risk preview, and every passed or blocked condition.</span>'; return; }
    const reasons = Array.isArray(r.reasons) ? r.reasons : [];
    body.innerHTML = `<div class="pmh-detail-top">
      <div><div class="pmh-detail-symbol">${esc(r.symbol)}</div><span class="pmh-detail-price">${money(r.quote?.price)} · ${fmt(r.score,0)}/100</span></div>
      <span class="pmh-status pmh-status--${statusClass(r.status)}">${esc(r.status)}</span>
    </div>
    <div class="pmh-grid">
      ${metric('Previous close / high', `${money(r.previousDay?.close)} / ${money(r.previousDay?.high)}`)}
      ${metric('Opening gate', r.opening?.eligible ? '<span class="pmh-pass">Passed</span>' : 'Blocked')}
      ${metric('Frozen PMH / low', `${money(r.premarket?.high)} / ${money(r.premarket?.low)}`)}
      ${metric('2-minute close', `${money(r.candle?.close)} ${r.candle?.closedAbovePmh ? '<span class="pmh-pass">above PMH</span>' : ''}`)}
      ${metric('Volume evidence', r.volume?.available ? `${fmt(r.volume.relativeVolume,2)}× · z ${fmt(r.volume.zScore,2)}` : 'Unavailable')}
      ${metric('ATR / 9 EMA', `${money(r.context?.atr)} / ${money(r.context?.ema9)}`)}
      ${metric('Resistance room', `${money(r.levels?.resistance)} · ${fmt(r.levels?.roomR,2)}R`)}
      ${metric('Risk sizing', `${r.sizing?.shares ?? 0} shares · ${money(r.sizing?.estimatedNotional)}`)}
      ${metric('Stop at candle low', `${money(r.levels?.stop)} · ${money(r.levels?.riskPerShare)}/share`)}
      ${metric('Partial / runner', `${r.targets?.partialPercent ?? '—'}% at ${money(r.targets?.partialPrice)} · 9 EMA runner`)}
      ${metric('Market / relative strength', `${r.context?.market?.bullish ? 'SPY positive' : 'Unavailable / failed'} · ${r.context?.relativeStrength === true ? 'outperforming' : 'not confirmed'}`)}
      ${metric('Price-action context', r.priceAction?.setup?.label || r.priceAction?.status || 'Unavailable')}
      ${metric('Structural invalidation', `${money(r.priceAction?.invalidation)}${r.priceAction?.riskReward != null ? ` · ${fmt(r.priceAction.riskReward,2)}R` : ''}`)}
    </div>
    <div class="pmh-reason-title">${reasons.length ? 'Blocked or pending conditions' : 'All configured conditions passed'}</div>
    ${reasons.length ? `<ul class="pmh-reasons">${reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="pmh-pass">Complete fresh evidence. Entry still re-checks all conditions server-side.</div>'}
    ${r.priceAction?.reasons?.length ? `<div class="pmh-reason-title">Price-action context (informational only)</div><ul class="pmh-reasons">${r.priceAction.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${enabled && r.eligible ? '<button class="mt-trade-buy pmh-execute" id="pmhExecuteBtn">Submit protected PMH entry</button>' : ''}
    `;
    $('pmhDetailTime').textContent = r.freshness?.barsAt ? `bars ${new Date(r.freshness.barsAt).toLocaleTimeString()}` : 'no fresh bars';
    $('pmhExecuteBtn')?.addEventListener('click', () => execute(r.symbol));
  }
  async function execute(symbol) {
    const btn = $('pmhExecuteBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Re-checking broker gates…'; }
    try {
      const out = await request('/api/opening-momentum/execute', { method:'POST', body:JSON.stringify({ symbol }) });
      $('pmhBotStatus').textContent = `${symbol}: order intent recorded; awaiting Alpaca fill confirmation.`;
      await refreshTrades(); await scan(false);
    } catch (e) {
      $('pmhBotStatus').textContent = `${symbol}: ${e.message}`;
    } finally { if ($('pmhExecuteBtn')) { $('pmhExecuteBtn').disabled = false; $('pmhExecuteBtn').textContent = 'Submit protected PMH entry'; } }
  }
  async function refreshTrades() {
    const box = $('pmhTradesBody'); if (!box) return;
    try {
      const { trades } = await request('/api/opening-momentum/trades');
      box.innerHTML = trades?.length ? trades.map(t => `<div class="pmh-trade"><span><strong>${esc(t.symbol)}</strong> · ${esc(t.status)}</span><span>${t.shares} sh · ${money(t.entry_price)}</span></div>`).join('') : 'No PMH order intents have been recorded.';
    } catch (e) { box.textContent = 'Connect Alpaca to view PMH broker journal.'; }
  }
  async function reconcile() {
    if (!enabled) return;
    try {
      const data = await request('/api/opening-momentum/reconcile', { method:'POST', body:'{}' });
      if (data.reconciled?.length) await refreshTrades();
    } catch (e) {
      // A reconciliation failure is visible in the activity area, but it must
      // not turn a missing broker response into a fabricated exit.
      $('pmhBotStatus').textContent = `Broker reconciliation unavailable: ${e.message}`;
    }
  }
  async function scan(allowAuto = true) {
    if (scanning) return;
    scanning = true; $('pmhScanStatus').textContent = 'Fetching fresh 1-minute Alpaca bars…';
    try {
      const data = await request(`/api/opening-momentum/scan?symbols=${encodeURIComponent(watchlist)}`);
      results = data.results || []; config = { ...config, ...(data.config || {}) };
      if (!selected || !results.some(x => x.symbol === selected.symbol)) selected = results[0] || null;
      const coverage = data.coverage || {};
      const brokerCount = Number(coverage.availableAtBroker);
      const rotation = coverage.rotation;
      const coverageLabel = Number.isFinite(brokerCount)
        ? `${coverage.scanned}/${brokerCount.toLocaleString()} catalog snapshot${rotation ? ` · batch ${rotation.batch}/${rotation.totalBatches}` : ''}`
        : `${coverage.scanned ?? results.length} unverified candidates`;
      $('pmhSession').textContent = data.sessionDate
        ? `Session ${data.sessionDate} · ${coverageLabel}`
        : `Session unavailable · ${coverageLabel}`;
      $('pmhScanStatus').textContent = `${results.filter(x => x.eligible).length} eligible · ${results.filter(x => x.status === 'BLOCKED').length} blocked · ${coverage.candidateSource || 'PMH watchlist'}`;
      renderRows(); renderDetail();
      if (enabled && allowAuto) {
        const candidate = results.find(x => x.eligible);
        if (candidate) await execute(candidate.symbol);
      }
    } catch (e) {
      $('pmhScanStatus').textContent = e.message.includes('Not authenticated') ? 'Sign in to scan PMH candidates' : `Scan unavailable: ${e.message}`;
      results = []; renderRows();
    } finally { scanning = false; }
  }
  async function init() {
    if (initialized) return;
    initialized = true;
    $('pmhConfigToggle')?.addEventListener('click', () => {
      const panel = $('pmhConfigBody'); const open = panel?.style.display !== 'none';
      if (panel) panel.style.display = open ? 'none' : ''; $('pmhConfigToggle').textContent = open ? '▼ Configure' : '▲ Hide settings';
    });
    $('pmhRefreshBtn')?.addEventListener('click', () => scan());
    $('pmhApplyConfig')?.addEventListener('click', async () => { await saveSettings(enabled); await scan(false); });
    $('pmhResetConfig')?.addEventListener('click', async () => { putConfig(defaults); await saveSettings(enabled); await scan(false); });
    $('pmhBotToggle')?.addEventListener('click', async () => {
      try { await saveSettings(!enabled); if (enabled) await scan(); } catch (e) { $('pmhBotStatus').textContent = `Could not change automation: ${e.message}`; }
    });
    $('pmhTradesRefresh')?.addEventListener('click', refreshTrades);
    $('pmhConnBtn')?.addEventListener('click', () => {
      if (window.alpacaTrader?.openConnectModal) window.alpacaTrader.openConnectModal('pmh');
      else $('pmhBotStatus').textContent = 'Alpaca connection panel is unavailable.';
    });
    if (!connectionBound) {
      connectionBound = true;
      window.addEventListener('alpaca-connection-changed', async event => {
        if (event.detail?.connection && event.detail.connection !== 'pmh') return;
        await refreshBrokerStatus();
        await refreshTrades();
        await scan(false);
      });
    }
    await refreshBrokerStatus();
    try {
      const saved = await request('/api/opening-momentum/settings');
    enabled = saved.enabled; liveAutomationPaused = saved.liveAutomationPaused === true;
    putConfig(saved.config); renderBot();
    } catch (e) { $('pmhBotStatus').textContent = 'Sign in and connect Alpaca to use Opening Momentum.'; }
    await refreshTrades(); await scan(false);
  }
  window.openingMomentumBot = {
    async open() {
      await init(); await reconcile(); if (!results.length) await scan(false);
      if (enabled && !interval) interval = setInterval(async () => { await reconcile(); await scan(); }, 120000);
    },
    pause() { if (interval) { clearInterval(interval); interval = null; } },
  };
}());