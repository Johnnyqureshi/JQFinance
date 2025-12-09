# alpaca_client.py
import os

class AlpacaClient:
    def __init__(self, api_key, api_secret, is_paper=True):
        self.api_key = api_key
        self.api_secret = api_secret
        self.is_paper = is_paper
        self.base_url = "https://paper-api.alpaca.markets" if is_paper else "https://api.alpaca.markets"
    
    def get_headers(self):
        return {
            "APCA-API-KEY-ID": self.api_key,
            "APCA-API-SECRET-KEY": self.api_secret
        }
    
    def get_base_url(self):
        return self.base_url
    
    @classmethod
    def from_account(cls, account):
        if account:
            return cls(
                api_key=account.api_key,
                api_secret=account.api_secret,
                is_paper=account.is_paper
            )
        api_key = os.environ.get("ALPACA_API_KEY", "")
        api_secret = os.environ.get("ALPACA_API_SECRET", "")
        return cls(api_key, api_secret, is_paper=True)


def make_client(api_key, api_secret, is_paper=True):
    return AlpacaClient(api_key, api_secret, is_paper)
