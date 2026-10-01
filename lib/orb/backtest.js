'use strict';

// ORB Bot — Opening Range Breakout point-in-time, no-look-ahead backtester.
//
// Pure: no I/O, no network, no Date.now(), no randomness. Identical inputs
// produce identical outputs. The ONLY strategy dependency is ./engine.js —
// the same shared engine used by paper and live — so backtest results reflect
// the real entry/exit logic (evaluateEntry / planExit / daily locks).
//
// POINT-IN-TIME DISCIPLINE (by construction):
//   - The simulation walks forward day by day, and within a day walks the
//     merged 1-minute bar stream in ascending (t, symbol) order.
//   - For each candidate entry tick T, evaluateEntry receives ONLY bars with
//     t <= T (bars truncated at the tick), nowMs = T, the opening range
//     computed from that morning's bars only (computeOpeningRange filters the
//     [9:30, 9:30+orMinutes) ET window), premarket/prior-day features built
//     from data strictly before T, and regime from prior-day index closes.
//   - A bar with t > decisionTime is NEVER used for any decision input:
//     entries are never evaluated before the OR completes (the stream starts
//     at or.endMs and the engine itself rejects OR_INCOMPLETE), and position
//     management only walks bars after the entry bar.
//   - Volume profile (RVOL), average volume, ATR, prior high/low and prior
//     close are all derived from dates STRICTLY before the trade date.
//
// EXECUTION MODEL:
//   - Entry fills at the decision bar's CLOSE +/- adverse slippage
//     (slippageBps). Longs pay up, shorts get a worse (lower) fill.
//   - Exits are conservative intrabar against the engine's stop/target plan:
//     stop is checked BEFORE targets, so when one bar touches both, the stop
//     wins (the worse fill for the direction). Long: bar low <= stop ->
//     stopped at the stop price; bar high >= target -> filled at target.
//     Short mirrors this.
//   - Target partials fill `pct` of the original share count at the target
//     price (adverse slippage), capped at the remaining shares; the final leg
//     (stop / EOD / last target) closes the remainder.
//   - Breakeven moves and trailing-stop tightening come from engine.planExit
//     evaluated per bar on the bar close (priority: stop exit > target
//     partial > breakeven > trail > hold).
//   - Positions never carry overnight: anything still open is flattened at
//     the first bar at/after 15:55 ET, or at the day's last bar as a safety
//     net.
//   - Daily locks (engine.checkDailyLocks / recordTradeResult) are maintained
//     per ET date: max daily loss, max trades/day, max consecutive losses,
//     max concurrent positions, max exposure, max trades/symbol. No new
//     entries while locked. openPositions/exposureDollars are tracked
//     intraday on top of the engine's immutable recordTradeResult transition.
//   - Commissions: commissionPerShare per share on the entry leg and on every
//     exit leg (partials included).
//
// ASSUMPTIONS (documented, no invented market data beyond these):
//   - 1-minute bars carry no spread, so the backtest assumes a constant
//     0.05% spread (ASSUMED_SPREAD_PCT), comfortably inside the default
//     maxSpreadPct of 0.3%. Real spread data would flow through ctx.spreadPct.
//   - hasMaterialNews is always false (no news feed in bar data); a live
//     newsPolicy=block setup would reject more trades than this backtest.
//   - VWAP is the session (from 9:30 ET) cumulative typical-price VWAP.
//   - Relative strength vs SPY = symbol's day-change % at the tick minus
//     SPY's prior-day change % (intraday SPY is unavailable in daily
//     indexData, so the prior-day momentum proxy is used).
//   - ATR(14) (Wilder) is computed from daily bars aggregated out of the
//     1-minute bars of prior dates; with fewer than 14 prior days it seeds
//     from whatever history exists (minimum 1 day).
//   - A symbol-day is skipped when its reference price (prior close, else the
//     day's first close) falls outside rules.minPrice/maxPrice.

