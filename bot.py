from trading_bot import TradingEngine
from strategy import Strategy


class TradingBot:
    def __init__(self):
        self.strategy = Strategy()
        self.engine = TradingEngine(strategy=self.strategy)

    def run(self):
        self.engine.start()
