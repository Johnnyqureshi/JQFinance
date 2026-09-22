'use strict';

// This module is deliberately limited to completed OHLCV and quote inputs.
// It must never be described as Level 2, an order book, executed flow,
// absorption, or institutional liquidity.

const finite = value => value !== null
  && value !== undefined
  && !(typeof value === 'string' && value.trim() === '')
  && Number.isFinite(Number(value));

const number = value => finite(value) ? Number(value) : null;
const round = (value, decimals = 2) => finite(value) ? +Number(value).toFixed(decimals) : null;

function normalizeBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .filter(bar => [bar?.h, bar?.l, bar?.c].every(finite))
    .map(bar => ({
      t: bar.t || bar.date || null,
      o: number(bar.o),
      h: number(bar.h),
      l: number(bar.l),
      c: number(bar.c),
      v: number(bar.v),
    }))
    .filter(bar => bar.h >= bar.l && bar.c > 0)
    .sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')));
}

function average(values) {
  const usable = values.filter(finite).map(Number);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function simpleMovingAverage(bars, period) {
  const closes = bars.map(bar => bar.c).filter(finite);
  return closes.length >= period ? average(closes.slice(-period)) : null;
}

function structureFromBars(bars) {
  if (bars.length < 10) {
    return {
      state: 'MIXED',
      available: false,
      higherHighs: null,
      higherLows: null,
      lowerHighs: null,
      lowerLows: null,
      reason: 'At least 10 completed daily bars are required for a two-window structure comparison.',
    };
  }

  const windowSize = Math.min(5, Math.floor(bars.length / 2));
  const prior = bars.slice(-(windowSize * 2), -windowSize);
  const recent = bars.slice(-windowSize);
  const higherHighs = Math.max(...recent.map(bar => bar.h)) > Math.max(...prior.map(bar => bar.h));
  const higherLows = Math.min(...recent.map(bar => bar.l)) > Math.min(...prior.map(bar => bar.l));
  const lowerHighs = Math.max(...recent.map(bar => bar.h)) < Math.max(...prior.map(bar => bar.h));
  const lowerLows = Math.min(...recent.map(bar => bar.l)) < Math.min(...prior.map(bar => bar.l));
  const state = higherHighs && higherLows
    ? 'BULLISH'
    : lowerHighs && lowerLows
      ? 'BEARISH'
      : 'MIXED';

  return {
    state,
    available: true,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    recentWindow: windowSize,
    reason: state === 'BULLISH'
      ? 'Recent completed bars made both a higher high and a higher low versus the prior window.'
      : state === 'BEARISH'
        ? 'Recent completed bars made both a lower high and a lower low versus the prior window.'
        : 'Recent completed bars do not show both matching higher or matching lower swing conditions.',
  };
}

function structuralLevels(levels, side, price) {
  const projected = /projected/i;
  return (Array.isArray(levels?.[side]) ? levels[side] : [])
    .map(level => ({
      price: number(level?.price ?? level),
      label: String(level?.label || 'Completed-session level'),
      confirmations: number(level?.confirmations) || 1,
      zoneLow: number(level?.zoneLow),
      zoneHigh: number(level?.zoneHigh),
    }))
    .filter(level => level.price != null
      && level.price > 0
      && !projected.test(level.label)
      && (side === 'support' ? level.price < price : level.price > price))
    .sort((a, b) => side === 'support' ? b.price - a.price : a.price - b.price)
    .slice(0, 3)
    .map((level, index) => ({
      ...level,
      price: round(level.price),
      zoneLow: round(level.zoneLow ?? level.price),
      zoneHigh: round(level.zoneHigh ?? level.price),
      rank: index + 1,
      type: side === 'support' ? 'STRUCTURAL SUPPORT' : 'STRUCTURAL RESISTANCE',
      source: `Completed OHLCV · ${level.label}`,
    }));
}

function activityFromRelativeVolume(relativeVolume) {
  if (!finite(relativeVolume)) return { state: 'UNAVAILABLE', label: 'Volume baseline unavailable' };
  const value = Number(relativeVolume);
  if (value >= 2) return { state: 'HIGH', label: 'High participation' };
  if (value < 0.75) return { state: 'LOW', label: 'Low participation' };
  return { state: 'NORMAL', label: 'Normal participation' };
}

function volumeTrend(bars) {
  const withVolume = bars.filter(bar => bar.v != null && bar.v > 0);
  if (withVolume.length < 10) return { state: 'UNAVAILABLE', reason: 'At least 10 completed volume bars are required.' };
  const recent = average(withVolume.slice(-5).map(bar => bar.v));
  const prior = average(withVolume.slice(-10, -5).map(bar => bar.v));
  if (recent == null || prior == null || prior <= 0) return { state: 'UNAVAILABLE', reason: 'Volume baseline unavailable.' };
  const changePct = (recent - prior) / prior * 100;
  return {
    state: changePct >= 10 ? 'RISING' : changePct <= -10 ? 'DECLINING' : 'STABLE',
    changePct: round(changePct, 1),
    recentAverage: round(recent, 0),
    priorAverage: round(prior, 0),
  };
}

function volumeByPrice(bars) {
  const usable = bars.filter(bar => bar.v != null && bar.v > 0 && bar.h >= bar.l);
  if (usable.length < 5) {
    return { available: false, reason: 'OHLCV volume history is unavailable for concentration analysis.' };
  }
  const low = Math.min(...usable.map(bar => bar.l));
  const high = Math.max(...usable.map(bar => bar.h));
  if (!(high > low)) return { available: false, reason: 'Price range is too narrow for concentration analysis.' };
  const bucketCount = 8;
  const width = (high - low) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    low: low + width * index,
    high: index === bucketCount - 1 ? high : low + width * (index + 1),
    volume: 0,
  }));
  usable.forEach(bar => {
    const typical = (bar.h + bar.l + bar.c) / 3;
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((typical - low) / width)));
    buckets[index].volume += bar.v;
  });
  const total = buckets.reduce((sum, bucket) => sum + bucket.volume, 0);
  const peak = buckets.slice().sort((a, b) => b.volume - a.volume)[0];
  return {
    available: total > 0,
    low: round(peak.low),
    high: round(peak.high),
    sharePct: total > 0 ? round(peak.volume / total * 100, 1) : null,
    bars: usable.length,
    method: 'Approximate OHLCV volume-by-price concentration across recent completed daily bars; not an order-book wall.',
  };
}

