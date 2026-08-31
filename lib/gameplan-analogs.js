'use strict';

const MARKET_TZ = 'America/New_York';

function marketParts(timestamp, timeZone = MARKET_TZ) {
  const ms = typeof timestamp === 'number'
    ? (timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp)
    : Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type)?.value;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minuteOfDay: hour * 60 + minute,
  };
}

function selectCurrentRegularSnapshot(intraday, previousClose, {
  marketState,
  nowMs = Date.now(),
  timeZone = MARKET_TZ,
} = {}) {
  const latest = Array.isArray(intraday) ? intraday.at(-1) : null;
  const parts = latest ? marketParts(latest.t, timeZone) : null;
  const nowParts = marketParts(nowMs, timeZone);
  const latestMs = typeof latest?.t === 'number'
    ? (latest.t < 10_000_000_000 ? latest.t * 1000 : latest.t)
    : Date.parse(latest?.t);
  if (marketState !== 'REGULAR' || !latest || latest.session !== 'reg' || !parts || !nowParts
      || parts.date !== nowParts.date
      || parts.minuteOfDay < 570 || parts.minuteOfDay >= 960
      || !Number.isFinite(latestMs) || nowMs - latestMs < 0 || nowMs - latestMs > 16 * 60_000
      || !(latest.c > 0) || !(previousClose > 0)) return null;
  const changePct = ((latest.c - previousClose) / previousClose) * 100;
  if (!(changePct < 0)) return null;
  return { bar: latest, dropMagnitudePct: Math.abs(changePct) };
}

function buildIntradayAnalogs({ daily, intraday, thresholdPct, currentDropPct, currentBar, timeZone = MARKET_TZ }) {
  if (!Array.isArray(daily) || !Array.isArray(intraday) || !currentBar
      || !(thresholdPct > 0) || !(currentDropPct >= thresholdPct)) return null;
  const current = marketParts(currentBar.t, timeZone);
  if (!current || current.minuteOfDay < 570 || current.minuteOfDay >= 960) return null;
  const magnitudeTolerancePct = Math.max(1, +(currentDropPct * 0.2).toFixed(1));
  const minDropPct = +(Math.max(thresholdPct, currentDropPct - magnitudeTolerancePct)).toFixed(1);
  const maxDropPct = +(currentDropPct + magnitudeTolerancePct).toFixed(1);

  const dailyIndex = new Map(daily.map((bar, index) => [bar.t, index]));
  const sessions = new Map();
  for (const bar of intraday) {
    if (!(bar?.c > 0)) continue;
    const parts = marketParts(bar.t, timeZone);
    if (!parts || parts.date === current.date
        || parts.minuteOfDay < 570 || parts.minuteOfDay >= 960) continue;
    if (!sessions.has(parts.date)) sessions.set(parts.date, []);
    sessions.get(parts.date).push({ ...bar, minuteOfDay: parts.minuteOfDay });
  }

  const events = [];
  for (const [date, bars] of sessions) {
    const dayIndex = dailyIndex.get(date);
    if (!(dayIndex > 0) || dayIndex >= daily.length - 1) continue;
    const priorClose = Number(daily[dayIndex - 1]?.c);
    if (!(priorClose > 0)) continue;

    bars.sort((a, b) => a.minuteOfDay - b.minuteOfDay);
    const comparable = bars.reduce((best, bar) => {
      const distance = Math.abs(bar.minuteOfDay - current.minuteOfDay);
      return !best || distance < best.distance ? { bar, distance } : best;
    }, null);
    // Do not silently compare different parts of the session when data is sparse.
    if (!comparable || comparable.distance > 10) continue;

    const snapshot = comparable.bar;
    const dropPct = ((snapshot.c - priorClose) / priorClose) * 100;
    const dropMagnitudePct = Math.abs(Math.min(0, dropPct));
    if (dropMagnitudePct < minDropPct || dropMagnitudePct > maxDropPct) continue;

    const remaining = bars.filter(bar => bar.minuteOfDay >= snapshot.minuteOfDay);
    const day = daily[dayIndex];
    const next = daily[dayIndex + 1];
    const maxHigh = Math.max(snapshot.c, ...remaining.map(bar => Number(bar.h) || Number(bar.c)));
    const minLow = Math.min(snapshot.c, ...remaining.map(bar => Number(bar.l) || Number(bar.c)));
    const reboundClose = ((day.c - snapshot.c) / snapshot.c) * 100;
    const reboundHigh = ((Math.max(maxHigh, next.h) - snapshot.c) / snapshot.c) * 100;
    const nextRet = ((next.c - day.c) / day.c) * 100;
    events.push({
      reboundClose,
      reboundHigh,
      nextRet,
      nextGreen: next.c > next.o,
      bounced3: reboundClose >= 3,
      bounced5: reboundClose >= 5,
      furtherDown: ((minLow - snapshot.c) / snapshot.c) * 100,
    });
  }

  if (!events.length) return null;
  const avg = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const med = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const pct = predicate => Math.round((events.filter(predicate).length / events.length) * 100);
  return {
    sampleSize: events.length,
    lowConfidence: events.length < 10,
    bounced3Pct: pct(event => event.bounced3),
    bounced5Pct: pct(event => event.bounced5),
    closedGreenNextPct: pct(event => event.nextGreen),
    avgMaxReboundPct: +avg(events.map(event => event.reboundHigh)).toFixed(1),
    medMaxReboundPct: +med(events.map(event => event.reboundHigh)).toFixed(1),
    avgNextDayPct: +avg(events.map(event => event.nextRet)).toFixed(1),
    maxFurtherDownsidePct: +Math.min(...events.map(event => event.furtherDown)).toFixed(1),
    methodology: 'intraday-time-matched',
    comparableTime: `${String(Math.floor(current.minuteOfDay / 60)).padStart(2, '0')}:${String(current.minuteOfDay % 60).padStart(2, '0')} ET`,
    matchWindowMinutes: 10,
    minDropPct,
    maxDropPct,
    magnitudeTolerancePct,
  };
}

module.exports = { buildIntradayAnalogs, marketParts, selectCurrentRegularSnapshot };