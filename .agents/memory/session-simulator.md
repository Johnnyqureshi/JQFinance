---
name: Session simulator
description: End-to-end smoke suite for Qureshi Finance
---
Run `node scripts/simulate.js` against the running dev server. It registers/logs in a harness user, exercises auth, market data, the momentum scanner pipeline, five-pillar filter compliance, fail-closed order/bot safety gates, and the AI game plan shape. Exit 0 = all pass. **How to apply:** run before declaring the app healthy or publishing.