function volumeConfirmation({ price, previousClose, changePct, relativeVolume }) {
  const move = finite(changePct)
    ? Number(changePct)
    : finite(previousClose) && previousClose > 0
      ? (price - Number(previousClose)) / Number(previousClose) * 100
      : null;
  if (move == null || relativeVolume == null) {
    return {
      state: 'UNAVAILABLE',
      direction: 'UNKNOWN',
      reason: 'Price change and a verified volume baseline are both required.',
    };
  }
  const direction = move > 0.15 ? 'BULLISH' : move < -0.15 ? 'BEARISH' : 'NEUTRAL';
  if (direction === 'NEUTRAL') {
    return { state: 'NEUTRAL', direction, movePct: round(move, 2), relativeVolume, reason: 'Price change is too small to call directional volume confirmation.' };
  }
  const strong = Number(relativeVolume) >= 1.2;
  return {
    state: strong ? 'CONFIRMED' : 'WEAK',
    direction,
    movePct: round(move, 2),
    relativeVolume: round(relativeVolume, 2),
    reason: strong
      ? `${direction === 'BULLISH' ? 'Upward' : 'Downward'} price movement has at least 1.2x the verified volume baseline.`
      : `${direction === 'BULLISH' ? 'Upward' : 'Downward'} price movement is not supported by elevated relative volume.`,
  };
}

function conditionState({ price, level, relativeVolume, side }) {
  if (price == null || level?.price == null) {
    return { state: 'UNAVAILABLE', trigger: level?.price ?? null, reason: `No verified structural ${side === 'up' ? 'resistance' : 'support'} is available.` };
  }
  const crossed = side === 'up' ? price > level.price : price < level.price;
  if (!crossed) {
    return {
      state: 'WATCH',
      trigger: level.price,
      reason: `A completed close ${side === 'up' ? 'above' : 'below'} structural ${side === 'up' ? 'resistance' : 'support'} is still required.`,
    };
  }
  if (relativeVolume == null) {
    return {
      state: 'UNCONFIRMED',
      trigger: level.price,
      reason: 'Price has crossed the structural level, but relative volume is unavailable.',
    };
  }
  if (Number(relativeVolume) < 1.2) {
    return {
      state: 'UNCONFIRMED',
      trigger: level.price,
      relativeVolume: round(relativeVolume, 2),
      reason: 'Price has crossed the structural level without at least 1.2x relative volume.',
    };
  }
  return {
    state: 'CONFIRMED',
    trigger: level.price,
    relativeVolume: round(relativeVolume, 2),
    reason: `Price is beyond the structural level with at least 1.2x relative volume.`,
  };
}

