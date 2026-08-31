---
name: Search signal isolation
description: Durable boundary and fail-safe rules for search-page volume analysis.
---

Search-page volume and price signals are read-only analysis. They must remain separate from bot confluence contracts, schedulers, entry gates, broker operations, and strategy settings. Directional search signals require fresh, completed 1-minute, 5-minute, and 15-minute acceleration windows plus a valid same-time historical volume baseline. Missing or stale required evidence must produce an explicit no-trade result.

**Why:** The search page is intended to help a trader interpret live participation without silently changing any automated strategy. Forming candles and partial timeframe coverage can otherwise create false breakout confirmations.

**How to apply:** Extend search analysis through its dedicated response object and UI only. Keep bot-facing outputs unchanged, use completed bars for structure and follow-through, and treat high volume as participation until price direction confirms control.