/* ── Johnny Qureshi Finance — Stock Scanner ──────────────────────────────────── */
(function () {
  'use strict';

  const DEFAULT_TICKERS = [
    'AAPL','MSFT','NVDA','TSLA','META','AMZN','AMD','GOOGL',
    'NFLX','PLTR','SOFI','MARA','COIN','RIOT','BAC','F',
    'SPY','QQQ','GE','NIO'
  ];

  let tickers     = [];
  let scanData    = [];
  let sortCol     = 'relVol';
  let sortDir     = 'desc';
  let countdown   = 60;
  let cdInterval  = null;
  let initialized = false;
  let filters     = { minPrice: null, maxPrice: null, minRelVol: null, minChg: null };

  /* ── helpers ──────────────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);

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

  function saveTickers() {
    try { localStorage.setItem('nsc_tickers', JSON.stringify(tickers)); } catch (_) {}
  }
  function loadTickers() {
    try {
      const v = JSON.parse(localStorage.getItem('nsc_tickers') || 'null');
      return Array.isArray(v) && v.length ? v : null;
    } catch (_) { return null; }
  }

  /* ── chip rendering ───────────────────────────────────────────────────────── */
  function renderChips() {
    const wrap = $('nscChips');
    if (!wrap) return;
    wrap.innerHTML = tickers.map(t =>
      `<span class="nsc-chip">${t}<button class="nsc-chip-rm" data-sym="${t}" title="Remove">×</button></span>`
    ).join('');
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
      const safeName = (r.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<tr class="${surge ? 'nsc-surge' : ''}">
        <td class="nsc-sym-cell">
          <span class="nsc-sym">${r.sym}</span>
          <span class="nsc-name-small">${safeName}</span>
        </td>
        <td class="nsc-r">${fmtPrice(r.price)}</td>
        <td class="nsc-r ${chgCls}">${r.change != null ? chgSign + r.change.toFixed(2) + '%' : '--'}</td>
        <td class="nsc-r">${fmtVol(r.volume)}</td>
        <td class="nsc-r ${surge ? 'nsc-relvol-hi' : ''}">${r.relVol != null ? r.relVol.toFixed(2) + '×' : '--'}</td>
        <td class="nsc-r">${r.atr14 != null ? r.atr14 : '--'}</td>
        <td class="nsc-r ${rsiCls}">${r.rsi14 != null ? r.rsi14 : '--'}</td>
        <td class="nsc-r">${fmtVol(r.floatSh)}</td>
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
      renderTable();
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

  /* ── ticker management ────────────────────────────────────────────────────── */
  function addTicker(raw) {
    const sym = (raw || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').trim();
    if (!sym || tickers.includes(sym)) return false;
    tickers.push(sym);
    saveTickers();
    renderChips();
    fetchData();
    startCountdown();
    return true;
  }

  function removeTicker(sym) {
    tickers  = tickers.filter(t => t !== sym);
    scanData = scanData.filter(r => r.sym !== sym);
    saveTickers();
    renderChips();
    renderTable();
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
      if (el) el.value = '';
    });
  }

  /* ── init ─────────────────────────────────────────────────────────────────── */
  function init() {
    if (initialized) return;
    initialized = true;

    const saved = loadTickers();
    tickers = saved || [...DEFAULT_TICKERS];
    renderChips();
    fetchData();
    startCountdown();

    /* add ticker */
    const addInput = $('nscAddInput');
    const addBtn   = $('nscAddBtn');
    if (addInput && addBtn) {
      addBtn.addEventListener('click', () => {
        if (addTicker(addInput.value)) addInput.value = '';
      });
      addInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          if (addTicker(addInput.value)) addInput.value = '';
        }
      });
    }

    /* remove chip via event delegation */
    const chipsWrap = $('nscChips');
    if (chipsWrap) {
      chipsWrap.addEventListener('click', e => {
        const rm = e.target.closest('.nsc-chip-rm');
        if (rm) removeTicker(rm.dataset.sym);
      });
    }

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
      }
    });
  }

  /* pause countdown (e.g. on logout) */
  function pause() {
    clearInterval(cdInterval);
    cdInterval = null;
  }

  /* resume: refresh immediately + restart countdown */
  function resume() {
    if (!initialized) { init(); return; }
    fetchData();
    startCountdown();
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
