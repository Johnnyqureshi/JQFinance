// ── Johnny Qureshi Finance — Trading Desk ────────────────────────────────────

const alpacaTrader = (() => {

  let connected     = false;
  let alpacaMode    = 'live';
  let _pollFailures = 0;
  let _keepAlive    = null;
  const POLL_FAIL_LIMIT = 3;

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
    try {
      const r = await apiFetch('/api/alpaca/credentials', { _silent: true });
      if (r.connected) {
        connected  = true;
        alpacaMode = r.mode || 'live';
        updateConnStatus();
        loadAccount();
        loadPositions();
        loadOrders();
        startKeepAlive();
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
      connected  = true;
      alpacaMode = r.mode || 'live';
      _pollFailures = 0;
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
    connected = false;
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

document.addEventListener('DOMContentLoaded', () => {
  simPanel.init();
  initBotToggles();
});
