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

  const liveBadge = document.getElementById('liveBadge');
  if (liveBadge) liveBadge.style.display = isOpen ? 'flex' : 'none';
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

// ─── SKELETON CARD ────────────────────────────────────────────────────────────

function buildSkeletonCard() {
  const div = document.createElement('div');
  div.className = 'stock-card card-skeleton';
  div.innerHTML = `
    <div class="card-top-row">
      <div class="card-left">
        <div class="skel skel-sym"></div>
        <div class="skel skel-price"></div>
        <div class="skel skel-change"></div>
      </div>
      <div class="card-gauge-wrap">
        <div class="gauge-skeleton"></div>
        <div class="skel skel-label"></div>
      </div>
    </div>
    <div class="skel skel-badge" style="margin-top:10px;"></div>
    <div class="skel skel-chart" style="margin-top:12px;"></div>
    <div class="skel skel-bar"   style="margin-top:10px;"></div>
    <div class="card-bottom-stats" style="margin-top:10px;">
      <div class="skel skel-stat"></div>
      <div class="skel skel-stat"></div>
      <div class="skel skel-stat"></div>
    </div>
  `;
  return div;
}

// ─── STOCK CARD COMPONENT ─────────────────────────────────────────────────────

function computeSmartScore(ratings) {
  if (!ratings || ratings.total === 0) return null;
  const { strongBuy, buy, hold, sell, strongSell, total } = ratings;
  const weighted = (strongBuy * 10 + buy * 7.5 + hold * 5 + sell * 2.5 + strongSell * 0) / total;
  return Math.max(1, Math.min(10, Math.round(weighted)));
}

function buildGaugeSVG(score) {
  const r = 15.9155;
  const circ = 100; // 2π * 15.9155 ≈ 100
  const pct  = score != null ? (score / 10) * circ : 0;
  const gap  = circ - pct;
  const scoreCls = score == null ? 'score-empty'
                 : score >= 7   ? 'score-high'
                 : score >= 4   ? 'score-mid'
                 :                'score-low';
  return `
    <svg class="smart-gauge" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
      <circle class="gauge-track" cx="18" cy="18" r="${r}"/>
      <circle class="gauge-fill ${scoreCls}" cx="18" cy="18" r="${r}"
        stroke-dasharray="${pct.toFixed(1)} ${gap.toFixed(1)}"
        stroke-dashoffset="25"/>
      <text class="gauge-num ${scoreCls}" x="18" y="18">
        ${score != null ? score : '—'}
      </text>
    </svg>
    <div class="gauge-label">Smart Score</div>`;
}

function buildConsensusBadge(consensus) {
  const map = {
    'Strong Buy':  { cls: 'strong-buy',  label: 'Strong Buy'  },
    'Buy':         { cls: 'buy',         label: 'Buy'         },
    'Hold':        { cls: 'hold',        label: 'Hold'        },
    'Sell':        { cls: 'sell',        label: 'Sell'        },
    'Strong Sell': { cls: 'strong-sell', label: 'Strong Sell' },
  };
  const m = map[consensus] || map['Hold'];
  return `<span class="consensus-badge ${m.cls}">
    <span class="badge-dot"></span>${m.label}
  </span>`;
}

function buildPriceTargetBar(priceTarget, currentPrice) {
  if (!priceTarget) return '';
  const { targetLow, targetHigh, targetMedian } = priceTarget;
  if (!targetLow || !targetHigh || targetHigh <= targetLow) return '';

  const range = targetHigh - targetLow;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const currentPct = clamp(((currentPrice - targetLow) / range) * 100, 2, 98);
  const medianPct  = clamp(((targetMedian - targetLow)  / range) * 100, 2, 98);

  const upside = currentPrice > 0 ? ((targetMedian - currentPrice) / currentPrice) * 100 : 0;
  const upsideStr = (upside >= 0 ? '+' : '') + upside.toFixed(1) + '%';
  const upsideCls = upside >= 0 ? 'up' : 'down';

  return `
    <div class="pt-section">
      <div class="pt-label-row">
        <span class="pt-label-text">Price Targets</span>
        <span class="pt-upside ${upsideCls}">${upsideStr} to median</span>
      </div>
      <div class="pt-bar-track">
        <div class="pt-range-fill"></div>
        <div class="pt-median-line" style="left:${medianPct.toFixed(1)}%"></div>
        <div class="pt-current-dot" style="left:${currentPct.toFixed(1)}%"></div>
      </div>
      <div class="pt-endpoints">
        <span>$${fmt(targetLow)}</span>
        <span>$${fmt(targetMedian)}</span>
        <span>$${fmt(targetHigh)}</span>
      </div>
    </div>`;
}

