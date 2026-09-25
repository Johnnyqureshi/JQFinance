'use strict';

const TOPICS = [
  { id: 'fed', label: 'Federal Reserve & rates', terms: ['fed', 'fomc', 'federal reserve', 'interest rate', 'interest rates', 'rate cut', 'rate hike'] },
  { id: 'inflation', label: 'Inflation', terms: ['inflation', 'cpi', 'ppi', 'prices'] },
  { id: 'jobs', label: 'Jobs & unemployment', terms: ['jobs', 'payroll', 'unemployment', 'labor market'] },
  { id: 'recession', label: 'Recession & growth', terms: ['recession', 'gdp', 'economic growth', 'slowdown'] },
  { id: 'energy', label: 'Oil & energy', terms: ['oil', 'crude', 'brent', 'gasoline', 'natural gas', 'energy'] },
  { id: 'tariffs', label: 'Tariffs & trade', terms: ['tariff', 'tariffs', 'trade war', 'trade policy'] },
  { id: 'geopolitical', label: 'Geopolitical risk', terms: ['war', 'geopolitical', 'middle east', 'conflict', 'sanctions'] },
  { id: 'crypto', label: 'Crypto markets', terms: ['btc', 'bitcoin', 'crypto', 'ethereum', 'eth'] },
];

const MARKET_TERM_EXPANSIONS = {
  fed: ['fed', 'fomc', 'federal reserve', 'interest rate', 'rate cut', 'rate hike', 'fed funds'],
  inflation: ['inflation', 'cpi', 'consumer price', 'ppi'],
  jobs: ['unemployment', 'payroll', 'jobs report', 'jobless claims'],
  recession: ['recession', 'gdp', 'economic growth'],
  energy: ['oil', 'crude', 'brent', 'gasoline', 'natural gas'],
  tariffs: ['tariff', 'trade war', 'trade policy'],
  geopolitical: ['geopolitical', 'war', 'conflict', 'sanctions'],
  crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto'],
};

const COMPANY_TERMS = {
  NVDA: ['nvidia', 'nvda'],
  SMCI: ['super micro', 'smci'],
  SNDK: ['sandisk', 'sndk'],
  SPY: ['s&p 500', 's&p', 'spy'],
  QQQ: ['nasdaq', 'qqq'],
  BTC: ['bitcoin', 'btc', 'crypto'],
  'BTC-USD': ['bitcoin', 'btc', 'crypto'],
};

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'be', 'bullish', 'bearish', 'does', 'for', 'how',
  'is', 'it', 'likely', 'market', 'markets', 'of', 'or', 'the', 'this', 'to',
  'what', 'why', 'will',
]);

function cleanQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

function classifySearchQuery(value) {
  const query = cleanQuery(value);
  const lower = query.toLowerCase();
  const topics = TOPICS.filter(topic => topic.terms.some(term => lower.includes(term)));
  const upperTokens = query.match(/\b[A-Z]{1,5}\b/g) || [];
  const explicitSymbol = upperTokens.find(token => !['FED', 'CPI', 'PPI', 'GDP'].includes(token))
    || (/\bbitcoin\b|\bbtc\b/i.test(query) ? 'BTC-USD' : null);
  const simpleTicker = /^[A-Za-z][A-Za-z.-]{0,9}$/.test(query) && !topics.length
    ? query.toUpperCase()
    : null;
  return {
    query,
    type: topics.length ? (explicitSymbol ? 'ASSET_MACRO' : 'MACRO') : 'ASSET',
    symbol: explicitSymbol || simpleTicker,
    topics: topics.map(topic => ({ id: topic.id, label: topic.label })),
    primaryTopic: topics[0]?.id || null,
  };
}

function queryTerms(value, classification = classifySearchQuery(value)) {
  const raw = cleanQuery(value).toLowerCase().split(/[^a-z0-9&.-]+/)
    .filter(term => term.length > 2 && !STOPWORDS.has(term));
  const expanded = classification.topics.flatMap(topic => MARKET_TERM_EXPANSIONS[topic.id] || []);
  const companies = COMPANY_TERMS[classification.symbol] || [];
  return [...new Set([...raw, ...expanded, ...companies])];
}

