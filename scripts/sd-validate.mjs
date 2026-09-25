// Singles & Doubles historical validation (BACKTEST ONLY — simulated, never real trades).
//
// Reads Alpaca paper credentials ONLY from APCA_API_KEY_ID / APCA_API_SECRET_KEY.
// Pulls recent 1Min intraday bars for ~20 liquid $5-$50 symbols over the last
// ~5 sessions, runs the real evaluateSd() per symbol/session, then prints the
// rejection funnel and a hypothetical outcome simulation (signal at 15:00 ET,
// exits at stop / single (+1%) / double (+2%) / EOD).
//
// EVERY output line is labeled BACKTEST (simulated, not real trades).
// Numbers are computed from real Alpaca data only; nothing is fabricated.
// Any API error is reported honestly and the script exits non-zero.

import { evaluateSd, classifySpyRegime, SD_RULES } from '../lib/sd-strategy.js';

const LABEL = 'BACKTEST (simulated, not real trades)';
const log = (...parts) => console.log(LABEL, ...parts);

const KEY = process.env.APCA_API_KEY_ID;
const SECRET = process.env.APCA_API_SECRET_KEY;
if (!KEY || !SECRET) {
  console.log('INSUFFICIENT HISTORICAL DATA: set APCA_API_KEY_ID/APCA_API_SECRET_KEY to run validation');
  process.exit(2);
}

const TRADE = 'https://paper-api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const HEADERS = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };

async function api(url) {
  let response;
  try {
    response = await fetch(url, { headers: HEADERS });
  } catch (error) {
    throw new Error(`Network request failed for ${new URL(url).pathname}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Alpaca API error: ${new URL(url).pathname} returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Alpaca API returned malformed JSON for ${new URL(url).pathname}.`);
  }
}

const etDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const etMinutes = value => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = type => Number(parts.find(p => p.type === type)?.value);
  return get('hour') * 60 + get('minute');
};

async function pagedBars(symbols, timeframe, start, end) {
  const out = Object.fromEntries(symbols.map(s => [s, []]));
  let page = null;
  for (let i = 0; i < 25; i += 1) {
    const query = new URLSearchParams({ symbols: symbols.join(','), timeframe, start, end, limit: '10000', adjustment: 'all', feed: 'iex', sort: 'asc' });
    if (page) query.set('page_token', page);
    const data = await api(`${DATA}/v2/stocks/bars?${query}`);
    if (!data || typeof data.bars !== 'object') throw new Error('Alpaca bars response was malformed.');
    for (const s of symbols) {
      if (data.bars[s] !== undefined && !Array.isArray(data.bars[s])) throw new Error(`Alpaca bars for ${s} were malformed.`);
      out[s].push(...(data.bars[s] || []));
    }
    page = data.next_page_token;
    if (!page) return out;
  }
  throw new Error('Alpaca bar pagination exceeded its safety bound.');
}

function typicalVwap(bars) {
  let pv = 0; let v = 0;
  for (const b of bars) {
    if (!(b.v > 0)) continue;
    pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v;
  }
  return v > 0 ? pv / v : null;
}

// Hypothetical outcome: entry at the signal bar close; per forward bar check
// stop first (conservative), then double, then single. After a single, the
// stop moves to breakeven (matching the strategy's runner rule).
function simulateOutcome({ entry, stop, single, double, forwardBars }) {
  let singleHit = false;
  let live = stop;
  for (const bar of forwardBars) {
    if (bar.l <= live) {
      return singleHit
        ? { outcome: 'stop_after_single', pnl: 0.5 * (single - entry) }
        : { outcome: 'stop', pnl: live - entry };
    }
    if (bar.h >= double) {
      return singleHit
        ? { outcome: 'double', pnl: 0.5 * (single - entry) + 0.5 * (double - entry) }
        : { outcome: 'double', pnl: double - entry };
    }
    if (!singleHit && bar.h >= single) { singleHit = true; live = entry; }
  }
  const eod = forwardBars.length ? forwardBars[forwardBars.length - 1].c : entry;
  return singleHit
    ? { outcome: 'single_only', pnl: 0.5 * (single - entry) + 0.5 * (eod - entry) }
    : { outcome: 'eod_flat', pnl: eod - entry };
}

