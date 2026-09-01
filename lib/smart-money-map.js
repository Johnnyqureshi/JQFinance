'use strict';

/**
 * Search-only Smart Money Map.
 *
 * This is an OHLCV interpretation layer. It cannot observe orders or identify
 * actual institutions, and it has no dependency on broker or bot code.
 */

const TIMEFRAMES = {
  '1H': { label: '1 hour', minutes: 60, intervalMs: 60 * 60 * 1000, minBars: 36, maxAgeMs: 4 * 60 * 60 * 1000 },
  '4H': { label: '4 hour', minutes: 240, intervalMs: 4 * 60 * 60 * 1000, minBars: 28, maxAgeMs: 16 * 60 * 60 * 1000 },
  '1D': { label: '1 day', minutes: 1440, intervalMs: 24 * 60 * 60 * 1000, minBars: 30, maxAgeMs: 3 * 24 * 60 * 60 * 1000 },
  '1W': { label: '1 week', minutes: 10080, intervalMs: 7 * 24 * 60 * 60 * 1000, minBars: 20, maxAgeMs: 16 * 24 * 60 * 60 * 1000 },
  '1M': { label: '1 month', minutes: 43200, intervalMs: 30 * 24 * 60 * 60 * 1000, minBars: 12, maxAgeMs: 65 * 24 * 60 * 60 * 1000 },
};

const TF_ORDER = ['1H', '4H', '1D', '1W', '1M'];
const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
const n = value => finite(value) ? Number(value) : null;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(value)));
const round = (value, digits = 4) => finite(value) ? +Number(value).toFixed(digits) : null;

