---
name: Probability confluence safety gate
description: Shared deterministic signal rules for first-page analysis and automated momentum entries.
---

All directional UI signals and automatic momentum entries must consume the same server-side technical-confluence snapshot. Automated long entry is allowed only with a fresh snapshot, complete 1-minute/5-minute/15-minute/hourly/daily evidence, a critical invalidation level, and a confirmed high-confluence bullish setup. Missing or stale evidence must yield HOLD/NO TRADE, not a client-side directional fallback.

**Why:** A simplified search-page SELL conflicted with a support bounce, creating inconsistent trading guidance. The user explicitly requires support/resistance-aware, precise decision support.

**How to apply:** When adding or changing a trading signal, preserve the shared deterministic source. Narrative/AI output may explain it but must never raise its stage, invent an entry, or override a no-trade decision.
