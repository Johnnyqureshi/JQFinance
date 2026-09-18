---
name: Retiring monolithic strategies
description: Safe removal pattern for a strategy embedded in the shared server and SQLite database
---

When removing an automated strategy from a monolithic trading server, first block its entire legacy API prefix and stop its scheduler, then disable its startup schema/migrations before dropping only that strategy’s local tables and records. Remove the dedicated browser assets and tests after the shared paths are protected. Never use broker APIs as part of local retirement unless the user explicitly authorizes reconciliation, cancellation, or flattening.

**Why:** Legacy handlers can remain textually present while the shared server is being decomposed; without an early route guard or disabled schema creation, stale clients or the next restart can reactivate the retired strategy or recreate its storage.

**How to apply:** Keep shared Momentum, Options, manual trading, and broker ownership data intact. Verify startup, removed prefixes, database table absence after restart, and the full remaining test suite.