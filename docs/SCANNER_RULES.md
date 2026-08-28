# Scanner Rules

The scanner engine intentionally keeps each criterion separate. It never collapses internal logic to a single Boolean.

Each criterion stores:

- criterion name
- actual value
- operator/rule
- desired value or range
- result: `PASS`, `FAIL`, or `UNKNOWN`
- human-readable explanation

The overall result is derived from criterion results:

- `FAIL` if any criterion fails.
- `UNKNOWN` if none fail and at least one is unknown.
- `PASS` only if all enabled criteria pass.

## Seeded Phase 1 Rules

Matt and Eric each receive a `My LST` profile with demo thresholds:

- price between 10 and 80
- RSI less than or equal to 55
- Bollinger percentage less than or equal to 70
- absolute delta between 0.12 and 0.30
- return on risk at least 1%
- bid/ask spread no more than 25%
- open interest at least 100
- option volume at least 25
- earnings distance at least 14 days
- debt/equity no more than 1.2

These thresholds are demonstration data, not investment recommendations.

## Future Rule Families

The schema can support future option-chain rules without redesign:

- stock price min/max
- RSI maximum
- BB percentage maximum
- DTE min/max/target
- absolute delta min/max
- distance from strike
- premium minimum
- ROR and annualized ROR
- bid/ask spread
- open interest and option volume
- implied volatility
- extrinsic value
- stock volume and average volume
- earnings before expiration
- do-not-trade flags
- fundamental rules
