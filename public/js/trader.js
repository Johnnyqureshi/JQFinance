// ── Johnny Qureshi Finance — Realtime Trader ────────────────────────────────────

const trader = (() => {
  const REFRESH_SECS = 60;
  let   countdown    = 0;
  let   cdTimer      = null;
  let   currentSym   = null;
  let   reqToken     = 0;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $  = id => document.getElementById(id);
  const ui = {
    loading: ()=>$('traderLoading'),
    loadSym: ()=>$('traderLoadingTicker'),
    error:   ()=>$('traderError'),
    errorMsg:()=>$('traderErrorMsg'),
    results: ()=>$('traderResults'),
  };

  // ── Utils ───────────────────────────────────────────────────────────────────
  const fmt  = (n,d=2) => n==null||isNaN(n)?'--':Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  const fmtV = v => !v?'--':v>=1e9?(v/1e9).toFixed(1)+'B':v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':String(v);

  // ── RSI (Wilder, 14-period) ─────────────────────────────────────────────────
  function calcRSI(closes, period=14) {
    if (closes.length < period+1) return null;
    let gains=0, losses=0;
    for (let i=1; i<=period; i++) {
      const d = closes[i]-closes[i-1];
      d>=0 ? gains+=d : losses+=Math.abs(d);
    }
    let avgG=gains/period, avgL=losses/period;
    for (let i=period+1; i<closes.length; i++) {
      const d = closes[i]-closes[i-1];
      avgG = (avgG*(period-1)+(d>=0?d:0))/period;
      avgL = (avgL*(period-1)+(d<0?Math.abs(d):0))/period;
    }
    if (!avgL) return 100;
    return 100 - 100/(1+avgG/avgL);
  }

  // ── Render pivot panel into home page card ──────────────────────────────────
  function renderPivots(container, pivots, price) {
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
        html += `<div class="pv-row pv-price">
          <span class="pv-cur-lbl">▶ PRICE</span>
          <span class="pv-cur-val">$${fmt(price)}</span>
          <span></span>
        </div>`;
        placed = true;
      }
      const dist    = price ? ((lvl.val - price) / price * 100) : 0;
      const distStr = (dist >= 0 ? '+' : '') + fmt(Math.abs(dist), 2) + '%';
      const distCls = dist > 0 ? 'above' : dist < 0 ? 'below' : '';
      html += `<div class="pv-row ${lvl.type}${lvl.key ? ' key' : ''}">
        <span class="pv-lbl">${lvl.lbl}</span>
        <span class="pv-val">$${fmt(lvl.val)}</span>
        <span class="pv-pct ${distCls}">${distStr} ${dist > 0 ? '↑' : dist < 0 ? '↓' : ''}</span>
      </div>`;
    }
    if (!placed) {
      html += `<div class="pv-row pv-price">
        <span class="pv-cur-lbl">▶ PRICE</span>
        <span class="pv-cur-val">$${fmt(price)}</span>
        <span></span>
      </div>`;
    }
    container.innerHTML = html;
  }

  // ── Signal logic ────────────────────────────────────────────────────────────
  function computeSignal(searchSignal) {
    const label = String(searchSignal?.signal?.label || '').toUpperCase();
    const confidence = Number.isFinite(Number(searchSignal?.confidence))
      ? Math.max(0, Math.min(100, Math.round(Number(searchSignal.confidence))))
      : 0;
    const reasons = Array.isArray(searchSignal?.reasons) && searchSignal.reasons.length
      ? searchSignal.reasons.slice(0, 4)
      : ['Verified multi-timeframe price and volume evidence'];

    if (label === 'BUY') {
      return { signal: 'BUY', confidence, reasons };
    }
    if (label === 'SELL') {
      return { signal: 'SELL', confidence, reasons };
    }
    throw new Error('Verified Search signal unavailable');
  }

  // ── RSI gauge SVG ──────────────────────────────────────────────────────────
  function drawRSI(rsi) {
    const svg  = $('rsiSvg'); if (!svg) return;
    const cx=90, cy=90, r=70, sw=12;
    const ARC  = Math.PI;
    const angle= (rsi/100)*ARC;
    const startX=cx-r, startY=cy;
    const endX=cx+r*Math.cos(Math.PI-angle), endY=cy-r*Math.sin(angle);
    const colors=[{s:0,e:30,c:'#1dd6a3'},{s:30,e:70,c:'#f5c842'},{s:70,e:100,c:'#e84545'}];
    let trackSeg='', fillSeg='';
    const ptOnArc=(pct)=>{ const a=pct/100*Math.PI; return {x:cx-r*Math.cos(Math.PI-a),y:cy-r*Math.sin(a)}; };
    for(const seg of colors){
      const p0=ptOnArc(seg.s), p1=ptOnArc(seg.e);
      trackSeg+=`<path d="M${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A${r} ${r} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}" stroke="${seg.c}" stroke-width="${sw}" fill="none" opacity=".15"/>`;
      if(rsi>seg.s){
        const eEnd=Math.min(rsi,seg.e);
        const q0=ptOnArc(seg.s),q1=ptOnArc(eEnd);
        const large=eEnd-seg.s>50?1:0;
        fillSeg+=`<path d="M${q0.x.toFixed(2)} ${q0.y.toFixed(2)} A${r} ${r} 0 ${large} 1 ${q1.x.toFixed(2)} ${q1.y.toFixed(2)}" stroke="${seg.c}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`;
      }
    }
    const needleA=(rsi/100)*Math.PI;
    const nx=cx+58*Math.cos(Math.PI+needleA), ny=cy-58*Math.sin(needleA);
    const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg">
      ${trackSeg}${fillSeg}
      <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" stroke="var(--t1)" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="4" fill="var(--teal)"/>
      <text x="${cx-r-2}" y="${cy+18}" font-size="8" fill="var(--t3)" text-anchor="middle">0</text>
      <text x="${cx}" y="${cy-r-8}" font-size="8" fill="var(--t3)" text-anchor="middle">50</text>
      <text x="${cx+r+2}" y="${cy+18}" font-size="8" fill="var(--t3)" text-anchor="middle">100</text>
    </svg>`;
    const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
    svg.replaceChildren(...parsed.documentElement.children);
  }

  // ── Countdown ring ─────────────────────────────────────────────────────────
  function startCountdown(onTick) {
    clearInterval(cdTimer);
    countdown = REFRESH_SECS;
    const arc = $('cdArc'), num = $('cdNum'), secs = $('cdSecs');
    const CIRC = 2*Math.PI*18; // r=18
    const update = () => {
      if (!arc||!num||!secs) return;
      const pct = countdown/REFRESH_SECS;
      arc.style.strokeDashoffset = (CIRC*(1-pct)).toFixed(2);
      num.textContent  = countdown;
      secs.textContent = countdown;
    };
    update();
    cdTimer = setInterval(()=>{ countdown--; update(); if(countdown<=0){clearInterval(cdTimer);if(onTick)onTick();} },1000);
  }

  // ── S/R row builder (safe DOM, no innerHTML) ────────────────────────────────
  function makeSRRow(type, title, description, pct, pctDir, displayPrice, tag) {
    const row = document.createElement('div');
    row.className = 'sr-row ' + type;

    const left = document.createElement('div');
    left.className = 'sr-left';

    const typeSpan = document.createElement('span');
    typeSpan.className = 'sr-type';
    typeSpan.textContent = title;

    const descSpan = document.createElement('span');
    descSpan.className = 'sr-desc';
    descSpan.textContent = description + ' \u00b7 ' + pct + '% ' + pctDir;

    left.append(typeSpan, descSpan);

    const priceSpan = document.createElement('span');
    priceSpan.className = 'sr-price';
    priceSpan.textContent = displayPrice;

    if (tag) {
      const tagSpan = document.createElement('span');
      tagSpan.className = 'sr-tag';
      tagSpan.textContent = tag;
      row.append(left, priceSpan, tagSpan);
    } else {
      row.append(left, priceSpan);
    }
    return row;
  }

  // ── Render results ─────────────────────────────────────────────────────────
  function render(sym, data, hist, gamePlan) {
    const { price, open, dayHigh, dayLow, volume, avgVolume } = data;
    const closes  = hist.map(h=>h.close);
    const rsi     = calcRSI([...closes].reverse());
    const tenDayV = hist.slice(0,10).reduce((s,h)=>s+h.volume,0)/Math.min(hist.length,10);
    const vwap    = Number(gamePlan?.indicators?.vwap);
    const { signal, confidence, reasons } = computeSignal(gamePlan?.searchSignal);

    const signalBullish = signal === 'BUY';
    const dayRngPct = dayHigh>dayLow ? ((price-dayLow)/(dayHigh-dayLow)*100) : 50;
    const fromOpen  = open ? ((price-open)/open*100) : 0;
    const rsiZone   = rsi===null?'--':rsi<30?'Oversold':rsi>70?'Overbought':'Neutral';
    const rsiZoneCls= rsi===null?'':rsi<30?'oversold':rsi>70?'overbought':'neutral';

    // verdict
    const vc = $('verdictCard');
    const vb = $('verdictBadge');
    const cls= signal.toLowerCase();
    ['buy','hold','wait','sell'].forEach(c=>{ vc.classList.remove(c); vb.classList.remove(c); });
    vc.classList.add(cls); vb.classList.add(cls);
    $('verdictBadge').textContent  = signal;
    $('verdictSym').textContent    = sym;
    $('verdictPrice').textContent  = '$'+fmt(price);
    $('verdictConf').textContent   = confidence+'%';
    $('verdictReason').textContent = reasons.join(' · ');

    // RSI
    if (rsi!==null) { drawRSI(rsi); $('rsiNum').textContent=fmt(rsi,1); $('rsiZone').textContent=rsiZone; $('rsiZone').className='rsi-zone '+rsiZoneCls; }
    else { $('rsiNum').textContent='--'; $('rsiZone').textContent='Insufficient data'; }

    // volume
    const vMax    = Math.max(volume||0, tenDayV||0);
    const vPctT   = vMax?(volume/vMax*100):0;
    const vPctA   = vMax?(tenDayV/vMax*100):0;
    const surge   = tenDayV>0 && volume/tenDayV>1.5;
    const el=$('volBarT'); if(el){el.style.width=vPctT.toFixed(1)+'%';}
    const elA=$('volBarA'); if(elA){elA.style.width=vPctA.toFixed(1)+'%';}
    $('volToday').textContent = fmtV(volume);
    $('volAvg').textContent   = fmtV(Math.round(tenDayV));
    const vb2=$('volBadge');
    vb2.textContent = surge?'Volume Surge':'Normal Volume';
    vb2.className = 'vol-badge '+(surge?'surge':'normal');

    // day range
    $('rLow').textContent  = '$'+fmt(dayLow);
    $('rCur').textContent  = '$'+fmt(price);
    $('rHigh').textContent = '$'+fmt(dayHigh);
    const dp = Math.max(0,Math.min(100,dayRngPct));
    const rf=$('rangeFill');const rd=$('rangeDot');
    if(rf) rf.style.width=dp.toFixed(1)+'%';
    if(rd) rd.style.left=dp.toFixed(1)+'%';
    $('rangePct').textContent = dp.toFixed(0)+'% position in today\'s range';

    // Signal direction must use the same binary verdict as the cards above.
    // Price versus open remains a factual sub-metric, not a second verdict.
    const dArrow=$('dirArrow'), dLabel=$('dirLabel'), dPct=$('dirPct');
    if(dArrow){ dArrow.className='dir-arrow '+(signalBullish?'up':'down'); dArrow.textContent=signalBullish?'▲':'▼'; }
    if(dLabel){ dLabel.className='dir-label '+(signalBullish?'up':'down'); dLabel.textContent=signalBullish?'Bullish':'Bearish'; }
    if(dPct) {
      const cleanFromOpen = Math.abs(fromOpen) < 0.005 ? 0 : fromOpen;
      dPct.textContent=(cleanFromOpen>0?'+':'')+fmt(cleanFromOpen)+'% from open ($'+fmt(open)+')';
    }

    // S/R
     const srTbl = $('srTable');
    if (srTbl) {
       const display = gamePlan?.displayLevels || {};
        const biasLevel = display.bias;
        const resistanceLevel = display.resistance?.[0];
        const supportLevel = display.support?.[0];
        const bias = Number(biasLevel?.price);
        const resistance = Number(resistanceLevel?.price);
        const support = Number(supportLevel?.price);
        const zoneText = level => Number.isFinite(Number(level?.zoneLow)) && Number.isFinite(Number(level?.zoneHigh))
          ? `$${fmt(level.zoneLow)}–$${fmt(level.zoneHigh)}`
          : `$${fmt(level?.price)}`;
       const nearbyRows = [
          Number.isFinite(resistance)
            ? makeSRRow('res', 'Resistance zone', 'Nearest completed-session level', ((resistance-price)/price*100).toFixed(2), 'above', zoneText(resistanceLevel), '')
           : null,
          Number.isFinite(support)
            ? makeSRRow('sup', 'Support zone', 'Nearest completed-session level', ((price-support)/price*100).toFixed(2), 'below', zoneText(supportLevel), '')
           : null,
       ].filter(Boolean);
      srTbl.replaceChildren();
        if (Number.isFinite(bias)) {
         const biasPanel = document.createElement('section');
         biasPanel.className = 'sr-bias';
         const biasTitle = document.createElement('div');
         biasTitle.className = 'sr-bias-title';
         biasTitle.textContent = 'KEY BIAS LEVEL';
         const biasPrice = document.createElement('div');
         biasPrice.className = 'sr-bias-price';
          biasPrice.textContent = zoneText(biasLevel);
         const biasDesc = document.createElement('div');
         biasDesc.className = 'sr-bias-desc';
          biasDesc.textContent = 'Hold above this zone = BULLISH bias  ·  Hold below = BEARISH bias';
         const biasState = document.createElement('div');
          const zoneLow = Number.isFinite(Number(biasLevel?.zoneLow)) ? Number(biasLevel.zoneLow) : bias;
          const zoneHigh = Number.isFinite(Number(biasLevel?.zoneHigh)) ? Number(biasLevel.zoneHigh) : bias;
          const above = price > zoneHigh;
          const below = price < zoneLow;
          biasState.className = 'sr-bias-state ' + (above ? 'up' : below ? 'down' : 'testing');
          biasState.textContent = above ? 'CURRENTLY ABOVE' : below ? 'CURRENTLY BELOW' : 'TESTING ZONE';
         biasPanel.append(biasTitle, biasPrice, biasDesc, biasState);
         srTbl.appendChild(biasPanel);
       }
       if (nearbyRows.length) {
         const nearbyTitle = document.createElement('div');
         nearbyTitle.className = 'sr-nearby-title';
          nearbyTitle.textContent = 'NEARBY SUPPORT & RESISTANCE · ATR BUFFERED';
         srTbl.append(nearbyTitle, ...nearbyRows);
         const note = document.createElement('p');
         note.className = 'sr-level-note';
          note.textContent = `Built from ${display.lookback || 14} completed sessions only${display.anchorDate ? ` · anchored to ${display.anchorDate}` : ''}.`;
         srTbl.appendChild(note);
      } else {
        const p = document.createElement('p');
        p.style.cssText = 'font-size:13px;color:var(--t3);padding:12px 0';
        p.textContent = 'Insufficient price history for S/R levels.';
        srTbl.appendChild(p);
      }
    }

    // Daily Pivots
    const pivots = gamePlan?.dailyPivots;
    const pivotCard  = $('pivotCard');
    const pivotPanel = $('pivotPanel');
    const pivotImp   = $('pivotImpliedInline');
    const pivotZBar  = $('pivotZoneBar');
    if (pivots && pivotCard && pivotPanel) {
      pivotCard.style.display = '';
      renderPivots(pivotPanel, pivots, price);
      if (pivotImp) {
        pivotImp.textContent = '· prior range $' + fmt(pivots.priorRange)
          + (pivots.anchorDate ? ' · anchored ' + pivots.anchorDate : '');
      }
      if (pivotZBar) {
        pivotZBar.textContent  = pivots.zone;
        pivotZBar.className    = 'pivot-zone-bar ' + pivots.zoneClass;
      }
    } else if (pivotCard) {
      pivotCard.style.display = 'none';
    }

    // show results
    ui.results().style.display='flex';
    startCountdown(()=>analyze(sym));
  }

  // ── Analyze ────────────────────────────────────────────────────────────────
  async function analyze(sym, suppliedAnalysis = null) {
    sym = sym.toUpperCase().trim();
    if (!sym) return;
    currentSym = sym;
    const tok = ++reqToken;

    ui.loading().style.display='flex';
    ui.error().style.display='none';
    ui.results().style.display='none';
    if(ui.loadSym()) ui.loadSym().textContent=sym;

    clearInterval(cdTimer);

    try {
      const [histRes, gamePlanRes] = await Promise.all([
        fetch(`/api/historical/${sym}?timeseries=30`).then(r=>r.ok?r.json():null),
        suppliedAnalysis || window.searchContext.load(sym),
      ]);
      if (tok !== reqToken || sym !== currentSym) return;
      if (!gamePlanRes?.snapshot?.price) throw new Error('Verified Search analysis unavailable for '+sym);
      const quoteRes = {
        price: gamePlanRes.snapshot.price,
        previousClose: gamePlanRes.snapshot.prevClose,
        open: gamePlanRes.snapshot.open,
        dayHigh: gamePlanRes.snapshot.high,
        dayLow: gamePlanRes.snapshot.low,
        volume: gamePlanRes.snapshot.volume,
        avgVolume: gamePlanRes.snapshot.avgVolume,
      };
      const hist = histRes?.historical||[];
      if (hist.length<5) throw new Error('Insufficient historical data for '+sym);

      ui.loading().style.display='none';
      render(sym, quoteRes, hist, gamePlanRes);
    } catch(e) {
      ui.loading().style.display='none';
      ui.error().style.display='flex';
      if($('traderErrorMsg')) $('traderErrorMsg').textContent=e.message||'Failed to analyze. Please try again.';
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    $('cdNow')?.addEventListener('click', () => { if (currentSym) analyze(currentSym); });
  }

  return { init, analyze };
})();

document.addEventListener('DOMContentLoaded', () => trader.init());
