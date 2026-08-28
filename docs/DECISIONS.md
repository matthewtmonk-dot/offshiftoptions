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

## 2026-08-28: Production Build Applies Migrations, Never Seeds

`pnpm build` runs `prisma generate && prisma migrate deploy && next build` so a Hostinger/Supabase deployment applies pending migrations automatically. The production build intentionally never runs `prisma db seed`, `migrate dev`, `db push`, or `migrate reset` — seeding a production database is a deliberate, separate, one-time action.
