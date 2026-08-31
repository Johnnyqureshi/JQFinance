---
name: Search signal isolation
description: Durable boundary and fail-safe rules for search-page volume analysis.
---

Search-page volume and price signals are read-only analysis. They must remain separate from bot confluence contracts, schedulers, entry gates, broker operations, and strategy settings. Search verdicts are binary BUY/SELL. Missing or stale evidence keeps the verdict provisional, caps confidence at 35%, and states the data gap instead of implying confirmation. Every visible Search panel must consume one timestamped server snapshot; generative narrative and unsupported default probabilities must not supplement the verdict.

Support and resistance are conditional thresholds, never automatic order instructions. Display direction as BULLISH/BEARISH. Search presents one nearest resistance and support, plus optional next-level breakout/breakdown confirmations. Resistance may be labeled bullish only above a confirmed break-and-hold; support may be labeled bearish only below a confirmed break-and-hold.

**Why:** Binary presentation must not hide weak evidence, parallel client fetches can make panels disagree, and news or generative prose must not substitute for mechanical price and volume confirmation.

**How to apply:** Keep bot-facing outputs unchanged. Share the authoritative Search response across header, signal, realtime, game-plan, and news views. Use completed bars, same-time RVOL, acceleration, and verified pivots. Label levels “BULLISH ABOVE” and “BEARISH BELOW” with confirmation language—not BUY/SELL triggers. Apply fresh entity-linked news only when price and volume corroborate it; ignore stale, future-dated, or unassociated headlines.