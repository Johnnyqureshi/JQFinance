'use strict';

// ORB Bot — Opening Range Breakout strategy engine.
//
// Pure functions only: no I/O, no Date.now(), no broker/db requires, no
// cross-bot imports. Every timestamp the engine needs arrives in the input
// (bar times, attempt times, or an explicit nowMs), so the SAME code path
// serves the point-in-time backtester, paper, and live. Deterministic:
// identical input -> identical output.
//
// Conventions:
//   - Bars: [{ t (ms epoch), o, h, l, c, v }], 1-minute. Ascending order is
//     not required (the engine sorts). All session math is America/New_York.
//   - Reject reasons are "CODE: human detail" strings, kept verbatim so the
//     journal can retain exact no-trade reasons (spec: retain rejected setups).
//   - The engine fail-closes: missing/invalid data (RVOL, spread, ATR, VWAP
//     when required, levels) withholds the trade instead of guessing.

// ---------------------------------------------------------------------------
// ET wall-clock helpers (local copies — no lib/warrior or lib/flipper imports).
// ---------------------------------------------------------------------------
function easternDate(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

function easternTimeMinutes(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return get('hour') * 60 + get('minute');
}

// ms epoch of midnight at the start of value's New York date.
function easternDayStartMs(value) {
  const date = easternDate(value);
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(`${date}T12:00:00Z`)));
  const offsetHours = 12 - localHour; // 4 for EDT, 5 for EST
  return Date.parse(`${date}T00:00:00-${String(offsetHours).padStart(2, '0')}:00`);
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

// ---------------------------------------------------------------------------
// Defaults — every spec setting, frozen. Wave 2 merges user overrides onto
// these via mergedOrbRules(); never mutate.
// ---------------------------------------------------------------------------
const DEFAULT_ORB_RULES = Object.freeze({
  // Opening range
  orMinutes: 15, // 5 | 15 | 30
  // Entry windows (ET)
  entryWindowStart: '09:45',
  entryWindowEnd: '11:30',
  secondWindowEnabled: false,
  secondWindowStart: '14:00',
  secondWindowEnd: '15:30',
  // Scoring
  minScore: 75,
  weights: Object.freeze({
    regime: 15, volume: 15, relStrength: 15, vwap: 10, breakoutQuality: 15,
    levelClearance: 10, trendAlign: 10, volatility: 5, premarket: 5,
  }),
  // RVOL
  minRvol: 1.5,
  preferredRvol: 2,
  strongRvol: 3,
  // Universe
  minPrice: 1,
  maxPrice: 20,
  minAvgVolume: 500000,
  maxSpreadPct: 0.3,
  maxPositions: 3,
  // Fixed watchlist (Johnny 2026-10-01): when non-empty the universe IS this
  // list (the Alpaca asset catalog is skipped) and the minPrice/maxPrice band
  // is bypassed for these symbols. All other gates — minAvgVolume,
  // maxSpreadPct, RVOL, scoring, entry logic — still apply. Empty string =
  // full Alpaca universe scan (back-compat).
  watchlist: 'SOUN,UUUU,SMR,ONDS,BBAI,BDC,RCAT,UMAC,RR,SERV,BTG,DNN,CRML,TMQ,ASM,PLG,IAUX,UEC,USAR,LASE,CDTG,USAS,EXK,MTA,SOC,BORR,PBR,NAT,GLND,RIG,EGY,BTE,ANNA,NEXT,QID,SQQQ,AAPD,PLTD,SBIT,TSLL,SATL,RDWU,BABO,KMLI,INTW,MULL,NVDG,NVDL,SMCX,SMCL,PLTG,ADBG,NOWL,VYX,UECG,NUVB,NVDY,SNXX,SKHX,SPCH,ORCU,SOFX,KEEL,CIFG,AFRU,IRE,AMAU,GPRO,NOK,CRMG,NVTX,HODU,SKHL,SNDC,TSLG,PATX,MUU,MSTZ,CORD,AVS,QQQD,ORCZ,NVD,ERY,TSXD,TSLZ',
  // Direction
  allowLong: true,
  allowShort: true,
  // Entry
  entryMode: 'either', // 'direct' | 'retest' | 'either'
  maxAttemptsPerSymbol: 2,
  cooldownMinutes: 15,
  // Sizing
  sizingMode: 'dollars', // 'dollars' | 'shares' | 'acctPct' | 'risk'
  fixedDollars: 500,
  fixedShares: 100,
  acctPct: 2,
  riskPct: 0.5,
  // Stops
  stopMode: 'atr', // 'pct' | 'atr' | 'orOpposite' | 'breakoutLevel' | 'retestExtreme' | 'dollarRisk'
  stopPct: 1.5,
  atrStopMult: 1.5,
  dollarRisk: 25,
  // Targets / exits
  targets: Object.freeze([
    Object.freeze({ r: 1.5, pct: 50 }),
    Object.freeze({ r: 3, pct: 50 }),
  ]),
  breakevenR: 1,
  trailMode: 'none', // 'none' | 'atr' | 'vwap'
  orWidthTargets: true,
  // Daily locks
  maxDailyLossDollars: 200,
  maxTradesPerDay: 10,
  maxConsecLosses: 3,
  maxExposureDollars: 5000,
  maxTradesPerSymbol: 2,
  // Filters
  requireVwapAgree: true,
  minLevelClearancePct: 0.5,
  minRR: 1.5,
  maxWickPct: 40,
  maxExtensionAtrs: 2,
  // News
  newsPolicy: 'block', // 'block' | 'reduce' | 'allow'
  // Mode
  tradingMode: 'PAPER',
  liveEnabled: false,
  liveConfirmed: false,
});

function mergedOrbRules(rules) {
  const src = rules && typeof rules === 'object' ? rules : {};
  const r = { ...DEFAULT_ORB_RULES, ...src };
  r.weights = { ...DEFAULT_ORB_RULES.weights, ...(src.weights || {}) };
  r.targets = (Array.isArray(src.targets) && src.targets.length
    ? src.targets
    : DEFAULT_ORB_RULES.targets).map(t => ({ ...t }));
  return r;
}

