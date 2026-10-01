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
  forecastSelection: null,
};
// The AI assistant is loaded as a separate browser module and reads the live
// session context through this explicit bridge.
window.state = state;

// ── utils ──────────────────────────────────────────────────────────────────────
const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtV = v => { if(!v) return '--'; if(v>=1e9) return (v/1e9).toFixed(1)+'B'; if(v>=1e6) return (v/1e6).toFixed(1)+'M'; if(v>=1e3) return (v/1e3).toFixed(0)+'K'; return String(v); };
const cls  = v => v >= 0 ? 'up' : 'down';
const escapeHtml = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const $    = id => document.getElementById(id);

// ── Theme ─────────────────────────────────────────────────────────────────────
const THEME_KEY = 'jqf-theme';

function applyTheme(theme, persist = true) {
  const nextTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;

  if (persist) {
    try { localStorage.setItem(THEME_KEY, nextTheme); } catch {}
  }

  const toggle = $('themeToggle');
  if (toggle) {
    const light = nextTheme === 'light';
    toggle.setAttribute('aria-pressed', String(light));
    toggle.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
    toggle.setAttribute('title', light ? 'Switch to dark mode' : 'Switch to light mode');
  }

  document.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: nextTheme } }));
}

function setupThemeToggle() {
  const toggle = $('themeToggle');
  if (!toggle) return;

  let savedTheme = document.documentElement.dataset.theme || 'dark';
  try {
    const storedTheme = localStorage.getItem(THEME_KEY);
    if (storedTheme === 'light' || storedTheme === 'dark') savedTheme = storedTheme;
  } catch {}

  applyTheme(savedTheme, false);
  toggle.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
  });
}

// ── Auth API ────────────────────────────────────────────────────────────────────
const authAPI = {
  async me()          { try { const r=await fetch('/api/auth/me'); return r.ok ? r.json() : null; } catch { return null; } },
  async login(u,p)    { try { const r=await fetch('/api/auth/login',    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}); return {ok:r.ok,data:await r.json()}; } catch { return {ok:false,data:{error:'Network error — please try again.'}}; } },
  async register(u,p,email) { try { const r=await fetch('/api/auth/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p,email})}); return {ok:r.ok,data:await r.json()}; } catch { return {ok:false,data:{error:'Network error — please try again.'}}; } },
  async resendVerification(email) { try { const r=await fetch('/api/auth/resend-verification', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(email?{email}:{})}); return {ok:r.ok,data:await r.json()}; } catch { return {ok:false}; } },
  async logout()      { try { await fetch('/api/auth/logout', {method:'POST'}); } catch {} },
};

// ── Watchlist API ───────────────────────────────────────────────────────────────
const wlAPI = {
  // One-shot wipe-recovery flag. If the server list is empty but this device
  // remembers symbols (a deploy wiped the server-side list before the volume
  // fix), push the remembered list up once so the account keeps it. After
  // that the server is the source of truth, so an intentional delete on
  // another device is never resurrected twice.
  _didWipeRecovery: false,
  async load() {
    try {
      const r = await fetch('/api/watchlist');
      if (!r.ok) return;
      const d = await r.json();
      const server = d.watchlist || [];
      if (!server.length && state.watchlist.length && !this._didWipeRecovery) {
        this._didWipeRecovery = true;
        for (const sym of state.watchlist) {
          try { await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym }) }); } catch (_) {}
        }
        try {
          const r2 = await fetch('/api/watchlist');
          if (r2.ok) { const d2 = await r2.json(); state.watchlist = d2.watchlist || []; }
        } catch (_) {}
        return;
      }
      state.watchlist = server;
    } catch (_) {}
  },
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
  async marketAlerts() {
    try {
      const r = await fetch('/api/market-alerts', { credentials: 'include' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
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
  async forecast(sym, lookback = 90, horizon = 30) {
    try {
      const r = await fetch(`/api/forecast/${encodeURIComponent(sym)}?lookback=${lookback}&horizon=${horizon}`);
      return r.ok ? r.json() : null;
    } catch { return null; }
  },
  async wsb() {
    try { const r = await fetch('/api/wsb'); return r.ok ? r.json() : null; } catch { return null; }
  },
};

// One authoritative Search-page analysis request shared by every panel.
// This prevents quote/signal/news panels from rendering different generations.
window.searchContext = (() => {
  const cache = new Map();
  const inflight = new Map();
  async function load(symbol, { force = false } = {}) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!sym) throw new Error('Symbol required');
    if (force) cache.delete(sym);
    const cached = cache.get(sym);
    const maxAge = Number(cached?.data?.freshness?.maxAgeMs) || 60_000;
    if (!force && cached && Date.now() - cached.at < maxAge) return cached.data;
    if (inflight.has(sym)) return inflight.get(sym);
    const request = fetch(`/api/gameplan/${encodeURIComponent(sym)}${force ? '?force=1' : ''}`, {
      credentials: 'same-origin',
    }).then(async response => {
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || 'Verified Search data unavailable');
      // Preserve the server generation age. A newly opened tab must not grant
      // an already-cached market snapshot a fresh client-side TTL.
      const generatedAt = Date.parse(data.generatedAt);
      cache.set(sym, { at: Number.isFinite(generatedAt) ? generatedAt : Date.now(), data });
      return data;
    }).finally(() => inflight.delete(sym));
    inflight.set(sym, request);
    return request;
  }
  return { load, invalidate: symbol => cache.delete(String(symbol || '').toUpperCase()) };
})();

// ── Breaking market-news band ─────────────────────────────────────────────────
const marketAlerts = (() => {
  const DISMISSED_KEY = 'jqf-dismissed-market-alerts';
  const POLL_MS = 5 * 60 * 1000;
  let timer = null;
  let currentFingerprint = '';
  let requestInFlight = false;

  function readDismissed() {
    try { return localStorage.getItem(DISMISSED_KEY) || ''; } catch { return ''; }
  }

  function setDismissed(value) {
    try { localStorage.setItem(DISMISSED_KEY, value); } catch {}
  }

  function hide() {
    const bar = $('marketAlertBar');
    if (bar) {
      bar.classList.remove('is-visible');
      bar.setAttribute('aria-hidden', 'true');
    }
  }

  function render(alerts) {
    const bar = $('marketAlertBar');
    const viewport = $('marketAlertViewport');
    const track = $('marketAlertTrack');
    if (!bar || !viewport || !track || !alerts?.length) {
      hide();
      return;
    }

    currentFingerprint = alerts.map(alert => alert.id).join('|');
    if (readDismissed() === currentFingerprint) {
      hide();
      return;
    }

    const items = alerts.map(alert => {
      const safeUrl = /^https?:\/\//i.test(String(alert.url || '')) ? alert.url : '';
      const content = `
        <span class="market-alert-headline">${escapeHtml(alert.headline)}</span>
        <span class="market-alert-source">${escapeHtml(alert.source || 'Market news')} · ${timeAgo(alert.publishedAt)}</span>`;
      return safeUrl
        ? `<a class="market-alert-item" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${content}</a>`
        : `<span class="market-alert-item">${content}</span>`;
    }).join('<span class="market-alert-separator" aria-hidden="true">•</span>');

    const group = `<div class="market-alert-group">${items}</div>`;
    track.innerHTML = `${group}<div class="market-alert-group market-alert-group-copy" aria-hidden="true">${items}</div>`;
    bar.classList.add('is-visible');
    bar.setAttribute('aria-hidden', 'false');

    requestAnimationFrame(() => {
      const groups = track.querySelectorAll('.market-alert-group');
      const needsScroll = groups.length > 1 && groups[0].scrollWidth > viewport.clientWidth;
      track.classList.toggle('is-scrollable', needsScroll);
      if (!needsScroll) groups[1]?.remove();
    });
  }

  async function refresh() {
    if (requestInFlight) return;
    requestInFlight = true;
    try {
      const data = await api.marketAlerts();
      render(data?.alerts || []);
    } finally {
      requestInFlight = false;
    }
  }

  function start() {
    clearInterval(timer);
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    currentFingerprint = '';
    hide();
  }

  function setup() {
    $('marketAlertClose')?.addEventListener('click', () => {
      if (currentFingerprint) setDismissed(currentFingerprint);
      hide();
    });
  }

  return { setup, start, stop };
})();

