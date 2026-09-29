'use strict';

// Warrior Bot — pure pattern detectors over 1-minute candles.
// Each detector takes ({ candles, ind, levels }, opts) where
//   candles: [{t,o,h,l,c,v}] oldest → newest (t = ms epoch)
//   ind:     computeIntraday(candles) output (same length)
//   levels:  optional S/R context:
//     { supports:[], resistances:[], prevDayHigh, prevDayLow,
//       premarketHigh, premarketLow, openingRangeHigh, openingRangeLow }
// and returns null (no structural match) or a result object. A structural
// match whose reward:risk < minRR (default 2.0) is returned with
// pattern_valid:false and an explanation — never silently dropped.
// Deterministic: same input → same output. No I/O.

const { swingPoints } = require('./indicators');

const isBull = c => +c.c > +c.o;
const isBear = c => +c.c < +c.o;
const round2 = v => Number.isFinite(v) ? +v.toFixed(2) : v;
const round4 = v => Number.isFinite(v) ? +v.toFixed(4) : v;

// Merge caller-supplied levels with swing-derived ones from recent bars.
function collectLevels(candles, levels, lookback = 60) {
  const slice = candles.slice(Math.max(0, candles.length - lookback));
  const swings = swingPoints(slice, 3, 3);
  const resistances = [
    ...(levels?.resistances || []),
    ...swings.highs.map(s => s.price),
    levels?.prevDayHigh, levels?.premarketHigh, levels?.openingRangeHigh,
  ].filter(Number.isFinite);
  const supports = [
    ...(levels?.supports || []),
    ...swings.lows.map(s => s.price),
    levels?.prevDayLow, levels?.premarketLow, levels?.openingRangeLow,
  ].filter(Number.isFinite);
  return { resistances, supports };
}
const nearestAbove = (arr, price) => {
  const c = arr.filter(p => p > price).sort((a, b) => a - b);
  return c.length ? c[0] : null;
};
const nearestBelow = (arr, price) => {
  const c = arr.filter(p => p < price).sort((a, b) => a - b);
  return c.length ? c[c.length - 1] : null;
};

// Shared quality mapping: `checks` is an array of booleans (passed quality
// gates). score is a 0–3 contribution, confidence a 0–1 probability proxy.
function quality(checks) {
  const passed = checks.filter(Boolean).length;
  const total = Math.max(1, checks.length);
  return {
    score: round2(Math.min(3, (passed / total) * 3)),
    confidence: round2(Math.min(0.95, 0.35 + 0.12 * passed)),
  };
}

// Common result builder. target falls back to entry + minRR*risk when no
// structural target exists; a structural target with rr < minRR invalidates.
function finalize({
  name, candles, startIdx, completeIdx, entry, stop, support, resistance,
  structuralTarget, minRR = 2.0, checks, explanation, forceInvalid = false,
}) {
  const q = quality(checks);
  const risk = entry - stop;
  const target = structuralTarget !== null && structuralTarget !== undefined
    ? structuralTarget : entry + risk * minRR;
  const reward = target - entry;
  const rr = risk > 0 ? reward / risk : -Infinity;
  const levelsOk = [entry, stop, target].every(Number.isFinite) && risk > 0 && reward > 0;
  const valid = !forceInvalid && levelsOk && rr >= minRR;
  const note = forceInvalid ? 'INVALID: pattern structure was invalidated.'
    : `INVALID: reward:risk ${round2(rr)} is below the ${minRR} minimum.`;
  return {
    pattern_name: name,
    pattern_valid: valid,
    pattern_confidence: q.confidence,
    pattern_start_time: candles[startIdx]?.t ?? null,
    pattern_completion_time: candles[completeIdx]?.t ?? null,
    entry_price: round4(entry),
    stop_price: round4(stop),
    support_level: support !== undefined ? round4(support) : null,
    resistance_level: resistance !== undefined ? round4(resistance) : null,
    invalidation_price: round4(stop),
    target_price: round4(target),
    risk_reward: round2(rr),
    pattern_score: q.score,
    explanation: valid ? explanation : `${explanation} ${note}`,
  };
}

