'use strict';

const STRATEGIES = Object.freeze(['pmh', 'ultrabot3']);
const DEFAULT_POLICY = Object.freeze({
  startingCapital: 25_000,
  maxRiskPerTradePct: 0.5,
  maxPositionPct: 10,
  commissionPerShare: 0,
  minimumTradingDays: 20,
  minimumClosedTrades: 30,
  minimumConfirmedFillRate: 0.95,
  minimumProtectedTradeRate: 1,
  maximumMissingExitRate: 0,
  maximumPeriodDayDifference: 2,
  maximumEntrySlippageBps: 250,
  maximumGrossExposurePct: 100,
  maximumConcurrentRiskPct: 2,
  minimumScoreMargin: 5,
});

const finite = value => value !== null && value !== undefined
  && !(typeof value === 'string' && value.trim() === '')
  && Number.isFinite(Number(value));
const round = (value, digits = 4) => Number(Number(value).toFixed(digits));
const pct = (value, total) => total > 0 ? round(value / total * 100, 2) : null;

function normalizePolicy(policy = {}) {
  const result = { ...DEFAULT_POLICY };
  for (const key of Object.keys(result)) {
    if (finite(policy[key])) result[key] = Number(policy[key]);
  }
  if (result.startingCapital <= 0 || result.maxRiskPerTradePct <= 0 || result.maxPositionPct <= 0) {
    throw new Error('Comparison capital and risk limits must be positive.');
  }
  return Object.freeze(result);
}

function validateTrade(raw, strategy, policy) {
  if (!raw || raw.strategy !== strategy) throw new Error(`${strategy} evidence must be isolated and strategy-tagged.`);
  if (!raw.tradeId || !raw.symbol) throw new Error(`${strategy} evidence requires tradeId and symbol.`);
  const openedAt = Date.parse(raw.openedAt);
  const closedAt = Date.parse(raw.closedAt);
  if (!Number.isFinite(openedAt) || !Number.isFinite(closedAt) || closedAt < openedAt) {
    throw new Error(`${strategy} trade ${raw.tradeId} has an invalid chronological period.`);
  }
  if (raw.mode !== 'paper' && raw.mode !== 'shadow') {
    throw new Error(`${strategy} trade ${raw.tradeId} must be Paper or shadow evidence.`);
  }
  const quantity = Number(raw.quantity);
  const requestedQuantity = Number(raw.requestedQuantity ?? quantity);
  const expectedEntryPrice = Number(raw.expectedEntryPrice);
  const entryPrice = Number(raw.entryPrice);
  const exitPrice = Number(raw.exitPrice);
  const stopPrice = Number(raw.stopPrice);
  if (![quantity, requestedQuantity, expectedEntryPrice, entryPrice, exitPrice, stopPrice].every(Number.isFinite)
      || quantity <= 0 || requestedQuantity < quantity || expectedEntryPrice <= 0
      || entryPrice <= 0 || exitPrice <= 0 || stopPrice <= 0 || stopPrice >= entryPrice) {
    throw new Error(`${strategy} trade ${raw.tradeId} has incomplete price, quantity, or stop evidence.`);
  }
  if (raw.entryFillConfirmed !== true || raw.exitFillConfirmed !== true) {
    throw new Error(`${strategy} trade ${raw.tradeId} is not based on confirmed entry and exit fills.`);
  }
  const initialRisk = (entryPrice - stopPrice) * quantity;
  const notional = entryPrice * quantity;
  const entrySlippageBps = Math.abs((entryPrice - expectedEntryPrice) / expectedEntryPrice * 10_000);
  if (initialRisk > policy.startingCapital * policy.maxRiskPerTradePct / 100 + 0.01
      || notional > policy.startingCapital * policy.maxPositionPct / 100 + 0.01) {
    throw new Error(`${strategy} trade ${raw.tradeId} exceeds the shared comparison risk policy.`);
  }
  if (entrySlippageBps > policy.maximumEntrySlippageBps) {
    throw new Error(`${strategy} trade ${raw.tradeId} exceeds the shared slippage-quality limit.`);
  }
  const fees = Number(raw.fees ?? quantity * policy.commissionPerShare * 2);
  if (!Number.isFinite(fees) || fees < 0) {
    throw new Error(`${strategy} trade ${raw.tradeId} has invalid fee evidence.`);
  }
  const pnl = (exitPrice - entryPrice) * quantity - fees;
  return {
    tradeId: String(raw.tradeId),
    openedAt,
    closedAt,
    session: new Date(openedAt).toISOString().slice(0, 10),
    pnl,
    initialRisk,
    notional,
    requestedQuantity,
    quantity,
    expectedEntryPrice,
    entryPrice,
    protected: raw.protectiveOrderConfirmed === true,
    protectiveExitRequired: raw.protectiveExitRequired === true,
    protectiveExitConfirmed: raw.protectiveExitConfirmed === true,
    missingExit: raw.exitEvidenceMissing === true,
  };
}

