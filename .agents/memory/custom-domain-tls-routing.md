---
name: Custom-domain TLS routing
description: Durable certificate-routing decision for the production custom domain.
---

Keep the apex custom-domain DNS record proxied through Cloudflare while retaining the verified Replit origin and verification TXT record.

**Why:** A DNS-only apex intermittently exposed the origin edge directly and an iPhone received a privacy/certificate warning even though the Replit deployment was healthy. Cloudflare Universal SSL was active and valid for both the apex and wildcard.

**How to apply:** When changing production DNS, preserve the current origin value and Replit verification record. Confirm the apex remains proxied, Universal SSL is active, public resolvers return Cloudflare edge addresses, and HTTPS returns a verified certificate plus HTTP 200.