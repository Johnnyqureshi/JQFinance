---
name: Replit cache cleanup
description: Safe cleanup boundary for generated workspace caches and provisioned language runtimes.
---

Never delete the workspace `.cache` directory wholesale during storage cleanup. It can contain the materialized Replit language runtime even when the module registry still reports that runtime as installed.

**Why:** Clearing all cache contents removed `node` and `npm` from new shell processes while an already-running Node workflow continued serving, creating hidden restart and publish risk. Reinstalling the registered Node module restored the toolchain.

**How to apply:** Clean only identified disposable subdirectories. After any cache cleanup, verify the required runtime and package manager in a new shell before restarting workflows or declaring the cleanup safe.