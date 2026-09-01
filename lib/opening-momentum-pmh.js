'use strict';

/**
 * Opening Momentum — pre-market-high break contract.
 * This module is intentionally side-effect free: market-data collection and
 * broker execution live in server.js, while every decision is reproducible here.
 */

const DEFAULT_PMH_CONFIG = Object.freeze({
  minScore: 80,
  minRelativeVolume: 2,
  minVolumeZScore: 1.5,
  minBodyRatio: 0.55,
  maxUpperWickRatio: 0.28,
  minRoomRiskMultiple: 2,
  maxSpreadPct: 0.5,
  maxRiskDollars: 100,
  maxPositionDollars: 5000,
  maxRiskPerSharePct: 8,
  maxTradePrice: 15,
  maxTradesPerDay: 3,
  maxDailyLoss: 500,
  partialTargetR: 2,
  partialPercent: 50,
  requireMarketStrength: true,
  requireSectorStrength: false,
  requireRelativeStrength: true,
});

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function mergeConfig(config) {
  const out = { ...DEFAULT_PMH_CONFIG, ...(config || {}) };
  for (const key of Object.keys(DEFAULT_PMH_CONFIG)) {
    if (!finite(out[key]) && typeof DEFAULT_PMH_CONFIG[key] === 'number') out[key] = DEFAULT_PMH_CONFIG[key];
  }
  out.minScore = clamp(out.minScore, 0, 100);
  out.partialPercent = clamp(out.partialPercent, 1, 99);
  out.maxPositionDollars = clamp(out.maxPositionDollars, 1, 1_000_000);
  return out;
}

function candleQuality(candle) {
  if (!candle || ![candle.open, candle.high, candle.low, candle.close].every(finite)) {
    return { available: false, ok: false, reason: 'Latest completed 2-minute candle is unavailable.' };
  }
  const range = candle.high - candle.low;
  if (!(range > 0)) return { available: false, ok: false, reason: 'Latest 2-minute candle has no valid range.' };
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const bodyRatio = body / range;
  const upperWickRatio = upperWick / range;
  return {
    available: true,
    green: candle.close > candle.open,
    bodyRatio,
    upperWickRatio,
    buyingPressure: (candle.close - candle.low) / range,
    ok: candle.close > candle.open,
  };
}

function timeOfDayVolume(currentVolume, baseline) {
  if (!finite(currentVolume) || !baseline || !finite(baseline.mean) || !finite(baseline.stdDev) ||
      baseline.samples < 5 || baseline.mean <= 0) {
    return { available: false, relativeVolume: null, zScore: null, reason: 'Same-time historical volume baseline is unavailable.' };
  }
  const relativeVolume = currentVolume / baseline.mean;
  const zScore = baseline.stdDev > 0 ? (currentVolume - baseline.mean) / baseline.stdDev : null;
  if (!finite(zScore)) {
    return { available: false, relativeVolume, zScore: null, reason: 'Same-time volume variance is unavailable.' };
  }
  return { available: true, relativeVolume, zScore, samples: baseline.samples };
}

function statusForBlock(reasons, hasBreakoutTest) {
  if (reasons.some(r => /fresh|unavailable|missing|baseline|quote|2-minute/i.test(r))) return 'BLOCKED';
  if (hasBreakoutTest) return 'BREAKOUT TEST';
  return 'WAITING';
}