function renderStockHeader(sym, snap) {
  const price = snap?.price || 0;
  const prev = snap?.previousClose || 0;
  // One authoritative reference close: premarket anchors to the prior close
  // (regularMarketPrice can go stale before the open); otherwise the regular close.
  const refClose = snap?.extendedType === 'PRE'
    ? (snap?.previousClose ?? snap?.regularClose)
    : snap?.regularClose;
  $('sTicker').textContent = sym;
  $('sName').textContent = snap?.name || '';
  const displayPrice = refClose ?? price;
  const displayChg = displayPrice - prev;
  const displayPct = prev ? (displayChg / prev) * 100 : 0;
  const displayUp = displayChg >= 0;
  $('sPrice').textContent = displayPrice ? '$' + fmt(displayPrice) : '--';
  const sc = $('sChange');
  sc.textContent = displayPrice && prev
    ? `${displayUp ? '+' : ''}${fmt(displayChg)} (${displayUp ? '+' : ''}${fmt(displayPct)}%)${snap?.changeWindow === '24H' ? ' · 24H' : ''}`
    : '';
  sc.className = 's-change ' + (displayUp ? 'up' : 'down');

  const extRow = $('sExtRow');
  if (extRow && snap?.extendedPrice) {
    const ep = snap.extendedPrice;
    const base = refClose ?? price;
    const ec = base ? ep - base : 0;
    const epct = base ? (ec / base) * 100 : 0;
    const eup = ec >= 0;
    const extType = snap.extendedType || 'EXT';
    $('sExtBadge').textContent = extType === 'OVERNIGHT' ? 'Overnight' : extType;
    $('sExtBadge').className = 's-ext-badge ' + (extType === 'PRE' ? 'pre' : extType === 'OVERNIGHT' ? 'ovn' : 'post');
    $('sExtPrice').textContent = '$' + fmt(ep);
    $('sExtChange').textContent = `${eup ? '+' : ''}${fmt(ec)} (${eup ? '+' : ''}${fmt(epct)}%)`;
    $('sExtChange').className = 's-ext-change ' + (eup ? 'up' : 'down');
    extRow.style.display = '';
  } else if (extRow) {
    extRow.style.display = 'none';
  }
}

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
function drawChart(canvas, bars, color, h=300, smartMoney=null, showAllZones=false) {
  if (!canvas || !bars?.length) return;
  const ctx = canvas.getContext('2d');
  const isLight = document.documentElement.dataset.theme === 'light';
  const w = canvas.clientWidth || canvas.offsetWidth || canvas.parentElement?.clientWidth - 40 || 640;
  const cleanBars = bars.filter(bar => [bar?.h, bar?.l, bar?.c].every(value => Number.isFinite(Number(value))));
  if (!cleanBars.length) return;

  // Render at device resolution so small axis labels stay crisp on mobile.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const prices = cleanBars.map(bar => Number(bar.c));
  const lows = cleanBars.map(bar => Number(bar.l));
  const highs = cleanBars.map(bar => Number(bar.h));
  const rawMin = Math.min(...prices, ...lows);
  const rawMax = Math.max(...prices, ...highs);
  const rawRange = Math.max(rawMax - rawMin, prices.at(-1) * 0.002, 0.01);

  // Search-only Smart Money overlays. They remain supporting context and never
  // alter the Search verdict or any trading decision.
  const mapZones = (Array.isArray(smartMoney?.zones) ? smartMoney.zones : [])
    .filter(zone => zone?.status !== 'INVALIDATED'
      && Number.isFinite(Number(zone.low)) && Number.isFinite(Number(zone.high)))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const latestPrice = prices.at(-1);
  const contextDistance = Math.max(rawRange * 1.75, latestPrice * 0.18);
  const nearbyCandidates = mapZones.filter(zone => {
    const midpoint = (Number(zone.low) + Number(zone.high)) / 2;
    return Math.abs(midpoint - latestPrice) <= contextDistance;
  });
  // The default view is intentionally calm: show the strongest nearby buyer
  // and seller area. "All zones" remains available for deeper inspection.
  const nearbyZones = showAllZones
    ? nearbyCandidates
    : [
      nearbyCandidates.find(zone => zone.type === 'DEMAND'),
      nearbyCandidates.find(zone => zone.type === 'SUPPLY'),
    ].filter(Boolean);
  const visibleZoneBounds = nearbyZones.flatMap(zone => [Number(zone.low), Number(zone.high)]);
  const scaleMin = Math.min(rawMin, ...visibleZoneBounds);
  const scaleMax = Math.max(rawMax, ...visibleZoneBounds);
  const scaleRange = Math.max(scaleMax - scaleMin, 0.01);
  const min = scaleMin - scaleRange * 0.035;
  const max = scaleMax + scaleRange * 0.035;
  const range = max - min || 1;
  const pad = { t: 24, r: 22, b: 52, l: 78 };
  const volumeHeight = 44;
  const volumeGap = 12;
  const priceBottom = h - pad.b - volumeHeight - volumeGap;
  const cw = w - pad.l - pad.r;
  const ch = priceBottom - pad.t;
  const sx = cleanBars.length > 1 ? cw / (cleanBars.length - 1) : cw;
  const xForIndex = index => pad.l + index * sx;
  const yForPrice = value => pad.t + ch - ((value - min) / range) * ch;
  ctx.clearRect(0, 0, w, h);

  // Give the price and volume panes distinct surfaces so the chart reads as a
  // composed panel instead of a collection of floating lines.
  ctx.fillStyle = isLight ? 'rgba(255,255,255,.96)' : 'rgba(5, 14, 28, .72)';
  ctx.fillRect(pad.l, pad.t, cw, ch);
  ctx.fillStyle = isLight ? 'rgba(238,243,248,.96)' : 'rgba(2, 8, 18, .58)';
  ctx.fillRect(pad.l, priceBottom + volumeGap, cw, volumeHeight);

  // Grid and price axis.
  ctx.strokeStyle = 'rgba(105, 132, 171, .18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + (ch / 4) * i;
    const value = max - (range / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = isLight ? '#475467' : '#91a5c4';
    ctx.font = '600 10px Inter';
    ctx.textAlign = 'right';
    ctx.fillText('$' + fmt(value), pad.l - 10, y + 3);
  }
  ctx.strokeStyle = 'rgba(145, 165, 196, .24)';
  ctx.beginPath();
  ctx.moveTo(pad.l, priceBottom + volumeGap / 2);
  ctx.lineTo(w - pad.r, priceBottom + volumeGap / 2);
  ctx.stroke();

  // Draw the zones first so the candles remain the most legible layer.
  const visibleZones = nearbyZones
    .filter(zone => Number(zone.high) >= min && Number(zone.low) <= max)
    .sort((a, b) => Number(a.low) - Number(b.low));
  let previousLabelBottom = -Infinity;
  visibleZones.forEach(zone => {
    const demand = zone.type === 'DEMAND';
    const top = yForPrice(Math.min(max, Number(zone.high)));
    const bottom = yForPrice(Math.max(min, Number(zone.low)));
    const zoneHeight = Math.max(8, bottom - top);
    const zoneColor = demand ? '#00f5ad' : '#ff3f5f';
    ctx.save();
    const zoneGradient = ctx.createLinearGradient(pad.l, top, w - pad.r, bottom);
    if (demand) {
      zoneGradient.addColorStop(0, 'rgba(0,245,173,.30)');
      zoneGradient.addColorStop(1, 'rgba(0,154,132,.12)');
    } else {
      zoneGradient.addColorStop(0, 'rgba(255,63,95,.30)');
      zoneGradient.addColorStop(1, 'rgba(170,25,65,.12)');
    }
    ctx.fillStyle = zoneGradient;
    ctx.strokeStyle = demand ? 'rgba(0,245,173,.92)' : 'rgba(255,63,95,.92)';
    ctx.shadowColor = demand ? 'rgba(0,245,173,.28)' : 'rgba(255,63,95,.28)';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 1.75;
    ctx.fillRect(pad.l, top, cw, zoneHeight);
    ctx.strokeRect(pad.l, top, cw, zoneHeight);
    ctx.shadowBlur = 0;
    ctx.fillStyle = zoneColor;
    ctx.fillRect(pad.l, top, 5, zoneHeight);
    ctx.font = '800 10px Inter';
    ctx.textAlign = 'left';
    const zoneText = `${demand ? 'BUYERS' : 'SELLERS'}  ·  ${zone.score || 0}`;
    const labelWidth = Math.min(cw - 12, ctx.measureText(zoneText).width + 14);
    let labelY = Math.max(pad.t + 3, Math.min(priceBottom - 19, top + 4));
    if (labelY < previousLabelBottom + 3) {
      labelY = Math.min(priceBottom - 19, previousLabelBottom + 3);
    }
    if (labelY > bottom - 19 && zoneHeight >= 20) labelY = Math.max(pad.t + 3, bottom - 19);
    previousLabelBottom = labelY + 17;
    ctx.fillStyle = isLight
      ? (demand ? 'rgba(236,253,245,.96)' : 'rgba(255,241,242,.96)')
      : (demand ? 'rgba(1,46,40,.96)' : 'rgba(72,10,28,.96)');
    ctx.strokeStyle = demand ? 'rgba(0,245,173,.6)' : 'rgba(255,63,95,.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(pad.l + 8, labelY, labelWidth, 17, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isLight ? (demand ? '#05603f' : '#b42318') : '#ffffff';
    ctx.fillText(zoneText, pad.l + 15, labelY + 12);
    ctx.restore();
  });

  const referenceItems = [];
  const drawReference = (price, lineColor, dash, label) => {
    const value = Number(price);
    if (!Number.isFinite(value) || value < min || value > max) return;
    referenceItems.push({ value, lineColor, dash, label, y: yForPrice(value) });
  };
  const drawReferences = () => {
    const labelGap = 17;
    const labelTop = pad.t + 10;
    const labelBottom = priceBottom - 5;
    const labels = [...referenceItems].sort((a, b) => a.y - b.y);
    let nextLabelY = labelTop;
    labels.forEach(item => {
      item.labelY = Math.max(item.y - 5, nextLabelY);
      nextLabelY = item.labelY + labelGap;
    });
    if (labels.length && nextLabelY > labelBottom) {
      let previous = labelBottom - (labels.length - 1) * labelGap;
      labels.forEach(item => {
        item.labelY = Math.max(labelTop, previous);
        previous += labelGap;
      });
    }
    labels.forEach(item => {
      const { lineColor, dash, label, y, labelY } = item;
      ctx.save();
      ctx.setLineDash(dash);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '800 9px Inter';
      const textWidth = ctx.measureText(label).width;
      const boxX = w - pad.r - textWidth - 12;
      ctx.fillStyle = isLight ? 'rgba(255,255,255,.96)' : 'rgba(5, 12, 25, .88)';
      ctx.beginPath();
      ctx.roundRect(boxX, labelY - 9, textWidth + 10, 15, 4);
      ctx.fill();
      ctx.fillStyle = lineColor;
      ctx.textAlign = 'right';
      ctx.fillText(label, w - pad.r - 5, labelY + 2);
      ctx.restore();
    });
  };
  const liquidityLevels = [];
  const seenLiquiditySides = new Set();
  (smartMoney?.overlay?.liquidity || []).forEach(level => {
    const side = level.side || 'LEVEL';
    if (showAllZones || !seenLiquiditySides.has(side)) {
      liquidityLevels.push(level);
      seenLiquiditySides.add(side);
    }
  });
  liquidityLevels.slice(0, showAllZones ? 6 : 2)
    .forEach(level => drawReference(level.price, 'rgba(255,216,77,.95)', [5, 4], `LIQ ${level.side || ''}`.trim()));
  (smartMoney?.overlay?.swings || []).forEach(level =>
    drawReference(level.price, 'rgba(196,181,253,.95)', [2, 3], level.type === 'HIGH' ? 'SWING HIGH' : 'SWING LOW'));
  drawReferences();

  // Volume gives the zone reaction some context without mixing it into price.
  const volumes = cleanBars.map(bar => Number(bar.v)).filter(value => Number.isFinite(value) && value > 0);
  const maxVolume = Math.max(...volumes, 1);
  cleanBars.forEach((bar, index) => {
    const volume = Number(bar.v);
    if (!Number.isFinite(volume) || volume <= 0) return;
    const barHeight = Math.max(1, (volume / maxVolume) * volumeHeight);
    const x = xForIndex(index);
    ctx.fillStyle = Number(bar.c) >= Number(bar.o ?? bar.c) ? 'rgba(29,214,163,.32)' : 'rgba(232,69,69,.32)';
    ctx.fillRect(Math.max(pad.l, x - Math.max(1, sx * 0.28)), h - pad.b - barHeight, Math.max(2, sx * 0.56), barHeight);
  });
  ctx.fillStyle = isLight ? '#475467' : '#91a5c4';
  ctx.font = '600 9px Inter';
  ctx.textAlign = 'left';
  ctx.fillText('VOLUME', pad.l, h - pad.b + 16);

  // OHLC candles and a thin close trace for direction at a glance.
  const candleWidth = Math.max(2, Math.min(12, sx * 0.62));
  const closePoints = [];
  cleanBars.forEach((bar, index) => {
    const open = Number.isFinite(Number(bar.o)) ? Number(bar.o) : Number(bar.c);
    const high = Number(bar.h);
    const low = Number(bar.l);
    const close = Number(bar.c);
    const x = xForIndex(index);
    const upBar = close >= open;
    const top = yForPrice(Math.max(open, close));
    const bottom = yForPrice(Math.min(open, close));
    ctx.save();
    ctx.strokeStyle = upBar ? '#35e6b4' : '#ff6178';
    ctx.fillStyle = upBar ? 'rgba(29,214,163,.72)' : 'rgba(232,69,69,.72)';
    ctx.lineWidth = Math.max(1, Math.min(2, candleWidth / 3));
    ctx.beginPath();
    ctx.moveTo(x, yForPrice(high));
    ctx.lineTo(x, yForPrice(low));
    ctx.stroke();
    ctx.fillRect(x - candleWidth / 2, top, candleWidth, Math.max(2, bottom - top));
    ctx.restore();
    closePoints.push([x, yForPrice(close)]);
  });
  if (closePoints.length > 1) {
    ctx.save();
    ctx.strokeStyle = color + 'aa';
    ctx.lineWidth = 1;
    ctx.beginPath();
    closePoints.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke();
    ctx.restore();
  }

  // Date/time labels make the wider context navigable.
  const labelStep = Math.max(1, Math.ceil((cleanBars.length - 1) / 5));
  ctx.fillStyle = '#91a5c4';
  ctx.font = '600 9px Inter';
  ctx.textAlign = 'center';
  for (let index = 0; index < cleanBars.length; index += labelStep) {
    const timestamp = cleanBars[index]?.t;
    const date = timestamp == null ? null : new Date(
      typeof timestamp === 'number' && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
    if (!date || Number.isNaN(date.getTime())) continue;
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    ctx.fillText(label, xForIndex(index), h - 8);
  }
  const lastX = xForIndex(cleanBars.length - 1);
  const lastY = yForPrice(prices.at(-1));
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

let activeOverviewChart = null;

function chartLegendHtml() {
  return `<div class="chart-smart-legend" aria-label="Smart Money chart legend">
    <span><i class="chart-legend-candle"></i>Candles</span>
    <span><i class="chart-legend-dot buy"></i>Buyers</span>
    <span><i class="chart-legend-dot sell"></i>Sellers</span>
    <span><i class="chart-legend-line liq"></i>Liquidity</span>
  </div>`;
}

function chartZoneKeyHtml(data) {
  const zones = Array.isArray(data?.zones)
    ? data.zones.filter(zone => zone?.status !== 'INVALIDATED'
      && Number.isFinite(Number(zone.low)) && Number.isFinite(Number(zone.high)))
    : [];
  const strongest = type => zones
    .filter(zone => zone.type === type)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
  const demand = strongest('DEMAND');
  const supply = strongest('SUPPLY');
  const range = zone => zone ? `$${fmt(zone.low)} – $${fmt(zone.high)}` : 'Not detected';
  const score = zone => zone ? `Score ${zone.score || 0}` : 'No confirmed range';
  const unavailable = data && data.available === false;
  return `<div class="chart-zone-key" id="chartZoneKey">
    <div class="chart-zone-key-head">
      <div><span class="chart-zone-kicker">READ THE MAP</span><strong>Potential reaction areas</strong></div>
      <span class="chart-zone-note">${unavailable ? 'Smart Money data unavailable' : 'Supporting context · not a trade verdict'}</span>
    </div>
    <div class="chart-zone-key-grid">
      <div class="chart-zone-key-item buyer">
        <span class="chart-zone-key-label"><i></i>BUYERS <em>potential demand</em></span>
        <strong>${range(demand)}</strong>
        <small>${score(demand)} · price may find support inside this band</small>
      </div>
      <div class="chart-zone-key-item seller">
        <span class="chart-zone-key-label"><i></i>SELLERS <em>potential supply</em></span>
        <strong>${range(supply)}</strong>
        <small>${score(supply)} · price may meet resistance inside this band</small>
      </div>
    </div>
  </div>`;
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function revealMobileNavPage(page) {
  const mobileButton = document.querySelector(`#mobileNav .mobile-nav-btn[data-page="${page}"]`);
  if (mobileButton && window.matchMedia('(max-width: 768px)').matches) {
    mobileButton.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

// ── Watchlist cross-device sync ─────────────────────────────────────────────
// The watchlist lives server-side per account, but the client only fetched it
// at login/boot — edits made on another device never appeared until re-login.
// Re-sync the list from the server whenever the watchlist page opens, every
// 60s while it stays open, and whenever the app returns to the foreground.
let wlSyncTimer = null;
async function syncWatchlistPage() {
  try { await wlAPI.load(); } catch (_) {}
  loadWatchlist();
  loadSectorHeatmap();
  futuresTracker.load();
}

function goPage(page) {
  state.prevPage = state.page;
  state.page     = page;
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page===page));
  revealMobileNavPage(page);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('page-'+page).classList.add('active');
  if (page==='markets')   loadMarkets();
  if (page==='watchlist') {
    syncWatchlistPage();
    clearInterval(wlSyncTimer);
    wlSyncTimer = setInterval(() => {
      if (document.getElementById('page-watchlist')?.classList.contains('active')) syncWatchlistPage();
    }, 60000);
  } else {
    clearInterval(wlSyncTimer);
    wlSyncTimer = null;
  }
  if (page==='scanner')   scanner.open();
  if (page==='trading')   { alpacaTrader.open(); }
  if (page==='warrior') { if (window.warriorBot) warriorBot.open(); }
  else if (window.warriorBot) warriorBot.pause();
  if (page==='flipper') { if (window.flipperBot) flipperBot.open(); }
  else if (window.flipperBot) flipperBot.pause();
  if (page==='crypto') { if (window.cryptoBot) cryptoBot.open(); }
  else if (window.cryptoBot) cryptoBot.pause();
  document.dispatchEvent(new CustomEvent('pageChanged', { detail: { page } }));
}

// Reset the home page to the main dashboard (Command Center), clearing any
// open ticker workspace / search state. Used by the site logo click.
function resetToDashboard() {
  state.prevPage = null;
  state.page     = 'home';
  state.symbol   = null;
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === 'home'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('page-home')?.classList.add('active');
  const ws = $('homeWorkspace'); if (ws) ws.style.display = 'none';
  const he = $('homeEmpty');     if (he) he.style.display = '';
  const hero = $('heroInput');   if (hero) hero.value = '';
  const drop = $('homeDrop');    if (drop) drop.classList.remove('open');
  const topVerdict = $('searchVerdictTop'); if (topVerdict) topVerdict.style.display = 'none';
  if (window.searchIntelligence) searchIntelligence.hide();
}

// Collapsible desktop sidebar — persists collapsed state in localStorage.
// The collapsed styles only apply inside the min-width:769px media query,
// so mobile (top bar + bottom nav) is unaffected.
function setupSidebar() {
  const nav = document.querySelector('.nav');
  const btn = $('navCollapse');
  if (!nav || !btn) return;
  const KEY = 'qf_sidebar_collapsed';
  const apply = (collapsed) => {
    nav.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (_) {}
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch (_) {}
  apply(collapsed);
  btn.addEventListener('click', () => apply(!nav.classList.contains('collapsed')));
}

// ── Stock page ─────────────────────────────────────────────────────────────────
async function openStock(sym, snap, { intelligenceQuery = null } = {}) {
  const loadId = ++state.loadId;
  state.prevPage  = state.page;
  state.page      = 'home';
  state.symbol    = sym;
  state.snap      = snap || {};
  state.stockData = null;
  window.searchSmartMoney = null;

  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page==='home'));
  revealMobileNavPage('home');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('page-home').classList.add('active');

  $('homeEmpty').style.display = 'none';
  $('homeWorkspace').style.display = '';
  const topVerdict = $('searchVerdictTop');
  if (topVerdict) topVerdict.style.display = 'none';

  const backBtn = $('backBtn');
  if (backBtn) backBtn.style.display = (state.prevPage && state.prevPage !== 'home') ? '' : 'none';

  renderStockHeader(sym, snap);
  updateWatchBtn(sym);

  document.querySelectorAll('.stock-tab').forEach(t => t.classList.toggle('active', t.dataset.tab==='overview'));
  document.querySelectorAll('.tab-pane').forEach(p => { p.classList.toggle('active', p.id==='tab-overview'); p.innerHTML='<div class="tab-spin"><div class="spinner"></div></div>'; });

  const analysisPromise = window.searchContext.load(sym);
  if (typeof rtTrader !== 'undefined') rtTrader.load(sym, analysisPromise);
  if (typeof gamePlan !== 'undefined') gamePlan.load(sym, analysisPromise);
  if (window.searchIntelligence) {
    searchIntelligence.load(intelligenceQuery || sym, { symbol: sym });
  }

  const [barsData, fmpData, analysis, valData] = await Promise.all([
    api.bars(sym, '1Hour', 120),
    api.stock(sym),
    analysisPromise.catch(() => null),
    api.valuation(sym),
  ]);
  if (loadId !== state.loadId || state.symbol !== sym) return;
  const authoritativeSnap = analysis?.snapshot ? {
    ...snap,
    price: analysis.snapshot.price,
    // Preserve the true regular-session close from the original snapshot.
    // Overwriting regularClose with the live price collapsed the
    // extended-hours change to $0.00.
    previousClose: analysis.snapshot.prevClose,
    open: analysis.snapshot.open,
    dayHigh: analysis.snapshot.high,
    dayLow: analysis.snapshot.low,
    volume: analysis.snapshot.volume,
    avgVolume: analysis.snapshot.avgVolume,
    marketState: analysis.snapshot.marketState,
     changeWindow: analysis.snapshot.changeWindow,
  } : snap;
  state.snap = authoritativeSnap;
  renderStockHeader(sym, authoritativeSnap);
  const up = (authoritativeSnap?.price || 0) >= (authoritativeSnap?.previousClose || 0);
  state.stockData = { sym, snap: authoritativeSnap, bars: barsData, fmp: fmpData, news: analysis?.news || [], val: valData, analysis };
  renderOverview(authoritativeSnap, barsData, up);
}

function openMacroSearch(query) {
  const clean = String(query || '').trim();
  if (!clean) return;
  ++state.loadId;
  state.prevPage = state.page;
  state.page = 'home';
  state.symbol = null;
  state.snap = null;
  state.stockData = null;
  document.querySelectorAll('.nav-link').forEach(link =>
    link.classList.toggle('active', link.dataset.page === 'home'));
  revealMobileNavPage('home');
  document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
  $('page-home').classList.add('active');
  $('homeEmpty').style.display = 'none';
  $('homeWorkspace').style.display = 'none';
  if (window.searchIntelligence) searchIntelligence.load(clean);
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
  if (tab==='analysts') renderAnalysts(d.fmp, d.snap?.price||0, d.val, d.analysis);
  if (tab==='news')     renderNews(d.news, d.sym);
  if (tab==='forecast') loadForecastTab(d.sym);
}

// ── Historical Forecast tab ──────────────────────────────────────────────────
async function loadForecastTab(sym) {
  if (!sym) return;
  if (state.stockData?.forecastLoadedFor === sym && state.stockData?.forecast) {
    renderForecastPanel(state.stockData.forecast, sym);
    return;
  }
  const panel = $('forecastPanel');
  if (panel) panel.innerHTML = '<div class="tab-spin"><div class="spinner"></div></div>';
  const loadId = ++state.forecastLoadId;
  const forecast = await api.forecast(sym);
  if (sym !== state.symbol || loadId !== state.forecastLoadId || !state.stockData) return;
  state.stockData.forecast = forecast;
  state.stockData.forecastLoadedFor = sym;
  renderForecastPanel(forecast, sym);
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
    `</div><div class="chart-card"><div class="chart-card-head"><div><h3>Intraday \u2014 5 trading days</h3><span class="chart-card-sub">Hourly OHLC with nearby higher-timeframe zones</span></div>${chartLegendHtml()}</div>` +
    '<canvas id="ovCanvas" style="height:280px"></canvas></div></div>' +
    '<div id="scorePanel"></div></div>';
  $('ov-open').textContent   = '$' + fmt(p.open);
  $('ov-prev').textContent   = '$' + fmt(p.previousClose);
  $('ov-high').textContent   = '$' + fmt(p.dayHigh);
  $('ov-low').textContent    = '$' + fmt(p.dayLow);
  $('ov-vol').textContent    = fmtV(p.volume);
  $('ov-avgvol').textContent = fmtV(p.avgVolume);
  const canvas = $('ovCanvas');
  activeOverviewChart = canvas && bars?.bars?.length >= 2
    ? { canvas, bars: bars.bars, color, showAll: false }
    : null;
  if (activeOverviewChart) requestAnimationFrame(() =>
    drawChart(canvas, bars.bars, color, 280, window.searchSmartMoney, false));
  // async score panel
  loadScorePanel(state.stockData?.fmp, p.price||0);
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

function historicalMatchOutcome(outcome) {
  const value = String(outcome || '').toUpperCase();
  if (value === 'BULLISH') return { label: 'Bullish', cls: 'bull' };
  if (value === 'BEARISH') return { label: 'Bearish', cls: 'bear' };
  return { label: 'Neutral', cls: 'neutral' };
}

function historicalMatchSimilarity(value) {
  const score = Number(value);
  return Number.isFinite(score) ? `${(Math.max(0, Math.min(1, score)) * 100).toFixed(0)}%` : '—';
}

function historicalMatchPath(data, date) {
  const analog = data?.paths?.analogs?.find(item => item.date === date);
  if (analog?.path?.length) return analog.path;
  return date === data?.closest?.date ? data?.paths?.closest : null;
}

function renderHistoricalSelection(data, selectedMatch) {
  if (!selectedMatch) return '';
  const outcome = historicalMatchOutcome(selectedMatch.outcome);
  return `<div class="hf-selection" aria-live="polite">
    <div class="hf-selection-head">
      <strong>Focused historical match</strong>
      <span>Read-only realized history</span>
    </div>
    <div class="hf-selection-grid">
      <div><span>Historical date</span><strong>${escapeHtml(selectedMatch.date || '—')}</strong></div>
      <div><span>Similarity</span><strong class="hf-match-similarity">${historicalMatchSimilarity(selectedMatch.similarity)}</strong></div>
      <div><span>Forward result</span><strong class="hf-match-result ${outcome.cls}">${pct(selectedMatch.forwardReturn)}</strong><small>${outcome.label}</small></div>
      <div><span>Max favorable</span><strong class="up">${pct(selectedMatch.maxRise)}</strong></div>
      <div><span>Max adverse</span><strong class="down">${pct(selectedMatch.maxDrawdown)}</strong></div>
    </div>
  </div>`;
}

function renderHistoricalMatches(data, selectedDate) {
  if (!data?.displayable || !Array.isArray(data.matches) || !data.matches.length) return '';
  const matches = [...data.matches].sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0));
  const rows = matches.map(match => {
    const outcome = historicalMatchOutcome(match.outcome);
    const date = escapeHtml(match.date || '—');
    const selected = match.date === selectedDate;
    return `<tr>
      <td><button type="button" class="hf-match-select${selected ? ' selected' : ''}" data-hf-match="${date}" aria-pressed="${selected}"><time datetime="${date}">${date}</time><span>${selected ? 'Focused' : 'Compare'}</span></button></td>
      <td class="hf-match-similarity">${historicalMatchSimilarity(match.similarity)}</td>
      <td><span class="hf-match-result ${outcome.cls}">${pct(match.forwardReturn)}</span><small>${outcome.label}</small></td>
      <td class="up">${pct(match.maxRise)}</td>
      <td class="down">${pct(match.maxDrawdown)}</td>
    </tr>`;
  }).join('');

  return `<details class="hf-matches">
    <summary><span>Review historical matches</span><strong>${matches.length}</strong></summary>
    <div class="hf-matches-note">Past analogs only — select one to compare its realized path with the aggregate projection. These are not live or guaranteed results.</div>
    <div class="hf-match-table-wrap">
      <table class="hf-match-table">
        <caption class="hf-sr-only">Historical pattern matches and their realized outcomes</caption>
        <thead><tr><th scope="col">Historical date</th><th scope="col">Similarity</th><th scope="col">Forward result</th><th scope="col">Max favorable</th><th scope="col">Max adverse</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

function forecastCalibrationPct(value) {
  return value != null && Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(0)}%`
    : '—';
}
function drawForecastPath(canvas, data) {
  if (!canvas || !data?.paths?.current?.length) return;
  const current = data.paths.current;
  const horizon = Number(data.horizon) || 30;
  const selectedDate = data.selectedMatch?.date || data.closest?.date;
  const selectedPath = historicalMatchPath(data, selectedDate);
  const lines = [
    { values: selectedPath, color: '#63b3ed', width: 2.5, label: 'Focused historical match' },
    { values: data.paths.bullish?.average, color: '#1dd6a3', width: 2.5, label: 'Bullish average' },
    { values: data.paths.bearish?.average, color: '#e84545', width: 2.5, label: 'Bearish average' },
  ].filter(line => Array.isArray(line.values) && line.values.length);
  const allValues = [...current, ...lines.flatMap(line => line.values),
    ...(data.paths.bullish?.lower || []), ...(data.paths.bullish?.upper || []),
    ...(data.paths.bearish?.lower || []), ...(data.paths.bearish?.upper || [])].filter(Number.isFinite);
  if (!allValues.length) return;
  const ctx = canvas.getContext('2d');
  const isLight = document.documentElement.dataset.theme === 'light';
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

  ctx.strokeStyle = isLight ? '#344054' : '#d7e3f4'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  current.forEach((value, index) => index ? ctx.lineTo(currentX(index), y(value)) : ctx.moveTo(currentX(index), y(value)));
  ctx.stroke();
  lines.forEach(line => {
    ctx.strokeStyle = line.color; ctx.lineWidth = line.width;
    ctx.beginPath();
    line.values.forEach((value, index) => index ? ctx.lineTo(forwardX(index), y(value)) : ctx.moveTo(forwardX(index), y(value)));
    ctx.stroke();
  });
  ctx.fillStyle = isLight ? '#475467' : '#93a6c6'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'left';
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
  const matches = Array.isArray(data?.matches) ? data.matches : [];
  const rememberedSelection = state.forecastSelection;
  const selectedDate = matches.some(match =>
    match.date === rememberedSelection?.date
    && rememberedSelection?.symbol === symbol
    && rememberedSelection?.lookback === lookback
    && rememberedSelection?.horizon === horizon)
    ? rememberedSelection.date
    : data?.closest?.date;
  const selectedMatch = matches.find(match => match.date === selectedDate) || data?.closest;
  const chartData = data ? { ...data, selectedMatch } : data;
  const stars = '★'.repeat(data?.robustness || 1) + '☆'.repeat(Math.max(0, 5 - (data?.robustness || 1)));
  const controls = `<div class="hf-controls">
      <label>Pattern <select id="forecastLookback">${selectableLookbacks.map(value => `<option value="${value}"${value === lookback ? ' selected' : ''}>${value} sessions</option>`).join('')}</select></label>
      <label>Outcome <select id="forecastHorizon">${selectableHorizons.map(value => `<option value="${value}"${value === horizon ? ' selected' : ''}>${value} sessions</option>`).join('')}</select></label>
    </div>`;

  if (!data?.available || !data.displayable) {
    panel.innerHTML = `<div class="hf-card hf-${status.cls}">
      <div class="hf-head"><div><span class="hf-kicker">Historical Forecast</span><h3>Historical conditional probability</h3></div>${controls}</div>
      <div class="hf-empty"><span class="hf-status-icon">${status.icon}</span><div><strong>${status.label}</strong><p>${status.detail}</p><small>Historical outcomes are withheld rather than estimated from an unreliable sample.</small></div></div>
      ${renderForecastCalibration(data?.validation)}
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
    ${renderHistoricalSelection(data, selectedMatch)}
    <div class="hf-chart-card">
      <div class="hf-chart-head"><strong>Focused match vs aggregate projection</strong><span>Normalized to 100 at the forecast point</span></div>
      <canvas id="forecastPathCanvas" aria-label="Current pattern and comparable historical outcome paths"></canvas>
      <div class="hf-legend"><span class="current">● Current pattern</span><span class="analog">● Focused historical match</span><span class="bull">● Bullish average</span><span class="bear">● Bearish average</span></div>
    </div>
    <div class="hf-facts">
      <div><span>Comparable windows</span><strong>${data.matchCount}</strong><small>${Number(data.effectiveSampleSize || 0).toFixed(1)} effective weighted sample</small></div>
      <div><span>Expected return</span><strong class="${data.expectedReturn >= 0 ? 'up' : 'down'}">${pct(data.expectedReturn)}</strong><small>10–90%: ${pct(data.returnRange?.p10)} to ${pct(data.returnRange?.p90)}</small></div>
      <div><span>Closest analog</span><strong>${(Number(closest.similarity || 0) * 100).toFixed(0)}% similar</strong><small>${escapeHtml(closest.date || '—')} · ${pct(closest.forwardReturn)} forward</small></div>
      <div><span>Historical range</span><strong class="up">${pct(closest.maxRise)}</strong><small class="down">Worst path: ${pct(closest.maxDrawdown)}</small></div>
    </div>
    ${renderForecastCalibration(data.validation)}
    <p class="hf-explain">${escapeHtml(data.explanation || '')}</p>
    ${renderHistoricalMatches(data, selectedDate)}
    <details class="hf-method"><summary>How calculated?</summary><p>Each comparison uses the selected normalized price path plus return correlation, volatility, momentum, and drawdown. A match’s influence is its similarity cubed. Bullish and bearish require a move beyond ±${Number(data.thresholdPct || 2).toFixed(1)}% over ${horizon} sessions. Future candles are used only to measure historical outcomes, never to select a match.</p><p>Historical outcomes among comparable patterns are not guarantees of future performance. This panel is read-only and does not change trading signals or place orders.</p></details>
  </div>`;
  const canvas = $('forecastPathCanvas');
  requestAnimationFrame(() => drawForecastPath(canvas, chartData));
  panel.querySelectorAll('[data-hf-match]').forEach(button => {
    button.addEventListener('click', () => {
      state.forecastSelection = {
        symbol,
        lookback,
        horizon,
        date: button.dataset.hfMatch,
      };
      renderForecastPanel(data, symbol);
    });
  });
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
let activeSearchChart = null;

function renderChart(sym, initBars, up) {
  const color = up ? '#1dd6a3' : '#e84545';
  $('tab-chart').innerHTML = `
    <div class="tf-row">
      <span class="tf-group-label">Price context</span>
      <button class="tf-btn active" data-tf="1Hour" data-lim="120" data-range-label="5D">5D</button>
      <button class="tf-btn" data-tf="1Hour" data-lim="240" data-range-label="2W">2W</button>
      <button class="tf-btn" data-tf="1Day" data-lim="30">1M</button>
      <button class="tf-btn" data-tf="1Day" data-lim="90">3M</button>
      <button class="tf-btn" data-tf="1Day" data-lim="180">6M</button>
      <button class="tf-btn" data-tf="1Day" data-lim="365">1Y</button>
      <span class="sm-chart-status" id="smChartStatus">Smart Money ${escapeHtml(window.searchSmartMoney?.timeframe || '1D')} zones · 5D price context</span>
      <button class="tf-btn sm-chart-toggle active" id="smChartToggle" type="button">Zones on</button>
      <button class="tf-btn sm-chart-all" id="smChartAll" type="button">Primary zones</button>
    </div>
    <div class="chart-card chart-card-main"><div class="chart-card-head"><div><span class="chart-card-kicker">SMART MONEY MAP · SUPPORTING CONTEXT</span><h3>Price action with potential zones</h3><span class="chart-card-sub">Candles show the path. Colored bands show where demand or supply may react.</span></div>${chartLegendHtml()}</div><div class="chart-canvas-wrap"><canvas id="mainCanvas" class="chart-main-canvas" style="height:500px"></canvas></div>${chartZoneKeyHtml(window.searchSmartMoney)}</div>`;
  const canvas = $('mainCanvas');
  activeSearchChart = { sym, canvas, bars: initBars?.bars || [], color, zones: true, showAll: false, rangeLabel: '5D' };
  const redraw = () => drawChart(canvas, activeSearchChart.bars, activeSearchChart.color, 500,
    activeSearchChart.zones ? window.searchSmartMoney : null, activeSearchChart.showAll);
  if (activeSearchChart.bars.length>=2) requestAnimationFrame(redraw);
  else api.bars(sym,'1Hour',120).then(d => {
    if (!d?.bars || activeSearchChart?.sym !== sym) return;
    activeSearchChart.bars = d.bars;
    requestAnimationFrame(redraw);
  });
  $('smChartToggle')?.addEventListener('click', event => {
    activeSearchChart.zones = !activeSearchChart.zones;
    event.currentTarget.classList.toggle('active', activeSearchChart.zones);
    event.currentTarget.textContent = activeSearchChart.zones ? 'Zones on' : 'Zones off';
    redraw();
  });
  $('smChartAll')?.addEventListener('click', event => {
    activeSearchChart.showAll = !activeSearchChart.showAll;
    event.currentTarget.classList.toggle('active', activeSearchChart.showAll);
    event.currentTarget.textContent = activeSearchChart.showAll ? 'All zones' : 'Primary zones';
    redraw();
  });
  $('tab-chart').querySelectorAll('.tf-btn').forEach(btn => {
    if (!btn.dataset.tf) return;
    btn.addEventListener('click', async () => {
      $('tab-chart').querySelectorAll('.tf-btn[data-tf]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const d = await api.bars(sym, btn.dataset.tf, +btn.dataset.lim);
      if (!d?.bars) return;
      const up2  = d.bars.at(-1)?.c >= d.bars[0]?.c;
      activeSearchChart.bars = d.bars;
      activeSearchChart.color = up2?'#1dd6a3':'#e84545';
      activeSearchChart.rangeLabel = btn.dataset.rangeLabel || btn.textContent.trim();
      const status = $('smChartStatus');
      if (status) status.textContent = `Smart Money ${window.searchSmartMoney?.timeframe || '1D'} zones · ${activeSearchChart.rangeLabel} price context`;
      requestAnimationFrame(redraw);
    });
  });
}

window.updateSearchSmartMoney = data => {
  window.searchSmartMoney = data || null;
  if (activeOverviewChart) {
    drawChart(activeOverviewChart.canvas, activeOverviewChart.bars, activeOverviewChart.color, 280,
      data, activeOverviewChart.showAll);
  }
  if (!activeSearchChart || !document.getElementById('tab-chart')?.classList.contains('active')) return;
  if (!activeSearchChart.bars.length && Array.isArray(data?.chartBars) && data.chartBars.length >= 2) {
    activeSearchChart.bars = data.chartBars;
    activeSearchChart.color = data.chartBars.at(-1)?.c >= data.chartBars[0]?.c ? '#1dd6a3' : '#e84545';
  }
  const status = $('smChartStatus');
  if (status) status.textContent = data?.available
    ? `Smart Money ${data.timeframe} zones · ${activeSearchChart.rangeLabel || 'price'} price context`
    : `Smart Money ${data?.timeframe || ''} unavailable · ${activeSearchChart.rangeLabel || 'price'} price context`;
  const zoneKey = $('chartZoneKey');
  if (zoneKey) zoneKey.outerHTML = chartZoneKeyHtml(data);
  drawChart(activeSearchChart.canvas, activeSearchChart.bars, activeSearchChart.color, 500,
    activeSearchChart.zones ? data : null, activeSearchChart.showAll);
};

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
        <div class="analyst-top-grid">
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

function renderNews(news, sym) {
  if (!news?.length) {
    $('tab-news').innerHTML = `<div class="news-feed"><p class="no-data" style="padding:24px">No recent news found${sym ? ` for ${escapeHtml(sym)}` : ''}. Headlines below the analysis may still carry market-wide context.</p></div>`;
    return;
  }
  const cards = news.slice(0, 20).map(n => {
    const publishedAt = n.publishedAt || n.created_at || n.date || null;
    const date  = publishedAt ? timeAgo(publishedAt) : '';
    const title = escapeHtml(n.headline || n.title || '');
    const rawUrl = n.url || '#';
    const safe  = /^https?:\/\//i.test(rawUrl) ? rawUrl.replace(/"/g, '%22') : '#';
    const img   = n.image ? `<div class="ni-thumb" style="background-image:url('${n.image.replace(/'/g,'%27')}')"></div>` : '';
    const sum   = n.summary ? `<div class="ni-summary">${escapeHtml(n.summary.slice(0, 120))}${n.summary.length>120?'…':''}</div>` : '';
    const linkAttrs = safe === '#'
      ? 'aria-disabled="true"'
      : `onclick="window.open('${safe}','_blank','noopener')" role="link" tabindex="0"`;
    return `<div class="news-item2${safe === '#' ? ' disabled' : ''}" ${linkAttrs}>
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
  const [snaps, ...barPayloads] = await Promise.all([
    api.snapshots(syms),
    ...[...syms, 'SPY'].map(sym => api.bars(sym, '1Day', 80)),
  ]);
  const benchmarkBars = barPayloads.at(-1)?.bars || [];
  const rrgBySym = Object.fromEntries(SECTORS.map((sector, index) => [
    sector.sym,
    window.RRGStyle?.calculateRrgStyle(barPayloads[index]?.bars || [], benchmarkBars) || {
      available: false,
      reason: 'RRG_STYLE_UNAVAILABLE',
    },
  ]));

  // Build enriched list sorted by % change desc
  const data = SECTORS.map(s => {
    const q   = snaps[s.sym] || {};
    const pct = q.changesPercentage ?? null;
    return { ...s, q, pct, rrg: rrgBySym[s.sym] };
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

    const rrgEl = document.createElement('span');
    const rrg = d.rrg;
    const rrgClass = rrg?.available
      ? `rrg-${String(rrg.quadrant).toLowerCase()}`
      : 'rrg-unavailable';
    rrgEl.className = `sr-tile-rrg ${rrgClass}`;
    rrgEl.textContent = rrg?.available
      ? `RRG-style ${rrg.quadrant} · RS ${rrg.rsRatio.toFixed(1)} / Mom ${rrg.rsMomentum.toFixed(1)}`
      : 'RRG-style unavailable';
    rrgEl.title = rrg?.available
      ? `${rrg.method}; completed ${rrg.asOf} close`
      : 'RRG-style context requires matching completed daily bars.';

    const barEl = document.createElement('div');
    barEl.className = 'sr-tile-bar';
    barEl.style.background = srBarColor(pct);

    tile.appendChild(rankEl);
    tile.appendChild(symEl);
    tile.appendChild(nameEl);
    tile.appendChild(pctEl);
    tile.appendChild(priceEl);
    tile.appendChild(sigEl);
    tile.appendChild(rrgEl);
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
    item.className = `drop-item${r.kind === 'macro' ? ' drop-macro' : ''}`;
    item.setAttribute('role', 'option');
    if (r.kind === 'macro') {
      item.dataset.query = r.query;
      if (r.symbol) item.dataset.contextSymbol = r.symbol;
    }
    else item.dataset.sym = r.symbol;
    const sym = document.createElement('span');
    sym.className = 'drop-sym';
    sym.textContent = r.kind === 'macro' ? 'MACRO' : r.symbol;
    const name = document.createElement('span');
    name.className = 'drop-name';
    name.textContent = r.kind === 'macro'
      ? `${r.label || r.query} · ${r.name || ''}`
      : r.name || '';
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

async function _selectDropQuery(query, input, drop, contextSymbol = '') {
  drop.classList.remove('open');
  input.value = '';
  if (contextSymbol) {
    const snapshots = await api.snapshots([contextSymbol]);
    openStock(
      contextSymbol,
      snapshots[contextSymbol] || { symbol: contextSymbol },
      { intelligenceQuery: query },
    );
  } else {
    openMacroSearch(query);
  }
}

function _bindDropSearch(input, drop, getTimer, setTimer) {
  let reqId = 0; // race-condition guard — only render the latest response

  function _attachItemListeners() {
    drop.querySelectorAll('.drop-item[data-sym],.drop-item[data-query]').forEach(item => {
      item.addEventListener('mousedown', e => { e.preventDefault(); }); // keep focus on input
      item.addEventListener('click', () => item.dataset.query
        ? _selectDropQuery(item.dataset.query, input, drop, item.dataset.contextSymbol)
        : _selectDropSym(item.dataset.sym, input, drop));
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

    const items = [...drop.querySelectorAll('.drop-item[data-sym],.drop-item[data-query]')];
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
        if (cur.dataset.query) {
          _selectDropQuery(cur.dataset.query, input, drop, cur.dataset.contextSymbol);
        }
        else _selectDropSym(cur.dataset.sym, input, drop);
      } else {
        // If the API offered a macro result, use it; otherwise load the exact ticker.
        const macroItem = items.find(item => item.dataset.query);
        if (macroItem) {
          _selectDropQuery(
            input.value.trim(),
            input,
            drop,
            macroItem.dataset.contextSymbol,
          );
        }
        else {
          const sym = input.value.trim().toUpperCase();
          if (sym) _selectDropSym(sym, input, drop);
        }
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
  marketAlerts.start();
  // Silently restore Alpaca connection state on every login/page-load —
  // credentials live in the DB and must not require a manual tab click to reconnect.
  alpacaTrader.checkCredentials();
}

function showAuthOverlay() {
  $('authOverlay').classList.remove('auth-hidden');
  $('navUser').style.display = 'none';
  window.jqfAgent?.hide();
  marketAlerts.stop();
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
  const topVerdict = $('searchVerdictTop'); if (topVerdict) topVerdict.style.display = 'none';
  if (window.searchIntelligence) searchIntelligence.hide();
  state.symbol = null;
}

let _resetAuthToLogin = () => {};   // populated by setupAuthUI

function setupAuthUI() {
  let mode = 'login';

  function setMode(m) {
    mode = m;
    hideVerifyPending();
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
    $('tabLogin').setAttribute('aria-selected', String(!isReg));
    $('tabReg').setAttribute('aria-selected', String(isReg));
    $('authUser').placeholder = isReg ? 'Choose a username' : 'Enter your username';
    $('authPass').placeholder = isReg ? 'Choose a password' : 'Enter your password';
    $('authPass').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
    const emailField = $('authEmailField');
    if (emailField) emailField.style.display = isReg ? '' : 'none';
    $('authSwitchLink')?.addEventListener('click', e=>{ e.preventDefault(); setMode(isReg?'login':'register'); });
  }

  $('tabLogin').addEventListener('click', () => setMode('login'));
  $('tabReg').addEventListener('click',   () => setMode('register'));
  $('authSwitchLink')?.addEventListener('click', e=>{ e.preventDefault(); setMode(mode==='login'?'register':'login'); });

  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const u = $('authUser').value.trim();
    const p = $('authPass').value;
    const em = $('authEmail') ? $('authEmail').value.trim() : '';
    $('authError').textContent = '';

    // Client-side validation
    if (!u) { $('authError').textContent = 'Please enter a username.'; $('authUser').focus(); return; }
    if (!p) { $('authError').textContent = 'Please enter a password.';  $('authPass').focus(); return; }
    if (mode === 'register' && p.length < 6) { $('authError').textContent = 'Password must be at least 6 characters.'; return; }
    if (mode === 'register' && !/^[a-zA-Z0-9_]{3,20}$/.test(u)) { $('authError').textContent = 'Username must be 3–20 characters (letters, numbers, _).'; return; }
    if (mode === 'register' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { $('authError').textContent = 'Please enter a valid email address.'; $('authEmail').focus(); return; }

    $('authSubmit').disabled    = true;
    $('authSubmit').textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';

    const res = mode === 'login' ? await authAPI.login(u, p) : await authAPI.register(u, p, em);

    if (res.ok) {
      if (mode === 'register') {
        // Account exists but has no session yet: the emailed verification
        // link gates the site, so show the "check your inbox" state.
        showVerifyPending(em);
      } else {
        await wlAPI.load();
        showApp(res.data);
        goPage('home');
      }
    } else {
      const code = res.data?.code;
      if (code === 'LEGACY_ACCOUNT_RETIRED') {
        $('authError').textContent = 'This older account was retired for security. Select “Create Account” above to make a new account with this username, then reconnect your broker account.';
      } else if (code === 'EMAIL_UNVERIFIED') {
        showUnverifiedLoginError(res.data?.email || em);
      } else {
        $('authError').textContent = res.data?.error || 'Something went wrong.';
      }
      $('authSubmit').disabled    = false;
      $('authSubmit').textContent = mode === 'login' ? 'Sign In' : 'Create Account';
    }
  });

  // Expose a reset function so showAuthOverlay can restore login mode on logout
  _resetAuthToLogin = () => {
    setMode('login');
    $('authSubmit').disabled = false;
  };

  // "Check your inbox" state shown right after signup — the account exists
  // but has no session until the emailed link is clicked.
  $('verifyPendingResend')?.addEventListener('click', async () => {
    const btn = $('verifyPendingResend');
    const email = $('authVerifyPending').dataset.email || '';
    $('verifyPendingError').textContent = '';
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const r = await authAPI.resendVerification(email);
    if (r.ok) {
      btn.textContent = 'Sent — check your inbox';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Resend verification email'; }, 30000);
    } else {
      btn.disabled = false;
      btn.textContent = 'Resend verification email';
      $('verifyPendingError').textContent = 'Could not send the email. Try again in a bit.';
    }
  });
  $('verifyPendingBack')?.addEventListener('click', e => { e.preventDefault(); setMode('login'); });
}

// After signup: hide the form and show the "check your inbox" panel.
function showVerifyPending(email) {
  document.querySelector('.auth-tabs').style.display = 'none';
  $('authForm').style.display = 'none';
  $('authSwitch').style.display = 'none';
  $('authTitle').textContent = 'Check your inbox';
  $('authSub').textContent = email
    ? `We sent a verification link to ${email}. Click the link to verify your email, then sign in.`
    : 'We sent you a verification link. Click the link to verify your email, then sign in.';
  $('verifyPendingError').textContent = '';
  const panel = $('authVerifyPending');
  panel.dataset.email = email || '';
  panel.style.display = '';
  const btn = $('verifyPendingResend');
  btn.disabled = false;
  btn.textContent = 'Resend verification email';
}

function hideVerifyPending() {
  const panel = $('authVerifyPending');
  if (panel) panel.style.display = 'none';
  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.style.display = '';
  const form = $('authForm');
  if (form) form.style.display = '';
  const sw = $('authSwitch');
  if (sw) sw.style.display = '';
}

// Unverified sign-in attempt: explain the gate and offer a fresh link.
function showUnverifiedLoginError(email) {
  const err = $('authError');
  err.innerHTML = '';
  const msg = document.createElement('span');
  msg.textContent = 'Please verify your email before signing in. Check your inbox for the verification link. ';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'auth-link-btn';
  btn.textContent = 'Resend verification email';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const r = await authAPI.resendVerification(email);
    btn.textContent = r.ok ? 'Sent — check your inbox' : 'Try again later';
    if (r.ok) setTimeout(() => { btn.disabled = false; btn.textContent = 'Resend verification email'; }, 30000);
    else btn.disabled = false;
  });
  err.append(msg, btn);
}

// ── INIT ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupThemeToggle();
  setupAuthUI();
  marketAlerts.setup();

  // Check if already logged in
  const me = await authAPI.me();
  if (me) {
    await wlAPI.load();
    showApp(me);
  }

  // Re-sync the watchlist when the app returns to the foreground (phones
  // background tabs constantly; the other device may have edited the list).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.getElementById('page-watchlist')?.classList.contains('active')) {
      syncWatchlistPage();
    }
  });

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

  // Site logo → reset to the main dashboard (desktop + mobile top bar share .nav-logo)
  document.querySelectorAll('.nav-logo').forEach(logo=>{
    logo.addEventListener('click', resetToDashboard);
    logo.addEventListener('keydown', e=>{
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resetToDashboard(); }
    });
  });

  setupSidebar();

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

function renderForecastCalibration(validation) {
  if (!validation) return '';
  const group = validation.group;
  const status = validation.status || group?.status || 'INSUFFICIENT_SAMPLE';
  const presentation = status === 'POOR_CALIBRATION'
    ? { cls: 'bad', label: 'Calibration warning' }
    : status === 'OK'
      ? { cls: 'good', label: 'Held up on unseen history' }
      : { cls: 'limited', label: 'Too little unseen evidence' };
  const independent = Number(group?.independentEvaluatedCalls || 0);
  const rows = [
    ['Bullish', 'bull'],
    ['Neutral', 'neutral'],
    ['Bearish', 'bear'],
  ].map(([label, key]) => {
    const range = group?.predictedProbabilityRanges?.[key];
    const rangeText = range
      ? `${forecastCalibrationPct(range.min)}–${forecastCalibrationPct(range.max)} predicted range`
      : 'No displayable probability range';
    return `<div class="hf-validation-item">
      <span>${label}</span>
      <strong>${forecastCalibrationPct(group?.meanPredictedProbabilities?.[key])} predicted</strong>
      <small>${forecastCalibrationPct(group?.realizedOutcomeRates?.[key])} realized · ${rangeText}</small>
    </div>`;
  }).join('');
  const warning = group?.warnings?.[0]?.message || validation.explanation
    || 'Calibration evidence is unavailable.';
  const period = validation.period?.firstForecastDate && validation.period?.lastOutcomeDate
    ? `${escapeHtml(validation.period.firstForecastDate)} through ${escapeHtml(validation.period.lastOutcomeDate)}`
    : 'No complete unseen period';
  return `<section class="hf-validation hf-validation-${presentation.cls}" aria-label="Walk-forward forecast calibration">
    <div class="hf-validation-head">
      <div><span>Walk-forward check</span><strong>${presentation.label}</strong></div>
      <b>${independent} independent call${independent === 1 ? '' : 's'}</b>
    </div>
    <div class="hf-validation-grid">${rows}</div>
    <p>${escapeHtml(warning)}</p>
    <small>Point-in-time period: ${period}. Outcome windows are non-overlapping. This evidence is read-only and cannot change automated trading.</small>
  </section>`;
}
