# StockPulse

## Overview

StockPulse is a real-time stock market dashboard with a TikTok-inspired layout. Built with Node.js/Express backend and vanilla HTML/CSS/JS frontend.

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
- **Files**: `public/index.html`, `public/css/style.css`, `public/js/app.js`
- **Fonts**: Google Fonts — Inter (body), Playfair Display (headings)
- **Theme**: Dark black (#0a0a0a, #111111) backgrounds with gold (#FFD700, #B8860B) accents

### Layout (TikTok-inspired)
- **Left sidebar**: Navigation — Feed, Markets, Watchlist, Search + market status indicator
- **Main area**: Full-height scrollable page content with topbar search
- **Right panel**: Stock detail panel — price, chart, stats, news, actions

### Pages
- **Feed** (`/`): Grid of stock cards with mini sparkline charts
- **Markets**: 4 sections — Indices, Top Movers, Tech Leaders, Finance
- **Watchlist**: Personalized list stored in localStorage; add/remove symbols
- **Search**: Full symbol + company name search via Alpaca assets API

### Features
- Live stock data from Alpaca paper trading API (snapshots, bars, news)
- Mini sparkline charts on each stock card (hourly data)
- Full line chart in detail panel and modal (1M/3M/6M/1Y/3D timeframes)
- Live ticker strip in topbar showing key indices
- Market open/closed indicator (Eastern Time)
- Persistent watchlist via localStorage
- Responsive design — sidebar collapses on mobile

## External Dependencies

### Financial Modeling Prep (FMP) — Prices, Ratings, News, Search
- **Base URL**: `https://financialmodelingprep.com/stable`
- **Required env var**: `FMP_API_KEY`
- **Endpoints used**:
  - `/stable/quote?symbol=X` — single quote (price, volume, high/low, open, prev close)
  - `/stable/grades?symbol=X` — analyst grades & upgrades/downgrades
  - `/stable/price-target-consensus?symbol=X` — low/median/high price targets
  - `/stable/fmp-articles` — market news articles
  - `/stable/search-name?query=X` — symbol + company name search
- **Note**: FMP free plan does not support batch (`symbol=A,B,C`) quote queries; snapshots fetch each symbol individually in parallel

### Yahoo Finance Chart API — Historical OHLCV (no key required)
- **Base URL**: `https://query1.finance.yahoo.com/v8/finance/chart`
- **Used for**: all bar/chart data — sparklines, panel charts, modal charts, Realtime Trader history
- **Timeframe mapping**: `1Hour` → `interval=1h`, `1Day` → `interval=1d`; range auto-derived from `limit`

### API Endpoints (server.js)
- `GET /api/snapshots?symbols=A,B,C` — parallel FMP individual quotes (Alpaca snapshot shape)
- `GET /api/quote/:symbol` — single FMP quote (Alpaca snapshot shape)
- `GET /api/bars/:symbol?timeframe=&limit=` — Yahoo Finance OHLCV bars (Alpaca bar shape `{t,o,h,l,c,v}`)
- `GET /api/historical/:symbol` — Yahoo Finance daily OHLCV, newest-first, for Realtime Trader
- `GET /api/news/:symbol` — FMP articles (filtered by ticker, falls back to general market news)
- `GET /api/search?q=...` — FMP name search filtered to US exchanges (NASDAQ, NYSE, AMEX, etc.)
- `GET /api/stock/:ticker` — FMP analyst ratings, price targets, upgrades/downgrades

## Available Environment Variables
- `FMP_API_KEY` — Financial Modeling Prep API key (primary data source)
- `AIML_API_KEY` — (available, not currently used)
- `SESSION_SECRET` — (available, not currently used)
