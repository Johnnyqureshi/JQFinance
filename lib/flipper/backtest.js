'use strict';

// Flipper Bot — "Invisible Wall Reversal" deterministic point-in-time backtest
// engine. Pure: no I/O, no network, no Date.now(), no randomness. Identical
// inputs produce identical reports.
//
// POINT-IN-TIME DISCIPLINE (by construction): walls for trade date D are
// computed from daily bars with ET date STRICTLY before D only:
//
//   computeWalls({ symbol, tradeDate: D,
//                  dailyBars: daily.filter(b => etDateKey(b.t) < D), rules })
//
// The signal modules therefore never receive a reference to any daily bar
// dated >= D, so Flip High / Flip Low cannot be influenced by post-D data.
// Trigger detection and position management only ever walk 1-minute bars of
// date D (plus the fixed C1/C2/C3 15-minute candles of date D). A dedicated
// test (tests/flipper-backtest.test.js, "no-future-data") proves flip levels,
// trades, and the report are unchanged when 60 future daily bars are appended.
//
// ASSUMPTIONS — pinned cross-workstream contracts (ARCHITECTURE.md). If the
// real modules deviate, the coordinator reconciles; the engine calls:
//
//   computeWalls({ symbol, tradeDate, dailyBars, rules })
//     -> { symbol, tradeDate, rangeHigh, rangeLow, flipHigh, flipLow }
//        (flipHigh/flipLow may be null)
//   detectWallTest({ walls, c1, rules })
//     -> [ { wallType, wallPrice, direction: 'long'|'short', c1,
//            priorityScore?, rejectionStrength?, reasons[] } ]
//   confirmC2({ candidate, c2, walls, rules })
//     -> { ok, reasons[] }   ("ok: true" marks a confirmed setup)
//        Legacy pinned-contract shape { state, direction, wallType, wallPrice,
//        c1, c2, triggerPrice, priorityScore, reasons[] } is also accepted.
//   checkTrigger({ candidate, c2, price, rules })
//     -> { triggered, entryPrice }   (strict break of the C2 extreme)
//        Legacy pinned-contract shape { state, direction, triggerPrice,
//        reasons[] } is also accepted.
//   computeStop({ direction, c1, entryPrice, rules }) -> stop price (number)
//     entryPrice is ALWAYS passed (percent/dollar modes need it).
//   computeTarget({ direction, walls, entryPrice, stopPrice, rules })
//     -> { target, plan, fallback, note }  (a bare target-price number is
//        also accepted)
//   sizePosition({ entryPrice, stopPrice, equity, rules }) -> integer shares
//     (a bare number; legacy { shares } / { sharesRecommended } also accepted)
//   buildTradeRecord(fields) -> trade record with the SPEC §18 fields
//     (ticker, direction, entryPrice, wallType, wallPrice, c1High, c1Low,
//     c2High, c2Low, stopPrice, targetPrice, positionSize, entryTimestamp,
//     exitTimestamp, exitPrice, pnl, mfe, mae, entryReason, exitReason).
//     The engine ALSO passes date, triggerPrice, stopKind, partialTaken,
//     pnlPct, rMultiple, holdMinutes, slippageCost, commissionCost and
//     riskReward; the real journal keeps exactly the 20 SPEC fields and
//     drops the rest. The report is built from the returned records and
//     needs pnl + exitTimestamp (+ ticker for context).
//
// checkTrigger is probed INTRABAR: for a long setup the engine passes the m1
// bar's HIGH as `price` (a touch above C2.h means the breakout happened inside
// the bar); for a short setup the bar's LOW. The fill price basis is the
// returned triggerPrice (the C2 extreme).
//
// Execution model:
// - Session candles: the 9:30 / 9:45 / 10:00 ET 15-min bars are C1/C2/C3.
//   A wall touch may land in any of the first `touchWindowCandles` candles
//   (default 2: C1 or C2); the confirmation candle is the candle AFTER the
//   touch and the trigger scan walks the 15-min window AFTER the
//   confirmation (touch C1 → confirm C2 → trigger 10:00–10:15; touch C2 →
//   confirm C3 → trigger 10:15–10:30). A touch path whose candles are
//   missing produces no setup on that path. One setup claim per wall per
//   symbol per day: the earliest touch wins.
// - Each touch candle is evaluated with detectWallTest, each candidate
//   confirmed with confirmC2 against the following candle. The first bar
//   in the trigger window where checkTrigger fires (per wall) produces a
//   trigger.
// - A trigger fills at the NEXT 1-min bar's open +/- slippageBps. No fill
//   bar (or a fill bar past EOD) means no trade.
// - Management on subsequent m1 bars of the same day: stops are checked
//   BEFORE targets, so when a bar's range touches both, the stop wins
//   (conservative). targetMode 'partial' (default): exit partialPct at the
//   primary target, move the stop to breakeven, trail the runner behind its
//   favorable extreme by runnerTrailPct. targetMode 'full': exit everything
//   at the target. EOD flatten at the first bar >= eodFlattenTime, at that
//   bar's open. Positions never carry overnight.
// - Guards: maxPositions concurrent open positions, maxDailyLossPct daily
//   closed-P&L halt, one entry attempt per wall per symbol per day, one open
//   position per symbol at a time.
// - Commissions: commissionPerShare per share on every fill leg. Slippage:
//   adverse slippageBps on entry and on every exit leg.
// - Daily bars are assumed split-adjusted already (per ARCHITECTURE.md); the
//   engine performs no adjustment itself.

