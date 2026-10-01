/* Crypto Breakout Bot — fully automated 24/7 crypto breakout desk.
 * Loop: FIND BREAKOUT → CONFIRM WITH VOLUME → ENTER → RIDE MOMENTUM →
 * DETECT VOLUME FADE/EXHAUSTION → TAKE PROFITS → TRAIL REMAINING POSITION.
 * PAPER is the only working mode. All panels render real API data; every
 * panel degrades gracefully ("... unavailable: <error>") when logged out or
 * when the backend is unreachable. API keys are sent to the server only in
 * the connect request body and are never logged or persisted client-side.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const isNumber = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));
  const money = value => isNumber(value) ? Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—';
  const number = (value, digits = 2) => isNumber(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const pct = value => isNumber(value) ? `${number(value)}%` : '—';
  const rvol = value => isNumber(value) ? `${number(value)}×` : '—';
  const time = value => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d) ? d.toLocaleTimeString() : '—'; };
  const date = value => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d) ? d.toLocaleDateString() : '—'; };
  const compact = value => isNumber(value) ? (Math.abs(value) >= 1e6 ? `${number(value / 1e6)}M` : Math.abs(value) >= 1e3 ? `${number(value / 1e3)}K` : number(value, 0)) : '—';
  let mounted = false, polling = null, status = null, refreshing = false, changing = false, revision = 0;
  let settingsView = null, activeBacktest = null;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response. Refresh to verify the current state.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (!data || typeof data !== 'object') throw new Error('Server response is incomplete.');
    return data;
  }
  function notice(message, error) { const el = $('cryNotice'); if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); } }
  function unavailable(el, label, error) { if (el) el.innerHTML = `<p class="cry-empty cry-unavailable">${esc(label)} unavailable: ${esc(error && error.message ? error.message : String(error || 'unknown error'))}</p>`; }

  // Every major threshold is configurable: score weights, entry thresholds,
  // scale-out ladder, stop/trailing math, position sizing, risk limits,
  // correlation caps, universe filters, and the two live switches.
  const RULE_SCHEMA = [
    { group: 'Score weights (%)', fields: [
      ['weightBreakoutQuality', 'Breakout quality (20)', 'number', 0.5], ['weightVolumeConfirmation', 'Volume confirmation (20)', 'number', 0.5],
      ['weightRelativeVolume', 'Relative volume (15)', 'number', 0.5], ['weightPriceStructure', 'Price structure (10)', 'number', 0.5],
      ['weightHtfTrend', 'Higher-timeframe trend (10)', 'number', 0.5], ['weightMomentum', 'Momentum (10)', 'number', 0.5],
      ['weightVwapEma', 'VWAP / EMA confirmation (5)', 'number', 0.5], ['weightLiquiditySpread', 'Liquidity / spread (5)', 'number', 0.5],
      ['weightMarketRegime', 'Market regime (5)', 'number', 0.5] ] },
    { group: 'Entry thresholds', fields: [
      ['minScore', 'Min breakout score (75)', 'number', 1], ['minScoreBearRegime', 'Min score — bearish BTC', 'number', 1],
      ['minRvol', 'Min RVOL (2.0)', 'number', 0.1], ['strongRvol', 'Strong RVOL (3.0)', 'number', 0.1],
      ['exceptionalRvol', 'Exceptional RVOL (4.0)', 'number', 0.1], ['requireCloseAboveResistance', 'Require close above resistance', 'checkbox'] ] },
    { group: 'Scale-out ladder (%)', fields: [
      ['scaleOut1TriggerPct', 'Tier 1 trigger % (+2)', 'number', 0.1], ['scaleOut1SizePct', 'Tier 1 size % (20)', 'number', 1],
      ['scaleOut2TriggerPct', 'Tier 2 trigger % (+4)', 'number', 0.1], ['scaleOut2SizePct', 'Tier 2 size % (20)', 'number', 1],
      ['scaleOut3TriggerPct', 'Tier 3 trigger % (+6)', 'number', 0.1], ['scaleOut3SizePct', 'Tier 3 size % (20)', 'number', 1] ] },
    { group: 'Stops & trailing', fields: [
      ['stopLossPct', 'Stop loss (%)', 'number', 0.1], ['atrMultiplier', 'Initial stop ATR multiplier', 'number', 0.1],
      ['trailingAtrMultiplier', 'Trailing stop ATR multiplier', 'number', 0.1], ['breakevenTriggerPct', 'Breakeven trigger (%)', 'number', 0.1],
      ['volumeFadeTightenPct', 'Tighten on volume fade (%)', 'number', 1] ] },
    { group: 'Position sizing', fields: [
      ['positionSizeUsd', 'Fixed size ($)', 'number', 10], ['positionSizePct', 'Size as % of account', 'number', 0.1],
      ['maxPositionSizePct', 'Max single position %', 'number', 0.1], ['maxTotalExposurePct', 'Max total portfolio exposure %', 'number', 1],
      ['maxPositions', 'Max open positions', 'number', 1] ] },
    { group: 'Risk limits', fields: [
      ['maxDailyLossPct', 'Max daily loss (%)', 'number', 0.1], ['maxConsecutiveLosses', 'Max consecutive losses', 'number', 1],
      ['maxTradesPerHour', 'Max trades / hour', 'number', 1], ['maxSpreadPct', 'Max spread (%)', 'number', 0.01],
      ['maxSlippagePct', 'Max slippage (%)', 'number', 0.01], ['maxCorrelatedExposurePct', 'Max correlated exposure %', 'number', 1] ] },
    { group: 'Universe', fields: [
      ['excludeStablecoins', 'Exclude stablecoins', 'checkbox'], ['includePaxg', 'Include PAXG', 'checkbox'],
      ['minLiquidityUsd', 'Min daily dollar volume ($)', 'number', 100000] ] },
    { group: 'Trading mode', fields: [
      ['tradingMode', 'Mode', 'select', ['PAPER', 'LIVE']],
      ['liveEnabled', 'Live switch 1 — enabled', 'checkbox'], ['liveConfirmed', 'Live switch 2 — confirmed', 'checkbox'] ] },
  ];

  function shell() {
    const page = $('page-crypto');
    if (!page || $('cryRoot')) return;
    page.innerHTML = `<section class="cry-shell" id="cryRoot" aria-labelledby="cryTitle">
      <header class="cry-hero"><div><span class="cry-eyebrow">24/7 AUTOMATED CRYPTO DESK</span><h1 id="cryTitle">Crypto Breakout Bot <em>find → confirm → enter → ride → trail</em></h1><p>Scans the full Alpaca crypto universe for confirmed breakouts, confirms with volume and RVOL, enters, scales out into strength, and trails the runner with a volatility-adjusted stop. Volume fade and momentum exhaustion tighten the exit.</p></div><span class="cry-auto-label">PAPER ONLY</span></header>
      <div class="cry-notice" id="cryNotice" role="status" aria-live="polite"></div>
      <section class="cry-status" aria-label="Crypto bot system status">
        <div><span>Connection</span><strong id="cryConnection">CHECKING</strong><small id="cryAccount">Paper account required</small></div>
        <div><span>Paper balance</span><strong id="cryBalance">—</strong><small id="cryBalanceNote">Simulated account</small></div>
        <div><span>Open positions</span><strong id="cryOpen">—</strong><small id="cryTodayPnl">Today&rsquo;s P&amp;L —</small></div>
        <div><span>BTC regime</span><strong id="cryRegime">—</strong><small id="cryRegimeNote">Market regime —</small></div>
      </section>
      <section class="cry-command"><div><span class="cry-eyebrow">BOT CONTROL</span><h2 id="cryMandate">Connect an account to begin</h2><p id="cryMandateCopy">Connect a dedicated Alpaca paper account. The scanner runs around the clock; entries are fully automatic in paper.</p><p id="cryBlockers" class="cry-blockers"></p></div><div class="cry-actions"><button class="cry-button cry-quiet" id="cryScannerToggle" disabled>Checking account</button><button class="cry-button cry-danger" id="cryEmergencyStop" disabled>Emergency stop</button></div></section>
      <section class="cry-layout"><main class="cry-main">
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">BTC REGIME</span><h2>Market</h2></div><span id="cryMarketMeta">Loading</span></div><div class="cry-perf"><div class="cry-perf-grid" id="cryMarketGrid"><div><span>Loading</span><strong>—</strong></div></div></div></article>
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">CONFIRMED + APPROACHING</span><h2>Breakout watchlist</h2></div><span id="cryWatchMeta">Loading</span></div><div class="cry-table-wrap"><table class="cry-table"><thead><tr><th>Symbol</th><th>Price</th><th>Breakout lvl</th><th>RVOL</th><th>Volume</th><th>RSI</th><th>MACD</th><th>VWAP</th><th>EMA structure</th><th>ATR</th><th>Score</th><th>Status</th></tr></thead><tbody id="cryWatchRows"><tr><td colspan="12" class="cry-empty">No watchlist data yet.</td></tr></tbody></table></div></article>
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">UNDER MANAGEMENT</span><h2>Active positions</h2></div><span id="cryPositionMeta">Loading</span></div><div class="cry-list" id="cryPositions"><p class="cry-empty">No data yet.</p></div></article>
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">CLOSED TRADES</span><h2>Trade history</h2></div><span id="cryTradeMeta">Loading</span></div><div class="cry-list" id="cryTrades"><p class="cry-empty">No data yet.</p></div></article>
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">VALIDATION</span><h2>Backtests</h2></div></div>
          <form class="cry-bt-form" id="cryBtForm"><label>Symbols (comma separated)<input id="cryBtSymbols" value="BTC,ETH,SOL" maxlength="240"></label><label>Days (7–365)<input id="cryBtDays" type="number" min="7" max="365" value="90"></label><button class="cry-button" type="submit" id="cryBtRun">Run backtest</button></form>
          <p class="cry-note">Backtests replay historical bars through the same detect → score pipeline the live scanner uses. No look-ahead: fills see only bars up to the current index.</p>
          <div class="cry-list" id="cryBacktests"><p class="cry-empty">No backtests yet.</p></div>
          <div id="cryBacktestDetail"></div>
        </article>
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">PAPER TRACK RECORD</span><h2>Paper stats</h2></div></div><div class="cry-perf" id="cryPerf"><p class="cry-empty">No data yet.</p></div></article>
      </main>
      <aside class="cry-rail">
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">DEDICATED BROKER</span><h2>Alpaca paper</h2></div></div><div class="cry-account-row"><div><b>Paper</b><small id="cryPaperState">Checking</small></div><button class="cry-button cry-quiet" id="cryPaperConnect">Connect</button></div><p class="cry-account-note">Crypto runs on its own dedicated Alpaca paper account — never shared with other bots or manual trading. Live trading is not available: live orders require <b>both</b> live switches and are refused loudly otherwise.</p></article>
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">FULL CONFIG</span><h2>Settings</h2></div></div><div id="crySettings"><p class="cry-empty">Loading settings…</p></div><button class="cry-button cry-save" id="crySave">Save settings</button></article>
        <article class="cry-panel"><div class="cry-head"><div><span class="cry-eyebrow">RISK DESK</span><h2>Alerts</h2></div></div><div class="cry-list" id="cryAlerts"><p class="cry-empty">No data yet.</p></div></article>
      </aside></section>
    </section>`;
  }

  function renderStatus() {
    if (!status) return;
    const connected = !!status.connected;
    $('cryConnection').textContent = connected ? 'PAPER CONNECTED' : 'DISCONNECTED';
    $('cryConnection').className = connected ? 'cry-good' : 'cry-bad';
    $('cryAccount').textContent = status.accountId ? `Account ${status.accountId}` : (status.blockers || []).join(' · ') || 'Dedicated crypto paper account required';
    $('cryBalance').textContent = money(status.paperBalance ?? status.equity);
    $('cryBalanceNote').textContent = isNumber(status.todayPnl) ? `Today ${money(status.todayPnl)}` : 'Simulated account';
    $('cryOpen').textContent = String(status.openPositions ?? '—');
    $('cryTodayPnl').textContent = `Today's P&L ${isNumber(status.todayPnl) ? money(status.todayPnl) : '—'}`;
    $('cryRegime').textContent = String(status.regime || status.btcRegime || '—').toUpperCase();
    $('cryRegimeNote').textContent = `BTC trend ${status.btcTrend || '—'}`;
    $('cryMandate').textContent = !connected ? 'Connect an account to begin' : !status.enabled ? 'Scanner is paused' : 'Scanning 24/7 — fully automatic in paper';
    $('cryMandateCopy').textContent = !connected ? 'Connect a dedicated Alpaca paper account. The scanner evaluates the whole eligible universe every cycle.' : status.ready ? 'Breakouts are detected, confirmed with volume, entered, scaled out, and trailed automatically.' : 'Existing positions remain under automatic management. New entries stay withheld until the server reports ready.';
    $('cryBlockers').textContent = (status.blockers || []).join(' · ');
    const toggle = $('cryScannerToggle');
    toggle.disabled = !connected || changing;
    toggle.textContent = !connected ? 'Connect Alpaca' : status.enabled ? 'Pause scanner' : 'Resume scanner';
    $('cryEmergencyStop').disabled = !connected || changing;
    $('cryPaperState').textContent = connected ? 'Connected' : 'Not connected';
    $('cryPaperConnect').textContent = connected ? 'Manage' : 'Connect';
  }

  function renderMarket(data) {
    const meta = $('cryMarketMeta'), grid = $('cryMarketGrid');
    const m = data?.market || data || {};
    const list = data?.opportunities || data?.watchlist || [];
    const breaking = list.filter(o => String(o.status).toLowerCase() === 'breaking_out').length;
    const approaching = list.filter(o => String(o.status).toLowerCase() === 'approaching').length;
    const bestRvol = list.reduce((a, b) => (isNumber(b.rvol) && (!a || b.rvol > a.rvol) ? b : a), null);
    const bestScore = list.reduce((a, b) => (isNumber(b.score) && (!a || b.score > a.score) ? b : a), null);
    meta.textContent = data ? `Updated ${time(data.updatedAt || data.asOf)}` : 'No data';
    const cell = (label, value) => `<div><span>${esc(label)}</span><strong>${value}</strong></div>`;
    grid.innerHTML =
      cell('BTC trend', esc(m.btcTrend ?? status?.btcTrend ?? '—')) +
      cell('Regime', esc(String(m.regime ?? status?.regime ?? status?.btcRegime ?? '—').toUpperCase())) +
      cell('Eligible assets', esc(m.eligibleAssets ?? data?.eligibleCount ?? '—')) +
      cell('Breaking out', String(breaking)) +
      cell('Approaching breakout', String(approaching)) +
      cell('Highest RVOL', bestRvol ? `${esc(bestRvol.symbol)} · ${rvol(bestRvol.rvol)}` : '—') +
      cell('Highest score', bestScore ? `${esc(bestScore.symbol)} · ${number(bestScore.score, 0)}` : '—') +
      cell('BTC price', money(m.btcPrice ?? status?.btcPrice));
  }

  function renderWatchlist(items) {
    const meta = $('cryWatchMeta'), body = $('cryWatchRows');
    meta.textContent = items?.length ? `${items.length} tracked` : 'Watchlist empty';
    if (!items?.length) { body.innerHTML = '<tr><td colspan="12" class="cry-empty">No opportunities — no data yet. The scanner ranks the whole eligible universe every cycle.</td></tr>'; return; }
    const badge = st => {
      const s = String(st || '').toLowerCase();
      if (s === 'breaking_out') return '<span class="cry-decision good">BREAKING OUT</span>';
      if (s === 'approaching') return '<span class="cry-decision wait">APPROACHING</span>';
      if (s === 'retest') return '<span class="cry-decision wait">RETEST</span>';
      return `<span class="cry-decision">${esc(st || '—').toUpperCase().replace(/_/g, ' ')}</span>`;
    };
    body.innerHTML = items.slice(0, 150).map(o => `<tr>
      <td><b>${esc(o.symbol)}</b></td><td>${money(o.price)}</td><td>${money(o.breakoutLevel ?? o.resistance)}</td>
      <td>${rvol(o.rvol)}</td><td>${compact(o.volume)}</td><td>${isNumber(o.rsi) ? number(o.rsi, 1) : '—'}</td>
      <td>${o.macd == null ? '—' : esc(typeof o.macd === 'object' ? `${number(o.macd.macd ?? o.macd.value)} / ${number(o.macd.signal)}` : number(o.macd))}</td>
      <td>${money(o.vwap)}</td><td>${esc(o.emaStructure || (isNumber(o.ema9) && isNumber(o.ema20) && isNumber(o.ema50) ? `${o.ema9 > o.ema20 && o.ema20 > o.ema50 ? '9>20>50' : 'mixed'}` : '—'))}</td>
      <td>${money(o.atr)}</td><td>${isNumber(o.score) ? number(o.score, 0) : '—'}</td><td>${badge(o.status)}</td>
    </tr>`).join('');
  }

  function renderPositions(items) {
    const el = $('cryPositions');
    $('cryPositionMeta').textContent = items?.length ? `${items.length} open` : 'Flat';
    if (!items?.length) { el.innerHTML = '<p class="cry-empty">No open positions — no data yet.</p>'; return; }
    el.innerHTML = items.map(p => {
      const pnl = p.unrealizedPnl ?? p.pnl, pnlClass = isNumber(pnl) ? (pnl >= 0 ? 'cry-good' : 'cry-bad') : '';
      return `<div class="cry-row"><div><b>${esc(p.symbol)}</b> <span class="cry-tag">${esc(p.setup || p.pattern || '')}</span> <span class="cry-tag">${esc(p.exitStatus || p.status || 'open')}</span>
        <small>${number(p.qty, 4)} @ ${money(p.entryPrice ?? p.entry)} → ${money(p.currentPrice ?? p.current)} · stop ${money(p.stop)}${p.trailingStop != null ? ` · trail ${money(p.trailingStop)}` : ''}</small>
        <small>RVOL ${rvol(p.rvol)} · vol ${compact(p.volume)} · ${isNumber(p.profitPct) ? pct(p.profitPct) : '—'} · setup score ${isNumber(p.setupScore ?? p.score) ? number(p.setupScore ?? p.score, 0) : '—'}</small></div>
        <strong class="${pnlClass}">${isNumber(pnl) ? money(pnl) : '—'}</strong></div>`;
    }).join('');
  }

  function renderTrades(items) {
    const el = $('cryTrades');
    $('cryTradeMeta').textContent = items?.length ? `${items.length} records` : 'No records';
    if (!items?.length) { el.innerHTML = '<p class="cry-empty">No trades recorded — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 60).map(t => {
      const cls = isNumber(t.pnl) ? (t.pnl >= 0 ? 'cry-good' : 'cry-bad') : '';
      const dur = t.durationSec != null ? `${Math.round(Number(t.durationSec) / 3600 * 10) / 10}h` : (t.duration || '—');
      return `<div class="cry-row"><div><b>${esc(t.symbol || '—')}</b> <span class="cry-tag">${esc(t.exitReason || t.status || '')}</span>
        <small>${money(t.entryPrice ?? t.entry)} → ${money(t.exitPrice ?? t.exit)} · ${isNumber(t.returnPct) ? pct(t.returnPct) : '—'} · ${esc(String(dur))} · MFE ${money(t.mfe ?? t.maxFavorableExcursion)} · MAE ${money(t.mae ?? t.maxAdverseExcursion)}</small></div>
        <strong class="${cls}">${isNumber(t.pnl) ? money(t.pnl) : '—'}</strong></div>`;
    }).join('');
  }

  function renderAlerts(items) {
    const el = $('cryAlerts');
    if (!items?.length) { el.innerHTML = '<p class="cry-empty">No alerts — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 30).map(a => `<div class="cry-row"><div><b>${esc(a.kind || a.type || 'alert')}</b><small>${esc(a.message)}</small></div><strong>${time(a.createdAt || a.created_at)}</strong></div>`).join('');
  }

  function renderPerf(payload) {
    const el = $('cryPerf');
    const s = payload?.stats || payload || {};
    const trades = payload?.trades || [];
    const closed = trades.filter(t => isNumber(t.pnl));
    if (!closed.length && !isNumber(s.totalTrades)) { el.innerHTML = '<p class="cry-empty">No closed trades — no data yet.</p>'; return; }
    const wins = closed.filter(t => t.pnl > 0);
    const grossWin = closed.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(closed.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
    const winRate = s.winRate ?? (closed.length ? wins.length / closed.length : null);
    const profitFactor = s.profitFactor ?? (grossLoss > 0 ? grossWin / grossLoss : null);
    const totalPnl = s.totalPnl ?? closed.reduce((a, t) => a + t.pnl, 0);
    const cell = (label, value, cls) => `<div><span>${esc(label)}</span><strong class="${cls || ''}">${value}</strong></div>`;
    el.innerHTML = `<div class="cry-perf-grid">
      ${cell('Paper balance', money(s.paperBalance ?? status?.paperBalance ?? status?.equity))}
      ${cell('Total P&L', money(totalPnl), totalPnl >= 0 ? 'cry-good' : 'cry-bad')}
      ${cell('Win rate', isNumber(winRate) ? pct(Number(winRate) * (Number(winRate) <= 1 ? 100 : 1)) : '—')}
      ${cell('Profit factor', isNumber(profitFactor) ? number(profitFactor) : '—')}
      ${cell('Max drawdown', isNumber(s.maxDrawdown) ? pct(s.maxDrawdown) : '—')}
      ${cell('Trades', s.totalTrades ?? closed.length)}
      ${cell('Winners', wins.length, 'cry-good')}
      ${cell('Losers', closed.length - wins.length, 'cry-bad')}
    </div>`;
  }

  function renderSettings() {
    const el = $('crySettings');
    const rules = settingsView?.settings || settingsView?.rules;
    if (!rules) { el.innerHTML = '<p class="cry-empty">Settings unavailable.</p>'; return; }
    const field = (key, label, type, stepOrOptions) => {
      const value = rules[key];
      const id = `cryRule_${key}`;
      if (type === 'checkbox') return `<label class="cry-field cry-check" for="${id}"><input id="${id}" type="checkbox" data-rule="${key}" ${value ? 'checked' : ''}><span>${esc(label)}</span></label>`;
      if (type === 'select') return `<label class="cry-field" for="${id}"><span>${esc(label)}</span><select id="${id}" data-rule="${key}">${stepOrOptions.map(o => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      return `<label class="cry-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="number" step="${stepOrOptions}" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
    };
    el.innerHTML = RULE_SCHEMA.map(group => `
      <fieldset class="cry-fieldset"><legend>${esc(group.group)}</legend>
      ${group.fields.map(([key, label, type, extra]) => field(key, label, type, extra)).join('')}
      </fieldset>`).join('') + `
      <p class="cry-note">Live orders require <b>both</b> live switches; anything less is refused loudly. The scale-out ladder fires partial profits at each configured trigger; the remainder trails on the volatility-adjusted stop.</p>`;
  }

  function renderBacktests(items) {
    const el = $('cryBacktests');
    if (!items?.length) { el.innerHTML = '<p class="cry-empty">No backtests yet.</p>'; return; }
    el.innerHTML = items.map(b => `<div class="cry-row"><div><b>${esc(String(b.backtestId || b.id).slice(0, 8))}…</b>
      <small>${esc(((b.params || {}).symbols || b.symbols || []).join(', '))} · ${esc((b.params || {}).days ?? b.days)}d · ${time(b.createdAt)}</small></div>
      <button class="cry-button cry-quiet" data-bt="${esc(b.backtestId || b.id)}">View</button></div>`).join('');
    el.querySelectorAll('[data-bt]').forEach(btn => btn.onclick = () => viewBacktest(btn.dataset.bt));
  }

  function renderBacktestDetail(detail) {
    const el = $('cryBacktestDetail');
    if (!detail) { el.innerHTML = ''; return; }
    const r = detail.report || {};
    const pct4 = v => isNumber(v) ? `${number(v * 100)}%` : '—';
    el.innerHTML = `<div class="cry-bt-detail"><h3>Backtest ${esc(String(detail.backtestId || detail.id || '').slice(0, 8))}…</h3>
      <div class="cry-perf-grid">
        <div><span>Trades</span><strong>${r.totalTrades ?? '—'}</strong></div>
        <div><span>Win rate</span><strong>${pct4(r.winRate)}</strong></div>
        <div><span>Profit factor</span><strong>${isNumber(r.profitFactor) ? number(r.profitFactor) : '—'}</strong></div>
        <div><span>Total return</span><strong>${pct4(r.totalReturn)}</strong></div>
        <div><span>Max drawdown</span><strong>${pct4(r.maxDrawdown)}</strong></div>
        <div><span>Avg R</span><strong>${isNumber(r.avgR) ? number(r.avgR) + 'R' : '—'}</strong></div>
      </div>
      <h4>Trades (${(detail.trades || []).length})</h4><div class="cry-list">
      ${(detail.trades || []).slice(0, 50).map(t => `<div class="cry-row"><div><b>${esc(t.symbol || '—')}</b> <span class="cry-tag">${esc(t.exitReason || '')}</span><small>${esc(t.date || '')} · ${isNumber(t.returnPct) ? pct(t.returnPct) : ''}</small></div><strong class="${isNumber(t.pnl) ? (t.pnl >= 0 ? 'cry-good' : 'cry-bad') : ''}">${isNumber(t.pnl) ? money(t.pnl) : '—'}</strong></div>`).join('') || '<p class="cry-empty">No data yet.</p>'}
      </div></div>`;
  }

  async function toggleScanner() {
    if (changing || !status?.connected) { if (!status?.connected) connectionModal(); return; }
    changing = true; revision++;
    try {
      status = await api('/api/crypto/settings', { method: 'PUT', body: JSON.stringify({ enabled: !status.enabled }) });
      settingsView = await api('/api/crypto/settings');
      renderStatus(); renderSettings();
      notice(status.enabled ? 'Scanner resumed — the 24/7 cycle is running.' : 'Scanner paused. Existing positions remain under automatic management.');
    } catch (error) { notice(`Scanner toggle failed: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }

  async function emergencyStop() {
    if (changing || !status?.connected) return;
    if (!window.confirm('EMERGENCY STOP: halt new entries and flatten all crypto positions now?')) return;
    changing = true; revision++;
    try {
      const result = await api('/api/crypto/emergency-stop', { method: 'POST' });
      notice(result.message || 'Emergency stop engaged: new entries halted, positions flattened.');
      await refresh();
    } catch (error) { notice(`Emergency stop failed: ${error.message}`, true); }
    finally { changing = false; }
  }

  async function saveSettings() {
    if (changing) return;
    const rules = {};
    document.querySelectorAll('#crySettings [data-rule]').forEach(input => {
      const key = input.dataset.rule;
      if (input.type === 'checkbox') rules[key] = input.checked;
      else if (input.tagName === 'SELECT') rules[key] = input.value;
      else if (input.value !== '') rules[key] = Number(input.value);
    });
    changing = true; revision++;
    try {
      status = await api('/api/crypto/settings', { method: 'PUT', body: JSON.stringify({ rules }) });
      settingsView = await api('/api/crypto/settings');
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
      const symbols = $('cryBtSymbols').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);
      const days = Math.min(Math.max(Number($('cryBtDays').value) || 90, 7), 365);
      notice('Running backtest — this can take a minute on long histories…');
      const result = await api('/api/crypto/backtest', { method: 'POST', body: JSON.stringify({ symbols, days }) });
      notice(`Backtest complete: ${result.report?.totalTrades ?? 0} trades.`);
      if (result.backtestId) viewBacktest(result.backtestId);
      renderBacktestDetail(result.report ? { backtestId: result.backtestId, report: result.report, trades: result.trades } : null);
    } catch (error) { notice(`Backtest failed: ${error.message}`, true); }
    finally { changing = false; }
  }
  async function viewBacktest(id) {
    try { activeBacktest = await api(`/api/crypto/backtest/${encodeURIComponent(id)}`); renderBacktestDetail(activeBacktest); }
    catch (error) { notice(`Backtest unavailable: ${error.message}`, true); }
  }

  function connectionModal() {
    if (changing) return;
    const old = $('cryModal'); if (old) old.remove();
    const previousFocus = document.activeElement;
    // Keys go straight into the connect request body and are never stored,
    // logged, or kept in any client-side variable beyond the fetch.
    document.body.insertAdjacentHTML('beforeend', `<div class="cry-modal" id="cryModal" role="dialog" aria-modal="true" aria-labelledby="cryModalTitle"><form class="cry-modal-card" id="cryForm"><button type="button" class="cry-close" id="cryClose" aria-label="Close">×</button><div class="cry-modal-scroll"><span class="cry-eyebrow">CRYPTO DEDICATED CONNECTION</span><h2 id="cryModalTitle">Connect Alpaca Paper</h2><p>Use a dedicated paper account, separate from other bots and manual trading. Keys are sent to the server once and are never stored in the browser. Paper only; live trading is not available.</p><label>API key<input id="cryKey" required autocomplete="off"></label><label>API secret<input id="crySecret" type="password" required autocomplete="off"></label><p id="cryFormError" class="cry-form-error" role="alert"></p></div><div class="cry-modal-actions"><button type="submit" class="cry-button" id="crySubmit">Connect Paper</button><button type="button" class="cry-button cry-quiet" id="cryDisconnect">Disconnect</button></div></form></div>`);
    const close = () => { if (changing) return; $('cryModal')?.remove(); previousFocus?.focus(); };
    $('cryClose').onclick = close;
    $('cryModal').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    $('cryForm').onsubmit = async event => {
      event.preventDefault();
      if (changing) return;
      changing = true; revision++;
      $('cryModal').querySelectorAll('button,input').forEach(control => { control.disabled = true; });
      try {
        status = await api('/api/crypto/connect', { method: 'POST', body: JSON.stringify({ key: $('cryKey').value, secret: $('crySecret').value }) });
        $('cryKey').value = ''; $('crySecret').value = '';
        settingsView = await api('/api/crypto/settings');
        close(); renderStatus(); renderSettings();
        notice('Paper connected — the 24/7 breakout scanner is running.');
        refresh();
      } catch (error) { $('cryFormError').textContent = `Connection blocked: ${error.message}`; }
      finally { changing = false; $('cryModal')?.querySelectorAll('button,input').forEach(control => { control.disabled = false; }); renderStatus(); }
    };
    $('cryDisconnect').onclick = async () => {
      if (!window.confirm('Disconnect the Crypto paper account? Blocked while positions remain open.')) return;
      if (changing) return;
      changing = true; revision++;
      try { status = await api('/api/crypto/disconnect', { method: 'POST' }); close(); renderStatus(); notice('Crypto disconnected.'); refresh(); }
      catch (error) { $('cryFormError').textContent = `Disconnect blocked: ${error.message}`; }
      finally { changing = false; renderStatus(); }
    };
    $('cryClose').focus();
  }

  async function refresh() {
    if (!mounted || refreshing || changing) return;
    refreshing = true;
    const startedRevision = revision;
    const results = await Promise.allSettled([
      api('/api/crypto/status'), api('/api/crypto/universe'), api('/api/crypto/opportunities'),
      api('/api/crypto/positions'), api('/api/crypto/trades'), api('/api/crypto/alerts'),
    ]);
    refreshing = false;
    if (!mounted || startedRevision !== revision) return;
    const get = i => results[i].status === 'fulfilled' ? results[i].value : null;
    const fail = i => results[i].status === 'rejected' ? results[i].reason.message : null;
    if (get(0)) { status = get(0); renderStatus(); } else notice(`Status unavailable: ${fail(0)}`, true);
    if (get(1) || get(2)) {
      renderMarket({ market: get(1)?.market || get(0)?.market, opportunities: get(2)?.opportunities || get(2)?.watchlist, eligibleCount: get(1)?.eligibleCount ?? get(1)?.assets?.length, updatedAt: get(2)?.asOf || get(1)?.asOf });
    } else $('cryMarketGrid').innerHTML = `<div><span>Market unavailable</span><strong>${esc(fail(1) || fail(2))}</strong></div>`;
    if (get(2)) renderWatchlist(get(2).opportunities || get(2).watchlist); else $('cryWatchRows').innerHTML = `<tr><td colspan="12" class="cry-empty cry-unavailable">Watchlist unavailable: ${esc(fail(2))}</td></tr>`;
    if (get(3)) renderPositions(get(3).positions); else unavailable($('cryPositions'), 'Positions', fail(3));
    if (get(4)) { renderTrades(get(4).trades); renderPerf({ stats: get(4).stats || get(0)?.stats, trades: get(4).trades }); }
    else { unavailable($('cryTrades'), 'Trades', fail(4)); renderPerf(null); }
    if (get(5)) renderAlerts(get(5).alerts); else unavailable($('cryAlerts'), 'Alerts', fail(5));
    if (!settingsView) { try { settingsView = await api('/api/crypto/settings'); renderSettings(); } catch (_) { /* settings panel keeps its empty state */ } }
  }

  async function open() {
    shell(); mounted = true;
    $('cryPaperConnect').onclick = connectionModal;
    $('cryScannerToggle').onclick = toggleScanner;
    $('cryEmergencyStop').onclick = emergencyStop;
    $('crySave').onclick = saveSettings;
    $('cryBtForm').onsubmit = runBacktest;
    try { settingsView = await api('/api/crypto/settings'); renderSettings(); } catch (_) {}
    await refresh(); if (!mounted) return; clearInterval(polling); polling = setInterval(refresh, 30000);
  }
  function pause() { mounted = false; clearInterval(polling); polling = null; }
  window.cryptoBot = { open, pause };
}());
