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

## Current live selection (September 16, 2026 - expiration-before-quality-gates fix)

Contract selection is separate from criterion scoring. The confirmed LST Core thresholds remain price $10–$50, RSI <=40, BB <=33%, Put ROR >=1%, earnings >=10 days, stock volume >=40,000, OI >=100, and option bid >=$0.10. No calculation or PASS/FAIL/UNKNOWN/NEAR/VERIFY semantics changed.

**Audit finding (fixed this slice):** the prior implementation applied enabled bid/OI/spread/delta gates *before* choosing which expiration to assess. That let a bad-liquidity or low-ROR weekly contract lose every candidate at its own date, so a 93/121/156-DTE contract that happened to PASS became "the closest surviving expiration" by default - a monthly/LEAPS contract silently standing in for a weekly one. The fix separates **structural existence** (decides which expirations exist) from **strategy quality** (decides which strike is preferred, never whether the expiration exists):

1. Structural existence only: PUT contracts, strike below the current stock price (OTM), a positive bid and a real ask (a $0-bid contract cannot be sold - this floor applies even when the `optionBid` rule is disabled), and the expiration's DTE inside the applicable horizon. The horizon is the user's own enabled hard `dte` range when present (authoritative), otherwise the **default weekly horizon of 1-13 DTE** - a scanner built around a ~7-DTE weekly CSP must not wander into a monthly contract just because nothing sits at the exact target. Nothing in this stage is a quality judgment; UNKNOWN evidence is never treated as absence.
2. Among structurally-valid expirations only - **before any bid/OI/spread/delta gate is applied** - choose smallest `abs(DTE - 7)`, then greater DTE, then expiration date ascending. If none exist in the applicable horizon: `NO_EXPIRATIONS_IN_CONFIGURED_RANGE` when the hard DTE rule is enabled and empty, or the new `NO_WEEKLY_EXPIRATION` ("No suitable weekly expiration available") when it's disabled and the default 1-13 horizon is empty - never a silent fallback to 21/30/93/121/156 DTE.
3. Only now do enabled bid/OI/spread/delta gates run, and only to prefer a STRIKE within the already-chosen expiration: if at least one of that expiration's strikes passes every enabled gate, prefer those; if none do, score all of that expiration's strikes anyway rather than returning blank - the resulting row shows its real FAIL/NEAR, never a jump to a different expiration. A weekly strike missing the 1% ROR target (or any other enabled gate) remains selected with its actual rule result; UNKNOWN OI alone never forces a fallback either.
4. Within the chosen expiration, choose highest existing setup score, then highest annualized ROR, then strike ascending, then provider symbol ascending. **Matt explicitly accepts lower strike as an intentional LST safety/cushion preference when score and annualized return tie:** more distance below the current stock price and lower cash-secured collateral, with the strategy intent of reducing assignment pressure. It is a late selection preference, not a guarantee against loss or assignment, and never overrides setup score, annualized ROR, enabled gates, or weekly expiration selection. Symbol ascending supplies the final deterministic ordering. Annualized ROR remains a quantitative tie-break even if its criterion is disabled.

Option enrichment stays capped at eight in production. Known stock FAILs are excluded. First priority is all enabled stock criteria known and PASS; second is no FAIL with one or more UNKNOWN. Within each priority group sort `(RSI ?? 100) + (BB% ?? 100)/10` ascending, then ticker ascending. Disabled criteria do not reduce priority; personal Research state never improves it. The bounded persisted-result list uses this same comparator so enriched rows remain visible.

### Option-chain request narrowing (September 17, 2026)