function timestampMs(value) {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBars(input, { nowMs = Date.now(), timeframe = '1D' } = {}) {
  const config = TIMEFRAMES[timeframe] || TIMEFRAMES['1D'];
  return (Array.isArray(input) ? input : [])
    .map((bar, index) => {
      const timestamp = timestampMs(bar?.t ?? bar?.date);
      return {
        index,
        t: bar?.t ?? bar?.date ?? null,
        timestamp,
        completedAt: timestampMs(bar?.completeAt) ?? (timestamp == null ? null : timestamp + config.intervalMs),
        o: n(bar?.o), h: n(bar?.h), l: n(bar?.l), c: n(bar?.c), v: n(bar?.v),
      };
    })
    .filter(bar => bar.timestamp != null
      && [bar.o, bar.h, bar.l, bar.c].every(finite)
      && bar.h >= bar.l && bar.o > 0 && bar.c > 0
      && bar.completedAt <= nowMs)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((bar, index) => ({ ...bar, index }));
}

function trueRange(bar, previousClose = null) {
  return Math.max(
    bar.h - bar.l,
    previousClose == null ? 0 : Math.abs(bar.h - previousClose),
    previousClose == null ? 0 : Math.abs(bar.l - previousClose),
  );
}

function atrSeries(bars, period = 14) {
  const trs = bars.map((bar, index) => trueRange(bar, bars[index - 1]?.c ?? null));
  return trs.map((_, index) => {
    if (index < period - 1) return null;
    const sample = trs.slice(index - period + 1, index + 1);
    return sample.length === period ? sample.reduce((sum, value) => sum + value, 0) / period : null;
  });
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let current = average(values.slice(0, period));
  for (const value of values.slice(period)) current = value * multiplier + current * (1 - multiplier);
  return current;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  const changes = [];
  for (let i = 1; i < values.length; i += 1) changes.push(values[i] - values[i - 1]);
  const sample = changes.slice(-period);
  const gains = average(sample.map(value => Math.max(0, value)));
  const losses = average(sample.map(value => Math.max(0, -value)));
  if (losses === 0) return gains > 0 ? 100 : 50;
  return 100 - (100 / (1 + gains / losses));
}

function relativeVolume(bars, index, period = 20) {
  const volume = bars[index]?.v;
  const history = bars.slice(Math.max(0, index - period), index)
    .map(bar => bar.v).filter(value => value != null && value > 0);
  return volume != null && history.length >= Math.min(5, period)
    ? volume / average(history)
    : null;
}

function body(bar) {
  return Math.abs(bar.c - bar.o);
}

function range(bar) {
  return Math.max(0.0000001, bar.h - bar.l);
}

function confirmedSwings(bars) {
  const highs = [];
  const lows = [];
  for (let i = 2; i < bars.length - 2; i += 1) {
    const window = bars.slice(i - 2, i + 3);
    if (bars[i].h >= Math.max(...window.map(bar => bar.h))) highs.push({
      type: 'HIGH', index: i, price: bars[i].h, t: bars[i].t,
    });
    if (bars[i].l <= Math.min(...window.map(bar => bar.l))) lows.push({
      type: 'LOW', index: i, price: bars[i].l, t: bars[i].t,
    });
  }
  return { highs, lows };
}

function structureState(swings) {
  const highs = swings.highs.slice(-3);
  const lows = swings.lows.slice(-3);
  const higherHighs = highs.length >= 2 && highs.at(-1).price > highs.at(-2).price;
  const lowerHighs = highs.length >= 2 && highs.at(-1).price < highs.at(-2).price;
  const higherLows = lows.length >= 2 && lows.at(-1).price > lows.at(-2).price;
  const lowerLows = lows.length >= 2 && lows.at(-1).price < lows.at(-2).price;
  const bullish = higherHighs && higherLows;
  const bearish = lowerHighs && lowerLows;
  return {
    state: bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'MIXED',
    bullish, bearish, higherHighs, lowerHighs, higherLows, lowerLows,
    swingHigh: swings.highs.at(-1) || null,
    swingLow: swings.lows.at(-1) || null,
  };
}

function overlaps(aLow, aHigh, bLow, bHigh, tolerance = 0) {
  return aLow <= bHigh + tolerance && bLow <= aHigh + tolerance;
}

function evidenceScore(factors) {
  const weights = {
    displacement: 24,
    base: 18,
    relativeVolume: 12,
    structure: 12,
    liquiditySweep: 10,
    fvg: 8,
    swingConfluence: 8,
    reaction: 8,
  };
  const present = Object.entries(factors)
    .filter(([, value]) => value === true)
    .reduce((sum, [key]) => sum + (weights[key] || 0), 0);
  return clamp(present);
}

function factorLabels(factors) {
  const labels = {
    displacement: 'displacement',
    base: 'base formation',
    relativeVolume: 'relative volume',
    structure: 'market structure',
    liquiditySweep: 'liquidity sweep',
    fvg: 'fair-value gap',
    swingConfluence: 'swing confluence',
    reaction: 'price reaction',
  };
  return Object.entries(factors).filter(([, value]) => value).map(([key]) => labels[key]);
}

function makeZone({
  type, low, high, originIndex, bars, atr, swings, structure, fvg = false,
  sweep = false, source = 'displacement/base', timeframe,
}) {
  if (!(low > 0) || !(high >= low) || originIndex < 2) return null;
  const latest = bars.at(-1);
  const currentPrice = latest?.c ?? null;
  const baseBar = bars[originIndex];
  const forward = bars.slice(originIndex + 1, Math.min(bars.length, originIndex + 8));
  const direction = type === 'DEMAND' ? 1 : -1;
  const reaction = forward.some(bar => direction > 0 ? bar.c > high : bar.c < low);
  const displacement = forward[0] && body(forward[0]) >= (atr[originIndex] || range(baseBar)) * 0.65;
  const rv = relativeVolume(bars, Math.min(bars.length - 1, originIndex + 1));
  const relatedSwing = type === 'DEMAND'
    ? swings.lows.some(swing => Math.abs(swing.price - low) <= (atr[originIndex] || 0) * 0.8)
    : swings.highs.some(swing => Math.abs(swing.price - high) <= (atr[originIndex] || 0) * 0.8);
  const factors = {
    displacement: !!displacement,
    base: true,
    relativeVolume: rv != null && rv >= 1.15,
    structure: type === 'DEMAND' ? structure.bullish || structure.higherLows : structure.bearish || structure.lowerHighs,
    liquiditySweep: sweep,
    fvg,
    swingConfluence: relatedSwing,
    reaction,
  };
  const score = evidenceScore(factors);
  const atrValue = atr[originIndex] || average(atr.filter(Number.isFinite)) || range(baseBar);
  const invalidation = type === 'DEMAND' ? low - atrValue * 0.25 : high + atrValue * 0.25;
  let touches = 0;
  let mitigated = false;
  let invalidated = false;
  for (const bar of bars.slice(originIndex + 1)) {
    if (overlaps(bar.l, bar.h, low, high)) touches += 1;
    if (type === 'DEMAND' && bar.c < invalidation) invalidated = true;
    if (type === 'SUPPLY' && bar.c > invalidation) invalidated = true;
  }
  mitigated = touches > 0;
  const status = invalidated ? 'INVALIDATED' : currentPrice != null && overlaps(currentPrice, currentPrice, low, high)
    ? 'ACTIVE · IN ZONE' : mitigated ? 'MITIGATED' : 'FRESH';
  const distancePct = currentPrice ? Math.abs((currentPrice - (low + high) / 2) / currentPrice) * 100 : null;
  return {
    id: `${timeframe}-${type}-${originIndex}`,
    type,
    low: round(low, 4),
    high: round(high, 4),
    midpoint: round((low + high) / 2, 4),
    origin: { t: baseBar.t, index: originIndex },
    score,
    confidence: score >= 70 ? 'HIGH' : score >= 52 ? 'MEDIUM' : 'LOW',
    timeframe,
    factors: factorLabels(factors),
    evidence: {
      relativeVolume: round(rv, 2),
      atr: round(atrValue, 4),
      displacement: !!displacement,
      fairValueGap: fvg,
      liquiditySweep: sweep,
      reaction,
    },
    freshness: 'COMPLETED BAR',
    touches,
    mitigation: mitigated ? 'TOUCHED / MITIGATED' : 'UNMITIGATED',
    status,
    invalidation: {
      reference: round(invalidation, 4),
      rule: type === 'DEMAND'
        ? 'Analytical invalidation below the demand range by 0.25 ATR'
        : 'Analytical invalidation above the supply range by 0.25 ATR',
    },
    distancePct: round(distancePct, 2),
    sources: [source],
  };
}

function detectCandidates(bars, timeframe, atr, swings, structure) {
  const candidates = [];
  for (let i = 2; i < bars.length - 3; i += 1) {
    const currentAtr = atr[i] || average(atr.filter(Number.isFinite));
    if (!(currentAtr > 0)) continue;
    const base = bars[i];
    const next = bars[i + 1];
    const nextNext = bars[i + 2];
    const baseSmall = range(base) <= currentAtr * 1.35;
    const bullDisplacement = next.c > base.h && body(next) >= currentAtr * 0.55
      && next.c > next.o && next.c >= nextNext?.c - currentAtr * 0.2;
    const bearDisplacement = next.c < base.l && body(next) >= currentAtr * 0.55
      && next.c < next.o && next.c <= nextNext?.c + currentAtr * 0.2;
    const bullFvg = nextNext && nextNext.l > base.h && (nextNext.l - base.h) >= currentAtr * 0.08;
    const bearFvg = nextNext && nextNext.h < base.l && (base.l - nextNext.h) >= currentAtr * 0.08;
    const sweptLow = bars.slice(Math.max(0, i - 8), i).some(bar => base.l < bar.l)
      && next.c > base.c;
    const sweptHigh = bars.slice(Math.max(0, i - 8), i).some(bar => base.h > bar.h)
      && next.c < base.c;
    if (baseSmall && bullDisplacement) {
      const zone = makeZone({
        type: 'DEMAND', low: base.l, high: Math.max(base.o, base.c),
        originIndex: i, bars, atr, swings, structure, fvg: !!bullFvg,
        sweep: sweptLow, source: bullFvg ? 'displacement/base + FVG' : 'displacement/base', timeframe,
      });
      if (zone) candidates.push(zone);
    }
    if (baseSmall && bearDisplacement) {
      const zone = makeZone({
        type: 'SUPPLY', low: Math.min(base.o, base.c), high: base.h,
        originIndex: i, bars, atr, swings, structure, fvg: !!bearFvg,
        sweep: sweptHigh, source: bearFvg ? 'displacement/base + FVG' : 'displacement/base', timeframe,
      });
      if (zone) candidates.push(zone);
    }
  }
  return candidates;
}

function swingZones(bars, timeframe, atr, swings, structure) {
  const zones = [];
  const latestIndex = bars.length - 1;
  for (const swing of [...swings.highs.slice(-6), ...swings.lows.slice(-6)]) {
    const width = Math.max(atr[swing.index] || 0, bars[swing.index]?.c * 0.002 || 0);
    const type = swing.type === 'LOW' ? 'DEMAND' : 'SUPPLY';
    const zone = makeZone({
      type,
      low: type === 'DEMAND' ? swing.price - width * 0.25 : swing.price - width * 0.7,
      high: type === 'DEMAND' ? swing.price + width * 0.7 : swing.price + width * 0.25,
      originIndex: Math.min(swing.index, latestIndex - 3),
      bars, atr, swings, structure, source: 'confirmed swing', timeframe,
    });
    if (zone) {
      zone.factors = [...new Set([...zone.factors, 'swing confluence'])];
      zone.score = Math.max(zone.score, 52);
      zone.confidence = zone.score >= 70 ? 'HIGH' : 'MEDIUM';
      zones.push(zone);
    }
  }
  return zones;
}

function mergeZones(zones, tolerance, currentPrice) {
  const merged = [];
  const sorted = [...zones].sort((a, b) => b.score - a.score || b.origin.index - a.origin.index);
  for (const zone of sorted) {
    const existing = merged.find(item => item.type === zone.type
      && overlaps(item.low, item.high, zone.low, zone.high, tolerance)
      && Math.max(item.high, zone.high) - Math.min(item.low, zone.low)
        <= Math.max(tolerance * 4, (item.high - item.low), (zone.high - zone.low)));
    if (!existing) {
      merged.push({ ...zone, timeframe: [zone.timeframe] });
      continue;
    }
    existing.low = round(Math.min(existing.low, zone.low), 4);
    existing.high = round(Math.max(existing.high, zone.high), 4);
    existing.midpoint = round((existing.low + existing.high) / 2, 4);
    existing.score = Math.max(existing.score, zone.score);
    existing.confidence = existing.score >= 70 ? 'HIGH' : 'MEDIUM';
    existing.timeframe = [...new Set([...existing.timeframe, zone.timeframe])];
    existing.factors = [...new Set([...existing.factors, ...zone.factors])];
    existing.sources = [...new Set([...existing.sources, ...zone.sources])];
    existing.touches += zone.touches;
    if (zone.status === 'ACTIVE · IN ZONE') existing.status = zone.status;
    const atrValue = Math.max(Number(existing.evidence?.atr || 0), Number(zone.evidence?.atr || 0));
    existing.invalidation = {
      reference: round(existing.type === 'DEMAND' ? existing.low - atrValue * 0.25 : existing.high + atrValue * 0.25, 4),
      rule: existing.type === 'DEMAND'
        ? 'Analytical invalidation below the merged demand range by 0.25 ATR'
        : 'Analytical invalidation above the merged supply range by 0.25 ATR',
    };
    existing.distancePct = currentPrice
      ? round(Math.abs((currentPrice - existing.midpoint) / currentPrice) * 100, 2)
      : null;
  }
  return merged.sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity));
}

