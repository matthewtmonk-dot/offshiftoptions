# PROJECT_HANDOFF.md

**This is the canonical current-state document — read this first.** It is short by design: current truth only, not a chronological diary. Detailed subsystem history, feature-by-feature narratives, and superseded next-steps live in `docs/PROJECT_HANDOFF_ARCHIVE.md` and the other `docs/*.md` files listed at the bottom — read those only when a task actually needs that depth. When repository state and this file disagree, investigate which is correct and fix this file; do not silently trust either.

---

## AI Continuity Rules

1. Read this entire file before making project changes. Inspect actual repository state before relying on it — this file can go stale.
2. When Matt explicitly says **"Read PROJECT_HANDOFF.md"**: read this file and `AGENTS.md`/`CLAUDE.md`, confirm enough of the real repository to know this file still matches reality, then respond with **only** `Ready.` — no summary, no recap, no next-steps list — unless there's a genuine blocker (contradiction, security concern, broken repo state, missing critical information), in which case give the shortest possible explanation instead.
3. **Updating this file is part of the definition of done** for any change to: application behavior, architecture, database/schema, auth, deployment, env vars, hosting/domain, external integrations, scanner behavior, Schwab status, security, PWA, production status, or an accepted roadmap/ticket's status. Keep it a snapshot, not an append-only log — replace stale content, don't pile onto it. Move genuinely historical detail to `docs/PROJECT_HANDOFF_ARCHIVE.md` rather than deleting it.
4. Never put secrets, passwords, API keys, tokens, or connection strings in this file or any tracked file — names/purposes only.
5. Do not silently reverse an architectural decision recorded here or in `docs/DECISIONS.md` — explain the conflict before making a major reversal.
6. Never run a destructive database operation (`prisma migrate reset`, `db:reset`, the destructive `prisma/seed.ts`, an ad hoc reset `deleteMany`) against anything but a disposable local database, without first explaining exactly what data would be lost and getting explicit confirmation.
7. **Database schema changes require special care** — see Production/Deployment below. Never push code that depends on a new migration until that migration is applied to Supabase and verified.
8. Keep brokerage integration read-only. Never add order submission/placement/cancellation because an API supports it, unless Matt explicitly authorizes changing that requirement.
9. Do not blindly implement a technically weaker approach just because it was requested — evaluate for security, data safety, maintainability, and standard best practices, and recommend the better option first.
10. Security-sensitive changes (auth, authorization, database access, financial data, OAuth, brokerage APIs, deployment secrets) require an explicit focused security review before the task is done.
11. If a secret is ever found committed to Git, don't just delete it — report the exposure and recommend credential rotation.
12. Never assume hiding a UI element provides authorization — authorization must be enforced server-side.
13. Never present mock, cached, stale, demo, or manual financial data as live/current market data.

---

## Project Identity & Purpose

- **Product:** Off Shift Options (formerly "LST Buddy") — a private, two-user PWA for Matt and Eric to run a disciplined, low-stress cash-secured-put options workflow: scan candidates, research tickers, track trades, share recommendations, chat, and measure performance over time.
- **Users:** Private two-user application only. No public signup exists or is planned.
- **Not:** a brokerage, a public trading platform, a financial advisory service, or an automated trading bot.
- `PRODUCT_VISION.md` (repo root) is the long-term north-star document; this file is the operational current-state snapshot.

## Product Model: Scan / Research / Track / Performance

Four connected jobs — a change that blurs the boundary between two of them needs a second look before merging:

1. **SCAN** — purely technical PASS/FAIL/UNKNOWN + setup score. Never influenced by personal opinion.
2. **RESEARCH** — the user's personal judgment of a ticker (Like/Watch/Neutral/Avoid/Never Trade). Purely personal: **never changes what Scan computes.** A `NEVER_TRADE` item is hidden from Scanner's default view but its score/status/label are computed exactly as if it weren't excluded.
3. **TRACK** — the append-only historical record of what actually happened (`Campaign`/`CampaignEvent`): every roll, assignment, covered call, and outcome, preserved forever.
4. **PERFORMANCE** — whether the strategy is working over time, built from confirmed ledger/broker facts, never a raw balance-delta guess.