function lastBar(candles, ind) {
  const i = candles.length - 1;
  return { i, c: candles[i], ind: ind[i] };
}
function requireInd(indRow, ...keys) {
  return indRow && keys.every(k => Number.isFinite(indRow[k]));
}

// ---------------------------------------------------------------------------
// 1. Candle-over-candle: candle B breaks candle A's high — bullish B
// preferred, B volume >= A volume, above VWAP, MACD >= 0 or improving.
// Stop below A's low.
// ---------------------------------------------------------------------------
function detectCandleOverCandle({ candles, ind, levels = {} }, opts = {}) {
  const minRR = opts.minRR ?? 2.0;
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const { i, c: B, ind: bi } = lastBar(candles, ind);
  const A = candles[i - 1];
  if (!requireInd(bi, 'vwap', 'macd', 'macdHist')) return null;
  const prevHist = ind[i - 1]?.macdHist;
  const macdOk = bi.macd >= 0 || (Number.isFinite(prevHist) && bi.macdHist > prevHist);
  if (!(+B.h > +A.h)) return null;                    // B must break A's high
  if (!(+B.v >= +A.v)) return null;                   // B volume >= A volume
  if (!(+B.c > bi.vwap)) return null;                 // above VWAP
  if (!macdOk) return null;                           // MACD >= 0 or improving
  const bullish = isBull(B);
  const entry = +B.c;
  const stop = +A.l;
  const lv = collectLevels(candles, levels);
  const resistance = nearestAbove(lv.resistances, entry);
  return finalize({
    name: 'CandleOverCandle', candles, startIdx: i - 1, completeIdx: i,
    entry, stop, support: stop, resistance,
    structuralTarget: resistance, minRR,
    checks: [bullish, +B.v >= 1.5 * +A.v, bi.macd >= 0, +B.c > bi.vwap * 1.002, +B.h - +B.l > +A.h - +A.l],
    explanation: `Candle B broke above candle A's high (${round4(+A.h)}) with volume ${round2(+B.v / Math.max(+A.v, 1))}x of A, closing above VWAP with MACD ${bi.macd >= 0 ? 'positive' : 'improving'}.`,
  });
}

// ---------------------------------------------------------------------------
// 2. Micro pullback: impulse, then 1–3 controlled pullback candles, then the
// first continuation candle breaks the pullback high. Stop below the
// pullback low.
// ---------------------------------------------------------------------------
function detectMicroPullback({ candles, ind, levels = {} }, opts = {}) {
  const minRR = opts.minRR ?? 2.0;
  if (!Array.isArray(candles) || candles.length < 6) return null;
  const { i, c: C, ind: ci } = lastBar(candles, ind);
  if (!isBull(C)) return null;
  if (!requireInd(ci, 'atr', 'vwap')) return null;
  // Pullback: 1–3 non-bullish candles directly before C.
  let pbEnd = i - 1; let pbStart = pbEnd;
  while (pbStart >= 0 && pbStart >= i - 3 && !isBull(candles[pbStart])) pbStart -= 1;
  pbStart += 1;
  const pbCount = pbEnd - pbStart + 1;
  if (pbCount < 1 || pbCount > 3) return null;
  const pbHigh = Math.max(...candles.slice(pbStart, pbEnd + 1).map(c => +c.h));
  const pbLow = Math.min(...candles.slice(pbStart, pbEnd + 1).map(c => +c.l));
  if (!(+C.c > pbHigh)) return null;                  // continuation breaks pullback high
  // Impulse: bars before the pullback.
  const impEnd = pbStart - 1;
  const impStart = Math.max(0, impEnd - 7);
  if (impEnd - impStart + 1 < 2) return null;
  const impRise = +candles[impEnd].c - +candles[impStart].o;
  const atr = ci.atr;
  if (!(impRise >= 1.5 * atr)) return null;            // genuine impulse
  const impBull = candles.slice(impStart, impEnd + 1).filter(isBull).length;
  if (impBull < Math.ceil((impEnd - impStart + 1) / 2)) return null;
  const pullbackDepth = +candles[impEnd].c - pbLow;
  if (!(pullbackDepth < 0.5 * impRise)) return null;   // controlled, <50% retrace
  const entry = +C.c;
  const stop = pbLow;
  const lv = collectLevels(candles, levels);
  const resistance = nearestAbove(lv.resistances, entry);
  const aboveVwap = +C.c > ci.vwap;
  return finalize({
    name: 'MicroPullback', candles, startIdx: impStart, completeIdx: i,
    entry, stop, support: stop, resistance,
    structuralTarget: resistance, minRR,
    checks: [pbCount <= 2, pullbackDepth < 0.382 * impRise, aboveVwap, impBull >= impEnd - impStart, +C.v >= ci.avgVol20],
    explanation: `Impulse of ${round2(impRise)} followed by a ${pbCount}-candle controlled pullback (retrace ${round2(pullbackDepth / impRise * 100)}%); continuation candle broke the pullback high ${round4(pbHigh)}.`,
  });
}

