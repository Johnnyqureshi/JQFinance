---
name: Broker credential vault
description: Rules for storing and rotating automated-strategy broker credentials.
---

Broker API keys and secrets must be stored as authenticated, versioned ciphertext derived from the deployment-wide session secret. Retain only a non-secret marker in legacy required plaintext columns, migrate an old plaintext record only when it is next used, and clear both ciphertext fields on disconnect. Do not use raw API keys in caches, logs, or response bodies.

**Why:** Multiple strategy accounts are long-lived and highly sensitive. A fresh migration should not invalidate existing connections, while weak storage or cache keys can expose reusable broker access.

**How to apply:** Encrypt every new credential write, decrypt only immediately before the authenticated broker request, fail closed if ciphertext is missing or tampered, and fingerprint credentials with a one-way digest when a cache needs an account discriminator.