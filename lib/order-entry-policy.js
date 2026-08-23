'use strict';

// Every non-PMH stock/ETF buy shares the compatible Momentum setup and
// protective-stop boundary. PMH has its own frozen-opening execution contract;
// price action remains informational there and must never alter PMH eligibility.
function requiresPriceActionForEntry({ side, isCrypto, strategy = 'generic' }) {
  return String(side || '').toLowerCase() === 'buy' && !isCrypto && strategy !== 'pmh';
}

module.exports = { requiresPriceActionForEntry };