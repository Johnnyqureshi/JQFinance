// ── Johnny Qureshi Finance — Alpaca Auto Trader ──────────────────────────────

const alpacaTrader = (() => {

  // ── State ─────────────────────────────────────────────────────────────────
  let connected   = false;
  let alpacaMode  = 'live';
  let autoEnabled = false;
  let atLeverage  = 1;
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
      autoEnabled = !!s.enabled;
      atLeverage  = s.leverage || 1;
      if ($('atInvestAmt')) $('atInvestAmt').value = s.investment_amount || 1000;
      if ($('atMaxPos'))    $('atMaxPos').value    = s.max_positions     || 1;
      document.querySelectorAll('.at-lb').forEach(b => b.classList.toggle('active', +b.dataset.lev === atLeverage));
      updateToggleUI();
    } catch(e) {}
  }

  async function saveSettings() {
    if (!connected) { alert('Connect Alpaca first.'); return; }
    const btn = $('atSaveBtn'), msg = $('atSaveMsg');
    if (btn) { btn.disabled=true; btn.textContent='Saving…'; }
    try {
      const body = {
        enabled:           autoEnabled ? 1 : 0,
        investment_amount: parseFloat($('atInvestAmt')?.value) || 1000,
        max_positions:     parseInt($('atMaxPos')?.value)      || 1,
        leverage:          atLeverage,
        min_volume:        500000,
      };
      const r = await apiFetch('/api/alpaca/auto-settings', {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
      });
      if (r.error) throw new Error(r.error);
      if (msg) { msg.textContent='✓ Saved'; msg.className='at-save-msg ok'; setTimeout(()=>msg.textContent='', 2500); }
    } catch(e) {
      if (msg) { msg.textContent='✗ '+e.message; msg.className='at-save-msg err'; }
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='Save'; }
    }
  }

  async function toggleAutoTrader() {
    if (!connected) { alert('Connect Alpaca first.'); return; }
    autoEnabled = !autoEnabled;
    await saveSettings();
    updateToggleUI();
    if (autoEnabled) {
      const scanNow = $('atScanNow');
      if (scanNow) scanNow.style.display = '';
      pollStatus();
    } else {
      const scanNow = $('atScanNow');
      if (scanNow) scanNow.style.display = 'none';
    }
  }

  function updateToggleUI() {
    const btn = $('atToggleBtn');
    const dot = $('atEngineDot');
    const txt = $('atEngineText');
    if (btn) {
      if (autoEnabled) {
        btn.textContent  = '⏸ Disable Auto-Trader';
        btn.className    = 'at-toggle-btn at-toggle-on';
      } else {
        btn.textContent  = '▶ Enable Auto-Trader';
        btn.className    = 'at-toggle-btn at-toggle-off';
      }
    }
    if (dot) dot.className = 'at-engine-dot ' + (autoEnabled ? 'dot-green' : 'dot-grey');
    if (txt) txt.textContent = autoEnabled ? 'Auto-trader ACTIVE — scanning every 60s' : 'Auto-trader is OFF';
    const scanNow = $('atScanNow');
    if (scanNow) scanNow.style.display = autoEnabled ? '' : 'none';
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
      loadAutoSettings();
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
    updateToggleUI();
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

      const renderRow = a => {
        const isBuy  = a.signal === 'BUY';
        const checks = a.checks || {};
        const checkStr = Object.entries(checks).map(([k,v]) =>
          `<span class="at-cond ${v.pass?'at-cond-pass':'at-cond-fail'}" title="${v.detail||''}">${v.pass?'✓':'✗'} ${k.replace(/_/g,' ')}</span>`
        ).join('');
        const atr = a.atr ? parseFloat(a.atr).toFixed(3) : 'n/a';
        const sl  = a.sl_price ? parseFloat(a.sl_price).toFixed(2) : (a.atr?(parseFloat(a.price||0)-1.5*parseFloat(a.atr)).toFixed(2):'n/a');
        const tp  = a.tp_price ? parseFloat(a.tp_price).toFixed(2) : (a.atr?(parseFloat(a.price||0)+3*parseFloat(a.atr)).toFixed(2):'n/a');
        const lev = a.autoLeverage && a.autoLeverage>1 ? `<span class="at-feed-lev">${a.autoLeverage}x auto</span>` : '';
        const vpRow = a.vah ? `<div class="at-feed-vp">
          <span class="at-vp-lbl">VAL</span><span class="at-vp-val-num">$${parseFloat(a.val).toFixed(2)}</span>
          <span class="at-vp-sep">·</span>
          <span class="at-vp-lbl">POC</span><span class="at-vp-poc-num">$${parseFloat(a.poc).toFixed(2)}</span>
          <span class="at-vp-sep">·</span>
          <span class="at-vp-lbl">VAH</span><span class="at-vp-vah-num">$${parseFloat(a.vah).toFixed(2)}</span>
          ${a.nearVAL?'<span class="at-vp-zone at-vp-val">@ VAL</span>':a.abovePOC?'<span class="at-vp-zone at-vp-poc">> POC</span>':''}
        </div>` : '';
        return `<div class="at-feed-row ${isBuy?'at-feed-buy':'at-feed-hold'}">
          <div class="at-feed-top">
            <span class="at-feed-sym">${a.symbol}</span>
            <span class="at-feed-sig at-sig-${(a.signal||'hold').toLowerCase()}">${a.signal||'HOLD'}</span>
            <span class="at-feed-conf">${a.confidence||0}%</span>
            ${lev}
            <span class="at-feed-px">$${a.price?parseFloat(a.price).toFixed(2):'--'}</span>
          </div>
          ${vpRow}
          <div class="at-feed-conds">${checkStr}</div>
          <div class="at-feed-meta">SL $${sl} · TP $${tp} · ATR ${atr} (2:1 R:R)</div>
        </div>`;
      };

      const buySection  = buys.length
        ? `<div class="at-feed-hdr at-feed-hdr-buy">✅ BUY Signals (${buys.length})</div>` + buys.map(renderRow).join('')
        : '<div class="at-empty at-empty-sm">No BUY signals — all conditions must pass simultaneously</div>';
      const holdSection = holds.length
        ? `<div class="at-feed-hdr at-feed-hdr-hold">Scanned — Not Actionable (${holds.length})</div>` + holds.map(renderRow).join('')
        : '';

      if (resEl) { resEl.innerHTML = header + buySection + holdSection; resEl.style.display=''; }
      // Also push into scan feed
      if (analyses.length) renderScanFeed(analyses);

    } catch(e) {
      if (resEl) { resEl.innerHTML=`<div class="at-empty at-err">Simulation error: ${e.message}</div>`; resEl.style.display=''; }
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='▷ Run Simulation'; }
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────
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

    // Toggle auto-trader
    $('atToggleBtn')?.addEventListener('click', toggleAutoTrader);

    // Scan now
    $('atScanNow')?.addEventListener('click', async () => {
      const btn = $('atScanNow');
      if (btn) { btn.disabled=true; btn.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Scanning…'; }
      try {
        await apiFetch('/api/alpaca/auto-scan', { method:'POST' });
        setTimeout(() => { pollStatus(); loadAutoLog(); loadPositions(); }, 5000);
      } catch(e) { alert(e.message); }
      finally {
        setTimeout(() => {
          if (btn) { btn.disabled=false; btn.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Scan Now'; }
        }, 3000);
      }
    });

    // Save settings
    $('atSaveBtn')?.addEventListener('click', saveSettings);

    // Leverage buttons
    document.querySelectorAll('.at-lb').forEach(btn => {
      btn.addEventListener('click', () => {
        atLeverage = +btn.dataset.lev;
        document.querySelectorAll('.at-lb').forEach(b => b.classList.toggle('active', b===btn));
      });
    });

    // Refresh positions
    $('atRefreshPos')?.addEventListener('click', () => { loadAccount(); loadPositions(); });

    // Refresh log
    $('atRefreshLog')?.addEventListener('click', loadAutoLog);

    // Simulation
    $('atSimBtn')?.addEventListener('click', runSimulation);
  }

  // ── Page open ──────────────────────────────────────────────────────────────
  function open() {
    checkCredentials().then(() => {
      if (autoEnabled) pollStatus();
    });
    loadAutoLog();
  }

  function init() {
    bindEvents();
  }

  return { init, open };

})();

document.addEventListener('DOMContentLoaded', () => alpacaTrader.init());
