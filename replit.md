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
- **Styling**: Custom CSS with CSS variables for theming (dark financial dashboard theme)
- **JavaScript**: Vanilla JS for form handling and API interactions
- **Fonts**: Google Fonts (Inter for UI, IBM Plex Mono for numerical data)

### Design Patterns
- **MVC-style separation**: Models in `models.py`, routes in `app.py`, templates in `templates/`
- **Environment-based configuration**: API keys and database URLs stored as environment variables
- **Connection pooling**: SQLAlchemy configured with pool recycling and pre-ping for reliability

### Data Models
- **Trade**: Stores trade records with symbol, direction, entry price, take profit price, status, and timestamp

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