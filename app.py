import os
import logging
import datetime
import pytz
import requests

from flask import Flask, render_template, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import DeclarativeBase
from werkzeug.middleware.proxy_fix import ProxyFix

logging.basicConfig(level=logging.DEBUG)

class Base(DeclarativeBase):
    pass

db = SQLAlchemy(model_class=Base)

app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET")
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_recycle": 300,
    "pool_pre_ping": True,
}

db.init_app(app)

ALPACA_BASE = "https://paper-api.alpaca.markets"
ALPACA_DATA = "https://data.alpaca.markets/v2"

def get_alpaca_headers():
    api_key = os.environ.get("ALPACA_API_KEY", "")
    api_secret = os.environ.get("ALPACA_API_SECRET", "")
    return {
        "APCA-API-KEY-ID": api_key,
        "APCA-API-SECRET-KEY": api_secret
    }

def check_api_connection():
    headers = get_alpaca_headers()
    if not headers["APCA-API-KEY-ID"] or not headers["APCA-API-SECRET-KEY"]:
        return False
    try:
        url = f"{ALPACA_BASE}/v2/account"
        r = requests.get(url, headers=headers, timeout=5)
        return r.status_code == 200
    except:
        return False

def get_assets():
    headers = get_alpaca_headers()
    if not headers["APCA-API-KEY-ID"] or not headers["APCA-API-SECRET-KEY"]:
        return []
    try:
        url = f"{ALPACA_BASE}/v2/assets"
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code == 200:
            assets = r.json()
            tradable = [a["symbol"] for a in assets if a.get("tradable", False)]
            priority_symbols = ["IONZ", "PLTZ", "SOXS"]
            for sym in priority_symbols:
                if sym not in tradable:
                    tradable.append(sym)
            return sorted(tradable)
        return []
    except Exception as e:
        logging.error(f"Error fetching assets: {e}")
        return []

def orb_trade(symbol, take_profit):
    headers = get_alpaca_headers()
    
    if not headers["APCA-API-KEY-ID"] or not headers["APCA-API-SECRET-KEY"]:
        return {"status": "ERROR", "message": "API keys not configured. Please add ALPACA_API_KEY and ALPACA_API_SECRET."}
    
    now = datetime.datetime.now(pytz.timezone("America/New_York"))
    market_open = now.replace(hour=9, minute=45, second=0, microsecond=0)

    if now < market_open:
        return {"status": "WAIT", "message": "ORB window has not started yet. Market opens at 9:30 AM ET, ORB analysis begins at 9:45 AM ET."}

    try:
        data_url = f"{ALPACA_DATA}/stocks/{symbol}/bars"
        params = {"timeframe": "15Min", "limit": 1}
        r = requests.get(data_url, headers=headers, params=params, timeout=10)

        if r.status_code != 200:
            return {"status": "ERROR", "message": f"Error loading market data: {r.text}"}

        data = r.json()
        bars = data.get("bars", [])
        
        if not bars:
            return {"status": "ERROR", "message": "No bar data available for this symbol."}

        bar = bars[0]
        high = bar["h"]
        low = bar["l"]

        last_url = f"{ALPACA_DATA}/stocks/{symbol}/trades/latest"
        lr = requests.get(last_url, headers=headers, timeout=10)
        
        if lr.status_code != 200:
            return {"status": "ERROR", "message": "Error fetching current price."}
            
        price = lr.json()["trade"]["p"]

        if price > high:
            direction = "BUY"
        elif price < low:
            direction = "SELL"
        else:
            return {
                "status": "NO_BREAKOUT", 
                "message": f"No breakout detected. Price ${price:.2f} is within the ORB range (${low:.2f} - ${high:.2f}).",
                "current_price": price,
                "orb_high": high,
                "orb_low": low
            }

        order_url = f"{ALPACA_BASE}/v2/orders"
        qty = 1

        order = {
            "symbol": symbol,
            "qty": qty,
            "side": direction.lower(),
            "type": "market",
            "time_in_force": "day"
        }

        orr = requests.post(order_url, json=order, headers=headers, timeout=10)

        if orr.status_code not in [200, 201]:
            return {"status": "ORDER_ERROR", "message": f"Trade failed: {orr.text}"}

        if direction == "BUY":
            tp_price = round(price * (1 + take_profit), 2)
        else:
            tp_price = round(price * (1 - take_profit), 2)

        tp_order = {
            "symbol": symbol,
            "qty": qty,
            "side": "sell" if direction == "BUY" else "buy",
            "type": "limit",
            "limit_price": tp_price,
            "time_in_force": "day"
        }

        tp_response = requests.post(order_url, json=tp_order, headers=headers, timeout=10)
        tp_placed = tp_response.status_code in [200, 201]
        
        if tp_placed:
            message = f"Successfully placed {direction} order for {symbol} at ${price:.2f} with take-profit at ${tp_price:.2f}"
        else:
            logging.warning(f"Take-profit order failed: {tp_response.text}")
            message = f"Entry order placed for {symbol} at ${price:.2f}, but take-profit order failed. Please set exit manually."

        return {
            "status": "TRADE_PLACED",
            "direction": direction,
            "symbol": symbol,
            "entry_price": price,
            "take_profit": tp_price,
            "take_profit_placed": tp_placed,
            "orb_high": high,
            "orb_low": low,
            "message": message
        }
        
    except requests.exceptions.Timeout:
        return {"status": "ERROR", "message": "Request timed out. Please try again."}
    except Exception as e:
        logging.error(f"ORB trade error: {e}")
        return {"status": "ERROR", "message": f"An error occurred: {str(e)}"}

@app.route("/")
def index():
    assets = get_assets()
    api_connected = check_api_connection()
    return render_template("index.html", assets=assets, api_connected=api_connected)

@app.route("/run_orb", methods=["POST"])
def run_orb():
    try:
        data = request.json
        symbol = data.get("symbol", "")
        take_profit = float(data.get("take_profit", 0.02))
        
        if not symbol:
            return jsonify({"status": "ERROR", "message": "Please select a symbol."})
        
        if take_profit <= 0 or take_profit > 1:
            return jsonify({"status": "ERROR", "message": "Take profit must be between 0% and 100%."})
            
        return jsonify(orb_trade(symbol, take_profit))
    except Exception as e:
        logging.error(f"Run ORB error: {e}")
        return jsonify({"status": "ERROR", "message": str(e)})

@app.route("/api/status")
def api_status():
    return jsonify({"connected": check_api_connection()})

with app.app_context():
    import models
    db.create_all()
