---
name: Money Flow provider boundaries
description: Verified inputs available to Money Flow and the fields that must remain unavailable without a specialized feed.
---

The current Yahoo quote/chart paths provide price, completed OHLCV, relative-volume context, broad/sector price context, and published equity short-interest statistics when returned. They do not verify ETF creations/redemptions, ETF constituent weights, crypto open interest, funding, long/short positioning, or liquidation totals.

**Why:** Inferring these metrics from price and volume would misrepresent capital flow and derivatives activity.

**How to apply:** Keep Money Flow labels provenance-aware and fail closed for unsupported fields until a provider supplies timestamped, venue- or instrument-specific data.