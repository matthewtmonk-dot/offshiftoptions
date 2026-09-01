<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# IMPORTANT — Project Continuity and Engineering Rules

Before doing meaningful work in this repository, read `PROJECT_HANDOFF.md`.

If Matt explicitly says **"Read PROJECT_HANDOFF.md"**: read it in full, read this file, and verify enough repository context to understand the current state. If there are no critical blockers, respond with only `Ready.` — no summary, no recap, no next-steps list.

`PROJECT_HANDOFF.md` is the canonical current-state document (architecture, deployment, database/seed safety, environment variables, features, security, testing, known issues, and next tasks). This `AGENTS.md` file covers general operating notes; `PROJECT_HANDOFF.md` is authoritative for project state.

**After every meaningful project change, update `PROJECT_HANDOFF.md` automatically before considering the task complete.** Matt should never need to ask. "Meaningful" includes changes to application behavior, architecture, database/schema, auth, deployment, environment variables, hosting/domain, external integrations, scanner, market-data behavior, Schwab status, security, PWA, chat, notifications, production status, known issues, technical debt, test status, or important decisions. Never put secrets into `PROJECT_HANDOFF.md` or any other tracked file.

Do not blindly implement a technically weaker approach just because Matt requested it. Evaluate significant technical requests for security, data safety, maintainability, production reliability, deployment compatibility, and standard best practices. When a clearly better solution exists, recommend and prefer it unless Matt explicitly says he understands the tradeoffs and wants the original approach anyway.

# Off Shift Options Agent Notes

Off Shift Options (formerly "LST Buddy") is a private, fun, educational trading research and tracking PWA for Matt and Eric. It helps with conservative cash-secured-put research, manual/demo tracking, watchlists, recommendations, chat, notifications, and rule-following. The "My LST" scanner profile name refers to the underlying Low Stress Trading strategy, not the app's product name.

## Absolute Product Rule

This application does not place trades. Do not add buy, sell, place order, submit order, replace order, cancel order, automated trading, or algorithmic execution methods. Schwab integration is read-only.

Schwab market data is shared application infrastructure, but brokerage account data is user-scoped. Never reuse Matt's OAuth/account authorization for Eric or let one user's balances, positions, transactions, imported records, campaigns, settings, performance, projections, or trading achievements populate or affect the other user's account.

## Stack

- Next.js App Router
- strict TypeScript
- Prisma 7 with PostgreSQL
- Tailwind CSS
- server-side cookie/database sessions
- pnpm
- Vitest
- Docker Compose

## Commands

- `pnpm dev`
- `pnpm build` (runs `prisma generate && next build` — this is also the exact Hostinger production build; it never seeds, bootstraps, or applies migrations, see `docs/ARCHITECTURE.md` Deployment)
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `RUN_DB_TESTS=1 DATABASE_URL=... pnpm test` (opt-in database integration tests)
- `pnpm test:e2e` (Playwright smoke tests against a running app)
- `pnpm db:migrate`
- `pnpm db:seed` (destructive, local development/reset data only — never run against production)
- `pnpm db:reset`
- `pnpm bootstrap:production` (safe, non-destructive, idempotent production user bootstrap — not part of routine deploys)
- `docker compose up --build`

## Coding Expectations

- Keep financial calculations isolated in `src/domain/finance` and covered by deterministic tests.
- Account/trading performance must be derived from the append-only ledger (`AccountLedgerEntry`), never from `currentBalance − startingBalance` — a deposit or withdrawal must never be mistaken for trading profit or loss. See `PROJECT_HANDOFF.md` Account Ledger section.
- A scanner criterion's default `enabled` state must come from `SCANNER_RULE_DEFINITIONS[...].defaultEnabled`, not left to the database column default — this bit us once in `prisma/seed.ts` (every rule silently defaulted to enabled).
- Brokerage import/reconciliation: never use a filename or CSV row number as economic identity — use `BrokerRecord.fingerprint` (the economic fact) and `identityKey` (the same real-world slot, without financial fields) instead. A same-identity-different-fingerprint match is a `CONFLICT`, never a silent overwrite. CampaignEvents remain the sole trading-performance source of truth even for a Campaign created from reconciled broker evidence — a Realized Gain/Loss import may only *verify* a Campaign's result, never add to it.
- Keep scanner logic in `src/domain/scanner` with PASS/FAIL/UNKNOWN per criterion.
- Enforce privacy server-side with `src/lib/privacy.ts`; never rely only on React hiding.
- Treat Phase 1 financial values as DEMO or MANUAL.
- Use record-level `Visibility` for shareable records.
- Keep UI friendly with restrained green accents; the app now supports Dark (original look, default for existing users)/Light/System appearance — see `PROJECT_HANDOFF.md` Appearance System section. Use red/green mainly for fail/pass states, consistently in both themes.
- Never use a Tailwind color-scale literal (e.g. `text-zinc-950`) for something that must stay a fixed color regardless of theme, such as dark text on a permanently-bright accent button — the Light theme remaps that same scale variable, so a "fixed" use of it silently becomes illegible. Use `text-black`/a dedicated non-remapped value instead. This bit us once (10 files fixed in the Appearance System slice).
- When running Playwright against `next dev`, use `PLAYWRIGHT_BASE_URL=http://localhost:<port>`, never `127.0.0.1` — Next's dev-mode cross-origin asset guard silently 403s JS chunks requested via the IP literal, breaking client hydration (and therefore every `onClick`-driven assertion) with no visible test failure. `playwright.config.ts`'s default already uses `localhost`.
- Update `PROJECT_HANDOFF.md` automatically after every meaningful change (see top of this file). `docs/HANDOFF.md` is an older chronological session log kept for detailed history.

## Key Docs

- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/DECISIONS.md`
- `docs/HANDOFF.md`
- `docs/SCHWAB_INTEGRATION.md`
