'use strict';

const DEFAULT_SWING_CONFIG = Object.freeze({
  minDailyBars: 220, minWeeklyBars: 52, maxDailyAgeMs: 5 * 24 * 60 * 60 * 1000,
  maxWeeklyAgeMs: 12 * 24 * 60 * 60 * 1000, minAverageDollarVolume: 1000000,
  minScore: 65, minRewardRisk: 2, slippageBps: 10, maxOutcomeBars: 30,
});
const finite = v => Number.isFinite(Number(v));
const num = v => finite(v) ? Number(v) : null;
const round = v => finite(v) ? +Number(v).toFixed(4) : null;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function validBar(b) {
  if (!b || !['o', 'h', 'l', 'c', 'v'].every(k => finite(b[k]))) return false;
  const [o, h, l, c, v] = [b.o, b.h, b.l, b.c, b.v].map(Number);
  return o > 0 && l > 0 && v > 0 && h >= Math.max(o, c) && l <= Math.min(o, c)
    && b.completed !== false && b.isComplete !== false;
}
function normalizeBars(source) {
  if (!Array.isArray(source) || source.some(b => !validBar(b))) return null;
  return source.map(b => ({ ...b, o:+b.o, h:+b.h, l:+b.l, c:+b.c, v:+b.v }));
}
function aggregateSwingWeeklyBars(dailyBars) {
  const daily=normalizeBars(dailyBars);
  if(!daily)return [];
  const weeks=new Map();
  for(const bar of daily) {
    const date=new Date(stamp(bar));
    const day=date.getUTCDay();
    date.setUTCDate(date.getUTCDate()+(day===0?-6:1-day));
    const key=date.toISOString().slice(0,10);
    const current=weeks.get(key);
    if(!current) weeks.set(key,{t:key,completedAt:bar.t??bar.timestamp,o:bar.o,h:bar.h,l:bar.l,c:bar.c,v:bar.v});
    else {
      current.h=Math.max(current.h,bar.h); current.l=Math.min(current.l,bar.l);
      current.c=bar.c; current.v+=bar.v; current.completedAt=bar.t??bar.timestamp;
    }
  }
  return [...weeks.values()].sort((a,b)=>a.t.localeCompare(b.t));
}
function stamp(bar) { const value = new Date(bar && (bar.t ?? bar.timestamp ?? bar.time)).getTime(); return Number.isFinite(value) ? value : null; }
function sma(values, n) { if (values.length < n) return null; return values.slice(-n).reduce((a,b) => a+b,0) / n; }
function ema(values, n) { if (values.length < n) return null; let x = values.slice(0,n).reduce((a,b)=>a+b,0)/n; const k=2/(n+1); for (const v of values.slice(n)) x=v*k+x*(1-k); return x; }
function rsi(values, n=14) { if (values.length <= n) return null; let gains=0, losses=0; for(let i=values.length-n;i<values.length;i++){const d=values[i]-values[i-1]; gains+=Math.max(0,d); losses+=Math.max(0,-d);} if (!losses) return 100; return 100-(100/(1+gains/losses)); }
function atr(bars, n=14) { if (bars.length < n + 1) return null; const x=[]; for(let i=1;i<bars.length;i++) x.push(Math.max(bars[i].h-bars[i].l,Math.abs(bars[i].h-bars[i-1].c),Math.abs(bars[i].l-bars[i-1].c))); return sma(x,n); }
function context(value, positive) {
  if (value === undefined || value === null) return { state:'UNAVAILABLE', value:null, positive:null };
  const val = typeof value === 'object' ? (value.score ?? value.value ?? value.status) : value;
  return { state:'AVAILABLE', value:val, positive: positive(val, value) };
}
function weeklyBarsAvailableAt(weeklyBars, decisionBar) {
  const decisionStamp=stamp(decisionBar);
  return (Array.isArray(weeklyBars)?weeklyBars:[]).filter(bar=>{
    const availableAt=new Date(bar?.completedAt ?? bar?.endTime ?? bar?.t ?? bar?.timestamp).getTime();
    return Number.isFinite(decisionStamp)&&Number.isFinite(availableAt)&&availableAt<=decisionStamp;
  });
}
function conservativeSwingOutcome(bar, stop, target, slippageBps=10) {
  if (!validBar(bar)) return null;
  const stopHit=bar.l<=stop, targetHit=bar.h>=target;
  if (!stopHit&&!targetHit) return null;
  if (stopHit) {
    const triggerPrice=bar.o<=stop?bar.o:stop;
    return { outcome:'STOP', exitPrice:round(triggerPrice*(1-slippageBps/10000)) };
  }
  return { outcome:'TARGET1', exitPrice:round(target) };
}

