# PROJECT_HANDOFF.md

This is the **canonical single source of truth** for the current state of Off Shift Options. It is not a diary — obsolete information is replaced or removed, not appended to. When repository state and this file disagree, investigate which is correct and fix this file.

---

# AI CONTINUITY RULES

1. Read this entire file before making project changes.
2. When Matt explicitly says **"Read PROJECT_HANDOFF.md"**: read this entire file, read `AGENTS.md` and `CLAUDE.md`, and inspect enough of the actual repository to confirm this file still matches reality.
3. If the project is understandable and no critical blocker requires Matt's input, respond with **only**: `Ready.` Do not summarize this file, do not recap the project, do not list next steps, do not explain what you read.
4. If there is a genuine contradiction, missing critical information, security concern, unresolved merge state, broken repository state, or other issue that makes it unsafe to begin work, do not say `Ready.` — give the shortest possible explanation of the blocker instead.
5. This `Ready.` behavior applies only to the explicit "Read PROJECT_HANDOFF.md" command. It does not mean saying "Ready." every time this file is edited during normal work.
6. Inspect actual repository state before relying on documentation — this file can go stale.
7. **Updating this file is part of the definition of done for every meaningful project change.** Matt should never have to ask. Before finishing a task, check whether it changed: application behavior, architecture, database/schema, authentication, authorization, deployment, environment variable requirements, hosting, domain configuration, external integrations, scanner functionality, market-data behavior, Schwab integration, security, PWA behavior, chat, notifications, production status, known issues, technical debt, test status, important project decisions, project phase, immediate next step, or the Git/deployment workflow. If yes, update this file before finishing. Minor typo-only/cosmetic changes don't require it.
8. Do not turn this file into an append-only diary. Remove stale information and replace it with current truth. Keep only the history that actually matters to a future developer/AI; Git has the rest.
9. Never put secrets, passwords, API keys, OAuth secrets, access/refresh tokens, session secrets, VAPID private keys, database connection strings, or other credentials in this file. Document environment variable **names** and purposes only.
10. Do not silently reverse the architectural decisions recorded below. If a requested change conflicts with one, explain the conflict before making a major reversal.
11. Never run destructive production database operations (`prisma migrate reset`, `db:reset`, the destructive `prisma/seed.ts`, anything using `deleteMany` as a reset) unless Matt explicitly understands and authorizes exactly what data would be lost.
12. **Database schema changes require special care.** Hostinger cannot reliably run `prisma migrate deploy` in production (see Production/Deployment). Never assume pushing a migration to `main` applies it. Do not push application code that depends on a new migration until that migration has been applied to Supabase and verified out-of-band, per the workflow in Production/Deployment.
13. Keep brokerage integration read-only. Never implement automated order submission merely because an API supports it, unless Matt explicitly authorizes changing that requirement.
14. **Do not blindly implement Matt's requested technical approach if a clearly better, safer, more secure, more maintainable, or more conventional solution exists.** Evaluate significant requests for security, data safety, maintainability, production reliability, deployment compatibility, privacy, and standard best practices. If there's a better approach, explain it and recommend it before implementing the weaker one. Default to the safer/better implementation unless Matt explicitly says he understands the tradeoffs and wants the original approach anyway.
15. Proactively protect against: committed secrets, insecure authentication, weak authorization, IDOR/cross-user access, destructive database operations, accidental production data loss, unsafe API credential handling, client-side exposure of private keys/tokens, insecure OAuth redirects/callbacks, weak session handling, missing input validation, unsafe file uploads, insecure dependency use, fragile deployment shortcuts, dev/production environment confusion, hard-coded production URLs/secrets, unnecessary public exposure of services, overcomplicated infrastructure, misleading financial data, and accidental trading/order execution.
16. Security-sensitive changes (authentication, authorization, database access, financial data, OAuth, brokerage APIs, deployment secrets, production infrastructure) require an explicit focused security review of the affected code before the task is done.
17. If a secret is ever found committed to Git, do not just delete it. Report the exposure (file, type, whether it's in history) and recommend proper credential rotation.
18. Never assume hiding a UI element provides authorization — authorization must be enforced server-side.
19. Never claim mock, cached, stale, demo, or manual financial information is live/current market data.

---

## Project Identity

- **Product name:** Off Shift Options
- **Users:** Private two-user application — Matt and Eric. No public signup exists or is planned.
- **Purpose:** A mobile-friendly app for two firefighter friends to run a disciplined, low-stress cash-secured-put options workflow: track trades/positions, scan candidates against personal criteria, share recommendations, chat, and build toward additional family income and long-term financial flexibility (including reduced dependence on firefighting work if health/life circumstances make that desirable).
- **This is NOT:** a brokerage, a public trading platform, a financial advisory service, or an automated trading bot.
- **`PRODUCT_VISION.md`** (repo root) is the long-term north-star document — product areas, principles, and future direction. It is distinct from this file: `PRODUCT_VISION.md` rarely changes and is not a changelog; `PROJECT_HANDOFF.md` is the operational current-state snapshot that changes with every meaningful task.

## Core Product Principles

- Mobile-first, installable PWA; desktop should still work well (especially scanner/table views).
- Simple, low-stress workflow; financial information should be understandable, not unnecessarily technical.
- `PRIVATE` data stays private to its owner; `SHARED` data is visible to both Matt and Eric per the authorization rules in `src/lib/privacy.ts`.
- Never fabricate live financial information. Demo/manual/mock data must always be visibly labeled as such.
- Future brokerage/market integration begins **read-only**. No order submission, no buy/sell, no account-changing brokerage actions, unless Matt explicitly changes this architecture later.
- Strong security and safe defaults are preferred over convenience shortcuts.
- When a better technical solution exists, recommend it rather than blindly following an inferior implementation request.

---

## Current Production Architecture

Verified from repository state (`package.json`, `Dockerfile`, `next.config.ts`):

| Layer | Current version/tool |
|---|---|
| Framework | Next.js 16.3.3, App Router, Turbopack |
| Language | TypeScript (strict), React 19.2.8 |
| ORM | Prisma 7.10.0 with `@prisma/adapter-pg` (`pg` 8.x driver) |
| Database | PostgreSQL — Supabase in production, `postgres:17-alpine` via Docker Compose locally |
| Styling | Tailwind CSS 4 |
| Package manager | pnpm 11.24.0 (via Corepack) |
| Testing | Vitest 4.1.11 (unit + opt-in DB integration), Playwright 1.62.1 (e2e) |
| Hosting | Hostinger managed Node.js hosting |
| Local containers | Docker Compose (`compose.yaml`) — `db` (Postgres) + `app` (Node 24 Alpine, see `Dockerfile`) |
| GitHub | https://github.com/matthewtmonk-dot/offshiftoptions.git, branch `main` |
| Production domain | https://offshiftoptions.com — connected and live (externally confirmed; see Hosting/Domain section) |

**Hostinger's actual configured Node.js version is externally managed** (Hostinger control panel) and not verifiable from this repository — there is no `.nvmrc`/`engines` field pinning it. The Docker image and local dev use Node 24.

---

## Production / Deployment

> **⚠ DATABASE SCHEMA CHANGES REQUIRE SPECIAL CARE.** Hostinger auto-deploys every push to `main`, but its managed Node environment cannot reliably execute Prisma's schema engine, so it does **not** apply migrations during deployment (see Migration strategy below). **Never push code to `main` that depends on a new migration until that migration has been applied to Supabase and verified**, per the workflow below. Never run `prisma migrate reset`, the destructive `prisma/seed.ts`, or any other destructive reset against production.

**Deployment model:**

```
GitHub main → Hostinger auto-deploy → Next.js app → Supabase PostgreSQL
```

- **Current permanent build command** (`package.json` → `"build"`): `prisma generate && next build` — confirmed as of the latest commit. It does **not** run `prisma migrate deploy`, does **not** seed, and does **not** bootstrap users. Every push to `main` triggers a Hostinger deploy.
- **Health endpoint:** `GET /api/health` → `{ app, database, latencyMs, checkedAt }` (200) or `{ app: "ok", database: "error", checkedAt }` (503). Never returns the raw database error message or connection details to the caller (logged server-side only).
- **Migration strategy (current, permanent):** Migrations are **not** run automatically by the Hostinger build. Root cause: `prisma migrate deploy` fails inside Hostinger's build environment with `schema-engine-debian-openssl-1.1.x EACCES` when it tries to *execute* the schema-engine binary as a subprocess (note: `prisma generate` succeeds — it doesn't need to execute that binary, only reference it). This points to Hostinger's managed environment restricting execution of arbitrary spawned binaries, not a missing `chmod +x` — a chmod fix was deliberately not attempted. Hostinger's build shell also does not support nested `pnpm run ...` calls from inside a package script.

  **Required workflow for any future schema migration:**
  1. Create/update the migration locally as usual (`pnpm db:migrate` against local Docker Postgres).
  2. Before pushing the schema-changing commit to `main` (a push deploys to Hostinger), apply it to Supabase from a machine that can actually execute the schema engine — a local dev machine or a CI runner both work:
     ```bash
     DATABASE_URL="<supabase-connection-string>" pnpm prisma migrate deploy
     ```
     Never hardcode or commit the Supabase `DATABASE_URL`.
  3. Verify it applied (check `_prisma_migrations` in Supabase, or `/api/health` after the next deploy).
  4. Only then push the code that depends on the new schema.

  Automating step 2 in CI is a reasonable future improvement (see Next Tasks), not yet built.

