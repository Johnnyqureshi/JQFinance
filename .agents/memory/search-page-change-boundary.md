---
name: Search page change boundary
description: Durable scope rule for Search-page market-context work
---

Market context, especially SPY, may adjust the existing Search signal confidence, but must not create new signal labels, cards, warnings, hierarchy, or layout changes. Preserve BUY/SELL, confidence presentation, Support & Resistance, gap analysis, tabs, and navigation.

**Why:** The Search page's compact structure and binary signal presentation are intentional; expanding market context into a second visible decision system obscures critical levels and changes the user's workflow.

**How to apply:** For future Search intelligence changes, modify the existing signal/confidence path first. Add visible UI only when explicitly requested, and keep it inside the existing structure.