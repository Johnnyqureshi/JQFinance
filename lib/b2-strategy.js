'use strict';

// B2 uses completed DAILY simple moving averages, never an intraday MA proxy.
// These thresholds are server-owned; only a dollar position cap is editable.
const B2_RULES = Object.freeze({
  fastPeriod: 20,
  slowPeriod: 50,
  maType: 'SMA',
  timeframe: '1Day',
  dataFeed: 'sip preferred; iex permitted for Paper only',
  dataRequirement: 'Live requires consolidated SIP. Paper may consistently use Alpaca IEX when SIP is not entitled.',
  minPrice: 1,
  maxPrice: 20,
  minRelativeVolume: 2,
  minDailyGainPct: 10,
  stopLossPct: 5,
  maxPositions: 2,
  minDailyVolume: 500000,
  minAverageDollarVolume: 1000000,
  maxSpreadPct: 1,
  minTrendEfficiency: 0.25,
  maxRecentCrossovers: 2,
  minFastSlopePct: 0,
  minSlowSlopePct: -0.1,
  minPriceExpansionPct: 1.5,
  maxQuoteAgeMs: 60000,
  maxTradeAgeMs: 90000,
  // Universe pre-filter (hot list): symbols showing momentum are re-scanned
  // every cycle so a fresh crossover is not missed while the full universe
  // rotates. The per-cycle market-data budget (batchSize) is unchanged:
  // priority symbols take the first slots, rotation fills the rest.
  priorityBatchSize: 25,
  priorityMinDailyGainPct: 5,
  priorityMinRelativeVolume: 1,
  priorityMaxAgeDays: 3,
  // Profit target: when an open position's unrealized gain reaches this
  // percent, the standard exit flow closes it. Momentum names that spike
  // 10%+ usually round-trip; without a target, winners become stopped-out
  // trades. The 5% protective stop remains the safety net below.
  takeProfitPct: 15,
  confirmation: 'Last completed regular-session daily candle',
  relativeVolumeMethod: 'Current session cumulative volume / mean of the prior 20 completed sessions (not time-adjusted)',
});

const finite = value => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value));
const round = (value, places = 6) => Number.isFinite(value) ? +value.toFixed(places) : null;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

function timestamp(value) {
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  return Date.parse(value);
}

function sessionDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = timestamp(value);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function isFresh(value, now, maximum) {
  const ms = timestamp(value);
  return Number.isFinite(ms) && ms <= now + 5000 && now - ms <= maximum;
}

function crossover(previousFast, previousSlow, fast, slow) {
  if (previousFast <= previousSlow && fast > slow) return 'BULLISH';
  if (previousFast >= previousSlow && fast < slow) return 'BEARISH';
  return null;
}

