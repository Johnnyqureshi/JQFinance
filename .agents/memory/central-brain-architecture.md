---
name: Central brain architecture
description: Product architecture for shared market context and per-user strategy execution
---

The platform has one shared market-intelligence and portfolio-risk context layer, while each bot retains its own strategy decision and execution logic. News, sentiment, seasonality, Federal Reserve/macro conditions, market regime, and correlated-exposure checks inform strategies but do not silently rewrite their rules.

**Why:** Users need different products (long-term, day trading, and LEAPS), so a single generic strategy would erase meaningful strategy differences. Shared context keeps the system coordinated without coupling bot logic.

**How to apply:** A valid dedicated broker connection selects/activates a bot. Multiple connected Paper bots may run concurrently for comparison; only one Live bot may be armed and active per user. Credentials never arm Live trading. PMH and UltraBot3 are competing Paper/shadow day-trading candidates and should be compared on risk-adjusted results, drawdown, consistency, and execution/protection reliability.