// ---------------------------------------------------------------------------
// parseWatchlist — engine-level watchlist normalization, shared by paper,
// live, and backtest so all three agree on the universe. Accepts a
// comma/whitespace-separated string or an array; returns uppercase, deduped,
// non-empty symbols in first-seen order. Empty input → [] (full-universe
// scan). Price-band bypass for watchlist symbols is applied at the call
// sites, keyed on this list being non-empty.
// ---------------------------------------------------------------------------
function parseWatchlist(rules) {
  const raw = rules && typeof rules === 'object' ? rules.watchlist : null;
  const parts = Array.isArray(raw) ? raw : (raw == null ? [] : String(raw).split(','));
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const s = String(p).trim().toUpperCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------
const finite = v => (v === null || v === undefined || v === '')
  ? null
  : (Number.isFinite(+v) ? +v : null);

function normalizeDir(d) {
  return String(d || '').toLowerCase() === 'short' ? 'short' : 'long';
}

const round4 = v => (Number.isFinite(+v) ? +(+v).toFixed(4) : NaN);

// ---------------------------------------------------------------------------
// Opening range.
// Bars: [{t,o,h,l,c,v}] from (or around) 9:30 ET. Takes the bars inside
// [9:30 ET, 9:30 ET + orMinutes). Returns {high, low, mid, width, startMs,
// endMs, barCount} or {error} when there is nothing usable.
// ---------------------------------------------------------------------------
const OR_MINUTES_ALLOWED = new Set([5, 15, 30]);

function computeOpeningRange(bars, orMinutes = 15) {
  const mins = +orMinutes;
  if (!OR_MINUTES_ALLOWED.has(mins)) {
    return { error: `INVALID_OR_MINUTES: orMinutes must be 5, 15, or 30 (got ${orMinutes}).` };
  }
  const list = Array.isArray(bars) ? bars.slice().sort((a, b) => a.t - b.t) : [];
  if (list.length === 0) {
    return { error: 'NO_BARS: no bars supplied for opening-range calculation.' };
  }
  const openMs = easternDayStartMs(list[0].t) + 9.5 * 3600000; // 9:30 ET
  const endMs = openMs + mins * 60000;
  const inRange = list.filter(b => b && Number.isFinite(+b.t) && b.t >= openMs && b.t < endMs);
  if (inRange.length === 0) {
    return { error: `NO_OR_BARS: no bars inside the ${mins}-minute opening range (9:30–${etClock(endMs - 1)} ET).` };
  }
  let high = -Infinity;
  let low = Infinity;
  for (const b of inRange) {
    if (Number.isFinite(+b.h)) high = Math.max(high, +b.h);
    if (Number.isFinite(+b.l)) low = Math.min(low, +b.l);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high < low) {
    return { error: 'BAD_OR_BARS: opening-range bars lack finite high/low values.' };
  }
  return {
    high, low, mid: (high + low) / 2, width: high - low,
    startMs: openMs, endMs, barCount: inRange.length,
  };
}

// ---------------------------------------------------------------------------
// Regime classification from SPY / QQQ / IWM day change + VIX.
// high-volatility when VIX > 30 or VIX up > 20% on the day (checked first).
// ---------------------------------------------------------------------------
function classifyRegime({ spyChangePct, qqqChangePct, iwmChangePct, vix, vixChangePct } = {}) {
  const reasons = [];
  const spy = finite(spyChangePct);
  const qqq = finite(qqqChangePct);
  const iwm = finite(iwmChangePct);
  const v = finite(vix);
  const vc = finite(vixChangePct);

  if (v !== null && v > 30) {
    reasons.push(`VIX ${v.toFixed(1)} above 30 — high-volatility regime.`);
    return { regime: 'high-volatility', score: -2, reasons };
  }
  if (vc !== null && vc > 20) {
    reasons.push(`VIX up ${vc.toFixed(1)}% on the day (>20%) — high-volatility regime.`);
    return { regime: 'high-volatility', score: -2, reasons };
  }
  if (spy === null || qqq === null || iwm === null) {
    reasons.push('Index day-change data missing — regime neutral.');
    return { regime: 'neutral', score: 0, reasons };
  }
  const avg = (spy + qqq + iwm) / 3;
  if (spy > 0 && qqq > 0 && iwm > 0 && avg >= 0.3) {
    const strong = avg >= 1.0;
    reasons.push(`SPY ${spy.toFixed(2)}%, QQQ ${qqq.toFixed(2)}%, IWM ${iwm.toFixed(2)}% — broad strength (avg ${avg.toFixed(2)}%).`);
    return { regime: 'bullish', score: strong ? 2 : 1, reasons };
  }
  if (spy < 0 && qqq < 0 && iwm < 0 && avg <= -0.3) {
    const strong = avg <= -1.0;
    reasons.push(`SPY ${spy.toFixed(2)}%, QQQ ${qqq.toFixed(2)}%, IWM ${iwm.toFixed(2)}% — broad weakness (avg ${avg.toFixed(2)}%).`);
    return { regime: 'bearish', score: strong ? -2 : -1, reasons };
  }
  reasons.push(`Mixed index tape (SPY ${spy.toFixed(2)}%, QQQ ${qqq.toFixed(2)}%, IWM ${iwm.toFixed(2)}%) — neutral.`);
  return { regime: 'neutral', score: 0, reasons };
}

// ---------------------------------------------------------------------------
// Explainable 0–100 setup score. Each component awards 0..weight with a
// reason string; weights come from rules.weights (default sums to 100).
//
// input: {
//   direction: 'long'|'short',
//   regime: 'bullish'|'bearish'|'neutral'|'high-volatility',
//   rvol, relStrengthVsSpy (signed % vs SPY),
//   vwapPosition: 'above'|'below'|'at',
//   breakoutQuality: { closeBeyond, wickPct, extensionAtrs, retestHold },
//   levelClearancePct, trendAligned (bool),
//   atrPct, premarketTrend: 'up'|'down'|'flat', gapPct,
// }
// ---------------------------------------------------------------------------
function scoreSetup(input = {}, rules = DEFAULT_ORB_RULES) {
  const r = mergedOrbRules(rules);
  const w = r.weights;
  const dir = normalizeDir(input.direction);
  const long = dir === 'long';
  const regime = String(input.regime || 'neutral').toLowerCase();
  const rvol = finite(input.rvol);
  const rs = finite(input.relStrengthVsSpy);
  const vwapPos = String(input.vwapPosition || '').toLowerCase();
  const bq = (input.breakoutQuality && typeof input.breakoutQuality === 'object') ? input.breakoutQuality : {};
  const clearance = finite(input.levelClearancePct);
  const atrPct = finite(input.atrPct);
  const pmTrend = String(input.premarketTrend || 'flat').toLowerCase();
  const gapPct = finite(input.gapPct);

  const reasons = [];
  const breakdown = {};
  const award = (key, pts, reason) => {
    const p = Math.max(0, Math.min(w[key], Math.round(pts)));
    breakdown[key] = p;
    reasons.push(`[${key}] +${p}/${w[key]} — ${reason}`);
  };

  // Regime (direction-aware)
  const aligned = (long && regime === 'bullish') || (!long && regime === 'bearish');
  const opposed = (long && regime === 'bearish') || (!long && regime === 'bullish');
  if (aligned) award('regime', w.regime, `regime ${regime} aligns with ${dir}`);
  else if (regime === 'neutral') award('regime', w.regime / 2, 'regime neutral — half credit');
  else if (regime === 'high-volatility') award('regime', w.regime * 0.2, 'high-volatility regime — minimal credit');
  else if (opposed) award('regime', 0, `regime ${regime} opposes ${dir}`);
  else award('regime', 0, `unknown regime "${regime}"`);

  // Volume / RVOL
  if (rvol === null) award('volume', 0, 'RVOL unknown');
  else if (rvol >= r.strongRvol) award('volume', w.volume, `RVOL ${rvol.toFixed(2)}x ≥ strong ${r.strongRvol}x`);
  else if (rvol >= r.preferredRvol) award('volume', w.volume * 0.8, `RVOL ${rvol.toFixed(2)}x ≥ preferred ${r.preferredRvol}x`);
  else if (rvol >= r.minRvol) award('volume', w.volume * 0.5, `RVOL ${rvol.toFixed(2)}x ≥ minimum ${r.minRvol}x`);
  else award('volume', 0, `RVOL ${rvol.toFixed(2)}x below minimum ${r.minRvol}x`);

  // Relative strength vs SPY (signed: positive favors longs, negative shorts)
  const rsSigned = rs === null ? 0 : (long ? rs : -rs);
  const rsAbs = rs === null ? 0 : Math.abs(rs);
  const rsLabel = rs === null ? 'n/a' : `${rs >= 0 ? '+' : ''}${rs.toFixed(2)}%`;
  if (rs === null) award('relStrength', 0, 'relative strength unknown');
  else if (rsSigned > 0 && rsAbs >= 1) award('relStrength', w.relStrength, `rel. strength ${rsLabel} vs SPY (strong)`);
  else if (rsSigned > 0 && rsAbs >= 0.5) award('relStrength', w.relStrength * 0.7, `rel. strength ${rsLabel} vs SPY (moderate)`);
  else if (rsSigned > 0) award('relStrength', w.relStrength * 0.4, `rel. strength ${rsLabel} vs SPY (mild)`);
  else award('relStrength', 0, `rel. ${long ? 'weakness' : 'strength'} ${rsLabel} vs SPY opposes ${dir}`);

  // VWAP agreement
  const vwapOk = (long && vwapPos === 'above') || (!long && vwapPos === 'below');
  if (vwapOk) award('vwap', w.vwap, `price ${vwapPos} VWAP — agreement`);
  else if (vwapPos === 'at') award('vwap', w.vwap * 0.4, 'price at VWAP — partial credit');
  else award('vwap', 0, `price ${vwapPos || 'unknown'} VWAP — no agreement`);

  // Breakout quality: close-beyond 40%, wick 33%, extension 27% of the bucket
  const bqMax = w.breakoutQuality;
  let bqPts = 0;
  const bqNotes = [];
  if (bq.closeBeyond === true) { bqPts += bqMax * 0.4; bqNotes.push('close beyond level'); }
  else bqNotes.push('no close beyond level');
  const wick = finite(bq.wickPct);
  if (wick === null) bqNotes.push('wick unknown');
  else if (wick <= 20) { bqPts += bqMax * 0.33; bqNotes.push(`wick ${wick.toFixed(1)}% clean`); }
  else if (wick <= r.maxWickPct) { bqPts += bqMax * 0.17; bqNotes.push(`wick ${wick.toFixed(1)}% acceptable`); }
  else bqNotes.push(`wick ${wick.toFixed(1)}% extreme`);
  const ext = finite(bq.extensionAtrs);
  if (ext === null) bqNotes.push('extension unknown');
  else if (ext <= 1) { bqPts += bqMax * 0.27; bqNotes.push(`extension ${ext.toFixed(2)} ATRs tight`); }
  else if (ext <= r.maxExtensionAtrs) { bqPts += bqMax * 0.13; bqNotes.push(`extension ${ext.toFixed(2)} ATRs ok`); }
  else bqNotes.push(`extension ${ext.toFixed(2)} ATRs stretched`);
  if (bq.retestHold === true && bqPts < bqMax) { bqPts = Math.min(bqMax, bqPts + 2); bqNotes.push('retest held'); }
  award('breakoutQuality', bqPts, bqNotes.join('; '));

  // Room to the next level
  if (clearance === null) award('levelClearance', 0, 'next-level distance unknown');
  else if (clearance >= 2) award('levelClearance', w.levelClearance, `${clearance.toFixed(2)}% room to next level`);
  else if (clearance >= r.minLevelClearancePct) award('levelClearance', w.levelClearance * 0.6, `${clearance.toFixed(2)}% room (≥ ${r.minLevelClearancePct}% min)`);
  else if (clearance > 0) award('levelClearance', w.levelClearance * 0.3, `${clearance.toFixed(2)}% room — tight`);
  else award('levelClearance', 0, `no room to next level (${clearance.toFixed(2)}%)`);

  // Intraday trend alignment
  if (input.trendAligned === true) award('trendAlign', w.trendAlign, 'intraday trend aligns with direction');
  else award('trendAlign', 0, 'intraday trend not aligned');

  // Volatility sweet spot (ATR as % of price)
  if (atrPct === null) award('volatility', 0, 'ATR% unknown');
  else if (atrPct < 0.3) award('volatility', w.volatility * 0.2, `ATR ${atrPct.toFixed(2)}% — too dead`);
  else if (atrPct < 0.5) award('volatility', w.volatility * 0.6, `ATR ${atrPct.toFixed(2)}% — quiet`);
  else if (atrPct <= 6) award('volatility', w.volatility, `ATR ${atrPct.toFixed(2)}% — tradeable`);
  else if (atrPct <= 8) award('volatility', w.volatility * 0.4, `ATR ${atrPct.toFixed(2)}% — hot`);
  else award('volatility', 0, `ATR ${atrPct.toFixed(2)}% — too volatile`);

  // Premarket structure
  const pmAligned = (long && pmTrend === 'up') || (!long && pmTrend === 'down');
  const pmOpposed = (long && pmTrend === 'down') || (!long && pmTrend === 'up');
  const gapAbs = gapPct === null ? 0 : Math.abs(gapPct);
  if (gapAbs > 10) award('premarket', 0, `extreme gap ${gapPct.toFixed(1)}% — untradeable`);
  else if (pmAligned) award('premarket', w.premarket, `premarket ${pmTrend} aligns with ${dir}`);
  else if (pmTrend === 'flat') award('premarket', w.premarket * 0.6, 'premarket flat');
  else if (pmOpposed) award('premarket', 0, `premarket ${pmTrend} opposes ${dir}`);
  else award('premarket', 0, `premarket trend "${pmTrend}" unknown`);

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    score, breakdown, maxScore: 100,
    meetsMinimum: score >= r.minScore, minScore: r.minScore, reasons,
  };
}

