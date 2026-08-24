'use strict';

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol) ? symbol : null;
}

function isLikelyCryptoSymbol(symbol) {
  // Do not infer crypto from a generic "-USD" or "USD" suffix: USD is also a
  // valid equity ETF ticker. This only recognizes supported pair-shaped names.
  return /^(?:BTC|ETH|LTC|BCH|DOGE|SHIB|AVAX|LINK|UNI|AAVE|MATIC|SOL|DOT|ADA|XRP|ATOM|ALGO|XTZ|SUSHI|YFI|BAT|CRV|GRT|MKR|PAXG|USDC)[-/](?:USD|USDT)$/
    .test(String(symbol || '').toUpperCase());
}

/**
 * Alpaca's `us_equity` assets include both individual stocks and ETFs. Keep the
 * broker's active + tradable flags authoritative rather than guessing from a
 * ticker or vendor screener.
 */
function buildTradableEquityCatalog(assets) {
  const bySymbol = new Map();
  for (const asset of Array.isArray(assets) ? assets : []) {
    const symbol = normalizeSymbol(asset?.symbol);
    if (!symbol || isLikelyCryptoSymbol(symbol)) continue;
    if (asset?.status !== 'active' || asset?.tradable !== true || asset?.asset_class !== 'us_equity') continue;
    bySymbol.set(symbol, {
      symbol,
      name: String(asset?.name || ''),
      exchange: String(asset?.exchange || ''),
      fractionable: asset?.fractionable === true,
      shortable: asset?.shortable === true,
      easyToBorrow: asset?.easy_to_borrow === true,
    });
  }
  return bySymbol;
}

function selectTradableEquityCandidates(candidates, catalog = null) {
  const symbols = [];
  const seen = new Set();
  const rejected = { duplicate: 0, invalidOrCrypto: 0, unavailableAtBroker: 0 };

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const symbol = normalizeSymbol(candidate);
    if (!symbol || isLikelyCryptoSymbol(symbol)) {
      rejected.invalidOrCrypto++;
      continue;
    }
    if (seen.has(symbol)) {
      rejected.duplicate++;
      continue;
    }
    seen.add(symbol);
    if (catalog instanceof Map && !catalog.has(symbol)) {
      rejected.unavailableAtBroker++;
      continue;
    }
    symbols.push(symbol);
  }

  return { symbols, rejected };
}

/**
 * Keep each refresh bounded while ensuring every broker-eligible symbol is
 * eventually examined. Market movers get a fixed priority budget; the rest of
 * the capacity moves deterministically through the complete Alpaca catalog.
 */
function selectCatalogRotation(catalog, {
  prioritySymbols = [],
  limit = 300,
  priorityLimit = 180,
  rotationLimit = null,
  rotationOffset = 0,
} = {}) {
  if (!(catalog instanceof Map) || catalog.size === 0) {
    return { symbols: [], prioritySymbols: [], rotatingSymbols: [], totalBatches: 0, batch: 0, nextOffset: 0 };
  }
  const maxSymbols = Math.max(1, Number(limit) || 1);
  const preferred = selectTradableEquityCandidates(prioritySymbols, catalog)
    .symbols
    .slice(0, Math.min(maxSymbols, Math.max(0, Number(priorityLimit) || 0)));
  const remainingCapacity = Math.max(0, maxSymbols - preferred.length);
  // Rotation always uses the complete, stable catalog—not "catalog minus this
  // response's movers." A changing priority list can then never skip a
  // catalog-only asset for an entire declared cycle. When callers do not set a
  // separate rotation budget, use every slot that the actual mover list left
  // open—not the theoretical priority reservation.
  const requestedRotationCapacity = rotationLimit == null
    ? remainingCapacity
    : Math.max(0, Number(rotationLimit) || 0);
  const rotationCapacity = Math.min(remainingCapacity, requestedRotationCapacity);
  const rotatingPool = [...catalog.keys()].sort();
  const totalBatches = rotationCapacity ? Math.ceil(rotatingPool.length / rotationCapacity) : 0;
  const start = Math.abs(Math.trunc(Number(rotationOffset) || 0)) % rotatingPool.length;
  const batch = rotationCapacity ? Math.floor(start / rotationCapacity) : 0;
  const rotatingSymbols = rotationCapacity
    ? rotatingPool.slice(start, start + rotationCapacity)
    : [];
  const nextOffset = rotationCapacity && start + rotatingSymbols.length < rotatingPool.length
    ? start + rotatingSymbols.length
    : 0;
  return {
    symbols: [...new Set([...preferred, ...rotatingSymbols])],
    prioritySymbols: preferred,
    rotatingSymbols,
    totalBatches,
    batch,
    nextOffset,
  };
}

function resolveInverseSymbol(symbol, inverseMap) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;
  const target = inverseMap?.[normalized];
  return normalizeSymbol(target);
}

function countOpenBuyEntries(orders) {
  return (Array.isArray(orders) ? orders : []).filter(order =>
    String(order?.side || '').toLowerCase() === 'buy'
  ).length;
}

function calculateEntryCapacity(positions, openOrders, maximumPositions) {
  const held = Array.isArray(positions) ? positions.length : 0;
  const pendingEntries = countOpenBuyEntries(openOrders);
  const used = held + pendingEntries;
  return {
    held,
    pendingEntries,
    used,
    available: Math.max(0, Number(maximumPositions || 0) - used),
  };
}

function canReserveEntryUnits(capacity, units = 1) {
  return Number.isFinite(Number(capacity?.available)) &&
    Number(capacity.available) >= Math.max(1, Number(units) || 1);
}

module.exports = {
  normalizeSymbol,
  isLikelyCryptoSymbol,
  buildTradableEquityCatalog,
  selectTradableEquityCandidates,
  selectCatalogRotation,
  resolveInverseSymbol,
  countOpenBuyEntries,
  calculateEntryCapacity,
  canReserveEntryUnits,
};