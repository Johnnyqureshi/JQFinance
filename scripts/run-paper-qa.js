#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runPaperQa } = require('../lib/paper-broker-qa');

const report = runPaperQa();
const outputArg = process.argv.find(arg => arg.startsWith('--output='));
const outputPath = outputArg ? outputArg.slice('--output='.length) : null;

if (outputPath) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote deterministic QA report to ${absolute}`);
}

console.log('Trading Bot Paper QA');
console.log('====================');
console.log(`Mode: ${report.mode}`);
console.log(`Live orders placed: ${report.liveOrdersPlaced ? 'YES' : 'NO'}`);
console.log(`Scenarios: ${report.total} total · ${report.passed} passed · ${report.failed} failed`);
console.log(`Strategy/scanner regressions: ${report.regressions.filter(item => item.status === 'PASS').length}/${report.regressions.length} passed`);
for (const bot of report.readiness) {
  console.log(`${bot.strategy}: ${bot.status} · ${bot.simulatedPassed}/${bot.simulatedScenarios} simulated scenarios passed`);
  if (bot.failedGates.length) console.log(`  Failed: ${bot.failedGates.join(', ')}`);
  console.log(`  Blocked: ${bot.blocked.join(', ')}`);
}
if (report.failed) {
  console.log('\nFailures:');
  report.results.filter(result => result.status === 'FAIL').forEach(result => {
    console.log(`- ${result.strategy}/${result.scenario}: ${result.errorDetails?.message || `expected ${result.expectedState}, got ${result.finalState}`}`);
  });
}
console.log('\nCritical remaining issues:');
report.criticalRemainingIssues.forEach(issue => console.log(`- ${issue}`));
console.log('\nLive-trading blockers:');
report.liveTradingBlockers.forEach(issue => console.log(`- ${issue}`));

process.exit(report.failed ? 1 : 0);