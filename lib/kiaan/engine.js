'use strict';

// Kiaan Bot — regime-first day-trading engine (spec:
// goals/kiaan-bot/files/kiaan-bot-spec.md).
//
// Pure functions only: no I/O, no Date.now(), no broker/db requires, and
// NO imports from any other bot — this engine's only sibling dependency
// is ./regime. Every input arrives injected: the market context, one
// candidate's precomputed features, and the account's day state. The
// stage-2 service computes features from bars and executes; this module
// only decides, deterministically: identical input -> identical output.
//
// The order of decisions is the strategy:
//   1. Regime first (./regime). Chop / unknown => nobody trades.
//   2. Risk-off => ordinary longs are blocked outright; only the fixed
//      inverse/hedge ETF list may be bought, and only on confirmation.
//   3. A candidate needs all three legs: price structure (opening-range
//      break or VWAP reclaim), relative strength vs SPY, volume
//      expansion — plus an explicit anti-chase extension cap.
//   4. Risk is defined before entry: ATR stop, R targets, fixed-dollar
//      sizing shrunk by a per-trade risk cap, daily locks.
//
// PAPER-ONLY BY DESIGN: there is no live mode anywhere in this module.
// mergedKiaanRules() forces tradingMode 'PAPER' regardless of overrides;
// going live would require changing code, not flipping a setting.
//
// Reject/confirm reasons are "CODE: human detail" strings, kept verbatim
// so the journal can retain the exact reason for every decision —
// including the "no trade" ones. Sitting out is a first-class decision.

const { DEFAULT_REGIME_THRESHOLDS, classifyRegime } = require('./regime');

// ---------------------------------------------------------------------------
// ET wall-clock helpers (local copies — the house pattern; no cross-bot
// imports).
// ---------------------------------------------------------------------------
function easternTimeMinutes(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return get('hour') * 60 + get('minute');
}