The scanner asks Schwab only for what it can evaluate: `contractType=PUT` plus a `fromDate`/`toDate` window covering the active DTE horizon (the default 1–13 weekly horizon, or the user's own enabled hard DTE range). `range=OTM`, `strategy=SINGLE` and `includeQuotes=TRUE` are unchanged - the OTM definition and the bid/ask/delta/OI rules all depend on them. Previously every request returned every listed expiration (weeklies through LEAPS) for both contract types, nearly all of which was parsed and discarded.

This is a transport narrowing only: the requested window is the *same* horizon `bestPutValues` already filters on, so an identical set of in-window contracts still produces an identical selection. Two honest consequences: the provider-level cache key now includes the window and contract type (a narrow response must never be served to a wider request), and `optionSelectionPreferredExpiration`/`optionSelectionFallback` are now computed over the returned in-window chain rather than the full chain - "preferred" now means "closest to seven among the weekly window OSO asked for". `toDate` inclusivity has not been verified against live Schwab responses (the API reference is login-gated); the DTE filter still runs on whatever returns, so a boundary contract could only ever be missed, never wrongly selected.

### Option enrichment disposition (September 17, 2026)

`optionEnrichment` (persisted in the existing `ScanResult.snapshotJson`, no migration) records whether a row's options were actually assessed - a different question from `contractReasonCode`, which only describes what a chain OSO *did* fetch contained. Because enrichment is budgeted, most rows in a broad scan are stock-screened only, and their option criteria read UNKNOWN because nobody asked Schwab, not because Schwab had no answer.

| State | Meaning | Scanner badge |
|---|---|---|
| `ENRICHED` | A chain request was spent on this ticker, successful or not (a failed request is still an assessment - see `CHAIN_UNAVAILABLE`) | unchanged PASS/NEAR/FAIL/VERIFY |
| `NOT_ENRICHED_BUDGET` | Shortlist-eligible but ranked outside the cap | `STOCK SCREEN ONLY` - "outside top-8 enrichment budget" |
| `NOT_ENRICHED_STOCK_FILTER` | A known stock-level FAIL excluded it before options were worth pricing; it never competed for the budget | `STOCK SCREEN ONLY` - "stock screen did not qualify" |
| `NOT_ENRICHED_DATA_UNAVAILABLE` | The quote/history needed to even run the stock screen failed | `STOCK SCREEN ONLY` - "stock data unavailable" |

A never-assessed row shows exactly one truthful line instead of per-criterion "Option bid unavailable / Open interest unavailable / Put ROR is unknown" phrasing, which would assert a Schwab answer that was never requested. `STOCK SCREEN ONLY` is deliberately an assessment-stage label, not a fifth option-quality verdict, and is styled apart from the four. Rows from runs predating the field keep their previous display rather than being relabelled on a guess. The state is its own field precisely so it survives a more specific technical `scanNote` claiming the note text. Near-match counting is deliberately unchanged (see the open scoring decision below).

Engineering diagnostics are stored in the existing `ScanResult.snapshotJson`, without new UI or migration: selected `expiration`/`dte`/`optionSymbol`, `optionSelectionTargetDte`, `optionSelectionReason`, `optionSelectionPreferredExpiration`, and `optionSelectionFallback`. Preferred expiration means closest to seven in the **normalized returned PUT chain before any structural, horizon, or quality gate**. Fallback means that closer date had no structurally-valid contract at all (never merely a quality-gate loss, since quality gates no longer affect which expiration is chosen); having no exact seven-day listing alone is not fallback. A blank `NO_WEEKLY_EXPIRATION`/`NO_EXPIRATIONS_IN_CONFIGURED_RANGE` row has no selected expiration to report a fallback against. These fields describe new runs only, not historical chains or raw contracts discarded by the provider normalizer. Full rejected chains and shortlist ordinals are not retained.

**Separate follow-up:** earnings distance still means days from today, not earnings after expiration. Matt's September 16 NKE observation (16 DTE / earnings in 15 days) requires a separate product decision; this slice does not change that rule.

**Open decision - UNKNOWN score credit (deliberately not changed):** `setupScore` awards 0.45 (45%) for every UNKNOWN criterion, so a stock-clean row whose options were never requested still scores around 79/100 on three option inputs nobody fetched. That inflates the average score and the near-match counts, which therefore partly measure missing data rather than market quality. Changing it alters scoring semantics for every row, so it needs an explicit product decision - the enrichment-disposition work above deliberately left every score, near-match count and label untouched.

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
