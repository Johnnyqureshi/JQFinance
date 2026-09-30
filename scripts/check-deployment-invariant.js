'use strict';

// Deployment invariant: production must boot through scripts/boot.js (durable
// snapshot restore + single-instance fence). This is what bit us on
// 2026-09-28, when Railway ran `node server.js` directly and every deploy
// silently wiped automated-trading.db.
//
// Railway's entrypoint is package.json "start" (the old Replit .replit config
// this script used to read is a dead artifact now), so that is what we check.

const path = require('path');

const pkg = require(path.join(__dirname, '..', 'package.json'));

const start = pkg && pkg.scripts && pkg.scripts.start;
if (start !== 'node scripts/boot.js') {
  throw new Error(
    `Deployment invariant failed: package.json "start" must be "node scripts/boot.js" (got ${JSON.stringify(start)}).`
  );
}

console.log('Deployment invariant verified: package.json start runs scripts/boot.js.');
