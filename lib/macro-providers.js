'use strict';

const TREASURY_SOURCE = 'U.S. Department of the Treasury — Daily Treasury Par Yield Curve Rates';
const TREASURY_BASE = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml';
const FED_SOURCE = 'Board of Governors of the Federal Reserve System — FOMC calendar and statements';
const FED_CALENDAR = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const BLS_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const CPI_SOURCE = 'U.S. Bureau of Labor Statistics — CPI for All Urban Consumers (CUUR0000SA0); asOf is period end';
const JOBS_SOURCE = 'U.S. Bureau of Labor Statistics — Current Population Survey and Current Employment Statistics; asOf is period end';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const BLS_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const BLS_FAILURE_TTL_MS = 15 * 60 * 1000;
const blsCache = new Map();

function errorReason(error) {
  const message = typeof error === 'string'
    ? error
    : error && error.message ? String(error.message) : 'unknown provider error';
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

function unavailable(source, url, fetchedAt, reason) {
  return { status: 'unavailable', source, url, asOf: null, fetchedAt, data: null, reason: errorReason(reason) };
}

async function boundedFetch(fetchImpl, url, options = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is unavailable');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeout;
  const requestAndRead = async () => {
    const response = await fetchImpl(url, { ...options, signal: controller ? controller.signal : undefined });
    if (!response || !response.ok) {
      throw new Error(`provider HTTP ${response && Number.isFinite(response.status) ? response.status : 'error'}`);
    }
    const lengthHeader = response.headers && response.headers.get && response.headers.get('content-length');
    if (lengthHeader && Number(lengthHeader) > MAX_BYTES) throw new Error('provider response exceeds size limit');

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (!item || item.done) break;
          if (!(item.value instanceof Uint8Array)) throw new Error('provider returned an invalid body chunk');
          bytes += item.value.byteLength;
          if (bytes > MAX_BYTES) {
            if (typeof reader.cancel === 'function') await reader.cancel().catch(() => {});
            throw new Error('provider response exceeds size limit');
          }
          chunks.push(item.value);
        }
      } finally {
        if (typeof reader.releaseLock === 'function') reader.releaseLock();
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), bytes)
        .toString('utf8');
    }

    // This path supports simple injected test doubles and older fetch implementations.
    // Production WHATWG fetch responses use the incrementally bounded reader above.
    if (typeof response.text !== 'function') throw new Error('provider response has no readable body');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('provider response exceeds size limit');
    return text;
  };
  try {
    return await Promise.race([
      requestAndRead(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          if (controller) controller.abort();
          reject(new Error('provider request timed out'));
        }, TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function finiteNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<d:${tag}(?:\\s[^>]*)?>([^<]+)</d:${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

function isGregorianDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseTreasury(xml, notAfter) {
  if (typeof xml !== 'string' || !/<feed[\s>]/i.test(xml)) throw new Error('invalid Treasury XML');
  const rows = [];
  for (const match of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const dateText = tagValue(match[0], 'NEW_DATE');
    const date = dateText && /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?$/.exec(dateText);
    const twoYear = finiteNumber(tagValue(match[0], 'BC_2YEAR'));
    const tenYear = finiteNumber(tagValue(match[0], 'BC_10YEAR'));
    const thirtyYear = finiteNumber(tagValue(match[0], 'BC_30YEAR'));
    if (!date || !isGregorianDate(date[1]) ||
      [twoYear, tenYear, thirtyYear].some((value) => value === null || value < 0 || value > 100)) continue;
    if (date[1] <= notAfter) rows.push({ asOf: date[1], twoYear, tenYear, thirtyYear });
  }
  return rows;
}

async function fetchTreasury(fetchImpl, nowDate, fetchedAt) {
  const year = nowDate.getUTCFullYear();
  const urls = [year, year - 1].map((value) =>
    `${TREASURY_BASE}?data=daily_treasury_yield_curve&field_tdr_date_value=${value}`);
  const results = await Promise.allSettled(urls.map((url) => boundedFetch(fetchImpl, url)));
  const rows = [];
  const errors = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push(`${year - index}: ${errorReason(result.reason)}`);
      return;
    }
    try {
      rows.push(...parseTreasury(result.value, nowDate.toISOString().slice(0, 10)));
    } catch (error) {
      errors.push(`${year - index}: ${errorReason(error)}`);
    }
  });
  const byDate = new Map();
  for (const row of rows) {
    const existing = byDate.get(row.asOf);
    if (existing && (existing.twoYear !== row.twoYear || existing.tenYear !== row.tenYear ||
      existing.thirtyYear !== row.thirtyYear)) {
      return unavailable(TREASURY_SOURCE, urls[0], fetchedAt, `conflicting Treasury rows for ${row.asOf}`);
    }
    byDate.set(row.asOf, row);
  }
  const ordered = [...byDate.values()].sort((a, b) => b.asOf.localeCompare(a.asOf));
  if (!ordered.length) return unavailable(TREASURY_SOURCE, urls[0], fetchedAt, errors.join('; ') || 'no complete observed yield rows');
  const latest = ordered[0];
  const envelope = {
    status: 'available',
    source: TREASURY_SOURCE,
    url: `${TREASURY_BASE}?data=daily_treasury_yield_curve&field_tdr_date_value=${latest.asOf.slice(0, 4)}`,
    asOf: latest.asOf,
    fetchedAt,
    data: {
      twoYear: latest.twoYear,
      tenYear: latest.tenYear,
      thirtyYear: latest.thirtyYear,
      previous: ordered[1] || null,
    },
  };
  if (errors.length) envelope.reason = `Partial Treasury fetch: ${errors.join('; ')}`;
  return envelope;
}

function stripHtml(value) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(?:8209|x2011);/gi, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseFedCalendar(html) {
  if (typeof html !== 'string' || !/FOMC Meetings/i.test(html)) throw new Error('invalid FOMC calendar HTML');
  const events = [];
  const statements = [];
  const headings = [...html.matchAll(/<a\s+id="[^"]*">\s*(20\d{2})\s+FOMC Meetings\s*<\/a>/gi)];
  for (let h = 0; h < headings.length; h += 1) {
    const year = Number(headings[h][1]);
    const section = html.slice(headings[h].index, headings[h + 1] ? headings[h + 1].index : html.length);
    for (const rowMatch of section.matchAll(/<div[^>]*class="[^"]*\brow fomc-meeting\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\brow fomc-meeting\b|$)/gi)) {
      const row = rowMatch[1];
      const monthMatch = row.match(/fomc-meeting__month[^>]*>\s*<strong>([A-Za-z]+)<\/strong>/i);
      const dateMatch = row.match(/fomc-meeting__date[^>]*>([^<]+)</i);
      if (!monthMatch || !dateMatch || !MONTHS[monthMatch[1].toLowerCase()]) continue;
      const days = dateMatch[1].match(/\d{1,2}/g);
      if (!days || !days.length) continue;
      const month = MONTHS[monthMatch[1].toLowerCase()];
      const day = Number(days[days.length - 1]);
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (!isGregorianDate(date)) continue;
      const statement = row.match(/href="(\/newsevents\/pressreleases\/monetary(20\d{6})a\.htm)"/i);
      const url = statement ? `https://www.federalreserve.gov${statement[1]}` : `${FED_CALENDAR}#${year}`;
      events.push({ date, title: 'FOMC meeting', url });
      if (statement) {
        const statementDate = `${statement[2].slice(0, 4)}-${statement[2].slice(4, 6)}-${statement[2].slice(6, 8)}`;
        if (isGregorianDate(statementDate)) statements.push({ date: statementDate, url });
      }
    }
  }
  if (!events.length) throw new Error('no FOMC meetings found');
  return {
    events: [...new Map(events.map((event) => [`${event.date}|${event.url}`, event])).values()]
      .sort((a, b) => a.date.localeCompare(b.date)),
    statements: [...new Map(statements.map((item) => [item.url, item])).values()],
  };
}