const {
  DEFAULT_ORB_RULES,
  computeOpeningRange,
  classifyRegime,
  evaluateEntry,
  planExit,
  checkDailyLocks,
  recordTradeResult,
  _et: { easternDate, easternTimeMinutes },
} = require('./engine');

const DEFAULT_BACKTEST_CONFIG = Object.freeze({
  initialEquity: 100000,
  slippageBps: 5,
  commissionPerShare: 0.005,
});

const OR_MINUTES_ALLOWED = new Set([5, 15, 30]);
const SESSION_OPEN_MIN = 9 * 60 + 30; // 9:30 ET
const EOD_FLATTEN_MIN = 15 * 60 + 55; // 15:55 ET
const ASSUMED_SPREAD_PCT = 0.05;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
const finite = v => (v === null || v === undefined || v === '')
  ? null
  : (Number.isFinite(+v) ? +v : null);
const r2 = v => (Number.isFinite(+v) ? +(+v).toFixed(2) : 0);
const r4 = v => (Number.isFinite(+v) ? +(+v).toFixed(4) : 0);

function mergeRules(rules) {
  const src = rules && typeof rules === 'object' ? rules : {};
  const r = { ...DEFAULT_ORB_RULES, ...src };
  r.weights = { ...DEFAULT_ORB_RULES.weights, ...(src.weights || {}) };
  r.targets = (Array.isArray(src.targets) && src.targets.length
    ? src.targets
    : DEFAULT_ORB_RULES.targets).map(t => ({ ...t }));
  return r;
}

function freshDayState(date) {
  return {
    date, pnl: 0, trades: 0, consecLosses: 0,
    openPositions: 0, exposureDollars: 0, tradesBySymbol: {},
  };
}

// Buckets (spec): score -> '75-79','80-84','85-89','90-100';
// rvol -> '1.5-2','2-3','3+'; time of day -> entry windows.
function scoreBucketOf(s) {
  const v = +s;
  if (v >= 90) return '90-100';
  if (v >= 85) return '85-89';
  if (v >= 80) return '80-84';
  if (v >= 75) return '75-79';
  return 'below-75';
}
function rvolBucketOf(v) {
  const x = +v;
  if (x >= 3) return '3+';
  if (x >= 2) return '2-3';
  return '1.5-2';
}
function timeBucketOf(min) {
  if (min >= 585 && min < 630) return '9:45-10:30';
  if (min >= 630 && min < 690) return '10:30-11:30';
  if (min >= 840 && min < 930) return '14:00-15:30';
  return 'other';
}

