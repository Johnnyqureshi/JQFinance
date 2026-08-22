# Strategy Validation Report

Generated: 2026-08-22T16:05:23.086Z
Study: 15a559f7d1a3
Mode: **PAPER_ONLY**
Input SHA-256: `c7398cab4f6dc4268d8c21df803e4d5b35026c1e7a2b06b027148336c97a18cb`
Experiment SHA-256: `15a559f7d1a3ad21949944d90e5ea019f6d17665d875b219621fb96fff4d23dc`
Exact replay: `node scripts/validate-strategy.js --experiment reports/data/strategy-experiment-15a559f7d1a3.json`

## Decision

**NO_PROMOTION**

Selected on validation only: `baseline`

No live-order settings or execution code were changed.

## Chronological split

| Period | Sessions | Trades | Win rate | Net expectancy | Profit factor | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| Development | 45 | 5 | 0.0% | $-147.45 | 0 | $737.24 |
| Validation | 15 | 0 | 0.0% | $0.00 | 0 | $0.00 |
| Untouched test | 15 | 5 | 20.0% | $38.88 | 1.3324307699038227 | $444.54 |

## Promotion checks that failed

- minValidationTrades: required 30; observed 0
- minTestTrades: required 30; observed 5
- positiveAfterCostExpectancy: required > 0; observed 38.88370733250005
- profitFactorGe1: required >= 1; observed val:0.00 test:1.33
- ciLoNonNegative: required >= 0 in validation and test; observed val:0 test:-158.12163066749994

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