function maxDrawdown(pnls, startingCapital) {
  let equity = startingCapital;
  let peak = equity;
  let drawdown = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return { dollars: round(drawdown, 2), pct: pct(drawdown, peak) };
}

function scoreArm(metrics) {
  const returnScore = Math.max(-25, Math.min(25, metrics.returnPct * 2.5));
  const drawdownScore = Math.max(0, 25 - metrics.maxDrawdownPct * 2.5);
  const consistencyScore = metrics.profitableSessionPct * 0.25;
  const fillScore = Math.max(0, Math.min(15, 15 - metrics.averageEntrySlippageBps * 0.5));
  const protectionScore = metrics.protectiveExitReliabilityPct * 0.1;
  return round(returnScore + drawdownScore + consistencyScore + fillScore + protectionScore, 2);
}

function validateConcurrentCapacity(strategy, trades, policy) {
  const events = trades.flatMap(trade => [
    { at: trade.openedAt, type: 'OPEN', notional: trade.notional, risk: trade.initialRisk, tradeId: trade.tradeId },
    { at: trade.closedAt, type: 'CLOSE', notional: -trade.notional, risk: -trade.initialRisk, tradeId: trade.tradeId },
  ]).sort((a, b) => a.at - b.at || (a.type === 'CLOSE' ? -1 : 1));
  let notional = 0;
  let risk = 0;
  for (const event of events) {
    notional += event.notional;
    risk += event.risk;
    if (notional > policy.startingCapital * policy.maximumGrossExposurePct / 100 + 0.01) {
      throw new Error(`${strategy} evidence exceeds shared concurrent capital at trade ${event.tradeId}.`);
    }
    if (risk > policy.startingCapital * policy.maximumConcurrentRiskPct / 100 + 0.01) {
      throw new Error(`${strategy} evidence exceeds shared concurrent risk at trade ${event.tradeId}.`);
    }
  }
}

function summarizeArm(strategy, rawTrades, policy) {
  const trades = (Array.isArray(rawTrades) ? rawTrades : [])
    .map(trade => validateTrade(trade, strategy, policy));
  const seenTradeIds = new Set();
  for (const trade of trades) {
    if (seenTradeIds.has(trade.tradeId)) {
      throw new Error(`${strategy} evidence contains duplicate tradeId ${trade.tradeId}.`);
    }
    seenTradeIds.add(trade.tradeId);
  }
  validateConcurrentCapacity(strategy, trades, policy);
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const sessions = new Map();
  for (const trade of trades) sessions.set(trade.session, (sessions.get(trade.session) || 0) + trade.pnl);
  const protectedTrades = trades.filter(trade => trade.protected);
  const requiredProtectiveExits = trades.filter(trade => trade.protectiveExitRequired);
  const confirmedProtectiveExits = requiredProtectiveExits.filter(trade => trade.protectiveExitConfirmed);
  const slippage = trades.map(trade =>
    Math.abs((trade.entryPrice - trade.expectedEntryPrice) / trade.expectedEntryPrice * 10_000));
  const realizedTrades = [...trades].sort((a, b) => a.closedAt - b.closedAt || a.openedAt - b.openedAt);
  const drawdown = maxDrawdown(realizedTrades.map(trade => trade.pnl), policy.startingCapital);
  const metrics = {
    closedTrades: trades.length,
    tradingDays: sessions.size,
    returnDollars: round(pnl, 2),
    returnPct: pct(pnl, policy.startingCapital) ?? 0,
    maxDrawdownDollars: drawdown.dollars,
    maxDrawdownPct: drawdown.pct ?? 0,
    profitableTradePct: pct(trades.filter(trade => trade.pnl > 0).length, trades.length),
    profitableSessionPct: pct([...sessions.values()].filter(value => value > 0).length, sessions.size),
    averageR: trades.length ? round(trades.reduce((sum, trade) =>
      sum + (trade.initialRisk > 0 ? trade.pnl / trade.initialRisk : 0), 0) / trades.length, 3) : null,
    confirmedFillRatePct: trades.length ? 100 : 0,
    averageEntrySlippageBps: slippage.length
      ? round(slippage.reduce((sum, value) => sum + value, 0) / slippage.length, 2) : null,
    quantityFillRatePct: pct(
      trades.reduce((sum, trade) => sum + trade.quantity, 0),
      trades.reduce((sum, trade) => sum + trade.requestedQuantity, 0)
    ),
    protectedTradePct: pct(protectedTrades.length, trades.length),
    protectiveExitReliabilityPct: requiredProtectiveExits.length
      ? pct(confirmedProtectiveExits.length, requiredProtectiveExits.length) : 100,
    missingExitRatePct: pct(trades.filter(trade => trade.missingExit).length, trades.length) ?? 0,
  };
  return {
    strategy,
    period: trades.length ? {
      start: new Date(Math.min(...trades.map(trade => trade.openedAt))).toISOString(),
      end: new Date(Math.max(...trades.map(trade => trade.closedAt))).toISOString(),
    } : null,
    metrics,
    score: scoreArm(metrics),
  };
}

