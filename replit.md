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

### Alpaca Trading API
- **Paper Trading**: `https://paper-api.alpaca.markets/v2`
- **Market Data**: `https://data.alpaca.markets/v2`
- **News**: `https://data.alpaca.markets/v1beta1/news`
- **Authentication**: APCA-API-KEY-ID, APCA-API-SECRET-KEY headers
- **Required env vars**: `ALPACA_API_KEY`, `ALPACA_API_SECRET`

### API Endpoints (server.js)
- `GET /api/snapshots?symbols=...` — batch price snapshots
- `GET /api/bars/:symbol?timeframe=&limit=` — OHLCV bar data
- `GET /api/quote/:symbol` — single symbol snapshot
- `GET /api/news/:symbol` — recent news articles
- `GET /api/search?q=...` — symbol/company name search

## Available Environment Variables
- `ALPACA_API_KEY` — Alpaca API key
- `ALPACA_API_SECRET` — Alpaca API secret
- `AIML_API_KEY` — (available, not currently used)
- `SESSION_SECRET` — (available, not currently used)
