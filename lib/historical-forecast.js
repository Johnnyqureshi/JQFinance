'use strict';

const LOOKBACKS = [30, 60, 90, 120, 180];
const HORIZONS = [5, 10, 20, 30, 60, 63];
const DEFAULT_WEIGHTS = Object.freeze({
  pricePath: 0.45,
  returns: 0.20,
  volatility: 0.15,
  momentum: 0.10,
  drawdown: 0.10,
});
const MIN_MATCHES = 10;

const finite = value => Number.isFinite(Number(value));
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function correlation(a, b) {
  if (!a?.length || a.length !== b?.length || a.length < 3) return 0;
  const am = mean(a);
  const bm = mean(b);
  let numerator = 0;
  let aSum = 0;
  let bSum = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - am;
    const db = b[i] - bm;
    numerator += da * db;
    aSum += da * da;
    bSum += db * db;
  }
  if (!aSum || !bSum) return 0;
  return clamp(numerator / Math.sqrt(aSum * bSum), -1, 1);
}

function normalize(values) {
  const base = Number(values?.[0]);
  if (!Number.isFinite(base) || base <= 0) return null;
  return values.map(value => Number(value) / base * 100);
}

function returns(values) {
  const output = [];
  for (let i = 1; i < values.length; i++) {
    const previous = Number(values[i - 1]);
    const current = Number(values[i]);
    output.push(previous > 0 ? current / previous - 1 : 0);
  }
  return output;
}

function volatility(values) {
  const changes = returns(values);
  const avg = mean(changes);
  if (avg == null) return 0;
  return Math.sqrt(mean(changes.map(change => (change - avg) ** 2)) || 0);
}

function drawdown(values) {
  let peak = -Infinity;
  return values.map(value => {
    peak = Math.max(peak, Number(value));
    return peak > 0 ? Number(value) / peak - 1 : 0;
  });
}

function similarity(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 0.0001);
  return clamp(1 - Math.abs(a - b) / (scale * 2));
}

function validateBars(input) {
  const bars = Array.isArray(input) ? input : [];
  const seen = new Set();
  const valid = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  let outOfOrder = false;
  let previousTime = -Infinity;

  for (const bar of bars) {
    const date = String(bar?.t ?? bar?.date ?? bar?.timestamp ?? '');
    const time = Date.parse(date);
    const open = Number(bar?.o ?? bar?.open);
    const high = Number(bar?.h ?? bar?.high);
    const low = Number(bar?.l ?? bar?.low);
    const close = Number(bar?.c ?? bar?.close);
    const volume = bar?.v ?? bar?.volume;
    const key = Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : date;
    if (seen.has(key)) duplicateCount++;
    seen.add(key);
    if (Number.isFinite(time) && time < previousTime) outOfOrder = true;
    previousTime = Math.max(previousTime, time);
    if (!Number.isFinite(time) || ![open, high, low, close].every(Number.isFinite)
      || open <= 0 || high <= 0 || low <= 0 || close <= 0
      || high < Math.max(open, close, low) || low > Math.min(open, close)
      || (volume != null && (!Number.isFinite(Number(volume)) || Number(volume) < 0))) {
      invalidCount++;
      continue;
    }
    valid.push({
      t: new Date(time).toISOString().slice(0, 10),
      o: open, h: high, l: low, c: close,
      v: volume == null ? null : Number(volume),
    });
  }

  valid.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return {
    bars: valid,
    quality: {
      supplied: bars.length,
      valid: valid.length,
      invalidCount,
      duplicateCount,
      outOfOrder,
      clean: invalidCount === 0 && duplicateCount === 0 && !outOfOrder,
    },
  };
}

function weightedQuantile(values, weights, percentile) {
  if (!values.length) return null;
  const pairs = values.map((value, index) => ({ value, weight: Math.max(0, weights[index] || 0) }))
    .sort((a, b) => a.value - b.value);
  const total = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  if (!total) return pairs[Math.min(pairs.length - 1, Math.floor(pairs.length * percentile))].value;
  let cumulative = 0;
  for (const pair of pairs) {
    cumulative += pair.weight;
    if (cumulative / total >= percentile) return pair.value;
  }
  return pairs.at(-1).value;
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return null;
  const p = clamp(successes / total);
  const denominator = 1 + z ** 2 / total;
  const centre = p + z ** 2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total);
  return [
    clamp((centre - spread) / denominator),
    clamp((centre + spread) / denominator),
  ];
}

function pathStats(matches, key, horizon) {
  const paths = matches.map(match => match.forwardPath).filter(path => path?.length === horizon + 1);
  if (!paths.length) return null;
  const average = [];
  const lower = [];
  const upper = [];
  for (let i = 0; i <= horizon; i++) {
    const values = paths.map(path => path[i]).filter(Number.isFinite);
    average.push(mean(values));
    lower.push(weightedQuantile(values, values.map(() => 1), 0.10));
    upper.push(weightedQuantile(values, values.map(() => 1), 0.90));
  }
  return { average, lower, upper, sampleSize: paths.length };
}