// ---------------------------------------------------------------------------
// 3. Bull flag: impulse, then a 2–4 candle pullback (flag), entry above flag
// resistance on the breakout bar. Stop below the pullback low.
// ---------------------------------------------------------------------------
function detectBullFlag({ candles, ind, levels = {} }, opts = {}) {
  const minRR = opts.minRR ?? 2.0;
  if (!Array.isArray(candles) || candles.length < 8) return null;
  const { i, c: B, ind: bi } = lastBar(candles, ind);
  if (!requireInd(bi, 'atr', 'vwap')) return null;
  // Flag: 2–4 candles directly before the breakout bar.
  for (let flagLen = 2; flagLen <= 4; flagLen += 1) {
    const fEnd = i - 1; const fStart = fEnd - flagLen + 1;
    if (fStart < 2) continue;
    const flag = candles.slice(fStart, fEnd + 1);
    const flagHigh = Math.max(...flag.map(c => +c.h));
    const flagLow = Math.min(...flag.map(c => +c.l));
    if (!(isBull(B) && +B.c > flagHigh)) continue;     // breakout bar
    // Impulse: up to 10 bars before the flag.
    const impEnd = fStart - 1;
    const impStart = Math.max(0, impEnd - 9);
    const impRise = +candles[impEnd].c - +candles[impStart].o;
    const atr = bi.atr;
    if (!(impRise >= 2.5 * atr || impRise / +candles[impStart].o >= 0.03)) continue;
    // Flag quality: lower highs, contained within 50% of the impulse.
    const highs = flag.map(c => +c.h);
    const lowerHighs = highs.slice(1).every((h, k) => h <= highs[k] + 0.25 * atr);
    if (!lowerHighs) continue;
    if (!((+candles[impEnd].h - flagLow) < 0.5 * impRise)) continue;
    if (!(+B.c > bi.vwap)) continue;
    const entry = +B.c;
    const stop = flagLow;
    const target = entry + impRise;                    // measured move
    return finalize({
      name: 'BullFlag', candles, startIdx: impStart, completeIdx: i,
      entry, stop, support: stop, resistance: flagHigh,
      structuralTarget: target, minRR,
      checks: [flagLen <= 3, impRise / +candles[impStart].o >= 0.03, +B.v >= bi.avgVol20, bi.macdHist > (ind[i - 1]?.macdHist ?? -Infinity), +B.c > bi.vwap * 1.002],
      explanation: `Impulse of ${round2(impRise)} (${round2(impRise / +candles[impStart].o * 100)}%) into a ${flagLen}-candle flag; breakout bar closed above flag resistance ${round4(flagHigh)} with measured-move target ${round4(target)}.`,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. ABCD: A high → B pullback low → C rebound → D second pullback with
// D > B (else INVALIDATE). Entry on breakout above C resistance, stop below D.
// ---------------------------------------------------------------------------
function detectABCD({ candles, ind, levels = {} }, opts = {}) {
  const minRR = opts.minRR ?? 2.0;
  if (!Array.isArray(candles) || candles.length < 12) return null;
  const { i, c: B0, ind: bi } = lastBar(candles, ind);
  if (!requireInd(bi, 'vwap')) return null;
  const swings = swingPoints(candles.slice(0, i), 2, 2); // structure before breakout bar
  const n = candles.length;
  // Find the latest A(high) < B(low) < C(high) < D(low) alternation.
  const highs = swings.highs; const lows = swings.lows;
  for (let d = lows.length - 1; d >= 0; d -= 1) {
    const D = lows[d];
    if (n - 1 - D.idx > 8) break;                      // D must be recent
    const C = [...highs].reverse().find(h => h.idx < D.idx);
    if (!C) continue;
    const Bp = [...lows].reverse().find(l => l.idx < C.idx);
    if (!Bp) continue;
    const A = [...highs].reverse().find(h => h.idx < Bp.idx);
    if (!A) continue;
    if (!(A.price > Bp.price && C.price > Bp.price
      && D.price < C.price && C.price < A.price * 1.01)) continue;
    const neckline = C.price;
    const checks = [C.price <= A.price, D.price >= (Bp.price + C.price) / 2, isBull(B0), +B0.c > bi.vwap];
    if (!(D.price > Bp.price)) {
      // D undercut B: the ABCD structure is invalidated, not a candidate.
      return finalize({
        name: 'ABCD', candles, startIdx: A.idx, completeIdx: i,
        entry: +B0.c, stop: D.price, support: D.price, resistance: neckline,
        structuralTarget: null, minRR, checks, forceInvalid: true,
        explanation: `D (${round4(D.price)}) undercut B (${round4(Bp.price)}) — ABCD structure invalidated.`,
      });
    }
    if (!(+B0.c > neckline)) continue;                // breakout above C resistance
    const entry = +B0.c;
    const stop = D.price;
    const ab = A.price - Bp.price;
    const target = entry + ab;                        // AB=CD projection
    return finalize({
      name: 'ABCD', candles, startIdx: A.idx, completeIdx: i,
      entry, stop, support: stop, resistance: neckline,
      structuralTarget: target, minRR, checks,
      explanation: `ABCD: A ${round4(A.price)} → B ${round4(Bp.price)} → C ${round4(C.price)} → D ${round4(D.price)} (D held above B); breakout above C resistance ${round4(neckline)} with AB=CD target ${round4(target)}.`,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Cup and handle: advance to a rim, rounded pullback, recovery to the rim,
// small handle, entry above cup resistance. Stop below the handle low.
// ---------------------------------------------------------------------------
function detectCupAndHandle({ candles, ind, levels = {} }, opts = {}) {
  const minRR = opts.minRR ?? 2.0;
  const window = opts.lookback ?? 30;
  if (!Array.isArray(candles) || candles.length < window + 2) return null;
  const { i, c: B0, ind: bi } = lastBar(candles, ind);
  if (!requireInd(bi, 'vwap')) return null;
  const seg = candles.slice(i - window, i);           // structure before breakout bar
  const rim = Math.max(...seg.map(c => +c.h));
  const rimIdxs = seg.map((c, k) => (+c.h >= rim * 0.997 ? k : -1)).filter(k => k >= 0);
  if (rimIdxs.length < 2) return null;
  const leftRim = rimIdxs[0];
  const rightRim = rimIdxs[rimIdxs.length - 1];
  if (rightRim - leftRim < 6) return null;
  const mid = seg.slice(leftRim, rightRim + 1);
  let bottomRel = 0; let bottom = Infinity;
  mid.forEach((c, k) => { if (+c.l < bottom) { bottom = +c.l; bottomRel = k; } });
  const cupDepth = rim - bottom;
  if (!(cupDepth > rim * 0.01)) return null;           // needs a real cup
  if (!(bottomRel > 1 && bottomRel < mid.length - 2)) return null; // interior bottom
  // U-shape: lows descend into the bottom then ascend out of it.
  const leftLows = mid.slice(0, bottomRel + 1).map(c => +c.l);
  const rightLows = mid.slice(bottomRel).map(c => +c.l);
  const desc = leftLows.slice(1).filter((l, k) => l <= leftLows[k] + cupDepth * 0.15).length;
  const asc = rightLows.slice(1).filter((l, k) => l >= rightLows[k] - cupDepth * 0.15).length;
  const rounded = desc >= leftLows.length * 0.5 && asc >= rightLows.length * 0.5;
  // Handle: last 2–4 bars of seg, below the rim, above the cup bottom.
  const handle = seg.slice(-4);
  if (handle.length < 2) return null;
  const handleHigh = Math.max(...handle.map(c => +c.h));
  const handleLow = Math.min(...handle.map(c => +c.l));
  if (!(handleHigh < rim)) return null;
  if (!(handleLow > bottom)) return null;
  const handleDepth = rim - handleLow;
  if (!(handleDepth < 0.4 * cupDepth)) return null;   // small handle
  if (!(isBull(B0) && +B0.c > rim)) return null;       // breakout above the rim
  const entry = +B0.c;
  const stop = handleLow;
  const target = entry + cupDepth;                     // measured move
  return finalize({
    name: 'CupAndHandle', candles, startIdx: i - window + leftRim, completeIdx: i,
    entry, stop, support: stop, resistance: rim,
    structuralTarget: target, minRR,
    checks: [rounded, handleDepth < 0.25 * cupDepth, +B0.v >= bi.avgVol20, +B0.c > bi.vwap, handle.length <= 3],
    explanation: `Cup (depth ${round2(cupDepth)}, ${rounded ? 'rounded' : 'V-shaped'} bottom) with a ${handle.length}-bar handle; breakout above cup resistance ${round4(rim)}, measured-move target ${round4(target)}.`,
  });
}

// ---------------------------------------------------------------------------
// 6. Inverted head and shoulders: left shoulder, lower head, higher right
// shoulder; entry above the neckline, stop below the right shoulder.
// ---------------------------------------------------------------------------
function detectInvertedHeadAndShoulders({ candles, ind, levels = {} }, opts = {}) {
  const minRR = opts.minRR ?? 2.0;
  if (!Array.isArray(candles) || candles.length < 15) return null;
  const { i, c: B0, ind: bi } = lastBar(candles, ind);
  if (!requireInd(bi, 'vwap')) return null;
  const swings = swingPoints(candles.slice(0, i), 2, 2);
  const n = candles.length;
  const lows = swings.lows; const highs = swings.highs;
  for (let s = lows.length - 1; s >= 2; s -= 1) {
    const RS = lows[s];                                // right shoulder
    if (n - 1 - RS.idx > 10) break;
    const H = lows[s - 1];                             // head
    const LS = lows[s - 2];                            // left shoulder
    if (!(H.price < LS.price && H.price < RS.price)) continue;
    if (!(RS.price >= LS.price * 0.98)) continue;      // right shoulder not lower
    const H1 = highs.filter(h => h.idx > LS.idx && h.idx < H.idx).pop();
    const H2 = highs.filter(h => h.idx > H.idx && h.idx < RS.idx).pop();
    if (!H1 || !H2) continue;
    const neckline = Math.max(H1.price, H2.price);
    if (!(isBull(B0) && +B0.c > neckline)) continue;   // breakout above neckline
    const entry = +B0.c;
    const stop = RS.price;
    const headDepth = neckline - H.price;
    const target = neckline + headDepth;
    return finalize({
      name: 'InvertedHeadAndShoulders', candles, startIdx: LS.idx, completeIdx: i,
      entry, stop, support: stop, resistance: neckline,
      structuralTarget: target, minRR,
      checks: [RS.price >= LS.price, headDepth > neckline * 0.005, +B0.v >= bi.avgVol20, +B0.c > bi.vwap, (neckline - Math.min(H1.price, H2.price)) / neckline < 0.01],
      explanation: `Inverted H&S: left shoulder ${round4(LS.price)}, head ${round4(H.price)}, right shoulder ${round4(RS.price)}; breakout above neckline ${round4(neckline)}, measured target ${round4(target)}.`,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// 7. VWAP reclaim: dip below VWAP, stabilize, bullish cross back above VWAP
// with volume expansion and improving MACD, then hold above VWAP for
// `confirmationBars` (default 2). NEVER triggers on the cross alone.
// ---------------------------------------------------------------------------
function detectVwapReclaim({ candles, ind, levels = {} }, opts = {}) {
  const minRR = opts.minRR ?? 2.0;
  const confirmationBars = Math.max(1, Math.floor(opts.confirmationBars ?? 2));
  if (!Array.isArray(candles) || candles.length < 6 + confirmationBars) return null;
  const { i } = lastBar(candles, ind);
  // Confirmation: the last `confirmationBars` bars all closed above VWAP.
  const conf = [];
  for (let k = 0; k < confirmationBars; k += 1) {
    const b = candles[i - k]; const r = ind[i - k];
    if (!b || !requireInd(r, 'vwap')) return null;
    if (!(+b.c > r.vwap)) return null;
    conf.unshift({ b, r, k: i - k });
  }
  // Cross-up bar directly before the confirmation run.
  const x = i - confirmationBars;
  const X = candles[x]; const xr = ind[x];
  const prev = candles[x - 1]; const pr = ind[x - 1];
  if (!X || !prev || !requireInd(xr, 'vwap', 'macdHist') || !requireInd(pr, 'vwap', 'macdHist')) return null;
  if (!(isBull(X) && +X.c > xr.vwap && +prev.c <= pr.vwap)) return null; // the cross
  if (!(xr.rvol >= 1.5)) return null;                   // volume expansion
  if (!(xr.macdHist > pr.macdHist)) return null;       // MACD improving
  // Dip: at least one bar before the cross closed below VWAP.
  let dipIdx = -1;
  for (let k = x - 1; k >= Math.max(0, x - 12); k -= 1) {
    const b = candles[k]; const r = ind[k];
    if (!requireInd(r, 'vwap')) break;
    if (+b.c < r.vwap) { dipIdx = k; break; }
    if (+b.c > r.vwap && k < x - 1) break;             // ran into older above-VWAP action
  }
  if (dipIdx < 0) return null;
  const dipRegion = candles.slice(dipIdx, x);
  const dipLow = Math.min(...dipRegion.map(c => +c.l));
  const entry = +candles[i].c;
  const stop = dipLow;
  const lv = collectLevels(candles, levels);
  const resistance = nearestAbove(lv.resistances, entry);
  return finalize({
    name: 'VwapReclaim', candles, startIdx: dipIdx, completeIdx: i,
    entry, stop, support: stop, resistance,
    structuralTarget: resistance, minRR,
    checks: [xr.rvol >= 2, xr.macdHist > 0, +X.c - +X.o > (+X.h - +X.l) * 0.5, dipRegion.length <= 6, +candles[i].c > conf[0].r.vwap * 1.001],
    explanation: `Dip below VWAP to ${round4(dipLow)}, bullish cross back above VWAP on ${round2(xr.rvol)}x relative volume with improving MACD, then held above VWAP for ${confirmationBars} bar(s).`,
  });
}

const DETECTORS = {
  detectCandleOverCandle,
  detectMicroPullback,
  detectBullFlag,
  detectABCD,
  detectCupAndHandle,
  detectInvertedHeadAndShoulders,
  detectVwapReclaim,
};

// Run every detector; return valid patterns sorted by pattern_score desc
// (ties broken by pattern_name for determinism).
function detectAll({ candles, ind, levels = {} } = {}, opts = {}) {
  const out = [];
  for (const [key, fn] of Object.entries(DETECTORS)) {
    let r = null;
    try { r = fn({ candles, ind, levels }, opts); } catch { r = null; }
    if (r && r.pattern_valid) out.push({ detector: key, ...r });
  }
  out.sort((a, b) => (b.pattern_score - a.pattern_score)
    || (a.pattern_name < b.pattern_name ? -1 : a.pattern_name > b.pattern_name ? 1 : 0));
  return out;
}

module.exports = { ...DETECTORS, detectAll };