async function main() {
  // 1. Universe: active tradable US equities -> snapshots -> $5-$50 filter.
  const assets = await api(`${TRADE}/v2/assets?status=active&asset_class=us_equity`);
  if (!Array.isArray(assets) || assets.length === 0) throw new Error('Alpaca asset universe was empty.');
  const candidates = assets
    .filter(a => a?.tradable === true && a?.status === 'active' && a?.class === 'us_equity' && /^[A-Z]{1,5}$/.test(a.symbol || ''))
    .slice(0, 80)
    .map(a => a.symbol);
  if (candidates.length === 0) throw new Error('No tradable equity candidates found.');
  const snapshots = await api(`${DATA}/v2/stocks/snapshots?${new URLSearchParams({ symbols: candidates.join(','), feed: 'iex' })}`);
  const picked = [];
  const spreads = {};
  for (const symbol of candidates) {
    const snap = snapshots?.[symbol];
    const price = Number(snap?.latestTrade?.p) || Number(snap?.dailyBar?.c);
    const bid = Number(snap?.latestQuote?.bp);
    const ask = Number(snap?.latestQuote?.ap);
    if (!(price >= SD_RULES.minPrice && price <= SD_RULES.maxPrice)) continue;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid) {
      spreads[symbol] = ((ask - bid) / ((ask + bid) / 2)) * 100;
    }
    picked.push(symbol);
    if (picked.length >= 20) break;
  }
  if (picked.length < 5) {
    throw new Error(`Only ${picked.length} liquid $${SD_RULES.minPrice}-$${SD_RULES.maxPrice} symbols found; need at least 5 for a meaningful sample.`);
  }

  // 2. Bars: 1Min for signals + SPY regime, 1Day for volume baselines.
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 10 * 86400000).toISOString();
  const symbols = [...picked, 'SPY'];
  const [minuteBars, dailyBars] = await Promise.all([
    pagedBars(symbols, '1Min', start, end),
    pagedBars(symbols, '1Day', new Date(Date.now() - 75 * 86400000).toISOString().slice(0, 10), end.slice(0, 10)),
  ]);

  // 3. Sessions: last 5 ET dates present in the SPY 1Min data.
  const spySessions = {};
  for (const bar of minuteBars.SPY) (spySessions[etDate(bar.t)] ||= []).push(bar);
  const sessions = Object.keys(spySessions).sort().slice(-5);
  if (sessions.length === 0) throw new Error('No recent SPY sessions returned; market data may be unavailable.');

  const spyDaily = (dailyBars.SPY || []).filter(b => b.v > 0);
  const spyPrevClose = {};
  for (let i = 1; i < spyDaily.length; i += 1) spyPrevClose[etDate(spyDaily[i].t)] = spyDaily[i - 1].c;

  const funnel = { evaluations: 0, eligible: 0, gates: {}, rejections: {} };
  const outcomes = [];
  let skipped = 0;

  for (const session of sessions) {
    const spyBars = spySessions[session];
    const spyLast = spyBars[spyBars.length - 1].c;
    const prevClose = Number(spyPrevClose[session]);
    const regime = classifySpyRegime({
      spyDayChangePct: Number.isFinite(prevClose) && prevClose > 0 ? (spyLast / prevClose - 1) * 100 : NaN,
      spyAboveVwap: (() => { const v = typicalVwap(spyBars); return v != null && spyLast > v; })(),
    });

    for (const symbol of picked) {
      const bars = (minuteBars[symbol] || []).filter(b => etDate(b.t) === session);
      const signalBars = bars.filter(b => etMinutes(b.t) < 15 * 60);
      const forwardBars = bars.filter(b => etMinutes(b.t) >= 15 * 60);
      if (signalBars.length < 60 || forwardBars.length < 5) { skipped += 1; continue; }

      const sessionVolume = signalBars.reduce((s, b) => s + b.v, 0);
      const daily = (dailyBars[symbol] || []).filter(b => b.v > 0).slice(-21, -1);
      const avgDollarVol = daily.length
        ? daily.reduce((s, b) => s + b.c * b.v, 0) / daily.length : NaN;
      const entry = signalBars[signalBars.length - 1].c;

      const result = evaluateSd({
        intradayBars: signalBars,
        dailyBars: dailyBars[symbol] || [],
        snapshot: { symbol, volume: sessionVolume, ask: entry, bid: entry },
        spyRegime: regime,
        spreadPct: Number.isFinite(spreads[symbol]) ? spreads[symbol] : NaN,
        avgDollarVol,
        minScore: SD_RULES.minScore,
        settings: {},
      });

      funnel.evaluations += 1;
      for (const gate of result.gates || []) {
        funnel.gates[gate.name] ||= { passed: 0, total: 0 };
        funnel.gates[gate.name].total += 1;
        if (gate.passed) funnel.gates[gate.name].passed += 1;
      }
      if (!result.eligible) {
        const failed = (result.gates || []).find(g => !g.passed);
        const stage = failed?.name || 'unknown';
        funnel.rejections[stage] = (funnel.rejections[stage] || 0) + 1;
        continue;
      }
      funnel.eligible += 1;
      if (!(result.stopPrice > 0) || !(result.singleTarget > entry) || !(result.doubleTarget > result.singleTarget)) {
        skipped += 1;
        continue;
      }
      outcomes.push({
        symbol, session, setup: result.setup, score: result.score,
        ...simulateOutcome({ entry, stop: result.stopPrice, single: result.singleTarget, double: result.doubleTarget, forwardBars }),
      });
    }
  }

  // 4. Report. Every line is labeled; every number is computed above.
  log('Singles & Doubles historical validation');
  log(`Universe: ${picked.length} symbols ($${SD_RULES.minPrice}-$${SD_RULES.maxPrice}): ${picked.join(', ')}`);
  log(`Sessions: ${sessions.join(', ')} (1Min bars, iex feed, signal at 15:00 ET, exits at stop/single/double/EOD)`);
  log('Note: spread uses each symbol\'s latest quote as a proxy; outcomes are hypothetical per-share simulations.');
  log(`Evaluations: ${funnel.evaluations} (skipped ${skipped} thin sessions)`);
  for (const name of ['price_band', 'liquidity', 'spread', 'momentum', 'vwap', 'quality_score', 'risk']) {
    const g = funnel.gates[name] || { passed: 0, total: 0 };
    log(`Funnel ${name}: ${g.passed}/${g.total} passed`);
  }
  const rej = Object.entries(funnel.rejections).sort((a, b) => b[1] - a[1])
    .map(([stage, n]) => `${stage}=${n}`).join(', ') || 'none';
  log(`Rejections by first failed gate: ${rej}`);
  log(`Eligible BUY signals: ${funnel.eligible}`);
  const wins = outcomes.filter(o => o.pnl > 0).length;
  const total = outcomes.reduce((s, o) => s + o.pnl, 0);
  const byOutcome = {};
  for (const o of outcomes) byOutcome[o.outcome] = (byOutcome[o.outcome] || 0) + 1;
  log(`Hypothetical signals simulated: ${outcomes.length}`);
  log(`Hypothetical outcomes: ${Object.entries(byOutcome).map(([k, n]) => `${k}=${n}`).join(', ') || 'none'}`);
  log(`Hypothetical per-share P&L: total ${total >= 0 ? '+' : ''}$${total.toFixed(2)}, avg ${outcomes.length ? `${total / outcomes.length >= 0 ? '+' : ''}$${(total / outcomes.length).toFixed(2)}` : 'n/a'}/signal, win rate ${outcomes.length ? `${((wins / outcomes.length) * 100).toFixed(1)}%` : 'n/a'}`);
}

main().catch(error => {
  console.error(LABEL, 'ERROR:', error.message);
  process.exit(1);
});
