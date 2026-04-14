// ── Johnny Qureshi Finance — Trading Desk ────────────────────────────────────

const alpacaTrader = (() => {

  let connected     = false;
  let reconnecting  = false;   // true while we're waiting for checkCredentials after logout
  let alpacaMode    = 'live';
  let _pollFailures = 0;
  let _keepAlive    = null;
  const POLL_FAIL_LIMIT  = 3;
  const LS_WAS_CONNECTED = 'jqf_alpaca_was_connected';

  const $   = id => document.getElementById(id);
  const fmt = (n, d = 2) => n == null || isNaN(n) ? '--'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtV  = v => !v ? '--' : v >= 1e9 ? (v / 1e9).toFixed(1) + 'B'
    : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(v);
  const fmtDT = iso => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--';

  // ── API helper ─────────────────────────────────────────────────────────────
  async function apiFetch(url, opts = {}) {
    const { _silent, ...fetchOpts } = opts;
    const r = await fetch(url, { credentials: 'include', ...fetchOpts });
    if (r.status === 401) {
      if (!_silent && typeof showAuthOverlay === 'function') showAuthOverlay();
      throw new Error('session_expired');
    }
    return r.json();
  }

  // ── Market hours helper ────────────────────────────────────────────────────
  function marketStatus() {
    const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day  = et.getDay();
    const mins = et.getHours() * 60 + et.getMinutes();
    const open = day >= 1 && day <= 5 && mins >= 570 && mins < 960;
    return { open, day, mins };
  }

  // ── PDT awareness banner ───────────────────────────────────────────────────
  function renderPDTBanner(account) {
    const banner = $('atPDTBanner');
    if (!banner) return;
    const ms = marketStatus();

    const dayTradeCount = parseInt(account?.daytrade_count ?? 0);
    const equity        = parseFloat(account?.equity ?? 0);
    const isSmallAcct   = equity > 0 && equity < 25000;

    let html = '';
    if (!ms.open) {
      html = `<span class="at-pdt-info">Markets closed — trading hours 9:30 AM – 4:00 PM ET, Mon–Fri</span>`;
    }
    if (isSmallAcct && dayTradeCount >= 2) {
      html += `<span class="at-pdt-warn">⚠ PDT Warning — ${dayTradeCount}/3 day trades used. Accounts under $25k are limited to 3 day trades per 5 days.</span>`;
    }
    if (isSmallAcct && dayTradeCount >= 3) {
      html  = `<span class="at-pdt-block">🚫 PDT Limit Reached — ${dayTradeCount} day trades used. You cannot open new day trades until the 5-day window rolls over or your account exceeds $25k.</span>`;
    }

    banner.innerHTML   = html;
    banner.style.display = html ? '' : 'none';

    // Update PDT chip in header
    const chip      = $('atPDTChip');
    const dtEl      = $('atDayTrades');
    if (chip && isSmallAcct) {
      chip.style.display = '';
      chip.className = 'at-chip at-chip-pdt' + (dayTradeCount >= 3 ? ' pdt-block' : dayTradeCount >= 2 ? ' pdt-warn' : '');
      if (dtEl) dtEl.textContent = dayTradeCount + '/3';
    } else if (chip) {
      chip.style.display = 'none';
    }
  }

  // ── Connection status ──────────────────────────────────────────────────────
  // Three states: connected (green) | reconnecting (yellow) | disconnected (red)
  function updateConnStatus() {
    const dot   = $('atConnDot');
    const txt   = $('atConnText');
    const badge = $('atModeBadge');
    const btn   = $('atConnBtn');
    const chips = $('atAcctChips');
    const place = $('atPlaceBtn');

    if (connected) {
      if (dot)   dot.className = 'at-conn-dot dot-green';
      if (txt)   txt.textContent = 'Connected';
      if (badge) { badge.textContent = alpacaMode.toUpperCase(); badge.className = 'at-mode-badge mode-' + (alpacaMode === 'live' ? 'live' : 'paper'); }
      if (btn)   btn.textContent = 'Account Settings';
      if (chips) chips.style.display = '';
      if (place) { place.disabled = false; place.textContent = 'Place Order'; }
    } else if (reconnecting) {
      // Credentials exist in DB — just waiting for session to verify them
      if (dot)   dot.className = 'at-conn-dot dot-yellow';
      if (txt)   txt.textContent = 'Reconnecting…';
      if (badge) { badge.textContent = 'RECONNECTING'; badge.className = 'at-mode-badge mode-paper'; }
      if (btn)   btn.textContent = 'Account Settings';
      if (chips) chips.style.display = 'none';
      if (place) { place.disabled = true; place.textContent = 'Reconnecting…'; }
    } else {
      if (dot)   dot.className = 'at-conn-dot dot-red';
      if (txt)   txt.textContent = 'Not connected';
      if (badge) { badge.textContent = 'DISCONNECTED'; badge.className = 'at-mode-badge mode-paper'; }
      if (btn)   btn.textContent = 'Connect Alpaca';
      if (chips) chips.style.display = 'none';
      if (place) { place.disabled = true; place.textContent = 'Connect Alpaca to Trade'; }
    }
  }

  // ── Account snapshot ───────────────────────────────────────────────────────
  async function loadAccount() {
    try {
      const a = await apiFetch('/api/alpaca/account');
      if (a.error) return;
      if ($('atEquity')) $('atEquity').textContent = '$' + fmt(a.equity);
      if ($('atCash'))   $('atCash').textContent   = '$' + fmt(a.cash);
      if ($('atBP'))     $('atBP').textContent     = '$' + fmt(a.buying_power);
      renderPDTBanner(a);
    } catch (e) {
      if (e.message !== 'session_expired') console.warn('[AT] Account load:', e.message);
    }
  }

  // ── Positions ──────────────────────────────────────────────────────────────
  async function loadPositions() {
    try {
      const pos = await apiFetch('/api/alpaca/positions');
      renderPositions(Array.isArray(pos) ? pos : []);
    } catch (e) {
      if (e.message !== 'session_expired') console.warn('[AT] Positions:', e.message);
    }
  }

  function renderPositions(positions) {
    const body    = $('atPositionsBody');
    const countEl = $('atPosCount');
    if (!body) return;
    if (countEl) countEl.textContent = positions.length;

    if (!positions.length) {
      body.innerHTML = '<div class="at-empty">No open positions</div>';
      return;
    }

    body.innerHTML = positions.map(p => {
      const pnl    = parseFloat(p.unrealized_pl ?? 0);
      const pnlPct = parseFloat(p.unrealized_plpc ?? 0) * 100;
      const up     = pnl >= 0;
      const qty    = parseFloat(p.qty ?? 0);
      const side   = qty >= 0 ? 'Long' : 'Short';
      return `<div class="at-pos-row">
        <div class="at-pos-left">
          <span class="at-pos-sym">${p.symbol}</span>
          <span class="at-pos-meta">${side} · ${Math.abs(qty)} shares · avg $${fmt(p.avg_entry_price)}</span>
        </div>
        <div class="at-pos-right">
          <span class="at-pos-px">$${fmt(p.current_price)}</span>
          <span class="at-pos-pnl ${up ? 'up' : 'down'}">${up ? '+' : ''}$${fmt(pnl)} (${up ? '+' : ''}${fmt(pnlPct)}%)</span>
        </div>
        <button class="at-close-btn" data-sym="${p.symbol}" title="Close position">✕</button>
      </div>`;
    }).join('');

    body.querySelectorAll('.at-close-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sym = btn.dataset.sym;
        if (!confirm(`Close ${sym} position?`)) return;
        btn.disabled = true; btn.textContent = '…';
        try {
          await apiFetch(`/api/alpaca/position/${sym}`, { method: 'DELETE' });
          loadPositions();
          loadAccount();
        } catch (e) { btn.disabled = false; btn.textContent = '✕'; alert('Error: ' + e.message); }
      });
    });
  }

  // ── Close ALL positions ─────────────────────────────────────────────────────
  async function closeAllPositions() {
    const btn = $('atCloseAllPos');
    if (!confirm('Close ALL open positions at market price? This cannot be undone.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Closing…'; }
    try {
      const r = await apiFetch('/api/alpaca/positions', { method: 'DELETE' });
      if (r.ok !== false) {
        setTimeout(() => { loadPositions(); loadAccount(); }, 1500);
      }
    } catch (e) {
      alert('Could not close positions: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✕ Close All'; }
    }
  }

  // ── Pending orders ──────────────────────────────────────────────────────────
  async function loadOrders() {
    try {
      const orders = await apiFetch('/api/alpaca/orders');
      renderOrders(Array.isArray(orders) ? orders : []);
    } catch (e) {
      if (e.message !== 'session_expired') console.warn('[AT] Orders:', e.message);
    }
  }

  function renderOrders(orders) {
    const body = $('atOrdersBody');
    if (!body) return;
    const recent = orders.slice(0, 12);
    if (!recent.length) { body.innerHTML = '<div class="at-empty">No pending orders</div>'; return; }

    body.innerHTML = recent.map(o => {
      const filled   = parseFloat(o.filled_avg_price ?? 0);
      const status   = o.status;
      const sCls     = status === 'filled' ? 'at-ord-filled' : status === 'canceled' ? 'at-ord-cancelled' : 'at-ord-pending';
      const sideUp   = o.side === 'buy';
      return `<div class="at-ord-row">
        <div class="at-ord-left">
          <span class="at-ord-sym">${o.symbol}</span>
          <span class="at-ord-meta">${o.side?.toUpperCase()} · ${o.qty || o.notional + ' notional'} · ${fmtDT(o.created_at)}</span>
        </div>
        <div class="at-ord-right">
          ${filled ? `<span class="at-ord-px">$${fmt(filled)}</span>` : ''}
          <span class="at-ord-status ${sCls}">${status}</span>
          ${status === 'new' || status === 'partially_filled' ? `<button class="at-cancel-btn" data-id="${o.id}" title="Cancel">✕</button>` : ''}
        </div>
      </div>`;
    }).join('');

    body.querySelectorAll('.at-cancel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '…';
        try {
          await apiFetch(`/api/alpaca/order/${btn.dataset.id}`, { method: 'DELETE' });
          loadOrders();
        } catch (e) { btn.disabled = false; btn.textContent = '✕'; }
      });
    });
  }

  // ── Check credentials ──────────────────────────────────────────────────────
  async function checkCredentials() {
    // If we know the user was previously connected, show "Reconnecting…" immediately
    // so there is never a red "Disconnected" flash between logout and re-login.
    if (!connected && localStorage.getItem(LS_WAS_CONNECTED)) {
      reconnecting = true;
      updateConnStatus();
    }
    try {
      const r = await apiFetch('/api/alpaca/credentials', { _silent: true });
      if (r.connected) {
        reconnecting = false;
        connected    = true;
        alpacaMode   = r.mode || 'live';
        localStorage.setItem(LS_WAS_CONNECTED, '1');
        updateConnStatus();
        loadAccount();
        loadPositions();
        loadOrders();
        startKeepAlive();
      } else {
        // No creds in DB — fully disconnected (user never connected or explicitly removed keys)
        reconnecting = false;
        connected    = false;
        localStorage.removeItem(LS_WAS_CONNECTED);
        updateConnStatus();
      }
    } catch (e) {
      if (e.message !== 'session_expired') console.warn('[AT] checkCreds:', e.message);
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function showModal() {
    const m = $('trdModal'); if (m) m.style.display = 'flex';
    if ($('trdModalErr')) $('trdModalErr').textContent = '';
    if ($('trdModalDisc')) $('trdModalDisc').style.display = connected ? '' : 'none';
    document.querySelectorAll('.trd-mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === alpacaMode));
    const w = $('trdLiveWarn'); if (w) w.style.display = alpacaMode === 'live' ? '' : 'none';
  }
  function hideModal() { const m = $('trdModal'); if (m) m.style.display = 'none'; }

  async function saveCredentials() {
    const key    = $('trdApiKey')?.value.trim();
    const secret = $('trdApiSecret')?.value.trim();
    const errEl  = $('trdModalErr');
    if (!key || !secret) { if (errEl) errEl.textContent = 'Both fields required.'; return; }
    const btn = $('trdModalSave');
    btn.disabled = true; btn.textContent = 'Connecting…';
    if (errEl) errEl.textContent = '';
    try {
      const r = await apiFetch('/api/alpaca/credentials', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ apiKey: key, apiSecret: secret, mode: alpacaMode }),
      });
      if (r.error) throw new Error(r.error);
      const acct = await apiFetch('/api/alpaca/account');
      if (acct.error) throw new Error('Credentials saved but account check failed: ' + acct.error);
      connected    = true;
      reconnecting = false;
      alpacaMode   = r.mode || 'live';
      _pollFailures = 0;
      localStorage.setItem(LS_WAS_CONNECTED, '1');
      hideModal();
      updateConnStatus();
      loadAccount();
      loadPositions();
      loadOrders();
      startKeepAlive();
    } catch (e) { if (errEl) errEl.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = 'Connect'; }
  }

  async function disconnect() {
    await apiFetch('/api/alpaca/credentials', { method: 'DELETE' });
    connected    = false;
    reconnecting = false;
    localStorage.removeItem(LS_WAS_CONNECTED);
    stopKeepAlive();
    updateConnStatus();
    hideModal();
    const posBody = $('atPositionsBody');
    if (posBody) posBody.innerHTML = '<div class="at-empty">Connect Alpaca to view live positions</div>';
    const ordBody = $('atOrdersBody');
    if (ordBody) ordBody.innerHTML = '<div class="at-empty">No recent orders</div>';
    const banner = $('atPDTBanner');
    if (banner) banner.style.display = 'none';
  }

  // ── Keep-alive ─────────────────────────────────────────────────────────────
  function startKeepAlive() {
    stopKeepAlive();
    _keepAlive = setInterval(async () => {
      try { await apiFetch('/api/auth/me', { _silent: true }); } catch {}
    }, 10 * 60 * 1000);
  }
  function stopKeepAlive() { clearInterval(_keepAlive); _keepAlive = null; }

  // ── Bind events ────────────────────────────────────────────────────────────
  function bindEvents() {
    $('atConnBtn')?.addEventListener('click', showModal);
    $('trdModalClose')?.addEventListener('click', hideModal);
    $('trdModalSave')?.addEventListener('click', saveCredentials);
    $('trdModalDisc')?.addEventListener('click', () => { if (confirm('Disconnect Alpaca?')) disconnect(); });

    document.querySelectorAll('.trd-mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.trd-mode-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        alpacaMode = tab.dataset.mode;
        const w = $('trdLiveWarn'); if (w) w.style.display = alpacaMode === 'live' ? '' : 'none';
      });
    });

    $('atRefreshPos')?.addEventListener('click', () => { loadPositions(); loadAccount(); });
    $('atRefreshOrders')?.addEventListener('click', loadOrders);
    $('atCloseAllPos')?.addEventListener('click', closeAllPositions);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function reset() {
    stopKeepAlive();
    connected = false;
    // If credentials were previously stored, show "Reconnecting…" (yellow) instead of
    // "Disconnected" (red). The creds are still in the DB — this is just a session logout.
    reconnecting = !!localStorage.getItem(LS_WAS_CONNECTED);
    updateConnStatus();
  }

  function open() {
    checkCredentials();
  }

  function init() {
    bindEvents();
    updateConnStatus();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && connected) {
        loadAccount(); loadPositions(); loadOrders();
      }
    });
  }

  return { init, open, checkCredentials, reset };

})();

