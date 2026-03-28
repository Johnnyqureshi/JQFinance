# StockPulse

## Overview

StockPulse is a real-time stock market dashboard inspired by TipRanks. Built with Node.js/Express backend and vanilla HTML/CSS/JS frontend.

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
- **Top nav bar**: Logo + tabs (Search, Markets, Watchlist, Trader) + market status + search input
- **Default page**: Search hero — large centered search bar, nothing shown until user types
- **Stock detail page**: Full-page view when a stock is selected, with 4 sub-tabs:
  - **Overview**: 6 stat boxes (Open, Prev Close, High, Low, Volume, VWAP) + intraday chart
  - **Chart**: Interactive chart with 2D/1M/3M/6M/1Y timeframes
  - **Analysts**: Consensus bar, price targets (Low/Median/High), recent rating changes
  - **News**: Recent news articles
- **Back button**: Returns to the page you came from (Search, Markets, or Watchlist)

### Pages
- **Search** (`default`): Hero with search bar + popular chip shortcuts. No data shown until searched.
- **Markets**: 4 sections (Indices, Top Movers, Tech Leaders, Finance) — loads on tab click
- **Watchlist**: Personal saved symbols stored in localStorage; click row to view stock detail
- **Trader**: Realtime analysis tool with RSI gauge, volume bars, day range, support/resistance

### Key UX Decisions
- **Search-first**: The landing page is always empty — no pre-loaded stock grids
- **No side panel**: Stock detail is a full-page view with tabs (not a slide-in panel)
- **Lazy data loading**: Markets and Watchlist only fetch data when their tab is opened
- **No auto-fetch on init**: Eliminates refresh crashes caused by startup API calls

## External Dependencies

### Financial Modeling Prep (FMP) — Prices, Ratings, News, Search
- **Base URL**: `https://financialmodelingprep.com/stable`
- **Required env var**: `FMP_API_KEY`
- **Free plan limit**: ~250 requests/day (rate limit errors appear as empty results)
- **Endpoints used**:
  - `/stable/quote?symbol=X` — single quote (price, volume, high/low, open, prev close)
  - `/stable/grades?symbol=X` — analyst grades & upgrades/downgrades
  - `/stable/price-target-consensus?symbol=X` — low/median/high price targets
  - `/stable/fmp-articles` — market news articles
  - `/stable/search-name?query=X` — symbol + company name search

### Yahoo Finance Chart API — Historical OHLCV (no key required)
- **Base URL**: `https://query1.finance.yahoo.com/v8/finance/chart`
- **Used for**: all bar/chart data — overview sparklines, chart tab, Realtime Trader history
- **Timeframe mapping**: `1Hour` → `interval=1h`, `1Day` → `interval=1d`

### API Endpoints (server.js)
- `GET /api/snapshots?symbols=A,B,C` — parallel FMP individual quotes (Alpaca snapshot shape)
- `GET /api/quote/:symbol` — single FMP quote (Alpaca snapshot shape)
- `GET /api/bars/:symbol?timeframe=&limit=` — Yahoo Finance OHLCV bars `{t,o,h,l,c,v}`
- `GET /api/historical/:symbol` — Yahoo Finance daily OHLCV, newest-first, for Realtime Trader
- `GET /api/news/:symbol` — FMP articles (filtered by ticker, falls back to general market news)
- `GET /api/search?q=...` — FMP name search filtered to US exchanges
- `GET /api/stock/:ticker` — FMP analyst ratings, price targets, upgrades/downgrades

## Available Environment Variables
- `FMP_API_KEY` — Financial Modeling Prep API key (primary data source)
- `AIML_API_KEY` — available, not currently used
- `SESSION_SECRET` — available, not currently used
