'use strict';

const DEFAULT_TIMEZONE = 'America/New_York';

function finite(value) {
  return value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
    && Number.isFinite(Number(value));
}

function marketDate(nowMs = Date.now(), timezone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function marketMinute(nowMs = Date.now(), timezone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function normalizeDailyBars(dailyBars) {
  return (Array.isArray(dailyBars) ? dailyBars : [])
    .filter(bar => [bar?.o, bar?.h, bar?.l, bar?.c].every(finite))
    .map(bar => ({
      t: String(bar.t || bar.date || '').slice(0, 10),
      o: Number(bar.o),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
      v: finite(bar.v) ? Number(bar.v) : null,
    }))
    .filter(bar => bar.t && bar.h >= bar.l && bar.o > 0 && bar.c > 0)
    .sort((a, b) => a.t.localeCompare(b.t));
}

function completedDailyBars(dailyBars, {
  nowMs = Date.now(),
  marketState = 'CLOSED',
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const bars = normalizeDailyBars(dailyBars);
  const latest = bars.at(-1);
  if (!latest) return [];
  // Fail closed for today's candle before 4:00 PM ET. Provider market-state
  // values are occasionally absent or stale; the exchange clock is the safer
  // authority for deciding whether a daily bar is complete.
  const beforeRegularClose = marketMinute(nowMs, timezone) < 16 * 60;
  return beforeRegularClose && latest.t === marketDate(nowMs, timezone)
    ? bars.slice(0, -1)
    : bars;
}

function atrWilder(completedBars, period = 14) {
  // A rolling ATR(period) needs period true ranges, hence period + 1 completed
  // bars. Bound the input so older history cannot influence today's buffer.
  const bars = normalizeDailyBars(completedBars).slice(-(period + 1));
  if (bars.length < period + 1) return null;
  const trueRanges = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1].c;
    trueRanges.push(Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - previousClose),
      Math.abs(bar.l - previousClose),
    ));
  }
  return trueRanges.reduce((sum, value) => sum + value, 0) / period;
}

function dailyPivots(anchorBar, currentPrice, atr) {
  if (!anchorBar) return null;
  const { h: high, l: low, c: close, t: anchorDate } = anchorBar;
  if (![high, low, close].every(finite) || high < low) return null;
  const pp = (high + low + close) / 3;
  const priorRange = high - low;
  const r1 = (2 * pp) - low;
  const r2 = pp + priorRange;
  const s1 = (2 * pp) - high;
  const s2 = pp - priorRange;
  const price = finite(currentPrice) ? Number(currentPrice) : pp;
  let zone;
  let zoneClass;
  if (price >= r2) { zone = 'Above R2'; zoneClass = 'bull'; }
  else if (price >= r1) { zone = 'R1–R2 Zone'; zoneClass = 'bull'; }
  else if (price >= pp) { zone = 'PP–R1 Zone'; zoneClass = 'bull'; }
  else if (price >= s1) { zone = 'S1–PP Zone'; zoneClass = 'bear'; }
  else if (price >= s2) { zone = 'S2–S1 Zone'; zoneClass = 'bear'; }
  else { zone = 'Below S2'; zoneClass = 'bear'; }
  return {
    pp, r1, r2, s1, s2,
    priorRange,
    priorRangePct: price > 0 ? (priorRange / price) * 100 : null,
    atr: finite(atr) ? Number(atr) : null,
    anchorDate,
    zone,
    zoneClass,
  };
}

function confirmedSwings(completedBars, lookback = 14) {
  const bars = normalizeDailyBars(completedBars).slice(-lookback);
  const highs = [];
  const lows = [];
  for (let index = 2; index < bars.length - 2; index += 1) {
    const window = bars.slice(index - 2, index + 3);
    if (bars[index].h === Math.max(...window.map(bar => bar.h))) highs.push(bars[index].h);
    if (bars[index].l === Math.min(...window.map(bar => bar.l))) lows.push(bars[index].l);
  }
  return { highs, lows };
}

function levelZone(price, buffer) {
  const halfWidth = finite(buffer) ? Number(buffer) : 0;
  return {
    zoneLow: +(Number(price) - halfWidth).toFixed(2),
    zoneHigh: +(Number(price) + halfWidth).toFixed(2),
  };
}

