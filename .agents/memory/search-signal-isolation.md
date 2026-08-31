---
name: Search signal isolation
description: Durable boundary and fail-safe rules for search-page volume analysis.
---

Search-page volume and price signals are read-only analysis. They must remain separate from bot confluence contracts, schedulers, entry gates, broker operations, and strategy settings. Search verdicts are binary BUY/SELL. Missing or stale evidence keeps the verdict provisional, caps confidence at 35%, and states the data gap instead of implying confirmation.

**Why:** Binary presentation must not hide weak evidence, and news alone must not substitute for mechanical price and volume confirmation.

**How to apply:** Keep bot-facing outputs unchanged. Use completed bars, same-time RVOL, acceleration, and verified pivots. Apply fresh news only when price and volume corroborate it; ignore stale, future-dated, or unassociated headlines.