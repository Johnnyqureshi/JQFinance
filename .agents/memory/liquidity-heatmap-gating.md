---
name: Unsupported liquidity heatmap gating
description: The liquidity heatmap must not appear until a real depth-capable market-data source is connected.
---

Keep the liquidity heatmap removed when the available providers cannot supply genuine order-book depth. Do not replace it with OHLCV-derived bars, Yahoo quotes, or an unavailable placeholder presented as a feature.

**Why:** The current market-data architecture does not provide Level 2 depth, and the user explicitly rejected false-positive feature modules.

**How to apply:** Reintroduce the UI only alongside a verified depth provider and clear provenance. Treat top-of-book as a separate, explicitly limited feature rather than a full heatmap.