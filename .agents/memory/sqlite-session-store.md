---
name: SQLite session store
description: Why persistent sessions use the built-in better-sqlite3 store instead of connect-sqlite3.
---

Use the local `better-sqlite3` session store for persistent Express sessions; it intentionally retains the existing `sessions` table schema so signed-in sessions survive the dependency migration.

**Why:** `connect-sqlite3` was constrained to the vulnerable sqlite3 v5/node-gyp dependency chain, including critical tar audit findings. The project already relies on maintained `better-sqlite3`.

**How to apply:** Keep session expiry checks fail-closed and cover get/set/touch/destroy behavior when changing authentication persistence. Do not reintroduce `connect-sqlite3` merely to simplify configuration.