// ---------------------------------------------------------------------------
// History builders — prior-date aggregates from 1-minute bars.
// ---------------------------------------------------------------------------
function aggregateDaily(bars) {
  const map = new Map();
  for (const b of bars) {
    const d = easternDate(b.t);
    if (!d) continue;
    let a = map.get(d);
    if (!a) {
      a = { date: d, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: 0, firstT: b.t, lastT: b.t };
      map.set(d, a);
    } else {
      if (+b.h > a.h) a.h = +b.h;
      if (+b.l < a.l) a.l = +b.l;
      if (b.t < a.firstT) { a.o = +b.o; a.firstT = b.t; }
      if (b.t >= a.lastT) { a.c = +b.c; a.lastT = b.t; }
    }
    const v = +b.v;
    if (Number.isFinite(v) && v > 0) a.v += v;
  }
  return [...map.values()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

// Wilder ATR(14) over prior daily true ranges. Seeds from whatever history
// exists (minimum 1 day); null when there is no prior day at all.
function atrFromDaily(priorDaily) {
  if (!priorDaily.length) return null;
  const trs = priorDaily.map((d, i) => {
    const prevClose = i > 0 ? priorDaily[i - 1].c : d.o;
    return Math.max(d.h - d.l, Math.abs(d.h - prevClose), Math.abs(d.l - prevClose));
  });
  const n = Math.min(14, trs.length);
  let atr = trs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
  return atr > 0 ? atr : null;
}

// Prior-day index closes for the regime: change % uses closes strictly
// before D (D-1 vs D-2); VIX level is the D-1 close.
function priorPair(series, D) {
  const arr = (Array.isArray(series) ? series : [])
    .slice()
    .sort((a, b) => a.t - b.t)
    .filter(b => easternDate(b.t) < D);
  const p1 = arr[arr.length - 1];
  const p2 = arr[arr.length - 2];
  return { c1: p1 ? finite(p1.c) : null, c2: p2 ? finite(p2.c) : null };
}
const chgPct = ({ c1, c2 }) => (c1 !== null && c2 !== null && c2 !== 0)
  ? ((c1 - c2) / c2) * 100 : null;

function regimeForDate(indexData, D) {
  const spy = priorPair(indexData.spy, D);
  const qqq = priorPair(indexData.qqq, D);
  const iwm = priorPair(indexData.iwm, D);
  const vix = priorPair(indexData.vix, D);
  const classified = classifyRegime({
    spyChangePct: chgPct(spy),
    qqqChangePct: chgPct(qqq),
    iwmChangePct: chgPct(iwm),
    vix: vix.c1,
    vixChangePct: chgPct(vix),
  });
  return { regime: classified.regime, spyPriorChange: chgPct(spy) };
}

// ---------------------------------------------------------------------------
// Per (symbol, date) preparation. Returns null when the symbol-day cannot
// produce a valid setup (no bars, no opening range, outside price band).
// ---------------------------------------------------------------------------
function prepareSymbolDay(s, D, bars, dailyAgg, indexData, r, om, profiles) {
  const dayBars = bars.filter(b => easternDate(b.t) === D);
  if (dayBars.length === 0) return null;

  // Opening range from THIS morning's bars only. computeOpeningRange filters
  // the [9:30 ET, 9:30+om ET) window internally; passing only date-D bars
  // keeps it strictly point-in-time.
  const or = computeOpeningRange(dayBars, om);
  if (or.error) return null;

  const priorDaily = dailyAgg.filter(d => d.date < D);
  const prior = priorDaily.length ? priorDaily[priorDaily.length - 1] : null;

  // Universe price band on the reference price (prior close, else day open).
  const refPrice = prior ? prior.c : finite(dayBars[0].c);
  if (refPrice === null || !(refPrice >= r.minPrice && refPrice <= r.maxPrice)) return null;

  const n = dayBars.length;
  const clockMin = new Array(n);
  const cumVol = new Array(n);
  const vwNum = new Array(n);
  const vwDen = new Array(n);
  let cv = 0;
  let vn = 0;
  let vd = 0;
  for (let i = 0; i < n; i++) {
    const b = dayBars[i];
    const cm = easternTimeMinutes(b.t);
    clockMin[i] = cm;
    const v = +b.v;
    cv += Number.isFinite(v) && v > 0 ? v : 0;
    cumVol[i] = cv;
    if (cm >= SESSION_OPEN_MIN) {
      const typ = ((+b.h) + (+b.l) + (+b.c)) / 3;
      const vv = Number.isFinite(v) && v > 0 ? v : 0;
      vn += typ * vv;
      vd += vv;
    }
    vwNum[i] = vn;
    vwDen[i] = vd;
  }

  const regime = regimeForDate(indexData, D);
  return {
    symbol: s, date: D, dayBars, or, om,
    prior, priorDaily,
    atr: atrFromDaily(priorDaily),
    avgVolume: priorDaily.length
      ? priorDaily.reduce((a, d) => a + d.v, 0) / priorDaily.length : null,
    levels: { priorHigh: prior ? prior.h : null, priorLow: prior ? prior.l : null },
    regime: regime.regime,
    spyPriorChange: regime.spyPriorChange,
    clockMin, cumVol, vwNum, vwDen,
    profiles, // symbol -> date -> {mins, vols} cumulative volume profiles
  };
}

function vwapAt(prep, i) {
  return prep.vwDen[i] > 0 ? prep.vwNum[i] / prep.vwDen[i] : null;
}

// RVOL at bar i: cumulative volume so far today vs the mean cumulative
// volume at the same ET clock time across prior dates (strictly before D).
function rvolAt(prep, i) {
  const prof = prep.profiles.get(prep.symbol);
  if (!prof) return null;
  const cm = prep.clockMin[i];
  const vals = [];
  for (const [d, p] of prof) {
    if (d >= prep.date) continue;
    let lo = 0;
    let hi = p.mins.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (p.mins[mid] <= cm) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans >= 0) vals.push(p.vols[ans]);
  }
  if (!vals.length) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return mean > 0 ? prep.cumVol[i] / mean : null;
}

function premarketOf(prep) {
  let first = null;
  let last = null;
  let firstSess = null;
  for (let i = 0; i < prep.dayBars.length; i++) {
    const b = prep.dayBars[i];
    if (prep.clockMin[i] < SESSION_OPEN_MIN) {
      if (!first) first = b;
      last = b;
    } else if (!firstSess) {
      firstSess = b;
    }
  }
  let trend = 'flat';
  if (first && last && first !== last) {
    const ch = (finite(last.c) / finite(first.c) - 1) * 100;
    trend = ch > 0.1 ? 'up' : ch < -0.1 ? 'down' : 'flat';
  }
  const gapPct = (firstSess && prep.prior && finite(firstSess.o) !== null)
    ? ((finite(firstSess.o) / prep.prior.c) - 1) * 100 : null;
  return { trend, gapPct };
}

// ---------------------------------------------------------------------------
// Entry decision at one candidate tick: evaluateEntry once per direction
// with bars truncated at the tick and nowMs = tick time. Returns the
// accepted entry plan or null.
// ---------------------------------------------------------------------------
function decideEntry(prep, i, attempts, equity, r, X) {
  const bar = prep.dayBars[i];
  const tau = bar.t;
  const barsSoFar = prep.dayBars.slice(0, i + 1); // truncated at the tick
  const vwap = vwapAt(prep, i);
  const rvol = rvolAt(prep, i);
  const priorClose = prep.prior ? prep.prior.c : null;
  const symChg = priorClose !== null && finite(bar.c) !== null
    ? ((finite(bar.c) / priorClose) - 1) * 100 : null;
  const relStrengthVsSpy = (symChg !== null && prep.spyPriorChange !== null)
    ? symChg - prep.spyPriorChange : null;

  const base = {
    symbol: prep.symbol,
    bars: barsSoFar,
    or: prep.or,
    vwap,
    rvol,
    avgVolume: prep.avgVolume,
    spreadPct: ASSUMED_SPREAD_PCT,
    relStrengthVsSpy,
    regime: prep.regime,
    atr: prep.atr,
    premarket: premarketOf(prep),
    levels: prep.levels,
    lastAttempts: attempts,
    accountEquity: equity,
    hasMaterialNews: false,
    nowMs: tau,
    rules: r,
  };

  let best = null;
  for (const direction of ['long', 'short']) {
    let res;
    try {
      res = evaluateEntry({ ...base, direction });
    } catch (_) {
      continue; // engine fail-closes; a throwing gate is a non-entry
    }
    if (!res || res.decision === 'wait') continue;
    if (!best || res.score > best.res.score
        || (res.score === best.res.score && direction < best.direction)) {
      best = { direction, res };
    }
  }
  if (!best) return null;

  const { direction, res } = best;
  const long = direction === 'long';
  const close = finite(bar.c);
  if (close === null || !(res.size && res.size.shares >= 1)) return null;
  // Entry fills at the decision bar's close +/- adverse slippage.
  const fill = long ? X.slipBuy(close) : X.slipSell(close);
  return {
    direction, long, res,
    entryT: tau, refClose: close, fill,
    shares: res.size.shares,
    stop: res.stop, targets: res.targets,
    score: res.score, rvolEntry: rvol,
  };
}

// ---------------------------------------------------------------------------
// Position management — conservative intrabar stop/target handling driven by
// the engine's stop/target plan, with breakeven/trailing from planExit.
// ---------------------------------------------------------------------------
function openPosition(plan, prep, X) {
  const shares = plan.shares;
  return {
    symbol: prep.symbol, date: prep.date,
    direction: plan.direction, long: plan.long,
    entryT: plan.entryT, refClose: plan.refClose, fill: plan.fill,
    sharesOrig: shares, sharesLeft: shares,
    stop: plan.stop, stopInit: plan.stop,
    targets: (plan.targets || []).slice(),
    taken: [],
    legs: [],
    beMoved: false,
    entrySlip: Math.abs(plan.fill - plan.refClose) * shares,
    entryComm: shares * X.cps,
    score: plan.score,
    rvolEntry: plan.rvolEntry,
    regime: prep.regime,
    orMinutes: prep.om,
    entryClockMin: easternTimeMinutes(plan.entryT),
    why: plan.res.why,
    notional: shares * plan.fill,
  };
}

function applyLeg(pos, ref, px, shares, kind, t) {
  pos.legs.push({ ref, px, shares, kind, t });
  pos.sharesLeft -= shares;
}

function closePosition(pos, exitReason, X) {
  const dirSign = pos.long ? 1 : -1;
  let gross = 0;
  let slipCost = 0;
  let comm = pos.entryComm;
  let exitNotional = 0;
  let exitShares = 0;
  for (const leg of pos.legs) {
    gross += dirSign * (leg.px - pos.fill) * leg.shares;
    slipCost += Math.abs(leg.px - leg.ref) * leg.shares;
    comm += leg.shares * X.cps;
    exitNotional += leg.px * leg.shares;
    exitShares += leg.shares;
  }
  const pnl = gross - pos.entrySlip - slipCost - comm;
  const riskPerShare = Math.abs(pos.fill - pos.stopInit);
  const rMultiple = riskPerShare > 0 ? pnl / (riskPerShare * pos.sharesOrig) : 0;
  const lastLeg = pos.legs[pos.legs.length - 1];
  return {
    symbol: pos.symbol,
    date: pos.date,
    direction: pos.direction,
    entryTime: pos.entryT,
    exitTime: lastLeg ? lastLeg.t : pos.entryT,
    entryPrice: r4(pos.fill),
    exitPrice: exitShares > 0 ? r4(exitNotional / exitShares) : r4(pos.fill),
    shares: pos.sharesOrig,
    pnl: r2(pnl),
    rMultiple: r4(rMultiple),
    score: pos.score,
    scoreBucket: scoreBucketOf(pos.score),
    rvol: r4(pos.rvolEntry),
    rvolBucket: rvolBucketOf(pos.rvolEntry),
    regime: pos.regime,
    orMinutes: pos.orMinutes,
    entryTimeBucket: timeBucketOf(pos.entryClockMin),
    entryReason: pos.why,
    exitReason,
  };
}

// Walk one bar of the position's symbol. Returns the finalized trade record
// when the position closes, else null.
function manageBar(pos, prep, i, r, X) {
  const bar = prep.dayBars[i];
  const cm = prep.clockMin[i];
  const close = finite(bar.c);
  const exitPx = ref => (pos.long ? X.slipSell(ref) : X.slipBuy(ref));

  // 1) EOD flatten — positions never carry overnight.
  if (cm >= EOD_FLATTEN_MIN) {
    const ref = finite(bar.o) !== null ? finite(bar.o) : close;
    applyLeg(pos, ref, exitPx(ref), pos.sharesLeft, 'eod-flatten', bar.t);
    return closePosition(pos, 'eod-flatten', X);
  }

  // 2) Stop — checked BEFORE targets; when one bar touches both, the stop
  //    wins (the worse fill for the direction).
  const stopHit = pos.long ? finite(bar.l) <= pos.stop : finite(bar.h) >= pos.stop;
  if (stopHit) {
    applyLeg(pos, pos.stop, exitPx(pos.stop), pos.sharesLeft, 'stop', bar.t);
    return closePosition(pos, 'stop', X);
  }

  // 3) Targets, nearest-first. Each fills `pct` of the ORIGINAL share count.
  for (const tg of pos.targets) {
    if (pos.taken.includes(tg.r)) continue;
    const tagged = pos.long ? finite(bar.h) >= tg.price : finite(bar.l) <= tg.price;
    if (!tagged) continue;
    pos.taken.push(tg.r);
    const want = Math.min(
      pos.sharesLeft,
      Math.floor((pos.sharesOrig * (+tg.pct || 0)) / 100)
    );
    if (want >= 1) applyLeg(pos, tg.price, exitPx(tg.price), want, 'target', bar.t);
    if (pos.sharesLeft <= 0) return closePosition(pos, 'target', X);
  }

  // 4) Breakeven / trailing via the shared engine (bar close).
  if (close !== null) {
    const pe = planExit(
      {
        direction: pos.direction,
        entry: pos.fill,
        stop: pos.stop,
        targets: pos.targets,
        size: pos.sharesOrig,
        breakevenAt: pos.beMoved ? true : 0,
        partialsTaken: pos.taken.slice(),
        breakevenR: +r.breakevenR > 0 ? +r.breakevenR : 1,
        trailMode: r.trailMode,
        trailAtrMult: 1.5,
      },
      { price: close, vwap: vwapAt(prep, i), atr: prep.atr }
    );
    if (pe.action === 'breakeven') {
      pos.stop = pos.fill;
      pos.beMoved = true;
    } else if (pe.action === 'trail' && Number.isFinite(+pe.newStop)) {
      pos.stop = +pe.newStop;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------
function buildSummary(trades, equity0, equityCurve, startDate, endDate) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const totalPnl = r2(trades.reduce((a, t) => a + t.pnl, 0));
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const meanR = arr => (arr.length
    ? arr.reduce((a, t) => a + t.rMultiple, 0) / arr.length : 0);

  let peak = equity0;
  let maxDD = 0;
  let maxDDPct = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0) maxDDPct = Math.max(maxDDPct, (dd / peak) * 100);
  }

  return {
    startDate,
    endDate,
    initialEquity: r2(equity0),
    finalEquity: r2(equity0 + totalPnl),
    totalPnl,
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n > 0 ? r4(wins.length / n) : 0,
    avgR: r4(meanR(trades)),
    avgWinR: r4(meanR(wins)),
    avgLossR: r4(meanR(losses)),
    maxDrawdown: r2(maxDD),
    maxDrawdownPct: r4(maxDDPct),
    profitFactor: grossLoss > 0
      ? r4(grossProfit / grossLoss)
      : (grossProfit > 0 ? Infinity : 0),
  };
}

function buildBreakdown(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()]
    .map(([key, arr]) => {
      const w = arr.filter(t => t.pnl > 0).length;
      return {
        key,
        trades: arr.length,
        winRate: r4(w / arr.length),
        avgR: r4(arr.reduce((a, t) => a + t.rMultiple, 0) / arr.length),
        totalPnl: r2(arr.reduce((a, t) => a + t.pnl, 0)),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// runBacktest.
// ---------------------------------------------------------------------------
function runBacktest({
  barsBySymbol = {},
  indexData = {},
  startDate = null,
  endDate = null,
  rules = {},
  initialEquity = DEFAULT_BACKTEST_CONFIG.initialEquity,
  slippageBps = DEFAULT_BACKTEST_CONFIG.slippageBps,
  commissionPerShare = DEFAULT_BACKTEST_CONFIG.commissionPerShare,
  orMinutes,
} = {}) {
  const r = mergeRules(rules);
  const om = (orMinutes === undefined || orMinutes === null) ? +r.orMinutes : +orMinutes;
  if (!OR_MINUTES_ALLOWED.has(om)) {
    throw new Error(`runBacktest: orMinutes must be 5, 15, or 30 (got ${orMinutes}).`);
  }
  r.orMinutes = om;

  const bps = Math.max(0, +slippageBps || 0);
  const cps = Math.max(0, +commissionPerShare || 0);
  const equity0 = Number.isFinite(+initialEquity) && +initialEquity > 0
    ? +initialEquity : DEFAULT_BACKTEST_CONFIG.initialEquity;
  const X = {
    slipBuy: p => p * (1 + bps / 10000), // adverse for buys / short exits
    slipSell: p => p * (1 - bps / 10000), // adverse for sells / long exits
    cps,
  };

  // Normalize bars per symbol (ascending) + daily aggregates + volume profiles.
  const symbols = Object.keys(barsBySymbol).sort();
  const symBars = new Map();
  const symDaily = new Map();
  const symProfiles = new Map();
  const allDates = new Set();
  let firstBarT = null;
  let lastBarT = null;
  for (const s of symbols) {
    const bars = (Array.isArray(barsBySymbol[s]) ? barsBySymbol[s] : [])
      .filter(b => b && Number.isFinite(+b.t))
      .slice()
      .sort((a, b) => a.t - b.t);
    symBars.set(s, bars);
    symDaily.set(s, aggregateDaily(bars));
    const byDate = new Map();
    for (const b of bars) {
      const d = easternDate(b.t);
      if (!d) continue;
      allDates.add(d);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(b);
      if (firstBarT === null || b.t < firstBarT) firstBarT = b.t;
      if (lastBarT === null || b.t > lastBarT) lastBarT = b.t;
    }
    const prof = new Map();
    for (const [d, arr] of byDate) {
      const mins = [];
      const vols = [];
      let cv = 0;
      for (const b of arr) {
        const v = +b.v;
        cv += Number.isFinite(v) && v > 0 ? v : 0;
        mins.push(easternTimeMinutes(b.t));
        vols.push(cv);
      }
      prof.set(d, { mins, vols });
    }
    symProfiles.set(s, prof);
  }

  let dates = [...allDates].sort();
  if (startDate) dates = dates.filter(d => d >= startDate);
  if (endDate) dates = dates.filter(d => d <= endDate);

  const emptyResult = () => ({
    summary: buildSummary([], equity0, [], startDate || null, endDate || null),
    byDirection: [],
    byOrDuration: [],
    byScoreBucket: [],
    byRvolBucket: [],
    byRegime: [],
    byTimeOfDay: [],
    trades: [],
    equityCurve: [],
  });
  if (dates.length === 0) return emptyResult();

  let equity = equity0;
  const trades = [];

  for (const D of dates) {
    let ds = freshDayState(D);
    const attempts = new Map(); // symbol -> [{t}] accepted entries today
    const open = [];
    const prepCache = new Map();
    const getPrep = s => {
      if (!prepCache.has(s)) {
        prepCache.set(s, prepareSymbolDay(
          s, D, symBars.get(s), symDaily.get(s), indexData, r, om, symProfiles
        ));
      }
      return prepCache.get(s);
    };

    // Merged chronological stream: every bar at/after OR completion, per
    // symbol, in ascending (t, symbol) order. Management of an open position
    // runs on its symbol's bar BEFORE any new entry is evaluated there.
    const stream = [];
    for (const s of symbols) {
      const prep = getPrep(s);
      if (!prep) continue;
      for (let i = 0; i < prep.dayBars.length; i++) {
        if (prep.dayBars[i].t >= prep.or.endMs) stream.push({ t: prep.dayBars[i].t, s, i });
      }
    }
    stream.sort((a, b) => (a.t - b.t) || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));

    for (const ev of stream) {
      const prep = getPrep(ev.s);
      if (!prep) continue;

      // 1) Manage the open position on this symbol (if any) at this bar.
      const pi = open.findIndex(p => p.symbol === ev.s);
      if (pi >= 0) {
        const releasedNotional = open[pi].notional;
        const rec = manageBar(open[pi], prep, ev.i, r, X);
        if (rec) {
          open.splice(pi, 1);
          ds = recordTradeResult(ds, { pnl: rec.pnl, symbol: rec.symbol });
          ds.openPositions = Math.max(0, ds.openPositions - 1);
          ds.exposureDollars = Math.max(0, ds.exposureDollars - releasedNotional);
          equity += rec.pnl;
          trades.push(rec);
        }
      }

      // 2) New entries — none while daily locks are engaged.
      if (checkDailyLocks(ds, r).locked) break;
      if (open.some(p => p.symbol === ev.s)) continue;
      const att = attempts.get(ev.s) || [];
      if (att.length >= r.maxAttemptsPerSymbol) continue;

      const plan = decideEntry(prep, ev.i, att, equity, r, X);
      if (!plan) continue;

      // Concurrency + exposure guards.
      if (open.length >= Math.max(1, Math.floor(+r.maxPositions))) continue;
      const notional = plan.shares * plan.fill;
      if (ds.exposureDollars + notional > +r.maxExposureDollars) continue;

      const pos = openPosition(plan, prep, X);
      open.push(pos);
      att.push({ t: ev.t });
      attempts.set(ev.s, att);
      ds.openPositions += 1;
      ds.exposureDollars += notional;
    }

    // Safety net: flatten anything still open at the day's last bar of its
    // symbol (the EOD check above normally closes everything at 15:55 ET).
    for (const pos of open.splice(0)) {
      const prep = getPrep(pos.symbol);
      const li = prep ? prep.dayBars.length - 1 : -1;
      if (prep && li >= 0) {
        const bar = prep.dayBars[li];
        const ref = finite(bar.c) !== null ? finite(bar.c) : pos.fill;
        const px = pos.long ? X.slipSell(ref) : X.slipBuy(ref);
        applyLeg(pos, ref, px, pos.sharesLeft, 'eod-flatten', bar.t);
        const rec = closePosition(pos, 'eod-flatten', X);
        ds = recordTradeResult(ds, { pnl: rec.pnl, symbol: rec.symbol });
        ds.openPositions = Math.max(0, ds.openPositions - 1);
        ds.exposureDollars = Math.max(0, ds.exposureDollars - pos.notional);
        equity += rec.pnl;
        trades.push(rec);
      }
    }
  }

  // Chronological trade order + equity curve on closed-trade equity.
  const ordered = trades.slice().sort((a, b) =>
    (a.exitTime - b.exitTime)
    || (a.entryTime - b.entryTime)
    || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const equityCurve = [];
  if (firstBarT !== null) {
    let eq = equity0;
    equityCurve.push({ t: firstBarT, equity: r2(eq) });
    for (const t of ordered) {
      eq += t.pnl;
      equityCurve.push({ t: t.exitTime, equity: r2(eq) });
    }
    if (lastBarT !== null && lastBarT > equityCurve[equityCurve.length - 1].t) {
      equityCurve.push({ t: lastBarT, equity: r2(equity0 + ordered.reduce((a, t) => a + t.pnl, 0)) });
    }
  }

  const summary = buildSummary(
    ordered, equity0, equityCurve,
    startDate || dates[0], endDate || dates[dates.length - 1]
  );

  return {
    summary,
    byDirection: buildBreakdown(ordered, t => t.direction),
    byOrDuration: buildBreakdown(ordered, t => `${t.orMinutes}-min`),
    byScoreBucket: buildBreakdown(ordered, t => t.scoreBucket),
    byRvolBucket: buildBreakdown(ordered, t => t.rvolBucket),
    byRegime: buildBreakdown(ordered, t => t.regime),
    byTimeOfDay: buildBreakdown(ordered, t => t.entryTimeBucket),
    trades: ordered,
    equityCurve,
  };
}

module.exports = { runBacktest, DEFAULT_BACKTEST_CONFIG };
