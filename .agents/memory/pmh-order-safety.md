---
name: PMH order safety
description: Durable safety rules for broker-managed Opening Momentum PMH orders.
---

Freeze the pre-market high only at or after the regular-session open, then keep it immutable for that user, symbol, and session. PMH entries must use a fresh executable ask with a bounded marketable limit and session-level idempotency reservation. Split the position into independently protected broker lots: a native bracket for the partial target and an OTO runner.

Treat broker mutation failures according to what is knowable. A definitive order rejection may restore the runner's stop after confirming residual shares. A timeout or cancellation race is ambiguous: reserve the state, reconcile by immutable client order ID, and never submit another sell or replacement stop until broker evidence proves which mutation occurred.

Until broker-race and partial-fill behavior has paper-trading evidence, keep PMH live submissions paused at the server boundary while allowing paper validation. Re-enabling live behavior must be an explicit operational decision, not a browser-side setting.

**Why:** An early pre-market snapshot can miss later highs, and a stale candle-price market order can exceed the intended risk. Browser-side partial exits and unverified stop cancellation can leave an orphan protective order or create unintended extra exposure.

**How to apply:** Block rather than infer whenever the PMH is not frozen, the executable quote is stale, an active session intent exists, or a stop cancellation is not terminal. Keep cancellation-unknown, exit-unknown, and protection-unresolved states distinct so reconciliation never mistakes uncertainty for protection. Reconcile journal P&L only from confirmed Alpaca fills.