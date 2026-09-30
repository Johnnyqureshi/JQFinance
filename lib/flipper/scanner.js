'use strict';

// Flipper Bot — universe + liquidity pipeline.
//
// Broker I/O is isolated to fetchUniverse / fetchQuotes (both take an injected
// `fetch` like warrior's fetchBroker: `(path, opts) => Promise<Response>` with
// `ok`, `status`, and `json()`). The service layer owns the base URL, auth
// headers, and feed fallback; this module only supplies the path.
// Everything else in this file is pure for testability.
//
// Lean-DB rule: filterLiquid returns aggregate-safe data only (pass list +
// rejection COUNTS). The caller logs counts; no symbol-level rejection list
// ever leaves this module.

const { buildTradableEquityCatalog } = require('../broker-universe');

// Pinned DEFAULT_FLIPPER_RULES subset used by the scanner (ARCHITECTURE.md).
const DEFAULT_SCAN_RULES = Object.freeze({
  minPrice: 1,
  maxPrice: 20,
  minAvgDailyVolume: 500000,
  minDayVolume: 50000,
  maxSpreadPct: 0.5,
  includeETFs: true,
  scanBudget: 100,
});

// Fetch the full Alpaca tradable US-equity universe. Tradable-ness comes from
// the broker's own flags via buildTradableEquityCatalog (status=active,
// tradable, asset_class=us_equity, crypto pairs excluded); fractionable assets
// are additionally required since Flipper routes standard equity orders.
// Returns [{ symbol, name, assetClass }]. Price pre-filter happens later.
async function fetchUniverse({ fetch, rules = {} } = {}) {
  if (typeof fetch !== 'function') throw new Error('fetchUniverse: fetch is required.');
  void rules;
  const response = await fetch('/v2/assets?status=active&asset_class=us_equity');
  if (!response || !response.ok) {
    const status = response && response.status !== undefined ? response.status : 'unknown';
    throw new Error(`fetchUniverse: broker assets request failed (HTTP ${status}).`);
  }
  const assets = await response.json();
  const catalog = buildTradableEquityCatalog(assets);
  const out = [];
  for (const entry of catalog.values()) {
    if (entry.fractionable !== true) continue;
    out.push({ symbol: entry.symbol, name: entry.name || null, assetClass: entry.assetClass });
  }
  return out;
}

// Batched latest-quote fetch for a symbol list (Alpaca data API). Returns
// { SYMBOL: { bid, ask, price, t } } where price is the bid/ask midpoint (or
// null when no two-sided quote exists). Symbols with no quote entry are
// omitted; filterLiquid skips the spread check for those.
async function fetchQuotes({ fetch, symbols = [] } = {}, { chunkSize = 200, feed = 'iex' } = {}) {
  if (typeof fetch !== 'function') throw new Error('fetchQuotes: fetch is required.');
  const list = [...new Set((Array.isArray(symbols) ? symbols : []).filter(s => typeof s === 'string' && s.length > 0))];
  const out = {};
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const path = `/v2/stocks/quotes/latest?symbols=${chunk.join(',')}&feed=${encodeURIComponent(feed)}`;
    const response = await fetch(path);
    if (!response || !response.ok) {
      const status = response && response.status !== undefined ? response.status : 'unknown';
      throw new Error(`fetchQuotes: broker quotes request failed (HTTP ${status}).`);
    }
    const data = await response.json();
    const quotes = (data && data.quotes) || {};
    for (const [symbol, q] of Object.entries(quotes)) {
      const bid = Number(q && q.bp);
      const ask = Number(q && q.ap);
      const hasBid = Number.isFinite(bid) && bid > 0;
      const hasAsk = Number.isFinite(ask) && ask > 0;
      out[String(symbol).toUpperCase()] = {
        bid: hasBid ? bid : null,
        ask: hasAsk ? ask : null,
        price: hasBid && hasAsk ? (bid + ask) / 2 : null,
        t: (q && q.t) || null,
      };
    }
  }
  return out;
}

function midPrice(quote) {
  if (!quote) return null;
  if (Number.isFinite(quote.price) && quote.price > 0) return quote.price;
  const bid = quote.bid; const ask = quote.ask;
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) return (bid + ask) / 2;
  return null;
}

// Liquidity + price + spread pipeline (pure). Aggregate-safe return:
// { passed: [symbols], total, passedCount, rejectedCount, rejectionCounts }.
// Rejection reasons are stable codes so the caller can count/log them.
function filterLiquid({ symbols = [], quotes = {}, dailyStats = {}, rules = {} } = {}) {
  const r = { ...DEFAULT_SCAN_RULES, ...rules };
  const passed = [];
  const rejectionCounts = {};
  const reject = reason => { rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1; };
  const list = Array.isArray(symbols) ? symbols : [];
  for (const symbol of list) {
    const stats = (dailyStats && dailyStats[symbol]) || {};
    // ETF exclusion is evaluated first (cheapest, no quote needed).
    if (r.includeETFs !== true && stats.isEtf === true) { reject('etf_excluded'); continue; }
    const price = midPrice(quotes ? quotes[symbol] : null);
    if (!Number.isFinite(price) || price <= 0) { reject('no_price'); continue; }
    if (price < +r.minPrice || price > +r.maxPrice) { reject('price_band'); continue; }
    const adv = +stats.adv;
    if (!Number.isFinite(adv) || adv < +r.minAvgDailyVolume) { reject('adv'); continue; }
    const dayVolume = +stats.dayVolume;
    if (!Number.isFinite(dayVolume) || dayVolume < +r.minDayVolume) { reject('day_volume'); continue; }
    const quote = quotes ? quotes[symbol] : null;
    if (quote && quote.bid !== null && quote.bid !== undefined
        && quote.ask !== null && quote.ask !== undefined
        && Number.isFinite(+quote.bid) && Number.isFinite(+quote.ask)
        && +quote.bid > 0 && +quote.ask > 0) {
      const mid = (+quote.bid + +quote.ask) / 2;
      const spreadPct = ((+quote.ask - +quote.bid) / mid) * 100;
      if (spreadPct > +r.maxSpreadPct) { reject('spread'); continue; }
    }
    // Spread check skipped when no two-sided quote is available.
    passed.push(symbol);
  }
  return {
    passed,
    total: list.length,
    passedCount: passed.length,
    rejectedCount: list.length - passed.length,
    rejectionCounts,
  };
}

// Rank liquid symbols by current-day volume desc, capped at rules.scanBudget.
// Pure; symbols with no volume entry count as 0. Ties broken alphabetically
// for a deterministic scan order.
function rankUniverse({ symbols = [], dayVolumes = {}, rules = {} } = {}) {
  const r = { ...DEFAULT_SCAN_RULES, ...rules };
  const budget = Math.max(0, Math.floor(+r.scanBudget || 0));
  const list = Array.isArray(symbols) ? symbols.slice() : [];
  const vol = symbol => {
    const v = dayVolumes && dayVolumes[symbol] !== undefined ? +dayVolumes[symbol] : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  list.sort((a, b) => {
    const d = vol(b) - vol(a);
    return d !== 0 ? d : String(a).localeCompare(String(b));
  });
  return list.slice(0, budget);
}

module.exports = {
  fetchUniverse,
  fetchQuotes,
  filterLiquid,
  rankUniverse,
  DEFAULT_SCAN_RULES,
};
