'use strict';

const assert = require('node:assert/strict');
const { fetchMacroProviders } = require('../lib/macro-providers');

const treasury = (rows) => `<?xml version="1.0"?><feed>${rows.map((row) => `<entry><content><m:properties>
<d:NEW_DATE m:type="Edm.DateTime">${row[0]}T00:00:00</d:NEW_DATE>
<d:BC_2YEAR>${row[1]}</d:BC_2YEAR><d:BC_10YEAR>${row[2]}</d:BC_10YEAR><d:BC_30YEAR>${row[3]}</d:BC_30YEAR>
</m:properties></content></entry>`).join('')}</feed>`;

const fedCalendar = `<html><h1>FOMC Meetings</h1>
<a id="y">2025 FOMC Meetings</a>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>January</strong></div>
<div class="fomc-meeting__date">28-29</div><strong>Statement:</strong>
<a href="/newsevents/pressreleases/monetary20250129a.htm">HTML</a></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>March</strong></div>
<div class="fomc-meeting__date">18-19*</div></div></html>`;

function bls(series) {
  return JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series } });
}

const cpi = bls([{ seriesID: 'CUUR0000SA0', data: [
  { year: '2025', period: 'M01', value: '310' },
  { year: '2024', period: 'M01', value: '300' },
] }]);
const jobs = bls([
  { seriesID: 'LNS14000000', data: [{ year: '2025', period: 'M01', value: '4.1' }] },
  { seriesID: 'CES0000000001', data: [
    { year: '2025', period: 'M01', value: '158100' },
    { year: '2024', period: 'M12', value: '158000' },
  ] },
]);

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body };
}

function streamedResponse(chunks, status = 200) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

