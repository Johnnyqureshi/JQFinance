// ── Johnny Qureshi Finance — Trading Desk ────────────────────────────────────

const alpacaTrader = (() => {

  let connected     = false;
  let reconnecting  = false;   // true while we're waiting for checkCredentials after logout
  // Paper is the safe default for a new/disconnected session. The server
  // remains authoritative once credentials have been loaded.
  let alpacaMode    = 'paper';
  let _pollFailures = 0;
  let _keepAlive    = null;
  let modalConnection = 'manual';
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

  // Tracks which modes have stored credentials (updated by checkCredentials)
  let paperConnected = false;
  let liveConnected  = false;

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

    // Mode switcher pills — show when at least one account is stored
    _renderModeSwitcher();
  }

  // ── Mode switcher pill bar ─────────────────────────────────────────────────
  function _renderModeSwitcher() {
    const wrap = $('atModeSwitcher');
    if (!wrap) return;

    const hasBoth = paperConnected && liveConnected;
    const hasOne  = paperConnected || liveConnected;

    if (!hasOne) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    wrap.innerHTML = `
      <span class="at-sw-label">Account:</span>
      <button class="at-sw-pill ${alpacaMode === 'paper' ? 'at-sw-active' : ''}" data-sw="paper" title="Switch to Paper Trading">
        📋 Paper ${paperConnected ? '' : '<span class="at-sw-missing">not set</span>'}
      </button>
      <button class="at-sw-pill ${alpacaMode === 'live' ? 'at-sw-active' : ''} ${alpacaMode === 'live' ? 'at-sw-live' : ''}" data-sw="live" title="Switch to Live Trading">
        💵 Live ${liveConnected ? '' : '<span class="at-sw-missing">not set</span>'}
      </button>
      ${hasBoth ? '' : '<span class="at-sw-hint">Connect both accounts to switch instantly</span>'}
    `;

    wrap.querySelectorAll('.at-sw-pill').forEach(btn => {
      btn.addEventListener('click', async () => {
        const target = btn.dataset.sw;
        if (target === alpacaMode) return;
        if (!_alpacaCredsAvailable(target)) {
          // Open modal pre-set to that mode
          alpacaMode = target;
          document.querySelectorAll('.trd-mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === target));
          const w = $('trdLiveWarn'); if (w) w.style.display = target === 'live' ? '' : 'none';
          showModal(); return;
        }
        btn.disabled = true;
        try {
          const r = await apiFetch('/api/alpaca/switch-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: target }),
          });
          if (r.ok) {
            alpacaMode = target;
            localStorage.setItem(LS_WAS_CONNECTED, '1');
            updateConnStatus();
            loadAccount(); loadPositions(); loadOrders();
          }
        } catch(e) { console.warn('[AT] switch-mode:', e.message); }
        finally { btn.disabled = false; }
      });
    });
  }

  function _alpacaCredsAvailable(mode) {
    return mode === 'paper' ? paperConnected : liveConnected;
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
    const closeAllBtn = $('atCloseAllPos');
    if (!body) return;
    if (countEl) countEl.textContent = positions.length;
    if (closeAllBtn && closeAllBtn.dataset.flattening !== 'true') {
      closeAllBtn.disabled = positions.length === 0;
      closeAllBtn.textContent = 'FLATTEN ALL';
    }

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
    if (!connected && localStorage.getItem(LS_WAS_CONNECTED)) {
      reconnecting = true;
      updateConnStatus();
    }
    try {
      const r = await apiFetch('/api/alpaca/credentials', { _silent: true });
      // Update both-mode availability from the new response fields
      paperConnected = !!r.paperConnected;
      liveConnected  = !!r.liveConnected;
      if (r.connected) {
        reconnecting = false;
        connected    = true;
        alpacaMode   = r.mode || 'paper';
        localStorage.setItem(LS_WAS_CONNECTED, '1');
        updateConnStatus();
        loadAccount();
        loadPositions();
        loadOrders();
        startKeepAlive();
      } else {
        reconnecting = false;
        connected    = false;
        localStorage.removeItem(LS_WAS_CONNECTED);
        updateConnStatus();
      }
    } catch (e) {
      reconnecting = false;
      connected    = false;
      updateConnStatus();
      if (e.message !== 'session_expired') console.warn('[AT] checkCreds:', e.message);
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function connectionLabel(connection) {
    return connection === 'pmh' ? 'Opening Momentum'
      : connection === 'momentum' ? 'Momentum Trader'
      : 'Manual Trading';
  }

  function connectionUrl(path, connection = modalConnection) {
    return connection === 'manual' ? path
      : `${path}${path.includes('?') ? '&' : '?'}connection=${encodeURIComponent(connection)}`;
  }

  function showModal(connection = 'manual') {
    modalConnection = ['momentum', 'pmh'].includes(connection) ? connection : 'manual';
    const m = $('trdModal'); if (m) m.style.display = 'flex';
    if ($('trdModalErr')) $('trdModalErr').textContent = '';
    if ($('trdModalTitle')) $('trdModalTitle').textContent = `Connect Alpaca — ${connectionLabel(modalConnection)}`;
    if ($('trdModalSub')) $('trdModalSub').textContent = modalConnection === 'manual'
      ? 'API keys stored securely per user'
      : `Dedicated account for ${connectionLabel(modalConnection)}. It cannot be shared with the other bot.`;
    if ($('trdModalDisc')) $('trdModalDisc').style.display = 'none';
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
      const r = await apiFetch(connectionUrl('/api/alpaca/credentials'), {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ apiKey: key, apiSecret: secret, mode: alpacaMode, connection: modalConnection }),
      });
      if (r.error) throw new Error(r.error);
      if (modalConnection === 'manual') {
        const acct = await apiFetch('/api/alpaca/account');
        if (acct.error) throw new Error('Credentials saved but account check failed: ' + acct.error);
        connected = true;
        reconnecting = false;
        alpacaMode = r.mode || 'paper';
      }
      _pollFailures = 0;
      if (modalConnection === 'manual') localStorage.setItem(LS_WAS_CONNECTED, '1');
      hideModal();
      if (modalConnection === 'manual') {
        updateConnStatus();
        loadAccount();
        loadPositions();
        loadOrders();
        startKeepAlive();
      }
      // Notify momentum scanner so AlpacaClient re-checks with fresh credentials
      window.dispatchEvent(new CustomEvent('alpaca-connection-changed', { detail: { connection: modalConnection } }));
    } catch (e) { if (errEl) errEl.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = 'Connect'; }
  }

  async function disconnect() {
    await apiFetch(connectionUrl('/api/alpaca/credentials'), { method: 'DELETE' });
    if (modalConnection !== 'manual') {
      hideModal();
      window.dispatchEvent(new CustomEvent('alpaca-connection-changed', { detail: { connection: modalConnection } }));
      return;
    }
    connected    = false;
    reconnecting = false;
    localStorage.removeItem(LS_WAS_CONNECTED);
    stopKeepAlive();
    updateConnStatus();
    hideModal();
    window.dispatchEvent(new CustomEvent('alpaca-connection-changed', { detail: { connection: 'manual' } }));
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
      if (document.visibilityState !== 'visible') return;
      if (connected) {
        // Refresh live data when tab comes back into focus
        loadAccount(); loadPositions(); loadOrders();
      } else {
        // Not connected — try to restore credentials automatically (handles the
        // case where the tab was hidden during a server restart / re-deploy and
        // the session or connection state was reset while the user was away).
        checkCredentials();
      }
    });
  }

  return { init, open, checkCredentials, reset, openConnectModal: showModal };

})();

document.addEventListener('DOMContentLoaded', () => alpacaTrader.init());


// ── Simulator Status Panel removed (Swing and ORB bots removed) ──────────────
const simPanel = (() => {
  function init() {}
  function load() {}
  function loadStatus() {}
  function loadWhale() {}
  return { init, load, loadStatus, loadWhale };
})();

function initBotToggles() {} // Swing/ORB bots removed — no toggles needed

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

const stratSim = { init() {} };

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
  macroCal.init();
});