// ---------------------------------------------------------------------------
// Entry-evaluation internals.
// ---------------------------------------------------------------------------

function regimeOf(regime) {
  const s = regime && typeof regime === 'object' && regime.regime
    ? String(regime.regime) : String(regime || 'neutral');
  const low = s.toLowerCase();
  return ['bullish', 'bearish', 'neutral', 'high-volatility'].includes(low) ? low : 'neutral';
}

function premarketTrendOf(premarket) {
  if (typeof premarket === 'string') return premarket.toLowerCase();
  if (premarket && typeof premarket === 'object' && premarket.trend) return String(premarket.trend).toLowerCase();
  return 'flat';
}

function gapOf(premarket) {
  if (premarket && typeof premarket === 'object') return finite(premarket.gapPct);
  return null;
}

function trendAlignedOf(ctx, direction, regimeStr) {
  if (ctx.trendAligned === true) return true;
  if (ctx.trendAligned === false) return false;
  const long = direction === 'long';
  return long ? regimeStr === 'bullish' : regimeStr === 'bearish';
}

// Stop price for every stopMode. dollarRisk needs a share count (sharesHint);
// with no usable count it falls back to the OR opposite side and says so.
function computeStopPrice({ direction, entry, level, atr, or, retestExtreme, rules, sharesHint }) {
  const long = direction === 'long';
  const mode = String(rules.stopMode || 'atr').toLowerCase().replace(/_/g, '');
  const buf = 0.1 * atr;
  let stop = NaN;
  let note = '';
  if (mode === 'pct') {
    stop = long ? entry * (1 - rules.stopPct / 100) : entry * (1 + rules.stopPct / 100);
    note = `fixed ${rules.stopPct}%`;
  } else if (mode === 'atr') {
    stop = long ? entry - rules.atrStopMult * atr : entry + rules.atrStopMult * atr;
    note = `ATR ${rules.atrStopMult}x`;
  } else if (mode === 'oropposite') {
    stop = long ? or.low : or.high;
    note = 'OR opposite side';
  } else if (mode === 'breakoutlevel') {
    stop = long ? level - buf : level + buf;
    note = 'breakout level ± 0.1 ATR buffer';
  } else if (mode === 'retestextreme') {
    if (retestExtreme !== null) {
      stop = long ? retestExtreme - buf : retestExtreme + buf;
      note = 'retest extreme ± 0.1 ATR buffer';
    } else {
      stop = long ? level - buf : level + buf;
      note = 'no retest extreme; fell back to breakout level';
    }
  } else if (mode === 'dollarrisk') {
    if (Number.isFinite(+sharesHint) && +sharesHint > 0 && +rules.dollarRisk > 0) {
      const d = rules.dollarRisk / +sharesHint;
      stop = long ? entry - d : entry + d;
      note = `$${rules.dollarRisk} risk over ${sharesHint} shares`;
    } else {
      stop = long ? or.low : or.high;
      note = 'dollarRisk stop needs a share count; fell back to OR opposite';
    }
  } else {
    stop = long ? entry - rules.atrStopMult * atr : entry + rules.atrStopMult * atr;
    note = `unknown stopMode "${rules.stopMode}"; used ATR ${rules.atrStopMult}x`;
  }
  return { stop: round4(stop), note, mode };
}

