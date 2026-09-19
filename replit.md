# Johnny Qureshi Finance

## Overview

Johnny Qureshi Finance is a real-time stock market dashboard with a fully automated Alpaca trading engine. Built with Node.js/Express backend and vanilla HTML/CSS/JS frontend.

### Automated trading boundary
- The only automated strategies are **LEAP Options** and **B2 Bot**.
- Momentum, PMH/Opening Momentum, Candlestick/UltraBot3, Swing, Money Printer, and older generic bots were removed. Do not restore them through old UI, handlers, schedulers, or migrations.
- Retirement deletes only local strategy records and credentials. Never cancel broker orders, reconcile retired accounts, or close broker positions as part of cleanup.
- Manual trading and Search/scanner research remain separate from automated execution.
- Each strategy requires a dedicated broker account, encrypted credentials, and account ownership checks. Never reuse manual credentials for a bot.
- Verified B2 Paper connection/selection starts automatically. Live connection/selection requires fresh explicit authorization to start. Do not auto-enable dormant accounts during startup/migration.
- Strategy rules are server-owned. Maximum position dollars is the only editable strategy parameter; enable/pause and live arming are authorization controls.

### B2 Bot
- `lib/b2-strategy.js`: completed-daily SMA20/SMA50 crossover, live price/RVOL/gain/liquidity and trend gates.
- `lib/b2-service.js`: dedicated broker credentials, persisted full Alpaca equity catalog rotation, order intents, reconciliation, and server scheduling.
- API prefix `/api/b2`; UI `public/js/b2.js` and `public/css/b2.css`.
- Live uses consolidated SIP data and blocks without entitlement. Paper prefers SIP but may switch to Alpaca IEX only after a SIP HTTP 403 and a valid fresh IEX quote probe; each evaluation uses one feed consistently.
- Long-only protected orders; 5% initial stop, persistent crossover reservations, and independent bearish-crossover exits.
- Server-managed fills and protection continue when new entries are paused.
- Position dollars is the only editable strategy setting; emergency pause/resume are separate authorization actions. Pausing revokes entries immediately without invalidating in-flight protective reconciliation.
- Every actual strategy evaluation validates consecutive completed sessions against the broker calendar. Full catalog scans rotate in batches; status reports the minimum cycles per pass, not simultaneous whole-market coverage.
- Automated B2 and LEAP entries remain fail-closed until the PostgreSQL repository/outbox cutover is complete. The development schema is `db/automated-trading-schema.sql`; Publish applies it to production, but the schema alone must never enable entries.
- Tests: `npm run test:b2` (mock brokers only; never place real orders to verify code). `npm run test:b2-ui` uses isolated Chromium against the running dev app with all B2 endpoints mocked.

## System Architecture

### Backend
- **Runtime**: Node.js
- **Framework**: Express
- **Port**: 5000
- **Entry point**: `server.js`