function dailySeries(raw, expectedDate, completedSessionDates) {
  if (!Array.isArray(raw) || !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate || '')) {
    return { error: 'Completed-session calendar or daily bars unavailable.', bars: [] };
  }
  const bars = [];
  let previousDate = null;
  for (const rawBar of raw) {
    const date = sessionDate(rawBar?.t);
    if (!date) return { error: 'Daily bar timestamp is invalid.', bars: [] };
    // Ignore the still-forming current candle and any future bars.
    if (date > expectedDate) continue;
    if (previousDate && date <= previousDate) {
      return { error: 'Daily bars contain duplicate or out-of-order sessions.', bars: [] };
    }
    if (!['o', 'h', 'l', 'c', 'v'].every(key => finite(rawBar[key]))) {
      return { error: 'Daily OHLCV evidence is incomplete.', bars: [] };
    }
    const b = Object.fromEntries(['o', 'h', 'l', 'c', 'v'].map(key => [key, Number(rawBar[key])]));
    if (b.l <= 0 || b.o <= 0 || b.c <= 0 || b.v <= 0
      || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c) || b.h < b.l) {
      return { error: 'Daily OHLCV evidence is invalid.', bars: [] };
    }
    bars.push({ ...b, date });
    previousDate = date;
  }
  if (bars.length < 65) return { error: 'At least 65 completed daily candles are required.', bars };
  if (bars.at(-1).date !== expectedDate) return { error: 'Latest completed daily session is missing or stale.', bars };
  if (completedSessionDates !== undefined) {
    if (!Array.isArray(completedSessionDates) || completedSessionDates.length < 65) {
      return { error: 'Completed-session calendar is missing or incomplete.', bars };
    }
    let previousCalendarDate = null;
    for (const date of completedSessionDates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
        || date !== new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)
        || (previousCalendarDate && date <= previousCalendarDate)) {
        return { error: 'Completed-session calendar is malformed or out of order.', bars };
      }
      previousCalendarDate = date;
    }
    if (completedSessionDates.at(-1) !== expectedDate) {
      return { error: 'Completed-session calendar does not end at the expected session.', bars };
    }
    const actualTail = bars.slice(-65).map(bar => bar.date);
    const calendarTail = completedSessionDates.slice(-65);
    if (actualTail.length !== calendarTail.length
      || actualTail.some((date, index) => date !== calendarTail[index])) {
      return { error: 'Daily bars do not match the last 65 completed exchange sessions.', bars };
    }
  }
  // A suspended symbol cannot present a recent last bar over an otherwise
  // discontinuous history as a reliable trend. Weekend/holiday gaps are allowed.
  for (let i = Math.max(1, bars.length - 65); i < bars.length; i += 1) {
    if (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date) > 7 * 86400000) {
      return { error: 'Daily history contains an unexplained multi-session gap.', bars };
    }
  }
  return { bars, error: null };
}