function liquidityLevels(bars, swings, currentPrice, atrValue) {
  const clusterTolerance = Math.max(atrValue * 0.45, currentPrice * 0.004);
  const cluster = (items, side) => {
    const groups = [];
    for (const item of items.slice(-12)) {
      let group = groups.find(candidate => Math.abs(candidate.price - item.price) <= clusterTolerance);
      if (!group) {
        group = { price: item.price, touches: 0, lastSeen: item.t };
        groups.push(group);
      }
      group.price = (group.price * group.touches + item.price) / (group.touches + 1);
      group.touches += 1;
      group.lastSeen = item.t;
    }
    return groups.filter(item => item.touches >= 2)
      .map(item => ({
        side, price: round(item.price, 4), touches: item.touches, lastSeen: item.lastSeen,
        status: side === 'ABOVE' ? (item.price > currentPrice ? 'RESTING ABOVE' : 'TAKEN / BELOW PRICE') : (item.price < currentPrice ? 'RESTING BELOW' : 'TAKEN / ABOVE PRICE'),
      }))
      .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))
      .slice(0, 3);
  };
  const swingsHigh = confirmedSwings(bars).highs;
  const swingsLow = confirmedSwings(bars).lows;
  return { above: cluster(swingsHigh, 'ABOVE'), below: cluster(swingsLow, 'BELOW') };
}