function buildSearchLevels({
  dailyBars,
  currentPrice,
  marketState,
  nowMs = Date.now(),
  timezone = DEFAULT_TIMEZONE,
  lookback = 14,
} = {}) {
  const price = Number(currentPrice);
  if (!finite(price) || price <= 0) {
    return { completedBars: [], anchorBar: null, atr: null, dailyPivots: null, levels: null, displayLevels: null };
  }
  const completed = completedDailyBars(dailyBars, { nowMs, marketState, timezone });
  const anchorBar = completed.at(-1) || null;
  const atr = atrWilder(completed, 14);
  const pivots = dailyPivots(anchorBar, price, atr);
  if (!anchorBar || !pivots) {
    return { completedBars: completed, anchorBar, atr, dailyPivots: null, levels: null, displayLevels: null };
  }

  const recent = completed.slice(-lookback);
  const swings = confirmedSwings(completed, lookback);
  // ATR is the preferred volatility measure. A symbol with a shorter history
  // still has a real prior-session range, so the level engine uses that range
  // rather than dropping the support/resistance card entirely.
  const volatility = finite(atr)
    ? Number(atr)
    : Math.max(anchorBar.h - anchorBar.l, price * 0.005, 0.01);
  const candidates = [
    { price: anchorBar.h, label: 'Prior-session high' },
    { price: anchorBar.l, label: 'Prior-session low' },
    { price: pivots.r1, label: 'Daily R1' },
    { price: pivots.r2, label: 'Daily R2' },
    { price: pivots.s1, label: 'Daily S1' },
    { price: pivots.s2, label: 'Daily S2' },
    { price: Math.max(...recent.map(bar => bar.h)), label: `${lookback}-session high` },
    { price: Math.min(...recent.map(bar => bar.l)), label: `${lookback}-session low` },
    ...swings.highs.map(value => ({ price: value, label: 'Confirmed swing high' })),
    ...swings.lows.map(value => ({ price: value, label: 'Confirmed swing low' })),
  ].filter(level => finite(level.price) && level.price > 0);

  const buffer = Math.max(price * 0.0005, Math.min(price * 0.003, volatility * 0.10));
  const dedupe = levels => {
    const sorted = [...levels].sort((a, b) => a.price - b.price);
    const merged = [];
    for (const candidate of sorted) {
      const existing = merged.find(level => Math.abs(level.price - candidate.price) <= buffer);
      if (existing) {
        existing.price = (existing.price * existing.confirmations + candidate.price) / (existing.confirmations + 1);
        existing.confirmations += 1;
        if (!existing.label.includes(candidate.label)) existing.label += ` + ${candidate.label}`;
      } else {
        merged.push({ ...candidate, confirmations: 1 });
      }
    }
    return merged.map(level => ({
      ...level,
      price: +level.price.toFixed(2),
      ...levelZone(level.price, buffer),
    }));
  };

  const allLevels = dedupe(candidates);
  const nearby = allLevels.filter(level => Math.abs(level.price - price) / price <= 0.15);
  const supportLabels = /low|s[12]\b|support/i;
  const resistanceLabels = /high|r[12]\b|resistance/i;
  const projected = (side, distance, label) => {
    const projectedPrice = side === 'support' ? price - distance : price + distance;
    return {
      price: +projectedPrice.toFixed(2),
      label,
      confirmations: 1,
      ...levelZone(projectedPrice, buffer),
    };
  };

  function pickSide(side) {
    const isSupport = side === 'support';
    const direction = level => isSupport ? level.price < price : level.price > price;
    const labelMatch = level => (isSupport ? supportLabels : resistanceLabels).test(level.label);
    const ordered = list => list
      .filter(level => finite(level.price) && level.price > 0)
      .sort((a, b) => isSupport ? b.price - a.price : a.price - b.price);
    const selected = [];
    const add = level => {
      if (!level || selected.some(existing => Math.abs(existing.price - level.price) <= buffer)) return;
      selected.push(level);
    };

    // Prefer the nearest completed-session level on the correct side.
    ordered(nearby.filter(direction)).forEach(add);
    // If extended-hours price is beyond the completed-session range, use the
    // nearest named structural level instead of reporting no support/resistance.
    ordered(allLevels.filter(labelMatch)).forEach(level => {
      if (selected.length < 2) add(level);
    });

    const projectionDistance = Math.max(volatility, price * 0.005);
    const first = selected[0];
    const nextDirectional = first
      ? ordered(allLevels.filter(level => isSupport
        ? level.price < first.price
        : level.price > first.price)).find(level => !selected.some(item => Math.abs(item.price - level.price) <= buffer))
      : null;
    add(nextDirectional);
    if (selected.length < 1) add(projected(isSupport ? 'support' : 'resistance', projectionDistance, isSupport
      ? 'Volatility-projected support'
      : 'Volatility-projected resistance'));
    if (selected.length < 2) {
      const base = selected[0]?.price ?? price;
      add(projected(isSupport ? 'support' : 'resistance', Math.max(projectionDistance, Math.abs(base - price) + projectionDistance), isSupport
        ? 'Next volatility-projected support'
        : 'Next volatility-projected resistance'));
    }
    return selected.slice(0, 3);
  }

  const support = pickSide('support');
  const resistance = pickSide('resistance');
  const nextSupport = support[1] || null;
  const nextResistance = resistance[1] || null;
  const bias = {
    price: +pivots.pp.toFixed(2),
    label: 'Key bias zone · prior-session daily pivot',
    anchorDate: pivots.anchorDate,
    ...levelZone(pivots.pp, buffer),
  };
  const levels = {
    bias,
    support,
    resistance,
    nextSupport,
    nextResistance,
    breakdown: support.length ? +(support.at(-1).zoneLow - buffer * 4).toFixed(2) : null,
    currentPrice: +price.toFixed(2),
    atr: atr == null ? null : +atr.toFixed(2),
    buffer: +buffer.toFixed(2),
    lookback,
    anchorDate: pivots.anchorDate,
  };
  return {
    completedBars: completed,
    anchorBar,
    atr,
    dailyPivots: pivots,
    levels,
    displayLevels: {
      bias,
      resistance: resistance.slice(0, 2),
      support: support.slice(0, 2),
      nextSupport,
      nextResistance,
      currentPrice: +price.toFixed(2),
      atr: levels.atr,
      buffer: levels.buffer,
      lookback,
      anchorDate: pivots.anchorDate,
      volatilitySource: finite(atr) ? 'ATR(14)' : 'prior-session range',
    },
  };
}

module.exports = {
  atrWilder,
  buildSearchLevels,
  completedDailyBars,
  confirmedSwings,
  dailyPivots,
  marketMinute,
  normalizeDailyBars,
};