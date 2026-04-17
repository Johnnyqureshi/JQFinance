class Strategy:
    def __init__(self):
        self.name = "BaseStrategy"

    def get_signal(self):
        return None

    def analyze(self, data):
        raise NotImplementedError("Subclasses must implement the analyze method.")
