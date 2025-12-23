import logging
import requests
from datetime import datetime

logger = logging.getLogger("sma.bot")
logger.setLevel(logging.INFO)

SMA_TICKERS = ["INTC", "DAL", "T"]
ALPACA_DATA = "https://data.alpaca.markets/v2"

def get_last_signal_state(user_id, account_id, symbol):
    from models import SMASignalState
    state = SMASignalState.query.filter_by(
        user_id=user_id, account_id=account_id, symbol=symbol
    ).first()
    return state

def update_signal_state(user_id, account_id, symbol, signal, bar_timestamp):
    from extensions import db
    from models import SMASignalState
    state = SMASignalState.query.filter_by(
        user_id=user_id, account_id=account_id, symbol=symbol
    ).first()
    if state:
        state.last_signal = signal
        state.last_bar_timestamp = bar_timestamp
    else:
        state = SMASignalState(
            user_id=user_id,
            account_id=account_id,
            symbol=symbol,
            last_signal=signal,
            last_bar_timestamp=bar_timestamp
        )
        db.session.add(state)
    db.session.commit()

def mark_bar_processed(user_id, account_id, symbol, bar_timestamp):
    from extensions import db
    from models import SMASignalState
    state = SMASignalState.query.filter_by(
        user_id=user_id, account_id=account_id, symbol=symbol
    ).first()
    if state:
        state.last_bar_timestamp = bar_timestamp
    else:
        state = SMASignalState(
            user_id=user_id,
            account_id=account_id,
            symbol=symbol,
            last_signal="hold",
            last_bar_timestamp=bar_timestamp
        )
        db.session.add(state)
    db.session.commit()

def get_alpaca_headers(account):
    if account:
        return {
            "APCA-API-KEY-ID": account.api_key,
            "APCA-API-SECRET-KEY": account.api_secret
        }
    return {}

def get_base_url(account):
    if account and not account.is_paper:
        return "https://api.alpaca.markets"
    return "https://paper-api.alpaca.markets"

def fetch_bars(symbol, headers, limit=100):
    url = f"{ALPACA_DATA}/stocks/{symbol}/bars"
    params = {"timeframe": "1Min", "limit": limit}
    try:
        r = requests.get(url, headers=headers, params=params, timeout=15)
        if r.status_code == 200:
            data = r.json()
            bars = data.get("bars", [])
            return bars
        logger.error(f"Error fetching bars for {symbol}: {r.status_code} - {r.text}")
        return []
    except Exception as e:
        logger.error(f"Exception fetching bars for {symbol}: {e}")
        return []

def calculate_sma(closes, window):
    if len(closes) < window:
        return None
    return sum(closes[-window:]) / window

def detect_crossover(bars):
    if len(bars) < 21:
        return "hold", None, None, None, None
    
    closes = [bar["c"] for bar in bars]
    
    current_sma_fast = calculate_sma(closes, 5)
    current_sma_slow = calculate_sma(closes, 20)
    
    prev_closes = closes[:-1]
    prev_sma_fast = calculate_sma(prev_closes, 5)
    prev_sma_slow = calculate_sma(prev_closes, 20)
    
    if any(v is None for v in [current_sma_fast, current_sma_slow, prev_sma_fast, prev_sma_slow]):
        return "hold", current_sma_fast, current_sma_slow, None, None
    
    current_above = current_sma_fast > current_sma_slow
    prev_above = prev_sma_fast > prev_sma_slow
    
    if current_above and not prev_above:
        return "buy", current_sma_fast, current_sma_slow, prev_sma_fast, prev_sma_slow
    elif not current_above and prev_above:
        return "sell", current_sma_fast, current_sma_slow, prev_sma_fast, prev_sma_slow
    else:
        trend = "bullish" if current_above else "bearish"
        return f"hold_{trend}", current_sma_fast, current_sma_slow, prev_sma_fast, prev_sma_slow

