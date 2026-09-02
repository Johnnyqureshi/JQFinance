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
const WALK_FORWARD_MIN_SAMPLE = 10;
const WALK_FORWARD_CALIBRATION_TOLERANCE = 0.20;
const WALK_FORWARD_BRIER_TOLERANCE = 0.45;
const WALK_FORWARD_CONTRACT_VERSION = 'HISTORICAL_FORECAST_WALK_FORWARD_V1';
const OUTCOMES = Object.freeze([
  { label: 'BULLISH', key: 'bull' },
  { label: 'BEARISH', key: 'bear' },
  { label: 'NEUTRAL', key: 'neutral' },
]);

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

function outcomeForReturn(forwardReturn, threshold) {
  return forwardReturn > threshold ? 'BULLISH'
    : forwardReturn < -threshold ? 'BEARISH'
      : 'NEUTRAL';
}

function numericRange(values) {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return null;
  return {
    min: Math.min(...finiteValues),
    max: Math.max(...finiteValues),
    mean: mean(finiteValues),
  };
}

function probabilityRange(values) {
  const range = numericRange(values);
  return range ? {
    ...range,
    lower: range.min,
    upper: range.max,
  } : null;
}

function validSelection(values, allowed, fallback) {
  if (values == null) return [...allowed];
  const selected = (Array.isArray(values) ? values : [values])
    .map(Number)
    .filter(value => allowed.includes(value));
  return [...new Set(selected)].sort((a, b) => a - b).length ? [...new Set(selected)].sort((a, b) => a - b) : [fallback];
}

function calibrationBands(calls, outcome) {
  const bands = Array.from({ length: 5 }, (_, index) => ({
    min: index / 5,
    max: (index + 1) / 5,
    calls: 0,
    predictedProbability: null,
    realizedRate: null,
  }));
  const probabilityKey = OUTCOMES.find(item => item.label === outcome)?.key;
  for (const call of calls) {
    const probability = call.probabilities?.[probabilityKey];
    if (!Number.isFinite(probability)) continue;
    const index = Math.min(4, Math.floor(probability * 5));
    const band = bands[index];
    band.calls++;
    band._probabilities ??= [];
    band._realized ??= [];
    band._probabilities.push(probability);
    band._realized.push(call.realizedOutcome === outcome ? 1 : 0);
  }
  return bands.map(band => {
    const { _probabilities: predicted, _realized: realized, ...publicBand } = band;
    return {
      ...publicBand,
      predictedProbability: predicted?.length ? mean(predicted) : null,
      realizedRate: realized?.length ? mean(realized) : null,
    };
  });
}

