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

Matt and Eric each receive their own `My LST` profile (`ScannerProfile`, `PRIVATE` visibility) seeded with demo thresholds:

- stock price between 10 and 80
- DTE between 14 and 45
- RSI less than or equal to 55
- Bollinger percentage less than or equal to 70
- absolute delta between 0.12 and 0.30
- put ROR at least 1%
- annualized ROR at least 15%
- option bid at least $0.05
- bid/ask spread no more than 25%
- open interest at least 100
- option volume at least 25
- earnings distance at least 14 days
- Do Not Trade filter (fixed at "must be false")
- debt/equity no more than 1.2

These thresholds are demonstration data, not investment recommendations.

## Editable Per-User Settings (Phase 1B)

`/scanner/settings` lets each user edit their own `My LST` profile:

- Every rule in `SCANNER_RULE_DEFINITIONS` (`src/domain/scanner/profile.ts`) can be enabled/disabled and, for numeric/range rules, have its desired value(s) changed.
- The boolean Do Not Trade rule is not user-editable beyond enable/disable; its desired value is always `false`.
- Settings are private per `ScannerProfile` (`@@unique([profileId, key])` on `ScannerRule` prevents duplicate rule keys per profile) — editing Matt's settings never changes Eric's, and vice versa. Covered by `src/lib/workflows.integration.test.ts`.
- Saving settings re-runs the demo scanner immediately so the Scanner page reflects the new thresholds.

## Future Rule Families

Remaining option-chain rules the schema can support without redesign:

- distance from strike
- premium minimum
- implied volatility
- extrinsic value
- stock volume and average volume
- additional fundamental rules
