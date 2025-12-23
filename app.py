import os
import logging
import datetime
import pytz
import requests

from flask import Flask, render_template, request, jsonify, redirect, url_for, flash
from flask_login import LoginManager, login_required, current_user
from werkzeug.middleware.proxy_fix import ProxyFix
from extensions import db

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

orb_logger = logging.getLogger("orb.monitor")
orb_logger.setLevel(logging.INFO)
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
orb_logger.addHandler(handler)

app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET")
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["REMEMBER_COOKIE_SAMESITE"] = "Lax"
app.config["REMEMBER_COOKIE_SECURE"] = True

app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_recycle": 300,
    "pool_pre_ping": True,
}

db.init_app(app)

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "auth.login"

from auth import auth_bp
app.register_blueprint(auth_bp)

from monitoring import position_monitor
position_monitor.init_app(app)

ALPACA_BASE = "https://paper-api.alpaca.markets"
ALPACA_DATA = "https://data.alpaca.markets/v2"

@login_manager.user_loader
def load_user(user_id):
    from models import User
    return User.query.get(int(user_id))

def get_alpaca_headers(account=None):
    if account:
        return {
            "APCA-API-KEY-ID": account.api_key,
            "APCA-API-SECRET-KEY": account.api_secret
        }
    api_key = os.environ.get("ALPACA_API_KEY", "")
    api_secret = os.environ.get("ALPACA_API_SECRET", "")
    return {
        "APCA-API-KEY-ID": api_key,
        "APCA-API-SECRET-KEY": api_secret
    }

def check_api_connection(account=None):
    headers = get_alpaca_headers(account)
    if not headers["APCA-API-KEY-ID"] or not headers["APCA-API-SECRET-KEY"]:
        return False
    try:
        url = f"{ALPACA_BASE}/v2/account"
        r = requests.get(url, headers=headers, timeout=5)
        return r.status_code == 200
    except:
        return False

def fetch_account_balance(account):
    headers = get_alpaca_headers(account)
    if not headers["APCA-API-KEY-ID"] or not headers["APCA-API-SECRET-KEY"]:
        return None
    try:
        base_url = "https://paper-api.alpaca.markets" if account.is_paper else "https://api.alpaca.markets"
        url = f"{base_url}/v2/account"
        r = requests.get(url, headers=headers, timeout=5)
        if r.status_code == 200:
            data = r.json()
            return {
                "equity": float(data.get("equity", 0)),
                "cash": float(data.get("cash", 0)),
                "buying_power": float(data.get("buying_power", 0))
            }
        return None
    except:
        return None