function evaluatePmhBreak(input = {}, suppliedConfig = {}) {
  const config = mergeConfig(suppliedConfig);
  const symbol = String(input.symbol || '').toUpperCase();
  const reasons = [];
  const fresh = input.freshness || {};
  const snapshot = input.premarket || {};
  const previous = input.previousDay || {};
  const candle = input.candle;
  const quote = input.quote || {};

  if (!symbol) reasons.push('Symbol is unavailable.');
  if (!snapshot.frozen || !finite(snapshot.high) || !finite(snapshot.low)) reasons.push('Frozen pre-market range is unavailable.');
  if (!finite(previous.close) || !finite(previous.high) || !finite(previous.low)) reasons.push('Previous-day OHLC is unavailable.');
  if (!fresh.bars || !fresh.quote) reasons.push('Required Alpaca bars or quote are stale or unavailable.');
  if (!finite(quote.price) || !finite(quote.bid) || !finite(quote.ask) || quote.ask < quote.bid) reasons.push('A valid current bid/ask quote is unavailable.');

  const openingEligible = finite(input.openingPrice) && finite(previous.close) && finite(previous.high)
    && input.openingPrice > previous.close && input.openingPrice > previous.high;
  if (finite(input.openingPrice) && finite(previous.close) && finite(previous.high) && !openingEligible) {
    reasons.push('Opening price must be above both the previous close and previous-day high.');
  }
  if (!finite(input.openingPrice)) reasons.push('Regular-session opening price is unavailable.');

  const quality = candleQuality(candle);
  if (!quality.available) reasons.push(quality.reason);
  const breakoutClose = quality.available && finite(snapshot.high) && candle.close > snapshot.high;
  const wickOnly = quality.available && finite(snapshot.high) && candle.high > snapshot.high && candle.close <= snapshot.high;
  if (wickOnly) reasons.push('Wick-only pre-market-high touch; a completed close above is required.');
  if (quality.available && !quality.green) reasons.push('Breakout candle closed red or neutral.');
  if (quality.available && quality.bodyRatio < config.minBodyRatio) reasons.push('Breakout candle body is too small.');
  if (quality.available && quality.upperWickRatio > config.maxUpperWickRatio) reasons.push('Breakout candle has excessive upper wick.');
  if (quality.available && !breakoutClose && !wickOnly) reasons.push('Waiting for a completed 2-minute close above the pre-market high.');

  const volume = timeOfDayVolume(candle?.volume, input.volumeBaseline);
  if (!volume.available) reasons.push(volume.reason);
  else {
    if (volume.relativeVolume < config.minRelativeVolume) reasons.push('Time-of-day relative volume is below the configured minimum.');
    if (volume.zScore < config.minVolumeZScore) reasons.push('Time-of-day volume z-score is below the configured minimum.');
  }

  const spreadPct = finite(quote.bid) && quote.bid > 0 && finite(quote.ask) ? ((quote.ask - quote.bid) / quote.bid) * 100 : null;
  if (!finite(spreadPct) || spreadPct > config.maxSpreadPct) reasons.push('Spread/liquidity does not meet the configured limit.');
  if (finite(quote.price) && quote.price > config.maxTradePrice) reasons.push('Price is above the configured PMH trade ceiling.');

  const entry = finite(candle?.close) ? candle.close : quote.price;
  const stop = finite(candle?.low) ? candle.low : null;
  const riskPerShare = finite(entry) && finite(stop) ? entry - stop : null;
  const riskPct = finite(riskPerShare) && entry > 0 ? (riskPerShare / entry) * 100 : null;
  if (!finite(riskPerShare) || riskPerShare <= 0) reasons.push('Breakout-low stop is invalid.');
  if (finite(riskPct) && riskPct > config.maxRiskPerSharePct) reasons.push('Breakout-low stop is too wide.');
  const roomToResistance = finite(input.resistance) && finite(entry) ? input.resistance - entry : null;
  const roomR = finite(roomToResistance) && finite(riskPerShare) && riskPerShare > 0 ? roomToResistance / riskPerShare : null;
  if (!finite(roomR)) reasons.push('Nearest resistance is unavailable.');
  else if (roomR < config.minRoomRiskMultiple) reasons.push('Not enough room to nearest resistance.');

  const market = input.market || {};
  const sector = input.sector || {};
  const relativeStrength = input.relativeStrength;
  if (config.requireMarketStrength && market.bullish !== true) reasons.push(market.available ? 'Market strength check failed.' : 'Market strength is unavailable.');
  if (config.requireSectorStrength && sector.bullish !== true) reasons.push(sector.available ? 'Sector strength check failed.' : 'Sector strength is unavailable.');
  if (config.requireRelativeStrength && relativeStrength !== true) reasons.push(relativeStrength == null ? 'Relative strength is unavailable.' : 'Relative strength check failed.');

  const maxRisk = config.maxRiskDollars;
  const riskShares = finite(riskPerShare) && riskPerShare > 0 ? Math.floor(maxRisk / riskPerShare) : 0;
  const positionShares = finite(entry) && entry > 0 ? Math.floor(config.maxPositionDollars / entry) : 0;
  const shares = Math.min(riskShares, positionShares);
  if (shares < 1) reasons.push('Risk budget cannot purchase one share at the breakout-low stop.');

  const score = clamp(
    (openingEligible ? 18 : 0) +
    (breakoutClose ? 22 : 0) +
    (quality.green ? 8 : 0) +
    (quality.bodyRatio >= config.minBodyRatio ? 8 : 0) +
    (quality.upperWickRatio <= config.maxUpperWickRatio ? 7 : 0) +
    (volume.available && volume.relativeVolume >= config.minRelativeVolume ? 12 : 0) +
    (volume.available && volume.zScore >= config.minVolumeZScore ? 8 : 0) +
    (finite(roomR) && roomR >= config.minRoomRiskMultiple ? 7 : 0) +
    (finite(spreadPct) && spreadPct <= config.maxSpreadPct ? 4 : 0) +
    (market.bullish === true ? 3 : 0) +
    (relativeStrength === true ? 3 : 0),
    0, 100
  );

  const confirmed = reasons.length === 0 && score >= config.minScore;
  const status = confirmed ? 'TRADE ELIGIBLE'
    : (breakoutClose && reasons.some(r => /risk|resistance|spread|market|sector|Relative|volume/i.test(r)) ? 'BREAKOUT CONFIRMED'
      : statusForBlock(reasons, breakoutClose || wickOnly));

  return {
    strategy: 'opening-momentum-pmh-v1',
    symbol,
    status,
    eligible: confirmed,
    score,
    config,
    reasons,
    opening: { price: input.openingPrice ?? null, eligible: openingEligible },
    previousDay: { close: previous.close ?? null, high: previous.high ?? null, low: previous.low ?? null },
    premarket: { high: snapshot.high ?? null, low: snapshot.low ?? null, volume: snapshot.volume ?? null, frozen: !!snapshot.frozen },
    candle: quality.available ? { ...candle, ...quality, closedAbovePmh: breakoutClose, wickOnly } : null,
    volume,
    quote: { price: quote.price ?? null, bid: quote.bid ?? null, ask: quote.ask ?? null, spreadPct },
    levels: { entry, stop, resistance: input.resistance ?? null, riskPerShare, riskPct, roomR },
    sizing: {
      method: 'risk',
      maxRiskDollars: maxRisk,
      maxPositionDollars: config.maxPositionDollars,
      shares,
      estimatedNotional: finite(entry) ? +(shares * entry).toFixed(2) : null,
    },
    targets: {
      partialR: config.partialTargetR,
      partialPercent: config.partialPercent,
      partialPrice: finite(entry) && finite(riskPerShare)
        ? +(entry + riskPerShare * config.partialTargetR).toFixed(4) : null,
    },
    context: { market, sector, relativeStrength: relativeStrength ?? null, atr: input.atr ?? null, ema9: input.ema9 ?? null },
    freshness: fresh,
    evaluatedAt: input.evaluatedAt || new Date().toISOString(),
  };
}

