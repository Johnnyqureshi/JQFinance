# ORB Trading Dashboard

## Overview

This is a Flask-based web application that implements an Opening Range Breakout (ORB) trading strategy using the Alpaca paper trading API. The dashboard allows users to select assets, configure take-profit percentages, and execute automated trades based on the first 15-minute candle after market open.

The application monitors for price breakouts above or below the opening range and places paper trades accordingly through Alpaca's trading API.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend Architecture
- **Framework**: Flask with Python
- **Database ORM**: Flask-SQLAlchemy with a custom DeclarativeBase
- **Database**: PostgreSQL (configured via DATABASE_URL environment variable)
- **Proxy Handling**: Werkzeug ProxyFix middleware for proper header forwarding

### Frontend Architecture
- **Templating**: Jinja2 templates served by Flask
- **Styling**: Cyberpunk theme with neon colors (cyan, magenta, pink, purple), animated glowing effects, and dark menacing aesthetic
- **JavaScript**: Vanilla JS for form handling and API interactions
- **Fonts**: Google Fonts (Orbitron for headings, Rajdhani for UI text)
- **Accessibility**: Respects prefers-reduced-motion for users who prefer less animation
- **Color Palette**: Neon cyan (#00ffff), magenta (#ff00ff), pink (#ff0080), purple (#8000ff), green (#00ff80), orange (#ff8000) on dark backgrounds (#0a0a0f)

### Design Patterns
- **MVC-style separation**: Models in `models.py`, routes in `app.py`, templates in `templates/`
- **Environment-based configuration**: API keys and database URLs stored as environment variables
- **Connection pooling**: SQLAlchemy configured with pool recycling and pre-ping for reliability

### Data Models
- **OrderRecord**: Stores trade records with symbol, direction, entry price, take profit price, status, strategy (orb/sma), and timestamp
- **OpenPosition**: Tracks active positions with persistent TP/SL targets for multi-day monitoring

### Trading Strategies
- **ORB (Opening Range Breakout)**: Trades breakouts above/below the first 15-minute candle after market open
  - Page: /dashboard
- **SMA Crossover Bot**: Trades any Alpaca-available symbol using 5/20 Simple Moving Average crossover detection
  - Page: /sma-bot (separate from ORB to avoid conflicts)
  - Supports all tradable US equities from Alpaca
  - Search/filter functionality for symbol selection
  - Only places orders on actual crossover events (not continuous trend signals)
  - Compares current vs previous SMA relationship to detect state changes
  - Endpoint: POST /api/run_sma_bot (requires symbols array)

### Position Monitoring
- **Background Scheduler**: APScheduler runs every 30 seconds during market hours (9:30 AM - 4:00 PM ET)
- **Persistent TP/SL**: Take-profit and stop-loss targets are stored in database, not in-memory
- **Cross-day Execution**: Positions are monitored across trading days until TP, SL, or manual close
- **Restart Recovery**: On app restart, all open positions are automatically resumed for monitoring
- **Trailing Stop Loss**: When enabled, automatically adjusts stop loss as price moves favorably (up for longs, down for shorts)
  - Tracks highest_price for BUY positions, lowest_price for SELL positions
  - SL only moves in favorable direction, never against position
  - Enabled by default via UI checkbox
- **Logging**: Comprehensive logging of trade entries, price checks, trailing stop updates, and exit reasons (orb.monitor logger)

### API Structure
- Form submissions handled via POST to Flask routes
- JSON responses for trade execution results
- Real-time status updates displayed on the frontend

## External Dependencies

### Alpaca Trading API
- **Paper Trading Base URL**: `https://paper-api.alpaca.markets`
- **Market Data URL**: `https://data.alpaca.markets/v2`
- **Authentication**: API key and secret passed via headers (APCA-API-KEY-ID, APCA-API-SECRET-KEY)
- **Required Environment Variables**:
  - `ALPACA_API_KEY`: Alpaca API key ID
  - `ALPACA_API_SECRET`: Alpaca API secret key

### Database
- PostgreSQL database connection via `DATABASE_URL` environment variable
- SQLAlchemy ORM for database operations

### Other Environment Variables
- `SESSION_SECRET`: Flask session secret key for security

### Python Dependencies
- Flask and Flask-SQLAlchemy for web framework and ORM
- requests for HTTP calls to Alpaca API
- pytz for timezone handling (Eastern Time for market hours)