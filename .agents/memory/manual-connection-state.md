---
name: Manual connection state
description: The manual trading UI must refresh its server-authoritative Paper/Live account map after broker credential changes.
---

After saving or disconnecting manual Alpaca credentials, refresh the credentials endpoint before rendering connection status or mode-switch controls. The active mode can change while another mode remains stored, so local booleans are not authoritative.

**Why:** A local-only state update left the Paper/Live switcher advertising stale credentials until a page reload, even though the server had already accepted the change.

**How to apply:** Treat the credentials response as the source of truth for active mode and per-mode availability after connect, disconnect, or mode changes.