function fairValueGaps(bars, atr, currentPrice) {
  const gaps = [];
  for (let index = 2; index < bars.length; index += 1) {
    const first = bars[index - 2];
    const third = bars[index];
    const atrValue = atr[index] || atr[index - 1];
    if (!(atrValue > 0)) continue;
    let type = null;
    let low = null;
    let high = null;
    if (third.l > first.h && third.l - first.h >= atrValue * 0.08) {
      type = 'BULLISH';
      low = first.h;
      high = third.l;
    } else if (third.h < first.l && first.l - third.h >= atrValue * 0.08) {
      type = 'BEARISH';
      low = third.h;
      high = first.l;
    }
    if (!type) continue;
    const following = bars.slice(index + 1);
    const filled = type === 'BULLISH'
      ? following.some(bar => bar.l <= low)
      : following.some(bar => bar.h >= high);
    gaps.push({
      type,
      low: round(low, 4),
      high: round(high, 4),
      midpoint: round((low + high) / 2, 4),
      origin: third.t,
      status: filled ? 'FILLED' : currentPrice >= low && currentPrice <= high ? 'ACTIVE · IN GAP' : 'OPEN',
    });
  }
  return gaps.slice(-8).reverse();
}

function liquiditySweeps(bars, atr) {
  const sweeps = [];
  for (let index = 5; index < bars.length; index += 1) {
    const bar = bars[index];
    const prior = bars.slice(index - 5, index);
    const priorHigh = Math.max(...prior.map(item => item.h));
    const priorLow = Math.min(...prior.map(item => item.l));
    const atrValue = atr[index] || atr[index - 1];
    if (!(atrValue > 0)) continue;
    if (bar.h > priorHigh + atrValue * 0.05 && bar.c < priorHigh) {
      sweeps.push({ side: 'ABOVE', price: round(priorHigh, 4), sweptAt: bar.t, status: 'REJECTED ABOVE LIQUIDITY' });
    }
    if (bar.l < priorLow - atrValue * 0.05 && bar.c > priorLow) {
      sweeps.push({ side: 'BELOW', price: round(priorLow, 4), sweptAt: bar.t, status: 'RECLAIMED BELOW LIQUIDITY' });
    }
  }
  return sweeps.slice(-6).reverse();
}

