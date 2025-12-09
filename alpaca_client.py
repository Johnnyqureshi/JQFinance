# alpaca_client.py
import alpaca_trade_api as tradeapi

def make_client(api_key, api_secret, is_paper=True):
    base = "https://paper-api.alpaca.markets" if is_paper else "https://api.alpaca.markets"
    return tradeapi.REST(api_key, api_secret, base_url=base, api_version='v2')