function fmtVol(v) {
  if (!v) return '--';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v;
}

function buildCard(symbol, snap) {
  const price     = snap?.latestTrade?.p || snap?.latestQuote?.ap || 0;
  const prevClose = snap?.prevDailyBar?.c || 0;
  const change    = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;
  const isUp      = change >= 0;
  const vol       = snap?.dailyBar?.v  || 0;
  const high      = snap?.dailyBar?.h  || 0;
  const low       = snap?.dailyBar?.l  || 0;

  const div = document.createElement('div');
  div.className = 'stock-card';
  div.dataset.symbol = symbol;
  div.dataset.price  = price.toString();

  div.innerHTML = `
    <div class="card-top-row">
      <div class="card-left">
        <div class="card-symbol">${symbol}</div>
        <div class="card-price">$${fmt(price)}</div>
        <div class="card-change ${cls(change)}">${isUp ? '+' : ''}${fmt(change)} (${isUp ? '+' : ''}${fmt(Math.abs(changePct))}%)</div>
      </div>
      <div class="card-gauge-wrap">
        <div class="gauge-skeleton"></div>
        <div class="gauge-label">Smart Score</div>
      </div>
    </div>

    <div class="consensus-badge-wrap"></div>

    <div class="mini-chart"><canvas></canvas></div>

    <div class="pt-section-wrap"></div>

    <div class="card-bottom-stats">
      <div class="card-stat">
        <label>Volume</label>
        <span>${fmtVol(vol)}</span>
      </div>
      <div class="card-stat">
        <label>Day High</label>
        <span>${high ? '$' + fmt(high) : '--'}</span>
      </div>
      <div class="card-stat">
        <label>Day Low</label>
        <span>${low ? '$' + fmt(low) : '--'}</span>
      </div>
    </div>
  `;

  div.addEventListener('click', () => openDetail(symbol, snap));
  return div;
}