### Frontend
- **Approach**: Vanilla HTML/CSS/JS (no frameworks)
- **Files**: root `index.html`, `public/css/style.css`, `public/js/app.js`, feature-specific scripts under `public/js`
- **Fonts**: Inter (body), DM Mono (numbers/tickers), Cormorant Garamond (Trader headings)
- **Theme**: Dark navy (#0d1117) with gold (#f0b429) accents, green (#3fb950), red (#f85149)

### Layout (TipRanks-inspired)
- **Top nav bar**: Logo + tabs (Search, Markets, Watchlist, WSB Trending) + market status + search input
- **Default page (Search/Home)**: Compact search bar at top. Empty state until stock searched. When stock selected, shows full analysis workspace in-place.
- **Analysis workspace** (home page after stock selected):
  - **Stock header**: Ticker, company name, price, % change, watch button, optional back button
  - **Left panel (Trading Signals)**: RSI gauge (14-period), volume vs 10-day avg, day range position, day direction, support/resistance levels, 60s auto-refresh countdown
  - **Right panel (4 tabs)**:
    - **Overview**: 6 stat boxes + intraday chart + score panel
    - **Chart**: Interactive chart with multiple timeframes
    - **Analysts**: Consensus bar, price targets, rating changes
    - **News**: Recent news articles
- **Back button**: Appears only when navigating from Markets/Watchlist/WSB; returns to that page

### Pages
- **Search/Home** (`default`): Compact search bar at top; empty state shown by default. Selecting a stock shows the full analysis workspace (Trader signals + tabs) in-place. No separate stock page — all analysis lives here.
- **Markets**: Top Gainers/Losers + **Crypto Markets (24/7 live grid)** + **Market Events (economic calendar + earnings)** + WSB Trending — loads on tab click
- **WSB Trending**: Dedicated page — top 10 r/wallstreetbets tickers by 24h mentions. Shows rank, $TICKER, company name, mention count, upvote sentiment bar, 24h mention change (▲/▼), live price + % change. Auto-refreshes every 5 minutes with countdown timer.
- **Watchlist**: Personal saved symbols stored in localStorage; click row to view stock detail
- **Trading Signals panel**: Integrated into the Search/Home workspace (left sidebar) — RSI gauge, volume bars, day range position, day direction, support/resistance levels, 60s auto-refresh. Triggered automatically on stock search. No separate Trader page.

### Key UX Decisions
- **Search-first**: The landing page is always empty — no pre-loaded stock grids
- **No side panel**: Stock detail is a full-page view with tabs (not a slide-in panel)
- **Lazy data loading**: Markets and Watchlist only fetch data when their tab is opened
- **No auto-fetch on init**: Eliminates refresh crashes caused by startup API calls

## External Dependencies

### Yahoo Finance (Primary — no API key required)
- **Price/Quote data**: `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d`
  - Extracts: price, open, dayHigh, dayLow, volume, previousClose, change%, name
- **Search**: `https://query1.finance.yahoo.com/v1/finance/search?q=...`
- **Historical/Bars**: `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=...&range=...`
- **News fallback**: Yahoo search API news results

### Financial Modeling Prep (FMP) — Analyst Data Only
- **Base URL**: `https://financialmodelingprep.com/api/v3`
- **Required env var**: `FMP_API_KEY`
- **Free plan limit**: ~250 requests/day — app degrades gracefully when hit
- **Used only for**: analyst ratings, price targets, upgrades/downgrades, news (with Yahoo fallback)

### Research scanner (not automation)

**Setup 1 — Bounce 2.0** (`/api/bounce-signal`, `/api/bounce-scan`)
- EMA 8/21/34 + SMA 50 + Stochastic (8,3,3) pullback-to-trend entries

**Setup 2 — Volatility Expansion** (`/api/ve/*`)
- ATR(14) contraction ≥5 bars → BB(20,2) squeeze → volume surge ≥1.5x → breakout close

**Setup 3 — Explosive Earnings** (`/api/ee/*`)
- EPS surprise ≥15% + Revenue growth ≥25% YoY + gap up ≥5% on earnings day + volume ≥2x
- Post-gap entry: ENTRY_ZONE (close above prev bar high within 2% of 10 EMA) or SHAKEOUT_ENTRY
- SL = 3% below entry; TP = 9% (3:1 R/R); research signals only
- Data: Yahoo Finance `earningsHistory` + `incomeStatementHistory` (FMP if valid key)
- Earnings date detection: FMP exact date → volume spike heuristic in 5–75 days after fiscal quarter end

**Setup 4 — Countertrend Setups** (`/api/ct/*`)
- RSI(14) ≥70 (short) or ≤30 (long) + price within 1% of major S/R (tested ≥2× in 6 months)
- Reversal confirmation: bearish/bullish engulfing candle OR RSI divergence (price makes new extreme, RSI doesn't)
- 2618 Setup: trendline break + price retests broken trendline + closes in reversal direction → "2618 RETEST ENTRY"
- Signals: COUNTERTREND SHORT SETUP / COUNTERTREND LONG SETUP / 2618 RETEST ENTRY
- SL = 1.5% from entry (or 1 tick outside swing high/low, whichever is wider)
- TP = nearest S/R or key MA (SMA50/SMA200); minimum 2:1 R/R enforced
- Position sizing and leverage: user-configurable in UI (manual per user spec)

### API Endpoints (server.js)
- `GET /api/snapshots?symbols=A,B,C` — Yahoo Finance parallel chart quotes
- `GET /api/quote/:symbol` — Yahoo Finance single chart quote
- `GET /api/bars/:symbol?timeframe=&limit=` — Yahoo Finance OHLCV bars `{t,o,h,l,c,v}`
- `GET /api/historical/:symbol` — Yahoo Finance daily OHLCV, newest-first, for Realtime Trader
- `GET /api/search?q=...` — Yahoo Finance search (equity symbols, US exchanges)
- `GET /api/news/:symbol` — NewsAPI.org primary (20 articles w/ images + summaries), FMP fallback, Yahoo fallback
- `GET /api/stock/:ticker` — FMP analyst ratings, price targets, upgrades/downgrades (graceful empty on rate limit)
- `GET /api/ee/signal/:symbol` — Explosive Earnings signal for single symbol
- `GET /api/ee/scan?symbols=...` — Explosive Earnings scan (default: recent earnings universe)

## Available Environment Variables
- `FMP_API_KEY` — Financial Modeling Prep (analyst ratings, price targets, upgrades)
- `NEWSAPI_KEY` — NewsAPI.org (primary news source — 20 articles with images/summaries)
- `AIML_API_KEY` — Search intelligence
- `SESSION_SECRET` — session signing and broker credential encryption; never change without a credential migration
