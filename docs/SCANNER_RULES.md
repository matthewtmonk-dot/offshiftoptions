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

## Current live selection (September 16, 2026)

Contract selection is separate from criterion scoring. The confirmed LST Core thresholds remain price $10–$50, RSI <=40, BB <=33%, Put ROR >=1%, earnings >=10 days, stock volume >=40,000, OI >=100, and option bid >=$0.10. No calculation or PASS/FAIL/UNKNOWN/NEAR/VERIFY semantics changed.

1. Preserve structural PUT/OTM/positive-bid/available-ask eligibility and enabled hard DTE, bid/OI/spread/delta gates. UNKNOWN gates remain eligible; they never become a fabricated PASS.
2. Among surviving expiration dates, choose smallest `abs(DTE - 7)`, then greater DTE, then expiration date ascending. The target is a selection preference, separate from hard DTE eligibility. With DTE disabled, its stored/default 14–45 range has no effect. With DTE enabled, only dates in the user's inclusive range compete. No exchange weekly/monthly label is required.
3. Within that one date, choose highest existing setup score, then highest annualized ROR, then strike ascending, then provider symbol ascending. **Matt explicitly accepts lower strike as an intentional LST safety/cushion preference when score and annualized return tie:** more distance below the current stock price and lower cash-secured collateral, with the strategy intent of reducing assignment pressure. It is a late selection preference, not a guarantee against loss or assignment, and never overrides setup score, annualized ROR, enabled gates, or weekly expiration selection. Symbol ascending supplies the final deterministic ordering. Annualized ROR remains a quantitative tie-break even if its criterion is disabled.
4. A weekly strike missing the 1% ROR target remains selected with its actual rule result. A different date can win only when the closer date has no contract surviving the existing structural/hard gates. UNKNOWN OI alone does not force a fallback. A chain with no eligible contracts retains the existing reason code and blank option fields.

Option enrichment stays capped at eight in production. Known stock FAILs are excluded. First priority is all enabled stock criteria known and PASS; second is no FAIL with one or more UNKNOWN. Within each priority group sort `(RSI ?? 100) + (BB% ?? 100)/10` ascending, then ticker ascending. Disabled criteria do not reduce priority; personal Research state never improves it. The bounded persisted-result list uses this same comparator so enriched rows remain visible.

Engineering diagnostics are stored in the existing `ScanResult.snapshotJson`, without new UI or migration: selected `expiration`/`dte`/`optionSymbol`, `optionSelectionTargetDte`, `optionSelectionReason`, `optionSelectionPreferredExpiration`, and `optionSelectionFallback`. Preferred expiration means closest to seven in the **normalized returned PUT chain before eligibility gates**. Fallback means that date was fully eliminated; having no exact seven-day listing alone is not fallback. These fields describe new runs only, not historical chains or raw contracts discarded by the provider normalizer. Full rejected chains and shortlist ordinals are not retained.

**Separate follow-up:** earnings distance still means days from today, not earnings after expiration. Matt's September 16 NKE observation (16 DTE / earnings in 15 days) requires a separate product decision; this slice does not change that rule.

## Historical seeded Phase 1 Rules

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