const { computeWalls } = require('./walls');
const { detectWallTest, confirmC2, checkTrigger } = require('./signals');
const { sizePosition, computeStop, computeTarget, rejectionStrength, priorityScore } = require('./risk');
const { buildTradeRecord } = require('./journal');

// --- Real-module shape adapters -------------------------------------------
// The sibling modules' real APIs differ slightly from the pinned shapes this
// engine was first coded against. These adapters accept BOTH shapes so the
// engine runs identically against the real modules and the pinned contracts.
function c2Confirmed(res) {
  // Real: { ok: true }. Legacy pinned: { state: 'waiting_trigger' }.
  return !!res && (res.ok === true || res.state === 'waiting_trigger');
}
function triggerFired(trig, direction) {
  // Real: { triggered, entryPrice }. Legacy pinned: { state }.
  if (!trig) return false;
  if (typeof trig.triggered === 'boolean') return trig.triggered;
  const st = trig.state;
  return direction === 'long' ? st === 'long_triggered' : st === 'short_triggered';
}
function triggerPriceOf(trig, fallback) {
  // Real: entryPrice. Legacy pinned: triggerPrice.
  const p = Number(trig && (trig.triggerPrice ?? trig.entryPrice));
  return Number.isFinite(p) ? p : fallback;
}
function sharesOf(sizing) {
  // Real: bare integer shares. Legacy pinned: { shares } / { sharesRecommended }.
  if (sizing && typeof sizing === 'object') return Math.floor(Number(sizing.shares ?? sizing.sharesRecommended ?? 0));
  return Math.floor(Number(sizing));
}
function targetOf(tg) {
  // Real: { target, plan, fallback, note }. Legacy pinned: bare number
  // (plan null — the engine-level targetMode then decides management).
  if (tg && typeof tg === 'object') return { target: +tg.target, plan: tg.plan || null };
  return { target: +tg, plan: null };
}
// Priority when the candidate carries none (the real detectWallTest does
// not score): rejection strength from the real risk module plus normalized
// volume / risk-reward / liquidity / spread proxies.
function scoreSetupReal({ direction, c1, wallPrice, stopPrice, entryPrice, targetPrice, rules, adv, dayVolume, spreadPct }) {
  let rs = 0;
  try { rs = rejectionStrength({ direction, c1, wallPrice, rules }); } catch (_) { rs = 0; }
  const rvol = adv > 0 && dayVolume > 0 ? Math.min(1, (dayVolume / adv) / 3) : 0.5;
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);
  const rr = risk > 0 ? Math.min(1, (reward / risk) / 4) : 0;
  const liquidity = adv > 0 ? Math.min(1, adv / 2000000) : 0.5;
  const spreadTightness = Number.isFinite(spreadPct)
    ? Math.max(0, Math.min(1, 1 - spreadPct / Math.max(0.01, +rules.maxSpreadPct || 0.5))) : 0.5;
  try {
    return priorityScore({ rejectionStrength: rs, rvol, rr, liquidity, spreadTightness });
  } catch (_) { return rs * 0.4 + rvol * 0.2 + rr * 0.2 + liquidity * 0.1 + spreadTightness * 0.1; }
}

