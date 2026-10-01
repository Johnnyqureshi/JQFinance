/* ORB Bot — "Opening Range Breakout" trading controls.
 * The bot measures the opening range (5/15/30 min), waits for the range to
 * complete, and only enters a breakout when score, volume/RVOL, regime,
 * relative strength, VWAP, level clearance, and risk/reward ALL agree.
 * PAPER is the default; live orders require all three live gates
 * (tradingMode=LIVE + both live switches) and are refused loudly otherwise.
 * Reuses the shared warrior skin classes (war-*) — warrior.css is global.
 * ORB-specific layout lives in css/orb.css; everything renders real API
 * data and empty states say "no data yet" — no invented numbers.
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
  let settingsView = null, activeBacktest = null, journalTab = 'trades', selectedSymbol = null, lastDashboard = null;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response. Refresh to verify the current state.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (!data || typeof data !== 'object') throw new Error('Server response is incomplete.');
    return data;
  }
  function notice(message, error) { const el = $('orbNotice'); if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); } }

  /* Every DEFAULT_ORB_RULES key, grouped for the settings form. */
  const RULE_SCHEMA = [
    { group: 'Opening Range', fields: [
      ['orMinutes', 'Opening range duration (min)', 'select', [5, 15, 30]] ] },
    { group: 'Entry Windows', fields: [
      ['entryWindowStart', 'Entry window start (ET)', 'time'],
      ['entryWindowEnd', 'Entry window end (ET)', 'time'],
      ['secondWindowEnabled', 'Enable second (afternoon) window', 'checkbox'],
      ['secondWindowStart', 'Second window start (ET)', 'time'],
      ['secondWindowEnd', 'Second window end (ET)', 'time'] ] },
    { group: 'Scoring & Filters', fields: [
      ['minScore', 'Minimum score to enter', 'number', 1],
      ['weights.regime', 'Weight — Regime', 'number', 1],
      ['weights.volume', 'Weight — Volume / RVOL', 'number', 1],
      ['weights.relStrength', 'Weight — Relative strength', 'number', 1],
      ['weights.vwap', 'Weight — VWAP', 'number', 1],
      ['weights.breakoutQuality', 'Weight — Breakout quality', 'number', 1],
      ['weights.levelClearance', 'Weight — Level clearance', 'number', 1],
      ['weights.trendAlign', 'Weight — Trend alignment', 'number', 1],
      ['weights.volatility', 'Weight — Volatility / ATR', 'number', 1],
      ['weights.premarket', 'Weight — Premarket structure', 'number', 1],
      ['minRvol', 'Min RVOL', 'number', 0.1],
      ['preferredRvol', 'Preferred RVOL', 'number', 0.1],
      ['strongRvol', 'Strong RVOL', 'number', 0.1],
      ['minRR', 'Min risk/reward (R)', 'number', 0.5],
      ['minLevelClearancePct', 'Min clearance to next level (%)', 'number', 0.1],
      ['maxWickPct', 'Max candle wick (%)', 'number', 0.05],
      ['maxExtensionAtrs', 'Max extension (ATRs)', 'number', 0.1],
      ['requireVwapAgree', 'Require VWAP agreement', 'checkbox'] ] },
    { group: 'Direction & Entry', fields: [
      ['allowLong', 'Allow longs', 'checkbox'],
      ['allowShort', 'Allow shorts', 'checkbox'],
      ['entryMode', 'Entry mode', 'select', ['breakout', 'retest', 'either']],
      ['maxAttemptsPerSymbol', 'Max attempts per symbol', 'number', 1],
      ['cooldownMinutes', 'Re-entry cooldown (min)', 'number', 1] ] },
    { group: 'Sizing', fields: [
      ['sizingMode', 'Sizing mode', 'select', ['fixed_dollars', 'fixed_shares', 'acct_pct', 'risk_pct']],
      ['fixedDollars', 'Fixed dollars per trade ($)', 'number', 100],
      ['fixedShares', 'Fixed shares per trade', 'number', 10],
      ['acctPct', 'Account % per trade', 'number', 0.1],
      ['riskPct', 'Risk % per trade', 'number', 0.1] ] },
    { group: 'Stops', fields: [
      ['stopMode', 'Stop mode', 'select', ['fixed_pct', 'atr', 'opposite_or_side', 'breakout_level', 'retest_extreme', 'dollar_risk']],
      ['stopPct', 'Fixed stop (%)', 'number', 0.1],
      ['atrStopMult', 'ATR stop multiplier', 'number', 0.1],
      ['dollarRisk', 'Dollar risk per trade ($)', 'number', 1] ] },
    { group: 'Targets & Management', fields: [
      ['targets', 'Targets (e.g. 1R,2R)', 'text'],
      ['breakevenR', 'Move stop to breakeven at (R)', 'number', 0.5],
      ['trailMode', 'Trailing mode', 'select', ['none', 'atr', 'vwap']],
      ['orWidthTargets', 'Use OR-width targets (1×/2×)', 'checkbox'] ] },
    { group: 'Daily Locks', fields: [
      ['maxPositions', 'Max open positions', 'number', 1],
      ['maxDailyLossDollars', 'Max daily loss ($)', 'number', 50],
      ['maxTradesPerDay', 'Max trades per day', 'number', 1],
      ['maxConsecLosses', 'Max consecutive losses', 'number', 1],
      ['maxExposureDollars', 'Max total exposure ($)', 'number', 100],
      ['maxTradesPerSymbol', 'Max trades per symbol/day', 'number', 1] ] },
    { group: 'Universe & Liquidity', fields: [
      ['watchlist', 'Fixed watchlist — comma-separated (overrides universe; price band ignored for these)', 'watchlist'],
      ['minPrice', 'Min price ($)', 'number', 0.1],
      ['maxPrice', 'Max price ($)', 'number', 1],
      ['minAvgVolume', 'Min avg daily volume (shares)', 'number', 100000],
      ['maxSpreadPct', 'Max bid/ask spread (%)', 'number', 0.05] ] },
    { group: 'News Policy', fields: [
      ['newsPolicy', 'News policy', 'select', ['block', 'reduce', 'allow']] ] },
    { group: 'Trading Mode', fields: [
      ['tradingMode', 'Mode', 'select', ['PAPER', 'LIVE']],
      ['liveEnabled', 'Live switch 1 — enabled', 'checkbox'],
      ['liveConfirmed', 'Live switch 2 — confirmed', 'checkbox'] ] },
  ];
  const WEIGHT_KEYS = ['weights.regime', 'weights.volume', 'weights.relStrength', 'weights.vwap', 'weights.breakoutQuality', 'weights.levelClearance', 'weights.trendAlign', 'weights.volatility', 'weights.premarket'];
  const WEIGHT_LABELS = { 'weights.regime': 'Regime', 'weights.volume': 'Volume / RVOL', 'weights.relStrength': 'Relative strength', 'weights.vwap': 'VWAP', 'weights.breakoutQuality': 'Breakout quality', 'weights.levelClearance': 'Level clearance', 'weights.trendAlign': 'Trend alignment', 'weights.volatility': 'Volatility / ATR', 'weights.premarket': 'Premarket structure' };

  const dirLabel = d => String(d || '—').toUpperCase();
  const dirClass = d => { const s = String(d || '').toLowerCase(); return s === 'long' ? 'war-good' : s === 'short' ? 'war-bad' : ''; };
  function regimeClass(r) {
    const s = String(r || '').toLowerCase();
    if (s.includes('bull')) return 'war-good';
    if (s.includes('bear')) return 'war-bad';
    if (s.includes('volat')) return 'orb-regime-vol';
    return '';
  }
  function regimeText(r) {
    if (r == null || r === '') return '—';
    if (typeof r === 'object') return String(pick(r, 'label', 'regime', 'state') || '—');
    return String(r).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  function indexQuote(q) {
    const price = isNumber(q) ? Number(q) : Number(pick(q, 'price', 'close', 'value'));
    const chg = isNumber(q) ? null : pick(q, 'changePct', 'change_pct', 'change');
    if (!isNumber(price) && chg == null) return null;
    return { price: isNumber(price) ? price : null, changePct: isNumber(chg) ? Number(chg) : null };
  }

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
    const page = $('page-orb');
    if (!page || $('orbRoot')) return;
    page.innerHTML = `<section class="war-shell" id="orbRoot" aria-labelledby="orbTitle">
      <header class="war-hero"><div><span class="war-eyebrow">OPENING RANGE BREAKOUT</span><h1 id="orbTitle">ORB Bot <em>wait for the range</em></h1><p>Measures the opening range (5/15/30 min), waits for it to complete, and only enters a breakout when score, volume/RVOL, regime, relative strength, VWAP, level clearance, and risk/reward all agree. No range completion, no trade.</p></div><span class="war-auto-label" id="orbModeBadge">PAPER ONLY</span></header>
      <div class="war-notice" id="orbNotice" role="status" aria-live="polite"></div>
      <section class="war-status" aria-label="ORB system status">
        <div><span>Status</span><strong id="orbPill">CHECKING</strong><small id="orbTradeDate">Trade date —</small></div>
        <div><span>Connection</span><strong id="orbConnection">CHECKING</strong><small id="orbAccount">Dedicated account required</small></div>
        <div><span>Open positions</span><strong id="orbOpen">—</strong><small id="orbDayPnl">Day P&amp;L —</small></div>
        <div><span>Scheduler</span><strong id="orbScheduler">—</strong><small id="orbSchedulerNote">Server-owned cycle</small></div>
      </section>
      <section class="war-command"><div><span class="war-eyebrow">BOT CONTROL</span><h2 id="orbMandate">Connect an account to begin</h2><p id="orbMandateCopy">Connect a dedicated Alpaca paper account. Trading starts disabled — you enable it.</p><p id="orbBlockers" class="war-blockers"></p></div><button class="war-button war-quiet" id="orbEnabledToggle" disabled>Checking account</button></section>
      <section class="war-layout"><main class="war-main">
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">MARKET REGIME</span><h2>Regime &amp; tape</h2></div><span id="orbRegimeMeta">Loading</span></div><div id="orbRegime"></div></article>
        <article class="war-panel orb-why-panel"><div class="war-head"><div><span class="war-eyebrow">WHY THIS TRADE?</span><h2>Explainer</h2></div><span id="orbWhyMeta">No selection</span></div><div id="orbWhy"><p class="war-empty">No candidate selected — no data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">CANDIDATES</span><h2>Top setups</h2></div><span id="orbCandidateMeta">Loading</span></div><div class="war-list" id="orbCandidates"><p class="war-empty">Loading candidates…</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">UNDER MANAGEMENT</span><h2>Positions</h2></div><span id="orbPositionMeta">Loading</span></div><div class="war-list" id="orbPositions"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">TRADE JOURNAL</span><h2>Journal</h2></div><div class="orb-tabs" role="tablist"><button type="button" class="orb-tab is-active" id="orbTabTrades" role="tab">Trades</button><button type="button" class="orb-tab" id="orbTabRejected" role="tab">Rejected setups</button></div></div><div class="war-table-wrap" id="orbJournal"><p class="war-empty" style="padding:13px 18px">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">VALIDATION</span><h2>Backtests</h2></div></div>
          <form class="war-bt-form" id="orbBtForm">
            <label>From<input id="orbBtStart" type="date"></label>
            <label>To<input id="orbBtEnd" type="date"></label>
            <button class="war-button" type="submit" id="orbBtRun">Run backtest</button>
          </form>
          <p class="war-note">Point-in-time backtests: the opening range and all signals are computed only from bars strictly before each bar — no future data, no repainted signals. Runs with your current settings. Fills and costs follow the engine's fill model; positions flatten at EOD.</p>
          <div class="war-list" id="orbBacktests"><p class="war-empty">No backtests yet.</p></div>
          <div id="orbBacktestDetail"></div>
        </article>
      </main>
      <aside class="war-rail">
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">DEDICATED BROKER</span><h2>Alpaca paper</h2></div></div><div class="war-account-row"><div><b>Paper</b><small id="orbPaperState">Checking</small></div><button class="war-button war-quiet" id="orbPaperConnect">Connect</button></div><p class="war-account-note">ORB runs on its own dedicated Alpaca paper account — never shared with other bots or manual trading. Key and secret are never displayed back. Paper is the default; live connect is refused loudly without all three live gates.</p></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">DAY STATE &amp; LOCKS</span><h2>Daily risk</h2></div></div><div class="war-list" id="orbLocks"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">UNIVERSE</span><h2>Watching</h2></div><span id="orbUniverseMeta">—</span></div><div class="war-list" id="orbUniverse"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">FULL CONFIG</span><h2>Settings</h2></div></div><div id="orbSettings"><p class="war-empty">Loading settings…</p></div><button class="war-button war-save" id="orbSave">Save settings</button></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">RISK DESK</span><h2>Alerts</h2></div></div><div class="war-list" id="orbAlerts"><p class="war-empty">No data yet.</p></div></article>
      </aside></section>
    </section>`;
    const today = new Date();
    const iso = d => d.toISOString().slice(0, 10);
    const to = $('orbBtEnd'); const from = $('orbBtStart');
    to.value = iso(today);
    const past = new Date(today); past.setDate(past.getDate() - 90);
    from.value = iso(past);
  }

  function renderStatus(tradeDate) {
    if (!status) return;
    const connected = !!status.connected;
    const [pillText, pillClass] = pillState();
    $('orbPill').textContent = pillText;
    $('orbPill').className = pillClass;
    $('orbModeBadge').textContent = `${String(status.mode || 'PAPER').toUpperCase()} ONLY`;
    $('orbTradeDate').textContent = tradeDate ? `Trade date ${esc(tradeDate)}` : 'Trade date —';
    $('orbConnection').textContent = connected ? 'PAPER CONNECTED' : 'DISCONNECTED';
    $('orbConnection').className = connected ? 'war-good' : 'war-bad';
    $('orbAccount').textContent = status.accountId ? `Account ${status.accountId}` : 'Dedicated ORB account required';
    $('orbScheduler').textContent = String(status.schedulerStatus || 'IDLE').toUpperCase();
    $('orbSchedulerNote').textContent = status.schedulerReason || (status.lastCycleAt ? `Last cycle ${time(status.lastCycleAt)}` : 'No completed cycle yet');
    $('orbMandate').textContent = !connected ? 'Connect an account to begin' : !status.enabled ? 'Trading is paused' : 'Watching the opening range';
    $('orbMandateCopy').textContent = !connected
      ? 'Connect a dedicated Alpaca paper account. ORB ships disabled — enable trading when you are ready.'
      : status.enabled
        ? 'The server measures the opening range after the 9:30 ET open and enters breakouts only when every gate agrees.'
        : 'Trading is paused. Existing positions remain under automatic management. New entries stay withheld until you resume.';
    $('orbBlockers').textContent = (status.blockers || []).join(' · ');
    const toggle = $('orbEnabledToggle');
    toggle.disabled = !connected || changing;
    toggle.textContent = !connected ? 'Connect Alpaca' : status.enabled ? 'Pause trading' : 'Resume trading';
    $('orbPaperState').textContent = connected ? 'Connected' : 'Not connected';
    $('orbPaperConnect').textContent = connected ? 'Manage' : 'Connect';
  }

  /* ---- Dashboard ---- */

  function renderRegime(data) {
    const el = $('orbRegime');
    if (!data) { el.innerHTML = '<p class="war-empty">Regime data unavailable — no data yet.</p>'; $('orbRegimeMeta').textContent = 'No data yet'; return; }
    const regime = pick(data, 'regime');
    const spy = indexQuote(pick(data, 'spy', 'SPY'));
    const qqq = indexQuote(pick(data, 'qqq', 'QQQ'));
    const vix = indexQuote(pick(data, 'vix', 'VIX'));
    const tape = (label, q) => {
      if (!q) return `<div><span>${esc(label)}</span><strong>—</strong><small>no data yet</small></div>`;
      const chg = q.changePct == null ? '' : `<small class="${q.changePct >= 0 ? 'war-good' : 'war-bad'}">${q.changePct >= 0 ? '+' : ''}${number(q.changePct)}%</small>`;
      return `<div><span>${esc(label)}</span><strong>${q.price == null ? '—' : money(q.price)}</strong>${chg}</div>`;
    };
    $('orbRegimeMeta').textContent = pick(data, 'tradeDate', 'trade_date') ? `Trade date ${esc(pick(data, 'tradeDate', 'trade_date'))}` : 'Live tape';
    el.innerHTML = `<div class="orb-regime ${regimeClass(regime)}"><span class="war-eyebrow">REGIME</span><strong>${esc(regimeText(regime))}</strong></div>
      <div class="orb-tape">${tape('SPY', spy)}${tape('QQQ', qqq)}${tape('VIX', vix)}</div>`;
  }

  function targetsText(item) {
    const t = pick(item, 'targets', 'targetPrices', 'target_prices');
    if (Array.isArray(t)) {
      const parts = t.map(x => (x && typeof x === 'object' ? money(pick(x, 'price')) : money(x))).filter(s => s !== '—');
      return parts.length ? parts.join(' → ') : '—';
    }
    if (t != null && t !== '') return esc(String(t));
    const t1 = pick(item, 'target1', 'target_1'), t2 = pick(item, 'target2', 'target_2');
    const parts = [money(t1), money(t2)].filter(s => s !== '—');
    return parts.length ? parts.join(' → ') : '—';
  }
  function stopText(item) {
    const stop = pick(item, 'stop', 'stopPrice', 'stop_price');
    const mode = pick(item, 'stopMode', 'stop_mode');
    return `${money(stop)}${mode ? ` <small>(${esc(String(mode).replace(/_/g, ' '))})</small>` : ''}`;
  }

  /* One shared card for a position or a candidate: OR, price, VWAP, RVOL,
   * relative strength, score, entry/stop/targets, risk, size, P&L, status. */
  function tradeCard(item, kind) {
    const symbol = pick(item, 'symbol', 'ticker') || '—';
    const dir = pick(item, 'direction');
    const orHigh = pick(item, 'orHigh', 'or_high'), orLow = pick(item, 'orLow', 'or_low');
    const orWidth = pick(item, 'orWidth', 'or_width');
    const orWidthPct = pick(item, 'orWidthPct', 'or_width_pct');
    const price = pick(item, 'price', 'currentPrice', 'current_price');
    const vwap = pick(item, 'vwap', 'VWAP');
    const rvol = pick(item, 'rvol', 'RVOL');
    const rs = pick(item, 'relStrength', 'rel_strength', 'relativeStrength', 'relative_strength');
    const score = pick(item, 'score');
    const minScore = pick(item, 'minScore', 'min_score');
    const entry = pick(item, 'entry', 'entryPrice', 'entry_price');
    const risk = pick(item, 'risk', 'riskDollars', 'risk_dollars');
    const size = pick(item, 'size', 'shares', 'qty');
    const pnl = pick(item, 'pnl', 'unrealizedPnl', 'unrealized_pnl');
    const tradeStatus = pick(item, 'status', 'state');
    const selected = selectedSymbol && String(symbol) === String(selectedSymbol);
    const scoreClass = isNumber(score) ? (isNumber(minScore) && score < minScore ? 'war-bad' : score >= 75 ? 'war-good' : '') : '';
    return `<div class="war-row orb-card${selected ? ' is-selected' : ''}" data-orb-select="${esc(symbol)}" data-orb-kind="${esc(kind)}" role="button" tabindex="0" aria-label="Explain ${esc(symbol)}">
      <div><b>${esc(symbol)}</b> <span class="war-tag ${dirClass(dir)}">${esc(dirLabel(dir))}</span>${tradeStatus ? `<span class="war-tag">${esc(String(tradeStatus).replace(/_/g, ' '))}</span>` : ''}${isNumber(score) ? `<span class="war-tag war-score ${scoreClass}">SCORE ${number(score, 0)}</span>` : ''}
        <small>OR ${money(orLow)} – ${money(orHigh)}${isNumber(orWidth) ? ` · width ${money(orWidth)}${isNumber(orWidthPct) ? ` (${number(orWidthPct)}%)` : ''}` : ''} · price ${money(price)} · VWAP ${money(vwap)} · RVOL ${isNumber(rvol) ? number(rvol) : '—'} · rel. strength ${isNumber(rs) ? number(rs) : '—'}</small>
        <small>Entry ${money(entry)} · stop ${stopText(item)} · targets ${targetsText(item)} · risk ${money(risk)} · size ${isNumber(size) ? `${number(size, 0)} sh` : '—'}</small>
      </div>
      <strong class="${isNumber(pnl) ? (pnl >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(pnl) ? money(pnl) : (kind === 'candidate' ? 'WATCH' : '—')}</strong>
    </div>`;
  }

  function renderCandidates(data) {
    const el = $('orbCandidates');
    const items = data?.candidates || [];
    $('orbCandidateMeta').textContent = items.length ? `${items.length} tracked` : 'No candidates yet';
    if (!items.length) { el.innerHTML = '<p class="war-empty">No candidates — no data yet. The scanner scores breakouts only after the opening range completes.</p>'; return; }
    el.innerHTML = items.map(c => tradeCard(c, 'candidate')).join('');
    el.querySelectorAll('[data-orb-select]').forEach(card => {
      card.onclick = () => { selectedSymbol = card.dataset.orbSelect; renderCandidates(lastDashboard); renderWhy(lastDashboard); };
      card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedSymbol = card.dataset.orbSelect; renderCandidates(lastDashboard); renderWhy(lastDashboard); } };
    });
  }

  function renderPositions(items) {
    const el = $('orbPositions');
    $('orbPositionMeta').textContent = items?.length ? `${items.length} open` : 'Flat';
    $('orbOpen').textContent = String(items?.length ?? '—');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No open positions — no data yet.</p>'; return; }
    el.innerHTML = items.map(p => tradeCard(p, 'position')).join('');
  }

  /* "WHY THIS TRADE?" — engine `why` string + 9-component score bars. */
  function breakdownArray(item) {
    const raw = pick(item, 'scoreBreakdown', 'score_breakdown', 'breakdown');
    if (!raw) return null;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') {
      return Object.entries(raw).map(([name, v]) => {
        const key = Object.keys(WEIGHT_LABELS).find(k => k.toLowerCase().includes(name.toLowerCase().replace(/[^a-z]/g, ''))) || null;
        const label = (key && WEIGHT_LABELS[key]) || String(name).replace(/_/g, ' ');
        if (v && typeof v === 'object') return { name: label, weight: pick(v, 'weight'), score: pick(v, 'score', 'pct') };
        return { name: label, weight: null, score: isNumber(v) ? Number(v) : null };
      });
    }
    return null;
  }
  function renderWhy(data) {
    const el = $('orbWhy');
    const pool = [...(data?.candidates || []), ...(data?.positions || [])];
    let item = pool.find(x => String(pick(x, 'symbol', 'ticker')) === String(selectedSymbol));
    if (!item) item = pool[0] || null;
    if (!item) { el.innerHTML = '<p class="war-empty">No candidate selected — no data yet.</p>'; $('orbWhyMeta').textContent = 'No selection'; return; }
    selectedSymbol = String(pick(item, 'symbol', 'ticker'));
    const symbol = selectedSymbol;
    const dir = pick(item, 'direction');
    const why = pick(item, 'why', 'explanation');
    const score = pick(item, 'score');
    const rows = breakdownArray(item);
    $('orbWhyMeta').textContent = `${symbol} · ${dirLabel(dir)}${isNumber(score) ? ` · score ${number(score, 0)}` : ''}`;
    const bars = rows?.length
      ? `<div class="orb-scorebars">${rows.map(r => {
          const label = r.name || r.label || '—';
          const w = Number(pick(r, 'weight')); const s = Number(pick(r, 'score'));
          const pts = isNumber(w) && isNumber(s) ? (w * s / 100) : null;
          const barPct = isNumber(s) ? Math.max(0, Math.min(100, s)) : 0;
          return `<div class="orb-scorebar"><span class="orb-scorebar-label">${esc(label)}</span><span class="orb-scorebar-track"><span class="orb-scorebar-fill" style="width:${barPct}%"></span></span><span class="orb-scorebar-value">${pts == null ? '—' : `${number(pts, 1)}/${number(w, 0)} pts`}</span></div>`;
        }).join('')}</div>`
      : '<p class="war-empty">Score breakdown unavailable — no data yet.</p>';
    const newsPolicy = settingsView?.rules?.newsPolicy || pick(item, 'newsPolicy', 'news_policy');
    const newsNote = pick(item, 'news', 'newsNote', 'news_note');
    const newsLine = newsNote
      ? esc(String(newsNote))
      : `News policy: ${esc(String(newsPolicy || 'block'))} — news data unavailable.`;
    el.innerHTML = `<div class="orb-why-head"><b>${esc(symbol)}</b> <span class="war-tag ${dirClass(dir)}">${esc(dirLabel(dir))}</span>${isNumber(score) ? `<span class="war-tag war-score">SCORE ${number(score, 0)}</span>` : ''}</div>
      <p class="orb-why-text">${why ? esc(String(why)) : 'No explanation recorded — no data yet.'}</p>
      ${bars}
      <p class="orb-why-news">${newsLine}</p>`;
  }

  function renderDayState(data) {
    const dayState = data?.dayState || data?.day_state || null;
    const pnl = pick(dayState, 'pnl', 'dayPnl', 'day_pnl');
    $('orbDayPnl').textContent = `Day P&L ${isNumber(pnl) ? money(pnl) : '—'}`;
    const locks = data?.locks || [];
    const el = $('orbLocks');
    if (!dayState && !locks.length) { el.innerHTML = '<p class="war-empty">No data yet.</p>'; return; }
    const lockRow = l => {
      const name = pick(l, 'name', 'lock') || '—';
      const used = pick(l, 'used', 'value'), limit = pick(l, 'limit', 'max');
      const tripped = !!pick(l, 'tripped', 'hit', 'locked');
      const detail = isNumber(used) && isNumber(limit) ? `${number(used, 0)} / ${number(limit, 0)}` : (used != null || limit != null ? `${used ?? '—'} / ${limit ?? '—'}` : '');
      return `<div class="war-row"><div><b>${esc(String(name).replace(/_/g, ' '))}</b><small>${esc(detail)}</small></div><span class="war-tag ${tripped ? 'war-bad' : ''}">${esc(tripped ? 'TRIPPED' : 'OK')}</span></div>`;
    };
    const summary = dayState ? `<div class="war-row"><div><b>Day summary</b><small>P&amp;L ${isNumber(pnl) ? money(pnl) : '—'} · trades ${esc(pick(dayState, 'trades', 'tradeCount') ?? '—')} · wins ${esc(pick(dayState, 'wins') ?? '—')} · losses ${esc(pick(dayState, 'losses') ?? '—')} · consec. losses ${esc(pick(dayState, 'consecLosses', 'consecutiveLosses') ?? '—')}</small></div></div>` : '';
    el.innerHTML = summary + (locks.length ? locks.map(lockRow).join('') : '<p class="war-empty">No locks configured — no data yet.</p>');
  }

  /* ---- Journal ---- */

  function journalTrades(items) {
    return items.filter(t => !t.rejected && String(pick(t, 'status') || '').toLowerCase() !== 'rejected');
  }
  function journalRejected(items) {
    return items.filter(t => t.rejected || String(pick(t, 'status') || '').toLowerCase() === 'rejected');
  }
  function renderJournal(items) {
    const el = $('orbJournal');
    const setTab = tab => { journalTab = tab; $('orbTabTrades').classList.toggle('is-active', tab === 'trades'); $('orbTabRejected').classList.toggle('is-active', tab === 'rejected'); renderJournal(items); };
    $('orbTabTrades').onclick = () => setTab('trades');
    $('orbTabRejected').onclick = () => setTab('rejected');
    if (!items?.length) { el.innerHTML = '<p class="war-empty" style="padding:13px 18px">No data yet.</p>'; return; }
    if (journalTab === 'rejected') {
      const rows = journalRejected(items);
      if (!rows.length) { el.innerHTML = '<p class="war-empty" style="padding:13px 18px">No rejected setups recorded — no data yet.</p>'; return; }
      el.innerHTML = `<table class="war-table"><thead><tr><th>Setup</th><th>Context</th><th>Score</th><th>No-trade reason</th></tr></thead><tbody>${rows.slice(0, 100).map(t => {
        const reasons = pick(t, 'rejectReasons', 'reject_reasons', 'reasons');
        const reasonText = Array.isArray(reasons) ? reasons.join(' · ') : (pick(t, 'rejectReason', 'reject_reason', 'why') || '—');
        return `<tr><td><b>${esc(pick(t, 'symbol', 'ticker') || '—')}</b> <span class="war-tag ${dirClass(pick(t, 'direction'))}">${esc(dirLabel(pick(t, 'direction')))}</span><small>${day(pick(t, 'createdAt', 'created_at'))} ${time(pick(t, 'createdAt', 'created_at'))}</small></td>
          <td><small>OR ${money(pick(t, 'orHigh', 'or_high'))}/${money(pick(t, 'orLow', 'or_low'))} · RVOL ${isNumber(pick(t, 'rvol')) ? number(pick(t, 'rvol')) : '—'} · regime ${esc(regimeText(pick(t, 'regime')))}</small></td>
          <td>${isNumber(pick(t, 'score')) ? number(pick(t, 'score'), 0) : '—'}</td>
          <td class="war-reason">${esc(String(reasonText))}</td></tr>`;
      }).join('')}</tbody></table>`;
      return;
    }
    const rows = journalTrades(items);
    if (!rows.length) { el.innerHTML = '<p class="war-empty" style="padding:13px 18px">No trades recorded — no data yet.</p>'; return; }
    el.innerHTML = `<table class="war-table"><thead><tr><th>Trade</th><th>Setup context</th><th>Position</th><th>Result</th><th>Reasons</th></tr></thead><tbody>${rows.slice(0, 100).map(t => {
      const dir = pick(t, 'direction');
      const pnl = pick(t, 'pnl');
      const r = pick(t, 'rMultiple', 'r_multiple', 'r');
      const entryAt = pick(t, 'entryAt', 'entry_at'), exitAt = pick(t, 'exitAt', 'exit_at');
      return `<tr><td><b>${esc(pick(t, 'symbol', 'ticker') || '—')}</b> <span class="war-tag ${dirClass(dir)}">${esc(dirLabel(dir))}</span><small>${day(entryAt)} ${time(entryAt)}${exitAt ? ` → ${time(exitAt)}` : ' · open'}</small></td>
        <td><small>OR ${money(pick(t, 'orHigh', 'or_high'))}/${money(pick(t, 'orLow', 'or_low'))} · VWAP ${money(pick(t, 'vwap'))} · RVOL ${isNumber(pick(t, 'rvol')) ? number(pick(t, 'rvol')) : '—'} · ATR ${money(pick(t, 'atr'))} · regime ${esc(regimeText(pick(t, 'regime')))} · score ${isNumber(pick(t, 'score')) ? number(pick(t, 'score'), 0) : '—'}</small></td>
        <td><small>${isNumber(pick(t, 'shares', 'size')) ? `${number(pick(t, 'shares', 'size'), 0)} sh` : '—'} · entry ${money(pick(t, 'entryPrice', 'entry_price'))} → exit ${money(pick(t, 'exitPrice', 'exit_price'))}<br>stop ${money(pick(t, 'stopPrice', 'stop_price'))} · targets ${esc(String(pick(t, 'targets') ?? '—'))} · risk ${money(pick(t, 'riskDollars', 'risk_dollars', 'risk'))}</small></td>
        <td class="${isNumber(pnl) ? (pnl >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(pnl) ? money(pnl) : '—'}<small>${isNumber(r) ? `${number(r)}R` : ''}</small></td>
        <td class="war-reason"><small>Entry: ${esc(pick(t, 'entryReason', 'entry_reason') || '—')}<br>Exit: ${esc(pick(t, 'exitReason', 'exit_reason') || '—')}</small></td></tr>`;
    }).join('')}</tbody></table>`;
  }

  function renderUniverse(data) {
    const el = $('orbUniverse');
    const raw = data?.symbols || data?.universe || data;
    const items = Array.isArray(raw) ? raw : [];
    $('orbUniverseMeta').textContent = items.length ? `${items.length} symbols` : '—';
    if (!items.length) { el.innerHTML = '<p class="war-empty">No universe data — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 40).map(s => {
      const symbol = typeof s === 'string' ? s : pick(s, 'symbol', 'ticker');
      const note = typeof s === 'string' ? '' : pick(s, 'note', 'status');
      return `<div class="war-row"><div><b>${esc(symbol || '—')}</b>${note ? `<small>${esc(String(note))}</small>` : ''}</div></div>`;
    }).join('');
  }

  function renderAlerts(items) {
    const el = $('orbAlerts');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No alerts — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 30).map(a => `<div class="war-row"><div><b>${esc(pick(a, 'kind'))}</b><small>${esc(pick(a, 'message'))}</small></div><strong>${time(pick(a, 'createdAt', 'created_at'))}</strong></div>`).join('');
  }

  /* ---- Settings ---- */

  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const setPath = (obj, path, value) => {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = value;
  };
  function renderSettings() {
    const el = $('orbSettings');
    const rules = settingsView?.rules;
    if (!rules) { el.innerHTML = '<p class="war-empty">Settings unavailable.</p>'; return; }
    const field = (key, label, type, stepOrOptions) => {
      const value = getPath(rules, key);
      const id = `orbRule_${key}`;
      if (type === 'checkbox') return `<label class="war-field war-check" for="${id}"><input id="${id}" type="checkbox" data-rule="${key}" ${value ? 'checked' : ''}><span>${esc(label)}</span></label>`;
      if (type === 'select') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><select id="${id}" data-rule="${key}">${stepOrOptions.map(o => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      if (type === 'time') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="time" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
      if (type === 'text') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="text" maxlength="32" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
      if (type === 'watchlist') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><textarea id="${id}" data-rule="${key}" rows="5" placeholder="SOUN, UUUU, SMR, …">${esc(value ?? '')}</textarea></label>`;
      return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="number" step="${stepOrOptions}" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
    };
    el.innerHTML = `
      <fieldset class="war-fieldset"><legend>Master switch</legend>
      <label class="war-field war-check" for="orbEnabled"><input id="orbEnabled" type="checkbox" data-enabled ${settingsView?.enabled ? 'checked' : ''}><span>Trading enabled</span></label>
      </fieldset>` +
      RULE_SCHEMA.map(group => `
      <fieldset class="war-fieldset"><legend>${esc(group.group)}</legend>
      ${group.fields.map(([key, label, type, extra]) => field(key, label, type, extra)).join('')}
      </fieldset>`).join('') +
      `<p class="war-note">Live orders require <b>all three</b>: Mode = LIVE <b>and</b> both live switches checked. Anything less is refused loudly by the server. Paper is the default.</p>`;
  }

  function collectRules() {
    const rules = {};
    // Merge onto current settings so nested objects (weights) survive.
    if (settingsView?.rules) {
      const deep = o => (o && typeof o === 'object' && !Array.isArray(o))
        ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deep(v)])) : o;
      Object.assign(rules, deep(settingsView.rules));
    }
    document.querySelectorAll('#orbSettings [data-rule]').forEach(input => {
      const key = input.dataset.rule;
      if (input.type === 'checkbox') setPath(rules, key, input.checked);
      else if (input.tagName === 'SELECT') setPath(rules, key, input.value);
      else if (input.type === 'time' || input.type === 'text') { if (input.value.trim() !== '') setPath(rules, key, input.value.trim()); }
      else if (input.tagName === 'TEXTAREA') setPath(rules, key, input.value.trim()); // empty clears → universe scan
      else if (input.value !== '') setPath(rules, key, Number(input.value));
    });
    return rules;
  }
  function validateRules(rules) {
    const errors = [];
    const weightSum = WEIGHT_KEYS.reduce((sum, k) => sum + (Number(getPath(rules, k)) || 0), 0);
    if (weightSum !== 100) errors.push(`Score weights must sum to 100 (currently ${number(weightSum, 0)}).`);
    const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
    const checkWindow = (start, end, label) => {
      if (!hhmm(start) || !hhmm(end)) errors.push(`${label}: use HH:MM times.`);
      else if (start >= end) errors.push(`${label}: start must be before end.`);
    };
    checkWindow(rules.entryWindowStart, rules.entryWindowEnd, 'Entry window');
    if (rules.secondWindowEnabled) checkWindow(rules.secondWindowStart, rules.secondWindowEnd, 'Second window');
    if (![5, 15, 30].includes(Number(rules.orMinutes))) errors.push('Opening range duration must be 5, 15, or 30 minutes.');
    if (rules.allowLong === false && rules.allowShort === false) errors.push('Enable at least one direction (long or short).');
    if (Number(rules.minRvol) > Number(rules.preferredRvol)) errors.push('Min RVOL cannot exceed preferred RVOL.');
    if (Number(rules.preferredRvol) > Number(rules.strongRvol)) errors.push('Preferred RVOL cannot exceed strong RVOL.');
    return errors;
  }

  /* ---- Backtests ---- */

  function renderBacktests(items) {
    const el = $('orbBacktests');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No backtests yet.</p>'; return; }
    el.innerHTML = items.map(b => {
      const id = pick(b, 'id', 'backtestId', 'backtest_id');
      const params = b.params || {};
      const range = params.startDate && params.endDate ? `${params.startDate} → ${params.endDate}` : (params.from && params.to ? `${params.from} → ${params.to}` : '');
      return `<div class="war-row"><div><b>${esc(String(id || '').slice(0, 8))}…</b>
        <small>${esc(range)} · ${day(pick(b, 'createdAt', 'created_at'))}</small></div>
        <button class="war-button war-quiet" data-bt="${esc(id)}">View</button></div>`;
    }).join('');
    el.querySelectorAll('[data-bt]').forEach(btn => btn.onclick = () => viewBacktest(btn.dataset.bt));
  }

  function breakdownTable(title, rows) {
    if (!rows?.length) return '';
    const metric = r => `<td>${isNumber(pick(r, 'trades')) ? number(pick(r, 'trades'), 0) : '—'}</td>
      <td>${isNumber(pick(r, 'winRate', 'win_rate')) ? pct(pick(r, 'winRate', 'win_rate')) : '—'}</td>
      <td>${isNumber(pick(r, 'avgR', 'avg_r')) ? `${number(pick(r, 'avgR', 'avg_r'))}R` : '—'}</td>
      <td class="${isNumber(pick(r, 'totalPnl', 'total_pnl')) ? (pick(r, 'totalPnl', 'total_pnl') >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(pick(r, 'totalPnl', 'total_pnl')) ? money(pick(r, 'totalPnl', 'total_pnl')) : '—'}</td>`;
    return `<h4>${esc(title)}</h4><div class="war-table-wrap orb-bt-wrap"><table class="war-table"><thead><tr><th>Bucket</th><th>Trades</th><th>Win rate</th><th>Avg R</th><th>Total P&amp;L</th></tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(String(pick(r, 'key', 'bucket', 'label') ?? '—'))}</b></td>${metric(r)}</tr>`).join('')}</tbody></table></div>`;
  }
  function equityChart(points) {
    if (!Array.isArray(points) || points.length < 2) return '';
    const vals = points.map(p => (p && typeof p === 'object' ? Number(pick(p, 'equity', 'value')) : Number(p))).filter(Number.isFinite);
    if (vals.length < 2) return '';
    const w = 560, h = 120, min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const path = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 8) - 4).toFixed(1)}`).join(' ');
    return `<svg class="orb-equity" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Equity curve"><polyline points="${path}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  }
  function renderBacktestDetail(detail) {
    const el = $('orbBacktestDetail');
    if (!detail) { el.innerHTML = ''; return; }
    const r = detail.report || detail.result || {};
    const summary = pick(r, 'summary') || r;
    const cell = v => (v == null ? '—' : isNumber(v) ? String(number(Number(v))) : esc(v));
    const stat = (label, value) => `<div><span>${esc(label)}</span><strong>${cell(value)}</strong></div>`;
    const eq = pick(r, 'equity') || {};
    el.innerHTML = `<div class="war-bt-detail"><h3>Backtest ${esc(String(pick(detail, 'id', 'backtestId', 'backtest_id') || '').slice(0, 8))}…</h3>
      <div class="war-perf-grid">
        ${stat('Total trades', pick(summary, 'totalTrades', 'total_trades'))}
        ${stat('Win rate', isNumber(pick(summary, 'winRate', 'win_rate')) ? pct(pick(summary, 'winRate', 'win_rate')) : pick(summary, 'winRate', 'win_rate'))}
        ${stat('Profit factor', pick(summary, 'profitFactor', 'profit_factor'))}
        ${stat('Avg R', pick(summary, 'avgR', 'avg_r'))}
        ${stat('Total P&L', isNumber(pick(summary, 'totalPnl', 'total_pnl')) ? money(pick(summary, 'totalPnl', 'total_pnl')) : pick(summary, 'totalPnl', 'total_pnl'))}
        ${stat('Max drawdown', pick(summary, 'maxDrawdown', 'max_drawdown'))}
        ${stat('Largest win', pick(summary, 'largestWin', 'largest_win'))}
        ${stat('Largest loss', pick(summary, 'largestLoss', 'largest_loss'))}
        ${stat('Avg winner', pick(summary, 'avgWinner', 'avg_winner'))}
        ${stat('Avg loser', pick(summary, 'avgLoser', 'avg_loser'))}
        ${stat('Consec. losses', pick(summary, 'maxConsecutiveLosses', 'consecutiveLosses'))}
        ${stat('Return', isNumber(pick(summary, 'totalReturn', 'total_return')) ? pct(pick(summary, 'totalReturn', 'total_return')) : pick(summary, 'totalReturn', 'total_return'))}
      </div>
      <h4>Equity curve</h4>
      ${equityChart(pick(r, 'equityCurve', 'equity_curve'))}
      <p class="orb-equity-summary"><small>Start ${money(pick(eq, 'start', 'startEquity'))} · end ${money(pick(eq, 'end', 'endEquity'))} · max drawdown ${money(pick(eq, 'maxDrawdown', 'max_drawdown'))}</small></p>
      ${breakdownTable('By direction', pick(r, 'byDirection', 'by_direction'))}
      ${breakdownTable('By OR duration', pick(r, 'byOrDuration', 'by_or_duration'))}
      ${breakdownTable('By score bucket', pick(r, 'byScoreBucket', 'by_score_bucket'))}
      ${breakdownTable('By RVOL bucket', pick(r, 'byRvolBucket', 'by_rvol_bucket'))}
      ${breakdownTable('By regime', pick(r, 'byRegime', 'by_regime'))}
      ${breakdownTable('By time of day', pick(r, 'byTimeOfDay', 'by_time_of_day'))}
      <h4>Trades (${(detail.trades || []).length})</h4><div class="war-list">
      ${(detail.trades || []).slice(0, 50).map(t => {
        const pnl = pick(t, 'pnl');
        return `<div class="war-row"><div><b>${esc(pick(t, 'symbol', 'ticker') || '—')}</b> <span class="war-tag ${dirClass(pick(t, 'direction'))}">${esc(dirLabel(pick(t, 'direction')))}</span><small>${esc(pick(t, 'date') || day(pick(t, 'entryAt', 'entry_at')) || '')} · ${esc(pick(t, 'exitReason', 'exit_reason') || '—')}</small></div><strong class="${isNumber(pnl) ? (pnl >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(pnl) ? money(pnl) : '—'}</strong></div>`;
      }).join('') || '<p class="war-empty">No data yet.</p>'}
      </div></div>`;
  }

  /* ---- Actions ---- */

  async function toggleEnabled() {
    if (changing || !status?.connected) { if (!status?.connected) connectionModal(); return; }
    changing = true; revision++;
    try {
      await api('/api/orb/settings', { method: 'PUT', body: JSON.stringify({ enabled: !status.enabled, rules: settingsView?.rules || {} }) });
      settingsView = await api('/api/orb/settings');
      status = await api('/api/orb/status');
      renderStatus(); renderSettings();
      notice(status.enabled ? 'ORB trading resumed — the opening range is watched after the 9:30 ET open.' : 'ORB trading paused. Existing positions remain under automatic management.');
    } catch (error) { notice(`Toggle failed: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  async function saveSettings() {
    if (changing) return;
    const rules = collectRules();
    const errors = validateRules(rules);
    if (errors.length) { notice(`Settings not saved: ${errors[0]}`, true); return; }
    const enabledInput = document.querySelector('#orbSettings [data-enabled]');
    changing = true; revision++;
    try {
      await api('/api/orb/settings', { method: 'PUT', body: JSON.stringify({ rules, ...(enabledInput ? { enabled: enabledInput.checked } : {}) }) });
      settingsView = await api('/api/orb/settings');
      status = await api('/api/orb/status');
      renderStatus(); renderSettings(); renderWhy(lastDashboard);
      notice('Settings saved.');
    } catch (error) { notice(`Settings not saved: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  async function runBacktest(event) {
    event.preventDefault();
    if (changing) return;
    changing = true; revision++;
    try {
      const startDate = $('orbBtStart').value, endDate = $('orbBtEnd').value;
      if (!startDate || !endDate || startDate > endDate) throw new Error('Pick a valid date range (from ≤ to).');
      notice('Running backtest — this can take a minute on long histories…');
      const result = await api('/api/orb/backtest', { method: 'POST', body: JSON.stringify({ startDate, endDate, rules: settingsView?.rules || {} }) });
      const id = pick(result, 'id', 'backtestId', 'backtest_id');
      notice(`Backtest queued: ${id ? String(id).slice(0, 8) + '…' : '—'}.`);
      await viewBacktest(id);
      const list = await api('/api/orb/backtests');
      renderBacktests(list.backtests || list);
    } catch (error) { notice(`Backtest failed: ${error.message}`, true); }
    finally { changing = false; }
  }
  async function viewBacktest(id) {
    if (!id) { notice('Backtest id missing from response.', true); return; }
    try { activeBacktest = await api(`/api/orb/backtests/${encodeURIComponent(id)}`); renderBacktestDetail(activeBacktest); }
    catch (error) { notice(`Backtest unavailable: ${error.message}`, true); }
  }
  function connectionModal() {
    if (changing) return;
    const old = $('orbModal'); if (old) old.remove();
    const previousFocus = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="war-modal" id="orbModal" role="dialog" aria-modal="true" aria-labelledby="orbModalTitle"><form class="war-modal-card" id="orbForm"><button type="button" class="war-close" id="orbClose" aria-label="Close">×</button><div class="war-modal-scroll"><span class="war-eyebrow">ORB DEDICATED CONNECTION</span><h2 id="orbModalTitle">Connect Alpaca Paper</h2><p>Use a dedicated paper account, separate from other bots and manual trading. Keys are stored encrypted and are never displayed back. Paper is the default — live connect is refused loudly without all three live gates.</p><label>API key<input id="orbKey" required autocomplete="off"></label><label>API secret<input id="orbSecret" type="password" required autocomplete="off"></label><p id="orbFormError" class="war-form-error" role="alert"></p></div><div class="war-modal-actions"><button type="submit" class="war-button" id="orbSubmit">Connect</button><button type="button" class="war-button war-quiet" id="orbDisconnect">Disconnect</button></div></form></div>`);
    const close = () => { if (changing) return; $('orbModal')?.remove(); previousFocus?.focus(); };
    $('orbClose').onclick = close;
    $('orbModal').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    $('orbForm').onsubmit = async event => {
      event.preventDefault();
      if (changing) return;
      changing = true; revision++;
      $('orbModal').querySelectorAll('button,input,select').forEach(control => { control.disabled = true; });
      try {
        status = await api('/api/orb/connect', { method: 'POST', body: JSON.stringify({ key: $('orbKey').value, secret: $('orbSecret').value }) });
        settingsView = await api('/api/orb/settings');
        close(); renderStatus(); renderSettings();
        notice('Paper connected. Trading is still disabled — resume it when ready.');
        refresh();
      } catch (error) { $('orbFormError').textContent = `Connection blocked: ${error.message}`; }
      finally { changing = false; $('orbModal')?.querySelectorAll('button,input,select').forEach(control => { control.disabled = false; }); renderStatus(); }
    };
    $('orbDisconnect').onclick = async () => {
      if (!window.confirm('Disconnect the ORB paper account? Blocked while positions remain open.')) return;
      if (changing) return;
      changing = true; revision++;
      try { status = await api('/api/orb/disconnect', { method: 'POST' }); close(); renderStatus(); notice('ORB disconnected.'); refresh(); }
      catch (error) { $('orbFormError').textContent = `Disconnect blocked: ${error.message}`; }
      finally { changing = false; renderStatus(); }
    };
    $('orbClose').focus();
  }

  async function refresh() {
    if (!mounted || refreshing || changing) return;
    refreshing = true;
    const startedRevision = revision;
    const results = await Promise.allSettled([
      api('/api/orb/status'), api('/api/orb/dashboard'), api('/api/orb/trades'),
      api('/api/orb/universe'), api('/api/orb/backtests'), api('/api/orb/alerts'),
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
      lastDashboard = dash;
      renderRegime(dash);
      renderCandidates(dash);
      renderWhy(dash);
      renderPositions(dash.positions);
      renderDayState(dash);
    } else {
      $('orbRegime').innerHTML = `<p class="war-empty war-unavailable">Dashboard unavailable: ${esc(fail(1))}</p>`;
      $('orbCandidates').innerHTML = `<p class="war-empty war-unavailable">Candidates unavailable: ${esc(fail(1))}</p>`;
      $('orbPositions').innerHTML = `<p class="war-empty war-unavailable">Positions unavailable: ${esc(fail(1))}</p>`;
      $('orbLocks').innerHTML = `<p class="war-empty war-unavailable">Locks unavailable: ${esc(fail(1))}</p>`;
    }
    if (get(2)) renderJournal(get(2).trades || get(2)); else $('orbJournal').innerHTML = `<p class="war-empty war-unavailable" style="padding:13px 18px">Journal unavailable: ${esc(fail(2))}</p>`;
    if (get(3)) renderUniverse(get(3)); else $('orbUniverse').innerHTML = `<p class="war-empty war-unavailable">Universe unavailable: ${esc(fail(3))}</p>`;
    if (get(4)) renderBacktests(get(4).backtests || get(4));
    if (get(5)) renderAlerts(get(5).alerts || get(5)); else $('orbAlerts').innerHTML = `<p class="war-empty war-unavailable">Alerts unavailable: ${esc(fail(5))}</p>`;
    if (!settingsView) { try { settingsView = await api('/api/orb/settings'); renderSettings(); } catch (_) { /* settings panel keeps its empty state */ } }
  }

  async function open() {
    shell(); mounted = true;
    $('orbPaperConnect').onclick = connectionModal;
    $('orbEnabledToggle').onclick = toggleEnabled;
    $('orbSave').onclick = saveSettings;
    $('orbBtForm').onsubmit = runBacktest;
    try { settingsView = await api('/api/orb/settings'); renderSettings(); } catch (_) {}
    await refresh(); if (!mounted) return; clearInterval(polling); polling = setInterval(refresh, 30000);
  }
  function pause() { mounted = false; clearInterval(polling); polling = null; }
  window.orbBot = { open, pause };
}());
