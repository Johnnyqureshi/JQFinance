---
name: Search Smart Money maps
description: Durable integrity rules for Search-only institutional-zone context.
---

Smart Money maps are supporting context inside Stock Intelligence. They must never become a second BUY/SELL verdict or feed automated strategy and execution logic.

**Why:** Zone detection is probabilistic price-action analysis, not evidence of actual institutional orders. Presenting it as an authoritative signal or sharing it with bots would overstate what completed OHLCV can prove.

**How to apply:** Use only completed canonical periods. A 4H bar must contain four complete hourly bars; weekly/monthly bars close at real calendar boundaries. Build confluence deterministically from the same requested market snapshot, never from whichever timeframes happen to be cached.