class TradingEngine:
    def __init__(self, strategy):
        self.strategy = strategy
        self.running = False

    def start(self):
        self.running = True
        self._loop()

    def stop(self):
        self.running = False

    def _loop(self):
        while self.running:
            signal = self.strategy.get_signal()
            if signal:
                self.execute(signal)

    def execute(self, signal):
        print(f"Executing signal: {signal}")
