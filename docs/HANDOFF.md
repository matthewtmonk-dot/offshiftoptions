# Handoff

This file is updated at the end of each Codex session.

## 2026-08-28 Initial Phase 1 Foundation

Time: 2026-08-28 11:56:47 -04:00

Current phase: Phase 1 local foundation.

## Request Received

Begin the long-term LST Buddy project in the current folder. Actually build and verify a Phase 1 PWA foundation with authentication, PostgreSQL/Prisma schema, demo/manual CSP data, scanner logic, watchlists, recommendations, buddy chat, in-app notifications, privacy protections, read-only broker architecture, Docker configuration, tests, docs, clean Git history, and this handoff.

## Work Completed

- Initialized Git and renamed the default branch to `main`.
- Scaffolded a Next.js App Router TypeScript app with Tailwind CSS and pnpm.
- Added Prisma 7, PostgreSQL adapter, `pg`, `bcryptjs`, `zod`, `lucide-react`, `tsx`, and Vitest.
- Designed the normalized Prisma schema for users, settings, sharing preferences, sessions, accounts, CSP trades, trade legs, position snapshots, watchlists, notes, comments, recommendations, conversations, chat messages, reactions, activities, notifications, push subscriptions, scanner profiles/rules/runs/results, market quote cache, option snapshots, and broker connections.
- Created an initial SQL migration at `prisma/migrations/20260828114500_init/migration.sql`.
- Added idempotent demo seed data for Matt, Eric, CORZ, scanner candidates, watchlists, shared/private records, recommendations, chat, notifications, reactions, mock quotes, mock option snapshots, and mock broker connections.
- Implemented database-backed authentication with HTTP-only session cookies and HMAC-hashed session tokens.
- Implemented server-side privacy helpers with tests.
- Implemented domain financial calculations with tests.
- Implemented criterion-level scanner logic with tests.
- Built authenticated pages for dashboard, positions, scanner, watchlist, recommendations, chat, notifications, and install.
- Added server actions for watchlist CRUD, visibility toggles, Pro/Con notes, comments, recommendations, recommendation status, chat messages, notifications, and Atta Boy reactions.
- Added `/api/health`.
- Added `/api/push-subscriptions` for future Web Push subscription storage.
- Added PWA manifest, service worker shell, install prompt component, and app icon placeholder.
- Added read-only `MarketDataProvider` and `BrokerReadProvider` interfaces plus mock providers.
- Added Schwab placeholder docs with explicit forbidden trading methods.
- Added project documentation.

## Files Created Or Changed

- `package.json` - scripts and dependencies.
- `compose.yaml` - PostgreSQL plus app services.
- `Dockerfile` - Node 24/pnpm app image.
- `.env.example` - local development environment template.
- `prisma/schema.prisma` - normalized database model.
- `prisma/migrations/20260828114500_init/migration.sql` - initial migration SQL.
- `prisma/seed.ts` - Phase 1 demo data.
- `src/app/*` - app routes, layouts, server actions, API routes.
- `src/components/*` - UI primitives and PWA registration/install components.
- `src/domain/finance/*` - financial calculations and tests.
- `src/domain/scanner/*` - scanner engine and tests.
- `src/lib/*` - Prisma, auth, privacy, notifications, formatting, and data loaders.
- `src/providers/*` - mock read-only providers and Schwab placeholder.
- `public/manifest.webmanifest`, `public/sw.js`, `public/icon.svg` - PWA assets.
- `docs/*`, `README.md`, `AGENTS.md` - project documentation.

## Database Changes

- Prisma schema validates.
- Initial migration SQL generated offline.
- Migration application was attempted but could not run because no PostgreSQL server is available at the local `.env` URL.
- Seed was attempted but could not run because PostgreSQL is unavailable. The error was `ECONNREFUSED`.

## Commands Executed

- `git init`
- `git branch -m main`
- `corepack pnpm dlx create-next-app@latest ...`
- `corepack pnpm add ...`
- `corepack pnpm approve-builds --all`
- `corepack pnpm prisma init --datasource-provider postgresql`
- `corepack pnpm prisma validate`
- `corepack pnpm prisma generate`
- `corepack pnpm prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script --output prisma/migrations/20260828114500_init/migration.sql`
- `corepack pnpm typecheck`
- `corepack pnpm test`
- `corepack pnpm lint`
- `corepack pnpm build`
- `corepack pnpm db:migrate`
- `corepack pnpm db:seed`
- `corepack pnpm dev`
- `Invoke-WebRequest http://localhost:3000/login`
- `Invoke-WebRequest http://localhost:3000/api/health`

## Verification Results

- `pnpm prisma validate` - passed.
- `pnpm typecheck` - passed.
- `pnpm test` - passed, 3 files and 10 tests.
- `pnpm lint` - passed with no warnings after cleanup.
- `pnpm build` - passed cleanly.
- `pnpm dev` - started successfully.
- `GET /login` - returned 200.
- `GET /api/health` - returned 503 because the database is unavailable; this is expected in the current environment.
- Forbidden order-method scan found only documentation that bans `placeOrder`, `submitOrder`, `replaceOrder`, and `cancelOrder`; no implementation exists.

