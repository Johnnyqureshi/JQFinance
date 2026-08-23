---
name: Shared production authentication and state
description: Production persistence boundaries for identities, sessions, and trading state.
---

Use the shared PostgreSQL database as the authoritative store for application identities and Express sessions. Deploy the application as one always-running VM while user-owned broker connections, bot settings, watchlists, and trade journals remain in SQLite.

**Why:** Autoscaled instances do not share their local filesystem. Any remaining SQLite trading state can therefore disagree across instances, including the broker credentials and journals that drive automated orders. A single VM keeps that state coherent until a full shared-database migration is complete.

**Isolation rule:** If the shared PostgreSQL identity and local SQLite compatibility row disagree on either user ID or username, fail closed. Never overwrite or attach the local row, because it may own another user's broker settings and trading data.

**How to apply:** Keep `SESSION_SECRET` deployment-managed and stable. Verify auth changes with a create-account, fresh-session, and fresh-login round trip. Do not switch the deployment target back to autoscale until all user-owned trading state has migrated off local SQLite.