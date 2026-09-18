---
name: B2 broker protection constraints
description: Why B2 confirms daily candles and handles OTO protection conservatively
---

B2 confirms an actual SMA20/SMA50 transition on completed daily candles; the next regular session must independently pass current price, gain and volume gates. Its volume ratio is cumulative current volume divided by a full-session historical mean, not a time-of-day extrapolation.

**Why:** A forming daily crossover can disappear before the close, and extrapolated partial volume can overstate confirmation. The uploaded strategy specified day-based averages and quality over quantity.

**How to apply:** Keep the confirmation convention and volume provenance visible. Do not replace daily evidence with short intraday moving averages or turn bullish alignment into repeated entry events.

Live requires consolidated SIP market data. Paper prefers SIP, but may persist Alpaca IEX only after SIP returns HTTP 403 and a fresh valid IEX quote probe succeeds. Every evaluation must use the same selected feed for history, snapshots, final validation, and exit replay.

**Why:** Alpaca Paper accounts may lack paid SIP entitlement; blocking Paper prevented any strategy validation. Mixing SIP history with partial-exchange current volume would corrupt RVOL, while allowing IEX for Live would weaken real-money evidence.

**How to apply:** Never fallback for Live, authentication failures, malformed data, timeouts, or non-entitlement responses. Reset feed selection on account/mode changes, and show IEX limitations clearly.

Use broker-held GTC protection for a multi-day stock strategy, not DAY protection. Alpaca's OTO child is held until the parent is filled, and its documentation does not promise OTO replacement support. A tighter existing stop after price improvement should not be lowered merely to match a formula.

**Why:** DAY children expire at the close; pretending an unsupported OTO replacement succeeded or treating a held child as active can leave shares unprotected. A failed or ambiguous broker request is not evidence of rejection.

**How to apply:** Confirm broker states, handle partial fills explicitly, retain tighter active protection, distinguish definitive terminal failures from unknown acceptance, and renew expired protection only after settling prior orders. Tests must include real-evaluator service integration, not only mocked BUY signals. No software stop guarantees an exact loss limit across gaps or halts.