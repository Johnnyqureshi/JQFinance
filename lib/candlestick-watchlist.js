'use strict';

const CANDLESTICK_CORE_SYMBOLS = [
  'AAPL','AMD','COIN','HOOD','IONQ','MARA','MSFT','NVDA','PLTR','QQQ','SMCI','SOFI','SPY','TSLA',
];

// Preserve UltraBot3's existing supplemental coverage without changing the
// shared Momentum/PMH screenshot universe.
const CANDLESTICK_LEGACY_SYMBOLS = [
  'OKLL','SKHL','AVS','SPCH','SNDC','MSTZ','RGTZ','RAM','APRE','CDTG',
  'INTW','HODU','TSLG','PATX','MUU','SNXX','SKHX','GLL','TSXD','TSLZ',
  'NVDQ','TSDD','CORD','DAMD','PLTD','SMCZ','QQQD','ORCZ','NVD',
  'ORCU','SOFX','KEEL','CIFG','AFRU','IRE','AMAU','NVDL','SMCX','PLTG','ADBG',
  'NOWL','VYX','UECG','NUVB','NVDY','TSLL','SATL','USAS','EXK','MTA',
  'BTG','DNN','CRML','TMQ','ASM','PLG','IAUX',
];

// Symbols transcribed from the nine user-provided UltraBot3 screenshots.
const ULTRABOT_SCREENSHOT_SYMBOLS = [
  'SOUN','UUUU','SMR','ONDS','BBAI','BDC','RCAT','UMAC','RR','SERV',
  'CDTG','USAS','EXK','MTA','BTG','DNN','CRML','TMQ','ASM',
  'SOC','CRAK','BORR','XLE','PBR','NAT','GLND','RIG','EGY',
  'NVDY','TSLL','SATL','RDWU','BABO','KMLI','NVDG',
  'SMCX','SMCL','PLTG','MULL','ADBG','OKLL','NOWL','VYX','UECG','NUVB',
  'SNXX','SKHX','SPCH','ORCU','SOFX','KEEL','CIFG','AFRU','IRE',
  'CRMG','NVTX','INTW','HODU','SKHL','SNDC','TSLG','PATX','MUU',
  'ORCZ','NVD','GLL','ERY','TSXD','TSLZ','NVDQ','TSDD',
  'MSTZ','CORD','DAMD','RGTZ','PLTD','SMCZ','AVS','QQQD',
];

const CANDLESTICK_WATCHLIST = [...new Set([
  ...CANDLESTICK_CORE_SYMBOLS,
  ...CANDLESTICK_LEGACY_SYMBOLS,
  ...ULTRABOT_SCREENSHOT_SYMBOLS,
])];

/**
 * Return a stable, non-overlapping batch and advance that user's cursor.
 * The cursor is intentionally in-memory: restarting the server starts a new
 * full coverage pass but never changes symbol order or drops symbols.
 */
function nextCandlestickWatchlistBatch(watchlist, state, key, limit) {
  const symbols = [...new Set(Array.isArray(watchlist) ? watchlist : [])];
  const batchSize = Math.max(1, Math.min(30, Math.floor(Number(limit) || 16)));
  if (!symbols.length) return { symbols: [], batch: 0, totalBatches: 0, offset: 0 };
  const priorOffset = Number(state.get(key) || 0) % symbols.length;
  // Do not wrap inside the final partial batch: wrapping there would repeat
  // the first symbols before every ticker had been evaluated once.
  const count = Math.min(batchSize, symbols.length - priorOffset);
  const batchSymbols = symbols.slice(priorOffset, priorOffset + count);
  const nextOffset = (priorOffset + count) % symbols.length;
  state.set(key, nextOffset);
  return {
    symbols: batchSymbols,
    batch: Math.floor(priorOffset / batchSize) + 1,
    totalBatches: Math.ceil(symbols.length / batchSize),
    offset: priorOffset,
  };
}

module.exports = {
  CANDLESTICK_WATCHLIST,
  ULTRABOT_SCREENSHOT_SYMBOLS,
  nextCandlestickWatchlistBatch,
};