function unavailable(reasons, config, daily = 0, weekly = 0) {
  return { strategy:'long-only-swing-v1', status:'NO TRADE', eligible:false, watchState:'UNAVAILABLE',
    direction:'LONG', score:0, confidence:0, entry:null, structuralStop:null, targets:[], riskReward:null,
    reasons:[...new Set(reasons)], config, evidence:{ dailyBars:daily, weeklyBars:weekly } };
}

function evaluateSwingSetup(input = {}, suppliedConfig = {}) {
  const config = { ...DEFAULT_SWING_CONFIG, ...suppliedConfig };
  const dailySource = input.dailyBars || input.bars;
  const weeklySource = input.weeklyBars || input.higherTimeframeBars;
  const daily = normalizeBars(dailySource); const weekly = normalizeBars(weeklySource);
  const invalid = [];
  if (!String(input.symbol || '').trim()) invalid.push('Symbol is unavailable.');
  if (!daily) invalid.push('Completed daily OHLCV bars are missing or malformed.');
  if (!weekly) invalid.push('Completed weekly OHLCV bars are missing or malformed.');
  if (daily && daily.length < config.minDailyBars) invalid.push(`At least ${config.minDailyBars} completed daily bars are required.`);
  if (weekly && weekly.length < config.minWeeklyBars) invalid.push(`At least ${config.minWeeklyBars} completed weekly bars are required.`);
  const now = num(input.now) ?? Date.now();
  const dailyFresh = input.freshness?.daily ?? input.dailyFresh;
  const weeklyFresh = input.freshness?.weekly ?? input.weeklyFresh;
  if (daily && (dailyFresh === false || (dailyFresh !== true
      && (!stamp(daily.at(-1)) || now - stamp(daily.at(-1)) > config.maxDailyAgeMs)))) {
    invalid.push('Daily bars are stale or freshness is unavailable.');
  }
  if (weekly && (weeklyFresh === false || (weeklyFresh !== true
      && (!stamp(weekly.at(-1)) || now - stamp(weekly.at(-1)) > config.maxWeeklyAgeMs)))) {
    invalid.push('Weekly bars are stale or freshness is unavailable.');
  }
  if (invalid.length) return unavailable(invalid, config, daily?.length || 0, weekly?.length || 0);

  const closes=daily.map(b=>b.c), wcloses=weekly.map(b=>b.c), last=daily.at(-1);
  const r=rsi(closes), a=atr(daily), sma20=sma(closes,20), sma50=sma(closes,50), ema20=ema(closes,20), sma200=sma(closes,200);
  const mean=sma(closes,20), variance=closes.slice(-20).reduce((s,x)=>s+(x-mean)**2,0)/20, deviation=Math.sqrt(variance);
  const bollingerPosition=deviation ? (last.c-(mean-2*deviation))/(4*deviation) : null;
  const high=Math.max(...closes.slice(-60)), drawdown=(high-last.c)/high;
  const support=Math.min(...daily.slice(-20).map(b=>b.l)), supportTouches=daily.slice(-20).filter(b=>Math.abs(b.l-support)/support<.012).length;
  const avgVol=sma(daily.map(b=>b.v),20), dollarVolume=avgVol*last.c;
  const reversal=last.c>last.o && last.c>daily.at(-2).h && last.v>=avgVol;
  const exhaustion=daily.slice(-3).filter(b=>b.c<b.o).length>=2 && last.c>last.o && last.l<=support*1.015;
  const priorSma200=sma(closes.slice(0,-20),200);
  const sma200Rising=sma200>priorSma200;
  const weeklySma20=sma(wcloses,20);
  const priorWeeklySma20=sma(wcloses.slice(0,-4),20);
  const weeklyTrend=last.c>sma(wcloses,10) && wcloses.at(-1)>weeklySma20 && weeklySma20>=priorWeeklySma20;
  const trend=last.c>sma50 && sma50>sma200 && sma200Rising && weeklyTrend;
  const relative=context(input.relativeStrength, v => Number(v) > 0 || String(v).toUpperCase()==='STRONG');
  const quality=context(input.quality, v => Number(v) >= 50 || v === true);
  const catalyst=context(input.catalyst, (v,o) => !(o?.bearishUnresolved === true || /BEARISH/.test(String(v).toUpperCase())));
  const sector=context(input.sector, v => Number(v) > 0 || /POSITIVE|BULLISH/.test(String(v).toUpperCase()));
  const market=context(input.market, v => Number(v) > 0 || /POSITIVE|BULLISH/.test(String(v).toUpperCase()));
  const structuralStop=Math.min(support, last.c-(a||0)*2);
  const entry=last.c, risk=entry-structuralStop;
  // Resistance comes only from price history that existed before the reversal
  // sequence. Targets are capped there rather than manufactured at an
  // optimistic fixed multiple.
  const priorResistance=Math.max(...daily.slice(-120,-5).map(bar=>bar.h));
  const availableRewardR=risk>0&&Number.isFinite(priorResistance)?(priorResistance-entry)/risk:0;
  const plannedRewardR=Math.max(0,Math.min(3,availableRewardR));
  const targets=plannedRewardR>0
    ? [plannedRewardR/3,plannedRewardR*2/3,plannedRewardR].map((rMultiple,i)=>({
      name:`T${i+1}`, price:round(entry+risk*rMultiple), r:round(rMultiple),
    }))
    : [];
  const reasons=[];
  if (!(dollarVolume >= config.minAverageDollarVolume)) reasons.push('Liquidity is below the minimum average dollar volume.');
  if (!trend) reasons.push('Long-term trend and weekly structure are not intact.');
  if (last.c < sma200 || wcloses.at(-1) < sma(wcloses,20)) reasons.push('Long-term structure is broken.');
  if (drawdown > .18 && (!reversal || !sma200Rising || last.c<ema20)) reasons.push('Falling knife: severe drawdown lacks repaired long-term structure.');
  if (!reversal || !exhaustion) reasons.push('A confirmed reversal and selling exhaustion are required; RSI or a moving-average touch alone is insufficient.');
  if (catalyst.positive === false) reasons.push('An unresolved bearish catalyst blocks long entries.');
  if (!(risk > 0) || plannedRewardR < config.minRewardRisk) reasons.push(`Historical resistance provides less than ${config.minRewardRisk}R.`);
  const optional=[quality,catalyst,sector,market,relative]; const unavailableOptional=optional.filter(x=>x.state==='UNAVAILABLE').length;
  const componentScores={
    longTermStructure:trend?25:0,
    reversalConfirmation:reversal?18:0,
    sellingExhaustion:exhaustion?12:0,
    supportConfluence:supportTouches>=2?10:0,
    oversold:r>=35&&r<=65?8:0,
    volatilityLocation:bollingerPosition!=null&&bollingerPosition<.65?7:0,
    relativeStrength:relative.positive?8:0,
    quality:quality.positive?5:0,
    sectorContext:sector.positive?4:0,
    marketRegime:market.positive?3:0,
  };
  const score=clamp(Math.round(Object.values(componentScores).reduce((sum,value)=>sum+value,0)),0,100);
  if (score < config.minScore) reasons.push(`Score ${score} is below minimum ${config.minScore}.`);
  const eligible=!reasons.length;
  return { strategy:'long-only-swing-v1', symbol:String(input.symbol).toUpperCase(), direction:'LONG',
    status:eligible?'TRADE ELIGIBLE':(trend && reversal?'WATCH':'NO TRADE'), eligible, watchState: eligible?'READY':(trend?'WATCH':'REJECTED'),
    score, componentScores, confidence:round(score*(unavailableOptional ? .8 : 1)), entry:round(entry), structuralStop:round(structuralStop),
    targets, riskReward:round(plannedRewardR), reasons:[...new Set(reasons)], config,
    evidence:{ rsi:round(r), sma20:round(sma20), sma50:round(sma50), ema20:round(ema20), sma200:round(sma200), sma200Rising, atr:round(a), bollingerPosition:round(bollingerPosition), drawdown:round(drawdown), support:round(support), supportTouches, reversalConfirmation:reversal, sellingExhaustion:exhaustion, trend, weeklyTrend, averageDollarVolume:round(dollarVolume), relativeStrength:relative, quality, catalyst, sector, market } };
}

