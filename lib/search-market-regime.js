'use strict';

const { completedDailyBars } = require('./search-levels');

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value)));
const finite = value => value !== null
  && value !== undefined
  && !(typeof value === 'string' && value.trim() === '')
  && Number.isFinite(Number(value));
const number = value => finite(value) ? Number(value) : null;

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function movingAverage(values, period) {
  return values.length >= period ? average(values.slice(-period)) : null;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + (change >= 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function macdHistogram(values) {
  if (values.length < 35) return null;
  const ema = (period) => {
    const seed = average(values.slice(0, period));
    if (seed == null) return null;
    const series = [seed];
    const multiplier = 2 / (period + 1);
    for (let index = period; index < values.length; index += 1) {
      series.push(values[index] * multiplier + series.at(-1) * (1 - multiplier));
    }
    return series;
  };
  const fast = ema(12);
  const slow = ema(26);
  if (!fast || !slow) return null;
  const macd = slow.map((value, index) => fast[index + 14] - value);
  const signalSeed = average(macd.slice(0, 9));
  if (signalSeed == null) return null;
  let signal = signalSeed;
  const multiplier = 2 / 10;
  for (let index = 9; index < macd.length; index += 1) {
    signal = macd[index] * multiplier + signal * (1 - multiplier);
  }
  return macd.at(-1) - signal;
}

function returnPct(closes, lookback) {
  if (closes.length <= lookback) return null;
  const start = closes.at(-1 - lookback);
  const end = closes.at(-1);
  return start > 0 ? ((end - start) / start) * 100 : null;
}

function normalizeBars(dailyBars, { nowMs = Date.now(), marketState = 'CLOSED' } = {}) {
  return completedDailyBars(dailyBars, { nowMs, marketState })
    .filter(bar => [bar?.o, bar?.h, bar?.l, bar?.c].every(finite))
    .map(bar => ({
      ...bar,
      o: Number(bar.o),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
      v: finite(bar.v) ? Number(bar.v) : null,
    }));
}

function classifySearchMarketRegime({ quote, dailyBars, marketState, nowMs = Date.now() } = {}) {
  const bars = normalizeBars(dailyBars, { nowMs, marketState });
  const price = number(quote?.regularMarketPrice ?? quote?.price);
  if (price == null || price <= 0 || bars.length < 20) {
    return {
      available: false,
      regime: 'UNAVAILABLE',
      direction: null,
      score: null,
      confidence: 0,
      price,
      changePct: number(quote?.regularMarketChangePercent),
      asOf: bars.at(-1)?.t || quote?.regularMarketTime || null,
      evidence: [],
      missing: ['SPY price and sufficient completed daily history'],
    };
  }

  const closes = bars.map(bar => bar.c);
  const values = {
    ema9: movingAverage(closes, 9),
    ema20: movingAverage(closes, 20),
    sma50: movingAverage(closes, 50),
    sma200: movingAverage(closes, 200),
    rsi14: rsi(closes),
    macdHistogram: macdHistogram(closes),
    return5: returnPct(closes, 5),
    return20: returnPct(closes, 20),
    changePct: number(quote?.regularMarketChangePercent),
  };
  const evidence = [];
  const compare = (label, left, right) => {
    if (!finite(left) || !finite(right)) return;
    const direction = Number(left) > Number(right) ? 'BULLISH' : Number(left) < Number(right) ? 'BEARISH' : 'NEUTRAL';
    evidence.push({ label, direction, value: Number(left), reference: Number(right) });
  };
  compare('Price vs EMA 20', price, values.ema20);
  compare('Price vs SMA 50', price, values.sma50);
  compare('Price vs SMA 200', price, values.sma200);
  compare('EMA 9 vs EMA 20', values.ema9, values.ema20);
  compare('EMA 20 vs SMA 50', values.ema20, values.sma50);
  compare('SMA 50 vs SMA 200', values.sma50, values.sma200);

  if (finite(values.rsi14)) {
    evidence.push({
      label: 'RSI 14',
      direction: values.rsi14 >= 55 ? 'BULLISH' : values.rsi14 <= 45 ? 'BEARISH' : 'NEUTRAL',
      value: values.rsi14,
    });
  }
  if (finite(values.macdHistogram)) {
    evidence.push({
      label: 'MACD histogram',
      direction: values.macdHistogram > 0 ? 'BULLISH' : values.macdHistogram < 0 ? 'BEARISH' : 'NEUTRAL',
      value: values.macdHistogram,
    });
  }
  if (finite(values.return5)) {
    evidence.push({
      label: '5-session return',
      direction: values.return5 > 0.75 ? 'BULLISH' : values.return5 < -0.75 ? 'BEARISH' : 'NEUTRAL',
      value: values.return5,
    });
  }
  if (finite(values.return20)) {
    evidence.push({
      label: '20-session return',
      direction: values.return20 > 1.5 ? 'BULLISH' : values.return20 < -1.5 ? 'BEARISH' : 'NEUTRAL',
      value: values.return20,
    });
  }
  if (finite(values.changePct)) {
    evidence.push({
      label: 'Current session change',
      direction: values.changePct > 0.3 ? 'BULLISH' : values.changePct < -0.3 ? 'BEARISH' : 'NEUTRAL',
      value: values.changePct,
    });
  }

  const bullish = evidence.filter(item => item.direction === 'BULLISH').length;
  const bearish = evidence.filter(item => item.direction === 'BEARISH').length;
  const directional = bullish + bearish;
  if (evidence.length < 4 || directional === 0) {
    return {
      available: false,
      regime: 'UNAVAILABLE',
      direction: null,
      score: null,
      confidence: Math.round((evidence.length / 10) * 100),
      price,
      changePct: values.changePct,
      asOf: bars.at(-1)?.t || null,
      evidence,
      missing: ['Directional SPY evidence'],
    };
  }

  const score = clamp(50 + ((bullish - bearish) / evidence.length) * 50);
  const regime = score >= 72 ? 'STRONG BULLISH'
    : score >= 58 ? 'BULLISH'
      : score <= 28 ? 'STRONG BEARISH'
        : score <= 42 ? 'BEARISH'
          : 'NEUTRAL';
  return {
    available: true,
    regime,
    direction: regime.includes('BULLISH') ? 'BULLISH' : regime.includes('BEARISH') ? 'BEARISH' : 'NEUTRAL',
    score: Math.round(score),
    confidence: Math.round((evidence.length / 10) * 100),
    price,
    changePct: values.changePct,
    asOf: bars.at(-1)?.t || null,
    indicators: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, finite(value) ? +Number(value).toFixed(3) : null])),
    evidence,
    missing: [],
  };
}

