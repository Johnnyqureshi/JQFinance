# Shared research liquidity policy

Edit `lib/liquidity-policy.json` and restart the application to change the shared
scanner and bot-research thresholds. This is intentionally one application-wide
policy, not an individual browser filter. Existing bot-specific strategy,
spread, risk, sizing and broker checks can still reject any candidate that passes.
Invalid settings stop startup with an explicit configuration error.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `minShareVolume` | 100,000 | Minimum current/session equity share volume, inclusive |
| `minDollarVolume` | 1,000,000 | Minimum price × session share volume in dollars, inclusive |
| `maxSpreadPct` | 1 | Maximum `(ask - bid) / midpoint × 100`, inclusive; `null` explicitly disables this gate |
| `pumpChangePct` | 30 | Positive session move at which the stricter turnover requirement starts |
| `pumpMinDollarVolume` | 10,000,000 | Minimum estimated turnover for that large-move screen |

Zero is a real setting, not “missing”; a zero spread limit accepts only locked
positive bid/ask quotes. Missing, nonpositive or crossed bid/ask quotes are labeled
unavailable and fail an enabled spread gate. Missing price or session volume
fails closed. Dollar volume is an **estimate** of session turnover, not summed
trade notional. It is not average daily volume or a five-minute-bar volume.

Current-session evidence must also be validated. Prior-session volume cannot be
combined with a fresh quote to qualify an entry, and premarket/closed-session
research must not be presented as passing the regular-session liquidity gate.
An enabled spread limit requires verifiable quote freshness; a trade timestamp
alone does not establish when the bid and ask were observed. Providers without
that evidence can therefore yield no eligible candidates rather than an
assumed pass.

The pump-like screen flags a large move with insufficient turnover. It is not
evidence of manipulation and does not claim to detect all pump-and-dump schemes.
Passing any liquidity threshold is not permission to trade.

Scanner responses separate rejected rows from eligible ranking and carry reasons
for inspection. Research liquidity inputs can also be supplied to the pure
price-action evaluator. Search-only technical analysis does not use that optional
research gate: it is not a bot candidate or execution authorization.