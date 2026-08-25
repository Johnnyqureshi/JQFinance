---
name: Bot Alpaca account isolation
description: Separation rule for every automated strategy broker connection.
---

Momentum Trader, Opening Momentum / PMH, and Candlestick Automation must connect through independent, strategy-scoped Alpaca credentials and active modes. An Alpaca account ID may not be used by any two bots or manual trading, including when it is accessed through separate API keys. A connected live account requires a new explicit arm after every credential, account, disconnect, or active-mode change.

**Why:** Separate client modules do not prevent strategy interference when both ultimately operate on the same broker account, symbols, positions, and protective orders.

**How to apply:** Keep bot-specific market-data, catalog, order, position, and reconciliation calls bound to their fixed strategy scope. Do not migrate or silently reuse legacy/manual credentials for any bot; each bot requires an explicit connection. Persist a live arm separately from credentials and revoke it whenever the connected identity changes.