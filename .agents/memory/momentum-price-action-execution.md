---
name: Momentum price-action execution
description: Server-owned safety rules for compatible long-only Momentum price-action entries.
---

Momentum automation must enter through its dedicated server-owned execution path, which independently rebuilds a compatible long-only price-action setup from broker data. It must never trust a browser-supplied automation flag, score, setup result, or stop calculation.

**Why:** A browser payload can be modified or become stale between scan and order submission. A client-selected route or flag cannot be an automation safety boundary.

**How to apply:** Require a newly completed five-minute bar within a short post-close window, fail closed when market/relative-strength/VWAP/volume evidence is incomplete, re-evaluate immediately before broker submission, and compare the exact rounded broker stop price against the freshly computed structural invalidation. Manual orders remain a separate path; PMH's frozen opening contract remains independent and cannot be upgraded by supplemental price-action context.