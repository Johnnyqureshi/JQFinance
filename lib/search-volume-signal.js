'use strict';

/**
 * Read-only search-page volume/price signal analysis.
 *
 * This module intentionally has no broker, scheduler, or strategy dependencies.
 * It produces bounded evidence for the search page only; automated bots keep
 * using their existing contracts.
 */

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(value)));
const finite = value => value !== null
  && value !== undefined
  && !(typeof value === 'string' && value.trim() === '')
  && Number.isFinite(Number(value));
const number = value => finite(value) ? Number(value) : null;

function timestampMs(value) {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectCrypto24hReference(bars, targetMs) {
  const target = Number(targetMs);
  if (!Number.isFinite(target)) return null;
  const wanted = target - 24 * 60 * 60 * 1000;
  return (Array.isArray(bars) ? bars : [])
    .map(bar => ({
      bar,
      ms: typeof bar?.t === 'number' ? bar.t * (bar.t < 1e11 ? 1000 : 1) : Date.parse(bar?.t),
    }))
    .filter(item => Number.isFinite(item.ms) && item.ms <= target
      && Math.abs(item.ms - wanted) <= 15 * 60 * 1000
      && Number.isFinite(Number(item.bar?.c)) && Number(item.bar.c) > 0)
    .sort((a, b) => Math.abs(a.ms - wanted) - Math.abs(b.ms - wanted))[0]?.bar || null;
}

function canonicalCrypto5mSeries(primaryBars, fallbackBars, generationNow = Date.now()) {
  const source = Array.isArray(primaryBars) && primaryBars.length ? primaryBars : fallbackBars;
  return (Array.isArray(source) ? source : [])
    .map(bar => ({ ...bar, timestampMs: timestampMs(bar?.t) }))
    .filter(bar => Number.isFinite(bar.timestampMs)
      && bar.timestampMs + 5 * 60 * 1000 <= generationNow
      && [bar.o, bar.h, bar.l, bar.c, bar.v].every(finite)
      && Number(bar.o) > 0 && Number(bar.c) > 0
      && Number(bar.h) >= Number(bar.l) && Number(bar.v) >= 0)
    .map(bar => ({ ...bar, o: +bar.o, h: +bar.h, l: +bar.l, c: +bar.c, v: +bar.v }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function crypto24hStats(bars) {
  const series = Array.isArray(bars) ? bars : [];
  const latest = series.at(-1);
  if (!latest) return { latest: null, high: null, low: null, volume: null, vwap: null, rangePosition: null };
  const window = series.filter(bar => bar.timestampMs >= latest.timestampMs - 24 * 60 * 60 * 1000);
  const volume = window.reduce((sum, bar) => sum + bar.v, 0);
  const vwapVolume = window.reduce((sum, bar) => sum + bar.c * bar.v, 0);
  const high = Math.max(...window.map(bar => bar.h));
  const low = Math.min(...window.map(bar => bar.l));
  return {
    latest,
    high,
    low,
    volume,
    vwap: volume > 0 ? vwapVolume / volume : null,
    rangePosition: high > low ? (latest.c - low) / (high - low) : null,
  };
}

function dateParts(value, timezone) {
  const ms = timestampMs(value);
  if (ms == null) return null;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minute: Number(parts.hour) * 60 + Number(parts.minute),
    };
  } catch {
    const date = new Date(ms);
    return {
      date: date.toISOString().slice(0, 10),
      minute: date.getUTCHours() * 60 + date.getUTCMinutes(),
    };
  }
}

function validRegularBar(bar, timezone) {
  const parts = dateParts(bar?.t, timezone);
  return !!bar
    && (bar.session === 'reg' || (parts && parts.minute >= 570 && parts.minute < 960))
    && parts != null
    && [bar.o, bar.h, bar.l, bar.c, bar.v].every(finite)
    && Number(bar.v) >= 0
    && Number(bar.h) >= Number(bar.l)
    && Number(bar.o) > 0
    && Number(bar.c) > 0;
}

function validContinuousBar(bar, timezone) {
  const parts = dateParts(bar?.t, timezone);
  return !!bar && parts != null
    && [bar.o, bar.h, bar.l, bar.c, bar.v].every(finite)
    && Number(bar.v) >= 0
    && Number(bar.h) >= Number(bar.l)
    && Number(bar.o) > 0
    && Number(bar.c) > 0;
}

function normalizedBars(bars, timezone, nowMs = Date.now(), sessionMode = 'regular') {
  return (Array.isArray(bars) ? bars : [])
    .filter(bar => sessionMode === 'continuous'
      ? validContinuousBar(bar, timezone)
      : validRegularBar(bar, timezone))
    .map(bar => {
      const parts = dateParts(bar.t, timezone);
      return {
        ...bar,
        o: Number(bar.o),
        h: Number(bar.h),
        l: Number(bar.l),
        c: Number(bar.c),
        v: Number(bar.v),
        timestampMs: timestampMs(bar.t),
        date: parts.date,
        minute: parts.minute,
      };
    })
    .filter(bar => bar.timestampMs <= nowMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function groupByDate(bars) {
  const grouped = new Map();
  for (const bar of bars) {
    if (!grouped.has(bar.date)) grouped.set(bar.date, []);
    grouped.get(bar.date).push(bar);
  }
  return grouped;
}

function marketDate(value = Date.now(), timezone = 'America/New_York') {
  const parts = dateParts(value, timezone);
  return parts?.date || null;
}

function selectCompletedDailyBar(dailyBars, {
  nowMs = Date.now(),
  marketState = 'CLOSED',
  timezone = 'America/New_York',
} = {}) {
  const bars = (Array.isArray(dailyBars) ? dailyBars : [])
    .filter(bar => [bar?.o, bar?.h, bar?.l, bar?.c].every(finite))
    .sort((a, b) => String(a.t || a.date).localeCompare(String(b.t || b.date)));
  const latest = bars.at(-1);
  if (!latest) return null;
  const today = marketDate(nowMs, timezone);
  const latestDate = String(latest.t || latest.date || '').slice(0, 10);
  const state = String(marketState || '').toUpperCase();
  const latestIsForming = ['PRE', 'PREPRE', 'REGULAR'].includes(state) && latestDate === today;
  return latestIsForming ? bars.at(-2) || null : latest;
}

/**
 * Compare the current cumulative regular-session volume with prior sessions at
 * the same minute. This is deliberately not a full-day volume comparison.
 */
function timeOfDayRelativeVolume({
  currentBars = [],
  historicalBars = [],
  nowMs = Date.now(),
  timezone = 'America/New_York',
  minimumSessions = 3,
  sessionMode = 'regular',
} = {}) {
  const continuous = sessionMode === 'continuous';
  const current = normalizedBars(currentBars, timezone, nowMs, sessionMode)
    .filter(bar => bar.timestampMs + 5 * 60_000 <= nowMs);
  const history = normalizedBars(historicalBars, timezone, nowMs, sessionMode);
  const latest = current.at(-1);
  if (!latest) {
    return {
      available: false,
      value: null,
      reason: continuous ? 'UTC-day RVOL: current volume is unavailable' : 'Current regular-session volume is unavailable',
      sampleSize: 0,
    };
  }

  const currentSession = current.filter(bar => bar.date === latest.date);
  const currentMinute = latest.minute;
  const currentCumulativeVolume = currentSession
    .filter(bar => bar.minute <= currentMinute)
    .reduce((sum, bar) => sum + bar.v, 0);

  const historicalSessions = groupByDate(history);
  const expectedSamples = [];
  for (const [date, bars] of historicalSessions) {
    if (date === latest.date) continue;
    const latestMinute = bars.at(-1)?.minute;
    if (latestMinute == null || latestMinute < currentMinute) continue;
    const cumulative = bars
      .filter(bar => bar.minute <= currentMinute)
      .reduce((sum, bar) => sum + bar.v, 0);
    if (cumulative > 0) expectedSamples.push(cumulative);
  }

  const expectedVolume = average(expectedSamples);
  if (expectedVolume == null || expectedSamples.length < minimumSessions) {
    return {
      available: false,
      value: null,
      reason: continuous
        ? `UTC-day RVOL requires at least ${minimumSessions} same-minute historical days`
        : `At least ${minimumSessions} same-time historical volume sessions are required`,
      sampleSize: expectedSamples.length,
      currentDate: latest.date,
      currentMinute,
      currentCumulativeVolume,
      expectedVolume: null,
    };
  }

  return {
    available: true,
    value: currentCumulativeVolume / expectedVolume,
    currentDate: latest.date,
    currentMinute,
    sessionElapsedMinutes: Math.max(0, currentMinute - 570),
    currentCumulativeVolume,
    expectedVolume,
    sampleSize: expectedSamples.length,
    reason: continuous ? 'UTC-day RVOL' : undefined,
  };
}

function rateForWindow(bars, intervalMinutes) {
  if (bars.length < 1 || !bars.every(bar => Number.isFinite(bar.v))) return null;
  const volume = bars.reduce((sum, bar) => sum + bar.v, 0);
  return volume / (bars.length * intervalMinutes);
}

function volumeAcceleration({
  barsByInterval = {},
  currentDate = null,
  nowMs = Date.now(),
  timezone = 'America/New_York',
  freshness = null,
  sessionMode = 'regular',
} = {}) {
  // Continuous crypto analysis is intentionally anchored to the canonical
  // completed 5-minute series. Do not mix separately fetched 1m/15m snapshots
  // into the same verdict generation.
  const intervalMinutes = sessionMode === 'continuous'
    ? { fiveMinute: 5 }
    : { oneMinute: 1, fiveMinute: 5, fifteenMinute: 15 };
  const byTimeframe = {};
  const ratios = [];

  for (const [key, minutes] of Object.entries(intervalMinutes)) {
    const sourceFresh = freshness == null || freshness[key]?.fresh === true;
    const bars = normalizedBars(barsByInterval[key], timezone, nowMs, sessionMode)
      .filter(bar => bar.timestampMs + minutes * 60_000 <= nowMs)
      .filter(bar => sessionMode === 'continuous' || !currentDate || bar.date === currentDate);
    const sufficientBars = bars.length >= 6;
    const prior = sufficientBars ? bars.slice(-6, -3) : [];
    const recent = sufficientBars ? bars.slice(-3) : [];
    const previousRate = rateForWindow(prior, minutes);
    const currentRate = rateForWindow(recent, minutes);
    const ratio = sourceFresh && previousRate > 0 && currentRate != null ? currentRate / previousRate : null;
    byTimeframe[key] = {
      available: ratio != null,
      ratio,
      accelerationPct: ratio == null ? null : (ratio - 1) * 100,
      currentRate,
      previousRate,
      sampleBars: bars.length,
      state: !sourceFresh ? 'STALE' : !sufficientBars ? 'INSUFFICIENT BARS' : ratio == null ? 'UNAVAILABLE' : ratio >= 1.1 ? 'ACCELERATING' : ratio <= 0.9 ? 'DECELERATING' : 'STABLE',
    };
    if (ratio != null) ratios.push(ratio);
  }

  const allTimeframesAvailable = ratios.length === Object.keys(intervalMinutes).length;
  const ratio = allTimeframesAvailable ? average(ratios) : null;
  return {
    available: allTimeframesAvailable && ratio != null,
    ratio,
    accelerationPct: ratio == null ? null : (ratio - 1) * 100,
    byTimeframe,
    missingTimeframes: Object.entries(byTimeframe)
      .filter(([, value]) => !value.available)
      .map(([key]) => key),
  };
}

function levelPrice(level) {
  return finite(level) ? Number(level) : finite(level?.price) ? Number(level.price) : null;
}

function firstLevel(levels) {
  const list = Array.isArray(levels) ? levels : [];
  return list.map(level => ({ ...level, price: levelPrice(level) })).find(level => level.price != null) || null;
}

function structureForBars(bars) {
  const close = bars.at(-1)?.c ?? null;
  const comparison = bars.at(-7)?.c ?? bars.at(0)?.c ?? null;
  const swingHighs = [];
  const swingLows = [];
  for (let index = 2; index < bars.length - 2; index += 1) {
    const window = bars.slice(index - 2, index + 3);
    const high = bars[index].h;
    const low = bars[index].l;
    if (high === Math.max(...window.map(bar => bar.h))
      && window.filter(bar => bar.h === high).length === 1) {
      swingHighs.push({ price: high, timestampMs: bars[index].timestampMs });
    }
    if (low === Math.min(...window.map(bar => bar.l))
      && window.filter(bar => bar.l === low).length === 1) {
      swingLows.push({ price: low, timestampMs: bars[index].timestampMs });
    }
  }
  const previousSwingHigh = swingHighs.at(-2)?.price ?? null;
  const latestSwingHigh = swingHighs.at(-1)?.price ?? null;
  const previousSwingLow = swingLows.at(-2)?.price ?? null;
  const latestSwingLow = swingLows.at(-1)?.price ?? null;
  const highStructure = previousSwingHigh == null || latestSwingHigh == null
    ? 'INSUFFICIENT'
    : latestSwingHigh > previousSwingHigh ? 'HH'
      : latestSwingHigh < previousSwingHigh ? 'LH' : 'EQUAL';
  const lowStructure = previousSwingLow == null || latestSwingLow == null
    ? 'INSUFFICIENT'
    : latestSwingLow > previousSwingLow ? 'HL'
      : latestSwingLow < previousSwingLow ? 'LL' : 'EQUAL';
  const structuralBreakLevel = highStructure === 'LH' ? latestSwingHigh : null;
  const breakoutConfirmed = structuralBreakLevel != null
    && bars.slice(-2).length === 2
    && bars.slice(-2).every(bar => bar.c > structuralBreakLevel);
  const structuralBias = highStructure === 'HH' && lowStructure === 'HL'
    ? 'BULLISH'
    : breakoutConfirmed && lowStructure !== 'LL'
      ? 'BULLISH'
      : highStructure === 'LH' && lowStructure === 'LL'
        ? 'BEARISH'
        : highStructure === 'INSUFFICIENT' || lowStructure === 'INSUFFICIENT'
          ? 'INSUFFICIENT'
          : 'MIXED';
  const higherLows = lowStructure === 'HL';
  const lowerHighs = highStructure === 'LH';
  const priceRising = close != null && comparison != null && close > comparison;
  const priceFalling = close != null && comparison != null && close < comparison;
  const greenVolume = bars.slice(-6).filter(bar => bar.c >= bar.o).reduce((sum, bar) => sum + bar.v, 0);
  const redVolume = bars.slice(-6).filter(bar => bar.c < bar.o).reduce((sum, bar) => sum + bar.v, 0);
  const last = bars.at(-1) || null;
  const priorBars = bars.slice(0, -1);
  const priorHigh = priorBars.length ? Math.max(...priorBars.slice(-20).map(bar => bar.h)) : null;
  const priorLow = priorBars.length ? Math.min(...priorBars.slice(-20).map(bar => bar.l)) : null;
  const lastVolumeBaseline = average(priorBars.slice(-10).map(bar => bar.v));
  const lastVolumeRatio = last && lastVolumeBaseline > 0 ? last.v / lastVolumeBaseline : null;
  return {
    higherLows,
    lowerHighs,
    previousSwingHigh,
    latestSwingHigh,
    previousSwingLow,
    latestSwingLow,
    highStructure,
    lowStructure,
    structuralBias,
    structuralBreakLevel,
    breakoutConfirmed,
    priceRising,
    priceFalling,
    greenVolume,
    redVolume,
    volumeDirection: greenVolume > redVolume ? 'BUYING' : redVolume > greenVolume ? 'SELLING' : 'BALANCED',
    priorHigh,
    priorLow,
    lastVolumeRatio,
    lastClose: close,
  };
}

function weightedConfidence({
  volumeFlow,
  structureMomentum,
  supportResistance,
  trend,
  rsi,
  other,
}) {
  const weights = {
    volumeFlow: 0.25,
    structureMomentum: 0.25,
    supportResistance: 0.20,
    trend: 0.15,
    rsi: 0.10,
    other: 0.05,
  };
  const parts = { volumeFlow, structureMomentum, supportResistance, trend, rsi, other };
  const overall = clamp(Object.entries(weights).reduce((sum, [key, weight]) => sum + (parts[key] ?? 0) * weight, 0));
  return { overall, weights, parts };
}

function entryWeightedConfidence(parts = {}) {
  const weights = {
    trend: 0.25,
    momentum: 0.15,
    volume: 0.15,
    entryQuality: 0.20,
    supportResistance: 0.10,
    extensionChase: 0.10,
    marketMacro: 0.05,
  };
  const normalized = Object.fromEntries(
    Object.keys(weights).map(key => [key, finite(parts[key]) ? clamp(Number(parts[key])) : 0]),
  );
  return {
    overall: clamp(Object.entries(weights)
      .reduce((sum, [key, weight]) => sum + normalized[key] * weight, 0)),
    weights,
    parts: normalized,
  };
}

const BULLISH_NEWS_TERMS = [
  'beat', 'beats', 'upgrade', 'upgraded', 'raised guidance', 'raises guidance',
  'strong outlook', 'approval', 'approved', 'fda', 'contract', 'partnership',
  'acquisition', 'buyback', 'launch', 'surge', 'record revenue', 'profit growth',
  'price target raised', 'outperform',
];
const BEARISH_NEWS_TERMS = [
  'miss', 'misses', 'downgrade', 'downgraded', 'cut guidance', 'cuts guidance',
  'weak outlook', 'offering', 'dilution', 'lawsuit', 'investigation', 'bankruptcy',
  'recall', 'layoff', 'fraud', 'warning', 'price target lowered', 'underperform',
  'guidance withdrawn', 'cyberattack',
];

function containsNewsTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
}

function newsCatalystScore(news, nowMs = Date.now()) {
  const items = Array.isArray(news) ? news : [];
  let bullishScore = 0;
  let bearishScore = 0;
  const catalysts = [];
  for (const item of items.slice(0, 12)) {
    const headline = String(item?.headline || item?.title || '').trim();
    if (!headline) continue;
    const published = item?.publishedAt || item?.providerPublishTime || item?.date;
    const publishedMs = typeof published === 'number'
      ? (published < 10_000_000_000 ? published * 1000 : published)
      : timestampMs(published);
    if (publishedMs == null || publishedMs > nowMs + 5 * 60_000) continue;
    const ageHours = Math.max(0, (nowMs - publishedMs) / 3_600_000);
    if (ageHours > 7 * 24) continue;
    const recencyWeight = ageHours <= 24 ? 1 : ageHours <= 72 ? 0.6 : 0.25;
    const text = headline.toLowerCase();
    const bullishTerms = BULLISH_NEWS_TERMS.filter(term => containsNewsTerm(text, term));
    const bearishTerms = BEARISH_NEWS_TERMS.filter(term => containsNewsTerm(text, term));
    const bullish = bullishTerms.length * 12 * recencyWeight;
    const bearish = bearishTerms.length * 12 * recencyWeight;
    if (!bullish && !bearish) continue;
    bullishScore += bullish;
    bearishScore += bearish;
    catalysts.push({
      headline,
      ageHours: +ageHours.toFixed(1),
      direction: bullish > bearish ? 'BULLISH' : bearish > bullish ? 'BEARISH' : 'MIXED',
      weight: +Math.max(bullish, bearish).toFixed(1),
    });
  }
  return {
    available: items.length > 0,
    bullishScore: clamp(bullishScore, 0, 100),
    bearishScore: clamp(bearishScore, 0, 100),
    netScore: clamp(bullishScore - bearishScore, -100, 100),
    catalysts,
    freshCatalystCount: catalysts.filter(item => item.ageHours <= 24).length,
  };
}

function buildSearchVolumeSignal({
  price,
  intradayBars = [],
  volumeHistory5m = [],
  barsByInterval = {},
  levels = {},
  indicators = {},
  market = {},
  dayChangePct = null,
  relativeDailyVolume = null,
  dayRangePosition = null,
  news = [],
  nowMs = Date.now(),
  timezone = 'America/New_York',
  minimumVolumeSessions = 3,
  sessionMode = 'regular',
  freshness = null,
  patternAnalysis = null,
  fibonacci = null,
  assetClass = 'stock',
  spotVolumeConfirmed = null,
  dailyBars = [],
  macroPressure = [],
} = {}) {
  const currentPrice = number(price);
  if (currentPrice == null || currentPrice <= 0) {
    return {
      available: false,
      signal: { label: 'WAIT', stage: 'WAITING', direction: 'NEUTRAL', setup: 'PRICE UNAVAILABLE' },
      confidence: 0,
      reason: 'Current price is unavailable',
    };
  }

  const currentBars = normalizedBars(intradayBars, timezone, nowMs, sessionMode)
    .filter(bar => bar.timestampMs + 5 * 60_000 <= nowMs);
  const currentDate = currentBars.at(-1)?.date || null;
  const regularCurrent = sessionMode === 'continuous'
    ? currentBars.filter(bar => currentBars.at(-1)
      && bar.timestampMs >= currentBars.at(-1).timestampMs - 24 * 60 * 60 * 1000)
    : currentBars.filter(bar => bar.date === currentDate);
  const relativeVolume = timeOfDayRelativeVolume({
    currentBars: intradayBars,
    historicalBars: volumeHistory5m,
    nowMs,
    timezone,
    minimumSessions: minimumVolumeSessions,
    sessionMode,
  });
  const acceleration = volumeAcceleration({
    barsByInterval,
    currentDate,
    nowMs,
    timezone,
    freshness,
    sessionMode,
  });
  const newsImpact = newsCatalystScore(news, nowMs);
  const structure = structureForBars(regularCurrent);

  const suppliedResistance = firstLevel(levels.resistance);
  const suppliedSupport = firstLevel(levels.support);
  const brokenResistanceReference = suppliedResistance?.price != null && suppliedResistance.price < currentPrice
    ? suppliedResistance.price
    : structure.priorHigh;
  const brokenSupportReference = suppliedSupport?.price != null && suppliedSupport.price > currentPrice
    ? suppliedSupport.price
    : structure.priorLow;
  const resistanceFollowThrough = brokenResistanceReference != null
    && currentPrice > brokenResistanceReference
    && regularCurrent.slice(-2).length === 2
    && regularCurrent.slice(-2).every(bar => bar.c > brokenResistanceReference);
  const supportFollowThrough = brokenSupportReference != null
    && currentPrice < brokenSupportReference
    && regularCurrent.slice(-2).length === 2
    && regularCurrent.slice(-2).every(bar => bar.c < brokenSupportReference);
  const referenceResistance = resistanceFollowThrough
    ? brokenResistanceReference
    : suppliedResistance?.price ?? structure.priorHigh;
  const referenceSupport = supportFollowThrough
    ? brokenSupportReference
    : suppliedSupport?.price ?? structure.priorLow;
  const distanceToResistancePct = referenceResistance != null
    ? ((referenceResistance - currentPrice) / currentPrice) * 100
    : null;
  const distanceToSupportPct = referenceSupport != null
    ? ((currentPrice - referenceSupport) / currentPrice) * 100
    : null;
  const nearResistance = distanceToResistancePct != null
    && distanceToResistancePct >= 0
    && distanceToResistancePct <= 1.5;
  const nearSupport = distanceToSupportPct != null
    && distanceToSupportPct >= 0
    && distanceToSupportPct <= 1;
  const resistanceBroken = resistanceFollowThrough;
  const supportBroken = supportFollowThrough;
  const currentVolumeFresh = freshness == null || freshness.fiveMinute?.fresh === true;
  const evidenceComplete = relativeVolume.available && currentVolumeFresh && acceleration.available;
  const highVolume = relativeVolume.available && relativeVolume.value >= 1.5;
  const strongVolume = relativeVolume.available && relativeVolume.value >= 2;
  const extremeVolume = relativeVolume.available && relativeVolume.value >= 3;
  const dailyVolumeRatio = number(relativeDailyVolume);
  const dailyHighVolume = dailyVolumeRatio != null && dailyVolumeRatio >= 1.5;
  const rangePosition = number(dayRangePosition);
  const accelerating = acceleration.available && acceleration.ratio > 1.1;
  const stronglyAccelerating = acceleration.available && acceleration.ratio > 1.25;
  const fadingVolume = acceleration.available && acceleration.ratio < 0.9;
  const bullishVolumeDirection = structure.priceRising && structure.volumeDirection === 'BUYING';
  const bearishVolumeDirection = structure.priceFalling && structure.volumeDirection === 'SELLING';
  const breakoutVolume = structure.lastVolumeRatio != null && structure.lastVolumeRatio >= 1.5;
  const cryptoFlowUnverified = assetClass === 'crypto' && spotVolumeConfirmed !== true;
  const levelBreakoutConfirmed = evidenceComplete && resistanceBroken && (breakoutVolume || highVolume)
    && accelerating && !fadingVolume && structure.priceRising && !cryptoFlowUnverified;
  const breakoutWatch = evidenceComplete && !resistanceBroken && nearResistance && highVolume
    && accelerating && structure.structuralBias === 'BULLISH' && structure.priceRising;
  const rejectionWithSelling = evidenceComplete && nearResistance && bearishVolumeDirection && highVolume && accelerating;
  const confirmedSupportBreakdown = evidenceComplete && supportBroken
    && bearishVolumeDirection && highVolume && accelerating;
  const significantResistance = suppliedResistance?.price ?? structure.priorHigh;
  const lastCompleted = regularCurrent.at(-1);
  const priorCompleted = regularCurrent.at(-2);
  const failedBreakout = significantResistance != null
    && lastCompleted?.c < significantResistance
    && (priorCompleted?.c > significantResistance || priorCompleted?.h > significantResistance)
    && (fadingVolume || !highVolume || lastCompleted.c < significantResistance);
  const rangeUpper = rangePosition != null && rangePosition >= 0.75;
  const resistanceCaution = distanceToResistancePct != null
    && distanceToResistancePct >= 2 && distanceToResistancePct <= 5;
  const resistanceZone = distanceToResistancePct != null
    && distanceToResistancePct >= 0 && distanceToResistancePct < 2;
  const immediateResistance = distanceToResistancePct != null
    && distanceToResistancePct >= 0 && distanceToResistancePct < 0.5;
  const upsideToResistance = referenceResistance != null && referenceResistance > currentPrice
    ? referenceResistance - currentPrice : null;
  const downsideToSupport = referenceSupport != null && referenceSupport < currentPrice
    ? currentPrice - referenceSupport : null;
  const nextResistance = (Array.isArray(levels.resistance) ? levels.resistance : [])
    .map(levelPrice)
    .filter(level => level != null && level > currentPrice)
    .sort((a, b) => a - b)[0] ?? null;
  const entryResistance = resistanceFollowThrough ? nextResistance : referenceResistance;
  const entryDistanceToResistancePct = entryResistance != null
    ? ((entryResistance - currentPrice) / currentPrice) * 100
    : null;
  const entryUpside = entryResistance != null && entryResistance > currentPrice
    ? entryResistance - currentPrice : upsideToResistance;
  const entryRiskReward = entryUpside != null && downsideToSupport > 0
    ? entryUpside / downsideToSupport : null;
  const poorLongRiskReward = entryRiskReward == null || entryRiskReward < 1;
  const unconfirmedBreakoutAttempt = significantResistance != null
    && currentPrice > significantResistance && !levelBreakoutConfirmed;
  const completedDailyCloses = (Array.isArray(dailyBars) ? dailyBars : [])
    .map(bar => number(bar?.c)).filter(value => value != null && value > 0);
  const periodGain = sessions => completedDailyCloses.length >= sessions
    ? ((currentPrice - completedDailyCloses.at(-sessions)) / completedDailyCloses.at(-sessions)) * 100
    : null;
  const gain3SessionPct = periodGain(3);
  const gain5SessionPct = periodGain(5);
  const sma20 = number(indicators.sma20);
  const sma50 = number(indicators.sma50);
  const sma200 = number(indicators.sma200);
  const atr = number(indicators.atr);
  const averageDistance = average => average != null
    ? ((currentPrice - average) / average) * 100 : null;
  const distanceFromSma20Pct = averageDistance(sma20);
  const distanceFromSma50Pct = averageDistance(sma50);
  const distanceFromSma200Pct = averageDistance(sma200);
  const atrExtension = atr > 0 && sma20 != null ? (currentPrice - sma20) / atr : null;
  const rsi14 = number(indicators.rsi14);
  const dayGain = number(dayChangePct);
  const entryCoreInputsAvailable = [
    dayGain, gain3SessionPct, gain5SessionPct, rsi14, sma20, atr,
    entryResistance, referenceSupport, rangePosition,
  ].every(value => value != null);
  const extensionInputsAvailable = entryCoreInputsAvailable
    && sma50 != null && sma200 != null;
  let chaseRisk = 0;
  const chaseReasons = [];
  const addChase = (points, reason) => { chaseRisk += points; chaseReasons.push(reason); };
  if (dayGain >= 15) addChase(35, `Price is up ${dayGain.toFixed(1)}% today`);
  else if (dayGain >= 12) addChase(25, `Price is up ${dayGain.toFixed(1)}% today`);
  else if (dayGain >= 8) addChase(15, `Price is up ${dayGain.toFixed(1)}% today`);
  if (gain3SessionPct >= 12) addChase(12, `Price is up ${gain3SessionPct.toFixed(1)}% over three sessions`);
  if (gain5SessionPct >= 18) addChase(12, `Price is up ${gain5SessionPct.toFixed(1)}% over five sessions`);
  if (rsi14 > 80) addChase(28, `RSI ${rsi14.toFixed(0)} indicates severe new-entry extension`);
  else if (rsi14 >= 75) addChase(18, `RSI ${rsi14.toFixed(0)} indicates major new-entry extension`);
  else if (rsi14 >= 70) addChase(8, `RSI ${rsi14.toFixed(0)} shows strong but increasingly extended momentum`);
  if (distanceFromSma20Pct >= 10) addChase(22, `Price is ${distanceFromSma20Pct.toFixed(1)}% above the 20 SMA`);
  else if (distanceFromSma20Pct >= 6) addChase(12, `Price is ${distanceFromSma20Pct.toFixed(1)}% above the 20 SMA`);
  if (distanceFromSma50Pct >= 20) addChase(12, `Price is ${distanceFromSma50Pct.toFixed(1)}% above the 50 SMA`);
  if (distanceFromSma200Pct >= 40) addChase(8, `Price is ${distanceFromSma200Pct.toFixed(1)}% above the 200 SMA`);
  if (atrExtension >= 3) addChase(20, `Price is ${atrExtension.toFixed(1)} ATR above the 20 SMA`);
  else if (atrExtension >= 2) addChase(10, `Price is ${atrExtension.toFixed(1)} ATR above the 20 SMA`);
  const exhaustionRisk = dayGain >= 8 && rsi14 >= 75 && (highVolume || dailyHighVolume);
  if (exhaustionRisk) addChase(15, 'Strong momentum and high volume coincide with elevated extension risk');
  chaseRisk = clamp(chaseRisk);

  let locationPenalty = 0;
  if (entryDistanceToResistancePct != null && entryDistanceToResistancePct >= 0) {
    if (entryDistanceToResistancePct < 2) locationPenalty += 30;
    else if (entryDistanceToResistancePct <= 5) locationPenalty += 18;
    else if (entryDistanceToResistancePct <= 10) locationPenalty += 8;
  }
  if (distanceToSupportPct != null && distanceToSupportPct > 8) locationPenalty += 12;
  if (poorLongRiskReward) locationPenalty += 25;
  if (rangeUpper) locationPenalty += 15;
  if (fadingVolume && nearResistance) locationPenalty += 12;
  if (failedBreakout) locationPenalty += 30;
  if (unconfirmedBreakoutAttempt) locationPenalty += 20;
  const exceptionalBreakout = levelBreakoutConfirmed
    && entryCoreInputsAvailable
    && entryRiskReward >= 1.5
    && entryDistanceToResistancePct >= 2
    && !fadingVolume;
  const effectiveChaseRisk = exceptionalBreakout ? Math.max(0, chaseRisk - 20) : chaseRisk;
  const entryQualityScore = entryCoreInputsAvailable
    ? clamp(100 - locationPenalty - effectiveChaseRisk)
    : null;
  const macroStates = (Array.isArray(macroPressure) ? macroPressure : [])
    .map(item => String(item?.state || '').toUpperCase())
    .filter(state => ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(state));
  const macroScore = macroStates.length
    ? clamp(50 + macroStates.reduce((sum, state) => sum + (state === 'BULLISH' ? 12 : state === 'BEARISH' ? -12 : 0), 0))
    : 50;
  const bullishNewsCorroborated = evidenceComplete && newsImpact.netScore > 0
    && structure.priceRising && (bullishVolumeDirection || accelerating);
  const bearishNewsCorroborated = evidenceComplete && newsImpact.netScore < 0
    && structure.priceFalling && (bearishVolumeDirection || accelerating);
  newsImpact.appliedDirection = bullishNewsCorroborated ? 'BULLISH'
    : bearishNewsCorroborated ? 'BEARISH' : null;

  let bullishVolumeScore = 0;
  let bearishVolumeScore = 0;
  if (highVolume && structure.priceRising) bullishVolumeScore += strongVolume ? 22 : 15;
  if (dailyHighVolume && structure.priceRising) bullishVolumeScore += 5;
  if (extremeVolume && structure.priceRising) bullishVolumeScore += 10;
  if (stronglyAccelerating && structure.priceRising) bullishVolumeScore += 18;
  else if (accelerating && structure.priceRising) bullishVolumeScore += 10;
  if (bullishVolumeDirection) bullishVolumeScore += 20;
  if (structure.higherLows) bullishVolumeScore += 15;
  if (levelBreakoutConfirmed && structure.structuralBias === 'BULLISH') bullishVolumeScore += 25;

  if (highVolume && structure.priceFalling) bearishVolumeScore += strongVolume ? 22 : 15;
  if (dailyHighVolume && structure.priceFalling) bearishVolumeScore += 5;
  if (extremeVolume && structure.priceFalling) bearishVolumeScore += 10;
  if (stronglyAccelerating && structure.priceFalling) bearishVolumeScore += 18;
  else if (accelerating && structure.priceFalling) bearishVolumeScore += 10;
  if (bearishVolumeDirection) bearishVolumeScore += 20;
  if (structure.lowerHighs) bearishVolumeScore += 15;
  if (confirmedSupportBreakdown) bearishVolumeScore += 25;
  if (rejectionWithSelling) bearishVolumeScore += 15;
  if (bullishNewsCorroborated) bullishVolumeScore += newsImpact.bullishScore * 0.35;
  if (bearishNewsCorroborated) bearishVolumeScore += newsImpact.bearishScore * 0.35;
  bullishVolumeScore = clamp(bullishVolumeScore);
  bearishVolumeScore = clamp(bearishVolumeScore);

  let pumpPressure = 0;
  if (highVolume) pumpPressure += strongVolume ? 24 : 16;
  if (extremeVolume) pumpPressure += 12;
  if (stronglyAccelerating) pumpPressure += 20;
  else if (accelerating) pumpPressure += 12;
  if (structure.higherLows) pumpPressure += 15;
  if (structure.priceRising) pumpPressure += 10;
  if (nearResistance || resistanceBroken) pumpPressure += 10;
  if (bullishVolumeDirection) pumpPressure += 10;
  pumpPressure = clamp(pumpPressure);

  const volumeFlow = clamp(Math.max(bullishVolumeScore, bearishVolumeScore));
  const structureMomentum = clamp(50
    + (structure.priceRising ? 18 : 0)
    + (structure.higherLows ? 17 : 0)
    - (structure.priceFalling ? 18 : 0)
    - (structure.lowerHighs ? 17 : 0)
    + (levelBreakoutConfirmed && structure.structuralBias === 'BULLISH' ? 15 : 0)
    - (supportBroken ? 15 : 0));
  const supportResistance = clamp(50
    + (breakoutWatch ? 4 : 0)
    + (levelBreakoutConfirmed && structure.structuralBias === 'BULLISH' ? 35 : 0)
    + (nearSupport && structure.priceRising ? 10 : 0)
    - (resistanceZone && !levelBreakoutConfirmed ? 30 : resistanceCaution ? 12 : 0)
    - (rangeUpper && !levelBreakoutConfirmed ? 12 : 0)
    - (poorLongRiskReward && !levelBreakoutConfirmed ? 18 : 0)
    - (fadingVolume && nearResistance ? 15 : 0)
    - (failedBreakout ? 35 : 0)
    - (rejectionWithSelling ? 30 : 0)
    - (supportBroken ? 35 : 0));
  const trendInputsAvailable = sma20 != null && sma50 != null && sma200 != null;
  const trend = !trendInputsAvailable ? null
    : currentPrice > sma20 && sma20 > sma50 && sma50 > sma200 ? 90
      : currentPrice > sma20 && currentPrice > sma50 ? 75
        : currentPrice < sma20 && sma20 < sma50 && sma50 < sma200 ? 10
          : currentPrice < sma20 && currentPrice < sma50 ? 25 : 50;
  const rsi = rsi14 == null ? 50
    : rsi14 >= 80 ? 35
      : rsi14 >= 70 ? 55
        : rsi14 >= 50 ? 75
          : rsi14 >= 35 ? 50
            : 40;
  const vwap = number(indicators.vwap);
  const macd = indicators.macd;
  const other = clamp(50
    + (vwap != null && currentPrice > vwap ? 20 : vwap != null && currentPrice < vwap ? -20 : 0)
    + (macd?.value != null && macd?.signal != null
      ? Number(macd.value) > Number(macd.signal) ? 15 : -15
      : 0));
  const appliedNewsNet = bullishNewsCorroborated || bearishNewsCorroborated ? newsImpact.netScore : 0;
  const newsOther = clamp(50 + appliedNewsNet * 0.35);
  const otherWithNews = clamp(other * 0.65 + newsOther * 0.35);
  const patternNet = number(patternAnalysis?.netScore) ?? 0;
  const patternOther = clamp(50 + patternNet * 2);
  const otherWithPatterns = patternAnalysis?.available
    ? clamp(otherWithNews * 0.75 + patternOther * 0.25)
    : otherWithNews;
  const fibonacciDirection = String(fibonacci?.direction || '').toUpperCase();
  const fibonacciScore = fibonacci?.available
    ? Math.max(0, Math.min(10, number(fibonacci.confluenceScore) ?? 0))
    : 0;
  const fibonacciOther = fibonacciDirection === 'BULLISH'
    ? 50 + fibonacciScore * 3
    : fibonacciDirection === 'BEARISH'
      ? 50 - fibonacciScore * 3
      : 50;
  const otherWithFibonacci = fibonacci?.available
    ? clamp(otherWithPatterns * 0.85 + fibonacciOther * 0.15)
    : otherWithPatterns;
  const rsiMomentum = rsi14 == null ? 50
    : rsi14 >= 70 ? 90
      : rsi14 >= 50 ? 78
        : rsi14 >= 40 ? 50 : 30;
  const momentumScore = clamp(structureMomentum * 0.65 + rsiMomentum * 0.35);
  const longVolumeScore = exhaustionRisk
    ? Math.min(55, bullishVolumeScore)
    : bullishVolumeScore;
  const entryConfidence = entryWeightedConfidence({
    trend,
    momentum: rsi14 == null ? null : momentumScore,
    volume: evidenceComplete ? longVolumeScore : null,
    entryQuality: entryQualityScore,
    supportResistance: referenceSupport != null && entryResistance != null ? supportResistance : null,
    extensionChase: extensionInputsAvailable ? 100 - effectiveChaseRisk : null,
    marketMacro: macroStates.length ? macroScore : null,
  });
  const bearishEntryConfidence = entryWeightedConfidence({
    trend: trend == null ? null : 100 - trend,
    momentum: rsi14 == null ? null : 100 - momentumScore,
    volume: evidenceComplete ? bearishVolumeScore : null,
    entryQuality: entryQualityScore == null ? null : 100 - entryQualityScore,
    supportResistance: referenceSupport != null && entryResistance != null
      ? 100 - supportResistance : null,
    extensionChase: extensionInputsAvailable ? effectiveChaseRisk : null,
    marketMacro: macroStates.length ? 100 - macroScore : null,
  });
  const confidence = weightedConfidence({ volumeFlow, structureMomentum, supportResistance, trend, rsi, other: otherWithFibonacci });
  const bullishConfidence = weightedConfidence({
    volumeFlow: bullishVolumeScore,
    structureMomentum,
    supportResistance,
    trend,
    rsi,
    other: otherWithFibonacci,
  });
  const bearishConfidence = weightedConfidence({
    volumeFlow: bearishVolumeScore,
    structureMomentum: 100 - structureMomentum,
    supportResistance: 100 - supportResistance,
    trend: 100 - trend,
    rsi: 100 - rsi,
    other: 100 - otherWithFibonacci,
  });

  const breakoutProbability = referenceResistance == null
    ? 0
    : clamp(15
      + pumpPressure * 0.35
      + (structure.higherLows ? 15 : 0)
      + (structure.priceRising ? 10 : 0)
      + (resistanceBroken ? 20 : 0)
      - (structure.lowerHighs ? 20 : 0));

  const aboveVwap = vwap != null && currentPrice > vwap;
  const belowVwap = vwap != null && currentPrice < vwap;
  const dayChange = number(dayChangePct);
  const bullishEvidence = bullishVolumeScore
    + (structure.priceRising ? 25 : 0)
    + (structure.higherLows ? 15 : 0)
    + (aboveVwap ? 10 : 0)
    + (dayChange != null && dayChange > 0 ? 8 : 0)
    + (String(market.trend || '').toUpperCase() === 'BULLISH' ? 10 : 0)
    + (patternNet > 0 ? Math.min(24, patternNet) : 0)
    + (fibonacciDirection === 'BULLISH' ? fibonacciScore : 0);
  const bearishEvidence = bearishVolumeScore
    + (structure.priceFalling ? 25 : 0)
    + (structure.lowerHighs ? 15 : 0)
    + (belowVwap ? 10 : 0)
    + (dayChange != null && dayChange < 0 ? 8 : 0)
    + (String(market.trend || '').toUpperCase() === 'BEARISH' ? 10 : 0)
    + (patternNet < 0 ? Math.min(24, Math.abs(patternNet)) : 0)
    + (fibonacciDirection === 'BEARISH' ? fibonacciScore : 0);
  const bullishRangeEvidence = rangePosition != null && rangePosition <= 0.25 ? 6
    : rangeUpper ? -12 : 0;
  const bearishRangeEvidence = rangePosition != null && rangePosition <= 0.35 ? 6 : 0;
  let bullishEvidenceWithRange = bullishEvidence + bullishRangeEvidence;
  const bearishEvidenceWithRange = bearishEvidence + bearishRangeEvidence;
  const bullishStructureValid = structure.structuralBias === 'BULLISH';
  const bearishStructureValid = structure.structuralBias === 'BEARISH';
  const bullishDirectional = evidenceComplete && bullishStructureValid
    && bullishEvidenceWithRange >= bearishEvidenceWithRange;
  const bearishDirectional = evidenceComplete && bearishStructureValid
    && bearishEvidenceWithRange >= bullishEvidenceWithRange;
  const extensionBlocksEntry = !entryCoreInputsAvailable
    || entryQualityScore < 55 || effectiveChaseRisk >= 50;
  const locationBlocksEntry = levelBreakoutConfirmed
    ? !exceptionalBreakout
    : resistanceZone || immediateResistance || failedBreakout
      || unconfirmedBreakoutAttempt || (rangeUpper && nearResistance) || poorLongRiskReward;
  const longEntryBlocked = bullishDirectional && (locationBlocksEntry || extensionBlocksEntry);
  const bullishEntry = bullishDirectional && !longEntryBlocked;
  const directional = bullishEntry || bearishDirectional;
  const direction = bullishEntry ? 'BULLISH' : bearishDirectional ? 'BEARISH' : 'NEUTRAL';
  const label = directional ? (direction === 'BULLISH' ? 'BUY' : 'SELL') : 'WAIT';
  let stage = !directional ? 'WAITING' : (levelBreakoutConfirmed && bullishStructureValid)
    || confirmedSupportBreakdown || rejectionWithSelling ? 'CONFIRMED' : 'PROVISIONAL';
  const reasons = [];
  if (!relativeVolume.available) reasons.push(relativeVolume.reason);
  if (!currentVolumeFresh) reasons.push('Current 5-minute volume is stale');
  if (!acceleration.available) {
    reasons.push(`Completed acceleration windows are unavailable: ${acceleration.missingTimeframes.join(', ')}`);
  }
  if (longEntryBlocked) {
    if (failedBreakout) reasons.push('Price broke resistance but failed to hold above it; breakout confirmation weakened');
    else if (unconfirmedBreakoutAttempt && cryptoFlowUnverified) {
      reasons.push('Bullish price action is above resistance, but organic spot-volume confirmation is unavailable');
    } else if (unconfirmedBreakoutAttempt) {
      reasons.push('Price moved above resistance, but expanding volume and acceptance above the level are not confirmed');
    }
    else if (immediateResistance) reasons.push('Bullish structure, but price is directly beneath resistance without breakout confirmation');
    else if (resistanceZone) reasons.push('Bullish structure is testing nearby resistance; wait for a close and hold above the level');
    if (rangeUpper && nearResistance) reasons.push('Price is in the upper portion of its range; entry location is unfavorable without confirmation');
    if (poorLongRiskReward) reasons.push(entryRiskReward == null
      ? 'Measured room to the next resistance is unavailable'
      : `Upside to resistance is only ${entryRiskReward.toFixed(2)}× the downside to support`);
    if (fadingVolume) reasons.push('Volume is fading as price approaches resistance');
    if (extensionBlocksEntry) {
      reasons.push(entryQualityScore == null
        ? 'Bullish trend and momentum remain intact, but required entry-quality inputs are unavailable'
        : `Bullish trend and momentum remain intact, but entry quality is ${entryQualityScore}/100 with ${effectiveChaseRisk}/100 chase risk`);
      reasons.push(...chaseReasons);
    }
  } else if (!directional) {
    reasons.push('Directional evidence is incomplete; no trade bias issued');
    if (!evidenceComplete) reasons.push('Complete fresh volume evidence is required for a directional signal');
    if (!bullishStructureValid && !bearishStructureValid) {
      reasons.push(`Confirmed swing structure is ${structure.structuralBias.toLowerCase()}; bullish or bearish structure is required`);
    } else if (bullishStructureValid && !bullishDirectional) {
      reasons.push('Volume evidence does not confirm the bullish structural bias');
    } else if (bearishStructureValid && !bearishDirectional) {
      reasons.push('Volume evidence does not confirm the bearish structural bias');
    }
  }
  if (levelBreakoutConfirmed && bullishStructureValid) {
    reasons.push('Resistance was reclaimed with expanding volume and follow-through');
  } else if (breakoutWatch) {
    reasons.push('Price is pressing resistance with bullish structure and increasing volume');
  } else if (confirmedSupportBreakdown && bearishVolumeScore >= 55) {
    reasons.push('Support broke while price and selling volume expanded');
  } else if (rejectionWithSelling && bearishVolumeScore >= 55) {
    reasons.push('Resistance rejected with expanding selling volume');
  } else if (direction === 'BULLISH') {
    reasons.push('Price structure and volume direction support buyers');
  } else if (structure.highStructure === 'LH' && structure.lowStructure === 'HL') {
    reasons.push('Higher lows are forming, but lower highs remain intact until a breakout holds');
  } else if (structure.structuralBias === 'INSUFFICIENT') {
    reasons.push('Confirmed swing structure is insufficient for a directional signal');
  } else {
    reasons.push('Falling price structure is accompanied by expanding selling volume');
  }

  if (structure.higherLows && !structure.lowerHighs) reasons.push('Higher lows are developing');
  if (structure.lowerHighs) reasons.push('Lower highs are developing');
   if (relativeVolume.available) reasons.push(sessionMode === 'continuous'
     ? `UTC-day RVOL is ${relativeVolume.value.toFixed(2)}×`
     : `Time-of-day RVOL is ${relativeVolume.value.toFixed(2)}×`);
  if (dailyVolumeRatio != null) reasons.push(`Daily volume is ${dailyVolumeRatio.toFixed(2)}× the average`);
  if (rangePosition != null) reasons.push(`Price is ${Math.round(rangePosition * 100)}% through today's range`);
  if (acceleration.available) reasons.push(`Volume acceleration is ${(acceleration.ratio * 100 - 100).toFixed(0)}%`);
  if (newsImpact.catalysts.length) {
    reasons.push(newsImpact.appliedDirection
      ? `${newsImpact.catalysts.length} recent catalyst${newsImpact.catalysts.length === 1 ? '' : 's'} corroborated ${newsImpact.appliedDirection.toLowerCase()} price/volume`
      : 'Recent catalyst was not applied without matching price and volume');
  } else if (newsImpact.available) {
    reasons.push('Recent headlines contained no scored directional catalyst');
  }
  if (patternAnalysis?.available) {
    const alignedPatterns = patternAnalysis.patterns
      .filter(pattern => pattern.type === direction)
      .slice(0, 2);
    if (alignedPatterns.length) {
      reasons.push(`${alignedPatterns.map(pattern => `${pattern.name} (${pattern.timeframe})`).join(' + ')} support the ${direction.toLowerCase()} read`);
    } else {
      reasons.push(`Detected chart patterns do not confirm the ${direction.toLowerCase()} read`);
    }
  }
  if (fibonacci?.available) {
    reasons.push(`Fibonacci ${String(fibonacci.setup || 'price map').toLowerCase()} adds ${fibonacciDirection.toLowerCase()} confluence; volume confirmation is still required`);
  }
  const selectedConfidence = direction === 'BULLISH'
    ? bullishConfidence
    : direction === 'BEARISH'
      ? bearishConfidence
      : confidence;
  const selectedEntryConfidence = direction === 'BEARISH'
    ? bearishEntryConfidence : entryConfidence;
  let displayedConfidence = longEntryBlocked
    ? entryConfidence.overall
    : !directional ? 0 : evidenceComplete
      ? selectedEntryConfidence.overall
      : Math.min(35, selectedConfidence.overall);
  if (direction === 'BULLISH' && resistanceCaution && !levelBreakoutConfirmed) displayedConfidence = Math.min(displayedConfidence, 62);
  if (direction === 'BULLISH' && rangeUpper && !levelBreakoutConfirmed) displayedConfidence = Math.min(displayedConfidence, 58);
  if (structure.structuralBias === 'MIXED') displayedConfidence = Math.min(displayedConfidence, 45);
  if (structure.structuralBias === 'BEARISH' && bullishEvidence > bearishEvidence) {
    displayedConfidence = Math.min(displayedConfidence, 35);
  }
  const extendedSignal = effectiveChaseRisk >= 50 || exhaustionRisk;
  const signalState = failedBreakout ? 'BULL TRAP'
    : longEntryBlocked && extendedSignal ? 'BULLISH — EXTENDED'
      : longEntryBlocked || breakoutWatch || unconfirmedBreakoutAttempt ? 'BREAKOUT WATCH'
        : direction === 'BULLISH' && displayedConfidence >= 80 ? 'STRONG BUY'
          : direction === 'BULLISH' ? 'BUY'
            : direction === 'BEARISH' && displayedConfidence >= 80 ? 'STRONG SELL'
              : direction === 'BEARISH' ? 'BEARISH' : 'NEUTRAL';

  return {
    available: true,
    sessionMode,
    signal: {
      label,
      state: signalState,
      stage,
      direction,
      setup: failedBreakout ? 'BULL TRAP'
        : levelBreakoutConfirmed && bullishStructureValid ? 'BREAKOUT CONFIRMED'
          : unconfirmedBreakoutAttempt && cryptoFlowUnverified ? 'BULLISH PRICE ACTION — SQUEEZE-DRIVEN BREAKOUT NOT CONFIRMED'
            : unconfirmedBreakoutAttempt ? 'BREAKOUT WATCH'
          : longEntryBlocked && resistanceZone ? 'BULLISH STRUCTURE — RESISTANCE TEST'
            : longEntryBlocked && poorLongRiskReward ? 'BULLISH STRUCTURE — POOR ENTRY LOCATION'
              : breakoutWatch ? 'BREAKOUT WATCH'
        : confirmedSupportBreakdown ? 'SUPPORT BREAKDOWN'
          : rejectionWithSelling ? 'RESISTANCE REJECTION'
            : 'DIRECTIONAL BIAS',
    },
    confidence: displayedConfidence,
    bullishConfidence: bullishConfidence.overall,
    bearishConfidence: bearishConfidence.overall,
    confidenceBreakdown: {
      ...selectedEntryConfidence,
      overall: displayedConfidence,
      legacyDirectional: selectedConfidence.overall,
    },
    pumpPressure,
    bullishVolumeScore,
    bearishVolumeScore,
    breakoutProbability,
    patternAnalysis: patternAnalysis?.available ? patternAnalysis : {
      available: false,
      direction: 'MIXED',
      netScore: 0,
      patterns: [],
    },
    fibonacci: fibonacci?.available ? fibonacci : {
      available: false,
      reason: fibonacci?.reason || 'Fibonacci swing unavailable',
    },
    newsImpact,
    relativeVolume: {
      available: relativeVolume.available,
      value: relativeVolume.value == null ? null : +relativeVolume.value.toFixed(2),
      currentCumulativeVolume: relativeVolume.currentCumulativeVolume ?? null,
      expectedVolume: relativeVolume.expectedVolume ?? null,
      sampleSize: relativeVolume.sampleSize,
      currentDate: relativeVolume.currentDate ?? null,
      currentMinute: relativeVolume.currentMinute ?? null,
      sessionElapsedMinutes: relativeVolume.sessionElapsedMinutes ?? null,
      reason: relativeVolume.reason ?? null,
    },
    dailyVolumeRatio: dailyVolumeRatio == null ? null : +dailyVolumeRatio.toFixed(2),
    dayRangePosition: rangePosition == null ? null : +rangePosition.toFixed(3),
    entryQuality: {
      trendBias: bullishStructureValid ? 'BULLISH' : bearishStructureValid ? 'BEARISH' : 'NEUTRAL',
      entryAllowed: bullishEntry,
      score: entryQualityScore,
      chaseRisk: effectiveChaseRisk,
      chaseRiskLabel: effectiveChaseRisk >= 65 ? 'HIGH'
        : effectiveChaseRisk >= 35 ? 'MODERATE' : 'LOW',
      exhaustionRisk,
      breakoutState: failedBreakout ? 'BULL TRAP'
        : levelBreakoutConfirmed ? 'BREAKOUT CONFIRMED'
          : nearResistance ? 'BREAKOUT WATCH' : 'NOT TESTING RESISTANCE',
      distanceToResistancePct: entryDistanceToResistancePct == null ? null : +entryDistanceToResistancePct.toFixed(2),
      rangePosition: rangePosition == null ? null : +rangePosition.toFixed(3),
      riskRewardToFirstResistance: entryRiskReward == null ? null : +entryRiskReward.toFixed(2),
      distanceToSupportPct: distanceToSupportPct == null ? null : +distanceToSupportPct.toFixed(2),
      distanceFromSma20Pct: distanceFromSma20Pct == null ? null : +distanceFromSma20Pct.toFixed(2),
      distanceFromSma50Pct: distanceFromSma50Pct == null ? null : +distanceFromSma50Pct.toFixed(2),
      distanceFromSma200Pct: distanceFromSma200Pct == null ? null : +distanceFromSma200Pct.toFixed(2),
      atrExtension: atrExtension == null ? null : +atrExtension.toFixed(2),
      dayGainPct: dayGain,
      gain3SessionPct: gain3SessionPct == null ? null : +gain3SessionPct.toFixed(2),
      gain5SessionPct: gain5SessionPct == null ? null : +gain5SessionPct.toFixed(2),
      rsi: rsi14,
      volumeFading: fadingVolume,
      volumeOrigin: cryptoFlowUnverified ? 'SPOT/FUTURES PARTICIPATION UNVERIFIED' : 'PRIMARY MARKET VOLUME',
      blockedReasons: [
        ...(resistanceZone && !levelBreakoutConfirmed ? ['UNCONFIRMED_RESISTANCE_TEST'] : []),
        ...(rangeUpper && nearResistance && !levelBreakoutConfirmed ? ['UPPER_RANGE_ENTRY'] : []),
        ...(poorLongRiskReward && !levelBreakoutConfirmed ? ['POOR_RISK_REWARD'] : []),
        ...(failedBreakout ? ['BULL_TRAP'] : []),
        ...(unconfirmedBreakoutAttempt ? ['BREAKOUT_NOT_CONFIRMED'] : []),
        ...(cryptoFlowUnverified ? ['ORGANIC_SPOT_VOLUME_UNVERIFIED'] : []),
        ...(extensionBlocksEntry ? ['CHASE_RISK'] : []),
      ],
      reasons: chaseReasons,
    },
    volumeAcceleration: {
      available: acceleration.available,
      ratio: acceleration.ratio == null ? null : +acceleration.ratio.toFixed(3),
      percent: acceleration.accelerationPct == null ? null : +acceleration.accelerationPct.toFixed(1),
      byTimeframe: Object.fromEntries(Object.entries(acceleration.byTimeframe).map(([key, value]) => [key, {
        ...value,
        ratio: value.ratio == null ? null : +value.ratio.toFixed(3),
        accelerationPct: value.accelerationPct == null ? null : +value.accelerationPct.toFixed(1),
      }])),
      missingTimeframes: acceleration.missingTimeframes,
    },
    structure: {
      higherLows: structure.higherLows,
      lowerHighs: structure.lowerHighs,
      previousSwingHigh: structure.previousSwingHigh,
      latestSwingHigh: structure.latestSwingHigh,
      previousSwingLow: structure.previousSwingLow,
      latestSwingLow: structure.latestSwingLow,
      highStructure: structure.highStructure,
      lowStructure: structure.lowStructure,
      structuralBias: structure.structuralBias,
      structuralBreakLevel: structure.structuralBreakLevel,
      breakoutConfirmed: structure.breakoutConfirmed,
      priceRising: structure.priceRising,
      priceFalling: structure.priceFalling,
      volumeDirection: structure.volumeDirection,
      lastVolumeRatio: structure.lastVolumeRatio == null ? null : +structure.lastVolumeRatio.toFixed(2),
    },
    levels: {
      resistance: referenceResistance == null ? null : {
        price: +referenceResistance.toFixed(2),
        distancePct: distanceToResistancePct == null ? null : +distanceToResistancePct.toFixed(2),
        near: nearResistance,
        broken: resistanceBroken,
        followThrough: resistanceBroken,
      },
      support: referenceSupport == null ? null : {
        price: +referenceSupport.toFixed(2),
        distancePct: distanceToSupportPct == null ? null : +distanceToSupportPct.toFixed(2),
        near: nearSupport,
        broken: supportBroken,
      },
    },
    dataQuality: {
      volumeBaselineAvailable: relativeVolume.available && currentVolumeFresh,
      currentVolumeFresh,
      accelerationAvailable: acceleration.available,
      directionalEvidence: {
        bullish: +bullishEvidence.toFixed(1),
        bearish: +bearishEvidence.toFixed(1),
        bullishWithRange: +bullishEvidenceWithRange.toFixed(1),
        bearishWithRange: +bearishEvidenceWithRange.toFixed(1),
      },
      missing: [
         ...(relativeVolume.available ? [] : [sessionMode === 'continuous' ? 'UTC-day RVOL' : 'Time-of-day volume baseline']),
        ...(currentVolumeFresh ? [] : ['Current 5-minute volume is stale']),
        ...(acceleration.available ? [] : ['Short-term volume acceleration']),
        ...(dayGain == null ? ['Current-session change'] : []),
        ...(gain3SessionPct == null ? ['Three-session change'] : []),
        ...(gain5SessionPct == null ? ['Five-session change'] : []),
        ...(rsi14 == null ? ['RSI 14'] : []),
        ...(sma20 == null ? ['20 SMA'] : []),
        ...(sma50 == null ? ['50 SMA'] : []),
        ...(sma200 == null ? ['200 SMA'] : []),
        ...(atr == null ? ['ATR'] : []),
        ...(entryResistance == null ? ['Nearest resistance'] : []),
        ...(referenceSupport == null ? ['Nearest support'] : []),
        ...(rangePosition == null ? ['Day-range position'] : []),
        ...(macroStates.length ? [] : ['Verified market/macro pressure']),
      ],
    },
    reasons: [...new Set(reasons)],
    weights: entryConfidence.weights,
  };
}

module.exports = {
  buildSearchVolumeSignal,
  newsCatalystScore,
  selectCompletedDailyBar,
  structureForBars,
  timeOfDayRelativeVolume,
  volumeAcceleration,
  selectCrypto24hReference,
  canonicalCrypto5mSeries,
  crypto24hStats,
};