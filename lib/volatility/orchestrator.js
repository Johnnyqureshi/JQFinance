'use strict';
const { acquireMarketData } = require('./data-provider');
const c = require('./calculations');
const marketCache = { value: null, at: 0, pending: null }, symbolCache = new Map();
const ttl = () => Number(process.env.VOLATILITY_CACHE_MS || 30000);
const staleMs = () => Number(process.env.VOLATILITY_STALE_MS || 96 * 60 * 60 * 1000);
async function marketSnapshot() {
  if (marketCache.value && Date.now() - marketCache.at < ttl()) return marketCache.value;
  if (marketCache.pending) return marketCache.pending;
  marketCache.pending = acquireMarketData().then(x => { marketCache.value = x; marketCache.at = Date.now(); return x; }).catch(error => ({ status: 'UNAVAILABLE', source: null, timestamp: new Date().toISOString(), error: error.message })).finally(() => { marketCache.pending = null; });
  return marketCache.pending;
}
function unavailable(error) {
  return {
    enabled: true, available: false, status: 'UNAVAILABLE', completeness: 0,
    generatedAt: new Date().toISOString(), timestamp: null, source: null, ageMs: null,
    error: error || null, dataQuality: { completeness: 0, status: 'UNAVAILABLE', missing: ['VIX history'] },
    market: null, stock: null, modeled: null, scores: null,
  };
}
function percent(value) { return Number.isFinite(value) ? value * 100 : null; }
function structureView(term) {
  const slope = term?.normalizedSlopes?.vix3mToVix;
  return {
    state: term?.classification || null,
    score: slope == null ? null : Math.round(c.clamp(50 - slope * 250)),
    spotTo3mPct: slope == null ? null : slope * 100,
    levels: term?.levels || null,
    spreads: term?.spreads || null,
    normalizedSlopes: term?.normalizedSlopes || null,
  };
}
async function buildVolatilitySnapshot({ symbol, price, dailyBars, spyDailyBars, optionChain = null, marketOptionChain = null, ivHistory = null } = {}) {
  try {
    const key = String(symbol || ''); const cached = symbolCache.get(key);
    if (cached && Date.now() - cached.at < ttl()) return cached.value;
    const raw = await marketSnapshot(), h = raw.histories || {}, market = c.vixMetrics(h.vix || []);
    const levels = Object.fromEntries(['vix','vix9d','vix3m','vix6m','vix1y'].map(k => [k, h[k]?.at(-1)?.c ?? null]));
    const chain = Array.isArray(optionChain) ? optionChain : [];
    const marketChain = Array.isArray(marketOptionChain) && marketOptionChain.length ? marketOptionChain : chain;
    const optionIv = c.currentOptionIv(chain, price);
    const currentIv = optionIv.iv;
    const marketSpot = h.spy?.at(-1)?.c ?? price;
    const gamma = c.gammaExposure(marketChain, marketSpot), flip = c.gammaFlip(marketChain, marketSpot);
    const stockRvs = Object.fromEntries([20,30,60].map(p => [p, c.realizedVol(dailyBars, p)]));
    const stress = [market.vixPercentile252, market.vix1dChange == null ? null : c.clamp(50 + market.vix1dChange * 8), gamma.netGamma == null ? null : gamma.netGamma < 0 ? 70 : 30].filter(Number.isFinite);
    const completeness = stress.length / 3;
    const sourceAgeMs = raw.timestamp ? Math.max(0, Date.now() - Date.parse(raw.timestamp)) : null;
    const stale = sourceAgeMs == null || sourceAgeMs > staleMs();
    const beta = c.betaCorrelation(dailyBars, spyDailyBars);
    const iv = c.ivRank(currentIv, ivHistory);
    const move = c.expectedMove(price, currentIv, optionIv.dte);
    const term = c.termStructure(levels);
    const gammaScore = gamma.netGamma == null ? null : gamma.netGamma < 0 ? 25 : 75;
    const regimeScore = stress.length ? Math.round(stress.reduce((a,b) => a+b,0)/stress.length) : null;
    const shockScore = market.vix1dChange == null ? null : Math.round(c.clamp(50 + market.vix1dChange * 8));
    const relativeVolatilityScore = stockRvs[20] == null || market.realizedVol?.[20] == null
      ? null : Math.round(c.clamp(50 + (stockRvs[20] - market.realizedVol[20]) * 100));
    const modeledInputs = [currentIv, stockRvs[20], market.vixLevel == null ? null : market.vixLevel / 100].filter(Number.isFinite);
    const modeledVolatility = modeledInputs.length ? modeledInputs.reduce((sum, value) => sum + value, 0) / modeledInputs.length : null;
    const missing = [
      !h.vix?.length && 'VIX history',
      !h.vvix?.length && 'VVIX history',
      term.classification == null && 'VIX term structure',
      !chain.length && `${symbol} options`,
      !marketOptionChain?.length && 'SPY options gamma',
      !Array.isArray(ivHistory) && 'historical IV',
    ].filter(Boolean);
    const value = {
      enabled: true,
      available: raw.status !== 'UNAVAILABLE' && !!h.vix?.length,
      status: raw.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : stale ? 'STALE_FALLBACK' : raw.status,
      source: raw.source,
      generatedAt: raw.generatedAt || new Date().toISOString(),
      timestamp: raw.timestamp,
      ageMs: sourceAgeMs,
      completeness,
      dataQuality: {
        completeness: Math.round(completeness * 100),
        status: stale ? 'STALE' : raw.status,
        missing,
        sourceTimestamp: raw.timestamp,
        sourceAgeMs,
        synchronizedAt: raw.generatedAt || null,
        officialProviderError: raw.officialProviderError || null,
      },
      market: {
        vix: {
          level: market.vixLevel, change1d: market.vix1dChange, change5d: market.vix5dChange,
          change20d: market.vix20dChange, percentile252: market.vixPercentile252,
          percentile63: market.vixPercentile63, zScore252: market.vixZScore252,
          distanceFrom20DMA: market.vixDistanceFrom20DMA,
          distanceFrom50DMA: market.vixDistanceFrom50DMA,
          distanceFrom200DMA: market.vixDistanceFrom200DMA,
          classification: market.classification,
          realizedVol5: percent(market.realizedVol?.[5]), realizedVol10: percent(market.realizedVol?.[10]),
          realizedVol20: percent(market.realizedVol?.[20]), realizedVol30: percent(market.realizedVol?.[30]),
          realizedVol60: percent(market.realizedVol?.[60]),
        },
        vvix: { level: h.vvix?.at(-1)?.c ?? null, percentile: c.percentile(h.vvix?.at(-1)?.c, (h.vvix || []).slice(-252).map(row => row.c)) },
        termStructure: structureView(term),
        futuresCurve: { state: null, score: null, status: 'UNAVAILABLE', reason: 'Futures curve not supplied by active provider' },
        spxIvTermStructure: { state: null, slope: null, status: 'UNAVAILABLE', reason: 'SPX IV term structure not supplied by active provider' },
        gamma: {
          ...gamma, gammaFlip: flip,
          distanceToGammaFlipPercent: flip && marketSpot ? ((marketSpot - flip) / marketSpot) * 100 : null,
          regime: gamma.netGamma == null ? null : gamma.netGamma < 0 ? 'NEGATIVE' : 'POSITIVE',
          proxy: marketOptionChain?.length ? 'SPY' : symbol,
        },
      },
      stock: {
        realizedVol20: percent(stockRvs[20]), realizedVol30: percent(stockRvs[30]), realizedVol60: percent(stockRvs[60]),
        atrPercentile: c.atrPercentile(dailyBars), beta: beta.beta, correlationSpy: beta.correlation,
        relativeVolatilityScore, currentIv: percent(iv.currentIV), ivRank: iv.ivRank, ivPercentile: iv.ivPercentile,
        expectedMove: move?.amount ?? null, expectedMovePercent: move?.percent ?? null,
        expectedRangeLow: move?.lower ?? null, expectedRangeHigh: move?.upper ?? null,
      },
      modeled: {
        volatility: percent(modeledVolatility),
        percentile: modeledVolatility == null ? null : c.percentile(modeledVolatility, [stockRvs[20], stockRvs[30], stockRvs[60]].filter(Number.isFinite)),
        trend: stockRvs[20] == null || stockRvs[60] == null ? null : stockRvs[20] > stockRvs[60] ? 'RISING' : 'FALLING',
        confidence: Math.round(completeness * 100),
      },
      scores: { regime: regimeScore, shock: shockScore, gamma: gammaScore, volatilityRegime: regimeScore },
    };
    symbolCache.set(key, { at: Date.now(), value }); return value;
  } catch (error) { return unavailable(error.message); }
}
module.exports = { buildVolatilitySnapshot, marketSnapshot };