// --- ET time helpers (same approach as lib/warrior/indicators.js) ---
const ET = 'America/New_York';
const etDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
});
const etTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, hour: '2-digit', minute: '2-digit', hour12: false,
});
const msOf = t => (typeof t === 'number' ? t : Date.parse(t));
function etDateKey(t) {
  const m = msOf(t);
  return Number.isFinite(m) ? etDateFmt.format(new Date(m)) : null;
}
// Minutes since ET midnight for a timestamp.
function etMinutes(t) {
  const m = msOf(t);
  if (!Number.isFinite(m)) return NaN;
  const parts = etTimeFmt.formatToParts(new Date(m));
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? NaN) % 24;
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? NaN);
  return hour * 60 + minute;
}

// Pinned DEFAULT_FLIPPER_RULES (ARCHITECTURE.md) — engine-level defaults for
// the rules object passed to the walls/signals/risk modules. Callers may
// override individual rules via config.rules.
const PINNED_DEFAULT_RULES = Object.freeze({
  minPrice: 1, maxPrice: 20,
  minAvgDailyVolume: 500000, minDayVolume: 50000, maxSpreadPct: 0.5,
  includeETFs: true, scanBudget: 100,
  swingLookback: 3, flipGapPct: 1.0, flipLookbackBars: 120,
  wallTolerancePct: 0.30,
  touchWindowCandles: 2,
  minC1MovePct: 0.75, breakoutCancelPct: 0.25,
  stopMode: 'structure', stopBufferPct: 0.1, stopPercent: 2.0, stopDollars: 0.10,
  targetMode: 'full', partialPct: 50, runnerTrailPct: 1.0, rrTarget: 2.0,
  sizeMode: 'shares', defaultShares: 100, defaultDollars: 2000,
  riskPct: 0.5, maxRiskPerTradePct: 1.0,
  maxPositions: 3, maxTradesPerDay: 5, maxDailyLossPct: 3,
  eodFlattenTime: '15:55', limitOffsetPct: 0.2,
  slippageBps: 5, commissionPerShare: 0.005,
  tradingMode: 'PAPER', liveEnabled: false, liveConfirmed: false,
});

const DEFAULT_CONFIG = Object.freeze({
  equity: 100000,
  slippageBps: 5,
  commissionPerShare: 0.005,
  eodFlattenTime: '15:55',
  maxPositions: 3,
  maxDailyLossPct: 3,
  targetMode: 'partial_runner', // 'partial_runner' | 'full' | 'rr' (legacy 'partial' accepted)
  partialPct: 50,        // percent of the position exited at the primary target
  runnerTrailPct: 1.0,   // percent the runner's stop trails its favorable extreme
  rules: PINNED_DEFAULT_RULES,
});

const C1_MIN = 9 * 60 + 30;   // 570 — Candle 1 (9:30–9:45 ET)
const C2_MIN = 9 * 60 + 45;   // 585 — Candle 2 (9:45–10:00 ET)
const C3_MIN = 10 * 60;       // 600 — Candle 3 (10:00–10:15 ET)
const TRIGGER_END_MIN = 10 * 60 + 15; // 615 — entry window closes

function parseClock(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : fallback;
}

