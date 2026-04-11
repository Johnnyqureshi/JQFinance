// ── Johnny Qureshi Finance — Trading Desk ────────────────────────────────────

const alpacaTrader = (() => {

  let connected     = false;
  let alpacaMode    = 'live';
  let _side         = 'buy';
  let _leverage     = 1;
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

  // ── Recent orders ──────────────────────────────────────────────────────────
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
    if (!recent.length) { body.innerHTML = '<div class="at-empty">No recent orders</div>'; return; }

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

  // ── Place order ────────────────────────────────────────────────────────────
  async function placeOrder() {
    const sym    = $('atSymbol')?.value.trim().toUpperCase();
    const amount = parseFloat($('atAmount')?.value);
    const tp     = parseFloat($('atTP')?.value) || 0;
    const sl     = parseFloat($('atSL')?.value) || 0;
    const msgEl  = $('atOrderMsg');

    if (!sym)         { showMsg('Enter a symbol.', 'err'); return; }
    if (!amount || amount < 1) { showMsg('Enter a valid dollar amount.', 'err'); return; }

    const ms = marketStatus();
    if (!ms.open) {
      showMsg('Market is currently closed. Trading hours: 9:30 AM–4:00 PM ET, Mon–Fri.', 'warn');
    }

    const btn = $('atPlaceBtn');
    btn.disabled = true; btn.textContent = 'Placing order…';
    if (msgEl) msgEl.className = '';

    try {
      const r = await apiFetch('/api/alpaca/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ symbol: sym, side: _side, amount, tpPct: tp, slPct: sl, leverage: _leverage }),
      });
      if (r.error) throw new Error(r.error);
      const shares = r.shares ? ` (${r.shares} shares)` : '';
      showMsg(`Order placed: ${_side.toUpperCase()} ${sym}${shares} @ $${fmt(r.price)}`, 'ok');
      loadPositions(); loadOrders(); loadAccount();
    } catch (e) {
      showMsg(e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Place Order';
    }
  }

  function showMsg(text, type) {
    const el = $('atOrderMsg');
    if (!el) return;
    el.textContent = text;
    el.className   = 'at-order-msg at-msg-' + type;
    if (type === 'ok') setTimeout(() => { el.textContent = ''; el.className = 'at-order-msg'; }, 5000);
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

    // Side buttons
    document.querySelectorAll('.at-side-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.at-side-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _side = btn.dataset.side;
      });
    });

    // Leverage buttons
    document.querySelectorAll('.at-lb').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.at-lb').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _leverage = parseInt(btn.dataset.lev);
      });
    });

    $('atPlaceBtn')?.addEventListener('click', placeOrder);
    $('atRefreshPos')?.addEventListener('click', () => { loadPositions(); loadAccount(); });
    $('atRefreshOrders')?.addEventListener('click', loadOrders);

    // Allow Enter on symbol field
    $('atSymbol')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('atAmount')?.focus(); });
    $('atAmount')?.addEventListener('keydown', e => { if (e.key === 'Enter' && connected) placeOrder(); });
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
