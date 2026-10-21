// ── VixionBot — Explosive Earnings Setup Scanner ────────────────

const eeScanner = (() => {

  const $   = id => document.getElementById(id);
  const fmt = (n, d = 2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPct = v => v == null || isNaN(v) ? '--' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

  let _filter  = 'all';
  let _custom  = [];
  let _results = [];
  let _eeLev   = 1;

  // ── Filter buttons ────────────────────────────────────────────────────────
  function initFilters() {
    document.querySelectorAll('.ee-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ee-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _filter = btn.dataset.filter;
        renderTable(_results);
      });
    });
  }

  // ── Custom ticker chips ───────────────────────────────────────────────────
  function renderChips() {
    const el = $('eeChips');
    if (!el) return;
    el.innerHTML = _custom.map(s =>
      `<span class="ee-chip">${s}<button class="ee-chip-x" data-sym="${s}" title="Remove">×</button></span>`
    ).join('');
    el.querySelectorAll('.ee-chip-x').forEach(b => {
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
    const inp    = $('eeCustomInput');
    const addBtn = $('eeAddBtn');
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
    $('eeImportWl')?.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/watchlist');
        const d = await r.json();
        (d.watchlist || []).forEach(s => { if (!_custom.includes(s)) _custom.push(s); });
        renderChips();
      } catch {}
    });
  }

  // ── Run scan ──────────────────────────────────────────────────────────────
  async function runScan() {
    const btn     = $('eeRunBtn');
    const spinner = $('eeSpinner');
    const summary = $('eeSummary');
    if (btn) btn.disabled = true;
    if (spinner) spinner.style.display = '';
    if (summary) summary.textContent = 'Scanning earnings universe…';

    const symbols = _custom.length ? _custom.join(',') : '';
    const url     = symbols ? `/api/ee/scan?symbols=${symbols}` : '/api/ee/scan';

    try {
      const r  = await fetch(url);
      const d  = await r.json();
      _results = d.results || [];

      const badge = $('eeTabBadge');
      if (badge) {
        const cnt = _results.filter(r => r.confirmed || r.signalType === 'ENTRY_ZONE' || r.signalType === 'SHAKEOUT_ENTRY').length;
        badge.textContent = cnt;
        badge.style.display = cnt > 0 ? '' : 'none';
      }

      const parts = [
        `${d.total} scanned`,
        d.entryZone   > 0 ? `${d.entryZone} Entry Zone`  : '',
        d.shakeout    > 0 ? `${d.shakeout} Shakeout`     : '',
        d.watching    > 0 ? `${d.watching} Watching`     : '',
        d.confirmed   > 0 ? `${d.confirmed} confirmed`   : '',
      ].filter(Boolean).join(' · ');
      if (summary) summary.textContent = parts || 'No results';

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
    const wrap = $('eeTableWrap');
    if (!wrap) return;

    let rows = results;
    if (_filter === 'entry')    rows = results.filter(r => r.signalType === 'ENTRY_ZONE');
    else if (_filter === 'shakeout') rows = results.filter(r => r.signalType === 'SHAKEOUT_ENTRY');
    else if (_filter === 'watching') rows = results.filter(r => r.signalType === 'WATCHING');

    if (!rows.length) {
      wrap.innerHTML = `<div class="ee-empty">No results match this filter.</div>`;
      return;
    }

    const head = `<table class="ee-table">
      <thead><tr>
        <th class="ee-th">Ticker</th>
        <th class="ee-th ee-th-r">Price</th>
        <th class="ee-th ee-th-r">Earnings</th>
        <th class="ee-th ee-th-r">EPS Surprise</th>
        <th class="ee-th ee-th-r">Rev Growth</th>
        <th class="ee-th ee-th-r">Gap %</th>
        <th class="ee-th ee-th-r">Vol Ratio</th>
        <th class="ee-th ee-th-r">EMA10 Dist</th>
        <th class="ee-th">Resistance</th>
        <th class="ee-th">Short Squeeze</th>
        <th class="ee-th">Signal</th>
        <th class="ee-th"></th>
      </tr></thead>
      <tbody>${rows.map(renderRow).join('')}</tbody>
    </table>`;
    wrap.innerHTML = head;

    wrap.querySelectorAll('.ee-trade-btn').forEach(btn => {
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
    if (r.error && !r.signalType) {
      return `<tr class="ee-row"><td class="ee-td" colspan="12">
        <span class="ee-sym">${r.symbol}</span>
        <span class="ee-err">${r.error}</span>
      </td></tr>`;
    }

    const signalBadge = (() => {
      switch (r.signalType) {
        case 'ENTRY_ZONE':    return `<span class="ee-badge-entry">ENTRY ZONE</span>`;
        case 'SHAKEOUT_ENTRY':return `<span class="ee-badge-shakeout">SHAKEOUT ENTRY</span>`;
        case 'WATCHING':      return `<span class="ee-badge-watching">WATCHING</span>`;
        default:              return `<span class="ee-badge-none">—</span>`;
      }
    })();

    const tick = v => v
      ? '<span class="ee-tick pass">✓</span>'
      : '<span class="ee-tick fail">✗</span>';

    const epsCls = r.passEPS
      ? 'ee-val-pass'
      : r.epsSurprisePct != null
        ? r.epsSurprisePct >= 0 ? 'ee-val-ok' : 'ee-val-miss'
        : '';

    const revCls = r.passRevenue ? 'ee-val-pass' : r.revenueGrowthPct != null ? 'ee-val-ok' : '';

    const gapCls = r.passGap
      ? 'ee-val-pass'
      : r.gapPct != null && r.gapPct > 0 ? 'ee-val-ok' : 'ee-val-miss';

    const volCls = r.passVolume ? 'ee-val-pass' : r.volRatio != null && r.volRatio >= 1 ? 'ee-val-ok' : 'ee-val-miss';

    const emaDist = r.ema10Distance != null ? r.ema10Distance.toFixed(1) + '%' : '--';
    const emaDistCls = r.nearEMA10 ? 'ee-val-pass' : 'ee-td-r';

    const sqFlag = r.shortSqueezePotential
      ? `<span class="ee-sq-flag">🔥 ${r.shortFloat?.toFixed(1)}% short</span>`
      : r.shortFloat != null
        ? `${r.shortFloat.toFixed(1)}%`
        : '--';

    const tradable = r.signalType === 'ENTRY_ZONE' || r.signalType === 'SHAKEOUT_ENTRY';

    return `<tr class="ee-row${r.confirmed ? ' ee-row-confirmed' : r.signalType ? ' ee-row-signal' : ''}">
      <td class="ee-td">
        <span class="ee-sym">${r.symbol}</span>
        ${r.earningsDate ? `<span class="ee-date">${r.earningsDate}</span>` : ''}
      </td>
      <td class="ee-td ee-td-r">$${fmt(r.price)}</td>
      <td class="ee-td ee-td-r">${r.earningsDate || '--'}</td>
      <td class="ee-td ee-td-r ${epsCls}">${fmtPct(r.epsSurprisePct)}</td>
      <td class="ee-td ee-td-r ${revCls}">${fmtPct(r.revenueGrowthPct)}</td>
      <td class="ee-td ee-td-r ${gapCls}">${r.gapPct != null ? fmtPct(r.gapPct) : '--'}</td>
      <td class="ee-td ee-td-r ${volCls}">${r.volRatio != null ? r.volRatio.toFixed(1) + '×' : '--'}</td>
      <td class="ee-td ee-td-r ${emaDistCls}">${emaDist}</td>
      <td class="ee-td">${tick(r.resistanceBroken)}</td>
      <td class="ee-td">${sqFlag}</td>
      <td class="ee-td">${signalBadge}</td>
      <td class="ee-td">
        ${tradable ? `<button class="ee-trade-btn" data-sym="${r.symbol}">Trade →</button>` : ''}
      </td>
    </tr>`;
  }

  // ── Auto-trade settings ───────────────────────────────────────────────────
  async function loadAutoSettings() {
    try {
      const r = await fetch('/api/ee/auto-settings', { credentials: 'include' });
      if (r.status === 401) return;
      const d = await r.json();
      const toggle = $('eeAutoEnabled');
      if (toggle) toggle.checked = !!d.enabled;
      const amtEl = $('eeAmount');
      if (amtEl) amtEl.value = d.amount || 1000;
      _eeLev = d.leverage || 1;
      document.querySelectorAll('.ee-lb').forEach(b => {
        b.classList.toggle('active', +b.dataset.lev === _eeLev);
      });
      const panel = $('eeAutoPanel');
      if (panel) panel.style.display = d.enabled ? '' : 'none';
      const log   = $('eeLogSection');
      if (log && d.enabled) { log.style.display = ''; loadTradeLog(); }
    } catch {}
  }

  async function saveAutoSettings() {
    const enabled = $('eeAutoEnabled')?.checked;
    const amount  = parseFloat($('eeAmount')?.value) || 1000;
    const saveMsg = $('eeSaveMsg');
    const saveBtn = $('eeSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const r = await fetch('/api/ee/auto-settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, amount, leverage: _eeLev }),
      });
      if (r.status === 401) {
        if (saveMsg) { saveMsg.textContent = 'Please log in first.'; saveMsg.className = 'ee-save-msg err'; }
        return;
      }
      if (saveMsg) { saveMsg.textContent = 'Settings saved!'; saveMsg.className = 'ee-save-msg ok'; }
      setTimeout(() => { if (saveMsg) saveMsg.textContent = ''; }, 3000);
    } catch (e) {
      if (saveMsg) { saveMsg.textContent = 'Save failed: ' + e.message; saveMsg.className = 'ee-save-msg err'; }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ── Trade log ─────────────────────────────────────────────────────────────
  async function loadTradeLog() {
    try {
      const r = await fetch('/api/ee/trade-log', { credentials: 'include' });
      if (r.status === 401) return;
      const rows = await r.json();
      const body = $('eeLogBody');
      if (!body) return;
      if (!rows.length) {
        body.innerHTML = '<div class="ee-empty">No auto-trades yet — bot fires when ENTRY ZONE or SHAKEOUT signal triggers during market hours.</div>';
        return;
      }
      body.innerHTML = rows.map(row => `
        <div class="ee-log-row">
          <div class="ee-log-left">
            <span class="ee-log-sym">${row.symbol}</span>
            <span class="ee-log-meta">
              <span class="ee-side-buy">BUY</span>
              · ${row.shares || '?'} shares · entry $${fmt(row.entry_price)}
              · <em>${row.signal || ''}</em>
            </span>
          </div>
          <div class="ee-log-right">
            ${row.tp_price ? `<span class="ee-log-tp">TP $${fmt(row.tp_price)}</span>` : ''}
            ${row.sl_price ? `<span class="ee-log-sl">SL $${fmt(row.sl_price)}</span>` : ''}
            <span class="ee-log-status">${row.status || 'open'}</span>
          </div>
          <div class="ee-log-date">${row.created_at?.slice(0, 16) || ''}</div>
        </div>
      `).join('');
    } catch {}
  }

  // ── Called when Explosive Earnings tab is opened ───────────────────────────
  function onTabOpen() {
    loadAutoSettings();
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    initFilters();
    initInputs();

    $('eeRunBtn')?.addEventListener('click', runScan);
    $('eeSaveBtn')?.addEventListener('click', saveAutoSettings);
    $('eeLogRefresh')?.addEventListener('click', loadTradeLog);

    $('eeAutoEnabled')?.addEventListener('change', e => {
      const panel  = $('eeAutoPanel');
      const logSec = $('eeLogSection');
      if (panel)  panel.style.display  = e.target.checked ? '' : 'none';
      if (logSec) logSec.style.display = e.target.checked ? '' : 'none';
      if (e.target.checked) loadTradeLog();
    });

    document.querySelectorAll('.ee-lb').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ee-lb').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _eeLev = parseInt(btn.dataset.lev);
      });
    });
  }

  return { init, onTabOpen };

})();

document.addEventListener('DOMContentLoaded', () => eeScanner.init());