function robustnessFor(matches, probabilities, closest) {
  const count = matches.length;
  const avgSimilarity = mean(matches.map(match => match.similarity)) || 0;
  const maxProbability = Math.max(probabilities?.bull ?? 0, probabilities?.bear ?? 0);
  const labels = matches.map(match => match.outcome);
  const dominant = labels.length
    ? labels.sort((a, b) => labels.filter(x => x === b).length - labels.filter(x => x === a).length)[0]
    : null;
  const consistency = dominant ? labels.filter(label => label === dominant).length / labels.length : 0;
  const closestAgrees = closest?.outcome === dominant;
  let score = 1;
  if (count >= 10) score++;
  if (count >= 20) score++;
  if (count >= 50) score++;
  if (avgSimilarity >= 0.75) score++;
  else if (avgSimilarity < 0.55) score = Math.max(1, score - 1);
  if (maxProbability >= 0.65 && consistency >= 0.65) score++;
  if (!closestAgrees) score--;
  return Math.max(1, Math.min(5, count < MIN_MATCHES ? Math.min(3, score) : score));
}

function buildHistoricalForecast(input = {}) {
  const requestedLookback = Number(input.lookback) || 90;
  const requestedHorizon = Number(input.horizon) || 30;
  const lookback = LOOKBACKS.includes(requestedLookback) ? requestedLookback : 90;
  const horizon = HORIZONS.includes(requestedHorizon) ? requestedHorizon : 30;
  const threshold = finite(input.threshold) ? Math.abs(Number(input.threshold)) / 100 : 0.02;
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights || {}) };
  const checked = validateBars(input.bars);
  const bars = checked.bars;
  const currentStart = bars.length - lookback;
  const cleanEnough = checked.quality.clean;

  const base = {
    available: false,
    status: 'INSUFFICIENT_HISTORICAL_DATA',
    ticker: input.ticker || null,
    lookback,
    horizon,
    thresholdPct: threshold * 100,
    dataQuality: checked.quality,
    matches: [],
    matchCount: 0,
    probabilities: null,
    robustness: 1,
    paths: null,
    explanation: 'Historical evidence is unavailable because the clean history or forward outcome window is insufficient.',
  };
  if (!cleanEnough || bars.length < lookback + horizon + MIN_MATCHES) return base;

  const currentCloses = bars.slice(currentStart).map(bar => bar.c);
  const currentPath = normalize(currentCloses);
  // Similarity uses the start-normalized path above. The chart instead must
  // join at the forecast boundary, where every forward analog begins at 100.
  const currentDisplayPath = currentCloses.map(close => close / currentCloses.at(-1) * 100);
  const currentReturns = returns(currentCloses);
  const currentDrawdown = drawdown(currentCloses).at(-1);
  const currentVolatility = volatility(currentCloses);
  const currentMomentum = currentCloses.at(-1) / currentCloses[Math.max(0, currentCloses.length - 11)] - 1;
  if (!currentPath) return base;

  const rawMatches = [];
  for (let end = lookback - 1; end < currentStart; end++) {
    // Purge candidates whose labelled future overlaps the live reference
    // pattern. Otherwise the current window would leak into a historical
    // outcome, inflating apparent confidence.
    if (end + horizon >= currentStart) continue;
    const window = bars.slice(end - lookback + 1, end + 1);
    const closes = window.map(bar => bar.c);
    const normalized = normalize(closes);
    if (!normalized) continue;
    const candidateReturns = returns(closes);
    const candidateDrawdown = drawdown(closes).at(-1);
    const candidateVolatility = volatility(closes);
    const candidateMomentum = closes.at(-1) / closes[Math.max(0, closes.length - 11)] - 1;
    const priceSimilarity = (correlation(currentPath, normalized) + 1) / 2;
    const returnSimilarity = (correlation(currentReturns, candidateReturns) + 1) / 2;
    const volatilitySimilarity = similarity(currentVolatility, candidateVolatility);
    const momentumSimilarity = similarity(currentMomentum, candidateMomentum);
    const drawdownSimilarity = similarity(currentDrawdown, candidateDrawdown);
    const similarityScore = clamp(
      weights.pricePath * priceSimilarity
      + weights.returns * returnSimilarity
      + weights.volatility * volatilitySimilarity
      + weights.momentum * momentumSimilarity
      + weights.drawdown * drawdownSimilarity
    );
    const anchor = bars[end].c;
    const forward = bars.slice(end, end + horizon + 1);
    const forwardReturn = forward.at(-1).c / anchor - 1;
    const futureOnly = forward.slice(1);
    const maxRise = futureOnly.length ? Math.max(...futureOnly.map(bar => bar.h / anchor - 1)) : forwardReturn;
    const maxDrawdown = futureOnly.length ? Math.min(...futureOnly.map(bar => bar.l / anchor - 1)) : forwardReturn;
    const outcome = forwardReturn > threshold ? 'BULLISH' : forwardReturn < -threshold ? 'BEARISH' : 'NEUTRAL';
    rawMatches.push({
      date: bars[end].t,
      endIndex: end,
      similarity: similarityScore,
      outcome,
      forwardReturn,
      maxRise,
      maxDrawdown,
      forwardPath: forward.map(bar => bar.c / anchor * 100),
      priceSimilarity,
      returnSimilarity,
      volatilitySimilarity,
      momentumSimilarity,
      drawdownSimilarity,
    });
  }

  // Keep one representative from each independent input + outcome span. This
  // embargo prevents a prolonged regime from masquerading as many observations.
  const selected = [];
  for (const candidate of rawMatches.sort((a, b) => b.similarity - a.similarity)) {
    if (selected.every(previous => Math.abs(previous.endIndex - candidate.endIndex) >= lookback + horizon)) {
      selected.push(candidate);
    }
    if (selected.length >= 100) break;
  }
  const matches = selected.sort((a, b) => a.endIndex - b.endIndex);
  if (!matches.length) return base;

  const weighted = matches.map(match => Math.max(0.0001, match.similarity ** 3));
  const totalWeight = weighted.reduce((sum, value) => sum + value, 0);
  const weightedProbability = outcome => matches.reduce((sum, match, index) =>
    sum + (match.outcome === outcome ? weighted[index] : 0), 0) / totalWeight;
  const probabilities = {
    bull: weightedProbability('BULLISH'),
    bear: weightedProbability('BEARISH'),
    neutral: weightedProbability('NEUTRAL'),
  };
  const closest = [...matches].sort((a, b) => b.similarity - a.similarity)[0];
  const bullish = matches.filter(match => match.outcome === 'BULLISH');
  const bearish = matches.filter(match => match.outcome === 'BEARISH');
  const effectiveSampleSize = totalWeight ** 2 / weighted.reduce((sum, value) => sum + value ** 2, 0);
  const expectedReturn = matches.reduce((sum, match, index) => sum + match.forwardReturn * weighted[index], 0) / totalWeight;
  const robustness = robustnessFor(matches, probabilities, closest);
  const status = matches.length < MIN_MATCHES ? 'LIMITED_HISTORICAL_SAMPLE' : 'OK';
  const displayable = matches.length >= MIN_MATCHES;
  const direction = probabilities.bull > probabilities.bear && probabilities.bull > probabilities.neutral
    ? 'BULLISH' : probabilities.bear > probabilities.bull && probabilities.bear > probabilities.neutral ? 'BEARISH' : 'NEUTRAL';

  return {
    available: true,
    displayable,
    status,
    ticker: input.ticker || null,
    lookback,
    horizon,
    thresholdPct: threshold * 100,
    dataQuality: checked.quality,
    matchCount: matches.length,
    matches: matches.map(({ endIndex, forwardPath, ...match }) => match),
    probabilities: displayable ? probabilities : null,
    rawProbabilities: probabilities,
    direction: displayable ? direction : 'UNCONFIRMED',
    robustness,
    effectiveSampleSize,
    closest: {
      date: closest.date,
      similarity: closest.similarity,
      outcome: closest.outcome,
      forwardReturn: closest.forwardReturn,
      maxRise: closest.maxRise,
      maxDrawdown: closest.maxDrawdown,
      path: closest.forwardPath,
    },
    expectedReturn: displayable ? expectedReturn : null,
    returnRange: displayable ? {
      p10: weightedQuantile(matches.map(match => match.forwardReturn), weighted, 0.10),
      p50: weightedQuantile(matches.map(match => match.forwardReturn), weighted, 0.50),
      p90: weightedQuantile(matches.map(match => match.forwardReturn), weighted, 0.90),
    } : null,
    probabilityIntervals: displayable ? {
      bull: wilsonInterval(probabilities.bull * effectiveSampleSize, effectiveSampleSize),
      bear: wilsonInterval(probabilities.bear * effectiveSampleSize, effectiveSampleSize),
      neutral: wilsonInterval(probabilities.neutral * effectiveSampleSize, effectiveSampleSize),
    } : null,
    paths: {
      current: currentDisplayPath,
      closest: closest.forwardPath,
      bullish: pathStats(bullish, 'forwardPath', horizon),
      bearish: pathStats(bearish, 'forwardPath', horizon),
    },
    explanation: displayable
      ? `${matches.length} separated historical windows matched the current ${lookback}-session normalized price structure. Outcomes are weighted by similarity and measured ${horizon} sessions forward; this is historical conditional evidence, not a guarantee.`
      : `Only ${matches.length} separated historical window${matches.length === 1 ? '' : 's'} matched. The sample is too small to display a reliable probability.`,
  };
}

module.exports = {
  LOOKBACKS,
  HORIZONS,
  DEFAULT_WEIGHTS,
  validateBars,
  buildHistoricalForecast,
};