function runBacktest({ barsBySymbol = {}, config = {} } = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    rules: { ...DEFAULT_CONFIG.rules, ...(config.rules || {}) },
  };
  const bps = +cfg.slippageBps || 0;
  const commission = +cfg.commissionPerShare || 0;
  const eodMin = parseClock(cfg.eodFlattenTime, 15 * 60 + 55);
  // Engine management mode: the pinned rules enum spells it 'partial_runner';
  // the legacy 'partial' spelling is accepted as an alias.
  const engineTargetMode = cfg.targetMode === 'partial' ? 'partial_runner' : (cfg.targetMode || 'full');
  const partialFrac = Math.min(0.99, Math.max(0.01, (+cfg.partialPct || 50) / 100));
  const trailFrac = (+cfg.runnerTrailPct || 0) / 100;
  const slipUp = p => p * (1 + bps / 10000);   // adverse for buys / short exits
  const slipDown = p => p * (1 - bps / 10000); // adverse for sells / long exits

  const symbols = Object.keys(barsBySymbol).sort();
  const data = {};
  for (const s of symbols) {
    const d = barsBySymbol[s] || {};
    data[s] = {
      daily: [...(d.daily || [])].sort((a, b) => msOf(a.t) - msOf(b.t)),
      m15: [...(d.m15 || [])].sort((a, b) => msOf(a.t) - msOf(b.t)),
      m1: [...(d.m1 || [])].sort((a, b) => msOf(a.t) - msOf(b.t)),
    };
  }

  const startEquity = +cfg.equity;
  let equity = startEquity;
  const trades = [];
  const dayState = new Map(); // dateKey -> { startEquity, pnl }
  const getDay = dateKey => {
    if (!dayState.has(dateKey)) dayState.set(dateKey, { startEquity: equity, pnl: 0 });
    return dayState.get(dateKey);
  };

  // ---- Phase 1: per (symbol, date) setup evaluation + trigger scan ----
  // Collects trigger events; entries are sequenced in phase 2 so the
  // maxPositions / daily-loss guards see positions in true chronological order.
  const triggerEvents = [];
  for (const symbol of symbols) {
    const { daily, m15, m1 } = data[symbol];
    const dates = [...new Set(m15.map(c => etDateKey(c.t)))].filter(Boolean).sort();
    for (const D of dates) {
      // POINT-IN-TIME: walls see daily bars strictly before D only.
      let walls;
      try {
        walls = computeWalls({
          symbol,
          tradeDate: D,
          dailyBars: daily.filter(b => etDateKey(b.t) < D),
          rules: cfg.rules,
        });
      } catch { continue; }
      if (!walls || !Number.isFinite(+walls.rangeHigh) || !Number.isFinite(+walls.rangeLow)) continue;

      const sess = m15.filter(c => etDateKey(c.t) === D);
      const byMinute = new Map(sess.map(c => [etMinutes(c.t), c]));
      const touchCount = Math.max(1, Math.min(4,
        Math.floor(+cfg.rules.touchWindowCandles) || 1));
      const adv20 = daily.length >= 21
        ? daily.slice(-21, -1).reduce((s, b) => s + (+b.v || 0), 0) / 20 : 0;
      const claimedWalls = new Set(); // one setup claim per wall per symbol per day
      const seenWalls = new Set(); // one trigger per wall per symbol per day
      for (let touchIdx = 0; touchIdx < touchCount; touchIdx++) {
        const touchMin = C1_MIN + touchIdx * 15;
        const confirmMin = touchMin + 15;
        const triggerMin = confirmMin + 15;
        const triggerEndMin = triggerMin + 15;
        const touchCandle = byMinute.get(touchMin);
        const confirmCandle = byMinute.get(confirmMin);
        const triggerCandle = byMinute.get(triggerMin);
        // Missing session candle on this touch path → no setup on this path.
        if (!touchCandle || !confirmCandle || !triggerCandle) continue;

        let candidates;
        try { candidates = detectWallTest({ walls, c1: touchCandle, rules: cfg.rules }) || []; }
        catch { continue; }
        if (!Array.isArray(candidates) || candidates.length === 0) continue;

        const confirmed = [];
        for (const cand of candidates) {
          const claimKey = cand.wallType ?? `${cand.direction}`;
          if (claimedWalls.has(claimKey)) continue; // earliest touch wins
          claimedWalls.add(claimKey);
          let res;
          try { res = confirmC2({ candidate: cand, c2: confirmCandle, walls, rules: cfg.rules }); }
          catch { continue; }
          // Real confirmC2 returns { ok, reasons[] }; the pinned contract
          // returned { state: 'waiting_trigger', ...candidate-fields }.
          const direction = cand.direction || res?.direction;
          if (!c2Confirmed(res) || !(direction === 'long' || direction === 'short')) continue;
          confirmed.push({
            direction,
            wallType: cand.wallType ?? res?.wallType,
            wallPrice: cand.wallPrice ?? res?.wallPrice,
            c1: touchCandle, c2: confirmCandle,
            priorityScore: cand.priorityScore ?? res?.priorityScore ?? null,
            reasons: res?.reasons || [],
          });
        }
        if (confirmed.length === 0) continue;
        // Stops/targets feed priority scoring; entryPrice is always passed to
        // computeStop (percent/dollar modes need it). The confirmation
        // candle's extreme is the entry proxy before the trigger bar is known.
        const dayVolSoFar = m1
          .filter(b => etDateKey(b.t) === D && etMinutes(b.t) < triggerMin)
          .reduce((s, b) => s + (+b.v || 0), 0);
        for (const setup of confirmed) {
          const entryProxy = setup.direction === 'long' ? +confirmCandle.h : +confirmCandle.l;
          let stopPrice = NaN; let targetPrice = NaN; let targetPlan = 'full';
          try { stopPrice = +computeStop({ direction: setup.direction, c1: touchCandle, entryPrice: entryProxy, rules: cfg.rules }); } catch { /* skip */ }
          try {
            const tg = targetOf(computeTarget({
              direction: setup.direction, walls, entryPrice: entryProxy,
              stopPrice, rules: cfg.rules,
            }));
            targetPrice = tg.target; targetPlan = tg.plan;
          } catch { /* skip */ }
          if (setup.priorityScore === null || setup.priorityScore === undefined) {
            setup.priorityScore = scoreSetupReal({
              direction: setup.direction, c1: touchCandle, wallPrice: +setup.wallPrice,
              stopPrice, entryPrice: entryProxy, targetPrice,
              rules: cfg.rules, adv: adv20, dayVolume: dayVolSoFar, spreadPct: NaN,
            });
          }
          setup.planStop = stopPrice; setup.planTarget = targetPrice; setup.planMode = targetPlan;
        }
        // Simultaneous triggers are priority-ranked (SPEC §17).
        confirmed.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));

        const windowBars = [];
        for (let i = 0; i < m1.length; i++) {
          const c = m1[i];
          if (etDateKey(c.t) !== D) continue;
          const mins = etMinutes(c.t);
          if (mins >= triggerMin && mins < triggerEndMin) windowBars.push({ bar: c, idx: i });
        }
        for (const { bar, idx } of windowBars) {
          for (const setup of confirmed) {
            if (seenWalls.has(setup.wallType)) continue;
            // Intrabar probe: long → bar high, short → bar low.
            const probe = setup.direction === 'long' ? +bar.h : +bar.l;
            if (!Number.isFinite(probe)) continue;
            let trig;
            try { trig = checkTrigger({ candidate: setup, c2: confirmCandle, price: probe, rules: cfg.rules }); }
            catch { continue; }
            // Real: { triggered, entryPrice }. Legacy pinned: { state }.
            if (!triggerFired(trig, setup.direction)) continue;
            seenWalls.add(setup.wallType);
            const fallbackTrigger = setup.direction === 'long' ? +confirmCandle.h : +confirmCandle.l;
            triggerEvents.push({
              symbol, date: D, setup, walls, c1: touchCandle, c2: confirmCandle,
              triggerIdx: idx,
              triggerT: msOf(bar.t),
              triggerPrice: triggerPriceOf(trig, fallbackTrigger),
              priority: setup.priorityScore ?? 0,
            });
          }
        }
      }
    }
  }

  // ---- Phase 2: chronological entry walk with guards + management ----
  triggerEvents.sort((a, b) => (
    a.date < b.date ? -1 : a.date > b.date ? 1
      : a.triggerT - b.triggerT || b.priority - a.priority
      || (a.symbol < b.symbol ? -1 : 1)
  ));

  const accepted = []; // { symbol, entryT, exitT } — for concurrency guards
  const usedWalls = new Set(); // `${symbol}|${date}|${wallType}` — one entry attempt per wall/day
  const openCountAt = t => accepted.filter(p => p.entryT <= t && t < p.exitT).length;
  const symbolOpenAt = (symbol, t) => accepted.some(p => p.symbol === symbol && p.entryT <= t && t < p.exitT);

  for (const ev of triggerEvents) {
    const wallKey = `${ev.symbol}|${ev.date}|${ev.setup.wallType}`;
    if (usedWalls.has(wallKey)) continue;
    const day = getDay(ev.date);
    if (day.pnl <= -(Math.max(0, +cfg.maxDailyLossPct) / 100) * day.startEquity) continue; // daily-loss halt

    const direction = ev.setup.direction;
    const dirSign = direction === 'long' ? 1 : -1;
    let stopPrice;
    let targetPrice;
    let targetPlan = engineTargetMode;
    try {
      // entryPrice is ALWAYS passed to computeStop (percent/dollar modes
      // need it; structure mode ignores it).
      stopPrice = +computeStop({ direction, c1: ev.c1, entryPrice: ev.triggerPrice, rules: cfg.rules });
      const tg = targetOf(computeTarget({
        direction, walls: ev.walls, entryPrice: ev.triggerPrice,
        stopPrice, rules: cfg.rules,
      }));
      targetPrice = tg.target;
      // The engine's management mode follows the computed plan when the real
      // module reports one ('partial_runner' | 'full' | 'rr'); a bare-number
      // target (legacy pinned shape) leaves the engine-level targetMode.
      if (tg.plan === 'partial_runner' || tg.plan === 'full' || tg.plan === 'rr') targetPlan = tg.plan;
    } catch { continue; }
    const validPlan = Number.isFinite(stopPrice) && Number.isFinite(ev.triggerPrice)
      && Number.isFinite(targetPrice)
      && dirSign * (ev.triggerPrice - stopPrice) > 0
      && dirSign * (targetPrice - ev.triggerPrice) > 0;
    if (!validPlan) continue;

    let shares = 0;
    try {
      // Real sizePosition returns bare integer shares (never throws); the
      // legacy pinned shapes { shares } / { sharesRecommended } are accepted.
      shares = sharesOf(sizePosition({
        entryPrice: ev.triggerPrice, stopPrice, targetPrice, equity, rules: cfg.rules,
      }));
    } catch { continue; }
    if (!(shares >= 1)) continue;

    // Fill at the NEXT 1-min bar's open + slippage.
    const m1 = data[ev.symbol].m1;
    const fillBar = m1[ev.triggerIdx + 1];
    if (!fillBar || etDateKey(fillBar.t) !== ev.date || etMinutes(fillBar.t) >= eodMin) continue;
    const entryT = msOf(fillBar.t);
    if (symbolOpenAt(ev.symbol, entryT)) continue; // one position per symbol at a time
    if (openCountAt(entryT) >= Math.max(1, Math.floor(+cfg.maxPositions))) continue; // concurrent cap

    usedWalls.add(wallKey);
    const fillOpen = +fillBar.o;
    const fillPrice = direction === 'long' ? slipUp(fillOpen) : slipDown(fillOpen);
    const entrySlipTotal = Math.abs(fillPrice - fillOpen) * shares;
    const entryCommission = shares * commission;
    const riskPerShare = Math.abs(fillPrice - stopPrice);

    // ---- Manage the position bar-by-bar through EOD ----
    let sharesLeft = shares;
    let stop = stopPrice;
    let stopKind = 'initial';
    let liveTarget = targetPrice;
    let partialTaken = false;
    let partialPnlAdj = 0;
    let mae = 0; // signed: adverse is negative
    let mfe = 0; // signed: favorable is positive
    let favExtreme = fillPrice; // favorable extreme since the partial (for the trail)
    let commissionCost = entryCommission;
    let slippageCost = entrySlipTotal;
    let exitPrice = null;
    let exitRef = null; // the un-slipped reference price of the exit leg
    let exitT = null;
    let exitReason = null;
    let lastBar = null;

    for (let bi = ev.triggerIdx + 1; bi < m1.length; bi++) {
      const bar = m1[bi];
      if (etDateKey(bar.t) !== ev.date) break;
      lastBar = bar;
      const bt = msOf(bar.t);
      const mins = etMinutes(bar.t);
      const o = +bar.o; const h = +bar.h; const l = +bar.l;
      if (![o, h, l].every(Number.isFinite)) continue;
      // Track excursions on the position while open.
      if (dirSign === 1) {
        if (l - fillPrice < mae) mae = l - fillPrice;
        if (h - fillPrice > mfe) mfe = h - fillPrice;
      } else {
        if (fillPrice - h < mae) mae = fillPrice - h;
        if (fillPrice - l > mfe) mfe = fillPrice - l;
      }
      if (partialTaken) favExtreme = dirSign === 1 ? Math.max(favExtreme, h) : Math.min(favExtreme, l);
      // EOD flatten at the bar's open.
      if (mins >= eodMin) {
        exitRef = o;
        exitPrice = dirSign === 1 ? slipDown(o) : slipUp(o);
        exitT = bt; exitReason = 'eod'; break;
      }
      // Stop BEFORE target on the same bar (conservative).
      const stopHit = dirSign === 1 ? l <= stop : h >= stop;
      if (stopHit) {
        exitRef = stop;
        exitPrice = dirSign === 1 ? slipDown(stop) : slipUp(stop);
        exitT = bt; exitReason = 'stop'; break;
      }
      const targetHit = dirSign === 1 ? h >= liveTarget : l <= liveTarget;
      if (targetHit) {
        if (targetPlan === 'partial_runner' && !partialTaken) {
          const pq = Math.floor(sharesLeft * partialFrac);
          const px = dirSign === 1 ? slipDown(liveTarget) : slipUp(liveTarget);
          if (pq >= 1 && pq < sharesLeft) {
            const proceeds = dirSign * (px - fillPrice) * pq;
            const pSlip = Math.abs(px - liveTarget) * pq;
            const pComm = pq * commission;
            partialPnlAdj += proceeds - pSlip - pComm;
            commissionCost += pComm;
            slippageCost += pSlip;
            sharesLeft -= pq;
          }
          partialTaken = true;
          stop = dirSign === 1 ? Math.max(stop, fillPrice) : Math.min(stop, fillPrice);
          stopKind = 'breakeven';
          favExtreme = fillPrice;
          liveTarget = dirSign === 1 ? Infinity : -Infinity; // runner exits via trailing stop / EOD
          continue;
        }
        exitRef = liveTarget;
        exitPrice = dirSign === 1 ? slipDown(liveTarget) : slipUp(liveTarget);
        exitT = bt; exitReason = 'target'; break;
      }
      // Trail the runner behind its favorable extreme.
      if (partialTaken && trailFrac > 0) {
        const cand = dirSign === 1 ? favExtreme * (1 - trailFrac) : favExtreme * (1 + trailFrac);
        if (dirSign === 1 ? cand > stop : cand < stop) { stop = cand; stopKind = 'trail'; }
      }
    }
    // Safety net: data ended before EOD — flatten at the last bar's close.
    if (exitPrice === null && lastBar) {
      exitRef = +lastBar.c;
      exitPrice = dirSign === 1 ? slipDown(exitRef) : slipUp(exitRef);
      exitT = msOf(lastBar.t);
      exitReason = 'eod';
    }
    if (exitPrice === null) continue; // no manageable bars — skip the trade

    const exitSlip = Math.abs(exitPrice - exitRef) * sharesLeft;
    const exitComm = sharesLeft * commission;
    commissionCost += exitComm;
    slippageCost += exitSlip;
    const gross = dirSign * (exitPrice - fillPrice) * sharesLeft;
    const pnl = gross + partialPnlAdj - entrySlipTotal - entryCommission - exitSlip - exitComm;

    day.pnl += pnl;
    equity += pnl;
    accepted.push({ symbol: ev.symbol, entryT, exitT });

    const holdMinutes = (exitT - entryT) / 60000;
    trades.push(buildTradeRecord({
      ticker: ev.symbol,
      date: ev.date,
      direction,
      entryPrice: +fillPrice.toFixed(4),
      exitPrice: +exitPrice.toFixed(4),
      wallType: ev.setup.wallType,
      wallPrice: Number.isFinite(+ev.setup.wallPrice) ? +ev.setup.wallPrice : null,
      c1High: +ev.c1.h, c1Low: +ev.c1.l,
      c2High: +ev.c2.h, c2Low: +ev.c2.l,
      triggerPrice: +ev.triggerPrice.toFixed(4),
      stopPrice: +stopPrice.toFixed(4),
      targetPrice: +targetPrice.toFixed(4),
      positionSize: shares,
      entryTimestamp: entryT,
      exitTimestamp: exitT,
      pnl: +pnl.toFixed(2),
      pnlPct: +((pnl / (shares * fillPrice)) * 100).toFixed(4),
      rMultiple: riskPerShare > 0 ? +((pnl / (riskPerShare * shares))).toFixed(4) : null,
      mae: +mae.toFixed(4),
      mfe: +mfe.toFixed(4),
      entryReason: `Invisible-wall reversal: touch candle tested ${ev.setup.wallType} @ ${ev.setup.wallPrice}, `
        + `next candle confirmed ${direction}, confirmation-extreme breakout during the 15-min trigger window after confirmation`,
      exitReason,
      stopKind,
      partialTaken,
      holdMinutes: +holdMinutes.toFixed(2),
      slippageCost: +slippageCost.toFixed(4),
      commissionCost: +commissionCost.toFixed(4),
      riskReward: riskPerShare > 0
        ? +((Math.abs(targetPrice - ev.triggerPrice) / riskPerShare)).toFixed(4) : null,
      orderStatus: 'filled',
    }));
  }

  return { report: buildReport(trades, startEquity), trades };
}

