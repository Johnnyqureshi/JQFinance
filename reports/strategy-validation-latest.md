# Strategy Validation Report

Generated: 2026-08-21T04:02:58.370Z
Study: 2a99ae2173ed
Mode: **PAPER_ONLY**
Input SHA-256: `d64d4027d40c646e45b4e0caed2c327a8114b58b19e94534f0955749dd60f9b2`
Experiment SHA-256: `2a99ae2173edd0bfb311669bf15da4d9222f8b8b34867ebd3941e96c81c438fa`
Exact replay: `node scripts/validate-strategy.js --experiment reports/data/strategy-experiment-2a99ae2173ed.json`

## Decision

**NO_PROMOTION**

Selected on validation only: `baseline`

No live-order settings or execution code were changed.

## Chronological split

| Period | Sessions | Trades | Win rate | Net expectancy | Profit factor | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| Development | 45 | 2 | 0.0% | $-132.89 | 0 | $265.77 |
| Validation | 15 | 0 | 0.0% | $0.00 | 0 | $0.00 |
| Untouched test | 15 | 6 | 50.0% | $-35.36 | 0.7132269776927245 | $739.83 |

## Promotion checks that failed

- minValidationTrades: required 30; observed 0
- minTestTrades: required 30; observed 6
- positiveAfterCostExpectancy: required > 0; observed -35.360715389520706
- profitFactorGe1: required >= 1; observed val:0.00 test:0.71
- ciLoNonNegative: required >= 0 in validation and test; observed val:0 test:-244.6006631248749

## Data limitations

- Uses current/curated membership, not point-in-time historical universe membership. Results may contain survivorship and selection bias.
- No point-in-time historical news catalyst archive was available; the news gate is declared unavailable.
- No point-in-time float/share-count archive was available; the float gate is declared unavailable.
- No Level 2 order book, tape, halt queue, or options-flow history was available.
- IEX/Yahoo OHLCV bars cannot reproduce exact exchange queue position or partial fills.
- The replay forces a time exit after 78 observed 5-minute bars. The current live bot may hold longer until its stop or RSI exit, so overnight behavior is not treated as an exact match.
- The historical replay is evidence for paper testing, not a guarantee of future performance.

## Execution assumptions

- A signal can fill only at the next completed 5-minute bar open.
- Buy and sell half-spread plus slippage are charged.
- Stop-loss wins when multiple exits occur in one bar.
- A gap or halt below the stop fills at the lower next bar open.
- Development and validation exits are force-closed at their own period boundary; no later split bars are readable.
- Maximum two concurrent long positions; no short selling.
- Historical news, point-in-time float, Level 2, tape, and options data are not fabricated.