def get_assets(account=None):
    headers = get_alpaca_headers(account)
    if not headers["APCA-API-KEY-ID"] or not headers["APCA-API-SECRET-KEY"]:
        priority_symbols = ["IONZ", "PLTZ", "SOXS", "TZA", "MSTZ", "FNGD", "RR", "EXK", "ASM", "LAC", "NVTS", "UVIX", "PLG", "AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "SPY", "QQQ"]
        return sorted(priority_symbols)
    try:
        base_url = ALPACA_BASE
        if account and not account.is_paper:
            base_url = "https://api.alpaca.markets"
        url = f"{base_url}/v2/assets"
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code == 200:
            assets = r.json()
            tradable = [a["symbol"] for a in assets if a.get("tradable", False)]
            priority_symbols = ["IONZ", "PLTZ", "SOXS", "TZA", "MSTZ", "FNGD", "RR", "EXK", "ASM", "LAC", "NVTS", "UVIX", "PLG"]
            for sym in priority_symbols:
                if sym not in tradable:
                    tradable.append(sym)
            return sorted(tradable)
        priority_symbols = ["IONZ", "PLTZ", "SOXS", "TZA", "MSTZ", "FNGD", "RR", "EXK", "ASM", "LAC", "NVTS", "UVIX", "PLG", "AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "SPY", "QQQ"]
        return sorted(priority_symbols)
    except Exception as e:
        logging.error(f"Error fetching assets: {e}")
        priority_symbols = ["IONZ", "PLTZ", "SOXS", "TZA", "MSTZ", "FNGD", "RR", "EXK", "ASM", "LAC", "NVTS", "UVIX", "PLG", "AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "SPY", "QQQ"]
        return sorted(priority_symbols)

def orb_trade(symbol, take_profit, account=None, user_id=None):
    from models import OrderRecord
    headers = get_alpaca_headers(account)
    
    if not headers["APCA-API-KEY-ID"] or not headers["APCA-API-SECRET-KEY"]:
        return {"status": "ERROR", "message": "API keys not configured."}
    
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

        alpaca_order_id = orr.json().get("id", "")

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
        
        if user_id:
            order_record = OrderRecord(
                user_id=user_id,
                symbol=symbol,
                side=direction.lower(),
                qty=qty,
                entry_price=price,
                tp_price=tp_price,
                alpaca_order_id=alpaca_order_id,
                status="placed" if tp_placed else "tp_failed"
            )
            db.session.add(order_record)
            db.session.commit()
        
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
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    return render_template("index.html")

@app.route("/dashboard")
@login_required
def dashboard():
    from models import AlpacaAccount, OrderRecord
    accounts = AlpacaAccount.query.filter_by(user_id=current_user.id).all()
    orders = OrderRecord.query.filter_by(user_id=current_user.id).order_by(OrderRecord.created_at.desc()).limit(20).all()
    
    selected_account = None
    account_balances = {}
    for account in accounts:
        balance = fetch_account_balance(account)
        account_balances[account.id] = balance
        if selected_account is None:
            selected_account = account
    
    assets = get_assets(selected_account)
    api_connected = check_api_connection(selected_account)
    
    return render_template("dashboard.html", accounts=accounts, orders=orders, assets=assets, api_connected=api_connected, account_balances=account_balances)

@app.route("/add_account", methods=["POST"])
@login_required
def add_account():
    from models import AlpacaAccount
    name = request.form.get("name", "Paper Account")
    api_key = request.form.get("api_key")
    api_secret = request.form.get("api_secret")
    is_paper = request.form.get("is_paper") == "on"
    
    account = AlpacaAccount(
        name=name,
        user_id=current_user.id,
        is_paper=is_paper
    )
    account.api_key = api_key
    account.api_secret = api_secret
    
    db.session.add(account)
    db.session.commit()
    flash("Account added successfully")
    return redirect(url_for("dashboard"))

@app.route("/run_orb", methods=["POST"])
def run_orb():
    try:
        data = request.json
        symbol = data.get("symbol", "")
        take_profit = float(data.get("take_profit", 0.02))
        account_id = data.get("account_id")
        
        if not symbol:
            return jsonify({"status": "ERROR", "message": "Please select a symbol."})
        
        if take_profit <= 0 or take_profit > 1:
            return jsonify({"status": "ERROR", "message": "Take profit must be between 0% and 100%."})
        
        account = None
        user_id = None
        if account_id and current_user.is_authenticated:
            from models import AlpacaAccount
            account = AlpacaAccount.query.filter_by(id=account_id, user_id=current_user.id).first()
            user_id = current_user.id
            
        return jsonify(orb_trade(symbol, take_profit, account, user_id))
    except Exception as e:
        logging.error(f"Run ORB error: {e}")
        return jsonify({"status": "ERROR", "message": str(e)})

@app.route("/api/status")
def api_status():
    return jsonify({"connected": check_api_connection()})

@app.route("/api/run_strategy", methods=["POST"])
def run_strategy():
    from strategies import get_strategy
    from alpaca_client import AlpacaClient
    
    try:
        data = request.json
        strategy_name = data.get("strategy", "orb")
        symbol = data.get("symbol", "")
        take_profit_raw = data.get("take_profit", 0.05)
        account_id = data.get("account_id")
        position_settings = data.get("position", {})
        
        if not symbol:
            return jsonify({"status": "ERROR", "message": "Please select a symbol."})
        
        is_manual_tp = take_profit_raw == "manual"
        take_profit = 0 if is_manual_tp else float(take_profit_raw)
        
        if not is_manual_tp and (take_profit <= 0 or take_profit > 1):
            return jsonify({"status": "ERROR", "message": "Take profit must be between 0% and 100%."})
        
        strategy = get_strategy(strategy_name)
        if not strategy:
            return jsonify({"status": "ERROR", "message": f"Unknown strategy: {strategy_name}"})
        
        account = None
        user_id = None
        if account_id and current_user.is_authenticated:
            from models import AlpacaAccount
            account = AlpacaAccount.query.filter_by(id=account_id, user_id=current_user.id).first()
            user_id = current_user.id
        
        client = AlpacaClient.from_account(account)
        
        stop_loss_pct = position_settings.get("stop_loss", 0.02)
        result = strategy.execute(
            client, 
            symbol, 
            take_profit=take_profit,
            stop_loss=stop_loss_pct,
            position_settings=position_settings,
            account=account
        )
        
        if result.get("status") == "TRADE_PLACED" and user_id:
            from models import OrderRecord
            order_record = OrderRecord(
                user_id=user_id,
                symbol=symbol,
                side=result.get("direction", "").lower(),
                qty=result.get("qty", 1),
                entry_price=result.get("entry_price"),
                tp_price=result.get("take_profit"),
                sl_price=result.get("stop_loss"),
                alpaca_order_id=result.get("alpaca_order_id", ""),
                status="placed" if result.get("take_profit_placed") else "tp_failed"
            )
            db.session.add(order_record)
            db.session.commit()
            
            if account_id:
                trailing_sl = position_settings.get("trailing_sl", False)
                position_monitor.add_position(
                    user_id=user_id,
                    account_id=account_id,
                    symbol=symbol,
                    side=result.get("direction", "").lower(),
                    qty=result.get("qty", 1),
                    entry_price=result.get("entry_price"),
                    tp_price=result.get("take_profit"),
                    sl_price=result.get("stop_loss"),
                    tp_pct=take_profit if not is_manual_tp else None,
                    sl_pct=stop_loss_pct,
                    trailing_sl=trailing_sl,
                    alpaca_order_id=result.get("alpaca_order_id", "")
                )
        
        return jsonify(result)
    except Exception as e:
        logging.error(f"Run strategy error: {e}")
        return jsonify({"status": "ERROR", "message": str(e)})

@app.route("/api/positions")
@login_required
def get_positions():
    from models import AlpacaAccount
    account_id = request.args.get("account_id")
    if not account_id:
        return jsonify({"positions": [], "error": "No account selected"})
    
    account = AlpacaAccount.query.filter_by(id=account_id, user_id=current_user.id).first()
    if not account:
        return jsonify({"positions": [], "error": "Account not found"})
    
    headers = get_alpaca_headers(account)
    base_url = "https://paper-api.alpaca.markets" if account.is_paper else "https://api.alpaca.markets"
    
    try:
        r = requests.get(f"{base_url}/v2/positions", headers=headers, timeout=10)
        if r.status_code == 200:
            positions = r.json()
            result = []
            for pos in positions:
                entry_price = float(pos.get("avg_entry_price", 0))
                current_price = float(pos.get("current_price", 0))
                qty = int(pos.get("qty", 0))
                unrealized_pl = float(pos.get("unrealized_pl", 0))
                unrealized_plpc = float(pos.get("unrealized_plpc", 0)) * 100
                market_value = float(pos.get("market_value", 0))
                
                result.append({
                    "symbol": pos.get("symbol"),
                    "qty": qty,
                    "side": pos.get("side"),
                    "entry_price": entry_price,
                    "current_price": current_price,
                    "unrealized_pl": unrealized_pl,
                    "unrealized_plpc": unrealized_plpc,
                    "market_value": market_value
                })
            return jsonify({"positions": result})
        return jsonify({"positions": [], "error": f"API error: {r.status_code}"})
    except Exception as e:
        logging.error(f"Error fetching positions: {e}")
        return jsonify({"positions": [], "error": str(e)})

@app.route("/api/market_status")
def market_status():
    try:
        eastern = pytz.timezone("America/New_York")
        now = datetime.datetime.now(eastern)
        weekday = now.weekday()
        hour = now.hour
        minute = now.minute
        
        is_weekday = weekday < 5
        market_open_time = now.replace(hour=9, minute=30, second=0, microsecond=0)
        market_close_time = now.replace(hour=16, minute=0, second=0, microsecond=0)
        orb_ready_time = now.replace(hour=9, minute=45, second=0, microsecond=0)
        
        is_market_open = is_weekday and market_open_time <= now <= market_close_time
        is_orb_ready = is_weekday and now >= orb_ready_time and now <= market_close_time
        
        status = "closed"
        message = "Market is closed"
        if is_weekday:
            if now < market_open_time:
                status = "pre_market"
                message = f"Market opens at 9:30 AM ET"
            elif now >= market_open_time and now < orb_ready_time:
                status = "opening"
                message = "Market open - Waiting for ORB window (9:45 AM ET)"
            elif is_orb_ready:
                status = "orb_ready"
                message = "ORB window active - Ready to trade"
            elif now > market_close_time:
                status = "closed"
                message = "Market closed for today"
        else:
            message = "Market closed (weekend)"
        
        return jsonify({
            "status": status,
            "message": message,
            "is_market_open": is_market_open,
            "is_orb_ready": is_orb_ready,
            "current_time": now.strftime("%H:%M:%S ET")
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

@app.route("/api/run_sma_bot", methods=["POST"])
@login_required
def run_sma_bot_endpoint():
    from models import AlpacaAccount, OrderRecord
    from sma_bot import run_sma_bot
    
    data = request.json or {}
    account_id = data.get("account_id")
    qty = int(data.get("qty", 1))
    
    if not account_id:
        return jsonify({"status": "ERROR", "message": "Please select an Alpaca account"})
    
    account = AlpacaAccount.query.filter_by(id=account_id, user_id=current_user.id).first()
    if not account:
        return jsonify({"status": "ERROR", "message": "Account not found"})
    
    try:
        result = run_sma_bot(account, user_id=current_user.id, qty=qty)
        
        if result.get("status") == "SUCCESS":
            for order in result.get("orders_placed", []):
                order_record = OrderRecord(
                    user_id=current_user.id,
                    symbol=order["symbol"],
                    side=order["side"],
                    qty=order["qty"],
                    entry_price=order.get("price"),
                    alpaca_order_id=order.get("order_id", ""),
                    status="placed",
                    strategy="sma"
                )
                db.session.add(order_record)
            db.session.commit()
        
        return jsonify(result)
    except Exception as e:
        logging.error(f"SMA bot error: {e}")
        return jsonify({"status": "ERROR", "message": str(e)})

@app.route("/api/close_position", methods=["POST"])
@login_required
def close_position():
    from models import AlpacaAccount
    data = request.json
    symbol = data.get("symbol")
    account_id = data.get("account_id")
    
    if not symbol or not account_id:
        return jsonify({"success": False, "error": "Missing symbol or account"})
    
    account = AlpacaAccount.query.filter_by(id=account_id, user_id=current_user.id).first()
    if not account:
        return jsonify({"success": False, "error": "Account not found"})
    
    headers = get_alpaca_headers(account)
    base_url = "https://paper-api.alpaca.markets" if account.is_paper else "https://api.alpaca.markets"
    
    try:
        r = requests.delete(f"{base_url}/v2/positions/{symbol}", headers=headers, timeout=10)
        if r.status_code in [200, 204]:
            position_monitor.close_position_manual(account_id, symbol)
            return jsonify({"success": True, "message": f"Position {symbol} closed"})
        return jsonify({"success": False, "error": f"Failed to close: {r.text}"})
    except Exception as e:
        logging.error(f"Error closing position: {e}")
        return jsonify({"success": False, "error": str(e)})

with app.app_context():
    import models
    db.create_all()
