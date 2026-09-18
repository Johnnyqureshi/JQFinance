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
- B2 Paper starts automatically on verified connection or deliberate selection of a saved Paper account. Live connection/selection starts only with fresh explicit real-money consent for that action. Do not activate existing dormant accounts during migration or restart.
  **Why:** The user requested hands-off trading after connection on 2026-09-18, superseding the earlier paused-Paper onboarding decision; it does not authorize silently carrying an old Live arm across accounts.
  **How to apply:** Keep position dollars as the only strategy setting. Present authorization inside account connection rather than as a tunable strategy checkbox.
- Emergency pause must immediately revoke unsubmitted entries without invalidating protective actions already in flight. It must also prevent an earlier asynchronous connection/resume attempt from re-enabling entries afterward.
  **Why:** Waiting for a long scan lease delays the stop control; changing the general configuration revision can interrupt stop restoration after a confirmed cancellation and leave a position exposed.
  **How to apply:** Keep entry revocation and pending activation invalidation separate from account/protection identity, and recheck entry authorization at the final broker boundary. Already-submitted orders cannot be undone by toggling a local flag.

- The order API applies leverage server-side (`amount * leverage`). Clients must send the BASE dollar amount plus `leverage` — pre-multiplying on the client doubles leverage silently.
  **Why:** caused risk-cap checks to evaluate half the real exposure.
  **How to apply:** any new order-placing code sends un-levered `amount`; risk math uses `base * leverage` once.
- Safety gates in an autonomous trading path must FAIL CLOSED: if analysis/pattern data is unavailable, skip the trade rather than proceed on score alone.
- An entry safety signal must be enforced at the authenticated broker-order boundary, not only in browser automation; re-fetch fast-moving market evidence immediately before the broker POST.
  **Why:** a direct API caller or a delayed browser request can bypass an otherwise correct client-side gate.
  **How to apply:** use the strategy's broker credential scope on the server and fail the order when a final fresh-evidence recheck cannot confirm the constraint.
- Auto-trade cycles need a mutex — scans can be triggered by timer, manual refresh, and config changes concurrently, causing duplicate orders.
- Automated stock sells require a verified owned long position and residual quantity. Cancel only the strategy-owned protective sell with confirmed settlement before a separate closing sell; never cancel unrelated orders.
  **Why:** A surviving stop plus a full-quantity exit can oversell and open an unintended short.
  **How to apply:** Re-read fills and position size after cancellation, and reconcile ambiguous broker responses by durable client order ID.
- User decision: NO manual inverse button — the strategy trades any eligible instrument, including leveraged or inverse ETFs, through server automation rather than a separate manual control.