## Docker Result

Docker is not installed or not available on PATH in this environment. `docker --version` failed, so `docker compose up --build` could not be executed here.

## Git State

Branch: `main`

Commits created this session:

- `25b91a3 chore: scaffold lst buddy foundation`
- `c7ef546 feat: build phase 1 lst buddy app`
- `fbad5bd test: configure vitest`
- `docs: document phase 1 handoff` as the final docs commit

Final working tree status after the docs commit: clean.

## Known Problems

- Docker could not be run in this environment.
- PostgreSQL could not be started or reached, so migrations and seed were not applied.
- Authenticated dashboard and seeded workflows compile, but were not browser-tested against a live database.
- Web Push delivery is intentionally deferred until HTTPS hosting and VAPID key handling are configured.

## Technical Debt

- Add integration tests against a disposable PostgreSQL database.
- Add Playwright smoke tests for Matt/Eric login and privacy workflows once Docker is available.
- Replace SVG placeholder app icon with production PNG/maskable assets.
- Expand server-side authorization tests beyond pure privacy helpers.
- Add editable scanner rule UI.
- Add account/trade CRUD beyond seeded demo data.

## Recommended Next Task

Install Docker Desktop or provide a reachable PostgreSQL instance, then run:

```bash
cp .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev
```

After that, verify Matt/Eric login, shared/private watchlist access, dashboard data, recommendation flow, chat, notifications, and `/api/health`.

## Questions Requiring Matt Or Architect Input

- What exact development password should be used for Matt and Eric in local `.env`?
- Should Phase 1 add editable scanner thresholds now or keep thresholds seeded until after DB verification?
- What private/shared defaults should Matt and Eric use for account balance, dollar P/L, percentage P/L, and achievements?

## 2026-08-28 GitHub Remote

Time: 2026-08-28 12:03:12 -04:00

- Added GitHub remote `origin`: `https://github.com/matthewtmonk-dot/offshiftoptions.git`
- Intended push target: `main`
- Follow-up verification: confirm the remote repository shows all local commits after push.

## 2026-08-28 Phase 1B Completion + Deployment Prep (Claude takeover)

Time: 2026-08-28

Codex began Phase 1B (database verification, end-to-end workflow verification, scanner settings, hardening) and left substantial uncommitted work before hitting its usage limit while starting Docker. Claude took over to review, verify, finish, and commit that work, then made one additional deployment-prep change.

### What Codex Had Already Built (uncommitted, inherited as-is)

- Refactored server action bodies out of `src/app/(app)/actions.ts` into a new `src/lib/workflows.ts`, with authorization/validation/notification logic centralized there.
- Tightened watchlist ownership: Pro/Con/General notes are now owner-only (`assertCanMutateRecord`); buddy interaction on shared items happens through comments instead.
- Renamed `RecommendationStatus` values `DISMISSED`/`DONE` to `PASSED`/`ARCHIVED`, with a migration that converts existing rows.
- Added recommendation reason tags (`src/domain/social/recommendations.ts`).
- Added an editable scanner rule catalog (`src/domain/scanner/profile.ts`) and a new `/scanner/settings` page for per-user scanner configuration, backed by `@@unique([profileId, key])` on `ScannerRule`.
- Added database-level ticker `CHECK` constraints on `WatchlistItem`, `StockNote`, `Recommendation`, `ChatMessage`, `Activity`.
- Improved scanner result cards (per-criterion detail, snapshot values), mobile layouts, buddy chat read/unread state, and notifications.
- Corrected CSP math to be explicit about per-share vs. per-contract values (`optionContractValue`, `premiumCaptureSummary`), and added `positionHealthSummary`.
- Added unit tests for the above, an opt-in database integration test suite (`src/lib/workflows.integration.test.ts`, gated by `RUN_DB_TESTS=1`), and a Playwright suite (`tests/e2e/phase1b.spec.ts`) with Chromium already installed.
- Created the `20260828132500_phase_1b_hardening` migration (not yet applied to any database).

### Review Findings

Reviewed the full diff for auth, authorization, privacy, migration correctness, and per-share/per-contract math. No security defects found; the note-ownership change and status rename are intentional design decisions (confirmed by matching page/test changes), not bugs.

One real defect found and fixed: `src/lib/notifications.ts` imports the `server-only` guard package, which is not a real dependency — it works only through Next.js's bundler-level alias. Once `workflows.ts` (and therefore `notifications.ts`) was imported by a plain-Node Vitest test, it failed. Fixed by (1) adding `server-only` as a real npm dependency so Next.js/production behavior is unchanged, and (2) aliasing `server-only` to a no-op stub (`test/stubs/server-only.ts`) in `vitest.config.mts` so tests can import server code without a bundler. This is the standard pattern for testing code that uses the `server-only` guard.

### Docker / PostgreSQL / Verification

