'use strict';

function barsFromBrokerResponse(payload, symbol) {
  const bars = Array.isArray(payload?.bars) ? payload.bars : payload?.bars?.[symbol];
  if (!Array.isArray(bars)) throw new Error(`Broker bar history is unavailable for ${symbol}.`);
  return bars;
}

function easternDateKey(value = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}
function isoWeekMonday(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}
function completedDailyBars(rawBars, now = Date.now()) {
  const today = easternDateKey(now);
  return (Array.isArray(rawBars) ? rawBars : []).filter(bar => {
    const timestamp = Date.parse(bar?.t ?? bar?.timestamp ?? '');
    return Number.isFinite(timestamp) && easternDateKey(timestamp) < today;
  }).map(bar => ({
    o: +bar.o, h: +bar.h, l: +bar.l, c: +bar.c, v: +bar.v,
    t: bar.t ?? bar.timestamp, completed: true,
  })).filter(bar => [bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite));
}
function completedWeeklyBars(dailyBars, now = Date.now()) {
  const currentWeek = isoWeekMonday(easternDateKey(now));
  return groupDailyToWeekly(dailyBars)
    .filter(bar => bar.t < currentWeek)
    .map(bar => ({ ...bar, completed: true }));
}

function groupDailyToWeekly(dailyBars) {
  const weeks = {};
  for (const bar of dailyBars) {
    const d   = new Date((bar.t || '').includes('T') ? bar.t : bar.t + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon  = new Date(d);
    mon.setUTCDate(d.getUTCDate() + diff);
    const key = `${mon.getUTCFullYear()}-${String(mon.getUTCMonth()+1).padStart(2,'0')}-${String(mon.getUTCDate()).padStart(2,'0')}`;
    if (!weeks[key]) {
      weeks[key] = { t: key, completedAt: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 };
    } else {
      const w = weeks[key];
      w.h = Math.max(w.h, bar.h);
      w.l = Math.min(w.l, bar.l);
      w.c = bar.c;
      w.v += bar.v || 0;
      w.completedAt = bar.t;
    }
  }
  return Object.values(weeks).sort((a, b) => a.t.localeCompare(b.t));
}

module.exports = { barsFromBrokerResponse, easternDateKey, isoWeekMonday, completedDailyBars, completedWeeklyBars, groupDailyToWeekly };