---
name: Automatic trading controls
description: Durable safety and ownership rules for every automated trading strategy
---
# Automatic trading controls

- All strategy thresholds, filters, universes, stop/target formulas, risk limits, and scan limits are server-owned. The only user-editable strategy value is maximum dollars per position.
  **Why:** browser-persisted tuning creates inconsistent behavior and lets stale or direct requests weaken automated safety policy.
  **How to apply:** rebuild execution config from server defaults on every read/write and copy only the validated position-dollar override; ignore all other submitted fields.
- Candidate pages are observational. A server scheduler is the sole owner of automated candidate selection and entry submission; strategy-specific browser entry endpoints stay closed.
  **Why:** browser-owned submissions create duplicate execution owners, stop when tabs close, and can bypass persisted enable, sizing, or Live-arm controls.
  **How to apply:** UI scans may refresh evidence and request reconciliation, but must not submit entries or automated exits. Scheduler functions call execution functions directly under strategy locks.
- A verified dedicated Paper connection enables that strategy automatically. Connecting or switching to Live never arms orders; every broker identity or mode change clears the prior Live arm.
  **Why:** Paper should be hands-off while Live requires an explicit, current authorization that cannot carry across account changes.
  **How to apply:** Paper credential verification updates persisted enablement; Live eligibility checks both enabled state and a separately persisted arm before any broker POST.

- The order API applies leverage server-side (`amount * leverage`). Clients must send the BASE dollar amount plus `leverage` — pre-multiplying on the client doubles leverage silently.
  **Why:** caused risk-cap checks to evaluate half the real exposure.
  **How to apply:** any new order-placing code sends un-levered `amount`; risk math uses `base * leverage` once.
- Safety gates in an autonomous trading path must FAIL CLOSED: if analysis/pattern data is unavailable, skip the trade rather than proceed on score alone.
- An entry safety signal must be enforced at the authenticated broker-order boundary, not only in browser automation; re-fetch fast-moving market evidence immediately before the broker POST.
  **Why:** a direct API caller or a delayed browser request can bypass an otherwise correct client-side gate.
  **How to apply:** use the strategy's broker credential scope on the server and fail the order when a final fresh-evidence recheck cannot confirm the constraint.
- VWAP confirmation for a momentum entry is regular-session-only (9:30 AM–4:00 PM New York time) and needs a timestamp-fresh executable/current quote; exclude premarket, after-hours, and prior-session bars.
  **Why:** rolling intraday windows or stale snapshot prices can make price appear above an obsolete VWAP and permit the exact reversal entry the gate is meant to prevent.
  **How to apply:** use a session-bounded VWAP calculation and reject a missing, stale, or implausibly future-dated quote before comparing it with VWAP.
- Auto-trade cycles need a mutex — scans can be triggered by timer, manual refresh, and config changes concurrently, causing duplicate orders.
- Signal filtering must accept both `BUY` and `STRONG BUY`; strict `=== 'BUY'` silently excluded the highest-scoring setups.
- Pre-trade gate order: signal → dump flags (hard: high-vol red candle or large topping tail; soft: 2+ of below-VWAP/below-EMA9/MACD-neg) → bearish pattern strength ≥2 → risk ≤5% of equity.
- NO-SHORT policy: platform never opens shorts. Sells require a verified held position, are quantity-based, and cancel the symbol's open orders first (else a leftover OTO stop-loss child could later flip short).
- User decision: NO manual inverse button — the strategy trades any eligible instrument, including leveraged or inverse ETFs, through server automation rather than a separate manual control.
- Gotcha: server-side calcRSI was referenced in 3 endpoints but never defined — try/catch silently nulled RSI everywhere for a long time. Watch for other referenced-but-undefined helpers hidden by catch(_){}.