// Target ladder: R-multiple targets from rules.targets plus OR-width
// projections (long: OR high + 1x/2x width; short: OR low − 1x/2x width)
// when rules.orWidthTargets is on. Sorted nearest-first.
function buildTargets({ direction, entry, stop, or, rules }) {
  const long = direction === 'long';
  const rps = Math.abs(entry - stop);
  const list = [];
  for (const t of rules.targets) {
    const rr = +t.r;
    if (!(rr > 0) || !(rps > 0)) continue;
    list.push({
      r: rr, pct: +t.pct || 0,
      price: round4(long ? entry + rr * rps : entry - rr * rps),
      type: 'rr',
    });
  }
  if (rules.orWidthTargets && Number.isFinite(+or.width) && +or.width > 0 && rps > 0) {
    const anchor = long ? +or.high : +or.low;
    for (const mult of [1, 2]) {
      const px = long ? anchor + mult * +or.width : anchor - mult * +or.width;
      list.push({
        r: +((Math.abs(px - entry) / rps).toFixed(3)), pct: 50,
        price: round4(px), type: 'or-width',
      });
    }
  }
  list.sort((a, b) => a.r - b.r);
  return list;
}

// ---------------------------------------------------------------------------
// evaluateEntry — the full entry gate.
//
// ctx: {
//   symbol, direction: 'long'|'short',
//   bars: 1-min bars ending at the decision tick (engine never looks ahead),
//   or: computeOpeningRange() output,
//   vwap, rvol, avgVolume, spreadPct, relStrengthVsSpy,
//   regime: 'bullish'|... (or classifyRegime() output),
//   atr, premarket: {trend, gapPct} | 'up'|'down'|'flat',
//   levels: { priorHigh, priorLow },
//   lastAttempts: [{ t, result }], accountEquity,
//   trendAligned (optional; derived from regime when omitted),
//   hasMaterialNews (optional), nowMs (optional; defaults to last bar time),
//   rules: overrides merged onto DEFAULT_ORB_RULES,
// }
//
// Returns { decision: 'enter-long'|'enter-short'|'reversal-long'|'reversal-short'|'wait',
//   score, breakdown, rejectReasons, entry, stop, targets, size, rr, why }.
// A failed breakout (close back inside the OR after breaking out) is rejected
// for the primary direction and re-evaluated as a reversal setup in the
// opposite direction off the OR mid — still gated by minScore.
// ---------------------------------------------------------------------------
function evaluateBreakoutSide({ ctx, rules, symbol, direction, level, bars, nowMs, or, rvol, atr, reject, isReversal }) {
  const long = direction === 'long';
  const lastBar = bars[bars.length - 1];
  const price = finite(lastBar.c);
  if (price === null) { reject('BAD_BARS', 'latest bar has no close'); return { status: 'rejected' }; }
  const beyond = c => (long ? c > level : c < level);

  // First close beyond the level after OR completion.
  let bi = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t < or.endMs) continue;
    const c = finite(bars[i].c);
    if (c !== null && beyond(c)) { bi = i; break; }
  }
  if (bi < 0) {
    reject('NO_BREAKOUT', `no ${direction} close beyond $${level} since OR end`);
    return { status: 'rejected' };
  }
  const bq = bars[bi];

  // Failed breakout: broke out, then closed back inside the OR (primary only).
  if (!isReversal) {
    const inside = long ? price < +or.high : price > +or.low;
    if (inside) return { status: 'failed-breakout', breakoutTime: bq.t, breakoutLevel: level };
  } else if (!beyond(price)) {
    reject('REVERSAL_NO_TRIGGER', `reversal-${direction} needs a close beyond OR mid $${level} (last $${price})`);
    return { status: 'rejected' };
  }

  // Wick of the reference candle (breakout bar; latest bar for reversals).
  const ref = isReversal ? lastBar : bq;
  const refIdx = isReversal ? bars.length - 1 : bi;
  const ro = finite(ref.o); const rh = finite(ref.h); const rl = finite(ref.l); const rc = finite(ref.c);
  const range = (rh !== null && rl !== null) ? rh - rl : 0;
  const wick = (ro !== null && rc !== null && rl !== null && rh !== null && range > 0)
    ? (long ? Math.min(ro, rc) - rl : rh - Math.max(ro, rc)) : 0;
  const wickPct = range > 0 ? Math.max(0, (wick / range) * 100) : 0;
  if (wickPct > rules.maxWickPct) {
    reject('EXTREME_WICK', `${direction} wick ${wickPct.toFixed(1)}% > max ${rules.maxWickPct}%`);
    return { status: 'rejected' };
  }

  // Extension in ATRs from the trigger level.
  const extAtrs = Math.abs(rc - level) / atr;
  if (extAtrs > rules.maxExtensionAtrs) {
    reject('OVER_EXTENDED', `${extAtrs.toFixed(2)} ATRs beyond $${level} > max ${rules.maxExtensionAtrs}`);
    return { status: 'rejected' };
  }

  // Disappearing volume: reference-bar volume vs mean of up to 5 prior bars.
  const bv = finite(ref.v);
  if (bv === null) { reject('VOLUME_MISSING', 'reference-bar volume unavailable — fail closed'); return { status: 'rejected' }; }
  const prevVols = [];
  for (let i = refIdx - 1; i >= 0 && prevVols.length < 5; i--) {
    const pv = finite(bars[i].v);
    if (pv !== null) prevVols.push(pv);
  }
  const avgPrev = prevVols.length ? prevVols.reduce((a, b) => a + b, 0) / prevVols.length : null;
  if (avgPrev !== null && avgPrev > 0 && bv < 0.5 * avgPrev) {
    reject('VOLUME_FADING', `volume ${Math.round(bv)} < 50% of prior-5-bar avg ${Math.round(avgPrev)} — disappearing volume`);
    return { status: 'rejected' };
  }

  // VWAP agreement.
  const vwap = finite(ctx.vwap);
  if (rules.requireVwapAgree) {
    if (vwap === null) { reject('VWAP_MISSING', 'VWAP unavailable and requireVwapAgree=true — fail closed'); return { status: 'rejected' }; }
    const ok = long ? price > vwap : price < vwap;
    if (!ok) {
      reject('VWAP_FAILURE', `${direction} needs price ${long ? 'above' : 'below'} VWAP $${vwap} (last $${price})`);
      return { status: 'rejected' };
    }
  }

  // Regime opposition (opposing SPY tape).
  const regimeStr = regimeOf(ctx.regime);
  if (long && regimeStr === 'bearish') { reject('REGIME_OPPOSED', 'bearish regime blocks long (opposing SPY tape)'); return { status: 'rejected' }; }
  if (!long && regimeStr === 'bullish') { reject('REGIME_OPPOSED', 'bullish regime blocks short (opposing SPY tape)'); return { status: 'rejected' }; }

  // Room to the next level.
  const levels = (ctx.levels && typeof ctx.levels === 'object') ? ctx.levels : {};
  const nextLevel = finite(long ? levels.priorHigh : levels.priorLow);
  if (nextLevel === null) {
    reject('LEVELS_MISSING', `${long ? 'priorHigh' : 'priorLow'} unavailable — fail closed`);
    return { status: 'rejected' };
  }
  const clearancePct = long
    ? ((nextLevel - level) / level) * 100
    : ((level - nextLevel) / level) * 100;
  if (clearancePct < rules.minLevelClearancePct) {
    reject('NEARBY_LEVEL', `only ${clearancePct.toFixed(2)}% to ${long ? 'prior high' : 'prior low'} $${nextLevel} < min ${rules.minLevelClearancePct}%`);
    return { status: 'rejected' };
  }

  // Entry mode: direct vs retest (retest = pullback touched the level and held).
  const entryMode = String(rules.entryMode || 'either').toLowerCase();
  let entryModeUsed = isReversal ? 'direct (reversal)' : 'direct';
  let retestHold = false;
  let retestExtreme = null;
  if (!isReversal && (entryMode === 'retest' || entryMode === 'either')) {
    let touched = false;
    let extreme = long ? Infinity : -Infinity;
    for (let i = bi + 1; i < bars.length; i++) {
      const bl = finite(bars[i].l); const bh = finite(bars[i].h); const bc = finite(bars[i].c);
      if (bl === null || bh === null || bc === null) continue;
      const held = long ? bc >= level : bc <= level;
      const touch = long ? bl <= level + 0.15 * atr : bh >= level - 0.15 * atr;
      if (touch && held) {
        touched = true;
        extreme = long ? Math.min(extreme, bl) : Math.max(extreme, bh);
      }
    }
    if (touched) { entryModeUsed = 'retest'; retestHold = true; retestExtreme = extreme; }
    else if (entryMode === 'retest') {
      reject('NO_RETEST', `entryMode=retest but no held retest of $${level} after the breakout`);
      return { status: 'rejected' };
    }
  }

  // Stop.
  const entry = price;
  const sizingMode = String(rules.sizingMode || 'dollars').toLowerCase();
  const equity = finite(ctx.accountEquity);
  let sharesHint = 0;
  if (sizingMode !== 'risk' && equity !== null) {
    sharesHint = sizePosition({
      mode: sizingMode, entry, stop: NaN, accountEquity: equity,
      fixedDollars: rules.fixedDollars, fixedShares: rules.fixedShares,
      acctPct: rules.acctPct, riskPct: rules.riskPct,
    }).shares;
  }
  const { stop, note: stopNote } = computeStopPrice({
    direction, entry, level, atr, or, retestExtreme, rules, sharesHint,
  });
  if (!Number.isFinite(stop) || stop <= 0 || (long ? !(stop < entry) : !(stop > entry))) {
    reject('BAD_STOP', `computed stop $${stop} invalid for ${direction} entry $${entry}`);
    return { status: 'rejected' };
  }

  // Targets + minimum R:R (gated on the first R-multiple target).
  const targets = buildTargets({ direction, entry, stop, or, rules });
  const rrTargets = targets.filter(t => t.type === 'rr');
  const firstRr = rrTargets.length ? rrTargets[0] : targets[0];
  if (!firstRr || !(firstRr.r >= rules.minRR)) {
    reject('LOW_RR', `first target R ${firstRr ? firstRr.r : 'n/a'} < minRR ${rules.minRR}`);
    return { status: 'rejected' };
  }

  // Score.
  const vwapPos = vwap === null ? 'unknown' : (price > vwap ? 'above' : price < vwap ? 'below' : 'at');
  const scored = scoreSetup({
    direction,
    regime: regimeStr,
    rvol,
    relStrengthVsSpy: finite(ctx.relStrengthVsSpy),
    vwapPosition: vwapPos,
    breakoutQuality: { closeBeyond: true, wickPct, extensionAtrs: extAtrs, retestHold },
    levelClearancePct: clearancePct,
    trendAligned: trendAlignedOf(ctx, direction, regimeStr),
    atrPct: (atr / entry) * 100,
    premarketTrend: premarketTrendOf(ctx.premarket),
    gapPct: gapOf(ctx.premarket),
  }, rules);
  if (!scored.meetsMinimum) {
    reject('LOW_SCORE', `score ${scored.score}/100 < minScore ${rules.minScore}`);
    return { status: 'rejected', scored };
  }

  // Size.
  if (equity === null) { reject('ACCOUNT_EQUITY_MISSING', 'accountEquity unavailable — cannot size'); return { status: 'rejected', scored }; }
  let size = sizePosition({
    mode: sizingMode, entry, stop, accountEquity: equity,
    fixedDollars: rules.fixedDollars, fixedShares: rules.fixedShares,
    acctPct: rules.acctPct, riskPct: rules.riskPct,
  });
  if (String(rules.newsPolicy).toLowerCase() === 'reduce' && ctx.hasMaterialNews === true && size.shares > 1) {
    const halved = Math.floor(size.shares / 2);
    size = {
      shares: halved,
      notional: round4(halved * entry),
      riskDollars: round4(halved * Math.abs(entry - stop)),
      reducedForNews: true,
    };
  }
  if (size.shares <= 0) { reject('ZERO_SIZE', `sizing mode "${sizingMode}" produced 0 shares`); return { status: 'rejected', scored }; }

  const why = buildWhy({
    symbol, direction, level, entry, stop, stopNote, targets, size,
    score: scored.score, breakdown: scored.breakdown, rules, rvol,
    regimeStr, vwap, breakoutTime: bq.t, entryModeUsed,
    clearancePct, nextLevel, isReversal,
    orMinutes: rules.orMinutes,
  });
  return {
    status: 'ok', score: scored.score, breakdown: scored.breakdown,
    entry, stop, targets, size, rr: firstRr.r, why,
    level, breakoutTime: bq.t, entryModeUsed,
    riskDollars: size.riskDollars,
  };
}