def place_order(symbol, side, qty, headers, base_url):
    order_url = f"{base_url}/v2/orders"
    order = {
        "symbol": symbol,
        "qty": qty,
        "side": side,
        "type": "market",
        "time_in_force": "gtc"
    }
    try:
        r = requests.post(order_url, json=order, headers=headers, timeout=10)
        if r.status_code in [200, 201]:
            order_data = r.json()
            logger.info(f"Order placed: {side} {qty} {symbol}")
            return {"success": True, "order_id": order_data.get("id"), "order": order_data}
        else:
            logger.error(f"Order failed for {symbol}: {r.status_code} - {r.text}")
            return {"success": False, "error": r.text}
    except Exception as e:
        logger.error(f"Exception placing order for {symbol}: {e}")
        return {"success": False, "error": str(e)}

def get_current_price(symbol, headers):
    url = f"{ALPACA_DATA}/stocks/{symbol}/trades/latest"
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code == 200:
            return r.json()["trade"]["p"]
        return None
    except:
        return None

def run_sma_bot(account, user_id=None, qty=1):
    if not account:
        return {"status": "ERROR", "message": "No Alpaca account connected"}
    
    if not user_id:
        return {"status": "ERROR", "message": "User authentication required"}
    
    headers = get_alpaca_headers(account)
    if not headers.get("APCA-API-KEY-ID"):
        return {"status": "ERROR", "message": "Invalid API credentials"}
    
    base_url = get_base_url(account)
    account_id = account.id
    results = {}
    orders_placed = []
    
    for ticker in SMA_TICKERS:
        try:
            bars = fetch_bars(ticker, headers, limit=100)
            
            if not bars or len(bars) < 21:
                results[ticker] = {
                    "signal": "hold",
                    "reason": f"Insufficient data ({len(bars) if bars else 0} bars, need 21 for crossover detection)",
                    "order_placed": False
                }
                continue
            
            signal, sma_fast, sma_slow, prev_sma_fast, prev_sma_slow = detect_crossover(bars)
            current_price = get_current_price(ticker, headers)
            
            last_bar_ts = bars[-1].get("t", "") if bars else ""
            
            last_state = get_last_signal_state(user_id, account_id, ticker)
            
            is_crossover = signal in ["buy", "sell"]
            should_trade = False
            
            if is_crossover:
                if last_state is None:
                    should_trade = True
                elif last_state.last_bar_timestamp != last_bar_ts:
                    should_trade = True
                elif last_state.last_signal != signal:
                    should_trade = True
                else:
                    logger.info(f"Skipping duplicate {signal} for {ticker} - already processed this bar")
            
            result = {
                "signal": signal,
                "sma_fast": round(sma_fast, 4) if sma_fast else None,
                "sma_slow": round(sma_slow, 4) if sma_slow else None,
                "prev_sma_fast": round(prev_sma_fast, 4) if prev_sma_fast else None,
                "prev_sma_slow": round(prev_sma_slow, 4) if prev_sma_slow else None,
                "current_price": current_price,
                "is_crossover": is_crossover,
                "order_placed": False
            }
            
            if should_trade:
                logger.info(f"CROSSOVER detected for {ticker}: {signal.upper()} - SMA5 crossed {'above' if signal == 'buy' else 'below'} SMA20")
                
                mark_bar_processed(user_id, account_id, ticker, last_bar_ts)
                
                order_result = place_order(ticker, signal, qty, headers, base_url)
                result["order_placed"] = order_result.get("success", False)
                result["order_id"] = order_result.get("order_id")
                if order_result.get("success"):
                    orders_placed.append({
                        "symbol": ticker,
                        "side": signal,
                        "qty": qty,
                        "price": current_price,
                        "order_id": order_result.get("order_id")
                    })
                    update_signal_state(user_id, account_id, ticker, signal, last_bar_ts)
                else:
                    result["order_error"] = order_result.get("error")
            elif is_crossover:
                result["skipped"] = "Already processed this crossover"
            else:
                mark_bar_processed(user_id, account_id, ticker, last_bar_ts)
                logger.info(f"No crossover for {ticker}: {signal} (no trade)")
            
            results[ticker] = result
            
        except Exception as e:
            logger.error(f"Error processing {ticker}: {e}")
            results[ticker] = {
                "signal": "error",
                "error": str(e),
                "order_placed": False
            }
    
    return {
        "status": "SUCCESS",
        "results": results,
        "orders_placed": orders_placed,
        "tickers": SMA_TICKERS,
        "timestamp": datetime.utcnow().isoformat()
    }
