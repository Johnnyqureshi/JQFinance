---
name: PMH server-side automation scheduler
description: How Opening Momentum (PMH) automation was moved from browser-dependent to always-on server-side, and the pattern to reuse for any other bot that needs the same fix.
---

Before August 2026, only UltraBot3 (candlestick) had a true always-on server scheduler. Momentum and PMH's auto-trade loops were client-only (`setInterval` gated on a browser-held `enabled`/`botEnabled` flag), so they stopped scanning, entering, and reconciling the moment the browser tab closed — despite each having a working, non-trivial safety-gated execution path.

PMH was fixed by extracting its route handlers into standalone async functions (`executePmhEntry(userId, symbol, source)`, `reconcilePmhTrades(userId)`) that the HTTP routes now call, and adding a `setInterval` scheduler (in server.js, alongside the pre-existing candlestick scheduler) that: iterates users with `pmh_settings.enabled=1`, acquires the shared `acquireBotLock`, always runs reconciliation (fills/exits must be recorded even when the market is closed or no one is watching), then during market hours scans the default symbol list, picks the top eligible candidate, and calls the same execute function a manual click would.

**Why:** This is the minimal, low-risk way to make a bot's automation survive a closed browser tab — reuse the exact server-side decision/execution logic that already exists behind the manual "click to trade" button, don't rewrite the strategy.

**How to apply:** Momentum's automation still has this exact gap (deliberately deferred — see task "Keep the Momentum bot trading automatically without a browser tab open") because its scoring engine is ~2,900 lines of client-only JS, not a thin server route — that one is a genuine rewrite, not an extraction. Use this same extract-then-schedule pattern for Momentum once server-side scoring exists. Also note: PMH's scheduler has no live-arm confirmation gate (unlike candlestick's `live_armed`), which is a known follow-up.