function buildWhy(p) {
  const tag = p.isReversal ? `REVERSAL-${p.direction.toUpperCase()}` : `ENTER-${p.direction.toUpperCase()}`;
  const bd = Object.entries(p.breakdown)
    .map(([k, v]) => `${k} ${v}/${p.rules.weights[k]}`).join(' · ');
  const tg = p.targets.map(t => `$${t.price.toFixed(2)} (${t.r}R${t.type === 'or-width' ? ', OR-width' : ''}, ${t.pct}%)`).join(' | ');
  const setupLine = p.isReversal
    ? `${p.orMinutes}-min OR ${p.direction === 'long' ? 'low' : 'high'} breakout FAILED (closed back inside); ${p.direction} the OR-mid breakdown ($${p.level}) at ${etClock(p.breakoutTime)}`
    : `${p.orMinutes}-min OR ${p.direction === 'long' ? 'high' : 'low'} $${p.level} broken at ${etClock(p.breakoutTime)} (${p.entryModeUsed} entry $${p.entry})`;
  return `${tag} ${p.symbol} — score ${p.score}/100 (min ${p.rules.minScore}). ` +
    `Setup: ${setupLine}. ` +
    `RVOL ${p.rvol.toFixed(2)}x, ${p.regimeStr} regime${p.vwap !== null ? `, VWAP $${p.vwap} (price ${p.direction === 'long' ? 'above' : 'below'})` : ''}. ` +
    `Room ${p.clearancePct.toFixed(2)}% to ${p.direction === 'long' ? 'prior high' : 'prior low'} $${p.nextLevel}. ` +
    `Stop $${p.stop} [${p.stopNote}]. Targets: ${tg}. ` +
    `Size ${p.size.shares} sh — $${p.size.notional.toFixed(2)} notional, $${p.size.riskDollars.toFixed(2)} risk${p.size.reducedForNews ? ' (halved: newsPolicy=reduce)' : ''}. ` +
    `Score detail: ${bd}.`;
}

