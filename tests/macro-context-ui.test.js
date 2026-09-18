/* Deterministic DOM-lite coverage for the scanner macro context renderer. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
// Run every renderer assertion in a negative UTC offset, regardless of CI host.
process.env.TZ = 'America/New_York';

function boot(fetchImpl) {
  const elements = {};
  const make = (id, active) => elements[id] = {
    id, innerHTML:'', textContent:'', disabled:false, classList:{ contains: x => active && x === 'active' },
    addEventListener() {}
  };
  make('page-scanner', true); make('macroContent'); make('macroChecked'); make('macroRefresh');
  const context = {
    window:{ location:{ origin:'https://app.test' } }, document:{ visibilityState:'visible', getElementById:id => elements[id] || null },
    URL, AbortSignal, setInterval:() => 1, clearInterval:() => {}, Date, console, fetch:fetchImpl
  };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync('public/js/macro-context.js', 'utf8'), context);
  return { elements, api:context.window.macroContext };
}
const live = { generatedAt:'2025-04-18T12:00:00Z', contextOnly:true, executionImpact:'none',
  inputs:{ treasury:{status:'available',source:'Treasury',url:'https://home.treasury.gov/a',asOf:'2025-04-18T11:00:00Z',fetchedAt:'2025-04-18T12:00:00Z',data:{twoYear:4.2,tenYear:4.4,thirtyYear:4.8,curve2s10sBps:20,curveChangeBps:2,changesBps:{twoYear:1,tenYear:2,thirtyYear:3}}},
    fed:{status:'available',source:'Federal Reserve',url:'https://www.federalreserve.gov',asOf:'2025-04-18T11:00:00Z',fetchedAt:'2025-04-18T12:00:00Z',data:{policy:{lower:4.25,upper:4.5,asOf:'2025-04-01',url:'https://www.federalreserve.gov'},calendarVerifiedAt:'2025-04-18T12:00:00Z',events:[{date:'2025-05-07',title:'FOMC <meeting>',url:'https://www.federalreserve.gov'}]}},
    inflation:{status:'stale',reason:'CPI source delayed',data:null}, employment:{status:'unavailable',reason:'BLS unavailable',data:null}, geopolitical:{status:'unavailable',reason:'No verified feed',data:null}},
  score:{value:42,regime:'Measured',components:[{label:'Rates',points:12,maxPoints:25,explanation:'Observed'}],methodology:'Server method',coverage:'Four inputs',contradictions:['Mixed reads']}, sectorImpacts:[{sector:'Utilities',context:'Rate-sensitive context'}], limitations:[] };

(async () => {
  let calls = 0;
  const app = boot(async () => (++calls === 1 ? {ok:true,status:200,json:async()=>live} : {ok:false,status:503,json:async()=>({})}));
  app.api.init(); await app.api.refresh();
  assert.match(app.elements.macroContent.innerHTML, /42/);
  assert.match(app.elements.macroContent.innerHTML, /2025-05-07/);
  assert(!app.elements.macroContent.innerHTML.includes('FOMC <meeting>'));
  assert.match(app.elements.macroContent.innerHTML, /CPI source delayed/);
  await app.api.refresh();
  const failed = app.elements.macroContent.innerHTML;
  assert.match(failed, /Unavailable/); assert.match(failed, /Refresh failed/);
  assert(!failed.includes('Rate-sensitive context')); assert(!failed.includes('4.2%'));
  const auth = boot(async () => ({ok:false,status:401,json:async()=>({})}));
  auth.api.init(); await auth.api.refresh();
  assert.match(auth.elements.macroContent.innerHTML, /Sign in required/);
  assert.strictEqual(calls, 2);
  const dated = JSON.parse(JSON.stringify(live));
  dated.inputs.treasury.asOf = '2026-09-17';
  dated.inputs.treasury.data.previous = { asOf:'2026-09-16' };
  dated.inputs.fed.asOf = '2026-09-16';
  dated.inputs.fed.data.policy.asOf = '2026-09-16';
  dated.inputs.inflation = {status:'available',source:'BLS CPI',url:'https://bls.gov',asOf:'2026-08-31',fetchedAt:'2026-09-18T12:00:00Z',data:{cpiYoY:3.4,period:'2026-08'}};
  dated.inputs.employment = {status:'available',source:'BLS jobs',url:'https://bls.gov',asOf:'2026-08-31',fetchedAt:'2026-09-18T12:00:00Z',data:{unemploymentRate:4.1,payrollChangeThousands:100,period:'2026-08'}};
  const dates = boot(async () => ({ok:true,status:200,json:async()=>dated}));
  dates.api.init(); await dates.api.refresh();
  const rendered = dates.elements.macroContent.innerHTML;
  // Exact labels and delimiters prove observations have neither shifted dates
  // nor fabricated times; retrieved/generated instants still include time.
  assert.deepStrictEqual([...rendered.matchAll(/Observed ([^<]+?) · Retrieved/g)].map(m => m[1]),
    ['2026-09-17', '2026-09-16', '2026-08-31', '2026-08-31']);
  assert.match(rendered, /prior observation 2026-09-16<\/p>/);
  assert.match(rendered, /· as of 2026-09-16 <a /);
  assert.match(rendered, /Retrieved [^<]*8:00\s*AM/);
  assert.match(dates.elements.macroChecked.textContent, /8:00\s*AM/);
  console.log('macro-context-ui tests passed');
})().catch(err => { console.error(err); process.exitCode = 1; });