function latestReclaim(bars, swings) {
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  if (!latest || !previous) return null;
  const priorHigh = [...swings.highs].reverse().find(swing => swing.index < bars.length - 2);
  const priorLow = [...swings.lows].reverse().find(swing => swing.index < bars.length - 2);
  if (priorHigh && previous.c <= priorHigh.price && latest.c > priorHigh.price) {
    return { direction: 'BULLISH', level: round(priorHigh.price, 4), status: 'CLOSED ABOVE PRIOR SWING', confirmedAt: latest.t };
  }
  if (priorLow && previous.c >= priorLow.price && latest.c < priorLow.price) {
    return { direction: 'BEARISH', level: round(priorLow.price, 4), status: 'CLOSED BELOW PRIOR SWING', confirmedAt: latest.t };
  }
  return null;
}

function buildSmartMoneyMap({
  bars = [], timeframe = '1D', currentPrice = null, nowMs = Date.now(),
  source = 'Yahoo Finance chart API', confluenceTimeframes = [],
} = {}) {
  const normalizedTimeframe = String(timeframe || '').toUpperCase();
  const config = TIMEFRAMES[normalizedTimeframe];
  if (!config) return { available: false, status: 'UNAVAILABLE', reason: 'Unsupported timeframe' };
  const completed = normalizeBars(bars, { nowMs, timeframe: normalizedTimeframe });
  const price = n(currentPrice) ?? completed.at(-1)?.c ?? null;
  const baseResult = {
    available: false, status: 'UNAVAILABLE', timeframe: normalizedTimeframe,
    timeframeLabel: config.label, generatedAt: new Date(nowMs).toISOString(),
    source, disclaimer: 'Algorithmically detected potential zones from completed OHLCV bars; this does not show actual institutional orders.',
  };
  if (!price || completed.length < config.minBars) {
    return {
      ...baseResult,
      reason: completed.length ? `At least ${config.minBars} completed ${config.label} bars are required` : 'Completed OHLCV data unavailable',
      dataQuality: { bars: completed.length, volumeAvailable: completed.some(bar => bar.v != null), history: completed.length >= config.minBars ? 'SUFFICIENT' : 'INSUFFICIENT' },
    };
  }
  const atr = atrSeries(completed);
  const swings = confirmedSwings(completed);
  const structure = structureState(swings);
  const latestAtr = atr.at(-1) || average(atr.filter(Number.isFinite));
  const rawCandidates = [
    ...detectCandidates(completed, normalizedTimeframe, atr, swings, structure),
    ...swingZones(completed, normalizedTimeframe, atr, swings, structure),
  ];
  const primary = mergeZones(
    rawCandidates.filter(zone => zone.score >= 52 && zone.status !== 'INVALIDATED'),
    Math.max(latestAtr * 0.55, price * 0.005),
    price,
  );
  const rangeHigh = Math.max(...completed.slice(-Math.min(60, completed.length)).map(bar => bar.h));
  const rangeLow = Math.min(...completed.slice(-Math.min(60, completed.length)).map(bar => bar.l));
  const rangePosition = rangeHigh > rangeLow ? ((price - rangeLow) / (rangeHigh - rangeLow)) * 100 : null;
  const ageMs = nowMs - (completed.at(-1)?.completedAt || completed.at(-1)?.timestamp || 0);
  const freshness = ageMs <= config.maxAgeMs ? 'FRESH' : 'STALE';
  const allConfluence = (Array.isArray(confluenceTimeframes) ? confluenceTimeframes : [])
    .flatMap(other => {
      const timeframes = Array.isArray(other?.timeframe) ? other.timeframe : [other?.timeframe];
      return timeframes.filter(Boolean).map(otherTimeframe => ({ ...other, timeframe: otherTimeframe }));
    });
  const overlapsByTf = primary.map(zone => {
    const matching = allConfluence.filter(other => other?.timeframe && other.timeframe !== normalizedTimeframe
      && other.status !== 'INVALIDATED'
      && other.type === zone.type
      && overlaps(zone.low, zone.high, other.low, other.high, Math.max(latestAtr * 0.75, price * 0.006)));
    return matching.length ? {
      zoneId: zone.id, timeframes: [normalizedTimeframe, ...matching.map(item => item.timeframe)],
      score: clamp(zone.score + Math.min(15, matching.length * 5)),
    } : null;
  }).filter(Boolean);
  const enriched = primary.map(zone => {
    const match = overlapsByTf.find(item => item.zoneId === zone.id);
    return match ? { ...zone, timeframe: match.timeframes, confluence: 'MULTI-TIMEFRAME', score: match.score, confidence: match.score >= 70 ? 'HIGH' : 'MEDIUM' } : zone;
  });
  const demand = enriched.filter(zone => zone.type === 'DEMAND').slice(0, 4);
  const supply = enriched.filter(zone => zone.type === 'SUPPLY').slice(0, 4);
  const currentDemand = demand.filter(zone => zone.high <= price).sort((a, b) => b.high - a.high)[0] || demand[0] || null;
  const currentSupply = supply.filter(zone => zone.low >= price).sort((a, b) => a.low - b.low)[0] || supply[0] || null;
  const bias = currentDemand && currentSupply
    ? currentDemand.score > currentSupply.score + 8 ? 'DEMAND-LED'
      : currentSupply.score > currentDemand.score + 8 ? 'SUPPLY-LED' : 'BALANCED'
    : currentDemand ? 'DEMAND-LED' : currentSupply ? 'SUPPLY-LED' : 'UNAVAILABLE';
  const confidence = enriched.length
    ? clamp(average(enriched.slice(0, 4).map(zone => zone.score)) - (freshness === 'STALE' ? 20 : 0))
    : 0;
  const gaps = fairValueGaps(completed, atr, price);
  const sweeps = liquiditySweeps(completed, atr);
  const support = currentDemand
    ? { low: currentDemand.low, high: currentDemand.high, source: 'potential demand zone' }
    : structure.swingLow ? { low: round(structure.swingLow.price, 4), high: round(structure.swingLow.price, 4), source: 'confirmed swing low' } : null;
  const resistance = currentSupply
    ? { low: currentSupply.low, high: currentSupply.high, source: 'potential supply zone' }
    : structure.swingHigh ? { low: round(structure.swingHigh.price, 4), high: round(structure.swingHigh.price, 4), source: 'confirmed swing high' } : null;
  return {
    ...baseResult,
    available: true,
    status: freshness,
    currentPrice: round(price, 4),
    asOf: completed.at(-1)?.t || null,
    bars: completed.length,
    dataQuality: {
      bars: completed.length,
      volumeAvailable: completed.some(bar => bar.v != null && bar.v > 0),
      history: 'SUFFICIENT',
      freshness,
      lowConfidenceHidden: rawCandidates.filter(zone => zone.score < 52).length,
    },
    indicators: {
      atr: round(latestAtr, 4),
      atrPct: round(latestAtr / price * 100, 2),
      ema20: round(ema(completed.map(bar => bar.c), 20), 4),
      rsi14: round(rsi(completed.map(bar => bar.c)), 1),
      vwap: completed.some(bar => bar.v > 0)
        ? round(completed.reduce((sum, bar) => sum + ((bar.h + bar.l + bar.c) / 3) * bar.v, 0)
          / completed.reduce((sum, bar) => sum + (bar.v || 0), 0), 4)
        : null,
    },
    structure: {
      state: structure.state,
      higherHighs: structure.higherHighs,
      lowerHighs: structure.lowerHighs,
      higherLows: structure.higherLows,
      lowerLows: structure.lowerLows,
      swingHigh: structure.swingHigh ? { price: round(structure.swingHigh.price, 4), t: structure.swingHigh.t } : null,
      swingLow: structure.swingLow ? { price: round(structure.swingLow.price, 4), t: structure.swingLow.t } : null,
    },
    supportResistance: { support, resistance },
    reclaim: latestReclaim(completed, swings),
    fairValueGaps: gaps,
    liquiditySweeps: sweeps,
    range: { high: round(rangeHigh, 4), low: round(rangeLow, 4), positionPct: round(rangePosition, 1), label: rangePosition == null ? 'UNAVAILABLE' : rangePosition >= 70 ? 'UPPER RANGE' : rangePosition <= 30 ? 'LOWER RANGE' : 'MID-RANGE' },
    liquidity: liquidityLevels(completed, swings, price, latestAtr),
    demand,
    supply,
    zones: enriched.slice(0, 8),
    nearest: { demand: currentDemand, supply: currentSupply },
    confidence,
    bias,
    chartBars: completed.map(bar => ({
      t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v,
    })),
    overlay: {
      zones: enriched.slice(0, 6).map(zone => ({ type: zone.type, low: zone.low, high: zone.high, score: zone.score, status: zone.status })),
      liquidity: [...(liquidityLevels(completed, swings, price, latestAtr).above || []), ...(liquidityLevels(completed, swings, price, latestAtr).below || [])],
      swings: [
        structure.swingHigh ? { type: 'HIGH', price: structure.swingHigh.price } : null,
        structure.swingLow ? { type: 'LOW', price: structure.swingLow.price } : null,
      ].filter(Boolean),
    },
    methodology: 'Completed OHLCV bars; ATR-normalized displacement and base detection; relative volume, structure, sweeps, FVGs, swings, reactions, and timeframe overlap are bounded scoring inputs. Nearby candidates are merged and low-confidence candidates are hidden.',
  };
}

