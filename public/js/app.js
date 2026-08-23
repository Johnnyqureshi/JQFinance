// ── Johnny Qureshi Finance — Main App ──────────────────────────────────────────

const INDICES  = ['SPY','QQQ','DIA','IWM'];
const MOVERS   = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','NFLX','UBER','COIN','PLTR','AMD'];

const state = {
  page:        'home',
  prevPage:    'home',
  symbol:      null,
  snap:        null,
  stockData:   null,
  watchlist:   [],
  currentUser: null,
  loadId:      0,
  forecastLoadId: 0,
};

// ── utils ──────────────────────────────────────────────────────────────────────
const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtV = v => { if(!v) return '--'; if(v>=1e9) return (v/1e9).toFixed(1)+'B'; if(v>=1e6) return (v/1e6).toFixed(1)+'M'; if(v>=1e3) return (v/1e3).toFixed(0)+'K'; return String(v); };
const cls  = v => v >= 0 ? 'up' : 'down';
const escapeHtml = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const $    = id => document.getElementById(id);

// ── Auth API ────────────────────────────────────────────────────────────────────
const authAPI = {
  async me()          { try { const r=await fetch('/api/auth/me'); return r.ok ? r.json() : null; } catch { return null; } },
  async login(u,p)    { try { const r=await fetch('/api/auth/login',    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}); return {ok:r.ok,data:await r.json()}; } catch { return {ok:false,data:{error:'Network error — please try again.'}}; } },
  async register(u,p) { try { const r=await fetch('/api/auth/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}); return {ok:r.ok,data:await r.json()}; } catch { return {ok:false,data:{error:'Network error — please try again.'}}; } },
  async logout()      { try { await fetch('/api/auth/logout', {method:'POST'}); } catch {} },
};

// ── Watchlist API ───────────────────────────────────────────────────────────────
const wlAPI = {
  async load()     { try { const r=await fetch('/api/watchlist'); if(r.ok){const d=await r.json(); state.watchlist=d.watchlist||[];} } catch {} },
  async add(sym)   { try { const r=await fetch('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:sym})}); if(r.ok){const d=await r.json(); state.watchlist=d.watchlist||[];} } catch {} },
  async remove(sym){ try { const r=await fetch(`/api/watchlist/${encodeURIComponent(sym)}`,{method:'DELETE'}); if(r.ok){const d=await r.json(); state.watchlist=d.watchlist||[];} } catch {} },
};

// ── API ────────────────────────────────────────────────────────────────────────
const api = {
  async snapshots(syms) {
    try { const r = await fetch(`/api/snapshots?symbols=${syms.join(',')}`); return r.ok ? r.json() : {}; } catch { return {}; }
  },
  async bars(sym, tf='1Day', limit=60) {
    try { const r = await fetch(`/api/bars/${sym}?timeframe=${tf}&limit=${limit}`); return r.ok ? r.json() : null; } catch { return null; }
  },
  async news(sym) {
    try { const r = await fetch(`/api/news/${sym}`); const d = await r.json(); return d.news || []; } catch { return []; }
  },
  async search(q) {
    try { const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`); return r.ok ? r.json() : []; } catch { return []; }
  },
  async stock(sym) {
    try { const r = await fetch(`/api/stock/${sym}`); return r.ok ? r.json() : null; } catch { return null; }
  },
  async valuation(sym) {
    try { const r = await fetch(`/api/valuation/${sym}`); return r.ok ? r.json() : null; } catch { return null; }
  },
  async forecast(sym, lookback=90, horizon=30, years=10) {
    try {
      const params = new URLSearchParams({ lookback, horizon, years });
      const r = await fetch(`/api/forecast/${encodeURIComponent(sym)}?${params}`);
      return r.ok ? r.json() : null;
    } catch { return null; }
  },
  async wsb() {
    try { const r = await fetch('/api/wsb'); return r.ok ? r.json() : null; } catch { return null; }
  },
};

// ── Market status ──────────────────────────────────────────────────────────────
function updateMarketStatus() {
  const et   = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const day  = et.getDay();
  const mins = et.getHours()*60 + et.getMinutes();
  const open = day>=1 && day<=5 && mins>=570 && mins<960;
  $('mktDot').className  = 'market-dot ' + (open ? 'open' : 'closed');
  $('mktText').textContent = open ? 'Market Open' : 'Market Closed';
}

// ── Chart drawing ──────────────────────────────────────────────────────────────
function drawChart(canvas, bars, color, h=300) {
  if (!canvas || !bars?.length) return;
  const ctx  = canvas.getContext('2d');
  const w    = canvas.offsetWidth || canvas.parentElement.clientWidth - 40;
  canvas.width  = w;
  canvas.height = h;
  const prices = bars.map(b => b.c);
  const min    = Math.min(...prices) * 0.998;
  const max    = Math.max(...prices) * 1.002;
  const range  = max - min || 1;
  const pad    = { t:10, r:10, b:30, l:56 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t  - pad.b;
  const sx = cw / (prices.length - 1);
  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = '#1c2a42'; ctx.lineWidth = 1;
  for (let i=0; i<=4; i++) {
    const y = pad.t + (ch/4)*i;
    const v = max - (range/4)*i;
    ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke();
    ctx.fillStyle='#3d5070'; ctx.font='10px Inter'; ctx.textAlign='right';
    ctx.fillText('$'+fmt(v), pad.l-4, y+3);
  }

  // gradient fill
  const grad = ctx.createLinearGradient(0,pad.t,0,h-pad.b);
  grad.addColorStop(0, color+'55'); grad.addColorStop(1, color+'00');
  ctx.beginPath();
  prices.forEach((p,i) => {
    const x=pad.l+i*sx, y=pad.t+ch-((p-min)/range)*ch;
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.lineTo(pad.l+(prices.length-1)*sx, h-pad.b);
  ctx.lineTo(pad.l, h-pad.b); ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();

  // line
  ctx.beginPath();
  prices.forEach((p,i) => {
    const x=pad.l+i*sx, y=pad.t+ch-((p-min)/range)*ch;
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.strokeStyle=color; ctx.lineWidth=2; ctx.stroke();

  // last dot
  const lx=pad.l+(prices.length-1)*sx, ly=pad.t+ch-((prices.at(-1)-min)/range)*ch;
  ctx.beginPath(); ctx.arc(lx,ly,4,0,Math.PI*2);
  ctx.fillStyle=color; ctx.fill();
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function goPage(page) {
  state.prevPage = state.page;
  state.page     = page;
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page===page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('page-'+page).classList.add('active');
  if (page==='markets')   loadMarkets();
  if (page==='watchlist') { loadWatchlist(); loadSectorHeatmap(); futuresTracker.load(); }
  if (page==='scanner')   scanner.open();
  if (page==='trading')   { alpacaTrader.open(); }
  if (page==='momentum')  { if (window.momentumTrader) momentumTrader.open(); }
  else if (window.momentumTrader) momentumTrader.pause();
  if (page==='opening-momentum') { if (window.openingMomentumBot) openingMomentumBot.open(); }
  else if (window.openingMomentumBot) openingMomentumBot.pause();
  document.dispatchEvent(new CustomEvent('pageChanged', { detail: { page } }));
}

// ── Stock page ─────────────────────────────────────────────────────────────────
async function openStock(sym, snap) {
  const loadId = ++state.loadId;
  state.prevPage  = state.page;
  state.page      = 'home';
  state.symbol    = sym;
  state.snap      = snap || {};
  state.stockData = null;

  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page==='home'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('page-home').classList.add('active');

  $('homeEmpty').style.display = 'none';
  $('homeWorkspace').style.display = '';

  const backBtn = $('backBtn');
  if (backBtn) backBtn.style.display = (state.prevPage && state.prevPage !== 'home') ? '' : 'none';

  const price = snap?.price || 0;
  const prev  = snap?.previousClose || 0;
  const chg   = price - prev;
  const pct   = prev ? (chg/prev)*100 : 0;
  const up    = chg >= 0;

  $('sTicker').textContent = sym;
  $('sName').textContent   = snap?.name || '';

  // Use regular close for the main price display during extended hours
  const displayPrice = snap?.regularClose ?? price;
  const displayPrev  = snap?.previousClose || 0;
  const displayChg   = displayPrice - displayPrev;
  const displayPct   = displayPrev ? (displayChg / displayPrev) * 100 : 0;
  const displayUp    = displayChg >= 0;

  $('sPrice').textContent  = displayPrice ? '$'+fmt(displayPrice) : '--';
  const sc = $('sChange');
  sc.textContent = displayPrice && displayPrev
    ? `${displayUp?'+':''}${fmt(displayChg)} (${displayUp?'+':''}${fmt(displayPct)}%)`
    : '';
  sc.className   = 's-change ' + (displayUp ? 'up' : 'down');

  // Extended hours price row
  const extRow    = $('sExtRow');
  const extBadge  = $('sExtBadge');
  const extPriceEl = $('sExtPrice');
  const extChgEl  = $('sExtChange');
  if (extRow && snap?.extendedPrice) {
    const ep   = snap.extendedPrice;
    const base = snap.regularClose ?? price;
    const ec   = base ? ep - base : 0;
    const epct = base ? (ec / base) * 100 : 0;
    const eup  = ec >= 0;
    extBadge.textContent  = snap.extendedType || 'EXT';
    extBadge.className    = 's-ext-badge ' + (snap.extendedType === 'PRE' ? 'pre' : 'post');
    extPriceEl.textContent = '$' + fmt(ep);
    extChgEl.textContent  = `${eup?'+':''}${fmt(ec)} (${eup?'+':''}${fmt(epct)}%)`;
    extChgEl.className    = 's-ext-change ' + (eup ? 'up' : 'down');
    extRow.style.display  = '';
  } else if (extRow) {
    extRow.style.display = 'none';
  }
  updateWatchBtn(sym);

  document.querySelectorAll('.stock-tab').forEach(t => t.classList.toggle('active', t.dataset.tab==='overview'));
  document.querySelectorAll('.tab-pane').forEach(p => { p.classList.toggle('active', p.id==='tab-overview'); p.innerHTML='<div class="tab-spin"><div class="spinner"></div></div>'; });

  trader.analyze(sym);
  if (typeof rtTrader !== 'undefined') rtTrader.load(sym);
  if (typeof gamePlan !== 'undefined') gamePlan.load(sym);

  const [barsData, fmpData, newsData, valData] = await Promise.all([
    api.bars(sym, '1Hour', 48),
    api.stock(sym),
    api.news(sym),
    api.valuation(sym),
  ]);
  if (loadId !== state.loadId || state.symbol !== sym) return;
  state.stockData = { sym, snap, bars: barsData, fmp: fmpData, news: newsData, val: valData, forecast: null };
  renderOverview(snap, barsData, up);
  const forecastLoadId = ++state.forecastLoadId;
  void api.forecast(sym).then(forecast => {
    if (loadId !== state.loadId || forecastLoadId !== state.forecastLoadId || state.symbol !== sym || !state.stockData) return;
    state.stockData.forecast = forecast;
    renderForecastPanel(forecast, sym);
  });
}

function updateWatchBtn(sym) {
  const on = state.watchlist.includes(sym);
  $('watchBtn').classList.toggle('on', on);
  $('watchBtnLabel').textContent = on ? '✓ Watching' : '+ Watch';
}

function switchStockTab(tab) {
  document.querySelectorAll('.stock-tab').forEach(t => t.classList.toggle('active', t.dataset.tab===tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id==='tab-'+tab));
  const d = state.stockData;
  if (!d) return;
  const up = (d.snap?.price||0) >= (d.snap?.previousClose||0);
  if (tab==='overview') renderOverview(d.snap, d.bars, up);
  if (tab==='chart')    renderChart(d.sym, d.bars, up);
  if (tab==='analysts') renderAnalysts(d.fmp, d.snap?.price||0, d.val);
  if (tab==='news')     renderNews(d.news);
}

// ── Overview tab ───────────────────────────────────────────────────────────────
function renderOverview(snap, bars, up) {
  const p = snap || {};
  const color = up ? '#1dd6a3' : '#e84545';
  $('tab-overview').innerHTML =
    '<div class="overview-layout"><div><div class="stat-strip">' +
    '<div class="stat-cell"><label>Open</label><span id="ov-open"></span></div>' +
    '<div class="stat-cell"><label>Prev Close</label><span id="ov-prev"></span></div>' +
    '<div class="stat-cell"><label>Day High</label><span id="ov-high"></span></div>' +
    '<div class="stat-cell"><label>Day Low</label><span id="ov-low"></span></div>' +
    '<div class="stat-cell"><label>Volume</label><span id="ov-vol"></span></div>' +
    '<div class="stat-cell"><label>Avg Volume</label><span id="ov-avgvol"></span></div>' +
    '</div><div class="chart-card"><h3>Intraday \u2014 Last 48 hours</h3>' +
    '<canvas id="ovCanvas" style="height:220px"></canvas></div></div>' +
    '<div id="scorePanel"></div></div><section id="forecastPanel" class="forecast-panel"></section>';
  $('ov-open').textContent   = '$' + fmt(p.open);
  $('ov-prev').textContent   = '$' + fmt(p.previousClose);
  $('ov-high').textContent   = '$' + fmt(p.dayHigh);
  $('ov-low').textContent    = '$' + fmt(p.dayLow);
  $('ov-vol').textContent    = fmtV(p.volume);
  $('ov-avgvol').textContent = fmtV(p.avgVolume);
  const canvas = $('ovCanvas');
  if (canvas && bars?.bars?.length >= 2) requestAnimationFrame(() => drawChart(canvas, bars.bars, color, 220));
  // async score panel
  loadScorePanel(state.stockData?.fmp, p.price||0);
  renderForecastPanel(state.stockData?.forecast, state.stockData?.sym);
}

function pct(value, digits=1) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(digits)}%`;
}

function forecastStatus(data) {
  if (!data?.available || data.status === 'INSUFFICIENT_HISTORICAL_DATA') {
    return { cls: 'insufficient', icon: '⊘', label: 'Insufficient historical data', detail: 'No forecast is shown until the required clean history and forward outcome windows are available.' };
  }
  if (!data.displayable || data.status === 'LIMITED_HISTORICAL_SAMPLE') {
    return { cls: 'limited', icon: '◌', label: 'Limited historical sample', detail: `Only ${data.matchCount || 0} separated comparable window${data.matchCount === 1 ? '' : 's'} were found. Probabilities are withheld to avoid false precision.` };
  }
  if (data.direction === 'BULLISH') return { cls: 'bullish', icon: '↗', label: 'Historical evidence leans bullish', detail: 'Comparable patterns more often produced the defined positive outcome.' };
  if (data.direction === 'BEARISH') return { cls: 'bearish', icon: '↘', label: 'Historical evidence leans bearish', detail: 'Comparable patterns more often produced the defined negative outcome.' };
  return { cls: 'neutral', icon: '→', label: 'Historical evidence is mixed', detail: 'Comparable outcomes do not show a dominant directional edge.' };
}

function probabilitySegment(label, value, cls) {
  const safe = Math.max(0, Math.min(100, Number(value || 0) * 100));
  return `<div class="hf-prob-item ${cls}">
    <div class="hf-prob-top"><span class="hf-prob-label"><i></i>${label}</span><strong>${safe.toFixed(0)}%</strong></div>
    <div class="hf-prob-track"><span style="width:${safe.toFixed(1)}%"></span></div>
  </div>`;
}

function drawForecastPath(canvas, data) {
  if (!canvas || !data?.paths?.current?.length) return;
  const current = data.paths.current;
  const horizon = Number(data.horizon) || 30;
  const lines = [
    { values: data.paths.closest, color: '#63b3ed', width: 2, label: 'Closest analog' },
    { values: data.paths.bullish?.average, color: '#1dd6a3', width: 2.5, label: 'Bullish average' },
    { values: data.paths.bearish?.average, color: '#e84545', width: 2.5, label: 'Bearish average' },
  ].filter(line => Array.isArray(line.values) && line.values.length);
  const allValues = [...current, ...lines.flatMap(line => line.values),
    ...(data.paths.bullish?.lower || []), ...(data.paths.bullish?.upper || []),
    ...(data.paths.bearish?.lower || []), ...(data.paths.bearish?.upper || [])].filter(Number.isFinite);
  if (!allValues.length) return;
  const ctx = canvas.getContext('2d');
  const width = Math.max(280, canvas.parentElement?.clientWidth || canvas.offsetWidth || 600);
  const height = 230;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.height = `${height}px`;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 42, right: 14, top: 14, bottom: 30 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const min = Math.min(...allValues, 100) - 1;
  const max = Math.max(...allValues, 100) + 1;
  const y = value => pad.top + (max - value) / (max - min || 1) * chartH;
  const dividerX = pad.left + chartW * 0.6;
  const currentX = index => pad.left + index / Math.max(1, current.length - 1) * (dividerX - pad.left);
  const forwardX = index => dividerX + index / Math.max(1, horizon) * (width - pad.right - dividerX);

  ctx.strokeStyle = 'rgba(111,132,166,.18)';
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach(fraction => {
    const guideY = pad.top + chartH * fraction;
    ctx.beginPath(); ctx.moveTo(pad.left, guideY); ctx.lineTo(width - pad.right, guideY); ctx.stroke();
  });
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(245,200,66,.65)';
  ctx.beginPath(); ctx.moveTo(pad.left, y(100)); ctx.lineTo(width - pad.right, y(100)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(111,132,166,.45)';
  ctx.beginPath(); ctx.moveTo(dividerX, pad.top); ctx.lineTo(dividerX, height - pad.bottom); ctx.stroke();

  const band = (path, fill) => {
    if (!path?.lower?.length || !path?.upper?.length) return;
    ctx.beginPath();
    path.upper.forEach((value, index) => index ? ctx.lineTo(forwardX(index), y(value)) : ctx.moveTo(forwardX(index), y(value)));
    [...path.lower].reverse().forEach((value, index) => ctx.lineTo(forwardX(path.lower.length - 1 - index), y(value)));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  band(data.paths.bullish, 'rgba(29,214,163,.10)');
  band(data.paths.bearish, 'rgba(232,69,69,.10)');

  ctx.strokeStyle = '#d7e3f4'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  current.forEach((value, index) => index ? ctx.lineTo(currentX(index), y(value)) : ctx.moveTo(currentX(index), y(value)));
  ctx.stroke();
  lines.forEach(line => {
    ctx.strokeStyle = line.color; ctx.lineWidth = line.width;
    ctx.beginPath();
    line.values.forEach((value, index) => index ? ctx.lineTo(forwardX(index), y(value)) : ctx.moveTo(forwardX(index), y(value)));
    ctx.stroke();
  });
  ctx.fillStyle = '#93a6c6'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Current pattern', pad.left, height - 9);
  ctx.fillText(`${horizon} sessions forward`, dividerX + 8, height - 9);
  ctx.textAlign = 'right';
  ctx.fillText(`${max.toFixed(0)}`, pad.left - 7, y(max) + 3);
  ctx.fillText(`${min.toFixed(0)}`, pad.left - 7, y(min) + 3);
}

function renderForecastPanel(data, symbol) {
  const panel = $('forecastPanel');
  if (!panel) return;
  const status = forecastStatus(data);
  const selectableLookbacks = [30, 60, 90, 120, 180];
  const selectableHorizons = [5, 10, 20, 30, 60, 63];
  const lookback = data?.lookback || 90;
  const horizon = data?.horizon || 30;
  const stars = '★'.repeat(data?.robustness || 1) + '☆'.repeat(Math.max(0, 5 - (data?.robustness || 1)));
  const controls = `<div class="hf-controls">
      <label>Pattern <select id="forecastLookback">${selectableLookbacks.map(value => `<option value="${value}"${value === lookback ? ' selected' : ''}>${value} sessions</option>`).join('')}</select></label>
      <label>Outcome <select id="forecastHorizon">${selectableHorizons.map(value => `<option value="${value}"${value === horizon ? ' selected' : ''}>${value} sessions</option>`).join('')}</select></label>
    </div>`;

  if (!data?.available || !data.displayable) {
    panel.innerHTML = `<div class="hf-card hf-${status.cls}">
      <div class="hf-head"><div><span class="hf-kicker">Historical Forecast</span><h3>Historical conditional probability</h3></div>${controls}</div>
      <div class="hf-empty"><span class="hf-status-icon">${status.icon}</span><div><strong>${status.label}</strong><p>${status.detail}</p><small>Historical outcomes are withheld rather than estimated from an unreliable sample.</small></div></div>
      <details class="hf-method"><summary>How calculated?</summary><p>Uses clean, split-adjusted daily OHLCV history to compare normalized price paths, returns, volatility, momentum, and drawdown. Candidate windows are separated and their future outcomes are measured only after the comparison date.</p></details>
    </div>`;
    bindForecastControls(symbol);
    return;
  }

  const probs = data.probabilities;
  const closest = data.closest || {};
  panel.innerHTML = `<div class="hf-card hf-${status.cls}">
    <div class="hf-head">
      <div><span class="hf-kicker">Historical Forecast</span><h3>Historical conditional probability</h3></div>
      ${controls}
    </div>
    <div class="hf-status-row">
      <span class="hf-status-icon">${status.icon}</span>
      <div><strong>${status.label}</strong><span>${status.detail}</span></div>
      <div class="hf-robustness"><span>Evidence quality</span><b aria-label="${data.robustness} of 5 stars">${stars}</b></div>
    </div>
    <div class="hf-probabilities">
      ${probabilitySegment('Bullish', probs.bull, 'bull')}
      ${probabilitySegment('Neutral', probs.neutral, 'neutral')}
      ${probabilitySegment('Bearish', probs.bear, 'bear')}
    </div>
    <div class="hf-chart-card">
      <div class="hf-chart-head"><strong>Historical analog projection</strong><span>Normalized to 100 at the forecast point</span></div>
      <canvas id="forecastPathCanvas" aria-label="Current pattern and comparable historical outcome paths"></canvas>
      <div class="hf-legend"><span class="current">● Current pattern</span><span class="analog">● Closest analog</span><span class="bull">● Bullish average</span><span class="bear">● Bearish average</span></div>
    </div>
    <div class="hf-facts">
      <div><span>Comparable windows</span><strong>${data.matchCount}</strong><small>${Number(data.effectiveSampleSize || 0).toFixed(1)} effective weighted sample</small></div>
      <div><span>Expected return</span><strong class="${data.expectedReturn >= 0 ? 'up' : 'down'}">${pct(data.expectedReturn)}</strong><small>10–90%: ${pct(data.returnRange?.p10)} to ${pct(data.returnRange?.p90)}</small></div>
      <div><span>Closest analog</span><strong>${(Number(closest.similarity || 0) * 100).toFixed(0)}% similar</strong><small>${escapeHtml(closest.date || '—')} · ${pct(closest.forwardReturn)} forward</small></div>
      <div><span>Historical range</span><strong class="up">${pct(closest.maxRise)}</strong><small class="down">Worst path: ${pct(closest.maxDrawdown)}</small></div>
    </div>
    <p class="hf-explain">${escapeHtml(data.explanation || '')}</p>
    <details class="hf-method"><summary>How calculated?</summary><p>Each comparison uses the selected normalized price path plus return correlation, volatility, momentum, and drawdown. A match’s influence is its similarity cubed. Bullish and bearish require a move beyond ±${Number(data.thresholdPct || 2).toFixed(1)}% over ${horizon} sessions. Future candles are used only to measure historical outcomes, never to select a match.</p><p>Historical outcomes among comparable patterns are not guarantees of future performance. This panel is read-only and does not change trading signals or place orders.</p></details>
  </div>`;
  const canvas = $('forecastPathCanvas');
  requestAnimationFrame(() => drawForecastPath(canvas, data));
  bindForecastControls(symbol);
}

function bindForecastControls(symbol) {
  const lookback = $('forecastLookback');
  const horizon = $('forecastHorizon');
  const update = async () => {
    if (!symbol || symbol !== state.symbol || !lookback || !horizon) return;
    const panel = $('forecastPanel');
    if (panel) panel.classList.add('hf-loading');
    const forecastLoadId = ++state.forecastLoadId;
    const forecast = await api.forecast(symbol, Number(lookback.value), Number(horizon.value));
    if (symbol !== state.symbol || forecastLoadId !== state.forecastLoadId || !state.stockData) return;
    state.stockData.forecast = forecast;
    renderForecastPanel(forecast, symbol);
  };
  lookback?.addEventListener('change', update);
  horizon?.addEventListener('change', update);
}

async function loadScorePanel(fmp, price) {
  const panel = $('scorePanel');
  if (!panel) return;
  const r = fmp?.ratings || {};
  const total   = r.total || 0;
  const totalBuy  = (r.strongBuy||0)+(r.buy||0);
  const totalSell = (r.sell||0)+(r.strongSell||0);
  const hold      = r.hold || 0;

  let scoreCardHtml = '';
  if (total > 0) {
    const buyRatio  = totalBuy / total;
    const sellRatio = totalSell / total;
    const score     = Math.max(1, Math.min(10, Math.round(1 + buyRatio*7 + (0.5-sellRatio)*2)));
    const scoreClass = score >= 7 ? 'bull' : score >= 4 ? 'neut' : 'bear';
    const verdict    = score >= 7 ? 'Bullish' : score >= 4 ? 'Neutral' : 'Bearish';

    const R=30, CX=40, CY=40, CIRC=2*Math.PI*R;
    const slice=(pct,off,color)=>{const len=(pct/100)*CIRC;return`<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${len.toFixed(2)} ${(CIRC-len).toFixed(2)}" stroke-dashoffset="${(-(off)*CIRC/100).toFixed(2)}"/>`;};
    const buyPct=totalBuy/total*100, holdPct=hold/total*100, sellPct=totalSell/total*100;
    const col = scoreClass==='bull'?'var(--green)':scoreClass==='neut'?'var(--gold)':'var(--red)';

    scoreCardHtml = `
    <div class="score-card">
      <div class="score-card-title">Qureshi Finance Score</div>
      <div class="score-badge-wrap">
        <div class="score-badge ${scoreClass}">${score}</div>
        <div>
          <div class="score-verdict">${verdict}</div>
          <div class="score-sub">Based on ${total} analyst ratings</div>
        </div>
      </div>
      <div class="donut-row">
        <div class="donut-wrap">
          <svg class="donut-svg" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="30" fill="none" stroke="var(--border)" stroke-width="10"/>
            ${slice(buyPct,0,'var(--green)')}${slice(holdPct,buyPct,'var(--gold)')}${slice(sellPct,buyPct+holdPct,'var(--red)')}
          </svg>
          <div class="donut-center">
            <span class="donut-pct" style="color:${col}">${buyPct.toFixed(0)}%</span>
            <span class="donut-lbl">Buy</span>
          </div>
        </div>
        <div class="donut-legend">
          <div class="leg-row"><span class="leg-dot" style="background:var(--green)"></span><span class="leg-name">Buy</span><span class="leg-n">${totalBuy}</span></div>
          <div class="leg-row"><span class="leg-dot" style="background:var(--gold)"></span><span class="leg-name">Hold</span><span class="leg-n">${hold}</span></div>
          <div class="leg-row"><span class="leg-dot" style="background:var(--red)"></span><span class="leg-name">Sell</span><span class="leg-n">${totalSell}</span></div>
        </div>
      </div>
      <div class="analyst-bars">
        ${barRow('Buy',totalBuy,total,'buy')}${barRow('Hold',hold,total,'hold')}${barRow('Sell',totalSell,total,'sell')}
      </div>
    </div>`;
  }

  panel.innerHTML = `${scoreCardHtml}${ptCard(fmp?.priceTarget, price)}`;
}

function barRow(label, count, total, cls) {
  if (!total) return '';
  const w = ((count/total)*100).toFixed(1);
  return `<div class="abar-row"><span class="abar-lbl">${label}</span><div class="abar-track"><div class="abar-fill ${cls}" style="width:${w}%"></div></div><span class="abar-n">${count}</span></div>`;
}

function ptCard(pt, price) {
  if (!pt?.targetMedian) return '';
  const { targetLow:low, targetMedian:med, targetHigh:high } = pt;
  const rng  = (high-low)||1;
  const curP = price>0 ? Math.max(0,Math.min(100,((price-low)/rng)*100)) : null;
  const medP = Math.max(0,Math.min(100,((med-low)/rng)*100));
  const ups  = price>0 ? ((med-price)/price)*100 : 0;
  return `
    <div class="pt-card">
      <div class="pt-card-title">Analyst Price Targets</div>
      <div class="pt-labels">
        <div class="pt-lbl"><span class="pt-lbl-name">Low</span><span class="pt-lbl-val">$${fmt(low)}</span></div>
        ${curP!==null?`<div class="pt-lbl"><span class="pt-lbl-name">Current</span><span class="pt-lbl-val cur">$${fmt(price)}</span></div>`:''}
        <div class="pt-lbl"><span class="pt-lbl-name">Median</span><span class="pt-lbl-val med">$${fmt(med)}</span></div>
        <div class="pt-lbl"><span class="pt-lbl-name">High</span><span class="pt-lbl-val">$${fmt(high)}</span></div>
      </div>
      <div class="pt-bar">
        <div class="pt-fill" style="width:${medP.toFixed(1)}%"></div>
        ${curP!==null?`<div class="pt-pin cur" style="left:${curP.toFixed(1)}%"></div>`:''}
        <div class="pt-pin med" style="left:${medP.toFixed(1)}%"></div>
      </div>
      <span class="pt-upside ${ups>=0?'up':'down'}">${ups>=0?'+':''}${ups.toFixed(1)}% upside to median target</span>
    </div>`;
}

// ── Chart tab ──────────────────────────────────────────────────────────────────
function renderChart(sym, initBars, up) {
  const color = up ? '#1dd6a3' : '#e84545';
  $('tab-chart').innerHTML = `
    <div class="tf-row">
      <button class="tf-btn active" data-tf="1Hour" data-lim="48">2D</button>
      <button class="tf-btn" data-tf="1Day" data-lim="30">1M</button>
      <button class="tf-btn" data-tf="1Day" data-lim="90">3M</button>
      <button class="tf-btn" data-tf="1Day" data-lim="180">6M</button>
      <button class="tf-btn" data-tf="1Day" data-lim="365">1Y</button>
    </div>
    <div class="chart-card"><canvas id="mainCanvas" style="height:340px"></canvas></div>`;
  const canvas = $('mainCanvas');
  if (initBars?.bars?.length>=2) requestAnimationFrame(() => drawChart(canvas, initBars.bars, color, 340));
  else api.bars(sym,'1Hour',48).then(d => d?.bars && requestAnimationFrame(() => drawChart(canvas, d.bars, color, 340)));
  $('tab-chart').querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      $('tab-chart').querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const d = await api.bars(sym, btn.dataset.tf, +btn.dataset.lim);
      if (!d?.bars) return;
      const up2  = d.bars.at(-1)?.c >= d.bars[0]?.c;
      requestAnimationFrame(() => drawChart(canvas, d.bars, up2?'#1dd6a3':'#e84545', 340));
    });
  });
}

// ── Analysts tab ───────────────────────────────────────────────────────────────
function ratingCls(r) {
  if (!r) return 'hold';
  const s = r.toLowerCase();
  if (s.includes('buy')||s==='outperform'||s==='overweight'||s==='accumulate') return 'buy';
  if (s.includes('sell')||s==='underperform'||s==='underweight') return 'sell';
  return 'hold';
}

// color indicator based on metric thresholds
function metricIndicator(key, value) {
  if (value == null) return 'neutral';
  const v = Number(value);
  switch (key) {
    case 'pe':            return v <= 0 ? 'weak' : v < 15 ? 'strong' : v < 30 ? 'neutral' : 'weak';
    case 'eps':           return v > 2  ? 'strong' : v > 0   ? 'neutral' : 'weak';
    case 'revenueGrowth': return v > 10 ? 'strong' : v >= 0  ? 'neutral' : 'weak';
    case 'netMargin':     return v > 15 ? 'strong' : v > 5   ? 'neutral' : 'weak';
    case 'grossMargin':   return v > 40 ? 'strong' : v > 20  ? 'neutral' : 'weak';
    default: return 'neutral';
  }
}

function valuationRow(label, key, value, formatted) {
  const ind = metricIndicator(key, value);
  const dot = `<span class="val-dot ${ind}"></span>`;
  return `
    <div class="val-row">
      <span class="val-label">${dot}${label}</span>
      <span class="val-value ${ind}">${formatted}</span>
    </div>`;
}

function renderValuation(val) {
  if (!val) return '<p class="no-data">Valuation data unavailable.</p>';

  const hasAny = val.pe != null || val.eps != null || val.revenueGrowth != null || val.netMargin != null || val.grossMargin != null;
  if (!hasAny) return '<p class="no-data">Valuation data unavailable — FMP rate limit may apply.</p>';

  const pe  = val.pe  != null ? fmt(val.pe, 1) + 'x' : '--';
  const eps = val.eps != null ? (val.eps >= 0 ? '$' : '-$') + fmt(Math.abs(val.eps), 2) : '--';
  const rev = val.revenueGrowth != null ? (val.revenueGrowth >= 0 ? '+' : '') + fmt(val.revenueGrowth, 1) + '%' : '--';
  const net = val.netMargin   != null ? fmt(val.netMargin, 1)   + '%' : '--';
  const grs = val.grossMargin != null ? fmt(val.grossMargin, 1) + '%' : '--';
  const period = val.date ? `<span class="val-period">Latest annual · ${escapeHtml(val.date.slice(0,4))}</span>` : '';

  return `
    <div class="val-header">${period}</div>
    ${valuationRow('P/E Ratio',           'pe',            val.pe,            pe)}
    ${valuationRow('EPS (Diluted)',        'eps',           val.eps,           eps)}
    ${valuationRow('Revenue Growth (YoY)','revenueGrowth', val.revenueGrowth, rev)}
    ${valuationRow('Net Profit Margin',   'netMargin',     val.netMargin,     net)}
    ${valuationRow('Gross Margin',        'grossMargin',   val.grossMargin,   grs)}
    <div class="val-legend">
      <span><i class="val-dot strong"></i>Healthy</span>
      <span><i class="val-dot neutral"></i>Neutral</span>
      <span><i class="val-dot weak"></i>Weak</span>
    </div>`;
}

function renderAnalysts(fmp, price, val) {
  const r  = fmp?.ratings || {};
  const pt = fmp?.priceTarget;
  const up = fmp?.upgrades || [];
  const total    = r.total||0;
  const totalBuy = (r.strongBuy||0)+(r.buy||0);
  const totalSell= (r.sell||0)+(r.strongSell||0);
  const hold     = r.hold||0;

  let consensusHtml = '<p class="no-data">Analyst data is temporarily unavailable (API rate limit may apply).</p>';
  if (total > 0) {
    const buyPct=totalBuy/total*100, holdPct=hold/total*100, sellPct=totalSell/total*100;
    const R=32,CX=40,CY=40,CIRC=2*Math.PI*R;
    const sl=(pct,off,color)=>{const len=(pct/100)*CIRC;return`<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}" stroke-width="12" stroke-dasharray="${len.toFixed(2)} ${(CIRC-len).toFixed(2)}" stroke-dashoffset="${(-(off)*CIRC/100).toFixed(2)}"/>`;};
    const consensus = totalBuy>totalSell&&totalBuy>hold?'buy':totalSell>totalBuy&&totalSell>hold?'sell':'hold';
    const cLabel    = totalBuy>totalSell*2?'Strong Buy':totalBuy>totalSell?'Buy':totalSell>totalBuy*2?'Strong Sell':totalSell>totalBuy?'Sell':'Hold';
    const cCol = consensus==='buy'?'var(--green)':consensus==='sell'?'var(--red)':'var(--gold)';
    consensusHtml = `
      <div class="donut-row">
        <div class="donut-wrap">
          <svg class="donut-svg" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="32" fill="none" stroke="var(--border)" stroke-width="12"/>
            ${sl(buyPct,0,'var(--green)')}${sl(holdPct,buyPct,'var(--gold)')}${sl(sellPct,buyPct+holdPct,'var(--red)')}
          </svg>
          <div class="donut-center"><span class="donut-pct" style="color:${cCol}">${buyPct.toFixed(0)}%</span><span class="donut-lbl">Buy</span></div>
        </div>
        <div class="donut-legend">
          <div class="leg-row"><span class="leg-dot" style="background:var(--green)"></span><span class="leg-name">Buy</span><span class="leg-n">${totalBuy}</span></div>
          <div class="leg-row"><span class="leg-dot" style="background:var(--gold)"></span><span class="leg-name">Hold</span><span class="leg-n">${hold}</span></div>
          <div class="leg-row"><span class="leg-dot" style="background:var(--red)"></span><span class="leg-name">Sell</span><span class="leg-n">${totalSell}</span></div>
        </div>
      </div>
      <span class="consensus-chip ${consensus}">${cLabel}</span>
      <div class="analyst-bars">
        ${barRow('Buy',totalBuy,total,'buy')}${barRow('Hold',hold,total,'hold')}${barRow('Sell',totalSell,total,'sell')}
      </div>
      <p style="font-size:11px;color:var(--t3);margin-top:10px;">${total} analyst ratings</p>`;
  }

  const upgradesHtml = up.length ? `
    <table class="up-table">
      <thead><tr><th>Firm</th><th>Rating</th><th>Change</th><th style="text-align:right">Date</th></tr></thead>
      <tbody>${up.slice(0,10).map(u=>{
        const d = u.date?new Date(u.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}):'';
        const c = ratingCls(u.newGrade);
        return`<tr><td class="up-firm">${escapeHtml(u.gradingCompany)||'—'}</td><td><span class="up-badge ${c}">${escapeHtml(u.newGrade)||'—'}</span></td><td class="up-prev">${escapeHtml(u.previousGrade)||'—'} → ${escapeHtml(u.newGrade)||'—'}</td><td class="up-date">${d}</td></tr>`;
      }).join('')}</tbody>
    </table>` : '<p class="no-data">No recent rating changes.</p>';

  $('tab-analysts').innerHTML = `
    <div class="analysts-layout">
      <div class="analysts-main">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="score-card"><div class="score-card-title">Analyst Consensus</div>${consensusHtml}</div>
          <div>${ptCard(pt,price)}</div>
        </div>
        <div class="upgrades-card"><div class="upgrades-title">Recent Rating Changes</div>${upgradesHtml}</div>
      </div>
      <div class="analysts-side">
        <div class="val-card">
          <div class="val-card-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            Valuation Metrics
          </div>
          ${renderValuation(val)}
        </div>
      </div>
    </div>`;
}

// ── News tab ───────────────────────────────────────────────────────────────────

function renderNews(news) {
  if (!news?.length) {
    $('tab-news').innerHTML = '<div class="news-feed"><p class="no-data" style="padding:24px">No recent news found.</p></div>';
    return;
  }
  const cards = news.slice(0, 20).map(n => {
    const date  = n.created_at ? timeAgo(n.created_at) : '';
    const title = escapeHtml(n.headline || n.title || '');
    const rawUrl = n.url || '#';
    const safe  = /^https?:\/\//i.test(rawUrl) ? rawUrl.replace(/"/g, '%22') : '#';
    const img   = n.image ? `<div class="ni-thumb" style="background-image:url('${n.image.replace(/'/g,'%27')}')"></div>` : '';
    const sum   = n.summary ? `<div class="ni-summary">${escapeHtml(n.summary.slice(0, 120))}${n.summary.length>120?'…':''}</div>` : '';
    return `<div class="news-item2" onclick="window.open('${safe}','_blank')">
      ${img}
      <div class="ni-body">
        <div class="ni-headline">${title}</div>
        ${sum}
        <div class="ni-meta">
          ${n.source ? `<span class="ni-src">${escapeHtml(n.source)}</span>` : ''}
          ${date    ? `<span class="ni-date">${date}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  $('tab-news').innerHTML = `<div class="news-grid">${cards}</div>`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff/60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m/60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h/24);
  if (d < 7)   return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

// ── Markets ────────────────────────────────────────────────────────────────────
function skelRows(n=5) {
  return Array(n).fill(`<div class="skel-row"><div class="skel" style="width:52px;height:13px"></div><div class="skel" style="flex:1;height:10px"></div><div class="skel" style="width:60px;height:13px"></div></div>`).join('');
}

// ── Crypto Markets ─────────────────────────────────────────────────────────────
const CRYPTO_TICKERS = ['BTC-USD','ETH-USD','BNB-USD','SOL-USD','XRP-USD','DOGE-USD','ADA-USD','AVAX-USD','LINK-USD','LTC-USD','DOT-USD','SHIB-USD'];

const CRYPTO_ICONS = {
  'BTC-USD':'#F7931A','ETH-USD':'#627EEA','BNB-USD':'#F3BA2F','SOL-USD':'#9945FF',
  'XRP-USD':'#00AAE4','DOGE-USD':'#C3A634','ADA-USD':'#0D1E2D','AVAX-USD':'#E84142',
  'LINK-USD':'#2A5ADA','LTC-USD':'#BFBBBB','DOT-USD':'#E6007A','SHIB-USD':'#FFA409',
};

async function loadCrypto() {
  const grid = $('cryptoGrid');
  if (!grid) return;

  try {
    const snaps = await api.snapshots(CRYPTO_TICKERS);

    const cards = CRYPTO_TICKERS.map(sym => {
      const s     = snaps[sym] || {};
      const px    = s.price   || null;   // null = data unavailable, never show $0
      const prev  = s.previousClose || null;
      const ch    = (px != null && prev != null) ? px - prev : null;
      const pct   = (ch != null && prev)         ? (ch / prev) * 100 : null;
      const mktcap = s.marketCap || 0;
      const name  = sym.replace('-USD','');
      const color = CRYPTO_ICONS[sym] || '#888';
      const eSym  = escapeHtml(sym);
      const priceStr = px != null ? (px >= 1000 ? fmt(px,0) : px >= 1 ? fmt(px,2) : fmt(px,6)) : '—';
      const pctStr   = pct != null ? (pct >= 0 ? '+' : '') + fmt(Math.abs(pct)) + '%' : '—';
      const chgCls   = pct == null ? '' : pct >= 0 ? 'up' : 'down';

      return `<div class="crypto-card" data-sym="${eSym}">
        <div class="crypto-card-icon" style="background:${color}22;border:1.5px solid ${color}44;color:${color}">${name.slice(0,3)}</div>
        <div class="crypto-card-info">
          <div class="crypto-card-name">${escapeHtml(s.name || name)}</div>
          <div class="crypto-card-sym">${name} <span class="crypto-24-7">24/7</span></div>
        </div>
        <div class="crypto-card-right">
          <div class="crypto-card-price">${px != null ? '$' + priceStr : '—'}</div>
          <div class="crypto-card-chg ${chgCls}">${pctStr}</div>
          ${mktcap ? `<div class="crypto-card-mcap">${fmtV(mktcap)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    grid.innerHTML = cards || '<div class="mrow-empty">No data available</div>';
    grid.querySelectorAll('.crypto-card').forEach(card => {
      card.addEventListener('click', () => openStock(card.dataset.sym, snaps[card.dataset.sym] || { symbol: card.dataset.sym }));
    });
  } catch {
    if (grid) grid.innerHTML = '<div class="mrow-empty">Crypto data unavailable</div>';
  }
}

// ── Market Events ──────────────────────────────────────────────────────────────
async function loadMarketEvents() {
  const ecoEl  = $('ecoTable');
  const earnEl = $('earningsTable');

  try {
    const r = await fetch('/api/events');
    if (!r.ok) throw new Error('events unavailable');
    const { economic, earnings } = await r.json();

    if (ecoEl) {
      if (economic && economic.length) {
        ecoEl.innerHTML = economic.map(e => {
          const d   = e.date ? new Date(e.date).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
          const hi  = e.impact === 'High';
          const act = e.actual != null ? `<span class="ev-val actual">${e.actual}</span>` : '';
          const est = e.estimate != null ? `<span class="ev-val est">est ${e.estimate}</span>` : '';
          return `<div class="ev-row">
            <span class="ev-date">${d}</span>
            <span class="ev-impact ${hi ? 'high' : 'med'}">${e.impact.toUpperCase()}</span>
            <span class="ev-name">${escapeHtml(e.event || '')}</span>
            <span class="ev-vals">${act}${est}</span>
          </div>`;
        }).join('');
      } else {
        ecoEl.innerHTML = '<div class="mrow-empty">No high-impact US events in the next 14 days</div>';
      }
    }

    if (earnEl) {
      if (earnings && earnings.length) {
        earnEl.innerHTML = earnings.map(e => {
          const d    = e.date ? new Date(e.date).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
          const when = e.time === 'bmo' ? 'BMO' : e.time === 'amc' ? 'AMC' : '';
          const eps  = e.epsEstimated != null ? `EPS est $${fmt(e.epsEstimated)}` : '';
          return `<div class="ev-row earn-row" data-sym="${escapeHtml(e.symbol)}">
            <span class="ev-date">${d}</span>
            <span class="earn-sym">${escapeHtml(e.symbol)}</span>
            <span class="earn-when ${when.toLowerCase()}">${when}</span>
            <span class="ev-name ev-eps">${eps}</span>
          </div>`;
        }).join('');
        earnEl.querySelectorAll('.earn-row').forEach(row => {
          row.addEventListener('click', () => openStock(row.dataset.sym, { symbol: row.dataset.sym }));
        });
      } else {
        earnEl.innerHTML = '<div class="mrow-empty">No major earnings in the next 14 days</div>';
      }
    }
  } catch {
    if (ecoEl)  ecoEl.innerHTML  = '<div class="mrow-empty">Events data unavailable</div>';
    if (earnEl) earnEl.innerHTML = '<div class="mrow-empty">Earnings data unavailable</div>';
  }
}

async function loadMarkets() {
  const TAPE_SYMS = ['SPY','QQQ','AAPL','MSFT','NVDA','TSLA'];
  ['gainersTable','losersTable'].forEach(id => { const el=$(id); if(el) el.innerHTML=skelRows(); });
  const allFetch = [...new Set([...MOVERS, ...TAPE_SYMS])];
  const snaps    = await api.snapshots(allFetch);

  const pct = sym => { const s=snaps[sym]||{}; const p=s.price||0,pv=s.previousClose||0; return pv?(p-pv)/pv:0; };

  const buildRow = sym => {
    const s  = snaps[sym]||{};
    const px = s.price||0, pv = s.previousClose||0;
    const ch = px-pv, pt = pv?(ch/pv)*100:0;
    const eSym = escapeHtml(sym);
    return `<div class="mrow" data-sym="${eSym}">
      <span class="mrow-sym">${eSym}</span>
      <span class="mrow-name">${escapeHtml(s.name||'')}</span>
      <span class="mrow-px">${px?'$'+fmt(px):'--'}</span>
      <span class="mrow-chg ${cls(ch)}">${ch>=0?'+':''}${fmt(pt)}%</span>
    </div>`;
  };

  const fill = (id, syms) => {
    const el=$(id); if(!el) return;
    el.innerHTML = syms.length ? syms.map(buildRow).join('') : '<div class="mrow-empty">No data</div>';
    el.querySelectorAll('.mrow').forEach(row => {
      row.addEventListener('click', () => openStock(row.dataset.sym, snaps[row.dataset.sym]||{symbol:row.dataset.sym}));
    });
  };

  const byPct    = [...MOVERS].sort((a,b) => pct(b)-pct(a));
  const gainers  = byPct.filter(s => pct(s) > 0).slice(0, 8);
  const losers   = byPct.filter(s => pct(s) < 0).reverse().slice(0, 8);

  fill('gainersTable', gainers);
  fill('losersTable',  losers);

  loadCrypto();
  loadMarketEvents();

  initWSBPage();

  // ticker tape
  const tape = $('tickerTape');
  if (tape) {
    tape.textContent = '';
    TAPE_SYMS.forEach(sym => {
      const s = snaps[sym]; if (!s?.price) return;
      const ch = s.price - (s.previousClose || 0), pt = (s.previousClose ? (ch / s.previousClose) * 100 : 0);
      const item = document.createElement('div'); item.className = 'tape-item';
      const symEl = document.createElement('span'); symEl.className = 'tape-sym'; symEl.textContent = sym;
      const priceEl = document.createElement('span'); priceEl.className = 'tape-price'; priceEl.textContent = `$${fmt(s.price)}`;
      const chgEl = document.createElement('span'); chgEl.className = `tape-chg ${cls(ch)}`; chgEl.textContent = `${ch >= 0 ? '+' : ''}${fmt(pt)}%`;
      item.appendChild(symEl); item.appendChild(priceEl); item.appendChild(chgEl);
      tape.appendChild(item);
    });
  }
}

// ── WSB Trending Page ──────────────────────────────────────────────────────────
let _wsbTimer = null;
let _wsbSecs  = 300;

async function fetchAndRenderWSBPage() {
  const tbl = $('wsbPageTable'), lu = $('wsbLastUpdated');
  if (!tbl) return;

  // skeleton
  tbl.innerHTML = Array(10).fill(0).map(()=>`
    <div class="wsbt-row wsbt-skel">
      <div class="wsbt-skel-inner"><div class="skel" style="width:32px;height:20px;border-radius:6px"></div></div>
      <div class="wsbt-skel-inner"><div class="skel" style="width:52px;height:14px"></div></div>
      <div class="wsbt-skel-inner"><div class="skel" style="width:90px;height:11px"></div></div>
      <div class="wsbt-skel-inner"><div class="skel" style="width:44px;height:13px"></div></div>
      <div class="wsbt-skel-inner"><div class="skel" style="width:100%;height:6px;border-radius:3px"></div></div>
      <div class="wsbt-skel-inner"><div class="skel" style="width:50px;height:13px"></div></div>
      <div class="wsbt-skel-inner"><div class="skel" style="width:52px;height:13px"></div></div>
      <div class="wsbt-skel-inner"><div class="skel" style="width:44px;height:13px"></div></div>
    </div>`).join('');

  const data = await api.wsb();
  const rows = data?.tickers || [];
  if (!rows.length) {
    tbl.innerHTML = '<div class="wsbt-empty">No data available — try refreshing.</div>';
    return;
  }

  // fetch live prices
  const snaps = await api.snapshots(rows.map(t => t.sym));

  const maxUpvotes  = Math.max(...rows.map(t => t.upvotes || 0), 1);
  const rankLabels  = ['🥇','🥈','🥉'];

  tbl.innerHTML = rows.map((t, i) => {
    // price info
    const s   = snaps[t.sym] || {};
    const px  = s.price || 0, pv = s.previousClose || 0;
    const pch = px - pv, ppt = pv ? (pch/pv)*100 : 0;

    // upvote bar (% of top entry's upvotes)
    const safeUpvotes = Number(t.upvotes) || 0;
    const upvPct = Math.round((safeUpvotes / maxUpvotes) * 100);
    const upvLabel = safeUpvotes >= 1000
      ? ((safeUpvotes / 1000).toFixed(1) + 'k')
      : String(safeUpvotes);

    // 24h mention change
    const mentChg = (t.mentions||0) - (t.mentionsAgo||0);
    let chgHtml;
    if      (mentChg > 0) chgHtml = `<span class="wsbt-chg up">▲ +${mentChg}</span>`;
    else if (mentChg < 0) chgHtml = `<span class="wsbt-chg down">▼ ${mentChg}</span>`;
    else                   chgHtml = `<span class="wsbt-chg flat">—</span>`;

    // rank badge
    const safeRank = Number(t.rank) || 0;
    const rankDisplay = i < 3
      ? `<span class="wsbt-medal">${rankLabels[i]}</span>`
      : `<span class="wsbt-ranknum">#${safeRank}</span>`;

    const safeSym      = escapeHtml(t.sym  || '');
    const safeName     = escapeHtml(t.name || '');
    const safeMentions = Number(t.mentions) || 0;
    const mentionDisplay = safeMentions >= 1000 ? (safeMentions/1000).toFixed(1)+'k' : safeMentions;

    return `<div class="wsbt-row" data-sym="${safeSym}" role="button" tabindex="0">
      <div class="wsbt-cell wsbt-col-rank">${rankDisplay}</div>
      <div class="wsbt-cell wsbt-col-ticker">
        <span class="wsbt-sym-btn">\$${safeSym}</span>
      </div>
      <div class="wsbt-cell wsbt-col-name">${safeName}</div>
      <div class="wsbt-cell wsbt-col-mentions">
        <span class="wsbt-mention-count">${mentionDisplay}</span>
        <span class="wsbt-mention-label">mentions</span>
      </div>
      <div class="wsbt-cell wsbt-col-bar">
        <div class="wsbt-bar-wrap">
          <div class="wsbt-bar-fill" style="width:${upvPct}%"></div>
        </div>
        <span class="wsbt-bar-label">${upvLabel} ↑</span>
      </div>
      <div class="wsbt-cell wsbt-col-chg">${chgHtml}</div>
      <div class="wsbt-cell wsbt-col-price">${px ? '$'+fmt(px) : '--'}</div>
      <div class="wsbt-cell wsbt-col-pct ${pch>=0?'up':'down'}">${px ? (pch>=0?'+':'')+fmt(ppt)+'%' : '--'}</div>
    </div>`;
  }).join('');

  // click to open stock
  tbl.querySelectorAll('.wsbt-row').forEach(row => {
    const open = () => {
      const sym = row.dataset.sym;
      openStock(sym, snaps[sym] || { symbol: sym });
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key==='Enter') open(); });
  });

  // updated timestamp
  if (lu && data.updated) {
    const d = new Date(data.updated);
    lu.textContent = 'Updated ' + d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  }
}

function initWSBPage() {
  // clear any running timer
  clearInterval(_wsbTimer);
  _wsbSecs = 300;

  // wire refresh button (idempotent)
  const btn = $('wsbPageRefresh');
  if (btn) {
    btn.onclick = () => {
      clearInterval(_wsbTimer);
      _wsbSecs = 300;
      fetchAndRenderWSBPage();
      startWsbCountdown();
    };
  }

  fetchAndRenderWSBPage();
  startWsbCountdown();
}

function startWsbCountdown() {
  clearInterval(_wsbTimer);
  _wsbSecs = 300;
  _wsbTimer = setInterval(() => {
    _wsbSecs--;
    const cd = $('wsbCountdown');
    if (cd) cd.textContent = `Next refresh in ${_wsbSecs}s`;
    if (_wsbSecs <= 0) {
      fetchAndRenderWSBPage();
      _wsbSecs = 300;
    }
  }, 1000);
}

// ── Watchlist ──────────────────────────────────────────────────────────────────
async function loadWatchlist() {
  const tbl = $('wlTable');
  if (!tbl) return;
  if (!state.watchlist.length) {
    tbl.innerHTML=`<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg><p>Your watchlist is empty</p><small>Add symbols to start tracking them</small></div>`;
    return;
  }
  tbl.innerHTML = '<div class="tab-spin"><div class="spinner"></div></div>';
  const snaps = await api.snapshots(state.watchlist);
  tbl.innerHTML = '';
  state.watchlist.forEach(sym => {
    const s = snaps[sym] || {};
    const isExtended = s.extendedPrice != null && s.marketState && s.marketState !== 'REGULAR';
    // During extended hours show extendedPrice; otherwise show regularClose or price
    const displayPx = isExtended ? s.extendedPrice : (s.price || 0);
    const pv = s.previousClose || 0;
    // Change vs previous close regardless of session
    const ch = displayPx && pv ? displayPx - pv : 0;
    const pt = pv ? (ch / pv) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'wl-row';

    const symSpan = document.createElement('span');
    symSpan.className = 'wl-sym';
    symSpan.textContent = sym;

    // Name + optional market-state badge
    const nameWrap = document.createElement('span');
    nameWrap.className = 'wl-name-wrap';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'wl-name';
    nameSpan.textContent = s.name || '';
    nameWrap.appendChild(nameSpan);
    if (isExtended) {
      const badge = document.createElement('span');
      badge.className = 'wl-session-badge wl-session-' + (s.extendedType === 'PRE' ? 'pre' : 'ah');
      badge.textContent = s.extendedType || 'EXT';
      nameWrap.appendChild(badge);
    } else if (s.marketState && !['REGULAR','PRE','POST','PREPRE','POSTPOST'].includes(s.marketState)) {
      const badge = document.createElement('span');
      badge.className = 'wl-session-badge wl-session-closed';
      badge.textContent = 'CLOSED';
      nameWrap.appendChild(badge);
    }

    // Price column — show extended price + regular close underneath when extended
    const pxWrap = document.createElement('span');
    pxWrap.className = 'wl-px-wrap';
    const pxSpan = document.createElement('span');
    pxSpan.className = 'wl-px';
    pxSpan.textContent = displayPx ? '$' + fmt(displayPx) : '--';
    pxWrap.appendChild(pxSpan);
    if (isExtended && s.regularClose) {
      const closeLbl = document.createElement('span');
      closeLbl.className = 'wl-reg-close';
      closeLbl.textContent = 'Close $' + fmt(s.regularClose);
      pxWrap.appendChild(closeLbl);
    }

    const chgSpan = document.createElement('span');
    chgSpan.className = `wl-chg ${cls(ch)}`;
    chgSpan.textContent = `${ch >= 0 ? '+' : ''}${fmt(pt)}%`;

    const rmBtn = document.createElement('button');
    rmBtn.className = 'wl-rm';
    rmBtn.dataset.sym = sym;
    rmBtn.title = 'Remove';
    rmBtn.textContent = '×';

    row.appendChild(symSpan);
    row.appendChild(nameWrap);
    row.appendChild(pxWrap);
    row.appendChild(chgSpan);
    row.appendChild(rmBtn);

    row.addEventListener('click', e => {
      if (e.target.closest('.wl-rm')) return;
      openStock(sym, s || { symbol: sym });
    });
    row.querySelector('.wl-rm').addEventListener('click', async () => {
      await wlAPI.remove(sym);
      loadWatchlist();
    });
    tbl.appendChild(row);
  });
}

// ── Futures & Overnight Tracker ───────────────────────────────────────────────
const futuresTracker = (() => {
  const SYMBOLS_ORDER = ['ES=F','NQ=F','YM=F','RTY=F','GC=F','CL=F','ZB=F'];
  let refreshTimer = null;

  function fmtPx(v, sym) {
    if (v == null) return '--';
    // Bond futures show as price (e.g. 108.50); others use comma formatting
    return '$' + (v >= 1000 ? v.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) : v.toFixed(2));
  }
  function fmtChg(chg, pct) {
    if (chg == null) return '';
    const sign = chg >= 0 ? '+' : '';
    return `${sign}${chg.toFixed(2)} (${sign}${pct != null ? pct.toFixed(2) : '0.00'}%)`;
  }
  function stateLabel(ms) {
    if (!ms) return '';
    if (ms === 'REGULAR') return 'Open';
    if (['PRE','PREPRE'].includes(ms)) return 'Pre';
    if (['POST','POSTPOST'].includes(ms)) return 'AH';
    return 'Closed';
  }

  function render(data) {
    const grid = $('futuresGrid');
    if (!grid) return;
    if (!data || !Object.keys(data).length) {
      grid.innerHTML = '<div class="futures-loading" style="color:#f85149">No data available</div>';
      return;
    }
    grid.innerHTML = '';
    SYMBOLS_ORDER.forEach(sym => {
      const q = data[sym];
      if (!q) return;
      const chg = q.change;
      const pct = q.changesPercentage;
      const isUp = chg != null && chg >= 0;
      const stLabel = stateLabel(q.marketState);

      const card = document.createElement('div');
      card.className = 'ft-card';

      const top = document.createElement('div');
      top.className = 'ft-card-top';

      const label = document.createElement('div');
      label.className = 'ft-label';
      label.textContent = q.label || sym;

      const stBadge = document.createElement('span');
      stBadge.className = 'ft-state ft-state-' + (stLabel === 'Open' ? 'open' : stLabel === 'Closed' ? 'closed' : 'ext');
      stBadge.textContent = stLabel || '—';

      top.appendChild(label);
      top.appendChild(stBadge);

      const symSmall = document.createElement('div');
      symSmall.className = 'ft-sym';
      symSmall.textContent = sym;

      const price = document.createElement('div');
      price.className = 'ft-price';
      price.textContent = fmtPx(q.price, sym);

      const chgDiv = document.createElement('div');
      chgDiv.className = 'ft-chg ' + (isUp ? 'up' : 'dn');
      chgDiv.textContent = fmtChg(chg, pct);

      card.appendChild(top);
      card.appendChild(symSmall);
      card.appendChild(price);
      card.appendChild(chgDiv);

      // Underlying ETF link
      if (q.underlying) {
        const link = document.createElement('button');
        link.className = 'ft-etf-link';
        link.textContent = '→ ' + q.underlying;
        link.addEventListener('click', () => openStock(q.underlying));
        card.appendChild(link);
      }

      grid.appendChild(card);
    });

    const upd = $('futuresUpdated');
    if (upd) {
      const now = new Date();
      upd.textContent = 'Updated ' + now.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true });
    }
  }

  async function load() {
    const grid = $('futuresGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="futures-loading"><div class="spinner"></div></div>';
    try {
      const r = await fetch('/api/futures');
      if (!r.ok) throw new Error(r.statusText);
      render(await r.json());
    } catch (e) {
      if (grid) grid.innerHTML = `<div class="futures-loading" style="color:#f85149">Failed to load — ${e.message}</div>`;
    }
  }

  function init() {
    load();
    const btn = $('futuresRefresh');
    if (btn) btn.addEventListener('click', load);
    // Auto-refresh every 60 seconds while on the watchlist page
    refreshTimer = setInterval(() => {
      if (document.getElementById('page-watchlist')?.classList.contains('active')) load();
    }, 60000);
  }

  return { init, load };
})();

// ── Sector Rotation Heatmap ────────────────────────────────────────────────────
const SECTORS = [
  { sym: 'XLK',  name: 'Technology'        },
  { sym: 'XLC',  name: 'Comm. Services'    },
  { sym: 'XLF',  name: 'Financials'        },
  { sym: 'XLV',  name: 'Healthcare'        },
  { sym: 'XLI',  name: 'Industrials'       },
  { sym: 'XLY',  name: 'Consumer Disc.'    },
  { sym: 'XLP',  name: 'Consumer Staples'  },
  { sym: 'XLE',  name: 'Energy'            },
  { sym: 'XLB',  name: 'Materials'         },
  { sym: 'XLRE', name: 'Real Estate'       },
  { sym: 'XLU',  name: 'Utilities'         },
];

function srBarColor(pct) {
  if (pct == null) return 'var(--border)';
  if (pct >= 0) {
    const t = Math.min(pct / 3, 1);
    return `rgba(29,214,163,${0.4 + t * 0.6})`;
  } else {
    const t = Math.min(Math.abs(pct) / 3, 1);
    return `rgba(239,83,80,${0.4 + t * 0.6})`;
  }
}

async function loadSectorHeatmap() {
  const grid    = $('srGrid');
  const summary = $('srSummary');
  if (!grid) return;

  grid.innerHTML    = '<div class="sr-loading"><div class="spinner"></div></div>';
  if (summary) summary.innerHTML = '';

  const syms  = SECTORS.map(s => s.sym);
  const snaps = await api.snapshots(syms);

  // Build enriched list sorted by % change desc
  const data = SECTORS.map(s => {
    const q   = snaps[s.sym] || {};
    const pct = q.changesPercentage ?? null;
    return { ...s, q, pct };
  }).sort((a, b) => (b.pct ?? -999) - (a.pct ?? -999));

  const inCount  = data.filter(d => d.pct != null && d.pct > 0.25).length;
  const outCount = data.filter(d => d.pct != null && d.pct < -0.25).length;

  // Summary badges
  if (summary) {
    summary.innerHTML = `
      <span class="sr-badge sr-badge-in">&#9650; ${inCount} Rotating In</span>
      <span class="sr-badge sr-badge-out">&#9660; ${outCount} Rotating Out</span>
    `;
  }

  grid.innerHTML = '';
  data.forEach((d, i) => {
    const pct  = d.pct;
    const px   = d.q.price;
    const pctCls = pct == null ? 'flat' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const pctTxt = pct == null ? '--' : (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';

    let signalCls, signalTxt;
    if      (pct == null)    { signalCls = 'sig-neutral'; signalTxt = '→ No data';   }
    else if (pct > 1.0)      { signalCls = 'sig-in';      signalTxt = '▲ Strong In'; }
    else if (pct > 0.25)     { signalCls = 'sig-in';      signalTxt = '↑ Rotating In'; }
    else if (pct < -1.0)     { signalCls = 'sig-out';     signalTxt = '▼ Strong Out'; }
    else if (pct < -0.25)    { signalCls = 'sig-out';     signalTxt = '↓ Rotating Out'; }
    else                     { signalCls = 'sig-neutral';  signalTxt = '→ Neutral';   }

    const tileCls = pct == null ? '' : pct > 0.25 ? 'sr-in' : pct < -0.25 ? 'sr-out' : '';

    const tile = document.createElement('div');
    tile.className = `sr-tile ${tileCls}`;

    const rankEl = document.createElement('span');
    rankEl.className = 'sr-rank';
    rankEl.textContent = `#${i + 1}`;

    const symEl = document.createElement('span');
    symEl.className = 'sr-tile-sym';
    symEl.textContent = d.sym;

    const nameEl = document.createElement('span');
    nameEl.className = 'sr-tile-name';
    nameEl.textContent = d.name;

    const pctEl = document.createElement('span');
    pctEl.className = `sr-tile-pct ${pctCls}`;
    pctEl.textContent = pctTxt;

    const priceEl = document.createElement('span');
    priceEl.className = 'sr-tile-price';
    priceEl.textContent = px != null ? '$' + fmt(px) : '';

    const sigEl = document.createElement('span');
    sigEl.className = `sr-tile-signal ${signalCls}`;
    sigEl.textContent = signalTxt;

    const barEl = document.createElement('div');
    barEl.className = 'sr-tile-bar';
    barEl.style.background = srBarColor(pct);

    tile.appendChild(rankEl);
    tile.appendChild(symEl);
    tile.appendChild(nameEl);
    tile.appendChild(pctEl);
    tile.appendChild(priceEl);
    tile.appendChild(sigEl);
    tile.appendChild(barEl);

    // Click to open the sector ETF
    tile.addEventListener('click', async () => {
      const s = await api.snapshots([d.sym]);
      openStock(d.sym, s[d.sym] || { symbol: d.sym });
    });

    grid.appendChild(tile);
  });
}

// ── Shared dropdown builder (safe alternative to innerHTML) ────────────────────
function buildDropItems(results) {
  return results.slice(0, 8).map(r => {
    const item = document.createElement('div');
    item.className = 'drop-item';
    item.dataset.sym = r.symbol;
    const sym = document.createElement('span');
    sym.className = 'drop-sym';
    sym.textContent = r.symbol;
    const name = document.createElement('span');
    name.className = 'drop-name';
    name.textContent = r.name || '';
    item.appendChild(sym);
    item.appendChild(name);
    return item;
  });
}

// ── Nav search ─────────────────────────────────────────────────────────────────
let navTimer=null;

async function _selectDropSym(sym, input, drop) {
  drop.classList.remove('open');
  input.value = '';
  const s = await api.snapshots([sym]);
  openStock(sym, s[sym] || { symbol: sym });
}

function _bindDropSearch(input, drop, getTimer, setTimer) {
  let reqId = 0; // race-condition guard — only render the latest response

  function _attachItemListeners() {
    drop.querySelectorAll('.drop-item[data-sym]').forEach(item => {
      item.addEventListener('mousedown', e => { e.preventDefault(); }); // keep focus on input
      item.addEventListener('click', () => _selectDropSym(item.dataset.sym, input, drop));
    });
  }

  function _getHighlighted() { return drop.querySelector('.drop-item.drop-active'); }

  function _highlight(el) {
    drop.querySelectorAll('.drop-item.drop-active').forEach(x => x.classList.remove('drop-active'));
    if (el) { el.classList.add('drop-active'); el.scrollIntoView({ block: 'nearest' }); }
  }

  input.addEventListener('input', () => {
    clearTimeout(getTimer());
    const q = input.value.trim();
    if (!q) { drop.classList.remove('open'); return; }

    // Show loading placeholder immediately
    const loading = document.createElement('div');
    loading.className = 'drop-item drop-noresults';
    loading.textContent = 'Searching…';
    drop.replaceChildren(loading);
    drop.classList.add('open');

    const myId = ++reqId;
    setTimer(setTimeout(async () => {
      const results = await api.search(q);
      if (myId !== reqId) return; // stale response — discard
      if (!results.length) {
        const noRes = document.createElement('div');
        noRes.className = 'drop-item drop-noresults';
        noRes.textContent = 'No results found';
        drop.replaceChildren(noRes);
        drop.classList.add('open');
        return;
      }
      drop.replaceChildren(...buildDropItems(results));
      drop.classList.add('open');
      _attachItemListeners();
    }, 260));
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { drop.classList.remove('open'); input.blur(); return; }
    if (!drop.classList.contains('open')) return;

    const items = [...drop.querySelectorAll('.drop-item[data-sym]')];
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = _getHighlighted();
      const next = cur ? (items[items.indexOf(cur) + 1] || items[0]) : items[0];
      _highlight(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = _getHighlighted();
      const prev = cur ? (items[items.indexOf(cur) - 1] || items[items.length - 1]) : items[items.length - 1];
      _highlight(prev);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = _getHighlighted();
      if (cur) {
        _selectDropSym(cur.dataset.sym, input, drop);
      } else {
        // No item highlighted — load exact ticker the user typed
        const sym = input.value.trim().toUpperCase();
        if (sym) _selectDropSym(sym, input, drop);
      }
    }
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !drop.contains(e.target)) drop.classList.remove('open');
  });
}

function setupNavSearch() {
  const input=$('navInput'), drop=$('navDrop');
  if (!input||!drop) return;
  _bindDropSearch(input, drop, ()=>navTimer, v=>{ navTimer=v; });
}

// ── Hero search ────────────────────────────────────────────────────────────────
let heroTimer=null;
function setupHeroSearch() {
  const input=$('heroInput'), drop=$('homeDrop');
  if(!input||!drop) return;
  _bindDropSearch(input, drop, ()=>heroTimer, v=>{ heroTimer=v; });
}

// ── Watchlist page setup ───────────────────────────────────────────────────────
function setupWatchlistPage() {
  const addBtn=$('addBtn'), row=$('addRow'), inp=$('addInput'), ok=$('addConfirm'), cancel=$('addCancel');
  if (!addBtn) return;
  addBtn.addEventListener('click',()=>{row.classList.toggle('open');inp?.focus();});
  ok?.addEventListener('click',async()=>{
    const sym=inp.value.trim().toUpperCase();
    if(sym&&!state.watchlist.includes(sym)) await wlAPI.add(sym);
    inp.value=''; row.classList.remove('open'); loadWatchlist();
  });
  cancel?.addEventListener('click',()=>{row.classList.remove('open');inp.value='';});
  inp?.addEventListener('keydown',e=>{if(e.key==='Enter')ok?.click();});
}

// ── Auth overlay helpers ────────────────────────────────────────────────────────
function showApp(user) {
  state.currentUser = user;
  $('authOverlay').classList.add('auth-hidden');
  $('navUser').style.display = 'flex';
  $('navUsername').textContent = user.username;
  window.jqfAgent?.show();
  futuresTracker.init();
  // Silently restore Alpaca connection state on every login/page-load —
  // credentials live in the DB and must not require a manual tab click to reconnect.
  alpacaTrader.checkCredentials();
}

function showAuthOverlay() {
  $('authOverlay').classList.remove('auth-hidden');
  $('navUser').style.display = 'none';
  window.jqfAgent?.hide();
  // Stop the trading desk poll and clear connection state cleanly on logout
  alpacaTrader.reset();
  // Pause scanner auto-refresh so it doesn't fire API calls while logged out
  window.stockScanner?.pause();
  state.currentUser = null;
  state.watchlist   = [];
  // Always land on the Sign In tab — prevents "username already taken" loop
  _resetAuthToLogin();
  $('authUser').value = '';
  $('authPass').value = '';
  // Reset UI to home so stale page content isn't shown on re-login
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === 'home'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const hp = $('page-home'); if (hp) hp.classList.add('active');
  state.page = 'home';
  // Clear any open stock workspace
  const ws = $('homeWorkspace'); if (ws) ws.style.display = 'none';
  const he = $('homeEmpty');    if (he) he.style.display = '';
  state.symbol = null;
}

let _resetAuthToLogin = () => {};   // populated by setupAuthUI

function setupAuthUI() {
  let mode = 'login';

  function setMode(m) {
    mode = m;
    const isReg = m === 'register';
    $('authTitle').textContent  = isReg ? 'Create your account' : 'Welcome back';
    $('authSub').textContent    = isReg ? 'Start tracking your personal watchlist' : 'Sign in to access your personalised watchlist';
    $('authSubmit').textContent = isReg ? 'Create Account' : 'Sign In';
    $('authSwitch').innerHTML   = isReg
      ? 'Already have an account? <a href="#" id="authSwitchLink">Sign in</a>'
      : 'No account? <a href="#" id="authSwitchLink">Create one free</a>';
    $('authError').textContent  = '';
    $('tabLogin').classList.toggle('active', !isReg);
    $('tabReg').classList.toggle('active',    isReg);
    $('authSwitchLink')?.addEventListener('click', e=>{ e.preventDefault(); setMode(isReg?'login':'register'); });
  }

  $('tabLogin').addEventListener('click', () => setMode('login'));
  $('tabReg').addEventListener('click',   () => setMode('register'));
  $('authSwitchLink')?.addEventListener('click', e=>{ e.preventDefault(); setMode(mode==='login'?'register':'login'); });

  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const u = $('authUser').value.trim();
    const p = $('authPass').value;
    $('authError').textContent = '';

    // Client-side validation
    if (!u) { $('authError').textContent = 'Please enter a username.'; $('authUser').focus(); return; }
    if (!p) { $('authError').textContent = 'Please enter a password.';  $('authPass').focus(); return; }
    if (mode === 'register' && p.length < 6) { $('authError').textContent = 'Password must be at least 6 characters.'; return; }
    if (mode === 'register' && !/^[a-zA-Z0-9_]{3,20}$/.test(u)) { $('authError').textContent = 'Username must be 3–20 characters (letters, numbers, _).'; return; }

    $('authSubmit').disabled    = true;
    $('authSubmit').textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';

    const res = mode === 'login' ? await authAPI.login(u, p) : await authAPI.register(u, p);

    if (res.ok) {
      await wlAPI.load();
      showApp(res.data);
      goPage('home');
    } else {
      $('authError').textContent = res.data?.code === 'LEGACY_ACCOUNT_RETIRED'
        ? 'This older account was retired for security. Select “Create Account” above to make a new account with this username, then reconnect your broker account.'
        : res.data?.error || 'Something went wrong.';
      $('authSubmit').disabled    = false;
      $('authSubmit').textContent = mode === 'login' ? 'Sign In' : 'Create Account';
    }
  });

  // Expose a reset function so showAuthOverlay can restore login mode on logout
  _resetAuthToLogin = () => {
    setMode('login');
    $('authSubmit').disabled = false;
  };
}

// ── INIT ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupAuthUI();

  // Check if already logged in
  const me = await authAPI.me();
  if (me) {
    await wlAPI.load();
    showApp(me);
  }

  // Logout
  $('navLogout')?.addEventListener('click', async () => {
    await authAPI.logout();
    showAuthOverlay();
  });

  // Change Password modal
  const cpwOverlay = $('cpwOverlay');
  $('navChangePw')?.addEventListener('click', () => {
    $('cpwCurrent').value = '';
    $('cpwNew').value = '';
    $('cpwConfirm').value = '';
    $('cpwError').textContent = '';
    $('cpwSubmit').disabled = false;
    $('cpwSubmit').textContent = 'Update Password';
    cpwOverlay.style.display = 'flex';
    setTimeout(() => $('cpwCurrent').focus(), 80);
  });
  $('cpwClose')?.addEventListener('click', () => { cpwOverlay.style.display = 'none'; });
  cpwOverlay?.addEventListener('click', e => { if (e.target === cpwOverlay) cpwOverlay.style.display = 'none'; });
  $('cpwSubmit')?.addEventListener('click', async () => {
    const cur = $('cpwCurrent').value;
    const nw  = $('cpwNew').value;
    const cf  = $('cpwConfirm').value;
    const errEl = $('cpwError');
    errEl.textContent = '';
    if (!cur || !nw || !cf) { errEl.textContent = 'All fields are required.'; return; }
    if (nw.length < 6)       { errEl.textContent = 'New password must be at least 6 characters.'; return; }
    if (nw !== cf)           { errEl.textContent = 'New passwords do not match.'; return; }
    const btn = $('cpwSubmit');
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
      });
      const data = await r.json();
      if (r.ok) {
        errEl.style.color = '#3fb950';
        errEl.textContent = 'Password updated successfully!';
        setTimeout(() => { cpwOverlay.style.display = 'none'; errEl.style.color = ''; }, 1800);
      } else {
        errEl.textContent = data.error || 'Update failed.';
        btn.disabled = false; btn.textContent = 'Update Password';
      }
    } catch { errEl.textContent = 'Network error — please try again.'; btn.disabled = false; btn.textContent = 'Update Password'; }
  });

  updateMarketStatus();
  setInterval(updateMarketStatus, 60000);

  document.querySelectorAll('.nav-link').forEach(tab=>{
    tab.addEventListener('click',()=>goPage(tab.dataset.page));
  });

  document.querySelectorAll('.stock-tab').forEach(tab=>{
    tab.addEventListener('click',()=>switchStockTab(tab.dataset.tab));
  });

  $('backBtn')?.addEventListener('click',()=>{
    const dest = state.prevPage || 'home';
    state.page = dest;
    document.querySelectorAll('.nav-link').forEach(l=>l.classList.toggle('active',l.dataset.page===dest));
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    $('page-'+dest)?.classList.add('active');
    state.symbol = null;
    $('homeWorkspace').style.display = 'none';
    $('homeEmpty').style.display = '';
  });

  $('watchBtn')?.addEventListener('click',async()=>{
    const sym=state.symbol; if(!sym) return;
    if(state.watchlist.includes(sym)) await wlAPI.remove(sym);
    else await wlAPI.add(sym);
    updateWatchBtn(sym);
  });

  setupNavSearch();
  setupHeroSearch();
  setupWatchlistPage();
});