function evaluateEntry(ctx = {}) {
  const rules = mergedOrbRules(ctx.rules);
  const symbol = String(ctx.symbol || 'UNKNOWN');
  const direction = normalizeDir(ctx.direction);
  const long = direction === 'long';
  const bars = (Array.isArray(ctx.bars) ? ctx.bars : []).slice().sort((a, b) => a.t - b.t);
  const or = ctx.or || {};
  const lastBar = bars[bars.length - 1];
  const nowMs = Number.isFinite(+ctx.nowMs) ? +ctx.nowMs : (lastBar ? +lastBar.t : NaN);

  const rejectReasons = [];
  const reject = (code, detail) => rejectReasons.push(`${code}: ${detail}`);
  const waitResult = () => ({
    decision: 'wait',
    score: 0,
    breakdown: null,
    rejectReasons,
    entry: null, stop: null, targets: null, size: null, rr: null,
    why: `WAIT ${symbol}: ${rejectReasons.length ? rejectReasons.join(' | ') : 'no setup'}`,
  });

  // --- universal gates ---
  if (bars.length === 0 || !Number.isFinite(nowMs)) {
    reject('NO_BARS', 'no bars / no decision timestamp');
    return waitResult();
  }
  if (long && rules.allowLong !== true) { reject('DIRECTION_DISABLED', 'longs disabled (allowLong=false)'); return waitResult(); }
  if (!long && rules.allowShort !== true) { reject('DIRECTION_DISABLED', 'shorts disabled (allowShort=false)'); return waitResult(); }
  if (!or || or.error || !Number.isFinite(+or.high) || !Number.isFinite(+or.low)
      || !(+or.high > +or.low) || !Number.isFinite(+or.endMs)) {
    reject('BAD_OR_DATA', or && or.error ? String(or.error) : 'opening range missing/invalid');
    return waitResult();
  }
  if (nowMs < or.endMs) {
    reject('OR_INCOMPLETE', `no entries before OR completion (${etClock(or.endMs)})`);
    return waitResult();
  }
  const etMin = easternTimeMinutes(nowMs);
  const inWin = (s, e) => {
    const a = parseClock(s, -1); const b = parseClock(e, -1);
    return a >= 0 && b >= 0 && etMin >= a && etMin < b;
  };
  const inWindow = inWin(rules.entryWindowStart, rules.entryWindowEnd)
    || (rules.secondWindowEnabled === true && inWin(rules.secondWindowStart, rules.secondWindowEnd));
  if (!inWindow) {
    const win2 = rules.secondWindowEnabled === true ? ` / ${rules.secondWindowStart}–${rules.secondWindowEnd}` : ' (second window disabled)';
    reject('OUTSIDE_ENTRY_WINDOW', `${etClock(nowMs)} outside ${rules.entryWindowStart}–${rules.entryWindowEnd}${win2} ET`);
    return waitResult();
  }

  // Attempts + cooldown, scoped to the ET date. Locks never reset intraday —
  // the caller owns the dayState; this only counts today's attempts.
  const todayStr = easternDate(nowMs);
  const attemptsToday = (Array.isArray(ctx.lastAttempts) ? ctx.lastAttempts : [])
    .filter(a => a && Number.isFinite(+a.t) && easternDate(+a.t) === todayStr)
    .sort((a, b) => a.t - b.t);
  if (attemptsToday.length >= rules.maxAttemptsPerSymbol) {
    reject('MAX_ATTEMPTS', `${attemptsToday.length} attempts today ≥ max ${rules.maxAttemptsPerSymbol}/symbol`);
    return waitResult();
  }
  const lastAttempt = attemptsToday[attemptsToday.length - 1];
  if (lastAttempt && nowMs - lastAttempt.t < rules.cooldownMinutes * 60000) {
    const remain = Math.ceil((rules.cooldownMinutes * 60000 - (nowMs - lastAttempt.t)) / 60000);
    reject('COOLDOWN', `last attempt ${etClock(lastAttempt.t)} — ${remain} min cooldown remaining`);
    return waitResult();
  }

  // Volume / liquidity / spread gates.
  const rvol = finite(ctx.rvol);
  if (rvol === null) { reject('RVOL_MISSING', 'RVOL unavailable — fail closed'); return waitResult(); }
  if (rvol < rules.minRvol) { reject('WEAK_VOLUME', `RVOL ${rvol.toFixed(2)}x < minimum ${rules.minRvol}x`); return waitResult(); }
  const avgVol = finite(ctx.avgVolume);
  if (avgVol === null || avgVol < rules.minAvgVolume) {
    reject('LOW_LIQUIDITY', `avg volume ${avgVol === null ? 'unknown' : Math.round(avgVol)} < ${rules.minAvgVolume}`);
    return waitResult();
  }
  const spread = finite(ctx.spreadPct);
  if (spread === null) { reject('SPREAD_UNKNOWN', 'spread unavailable — fail closed'); return waitResult(); }
  if (spread > rules.maxSpreadPct) { reject('WIDE_SPREAD', `spread ${spread.toFixed(2)}% > max ${rules.maxSpreadPct}%`); return waitResult(); }
  const atr = finite(ctx.atr);
  if (atr === null || atr <= 0) { reject('ATR_MISSING', 'ATR unavailable — stops/targets cannot be computed'); return waitResult(); }

  // News policy.
  if (ctx.hasMaterialNews === true && String(rules.newsPolicy).toLowerCase() === 'block') {
    reject('NEWS_BLOCKED', 'material news present and newsPolicy=block');
    return waitResult();
  }

  // --- primary direction ---
  const primary = evaluateBreakoutSide({
    ctx, rules, symbol, direction,
    level: long ? +or.high : +or.low,
    bars, nowMs, or, rvol, atr, reject, isReversal: false,
  });
  if (primary.status === 'ok') {
    return {
      decision: long ? 'enter-long' : 'enter-short',
      score: primary.score, breakdown: primary.breakdown, rejectReasons,
      entry: primary.entry, stop: primary.stop, targets: primary.targets,
      size: primary.size, rr: primary.rr, why: primary.why,
    };
  }
  if (primary.status === 'failed-breakout') {
    const revDir = long ? 'short' : 'long';
    reject('RETURN_INSIDE_OR',
      `failed ${direction} breakout: broke $${primary.breakoutLevel} at ${etClock(primary.breakoutTime)} then closed back inside the OR`);
    if ((revDir === 'long' && rules.allowLong !== true) || (revDir === 'short' && rules.allowShort !== true)) {
      reject('REVERSAL_DIRECTION_DISABLED', `${revDir}s disabled — no reversal setup`);
      return waitResult();
    }
    const rev = evaluateBreakoutSide({
      ctx, rules, symbol, direction: revDir, level: +or.mid,
      bars, nowMs, or, rvol, atr, reject, isReversal: true,
    });
    if (rev.status === 'ok') {
      return {
        decision: revDir === 'long' ? 'reversal-long' : 'reversal-short',
        score: rev.score, breakdown: rev.breakdown, rejectReasons,
        entry: rev.entry, stop: rev.stop, targets: rev.targets,
        size: rev.size, rr: rev.rr, why: rev.why,
      };
    }
    return waitResult();
  }
  return waitResult();
}