function parseClock(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return fallback;
  const mins = (+m[1]) * 60 + (+m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : fallback;
}

function etClock(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('hour')}:${get('minute')} ET`;
}

const finite = v => (v === null || v === undefined || v === '')
  ? null
  : (Number.isFinite(+v) ? +v : null);

const round4 = v => (Number.isFinite(+v) ? +(+v).toFixed(4) : NaN);

// Comma/whitespace string or array -> uppercase, deduped symbol list.
function parseSymbolList(raw) {
  const parts = Array.isArray(raw) ? raw : (raw == null ? [] : String(raw).split(/[\s,]+/));
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const s = String(p || '').trim().toUpperCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defaults — every spec setting, frozen. mergedKiaanRules() merges user
// overrides onto these; never mutate.
// ---------------------------------------------------------------------------
const DEFAULT_KIAAN_RULES = Object.freeze({
  // Regime thresholds (owned by ./regime — spread in so one merged rules
  // object drives both modules).
  ...DEFAULT_REGIME_THRESHOLDS,
  // Session
  orMinutes: 15, // opening range the service measures breaks against
  entryWindowStart: '09:45',
  entryWindowEnd: '15:30',
  flattenTime: '15:55', // EOD flatten — the bot never holds overnight
  // Universe rails
  minPrice: 1,
  maxPrice: 20,
  minAvgVolume: 500000,
  maxSpreadPct: 0.3,
  // The ONLY long expression allowed on a risk-off day: inverse /
  // index-hedge ETFs, bought long (the bot never shorts stock). They
  // still need full confirmation — being on this list earns nothing by
  // itself.
  hedgeSymbols: 'SQQQ,SPXS,TSDD,SOXS,TECS,LABD',
  // Confirmation — all three legs required
  minRelStrengthPct: 1.0, // candidate day change minus SPY day change, pts
  minRvol: 1.5, // relative volume (pace vs the name's own average)
  // Anti-chase
  maxExtensionAtrs: 2, // entry may sit at most this far past the trigger
  maxDayGainPct: 20, // a name already up more than this is never chased
  // Sizing & risk
  sizingMode: 'dollars', // 'dollars' | 'risk'
  fixedDollars: 500,
  maxRiskPerTradeDollars: 50, // hard cap: shrinks shares when the stop is wide
  atrStopMult: 1.5, // stop = entry − atrStopMult × ATR (longs)
  targets: Object.freeze([
    Object.freeze({ r: 2, pct: 50 }),
    Object.freeze({ r: 3, pct: 50 }),
  ]),
  breakevenR: 1, // move stop to entry once price reaches this R
  maxPositions: 3,
  // Daily locks
  maxDailyLossPct: 2, // of account equity; at/past it the day is halted
  maxConsecutiveLosses: 3,
  maxTradesPerDay: 6,
  // Mode — PAPER ONLY. Deliberately no liveEnabled/liveConfirmed keys:
  // there is no live path to switch on.
  tradingMode: 'PAPER',
});

function mergedKiaanRules(rules) {
  const src = rules && typeof rules === 'object' ? rules : {};
  const r = { ...DEFAULT_KIAAN_RULES, ...src };
  r.targets = (Array.isArray(src.targets) && src.targets.length
    ? src.targets
    : DEFAULT_KIAAN_RULES.targets).map(t => ({ ...t }));
  r.hedgeSymbols = parseSymbolList(
    src.hedgeSymbols !== undefined ? src.hedgeSymbols : DEFAULT_KIAAN_RULES.hedgeSymbols,
  ).join(',');
  // Paper-only is not a preference, it is the design: no override can
  // move this bot toward live trading.
  r.tradingMode = 'PAPER';
  return r;
}

function isHedgeSymbol(symbol, rules) {
  const r = mergedKiaanRules(rules);
  return parseSymbolList(r.hedgeSymbols).includes(String(symbol || '').toUpperCase());
}

// ---------------------------------------------------------------------------
// checkDailyLocks(dayState, rules) -> { locked, reasons }
// dayState: { openPositions, tradesToday, dailyPnlPct, consecutiveLosses }
// (dailyPnlPct is signed: -2.5 means down 2.5% of equity on the day.)
// ---------------------------------------------------------------------------
function checkDailyLocks(dayState = {}, rules = {}) {
  const r = mergedKiaanRules(rules);
  const ds = dayState && typeof dayState === 'object' ? dayState : {};
  const reasons = [];
  const lock = (code, detail) => reasons.push(`${code}: ${detail}`);

  const pnlPct = finite(ds.dailyPnlPct);
  if (pnlPct !== null && pnlPct <= -Math.abs(+r.maxDailyLossPct)) {
    lock('DAILY_LOSS_HALT', `daily P&L ${pnlPct.toFixed(2)}% at/past the −${r.maxDailyLossPct}% max daily loss — halted for the day`);
  }
  const consec = finite(ds.consecutiveLosses);
  if (consec !== null && consec >= +r.maxConsecutiveLosses) {
    lock('CONSEC_LOSS_HALT', `${consec} consecutive losses ≥ max ${r.maxConsecutiveLosses} — halted for the day`);
  }
  const trades = finite(ds.tradesToday);
  if (trades !== null && trades >= +r.maxTradesPerDay) {
    lock('MAX_TRADES', `${trades} trades today ≥ max ${r.maxTradesPerDay} — no more entries today`);
  }
  const open = finite(ds.openPositions);
  if (open !== null && open >= +r.maxPositions) {
    lock('MAX_POSITIONS', `${open} open positions ≥ max ${r.maxPositions} — no room for a new entry`);
  }
  return { locked: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// sizePosition — fixed-dollar sizing shrunk by the per-trade risk cap
// ('dollars'), or pure risk sizing ('risk': risk exactly
// maxRiskPerTradeDollars). Never throws; invalid input yields 0 shares.
// Returns { shares, notional, riskDollars, cappedByRisk }.
// ---------------------------------------------------------------------------
function sizePosition({ mode, entry, stop, fixedDollars, maxRiskDollars } = {}) {
  const e = finite(entry);
  const s = finite(stop);
  const zero = { shares: 0, notional: 0, riskDollars: 0, cappedByRisk: false };
  if (e === null || e <= 0 || s === null || !(s < e)) return zero;
  const perShare = e - s;
  const riskCap = finite(maxRiskDollars);
  const maxByRisk = riskCap !== null && riskCap > 0 ? Math.floor(riskCap / perShare) : Infinity;

  let shares;
  let cappedByRisk = false;
  if (String(mode || 'dollars').toLowerCase() === 'risk') {
    shares = maxByRisk === Infinity ? 0 : maxByRisk;
  } else {
    const dollars = finite(fixedDollars);
    if (dollars === null || dollars <= 0) return zero;
    shares = Math.floor(dollars / e);
    if (shares > maxByRisk) { shares = maxByRisk; cappedByRisk = true; }
  }
  if (!Number.isFinite(shares) || shares <= 0) return { ...zero, cappedByRisk };
  return {
    shares,
    notional: round4(shares * e),
    riskDollars: round4(shares * perShare),
    cappedByRisk,
  };
}

// ---------------------------------------------------------------------------
// evaluateSession(context, rules) — the day's stance, decided before any
// symbol is considered. This is the journal record for the session: on a
// stand-aside day it IS the explanation.
//
// context: { market: {...classifyRegime input}, regime?, dayState? }
// Returns { regime, score, stance: 'seek-longs'|'seek-hedges'|'stand-aside',
//   guardActive, locked, reasons, why }.
// ---------------------------------------------------------------------------
function evaluateSession(context = {}, rules = {}) {
  const r = mergedKiaanRules(rules);
  const ctx = context && typeof context === 'object' ? context : {};
  const cls = ctx.regime && typeof ctx.regime === 'object' && typeof ctx.regime.regime === 'string'
    ? ctx.regime
    : classifyRegime(ctx.market || {}, r);
  const reasons = [...(cls.reasons || [])];
  const guardActive = cls.guardActive === true;

  const locks = checkDailyLocks(ctx.dayState || {}, r);
  reasons.push(...locks.reasons);

  let stance;
  if (locks.locked) stance = 'stand-aside';
  else if (guardActive) stance = 'seek-hedges'; // relief-bounce guard day: hedge-only
  else if (cls.regime === 'risk-on') stance = 'seek-longs';
  else if (cls.regime === 'risk-off') stance = 'seek-hedges';
  else stance = 'stand-aside';

  if (stance === 'stand-aside' && !locks.locked) {
    reasons.push(cls.regime === 'unknown'
      ? 'STAND_ASIDE: regime unknown — no trading until the market context is trustworthy'
      : 'STAND_ASIDE: chop/unclear regime — no trading today unless the regime resolves');
  }
  if (stance === 'seek-hedges' && guardActive) {
    reasons.push('HEDGES_ONLY_GUARD: relief-bounce guard — the score reads risk-on but the 10Y and Brent levels block fresh longs; only confirming hedge-list ETFs may be bought');
  } else if (stance === 'seek-hedges') {
    reasons.push('HEDGES_ONLY: risk-off — ordinary longs blocked; only confirming hedge-list ETFs may be bought');
  }
  if (stance === 'seek-longs') {
    reasons.push('LONGS_OK: risk-on — strongest relative-strength breakouts may be bought');
  }

  const why = stance === 'seek-longs'
    ? `KIAAN SESSION: risk-on (score ${cls.score > 0 ? '+' : ''}${cls.score ?? 0}) — seeking long breakouts in the strongest names.`
    : stance === 'seek-hedges' && guardActive
      ? `KIAAN SESSION: relief-bounce guard (score ${cls.score > 0 ? '+' : ''}${cls.score ?? 0}) — the tape scores risk-on but the 10Y and Brent levels are still blocked; no ordinary longs, hedge-list ETFs only, on confirmation.`
      : stance === 'seek-hedges'
        ? `KIAAN SESSION: risk-off (score ${cls.score > 0 ? '+' : ''}${cls.score ?? 0}) — no ordinary longs; hedge-list ETFs only, on confirmation.`
        : `KIAAN SESSION: stand aside — regime ${cls.regime}${locks.locked ? ', day locked by risk limits' : ''}. No trades.`;

  return {
    regime: cls.regime,
    score: Number.isFinite(+cls.score) ? +cls.score : 0,
    stance,
    guardActive,
    locked: locks.locked,
    reasons,
    why,
  };
}

// ---------------------------------------------------------------------------
// evaluateCandidate(context, candidate, rules) — one symbol, one decision.
//
// context: {
//   market: {...classifyRegime input},   // used unless context.regime set
//   regime?: <classifyRegime output>,    // precomputed classification
//   nowMs,                               // decision timestamp (ms epoch)
//   dayState: { openPositions, tradesToday, dailyPnlPct, consecutiveLosses },
//   accountEquity,
// }
// candidate (features precomputed by the caller from bars — the engine
// never fetches or derives them):
//   { symbol, price, prevClose?, dayChangePct, relStrengthPct?,
//     vwap, priceVsVwapPct?, orHigh, orLow, brokeOrHigh, reclaimedVwap,
//     rvol, atr, avgVolume, spreadPct, isInverseHedge? }
//
// Returns { decision: 'enter-long'|'no-trade', symbol, side: 'long'|null,
//   regime, reasons, why, entry, stop, targets, size, rr } — shaped to be
// journaled verbatim. On 'no-trade', entry/stop/targets/size are null and
// reasons carry the exact blocker(s).
// ---------------------------------------------------------------------------
function evaluateCandidate(context = {}, candidate = {}, rules = {}) {
  const r = mergedKiaanRules(rules);
  const ctx = context && typeof context === 'object' ? context : {};
  const cand = candidate && typeof candidate === 'object' ? candidate : {};
  const symbol = String(cand.symbol || 'UNKNOWN').toUpperCase();

  const reasons = [];
  const reject = (code, detail) => reasons.push(`${code}: ${detail}`);
  const cls = ctx.regime && typeof ctx.regime === 'object' && typeof ctx.regime.regime === 'string'
    ? ctx.regime
    : classifyRegime(ctx.market || {}, r);
  const guardActive = cls.guardActive === true;
  const noTrade = () => ({
    decision: 'no-trade',
    symbol,
    side: null,
    regime: cls.regime,
    guardActive,
    reasons,
    why: `NO-TRADE ${symbol} — ${reasons.length ? reasons[0] : 'no setup'}`,
    entry: null, stop: null, targets: null, size: null, rr: null,
  });

  // --- 1. regime gate: decided before the symbol is even considered ----
  reasons.push(...(cls.reasons || []));
  if (cls.regime === 'unknown') {
    reject('REGIME_UNKNOWN', 'market context missing/invalid — fail closed, no trade');
    return noTrade();
  }
  if (cls.regime === 'chop') {
    reject('REGIME_CHOP', 'chop/unclear regime — standing aside is the decision');
    return noTrade();
  }

  // --- 2. daily locks ----------------------------------------------------
  const locks = checkDailyLocks(ctx.dayState || {}, r);
  if (locks.locked) {
    reasons.push(...locks.reasons);
    reject('DAY_LOCKED', 'daily risk locks are engaged — no new entries');
    return noTrade();
  }

  // --- 3. entry window -----------------------------------------------------
  const nowMs = finite(ctx.nowMs);
  if (nowMs === null) { reject('NO_TIMESTAMP', 'decision timestamp unavailable — fail closed'); return noTrade(); }
  const etMin = easternTimeMinutes(nowMs);
  const winStart = parseClock(r.entryWindowStart, -1);
  const winEnd = parseClock(r.entryWindowEnd, -1);
  if (winStart < 0 || winEnd < 0 || etMin < winStart || etMin >= winEnd) {
    reject('OUTSIDE_ENTRY_WINDOW', `${etClock(nowMs)} outside ${r.entryWindowStart}–${r.entryWindowEnd} ET`);
    return noTrade();
  }

  // --- 4. regime vs instrument: who is even allowed to trade -------------
  const hedge = cand.isInverseHedge === true || isHedgeSymbol(symbol, r);
  if (guardActive) {
    // Relief-bounce guard day: the score reads risk-on, but both macro
    // levels are blocked, so the day trades exactly like a risk-off day
    // for instruments — ordinary longs refused, hedge list may confirm.
    if (!hedge) {
      const g = cls.guard && typeof cls.guard === 'object' ? cls.guard : {};
      const gy = finite(g.tenYearLevel) ?? finite(cls.inputs && cls.inputs.tenYearLevel);
      const gb = finite(g.brentLevel) ?? finite(cls.inputs && cls.inputs.brentLevel);
      reject('RELIEF_BOUNCE_GUARD', `${symbol} is an ordinary name — the relief-bounce guard is active (10Y ${gy === null ? 'n/a' : `${gy.toFixed(2)}%`} ≥ ${r.guardYieldMin}%, Brent ${gb === null ? 'n/a' : `$${gb.toFixed(2)}`} ≥ $${r.guardBrentMin}); fresh longs blocked, hedge-list ETFs only`);
      return noTrade();
    }
    reasons.push(`HEDGE_CONFIRM_PATH: ${symbol} is on the hedge list and the relief-bounce guard is active — it may trade on confirmation`);
  } else if (cls.regime === 'risk-off' && !hedge) {
    reject('REGIME_RISK_OFF', `${symbol} is an ordinary name — fresh longs are blocked in a risk-off regime, however good the chart looks`);
    return noTrade();
  } else if (cls.regime === 'risk-on' && hedge) {
    reject('REGIME_RISK_ON_HEDGE', `${symbol} is a hedge-list instrument — not bought long on a risk-on day (no fighting the tape)`);
    return noTrade();
  } else {
    reasons.push(hedge
      ? `HEDGE_CONFIRM_PATH: ${symbol} is on the hedge list and the regime is risk-off — it may trade on confirmation`
      : `REGIME_OK: ${cls.regime} regime — ${symbol} is an ordinary long candidate`);
  }

  // --- 5. data rails: fail closed ----------------------------------------
  const price = finite(cand.price);
  if (price === null || price <= 0) { reject('PRICE_MISSING', 'candidate price unavailable — fail closed'); return noTrade(); }
  // Hedge-list exemption (diagnosis 2026-10-09 addendum §5a): the $20
  // maxPrice cap applies to ordinary longs only. SQQQ/SPXS/SOXS/TECS sit
  // above $20 at typical prices, so capping hedges left risk-off days
  // with 2 of 6 candidates tradeable. The minPrice floor still applies
  // to hedges; the 1.5xATR stop and EOD flatten bound the risk.
  if (price < +r.minPrice || (!hedge && price > +r.maxPrice)) {
    reject('PRICE_BAND', `$${price} outside the $${r.minPrice}–$${r.maxPrice} band`);
    return noTrade();
  }
  if (hedge && price > +r.maxPrice) {
    reasons.push(`HEDGE_PRICE_BAND_EXEMPT: ${symbol} is a hedge-list instrument at $${price} — the $${r.maxPrice} cap applies to ordinary longs only`);
  }
  const atr = finite(cand.atr);
  if (atr === null || atr <= 0) { reject('ATR_MISSING', 'ATR unavailable — the stop cannot be computed, fail closed'); return noTrade(); }
  const rvol = finite(cand.rvol);
  if (rvol === null) { reject('RVOL_MISSING', 'relative volume unavailable — fail closed'); return noTrade(); }
  const avgVol = finite(cand.avgVolume);
  if (avgVol === null || avgVol < +r.minAvgVolume) {
    reject('LOW_LIQUIDITY', `average volume ${avgVol === null ? 'unknown' : Math.round(avgVol)} < ${r.minAvgVolume}`);
    return noTrade();
  }
  const spread = finite(cand.spreadPct);
  if (spread === null) { reject('SPREAD_UNKNOWN', 'spread unavailable — fail closed'); return noTrade(); }
  if (spread > +r.maxSpreadPct) {
    reject('WIDE_SPREAD', `spread ${spread.toFixed(2)}% > max ${r.maxSpreadPct}%`);
    return noTrade();
  }

  // --- 6. confirmation leg 1: price structure ------------------------------
  const orHigh = finite(cand.orHigh);
  const vwap = finite(cand.vwap);
  const brokeOr = cand.brokeOrHigh === true && orHigh !== null && price > orHigh;
  const reclaimed = cand.reclaimedVwap === true && vwap !== null && price > vwap;
  if (!brokeOr && !reclaimed) {
    if (cand.brokeOrHigh === true && orHigh === null) {
      reject('LEVELS_MISSING', 'opening-range high unavailable — cannot confirm a break, fail closed');
    } else if (cand.reclaimedVwap === true && vwap === null) {
      reject('VWAP_MISSING', 'VWAP unavailable — cannot confirm a reclaim, fail closed');
    } else {
      reject('NO_STRUCTURE', `no opening-range break (OR high ${orHigh === null ? 'n/a' : `$${orHigh}`}) and no VWAP reclaim — no confirmed structure`);
    }
    return noTrade();
  }
  const triggerLevel = brokeOr ? orHigh : vwap;
  const triggerName = brokeOr ? `opening-range high $${orHigh}` : `VWAP $${vwap}`;
  reasons.push(brokeOr
    ? `STRUCTURE_BREAK: closed above the ${triggerName}`
    : `STRUCTURE_RECLAIM: reclaimed ${triggerName}`);

  // --- 7. confirmation leg 2: relative strength ----------------------------
  const spyChg = finite(ctx.market && ctx.market.spy && ctx.market.spy.dayChangePct);
  let rs = finite(cand.relStrengthPct);
  if (rs === null) {
    const dayChg = finite(cand.dayChangePct);
    if (dayChg !== null && spyChg !== null) rs = +(dayChg - spyChg).toFixed(4);
  }
  if (rs === null) { reject('RS_MISSING', 'relative strength vs SPY unavailable — fail closed'); return noTrade(); }
  if (rs < +r.minRelStrengthPct) {
    reject('WEAK_RS', `relative strength ${rs >= 0 ? '+' : ''}${rs.toFixed(2)} pts vs SPY < min +${r.minRelStrengthPct} — not a leader`);
    return noTrade();
  }
  reasons.push(`RS_OK: outperforming SPY by ${rs.toFixed(2)} pts ≥ +${r.minRelStrengthPct}`);

  // --- 8. confirmation leg 3: volume expansion -----------------------------
  if (rvol < +r.minRvol) {
    reject('WEAK_VOLUME', `relative volume ${rvol.toFixed(2)}x < min ${r.minRvol}x — breakout without volume is a head-fake`);
    return noTrade();
  }
  reasons.push(`VOLUME_OK: relative volume ${rvol.toFixed(2)}x ≥ ${r.minRvol}x`);

  // --- 9. anti-chase ---------------------------------------------------------
  const dayChg = finite(cand.dayChangePct);
  if (dayChg !== null && dayChg > +r.maxDayGainPct) {
    reject('CHASE_DAY_GAIN', `already +${dayChg.toFixed(1)}% on the day > max +${r.maxDayGainPct}% — the move is made, never chase it`);
    return noTrade();
  }
  const extensionAtrs = (price - triggerLevel) / atr;
  if (extensionAtrs > +r.maxExtensionAtrs) {
    reject('CHASE_EXTENDED', `${extensionAtrs.toFixed(1)} ATR beyond the ${triggerName} > max ${r.maxExtensionAtrs} ATR — extended, the stop would be a mile away`);
    return noTrade();
  }
  reasons.push(`NOT_EXTENDED: ${extensionAtrs.toFixed(2)} ATR past the trigger ≤ ${r.maxExtensionAtrs} ATR cap`);

  // --- 10. stop, targets, size ----------------------------------------------
  const entry = price;
  const stop = round4(entry - +r.atrStopMult * atr);
  if (!(stop > 0 && stop < entry)) {
    reject('BAD_STOP', `computed stop $${stop} invalid for entry $${entry}`);
    return noTrade();
  }
  const riskPerShare = entry - stop;
  const targets = r.targets
    .filter(t => Number.isFinite(+t.r) && +t.r > 0)
    .map(t => ({ r: +t.r, pct: +t.pct || 0, price: round4(entry + +t.r * riskPerShare) }));
  if (!targets.length) { reject('NO_TARGETS', 'no valid R targets configured'); return noTrade(); }

  const size = sizePosition({
    mode: r.sizingMode, entry, stop,
    fixedDollars: r.fixedDollars, maxRiskDollars: r.maxRiskPerTradeDollars,
  });
  if (size.shares <= 0) {
    reject('ZERO_SIZE', `sizing mode "${r.sizingMode}" produced 0 shares (entry $${entry}, stop $${stop})`);
    return noTrade();
  }
  if (size.cappedByRisk) {
    reasons.push(`SIZE_CAPPED_BY_RISK: share count shrunk so risk stays ≤ $${r.maxRiskPerTradeDollars}`);
  }

  const tg = targets.map(t => `$${t.price.toFixed(2)} (${t.r}R, ${t.pct}%)`).join(' | ');
  const why = (guardActive
    ? `ENTER-LONG ${symbol} — relief-bounce guard day (score ${cls.score > 0 ? '+' : ''}${cls.score ?? 0}; 10Y and Brent levels blocked, hedge-list trade only). `
    : `ENTER-LONG ${symbol} — ${cls.regime} regime (score ${cls.score > 0 ? '+' : ''}${cls.score ?? 0}). `)
    + `${brokeOr ? `Broke the ${triggerName}` : `Reclaimed ${triggerName}`} on ${rvol.toFixed(2)}x relative volume, `
    + `outperforming SPY by ${rs.toFixed(2)} pts. Stop $${stop.toFixed(2)} (${r.atrStopMult}× ATR). `
    + `Targets: ${tg}. Size ${size.shares} sh — $${size.notional.toFixed(2)} notional, $${size.riskDollars.toFixed(2)} risk.`;

  return {
    decision: 'enter-long',
    symbol,
    side: 'long',
    regime: cls.regime,
    guardActive,
    reasons,
    why,
    entry,
    stop,
    targets,
    size,
    rr: targets[0].r,
  };
}

// ---------------------------------------------------------------------------
// validateConfig(rules) -> { ok, errors } — light structural validation
// of a full (merged) rules object, house style.
// ---------------------------------------------------------------------------
function validateConfig(rules = {}) {
  const r = mergedKiaanRules(rules);
  const errors = [];
  const err = (field, msg) => errors.push(`${field}: ${msg}`);
  const isNum = v => Number.isFinite(+v);

  if (![5, 15, 30].includes(+r.orMinutes)) err('orMinutes', 'must be 5, 15, or 30');
  for (const [sKey, eKey, label] of [['entryWindowStart', 'entryWindowEnd', 'entry window']]) {
    const a = parseClock(r[sKey], -1);
    const b = parseClock(r[eKey], -1);
    if (a < 0) err(sKey, 'must be HH:MM (24h)');
    if (b < 0) err(eKey, 'must be HH:MM (24h)');
    if (a >= 0 && b >= 0 && !(a < b)) err(label, `${r[sKey]} must be before ${r[eKey]}`);
  }
  if (parseClock(r.flattenTime, -1) < 0) err('flattenTime', 'must be HH:MM (24h)');
  if (!(+r.minPrice > 0)) err('minPrice', 'must be > 0');
  if (!(+r.maxPrice > +r.minPrice)) err('maxPrice', 'must be > minPrice');
  if (!(+r.minAvgVolume > 0)) err('minAvgVolume', 'must be > 0');
  if (!(+r.maxSpreadPct > 0)) err('maxSpreadPct', 'must be > 0');
  if (!Number.isInteger(+r.maxPositions) || +r.maxPositions < 1) err('maxPositions', 'must be an integer ≥ 1');
  if (!(+r.minRvol > 0)) err('minRvol', 'must be > 0');
  if (!(+r.maxExtensionAtrs > 0)) err('maxExtensionAtrs', 'must be > 0');
  if (!(+r.atrStopMult > 0)) err('atrStopMult', 'must be > 0');
  if (!(+r.fixedDollars > 0)) err('fixedDollars', 'must be > 0');
  if (!(+r.maxRiskPerTradeDollars > 0)) err('maxRiskPerTradeDollars', 'must be > 0');
  if (!(+r.maxDailyLossPct > 0)) err('maxDailyLossPct', 'must be > 0');
  if (!Number.isInteger(+r.maxConsecutiveLosses) || +r.maxConsecutiveLosses < 1) err('maxConsecutiveLosses', 'must be an integer ≥ 1');
  if (!Number.isInteger(+r.maxTradesPerDay) || +r.maxTradesPerDay < 1) err('maxTradesPerDay', 'must be an integer ≥ 1');
  if (!Array.isArray(r.targets) || !r.targets.length
    || r.targets.some(t => !isNum(t.r) || +t.r <= 0)) err('targets', 'must be a non-empty list of positive R multiples');
  if (r.tradingMode !== 'PAPER') err('tradingMode', 'must be PAPER — this bot has no live mode');
  return { ok: errors.length === 0, errors };
}

module.exports = {
  DEFAULT_KIAAN_RULES,
  mergedKiaanRules,
  parseSymbolList,
  isHedgeSymbol,
  classifyRegime,
  evaluateSession,
  evaluateCandidate,
  checkDailyLocks,
  sizePosition,
  validateConfig,
};