function summarizeWalkForwardGroup(calls, lookback, horizon, minSample) {
  const displayable = calls.filter(call => call.evaluable);
  const evaluated = [];
  for (const call of displayable) {
    const previous = evaluated.at(-1);
    // Calibration labels must not share future-return sessions. Closely spaced
    // calls remain in the audit trail, but they do not inflate sample adequacy
    // or receive additional weight in reliability statistics.
    if (!previous || call.asOfIndex - previous.asOfIndex >= horizon) evaluated.push(call);
  }
  const probabilities = Object.fromEntries(OUTCOMES.map(({ label, key }) => [
    key,
    probabilityRange(evaluated.map(call => call.probabilities?.[key])),
  ]));
  const realizedCounts = Object.fromEntries(OUTCOMES.map(({ label, key }) => [
    key,
    evaluated.filter(call => call.realizedOutcome === label).length,
  ]));
  const realizedRates = Object.fromEntries(OUTCOMES.map(({ key }) => [
    key,
    evaluated.length ? realizedCounts[key] / evaluated.length : null,
  ]));
  const meanPredicted = Object.fromEntries(OUTCOMES.map(({ key }) => [
    key,
    evaluated.length
      ? mean(evaluated.map(call => call.probabilities?.[key]).filter(Number.isFinite))
      : null,
  ]));
  const calibrationError = Object.fromEntries(OUTCOMES.map(({ key }) => {
    return [key, meanPredicted[key] == null || realizedRates[key] == null
      ? null
      : Math.abs(meanPredicted[key] - realizedRates[key])];
  }));
  const brierScore = evaluated.length
    ? mean(evaluated.map(call => OUTCOMES.reduce((sum, { label, key }) => {
      const expected = call.realizedOutcome === label ? 1 : 0;
      return sum + (call.probabilities[key] - expected) ** 2;
    }, 0)))
    : null;
  const maxCalibrationError = Math.max(
    ...Object.values(calibrationError).filter(Number.isFinite),
    0,
  );
  const warnings = [];
  if (evaluated.length < minSample) {
    warnings.push({
      code: 'TOO_SMALL_SAMPLE',
      required: minSample,
      actual: evaluated.length,
      message: `Only ${evaluated.length} point-in-time forecast${evaluated.length === 1 ? '' : 's'} had displayable probabilities; at least ${minSample} are required.`,
    });
  } else if (maxCalibrationError > WALK_FORWARD_CALIBRATION_TOLERANCE
    || brierScore > WALK_FORWARD_BRIER_TOLERANCE) {
    warnings.push({
      code: 'POOR_CALIBRATION',
      tolerance: WALK_FORWARD_CALIBRATION_TOLERANCE,
      brierTolerance: WALK_FORWARD_BRIER_TOLERANCE,
      maxCalibrationError,
      brierScore,
      message: 'Predicted probabilities differ materially from realized outcome rates on the unseen period.',
    });
  }
  return {
    lookback,
    horizon,
    calls: calls.length,
    displayableCalls: displayable.length,
    evaluatedCalls: evaluated.length,
    independentEvaluatedCalls: evaluated.length,
    overlappingCallsExcluded: displayable.length - evaluated.length,
    withheldCalls: calls.length - displayable.length,
    predictedProbabilityRanges: probabilities,
    realizedOutcomeCounts: realizedCounts,
    realizedOutcomeRates: realizedRates,
    meanPredictedProbabilities: meanPredicted,
    calibrationError,
    maxCalibrationError,
    brierScore,
    reliability: Object.fromEntries(OUTCOMES.map(({ label, key }) => [
      key,
      calibrationBands(evaluated, label),
    ])),
    status: warnings.some(warning => warning.code === 'TOO_SMALL_SAMPLE')
      ? 'INSUFFICIENT_SAMPLE'
      : warnings.length ? 'POOR_CALIBRATION' : 'OK',
    warnings,
  };
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

/**
 * Validate the historical forecast against later bars without allowing those
 * later bars into the forecast call itself.
 *
 * Each call is built from bars.slice(0, asOfIndex + 1). The bar at
 * asOfIndex+horizon is used only after the call has been made to label the
 * realized outcome. This makes the report a point-in-time replay rather than
 * an in-sample score of the current forecast.
 *
 * @param {object} input
 * @param {object[]} input.bars
 * @param {string} [input.ticker]
 * @param {number[]} [input.lookbacks]
 * @param {number[]} [input.horizons]
 * @param {number} [input.step=5] Number of sessions between forecast calls.
 * @param {number} [input.thresholdPct=2] Outcome threshold in percent.
 * @param {number} [input.minSample=10] Minimum displayable calls per group.
 * @returns {object} Deterministic, read-only validation report.
 */
function buildWalkForwardValidationReport(input = {}) {
  const checked = validateBars(input.bars);
  const bars = checked.bars;
  const lookbacks = validSelection(input.lookbacks, LOOKBACKS, 90);
  const horizons = validSelection(input.horizons, HORIZONS, 30);
  const requestedStep = Number(input.step);
  const step = Number.isInteger(requestedStep) && requestedStep > 0 ? requestedStep : 5;
  const requestedMinSample = Number(input.minSample);
  const minSample = Number.isInteger(requestedMinSample) && requestedMinSample > 0
    ? requestedMinSample : WALK_FORWARD_MIN_SAMPLE;
  const requestedThreshold = input.thresholdPct ?? input.threshold;
  const thresholdPct = finite(requestedThreshold) ? Math.abs(Number(requestedThreshold)) : 2;
  const threshold = thresholdPct / 100;
  const startIndex = Number.isInteger(Number(input.startIndex)) && Number(input.startIndex) >= 0
    ? Number(input.startIndex) : 0;
  const maxHorizon = Math.max(...horizons);
  const requestedEnd = Number(input.endIndex);
  const endIndex = Number.isInteger(requestedEnd)
    ? Math.min(requestedEnd, bars.length - maxHorizon - 1)
    : bars.length - maxHorizon - 1;
  const base = {
    contractVersion: WALK_FORWARD_CONTRACT_VERSION,
    available: false,
    status: 'INSUFFICIENT_HISTORICAL_DATA',
    mode: 'READ_ONLY',
    liveExecutionAllowed: false,
    automationChanged: false,
    pointInTime: true,
    ticker: input.ticker || null,
    lookbacks,
    horizons,
    step,
    thresholdPct,
    minSample,
    dataQuality: checked.quality,
    calls: [],
    groups: [],
    flags: [],
    summary: {
      totalCalls: 0,
      evaluatedCalls: 0,
      groups: 0,
      flaggedGroups: 0,
    },
    explanation: 'No point-in-time forecast calls had enough clean history and later outcome data to validate.',
  };
  if (!checked.quality.clean || endIndex < startIndex) return base;

  const groups = [];
  const calls = [];
  for (const lookback of lookbacks) {
    for (const horizon of horizons) {
      // buildHistoricalForecast requires this much prefix data before it can
      // produce ten separated, labelled analogs.
      const firstEligibleIndex = lookback + horizon + MIN_MATCHES;
      const firstIndex = Math.max(startIndex, firstEligibleIndex);
      const lastIndex = Math.min(endIndex, bars.length - horizon - 1);
      const groupCalls = [];
      for (let asOfIndex = firstIndex; asOfIndex <= lastIndex; asOfIndex += step) {
        const forecast = buildHistoricalForecast({
          ...input,
          bars: bars.slice(0, asOfIndex + 1),
          lookback,
          horizon,
          threshold: thresholdPct,
        });
        const anchor = bars[asOfIndex]?.c;
        const outcomeBar = bars[asOfIndex + horizon];
        if (!Number.isFinite(anchor) || !Number.isFinite(outcomeBar?.c)) continue;
        const realizedReturn = outcomeBar.c / anchor - 1;
        const realizedOutcome = outcomeForReturn(realizedReturn, threshold);
        const evaluable = !!forecast.probabilities
          && ['bull', 'bear', 'neutral'].every(key => Number.isFinite(forecast.probabilities[key]));
        const call = {
          lookback,
          horizon,
          asOfIndex,
          asOf: bars[asOfIndex].t,
          outcomeDate: outcomeBar.t,
          forecastStatus: forecast.status,
          forecastAvailable: forecast.available,
          forecastDisplayable: forecast.displayable === true,
          evaluable,
          // These fields are deliberately explicit for audit consumers.
          forecastUsedBarsThrough: bars[asOfIndex].t,
          futureDataUsedByForecast: false,
          realizedOutcome,
          realizedReturn,
          predictedDirection: forecast.direction || 'UNCONFIRMED',
          probabilities: evaluable ? { ...forecast.probabilities } : null,
          probabilityIntervals: evaluable && forecast.probabilityIntervals
            ? JSON.parse(JSON.stringify(forecast.probabilityIntervals)) : null,
        };
        groupCalls.push(call);
        calls.push(call);
      }
      groups.push(summarizeWalkForwardGroup(groupCalls, lookback, horizon, minSample));
    }
  }

  const flags = groups.flatMap(group => group.warnings.map(warning => ({
    ...warning,
    lookback: group.lookback,
    horizon: group.horizon,
  })));
  const evaluatedCalls = calls.filter(call => call.evaluable).length;
  const independentEvaluatedCalls = groups.reduce((sum, group) =>
    sum + group.independentEvaluatedCalls, 0);
  const poorCalibration = flags.some(flag => flag.code === 'POOR_CALIBRATION');
  const insufficientSample = flags.some(flag => flag.code === 'TOO_SMALL_SAMPLE');
  const status = poorCalibration ? 'POOR_CALIBRATION'
    : insufficientSample ? 'INSUFFICIENT_SAMPLE' : 'OK';
  return {
    ...base,
    available: calls.length > 0,
    status: calls.length ? status : base.status,
    calls,
    groups,
    flags,
    summary: {
      totalCalls: calls.length,
      displayableCalls: evaluatedCalls,
      evaluatedCalls: independentEvaluatedCalls,
      independentEvaluatedCalls,
      overlappingCallsExcluded: evaluatedCalls - independentEvaluatedCalls,
      withheldCalls: calls.length - evaluatedCalls,
      groups: groups.length,
      flaggedGroups: groups.filter(group => group.warnings.length > 0).length,
      poorCalibrationGroups: groups.filter(group => group.status === 'POOR_CALIBRATION').length,
      insufficientSampleGroups: groups.filter(group => group.status === 'INSUFFICIENT_SAMPLE').length,
    },
    explanation: poorCalibration
      ? 'At least one lookback/horizon group is materially miscalibrated on later unseen outcomes. This report is diagnostic only and cannot change trading automation.'
      : insufficientSample
        ? 'At least one lookback/horizon group has too few displayable point-in-time forecasts for a reliable calibration judgment.'
        : 'Displayable point-in-time probabilities were compared with outcomes that occurred later. This report is diagnostic only and cannot change trading automation.',
  };
}

module.exports = {
  LOOKBACKS,
  HORIZONS,
  DEFAULT_WEIGHTS,
  MIN_MATCHES,
  WALK_FORWARD_MIN_SAMPLE,
  WALK_FORWARD_CALIBRATION_TOLERANCE,
  WALK_FORWARD_BRIER_TOLERANCE,
  WALK_FORWARD_CONTRACT_VERSION,
  validateBars,
  buildHistoricalForecast,
  buildWalkForwardValidationReport,
  // Keep the shorter names convenient for scripts that call this as a test
  // runner rather than as a report builder.
  runWalkForwardValidation: buildWalkForwardValidationReport,
  buildWalkForwardReport: buildWalkForwardValidationReport,
};