function evaluatePmhRunnerExit({ candle, pmh, ema9, momentumCollapsed = false, majorReversal = false, stopHit = false } = {}) {
  if (!candle || !finite(candle.close)) return { exit: false, reason: 'Awaiting a completed 2-minute candle.' };
  if (stopHit) return { exit: true, reason: 'Protective stop confirmed.' };
  if (finite(ema9) && candle.close < ema9) return { exit: true, reason: 'Completed 2-minute close below 9 EMA.' };
  if (finite(pmh) && candle.close < pmh) return { exit: true, reason: 'Completed 2-minute close back below pre-market high.' };
  if (momentumCollapsed) return { exit: true, reason: 'Confirmed momentum collapse.' };
  if (majorReversal) return { exit: true, reason: 'Major reversal confirmed.' };
  return { exit: false, reason: 'Runner remains active.' };
}

function pmhRegularSessionOpenAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(fields.weekday);
  const minutes = Number(fields.hour) * 60 + Number(fields.minute);
  return weekday && Number.isFinite(minutes) && minutes >= 570;
}

function calculatePmhBoundedEntry({
  ask,
  quoteAt,
  now = new Date(),
  stop,
  resistance,
  config: suppliedConfig = DEFAULT_PMH_CONFIG,
  maxTradePrice = Infinity,
  maxQuoteAgeMs = 15 * 1000,
  slippageBps = 25,
} = {}) {
  const config = mergeConfig(suppliedConfig);
  const reasons = [];
  const executableAsk = Number(ask);
  const quoteTime = new Date(quoteAt || 0).getTime();
  const nowTime = new Date(now).getTime();
  const quoteAge = nowTime - quoteTime;
  if (!(executableAsk > 0) || !Number.isFinite(quoteTime) || !Number.isFinite(nowTime)
      || quoteAge < 0 || quoteAge > maxQuoteAgeMs) {
    reasons.push('Fresh executable Alpaca ask is unavailable; PMH order blocked.');
  }

  const cap = executableAsk * (1 + Number(slippageBps) / 10_000);
  // Alpaca equity prices use cents. Round down to keep the actual limit at or
  // below the slippage cap, while retaining a marketable price when possible.
  const marketableEntry = Math.ceil((executableAsk - 1e-9) * 100) / 100;
  let entry = Math.floor((cap + 1e-9) * 100) / 100;
  if (entry < marketableEntry) entry = marketableEntry;
  if (!(entry > 0) || entry > cap + 1e-9) reasons.push('Executable quote cannot produce a bounded marketable limit.');

  const stopPrice = Number(stop);
  const resistancePrice = Number(resistance);
  const riskPerShare = entry - stopPrice;
  const riskPct = entry > 0 ? riskPerShare / entry * 100 : Infinity;
  if (!(riskPerShare > 0) || !Number.isFinite(riskPerShare)) reasons.push('Fresh quote invalidates the configured stop.');
  if (riskPct > config.maxRiskPerSharePct) reasons.push('Fresh quote makes the stop too wide.');
  if (!Number.isFinite(resistancePrice)
      || resistancePrice - entry < riskPerShare * config.minRoomRiskMultiple) {
    reasons.push('Fresh quote invalidates the configured resistance-risk gate.');
  }
  if (entry > Math.min(Number(maxTradePrice), config.maxTradePrice)) {
    reasons.push('Fresh quote exceeds the configured PMH trade ceiling.');
  }

  const riskShares = riskPerShare > 0 ? Math.floor(config.maxRiskDollars / riskPerShare) : 0;
  const positionShares = entry > 0 ? Math.floor(config.maxPositionDollars / entry) : 0;
  const shares = Math.min(riskShares, positionShares);
  if (!Number.isInteger(shares) || shares < 1) reasons.push('Risk sizing produced less than one whole share.');

  return {
    eligible: reasons.length === 0,
    reasons,
    ask: Number.isFinite(executableAsk) ? executableAsk : null,
    entry: Number.isFinite(entry) ? +entry.toFixed(2) : null,
    stop: Number.isFinite(stopPrice) ? stopPrice : null,
    resistance: Number.isFinite(resistancePrice) ? resistancePrice : null,
    riskPerShare: Number.isFinite(riskPerShare) ? riskPerShare : null,
    riskPct: Number.isFinite(riskPct) ? riskPct : null,
    shares,
    quoteAgeMs: Number.isFinite(quoteAge) ? quoteAge : null,
    maxRiskDollars: config.maxRiskDollars,
    maxPositionDollars: config.maxPositionDollars,
    slippageBps,
  };
}

