# Off Shift Options - decision-system roadmap (drafted Oct 31, 2026)

Source: Matt's "Next Phase of Development" brief (sections 1-10, received in two pastes on Oct 31, 2026). This is the
architecture and sequence Claude proposes; Matt has not yet approved it.

## What already exists (build on it, do not restart)

| Need in the brief | Already in the app |
|---|---|
| RSI / Bollinger / price / volume / option liquidity / delta / ROR scoring, PASS / NEAR | Scanner (`src/domain/scanner/*`), per-user technical cache, "Prepare data now" |
| Earnings dates, "unknown is not safe" | `EarningsCalendarEntry` (one shared Alpha Vantage EARNINGS_CALENDAR call covers every ticker) + `earningsEvidence.ts` (SCHEDULED / STALE / AMBIGUOUS / NO_EVIDENCE, fail-closed) |
| Fundamentals | `TickerFundamentals` (Alpha Vantage OVERVIEW + BALANCE_SHEET, 25 calls/day shared budget, cached, backoff) |
| Per-company decisions (would own, exclusion reason, notes) | Research (`WatchlistItem`: researchStatus, wouldOwn, exclusionReason, manual fields) |
| Position next steps | `nextStep.ts`, `positionReview.ts`, the 3 PM check |
| Roll / assignment / covered-call handling | Campaign model + Schwab reconciliation |

Gaps: no ethical-screening data, no durability score from price history, no macro-event calendar, no news/filing
monitor, no learn-from-results loop, no single ranked "what should I do" view.

## Principles (apply to every phase)

1. Facts before AI. Compute everything we can from data we already pull (Schwab candles/chains, shared earnings
   calendar). Use an AI model only to read text we cannot parse, and only on short, retrieved, public text.
2. Company-level, cached, slow-changing. Ethics, durability and fundamentals are researched once per company and
   refreshed on a schedule or on an event - never per option contract, never per scan.
3. Hard rules cannot be bought off by premium. Verified ethical exclusion, unverified-earnings-inside-the-holding-window
   (new puts), and critical durability failures cap the grade at Avoid regardless of score.
4. Unknown is its own state. Missing / stale / unverified data is shown as "Unverified", never as "clear".
5. Never invent numbers. No made-up revenue percentages; use labeled qualitative ratings when no figure exists.
6. Everything has a source link, an as-of date, and a confidence (separate from the score).
7. The app does not place orders (see Phase 8 for the staged, opt-in path to change that).

## Phases (each is its own small PR; Matt reviews screenshots, not code)

**Phase 0 - finish the foundation (this week).** Merge "Prepare data now", get scanner data fresh, resolve the
SOFI / PATH tracker mismatch, then ship the "Next moves" panel on the Dashboard: (a) positions needing a decision,
(b) PASS / NEAR scanner names. Also review the 21 Dependabot alerts.

**Phase 1 - event and earnings risk.**
- Configurable earnings buffer (default: no new put may span an earnings date; N days after expiry as a setting).
  Separate rule for assigned shares / covered calls (earnings allowed, shown as a note, not a block).
- Earnings state shown honestly: Confirmed date / Estimated / Unverified (never "none").
- Macro calendar (FOMC, CPI, jobs report): a small dated file taken from the Fed and BLS published schedules,
  refreshed yearly. Zero API cost.
- Abnormal volatility and liquidity flags from option-chain data we already fetch (wide spreads, IV spike vs realized).

**Phase 2 - company durability score (0-100, plus Optimal / Good / Marginal / Avoid).**
- From price history we already download: long-term trend (50/200-day), max drawdown, recovery time after past
  drawdowns, distance to support, volatility. No new API calls.
- From fundamentals: revenue trend, margins, cash, debt, current ratio (Alpha Vantage, already wired).
- Dilution, free cash flow, debt maturity, going-concern notes: SEC EDGAR (free, no key, official XBRL company facts +
  filing list). Recommended as the primary source for deep fundamentals because Alpha Vantage's 25 calls/day cannot
  cover statements for many companies. Needs: descriptive User-Agent, polite rate (<10 req/s). To verify in build.
- Weighted score, but with caps: critical failures cannot be outweighed.

**Phase 3 - ethical compatibility (company-level, human-final).**
- New tables: company ethics profile (per-category rating, evidence confidence, as-of, next-review date), evidence
  items (source URL, quote-free summary, date, source type), and decisions (Approved / Excluded / Under review, who,
  why, when). History kept; every change logged.
