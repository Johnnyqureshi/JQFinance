---
name: Search prediction-market integrity
description: Data-discovery, labeling, and failure rules for prediction-market evidence on Search.
---

Search prediction-market evidence must come from Kalshi’s official public API. Discover relevant contracts through category and series metadata rather than assuming the first pages of the global open-market list are representative.

**Why:** The global catalog is dominated by short-duration contracts; bounded first-page scans can miss relevant economic markets and falsely imply that none exist. Prediction-market probabilities are also market prices, not guaranteed forecasts.

**How to apply:** Match queries against series metadata, fetch open contracts for relevant series, cache backend results, and expose source, status, and timestamp. Never substitute a probability when no relevant contract exists or the provider fails. Keep this context Search-only and separate from automated trading.