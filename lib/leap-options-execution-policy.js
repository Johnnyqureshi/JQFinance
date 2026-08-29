'use strict';

const crypto = require('crypto');
const { ALLOWED_UNDERLYINGS } = require('./leap-options-strategy');
const num = value => Number.isFinite(Number(value)) ? Number(value) : null;
const DAY = 86400000;
const optionSymbol = contract => String(contract?.symbol ?? contract?.option_symbol ?? contract?.id ?? '').trim();
function contractExpiration(contract) { return new Date(contract?.expiration_date ?? contract?.expiration ?? contract?.expiry).getTime(); }
function selectLeapContract(contracts, { symbol, underlyingPrice, now = Date.now(), minDte = 360 } = {}) {
  const root = String(symbol || '').toUpperCase(), price = num(underlyingPrice), time = num(now);
  if (!ALLOWED_UNDERLYINGS.includes(root) || !(price > 0) || !Number.isFinite(time) || !Array.isArray(contracts)) return null;
  const candidates = contracts.filter(contract => String(contract.underlying_symbol ?? contract.underlying ?? '').toUpperCase() === root
    && String(contract.type ?? contract.option_type ?? '').toLowerCase() === 'call'
    && num(contract.strike_price ?? contract.strike) > 0 && contractExpiration(contract) - time >= minDte * DAY
    && num(contract.multiplier) === 100 && optionSymbol(contract));
  if (!candidates.length) return null;
  const expiry = Math.min(...candidates.map(contractExpiration));
  return candidates.filter(contract => contractExpiration(contract) === expiry)
    .sort((a,b) => Math.abs(num(a.strike_price ?? a.strike) - price * 1.1) - Math.abs(num(b.strike_price ?? b.strike) - price * 1.1))[0] || null;
}
function normalizeOptionQuote(quote, { now = Date.now(), maxQuoteAgeMs = 60000, maxSpreadFraction = .15 } = {}) {
  const bid = num(quote?.bid_price ?? quote?.bid), ask = num(quote?.ask_price ?? quote?.ask);
  const timestamp = new Date(quote?.timestamp ?? quote?.t ?? quote?.updated_at ?? quote?.quote_timestamp).getTime();
  if (!(bid > 0) || !(ask > 0) || !Number.isFinite(timestamp)) return null;
  if (timestamp > now + 5000 || now - timestamp > maxQuoteAgeMs || bid >= ask) return null;
  const mid = (bid + ask) / 2, spreadFraction = (ask - bid) / mid;
  if (!(spreadFraction <= maxSpreadFraction)) return null;
  return { bid, ask, mid, spreadFraction, timestamp, mark:mid };
}
function quotePassesLeapGates(contract, quote, config = {}) {
  const normalized = normalizeOptionQuote(quote, config);
  if (!normalized || num(contract?.multiplier) !== 100) return null;
  const openInterest = num(contract?.open_interest ?? contract?.openInterest);
  const volume = num(contract?.volume);
  if ((openInterest != null && openInterest <= 0) || (volume != null && volume <= 0)) return null;
  return normalized;
}
function calculateLeapContracts({ equity, maxPositionDollars, premium, multiplier = 100 } = {}) {
  const cap = Math.min(Math.max(0, (num(equity) || 0) * .05), Math.max(0, num(maxPositionDollars) || 0));
  if (!(num(premium) > 0) || num(multiplier) !== 100) return 0;
  return Math.max(0, Math.floor(cap / (num(premium) * 100)));
}
function immutableLeapClientOrderId({ symbol, contractSymbol, purpose = 'entry', nonce } = {}) {
  const root=String(symbol || '').toUpperCase(), contract=String(contractSymbol || '').toUpperCase();
  const suffix=String(nonce ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (!ALLOWED_UNDERLYINGS.includes(root) || !contract || !suffix) throw new Error('An allowed underlying, contract symbol, and immutable nonce are required.');
  const intent=String(purpose || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7);
  if (!intent) throw new Error('A valid immutable order purpose is required.');
  const contractHash=crypto.createHash('sha256').update(contract).digest('hex').slice(0, 10);
  return `jqf-leap-${root}-${intent}-${contractHash}-${suffix.slice(0, 12)}`.slice(0, 48);
}
function buildLeapEntryOrder({ contractSymbol, quantity, limitPrice, clientOrderId } = {}) {
  if (!optionSymbol({symbol:contractSymbol}) || !Number.isInteger(Number(quantity)) || Number(quantity) <= 0 || !(num(limitPrice) > 0)
      || !/^jqf-leap-/.test(String(clientOrderId || ''))) throw new Error('A bounded LEAP call entry and immutable jqf-leap client ID are required.');
  return Object.freeze({ symbol:String(contractSymbol), qty:String(Number(quantity)), side:'buy', type:'limit',
    limit_price:num(limitPrice).toFixed(2), time_in_force:'day', client_order_id:String(clientOrderId) });
}
function buildLeapTargetOrder({ contractSymbol, quantity, averageEntryPremium, clientOrderId } = {}) {
  const target=num(averageEntryPremium) * 2;
  if (!optionSymbol({symbol:contractSymbol}) || !Number.isInteger(Number(quantity)) || Number(quantity) <= 0
      || !/^jqf-leap-/.test(String(clientOrderId || '')) || !(target > 0)) {
    throw new Error('A confirmed positive average entry premium, quantity, and immutable jqf-leap client ID are required.');
  }
  return Object.freeze({ symbol:String(contractSymbol), qty:String(Number(quantity)), side:'sell', type:'limit',
    limit_price:target.toFixed(2), time_in_force:'gtc', client_order_id:String(clientOrderId) });
}
module.exports = { selectLeapContract, discoverLeapContract:selectLeapContract, normalizeOptionQuote, quotePassesLeapGates,
  calculateLeapContracts, calculateLeapQuantity:calculateLeapContracts, immutableLeapClientOrderId, createLeapClientOrderId:immutableLeapClientOrderId,
  buildLeapEntryOrder, buildLeapTargetOrder };