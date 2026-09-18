---
name: Retired strategy comparisons
description: Safety boundary for evaluating removed automated strategies without restoring them.
---

Comparisons involving retired strategies must use a neutral, read-only Paper/shadow evidence contract with shared capital, risk, cost, period, and quality rules. A comparison must not restore retired routes, credentials, schedulers, storage, or broker operations.

**Why:** Historical strategy names may still be useful for research, but their automated execution systems were deliberately removed. Reintroducing those systems just to benchmark them would violate the trading boundary and could interfere with active accounts.

**How to apply:** Accept isolated, strategy-tagged evidence; require confirmed fills and complete protection/exit records; report insufficient evidence rather than infer a winner; keep all comparison endpoints read-only and outside retired API prefixes.