function classifySector({ trend, changePct, etf } = {}) {
  const direction = String(trend || '').toUpperCase();
  if (!['BULLISH', 'BEARISH', 'NEUTRAL'].includes(direction) || !finite(changePct)) {
    return { label: 'UNAVAILABLE', direction: null, changePct: null, etf: etf || null };
  }
  return {
    label: direction,
    direction,
    changePct: +Number(changePct).toFixed(2),
    etf: etf || null,
  };
}

function classifyRelativeStrength({
  stockDailyBars,
  spyDailyBars,
  stockMarketState,
  spyMarketState,
  stockSignal,
  nowMs = Date.now(),
} = {}) {
  const stockBars = normalizeBars(stockDailyBars, { nowMs, marketState: stockMarketState });
  const spyBars = normalizeBars(spyDailyBars, { nowMs, marketState: spyMarketState });
  const stockCloses = stockBars.map(bar => bar.c);
  const spyCloses = spyBars.map(bar => bar.c);
  const stock5 = returnPct(stockCloses, 5);
  const spy5 = returnPct(spyCloses, 5);
  const stock20 = returnPct(stockCloses, 20);
  const spy20 = returnPct(spyCloses, 20);
  const vs5 = finite(stock5) && finite(spy5) ? stock5 - spy5 : null;
  const vs20 = finite(stock20) && finite(spy20) ? stock20 - spy20 : null;
  if (vs5 == null && vs20 == null) {
    return { label: 'UNAVAILABLE', score: 0, vs5: null, vs20: null, evidence: 'Stock/SPY return comparison unavailable' };
  }

  const higherLows = stockSignal?.structure?.higherLows === true;
  const bullishVolume = Number(stockSignal?.bullishVolumeScore) >= 55;
  const confirmed = stockSignal?.signal?.stage === 'CONFIRMED';
  const strong = (finite(vs5) && vs5 >= 2 && finite(vs20) && vs20 >= 0)
    || (finite(vs5) && vs5 >= 3 && (higherLows || bullishVolume || confirmed));
  const weak = (finite(vs5) && vs5 <= -2 && finite(vs20) && vs20 <= 0)
    || (finite(vs5) && vs5 <= -3);
  const moderate = !weak && !strong && ((finite(vs5) && vs5 >= 1) || (finite(vs20) && vs20 >= 1));
  return {
    label: strong ? 'STRONG' : weak ? 'WEAK' : moderate ? 'MODERATE' : 'NEUTRAL',
    score: strong ? 10 : weak ? -10 : moderate ? 5 : 0,
    vs5: finite(vs5) ? +vs5.toFixed(2) : null,
    vs20: finite(vs20) ? +vs20.toFixed(2) : null,
    evidence: strong
      ? 'Multi-session outperformance versus SPY'
      : weak
        ? 'Multi-session underperformance versus SPY'
        : moderate
          ? 'Moderate outperformance versus SPY'
          : 'No meaningful multi-session relative-strength edge',
  };
}

function sensitivityFromProfile(symbol, quote, profile) {
  const assetText = [
    symbol,
    quote?.shortName,
    profile?.assetProfile?.industry,
    profile?.assetProfile?.longBusinessSummary,
  ].filter(Boolean).join(' ');
  const beta = number(quote?.beta ?? profile?.assetProfile?.beta);
  return {
    high: (beta != null && beta >= 1.3)
      || /\b(?:bitcoin|crypto|cryptocurrency|leveraged|2x|3x|inverse)\b/i.test(assetText),
    beta,
    reason: beta != null && beta >= 1.3
      ? `Beta ${beta.toFixed(2)} indicates elevated market sensitivity`
      : /\b(?:bitcoin|crypto|cryptocurrency|leveraged|2x|3x|inverse)\b/i.test(assetText)
        ? 'Asset profile indicates elevated market sensitivity'
        : null,
  };
}

