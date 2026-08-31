'use strict';

function finite(value) {
  return Number.isFinite(Number(value));
}

function normalizeBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .filter(bar => [bar?.o, bar?.h, bar?.l, bar?.c].every(finite))
    .map(bar => ({
      t: String(bar.t || bar.date || '').slice(0, 10),
      o: Number(bar.o),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
    }))
    .filter(bar => bar.t && bar.h >= bar.l && bar.o > 0 && bar.c > 0)
    .sort((a, b) => a.t.localeCompare(b.t));
}

function detectSessionGaps(bars, minimumGapPct = 0.2) {
  const normalized = normalizeBars(bars);
  const gaps = [];
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    let direction = null;
    let zoneLow = null;
    let zoneHigh = null;
    if (current.l > previous.h) {
      direction = 'UP';
      zoneLow = previous.h;
      zoneHigh = current.l;
    } else if (current.h < previous.l) {
      direction = 'DOWN';
      zoneLow = current.h;
      zoneHigh = previous.l;
    }
    if (!direction) continue;
    const sizePct = previous.c > 0 ? ((zoneHigh - zoneLow) / previous.c) * 100 : 0;
    if (sizePct < minimumGapPct) continue;
    gaps.push({
      direction,
      index,
      date: current.t,
      zoneLow,
      zoneHigh,
      sizePct,
    });
  }
  return { bars: normalized, gaps };
}

function isFilled(gap, bars, endIndex = bars.length - 1) {
  for (let index = gap.index + 1; index <= endIndex; index += 1) {
    const bar = bars[index];
    if (gap.direction === 'UP' && bar.l <= gap.zoneLow) return index - gap.index;
    if (gap.direction === 'DOWN' && bar.h >= gap.zoneHigh) return index - gap.index;
  }
  return null;
}

function historicalFillStats(gaps, bars, direction, horizonSessions) {
  const eligible = gaps.filter(gap =>
    gap.direction === direction && gap.index + horizonSessions < bars.length);
  const fillDays = eligible
    .map(gap => isFilled(gap, bars, gap.index + horizonSessions))
    .filter(days => days != null);
  return {
    fillRatePct: eligible.length
      ? Math.round((fillDays.length / eligible.length) * 100)
      : null,
    sampleSize: eligible.length,
    medianSessions: fillDays.length
      ? [...fillDays].sort((a, b) => a - b)[Math.floor(fillDays.length / 2)]
      : null,
    horizonSessions,
  };
}

function serializeGap(gap, price, stats) {
  if (!gap) return null;
  const nearestEdge = gap.direction === 'DOWN' ? gap.zoneLow : gap.zoneHigh;
  const fillEdge = gap.direction === 'DOWN' ? gap.zoneHigh : gap.zoneLow;
  return {
    direction: gap.direction,
    date: gap.date,
    zoneLow: +gap.zoneLow.toFixed(2),
    zoneHigh: +gap.zoneHigh.toFixed(2),
    sizePct: +gap.sizePct.toFixed(2),
    distancePct: +((Math.abs(nearestEdge - price) / price) * 100).toFixed(2),
    remainingFillPct: +((Math.abs(fillEdge - price) / price) * 100).toFixed(2),
    historicalFill: stats,
  };
}

function buildSearchGapAnalysis({
  dailyBars,
  currentPrice,
  minimumGapPct = 0.2,
  horizonSessions = 20,
} = {}) {
  const price = Number(currentPrice);
  const { bars, gaps } = detectSessionGaps(dailyBars, minimumGapPct);
  if (!finite(price) || price <= 0) {
    return { available: false, above: null, below: null, reason: 'Current price unavailable' };
  }

  const open = gaps.filter(gap => isFilled(gap, bars) == null);
  const above = open
    .filter(gap => gap.direction === 'DOWN' && gap.zoneLow > price)
    .sort((a, b) => a.zoneLow - b.zoneLow)[0] || null;
  const below = open
    .filter(gap => gap.direction === 'UP' && gap.zoneHigh < price)
    .sort((a, b) => b.zoneHigh - a.zoneHigh)[0] || null;
  const current = open
    .filter(gap => gap.zoneLow <= price && gap.zoneHigh >= price)
    .sort((a, b) => Math.abs(a.zoneHigh - a.zoneLow) - Math.abs(b.zoneHigh - b.zoneLow))[0] || null;
  const downStats = historicalFillStats(gaps, bars, 'DOWN', horizonSessions);
  const upStats = historicalFillStats(gaps, bars, 'UP', horizonSessions);

  return {
    available: bars.length >= horizonSessions + 2,
    above: serializeGap(above, price, downStats),
    below: serializeGap(below, price, upStats),
    current: serializeGap(current, price, current?.direction === 'DOWN' ? downStats : upStats),
    methodology: `Unfilled daily range gaps of at least ${minimumGapPct}% using completed sessions; rates measure full gap traversal within ${horizonSessions} sessions and are not guarantees.`,
  };
}

function summarizePatternAnalysis({ daily = [], intraday = [] } = {}) {
  const select = (patterns, timeframe) => (Array.isArray(patterns) ? patterns : [])
    .filter(pattern => ['BULLISH', 'BEARISH'].includes(pattern?.type))
    .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0))
    .slice(0, 3)
    .map(pattern => ({
      name: String(pattern.name),
      type: pattern.type,
      strength: Math.max(1, Math.min(3, Number(pattern.strength) || 1)),
      timeframe,
      description: String(pattern.desc || ''),
    }));
  const patterns = [...select(daily, 'Daily'), ...select(intraday, '5-minute')];
  const bullishScore = patterns
    .filter(pattern => pattern.type === 'BULLISH')
    .reduce((sum, pattern) => sum + pattern.strength * (pattern.timeframe === 'Daily' ? 4 : 3), 0);
  const bearishScore = patterns
    .filter(pattern => pattern.type === 'BEARISH')
    .reduce((sum, pattern) => sum + pattern.strength * (pattern.timeframe === 'Daily' ? 4 : 3), 0);
  const netScore = Math.max(-24, Math.min(24, bullishScore - bearishScore));
  return {
    available: patterns.length > 0,
    direction: netScore > 0 ? 'BULLISH' : netScore < 0 ? 'BEARISH' : 'MIXED',
    netScore,
    bullishScore,
    bearishScore,
    patterns,
  };
}

module.exports = {
  buildSearchGapAnalysis,
  detectSessionGaps,
  historicalFillStats,
  summarizePatternAnalysis,
};