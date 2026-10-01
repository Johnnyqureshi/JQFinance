'use strict';
/* HomePulse — home-page "Command Center" module.
 *
 * Lives inside #homeEmpty (replacing the old Search Markets empty state).
 * Three parts: regime banner (client-side Risk-On / Risk-Off / Chop read),
 * market pulse strip (SPY/QQQ/IWM/VIX/10Y/BTC/Oil tiles, 60s refresh), and
 * a bot command center (bot status pills, today's realized P&L,
 * open positions). Read-only use of existing endpoints; never touches
 * strategy, service, API or table code.
 *
 * Pure logic (classifyRegime, formatters, trade summarizers) has no DOM
 * dependencies and is exported for node tests via module.exports.
 */
(function () {

  // ── Pure logic ────────────────────────────────────────────────────────────

  function fmtPct(x) {
    const n = numOrNull(x);
    if (n === null) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function fmtPrice(x) {
    const n = numOrNull(x);
    if (n === null) return '—';
    const abs = Math.abs(n);
    const digits = abs >= 1000 ? 0 : 2;
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtMoney(x) {
    const n = numOrNull(x);
    if (n === null) return '—';
    const sign = n > 0 ? '+' : n < 0 ? '−' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function fmtVix(x) {
    const n = numOrNull(x);
    return n === null ? '—' : n.toFixed(1);
  }

  // null/undefined/''/non-numeric all become null (Number(null) === 0 would
  // otherwise masquerade as a VIX of zero).
  function numOrNull(x) {
    if (x == null || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  // Regime read from SPY day-change % and VIX level.
  // Risk-On:  VIX < 20 and SPY up.  Risk-Off: VIX > 28 or SPY down > 1%.
  // Anything else is Chop. Missing inputs degrade gracefully (never Risk-On
  // without a VIX read; SPY-only Risk-Off still fires).
  function classifyRegime(spyChangePct, vixLevel) {
    const spy = numOrNull(spyChangePct);
    const vix = numOrNull(vixLevel);
    const spyOk = spy !== null;
    const vixOk = vix !== null;
    if (!spyOk && !vixOk) {
      return { label: 'Waiting', tone: 'neutral', reason: 'Market data is still loading.' };
    }
    const spyTxt = spyOk ? 'SPY ' + fmtPct(spy) : 'SPY —';
    if ((vixOk && vix > 28) || (spyOk && spy < -1)) {
      return {
        label: 'Risk-Off', tone: 'off',
        reason: vixOk && vix > 28
          ? `VIX at ${fmtVix(vix)} — fear is elevated, desks are de-risking.`
          : `${spyTxt} — broad selling pressure.`,
      };
    }
    if (vixOk && vix < 20 && spyOk && spy > 0) {
      return {
        label: 'Risk-On', tone: 'on',
        reason: `${spyTxt} with VIX at ${fmtVix(vix)} — desks are buying risk.`,
      };
    }
    return {
      label: 'Chop', tone: 'chop',
      reason: `${spyTxt}${vixOk ? ' with VIX at ' + fmtVix(vix) : ''} — no conviction either way.`,
    };
  }

  // Normalise a trade row from the bot APIs (camelCase or snake_case).
  function normTrade(t) {
    if (!t || typeof t !== 'object') return null;
    return {
      status: String(t.status || t.state || '').toLowerCase(),
      pnl: Number(t.pnl),
      created: t.createdAt || t.created_at || null,
      closed: t.closedAt || t.closed_at || null,
    };
  }

  function localDayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function isToday(created) {
    if (!created) return false;
    const d = new Date(created);
    if (Number.isNaN(d.getTime())) return false;
    return localDayKey(d) === localDayKey(new Date());
  }

  // Today's realized P&L = sum of pnl over trades closed today.
  function todayRealizedPnl(trades) {
    const today = localDayKey(new Date());
    let sum = 0, count = 0;
    for (const t of [].concat(trades || [])) {
      const n = normTrade(t);
      if (!n || n.status !== 'closed') continue;
      if (!n.created || localDayKey(new Date(n.created)) !== today) continue;
      if (Number.isFinite(n.pnl)) { sum += n.pnl; count++; }
    }
    return { pnl: sum, trades: count };
  }

  // Open positions = trades in an unresolved, filled state.
  function openPositionCount(trades) {
    let n = 0;
    for (const t of [].concat(trades || [])) {
      const s = normTrade(t);
      if (s && (s.status === 'open' || s.status === 'partial')) n++;
    }
    return n;
  }

  // Status pill from a bot status payload ({ enabled, mode }).
  function pillFor(status) {
    if (!status || !status.enabled) return { text: 'Paused', cls: 'hp-pill-paused' };
    if (status.mode === 'live') return { text: 'Live', cls: 'hp-pill-live' };
    return { text: 'Paper', cls: 'hp-pill-paper' };
  }

  // ── DOM / network (browser only) ──────────────────────────────────────────

  var PULSE_SYMBOLS = [
    { key: 'SPY',     label: 'SPY' },
    { key: 'QQQ',     label: 'QQQ' },
    { key: 'IWM',     label: 'IWM' },
    { key: '^VIX',    label: 'VIX' },
    { key: '^TNX',    label: '10Y' },
    { key: 'BTC-USD', label: 'BTC' },
    { key: 'CL=F',    label: 'Oil' },
  ];

  function $(id) { return document.getElementById(id); }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function quoteOf(map, key) { return (map && map[key]) || null; }

  function renderTiles(map) {
    var host = $('hpTiles');
    if (!host) return;
    host.innerHTML = PULSE_SYMBOLS.map(function (s) {
      var q = quoteOf(map, s.key);
      var price = q ? fmtPrice(q.price) : '—';
      var pct = q ? fmtPct(q.changesPercentage) : '—';
      var chg = q ? numOrNull(q.changesPercentage) : null;
      var dir = chg === null ? 'flat' : (chg >= 0 ? 'up' : 'down');
      return '<div class="hp-tile" role="listitem">' +
        '<span class="hp-tile-label">' + s.label + '</span>' +
        '<strong class="hp-tile-price">' + price + '</strong>' +
        '<span class="hp-tile-chg hp-' + dir + '">' + pct + '</span>' +
        '</div>';
    }).join('');
  }

  function renderRegime(map) {
    var label = $('hpRegimeLabel'), reason = $('hpRegimeReason'), banner = $('hpRegime');
    if (!label || !reason || !banner) return;
    var spy = quoteOf(map, 'SPY');
    var vix = quoteOf(map, '^VIX');
    var r = classifyRegime(spy ? spy.changesPercentage : null, vix ? vix.price : null);
    banner.setAttribute('data-tone', r.tone);
    label.textContent = r.label;
    reason.textContent = r.reason;
  }

  function setPill(id, pill) {
    var el = $(id);
    if (!el) return;
    el.textContent = pill.text;
    el.className = 'hp-pill ' + pill.cls;
  }

  function renderBotCard(prefix, status, trades) {
    setPill(prefix + 'Pill', pillFor(status));
    var blockerEl = $(prefix + 'Blocker');
    if (blockerEl) {
      var txt = (!status || status.ready) ? '' : (status.blockers || []).slice(0, 1).join(' ');
      blockerEl.textContent = txt;
      blockerEl.style.display = txt ? '' : 'none';
    }
    var pnlEl = $(prefix + 'Pnl'), openEl = $(prefix + 'Open');
    if (trades == null) {
      if (pnlEl) pnlEl.textContent = '—';
      if (openEl) openEl.textContent = '—';
      return;
    }
    var realized = todayRealizedPnl(trades);
    var open = openPositionCount(trades);
    if (pnlEl) {
      pnlEl.textContent = fmtMoney(realized.pnl);
      pnlEl.className = 'hp-bot-num ' + (realized.pnl > 0 ? 'hp-up' : realized.pnl < 0 ? 'hp-down' : '');
    }
    if (openEl) openEl.textContent = String(open);
  }

  function refreshPulse() {
    var equity = fetchJson('/api/snapshots?symbols=' + encodeURIComponent('SPY,QQQ,IWM')).catch(function () { return null; });
    var macro  = fetchJson('/api/snapshots?symbols=' + encodeURIComponent('^VIX,^TNX,BTC-USD,CL=F')).catch(function () { return null; });
    return Promise.all([equity, macro]).then(function (parts) {
      var map = {};
      parts.forEach(function (p) { if (p && typeof p === 'object') Object.assign(map, p); });
      renderTiles(map);
      renderRegime(map);
    }).catch(function () {
      renderTiles(null);
      renderRegime(null);
    });
  }

  function refreshBots() {
    var jobs = [
      { prefix: 'hpWarrior', statusUrl: '/api/warrior/status', tradesUrl: '/api/warrior/trades' },
    ];
    return Promise.all(jobs.map(function (job) {
      return Promise.allSettled([fetchJson(job.statusUrl), fetchJson(job.tradesUrl)]).then(function (rs) {
        var status = rs[0].status === 'fulfilled' ? rs[0].value : null;
        var trades = rs[1].status === 'fulfilled' ? (rs[1].value && rs[1].value.trades) : null;
        renderBotCard(job.prefix, status, trades);
      });
    }));
  }

  var refreshing = false;
  function refresh() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    return Promise.allSettled([refreshPulse(), refreshBots()]).then(function () { refreshing = false; });
  }

  function homeVisible() {
    var page = $('page-home');
    return !!page && page.classList.contains('active') && !document.hidden;
  }

  function init() {
    if (!$('homeEmpty') || !$('hpTiles')) return;
    var warriorview = $('hpWarriorView');
    if (warriorview) warriorview.addEventListener('click', function () { if (typeof goPage === 'function') goPage('warrior'); });
    refresh();
    setInterval(function () { if (homeVisible()) refresh(); }, 60000);
  }

  var api = {
    refresh: refresh,
    classifyRegime: classifyRegime,
    todayRealizedPnl: todayRealizedPnl,
    openPositionCount: openPositionCount,
    pillFor: pillFor,
    fmtPct: fmtPct,
    fmtPrice: fmtPrice,
    fmtMoney: fmtMoney,
  };

  if (typeof window !== 'undefined') {
    window.HomePulse = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
