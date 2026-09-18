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
    // Alpaca normally returns booleans, but a few HTTP/client paths serialize
    // flags as strings. Normalize only explicit true values—never treat a
    // missing or truthy-looking value as tradable.
    const tradable = asset?.tradable === true || asset?.tradable === 'true' || asset?.tradable === 1;
    // Alpaca's REST asset object uses `class`; retain `asset_class` support for
    // older normalized/cache records. Requiring only `asset_class` rejected
    // every live Alpaca equity response at the final order-validation gate.
    const assetClass = String(asset?.class ?? asset?.asset_class ?? '').toLowerCase();
    if (String(asset?.status || '').toLowerCase() !== 'active' || !tradable || assetClass !== 'us_equity') continue;
    bySymbol.set(symbol, {
      symbol,
      name: String(asset?.name || ''),
      exchange: String(asset?.exchange || ''),
      assetClass,
      fractionable: asset?.fractionable === true,
      shortable: asset?.shortable === true,
      easyToBorrow: asset?.easy_to_borrow === true,
    });
  }
  return bySymbol;
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
  resolveInverseSymbol,
  countOpenBuyEntries,
  calculateEntryCapacity,
  canReserveEntryUnits,
};