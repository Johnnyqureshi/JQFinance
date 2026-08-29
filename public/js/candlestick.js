/* Standalone UltraBot3 UI. The server is authoritative for every
 * pattern, safety gate, sizing decision, order submission, and reconciliation. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
  const num = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const money = value => Number.isFinite(Number(value)) ? `$${num(value)}` : '—';
  const defaults = { minScore:65, minRelativeVolume:1.2, minRewardRisk:2, maxPositionDollars:1000, maxRiskDollars:100, maxSymbols:16 };
  let config = { ...defaults }, enabled = false, liveArmed = false, readiness = null, results = [], selected = null, interval = null, initialized = false, scanning = false, scanGeneration = 0, refreshChain = Promise.resolve();
  async function request(url, opts = {}) {
    const response = await fetch(url, { credentials:'include', headers:{ 'Content-Type':'application/json', ...(opts.headers || {}) }, ...opts });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  function readConfig() {
    return { ...config, minScore:+$('candleScore').value, minRelativeVolume:+$('candleRelVol').value, minRewardRisk:+$('candleRR').value,
      maxSymbols:+$('candleSymbols').value, maxPositionDollars:+$('candlePosition').value, maxRiskDollars:+$('candleRisk').value };
  }
  function putConfig(next) {
    config = { ...defaults, ...(next || {}) };
    const fields = { candleScore:'minScore', candleRelVol:'minRelativeVolume', candleRR:'minRewardRisk', candleSymbols:'maxSymbols', candlePosition:'maxPositionDollars', candleRisk:'maxRiskDollars' };
    Object.entries(fields).forEach(([id,key]) => { if ($(id)) $(id).value = config[key]; });
  }
  async function refreshConnection() {
    try {
      const status = await request('/api/candlestick/readiness');
      readiness = status;
      enabled = !!status.enabled;
      liveArmed = !!status.liveArmed;
      const brokerUsable = status.connected && status.broker?.reachable && status.broker?.active
        && !status.broker?.tradingBlocked && !status.broker?.accountBlocked;
      $('candleConnDot').className = `at-conn-dot ${brokerUsable ? 'dot-green':'dot-red'}`;
      $('candleConnText').textContent = brokerUsable
        ? `Broker verified · ${String(status.mode).toUpperCase()} · ${status.accountId}`
        : status.connected ? `Credentials saved · broker unavailable · ${String(status.mode).toUpperCase()}` : 'Not connected';
      $('candleConnBtn').textContent = status.connected ? 'Account Settings' : 'Connect Alpaca';
      renderBot();
    } catch (error) {
      $('candleConnText').textContent = 'Connection status unavailable';
      $('candleBotStatus').textContent = `Readiness unavailable: ${error.message}`;
    }
  }
  function renderBot() {
    $('candleBotToggle').textContent = enabled ? '■ PAUSE AUTOMATION' : '▶ ENABLE AUTOMATION';
    $('candleBotToggle').classList.toggle('mt-bot-toggle--off', !enabled);
    $('candleBotBar').classList.toggle('mt-bot-bar--on', enabled);
    $('candleLiveArm').checked = liveArmed;
    const last = readiness?.lastCycleAt
      ? ` Last cycle: ${readiness.lastCycleStatus || 'unknown'} · ${readiness.lastCycleReason || 'No detail recorded.'}`
      : '';
    $('candleBotStatus').textContent = readiness?.blockers?.length
      ? `${readiness.blockers.join(' ')}${last}`
      : enabled
        ? `Automation is on and the broker is verified.${last}`
        : 'Automation is off. Server scans stay read-only.';
  }
  function statusClass(row) { return row.eligible ? 'eligible' : row.direction ? 'waiting' : 'blocked'; }
  function pattern(row) {
    const candlePatterns = Object.entries(row.evidence?.patterns || {})
      .filter(([, active]) => active).map(([name]) => name.replace(/([A-Z])/g, ' $1').trim());
    const momentumPatterns = row.evidence?.patternAnalysis?.confirmed || [];
    return [...new Set([...candlePatterns, ...momentumPatterns.map(name => name.replaceAll('_', ' ').toLowerCase())])].join(', ')
      || 'No confirmed pattern';
  }
  function renderRows() {
    const body = $('candleScanBody'); if (!body) return;
    if (!results.length) { body.innerHTML = '<tr><td colspan="6" class="mt-empty-row">No candidate data returned. Missing or stale data remains a no-trade state.</td></tr>'; return; }
    body.innerHTML = results.map((row, i) => `<tr class="pmh-row ${selected?.symbol === row.symbol ? 'active':''}" data-candle-index="${i}">
      <td><strong>${esc(row.symbol)}</strong></td><td>${esc(row.direction || '—')}</td><td>${esc(pattern(row))}<br><span class="mt-panel-sub">${esc(row.evidence?.regime?.regime || 'UNKNOWN')}</span></td>
      <td class="mt-r">${num(row.evidence?.relativeVolume, 1)}×</td><td class="mt-r"><strong>${num(row.score, 0)}</strong></td>
      <td class="mt-r"><span class="pmh-status pmh-status--${statusClass(row)}">${esc(row.status || 'NO TRADE')}</span></td></tr>`).join('');
    body.querySelectorAll('[data-candle-index]').forEach(el => el.addEventListener('click', () => { selected = results[+el.dataset.candleIndex]; renderRows(); renderDetail(); }));
  }
  const metric = (label, value) => `<div class="pmh-metric"><span>${esc(label)}</span><strong>${value}</strong></div>`;
  function renderDetail() {
    const box = $('candleDetailBody'); if (!box) return;
    if (!selected) { box.textContent = 'Select a candidate to inspect every passed or rejected gate.'; return; }
    const row = selected, evidence = row.evidence || {};
    box.innerHTML = `<div class="pmh-detail-top"><div><div class="pmh-detail-symbol">${esc(row.symbol)} · ${esc(row.direction || 'NO TRADE')}</div><span class="pmh-detail-price">${num(row.score,0)}/100 · ${esc(pattern(row))}</span></div><span class="pmh-status pmh-status--${statusClass(row)}">${esc(row.status)}</span></div>
      <div class="pmh-grid">${metric('Entry / stop', `${money(row.entry)} / ${money(row.stop)}`)}${metric('Target / reward', `${money(row.target)} / ${num(row.riskReward,2)}R`)}${metric('VWAP / rel. volume', `${money(evidence.vwap)} / ${num(evidence.relativeVolume,2)}×`)}${metric('Support / resistance', `${money(evidence.support)} / ${money(evidence.resistance)}`)}${metric('Trend / structure', `${esc(evidence.regime?.trend)} / ${esc(evidence.regime?.structure)}`)}${metric('Confirmation', evidence.confirmation ? '<span class="pmh-pass">Closed trigger passed</span>' : 'Waiting')}</div>
      <div class="pmh-reason-title">${row.reasons?.length ? 'Rejected or pending gates' : 'All safety gates passed'}</div>${row.reasons?.length ? `<ul class="pmh-reasons">${row.reasons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>` : '<div class="pmh-pass">Fresh server evidence is complete. Order submission re-checks this setup.</div>'}
      ${enabled && row.eligible ? '<button class="mt-trade-buy pmh-execute" id="candleExecuteBtn">Submit broker-protected entry</button>' : ''}`;
    $('candleDetailTime').textContent = row.evaluatedAt ? new Date(row.evaluatedAt).toLocaleTimeString() : '—';
    $('candleExecuteBtn')?.addEventListener('click', () => execute(row.symbol));
  }
  async function scan() {
    const generation = ++scanGeneration;
    scanning = true; $('candleScanStatus').textContent = 'Fetching completed 5-minute Alpaca bars…';
    try {
      const data = await request('/api/candlestick/scan');
      if (generation !== scanGeneration) return;
      results = data.results || []; config = { ...config, ...(data.config || {}) };
      if (!selected || !results.some(row => row.symbol === selected.symbol)) selected = results[0] || null;
      const funnel = data.funnel || {}; $('candleScanStatus').textContent = `${funnel.eligible || 0} eligible · ${funnel.rejected || 0} context rejects · ${funnel.noPattern || 0} no pattern`;
      $('candleSession').textContent = `Server-side scan · ${new Date(data.evaluatedAt || Date.now()).toLocaleTimeString()}`; renderRows(); renderDetail();
    } catch (error) {
      if (generation === scanGeneration) $('candleScanStatus').textContent = `Scan unavailable: ${error.message}. Previous results are retained.`;
    } finally { if (generation === scanGeneration) scanning = false; }
  }
  async function execute(symbol) {
    const button = $('candleExecuteBtn'); if (button) { button.disabled = true; button.textContent = 'Re-checking broker gates…'; }
    try { await request('/api/candlestick/execute', { method:'POST', body:JSON.stringify({ symbol }) }); $('candleBotStatus').textContent = `${symbol}: order intent recorded; awaiting broker-confirmed fill.`; await refreshTrades(); }
    catch (error) { $('candleBotStatus').textContent = `${symbol}: ${error.message}`; }
    finally { if ($('candleExecuteBtn')) { $('candleExecuteBtn').disabled = false; $('candleExecuteBtn').textContent = 'Submit broker-protected entry'; } }
  }
  function renderTrades(trades) { $('candleTradesBody').innerHTML = trades?.length ? trades.map(t => `<div class="pmh-trade"><span><strong>${esc(t.symbol)}</strong> · ${esc(t.direction)} · ${esc(t.status)}</span><span>${num(t.shares,0)} sh · ${money(t.entry_price)}</span></div>`).join('') : 'No UltraBot3 order intents have been recorded.'; }
  async function refreshTrades() {
    try { const { trades } = await request('/api/candlestick/trades'); renderTrades(trades); }
    catch { $('candleTradesBody').textContent = 'Connect Alpaca to view the UltraBot3 broker journal.'; }
  }
  async function reconcile() { if (!readiness?.reconciliationReady) return; try { const out = await request('/api/candlestick/reconcile', { method:'POST', body:'{}' }); renderTrades(out.trades); } catch (error) { $('candleBotStatus').textContent = `Broker reconciliation unavailable: ${error.message}`; } }
  async function backtest() {
    $('candleBacktestBody').textContent = 'Replaying completed historical bars without lookahead…';
    try { const data = await request('/api/candlestick/backtest?symbol=SPY'); const m = data.metrics || {}; $('candleBacktestBody').innerHTML = `<strong>${data.insufficientEvidence ? 'Insufficient evidence' : 'Historical replay'}</strong><br>${esc(data.note || '')}<br>${m.trades || 0} closed samples · win rate ${m.winRate == null ? '—' : `${(m.winRate*100).toFixed(1)}%`} · expectancy ${num(m.expectancyR,2)}R · max drawdown ${num(m.maxDrawdownR,2)}R`; } catch (error) { $('candleBacktestBody').textContent = `Backtest unavailable: ${error.message}`; }
  }
  async function save(nextEnabled = enabled, refreshScan = true) {
    config = readConfig(); liveArmed = $('candleLiveArm').checked;
    const out = await request('/api/candlestick/settings', { method:'PUT', body:JSON.stringify({ enabled:nextEnabled, liveArmed, config }) });
    enabled = out.enabled; liveArmed = out.liveArmed; putConfig(out.config); await refreshConnection();
    if (refreshScan) { selected = null; await scan(); }
  }
  function queueRefresh({ includeScan = true, includeTrades = true } = {}) {
    refreshChain = refreshChain.catch(() => {}).then(async () => {
      await refreshConnection();
      if (includeScan) await scan();
      if (includeTrades) await refreshTrades();
    });
    return refreshChain;
  }
  async function init() {
    if (initialized) return; initialized = true;
    $('candleConfigToggle').addEventListener('click', () => { const hidden = $('candleConfigBody').style.display === 'none'; $('candleConfigBody').style.display = hidden ? '' : 'none'; $('candleConfigToggle').textContent = hidden ? '▲ Hide settings' : '▼ Configure'; });
    $('candleConnBtn').addEventListener('click', () => window.alpacaTrader?.openConnectModal('candlestick'));
    $('candleRefreshBtn').addEventListener('click', scan);
    $('candleSaveBtn').addEventListener('click', async () => { try { await save(enabled); } catch (error) { $('candleBotStatus').textContent = `Settings not saved: ${error.message}`; } });
    $('candleResetBtn').addEventListener('click', async () => { const prior = { ...config }; putConfig(defaults); try { await save(enabled); } catch (error) { putConfig(prior); $('candleBotStatus').textContent = `Defaults not saved: ${error.message}`; } });
    $('candleBotToggle').addEventListener('click', async () => { try { await save(!enabled); } catch (error) { $('candleBotStatus').textContent = error.message; } });
    $('candleTradesRefresh').addEventListener('click', refreshTrades); $('candleBacktestBtn').addEventListener('click', backtest);
    window.addEventListener('alpaca-connection-changed', event => { if (event.detail?.connection === 'candlestick') queueRefresh(); });
    await refreshConnection();
    try { const saved = await request('/api/candlestick/settings'); enabled = saved.enabled; liveArmed = saved.liveArmed; putConfig(saved.config); renderBot(); } catch { $('candleBotStatus').textContent = 'Sign in and connect a dedicated Alpaca account to use this bot.'; }
    await refreshTrades(); await scan(); await refreshConnection();
  }
  window.candlestickBot = { async open() { await init(); await reconcile(); if (!results.length) await scan(); await refreshConnection(); if (!interval) interval = setInterval(async () => { await reconcile(); await queueRefresh(); }, 120000); }, pause() { if (interval) { clearInterval(interval); interval = null; } } };
}());