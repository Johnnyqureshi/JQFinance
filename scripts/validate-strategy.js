#!/usr/bin/env node
'use strict';

/**
 * Point-in-time strategy validation runner.
 *
 * This script reads historical 5-minute OHLCV bars only. It never calls a
 * trading endpoint and every generated configuration is marked PAPER_ONLY.
 *
 * Examples:
 *   node scripts/validate-strategy.js
 *   node scripts/validate-strategy.js --days 120 --max-symbols 100
 *   node scripts/validate-strategy.js --symbols SOUN,PLUG,KULR,SPY
 *   node scripts/validate-strategy.js --provider yahoo --days 55
 *   node scripts/validate-strategy.js --snapshot reports/data/strategy-ohlcv-<hash>.json.gz
 *   node scripts/validate-strategy.js --experiment reports/data/strategy-experiment-<hash>.json
 *   node scripts/validate-strategy.js --diagnostic-stop-free --experiment reports/data/strategy-experiment-<hash>.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const fetch = require('node-fetch');
const {
  CONTRACT_VERSION,
  buildOhlcvSeries,
  buildPointInTimeSignals,
  createConfig,
  replaySession,
  runWalkForwardValidation,
  runStopFreeDiagnostic,
} = require('../lib/strategy-validator');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports');
const PAPER_CONFIG_PATH = path.join(ROOT, 'config', 'paper-strategy.json');
const DEFAULT_DAYS = 120;
const DEFAULT_MAX_SYMBOLS = 100;
const REQUEST_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const next = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    out[rawKey] = next;
  }
  return out;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function credentialCandidates() {
  const pairs = [
    {
      source: 'paper-data-key',
      key: process.env.ALPACA_PAPER_KEY || process.env.ALPACA_API_KEY,
      secret: process.env.ALPACA_PAPER_SECRET || process.env.ALPACA_API_SECRET || process.env.ALPACA_SECRET_KEY,
      tradingBase: 'https://paper-api.alpaca.markets',
    },
    {
      source: 'live-data-key',
      key: process.env.ALPACA_LIVE_KEY,
      secret: process.env.ALPACA_LIVE_SECRET || process.env.ALPACA_LIVE_SECRET_KEY,
      tradingBase: 'https://api.alpaca.markets',
    },
  ];
  return pairs.filter(pair => pair.key && pair.secret);
}

async function selectReadOnlyAlpacaCredentials(candidates) {
  for (const candidate of candidates) {
    const headers = {
      'APCA-API-KEY-ID': candidate.key,
      'APCA-API-SECRET-KEY': candidate.secret,
    };
    try {
      await fetchJson('https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&limit=1&feed=iex', { headers }, 1);
      return candidate;
    } catch (_) {
      // Try the next configured pair. Never print either credential.
    }
  }
  return null;
}

function timeoutSignal(ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = timeoutSignal();
    try {
      const response = await fetch(url, { ...options, signal: timeout.signal });
      if (response.status === 429 || response.status >= 500) {
        const message = `HTTP ${response.status}`;
        if (attempt === attempts - 1) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    } finally {
      timeout.clear();
    }
  }
  throw lastError || new Error('Request failed');
}

function parseCuratedUniverse() {
  try {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'momentum.js'), 'utf8');
    const match = source.match(/UNIVERSE:\s*\[([\s\S]*?)\]\s*,/);
    if (!match) return [];
    return [...match[1].matchAll(/'([A-Z][A-Z0-9.\-]{0,11})'/g)].map(m => m[1]);
  } catch (_) {
    return [];
  }
}

async function fetchCurrentAlpacaUniverse(creds, maxSymbols) {
  const headers = {
    'APCA-API-KEY-ID': creds.key,
    'APCA-API-SECRET-KEY': creds.secret,
  };
  const symbols = [];
  const sources = [];
  const endpoints = [
    ['most-actives', `https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?top=${Math.min(100, maxSymbols)}&by=volume`],
    ['market-movers', 'https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50'],
  ];
  for (const [name, url] of endpoints) {
    try {
      const data = await fetchJson(url, { headers });
      const rows = name === 'market-movers'
        ? [...(data.gainers || []), ...(data.losers || [])]
        : (data.most_actives || []);
      for (const row of rows) {
        const sym = String(row.symbol || '').toUpperCase();
        if (/^[A-Z][A-Z0-9.\-]{0,11}$/.test(sym)) symbols.push(sym);
      }
      sources.push(name);
    } catch (error) {
      console.warn(`[validator] ${name} universe unavailable: ${error.message}`);
    }
  }
  try {
    const assets = await fetchJson(
      `${creds.tradingBase}/v2/assets?status=active&asset_class=us_equity`,
      { headers },
    );
    const eligible = (Array.isArray(assets) ? assets : [])
      .filter(asset => asset.tradable && /^[A-Z][A-Z0-9.\-]{0,7}$/.test(asset.symbol || ''))
      .map(asset => asset.symbol)
      .sort((a, b) => {
        const ah = crypto.createHash('sha1').update(`qf-validator|${a}`).digest('hex');
        const bh = crypto.createHash('sha1').update(`qf-validator|${b}`).digest('hex');
        return ah.localeCompare(bh);
      });
    symbols.push(...eligible);
    sources.push('deterministic-current-active-sample');
  } catch (error) {
    console.warn(`[validator] active asset universe unavailable: ${error.message}`);
  }
  return { symbols: [...new Set(symbols)].slice(0, maxSymbols), sources };
}

async function resolveUniverse(args, provider, creds, maxSymbols) {
  if (typeof args.symbols === 'string') {
    const supplied = args.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    return {
      symbols: [...new Set([...supplied, 'SPY'])],
      source: 'user-supplied',
      survivorshipBias: 'User-supplied symbols; historical universe membership is not reconstructed.',
    };
  }

  const curated = parseCuratedUniverse();
  let live = { symbols: [], sources: [] };
  if (provider === 'alpaca' && creds) {
    live = await fetchCurrentAlpacaUniverse(creds, maxSymbols);
  }
  const combined = [...new Set([...live.symbols, ...curated, 'SPY'])].slice(0, maxSymbols);
  if (!combined.includes('SPY')) combined.push('SPY');
  return {
    symbols: combined,
    source: live.symbols.length ? `current-${live.sources.join('+')}-plus-curated` : 'curated',
    survivorshipBias: 'Uses current/curated membership, not point-in-time historical universe membership. Results may contain survivorship and selection bias.',
  };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchAlpacaBars(symbols, startIso, endIso, creds) {
  const headers = {
    'APCA-API-KEY-ID': creds.key,
    'APCA-API-SECRET-KEY': creds.secret,
  };
  const raw = {};
  for (const group of chunk(symbols, 25)) {
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        symbols: group.join(','),
        timeframe: '5Min',
        start: startIso,
        end: endIso,
        limit: '10000',
        adjustment: 'all',
        feed: 'iex',
        sort: 'asc',
      });
      if (pageToken) params.set('page_token', pageToken);
      const data = await fetchJson(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
      for (const [symbol, bars] of Object.entries(data.bars || {})) {
        if (!raw[symbol]) raw[symbol] = [];
        raw[symbol].push(...bars.map(bar => ({ ...bar, symbol })));
      }
      pageToken = data.next_page_token || null;
      pages++;
      if (pages > 200) throw new Error('Alpaca pagination safety limit reached');
    } while (pageToken);
    console.log(`[validator] downloaded ${group.length} symbols (${pages} page${pages === 1 ? '' : 's'})`);
  }
  return raw;
}

async function fetchYahooBars(symbols, days) {
  const raw = {};
  const range = days <= 30 ? '1mo' : '60d';
  const queue = [...symbols];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const symbol = queue.shift();
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=${range}&includePrePost=false`;
        const data = await fetchJson(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        const result = data?.chart?.result?.[0];
        const quote = result?.indicators?.quote?.[0] || {};
        const bars = (result?.timestamp || []).map((seconds, i) => ({
          symbol,
          t: seconds * 1000,
          o: quote.open?.[i],
          h: quote.high?.[i],
          l: quote.low?.[i],
          c: quote.close?.[i],
          v: quote.volume?.[i],
        }));
        raw[symbol] = bars;
      } catch (error) {
        console.warn(`[validator] Yahoo ${symbol}: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
  return raw;
}

function normaliseBars(rawBySymbol) {
  const barsMap = {};
  for (const [symbol, rawBars] of Object.entries(rawBySymbol)) {
    const bars = buildOhlcvSeries(rawBars).filter(bar => bar.symbol === symbol);
    if (bars.length) barsMap[symbol] = bars;
  }
  return barsMap;
}

function fullGateOverride(base, patch) {
  return { gates: { ...base.gates, ...patch } };
}

function ablations(base) {
  return [
    { name: 'remove_price_gate', configOverride: fullGateOverride(base, { priceRange: false }) },
    { name: 'remove_gain_gate', configOverride: fullGateOverride(base, { minGainPct: false }) },
    { name: 'remove_relative_volume_gate', configOverride: fullGateOverride(base, { minRelVol: false }) },
    { name: 'remove_score_gate', configOverride: fullGateOverride(base, { minScore: false }) },
    { name: 'raise_min_gain_to_15pct', configOverride: { minGainPct: 15 } },
    { name: 'raise_min_relative_volume_to_7_5x', configOverride: { minRelVol: 7.5 } },
    { name: 'require_score_5', configOverride: { minScore: 5 } },
    { name: 'cap_extended_gain_at_30pct', configOverride: { maxGainPct: 30, ...fullGateOverride(base, { maxGainPct: true }) } },
    { name: 'require_price_above_vwap', configOverride: fullGateOverride(base, { requireAboveVwap: true }) },
    { name: 'require_macd_12_26_9_bullish', configOverride: fullGateOverride(base, { requireMacdBullish: true }) },
    { name: 'require_20_bar_breakout', configOverride: fullGateOverride(base, { requireBreakout20: true }) },
    { name: 'reject_large_bearish_bar', configOverride: fullGateOverride(base, { rejectBearishDump: true }) },
    { name: 'require_prior_spy_bullish_regime', configOverride: fullGateOverride(base, { marketRegimeBullish: true }) },
    { name: 'enter_0935_to_1100_et', configOverride: { entryStartMinutesET: 575, entryEndMinutesET: 660 } },
    { name: 'enter_1000_to_1550_et', configOverride: { entryStartMinutesET: 600, entryEndMinutesET: 950 } },
    { name: 'tighten_stop_to_3pct', configOverride: { stopPct: 3 } },
    { name: 'widen_stop_to_7pct', configOverride: { stopPct: 7 } },
    { name: 'exit_at_rsi_70', configOverride: { takeProfitRsiLevel: 70 } },
    { name: 'exit_at_rsi_80', configOverride: { takeProfitRsiLevel: 80 } },
  ];
}

function safeJson(value, spacing = 2) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) return item > 0 ? 'Infinity' : '-Infinity';
    return item;
  }, spacing);
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, filePath);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function saveInputSnapshot(payload, retrievedAt) {
  const payloadJson = safeJson(payload, 0);
  const inputSha256 = sha256(payloadJson);
  const relativePath = path.join(
    'reports',
    'data',
    `strategy-ohlcv-${inputSha256.slice(0, 16)}.json.gz`,
  );
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) {
    atomicWrite(absolutePath, zlib.gzipSync(Buffer.from(payloadJson), { level: 9 }));
  }
  const manifest = {
    schemaVersion: 1,
    inputSha256,
    retrievedAt,
    snapshotPath: relativePath,
    loadCommand: `node scripts/validate-strategy.js --snapshot ${relativePath}`,
    payload: {
      provider: payload.provider,
      feed: payload.feed,
      requestedDays: payload.requestedDays,
      requestedSymbols: payload.universe.symbols.length,
      barCount: Object.values(payload.barsMap).reduce((sum, bars) => sum + bars.length, 0),
    },
  };
  atomicWrite(`${absolutePath}.manifest.json`, safeJson(manifest) + '\n');
  return { ...manifest, absolutePath };
}

function loadInputSnapshot(snapshotArg) {
  if (!snapshotArg || snapshotArg === true) {
    throw new Error('--snapshot requires a workspace-relative .json.gz path');
  }
  const absolutePath = path.resolve(ROOT, String(snapshotArg));
  const relativePath = path.relative(ROOT, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Snapshot path must stay inside the workspace');
  }
  const payloadJson = zlib.gunzipSync(fs.readFileSync(absolutePath)).toString('utf8');
  const payload = JSON.parse(payloadJson);
  if (payload.schemaVersion !== 1 || payload.contractVersion !== CONTRACT_VERSION) {
    throw new Error(`Snapshot contract must be schema 1 / validator ${CONTRACT_VERSION}`);
  }
  if (!payload.barsMap || !payload.universe?.symbols || !payload.provider) {
    throw new Error('Snapshot payload is incomplete');
  }
  const inputSha256 = sha256(payloadJson);
  const expectedHash = path.basename(absolutePath)
    .match(/strategy-ohlcv-([a-f0-9]{16})\.json\.gz$/)?.[1];
  if (expectedHash && inputSha256.slice(0, 16) !== expectedHash) {
    throw new Error('Snapshot content hash does not match its filename');
  }
  let retrievedAt = null;
  try {
    retrievedAt = JSON.parse(fs.readFileSync(`${absolutePath}.manifest.json`, 'utf8')).retrievedAt || null;
  } catch (_) {
    // The content hash still proves the bars; old snapshots may lack a manifest.
  }
  return {
    payload,
    inputSha256,
    snapshotPath: relativePath,
    loadCommand: `node scripts/validate-strategy.js --snapshot ${relativePath}`,
    retrievedAt,
  };
}

function currentSourceHashes() {
  return {
    validatorSha256: sha256(fs.readFileSync(path.join(ROOT, 'lib', 'strategy-validator.js'))),
    runnerSha256: sha256(fs.readFileSync(__filename)),
  };
}

function buildExperimentPayload(inputSnapshot, baseConfig, variants, sourceHashes = currentSourceHashes()) {
  return {
    schemaVersion: 1,
    contractVersion: CONTRACT_VERSION,
    inputSnapshot: {
      inputSha256: inputSnapshot.inputSha256,
      snapshotPath: inputSnapshot.snapshotPath,
    },
    baseConfig,
    variants,
    sourceHashes,
  };
}

function experimentIdentity(payload) {
  const experimentSha256 = sha256(safeJson(payload, 0));
  const studyId = experimentSha256.slice(0, 12);
  const experimentPath = path.join('reports', 'data', `strategy-experiment-${studyId}.json`);
  return {
    experimentSha256,
    studyId,
    experimentPath,
    replayCommand: `node scripts/validate-strategy.js --experiment ${experimentPath}`,
  };
}

function saveExperimentManifest(inputSnapshot, baseConfig, variants) {
  const payload = buildExperimentPayload(inputSnapshot, baseConfig, variants);
  const identity = experimentIdentity(payload);
  atomicWrite(path.join(ROOT, identity.experimentPath), safeJson(payload) + '\n');
  return { payload, ...identity, configLocked: true };
}

function loadExperimentManifest(experimentArg) {
  if (!experimentArg || experimentArg === true) {
    throw new Error('--experiment requires a workspace-relative .json path');
  }
  const absolutePath = path.resolve(ROOT, String(experimentArg));
  const relativePath = path.relative(ROOT, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Experiment path must stay inside the workspace');
  }
  const payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  if (payload.schemaVersion !== 1 || payload.contractVersion !== CONTRACT_VERSION) {
    throw new Error(`Experiment contract must be schema 1 / validator ${CONTRACT_VERSION}`);
  }
  if (!payload.inputSnapshot?.inputSha256 || !payload.inputSnapshot?.snapshotPath
      || !payload.baseConfig || !Array.isArray(payload.variants) || !payload.sourceHashes) {
    throw new Error('Experiment manifest is incomplete');
  }
  const identity = experimentIdentity(payload);
  const expectedId = path.basename(absolutePath)
    .match(/strategy-experiment-([a-f0-9]{12})\.json$/)?.[1];
  if (expectedId && identity.studyId !== expectedId) {
    throw new Error('Experiment content hash does not match its filename');
  }
  const currentHashes = currentSourceHashes();
  if (payload.sourceHashes.validatorSha256 !== currentHashes.validatorSha256
      || payload.sourceHashes.runnerSha256 !== currentHashes.runnerSha256) {
    throw new Error('Validator source does not match the experiment manifest; restore the recorded code before replay');
  }
  return { payload, ...identity, experimentPath: relativePath, configLocked: true };
}

function csvValue(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tradesCsv(trades) {
  const columns = [
    'symbol', 'entryTime', 'exitTime', 'entryPrice', 'exitPrice', 'stopPrice',
    'qty', 'notional', 'netPnl', 'netPnlPct', 'exitReason', 'holdBars', 'mae', 'mfe',
  ];
  return [
    columns.join(','),
    ...trades.map(trade => columns.map(column => {
      const value = column.endsWith('Time') ? new Date(trade[column]).toISOString() : trade[column];
      return csvValue(value);
    }).join(',')),
  ].join('\n') + '\n';
}

function pct(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function money(value) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

function markdownSummary(report) {
  const b = report.walkForward.baseline;
  const selected = report.walkForward.selectionAudit;
  const test = report.walkForward.testResults.metrics;
  const gaps = report.dataQuality.dataGaps.map(gap => `- ${gap}`).join('\n');
  const failed = Object.entries(report.walkForward.promotionChecks)
    .filter(([, check]) => !check.pass)
    .map(([name, check]) => `- ${name}: required ${check.required}; observed ${check.actual}`)
    .join('\n') || '- None';
  return `# Strategy Validation Report

Generated: ${report.generatedAt}
Study: ${report.studyId}
Mode: **PAPER_ONLY**
Input SHA-256: \`${report.inputSnapshot.inputSha256}\`
Experiment SHA-256: \`${report.experiment.experimentSha256}\`
Exact replay: \`${report.experiment.replayCommand}\`

## Decision

**${report.walkForward.promotionStatus}**

Selected on validation only: \`${selected.selectedName}\`

No live-order settings or execution code were changed.

## Chronological split

| Period | Sessions | Trades | Win rate | Net expectancy | Profit factor | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| Development | ${report.walkForward.splitAudit.devSessions.length} | ${b.dev.n} | ${pct(b.dev.winRate)} | ${money(b.dev.netExpectancy)} | ${b.dev.profitFactor} | ${money(b.dev.maxDrawdown)} |
| Validation | ${report.walkForward.splitAudit.valSessions.length} | ${b.val.n} | ${pct(b.val.winRate)} | ${money(b.val.netExpectancy)} | ${b.val.profitFactor} | ${money(b.val.maxDrawdown)} |
| Untouched test | ${report.walkForward.splitAudit.testSessions.length} | ${test.n} | ${pct(test.winRate)} | ${money(test.netExpectancy)} | ${test.profitFactor} | ${money(test.maxDrawdown)} |

## Promotion checks that failed

${failed}

## Data limitations

${gaps}

## Execution assumptions

- A signal can fill only at the next completed 5-minute bar open.
- Buy and sell half-spread plus slippage are charged.
- Stop-loss wins when multiple exits occur in one bar.
- A gap or halt below the stop fills at the lower next bar open.
- Development and validation exits are force-closed at their own period boundary; no later split bars are readable.
- Maximum two concurrent long positions; no short selling.
- Historical news, point-in-time float, Level 2, tape, and options data are not fabricated.
`;
}

function stopFreeDiagnosticIdentity(experiment, inputSnapshot, sourceHashes = currentSourceHashes()) {
  const payload = {
    schemaVersion: 1,
    contractVersion: CONTRACT_VERSION,
    diagnosticId: 'STOP_FREE_ENTRY_EXIT_ISOLATION',
    baseExperimentSha256: experiment.experimentSha256,
    baseExperimentPath: experiment.experimentPath,
    inputSha256: inputSnapshot.inputSha256,
    sourceHashes,
  };
  const diagnosticSha256 = sha256(safeJson(payload, 0));
  const diagnosticId = diagnosticSha256.slice(0, 12);
  return {
    payload,
    diagnosticSha256,
    diagnosticId,
    manifestPath: path.join('reports', 'data', `strategy-stop-free-diagnostic-${diagnosticId}.json`),
    replayCommand: `node scripts/validate-strategy.js --diagnostic-stop-free --experiment ${experiment.experimentPath}`,
  };
}

function stopFreeDiagnosticMarkdown(report) {
  const rows = ['dev', 'val', 'test'].map(period => {
    const r = report.diagnostic.periods[period];
    return `| ${period === 'test' ? 'Untouched test' : period === 'dev' ? 'Development' : 'Validation'} | `
      + `${r.baseline.n} | ${pct(r.baseline.winRate)} | ${money(r.baseline.netExpectancy)} | `
      + `${r.stopFree.n} | ${pct(r.stopFree.winRate)} | ${money(r.stopFree.netExpectancy)} | `
      + `${r.stopFree.profitFactor} | ${money(r.stopFree.worstMae)} | ${money(r.stopFree.maxDrawdown)} | `
      + `${r.comparison.ignoredStopTradeCount} / ${r.comparison.ignoredStopBreaches} |`;
  }).join('\n');
  const assessment = report.diagnostic.assessment;
  return `# Stop-Free Entry/Exit Diagnostic

Generated: ${report.generatedAt}
Mode: **PAPER_ONLY — DIAGNOSTIC ONLY**
Base study: \`${report.baseStudyId}\`
Base experiment SHA-256: \`${report.baseExperiment.experimentSha256}\`
Diagnostic SHA-256: \`${report.diagnosticIdentity.diagnosticSha256}\`
Exact replay: \`${report.diagnosticIdentity.replayCommand}\`

## What was held constant

- The same entry signals, gates, next-bar fills, spread, slippage, and stop-based sizing.
- The same RSI, session, max-hold, and split-boundary exits.
- Only stop-triggered exits were suppressed. This cannot enable live execution and is not eligible for promotion.

## Results

| Period | Baseline trades | Baseline win rate | Baseline expectancy | Stop-free trades | Stop-free win rate | Stop-free expectancy | Stop-free PF | Stop-free worst MAE | Stop-free max drawdown | Stop-hit trades / bars below stop |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

## Assessment

**${assessment.status}**

${assessment.conclusion}

The stop-free replay is a counterfactual risk diagnostic, not a trading recommendation. The active paper configuration and live order path were not changed.
`;
}

function writeStopFreeDiagnosticArtifacts(rootDir, diagnosticReport, identity) {
  const reportDir = path.join(rootDir, 'reports');
  const versionedReport = path.join(reportDir, `strategy-stop-free-diagnostic-${identity.diagnosticId}.json`);
  const latestReport = path.join(reportDir, 'strategy-stop-free-diagnostic-latest.json');
  const latestSummary = path.join(reportDir, 'strategy-stop-free-diagnostic-latest.md');
  atomicWrite(path.join(rootDir, identity.manifestPath), safeJson(identity.payload) + '\n');
  atomicWrite(versionedReport, safeJson(diagnosticReport) + '\n');
  atomicWrite(latestReport, safeJson(diagnosticReport) + '\n');
  atomicWrite(latestSummary, stopFreeDiagnosticMarkdown(diagnosticReport));
  return { versionedReport, latestReport, latestSummary };
}

async function main() {
  const args = parseArgs(process.argv);
  let lockedExperiment = null;
  if (args.experiment) {
    const conflicting = Object.keys(args).filter(key => key !== 'experiment' && key !== 'diagnostic-stop-free');
    if (conflicting.length) {
      throw new Error(`--experiment rejects conflicting flags: ${conflicting.map(key => `--${key}`).join(', ')}`);
    }
    lockedExperiment = loadExperimentManifest(args.experiment);
    args.snapshot = lockedExperiment.payload.inputSnapshot.snapshotPath;
  }
  if (args['diagnostic-stop-free'] && !lockedExperiment) {
    throw new Error('--diagnostic-stop-free requires a locked --experiment manifest');
  }
  let days = toInt(args.days, DEFAULT_DAYS, 30, 730);
  const maxSymbols = toInt(args['max-symbols'], DEFAULT_MAX_SYMBOLS, 2, 250);
  let provider;
  let feed;
  let creds = null;
  let universe;
  let barsMap;
  let inputSnapshot;

  if (args.snapshot) {
    const loaded = loadInputSnapshot(args.snapshot);
    const payload = loaded.payload;
    provider = payload.provider;
    feed = payload.feed;
    days = payload.requestedDays;
    universe = payload.universe;
    barsMap = normaliseBars(payload.barsMap);
    inputSnapshot = {
      inputSha256: loaded.inputSha256,
      snapshotPath: loaded.snapshotPath,
      loadCommand: loaded.loadCommand,
      retrievedAt: loaded.retrievedAt,
      loadedFromArchive: true,
    };
    if (lockedExperiment
        && loaded.inputSha256 !== lockedExperiment.payload.inputSnapshot.inputSha256) {
      throw new Error('Experiment manifest input hash does not match the OHLCV snapshot');
    }
    console.log(`[validator] immutable snapshot=${loaded.snapshotPath} sha256=${loaded.inputSha256.slice(0, 16)}…`);
  } else {
    const candidates = credentialCandidates();
    const requestedProvider = String(args.provider || '').toLowerCase();
    provider = requestedProvider || (candidates.length ? 'alpaca' : 'yahoo');
    if (!['alpaca', 'yahoo'].includes(provider)) throw new Error('provider must be alpaca or yahoo');
    creds = provider === 'alpaca' ? await selectReadOnlyAlpacaCredentials(candidates) : null;
    if (provider === 'alpaca' && !creds) {
      throw new Error('Alpaca data credentials are unavailable. Use --provider yahoo or configure an Alpaca data key.');
    }

    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    universe = await resolveUniverse(args, provider, creds, maxSymbols);
    console.log(`[validator] provider=${provider} symbols=${universe.symbols.length} range=${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`);
    const raw = provider === 'alpaca'
      ? await fetchAlpacaBars(universe.symbols, start.toISOString(), end.toISOString(), creds)
      : await fetchYahooBars(universe.symbols, Math.min(days, 60));
    barsMap = normaliseBars(raw);
    feed = provider === 'alpaca' ? 'IEX historical 5-minute bars' : 'Yahoo historical 5-minute bars';
    const snapshot = saveInputSnapshot({
      schemaVersion: 1,
      contractVersion: CONTRACT_VERSION,
      provider,
      feed,
      requestedDays: days,
      universe,
      barsMap,
    }, end.toISOString());
    inputSnapshot = {
      inputSha256: snapshot.inputSha256,
      snapshotPath: snapshot.snapshotPath,
      loadCommand: snapshot.loadCommand,
      retrievedAt: snapshot.retrievedAt,
      loadedFromArchive: false,
    };
    console.log(`[validator] archived immutable input ${snapshot.snapshotPath}`);
  }

  if (!barsMap.SPY) throw new Error('SPY benchmark bars are required but unavailable');

  const receivedSymbols = Object.keys(barsMap);
  if (receivedSymbols.length < 2) throw new Error('Not enough symbols returned historical bars');
  const barCount = Object.values(barsMap).reduce((sum, bars) => sum + bars.length, 0);

  const built = buildPointInTimeSignals(barsMap, {
    benchmarkSymbol: 'SPY',
    prefilter: true,
    volumeLookbackSessions: 20,
    minHistorySessions: 5,
  });
  if (!built.signals.length) throw new Error('No point-in-time signal snapshots could be constructed');

  const baseConfig = lockedExperiment
    ? createConfig(lockedExperiment.payload.baseConfig)
    : createConfig({
      mode: 'PAPER_ONLY',
      maxConcurrentLongs: 2,
      maxTradesPerDay: 5,
      halfSpreadPct: Number(args['half-spread-pct'] ?? 0.15),
      slippagePct: Number(args['slippage-pct'] ?? 0.20),
      startingEquity: Number(args.equity ?? 25000),
      positionPct: Number(args['position-pct'] ?? 10),
      leverage: 1,
      stopPct: 5,
      maxRiskPct: 1,
      maxDailyRiskPct: 3,
      takeProfitRsiLevel: 75,
      maxHoldBars: 78,
      cooldownBars: 3,
      entryStartMinutesET: 575,
      entryEndMinutesET: 950,
      promotionMinValTrades: toInt(args['min-validation-trades'], 30, 5, 10000),
      promotionMinTestTrades: toInt(args['min-test-trades'], 30, 5, 10000),
    });

  const variants = lockedExperiment
    ? lockedExperiment.payload.variants
    : ablations(baseConfig);
  const experiment = lockedExperiment || saveExperimentManifest(inputSnapshot, baseConfig, variants);
  if (args['diagnostic-stop-free']) {
    const diagnostic = runStopFreeDiagnostic(built.signals, barsMap, baseConfig);
    const identity = stopFreeDiagnosticIdentity(experiment, inputSnapshot);
    const diagnosticReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: 'PAPER_ONLY',
      liveExecutionAllowed: false,
      promotionEligible: false,
      baseStudyId: experiment.studyId,
      inputSnapshot: {
        inputSha256: inputSnapshot.inputSha256,
        snapshotPath: inputSnapshot.snapshotPath,
        immutable: true,
      },
      baseExperiment: {
        experimentSha256: experiment.experimentSha256,
        experimentPath: experiment.experimentPath,
        replayCommand: experiment.replayCommand,
      },
      diagnosticIdentity: {
        diagnosticSha256: identity.diagnosticSha256,
        manifestPath: identity.manifestPath,
        replayCommand: identity.replayCommand,
        sourceHashes: identity.payload.sourceHashes,
      },
      diagnostic,
      note: 'Separate counterfactual diagnostic. It does not modify paper-strategy.json or any live order behavior.',
    };
    const artifacts = writeStopFreeDiagnosticArtifacts(ROOT, diagnosticReport, identity);
    console.log('');
    console.log('════════════════════════════════════════════════════');
    console.log(`Diagnostic: ${identity.diagnosticId}`);
    console.log(`Status:     ${diagnostic.assessment.status}`);
    console.log(`Test win:   ${pct(diagnostic.periods.test.stopFree.winRate)}`);
    console.log(`Test expect:${money(diagnostic.periods.test.stopFree.netExpectancy)} after costs`);
    console.log(`Report:     ${path.relative(ROOT, artifacts.latestReport)}`);
    console.log(`Replay:     ${identity.replayCommand}`);
    console.log('Paper strategy and live orders: UNCHANGED');
    return;
  }
  console.log(`[validator] replaying ${built.signals.length.toLocaleString()} decisions across ${variants.length} one-at-a-time ablations`);
  const walkForward = runWalkForwardValidation(built.signals, barsMap, baseConfig, variants);
  const fullBaseline = replaySession(built.signals, barsMap, baseConfig);

  const firstBar = Math.min(...Object.values(barsMap).map(bars => bars[0].t));
  const lastBar = Math.max(...Object.values(barsMap).map(bars => bars[bars.length - 1].t));
  const studyId = experiment.studyId;

  const report = {
    studyId,
    generatedAt: new Date().toISOString(),
    contractVersion: CONTRACT_VERSION,
    mode: 'PAPER_ONLY',
    inputSnapshot: {
      ...inputSnapshot,
      immutable: true,
    },
    experiment: {
      experimentSha256: experiment.experimentSha256,
      experimentPath: experiment.experimentPath,
      replayCommand: experiment.replayCommand,
      configLocked: true,
      sourceHashes: experiment.payload.sourceHashes,
    },
    dataQuality: {
      provider,
      feed,
      credentialSource: provider === 'alpaca' ? (creds?.source || 'archived-snapshot') : null,
      requestedDays: days,
      requestedSymbols: universe.symbols.length,
      receivedSymbols: receivedSymbols.length,
      missingSymbols: universe.symbols.filter(symbol => !barsMap[symbol]),
      barCount,
      firstBar: new Date(firstBar).toISOString(),
      lastBar: new Date(lastBar).toISOString(),
      universeSource: universe.source,
      universeBias: universe.survivorshipBias,
      dataGaps: [
        universe.survivorshipBias,
        'No point-in-time historical news catalyst archive was available; the news gate is declared unavailable.',
        'No point-in-time float/share-count archive was available; the float gate is declared unavailable.',
        'No Level 2 order book, tape, halt queue, or options-flow history was available.',
        'IEX/Yahoo OHLCV bars cannot reproduce exact exchange queue position or partial fills.',
        `The replay forces a time exit after ${baseConfig.maxHoldBars} observed 5-minute bars. The current live bot may hold longer until its stop or RSI exit, so overnight behavior is not treated as an exact match.`,
        'The historical replay is evidence for paper testing, not a guarantee of future performance.',
      ],
    },
    signalContract: built.metadata,
    executionModel: {
      nextBarFill: true,
      conservativeSameBarPriority: 'STOP > TIME EXIT > RSI EXIT',
      gapBelowStopFillsAtBarOpen: true,
      maxConcurrentLongs: baseConfig.maxConcurrentLongs,
      maxTradesPerDay: baseConfig.maxTradesPerDay,
      halfSpreadPctOneWay: baseConfig.halfSpreadPct,
      slippagePctOneWay: baseConfig.slippagePct,
      holdingPeriod: `Force exit after ${baseConfig.maxHoldBars} observed 5-minute bars; a late entry can carry overnight until that limit`,
      liveHoldingDifferenceDeclared: true,
      noShorts: true,
      liveOrdersChanged: false,
      splitBarBoundariesEnforced: true,
      periodEndExitReason: 'PERIOD_END',
    },
    walkForward,
    fullBaseline: {
      metrics: fullBaseline.metrics,
      candidateCount: fullBaseline.candidates.length,
      filledCount: fullBaseline.trades.length,
      rejectionCounts: fullBaseline.candidates.reduce((counts, candidate) => {
        const key = candidate.rejectCode || candidate.status;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
    },
  };

  const latestReport = path.join(REPORT_DIR, 'strategy-validation-latest.json');
  const versionedReport = path.join(REPORT_DIR, `strategy-validation-${studyId}.json`);
  const summaryPath = path.join(REPORT_DIR, 'strategy-validation-latest.md');
  const decisionsPath = path.join(REPORT_DIR, 'strategy-decisions-latest.jsonl.gz');
  const tradesPath = path.join(REPORT_DIR, 'strategy-trades-latest.csv');
  report.artifacts = {
    report: path.relative(ROOT, latestReport),
    summary: path.relative(ROOT, summaryPath),
    decisions: path.relative(ROOT, decisionsPath),
    trades: path.relative(ROOT, tradesPath),
    inputSnapshot: inputSnapshot.snapshotPath,
    experiment: experiment.experimentPath,
  };
  const json = safeJson(report);
  atomicWrite(latestReport, json + '\n');
  atomicWrite(versionedReport, json + '\n');
  atomicWrite(summaryPath, markdownSummary(report));
  const decisionJsonl = fullBaseline.candidates.map(candidate => safeJson(candidate, 0)).join('\n') + '\n';
  atomicWrite(decisionsPath, zlib.gzipSync(Buffer.from(decisionJsonl), { level: 9 }));
  const legacyDecisionsPath = path.join(REPORT_DIR, 'strategy-decisions-latest.jsonl');
  if (fs.existsSync(legacyDecisionsPath)) fs.unlinkSync(legacyDecisionsPath);
  atomicWrite(tradesPath, tradesCsv(fullBaseline.trades));

  const paperConfig = {
    schemaVersion: 1,
    studyId,
    experimentSha256: experiment.experimentSha256,
    experimentPath: experiment.experimentPath,
    generatedAt: report.generatedAt,
    mode: 'PAPER_ONLY',
    liveExecutionAllowed: false,
    status: walkForward.promotionStatus,
    selectionOutcome: walkForward.selectionOutcome,
    selectedName: walkForward.selectionAudit.selectedName,
    config: walkForward.frozenConfig,
    promotionChecks: walkForward.promotionChecks,
    note: 'Validation output only. The live trading path does not read this file.',
  };
  atomicWrite(PAPER_CONFIG_PATH, safeJson(paperConfig) + '\n');

  console.log('');
  console.log('════════════════════════════════════════════════════');
  console.log(`Study:      ${studyId}`);
  console.log(`Decision:   ${walkForward.promotionStatus}`);
  console.log(`Selected:   ${walkForward.selectionAudit.selectedName}`);
  console.log(`Test trades:${walkForward.testResults.metrics.n}`);
  console.log(`Test win:   ${pct(walkForward.testResults.metrics.winRate)}`);
  console.log(`Test expect:${money(walkForward.testResults.metrics.netExpectancy)} after costs`);
  console.log(`Report:     ${path.relative(ROOT, latestReport)}`);
  console.log(`Replay:     ${experiment.replayCommand}`);
  console.log('Live orders: UNCHANGED');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[validator] FAILED: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildExperimentPayload,
  experimentIdentity,
  stopFreeDiagnosticIdentity,
  writeStopFreeDiagnosticArtifacts,
  parseArgs,
  safeJson,
};