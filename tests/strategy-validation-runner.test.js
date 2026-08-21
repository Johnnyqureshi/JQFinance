'use strict';

const assert = require('assert');
const { createConfig } = require('../lib/strategy-validator');
const {
  buildExperimentPayload,
  experimentIdentity,
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

if (process.exitCode) {
  console.error(`\nResults: ${passed} passed, failures present\n`);
} else {
  console.log(`\nResults: ${passed} passed, 0 failed\n`);
}