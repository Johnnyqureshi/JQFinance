---
name: Broker catalog coverage
description: The safe way to make a large Alpaca asset catalog available without scanning every symbol on every refresh.
---

Use a stable, per-account snapshot of Alpaca active/tradable US equities and advance an in-memory per-account cursor through a fixed catalog lane. Market movers may add priority candidates, but must not determine or subtract from the rotation lane.

**Why:** Rebuilding a “catalog minus current movers” pool each refresh lets a changing mover list reshuffle offsets and indefinitely skip less-liquid, catalog-only symbols while falsely claiming full coverage.

**How to apply:** Report the snapshot timestamp, catalog size, selected count, and cursor batch honestly. Refreshing a catalog or restarting the service creates a new snapshot/cursor; each in-process batch must cover a disjoint lane until the cycle completes.