'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  CONTRACT_VERSION,
  buildPriceActionOutcomeReport,
  computeMetrics,
  createConfig,
  evaluateCandidate,
  instrumentGroup,
  isMarketHours,
} = require('./strategy-validator');
const { summarizePriceActionResult } = require('./price-action-setups');

const CYCLE_MS = 5 * 60 * 1000;
const RETENTION_DAYS = 180;
const SCANNER_PRICE_ACTION_UNAVAILABLE_REASON =
  'Completed 5-minute price-action evidence is unavailable in the scanner snapshot.';

function annotateScannerRowsForShadow(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (row?.priceAction || row?.priceActionEvidence) return row;
    return {
      ...row,
      priceActionEvidence: {
        strategy: 'smb-compatible-long-v1',
        direction: 'LONG_ONLY',
        status: 'NO TRADE',
        eligible: false,
        setupType: 'UNAVAILABLE',
        setup: null,
        invalidation: null,
        target: null,
        riskReward: null,
        noTradeReason: SCANNER_PRICE_ACTION_UNAVAILABLE_REASON,
        noTradeReasons: [SCANNER_PRICE_ACTION_UNAVAILABLE_REASON],
        reasons: [SCANNER_PRICE_ACTION_UNAVAILABLE_REASON],
      },
    };
  });
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scoreSnapshot(row) {
  const gain = Number(row.change);
  const relVol = Number(row.relVol);
  let score = 0;
  if (Number.isFinite(gain) && gain >= 10) score += 2;
  if (Number.isFinite(gain) && gain >= 30) score += 1;
  if (Number.isFinite(relVol) && relVol >= 5) score += 1;
  if (Number.isFinite(relVol) && relVol >= 10) score += 1;
  return score;
}

function sizePosition(fillPrice, cfg, equity) {
  const stopPrice = fillPrice * (1 - cfg.stopPct / 100);
  let notional = cfg.fixedNotional != null
    ? cfg.fixedNotional * (cfg.leverage || 1)
    : equity * (cfg.positionPct / 100) * (cfg.leverage || 1);
  if (cfg.maxRiskPct > 0 && fillPrice > stopPrice) {
    const maxLoss = equity * cfg.maxRiskPct / 100;
    notional = Math.min(notional, maxLoss / (fillPrice - stopPrice) * fillPrice);
  }
  const qty = fillPrice > 0 ? Math.max(1, Math.floor(notional / fillPrice)) : 0;
  return { stopPrice, qty, notional: qty * fillPrice };
}

