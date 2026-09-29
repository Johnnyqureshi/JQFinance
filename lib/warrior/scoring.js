'use strict';

// Warrior Bot — setup scoring (spec §16). Pure function.
// Input:
//   pattern:           pattern detector result (or null)
//   ind:               latest intraday indicator row extended with price:
//                      { price, vwap, ema9, ema20, macd, macdHist, macdHistPrev, rvol }
//   regime:            'BULLISH' | 'NEUTRAL' | 'BEARISH'
//   dayChangePct:      % move from prior close
//   newIntradayHigh:   boolean
//   volumeExpanding:   boolean
//   aboveEma200Daily:  boolean | null (daily 200 EMA context; null = unknown)
//   rules:             DEFAULT_RULES override
//
// Points (weights default to 1, applied per bucket):
//   momentum: +2 strong RVOL (>= strongRvol), +2 new intraday high,
//             +1 volume expansion, +1 strong % move (>= 3%)
//   trend:    +2 above VWAP, +1 above 9 EMA, +1 9EMA >= 20EMA,
//             +1 above daily 200 EMA
//   macd:     +1 positive, +1 increasing
//   pattern:  +3 when a valid high-quality pattern (pattern_score >= 2)
// Max raw score is 16; displayScore caps at "15+".

const DEFAULT_RULES = Object.freeze({
  minScore: 9,
  highQuality: 11,
  minScoreBull: 9,
  minScoreNeutral: 10,
  minScoreBear: 12,
  minRR: 2.0,
  strongRvol: 2,
  veryStrongRvol: 5,
  weights: Object.freeze({ momentum: 1, trend: 1, macd: 1, pattern: 1 }),
});

const finite = v => Number.isFinite(+v) ? +v : null;

function scoreSetup({
  pattern = null, ind = {}, regime = 'NEUTRAL',
  dayChangePct = 0, newIntradayHigh = false, volumeExpanding = false,
  aboveEma200Daily = null,
} = {}, rules = DEFAULT_RULES) {
  const r = { ...DEFAULT_RULES, ...rules, weights: { ...DEFAULT_RULES.weights, ...(rules.weights || {}) } };
  const reasons = [];
  const award = (bucket, pts, reason) => {
    if (pts > 0) { bucket.points += pts; reasons.push(`+${pts} ${reason}`); }
    else reasons.push(`+0 ${reason} — not met`);
  };
  const momentum = { points: 0 }; const trend = { points: 0 };
  const macd = { points: 0 }; const pat = { points: 0 };

  const price = finite(ind.price);
  const vwap = finite(ind.vwap);
  const ema9 = finite(ind.ema9);
  const ema20 = finite(ind.ema20);
  const macdLine = finite(ind.macd);
  const macdHist = finite(ind.macdHist);
  const macdHistPrev = finite(ind.macdHistPrev);
  const rvol = finite(ind.rvol);
  const dayChg = finite(dayChangePct) ?? 0;

  // Momentum (max 6)
  award(momentum, rvol !== null && rvol >= r.strongRvol ? 2 : 0,
    `strong RVOL ${rvol === null ? '(unknown)' : rvol.toFixed(2) + 'x'} >= ${r.strongRvol}x`);
  award(momentum, newIntradayHigh === true ? 2 : 0, 'new intraday high');
  award(momentum, volumeExpanding === true ? 1 : 0, 'volume expanding');
  award(momentum, dayChg >= 3 ? 1 : 0, `day move ${dayChg.toFixed(2)}% >= 3%`);

  // Trend (max 5)
  award(trend, price !== null && vwap !== null && price > vwap ? 2 : 0, 'price above VWAP');
  award(trend, price !== null && ema9 !== null && price > ema9 ? 1 : 0, 'price above 9 EMA');
  award(trend, ema9 !== null && ema20 !== null && ema9 >= ema20 ? 1 : 0, '9 EMA >= 20 EMA');
  award(trend, aboveEma200Daily === true ? 1 : 0, 'price above daily 200 EMA');

  // MACD (max 2)
  award(macd, macdLine !== null && macdLine > 0 ? 1 : 0, 'MACD positive');
  award(macd, macdHist !== null && macdHistPrev !== null && macdHist > macdHistPrev ? 1 : 0,
    'MACD histogram increasing');

  // Pattern (max 3)
  const patScore = finite(pattern?.pattern_score);
  const patOk = pattern?.pattern_valid === true && patScore !== null && patScore >= 2;
  award(pat, patOk ? 3 : 0,
    `valid high-quality pattern${pattern ? ` (${pattern.pattern_name}, score ${patScore})` : ''}`);

  const breakdown = {
    momentum: Math.round(momentum.points * r.weights.momentum),
    trend: Math.round(trend.points * r.weights.trend),
    macd: Math.round(macd.points * r.weights.macd),
    pattern: Math.round(pat.points * r.weights.pattern),
  };
  const score = breakdown.momentum + breakdown.trend + breakdown.macd + breakdown.pattern;
  const minRequired = regime === 'BULLISH' ? r.minScoreBull
    : regime === 'BEARISH' ? r.minScoreBear : r.minScoreNeutral;
  return {
    score,
    displayScore: score > 15 ? '15+' : String(score),
    breakdown,
    reasons,
    minRequired,
    meetsMinimum: score >= minRequired,
    highQuality: score >= r.highQuality,
  };
}

module.exports = { DEFAULT_RULES, scoreSetup };
