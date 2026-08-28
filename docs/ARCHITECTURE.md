# LST Buddy Architecture

LST Buddy is a local-first Progressive Web App built with Next.js App Router, strict TypeScript, Prisma 7, PostgreSQL, Tailwind CSS, and Vitest.

Phase 1 is intentionally demo/manual:

- No Schwab credentials are required.
- No live option chain is presented.
- No trade placement, order submission, replacement, or cancellation exists.
- Authentication, privacy checks, scanner rules, watchlists, chat, recommendations, notifications, and CSP position math are implemented server-side where relevant.

## Runtime Shape

- Next.js server components render authenticated pages.
- Server actions mutate watchlists, recommendations, reactions, chat messages, and notifications.
- Cookie-backed sessions are stored in the database as HMAC-hashed opaque tokens.
- Prisma uses `@prisma/adapter-pg` with `pg` for PostgreSQL connectivity.
- Docker Compose starts PostgreSQL, applies migrations, seeds demo data, and starts Next.js.

## Important Boundaries

- `src/domain/finance` contains deterministic financial calculations, including per-contract vs. per-share CSP money math and position health status.
- `src/domain/scanner` contains criterion-level scanner evaluation; `src/domain/scanner/profile.ts` defines the editable rule catalog, demo candidates, and form parsing for `/scanner/settings`.
- `src/domain/social` contains recommendation reason tags/statuses shared between server actions and pages.
- `src/lib/privacy.ts` contains reusable authorization checks (`assertCanReadRecord`, `assertCanMutateRecord`).
- `src/lib/tickers.ts` contains server-side ticker validation shared by workflows and forms.
- `src/lib/workflows.ts` contains the actual mutation/authorization/notification logic for every server action; it is unit- and integration-tested independent of Next.js.
- `src/providers/*` contains read-only market and broker provider contracts.
- `src/providers/schwab` is a placeholder and must not grow trading methods.

## Data Flow

1. Seed script creates Matt, Eric, demo CSP positions, scanner runs, watchlists, chat, recommendations, notifications, and reactions.
2. Authenticated pages call server-side data loaders in `src/lib/app-data.ts`.
3. Server actions in `src/app/(app)/actions.ts` parse `FormData` and delegate to `src/lib/workflows.ts`, which performs authorization, validation, and mutation.
4. Notifications are written through `NotificationDeliveryProvider` implementations.

## Testing

- `src/**/*.test.ts` — Vitest unit tests, always run by `pnpm test`.
- `src/lib/workflows.integration.test.ts` — opt-in Vitest tests against a live PostgreSQL database, gated by `RUN_DB_TESTS=1` and `DATABASE_URL` (skipped otherwise). Vitest aliases the `server-only` package to a no-op stub (`test/stubs/server-only.ts`) since that guard only works inside Next.js's bundler.
- `tests/e2e/*.spec.ts` — Playwright smoke tests (`pnpm test:e2e`) against a running app instance, covering login, private/shared data isolation, recommendation delivery, per-user scanner settings, and mobile layout.

## Local Operations

The intended full local path is:

```bash
cp .env.example .env
docker compose up --build
```

Without Docker, use a local PostgreSQL instance and run:

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```