function decimal(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function centsFromDollars(value) {
  const number = decimal(value);
  return number == null ? null : Math.round(number * 10000) / 100;
}

function normalizeKalshiMarket(market) {
  if (!market?.ticker || !market?.title) return null;
  const bid = centsFromDollars(market.yes_bid_dollars);
  const ask = centsFromDollars(market.yes_ask_dollars);
  const last = centsFromDollars(market.last_price_dollars);
  const previous = centsFromDollars(market.previous_price_dollars);
  const yesProbability = bid != null && ask != null && ask >= bid
    ? Math.round((bid + ask) / 2)
    : last == null ? null : Math.round(last);
  const probabilityChange = yesProbability == null || previous == null
    ? null
    : +(yesProbability - previous).toFixed(1);
  return {
    ticker: String(market.ticker),
    eventTicker: market.event_ticker ? String(market.event_ticker) : null,
    title: String(market.title),
    yesLabel: String(market.yes_sub_title || 'Yes'),
    noLabel: String(market.no_sub_title || 'No'),
    yesProbability,
    noProbability: yesProbability == null ? null : 100 - yesProbability,
    yesBid: bid,
    yesAsk: ask,
    lastPrice: last,
    previousPrice: previous,
    probabilityChange,
    volume: decimal(market.volume_fp),
    volume24h: decimal(market.volume_24h_fp),
    openInterest: decimal(market.open_interest_fp),
    liquidityDollars: decimal(market.liquidity_dollars),
    status: String(market.status || 'unknown').toUpperCase(),
    closeTime: market.close_time || null,
    expirationTime: market.expiration_time || null,
    updatedAt: market.updated_time || null,
    source: 'Kalshi',
  };
}

function marketRelevanceScore(market, value, classification = classifySearchQuery(value)) {
  const terms = queryTerms(value, classification);
  const text = [
    market?.ticker, market?.event_ticker, market?.title, market?.yes_sub_title,
    market?.no_sub_title,
  ].filter(Boolean).join(' ').toLowerCase();
  const exact = cleanQuery(value).toLowerCase();
  let score = exact.length >= 3 && text.includes(exact) ? 8 : 0;
  for (const term of terms) {
    if (text.includes(term)) score += term.includes(' ') ? 3 : 2;
  }
  return score;
}

function selectRelevantKalshiMarkets(markets, value, limit = 6) {
  const classification = classifySearchQuery(value);
  const now = Date.now();
  // A prediction-market quote that has not updated in 72h is not a live
  // probability. Drop stale markets rather than displaying dead prices
  // next to a "just now" freshness label.
  const STALE_MS = 72 * 60 * 60 * 1000;
  return (Array.isArray(markets) ? markets : [])
    .map(market => ({ market, score: marketRelevanceScore(market, value, classification) }))
    .filter(item => item.score >= 3)
    .sort((a, b) => b.score - a.score
      || Number(b.market.volume_24h_fp || 0) - Number(a.market.volume_24h_fp || 0))
    .slice(0, limit)
    .map(item => normalizeKalshiMarket(item.market))
    .filter(market => {
      if (!market) return false;
      const updated = Date.parse(market.updatedAt);
      return !Number.isFinite(updated) || now - updated <= STALE_MS;
    });
}

function directionalState(value, bullishThreshold, bearishThreshold = -bullishThreshold) {
  const number = decimal(value);
  if (number == null) return 'UNAVAILABLE';
  if (number >= bullishThreshold) return 'BULLISH';
  if (number <= bearishThreshold) return 'BEARISH';
  return 'NEUTRAL';
}

function buildMacroPressure(indicators = {}, asset = {}) {
  const isGrowth = ['Technology', 'Communication Services'].includes(asset.sector)
    || ['NVDA', 'SMCI', 'SNDK', 'QQQ', 'BTC-USD'].includes(asset.symbol);
  const tenYear = indicators.tenYear || {};
  const vix = indicators.vix || {};
  const oil = indicators.oil || {};
  const spy = indicators.spy || {};
  const qqq = indicators.qqq || {};
  const rateState = tenYear.changePct == null ? 'UNAVAILABLE'
    : directionalState(-tenYear.changePct, 0.45);
  const riskState = vix.changePct == null ? 'UNAVAILABLE'
    : directionalState(-vix.changePct, 2);
  const oilState = oil.changePct == null ? 'UNAVAILABLE'
    : directionalState(isGrowth ? -oil.changePct : oil.changePct, 1);
  const marketAverage = spy.changePct == null && qqq.changePct == null
    ? null
    : [spy.changePct, qqq.changePct].filter(Number.isFinite)
      .reduce((sum, number) => sum + number, 0)
      / [spy.changePct, qqq.changePct].filter(Number.isFinite).length;
  return [
    {
      key: 'rates',
      label: 'Rates',
      state: rateState,
      detail: tenYear.changePct == null
        ? '10Y Treasury data unavailable'
        : `10Y yield ${tenYear.changePct >= 0 ? '+' : ''}${tenYear.changePct.toFixed(2)}% today${isGrowth ? ' · rising yields typically pressure duration-sensitive assets' : ''}`,
    },
    {
      key: 'risk',
      label: 'Risk sentiment',
      state: riskState,
      detail: vix.changePct == null ? 'VIX data unavailable' : `VIX ${vix.changePct >= 0 ? '+' : ''}${vix.changePct.toFixed(2)}% today`,
    },
    {
      key: 'energy',
      label: 'Oil',
      state: oilState,
      detail: oil.changePct == null ? 'Crude-oil data unavailable' : `WTI crude ${oil.changePct >= 0 ? '+' : ''}${oil.changePct.toFixed(2)}% today`,
    },
    {
      key: 'market',
      label: 'Broad market',
      state: directionalState(marketAverage, 0.3),
      detail: marketAverage == null ? 'SPY/QQQ data unavailable' : `SPY/QQQ average ${marketAverage >= 0 ? '+' : ''}${marketAverage.toFixed(2)}% today`,
    },
  ];
}

function marketEquityImplication(market) {
  const text = `${market?.title || ''} ${market?.yesLabel || ''}`.toLowerCase();
  if (/(hike|higher rate|above .*%|inflation.*above|recession)/.test(text)) return -1;
  if (/(cut|lower rate|below .*%)/.test(text)) return 1;
  return 0;
}

function detectPredictionPriceDivergence(markets, assetChangePct) {
  if (!Number.isFinite(Number(assetChangePct))) return null;
  const candidates = (Array.isArray(markets) ? markets : [])
    .filter(market => Number.isFinite(market.probabilityChange)
      && Math.abs(market.probabilityChange) >= 5
      && marketEquityImplication(market) !== 0)
    .sort((a, b) => Math.abs(b.probabilityChange) - Math.abs(a.probabilityChange));
  const market = candidates[0];
  if (!market || Math.abs(Number(assetChangePct)) < 0.5) return null;
  const expectedEquityDirection = Math.sign(market.probabilityChange) * marketEquityImplication(market);
  const actualDirection = Math.sign(Number(assetChangePct));
  if (!expectedEquityDirection || expectedEquityDirection === actualDirection) return null;
  return {
    detected: true,
    marketTicker: market.ticker,
    marketTitle: market.title,
    probabilityChange: market.probabilityChange,
    assetChangePct: +Number(assetChangePct).toFixed(2),
    interpretation: expectedEquityDirection < 0
      ? 'Prediction-market pricing moved toward a typically risk-negative outcome while the asset rose. Another catalyst may currently be dominating price action.'
      : 'Prediction-market pricing moved toward a typically risk-supportive outcome while the asset fell. Earnings, positioning, liquidity, geopolitical risk, or technical structure may be dominating.',
    caveat: 'This is an analytical divergence based on measured changes, not a forecast.',
  };
}

module.exports = {
  TOPICS,
  buildMacroPressure,
  classifySearchQuery,
  detectPredictionPriceDivergence,
  marketRelevanceScore,
  normalizeKalshiMarket,
  queryTerms,
  selectRelevantKalshiMarkets,
};