function createPaperShadow({ db, rootDir, resolveMarketRegime = async () => null }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_shadow_decisions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      study_id            TEXT NOT NULL,
      experiment_sha256   TEXT NOT NULL,
      cycle_id            INTEGER NOT NULL,
      snapshot_at         TEXT NOT NULL,
      config_name         TEXT NOT NULL,
      config_sha256       TEXT NOT NULL,
      symbol              TEXT NOT NULL,
      instrument_group    TEXT NOT NULL,
      market_regime       TEXT NOT NULL,
      status              TEXT NOT NULL,
      reject_code         TEXT,
      price_action_setup_type TEXT NOT NULL DEFAULT 'UNAVAILABLE',
      price_action_invalidation REAL,
      price_action_no_trade_reason TEXT,
      price_action_json   TEXT NOT NULL DEFAULT '{}',
      decision_json       TEXT NOT NULL,
      scanner_snapshot_json TEXT NOT NULL,
      created_at          TEXT DEFAULT (datetime('now')),
      UNIQUE (experiment_sha256, cycle_id, config_name, symbol)
    );

    CREATE TABLE IF NOT EXISTS paper_shadow_positions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id         INTEGER NOT NULL UNIQUE,
      study_id            TEXT NOT NULL,
      experiment_sha256   TEXT NOT NULL,
      config_name         TEXT NOT NULL,
      config_sha256       TEXT NOT NULL,
      symbol              TEXT NOT NULL,
      instrument_group    TEXT NOT NULL,
      market_regime       TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      signal_cycle        INTEGER NOT NULL,
      signal_at           TEXT NOT NULL,
      entry_cycle         INTEGER,
      entry_at            TEXT,
      entry_price         REAL,
      stop_price          REAL,
      qty                 REAL,
      notional            REAL,
      exit_cycle          INTEGER,
      exit_at             TEXT,
      exit_price          REAL,
      exit_reason         TEXT,
      net_pnl             REAL,
      mae                 REAL DEFAULT 0,
      mfe                 REAL DEFAULT 0,
      last_mark_at        TEXT,
      outcome_source      TEXT DEFAULT 'SCANNER_SNAPSHOT',
      price_action_setup_type TEXT NOT NULL DEFAULT 'UNAVAILABLE',
      price_action_invalidation REAL,
      FOREIGN KEY (decision_id) REFERENCES paper_shadow_decisions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_shadow_decisions_study
      ON paper_shadow_decisions (experiment_sha256, config_name, cycle_id);
    CREATE INDEX IF NOT EXISTS idx_shadow_positions_study
      ON paper_shadow_positions (experiment_sha256, config_name, status);
  `);
  [
    `ALTER TABLE paper_shadow_decisions ADD COLUMN price_action_setup_type TEXT NOT NULL DEFAULT 'UNAVAILABLE'`,
    `ALTER TABLE paper_shadow_decisions ADD COLUMN price_action_invalidation REAL`,
    `ALTER TABLE paper_shadow_decisions ADD COLUMN price_action_no_trade_reason TEXT`,
    `ALTER TABLE paper_shadow_decisions ADD COLUMN price_action_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE paper_shadow_positions ADD COLUMN price_action_setup_type TEXT NOT NULL DEFAULT 'UNAVAILABLE'`,
    `ALTER TABLE paper_shadow_positions ADD COLUMN price_action_invalidation REAL`,
  ].forEach(sql => {
    try {
      db.prepare(sql).run();
    } catch (error) {
      if (!/duplicate column name/i.test(error.message || '')) {
        throw new Error(`Paper-shadow schema migration failed: ${error.message}`);
      }
    }
  });

  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO paper_shadow_decisions
      (study_id, experiment_sha256, cycle_id, snapshot_at, config_name,
       config_sha256, symbol, instrument_group, market_regime, status,
       reject_code, price_action_setup_type, price_action_invalidation,
       price_action_no_trade_reason, price_action_json, decision_json,
       scanner_snapshot_json)
    VALUES
      (@studyId, @experimentSha256, @cycleId, @snapshotAt, @configName,
       @configSha256, @symbol, @instrumentGroup, @marketRegime, @status,
       @rejectCode, @priceActionSetupType, @priceActionInvalidation,
       @priceActionNoTradeReason, @priceActionJson, @decisionJson,
       @scannerSnapshotJson)
  `);
  const findDecision = db.prepare(`
    SELECT id FROM paper_shadow_decisions
    WHERE experiment_sha256=? AND cycle_id=? AND config_name=? AND symbol=?
  `);
  const insertPosition = db.prepare(`
    INSERT OR IGNORE INTO paper_shadow_positions
      (decision_id, study_id, experiment_sha256, config_name, config_sha256,
       symbol, instrument_group, market_regime, signal_cycle, signal_at,
       price_action_setup_type, price_action_invalidation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let cache = null;
  let cacheKey = '';

  function loadConfigs() {
    const paperPath = path.join(rootDir, 'config', 'paper-strategy.json');
    const stat = fs.statSync(paperPath);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (cache && key === cacheKey) return cache;

    const paper = JSON.parse(fs.readFileSync(paperPath, 'utf8'));
    if (paper.mode !== 'PAPER_ONLY' || paper.liveExecutionAllowed !== false) {
      throw new Error('Paper strategy config is not safely locked');
    }
    const experimentPath = path.resolve(rootDir, paper.experimentPath);
    if (!experimentPath.startsWith(`${path.resolve(rootDir)}${path.sep}`)) {
      throw new Error('Paper experiment path leaves the workspace');
    }
    const experiment = JSON.parse(fs.readFileSync(experimentPath, 'utf8'));
    if (experiment.contractVersion !== CONTRACT_VERSION) {
      throw new Error('Paper experiment contract is incompatible');
    }
    if (hashJson(experiment) !== paper.experimentSha256) {
      throw new Error('Paper experiment content does not match its locked hash');
    }
    const baseline = createConfig(experiment.baseConfig);
    const selected = createConfig(paper.config);
    cache = {
      paper,
      experiment,
      studyId: paper.studyId,
      experimentSha256: paper.experimentSha256,
      configs: [
        { name: 'baseline', cfg: baseline, sha256: hashJson(baseline) },
        { name: 'selected', cfg: selected, sha256: hashJson(selected) },
      ],
    };
    cacheKey = key;
    return cache;
  }

  function configState(meta, snapshotAt, cycleId) {
    const active = db.prepare(`
      SELECT symbol FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=? AND status IN ('pending','open')
    `).all(meta.experimentSha256, meta.name);
    const openPositions = Object.fromEntries(active.map(row => [row.symbol, { shadow: true }]));
    const day = new Date(snapshotAt).toISOString().slice(0, 10);
    const daily = db.prepare(`
      SELECT COUNT(*) AS n,
             COALESCE(SUM((entry_price-stop_price)*qty),0) AS risk
      FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=? AND entry_at LIKE ? || '%'
    `).get(meta.experimentSha256, meta.name, day);
    const closed = db.prepare(`
      SELECT symbol, MAX(exit_cycle) AS exit_cycle
      FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=? AND status='closed'
      GROUP BY symbol
    `).all(meta.experimentSha256, meta.name);
    const pnl = db.prepare(`
      SELECT COALESCE(SUM(net_pnl),0) AS pnl
      FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=? AND status='closed'
    `).get(meta.experimentSha256, meta.name)?.pnl || 0;
    return {
      openPositions,
      dailyTrades: { [day]: daily.n || 0 },
      lastExitBar: Object.fromEntries(closed.map(row => [
        row.symbol,
        -(cycleId - Number(row.exit_cycle)),
      ])),
      dailyRiskUsed: { [day]: Number(daily.risk) || 0 },
      equityCurve: [meta.cfg.startingEquity + Number(pnl)],
    };
  }

  function settlePositions(meta, rowsBySymbol, snapshotAt, cycleId) {
    const positions = db.prepare(`
      SELECT * FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=? AND status IN ('pending','open')
      ORDER BY id
    `).all(meta.experimentSha256, meta.name);
    const sellCostPct = (meta.cfg.halfSpreadPct + meta.cfg.slippagePct) / 100;
    const equityPnl = db.prepare(`
      SELECT COALESCE(SUM(net_pnl),0) AS pnl FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=? AND status='closed'
    `).get(meta.experimentSha256, meta.name)?.pnl || 0;
    let equity = meta.cfg.startingEquity + Number(equityPnl);

    for (const pos of positions) {
      const row = rowsBySymbol.get(pos.symbol);
      if (!row || !Number.isFinite(Number(row.price))) continue;
      const price = Number(row.price);

      if (pos.status === 'pending') {
        if (cycleId <= pos.signal_cycle) continue;
        if (!isMarketHours(snapshotAt)) {
          db.prepare(`
            UPDATE paper_shadow_positions
            SET status='cancelled', exit_cycle=?, exit_at=?, exit_reason='MISSED_NEXT_SNAPSHOT',
                last_mark_at=?
            WHERE id=?
          `).run(cycleId, new Date(snapshotAt).toISOString(), new Date(snapshotAt).toISOString(), pos.id);
          continue;
        }
        const fillPrice = price * (1 + sellCostPct);
        const sizing = sizePosition(fillPrice, meta.cfg, equity);
        db.prepare(`
          UPDATE paper_shadow_positions
          SET status='open', entry_cycle=?, entry_at=?, entry_price=?, stop_price=?,
              qty=?, notional=?, last_mark_at=?
          WHERE id=?
        `).run(
          cycleId, new Date(snapshotAt).toISOString(), fillPrice, sizing.stopPrice,
          sizing.qty, sizing.notional, new Date(snapshotAt).toISOString(), pos.id,
        );
        continue;
      }

      const adverse = Math.min((price - pos.entry_price) * pos.qty, 0);
      const favorable = Math.max((price - pos.entry_price) * pos.qty, 0);
      const holdCycles = cycleId - pos.entry_cycle;
      let exitReason = null;
      let rawExit = price;
      if (price <= pos.stop_price) {
        exitReason = 'STOP';
        rawExit = Math.min(price, pos.stop_price);
      } else if (!isMarketHours(snapshotAt)) {
        exitReason = 'SESSION_END';
      } else if (holdCycles >= meta.cfg.maxHoldBars) {
        exitReason = 'MAX_HOLD';
      } else if (Number.isFinite(Number(row.rsi14))
          && Number(row.rsi14) >= meta.cfg.takeProfitRsiLevel) {
        exitReason = 'RSI_EXIT';
      }

      if (!exitReason) {
        db.prepare(`
          UPDATE paper_shadow_positions
          SET mae=MIN(mae, ?), mfe=MAX(mfe, ?), last_mark_at=?
          WHERE id=?
        `).run(adverse, favorable, new Date(snapshotAt).toISOString(), pos.id);
        continue;
      }
      const exitPrice = rawExit * (1 - sellCostPct);
      const netPnl = (exitPrice - pos.entry_price) * pos.qty;
      db.prepare(`
        UPDATE paper_shadow_positions
        SET status='closed', exit_cycle=?, exit_at=?, exit_price=?, exit_reason=?,
            net_pnl=?, mae=MIN(mae, ?), mfe=MAX(mfe, ?), last_mark_at=?
        WHERE id=?
      `).run(
        cycleId, new Date(snapshotAt).toISOString(), exitPrice, exitReason,
        netPnl, adverse, favorable, new Date(snapshotAt).toISOString(), pos.id,
      );
      equity += netPnl;
    }
  }

  async function ingest(rows, options = {}) {
    if (!Array.isArray(rows) || rows.length === 0) return { skipped: true };
      const loaded = loadConfigs();
      const snapshotAt = Number(options.snapshotAt) || Date.now();
      const cycleId = Math.floor(snapshotAt / CYCLE_MS);
      const snapshotIso = new Date(snapshotAt).toISOString();
      const rowsBySymbol = new Map(rows
        .filter(row => row?.sym && Number.isFinite(Number(row.price)))
        .map(row => [String(row.sym).toUpperCase(), row]));
      if (!rowsBySymbol.size) return { skipped: true };
      const regime = options.marketRegime
        || await resolveMarketRegime()
        || 'UNKNOWN';
      const ranked = [...rowsBySymbol.values()]
        .map(row => ({ row, score: scoreSnapshot(row) }))
        .sort((a, b) =>
          b.score - a.score
          || (Number(b.row.relVol) || 0) - (Number(a.row.relVol) || 0)
          || String(a.row.sym).localeCompare(String(b.row.sym))
        );

      for (const configMeta of loaded.configs) {
        const meta = { ...configMeta, experimentSha256: loaded.experimentSha256 };
        settlePositions(meta, rowsBySymbol, snapshotAt, cycleId);
        const state = configState(meta, snapshotAt, cycleId);

        for (let i = 0; i < ranked.length; i++) {
          const { row, score } = ranked[i];
          const symbol = String(row.sym).toUpperCase();
          const signal = {
            symbol,
            tMs: snapshotAt,
            barIndex: 0,
            side: 'long',
            rank: i + 1,
            price: Number(row.price),
            gainPct: Number.isFinite(Number(row.change)) ? Number(row.change) : null,
            relVol: Number.isFinite(Number(row.relVol)) ? Number(row.relVol) : null,
            score,
            marketRegime: regime,
          };
          const rawPriceAction = row.priceAction || row.priceActionEvidence || null;
          const priceAction = summarizePriceActionResult(rawPriceAction);
          if (!rawPriceAction) {
            priceAction.noTradeReason = 'Price-action evidence unavailable.';
            priceAction.noTradeReasons = ['Price-action evidence unavailable.'];
          }
          signal.priceAction = rawPriceAction;
          const bar = {
            symbol,
            t: snapshotAt,
            o: signal.price,
            h: signal.price,
            l: signal.price,
            c: signal.price,
            v: Number(row.volume) || 0,
          };
          const decision = evaluateCandidate(signal, [bar], configMeta.cfg, state, null, {
            gateOnly: true,
          });
          const values = {
            studyId: loaded.studyId,
            experimentSha256: loaded.experimentSha256,
            cycleId,
            snapshotAt: snapshotIso,
            configName: configMeta.name,
            configSha256: configMeta.sha256,
            symbol,
            instrumentGroup: instrumentGroup(symbol),
            marketRegime: regime,
            status: decision.status,
            rejectCode: decision.rejectCode,
            priceActionSetupType: priceAction.setupType,
            priceActionInvalidation: priceAction.invalidation,
            priceActionNoTradeReason: priceAction.noTradeReason,
            priceActionJson: JSON.stringify(priceAction),
            decisionJson: JSON.stringify(decision),
            scannerSnapshotJson: JSON.stringify(row),
          };
          insertDecision.run(values);
          const decisionRow = findDecision.get(
            loaded.experimentSha256, cycleId, configMeta.name, symbol,
          );
          if (decision.status === 'QUALIFIED' && decisionRow) {
            insertPosition.run(
              decisionRow.id, loaded.studyId, loaded.experimentSha256,
              configMeta.name, configMeta.sha256, symbol, instrumentGroup(symbol),
              regime, cycleId, snapshotIso,
              priceAction.setupType, priceAction.invalidation,
            );
            state.openPositions[symbol] = { shadow: true };
          }
        }
      }

      db.prepare(`
        DELETE FROM paper_shadow_decisions
        WHERE created_at < datetime('now', ?)
          AND id NOT IN (SELECT decision_id FROM paper_shadow_positions)
      `).run(`-${RETENTION_DAYS} days`);
      return { skipped: false, cycleId, rows: rowsBySymbol.size };
  }

  function decisionStats(experimentSha256, configName) {
    const row = db.prepare(`
      SELECT COUNT(*) AS decisions,
             SUM(CASE WHEN status='QUALIFIED' THEN 1 ELSE 0 END) AS qualified,
             COUNT(DISTINCT cycle_id) AS cycles,
             MIN(snapshot_at) AS first_snapshot,
             MAX(snapshot_at) AS last_snapshot
      FROM paper_shadow_decisions
      WHERE experiment_sha256=? AND config_name=?
    `).get(experimentSha256, configName);
    const byGroup = db.prepare(`
      SELECT instrument_group AS name, COUNT(*) AS decisions,
             SUM(CASE WHEN status='QUALIFIED' THEN 1 ELSE 0 END) AS qualified
      FROM paper_shadow_decisions
      WHERE experiment_sha256=? AND config_name=?
      GROUP BY instrument_group
    `).all(experimentSha256, configName);
    const byRegime = db.prepare(`
      SELECT market_regime AS name, COUNT(*) AS decisions,
             SUM(CASE WHEN status='QUALIFIED' THEN 1 ELSE 0 END) AS qualified
      FROM paper_shadow_decisions
      WHERE experiment_sha256=? AND config_name=?
      GROUP BY market_regime
    `).all(experimentSha256, configName);
    return {
      decisions: row.decisions || 0,
      qualified: row.qualified || 0,
      cycles: row.cycles || 0,
      firstSnapshot: row.first_snapshot,
      lastSnapshot: row.last_snapshot,
      byGroup: Object.fromEntries(byGroup.map(item => [item.name, {
        decisions: item.decisions,
        qualified: item.qualified || 0,
      }])),
      byRegime: Object.fromEntries(byRegime.map(item => [item.name, {
        decisions: item.decisions,
        qualified: item.qualified || 0,
      }])),
    };
  }

  function outcomeMetrics(loaded, configName) {
    const rows = db.prepare(`
      SELECT * FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=? AND status='closed'
      ORDER BY exit_cycle, id
    `).all(loaded.experimentSha256, configName);
    const cfg = loaded.configs.find(item => item.name === configName).cfg;
    const trades = rows.map(row => ({
      symbol: row.symbol,
      entryTime: Date.parse(row.entry_at),
      exitTime: Date.parse(row.exit_at),
      netPnl: Number(row.net_pnl) || 0,
      grossPnl: Number(row.net_pnl) || 0,
      win: Number(row.net_pnl) > 0,
      exitReason: row.exit_reason,
      mae: Number(row.mae) || 0,
      mfe: Number(row.mfe) || 0,
      holdBars: Number(row.exit_cycle) - Number(row.entry_cycle),
      qty: Number(row.qty) || 0,
      notional: Number(row.notional) || 0,
      marketRegime: row.market_regime,
      priceActionSetupType: row.price_action_setup_type || 'UNAVAILABLE',
      priceActionInvalidation: row.price_action_invalidation ?? null,
    }));
    const open = db.prepare(`
      SELECT status, COUNT(*) AS n FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=?
      GROUP BY status
    `).all(loaded.experimentSha256, configName);
    return {
      metrics: computeMetrics(trades, cfg),
      positionCounts: Object.fromEntries(open.map(row => [row.status, row.n])),
    };
  }

  function priceActionEvidence(loaded, configName) {
    const candidates = db.prepare(`
      SELECT decision_json, price_action_json, price_action_setup_type,
             price_action_invalidation, price_action_no_trade_reason
      FROM paper_shadow_decisions
      WHERE experiment_sha256=? AND config_name=?
      ORDER BY cycle_id, id
    `).all(loaded.experimentSha256, configName).map(row => {
      let decision = {};
      try { decision = JSON.parse(row.decision_json); } catch {}
      let priceAction = null;
      try { priceAction = JSON.parse(row.price_action_json); } catch {}
      decision.priceAction = {
        ...summarizePriceActionResult(priceAction),
        setupType: row.price_action_setup_type || 'UNAVAILABLE',
        invalidation: row.price_action_invalidation ?? null,
        noTradeReason: row.price_action_no_trade_reason
          || priceAction?.noTradeReason
          || 'Price-action evidence unavailable.',
      };
      return decision;
    });
    const closed = db.prepare(`
      SELECT * FROM paper_shadow_positions
      WHERE experiment_sha256=? AND config_name=? AND status='closed'
      ORDER BY exit_cycle, id
    `).all(loaded.experimentSha256, configName).map(row => ({
      symbol: row.symbol,
      entryTime: Date.parse(row.entry_at),
      exitTime: Date.parse(row.exit_at),
      netPnl: Number(row.net_pnl) || 0,
      grossPnl: Number(row.net_pnl) || 0,
      win: Number(row.net_pnl) > 0,
      exitReason: row.exit_reason,
      mae: Number(row.mae) || 0,
      mfe: Number(row.mfe) || 0,
      holdBars: Number(row.exit_cycle) - Number(row.entry_cycle),
      qty: Number(row.qty) || 0,
      notional: Number(row.notional) || 0,
      marketRegime: row.market_regime,
      priceActionSetupType: row.price_action_setup_type || 'UNAVAILABLE',
      priceActionInvalidation: row.price_action_invalidation ?? null,
    }));
    const cfg = loaded.configs.find(item => item.name === configName).cfg;
    const required = loaded.paper.promotionChecks?.minTestTrades?.required
      ?? cfg.promotionMinTestTrades
      ?? 30;
    return buildPriceActionOutcomeReport(candidates, closed, cfg, {
      minimumSample: required,
    });
  }

  function summary() {
    const loaded = loadConfigs();
    const baselineDecisions = decisionStats(loaded.experimentSha256, 'baseline');
    const selectedDecisions = decisionStats(loaded.experimentSha256, 'selected');
    const baselineOutcomes = outcomeMetrics(loaded, 'baseline');
    const selectedOutcomes = outcomeMetrics(loaded, 'selected');
    const pairedDecisions = db.prepare(`
      SELECT COUNT(*) AS n
      FROM paper_shadow_decisions b
      JOIN paper_shadow_decisions s
        ON s.experiment_sha256=b.experiment_sha256
       AND s.cycle_id=b.cycle_id
       AND s.symbol=b.symbol
       AND s.config_name='selected'
      WHERE b.experiment_sha256=? AND b.config_name='baseline'
    `).get(loaded.experimentSha256)?.n || 0;
    const checks = loaded.paper.promotionChecks || {};
    const sampleAdequate = !!checks.minValidationTrades?.pass
      && !!checks.minTestTrades?.pass;
    return {
      available: true,
      mode: 'PAPER_ONLY',
      liveExecutionAllowed: false,
      studyId: loaded.studyId,
      experimentSha256: loaded.experimentSha256,
      selectedName: loaded.paper.selectedName,
      historicalStatus: loaded.paper.status,
      sampleAdequate,
      strategyEvaluable: sampleAdequate && loaded.paper.status === 'PROMOTED_TO_PAPER',
      shadowState: loaded.paper.status === 'PROMOTED_TO_PAPER'
        ? 'ACTIVE_CANDIDATE_COMPARISON'
        : 'ACTIVE_BASELINE_ONLY',
      pairedDecisions,
      baseline: {
        configSha256: loaded.configs[0].sha256,
        decisions: baselineDecisions,
        outcomes: baselineOutcomes,
      },
      selected: {
        configSha256: loaded.configs[1].sha256,
        decisions: selectedDecisions,
        outcomes: selectedOutcomes,
      },
      priceActionEvidence: {
        mode: 'PAPER_ONLY',
        liveExecutionAllowed: false,
        promotionEligible: false,
        baseline: priceActionEvidence(loaded, 'baseline'),
        selected: priceActionEvidence(loaded, 'selected'),
      },
      delta: {
        qualified: selectedDecisions.qualified - baselineDecisions.qualified,
        closedTrades: selectedOutcomes.metrics.n - baselineOutcomes.metrics.n,
        totalPnl: selectedOutcomes.metrics.totalPnl - baselineOutcomes.metrics.totalPnl,
        netExpectancy: selectedOutcomes.metrics.netExpectancy
          - baselineOutcomes.metrics.netExpectancy,
      },
      caveat: 'Shadow fills and outcomes use observed scanner snapshots, not broker orders or full intrabar quote history.',
    };
  }

  return { ingest, summary, scoreSnapshot };
}

module.exports = {
  CYCLE_MS,
  annotateScannerRowsForShadow,
  createPaperShadow,
  scoreSnapshot,
  sizePosition,
};