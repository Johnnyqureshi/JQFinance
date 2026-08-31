'use strict';

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (const item of values.slice(period)) value = item * multiplier + value * (1 - multiplier);
  return value;
}

function evaluateBenchmark(symbol, bars, now = new Date()) {
  const bucketStart = Math.floor(now.getTime() / 300000) * 300000;
  const completed = (Array.isArray(bars) ? bars : [])
    .filter(bar => Number.isFinite(Date.parse(bar?.t)) && Date.parse(bar.t) < bucketStart)
    .filter(bar => [bar?.o, bar?.h, bar?.l, bar?.c, bar?.v].every(Number.isFinite))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (completed.length < 9) {
    return { symbol, available: false, dropping: false, reason: 'At least 9 completed 5-minute bars are required.' };
  }
  const latest = completed[completed.length - 1];
  const ageMs = now.getTime() - (Date.parse(latest.t) + 300000);
  // Match Momentum's structural-entry freshness contract: once a completed
  // five-minute bar is more than two minutes old, fail closed until the broker
  // supplies the next completion.
  if (ageMs < 0 || ageMs > 2 * 60 * 1000) {
    return { symbol, available: false, dropping: false, reason: 'Latest completed 5-minute bar is stale.' };
  }
  const firstOpen = completed[0].o;
  const changePct = firstOpen > 0 ? (latest.c - firstOpen) / firstOpen * 100 : null;
  const volume = completed.reduce((sum, bar) => sum + bar.v, 0);
  const vwap = volume > 0
    ? completed.reduce((sum, bar) => sum + ((bar.h + bar.l + bar.c) / 3) * bar.v, 0) / volume
    : null;
  const ema9 = ema(completed.map(bar => bar.c), 9);
  const dropping = Number.isFinite(changePct) && changePct <= -0.5
    && Number.isFinite(vwap) && latest.c < vwap
    && Number.isFinite(ema9) && latest.c < ema9;
  return {
    symbol,
    available: true,
    dropping,
    changePct: +changePct.toFixed(3),
    price: latest.c,
    vwap: +vwap.toFixed(4),
    ema9: +ema9.toFixed(4),
    latestCompletedAt: new Date(Date.parse(latest.t) + 300000).toISOString(),
    reason: dropping
      ? `${symbol} is down at least 0.5% intraday and below VWAP and EMA(9).`
      : `${symbol} does not meet every downside confirmation.`,
  };
}

function evaluateMarketDirection(benchmarkBars, now = new Date()) {
  const benchmarks = ['SPY', 'QQQ'].map(symbol =>
    evaluateBenchmark(symbol, benchmarkBars?.[symbol], now)
  );
  const available = benchmarks.every(item => item.available);
  const dropping = available && benchmarks.every(item => item.dropping);
  const weakest = benchmarks.slice().sort((a, b) => (a.changePct ?? Infinity) - (b.changePct ?? Infinity))[0];
  return {
    available,
    direction: dropping ? 'DROPPING' : available ? 'NOT_DROPPING' : 'UNAVAILABLE',
    dropping,
    inverseMode: dropping,
    inverseSymbol: dropping && weakest?.symbol === 'QQQ' ? 'QID' : dropping ? 'SH' : null,
    benchmarks,
    checkedAt: now.toISOString(),
    reason: dropping
      ? 'SPY and QQQ are both down at least 0.5% intraday and below VWAP and EMA(9) on fresh completed 5-minute bars.'
      : available
        ? 'The broad market does not meet every downside confirmation.'
        : 'Fresh completed SPY and QQQ evidence is unavailable.',
  };
}

function canUseInverseFallback({
  scannedSymbols = 0,
  completedQuotes = 0,
  quoteFailures = 0,
  shortlisted = 0,
  completedCandidates = 0,
  candidateFailures = 0,
  eligibleLongs = 0,
} = {}) {
  if (!(scannedSymbols > 0)) {
    return { allowed: false, reason: 'No ordinary-long symbols were available to evaluate.' };
  }
  if (quoteFailures > 0 || completedQuotes !== scannedSymbols) {
    return { allowed: false, reason: 'Ordinary-long quote coverage was incomplete.' };
  }
  if (candidateFailures > 0 || completedCandidates !== shortlisted) {
    return { allowed: false, reason: 'Ordinary-long safety evaluation was incomplete.' };
  }
  if (eligibleLongs > 0) {
    return { allowed: false, reason: 'At least one safe ordinary-long candidate passed.' };
  }
  return { allowed: true, reason: 'The bounded ordinary-long scan completed and no safe long passed.' };
}

function hasCompleteMomentumQuote(quote) {
  const presentFinite = value =>
    value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
    && Number.isFinite(Number(value));
  const averageVolumeRaw = quote?.averageDailyVolume3Month ?? quote?.averageDailyVolume10Day;
  return presentFinite(quote?.regularMarketPrice)
    && Number(quote.regularMarketPrice) > 0
    && presentFinite(quote?.regularMarketChangePercent)
    && presentFinite(quote?.regularMarketVolume)
    && Number(quote.regularMarketVolume) >= 0
    && presentFinite(averageVolumeRaw)
    && Number(averageVolumeRaw) > 0;
}

module.exports = {
  ema,
  evaluateBenchmark,
  evaluateMarketDirection,
  canUseInverseFallback,
  hasCompleteMomentumQuote,
};