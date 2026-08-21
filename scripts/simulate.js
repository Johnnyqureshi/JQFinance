#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Qureshi Finance — deterministic session simulator / smoke suite
// Runs against the LIVE local server via HTTP, exercising the real code paths:
//   1. Auth (register-or-login)
//   2. Public market-data endpoints
//   3. Momentum scanner pipeline (universe → batch → per-symbol analysis)
//   4. Five-pillar scoring sanity (bounds, hard filters honored)
//   5. Fail-closed safety gates (orders/bot without creds must refuse cleanly)
//   6. AI Trade Game Plan shape check
//   7. Biotech catalyst intelligence contract
//   8. Paper-only strategy validation + live shadow comparison contracts
// Usage: node scripts/simulate.js
// Exits 0 when all checks pass, 1 otherwise.
// ─────────────────────────────────────────────────────────────────────────────
const BASE = 'https://' + process.env.REPLIT_DEV_DOMAIN;
const USER = { username: 'sim_harness_user', password: 'Sim!Harness#2026' };

let cookie = '';
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ✗', name, detail || ''); }
}
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j, setCookie: r.headers.get('set-cookie') };
}

(async () => {
  console.log('── 1. Auth ──');
  let r = await api('POST', '/api/auth/login', USER);
  if (r.status !== 200) r = await api('POST', '/api/auth/register', USER);
  check('login/register returns 200', r.status === 200, `got ${r.status}`);
  cookie = (r.setCookie || '').split(';')[0];
  check('session cookie issued', !!cookie);
  const me = await api('GET', '/api/auth/me');
  check('/api/auth/me authenticated', me.status === 200 && !!me.j?.username);

  console.log('── 2. Market data ──');
  const quote = await api('GET', '/api/quote/SPY');
  check('SPY quote has numeric price', typeof quote.j?.price === 'number' && quote.j.price > 100);
  const hist = await api('GET', '/api/historical/SPY?timeseries=20');
  check('historical returns bars', Array.isArray(hist.j?.historical) && hist.j.historical.length >= 10);
  const intra = await api('GET', '/api/intraday/SPY');
  check('intraday returns bars array', Array.isArray(intra.j?.bars));
  const news = await api('GET', '/api/news/AAPL');
  check('news endpoint returns list', news.status === 200);

  console.log('── 3. Momentum scanner pipeline ──');
  const uni = await api('GET', '/api/momentum/universe');
  const symbols = uni.j?.symbols || uni.j?.universe || [];
  check('universe non-empty', symbols.length > 0, `size=${symbols.length}`);
  const batchSyms = symbols.slice(0, 10).map(s => (typeof s === 'string' ? s : s.symbol)).filter(Boolean);
  const batch = await api('POST', '/api/scanner-batch', { symbols: batchSyms.length ? batchSyms : ['AAPL', 'TSLA'] });
  const rows = Array.isArray(batch.j) ? batch.j : (batch.j?.results || []);
  check('scanner-batch returns rows', batch.status === 200 && rows.length > 0, `rows=${rows.length}`);

  const testSym = (rows[0]?.symbol) || 'AAPL';
  const ana = await api('GET', `/api/momentum/analysis/${testSym}`);
  check('momentum analysis returns 200', ana.status === 200);
  const score = ana.j?.score ?? ana.j?.momentumScore;
  if (score != null) {
    check('score within 0–7 bounds', score >= 0 && score <= 7, `score=${score}`);
  } else {
    check('analysis payload has data (score optional for non-qualifying syms)', !!ana.j);
  }

  console.log('── 4. Five-pillar hard filters (qualified names only) ──');
  const qualified = rows.filter(x => x.qualified || x.signal === 'BUY' || x.signal === 'STRONG BUY');
  let filterViolations = 0;
  for (const q of qualified) {
    const p = q.price ?? q.lastPrice;
    if (p != null && (p < 2 || p > 20)) filterViolations++;
    if (q.changePct != null && q.changePct < 10) filterViolations++;
  }
  check('no qualified row violates price/gain filters', filterViolations === 0, `${filterViolations} violation(s) in ${qualified.length} qualified`);

  console.log('── 5. Fail-closed safety gates (user has NO Alpaca creds) ──');
  const acct = await api('GET', '/api/alpaca/account');
  check('account without creds → clean 4xx error', acct.status >= 400 && acct.status < 500 && !!acct.j?.error);
  const order = await api('POST', '/api/alpaca/order', { symbol: 'AAPL', qty: 1, side: 'buy', type: 'market', time_in_force: 'day' });
  check('order without creds is REFUSED', order.status >= 400 && !!order.j?.error, `status=${order.status}`);
  const shortOrder = await api('POST', '/api/alpaca/order', { symbol: 'AAPL', qty: 1, side: 'sell', type: 'market', time_in_force: 'day' });
  check('sell/short without creds/position is REFUSED', shortOrder.status >= 400, `status=${shortOrder.status}`);
  const trig = await api('POST', '/api/bots/trigger', { bot: 'momentum' });
  const trigRefused = trig.j?.ok === false || trig.status >= 400;
  check('bot trigger without creds / off-hours refuses cleanly', trigRefused, JSON.stringify(trig.j).slice(0, 120));
  const flat = await api('DELETE', '/api/alpaca/positions');
  check('flatten without creds → clean 4xx error', flat.status >= 400 && flat.status < 500);

  console.log('── 6. AI Trade Game Plan ──');
  const gp = await api('GET', '/api/gameplan/AAPL');
  check('gameplan returns 200', gp.status === 200);
  if (gp.j?.ok) {
    const d = gp.j;
    check('has probabilities with stated basis', !!d.probabilities?.basis);
    check('probabilities within 0–100', ['reliefBounce','closeGreen','rebound3','rebound5','downsideLeg'].every(k => d.probabilities?.[k] == null || (d.probabilities[k] >= 0 && d.probabilities[k] <= 100)));
    check('has support/resistance levels', Array.isArray(d.levels?.support) && Array.isArray(d.levels?.resistance));
    check('has confidence score 0–100', d.confidence?.overall >= 0 && d.confidence?.overall <= 100);
    check('declares data gaps honestly', Array.isArray(d.dataGaps));
    check('AI narrative present OR reason declared', d.ai?.available === true || typeof d.ai?.reason === 'string');
  } else {
    check('gameplan unavailable is declared honestly', gp.j?.unavailable === true && !!gp.j?.error);
  }
  const gpBad = await api('GET', '/api/gameplan/NOTAREALTICKER123');
  check('bogus ticker → honest unavailable/error, no crash', gpBad.status === 200 ? (gpBad.j?.ok === false) : gpBad.status < 500 || gpBad.j?.error != null);

  console.log('── 7. Biotech Catalyst Intelligence ──');
  const catalyst = await api('GET', '/api/catalyst-intel');
  check('catalyst feed responds without crashing', [200, 503].includes(catalyst.status));
  check('catalyst feed always returns an events array', Array.isArray(catalyst.j?.events));
  check('catalyst feed declares source/data-gap quality', Array.isArray(catalyst.j?.sources) && Array.isArray(catalyst.j?.dataGaps));
  if (catalyst.j?.events?.length) {
    check('catalyst event scores stay within 0–100', catalyst.j.events.every(e =>
      ['catalystScore', 'explosivenessScore', 'confidence', 'opportunityScore']
        .every(k => Number.isFinite(e[k]) && e[k] >= 0 && e[k] <= 100)
    ));
    check('catalyst events retain source and timestamp fields', catalyst.j.events.every(e =>
      typeof e.source === 'string' && Object.hasOwn(e, 'publishedAt') && Object.hasOwn(e, 'verified')
    ));
  } else {
    check('empty catalyst feed is honest about availability', catalyst.j?.ok === true || !!catalyst.j?.error);
  }
  const unauthCatalyst = await fetch(BASE + '/api/catalyst-intel');
  check('catalyst feed rejects unauthenticated access', unauthCatalyst.status === 401);
  const forceOne = await api('GET', '/api/catalyst-intel?force=1');
  const forceTwo = await api('GET', '/api/catalyst-intel?force=1');
  check('manual catalyst refresh is throttled back to cache', forceOne.status === 200 && forceTwo.status === 200 && forceTwo.j?.cached === true);

  console.log('── 8. Paper-only Strategy Validation ──');
  const validation = await api('GET', '/api/momentum/strategy-validation');
  check('strategy validation report returns 200', validation.status === 200);
  check('strategy validation is explicitly paper-only', validation.j?.mode === 'PAPER_ONLY');
  check('strategy validation cannot alter live orders', validation.j?.liveOrdersChanged === false);
  check('strategy validation reports a promotion decision',
    ['NO_PROMOTION', 'PROMOTED_TO_PAPER'].includes(validation.j?.promotionStatus),
    `status=${validation.j?.promotionStatus}`);
  check('strategy validation includes held-out metrics',
    Number.isFinite(validation.j?.testMetrics?.n) && Number.isFinite(validation.j?.testMetrics?.netExpectancy));
  check('strategy validation exposes its held-out confidence interval',
    Number.isFinite(validation.j?.testConfidenceInterval?.lo)
      && Number.isFinite(validation.j?.testConfidenceInterval?.hi));
  check('strategy validation exposes immutable input identity',
    /^[a-f0-9]{64}$/.test(validation.j?.inputSha256 || ''));
  check('strategy validation exposes a locked experiment identity',
    /^[a-f0-9]{64}$/.test(validation.j?.experimentSha256 || '')
      && /^node scripts\/validate-strategy\.js --experiment reports\/data\//.test(validation.j?.replayCommand || ''));
  check('insufficient historical samples remain non-evaluable',
    validation.j?.sampleAdequate === false
      && validation.j?.strategyEvaluable === false
      && validation.j?.promotionStatus === 'NO_PROMOTION');
  const shadow = await api('GET', '/api/momentum/paper-comparison');
  check('paper shadow comparison returns 200', shadow.status === 200 && shadow.j?.available === true);
  check('paper shadow comparison cannot enable execution',
    shadow.j?.mode === 'PAPER_ONLY' && shadow.j?.liveExecutionAllowed === false);
  check('paper shadow stores paired baseline and selected decisions',
    Number.isFinite(shadow.j?.pairedDecisions)
      && Number.isFinite(shadow.j?.baseline?.decisions?.decisions)
      && Number.isFinite(shadow.j?.selected?.decisions?.decisions));
  check('paper shadow keeps an inadequate study baseline-only',
    shadow.j?.sampleAdequate === false
      && shadow.j?.strategyEvaluable === false
      && shadow.j?.shadowState === 'ACTIVE_BASELINE_ONLY');
  const unauthValidation = await fetch(BASE + '/api/momentum/strategy-validation');
  check('strategy validation rejects unauthenticated access', unauthValidation.status === 401);
  const unauthShadow = await fetch(BASE + '/api/momentum/paper-comparison');
  check('paper shadow comparison rejects unauthenticated access', unauthShadow.status === 401);

  console.log('\n══════════════════════════════════');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  -', f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SIMULATOR CRASHED:', e); process.exit(1); });
