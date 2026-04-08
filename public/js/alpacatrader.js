// ── Johnny Qureshi Finance — Alpaca Auto Trader ──────────────────────────────

const alpacaTrader = (() => {

  // ── State ─────────────────────────────────────────────────────────────────
  let connected   = false;
  let alpacaMode  = 'live';
  let autoEnabled = false;
  let atLeverage  = 1;
  let atOrderType = 'auto';
  let statusPoll  = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  const $   = id => document.getElementById(id);
  const fmt = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  const fmtV = v => !v?'--':v>=1e9?(v/1e9).toFixed(1)+'B':v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':String(v);
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '--';
  const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '--';
  const fmtAgo = iso => {
    if (!iso) return '--';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    return s < 60 ? s + 's ago' : Math.round(s/60) + 'm ago';
  };

  async function apiFetch(url, opts={}) {
    const r = await fetch(url, { credentials:'include', ...opts });
    // Session expired — redirect to login so the engine stays visible
    if (r.status === 401) {
      stopStatusPoll();
      window.location.href = '/login';
      throw new Error('session_expired');
    }
    return r.json();
  }

  // ── Connection ─────────────────────────────────────────────────────────────
  function updateConnStatus() {
    const dot  = $('atConnDot');
    const txt  = $('atConnText');
    const badge= $('atModeBadge');
    const btn  = $('atConnBtn');
    const chips= $('atAcctChips');
    if (connected) {
      if (dot)   { dot.className='at-conn-dot dot-green'; }
      if (txt)   txt.textContent = 'Connected';
      if (badge) { badge.textContent = alpacaMode.toUpperCase(); badge.className='at-mode-badge mode-'+(alpacaMode==='live'?'live':'paper'); }
      if (btn)   btn.textContent = 'Account Settings';
      if (chips) chips.style.display = '';
    } else {
      if (dot)   { dot.className='at-conn-dot dot-red'; }
      if (txt)   txt.textContent = 'Not connected';
      if (badge) { badge.textContent = 'DISCONNECTED'; badge.className='at-mode-badge mode-paper'; }
      if (btn)   btn.textContent = 'Connect Alpaca';
      if (chips) chips.style.display = 'none';
    }
  }

  async function checkCredentials() {
    try {
      const r = await apiFetch('/api/alpaca/credentials');
      connected  = !!r.connected;
      alpacaMode = r.mode || 'live';
      updateConnStatus();
      if (connected) { loadAccount(); loadAutoSettings(); startStatusPoll(); loadAutoLog(); }
    } catch(e) {}
  }

  // ── Account snapshot ───────────────────────────────────────────────────────
  async function loadAccount() {
    if (!connected) return;
    try {
      const a = await apiFetch('/api/alpaca/account');
      if (a.error) return;
      const equity = parseFloat(a.equity||0);
      const cash   = parseFloat(a.cash||0);
      const bp     = parseFloat(a.buying_power||0);
      const dtc    = parseInt(a.daytrade_count||0, 10);
      const isPDT  = a.pattern_day_trader === true;

      if ($('atEquity')) $('atEquity').textContent = '$' + fmt(equity);
      if ($('atCash'))   $('atCash').textContent   = '$' + fmt(cash);
      if ($('atBP'))     $('atBP').textContent     = '$' + fmt(bp);

      // PDT display
      const pdtChip = $('atPDTChip');
      const pdtVal  = $('atDayTrades');
      const pdtWarn = $('atPDTWarn');
      if (pdtChip) {
        pdtChip.style.display = '';
        if (pdtVal) pdtVal.textContent = dtc + '/3 day trades';
        if (dtc >= 3 && equity < 25000) {
          pdtChip.style.borderColor = '#f87171';
          if (pdtWarn) pdtWarn.style.display = '';
        } else {
          pdtChip.style.borderColor = '';
          if (pdtWarn) pdtWarn.style.display = 'none';
        }
      }
      // Reload live positions from Alpaca
      loadPositions();
    } catch(e) { console.error('[AT] Account error:', e.message); }
  }

  // ── Live positions from Alpaca ─────────────────────────────────────────────
  async function loadPositions() {
    if (!connected) return;
    try {
      const pos = await apiFetch('/api/alpaca/positions');
      renderPositions(Array.isArray(pos) ? pos : []);
    } catch(e) {}
  }

  function renderPositions(positions) {
    const el  = $('atPositionsBody');
    const cnt = $('atPosCount');
    if (cnt) cnt.textContent = positions.length;
    if (!el) return;
    if (!positions.length) {
      el.innerHTML = '<div class="at-empty">No open positions — engine is monitoring the market</div>';
      return;
    }
    el.innerHTML = positions.map(p => {
      const pnl = parseFloat(p.unrealized_pl||0);
      const pct = parseFloat(p.unrealized_plpc||0)*100;
      const up  = pnl >= 0;
      const qty = parseFloat(p.qty||0);
      return `<div class="at-pos-row">
        <div class="at-pos-sym">${p.symbol}</div>
        <div class="at-pos-qty">${qty>0?'Long':'Short'} ${Math.abs(qty)} sh</div>
        <div class="at-pos-px">$${fmt(parseFloat(p.current_price||0))}</div>
        <div class="at-pos-avg">avg $${fmt(parseFloat(p.avg_entry_price||0))}</div>
        <div class="at-pos-pnl ${up?'up':'dn'}">${up?'+':'−'}$${fmt(Math.abs(pnl))} (${up?'+':''}${fmt(pct)}%)</div>
        <button class="at-close-btn" data-sym="${p.symbol}" title="Close position">✕ Close</button>
      </div>`;
    }).join('');
    el.querySelectorAll('.at-close-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Close ${btn.dataset.sym} position?`)) return;
        btn.disabled = true; btn.textContent = '…';
        try {
          await apiFetch('/api/alpaca/position/'+btn.dataset.sym, { method:'DELETE' });
          setTimeout(loadPositions, 1200);
        } catch(e) { btn.disabled=false; btn.textContent='✕ Close'; alert(e.message); }
      });
    });
  }

  // ── Auto-trader settings ───────────────────────────────────────────────────
  async function loadAutoSettings() {
    try {
      const s = await apiFetch('/api/alpaca/auto-settings');
      atLeverage = s.leverage || 1;
      if ($('atInvestAmt')) $('atInvestAmt').value = s.investment_amount || 1000;
      if ($('atMaxPos'))    $('atMaxPos').value    = s.max_positions     || 1;
      document.querySelectorAll('.at-lb').forEach(b => b.classList.toggle('active', +b.dataset.lev === atLeverage));
      atOrderType = s.order_type || 'auto';
      document.querySelectorAll('.at-otb').forEach(b => b.classList.toggle('active', b.dataset.ot === atOrderType));
      // Auto-enable if not already running
      if (!s.enabled) {
        autoEnabled = true;
        await saveSettings();
      } else {
        autoEnabled = true;
      }
      updateEngineUI();
    } catch(e) {}
  }

  let _saveTimer = null;
  async function saveSettings() {
    if (!connected) return;
    try {
      const body = {
        enabled:           1,
        investment_amount: parseFloat($('atInvestAmt')?.value) || 1000,
        max_positions:     parseInt($('atMaxPos')?.value)      || 1,
        leverage:          atLeverage,
        order_type:        atOrderType,
        min_volume:        500000,
      };
      await apiFetch('/api/alpaca/auto-settings', {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
      });
    } catch(e) {}
  }

  function scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveSettings, 800);
  }

  async function togglePause() {
    if (!connected) return;
    autoEnabled = !autoEnabled;
    try {
      await apiFetch('/api/alpaca/auto-settings', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          enabled:           autoEnabled ? 1 : 0,
          investment_amount: parseFloat($('atInvestAmt')?.value) || 1000,
          max_positions:     parseInt($('atMaxPos')?.value)      || 1,
          leverage:          atLeverage,
          order_type:        atOrderType,
          min_volume:        500000,
        }),
      });
    } catch(e) {}
    updateEngineUI();
    if (autoEnabled) pollStatus();
  }

  function updateEngineUI() {
    const pauseBtn = $('atToggleBtn');
    const dot = $('atEngineDot');
    const txt = $('atEngineText');
    if (pauseBtn) {
      pauseBtn.style.display  = connected ? '' : 'none';
      pauseBtn.textContent    = autoEnabled ? '⏸ Pause' : '▶ Resume';
    }
    if (dot) dot.className = 'at-engine-dot ' + (autoEnabled ? 'dot-green' : 'dot-grey');
    if (txt) txt.textContent = autoEnabled ? 'Trading engine running — scanning every 60s' : 'Engine paused';
  }

  // ── Status polling ─────────────────────────────────────────────────────────
  async function pollStatus() {
    if (!connected) return;
    try {
      const st = await apiFetch('/api/alpaca/auto-status');

      // Spinner
      const sp = $('atScanSpinner');
      if (sp) sp.style.display = st.scanning ? '' : 'none';

      // Last scan
      const ls = $('atLastScan');
      if (ls) ls.textContent = st.lastScan ? fmtAgo(st.lastScan) : '--';

      // Market badge
      const mkt = $('atMktBadge');
      if (mkt) {
        mkt.textContent = st.marketOpen ? 'Market Open' : 'Market Closed';
        mkt.className   = 'at-mkt-badge ' + (st.marketOpen ? 'mkt-open' : 'mkt-closed');
      }

      // Positions meta
      const pm = $('atPosMeta');
      if (pm) pm.textContent = (st.openPositions||0) + '/' + (st.maxPositions||1) + ' positions';

      // Rate limit
      const rl = $('atRateMeta');
      if (rl && st.rateLimit != null) rl.textContent = st.rateLimit + ' orders/hr left';

      // Last action
      const act = $('atLastAction');
      if (act && st.lastAction) act.textContent = '→ ' + st.lastAction;

      // Error
      const err = $('atEngineError');
      if (err) {
        if (st.error) { err.textContent = '⚠ ' + st.error; err.style.display = ''; }
        else err.style.display = 'none';
      }

      // PDT warn from server
      const pdtWarn = $('atPDTWarn');
      if (pdtWarn && st.pdtBlocked) pdtWarn.style.display = '';

      // Sector heatmap
      if (Array.isArray(st.hotSectors) && st.hotSectors.length) {
        renderHotSectors(st.hotSectors);
      }

      // Live scan feed
      if (Array.isArray(st.analyses) && st.analyses.length) {
        renderScanFeed(st.analyses);
      }

    } catch(e) {}
  }

  function startStatusPoll() {
    clearInterval(statusPoll);
    statusPoll = setInterval(pollStatus, 5000);
    pollStatus();
  }

  function stopStatusPoll() { clearInterval(statusPoll); statusPoll = null; }

  // ── Sector heatmap strip ────────────────────────────────────────────────────
  function renderHotSectors(hotSectors) {
    const el = $('atSectorHeatmap');
    if (!el) return;
    const NAMES = {
      XLK:'Tech', XLF:'Finance', XLE:'Energy', XLV:'Health',
      XLI:'Industrial', XLC:'Comm', XLY:'ConsDisc', XLP:'Staples',
      XLB:'Materials', XLRE:'Real Estate', XLU:'Utilities',
    };
    el.innerHTML = hotSectors.map(s => {
      const chg  = s.chg || 0;
      const sign = chg >= 0 ? '+' : '';
      const cls  = chg >= 0.5 ? 'sector-hot' : chg <= -0.5 ? 'sector-cold' : 'sector-flat';
      const name = NAMES[s.etf] || s.etf;
      return `<span class="at-sector-chip ${cls}">${name} <b>${sign}${chg.toFixed(2)}%</b></span>`;
    }).join('');
  }

  // ── Live scan feed ─────────────────────────────────────────────────────────
  function renderScanFeed(analyses) {
    const el  = $('atScanFeed');
    const cnt = $('atScanCount');
    if (!el) return;
    if (cnt) cnt.textContent = analyses.length + ' symbols';

    const buys  = analyses.filter(a => a.signal === 'BUY');
    const holds = analyses.filter(a => a.signal !== 'BUY');

    const vpZoneLabel = a => {
      if (!a.vah) return null;
      if (a.nearVAL)  return { txt:'@ VAL', cls:'at-vp-val' };
      if (a.abovePOC) return { txt:'> POC', cls:'at-vp-poc' };
      if (a.inVA)     return { txt:'in VA',  cls:'at-vp-va'  };
      if (a.price > a.vah) return { txt:'> VAH', cls:'at-vp-vah' };
      return { txt:'< VAL', cls:'at-vp-out' };
    };

    const renderRow = a => {
      const isBuy  = a.signal === 'BUY';
      const checks = a.checks || {};

      // VP bar — visual range showing VAL / POC / VAH with price position
      let vpBar = '';
      if (a.vah && a.val && a.poc && a.price) {
        const rangeW = a.vah - a.val;
        const pocPct  = rangeW > 0 ? Math.max(0, Math.min(100, ((a.poc - a.val) / rangeW) * 100)) : 50;
        const pxPct   = rangeW > 0 ? Math.max(0, Math.min(100, ((a.price - a.val) / rangeW) * 100)) : 50;
        const zoneCls = a.tightVAL ? 'at-vp-val' : a.nearVAL ? 'at-vp-poc' : a.abovePOC ? 'at-vp-va' : a.price > a.vah ? 'at-vp-vah' : 'at-vp-out';
        vpBar = `<div class="at-vp-hero">
          <div class="at-vp-labels">
            <span class="at-vp-label-val">VAL <b>$${parseFloat(a.val).toFixed(2)}</b></span>
            <span class="at-vp-label-poc">POC <b>$${parseFloat(a.poc).toFixed(2)}</b></span>
            <span class="at-vp-label-vah">VAH <b>$${parseFloat(a.vah).toFixed(2)}</b></span>
          </div>
          <div class="at-vp-track">
            <div class="at-vp-fill" style="width:${pocPct}%"></div>
            <div class="at-vp-poc-line" style="left:${pocPct}%"></div>
            <div class="at-vp-price-tick" style="left:${Math.min(98,pxPct)}%"></div>
          </div>
          ${a.zoneStr ? `<div class="at-vp-zone-lbl ${zoneCls}">${a.zoneStr}</div>` : ''}
          ${isBuy && a.tp_price ? `<div class="at-vp-trade">SL $${parseFloat(a.sl_price).toFixed(2)} → Entry $${parseFloat(a.price).toFixed(2)} → TP (VAH) $${parseFloat(a.tp_price).toFixed(2)}</div>` : ''}
        </div>`;
      }

      const condStr = Object.entries(checks).map(([k, v]) =>
        `<span class="at-cond ${v.pass?'at-cond-pass':'at-cond-fail'}" title="${v.detail||''}">${v.pass?'✓':'✗'} ${k.replace(/_/g,' ')}</span>`
      ).join('');
      const levStr = a.autoLeverage && a.autoLeverage > 1 ? `<span class="at-feed-lev">${a.autoLeverage}×</span>` : '';
      return `<div class="at-feed-row ${isBuy?'at-feed-buy':'at-feed-hold'}">
        <div class="at-feed-top">
          <span class="at-feed-sym">${a.symbol}</span>
          <span class="at-feed-sig at-sig-${(a.signal||'hold').toLowerCase()}">${a.signal||'HOLD'}</span>
          <span class="at-feed-conf">${a.confidence||0}%</span>
          ${levStr}
          <span class="at-feed-px">$${a.price?parseFloat(a.price).toFixed(2):'--'}</span>
          <span class="at-feed-rsi">RSI ${a.rsi?parseFloat(a.rsi).toFixed(0):'--'}</span>
        </div>
        ${vpBar}
        <div class="at-feed-conds">${condStr}</div>
      </div>`;
    };

    const buySection  = buys.length
      ? `<div class="at-feed-hdr at-feed-hdr-buy">✅ VP Entry Signals (${buys.length})</div>` + buys.map(renderRow).join('')
      : '<div class="at-empty at-empty-sm">No VP entry signals — engine watching for VAL bounces and POC breakouts</div>';

    const holdSection = holds.length
      ? `<div class="at-feed-hdr at-feed-hdr-hold">Monitoring (${holds.length})</div>` + holds.map(renderRow).join('')
      : '';

    el.innerHTML = buySection + holdSection;
  }

  // ── Auto-trade log ─────────────────────────────────────────────────────────
  async function loadAutoLog() {
    const el = $('atLogBody'); if (!el) return;
    try {
      const logs = await apiFetch('/api/alpaca/auto-log');
      if (!Array.isArray(logs) || !logs.length) {
        el.innerHTML = '<div class="at-empty">No auto-trades yet — engine will trade automatically when conditions are met</div>';
        return;
      }
      const EXIT_LABELS = {
        broker_close:            'Broker TP/SL',
        signal_reversal:         'Signal flip',
        tp_hit:                  'TP hit',
        sl_hit:                  'SL hit',
        price_below_ema9:        'Below EMA9',
        unfilled_timeout:        'Unfilled 2m',
      };
      const statusInfo = l => {
        if (l.status==='pending_fill') return { cls:'alog-pending', label:'Pending Fill' };
        if (l.status==='cancelled')   return { cls:'alog-cancelled', label:'Cancelled' };
        if (l.status==='open')        return { cls:'alog-open', label:'Open' };
        const pnl = l.pnl!=null ? parseFloat(l.pnl) : null;
        return { cls: pnl!=null&&pnl>0 ? 'alog-win' : 'alog-loss', label:'Closed' };
      };
      const rows = logs.slice(0,40).map(l => {
          const pnl  = l.pnl!=null ? parseFloat(l.pnl) : null;
          const up   = pnl!=null && pnl>=0;
          const si   = statusInfo(l);
          const exit = EXIT_LABELS[l.exit_reason] || l.exit_reason || '--';
          return `<div class="at-log-row ${si.cls}">
            <span class="${l.side==='buy'?'ord-buy':'ord-sell'}">${(l.side||'--').toUpperCase()}</span>
            <span class="at-log-sym">${l.symbol}</span>
            <span>${l.shares||'--'}</span>
            <span>$${fmt(l.entry_price)}</span>
            <span class="up">$${fmt(l.tp_price)}</span>
            <span class="dn">$${fmt(l.sl_price)}</span>
            <span>${l.confidence||'--'}%</span>
            <span>${l.leverage||1}x</span>
            <span class="${pnl!=null?(up?'up':'dn'):''}">${pnl!=null?(up?'+':'−')+'$'+fmt(Math.abs(pnl)):'--'}</span>
            <span class="text-dim">${exit}</span>
            <span class="at-log-status ${si.cls}">${si.label}</span>
            <span>${fmtDateTime(l.created_at)}</span>
          </div>`;
        }).join('');
      el.innerHTML = `<div class="at-log-scroll">
        <div class="at-log-header">
          <span>Side</span><span>Symbol</span><span>Sh</span><span>Entry</span>
          <span>TP</span><span>SL</span><span>Conf</span><span>Lev</span>
          <span>P&L</span><span>Exit</span><span>Status</span><span>Time</span>
        </div>${rows}</div>`;
    } catch(e) {
      el.innerHTML = '<div class="at-empty at-err">Failed to load log</div>';
    }
  }

  // ── Connect modal ──────────────────────────────────────────────────────────
  function showModal() {
    const m = $('trdModal'); if (m) m.style.display='flex';
    if ($('trdModalErr')) $('trdModalErr').textContent = '';
    if ($('trdModalDisc')) $('trdModalDisc').style.display = connected ? '' : 'none';
    document.querySelectorAll('.trd-mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode===alpacaMode));
    const w = $('trdLiveWarn'); if (w) w.style.display = alpacaMode==='live' ? '' : 'none';
  }
  function hideModal() { const m = $('trdModal'); if (m) m.style.display='none'; }

  async function saveCredentials() {
    const key    = $('trdApiKey')?.value.trim();
    const secret = $('trdApiSecret')?.value.trim();
    const errEl  = $('trdModalErr');
    if (!key||!secret) { if(errEl) errEl.textContent='Both fields required.'; return; }
    const btn = $('trdModalSave');
    btn.disabled=true; btn.textContent='Connecting…';
    if (errEl) errEl.textContent='';
    try {
      const r = await apiFetch('/api/alpaca/credentials', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ apiKey:key, apiSecret:secret, mode:alpacaMode }),
      });
      if (r.error) throw new Error(r.error);
      const acct = await apiFetch('/api/alpaca/account');
      if (acct.error) throw new Error('Credentials saved but account failed: ' + acct.error);
      connected  = true;
      alpacaMode = r.mode || 'live';
      hideModal();
      updateConnStatus();
      loadAccount();
      await loadAutoSettings();   // auto-enables engine
      startStatusPoll();
      loadAutoLog();
    } catch(e) { if(errEl) errEl.textContent = e.message; }
    finally { btn.disabled=false; btn.textContent='Connect'; }
  }

  async function disconnect() {
    await apiFetch('/api/alpaca/credentials', { method:'DELETE' });
    connected=false; autoEnabled=false;
    stopStatusPoll();
    updateConnStatus();
    updateEngineUI();
    hideModal();
    const posEl = $('atPositionsBody');
    if (posEl) posEl.innerHTML = '<div class="at-empty">Connect Alpaca to view live positions</div>';
    const chips = $('atAcctChips');
    if (chips) chips.style.display='none';
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  async function runSimulation() {
    if (!connected) { alert('Connect Alpaca first.'); return; }
    const btn   = $('atSimBtn');
    const resEl = $('atSimResults');
    if (btn) { btn.disabled=true; btn.textContent='Running…'; }
    try {
      const r = await apiFetch('/api/alpaca/simulate', { method:'POST' });
      if (r.error) throw new Error(r.error);
      const sim      = r.simulation || {};
      const analyses = sim.analyses || [];

      let mktLabel='Market CLOSED', mktCls='at-sim-closed';
      if (sim.marketOpen) { mktLabel='Market OPEN'; mktCls='at-sim-open'; }

      const header = `<div class="at-sim-header">
        Simulation — <span class="${mktCls}">${mktLabel}</span> — ${new Date().toLocaleTimeString()}
        <span class="at-sim-note">(No real orders placed — real data)</span>
      </div>`;

      const buys  = analyses.filter(a => a.signal === 'BUY');
      const holds = analyses.filter(a => a.signal !== 'BUY');

      // Reuse same VP row renderer as the live feed
      const renderSimRow = a => {
        const isBuy  = a.signal === 'BUY';
        const checks = a.checks || {};
        let vpBar = '';
        if (a.vah && a.val && a.poc && a.price) {
          const rangeW = a.vah - a.val;
          const pocPct = rangeW > 0 ? Math.max(0, Math.min(100, ((a.poc - a.val) / rangeW) * 100)) : 50;
          const pxPct  = rangeW > 0 ? Math.max(0, Math.min(100, ((a.price - a.val) / rangeW) * 100)) : 50;
          const zoneCls = a.tightVAL ? 'at-vp-val' : a.nearVAL ? 'at-vp-poc' : a.abovePOC ? 'at-vp-va' : a.price > a.vah ? 'at-vp-vah' : 'at-vp-out';
          vpBar = `<div class="at-vp-hero">
            <div class="at-vp-labels">
              <span class="at-vp-label-val">VAL <b>$${parseFloat(a.val).toFixed(2)}</b></span>
              <span class="at-vp-label-poc">POC <b>$${parseFloat(a.poc).toFixed(2)}</b></span>
              <span class="at-vp-label-vah">VAH <b>$${parseFloat(a.vah).toFixed(2)}</b></span>
            </div>
            <div class="at-vp-track">
              <div class="at-vp-fill" style="width:${pocPct}%"></div>
              <div class="at-vp-poc-line" style="left:${pocPct}%"></div>
              <div class="at-vp-price-tick" style="left:${Math.min(98,pxPct)}%"></div>
            </div>
            ${a.zoneStr ? `<div class="at-vp-zone-lbl ${zoneCls}">${a.zoneStr}</div>` : ''}
            ${isBuy && a.tp_price ? `<div class="at-vp-trade">SL $${parseFloat(a.sl_price).toFixed(2)} → Entry $${parseFloat(a.price).toFixed(2)} → TP (VAH) $${parseFloat(a.tp_price).toFixed(2)}</div>` : ''}
          </div>`;
        }
        const condStr = Object.entries(checks).map(([k,v]) =>
          `<span class="at-cond ${v.pass?'at-cond-pass':'at-cond-fail'}" title="${v.detail||''}">${v.pass?'✓':'✗'} ${k.replace(/_/g,' ')}</span>`
        ).join('');
        return `<div class="at-feed-row ${isBuy?'at-feed-buy':'at-feed-hold'}">
          <div class="at-feed-top">
            <span class="at-feed-sym">${a.symbol}</span>
            <span class="at-feed-sig at-sig-${(a.signal||'hold').toLowerCase()}">${a.signal||'HOLD'}</span>
            <span class="at-feed-conf">${a.confidence||0}%</span>
            <span class="at-feed-px">$${a.price?parseFloat(a.price).toFixed(2):'--'}</span>
            <span class="at-feed-rsi">RSI ${a.rsi?parseFloat(a.rsi).toFixed(0):'--'}</span>
          </div>
          ${vpBar}
          <div class="at-feed-conds">${condStr}</div>
        </div>`;
      };

      const buySection  = buys.length
        ? `<div class="at-feed-hdr at-feed-hdr-buy">✅ VP Entry Signals Now (${buys.length})</div>` + buys.map(renderSimRow).join('')
        : '<div class="at-empty at-empty-sm">No current VP entry signals — watching for VAL bounces and POC breakouts</div>';
      const holdSection = holds.length
        ? `<div class="at-feed-hdr at-feed-hdr-hold">Monitoring (${holds.length})</div>` + holds.map(renderSimRow).join('')
        : '';

      if (resEl) { resEl.innerHTML = header + buySection + holdSection; resEl.style.display=''; }
      if (analyses.length) renderScanFeed(analyses);

    } catch(e) {
      if (resEl) { resEl.innerHTML=`<div class="at-empty at-err">Simulation error: ${e.message}</div>`; resEl.style.display=''; }
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='▷ Run Simulation'; }
    }
  }

  // ── Backtest ────────────────────────────────────────────────────────────────
  async function runBacktest() {
    const btn   = $('atBtBtn');
    const resEl = $('atBtResults');
    if (btn) { btn.disabled=true; btn.textContent='Running backtest…'; }
    if (resEl) { resEl.style.display=''; resEl.innerHTML='<div class="at-bt-loading"><div class="at-bt-spinner"></div> Fetching 60 days of data for 20 symbols… (~15s)</div>'; }
    try {
      const r = await apiFetch('/api/alpaca/backtest');
      if (r.error) throw new Error(r.error);
      const s = r.stats || {};
      const trades = r.trades || [];

      const kellyColor  = s.kelly > 0 ? '#4ade80' : '#f87171';
      const winColor    = s.winRate >= 55 ? '#4ade80' : s.winRate >= 45 ? '#facc15' : '#f87171';
      const pnlColor    = s.totalPnl >= 0 ? '#4ade80' : '#f87171';
      const pnlSign     = s.totalPnl >= 0 ? '+' : '';

      const verdict = s.kelly > 10 ? '🟢 Statistically profitable — Kelly is positive, deploy capital'
                    : s.kelly >  0 ? '🟡 Marginal edge — profitable but small, consider paper trading first'
                    : '🔴 Negative edge in this period — do not trade live until conditions improve';

      const summary = `<div class="at-bt-summary">
        <div class="at-bt-title">Volume Profile Strategy — 60-Day Backtest</div>
        <div class="at-bt-subtitle">${trades.length} trades across 20 liquid symbols</div>
        <div class="at-bt-stats">
          <div class="at-bt-stat">
            <div class="at-bt-stat-val" style="color:${winColor}">${s.winRate}%</div>
            <div class="at-bt-stat-lbl">Win Rate</div>
            <div class="at-bt-stat-sub">${s.wins}W / ${s.losses}L / ${s.expired} exp</div>
          </div>
          <div class="at-bt-stat">
            <div class="at-bt-stat-val">${s.avgRR}:1</div>
            <div class="at-bt-stat-lbl">Avg Risk:Reward</div>
            <div class="at-bt-stat-sub">TP=VAH / SL=VAL−0.5%</div>
          </div>
          <div class="at-bt-stat">
            <div class="at-bt-stat-val" style="color:${pnlColor}">${pnlSign}${s.totalPnl}%</div>
            <div class="at-bt-stat-lbl">Cumulative P&amp;L</div>
            <div class="at-bt-stat-sub">Avg win ${s.avgWin}% / Avg loss ${s.avgLoss}%</div>
          </div>
          <div class="at-bt-stat">
            <div class="at-bt-stat-val" style="color:${kellyColor}">${s.kelly}%</div>
            <div class="at-bt-stat-lbl">Kelly Criterion</div>
            <div class="at-bt-stat-sub">Optimal position size</div>
          </div>
        </div>
        <div class="at-bt-verdict">${verdict}</div>
      </div>`;

      const valBounceRows = trades.filter(t => t.trigger === 'val_bounce');
      const pocRows       = trades.filter(t => t.trigger === 'poc_breakout');
      const vbWinRate = valBounceRows.length > 0
        ? Math.round(valBounceRows.filter(t=>t.hit==='tp').length/valBounceRows.length*100) : 0;
      const pbWinRate = pocRows.length > 0
        ? Math.round(pocRows.filter(t=>t.hit==='tp').length/pocRows.length*100) : 0;

      const breakdown = `<div class="at-bt-breakdown">
        <div class="at-bt-trigger">
          <div class="at-bt-trig-name">VAL Bounce</div>
          <div class="at-bt-trig-n">${valBounceRows.length} trades</div>
          <div class="at-bt-trig-wr" style="color:${vbWinRate>=55?'#4ade80':vbWinRate>=45?'#facc15':'#f87171'}">${vbWinRate}% win</div>
        </div>
        <div class="at-bt-trigger">
          <div class="at-bt-trig-name">POC Breakout</div>
          <div class="at-bt-trig-n">${pocRows.length} trades</div>
          <div class="at-bt-trig-wr" style="color:${pbWinRate>=55?'#4ade80':pbWinRate>=45?'#facc15':'#f87171'}">${pbWinRate}% win</div>
        </div>
      </div>`;

      const tradeRows = trades.slice(0, 60).map(t => {
        const hitCls  = t.hit==='tp' ? 'at-bt-tp' : t.hit==='sl' ? 'at-bt-sl' : 'at-bt-exp';
        const hitLbl  = t.hit==='tp' ? '✅ TP' : t.hit==='sl' ? '❌ SL' : '⏸ Exp';
        const pnlCls  = t.pnlPct >= 0 ? 'at-bt-pnl-pos' : 'at-bt-pnl-neg';
        const pnlSign = t.pnlPct >= 0 ? '+' : '';
        const trigLbl = t.trigger==='val_bounce' ? 'VAL' : 'POC';
        return `<div class="at-bt-row ${hitCls}">
          <span class="at-bt-row-sym">${t.symbol}</span>
          <span class="at-bt-row-date">${t.date}</span>
          <span class="at-bt-row-trig at-trig-${t.trigger}">${trigLbl}</span>
          <span class="at-bt-row-px">$${t.openPrice}</span>
          <span class="at-bt-row-tp">TP $${t.tpLevel}</span>
          <span class="at-bt-row-sl">SL $${t.slLevel}</span>
          <span class="at-bt-row-hit">${hitLbl}</span>
          <span class="at-bt-row-pnl ${pnlCls}">${pnlSign}${t.pnlPct}%</span>
          <span class="at-bt-row-rr">${t.rr}:1</span>
        </div>`;
      }).join('');

      const tradeList = `<div class="at-bt-trades">
        <div class="at-bt-trades-hdr">Trade Log (most recent ${Math.min(60,trades.length)} of ${trades.length})</div>
        <div class="at-bt-trades-cols">
          <span>Symbol</span><span>Date</span><span>Trigger</span><span>Entry</span>
          <span>TP Target</span><span>SL Level</span><span>Result</span><span>P&amp;L %</span><span>R:R</span>
        </div>
        ${tradeRows}
      </div>`;

      if (resEl) resEl.innerHTML = summary + breakdown + tradeList;
    } catch(e) {
      if (resEl) resEl.innerHTML=`<div class="at-empty at-err">Backtest error: ${e.message}</div>`;
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='📊 Run Backtest (60 days)'; }
    }
  }

  function bindEvents() {
    // Connect button & modal
    $('atConnBtn')?.addEventListener('click', showModal);
    $('trdConnBtn')?.addEventListener('click', showModal);
    $('trdModalClose')?.addEventListener('click', hideModal);
    $('trdModal')?.addEventListener('click', e => { if(e.target.id==='trdModal') hideModal(); });
    $('trdModalSave')?.addEventListener('click', saveCredentials);
    $('trdModalDisc')?.addEventListener('click', async () => {
      if (confirm('Disconnect and remove stored credentials?')) await disconnect();
    });

    // Mode tabs
    document.querySelectorAll('.trd-mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        alpacaMode = tab.dataset.mode;
        document.querySelectorAll('.trd-mode-tab').forEach(t => t.classList.toggle('active', t===tab));
        const w = $('trdLiveWarn'); if (w) w.style.display = alpacaMode==='live' ? '' : 'none';
      });
    });

    // Pause / Resume button
    $('atToggleBtn')?.addEventListener('click', togglePause);

    // Leverage buttons — auto-save on change
    document.querySelectorAll('.at-lb').forEach(btn => {
      btn.addEventListener('click', () => {
        atLeverage = +btn.dataset.lev;
        document.querySelectorAll('.at-lb').forEach(b => b.classList.toggle('active', b===btn));
        scheduleSave();
      });
    });

    // Order type buttons — auto-save on change
    document.querySelectorAll('.at-otb').forEach(btn => {
      btn.addEventListener('click', () => {
        atOrderType = btn.dataset.ot;
        document.querySelectorAll('.at-otb').forEach(b => b.classList.toggle('active', b===btn));
        scheduleSave();
      });
    });

    // Investment / max positions — auto-save on change
    $('atInvestAmt')?.addEventListener('input', scheduleSave);
    $('atMaxPos')?.addEventListener('input', scheduleSave);

    // Refresh positions
    $('atRefreshPos')?.addEventListener('click', () => { loadAccount(); loadPositions(); });

    // Refresh log
    $('atRefreshLog')?.addEventListener('click', loadAutoLog);
  }

  // ── Page open ──────────────────────────────────────────────────────────────
  function open() {
    checkCredentials().then(() => {
      startStatusPoll();
    });
    loadAutoLog();
  }

  function init() {
    bindEvents();
  }

  return { init, open };

})();

document.addEventListener('DOMContentLoaded', () => alpacaTrader.init());
