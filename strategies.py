# strategies.py
from datetime import datetime, timedelta
import pytz
import alpaca_trade_api as tradeapi

class StrategyBase:
    name = "base"
    def scan_and_trade(self, client, symbol, **kwargs):
        raise NotImplementedError

class ORB15(StrategyBase):
    name = "ORB-15m"
    def __init__(self, opening_bars=4, profit_pct=5.0, stop_loss_pct=None):
        self.opening_bars = opening_bars
        self.profit_pct = profit_pct
        self.stop_loss_pct = stop_loss_pct

    def scan_and_trade(self, client, symbol, trade_size_usd=None):
        eastern = pytz.timezone("US/Eastern")
        today = datetime.now(eastern).date()
        start = eastern.localize(datetime(today.year, today.month, today.day, 9, 30)).astimezone(pytz.utc).isoformat()
        end = eastern.localize(datetime(today.year, today.month, today.day, 16, 0)).astimezone(pytz.utc).isoformat()

        bars = client.get_bars(symbol, tradeapi.rest.TimeFrame(15, "minute"), start=start, end=end).df
        if bars is None or len(bars) < self.opening_bars + 1:
            return {"status":"not_enough_bars"}
        opening = bars.iloc[:self.opening_bars]
        opening_high = opening['high'].max()
        opening_low = opening['low'].min()
        rest = bars.iloc[self.opening_bars:]
        breakout = None
        for idx, row in rest.iterrows():
            if row['high'] > opening_high:
                breakout = row
                break
        if breakout is None:
            return {"status":"no_breakout"}
        try:
            pos = client.get_position(symbol)
            return {"status":"already_have_position"}
        except Exception:
            pass
        last_price = breakout['close']
        acct = client.get_account()
        bp = float(acct.buying_power or acct.cash)
        trade_amount = trade_size_usd or (bp * 0.01)
        qty = max(1, int(trade_amount / last_price))
        order = client.submit_order(symbol=symbol, qty=qty, side='buy', type='market', time_in_force='day')
        tp = round(last_price * (1 + self.profit_pct/100.0), 2)
        client.submit_order(symbol=symbol, qty=qty, side='sell', type='limit', time_in_force='day', limit_price=str(tp))
        if self.stop_loss_pct:
            sl = round(last_price * (1 - self.stop_loss_pct/100.0), 2)
            client.submit_order(symbol=symbol, qty=qty, side='sell', type='stop', time_in_force='day', stop_price=str(sl))
        return {"status":"entered","symbol":symbol,"qty":qty,"entry":last_price,"tp":tp}
