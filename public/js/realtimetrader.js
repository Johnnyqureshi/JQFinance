// ── Johnny Qureshi Finance — Realtime Trader Console (Intraday) ─────────────────

const rtTrader = (() => {
  const REFRESH_SECS = 60;
  let cdTimer    = null;
  let countdown  = 0;
  let currentSym = null;
  let reqToken   = 0;

  const $ = id => document.getElementById(id);
  const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtV = v => !v ? '--' : v >= 1e9 ? (v/1e9).toFixed(1)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v);
  // Null-safe DOM write helpers — elements may not exist when panel is unmounted
  const setSafe = (id, val)  => { const e = $(id); if (e) e.textContent = String(val); };
  const setCls  = (id, cls)  => { const e = $(id); if (e) e.className   = cls; };

  // ── VWAP (Volume Weighted Average Price) ────────────────────────────────────
  function calcVWAP(bars) {
    let sumTP = 0, sumV = 0;
    for (const b of bars) {
      if (b.v == null || b.h == null || b.l == null || b.c == null || b.v <= 0) continue;
      const tp = (b.h + b.l + b.c) / 3;
      sumTP += tp * b.v;
      sumV  += b.v;
    }
    return sumV > 0 ? sumTP / sumV : null;
  }

  // ── Intraday RSI (Wilder, 14-period on 5-min closes) ────────────────────────
  function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      d >= 0 ? gains += d : losses += Math.abs(d);
    }
    let avgG = gains / period, avgL = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgG = (avgG * (period - 1) + (d >= 0 ? d : 0)) / period;
      avgL = (avgL * (period - 1) + (d <  0 ? Math.abs(d) : 0)) / period;
    }
    if (!avgL) return 100;
    return 100 - 100 / (1 + avgG / avgL);
  }

  // ── Intraday Support & Resistance (pivot highs/lows from today's 5-min bars) ─
  function calcSR(bars, price) {
    if (bars.length < 3 || !price) return { support: null, resistance: null };
    const suppArr = [], resArr = [];
    for (let i = 1; i < bars.length - 1; i++) {
      if (bars[i].h > bars[i-1].h && bars[i].h > bars[i+1].h) resArr.push(bars[i].h);
      if (bars[i].l < bars[i-1].l && bars[i].l < bars[i+1].l) suppArr.push(bars[i].l);
    }
    const nearest = (arr, above) => {
      const filtered = above ? arr.filter(v => v > price) : arr.filter(v => v < price);
      if (!filtered.length) return null;
      return above
        ? Math.min(...filtered)
        : Math.max(...filtered);
    };
    return {
      support:    nearest(suppArr, false),
      resistance: nearest(resArr,  true),
    };
  }

  // ── Volume momentum ─────────────────────────────────────────────────────────
  function calcVolData(bars) {
    const vols   = bars.map(b => b.v || 0).filter(v => v > 0);
    const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const lastVol = bars.length ? (bars[bars.length - 1].v || 0) : 0;
    return { avgVol, lastVol, surge: avgVol > 0 && lastVol / avgVol > 1.5 };
  }

  // ── Price momentum: net bullish bars in last 5 candles ──────────────────────
  function calcMomentum(bars) {
    if (bars.length < 3) return 0;
    const last = bars.slice(-Math.min(5, bars.length));
    const up   = last.filter(b => b.c > b.o).length;
    const down = last.filter(b => b.c < b.o).length;
    return up - down;
  }

  // ── Signal engine ───────────────────────────────────────────────────────────
  function computeSignal(rsi, price, vwap, volData, momentum, sr, confluence, isFresh, searchSignal) {
    const searchLabel = String(searchSignal?.signal?.label || '').toUpperCase();
    if (searchLabel === 'BUY' || searchLabel === 'SELL') {
      return {
        signal: searchLabel,
        confidence: Number.isFinite(Number(searchSignal.confidence)) ? Math.round(Number(searchSignal.confidence)) : 30,
        reasons: Array.isArray(searchSignal.reasons) && searchSignal.reasons.length
          ? searchSignal.reasons.slice(0, 4)
          : ['Binary search signal derived from price, volume, pivots, and recent catalysts'],
      };
    }
    throw new Error('Verified Search signal unavailable');
    /*
    // The server-side technical engine is the authoritative path whenever it is
    // available. It evaluates higher timeframes and critical support/resistance,
    // avoiding a one-bar SELL call into a confirmed support response.
    if (confluence?.available && !isFresh) {
      return {
        signal: price >= (vwap ?? price) ? 'BUY' : 'SELL', confidence: 30,
        reasons: ['DATA STALE — SIGNAL CONFIDENCE REDUCED', 'Fallback direction uses price versus VWAP'],
      };
    }
    if (confluence?.available) {
      const scores = confluence.scores || {};
      const signal = confluence.signal || {};
      if (confluence.dataQuality?.fresh !== true) {
        return {
          signal: price >= (vwap ?? price) ? 'BUY' : 'SELL', confidence: 30,
          reasons: ['STALE OR UNVERIFIED MARKET DATA', 'Fallback direction uses price versus VWAP'],
        };
      }
      const support = confluence.levels?.criticalSupport;
      const resistance = confluence.levels?.criticalResistance;
      const supportNote = support?.price != null ? `Critical support $${fmt(support.price)}` : 'No verified support level';
      const resistanceNote = resistance?.price != null ? `Critical resistance $${fmt(resistance.price)}` : 'No verified resistance level';
      if (signal.stage === 'CONFIRMED' && scores.bullish >= 68 && scores.drawdown < scores.bullish) {
        return {
          signal: 'BUY', confidence: scores.setupQuality || scores.bullish,
          reasons: [signal.label, supportNote, `Bounce estimate ${scores.bounce}%`, 'Multiple independent technical confirmations'],
        };
      }
      if (signal.stage === 'ENTRY CONFIRMATION' && scores.bullish >= 58 && scores.drawdown < scores.bullish) {
        return {
          signal: 'BUY', confidence: scores.setupQuality || scores.bullish,
          reasons: [signal.label, `Wait for confirmation level`, supportNote, `Bullish ${scores.bullish}% vs drawdown ${scores.drawdown}%`],
        };
      }
      if (signal.label?.includes('BEARISH') || signal.label?.includes('DRAWDOWN')) {
        // Never call a short-style SELL into nearby, unbroken support. The signal
        // becomes actionable only after the deterministic engine confirms that
        // support has failed.
        if (support?.distancePct != null && support.distancePct <= 1 && signal.stage !== 'INVALIDATED') {
          return {
            signal: 'SELL', confidence: scores.setupQuality || scores.bearish,
            reasons: ['Elevated drawdown risk, but price remains at critical support', supportNote, 'Wait for a support break before treating it as bearish confirmation'],
          };
        }
        return {
          signal: 'SELL', confidence: scores.setupQuality || scores.bearish,
          reasons: [signal.label, resistanceNote, `Drawdown estimate ${scores.drawdown}%`, 'Multiple bearish confirmations'],
        };
      }
      return {
        signal: scores.bullish >= scores.bearish ? 'BUY' : 'SELL', confidence: scores.setupQuality || 50,
        reasons: [signal.label || 'NO CLEAR EDGE', supportNote, resistanceNote, 'Signals conflict — wait for confirmation'],
      };
    }

    // The shared confluence path is unavailable, so do not fall back to a
    // simplified one-bar BUY/SELL rule. It would be inconsistent with the bot.
    if (!confluence?.available) {
      return {
        signal: price >= (vwap ?? price) ? 'BUY' : 'SELL', confidence: 30,
        reasons: ['Technical confluence unavailable', 'No directional call without support/resistance and multi-timeframe confirmation'],
      };
    }

    const aboveVwap  = vwap != null && price > vwap;
    const belowVwap  = vwap != null && price < vwap;

    let signal = price >= (vwap ?? price) ? 'BUY' : 'SELL', confidence = 50, reasons = [];

    if (rsi !== null && rsi < 40 && aboveVwap && momentum >= 2) {
      signal = 'BUY'; confidence = 78;
      reasons = ['RSI deeply oversold (< 40)', 'Price trading above VWAP', 'Strong bullish bar sequence'];
    } else if (rsi !== null && rsi < 45 && aboveVwap && volData.surge) {
      signal = 'BUY'; confidence = 70;
      reasons = ['RSI below 45 with recovery signal', 'Price above VWAP', 'Volume surge confirms move'];
    } else if (sr.support && price <= sr.support * 1.005 && aboveVwap && momentum >= 1) {
      signal = 'BUY'; confidence = 63;
      reasons = ['Price bouncing off intraday support', 'Price above VWAP', 'Bullish momentum at demand zone'];
    } else if (sr.support && price <= sr.support * 1.006) {
      // A nearby support test needs confirmation, not a forced directional call.
      signal = price >= (vwap ?? price) ? 'BUY' : 'SELL'; confidence = 54;
      reasons = ['Price is testing intraday support', 'Wait for a break or a confirmed bounce', 'Fallback signal has limited context'];
    } else if (rsi !== null && rsi > 70 && belowVwap) {
      signal = 'SELL'; confidence = 76;
      reasons = ['RSI overbought (> 70)', 'Price below VWAP — bearish bias', 'Overbought + below equilibrium'];
    } else if (rsi !== null && rsi > 65 && momentum <= -2) {
      signal = 'SELL'; confidence = 70;
      reasons = ['RSI elevated above 65', 'Strong bearish bar sequence', 'Momentum divergence'];
    } else if (sr.resistance && price >= sr.resistance * 0.995 && belowVwap) {
      signal = 'SELL'; confidence = 62;
      reasons = ['Price pressing into intraday resistance', 'Price below VWAP', 'Supply zone + bearish bias'];
    } else {
      if (aboveVwap && momentum > 0) {
        confidence = 57;
        reasons = ['Price above VWAP — mild bullish bias', 'RSI in neutral range', 'Monitor for breakout confirmation'];
      } else if (belowVwap && momentum < 0) {
        confidence = 52;
        reasons = ['Price below VWAP — mild bearish bias', 'RSI neutral', 'No strong entry signal yet'];
      } else {
        confidence = 50;
        reasons = ['Price near VWAP equilibrium', 'RSI neutral, no extreme reads', 'Await directional breakout'];
      }
    }

    return { signal, confidence, reasons };
    */
  }

  // ── Fixed Range Volume Profile (FRVP) ───────────────────────────────────────
  function calcVolumeProfile(bars, numBuckets = 24) {
    if (!bars || bars.length < 3) return null;

    // Global high/low across all intraday bars
    let hi = -Infinity, lo = Infinity;
    for (const b of bars) {
      if (b.h != null && b.h > hi) hi = b.h;
      if (b.l != null && b.l < lo) lo = b.l;
    }
    if (!isFinite(hi) || !isFinite(lo) || hi - lo < 0.001) return null;

    const range      = hi - lo;
    const bucketSize = range / numBuckets;

    // Create price buckets
    const buckets = Array.from({ length: numBuckets }, (_, i) => ({
      low:    lo + i * bucketSize,
      high:   lo + (i + 1) * bucketSize,
      center: lo + (i + 0.5) * bucketSize,
      volume: 0,
    }));

    // Distribute each bar's volume proportionally across overlapping buckets
    for (const b of bars) {
      if (b.h == null || b.l == null || !b.v || b.v <= 0) continue;
      const bRange = b.h - b.l;
      if (bRange < 0.001) {
        // Zero-range bar — put all volume at closest bucket
        const idx = Math.max(0, Math.min(numBuckets - 1, Math.floor((b.c - lo) / bucketSize)));
        buckets[idx].volume += b.v;
        continue;
      }
      for (let bi = 0; bi < numBuckets; bi++) {
        const overlap = Math.min(b.h, buckets[bi].high) - Math.max(b.l, buckets[bi].low);
        if (overlap > 0) buckets[bi].volume += b.v * (overlap / bRange);
      }
    }

    // Point of Control — bucket with the most volume
    let pocIdx = 0;
    for (let i = 1; i < numBuckets; i++) {
      if (buckets[i].volume > buckets[pocIdx].volume) pocIdx = i;
    }

    // Value Area — expand from POC until 70% of total volume is captured
    const totalVol = buckets.reduce((s, b) => s + b.volume, 0);
    const vaTarget = totalVol * 0.70;
    let vaVol = buckets[pocIdx].volume;
    let vaLo = pocIdx, vaHi = pocIdx;

    while (vaVol < vaTarget) {
      const canUp   = vaHi < numBuckets - 1;
      const canDown = vaLo > 0;
      if (!canUp && !canDown) break;
      const upVol   = canUp   ? buckets[vaHi + 1].volume : -1;
      const downVol = canDown ? buckets[vaLo - 1].volume : -1;
      if (upVol >= downVol) { vaHi++; vaVol += buckets[vaHi].volume; }
      else                  { vaLo--; vaVol += buckets[vaLo].volume; }
    }

    const maxVol = Math.max(...buckets.map(b => b.volume));

    return {
      buckets, numBuckets, pocIdx, vaLo, vaHi,
      poc: buckets[pocIdx].center,
      vah: buckets[vaHi].high,
      val: buckets[vaLo].low,
      globalHigh: hi, globalLow: lo,
      totalVol, maxVol,
    };
  }

  // ── Draw Volume Profile on canvas ───────────────────────────────────────────
  function drawVolumeProfile(vp, price) {
    const canvas = $('rtVPCanvas');
    if (!canvas || !vp) return;

    const DPR  = Math.min(window.devicePixelRatio || 1, 2);
    const W    = canvas.parentElement ? canvas.parentElement.clientWidth || 360 : 360;
    const H    = 170;
    canvas.width        = W * DPR;
    canvas.height       = H * DPR;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.clearRect(0, 0, W, H);

    const PAD_L  = 46; // space for side labels
    const PAD_R  = 36; // space for price labels on right
    const PAD_T  = 6;
    const PAD_B  = 6;
    const chartW = W - PAD_L - PAD_R;
    const chartH = H - PAD_T - PAD_B;
    const n      = vp.numBuckets;
    const rowH   = chartH / n;

    // Draw each bucket row (bucket 0 = lowest price → bottom of chart)
    for (let i = 0; i < n; i++) {
      const bkt    = vp.buckets[i];
      const barW   = vp.maxVol > 0 ? (bkt.volume / vp.maxVol) * chartW : 0;
      const y      = PAD_T + (n - 1 - i) * rowH; // high bucket = top of chart
      const isPOC  = i === vp.pocIdx;
      const isVA   = i >= vp.vaLo && i <= vp.vaHi;

      // Row background
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
        ctx.fillRect(PAD_L, y, chartW, rowH);
      }

      // Volume bar
      if (isPOC) {
        ctx.fillStyle = 'rgba(245,200,66,0.75)';
      } else if (isVA) {
        ctx.fillStyle = 'rgba(29,214,163,0.28)';
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
      }
      if (barW > 0.5) ctx.fillRect(PAD_L, y + 1, barW, Math.max(1.5, rowH - 1.5));

      // Right-side price labels for key levels
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      const midY = y + rowH / 2;
      if (isPOC) {
        ctx.fillStyle = 'rgba(245,200,66,0.95)';
        ctx.font      = 'bold 8.5px DM Mono, monospace';
        ctx.fillText('$' + fmt(bkt.center), PAD_L + chartW + 4, midY);
      } else if (i === vp.vaHi) {
        ctx.fillStyle = 'rgba(29,214,163,0.80)';
        ctx.font      = '8px DM Mono, monospace';
        ctx.fillText('$' + fmt(bkt.high), PAD_L + chartW + 4, midY);
      } else if (i === vp.vaLo) {
        ctx.fillStyle = 'rgba(29,214,163,0.80)';
        ctx.font      = '8px DM Mono, monospace';
        ctx.fillText('$' + fmt(bkt.low), PAD_L + chartW + 4, midY);
      }
    }

    // Left axis labels
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.font         = '8px DM Mono, monospace';
    const labelSteps = [0, 0.25, 0.5, 0.75, 1];
    for (const t of labelSteps) {
      const p = vp.globalLow + t * (vp.globalHigh - vp.globalLow);
      const y = PAD_T + (1 - t) * chartH;
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillText('$' + fmt(p), PAD_L - 3, y);
    }

    const priceToY = p =>
      PAD_T + ((vp.globalHigh - p) / (vp.globalHigh - vp.globalLow)) * chartH;

    // POC dashed line
    const pocY = priceToY(vp.poc);
    ctx.strokeStyle = 'rgba(245,200,66,0.55)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(PAD_L, pocY); ctx.lineTo(PAD_L + chartW, pocY); ctx.stroke();
    ctx.setLineDash([]);

    // Left labels: POC, VAH, VAL
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.font         = 'bold 8px DM Mono, monospace';
    ctx.fillStyle    = 'rgba(245,200,66,0.90)';
    ctx.fillText('POC', PAD_L - 3, pocY);

    const vahY = priceToY(vp.vah);
    ctx.strokeStyle = 'rgba(29,214,163,0.35)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(PAD_L, vahY); ctx.lineTo(PAD_L + chartW, vahY); ctx.stroke();
    ctx.font      = '7.5px DM Mono, monospace';
    ctx.fillStyle = 'rgba(29,214,163,0.75)';
    ctx.fillText('VAH', PAD_L - 3, vahY);

    const valY = priceToY(vp.val);
    ctx.beginPath(); ctx.moveTo(PAD_L, valY); ctx.lineTo(PAD_L + chartW, valY); ctx.stroke();
    ctx.fillText('VAL', PAD_L - 3, valY);
    ctx.setLineDash([]);

    // Current price line
    if (price >= vp.globalLow && price <= vp.globalHigh) {
      const curY = priceToY(price);
      ctx.strokeStyle = 'rgba(255,255,255,0.80)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(PAD_L, curY); ctx.lineTo(PAD_L + chartW, curY); ctx.stroke();
      ctx.setLineDash([]);

      // "NOW" label
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'middle';
      ctx.font         = 'bold 8px DM Mono, monospace';
      ctx.fillStyle    = 'rgba(255,255,255,0.85)';
      ctx.fillText('NOW', PAD_L - 3, curY);
    }
  }

  // ── Render Volume Profile panel ──────────────────────────────────────────────
  function renderVolumeProfile(vp, price) {
    const panel = $('rtVPPanel');
    if (!panel) return;

    if (!vp) {
      panel.style.display = 'none';
      return;
    }

    // Draw the canvas chart
    // Defer to allow panel to be visible + sized first
    requestAnimationFrame(() => drawVolumeProfile(vp, price));

    // Fill metric cells (null-safe — panel may not be in DOM)
    setSafe('rtVPPoc', '$' + fmt(vp.poc));
    setSafe('rtVPVah', '$' + fmt(vp.vah));
    setSafe('rtVPVal', '$' + fmt(vp.val));

    const pocPct = ((price - vp.poc) / vp.poc * 100);
    const pocEl  = $('rtVPPocSub');
    if (pocEl) {
      pocEl.textContent = (pocPct >= 0 ? '+' : '') + pocPct.toFixed(2) + '% vs price';
      pocEl.className   = 'rt-vp-msub ' + (pocPct >= 0 ? 'above' : 'below');
    }

    // Price zone label
    const zoneEl = $('rtVPZone');
    if (zoneEl) {
      if (price > vp.vah) {
        zoneEl.textContent  = '▲ Above Value Area';
        zoneEl.className    = 'rt-vp-zone above';
      } else if (price < vp.val) {
        zoneEl.textContent  = '▼ Below Value Area';
        zoneEl.className    = 'rt-vp-zone below';
      } else if (Math.abs(price - vp.poc) / vp.poc < 0.003) {
        zoneEl.textContent  = '◆ At Point of Control';
        zoneEl.className    = 'rt-vp-zone poc';
      } else if (price > vp.poc) {
        zoneEl.textContent  = '↑ Inside VA — Above POC';
        zoneEl.className    = 'rt-vp-zone above';
      } else {
        zoneEl.textContent  = '↓ Inside VA — Below POC';
        zoneEl.className    = 'rt-vp-zone below';
      }
    }

    panel.style.display = '';
  }

  // ── Daily Pivot Points (Floor Pivots from prior session OHLC) ───────────────
  function calcDailyPivots(dailyBars, price) {
    // dailyBars are newest-first; [0] = today (partial), [1] = yesterday (complete)
    if (!dailyBars || dailyBars.length < 2) return null;
    const yest = dailyBars[1];
    if (!yest) return null;
    const H = yest.high, L = yest.low, C = yest.close;
    if (!H || !L || !C) return null;

    const pp = (H + L + C) / 3;
    const r1 = 2 * pp - L;
    const r2 = pp + (H - L);
    const s1 = 2 * pp - H;
    const s2 = pp - (H - L);

    const impliedMove    = r1 - s1;
    const impliedMovePct = price ? (impliedMove / price) * 100 : 0;

    let zone, zoneClass;
    if      (price >= r2) { zone = 'Above R2';   zoneClass = 'zone-bull'; }
    else if (price >= r1) { zone = 'R1–R2 Zone'; zoneClass = 'zone-bull'; }
    else if (price >= pp) { zone = 'PP–R1 Zone'; zoneClass = 'zone-bull'; }
    else if (price >= s1) { zone = 'S1–PP Zone'; zoneClass = 'zone-bear'; }
    else if (price >= s2) { zone = 'S2–S1 Zone'; zoneClass = 'zone-bear'; }
    else                  { zone = 'Below S2';   zoneClass = 'zone-bear'; }

    return { pp, r1, r2, s1, s2, impliedMove, impliedMovePct, zone, zoneClass };
  }

  // ── Render Daily Pivots Panel (RT console) ───────────────────────────────────
  function renderDailyPivots(pivots, price) {
    const panel = $('rtPivotPanel');
    const body  = $('rtPivotBody');
    const imp   = $('rtPivotImplied');
    const zoneEl = $('rtPivotZone');
    if (!panel || !body) return;

    if (!pivots) { panel.style.display = 'none'; return; }

    if (imp) {
      imp.textContent = '$' + fmt(pivots.impliedMove) + ' · ' + pivots.impliedMovePct.toFixed(2) + '% implied range';
    }
    if (zoneEl) {
      zoneEl.textContent = pivots.zone;
      zoneEl.className   = 'rt-pivot-zone ' + pivots.zoneClass;
    }

    // Build level ladder (high to low), insert price marker between levels
    const levels = [
      { lbl: 'R2', val: pivots.r2, type: 'res-2' },
      { lbl: 'R1', val: pivots.r1, type: 'res-1', key: true },
      { lbl: 'PP', val: pivots.pp, type: 'pivot'  },
      { lbl: 'S1', val: pivots.s1, type: 'sup-1', key: true },
      { lbl: 'S2', val: pivots.s2, type: 'sup-2' },
    ].sort((a, b) => b.val - a.val);

    let html = '', placed = false;
    for (const lvl of levels) {
      if (!placed && price >= lvl.val) {
        html += `<div class="rt-pivot-row price-mark">
          <span class="rt-pivot-cur-lbl">▶ PRICE</span>
          <span class="rt-pivot-cur-val">$${fmt(price)}</span>
          <span class="rt-pivot-cur-sep"></span>
        </div>`;
        placed = true;
      }
      const dist    = price ? ((lvl.val - price) / price * 100) : 0;
      const distStr = (dist >= 0 ? '+' : '') + fmt(Math.abs(dist), 2) + '%';
      const distCls = dist > 0 ? 'above' : dist < 0 ? 'below' : '';
      html += `<div class="rt-pivot-row ${lvl.type}${lvl.key ? ' key' : ''}">
        <span class="rt-pivot-lbl">${lvl.lbl}</span>
        <span class="rt-pivot-val">$${fmt(lvl.val)}</span>
        <span class="rt-pivot-pct ${distCls}">${distStr} ${dist > 0 ? '↑' : dist < 0 ? '↓' : ''}</span>
      </div>`;
    }
    if (!placed) {
      html += `<div class="rt-pivot-row price-mark">
        <span class="rt-pivot-cur-lbl">▶ PRICE</span>
        <span class="rt-pivot-cur-val">$${fmt(price)}</span>
        <span class="rt-pivot-cur-sep"></span>
      </div>`;
    }

    body.innerHTML = html;
    panel.style.display = '';
  }

  // ── ATR (Average True Range, 14-period on daily bars) ───────────────────────
  function calcATR(dailyBars, period = 14) {
    if (!dailyBars || dailyBars.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < dailyBars.length && trs.length < period; i++) {
      const cur  = dailyBars[i];
      const prev = dailyBars[i + 1]; // bars are newest-first from the server
      if (!cur || !prev || !cur.high || !cur.low || !cur.close || !prev.close) continue;
      trs.push(Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low  - prev.close)
      ));
    }
    if (trs.length < Math.floor(period / 2)) return null;
    return trs.reduce((s, v) => s + v, 0) / trs.length;
  }

  // ── Render candle patterns for a specific timeframe ─────────────────────────
  function renderCandlePatterns(patterns, listId, emptyLabel) {
    const listEl = $(listId);
    if (!listEl) return;

    const items = Array.isArray(patterns) ? patterns : [];
    if (!items.length) {
      listEl.innerHTML = `<span class="rt-patterns-empty">${emptyLabel}</span>`;
      return;
    }

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));

    listEl.innerHTML = items.map(pattern => {
      const type = pattern?.type;
      const cls = type === 'BULLISH' ? 'cp-bull' : type === 'BEARISH' ? 'cp-bear' : 'cp-neutral';
      const arrow = type === 'BULLISH' ? '▲' : type === 'BEARISH' ? '▼' : '●';
      const strength = Math.max(1, Math.min(3, Number(pattern?.strength) || 1));
      const dots = '●'.repeat(strength) + '○'.repeat(3 - strength);
      const desc = String(pattern?.desc || '').split(' — ').pop();
      return `<div class="cp-row ${cls}">
        <div class="cp-row-top">
          <span class="cp-badge ${cls}">${arrow}</span>
          <span class="cp-name">${escapeHtml(pattern?.name || 'Pattern')}</span>
          <span class="cp-strength">${dots}</span>
        </div>
        <div class="cp-desc">${escapeHtml(desc)}</div>
      </div>`;
    }).join('');
  }

  // ── Countdown timer ─────────────────────────────────────────────────────────
  function startCountdown(onDone) {
    clearInterval(cdTimer);
    countdown = REFRESH_SECS;
    const el = $('rtCdSecs');
    const update = () => { if (el) el.textContent = countdown; };
    update();
    cdTimer = setInterval(() => {
      countdown--;
      update();
      if (countdown <= 0) { clearInterval(cdTimer); if (onDone) onDone(); }
    }, 1000);
  }

  // ── Render results ──────────────────────────────────────────────────────────
  function render(sym, bars, price, dailyBars, marketState, gamePlan, dailyPatterns, intradayPatterns) {
    const closes  = bars.map(b => b.c);
    const vwap    = Number.isFinite(Number(gamePlan?.indicators?.vwap))
      ? Number(gamePlan.indicators.vwap)
      : null;
    const rsi     = calcRSI(closes);
    const sr      = calcSR(bars, price);
    const volData = calcVolData(bars);
    const momentum = calcMomentum(bars);
    const confluence = gamePlan?.confluence || null;
    const generated = Date.parse(gamePlan?.generatedAt || '');
    const fresh = Number.isFinite(generated) && Date.now() - generated <= 90_000;
    const { signal, confidence, reasons } = computeSignal(rsi, price, vwap, volData, momentum, sr, confluence, fresh, gamePlan?.searchSignal);

    // Verdict
    const vb = $('rtVerdict');
    if (vb) {
      ['buy', 'hold', 'wait', 'sell'].forEach(c => vb.classList.remove(c));
      vb.classList.add(signal.toLowerCase());
      vb.textContent = signal;
    }
    setSafe('rtConf',   confidence + '% confidence');
    setSafe('rtSym',    sym);
    setSafe('rtReason', reasons.join(' · '));

    // VWAP
    if (vwap != null) {
      const diff    = ((price - vwap) / vwap * 100);
      const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '% vs price';
      setSafe('rtVwap',    '$' + fmt(vwap));
      setSafe('rtVwapSub', diffStr);
      setCls ('rtVwapSub', 'rt-m-sub ' + (price > vwap ? 'up' : 'down'));
    } else {
      setSafe('rtVwap',    '--');
      setSafe('rtVwapSub', 'No data');
      setCls ('rtVwapSub', 'rt-m-sub');
    }

    // RSI (element removed from RT console — shown in Trading Signals panel instead)
    const rsiZone = rsi === null ? '--'
      : rsi < 30 ? 'Oversold' : rsi < 45 ? 'Low' : rsi > 70 ? 'Overbought' : rsi > 60 ? 'High' : 'Neutral';
    const rsiCls  = rsi === null ? '' : rsi < 45 ? 'up' : rsi > 65 ? 'down' : 'neut';
    const rtRsiEl = $('rtRsi');
    if (rtRsiEl) {
      rtRsiEl.textContent             = rsi !== null ? fmt(rsi, 1) : '--';
      $('rtRsiZone').textContent      = rsiZone;
      $('rtRsiZone').className        = 'rt-m-sub ' + rsiCls;
    }

    // Volume
    const volSurge = volData.surge;
    setSafe('rtVol',    fmtV(volData.lastVol));
    setSafe('rtVolSub', volSurge
      ? 'Surge vs avg ' + fmtV(Math.round(volData.avgVol))
      : (volData.avgVol ? 'Avg ' + fmtV(Math.round(volData.avgVol)) : '--'));
    setCls ('rtVolSub', 'rt-m-sub ' + (volSurge ? 'up' : ''));

    // Sentiment (momentum-based)
    const sentLabel = signal === 'BUY' ? 'Buying evidence' : 'Selling evidence';
    const sentCls   = signal === 'BUY' ? 'up' : 'down';
    const momDesc   = 'Verified Search snapshot';
    setSafe('rtSent',    sentLabel);
    setSafe('rtSentSub', 'Last 5 · ' + momDesc);
    setCls ('rtSentSub', 'rt-m-sub ' + sentCls);

    // Support / Resistance (elements removed from RT console — shown in Trading Signals panel instead)
    const rtSupportEl = $('rtSupport');
    if (rtSupportEl) {
      if (sr.support != null) {
        const pct = ((price - sr.support) / price * 100).toFixed(2);
        rtSupportEl.textContent           = '$' + fmt(sr.support);
        $('rtSupportSub').textContent     = pct + '% below';
        $('rtSupportSub').className       = 'rt-m-sub';
      } else {
        rtSupportEl.textContent           = '--';
        $('rtSupportSub').textContent     = 'No level';
        $('rtSupportSub').className       = 'rt-m-sub';
      }
    }
    const rtResistanceEl = $('rtResistance');
    if (rtResistanceEl) {
      if (sr.resistance != null) {
        const pct = ((sr.resistance - price) / price * 100).toFixed(2);
        rtResistanceEl.textContent           = '$' + fmt(sr.resistance);
        $('rtResistanceSub').textContent     = pct + '% above';
        $('rtResistanceSub').className       = 'rt-m-sub';
      } else {
        rtResistanceEl.textContent           = '--';
        $('rtResistanceSub').textContent     = 'No level';
        $('rtResistanceSub').className       = 'rt-m-sub';
      }
    }

    // Timestamp + market state badge
    setSafe('rtUpdated', 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
    const msEl = $('rtMarketState');
    if (msEl) {
      const isCrypto = sym.includes('-');
      const isPost   = !isCrypto && ['POST', 'POSTPOST'].includes(marketState);
      const isPre    = !isCrypto && ['PRE',  'PREPRE' ].includes(marketState);
      const isClosed = !isCrypto && marketState === 'CLOSED';
      msEl.textContent  = isCrypto ? '24/7 CRYPTO' : isPost ? 'AFTER HOURS' : isPre ? 'PRE-MARKET' : isClosed ? 'MARKET CLOSED' : 'MARKET OPEN';
      msEl.className    = 'rt-market-state-badge ' + (isCrypto ? 'crypto' : isPost ? 'post' : isPre ? 'pre' : isClosed ? 'closed' : 'open');
      msEl.style.display = '';
    }

    $('rtLoading').style.display = 'none';
    $('rtError').style.display   = 'none';
    $('rtResults').style.display = 'grid';

    // Fixed Range Volume Profile
    const vp = calcVolumeProfile(bars);
    renderVolumeProfile(vp, price);

    // Daily pivot levels + implied move
    const pivots = calcDailyPivots(dailyBars || [], price);
    renderDailyPivots(pivots, price);

    // Keep the slower daily context separate from the actionable 5-minute read.
    renderCandlePatterns(dailyPatterns, 'rtDailyPatternsList', 'No significant patterns detected on daily bars');
    renderCandlePatterns(intradayPatterns, 'rtIntradayPatternsList', 'No significant patterns detected on 5-min bars');

    startCountdown(() => analyze(sym));
  }

  // ── Analyze ─────────────────────────────────────────────────────────────────
  async function analyze(sym, suppliedAnalysis = null) {
    sym = sym.toUpperCase().trim();
    if (!sym) return;
    currentSym = sym;
    const tok = ++reqToken;

    $('rtLoading').style.display = 'flex';
    $('rtError').style.display   = 'none';
    $('rtResults').style.display = 'none';
    const ls = $('rtLoadSym'); if (ls) ls.textContent = sym;
    clearInterval(cdTimer);

    try {
      const [intradayRes, histRes, gamePlanRes, dailyPatternRes] = await Promise.all([
        fetch(`/api/intraday/${sym}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/historical/${sym}?timeseries=20`).then(r => r.ok ? r.json() : null).catch(() => null),
        suppliedAnalysis || window.searchContext.load(sym),
        fetch(`/api/patterns/${sym}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (tok !== reqToken || sym !== currentSym) return;

      const price       = gamePlanRes?.snapshot?.price ?? null;
      const bars        = intradayRes?.bars || [];
      const dailyBars   = histRes?.historical || [];
      const dailyPatterns = dailyPatternRes?.patterns || [];
      const intradayPatterns = intradayRes?.intradayPatterns || [];
      const marketState = gamePlanRes?.snapshot?.marketState ?? intradayRes?.marketState ?? 'REGULAR';

      if (!price) throw new Error('Unable to fetch quote for ' + sym);
      if (bars.length < 2) throw new Error('No price data available for ' + sym + ' — try again shortly.');

      $('rtInput').value = sym;
      render(sym, bars, price, dailyBars, marketState, gamePlanRes, dailyPatterns, intradayPatterns);

    } catch (e) {
      $('rtLoading').style.display = 'none';
      $('rtError').style.display   = 'flex';
      const em = $('rtErrMsg'); if (em) em.textContent = e.message || 'Failed to analyze. Please try again.';
    }
  }

  // ── Public: load from main search ───────────────────────────────────────────
  function load(sym, suppliedAnalysis = null) {
    analyze(sym, suppliedAnalysis);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    $('rtRefreshBtn')?.addEventListener('click', () => {
      if (currentSym) analyze(currentSym);
    });

    const input = $('rtInput');
    const drop  = $('rtDrop');
    if (!input) return;

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = input.value.trim();
        if (v) { if (drop) drop.style.display = 'none'; analyze(v); }
      }
    });

    let searchTimer;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (!q) { if (drop) drop.style.display = 'none'; return; }
      searchTimer = setTimeout(async () => {
        try {
          const res   = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
          const items = await res.json();
          if (!drop) return;
          if (!items.length) { drop.style.display = 'none'; return; }
          drop.replaceChildren();
          items.forEach(it => {
            const d    = document.createElement('div');
            d.className = 'drop-item';
            const sym  = document.createElement('span');
            sym.className   = 'drop-sym';
            sym.textContent = it.symbol;
            const name = document.createElement('span');
            name.className   = 'drop-name';
            name.textContent = it.name;
            d.append(sym, name);
            d.addEventListener('mousedown', () => {
              input.value        = it.symbol;
              drop.style.display = 'none';
              analyze(it.symbol);
            });
            drop.appendChild(d);
          });
          drop.style.display = 'block';
        } catch {}
      }, 280);
    });

    input.addEventListener('blur', () => {
      setTimeout(() => { if (drop) drop.style.display = 'none'; }, 200);
    });
  }

  return { init, load, analyze };
})();

document.addEventListener('DOMContentLoaded', () => rtTrader.init());
