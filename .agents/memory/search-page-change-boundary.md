---
name: Search page change boundary
description: Durable scope rule for Search-page market-context work
---

Market context, especially SPY, may adjust the existing Search signal confidence, but must not create new signal labels, cards, warnings, hierarchy, or layout changes. Preserve BUY/SELL, confidence presentation, Support & Resistance, gap analysis, tabs, and navigation. External providers may supply raw data, but our own evidence engines must own verdicts, levels, confidence, and strategies; user-facing Search output must not use speculative or hold/wait terminology. Support & Resistance must always show immediate and next levels in order, and the Trade Plan must use the same immediate support/resistance prices.

**Why:** The Search page's compact structure and binary signal presentation are intentional; expanding market context into a second visible decision system obscures critical levels and changes the user's workflow. Provider dependence in the decision layer would also make the product a passive data aggregator instead of its own decision machine.

**How to apply:** For future Search intelligence changes, modify the existing signal/confidence path first. Add visible UI only when explicitly requested, and keep it inside the existing structure.