- **Known historical workaround (resolved, no longer present):** During the very first production deployment, the build script was temporarily changed several times (adding `prisma migrate deploy`, then a bootstrap step, then bypassing the migration engine, then calling `tsx prisma/bootstrap-production.ts` directly) to get Matt/Eric created against the brand-new Supabase database. All of that was reverted once the one-time bootstrap succeeded. **The current `build` script has none of this — verified directly against `package.json`.**

---

## Database / Seed / Bootstrap Safety

**This distinction is critical and must never be blurred:**

- **`prisma/seed.ts`** (`pnpm db:seed`) — **DESTRUCTIVE, development/demo only.** Its `resetDatabase()` unconditionally `deleteMany()`s nearly every table (users, sessions, trades, watchlists, chat, notifications, scanner profiles, etc.) before recreating demo data for Matt and Eric. **Must never run against Supabase/production.** There is no safeguard in the script itself preventing this other than discipline — never wire it into any production script or CI path.
- **`prisma/bootstrap-production.ts`** (`pnpm bootstrap:production`, logic in `src/lib/bootstrap.ts`) — **safe, non-destructive, idempotent.** Creates Matt (`matt@lst.local`) and Eric (`eric@lst.local`) only if a user with that email doesn't already exist, using `DEV_SEED_PASSWORD` for the initial password (only set at creation time — never overwrites an existing password), and creates their shared private conversation only if one doesn't already exist. It never deletes, resets, or overwrites existing users or any other data. Proven by DB-integration tests (`src/lib/bootstrap.integration.test.ts`): first run creates both users + conversation; a second run creates nothing new, doesn't touch the password, and doesn't delete unrelated data added in between.
- **Current status:** The initial production bootstrap has already run successfully against Supabase — Matt and Eric accounts exist in production and login has been verified. **`bootstrap:production` is not part of the routine build** and should not run on every deployment; it now exists mainly as a disaster-recovery/reference tool (e.g., manually re-run only if a brand-new empty production database is ever provisioned again).

**Never run against production:** `prisma migrate reset`, `db:reset`, `pnpm db:seed`, or any ad hoc `deleteMany`-based reset logic — unless Matt explicitly understands and authorizes exactly what data would be lost. If any AI is ever asked to run a destructive database command, it must first explain exactly what data would be lost and get explicit confirmation.

**Migration status:** `prisma/migrations/20260828215700_campaign_tracker_foundation/` (adds the Campaign Tracker schema — see Campaign Tracker section) is applied to both local Docker Postgres and **production Supabase** (Matt ran `prisma migrate deploy` against production on 2026-08-29 and confirmed with `prisma migrate status` — "3 migrations found, database schema is up to date").

**`prisma/migrations/20260831211006_account_ledger_and_broker_link/` is applied to both local Docker Postgres and production Supabase** (Matt ran `prisma migrate deploy` + `prisma migrate status` against production on 2026-08-31, confirmed up to date, before the dependent code was pushed). It is purely additive (two new enums `AccountLedgerEntryType`/`AccountSource`, a new `AccountLedgerEntry` table, three new nullable columns on `TradingAccount` — `source`, `brokerConnectionId`, `externalAccountId` — one default-value change on `TradingAccount.visibility` from `SHARED` to `PRIVATE` for new rows only, a new unique index, and two new FKs).

---

## Environment Variables / Secrets

Names and purposes only — **never values**.

**PRODUCTION REQUIRED**
- `DATABASE_URL` — Supabase Postgres connection string.
- `LST_SESSION_SECRET` — HMAC key used to hash session tokens before storing/looking them up (name predates the "Off Shift Options" rebrand; not yet renamed — see Known Issues).
- `NEXT_PUBLIC_APP_URL` — used for `metadataBase` (canonical/Open Graph URL resolution). Already set in Hostinger to `https://offshiftoptions.com`, with a redeployment completed afterward (externally confirmed; not independently verifiable from this repo).

**DEVELOPMENT ONLY**
- `DEV_SEED_PASSWORD` — initial password used by `prisma/seed.ts` and (only for user creation) `prisma/bootstrap-production.ts`. Was required once in Hostinger's env for the one-time production bootstrap; not needed for routine deploys now that Matt/Eric already exist.
- `RUN_DB_TESTS` — set to `1` to opt into the Vitest DB-integration suites (skipped otherwise).
- `PLAYWRIGHT_BASE_URL` — overrides the Playwright base URL (defaults to `http://127.0.0.1:3000`).
- `NODE_ENV` — managed by Next.js itself (`next dev` forces development, `next build`/`next start` force production); not something to set manually.

**SCHWAB INTEGRATION** (read-only foundation implemented; Hostinger env vars configured per Matt on 2026-08-31; OAuth connection pending)
- `SCHWAB_CLIENT_ID` — server-side Schwab app client ID.
- `SCHWAB_CLIENT_SECRET` — server-side Schwab app client secret.
- `SCHWAB_REDIRECT_URI` — must match the registered production callback exactly: `https://offshiftoptions.com/api/schwab/callback`.
- `SCHWAB_TOKEN_ENCRYPTION_KEY` — server-side 32-byte AES-GCM key for encrypted Schwab access/refresh tokens. Recommended format is `base64:<32 random bytes in base64>`; generate locally with `node -e "console.log('base64:'+require('node:crypto').randomBytes(32).toString('base64'))"`.
- These are consumed only by server-side Schwab code (`src/providers/schwab/*`, `/api/schwab/connect`, `/api/schwab/callback`, and related workflows). Do not use `NEXT_PUBLIC_` for Schwab credentials, and never commit or paste values into project documentation.

**FUTURE WEB PUSH** (not yet used anywhere in code)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — required once real Web Push delivery is implemented (see Known Issues / PWA section). Private key must stay server-only.

**Secrets scan result:** Tracked files were checked for common secret patterns (API keys, private key blocks, tokens, credential-bearing connection strings). No real secrets found. `compose.yaml` and `.env.example` contain only hardcoded **local Docker dev** placeholder credentials (`lst_buddy` / `lst_buddy_dev`, pointing at `db:5432`/`localhost:5432`), which is the intended, safe convention for local development — not a production credential. No `.env` file is tracked (only `.env.example`).

---

## Authentication

- Email/password authentication with database-backed sessions (`src/lib/auth.ts`).
- Passwords hashed with `bcryptjs` (cost 10) — consistently in `prisma/seed.ts`, `prisma/bootstrap-production.ts`, and `src/lib/account.ts`.
- Session cookie: HTTP-only, `SameSite=Lax`, `Secure` when `NODE_ENV === "production"` (true for the deployed Hostinger app). Session tokens are opaque random values in the cookie, HMAC-hashed (`LST_SESSION_SECRET`) before being stored/looked up — the raw token is never persisted.
- A new session token is always minted on sign-in (never reused from an existing cookie) — no session-fixation vector.
- **Password changing exists**: `/account` (`src/lib/account.ts`) lets a signed-in user change their own password — requires the correct current password, enforces minimum length (10) plus letter+number complexity, and deletes every *other* session for that user on success (keeps the current one), so a changed password immediately signs out other devices.
- **No public signup.** Only Matt and Eric exist; this remains a private two-user app.
- All authorization is enforced server-side in `src/lib/privacy.ts` (`assertCanReadRecord`, `assertCanMutateRecord`) and applied through `src/lib/workflows.ts` — the only place server actions mutate data. UI hiding is never relied on for security.
- Dev-only quick-login buttons on `/login` render only when `NODE_ENV !== "production"` — confirmed absent from a real `next build && next start` production run.

---

## Current Features

