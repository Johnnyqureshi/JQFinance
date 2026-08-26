---
name: Bot trade journal integrity
description: Reliability rules for persisting automated trade outcomes and calculating performance.
---

Automated trade performance is only realized after the broker confirms the completed fills. Create a durable, idempotent journal entry before submitting an automated buy, and persist the durable broker client order identifier before submitting an automated exit. Use those identifiers to reconcile interrupted submissions and reloads. Do not close or calculate P&L from a quoted price, accepted order, or a disappeared position.

Persist broker actions as a distinct pre-dispatch intent before calling the broker. An ambiguous protective-exit intent may only be re-dispatched with the exact same broker client order ID after lookup; an ambiguous entry must remain withheld rather than be re-submitted at a stale price. Aggregate confirmed partial exit fills and close only when the broker position is flat.

For an unprotected partially filled bracket parent, persist a cancellation intent and retry cancellation of the parent and every live stop/target child until the broker confirms they are terminal. Treat every nonterminal state—including `pending_cancel`—as still capable of filling; never submit the rescue market exit before that confirmation. Validate remaining bracket coverage against the current broker position, not the original entry size.

**Why:** A browser can miss an order response, market orders can fill at a different price or size than their estimate, and stop orders can slip. A process may also stop between persisting an intent and dispatching it; treating that as an accepted order can leave unprotected exposure or cause duplicate market exits. Treating any of those as a completed trade silently produces incorrect P&L and win-rate data.

**How to apply:** Keep entries pending until the parent buy is terminal, refresh entry price and quantity from broker fills/positions, and close a journal row only after the sell order reports its actual fill and the broker has no residual position. Retain a pending exit until it fills or the broker definitively rejects it. Load all open rows regardless of activity-history limits so reconciliation continues after a reload.