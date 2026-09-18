---
name: Shared entry liquidity policy
description: Why liquidity configuration is shared and limited to entry research.
---

Keep liquidity thresholds centralized across scanner ranking and bot entry research, not independent browser filters. Apply them only to new-entry eligibility, never to sell signals or management of existing positions.

**Why:** A scanner-only filter can hide an illiquid symbol from the user while a bot still accepts it. Conversely, rejecting a research evaluation before it can emit a sell signal can trap an existing position. Strategy exits remain authoritative even when entry liquidity fails.

**How to apply:** Future settings interfaces should update the shared policy with validation rather than add local overrides. Keep an exit-preservation regression when altering candidate gates. Use actual current-session volume, not completed historical volume masquerading as today's turnover.

Yahoo retains regular-session price and volume outside regular trading hours, and a trade timestamp does not timestamp its bid/ask. Validate provider session identity and quote freshness independently; a fresh Alpaca quote likewise does not prove that its daily bar is from today.

**Why:** Otherwise yesterday's high turnover can admit an illiquid premarket candidate while the policy claims current-session liquidity.