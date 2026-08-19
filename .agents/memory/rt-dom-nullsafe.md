---
name: Realtime trader null-safe DOM writes
description: realtimetrader.js uses setSafe/setCls helpers; direct DOM writes crash when panel is unmounted
---

## The rule

Never write `$(id).textContent = val` or `$(id).className = cls` directly in realtimetrader.js.
Always use the helpers defined near the top of the module:

```js
const setSafe = (id, val) => { const e = $(id); if (e) e.textContent = String(val); };
const setCls  = (id, cls) => { const e = $(id); if (e) e.className   = cls; };
```

## Why

The realtime trader panel can be unmounted from the DOM when the user navigates away.
Any direct `$('rtXxx').textContent = ...` call on a missing element throws `Cannot set properties of null`.
This was causing silent JS errors on every panel refresh cycle.

## What's guarded vs not

- `setSafe`/`setCls` covers: rtVerdict, rtConf, rtSym, rtReason, rtVwap, rtVwapSub, rtVol, rtVolSub, rtSent, rtSentSub, rtUpdated, rtVPPoc, rtVPVah, rtVPVal
- `if (panel) return;` guards: renderPrediction (lines 581+) — all writes inside are safe
- `if (pocEl)`, `if (zoneEl)`, `if (imp)` guards: volume profile and pivot zone writes — safe
- RSI, Support, Resistance: already guarded by `if (rtRsiEl)`, `if (rtSupportEl)` etc (elements removed from HTML)

**How to apply:** Any new metric cells added to realtimetrader.js MUST use `setSafe`/`setCls` for their DOM writes.