function buildMarketStructureProxy({
  symbol = null,
  snapshot = {},
  indicators = {},
  dailyBars = [],
  levels = {},
  nowMs = Date.now(),
  source = 'Yahoo Finance quote and chart API',
} = {}) {
  const bars = normalizeBars(dailyBars);
  const price = number(snapshot.price);
  const previousClose = number(snapshot.prevClose) ?? bars.at(-1)?.c ?? null;
  const currentVolume = number(snapshot.volume);
  const historicalAverageVolume = number(snapshot.avgVolume)
    ?? average(bars.slice(-20).map(bar => bar.v));
  const relativeVolume = number(snapshot.relVol)
    ?? (currentVolume != null && historicalAverageVolume > 0 ? currentVolume / historicalAverageVolume : null);
  const sma20 = number(indicators.sma20) ?? simpleMovingAverage(bars, 20);
  const sma50 = number(indicators.sma50) ?? simpleMovingAverage(bars, 50);
  const sma200 = number(indicators.sma200) ?? simpleMovingAverage(bars, 200);
  const vwap = number(indicators.vwap);
  const atr = number(indicators.atr);
  const structure = structureFromBars(bars);
  const support = structuralLevels(levels, 'support', price);
  const resistance = structuralLevels(levels, 'resistance', price);
  const nearestSupport = support[0] || null;
  const nearestResistance = resistance[0] || null;
  const trendChecks = [
    price != null && sma20 != null ? { label: 'Price vs 20 SMA', bullish: price > sma20 } : null,
    sma20 != null && sma50 != null ? { label: '20 SMA vs 50 SMA', bullish: sma20 > sma50 } : null,
    structure.available ? { label: 'Higher highs / higher lows', bullish: structure.state === 'BULLISH' } : null,
  ].filter(Boolean);
  if (vwap != null && price != null) trendChecks.push({ label: 'Price vs session VWAP', bullish: price > vwap });
  const missingTrendInputs = [
    price == null ? 'current price' : null,
    sma20 == null ? '20 SMA' : null,
    sma50 == null ? '50 SMA' : null,
    !structure.available ? 'completed-bar structure' : null,
  ].filter(Boolean);
  const bullishChecks = trendChecks.filter(check => check.bullish).length;
  const bearishChecks = trendChecks.length - bullishChecks;
  const trend = missingTrendInputs.length
    ? 'MIXED'
    : bullishChecks === trendChecks.length
      ? 'BULLISH'
      : bearishChecks === trendChecks.length
        ? 'BEARISH'
        : 'MIXED';
  const previousBar = bars.at(-1) || null;
  const activity = activityFromRelativeVolume(relativeVolume);
  const confirmation = volumeConfirmation({
    price,
    previousClose,
    changePct: snapshot.changePct,
    relativeVolume,
  });
  const trendVolume = volumeTrend(bars);
  const breakout = conditionState({ price, level: nearestResistance, relativeVolume, side: 'up' });
  const breakdown = conditionState({ price, level: nearestSupport, relativeVolume, side: 'down' });
  const volumeProfile = volumeByPrice(bars.slice(-40));
  const volatilityPct = atr != null && price > 0 ? atr / price * 100 : null;
  const gamePlanBias = trend === 'BULLISH' && confirmation.direction !== 'BEARISH'
    ? 'BULLISH'
    : trend === 'BEARISH' && confirmation.direction !== 'BULLISH'
      ? 'BEARISH'
      : 'NEUTRAL';
  const missing = [
    sma20 == null ? '20 SMA' : null,
    sma50 == null ? '50 SMA' : null,
    sma200 == null ? '200 SMA' : null,
    vwap == null ? 'session VWAP' : null,
    atr == null ? 'ATR' : null,
    relativeVolume == null ? 'relative volume' : null,
    !nearestSupport ? 'structural support' : null,
    !nearestResistance ? 'structural resistance' : null,
  ].filter(Boolean);

  return {
    available: price != null && bars.length > 0,
    symbol: String(symbol || '').toUpperCase() || null,
    generatedAt: new Date(nowMs).toISOString(),
    status: price != null && bars.length >= 20 ? 'AVAILABLE' : 'PARTIAL',
    source,
    dataQuality: {
      dailyBars: bars.length,
      volumeAvailable: currentVolume != null || bars.some(bar => bar.v != null),
      complete: missing.length === 0,
      missing,
    },
    current: {
      price: round(price),
      changePct: round(snapshot.changePct, 2),
      open: round(snapshot.open),
      high: round(snapshot.high),
      low: round(snapshot.low),
      volume: round(currentVolume, 0),
      dollarVolume: price != null && currentVolume != null ? round(price * currentVolume, 0) : null,
      marketState: snapshot.marketState || null,
    },
    previousSession: previousBar
      ? { date: previousBar.t, open: round(previousBar.o), high: round(previousBar.h), low: round(previousBar.l), close: round(previousBar.c), volume: round(previousBar.v, 0) }
      : null,
    trend: {
      regime: trend,
      structure: structure.state,
      checks: trendChecks.map(check => ({ ...check, state: check.bullish ? 'BULLISH' : 'BEARISH' })),
      missing: missingTrendInputs,
      reason: missingTrendInputs.length
        ? `Trend is MIXED because ${missingTrendInputs.join(', ')} ${missingTrendInputs.length === 1 ? 'is' : 'are'} unavailable.`
        : trend === 'MIXED'
          ? 'Available trend checks do not agree.'
          : `All available trend checks are ${trend.toLowerCase()}.`,
      higherHighs: structure.higherHighs,
      higherLows: structure.higherLows,
      lowerHighs: structure.lowerHighs,
      lowerLows: structure.lowerLows,
    },
    indicators: {
      sma20: round(sma20),
      sma50: round(sma50),
      sma200: round(sma200),
      vwap: round(vwap),
      atr: round(atr),
      atrPct: round(volatilityPct, 2),
      relativeVolume: round(relativeVolume, 2),
    },
    activity: {
      ...activity,
      relativeVolume: round(relativeVolume, 2),
      currentVolume: round(currentVolume, 0),
      averageVolume: round(historicalAverageVolume, 0),
      trend: trendVolume,
      confirmation,
    },
    levels: {
      support,
      resistance,
      nearestSupport,
      nearestResistance,
      note: 'Structural levels are derived from completed OHLCV bars; they are not resting orders or liquidity walls.',
    },
    conditions: {
      breakout,
      breakdown,
    },
    volumeConcentration: volumeProfile,
    gamePlanInput: {
      bias: gamePlanBias,
      status: missingTrendInputs.length || !nearestSupport || !nearestResistance ? 'PROVISIONAL' : 'VERIFIED_INPUTS',
      reason: gamePlanBias === 'NEUTRAL'
        ? 'No directional game-plan bias is issued because the verified trend and volume evidence do not align.'
        : `${gamePlanBias} bias uses only the verified trend, price, volume, VWAP, and structural-level inputs shown above.`,
      bullishCondition: nearestResistance
        ? `A bullish continuation requires a completed close above structural resistance at $${round(nearestResistance.price)} with at least 1.2x relative volume.`
        : 'Bullish continuation condition unavailable without structural resistance.',
      bearishCondition: nearestSupport
        ? `A bearish continuation requires a completed close below structural support at $${round(nearestSupport.price)} with at least 1.2x relative volume.`
        : 'Bearish continuation condition unavailable without structural support.',
      invalidation: gamePlanBias === 'BULLISH'
        ? nearestSupport ? `Bullish context is weakened below structural support at $${round(nearestSupport.price)}.` : 'Bullish invalidation level unavailable.'
        : gamePlanBias === 'BEARISH'
          ? nearestResistance ? `Bearish context is weakened above structural resistance at $${round(nearestResistance.price)}.` : 'Bearish invalidation level unavailable.'
          : 'No directional invalidation is issued for a neutral or incomplete context.',
      nextLevels: {
        upside: resistance[0]?.price ?? null,
        downside: support[0]?.price ?? null,
        nextUpside: resistance[1]?.price ?? null,
        nextDownside: support[1]?.price ?? null,
      },
    },
    methodology: 'Deterministic proxy from the verified quote, completed daily OHLCV, session VWAP, ATR, moving averages, relative volume, and completed-session structural levels.',
    disclaimer: 'This is market-structure context only. It does not observe Level 2, order-book walls, absorption, quote imbalance, or executed aggressor flow, and it does not place or authorize trades.',
  };
}

module.exports = {
  buildMarketStructureProxy,
  structureFromBars,
  volumeByPrice,
};