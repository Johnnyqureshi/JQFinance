import os
import logging
import requests
from flask import Blueprint, render_template, request, jsonify
from flask_login import login_required, current_user
from extensions import db
from datetime import datetime

finelo_bp = Blueprint("finelo", __name__)
logger = logging.getLogger("finelo")

AIML_API_BASE = "https://api.aimlapi.com/v1"
AIML_API_KEY = os.environ.get("AIML_API_KEY", "")
ALPACA_DATA = "https://data.alpaca.markets/v2"


def get_aiml_headers():
    return {
        "Authorization": f"Bearer {AIML_API_KEY}",
        "Content-Type": "application/json"
    }


def get_alpaca_headers_for_user():
    from models import AlpacaAccount
    if current_user.is_authenticated:
        account = AlpacaAccount.query.filter_by(user_id=current_user.id).first()
        if account:
            return {
                "APCA-API-KEY-ID": account.api_key,
                "APCA-API-SECRET-KEY": account.api_secret
            }
    api_key = os.environ.get("ALPACA_API_KEY", "")
    api_secret = os.environ.get("ALPACA_API_SECRET", "")
    return {
        "APCA-API-KEY-ID": api_key,
        "APCA-API-SECRET-KEY": api_secret
    }


@finelo_bp.route("/finelo")
@login_required
def finelo_page():
    from models import ChatMessage, SimulatorPortfolio
    messages = ChatMessage.query.filter_by(
        user_id=current_user.id
    ).order_by(ChatMessage.created_at.desc()).limit(50).all()
    messages = list(reversed(messages))

    portfolio = SimulatorPortfolio.query.filter_by(user_id=current_user.id).first()
    if not portfolio:
        portfolio = SimulatorPortfolio(
            user_id=current_user.id,
            cash_balance=100000.0,
            initial_balance=100000.0
        )
        db.session.add(portfolio)
        db.session.commit()

    return render_template("finelo.html",
                           active_tab="finelo",
                           messages=messages,
                           portfolio=portfolio)


