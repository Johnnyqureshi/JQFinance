---
name: Search liquidity truthfulness
description: Market-microstructure boundaries for Search liquidity and direction analysis.
---

Treat venue-limited top-of-book snapshots as partial, low-weight context only. Use a timestamp-validated quote midpoint for liquidity scoring. Do not infer aggressor side from asynchronous quote/trade snapshots or relabel technical levels as liquidity support/resistance. Keep Level 2 walls, wall lifecycle, absorption, and full-market depth unavailable until a genuine sequenced depth-and-trades feed exists.

**Why:** Resting quotes can move or cancel, venue-only data is not NBBO, and independently timed trades and quotes cannot reliably establish who initiated a trade. Overstating these inputs can create false directional confidence.

**How to apply:** Any future Search heatmap or provider integration must expose venue and freshness, preserve individual score components, fail closed on stale or malformed data, and leave the canonical Search verdict unchanged unless separately approved.