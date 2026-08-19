---
name: Auto-trade safety gates
description: Pre-trade gating rules and pitfalls for the momentum bot's auto-trade path
---
# Auto-trade safety gates

- The order API applies leverage server-side (`amount * leverage`). Clients must send the BASE dollar amount plus `leverage` — pre-multiplying on the client doubles leverage silently.
  **Why:** caused risk-cap checks to evaluate half the real exposure.
  **How to apply:** any new order-placing code sends un-levered `amount`; risk math uses `base * leverage` once.
- Safety gates in an autonomous trading path must FAIL CLOSED: if analysis/pattern data is unavailable, skip the trade rather than proceed on score alone.
- Auto-trade cycles need a mutex — scans can be triggered by timer, manual refresh, and config changes concurrently, causing duplicate orders.
- Signal filtering must accept both `BUY` and `STRONG BUY`; strict `=== 'BUY'` silently excluded the highest-scoring setups.
- Pre-trade gate order: signal → dump flags (hard: high-vol red candle or large topping tail; soft: 2+ of below-VWAP/below-EMA9/MACD-neg) → bearish pattern strength ≥2 → risk ≤5% of equity.
- NO-SHORT policy: platform never opens shorts. Sells require a verified held position, are quantity-based, and cancel the symbol's open orders first (else a leftover OTO stop-loss child could later flip short).
- User decision: NO manual inverse button — bot trades anything passing criteria (leveraged/inverse ETFs included) fully automatically. Users only set position size, stop loss, take profit.
- Exit model: bot entries are OTO orders (market buy + 5% stop-loss leg only, integer qty); take profit is an RSI(14, 1-min) ≥ configurable level (default 75) checked by the 20s position poller, which needs an in-flight mutex or overlapping polls double-sell.
- Criteria per user (final): price $3–$20, gain ≥10% gate with +1 bonus at ≥30%, relVol ≥5×/10×, news, float <5M ideal (scores point) with 10M hard ceiling. Legacy saved minPrice:2 auto-migrates to 3.
- Gotcha: server-side calcRSI was referenced in 3 endpoints but never defined — try/catch silently nulled RSI everywhere for a long time. Watch for other referenced-but-undefined helpers hidden by catch(_){}.