@finelo_bp.route("/api/finelo/chat", methods=["POST"])
@login_required
def ai_chat():
    from models import ChatMessage
    try:
        if not AIML_API_KEY:
            return jsonify({"status": "error", "message": "AI/ML API key not configured."})

        data = request.json
        user_message = data.get("message", "").strip()

        if not user_message:
            return jsonify({"status": "error", "message": "Please enter a message."})

        recent = ChatMessage.query.filter_by(
            user_id=current_user.id
        ).order_by(ChatMessage.created_at.desc()).limit(10).all()
        recent = list(reversed(recent))

        conversation = [
            {"role": "system", "content": "You are an expert trading mentor and financial educator. You help users understand trading concepts, market analysis, technical indicators, risk management, and trading psychology. Be concise but thorough. Use examples when helpful. Never give specific buy/sell recommendations - instead teach the user how to analyze and make their own decisions. Format responses with clear structure using bullet points and headers when appropriate."}
        ]

        for msg in recent:
            conversation.append({"role": msg.role, "content": msg.content})

        conversation.append({"role": "user", "content": user_message})

        headers = get_aiml_headers()
        payload = {
            "model": "gpt-4o-mini",
            "messages": conversation,
            "max_tokens": 1000,
            "temperature": 0.7
        }

        response = requests.post(
            f"{AIML_API_BASE}/chat/completions",
            json=payload,
            headers=headers,
            timeout=30
        )

        if response.status_code >= 400:
            logger.error(f"AIML chat error: {response.status_code} - {response.text}")
            return jsonify({"status": "error", "message": "AI service temporarily unavailable."})

        result = response.json()
        ai_response = result.get("choices", [{}])[0].get("message", {}).get("content", "I couldn't generate a response.")

        user_record = ChatMessage(
            user_id=current_user.id,
            role="user",
            content=user_message
        )
        ai_record = ChatMessage(
            user_id=current_user.id,
            role="assistant",
            content=ai_response
        )
        db.session.add(user_record)
        db.session.add(ai_record)
        db.session.commit()

        return jsonify({
            "status": "success",
            "response": ai_response
        })

    except Exception as e:
        logger.error(f"AI chat error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@finelo_bp.route("/api/finelo/analyze-chart", methods=["POST"])
@login_required
def analyze_chart():
    try:
        if not AIML_API_KEY:
            return jsonify({"status": "error", "message": "AI/ML API key not configured."})

        data = request.json
        image_url = data.get("image_url", "").strip()
        analysis_type = data.get("analysis_type", "general")

        if not image_url:
            return jsonify({"status": "error", "message": "Please provide a chart image URL."})

        prompts = {
            "general": "Analyze this trading chart. Identify the current trend (bullish/bearish/neutral), key support and resistance levels, any chart patterns you recognize (head and shoulders, double top/bottom, triangles, flags, etc.), and important price levels. Provide a structured analysis.",
            "patterns": "Focus on identifying chart patterns in this image. Look for: candlestick patterns (doji, hammer, engulfing, etc.), classic chart patterns (triangles, wedges, channels, head and shoulders), and any continuation or reversal patterns. Explain what each pattern suggests.",
            "indicators": "Analyze the technical indicators visible in this chart. Identify any moving averages, RSI, MACD, Bollinger Bands, or other indicators. Explain what each indicator is signaling and whether they confirm or diverge from each other.",
            "levels": "Identify all key support and resistance levels in this chart. Mark the strongest levels and explain why they are significant. Also identify any trendlines, channels, or Fibonacci levels that may be relevant."
        }

        system_prompt = prompts.get(analysis_type, prompts["general"])

        headers = get_aiml_headers()
        payload = {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "You are an expert technical analyst and chart reader. Provide detailed, structured analysis of trading charts. Be specific about price levels, patterns, and what they indicate. Never give buy/sell recommendations."},
                {"role": "user", "content": [
                    {"type": "text", "text": system_prompt},
                    {"type": "image_url", "image_url": {"url": image_url}}
                ]}
            ],
            "max_tokens": 1500,
            "temperature": 0.3
        }

        response = requests.post(
            f"{AIML_API_BASE}/chat/completions",
            json=payload,
            headers=headers,
            timeout=60
        )

        if response.status_code >= 400:
            logger.error(f"Chart analysis error: {response.status_code} - {response.text}")
            return jsonify({"status": "error", "message": "Chart analysis service unavailable."})

        result = response.json()
        analysis = result.get("choices", [{}])[0].get("message", {}).get("content", "Unable to analyze chart.")

        return jsonify({
            "status": "success",
            "analysis": analysis
        })

    except Exception as e:
        logger.error(f"Chart analysis error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@finelo_bp.route("/api/finelo/ticker")
@login_required
def get_ticker_data():
    try:
        symbols = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "NVDA", "META", "SPY", "QQQ", "AMD", "NFLX", "JPM"]
        headers = get_alpaca_headers_for_user()

        if not headers.get("APCA-API-KEY-ID"):
            return jsonify({"status": "success", "tickers": []})

        url = f"{ALPACA_DATA}/stocks/snapshots"
        params = {"symbols": ",".join(symbols)}
        response = requests.get(url, headers=headers, params=params, timeout=10)

        if response.status_code != 200:
            return jsonify({"status": "success", "tickers": []})

        data = response.json()
        tickers = []

        for symbol, snapshot in data.items():
            daily_bar = snapshot.get("dailyBar", {})
            prev_daily = snapshot.get("prevDailyBar", {})
            latest_trade = snapshot.get("latestTrade", {})

            price = latest_trade.get("p", daily_bar.get("c", 0))
            prev_close = prev_daily.get("c", 0)
            change = price - prev_close if prev_close else 0
            change_pct = (change / prev_close * 100) if prev_close else 0

            tickers.append({
                "symbol": symbol,
                "price": round(price, 2),
                "change": round(change, 2),
                "change_pct": round(change_pct, 2)
            })

        tickers.sort(key=lambda x: x["symbol"])
        return jsonify({"status": "success", "tickers": tickers})

    except Exception as e:
        logger.error(f"Ticker data error: {e}")
        return jsonify({"status": "success", "tickers": []})


