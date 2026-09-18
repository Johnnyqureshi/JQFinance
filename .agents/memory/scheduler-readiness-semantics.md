---
name: Scheduler readiness semantics
description: Durable status rules for server-owned automated trading cycles
---

An automated trading UI must distinguish broker connection, saved automation authorization, market-hours verification, scheduler eligibility, and the exact reason entries are withheld. A missing credential or pre-scan broker/data failure must also leave a bounded persisted cycle/symbol outcome rather than looking idle.

**Why:** A green connection label and an enabled setting can coexist with missing broker data, a closed market, stale evidence, or a scheduler that never ran. Silent returns make operators believe a paper verification or production cycle happened when it did not.

**How to apply:** Keep reconciliation independent from new-entry eligibility, fail closed at the broker boundary, persist safe non-secret blocker text, and expose a separate `entryReadyNow`/scheduler eligibility state in both the server response and the browser.