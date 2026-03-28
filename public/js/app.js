// ─────────────────────────────────────────────────────────────────────────────
// StockPulse - Main App
// ─────────────────────────────────────────────────────────────────────────────

const FEED_SYMBOLS = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD',
  'NFLX','PYPL','JPM','BAC','GS','V','MA','SPY','QQQ','DIA','IWM','GLD'
];

const INDICES    = ['SPY','QQQ','DIA','IWM','GLD'];
const TECH       = ['AAPL','MSFT','NVDA','GOOGL','META','AMD','TSLA'];
const FINANCE    = ['JPM','BAC','GS','V','MA','PYPL'];
const MOVERS_SYM = ['AMZN','NFLX','UBER','COIN','PLTR','ROKU','RBLX','SNAP'];

// ─── STATE ────────────────────────────────────────────────────────────────────

const state = {
  snapshots: {},
  currentSymbol: null,
  watchlist: JSON.parse(localStorage.getItem('sp_watchlist') || '["AAPL","MSFT","NVDA"]'),
  panelChart: null,
  modalChart: null,
  miniCharts: {}
};

// ─── UTILS ────────────────────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '--';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtChange(chg, pct) {
  const sign = chg >= 0 ? '+' : '';
  return `${sign}${fmt(chg)} (${sign}${fmt(pct)}%)`;
}

function cls(val) { return val >= 0 ? 'up' : 'down'; }

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

// ─── MARKET STATUS ────────────────────────────────────────────────────────────

function updateMarketStatus() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  const isWeekday = day >= 1 && day <= 5;
  const isOpen = isWeekday && mins >= 570 && mins < 960; // 9:30–16:00

  const dot = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  dot.className = 'status-dot ' + (isOpen ? 'open' : 'closed');
  text.textContent = isOpen ? 'Market Open' : 'Market Closed';
}

// ─── MINI CHART ───────────────────────────────────────────────────────────────

