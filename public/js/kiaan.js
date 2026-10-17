/* Kiaan Bot — regime-first trading controls (stage 2, Johnny 2026-10-08).
 * The bot classifies the day (risk-on / risk-off / chop / unknown) from
 * SPY/QQQ, VIX, yields and oil BEFORE it looks at a single stock, then
 * trades only what the regime allows. Every decision — including standing
 * aside — is journaled server-side with its reasons and shown here.
 * PAPER ONLY BY DESIGN: there is no live mode anywhere in this bot.
 * Reuses the shared bot skin classes (war-*) from kiaan.css (the skin was
 * Warrior's until its deletion on 2026-10-16; the classes stayed because
 * Kiaan's page is built on them);
 * Kiaan-specific bits live in the kb-* style block below. Everything
 * renders real API data; empty states say "no data yet".
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
  let settingsView = null, lastDashboard = null;

  const CSS = [
    '.kb-regime{border:1px solid rgba(127,140,160,.25);border-radius:14px;padding:14px 16px;margin-bottom:12px}',
    '.kb-regime strong{font-size:20px;font-weight:800}',
    '.kb-regime.risk-on{border-color:rgba(29,214,163,.45);background:rgba(29,214,163,.07)}',
    '.kb-regime.risk-off{border-color:rgba(255,92,92,.45);background:rgba(255,92,92,.07)}',
    '.kb-regime.chop,.kb-regime.unknown{border-color:rgba(255,170,60,.4);background:rgba(255,170,60,.06)}',
    '.kb-tape{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:10px 0}',
    '.kb-tape div span{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.65}',
    '.kb-tape div strong{font-size:16px}',
    '.kb-tape div small{display:block}',
    '.kb-reasons{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.55;opacity:.9}',
    '.kb-stance{font-size:13px;font-weight:700;letter-spacing:.04em}',
  ].join('\n');

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response. Refresh to verify the current state.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (!data || typeof data !== 'object') throw new Error('Server response is incomplete.');
    return data;
  }
  function notice(message, error) { const el = $('kiaanNotice'); if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); } }

  function pillState() {
    if (!status) return ['CHECKING', ''];
    const sched = String(status.schedulerStatus || '').toLowerCase();
    if (sched === 'error') return ['ERROR', 'war-bad'];
    if (!status.connected) return ['DISCONNECTED', ''];
    if (!status.enabled) return ['PAUSED', ''];
    if (sched === 'ok') return ['PAPER–ACTIVE', 'war-good'];
    return ['PAPER–IDLE', ''];
  }

  function shell() {
    const page = $('page-kiaan');
    if (!page || $('kiaanRoot')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    page.appendChild(style);
    const root = document.createElement('div');
    root.innerHTML = `<section class="war-shell" id="kiaanRoot" aria-labelledby="kiaanTitle">
      <header class="war-hero"><div><span class="war-eyebrow">REGIME-FIRST · KIAAN BOT</span><h1 id="kiaanTitle">Kiaan Bot <em>regime first, trades second</em></h1><p>Reads the market first, then decides whether trading is allowed today and in what. Every decision is journaled in plain language.</p></div><span class="war-auto-label">PAPER ONLY</span></header>
      <div class="war-notice" id="kiaanNotice" role="status" aria-live="polite"></div>
      <section class="war-status" aria-label="Kiaan Bot system status">
        <div><span>Status</span><strong id="kiaanPill">CHECKING</strong><small id="kiaanTradeDate">Trade date —</small></div>
        <div><span>Connection</span><strong id="kiaanConnection">CHECKING</strong><small id="kiaanAccount">Dedicated account required</small></div>
        <div><span>Open positions</span><strong id="kiaanOpen">—</strong><small id="kiaanDayPnl">Day P&amp;L —</small></div>
        <div><span>Scheduler</span><strong id="kiaanScheduler">—</strong><small id="kiaanSchedulerNote">Server-owned cycle</small></div>
      </section>
      <section class="war-command"><div><span class="war-eyebrow">BOT CONTROL</span><h2 id="kiaanMandate">Checking account</h2><p id="kiaanMandateCopy">Broker connection is managed on the Brokers page. Trading can be paused or resumed here.</p><p id="kiaanBlockers" class="war-blockers"></p></div><button class="war-button war-quiet" id="kiaanEnabledToggle" disabled>Checking account</button></section>
      <section class="war-layout"><main class="war-main">
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">TODAY'S REGIME</span><h2>Market read</h2></div><span id="kiaanRegimeMeta">Loading</span></div><div id="kiaanRegime"></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">DECISIONS JOURNAL</span><h2>Why every trade — and every no-trade</h2></div><span id="kiaanDecisionMeta">Loading</span></div><div class="war-list" id="kiaanDecisions"><p class="war-empty">Loading decisions…</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">UNDER MANAGEMENT</span><h2>Positions</h2></div><span id="kiaanPositionMeta">Loading</span></div><div class="war-list" id="kiaanPositions"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">TRADE JOURNAL</span><h2>Trades</h2></div></div><div class="war-table-wrap" id="kiaanJournal"><p class="war-empty" style="padding:13px 18px">No data yet.</p></div></article>
      </main>
      <aside class="war-rail">
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">BROKER</span><h2>Alpaca</h2></div></div><div class="war-account-row"><div><b>Paper</b><small id="kiaanPaperState">Checking</small></div><span class="war-tag">ALPACA</span></div><p class="war-account-note">Connection status only. Broker accounts are managed on the Brokers page — there is no key entry on this page.</p></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">DAY STATE &amp; LOCKS</span><h2>Daily risk</h2></div></div><div class="war-list" id="kiaanLocks"><p class="war-empty">No data yet.</p></div></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">SETTINGS</span><h2>Settings</h2></div></div><div id="kiaanSettings"><p class="war-empty">Loading settings…</p></div><button class="war-button war-save" id="kiaanSave">Save settings</button></article>
        <article class="war-panel"><div class="war-head"><div><span class="war-eyebrow">RISK DESK</span><h2>Alerts</h2></div></div><div class="war-list" id="kiaanAlerts"><p class="war-empty">No data yet.</p></div></article>
      </aside></section>
    </section>`;
    page.appendChild(root);
  }

  const userView = () => settingsView?.viewer === 'user' || status?.viewer === 'user' || lastDashboard?.viewer === 'user';

  function renderStatus(tradeDate) {
    if (!status) return;
    const connected = !!status.connected;
    const [pillText, pillClass] = pillState();
    $('kiaanPill').textContent = pillText;
    $('kiaanPill').className = pillClass;
    $('kiaanTradeDate').textContent = tradeDate ? `Trade date ${esc(tradeDate)}` : 'Trade date —';
    $('kiaanConnection').textContent = connected ? 'PAPER CONNECTED' : 'DISCONNECTED';
    $('kiaanConnection').className = connected ? 'war-good' : 'war-bad';
    $('kiaanAccount').textContent = userView() ? 'Alpaca · Paper' : (status.accountId ? `Account ${status.accountId}` : 'Dedicated Kiaan account required');
    $('kiaanScheduler').textContent = String(status.schedulerStatus || 'IDLE').toUpperCase();
    $('kiaanSchedulerNote').textContent = userView()
      ? (status.lastCycleAt ? `Last cycle ${time(status.lastCycleAt)}` : 'No completed cycle yet')
      : (status.schedulerReason || (status.lastCycleAt ? `Last cycle ${time(status.lastCycleAt)}` : 'No completed cycle yet'));
    $('kiaanMandate').textContent = !connected ? 'No broker account connected' : !status.enabled ? 'Trading is paused' : 'Reading the regime';
    $('kiaanMandateCopy').textContent = !connected
      ? 'Broker connection is managed on the Brokers page. Once an account is connected, trading can be paused or resumed here.'
      : status.enabled
        ? 'The server classifies the regime every minute of the session and trades only what the regime allows. Fully automatic — no approval step.'
        : 'Trading is paused. Existing positions remain under automatic management. New entries stay withheld until you resume.';
    $('kiaanBlockers').textContent = (status.blockers || []).join(' · ');
    const toggle = $('kiaanEnabledToggle');
    toggle.disabled = !connected || changing;
    toggle.textContent = !connected ? 'Not connected' : status.enabled ? 'Pause trading' : 'Resume trading';
    $('kiaanPaperState').textContent = connected ? 'Connected' : 'Not connected';
  }

  function renderRegime(data) {
    const el = $('kiaanRegime');
    const session = data?.session || null;
    if (!session) {
      el.innerHTML = userView()
        ? '<p class="war-empty">No regime read yet — no data yet.</p>'
        : '<p class="war-empty">No regime read yet — no data yet. The first read lands on the first scheduler cycle after the bot is enabled, and is journaled here with every vote.</p>';
      $('kiaanRegimeMeta').textContent = 'No data yet';
      return;
    }
    if (userView()) {
      // User view: today's regime in ONE plain line — no score, no vote
      // breakdown, no market tape.
      const label = { 'risk-on': 'Risk-on', 'risk-off': 'Risk-off', chop: 'Chop', unknown: 'Unknown' }[session.regime] || 'Unknown';
      $('kiaanRegimeMeta').textContent = session.updatedAt ? `Updated ${time(session.updatedAt)}` : 'Live read';
      el.innerHTML = `<div class="kb-regime ${esc(session.regime || '')}"><strong>${esc(label)}</strong></div>`;
      return;
    }
    $('kiaanRegimeMeta').textContent = session.updatedAt ? `Updated ${time(session.updatedAt)}` : 'Live read';
    const inputs = session.inputs || {};
    const tape = (label, value, suffix) => `<div><span>${esc(label)}</span><strong>${value == null ? '—' : esc(String(value))}</strong><small>${esc(suffix || '')}</small></div>`;
    const signed = (v, digits = 2) => isNumber(v) ? `${Number(v) >= 0 ? '+' : ''}${number(v, digits)}%` : null;
    const stanceLabel = { 'seek-longs': 'SEEKING LONGS', 'seek-hedges': 'HEDGES ONLY', 'stand-aside': 'STANDING ASIDE' }[session.stance] || session.stance;
    const reasons = Array.isArray(session.reasons) ? session.reasons : [];
    el.innerHTML = `<div class="kb-regime ${esc(session.regime || '')}"><span class="war-eyebrow">REGIME</span><br><strong>${esc(String(session.regime || '—').toUpperCase())}</strong> <span class="kb-stance">· ${esc(stanceLabel || '')} · score ${isNumber(session.score) ? `${Number(session.score) >= 0 ? '+' : ''}${number(session.score, 0)}` : '—'}</span>
      <div class="kb-tape">
        ${tape('SPY', inputs.spyDayChangePct == null ? null : signed(inputs.spyDayChangePct), inputs.spyTrend ? `trend ${inputs.spyTrend}` : '')}
        ${tape('QQQ', inputs.qqqDayChangePct == null ? null : signed(inputs.qqqDayChangePct), inputs.qqqTrend ? `trend ${inputs.qqqTrend}` : '')}
        ${tape('VIX', inputs.vixLevel == null ? null : number(inputs.vixLevel, 1), inputs.vixDayChangePct == null ? '' : signed(inputs.vixDayChangePct, 1) + ' today')}
        ${tape('10Y yield', inputs.tenYearChangeBps == null ? null : `${Number(inputs.tenYearChangeBps) >= 0 ? '+' : ''}${number(inputs.tenYearChangeBps, 0)} bps`, 'day change')}
        ${tape('Oil', inputs.oilDayChangePct == null ? null : signed(inputs.oilDayChangePct, 1), 'day change')}
      </div>
      ${session.why ? `<p style="margin:6px 0 0;font-size:13.5px">${esc(session.why)}</p>` : ''}
      ${reasons.length ? `<ul class="kb-reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      </div>
      <p class="war-note">VIX, yields and oil are read from Yahoo Finance (the site's own macro source); SPY/QQQ from the bot's Alpaca feed. If VIX cannot be read, the regime is UNKNOWN and the bot stands aside — it never guesses.</p>`;
  }

  function renderDecisions(journalData) {
    const el = $('kiaanDecisions');
    const items = (journalData?.decisions || []).filter(d => d.kind === 'candidate');
    $('kiaanDecisionMeta').textContent = items.length ? `${items.length} symbols decided today` : 'No decisions yet';
    if (!items.length) { el.innerHTML = '<p class="war-empty">No candidate decisions — no data yet. On a stand-aside day the session read above is the journal entry: sitting out is a decision, and it is recorded.</p>'; return; }
    el.innerHTML = items.slice(0, 60).map(d => {
      const entered = d.decision === 'enter-long';
      if (userView()) {
        return `<div class="war-row"><div><b>${esc(d.symbol || '—')}</b> <span class="war-tag ${entered ? 'war-good' : ''}">${esc(entered ? 'ENTER LONG' : 'NO TRADE')}</span> <span class="war-tag">${esc(String(d.regime || '—').toUpperCase())}</span>
        <small>${esc(d.why || '')}</small></div></div>`;
      }
      const f = d.data?.features || {};
      const firstReason = Array.isArray(d.reasons) && d.reasons.length ? d.reasons[d.reasons.length - 1] : '';
      return `<div class="war-row"><div><b>${esc(d.symbol || '—')}</b> <span class="war-tag ${entered ? 'war-good' : ''}">${esc(entered ? 'ENTER LONG' : 'NO TRADE')}</span> <span class="war-tag">${esc(String(d.regime || '—').toUpperCase())}</span>
        <small>price ${money(f.price)} · RS ${isNumber(f.relStrengthPct) ? `${Number(f.relStrengthPct) >= 0 ? '+' : ''}${number(f.relStrengthPct)} pts` : '—'} · RVOL pace ${isNumber(f.rvol) ? `${number(f.rvol)}×` : '—'} · OR high ${money(f.orHigh)} · VWAP ${money(f.vwap)}</small>
        <small>${esc(d.why || firstReason || '')}</small></div></div>`;
    }).join('');
  }

  function renderPositions(items) {
    const el = $('kiaanPositions');
    $('kiaanPositionMeta').textContent = items?.length ? `${items.length} open` : 'Flat';
    $('kiaanOpen').textContent = String(items?.length ?? '—');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No open positions — no data yet.</p>'; return; }
    el.innerHTML = items.map(p => {
      if (userView()) {
        return `<div class="war-row"><div><b>${esc(p.symbol || '—')}</b> <span class="war-tag war-good">LONG</span> <span class="war-tag">${esc(String(p.status || '').replace(/_/g, ' '))}</span>
        <small>${esc(p.shares ?? '—')} sh · entry ${money(p.entry_price)} · realized so far ${money(p.realized_pnl)}</small></div></div>`;
      }
      const targets = (() => { try { const t = JSON.parse(p.targets_json || '[]'); return Array.isArray(t) ? t.map(x => `${money(x.price)} (${x.r}R)`).join(' → ') : '—'; } catch (_) { return '—'; } })();
      const prot = [p.t1_status === 'protected' ? 'OCO live' : null, p.t2_status === 'protected' ? 'stop live' : null].filter(Boolean).join(' · ') || 'server-managed';
      return `<div class="war-row"><div><b>${esc(p.symbol || '—')}</b> <span class="war-tag war-good">LONG</span> <span class="war-tag">${esc(String(p.status || '').replace(/_/g, ' '))}</span>
        <small>${esc(p.shares ?? '—')} sh · entry ${money(p.entry_price)} · stop ${money(p.stop_price)}${p.breakeven_at ? ' (breakeven)' : ''} · targets ${esc(targets)}</small>
        <small>Protection: ${esc(prot)} · realized so far ${money(p.realized_pnl)}</small></div></div>`;
    }).join('');
  }

  function renderJournal(items) {
    const el = $('kiaanJournal');
    if (!items?.length) { el.innerHTML = '<p class="war-empty" style="padding:13px 18px">No trades recorded — no data yet.</p>'; return; }
    if (userView()) {
      el.innerHTML = `<table class="war-table"><thead><tr><th>Trade</th><th>Position</th><th>Result</th></tr></thead><tbody>${items.slice(0, 100).map(t => {
        const pnl = pick(t, 'pnl');
        const entryAt = pick(t, 'entryTime', 'entry_time', 'createdAt', 'created_at');
        return `<tr><td><b>${esc(pick(t, 'symbol') || '—')}</b> <span class="war-tag war-good">LONG</span><small>${day(entryAt)} ${time(entryAt)}${t.closedAt ? ` → ${time(t.closedAt)}` : ' · open'}</small></td>
        <td><small>${isNumber(pick(t, 'size')) ? `${number(pick(t, 'size'), 0)} sh` : '—'} · entry ${money(pick(t, 'entryPrice'))} → exit ${money(pick(t, 'exitPrice'))}</small></td>
        <td class="${isNumber(pnl) ? (Number(pnl) >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(pnl) ? money(pnl) : '—'}</td></tr>`;
      }).join('')}</tbody></table>`;
      return;
    }
    el.innerHTML = `<table class="war-table"><thead><tr><th>Trade</th><th>Context</th><th>Position</th><th>Result</th><th>Reasons</th></tr></thead><tbody>${items.slice(0, 100).map(t => {
      const pnl = pick(t, 'pnl');
      const r = pick(t, 'rMultiple', 'r_multiple');
      const entryAt = pick(t, 'entryTime', 'entry_time', 'createdAt', 'created_at');
      const targets = (() => { const raw = pick(t, 'targets'); if (raw == null) return '—'; try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr.map(x => `${money(x.price)} (${x.r}R, ${x.pct}%)`).join(' → ') : String(raw); } catch (_) { return String(raw); } })();
      return `<tr><td><b>${esc(pick(t, 'symbol') || '—')}</b> <span class="war-tag war-good">LONG</span><small>${day(entryAt)} ${time(entryAt)}${t.closedAt ? ` → ${time(t.closedAt)}` : ' · open'}</small></td>
        <td><small>regime ${esc(String(pick(t, 'regime') || '—'))} (${isNumber(pick(t, 'regimeScore')) ? number(pick(t, 'regimeScore'), 0) : '—'}) · RS ${isNumber(pick(t, 'relStrength')) ? number(pick(t, 'relStrength')) : '—'} · RVOL ${isNumber(pick(t, 'rvol')) ? number(pick(t, 'rvol')) : '—'} · ATR ${money(pick(t, 'atr'))} · OR ${money(pick(t, 'orLow'))}/${money(pick(t, 'orHigh'))} · VWAP ${money(pick(t, 'vwap'))}</small></td>
        <td><small>${isNumber(pick(t, 'size')) ? `${number(pick(t, 'size'), 0)} sh` : '—'} · entry ${money(pick(t, 'entryPrice'))} → exit ${money(pick(t, 'exitPrice'))}<br>stop ${money(pick(t, 'stopPrice'))} · targets ${esc(targets)} · risk ${money(pick(t, 'riskDollars'))}</small></td>
        <td class="${isNumber(pnl) ? (Number(pnl) >= 0 ? 'war-good' : 'war-bad') : ''}">${isNumber(pnl) ? money(pnl) : '—'}<small>${isNumber(r) ? `${number(r)}R` : ''}</small></td>
        <td class="war-reason"><small>Entry: ${esc(pick(t, 'entryReason') || '—')}<br>Exit: ${esc(pick(t, 'exitReason') || '—')}</small></td></tr>`;
    }).join('')}</tbody></table>`;
  }

  function renderDayState(data) {
    const dayState = data?.dayState || null;
    const pnl = pick(dayState, 'pnl');
    $('kiaanDayPnl').textContent = `Day P&L ${isNumber(pnl) ? money(pnl) : '—'}`;
    const el = $('kiaanLocks');
    const locks = data?.locks || null;
    if (!dayState) { el.innerHTML = '<p class="war-empty">No data yet.</p>'; return; }
    const lockLines = locks?.locked
      ? `<div class="war-row"><div><b>LOCKED</b><small>${esc(userView() ? 'The bot has stopped taking new trades for today.' : (locks.reasons || []).join(' · '))}</small></div><span class="war-tag war-bad">HALTED</span></div>`
      : '<div class="war-row"><div><b>Daily locks</b><small>No lock engaged. Loss %, loss streak, trade count and position caps are enforced by the engine before every entry.</small></div><span class="war-tag war-good">OK</span></div>';
    el.innerHTML = (userView()
      ? `<div class="war-row"><div><b>Day summary</b><small>P&amp;L ${isNumber(pnl) ? money(pnl) : '—'} · trades ${esc(pick(dayState, 'trades') ?? '—')} · wins ${esc(pick(dayState, 'wins') ?? '—')} · losses ${esc(pick(dayState, 'losses') ?? '—')}</small></div></div>`
      : `<div class="war-row"><div><b>Day summary</b><small>P&amp;L ${isNumber(pnl) ? money(pnl) : '—'} · trades ${esc(pick(dayState, 'trades') ?? '—')} · wins ${esc(pick(dayState, 'wins') ?? '—')} · losses ${esc(pick(dayState, 'losses') ?? '—')} · consec. losses ${esc(pick(dayState, 'consecLosses') ?? '—')} · exposure ${money(pick(dayState, 'exposureDollars'))}</small></div></div>`) + lockLines;
  }

  function renderAlerts(items) {
    const el = $('kiaanAlerts');
    if (!items?.length) { el.innerHTML = '<p class="war-empty">No alerts — no data yet.</p>'; return; }
    el.innerHTML = items.slice(0, 30).map(a => `<div class="war-row"><div><b>${esc(pick(a, 'kind'))}</b><small>${esc(pick(a, 'message'))}</small></div><strong>${time(pick(a, 'createdAt', 'created_at'))}</strong></div>`).join('');
  }

  /* ---- Settings ---- */

  function renderSettings() {
    const el = $('kiaanSettings');
    const rules = settingsView?.rules;
    if (!rules) { el.innerHTML = '<p class="war-empty">Settings unavailable.</p>'; return; }
    const field = (key, label, type, stepOrOptions) => {
      const value = rules[key];
      const id = `kiaanRule_${key}`;
      if (type === 'boolselect') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><select id="${id}" data-rule="${key}" data-bool="1"><option value="true" ${value === true ? 'selected' : ''}>On</option><option value="false" ${value === true ? '' : 'selected'}>Off</option></select></label>`;
      if (type === 'select') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><select id="${id}" data-rule="${key}">${stepOrOptions.map(o => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      if (type === 'time') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="time" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
      if (type === 'text') return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="text" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
      if (type === 'targets') {
        const text = Array.isArray(value) ? value.map(t => `${t.r}R:${t.pct}%`).join(', ') : '';
        return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="text" maxlength="64" data-rule="${key}" value="${esc(text)}"></label>`;
      }
      return `<label class="war-field" for="${id}"><span>${esc(label)}</span><input id="${id}" type="number" step="${stepOrOptions}" data-rule="${key}" value="${esc(value ?? '')}"></label>`;
    };
    if (settingsView?.viewer === 'user') {
      // User view: position size is the ONLY editable field on this page.
      el.innerHTML = `
      <fieldset class="war-fieldset"><legend>Position size</legend>
      ${field('fixedDollars', 'Position size — dollars per trade ($)', 'number', 50)}
      </fieldset>
      <p class="war-note">This is the only setting you can change. Everything else about how the bot trades is managed for you. Mode is <b>PAPER</b>.</p>`;
      return;
    }
    el.innerHTML = `
      <fieldset class="war-fieldset"><legend>Master switch</legend>
      <label class="war-field war-check" for="kiaanEnabled"><input id="kiaanEnabled" type="checkbox" data-enabled ${settingsView?.enabled ? 'checked' : ''}><span>Trading enabled</span></label>
      </fieldset>` +
      (settingsView?.uiSchema || []).map(group => `
      <fieldset class="war-fieldset"><legend>${esc(group.group)}</legend>
      ${group.fields.map(([key, label, type, extra]) => field(key, label, type, extra)).join('')}
      </fieldset>`).join('') +
      `<p class="war-note">Mode is <b>PAPER</b> — permanently. This bot has no live mode: the engine forces paper and there is no live connect or order path.</p>`;
  }

  function collectRules() {
    const rules = {};
    if (settingsView?.rules) {
      const deep = o => (o && typeof o === 'object' && !Array.isArray(o))
        ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deep(v)])) : o;
      Object.assign(rules, deep(settingsView.rules));
    }
    document.querySelectorAll('#kiaanSettings [data-rule]').forEach(input => {
      const key = input.dataset.rule;
      if (key === 'targets') {
        const parsed = [];
        let ok = input.value.trim() !== '';
        for (const part of input.value.split(',')) {
          const m = part.trim().match(/^([\d.]+)\s*R?\s*[:x]\s*([\d.]+)\s*%?$/i);
          if (!m) { ok = false; break; }
          parsed.push({ r: Number(m[1]), pct: Number(m[2]) });
        }
        if (ok && parsed.length) rules[key] = parsed;
        return;
      }
      if (input.dataset.bool === '1') rules[key] = input.value === 'true';
      else if (input.tagName === 'SELECT') rules[key] = /^\d+$/.test(input.value) ? Number(input.value) : input.value;
      else if (input.type === 'time' || input.type === 'text') { if (input.value.trim() !== '') rules[key] = input.value.trim(); }
      else if (input.value !== '') rules[key] = Number(input.value);
    });
    return rules;
  }

  /* ---- Actions ---- */

  async function toggleEnabled() {
    if (changing || !status?.connected) return;
    changing = true; revision++;
    try {
      await api('/api/kiaan/settings', { method: 'PUT', body: JSON.stringify({ enabled: !status.enabled }) });
      settingsView = await api('/api/kiaan/settings');
      status = await api('/api/kiaan/status');
      renderStatus(); renderSettings();
      notice(status.enabled ? 'Kiaan Bot resumed — the regime is read every minute of the session.' : 'Kiaan Bot paused. Existing positions remain under automatic management.');
    } catch (error) { notice(`Toggle failed: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  async function saveSettings() {
    if (changing) return;
    const rules = collectRules();
    const enabledInput = document.querySelector('#kiaanSettings [data-enabled]');
    changing = true; revision++;
    try {
      await api('/api/kiaan/settings', { method: 'PUT', body: JSON.stringify({ rules, ...(enabledInput ? { enabled: enabledInput.checked } : {}) }) });
      settingsView = await api('/api/kiaan/settings');
      status = await api('/api/kiaan/status');
      renderStatus(); renderSettings();
      notice('Settings saved.');
    } catch (error) { notice(`Settings not saved: ${error.message}`, true); }
    finally { changing = false; renderStatus(); }
  }
  async function refresh() {
    if (!mounted || refreshing || changing) return;
    refreshing = true;
    const startedRevision = revision;
    const results = await Promise.allSettled([
      api('/api/kiaan/status'), api('/api/kiaan/dashboard'), api('/api/kiaan/trades'),
      api('/api/kiaan/journal'), api('/api/kiaan/alerts'),
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
      renderPositions(dash.positions);
      renderDayState(dash);
    } else {
      $('kiaanRegime').innerHTML = `<p class="war-empty war-unavailable">Dashboard unavailable: ${esc(fail(1))}</p>`;
      $('kiaanPositions').innerHTML = `<p class="war-empty war-unavailable">Positions unavailable: ${esc(fail(1))}</p>`;
      $('kiaanLocks').innerHTML = `<p class="war-empty war-unavailable">Locks unavailable: ${esc(fail(1))}</p>`;
    }
    if (get(2)) renderJournal(get(2).trades || get(2)); else $('kiaanJournal').innerHTML = `<p class="war-empty war-unavailable" style="padding:13px 18px">Journal unavailable: ${esc(fail(2))}</p>`;
    if (get(3)) renderDecisions(get(3)); else $('kiaanDecisions').innerHTML = `<p class="war-empty war-unavailable">Decisions unavailable: ${esc(fail(3))}</p>`;
    if (get(4)) renderAlerts(get(4).alerts || get(4)); else $('kiaanAlerts').innerHTML = `<p class="war-empty war-unavailable">Alerts unavailable: ${esc(fail(4))}</p>`;
    if (!settingsView) { try { settingsView = await api('/api/kiaan/settings'); renderSettings(); } catch (_) { /* settings panel keeps its empty state */ } }
  }

  async function open() {
    shell(); mounted = true;
    $('kiaanEnabledToggle').onclick = toggleEnabled;
    $('kiaanSave').onclick = saveSettings;
    try { settingsView = await api('/api/kiaan/settings'); renderSettings(); } catch (_) {}
    await refresh(); if (!mounted) return; clearInterval(polling); polling = setInterval(refresh, 30000);
  }
  function pause() { mounted = false; clearInterval(polling); polling = null; }
  window.kiaanBot = { open, pause };
}());
