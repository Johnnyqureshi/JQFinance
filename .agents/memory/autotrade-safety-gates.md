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