// ---------------------------------------------------------------------------
// planExit — one-tick exit decision for an open position.
//
// position: { direction, entry, stop, targets: [{r, pct, price, type}],
//   size, breakevenAt (truthy once moved), partialsTaken: [r...],
//   breakevenR, trailMode: 'none'|'atr'|'vwap', trailAtrMult }
// market: { price, vwap, atr, rMultiple (optional; computed when omitted) }
//
// Priority: stop-hit exit > newly-tagged target partial > breakeven move >
// trailing tighten > hold. OR-width projections ride along as targets with
// type 'or-width' (their r is width-distance / risk).
// ---------------------------------------------------------------------------
function planExit(position = {}, market = {}) {
  const direction = normalizeDir(position.direction);
  const long = direction === 'long';
  const entry = finite(position.entry);
  const stop = finite(position.stop);
  const price = finite(market.price);
  if (entry === null || stop === null || price === null || entry <= 0) {
    return {
      action: 'hold',
      newStop: Number.isFinite(stop) ? stop : null,
      reason: 'HOLD: position or market data missing/invalid — no action.',
    };
  }
  const rps = Math.abs(entry - stop);
  const rMult = Number.isFinite(+market.rMultiple)
    ? +market.rMultiple
    : (rps > 0 ? (long ? (price - entry) : (entry - price)) / rps : 0);
  const targets = Array.isArray(position.targets) ? position.targets : [];
  const partialsTaken = Array.isArray(position.partialsTaken) ? position.partialsTaken.map(Number) : [];
  const breakevenR = Number.isFinite(+position.breakevenR) && +position.breakevenR > 0 ? +position.breakevenR : 1;

  // 1. Stop hit — exit, never hold through the stop.
  if (long ? price <= stop : price >= stop) {
    return { action: 'exit', newStop: stop, reason: `EXIT: stop $${stop} hit at $${price} (${rMult.toFixed(2)}R).` };
  }
  // 2. Newly-tagged target — partial (highest newly-tagged R first).
  const due = targets
    .filter(t => Number.isFinite(+t.r) && rMult >= +t.r && !partialsTaken.includes(+t.r))
    .sort((a, b) => +b.r - +a.r);
  if (due.length > 0) {
    const t = due[0];
    const label = t.type === 'or-width' ? 'OR-width projection' : 'target';
    return {
      action: 'partial', newStop: stop, target: t,
      reason: `PARTIAL: ${label} ${t.r}R tagged at $${price} — take ${t.pct || 0}% off.`,
    };
  }
  // 3. Breakeven trigger.
  const alreadyBE = position.breakevenAt === true
    || (Number.isFinite(+position.breakevenAt) && +position.breakevenAt > 0);
  if (!alreadyBE && rMult >= breakevenR) {
    return {
      action: 'breakeven', newStop: entry,
      reason: `BREAKEVEN: ${rMult.toFixed(2)}R ≥ ${breakevenR}R — move stop to entry $${entry}.`,
    };
  }
  // 4. Trailing.
  const trailMode = String(position.trailMode || 'none').toLowerCase();
  const effectiveStop = alreadyBE ? entry : stop;
  let candidate = null;
  if (trailMode === 'atr' && Number.isFinite(+market.atr) && +market.atr > 0) {
    const mult = Number.isFinite(+position.trailAtrMult) && +position.trailAtrMult > 0 ? +position.trailAtrMult : 1.5;
    candidate = long ? price - mult * +market.atr : price + mult * +market.atr;
  } else if (trailMode === 'vwap' && Number.isFinite(+market.vwap) && rMult >= breakevenR) {
    candidate = long ? Math.min(+market.vwap, price) : Math.max(+market.vwap, price);
  }
  if (candidate !== null && Number.isFinite(candidate)) {
    const improves = long ? candidate > effectiveStop : candidate < effectiveStop;
    if (improves) {
      return {
        action: 'trail', newStop: +candidate.toFixed(4),
        reason: `TRAIL: ${trailMode.toUpperCase()} stop tightened to $${candidate.toFixed(2)}.`,
      };
    }
  }
  return { action: 'hold', newStop: stop, reason: `HOLD: $${price} (${rMult.toFixed(2)}R) — no exit trigger.` };
}

