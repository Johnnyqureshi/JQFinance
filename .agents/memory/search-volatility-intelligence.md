---
name: Search volatility intelligence
description: Durable safety boundary for volatility evidence on the Search page.
---

Volatility intelligence is additive context for the existing Search decision path. It may make a bounded numerical confidence adjustment, but it must never create a second verdict or alter the established signal label, direction, stage, trade levels, or readiness gates. The feature remains disabled unless explicitly enabled.

**Why:** Volatility and inferred options positioning can be useful context, but provider gaps, stale daily index values, and model assumptions make them unsafe as standalone confirmation. A missing or stale source must be visibly unavailable rather than silently converted to zero.

**How to apply:** Preserve source timestamps, freshness, completeness, and provider labels. Apply no confidence influence when inputs are unavailable, stale, or below the completeness threshold. Label Yahoo data as a fallback rather than official Cboe data, and describe gamma positioning as inferred rather than observed.