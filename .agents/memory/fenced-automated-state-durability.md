---
name: Fenced automated-state durability
description: Non-negotiable durability rules for synchronous automated trading state across VM lifecycle events.
---

Keep B2 and LEAP state isolated in a dedicated SQLite image, but treat PostgreSQL as the durable authority through a single-writer lease, monotonically generated checksummed snapshots, and durable action intent before every broker mutation. A broker or control-plane success must not be acknowledged before its resulting local state is checkpointed.

**Why:** VM-local files can disappear across republishes, while a direct asynchronous repository conversion would break deeply synchronous strategy lifecycles. A periodic backup is insufficient because a broker action can outlive the state that justified or records it. First cutover also crosses two SQLite files, so WAL cannot provide crash-atomic copy-and-remove semantics.

**How to apply:** Restore only while holding the fence; fail closed on lease, checksum, generation, or checkpoint failure; reconcile ambiguous intents rather than retrying blindly; preserve protection while entries are paused; use rollback journals for the one-time attached-database cutover and enable WAL only after it commits. Keep B2 and LEAP credentials, ownership, intents, and schedulers separate.