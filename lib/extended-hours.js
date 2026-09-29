'use strict';

// Extended-hours (pre-market / after-hours) price resolution for Qureshi Finance.
//
// Yahoo Finance keeps reporting the last session's after-hours price through the
// weekend and on holidays, but with marketState 'CLOSED'. The quote normaliser
// used to drop it in that state, so the quote header showed no AH line on
// Saturdays and Sundays even though the data was right there. This module is
// the single place that decides what counts as an extended-hours price.
//
// Input:  { marketState, regularMarketPrice, postMarketPrice, preMarketPrice }
// Output: { extendedPrice, extendedType } — extendedType is 'AH', 'PRE', or null.

function resolveExtendedHours(q = {}) {
  const marketState = q.marketState || 'CLOSED';
  const isPost = ['POST', 'POSTPOST'].includes(marketState);
  const isPre  = ['PRE',  'PREPRE' ].includes(marketState);
  const regPrice = q.regularMarketPrice ?? null;

  let extendedPrice = null;
  let extendedType  = null;

  if (isPost) {
    extendedPrice = q.postMarketPrice ?? null;
    extendedType  = extendedPrice != null ? 'AH' : null;
  } else if (isPre) {
    if (q.preMarketPrice != null) {
      extendedPrice = q.preMarketPrice;
      extendedType  = 'PRE';
    } else if (q.postMarketPrice != null) {
      // PREPRE window — no pre-market trading yet; show last AH price
      extendedPrice = q.postMarketPrice;
      extendedType  = 'AH';
    }
  } else if (
    marketState === 'CLOSED' &&
    q.postMarketPrice != null &&
    regPrice != null &&
    q.postMarketPrice !== regPrice
  ) {
    // Weekend/holiday: Yahoo still reports the last session's after-hours
    // price with marketState CLOSED. Surface it only when it actually moved,
    // so a flat "AH $771.35 +$0.00" line never renders as noise.
    // NOTE: when the overnight (24h) market is live, the caller prefers
    // deriveOvernightPrice() below — a live-derived price beats Friday's AH.
    extendedPrice = q.postMarketPrice;
    extendedType  = 'AH';
  }

  return { extendedPrice, extendedType };
}

// ── Overnight (24-hour market) pricing ───────────────────────────────────────
// On Sunday evenings and weeknights the equity market is closed but index
// futures (and Robinhood's 24 Hour Market) trade live. Friday's AH close goes
// stale fast — e.g. SPY AH $772.04 Friday vs $768.67 overnight Sunday — so for
// the index ETFs we derive a live overnight price from their futures:
//
//   implied = etfClose × (futureLive / futureAnchor)
//
// where futureAnchor is the future's 16:00 ET bar on the ETF's last close day.
// The ratio anchors both legs at the same moment, so only the overnight move
// flows through; carry/basis drift over a weekend is ~0.02%.

const OVERNIGHT_FUTURES = {
  SPY: 'ES=F',   // S&P 500
  QQQ: 'NQ=F',   // Nasdaq 100
  DIA: 'YM=F',   // Dow Jones
  IWM: 'RTY=F',  // Russell 2000
};

function etWallClock(d = new Date()) {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return {
    day: et.getDay(), // 0=Sun 6=Sat
    mins: et.getHours() * 60 + et.getMinutes(),
    ymd: `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`,
  };
}

// True when index futures are live while equities are closed:
// Sunday from 6pm ET, all of Mon–Thu, Friday before 5pm ET.
function isOvernightWindow(d = new Date()) {
  const { day, mins } = etWallClock(d);
  if (day === 0) return mins >= 1080;   // Sunday 18:00 ET
  if (day >= 1 && day <= 4) return true;
  if (day === 5) return mins < 1020;    // Friday 17:00 ET
  return false;                         // Saturday
}

// Most recent weekday whose 16:00 ET close anchors the futures/ETF ratio.
// Sunday/Saturday → Friday; Mon–Fri → same day (the bar search falls back to
// the latest available bar, which covers holidays).
function overnightAnchorYmd(d = new Date()) {
  const { day, ymd } = etWallClock(d);
  if (day === 0 || day === 6) {
    const dt = new Date(d.getTime() - (day === 0 ? 2 : 1) * 86400000);
    return etWallClock(dt).ymd;
  }
  return ymd;
}

function deriveOvernightPrice({ futureLive, futureAnchor, etfClose }) {
  if (futureLive == null || futureAnchor == null || etfClose == null) return null;
  if (!(futureAnchor > 0)) return null;
  return etfClose * (futureLive / futureAnchor);
}

module.exports = {
  resolveExtendedHours,
  OVERNIGHT_FUTURES,
  etWallClock,
  isOvernightWindow,
  overnightAnchorYmd,
  deriveOvernightPrice,
};