function simulateSwingBacktest(input={}, config={}) {
  const bars=normalizeBars(input.dailyBars || input.bars) || []; const records=[]; const c={...DEFAULT_SWING_CONFIG,...config};
  for(let i=c.minDailyBars;i<bars.length-1;i++) {
    const weekly=weeklyBarsAvailableAt(input.weeklyBars,bars[i]);
    const setup=evaluateSwingSetup({...input,dailyBars:bars.slice(0,i+1),weeklyBars:weekly,freshness:{daily:true,weekly:true}},c);
    if(!setup.eligible) continue;
    const next=bars[i+1], fill=next.o * (1 + c.slippageBps / 10000); const stop=setup.structuralStop;
    if (!(fill > stop) || fill >= setup.targets[0].price) {
      records.push({decisionIndex:i, entryIndex:i+1, fill:null, outcome:'SKIPPED_GAP', exitPrice:null, exitIndex:i+1, realizedR:null, setup});
      continue;
    }
    const initialRisk=fill-stop;
    const targetHits=[false,false,false];
    let outcome='OPEN', exitPrice=null, exitIndex=null, remaining=1, realizedDollars=0, trailingStop=stop;
    const horizon=Math.min(bars.length,i+1+c.maxOutcomeBars);
    // A signal is generated after session i closes. A bar that touches an
    // active stop and a target is always charged as a stop first. Scale-outs
    // are 25% each; only the final 25% receives a completed-bar trailing stop
    // after TP3 has been confirmed.
    for (let j=i+1;j<horizon;j++) {
      const outcomeBar=bars[j];
      if (outcomeBar.l<=trailingStop) {
        const trigger=outcomeBar.o<=trailingStop?outcomeBar.o:trailingStop;
        exitPrice=trigger*(1-c.slippageBps/10000);
        realizedDollars+=remaining*(exitPrice-fill);
        remaining=0;
        outcome=targetHits[2]?'TRAILING_STOP':'STOP';
        exitIndex=j;
        break;
      }
      for(let targetIndex=0;targetIndex<3;targetIndex++) {
        if(!targetHits[targetIndex]&&outcomeBar.h>=setup.targets[targetIndex].price) {
          targetHits[targetIndex]=true;
          realizedDollars+=.25*(setup.targets[targetIndex].price-fill);
          remaining-=.25;
        }
      }
      if(targetHits[2]&&remaining>0) {
        const known=bars.slice(0,j+1);
        const knownCloses=known.map(bar=>bar.c);
        const ema20=ema(knownCloses,20);
        const knownAtr=atr(known,14);
        const swingLow=Math.min(...known.slice(-10).map(bar=>bar.l));
        const candidate=Math.min(outcomeBar.c*.98,Math.max(ema20||stop,swingLow-(knownAtr||0)*.5));
        trailingStop=Math.max(trailingStop,candidate);
      }
    }
    const realizedR=remaining===0?realizedDollars/initialRisk:null;
    const partialRealizedR=realizedDollars/initialRisk;
    records.push({decisionIndex:i, entryIndex:i+1, fill:round(fill), outcome,
      exitPrice:round(exitPrice), exitIndex, realizedR:round(realizedR),
      partialRealizedR:round(partialRealizedR), targetHits, trailingStop:round(trailingStop), setup});
    // Never simulate overlapping positions in the same symbol, including a
    // position still open at the end of its declared evidence window.
    i=exitIndex!=null?exitIndex:horizon-1;
  }
  return { strategy:'long-only-swing-v1', records, summary:{
    trades:records.length,
    stops:records.filter(x=>x.outcome==='STOP'||x.outcome==='TRAILING_STOP').length,
    targets:records.filter(x=>x.targetHits?.[0]).length,
  } };
}

module.exports={ DEFAULT_SWING_CONFIG, evaluateSwingSetup, analyzeSwingSetup:evaluateSwingSetup,
  simulateSwingBacktest, backtestSwingStrategy:simulateSwingBacktest, validSwingBar:validBar,
  aggregateSwingWeeklyBars, weeklyBarsAvailableAt, conservativeSwingOutcome, sma, ema, rsi, atr };