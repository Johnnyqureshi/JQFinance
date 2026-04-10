// ── Johnny Qureshi Finance — Alpaca Auto Trader ──────────────────────────────

const alpacaTrader = (() => {

  // ── State ─────────────────────────────────────────────────────────────────
  let connected   = false;
  let alpacaMode  = 'live';
  let autoEnabled = false;
  let atLeverage     = 1;
  let atOrderType    = 'auto';
  let statusPoll  = null;
  let keepAlivePoll = null;      // session keep-alive timer
  let _pollFailures = 0;         // consecutive poll failures before hard disconnect
  const POLL_FAIL_LIMIT = 3;    // tolerate up to 3 consecutive 401s before showing auth

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

  // opts._silent = true  → caller handles 401 itself (polling); no auto-overlay
  async function apiFetch(url, opts={}) {
    const { _silent, ...fetchOpts } = opts;
    const r = await fetch(url, { credentials:'include', ...fetchOpts });
    if (r.status === 401) {
      if (_silent) {
        // Let the poll decide when to hard-disconnect (after POLL_FAIL_LIMIT hits)
        throw new Error('session_expired');
      }
      // Hard disconnect — user-triggered action returned 401, session is gone
      stopStatusPoll();
      connected   = false;
      autoEnabled = false;
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      else window.location.href = '/';
      throw new Error('session_expired');
    }
    return r.json();
  }

  // Hard-disconnect: called only after POLL_FAIL_LIMIT consecutive auth failures
  function _hardDisconnect() {
    stopStatusPoll();
    connected   = false;
    autoEnabled = false;
    _pollFailures = 0;
    updateConnStatus();
    if (typeof showAuthOverlay === 'function') showAuthOverlay();
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

  // Retry up to `maxTries` times with `delay` ms between attempts.
  // This makes the post-login re-connect resilient to cookie-timing edge cases.
  async function checkCredentials(maxTries = 3, delay = 600) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const r = await apiFetch('/api/alpaca/credentials');
        connected  = !!r.connected;
        alpacaMode = r.mode || 'paper';
        _pollFailures = 0;
        updateConnStatus();
        if (connected) {
          loadAccount();
          loadAutoSettings();
          startStatusPoll();
          startKeepAlive();
          loadAutoLog();
        }
        return; // success — stop retrying
      } catch(e) {
        if (attempt < maxTries) {
          await new Promise(res => setTimeout(res, delay));
        }
        // On final attempt failure: leave connected as-is, don't wipe it to false
      }
    }
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
      document.querySelectorAll('.at-lb[data-lev]').forEach(b => b.classList.toggle('active', +b.dataset.lev === atLeverage));
      atOrderType = s.order_type || 'auto';
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
      // _silent=true: a single 401 won't show the auth overlay immediately.
      // We track consecutive failures and only hard-disconnect after POLL_FAIL_LIMIT.
      const st = await apiFetch('/api/alpaca/auto-status', { _silent: true });
      _pollFailures = 0; // successful response — reset failure counter

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

      // Geo-risk + lunch-lull gauge + regime
      renderRiskGauge(st.geoRisk || null, st.lunchLull || false, st.regime || null);

      // Sector heatmap
      if (Array.isArray(st.hotSectors) || Array.isArray(st.coldSectors)) {
        renderHotSectors(st.hotSectors || [], st.coldSectors || []);
      }

      // Live scan feed
      if (Array.isArray(st.analyses) && st.analyses.length) {
        renderScanFeed(st.analyses);
      }

    } catch(e) {
      if (e.message === 'session_expired') {
        _pollFailures++;
        if (_pollFailures >= POLL_FAIL_LIMIT) {
          // Confirmed session has gone — hard disconnect now
          _hardDisconnect();
        }
        // Otherwise stay connected; might be a transient blip — try again next tick
      }
      // Non-auth errors (network, JSON parse, server error) are silently ignored
    }
  }

  function startStatusPoll() {
    _pollFailures = 0;
    clearInterval(statusPoll);
    statusPoll = setInterval(pollStatus, 5000);
    pollStatus();
  }

  function stopStatusPoll() { clearInterval(statusPoll); statusPoll = null; }

  // ── Session keep-alive — pings /api/auth/me every 10 min to prevent expiry ──
  // This is important for long-running trading sessions where the user may leave
  // the page idle without any other API calls being made.
  function startKeepAlive() {
    clearInterval(keepAlivePoll);
    keepAlivePoll = setInterval(async () => {
      try { await fetch('/api/auth/me', { credentials: 'include' }); } catch {}
    }, 10 * 60 * 1000); // every 10 minutes
  }

  function stopKeepAlive() { clearInterval(keepAlivePoll); keepAlivePoll = null; }

  // ── Geo-risk + session-state gauge + regime ─────────────────────────────────
  function renderRiskGauge(geo, lunchLull, regime) {
    const el = $('atRiskGauge');
    if (!el) return;

    const pills = [];

    // ── Market Regime banner — always shown first, most prominent ────────────
    if (regime?.regime) {
      const r = regime.regime;
      const regimeMeta = {
        BULL:  { cls: 'regime-bull',   icon: '🟢', label: 'BULL MODE',  sub: 'Long stocks preferred' },
        MIXED: { cls: 'regime-mixed',  icon: '🟡', label: 'MIXED MODE', sub: 'Selective entries only' },
        BEAR:  { cls: 'regime-bear',   icon: '🔴', label: 'BEAR MODE',  sub: 'Inverse ETFs activated' },
        CRASH: { cls: 'regime-crash',  icon: '🆘', label: 'CRASH MODE', sub: 'Inverse ETFs ONLY — longs blocked' },
      };
      const m = regimeMeta[r] || regimeMeta.MIXED;
      const spyLine = regime.spyChg != null ? ` · SPY ${regime.spyChg >= 0 ? '+' : ''}${regime.spyChg.toFixed(1)}%` : '';
      const vixLine = regime.vix   != null ? ` · VIX ${regime.vix.toFixed(0)}` : '';
      pills.push(`<span class="at-risk-pill at-regime-pill ${m.cls}">${m.icon} <strong>${m.label}</strong> — ${m.sub}${spyLine}${vixLine}</span>`);
      // EMA structure pills for SPY
      if (regime.spyAbove9 != null) {
        const ema9cls  = regime.spyAbove9  ? 'risk-low'  : 'risk-high';
        const ema21cls = regime.spyAbove21 ? 'risk-low'  : 'risk-high';
        const ema50cls = regime.spyAbove50 ? 'risk-low'  : 'risk-high';
        pills.push(`<span class="at-risk-pill ${ema9cls}">SPY EMA-9 ${regime.spyAbove9 ? '✓' : '✗'}</span>`);
        pills.push(`<span class="at-risk-pill ${ema21cls}">SPY EMA-21 ${regime.spyAbove21 ? '✓' : '✗'}</span>`);
        pills.push(`<span class="at-risk-pill ${ema50cls}">SPY EMA-50 ${regime.spyAbove50 ? '✓' : '✗'}</span>`);
      }
    }

    if (lunchLull) {
      pills.push(`<span class="at-risk-pill risk-neutral">🕛 Lunch Lull — thin tape (12–12:30 PM ET)</span>`);
    }

    if (geo) {
      const score    = geo.geoScore ?? 0;
      const cls      = score >= 60 ? 'risk-high' : score >= 30 ? 'risk-med' : 'risk-low';
      const icon     = score >= 60 ? '🔴' : score >= 30 ? '🟡' : '🟢';
      pills.push(`<span class="at-risk-pill ${cls}">${icon} GeoRisk ${score}/100</span>`);

      if (geo.vixSpike) {
        pills.push(`<span class="at-risk-pill risk-high">⚡ VIX ${geo.vix?.toFixed(1)} — volatility spike</span>`);
      } else if (geo.vix) {
        const vixCls = geo.vix >= 25 ? 'risk-med' : 'risk-low';
        pills.push(`<span class="at-risk-pill ${vixCls}">VIX ${geo.vix.toFixed(1)}</span>`);
      }

      if (geo.oilTension) {
        pills.push(`<span class="at-risk-pill risk-high">🛢 Oil Tension — Brent spread $${(geo.spread||0).toFixed(2)} · Tankers active</span>`);
      } else if (geo.wti) {
        pills.push(`<span class="at-risk-pill risk-neutral">WTI $${geo.wti.toFixed(2)}</span>`);
      }

      if (geo.broadDown) {
        pills.push(`<span class="at-risk-pill risk-high">📉 SPY ${geo.spyChg?.toFixed(2)}% — broad market selling</span>`);
      }
    }

    el.innerHTML = pills.length
      ? pills.join('')
      : `<span class="at-risk-pill risk-low">🟢 Market conditions nominal</span>`;
  }

  // ── Sector heatmap strip ────────────────────────────────────────────────────
  const SECTOR_INVERSE_LABELS = {
    XLK:['TECS','SQQQ'], XLF:['FAZ','SDS'], XLE:['DRIP','SCO'],
    XLV:['LABD','SDS'],  XLC:['SQQQ'],      XLY:['SDS','SPXS'],
    XLI:['TZA','SDS'],   XLB:['SDS'],       XLRE:['DRV'],
    XLU:['SDS'],         XLP:['SDS'],
  };
  function renderHotSectors(hotSectors, coldSectors) {
    const el = $('atSectorHeatmap');
    if (!el) return;
    const NAMES = {
      XLK:'Tech', XLF:'Finance', XLE:'Energy', XLV:'Health',
      XLI:'Industrial', XLC:'Comm', XLY:'ConsDisc', XLP:'Staples',
      XLB:'Materials', XLRE:'Real Estate', XLU:'Utilities',
    };
    const coldSet = new Set((coldSectors || []).map(s => s.etf));
    const all = [...(hotSectors || []), ...(coldSectors || [])];
    el.innerHTML = all.map(s => {
      const chg  = s.chg || 0;
      const sign = chg >= 0 ? '+' : '';
      const cls  = chg >= 0.5 ? 'sector-hot' : chg <= -0.3 ? 'sector-cold' : 'sector-flat';
      const name = NAMES[s.etf] || s.etf;
      const inverseTag = coldSet.has(s.etf)
        ? ` <span class="at-inverse-tag">↓ ${(SECTOR_INVERSE_LABELS[s.etf] || []).join('/')}</span>`
        : '';
      return `<span class="at-sector-chip ${cls}">${name} <b>${sign}${chg.toFixed(2)}%</b>${inverseTag}</span>`;
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

      // ── MA Ribbon ────────────────────────────────────────────────────────────
      const maFmt = (val, label, above) => val
        ? `<span class="at-ma-pill ${above ? 'ma-above' : 'ma-below'}" title="${label}=$${parseFloat(val).toFixed(2)}">${label} $${parseFloat(val).toFixed(2)}</span>`
        : '';
      const crossoverBadge = a.maCrossover
        ? `<span class="at-ma-pill ma-crossover" title="EMA-9 crossed above EMA-21 — fresh bullish momentum">⚡ Crossover</span>`
        : '';
      const ribbonBadge = a.maRibbon
        ? `<span class="at-ma-pill ma-ribbon" title="EMA-9 > EMA-21 > EMA-50 — full bull stack">▲ MA Ribbon</span>`
        : '';
      const maRibbonHtml = (a.ema9 || a.ema21 || a.ema50)
        ? `<div class="at-ma-ribbon">
            ${maFmt(a.ema9,  'EMA9',  a.aboveEMA9)}
            ${maFmt(a.ema21, 'EMA21', a.aboveEMA21)}
            ${maFmt(a.ema50, 'EMA50', a.aboveEMA50)}
            ${crossoverBadge}
            ${ribbonBadge}
          </div>`
        : '';

      // Detect inverse ETF from symbol name patterns used in INVERSE_ETF_SET
      const INVERSE_SYMS = new Set(['SQQQ','SPXS','SDOW','TZA','SRTY','FAZ','TECS','HIBS','SDS','QID','TWM','UVXY','UVIX','SOXS','BERZ','LABD','DRV','MIDZ','WEBS','DRIP','DUST','SCO','KOLD','DUG','GLL','ZSL','SVXY','NVDQ','NVD','MSTZ','TSLZ','TSDD','PLTD','CORD','AAPD','AMDD','GGLS','QQQD','SBIT','RGTZ','RXD']);
      const isInvSym = INVERSE_SYMS.has(a.symbol);
      const invBadge = isInvSym ? `<span class="at-inverse-badge" title="Inverse ETF — profits when market falls">INV</span>` : '';

      return `<div class="at-feed-row ${isBuy?'at-feed-buy':'at-feed-hold'} ${isInvSym?'at-feed-inverse':''}">
        <div class="at-feed-top">
          <span class="at-feed-sym">${a.symbol}</span>
          ${invBadge}
          <span class="at-feed-sig at-sig-${(a.signal||'hold').toLowerCase()}">${a.signal||'HOLD'}</span>
          <span class="at-feed-conf">${a.confidence||0}%</span>
          ${levStr}
          <span class="at-feed-px">$${a.price?parseFloat(a.price).toFixed(2):'--'}</span>
          <span class="at-feed-rsi">RSI ${a.rsi?parseFloat(a.rsi).toFixed(0):'--'}</span>
        </div>
        ${maRibbonHtml}
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
        trailing_stop_1pct:      'Trailing stop 1%',
        dynamic_ema21_stop:      'EMA-21 dynamic stop',
        below_ema50_breakdown:   'EMA-50 breakdown',
        below_ema21_and_ema50:   'EMA-21+50 double exit',
        price_below_ema21_x2:    'Below EMA-21 ×2',
        eod_force_close:         'EOD closed',
        held_overnight:          '🌙 Held overnight (trending)',
        unfilled_timeout:        'GTC timeout 30m',
      };
      const statusInfo = l => {
        if (l.status==='pending_fill') return { cls:'alog-pending', label:'Pending Fill' };
        if (l.status==='cancelled')   return { cls:'alog-cancelled', label:'Cancelled' };
        if (l.status==='open' && l.exit_reason==='held_overnight')
          return { cls:'alog-overnight', label:'🌙 Holding Overnight' };
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
      _pollFailures = 0;
      hideModal();
      updateConnStatus();
      loadAccount();
      await loadAutoSettings();   // auto-enables engine
      startStatusPoll();
      startKeepAlive();
      loadAutoLog();
    } catch(e) { if(errEl) errEl.textContent = e.message; }
    finally { btn.disabled=false; btn.textContent='Connect'; }
  }

  async function disconnect() {
    await apiFetch('/api/alpaca/credentials', { method:'DELETE' });
    connected=false; autoEnabled=false;
    stopStatusPoll();
    stopKeepAlive();
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
    if (resEl) { resEl.style.display=''; resEl.innerHTML='<div class="at-bt-loading"><div class="at-bt-spinner"></div> Fetching 60 days of data for 30 symbols (20 bull + 10 inverse ETF)… (~20s)</div>'; }
    try {
      const r = await apiFetch('/api/alpaca/backtest');
      if (r.error) throw new Error(r.error);
      const s  = r.stats  || {};
      const bs = r.bullStats    || {};
      const is = r.inverseStats || {};
      const trades = r.trades || [];

      const statColor = (wr, kelly, pnl) => ({
        winColor:  wr   >= 55 ? '#4ade80' : wr   >= 45 ? '#facc15' : '#f87171',
        pnlColor:  pnl  >= 0  ? '#4ade80' : '#f87171',
        kellyColor: kelly > 0 ? '#4ade80' : '#f87171',
        pnlSign:   pnl  >= 0  ? '+' : '',
      });
      const sc = statColor(s.winRate,  s.kelly,  s.totalPnl);
      const bc = statColor(bs.winRate, bs.kelly, bs.totalPnl);
      const ic = statColor(is.winRate, is.kelly, is.totalPnl);

      const verdict = s.kelly > 10 ? '🟢 Statistically profitable — Kelly is positive, deploy capital'
                    : s.kelly >  0 ? '🟡 Marginal edge — profitable but small, consider paper trading first'
                    : '🔴 Negative edge in this period — do not trade live until conditions improve';

      const summary = `<div class="at-bt-summary">
        <div class="at-bt-title">Volume Profile Strategy — 60-Day Backtest</div>
        <div class="at-bt-subtitle">Regime-Aware: ${trades.length} trades — 20 bull stocks + 10 inverse ETFs (SQQQ · SPXS · SDOW · TZA · SDS · QID · FAZ · TECS · SRTY · UVXY)</div>
        <div class="at-bt-stats">
          <div class="at-bt-stat">
            <div class="at-bt-stat-val" style="color:${sc.winColor}">${s.winRate}%</div>
            <div class="at-bt-stat-lbl">Win Rate (All)</div>
            <div class="at-bt-stat-sub">${s.wins}W / ${s.losses}L / ${s.expired} exp</div>
          </div>
          <div class="at-bt-stat">
            <div class="at-bt-stat-val">${s.avgRR}:1</div>
            <div class="at-bt-stat-lbl">Avg Risk:Reward</div>
            <div class="at-bt-stat-sub">TP=VAH / SL=VAL−0.5%</div>
          </div>
          <div class="at-bt-stat">
            <div class="at-bt-stat-val" style="color:${sc.pnlColor}">${sc.pnlSign}${s.totalPnl}%</div>
            <div class="at-bt-stat-lbl">Cumulative P&amp;L</div>
            <div class="at-bt-stat-sub">Avg win ${s.avgWin}% / Avg loss ${s.avgLoss}%</div>
          </div>
          <div class="at-bt-stat">
            <div class="at-bt-stat-val" style="color:${sc.kellyColor}">${s.kelly}%</div>
            <div class="at-bt-stat-lbl">Kelly Criterion</div>
            <div class="at-bt-stat-sub">Optimal position size</div>
          </div>
        </div>
        <div class="at-bt-verdict">${verdict}</div>
      </div>`;

      // ── Regime split panel — Bull vs Inverse ETF performance ──────────────
      const regimeSplit = `<div class="at-bt-regime-split">
        <div class="at-bt-regime-panel at-bt-bull-panel">
          <div class="at-bt-regime-title">📈 Bull Stocks (20 symbols)</div>
          <div class="at-bt-regime-stats">
            <div class="at-bt-regime-stat"><span style="color:${bc.winColor}">${bs.winRate}%</span><br><small>Win Rate</small></div>
            <div class="at-bt-regime-stat"><span style="color:${bc.pnlColor}">${bc.pnlSign}${bs.totalPnl}%</span><br><small>P&L</small></div>
            <div class="at-bt-regime-stat"><span style="color:${bc.kellyColor}">${bs.kelly}%</span><br><small>Kelly</small></div>
            <div class="at-bt-regime-stat"><span>${bs.total}</span><br><small>Trades</small></div>
          </div>
        </div>
        <div class="at-bt-regime-divider">⇄</div>
        <div class="at-bt-regime-panel at-bt-inv-panel">
          <div class="at-bt-regime-title">📉 Inverse ETFs (10 symbols) <span class="at-inverse-badge">INV</span></div>
          <div class="at-bt-regime-stats">
            <div class="at-bt-regime-stat"><span style="color:${ic.winColor}">${is.winRate}%</span><br><small>Win Rate</small></div>
            <div class="at-bt-regime-stat"><span style="color:${ic.pnlColor}">${ic.pnlSign}${is.totalPnl}%</span><br><small>P&L</small></div>
            <div class="at-bt-regime-stat"><span style="color:${ic.kellyColor}">${is.kelly}%</span><br><small>Kelly</small></div>
            <div class="at-bt-regime-stat"><span>${is.total}</span><br><small>Trades</small></div>
          </div>
          <div class="at-bt-regime-note">In BEAR/CRASH mode these become the primary universe — engine pivots to them automatically when SPY collapses</div>
        </div>
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

      const INVERSE_SYM_SET = new Set(['SQQQ','SPXS','SDOW','TZA','SDS','QID','FAZ','TECS','SRTY','UVXY']);
      const tradeRows = trades.slice(0, 80).map(t => {
        const hitCls  = t.hit==='tp' ? 'at-bt-tp' : t.hit==='sl' ? 'at-bt-sl' : 'at-bt-exp';
        const hitLbl  = t.hit==='tp' ? '✅ TP' : t.hit==='sl' ? '❌ SL' : '⏸ Exp';
        const pnlCls  = t.pnlPct >= 0 ? 'at-bt-pnl-pos' : 'at-bt-pnl-neg';
        const pnlSign = t.pnlPct >= 0 ? '+' : '';
        const trigLbl = t.trigger==='val_bounce' ? 'VAL' : 'POC';
        const isInv   = t.isInverse || INVERSE_SYM_SET.has(t.symbol);
        const invTag  = isInv ? `<span class="at-inverse-badge" style="margin-left:3px">INV</span>` : '';
        return `<div class="at-bt-row ${hitCls} ${isInv?'at-bt-row-inv':''}">
          <span class="at-bt-row-sym">${t.symbol}${invTag}</span>
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
        <div class="at-bt-trades-hdr">Trade Log (most recent ${Math.min(80,trades.length)} of ${trades.length}) — <span style="color:#f87171">red border</span> = inverse ETF</div>
        <div class="at-bt-trades-cols">
          <span>Symbol</span><span>Date</span><span>Trigger</span><span>Entry</span>
          <span>TP Target</span><span>SL Level</span><span>Result</span><span>P&amp;L %</span><span>R:R</span>
        </div>
        ${tradeRows}
      </div>`;

      if (resEl) resEl.innerHTML = summary + regimeSplit + breakdown + tradeList;
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
    document.querySelectorAll('.at-lb[data-lev]').forEach(btn => {
      btn.addEventListener('click', () => {
        atLeverage = +btn.dataset.lev;
        document.querySelectorAll('.at-lb[data-lev]').forEach(b => b.classList.toggle('active', b===btn));
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

    // Reset trade log + engine state
    $('atResetLog')?.addEventListener('click', async () => {
      if (!confirm('This will permanently delete all local trade history and reset the engine state (cooldowns, trailing stops, streaks).\n\nNote: positions and orders already on Alpaca are unaffected.\n\nContinue?')) return;
      const btn = $('atResetLog');
      btn.disabled = true; btn.textContent = 'Resetting…';
      try {
        const r = await apiFetch('/api/alpaca/auto-log', { method: 'DELETE' });
        if (r.ok) {
          const body = $('atLogBody');
          if (body) body.innerHTML = '<div class="at-empty">Trade log cleared — engine state reset and ready for a fresh start</div>';
        }
      } catch(e) {}
      btn.disabled = false; btn.textContent = '✕ Reset';
    });
  }

  // ── Reset — called on logout to stop polling and clear connection state ────
  function reset() {
    stopStatusPoll();
    stopKeepAlive();
    _pollFailures = 0;
    connected    = false;
    autoEnabled  = false;
    updateConnStatus();
  }

  // ── Page open ──────────────────────────────────────────────────────────────
  function open() {
    // checkCredentials already starts the poll + keep-alive if connected.
    // The extra .then() guard here prevents a second startStatusPoll if credentials
    // call is still in flight (it'll be a no-op since startStatusPoll clears first).
    checkCredentials();
    loadAutoLog();
  }

  // ── Tab visibility reconnect — when user returns to tab after being away ───
  // Re-validate the connection to catch any session expiry that happened while hidden.
  function _setupVisibilityReconnect() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && connected) {
        // Reset failure counter and let poll re-confirm connection status
        _pollFailures = 0;
        pollStatus();
      }
    });
  }

  function init() {
    bindEvents();
    _setupVisibilityReconnect();
  }

  return { init, open, checkCredentials, reset };

})();

document.addEventListener('DOMContentLoaded', () => alpacaTrader.init());