- Categories: abortion (direct performance = hard exclusion; manufacturing / distribution / financing graded by
  directness), pornography, gambling (sliding scale 5% / 10% / defining), predatory lending (documented practices,
  not labels), deceptive marketing of substances, other. Score 0-100 + Green / Light green / Yellow / Red / Excluded.
- Click the score to see categories, any verified percentage, evidence, confidence. Percentages shown only when a
  source states them.
- Research is done by Claude in sessions with Matt (primary sources: 10-K / 20-F text, company disclosures,
  regulator records, reputable reporting) for the companies that actually reach the shortlist first (scanner PASS /
  NEAR plus current holdings plus Research list), not the whole 2,500 universe. Results are stored, so there is no
  runtime token cost and the Scanner just joins the stored rating.
- Re-review triggers: new 8-K / major filing, large news item, Matt's manual flag, or the scheduled review date.
- An unrated company shows "Not yet reviewed" (neutral-warning), never green.
- A published faith-based fund / index screen can be used as a cross-check source, labeled as secondary evidence.

**Phase 4 - ranked recommendations.** Combine: ethics gate -> earnings/event gate -> durability -> option quality
(liquidity, delta, strike distance, IV vs realized, premium vs risk). Premium ladder as a preference, not a driver:
look for ~1.0%/week, fall back to 0.8% then 0.6%, below 0.6% = Avoid unless Matt overrides. Output categories:
Optimal / Good / Marginal / Avoid with a one-line reason. Covered calls get their own ranking logic.

**Phase 5 - learn from results.** Log every recommendation (what the app said, data snapshot) and the outcome (expired
worthless / assigned / rolled / loss). Review quarterly: which criteria predicted trouble. 14 campaigns today is too
few to fit weights - first collect, then adjust by hand with evidence; no automatic self-tuning.

**Phase 6 - lightweight AI (Jev or alternative), pilot only.** Rule: if arithmetic, structured data, ordinary
TypeScript or an existing API can decide it, AI is not used. AI is reserved for genuinely qualitative reading of short
retrieved public text (is this headline material? does this filing excerpt describe X? is the business deteriorating?),
and its output is stored as "model judgment" (with model name, prompt version, source text hash, date), visibly separate
from "verified fact". A model's confidence is displayed as a hint, never used as proof and never allowed to set a hard
exclusion by itself - only a human-confirmed (Matt) or primary-source-verified finding can. Design: one `classify()`
adapter (input text + question + allowed answers -> compact JSON), so the provider can change without touching the
strategy; results cached by (company, source-text hash) so unchanged information is never re-analyzed; batch where
the provider allows. Before adopting any provider: label ~50 real examples, compare Jev vs a small Claude model vs a
no-AI keyword baseline on accuracy / cost / latency / failure behavior. If the baseline is good enough, no AI.
Public text only - never account data. See "Jev notes" below.

**Phase 7 - position lifecycle and account-level protection.**
- Full economics per position (premiums, commissions, realized loss, roll costs, net vs original assignment price);
  a roll is shown with its true net credit/debit and never labeled "recovered" unless the numbers say so. Much of this
  exists in Campaigns; gaps are fees-pending cleanup and a per-position "break-even to recover" view.
- Covered-call strike suggestions anchored on assignment price / economic break-even, with the cost of getting there.
- Account-level guardrails checked before any recommendation is shown as OK: max % of account in one name, max total
  collateral committed, correlated names (same sector / theme), and event clustering (several positions exposed to the
  same earnings or macro date). Thresholds are settings with sensible defaults.
- Realistic performance measures instead of "% expired worthless": actual P&L, drawdown, capital utilization,
  assignment frequency, time to recover, risk-adjusted return. (The Performance tab already has the first pieces.)

**Phase 8 - automation, staged and opt-in. Not started until Phases 0-7 have a track record.**
Ladder (matches Matt's): (1) research + recommendations; (2) paper trading - the app records the order it WOULD have
placed and later scores it against real prices; (3) real orders queued for Matt's approval; (4) limited automatic
execution inside strict limits; (5) broader only after a convincing record. Controls that must exist before step 3:
a separate Schwab credential used only for orders (if Schwab allows narrower scopes - to verify), approved-ticker list
and ethics gate re-checked at order time, hard limits (contracts, dollars, orders per day, strategies allowed =
cash-secured put / covered call only, no market orders, limit price bounds), idempotency key and duplicate-order check
against Schwab's live orders before every submit, order-status reconciliation after, a global kill switch (one click
and automatic on repeated errors), full audit log, safe failure on any API error (never retry blindly), and a daily
position/cash reconciliation that halts trading on any mismatch. Today the app never places orders, enforced in code
and by documentation; that property is kept until step 3 is explicitly approved by Matt.