function comparisonBlockers(arms, policy) {
  const blockers = [];
  for (const arm of arms) {
    const m = arm.metrics;
    if (m.tradingDays < policy.minimumTradingDays) blockers.push(`${arm.strategy} needs ${policy.minimumTradingDays} trading days.`);
    if (m.closedTrades < policy.minimumClosedTrades) blockers.push(`${arm.strategy} needs ${policy.minimumClosedTrades} closed trades.`);
    if (m.confirmedFillRatePct < policy.minimumConfirmedFillRate * 100) blockers.push(`${arm.strategy} confirmed-fill rate is too low.`);
    if ((m.protectedTradePct ?? 0) < policy.minimumProtectedTradeRate * 100) blockers.push(`${arm.strategy} protection coverage is incomplete.`);
    if (m.missingExitRatePct > policy.maximumMissingExitRate * 100) blockers.push(`${arm.strategy} has missing exit evidence.`);
  }
  if (arms.every(arm => arm.period)) {
    const day = 86_400_000;
    const starts = arms.map(arm => Date.parse(arm.period.start));
    const ends = arms.map(arm => Date.parse(arm.period.end));
    if ((Math.max(...starts) - Math.min(...starts)) / day > policy.maximumPeriodDayDifference
        || (Math.max(...ends) - Math.min(...ends)) / day > policy.maximumPeriodDayDifference) {
      blockers.push('Strategy comparison periods are not comparable.');
    }
  }
  return blockers;
}

function buildDayTradingComparison({ evidence = {}, policy: rawPolicy = {} } = {}) {
  const policy = normalizePolicy(rawPolicy);
  const arms = STRATEGIES.map(strategy => summarizeArm(strategy, evidence[strategy], policy));
  const blockers = comparisonBlockers(arms, policy);
  const ranked = [...arms].sort((a, b) => b.score - a.score);
  const scoreMargin = round(ranked[0].score - ranked[1].score, 2);
  const decisive = blockers.length === 0 && scoreMargin >= policy.minimumScoreMargin;
  return {
    comparison: 'pmh-vs-ultrabot3-research-v1',
    executionBoundary: 'READ_ONLY_PAPER_OR_SHADOW_EVIDENCE',
    policy,
    dataQuality: {
      status: blockers.length ? 'INSUFFICIENT_EVIDENCE' : 'QUALIFIED',
      blockers,
      confirmedFillsOnly: true,
      comparablePeriodRequired: true,
    },
    arms,
    decision: {
      status: decisive ? 'WINNER_SELECTED' : blockers.length ? 'INSUFFICIENT_EVIDENCE' : 'NO_CLEAR_WINNER',
      winner: decisive ? ranked[0].strategy : null,
      retire: decisive ? ranked[1].strategy : null,
      scoreMargin,
      rationale: decisive
        ? `${ranked[0].strategy} leads the shared risk-adjusted score by ${scoreMargin} points.`
        : blockers.length
          ? 'No strategy can be selected until both arms satisfy every data-quality requirement.'
          : `The ${scoreMargin}-point score margin is below the ${policy.minimumScoreMargin}-point decision threshold.`,
    },
  };
}

module.exports = {
  DEFAULT_POLICY,
  STRATEGIES,
  buildDayTradingComparison,
  normalizePolicy,
};