function alignmentFor(stockDirection, marketDirection) {
  if (!stockDirection || !marketDirection || marketDirection === 'NEUTRAL') return 'NEUTRAL';
  return stockDirection === marketDirection ? marketDirection : (marketDirection === 'BULLISH' ? 'BULLISH' : 'BEARISH');
}

function applySearchMarketRegime({
  searchSignal,
  spyRegime,
  sector,
  relativeStrength,
  sensitivity,
} = {}) {
  const base = searchSignal || {};
  const baseSignal = base.signal || {};
  const technicalDirection = String(baseSignal.direction || '').toUpperCase();
  const technicalConfidence = finite(base.confidence) ? Number(base.confidence) : 0;
  const marketAvailable = spyRegime?.available === true;
  const marketDirection = spyRegime?.direction || null;
  const marketRegime = spyRegime?.regime || 'UNAVAILABLE';
  const sectorDirection = sector?.direction || null;
  const aligned = marketAvailable && marketDirection && technicalDirection === marketDirection;
  const marketScore = !marketAvailable ? 0
    : aligned
      ? marketRegime.includes('STRONG') ? 20 : 10
      : marketRegime.includes('STRONG')
        ? (sensitivity?.high ? -25 : -20)
        : (sensitivity?.high ? -18 : -12);
  const sectorScore = sectorDirection === technicalDirection ? 10 : sectorDirection && sectorDirection !== 'NEUTRAL' ? -10 : 0;
  const relativeScore = relativeStrength?.score || 0;
  const qualityCap = base.dataQuality?.volumeBaselineAvailable === false ? 35 : 100;
  const adjustedConfidence = Math.round(clamp(technicalConfidence + marketScore + sectorScore + relativeScore, 0, qualityCap));
  const conflict = marketAvailable && technicalDirection && marketDirection
    && technicalDirection !== marketDirection && marketDirection !== 'NEUTRAL';
  const marketState = marketAvailable
    ? (conflict ? 'COUNTER-TREND' : aligned ? 'ALIGNED' : 'NEUTRAL')
    : 'UNAVAILABLE';
  const marketAlignment = marketAvailable
    ? alignmentFor(technicalDirection, marketDirection)
    : 'UNAVAILABLE';
  const reasons = [
    ...(Array.isArray(base.reasons) ? base.reasons : []),
    marketAvailable
      ? `SPY market context: ${marketRegime.toLowerCase()}`
      : null,
    relativeStrength?.evidence,
  ].filter(Boolean);

  return {
    ...base,
    signal: {
      ...baseSignal,
      label: baseSignal.label || (technicalDirection === 'BEARISH' ? 'SELL' : 'BUY'),
    },
    confidence: adjustedConfidence,
    baseConfidence: technicalConfidence,
    confidenceBreakdown: {
      ...(base.confidenceBreakdown || {}),
      technicalSetup: technicalConfidence,
      marketAlignment: marketScore,
      sectorAlignment: sectorScore,
      relativeStrength: relativeScore,
      overall: adjustedConfidence,
    },
    marketContext: {
      spy: spyRegime,
      marketAlignment: { label: marketAlignment, state: marketState, score: marketScore },
      sector: sector || { label: 'UNAVAILABLE', direction: null },
      relativeStrength: relativeStrength || { label: 'UNAVAILABLE', score: 0 },
      sensitivity: sensitivity || { high: false },
      finalSignal: baseSignal.label || (technicalDirection === 'BEARISH' ? 'SELL' : 'BUY'),
    },
    reasons: [...new Set(reasons)],
    dataQuality: {
      ...(base.dataQuality || {}),
      marketContextAvailable: marketAvailable,
      marketContextMissing: spyRegime?.missing || [],
    },
  };
}

function buildSearchMarketContext({
  symbol,
  quote,
  stockQuote,
  spyDailyBars,
  stockDailyBars,
  stockMarketState,
  spyMarketState,
  stockSignal,
  sectorTrend,
  sectorChangePct,
  sectorEtf,
  profile,
  nowMs = Date.now(),
} = {}) {
  const spyRegime = classifySearchMarketRegime({
    quote,
    dailyBars: spyDailyBars,
    marketState: spyMarketState,
    nowMs,
  });
  const sector = classifySector({ trend: sectorTrend, changePct: sectorChangePct, etf: sectorEtf });
  const relativeStrength = classifyRelativeStrength({
    stockDailyBars,
    spyDailyBars,
    stockMarketState,
    spyMarketState,
    stockSignal,
    nowMs,
  });
  const sensitivity = sensitivityFromProfile(symbol, stockQuote, profile);
  return { spy: spyRegime, sector, relativeStrength, sensitivity };
}

module.exports = {
  applySearchMarketRegime,
  buildSearchMarketContext,
  classifySearchMarketRegime,
  classifyRelativeStrength,
};