Research *feeds* Scanner (widens the live-scan universe, personal exclusion hides a candidate from the actionable list) but never *replaces* it. See `docs/DATA_MODEL.md`, `docs/LST_DOMAIN.md`, `docs/SCANNER_RULES.md` for subsystem depth.

---

## Current Architecture

| Layer | Current version/tool |
|---|---|
| Framework | Next.js 16.3.3, App Router, Turbopack |
| Language | TypeScript (strict), React 19.2.8 |
| ORM | Prisma 7.10.0 with `@prisma/adapter-pg` (`pg` driver) |
| Database | PostgreSQL — Supabase in production, `postgres:17-alpine` via Docker Compose locally |
| Styling | Tailwind CSS 4 |
| Package manager | pnpm 11.24.0 (via Corepack) |
| Testing | Vitest 4.1.11 (unit + opt-in DB integration), Playwright 1.62.1 (e2e) |
| Hosting | Hostinger managed Node.js hosting, auto-deploy from GitHub `main` |
| GitHub | https://github.com/matthewtmonk-dot/offshiftoptions.git, branch `main` |
| Production domain | https://offshiftoptions.com |

Full architecture detail (runtime shape, data flow, testing layers, local dev paths): `docs/ARCHITECTURE.md`.

## Current Production / Deployment State

```
GitHub main → Hostinger auto-deploy → Next.js app → Supabase PostgreSQL
```

- **Build command:** `node scripts/write-build-info.mjs && prisma generate && next build`. Never seeds, bootstraps, or runs `prisma migrate deploy`. Every push to `main` deploys.
- **`GET /api/health`** → `{ app, database, commit, buildTime, latencyMs, checkedAt }` (200) or `{ app: "ok", database: "error", commit, buildTime, checkedAt }` (503). `commit`/`buildTime` are resolved at build time (`scripts/write-build-info.mjs`, env var else `.git/HEAD` via plain `fs` reads, never a spawned subprocess) — **verifying a Hostinger deploy is `curl https://offshiftoptions.com/api/health` and comparing `commit` to `git rev-parse --short=12 HEAD`.**
- **Migrations are NOT applied automatically by Hostinger** (its build environment can't execute Prisma's schema engine — `EACCES` on spawning it). Required workflow for any schema change: migrate locally → apply to Supabase directly (`DATABASE_URL="<supabase>" pnpm prisma migrate deploy`, from a machine that can execute it) and verify → only then push the dependent code to `main`. Full root-cause detail: `docs/ARCHITECTURE.md`.
- **As of 2026-09-20, all committed migrations are applied to both local Docker Postgres and production Supabase** — no known pending/local-only migration exists. Verify with `prisma migrate status` before trusting this if it's been a while.
- **`prisma/seed.ts`** (`pnpm db:seed`) is **destructive** (development only) — unconditionally deletes and recreates demo data. **`prisma/bootstrap-production.ts`** (`pnpm bootstrap:production`) is safe/idempotent (creates Matt/Eric only if absent) — already run once against production; not part of routine deploys.

## Environment Variables (names/purposes only — never values)

