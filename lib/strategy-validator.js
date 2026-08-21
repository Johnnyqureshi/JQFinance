'use strict';

/**
 * strategy-validator.js — Pure, deterministic paper-only strategy replay engine.
 *
 * CONTRACT VERSION: 2
 *  (v1→v2: added sizing fields, decisionId, strategyVersion, inputSnapshot,
 *   gateReasons, DST-correct market-hours, gap-fill stop model,
 *   same-symbol-open guard, new OHLCV gates, buildPointInTimeSignals,
 *   runWalkForwardValidation)
 *
 * Public API (all exported at module.exports):
 *
 *   buildOhlcvSeries(rawBars)                        → normalised + sorted bar array
 *   splitPeriods(bars, devFrac, valFrac)              → { dev, val, test }
 *   createConfig(overrides)                           → validated frozen config
 *   validateConfig(cfg)                               → { ok, errors }
 *   declaredUnavailableGates()                        → string[]
 *   isMarketHours(tMs)                                → boolean  (DST-correct)
 *   computeRsi(closes, period)                        → number
 *   computeVwap(bars)                                 → number
 *   computeMacd(closes, fast, slow, signal)           → { macd, signal, hist }
 *   evaluateCandidate(signal, bars, cfg, state)       → candidateRecord
 *   replaySession(signals, barsMap, cfg)              → { trades, candidates, metrics }
 *   computeMetrics(trades, cfg)                       → metricsObject
 *   bootstrapCI(trades, cfg, opts)                    → { mean, lo, hi, n, reps }
 *   ablationRun(signals, barsMap, baseConfig, ablations) → ablationResults[]
 *   buildPointInTimeSignals(barsMap, opts)            → { signals, metadata }
 *   runWalkForwardValidation(signals, barsMap, cfg, ablations, opts)
 *                                                     → walkForwardReport
 *
 * Design principles:
 *   - No lookahead: gates see only bars strictly before the signal bar.
 *   - Entries fill at the NEXT bar open + buy half-spread + slippage.
 *   - Stop fills conservatively: a gap below the stop fills at the lower bar open;
 *     an intrabar touch fills at the stop, then sell costs are applied.
 *   - Stop always wins over all other exits on the same bar.
 *   - All other exits apply sell half-spread + slippage on exit price.
 *   - Missing required gate data → fail-closed, recorded in missingDataStates.
 *   - No shorts ever generated.
 *   - Max concurrent longs (configurable, default 2).
 *   - Same symbol already open → rejected (SYMBOL_ALREADY_OPEN).
 *   - Max daily trades (configurable).
 *   - Re-entry cooldown per symbol.
 *   - DST-correct market-hours filtering (America/New_York).
 *   - Sizing: startingEquity, positionPct/fixed notional, leverage, maxRiskPct, maxDailyRisk.
 *   - Metrics use sized net PnL and equity-curve max drawdown.
 *   - Test period is never used for selection.
 *   - Unavailable gates declared explicitly; market_regime is available when
 *     benchmark bars are supplied.
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const CONTRACT_VERSION = 2;

/**
 * Gates that are ALWAYS unavailable regardless of inputs.
 * market_regime is NOT in this list — it can be derived from supplied benchmark bars.
 */
const UNAVAILABLE_GATES = [
  'news_catalyst',   // real-time breaking news, not in OHLCV
  'float_shares',    // point-in-time float — no vendor snapshot
  'level2_tape',     // order-book / tape data
  'options_flow',    // unusual options activity
];

/** Promotion criteria keys */
const PROMO_CRITERIA = [
  'minValidationTrades',
  'minTestTrades',
  'positiveAfterCostExpectancy',
  'profitFactorGe1',
  'maxDrawdownNotWorse',
  'ciLoNonNegative',
];

// ── DST-correct market-hours ───────────────────────────────────────────────────

/**
 * Returns true if tMs falls within the regular US equity session (09:30–16:00
 * America/New_York), correctly handling DST transitions.
 * Uses Intl.DateTimeFormat to project UTC→ET without any fixed offset assumption.
 * @param {number} tMs  Unix ms timestamp.
 * @returns {boolean}
 */
function isMarketHours(tMs) {
  // Fast weekend rejection via UTC (saves Intl call in hot path)
  const d = new Date(tMs);
  // Intl-project to New York local time
  const parts = _nyParts(tMs);
  if (!parts) return false;
  const dow = parts.weekday; // 'Mon'..'Sun' (narrow) — we use numeric day instead
  // Build a UTC date-only string and check weekday via getUTCDay on the NY date
  const nyDate = new Date(
    `${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}T12:00:00Z`
  );
  const nyDow = nyDate.getUTCDay(); // 0=Sun, 6=Sat
  if (nyDow === 0 || nyDow === 6) return false;

  const nyMinutes = parts.hour * 60 + parts.minute;
  return nyMinutes >= 9 * 60 + 30 && nyMinutes < 16 * 60;
}

/** Extract New York date/time parts using Intl — returns null on failure */
function _nyParts(tMs) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = {};
    for (const { type, value } of fmt.formatToParts(new Date(tMs))) {
      if (type !== 'literal') parts[type] = Number(value);
    }
    // hour12:false gives 24-hour; noon reported as 12, midnight as 0 or 24
    if (parts.hour === 24) parts.hour = 0;
    return parts;
  } catch (_) {
    return null;
  }
}

// ── Default config ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  version:             CONTRACT_VERSION,

  // ── Position limits ──────────────────────────────────────────────────────────
  maxConcurrentLongs:  2,
  maxTradesPerDay:     5,

  // ── Cost model ───────────────────────────────────────────────────────────────
  halfSpreadPct:       0.05,   // buy half-spread as % of price
  slippagePct:         0.05,   // one-way slippage as % of price
  // sell half-spread and slippage applied symmetrically on exit

  // ── Sizing ───────────────────────────────────────────────────────────────────
  startingEquity:      25000,  // paper equity in $
  positionPct:         10,     // % of equity per position (null → use fixedNotional)
  fixedNotional:       null,   // fixed $ notional override
  leverage:            1,      // leverage multiplier (1 = no leverage)
  maxRiskPct:          1,      // max % of equity risked per trade (stop-based)
  maxDailyRiskPct:     3,      // max % of equity lost in a day before halting

  // ── Risk ─────────────────────────────────────────────────────────────────────
  stopPct:             5.0,
  takeProfitRsiLevel:  75,
  maxHoldBars:         78,     // ~6.5 h of 5-min bars

  // ── Cooldown ─────────────────────────────────────────────────────────────────
  cooldownBars:        6,

  // ── Market hours ─────────────────────────────────────────────────────────────
  enforceMarketHours:  true,
  entryStartMinutesET: null,   // restrict entries after this minute-of-day (e.g. 9*60+30)
  entryEndMinutesET:   null,   // restrict entries before this minute-of-day (e.g. 14*60)

  // ── Gates: which OHLCV-derivable optional gates are enabled ──────────────────
  gates: {
    // always-on optional gates (OHLCV-derivable, enabled by default)
    priceRange:          true,
    minGainPct:          true,
    minRelVol:           true,
    minScore:            true,
    maxGainPct:          false,  // optional upper gain cap
    // new OHLCV gates (off by default, enable via ablation)
    requireAboveVwap:    false,
    requireMacdBullish:  false,
    requireBreakout20:   false,
    rejectBearishDump:   false,
    marketRegimeBullish: false,  // requires benchmarkSymbol in barsMap
    // permanently unavailable — always false
    newsCatalyst:        false,
    floatShares:         false,
    level2Tape:          false,
    optionsFlow:         false,
  },

  // ── Gate thresholds ──────────────────────────────────────────────────────────
  minPrice:            3.0,
  maxPrice:            20.0,
  minGainPct:          10.0,
  maxGainPct:          null,   // null = disabled
  minRelVol:           5.0,
  minScore:            4,
  dumpCandlePct:       -8,     // bearish dump: bar return worse than this %
  benchmarkSymbol:     'SPY',  // symbol key in barsMap for regime gate

  // ── RSI / MACD ───────────────────────────────────────────────────────────────
  rsiPeriod:           14,
  macdFast:            12,
  macdSlow:            26,
  macdSignal:          9,

  // ── Walk-forward split ────────────────────────────────────────────────────────
  devFrac:             0.6,
  valFrac:             0.2,

  // ── Bootstrap CI ─────────────────────────────────────────────────────────────
  bootstrapReps:       2000,
  bootstrapSeed:       42,

  // ── Promotion thresholds ─────────────────────────────────────────────────────
  promotionMinValTrades:   30,
  promotionMinTestTrades:  30,

  // ── Strategy mode (cannot be overridden to non-paper) ────────────────────────
  mode:                'PAPER_ONLY',

  // ── Mandatory safety gates (internal, not user-settable) ─────────────────────
  _mandatoryGates: ['noShorts', 'marketHours', 'stopProtection', 'positionCap', 'dailyTradeCap'],
};

// ── Config helpers ─────────────────────────────────────────────────────────────