function pmhActiveStopLeg(leg) {
  const type = String(leg?.type || leg?.order_type || '').toLowerCase();
  return ['stop', 'stop_limit', 'stop_loss'].includes(type);
}

function reservePmhEntryIntent(db, { userId, symbol, sessionDate, detail }) {
  const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  if (!db || !normalizedSymbol || !sessionDate) throw new Error('A complete PMH entry intent is required.');
  return db.prepare(`INSERT INTO pmh_entry_intents (user_id,symbol,session_date,status,detail)
    VALUES (?,?,?,?,?)`).run(userId, normalizedSymbol, sessionDate, 'pending', detail || null);
}

function summarizePmhTerminalExit({
  runnerQty,
  filledQty,
  filledAvgPrice,
  entryPrice,
  accountPositionQty,
} = {}) {
  const requested = Math.max(0, Number(runnerQty) || 0);
  const confirmedFilled = Math.min(requested, Math.max(0, Number(filledQty) || 0));
  const remainingRunnerQty = Math.max(0, requested - confirmedFilled);
  const availablePositionQty = Math.max(0, Number(accountPositionQty) || 0);
  const protectionQty = Math.min(remainingRunnerQty, availablePositionQty);
  const price = Number(filledAvgPrice);
  const basis = Number(entryPrice);
  const realizedPnl = confirmedFilled > 0 && Number.isFinite(price) && Number.isFinite(basis)
    ? +((price - basis) * confirmedFilled).toFixed(6)
    : 0;
  return {
    requestedRunnerQty: requested,
    confirmedFilledQty: confirmedFilled,
    remainingRunnerQty,
    availablePositionQty,
    protectionQty,
    realizedPnl,
  };
}

