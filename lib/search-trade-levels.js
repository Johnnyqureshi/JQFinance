'use strict';

const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = value => finite(value) ? +Number(value).toFixed(2) : null;

function addCandidate(list, price, source, weight, currentPrice, side, detail = '') {
  const value = Number(price);
  if (!finite(value) || value <= 0 || !finite(currentPrice)) return;
  if (side === 'buy' && value >= currentPrice) return;
  if (side === 'sell' && value <= currentPrice) return;
  const distancePct = Math.abs(value - currentPrice) / currentPrice * 100;
  if (distancePct > 15) return;
  list.push({ price: value, source, weight, detail, distancePct });
}

function selectLevel(candidates, tolerance) {
  if (!candidates.length) return null;
  const clusters = candidates.map(anchor => {
    const members = candidates.filter(candidate => Math.abs(candidate.price - anchor.price) <= tolerance);
    const uniqueSources = [...new Set(members.map(candidate => candidate.source))];
    const weight = uniqueSources.reduce((sum, source) =>
      sum + Math.max(...members.filter(candidate => candidate.source === source).map(candidate => candidate.weight)), 0);
    const center = members.reduce((sum, candidate) => sum + candidate.price * candidate.weight, 0)
      / members.reduce((sum, candidate) => sum + candidate.weight, 0);
    const representative = [...members].sort((a, b) =>
      b.weight - a.weight || Math.abs(a.price - center) - Math.abs(b.price - center))[0];
    return {
      representative,
      members,
      sources: uniqueSources,
      rank: weight + Math.max(0, 3 - representative.distancePct) * 0.35,
    };
  });
  const selected = clusters.sort((a, b) =>
    b.rank - a.rank || a.representative.distancePct - b.representative.distancePct)[0];
  return {
    price: round(selected.representative.price),
    source: selected.representative.source,
    sourceDetail: selected.representative.detail,
    evidence: selected.sources,
    evidenceCount: selected.sources.length,
    distancePct: +selected.representative.distancePct.toFixed(2),
    alignment: selected.sources.length >= 3 ? 'HIGH' : selected.sources.length >= 2 ? 'MULTIPLE' : 'BASE',
  };
}

function buildSearchTradeLevels({
  currentPrice,
  levels = {},
  confluence = {},
  fibonacci = {},
  smartMoney = {},
  searchSignal = {},
} = {}) {
  const price = Number(currentPrice);
  if (!finite(price) || price <= 0) {
    return { available: false, status: 'UNAVAILABLE', reason: 'Current price unavailable' };
  }

  const buyCandidates = [];
  const sellCandidates = [];
  const support = levels?.support?.[0];
  const resistance = levels?.resistance?.[0];
  const atr = Number(levels?.atr || smartMoney?.indicators?.atr);
  const tolerance = Math.max(price * 0.004, finite(atr) ? atr * 0.30 : 0);

  addCandidate(buyCandidates, support?.price, 'Completed-session support', 5, price, 'buy', support?.label);
  addCandidate(sellCandidates, resistance?.price, 'Completed-session resistance', 5, price, 'sell', resistance?.label);

  const criticalSupport = confluence?.levels?.criticalSupport;
  const criticalResistance = confluence?.levels?.criticalResistance;
  if (!support || Number(criticalSupport?.price) !== Number(support?.price)) {
    addCandidate(buyCandidates, criticalSupport?.price, 'Multi-timeframe technical level', 4, price, 'buy', criticalSupport?.label);
  }
  if (!resistance || Number(criticalResistance?.price) !== Number(resistance?.price)) {
    addCandidate(sellCandidates, criticalResistance?.price, 'Multi-timeframe technical level', 4, price, 'sell', criticalResistance?.label);
  }

  const vwap = confluence?.vwap?.value;
  if (confluence?.dataQuality?.fresh === true) {
    addCandidate(buyCandidates, vwap, 'Fresh intraday VWAP', 2, price, 'buy', confluence?.vwap?.slope);
    addCandidate(sellCandidates, vwap, 'Fresh intraday VWAP', 2, price, 'sell', confluence?.vwap?.slope);
  }

  if (fibonacci?.available) {
    addCandidate(buyCandidates, fibonacci?.nearestSupport?.price, 'Confirmed-swing Fibonacci', 2, price, 'buy', fibonacci?.setup);
    addCandidate(sellCandidates, fibonacci?.nearestResistance?.price, 'Confirmed-swing Fibonacci', 2, price, 'sell', fibonacci?.setup);
  }

  if (smartMoney?.available && smartMoney?.status === 'FRESH') {
    const demand = smartMoney?.nearest?.demand;
    const supply = smartMoney?.nearest?.supply;
    const demandPrice = demand?.midpoint ?? (finite(demand?.low) && finite(demand?.high)
      ? (Number(demand.low) + Number(demand.high)) / 2 : null);
    const supplyPrice = supply?.midpoint ?? (finite(supply?.low) && finite(supply?.high)
      ? (Number(supply.low) + Number(supply.high)) / 2 : null);
    addCandidate(buyCandidates, demandPrice, 'Smart Money demand zone', 2.5, price, 'buy', demand?.confluence || demand?.confidence);
    addCandidate(sellCandidates, supplyPrice, 'Smart Money supply zone', 2.5, price, 'sell', supply?.confluence || supply?.confidence);
  }

  const buy = selectLevel(buyCandidates, tolerance);
  const sell = selectLevel(sellCandidates, tolerance);
  const considered = [
    levels?.support?.length || levels?.resistance?.length ? 'Completed-session support / resistance' : null,
    confluence?.available ? 'Multi-timeframe trend, momentum, VWAP, volume, and market regime' : null,
    confluence?.priceAction?.available ? 'Completed-bar price action' : null,
    searchSignal?.structure ? 'Search price structure and volume confirmation' : null,
    fibonacci?.available ? 'Confirmed-swing Fibonacci' : null,
    smartMoney?.available ? 'Smart Money demand / supply zones' : null,
    searchSignal?.newsImpact ? 'Price-confirmed catalyst checks' : null,
  ].filter(Boolean);
  const signalStage = searchSignal?.signal?.stage || 'UNAVAILABLE';
  const fresh = confluence?.dataQuality?.fresh === true;
  const complete = buy != null && sell != null;
  const fullyConfirmed = complete
    && fresh
    && confluence?.dataQuality?.entryEligible === true
    && signalStage === 'CONFIRMED';

  return {
    available: complete,
    status: complete ? (fullyConfirmed ? 'VERIFIED' : 'PROVISIONAL') : 'WAITING',
    buy,
    sell,
    signalStage,
    considered,
    methodology: 'Prices are selected from the strongest nearby cluster of real deterministic levels. Qualitative evidence controls readiness and alignment; it never invents a price.',
    dataQuality: {
      fresh,
      entryEligible: confluence?.dataQuality?.entryEligible === true,
      missingCriticalInputs: confluence?.dataQuality?.missingCriticalInputs || [],
    },
  };
}

module.exports = { buildSearchTradeLevels };