**Production required:** `DATABASE_URL`, `LST_SESSION_SECRET` (session-token HMAC key), `NEXT_PUBLIC_APP_URL`, `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`) + `BUDDY_CHAT_STORAGE_BUCKET` (private Buddy Chat attachment storage).
**Development only:** `DEV_SEED_PASSWORD`, `RUN_DB_TESTS`, `PLAYWRIGHT_BASE_URL` (use `localhost`, not `127.0.0.1`), `BUDDY_CHAT_LOCAL_STORAGE_ROOT`.
**Schwab:** `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `SCHWAB_REDIRECT_URI`, `SCHWAB_TOKEN_ENCRYPTION_KEY` — server-side only, never `NEXT_PUBLIC_`.
**Alpha Vantage:** `ALPHA_VANTAGE_API_KEY` (25 requests/day total, shared), `OSO_CRON_SECRET` (protects the scheduled fundamentals-queue endpoint).
**Future (unused today):** `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` for real Web Push.

---

## User / Data Ownership & Privacy Invariants

- **Matt and Eric are fully separate account owners.** One user's balances, positions, transactions, imported records, campaigns, settings, performance, projections, or research opinions must never populate, affect, or be blended into the other's — proven throughout by DB-integration tests (privacy, workflows, account ledger, research). Sharing a record (`SHARED` visibility) makes it *visible* to the other user; it never merges it into their own totals/balances/P/L.
- `PRIVATE` data stays private to its owner; `SHARED` is visible to both, per `src/lib/privacy.ts` (`assertCanReadRecord`/`assertCanMutateRecord`). Authorization is enforced **server-side only** — UI hiding is never relied on for security.
- Research opinions (Like/Watch/Avoid/Never Trade, notes, manual fields) default to **PRIVATE** and post no shared activity — even the bare fact that a user researched a ticker is personal unless explicitly shared.
- Tracker Performance is always computed from the viewer's **own** accounts/campaigns only, never the scope-filtered Mine/Buddy/Both list — switching scope can make a buddy's shared campaigns *visible*, never blended into your own figures.

## Read-Only Brokerage Constraints

- **This application does not place trades.** No buy/sell/place/submit/replace/cancel-order or algorithmic execution exists or may be added without Matt explicitly changing this requirement. Schwab's Order Limit is configured at **0**.
- Allowed Schwab methods are read-only: `getQuote`, `getPriceHistory`, `getOptionChain`, `getInstrument`, `getMarketHours`, `getAccounts`, `getPositions`, `getTransactions`, `getOrders` (historical observation only).
- Brokerage account data is **user-scoped**: a user's own OAuth connection, tokens, balances, positions, and transactions are never used to serve another user's requests. Personal-broker provider resolution has no cross-user fallback path at all.
- Shared market-data fallback (one user's connection serving another's read-only quote request) remains **disabled** (`DISABLED_POLICY_NOT_VERIFIED`) — no official Schwab documentation has confirmed this is permitted. Do not enable it without that verification.
- **Bounded provider usage:** live scans use a fixed starter ticker universe (currently 13 symbols + the user's own Research union), cap option-chain calls, and use bounded concurrency (`SCAN_FETCH_CONCURRENCY`) — not unbounded polling. Alpha Vantage's 25-requests/day budget is shared across both users and the Scanner and is protected by an explicit queue/priority design (`docs/ARCHITECTURE.md`, Alpha Vantage detail in the archive).
- **A linked broker position record must never supply a current-position mark merely because it belongs to the campaign** (`src/domain/finance/currentPositionMark.ts`, `resolveCurrentCostToClose`) — every candidate is validated against `getCurrentOpenPut`'s own account/underlying/strike/expiration/quantity before being accepted, so a rolled campaign's pre-roll contract (which stays linked forever) can never value the post-roll leg. Freshness policy (`classifyMarkFreshness`, `marketCalendar.ts`): CURRENT_SESSION/LAST_SESSION are usable, STALE/MISSING are rejected outright — calendar-day-only, never invented intraday precision. A rejected/unavailable mark means an honest PENDING/INCOMPLETE `currentPLStatus` (Ticket 4), never a stale number or a fabricated zero.
- Tokens/secrets/developer credentials are encrypted at rest (AES-256-GCM) and never reach client-side JS, logs, or this documentation.

## Campaign / Event-History Invariants

- `CampaignEvent` rows are **append-only** — no workflow ever updates or deletes an existing event. A roll writes a `ROLL_PUT_CLOSE` + `ROLL_PUT_OPEN` pair sharing a `groupKey`; the old and new legs both remain in history, never overwritten. The full lifecycle (open → roll → assign → covered call → close) is always reconstructible from events alone.
- **`getCurrentOpenPut` (`src/domain/finance/campaigns.ts`) is the single authoritative definition of "what put is open right now"** — used identically by the Dashboard, Tracker, and Performance (`summarizeCampaignProgress`). Do not add a second, competing interpretation of current-leg state anywhere; delegate to this function instead. Its event ordering (`compareEvents`) is fully deterministic (`occurredAt` → `sortOrder` → `createdAt` → `id`), so the same event history produces the same result regardless of array/query order — this was a real, fixed bug (see Roadmap status below).
- **Conservative expiration confirmation:** a short put is only marked expired-worthless when broker evidence is complete (positions COMPLETE, all transaction categories COMPLETE, persistence COMPLETE, the transaction window covers expiration, no remaining matching option, no acquired long position) — any failed/partial/incomplete evidence keeps the campaign OPEN (`EXPIRATION_EVIDENCE_INCOMPLETE`) rather than guessing. Never invents an OTM quote or a zero-cost close.
- A `CampaignStatus` of `OPEN`/`ASSIGNED`/`CLOSED` and a `Campaign.visibility` of `INHERIT`/`PRIVATE`/`SHARED` (inheriting from the parent `TradingAccount` when `INHERIT`) fully describe lifecycle/visibility state — see `docs/DATA_MODEL.md`.

## Reconciliation / Import Safeguards

- Never use a filename or CSV row number as economic identity. Use `BrokerRecord.fingerprint` (the exact economic fact — backs DB-level dedupe) and a separate `identityKey` (the same real-world slot — account+date+symbol+action — without the financial fields, used for conflict detection).
- A same-`identityKey`-different-`fingerprint` match is always a `CONFLICT`, stored as a separate row for manual review — **never a silent overwrite** of the original.
- Import classification is `NEW | DUPLICATE | CONFLICT | NEEDS_REVIEW | INVALID` — never guessed. Preview-before-persist: uploading/previewing a file never mutates financial history by itself; only an explicit Confirm persists `BrokerRecord`s.
- `CampaignEvent`s remain the sole trading-performance source of truth even for a campaign created from reconciled broker evidence — a Realized Gain/Loss import may only *verify* a campaign's result, never add to it.
- Linking a broker position to a `Campaign` (via reconciliation) makes it count exactly once in Dashboard/Tracker totals; an unlinked broker position stays additive by design (no reconciliation identity exists for it yet).

## Scanner — Purpose & Current Constraints

- `src/domain/scanner` evaluates each criterion PASS/FAIL/UNKNOWN; overall result is FAIL if any criterion fails, else UNKNOWN if any is unknown, else PASS. **Gating** rules (price, volume, OI, bid, spread, delta, earnings distance, Do Not Trade) cap the displayed score/label at "Fails" on any FAIL — the UI never shows positive language for an untradeable setup. An UNKNOWN result is labeled "Verify," never a positive score.
- **LST Core** (`SCANNER_RULE_DEFINITIONS`) is the canonical default rule set; each user can edit their own `ScannerProfile`/`ScannerRule` and reset to LST Core at any time — editing one user's settings never affects the other's.
- Live scanning uses a bounded starter universe + the user's own Research tickers, option-chain calls capped, bounded concurrency — see Bounded Provider Usage above. Demo data is always visibly labeled as demo, never presented as live.
- **Scanner and Research are separate concepts** (see Product Model) — a Research/personal-exclusion status must never alter a Scan result's technical score, status, or label.
- A separate **Covered Call scanner mode** exists (decision support only, universe = the user's own `ASSIGNED` campaigns) — architecturally distinct from the CSP live scanner, not a generalization of it.
- Full rule catalog and selection algorithm detail: `docs/SCANNER_RULES.md`.

## Financial / Accounting Invariants

- Account/trading performance is derived from the append-only `AccountLedgerEntry` ledger plus confirmed `BrokerRecord` facts — **never** a raw `currentBalance − startingBalance` shortcut, which would silently mix deposits/withdrawals with trading P/L.
- Only `CLOSED` campaigns count toward win/loss; an `OPEN` campaign's net cash flow (even if positive) is never counted as a completed win.
- **Confirmed vs. incomplete/provisional data must stay visibly distinct**: `src/domain/finance/performance.ts` exports a shared `CompletenessStatus` (`CONFIRMED | PENDING | INCOMPLETE | NOT_APPLICABLE`) - `WinLossSummary`/`ThisWeekSummary` compute `wins`/`losses`/`winRate` from CONFIRMED outcomes only (`confirmedCount`/`pendingCount` expose the split), and `CampaignProgressSummary` carries `currentPLStatus`/`projectedOtmStatus` per campaign. An unresolved Schwab fee shows "Pending"/gross-only, never a fabricated confirmed net number (`feesFullyKnown`/`netPLExact`/`grossPL`) and is excluded from the confirmed win/loss denominator. A missing cost-to-close/current-price source means the current mark is shown as unavailable (PENDING), never guessed; a legacy event missing required fields is INCOMPLETE, distinct from a campaign where the metric genuinely doesn't apply (NOT_APPLICABLE) - see `getOpenPutEvidenceState` (`campaigns.ts`). An `ASSIGNED` campaign's current valuation is INCOMPLETE, not NOT_APPLICABLE, since real exposure exists with no valuation engine yet (Roadmap item 7). `currentCollateralCommitted` (the *currently* open leg's own collateral) is distinct from `collateralCommitted` (a lifetime high-water mark used only for closed-campaign return-on-collateral) — using the wrong one for "what's secured right now" was a real, fixed bug (see Roadmap status).
- Deposits/withdrawals are never presented as trading profit or loss. Total gain, trading P/L, other income, current/mark-to-market P/L, and projected-OTM P/L are separate, explicitly labeled figures, not blended.
- Full methodology: `docs/ARCHITECTURE.md`, `docs/LST_DOMAIN.md`, and the archive's Account Ledger / Performance Methodology section.

---

## Current Accepted Roadmap

High-level sequence only — implementation detail for a ticket belongs in its own commit/PR/handoff note, not here:

1. **Ticket 1 — Current-leg parity between campaigns and Performance** — **COMPLETE**, commit `f68849f`. Astra-approved with a non-blocking follow-up (resolved by Ticket 4, see below).
2. **Ticket 2 — PWA privacy/cache verification** — **NOT REPRODUCED** (the suspected authenticated-content-caching risk did not reproduce under real browser testing, including an adversarial poisoned-cache simulation); no code change made; no Astra review required.
3. **Ticket 3 — Documentation cleanup** — **COMPLETE** (this restructuring).
4. **Ticket 4 — Confirmed/pending/incomplete profit-status propagation** — **COMPLETE**, ready for combined Astra review with Ticket 5 (see below). Added a shared `CompletenessStatus` (`CONFIRMED | PENDING | INCOMPLETE | NOT_APPLICABLE`) to `src/domain/finance/performance.ts`: `WinLossSummary`/`ThisWeekSummary` now split `confirmedCount`/`pendingCount` and compute `wins`/`losses`/`winRate` from CONFIRMED outcomes only (a completed campaign with an unresolved fee no longer inflates the confirmed win rate); `CampaignProgressSummary` gained `currentPLStatus`/`projectedOtmStatus` per campaign, backed by a new `getOpenPutEvidenceState` (`src/domain/finance/campaigns.ts`) that distinguishes "no put open" from "a put should be open but its evidence is incomplete" - the exact distinction `projectedOtmApplicable` alone couldn't make. Fixed the Astra-flagged bug directly: Tracker's `currentCampaignPartial`/`projectedOtmPartial` (`positions/page.tsx`) now check `currentPLStatus`/`projectedOtmStatus === "INCOMPLETE" | "PENDING"` instead of the old `projectedOtmApplicable && value === null` check that silently missed incomplete-evidence rows. An `ASSIGNED` campaign's current valuation is now explicitly INCOMPLETE (real exposure, no valuation engine yet - not NOT_APPLICABLE), so it correctly flags aggregate coverage as partial. Dashboard/Tracker win-loss and Closed-Record displays now show a "+N pending" count. No schema change. 50+ new/updated tests.
5. **Ticket 5 — Validated current-position marks + separated exposure types** — **COMPLETE**, ready for combined Astra review with Ticket 4. Root cause: the Tracker's cost-to-close resolver accepted the first linked Schwab POSITION record classified as a short put merely because it belonged to the campaign - for a rolled campaign, its PRE-ROLL contract's own historical position snapshot stays linked forever, so a rolled campaign's current valuation could silently use the OLD contract's numbers. Fixed by extracting the resolver into `src/domain/finance/currentPositionMark.ts` (`resolveCurrentCostToClose`), which now validates every candidate record's account, underlying, strike, expiration, and short quantity against `getCurrentOpenPut`'s own answer (Ticket 1) before accepting it, plus a new conservative freshness policy (`classifyMarkFreshness`, `src/domain/finance/marketCalendar.ts` - CURRENT_SESSION/LAST_SESSION/STALE/MISSING, calendar-day-only, no invented intraday precision) that rejects STALE/MISSING evidence and labels LAST_SESSION (weekend/holiday) data as "last session," never a live quote. Also fixed a real exposure-type conflation: Dashboard's "Secured (CSP)" fell back to a campaign's lifetime-max put collateral once it had no current open put, which kept an ASSIGNED campaign's old put collateral inside "Secured (CSP)" forever even though that put is gone and the cash is now equity - fixed via a new `summarizeCampaignExposure` (`src/domain/finance/brokerPositions.ts`) that keeps open-put collateral, assigned-share basis, and covered-call coverage as three explicitly separate, honestly-labeled facts (no wheel valuation engine built). No schema change. 33 new tests (`currentPositionMark.test.ts`, `marketCalendar.test.ts`, `brokerPositions.test.ts`).
6. Scanner truthfulness.
7. Account baseline/contribution boundaries.
8. Complete wheel valuation/period reporting - will also be what promotes an ASSIGNED campaign's `currentPLStatus` from INCOMPLETE to CONFIRMED/PENDING (Ticket 4) and gives `assignedShareCapital` (Ticket 5) a real live valuation instead of cost basis only.
9. Dashboard hierarchy.
10. Settings/Admin + communication consolidation.
11. Scanner redesign/readability/mobile/history/benchmarks.

**DB integration tests could not be run for Tickets 4 or 5** (local Postgres/Docker unavailable this session - `ECONNREFUSED`) - flagged for a follow-up run once the environment is back up, before Astra's review is treated as final.

## Known Active Blockers / Issues

- Web Push delivery is a documented no-op (manifest/service-worker/install prompt exist; VAPID keys and the actual push pipeline are not built).
- No CI-automated Supabase migration deploy — still a manual runbook (migrate locally → apply to Supabase → verify → push dependent code).
- `LST_SESSION_SECRET` env var name predates the "Off Shift Options" rebrand — cosmetic, low priority, requires a coordinated Hostinger env var rename.
- CSP allows `script-src`/`style-src` `'unsafe-inline'` (Next.js App Router requirement without a nonce setup) — a possible future hardening, not currently required.
- Research's PEG ratio, Debt/Equity, and Current Ratio remain manual-only — confirmed genuinely absent from Schwab's Trader API; P/E, EPS, and dividend amount/yield **are** auto-populated from Schwab where a live connection exists.
- Eric's research spreadsheet has not been imported (not yet provided; a dry-run-first importer design exists in the archive for when it is).
- Live Schwab scanner uses a bounded starter universe by design, not yet a broad market scan — see Roadmap item 10.

## Where Documentation Lives

| Topic | File |
|---|---|
| Full chronological history, superseded next-steps, detailed subsystem narratives | `docs/PROJECT_HANDOFF_ARCHIVE.md` |
| Earliest project history (Phase 1 foundation through first production deploy) | `docs/HANDOFF.md` |
| Runtime architecture, data flow, testing layers, deployment detail | `docs/ARCHITECTURE.md` |
| Schema/model detail | `docs/DATA_MODEL.md` |
| Recorded architectural decisions | `docs/DECISIONS.md` |
| Domain/strategy detail (LST, rolls, statuses) | `docs/LST_DOMAIN.md` |
| PWA/notifications detail | `docs/PWA_AND_NOTIFICATIONS.md` |
| Scanner rule catalog and selection algorithm | `docs/SCANNER_RULES.md` |
| Schwab integration detail (OAuth, CSV, reconciliation) | `docs/SCHWAB_INTEGRATION.md` |
| Security/privacy detail | `docs/SECURITY.md` |
| Prior long-form roadmap phases (superseded by the roadmap above) | `docs/ROADMAP.md` |

Agent instructions: `AGENTS.md` (coding conventions, commands, gotchas) and `CLAUDE.md` (entry protocol). Both point here first.
