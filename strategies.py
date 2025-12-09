import logging
import datetime
import pytz
from abc import ABC, abstractmethod
from alpaca_client import AlpacaClient

class TradingStrategy(ABC):
    name = "Base Strategy"
    description = "Abstract base strategy"
    
    @abstractmethod
    def execute(self, client, symbol, **params):
        pass

class ORBStrategy(TradingStrategy):
    name = "Opening Range Breakout"
    description = "Trades breakouts above/below the first 15-minute candle after market open"
    
    def execute(self, client, symbol, take_profit=0.05, qty=1, **params):
        if not client.is_configured():
            return {"status": "ERROR", "message": "API keys not configured."}
        
        now = datetime.datetime.now(pytz.timezone("America/New_York"))
        market_open = now.replace(hour=9, minute=45, second=0, microsecond=0)
        
        if now < market_open:
            return {
                "status": "WAIT", 
                "message": "ORB window has not started yet. Market opens at 9:30 AM ET, ORB analysis begins at 9:45 AM ET."
            }
        
        bars = client.get_bars(symbol, timeframe="15Min", limit=1)
        if not bars:
            return {"status": "ERROR", "message": "No bar data available for this symbol."}
        
        bar = bars[0]
        high = bar["h"]
        low = bar["l"]
        
        trade = client.get_latest_trade(symbol)
        if not trade:
            return {"status": "ERROR", "message": "Error fetching current price."}
        
        price = trade["p"]
        
        if price > high:
            direction = "buy"
        elif price < low:
            direction = "sell"
        else:
            return {
                "status": "NO_BREAKOUT",
                "message": f"No breakout detected. Price ${price:.2f} is within the ORB range (${low:.2f} - ${high:.2f}).",
                "current_price": price,
                "orb_high": high,
                "orb_low": low
            }
        
        entry_result = client.place_order(symbol, qty, direction, "market")
        if not entry_result["success"]:
            return {"status": "ORDER_ERROR", "message": f"Trade failed: {entry_result['error']}"}
        
        alpaca_order_id = entry_result["order"].get("id", "")
        
        if direction == "buy":
            tp_price = round(price * (1 + take_profit), 2)
            tp_side = "sell"
        else:
            tp_price = round(price * (1 - take_profit), 2)
            tp_side = "buy"
        
        tp_result = client.place_order(symbol, qty, tp_side, "limit", limit_price=tp_price)
        tp_placed = tp_result["success"]
        
        if tp_placed:
            message = f"Successfully placed {direction.upper()} order for {symbol} at ${price:.2f} with take-profit at ${tp_price:.2f}"
        else:
            logging.warning(f"Take-profit order failed: {tp_result.get('error')}")
            message = f"Entry order placed for {symbol} at ${price:.2f}, but take-profit order failed. Please set exit manually."
        
        return {
            "status": "TRADE_PLACED",
            "direction": direction.upper(),
            "symbol": symbol,
            "entry_price": price,
            "take_profit": tp_price,
            "take_profit_placed": tp_placed,
            "orb_high": high,
            "orb_low": low,
            "alpaca_order_id": alpaca_order_id,
            "message": message
        }

AVAILABLE_STRATEGIES = {
    "orb": ORBStrategy()
}

def get_strategy(name):
    return AVAILABLE_STRATEGIES.get(name.lower())

def list_strategies():
    return [
        {"id": key, "name": s.name, "description": s.description}
        for key, s in AVAILABLE_STRATEGIES.items()
    ]
