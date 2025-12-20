import logging
import threading
from datetime import datetime
import pytz
import requests

logger = logging.getLogger("orb.monitor")
logger.setLevel(logging.INFO)

ALPACA_DATA = "https://data.alpaca.markets/v2"

class PositionMonitor:
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self.scheduler = None
        self.app = None
        self.running = False
    
    def init_app(self, app):
        self.app = app
        self._start_scheduler()
        logger.info("Position monitor initialized")
    
    def _start_scheduler(self):
        from apscheduler.schedulers.background import BackgroundScheduler
        
        if self.scheduler and self.scheduler.running:
            return
            
        self.scheduler = BackgroundScheduler()
        self.scheduler.add_job(
            self._check_positions,
            'interval',
            seconds=30,
            id='position_monitor',
            replace_existing=True
        )
        self.scheduler.start()
        self.running = True
        logger.info("Position monitor scheduler started - checking every 30 seconds")
    
    def _is_market_hours(self):
        eastern = pytz.timezone("America/New_York")
        now = datetime.now(eastern)
        weekday = now.weekday()
        
        if weekday >= 5:
            return False
        
        market_open = now.replace(hour=9, minute=30, second=0, microsecond=0)
        market_close = now.replace(hour=16, minute=0, second=0, microsecond=0)
        
        return market_open <= now <= market_close
    
    def _check_positions(self):
        if not self._is_market_hours():
            return
        
        with self.app.app_context():
            from models import OpenPosition, AlpacaAccount
            from extensions import db
            
            open_positions = OpenPosition.query.filter_by(status="open").all()
            
            if not open_positions:
                return
            
            logger.info(f"Checking {len(open_positions)} open positions")
            
            for position in open_positions:
                try:
                    self._check_single_position(position)
                except Exception as e:
                    logger.error(f"Error checking position {position.symbol}: {e}")
    
    def _check_single_position(self, position):
        from models import AlpacaAccount
        from extensions import db
        
        account = AlpacaAccount.query.get(position.account_id)
        if not account:
            logger.warning(f"Account {position.account_id} not found for position {position.symbol}")
            return
        
        headers = {
            "APCA-API-KEY-ID": account.api_key,
            "APCA-API-SECRET-KEY": account.api_secret
        }
        
        try:
            url = f"{ALPACA_DATA}/stocks/{position.symbol}/trades/latest"
            r = requests.get(url, headers=headers, timeout=10)
            
            if r.status_code != 200:
                logger.warning(f"Failed to fetch price for {position.symbol}: {r.status_code}")
                return
            
            current_price = r.json()["trade"]["p"]
            position.last_price = current_price
            position.last_checked_at = datetime.utcnow()
            
            if position.trailing_sl and position.sl_pct:
                self._update_trailing_stop(position, current_price)
            
            tp_str = f"${position.tp_price:.2f}" if position.tp_price else "N/A"
            sl_str = f"${position.sl_price:.2f}" if position.sl_price else "N/A"
            trailing_str = " (trailing)" if position.trailing_sl else ""
            logger.info(
                f"Price check: {position.symbol} | Side: {position.side} | "
                f"Entry: ${position.entry_price:.2f} | Current: ${current_price:.2f} | "
                f"TP: {tp_str} | SL: {sl_str}{trailing_str}"
            )
            
            should_exit = False
            exit_reason = None
            
            if position.side.lower() == "buy":
                if position.tp_price and current_price >= position.tp_price:
                    should_exit = True
                    exit_reason = "take_profit"
                    logger.info(f"TP HIT: {position.symbol} @ ${current_price:.2f} >= ${position.tp_price:.2f}")
                elif position.sl_price and current_price <= position.sl_price:
                    should_exit = True
                    exit_reason = "trailing_stop" if position.trailing_sl else "stop_loss"
                    logger.info(f"SL HIT: {position.symbol} @ ${current_price:.2f} <= ${position.sl_price:.2f}")
            else:
                if position.tp_price and current_price <= position.tp_price:
                    should_exit = True
                    exit_reason = "take_profit"
                    logger.info(f"TP HIT: {position.symbol} @ ${current_price:.2f} <= ${position.tp_price:.2f}")
                elif position.sl_price and current_price >= position.sl_price:
                    should_exit = True
                    exit_reason = "trailing_stop" if position.trailing_sl else "stop_loss"
                    logger.info(f"SL HIT: {position.symbol} @ ${current_price:.2f} >= ${position.sl_price:.2f}")
            
            if should_exit:
                self._execute_exit(position, account, current_price, exit_reason)
            
            db.session.commit()
            
        except Exception as e:
            logger.error(f"Error checking {position.symbol}: {e}")
    
    def _update_trailing_stop(self, position, current_price):
        from extensions import db
        
        if position.side.lower() == "buy":
            if position.highest_price is None or current_price > position.highest_price:
                position.highest_price = current_price
                new_sl = round(current_price * (1 - position.sl_pct), 2)
                if position.sl_price is None or new_sl > position.sl_price:
                    old_sl_str = f"${position.sl_price:.2f}" if position.sl_price else "$0.00"
                    position.sl_price = new_sl
                    logger.info(
                        f"TRAILING SL UPDATED: {position.symbol} | "
                        f"New high: ${current_price:.2f} | "
                        f"SL moved: {old_sl_str} -> ${new_sl:.2f}"
                    )
        else:
            if position.lowest_price is None or current_price < position.lowest_price:
                position.lowest_price = current_price
                new_sl = round(current_price * (1 + position.sl_pct), 2)
                if position.sl_price is None or new_sl < position.sl_price:
                    old_sl_str = f"${position.sl_price:.2f}" if position.sl_price else "$0.00"
                    position.sl_price = new_sl
                    logger.info(
                        f"TRAILING SL UPDATED: {position.symbol} | "
                        f"New low: ${current_price:.2f} | "
                        f"SL moved: {old_sl_str} -> ${new_sl:.2f}"
                    )
    
    def _execute_exit(self, position, account, current_price, exit_reason):
        from extensions import db
        
        base_url = "https://paper-api.alpaca.markets" if account.is_paper else "https://api.alpaca.markets"
        headers = {
            "APCA-API-KEY-ID": account.api_key,
            "APCA-API-SECRET-KEY": account.api_secret
        }
        
        try:
            url = f"{base_url}/v2/positions/{position.symbol}"
            r = requests.delete(url, headers=headers, timeout=10)
            
            if r.status_code in [200, 204]:
                position.status = "closed"
                position.exit_price = current_price
                position.exit_reason = exit_reason
                position.closed_at = datetime.utcnow()
                
                pnl = (current_price - position.entry_price) * position.qty
                if position.side.lower() == "sell":
                    pnl = -pnl
                
                logger.info(
                    f"EXIT EXECUTED: {position.symbol} | Reason: {exit_reason} | "
                    f"Entry: ${position.entry_price:.2f} | Exit: ${current_price:.2f} | "
                    f"P&L: ${pnl:.2f}"
                )
            else:
                logger.error(f"Failed to close position {position.symbol}: {r.text}")
                
        except Exception as e:
            logger.error(f"Error executing exit for {position.symbol}: {e}")
    
    def add_position(self, user_id, account_id, symbol, side, qty, entry_price, 
                     tp_price=None, sl_price=None, tp_pct=None, sl_pct=None, 
                     trailing_sl=False, alpaca_order_id=None):
        with self.app.app_context():
            from models import OpenPosition
            from extensions import db
            
            existing = OpenPosition.query.filter_by(
                account_id=account_id,
                symbol=symbol,
                status="open"
            ).first()
            
            if existing:
                existing.qty += qty
                existing.entry_price = (existing.entry_price + entry_price) / 2
                if tp_price:
                    existing.tp_price = tp_price
                if sl_price:
                    existing.sl_price = sl_price
                db.session.commit()
                logger.info(f"Updated existing position: {symbol} | New qty: {existing.qty}")
                return existing
            
            position = OpenPosition(
                user_id=user_id,
                account_id=account_id,
                symbol=symbol,
                side=side,
                qty=qty,
                entry_price=entry_price,
                tp_price=tp_price,
                sl_price=sl_price,
                tp_pct=tp_pct,
                sl_pct=sl_pct,
                trailing_sl=trailing_sl,
                highest_price=entry_price if side.lower() == "buy" else None,
                lowest_price=entry_price if side.lower() == "sell" else None,
                alpaca_order_id=alpaca_order_id,
                status="open"
            )
            
            db.session.add(position)
            db.session.commit()
            
            tp_log = f"${tp_price:.2f}" if tp_price else "Manual"
            sl_log = f"${sl_price:.2f}" if sl_price else "None"
            trailing_log = " (trailing)" if trailing_sl else ""
            logger.info(
                f"TRADE ENTRY: {symbol} | Side: {side} | Qty: {qty} | "
                f"Entry: ${entry_price:.2f} | TP: {tp_log} | SL: {sl_log}{trailing_log}"
            )
            
            return position
    
    def close_position_manual(self, account_id, symbol):
        with self.app.app_context():
            from models import OpenPosition
            from extensions import db
            
            position = OpenPosition.query.filter_by(
                account_id=account_id,
                symbol=symbol,
                status="open"
            ).first()
            
            if position:
                position.status = "closed"
                position.exit_reason = "manual"
                position.closed_at = datetime.utcnow()
                db.session.commit()
                logger.info(f"MANUAL CLOSE: {symbol} | Position marked as closed")
    
    def get_open_positions(self, account_id=None):
        with self.app.app_context():
            from models import OpenPosition
            
            query = OpenPosition.query.filter_by(status="open")
            if account_id:
                query = query.filter_by(account_id=account_id)
            
            return query.all()


position_monitor = PositionMonitor()
