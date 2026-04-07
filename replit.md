# Johnny Qureshi Finance

## Overview

Johnny Qureshi Finance is a real-time stock market dashboard inspired by TipRanks. Built with Node.js/Express backend and vanilla HTML/CSS/JS frontend.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend
- **Runtime**: Node.js 20
- **Framework**: Express
- **Port**: 5000
- **Entry point**: `server.js`

### Frontend
- **Approach**: Vanilla HTML/CSS/JS (no frameworks)
- **Files**: `public/index.html`, `public/css/style.css`, `public/js/app.js`, `public/js/trader.js`
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

### API Endpoints (server.js)
- `GET /api/snapshots?symbols=A,B,C` — Yahoo Finance parallel chart quotes
- `GET /api/quote/:symbol` — Yahoo Finance single chart quote
- `GET /api/bars/:symbol?timeframe=&limit=` — Yahoo Finance OHLCV bars `{t,o,h,l,c,v}`
- `GET /api/historical/:symbol` — Yahoo Finance daily OHLCV, newest-first, for Realtime Trader
- `GET /api/search?q=...` — Yahoo Finance search (equity symbols, US exchanges)
- `GET /api/news/:symbol` — NewsAPI.org primary (20 articles w/ images + summaries), FMP fallback, Yahoo fallback
- `GET /api/stock/:ticker` — FMP analyst ratings, price targets, upgrades/downgrades (graceful empty on rate limit)

## Available Environment Variables
- `FMP_API_KEY` — Financial Modeling Prep (analyst ratings, price targets, upgrades)
- `NEWSAPI_KEY` — NewsAPI.org (primary news source — 20 articles with images/summaries)
- `AIML_API_KEY` — available, not currently used
- `SESSION_SECRET` — available, not currently used
