---
name: Automatic bot context authority
description: Defines the boundary between shared market evidence and strategy execution rules.
---

Shared automatic-bot context is advisory by default. Missing and stale sources must be explicit and their data withheld; a strategy may block entries only through its own named policy with declared required sources.

**Why:** Centralized provider and freshness logic prevents inconsistent evidence, but silently applying shared sizing, direction, stop, target, or lifecycle changes would alter independently validated strategies.

**How to apply:** Publish normalized sources through the common contract. Keep entry, sizing, stop, target, exit, and lifecycle decisions inside each strategy, and require an explicit strategy policy before shared context can block an entry.