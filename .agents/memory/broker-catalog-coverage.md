---
name: Broker catalog coverage
description: The safe way to make a large Alpaca asset catalog available without scanning every symbol on every refresh.
---

Use a stable, per-account snapshot of Alpaca active/tradable US equities and advance an in-memory per-account cursor through a fixed catalog lane. Market movers may add priority candidates, but must not determine or subtract from the rotation lane. Treat the priority quota as a maximum, not a reservation: unused mover slots must be filled by the catalog lane.

Alpaca's actual REST asset objects identify the asset class in the `class` field. A compatibility parser may also accept normalized `asset_class` records, but live broker validation must never require `asset_class` alone.

**Why:** Rebuilding a “catalog minus current movers” pool each refresh lets a changing mover list reshuffle offsets and indefinitely skip less-liquid, catalog-only symbols while falsely claiming full coverage. Separately, requiring the wrong asset-class field caused valid equities to pass strategy evaluation and then be withheld at the final broker gate.

**How to apply:** Report the snapshot timestamp, catalog size, selected count, and cursor batch honestly. Refreshing a catalog or restarting the service creates a new snapshot/cursor; each in-process batch must cover a disjoint lane until the cycle completes, using the whole configured scan budget when movers are sparse. Test broker-object parsing with Alpaca's real `class: "us_equity"` response shape.