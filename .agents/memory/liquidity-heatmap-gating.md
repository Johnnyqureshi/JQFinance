---
name: Unsupported liquidity heatmap and verified proxy
description: Full depth claims remain gated; a separate OHLCV structure proxy is allowed when its limits are explicit.
---

Keep the Level 2 liquidity heatmap, order-book walls, absorption, quote imbalance, and executed-flow claims removed when the available providers cannot supply genuine depth and trades. The approved replacement may show a separately named market-structure and liquidity proxy built from verified quote, completed OHLCV, VWAP, ATR, moving averages, relative volume, volume concentration, and structural support/resistance.

**Why:** The current market-data architecture does not provide Level 2 depth, but the user asked for useful verified context instead of repeated unavailable cards. A proxy is valuable only when it cannot be mistaken for observed order-book liquidity.

**How to apply:** Keep the old heatmap labels and unavailable feature cards retired. Label structural levels as structural, derive them from completed OHLCV, show missing inputs as unavailable, and include an explicit disclaimer that no Level 2, wall, absorption, imbalance, or aggressor-flow data is observed. If a genuine depth provider is later connected, treat that as a separate feature with its own provenance and tests.