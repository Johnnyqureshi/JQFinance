---
name: Search gaps and patterns
description: Safety rules for Search-page gap statistics and chart-pattern evidence.
---

Search gap zones and fill percentages must use completed daily sessions and true range gaps. A fill percentage is a stock-specific historical full-traversal rate over a stated horizon, not a promise that the current gap will fill.

**Why:** Live/forming daily candles and provider market-state errors can repaint gaps and pattern signals. A price trading inside an open gap must be shown as an in-progress traversal rather than reported as no gap.

**How to apply:** Fail closed before the regular close using the exchange clock. Pattern evidence from completed daily and intraday bars may adjust a Search BUY/SELL read, but it must not independently upgrade the signal to confirmed or alter bot execution rules.