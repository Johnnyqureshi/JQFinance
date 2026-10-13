'use strict';

// Warrior Bot — deterministic intraday backtest engine. Pure: no I/O, no
// network, no broker calls.
//
// NO-LOOK-AHEAD BY CONSTRUCTION: the strategy is invoked per symbol per
// 1-minute bar with ctx.history = { daily, m5, m1 } where each array is
// sliced to bars with timestamps <= the current bar (m1 is exactly
// bars[0..i]). ctx.indicators and ctx.patterns are computed from those
// slices only. The strategy object never receives a reference to any bar
// after the current one, so a strategy cannot read the future even if it
// tries (history.m1[barIndex + 1] is undefined). There is no randomness
// anywhere: identical inputs produce identical reports.
//
// runBacktest({ barsBySymbol, strategy, config })
//   barsBySymbol: { SYM: { daily:[...], m5:[...], m1:[...] } } — candles
//                 {t,o,h,l,c,v}, t = ms epoch, oldest → newest.
//   strategy:     (symbol, ctx) => null | { pattern, entry, stop, target,
//                 orderType?: 'market'|'limit', pattern_name? }
//                 ctx = { symbol, bar, barIndex, history, indicators,
//                         patterns, pattern, score, regime, levels,
//                         dateKey, sessionMinutes }
//   config:       { slippageBps, commissionPerShare, riskPerTradePct,
//                 maxRiskPerTradePct, maxDailyLossPct, maxPositions,
//                 sessionStart, sessionEnd, minRR, partialAtR, partialPct,
//                 trailMethod: 'ema9'|'none', equity, regime }
//
// Execution model (long-only):
// - A signal on completed bar i fills at the open of bar i+1 (same ET
//   date) plus slippage; limit orders fill when touched, cancelled at EOD.
// - Intrabar, stops are checked before targets: if a bar's range touches
//   both, the stop wins (conservative).
// - Partial exit of partialPct at +partialAtR R, stop moved to breakeven;
//   afterwards trailMethod 'ema9' ratchets the stop to ema9 - 0.25*atr.
// - EOD flatten at the first bar >= 15:55 ET, at that bar's open.
// - Daily-loss halt: no new entries once the day's closed P&L breaches
//   -maxDailyLossPct of the day's starting equity.
// - Commissions per share on every fill leg.

const {
  computeIntraday, emaSeries, openingRange, premarketLevels, prevDayLevels,
  swingPoints, etDateKey, etMinutes, volumeFadeDetected,
} = require('./indicators');
const { detectAll } = require('./patterns');
const { scoreSetup, DEFAULT_RULES } = require('./scoring');
const { classifyRegime } = require('./regime');
const { planTrade } = require('./risk');
const { buildTradeRecord } = require('./journal');

const DEFAULT_CONFIG = Object.freeze({
  slippageBps: 5,
  commissionPerShare: 0.005,
  riskPerTradePct: 0.5,
  maxRiskPerTradePct: 1,
  maxDailyLossPct: 2,
  maxPositions: 3,
  sessionStart: '09:30',
  sessionEnd: '16:00',
  minRR: 2.0,
  partialAtR: 2,
  partialPct: 0.5,
  // Hold-the-runner (Johnny 2026-10-01), mirroring the live engine: after
  // the partial, the fixed target no longer applies to the remainder — it
  // exits on the shared volume-fade definition (indicators), the trailing
  // stop, the stop, or EOD. NOTE: this backtester MIRRORS the live exit
  // logic in lib/warrior/service.js; it does not share the code path, so
  // exit changes must be made in both places.
  holdRunners: true,
  fadeVolumeFraction: 0.6,
  fadeStallBars: 2,
  fadeBaselineBars: 20,
  // RSI take-profit (Johnny 2026-10-12), mirroring the live reconcile
  // exit: RSI(14) at/above the level closes the full remaining position.
  // Null/0 disables (the service route passes the live rule through).
  takeProfitRsi: null,
  trailMethod: 'ema9',
  equity: 25000,
  regime: null, // fixed regime override ('BULLISH'|'NEUTRAL'|'BEARISH') when index data absent
});

