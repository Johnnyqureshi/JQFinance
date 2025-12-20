from extensions import db
from flask_login import UserMixin
from datetime import datetime
from cryptography.fernet import Fernet
import os
import base64

def get_encryption_key():
    key = os.environ.get("SESSION_SECRET", "default-secret-key-32bytes!!")
    key_bytes = key.encode()[:32].ljust(32, b'0')
    return base64.urlsafe_b64encode(key_bytes)

def encrypt_value(value):
    if not value:
        return value
    f = Fernet(get_encryption_key())
    return f.encrypt(value.encode()).decode()

def decrypt_value(value):
    if not value:
        return value
    try:
        f = Fernet(get_encryption_key())
        return f.decrypt(value.encode()).decode()
    except:
        return value

class User(UserMixin, db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    alpaca_accounts = db.relationship("AlpacaAccount", backref="owner", lazy=True)
    orders = db.relationship("OrderRecord", backref="owner", lazy=True)

class AlpacaAccount(db.Model):
    __tablename__ = "alpaca_accounts"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120))
    _api_key = db.Column("api_key", db.String(500), nullable=False)
    _api_secret = db.Column("api_secret", db.String(500), nullable=False)
    is_paper = db.Column(db.Boolean, default=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    @property
    def api_key(self):
        return decrypt_value(self._api_key)
    
    @api_key.setter
    def api_key(self, value):
        self._api_key = encrypt_value(value)

    @property
    def api_secret(self):
        return decrypt_value(self._api_secret)
    
    @api_secret.setter
    def api_secret(self, value):
        self._api_secret = encrypt_value(value)

class OrderRecord(db.Model):
    __tablename__ = "order_records"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'))
    symbol = db.Column(db.String(20))
    side = db.Column(db.String(10))
    qty = db.Column(db.Integer)
    entry_price = db.Column(db.Float)
    tp_price = db.Column(db.Float)
    sl_price = db.Column(db.Float, nullable=True)
    alpaca_order_id = db.Column(db.String(120))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    status = db.Column(db.String(40), default="placed")


class OpenPosition(db.Model):
    __tablename__ = "open_positions"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    account_id = db.Column(db.Integer, db.ForeignKey('alpaca_accounts.id'), nullable=False)
    symbol = db.Column(db.String(20), nullable=False)
    side = db.Column(db.String(10), nullable=False)
    qty = db.Column(db.Integer, nullable=False)
    entry_price = db.Column(db.Float, nullable=False)
    tp_price = db.Column(db.Float, nullable=True)
    sl_price = db.Column(db.Float, nullable=True)
    tp_pct = db.Column(db.Float, nullable=True)
    sl_pct = db.Column(db.Float, nullable=True)
    alpaca_order_id = db.Column(db.String(120))
    status = db.Column(db.String(40), default="open")
    last_price = db.Column(db.Float, nullable=True)
    last_checked_at = db.Column(db.DateTime, nullable=True)
    exit_price = db.Column(db.Float, nullable=True)
    exit_reason = db.Column(db.String(40), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    closed_at = db.Column(db.DateTime, nullable=True)
    
    account = db.relationship("AlpacaAccount", backref="open_positions")
    user = db.relationship("User", backref="open_positions")