## Recommended order (risk reduction first, then usefulness, effort, API limits, cost)
1. Phase 0 (foundation + Next moves) - removes today's reliability gaps; low effort.
2. Phase 1 earnings / event gates - biggest single risk reducer for new puts; mostly existing data; low effort.
3. Phase 2 durability from price history first (free), then EDGAR fundamentals - medium effort.
4. Phase 3 ethics - highest value to Matt but research-heavy; start with the shortlist and current holdings.
   (Can run in parallel with 2 because it is mostly Claude research sessions, not code.)
5. Phase 4 combined ranking and compact UI - after 1-3 have real data to rank.
6. Phase 7 account guardrails - small and valuable at this account size (see below); can move ahead of 4.
7. Phase 5 logging starts as soon as Phase 4 ships; Phase 6 AI pilot only if a real gap remains; Phase 8 last.

## Assumptions worth challenging
- **Account size drives risk more than any score.** At about $10.7k, one $25-strike put ties up $2,500 (~23% of the
  account); three or four positions fill it. Concentration, correlation (UPST and SOFI are both fintech; CORZ is a
  crypto miner) and event clustering are the dominant risks, so account-level guardrails (Phase 7) matter early.
- **1% weekly is about 50% annualized.** Premium that high usually is the market pricing real risk; that is why the
  ladder (1.0 -> 0.8 -> 0.6) and the "attractive premium is not a good company" rule belong in the ranking, not as
  a target to hit. Never force a trade.
- **"Expired worthless" is not performance.** Judge on realized P&L including the assigned-and-stuck cases.
- **Ethical data is the least available data.** No free feed answers "does this company perform abortions".
  Reality is curated research with sources; hence the explicit "Not yet reviewed" state and shortlist-first rollout.
- **AI confidence is not accuracy.** Model judgments stay labeled and can never hard-exclude on their own.
- **Read-only is currently a big safety property.** The Schwab connection is only used for reads because our code never
  calls order endpoints; real automation changes the threat model (a stolen token could trade), which is why Phase 8
  needs separate credentials, limits, and a kill switch rather than "turn on trading".
- **Estimated earnings dates are not safe.** Treat unverified or stale as unknown, and unknown blocks new puts.

## UX principle
Compact default row: Premium / collateral required, trade grade (Optimal / Good / Marginal / Avoid), durability score,
ethics badge, earnings/event warnings, one-line reason. Everything else (evidence, categories, history) opens on demand
and is stored, not regenerated.

## Cost and API budget
- Schwab: no extra cost; durability uses candles we already fetch.
- Alpha Vantage free: 25 calls/day. Keep for the earnings calendar (1 call covers all) and OVERVIEW on shortlist names.
  Paid tier is a later option only if needed. Whether INCOME_STATEMENT / CASH_FLOW / NEWS_SENTIMENT are free-tier is
  unconfirmed - test one call before relying on them.
- SEC EDGAR: free. Macro calendar: static file. AI: only Phase 6, tiny prompts, cached.

## Jev notes (verified Oct 31, 2026)
- `https://jev-ai.org/docs/` fails the TLS handshake (certificate/protocol error) - do not send anything to it.
- Public sources describe Jev as TypeSafe AI's decision model (yes/no probability "noul", choice, score), early
  access, also reachable through AIML API (`/v1/decisions`) and an OpenRouter Decisions API client. Official docs,
  pricing and access terms still need to be confirmed from TypeSafe's own site before any pilot.

## Decisions needed from Matt
1. Approve the order above (or reorder).
2. Earnings buffer default for new puts: block any earnings date on or before expiration (+0 days), or add a cushion?
3. Ethics research: OK to start with current holdings + scanner PASS / NEAR names + Research list, rating each with
   sources, and for you to confirm borderline ones?
4. Account guardrail defaults (max % in one name, total collateral, max per sector) - suggest starting values after
   Phase 0.
