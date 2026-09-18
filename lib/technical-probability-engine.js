'use strict';

/**
 * Deterministic technical confluence analysis.
 *
 * This is decision support, not a forecasting model. Every score is bounded,
 * is derived only from supplied market observations, and exposes the factors
 * that produced it so callers never need to infer a hidden "prediction".
 */

const clamp = (value, min = 5, max = 95) => Math.max(min, Math.min(max, Math.round(value)));
const finite = value => Number.isFinite(Number(value));
const number = value => finite(value) ? Number(value) : null;

function ema(values, period) {
  const clean = values.map(number).filter(v => v != null);
  if (clean.length < period) return null;
  const k = 2 / (period + 1);
  let value = clean.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < clean.length; i++) value = clean[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  const clean = values.map(number).filter(v => v != null);
  if (clean.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = clean[i] - clean[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < clean.length; i++) {
    const change = clean[i] - clean[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function pctDistance(price, level) {
  if (!finite(price) || !finite(level) || Number(level) === 0) return null;
  return ((Number(price) - Number(level)) / Number(level)) * 100;
}

function trendForBars(bars, fast = 9, slow = 20) {
  const closes = (bars || []).map(bar => number(bar.c)).filter(v => v != null);
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const momentum = rsi(closes);
  if (fastEma == null || slowEma == null || !closes.length) {
    return { state: 'UNAVAILABLE', rsi: momentum, fastEma, slowEma };
  }
  const price = closes.at(-1);
  const state = price > fastEma && fastEma > slowEma
    ? 'BULLISH'
    : price < fastEma && fastEma < slowEma
      ? 'BEARISH'
      : 'MIXED';
  return { state, rsi: momentum == null ? null : +momentum.toFixed(1), fastEma, slowEma };
}

function intradayVwapTrend(bars) {
  const regular = (bars || []).filter(bar => bar.session === 'reg' && finite(bar.v) && Number(bar.v) > 0
    && finite(bar.h) && finite(bar.l) && finite(bar.c));
  if (regular.length < 4) return { value: null, slope: 'UNAVAILABLE', reclaimed: false, rejected: false };
  let pv = 0;
  let volume = 0;
  const values = [];
  for (const bar of regular) {
    const typicalPrice = (Number(bar.h) + Number(bar.l) + Number(bar.c)) / 3;
    pv += typicalPrice * Number(bar.v);
    volume += Number(bar.v);
    values.push(pv / volume);
  }
  const value = values.at(-1);
  const compare = values.at(-4);
  const slope = value > compare * 1.0005 ? 'RISING' : value < compare * 0.9995 ? 'FALLING' : 'FLAT';
  const lastFour = regular.slice(-4);
  const reclaimed = lastFour[0].c < values[values.length - 4] && lastFour.at(-1).c > value;
  const rejected = lastFour[0].c > values[values.length - 4] && lastFour.at(-1).c < value;
  return { value, slope, reclaimed, rejected };
}

function intradayVolume(bars) {
  const valid = (bars || []).filter(bar => finite(bar.v) && Number(bar.v) > 0);
  if (valid.length < 6) return { state: 'UNAVAILABLE', ratio: null, upDownRatio: null };
  const recent = valid.slice(-3);
  const prior = valid.slice(-Math.min(18, valid.length), -3);
  const recentVolume = recent.reduce((sum, bar) => sum + Number(bar.v), 0) / recent.length;
  const priorVolume = prior.length
    ? prior.reduce((sum, bar) => sum + Number(bar.v), 0) / prior.length
    : null;
  const ratio = priorVolume ? recentVolume / priorVolume : null;
  const recentUp = recent.filter(bar => Number(bar.c) >= Number(bar.o)).reduce((sum, bar) => sum + Number(bar.v), 0);
  const recentDown = recent.filter(bar => Number(bar.c) < Number(bar.o)).reduce((sum, bar) => sum + Number(bar.v), 0);
  const upDownRatio = recentDown > 0 ? recentUp / recentDown : recentUp > 0 ? 99 : 1;
  let state = 'NORMAL';
  if (ratio != null && ratio >= 2.2) state = 'SPIKE';
  else if (ratio != null && ratio <= 0.65) state = 'CONTRACTING';
  return { state, ratio, upDownRatio };
}

function nearbyLevel(price, levels, direction) {
  const source = Array.isArray(levels) ? levels : [];
  const matching = source
    .filter(level => finite(level.price) && (direction === 'support' ? Number(level.price) <= price : Number(level.price) >= price))
    .map(level => {
      const distancePct = Math.abs(pctDistance(price, level.price));
      const confirmations = Math.max(1, Number(level.confirmations) || 1);
      // A repeatedly observed level is more meaningful than a one-off pivot,
      // but proximity still dominates when choosing the actionable level.
      return { ...level, confirmations, distancePct, rank: distancePct - Math.min(confirmations, 4) * 0.08 };
    })
    .sort((a, b) => a.rank - b.rank);
  return matching[0] || null;
}

function buildTechnicalConfluence({
  price,
  dailyBars = [],
  intradayBars = [],
  indicators = {},
  levels = {},
  relVol = null,
  dayChangePct = null,
  market = {},
  newsCount = 0,
  timeframes = {},
  freshness = null,
} = {}) {
  const currentPrice = number(price);
  const bullishFactors = [];
  const bearishFactors = [];
  const notes = [];
  const missing = [];
  if (currentPrice == null) return { available: false, reason: 'Current price unavailable' };

  const timeframeResults = Object.fromEntries(
    Object.entries(timeframes).map(([key, bars]) => [key, trendForBars(bars)])
  );
  const requiredTimeframes = ['oneMinute', 'fiveMinute', 'fifteenMinute', 'hourly', 'daily'];
  const missingTimeframes = requiredTimeframes.filter(key =>
    !timeframeResults[key] || timeframeResults[key].state === 'UNAVAILABLE'
  );
  const addBull = (points, reason) => bullishFactors.push({ points, reason });
  const addBear = (points, reason) => bearishFactors.push({ points, reason });
  const daily = trendForBars(dailyBars, 9, 20);
  const intraday = trendForBars(intradayBars, 9, 20);
  const vwap = intradayVwapTrend(intradayBars);
  const volume = intradayVolume(intradayBars);
  const support = nearbyLevel(currentPrice, levels.support, 'support');
  const resistance = nearbyLevel(currentPrice, levels.resistance, 'resistance');
  const rsi14 = number(indicators.rsi14);
  const macd = indicators.macd || null;
  const ema9 = number(indicators.ema9);
  const ema20 = number(indicators.ema20);
  const sma50 = number(indicators.sma50);
  const sma200 = number(indicators.sma200);

  let bullish = 50;
  let bearish = 50;
  let bounce = 32;
  let drawdown = 32;

  // Higher-timeframe structure has more influence than a single intraday bar.
  if (daily.state === 'BULLISH') { bullish += 12; bearish -= 8; addBull(12, 'Daily price structure is above aligned 9/20 averages'); }
  else if (daily.state === 'BEARISH') { bearish += 12; bullish -= 8; addBear(12, 'Daily price structure is below aligned 9/20 averages'); }
  else missing.push('Daily moving-average alignment');

  if (intraday.state === 'BULLISH') { bullish += 8; bearish -= 5; addBull(8, '5-minute structure is aligned bullish'); }
  else if (intraday.state === 'BEARISH') { bearish += 8; bullish -= 5; addBear(8, '5-minute structure is aligned bearish'); }
  else missing.push('5-minute moving-average alignment');

  // Lower timeframes help with timing, while 15-minute/hourly bars validate that
  // the setup is not fighting the surrounding intraday structure.
  const alignmentFrames = ['oneMinute', 'fifteenMinute', 'hourly']
    .map(key => timeframeResults[key])
    .filter(frame => frame?.state && frame.state !== 'UNAVAILABLE');
  const bullishFrames = alignmentFrames.filter(frame => frame.state === 'BULLISH').length;
  const bearishFrames = alignmentFrames.filter(frame => frame.state === 'BEARISH').length;
  if (bullishFrames >= 2) { bullish += 6; addBull(6, 'Multiple intraday timeframes are aligned bullish'); }
  if (bearishFrames >= 2) { bearish += 6; addBear(6, 'Multiple intraday timeframes are aligned bearish'); }
  if (daily.state === 'BULLISH' && bearishFrames >= 2) {
    bullish -= 8; notes.push('Shorter timeframes conflict with the bullish daily structure');
  }
  if (daily.state === 'BEARISH' && bullishFrames >= 2) {
    bearish -= 8; notes.push('Shorter timeframes conflict with the bearish daily structure');
  }

  if (vwap.value == null) {
    missing.push('Intraday VWAP');
  } else if (currentPrice > vwap.value && vwap.slope === 'RISING') {
    bullish += 13; bearish -= 8; bounce += 5; addBull(13, 'Price is above a rising VWAP');
  } else if (currentPrice < vwap.value && vwap.slope === 'FALLING') {
    bearish += 13; bullish -= 8; drawdown += 6; addBear(13, 'Price is below a falling VWAP');
  } else if (vwap.reclaimed) {
    bullish += 9; bounce += 10; addBull(9, 'Price reclaimed VWAP');
  } else if (vwap.rejected) {
    bearish += 9; drawdown += 9; addBear(9, 'Price was rejected at VWAP');
  }

  if (rsi14 == null) {
    missing.push('RSI 14');
  } else if (rsi14 >= 55 && rsi14 < 72) {
    bullish += 7; addBull(7, `RSI ${rsi14.toFixed(0)} shows constructive momentum without an extreme reading`);
  } else if (rsi14 >= 75) {
    bearish += 7; drawdown += 8; addBear(7, `RSI ${rsi14.toFixed(0)} is in a potential exhaustion / take-profit zone`);
  } else if (rsi14 <= 30) {
    bounce += 7; notes.push(`RSI ${rsi14.toFixed(0)} is potentially oversold; this alone is not a buy signal`);
  } else if (rsi14 < 45) {
    bearish += 4; drawdown += 3; addBear(4, `RSI ${rsi14.toFixed(0)} shows weak momentum`);
  }

  if (ema9 != null && ema20 != null) {
    if (ema9 > ema20) { bullish += 6; addBull(6, '9 EMA is above 20 EMA'); }
    else if (ema9 < ema20) { bearish += 6; addBear(6, '9 EMA is below 20 EMA'); }
    const extension = Math.abs(pctDistance(currentPrice, ema9) || 0);
    if (extension >= 4) {
      if (currentPrice > ema9) { drawdown += 5; addBear(5, `Price is extended ${extension.toFixed(1)}% above the 9 EMA`); }
      else { bounce += 3; notes.push(`Price is extended ${extension.toFixed(1)}% below the 9 EMA`); }
    }
  } else missing.push('Short moving averages');

  if (sma50 != null && sma200 != null) {
    if (currentPrice > sma50 && currentPrice > sma200) { bullish += 5; addBull(5, 'Price is above the 50 and 200 SMA'); }
    else if (currentPrice < sma50 && currentPrice < sma200) { bearish += 5; addBear(5, 'Price is below the 50 and 200 SMA'); }
  } else missing.push('Long moving averages');

  if (macd?.value != null && macd?.signal != null) {
    if (Number(macd.value) > Number(macd.signal) && Number(macd.histogram) >= 0) {
      bullish += 6; addBull(6, 'MACD is above its signal with a non-negative histogram');
    } else if (Number(macd.value) < Number(macd.signal) && Number(macd.histogram) <= 0) {
      bearish += 6; addBear(6, 'MACD is below its signal with a non-positive histogram');
    }
  } else missing.push('MACD');

  if (volume.ratio != null) {
    if (volume.ratio >= 1.5 && volume.upDownRatio > 1.15) { bullish += 8; addBull(8, 'Recent buying volume is expanding'); }
    else if (volume.ratio >= 1.5 && volume.upDownRatio < 0.87) { bearish += 8; drawdown += 5; addBear(8, 'Recent selling volume is expanding'); }
    else if (volume.state === 'CONTRACTING') notes.push('Intraday volume is contracting; wait for expansion before treating a breakout as confirmed');
  } else missing.push('Intraday volume trend');

  if (finite(relVol)) {
    if (Number(relVol) >= 1.5 && Number(dayChangePct) > 0) { bullish += 5; addBull(5, `Daily relative volume is ${Number(relVol).toFixed(1)}× and confirms the advance`); }
    else if (Number(relVol) >= 1.5 && Number(dayChangePct) < 0) { bearish += 5; addBear(5, `Daily relative volume is ${Number(relVol).toFixed(1)}× and confirms the decline`); }
    else if (Number(relVol) < 0.8 && Math.abs(Number(dayChangePct) || 0) > 1) notes.push('Price move lacks daily relative-volume confirmation');
  } else missing.push('Daily relative volume');

  const nearSupport = support && support.distancePct <= 1;
  const nearResistance = resistance && resistance.distancePct <= 1.5;
  if (nearSupport) {
    if (rsi14 != null && rsi14 <= 40 && (vwap.reclaimed || intraday.state === 'BULLISH')) {
      bounce += 13; bullish += 5; addBull(5, `Confirmed response near ${support.label || 'support'} at $${Number(support.price).toFixed(2)}`);
    } else {
      notes.push(`Price is near ${support.label || 'support'} at $${Number(support.price).toFixed(2)}; confirmation is still required`);
    }
  }
  if (nearResistance) {
    if (rsi14 != null && rsi14 >= 65 && (vwap.rejected || intraday.state === 'BEARISH')) {
      drawdown += 13; bearish += 5; addBear(5, `Confirmed rejection risk near ${resistance.label || 'resistance'} at $${Number(resistance.price).toFixed(2)}`);
    } else {
      notes.push(`Price is near ${resistance.label || 'resistance'} at $${Number(resistance.price).toFixed(2)}; breakout volume is required`);
    }
  }

  const marketTrend = market.trend || 'NEUTRAL';
  const sectorTrend = market.sectorTrend || 'NEUTRAL';
  const stockVsSpy = finite(dayChangePct) && finite(market.spy) ? Number(dayChangePct) - Number(market.spy) : null;
  const stockVsSector = finite(dayChangePct) && finite(market.sectorChangePct) ? Number(dayChangePct) - Number(market.sectorChangePct) : null;
  if (stockVsSpy != null && stockVsSpy >= 1 && (stockVsSector == null || stockVsSector >= 0)) {
    bullish += 5; addBull(5, `Stock is outperforming SPY by ${stockVsSpy.toFixed(1)} points`);
  } else if (stockVsSpy != null && stockVsSpy <= -1 && (stockVsSector == null || stockVsSector <= 0)) {
    bearish += 5; addBear(5, `Stock is underperforming SPY by ${Math.abs(stockVsSpy).toFixed(1)} points`);
  }
  if (marketTrend === 'BEARISH' && daily.state !== 'BULLISH') { bearish += 4; drawdown += 4; addBear(4, 'Broad market regime is bearish'); }
  if (marketTrend === 'BULLISH' && sectorTrend !== 'BEARISH') { bullish += 4; addBull(4, 'Broad market regime supports risk-on setups'); }
  if (newsCount > 0) notes.push('Recent headlines are displayed as context; no direction was inferred without a verified catalyst classification');

  bullish = clamp(bullish);
  bearish = clamp(bearish);
  bounce = clamp(bounce + Math.max(0, bullish - bearish) * 0.18);
  drawdown = clamp(drawdown + Math.max(0, bearish - bullish) * 0.18);

  const criticalMissingInputs = [
    ...(intradayBars.length >= 15 ? [] : ['Sufficient 5-minute bars']),
    ...(vwap.value != null ? [] : ['Intraday VWAP']),
    ...(volume.ratio != null ? [] : ['Intraday volume trend']),
    ...(support?.price != null ? [] : ['Critical support / invalidation level']),
    ...missingTimeframes.map(key => `${key.replace(/([A-Z])/g, ' $1')} timeframe`),
  ];
  const requiredSources = ['quote', 'oneMinute', 'fiveMinute', 'fifteenMinute', 'hourly', 'daily'];
  const staleSources = requiredSources.filter(key => freshness?.[key]?.fresh !== true);
  criticalMissingInputs.push(...staleSources.map(key => `${key.replace(/([A-Z])/g, ' $1')} source stale or timestamp unavailable`));
  const entryEligible = criticalMissingInputs.length === 0;
  const bullCount = bullishFactors.length;
  const bearCount = bearishFactors.length;
  const edge = bullish - bearish;
  const lastTwoIntraday = intradayBars.slice(-2);
  const breakoutConfirmed = resistance?.price != null
    && lastTwoIntraday.length === 2
    && lastTwoIntraday.every(bar => number(bar?.c) > Number(resistance.price))
    && volume.ratio != null
    && volume.ratio >= 1.5
    && volume.state !== 'CONTRACTING';
  let stage = 'WATCH';
  let signal = 'NO CLEAR EDGE';
  if (!entryEligible) {
    signal = 'DATA INCOMPLETE — NO TRADE';
  } else if (bullish >= 68 && edge >= 12 && bullCount >= 5 && (!nearResistance || breakoutConfirmed)) {
    stage = 'CONFIRMED';
    signal = 'HIGH-PROBABILITY BULLISH SETUP';
  } else if (nearResistance && bullish >= 58 && edge >= 7 && bullCount >= 4) {
    stage = 'WATCH';
    signal = 'BULLISH STRUCTURE — RESISTANCE TEST';
  } else if (bullish >= 58 && edge >= 7 && bullCount >= 4) {
    stage = 'ENTRY CONFIRMATION';
    signal = 'MODERATE BULLISH SETUP';
  } else if (bearish >= 68 && -edge >= 12 && bearCount >= 4) {
    stage = nearSupport ? 'WATCH' : 'INVALIDATED';
    signal = 'HIGH-PROBABILITY BEARISH SETUP';
  } else if (bearish >= 58 && -edge >= 7) {
    stage = 'WATCH';
    signal = 'ELEVATED DRAWDOWN RISK';
  }

  const availableInputs = 9 - Math.min(missing.length, 9);
  const rawSetupQuality = 38 + Math.min(30, Math.abs(edge) * 1.2) + Math.min(20, Math.max(bullCount, bearCount) * 4) + availableInputs * 1.3;
  const setupQuality = entryEligible
    ? (nearResistance && !breakoutConfirmed ? Math.min(55, clamp(rawSetupQuality)) : clamp(rawSetupQuality))
    : Math.min(55, clamp(rawSetupQuality));
  const riskState = drawdown >= 68 ? 'ELEVATED' : drawdown >= 55 ? 'MODERATE' : 'CONTROLLED';
  const momentumState = rsi14 == null ? 'UNAVAILABLE'
    : rsi14 >= 75 ? 'EXTENDED'
      : rsi14 >= 60 ? 'STRONG BULLISH'
        : rsi14 >= 50 ? 'BULLISH DEVELOPING'
          : rsi14 >= 40 ? 'NEUTRAL'
            : rsi14 >= 30 ? 'WEAK / RECOVERY'
              : 'POTENTIALLY OVERSOLD';
  const volumeState = volume.state === 'UNAVAILABLE' ? 'UNAVAILABLE'
    : volume.state === 'SPIKE' && volume.upDownRatio > 1.15 ? 'BUYING VOLUME SPIKE'
      : volume.state === 'SPIKE' && volume.upDownRatio < 0.87 ? 'SELLING VOLUME SPIKE'
        : volume.state;
  const trend = daily.state === 'UNAVAILABLE' ? intraday.state : daily.state;

  const atr = number(indicators.atr);
  const invalidation = support?.price != null
    ? Number(support.price) - (atr || currentPrice * 0.015) * 0.35
    : null;
  const target1 = resistance?.price ?? (atr ? currentPrice + atr : null);
  const target2 = atr && target1 ? Math.max(Number(target1), currentPrice + atr * 2) : null;
  const risk = invalidation != null ? currentPrice - invalidation : null;
  const reward = target1 != null ? Number(target1) - currentPrice : null;
  const riskReward = risk && reward && risk > 0 ? reward / risk : null;

  return {
    available: true,
    scores: { bullish, bearish, bounce, drawdown, setupQuality },
    states: {
      trend,
      momentum: momentumState,
      volume: volumeState,
      risk: riskState,
      marketRegime: marketTrend,
      relativeStrength: stockVsSpy == null ? 'UNAVAILABLE' : stockVsSpy >= 1 ? 'STRONG' : stockVsSpy <= -1 ? 'WEAK' : 'NEUTRAL',
    },
    signal: {
      label: signal,
      stage,
      breakoutConfirmed,
      confluence: Math.max(bullCount, bearCount) >= 5 ? 'HIGH CONFLUENCE' : Math.max(bullCount, bearCount) >= 3 ? 'MULTIPLE CONFIRMATIONS' : 'SINGLE / MIXED SIGNAL',
    },
    levels: {
      criticalSupport: support ? { ...support, distancePct: +support.distancePct.toFixed(2) } : null,
      criticalResistance: resistance ? { ...resistance, distancePct: +resistance.distancePct.toFixed(2) } : null,
    },
    tradePlan: {
      entryZone: support?.price ?? (vwap.value != null ? +vwap.value.toFixed(2) : null),
      confirmation: resistance?.price ?? null,
      invalidation: invalidation == null ? null : +invalidation.toFixed(2),
      target1: target1 == null ? null : +Number(target1).toFixed(2),
      target2: target2 == null ? null : +Number(target2).toFixed(2),
      riskReward: riskReward == null ? null : +riskReward.toFixed(2),
    },
    vwap: { value: vwap.value == null ? null : +vwap.value.toFixed(2), slope: vwap.slope, reclaimed: vwap.reclaimed, rejected: vwap.rejected },
    timeframes: timeframeResults,
    dataQuality: {
      entryEligible,
      fresh: freshness ? staleSources.length === 0 : false,
      missingCriticalInputs: [...new Set(criticalMissingInputs)],
      sourceFreshness: freshness || null,
    },
    audit: { bullishFactors, bearishFactors, notes, missingInputs: [...new Set(missing)] },
  };
}

module.exports = { buildTechnicalConfluence };