#!/bin/bash
set -e

# Post-merge setup — runs after any task branch is merged.
# Installs any new npm dependencies added by the merged task.

node scripts/check-deployment-invariant.js
npm install --prefer-offline
npm run db:push
