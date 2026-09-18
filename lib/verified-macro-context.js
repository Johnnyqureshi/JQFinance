'use strict';

// Research context only. Never import this module into order/execution decisions.
const DAY = 86400000;
const MAX_FETCH_AGE = 6 * 3600000;
const MAX_OBSERVATION_DAYS = { treasury: 4, fed: 75, inflation: 75, employment: 75 };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 100) / 100;
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

function normalizeInput(key, input, now) {
  const result = { source: key, url: null, asOf: null, fetchedAt: null, ...input };
  if (result.status !== 'available' || !result.data) {
    return { ...result, status: 'unavailable', data: null, reason: result.reason || 'Provider unavailable' };
  }
  const observed = time(result.asOf);
  const fetched = time(result.fetchedAt);
  // A verified schedule has a retrieval time, not an observation date. Preserve
  // it independently when policy is unavailable, without inventing a Fed asOf.
  const calendarOnly = key === 'fed' && result.asOf == null && result.data.policy == null
    && Number.isFinite(time(result.data.calendarVerifiedAt))
    && time(result.data.calendarVerifiedAt) <= now + 60000
    && now - time(result.data.calendarVerifiedAt) <= MAX_FETCH_AGE;
  if ((!Number.isFinite(observed) && !calendarOnly) || !Number.isFinite(fetched) || observed > now || fetched > now + 60000) {
    return { ...result, status: 'unavailable', data: null, reason: 'Missing or future-dated source timestamp' };
  }
  if (now - observed > MAX_OBSERVATION_DAYS[key] * DAY || now - fetched > MAX_FETCH_AGE) {
    return { ...result, status: 'stale', data: null, reason: `Outside freshness window (${MAX_OBSERVATION_DAYS[key]} observation days; 6 hours since retrieval)` };
  }
  const d = result.data;
  let valid = false;
  if (key === 'treasury') {
    valid = [d.twoYear, d.tenYear, d.thirtyYear].every(v => finite(v) && v >= 0 && v <= 30);
    const p = d.previous;
    // A missing prior observation does not invalidate today's published levels.
    const previousValid = p && [p.twoYear, p.tenYear, p.thirtyYear].every(v => finite(v) && v >= 0 && v <= 30)
      && Number.isFinite(time(p.asOf)) && time(p.asOf) < observed && observed - time(p.asOf) <= 7 * DAY;
    result.data = {
      ...d,
      previous: previousValid ? { ...p } : null,
      curve2s10sBps: valid ? round((d.tenYear - d.twoYear) * 100) : null,
      curveChangeBps: valid && previousValid ? round(((d.tenYear - d.twoYear) - (p.tenYear - p.twoYear)) * 100) : null,
      changesBps: valid && previousValid ? Object.fromEntries(['twoYear', 'tenYear', 'thirtyYear'].map(k => [k, round((d[k] - p[k]) * 100)])) : null,
    };
  } else if (key === 'fed') {
    valid = Array.isArray(d.events);
    const policy = d.policy;
    const policyValid = policy && finite(policy.lower) && finite(policy.upper)
      && policy.lower >= 0 && policy.upper <= 30 && policy.lower <= policy.upper
      && Number.isFinite(time(policy.asOf)) && time(policy.asOf) <= now && now - time(policy.asOf) <= 75 * DAY;
    const calendarTime = time(d.calendarVerifiedAt);
    const calendarValid = Number.isFinite(calendarTime) && calendarTime <= now + 60000 && now - calendarTime <= MAX_FETCH_AGE;
    result.data = {
      ...d,
      policy: policyValid ? { ...policy } : null,
      events: valid && calendarValid ? d.events.filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(time(e.date))).sort((a, b) => a.date.localeCompare(b.date)) : [],
      ...(!calendarValid ? { calendarUnavailable: 'Schedule retrieval timestamp missing or stale.' } : {}),
    };
  } else if (key === 'inflation') {
    valid = finite(d.cpiYoY) && d.cpiYoY >= -20 && d.cpiYoY <= 100;
  } else if (key === 'employment') {
    valid = finite(d.unemploymentRate) && d.unemploymentRate >= 0 && d.unemploymentRate <= 100
      && (d.payrollChangeThousands == null || finite(d.payrollChangeThousands));
  }
  if (!valid) return { ...result, status: 'unavailable', data: null, reason: 'Missing, invalid, or contradictory provider values' };
  return result;
}