const EOD_FLATTEN_MINUTES = 15 * 60 + 55; // 15:55 ET

function parseSessionTime(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return fallback;
  return (+m[1]) * 60 + (+m[2]);
}
const tms = c => (typeof c.t === 'number' ? c.t : Date.parse(c.t));
const slipUp = (p, bps) => p * (1 + bps / 10000);
const slipDown = (p, bps) => p * (1 - bps / 10000);

function buildLevels(m1slice, dailySlice) {
  const or = openingRange(m1slice, 30);
  const pm = premarketLevels(m1slice);
  const pd = prevDayLevels(dailySlice);
  const swings = swingPoints(m1slice.slice(-60), 3, 3);
  return {
    supports: swings.lows.map(s => s.price),
    resistances: swings.highs.map(s => s.price),
    prevDayHigh: pd?.high ?? null, prevDayLow: pd?.low ?? null,
    premarketHigh: pm?.high ?? null, premarketLow: pm?.low ?? null,
    openingRangeHigh: or?.high ?? null, openingRangeLow: or?.low ?? null,
  };
}

function indexRegimeInput(series, barT) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const sliced = series.filter(c => tms(c) <= barT);
  if (sliced.length < 2) return null;
  const closes = sliced.map(c => +c.c);
  const e20 = emaSeries(closes, 20);
  const last = closes.length - 1;
  const dayChangePct = (closes[last] / closes[last - 1] - 1) * 100;
  return { price: closes[last], ema20: e20[last], dayChangePct };
}

function resolveRegime(barsBySymbol, barT, config) {
  const spy = barsBySymbol.SPY ? indexRegimeInput(barsBySymbol.SPY.daily, barT) : null;
  const qqq = barsBySymbol.QQQ ? indexRegimeInput(barsBySymbol.QQQ.daily, barT) : null;
  if (spy && qqq) {
    let vixChangePct = null;
    if (barsBySymbol.VIX) {
      const v = indexRegimeInput(barsBySymbol.VIX.daily, barT);
      if (v) vixChangePct = v.dayChangePct;
    }
    return { ...classifyRegime({ spy, qqq, vixChangePct }), source: 'index' };
  }
  if (['BULLISH', 'NEUTRAL', 'BEARISH'].includes(config.regime)) {
    return { regime: config.regime, reasons: ['Regime override from backtest config.'], source: 'override' };
  }
  return { regime: 'NEUTRAL', reasons: ['No index data — defaulting to neutral.'], source: 'default' };
}

