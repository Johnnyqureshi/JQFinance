---
name: Shared production authentication
description: Authentication and sessions for autoscaled deployment instances.
---

Use the shared PostgreSQL database as the authoritative store for application identities and Express sessions. Keep legacy SQLite rows synchronized by user ID only as a compatibility bridge for the existing strategy data.

**Why:** Autoscaled instances do not share their local filesystem. SQLite-backed users or sessions can therefore make an account appear to register or log in on one instance but disappear on the next request.

**How to apply:** Any deployment-safe auth change must use the managed PostgreSQL schema flow and be verified with a create-account, fresh-session, and fresh-login round trip. Do not add startup database DDL; publish the development schema so the platform applies it to production.