function drawMiniChart(canvas, prices, isUp) {
  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth || 220;
  const h = 48;
  canvas.width = w;
  canvas.height = h;

  if (!prices || prices.length < 2) return;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const color = isUp ? '#22c55e' : '#ef4444';
  const step = w / (prices.length - 1);

  ctx.clearRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, isUp ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = i * step;
    const y = h - ((p - min) / range) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });

  const lastX = (prices.length - 1) * step;
  const lastY = h - ((prices[prices.length - 1] - min) / range) * (h - 4) - 2;
  ctx.lineTo(lastX, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = i * step;
    const y = h - ((p - min) / range) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

async function loadMiniChart(symbol, container) {
  const data = await fetchBars(symbol, '1Hour', 24);
  if (!data || !data.bars) return;
  const prices = data.bars.map(b => b.c);
  const canvas = container.querySelector('canvas');
  if (canvas && prices.length > 1) {
    const isUp = prices[prices.length - 1] >= prices[0];
    drawMiniChart(canvas, prices, isUp);
  }
}

// ─── FULL CHART (panel / modal) ───────────────────────────────────────────────

function drawFullChart(canvas, bars, color) {
  if (!bars || bars.length === 0) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth || canvas.parentElement.offsetWidth - 32;
  const h = canvas.offsetHeight || 240;
  canvas.width = w;
  canvas.height = h;

  const prices = bars.map(b => b.c);
  const min = Math.min(...prices) * 0.999;
  const max = Math.max(...prices) * 1.001;
  const range = max - min || 1;

  const pad = { top: 10, right: 10, bottom: 24, left: 50 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  const step = cw / (prices.length - 1);

  // Grid lines
  ctx.strokeStyle = '#1e1e1e';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();

    const val = max - (range / 4) * i;
    ctx.fillStyle = '#555';
    ctx.font = '10px Inter';
    ctx.textAlign = 'right';
    ctx.fillText('$' + fmt(val), pad.left - 4, y + 3);
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
  grad.addColorStop(0, color + '44');
  grad.addColorStop(1, color + '00');

  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = pad.left + i * step;
    const y = pad.top + ch - ((p - min) / range) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.left + (prices.length - 1) * step, h - pad.bottom);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = pad.left + i * step;
    const y = pad.top + ch - ((p - min) / range) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Last price dot
  const lastX = pad.left + (prices.length - 1) * step;
  const lastY = pad.top + ch - ((prices[prices.length - 1] - min) / range) * ch;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ─── STOCK CARDS (Feed) ───────────────────────────────────────────────────────

function buildCard(symbol, snap) {
  const q = snap?.dailyBar || snap?.latestTrade || {};
  const price = snap?.latestTrade?.p || snap?.latestQuote?.ap || 0;
  const prevClose = snap?.prevDailyBar?.c || 0;
  const change = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;
  const isUp = change >= 0;
  const vol = snap?.dailyBar?.v || 0;
  const high = snap?.dailyBar?.h || 0;
  const low = snap?.dailyBar?.l || 0;

  const div = document.createElement('div');
  div.className = 'stock-card';
  div.dataset.symbol = symbol;
  div.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-symbol">${symbol}</div>
      </div>
      <div class="card-badge ${cls(change)}">${isUp ? '▲' : '▼'} ${fmt(Math.abs(changePct))}%</div>
    </div>
    <div class="card-price">$${fmt(price)}</div>
    <div class="card-stats">
      <div class="card-stat">
        <label>Change</label>
        <span style="color:var(--${isUp ? 'green' : 'red'})">${isUp ? '+' : ''}${fmt(change)}</span>
      </div>
      <div class="card-stat">
        <label>High</label>
        <span>${high ? '$' + fmt(high) : '--'}</span>
      </div>
      <div class="card-stat">
        <label>Volume</label>
        <span>${vol > 1e6 ? (vol / 1e6).toFixed(1) + 'M' : vol > 1000 ? (vol / 1000).toFixed(0) + 'K' : vol || '--'}</span>
      </div>
    </div>
    <div class="mini-chart"><canvas></canvas></div>
  `;
  div.addEventListener('click', () => openDetail(symbol, snap));
  return div;
}

async function loadFeed() {
  const grid = document.getElementById('feedGrid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading market data...</p></div>';

  const snaps = await fetchSnapshots(FEED_SYMBOLS);
  state.snapshots = snaps;

  grid.innerHTML = '';
  if (!snaps || Object.keys(snaps).length === 0) {
    grid.innerHTML = '<div class="loading-state"><p>Unable to load market data. Check API keys.</p></div>';
    return;
  }

  const cards = [];
  FEED_SYMBOLS.forEach(sym => {
    const snap = snaps[sym];
    if (!snap) return;
    const card = buildCard(sym, snap);
    grid.appendChild(card);
    cards.push({ sym, card });
  });

  // Load mini charts async in batches
  for (const { sym, card } of cards) {
    const mc = card.querySelector('.mini-chart');
    loadMiniChart(sym, mc);
  }

  updateTickerStrip(snaps);
}

// ─── TICKER STRIP ─────────────────────────────────────────────────────────────

function updateTickerStrip(snaps) {
  const strip = document.getElementById('tickerStrip');
  const syms = ['SPY','QQQ','AAPL','MSFT','NVDA','TSLA','AMZN'];
  strip.innerHTML = syms.map(sym => {
    const s = snaps[sym];
    if (!s) return '';
    const price = s.latestTrade?.p || 0;
    const prev = s.prevDailyBar?.c || 0;
    const chg = price - prev;
    const pct = prev ? (chg / prev) * 100 : 0;
    const dir = chg >= 0 ? 'up' : 'down';
    return `<div class="ticker-item">
      <span class="t-sym">${sym}</span>
      <span class="t-price">$${fmt(price)}</span>
      <span class="t-change ${dir}">${chg >= 0 ? '+' : ''}${fmt(pct)}%</span>
    </div>`;
  }).join('');
}

// ─── DETAIL PANEL ─────────────────────────────────────────────────────────────

async function openDetail(symbol, snap) {
  state.currentSymbol = symbol;
  const panel = document.getElementById('panelContent');
  const pc = document.getElementById('panelClose');
  pc.style.display = 'block';

  const price = snap?.latestTrade?.p || 0;
  const prev = snap?.prevDailyBar?.c || 0;
  const change = price - prev;
  const pct = prev ? (change / prev) * 100 : 0;
  const isUp = change >= 0;
  const high = snap?.dailyBar?.h || 0;
  const low = snap?.dailyBar?.l || 0;
  const open = snap?.dailyBar?.o || 0;
  const vol = snap?.dailyBar?.v || 0;

  panel.innerHTML = `
    <div class="panel-header">
      <div class="panel-symbol">${symbol}</div>
    </div>
    <div class="panel-price">$${fmt(price)}</div>
    <div class="panel-change ${cls(change)}">${fmtChange(change, pct)}</div>
    <div class="panel-chart-area">
      <canvas id="panelChartCanvas"></canvas>
    </div>
    <div class="panel-grid">
      <div class="panel-stat"><label>Open</label><span>$${fmt(open)}</span></div>
      <div class="panel-stat"><label>Prev Close</label><span>$${fmt(prev)}</span></div>
      <div class="panel-stat"><label>High</label><span>$${fmt(high)}</span></div>
      <div class="panel-stat"><label>Low</label><span>$${fmt(low)}</span></div>
      <div class="panel-stat"><label>Volume</label><span>${vol > 1e6 ? (vol/1e6).toFixed(2)+'M' : vol > 1000 ? (vol/1000).toFixed(0)+'K' : vol||'--'}</span></div>
      <div class="panel-stat"><label>VWAP</label><span>$${fmt(snap?.dailyBar?.vw)}</span></div>
    </div>
    <div class="panel-actions">
      <button class="panel-btn gold" onclick="openModal('${symbol}')">Full Chart</button>
      <button class="panel-btn outline" onclick="toggleWatchlist('${symbol}')">
        ${state.watchlist.includes(symbol) ? '★ Watchlist' : '☆ Watch'}
      </button>
    </div>
    <div class="panel-section-title">Recent News</div>
    <div class="panel-news" id="panelNews"><div class="spinner" style="margin:20px auto;width:24px;height:24px;border-width:2px"></div></div>
  `;

  // Load panel chart
  const data = await fetchBars(symbol, '1Hour', 48);
  const pCanvas = document.getElementById('panelChartCanvas');
  if (pCanvas && data?.bars) {
    const color = isUp ? '#22c55e' : '#ef4444';
    pCanvas.style.height = '120px';
    drawFullChart(pCanvas, data.bars, color);
  }

  // Load news
  const news = await fetchNews(symbol);
  const newsEl = document.getElementById('panelNews');
  if (newsEl) {
    if (news.length === 0) {
      newsEl.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No recent news found.</p>';
    } else {
      newsEl.innerHTML = news.slice(0, 5).map(n => `
        <div class="news-item" onclick="window.open('${n.url}','_blank')">
          <div class="news-headline">${n.headline}</div>
          <div class="news-meta">${n.source} · ${new Date(n.created_at).toLocaleDateString()}</div>
        </div>
      `).join('');
    }
  }
}

function closePanel() {
  document.getElementById('panelContent').innerHTML = `
    <div class="panel-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      <p>Select a stock to view details</p>
    </div>
  `;
  document.getElementById('panelClose').style.display = 'none';
  state.currentSymbol = null;
}

// ─── MODAL CHART ──────────────────────────────────────────────────────────────

async function openModal(symbol) {
  const modal = document.getElementById('chartModal');
  document.getElementById('modalTitle').textContent = symbol;
  modal.style.display = 'flex';
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.tf-btn[data-tf="1Day"]').classList.add('active');
  await loadModalChart(symbol, '1Day', 30);
}

async function loadModalChart(symbol, tf, limit) {
  const canvas = document.getElementById('chartCanvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

  const data = await fetchBars(symbol, tf, limit);
  if (!data?.bars) return;

  const bars = data.bars;
  const prices = bars.map(b => b.c);
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? '#22c55e' : '#ef4444';

  canvas.style.height = '248px';
  drawFullChart(canvas, bars, color);

  const first = prices[0];
  const last = prices[prices.length - 1];
  const chg = last - first;
  const pct = first ? (chg / first) * 100 : 0;
  const high = Math.max(...prices);
  const low = Math.min(...prices);

  document.getElementById('modalStats').innerHTML = `
    <div class="modal-stat"><label>Current</label><span>$${fmt(last)}</span></div>
    <div class="modal-stat"><label>Change</label><span style="color:var(--${cls(chg)})">${chg >= 0 ? '+' : ''}${fmt(chg)} (${chg >= 0 ? '+' : ''}${fmt(pct)}%)</span></div>
    <div class="modal-stat"><label>High</label><span>$${fmt(high)}</span></div>
    <div class="modal-stat"><label>Low</label><span>$${fmt(low)}</span></div>
  `;
}

function closeModal() {
  document.getElementById('chartModal').style.display = 'none';
}

// ─── WATCHLIST ────────────────────────────────────────────────────────────────

function toggleWatchlist(symbol) {
  const idx = state.watchlist.indexOf(symbol);
  if (idx >= 0) {
    state.watchlist.splice(idx, 1);
  } else {
    state.watchlist.push(symbol);
  }
  saveWatchlist();
  if (state.currentSymbol === symbol) {
    const snap = state.snapshots[symbol];
    if (snap) openDetail(symbol, snap);
  }
  if (document.getElementById('page-watchlist').classList.contains('active')) {
    loadWatchlist();
  }
}

async function loadWatchlist() {
  const grid = document.getElementById('watchlistGrid');
  if (state.watchlist.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        <p>Your watchlist is empty</p>
        <span>Add symbols to track them here</span>
      </div>
    `;
    return;
  }

  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  const snaps = await fetchSnapshots(state.watchlist);

  grid.innerHTML = '';
  state.watchlist.forEach(sym => {
    const s = snaps[sym];
    const price = s?.latestTrade?.p || 0;
    const prev = s?.prevDailyBar?.c || 0;
    const chg = price - prev;
    const pct = prev ? (chg / prev) * 100 : 0;
    const isUp = chg >= 0;

    const card = document.createElement('div');
    card.className = 'watchlist-card';
    card.innerHTML = `
      <div class="wl-left" onclick="openWatchlistItem('${sym}', this)">
        <div class="wl-sym">${sym}</div>
        <div class="wl-price">$${fmt(price)}</div>
      </div>
      <div class="wl-right">
        <div class="wl-change ${cls(chg)}">${isUp ? '+' : ''}${fmt(pct)}%</div>
        <button class="wl-remove" title="Remove" onclick="removeFromWatchlist('${sym}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
}

window.openWatchlistItem = async function(sym, el) {
  const snaps = await fetchSnapshots([sym]);
  if (snaps[sym]) openDetail(sym, snaps[sym]);
};

window.removeFromWatchlist = function(sym) {
  const idx = state.watchlist.indexOf(sym);
  if (idx >= 0) state.watchlist.splice(idx, 1);
  saveWatchlist();
  loadWatchlist();
};

window.toggleWatchlist = toggleWatchlist;
window.openModal = openModal;

// ─── MARKETS PAGE ─────────────────────────────────────────────────────────────

function buildMarketsRow(sym, snaps) {
  const s = snaps[sym];
  const price = s?.latestTrade?.p || 0;
  const prev = s?.prevDailyBar?.c || 0;
  const chg = price - prev;
  const pct = prev ? (chg / prev) * 100 : 0;
  const isUp = chg >= 0;

  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML = `
    <span class="r-sym">${sym}</span>
    <span class="r-price">$${fmt(price)}</span>
    <span class="r-change ${cls(chg)}">${isUp ? '+' : ''}${fmt(chg)} (${isUp ? '+' : ''}${fmt(pct)}%)</span>
  `;
  div.addEventListener('click', () => { if (s) openDetail(sym, s); });
  return div;
}

async function loadMarkets() {
  const allSyms = [...new Set([...INDICES, ...TECH, ...FINANCE, ...MOVERS_SYM])];
  const snaps = await fetchSnapshots(allSyms);
  Object.assign(state.snapshots, snaps);

  const fill = (id, syms) => {
    const el = document.getElementById(id);
    el.innerHTML = '';
    syms.forEach(sym => el.appendChild(buildMarketsRow(sym, snaps)));
  };

  fill('indicesTable', INDICES);
  fill('techTable', TECH);
  fill('financeTable', FINANCE);

  // Sort movers by % change
  const sorted = MOVERS_SYM.slice().sort((a, b) => {
    const pct = sym => {
      const s = snaps[sym];
      const p = s?.latestTrade?.p || 0;
      const prev = s?.prevDailyBar?.c || 0;
      return prev ? (p - prev) / prev * 100 : 0;
    };
    return Math.abs(pct(b)) - Math.abs(pct(a));
  });
  fill('moversTable', sorted);
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

let searchTimer = null;

function setupSearch() {
  // Topbar search
  const topInput = document.getElementById('topbarSearch');
  const dropdown = document.getElementById('searchDropdown');

  topInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = topInput.value.trim();
    if (!q) { dropdown.classList.remove('open'); return; }
    searchTimer = setTimeout(async () => {
      const results = await searchSymbols(q);
      if (!results.length) { dropdown.classList.remove('open'); return; }
      dropdown.innerHTML = results.slice(0, 10).map(r => `
        <div class="search-result-item" data-sym="${r.symbol}">
          <span class="sym">${r.symbol}</span>
          <span class="name">${r.name || ''}</span>
        </div>
      `).join('');
      dropdown.classList.add('open');
      dropdown.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', async () => {
          const sym = item.dataset.sym;
          dropdown.classList.remove('open');
          topInput.value = '';
          const snaps = await fetchSnapshots([sym]);
          if (snaps[sym]) openDetail(sym, snaps[sym]);
        });
      });
    }, 300);
  });

  document.addEventListener('click', e => {
    if (!topInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  // Search page
  const pageInput = document.getElementById('searchPageInput');
  const searchResults = document.getElementById('searchResults');

  pageInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = pageInput.value.trim();
    if (!q) {
      searchResults.innerHTML = '<p class="search-hint">Type a symbol or company name to search</p>';
      return;
    }
    searchTimer = setTimeout(async () => {
      searchResults.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
      const results = await searchSymbols(q);
      if (!results.length) {
        searchResults.innerHTML = '<p class="search-hint">No results found</p>';
        return;
      }
      searchResults.innerHTML = '';
      const snaps = await fetchSnapshots(results.slice(0, 10).map(r => r.symbol));
      results.slice(0, 10).forEach(r => {
        const s = snaps[r.symbol];
        const price = s?.latestTrade?.p || 0;
        const prev = s?.prevDailyBar?.c || 0;
        const chg = price - prev;
        const pct = prev ? (chg / prev) * 100 : 0;
        const isUp = chg >= 0;

        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `
          <span class="r-sym">${r.symbol}</span>
          <span class="r-name">${r.name || ''}</span>
          <span class="r-price">$${fmt(price)}</span>
          <span class="r-change ${cls(chg)}">${isUp ? '+' : ''}${fmt(pct)}%</span>
        `;
        row.addEventListener('click', () => { if (s) openDetail(r.symbol, s); });
        searchResults.appendChild(row);
      });
    }, 400);
  });
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const page = item.dataset.page;

      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-' + page).classList.add('active');

      if (page === 'feed' && Object.keys(state.snapshots).length === 0) loadFeed();
      if (page === 'markets') loadMarkets();
      if (page === 'watchlist') loadWatchlist();
      if (page === 'search') document.getElementById('searchPageInput').focus();

      // Close sidebar on mobile
      if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
      }
    });
  });

  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  document.getElementById('panelClose').addEventListener('click', closePanel);

  document.getElementById('refreshFeed').addEventListener('click', loadFeed);

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('chartModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Timeframe buttons
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (state.currentSymbol) {
        loadModalChart(state.currentSymbol, btn.dataset.tf, parseInt(btn.dataset.limit));
      }
    });
  });

  // Watchlist add button
  document.getElementById('addToWatchlist').addEventListener('click', () => {
    const form = document.getElementById('addSymbolForm');
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
    if (form.style.display === 'flex') document.getElementById('watchlistInput').focus();
  });

  document.getElementById('confirmAddSymbol').addEventListener('click', async () => {
    const sym = document.getElementById('watchlistInput').value.trim().toUpperCase();
    if (!sym) return;
    if (state.watchlist.includes(sym)) {
      document.getElementById('watchlistInput').value = '';
      return;
    }
    state.watchlist.push(sym);
    saveWatchlist();
    document.getElementById('watchlistInput').value = '';
    document.getElementById('addSymbolForm').style.display = 'none';
    loadWatchlist();
  });

  document.getElementById('cancelAddSymbol').addEventListener('click', () => {
    document.getElementById('addSymbolForm').style.display = 'none';
    document.getElementById('watchlistInput').value = '';
  });

  document.getElementById('watchlistInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('confirmAddSymbol').click();
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

function init() {
  updateMarketStatus();
  setInterval(updateMarketStatus, 60000);
  setupNav();
  setupSearch();
  loadFeed();
}

document.addEventListener('DOMContentLoaded', init);
