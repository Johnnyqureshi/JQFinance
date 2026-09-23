'use strict';

// Money Flow is intentionally a provenance-first presentation layer. Yahoo
// quote/chart data can describe observed price/volume participation, but it
// does not provide ETF creations/redemptions, crypto derivatives positioning,
// or liquidation prints. Those fields stay unavailable until a provider can
// verify them.

const finite = value => value !== null
  && value !== undefined
  && !(typeof value === 'string' && value.trim() === '')
  && Number.isFinite(Number(value));

const rawValue = value => value && typeof value === 'object' && 'raw' in value ? value.raw : value;
const num = value => finite(rawValue(value)) ? Number(rawValue(value)) : null;
const round = (value, decimals = 2) => num(value) == null ? null : +num(value).toFixed(decimals);

function normalizeBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .filter(bar => [bar?.h, bar?.l, bar?.c].every(finite))
    .map(bar => ({
      t: bar.t || bar.date || null,
      o: num(bar.o),
      h: num(bar.h),
      l: num(bar.l),
      c: num(bar.c),
      v: num(bar.v),
    }))
    .filter(bar => bar.c > 0 && bar.h >= bar.l)
    .sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')));
}

function average(values) {
  const usable = values.filter(finite).map(Number);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function normalizeSeries(values) {
  const usable = values.filter(value => finite(value)).map(Number);
  if (usable.length < 2) return usable.length ? usable.map(() => 50) : [];
  const low = Math.min(...usable);
  const high = Math.max(...usable);
  return high === low ? usable.map(() => 50) : usable.map(value => ((value - low) / (high - low)) * 100);
}

function activityDirection(changePct) {
  if (!finite(changePct) || Math.abs(Number(changePct)) < 0.15) return 'NEUTRAL';
  return Number(changePct) > 0 ? 'UP' : 'DOWN';
}

function classifyMoneyFlowInstrument({ assetType = 'EQUITY', instrumentType = null, quoteType = null } = {}) {
  if (String(assetType || '').toUpperCase() === 'CRYPTO' || String(instrumentType || '').toUpperCase() === 'CRYPTO') return 'CRYPTO';
  if (String(instrumentType || '').toUpperCase() === 'ETF' || String(quoteType || '').toUpperCase() === 'ETF' || String(assetType || '').toUpperCase() === 'ETF') return 'ETF';
  return 'STOCK';
}

function relativeVolume(snapshot, bars) {
  const direct = num(snapshot?.relVol);
  if (direct != null) return direct;
  const currentVolume = num(snapshot?.volume);
  const averageVolume = num(snapshot?.avgVolume) ?? average(bars.slice(-20).map(bar => bar.v));
  return currentVolume != null && averageVolume > 0 ? currentVolume / averageVolume : null;
}

function flowStatus(score) {
  if (score == null) return 'INSUFFICIENT DATA';
  if (score >= 75) return 'STRONG INFLOW';
  if (score >= 60) return 'INFLOW';
  if (score <= 25) return 'STRONG OUTFLOW';
  if (score <= 40) return 'OUTFLOW';
  return 'NEUTRAL';
}

function computeScore({ price, changePct, relVol, vwap, spyChangePct, sectorChangePct }) {
  if (price == null || changePct == null || relVol == null) return null;
  let score = 50;
  const move = Number(changePct);
  const direction = move > 0.15 ? 1 : move < -0.15 ? -1 : 0;
  if (direction) {
    score += direction * (Number(relVol) >= 3 ? 30 : Number(relVol) >= 2 ? 24 : Number(relVol) >= 1.5 ? 18 : Number(relVol) >= 1 ? 10 : 4);
  }
  if (vwap != null && price !== 0) {
    const aboveVwap = price >= vwap;
    score += aboveVwap ? 8 : -8;
  }
  if (finite(spyChangePct) && Math.abs(Number(spyChangePct)) >= 0.3) {
    score += Math.sign(Number(spyChangePct)) * 4;
  }
  if (finite(sectorChangePct) && Math.abs(Number(sectorChangePct)) >= 0.3) {
    score += Math.sign(Number(sectorChangePct)) * 3;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildParticipationSeries(bars, period) {
  const selected = bars.slice(-period);
  if (!selected.length) return { available: false, points: [], reason: 'Completed OHLCV history unavailable.' };
  const closes = selected.map(bar => bar.c);
  const flowValues = [];
  let cumulative = 0;
  selected.forEach((bar, index) => {
    const previous = selected[index - 1]?.c;
    if (bar.v == null || bar.v <= 0 || previous == null) {
      flowValues.push(null);
      return;
    }
    const sign = bar.c > previous ? 1 : bar.c < previous ? -1 : 0;
    cumulative += sign * bar.v;
    flowValues.push(cumulative);
  });
  const priceNormalized = normalizeSeries(closes);
  const flowNormalized = normalizeSeries(flowValues);
  const points = selected.map((bar, index) => ({
    t: bar.t,
    price: round(bar.c),
    priceNormalized: round(priceNormalized[index], 1),
    flow: flowValues[index] == null ? null : round(flowValues[index], 0),
    flowNormalized: flowNormalized[index] == null ? null : round(flowNormalized[index], 1),
  }));
  return {
    available: points.some(point => point.flowNormalized != null),
    points,
    method: 'Signed completed-bar volume proxy; price change signs volume and does not identify buyer-initiated executions.',
    reason: points.some(point => point.flowNormalized != null) ? null : 'Volume was unavailable for the selected period.',
  };
}

function buildShortPositioning(quoteSummary, relativeVol) {
  const stats = quoteSummary?.defaultKeyStatistics || {};
  const sharesShort = num(stats.sharesShort);
  const priorSharesShort = num(stats.sharesShortPriorMonth ?? stats.sharesShortPreviousMonth);
  const shortRatio = num(stats.shortRatio);
  const shortPercent = num(stats.shortPercentOfFloat);
  const percentOfFloat = shortPercent == null ? null : round(shortPercent * 100, 2);
  const change = sharesShort != null && priorSharesShort != null ? sharesShort - priorSharesShort : null;
  const direction = change == null || change === 0 ? 'NEUTRAL' : change > 0 ? 'UP' : 'DOWN';
  const timestamp = num(stats.dateShortInterest);
  const hasData = sharesShort != null || shortRatio != null || percentOfFloat != null;
  return {
    available: hasData,
    status: hasData ? 'AVAILABLE' : 'DATA UNAVAILABLE',
    source: hasData ? 'Yahoo Finance defaultKeyStatistics' : 'Yahoo Finance short-interest fields unavailable',
    asOf: timestamp == null ? null : new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp).toISOString(),
    metrics: [
      { label: 'Short interest', value: sharesShort, unit: 'shares', direction },
      { label: 'Short interest % float', value: percentOfFloat, unit: '%', direction },
      { label: 'Days to cover', value: shortRatio, unit: 'days', direction: 'NEUTRAL' },
      { label: 'Short volume', value: null, unit: '', direction: 'UNAVAILABLE' },
      { label: 'Relative volume', value: relativeVol == null ? null : round(relativeVol, 2), unit: 'x', direction: relativeVol == null ? 'UNAVAILABLE' : 'NEUTRAL' },
    ],
    change: change == null ? null : round(change, 0),
    note: hasData
      ? 'Short-interest fields are reported statistics, not real-time short selling or a squeeze confirmation.'
      : 'No verified short-interest fields were returned for this symbol.',
  };
}

function unavailableEtfExposure(reason, label = 'ETF Flow Exposure — Estimated') {
  return {
    available: false,
    label,
    reason,
    estimated: true,
    source: 'ETF net-flow and constituent-weight source unavailable',
    rows: [],
  };
}

function buildEtfActivity(market) {
  const rows = [];
  const add = (symbol, label, changePct, volume, averageVolume) => {
    if (!symbol) return;
    rows.push({
      symbol,
      label,
      changePct: num(changePct),
      relativeVolume: num(volume) != null && num(averageVolume) > 0 ? round(num(volume) / num(averageVolume), 2) : null,
      note: 'Price/volume activity context only; not ETF net flow.',
    });
  };
  const activity = Array.isArray(market?.etfActivity) ? market.etfActivity : [];
  activity.forEach(item => add(item.symbol, item.label || item.symbol, item.changePct, item.volume, item.averageVolume));
  if (market?.spy != null && !rows.some(row => row.symbol === 'SPY')) add('SPY', 'Broad market', market.spy);
  if (market?.qqq != null && !rows.some(row => row.symbol === 'QQQ')) add('QQQ', 'Nasdaq 100', market.qqq);
  if (market?.iwm != null && !rows.some(row => row.symbol === 'IWM')) add('IWM', 'Russell 2000', market.iwm);
  if (market?.sectorEtf && !rows.some(row => row.symbol === market.sectorEtf)) {
    add(market.sectorEtf, 'Sector ETF', market.sectorChangePct, market.sectorActivity?.volume, market.sectorActivity?.averageVolume);
  }
  return rows.slice(0, 5);
}

function primaryDriver({ assetType, score, relativeVol, changePct, market, confirmation }) {
  if (score == null || changePct == null) {
    return { label: 'INSUFFICIENT DATA', reason: 'A verified price move and volume baseline were not both available, so no primary flow driver is assigned.' };
  }
  const move = Number(changePct);
  const broadAligned = finite(market?.spy) && Math.sign(Number(market.spy)) === Math.sign(move) && Math.abs(Number(market.spy)) >= 0.3;
  const sectorAligned = finite(market?.sectorChangePct) && Math.sign(Number(market.sectorChangePct)) === Math.sign(move) && Math.abs(Number(market.sectorChangePct)) >= 0.3;
  if (relativeVol >= 1.5 && confirmation === 'CONFIRMED') {
    return {
      label: 'ELEVATED VOLUME',
      reason: `${assetType === 'CRYPTO' ? 'Observed chart volume' : 'Observed trading volume'} is ${Number(relativeVol).toFixed(2)}x the available baseline while price is moving ${move > 0 ? 'higher' : 'lower'}. This is participation context, not proof of institutional flow.`,
    };
  }
  if (broadAligned && sectorAligned) {
    return { label: 'BROAD + SECTOR MOVEMENT', reason: `The selected asset and both available market context series are moving ${move > 0 ? 'higher' : 'lower'}; attribution is contextual, not direct ETF flow.` };
  }
  if (broadAligned) {
    return { label: 'BROAD MARKET MOVEMENT', reason: `The selected asset is moving with SPY at ${Number(market.spy).toFixed(2)}%; this does not establish direct capital flow into the asset.` };
  }
  if (sectorAligned) {
    return { label: 'SECTOR MOVEMENT', reason: `The selected asset is moving with ${market.sectorEtf || 'its sector ETF'} at ${Number(market.sectorChangePct).toFixed(2)}%; sector price movement is not ETF net-flow data.` };
  }
  return { label: 'MIXED', reason: 'Available price, volume, and market-context evidence does not isolate one verified primary driver.' };
}

function buildMoneyFlowData({
  symbol = null,
  assetType = 'EQUITY',
  instrumentType = null,
  snapshot = {},
  indicators = {},
  dailyBars = [],
  market = {},
  quoteSummary = null,
  source = 'Yahoo Finance quote and chart API',
  generatedAt = Date.now(),
} = {}) {
  const type = String(assetType || 'EQUITY').toUpperCase() === 'CRYPTO' ? 'CRYPTO' : 'EQUITY';
  const instrument = classifyMoneyFlowInstrument({ assetType: type, instrumentType });
  const bars = normalizeBars(dailyBars);
  const price = num(snapshot.price);
  const changePct = num(snapshot.changePct)
    ?? (price != null && bars.at(-1)?.c > 0 ? (price - bars.at(-1).c) / bars.at(-1).c * 100 : null);
  const relVol = relativeVolume(snapshot, bars);
  const vwap = num(indicators.vwap);
  const score = computeScore({
    price,
    changePct,
    relVol,
    vwap,
    spyChangePct: market.spy,
    sectorChangePct: market.sectorChangePct,
  });
  const confirmation = changePct != null && relVol != null && Math.abs(changePct) >= 0.15
    ? relVol >= 1.2 ? 'CONFIRMED' : 'NOT CONFIRMED'
    : 'UNAVAILABLE';
  const status = flowStatus(score);
  const participation = {
    relativeVolume: round(relVol, 2),
    threshold: { normal: 1, elevated: 1.5, strong: 2, extreme: 3 },
    confirmation,
    note: relVol == null ? 'Data unavailable' : confirmation === 'CONFIRMED' ? 'Volume confirms move' : confirmation === 'NOT CONFIRMED' ? 'Volume does NOT confirm move' : 'Directional move unavailable',
    source: relVol == null ? 'Volume baseline unavailable' : source,
  };
  const exposure = instrument === 'ETF'
    ? unavailableEtfExposure('Verified ETF creations/redemptions flow data is not published by the connected providers.', 'ETF Net Flow')
    : unavailableEtfExposure('The connected market-data providers do not publish verified ETF net flow and constituent-weight inputs.');
  const activityRows = buildEtfActivity(market);
  const positioning = type === 'EQUITY'
    ? buildShortPositioning(quoteSummary, relVol)
    : {
      available: false,
      status: 'DATA UNAVAILABLE',
      source: 'No connected crypto derivatives feed',
      asOf: null,
      metrics: [
        { label: 'Open interest', value: null, unit: '', direction: 'UNAVAILABLE' },
        { label: 'Funding rate', value: null, unit: '', direction: 'UNAVAILABLE' },
        { label: 'Long / short', value: null, unit: '', direction: 'UNAVAILABLE' },
        { label: 'Liquidations', value: null, unit: '', direction: 'UNAVAILABLE' },
      ],
      note: 'Open interest, funding, positioning, and liquidation data are not provided by the connected Yahoo chart/quote feed.',
    };
  const flowTrend = {
    '5D': buildParticipationSeries(bars, 5),
    '20D': buildParticipationSeries(bars, 20),
    label: 'Observed participation trend — OHLCV proxy, not ETF net flow',
    source,
  };
  const driver = primaryDriver({
    assetType: type,
    score,
    relativeVol: relVol,
    changePct,
    market,
    confirmation,
  });
  const missing = [
    score == null ? 'price/volume flow proxy score' : null,
    exposure.available ? null : 'ETF net flow exposure',
    type === 'CRYPTO' ? 'open interest, funding, long/short, and liquidation data' : positioning.available ? null : 'short-interest statistics',
  ].filter(Boolean);

  return {
    available: price != null || bars.length > 0,
    symbol: String(symbol || '').toUpperCase() || null,
    assetType: type,
    instrumentType: instrument,
    instrumentTypeSource: instrument === 'CRYPTO' ? 'Crypto symbol classification' : instrumentType ? 'Provider quoteType' : 'Equity default; provider quoteType unavailable',
    generatedAt: new Date(generatedAt).toISOString(),
    status: missing.length ? 'PARTIAL' : 'AVAILABLE',
    source,
    dataQuality: {
      missing,
      delayed: false,
      note: type === 'CRYPTO'
        ? 'Yahoo chart volume is venue-aggregated and does not distinguish spot from derivatives participation.'
        : 'Observed quote/chart inputs are separated from unavailable ETF-flow and real-time short-volume fields.',
    },
    summary: {
      status,
      score,
      scoreLabel: score == null ? 'Data unavailable' : 'OHLCV participation proxy score',
      direction: activityDirection(changePct),
      reason: score == null
        ? 'Price and verified volume-baseline inputs were not both available.'
        : 'Score combines price direction, relative volume, VWAP location, and limited market/sector price context. It is not a direct capital-flow measurement.',
    },
    participation,
    etfExposure: exposure,
    etfActivity: activityRows,
    flowTrend,
    priceFlow: {
      periods: flowTrend,
      label: 'Price vs money-flow proxy',
      note: type === 'CRYPTO'
        ? 'Signed chart-volume comparison only; spot/futures source is not isolated.'
        : 'Signed completed-bar volume comparison only; it does not identify buyer-initiated executions.',
    },
    positioning,
    liquidation: type === 'CRYPTO'
      ? { available: false, status: 'DATA UNAVAILABLE', long: null, short: null, driver: 'NEITHER / INSUFFICIENT DATA', source: 'No connected liquidation feed' }
      : null,
    primaryDriver: driver,
    timestamps: {
      generatedAt: new Date(generatedAt).toISOString(),
      source,
      etfFlow: 'Unavailable',
      positioning: positioning.asOf || 'Unavailable',
    },
    methodology: 'Deterministic visual summary of verified quote, completed OHLCV, VWAP, market/sector price context, and published short-interest fields when available.',
    disclaimer: 'MONEY FLOW is a data-limited participation proxy. It does not prove institutional flow, ETF creations/redemptions, short covering, a squeeze, or buyer-initiated executions.',
  };
}

module.exports = {
  buildMoneyFlowData,
  buildParticipationSeries,
  buildShortPositioning,
  classifyMoneyFlowInstrument,
};