function aggregateBars(bars, groups = 4) {
  const source = Array.isArray(bars) ? bars : [];
  const output = [];
  for (let i = 0; i + groups <= source.length; i += groups) {
    const slice = source.slice(i, i + groups);
    if (!slice.length) continue;
    output.push({
      t: slice[0].t, o: slice[0].o, h: Math.max(...slice.map(bar => bar.h)),
      l: Math.min(...slice.map(bar => bar.l)), c: slice.at(-1).c,
      v: slice.every(bar => bar.v == null) ? null : slice.reduce((sum, bar) => sum + (bar.v || 0), 0),
    });
  }
  return output;
}

function aggregateRegularSessionHours(bars, timezone = 'America/New_York') {
  const sessions = new Map();
  for (const bar of (bars || []).filter(item => item.session === 'reg')) {
    const timestamp = timestampMs(bar.t);
    if (timestamp == null) continue;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (!sessions.has(date)) sessions.set(date, []);
    sessions.get(date).push(bar);
  }
  return [...sessions.values()].flatMap(session => {
    const group = session.sort((a, b) => timestampMs(a.t) - timestampMs(b.t)).slice(0, 4);
    if (group.length !== 4) return [];
    return [{
      t: group[0].t,
      completeAt: timestampMs(group.at(-1).t) + 60 * 60 * 1000,
      o: group[0].o,
      h: Math.max(...group.map(bar => bar.h)),
      l: Math.min(...group.map(bar => bar.l)),
      c: group.at(-1).c,
      v: group.every(bar => bar.v == null) ? null : group.reduce((sum, bar) => sum + (bar.v || 0), 0),
    }];
  });
}

