'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConfig } = require('../lib/strategy-validator');
const {
  buildExperimentPayload,
  experimentIdentity,
  stopFreeDiagnosticIdentity,
  writeStopFreeDiagnosticArtifacts,
  safeJson,
} = require('../scripts/validate-strategy');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('\nStrategy experiment manifest\n');

const input = {
  inputSha256: 'a'.repeat(64),
  snapshotPath: 'reports/data/strategy-ohlcv-aaaaaaaaaaaaaaaa.json.gz',
};
const config = createConfig({
  halfSpreadPct: 0.27,
  slippagePct: 0.41,
  startingEquity: 43210,
  positionPct: 7,
  promotionMinValTrades: 47,
  promotionMinTestTrades: 53,
});
const variants = [
  { name: 'non_default_stop', configOverride: { stopPct: 3.25 } },
];
const sourceHashes = {
  validatorSha256: 'b'.repeat(64),
  runnerSha256: 'c'.repeat(64),
};

test('non-default costs, sizing, thresholds, and ablations are serialized', () => {
  const payload = buildExperimentPayload(input, config, variants, sourceHashes);
  const restored = JSON.parse(safeJson(payload, 0));
  assert.strictEqual(restored.baseConfig.halfSpreadPct, 0.27);
  assert.strictEqual(restored.baseConfig.slippagePct, 0.41);
  assert.strictEqual(restored.baseConfig.startingEquity, 43210);
  assert.strictEqual(restored.baseConfig.positionPct, 7);
  assert.strictEqual(restored.baseConfig.promotionMinValTrades, 47);
  assert.strictEqual(restored.baseConfig.promotionMinTestTrades, 53);
  assert.deepStrictEqual(restored.variants, variants);
});

test('JSON round-trip preserves experiment identity and replay command', () => {
  const payload = buildExperimentPayload(input, config, variants, sourceHashes);
  const before = experimentIdentity(payload);
  const restored = JSON.parse(safeJson(payload, 0));
  const after = experimentIdentity(restored);
  assert.deepStrictEqual(after, before);
  assert.strictEqual(
    before.replayCommand,
    `node scripts/validate-strategy.js --experiment reports/data/strategy-experiment-${before.studyId}.json`,
  );
});

test('changing one execution assumption changes the experiment identity', () => {
  const original = buildExperimentPayload(input, config, variants, sourceHashes);
  const changed = buildExperimentPayload(
    input,
    createConfig({ ...config, slippagePct: 0.42 }),
    variants,
    sourceHashes,
  );
  assert.notStrictEqual(experimentIdentity(original).studyId, experimentIdentity(changed).studyId);
});

test('changing validator source identity changes the experiment identity', () => {
  const original = buildExperimentPayload(input, config, variants, sourceHashes);
  const changed = buildExperimentPayload(input, config, variants, {
    ...sourceHashes,
    validatorSha256: 'd'.repeat(64),
  });
  assert.notStrictEqual(experimentIdentity(original).studyId, experimentIdentity(changed).studyId);
});

test('stop-free diagnostic identity is bound to its baseline experiment and source', () => {
  const experiment = {
    experimentSha256: 'e'.repeat(64),
    experimentPath: 'reports/data/strategy-experiment-eeeeeeeeeeee.json',
  };
  const identity = stopFreeDiagnosticIdentity(experiment, input, sourceHashes);
  assert(/^[a-f0-9]{64}$/.test(identity.diagnosticSha256));
  assert(identity.replayCommand.includes('--diagnostic-stop-free --experiment'));
  assert.strictEqual(identity.payload.baseExperimentSha256, experiment.experimentSha256);
  const changed = stopFreeDiagnosticIdentity(
    { ...experiment, experimentSha256: 'f'.repeat(64) },
    input,
    sourceHashes,
  );
  assert.notStrictEqual(changed.diagnosticId, identity.diagnosticId);
});

test('stop-free diagnostic artifacts never write the frozen paper configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-stop-free-'));
  const configPath = path.join(root, 'config', 'paper-strategy.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const sentinel = '{"mode":"PAPER_ONLY","sentinel":true}\n';
  fs.writeFileSync(configPath, sentinel);
  const metric = {
    n: 1, winRate: 0, netExpectancy: -1, profitFactor: 0,
    worstMae: -5, maxDrawdown: 5,
  };
  const report = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    baseStudyId: 'baseline-study',
    baseExperiment: { experimentSha256: 'e'.repeat(64) },
    diagnosticIdentity: {
      diagnosticSha256: 'f'.repeat(64),
      replayCommand: 'node scripts/validate-strategy.js --diagnostic-stop-free --experiment reports/data/example.json',
    },
    diagnostic: {
      periods: Object.fromEntries(['dev', 'val', 'test'].map(period => [period, {
        baseline: metric,
        stopFree: metric,
        comparison: { ignoredStopTradeCount: 1, ignoredStopBreaches: 2 },
      }])),
      assessment: { status: 'INSUFFICIENT_SAMPLE', conclusion: 'Diagnostic only.' },
    },
  };
  const identity = {
    diagnosticId: 'abcdef123456',
    manifestPath: 'reports/data/strategy-stop-free-diagnostic-abcdef123456.json',
    payload: { schemaVersion: 1 },
  };
  const artifacts = writeStopFreeDiagnosticArtifacts(root, report, identity);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), sentinel);
  assert(fs.existsSync(artifacts.latestReport));
  assert(fs.existsSync(artifacts.latestSummary));
  assert(fs.existsSync(path.join(root, identity.manifestPath)));
  fs.rmSync(root, { recursive: true, force: true });
});

if (process.exitCode) {
  console.error(`\nResults: ${passed} passed, failures present\n`);
} else {
  console.log(`\nResults: ${passed} passed, 0 failed\n`);
}