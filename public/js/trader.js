// ─────────────────────────────────────────────────────────────────────────────
// StockPulse — Realtime Trader module
// All analysis math runs client-side; data comes from FMP via /api/* proxies.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────

  const trader = {
    symbol:        null,
    countdownTimer: null,
    countdownSecs:  60,
    refreshPending: false,
  };

  const CIRCUMFERENCE = 2 * Math.PI * 18; // countdown ring r=18

  // ─── DOM refs (resolved after DOMContentLoaded) ───────────────────────────

  let $input, $btn, $loading, $loadingTicker, $error, $errorMsg, $results;

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function fmtNum(n, dec = 2) {
    if (n == null || isNaN(n)) return '--';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function fmtVol(v) {
    if (v == null || isNaN(v)) return '--';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
  }

  // ─── Math: RSI (Wilder smoothing) ─────────────────────────────────────────

  function calcRSI(closes, period = 14) {
    // closes must be oldest-first
    if (closes.length < period + 1) return null;

    let gains = 0, losses = 0;

    // Seed: first 'period' changes
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains  += diff;
      else           losses -= diff;
    }

    let avgGain = gains  / period;
    let avgLoss = losses / period;

    // Wilder smoothing for remaining data
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const g = diff > 0 ? diff : 0;
      const l = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
  }

  // ─── Math: 10-day average volume ──────────────────────────────────────────

  function calcAvgVolume(historical) {
    // historical is newest-first; skip index 0 (today) for average
    const past = historical.slice(1, 11).map(d => d.volume).filter(v => v > 0);
    if (!past.length) return null;
    return past.reduce((a, b) => a + b, 0) / past.length;
  }

  // ─── Math: Support & Resistance from 14-day highs/lows ───────────────────

  function calcSupportResistance(historical) {
    // historical newest-first; use all 14 rows
    const rows = historical.slice(0, 14);
    const highs = rows.map(d => d.high).filter(Boolean).sort((a, b) => b - a);
    const lows  = rows.map(d => d.low ).filter(Boolean).sort((a, b) => a - b);

    const resistance = [...new Set(highs)].slice(0, 2);
    const support    = [...new Set(lows)].slice(0, 2);

    return { resistance, support };
  }

  // ─── Verdict logic ────────────────────────────────────────────────────────

  function computeVerdict({ rsi, price, open, high, low, volume, avgVolume, resistance }) {
    const isBullish   = price > open;
    const isBearish   = price < open;
    const volSurge    = avgVolume && volume >= avgVolume * 1.5;
    const nearRes     = resistance.some(r => price >= r * 0.98 && price <= r * 1.02);

    let verdict;
    if (rsi !== null && rsi < 45 && isBullish && volSurge) {
      verdict = 'BUY';
    } else if (rsi !== null && (rsi > 70 || (nearRes && isBearish))) {
      verdict = 'SELL';
    } else {
      verdict = 'HOLD';
    }

    // Confidence
    let confidence = 50;
    if (verdict === 'BUY') {
      confidence += Math.round((45 - rsi) / 45 * 22);       // RSI room (0–22)
      const surge = avgVolume ? volume / avgVolume : 1;
      confidence += Math.round(Math.min((surge - 1.5) * 18, 18)); // vol (0–18)
      const pctOpen = open ? ((price - open) / open) * 100 : 0;
      confidence += Math.round(Math.min(pctOpen * 3, 10));  // bullish day (0–10)
    } else if (verdict === 'SELL') {
      if (rsi !== null && rsi > 70) confidence += Math.round((rsi - 70) / 30 * 28);
      if (nearRes) confidence += 16;
      if (isBearish && open) {
        const pctOpen = ((open - price) / open) * 100;
        confidence += Math.round(Math.min(pctOpen * 3, 10));
      }
    } else {
      // HOLD: score how far from both thresholds
      const distBuy  = rsi !== null ? Math.max(0, rsi - 45) : 25;
      const distSell = rsi !== null ? Math.max(0, 70 - rsi) : 25;
      confidence = 52 + Math.round(Math.min(distBuy, distSell) / 25 * 30);
    }

    confidence = Math.min(Math.max(confidence, 42), 95);

    // Reason string
    const reasons = [];
    if (rsi !== null) reasons.push(`RSI ${rsi.toFixed(1)}`);
    if (volSurge) reasons.push(`Volume surge ${avgVolume ? (volume / avgVolume).toFixed(1) + '×' : ''}`);
    if (isBullish) reasons.push('Trading above open');
    if (isBearish) reasons.push('Trading below open');
    if (nearRes) reasons.push('Near resistance');

    return { verdict, confidence, reasons };
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  // RSI arc gauge (SVG)
  function renderRSIGauge(rsi) {
    const svg = document.getElementById('rsiGaugeSvg');
    if (!svg) return;

    const cx = 90, cy = 100, r = 80, sw = 16;

    function rsiToPoint(v) {
      const angle = Math.PI * (1 - v / 100);
      return {
        x: (cx + r * Math.cos(angle)).toFixed(2),
        y: (cy - r * Math.sin(angle)).toFixed(2),
      };
    }

    function arcPath(v1, v2) {
      const p1 = rsiToPoint(v1);
      const p2 = rsiToPoint(v2);
      // Spans < 180° so large-arc = 0; going right through top = sweep 0 (CCW in SVG)
      return `M ${p1.x} ${p1.y} A ${r} ${r} 0 0 0 ${p2.x} ${p2.y}`;
    }

    const needleColor = rsi == null ? '#444' : rsi < 45 ? '#22c55e' : rsi <= 70 ? '#FFD700' : '#ef4444';
    const np = rsi != null ? rsiToPoint(rsi) : rsiToPoint(50);

    svg.innerHTML = `
      <path d="${arcPath(0.5, 99.5)}" fill="none" stroke="#1e1e1e" stroke-width="${sw}" stroke-linecap="round"/>
      <path d="${arcPath(0.5, 44.5)}" fill="none" stroke="#22c55e" stroke-width="${sw - 4}" stroke-linecap="round" opacity="0.7"/>
      <path d="${arcPath(45.5, 69.5)}" fill="none" stroke="#FFD700" stroke-width="${sw - 4}" stroke-linecap="round" opacity="0.7"/>
      <path d="${arcPath(70.5, 99.5)}" fill="none" stroke="#ef4444" stroke-width="${sw - 4}" stroke-linecap="round" opacity="0.7"/>
      ${rsi != null ? `
        <line x1="${cx}" y1="${cy}" x2="${np.x}" y2="${np.y}" stroke="${needleColor}" stroke-width="3" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="5" fill="${needleColor}"/>
        <circle cx="${np.x}" cy="${np.y}" r="6" fill="${needleColor}" opacity="0.9"/>
      ` : ''}
      <!-- Zone labels -->
      <text x="10"  y="108" fill="#22c55e" font-size="9" font-family="DM Mono,monospace" opacity="0.8">0</text>
      <text x="90"  y="22"  fill="#FFD700" font-size="9" font-family="DM Mono,monospace" text-anchor="middle" opacity="0.8">50</text>
      <text x="164" y="108" fill="#ef4444" font-size="9" font-family="DM Mono,monospace" opacity="0.8">100</text>
    `;

    // Numeric readout
    const numEl   = document.getElementById('rsiNumber');
    const zoneEl  = document.getElementById('rsiZoneLabel');
    if (numEl)  numEl.textContent  = rsi != null ? rsi.toFixed(1) : '--';
    if (zoneEl) {
      if (rsi == null) {
        zoneEl.textContent  = 'N/A';
        zoneEl.className    = 'rsi-zone-label';
      } else if (rsi < 30) {
        zoneEl.textContent  = 'Extremely Oversold';
        zoneEl.className    = 'rsi-zone-label oversold';
      } else if (rsi < 45) {
        zoneEl.textContent  = 'Oversold';
        zoneEl.className    = 'rsi-zone-label oversold';
      } else if (rsi <= 70) {
        zoneEl.textContent  = 'Neutral';
        zoneEl.className    = 'rsi-zone-label neutral';
      } else {
        zoneEl.textContent  = 'Overbought';
        zoneEl.className    = 'rsi-zone-label overbought';
      }
    }
  }

  // Verdict card
  function renderVerdict(symbol, price, verdict, confidence, reasons) {
    const card = document.getElementById('verdictCard');
    const badge = document.getElementById('verdictBadge');
    if (card)  { card.className  = `verdict-card ${verdict.toLowerCase()}`; }
    if (badge) { badge.textContent = verdict; badge.className = `verdict-badge ${verdict.toLowerCase()}`; }

    const symEl  = document.getElementById('verdictSymbol');
    const priceEl= document.getElementById('verdictPrice');
    const confEl = document.getElementById('verdictConfidence');
    const rsnEl  = document.getElementById('verdictReason');

    if (symEl)  symEl.textContent  = symbol;
    if (priceEl) priceEl.textContent = '$' + fmtNum(price);
    if (confEl) confEl.textContent  = confidence + '%';
    if (rsnEl)  rsnEl.textContent   = reasons.join(' · ');
  }

  // Volume bars
  function renderVolume(volume, avgVolume) {
    const todayEl  = document.getElementById('volToday');
    const avgEl    = document.getElementById('volAvg');
    const barToday = document.getElementById('volBarToday');
    const barAvg   = document.getElementById('volBarAvg');
    const diffEl   = document.getElementById('volDiffBadge');

    if (todayEl) todayEl.textContent = fmtVol(volume);
    if (avgEl)   avgEl.textContent   = avgVolume ? fmtVol(Math.round(avgVolume)) : '--';

    if (barToday && barAvg && avgVolume) {
      const ratio   = volume / avgVolume;
      const todayPct = Math.min(ratio * 100, 200);  // cap bar at 200% of avg
      barToday.style.width = Math.min(todayPct / 2, 100) + '%';
      barAvg.style.width   = '50%'; // avg always at 50% reference

      if (diffEl) {
        const pctDiff = ((ratio - 1) * 100).toFixed(0);
        const surge   = ratio >= 1.5;
        diffEl.textContent = (ratio >= 1 ? '+' : '') + pctDiff + '% vs avg' + (surge ? ' — Volume Surge ⚡' : '');
        diffEl.className   = 'vol-diff-badge ' + (surge ? 'surge' : 'normal');
      }
    } else if (diffEl) {
      diffEl.textContent = 'Volume avg unavailable';
      diffEl.className   = 'vol-diff-badge normal';
    }
  }

  // Day range slider
  function renderDayRange(price, low, high) {
    const lowEl   = document.getElementById('rangeLow');
    const highEl  = document.getElementById('rangeHigh');
    const curEl   = document.getElementById('rangeCurrent');
    const fillBar = document.getElementById('rangeFillBar');
    const dotEl   = document.getElementById('rangeDotMarker');
    const pctEl   = document.getElementById('rangePctLabel');

    if (lowEl)  lowEl.textContent  = '$' + fmtNum(low,  2);
    if (highEl) highEl.textContent = '$' + fmtNum(high, 2);
    if (curEl)  curEl.textContent  = '$' + fmtNum(price,2);

    const range = high - low;
    const pct   = range > 0 ? Math.max(0, Math.min(100, ((price - low) / range) * 100)) : 50;

    if (fillBar) fillBar.style.width = pct + '%';
    if (dotEl)   dotEl.style.left    = pct + '%';
    if (pctEl)   pctEl.textContent   = fmtNum(pct, 1) + '% of today\'s range';
  }

  // Day direction
  function renderDirection(price, open) {
    const arrow = document.getElementById('directionArrow');
    const label = document.getElementById('directionLabel');
    const pct   = document.getElementById('directionPct');

    const bullish = price >= open;
    const change  = open ? ((price - open) / open) * 100 : 0;
    const sign    = change >= 0 ? '+' : '';

    if (arrow) { arrow.textContent = bullish ? '▲' : '▼'; arrow.className = 'direction-arrow ' + (bullish ? 'up' : 'down'); }
    if (label) { label.textContent = bullish ? 'Bullish' : 'Bearish'; label.className = 'direction-label ' + (bullish ? 'up' : 'down'); }
    if (pct)   pct.textContent  = sign + fmtNum(change, 2) + '% from open';
  }

  // Support/Resistance table
  function renderSR(resistance, support) {
    const table = document.getElementById('srTable');
    if (!table) return;

    const rows = [
      ...resistance.map((p, i) => ({ type: 'resistance', label: `R${i + 1}`, price: p, tag: 'Take Profit' })),
      ...support.map(   (p, i) => ({ type: 'support',    label: `S${i + 1}`, price: p, tag: 'Buy Zone'   })),
    ];

    table.innerHTML = rows.map(row => `
      <div class="sr-row ${row.type}">
        <div class="sr-level-info">
          <span class="sr-type">${row.type}</span>
          <span class="sr-name">${row.label} — 14-Day ${row.type === 'resistance' ? 'High' : 'Low'}</span>
        </div>
        <span class="sr-price">$${fmtNum(row.price)}</span>
        <span class="sr-tag">${row.tag}</span>
      </div>
    `).join('');
  }

  // ─── Countdown ring ───────────────────────────────────────────────────────

  function startCountdown() {
    stopCountdown();
    trader.countdownSecs = 60;
    updateCountdownUI(60);

    trader.countdownTimer = setInterval(() => {
      trader.countdownSecs -= 1;
      updateCountdownUI(trader.countdownSecs);

      if (trader.countdownSecs <= 0) {
        stopCountdown();
        if (trader.symbol) runAnalysis(trader.symbol);
      }
    }, 1000);
  }

  function stopCountdown() {
    if (trader.countdownTimer) {
      clearInterval(trader.countdownTimer);
      trader.countdownTimer = null;
    }
  }

  function updateCountdownUI(secs) {
    const numEl  = document.getElementById('countdownNum');
    const secsEl = document.getElementById('countdownSecs');
    const arc    = document.getElementById('countdownArc');

    if (numEl)  numEl.textContent  = secs;
    if (secsEl) secsEl.textContent = secs;

    if (arc) {
      const offset = CIRCUMFERENCE * (1 - secs / 60);
      arc.style.strokeDashoffset = offset;
    }
  }

  // ─── States ───────────────────────────────────────────────────────────────

  function showLoading(symbol) {
    $loading.style.display = 'flex';
    $results.style.display = 'none';
    $error.style.display   = 'none';
    $loadingTicker.textContent = symbol;
    $btn.disabled = true;
  }

  function showError(msg) {
    $loading.style.display = 'none';
    $results.style.display = 'none';
    $error.style.display   = 'flex';
    $errorMsg.textContent  = msg;
    $btn.disabled = false;
  }

  function showResults() {
    $loading.style.display = 'none';
    $error.style.display   = 'none';
    $results.style.display = 'flex';
    $btn.disabled = false;
  }

  // ─── Core: fetch + analyze ────────────────────────────────────────────────

  async function runAnalysis(symbol) {
    trader.symbol = symbol;
    showLoading(symbol);
    stopCountdown();

    try {
      const [quoteRes, histRes] = await Promise.all([
        fetch(`/api/quote/${symbol}`),
        fetch(`/api/historical/${symbol}?timeseries=30`),
      ]);

      if (!quoteRes.ok) throw new Error(`Quote fetch failed (${quoteRes.status})`);

      const quoteData = await quoteRes.json();
      if (quoteData.error) throw new Error(quoteData.error);

      // FMP quote via our proxy — extract price fields
      const price = quoteData?.latestTrade?.p;
      const open  = quoteData?.dailyBar?.o;
      const high  = quoteData?.dailyBar?.h;
      const low   = quoteData?.dailyBar?.l;
      const vol   = quoteData?.dailyBar?.v;

      if (!price) throw new Error('No price data returned for this symbol.');

      // Historical data for RSI + avg volume
      let closes = [], historical = [], avgVolume = null, rsi = null;
      let resistance = [], support = [];

      if (histRes.ok) {
        const histData = await histRes.json();
        historical = histData?.historical || [];

        if (historical.length >= 2) {
          // Reverse: FMP is newest-first; RSI needs oldest-first
          closes = [...historical].reverse().map(d => d.close);
          rsi    = calcRSI(closes, 14);
          avgVolume = calcAvgVolume(historical);
          const sr = calcSupportResistance(historical);
          resistance = sr.resistance;
          support    = sr.support;
        }
      }

      // Compute verdict
      const { verdict, confidence, reasons } = computeVerdict({
        rsi, price, open, high, low,
        volume: vol, avgVolume,
        resistance,
      });

      // Render all components
      renderVerdict(symbol, price, verdict, confidence, reasons);
      renderRSIGauge(rsi);
      renderVolume(vol, avgVolume);
      renderDayRange(price, low, high);
      renderDirection(price, open);
      renderSR(resistance, support);

      showResults();
      startCountdown();

    } catch (err) {
      console.error('[Trader]', err);
      showError(err.message || 'Could not analyze this symbol. Check the ticker and try again.');
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  function boot() {
    $input        = document.getElementById('traderTickerInput');
    $btn          = document.getElementById('traderAnalyzeBtn');
    $loading      = document.getElementById('traderLoading');
    $loadingTicker= document.getElementById('traderLoadingTicker');
    $error        = document.getElementById('traderError');
    $errorMsg     = document.getElementById('traderErrorMsg');
    $results      = document.getElementById('traderResults');

    if (!$input || !$btn) return;

    function triggerAnalysis() {
      const sym = $input.value.trim().toUpperCase();
      if (!sym) { $input.focus(); return; }
      runAnalysis(sym);
    }

    $btn.addEventListener('click', triggerAnalysis);

    $input.addEventListener('keydown', e => {
      if (e.key === 'Enter') triggerAnalysis();
    });

    const refreshBtn = document.getElementById('traderRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        if (trader.symbol) runAnalysis(trader.symbol);
      });
    }

    // Stop countdown when user leaves the Trader page
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.dataset.page !== 'trader') stopCountdown();
        else if (trader.symbol) {
          // Coming back to trader — restart if we have data
          // (results already showing, countdown just resumes)
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
