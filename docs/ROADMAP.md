# Roadmap

## Phase 1

Local foundation, authentication, database, demo/manual scanner, watchlists, trades, PWA shell, chat, recommendations, in-app notifications, privacy, and tests.

## Phase 2

Schwab developer setup, OAuth, read-only account integration, read-only positions, quotes, and price history.

**Infrastructure task:** Design a controlled process for applying future production schema migrations. Hostinger's build environment cannot run `prisma migrate deploy` directly (see `docs/ARCHITECTURE.md` — Deployment, and `docs/DECISIONS.md`), so migrations currently cannot be applied automatically during deployment. This is not yet designed; it needs a deliberate, separate step run before a Hostinger deploy that has a schema change.

## Phase 3

Live option-chain integration, live LST scanner, Greeks/liquidity analysis, and earnings integration.

## Phase 4

Position monitoring, closing/rolling analysis, alerts, and historical synchronization.

Closing/rolling analysis is informational only. Orders are still executed outside LST Buddy.

## Phase 5

Web Push, social polish, analytics, achievements, and mobile/PWA polish.

## Phase 6

HTTPS deployment, backups, production database, security hardening, and monitoring.