// SPEC §20 report: totalTrades, winningTrades, losingTrades, winRate,
// averageWinner, averageLoser, profitFactor, maxDrawdown, averageTrade,
// largestWin, largestLoss, totalReturn, consecutiveWins, consecutiveLosses,
// plus startEquity/endEquity. Single config run — no parameter optimization.
function buildReport(trades, startEquity) {
  const ordered = [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp);
  const wins = ordered.filter(t => t.pnl > 0);
  const losses = ordered.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const totalPnl = ordered.reduce((a, t) => a + t.pnl, 0);

  // Max drawdown on the closed-trade equity curve (fraction of peak).
  let eq = startEquity;
  let peak = eq;
  let maxDD = 0;
  for (const t of ordered) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    if (peak > 0) maxDD = Math.max(maxDD, (peak - eq) / peak);
  }

  // Max consecutive win/loss streaks (flat trades reset both).
  let cw = 0; let cl = 0; let maxCW = 0; let maxCL = 0;
  for (const t of ordered) {
    if (t.pnl > 0) { cw += 1; cl = 0; if (cw > maxCW) maxCW = cw; }
    else if (t.pnl < 0) { cl += 1; cw = 0; if (cl > maxCL) maxCL = cl; }
    else { cw = 0; cl = 0; }
  }

  const n = ordered.length;
  return {
    totalTrades: n,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: n > 0 ? +(wins.length / n).toFixed(4) : 0,
    averageWinner: wins.length > 0 ? +(grossProfit / wins.length).toFixed(2) : 0,
    averageLoser: losses.length > 0 ? +(-grossLossAbs / losses.length).toFixed(2) : 0,
    profitFactor: grossLossAbs > 0 ? +(grossProfit / grossLossAbs).toFixed(4)
      : (grossProfit > 0 ? Infinity : 0),
    maxDrawdown: +maxDD.toFixed(6),
    averageTrade: n > 0 ? +(totalPnl / n).toFixed(2) : 0,
    largestWin: n > 0 ? +Math.max(...ordered.map(t => t.pnl)).toFixed(2) : 0,
    largestLoss: n > 0 ? +Math.min(...ordered.map(t => t.pnl)).toFixed(2) : 0,
    totalReturn: startEquity > 0 ? +(totalPnl / startEquity).toFixed(6) : 0,
    consecutiveWins: maxCW,
    consecutiveLosses: maxCL,
    startEquity: +(+startEquity).toFixed(2),
    endEquity: +((startEquity + totalPnl)).toFixed(2),
  };
}

module.exports = { runBacktest, DEFAULT_CONFIG };
