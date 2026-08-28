'use strict';

const assert = require('assert');
const { STRATEGIES, SCENARIOS, performScenario, runPaperQa } = require('../lib/paper-broker-qa');

const report = runPaperQa();

assert.strictEqual(report.mode, 'PAPER_SIMULATION_ONLY');
assert.strictEqual(report.liveOrdersPlaced, false);
assert.strictEqual(report.total, STRATEGIES.length * SCENARIOS.length);
assert.strictEqual(report.failed, 0, JSON.stringify(report.results.filter(result => result.status === 'FAIL'), null, 2));
assert.strictEqual(report.passed, report.total);

for (const result of report.results) {
  assert.ok(STRATEGIES.includes(result.strategy));
  assert.ok(SCENARIOS.some(([scenario]) => scenario === result.scenario));
  assert.ok(result.symbol);
  assert.ok(result.initialState);
  assert.ok(result.positionState);
  assert.ok(result.protectionState);
  assert.ok(Array.isArray(result.reconciliationResult));
  assert.strictEqual(result.status, 'PASS');
}

const pmhPauseScenario = performScenario('pmh', 'restart-protected');
assert.strictEqual(pmhPauseScenario.status, 'PASS');
assert.strictEqual(pmhPauseScenario.finalState, 'open');
assert.strictEqual(pmhPauseScenario.protectionState.stop, 'active');
assert.strictEqual(pmhPauseScenario.protectionState.runner, 'separate-protected-lot');

const duplicate = performScenario('momentum', 'duplicate-entry');
assert.strictEqual(duplicate.status, 'PASS');
assert.strictEqual(duplicate.partialFillStatus.length, 1);

for (const readiness of report.readiness) {
  assert.strictEqual(readiness.status, 'NOT READY');
  assert.strictEqual(readiness.simulatedFailed, 0);
  assert.ok(readiness.blocked.includes('REAL_PAPER_BROKER_EXECUTION'));
}

console.log(`paper broker QA tests passed (${report.passed}/${report.total} deterministic scenarios)`);