- Docker Desktop was installed but not running; started it, then ran `docker compose up --build -d` successfully.
- `docker compose ps`: both `db` (postgres:17-alpine, healthy) and `app` came up.
- Migrations: both `20260828114500_init` and `20260828132500_phase_1b_hardening` applied cleanly against a fresh volume.
- Seed: ran successfully, confirmed Matt (`matt@lst.local`) and Eric (`eric@lst.local`) exist via `psql`.
- Health: `GET /api/health` returned `200 {"app":"ok","database":"ok",...}`.
- Persistence: ran `docker compose restart` (no volume deleted); confirmed "No pending migrations to apply", seed re-ran idempotently, watchlist demo data (CORZ/SOFI/AMD/IONQ) was unchanged after restart, and `/api/health` still returned healthy.
- Database integration tests: `RUN_DB_TESTS=1 DATABASE_URL=... pnpm test` — all 6 integration tests passed after the `server-only` fix (private/shared watchlist protection, unauthorized mutation rejection, recommendation notification, chat membership protection, notification ownership, per-user scanner settings isolation).
- Playwright: `pnpm exec playwright test` — all 5 tests passed against the live Docker app (Matt/Eric login, private watchlist isolation, recommendation delivery across users, per-user scanner settings, mobile layout with no horizontal overflow on 8 routes).
- Static checks: `pnpm prisma validate`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit only), and `pnpm build` all passed, both before and after the `server-only` fix and the package.json build-script change.

### Deployment Prep (Hostinger + Supabase)

Changed `package.json`'s `build` script from `prisma generate && next build` to `prisma generate && prisma migrate deploy && next build`, so a Hostinger deployment applies pending Prisma migrations against the Supabase database automatically before building. Verified `pnpm build` runs `prisma migrate deploy` safely against the local Docker dev database ("No pending migrations to apply") — no seed command was added, and no destructive Prisma command (`db push`, `migrate dev`, `migrate reset`) was introduced. Production seeding remains a separate, manual, one-time action against the real Supabase database.

### Not Done / Deferred

- No Schwab integration work was started or touched.
- No brokerage order-placement code exists anywhere in the repo (confirmed by the existing forbidden-method boundary in `src/providers/schwab`).
- The Hostinger deployment itself was not performed; Supabase production data was not touched; production seed was not run.
- `docs/ROADMAP.md` and `docs/PWA_AND_NOTIFICATIONS.md` were reviewed and left unchanged — still accurate for Phase 1B scope.

### Known Problems / Technical Debt

- The `RUN_DB_TESTS=1` convenience relies on `DATABASE_URL` being exported in the same shell; Vitest does not auto-load `.env`, so both variables must be set explicitly (documented in README).
- Positions page includes a small "Remaining/contract" metric that shows single-contract ask value alongside per-position totals; not incorrect, but potentially confusing next to `Estimated BTC` — worth revisiting for clarity, not urgent.
- Same outstanding items as Phase 1: replace SVG placeholder app icon, expand broker/account CRUD, Web Push delivery still deferred until HTTPS + VAPID.

### Git State

See commits below. Working tree was clean after the final push (`git status`), branch `main` tracking `origin/main`.

## 2026-08-28 First Hostinger Production Deployment

The first Hostinger deployment against the new Supabase database succeeded. Getting there required several corrective, user-directed changes to the `build` script, made and pushed one at a time as each Hostinger failure was diagnosed:

1. `prisma generate && prisma migrate deploy && next build` (planned permanent build) — not tried yet in production at this point.
2. Added a one-time `pnpm run bootstrap:production` step before `next build` to also create the initial Matt/Eric users. First attempt failed: `prisma migrate deploy` errored inside Hostinger's build environment with `schema-engine-debian-openssl-1.1.x EACCES`.
3. Dropped `prisma migrate deploy` (migrations were already applied from an earlier successful deploy) — `prisma generate && pnpm run bootstrap:production && next build`. Failed: Hostinger's build shell does not support nested `pnpm run ...` calls (`pnpm: command not found`).
4. Called `tsx prisma/bootstrap-production.ts` directly instead of through `pnpm run` — `prisma generate && tsx prisma/bootstrap-production.ts && next build`. **This succeeded.** The safe, non-destructive bootstrap created Matt and Eric against the live Supabase database, and Matt's login was verified working in production.
5. Cleaned up: reverted `build` to the permanent `prisma generate && next build`, and removed the now-unneeded `build:first-deploy` script. `bootstrap:production` and `db:seed` were both kept as-is (implementations unchanged throughout).

**Resulting policy:** Prisma migrations are not run automatically during the Hostinger build (see `docs/ARCHITECTURE.md` — Deployment, and `docs/DECISIONS.md`). A controlled process for applying future production schema migrations has not been designed yet; it is tracked as a Phase 2 infrastructure task in `docs/ROADMAP.md`. The production bootstrap has already run once and is not part of routine deploys going forward.

No commands were run against Supabase from this local machine at any point in this sequence — every `pnpm build`/`pnpm bootstrap:production` execution happened inside Hostinger's own deploy pipeline.