| Feature | Status | Notes |
|---|---|---|
| Dashboard | WORKING (one-screen cockpit) | `/dashboard` — a compact status line (per-user greeting, scan provenance badge, open count, win rate), a 5-stat account strip (account value, cash, secured CSP capital, open positions, realized trading P/L), a weekly-return/1% target strip (honest `INSUFFICIENT HISTORY` state when there isn't enough closed-campaign history), and three compact panels (Open Positions, Top Setups sorted by honest setup score, deduped Buddy Activity). Rewritten from an earlier tile-based layout that had several contentless/"No data" cards; see Current State for details. |
| Scanner (results) | DEMO + CONTROLLED LIVE SCHWAB PATH | `src/domain/scanner` — real PASS/FAIL/UNKNOWN evaluation engine with setup scores, near-match detection, exclusion diagnostics, sortable/quick-filtered results, and expandable stock/option inspectors. Demo remains deterministic and visibly labeled. A new read-only `LIVE:SCHWAB` action can run a small staged live scan once Schwab env vars and OAuth are configured; it never silently falls back to demo data. Score/label are now gating-aware — see Scanner section. |
| My LST scanner settings ("Scanner Rules") | WORKING (per-user) | `/scanner/settings` (nav label "Scanner Rules") — each user edits their own `ScannerProfile`/`ScannerRule` rows against an explicit **LST Core** baseline, with a "Reset all to LST Core" action and a per-rule "Differs from LST Core" diff badge; proven isolated per-user by DB integration tests. |
| Account Ledger | WORKING | `/account` and Tracker's Accounts/Performance tabs — see Account Ledger section. Distinguishes external cash flows (deposits/withdrawals/adjustments) from trading P/L; never derives performance from `currentBalance − startingBalance`. |
| Watchlist | WORKING | Private/shared items, Pro/Con/General notes (owner-only edit), buddy comments (shared, read-access-gated). |
| Recommendations | WORKING | Send/receive between Matt and Eric, reason tags, status lifecycle (`NEW`/`WATCHING`/`PASSED`/`ARCHIVED`), participant-gated comments. |
| Buddy chat | WORKING (polling-live) | Membership-gated conversation; new messages/read-receipts appear without a manual reload via a 4s `router.refresh()` poll while the tab is visible (`src/components/live-refresh.tsx`) — not WebSockets/Realtime. |
| Notifications | WORKING (in-app only) | In-app notification model/UI/provider works. External Web Push is a documented no-op (see PWA section). |
| Tracker (accounts + campaigns) | WORKING (manual/demo + Schwab positions where connected) | `/positions` (nav label "Tracker") — four compact tabs (Open / History / Performance / Accounts) inside the existing page, not new nav entries. Full CSP/wheel campaign lifecycles (open → roll → assign → covered call → close) with SHARED/PRIVATE/INHERIT visibility and Mine/Eric/Both filtering. See Campaign Tracker section. |
| Legacy Trade/TradeLeg positions | DEMO/MANUAL | The original per-trade position model still renders (as "Legacy open CSP snapshots") below the campaign list on `/positions` for continuity; new work should use campaigns, not this model. |
| Cash-secured put calculations | WORKING | `src/domain/finance/calculations.ts` — real, tested per-share vs. per-contract math (premium capture, ROR, annualized ROR, break-even, position health status). Deterministic, not dependent on live data. |
| PWA / installation | WORKING | Manifest, service worker, install prompt, real 192/512 PNG icons (any + maskable) and Apple touch icon. |
| Health endpoint | WORKING | See Deployment section. |
| Authentication | WORKING | See Authentication section. |
| Change password | WORKING | `/account`. |
| Sharing/privacy controls | WORKING | `PRIVATE`/`SHARED` visibility enforced server-side; proven by unit + DB-integration tests. |
| Schwab market/account data | FOUNDATION + ACCOUNT SYNC IMPLEMENTED, DEPLOY/OAUTH PENDING | Schwab Trader API app is approved/configured for Market Data Production and Accounts and Trading Production, with Order Limit 0 and callback `https://offshiftoptions.com/api/schwab/callback`. OAuth routes, signed state, encrypted token storage/refresh, read-only market-data provider, read-only broker-read provider, an account-sync workflow (`syncSchwabAccountForUser`) that writes a `BROKER_SNAPSHOT` ledger entry per linked account, an honest "Sync now" / "Reconnect" / "Disconnect" UI on `/account`, and a read-only open-positions panel on the Tracker's Open tab are implemented. Hostinger Schwab env vars are configured per Matt as of 2026-08-31. No trading, no automatic campaign-to-position reconciliation, and live production use still requires deploy plus a completed Schwab OAuth connection. |

---

## Scanner

- Engine: `src/domain/scanner/scanner.ts` — criterion-level evaluation. Each criterion produces `PASS` / `FAIL` / `UNKNOWN` with an actual value, operator, desired value/range, and explanation. Overall result: `FAIL` if any criterion fails, else `UNKNOWN` if any is unknown, else `PASS`. The engine also calculates a criteria/setup score (not profit probability), labels score quality, identifies near misses, surfaces a primary concern, and summarizes first-rule exclusions for the "why is the list thin?" diagnostic.
- **LST Core baseline** (`SCANNER_RULE_DEFINITIONS` in `src/domain/scanner/profile.ts`): the canonical default rule set for a fresh user — price $10–$50, RSI ≤ 40, BB % ≤ 33%, Put ROR ≥ 1.00%, earnings distance ≥ 10 days, stock volume ≥ 40,000, open interest ≥ 100, option bid ≥ $0.10 (all `defaultEnabled: true`); DTE, absolute delta, annualized ROR, bid/ask spread %, option volume, Do Not Trade filter, and debt/equity exist as available rules but are `defaultEnabled: false` by default (preference/context rules, not part of the confirmed LST Core numbers). `/scanner/settings` (nav label "Scanner Rules") shows a "Reset all to LST Core" action (`resetScannerSettingsToLstCoreForUser`) and a per-rule "Differs from LST Core" diff badge (`diffScannerRulesFromLstCore`) — it never silently overwrites a user's own edits. **Both `ensureMyLstScannerProfileForUser` (on-demand profile creation) and `prisma/seed.ts` must create each `ScannerRule.enabled` from `definition.defaultEnabled`** — a real bug was found and fixed this session where the seed script left the schema's own column default (`true`) in place for every rule, so a freshly-seeded demo user started with every preference rule turned on instead of matching LST Core. Verified by screenshot after the fix: a fresh Eric profile now shows "This profile matches LST Core."
- **Gating vs. preference / honest score semantics** (`GATING_RULE_KEYS` in `profile.ts`; `honestSetupScore`/`honestSetupLabel`/`hasGatingFailure` in `scanner.ts`): price, stock volume, open interest, option bid, bid/ask spread %, delta, earnings distance, and the Do Not Trade filter are **gating** — a FAIL on any of them means the setup is untradeable, not merely a quality miss. A gating FAIL caps the displayed score at `GATING_SCORE_CAP` (49) and forces the label to `"Fails"` regardless of how good the other criteria look — the UI never shows positive language ("Excellent"/"Strong"/"Ready") for a setup that fails a gating rule. An overall `UNKNOWN` result (a critical criterion, most commonly earnings, could not be evaluated) is labeled `"Verify"`, not a positive score label, even if the *known* criteria all pass — e.g. "92/100 known · Verify · Earnings unavailable" is the intended shape, never "Excellent." `/scanner` and `/dashboard` both use `honestSetupScore`/`honestSetupLabel` (never the raw `setupScore`/`setupScoreLabel`) for anything shown to the user, and the dashboard's Top Setups panel sorts by this honest score, never alphabetically.
- **Known limitation — earnings data**: Schwab's Trader API does not expose a reliable earnings-calendar/next-earnings-date endpoint in the read-only surface this app uses, so the `earningsDistance` criterion stays `UNKNOWN` for a live Schwab scan (demo data hand-supplies `earningsDate`/`earningsDistance` for its fixed candidate list only). This is deliberately left honest (`UNKNOWN`, never guessed) rather than bolting on a third-party financial-data API in this slice. A clean provider boundary for a future earnings source is the `earningsDistance` criterion key itself plus the `ScannerRuleDefinition`/`CriterionResult` shape already in place — a future slice can add a real provider without changing the engine.
- Rule catalog: `src/domain/scanner/profile.ts` (`SCANNER_RULE_DEFINITIONS`) — stock price range, RSI, Bollinger %, DTE, absolute delta, put ROR, annualized ROR, option bid, bid/ask spread %, open interest, option volume, earnings distance, Do Not Trade filter (fixed desired value, not user-editable), debt/equity.
- Per-user settings: `/scanner/settings` edits a user's own `ScannerProfile`/`ScannerRule` rows (enable/disable + desired value(s) per rule); `@@unique([profileId, key])` prevents duplicate rule keys per profile. Verified isolated per user (Matt editing his settings never changes Eric's) by `src/lib/workflows.integration.test.ts`.
- Scanner page UI: `/scanner` now has Score and Filter modes, quick filters (Strongest, Best premium, Most liquid, Lowest RSI, Far from earnings, Near matches, Watchlist only), query-string sorting, desktop table layout, mobile cards, native expandable inspectors, visual status tiles, a `Refresh demo scan` server action, and a `Run live Schwab scan` server action. Scan provenance is visibly labeled as `DEMO` or `LIVE • SCHWAB`.
- **Demo data remains available and labeled**: `DEMO_SCAN_CANDIDATES` in `profile.ts` is a fixed 13-candidate universe (including IONQ, HOOD, PLTR, RIVN, AAP, SNAP, F, CORZ, SOFI, AMD, ROKU, T, WBD) with hand-entered stock/option/technical/earnings/liquidity values, not a live feed.
- **Controlled live Schwab scan**: `src/domain/scanner/live-scan.ts` uses the same 13-symbol starter universe for the first production-safe slice. It fetches quotes and daily history first, calculates OSO-owned RSI/Bollinger/volume/price filters, shortlists only candidates that pass the inexpensive stock stage, then calls option chains for at most 8 symbols by default. Successful live runs persist with `ScanRun.source = "LIVE:SCHWAB"`. Failures surface `LIVE DATA UNAVAILABLE` to the user and do not create or substitute demo results.
- Demo provider names: `src/providers/market-data/mock.ts` exports `DemoMarketDataProvider` plus backward-compatible `MockMarketDataProvider`; the demo market provider reads from the same deterministic scanner demo universe for quotes and option-chain snapshots. `src/providers/broker-read/mock.ts` exports `DemoBrokerReadProvider` plus backward-compatible `MockBrokerReadProvider`. These providers remain read-only test/development boundaries.

---

## Campaign Tracker

`/positions` (nav label "Tracker") is a manual account + campaign lifecycle tracker — the direct implementation of the "Tracker" product area in `PRODUCT_VISION.md`. It models a whole trading idea (a "campaign") from the first cash-secured put through rolls, assignment, covered calls, and eventual close as one continuous, inspectable history — not isolated trade rows.

