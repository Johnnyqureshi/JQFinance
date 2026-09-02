---
name: PostgreSQL pool resilience
description: Managed PostgreSQL restarts can terminate idle clients and briefly make the auth database unreachable.
---

Treat PostgreSQL connectivity as recoverable infrastructure, not a permanent application state. Pool-level disconnects must have an error listener, and startup initialization must retry before auth requests are rejected.

**Why:** A managed database restart previously emitted an unhandled pool error and a first-start connection timeout, which could crash the app and leave sign-in returning 503 until a manual restart.

**How to apply:** Keep auth readiness retryable with a short backoff, log only the error message, and verify both clean startup and an auth request after a transient database interruption.