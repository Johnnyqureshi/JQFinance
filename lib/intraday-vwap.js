'use strict';

const NEW_YORK_TIME_ZONE = 'America/New_York';

function newYorkParts(date) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: NEW_YORK_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
  return values;
}

function newYorkDateAt(date, hour, minute) {
  const parts = newYorkParts(date);
  const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0);
  const rendered = newYorkParts(new Date(desiredUtc));
  const offsetMs = Date.UTC(
    rendered.year, rendered.month - 1, rendered.day,
    rendered.hour, rendered.minute, rendered.second
  ) - desiredUtc;
  return new Date(desiredUtc - offsetMs);
}

function regularSessionWindow(now = new Date()) {
  return {
    start: newYorkDateAt(now, 9, 30),
    end: newYorkDateAt(now, 16, 0),
  };
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  return Date.parse(value || '');
}

function regularSessionBars(bars, now = new Date()) {
  const { start, end } = regularSessionWindow(now);
  return (Array.isArray(bars) ? bars : []).filter(bar => {
    const timestamp = timestampMs(bar?.t);
    return Number.isFinite(timestamp) && timestamp >= start.getTime() && timestamp < end.getTime();
  });
}

function calculateRegularSessionVwap(bars, now = new Date()) {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const bar of regularSessionBars(bars, now)) {
    const high = Number(bar.h);
    const low = Number(bar.l);
    const close = Number(bar.c);
    const volume = Number(bar.v);
    if (![high, low, close, volume].every(Number.isFinite) || volume <= 0) continue;
    cumulativePriceVolume += ((high + low + close) / 3) * volume;
    cumulativeVolume += volume;
  }
  return cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : null;
}

function isFreshQuoteTimestamp(timestamp, now = new Date(), maxAgeMs = 15_000) {
  const asOf = timestampMs(timestamp);
  if (!Number.isFinite(asOf)) return false;
  const ageMs = now.getTime() - asOf;
  return ageMs >= -5_000 && ageMs <= maxAgeMs;
}

module.exports = {
  calculateRegularSessionVwap,
  isFreshQuoteTimestamp,
  regularSessionBars,
  regularSessionWindow,
};