function fixtureFetch(overrides = {}) {
  return async (url, options = {}) => {
    if (overrides[url]) {
      const value = overrides[url];
      if (value instanceof Error) throw value;
      return response(value.body, value.status || 200);
    }
    if (url.includes('field_tdr_date_value=2025')) return response(treasury([['2025-01-02', '4.2', '4.5', '4.7']]));
    if (url.includes('field_tdr_date_value=2024')) return response(treasury([['2024-12-31', '4.1', '4.4', '4.6']]));
    if (url.endsWith('fomccalendars.htm')) return response(fedCalendar);
    if (url.includes('monetary20250129a.htm')) {
      return response('<p>The Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent.</p>');
    }
    if (url.includes('api.bls.gov')) {
      const request = JSON.parse(options.body);
      return response(request.seriesid.length === 1 ? cpi : jobs);
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

(async () => {
  const now = Date.parse('2025-02-15T12:00:00Z');
  const result = await fetchMacroProviders({ now, fetchImpl: fixtureFetch() });
  assert.deepEqual(result.treasury.data, {
    twoYear: 4.2, tenYear: 4.5, thirtyYear: 4.7,
    previous: { asOf: '2024-12-31', twoYear: 4.1, tenYear: 4.4, thirtyYear: 4.6 },
  });
  assert.equal(result.treasury.asOf, '2025-01-02');
  assert.equal(result.treasury.fetchedAt, '2025-02-15T12:00:00.000Z');
  assert.deepEqual(result.fed.data.policy, {
    lower: 4.25, upper: 4.5, asOf: '2025-01-29',
    url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20250129a.htm',
  });
  assert.equal(result.fed.data.calendarVerifiedAt, result.fed.fetchedAt);
  assert.deepEqual(result.inflation.data, { cpiYoY: (310 / 300 - 1) * 100, period: '2025-01' });
  assert.equal(result.inflation.asOf, '2025-01-31');
  assert.deepEqual(result.employment.data, {
    unemploymentRate: 4.1, payrollChangeThousands: 100, period: '2025-01',
  });

  const badStatement = await fetchMacroProviders({
    now,
    fetchImpl: fixtureFetch({
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20250129a.htm': { body: '<p>No range here.</p>' },
    }),
  });
  assert.equal(badStatement.fed.status, 'available');
  assert.deepEqual(badStatement.fed.data.events.map((event) => event.date), ['2025-03-19']);
  assert.equal(badStatement.fed.data.policy, null);
  assert.match(badStatement.fed.reason, /policy unavailable/);
  for (const [range, lower, upper] of [['0 to 1/4', 0, 0.25], ['1/4 to 1/2', 0.25, 0.5]]) {
    const fraction = await fetchMacroProviders({
      now, fetchImpl: fixtureFetch({
        'https://www.federalreserve.gov/newsevents/pressreleases/monetary20250129a.htm':
          { body: `<p>The target range for the federal funds rate at ${range} percent.</p>` },
      }),
    });
    assert.equal(fraction.fed.data.policy.lower, lower);
    assert.equal(fraction.fed.data.policy.upper, upper);
  }

  const badTreasury = treasury([
    ['2025-01-02', '4.2', '4.5', '4.7'],
    ['2025-01-02', '9.2', '4.5', '4.7'],
  ]);
  const conflicts = await fetchMacroProviders({
    now,
    fetchImpl: fixtureFetch({
      'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=2025': { body: badTreasury },
    }),
  });
  assert.equal(conflicts.treasury.status, 'unavailable');
  assert.match(conflicts.treasury.reason, /conflicting/);

  const failedBls = await fetchMacroProviders({
    now,
    fetchImpl: async (url, options) => url.includes('api.bls.gov')
      ? response('service down', 503)
      : fixtureFetch()(url, options),
  });
  assert.equal(failedBls.inflation.status, 'unavailable');
  assert.equal(failedBls.employment.status, 'unavailable');
  assert.equal(failedBls.treasury.status, 'available');
  assert.equal(failedBls.fed.status, 'available');

  const missingPayroll = bls([
    { seriesID: 'LNS14000000', data: [{ year: '2025', period: 'M01', value: '4.1' }] },
    { seriesID: 'CES0000000001', data: [{ year: '2025', period: 'M01', value: '-' }] },
  ]);
  const partialJobs = await fetchMacroProviders({
    now,
    fetchImpl: async (url, options) => {
      if (url.includes('api.bls.gov') && JSON.parse(options.body).seriesid.length === 2) return response(missingPayroll);
      return fixtureFetch()(url, options);
    },
  });
  assert.equal(partialJobs.employment.status, 'available');
  assert.equal(partialJobs.employment.data.payrollChangeThousands, null);
  assert.match(partialJobs.employment.reason, /payroll change unavailable/);

  const invalidDate = await fetchMacroProviders({
    now,
    fetchImpl: async (url, options) => {
      if (url.includes('field_tdr_date_value=2025')) {
        return response(treasury([['2025-02-31', '4.2', '4.5', '4.7']]));
      }
      if (url.includes('field_tdr_date_value=2024')) return response('<feed></feed>');
      return fixtureFetch()(url, options);
    },
  });
  assert.equal(invalidDate.treasury.status, 'unavailable');
  assert.match(invalidDate.treasury.reason, /no complete observed yield rows/);

  const oversizedChunk = new Uint8Array((2 * 1024 * 1024) + 1);
  const bounded = await fetchMacroProviders({
    now,
    fetchImpl: async (url, options) => {
      if (url.includes('api.bls.gov')) return streamedResponse([oversizedChunk]);
      return fixtureFetch()(url, options);
    },
  });
  assert.equal(bounded.inflation.status, 'unavailable');
  assert.match(bounded.inflation.reason, /size limit/);
  assert.equal(bounded.employment.status, 'unavailable');

  const originalFetch = globalThis.fetch;
  let publicBlsCalls = 0;
  const publicFixture = async (url, options) => {
    if (url.includes('api.bls.gov')) publicBlsCalls += 1;
    return fixtureFetch()(url, options);
  };
  globalThis.fetch = publicFixture;
  try {
    const firstCached = await fetchMacroProviders({ now });
    const secondCached = await fetchMacroProviders({ now: now + 60_000 });
    assert.equal(publicBlsCalls, 2);
    assert.equal(secondCached.inflation.fetchedAt, firstCached.inflation.fetchedAt);
    assert.equal(secondCached.employment.fetchedAt, firstCached.employment.fetchedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('macro provider tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});