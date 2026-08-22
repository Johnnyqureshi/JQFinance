---
name: Broker entry capacity
description: Safety rules for shared buy capacity and ambiguous multi-lot broker submissions.
---

All pending BUY parent orders consume shared entry capacity; failure to list open orders is a no-entry state. A PMH trade uses two independently protected parent lots, so it must reserve two available units atomically before either lot is submitted. Persist each client order ID before submitting its POST and reconcile by client ID whenever an order ID is unavailable.

**Why:** Counting only bracket parents admits simple or OTO entries beyond the account-wide limit. A network timeout after a broker POST is ambiguous, and treating it as a definite rejection can orphan an accepted entry.

**How to apply:** Any new entry route acquires the shared entry lock, verifies open positions and pending buys with Alpaca, then reserves the number of parent buy orders it will submit. Do not bypass equity validation or market-hours checks based on loose ticker suffix heuristics.