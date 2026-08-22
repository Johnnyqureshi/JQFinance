---
name: PMH order safety
description: Durable safety rules for broker-managed Opening Momentum PMH orders.
---

Freeze the pre-market high only at or after the regular-session open, then keep it immutable for that user, symbol, and session. PMH entries must use a fresh executable ask with a bounded marketable limit and session-level idempotency reservation. Split the position into independently protected broker lots: a native bracket for the partial target and an OTO runner.

**Why:** An early pre-market snapshot can miss later highs, and a stale candle-price market order can exceed the intended risk. Browser-side partial exits and unverified stop cancellation can leave an orphan protective order or create unintended extra exposure.

**How to apply:** Block rather than infer whenever the PMH is not frozen, the executable quote is stale, an active session intent exists, or a stop cancellation is not terminal. Reconcile journal P&L only from confirmed Alpaca fills.