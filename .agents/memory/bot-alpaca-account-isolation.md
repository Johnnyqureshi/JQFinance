---
name: Bot Alpaca account isolation
description: Separation rule for Momentum and Opening Momentum broker connections.
---

Momentum Trader and Opening Momentum / PMH must connect through independent, strategy-scoped Alpaca credentials and active modes. An Alpaca account ID may not be used by both bots, including when it is accessed through separate API keys.

**Why:** Separate client modules do not prevent strategy interference when both ultimately operate on the same broker account, symbols, positions, and protective orders.

**How to apply:** Keep bot-specific market-data, catalog, order, position, and reconciliation calls bound to their fixed strategy scope. Do not migrate or silently reuse legacy/manual credentials for either bot; each bot requires an explicit connection.