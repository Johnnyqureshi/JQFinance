// ── Johnny Qureshi Finance — Volatility Expansion Scanner ────────────────────

const veScanner = (() => {

  const $   = id => document.getElementById(id);
  const fmt = (n, d = 2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtV = v => !v ? '--' : v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(v);

  let _filter   = 'all';
  let _custom   = [];
  let _results  = [];
  let _veLev    = 1;

  // ── Tab switching (all 4 strategies) ────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.strat-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.strat-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const strat  = tab.dataset.strat;
        const bsPage = document.querySelector('.bs-page');
        const vePage = $('vePage');
        const eePage = $('eePage');
        const ctPage = $('ctPage');

        if (bsPage) bsPage.style.display = strat === 'bounce'       ? '' : 'none';
        if (vePage) vePage.style.display  = strat === 'volatility'   ? '' : 'none';
        if (eePage) eePage.style.display  = strat === 'earnings'     ? '' : 'none';
        if (ctPage) ctPage.style.display  = strat === 'countertrend' ? '' : 'none';

        if (strat === 'volatility')   loadAutoSettings();
        if (strat === 'earnings'     && typeof eeScanner  !== 'undefined') eeScanner.onTabOpen();
        if (strat === 'countertrend' && typeof ctScanner  !== 'undefined') ctScanner.onTabOpen();
      });
    });
  }

  // ── Filter buttons ────────────────────────────────────────────────────────
  function initFilters() {
    document.querySelectorAll('.ve-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ve-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _filter = btn.dataset.filter;
        renderTable(_results);
      });
    });
  }

  // ── Custom ticker chips ───────────────────────────────────────────────────
  function renderChips() {
    const el = $('veChips');
    if (!el) return;
    el.innerHTML = _custom.map(s =>
      `<span class="ve-chip">${s}<button class="ve-chip-x" data-sym="${s}" title="Remove">×</button></span>`
    ).join('');
    el.querySelectorAll('.ve-chip-x').forEach(b => {
      b.addEventListener('click', () => {
        _custom = _custom.filter(s => s !== b.dataset.sym);
        renderChips();
      });
    });
  }

  function addChip(raw) {
    const sym = raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
    if (!sym || _custom.includes(sym)) return;
    _custom.push(sym);
    renderChips();
  }

  function initInputs() {
    const inp    = $('veCustomInput');
    const addBtn = $('veAddBtn');
    if (inp) {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { addChip(inp.value); inp.value = ''; }
      });
    }
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (inp?.value.trim()) { addChip(inp.value); inp.value = ''; }
      });
    }
    $('veImportWl')?.addEventListener('click', async () => {
      try {
        const r  = await fetch('/api/watchlist');
        const d  = await r.json();
        (d.watchlist || []).forEach(s => { if (!_custom.includes(s)) _custom.push(s); });
        renderChips();
      } catch {}
    });
  }

  // ── Run scan ──────────────────────────────────────────────────────────────
  async function runScan() {
    const btn     = $('veRunBtn');
    const spinner = $('veSpinner');
    const summary = $('veSummary');
    if (btn)     { btn.disabled = true; }
    if (spinner) spinner.style.display = '';
    if (summary) summary.textContent = 'Scanning…';

    const symbols = _custom.length ? _custom.join(',') : '';
    const url     = symbols ? `/api/ve/scan?symbols=${symbols}` : '/api/ve/scan';

    try {
      const r  = await fetch(url);
      const d  = await r.json();
      _results = d.results || [];

      const badge = $('veTabBadge');
      if (badge) {
        const cnt = _results.filter(r => r.confirmed).length;
        if (cnt > 0) { badge.textContent = cnt; badge.style.display = ''; }
        else badge.style.display = 'none';
      }
      if (summary) summary.textContent = `${d.total} symbols scanned · ${d.confirmed} confirmed signals`;
      renderTable(_results);
    } catch (e) {
      if (summary) summary.textContent = 'Scan failed — ' + e.message;
    } finally {
      if (btn) btn.disabled = false;
      if (spinner) spinner.style.display = 'none';
    }
  }

  // ── Render results table ──────────────────────────────────────────────────
  function renderTable(results) {
    const wrap = $('veTableWrap');
    if (!wrap) return;

    let rows = results;
    if (_filter === 'confirmed') rows = results.filter(r => r.confirmed);
    else if (_filter === 'squeeze') rows = results.filter(r => r.isSqueezed || r.hasContraction);

    if (!rows.length) {
      wrap.innerHTML = `<div class="ve-empty">${_filter === 'all' ? 'No results yet — click Scan Universe.' : 'No signals match this filter.'}</div>`;
      return;
    }

    const head = `<table class="ve-table">
      <thead><tr>
        <th class="ve-th">Ticker</th>
        <th class="ve-th ve-th-r">Price</th>
        <th class="ve-th ve-th-r">ATR</th>
        <th class="ve-th ve-th-r">ATR/Avg</th>
        <th class="ve-th ve-th-r">BB Width</th>
        <th class="ve-th ve-th-r">Vol/Avg</th>
        <th class="ve-th ve-th-r">Range H</th>
        <th class="ve-th ve-th-r">Range L</th>
        <th class="ve-th">Contraction</th>
        <th class="ve-th">Squeeze</th>
        <th class="ve-th">Signal</th>
        <th class="ve-th"></th>
      </tr></thead>
      <tbody id="veTableBody">${rows.map(renderRow).join('')}</tbody>
    </table>`;
    wrap.innerHTML = head;

    wrap.querySelectorAll('.ve-trade-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (typeof goPage === 'function') goPage('trading');
        setTimeout(() => {
          const el = document.getElementById('atSymbol');
          if (el) el.value = btn.dataset.sym;
        }, 300);
      });
    });
  }

  function renderRow(r) {
    if (r.error) {
      return `<tr class="ve-row"><td class="ve-td" colspan="12"><span class="ve-sym">${r.symbol}</span> <span class="ve-err">${r.error}</span></td></tr>`;
    }
    const signalBadge = r.confirmed
      ? `<span class="ve-badge-${r.direction === 'LONG' ? 'long' : 'short'}">${r.direction}</span>`
      : r.hasContraction && r.isSqueezed
        ? `<span class="ve-badge-squeeze">SQUEEZE</span>`
        : `<span class="ve-badge-none">—</span>`;
    const tick = v => v
      ? '<span class="ve-tick pass">✓</span>'
      : '<span class="ve-tick fail">✗</span>';
    const volCls = r.volRatio >= 2 ? 've-vol-hot' : r.volRatio >= 1.5 ? 've-vol-surge' : '';
    const tradable = r.confirmed;
    return `<tr class="ve-row${r.confirmed ? ' ve-row-confirmed' : ''}">
      <td class="ve-td"><span class="ve-sym">${r.symbol}</span></td>
      <td class="ve-td ve-td-r">$${fmt(r.price)}</td>
      <td class="ve-td ve-td-r">${fmt(r.atr, 3)}</td>
      <td class="ve-td ve-td-r">${r.atrRatio != null ? r.atrRatio.toFixed(2) + 'x' : '--'}</td>
      <td class="ve-td ve-td-r">${fmt(r.bbWidth, 2)}%</td>
      <td class="ve-td ve-td-r ${volCls}">${r.volRatio != null ? r.volRatio.toFixed(1) + 'x' : '--'}</td>
      <td class="ve-td ve-td-r">$${fmt(r.rangeHigh)}</td>
      <td class="ve-td ve-td-r">$${fmt(r.rangeLow)}</td>
      <td class="ve-td">${tick(r.hasContraction)} ${r.contractionBars != null ? r.contractionBars + ' bars' : ''}</td>
      <td class="ve-td">${tick(r.isSqueezed)}</td>
      <td class="ve-td">${signalBadge}</td>
      <td class="ve-td">
        ${tradable ? `<button class="ve-trade-btn" data-sym="${r.symbol}">Trade →</button>` : ''}
      </td>
    </tr>`;
  }

  // ── Auto-trade settings ───────────────────────────────────────────────────
  async function loadAutoSettings() {
    try {
      const r = await fetch('/api/ve/auto-settings', { credentials: 'include' });
      if (r.status === 401) return;
      const d = await r.json();
      const toggle = $('veAutoEnabled');
      if (toggle) toggle.checked = !!d.enabled;
      const amtEl = $('veAmount');
      if (amtEl) amtEl.value = d.amount || 1000;
      _veLev = d.leverage || 1;
      document.querySelectorAll('.ve-lb').forEach(b => {
        b.classList.toggle('active', +b.dataset.lev === _veLev);
      });
      const panel = $('veAutoPanel');
      if (panel) panel.style.display = d.enabled ? '' : 'none';
      const log = $('veLogSection');
      if (log && d.enabled) { log.style.display = ''; loadTradeLog(); }
    } catch {}
  }

  async function saveAutoSettings() {
    const enabled  = $('veAutoEnabled')?.checked;
    const amount   = parseFloat($('veAmount')?.value) || 1000;
    const saveMsg  = $('veSaveMsg');
    const saveBtn  = $('veSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const r = await fetch('/api/ve/auto-settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, amount, leverage: _veLev }),
      });
      if (r.status === 401) { if (saveMsg) { saveMsg.textContent = 'Please log in first.'; saveMsg.className = 've-save-msg err'; } return; }
      if (saveMsg) { saveMsg.textContent = 'Settings saved!'; saveMsg.className = 've-save-msg ok'; }
      setTimeout(() => { if (saveMsg) saveMsg.textContent = ''; }, 3000);
    } catch (e) {
      if (saveMsg) { saveMsg.textContent = 'Save failed: ' + e.message; saveMsg.className = 've-save-msg err'; }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ── Trade log ─────────────────────────────────────────────────────────────
  async function loadTradeLog() {
    try {
      const r = await fetch('/api/ve/trade-log', { credentials: 'include' });
      if (r.status === 401) return;
      const rows = await r.json();
      const body = $('veLogBody');
      if (!body) return;
      if (!rows.length) { body.innerHTML = '<div class="ve-empty">No auto-trades yet — bot will trade when signals fire during market hours.</div>'; return; }
      body.innerHTML = rows.map(row => {
        const isBuy  = row.side === 'buy';
        const sideCls = isBuy ? 've-side-buy' : 've-side-sell';
        return `<div class="ve-log-row">
          <div class="ve-log-left">
            <span class="ve-log-sym">${row.symbol}</span>
            <span class="ve-log-meta">
              <span class="${sideCls}">${row.side?.toUpperCase()}</span>
              · ${row.shares || '?'} shares · entry $${fmt(row.entry_price)}
            </span>
          </div>
          <div class="ve-log-right">
            ${row.tp_price ? `<span class="ve-log-tp">TP $${fmt(row.tp_price)}</span>` : ''}
            ${row.sl_price ? `<span class="ve-log-sl">SL $${fmt(row.sl_price)}</span>` : ''}
            <span class="ve-log-status">${row.status || 'open'}</span>
          </div>
          <div class="ve-log-date">${row.created_at?.slice(0, 16) || ''}</div>
        </div>`;
      }).join('');
    } catch {}
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    initTabs();
    initFilters();
    initInputs();

    $('veRunBtn')?.addEventListener('click', runScan);
    $('veSaveBtn')?.addEventListener('click', saveAutoSettings);
    $('veLogRefresh')?.addEventListener('click', loadTradeLog);

    // Auto-trade toggle shows/hides config panel
    $('veAutoEnabled')?.addEventListener('change', e => {
      const panel  = $('veAutoPanel');
      const logSec = $('veLogSection');
      if (panel)  panel.style.display  = e.target.checked ? '' : 'none';
      if (logSec) logSec.style.display = e.target.checked ? '' : 'none';
      if (e.target.checked) loadTradeLog();
    });

    // Leverage buttons
    document.querySelectorAll('.ve-lb').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ve-lb').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _veLev = parseInt(btn.dataset.lev);
      });
    });
  }

  return { init };

})();

document.addEventListener('DOMContentLoaded', () => veScanner.init());
