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

- `src/domain/finance` contains deterministic financial calculations.
- `src/domain/scanner` contains criterion-level scanner evaluation.
- `src/lib/privacy.ts` contains reusable authorization checks.
- `src/providers/*` contains read-only market and broker provider contracts.
- `src/providers/schwab` is a placeholder and must not grow trading methods.

## Data Flow

1. Seed script creates Matt, Eric, demo CSP positions, scanner runs, watchlists, chat, recommendations, notifications, and reactions.
2. Authenticated pages call server-side data loaders in `src/lib/app-data.ts`.
3. Mutations run through server actions in `src/app/(app)/actions.ts`.
4. Notifications are written through `NotificationDeliveryProvider` implementations.

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
