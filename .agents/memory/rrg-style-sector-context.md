---
name: RRG-style sector context
description: Product boundary for using public market data to show rotation context without claiming official RelativeRotationGraphs output.
---

Use RRG-style sector context only as an additive, read-only visualization derived from completed sector ETF and benchmark closes. Do not present it as official JdK RRG data, scrape authenticated chart endpoints, or let it create trading signals.

**Why:** RelativeRotationGraphs.com does not expose an unauthenticated public data feed; its exact API and online service are licensed products.

**How to apply:** Keep any derived RS-ratio and RS-momentum display labeled as an approximation, disclose the benchmark and completed-bar method, and keep Search and automated execution authoritative.