function aggregateCalendarBars(bars, timeframe) {
  if (!['1W', '1M'].includes(timeframe)) return [];
  const groups = new Map();
  for (const bar of bars || []) {
    const rawTimestamp = timestampMs(bar.t ?? bar.date);
    const timestamp = typeof (bar.t ?? bar.date) === 'string'
      && /^\d{4}-\d{2}-\d{2}/.test(bar.t ?? bar.date)
      ? Date.parse(String(bar.t ?? bar.date).slice(0, 10) + 'T12:00:00Z')
      : rawTimestamp;
    if (!Number.isFinite(timestamp)) continue;
    const date = new Date(timestamp);
    let key;
    let completeAt;
    if (timeframe === '1M') {
      key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      completeAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    } else {
      const monday = new Date(timestamp);
      const day = monday.getUTCDay() || 7;
      monday.setUTCDate(monday.getUTCDate() - day + 1);
      key = monday.toISOString().slice(0, 10);
      completeAt = monday.getTime() + 7 * 24 * 60 * 60 * 1000;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...bar, completeAt });
  }
  return [...groups.values()].map(group => ({
    t: group[0].t,
    completeAt: group[0].completeAt,
    o: group[0].o,
    h: Math.max(...group.map(bar => bar.h)),
    l: Math.min(...group.map(bar => bar.l)),
    c: group.at(-1).c,
    v: group.every(bar => bar.v == null) ? null : group.reduce((sum, bar) => sum + (bar.v || 0), 0),
  }));
}

module.exports = {
  TIMEFRAMES,
  TF_ORDER,
  aggregateBars,
  aggregateCalendarBars,
  aggregateRegularSessionHours,
  buildSmartMoneyMap,
  confirmedSwings,
  normalizeBars,
};