function evaluateB2({
  bars: rawBars, snapshot = {}, asset = {}, now = Date.now(), expectedSessionDate,
  completedSessionDates,
} = {}) {
  const symbol = String(asset.symbol || snapshot?.symbol || '').trim().toUpperCase();
  const result = {
    symbol, eligible: false, signal: 'WAIT', crossover: null, eventId: null,
    signalDate: null, reasons: [], gates: [], metrics: {},
  };
  const gate = (name, passed, reason) => {
    const ok = passed === true;
    result.gates.push({ name, passed: ok, reason });
    if (!ok) result.reasons.push(reason);
  };
  const parsed = dailySeries(rawBars, expectedSessionDate, completedSessionDates);
  gate('Completed daily history', !parsed.error, parsed.error || 'Completed daily history is current.');
  if (parsed.error) return result;

  const bars = parsed.bars;
  const closes = bars.map(b => b.c);
  const averageAt = (index, period) => mean(closes.slice(index - period + 1, index + 1));
  const lastIndex = bars.length - 1;
  const fast = averageAt(lastIndex, 20);
  const slow = averageAt(lastIndex, 50);
  const previousFast = averageAt(lastIndex - 1, 20);
  const previousSlow = averageAt(lastIndex - 1, 50);
  const crossed = crossover(previousFast, previousSlow, fast, slow);
  result.crossover = crossed;
  result.signalDate = bars.at(-1).date;
  result.eventId = crossed ? `${symbol}:${result.signalDate}:${crossed}` : null;
  const fastSlopePct = (fast / previousFast - 1) * 100;
  const slowSlopePct = (slow / previousSlow - 1) * 100;
  const tail = bars.slice(-10);
  const net = tail.at(-1).c - tail[0].c;
  const travel = tail.slice(1).reduce((sum, b, i) => sum + Math.abs(b.c - tail[i].c), 0);
  const efficiency = travel > 0 ? net / travel : 0;
  let recentCrossovers = 0;
  for (let i = bars.length - 10; i < bars.length; i += 1) {
    if (crossover(averageAt(i - 1, 20), averageAt(i - 1, 50), averageAt(i, 20), averageAt(i, 50))) {
      recentCrossovers += 1;
    }
  }
  const earlier = bars.slice(-10, -5);
  const recent = bars.slice(-5);
  const higherHigh = Math.max(...recent.map(b => b.h)) > Math.max(...earlier.map(b => b.h));
  const higherLow = Math.min(...recent.map(b => b.l)) > Math.min(...earlier.map(b => b.l));
  const expansionPct = (tail.at(-1).c / tail[0].c - 1) * 100;
  result.metrics = {
    fastMA: round(fast), slowMA: round(slow),
    previousFastMA: round(previousFast), previousSlowMA: round(previousSlow),
    fastSlopePct: round(fastSlopePct), slowSlopePct: round(slowSlopePct),
    trendStrength: round(efficiency), higherHigh, higherLow, recentCrossovers,
    priceExpansionPct: round(expansionPct),
    crossoverQuality: round((fast - slow) / slow * 100),
  };

  // Exits do not depend on entry-volume, price, gain or trend gates. Service
  // still verifies market clock, broker identity, ownership and executable qty.
  if (crossed === 'BEARISH') {
    result.signal = 'EXIT';
    result.reasons = ['Confirmed bearish 20-day / 50-day SMA crossover; close the associated B2 long.'];
    return result;
  }

  gate('New bullish crossover', crossed === 'BULLISH', 'No new bullish 20-day / 50-day SMA crossover.');
  const quote = snapshot?.latestQuote || {};
  const trade = snapshot?.latestTrade || {};
  const day = snapshot?.dailyBar || {};
  const previousDay = snapshot?.prevDailyBar || {};
  const price = finite(trade.p) ? Number(trade.p) : NaN;
  const bid = finite(quote.bp) ? Number(quote.bp) : NaN;
  const ask = finite(quote.ap) ? Number(quote.ap) : NaN;
  const previousClose = finite(previousDay.c) ? Number(previousDay.c) : NaN;
  const dailyVolume = finite(day.v) ? Number(day.v) : NaN;
  const baseline = bars.slice(-20);
  const averageVolume = mean(baseline.map(b => b.v));
  const averageDollarVolume = mean(baseline.map(b => b.c * b.v));
  const relativeVolume = dailyVolume / averageVolume;
  const dailyGainPct = (price / previousClose - 1) * 100;
  const spreadPct = (ask - bid) / ((ask + bid) / 2) * 100;
  const today = sessionDate(now);
  const quoteFresh = isFresh(quote.t, now, B2_RULES.maxQuoteAgeMs) && sessionDate(quote.t) === today;
  const tradeFresh = isFresh(trade.t, now, B2_RULES.maxTradeAgeMs) && sessionDate(trade.t) === today;
  const prevCloseMatches = previousClose > 0 && Math.abs(previousClose - bars.at(-1).c) / previousClose <= 0.001;
  const dailyFresh = sessionDate(day.t) === today && today > expectedSessionDate;
  gate('Tradable equity', asset.tradable === true && asset.status === 'active'
    && (!asset.class || asset.class === 'us_equity') && !!symbol,
  'Security is not an active, tradable US equity.');
  gate('Halt and quote safety', asset.halted !== true && asset.trading_halted !== true
    && asset.suspended !== true && snapshot?.halted !== true
    && quoteFresh && tradeFresh && bid > 0 && ask >= bid
    && Number(quote.bs) > 0 && Number(quote.as) > 0,
  'Halted security, stale trade/quote, crossed quote, or unavailable displayed liquidity.');
  gate('Current session snapshot', dailyFresh && sessionDate(previousDay.t) === expectedSessionDate
    && prevCloseMatches, 'Daily snapshot and prior close do not match the current trading session.');
  gate('Price $1–$20', price >= 1 && price <= 20 && ask >= 1 && ask <= 20,
    'Price or executable ask is outside $1–$20.');
  gate('Relative volume ≥2x', Number.isFinite(relativeVolume) && relativeVolume >= 2,
    'Current cumulative volume is below 2× the preceding 20-session average.');
  gate('Daily gain ≥10%', Number.isFinite(dailyGainPct) && dailyGainPct >= 10 - 1e-9,
    'Stock is not up at least 10% from the previous regular-session close.');
  gate('High volume', dailyVolume >= B2_RULES.minDailyVolume,
    'Fewer than 500,000 shares have traded in the current session.');
  gate('Liquidity', averageDollarVolume >= B2_RULES.minAverageDollarVolume
    && Number.isFinite(spreadPct) && spreadPct >= 0 && spreadPct <= B2_RULES.maxSpreadPct,
  'Average dollar volume is below $1m or the bid/ask spread exceeds 1%.');
  gate('MA slopes', fastSlopePct > 0 && slowSlopePct >= B2_RULES.minSlowSlopePct,
    '20MA is not rising or 50MA is declining more than 0.1% per session.');
  gate('Price above averages', price > fast && price > slow,
    'Price is not above both daily moving averages.');
  gate('Higher highs and lows', higherHigh && higherLow,
    'The latest five-session range is not making higher highs and higher lows than the prior five.');
  gate('Directional expansion', efficiency >= B2_RULES.minTrendEfficiency
    && expansionPct >= B2_RULES.minPriceExpansionPct,
  'Ten-session price action lacks directional efficiency or meaningful expansion.');
  gate('Whipsaw filter', recentCrossovers <= B2_RULES.maxRecentCrossovers,
    'More than two MA crossovers occurred in the last ten completed sessions.');
  Object.assign(result.metrics, {
    price: round(price), bid: round(bid), ask: round(ask), spreadPct: round(spreadPct),
    dailyVolume: round(dailyVolume), averageVolume: round(averageVolume),
    averageDollarVolume: round(averageDollarVolume), relativeVolume: round(relativeVolume),
    dailyGainPct: round(dailyGainPct), volumeConfirmation: round(relativeVolume),
    liquidityScore: Number.isFinite(spreadPct) && spreadPct >= 0
      ? round(averageDollarVolume / Math.max(spreadPct, 0.01)) : null,
  });
  result.eligible = result.gates.every(g => g.passed);
  if (result.eligible) {
    result.signal = 'BUY';
    result.reasons = ['New completed-daily bullish crossover and all live entry filters passed.'];
  }
  return result;
}

