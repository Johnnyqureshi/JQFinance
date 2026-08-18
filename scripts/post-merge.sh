#!/bin/bash
set -e

# Post-merge setup — runs after any task branch is merged.
# Installs any new npm dependencies added by the merged task.

npm install --prefer-offline