// ---------------------------------------------------------------------------
// sizePosition — all four sizing modes. Returns { shares, notional, riskDollars }.
// Never throws; invalid input yields 0 shares.
// ---------------------------------------------------------------------------
function sizePosition({ mode, entry, stop, accountEquity, fixedDollars, fixedShares, acctPct, riskPct } = {}) {
  const e = finite(entry);
  const eq = finite(accountEquity);
  const m = String(mode || 'dollars').toLowerCase();
  const zero = { shares: 0, notional: 0, riskDollars: 0 };
  if (e === null || e <= 0 || eq === null || eq <= 0) return zero;

  let shares = 0;
  if (m === 'shares') {
    const s = +fixedShares;
    shares = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  } else if (m === 'acctpct' || m === 'acct_pct') {
    const p = +acctPct;
    shares = Number.isFinite(p) && p > 0 ? Math.floor((eq * p) / 100 / e) : 0;
  } else if (m === 'risk') {
    const p = +riskPct;
    const s = finite(stop);
    const rps = s === null ? NaN : Math.abs(e - s);
    shares = (Number.isFinite(p) && p > 0 && Number.isFinite(rps) && rps > 0)
      ? Math.floor(((eq * p) / 100) / rps) : 0;
  } else { // 'dollars' (default)
    const d = +fixedDollars;
    shares = Number.isFinite(d) && d > 0 ? Math.floor(d / e) : 0;
  }
  shares = Math.max(0, Math.floor(shares));
  const rps2 = Number.isFinite(+stop) ? Math.abs(e - +stop) : 0;
  return {
    shares,
    notional: +(shares * e).toFixed(2),
    riskDollars: +(shares * rps2).toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Daily locks. dayState: { date (ET 'YYYY-MM-DD'), pnl, trades, consecLosses,
// openPositions, exposureDollars, tradesBySymbol: {SYM: n} }.
// Locks are keyed by the ET date — the caller starts a fresh dayState per
// date; this function never resets anything intraday, it only evaluates.
// ---------------------------------------------------------------------------
function checkDailyLocks(dayState = {}, rules = DEFAULT_ORB_RULES) {
  const r = mergedOrbRules(rules);
  const d = dayState || {};
  const reasons = [];
  const num = v => (Number.isFinite(+v) ? +v : 0);

  const pnl = num(d.pnl);
  if (pnl <= -r.maxDailyLossDollars) {
    reasons.push(`MAX_DAILY_LOSS: day P&L $${pnl.toFixed(2)} at/beyond the -$${r.maxDailyLossDollars} limit.`);
  }
  if (num(d.trades) >= r.maxTradesPerDay) {
    reasons.push(`MAX_TRADES_PER_DAY: ${num(d.trades)} trades hit the ${r.maxTradesPerDay} cap.`);
  }
  if (num(d.consecLosses) >= r.maxConsecLosses) {
    reasons.push(`MAX_CONSEC_LOSSES: ${num(d.consecLosses)} consecutive losses hit the ${r.maxConsecLosses} limit.`);
  }
  if (num(d.openPositions) >= r.maxPositions) {
    reasons.push(`MAX_POSITIONS: ${num(d.openPositions)} open positions hit the ${r.maxPositions} cap.`);
  }
  if (num(d.exposureDollars) >= r.maxExposureDollars) {
    reasons.push(`MAX_EXPOSURE: $${num(d.exposureDollars).toFixed(2)} exposure hit the $${r.maxExposureDollars} cap.`);
  }
  const tbs = (d.tradesBySymbol && typeof d.tradesBySymbol === 'object') ? d.tradesBySymbol : {};
  for (const [sym, n] of Object.entries(tbs)) {
    if (num(n) >= r.maxTradesPerSymbol) {
      reasons.push(`MAX_TRADES_PER_SYMBOL: ${sym} at ${num(n)} trades (cap ${r.maxTradesPerSymbol}).`);
    }
  }
  return { locked: reasons.length > 0, reasons };
}

// Pure state transition: returns a NEW dayState, never mutates the input.
function recordTradeResult(dayState = {}, { pnl = 0, symbol = 'UNKNOWN' } = {}) {
  const d = { ...(dayState || {}), tradesBySymbol: { ...((dayState || {}).tradesBySymbol || {}) } };
  const p = Number.isFinite(+pnl) ? +pnl : 0;
  const sym = String(symbol || 'UNKNOWN');
  d.pnl = (Number.isFinite(+d.pnl) ? +d.pnl : 0) + p;
  d.trades = (Number.isFinite(+d.trades) ? +d.trades : 0) + 1;
  d.consecLosses = p < 0 ? (Number.isFinite(+d.consecLosses) ? +d.consecLosses : 0) + 1 : 0;
  d.tradesBySymbol[sym] = (Number.isFinite(+d.tradesBySymbol[sym]) ? +d.tradesBySymbol[sym] : 0) + 1;
  return d;
}

// ---------------------------------------------------------------------------
// validateConfig — config-panel validation. Merges onto defaults first so a
// partial override still validates. Returns { ok, errors: [] }.
// ---------------------------------------------------------------------------
function validateConfig(rules = {}) {
  const r = mergedOrbRules(rules);
  const errors = [];
  const err = (field, msg) => errors.push(`${field}: ${msg}`);
  const isNum = v => Number.isFinite(+v);

  if (![5, 15, 30].includes(+r.orMinutes)) err('orMinutes', 'must be 5, 15, or 30');

  for (const [sKey, eKey, label] of [
    ['entryWindowStart', 'entryWindowEnd', 'entry window'],
    ['secondWindowStart', 'secondWindowEnd', 'second window'],
  ]) {
    const a = parseClock(r[sKey], -1);
    const b = parseClock(r[eKey], -1);
    if (a < 0) err(sKey, 'must be HH:MM (24h)');
    if (b < 0) err(eKey, 'must be HH:MM (24h)');
    if (a >= 0 && b >= 0 && !(a < b)) err(label, `${r[sKey]} must be before ${r[eKey]}`);
  }
  if (typeof r.secondWindowEnabled !== 'boolean') err('secondWindowEnabled', 'must be boolean');

  if (!isNum(r.minScore) || +r.minScore < 0 || +r.minScore > 100) err('minScore', 'must be 0–100');
  const wKeys = ['regime', 'volume', 'relStrength', 'vwap', 'breakoutQuality', 'levelClearance', 'trendAlign', 'volatility', 'premarket'];
  if (wKeys.some(k => !isNum(r.weights[k]) || +r.weights[k] < 0)) {
    err('weights', 'each weight must be a non-negative number');
  } else {
    const wSum = wKeys.reduce((a, k) => a + (+r.weights[k] || 0), 0);
    if (Math.abs(wSum - 100) > 1e-9) err('weights', `must sum to 100 (got ${wSum})`);
  }

  if (!(+r.minRvol > 0)) err('minRvol', 'must be > 0');
  if (!(+r.preferredRvol >= +r.minRvol)) err('preferredRvol', 'must be ≥ minRvol');
  if (!(+r.strongRvol >= +r.preferredRvol)) err('strongRvol', 'must be ≥ preferredRvol');

  if (!(+r.minPrice > 0)) err('minPrice', 'must be > 0');
  if (!(+r.maxPrice > +r.minPrice)) err('maxPrice', 'must be > minPrice');
  if (!(+r.minAvgVolume > 0)) err('minAvgVolume', 'must be > 0');
  if (!(+r.maxSpreadPct > 0)) err('maxSpreadPct', 'must be > 0');
  if (!Number.isInteger(+r.maxPositions) || +r.maxPositions < 1) err('maxPositions', 'must be an integer ≥ 1');

  const wl = r.watchlist;
  if (wl !== '' && wl != null && !Array.isArray(wl) && typeof wl !== 'string') {
    err('watchlist', 'must be a comma-separated string or an array of symbols');
  }

  if (typeof r.allowLong !== 'boolean') err('allowLong', 'must be boolean');
  if (typeof r.allowShort !== 'boolean') err('allowShort', 'must be boolean');
  if (r.allowLong !== true && r.allowShort !== true) err('direction', 'at least one of allowLong/allowShort must be true');

  if (!['direct', 'retest', 'either'].includes(String(r.entryMode).toLowerCase())) err('entryMode', 'must be direct, retest, or either');
  if (!Number.isInteger(+r.maxAttemptsPerSymbol) || +r.maxAttemptsPerSymbol < 1) err('maxAttemptsPerSymbol', 'must be an integer ≥ 1');
  if (!isNum(r.cooldownMinutes) || +r.cooldownMinutes < 0) err('cooldownMinutes', 'must be ≥ 0');

  if (!['dollars', 'shares', 'acctpct', 'risk'].includes(String(r.sizingMode).toLowerCase())) err('sizingMode', 'must be dollars, shares, acctPct, or risk');
  if (!(+r.fixedDollars > 0)) err('fixedDollars', 'must be > 0');
  if (!(+r.fixedShares > 0)) err('fixedShares', 'must be > 0');
  if (!(+r.acctPct > 0)) err('acctPct', 'must be > 0');
  if (!(+r.riskPct > 0)) err('riskPct', 'must be > 0');

  const stopModes = ['pct', 'atr', 'oropposite', 'breakoutlevel', 'retestextreme', 'dollarrisk'];
  if (!stopModes.includes(String(r.stopMode).toLowerCase().replace(/_/g, ''))) err('stopMode', `must be one of ${stopModes.join(', ')}`);
  if (!(+r.stopPct > 0)) err('stopPct', 'must be > 0');
  if (!(+r.atrStopMult > 0)) err('atrStopMult', 'must be > 0');
  if (!(+r.dollarRisk > 0)) err('dollarRisk', 'must be > 0');

  if (!Array.isArray(r.targets) || r.targets.length === 0) {
    err('targets', 'must be a non-empty array');
  } else {
    let pctSum = 0;
    r.targets.forEach((t, i) => {
      if (!(+t.r > 0)) err(`targets[${i}].r`, 'must be > 0');
      if (!isNum(t.pct) || +t.pct < 0 || +t.pct > 100) err(`targets[${i}].pct`, 'must be 0–100');
      pctSum += +t.pct || 0;
    });
    if (Math.abs(pctSum - 100) > 1e-9) err('targets', `pct allocations must sum to 100 (got ${pctSum})`);
  }
  if (!(+r.breakevenR > 0)) err('breakevenR', 'must be > 0');
  if (!['none', 'atr', 'vwap'].includes(String(r.trailMode).toLowerCase())) err('trailMode', 'must be none, atr, or vwap');
  if (typeof r.orWidthTargets !== 'boolean') err('orWidthTargets', 'must be boolean');

  if (!(+r.maxDailyLossDollars > 0)) err('maxDailyLossDollars', 'must be > 0');
  if (!Number.isInteger(+r.maxTradesPerDay) || +r.maxTradesPerDay < 1) err('maxTradesPerDay', 'must be an integer ≥ 1');
  if (!Number.isInteger(+r.maxConsecLosses) || +r.maxConsecLosses < 1) err('maxConsecLosses', 'must be an integer ≥ 1');
  if (!(+r.maxExposureDollars > 0)) err('maxExposureDollars', 'must be > 0');
  if (!Number.isInteger(+r.maxTradesPerSymbol) || +r.maxTradesPerSymbol < 1) err('maxTradesPerSymbol', 'must be an integer ≥ 1');

  if (typeof r.requireVwapAgree !== 'boolean') err('requireVwapAgree', 'must be boolean');
  if (!isNum(r.minLevelClearancePct) || +r.minLevelClearancePct < 0) err('minLevelClearancePct', 'must be ≥ 0');
  if (!(+r.minRR > 0)) err('minRR', 'must be > 0');
  if (!(+r.maxWickPct > 0) || +r.maxWickPct > 100) err('maxWickPct', 'must be 0–100');
  if (!(+r.maxExtensionAtrs > 0)) err('maxExtensionAtrs', 'must be > 0');

  if (!['block', 'reduce', 'allow'].includes(String(r.newsPolicy).toLowerCase())) err('newsPolicy', 'must be block, reduce, or allow');
  if (!['PAPER', 'LIVE'].includes(String(r.tradingMode).toUpperCase())) err('tradingMode', 'must be PAPER or LIVE');
  if (String(r.tradingMode).toUpperCase() === 'LIVE' && !(r.liveEnabled === true && r.liveConfirmed === true)) {
    err('tradingMode', 'LIVE requires both liveEnabled and liveConfirmed to be true');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  DEFAULT_ORB_RULES,
  parseWatchlist,
  computeOpeningRange,
  classifyRegime,
  scoreSetup,
  evaluateEntry,
  planExit,
  sizePosition,
  checkDailyLocks,
  recordTradeResult,
  validateConfig,
  // ET helpers are exported for wave-2/wave-3 reuse (pure, no I/O).
  _et: { easternDate, easternTimeMinutes, easternDayStartMs, parseClock, etClock },
};
