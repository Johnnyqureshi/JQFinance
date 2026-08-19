---
name: 5-pillar scanner system
description: How the momentum scanner enforces 5 hard filters and scores stocks 0-7
---

## The 5 Pillars

All five must pass as hard filters before a stock appears in results.

| # | Pillar | Hard filter | Score bonus |
|---|---|---|---|
| 1 | Price $2–$20 | filter() rejects outside range | none (now a gate, not a point) |
| 2 | Daily gain ≥ 10% | filter() rejects < minGainPercent | +2 (≥10%), +1 more (≥20%) |
| 3 | Rel Vol ≥ 5× | filter() rejects < minRelVol | +1 (≥5×), +1 more (≥10×) |
| 4 | News catalyst | scan() filters after Pass 2 async check | +1 |
| 5 | Float < 10M shares | filter() rejects floatSh > maxFloat (only if floatSh known) | +1 |

Max score: 7. Min score default: 4.

## Config defaults (momentum.js)

```js
minPrice: 2.00, maxPrice: 20.00,
minGainPercent: 10.0, minRelVol: 5.0,
requireNewsCatalyst: true, maxFloat: 10_000_000,
minScore: 4
```

## Key behaviours

- `floatSh` comes from Yahoo Finance `floatShares` field — unreliable, often null. When null, stock is ALLOWED through P5 (don't punish missing data).
- News filter uses graceful bypass: if ALL news fetches fail (API down), skip the filter entirely to avoid zero results.
- Scoring rvol tiers are ≥5× (+1) and ≥10× (+1 bonus), NOT the old ≥2×/≥5× tiers.
- Price range is a hard gate — no longer awards +1 score point.

**Why:** Low-float stocks with news catalysts are the highest-probability momentum setups. All 5 pillars must co-exist for the setup to be valid.