@finelo_bp.route("/api/finelo/simulator/trade", methods=["POST"])
@login_required
def simulator_trade():
    from models import SimulatorPortfolio, SimulatorTrade
    try:
        data = request.json
        symbol = data.get("symbol", "").strip().upper()
        side = data.get("side", "").lower()
        qty = int(data.get("qty", 1))

        if not symbol or side not in ["buy", "sell"]:
            return jsonify({"status": "error", "message": "Invalid trade parameters."})

        if qty < 1 or qty > 10000:
            return jsonify({"status": "error", "message": "Quantity must be between 1 and 10,000."})

        headers = get_alpaca_headers_for_user()
        if not headers.get("APCA-API-KEY-ID"):
            return jsonify({"status": "error", "message": "No trading account linked."})

        url = f"{ALPACA_DATA}/stocks/{symbol}/trades/latest"
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code != 200:
            return jsonify({"status": "error", "message": f"Could not get price for {symbol}."})

        price = r.json().get("trade", {}).get("p", 0)
        if not price:
            return jsonify({"status": "error", "message": f"No price data for {symbol}."})

        portfolio = SimulatorPortfolio.query.filter_by(user_id=current_user.id).first()
        if not portfolio:
            portfolio = SimulatorPortfolio(user_id=current_user.id, cash_balance=100000.0, initial_balance=100000.0)
            db.session.add(portfolio)

        total_cost = price * qty

        if side == "buy":
            if portfolio.cash_balance < total_cost:
                return jsonify({"status": "error", "message": f"Insufficient funds. Need ${total_cost:,.2f}, have ${portfolio.cash_balance:,.2f}."})
            portfolio.cash_balance -= total_cost
            trade = SimulatorTrade(
                user_id=current_user.id,
                symbol=symbol,
                side=side,
                qty=qty,
                price=price,
                total_value=total_cost,
                status="open"
            )
            db.session.add(trade)
        else:
            buy_trades = SimulatorTrade.query.filter_by(
                user_id=current_user.id, symbol=symbol, side="buy", status="open"
            ).order_by(SimulatorTrade.created_at.asc()).all()
            total_held = sum(t.qty for t in buy_trades)
            if total_held < qty:
                return jsonify({"status": "error", "message": f"Not enough shares. You hold {total_held} of {symbol}."})
            portfolio.cash_balance += total_cost

            remaining = qty
            for bt in buy_trades:
                if remaining <= 0:
                    break
                if bt.qty <= remaining:
                    remaining -= bt.qty
                    bt.status = "closed"
                else:
                    bt.qty -= remaining
                    remaining = 0

            trade = SimulatorTrade(
                user_id=current_user.id,
                symbol=symbol,
                side=side,
                qty=qty,
                price=price,
                total_value=total_cost,
                status="closed"
            )
            db.session.add(trade)

        portfolio.total_trades += 1
        db.session.commit()

        return jsonify({
            "status": "success",
            "message": f"{'Bought' if side == 'buy' else 'Sold'} {qty} {symbol} @ ${price:,.2f}",
            "trade": {
                "symbol": symbol,
                "side": side,
                "qty": qty,
                "price": price,
                "total": total_cost
            },
            "balance": portfolio.cash_balance
        })

    except Exception as e:
        logger.error(f"Simulator trade error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@finelo_bp.route("/api/finelo/simulator/portfolio")
@login_required
def simulator_portfolio():
    from models import SimulatorPortfolio, SimulatorTrade
    try:
        portfolio = SimulatorPortfolio.query.filter_by(user_id=current_user.id).first()
        if not portfolio:
            return jsonify({
                "cash": 100000.0,
                "initial": 100000.0,
                "total_trades": 0,
                "positions": []
            })

        trades = SimulatorTrade.query.filter_by(
            user_id=current_user.id, status="open"
        ).all()

        positions = {}
        for t in trades:
            if t.symbol not in positions:
                positions[t.symbol] = {"symbol": t.symbol, "qty": 0, "avg_price": 0, "total_cost": 0}

            if t.side == "buy":
                positions[t.symbol]["qty"] += t.qty
                positions[t.symbol]["total_cost"] += t.total_value
            else:
                positions[t.symbol]["qty"] -= t.qty
                positions[t.symbol]["total_cost"] -= t.total_value

        pos_list = []
        for sym, pos in positions.items():
            if pos["qty"] > 0:
                pos["avg_price"] = pos["total_cost"] / pos["qty"] if pos["qty"] else 0
                pos_list.append(pos)

        return jsonify({
            "cash": portfolio.cash_balance,
            "initial": portfolio.initial_balance,
            "total_trades": portfolio.total_trades,
            "positions": pos_list
        })

    except Exception as e:
        logger.error(f"Portfolio error: {e}")
        return jsonify({"cash": 100000.0, "initial": 100000.0, "total_trades": 0, "positions": []})


@finelo_bp.route("/api/finelo/simulator/reset", methods=["POST"])
@login_required
def simulator_reset():
    from models import SimulatorPortfolio, SimulatorTrade
    try:
        SimulatorTrade.query.filter_by(user_id=current_user.id).delete()
        portfolio = SimulatorPortfolio.query.filter_by(user_id=current_user.id).first()
        if portfolio:
            portfolio.cash_balance = 100000.0
            portfolio.total_trades = 0
        db.session.commit()
        return jsonify({"status": "success", "message": "Simulator reset to $100,000."})
    except Exception as e:
        logger.error(f"Simulator reset error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@finelo_bp.route("/api/finelo/chat/clear", methods=["POST"])
@login_required
def clear_chat():
    from models import ChatMessage
    try:
        ChatMessage.query.filter_by(user_id=current_user.id).delete()
        db.session.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})
