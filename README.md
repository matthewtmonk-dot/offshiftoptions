# Off Shift Options

Off Shift Options (formerly "LST Buddy") is a private PWA for Matt and Eric to research and track conservative cash-secured puts with watchlists, scanner criteria, recommendations, chat, in-app notifications, and privacy controls. The "My LST" scanner profile name refers to the underlying Low Stress Trading strategy, not the app's product name.

This app does not place trades. Trades stay in Schwab/Thinkorswim or another brokerage outside Off Shift Options.

## Quick Start With Docker

1. Create local environment values:

```bash
cp .env.example .env
```

2. Set `DEV_SEED_PASSWORD` in `.env`.

3. Start the app and database:

```bash
docker compose up --build
```

The app runs at `http://localhost:3000`.

## Seeded Development Users

- Matt: `matt@lst.local`
- Eric: `eric@lst.local`
- Password: value of `DEV_SEED_PASSWORD`

The Docker Compose file provides a development fallback password of `lstbuddy-dev-only` if `DEV_SEED_PASSWORD` is not set.

## Local Commands

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Useful scripts:

- `pnpm dev`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm db:migrate`
- `pnpm db:seed` — **destructive**, local development/reset data only
- `pnpm db:reset`
- `pnpm bootstrap:production` — safe, non-destructive, idempotent production user bootstrap (already run once against Supabase; not part of routine deploys)

`pnpm build` runs `prisma generate && next build`. This is also the exact Hostinger production build command. It never seeds, bootstraps, or applies migrations — see "Deployment (Hostinger + Supabase)" in `docs/ARCHITECTURE.md` for why migrations are not run automatically, and `docs/DECISIONS.md` for the full history.

## Database Integration Tests

`pnpm test` runs the unit suite and skips database-backed tests by default. To run the opt-in integration tests in `src/lib/*.integration.test.ts` against a live PostgreSQL instance (for example the Docker Compose database), set both `RUN_DB_TESTS=1` and `DATABASE_URL`:

```bash
RUN_DB_TESTS=1 DATABASE_URL="postgresql://lst_buddy:lst_buddy_dev@localhost:5432/lst_buddy?schema=public" pnpm test
```

These tests require Matt and Eric to already be seeded.

## End-To-End Tests

`pnpm test:e2e` runs the Playwright suite in `tests/e2e` against a running app (default `http://localhost:3000`, override with `PLAYWRIGHT_BASE_URL`). Start the Docker stack (or `pnpm dev` against a seeded database) first, then run `pnpm exec playwright install chromium` once per machine before the first run.

## PWA Notes

The app includes a web app manifest, service worker shell, install prompt component, standalone display metadata, and mobile-first authenticated layouts.

External mobile Web Push is not active in Phase 1. Push subscriptions can be stored, but delivery is deferred until HTTPS hosting and VAPID key management are configured.

## AI / Developer Continuity

For the current project state, architecture decisions, production status, security rules, and next development tasks, read:

`PROJECT_HANDOFF.md`

AI coding agents should read that file before beginning work and update it automatically after meaningful changes.

## Documentation

- `PROJECT_HANDOFF.md` — canonical current-state document
- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/LST_DOMAIN.md`
- `docs/SCANNER_RULES.md`
- `docs/PWA_AND_NOTIFICATIONS.md`
- `docs/SCHWAB_INTEGRATION.md`
- `docs/SECURITY.md`
- `docs/ROADMAP.md`
- `docs/DECISIONS.md`
- `docs/HANDOFF.md`

## Verification

Run before handoff:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Docker/PostgreSQL verification requires Docker to be installed and available on PATH.
