'use strict';

// One process-wide policy for scanners and bot research, not a browser filter.
// Invalid configuration fails at startup rather than silently disabling safety.
function validateLiquidityPolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new TypeError('Liquidity policy is required.');
  for (const key of ['minDollarVolume', 'minShareVolume', 'pumpChangePct', 'pumpMinDollarVolume']) {
    if (typeof policy[key] !== 'number' || !Number.isFinite(policy[key]) || policy[key] < 0) {
      throw new TypeError(`Liquidity policy ${key} must be a finite nonnegative number.`);
    }
  }
  if (policy.pumpChangePct <= 0) throw new TypeError('Liquidity policy pumpChangePct must be positive.');
  if (policy.pumpMinDollarVolume < policy.minDollarVolume) {
    throw new TypeError('Liquidity policy pumpMinDollarVolume must be at least minDollarVolume.');
  }
  if (policy.maxSpreadPct !== null && (
    typeof policy.maxSpreadPct !== 'number' || !Number.isFinite(policy.maxSpreadPct) || policy.maxSpreadPct < 0
  )) throw new TypeError('Liquidity policy maxSpreadPct must be null or a finite nonnegative number.');
  return Object.freeze({ ...policy });
}

const DEFAULT_LIQUIDITY_POLICY = validateLiquidityPolicy(require('./liquidity-policy.json'));
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
  && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
function easternDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
function easternMarketState(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'CLOSED';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'CLOSED';
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 570 && minutes < 960) return 'REGULAR';
  if (minutes >= 240 && minutes < 570) return 'PRE';
  if (minutes >= 960 && minutes < 1200) return 'POST';
  return 'CLOSED';
}

/**
 * Daily/session share volume and price-times-volume (an estimated dollar
 * turnover, not actual traded notional). Spread uses the quote midpoint.
 * This is a rejection gate, never a trade recommendation or pump accusation.
 */
