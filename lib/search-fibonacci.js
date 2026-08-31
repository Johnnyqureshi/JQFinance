'use strict';

const RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];

function finite(value) {
  return Number.isFinite(Number(value));
}

function normalizeBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .filter(bar => [bar?.h, bar?.l, bar?.c].every(finite))
    .map((bar, index) => ({
      index,
      t: String(bar.t || bar.date || '').slice(0, 10),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
    }))
    .filter(bar => bar.h >= bar.l && bar.c > 0);
}

function confirmedPivots(bars) {
  const pivots = [];
  for (let index = 2; index < bars.length - 2; index += 1) {
    const window = bars.slice(index - 2, index + 3);
    const bar = bars[index];
    if (bar.h === Math.max(...window.map(item => item.h))) {
      pivots.push({ type: 'HIGH', index, price: bar.h, date: bar.t });
    }
    if (bar.l === Math.min(...window.map(item => item.l))) {
      pivots.push({ type: 'LOW', index, price: bar.l, date: bar.t });
    }
  }
  return pivots;
}

function selectSwing(bars) {
  const pivots = confirmedPivots(bars);
  for (let index = pivots.length - 1; index > 0; index -= 1) {
    const end = pivots[index];
    const start = [...pivots.slice(0, index)].reverse()
      .find(pivot => pivot.type !== end.type && end.index - pivot.index >= 3);
    if (!start) continue;
    const low = start.type === 'LOW' ? start : end;
    const high = start.type === 'HIGH' ? start : end;
    if (high.price <= low.price || (high.price - low.price) / low.price < 0.01) continue;
    return {
      direction: end.type === 'HIGH' ? 'BULLISH' : 'BEARISH',
      low,
      high,
      start,
      end,
    };
  }

  const low = bars.reduce((best, bar) => bar.l < best.l ? bar : best, bars[0]);
  const high = bars.reduce((best, bar) => bar.h > best.h ? bar : best, bars[0]);
  if (!low || !high || high.h <= low.l || (high.h - low.l) / low.l < 0.01) return null;
  const lowPivot = { type: 'LOW', index: low.index, price: low.l, date: low.t };
  const highPivot = { type: 'HIGH', index: high.index, price: high.h, date: high.t };
  const end = low.index < high.index ? highPivot : lowPivot;
  const start = end.type === 'HIGH' ? lowPivot : highPivot;
  return {
    direction: end.type === 'HIGH' ? 'BULLISH' : 'BEARISH',
    low: lowPivot,
    high: highPivot,
    start,
    end,
  };
}

function buildSearchFibonacci({ dailyBars, currentPrice, lookback = 60 } = {}) {
  const price = Number(currentPrice);
  const bars = normalizeBars(dailyBars).slice(-lookback)
    .map((bar, index) => ({ ...bar, index }));
  if (!finite(price) || price <= 0) {
    return { available: false, reason: 'Current price unavailable' };
  }
  if (bars.length < 10) {
    return { available: false, reason: 'At least 10 completed sessions are required' };
  }
  const swing = selectSwing(bars);
  if (!swing) return { available: false, reason: 'No confirmed price swing available' };

  const range = swing.high.price - swing.low.price;
  const levelPrice = ratio => swing.direction === 'BULLISH'
    ? swing.high.price - range * ratio
    : swing.low.price + range * ratio;
  const levels = RATIOS.map(ratio => ({
    ratio: +(ratio * 100).toFixed(1),
    price: +levelPrice(ratio).toFixed(2),
    distancePct: +((Math.abs(price - levelPrice(ratio)) / price) * 100).toFixed(2),
  }));
  const extensions = [1.272, 1.618].map(ratio => ({
    ratio: +(ratio * 100).toFixed(1),
    price: +(swing.direction === 'BULLISH'
      ? swing.low.price + range * ratio
      : swing.high.price - range * ratio).toFixed(2),
  }));
  const support = levels.filter(level => level.price <= price).sort((a, b) => b.price - a.price)[0] || null;
  const resistance = levels.filter(level => level.price >= price).sort((a, b) => a.price - b.price)[0] || null;
  const nearest = [...levels].sort((a, b) => a.distancePct - b.distancePct)[0];
  const golden = levels.find(level => level.ratio === 61.8);
  const beyondImpulse = swing.direction === 'BULLISH'
    ? price > swing.high.price
    : price < swing.low.price;
  const holdingGolden = swing.direction === 'BULLISH'
    ? price >= golden.price
    : price <= golden.price;
  const direction = beyondImpulse || holdingGolden
    ? swing.direction
    : swing.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
  const confluenceScore = beyondImpulse ? 10 : nearest.distancePct <= 0.35 ? 8 : 6;

  return {
    available: true,
    direction,
    confluenceScore,
    setup: beyondImpulse
      ? `${swing.direction} EXTENSION`
      : holdingGolden
        ? `${swing.direction} SWING HOLDING 61.8%`
        : 'DEEP RETRACEMENT / SWING AT RISK',
    swing: {
      direction: swing.direction,
      low: +swing.low.price.toFixed(2),
      high: +swing.high.price.toFixed(2),
      lowDate: swing.low.date,
      highDate: swing.high.date,
      range: +range.toFixed(2),
    },
    levels,
    extensions,
    nearestSupport: support,
    nearestResistance: resistance,
    nearestLevel: nearest,
    methodology: 'Confirmed completed-session swing; Fibonacci is confluence, not a standalone trade trigger.',
  };
}

module.exports = {
  buildSearchFibonacci,
  confirmedPivots,
  selectSwing,
};