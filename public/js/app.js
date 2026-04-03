// ── StockPulse — Main App ──────────────────────────────────────────────────────

const INDICES  = ['SPY','QQQ','DIA','IWM'];
const MOVERS   = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','NFLX','UBER','COIN','PLTR','AMD'];

const state = {
  page:        'home',
  prevPage:    'home',
  symbol:      null,
  snap:        null,
  stockData:   null,
  watchlist:   JSON.parse(localStorage.getItem('sp_wl') || '["AAPL","MSFT","NVDA","TSLA"]'),
};

// ── utils ──────────────────────────────────────────────────────────────────────
const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtV = v => { if(!v) return '--'; if(v>=1e9) return (v/1e9).toFixed(1)+'B'; if(v>=1e6) return (v/1e6).toFixed(1)+'M'; if(v>=1e3) return (v/1e3).toFixed(0)+'K'; return String(v); };
const cls  = v => v >= 0 ? 'up' : 'down';
const escapeHtml = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const $    = id => document.getElementById(id);
const saveWL = () => localStorage.setItem('sp_wl', JSON.stringify(state.watchlist));

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
  if (page==='watchlist') loadWatchlist();
}

// ── Stock page ─────────────────────────────────────────────────────────────────
async function openStock(sym, snap) {
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
  $('sPrice').textContent  = price ? '$'+fmt(price) : '--';
  const sc = $('sChange');
  sc.textContent = price && prev ? `${up?'+':''}${fmt(chg)} (${up?'+':''}${fmt(pct)}%)` : '';
  sc.className   = 's-change ' + (up ? 'up' : 'down');
  updateWatchBtn(sym);

  document.querySelectorAll('.stock-tab').forEach(t => t.classList.toggle('active', t.dataset.tab==='overview'));
  document.querySelectorAll('.tab-pane').forEach(p => { p.classList.toggle('active', p.id==='tab-overview'); p.innerHTML='<div class="tab-spin"><div class="spinner"></div></div>'; });

  trader.analyze(sym);
  if (typeof rtTrader !== 'undefined') rtTrader.load(sym);

  const [barsData, fmpData, newsData, valData] = await Promise.all([
    api.bars(sym, '1Hour', 48),
    api.stock(sym),
    api.news(sym),
    api.valuation(sym),
  ]);
  state.stockData = { sym, snap, bars: barsData, fmp: fmpData, news: newsData, val: valData };
  renderOverview(snap, barsData, up);
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
    '<div id="scorePanel"></div></div>';
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
      <div class="score-card-title">StockPulse Score</div>
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

// ── WSB ────────────────────────────────────────────────────────────────────────
async function loadWSB() {
  const body = $('wsbBody'), upd = $('wsbUpdated');
  if (!body) return;
  body.innerHTML = '<div class="tab-spin"><div class="spinner"></div></div>';
  const data = await api.wsb();
  if (!data || (!data.tickers?.length && !data.risers?.length)) {
    body.innerHTML = '<div class="wsb-err">Could not load WSB data — try again shortly.</div>';
    return;
  }

  if (upd && data.updated) {
    const s = Math.floor((Date.now() - new Date(data.updated).getTime()) / 1000);
    upd.textContent = s < 60 ? 'just now' : `${Math.floor(s/60)}m ago`;
  }

  // fetch live prices for all relevant tickers
  const allSyms = [...new Set([
    ...(data.tickers||[]).map(t=>t.sym),
    ...(data.risers||[]).map(t=>t.sym),
  ])];
  const snaps = allSyms.length ? await api.snapshots(allSyms) : {};

  const maxMentions = data.tickers[0]?.mentions || 1;

  const buildTickerRow = (t, showBar=true) => {
    const s  = snaps[t.sym] || {};
    const px = s.price||0, pv = s.previousClose||0;
    const ch = px-pv, pt = pv?(ch/pv)*100:0;
    const rank     = Number(t.rank)     || 0;
    const mentions = Number(t.mentions) || 0;
    const bar = Math.round((mentions/maxMentions)*100);
    const rankChg = (Number(t.rankAgo) || rank) - rank;
    const rankBadge = rankChg > 0
      ? `<span class="wsb-rank-up">▲${rankChg}</span>`
      : rankChg < 0
        ? `<span class="wsb-rank-dn">▼${Math.abs(rankChg)}</span>`
        : `<span class="wsb-rank-eq">—</span>`;
    const safeSym  = escapeHtml(t.sym  || '');
    const safeName = escapeHtml((t.name||'').split(' ').slice(0,2).join(' '));
    return `<div class="wsb-ticker-row" data-sym="${safeSym}">
      <span class="wsb-rank">#${rank}</span>
      ${rankBadge}
      <span class="wsb-sym">${safeSym}</span>
      ${showBar ? `<div class="wsb-bar-wrap"><div class="wsb-bar" style="width:${bar}%"></div></div>` : `<span class="wsb-name-sm">${safeName}</span>`}
      <span class="wsb-mentions">${mentions >= 1000 ? (mentions/1000).toFixed(1)+'k' : mentions}</span>
      ${px ? `<span class="wsb-px">$${fmt(px)}</span><span class="wsb-pct ${cls(ch)}">${ch>=0?'+':''}${fmt(pt)}%</span>` : '<span class="wsb-px wsb-na">--</span><span class="wsb-pct wsb-na">--</span>'}
    </div>`;
  };

  const buildRiserRow = t => {
    const s  = snaps[t.sym] || {};
    const px = s.price||0, pv = s.previousClose||0;
    const ch = px-pv, pt = pv?(ch/pv)*100:0;
    const rank     = Number(t.rank)     || 0;
    const rankGain = Number(t.rankGain) || 0;
    const mentions = Number(t.mentions) || 0;
    const safeSym  = escapeHtml(t.sym  || '');
    const safeName = escapeHtml((t.name||'').split(' ').slice(0,2).join(' '));
    return `<div class="wsb-ticker-row" data-sym="${safeSym}">
      <span class="wsb-rank">#${rank}</span>
      <span class="wsb-rank-up">▲${rankGain}</span>
      <span class="wsb-sym">${safeSym}</span>
      <span class="wsb-name-sm">${safeName}</span>
      <span class="wsb-mentions">${mentions >= 1000 ? (mentions/1000).toFixed(1)+'k' : mentions}</span>
      ${px ? `<span class="wsb-px">$${fmt(px)}</span><span class="wsb-pct ${cls(ch)}">${ch>=0?'+':''}${fmt(pt)}%</span>` : '<span class="wsb-px wsb-na">--</span><span class="wsb-pct wsb-na">--</span>'}
    </div>`;
  };

  const tickerRows = (data.tickers||[]).map(t => buildTickerRow(t, true)).join('');
  const riserRows  = (data.risers||[]).map(buildRiserRow).join('');

  body.innerHTML = `
    <div class="wsb-cols">
      <div class="wsb-left">
        <div class="wsb-section-label">Most Mentioned — 24h</div>
        <div class="wsb-tickers">${tickerRows||'<div class="wsb-err">No data</div>'}</div>
      </div>
      <div class="wsb-right">
        <div class="wsb-section-label">Biggest Rank Gainers — vs Yesterday</div>
        <div class="wsb-tickers">${riserRows||'<div class="wsb-err">No risers today</div>'}</div>
      </div>
    </div>`;

  body.querySelectorAll('.wsb-ticker-row').forEach(row => {
    row.addEventListener('click', () => {
      const sym = row.dataset.sym;
      openStock(sym, snaps[sym] || { symbol: sym });
    });
  });
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
    const s=snaps[sym]||{};
    const px=s.price||0, pv=s.previousClose||0, ch=px-pv, pt=pv?(ch/pv)*100:0;
    const row = document.createElement('div');
    row.className='wl-row';
    const symSpan = document.createElement('span');
    symSpan.className = 'wl-sym';
    symSpan.textContent = sym;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'wl-name';
    nameSpan.textContent = s.name || '';
    const pxSpan = document.createElement('span');
    pxSpan.className = 'wl-px';
    pxSpan.textContent = px ? '$' + fmt(px) : '--';
    const chgSpan = document.createElement('span');
    chgSpan.className = `wl-chg ${cls(ch)}`;
    chgSpan.textContent = `${ch >= 0 ? '+' : ''}${fmt(pt)}%`;
    const rmBtn = document.createElement('button');
    rmBtn.className = 'wl-rm';
    rmBtn.dataset.sym = sym;
    rmBtn.title = 'Remove';
    rmBtn.textContent = '×';
    row.appendChild(symSpan);
    row.appendChild(nameSpan);
    row.appendChild(pxSpan);
    row.appendChild(chgSpan);
    row.appendChild(rmBtn);
    row.addEventListener('click', e => {
      if (e.target.closest('.wl-rm')) return;
      openStock(sym, s||{symbol:sym});
    });
    row.querySelector('.wl-rm').addEventListener('click', () => {
      state.watchlist.splice(state.watchlist.indexOf(sym),1);
      saveWL(); loadWatchlist();
    });
    tbl.appendChild(row);
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
function setupNavSearch() {
  const input=$('navInput'), drop=$('navDrop');
  if (!input||!drop) return;
  input.addEventListener('input',()=>{
    clearTimeout(navTimer);
    const q=input.value.trim();
    if(!q){drop.classList.remove('open');return;}
    navTimer=setTimeout(async()=>{
      const results=await api.search(q);
      if(!results.length){drop.classList.remove('open');return;}
      drop.replaceChildren(...buildDropItems(results));
      drop.classList.add('open');
      drop.querySelectorAll('.drop-item').forEach(item=>{
        item.addEventListener('click',async()=>{
          drop.classList.remove('open'); input.value='';
          const s=await api.snapshots([item.dataset.sym]);
          openStock(item.dataset.sym, s[item.dataset.sym]||{symbol:item.dataset.sym});
        });
      });
    },260);
  });
  document.addEventListener('click',e=>{ if(!input.contains(e.target)&&!drop.contains(e.target)) drop.classList.remove('open'); });
}

// ── Hero search ────────────────────────────────────────────────────────────────
let heroTimer=null;
function setupHeroSearch() {
  const input=$('heroInput'), drop=$('homeDrop');
  if(!input||!drop) return;
  input.addEventListener('input',()=>{
    clearTimeout(heroTimer);
    const q=input.value.trim();
    if(!q){drop.classList.remove('open');return;}
    heroTimer=setTimeout(async()=>{
      const results=await api.search(q);
      if(!results.length){drop.classList.remove('open');return;}
      drop.replaceChildren(...buildDropItems(results));
      drop.classList.add('open');
      drop.querySelectorAll('.drop-item').forEach(item=>{
        item.addEventListener('click',async()=>{
          drop.classList.remove('open'); input.value='';
          const s=await api.snapshots([item.dataset.sym]);
          openStock(item.dataset.sym, s[item.dataset.sym]||{symbol:item.dataset.sym});
        });
      });
    },260);
  });
  document.addEventListener('click',e=>{ if(!input.contains(e.target)&&!drop.contains(e.target)) drop.classList.remove('open'); });
}

// ── Watchlist page setup ───────────────────────────────────────────────────────
function setupWatchlistPage() {
  const addBtn=$('addBtn'), row=$('addRow'), inp=$('addInput'), ok=$('addConfirm'), cancel=$('addCancel');
  if (!addBtn) return;
  addBtn.addEventListener('click',()=>{row.classList.toggle('open');inp?.focus();});
  ok?.addEventListener('click',async()=>{
    const sym=inp.value.trim().toUpperCase();
    if(sym&&!state.watchlist.includes(sym)){state.watchlist.push(sym);saveWL();}
    inp.value=''; row.classList.remove('open'); loadWatchlist();
  });
  cancel?.addEventListener('click',()=>{row.classList.remove('open');inp.value='';});
  inp?.addEventListener('keydown',e=>{if(e.key==='Enter')ok?.click();});
}

// ── INIT ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
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

  $('watchBtn')?.addEventListener('click',()=>{
    const sym=state.symbol; if(!sym) return;
    const idx=state.watchlist.indexOf(sym);
    idx>=0 ? state.watchlist.splice(idx,1) : state.watchlist.push(sym);
    saveWL(); updateWatchBtn(sym);
  });

  setupNavSearch();
  setupHeroSearch();
  setupWatchlistPage();
});