async function fetchStockAnalysis(symbol) {
  try {
    const r = await fetch(`/api/stock/${symbol}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function loadFMPCard(symbol, cardEl) {
  const data = await fetchStockAnalysis(symbol);
  if (!data) return;

  const currentPrice = parseFloat(cardEl.dataset.price || '0');

  // Smart Score gauge
  const gaugeWrap = cardEl.querySelector('.card-gauge-wrap');
  if (gaugeWrap) {
    const score = computeSmartScore(data.ratings);
    gaugeWrap.innerHTML = buildGaugeSVG(score);
  }

  // Consensus badge
  const badgeWrap = cardEl.querySelector('.consensus-badge-wrap');
  if (badgeWrap && data.ratings?.consensus) {
    badgeWrap.innerHTML = buildConsensusBadge(data.ratings.consensus);
  }

  // Price target bar
  const ptWrap = cardEl.querySelector('.pt-section-wrap');
  if (ptWrap && data.priceTarget) {
    ptWrap.innerHTML = buildPriceTargetBar(data.priceTarget, currentPrice);
  }
}

function revealCard(card, delayMs) {
  card.style.animationDelay = `${delayMs}ms`;
  card.classList.add('card-reveal');
}

async function loadFeed() {
  const grid = document.getElementById('feedGrid');

  // 1. Show skeleton placeholders immediately
  grid.innerHTML = '';
  FEED_SYMBOLS.forEach(() => grid.appendChild(buildSkeletonCard()));

  // 2. Fetch live data
  const snaps = await fetchSnapshots(FEED_SYMBOLS);
  state.snapshots = snaps;

  if (!snaps || Object.keys(snaps).length === 0) {
    grid.innerHTML = '<div class="loading-state"><p>Unable to load market data. Check API keys.</p></div>';
    return;
  }

  // 3. Replace skeletons with real cards, staggered fade-in
  grid.innerHTML = '';
  const cards = [];
  FEED_SYMBOLS.forEach((sym, i) => {
    const snap = snaps[sym];
    if (!snap) return;
    const card = buildCard(sym, snap);
    revealCard(card, i * 40); // 40ms stagger per card
    grid.appendChild(card);
    cards.push({ sym, card });
  });

  updateTickerStrip(snaps);

  // 4. Load mini charts
  cards.forEach(({ sym, card }) => {
    loadMiniChart(sym, card.querySelector('.mini-chart'));
  });

  // 5. Load FMP data in batches of 5
  const BATCH = 5;
  for (let i = 0; i < cards.length; i += BATCH) {
    const batch = cards.slice(i, i + BATCH);
    batch.forEach(({ sym, card }) => loadFMPCard(sym, card));
    if (i + BATCH < cards.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
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
  const panelEl      = document.getElementById('detailPanel');
  const panelContent = document.getElementById('panelContent');
  const backdrop     = document.getElementById('panelBackdrop');

  // Slide panel in (mobile overlay)
  panelEl.classList.add('open');
  if (backdrop) backdrop.classList.add('visible');
  document.getElementById('panelClose').style.display = 'flex';

  const price = snap?.latestTrade?.p || snap?.latestQuote?.ap || 0;
  const prev  = snap?.prevDailyBar?.c || 0;
  const change = price - prev;
  const pct    = prev ? (change / prev) * 100 : 0;
  const isUp   = change >= 0;
  const high   = snap?.dailyBar?.h  || 0;
  const low    = snap?.dailyBar?.l  || 0;
  const open   = snap?.dailyBar?.o  || 0;
  const vol    = snap?.dailyBar?.v  || 0;

  panelContent.innerHTML = `
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
      <div class="panel-stat"><label>Volume</label><span>${fmtVol(vol)}</span></div>
      <div class="panel-stat"><label>VWAP</label><span>$${fmt(snap?.dailyBar?.vw)}</span></div>
    </div>
    <div class="panel-actions">
      <button class="panel-btn gold" onclick="openModal('${symbol}')">Full Chart</button>
      <button class="panel-btn outline" onclick="toggleWatchlist('${symbol}')">
        ${state.watchlist.includes(symbol) ? '★ Watchlist' : '☆ Watch'}
      </button>
    </div>

    <div class="panel-section-title">Analyst Ratings</div>
    <div id="panelAnalyst"><div class="panel-loading-sm"></div></div>

    <div class="panel-section-title">Price Targets</div>
    <div id="panelPriceTargets"><div class="panel-loading-sm"></div></div>

    <div class="panel-section-title">Upgrades &amp; Downgrades</div>
    <div id="panelUpgrades"><div class="panel-loading-sm"></div></div>

    <div class="panel-section-title">Recent News</div>
    <div class="panel-news" id="panelNews"><div class="panel-loading-sm"></div></div>
  `;

  // Fetch chart, FMP analyst data, and news all in parallel
  const [chartData, fmpData, news] = await Promise.all([
    fetchBars(symbol, '1Hour', 48),
    fetchStockAnalysis(symbol),
    fetchNews(symbol),
  ]);

  // Chart
  const pCanvas = document.getElementById('panelChartCanvas');
  if (pCanvas && chartData?.bars) {
    pCanvas.style.height = '120px';
    drawFullChart(pCanvas, chartData.bars, isUp ? '#22c55e' : '#ef4444');
  }

  // Analyst ratings bar
  const analystEl = document.getElementById('panelAnalyst');
  if (analystEl) {
    analystEl.innerHTML = fmpData?.ratings
      ? buildAnalystBar(fmpData.ratings)
      : '<p class="panel-no-data">No analyst data available</p>';
  }

  // Price targets
  const ptEl = document.getElementById('panelPriceTargets');
  if (ptEl) {
    ptEl.innerHTML = fmpData?.priceTarget
      ? buildPtStatBoxes(fmpData.priceTarget, price)
      : '<p class="panel-no-data">No price target data available</p>';
  }

  // Upgrades / downgrades
  const upgradesEl = document.getElementById('panelUpgrades');
  if (upgradesEl) {
    upgradesEl.innerHTML = fmpData?.upgrades?.length
      ? buildUpgradesList(fmpData.upgrades.slice(0, 5))
      : '<p class="panel-no-data">No recent rating changes</p>';
  }

  // News
  const newsEl = document.getElementById('panelNews');
  if (newsEl) {
    if (!news.length) {
      newsEl.innerHTML = '<p class="panel-no-data">No recent news found.</p>';
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
  const panelEl  = document.getElementById('detailPanel');
  const backdrop = document.getElementById('panelBackdrop');
  panelEl.classList.remove('open');
  if (backdrop) backdrop.classList.remove('visible');
  document.getElementById('panelClose').style.display = 'none';
  document.getElementById('panelContent').innerHTML = `
    <div class="panel-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      <p>Select a stock to view details</p>
    </div>
  `;
  state.currentSymbol = null;
}

// ─── PANEL BUILDER HELPERS ────────────────────────────────────────────────────

function buildAnalystBar(ratings) {
  const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0, total = 0 } = ratings;
  if (total === 0) return '<p class="panel-no-data">No analyst rating data</p>';

  const pct = n => ((n / total) * 100).toFixed(1);
  const segments = [
    { cls: 'strong-buy',  count: strongBuy,  label: 'Strong Buy'  },
    { cls: 'buy',         count: buy,         label: 'Buy'         },
    { cls: 'hold',        count: hold,        label: 'Hold'        },
    { cls: 'sell',        count: sell,        label: 'Sell'        },
    { cls: 'strong-sell', count: strongSell,  label: 'Strong Sell' },
  ].filter(s => s.count > 0);

  const barSegs = segments
    .map(s => `<div class="analyst-bar-seg ${s.cls}" style="width:${pct(s.count)}%"></div>`)
    .join('');

  const legend = segments
    .map(s => `
      <div class="analyst-legend-item">
        <span class="al-dot ${s.cls}"></span>
        <span class="al-count">${s.count}</span>
        <span>${s.label}</span>
      </div>`)
    .join('');

  return `
    <div class="analyst-bar-wrap">
      <div class="analyst-bar">${barSegs}</div>
      <div class="analyst-legend">${legend}</div>
    </div>`;
}

function buildPtStatBoxes(priceTarget, currentPrice) {
  const { targetLow, targetMedian, targetHigh } = priceTarget;
  if (!targetMedian) return '<p class="panel-no-data">No price target data</p>';

  const upside = currentPrice > 0 ? ((targetMedian - currentPrice) / currentPrice) * 100 : 0;
  const upsideCls = upside >= 0 ? 'up' : 'down';
  const upsideStr = (upside >= 0 ? '+' : '') + upside.toFixed(1) + '%';

  return `
    <div class="pt-stat-boxes">
      <div class="pt-stat-box">
        <label>Low</label>
        <div class="pt-val">$${fmt(targetLow)}</div>
      </div>
      <div class="pt-stat-box median">
        <label>Median</label>
        <div class="pt-val">$${fmt(targetMedian)}</div>
      </div>
      <div class="pt-stat-box">
        <label>High</label>
        <div class="pt-val">$${fmt(targetHigh)}</div>
      </div>
    </div>
    <p class="pt-upside-note">
      <strong class="${upsideCls}">${upsideStr}</strong> upside to analyst median
    </p>`;
}

function ratingBadgeClass(ratingStr) {
  if (!ratingStr) return 'neutral';
  const r = ratingStr.toLowerCase();
  if (r.includes('strong buy') || r === 'strong_buy') return 'strong-buy';
  if (r.includes('buy') || r === 'overweight' || r === 'outperform' || r === 'accumulate') return 'buy';
  if (r.includes('strong sell') || r === 'strong_sell') return 'strong-sell';
  if (r.includes('sell') || r === 'underweight' || r === 'underperform') return 'sell';
  if (r.includes('hold') || r === 'neutral' || r === 'market perform' || r === 'equal weight' || r === 'in-line') return 'hold';
  return 'neutral';
}

function buildUpgradesList(upgrades) {
  if (!upgrades || upgrades.length === 0) return '<p class="panel-no-data">No recent changes</p>';
  return `<div class="upgrades-list">` + upgrades.map(u => {
    const prevCls = ratingBadgeClass(u.previousGrade || u.previousRating);
    const newCls  = ratingBadgeClass(u.newGrade || u.newRating);
    const firm    = u.gradingCompany || u.firm || 'Unknown';
    const prev    = u.previousGrade || u.previousRating || '—';
    const next    = u.newGrade      || u.newRating      || '—';
    const date    = u.date ? new Date(u.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    return `
      <div class="upgrade-item">
        <div class="upgrade-top">
          <span class="upgrade-firm">${firm}</span>
          <span class="upgrade-date">${date}</span>
        </div>
        <div class="upgrade-bottom">
          <span class="upgrade-badge ${prevCls}">${prev}</span>
          <span class="upgrade-arrow">→</span>
          <span class="upgrade-badge ${newCls}">${next}</span>
        </div>
      </div>`;
  }).join('') + `</div>`;
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

// ─── FEED SEARCH ──────────────────────────────────────────────────────────────

function setupFeedSearch() {
  const input  = document.getElementById('feedSearch');
  const btn    = document.getElementById('feedSearchBtn');
  const msg    = document.getElementById('feedSearchMsg');
  if (!input || !btn || !msg) return;

  async function addTickerToFeed() {
    const sym = input.value.trim().toUpperCase().replace(/[^A-Z.]/g, '');
    if (!sym) return;

    // Prevent duplicate (skip if already in feed)
    const grid = document.getElementById('feedGrid');
    if (grid.querySelector(`.stock-card[data-symbol="${sym}"]`)) {
      msg.textContent = `${sym} is already in your feed`;
      msg.className   = 'feed-search-msg info';
      setTimeout(() => { msg.textContent = ''; msg.className = 'feed-search-msg'; }, 2500);
      input.value = '';
      return;
    }

    // Show loading state
    btn.classList.add('loading');
    msg.textContent = `Fetching ${sym}…`;
    msg.className   = 'feed-search-msg info';

    // Insert skeleton at the top first
    const skeleton = buildSkeletonCard();
    grid.prepend(skeleton);

    try {
      const res   = await fetch(`/api/quote/${sym}`);
      const data  = await res.json();
      const snap  = data?.snapshot || data;

      if (!snap || (!snap.latestTrade && !snap.latestQuote)) {
        throw new Error('Not found');
      }

      // Replace skeleton with real card
      const card = buildCard(sym, snap);
      revealCard(card, 0);
      grid.replaceChild(card, skeleton);

      // Update local state
      if (!state.snapshots) state.snapshots = {};
      state.snapshots[sym] = snap;

      // Load chart + FMP data
      loadMiniChart(sym, card.querySelector('.mini-chart'));
      loadFMPCard(sym, card);

      msg.textContent = `${sym} added to your feed`;
      msg.className   = 'feed-search-msg success';
      input.value = '';
      setTimeout(() => { msg.textContent = ''; msg.className = 'feed-search-msg'; }, 3000);

    } catch {
      grid.removeChild(skeleton);
      msg.textContent = `Couldn't find "${sym}" — check the ticker symbol`;
      msg.className   = 'feed-search-msg error';
      setTimeout(() => { msg.textContent = ''; msg.className = 'feed-search-msg'; }, 3500);
    }

    btn.classList.remove('loading');
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') addTickerToFeed();
  });

  btn.addEventListener('click', addTickerToFeed);
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
  document.getElementById('panelBackdrop').addEventListener('click', closePanel);

  document.getElementById('refreshFeed').addEventListener('click', loadFeed);

  // ── Feed search: add a ticker to the top of the feed ──────────────────────
  setupFeedSearch();

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