function runBacktest({ barsBySymbol = {}, strategy, config = {} } = {}) {
  if (typeof strategy !== 'function') throw new Error('runBacktest: strategy must be a function.');
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const bps = +cfg.slippageBps;
  const commission = +cfg.commissionPerShare;
  const firstSignalMin = parseSessionTime(cfg.sessionStart, 570);
  const lastSignalMin = parseSessionTime(cfg.sessionEnd, 960) - 7; // fill bar must precede EOD flatten

  const symbols = Object.keys(barsBySymbol).sort();
  const data = {};
  for (const s of symbols) {
    const d = barsBySymbol[s] || {};
    const m1 = [...(d.m1 || [])].sort((a, b) => tms(a) - tms(b));
    const m5 = [...(d.m5 || [])].sort((a, b) => tms(a) - tms(b));
    const daily = [...(d.daily || [])].sort((a, b) => tms(a) - tms(b));
    // Indicators are precomputed once per symbol: every series is
    // no-look-ahead by construction (value at i uses bars[0..i] only), so
    // indFull.slice(0, i+1) is exactly what a per-prefix recompute yields.
    data[s] = { m1, m5, daily, indFull: computeIntraday(m1) };
  }

  // Chronological event queue across symbols: [barTime, symbol, barIndex].
  const events = [];
  for (const s of symbols) {
    data[s].m1.forEach((bar, i) => events.push([tms(bar), s, i]));
  }
  events.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));

  let equity = +cfg.equity;
  const startEquity = equity;
  const trades = [];
  const open = new Map();    // symbol -> position
  const pending = new Map(); // symbol -> pending entry { fillIndex, order }
  const dayState = new Map(); // dateKey -> { startEquity, pnl }

  const getDay = dateKey => {
    if (!dayState.has(dateKey)) dayState.set(dateKey, { startEquity: equity, pnl: 0 });
    return dayState.get(dateKey);
  };
  const openCount = () => open.size;

  function closePosition(pos, exitPrice, exitT, exitReason, stopKind, bar) {
    const exitSlip = Math.abs(exitPrice) * bps / 10000;
    const gross = (exitPrice - pos.entryPrice) * pos.shares;
    const comm = pos.shares * commission;
    // Net P&L = final-leg gross + banked partial P&L (net of its own costs)
    // - entry slippage/commission (on the full initial size) - exit leg costs.
    const pnl = gross + pos.partialPnlAdj - pos.entrySlipTotal - exitSlip * pos.shares
      - comm - pos.entryCommission;
    const day = getDay(pos.dateKey);
    day.pnl += pnl;
    equity += pnl;
    const holdMinutes = (exitT - pos.entryT) / 60000;
    const risk = pos.riskPerShare;
    trades.push(buildTradeRecord({
      ticker: pos.symbol,
      date: pos.dateKey,
      enteredAt: pos.entryT,
      exitedAt: exitT,
      pattern: pos.patternName,
      patternName: pos.patternName,
      patternScore: pos.patternScore,
      patternConfidence: pos.patternConfidence,
      regime: pos.regime,
      spyTrend: pos.spyTrend,
      qqqTrend: pos.qqqTrend,
      sectorTrend: null,
      entryPrice: +pos.entryPrice.toFixed(4),
      stopPrice: +pos.initialStop.toFixed(4),
      targetPrice: +pos.target.toFixed(4),
      shares: pos.initialShares,
      notional: +(pos.initialShares * pos.entryPrice).toFixed(2),
      score: pos.score,
      scoreBreakdown: pos.scoreBreakdown,
      indicators: pos.indicators,
      dayChangePct: pos.dayChangePct,
      entryReason: pos.entryReason,
      exitReason,
      exitPrice: +exitPrice.toFixed(4),
      pnl: +pnl.toFixed(2),
      pnlPct: +(pnl / (pos.initialShares * pos.entryPrice) * 100).toFixed(4),
      rMultiple: risk > 0 ? +((pnl / (risk * pos.initialShares))).toFixed(4) : null,
      mae: +pos.mae.toFixed(4),
      mfe: +pos.mfe.toFixed(4),
      maeR: risk > 0 ? +(pos.mae / risk).toFixed(4) : null,
      mfeR: risk > 0 ? +(pos.mfe / risk).toFixed(4) : null,
      holdMinutes: +holdMinutes.toFixed(2),
      slippageCost: +((pos.entrySlipTotal + exitSlip * pos.shares)).toFixed(4),
      commissionCost: +((pos.entryCommission + comm)).toFixed(4),
      orderStatus: 'filled',
      riskReward: +((pos.target - pos.plannedEntry) / risk).toFixed(4),
      stopKind,
      partialTaken: pos.partialTaken,
    }));
    open.delete(pos.symbol);
  }

  function managePosition(pos, bar, indRow, barsSoFar) {
    const bt = tms(bar);
    const mins = etMinutes(bt);
    const o = +bar.o; const h = +bar.h; const l = +bar.l;
    // Track excursions on the remaining shares.
    if (l - pos.entryPrice < pos.mae) pos.mae = l - pos.entryPrice;
    if (h - pos.entryPrice > pos.mfe) pos.mfe = h - pos.entryPrice;
    // EOD flatten.
    if (mins >= EOD_FLATTEN_MINUTES) {
      closePosition(pos, slipDown(o, bps), bt, 'eod', pos.stopKind, bar);
      return;
    }
    const risk = pos.riskPerShare;
    // Partial at +partialAtR R.
    if (!pos.partialTaken && risk > 0 && h >= pos.entryPrice + cfg.partialAtR * risk) {
      const partialQty = Math.floor(pos.shares * cfg.partialPct);
      const px = slipDown(pos.entryPrice + cfg.partialAtR * risk, bps);
      if (partialQty >= 1) {
        const proceeds = (px - pos.entryPrice) * partialQty;
        const pslip = Math.abs(px) * bps / 10000 * partialQty;
        const pcomm = partialQty * commission;
        pos.partialPnlAdj += proceeds - pslip - pcomm; // credited at final close
        pos.shares -= partialQty;
      }
      pos.partialTaken = true;
      if (pos.stop < pos.entryPrice) { pos.stop = pos.entryPrice; pos.stopKind = 'breakeven'; }
    }
    // Stop first (conservative: both touched on the same bar → stop wins).
    if (l <= pos.stop) {
      closePosition(pos, slipDown(pos.stop, bps), bt, 'stop', pos.stopKind, bar);
      return;
    }
    // Fixed target — suppressed for the runner while holdRunners is on:
    // after the partial banks, the remainder is never dumped at target.
    if (h >= pos.target && !(cfg.holdRunners && pos.partialTaken)) {
      closePosition(pos, slipDown(pos.target, bps), bt, 'target', pos.stopKind, bar);
      return;
    }
    // Trailing stop after the partial.
    if (pos.partialTaken && cfg.trailMethod === 'ema9' && indRow
      && Number.isFinite(indRow.ema9) && Number.isFinite(indRow.atr)) {
      const candidate = indRow.ema9 - 0.25 * indRow.atr;
      if (candidate > pos.stop) { pos.stop = candidate; pos.stopKind = 'trail'; }
    }
    // Volume-fade exit for the runner (shared definition with live):
    // recent volume collapsed vs its trailing baseline AND price stalled.
    // Close-based signal, so it fills at this bar's close.
    if (cfg.holdRunners && pos.partialTaken && volumeFadeDetected(barsSoFar, cfg)) {
      closePosition(pos, slipDown(+bar.c, bps), bt, 'volume_fade', pos.stopKind, bar);
      return;
    }
    // RSI take-profit (Johnny 2026-10-12), mirroring the live exit:
    // RSI(14) from the shared indicator row at/above the configured
    // level closes the FULL remaining position. Close-based signal (the
    // live engine reads the same completed-bar RSI), fills at close.
    // Checked after the other managed exits, like live: stop / target /
    // partial / trailing / fade on the same bar keep precedence.
    const tpRsi = +cfg.takeProfitRsi;
    if (Number.isFinite(tpRsi) && tpRsi > 0 && indRow && Number.isFinite(indRow.rsi) && indRow.rsi >= tpRsi) {
      closePosition(pos, slipDown(+bar.c, bps), bt, 'RSI_TAKE_PROFIT', pos.stopKind, bar);
      return;
    }
  }

  function tryFillPending(symbol, bar, dateKey) {
    const p = pending.get(symbol);
    if (!p) return;
    const bt = tms(bar);
    if (dateKey !== p.dateKey) { pending.delete(symbol); return; } // never carry overnight
    if (etMinutes(bt) >= EOD_FLATTEN_MINUTES) { pending.delete(symbol); return; }
    const o = +bar.o; const l = +bar.l;
    let fill = null;
    if (p.orderType === 'limit') {
      if (o <= p.limitPrice) fill = o;
      else if (l <= p.limitPrice) fill = p.limitPrice;
      else return; // still working
    } else {
      fill = o;
    }
    pending.delete(symbol);
    const fillPrice = slipUp(fill, bps);
    const entrySlipTotal = Math.abs(fillPrice - fill) * p.shares;
    open.set(symbol, {
      symbol, entryPrice: fillPrice, shares: p.shares, initialShares: p.shares,
      stop: p.stop, initialStop: p.stop, target: p.target,
      plannedEntry: p.entry, riskPerShare: p.entry - p.stop,
      entryT: bt, dateKey, entrySlipTotal, entryCommission: p.shares * commission,
      partialPnlAdj: 0, partialTaken: false, stopKind: 'initial',
      mae: Math.min(0, l - fillPrice), mfe: Math.max(0, +bar.h - fillPrice),
      patternName: p.patternName, patternScore: p.patternScore, patternConfidence: p.patternConfidence,
      regime: p.regime, spyTrend: p.spyTrend, qqqTrend: p.qqqTrend,
      score: p.score, scoreBreakdown: p.scoreBreakdown, indicators: p.indicators,
      dayChangePct: p.dayChangePct, entryReason: p.entryReason,
    });
    // Intrabar management of the fill bar happens once in the main loop,
    // with the fill bar's own indicator row.
  }

  function considerSignal(symbol, bar, i, ctx) {
    const mins = etMinutes(tms(bar));
    if (mins < firstSignalMin || mins > lastSignalMin) return;
    if (open.has(symbol) || pending.has(symbol)) return; // one position per symbol
    if (openCount() >= cfg.maxPositions) return;
    const day = getDay(ctx.dateKey);
    if (day.pnl <= -(cfg.maxDailyLossPct / 100) * day.startEquity) return; // daily-loss halt
    let setup = null;
    try { setup = strategy(symbol, ctx); } catch { return; }
    if (!setup) return;
    const pattern = setup.pattern || null;
    const entry = Number.isFinite(+setup.entry) ? +setup.entry
      : Number.isFinite(+pattern?.entry_price) ? +pattern.entry_price : NaN;
    const stop = Number.isFinite(+setup.stop) ? +setup.stop
      : Number.isFinite(+pattern?.stop_price) ? +pattern.stop_price : NaN;
    const target = Number.isFinite(+setup.target) ? +setup.target
      : Number.isFinite(+pattern?.target_price) ? +pattern.target_price : NaN;
    if (pattern && pattern.pattern_valid === false) return;
    if (![entry, stop, target].every(Number.isFinite) || !(entry > stop && stop > 0) || !(target > entry)) return;
    if ((target - entry) / (entry - stop) < cfg.minRR) return;
    let sizing;
    try {
      sizing = planTrade({
        entry, stop, target, equity, riskPerTradePct: cfg.riskPerTradePct,
        maxRiskPerTradePct: cfg.maxRiskPerTradePct,
      });
    } catch { return; }
    if (sizing.sharesRecommended < 1) return;
    const next = data[symbol].m1[i + 1];
    if (!next || etDateKey(tms(next)) !== ctx.dateKey) return; // no fill bar, no trade
    pending.set(symbol, {
      dateKey: ctx.dateKey,
      orderType: setup.orderType === 'limit' ? 'limit' : 'market',
      limitPrice: setup.orderType === 'limit' ? entry : null,
      entry, stop, target, shares: sizing.sharesRecommended,
      patternName: pattern?.pattern_name || setup.pattern_name || 'custom',
      patternScore: pattern?.pattern_score ?? null,
      patternConfidence: pattern?.pattern_confidence ?? null,
      regime: ctx.regime.regime, spyTrend: ctx.spyTrend, qqqTrend: ctx.qqqTrend,
      score: ctx.score.score, scoreBreakdown: ctx.score.breakdown,
      indicators: ctx.entryIndicators, dayChangePct: ctx.dayChangePct,
      entryReason: `strategy signal: ${pattern?.pattern_name || setup.pattern_name || 'custom'} @ ${ctx.dateKey} ${bar.t}`,
      indRow: ctx.indicators[ctx.indicators.length - 1],
    });
  }

  for (const [barT, symbol, i] of events) {
    const { m1, m5, daily } = data[symbol];
    const bar = m1[i];
    const dateKey = etDateKey(barT);
    // 1) Fill any pending entry at this bar's open.
    tryFillPending(symbol, bar, dateKey);
    // 2) Manage the open position intrabar.
    const pos = open.get(symbol);
    // 3) Build the no-look-ahead context: slices end at the current bar.
    const m1slice = m1.slice(0, i + 1);
    const m5slice = m5.filter(c => tms(c) <= barT);
    const dailyslice = daily.filter(c => tms(c) <= barT);
    const indicators = data[symbol].indFull.slice(0, i + 1);
    const lastInd = indicators[indicators.length - 1];
    const levels = buildLevels(m1slice, dailyslice);
    const patterns = detectAll({ candles: m1slice, ind: indicators, levels });
    const top = patterns[0] || null;
    const regime = resolveRegime(barsBySymbol, barT, cfg);
    const dayCloses = dailyslice.map(c => +c.c);
    const dayChangePct = dayCloses.length >= 2
      ? (dayCloses[dayCloses.length - 1] / dayCloses[dayCloses.length - 2] - 1) * 100 : 0;
    const e200 = emaSeries(dayCloses, 200);
    const aboveEma200Daily = e200[e200.length - 1] !== null && e200[e200.length - 1] !== undefined
      ? dayCloses[dayCloses.length - 1] > e200[e200.length - 1] : null;
    const todayBars = m1slice.filter(c => etDateKey(tms(c)) === dateKey);
    const newIntradayHigh = todayBars.length > 1
      && +bar.h >= Math.max(...todayBars.slice(0, -1).map(c => +c.h));
    const score = scoreSetup({
      pattern: top,
      ind: {
        price: +bar.c, vwap: lastInd.vwap, ema9: lastInd.ema9, ema20: lastInd.ema20,
        macd: lastInd.macd, macdHist: lastInd.macdHist,
        macdHistPrev: indicators.length > 1 ? indicators[indicators.length - 2].macdHist : null,
        rvol: lastInd.rvol,
      },
      regime: regime.regime, dayChangePct, newIntradayHigh,
      volumeExpanding: lastInd.rvol >= 1.5, aboveEma200Daily,
    }, DEFAULT_RULES);
    if (pos) managePosition(pos, bar, lastInd, m1slice);
    const ctx = {
      symbol, bar, barIndex: i,
      history: { daily: dailyslice, m5: m5slice, m1: m1slice },
      indicators, patterns, pattern: top, score, regime, levels,
      dateKey, sessionMinutes: etMinutes(barT),
      dayChangePct, newIntradayHigh,
      spyTrend: barsBySymbol.SPY ? `${regime.regime}` : null,
      qqqTrend: barsBySymbol.QQQ ? `${regime.regime}` : null,
      entryIndicators: {
        ema9: lastInd.ema9, ema20: lastInd.ema20, vwap: lastInd.vwap,
        macd: lastInd.macd, macdHist: lastInd.macdHist, atr: lastInd.atr, rvol: lastInd.rvol,
      },
    };
    considerSignal(symbol, bar, i, ctx);
  }
  // Anything still open at the end of data is flattened at the last bar's close.
  for (const pos of [...open.values()]) {
    const bars = data[pos.symbol].m1;
    const lastBar = bars[bars.length - 1];
    closePosition(pos, slipDown(+lastBar.c, bps), tms(lastBar), 'eod', pos.stopKind, lastBar);
  }
  pending.clear();

  return { report: buildReport(trades, startEquity, dayState), trades };
}

