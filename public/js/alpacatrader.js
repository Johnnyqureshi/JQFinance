// ── Johnny Qureshi Finance — Alpaca Trading Desk ─────────────────────────────

const alpacaTrader = (() => {

  // ── State ─────────────────────────────────────────────────────────────────
  let currentSym   = null;
  let currentPrice = null;
  let tpPct        = 2;
  let slPct        = 1;
  let tpOn         = true;
  let slOn         = true;
  let tradeSide    = 'buy';
  let connected    = false;
  let alpacaMode   = 'paper';
  let cdInterval   = null;
  let cdSecs       = 60;
  let analysisBusy = false;

  // ── Popular tickers ───────────────────────────────────────────────────────
  const QUICK = [
    'SPY','QQQ','IWM','AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA',
    'AMD','PLTR','COIN','MSTR','HOOD','RIVN','SOXL','TQQQ','SQQQ','ARKK',
    'GLD','TLT','MARA','RIOT','SMCI','ARM','NFLX','CRWD','BA','JPM',
    'XOM','UBER','SNAP','RBLX','INTC','MU','AVGO','GME','SOFI','NIO',
    'BABA','DKNG','LCID','IONQ','BBAI','SOUN','NVDL','TSLL','LABD','SPXU',
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────
  const $  = id => document.getElementById(id);
  const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  const fmtV = v => !v ? '--' : v>=1e9?(v/1e9).toFixed(1)+'B':v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':String(v);

  async function apiFetch(url, opts={}) {
    const r = await fetch(url, { credentials:'include', ...opts });
    return r.json();
  }

  // ── Compact analysis math ─────────────────────────────────────────────────
  function calcVWAP(bars) {
    let sumTP=0, sumV=0;
    for (const b of bars) {
      if (!b.v||b.v<=0||b.h==null) continue;
      const tp=(b.h+b.l+b.c)/3;
      sumTP+=tp*b.v; sumV+=b.v;
    }
    return sumV>0 ? sumTP/sumV : null;
  }

  function calcRSI(closes, period=14) {
    if (closes.length < period+1) return null;
    let g=0, l=0;
    for (let i=1;i<=period;i++) { const d=closes[i]-closes[i-1]; d>=0?g+=d:l+=Math.abs(d); }
    let ag=g/period, al=l/period;
    for (let i=period+1;i<closes.length;i++) {
      const d=closes[i]-closes[i-1];
      ag=(ag*(period-1)+(d>=0?d:0))/period;
      al=(al*(period-1)+(d<0?Math.abs(d):0))/period;
    }
    return al===0 ? 100 : 100-100/(1+ag/al);
  }

  function calcSR(bars, price) {
    if (bars.length<3||!price) return {support:null,resistance:null};
    const sup=[], res=[];
    for (let i=1;i<bars.length-1;i++) {
      if (bars[i].h>bars[i-1].h&&bars[i].h>bars[i+1].h) res.push(bars[i].h);
      if (bars[i].l<bars[i-1].l&&bars[i].l<bars[i+1].l) sup.push(bars[i].l);
    }
    const nearest=(arr,above)=>{
      const f=above?arr.filter(v=>v>price):arr.filter(v=>v<price);
      return f.length ? (above?Math.min(...f):Math.max(...f)) : null;
    };
    return {support:nearest(sup,false),resistance:nearest(res,true)};
  }

  function calcMomentum(bars) {
    if (bars.length<2) return 0;
    const last=bars.slice(-Math.min(5,bars.length));
    return last.filter(b=>b.c>b.o).length - last.filter(b=>b.c<b.o).length;
  }

  function computeSignal(rsi,price,vwap,volData,momentum,sr) {
    const above=vwap!=null&&price>vwap;
    const below=vwap!=null&&price<vwap;
    let signal='HOLD',confidence=50,reasons=[];
    if (rsi<40&&above&&momentum>=2)           { signal='BUY';  confidence=78; reasons=['RSI deeply oversold','Above VWAP','Bullish bars']; }
    else if (rsi<45&&above&&volData.surge)    { signal='BUY';  confidence=70; reasons=['RSI recovery zone','Above VWAP','Volume surge']; }
    else if (sr.support&&price<=sr.support*1.005&&above&&momentum>=1) { signal='BUY'; confidence=63; reasons=['Bouncing off support','Above VWAP','Bullish momentum']; }
    else if (rsi>70&&below)                   { signal='SELL'; confidence=76; reasons=['RSI overbought','Below VWAP']; }
    else if (rsi>65&&momentum<=-2)            { signal='SELL'; confidence=70; reasons=['RSI elevated','Bearish bars']; }
    else if (sr.resistance&&price>=sr.resistance*0.995&&below) { signal='SELL'; confidence=62; reasons=['Pressing resistance','Below VWAP']; }
    else {
      if (above&&momentum>0)        { confidence=57; reasons=['Above VWAP — mild bullish','RSI neutral']; }
      else if (below&&momentum<0)   { confidence=52; reasons=['Below VWAP — mild bearish','RSI neutral']; }
      else                          { confidence=50; reasons=['Near VWAP equilibrium','No directional bias']; }
    }
    return {signal,confidence,reasons};
  }

  function computeBias(rsi,price,vwap,momentum) {
    let score=0;
    if (vwap) (price>vwap?score++:score--);
    if (rsi!=null) { if(rsi<45)score++; else if(rsi>60)score--; }
    if (momentum>=2)score++; else if(momentum<=-2)score--;
    if (score>=2)  return {text:'Bullish',cls:'bull'};
    if (score<=-2) return {text:'Bearish',cls:'bear'};
    return {text:'Neutral',cls:'neut'};
  }

  // ── Load and display analysis ─────────────────────────────────────────────
  async function loadAnalysis(sym) {
    if (!sym) return;
    currentSym = sym.toUpperCase();
    analysisBusy = true;
    $('trdAnalysisLoading').style.display='flex';
    clearInterval(cdInterval);
    cdSecs=60;
    updateCd();

    try {
      const [intraday, quote] = await Promise.all([
        apiFetch('/api/intraday/'+currentSym),
        apiFetch('/api/quote/'+currentSym),
      ]);

      const bars   = intraday?.bars || [];
      const price  = quote?.price ?? (bars.length ? bars[bars.length-1].c : null);
      const prev   = quote?.previousClose;
      const chg    = price && prev ? price-prev : null;
      const pct    = chg && prev   ? (chg/prev)*100 : null;

      currentPrice = price;

      // Ticker / price display
      $('trdTicker').textContent  = currentSym;
      $('trdPrice').textContent   = price ? '$'+fmt(price) : '--';
      if (chg!=null) {
        const up=chg>=0;
        $('trdChg').textContent   = (up?'+':'')+fmt(chg)+' ('+( up?'+':'')+fmt(pct)+'%)';
        $('trdChg').className     = 'trd-sym-chg '+(up?'up':'dn');
      }

      // Extended hours badge
      const ext=$('trdExtBadge');
      if (quote?.extendedPrice && quote?.extendedType) {
        const eChg=quote.extendedPrice-price;
        const ePct=price?(eChg/price)*100:0;
        ext.textContent = quote.extendedType+': $'+fmt(quote.extendedPrice)+' ('+( ePct>=0?'+':'')+fmt(ePct)+'%)';
        ext.style.display='';
      } else { ext.style.display='none'; }

      if (!bars.length) throw new Error('No intraday bars');

      const closes   = bars.map(b=>b.c);
      const vwap     = calcVWAP(bars);
      const rsi      = calcRSI(closes);
      const sr       = calcSR(bars,price);
      const momentum = calcMomentum(bars);
      const vols     = bars.map(b=>b.v||0).filter(v=>v>0);
      const avgVol   = vols.length?vols.reduce((a,b)=>a+b,0)/vols.length:0;
      const lastVol  = bars.length?bars[bars.length-1].v||0:0;
      const volData  = {surge:avgVol>0&&lastVol/avgVol>1.5,lastVol,avgVol};
      const sig      = computeSignal(rsi??50,price??0,vwap,volData,momentum,sr);
      const bias     = computeBias(rsi??50,price??0,vwap,momentum);

      // Stats
      $('trdVwap').textContent     = vwap  ? '$'+fmt(vwap)      : '--';
      $('trdRsi').textContent      = rsi   ? rsi.toFixed(1)      : '--';
      const vwapPct = vwap&&price ? ((price-vwap)/vwap*100) : null;
      $('trdVwapPos').textContent  = vwapPct!=null ? (vwapPct>=0?'+':'')+fmt(vwapPct)+'%' : '--';
      $('trdVwapPos').className    = 'trd-stat-val '+(vwapPct>=0?'up':'dn');
      $('trdVol').textContent      = fmtV(lastVol)+(volData.surge?' 🔥':'');

      // Signal badge
      const sigEl=$('trdSignal');
      sigEl.textContent = sig.signal;
      sigEl.className   = 'trd-sig-badge sig-'+sig.signal.toLowerCase();
      $('trdSignalConf').textContent = sig.confidence+'% confidence';

      // Bias badge
      const bEl=$('trdBias');
      bEl.textContent = bias.text;
      bEl.className   = 'trd-bias-badge bias-'+bias.cls;

      // Support / resistance
      $('trdSupport').textContent    = sr.support    ? '$'+fmt(sr.support)    : '--';
      $('trdResistance').textContent = sr.resistance ? '$'+fmt(sr.resistance) : '--';

      // Daily pivot levels
      const dailyH = Math.max(...bars.map(b=>b.h));
      const dailyL = Math.min(...bars.map(b=>b.l));
      const dailyC = bars[bars.length-1].c;
      const pp=(dailyH+dailyL+dailyC)/3;
      const r1=2*pp-dailyL, r2=pp+(dailyH-dailyL);
      const s1=2*pp-dailyH, s2=pp-(dailyH-dailyL);
      $('trdPP').textContent = '$'+fmt(pp);
      $('trdR1').textContent = '$'+fmt(r1);
      $('trdR2').textContent = '$'+fmt(r2);
      $('trdS1').textContent = '$'+fmt(s1);
      $('trdS2').textContent = '$'+fmt(s2);

      // Signal reasons
      const rDiv=$('trdReasons');
      rDiv.innerHTML=sig.reasons.map(r=>`<span class="trd-reason">${r}</span>`).join('');

      updateTradeCalc();
      startCd();
    } catch(e) {
      console.error('[AlpacaTrader] Analysis error:', e);
    } finally {
      $('trdAnalysisLoading').style.display='none';
      analysisBusy=false;
    }
  }

  // ── Auto-refresh countdown ────────────────────────────────────────────────
  function startCd() {
    clearInterval(cdInterval);
    cdSecs=60;
    updateCd();
    cdInterval=setInterval(()=>{
      cdSecs--;
      updateCd();
      if (cdSecs<=0) { cdSecs=60; if(currentSym&&!analysisBusy) loadAnalysis(currentSym); }
    },1000);
  }

  function updateCd() {
    const el=$('trdRefreshCd');
    if(el) el.textContent='⟳ '+cdSecs+'s';
  }

  // ── Trade setup ───────────────────────────────────────────────────────────
  function updateTradeCalc() {
    const amtEl=$('trdAmount');
    const amount = amtEl ? parseFloat(amtEl.value)||0 : 0;

    // Shares estimate
    const hint=$('trdSharesHint');
    if (currentPrice&&amount>0) {
      const hasBracket=tpOn||slOn;
      const shares=hasBracket ? Math.max(1,Math.floor(amount/currentPrice)) : (amount/currentPrice).toFixed(2);
      hint.textContent=`≈ ${shares} shares @ $${fmt(currentPrice)}${hasBracket?' (whole shares — bracket order)':''}`;
      $('trdSumSym').textContent    = currentSym||'--';
      $('trdSumPrice').textContent  = '$'+fmt(currentPrice);
      $('trdSumShares').textContent = shares;
      $('trdSumType').textContent   = hasBracket ? 'Market + Bracket (TP/SL)' : 'Market (Notional)';
    } else {
      hint.textContent = '≈ -- shares';
    }

    // TP display
    const tpVal=$('trdTpVal');
    const tpLvl=$('trdTpLevel');
    if (tpOn) {
      tpVal.textContent = (tradeSide==='buy'?'+':'-')+tpPct+'%';
      if (currentPrice) {
        const lvl=tradeSide==='buy'?currentPrice*(1+tpPct/100):currentPrice*(1-tpPct/100);
        tpLvl.textContent='→ $'+fmt(lvl);
      }
    } else {
      tpVal.textContent='OFF'; tpLvl.textContent='No take-profit';
    }

    // SL display
    const slVal=$('trdSlVal');
    const slLvl=$('trdSlLevel');
    if (slOn) {
      slVal.textContent = (tradeSide==='buy'?'-':'+')+slPct+'%';
      if (currentPrice) {
        const lvl=tradeSide==='buy'?currentPrice*(1-slPct/100):currentPrice*(1+slPct/100);
        slLvl.textContent='→ $'+fmt(lvl);
      }
    } else {
      slVal.textContent='OFF'; slLvl.textContent='No stop-loss';
    }

    // Execute button state
    const btn=$('trdExecuteBtn');
    if (btn) {
      if (!connected) {
        btn.disabled=true;
        btn.textContent='Connect Alpaca to Trade';
        btn.className='trd-execute-btn';
      } else if (!currentSym||!currentPrice) {
        btn.disabled=true;
        btn.textContent='Load a symbol first';
        btn.className='trd-execute-btn';
      } else {
        btn.disabled=false;
        btn.className='trd-execute-btn '+(tradeSide==='buy'?'trd-exec-buy':'trd-exec-sell');
        btn.textContent=tradeSide==='buy' ? `BUY ${currentSym}` : `SELL ${currentSym}`;
      }
    }
  }

  // ── Place order ───────────────────────────────────────────────────────────
  async function placeOrder() {
    const amount=parseFloat($('trdAmount')?.value)||0;
    if (!currentSym||!currentPrice||amount<=0) return;

    const btn=$('trdExecuteBtn');
    const msgEl=$('trdOrderMsg');
    btn.disabled=true;
    btn.textContent='Placing order…';
    msgEl.textContent='';
    msgEl.className='trd-order-msg';

    try {
      const body={
        symbol:  currentSym,
        side:    tradeSide,
        amount,
        tpPct:   tpOn?tpPct:0,
        slPct:   slOn?slPct:0,
      };
      const r=await apiFetch('/api/alpaca/order',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),
      });
      if (r.error) throw new Error(r.error);

      const side=tradeSide.toUpperCase();
      const shares=r.shares||'--';
      const price =r.price ? '$'+fmt(r.price) : '';
      msgEl.textContent=`✓ ${side} order placed — ${shares} shares ${price}`;
      msgEl.className='trd-order-msg success';
      setTimeout(()=>loadPortfolio(),1500);
    } catch(e) {
      msgEl.textContent='✗ '+e.message;
      msgEl.className='trd-order-msg error';
    } finally {
      updateTradeCalc();
    }
  }

  // ── Portfolio (account + positions + orders) ──────────────────────────────
  async function loadPortfolio() {
    if (!connected) return;
    try {
      const [acct,positions,orders]=await Promise.all([
        apiFetch('/api/alpaca/account'),
        apiFetch('/api/alpaca/positions'),
        apiFetch('/api/alpaca/orders'),
      ]);
      renderAccount(acct);
      renderPositions(Array.isArray(positions)?positions:[]);
      renderOrders(Array.isArray(orders)?orders:[]);
    } catch(e) {
      console.error('[AlpacaTrader] Portfolio error:', e.message);
    }
  }

  function renderAccount(a) {
    const el=$('trdAccountBody');
    if (!el) return;
    if (a.error) { el.innerHTML=`<div class="trd-bot-empty trd-error">${a.error}</div>`; return; }
    const equity = parseFloat(a.equity||0);
    const cash   = parseFloat(a.cash||0);
    const bp     = parseFloat(a.buying_power||0);
    const dayPL  = parseFloat(a.equity||0)-parseFloat(a.last_equity||a.equity||0);
    const up     = dayPL>=0;
    el.innerHTML=`
      <div class="trd-acct-grid">
        <div class="trd-acct-item"><div class="trd-acct-lbl">Portfolio Value</div><div class="trd-acct-val">$${fmt(equity)}</div></div>
        <div class="trd-acct-item"><div class="trd-acct-lbl">Cash Available</div><div class="trd-acct-val">$${fmt(cash)}</div></div>
        <div class="trd-acct-item"><div class="trd-acct-lbl">Buying Power</div><div class="trd-acct-val">$${fmt(bp)}</div></div>
        <div class="trd-acct-item"><div class="trd-acct-lbl">Today's P&L</div><div class="trd-acct-val ${up?'up':'dn'}">${up?'+':''}$${fmt(Math.abs(dayPL))}</div></div>
      </div>
      <div class="trd-acct-status">${a.status==='ACTIVE'?'<span class="trd-dot-green"></span> Account Active':'Status: '+(a.status||'--')}</div>
    `;
  }

  function renderPositions(positions) {
    const el=$('trdPositionsBody');
    const cntEl=$('trdPosCount');
    if (cntEl) cntEl.textContent=positions.length;
    if (!el) return;
    if (!positions.length) { el.innerHTML='<div class="trd-bot-empty">No open positions</div>'; return; }
    el.innerHTML=positions.map(p=>{
      const pnl=parseFloat(p.unrealized_pl||0);
      const pnlPct=parseFloat(p.unrealized_plpc||0)*100;
      const up=pnl>=0;
      const qty=parseFloat(p.qty||0);
      const sym=p.symbol;
      return `
        <div class="trd-pos-row">
          <div class="trd-pos-left">
            <div class="trd-pos-sym">${sym}</div>
            <div class="trd-pos-qty">${qty>0?'Long':'Short'} ${Math.abs(qty)} sh</div>
          </div>
          <div class="trd-pos-mid">
            <div class="trd-pos-price">$${fmt(parseFloat(p.current_price||0))}</div>
            <div class="trd-pos-avg">avg $${fmt(parseFloat(p.avg_entry_price||0))}</div>
          </div>
          <div class="trd-pos-right">
            <div class="trd-pos-pnl ${up?'up':'dn'}">${up?'+':''}$${fmt(Math.abs(pnl))}</div>
            <div class="trd-pos-pct ${up?'up':'dn'}">(${up?'+':''}${fmt(pnlPct)}%)</div>
          </div>
          <button class="trd-close-btn" data-sym="${sym}" title="Close position">✕</button>
        </div>
      `;
    }).join('');
    el.querySelectorAll('.trd-close-btn').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        btn.disabled=true; btn.textContent='…';
        try { await apiFetch('/api/alpaca/position/'+btn.dataset.sym,{method:'DELETE'}); loadPortfolio(); }
        catch(e){ btn.disabled=false; btn.textContent='✕'; alert(e.message); }
      });
    });
  }

  function renderOrders(orders) {
    const el=$('trdOrdersBody');
    const cntEl=$('trdOrdCount');
    if (cntEl) cntEl.textContent=orders.length;
    if (!el) return;
    if (!orders.length) { el.innerHTML='<div class="trd-bot-empty">No recent orders</div>'; return; }

    const STATUS_LABELS={
      new:'Pending',filled:'Filled',partially_filled:'Partial',
      canceled:'Cancelled',expired:'Expired',replaced:'Replaced',
      pending_new:'Submitting',accepted:'Accepted',
    };
    el.innerHTML=orders.slice(0,12).map(o=>{
      const side=o.side?.toUpperCase()||'--';
      const sym=o.symbol||'--';
      const st=STATUS_LABELS[o.status]||o.status||'--';
      const qty=o.qty||o.notional||'--';
      const fillPx=parseFloat(o.filled_avg_price||0);
      const dt=o.submitted_at ? new Date(o.submitted_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '--';
      const isPending=o.status==='new'||o.status==='pending_new'||o.status==='accepted';
      const canCancel=isPending||o.status==='partially_filled';
      const stCls=o.status==='filled'?'ord-filled':isPending?'ord-pending':'ord-done';
      return `
        <div class="trd-ord-row">
          <div class="trd-ord-side ${o.side==='buy'?'ord-buy':'ord-sell'}">${side}</div>
          <div class="trd-ord-sym">${sym}</div>
          <div class="trd-ord-qty">${qty}${o.notional?'$':' sh'}</div>
          <div class="trd-ord-px">${fillPx?'$'+fmt(fillPx):'--'}</div>
          <div class="trd-ord-st ${stCls}">${st}</div>
          <div class="trd-ord-time">${dt}</div>
          ${canCancel?`<button class="trd-cancel-btn" data-id="${o.id}">✕</button>`:'<span class="trd-cancel-ph"></span>'}
        </div>
      `;
    }).join('');
    el.querySelectorAll('.trd-cancel-btn').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        btn.disabled=true; btn.textContent='…';
        try { await apiFetch('/api/alpaca/order/'+btn.dataset.id,{method:'DELETE'}); setTimeout(loadPortfolio,800); }
        catch(e){ btn.disabled=false; btn.textContent='✕'; alert(e.message); }
      });
    });
  }

  // ── Connection modal ──────────────────────────────────────────────────────
  function showModal() {
    const m=$('trdModal');
    if(m){ m.style.display='flex'; $('trdModalErr').textContent=''; }
    // Pre-fill mode indicator
    const btnDisc=$('trdModalDisc');
    if(btnDisc) btnDisc.style.display=connected?'':'none';
  }

  function hideModal() {
    const m=$('trdModal'); if(m) m.style.display='none';
  }

  async function saveCredentials() {
    const key    = $('trdApiKey')?.value.trim();
    const secret = $('trdApiSecret')?.value.trim();
    const errEl  = $('trdModalErr');
    if(!key||!secret){ if(errEl)errEl.textContent='Both fields required.'; return; }
    const saveBtn=$('trdModalSave');
    saveBtn.disabled=true; saveBtn.textContent='Connecting…';
    errEl.textContent='';
    try {
      const r=await apiFetch('/api/alpaca/credentials',{
        method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({apiKey:key,apiSecret:secret,mode:alpacaMode}),
      });
      if(r.error) throw new Error(r.error);
      // Verify by hitting account
      const acct=await apiFetch('/api/alpaca/account');
      if(acct.error) throw new Error('Credentials saved but account fetch failed: '+acct.error);
      connected=true;
      alpacaMode=r.mode||'paper';
      hideModal();
      updateConnStatus();
      loadPortfolio();
    } catch(e){
      if(errEl) errEl.textContent=e.message;
    } finally {
      saveBtn.disabled=false; saveBtn.textContent='Connect';
    }
  }

  async function disconnect() {
    await apiFetch('/api/alpaca/credentials',{method:'DELETE'});
    connected=false;
    updateConnStatus();
    hideModal();
    $('trdAccountBody').innerHTML='<div class="trd-bot-empty">Connect Alpaca to view account</div>';
    $('trdPositionsBody').innerHTML='<div class="trd-bot-empty">No open positions</div>';
    $('trdOrdersBody').innerHTML='<div class="trd-bot-empty">No recent orders</div>';
    $('trdPosCount').textContent='0';
    $('trdOrdCount').textContent='0';
    updateTradeCalc();
  }

  function updateConnStatus() {
    const dot=$('trdConnDot'), txt=$('trdConnText'), badge=$('trdModeBadge'), btn=$('trdConnBtn');
    if(connected){
      dot.className='trd-conn-dot dot-green';
      txt.textContent='Connected';
      badge.textContent=alpacaMode.toUpperCase();
      badge.className='trd-mode-badge mode-'+(alpacaMode==='live'?'live':'paper');
      btn.textContent='Account Settings';
    } else {
      dot.className='trd-conn-dot dot-red';
      txt.textContent='Not connected';
      badge.textContent='DISCONNECTED';
      badge.className='trd-mode-badge mode-paper';
      btn.textContent='Connect Alpaca';
    }
  }

  async function checkCredentials() {
    try {
      const r=await apiFetch('/api/alpaca/credentials');
      connected=!!r.connected;
      alpacaMode=r.mode||'paper';
      updateConnStatus();
      if(connected) loadPortfolio();
      updateTradeCalc();
    } catch(e){}
  }

  // ── Quick-ticker grid ─────────────────────────────────────────────────────
  function buildQuickGrid() {
    const grid=$('trdQuickGrid');
    if(!grid) return;
    grid.innerHTML=QUICK.map(sym=>`<button class="trd-qt-btn" data-sym="${sym}">${sym}</button>`).join('');
    grid.querySelectorAll('.trd-qt-btn').forEach(btn=>{
      btn.addEventListener('click',()=>selectSymbol(btn.dataset.sym));
    });
  }

  function selectSymbol(sym) {
    $('trdSymInput').value=sym;
    document.querySelectorAll('.trd-qt-btn').forEach(b=>{
      b.classList.toggle('active',b.dataset.sym===sym);
    });
    loadAnalysis(sym);
  }

  // ── Page open ────────────────────────────────────────────────────────────
  function open() {
    checkCredentials();
    if(currentSym) loadAnalysis(currentSym);
    else if(!currentSym) selectSymbol('SPY');
  }

  // ── Bind events ───────────────────────────────────────────────────────────
  function bindEvents() {
    // Symbol load
    $('trdSymGo')?.addEventListener('click',()=>{
      const v=$('trdSymInput').value.trim().toUpperCase();
      if(v) selectSymbol(v);
    });
    $('trdSymInput')?.addEventListener('keydown',e=>{
      if(e.key==='Enter'){ const v=e.target.value.trim().toUpperCase(); if(v)selectSymbol(v); }
    });
    $('trdSymInput')?.addEventListener('input',e=>{
      e.target.value=e.target.value.toUpperCase();
    });

    // Refresh
    $('trdRefreshNow')?.addEventListener('click',()=>{ if(currentSym)loadAnalysis(currentSym); });
    $('trdRefreshAccount')?.addEventListener('click',loadPortfolio);

    // Side toggle
    $('trdBuyBtn')?.addEventListener('click',()=>{
      tradeSide='buy';
      $('trdBuyBtn').classList.add('active');
      $('trdSellBtn').classList.remove('active');
      updateTradeCalc();
    });
    $('trdSellBtn')?.addEventListener('click',()=>{
      tradeSide='sell';
      $('trdSellBtn').classList.add('active');
      $('trdBuyBtn').classList.remove('active');
      updateTradeCalc();
    });

    // Amount
    $('trdAmount')?.addEventListener('input',updateTradeCalc);

    // TP controls
    $('trdTpPlus')?.addEventListener('click',()=>{ if(tpOn&&tpPct<20){tpPct++;updateTradeCalc();} });
    $('trdTpMinus')?.addEventListener('click',()=>{ if(tpOn&&tpPct>1){tpPct--;updateTradeCalc();} });
    $('trdTpOff')?.addEventListener('click',()=>{ tpOn=!tpOn; updateTradeCalc(); });

    // SL controls
    $('trdSlPlus')?.addEventListener('click',()=>{ if(slOn&&slPct<20){slPct++;updateTradeCalc();} });
    $('trdSlMinus')?.addEventListener('click',()=>{ if(slOn&&slPct>1){slPct--;updateTradeCalc();} });
    $('trdSlOff')?.addEventListener('click',()=>{ slOn=!slOn; updateTradeCalc(); });

    // Execute
    $('trdExecuteBtn')?.addEventListener('click',placeOrder);

    // Connect button
    $('trdConnBtn')?.addEventListener('click',showModal);

    // Modal
    $('trdModalClose')?.addEventListener('click',hideModal);
    $('trdModal')?.addEventListener('click',e=>{ if(e.target.id==='trdModal')hideModal(); });
    $('trdModalSave')?.addEventListener('click',saveCredentials);
    $('trdModalDisc')?.addEventListener('click',async()=>{
      if(confirm('Disconnect Alpaca and remove stored credentials?')) await disconnect();
    });

    // Mode tabs in modal
    document.querySelectorAll('.trd-mode-tab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        alpacaMode=tab.dataset.mode;
        document.querySelectorAll('.trd-mode-tab').forEach(t=>t.classList.toggle('active',t===tab));
        const warn=$('trdLiveWarn');
        if(warn) warn.style.display=alpacaMode==='live'?'':'none';
      });
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    buildQuickGrid();
    bindEvents();
    // Don't load credentials here — wait for open() when user navigates to page
  }

  return { init, open };

})();

document.addEventListener('DOMContentLoaded', () => alpacaTrader.init());