document.addEventListener('DOMContentLoaded', () => alpacaTrader.init());


// All 5 bots are always active — no toggle needed. They run automatically
// for every user who has Alpaca credentials connected, scanning the full
// MASTER_UNIVERSE every 5 minutes during market hours.

// ── Simulator Status Panel (fully automatic — no manual buttons) ──────────────
const simPanel = (() => {
  const BOT_LABELS = {
    countertrend: 'CT', orb: 'ORB', swing: 'Swing'
  };
  const STATUS_INTERVAL  = 60  * 1000;  // refresh status every 60 s
  const WHALE_INTERVAL   = 5 * 60 * 1000; // refresh whale data every 5 min
  let statusTimer = null;
  let whaleTimer  = null;
  let isVisible   = false;

  function fmt$(n) {
    if (n == null) return '—';
    return '$' + parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  function nowStr() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  }

  async function loadStatus() {
    try {
      const data = await fetch('/api/bots/status').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

      // Universe + last-refresh stamp
      const uEl = document.getElementById('atSimUniverseSize');
      if (uEl) uEl.textContent = `Scanning ${data.universeSize} symbols`;
      const lrEl = document.getElementById('atSimLastRefresh');
      if (lrEl) lrEl.textContent = `Last updated ${nowStr()}`;

      // Auto-badge label
      const lbl = document.getElementById('atSimAutoLabel');
      if (lbl) lbl.textContent = 'Live — updates every 60s';

      // Recent bot trades
      const tbody = document.getElementById('atSimTradesTbody');
      if (tbody) {
        if (!data.recentTrades?.length) {
          tbody.innerHTML = `<tr><td colspan="7" class="at-sim-empty">No bot trades on record yet</td></tr>`;
        } else {
          tbody.innerHTML = data.recentTrades.map(t => `
            <tr>
              <td><strong>${t.symbol}</strong></td>
              <td>${BOT_LABELS[t.strategy] || t.strategy}</td>
              <td>${(t.side||'').toUpperCase()}</td>
              <td>${t.shares != null ? parseFloat(t.shares).toFixed(0) : '—'}</td>
              <td>${fmt$(t.entry_price)}</td>
              <td class="${t.status==='open'?'at-sim-status-open':'at-sim-status-closed'}">${(t.status||'').toUpperCase()}</td>
              <td>${fmtTime(t.created_at)}</td>
            </tr>`).join('');
        }
      }
    } catch (e) {
      console.warn('[simPanel] status load error:', e.message);
    }
  }

  async function loadWhale() { /* data used by bots server-side only — no UI */ }

  function startTimers() {
    if (statusTimer) return;
    loadStatus();
    statusTimer = setInterval(loadStatus, STATUS_INTERVAL);
  }

  function stopTimers() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (whaleTimer)  { clearInterval(whaleTimer);  whaleTimer  = null; }
  }

  async function clearLog() {
    const btn = document.getElementById('atClearLog');
    if (!confirm('Clear all bot trade log entries? This cannot be undone.')) return;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/bots/clear-log', { method: 'DELETE' }).then(r => r.json());
      if (res.ok) {
        const tbody = document.getElementById('atSimTradesTbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="at-sim-empty">Log cleared (${res.deleted} entries removed)</td></tr>`;
      }
    } catch (e) {
      console.warn('[simPanel] clear-log error:', e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function init() {
    document.getElementById('atClearLog')?.addEventListener('click', clearLog);
    // Auto-start when Trading Desk tab becomes active
    document.addEventListener('pageChanged', (e) => {
      if (e.detail?.page === 'trading') {
        isVisible = true;
        startTimers();
      } else {
        isVisible = false;
        stopTimers(); // pause fetches when tab not visible
      }
    });
    // If already on trading page when JS loads
    if (document.getElementById('page-trading')?.classList.contains('active')) {
      isVisible = true;
      startTimers();
    }
  }

  function load() { loadStatus(); loadWhale(); }
  return { init, load, loadStatus, loadWhale };
})();

// ── Bot toggle switches ────────────────────────────────────────────────────────
async function initBotToggles() {
  const checkboxes = document.querySelectorAll('.bot-toggle-cb');
  if (!checkboxes.length) return;

  // Load saved states from server
  try {
    const states = await fetch('/api/bots/toggles').then(r => r.json());
    checkboxes.forEach(cb => {
      const bot = cb.dataset.bot;
      if (bot && states[bot] !== undefined) {
        cb.checked = states[bot];
        updateToggleUI(cb);
      }
    });
  } catch (e) {
    console.warn('[bot-toggles] Could not load toggle states:', e.message);
  }

  // Wire up change handlers
  checkboxes.forEach(cb => {
    cb.addEventListener('change', async () => {
      const bot     = cb.dataset.bot;
      const enabled = cb.checked;
      updateToggleUI(cb);
      try {
        await fetch('/api/bots/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot, enabled })
        });
      } catch (e) {
        console.warn('[bot-toggles] Toggle save failed:', e.message);
        cb.checked = !enabled; // revert on failure
        updateToggleUI(cb);
      }
    });
  });
}

function updateToggleUI(cb) {
  const label = cb.closest('.bot-toggle')?.querySelector('.bot-toggle-label');
  if (label) label.textContent = cb.checked ? 'ON' : 'OFF';
  const card  = cb.closest('.at-bot-card');
  if (card) card.classList.toggle('at-bot-card--disabled', !cb.checked);
}

// ── Global Trading Settings module ───────────────────────────────────────────
async function initTradeSettings() {
  const mod = document.getElementById('tradeSettingsModule');
  if (!mod) return;

  const btnPct    = document.getElementById('tsBtnPct');
  const btnFixed  = document.getElementById('tsBtnFixed');
  const prefix    = document.getElementById('tsInputPrefix');
  const input     = document.getElementById('tsPositionValue');
  const levGroup  = document.getElementById('tsLevGroup');
  const savedBadge = document.getElementById('tsSavedBadge');

  let currentMode = 'pct';
  let currentLev  = 1;
  let saveTimer   = null;

  function setMode(mode) {
    currentMode = mode;
    btnPct.classList.toggle('active', mode === 'pct');
    btnFixed.classList.toggle('active', mode === 'fixed');
    prefix.textContent = mode === 'pct' ? '%' : '$';
    input.step = mode === 'pct' ? '1'   : '100';
    input.min  = mode === 'pct' ? '1'   : '1';
    input.placeholder = mode === 'pct' ? '15' : '5000';
  }

  function setLev(lev) {
    currentLev = lev;
    levGroup.querySelectorAll('.ts-lev-btn').forEach(b => b.classList.toggle('active', +b.dataset.lev === lev));
  }

  function flashSaved() {
    savedBadge.textContent = 'Auto-saved ✓';
    savedBadge.classList.add('visible');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savedBadge.classList.remove('visible'), 2200);
  }

  async function persist() {
    const val = parseFloat(input.value);
    if (!val || val <= 0) return;
    try {
      await fetch('/api/trade-settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          position_mode:   currentMode,
          position_pct:    currentMode === 'pct'   ? val : 15,
          position_amount: currentMode === 'fixed' ? val : 5000,
          leverage:        currentLev,
        }),
      });
      flashSaved();
    } catch (_) {}
  }

  // Load current settings from server
  try {
    const data = await fetch('/api/trade-settings', { credentials: 'include' }).then(r => r.json());
    setMode(data.position_mode || 'pct');
    setLev(data.leverage || 1);
    input.value = data.position_mode === 'fixed'
      ? (data.position_amount || 5000)
      : (data.position_pct    || 15);
  } catch (_) {}

  btnPct.addEventListener('click',   () => { setMode('pct');   persist(); });
  btnFixed.addEventListener('click', () => { setMode('fixed'); persist(); });

  levGroup.querySelectorAll('.ts-lev-btn').forEach(btn => {
    btn.addEventListener('click', () => { setLev(+btn.dataset.lev); persist(); });
  });

  input.addEventListener('change', persist);
  input.addEventListener('blur',   persist);
}

