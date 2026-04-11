// ── Bounce 2.0 Scanner ────────────────────────────────────────────────────────
const bounceScanner = (() => {
  const $   = id => document.getElementById(id);
  const fmt = (n, d = 2) => n == null ? '—' : Number(n).toFixed(d);
  const fmtP = n => n == null ? '—' : '$' + Number(n).toFixed(2);
  const tick = ok => ok ? '<span class="bs-tick ok">✓</span>' : '<span class="bs-tick fail">✗</span>';

  let _results  = [];
  let _filter   = 'all';
  let _scanning = false;
  let _custom   = [];

  // ── Trading-hours gate ─────────────────────────────────────────────────────
  function marketStatus() {
    const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day  = et.getDay();
    const mins = et.getHours() * 60 + et.getMinutes();
    const isWeekday = day >= 1 && day <= 5;
    const isRegular = mins >= 570 && mins < 960;   // 9:30–16:00
    const isPre     = mins >= 240 && mins < 570;   // 04:00–9:30
    const isPost    = mins >= 960 && mins < 1200;  // 16:00–20:00
    return { isWeekday, isRegular, isPre, isPost, isExtended: isPre || isPost };
  }

  // ── Fetch & Scan ───────────────────────────────────────────────────────────
  async function runScan(symbols) {
    if (_scanning) return;
    _scanning = true;

    const runBtn   = $('bsRunBtn');
    const spinner  = $('bsSpinner');
    const summary  = $('bsSummary');
    const tableWrap = $('bsTableWrap');

    if (runBtn)   runBtn.disabled = true;
    if (spinner)  spinner.style.display = '';
    if (summary)  summary.textContent = 'Scanning…';

    const qs = symbols?.length ? `?symbols=${symbols.join(',')}` : '';

    try {
      const r   = await fetch('/api/bounce-scan' + qs);
      const d   = await r.json();
      _results  = d.results || [];

      if (summary) {
        const confirmed = _results.filter(x => x.confirmed).length;
        const at = new Date(d.scannedAt);
        summary.innerHTML = `Scanned <strong>${_results.length}</strong> symbols — 
          <span class="bs-count-confirmed">${confirmed} confirmed</span> — 
          <span class="bs-count-time">${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
      }

      applyFilterAndRender();
    } catch (e) {
      if (summary) summary.textContent = 'Scan failed: ' + e.message;
    } finally {
      _scanning = false;
      if (runBtn)  runBtn.disabled  = false;
      if (spinner) spinner.style.display = 'none';
    }
  }

  // ── Filter & Render table ──────────────────────────────────────────────────
  function applyFilterAndRender() {
    const tableWrap = $('bsTableWrap');
    if (!tableWrap) return;

    let rows = _results;
    if (_filter === 'confirmed') rows = rows.filter(r => r.confirmed);
    else if (_filter === 'setup')  rows = rows.filter(r => !r.confirmed && !r.error && (r.cond1 || r.cond2 || r.cond3));

    if (!rows.length) {
      tableWrap.innerHTML = `<div class="bs-empty">No results for "${_filter}" filter.</div>`;
      return;
    }

    tableWrap.innerHTML = `
      <table class="bs-table">
        <thead>
          <tr class="bs-thead-row">
            <th class="bs-th">Symbol</th>
            <th class="bs-th bs-th-r">Price</th>
            <th class="bs-th bs-th-r">EMA 8</th>
            <th class="bs-th bs-th-r">EMA 21</th>
            <th class="bs-th bs-th-r">EMA 34</th>
            <th class="bs-th bs-th-r">SMA 50</th>
            <th class="bs-th bs-th-r">Stoch %K</th>
            <th class="bs-th bs-th-r">Prev High</th>
            <th class="bs-th bs-th-c" title="8>21>34>50 stack">Trend</th>
            <th class="bs-th bs-th-c" title="Price between EMA8 and SMA50">Zone</th>
            <th class="bs-th bs-th-c" title="Stoch %K < 40">Stoch</th>
            <th class="bs-th bs-th-c" title="Close > Prev High">Entry</th>
            <th class="bs-th bs-th-c">Signal</th>
            <th class="bs-th bs-th-r">TP</th>
            <th class="bs-th bs-th-r">SL</th>
            <th class="bs-th bs-th-r">R:R</th>
            <th class="bs-th bs-th-act">Trade</th>
          </tr>
        </thead>
        <tbody id="bsTbody">
          ${rows.map(r => renderRow(r)).join('')}
        </tbody>
      </table>`;

    tableWrap.querySelectorAll('.bs-trade-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const sym = btn.dataset.sym;
        const tp  = parseFloat(btn.dataset.tp);
        const sl  = parseFloat(btn.dataset.sl);
        openTradePanel(sym, tp, sl);
      });
    });

    tableWrap.querySelectorAll('.bs-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.bs-trade-btn')) return;
        const sym = row.dataset.sym;
        if (sym && typeof openStock === 'function') {
          openStock(sym, null);
          if (typeof goPage === 'function') goPage('home');
        }
      });
    });
  }

  function renderRow(r) {
    if (r.error && !r.cond1 && !r.cond2) {
      return `<tr class="bs-row bs-row-error" data-sym="${r.symbol}">
        <td class="bs-td bs-sym">${r.symbol}</td>
        <td class="bs-td" colspan="16"><span class="bs-err">${r.error}</span></td>
      </tr>`;
    }

    const signalHtml = r.confirmed
      ? '<span class="bs-confirmed">BOUNCE SETUP CONFIRMED</span>'
      : '<span class="bs-pending">Partial (' + [r.cond1, r.cond2, r.cond3, r.cond4].filter(Boolean).length + '/4)</span>';

    const rrCls = r.rr >= 2 ? 'bs-rr-good' : r.rr >= 1 ? 'bs-rr-ok' : 'bs-rr-bad';

    return `<tr class="bs-row${r.confirmed ? ' bs-row-confirmed' : ''}" data-sym="${r.symbol}">
      <td class="bs-td bs-sym"><span class="bs-sym-text">${r.symbol}</span></td>
      <td class="bs-td bs-td-r">${fmtP(r.price)}</td>
      <td class="bs-td bs-td-r bs-ema">${fmt(r.ema8)}</td>
      <td class="bs-td bs-td-r bs-ema">${fmt(r.ema21)}</td>
      <td class="bs-td bs-td-r bs-ema">${fmt(r.ema34)}</td>
      <td class="bs-td bs-td-r bs-sma">${fmt(r.sma50)}</td>
      <td class="bs-td bs-td-r${r.stochK < 40 ? ' bs-stoch-low' : r.stochK > 80 ? ' bs-stoch-high' : ''}">${fmt(r.stochK)}</td>
      <td class="bs-td bs-td-r">${fmtP(r.prevHigh)}</td>
      <td class="bs-td bs-td-c">${tick(r.cond1)}</td>
      <td class="bs-td bs-td-c">${tick(r.cond2)}</td>
      <td class="bs-td bs-td-c">${tick(r.cond3)}</td>
      <td class="bs-td bs-td-c">${tick(r.cond4)}</td>
      <td class="bs-td">${signalHtml}</td>
      <td class="bs-td bs-td-r bs-tp">${fmtP(r.tpLevel)}</td>
      <td class="bs-td bs-td-r bs-sl">${fmtP(r.slLevel)}</td>
      <td class="bs-td bs-td-r ${rrCls}">${r.rr != null ? fmt(r.rr) + 'x' : '—'}</td>
      <td class="bs-td bs-td-act">
        <button class="bs-trade-btn" data-sym="${r.symbol}" data-tp="${r.tpLevel || ''}" data-sl="${r.slLevel || ''}" ${!r.confirmed ? 'disabled' : ''}>Buy</button>
      </td>
    </tr>`;
  }

  // ── Quick-trade panel (opens Alpaca trader) ────────────────────────────────
  function openTradePanel(sym, tp, sl) {
    // Switch to trading page and pre-fill the symbol
    if (typeof goPage === 'function') goPage('trading');
    setTimeout(() => {
      const symIn = document.getElementById('atSymbol');
      if (symIn) { symIn.value = sym; symIn.dispatchEvent(new Event('input')); }
    }, 300);
  }

  // ── Custom symbol input ────────────────────────────────────────────────────
  function setupCustomInput() {
    const inp    = $('bsCustomInput');
    const addBtn = $('bsAddBtn');
    const chips  = $('bsChips');

    function addSymbol(raw) {
      const sym = raw.trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (!sym || _custom.includes(sym)) return;
      _custom.push(sym);
      renderChips();
    }

    function renderChips() {
      if (!chips) return;
      chips.innerHTML = _custom.map(s =>
        `<span class="bs-chip">${s}<button class="bs-chip-rm" data-sym="${s}" title="Remove">×</button></span>`
      ).join('');
      chips.querySelectorAll('.bs-chip-rm').forEach(b => {
        b.addEventListener('click', () => {
          _custom = _custom.filter(s => s !== b.dataset.sym);
          renderChips();
        });
      });
    }

    inp?.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addSymbol(inp.value);
        inp.value = '';
      }
    });
    addBtn?.addEventListener('click', () => {
      addSymbol(inp.value);
      inp.value = '';
      inp.focus();
    });
  }

  // ── Filter buttons ─────────────────────────────────────────────────────────
  function setupFilters() {
    document.querySelectorAll('.bs-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.bs-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _filter = btn.dataset.filter;
        applyFilterAndRender();
      });
    });
  }

  // ── Single-symbol lookup ───────────────────────────────────────────────────
  async function lookupSingle(sym) {
    const panel = $('bsSinglePanel');
    if (!panel) return;
    panel.innerHTML = '<div class="bs-single-loading">Loading signal for <strong>' + sym + '</strong>…</div>';
    try {
      const r = await fetch('/api/bounce-signal/' + encodeURIComponent(sym));
      const d = await r.json();
      panel.innerHTML = renderSingleCard(d);

      panel.querySelector('.bs-single-trade-btn')?.addEventListener('click', () => {
        openTradePanel(sym, d.tpLevel, d.slLevel);
      });
    } catch (e) {
      panel.innerHTML = '<div class="bs-err">Error: ' + e.message + '</div>';
    }
  }

  function renderSingleCard(d) {
    if (d.error) return `<div class="bs-single-card bs-single-err"><strong>${d.symbol}</strong>: ${d.error}</div>`;

    const condRows = [
      { label: 'Trend stack (8>21>34>50)', ok: d.cond1, detail: d.cond1 ? 'EMAs aligned bullishly' : 'Not in uptrend' },
      { label: 'Pullback zone (SMA50–EMA8)', ok: d.cond2, detail: d.cond2 ? `Price ${fmtP(d.price)} is between EMA8 ${fmtP(d.ema8)} and SMA50 ${fmtP(d.sma50)}` : `Price ${fmtP(d.price)} outside zone` },
      { label: 'Stochastic %K < 40', ok: d.cond3, detail: `%K = ${fmt(d.stochK)} / %D = ${fmt(d.stochD)}` },
      { label: 'Close above prev bar high', ok: d.cond4, detail: `Close ${fmtP(d.price)} vs Prev High ${fmtP(d.prevHigh)}` },
    ];

    const rrCls = d.rr >= 2 ? 'bs-rr-good' : d.rr >= 1 ? 'bs-rr-ok' : 'bs-rr-bad';

    return `
      <div class="bs-single-card${d.confirmed ? ' confirmed' : ''}">
        <div class="bs-single-header">
          <span class="bs-single-sym">${d.symbol}</span>
          <span class="bs-single-price">${fmtP(d.price)}</span>
          ${d.confirmed ? '<span class="bs-badge-confirmed">BOUNCE SETUP CONFIRMED</span>' : '<span class="bs-badge-partial">Partial Setup</span>'}
        </div>
        <div class="bs-single-conds">
          ${condRows.map(c => `
            <div class="bs-cond-row ${c.ok ? 'ok' : 'fail'}">
              ${tick(c.ok)}
              <span class="bs-cond-label">${c.label}</span>
              <span class="bs-cond-detail">${c.detail}</span>
            </div>`).join('')}
        </div>
        <div class="bs-single-levels">
          <div class="bs-level-row">
            <span class="bs-level-lbl">Take Profit</span>
            <span class="bs-level-val bs-tp">${fmtP(d.tpLevel)}</span>
            <span class="bs-level-note">Prev swing high</span>
          </div>
          <div class="bs-level-row">
            <span class="bs-level-lbl">Stop Loss</span>
            <span class="bs-level-val bs-sl">${fmtP(d.slLevel)}</span>
            <span class="bs-level-note">SMA50 / pullback low</span>
          </div>
          <div class="bs-level-row">
            <span class="bs-level-lbl">Risk:Reward</span>
            <span class="bs-level-val ${rrCls}">${d.rr != null ? fmt(d.rr) + ' : 1' : '—'}</span>
          </div>
        </div>
        <div class="bs-single-exits">
          <span class="bs-exits-title">Exit Signals to Watch</span>
          <ul class="bs-exits-list">
            <li>Stochastic %K crosses above 80 (overbought)</li>
            <li>Daily close below EMA 8</li>
            <li>Price reaches previous swing high ${fmtP(d.tpLevel)}</li>
          </ul>
        </div>
        ${d.confirmed ? `<button class="bs-single-trade-btn">Place Trade →</button>` : ''}
      </div>`;
  }

  // ── PDT awareness banner ───────────────────────────────────────────────────
  function renderPDTBanner() {
    const banner = $('bsPDTBanner');
    if (!banner) return;
    const ms = marketStatus();
    if (!ms.isWeekday) {
      banner.innerHTML = '<span class="bs-pdt-warn">Markets closed (weekend). Scanner uses end-of-week closing data.</span>';
      banner.style.display = '';
    } else if (!ms.isRegular && !ms.isExtended) {
      banner.innerHTML = '<span class="bs-pdt-warn">Markets closed. Signals are based on most recent session data.</span>';
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  }

  // ── Watchlist import ───────────────────────────────────────────────────────
  async function importWatchlist() {
    try {
      const r = await fetch('/api/watchlist');
      const d = await r.json();
      const wl = d.watchlist || [];
      wl.forEach(sym => { if (!_custom.includes(sym)) _custom.push(sym); });
      document.getElementById('bsChips') && (() => {
        const chips = document.getElementById('bsChips');
        chips.innerHTML = _custom.map(s =>
          `<span class="bs-chip">${s}<button class="bs-chip-rm" data-sym="${s}" title="Remove">×</button></span>`
        ).join('');
        chips.querySelectorAll('.bs-chip-rm').forEach(b => {
          b.addEventListener('click', () => {
            _custom = _custom.filter(s => s !== b.dataset.sym);
          });
        });
      })();
    } catch (e) {
      console.error('[BS] Watchlist import failed:', e.message);
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    setupCustomInput();
    setupFilters();
    renderPDTBanner();

    $('bsRunBtn')?.addEventListener('click', () => {
      const syms = _custom.length ? _custom : [];
      runScan(syms);
    });

    $('bsImportWl')?.addEventListener('click', importWatchlist);

    // Single lookup input
    const singleInp = $('bsSingleInput');
    const singleBtn = $('bsSingleBtn');
    singleBtn?.addEventListener('click', () => {
      const sym = singleInp?.value.trim().toUpperCase();
      if (sym) lookupSingle(sym);
    });
    singleInp?.addEventListener('keydown', e => {
      if (e.key === 'Enter') singleBtn?.click();
    });
  }

  return { init, open: () => renderPDTBanner() };
})();

// named alias for nav integration
const scanner = bounceScanner;

document.addEventListener('DOMContentLoaded', () => bounceScanner.init());