/**
 * Coordinate the dangerous part of a runner exit. The broker adapter is
 * deliberately injected so cancellation/fill races can be tested without
 * talking to Alpaca. Every uncertain state returns reconcile_only and never
 * submits a discretionary sell.
 */
async function managePmhRunnerExit({
  broker,
  symbol,
  entryOrderId,
  entryClientOrderId,
  exitClientOrderId,
  maxQty,
  stopPrice,
  parent,
} = {}) {
  const reconcileOnly = (reason, extra = {}) => ({
    action: 'reconcile_only',
    reason,
    ...extra,
  });
  if (!broker || !Array.isArray(parent?.legs)) {
    return reconcileOnly('Runner protection is unavailable; broker state requires reconciliation.');
  }

  const activeStops = parent.legs.filter(leg =>
    pmhActiveStopLeg(leg) && ['new', 'accepted', 'pending_new'].includes(String(leg.status || '').toLowerCase())
  );
  for (const leg of activeStops) {
    try {
      await broker.cancelOrder(leg.id);
      const settled = await broker.getOrder(leg.id);
      if (!['canceled', 'cancelled'].includes(String(settled?.status || '').toLowerCase())) {
        return reconcileOnly('Runner stop cancellation is unsettled; no discretionary sell submitted.', {
          stopCancelAmbiguous: true,
        });
      }
    } catch (error) {
      // DELETE may have raced a fill or may have succeeded before a timeout.
      // Never infer cancellation and never submit a second sell.
      return reconcileOnly('Runner stop cancellation raced the broker; terminal state requires reconciliation.', {
        stopCancelAmbiguous: true,
        error: error.message,
      });
    }
  }

  let afterCancel;
  try {
    afterCancel = await broker.getNestedOrder(entryOrderId);
  } catch (error) {
    return reconcileOnly('Runner stop state could not be confirmed after cancellation.', {
      stopCancelAmbiguous: true,
      error: error.message,
    });
  }
  if (typeof broker.isOwned === 'function' && !broker.isOwned(afterCancel, entryClientOrderId)) {
    return reconcileOnly('Broker response cannot be bound to the PMH runner intent.', {
      stopCancelAmbiguous: true,
    });
  }
  const stopFilledDuringCancel = (afterCancel?.legs || []).some(leg =>
    pmhActiveStopLeg(leg) && String(leg.status || '').toLowerCase() === 'filled'
  );
  if (stopFilledDuringCancel) {
    return reconcileOnly('Runner stop filled during cancellation; broker fill reconciliation only.', {
      stopFilledDuringCancel: true,
    });
  }
  const unsettledStops = (afterCancel?.legs || []).filter(leg => {
    if (!pmhActiveStopLeg(leg)) return false;
    return !['canceled', 'cancelled', 'rejected', 'expired'].includes(String(leg.status || '').toLowerCase());
  });
  if (unsettledStops.length) {
    return reconcileOnly('Runner stop remains active or unsettled; no discretionary sell submitted.', {
      stopCancelAmbiguous: true,
    });
  }

  let position;
  try {
    position = await broker.getPosition(symbol);
  } catch (error) {
    return reconcileOnly('Runner position could not be confirmed before exit.', { error: error.message });
  }
  const remainingQty = Math.min(Number(position?.qty), Number(maxQty));
  if (!(remainingQty > 0)) {
    return reconcileOnly('Runner position is absent; broker state requires reconciliation.');
  }

  try {
    const exitOrder = await broker.submitMarketExit({
      symbol, qty: String(remainingQty), side: 'sell', type: 'market',
      time_in_force: 'day', client_order_id: exitClientOrderId,
    });
    return { action: 'pending_exit', exitOrder, remainingQty };
  } catch (error) {
    if (typeof broker.isDefinitiveExitFailure !== 'function' || !broker.isDefinitiveExitFailure(error)) {
      return {
        action: 'exit_unknown',
        exitError: error.message,
      };
    }
    let rescueOrder = null;
    let rescueQty = 0;
    let rescueError = null;
    try {
      const rescuePosition = await broker.getPosition(symbol);
      rescueQty = Math.min(Number(rescuePosition?.qty), Number(maxQty));
      if (rescueQty > 0 && Number(stopPrice) > 0) {
        if (typeof broker.beforeProtectiveStop === 'function') {
          await broker.beforeProtectiveStop({ symbol, rescueQty, stopPrice });
        }
        rescueOrder = await broker.submitProtectiveStop({
          symbol, qty: String(rescueQty), side: 'sell', type: 'stop',
          time_in_force: 'day', stop_price: Number(stopPrice).toFixed(2),
        });
      }
    } catch (restoreError) {
      rescueError = restoreError.message;
    }
    return {
      action: rescueOrder ? 'protected_after_exit_failure' : 'exit_failed',
      exitError: error.message,
      rescueOrder,
      rescueQty,
      rescueError,
    };
  }
}

