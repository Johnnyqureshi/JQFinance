'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createConfig } = require('../lib/strategy-validator');
const {
  annotateScannerRowsForShadow,
  createPaperShadow,
} = require('../lib/paper-shadow');

async function main() {
  const productionShapedRow = annotateScannerRowsForShadow([{
    sym: 'MSFT',
    price: 10,
    change: 1,
    relVol: 2,
    volume: 100_000,
    rsi14: 50,
  }])[0];
  assert.strictEqual(productionShapedRow.priceActionEvidence.setupType, 'UNAVAILABLE');
  assert.match(productionShapedRow.priceActionEvidence.noTradeReason, /completed 5-minute/i);

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-shadow-'));
  fs.mkdirSync(path.join(rootDir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'reports', 'data'), { recursive: true });
  const db = new Database(':memory:');

  const baseline = createConfig({
    halfSpreadPct: 0.1,
    slippagePct: 0.1,
    minScore: 4,
    entryStartMinutesET: 570,
    entryEndMinutesET: 950,
  });
  const selected = createConfig({ ...baseline, minScore: 6 });
  const experimentPath = 'reports/data/strategy-experiment-test.json';
  const experiment = {
    schemaVersion: 1,
    contractVersion: 2,
    baseConfig: baseline,
    variants: [],
    inputSnapshot: {
      inputSha256: 'a'.repeat(64),
      snapshotPath: 'reports/data/test.json.gz',
    },
    sourceHashes: {
      validatorSha256: 'b'.repeat(64),
      runnerSha256: 'c'.repeat(64),
    },
  };
  fs.writeFileSync(path.join(rootDir, experimentPath), JSON.stringify(experiment));
  fs.writeFileSync(path.join(rootDir, 'config', 'paper-strategy.json'), JSON.stringify({
    schemaVersion: 1,
    studyId: 'shadow-test',
    experimentSha256: crypto.createHash('sha256')
      .update(JSON.stringify(experiment))
      .digest('hex'),
    experimentPath,
    mode: 'PAPER_ONLY',
    liveExecutionAllowed: false,
    status: 'NO_PROMOTION',
    selectedName: 'stricter_score',
    config: selected,
    promotionChecks: {
      minValidationTrades: { pass: false },
      minTestTrades: { pass: false },
    },
  }));

  const shadow = createPaperShadow({
    db,
    rootDir,
    resolveMarketRegime: async () => 'BULLISH',
  });
  const row = {
    sym: 'AAPL',
    price: 10,
    change: 35,
    relVol: 12,
    volume: 2_000_000,
    rsi14: 50,
    priceAction: {
      strategy: 'smb-compatible-long-v1',
      direction: 'LONG_ONLY',
      status: 'TRADE ELIGIBLE',
      eligible: true,
      setup: { type: 'BREAKOUT_CONTINUATION', label: 'Breakout continuation' },
      invalidation: 9.5,
      target: 11,
      riskReward: 2,
      reasons: [],
    },
  };
  const t0 = Date.parse('2026-08-20T14:00:00.000Z'); // 10:00 ET
  await shadow.ingest([row], { snapshotAt: t0 });
  await shadow.ingest([{ ...row, price: 11 }], { snapshotAt: t0 + 5 * 60 * 1000 });
  await shadow.ingest([{ ...row, price: 12, rsi14: 80 }], { snapshotAt: t0 + 10 * 60 * 1000 });

  const summary = shadow.summary();
  assert.strictEqual(summary.mode, 'PAPER_ONLY');
  assert.strictEqual(summary.liveExecutionAllowed, false);
  assert.strictEqual(summary.shadowState, 'ACTIVE_BASELINE_ONLY');
  assert.strictEqual(summary.sampleAdequate, false);
  assert.strictEqual(summary.strategyEvaluable, false);
  assert.strictEqual(summary.pairedDecisions, 3);
  assert.strictEqual(summary.baseline.decisions.qualified, 1);
  assert.strictEqual(summary.selected.decisions.qualified, 0);
  assert.strictEqual(summary.baseline.outcomes.metrics.n, 1);
  assert.strictEqual(summary.selected.outcomes.metrics.n, 0);
  assert.strictEqual(summary.baseline.outcomes.metrics.byRegime.BULLISH.count, 1);
  assert(summary.baseline.outcomes.metrics.totalPnl > 0);
  const breakoutEvidence = summary.priceActionEvidence.baseline
    .setupTypes.BREAKOUT_CONTINUATION;
  assert.strictEqual(summary.priceActionEvidence.promotionEligible, false);
  assert.strictEqual(breakoutEvidence.candidates, 3);
  assert.strictEqual(breakoutEvidence.outcomes, 1);
  assert.strictEqual(breakoutEvidence.assessment, 'INSUFFICIENT_SAMPLE');
  assert.strictEqual(breakoutEvidence.promotionEligible, false);

  await shadow.ingest([{
    ...row,
    sym: 'MSFT',
    change: 1,
    priceAction: undefined,
    priceActionEvidence: productionShapedRow.priceActionEvidence,
  }], { snapshotAt: t0 });
  const unavailable = db.prepare(`
    SELECT price_action_setup_type, price_action_invalidation,
           price_action_no_trade_reason
    FROM paper_shadow_decisions
    WHERE symbol='MSFT' AND config_name='baseline'
  `).get();
  assert.strictEqual(unavailable.price_action_setup_type, 'UNAVAILABLE');
  assert.strictEqual(unavailable.price_action_invalidation, null);
  assert.match(unavailable.price_action_no_trade_reason, /unavailable/i);

  const decisionRow = db.prepare(`
    SELECT COUNT(*) AS n, MIN(price_action_setup_type) AS setup_type,
           MIN(price_action_invalidation) AS invalidation
    FROM paper_shadow_decisions
  `).get();
  const decisions = decisionRow.n;
  const positions = db.prepare('SELECT COUNT(*) AS n FROM paper_shadow_positions').get().n;
  assert.strictEqual(decisions, 8);
  assert.strictEqual(decisionRow.setup_type, 'BREAKOUT_CONTINUATION');
  assert.strictEqual(decisionRow.invalidation, 9.5);
  assert.strictEqual(positions, 1);

  const paperPath = path.join(rootDir, 'config', 'paper-strategy.json');
  const tamperedPaper = JSON.parse(fs.readFileSync(paperPath, 'utf8'));
  tamperedPaper.experimentSha256 = '0'.repeat(64);
  fs.writeFileSync(paperPath, JSON.stringify(tamperedPaper));
  const tamperedShadow = createPaperShadow({
    db,
    rootDir,
    resolveMarketRegime: async () => 'BULLISH',
  });
  assert.throws(
    () => tamperedShadow.summary(),
    /experiment content does not match its locked hash/,
  );

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
  console.log('\nPaper shadow comparator\n');
  console.log('  ✓ paired decisions persist for baseline and selected configs');
  console.log('  ✓ next-snapshot fills and scanner-snapshot outcomes persist');
  console.log('  ✓ insufficient historical samples remain non-evaluable and paper-only');
  console.log('  ✓ tampered experiment manifests fail closed');
  console.log('\nResults: 4 passed, 0 failed\n');
}

main().catch(error => {
  console.error(`\nPaper shadow comparator failed: ${error.stack || error.message}\n`);
  process.exit(1);
});