function bucketStats() { return { trades: 0, wins: 0, losses: 0, pnl: 0 }; }
function bump(bucket, trade) {
  bucket.trades += 1;
  if (trade.pnl > 0) bucket.wins += 1; else if (trade.pnl < 0) bucket.losses += 1;
  bucket.pnl = +(bucket.pnl + trade.pnl).toFixed(2);
}

function buildReport(trades, startEquity, dayState) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  // Closed-trade equity curve for drawdown; daily closes for Sharpe.
  let eq = startEquity; let peak = eq; let maxDD = 0;
  const byDate = new Map();
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    maxDD = Math.max(maxDD, peak > 0 ? (peak - eq) / peak : 0);
    const d = byDate.get(t.date) || { eq: null };
    d.eq = eq; byDate.set(t.date, d);
  }
  const dates = [...byDate.keys()].sort();
  const dailyRets = [];
  let prevEq = startEquity;
  for (const d of dates) {
    const e = byDate.get(d).eq;
    dailyRets.push(prevEq > 0 ? (e - prevEq) / prevEq : 0);
    prevEq = e;
  }
  let sharpe = 0;
  if (dailyRets.length >= 2) {
    const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
    const sd = Math.sqrt(dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyRets.length);
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  }
  let maxCW = 0; let maxCL = 0; let cw = 0; let cl = 0;
  for (const t of trades) {
    if (t.pnl > 0) { cw += 1; cl = 0; maxCW = Math.max(maxCW, cw); }
    else if (t.pnl < 0) { cl += 1; cw = 0; maxCL = Math.max(maxCL, cl); }
    else { cw = 0; cl = 0; }
  }
  const byPattern = {}; const byRegime = {}; const byHour = {}; const bySymbol = {}; const byMonth = {};
  for (const t of trades) {
    const p = t.patternName || 'unknown';
    const rg = t.regime || 'unknown';
    const hr = String(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hour12: false,
    }).format(new Date(t.enteredAt))).padStart(2, '0');
    const mo = String(t.date || '').slice(0, 7);
    for (const [map, key] of [[byPattern, p], [byRegime, rg], [byHour, hr], [bySymbol, t.ticker], [byMonth, mo]]) {
      if (!map[key]) map[key] = bucketStats();
      bump(map[key], t);
    }
  }
  for (const map of [byPattern, byRegime, byHour, bySymbol, byMonth]) {
    for (const k of Object.keys(map)) {
      const b = map[k];
      b.winRate = b.trades > 0 ? +(b.wins / b.trades).toFixed(4) : 0;
    }
  }
  const rMults = trades.map(t => t.rMultiple).filter(Number.isFinite);
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? +(wins.length / trades.length).toFixed(4) : 0,
    avgWinner: wins.length > 0 ? +(grossProfit / wins.length).toFixed(2) : 0,
    avgLoser: losses.length > 0 ? +(-grossLoss / losses.length).toFixed(2) : 0,
    profitFactor: grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(4)
      : (grossProfit > 0 ? Infinity : 0),
    expectancy: trades.length > 0 ? +(totalPnl / trades.length).toFixed(2) : 0,
    totalReturn: startEquity > 0 ? +(totalPnl / startEquity).toFixed(6) : 0,
    maxDrawdown: +maxDD.toFixed(6),
    sharpe: +sharpe.toFixed(4),
    avgR: rMults.length > 0 ? +(rMults.reduce((a, b) => a + b, 0) / rMults.length).toFixed(4) : 0,
    largestWinner: trades.length > 0 ? +Math.max(...trades.map(t => t.pnl)).toFixed(2) : 0,
    largestLoser: trades.length > 0 ? +Math.min(...trades.map(t => t.pnl)).toFixed(2) : 0,
    avgHoldMinutes: trades.length > 0
      ? +(trades.reduce((a, t) => a + (t.holdMinutes || 0), 0) / trades.length).toFixed(2) : 0,
    maxConsecWins: maxCW,
    maxConsecLosses: maxCL,
    byPattern, byRegime, byHour, bySymbol, byMonth,
  };
}

module.exports = { runBacktest, DEFAULT_CONFIG };