/**
 * Reconciliation is deliberately first. Entry gates may pause automation, live
 * arming, or market-hours submissions, but they must not strand broker-owned
 * positions and unresolved PMH orders.
 */
async function preparePmhManagedCycle({
  reconcile,
  botEnabled,
  settingsEnabled,
  mode,
  liveArmed,
  livePaused,
  marketOpen,
} = {}) {
  if (typeof reconcile !== 'function') throw new Error('PMH reconciliation callback is required.');
  const reconciliation = await reconcile();
  const reconciled = Array.isArray(reconciliation?.reconciled)
    ? reconciliation.reconciled.length
    : Number(reconciliation?.reconciled || 0);
  const blocked = (status, reason) => ({ allowEntry: false, status, reason, reconciled, reconciliation });
  if (!botEnabled || !settingsEnabled) {
    return blocked('reconciled_paused', 'New PMH entries are disabled; existing broker state was reconciled.');
  }
  if (mode === 'live' && livePaused) {
    return blocked('reconciled_live_paused', 'PMH live entries are paused; existing broker state was reconciled.');
  }
  if (mode === 'live' && !liveArmed) {
    return blocked('reconciled_live_unarmed', 'PMH live entries are not armed; existing broker state was reconciled.');
  }
  if (!marketOpen) {
    return blocked('reconciled', 'Existing broker state was reconciled outside the entry window.');
  }
  return { allowEntry: true, status: 'ready_for_entry_scan', reason: null, reconciled, reconciliation };
}

module.exports = {
  DEFAULT_PMH_CONFIG,
  candleQuality,
  timeOfDayVolume,
  evaluatePmhBreak,
  evaluatePmhRunnerExit,
  pmhRegularSessionOpenAt,
  calculatePmhBoundedEntry,
  pmhActiveStopLeg,
  reservePmhEntryIntent,
  summarizePmhTerminalExit,
  managePmhRunnerExit,
  preparePmhManagedCycle,
};