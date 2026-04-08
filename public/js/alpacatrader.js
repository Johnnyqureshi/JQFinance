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
  let leverage     = 1;          // manual trade leverage
  let atLeverage   = 1;          // auto-trade leverage setting
  let connected    = false;
  let alpacaMode   = 'live';
  let cdInterval   = null;
  let cdSecs       = 60;
  let analysisBusy = false;
  let statusPoll   = null;
  let autoEnabled  = false;

  // ── Popular tickers ───────────────────────────────────────────────────────
  const QUICK = [
    'SPY','QQQ','IWM','AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA',
    'AMD','PLTR','COIN','MSTR','HOOD','RIVN','SOXL','TQQQ','SQQQ','ARKK',
    'GLD','TLT','MARA','RIOT','SMCI','ARM','NFLX','CRWD','BA','JPM',
    'XOM','UBER','SNAP','RBLX','INTC','MU','AVGO','GME','SOFI','NIO',
    'BABA','DKNG','LCID','IONQ','BBAI','SOUN','NVDL','TSLL','LABD','SPXU',
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────
  const $   = id => document.getElementById(id);
  const fmt = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  const fmtV = v => !v?'--':v>=1e9?(v/1e9).toFixed(1)+'B':v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':String(v);
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '--';
  const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '--';

  async function apiFetch(url, opts={}) {
    const r = await fetch(url, { credentials:'include', ...opts });
    return r.json();
  }

  // ── Compact analysis math ─────────────────────────────────────────────────
  function calcVWAP(bars) {
    let st=0, sv=0;
    for (const b of bars) {
      if (!b.v||b.v<=0||b.h==null) continue;
      st+=((b.h+b.l+b.c)/3)*b.v; sv+=b.v;
    }
    return sv>0?st/sv:null;
  }

  function calcRSI(closes, p=14) {
    if (closes.length<p+1) return null;
    let g=0, l=0;
    for (let i=1;i<=p;i++){const d=closes[i]-closes[i-1];d>=0?g+=d:l-=d;}
    let ag=g/p, al=l/p;
    for (let i=p+1;i<closes.length;i++){
      const d=closes[i]-closes[i-1];
      ag=(ag*(p-1)+Math.max(d,0))/p;
      al=(al*(p-1)+Math.max(-d,0))/p;
    }
    return al===0?100:100-100/(1+ag/al);
  }

  function calcSR(bars, price) {
    if (bars.length<3||!price) return {support:null,resistance:null};
    const sup=[], res=[];
    for (let i=1;i<bars.length-1;i++){
      if(bars[i].h>bars[i-1].h&&bars[i].h>bars[i+1].h) res.push(bars[i].h);
      if(bars[i].l<bars[i-1].l&&bars[i].l<bars[i+1].l) sup.push(bars[i].l);
    }
    const nearest=(arr,above)=>{const f=above?arr.filter(v=>v>price):arr.filter(v=>v<price);return f.length?(above?Math.min(...f):Math.max(...f)):null;};
    return {support:nearest(sup,false),resistance:nearest(res,true)};
  }

  function calcMomentum(bars) {
    const last=bars.slice(-Math.min(5,bars.length));
    return last.filter(b=>b.c>b.o).length-last.filter(b=>b.c<b.o).length;
  }

  function computeSignal(rsi,price,vwap,volData,momentum,sr) {
    const above=vwap!=null&&price>vwap, below=vwap!=null&&price<vwap;
    let signal='HOLD',confidence=50,reasons=[];
    if      (rsi<40&&above&&momentum>=2)                               {signal='BUY'; confidence=80;reasons=['RSI deeply oversold','Above VWAP','Bullish bars'];}
    else if (rsi<45&&above&&volData.surge)                             {signal='BUY'; confidence=72;reasons=['RSI recovery zone','Above VWAP','Volume surge'];}
    else if (sr.support&&price<=sr.support*1.005&&above&&momentum>=1)  {signal='BUY'; confidence=65;reasons=['Support bounce','Above VWAP','Bullish momentum'];}
    else if (rsi>70&&below)                                            {signal='SELL';confidence=78;reasons=['RSI overbought','Below VWAP'];}
    else if (rsi>65&&momentum<=-2)                                     {signal='SELL';confidence=72;reasons=['RSI elevated','Bearish bars'];}
    else if (sr.resistance&&price>=sr.resistance*0.995&&below)         {signal='SELL';confidence=64;reasons=['Resistance wall','Below VWAP'];}
    else {confidence=above&&momentum>0?57:(below&&momentum<0?52:50);}
    return {signal,confidence,reasons};
  }

  function computeBias(rsi,price,vwap,momentum){
    let sc=0;
    if(vwap)(price>vwap?sc++:sc--);
    if(rsi!=null)(rsi<45?sc++:(rsi>60?sc--:0));
    if(momentum>=2)sc++;else if(momentum<=-2)sc--;
    return sc>=2?{text:'Bullish',cls:'bull'}:sc<=-2?{text:'Bearish',cls:'bear'}:{text:'Neutral',cls:'neut'};
  }

  // ── Load analysis ─────────────────────────────────────────────────────────
  async function loadAnalysis(sym) {
    if (!sym) return;
    currentSym   = sym.toUpperCase();
    analysisBusy = true;
    $('trdAnalysisLoading').style.display='flex';
    clearInterval(cdInterval); cdSecs=60; updateCd();

    try {
      const [intraday, quote] = await Promise.all([
        apiFetch('/api/intraday/'+currentSym),
        apiFetch('/api/quote/'+currentSym),
      ]);

      const bars   = intraday?.bars || [];
      const price  = quote?.price ?? (bars.length?bars[bars.length-1].c:null);
      const prev   = quote?.previousClose;
      const chg    = price&&prev ? price-prev : null;
      const pct    = chg&&prev   ? (chg/prev)*100 : null;
      currentPrice = price;

      // Ticker/price
      $('trdTicker').textContent = currentSym;
      $('trdPrice').textContent  = price?'$'+fmt(price):'--';
      if (chg!=null) {
        const up=chg>=0;
        $('trdChg').textContent = (up?'+':'')+fmt(chg)+' ('+(up?'+':'')+fmt(pct)+'%)';
        $('trdChg').className   = 'trd-sym-chg '+(up?'up':'dn');
      }

      // Extended hours badge
      const ext=$('trdExtBadge');
      if (quote?.extendedPrice&&quote?.extendedType) {
        const eChg=quote.extendedPrice-price, ePct=price?(eChg/price)*100:0;
        ext.textContent='['+quote.extendedType+'] $'+fmt(quote.extendedPrice)+' ('+(ePct>=0?'+':'')+fmt(ePct)+'%)';
        ext.style.display='';
      } else { ext.style.display='none'; }

      if (!bars.length) throw new Error('No bars');

      const closes   = bars.map(b=>b.c);
      const vwap     = calcVWAP(bars);
      const rsi      = calcRSI(closes);
      const sr       = calcSR(bars,price);
      const momentum = calcMomentum(bars);
      const vols     = bars.map(b=>b.v||0).filter(v=>v>0);
      const avgV     = vols.length?vols.reduce((a,b)=>a+b,0)/vols.length:0;
      const lastV    = bars[bars.length-1].v||0;
      const volData  = {surge:avgV>0&&lastV/avgV>1.5,lastV,avgV};
      const sig      = computeSignal(rsi??50,price??0,vwap,volData,momentum,sr);
      const bias     = computeBias(rsi??50,price??0,vwap,momentum);

      // Stats
      $('trdVwap').textContent    = vwap?'$'+fmt(vwap):'--';
      $('trdRsi').textContent     = rsi?rsi.toFixed(1):'--';
      const vwapPct = vwap&&price?((price-vwap)/vwap*100):null;
      $('trdVwapPos').textContent = vwapPct!=null?(vwapPct>=0?'+':'')+fmt(vwapPct)+'%':'--';
      $('trdVwapPos').className   = 'trd-stat-val '+(vwapPct>=0?'up':'dn');
      $('trdVol').textContent     = fmtV(lastV)+(volData.surge?' 🔥':'');

      // Signal badge
      const sigEl=$('trdSignal');
      sigEl.textContent = sig.signal;
      sigEl.className   = 'trd-sig-badge sig-'+sig.signal.toLowerCase();
      $('trdSignalConf').textContent = sig.confidence+'% confidence';

      // Bias
      const bEl=$('trdBias');
      bEl.textContent = bias.text;
      bEl.className   = 'trd-bias-badge bias-'+bias.cls;

      // S/R
      $('trdSupport').textContent    = sr.support    ?'$'+fmt(sr.support)   :'--';
      $('trdResistance').textContent = sr.resistance ?'$'+fmt(sr.resistance):'--';

      // Pivot levels
      const dH=Math.max(...bars.map(b=>b.h)), dL=Math.min(...bars.map(b=>b.l)), dC=bars[bars.length-1].c;
      const pp=(dH+dL+dC)/3;
      $('trdPP').textContent='$'+fmt(pp);
      $('trdR1').textContent='$'+fmt(2*pp-dL);
      $('trdR2').textContent='$'+fmt(pp+(dH-dL));
      $('trdS1').textContent='$'+fmt(2*pp-dH);
      $('trdS2').textContent='$'+fmt(pp-(dH-dL));

      // Reasons
      $('trdReasons').innerHTML=sig.reasons.map(r=>`<span class="trd-reason">${r}</span>`).join('');

      // Auto-trade hint — if signal is actionable
      const hintEl=$('trdAutoSigHint');
      if (hintEl) {
        if ((sig.signal==='BUY'||sig.signal==='SELL')&&sig.confidence>=65) {
          hintEl.textContent = `💡 ${sig.signal} signal (${sig.confidence}%) — auto-trader would act on this`;
          hintEl.style.display='';
        } else { hintEl.style.display='none'; }
      }

      updateTradeCalc();
      startCd();
    } catch(e) {
      console.error('[AlpacaTrader] Analysis error:', e);
    } finally {
      $('trdAnalysisLoading').style.display='none';
      analysisBusy=false;
    }
  }

  // ── Countdown ─────────────────────────────────────────────────────────────
  function startCd() {
    clearInterval(cdInterval); cdSecs=60; updateCd();
    cdInterval=setInterval(()=>{
      cdSecs--;updateCd();
      if(cdSecs<=0){cdSecs=60;if(currentSym&&!analysisBusy)loadAnalysis(currentSym);}
    },1000);
  }
  function updateCd(){const el=$('trdRefreshCd');if(el)el.textContent='⟳ '+cdSecs+'s';}

  // ── Trade setup ───────────────────────────────────────────────────────────
  function updateTradeCalc() {
    const amount = parseFloat($('trdAmount')?.value)||0;
    const levAmount = amount * leverage;
    const hint=$('trdSharesHint');
    if (currentPrice&&amount>0) {
      const hasBracket=tpOn||slOn;
      const shares=hasBracket?Math.max(1,Math.floor(levAmount/currentPrice)):(levAmount/currentPrice).toFixed(2);
      const levStr=leverage>1?' ('+leverage+'x leverage = $'+fmt(levAmount)+')':'';
      const brkStr=hasBracket?' — bracket order':'';
      hint.textContent='≈ '+shares+' shares @ $'+fmt(currentPrice)+levStr+brkStr;
      $('trdSumSym').textContent    = currentSym||'--';
      $('trdSumPrice').textContent  = '$'+fmt(currentPrice);
      $('trdSumShares').textContent = shares;
      $('trdSumType').textContent   = hasBracket?'Market + Bracket':'Market';
    } else {
      if(hint) hint.textContent='≈ -- shares';
    }

    // TP
    const tpV=$('trdTpVal'),tpL=$('trdTpLevel');
    if(tpOn){tpV.textContent=(tradeSide==='buy'?'+':'-')+tpPct+'%';
      if(currentPrice)tpL.textContent='→ $'+fmt(tradeSide==='buy'?currentPrice*(1+tpPct/100):currentPrice*(1-tpPct/100));}
    else{tpV.textContent='OFF';tpL.textContent='No take-profit';}

    // SL
    const slV=$('trdSlVal'),slL=$('trdSlLevel');
    if(slOn){slV.textContent=(tradeSide==='buy'?'-':'+')+slPct+'%';
      if(currentPrice)slL.textContent='→ $'+fmt(tradeSide==='buy'?currentPrice*(1-slPct/100):currentPrice*(1+slPct/100));}
    else{slV.textContent='OFF';slL.textContent='No stop-loss';}

    // Execute button
    const btn=$('trdExecuteBtn');
    if(btn){
      if(!connected){btn.disabled=true;btn.textContent='Connect Alpaca to Trade';btn.className='trd-execute-btn';}
      else if(!currentSym||!currentPrice){btn.disabled=true;btn.textContent='Load a symbol first';btn.className='trd-execute-btn';}
      else{
        btn.disabled=false;
        btn.className='trd-execute-btn '+(tradeSide==='buy'?'trd-exec-buy':'trd-exec-sell');
        btn.textContent=tradeSide==='buy'?`BUY ${currentSym}`:`SELL SHORT ${currentSym}`;
        if(leverage>1) btn.textContent+=' ('+leverage+'x)';
      }
    }
  }

  // ── Place manual order ────────────────────────────────────────────────────
  async function placeOrder() {
    const amount=parseFloat($('trdAmount')?.value)||0;
    if(!currentSym||!currentPrice||amount<=0) return;
    const btn=$('trdExecuteBtn'), msgEl=$('trdOrderMsg');
    btn.disabled=true; btn.textContent='Placing order…'; msgEl.textContent=''; msgEl.className='trd-order-msg';
    try {
      const r=await apiFetch('/api/alpaca/order',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({symbol:currentSym,side:tradeSide,amount,tpPct:tpOn?tpPct:0,slPct:slOn?slPct:0,leverage}),
      });
      if(r.error) throw new Error(r.error);
      const lev=r.leverage>1?` (${r.leverage}x leverage)`:'';
      msgEl.textContent=`✓ ${tradeSide.toUpperCase()} order placed — ${r.shares||'~'}sh @ $${fmt(r.price)}${lev}`;
      msgEl.className='trd-order-msg success';
      setTimeout(()=>loadPortfolio(),1500);
    } catch(e){
      msgEl.textContent='✗ '+e.message; msgEl.className='trd-order-msg error';
    } finally { updateTradeCalc(); }
  }

  // ── Portfolio ─────────────────────────────────────────────────────────────
  async function loadPortfolio() {
    if(!connected) return;
    try {
      const [acct,pos,ord]=await Promise.all([
        apiFetch('/api/alpaca/account'),
        apiFetch('/api/alpaca/positions'),
        apiFetch('/api/alpaca/orders'),
      ]);
      renderAccount(acct);
      renderPositions(Array.isArray(pos)?pos:[]);
      renderOrders(Array.isArray(ord)?ord:[]);
    } catch(e){console.error('[AlpacaTrader] Portfolio error:',e.message);}
  }

  function renderAccount(a) {
    const el=$('trdAccountBody'); if(!el) return;
    if(a.error){el.innerHTML=`<div class="trd-bot-empty trd-error">${a.error}</div>`;return;}
    const equity=parseFloat(a.equity||0),cash=parseFloat(a.cash||0),bp=parseFloat(a.buying_power||0);
    const dayPL=parseFloat(a.equity||0)-parseFloat(a.last_equity||a.equity||0);
    const up=dayPL>=0;
    el.innerHTML=`
      <div class="trd-acct-grid">
        <div class="trd-acct-item"><div class="trd-acct-lbl">Portfolio</div><div class="trd-acct-val">$${fmt(equity)}</div></div>
        <div class="trd-acct-item"><div class="trd-acct-lbl">Cash</div><div class="trd-acct-val">$${fmt(cash)}</div></div>
        <div class="trd-acct-item"><div class="trd-acct-lbl">Buying Power</div><div class="trd-acct-val">$${fmt(bp)}</div></div>
        <div class="trd-acct-item"><div class="trd-acct-lbl">Day P&amp;L</div><div class="trd-acct-val ${up?'up':'dn'}">${up?'+':'−'}$${fmt(Math.abs(dayPL))}</div></div>
      </div>
      <div class="trd-acct-status"><span class="trd-dot-green"></span>${a.status==='ACTIVE'?'Account Active':'Status: '+(a.status||'--')}</div>
    `;
  }

  function renderPositions(positions) {
    const el=$('trdPositionsBody'), cn=$('trdPosCount');
    if(cn) cn.textContent=positions.length;
    if(!el) return;
    if(!positions.length){el.innerHTML='<div class="trd-bot-empty">No open positions</div>';return;}
    el.innerHTML=positions.map(p=>{
      const pnl=parseFloat(p.unrealized_pl||0), pct=parseFloat(p.unrealized_plpc||0)*100, up=pnl>=0;
      return `<div class="trd-pos-row">
        <div class="trd-pos-left"><div class="trd-pos-sym">${p.symbol}</div><div class="trd-pos-qty">${parseFloat(p.qty)>0?'Long':'Short'} ${Math.abs(parseFloat(p.qty))} sh</div></div>
        <div class="trd-pos-mid"><div class="trd-pos-price">$${fmt(parseFloat(p.current_price||0))}</div><div class="trd-pos-avg">avg $${fmt(parseFloat(p.avg_entry_price||0))}</div></div>
        <div class="trd-pos-right"><div class="trd-pos-pnl ${up?'up':'dn'}">${up?'+':'−'}$${fmt(Math.abs(pnl))}</div><div class="trd-pos-pct ${up?'up':'dn'}">(${up?'+':''}${fmt(pct)}%)</div></div>
        <button class="trd-close-btn" data-sym="${p.symbol}" title="Close position">✕</button>
      </div>`;
    }).join('');
    el.querySelectorAll('.trd-close-btn').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        btn.disabled=true;btn.textContent='…';
        try{await apiFetch('/api/alpaca/position/'+btn.dataset.sym,{method:'DELETE'});loadPortfolio();}
        catch(e){btn.disabled=false;btn.textContent='✕';alert(e.message);}
      });
    });
  }

  function renderOrders(orders) {
    const el=$('trdOrdersBody'), cn=$('trdOrdCount');
    if(cn) cn.textContent=orders.length;
    if(!el) return;
    if(!orders.length){el.innerHTML='<div class="trd-bot-empty">No recent orders</div>';return;}
    const STATUS={new:'Pending',filled:'Filled',partially_filled:'Partial',canceled:'Cancelled',expired:'Expired',replaced:'Replaced',pending_new:'Submitting',accepted:'Accepted'};
    el.innerHTML=orders.slice(0,12).map(o=>{
      const isPending=o.status==='new'||o.status==='pending_new'||o.status==='accepted';
      const canCancel=isPending||o.status==='partially_filled';
      const stCls=o.status==='filled'?'ord-filled':isPending?'ord-pending':'ord-done';
      return `<div class="trd-ord-row">
        <div class="trd-ord-side ${o.side==='buy'?'ord-buy':'ord-sell'}">${(o.side||'--').toUpperCase()}</div>
        <div class="trd-ord-sym">${o.symbol||'--'}</div>
        <div class="trd-ord-qty">${o.qty||o.notional||'--'}${o.notional?'$':''}</div>
        <div class="trd-ord-px">${parseFloat(o.filled_avg_price||0)?'$'+fmt(parseFloat(o.filled_avg_price)):'--'}</div>
        <div class="trd-ord-st ${stCls}">${STATUS[o.status]||o.status||'--'}</div>
        <div class="trd-ord-time">${fmtTime(o.submitted_at)}</div>
        ${canCancel?`<button class="trd-cancel-btn" data-id="${o.id}">✕</button>`:'<span class="trd-cancel-ph"></span>'}
      </div>`;
    }).join('');
    el.querySelectorAll('.trd-cancel-btn').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        btn.disabled=true;btn.textContent='…';
        try{await apiFetch('/api/alpaca/order/'+btn.dataset.id,{method:'DELETE'});setTimeout(loadPortfolio,800);}
        catch(e){btn.disabled=false;btn.textContent='✕';alert(e.message);}
      });
    });
  }

  // ── Auto-trade settings ───────────────────────────────────────────────────
  async function loadAutoSettings() {
    try {
      const s=await apiFetch('/api/alpaca/auto-settings');
      autoEnabled = !!s.enabled;
      atLeverage  = s.leverage||1;
      if($('atRiskPct'))  $('atRiskPct').value  = s.risk_pct||2;
      if($('atMaxPos'))   $('atMaxPos').value    = s.max_positions||3;
      if($('atTpPct'))    $('atTpPct').value     = s.tp_pct||3;
      if($('atSlPct'))    $('atSlPct').value     = s.sl_pct||1.5;
      if($('atMinVol'))   $('atMinVol').value    = s.min_volume||1000000;
      if($('atConf'))     $('atConf').value      = s.confidence_threshold||70;
      document.querySelectorAll('.at-lev-btn').forEach(b=>b.classList.toggle('active',+b.dataset.lev===atLeverage));
      updateAutoToggleUI();
    } catch(e){}
  }

  async function saveAutoSettings() {
    if(!connected){alert('Connect Alpaca first.');return;}
    const saveBtn=$('trdSaveAutoSettings');
    if(saveBtn){saveBtn.disabled=true;saveBtn.textContent='Saving…';}
    try {
      const body={
        enabled: autoEnabled?1:0,
        risk_pct:   parseFloat($('atRiskPct')?.value)||2,
        max_positions: parseInt($('atMaxPos')?.value)||3,
        tp_pct:     parseFloat($('atTpPct')?.value)||3,
        sl_pct:     parseFloat($('atSlPct')?.value)||1.5,
        min_volume: parseInt($('atMinVol')?.value)||1000000,
        confidence_threshold: parseInt($('atConf')?.value)||70,
        leverage:   atLeverage,
      };
      const r=await apiFetch('/api/alpaca/auto-settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(r.error) throw new Error(r.error);
      const msg=$('trdSaveMsg');if(msg){msg.textContent='✓ Saved';msg.className='trd-save-msg ok';setTimeout(()=>{msg.textContent='';},2500);}
    } catch(e){
      const msg=$('trdSaveMsg');if(msg){msg.textContent='✗ '+e.message;msg.className='trd-save-msg err';}
    } finally {
      if(saveBtn){saveBtn.disabled=false;saveBtn.textContent='Save Settings';}
    }
  }

  async function toggleAutoTrader() {
    if(!connected){alert('Connect Alpaca first.');return;}
    autoEnabled=!autoEnabled;
    await saveAutoSettings();
    updateAutoToggleUI();
    if(autoEnabled) pollAutoStatus();
  }

  function updateAutoToggleUI() {
    const btn=$('trdAutoToggle');
    if(!btn) return;
    if(autoEnabled){
      btn.textContent='⏸ Disable Auto-Trader';
      btn.className='trd-auto-toggle enabled';
    } else {
      btn.textContent='▶ Enable Auto-Trader';
      btn.className='trd-auto-toggle';
    }
    const dot=$('trdAutoDot'), txt=$('trdAutoStatusText'), live=$('trdAutoLive');
    if(dot) dot.className='trd-auto-dot '+(autoEnabled?'dot-green':'dot-grey');
    if(txt) txt.textContent=autoEnabled?'Active':'Disabled';
    if(live) live.style.display=autoEnabled?'':'none';
  }

  // ── Auto status polling ───────────────────────────────────────────────────
  async function pollAutoStatus() {
    if(!connected) return;
    try {
      const st=await apiFetch('/api/alpaca/auto-status');

      // Last scan time
      const scanEl=$('trdLastScan');
      if(scanEl&&st.lastScan){
        const ago=Math.round((Date.now()-new Date(st.lastScan).getTime())/1000);
        scanEl.textContent=ago<60?ago+'s ago':Math.round(ago/60)+'m ago';
      } else if(scanEl) scanEl.textContent='--';

      // Candidates
      const candEl=$('trdCandidates');
      if(candEl) candEl.textContent=Array.isArray(st.candidates)&&st.candidates.length?st.candidates.slice(0,6).join(', '):'--';

      // Last action
      const actEl=$('trdAutoLastAction');
      if(actEl&&st.lastAction) actEl.textContent=st.lastAction;

      // Scanning spinner
      const scanIconEl=$('trdAutoScanIcon');
      if(scanIconEl) scanIconEl.style.display=st.scanning?'':'none';

      // Market open badge
      const mktEl=$('trdMarketStatus');
      if(mktEl){
        mktEl.textContent=st.marketOpen?'Market Open':'Market Closed';
        mktEl.className='trd-mkt-badge '+(st.marketOpen?'mkt-open':'mkt-closed');
      }

      // Rate limit remaining
      const rlEl=$('trdRateLimit');
      if(rlEl&&st.rateLimit!=null) rlEl.textContent='Orders left: '+st.rateLimit+'/10';

      // Error
      const errEl=$('trdAutoError');
      if(errEl){
        if(st.error){errEl.textContent='⚠ '+st.error;errEl.style.display='';}
        else errEl.style.display='none';
      }
    } catch(e){}
  }

  function startStatusPoll() {
    clearInterval(statusPoll);
    statusPoll=setInterval(pollAutoStatus, 5000);
    pollAutoStatus();
  }

  function stopStatusPoll() { clearInterval(statusPoll); statusPoll=null; }

  // ── Auto-trade log ────────────────────────────────────────────────────────
  async function loadAutoLog() {
    const el=$('trdAutoLogBody'); if(!el) return;
    try {
      const logs=await apiFetch('/api/alpaca/auto-log');
      if(!Array.isArray(logs)||!logs.length){
        el.innerHTML='<div class="trd-bot-empty">No auto-trades yet — enable the engine and it will trade automatically</div>';
        return;
      }
      const EXIT_LABELS={
        broker_close:'Broker TP/SL',
        signal_reversal:'Signal flip',
        tp_hit:'TP hit',
        sl_hit:'SL hit',
      };
      el.innerHTML=`
        <div class="trd-alog-header">
          <span>Side</span><span>Symbol</span><span>Sh</span><span>Entry</span><span>TP→</span><span>SL→</span>
          <span>Conf</span><span>P&amp;L</span><span>Exit</span><span>Status</span><span>Time</span>
        </div>
        ${logs.slice(0,25).map(l=>{
          const pnl=l.pnl!=null?parseFloat(l.pnl):null;
          const up=pnl!=null&&pnl>=0;
          const sc=l.status==='open'?'alog-open':pnl!=null&&pnl>0?'alog-win':'alog-loss';
          const statusCls=l.status==='open'?'ord-pending':pnl!=null&&pnl>0?'ord-filled':'ord-done';
          const exitLabel=EXIT_LABELS[l.exit_reason]||'--';
          return `<div class="trd-alog-row ${sc}" title="${l.reasons||''}">
            <span class="${l.side==='buy'?'ord-buy':'ord-sell'}">${(l.side||'').toUpperCase()}</span>
            <span class="trd-ord-sym">${l.symbol}</span>
            <span>${l.shares||'--'}</span>
            <span>$${fmt(l.entry_price)}</span>
            <span class="up">$${fmt(l.tp_price)}</span>
            <span class="dn">$${fmt(l.sl_price)}</span>
            <span class="sig-${(l.signal||'hold').toLowerCase()}">${l.confidence||'--'}%</span>
            <span class="${pnl!=null?(up?'up':'dn'):''}">${pnl!=null?(up?'+':'−')+'$'+fmt(Math.abs(pnl)):'--'}</span>
            <span class="text-dim" style="font-size:0.7rem">${l.status==='open'?'Active':exitLabel}</span>
            <span class="${statusCls}">${l.status==='open'?'Open':'Closed'}</span>
            <span>${fmtDateTime(l.created_at)}</span>
          </div>`;
        }).join('')}
      `;
    } catch(e){el.innerHTML='<div class="trd-bot-empty trd-error">Failed to load log</div>';}
  }

  // ── Connect modal ─────────────────────────────────────────────────────────
  function showModal() {
    const m=$('trdModal'); if(m) m.style.display='flex';
    $('trdModalErr').textContent='';
    $('trdModalDisc').style.display=connected?'':'none';
    // Default to live mode tab
    document.querySelectorAll('.trd-mode-tab').forEach(t=>t.classList.toggle('active',t.dataset.mode===alpacaMode));
    const w=$('trdLiveWarn');if(w) w.style.display=alpacaMode==='live'?'':'none';
  }
  function hideModal() { const m=$('trdModal');if(m) m.style.display='none'; }

  async function saveCredentials() {
    const key=$('trdApiKey')?.value.trim(), secret=$('trdApiSecret')?.value.trim();
    const errEl=$('trdModalErr');
    if(!key||!secret){if(errEl)errEl.textContent='Both fields required.';return;}
    const saveBtn=$('trdModalSave');
    saveBtn.disabled=true; saveBtn.textContent='Connecting…'; errEl.textContent='';
    try {
      const r=await apiFetch('/api/alpaca/credentials',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key,apiSecret:secret,mode:alpacaMode})});
      if(r.error) throw new Error(r.error);
      const acct=await apiFetch('/api/alpaca/account');
      if(acct.error) throw new Error('Credentials saved but account failed: '+acct.error);
      connected=true; alpacaMode=r.mode||'paper';
      hideModal(); updateConnStatus(); loadPortfolio(); loadAutoSettings(); startStatusPoll();
    } catch(e){if(errEl)errEl.textContent=e.message;}
    finally{saveBtn.disabled=false;saveBtn.textContent='Connect';}
  }

  async function disconnect() {
    await apiFetch('/api/alpaca/credentials',{method:'DELETE'});
    connected=false; autoEnabled=false; stopStatusPoll(); updateConnStatus(); updateAutoToggleUI(); hideModal();
    ['trdAccountBody','trdPositionsBody','trdOrdersBody'].forEach(id=>{
      const el=$(id);if(el) el.innerHTML='<div class="trd-bot-empty">Connect Alpaca to view</div>';
    });
    updateTradeCalc();
  }

  function updateConnStatus() {
    const dot=$('trdConnDot'),txt=$('trdConnText'),badge=$('trdModeBadge'),btn=$('trdConnBtn');
    if(connected){
      if(dot) dot.className='trd-conn-dot dot-green';
      if(txt) txt.textContent='Connected';
      if(badge){badge.textContent=alpacaMode.toUpperCase();badge.className='trd-mode-badge mode-'+(alpacaMode==='live'?'live':'paper');}
      if(btn) btn.textContent='Account Settings';
    } else {
      if(dot) dot.className='trd-conn-dot dot-red';
      if(txt) txt.textContent='Not connected';
      if(badge){badge.textContent='DISCONNECTED';badge.className='trd-mode-badge mode-paper';}
      if(btn) btn.textContent='Connect Alpaca';
    }
  }

  async function checkCredentials() {
    try {
      const r=await apiFetch('/api/alpaca/credentials');
      connected=!!r.connected; alpacaMode=r.mode||'paper';
      updateConnStatus();
      if(connected){loadPortfolio();loadAutoSettings();startStatusPoll();}
      updateTradeCalc();
    } catch(e){}
  }

  // ── Quick-ticker grid ─────────────────────────────────────────────────────
  function buildQuickGrid() {
    const grid=$('trdQuickGrid'); if(!grid) return;
    grid.innerHTML=QUICK.map(sym=>`<button class="trd-qt-btn" data-sym="${sym}">${sym}</button>`).join('');
    grid.querySelectorAll('.trd-qt-btn').forEach(btn=>{
      btn.addEventListener('click',()=>selectSymbol(btn.dataset.sym));
    });
  }

  function selectSymbol(sym) {
    $('trdSymInput').value=sym;
    document.querySelectorAll('.trd-qt-btn').forEach(b=>b.classList.toggle('active',b.dataset.sym===sym));
    loadAnalysis(sym);
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function bindEvents() {
    // Symbol
    $('trdSymGo')?.addEventListener('click',()=>{const v=$('trdSymInput').value.trim().toUpperCase();if(v)selectSymbol(v);});
    $('trdSymInput')?.addEventListener('keydown',e=>{if(e.key==='Enter'){const v=e.target.value.trim().toUpperCase();if(v)selectSymbol(v);}});
    $('trdSymInput')?.addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase();});

    // Refresh
    $('trdRefreshNow')?.addEventListener('click',()=>{if(currentSym)loadAnalysis(currentSym);});
    $('trdRefreshAccount')?.addEventListener('click',loadPortfolio);

    // Side
    $('trdBuyBtn')?.addEventListener('click',()=>{tradeSide='buy';$('trdBuyBtn').classList.add('active');$('trdSellBtn').classList.remove('active');updateTradeCalc();});
    $('trdSellBtn')?.addEventListener('click',()=>{tradeSide='sell';$('trdSellBtn').classList.add('active');$('trdBuyBtn').classList.remove('active');updateTradeCalc();});

    // Amount
    $('trdAmount')?.addEventListener('input',updateTradeCalc);

    // Manual leverage buttons
    document.querySelectorAll('.trd-lev-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        leverage=+btn.dataset.lev;
        document.querySelectorAll('.trd-lev-btn').forEach(b=>b.classList.toggle('active',b===btn));
        const warn=$('trdLevWarn');
        if(warn) warn.style.display=leverage>1?'':'none';
        updateTradeCalc();
      });
    });

    // TP/SL
    $('trdTpPlus')?.addEventListener('click',()=>{if(tpOn&&tpPct<20){tpPct++;updateTradeCalc();}});
    $('trdTpMinus')?.addEventListener('click',()=>{if(tpOn&&tpPct>1){tpPct--;updateTradeCalc();}});
    $('trdTpOff')?.addEventListener('click',()=>{tpOn=!tpOn;updateTradeCalc();});
    $('trdSlPlus')?.addEventListener('click',()=>{if(slOn&&slPct<20){slPct++;updateTradeCalc();}});
    $('trdSlMinus')?.addEventListener('click',()=>{if(slOn&&slPct>1){slPct--;updateTradeCalc();}});
    $('trdSlOff')?.addEventListener('click',()=>{slOn=!slOn;updateTradeCalc();});

    // Execute
    $('trdExecuteBtn')?.addEventListener('click',placeOrder);

    // Connection
    $('trdConnBtn')?.addEventListener('click',showModal);
    $('trdModalClose')?.addEventListener('click',hideModal);
    $('trdModal')?.addEventListener('click',e=>{if(e.target.id==='trdModal')hideModal();});
    $('trdModalSave')?.addEventListener('click',saveCredentials);
    $('trdModalDisc')?.addEventListener('click',async()=>{if(confirm('Disconnect and remove stored credentials?'))await disconnect();});

    // Mode tabs
    document.querySelectorAll('.trd-mode-tab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        alpacaMode=tab.dataset.mode;
        document.querySelectorAll('.trd-mode-tab').forEach(t=>t.classList.toggle('active',t===tab));
        const w=$('trdLiveWarn');if(w)w.style.display=alpacaMode==='live'?'':'none';
      });
    });

    // Auto-trader leverage buttons
    document.querySelectorAll('.at-lev-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        atLeverage=+btn.dataset.lev;
        document.querySelectorAll('.at-lev-btn').forEach(b=>b.classList.toggle('active',b===btn));
      });
    });

    // Auto-trader controls
    $('trdAutoToggle')?.addEventListener('click',toggleAutoTrader);
    $('trdSaveAutoSettings')?.addEventListener('click',saveAutoSettings);
    $('trdScanNow')?.addEventListener('click',async()=>{
      const btn=$('trdScanNow');
      if(btn){btn.disabled=true;btn.textContent='Scanning…';}
      try{
        const r=await apiFetch('/api/alpaca/auto-scan',{method:'POST'});
        const msg=$('trdAutoLastAction');if(msg)msg.textContent=r.message||'Scan triggered…';
        setTimeout(()=>{pollAutoStatus();loadAutoLog();},3000);
      }catch(e){alert(e.message);}
      finally{if(btn){btn.disabled=false;btn.textContent='▶ Scan Now';}}
    });
    $('trdRefreshAutoLog')?.addEventListener('click',loadAutoLog);

    // Simulation
    $('trdSimulate')?.addEventListener('click',async()=>{
      const btn=$('trdSimulate');
      const resEl=$('trdSimResults');
      if(!connected){alert('Connect Alpaca first.');return;}
      btn.disabled=true;btn.textContent='Running…';
      try{
        const r=await apiFetch('/api/alpaca/simulate',{method:'POST'});
        if(r.error) throw new Error(r.error);
        const sim=r.simulation||{};
        const analyses=(sim.analyses||[]);
        const mkt=sim.marketOpen?'<span class="sim-open">Market OPEN</span>':'<span class="sim-closed">Market CLOSED</span>';
        const header=`<div class="sim-header">Simulation Results ${mkt} — ${new Date().toLocaleTimeString()} (no real orders placed)</div>`;
        const rows=analyses.length?analyses.map(a=>{
          const sc=a.signal==='BUY'?'ord-buy':a.signal==='SELL'?'ord-sell':'';
          return `<div class="sim-row">
            <span class="${sc}">${a.signal}</span>
            <span class="trd-ord-sym">${a.symbol}</span>
            <span>${a.confidence}%</span>
            <span class="text-dim">$${a.price?a.price.toFixed(2):'--'}</span>
            <span class="text-dim">RSI ${a.rsi?a.rsi.toFixed(0):'--'}</span>
            <span class="sim-reasons">${(a.reasons||[]).join(' · ')}</span>
          </div>`;
        }).join(''):'<div class="sim-empty">No candidates above volume threshold</div>';
        resEl.innerHTML=header+rows;
        resEl.style.display='';
      }catch(e){
        const resEl2=$('trdSimResults');
        if(resEl2){resEl2.innerHTML=`<div class="sim-error">Simulation error: ${e.message}</div>`;resEl2.style.display='';}
      }finally{
        btn.disabled=false;
        btn.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 8 12 12 14 14"/></svg> Run Simulation';
      }
    });
  }

  // ── Page open ─────────────────────────────────────────────────────────────
  function open() {
    checkCredentials().then(()=>{
      if(currentSym) loadAnalysis(currentSym);
      else selectSymbol('SPY');
      loadAutoLog();
    });
  }

  function init() {
    buildQuickGrid();
    bindEvents();
  }

  return { init, open };

})();

document.addEventListener('DOMContentLoaded', () => alpacaTrader.init());
