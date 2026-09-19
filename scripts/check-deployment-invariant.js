'use strict';

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', '.replit');
const config = fs.readFileSync(configPath, 'utf8');
const deployment = config.match(/\[deployment\]([\s\S]*?)(?=\n\[|$)/)?.[1] || '';

if (!/^\s*deploymentTarget\s*=\s*"vm"\s*$/m.test(deployment)) {
  throw new Error('Deployment invariant failed: production must use deploymentTarget = "vm".');
}
if (!/^\s*run\s*=\s*\[\s*"node"\s*,\s*"scripts\/boot\.js"\s*\]\s*$/m.test(deployment)) {
  throw new Error('Deployment invariant failed: production must run node scripts/boot.js.');
}
const portBlocks = config.split('[[ports]]').slice(1).map(block => block.split(/\n\[\[/, 1)[0]);
const hasWebPort = portBlocks.some(block =>
  /^\s*localPort\s*=\s*5000\s*$/m.test(block)
  && /^\s*externalPort\s*=\s*80\s*$/m.test(block));
if (!hasWebPort) {
  throw new Error('Deployment invariant failed: local port 5000 must map to external port 80.');
}

console.log('Deployment invariant verified: VM, boot wrapper, and port mapping are configured.');