---
name: Paused bot reconciliation
description: Safety boundary between disabling new automated entries and continuing broker-owned position protection.
---

An automation toggle may stop new entries, but it must not stop reconciliation, protective-order verification, or emergency recovery for positions and unresolved orders the strategy already owns.

**Why:** Treating “disabled” as an early return before reconciliation can strand an existing position even though the UI promises that pausing only prevents new trades.

**How to apply:** Discover scheduler users from both enabled settings and nonterminal strategy journals. Reconcile first when credentials are available; only then apply enabled, live-arm, and market-hours gates to new entries.