function evaluateLiquidity(input = {}, policy = DEFAULT_LIQUIDITY_POLICY) {
  input = input || {};
  policy = validateLiquidityPolicy(policy);
  const price = number(input.price);
  const volume = number(input.volume);
  const bid = number(input.bid);
  const ask = number(input.ask);
  const changePct = number(input.changePct);
  const now = timestamp(input.now) ?? Date.now();
  const expectedSessionDate = easternDate(now);
  const actualMarketState = easternMarketState(now);
  const declaredMarketState = typeof input.marketState === 'string' ? input.marketState.toUpperCase() : null;
  const volumeTimestamp = timestamp(input.volumeTimestamp);
  const priceTimestamp = timestamp(input.priceTimestamp);
  const quoteTimestamp = timestamp(input.quoteTimestamp);
  const volumeSessionDate = volumeTimestamp === null ? null : easternDate(volumeTimestamp);
  const priceSessionDate = priceTimestamp === null ? null : easternDate(priceTimestamp);
  const quoteSessionDate = quoteTimestamp === null ? null : easternDate(quoteTimestamp);
  const regularSession = actualMarketState === 'REGULAR'
    && (declaredMarketState === null || declaredMarketState === 'REGULAR');
  const shareVolume = volume !== null && volume >= 0 ? volume : null;
  const turnover = price !== null && price > 0 && shareVolume !== null ? price * shareVolume : null;
  const dollarVolume = Number.isFinite(turnover) ? turnover : null;
  const quoteFresh = quoteTimestamp !== null && quoteSessionDate === expectedSessionDate
    && quoteTimestamp <= now + 5000 && now - quoteTimestamp <= 60000;
  const quoteValid = regularSession && quoteFresh
    && bid !== null && ask !== null && bid > 0 && ask >= bid;
  const rawSpread = quoteValid ? ((ask - bid) / (ask / 2 + bid / 2)) * 100 : null;
  const spreadPct = Number.isFinite(rawSpread) ? rawSpread : null;
  const reasons = [];
  const codes = [];
  const reject = (code, reason) => { codes.push(code); reasons.push(reason); };

  if (!regularSession) {
    reject('SESSION_NOT_REGULAR',
      `Current-session liquidity is unavailable outside the regular market session (${declaredMarketState || actualMarketState}).`);
  }
  if (volumeTimestamp === null) {
    reject('VOLUME_TIMESTAMP_UNAVAILABLE', 'Session-volume timestamp is unavailable.');
  } else if (volumeSessionDate !== expectedSessionDate) {
    reject('VOLUME_WRONG_SESSION', 'Share volume does not belong to the current New York trading date.');
  } else if (volumeTimestamp > now + 5000) {
    reject('VOLUME_TIMESTAMP_INVALID', 'Session-volume timestamp is in the future.');
  }
  if (priceTimestamp === null) {
    reject('PRICE_TIMESTAMP_UNAVAILABLE', 'Price timestamp is unavailable.');
  } else if (priceSessionDate !== expectedSessionDate || priceTimestamp > now + 5000) {
    reject('PRICE_WRONG_SESSION', 'Price does not belong to the current New York trading date.');
  }
  if (shareVolume === null) reject('SHARE_VOLUME_UNAVAILABLE', 'Session share volume is unavailable.');
  else if (shareVolume < policy.minShareVolume) {
    reject('LOW_SHARE_VOLUME', `Session share volume ${shareVolume.toLocaleString('en-US')} is below ${policy.minShareVolume.toLocaleString('en-US')}.`);
  }
  if (dollarVolume === null) reject('DOLLAR_VOLUME_UNAVAILABLE', 'Estimated session dollar volume is unavailable.');
  else if (dollarVolume < policy.minDollarVolume) {
    reject('LOW_DOLLAR_VOLUME', `Estimated session dollar volume $${dollarVolume.toLocaleString('en-US')} is below $${policy.minDollarVolume.toLocaleString('en-US')}.`);
  }
  if (policy.maxSpreadPct !== null) {
    if (quoteTimestamp === null) {
      reject('QUOTE_TIMESTAMP_UNAVAILABLE', 'Bid/ask timestamp is unavailable; spread freshness cannot be validated.');
    } else if (quoteSessionDate !== expectedSessionDate) {
      reject('QUOTE_WRONG_SESSION', 'Bid/ask quote does not belong to the current New York trading date.');
    } else if (quoteTimestamp > now + 5000 || now - quoteTimestamp > 60000) {
      reject('QUOTE_STALE', 'Bid/ask quote is stale or has an invalid future timestamp.');
    }
    if (spreadPct === null) reject('SPREAD_UNAVAILABLE', 'Bid/ask spread is unavailable, invalid, stale, or outside the regular session; the configured spread gate cannot pass.');
    else if (spreadPct - policy.maxSpreadPct > 1e-10) {
      reject('WIDE_SPREAD', `Bid/ask spread ${spreadPct.toFixed(3)}% exceeds ${policy.maxSpreadPct}%.`);
    }
  }
  if (changePct !== null && changePct >= policy.pumpChangePct
    && (dollarVolume === null || dollarVolume < policy.pumpMinDollarVolume)) {
    reject('PUMP_LIKE_LOW_LIQUIDITY', `Pump-like risk screen: move of at least ${policy.pumpChangePct}% without $${policy.pumpMinDollarVolume.toLocaleString('en-US')} estimated session dollar volume. This is a risk heuristic, not evidence of manipulation.`);
  }
  return {
    eligible: reasons.length === 0, reasons, codes, shareVolume, dollarVolume,
    spreadPct, spreadStatus: spreadPct === null ? 'unavailable' : 'available',
    evidence: {
      now: new Date(now).toISOString(), marketState: declaredMarketState || actualMarketState,
      actualMarketState, expectedSessionDate, volumeTimestamp: volumeTimestamp === null ? null : new Date(volumeTimestamp).toISOString(),
      priceTimestamp: priceTimestamp === null ? null : new Date(priceTimestamp).toISOString(),
      quoteTimestamp: quoteTimestamp === null ? null : new Date(quoteTimestamp).toISOString(),
      volumeSessionDate, priceSessionDate, quoteSessionDate,
    },
    policy,
  };
}

module.exports = {
  DEFAULT_LIQUIDITY_POLICY, validateLiquidityPolicy, evaluateLiquidity,
  easternDate, easternMarketState,
};