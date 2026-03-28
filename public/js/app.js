// ─────────────────────────────────────────────────────────────────────────────
// StockPulse — Main App
// ─────────────────────────────────────────────────────────────────────────────

const INDICES    = ['SPY','QQQ','DIA','IWM','GLD'];
const TECH       = ['AAPL','MSFT','NVDA','GOOGL','META','AMD','TSLA'];
const FINANCE    = ['JPM','BAC','GS','V','MA','PYPL'];
const MOVERS_SYM = ['AMZN','NFLX','UBER','COIN','PLTR','ROKU','RBLX','SNAP'];

// ─── STATE ────────────────────────────────────────────────────────────────────

const state = {
  snapshots:    {},
  currentPage:  'search',
  prevPage:     'search',
  currentSymbol: null,
  currentSnap:   null,
  stockData:     null,    // { bars, fmp, news } — fetched when stock opens
  watchlist: JSON.parse(localStorage.getItem('sp_watchlist') || '["AAPL","MSFT","NVDA"]'),
};

// ─── UTILS ────────────────────────────────────────────────────────────────────

function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return '--';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function cls(val) { return val >= 0 ? 'up' : 'down'; }

function fmtVol(v) {
  if (!v) return '--';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
}

function saveWatchlist() {
  localStorage.setItem('sp_watchlist', JSON.stringify(state.watchlist));
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function fetchSnapshots(symbols) {
  try {
    const r = await fetch(`/api/snapshots?symbols=${symbols.join(',')}`);
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

async function fetchBars(symbol, timeframe = '1Day', limit = 60) {
  try {
    const r = await fetch(`/api/bars/${symbol}?timeframe=${timeframe}&limit=${limit}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchNews(symbol) {
  try {
    const r = await fetch(`/api/news/${symbol}`);
    if (!r.ok) return [];
    const d = await r.json();
    return d.news || [];
  } catch { return []; }
}

async function searchSymbols(q) {
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function fetchStockAnalysis(symbol) {
  try {
    const r = await fetch(`/api/stock/${symbol}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── MARKET STATUS ────────────────────────────────────────────────────────────

function updateMarketStatus() {
  const now = new Date();
  const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  const isOpen = day >= 1 && day <= 5 && mins >= 570 && mins < 960;

  const dot  = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  if (dot)  dot.className  = 'status-dot ' + (isOpen ? 'open' : 'closed');
  if (text) text.textContent = isOpen ? 'Market Open' : 'Market Closed';
}

// ─── MINI CHART ───────────────────────────────────────────────────────────────

function drawMiniChart(canvas, prices, isUp) {
  if (!canvas || !prices || prices.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth || 220;
  const h = 48;
  canvas.width  = w;
  canvas.height = h;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const color = isUp ? '#3fb950' : '#f85149';
  const step  = w / (prices.length - 1);

  ctx.clearRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, isUp ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = i * step;
    const y = h - ((p - min) / range) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  const lastX = (prices.length - 1) * step;
  const lastY = h - ((prices[prices.length - 1] - min) / range) * (h - 4) - 2;
  ctx.lineTo(lastX, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = i * step;
    const y = h - ((p - min) / range) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
}

// ─── FULL CHART ───────────────────────────────────────────────────────────────

function drawFullChart(canvas, bars, color) {
  if (!canvas || !bars || bars.length === 0) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth || canvas.parentElement.offsetWidth - 48;
  const h = canvas.offsetHeight || 300;
  canvas.width  = w;
  canvas.height = h;

  const prices = bars.map(b => b.c);
  const min    = Math.min(...prices) * 0.999;
  const max    = Math.max(...prices) * 1.001;
  const range  = max - min || 1;

  const pad = { top: 12, right: 12, bottom: 28, left: 54 };
  const cw  = w - pad.left - pad.right;
  const ch  = h - pad.top  - pad.bottom;
  const step = cw / (prices.length - 1);

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y   = pad.top + (ch / 4) * i;
    const val = max - (range / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#484f58'; ctx.font = '10px Inter'; ctx.textAlign = 'right';
    ctx.fillText('$' + fmt(val), pad.left - 4, y + 3);
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
  grad.addColorStop(0, color + '44'); grad.addColorStop(1, color + '00');
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = pad.left + i * step;
    const y = pad.top + ch - ((p - min) / range) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.left + (prices.length - 1) * step, h - pad.bottom);
  ctx.lineTo(pad.left, h - pad.bottom); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Line
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = pad.left + i * step;
    const y = pad.top + ch - ((p - min) / range) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();

  // Dot at last price
  const lastX = pad.left + (prices.length - 1) * step;
  const lastY = pad.top + ch - ((prices[prices.length - 1] - min) / range) * ch;
  ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
}

// ─── ANALYST HELPERS ──────────────────────────────────────────────────────────

function ratingBadgeClass(r) {
  if (!r) return 'reiterate';
  const s = r.toLowerCase();
  if (s.includes('strong buy'))  return 'upgrade';
  if (s.includes('buy') || s === 'overweight' || s === 'outperform' || s === 'accumulate') return 'upgrade';
  if (s.includes('strong sell')) return 'downgrade';
  if (s.includes('sell') || s === 'underweight' || s === 'underperform') return 'downgrade';
  if (s.includes('initiat') || s.includes('coverage')) return 'initiated';
  return 'reiterate';
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

function switchTab(page) {
  state.prevPage = state.currentPage;
  state.currentPage = page;

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  if (page === 'markets')   loadMarkets();
  if (page === 'watchlist') loadWatchlist();
}

// ─── STOCK DETAIL PAGE ────────────────────────────────────────────────────────

async function openStock(symbol, snap) {
  state.prevPage     = state.currentPage;
  state.currentPage  = 'stock';
  state.currentSymbol = symbol;
  state.currentSnap   = snap;
  state.stockData     = null;

  // Deactivate all nav tabs while on stock page
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-stock').classList.add('active');

  // Stock header
  const price     = snap?.price || 0;
  const prev      = snap?.previousClose || 0;
  const change    = price - prev;
  const pct       = prev ? (change / prev) * 100 : 0;
  const isUp      = change >= 0;

  document.getElementById('detailSymbol').textContent = symbol;
  document.getElementById('detailName').textContent   = '';
  document.getElementById('detailPrice').textContent  = price ? '$' + fmt(price) : '--';

  const changeEl = document.getElementById('detailChange');
  changeEl.textContent = price && prev
    ? `${isUp ? '+' : ''}${fmt(change)} (${isUp ? '+' : ''}${fmt(pct)}%)`
    : '';
  changeEl.className = 'stock-change ' + cls(change);

  updateWatchBtn(symbol);

  // Reset to Overview tab
  document.querySelectorAll('.stock-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'overview'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-overview'));
  ['overview','chart','analysts','news'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.innerHTML = '<div class="tab-loading"><div class="spinner"></div></div>';
  });

  // Fetch all data in parallel
  const [barsData, fmpData, newsData] = await Promise.all([
    fetchBars(symbol, '1Hour', 48),
    fetchStockAnalysis(symbol),
    fetchNews(symbol),
  ]);

  state.stockData = { snap, bars: barsData, fmp: fmpData, news: newsData, symbol };

  // Render Overview (active tab)
  renderOverviewTab(snap, barsData, isUp);
}

function updateWatchBtn(symbol) {
  const btn   = document.getElementById('detailWatchBtn');
  const label = document.getElementById('watchBtnLabel');
  if (!btn || !label) return;
  const watching = state.watchlist.includes(symbol);
  btn.classList.toggle('watching', watching);
  label.textContent = watching ? 'Watching' : 'Watch';
}

function switchStockTab(tab) {
  document.querySelectorAll('.stock-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));

  const d = state.stockData;
  if (!d) return;

  const snap   = d.snap;
  const price  = snap?.price || 0;
  const prev   = snap?.previousClose || 0;
  const isUp   = price >= prev;

  if (tab === 'overview') renderOverviewTab(snap, d.bars, isUp);
  if (tab === 'chart')    renderChartTab(d.symbol, d.bars, isUp);
  if (tab === 'analysts') renderAnalystsTab(d.fmp, price);
  if (tab === 'news')     renderNewsTab(d.news);
}

function renderOverviewTab(snap, barsData, isUp) {
  const panel  = document.getElementById('tab-overview');
  if (!panel) return;

  const price  = snap?.price         || 0;
  const prev   = snap?.previousClose || 0;
  const open   = snap?.open          || 0;
  const high   = snap?.dayHigh       || 0;
  const low    = snap?.dayLow        || 0;
  const vol    = snap?.volume        || 0;
  const vwap   = snap?.price         || 0;

  panel.innerHTML = `
    <div class="overview-stats-grid">
      <div class="stat-box"><label>Open</label><span>$${fmt(open)}</span></div>
      <div class="stat-box"><label>Prev Close</label><span>$${fmt(prev)}</span></div>
      <div class="stat-box"><label>Day High</label><span>$${fmt(high)}</span></div>
      <div class="stat-box"><label>Day Low</label><span>$${fmt(low)}</span></div>
      <div class="stat-box"><label>Volume</label><span>${fmtVol(vol)}</span></div>
      <div class="stat-box"><label>VWAP</label><span>${vwap ? '$' + fmt(vwap) : '--'}</span></div>
    </div>
    <div class="overview-chart-card">
      <h3>Intraday (48h)</h3>
      <canvas id="overviewChartCanvas" style="height:140px;"></canvas>
    </div>
  `;

  const canvas = document.getElementById('overviewChartCanvas');
  if (canvas && barsData?.bars?.length >= 2) {
    const color = isUp ? '#3fb950' : '#f85149';
    requestAnimationFrame(() => drawFullChart(canvas, barsData.bars, color));
  }
}

function renderChartTab(symbol, initialBars, isUp) {
  const panel = document.getElementById('tab-chart');
  if (!panel) return;

  panel.innerHTML = `
    <div class="chart-timeframes">
      <button class="tf-btn active" data-tf="1Hour" data-limit="48">2D</button>
      <button class="tf-btn" data-tf="1Day" data-limit="30">1M</button>
      <button class="tf-btn" data-tf="1Day" data-limit="90">3M</button>
      <button class="tf-btn" data-tf="1Day" data-limit="180">6M</button>
      <button class="tf-btn" data-tf="1Day" data-limit="365">1Y</button>
    </div>
    <div class="chart-card">
      <canvas id="mainChartCanvas" style="height:340px;"></canvas>
    </div>
  `;

  const canvas = document.getElementById('mainChartCanvas');

  async function loadChartTab(tf, limit) {
    if (canvas) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }
    const data = await fetchBars(symbol, tf, limit);
    if (!data?.bars || !canvas) return;
    const prices = data.bars.map(b => b.c);
    const up     = prices[prices.length - 1] >= prices[0];
    const color  = up ? '#3fb950' : '#f85149';
    requestAnimationFrame(() => drawFullChart(canvas, data.bars, color));
  }

  // Render the initial bars immediately if we have them
  if (initialBars?.bars?.length >= 2 && canvas) {
    const color = isUp ? '#3fb950' : '#f85149';
    requestAnimationFrame(() => drawFullChart(canvas, initialBars.bars, color));
  } else {
    loadChartTab('1Hour', 48);
  }

  panel.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadChartTab(btn.dataset.tf, parseInt(btn.dataset.limit));
    });
  });
}

function renderAnalystsTab(fmpData, price) {
  const panel = document.getElementById('tab-analysts');
  if (!panel) return;

  const ratings     = fmpData?.ratings;
  const priceTarget = fmpData?.priceTarget;
  const upgrades    = fmpData?.upgrades || [];

  // ── Consensus card ──────────────────────────────────────────────────────────
  let ratingsHtml = '<p class="no-data">No analyst data available</p>';
  if (ratings && ratings.total > 0) {
    const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0, total } = ratings;
    const totalBuy  = strongBuy + buy;
    const totalSell = sell + strongSell;
    const consensus = totalBuy > hold && totalBuy > totalSell ? 'buy'
                    : totalSell > hold && totalSell > totalBuy ? 'sell'
                    : 'hold';
    const consensusLabel = totalBuy > totalSell * 2 ? 'Strong Buy'
                         : totalBuy > totalSell     ? 'Buy'
                         : totalSell > totalBuy * 2 ? 'Strong Sell'
                         : totalSell > totalBuy     ? 'Sell'
                         : 'Hold';

    // Donut chart via SVG
    const buyPct  = (totalBuy  / total) * 100;
    const holdPct = (hold      / total) * 100;
    const sellPct = (totalSell / total) * 100;
    const R = 38, CX = 50, CY = 50, CIRC = 2 * Math.PI * R;
    function donutSlice(pct, offset, color) {
      const len = (pct / 100) * CIRC;
      return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
        stroke="${color}" stroke-width="12"
        stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}"
        stroke-dashoffset="${(-offset * CIRC / 100).toFixed(2)}"
        stroke-linecap="butt"/>`;
    }
    const buySlice  = donutSlice(buyPct,  0,          'var(--green)');
    const holdSlice = donutSlice(holdPct, buyPct,     'var(--gold)');
    const sellSlice = donutSlice(sellPct, buyPct + holdPct, 'var(--red)');

    const pctColor = consensus === 'buy' ? 'var(--green)' : consensus === 'sell' ? 'var(--red)' : 'var(--gold)';

    const barRow = (label, count, cls) => count > 0 ? `
      <div class="analyst-bar-row">
        <span class="analyst-bar-label">${label}</span>
        <div class="analyst-bar-track"><div class="analyst-bar-fill ${cls}" style="width:${((count/total)*100).toFixed(1)}%"></div></div>
        <span class="analyst-bar-count">${count}</span>
      </div>` : '';

    ratingsHtml = `
      <div class="consensus-wrap">
        <div class="consensus-donut-wrap">
          <svg class="consensus-donut-svg" viewBox="0 0 100 100">
            <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--border)" stroke-width="12"/>
            ${buySlice}${holdSlice}${sellSlice}
          </svg>
          <div class="consensus-center">
            <span class="consensus-pct" style="color:${pctColor}">${buyPct.toFixed(0)}%</span>
            <span class="consensus-label-sm">Buy</span>
          </div>
        </div>
        <div class="consensus-legend">
          <div class="legend-row"><span class="legend-dot" style="background:var(--green)"></span><span class="legend-name">Buy</span><span class="legend-val">${totalBuy}</span></div>
          <div class="legend-row"><span class="legend-dot" style="background:var(--gold)"></span><span class="legend-name">Hold</span><span class="legend-val">${hold}</span></div>
          <div class="legend-row"><span class="legend-dot" style="background:var(--red)"></span><span class="legend-name">Sell</span><span class="legend-val">${totalSell}</span></div>
        </div>
      </div>
      <span class="consensus-badge ${consensus}" style="margin-bottom:14px;">${consensusLabel}</span>
      ${barRow('Buy', totalBuy, 'buy')}
      ${barRow('Hold', hold, 'hold')}
      ${barRow('Sell', totalSell, 'sell')}
      <p style="font-size:11px;color:var(--text-muted);margin-top:12px;">${total} analyst ratings</p>
    `;
  }

  // ── Price target card ────────────────────────────────────────────────────────
  let ptHtml = '<p class="no-data">No price target data</p>';
  if (priceTarget?.targetMedian) {
    const { targetLow, targetMedian, targetHigh } = priceTarget;
    const range   = targetHigh - targetLow || 1;
    const curPct  = price     > 0 ? Math.max(0, Math.min(100, ((price       - targetLow) / range) * 100)) : null;
    const medPct  = Math.max(0, Math.min(100, ((targetMedian - targetLow) / range) * 100));
    const upside  = price > 0 ? ((targetMedian - price) / price) * 100 : 0;
    const upsideCls = upside >= 0 ? 'up' : 'down';

    ptHtml = `
      <div class="pt-bar-wrap">
        <div class="pt-bar-labels">
          <div class="pt-bar-label-item">
            <span class="pt-bar-label-name">Low</span>
            <span class="pt-bar-label-val">$${fmt(targetLow)}</span>
          </div>
          ${curPct !== null ? `
          <div class="pt-bar-label-item">
            <span class="pt-bar-label-name">Current</span>
            <span class="pt-bar-label-val current">$${fmt(price)}</span>
          </div>` : ''}
          <div class="pt-bar-label-item">
            <span class="pt-bar-label-name">Median</span>
            <span class="pt-bar-label-val median">$${fmt(targetMedian)}</span>
          </div>
          <div class="pt-bar-label-item">
            <span class="pt-bar-label-name">High</span>
            <span class="pt-bar-label-val">$${fmt(targetHigh)}</span>
          </div>
        </div>
        <div class="pt-bar-track">
          <div class="pt-bar-fill" style="width:${medPct.toFixed(1)}%"></div>
          ${curPct !== null ? `<div class="pt-bar-pin current" style="left:${curPct.toFixed(1)}%"></div>` : ''}
          <div class="pt-bar-pin median" style="left:${medPct.toFixed(1)}%"></div>
        </div>
        <span class="pt-upside ${upsideCls}">${upside >= 0 ? '+' : ''}${upside.toFixed(1)}% upside to median</span>
      </div>
    `;
  }

  // ── Upgrades table ───────────────────────────────────────────────────────────
  let upgradesHtml = '<p class="no-data">No recent rating changes</p>';
  if (upgrades.length > 0) {
    upgradesHtml = `
      <table class="upgrades-table">
        <thead>
          <tr>
            <th>Firm</th>
            <th>Rating</th>
            <th>Change</th>
            <th style="text-align:right">Date</th>
          </tr>
        </thead>
        <tbody>
          ${upgrades.slice(0, 10).map(u => {
            const firm = u.gradingCompany || 'Unknown';
            const prev = u.previousGrade  || '—';
            const next = u.newGrade       || '—';
            const date = u.date ? new Date(u.date).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' }) : '';
            const cls  = ratingBadgeClass(next);
            return `<tr>
              <td class="upgrade-firm">${firm}</td>
              <td><span class="upgrade-action-badge ${cls}">${next}</span></td>
              <td class="upgrade-rating-text">${prev} → ${next}</td>
              <td class="upgrade-date-text">${date}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  panel.innerHTML = `
    <div class="analysts-layout">
      <div class="analyst-card">
        <div class="analyst-card-title">Analyst Consensus</div>
        ${ratingsHtml}
      </div>
      <div class="analyst-card">
        <div class="analyst-card-title">Price Targets</div>
        ${ptHtml}
      </div>
    </div>
    <div class="upgrades-card">
      <div class="upgrades-card-title">Recent Rating Changes</div>
      ${upgradesHtml}
    </div>
  `;
}

function renderNewsTab(newsData) {
  const panel = document.getElementById('tab-news');
  if (!panel) return;

  if (!newsData || newsData.length === 0) {
    panel.innerHTML = '<div class="news-list"><p class="no-data">No recent news found.</p></div>';
    return;
  }

  panel.innerHTML = `
    <div class="news-list">
      ${newsData.slice(0, 12).map(n => {
        const date = n.created_at ? new Date(n.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
        return `
        <div class="news-item" onclick="window.open('${n.url || '#'}','_blank')">
          <div class="news-headline">${n.headline || n.title || 'No title'}</div>
          <div class="news-meta">
            ${n.source ? `<span class="news-source">${n.source}</span>` : ''}
            ${date ? `<span>${date}</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

// ─── MARKETS ──────────────────────────────────────────────────────────────────

function buildMarketRow(sym, snaps) {
  const s     = snaps[sym];
  const price = s?.price || 0;
  const prev  = s?.previousClose || 0;
  const chg   = price - prev;
  const pct   = prev ? (chg / prev) * 100 : 0;
  const isUp  = chg >= 0;

  const div = document.createElement('div');
  div.className = 'market-row';
  div.innerHTML = `
    <span class="mrow-sym">${sym}</span>
    <span class="mrow-name"></span>
    <span class="mrow-price">${price ? '$' + fmt(price) : '--'}</span>
    <span class="mrow-change ${cls(chg)}">${isUp ? '+' : ''}${fmt(pct)}%</span>
  `;
  div.addEventListener('click', () => openStock(sym, s || { symbol: sym }));
  return div;
}

async function loadMarkets() {
  const allSyms = [...new Set([...INDICES, ...TECH, ...FINANCE, ...MOVERS_SYM])];

  // Show skeletons
  ['indicesTable','moversTable','techTable','financeTable'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = [1,2,3,4,5].map(() => `
      <div class="market-row-skeleton">
        <div class="skel" style="width:48px;height:14px;"></div>
        <div class="skel" style="flex:1;height:10px;"></div>
        <div class="skel" style="width:56px;height:14px;"></div>
      </div>
    `).join('');
  });

  const snaps = await fetchSnapshots(allSyms);
  Object.assign(state.snapshots, snaps);

  const fill = (id, syms) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    syms.forEach(sym => el.appendChild(buildMarketRow(sym, snaps)));
  };

  fill('indicesTable', INDICES);
  fill('techTable', TECH);
  fill('financeTable', FINANCE);

  const sorted = MOVERS_SYM.slice().sort((a, b) => {
    const pctOf = s => { const snap = snaps[s]; const p = snap?.price||0; const pv = snap?.previousClose||0; return pv ? Math.abs((p-pv)/pv) : 0; };
    return pctOf(b) - pctOf(a);
  });
  fill('moversTable', sorted);

  // Ticker strip
  updateTickerStrip(snaps);
}

function updateTickerStrip(snaps) {
  const strip = document.getElementById('tickerStrip');
  if (!strip) return;
  const syms = ['SPY','QQQ','AAPL','MSFT','NVDA','TSLA'];
  strip.innerHTML = syms.map(sym => {
    const s    = snaps[sym];
    const price = s?.price || 0;
    const prev  = s?.previousClose || 0;
    const chg   = price - prev;
    const pct   = prev ? (chg / prev) * 100 : 0;
    return price ? `
      <div class="ticker-item">
        <span class="t-sym">${sym}</span>
        <span class="t-price">$${fmt(price)}</span>
        <span class="t-change ${cls(chg)}">${chg >= 0 ? '+' : ''}${fmt(pct)}%</span>
      </div>` : '';
  }).join('');
}

// ─── WATCHLIST ────────────────────────────────────────────────────────────────

async function loadWatchlist() {
  const grid = document.getElementById('watchlistGrid');
  if (!grid) return;

  if (state.watchlist.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
        <p>Your watchlist is empty</p>
        <span>Add symbols to track them here</span>
      </div>`;
    return;
  }

  grid.innerHTML = '<div class="tab-loading"><div class="spinner"></div></div>';
  const snaps = await fetchSnapshots(state.watchlist);

  grid.innerHTML = '';
  state.watchlist.forEach(sym => {
    const s     = snaps[sym];
    const price = s?.price || 0;
    const prev  = s?.previousClose || 0;
    const chg   = price - prev;
    const pct   = prev ? (chg / prev) * 100 : 0;
    const isUp  = chg >= 0;

    const row = document.createElement('div');
    row.className = 'watchlist-row';
    row.innerHTML = `
      <span class="wrow-sym">${sym}</span>
      <span class="wrow-price">${price ? '$' + fmt(price) : '--'}</span>
      <span class="wrow-change ${cls(chg)}">${isUp ? '+' : ''}${fmt(pct)}%</span>
      <button class="wrow-remove" title="Remove" data-sym="${sym}">×</button>
    `;
    row.addEventListener('click', e => {
      if (e.target.closest('.wrow-remove')) return;
      openStock(sym, s || { symbol: sym });
    });
    row.querySelector('.wrow-remove').addEventListener('click', () => {
      state.watchlist.splice(state.watchlist.indexOf(sym), 1);
      saveWatchlist();
      loadWatchlist();
    });
    grid.appendChild(row);
  });
}

// ─── NAV SEARCH (dropdown) ────────────────────────────────────────────────────

let searchTimer = null;

function setupNavSearch() {
  const input    = document.getElementById('navSearchInput');
  const dropdown = document.getElementById('navDropdown');
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { dropdown.classList.remove('open'); return; }
    searchTimer = setTimeout(async () => {
      const results = await searchSymbols(q);
      if (!results.length) { dropdown.classList.remove('open'); return; }
      dropdown.innerHTML = results.slice(0, 8).map(r => `
        <div class="dropdown-item" data-sym="${r.symbol}">
          <span class="dropdown-sym">${r.symbol}</span>
          <span class="dropdown-name">${r.name || ''}</span>
        </div>`).join('');
      dropdown.classList.add('open');
      dropdown.querySelectorAll('.dropdown-item').forEach(item => {
        item.addEventListener('click', async () => {
          const sym = item.dataset.sym;
          dropdown.classList.remove('open');
          input.value = '';
          const snaps = await fetchSnapshots([sym]);
          openStock(sym, snaps[sym] || { symbol: sym });
        });
      });
    }, 280);
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });
}

// ─── HERO SEARCH ──────────────────────────────────────────────────────────────

function setupHeroSearch() {
  const input       = document.getElementById('heroSearchInput');
  const resultsWrap = document.getElementById('searchResultsWrap');
  const resultsList = document.getElementById('searchResultsList');
  const hero        = document.getElementById('searchHero');
  if (!input || !resultsWrap || !resultsList || !hero) return;

  let heroTimer = null;

  input.addEventListener('input', () => {
    clearTimeout(heroTimer);
    const q = input.value.trim();
    if (!q) {
      resultsWrap.style.display = 'none';
      hero.style.display = 'flex';
      return;
    }
    heroTimer = setTimeout(async () => {
      hero.style.display = 'none';
      resultsWrap.style.display = 'block';
      resultsList.innerHTML = '<div class="tab-loading"><div class="spinner"></div></div>';
      const results = await searchSymbols(q);
      if (!results.length) {
        resultsList.innerHTML = '<p class="search-hint">No results found</p>';
        return;
      }
      renderSearchResults(results, resultsList);
    }, 320);
  });

  // Chip clicks
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const sym   = chip.dataset.sym;
      const snaps = await fetchSnapshots([sym]);
      openStock(sym, snaps[sym] || { symbol: sym });
    });
  });
}

async function renderSearchResults(results, container) {
  const snaps = await fetchSnapshots(results.slice(0, 8).map(r => r.symbol));
  container.innerHTML = '';
  results.slice(0, 8).forEach(r => {
    const s     = snaps[r.symbol];
    const price = s?.price || 0;
    const prev  = s?.previousClose || 0;
    const chg   = price - prev;
    const pct   = prev ? (chg / prev) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'result-row';
    row.innerHTML = `
      <span class="result-sym">${r.symbol}</span>
      <span class="result-name">${r.name || ''}</span>
      ${r.exchangeShortName ? `<span class="result-exchange">${r.exchangeShortName}</span>` : ''}
      ${price ? `<span class="mrow-price">$${fmt(price)}</span>` : ''}
      ${price && prev ? `<span class="mrow-change ${cls(chg)}">${chg >= 0 ? '+' : ''}${fmt(pct)}%</span>` : ''}
      <span class="result-arrow">›</span>
    `;
    row.addEventListener('click', () => openStock(r.symbol, s || { symbol: r.symbol, name: r.name }));
    container.appendChild(row);
  });
}

// ─── BACK BUTTON ──────────────────────────────────────────────────────────────

function setupBackBtn() {
  const btn = document.getElementById('backBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const prev = state.prevPage;
    state.currentPage = prev;
    state.currentSymbol = null;

    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === prev));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const prevEl = document.getElementById('page-' + prev);
    if (prevEl) prevEl.classList.add('active');
  });
}

// ─── WATCHLIST WATCH BUTTON ───────────────────────────────────────────────────

function setupWatchBtn() {
  const btn = document.getElementById('detailWatchBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const sym = state.currentSymbol;
    if (!sym) return;
    const idx = state.watchlist.indexOf(sym);
    if (idx >= 0) {
      state.watchlist.splice(idx, 1);
    } else {
      state.watchlist.push(sym);
    }
    saveWatchlist();
    updateWatchBtn(sym);
  });
}

// ─── ADD TO WATCHLIST (page) ──────────────────────────────────────────────────

function setupWatchlistPage() {
  const addBtn      = document.getElementById('addToWatchlistBtn');
  const form        = document.getElementById('addSymbolForm');
  const confirmBtn  = document.getElementById('confirmAddSymbol');
  const cancelBtn   = document.getElementById('cancelAddSymbol');
  const input       = document.getElementById('watchlistInput');
  if (!addBtn || !form) return;

  addBtn.addEventListener('click', () => {
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
    if (form.style.display === 'flex') input?.focus();
  });

  confirmBtn?.addEventListener('click', async () => {
    const sym = input?.value.trim().toUpperCase();
    if (!sym) return;
    if (!state.watchlist.includes(sym)) {
      state.watchlist.push(sym);
      saveWatchlist();
    }
    if (input) input.value = '';
    form.style.display = 'none';
    loadWatchlist();
  });

  cancelBtn?.addEventListener('click', () => {
    form.style.display = 'none';
    if (input) input.value = '';
  });

  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmBtn?.click();
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  updateMarketStatus();
  setInterval(updateMarketStatus, 60000);

  // Top nav tab clicks
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      switchTab(tab.dataset.page);
    });
  });

  // Stock sub-tab clicks
  document.querySelectorAll('.stock-tab').forEach(tab => {
    tab.addEventListener('click', () => switchStockTab(tab.dataset.tab));
  });

  setupNavSearch();
  setupHeroSearch();
  setupBackBtn();
  setupWatchBtn();
  setupWatchlistPage();
});
