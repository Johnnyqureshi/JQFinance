import os
import logging
import requests

ALPACA_PAPER_BASE = "https://paper-api.alpaca.markets"
ALPACA_LIVE_BASE = "https://api.alpaca.markets"
ALPACA_DATA = "https://data.alpaca.markets/v2"

class AlpacaClient:
    def __init__(self, api_key=None, api_secret=None, is_paper=True):
        self.api_key = api_key or os.environ.get("ALPACA_API_KEY", "")
        self.api_secret = api_secret or os.environ.get("ALPACA_API_SECRET", "")
        self.base_url = ALPACA_PAPER_BASE if is_paper else ALPACA_LIVE_BASE
        self.data_url = ALPACA_DATA
    
    @classmethod
    def from_account(cls, account):
        if account:
            return cls(
                api_key=account.api_key,
                api_secret=account.api_secret,
                is_paper=account.is_paper
            )
        return cls()
    
    @property
    def headers(self):
        return {
            "APCA-API-KEY-ID": self.api_key,
            "APCA-API-SECRET-KEY": self.api_secret
        }
    
    def is_configured(self):
        return bool(self.api_key and self.api_secret)
    
    def check_connection(self):
        if not self.is_configured():
            return False
        try:
            url = f"{self.base_url}/v2/account"
            r = requests.get(url, headers=self.headers, timeout=5)
            return r.status_code == 200
        except:
            return False
    
    def get_account(self):
        if not self.is_configured():
            return None
        try:
            url = f"{self.base_url}/v2/account"
            r = requests.get(url, headers=self.headers, timeout=10)
            if r.status_code == 200:
                return r.json()
            return None
        except Exception as e:
            logging.error(f"Error fetching account: {e}")
            return None
    
    def get_tradable_assets(self):
        if not self.is_configured():
            return []
        try:
            url = f"{self.base_url}/v2/assets"
            r = requests.get(url, headers=self.headers, timeout=30)
            if r.status_code == 200:
                assets = r.json()
                tradable = [a["symbol"] for a in assets if a.get("tradable", False)]
                priority_symbols = ["SOXS", "TZA", "MSTZ", "FNGD", "RR", "EXK", "ASM", "LAC", "NVTS", "UVIX", "PLG"]
                for sym in priority_symbols:
                    if sym not in tradable:
                        tradable.append(sym)
                return sorted(tradable)
            return []
        except Exception as e:
            logging.error(f"Error fetching assets: {e}")
            return []
    
    def get_bars(self, symbol, timeframe="15Min", limit=1):
        try:
            url = f"{self.data_url}/stocks/{symbol}/bars"
            params = {"timeframe": timeframe, "limit": limit}
            r = requests.get(url, headers=self.headers, params=params, timeout=10)
            if r.status_code == 200:
                data = r.json()
                return data.get("bars", [])
            return None
        except Exception as e:
            logging.error(f"Error fetching bars: {e}")
            return None
    
    def get_latest_trade(self, symbol):
        try:
            url = f"{self.data_url}/stocks/{symbol}/trades/latest"
            r = requests.get(url, headers=self.headers, timeout=10)
            if r.status_code == 200:
                return r.json().get("trade", {})
            return None
        except Exception as e:
            logging.error(f"Error fetching latest trade: {e}")
            return None
    
    def place_order(self, symbol, qty, side, order_type="market", limit_price=None, time_in_force="day"):
        try:
            url = f"{self.base_url}/v2/orders"
            order = {
                "symbol": symbol,
                "qty": qty,
                "side": side,
                "type": order_type,
                "time_in_force": time_in_force
            }
            if order_type == "limit" and limit_price:
                order["limit_price"] = limit_price
            
            r = requests.post(url, json=order, headers=self.headers, timeout=10)
            if r.status_code in [200, 201]:
                return {"success": True, "order": r.json()}
            return {"success": False, "error": r.text}
        except Exception as e:
            logging.error(f"Error placing order: {e}")
            return {"success": False, "error": str(e)}
    
    def get_positions(self):
        if not self.is_configured():
            return []
        try:
            url = f"{self.base_url}/v2/positions"
            r = requests.get(url, headers=self.headers, timeout=10)
            if r.status_code == 200:
                return r.json()
            return []
        except Exception as e:
            logging.error(f"Error fetching positions: {e}")
            return []
    
    def get_orders(self, status="open"):
        if not self.is_configured():
            return []
        try:
            url = f"{self.base_url}/v2/orders"
            params = {"status": status}
            r = requests.get(url, headers=self.headers, params=params, timeout=10)
            if r.status_code == 200:
                return r.json()
            return []
        except Exception as e:
            logging.error(f"Error fetching orders: {e}")
            return []
