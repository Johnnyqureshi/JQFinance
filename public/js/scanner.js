// ── StockPulse — Stock Scanner ────────────────────────────────────────────────
// API CONFIG — swap in live keys here
// const CFG = {
//   alphaVantage: 'YOUR_KEY', // https://www.alphavantage.co
//   polygon:      'YOUR_KEY', // https://polygon.io
//   finviz:       'YOUR_KEY', // https://finviz.com/elite
// };
// Currently uses the site's Yahoo Finance proxy — no key required.

const scanner = (() => {

  // ── Stock Universe ──────────────────────────────────────────────────────────
  const UNIVERSE = [
    {sym:'AAPL', name:'Apple',           sector:'Technology',  mcap:'Large', float:15200},
    {sym:'MSFT', name:'Microsoft',        sector:'Technology',  mcap:'Large', float:7400},
    {sym:'NVDA', name:'NVIDIA',           sector:'Technology',  mcap:'Large', float:24200},
    {sym:'GOOGL', name:'Alphabet',        sector:'Technology',  mcap:'Large', float:12000},
    {sym:'META', name:'Meta Platforms',   sector:'Technology',  mcap:'Large', float:2550},
    {sym:'AMZN', name:'Amazon',           sector:'Technology',  mcap:'Large', float:10500},
    {sym:'TSLA', name:'Tesla',            sector:'EV / Auto',   mcap:'Large', float:3190},
    {sym:'AMD',  name:'AMD',              sector:'Technology',  mcap:'Large', float:1620},
    {sym:'INTC', name:'Intel',            sector:'Technology',  mcap:'Large', float:4310},
    {sym:'ORCL', name:'Oracle',           sector:'Technology',  mcap:'Large', float:2720},
    {sym:'CRM',  name:'Salesforce',       sector:'Technology',  mcap:'Large', float:960},
    {sym:'NFLX', name:'Netflix',          sector:'Technology',  mcap:'Large', float:430},
    {sym:'ADBE', name:'Adobe',            sector:'Technology',  mcap:'Large', float:440},
    {sym:'CRWD', name:'CrowdStrike',      sector:'Technology',  mcap:'Large', float:240},
    {sym:'ARM',  name:'ARM Holdings',     sector:'Technology',  mcap:'Large', float:840},
    {sym:'SMCI', name:'Super Micro',      sector:'Technology',  mcap:'Mid',   float:530},
    {sym:'PLTR', name:'Palantir',         sector:'Technology',  mcap:'Mid',   float:2100},
    {sym:'DDOG', name:'Datadog',          sector:'Technology',  mcap:'Mid',   float:320},
    {sym:'NET',  name:'Cloudflare',       sector:'Technology',  mcap:'Mid',   float:330},
    {sym:'RBLX', name:'Roblox',           sector:'Technology',  mcap:'Mid',   float:640},
    {sym:'ABNB', name:'Airbnb',           sector:'Technology',  mcap:'Mid',   float:630},
    {sym:'DASH', name:'DoorDash',         sector:'Technology',  mcap:'Mid',   float:420},
    {sym:'UBER', name:'Uber',             sector:'Technology',  mcap:'Mid',   float:2090},
    {sym:'SNAP', name:'Snap',             sector:'Technology',  mcap:'Mid',   float:1630},
    {sym:'PINS', name:'Pinterest',        sector:'Technology',  mcap:'Mid',   float:1370},
    {sym:'U',    name:'Unity Software',   sector:'Technology',  mcap:'Small', float:360},
    {sym:'IONQ', name:'IonQ',             sector:'Technology',  mcap:'Small', float:130},
    {sym:'JPM',  name:'JPMorgan',         sector:'Finance',     mcap:'Large', float:2870},
    {sym:'BAC',  name:'Bank of America',  sector:'Finance',     mcap:'Large', float:7900},
    {sym:'GS',   name:'Goldman Sachs',    sector:'Finance',     mcap:'Large', float:325},
    {sym:'MS',   name:'Morgan Stanley',   sector:'Finance',     mcap:'Large', float:1630},
    {sym:'V',    name:'Visa',             sector:'Finance',     mcap:'Large', float:2080},
    {sym:'MA',   name:'Mastercard',       sector:'Finance',     mcap:'Large', float:930},
    {sym:'COIN', name:'Coinbase',         sector:'Finance',     mcap:'Mid',   float:235},
    {sym:'HOOD', name:'Robinhood',        sector:'Finance',     mcap:'Small', float:420},
    {sym:'SOFI', name:'SoFi Technologies',sector:'Finance',     mcap:'Small', float:980},
    {sym:'JNJ',  name:'Johnson & Johnson',sector:'Healthcare',  mcap:'Large', float:2400},
    {sym:'PFE',  name:'Pfizer',           sector:'Healthcare',  mcap:'Large', float:5680},
    {sym:'ABBV', name:'AbbVie',           sector:'Healthcare',  mcap:'Large', float:1760},
    {sym:'MRK',  name:'Merck',            sector:'Healthcare',  mcap:'Large', float:2540},
    {sym:'UNH',  name:'UnitedHealth',     sector:'Healthcare',  mcap:'Large', float:920},
    {sym:'XOM',  name:'ExxonMobil',       sector:'Energy',      mcap:'Large', float:3980},
    {sym:'CVX',  name:'Chevron',          sector:'Energy',      mcap:'Large', float:1870},
    {sym:'SLB',  name:'SLB',              sector:'Energy',      mcap:'Mid',   float:1400},
    {sym:'WMT',  name:'Walmart',          sector:'Consumer',    mcap:'Large', float:8050},
    {sym:'COST', name:'Costco',           sector:'Consumer',    mcap:'Large', float:442},
    {sym:'SBUX', name:'Starbucks',        sector:'Consumer',    mcap:'Mid',   float:1130},
    {sym:'TSLA', name:'Tesla',            sector:'EV / Auto',   mcap:'Large', float:3190},
    {sym:'RIVN', name:'Rivian',           sector:'EV / Auto',   mcap:'Small', float:950},
    {sym:'LCID', name:'Lucid',            sector:'EV / Auto',   mcap:'Small', float:2200},
    {sym:'MARA', name:'MARA Holdings',    sector:'Crypto',      mcap:'Small', float:360},
    {sym:'RIOT', name:'Riot Platforms',   sector:'Crypto',      mcap:'Small', float:290},
    {sym:'CLSK', name:'CleanSpark',       sector:'Crypto',      mcap:'Small', float:170},
  ].filter((v, i, a) => a.findIndex(x => x.sym === v.sym) === i); // dedupe

  const SECTORS = ['', ...new Set(UNIVERSE.map(u => u.sector))].sort((a, b) => a.localeCompare(b));

  // ── State ───────────────────────────────────────────────────────────────────
  let sortCol      = 'chgPct';
  let sortDir      = -1;
  let lastResults  = [];
  let activePreset = 'all';
  let _inited      = false;
  let _refreshTimer   = null;
  let _refreshSecs    = 0;
  let _refreshInterval = 0;
  let _scWatchlist = [];

  const $ = id => document.getElementById(id);
  const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d});
  const fmtV = v => !v ? '--' : v >= 1e9 ? (v/1e9).toFixed(1)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v);
  const esc  = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ── Filter state ────────────────────────────────────────────────────────────
  const filters = {
    mcap: new Set(['Large','Mid','Small','Micro']),
    sector: '',
    minPx: 0, maxPx: 9999,
    minVol: 0,
    minChgPct: -999,
    minRSI: 0, maxRSI: 100,
    minRelVol: 0,
  };

  // ── Presets ─────────────────────────────────────────────────────────────────
  const PRESETS = {
    all:      { mcap:['Large','Mid','Small','Micro'], minChgPct:-999, minVol:0,    minRSI:0,  maxRSI:100, minRelVol:0 },
    momentum: { mcap:['Large','Mid','Small','Micro'], minChgPct:5,    minVol:1e6,  minRSI:0,  maxRSI:100, minRelVol:0 },
    oversold: { mcap:['Large','Mid','Small','Micro'], minChgPct:0,    minVol:0,    minRSI:0,  maxRSI:32,  minRelVol:0 },
    highvol:  { mcap:['Large','Mid','Small','Micro'], minChgPct:-999, minVol:5e5,  minRSI:0,  maxRSI:100, minRelVol:3 },
    smallcap: { mcap:['Small','Micro'],               minChgPct:4,    minVol:0,    minRSI:0,  maxRSI:100, minRelVol:0 },
  };

  // ── RSI (Wilder, 14-period) ─────────────────────────────────────────────────
  function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i-1];
      d >= 0 ? gains += d : losses += Math.abs(d);
    }
    let avgG = gains / period, avgL = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      avgG = (avgG*(period-1) + (d >= 0 ? d : 0)) / period;
      avgL = (avgL*(period-1) + (d <  0 ? Math.abs(d) : 0)) / period;
    }
    if (!avgL) return 100;
    return 100 - 100 / (1 + avgG / avgL);
  }

  // ── Data fetchers ───────────────────────────────────────────────────────────
  // To swap in Alpha Vantage or Polygon, replace these two functions.

  async function fetchSnaps(syms) {
    // Yahoo Finance via backend proxy — /api/snapshots?symbols=A,B,C
    try {
      const r = await fetch(`/api/snapshots?symbols=${syms.join(',')}`);
      return r.ok ? r.json() : {};
    } catch { return {}; }
  }

  async function fetchRSI(sym) {
    // Uses /api/intraday (5-min bars) for intraday RSI
    // Alpha Vantage swap: GET /query?function=RSI&symbol=${sym}&interval=5min&time_period=14&series_type=close&apikey=${CFG.alphaVantage}
    try {
      const r = await fetch(`/api/intraday/${sym}`);
      if (!r.ok) return null;
      const d = await r.json();
      const bars = d.bars || [];
      if (bars.length < 15) return null;
      return calcRSI(bars.map(b => b.c));
    } catch { return null; }
  }

  function pct(snap) {
    if (!snap?.price || !snap?.previousClose) return 0;
    return (snap.price - snap.previousClose) / snap.previousClose * 100;
  }

  // ── Scan ─────────────────────────────────────────────────────────────────────
  async function runScan() {
    setLoading(true);
    _scWatchlist = JSON.parse(localStorage.getItem('sp_wl') || '[]');

    const syms  = UNIVERSE.map(u => u.sym);
    const snaps = await fetchSnaps(syms);

    const p = PRESETS[activePreset] || {};

    const candidates = UNIVERSE.filter(u => {
      const s = snaps[u.sym];
      if (!s?.price) return false;
      const px  = s.price;
      const chg = pct(s);
      const vol = s.volume || 0;
      const avg = s.avgVolume || 1;
      const rv  = avg > 0 ? vol / avg : 0;
      if (px  < filters.minPx || px > filters.maxPx) return false;
      if (vol < filters.minVol) return false;
      if (chg < filters.minChgPct) return false;
      if (filters.minRelVol > 0 && rv < filters.minRelVol) return false;
      if (!filters.mcap.has(u.mcap)) return false;
      if (filters.sector && u.sector !== filters.sector) return false;
      return true;
    });

    // Sort by |% change| desc, take top 25 for RSI fetch
    candidates.sort((a, b) => Math.abs(pct(snaps[b.sym])) - Math.abs(pct(snaps[a.sym])));
    const top = candidates.slice(0, 25);

    // Fetch RSI in parallel (capped at 25)
    const rsiMap = {};
    await Promise.all(top.map(async u => { rsiMap[u.sym] = await fetchRSI(u.sym); }));

    // Apply RSI filter
    const passed = top.filter(u => {
      const r = rsiMap[u.sym];
      if (r === null) return filters.minRSI === 0 && filters.maxRSI === 100; // include if no RSI when unfiltered
      return r >= filters.minRSI && r <= filters.maxRSI;
    });

    lastResults = passed.map(u => {
      const s   = snaps[u.sym] || {};
      const px  = s.price || 0;
      const pv  = s.previousClose || 0;
      const vol = s.volume || 0;
      const avg = s.avgVolume || 1;
      return {
        sym:     u.sym,   name:   u.name,
        sector:  u.sector, mcap:  u.mcap,  float: u.float,
        price:   px,
        chg:     px - pv,
        chgPct:  pct(s),
        volume:  vol,
        avgVol:  avg,
        relVol:  avg > 0 ? vol / avg : 0,
        rsi:     rsiMap[u.sym],
        dayHigh: s.dayHigh || null,
        dayLow:  s.dayLow  || null,
        open:    s.open    || null,
        watched: _scWatchlist.includes(u.sym),
      };
    });

    renderTable();
    setLoading(false);

    const ce = $('scCount');
    if (ce) ce.textContent = `${lastResults.length} result${lastResults.length !== 1 ? 's' : ''}`;
    const ue = $('scUpdated');
    if (ue) ue.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  }

  // ── Table render ─────────────────────────────────────────────────────────────
  function renderTable() {
    const body = $('scBody');
    if (!body) return;

    const rows = [...lastResults].sort((a, b) => {
      let av = a[sortCol] ?? -Infinity;
      let bv = b[sortCol] ?? -Infinity;
      return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
    });

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="9" class="sc-empty">No stocks match — try adjusting filters or run a preset scan</td></tr>`;
      return;
    }

    body.innerHTML = rows.map(r => {
      const chgCls  = r.chgPct >= 0 ? 'up' : 'down';
      const rsiCls  = r.rsi === null ? '' : r.rsi < 30 ? 'sc-oversold' : r.rsi > 70 ? 'sc-overbought' : '';
      const rsiStr  = r.rsi !== null ? fmt(r.rsi, 1) : '--';
      const floatLbl = r.float >= 1000 ? (r.float/1000).toFixed(1)+'B' : r.float+'M';
      const rvCls   = r.relVol >= 3 ? 'sc-surge' : '';
      const mcapLbl = r.mcap[0];
      return `<tr class="sc-row ${rsiCls}" data-sym="${esc(r.sym)}">
        <td class="sc-td sc-td-star"><button class="sc-star${r.watched?' on':''}" data-sym="${esc(r.sym)}" title="Watchlist">★</button></td>
        <td class="sc-td sc-td-sym"><span class="sc-sym">${esc(r.sym)}</span></td>
        <td class="sc-td sc-td-name sc-mono-sm">${esc(r.name)}</td>
        <td class="sc-td sc-td-num">$${fmt(r.price)}</td>
        <td class="sc-td sc-td-num ${chgCls}">${r.chgPct>=0?'+':''}${fmt(r.chgPct)}%</td>
        <td class="sc-td sc-td-num">${fmtV(r.volume)}</td>
        <td class="sc-td sc-td-num ${rvCls}">${fmt(r.relVol,1)}x</td>
        <td class="sc-td sc-td-num">${rsiStr}</td>
        <td class="sc-td sc-td-cap"><span class="sc-cap-badge sc-cap-${r.mcap.toLowerCase()}">${mcapLbl}</span></td>
      </tr>`;
    }).join('');

    body.querySelectorAll('.sc-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.sc-star')) return;
        openDetail(row.dataset.sym);
      });
    });
    body.querySelectorAll('.sc-star').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); toggleWatch(btn.dataset.sym, btn); });
    });
  }

  // ── Sort ─────────────────────────────────────────────────────────────────────
  function setSort(col) {
    sortDir = sortCol === col ? sortDir * -1 : -1;
    sortCol = col;
    document.querySelectorAll('.sc-th[data-col]').forEach(th => {
      th.dataset.sort = th.dataset.col === col ? (sortDir === 1 ? 'asc' : 'desc') : '';
    });
    renderTable();
  }

  // ── Detail modal ─────────────────────────────────────────────────────────────
  function openDetail(sym) {
    const r = lastResults.find(x => x.sym === sym);
    if (!r) return;
    const m = $('scModal');
    if (!m) return;

    $('scMSym').textContent   = r.sym;
    $('scMName').textContent  = r.name;
    $('scMPrice').textContent = '$' + fmt(r.price);
    const chgEl = $('scMChg');
    chgEl.textContent = (r.chgPct>=0?'+':'') + fmt(r.chgPct) + '%';
    chgEl.className   = 'sc-modal-chg ' + (r.chgPct>=0?'up':'down');

    $('scMSector').textContent  = r.sector;
    $('scMMcap').textContent    = r.mcap + ' Cap';
    $('scMFloat').textContent   = r.float >= 1000 ? (r.float/1000).toFixed(1)+'B' : r.float+'M';
    $('scMVol').textContent     = fmtV(r.volume);
    $('scMAvgVol').textContent  = fmtV(Math.round(r.avgVol));
    $('scMRelVol').textContent  = fmt(r.relVol,1) + 'x';
    $('scMRsi').textContent     = r.rsi !== null ? fmt(r.rsi,1) : '--';
    $('scMDayHigh').textContent = r.dayHigh ? '$'+fmt(r.dayHigh) : '--';
    $('scMDayLow').textContent  = r.dayLow  ? '$'+fmt(r.dayLow)  : '--';
    $('scMOpen').textContent    = r.open    ? '$'+fmt(r.open)    : '--';

    const rsiZone = r.rsi === null ? '--'
      : r.rsi < 30 ? 'OVERSOLD' : r.rsi > 70 ? 'OVERBOUGHT' : r.rsi < 45 ? 'LOW' : r.rsi > 60 ? 'HIGH' : 'NEUTRAL';
    const rsiZoneCls = r.rsi === null ? '' : r.rsi < 30 ? 'oversold' : r.rsi > 70 ? 'overbought' : 'neutral';
    const rz = $('scMRsiZone');
    rz.textContent = rsiZone;
    rz.className = 'sc-mzone ' + rsiZoneCls;

    const openBtn = $('scMOpenStock');
    if (openBtn) {
      openBtn.onclick = () => {
        closeModal();
        if (typeof openStock === 'function') openStock(r.sym, { symbol: r.sym, price: r.price, previousClose: r.price - r.chg, name: r.name });
      };
    }

    m.classList.add('open');
  }

  function closeModal() {
    $('scModal')?.classList.remove('open');
  }

  // ── Watchlist toggle ─────────────────────────────────────────────────────────
  function toggleWatch(sym, btn) {
    _scWatchlist = JSON.parse(localStorage.getItem('sp_wl') || '[]');
    const idx = _scWatchlist.indexOf(sym);
    idx >= 0 ? _scWatchlist.splice(idx,1) : _scWatchlist.push(sym);
    localStorage.setItem('sp_wl', JSON.stringify(_scWatchlist));
    const on = _scWatchlist.includes(sym);
    const r = lastResults.find(x => x.sym === sym);
    if (r) r.watched = on;
    document.querySelectorAll(`.sc-star[data-sym="${sym}"]`).forEach(b => b.classList.toggle('on', on));
  }

  // ── Export CSV ───────────────────────────────────────────────────────────────
  function exportCSV() {
    if (!lastResults.length) return;
    const hdr = 'Ticker,Name,Sector,MarketCap,Price,Chg%,Volume,RelVol,RSI,Float(M)';
    const rows = lastResults.map(r =>
      `${r.sym},"${r.name}","${r.sector}",${r.mcap},${fmt(r.price)},${fmt(r.chgPct)},${r.volume},${fmt(r.relVol,2)},${r.rsi!==null?fmt(r.rsi,1):''},${r.float}`
    );
    const blob = new Blob([[hdr,...rows].join('\n')], {type:'text/csv'});
    const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(blob), download:`scanner_${new Date().toISOString().slice(0,10)}.csv`});
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ── Auto-refresh ─────────────────────────────────────────────────────────────
  function setAutoRefresh(secs) {
    clearInterval(_refreshTimer);
    _refreshInterval = secs;
    _refreshSecs     = secs;
    updateCd();
    if (secs > 0) {
      _refreshTimer = setInterval(() => {
        _refreshSecs--;
        updateCd();
        if (_refreshSecs <= 0) { runScan(); _refreshSecs = _refreshInterval; }
      }, 1000);
    }
  }

  function updateCd() {
    const el = $('scCdNum');
    if (!el) return;
    el.textContent = !_refreshInterval ? 'OFF' : _refreshSecs + 's';
  }

  // ── Loading overlay ───────────────────────────────────────────────────────────
  function setLoading(on) {
    const ov = $('scLoadingOv');
    if (ov) ov.style.display = on ? 'flex' : 'none';
    const btn = $('scScanBtn');
    if (btn) { btn.disabled = on; btn.textContent = on ? 'SCANNING…' : '▶ SCAN'; }
  }

  // ── Filter helpers ────────────────────────────────────────────────────────────
  function applyPreset(key) {
    const p = PRESETS[key] || PRESETS.all;
    activePreset = key;
    filters.mcap      = new Set(p.mcap);
    filters.sector    = p.sector || '';
    filters.minChgPct = p.minChgPct ?? -999;
    filters.minVol    = p.minVol ?? 0;
    filters.minRSI    = p.minRSI ?? 0;
    filters.maxRSI    = p.maxRSI ?? 100;
    filters.minRelVol = p.minRelVol ?? 0;
    syncFiltersToUI();
    document.querySelectorAll('.sc-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === key));
  }

  function syncFiltersToUI() {
    document.querySelectorAll('.sc-mcap-btn').forEach(b => b.classList.toggle('active', filters.mcap.has(b.dataset.mcap)));
    const sel = $('scSector'); if (sel) sel.value = filters.sector || '';
    const mc  = $('scMinChg'); if (mc)  mc.value  = filters.minChgPct <= -999 ? '' : filters.minChgPct;
    const mv  = $('scMinVol');
    if (mv) { const m = {0:'0',500000:'500K',1000000:'1M',5000000:'5M'}; mv.value = m[filters.minVol] || '0'; }
    const mr1 = $('scMinRsi'); if (mr1) mr1.value = filters.minRSI || '';
    const mr2 = $('scMaxRsi'); if (mr2) mr2.value = filters.maxRSI === 100 ? '' : filters.maxRSI;
    const rrv = $('scMinRelVol');
    if (rrv) { const m = {0:'0',2:'2',3:'3',5:'5'}; rrv.value = m[filters.minRelVol] || '0'; }
  }

  function readFiltersFromUI() {
    filters.mcap = new Set();
    document.querySelectorAll('.sc-mcap-btn.active').forEach(b => filters.mcap.add(b.dataset.mcap));
    if (!filters.mcap.size) filters.mcap = new Set(['Large','Mid','Small','Micro']);
    const sel = $('scSector'); filters.sector = sel ? sel.value : '';
    const mc  = $('scMinChg'); filters.minChgPct = mc && mc.value !== '' ? parseFloat(mc.value) : -999;
    const mv  = $('scMinVol');
    if (mv) { const m = {'0':0,'500K':5e5,'1M':1e6,'5M':5e6}; filters.minVol = m[mv.value] ?? 0; }
    const mr1 = $('scMinRsi'); filters.minRSI = mr1 && mr1.value !== '' ? parseFloat(mr1.value) : 0;
    const mr2 = $('scMaxRsi'); filters.maxRSI = mr2 && mr2.value !== '' ? parseFloat(mr2.value) : 100;
    const rrv = $('scMinRelVol');
    if (rrv) { const m = {'0':0,'2':2,'3':3,'5':5}; filters.minRelVol = m[rrv.value] ?? 0; }
  }

  // ── Populate sector dropdown ──────────────────────────────────────────────────
  function buildSectorDropdown() {
    const sel = $('scSector');
    if (!sel) return;
    sel.innerHTML = '<option value="">All Sectors</option>' +
      SECTORS.filter(Boolean).map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  }

  // ── Init (binds events once) ──────────────────────────────────────────────────
  function init() {
    if (_inited) return;
    _inited = true;

    buildSectorDropdown();

    document.querySelectorAll('.sc-preset').forEach(btn => {
      btn.addEventListener('click', () => { applyPreset(btn.dataset.preset); runScan(); });
    });

    $('scScanBtn')?.addEventListener('click', () => {
      readFiltersFromUI();
      activePreset = '';
      document.querySelectorAll('.sc-preset').forEach(b => b.classList.remove('active'));
      runScan();
    });

    document.querySelectorAll('.sc-th[data-col]').forEach(th => {
      th.addEventListener('click', () => setSort(th.dataset.col));
    });

    document.querySelectorAll('.sc-rf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sc-rf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setAutoRefresh(parseInt(btn.dataset.secs));
      });
    });

    document.querySelectorAll('.sc-mcap-btn').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });

    $('scExportBtn')?.addEventListener('click', exportCSV);
    $('scModalClose')?.addEventListener('click', closeModal);
    $('scModal')?.addEventListener('click', e => { if (e.target === $('scModal')) closeModal(); });

    $('scFilterToggle')?.addEventListener('click', () => {
      $('scFilterPanel')?.classList.toggle('open');
    });
  }

  // ── Open (called each time page is navigated to) ───────────────────────────
  function open() {
    init();
    if (!lastResults.length) {
      applyPreset('all');
      runScan();
    }
  }

  return { open, runScan };
})();
