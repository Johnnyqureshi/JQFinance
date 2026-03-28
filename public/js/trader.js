// ── StockPulse — Realtime Trader ──────────────────────────────────────────────

const trader = (() => {
  const REFRESH_SECS = 60;
  let   countdown    = 0;
  let   cdTimer      = null;
  let   currentSym   = null;

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

  // ── Support / Resistance (pivot clusters in 14-day data) ───────────────────
  function calcSR(bars) {
    const price = bars[0]?.c;
    if (!bars.length || !price) return { support:[], resistance:[] };
    const pivots = [];
    for (let i=1; i<bars.length-1; i++) {
      const h = bars[i].h, l = bars[i].l;
      if (h > bars[i-1].h && h > bars[i+1].h) pivots.push({ type:'r', val:h });
      if (l < bars[i-1].l && l < bars[i+1].l) pivots.push({ type:'s', val:l });
    }
    const cluster=(arr,tol=0.02)=>{
      const merged=[]; arr.sort((a,b)=>a-b);
      for(const v of arr){
        const g=merged.find(g=>Math.abs(g.center-v)/g.center<tol);
        g ? (g.sum+=v,g.n++,g.center=g.sum/g.n) : merged.push({center:v,sum:v,n:1});
      }
      return merged.sort((a,b)=>b.n-a.n).map(g=>g.center);
    };
    const rs=cluster(pivots.filter(p=>p.type==='r').map(p=>p.val)).filter(v=>v>price);
    const ss=cluster(pivots.filter(p=>p.type==='s').map(p=>p.val)).filter(v=>v<price);
    return { resistance: rs.slice(0,2), support: ss.slice(0,2) };
  }

  // ── Signal logic ────────────────────────────────────────────────────────────
  function computeSignal(rsi, price, open, volume, avgVol, sr) {
    const bearishDay  = price < open;
    const bullishDay  = price >= open;
    const volumeSurge = avgVol>0 && volume/avgVol > 1.5;
    const nearRes     = sr.resistance.length>0 && Math.abs(price-sr.resistance[0])/price < 0.015;

    let signal='HOLD', confidence=50, reasons=[];

    if (rsi<45 && bullishDay && volumeSurge) {
      signal='BUY'; confidence=75;
      reasons=['RSI below 45 (oversold momentum)','Bullish day — price above open','Volume surge (+50% above average)'];
    } else if (rsi>70 || (nearRes && bearishDay)) {
      signal='SELL'; confidence=rsi>70?72:60;
      if (rsi>70)        reasons.push('RSI overbought (above 70)');
      if (nearRes)       reasons.push('Price near resistance level');
      if (bearishDay)    reasons.push('Bearish day — price below open');
    } else {
      reasons=['RSI in neutral range','No extreme volume signal','No strong directional bias'];
      confidence = rsi<55 ? 60 : 52;
    }

    return { signal, confidence, reasons };
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

  // ── Render results ─────────────────────────────────────────────────────────
  function render(sym, data, hist) {
    const { price, open, dayHigh, dayLow, volume, avgVolume } = data;
    const closes  = hist.map(h=>h.close);
    const rsi     = calcRSI([...closes].reverse());
    const tenDayV = hist.slice(0,10).reduce((s,h)=>s+h.volume,0)/Math.min(hist.length,10);
    const sr      = calcSR(hist.map(h=>({c:h.close,h:h.high,l:h.low})));
    const { signal, confidence, reasons } = computeSignal(rsi, price, open, volume, tenDayV, sr);

    const bullish = price >= open;
    const dayRngPct = dayHigh>dayLow ? ((price-dayLow)/(dayHigh-dayLow)*100) : 50;
    const fromOpen  = open ? ((price-open)/open*100) : 0;
    const rsiZone   = rsi===null?'--':rsi<30?'Oversold':rsi>70?'Overbought':'Neutral';
    const rsiZoneCls= rsi===null?'':rsi<30?'oversold':rsi>70?'overbought':'neutral';

    // verdict
    const vc = $('verdictCard');
    const vb = $('verdictBadge');
    const cls= signal.toLowerCase();
    ['buy','hold','sell'].forEach(c=>{ vc.classList.remove(c); vb.classList.remove(c); });
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

    // direction
    const dArrow=$('dirArrow'), dLabel=$('dirLabel'), dPct=$('dirPct');
    if(dArrow){ dArrow.className='dir-arrow '+(bullish?'up':'down'); dArrow.textContent=bullish?'▲':'▼'; }
    if(dLabel){ dLabel.className='dir-label '+(bullish?'up':'down'); dLabel.textContent=bullish?'Bullish':'Bearish'; }
    if(dPct)  dPct.textContent=(fromOpen>=0?'+':'')+fmt(fromOpen)+'% from open ($'+fmt(open)+')';

    // S/R
    const srTbl = $('srTable');
    if (srTbl) {
      const resRows = sr.resistance.slice(0,2).map((v,i)=>`
        <div class="sr-row res">
          <div class="sr-left"><span class="sr-type">Resistance</span><span class="sr-desc">Level ${i+1} — ${((v-price)/price*100).toFixed(2)}% above</span></div>
          <span class="sr-price">$${fmt(v)}</span>
          <span class="sr-tag">SELL ZONE</span>
        </div>`).join('');
      const supRows = sr.support.slice(0,2).map((v,i)=>`
        <div class="sr-row sup">
          <div class="sr-left"><span class="sr-type">Support</span><span class="sr-desc">Level ${i+1} — ${((price-v)/price*100).toFixed(2)}% below</span></div>
          <span class="sr-price">$${fmt(v)}</span>
          <span class="sr-tag">BUY ZONE</span>
        </div>`).join('');
      srTbl.innerHTML = resRows + supRows || '<p style="font-size:13px;color:var(--t3);padding:12px 0">Insufficient price history for S/R levels.</p>';
    }

    // show results
    ui.results().style.display='flex';
    startCountdown(()=>analyze(sym));
  }

  // ── Analyze ────────────────────────────────────────────────────────────────
  async function analyze(sym) {
    sym = sym.toUpperCase().trim();
    if (!sym) return;
    currentSym = sym;

    ui.loading().style.display='flex';
    ui.error().style.display='none';
    ui.results().style.display='none';
    if(ui.loadSym()) ui.loadSym().textContent=sym;

    clearInterval(cdTimer);

    try {
      const [quoteRes, histRes] = await Promise.all([
        fetch(`/api/quote/${sym}`).then(r=>r.ok?r.json():null),
        fetch(`/api/historical/${sym}?timeseries=30`).then(r=>r.ok?r.json():null),
      ]);

      if (!quoteRes?.price) throw new Error('Unable to fetch quote data for '+sym);
      const hist = histRes?.historical||[];
      if (hist.length<5) throw new Error('Insufficient historical data for '+sym);

      ui.loading().style.display='none';
      render(sym, quoteRes, hist);
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
