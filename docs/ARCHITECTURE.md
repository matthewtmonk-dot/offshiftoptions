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

## Deployment (Hostinger + Supabase)

**Hostinger production build:**

```bash
prisma generate && next build
```

This is the permanent `pnpm build` script. It does not run `prisma migrate deploy` and does not seed or bootstrap any data.

**Current migration policy:** Prisma migrations are **not** automatically executed inside Hostinger.

**Root cause analysis:** `prisma generate` succeeds inside the Hostinger build, but `prisma migrate deploy` fails with `schema-engine-debian-openssl-1.1.x EACCES`. `generate` mainly copies/references engine binaries; `migrate deploy` must actually **spawn and execute** the downloaded `schema-engine` binary as a subprocess to talk to the database. An `EACCES` specifically on execution (not on read/open) after a successful `generate` step points to the Hostinger build/runtime environment restricting execution of arbitrary spawned binaries — most likely a `noexec`-mounted or otherwise locked-down filesystem/sandbox on their managed Node hosting product, not a simple missing-`+x`-bit problem. A `chmod +x` would not fix a mount-level `noexec` restriction, so that was deliberately not attempted. Hostinger's build shell also does not support nested `pnpm run ...` invocations from within a package script (only the top-level `pnpm run build` works).

**Recommended long-term migration workflow** (safe, maintainable, no Hostinger environment changes required):

1. Change `prisma/schema.prisma` and generate a migration locally as usual (`prisma migrate dev` in local development against Docker Postgres).
2. Before pushing the schema-changing commit to `main` (remember: pushing to `main` triggers a Hostinger auto-deploy), apply the migration directly to Supabase from an environment that can actually execute the schema-engine binary — a local developer machine or a CI runner (e.g. a manually-triggered GitHub Actions job) both work, since neither has Hostinger's execution restriction:
   ```bash
   DATABASE_URL="<supabase-connection-string>" pnpm prisma migrate deploy
   ```
   Never hardcode or commit the Supabase `DATABASE_URL`; pass it as an ad hoc environment variable or CI secret.
3. Verify the migration applied cleanly (check `_prisma_migrations` in Supabase, or hit `/api/health` after the next deploy).
4. Only then push the application code that depends on the new schema to `main`, so Hostinger's build (`prisma generate && next build`) runs against a database that already has the matching schema.

This keeps Hostinger's build fully dependable (it never touches migrations) while still using Prisma's own migration history tracking (`_prisma_migrations`) instead of hand-run SQL, which would need manual bookkeeping to stay in sync. Automating step 2 in CI is a reasonable Phase 2 follow-up once this manual workflow has been used a few times — see `docs/ROADMAP.md` (Phase 2 infrastructure).

**Two separate database scripts exist and must not be confused:**

- `pnpm db:seed` (`prisma/seed.ts`) — **destructive**, local development only. Unconditionally deletes nearly all data before recreating demo users/trades/watchlists/chat. Must never run against Supabase/production.
- `pnpm bootstrap:production` (`prisma/bootstrap-production.ts`, logic in `src/lib/bootstrap.ts`) — **safe, non-destructive, idempotent**. Creates Matt and Eric (and their shared conversation) only if they don't already exist; never deletes, resets, or overwrites existing data. This is not part of the routine Hostinger build — the initial production bootstrap has already been run successfully once, and this script is now only for reference/disaster-recovery (e.g. manually re-run against Supabase if a brand-new database is ever provisioned again).