function parseRate(value) {
  const normalized = value.replace(/[‐‑‒–—−]/g, '-').trim();
  const standaloneFraction = normalized.match(/^(\d+)\/(\d+)$/);
  if (standaloneFraction) {
    const result = Number(standaloneFraction[1]) / Number(standaloneFraction[2]);
    return Number.isFinite(result) ? result : null;
  }
  let match = normalized.match(/^(\d+)(?:-(\d+)\/(\d+))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = match[2] ? Number(match[2]) / Number(match[3]) : 0;
  const result = whole + fraction;
  return Number.isFinite(result) ? result : null;
}

function parseFedPolicy(html) {
  const text = stripHtml(html).replace(/[‐‑‒–—−]/g, '-');
  const match = text.match(/target range for the federal funds rate[\s\S]{0,180}?(?:at|to)\s+(\d+(?:-\d+\/\d+|\/\d+)?)\s+(?:to|-)\s+(\d+(?:-\d+\/\d+|\/\d+)?)\s+percent/i);
  if (!match) throw new Error('latest FOMC statement did not contain a parseable policy range');
  const lower = parseRate(match[1]);
  const upper = parseRate(match[2]);
  if (lower === null || upper === null || lower < 0 || upper > 100 || lower > upper) {
    throw new Error('invalid FOMC policy range');
  }
  return { lower, upper };
}

async function fetchFed(fetchImpl, nowDate, fetchedAt) {
  let parsed;
  try {
    parsed = parseFedCalendar(await boundedFetch(fetchImpl, FED_CALENDAR));
  } catch (error) {
    return unavailable(FED_SOURCE, FED_CALENDAR, fetchedAt, error);
  }
  const today = nowDate.toISOString().slice(0, 10);
  const candidate = parsed.statements.filter((item) => item.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  let policy = null;
  let reason;
  if (candidate) {
    try {
      const range = parseFedPolicy(await boundedFetch(fetchImpl, candidate.url));
      policy = { ...range, asOf: candidate.date, url: candidate.url };
    } catch (error) {
      reason = `FOMC calendar available; policy unavailable: ${errorReason(error)}`;
    }
  } else {
    reason = 'FOMC calendar available; no dated policy statement at or before now';
  }
  const envelope = {
    status: 'available',
    source: FED_SOURCE,
    url: FED_CALENDAR,
    asOf: policy ? policy.asOf : null,
    fetchedAt,
    data: {
      events: parsed.events.filter((event) => event.date >= today),
      policy,
      calendarVerifiedAt: fetchedAt,
    },
  };
  if (reason) envelope.reason = reason;
  return envelope;
}

function parseBlsJson(text, requiredIds) {
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new Error('invalid BLS JSON');
  }
  if (!body || body.status !== 'REQUEST_SUCCEEDED' || !body.Results || !Array.isArray(body.Results.series)) {
    throw new Error(`BLS request failed${body && body.message ? `: ${[].concat(body.message).join('; ')}` : ''}`);
  }
  const output = new Map();
  for (const id of requiredIds) {
    const matching = body.Results.series.filter((series) => series && series.seriesID === id);
    if (matching.length !== 1 || !Array.isArray(matching[0].data)) throw new Error(`BLS series ${id} missing or duplicated`);
    const periods = new Map();
    for (const row of matching[0].data) {
      if (!row || !/^\d{4}$/.test(row.year) || !/^M(0[1-9]|1[0-2])$/.test(row.period)) continue;
      const period = `${row.year}-${row.period.slice(1)}`;
      const value = finiteNumber(row.value);
      if (value === null) continue;
      if (periods.has(period) && periods.get(period) !== value) throw new Error(`conflicting BLS values for ${id} ${period}`);
      periods.set(period, value);
    }
    output.set(id, periods);
  }
  return output;
}

function periodEnd(period) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function priorPeriod(period, months) {
  const [year, month] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 - months, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function fetchBls(fetchImpl, nowDate, fetchedAt, kind) {
  const inflation = kind === 'inflation';
  const ids = inflation ? ['CUUR0000SA0'] : ['LNS14000000', 'CES0000000001'];
  const source = inflation ? CPI_SOURCE : JOBS_SOURCE;
  const body = JSON.stringify({
    seriesid: ids,
    startyear: String(nowDate.getUTCFullYear() - 2),
    endyear: String(nowDate.getUTCFullYear()),
  });
  try {
    const parsed = parseBlsJson(await boundedFetch(fetchImpl, BLS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }), ids);
    const today = nowDate.toISOString().slice(0, 10);
    if (inflation) {
      const values = parsed.get(ids[0]);
      const period = [...values.keys()].filter((item) => periodEnd(item) <= today && values.has(priorPeriod(item, 12)))
        .sort().pop();
      if (!period) throw new Error('no CPI period with a valid year-earlier comparison');
      const current = values.get(period);
      const prior = values.get(priorPeriod(period, 12));
      const cpiYoY = ((current / prior) - 1) * 100;
      if (!Number.isFinite(cpiYoY) || prior <= 0) throw new Error('invalid CPI year-over-year calculation');
      return {
        status: 'available', source, url: BLS_URL, asOf: periodEnd(period), fetchedAt,
        data: { cpiYoY, period },
      };
    }
    const unemployment = parsed.get('LNS14000000');
    const payroll = parsed.get('CES0000000001');
    const period = [...unemployment.keys()].filter((item) => periodEnd(item) <= today).sort().pop();
    if (!period) throw new Error('no valid unemployment observation');
    const unemploymentRate = unemployment.get(period);
    if (unemploymentRate < 0 || unemploymentRate > 100) throw new Error('invalid unemployment rate');
    const previous = priorPeriod(period, 1);
    const payrollChangeThousands = payroll.has(period) && payroll.has(previous)
      ? payroll.get(period) - payroll.get(previous) : null;
    if (payrollChangeThousands !== null && !Number.isFinite(payrollChangeThousands)) {
      throw new Error('invalid payroll change');
    }
    const result = {
      status: 'available', source, url: BLS_URL, asOf: periodEnd(period), fetchedAt,
      data: { unemploymentRate, payrollChangeThousands, period },
    };
    if (payrollChangeThousands === null) result.reason = `Unemployment available; payroll change unavailable for ${period}`;
    return result;
  } catch (error) {
    return unavailable(source, BLS_URL, fetchedAt, error);
  }
}

function cloneEnvelope(value) {
  return JSON.parse(JSON.stringify(value));
}

async function fetchBlsWithCache(fetchImpl, nowDate, fetchedAt, kind) {
  // Injected fetch implementations remain completely deterministic and never
  // share fixture results through process-global state.
  const cacheable = typeof globalThis.fetch === 'function' && fetchImpl === globalThis.fetch;
  if (!cacheable) return fetchBls(fetchImpl, nowDate, fetchedAt, kind);
  const currentTime = Date.now();
  const cached = blsCache.get(kind);
  if (cached && cached.expiresAt > currentTime) return cloneEnvelope(cached.value);
  const value = await fetchBls(fetchImpl, nowDate, fetchedAt, kind);
  blsCache.set(kind, {
    value: cloneEnvelope(value),
    expiresAt: currentTime + (value.status === 'available' ? BLS_SUCCESS_TTL_MS : BLS_FAILURE_TTL_MS),
  });
  return value;
}

async function fetchMacroProviders({ now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const nowDate = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new TypeError('now must be a finite timestamp');
  const fetchedAt = nowDate.toISOString();
  const [treasury, fed, inflation, employment] = await Promise.all([
    fetchTreasury(fetchImpl, nowDate, fetchedAt),
    fetchFed(fetchImpl, nowDate, fetchedAt),
    fetchBlsWithCache(fetchImpl, nowDate, fetchedAt, 'inflation'),
    fetchBlsWithCache(fetchImpl, nowDate, fetchedAt, 'employment'),
  ]);
  return { treasury, fed, inflation, employment };
}

module.exports = { fetchMacroProviders };