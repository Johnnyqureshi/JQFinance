# Stop-Free Entry/Exit Diagnostic

Generated: 2026-08-21T04:31:27.012Z
Mode: **PAPER_ONLY — DIAGNOSTIC ONLY**
Base study: `7488c74ceda8`
Base experiment SHA-256: `7488c74ceda87fb85747ae3c12b098ecead741b1399c4e1d34795f31c2c372de`
Diagnostic SHA-256: `a18ed4577877332d67ea9a61bb4fb796217e01c19dcf6a1a398b7d59d490f9cc`
Exact replay: `node scripts/validate-strategy.js --diagnostic-stop-free --experiment reports/data/strategy-experiment-7488c74ceda8.json`

## What was held constant

- The same entry signals, gates, next-bar fills, spread, slippage, and stop-based sizing.
- The same RSI, session, max-hold, and split-boundary exits.
- Only stop-triggered exits were suppressed. This cannot enable live execution and is not eligible for promotion.

## Results

| Period | Baseline trades | Baseline win rate | Baseline expectancy | Stop-free trades | Stop-free win rate | Stop-free expectancy | Stop-free PF | Stop-free worst MAE | Stop-free max drawdown | Stop-hit trades / bars below stop |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Development | 2 | 0.0% | $-132.89 | 2 | 0.0% | $-88.83 | 0 | $-378.75 | $177.65 | 2 / 28 |
| Validation | 0 | 0.0% | $0.00 | 0 | 0.0% | $0.00 | 0 | $0.00 | $0.00 | 0 / 0 |
| Untouched test | 6 | 50.0% | $-35.36 | 6 | 50.0% | $-405.13 | 0.17836133312440502 | $-1446.81 | $2946.56 | 3 / 159 |

## Assessment

**INSUFFICIENT_SAMPLE_STOP_FREE_WORSE**

The stop-free exits were worse than the protected baseline and there are too few untouched trades to establish an entry or exit edge.

The stop-free replay is a counterfactual risk diagnostic, not a trading recommendation. The active paper configuration and live order path were not changed.