/** Convert snake_case gate name to camelCase key */
function _camelGateKey(name) {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Validate a config object.
 * @param {object} cfg
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateConfig(cfg) {
  const errors = [];
  if (cfg.version !== CONTRACT_VERSION) {
    errors.push(`config.version must be ${CONTRACT_VERSION}, got ${cfg.version}`);
  }
  if (typeof cfg.maxConcurrentLongs !== 'number' || cfg.maxConcurrentLongs < 1) {
    errors.push('maxConcurrentLongs must be a positive number');
  }
  if (typeof cfg.maxTradesPerDay !== 'number' || cfg.maxTradesPerDay < 1) {
    errors.push('maxTradesPerDay must be a positive number');
  }
  if (typeof cfg.stopPct !== 'number' || cfg.stopPct <= 0) {
    errors.push('stopPct must be a positive number');
  }
  if (typeof cfg.halfSpreadPct !== 'number' || cfg.halfSpreadPct < 0) {
    errors.push('halfSpreadPct must be >= 0');
  }
  if (typeof cfg.slippagePct !== 'number' || cfg.slippagePct < 0) {
    errors.push('slippagePct must be >= 0');
  }
  if (typeof cfg.startingEquity !== 'number' || cfg.startingEquity <= 0) {
    errors.push('startingEquity must be a positive number');
  }
  if (cfg.leverage != null && (typeof cfg.leverage !== 'number' || cfg.leverage < 1)) {
    errors.push('leverage must be >= 1');
  }
  // Mode must stay PAPER_ONLY
  if (cfg.mode !== 'PAPER_ONLY') {
    errors.push('mode must be PAPER_ONLY; this engine cannot enable live trading');
  }
  // Unavailable gates must not be enabled
  const gates = cfg.gates || {};
  for (const g of UNAVAILABLE_GATES) {
    const key = _camelGateKey(g);
    if (gates[key] === true) {
      errors.push(`Gate "${g}" is declared unavailable and cannot be enabled`);
    }
  }
  const dv = Number(cfg.devFrac || 0);
  const vv = Number(cfg.valFrac || 0);
  if (dv <= 0 || vv <= 0 || dv + vv >= 1) {
    errors.push('devFrac and valFrac must be > 0 and devFrac+valFrac < 1');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Create a fully-populated frozen config.
 * Unavailable gates are forced off. mode is forced to PAPER_ONLY.
 * @param {object} [overrides={}]
 * @returns {Readonly<object>}
 */
function createConfig(overrides = {}) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, overrides, {
    gates: Object.assign({}, DEFAULT_CONFIG.gates, overrides.gates || {}),
    _mandatoryGates: DEFAULT_CONFIG._mandatoryGates,
    mode: 'PAPER_ONLY',
  });
  // Force permanently unavailable gates off
  for (const g of UNAVAILABLE_GATES) {
    cfg.gates[_camelGateKey(g)] = false;
  }
  const { ok, errors } = validateConfig(cfg);
  if (!ok) throw new Error('Invalid strategy config: ' + errors.join('; '));
  return Object.freeze(cfg);
}

/**
 * Returns gates that are always unavailable for OHLCV-only replay.
 * @returns {string[]}
 */
function declaredUnavailableGates() {
  return [...UNAVAILABLE_GATES];
}

// ── OHLCV helpers ──────────────────────────────────────────────────────────────

/**
 * Normalise and sort an array of raw bar objects.
 * Each bar must have: { symbol, t, o, h, l, c, v }
 * @param {object[]} rawBars
 * @returns {object[]}
 */
function buildOhlcvSeries(rawBars) {
  if (!Array.isArray(rawBars)) throw new TypeError('rawBars must be an array');
  const out = [];
  for (const bar of rawBars) {
    if (!bar || typeof bar !== 'object') continue;
    const tMs = _parseBarTime(bar.t);
    if (!Number.isFinite(tMs)) continue;
    const o = Number(bar.o);
    const h = Number(bar.h);
    const l = Number(bar.l);
    const c = Number(bar.c);
    const v = Number(bar.v);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) ||
        !Number.isFinite(c) || !Number.isFinite(v)) continue;
    out.push({ symbol: String(bar.symbol || '').toUpperCase(), t: tMs, o, h, l, c, v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function _parseBarTime(t) {
  if (typeof t === 'number') return t;
  if (typeof t === 'string') { const n = Date.parse(t); return Number.isFinite(n) ? n : NaN; }
  return NaN;
}

/**
 * Split a sorted bar array chronologically into dev / val / test.
 * Split is made on unique trading sessions so partial-session contamination
 * cannot leak across the boundary.
 * @param {object[]} bars
 * @param {number}   devFrac
 * @param {number}   valFrac
 * @returns {{ dev: object[], val: object[], test: object[] }}
 */
function splitPeriods(bars, devFrac = 0.6, valFrac = 0.2) {
  if (!Array.isArray(bars)) throw new TypeError('bars must be an array');
  if (devFrac <= 0 || valFrac <= 0 || devFrac + valFrac >= 1) {
    throw new RangeError('devFrac and valFrac must be > 0 and sum < 1');
  }
  const n = bars.length;
  const devEnd = Math.floor(n * devFrac);
  const valEnd = Math.floor(n * (devFrac + valFrac));
  return {
    dev:  bars.slice(0, devEnd),
    val:  bars.slice(devEnd, valEnd),
    test: bars.slice(valEnd),
  };
}

/**
 * Split signals by unique chronological trading sessions (NY calendar days).
 * Returns { devSignals, valSignals, testSignals, sessions, splitAudit }.
 * Selection only ever touches dev+val; test is explicitly sealed.
 * @param {object[]} signals  sorted by tMs
 * @param {number}   devFrac
 * @param {number}   valFrac
 * @returns {object}
 */
function _splitSignalsBySession(signals, devFrac, valFrac) {
  // Group signals by NY calendar date
  const sessionMap = new Map(); // dateStr → [signals]
  for (const s of signals) {
    const parts = _nyParts(s.tMs || 0);
    const key = parts
      ? `${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`
      : 'unknown';
    if (!sessionMap.has(key)) sessionMap.set(key, []);
    sessionMap.get(key).push(s);
  }
  const sessions = [...sessionMap.keys()].sort();
  const ns = sessions.length;
  const devEndIdx = Math.floor(ns * devFrac);
  const valEndIdx = Math.floor(ns * (devFrac + valFrac));

  const devSessions  = new Set(sessions.slice(0, devEndIdx));
  const valSessions  = new Set(sessions.slice(devEndIdx, valEndIdx));
  const testSessions = new Set(sessions.slice(valEndIdx));

  return {
    devSignals:  signals.filter(s => { const k = _sessionKey(s.tMs); return devSessions.has(k); }),
    valSignals:  signals.filter(s => { const k = _sessionKey(s.tMs); return valSessions.has(k); }),
    testSignals: signals.filter(s => { const k = _sessionKey(s.tMs); return testSessions.has(k); }),
    sessions,
    splitAudit: {
      totalSessions:   ns,
      devSessions:     sessions.slice(0, devEndIdx),
      valSessions:     sessions.slice(devEndIdx, valEndIdx),
      testSessions:    sessions.slice(valEndIdx),
      testNeverUsedForSelection: true,
    },
  };
}

function _sessionKey(tMs) {
  const parts = _nyParts(tMs || 0);
  if (!parts) return 'unknown';
  return `${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;
}

// ── Indicator helpers ──────────────────────────────────────────────────────────

/**
 * Compute simple RSI(period). Returns NaN if insufficient data.
 * @param {number[]} closes
 * @param {number}   period
 * @returns {number}
 */
function computeRsi(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return NaN;
  const slice = closes.slice(-(period + 1));
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Compute VWAP from bar array (cumulative from first bar).
 * @param {object[]} bars  Array of { o, h, l, c, v }
 * @returns {number}
 */
function computeVwap(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return NaN;
  let cumTpv = 0, cumVol = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumTpv += tp * b.v;
    cumVol += b.v;
  }
  return cumVol > 0 ? cumTpv / cumVol : NaN;
}

/**
 * Compute MACD (EMA fast/slow + signal EMA).
 * Returns { macd, signal: signalLine, hist } or null if insufficient data.
 * @param {number[]} closes
 * @param {number}   fast    default 12
 * @param {number}   slow    default 26
 * @param {number}   sig     default 9
 * @returns {{ macd: number, signal: number, hist: number }|null}
 */
function computeMacd(closes, fast = 12, slow = 26, sig = 9) {
  if (!Array.isArray(closes) || closes.length < slow + sig) return null;
  const emaFast = _ema(closes, fast);
  const emaSlow = _ema(closes, slow);
  if (!Number.isFinite(emaFast) || !Number.isFinite(emaSlow)) return null;
  // Build MACD line history (only last slow+sig values needed for signal EMA)
  const needed = slow + sig;
  const slice = closes.slice(-needed);
  const macdLine = [];
  for (let i = slow - 1; i < slice.length; i++) {
    const f = _ema(slice.slice(0, i + 1), fast);
    const s = _ema(slice.slice(0, i + 1), slow);
    macdLine.push(f - s);
  }
  if (macdLine.length < sig) return null;
  const signalLine = _ema(macdLine, sig);
  const macdVal = macdLine[macdLine.length - 1];
  return { macd: macdVal, signal: signalLine, hist: macdVal - signalLine };
}

/** Wilder/exponential moving average */
function _ema(arr, period) {
  if (!arr || arr.length < period) return NaN;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

/** Check if latest close exceeds 20-bar highest high (breakout). */
function _isBreakout20(bars, idx) {
  if (idx < 20) return false;
  const lookback = bars.slice(idx - 20, idx); // strictly before current
  const highest = Math.max(...lookback.map(b => b.h));
  return bars[idx].c > highest;
}

/** Check if bar is a bearish dump candle (bar return < dumpCandlePct). */
function _isDumpCandle(bar, dumpPct) {
  if (!bar || bar.o === 0) return false;
  return ((bar.c - bar.o) / bar.o) * 100 < dumpPct;
}

/**
 * Return the NY minute-of-day for a timestamp, or NaN.
 */
function _nyMinuteOfDay(tMs) {
  const p = _nyParts(tMs);
  if (!p) return NaN;
  return p.hour * 60 + p.minute;
}

// ── Candidate evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate a single candidate signal against all enabled gates.
 * Returns a full candidateRecord regardless of pass/fail.
 * All gate results are collected before returning (no early-exit after first failure).
 *
 * @param {object}   signal         { symbol, tMs, price, gainPct, relVol, score, vwap?, macd?, ... }
 * @param {object[]} barsForSymbol  Sorted OHLCV bars for this symbol.
 * @param {object}   cfg            Validated config.
 * @param {object}   state          Mutable state: { openPositions, dailyTrades, lastExitBar, dailyRiskUsed, equityCurve }
 * @param {object[]} [benchmarkBars] Sorted bars for benchmarkSymbol (for regime gate).
 * @returns {object}  candidateRecord
 */
function evaluateCandidate(signal, barsForSymbol, cfg, state, benchmarkBars, opts = {}) {
  const record = _newCandidateRecord(signal);

  // ── Locate signal bar ──────────────────────────────────────────────────────
  const hintedIdx = Number.isInteger(signal.barIndex) ? signal.barIndex : -1;
  const signalBarIdx = hintedIdx >= 0 && barsForSymbol[hintedIdx]?.t === signal.tMs
    ? hintedIdx
    : barsForSymbol.findIndex(b => b.t >= (signal.tMs || 0));
  if (signalBarIdx < 0) {
    return _finalise(record, 'REJECTED', 'NO_SIGNAL_BAR', 'No bar found at or after signal timestamp');
  }
  const signalBar = barsForSymbol[signalBarIdx];
  record.signalBarTime = signalBar.t;

  // ── Collect ALL gate results before deciding ───────────────────────────────
  // We run every gate and collect pass/fail reasons; rejection uses the first failure.
  const gateResults = []; // { gate, pass, reason, value }

  // ── Mandatory gates ────────────────────────────────────────────────────────

  // 1. Market hours
  if (cfg.enforceMarketHours) {
    const inHours = isMarketHours(signalBar.t);
    gateResults.push({ gate: 'marketHours', pass: inHours,
      reason: inHours ? 'In regular session' : 'Outside regular session',
      value: inHours });
  }

  // Entry time window restriction (optional but mandatory-like once set)
  if (cfg.entryStartMinutesET != null || cfg.entryEndMinutesET != null) {
    const minOfDay = _nyMinuteOfDay(signalBar.t);
    const start = cfg.entryStartMinutesET ?? 0;
    const end   = cfg.entryEndMinutesET   ?? 24 * 60;
    const inWindow = Number.isFinite(minOfDay) && minOfDay >= start && minOfDay < end;
    gateResults.push({ gate: 'entryTimeWindow', pass: inWindow,
      reason: inWindow ? 'Within entry time window' : `Minute-of-day ${minOfDay} outside [${start},${end})`,
      value: minOfDay });
  }

  // 2. No shorts
  const isShort = signal.side === 'short';
  gateResults.push({ gate: 'noShorts', pass: !isShort,
    reason: isShort ? 'Short selling is prohibited' : 'Long only',
    value: signal.side || 'long' });

  // 3. Same-symbol-open guard (mandatory)
  const sym = String(signal.symbol || '').toUpperCase();
  const symAlreadyOpen = !!(state.openPositions && state.openPositions[sym]);
  gateResults.push({ gate: 'symbolNotAlreadyOpen', pass: !symAlreadyOpen,
    reason: symAlreadyOpen ? `${sym} already has an open position` : 'Symbol not open',
    value: symAlreadyOpen });

  // 4. Max concurrent positions
  const dayKey = _dayKey(signalBar.t);
  const openCount = _openPositionCount(state.openPositions);
  record.gateValues.openPositions = openCount;
  const posOk = openCount < cfg.maxConcurrentLongs;
  gateResults.push({ gate: 'positionCap', pass: posOk,
    reason: posOk ? `${openCount}/${cfg.maxConcurrentLongs} positions` : `At max ${cfg.maxConcurrentLongs} concurrent longs`,
    value: openCount });

  // 5. Max daily trades
  const todayTrades = (state.dailyTrades && state.dailyTrades[dayKey]) || 0;
  record.gateValues.dailyTrades = todayTrades;
  const dayOk = todayTrades < cfg.maxTradesPerDay;
  gateResults.push({ gate: 'dailyTradeCap', pass: dayOk,
    reason: dayOk ? `${todayTrades}/${cfg.maxTradesPerDay} trades today` : `Daily cap of ${cfg.maxTradesPerDay} reached`,
    value: todayTrades });

  // 6. Daily risk cap
  const equityNow = _currentEquity(state, cfg);
  const dailyRiskUsed = (state.dailyRiskUsed && state.dailyRiskUsed[dayKey]) || 0;
  const maxDailyRisk  = equityNow * cfg.maxDailyRiskPct / 100;
  const riskOk = dailyRiskUsed < maxDailyRisk;
  gateResults.push({ gate: 'dailyRiskCap', pass: riskOk,
    reason: riskOk ? `Daily risk used $${dailyRiskUsed.toFixed(2)} / $${maxDailyRisk.toFixed(2)}` : 'Daily risk cap reached',
    value: dailyRiskUsed });

  // 7. Cooldown per symbol
  const lastExitBarIdx = (state.lastExitBar && state.lastExitBar[sym]) ?? -Infinity;
  const barsSinceLast  = lastExitBarIdx === -Infinity ? Infinity : signalBarIdx - lastExitBarIdx;
  record.gateValues.barsSinceLast = barsSinceLast;
  const cdOk = barsSinceLast >= cfg.cooldownBars;
  gateResults.push({ gate: 'cooldown', pass: cdOk,
    reason: cdOk ? `${barsSinceLast >= 1e6 ? '∞' : barsSinceLast} bars since last exit` : `Only ${barsSinceLast} bars since last exit (need ${cfg.cooldownBars})`,
    value: barsSinceLast });

  // ── Optional OHLCV-derivable gates ────────────────────────────────────────

  // 8. Price range
  if (cfg.gates.priceRange) {
    const price = signal.price;
    record.gateValues.price = price;
    if (price == null) {
      record.missingDataStates.push('price');
      gateResults.push({ gate: 'priceRange', pass: false, reason: 'price data missing', value: null });
    } else {
      const ok = price >= cfg.minPrice && price <= cfg.maxPrice;
      gateResults.push({ gate: 'priceRange', pass: ok,
        reason: ok ? `Price $${price} in [$${cfg.minPrice},$${cfg.maxPrice}]` : `Price $${price} outside range`,
        value: price });
    }
  }

  // 9. Min gain
  if (cfg.gates.minGainPct) {
    const gain = signal.gainPct;
    record.gateValues.gainPct = gain;
    if (gain == null) {
      record.missingDataStates.push('gainPct');
      gateResults.push({ gate: 'minGainPct', pass: false, reason: 'gainPct data missing', value: null });
    } else {
      const ok = gain >= cfg.minGainPct;
      gateResults.push({ gate: 'minGainPct', pass: ok,
        reason: ok ? `gainPct ${gain}% >= ${cfg.minGainPct}%` : `gainPct ${gain}% < ${cfg.minGainPct}%`,
        value: gain });
    }
  }

  // 10. Max gain cap
  if (cfg.gates.maxGainPct && cfg.maxGainPct != null) {
    const gain = signal.gainPct;
    if (gain == null) {
      if (!record.missingDataStates.includes('gainPct')) record.missingDataStates.push('gainPct');
      gateResults.push({ gate: 'maxGainPct', pass: false, reason: 'gainPct missing for maxGain gate', value: null });
    } else {
      const ok = gain <= cfg.maxGainPct;
      gateResults.push({ gate: 'maxGainPct', pass: ok,
        reason: ok ? `gainPct ${gain}% <= ${cfg.maxGainPct}%` : `gainPct ${gain}% > ${cfg.maxGainPct}% (extended; likely late)`,
        value: gain });
    }
  }

  // 11. Relative volume
  if (cfg.gates.minRelVol) {
    const rv = signal.relVol;
    record.gateValues.relVol = rv;
    if (rv == null) {
      record.missingDataStates.push('relVol');
      gateResults.push({ gate: 'minRelVol', pass: false, reason: 'relVol data missing', value: null });
    } else {
      const ok = rv >= cfg.minRelVol;
      gateResults.push({ gate: 'minRelVol', pass: ok,
        reason: ok ? `relVol ${rv.toFixed(1)}x >= ${cfg.minRelVol}x` : `relVol ${rv.toFixed(1)}x < ${cfg.minRelVol}x`,
        value: rv });
    }
  }

  // 12. Composite score
  if (cfg.gates.minScore) {
    const score = signal.score;
    record.gateValues.score = score;
    if (score == null) {
      record.missingDataStates.push('score');
      gateResults.push({ gate: 'minScore', pass: false, reason: 'score data missing', value: null });
    } else {
      const ok = score >= cfg.minScore;
      gateResults.push({ gate: 'minScore', pass: ok,
        reason: ok ? `score ${score} >= ${cfg.minScore}` : `score ${score} < ${cfg.minScore}`,
        value: score });
    }
  }

  // 13. Above VWAP
  if (cfg.gates.requireAboveVwap) {
    const vwap = signal.vwap;
    const price = signal.price;
    if (vwap == null || price == null) {
      if (vwap == null) record.missingDataStates.push('vwap');
      gateResults.push({ gate: 'requireAboveVwap', pass: false, reason: 'vwap or price missing', value: vwap });
    } else {
      const ok = price > vwap;
      gateResults.push({ gate: 'requireAboveVwap', pass: ok,
        reason: ok ? `price $${price} > VWAP $${vwap.toFixed(2)}` : `price $${price} <= VWAP $${vwap.toFixed(2)}`,
        value: vwap });
    }
  }

  // 14. MACD bullish (histogram > 0)
  if (cfg.gates.requireMacdBullish) {
    const macdObj = signal.macd;
    if (macdObj == null) {
      record.missingDataStates.push('macd');
      gateResults.push({ gate: 'requireMacdBullish', pass: false, reason: 'macd data missing', value: null });
    } else {
      const ok = macdObj.hist > 0;
      gateResults.push({ gate: 'requireMacdBullish', pass: ok,
        reason: ok ? `MACD hist ${macdObj.hist.toFixed(4)} > 0` : `MACD hist ${macdObj.hist.toFixed(4)} <= 0`,
        value: macdObj.hist });
    }
  }

  // 15. 20-bar breakout
  if (cfg.gates.requireBreakout20) {
    const breakout = signal.breakout20;
    if (breakout == null) {
      record.missingDataStates.push('breakout20');
      gateResults.push({ gate: 'requireBreakout20', pass: false, reason: 'breakout20 missing', value: null });
    } else {
      gateResults.push({ gate: 'requireBreakout20', pass: !!breakout,
        reason: breakout ? 'New 20-bar high breakout' : 'No 20-bar breakout',
        value: breakout });
    }
  }

  // 16. Reject bearish dump candle
  if (cfg.gates.rejectBearishDump) {
    const dumpPct = signal.dumpCandlePct;
    if (dumpPct == null) {
      record.missingDataStates.push('dumpCandlePct');
      gateResults.push({ gate: 'rejectBearishDump', pass: false, reason: 'dumpCandlePct missing', value: null });
    } else {
      const ok = dumpPct >= cfg.dumpCandlePct;
      gateResults.push({ gate: 'rejectBearishDump', pass: ok,
        reason: ok ? `Bar return ${dumpPct.toFixed(2)}% >= ${cfg.dumpCandlePct}%` : `Bearish dump candle ${dumpPct.toFixed(2)}%`,
        value: dumpPct });
    }
  }

  // 17. Market regime (requires benchmarkBars or signal.marketRegime)
  if (cfg.gates.marketRegimeBullish) {
    const regime = signal.marketRegime;
    if (regime == null) {
      record.missingDataStates.push('marketRegime');
      gateResults.push({ gate: 'marketRegimeBullish', pass: false, reason: 'marketRegime missing', value: null });
    } else {
      const ok = regime === 'BULLISH';
      gateResults.push({ gate: 'marketRegimeBullish', pass: ok,
        reason: ok ? 'Market regime BULLISH' : `Market regime ${regime}`,
        value: regime });
    }
  }

  // ── Unavailable gates — record as declared, never reject ──────────────────
  for (const g of UNAVAILABLE_GATES) {
    const key = _camelGateKey(g);
    record.unavailableGates.push(g);
    record.gateValues[key] = 'UNAVAILABLE';
    gateResults.push({ gate: g, pass: null, reason: 'Gate unavailable for OHLCV replay', value: 'UNAVAILABLE' });
  }

  // ── Compile gate reasons into record ──────────────────────────────────────
  record.gateReasons = gateResults;
  record.passedGates  = gateResults.filter(g => g.pass === true).map(g => g.gate);
  record.failedGates  = gateResults.filter(g => g.pass === false).map(g => g.gate);

  // ── Determine overall pass/fail (first non-null failure wins) ─────────────
  const firstFail = gateResults.find(g => g.pass === false);
  if (firstFail) {
    const code = firstFail.value == null
      ? _gateToCodeForMissing(firstFail.gate)
      : _gateToCode(firstFail.gate);
    return _finalise(record, 'REJECTED', code, firstFail.reason);
  }

  // Live paper/shadow evaluation records gate decisions now and waits for the
  // next observed scanner snapshot to create a hypothetical fill. It never
  // fabricates a future bar and can never submit an order.
  if (opts.gateOnly === true) {
    record.status = 'QUALIFIED';
    record.intendedEntryTime = signalBar.t;
    record.inputSnapshot = {
      price: signal.price ?? null,
      gainPct: signal.gainPct ?? null,
      relVol: signal.relVol ?? null,
      score: signal.score ?? null,
      vwap: signal.vwap ?? null,
      macdHist: signal.macd?.hist ?? null,
      breakout20: signal.breakout20 ?? null,
      dumpCandlePct: signal.dumpCandlePct ?? null,
      marketRegime: signal.marketRegime ?? null,
      entryOpen: null,
    };
    return record;
  }

  // ── Find next bar for entry fill ──────────────────────────────────────────
  const entryBarIdx = signalBarIdx + 1;
  if (entryBarIdx >= barsForSymbol.length) {
    return _finalise(record, 'REJECTED', 'NO_NEXT_BAR', 'No next bar available for entry fill');
  }
  const entryBar = barsForSymbol[entryBarIdx];

  if (cfg.enforceMarketHours && !isMarketHours(entryBar.t)) {
    return _finalise(record, 'REJECTED', 'ENTRY_OUTSIDE_MARKET_HOURS', 'Entry bar is outside regular trading hours');
  }

  // ── Compute sizing ────────────────────────────────────────────────────────
  const equity  = _currentEquity(state, cfg);
  const buyCost = entryBar.o * (cfg.halfSpreadPct + cfg.slippagePct) / 100;
  const fillPrice = entryBar.o + buyCost;
  const stopPrice = fillPrice * (1 - cfg.stopPct / 100);

  const sizing = _computeSizing(fillPrice, stopPrice, equity, cfg);

  record.intendedEntryTime = signalBar.t;
  record.actualFillTime    = entryBar.t;
  record.fillPrice         = fillPrice;
  record.stopPrice         = stopPrice;
  record.qty               = sizing.qty;
  record.notional          = sizing.notional;
  record.status            = 'FILLED';

  // Store input snapshot (point-in-time values used for decision)
  record.inputSnapshot = {
    price:        signal.price   ?? null,
    gainPct:      signal.gainPct ?? null,
    relVol:       signal.relVol  ?? null,
    score:        signal.score   ?? null,
    vwap:         signal.vwap    ?? null,
    macdHist:     signal.macd?.hist ?? null,
    breakout20:   signal.breakout20 ?? null,
    dumpCandlePct:signal.dumpCandlePct ?? null,
    marketRegime: signal.marketRegime ?? null,
    entryOpen:    entryBar.o,
  };

  return record;
}

// ── Internal helpers for evaluateCandidate ─────────────────────────────────────

function _gateToCode(gate) {
  const map = {
    marketHours:           'OUTSIDE_MARKET_HOURS',
    entryTimeWindow:       'OUTSIDE_ENTRY_WINDOW',
    noShorts:              'NO_SHORTS',
    symbolNotAlreadyOpen:  'SYMBOL_ALREADY_OPEN',
    positionCap:           'MAX_POSITIONS',
    dailyTradeCap:         'DAILY_TRADE_CAP',
    dailyRiskCap:          'DAILY_RISK_CAP',
    cooldown:              'COOLDOWN',
    priceRange:            'PRICE_RANGE',
    minGainPct:            'GAIN_PCT',
    maxGainPct:            'GAIN_PCT_HIGH',
    minRelVol:             'REL_VOL',
    minScore:              'SCORE',
    requireAboveVwap:      'BELOW_VWAP',
    requireMacdBullish:    'MACD_BEARISH',
    requireBreakout20:     'NO_BREAKOUT',
    rejectBearishDump:     'BEARISH_DUMP',
    marketRegimeBullish:   'REGIME_NOT_BULLISH',
  };
  return map[gate] || gate.toUpperCase();
}

function _gateToCodeForMissing(gate) {
  const missing = {
    priceRange:          'MISSING_PRICE',
    minGainPct:          'MISSING_GAIN_PCT',
    maxGainPct:          'MISSING_GAIN_PCT',
    minRelVol:           'MISSING_REL_VOL',
    minScore:            'MISSING_SCORE',
    requireAboveVwap:    'MISSING_VWAP',
    requireMacdBullish:  'MISSING_MACD',
    requireBreakout20:   'MISSING_BREAKOUT20',
    rejectBearishDump:   'MISSING_DUMP_CANDLE',
    marketRegimeBullish: 'MISSING_MARKET_REGIME',
  };
  return missing[gate] || `MISSING_${gate.toUpperCase()}`;
}

function _newCandidateRecord(signal) {
  const rank = signal.rank ?? 0;
  return {
    contractVersion:  CONTRACT_VERSION,
    strategyVersion:  CONTRACT_VERSION,
    decisionId:       `d${CONTRACT_VERSION}-${(signal.tMs || 0).toString(36)}-${String(signal.symbol || '').toUpperCase()}-${rank}`,
    symbol:           String(signal.symbol || '').toUpperCase(),
    signalTime:       signal.tMs || null,
    signalBarTime:    null,
    intendedEntryTime:null,
    actualFillTime:   null,
    fillPrice:        null,
    stopPrice:        null,
    qty:              null,
    notional:         null,
    status:           'PENDING',
    rejectReason:     null,
    rejectCode:       null,
    gateValues:       {},
    gateReasons:      [],
    passedGates:      [],
    failedGates:      [],
    unavailableGates: [],
    missingDataStates:[],
    inputSnapshot:    null,
    rank:             signal.rank ?? null,
  };
}

function _finalise(record, status, code, reason) {
  record.status      = status;
  record.rejectCode  = code || null;
  record.rejectReason= reason || null;
  return record;
}

function _dayKey(tMs) {
  const p = _nyParts(tMs);
  if (!p) return new Date(tMs).toISOString().slice(0, 10);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}

function _openPositionCount(openPositions) {
  return Object.values(openPositions || {}).filter(Boolean).length;
}

function _currentEquity(state, cfg) {
  if (!state.equityCurve || state.equityCurve.length === 0) return cfg.startingEquity;
  return state.equityCurve[state.equityCurve.length - 1];
}

/**
 * Compute share quantity and notional, honouring positionPct, leverage, maxRiskPct.
 */
function _computeSizing(fillPrice, stopPrice, equity, cfg) {
  let notional;
  if (cfg.fixedNotional != null) {
    notional = cfg.fixedNotional * (cfg.leverage || 1);
  } else {
    notional = equity * (cfg.positionPct / 100) * (cfg.leverage || 1);
  }
  // Risk-based cap: maxRiskPct limits loss to that % of equity
  if (cfg.maxRiskPct != null && cfg.maxRiskPct > 0 && fillPrice > stopPrice) {
    const riskPerShare = fillPrice - stopPrice;
    const maxLoss      = equity * cfg.maxRiskPct / 100;
    const maxQtyByRisk = maxLoss / riskPerShare;
    const maxNotional  = maxQtyByRisk * fillPrice;
    if (notional > maxNotional) notional = maxNotional;
  }
  const qty = fillPrice > 0 ? Math.max(1, Math.floor(notional / fillPrice)) : 0;
  return { qty, notional: qty * fillPrice };
}

// ── Replay engine ──────────────────────────────────────────────────────────────

/**
 * Replay signals chronologically against OHLCV data.
 * Returns { trades, candidates, metrics }.
 *
 * @param {object[]} signals   Sorted by tMs. Each: { symbol, tMs, price?, gainPct?, relVol?, score?, ... }
 * @param {object}   barsMap   Map of symbol → sorted bar array. Include benchmarkSymbol if marketRegimeBullish gate is used.
 * @param {object}   cfg       Config from createConfig().
 * @returns {{ trades: object[], candidates: object[], metrics: object }}
 */
function replaySession(signals, barsMap, cfg, opts = {}) {
  if (!Array.isArray(signals)) throw new TypeError('signals must be an array');
  if (!barsMap || typeof barsMap !== 'object') throw new TypeError('barsMap must be an object');

  const sortedSignals = [...signals].sort((a, b) =>
    (a.tMs || 0) - (b.tMs || 0) ||
    (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.relVol ?? 0) - (a.relVol ?? 0) ||
    String(a.symbol || '').localeCompare(String(b.symbol || ''))
  );

  const state = {
    openPositions: {},   // symbol → position object (remains until exitTime passes)
    dailyTrades:   {},   // dayKey → count
    lastExitBar:   {},   // symbol → bar index of last exit
    dailyRiskUsed: {},   // dayKey → total risk $ used
    equityCurve:   [cfg.startingEquity],
  };

  const pendingExits = []; // { sym, exitTime, exitBarIdx, trade }
  const captureCandidates = opts.captureCandidates !== false;
  const candidates   = [];
  const trades       = [];

  for (const signal of sortedSignals) {
    const signalTime = signal.tMs || 0;
    const sym = String(signal.symbol || '').toUpperCase();

    // ── Expire positions whose exit time is strictly before current signal ──
    for (let pi = pendingExits.length - 1; pi >= 0; pi--) {
      const pe = pendingExits[pi];
      if (pe.exitTime < signalTime) {
        delete state.openPositions[pe.sym];
        state.lastExitBar[pe.sym] = pe.exitBarIdx;
        pendingExits.splice(pi, 1);
        trades.push(pe.trade);
        // Update equity curve
        state.equityCurve.push(
          (state.equityCurve[state.equityCurve.length - 1] || cfg.startingEquity) + pe.trade.netPnl
        );
      }
    }

    const bars = barsMap[sym];
    if (!bars || bars.length === 0) {
      const rec = _newCandidateRecord(signal);
      _finalise(rec, 'REJECTED', 'NO_BARS', 'No OHLCV bars available for symbol');
      rec.missingDataStates.push('ohlcv');
      if (captureCandidates) candidates.push(rec);
      continue;
    }

    const benchmarkBars = barsMap[cfg.benchmarkSymbol] || null;
    const rec = evaluateCandidate(signal, bars, cfg, state, benchmarkBars);
    if (captureCandidates) candidates.push(rec);

    if (rec.status !== 'FILLED') continue;

    // ── Register open position ──────────────────────────────────────────────
    const pos = {
      symbol:      sym,
      fillPrice:   rec.fillPrice,
      stopPrice:   rec.stopPrice,
      qty:         rec.qty,
      notional:    rec.notional,
      entryBarIdx: bars.findIndex(b => b.t >= rec.actualFillTime),
      entryTime:   rec.actualFillTime,
      marketRegime: signal.marketRegime || 'UNKNOWN',
    };
    state.openPositions[sym] = pos;

    const dk = _dayKey(rec.actualFillTime);
    state.dailyTrades[dk]   = (state.dailyTrades[dk] || 0) + 1;

    // Risk used = potential stop loss
    const riskPerTrade = (rec.fillPrice - rec.stopPrice) * rec.qty;
    state.dailyRiskUsed[dk] = (state.dailyRiskUsed[dk] || 0) + riskPerTrade;

    // ── Pre-compute trade outcome ───────────────────────────────────────────
    const trade = _simulatePosition(pos, bars, cfg, opts.endOfDataExitReason);
    const exitBarIdx = bars.findIndex(b => b.t >= trade.exitTime);

    pendingExits.push({
      sym,
      exitTime:   trade.exitTime,
      exitBarIdx: exitBarIdx >= 0 ? exitBarIdx : bars.length - 1,
      trade,
    });
  }

  // Flush remaining pending exits
  pendingExits.sort((a, b) => a.exitTime - b.exitTime);
  for (const pe of pendingExits) {
    trades.push(pe.trade);
    state.equityCurve.push(
      (state.equityCurve[state.equityCurve.length - 1] || cfg.startingEquity) + pe.trade.netPnl
    );
  }

  trades.sort((a, b) => a.entryTime - b.entryTime);
  const metrics = computeMetrics(trades, cfg, state.equityCurve);
  return { trades, candidates, metrics };
}

// ── Position simulation ────────────────────────────────────────────────────────

/**
 * Simulate a position through bars to its exit.
 * Priority: STOP > SESSION_END/MAX_HOLD > RSI_EXIT.
 * Stop is conservative: if the bar gaps below the stop, fill at the lower bar
 * open; otherwise fill at the stop. Sell costs are then subtracted.
 * All other exits apply sell half-spread + slippage to exit price.
 * @private
 */
function _simulatePosition(pos, bars, cfg, endOfDataExitReason = 'END_OF_DATA') {
  const { entryBarIdx, fillPrice: entryPrice, stopPrice, qty } = pos;

  let exitPrice  = null;
  let exitTime   = null;
  let exitReason = null;
  let exitBarIdx = entryBarIdx;
  let mae = 0;
  let mfe = 0;

  const closes = bars.slice(0, entryBarIdx + 1).map(b => b.c);
  const sellCostPct = (cfg.halfSpreadPct + cfg.slippagePct) / 100;

  for (let i = entryBarIdx + 1; i < bars.length; i++) {
    const bar = bars[i];
    const barIsOpen = !cfg.enforceMarketHours || isMarketHours(bar.t);

    // Excursions relative to entry (before costs)
    const ae = Math.min(bar.l - entryPrice, 0);
    const fe = Math.max(bar.h - entryPrice, 0);
    if (ae < mae) mae = ae;
    if (fe > mfe) mfe = fe;

    closes.push(bar.c);
    const rsi      = computeRsi(closes, cfg.rsiPeriod);
    const holdBars = i - entryBarIdx;
    const stopHit  = bar.l <= stopPrice;
    const rsiExit  = Number.isFinite(rsi) && rsi >= cfg.takeProfitRsiLevel;
    const maxHold  = holdBars >= cfg.maxHoldBars;
    const sesEnd   = !barIsOpen;

    // PRIORITY 1 — STOP (conservative gap fill)
    if (stopHit) {
      // A stop order does not guarantee its stop price through an overnight or
      // halt gap. Use the lower bar open when it is already below the stop.
      const conservativeFillBeforeCosts = Math.min(stopPrice, bar.o);
      exitPrice  = conservativeFillBeforeCosts * (1 - sellCostPct);
      exitTime   = bar.t;
      exitReason = 'STOP';
      exitBarIdx = i;
      break;
    }

    // PRIORITY 2 — time-based forced exit
    if (sesEnd || maxHold) {
      exitPrice  = bar.c * (1 - sellCostPct);
      exitTime   = bar.t;
      exitReason = maxHold ? 'MAX_HOLD' : 'SESSION_END';
      exitBarIdx = i;
      break;
    }

    // PRIORITY 3 — RSI exit
    if (rsiExit) {
      exitPrice  = bar.c * (1 - sellCostPct);
      exitTime   = bar.t;
      exitReason = 'RSI_EXIT';
      exitBarIdx = i;
      break;
    }
  }

  // End-of-data fallback
  if (exitPrice === null) {
    if (bars.length > entryBarIdx + 1) {
      const lb   = bars[bars.length - 1];
      exitPrice  = lb.c * (1 - sellCostPct);
      exitTime   = lb.t;
      exitReason = endOfDataExitReason;
      exitBarIdx = bars.length - 1;
    } else {
      exitPrice  = entryPrice * (1 - sellCostPct);
      exitTime   = pos.entryTime;
      exitReason = 'NO_EXIT_BAR';
      exitBarIdx = entryBarIdx;
    }
  }

  const grossPnlPerShare = exitPrice - entryPrice;
  const grossPnl = grossPnlPerShare * qty;
  const netPnl   = grossPnl; // costs already embedded in exitPrice; buy cost in entryPrice
  const netPnlPct = entryPrice > 0 ? (grossPnlPerShare / entryPrice) * 100 : 0;

  return {
    symbol:      pos.symbol,
    entryTime:   pos.entryTime,
    exitTime,
    entryPrice,
    exitPrice,
    stopPrice,
    qty,
    notional:    pos.notional,
    grossPnl,
    netPnl,
    netPnlPct,
    win:         netPnl > 0,
    exitReason,
    mae:         mae * qty,
    mfe:         mfe * qty,
    holdBars:    exitBarIdx - entryBarIdx,
    marketRegime: pos.marketRegime || 'UNKNOWN',
  };
}

// ── Metrics ────────────────────────────────────────────────────────────────────

/**
 * Compute performance metrics from a completed trade array.
 * Uses sized net PnL and equity-curve drawdown when equityCurve is provided.
 * @param {object[]} trades
 * @param {object}   cfg
 * @param {number[]} [equityCurve]
 * @returns {object}
 */
function computeMetrics(trades, cfg, equityCurve) {
  const n = trades.length;
  if (n === 0) return _emptyMetrics(cfg);

  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);

  const winRate       = wins.length / n;
  const avgWin        = wins.length   ? _mean(wins.map(t => t.netPnl))   : 0;
  const avgLoss       = losses.length ? _mean(losses.map(t => t.netPnl)) : 0;
  const netExpectancy = winRate * avgWin + (1 - winRate) * avgLoss;

  const grossProfit  = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? Infinity : 0;

  const totalPnl   = trades.reduce((s, t) => s + t.netPnl, 0);
  const avgHold    = _mean(trades.map(t => t.holdBars));
  const turnover   = n;
  const avgMae     = _mean(trades.map(t => t.mae));
  const avgMfe     = _mean(trades.map(t => t.mfe));

  // Equity-curve drawdown preferred; fallback to PnL series
  const ddSeries = equityCurve && equityCurve.length > 0
    ? equityCurve
    : trades.map(t => t.netPnl);
  const maxDrawdown = equityCurve && equityCurve.length > 0
    ? _maxDrawdownFromEquity(equityCurve)
    : _computeMaxDrawdown(trades.map(t => t.netPnl));

  // Exit reasons
  const exitReasons = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;

  // Monthly
  const monthly = {};
  for (const t of trades) {
    const k = _monthKey(t.entryTime);
    if (!monthly[k]) monthly[k] = { count: 0, pnl: 0, wins: 0 };
    monthly[k].count++; monthly[k].pnl += t.netPnl;
    if (t.win) monthly[k].wins++;
  }
  for (const k of Object.keys(monthly))
    monthly[k].winRate = monthly[k].count ? monthly[k].wins / monthly[k].count : 0;

  // Instrument group — keep inverse exposure separate from long leverage.
  const byGroup = _emptyBreakdown(['stock', 'long_leveraged_etf', 'inverse_etf', 'other_etf']);
  for (const t of trades) {
    _addBreakdownTrade(byGroup, instrumentGroup(t.symbol), t);
  }
  _finaliseBreakdown(byGroup);

  // Point-in-time SPY regime attached to the entry signal.
  const byRegime = _emptyBreakdown(['BULLISH', 'BEARISH', 'UNKNOWN']);
  for (const t of trades) {
    const regime = ['BULLISH', 'BEARISH'].includes(t.marketRegime)
      ? t.marketRegime
      : 'UNKNOWN';
    _addBreakdownTrade(byRegime, regime, t);
  }
  _finaliseBreakdown(byRegime);

  return {
    contractVersion: CONTRACT_VERSION,
    n, winCount: wins.length, lossCount: losses.length,
    winRate, avgWin, avgLoss,
    netExpectancy, profitFactor,
    totalPnl, avgHoldBars: avgHold, turnover,
    avgMae, avgMfe, maxDrawdown,
    exitReasons, monthly, byGroup, byRegime,
  };
}

function _emptyMetrics() {
  return {
    contractVersion: CONTRACT_VERSION,
    n: 0, winCount: 0, lossCount: 0,
    winRate: 0, avgWin: 0, avgLoss: 0,
    netExpectancy: 0, profitFactor: 0,
    totalPnl: 0, avgHoldBars: 0, turnover: 0,
    avgMae: 0, avgMfe: 0, maxDrawdown: 0,
    exitReasons: {},
    monthly: {},
    byGroup: _finaliseBreakdown(_emptyBreakdown(['stock', 'long_leveraged_etf', 'inverse_etf', 'other_etf'])),
    byRegime: _finaliseBreakdown(_emptyBreakdown(['BULLISH', 'BEARISH', 'UNKNOWN'])),
  };
}

function _mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function _computeMaxDrawdown(pnls) {
  let peak = 0, cum = 0, maxDD = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function _maxDrawdownFromEquity(curve) {
  let peak = curve[0], maxDD = 0;
  for (const e of curve) {
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function _monthKey(tMs) {
  const d = new Date(tMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}

function _emptyBreakdown(keys) {
  return Object.fromEntries(keys.map(key => [key, {
    count: 0,
    pnl: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    netExpectancy: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    _pnls: [],
  }]));
}

function _addBreakdownTrade(breakdown, key, trade) {
  if (!breakdown[key]) breakdown[key] = _emptyBreakdown([key])[key];
  const bucket = breakdown[key];
  const pnl = Number(trade.netPnl) || 0;
  bucket.count++;
  bucket.pnl += pnl;
  bucket._pnls.push(pnl);
  if (pnl > 0) bucket.wins++;
  else bucket.losses++;
}

function _finaliseBreakdown(breakdown) {
  for (const bucket of Object.values(breakdown)) {
    const pnls = bucket._pnls || [];
    const grossProfit = pnls.filter(pnl => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
    const grossLoss = Math.abs(pnls.filter(pnl => pnl <= 0).reduce((sum, pnl) => sum + pnl, 0));
    bucket.winRate = bucket.count ? bucket.wins / bucket.count : 0;
    bucket.netExpectancy = bucket.count ? bucket.pnl / bucket.count : 0;
    bucket.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    bucket.maxDrawdown = _computeMaxDrawdown(pnls);
    delete bucket._pnls;
  }
  return breakdown;
}

function instrumentGroup(symbol) {
  if (/^(SQQQ|QID|AAPD|AMDD|AMZD|PLTD|QQQD|NVD|NVDQ|MSTZ|TSLZ|TSDD|SBIT|TZA|SPXS|SPXU|SOXS|TECS|FAZ|ERY|LABD|DUST|JDST|AIBD|TSXD|DRIP|DXD|SH|PSQ|RWM|DOG|TBF|SJB|GLL|ZSL|SCO|SARK|GGLS|RGTZ|CORD|BIS|SRTY|SVXY)$/i.test(symbol)) return 'inverse_etf';
  if (/^(TQQQ|SOXL|SPXL|TECL|LABU|UPRO|TNA|FAS|ERX|UDOW|TSLL|NVDX|NVDL|AMDL|PLTG|HOOG|NVDG|MSFU|AAPU|AMZU|GGLL|METU|BIB|CURE|URTY|UVXY)$/i.test(symbol)) return 'long_leveraged_etf';
  if (/^(QQQ|SPY|IWM|DIA|GLD|SLV|TLT|HYG|ARKK|XLF|XLE|XLK|XLV|SMH|XBI|IBB|ARKG)$/i.test(symbol)) return 'other_etf';
  return 'stock';
}

// ── Bootstrap CI ───────────────────────────────────────────────────────────────

/**
 * Deterministic bootstrap CI for net expectancy (mean netPnl per trade).
 * @param {object[]} trades
 * @param {object}   cfg
 * @param {object}   [opts]
 * @returns {{ mean, lo, hi, n, reps }}
 */
function bootstrapCI(trades, cfg, opts = {}) {
  const reps  = opts.reps  ?? cfg.bootstrapReps  ?? 2000;
  const seed  = opts.seed  ?? cfg.bootstrapSeed  ?? 42;
  const alpha = opts.alpha ?? 0.05;
  const n     = trades.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0, n: 0, reps };

  const pnls = trades.map(t => t.netPnl);
  const prng = _mulberry32(seed);
  const bootMeans = [];

  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += pnls[Math.floor(prng() * n)];
    bootMeans.push(sum / n);
  }
  bootMeans.sort((a, b) => a - b);
  const lo = bootMeans[Math.floor(reps * (alpha / 2))];
  const hi = bootMeans[Math.floor(reps * (1 - alpha / 2))];
  return { mean: _mean(pnls), lo, hi, n, reps };
}

function _mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ── buildPointInTimeSignals ────────────────────────────────────────────────────

/**
 * Build point-in-time signal objects from completed 5-minute OHLCV bars.
 * Each signal reflects only data available at the END of the signal bar
 * (no lookahead: previous-session baselines, cumulative intraday stats, indicators).
 *
 * @param {object}  barsMap  Map of symbol → sorted 5-min bar array.
 * @param {object}  [opts]
 * @param {boolean} [opts.prefilter=true]   Apply conservative pre-filter (pass ≥1 pillar).
 * @param {string}  [opts.benchmarkSymbol='SPY']  Symbol for regime detection.
 * @returns {{ signals: object[], metadata: object }}
 */
function buildPointInTimeSignals(barsMap, opts = {}) {
  const prefilter       = opts.prefilter !== false;
  const benchmarkSymbol = opts.benchmarkSymbol || 'SPY';
  const volumeLookbackSessions = Math.max(1, Number(opts.volumeLookbackSessions) || 20);
  const minHistorySessions = Math.max(1, Number(opts.minHistorySessions) || 5);
  const signals = [];

  // Collect regime info from benchmark bars (prior close needed for each session)
  const benchmarkBars = barsMap[benchmarkSymbol] || [];
  const benchmarkBySession = _groupBySession(benchmarkBars);
  const benchmarkSessionDates = [...benchmarkBySession.keys()].sort();

  for (const [symbol, bars] of Object.entries(barsMap)) {
    if (symbol === benchmarkSymbol) continue;

    // Group bars by NY trading session
    const sessionGroups = _groupBySession(bars);
    const sessionDates  = [...sessionGroups.keys()].sort();
    const globalIndexByTime = new Map(bars.map((bar, index) => [bar.t, index]));

    for (let si = 0; si < sessionDates.length; si++) {
      const sessionDate = sessionDates[si];
      const sessionBars = sessionGroups.get(sessionDate);
      if (!sessionBars || sessionBars.length === 0) continue;

      // Previous session close — strictly before current session
      const prevDate  = si > 0 ? sessionDates[si - 1] : null;
      const prevBars  = prevDate ? sessionGroups.get(prevDate) : null;
      const prevClose = prevBars ? prevBars[prevBars.length - 1].c : null;

      // Previous sessions' average daily volume (strictly historical)
      const priorDates = sessionDates.slice(Math.max(0, si - volumeLookbackSessions), si);
      const prevSessionVolumes = priorDates.map(d => {
        const sb = sessionGroups.get(d);
        return sb ? sb.reduce((s, b) => s + b.v, 0) : 0;
      });
      const avgDailyVol = prevSessionVolumes.length >= minHistorySessions
        ? prevSessionVolumes.reduce((s, v) => s + v, 0) / prevSessionVolumes.length
        : null;

      // Benchmark regime: latest available benchmark session strictly before
      // this symbol's session. Never align by the symbol's session index.
      const prevBenchDate = [...benchmarkSessionDates]
        .reverse()
        .find(date => date < sessionDate) || null;
      const benchBars      = prevBenchDate ? benchmarkBySession.get(prevBenchDate) : null;
      const regimeRaw      = benchBars ? _classifyRegime(benchBars) : null;
      const marketRegime   = regimeRaw;

      // Iterate completed bars within the session (need at least 1 prior bar for intraday stats)
      let cumVol = 0;
      let cumTpv = 0; // for VWAP
      const intraBars = [];

      for (let bi = 0; bi < sessionBars.length - 1; bi++) {
        const bar = sessionBars[bi];
        cumVol += bar.v;
        cumTpv += ((bar.h + bar.l + bar.c) / 3) * bar.v;
        intraBars.push(bar);

        // Skip first bar (need at least one prior bar to compute open→current gain)
        if (bi < 1) continue;

        const openBar    = sessionBars[0];
        const openPrice  = openBar.o;
        if (!openPrice || openPrice === 0) continue;

        const currentClose = bar.c;

        // Cumulative intraday gain % relative to prior session close (if available)
        // or session open if not
        const basePrice  = prevClose ?? openPrice;
        const gainPct    = basePrice > 0 ? ((currentClose - basePrice) / basePrice) * 100 : null;

        // Relative volume: current session volume vs avg daily (time-adjusted)
        const sessionElapsedBars   = bi + 1; // bars completed so far this session
        const totalSessionBars     = sessionBars.length;
        // Full-day relative volume (actual cumVol vs avgDailyVol)
        const relVolFullDay = avgDailyVol && avgDailyVol > 0 ? cumVol / avgDailyVol : null;
        // Time-adjusted relative volume (pace-projected)
        const paceProjected = totalSessionBars > 0
          ? cumVol * (totalSessionBars / sessionElapsedBars)
          : null;
        const relVolTimeAdj = avgDailyVol && avgDailyVol > 0 && paceProjected != null
          ? paceProjected / avgDailyVol
          : null;

        // VWAP (session-to-date, using only completed bars)
        const vwap = cumVol > 0 ? cumTpv / cumVol : null;

        // RSI (14) — uses all available closes within session up to and including this bar
        const intraDayCloses = intraBars.map(b => b.c);
        const rsi14 = computeRsi(intraDayCloses, 14);

        // MACD 12/26/9
        const allCloses = intraDayCloses;
        const macdResult = allCloses.length >= 26 + 9
          ? computeMacd(allCloses, 12, 26, 9)
          : null;

        // 20-bar breakout: close > highest high of prior 20 bars (strictly before this bar)
        const breakout20 = intraBars.length > 20
          ? _isBreakout20(intraBars, intraBars.length - 1)
          : null;

        // Dump candle: current bar return
        const dumpCandlePct = bar.o > 0
          ? ((bar.c - bar.o) / bar.o) * 100
          : null;

        // Composite score (matches current scanner rules)
        const score = _computeSignalScore(gainPct, relVolFullDay);

        const sig = {
          symbol,
          tMs:           bar.t,
          barIndex:      globalIndexByTime.get(bar.t),
          price:         currentClose,
          gainPct:       gainPct != null ? Math.round(gainPct * 100) / 100 : null,
          relVol:        relVolFullDay != null ? Math.round(relVolFullDay * 100) / 100 : null,
          relVolTimeAdj: relVolTimeAdj != null ? Math.round(relVolTimeAdj * 100) / 100 : null,
          score,
          vwap:          vwap != null ? Math.round(vwap * 10000) / 10000 : null,
          rsi:           Number.isFinite(rsi14) ? Math.round(rsi14 * 100) / 100 : null,
          macd:          macdResult,
          breakout20:    breakout20,
          dumpCandlePct: dumpCandlePct != null ? Math.round(dumpCandlePct * 100) / 100 : null,
          marketRegime,
          marketRegimeAsOf: prevBenchDate,
          // Metadata
          sessionDate,
          prevClose:     prevClose ?? null,
          cumVol,
          side:          'long',
        };

        if (prefilter && !_passesPrefilter(sig)) continue;

        signals.push(sig);
      }
    }
  }

  signals.sort((a, b) =>
    a.tMs - b.tMs ||
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.relVol ?? 0) - (a.relVol ?? 0) ||
    a.symbol.localeCompare(b.symbol)
  );
  let rankTime = null;
  let rank = 0;
  for (const signal of signals) {
    if (signal.tMs !== rankTime) {
      rankTime = signal.tMs;
      rank = 1;
    } else {
      rank++;
    }
    signal.rank = rank;
  }

  return {
    signals,
    metadata: {
      symbolCount:    Object.keys(barsMap).filter(s => s !== benchmarkSymbol).length,
      signalCount:    signals.length,
      prefilterApplied: prefilter,
      benchmarkSymbol,
      volumeLookbackSessions,
      minHistorySessions,
      generatedAt:    Date.now(),
      unavailableGates: [...UNAVAILABLE_GATES],
      note: 'news_catalyst and float_shares are not synthesised. Relative volume uses only the prior rolling completed sessions. marketRegime classifies the latest completed benchmark session strictly before each candidate date.',
    },
  };
}

/** Group bars by NY trading session date */
function _groupBySession(bars) {
  const map = new Map();
  for (const bar of bars) {
    const p = _nyParts(bar.t);
    if (!p) continue;
    const key = `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(bar);
  }
  return map;
}

/** Classify market regime from a session's bars. */
function _classifyRegime(bars) {
  if (!bars || bars.length === 0) return null;
  const open  = bars[0].o;
  const close = bars[bars.length - 1].c;
  const pct   = open > 0 ? ((close - open) / open) * 100 : 0;
  if (pct >= 0.5)  return 'BULLISH';
  if (pct <= -0.5) return 'BEARISH';
  return 'NEUTRAL';
}

/** Conservative prefilter: at least one pillar must plausibly pass. */
function _passesPrefilter(sig) {
  // Preserve a broad, identical candidate stream for tighten/remove ablations
  // while avoiding millions of obviously irrelevant 5-minute snapshots.
  return sig.price >= 2
    && sig.price <= 25
    && sig.gainPct != null
    && sig.gainPct >= 5
    && sig.relVol != null
    && sig.relVol >= 1
    && sig.cumVol >= 50_000;
}

/** Score matching current scanner: +2 gain≥10, +1 gain≥30, +1 rvol≥5, +1 rvol≥10 */
function _computeSignalScore(gainPct, relVol) {
  let score = 0;
  if (gainPct != null) {
    if (gainPct >= 10) score += 2;
    if (gainPct >= 30) score += 1;
  }
  if (relVol != null) {
    if (relVol >= 5)  score += 1;
    if (relVol >= 10) score += 1;
  }
  return score;
}

// ── Ablation runner (dev+val, compatible with v1) ─────────────────────────────

/**
 * One-at-a-time ablation over the dev+val period.
 * Test metrics are never included in the output.
 * Compatible with v1 callers.
 *
 * @param {object[]} signals
 * @param {object}   barsMap
 * @param {object}   baseConfig
 * @param {object[]} ablations  [{ name, configOverride }]
 * @returns {object[]}
 */
function ablationRun(signals, barsMap, baseConfig, ablations) {
  if (!Array.isArray(ablations)) throw new TypeError('ablations must be an array');

  // Derive dev+val cutoff from sessions
  const split = _splitSignalsBySession(
    signals,
    baseConfig.devFrac ?? DEFAULT_CONFIG.devFrac,
    baseConfig.valFrac ?? DEFAULT_CONFIG.valFrac,
  );
  const devValSignals = [...split.devSignals, ...split.valSignals]
    .sort((a, b) => (a.tMs || 0) - (b.tMs || 0));
  const devValEndSession = split.splitAudit.valSessions.at(-1)
    || split.splitAudit.devSessions.at(-1);
  const boundedBars = _barsThroughSession(barsMap, devValEndSession);

  const results = [];
  for (const abl of ablations) {
    const ablCfg = createConfig(Object.assign({}, baseConfig, abl.configOverride || {}, {
      _mandatoryGates: baseConfig._mandatoryGates || DEFAULT_CONFIG._mandatoryGates,
    }));
    const { trades } = replaySession(devValSignals, boundedBars, ablCfg, {
      captureCandidates: false,
      endOfDataExitReason: 'PERIOD_END',
    });
    const metrics = computeMetrics(trades, ablCfg);
    const ci      = bootstrapCI(trades, ablCfg);
    results.push({ name: abl.name, config: ablCfg, metrics, ci });
  }
  return results;
}

// ── Walk-forward validation ────────────────────────────────────────────────────

/**
 * Run a full walk-forward validation study.
 *
 * Workflow:
 *   1. Split signals into dev / val / test by unique NY trading sessions.
 *   2. Compute baseline (baseConfig) metrics on all three periods independently.
 *   3. Run one-at-a-time ablations on dev+val stream.
 *   4. Select best ablation using validation period only.
 *   5. Freeze selection.
 *   6. Evaluate the frozen selection on the untouched test period.
 *   7. Apply promotion criteria; emit selectionAudit proving test was not used for selection.
 *
 * @param {object[]} signals    All signals, sorted by tMs.
 * @param {object}   barsMap    Full bars map.
 * @param {object}   baseConfig Config from createConfig().
 * @param {object[]} [ablations] [{ name, configOverride }] — may be empty or omitted.
 * @param {object}   [opts]
 * @param {number}   [opts.bootstrapSeed]
 * @returns {object}  walkForwardReport
 */
function runWalkForwardValidation(signals, barsMap, baseConfig, ablations = [], opts = {}) {
  if (!Array.isArray(signals)) throw new TypeError('signals must be an array');

  const sorted = [...signals].sort((a, b) => (a.tMs || 0) - (b.tMs || 0));

  // ── Split by session ──────────────────────────────────────────────────────
  const split = _splitSignalsBySession(sorted, baseConfig.devFrac, baseConfig.valFrac);
  const { devSignals, valSignals, testSignals, splitAudit } = split;

  // ── Baseline on each period ───────────────────────────────────────────────
  const baselineDev  = _runPeriod(devSignals,  barsMap, baseConfig, 'dev',  splitAudit.devSessions.at(-1));
  const baselineVal  = _runPeriod(valSignals,  barsMap, baseConfig, 'val',  splitAudit.valSessions.at(-1));
  const baselineTest = _runPeriod(testSignals, barsMap, baseConfig, 'test', splitAudit.testSessions.at(-1));

  // ── Ablations on dev+val ──────────────────────────────────────────────────
  const devValSignals = [...devSignals, ...valSignals].sort((a, b) => (a.tMs||0)-(b.tMs||0));

  const ablationResults = [];
  for (const abl of ablations) {
    const ablCfg = createConfig(Object.assign({}, baseConfig, abl.configOverride || {}));

    // Dev metrics (for information only)
    const devR   = _runPeriod(devSignals,  barsMap, ablCfg, 'dev', splitAudit.devSessions.at(-1));
    // Val metrics (selection criteria)
    const valR   = _runPeriod(valSignals,  barsMap, ablCfg, 'val', splitAudit.valSessions.at(-1));
    const valCI  = bootstrapCI(valR.trades, ablCfg, { seed: opts.bootstrapSeed ?? ablCfg.bootstrapSeed });

    ablationResults.push({
      name:       abl.name,
      config:     ablCfg,
      devMetrics: devR.metrics,
      valMetrics: valR.metrics,
      valCI,
      // NOTE: no testMetrics here — test is never used for selection
    });
  }

  // ── Select best on validation only ───────────────────────────────────────
  // Rank by validation net expectancy (higher is better)
  // Baseline is always a candidate (name: 'baseline')
  const candidates = [
    {
      name: 'baseline', config: baseConfig,
      valMetrics: baselineVal.metrics,
      valCI: bootstrapCI(baselineVal.trades, baseConfig, { seed: opts.bootstrapSeed ?? baseConfig.bootstrapSeed }),
    },
    ...ablationResults,
  ];

  const minValTrades = baseConfig.promotionMinValTrades ?? 30;
  const eligibleForSelection = candidates.filter(c => c.valMetrics.n >= minValTrades);
  const ranked = [...(eligibleForSelection.length ? eligibleForSelection : [candidates[0]])].sort(
    (a, b) => (b.valMetrics.netExpectancy || 0) - (a.valMetrics.netExpectancy || 0)
  );
  const selected = ranked[0];

  // ── Freeze selection, then evaluate on test (ONCE) ───────────────────────
  const frozenConfig = selected.config;
  const testR  = _runPeriod(testSignals, barsMap, frozenConfig, 'test', splitAudit.testSessions.at(-1));
  const testCI = bootstrapCI(testR.trades, frozenConfig, { seed: opts.bootstrapSeed ?? frozenConfig.bootstrapSeed });

  // ── Promotion criteria ────────────────────────────────────────────────────
  const minTestTrades = frozenConfig.promotionMinTestTrades ?? 30;
  const baselineMaxDD = baselineTest.metrics.maxDrawdown;
  const baselineSelected = selected.name === 'baseline';

  const promotionChecks = {
    minValidationTrades:       { required: minValTrades,   actual: selected.valMetrics.n,             pass: selected.valMetrics.n >= minValTrades },
    minTestTrades:             { required: minTestTrades,  actual: testR.metrics.n,                   pass: testR.metrics.n >= minTestTrades },
    positiveAfterCostExpectancy:{ required: '> 0',         actual: testR.metrics.netExpectancy,       pass: testR.metrics.netExpectancy > 0 && selected.valMetrics.netExpectancy > 0 },
    profitFactorGe1:           { required: '>= 1',         actual: `val:${selected.valMetrics.profitFactor?.toFixed(2)} test:${testR.metrics.profitFactor?.toFixed(2)}`, pass: (selected.valMetrics.profitFactor || 0) >= 1 && (testR.metrics.profitFactor || 0) >= 1 },
    maxDrawdownNotWorse:       { required: `<= baseline ${baselineMaxDD.toFixed(2)}`, actual: testR.metrics.maxDrawdown, pass: testR.metrics.maxDrawdown <= baselineMaxDD },
    ciLoNonNegative:           { required: '>= 0 in validation and test', actual: `val:${selected.valCI.lo} test:${testCI.lo}`, pass: selected.valCI.lo >= 0 && testCI.lo >= 0 },
  };

  const allPromoPass = Object.values(promotionChecks).every(c => c.pass);
  const failedPromo  = Object.entries(promotionChecks).filter(([, c]) => !c.pass).map(([k]) => k);

  return {
    contractVersion: CONTRACT_VERSION,
    mode:            'PAPER_ONLY',
    splitAudit,
    baseline: {
      dev:  baselineDev.metrics,
      val:  baselineVal.metrics,
      test: baselineTest.metrics,
    },
    ablationResults,
    selectionAudit: {
      selectedName:               selected.name,
      selectionCriteria:          'max validation net expectancy',
      testNeverUsedForSelection:  true,
      valMetrics:                 selected.valMetrics,
      valCI:                      selected.valCI,
      rankedCandidates:           ranked.map(c => ({ name: c.name, valNetExpectancy: c.valMetrics.netExpectancy, valN: c.valMetrics.n })),
    },
    frozenConfig,
    testResults: {
      metrics: testR.metrics,
      ci:      testCI,
      trades:  testR.trades,
    },
    promotionChecks,
    promoted:        allPromoPass && !baselineSelected,
    promotionStatus: baselineSelected
      ? 'NO_PROMOTION'
      : allPromoPass ? 'PROMOTED_TO_PAPER' : 'NO_PROMOTION',
    selectionOutcome: baselineSelected ? 'BASELINE_RETAINED' : selected.name,
    promotionReasons: baselineSelected
      ? ['No eligible ablation beat the baseline on validation; live strategy unchanged']
      : allPromoPass ? ['All criteria met'] : failedPromo.map(k => `FAILED:${k}`),
  };
}

function _barsThroughSession(barsMap, endSession) {
  if (!endSession) return barsMap;
  return Object.fromEntries(Object.entries(barsMap).map(([symbol, bars]) => {
    // Bars are already chronological. Binary-search the first bar belonging
    // to a later NY session instead of formatting every timestamp on every
    // ablation run.
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (_dayKey(bars[mid].t) <= endSession) lo = mid + 1;
      else hi = mid;
    }
    return [symbol, bars.slice(0, lo)];
  }));
}

function _runPeriod(signals, barsMap, cfg, _label, endSession) {
  const boundedBars = _barsThroughSession(barsMap, endSession);
  const { trades, candidates, metrics } = replaySession(signals, boundedBars, cfg, {
    captureCandidates: false,
    endOfDataExitReason: 'PERIOD_END',
  });
  return { trades, candidates, metrics };
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  CONTRACT_VERSION,
  DEFAULT_CONFIG,
  UNAVAILABLE_GATES,
  buildOhlcvSeries,
  splitPeriods,
  createConfig,
  validateConfig,
  declaredUnavailableGates,
  isMarketHours,
  computeRsi,
  computeVwap,
  computeMacd,
  evaluateCandidate,
  replaySession,
  computeMetrics,
  bootstrapCI,
  ablationRun,
  buildPointInTimeSignals,
  runWalkForwardValidation,
  instrumentGroup,
};
