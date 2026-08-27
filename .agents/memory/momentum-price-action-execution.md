---
name: Momentum price-action execution
description: Server-owned safety rules for compatible long-only Momentum price-action entries.
---

Automated Momentum entry safety is a server trust boundary: it must independently rebuild a compatible long-only price-action setup from broker data and must never trust a browser-supplied score, setup result, or stop calculation.

**Why:** A browser payload can be modified or become stale between scan and order submission. A client-selected route or flag cannot be an automation safety boundary.

**How to apply:** Require completed, fresh evidence; fail closed when market, relative-strength, VWAP, or volume data is incomplete; re-evaluate immediately before submission; and prevent a rounded protective stop from falling below structural invalidation. Persist enablement and configuration server-side, with one server-owned scheduler as the execution owner; the browser may display scans but must not be a second execution path. PMH remains a separate frozen-opening contract and cannot be upgraded by supplemental price-action context.