// ── Strategy Simulation ───────────────────────────────────────────────────────
const stratSim = (() => {
  const $ = id => document.getElementById(id);

  function fmtDollar(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtNum(n, d=2)  { return n == null ? '—' : Number(n).toFixed(d); }

  function badge(confirmed, warn) {
    if (warn)      return '<span class="sim-card-badge sim-badge-warn">⚡ Partial</span>';
    if (confirmed) return '<span class="sim-card-badge sim-badge-fire">🔥 Signal!</span>';
    return '<span class="sim-card-badge sim-badge-none">No Signal</span>';
  }

  function condPill(label, pass) {
    return `<span class="sim-cond ${pass ? 'pass' : 'fail'}">${label}</span>`;
  }

  function renderSwingCard(sig, label) {
    if (!sig) return `<div class="sim-card signal-no"><div class="sim-card-head"><span class="sim-card-name">${label}</span>${badge(false)}</div><div class="sim-card-fails"><div class="sim-fail-item">No data returned</div></div></div>`;
    const ok = sig.confirmed;
    const has = sig.cond1 != null;
    return `<div class="sim-card ${ok ? 'signal-yes' : 'signal-no'}">
      <div class="sim-card-head">
        <span class="sim-card-name">Swing — ${label}</span>
        ${badge(ok)}
      </div>
      ${has ? `<div class="sim-cond-list">
        ${condPill('C1',sig.cond1)}${condPill('C2',sig.cond2)}${condPill('C3',sig.cond3)}${condPill('C4',sig.cond4)}${condPill('C5',sig.cond5)}
      </div>` : ''}
      ${ok && sig.trade ? `<div class="sim-card-trade">
        <div class="sim-trade-row"><span class="sim-trade-label">Symbol</span><span class="sim-trade-val blue">${sig.trade.symbol}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Entry</span><span class="sim-trade-val">${fmtDollar(sig.trade.price)}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Shares</span><span class="sim-trade-val">${sig.trade.shares}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Position</span><span class="sim-trade-val green">${fmtDollar(sig.trade.dollars)}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Stop</span><span class="sim-trade-val red">${fmtDollar(sig.trade.sl)}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">TP1 / TP2 / TP3</span><span class="sim-trade-val">${fmtDollar(sig.trade.tp1)} / ${fmtDollar(sig.trade.tp2)} / ${fmtDollar(sig.trade.tp3)}</span></div>
      </div>` : ''}
      ${!ok && sig.failReasons?.length ? `<div class="sim-card-fails">${sig.failReasons.map(r => `<div class="sim-fail-item">${r}</div>`).join('')}</div>` : ''}
    </div>`;
  }

  function renderCTCard(ct) {
    const ok = ct.bestTrade != null;
    const tr = ct.bestTrade;
    return `<div class="sim-card ${ok ? 'signal-yes' : 'signal-no'}">
      <div class="sim-card-head">
        <span class="sim-card-name">Countertrend (CT)</span>
        ${badge(ok)}
      </div>
      <div class="sim-trade-row" style="font-size:.73rem;color:#8b949e;">Scanned ${ct.scanned} symbols · ${ct.confirmedCount} confirmed</div>
      ${ok ? `<div class="sim-card-trade">
        <div class="sim-trade-row"><span class="sim-trade-label">Symbol</span><span class="sim-trade-val blue">${tr.symbol}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Signal</span><span class="sim-trade-val">${tr.signalType}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Direction</span><span class="sim-trade-val ${tr.side.includes('BUY') ? 'green' : 'red'}">${tr.side}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Price</span><span class="sim-trade-val">${fmtDollar(tr.price)}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Shares</span><span class="sim-trade-val">${tr.shares}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Position</span><span class="sim-trade-val green">${fmtDollar(tr.dollars)}</span></div>
        <div class="sim-trade-row"><span class="sim-trade-label">Stop / Target</span><span class="sim-trade-val">${fmtDollar(tr.sl)} / ${fmtDollar(tr.tp)}</span></div>
        ${tr.rsi != null ? `<div class="sim-trade-row"><span class="sim-trade-label">RSI</span><span class="sim-trade-val">${fmtNum(tr.rsi,1)}</span></div>` : ''}
      </div>` : `<div class="sim-card-fails"><div class="sim-fail-item">No confirmed CT setup in universe</div></div>`}
    </div>`;
  }

  function renderORBCard(orb) {
    if (!orb) return `<div class="sim-card signal-no"><div class="sim-card-head"><span class="sim-card-name">ORB</span>${badge(false)}</div></div>`;
    const ok = orb.confirmed;
    const warn = !orb.confirmed && orb.breakout && orb.breakout !== 'NONE';
    return `<div class="sim-card ${ok ? 'signal-yes' : warn ? 'signal-warn' : 'signal-no'}">
      <div class="sim-card-head">
        <span class="sim-card-name">ORB (Opening Range)</span>
        ${badge(ok, warn)}
      </div>
      <div class="sim-card-trade">
        <div class="sim-trade-row"><span class="sim-trade-label">SPY Breakout</span><span class="sim-trade-val ${ok || warn ? 'green' : ''}">${orb.breakout || 'NONE'}</span></div>
        ${orb.orbHigh ? `<div class="sim-trade-row"><span class="sim-trade-label">ORB Range</span><span class="sim-trade-val">${fmtDollar(orb.orbLow)} – ${fmtDollar(orb.orbHigh)}</span></div>` : ''}
        ${orb.vix    ? `<div class="sim-trade-row"><span class="sim-trade-label">VIX</span><span class="sim-trade-val ${orb.vix>35?'red':''}">${fmtNum(orb.vix,1)} ${orb.vixOk?'✓':'✗'}</span></div>` : ''}
        ${orb.rsi    ? `<div class="sim-trade-row"><span class="sim-trade-label">RSI</span><span class="sim-trade-val">${fmtNum(orb.rsi,1)}</span></div>` : ''}
        <div class="sim-trade-row"><span class="sim-trade-label">VWAP Aligned</span><span class="sim-trade-val">${orb.vwapAligned ?? '—'}</span></div>
      </div>
      ${orb.reason && !ok ? `<div class="sim-card-fails"><div class="sim-fail-item">${orb.reason}</div></div>` : ''}
    </div>`;
  }

  async function run() {
    const btn = $('stratSimBtn');
    const loading = $('stratSimLoading');
    const results = $('stratSimResults');
    const meta    = $('stratSimMeta');
    const cards   = $('stratSimCards');
    const ctDetail= $('stratSimCTDetail');
    const ctTbody = $('stratSimCTTbody');
    const msgEl   = $('stratSimLoadingMsg');

    btn.disabled = true;
    loading.style.display = 'flex';
    results.style.display = 'none';
    ctDetail.style.display = 'none';

    // Animated loading messages
    const msgs = [
      'Running CT signal scan across universe…',
      'Computing ORB breakout levels…',
      'Analysing Swing weekly charts…',
      'Calculating hypothetical position sizes…',
    ];
    let mi = 0;
    const msgTimer = setInterval(() => { msgEl.textContent = msgs[++mi % msgs.length]; }, 3000);

    try {
      const r = await fetch('/api/bots/simulate', { method: 'POST', credentials: 'include' });
      const d = await r.json();
      clearInterval(msgTimer);
      if (!r.ok) throw new Error(d.error || 'Simulation failed');

      const { meta: m, ct, orb, swing } = d;

      // Meta bar
      meta.innerHTML = `
        <span>Equity: <strong>${fmtDollar(m.equity)}</strong>${!m.alpacaConnected ? ' <span style="color:#d29922">(Alpaca not connected — using $10k placeholder)</span>' : ''}</span>
        <span>Position Value: <strong>${fmtDollar(m.positionValue)}</strong></span>
        <span>Mode: <strong>${m.settings.mode === 'fixed' ? 'Fixed $'+m.settings.fixed : m.settings.pct+'% equity'}</strong></span>
        <span>Leverage: <strong>${m.settings.leverage}×</strong></span>
        <span style="margin-left:auto;color:#484f58;">Run at ${new Date(m.ts).toLocaleTimeString()}</span>
      `;

      // Attach trade objects to swing signals
      const tradeMap = {};
      swing.trades.forEach(t => { tradeMap[t.symbol] = t; });
      if (swing.spy)     swing.spy.trade     = tradeMap['SPY'] || null;
      if (swing.qqq)     swing.qqq.trade     = tradeMap['QQQ'] || null;
      if (swing.inverse) swing.inverse.trade = tradeMap['SH']  || null;

      // Build bot cards
      cards.innerHTML = [
        renderCTCard(ct),
        renderORBCard(orb),
        renderSwingCard(swing.spy,     'SPY Long'),
        renderSwingCard(swing.qqq,     'QQQ Long'),
        renderSwingCard(swing.inverse, 'SH Inverse'),
      ].join('');

      // CT signals table
      if (ct.topSignals?.length) {
        ctTbody.innerHTML = ct.topSignals.map(s => `<tr>
          <td>${s.symbol}</td>
          <td>${s.signalType}</td>
          <td>${s.direction || '—'}</td>
          <td>${fmtDollar(s.price)}</td>
          <td>${s.rsi != null ? fmtNum(s.rsi,1) : '—'}</td>
          <td>${fmtNum(s.score,1)}</td>
          <td class="${s.confirmed ? 'sim-ct-confirmed' : 'sim-ct-watching'}">${s.confirmed ? '✓ Confirmed' : 'Watching'}</td>
        </tr>`).join('');

        const ctDetailBtn = document.createElement('button');
        ctDetailBtn.className = 'sim-show-ct-btn';
        ctDetailBtn.textContent = `▸ Show CT signals table (${ct.topSignals.length} symbols)`;
        ctDetailBtn.onclick = () => {
          const vis = ctDetail.style.display !== 'none';
          ctDetail.style.display = vis ? 'none' : 'block';
          ctDetailBtn.textContent = `${vis ? '▸' : '▾'} ${vis ? 'Show' : 'Hide'} CT signals table (${ct.topSignals.length} symbols)`;
        };
        cards.appendChild(ctDetailBtn);
      }

      loading.style.display = 'none';
      results.style.display = 'block';
    } catch (err) {
      clearInterval(msgTimer);
      loading.style.display = 'none';
      cards.innerHTML = `<div style="color:#f85149;font-size:.85rem;padding:12px 0;">Simulation error: ${err.message}</div>`;
      results.style.display = 'block';
    }
    btn.disabled = false;
  }

  function init() {
    const btn = document.getElementById('stratSimBtn');
    if (btn) btn.addEventListener('click', run);
  }
  return { init };
})();

// ── Market Calendar & Macro Context Card ─────────────────────────────────────
const macroCal = (() => {
  function chipClass(bias) {
    if (!bias) return 'mc-chip-neut';
    const b = bias.toLowerCase();
    if (b === 'bullish') return 'mc-chip-bull';
    if (b === 'bearish') return 'mc-chip-bear';
    if (b === 'volatile' || b === 'caution') return 'mc-chip-warn';
    return 'mc-chip-neut';
  }
  function sizeBarColor(mult) {
    if (mult >= 1.0) return '#3fb950';
    if (mult >= 0.8) return '#d29922';
    return '#f85149';
  }
  function render(d, el) {
    let html = '';
    if (d.hardBlock) {
      html += `<div class="mc-block-banner">⛔ HARD BLOCK ACTIVE: ${d.hardBlockReason || 'Quad-witch morning — no new entries'}</div>`;
    }
    html += '<div class="macro-cal-grid">';

    // Seasonal month tile
    const m = d.monthly || {};
    const bias = m.bias || 'Neutral';
    html += `<div class="mc-tile">
      <div class="mc-tile-label">Seasonal Month</div>
      <div class="mc-tile-value">${m.label || '—'}</div>
      <div class="mc-tile-sub">Hist. avg: <b>${m.avgReturn != null ? (m.avgReturn > 0 ? '+' : '') + m.avgReturn + '%' : '—'}</b></div>
      <span class="mc-chip ${chipClass(bias)}">${bias}</span>
    </div>`;

    // OpEx tile
    const opexChip = d.isOpExDay ? 'mc-chip-warn' : d.inOpExWeek ? 'mc-chip-warn' : 'mc-chip-neut';
    const opexLabel = d.isOpExDay ? 'OpEx Day' : d.inOpExWeek ? 'OpEx Week' : `${d.daysToOpEx ?? '?'}d to OpEx`;
    html += `<div class="mc-tile">
      <div class="mc-tile-label">Options Expiry</div>
      <div class="mc-tile-value">${d.opExDate || '—'}</div>
      <div class="mc-tile-sub">${d.isQuadWitch ? '⚠ Quad-witch' : 'Monthly OpEx'}</div>
      <span class="mc-chip ${opexChip}">${opexLabel}</span>
    </div>`;

    // Earnings season tile
    const inEarnings = !!d.earningsSeason;
    const esChip = inEarnings ? 'mc-chip-warn' : 'mc-chip-neut';
    html += `<div class="mc-tile">
      <div class="mc-tile-label">Earnings Season</div>
      <div class="mc-tile-value">${inEarnings ? d.earningsSeason + ' Earnings' : 'Off-Season'}</div>
      <div class="mc-tile-sub">${inEarnings ? 'Major reports in progress' : 'No major earnings window'}</div>
      <span class="mc-chip ${esChip}">${inEarnings ? 'Elevated Vol.' : 'Normal'}</span>
    </div>`;

    // Position sizing tile
    const pct = Math.round((d.sizeMult || 1) * 100);
    const barColor = sizeBarColor(d.sizeMult || 1);
    html += `<div class="mc-tile">
      <div class="mc-tile-label">Bot Size Multiplier</div>
      <div class="mc-tile-value">${d.sizeMult != null ? d.sizeMult.toFixed(2) : '1.00'}×</div>
      <div class="mc-size-bar-wrap">
        <div class="mc-size-bar-bg"><div class="mc-size-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
        <span class="mc-size-bar-pct">${pct}%</span>
      </div>
      <div class="mc-tile-sub">Stop adjust: ${d.stopAdjust != null ? d.stopAdjust.toFixed(2) : '1.00'}×</div>
    </div>`;

    // Year context tile (midterm / election cycle)
    const yearCtx = d.isMidtermYear ? 'Midterm Election Year'
                  : d.isPreMidterm  ? 'Pre-Midterm Year'
                  : d.isPostMidterm ? 'Post-Midterm Year'
                  : d.isVolatilePreElection ? 'Pre-Election Volatility'
                  : null;
    if (yearCtx) {
      html += `<div class="mc-tile">
        <div class="mc-tile-label">Election Cycle</div>
        <div class="mc-tile-value" style="font-size:.85rem">${yearCtx}</div>
        <span class="mc-chip mc-chip-warn">Cycle Active</span>
      </div>`;
    }

    // Notes list (spans full width)
    if (d.sizeNotes && d.sizeNotes.length) {
      html += `<ul class="mc-notes-list">`;
      d.sizeNotes.forEach(n => { html += `<li>${n}</li>`; });
      html += `</ul>`;
    }

    html += '</div>';
    el.innerHTML = html;
  }

  async function load() {
    const el = document.getElementById('macroCalBody');
    if (!el) return;
    el.innerHTML = '<div class="macro-cal-loading">Loading macro context…</div>';
    try {
      const r = await fetch('/api/macro-context');
      if (!r.ok) throw new Error(r.statusText);
      const d = await r.json();
      render(d, el);
    } catch (e) {
      el.innerHTML = `<div class="macro-cal-loading" style="color:#f85149">Failed to load: ${e.message}</div>`;
    }
  }

  function init() {
    load();
    const btn = document.getElementById('macroCalRefresh');
    if (btn) btn.addEventListener('click', load);
  }

  return { init, load };
})();

document.addEventListener('DOMContentLoaded', () => {
  simPanel.init();
  initBotToggles();
  initTradeSettings();
  stratSim.init();
  macroCal.init();
});
