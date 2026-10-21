/* ── VixionBot — Stock Scanner ──────────────────────────────────── */
(function () {
  'use strict';

  const DEFAULT_TICKERS = [
    'AAPL','MSFT','NVDA','TSLA','META','AMZN','AMD','GOOGL',
    'NFLX','PLTR','SOFI','MARA','COIN','RIOT','BAC','F',
    'SPY','QQQ','GE','NIO'
  ];

  const tickers   = [...DEFAULT_TICKERS];   // fixed list — no UI management
  let scanData    = [];
  let sortCol     = 'relVol';
  let sortDir     = 'desc';
  let countdown   = 60;
  let cdInterval  = null;
  let initialized = false;
  let filters     = { minPrice: null, maxPrice: null, minRelVol: null, minChg: null };
  let rejectedData = [];
  let liquidityPolicy = null;
  let bciEvents = [], bciView = 'top', bciTimer = null, bciLoading = false, bciInitialized = false;

  /* ── helpers ──────────────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  function bciCanFetch() {
    return document.visibilityState === 'visible' && $('page-scanner')?.classList.contains('active');
  }

  function fmtPrice(n) {
    if (n == null) return '--';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtVol(n) {
    if (n == null) return '--';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
  }
  function fmtMcap(n) {
    if (n == null) return '--';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9)  return (n / 1e9).toFixed(1)  + 'B';
    if (n >= 1e6)  return (n / 1e6).toFixed(0)  + 'M';
    return '--';
  }
  function bciEsc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function bciVal(value, suffix) {
    return value == null || value === '' ? 'Unavailable' : bciEsc(String(value) + (suffix || ''));
  }
  function bciTime(value) {
    if (!value) return 'Time unavailable';
    const d = new Date(value);
    return isNaN(d.getTime()) ? bciEsc(value) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  }
  function liquidityReasons(row) {
    const liquidity = row && row.liquidity;
    const reasons = Array.isArray(liquidity?.reasons) ? liquidity.reasons
      : Array.isArray(row?.reasons) ? row.reasons : [];
    return reasons.length ? reasons : ['Liquidity requirements were not met.'];
  }
  function spreadText(liquidity) {
    if (liquidity?.spreadPct == null || !Number.isFinite(Number(liquidity.spreadPct))) {
      return 'Spread unavailable';
    }
    return `Spread ${Number(liquidity.spreadPct).toFixed(2)}%`;
  }
  function renderLiquidityPolicy() {
    const el = $('nscLiquidityPolicy');
    if (!el) return;
    if (!liquidityPolicy) {
      el.textContent = 'Shared liquidity policy unavailable';
      return;
    }
    el.textContent = [
      `Shared liquidity policy: ≥ ${fmtVol(liquidityPolicy.minShareVolume)} shares/session`,
      `≥ ${fmtPrice(liquidityPolicy.minDollarVolume)} estimated dollar volume/session`,
      `≤ ${bciVal(liquidityPolicy.maxSpreadPct, '%')} spread`,
    ].join(' · ');
  }
  function renderRejected() {
    const section = $('nscRejectedSection');
    const summary = $('nscRejectedSummary');
    const list = $('nscRejectedList');
    if (!section || !summary || !list) return;
    section.hidden = rejectedData.length === 0;
    summary.textContent = `${rejectedData.length} candidate${rejectedData.length === 1 ? '' : 's'} excluded by shared liquidity policy`;
    list.innerHTML = rejectedData.map(row => {
      const liquidity = row?.liquidity || {};
      const metrics = [
        `Share volume: ${fmtVol(liquidity.shareVolume)}`,
        `Est. dollar volume: ${liquidity.dollarVolume == null ? 'Unavailable' : fmtPrice(liquidity.dollarVolume)}`,
        spreadText(liquidity),
      ].join(' · ');
      return `<li class="nsc-rejected-item"><strong>${bciEsc(row?.sym || row?.symbol || 'Unavailable')}</strong><span>${bciEsc(liquidityReasons(row).join(' · '))}</span><small>${bciEsc(metrics)}</small></li>`;
    }).join('');
  }
  function renderBciLiquidityRejected(rows) {
    const section = $('bciLiquidityRejected');
    const list = $('bciLiquidityRejectedList');
    if (!section || !list) return;
    const rejected = Array.isArray(rows) ? rows : [];
    section.hidden = rejected.length === 0;
    list.innerHTML = rejected.map(row =>
      `<li><strong>${bciEsc(row?.symbol || row?.sym || 'Unavailable')}</strong><span>${bciEsc(liquidityReasons(row).join(' · '))}</span></li>`
    ).join('');
  }
  function bciSafeHref(value) {
    try {
      const url = new URL(String(value || ''), window.location.origin);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  function bciViewEvents() {
    if (bciView === 'fda') return bciEvents.filter(e =>
      (Array.isArray(e.views) && e.views.includes('fda'))
      || /fda|clinical|trial|phase|drug|approval|\bind\b|pdufa|fast track|breakthrough|orphan/i.test((e.category || '') + ' ' + (e.headline || ''))
    );
    if (bciView === 'risk') return bciEvents.filter(e =>
      (Array.isArray(e.views) && e.views.includes('risk'))
      || (e.dilutionRisk && e.dilutionRisk !== 'NONE FOUND')
      || /bearish/i.test(e.direction || '')
      || (Array.isArray(e.riskFlags) && e.riskFlags.some(flag => !/unavailable|unverified/i.test(flag)))
    );
    return [...bciEvents].sort((a, b) => (b.opportunityScore ?? b.catalystScore ?? -Infinity) - (a.opportunityScore ?? a.catalystScore ?? -Infinity));
  }
  function renderBci() {
    const grid = $('bciGrid'), meta = $('bciMeta');
    if (!grid) return;
    const events = bciViewEvents();
    const payload = window._bciPayload || {};
    if (meta) meta.innerHTML = [
      payload.marketState ? `<span class="bci-pill">Market: ${bciEsc(payload.marketState)}</span>` : '',
      payload.updatedAt ? `<span>Feed updated ${bciTime(payload.updatedAt)}</span>` : '',
      payload.cached ? '<span class="bci-pill">Cached</span>' : '',
      payload.stale ? '<span class="bci-pill bci-stale">Stale data</span>' : '',
      Array.isArray(payload.sources) && payload.sources.length
        ? `<span>Sources: ${bciEsc(payload.sources.map(s => typeof s === 'string' ? s : `${s.name} ${s.status === 'live' ? `(${s.count})` : '(unavailable)'}`).join(', '))}</span>`
        : '',
      Array.isArray(payload.dataGaps) && payload.dataGaps.length ? `<span>Gaps: ${bciEsc(payload.dataGaps.join(', '))}</span>` : ''
    ].filter(Boolean).join('');
    if (!events.length) {
      grid.innerHTML = `<div class="bci-empty">${bciEvents.length ? 'No events match this view.' : 'No catalyst events available right now. Scanner data remains available above.'}</div>`;
      return;
    }
    grid.innerHTML = events.map((e, i) => {
      const pct = e.changePct == null ? null : Number(e.changePct);
      const direction = String(e.direction || '').toLowerCase();
      const riskFlags = Array.isArray(e.riskFlags) ? e.riskFlags : [];
      const risk = e.dilutionRisk && e.dilutionRisk !== 'NONE FOUND' ? `Dilution ${bciEsc(e.dilutionRisk)}` : '';
      const safeUrl = bciSafeHref(e.url);
      return `<article class="bci-card" data-bci-index="${i}" tabindex="0" role="button" aria-label="Open ${bciEsc(e.symbol || 'catalyst')}">
        <div class="bci-card-top"><span class="bci-symbol">${bciEsc(e.symbol || 'Unavailable')}</span><span class="bci-company">${bciEsc(e.company || 'Company unavailable')}</span><span class="bci-price">${fmtPrice(e.price)}</span></div>
        <div class="bci-metrics"><span class="bci-metric">Chg <strong class="${pct > 0 ? 'bci-up' : pct < 0 ? 'bci-down' : ''}">${pct == null ? 'Unavailable' : (pct > 0 ? '+' : '') + pct.toFixed(2) + '%'}</strong></span><span class="bci-metric">Vol <strong>${fmtVol(e.volume)}</strong></span><span class="bci-metric">Rel <strong>${bciVal(e.relVol, '×')}</strong></span><span class="bci-metric">Cap <strong>${fmtMcap(e.marketCap)}</strong></span><span class="bci-metric">Float <strong>${fmtVol(e.float)}</strong></span></div>
        <div class="bci-badges"><span class="bci-badge bci-category">${bciEsc(e.category || 'Unclassified')}</span><span class="bci-badge bci-score">Opportunity ${bciVal(e.opportunityScore)}</span><span class="bci-badge bci-score">Catalyst ${bciVal(e.catalystScore)}</span><span class="bci-badge bci-score">Explosive ${bciVal(e.explosivenessScore)}</span><span class="bci-badge bci-confidence">Confidence ${bciVal(e.confidence)}</span>${direction ? `<span class="bci-badge ${direction.includes('bearish') ? 'bci-direction-down' : direction === 'neutral' ? 'bci-direction-neutral' : 'bci-direction-up'}">${bciEsc(e.direction)}</span>` : ''}${risk ? `<span class="bci-badge bci-risk">${risk}</span>` : ''}</div>
        <span class="bci-headline">${bciEsc(e.headline || 'Headline unavailable')}</span>
        <details class="bci-detail"><summary>Why it matters &amp; risk</summary><p>${bciEsc(e.whyItMatters || 'Explanation unavailable.')}</p><p><strong>Flags:</strong> ${riskFlags.length ? bciEsc(riskFlags.join(' · ')) : 'No headline-based dilution flags found.'}</p></details>
        <div class="bci-foot">${safeUrl ? `<a class="bci-source" href="${bciEsc(safeUrl)}" target="_blank" rel="noopener noreferrer">${bciEsc(e.source || 'Source')}</a>` : `<span class="bci-source">Source unavailable</span>`}<span>${bciTime(e.publishedAt)}${e.verified ? ' · Source-linked' : ' · Unverified'}${e.duplicateCount > 1 ? ` · ${bciEsc(e.duplicateCount)} reports merged` : ''}</span></div>
      </article>`;
    }).join('');
    grid.querySelectorAll('.bci-card').forEach(card => {
      const open = () => {
        const e = events[Number(card.dataset.bciIndex)];
        if (e && typeof window.openStock === 'function') window.openStock(e.symbol, { name: e.company, price: e.price, previousClose: e.changePct != null && Number(e.changePct) !== -100 ? Number(e.price) / (1 + Number(e.changePct) / 100) : e.price });
      };
      card.addEventListener('click', ev => { if (!ev.target.closest('a')) open(); });
      card.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    });
  }
  async function fetchBci(force) {
    if (bciLoading || !bciCanFetch()) return;
    bciLoading = true;
    const stateEl = $('bciState'), btn = $('bciRefresh');
    if (stateEl) stateEl.textContent = 'Loading catalyst feed…';
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch('/api/catalyst-intel' + (force ? '?force=1' : ''), { credentials: 'include' });
      if (resp.status === 401) throw new Error('Sign in required to view catalyst intelligence.');
      if (!resp.ok) throw new Error(resp.status === 429 ? 'Provider rate limit; retry shortly.' : 'Catalyst provider unavailable.');
      const data = await resp.json();
      if (!data.ok && data.error) throw new Error(data.error);
      window._bciPayload = data; bciEvents = Array.isArray(data.events) ? data.events : [];
      renderBci();
      renderBciLiquidityRejected(data.liquidityRejected);
      if (stateEl) stateEl.textContent = data.stale ? 'Showing stale feed' : `Updated ${bciTime(data.updatedAt)}`;
    } catch (err) {
      if (bciEvents.length) {
        window._bciPayload = {
          ...(window._bciPayload || {}),
          stale: true,
          dataGaps: [...new Set([...(window._bciPayload?.dataGaps || []), err.message || 'Refresh unavailable'])],
        };
        renderBci();
        if (stateEl) stateEl.textContent = 'Showing last available feed';
      } else {
        if (stateEl) stateEl.textContent = 'Catalyst feed unavailable';
        if ($('bciGrid')) $('bciGrid').innerHTML = `<div class="bci-error">${bciEsc(err.message || 'Unable to load catalyst intelligence.')} Scanner remains available above.</div>`;
      }
    } finally { bciLoading = false; if (btn) btn.disabled = false; }
  }
  function startBciTimer() {
    clearInterval(bciTimer);
    bciTimer = setInterval(() => { if (bciCanFetch()) fetchBci(false); }, 180000);
  }
  function initBci() {
    if (bciInitialized) {
      fetchBci(false);
      startBciTimer();
      return;
    }
    bciInitialized = true;
    $('bciRefresh')?.addEventListener('click', () => fetchBci(true));
    document.querySelectorAll('.bci-tab').forEach(tab => tab.addEventListener('click', () => {
      bciView = tab.dataset.bciView; document.querySelectorAll('.bci-tab').forEach(t => t.classList.toggle('bci-active', t === tab)); renderBci();
    }));
    fetchBci(false);
    startBciTimer();
  }

  /* ── filtering ────────────────────────────────────────────────────────────── */
  function applyFilters(data) {
    return data.filter(r => {
      if (filters.minPrice  != null && (r.price  ?? 0) < filters.minPrice)  return false;
      if (filters.maxPrice  != null && (r.price  ?? 0) > filters.maxPrice)  return false;
      if (filters.minRelVol != null && (r.relVol ?? 0) < filters.minRelVol) return false;
      if (filters.minChg    != null && (r.change ?? 0) < filters.minChg)    return false;
      return true;
    });
  }

  /* ── sorting ──────────────────────────────────────────────────────────────── */
  function sortData(data) {
    return [...data].sort((a, b) => {
      const nullVal = sortDir === 'desc' ? -Infinity : Infinity;
      let va = a[sortCol] ?? nullVal;
      let vb = b[sortCol] ?? nullVal;
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
  }

  /* ── table rendering ──────────────────────────────────────────────────────── */
  function renderTable() {
    const body    = $('nscBody');
    const countEl = $('nscCount');
    if (!body) return;

    const filtered = applyFilters(scanData);
    const sorted   = sortData(filtered);

    if (countEl) {
      countEl.textContent = sorted.length
        ? sorted.length + ' stock' + (sorted.length !== 1 ? 's' : '')
        : '';
    }

    /* update sort arrows */
    document.querySelectorAll('.nsc-table .nsc-th').forEach(th => {
      th.classList.remove('nsc-sort-asc', 'nsc-sort-desc');
      const arrow = th.querySelector('.nsc-arrow');
      if (arrow) arrow.textContent = '';
      if (th.dataset.col === sortCol) {
        th.classList.add(sortDir === 'asc' ? 'nsc-sort-asc' : 'nsc-sort-desc');
        if (arrow) arrow.textContent = sortDir === 'asc' ? ' ↑' : ' ↓';
      }
    });

    if (!sorted.length) {
      body.innerHTML = `<tr><td colspan="10" class="nsc-empty-row">No stocks match the current filters</td></tr>`;
      return;
    }

    body.innerHTML = sorted.map(r => {
      const surge   = r.relVol != null && r.relVol >= 2;
      const chgCls  = r.change > 0 ? 'nsc-up' : r.change < 0 ? 'nsc-dn' : '';
      const chgSign = r.change > 0 ? '+' : '';
      const rsiCls  = r.rsi14 != null
        ? (r.rsi14 < 30 ? 'nsc-rsi-os' : r.rsi14 > 70 ? 'nsc-rsi-ob' : '')
        : '';
      const nearHigh = r.w52Dist != null && r.w52Dist >= -3;
      const safeName = bciEsc(r.name || '');
      const liquidity = r.liquidity || {};
      const liquidityInfo = [
        `Est. $ vol ${liquidity.dollarVolume == null ? 'Unavailable' : fmtPrice(liquidity.dollarVolume)}`,
        spreadText(liquidity),
      ].join(' · ');
      return `<tr class="${surge ? 'nsc-surge' : ''}">
        <td class="nsc-sym-cell">
          <span class="nsc-sym">${bciEsc(r.sym || r.symbol || 'Unavailable')}</span>
          <span class="nsc-name-small">${safeName}</span>
          <span class="nsc-name-small nsc-liquidity-info">${bciEsc(liquidityInfo)}</span>
        </td>
        <td class="nsc-r">${fmtPrice(r.price)}</td>
        <td class="nsc-r ${chgCls}">${r.change != null ? chgSign + r.change.toFixed(2) + '%' : '--'}</td>
        <td class="nsc-r">${fmtVol(r.volume)}</td>
        <td class="nsc-r ${surge ? 'nsc-relvol-hi' : ''}">${r.relVol != null ? r.relVol.toFixed(2) + '×' : '--'}</td>
        <td class="nsc-r">${r.atr14 != null ? r.atr14 : '--'}</td>
        <td class="nsc-r ${rsiCls}">${r.rsi14 != null ? r.rsi14 : '--'}</td>
        <td class="nsc-r">${fmtVol(r.float ?? r.floatSh)}</td>
        <td class="nsc-r">${fmtMcap(r.marketCap)}</td>
        <td class="nsc-r ${nearHigh ? 'nsc-52hi' : ''}">${r.w52Dist != null ? (r.w52Dist >= 0 ? '+' : '') + r.w52Dist.toFixed(1) + '%' : '--'}</td>
      </tr>`;
    }).join('');
  }

  /* ── data fetch ───────────────────────────────────────────────────────────── */
  async function fetchData() {
    if (!tickers.length) return;
    const loadEl   = $('nscLoading');
    const statusEl = $('nscStatus');
    if (loadEl)   loadEl.style.display = 'flex';
    if (statusEl) statusEl.textContent = 'Scanning ' + tickers.length + ' tickers…';

    try {
      const resp = await fetch('/api/scanner-batch', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ symbols: tickers }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      scanData = data.results || [];
      rejectedData = Array.isArray(data.rejected) ? data.rejected : [];
      liquidityPolicy = data.liquidityPolicy || null;
      renderTable();
      renderLiquidityPolicy();
      renderRejected();
      if (statusEl) statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Error: ' + err.message;
    } finally {
      if (loadEl) loadEl.style.display = 'none';
    }
  }

  /* ── auto-refresh countdown ───────────────────────────────────────────────── */
  function startCountdown() {
    clearInterval(cdInterval);
    countdown = 60;
    const cdEl = $('nscCountdown');
    if (cdEl) cdEl.textContent = '60s';
    cdInterval = setInterval(() => {
      countdown--;
      if (cdEl) cdEl.textContent = countdown + 's';
      if (countdown <= 0) {
        countdown = 60;
        if (cdEl) cdEl.textContent = '60s';
        fetchData();
      }
    }, 1000);
  }

  /* ── read filter inputs ───────────────────────────────────────────────────── */
  function readFilters() {
    const pv = id => { const n = parseFloat($(id)?.value); return isNaN(n) ? null : n; };
    filters.minPrice  = pv('nscMinPrice');
    filters.maxPrice  = pv('nscMaxPrice');
    filters.minRelVol = pv('nscMinRelVol');
    filters.minChg    = pv('nscMinChg');
  }

  function clearFilterInputs() {
    ['nscMinPrice', 'nscMaxPrice', 'nscMinRelVol', 'nscMinChg'].forEach(id => {
      const el = $(id);
      if (!el) return;
      // Works for both <select> (reset to first option) and any legacy <input>
      if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    });
  }

  /* ── init ─────────────────────────────────────────────────────────────────── */
  function init() {
    if (initialized) return;
    initialized = true;

    fetchData();
    startCountdown();
    initBci();
    window.macroContext?.init();
    window.macroContext?.resume();

    /* sortable column headers */
    document.querySelectorAll('.nsc-table .nsc-th[data-col]').forEach(th => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (sortCol === col) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
        else { sortCol = col; sortDir = 'desc'; }
        renderTable();
      });
    });

    /* refresh button */
    $('nscRefreshBtn')?.addEventListener('click', () => {
      fetchData();
      startCountdown();
    });

    /* filters */
    $('nscApplyFilters')?.addEventListener('click', () => {
      readFilters();
      renderTable();
    });
    $('nscResetFilters')?.addEventListener('click', () => {
      filters = { minPrice: null, maxPrice: null, minRelVol: null, minChg: null };
      clearFilterInputs();
      renderTable();
    });

    /* refresh when tab becomes visible again */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        fetchData();
        startCountdown();
        if (bciCanFetch()) fetchBci(false);
        window.macroContext?.resume();
      }
    });
  }

  /* pause countdown (e.g. on logout) */
  function pause() {
    clearInterval(cdInterval);
    cdInterval = null;
    clearInterval(bciTimer);
    bciTimer = null;
    window.macroContext?.pause();
  }

  /* resume: refresh immediately + restart countdown */
  function resume() {
    if (!initialized) { init(); return; }
    fetchData();
    startCountdown();
    fetchBci(false);
    startBciTimer();
    window.macroContext?.resume();
  }

  window.stockScanner = { init, refresh: fetchData, pause, resume };

  /* Compat alias — app.js calls scanner.open() on nav to scanner page */
  window.scanner = { open: resume };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
