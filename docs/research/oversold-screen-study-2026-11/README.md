# Oversold-screen study and strategy review (Nov 5, 2026)

Record of a structured Claude-vs-ChatGPT review of the weekly cash-secured-put scanner, and of the one empirical test it
produced. Nothing here changes a threshold. No account balances, positions or credentials are in this folder.

## How the review worked
Claude (engineer: repo, tests, live app) and ChatGPT (high-effort reasoning partner) were told to challenge each other and
not simply agree. Four rounds. Claude corrected its own first-round numbers against the code and the owner's saved profile.

## What ChatGPT challenged (and what was decided)
| Topic | Outcome |
|---|---|
| Ranking | Real weakness: `setupScore` is the share of criteria passed, so every full pass scores ~100 and **premium decides the tie**. Not fixed yet. Needs a stock-quality dimension kept separate from technical setup and option economics. |
| Stock quality | Thin today (ethics + debt/equity <= 1.2 + technical oversold). Proposed SEC-filings tiers A / B / VERIFY / REJECT. A hard "operating cash flow > 0" gate was judged too strict for this universe; agreed instead: REJECT only on clear distress (confirmed going-concern, < 4 quarters stressed cash runway), CAUTION for 4-8 quarters, VERIFY when data is missing. Not built. |
| Volume | Today's cumulative share volume makes results depend on the time of day. Replace with a 20-day average dollar volume (ChatGPT proposed >= $20M/day). Needs a DB column, so needs the owner's go-ahead before any migration. |
| Concentration | Current 25% per company / 80% total kept as a comparison scenario; ChatGPT's provisional starting point is 20% / 60%, including assigned shares. Owner's drawdown tolerance is unknown and is his decision. |
| Yield floor | Scanner floor 1.0%, planner floor 0.6% (inconsistent). Agreed: premium must not be rewarded in ranking; replace fixed floors with a net-economics check (fees <= 10-15% of gross premium) plus a "suspiciously rich premium" flag. The 15% annualized rule is redundant (owner has it off). |
| Falling-knife guards | Tested (below). **All four DROPPED** by the pre-registered rule. |
| Rolling | Roll only if the replacement independently passes entry rules; compare roll vs close vs assignment using ask-to-close, bid-to-open and fees on both legs; campaign P/L = realized + unrealized + dividends - costs without double counting premium. Not built. |
| Vehicle | Keep cash-secured puts (not credit spreads): fewer, better companies, zero trades allowed. |

## Pre-registered study (protocol V1.0, written by ChatGPT before any data was inspected)
* Signal: Friday close with RSI(14, Wilder) <= 40 and Bollinger %B <= 33. Entry: next Monday open. As-traded price $10-50, prior 20-session average dollar volume >= $20M, >= 252 sessions of history.
* Outcome: intraday low >= 10% below entry within 10 sessions. Guards (each tested alone): G1 5-session drop > 3x ATR(14); G2 below a falling 200-day average; G3 within 5% of the 52-week low; G4 gap-down > 2x ATR on > 2x volume in the last 10 sessions.
* Decision rule: CAUTION needs >= 2 pp absolute and >= 20% relative reduction with >= 60% retention and statistical support in two validation years; REJECT needs >= 4 pp / 40% / 75% retention; otherwise DROP. Development 2016-2022, validation 2023 on (no tuning on validation). Week-block bootstrap, Bonferroni one-sided 1.25%.
* **Survivor-only exploratory:** free data lacks delisted companies, so the study may not authorize any hard rejection.

## Result (validation period, 6,264 baseline signals, baseline tail rate 18.7%)
| Guard | Flagged | Retention | Tail rate if excluded | Reduction | Decision |
|---|---|---|---|---|---|
| G1 rapid decline | 635 | 90% | 18.7% | 0.0 pp | DROP |
| G2 falling trend | 3,448 | 45% | 18.8% | -0.1 pp | DROP (also fails retention) |
| G3 52-week low | 1,781 | 72% | 19.5% | -0.8 pp | DROP |
| G4 gap-down | 484 | 92% | 18.8% | -0.1 pp | DROP |

* G2 looked strong in development (25.3% -> 19.8%, mostly 2020) and did **not** replicate: an in-sample result.
* The oversold screen itself was not riskier than comparable stocks in validation (18.7% vs 19.9%), but in development it was (25.3% vs 22.0%, driven by 2020). Neither period proves safety across regimes.
* Caveats: survivorship (36 of 523 listed tickers returned 404), overlapping windows and same-stock dependence (p-values optimistic), a few market-wide selloffs dominate, 47 unexplained large jumps, prices not dividend-adjusted, and **no option economics**: this is a stock-price tail study only.
* Deviation from the protocol: "a year supports a guard" was not defined; the runner required >= 20 flagged observations and the CAUTION effect sizes.

## Next free-data test ChatGPT asked for
Historical 5% and 10% **strike-touch** frequencies and **expiration-in-the-money** frequencies, separately (an 18.7% chance of a >= 10% intraday drop is not an 18.7% assignment rate).

## Readiness verdict (ChatGPT, accepted by Claude)
Not ready to recommend real-money trades unattended; usable as a **candidate finder with human review**. Before the next new trade: complete option pricing (SCAN INCOMPLETE now warns), a real ownership-quality check per candidate, review of any open in-the-money put, enforced position limits and no-trade decisions. Within 30 days: 20-day average dollar volume, SEC quality tiers, campaign P/L, candidate and outcome logging. Provisional sizing for a roughly $10k account: 20% per company, 60% total, uncommitted cash is fine.

## Reproducing
`node fetch.mjs` (throttled, disk-cached Yahoo daily data into `./cache`), then `node study.mjs`. Both scripts are read-only research code, not part of the app. The `cache/` folder is git-ignored.
