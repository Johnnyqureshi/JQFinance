---
name: Bot trade journal integrity
description: Reliability rules for persisting automated trade outcomes and calculating performance.
---

Automated trade performance is only realized after the broker confirms the completed fills. Create a durable, idempotent journal entry before submitting an automated buy, and persist the durable broker client order identifier before submitting an automated exit. Use those identifiers to reconcile interrupted submissions and reloads. Do not close or calculate P&L from a quoted price, accepted order, or a disappeared position.

**Why:** A browser can miss an order response, market orders can fill at a different price or size than their estimate, and stop orders can slip. Treating any of those as a completed trade silently produces incorrect P&L and win-rate data.

**How to apply:** Keep entries pending until the parent buy is terminal, refresh entry price and quantity from broker fills/positions, and close a journal row only after the sell order reports its actual fill. Retain a pending exit until it fills or the broker definitively rejects it. Load all open rows regardless of activity-history limits so reconciliation continues after a reload.