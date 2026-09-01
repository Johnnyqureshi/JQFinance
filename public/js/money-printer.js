/* The Money Printer: a read-only viewport into the server-owned Search scheduler. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '—').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
  const usd = v => Number.isFinite(Number(v)) ? `$${Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';
  const pct = v => Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : '—';
  let config = {}, readiness = null, results = [], selected = null, timer = null, initialized = false;
  async function request(url, opts = {}) {
    const r = await fetch(url, { credentials:'include', headers:{'Content-Type':'application/json', ...(opts.headers || {})}, ...opts });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d;
  }
  function connectionGood(r) { return r?.brokerReady === true || (!!(r?.connected || r?.connection?.connected) && r?.broker?.reachable === true && r?.broker?.active === true && !r?.broker?.tradingBlocked && !r?.broker?.accountBlocked); }
  function renderReadiness() {
    const r = readiness || {}, usable = connectionGood(r), mode = String(r.mode || r.account?.mode || 'offline').toUpperCase();
    $('mpConnDot').className = `mp-status-dot ${usable ? 'ready' : 'blocked'}`;
    $('mpConnText').textContent = usable ? `Dedicated broker verified · ${mode} · ${r.accountId || r.account?.id || 'account ready'}` : (r.connected ? `Broker requires attention · ${mode}` : 'Dedicated Alpaca account not connected');
    $('mpMode').textContent = r.liveArmed ? 'LIVE ARMED' : r.enabled ? `${mode} ACTIVE` : 'AUTOMATION PAUSED';
    $('mpMode').className = `mp-mode ${r.liveArmed ? 'live' : r.enabled ? 'active' : ''}`;
    $('mpToggleBtn').textContent = r.enabled ? 'Pause automation' : 'Enable automation';
    $('mpToggleBtn').classList.toggle('is-on', !!r.enabled);
    $('mpConnectBtn').textContent = r.connected ? 'Account settings' : 'Connect Alpaca';
    $('mpLiveArm').checked = !!r.liveArmed; $('mpLiveArm').disabled = mode !== 'LIVE';
    const blockers = r.blockers || [];
    $('mpReadinessNote').className = `mp-alert ${blockers.length ? 'warning' : 'good'}`;
    $('mpReadinessNote').textContent = blockers.length ? blockers.join(' · ') : r.enabled ? 'Scheduler is enabled. The server owns all entry and risk decisions.' : 'Automation is paused. Candidate intelligence remains available for review.';
    const cycleAt = r.lastCycleAt || r.cycle?.evaluatedAt || r.cycle?.lastCycleAt;
    $('mpCycleText').textContent = cycleAt ? `Last cycle ${new Date(cycleAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})} · ${r.lastCycleStatus || r.cycle?.status || 'recorded'}` : 'No cycle timestamp reported';
    const criteria = r.triggerCriteria || r.criteria || r.cycle?.criteria || ['Verified Search evidence', 'Fresh market data and eligible broker state', 'Server risk and position limits'];
    $('mpRuleList').innerHTML = (Array.isArray(criteria) ? criteria : Object.entries(criteria).map(([k,v]) => `${k}: ${v}`)).map(x => `<div class="mp-rule"><span></span>${esc(typeof x === 'string' ? x : x.label || x.name || x)}</div>`).join('');
    const telemetry = [['Broker', usable ? 'Verified' : 'Unavailable'],['Mode', mode],['Cycle', r.lastCycleStatus || r.cycle?.status || 'Not reported'],['Blockers', blockers.length ? blockers.length : 'None']];
    $('mpTelemetryBody').innerHTML = telemetry.map(([k,v]) => `<div><span>${k}</span><strong>${esc(v)}</strong></div>`).join('');
  }
  function levelPair(row, next = false) {
    const support = next ? row.nextSupport : row.support;
    const resistance = next ? row.nextResistance : row.resistance;
    return `<small>SUP</small> ${usd(support)}<br><small>RES</small> ${usd(resistance)}`;
  }
  function renderCandidates() {
    const body = $('mpCandidatesBody'); if (!results.length) { body.innerHTML = '<tr><td colspan="7" class="mp-empty">No ranked candidates were returned in this scan.</td></tr>'; $('mpDetail').textContent = 'The next server scan will publish its complete decision record here.'; return; }
    body.innerHTML = results.map((r,i) => { const buy = r.direction === 'BUY', score = r.confidence ?? r.score; const covered = r.evidenceSummary || r.evidence?.summary; return `<tr data-mp-index="${i}" class="${selected?.symbol===r.symbol?'selected':''}"><td><span class="mp-rank">${i+1}</span><strong>${esc(r.symbol)}</strong></td><td><span class="mp-side ${buy?'buy':'sell'}">${esc(r.direction)}</span></td><td><b>${Number.isFinite(Number(score))?Math.round(score):'—'}</b><i class="mp-score"><em style="width:${Math.max(0,Math.min(100,Number(score)||0))}%"></em></i></td><td>${levelPair(r)}</td><td>${levelPair(r,true)}</td><td>${covered ? 'Covered' : '—'}</td><td><span class="mp-decision ${r.eligible?'eligible':'rejected'}">${esc(r.status || (r.eligible?'ELIGIBLE':'REJECTED'))}</span></td></tr>`; }).join('');
    body.querySelectorAll('[data-mp-index]').forEach(el => el.addEventListener('click', () => { selected = results[Number(el.dataset.mpIndex)]; renderCandidates(); renderDetail(); }));
    renderDetail();
  }
  function renderDetail() {
    if (!selected) return; const r=selected, reasons=r.reasons || [], ev=r.evidence?.summary || r.evidenceSummary || 'No evidence summary supplied.';
    $('mpDetail').innerHTML = `<div class="mp-detail-top"><div><span class="mp-kicker">SETUP DETAIL</span><h3>${esc(r.symbol)} <span class="mp-side ${r.direction==='BUY'?'buy':'sell'}">${esc(r.direction)}</span></h3></div><b>${Math.round(r.confidence ?? r.score ?? 0)}/100</b></div><p>${esc(ev)}</p><div class="mp-detail-levels"><span>Immediate support <b>${usd(r.support)}</b></span><span>Next support <b>${usd(r.nextSupport)}</b></span><span>Immediate resistance <b>${usd(r.resistance)}</b></span><span>Next resistance <b>${usd(r.nextResistance)}</b></span></div><div class="mp-reasons"><strong>${reasons.length?'Decision constraints':'Evidence record'}</strong>${reasons.length?`<ul>${reasons.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'<span>All reported server gates are satisfied for this candidate.</span>'}</div>`;
  }
  function renderTrades(trades) { $('mpTradesBody').innerHTML = trades?.length ? `<div class="mp-trades">${trades.slice(0,8).map(t=>`<div><strong>${esc(t.symbol)}</strong><span>${esc(t.direction || t.side)} · ${esc(t.status)}</span><b>${usd(t.entry_price || t.entryPrice || t.notional)}</b></div>`).join('')}</div>` : '<div class="mp-trades-empty">No broker journal entries are recorded for this account.</div>'; }
  async function loadReadiness(){ try { readiness=await request('/api/money-printer/readiness'); renderReadiness(); } catch(e){ $('mpReadinessNote').className='mp-alert warning'; $('mpReadinessNote').textContent=`Readiness unavailable: ${e.message}`; } }
  async function loadSettings(){ const s=await request('/api/money-printer/settings'); config=s.config||{}; readiness={...(readiness||{}),enabled:s.enabled,liveArmed:s.liveArmed}; $('mpPosition').value=config.maxPositionDollars ?? ''; $('mpProfit').value=config.takeProfitPct ?? ''; $('mpStop').value=config.stopLossPct ?? ''; renderReadiness(); }
  async function scan(){ $('mpFunnel').textContent='Evaluating Search universe…'; try { const d=await request('/api/money-printer/scan'); results=d.results||[]; config={...config,...(d.config||{})}; const f=d.funnel||{}; $('mpFunnel').textContent=`${f.eligible ?? 0} eligible · ${f.rejected ?? 0} rejected · ${d.evaluatedAt?new Date(d.evaluatedAt).toLocaleTimeString():''}`; if(!selected || !results.some(r=>r.symbol===selected.symbol)) selected=results[0]||null; renderCandidates(); } catch(e) { $('mpFunnel').textContent=`Scan unavailable: ${e.message}`; } }
  async function trades(){ try { renderTrades((await request('/api/money-printer/trades')).trades); } catch(e){ $('mpTradesBody').textContent=`Broker journal unavailable: ${e.message}`; } }
  async function save(nextEnabled){ const body={enabled:nextEnabled,liveArmed:$('mpLiveArm').checked,maxPositionDollars:Number($('mpPosition').value),takeProfitPct:Number($('mpProfit').value),stopLossPct:Number($('mpStop').value)}; const out=await request('/api/money-printer/settings',{method:'PUT',body:JSON.stringify(body)}); config=out.config||config; readiness={...(readiness||{}),enabled:out.enabled,liveArmed:out.liveArmed}; renderReadiness(); await scan(); }
  async function refresh(){ await loadReadiness(); await Promise.allSettled([loadSettings(),scan(),trades()]); }
  async function init(){ if(initialized)return; initialized=true; $('mpConnectBtn').addEventListener('click',()=>window.alpacaTrader?.openConnectModal('money-printer')); $('mpRefreshBtn').addEventListener('click',refresh); $('mpScanBtn').addEventListener('click',scan); $('mpSaveBtn').addEventListener('click',()=>save(readiness?.enabled).catch(e=>$('mpReadinessNote').textContent=`Mandate not saved: ${e.message}`)); $('mpToggleBtn').addEventListener('click',()=>save(!readiness?.enabled).catch(e=>$('mpReadinessNote').textContent=`Automation update failed: ${e.message}`)); $('mpReconcileBtn').addEventListener('click',async()=>{ try {renderTrades((await request('/api/money-printer/reconcile',{method:'POST',body:'{}'})).trades);}catch(e){$('mpTradesBody').textContent=`Reconciliation unavailable: ${e.message}`;} }); window.addEventListener('alpaca-connection-changed',e=>{if(e.detail?.connection==='money-printer')refresh();}); await refresh(); }
  window.moneyPrinter={async open(){await init();if(!timer)timer=setInterval(refresh,120000);},pause(){clearInterval(timer);timer=null;}};
}());