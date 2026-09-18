---
name: Search entry-quality gating
description: Durable rules separating bullish trend evidence from whether a new Search entry is safe now.
---

Search must treat trend, momentum, volume, entry location, support/resistance, extension risk, and market context as separate evidence. A bullish trend can produce `BULLISH — EXTENDED` or `BREAKOUT WATCH` without authorizing a BUY.

Confirmed breakouts do not bypass entry safeguards. An immediate entry exception requires measured room to the next resistance, favorable measured risk/reward, sustained non-fading volume, and complete core entry inputs.

Unavailable weighted inputs contribute zero and stay explicitly unavailable. They must never become a neutral or favorable synthetic score.

**Why:** Pumping assets can have real bullish structure and confirmed volume while still offering a poor new entry. Treating missing measurements as favorable or allowing breakout status to override chase risk recreates high-confidence chase signals.

**How to apply:** Keep this logic confined to Search. Preserve bot strategy contracts. Any future Search confidence wrapper must retain the direction-correct component weights and must not replace unavailable context with a neutral midpoint.