**Schema** (`prisma/schema.prisma`, migration `prisma/migrations/20260828215700_campaign_tracker_foundation/`, **applied to production Supabase as of 2026-08-29** — see Database / Seed / Bootstrap Safety):
- `RecordVisibility` enum: `INHERIT | PRIVATE | SHARED` — used by `Campaign.visibility`.
- `Campaign` model: owner, account, ticker, `CampaignStrategy` (`CASH_SECURED_PUT | WHEEL`), `CampaignStatus` (`OPEN | ASSIGNED | CLOSED`), visibility, opened/closed dates, thesis text, and an `entrySnapshotJson` (the owner's own scanner result at entry time, for context — not a live query).
- `CampaignEvent` model: append-only lifecycle events (`SELL_PUT`, `CLOSE_PUT`, `ROLL_PUT_CLOSE`, `ROLL_PUT_OPEN`, `ASSIGNMENT`, `SELL_COVERED_CALL`, `CLOSE_COVERED_CALL`, `COVERED_CALL_EXPIRED`, `STOCK_SALE`, `NOTE`), each with its own contracts/shares/strike/premium/fees/underlying price. A roll writes a `ROLL_PUT_CLOSE` + `ROLL_PUT_OPEN` pair sharing a `groupKey`; **no workflow ever updates or deletes an existing event** — the full history is always reconstructible.
- `TradingAccount` gained `startingBalance`/`manualBalance` (manual, not synced). Its default `visibility` was briefly `SHARED` during the Campaign Tracker slice; the 2026-08-31 Account Ledger slice changed the default back to `PRIVATE` per explicit product decision (financial account data should not default to shared the way collaborative watchlist/research data does) — see Account Ledger section and Architectural Decisions.

**Visibility model:** a `Campaign.visibility` of `INHERIT` resolves to its parent account's `Visibility` (`resolveInheritedVisibility` in `src/lib/privacy.ts`); `SHARED`/`PRIVATE` on the campaign itself always override the account. Server-side query logic (`getTrackerPageData` in `src/lib/app-data.ts`) filters buddy-visible campaigns with `visibility = SHARED OR (visibility = INHERIT AND account.visibility = SHARED)` — a buddy never receives a row for a private campaign or an inherited campaign under a private account, regardless of the `mine`/`buddy`/`both` scope requested. Proven by `src/lib/workflows.integration.test.ts` (inherited/explicit-shared/explicit-private transitions, including an account later flipped to SHARED while its campaign is explicitly PRIVATE, which must still block) and by a Playwright test that logs in as both users. All campaign mutations (`closeCampaignPutForUser`, `rollCampaignPutForUser`, `assignCampaignPutForUser`, `toggleCampaignVisibilityForUser`, etc., in `src/lib/workflows.ts`) re-read ownership from the database by ID before acting — a tampered form ID cannot mutate another user's campaign.
- One narrow leak was found and fixed during this session: a buddy viewing an explicitly-SHARED campaign whose parent account is PRIVATE previously saw that private account's name on the campaign card. `CampaignCard` in `src/app/(app)/positions/page.tsx` now shows "Private account" instead unless the viewer can actually read the account (owner or account itself SHARED).

**Financial calculations** (`src/domain/finance/campaigns.ts`, `summarizeCampaign()`): sums option credits/debits (including roll legs, at the 100-share multiplier) into `totalPremiumReceived`/`optionDebitsPaid`/`netOptionPremium`, tracks `rollCredits`/`rollDebits`/`netRollPremium` for roll-specific display, and computes `realizedPL` as `premium credits − premium debits − realized stock cost basis + stock sale proceeds − fees`, unconditionally (not branched on share-holding state). A proportional (average-cost) allocation splits assigned-share cost basis between shares already sold and shares still held, so a **partial** stock sale's realized gain/loss is captured immediately rather than silently dropped until the whole position closes — this was a real gap found and fixed this session, with two new regression tests (`campaigns.test.ts`) proving it. `unrealizedPL`/`totalCampaignPL` require a supplied current stock price for any still-held shares and stay `null` (never fabricated) without one. `finalResult` is `GAIN`/`LOSS`/`BREAKEVEN`/`OPEN`/`UNKNOWN` — never dressed up. Verified against the task's own worked roll example (sell +$48, roll −$71/+$102 ⇒ net roll +$31, total option cash flow +$79) both in unit tests and live in the demo UI.

**UI** (`src/app/(app)/positions/page.tsx`): a stat strip (campaign count, known realized P/L, net option premium, visible accounts), a Mine/`<buddy name>`/Both segmented control (`?scope=`), and four compact tabs inside the same page (`?view=open|history|performance|accounts`, default `open`) — deliberately not four new top-level nav entries:
  - **Open** — collapsible "New Campaign"/"New Account" panels (the account panel opens by default and the campaign panel is hidden entirely when the user has no account yet, so the form for an unusable action is never expanded ahead of the actual first step), a read-only "Your Schwab Positions" panel (`SchwabPositionsPanel`, only rendered when Schwab is connected) showing each Schwab position tagged `Possible match` (same underlying ticker as an open campaign) or `Unlinked` — never an automatic hard link, and one `<details>` card per non-`CLOSED` campaign with lifecycle timeline, result breakdown, and (owner-only) action forms (Close Put, Roll, Mark Assigned).
  - **History** — the same campaign card, filtered to `CLOSED` only, outcome-led.
  - **Performance** — always computed from the current user's own completed campaigns and own accounts only (`ownCompletedCampaigns`/`ownAccounts` from `getTrackerPageData`, never the scope-filtered `campaigns`/`visibleAccounts` lists), so switching the Mine/Buddy/Both selector can never blend Matt's and Eric's results. Shows starting value, net contributions, current value, win/loss counts, win rate, average win/loss, average duration, weekly return vs. the 1% target, and trailing 4-week average — see Account Ledger / Performance Methodology section.
  - **Accounts** — the scope-filtered `visibleAccounts`, each showing ledger-derived starting/contributions/current value (not the old ad hoc `manualBalance` field) plus a link to `/account` for logging a deposit/withdrawal/adjustment.

Verified overflow-free on a 390px mobile viewport via Playwright and manual screenshots (`test-results/visual-qa/`).

**Demo data** (`prisma/seed.ts`, local dev only): 3 accounts (Matt IRA — SHARED, Eric IRA — SHARED, Matt's Playground/Paper — PRIVATE) and 8 campaigns covering: a simple profitable closed CSP (BROS), an open CSP (IONQ), a single roll (AAP), multiple rolls closing positive (SOFI), an assigned CSP that continues through covered calls including one expiring worthless (F, `WHEEL` strategy), a losing closed CSP (ROKU), an explicitly-PRIVATE campaign under a private account (WBD, Matt), and a SHARED campaign owned by Eric (HOOD) so both users have visible history.

**Known limitation (intentional, not a bug):** there is no UI action yet to sell/close a covered call or record a stock sale — an `ASSIGNED` campaign shows an honest in-app note ("Covered call and stock-sale events are modeled now; manual buttons for that phase are a clean next slice.") rather than a broken control. The finance engine and schema already fully support these event types (exercised by seed data and tests); only the create-event UI/workflow/action for that phase is missing. This is the recommended next slice — see Next Tasks.

---

## Account Ledger / Performance Methodology

**Schema** (migration `20260831211006_account_ledger_and_broker_link` — see Database / Seed / Bootstrap Safety for production status): `AccountLedgerEntry` (`src/domain/finance/accountLedger.ts` for the domain logic) records `STARTING_VALUE | DEPOSIT | WITHDRAWAL | MANUAL_ADJUSTMENT | BROKER_SNAPSHOT | NOTE` entries per `TradingAccount`, each with an amount/accountValue/cash and `occurredAt`. `TradingAccount` gained `source` (`MANUAL | SCHWAB`), `brokerConnectionId`, and `externalAccountId` (unique per `(userId, externalAccountId)` so a Schwab sync upserts the same account instead of duplicating it).

**Why a ledger instead of `startingBalance`/`currentBalance`:** the ledger is the only source of truth for trading performance — `currentBalance − startingBalance` would silently count a deposit as profit. Worked example (`accountLedger.test.ts`, `accountLedger.integration.test.ts`): starting $10,000 + a $2,000 deposit + $300 of trading P/L = current $12,300, and the trading profit is reported as **+$300**, not +$2,300. `summarizeAccountLedger()` computes `startingValue`/`netContributions`/`ledgerDerivedValue` from `STARTING_VALUE`/`DEPOSIT`/`WITHDRAWAL`/`MANUAL_ADJUSTMENT` entries only (a `BROKER_SNAPSHOT` never counts as a contribution — it's a fact Schwab reported, not a cash flow the user made); `currentAccountValue()` then adds known realized trading P/L on top, or uses the latest `BROKER_SNAPSHOT` as authoritative when one exists (a live Schwab-synced account already reflects P/L/contributions/everything, so it overrides the ledger-derived math rather than double-counting alongside it).
- `createTradingAccountForUser` now defaults new accounts to `PRIVATE` (previously `SHARED`) and automatically writes a `STARTING_VALUE` ledger entry from the provided starting balance.
- `addAccountLedgerEntryForUser` (Account page mini-form) lets an owner log a `DEPOSIT`/`WITHDRAWAL`/`MANUAL_ADJUSTMENT`; re-checks account ownership server-side (a cross-user attempt throws `ValidationError`, proven by `accountLedger.integration.test.ts`).
- `prisma/seed.ts` was updated to give each of the three demo accounts a matching `STARTING_VALUE` ledger entry, so the Account/Performance/Accounts views don't show "No data" for the seeded demo accounts.

**Win/loss accounting** (`src/domain/finance/performance.ts`, `summarizeWinLoss`): only campaigns with `status: "CLOSED"` are ever fed into this function — `getTrackerPageData`'s `ownCompletedCampaigns` and `getDashboardData`'s `completedCampaigns` both query `status: "CLOSED"` at the database level, so an OPEN campaign's net cash flow (e.g. +$28 sell, −$53 roll close, +$82 roll open = +$57 while still OPEN) can never be counted as a completed win no matter its sign — it only becomes a `GAIN`/`LOSS`/`BREAKEVEN` once a subsequent close event actually closes it (e.g. a final −$11 close brings the example to +$46, a `GAIN`, counted only at that point). This exact worked example is a regression test in `src/lib/accountLedger.integration.test.ts` against a real database. No event is ever double-counted or deleted — every roll leg stays in the append-only `CampaignEvent` history (see Campaign Tracker section).

**Weekly return vs. the 1% target** (`summarizeWeeklyReturns`): buckets each closed campaign's realized P/L by the ISO week it closed in and divides each week's P/L by a single fixed baseline (the account's current ledger-derived value). This is a **simple realized-return-per-week metric, explicitly not a time-weighted or money-weighted rate of return** — it does not adjust for deposits/withdrawals mid-period, and a fixed baseline understates return in early (smaller-account) weeks and overstates it in later (grown-account) weeks. This is a deliberate choice to avoid fabricating a precision the app cannot back up; a proper time-weighted return is future work once there is enough dated history to make one meaningful. When there are no closed campaigns with a known baseline, both the Dashboard and Tracker Performance tab show `INSUFFICIENT HISTORY` rather than a fabricated projection.

**Privacy invariant:** Performance is deliberately read from an always-"mine"-scoped query, never the Mine/Buddy/Both scope-filtered campaign list — so setting the Tracker scope to "Both" can make a buddy's shared campaigns *visible* in Open/History, but can never blend into *your own* win rate, weekly return, or realized P/L figures. Proven by `src/lib/accountLedger.integration.test.ts`.

---

## Schwab API

- **Current status: Schwab Trader API app approved/configured; read-only OAuth/provider foundation implemented locally on 2026-08-31.** Hostinger Schwab env vars are configured per Matt. Production live use is pending deploy plus a real OAuth connection.
- Enabled products: **Market Data Production** and **Accounts and Trading Production**.
- **Order Limit: 0.** Even though the Schwab app includes the Accounts and Trading product, Off Shift Options remains strictly read-only.
- Registered production callback URL: `https://offshiftoptions.com/api/schwab/callback`.
- Official Schwab docs/API checks were refreshed before implementation. Schwab public docs identify OAuth 2 delegated access with `authorization_code` callback flow and refresh-token renewal; no public official PKCE requirement/support was found, so the implementation uses signed, expiring, per-user OAuth state and does not send PKCE parameters. The official API host/path family was also probed without credentials and returned `401 Unauthorized` at the expected auth, token, market-data, and trader endpoints.
- No Schwab credentials, secrets, OAuth tokens, authorization codes, refresh tokens, account hashes, or client IDs exist in this repository. Only env var names and placeholder examples are documented.
- OAuth routes:
  - `GET /api/schwab/connect` requires an authenticated OSO session, validates server env config, creates a 10-minute signed HttpOnly state cookie scoped to the current user, and redirects to Schwab's authorization endpoint.
  - `GET /api/schwab/callback` requires the same current OSO user, verifies returned state and cookie state, exchanges the code server-side with the Schwab token endpoint, stores encrypted tokens in that user's `BrokerConnection`, discovers account-number hashes server-side, and redirects back to `/account`.
- Token storage/refresh: `src/providers/schwab/crypto.ts` encrypts access/refresh tokens using AES-256-GCM with `SCHWAB_TOKEN_ENCRYPTION_KEY`; `src/providers/schwab/tokens.ts` refreshes near-expiry access tokens and marks a connection `EXPIRED` if refresh fails. Token and account-hash errors are sanitized before reaching UI.
- Market data provider: `src/providers/schwab/market-data.ts` implements the existing `MarketDataProvider` interface for quotes, price history, option chains, instruments, and market hours. `src/providers/schwab/normalizers.ts` maps Schwab payloads into OSO's internal quote/candle/option snapshots, including bid/ask/mark/last/open interest/volume/Greeks where present. OSO still calculates Wilder RSI, Bollinger Bands/position, spread %, distance OTM, RoR, annualized RoR, setup score, PASS/FAIL/UNKNOWN, and near-match diagnostics.
- Controlled scanner integration: `rerunLiveSchwabScannerForUser()` uses `getSchwabMarketDataProvider()` and persists successful runs with `source = "LIVE:SCHWAB"`. If Schwab env vars/tokens/API calls are unavailable, the action returns `LIVE DATA UNAVAILABLE` and does not silently use demo data.
- Broker-read foundation: `src/providers/schwab/broker-read.ts` implements read-only accounts, account detail/positions, transactions, and historical order observation behind `BrokerReadProvider`.
- **Account sync** (`syncSchwabAccountForUser` in `src/lib/workflows.ts`): pulls the authenticated user's own Schwab accounts/balances only, upserts a `TradingAccount` per Schwab account (`source: "SCHWAB"`, keyed on `(userId, externalAccountId)` so re-syncing never duplicates), and writes a `BROKER_SNAPSHOT` ledger entry each sync — never fabricates a value Schwab didn't return, and a fetch failure is recorded (`recordSchwabAccountSyncResult`) and surfaced honestly rather than silently retried or masked. `/account`'s primary, low-risk action is **"Sync now"**; "Reconnect Schwab" and raw token-expiry/callback-URL details are demoted into a collapsed "Connection details" section; "Disconnect" is visually muted/deliberate, not a primary button.
- **Open broker positions**: `getSchwabOpenPositionsForUser` returns the authenticated user's own Schwab positions (symbol, quantity, market value, account label, plus `assetType`/`putCall`/`strikePrice`/`underlyingSymbol` straight from Schwab's own instrument object when present) with no attempt to reconcile them against OSO campaigns beyond a same-underlying-ticker heuristic. The Tracker's Open tab labels each Schwab position `Possible match` or `Unlinked` against the user's own open campaign tickers — deliberately not an automatic hard link, since reconciling broker fills to specific campaigns from ambiguous transaction history is future work, not this slice.
- **OCC option symbol parsing** (`src/domain/finance/occOption.ts`): Schwab renders option positions with a raw OCC symbol (e.g. `RIOT 260904P00017500`); `parseOccOptionSymbol` turns that into `{ underlying, expiration, optionType, strike }` (tested against real padding/case variants and invalid input), and `describeBrokerPositionForDisplay`/`formatOccOptionSymbol` render it as "RIOT · Sep 4, 2026 · $17.50 Put" with "-1 contract" (not "-1 sh") for an option quantity. The original raw symbol is always preserved on the `BrokerPosition` object; only the display layer reformats it.
- **CSP secured capital from broker positions** (`src/domain/finance/brokerPositions.ts`, `summarizeCspSecuredCapital`): counts `strike × 100 × |short contracts|` only for positions confidently identified as a short put — preferring Schwab's own `putCall`/`assetType`/`strikePrice` instrument fields when present, falling back to the OCC symbol parse only when Schwab didn't supply them. Long puts, calls, equity, and any position that can't be confidently classified (`classifyBrokerPosition` returns `"UNKNOWN"`) are excluded and never guessed; `hasUnknown` on the summary tells the Dashboard to show the total as a floor (`$X+`) rather than presenting it as complete. No existing "authoritative collateral" field is captured in the normalized Schwab position data today, so the strike-based calculation is the only source — this is documented, not a placeholder for a field we're ignoring.
- **Dashboard Open Positions / Secured CSP** (2026-08-31 follow-up fix — a live smoke test found the Dashboard stuck at 0/$0.00 for a user with 3 real Schwab short puts because it only ever read OSO campaigns): the Dashboard now fetches `getSchwabOpenPositionsForUser` directly (same pattern as the Tracker) and adds broker positions into both "Open positions" (`computeOpenPositionsCount`) and "Secured (CSP)" (`summarizeCspSecuredCapital`). **This is a simple additive count, not a deduplicated one** — since there is no link between an OSO campaign and a Schwab position yet, the same real-world trade tracked as both would currently count twice. This is the deliberate, safest-available interim behavior (never silently merging or guessing a link) until reconciliation ships; `computeOpenPositionsCount`'s docstring and a dashboard code comment both call this out. A small `LIVE SCHWAB` / `MANUAL` / `MIXED` badge next to the Account Value stat shows whether the displayed account metrics are live-synced, manually entered, or a mix — a live broker value is never allowed to look like manually-entered data.
- Existing Prisma model reused: Schwab OAuth data uses the existing `BrokerConnection` table (`provider`, `status`, encrypted token ciphertext fields, expiry/scopes/metadata). No schema migration was required for this slice.
- Market data may currently use the latest connected Schwab connection as a server-only market-data token source. That path only calls market-data endpoints and never exposes the owner, tokens, account hashes, balances, positions, transactions, or account history to another user.
- **Architectural rule (do not violate):** read-only. Allowed methods are read-oriented only (`getQuote`, `getPriceHistory`, `getOptionChain`, `getInstrument`, `getMarketHours`, `getAccounts`, `getPositions`, `getTransactions`, `getOrders` for historical observation only). Forbidden: `placeOrder`, `submitOrder`, `replaceOrder`, `cancelOrder`, preview-for-execution endpoints, algorithmic execution, automated trading — do not add these unless Matt explicitly changes this requirement.
- **Brokerage account data is user-scoped:** Matt's Schwab OAuth connection, balances, positions, transactions, imported records, campaigns, account settings, performance, projections, and trading-result achievements belong to Matt. They must never populate Eric's account, affect Eric's settings, appear as Eric's positions, change Eric's account value/history, or automatically become shared. Eric can continue using manual accounts/trades/imports without connecting Schwab; if he later wants automatic Schwab account sync, he authorizes his own Schwab account through the same OSO Schwab developer app.
- **Sharing is separate from ownership:** Matt can share a campaign/account summary with Eric, but the owner remains Matt and the underlying brokerage connection/tokens remain Matt-owned. Shared visibility never makes a campaign count toward Eric's balance, P/L, win rate, projections, or trading-result achievements.
- Any Schwab client secret, authorization code, access token, refresh token, account hash, or broker-specific identifier must stay server-side, never in client-side JavaScript, logs, error pages, analytics, screenshots, project docs, or Git. Store Schwab access/refresh tokens encrypted at rest with a dedicated server-side key.

---

## Hosting / Domain

- **Production domain:** https://offshiftoptions.com — connected to the Hostinger Node application and live (externally confirmed: purchased, connected, `NEXT_PUBLIC_APP_URL` updated in Hostinger to this URL, and Hostinger redeployed afterward). Not independently verifiable from this repository.
- **Hosting:** Hostinger managed Node.js hosting, deployed via GitHub auto-deploy from `main`.
- **Database:** Supabase PostgreSQL (production).
- Cookies, the service worker scope, and the PWA manifest's `start_url`/`scope` are all relative (`/`) — no hardcoded domain anywhere in the app, so no further code change was needed for the domain cutover.
- The old temporary Hostinger-provided URL is no longer the primary production URL now that `offshiftoptions.com` is connected and confirmed live.

---

## PWA / Mobile

- Manifest (`public/manifest.webmanifest`): name "Off Shift Options", short name "OSO", standalone display, theme/background colors, icons for both `any` and `maskable` purposes.
- Icons: `public/icon.svg` (scalable), `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-192.png`, `public/icon-maskable-512.png`, `public/apple-touch-icon.png` (180x180), rebranded `src/app/favicon.ico`. No remaining placeholder icons.
- Service worker (`public/sw.js`): network-first for page navigations with a cached `/login` fallback (never serves a stale authenticated/financial page offline); cache-first only for a small fixed shell asset list. Cache name is versioned (`oso-shell-v2`) so it invalidates cleanly on updates.
- Mobile navigation, touch targets, and layout verified overflow-free at 390px width across all main authenticated routes via Playwright.
- **Unfinished:** real Web Push delivery. `WebPushNotificationProvider` (`src/lib/notifications.ts`) is a documented no-op. The storage endpoint (`POST /api/push-subscriptions`) exists but nothing on the client calls it yet. HTTPS (the old blocker) is no longer the issue — completing this needs VAPID key generation/config, a `web-push` server dependency, a client subscribe flow, permission-decline handling, and a service worker `push` handler. Tracked as a Phase 2/3 task in `docs/PWA_AND_NOTIFICATIONS.md`, not started.

---

## Chat / Social

- One private conversation per Matt/Eric pair, created by the production bootstrap (or dev seed locally). No self-service "start a conversation" UI exists (not needed — there are only two users).
- Sending/reading requires active `ConversationMember` membership, enforced server-side (`src/lib/workflows.ts`); proven by a DB-integration test that a non-member's send attempt is rejected.
- Read receipts (`ChatMessageRead`) track per-user read state; unread count and "Unread"/"Read by ..." UI reflect it.
- **Live updates:** a client component polls `router.refresh()` every 4 seconds while the chat tab is visible (paused when hidden) — the simplest mechanism compatible with the existing Server Component/Server Action architecture, no WebSockets or Supabase Realtime.
- Recommendations carry their own participant-gated comments and reactions; watchlist items carry owner-only notes plus shared, read-access-gated comments.
- Notification delivery on new messages/recommendations/comments/reactions is server-side (`notifyInApp`), scoped to the correct recipient only.

---

## Security

- Server-side mutation authorization for every action, centralized in `src/lib/workflows.ts` (never trust client state or hidden UI).
- `PRIVATE`/`SHARED` visibility enforced in `src/lib/privacy.ts`; buddies can read shared records but never private ones; mutation always requires ownership except for intentionally social actions (comments/reactions/chat) which use read-access or explicit participant checks instead.
- Sessions: HTTP-only, `Secure` in production, `SameSite=Lax`, HMAC-hashed tokens, new token minted per login (no fixation).
- Password hashing: `bcryptjs`, consistent across all creation/change paths.
- Ownership enforcement covers watchlist items, notes, recommendations, chat membership, notifications, and scanner settings — each scoped to the correct owner/participant, proven by unit + DB-integration tests.
- Schwab market data may be shared application infrastructure, but Schwab brokerage account data and tokens are strictly user-scoped. Never reuse one user's OAuth connection for another user's account sync, imports, balances, positions, transactions, performance, projections, settings, or trading-result achievements.
- Schwab OAuth state is signed with an HMAC, expires after 10 minutes, is tied to the current OSO user, and is stored in an HttpOnly/SameSite=Lax cookie (`Secure` in production). The callback requires an active OSO session and rejects cross-user, tampered, mismatched, or expired state.
- Schwab access/refresh tokens are encrypted at rest with a dedicated server-side AES-256-GCM key. Client-side UI shows only safe connection metadata such as status, linked account count, and account-number last4s; account hashes stay server-side.
- Schwab token access has an explicit `expectedUserId` guard and a DB integration regression test proving Eric cannot read Matt's Schwab broker token.
- No secrets in the client bundle — only `NEXT_PUBLIC_APP_URL` is public, and it contains no sensitive data.
- No trading/order-submission endpoints exist anywhere in the codebase.
- Input validation: server-side ticker format validation (`src/lib/tickers.ts`) backed by database `CHECK` constraints; password strength validation (`src/lib/account.ts`).
- `/api/health` never leaks database error details (see Deployment section).
- Production HTTP security headers (`next.config.ts`, applied to every route): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, `Strict-Transport-Security`, and a baseline `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`; `script-src`/`style-src` still allow `'unsafe-inline'` because Next's App Router needs it without a nonce setup — a known, accepted tradeoff, not a gap to silently "fix" by weakening the CSP further).
- **No currently known open security issues.** A full audit pass (auth, IDOR, session handling, secrets, headers, health endpoint) was completed and fixes applied — see `docs/HANDOFF.md`'s "Pre-Schwab Production Hardening" entry for the detailed findings/fixes list.

---

## Testing

Last verified (August 31, 2026, against local Docker PostgreSQL and the local Docker app container — nothing run against Supabase):

| Check | Command | Result |
|---|---|---|
| Prisma validate | `corepack pnpm prisma validate` | passed |
| Prisma generate | via `corepack pnpm typecheck` / `corepack pnpm build` | passed |
| TypeScript | `corepack pnpm typecheck` | passed |
| ESLint | `corepack pnpm lint` | passed, no output |
| Vitest unit tests | `corepack pnpm test` | 95 passed / 25 skipped (DB tests skip without `RUN_DB_TESTS`) |
| Vitest incl. DB integration | `RUN_DB_TESTS=1 DATABASE_URL=<local Docker Postgres URL> corepack pnpm test` | 120/120 passed across 24 files against local Docker Postgres |
| Playwright e2e | `corepack pnpm exec playwright test` against the rebuilt local Docker `app` container | 6/6 passed, including mobile overflow sweeps across all main routes |
| Production build | `corepack pnpm build` | passed |

This pass's new/updated tests: `src/domain/finance/accountLedger.test.ts` and `accountLedger.integration.test.ts` (starting/deposit/withdrawal/adjustment math, cross-user ledger-entry rejection, the $10,000+$2,000+$300=$12,300 worked example, the +28/−53/+82=+57-OPEN-then−11=+46-WIN worked example against a real database, and proof that a buddy's completed campaign never appears in another user's `ownCompletedCampaigns` even under `scope=both`), `src/domain/finance/performance.test.ts` (win/loss and weekly-return math), `src/domain/scanner/profile.test.ts` (LST Core diffing), three new gating/`UNKNOWN`-semantics tests in `scanner.test.ts`, and a fixed pre-existing DB-integration assertion that still expected the pre-LST-Core price default. Earlier Schwab-focused tests (token encryption, OAuth state tamper/cross-user/expiry rejection, sanitized errors, payload normalization, token refresh, staged live scanner behavior, cross-user token-read rejection) are unchanged and still pass.

**2026-08-31 follow-up fix (Dashboard broker positions)**, after a live smoke test found the Dashboard stuck at 0 open positions / $0.00 secured despite 3 real synced Schwab short puts: `src/domain/finance/occOption.test.ts` (OCC symbol parsing against real padding/case variants and invalid input), `src/domain/finance/brokerPositions.test.ts` (short-put classification preferring Schwab's own fields over the OCC fallback, long puts/calls/equity never counted as CSP collateral, an unclassifiable position excluded and flagged rather than guessed, `computeOpenPositionsCount` proving the exact reported bug is fixed — 0 campaigns + 3 broker positions = 3, not 0 — and human-readable display formatting), `src/providers/schwab/broker-read.test.ts` (the normalizer correctly extracts `assetType`/`putCall`/`strikePrice`/signed quantity from Schwab's raw position payload for 3 short puts, a long position, and a plain equity position), and a new `src/lib/broker-connections.integration.test.ts` case proving Eric gets `null` from both `getSchwabBrokerReadProviderForUser` and `getSchwabOpenPositionsForUser` while Matt's own connection resolves normally. No schema change was needed for this fix.

DB-integration tests always use disposable test users with cleanup in `afterAll` — they never touch Matt/Eric's real seeded credentials. Nothing in this repository's test suite is designed to run against Supabase; do not point it there.

---

## Important File Map

- `PROJECT_HANDOFF.md` — this file; canonical current-state document.
- `PRODUCT_VISION.md` — long-term product north-star (areas, principles, non-goals); not a changelog.
- `docs/HANDOFF.md` — older chronological session-by-session log (kept for detailed history); this file is now canonical for *current* state.
- `AGENTS.md` — general agent operating instructions.
- `CLAUDE.md` — Claude-specific entry pointer to this file.
- `README.md` — human/developer-facing docs, local setup, scripts.
- `package.json` — scripts and dependencies.
- `prisma/schema.prisma` — database model.
- `prisma/migrations/` — migrations: `20260828114500_init`, `20260828132500_phase_1b_hardening`, `20260828215700_campaign_tracker_foundation`, `20260831211006_account_ledger_and_broker_link` — all four applied to production Supabase.
- `src/domain/finance/accountLedger.ts` — account ledger summarization (`summarizeAccountLedger`, `currentAccountValue`) — see Account Ledger section.
- `src/domain/finance/performance.ts` — win/loss and weekly-return-vs-target math (`summarizeWinLoss`, `summarizeWeeklyReturns`) — see Account Ledger section.
- `src/domain/finance/occOption.ts` — OCC option symbol parsing/formatting for display (`parseOccOptionSymbol`) — see Schwab API section.
- `src/domain/finance/brokerPositions.ts` — broker-position classification, CSP secured-capital math, and open-positions counting (`classifyBrokerPosition`, `summarizeCspSecuredCapital`, `computeOpenPositionsCount`, `describeBrokerPositionForDisplay`) — see Schwab API section.
- `prisma/seed.ts` — **destructive** development/demo seed. Never production.
- `prisma/bootstrap-production.ts` — safe production bootstrap CLI.
- `src/lib/bootstrap.ts` — safe bootstrap logic (idempotent, non-destructive).
- `src/lib/auth.ts` — authentication/session logic.
- `src/lib/account.ts` — change-password logic.
- `src/lib/broker-connections.ts` — safe Schwab connection summaries, disconnect, and provider factory helpers.
- `src/lib/privacy.ts` — `PRIVATE`/`SHARED` authorization helpers.
- `src/lib/workflows.ts` — server-side mutation/authorization logic for every server action.
- `src/domain/scanner/` — scanner engine (`scanner.ts`), rule catalog/demo data (`profile.ts`), and staged live Schwab scanner (`live-scan.ts`).
- `src/domain/finance/calculations.ts` — legacy per-trade financial calculations.
- `src/domain/finance/campaigns.ts` — campaign lifecycle financial summaries (`summarizeCampaign`).
- `src/domain/social/` — recommendation reason tags/statuses.
- `src/providers/market-data/` — market-data provider contracts plus demo provider.
- `src/providers/broker-read/` — broker-read provider contracts plus demo provider.
- `src/providers/schwab/` — read-only Schwab OAuth/token/client/normalizer/market-data/broker-read implementation and docs.
- `src/components/live-refresh.tsx` — chat's polling live-update mechanism.
- `src/app/(app)/` — authenticated Next.js routes (dashboard, positions, scanner, scanner/settings, watchlist, recommendations, chat, notifications, account, install).
- `src/app/api/health/`, `src/app/api/push-subscriptions/`, `src/app/api/schwab/` — API routes.
- `next.config.ts` — security headers.
- `docs/` — supporting architecture/security/decision documentation (`ARCHITECTURE.md`, `SECURITY.md`, `DECISIONS.md`, `DATA_MODEL.md`, `SCANNER_RULES.md`, `PWA_AND_NOTIFICATIONS.md`, `SCHWAB_INTEGRATION.md`, `ROADMAP.md`, `LST_DOMAIN.md`).

---

## Architectural Decisions

Future AI agents should not casually reverse these:

- Hostinger is production application hosting; Supabase is production PostgreSQL.
- Supabase's Data API is not enabled merely because Supabase offers it — Prisma over a direct Postgres connection is the only production data-access path.
- Prisma is the ORM.
- GitHub `main` drives deployment (every push auto-deploys).
- The destructive development seed (`prisma/seed.ts`) and the safe production bootstrap (`prisma/bootstrap-production.ts`) are deliberately separate and must stay that way.
- The production build never runs the bootstrap or migrations automatically (see Deployment section for why and the required manual migration workflow).
- `PRIVATE`/`SHARED` visibility is intentional, load-bearing architecture — not a cosmetic UI toggle.
- Future Schwab integration begins read-only; no automatic trading/order submission.
- The scanner must never represent mock/demo data as live.
- Mobile-first PWA remains a core requirement.
- Chat updates via simple client-side polling (`router.refresh()`), not WebSockets/Realtime — deliberately the simplest option for a two-user app.
- Watchlist Pro/Con/General notes are owner-only; buddy interaction on shared items happens through comments instead.
- Campaigns model a whole trading idea as an append-only event history (`CampaignEvent`), never overwriting or deleting a prior event — a roll always writes new `ROLL_PUT_CLOSE`/`ROLL_PUT_OPEN` rows, it never edits the original `SELL_PUT`. Do not "simplify" this into a mutable current-state-only model.
- Campaign visibility defaults to `INHERIT` from its account, but an explicit `SHARED`/`PRIVATE` on the campaign itself always overrides the account — this lets one campaign be shared out of an otherwise-private account (or vice versa) without changing the account's own visibility.
- Prefer secure, conventional, maintainable implementation choices; do not blindly implement a technically weaker approach when a clearly better one exists (see AI Continuity Rules above).
- Account performance is always derived from the ledger (`AccountLedgerEntry`), never from `currentBalance − startingBalance` — do not reintroduce a derived-difference shortcut (see Account Ledger section).
- A scanner setup that fails a gating rule (`GATING_RULE_KEYS`) must never receive a positive score label, and an `UNKNOWN` overall result must never be labeled as if it passed — do not relax `honestSetupScore`/`honestSetupLabel` back to the raw score/label.
- Performance/win-rate figures are computed from an always-"mine"-scoped query, never the Mine/Buddy/Both scope selector — do not let a shared/"Both" view accidentally aggregate Matt's and Eric's P/L into one number.
- New `TradingAccount` rows default to `PRIVATE` visibility, not `SHARED` — sharing remains explicit and opt-in.
- CSP secured capital from a Schwab position only ever counts a position confidently identified as a short put (`classifyBrokerPosition`); never infer PUT/CALL or short/long when the data is ambiguous — show the total as a floor (`hasUnknown`) instead of guessing.
- Raw OCC option symbols are never shown to the user as-is; always run them through `src/domain/finance/occOption.ts` for display while preserving the original symbol internally.

---

## Known Issues / Technical Debt

- **Web Push is unfinished** — documented no-op, real implementation deferred (see PWA section).
- **`LST_SESSION_SECRET` env var name predates the "Off Shift Options" rebrand.** Cosmetic only (it's an internal config key, not user-visible), but renaming it later requires coordinating the Hostinger env var change with a deploy — not urgent.
- **CSP allows `script-src`/`style-src` `'unsafe-inline'`** because Next's App Router needs it without a nonce-based setup. A stricter nonce-based CSP is a possible future hardening step, not currently required.
- **No CI-automated migration deploy** — Hostinger cannot run `prisma migrate deploy` (see the warning in Production / Deployment). The Supabase migration workflow is currently a manual runbook: apply and verify a migration against Supabase *before* pushing dependent code to `main`. Reasonable to automate in CI later; not done yet, and not to be implemented as a side effect of an unrelated task.
- **Live Schwab scanner is a foundation, not the full production scanner yet.** Hostinger Schwab env vars are configured per Matt, but live scanning still requires the code deploy and at least one OAuth connection. The live universe is intentionally still the 13-symbol starter list, option-chain calls are capped, and there is no durable market-data cache/backoff layer yet. A broader curated universe plus batching/rate-limit handling is the next Schwab scanner slice.
- **No UI action yet for covered-call sell/close or stock sale** on an `ASSIGNED` campaign — intentionally deferred, honestly labeled in the UI, and is the recommended next slice (see Next Tasks). The finance/schema layer already supports these event types.
- Manual campaigns/accounts remain fully manual entry; Schwab-synced accounts now update via "Sync now" (see Account Ledger / Schwab API sections), but there is still no UI to turn a Schwab position into an explicit link to a specific OSO campaign (only a same-ticker "Possible match"/"Unlinked" hint) or to import historical Schwab transactions as campaigns.
- **Dashboard "Open positions" and "Secured (CSP)" are additive, not deduplicated**, across OSO campaigns and Schwab broker positions — a real-world trade tracked as both would count twice today. This is the deliberate interim behavior until campaign-to-position reconciliation exists (see Schwab API section); fixing it properly requires the same reconciliation UI already tracked as future work, not a quick patch.

---

## Current State — Where We Left Off

- Off Shift Options is live on Hostinger, deployed via GitHub `main` auto-deploy.
- Supabase production PostgreSQL is live and reachable; `/api/health` has reported healthy.
- Production Matt/Eric accounts have been bootstrapped via the safe, non-destructive bootstrap script and login has been verified in production.
- `offshiftoptions.com` has been purchased, connected as the production domain, and confirmed live; `NEXT_PUBLIC_APP_URL` has already been updated in Hostinger to `https://offshiftoptions.com` and Hostinger redeployed afterward (externally confirmed). The old temporary Hostinger URL is no longer primary.
- Schwab Trader API app approval/configuration is complete as of 2026-08-31: Market Data Production and Accounts and Trading Production are enabled, Order Limit is 0, and the production callback is `https://offshiftoptions.com/api/schwab/callback`.
- Earlier completed work: a full pre-Schwab production hardening pass (rebrand, PWA icons, Change Password, live chat, security headers, `/api/health` fix), a scanner demo-quality pass (setup scoring, near-match detection, exclusion diagnostics, Score/Filter modes, quick filters, `Demo*Provider` naming), the Campaign Tracker foundation (`Campaign`/`CampaignEvent`/`RecordVisibility` schema, lifecycle math, INHERIT/SHARED/PRIVATE visibility, the original `/positions` UI), and the Schwab OAuth/market-data foundation (env config, signed OAuth state, `/api/schwab/connect`/`callback`, encrypted token storage/refresh, read-only market-data and broker-read providers, the original Account-page connection panel, and the `LIVE • SCHWAB` live scanner action). All of the above is committed, pushed, and live in production.
- **Migration `20260828215700_campaign_tracker_foundation` applied to production Supabase on 2026-08-29** (Matt ran `prisma migrate deploy` + `prisma migrate status`, confirmed up to date). Campaign Tracker code committed and pushed to `origin/main` in the same session — see Recent Relevant Commits.
- No schema migration was created or required for the Schwab OAuth/market-data foundation; it reuses the existing `BrokerConnection` model.
- This continuity system (`PROJECT_HANDOFF.md`, `AGENTS.md` update, `CLAUDE.md`) is in place so any AI can resume by reading this file.
- **The "Core Trading Cockpit + Account/Tracking Usability" slice** — driven by an independent 53-finding UX audit of production (`OFF_SHIFT_OPTIONS_UX_AUDIT.md`, repo root) and taking over an interrupted Codex slice that had partially added the `AccountLedgerEntry` schema and LST Core threshold values — is **committed, pushed, and deployed**. Delivered: the Account Ledger (schema + domain logic + `/account` UI), the LST Core scanner baseline with a "Reset to LST Core" action and diff badges (plus a real seed-data bug fix so fresh profiles actually match LST Core), gating-vs-preference honest score/label semantics on the scanner, a Schwab account-sync workflow with an honest Sync-now-first `/account` UI and a read-only Tracker open-positions panel, a rebuilt one-screen Dashboard cockpit, and the Tracker's Open/History/Performance/Accounts tabs with performance math that is provably never blended across users. Full detail is in the Account Ledger, Scanner, Schwab API, and Campaign Tracker sections above. Commit `a7af62b` (2026-08-31).
- **Migration `20260831211006_account_ledger_and_broker_link` was applied to production Supabase and verified** (Matt ran `prisma migrate deploy` + `prisma migrate status`, confirmed "Database schema is up to date") before the above commit was pushed to `main`.
- **2026-08-31 follow-up fix (same day, post-deploy live smoke test): Dashboard broker-position visibility.** The live smoke test found Matt's 3 real synced Schwab short puts (RIOT/APLD/CORZ) correctly appearing on the Tracker's Open tab, but the Dashboard still showed "Open positions: 0" / "Secured (CSP): $0.00" because it only ever read OSO campaigns, never Schwab positions. Fixed by wiring `getSchwabOpenPositionsForUser` into the Dashboard (same pattern as the Tracker) and adding two new domain modules — `src/domain/finance/occOption.ts` (OCC option symbol parsing/formatting, e.g. "RIOT 260904P00017500" → "RIOT · Sep 4, 2026 · $17.50 Put") and `src/domain/finance/brokerPositions.ts` (short-put classification, CSP secured-capital math, additive open-positions counting) — used by both the Dashboard and the Tracker's Schwab positions panel for consistent display and math. Also fixed two stale copy strings ("Demo/manual data only..." on the Tracker, "Demo/manual Phase 1" in the sidebar) that were no longer accurate once live Schwab data was displayed, and added a `LIVE SCHWAB`/`MANUAL`/`MIXED` badge next to the Dashboard's Account Value stat. **No schema change was required or made for this fix.**
- **Deferred from the UX audit, intentionally not attempted** (engineering judgment — see the audit file for full detail): a full `/t/RIOT`-style Research page, a whole-options-universe scanner, whole-chain strike optimization, third-party earnings-calendar ingestion (the `earningsDistance` criterion stays honestly `UNKNOWN` on live Schwab scans — see Scanner section), achievements/gamification, a projections/forecasting engine, CSV import of historical trades, consolidating Recs/Chat/Alerts into one inbox, and a full navigation redesign (only the one low-risk, directly-tied rename — "Settings" → "Scanner Rules" — was made). These remain good candidates for future slices.
- **Nothing is currently blocked by Schwab approval, production env var setup, or a pending migration.** Schwab is connected and syncing live for Matt in production.

### Git / Deployment State (as of this session)

- The scanner enhancement work, the Campaign Tracker foundation, and the Schwab OAuth/market-data foundation (schema, workflows, UI, tests, docs) are **committed and pushed to `origin/main`** — see Recent Relevant Commits for hashes.
- The Core Trading Cockpit + Account Ledger slice (commit `a7af62b`) is **committed, pushed, and deployed**; its migration was applied to and verified against production Supabase first.
- The Dashboard broker-position follow-up fix (this session, no schema change) is validated locally and ready to commit/push — see Next Tasks for the exact remaining step.

---

## Next Tasks

**NOW**
- Commit and push the Dashboard broker-position follow-up fix (no migration needed — see Current State). After Hostinger auto-deploys: confirm `/dashboard` shows "Open positions: 3" and a non-zero "Secured (CSP)" for Matt's real RIOT/APLD/CORZ short puts, that the Tracker's Schwab positions now render as "RIOT · Sep 4, 2026 · $17.50 Put" / "-1 contract" instead of the raw OCC symbol, and that the Account Value stat shows the correct `LIVE SCHWAB`/`MIXED` badge.
- Once broker-position reconciliation is prioritized: replace the additive (non-deduplicated) Open Positions/Secured CSP counting with a real link between an OSO campaign and a Schwab position, so the same real-world trade is never counted twice (see Schwab API section).
- Next Schwab scanner slice: broaden the live ticker universe, add batching/rate-limit backoff/caching, add stronger empty-chain diagnostics, and decide whether a real earnings-data provider is worth adding (see Scanner section's earnings-`UNKNOWN` limitation) versus keeping it honestly `UNKNOWN`.
- **Recommended next implementation slice:** finish the wheel lifecycle UI — a "Sell Covered Call" action, a "Close Covered Call"/"Expire Covered Call" action, and a "Record Stock Sale" action for `ASSIGNED` campaigns, mirroring the existing `closeCampaignPutForUser`/`rollCampaignPutForUser` pattern (ownership re-checked server-side, event appended, never mutating prior events). The finance math and schema already support this; only the create-event workflows/actions/forms are missing.
- Consider automating the Supabase migration-deploy step in CI instead of the manual runbook.
- Consider renaming `LST_SESSION_SECRET` to something brand-neutral (coordinate with a Hostinger env var update — not urgent).

**DEFERRED FROM THE 2026-08-31 UX AUDIT** (engineering judgment — see `OFF_SHIFT_OPTIONS_UX_AUDIT.md` and Current State for why)
- Full `/t/RIOT`-style Research page; whole-options-universe scanner; whole-chain strike optimization.
- Third-party earnings-calendar ingestion (stays `UNKNOWN` honestly for now).
- Achievements/gamification; a projections/forecasting engine (would require fabricating confidence the app doesn't have).
- CSV import of historical trades.
- Consolidating Recs/Chat/Alerts into one inbox; a full navigation redesign.

**SCHWAB INTEGRATION**
- Keep OAuth/token/account-hash handling server-only and re-check official Schwab docs before adding new endpoint coverage. If Schwab publishes PKCE support/requirements later, add it deliberately with tests.
- Expand shared live market-data integration for quotes, historical prices, option chains, expirations/strikes, bid/ask, option volume, open interest, and Greeks where Schwab provides them.
- Build Matt's read-only account/position/transaction sync as user-scoped brokerage data with an explicit reconciliation/confirmation UI. Eric remains independent/manual unless he later authorizes his own Schwab connection through the same OSO Schwab app.
- Gradually replace the demo scanner universe with live option-chain data while keeping the same PASS/FAIL/UNKNOWN engine and visible data-source labels.
- Re-verify the "no order execution" boundary after every Schwab expansion.

**LATER**
- Complete real Web Push delivery (VAPID keys, `web-push` dependency, client subscribe flow, service worker push handler).
- Stricter nonce-based CSP.
- Expand automated test coverage for the change-password and live-chat features with a two-context Playwright scenario, if desired.

---

## Recent Relevant Commits

- `a7af62b` — feat: add account ledger, LST Core scanner baseline, Schwab account sync, and cockpit dashboard/tracker
- `868e250` — test: cover campaign visibility, roll history, and lifecycle math
- `648c970` — feat: add campaign tracker foundation (accounts, campaigns, lifecycle, visibility)
- `4cba783` — feat: enhance scanner with setup scoring, quick filters, and diagnostics
- `ff413e8` — docs: clarify production migration and domain state
- `7d847e4` — docs: document pre-Schwab production hardening

Full history is in Git — this list is only enough to orient a new AI, not a complete log.