function rankB2Candidates(a, b) {
  if (!!a.eligible !== !!b.eligible) return a.eligible ? -1 : 1;
  for (const field of ['relativeVolume', 'dailyGainPct', 'trendStrength', 'volumeConfirmation', 'crossoverQuality', 'liquidityScore']) {
    const score = row => finite(row?.metrics?.[field]) ? Number(row.metrics[field]) : -Infinity;
    if (score(a) !== score(b)) return score(b) > score(a) ? 1 : -1;
  }
  return String(a.symbol || '').localeCompare(String(b.symbol || ''));
}

function buildB2Entry({ symbol, ask, maxPositionDollars, buyingPower, clientOrderId } = {}) {
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol || '')) throw new Error('Invalid B2 equity symbol.');
  if (![ask, maxPositionDollars, buyingPower].every(finite)
    || Number(ask) < 1 || Number(ask) > 20
    || Number(maxPositionDollars) <= 0 || Number(buyingPower) <= 0) {
    throw new Error('B2 price or position capacity is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(clientOrderId || '')) throw new Error('Durable B2 client order ID required.');
  const limitPrice = Math.ceil(Number(ask) * 100 - 1e-8) / 100;
  const qty = Math.floor(Math.min(Number(maxPositionDollars), Number(buyingPower)) / limitPrice);
  if (qty < 1) throw new Error('Insufficient buying power or position allowance for one share.');
  // Round upward to a broker-valid cent: never intentionally risk more than 5%.
  const stopPrice = Math.ceil(limitPrice * 0.95 * 100 - 1e-8) / 100;
  return {
    // GTC applies to the attached child too: a multi-day strategy must not
    // silently lose its protective stop at the first closing bell.
    symbol, qty: String(qty), side: 'buy', type: 'limit', time_in_force: 'gtc',
    limit_price: limitPrice.toFixed(2), order_class: 'oto',
    stop_loss: { stop_price: stopPrice.toFixed(2) }, client_order_id: clientOrderId,
  };
}

module.exports = { B2_RULES, evaluateB2, rankB2Candidates, buildB2Entry, sessionDate };