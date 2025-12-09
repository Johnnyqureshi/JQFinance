# strategies.py
from datetime import datetime, timedelta
import pytz
import requests
import logging

ALPACA_DATA = "https://data.alpaca.markets/v2"

class StrategyBase:
    name = "base"
    
    def execute(self, client, symbol, **kwargs):
        raise NotImplementedError

class ORBStrategy(StrategyBase):
    name = "orb"
    
    def execute(self, client, symbol, take_profit=0.05, stop_loss=0.02, position_settings=None, account=None):
        eastern = pytz.timezone("America/New_York")
        now = datetime.now(eastern)
        market_open = now.replace(hour=9, minute=45, second=0, microsecond=0)
        
        if now < market_open:
            return {"status": "WAIT", "message": "ORB window has not started yet. Market opens at 9:30 AM ET, ORB analysis begins at 9:45 AM ET."}
        
        headers = client.get_headers()
        
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
            
            qty = self._calculate_qty(account, position_settings, price, stop_loss)
            
            base_url = client.get_base_url()
            order_url = f"{base_url}/v2/orders"
            
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
                sl_price = round(price * (1 - stop_loss), 2) if stop_loss else None
            else:
                tp_price = round(price * (1 - take_profit), 2)
                sl_price = round(price * (1 + stop_loss), 2) if stop_loss else None
            
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
            
            sl_placed = False
            if stop_loss and sl_price:
                sl_order = {
                    "symbol": symbol,
                    "qty": qty,
                    "side": "sell" if direction == "BUY" else "buy",
                    "type": "stop",
                    "stop_price": sl_price,
                    "time_in_force": "day"
                }
                sl_response = requests.post(order_url, json=sl_order, headers=headers, timeout=10)
                sl_placed = sl_response.status_code in [200, 201]
            
            if tp_placed:
                message = f"Placed {direction} order for {qty} shares of {symbol} at ${price:.2f}. TP: ${tp_price:.2f}"
                if sl_placed:
                    message += f", SL: ${sl_price:.2f}"
            else:
                message = f"Entry order placed for {symbol} at ${price:.2f}, but take-profit order failed."
            
            return {
                "status": "TRADE_PLACED",
                "direction": direction,
                "symbol": symbol,
                "qty": qty,
                "entry_price": price,
                "take_profit": tp_price,
                "stop_loss": sl_price,
                "take_profit_placed": tp_placed,
                "stop_loss_placed": sl_placed,
                "alpaca_order_id": alpaca_order_id,
                "orb_high": high,
                "orb_low": low,
                "message": message
            }
            
        except requests.exceptions.Timeout:
            return {"status": "ERROR", "message": "Request timed out. Please try again."}
        except Exception as e:
            logging.error(f"ORB strategy error: {e}")
            return {"status": "ERROR", "message": f"An error occurred: {str(e)}"}
    
    def _calculate_qty(self, account, position_settings, current_price, stop_loss_pct):
        if not position_settings:
            return 1
        
        size_type = position_settings.get("size_type", "fixed")
        size_value = position_settings.get("size_value", 1)
        max_risk = position_settings.get("max_risk", 0.02)
        
        effective_stop_loss = stop_loss_pct if stop_loss_pct and stop_loss_pct > 0 else 0.02
        
        if not account:
            if size_type == "fixed":
                return max(1, int(size_value))
            return 1
        
        from app import fetch_account_balance
        balance = fetch_account_balance(account)
        if not balance:
            if size_type == "fixed":
                return max(1, int(size_value))
            return 1
        
        equity = balance.get("equity", 0)
        buying_power = balance.get("buying_power", 0)
        
        if equity <= 0 or current_price <= 0:
            return 1
        
        if size_type == "fixed":
            qty = max(1, int(size_value))
        elif size_type == "dollars":
            qty = int(size_value / current_price) if current_price > 0 else 1
            qty = max(1, qty)
        elif size_type == "percent":
            dollar_amount = buying_power * (size_value / 100)
            qty = int(dollar_amount / current_price) if current_price > 0 else 1
            qty = max(1, qty)
        else:
            qty = 1
        
        max_risk_dollars = equity * max_risk
        risk_per_share = current_price * effective_stop_loss
        
        if risk_per_share > 0:
            max_qty_by_risk = int(max_risk_dollars / risk_per_share)
            if max_qty_by_risk < 1:
                logging.warning(f"Max risk calculation results in 0 shares. Risk: ${max_risk_dollars:.2f}, Risk/share: ${risk_per_share:.2f}")
                return 1
            qty = min(qty, max_qty_by_risk)
        
        return max(1, qty)


STRATEGIES = {
    "orb": ORBStrategy()
}

def get_strategy(name):
    return STRATEGIES.get(name)
