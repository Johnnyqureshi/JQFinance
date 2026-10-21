// ── VixionBot — Countertrend Setup Scanner ──────────────────────

const ctScanner = (() => {

  const $   = id => document.getElementById(id);
  const fmt = (n, d = 2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  let _filter  = 'all';
  let _custom  = [];
  let _results = [];

  // ── Signal badge HTML ─────────────────────────────────────────────────────
  function signalBadge(row) {
    if (row.signalType === '2618 RETEST ENTRY') {
      return `<span class="ct-badge ct-badge--2618">2618 RETEST</span>`;
    }
    if (row.signalType === 'COUNTERTREND SHORT SETUP') {
      return `<span class="ct-badge ct-badge--short">SHORT SETUP</span>`;
    }
    if (row.signalType === 'COUNTERTREND LONG SETUP') {
      return `<span class="ct-badge ct-badge--long">LONG SETUP</span>`;
    }
    return `<span class="ct-badge ct-badge--watch">WATCHING</span>`;
  }

  // ── Render results table ───────────────────────────────────────────────────
  function renderTable(rows) {
    const tbody  = $('ctTableBody');
    const table  = $('ctTable');
    const empty  = $('ctEmpty');
    if (!tbody) return;

    let filtered = rows;
    if (_filter === 'short')     filtered = rows.filter(r => r.direction === 'SHORT' && r.signalType !== '2618 RETEST ENTRY');
    if (_filter === 'long')      filtered = rows.filter(r => r.direction === 'LONG'  && r.signalType !== '2618 RETEST ENTRY');
    if (_filter === '2618')      filtered = rows.filter(r => r.signalType === '2618 RETEST ENTRY');
    if (_filter === 'confirmed') filtered = rows.filter(r => r.confirmed);

    if (!filtered.length) {
      if (table) table.style.display = 'none';
      if (empty) { empty.style.display = ''; empty.innerHTML = `No setups match the selected filter.`; }
      return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = '';

    tbody.innerHTML = filtered.map(r => {
      const rsiClass = r.rsi >= 70 ? 'ct-rsi--ob' : r.rsi <= 30 ? 'ct-rsi--os' : '';
      const rrClass  = r.riskReward >= 2 ? 'ct-rr--good' : '';
      const candle   = r.candlePattern || '--';
      const diverg   = r.divergence ? `<span class="ct-div-flag">${r.divergence}</span>` : '--';
      return `<tr class="${r.confirmed ? 'ct-row--hot' : ''}">
        <td class="ct-sym">${r.symbol}</td>
        <td>$${fmt(r.price)}</td>
        <td class="${rsiClass}">${fmt(r.rsi, 1)}</td>
        <td>${r.srLevel ? `$${fmt(r.srLevel)} <span class="ct-sr-lbl">${r.srLabel}</span>` : '--'}</td>
        <td>${candle}</td>
        <td>${diverg}</td>
        <td>${signalBadge(r)}</td>
        <td class="ct-stop">${r.stopLoss ? '$'+fmt(r.stopLoss) : '--'}</td>
        <td class="ct-target">${r.target ? '$'+fmt(r.target) : '--'}</td>
        <td class="${rrClass}">${r.riskReward ? r.riskReward+'x' : '--'}</td>
      </tr>`;
    }).join('');
  }

  // ── Chip input ────────────────────────────────────────────────────────────
  function renderChips() {
    const el = $('ctChips');
    if (!el) return;
    el.innerHTML = _custom.map((s, i) =>
      `<span class="ct-chip">${s}<button class="ct-chip-rm" data-i="${i}">×</button></span>`
    ).join('');
    el.querySelectorAll('.ct-chip-rm').forEach(btn =>
      btn.addEventListener('click', () => { _custom.splice(+btn.dataset.i, 1); renderChips(); })
    );
  }

  function initChipInput() {
    const inp = $('ctCustomInput');
    if (!inp) return;
    inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const val = inp.value.trim().toUpperCase();
      if (val && !_custom.includes(val)) { _custom.push(val); renderChips(); }
      inp.value = '';
    });
  }

  // ── Filter buttons ────────────────────────────────────────────────────────
  function initFilters() {
    document.querySelectorAll('.ct-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ct-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _filter = btn.dataset.filter;
        renderTable(_results);
      });
    });
  }

  // ── Run scan ──────────────────────────────────────────────────────────────
  async function runScan() {
    const btn     = $('ctScanBtn');
    const summary = $('ctSummary');
    const empty   = $('ctEmpty');
    const table   = $('ctTable');
    const total   = $('ctStatTotal');
    const conf    = $('ctStatConfirmed');

    if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
    if (summary) summary.textContent = 'Scanning…';
    if (empty) { empty.style.display = ''; empty.innerHTML = '<div class="ct-spin"><div class="spinner"></div></div>'; }
    if (table) table.style.display = 'none';

    const qs = _custom.length ? '?symbols=' + _custom.join(',') : '';
    try {
      const res  = await fetch('/api/ct/scan' + qs);
      const data = await res.json();
      _results = data.results || [];

      if (total) total.textContent = data.total ?? _results.length;
      if (conf)  conf.textContent  = data.confirmed ?? _results.filter(r => r.confirmed).length;

      const badge = $('ctTabBadge');
      const confirmedCount = _results.filter(r => r.confirmed).length;
      if (badge) { badge.textContent = confirmedCount; badge.style.display = confirmedCount ? '' : 'none'; }

      if (summary) summary.textContent =
        `Found ${_results.length} stocks scanned · ${confirmedCount} confirmed signal${confirmedCount !== 1 ? 's' : ''}`;

      renderTable(_results);
    } catch {
      if (summary) summary.textContent = 'Scan failed — check console';
      if (empty) { empty.style.display = ''; empty.textContent = 'Scan error.'; }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan Universe'; }
    }
  }

  // ── Auto-trade settings ───────────────────────────────────────────────────
  async function loadAutoSettings() {
    try {
      const res  = await fetch('/api/ct/auto-settings');
      if (!res.ok) return;
      const data = await res.json();
      const amtEl = $('ctAmount');
      const levEl = $('ctLeverage');
      const togEl = $('ctAutoToggle');
      const badEl = $('ctAutoBadge');
      if (amtEl) amtEl.value = data.amount || 500;
      if (levEl) levEl.value = data.leverage || 1;
      if (togEl) {
        togEl.dataset.enabled = data.enabled ? '1' : '0';
        togEl.textContent = data.enabled ? 'Disable Bot' : 'Enable Bot';
        togEl.classList.toggle('ct-auto-toggle--on', !!data.enabled);
      }
      if (badEl) { badEl.textContent = data.enabled ? 'ON' : 'OFF'; badEl.classList.toggle('ct-auto-badge--on', !!data.enabled); }
    } catch {}
  }

  async function saveAutoSettings(enabled) {
    const amt = parseFloat($('ctAmount')?.value) || 500;
    const lev = parseFloat($('ctLeverage')?.value) || 1;
    await fetch('/api/ct/auto-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, amount: amt, leverage: lev }),
    });
    await loadAutoSettings();
  }

  function initAutoCard() {
    const saveBtn   = $('ctAutoSave');
    const toggleBtn = $('ctAutoToggle');
    if (saveBtn)   saveBtn.addEventListener('click', () => saveAutoSettings(+toggleBtn?.dataset?.enabled || 0));
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      const newEnabled = toggleBtn.dataset.enabled === '1' ? 0 : 1;
      saveAutoSettings(newEnabled);
    });
  }

  // ── Trade log ─────────────────────────────────────────────────────────────
  async function loadTradeLog() {
    const body = $('ctLogBody');
    if (!body) return;
    try {
      const res  = await fetch('/api/ct/trade-log');
      const rows = await res.json();
      if (!rows.length) { body.innerHTML = '<div class="ct-empty">No auto-trades yet</div>'; return; }
      body.innerHTML = `<table class="ct-log-table">
        <thead><tr><th>Time</th><th>Symbol</th><th>Signal</th><th>R/R</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${new Date(r.created_at).toLocaleString()}</td>
          <td class="ct-sym">${r.symbol}</td>
          <td>${r.signal_type}</td>
          <td>${r.confidence ? r.confidence + 'x' : '--'}</td>
          <td>$${fmt(r.amount)}</td>
          <td class="${r.status === 'placed' ? 'ct-log-ok' : 'ct-log-err'}">${r.status}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    } catch { body.innerHTML = '<div class="ct-empty">Failed to load log</div>'; }
  }

  // ── Public: called when tab is opened ─────────────────────────────────────
  function onTabOpen() {
    loadAutoSettings();
    loadTradeLog();
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    initChipInput();
    initFilters();
    initAutoCard();

    const scanBtn = $('ctScanBtn');
    if (scanBtn) scanBtn.addEventListener('click', runScan);

    const logRefresh = $('ctLogRefresh');
    if (logRefresh) logRefresh.addEventListener('click', loadTradeLog);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { onTabOpen };

})();
