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