function buildVerifiedMacroContext(raw = {}, now = Date.now()) {
  const inputs = Object.fromEntries(Object.keys(MAX_OBSERVATION_DAYS).map(key => [key, normalizeInput(key, raw[key], now)]));
  inputs.geopolitical = {
    status: 'unavailable', source: 'No verified geopolitical risk provider configured',
    url: null, asOf: null, fetchedAt: null, data: null,
    reason: 'Global geopolitical severity cannot be inferred reliably from prices or headlines. Excluded from the score; unavailable does not mean low risk.',
  };
  const treasury = inputs.treasury.data;
  const fed = inputs.fed.data;
  const inflation = inputs.inflation.data;
  const employment = inputs.employment.data;
  const today = new Date(now).toISOString().slice(0, 10);
  const nextEvent = fed?.events.find(e => e.date >= today);
  const daysToEvent = nextEvent ? (time(nextEvent.date) - time(today)) / DAY : null;
  const components = [];
  function add(key, label, points, maxPoints, explanation) {
    components.push({ key, label, points, maxPoints, explanation });
  }
  add('policy', 'Policy-rate pressure', fed?.policy ? (fed.policy.upper >= 5 ? 10 : fed.policy.upper >= 3 ? 5 : 0) : null, 10,
    fed?.policy ? `Fed target upper bound ${fed.policy.upper}%. Rule: ≥5% = 10; ≥3% = 5; otherwise 0.` : 'Verified, fresh policy target range unavailable.');
  add('curve', '2s10s inversion', treasury ? (treasury.curve2s10sBps < -50 ? 25 : treasury.curve2s10sBps < 0 ? 15 : 0) : null, 25,
    treasury ? `10Y minus 2Y: ${treasury.curve2s10sBps} bp. Rule: below −50 bp = 25; below 0 = 15; otherwise 0.` : 'Fresh 2Y/10Y observations unavailable.');
  const change = treasury?.changesBps?.tenYear;
  add('yieldChange', '10Y yield increase', finite(change) ? (change >= 10 ? 15 : change >= 5 ? 8 : 0) : null, 15,
    finite(change) ? `Change from previous reported session: ${change} bp. Rule: ≥10 bp = 15; ≥5 bp = 8; otherwise 0.` : 'Two comparable recent Treasury observations required.');
  add('inflation', 'Inflation pressure', inflation ? (inflation.cpiYoY >= 4 ? 20 : inflation.cpiYoY >= 3 ? 12 : inflation.cpiYoY > 2 ? 5 : 0) : null, 20,
    inflation ? `CPI-U year-over-year: ${round(inflation.cpiYoY)}%. Rule: ≥4% = 20; ≥3% = 12; >2% = 5; otherwise 0. CPI is not the Fed’s PCE target measure.` : 'Fresh CPI observations unavailable.');
  add('employment', 'Labor-market stress', employment ? Math.min(20, (employment.unemploymentRate >= 5 ? 20 : employment.unemploymentRate >= 4 ? 10 : 0) + (employment.payrollChangeThousands < 0 ? 10 : 0)) : null, 20,
    employment ? `Unemployment ${employment.unemploymentRate}%; payroll change ${employment.payrollChangeThousands == null ? 'unavailable' : `${employment.payrollChangeThousands} thousand`}. Rule: unemployment ≥5% = 20; ≥4% = 10; negative payrolls add 10, capped at 20.` : 'Fresh employment observations unavailable.');
  add('event', 'FOMC event proximity', daysToEvent != null ? (daysToEvent <= 3 ? 10 : daysToEvent <= 7 ? 5 : 0) : null, 10,
    nextEvent ? `Next scheduled decision date ${nextEvent.date}. Rule: within 3 calendar days = 10; within 7 = 5; otherwise 0. No intraday time assumed.` : 'Verified upcoming FOMC schedule unavailable.');
  // No imputation, rescaling, or zero contribution for missing core evidence.
  if (employment && !finite(employment.payrollChangeThousands)) {
    components.find(c => c.key === 'employment').points = null;
  }
  const complete = components.every(c => c.points !== null);
  const value = complete ? components.reduce((total, c) => total + c.points, 0) : null;
  const contradictions = [];
  if (inflation?.cpiYoY >= 3 && employment?.unemploymentRate >= 5) {
    contradictions.push('Inflation pressure and labor weakness coexist: tighter-policy and growth risks conflict. Neither signal cancels the other.');
  }
  if (treasury?.curve2s10sBps < 0 && change < 0) {
    contradictions.push('The curve is inverted while the 10Y yield is falling. Lower yields do not remove the inversion warning.');
  }
  const sectorImpacts = [];
  if (treasury && finite(change) && change !== 0) {
    sectorImpacts.push({ sector: 'Technology / REITs / utilities', context: `All else equal, ${change > 0 ? 'rising' : 'falling'} yields can ${change > 0 ? 'pressure' : 'support'} long-duration valuations. Heuristic, not a forecast.` });
  }
  if (treasury) sectorImpacts.push({ sector: 'Banks', context: `The ${treasury.curve2s10sBps < 0 ? 'inverted' : 'non-inverted'} 2s10s curve is lending-margin context, not a bank earnings prediction; funding and credit losses also matter.` });
  if (inflation?.cpiYoY >= 3) sectorImpacts.push({ sector: 'Consumer discretionary', context: 'Elevated CPI can pressure purchasing power and input margins. This does not predict individual stocks.' });
  if (employment?.unemploymentRate >= 5 || employment?.payrollChangeThousands < 0) sectorImpacts.push({ sector: 'Industrials / consumer cyclicals', context: 'Labor weakness can signal softer demand; this is a conditional sensitivity, not a trade signal.' });
  return {
    generatedAt: new Date(now).toISOString(), contextOnly: true, executionImpact: 'none', inputs,
    score: {
      value, regime: value == null ? 'unavailable' : value >= 65 ? 'elevated' : value >= 35 ? 'moderate' : 'lower',
      components, contradictions,
      coverage: `${components.filter(c => c.points !== null).length}/${components.length} measured components; geopolitical risk excluded`,
      methodology: 'Measured macro risk v1: sum of six fixed components (maximum 100). Lower <35, moderate 35–64, elevated ≥65. All six required. Heuristic, not a probability, recommendation, or validated trading signal.',
    },
    sectorImpacts,
    limitations: [
      'Read-only research context. No bot, sizing, entry, exit, or technical-probability gate uses this score. Paper validation is required before any execution use.',
      'Geopolitical risk is unmeasured; a lower measured score is not a statement that overall market risk is low.',
      'Treasury par yields are daily observations, not live quotes. BLS figures are monthly, subject to revisions, and observation dates are not release timestamps.',
      'Freshness limits: Treasury 4 calendar days; Fed policy and BLS observation dates 75 days; provider retrieval 6 hours. Missing or stale core components suppress the score.',
    ],
  };
}

function createMacroContextService({ loadProviders, clock = Date.now, ttlMs = 5 * 60000 } = {}) {
  if (typeof loadProviders !== 'function') throw new TypeError('loadProviders required');
  let cache = null;
  let cachedAt = null;
  let pending = null;
  return async function getContext() {
    const now = clock();
    if (cachedAt !== null && now - cachedAt < ttlMs) return buildVerifiedMacroContext(cache, now);
    if (!pending) {
      pending = Promise.resolve().then(() => loadProviders({ now })).catch(() => ({})).then(raw => {
        cache = raw || {};
        cachedAt = clock();
      }).finally(() => { pending = null; });
    }
    await pending;
    return buildVerifiedMacroContext(cache, clock());
  };
}

module.exports = { buildVerifiedMacroContext, createMacroContextService };