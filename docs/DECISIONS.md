# Decisions

## 2026-08-28: Next.js App Router And Prisma 7

Use Next.js App Router with server components and server actions. Use Prisma 7 with `@prisma/adapter-pg` because the generated Prisma 7 client expects an adapter-backed connection.

## 2026-08-28: Database-Backed Sessions

Use simple first-party cookie sessions rather than adding a larger auth framework in the first session. Session tokens are opaque random values in cookies and HMAC-hashed in the database.

## 2026-08-28: Demo/Manual Data Boundary

Seed realistic demo data and label Phase 1 financial values as demo/manual. Do not present modeled or seeded values as live market data.

## 2026-08-28: In-App Notifications First

Implement in-app notifications now. Store push subscriptions and provide a Web Push abstraction, but defer external push delivery until HTTPS and VAPID key handling exist.

## 2026-08-28: Read-Only Broker Contracts

Create read-oriented provider interfaces only. Do not add order placement methods or broker trading abstractions.

## 2026-08-28: Scanner Criteria Preserve Explanations

Model scanner results as criterion-level records with PASS/FAIL/UNKNOWN and explanations, then derive the summary from those rows.

## 2026-08-28: Phase 1B — Workflows Module Owns Mutations

Move server action bodies out of `src/app/(app)/actions.ts` into `src/lib/workflows.ts` so authorization, validation, and notification logic are unit- and integration-testable independent of Next.js server action wiring. Actions stay thin: parse `FormData`, call a workflow function, map `ValidationError` to a redirect-with-error.

## 2026-08-28: Phase 1B — Recommendation Status Rename

Rename `RecommendationStatus` values `DISMISSED`/`DONE` to `PASSED`/`ARCHIVED` for clearer buddy-facing language. The hardening migration converts existing rows rather than dropping data.

## 2026-08-28: Phase 1B — Notes Are Owner-Only, Comments Are Shared

Watchlist Pro/Con/General notes are structured, single-per-category-per-owner records editable only by the owning user. Buddy interaction on a shared watchlist item happens through `Comment`, which remains readable/writable by anyone who can read the item. This keeps a user's own structured research separate from open buddy discussion.

## 2026-08-28: Phase 1B — Database-Level Ticker Constraints

Add `CHECK` constraints on ticker columns (`WatchlistItem`, `StockNote`, `Recommendation`, `ChatMessage`, `Activity`) as a defense-in-depth backstop behind the existing server-side `src/lib/tickers.ts` validation.

## 2026-08-28: Non-Destructive Production Bootstrap, Separate From The Dev Seed

`prisma/seed.ts` (`pnpm db:seed`) is a destructive development fixture: it unconditionally deletes nearly every row in the database before recreating Matt, Eric, and demo trades/watchlists/chat. It must never run against production.

For a brand-new production database's one-time initial setup, `prisma/bootstrap-production.ts` (`pnpm bootstrap:production`, logic in `src/lib/bootstrap.ts`) instead only creates the two initial users (`matt@lst.local`, `eric@lst.local`, using `DEV_SEED_PASSWORD` for their initial password) and their shared conversation if they do not already exist — it never deletes, resets, or overwrites existing users, passwords, or any other data, and is safe to run repeatedly.

## 2026-08-28: Hostinger Production Build Does Not Run Migrations Or Bootstrap

The permanent Hostinger production build is `prisma generate && next build`.

During the first production deployment, the build script was temporarily changed several times to run `prisma migrate deploy` and then `pnpm bootstrap:production` (or `tsx prisma/bootstrap-production.ts` directly) so the brand-new Supabase database could be migrated and bootstrapped in one deploy. Two real Hostinger environment limitations were discovered in the process:

- `prisma migrate deploy` fails inside the Hostinger build environment with `schema-engine-debian-openssl-1.1.x EACCES`.
- Hostinger's build shell does not support nested `pnpm run ...` invocations from within a package script (only the top-level `pnpm run build` works); a script must exec binaries like `tsx` directly instead.

Once the first deployment's bootstrap succeeded and Matt/Eric login was verified against Supabase, the build script was reverted to the permanent form above. Prisma migrations are intentionally **not** run automatically during the Hostinger build going forward — see `docs/ARCHITECTURE.md` (Deployment) and `docs/ROADMAP.md` (Phase 2 infrastructure) for the resulting migration policy and the still-undesigned controlled migration process.
