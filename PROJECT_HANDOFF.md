# PROJECT_HANDOFF.md

This is the **canonical single source of truth** for the current state of Off Shift Options. It is not a diary — obsolete information is replaced or removed, not appended to. When repository state and this file disagree, investigate which is correct and fix this file.

---

# AI CONTINUITY RULES

1. Read this entire file before making project changes.
2. When Matt explicitly says **"Read PROJECT_HANDOFF.md"**: read this entire file, read `AGENTS.md` and `CLAUDE.md`, and inspect enough of the actual repository to confirm this file still matches reality.
3. If the project is understandable and no critical blocker requires Matt's input, respond with **only**: `Ready.` Do not summarize this file, do not recap the project, do not list next steps, do not explain what you read.
4. If there is a genuine contradiction, missing critical information, security concern, unresolved merge state, broken repository state, or other issue that makes it unsafe to begin work, do not say `Ready.` — give the shortest possible explanation of the blocker instead.
5. This `Ready.` behavior applies only to the explicit "Read PROJECT_HANDOFF.md" command. It does not mean saying "Ready." every time this file is edited during normal work.
6. Inspect actual repository state before relying on documentation — this file can go stale.
7. **Updating this file is part of the definition of done for every meaningful project change.** Matt should never have to ask. Before finishing a task, check whether it changed: application behavior, architecture, database/schema, authentication, authorization, deployment, environment variable requirements, hosting, domain configuration, external integrations, scanner functionality, market-data behavior, Schwab integration, security, PWA behavior, chat, notifications, production status, known issues, technical debt, test status, important project decisions, project phase, immediate next step, or the Git/deployment workflow. If yes, update this file before finishing. Minor typo-only/cosmetic changes don't require it.
8. Do not turn this file into an append-only diary. Remove stale information and replace it with current truth. Keep only the history that actually matters to a future developer/AI; Git has the rest.
9. Never put secrets, passwords, API keys, OAuth secrets, access/refresh tokens, session secrets, VAPID private keys, database connection strings, or other credentials in this file. Document environment variable **names** and purposes only.
10. Do not silently reverse the architectural decisions recorded below. If a requested change conflicts with one, explain the conflict before making a major reversal.
11. Never run destructive production database operations (`prisma migrate reset`, `db:reset`, the destructive `prisma/seed.ts`, anything using `deleteMany` as a reset) unless Matt explicitly understands and authorizes exactly what data would be lost.
12. **Database schema changes require special care.** Hostinger cannot reliably run `prisma migrate deploy` in production (see Production/Deployment). Never assume pushing a migration to `main` applies it. Do not push application code that depends on a new migration until that migration has been applied to Supabase and verified out-of-band, per the workflow in Production/Deployment.
13. Keep brokerage integration read-only. Never implement automated order submission merely because an API supports it, unless Matt explicitly authorizes changing that requirement.
14. **Do not blindly implement Matt's requested technical approach if a clearly better, safer, more secure, more maintainable, or more conventional solution exists.** Evaluate significant requests for security, data safety, maintainability, production reliability, deployment compatibility, privacy, and standard best practices. If there's a better approach, explain it and recommend it before implementing the weaker one. Default to the safer/better implementation unless Matt explicitly says he understands the tradeoffs and wants the original approach anyway.
15. Proactively protect against: committed secrets, insecure authentication, weak authorization, IDOR/cross-user access, destructive database operations, accidental production data loss, unsafe API credential handling, client-side exposure of private keys/tokens, insecure OAuth redirects/callbacks, weak session handling, missing input validation, unsafe file uploads, insecure dependency use, fragile deployment shortcuts, dev/production environment confusion, hard-coded production URLs/secrets, unnecessary public exposure of services, overcomplicated infrastructure, misleading financial data, and accidental trading/order execution.
16. Security-sensitive changes (authentication, authorization, database access, financial data, OAuth, brokerage APIs, deployment secrets, production infrastructure) require an explicit focused security review of the affected code before the task is done.
17. If a secret is ever found committed to Git, do not just delete it. Report the exposure (file, type, whether it's in history) and recommend proper credential rotation.
18. Never assume hiding a UI element provides authorization — authorization must be enforced server-side.
19. Never claim mock, cached, stale, demo, or manual financial information is live/current market data.

---

## Project Identity

- **Product name:** Off Shift Options
- **Users:** Private two-user application — Matt and Eric. No public signup exists or is planned.
- **Purpose:** A mobile-friendly app for two firefighter friends to run a disciplined, low-stress cash-secured-put options workflow: track trades/positions, scan candidates against personal criteria, share recommendations, chat, and build toward additional family income and long-term financial flexibility (including reduced dependence on firefighting work if health/life circumstances make that desirable).
- **This is NOT:** a brokerage, a public trading platform, a financial advisory service, or an automated trading bot.

## Core Product Principles

- Mobile-first, installable PWA; desktop should still work well (especially scanner/table views).
- Simple, low-stress workflow; financial information should be understandable, not unnecessarily technical.
- `PRIVATE` data stays private to its owner; `SHARED` data is visible to both Matt and Eric per the authorization rules in `src/lib/privacy.ts`.
- Never fabricate live financial information. Demo/manual/mock data must always be visibly labeled as such.
- Future brokerage/market integration begins **read-only**. No order submission, no buy/sell, no account-changing brokerage actions, unless Matt explicitly changes this architecture later.
- Strong security and safe defaults are preferred over convenience shortcuts.
- When a better technical solution exists, recommend it rather than blindly following an inferior implementation request.

---

## Current Production Architecture

Verified from repository state (`package.json`, `Dockerfile`, `next.config.ts`):

| Layer | Current version/tool |
|---|---|
| Framework | Next.js 16.3.3, App Router, Turbopack |
| Language | TypeScript (strict), React 19.2.8 |
| ORM | Prisma 7.10.0 with `@prisma/adapter-pg` (`pg` 8.x driver) |
| Database | PostgreSQL — Supabase in production, `postgres:17-alpine` via Docker Compose locally |
| Styling | Tailwind CSS 4 |
| Package manager | pnpm 11.24.0 (via Corepack) |
| Testing | Vitest 4.1.11 (unit + opt-in DB integration), Playwright 1.62.1 (e2e) |
| Hosting | Hostinger managed Node.js hosting |
| Local containers | Docker Compose (`compose.yaml`) — `db` (Postgres) + `app` (Node 24 Alpine, see `Dockerfile`) |
| GitHub | https://github.com/matthewtmonk-dot/offshiftoptions.git, branch `main` |
| Production domain | https://offshiftoptions.com — connected and live (externally confirmed; see Hosting/Domain section) |

**Hostinger's actual configured Node.js version is externally managed** (Hostinger control panel) and not verifiable from this repository — there is no `.nvmrc`/`engines` field pinning it. The Docker image and local dev use Node 24.

---

## Production / Deployment

> **⚠ DATABASE SCHEMA CHANGES REQUIRE SPECIAL CARE.** Hostinger auto-deploys every push to `main`, but its managed Node environment cannot reliably execute Prisma's schema engine, so it does **not** apply migrations during deployment (see Migration strategy below). **Never push code to `main` that depends on a new migration until that migration has been applied to Supabase and verified**, per the workflow below. Never run `prisma migrate reset`, the destructive `prisma/seed.ts`, or any other destructive reset against production.

**Deployment model:**

```
GitHub main → Hostinger auto-deploy → Next.js app → Supabase PostgreSQL
```

- **Current permanent build command** (`package.json` → `"build"`): `prisma generate && next build` — confirmed as of the latest commit. It does **not** run `prisma migrate deploy`, does **not** seed, and does **not** bootstrap users. Every push to `main` triggers a Hostinger deploy.
- **Health endpoint:** `GET /api/health` → `{ app, database, latencyMs, checkedAt }` (200) or `{ app: "ok", database: "error", checkedAt }` (503). Never returns the raw database error message or connection details to the caller (logged server-side only).
- **Migration strategy (current, permanent):** Migrations are **not** run automatically by the Hostinger build. Root cause: `prisma migrate deploy` fails inside Hostinger's build environment with `schema-engine-debian-openssl-1.1.x EACCES` when it tries to *execute* the schema-engine binary as a subprocess (note: `prisma generate` succeeds — it doesn't need to execute that binary, only reference it). This points to Hostinger's managed environment restricting execution of arbitrary spawned binaries, not a missing `chmod +x` — a chmod fix was deliberately not attempted. Hostinger's build shell also does not support nested `pnpm run ...` calls from inside a package script.

  **Required workflow for any future schema migration:**
  1. Create/update the migration locally as usual (`pnpm db:migrate` against local Docker Postgres).
  2. Before pushing the schema-changing commit to `main` (a push deploys to Hostinger), apply it to Supabase from a machine that can actually execute the schema engine — a local dev machine or a CI runner both work:
     ```bash
     DATABASE_URL="<supabase-connection-string>" pnpm prisma migrate deploy
     ```
     Never hardcode or commit the Supabase `DATABASE_URL`.
  3. Verify it applied (check `_prisma_migrations` in Supabase, or `/api/health` after the next deploy).
  4. Only then push the code that depends on the new schema.

  Automating step 2 in CI is a reasonable future improvement (see Next Tasks), not yet built.

- **Known historical workaround (resolved, no longer present):** During the very first production deployment, the build script was temporarily changed several times (adding `prisma migrate deploy`, then a bootstrap step, then bypassing the migration engine, then calling `tsx prisma/bootstrap-production.ts` directly) to get Matt/Eric created against the brand-new Supabase database. All of that was reverted once the one-time bootstrap succeeded. **The current `build` script has none of this — verified directly against `package.json`.**

---

## Database / Seed / Bootstrap Safety

**This distinction is critical and must never be blurred:**

- **`prisma/seed.ts`** (`pnpm db:seed`) — **DESTRUCTIVE, development/demo only.** Its `resetDatabase()` unconditionally `deleteMany()`s nearly every table (users, sessions, trades, watchlists, chat, notifications, scanner profiles, etc.) before recreating demo data for Matt and Eric. **Must never run against Supabase/production.** There is no safeguard in the script itself preventing this other than discipline — never wire it into any production script or CI path.
- **`prisma/bootstrap-production.ts`** (`pnpm bootstrap:production`, logic in `src/lib/bootstrap.ts`) — **safe, non-destructive, idempotent.** Creates Matt (`matt@lst.local`) and Eric (`eric@lst.local`) only if a user with that email doesn't already exist, using `DEV_SEED_PASSWORD` for the initial password (only set at creation time — never overwrites an existing password), and creates their shared private conversation only if one doesn't already exist. It never deletes, resets, or overwrites existing users or any other data. Proven by DB-integration tests (`src/lib/bootstrap.integration.test.ts`): first run creates both users + conversation; a second run creates nothing new, doesn't touch the password, and doesn't delete unrelated data added in between.
- **Current status:** The initial production bootstrap has already run successfully against Supabase — Matt and Eric accounts exist in production and login has been verified. **`bootstrap:production` is not part of the routine build** and should not run on every deployment; it now exists mainly as a disaster-recovery/reference tool (e.g., manually re-run only if a brand-new empty production database is ever provisioned again).

**Never run against production:** `prisma migrate reset`, `db:reset`, `pnpm db:seed`, or any ad hoc `deleteMany`-based reset logic — unless Matt explicitly understands and authorizes exactly what data would be lost. If any AI is ever asked to run a destructive database command, it must first explain exactly what data would be lost and get explicit confirmation.

---

## Environment Variables / Secrets

Names and purposes only — **never values**.

**PRODUCTION REQUIRED**
- `DATABASE_URL` — Supabase Postgres connection string.
- `LST_SESSION_SECRET` — HMAC key used to hash session tokens before storing/looking them up (name predates the "Off Shift Options" rebrand; not yet renamed — see Known Issues).
- `NEXT_PUBLIC_APP_URL` — used for `metadataBase` (canonical/Open Graph URL resolution). Already set in Hostinger to `https://offshiftoptions.com`, with a redeployment completed afterward (externally confirmed; not independently verifiable from this repo).

**DEVELOPMENT ONLY**
- `DEV_SEED_PASSWORD` — initial password used by `prisma/seed.ts` and (only for user creation) `prisma/bootstrap-production.ts`. Was required once in Hostinger's env for the one-time production bootstrap; not needed for routine deploys now that Matt/Eric already exist.
- `RUN_DB_TESTS` — set to `1` to opt into the Vitest DB-integration suites (skipped otherwise).
- `PLAYWRIGHT_BASE_URL` — overrides the Playwright base URL (defaults to `http://127.0.0.1:3000`).
- `NODE_ENV` — managed by Next.js itself (`next dev` forces development, `next build`/`next start` force production); not something to set manually.

**FUTURE SCHWAB** (not yet used anywhere in code — names not finalized)
- A Schwab OAuth client ID / client secret / redirect URI, and encrypted-at-rest token storage. None of this exists yet. When added: server-side only, never in client bundles, never committed, never placed in this file.

**FUTURE WEB PUSH** (not yet used anywhere in code)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — required once real Web Push delivery is implemented (see Known Issues / PWA section). Private key must stay server-only.

**Secrets scan result:** Tracked files were checked for common secret patterns (API keys, private key blocks, tokens, credential-bearing connection strings). No real secrets found. `compose.yaml` and `.env.example` contain only hardcoded **local Docker dev** placeholder credentials (`lst_buddy` / `lst_buddy_dev`, pointing at `db:5432`/`localhost:5432`), which is the intended, safe convention for local development — not a production credential. No `.env` file is tracked (only `.env.example`).

---

## Authentication

- Email/password authentication with database-backed sessions (`src/lib/auth.ts`).
- Passwords hashed with `bcryptjs` (cost 10) — consistently in `prisma/seed.ts`, `prisma/bootstrap-production.ts`, and `src/lib/account.ts`.
- Session cookie: HTTP-only, `SameSite=Lax`, `Secure` when `NODE_ENV === "production"` (true for the deployed Hostinger app). Session tokens are opaque random values in the cookie, HMAC-hashed (`LST_SESSION_SECRET`) before being stored/looked up — the raw token is never persisted.
- A new session token is always minted on sign-in (never reused from an existing cookie) — no session-fixation vector.
- **Password changing exists**: `/account` (`src/lib/account.ts`) lets a signed-in user change their own password — requires the correct current password, enforces minimum length (10) plus letter+number complexity, and deletes every *other* session for that user on success (keeps the current one), so a changed password immediately signs out other devices.
- **No public signup.** Only Matt and Eric exist; this remains a private two-user app.
- All authorization is enforced server-side in `src/lib/privacy.ts` (`assertCanReadRecord`, `assertCanMutateRecord`) and applied through `src/lib/workflows.ts` — the only place server actions mutate data. UI hiding is never relied on for security.
- Dev-only quick-login buttons on `/login` render only when `NODE_ENV !== "production"` — confirmed absent from a real `next build && next start` production run.

---

## Current Features

| Feature | Status | Notes |
|---|---|---|
| Dashboard | WORKING | Aggregates account snapshot, open trades, watchlist, recommendations, latest scan, recent chat. All values marked demo/manual where applicable. |
| Scanner (results) | DEMO/MOCK | `src/domain/scanner` — real PASS/FAIL/UNKNOWN evaluation engine, but against a fixed demo candidate list (CORZ/SOFI/AMD/IONQ), not live market data. Visibly labeled with a banner + DEMO badges. |
| My LST scanner settings | WORKING (per-user) | `/scanner/settings` — each user edits their own `ScannerProfile`/`ScannerRule` rows; proven isolated per-user by DB integration tests. |
| Watchlist | WORKING | Private/shared items, Pro/Con/General notes (owner-only edit), buddy comments (shared, read-access-gated). |
| Recommendations | WORKING | Send/receive between Matt and Eric, reason tags, status lifecycle (`NEW`/`WATCHING`/`PASSED`/`ARCHIVED`), participant-gated comments. |
| Buddy chat | WORKING (polling-live) | Membership-gated conversation; new messages/read-receipts appear without a manual reload via a 4s `router.refresh()` poll while the tab is visible (`src/components/live-refresh.tsx`) — not WebSockets/Realtime. |
| Notifications | WORKING (in-app only) | In-app notification model/UI/provider works. External Web Push is a documented no-op (see PWA section). |
| Trades / Positions | DEMO/MANUAL | Seeded demo CSP positions; all financial values explicitly labeled demo/manual, never presented as live. |
| Cash-secured put calculations | WORKING | `src/domain/finance/calculations.ts` — real, tested per-share vs. per-contract math (premium capture, ROR, annualized ROR, break-even, position health status). Deterministic, not dependent on live data. |
| PWA / installation | WORKING | Manifest, service worker, install prompt, real 192/512 PNG icons (any + maskable) and Apple touch icon. |
| Health endpoint | WORKING | See Deployment section. |
| Authentication | WORKING | See Authentication section. |
| Change password | WORKING | `/account`. |
| Sharing/privacy controls | WORKING | `PRIVATE`/`SHARED` visibility enforced server-side; proven by unit + DB-integration tests. |
| Schwab market/account data | BLOCKED BY EXTERNAL SERVICE | Access requested, approval pending. Nothing implemented beyond read-only provider interface placeholders. |

---

## Scanner

- Engine: `src/domain/scanner/scanner.ts` — criterion-level evaluation. Each criterion produces `PASS` / `FAIL` / `UNKNOWN` with an actual value, operator, desired value/range, and explanation. Overall result: `FAIL` if any criterion fails, else `UNKNOWN` if any is unknown, else `PASS`.
- Rule catalog: `src/domain/scanner/profile.ts` (`SCANNER_RULE_DEFINITIONS`) — stock price range, RSI, Bollinger %, DTE, absolute delta, put ROR, annualized ROR, option bid, bid/ask spread %, open interest, option volume, earnings distance, Do Not Trade filter (fixed desired value, not user-editable), debt/equity.
- Per-user settings: `/scanner/settings` edits a user's own `ScannerProfile`/`ScannerRule` rows (enable/disable + desired value(s) per rule); `@@unique([profileId, key])` prevents duplicate rule keys per profile. Verified isolated per user (Matt editing his settings never changes Eric's) by `src/lib/workflows.integration.test.ts`.
- **Data is demo/mock**: `DEMO_SCAN_CANDIDATES` in `profile.ts` is a fixed list (CORZ, SOFI, AMD, IONQ) with hand-entered values, not a live feed. This is visibly labeled in the UI (banner + per-card DEMO badge) and must stay labeled until real Schwab option-chain data replaces it.

---

## Schwab API

- **Current status: access requested, approval pending** (externally reported — not verifiable from this repo).
- No Schwab credentials, secrets, OAuth tokens, or client IDs exist anywhere in this repository.
- `src/providers/schwab/` contains only a placeholder/read-only interface boundary — no live calls implemented.
- **Architectural rule (do not violate):** read-only. Allowed future methods are read-oriented only (`getQuote`, `getPriceHistory`, `getOptionChain`, `getAccounts`, `getPositions`, `getTransactions`, `getOrders` for historical observation only). Forbidden: `placeOrder`, `submitOrder`, `replaceOrder`, `cancelOrder`, algorithmic execution, automated trading — do not add these unless Matt explicitly changes this requirement.
- When Schwab work begins, update this section continuously (approval state, app registration, callback config, OAuth/token-refresh status, available functionality, scanner integration status) without ever storing secrets here. Any Schwab client secret or token must stay server-side, never in client-side JavaScript.

---

## Hosting / Domain

- **Production domain:** https://offshiftoptions.com — connected to the Hostinger Node application and live (externally confirmed: purchased, connected, `NEXT_PUBLIC_APP_URL` updated in Hostinger to this URL, and Hostinger redeployed afterward). Not independently verifiable from this repository.
- **Hosting:** Hostinger managed Node.js hosting, deployed via GitHub auto-deploy from `main`.
- **Database:** Supabase PostgreSQL (production).
- Cookies, the service worker scope, and the PWA manifest's `start_url`/`scope` are all relative (`/`) — no hardcoded domain anywhere in the app, so no further code change was needed for the domain cutover.
- The old temporary Hostinger-provided URL is no longer the primary production URL now that `offshiftoptions.com` is connected and confirmed live.

---

## PWA / Mobile

- Manifest (`public/manifest.webmanifest`): name "Off Shift Options", short name "OSO", standalone display, theme/background colors, icons for both `any` and `maskable` purposes.
- Icons: `public/icon.svg` (scalable), `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-192.png`, `public/icon-maskable-512.png`, `public/apple-touch-icon.png` (180x180), rebranded `src/app/favicon.ico`. No remaining placeholder icons.
- Service worker (`public/sw.js`): network-first for page navigations with a cached `/login` fallback (never serves a stale authenticated/financial page offline); cache-first only for a small fixed shell asset list. Cache name is versioned (`oso-shell-v2`) so it invalidates cleanly on updates.
- Mobile navigation, touch targets, and layout verified overflow-free at 390px width across all main authenticated routes via Playwright.
- **Unfinished:** real Web Push delivery. `WebPushNotificationProvider` (`src/lib/notifications.ts`) is a documented no-op. The storage endpoint (`POST /api/push-subscriptions`) exists but nothing on the client calls it yet. HTTPS (the old blocker) is no longer the issue — completing this needs VAPID key generation/config, a `web-push` server dependency, a client subscribe flow, permission-decline handling, and a service worker `push` handler. Tracked as a Phase 2/3 task in `docs/PWA_AND_NOTIFICATIONS.md`, not started.

---

## Chat / Social

- One private conversation per Matt/Eric pair, created by the production bootstrap (or dev seed locally). No self-service "start a conversation" UI exists (not needed — there are only two users).
- Sending/reading requires active `ConversationMember` membership, enforced server-side (`src/lib/workflows.ts`); proven by a DB-integration test that a non-member's send attempt is rejected.
- Read receipts (`ChatMessageRead`) track per-user read state; unread count and "Unread"/"Read by ..." UI reflect it.
- **Live updates:** a client component polls `router.refresh()` every 4 seconds while the chat tab is visible (paused when hidden) — the simplest mechanism compatible with the existing Server Component/Server Action architecture, no WebSockets or Supabase Realtime.
- Recommendations carry their own participant-gated comments and reactions; watchlist items carry owner-only notes plus shared, read-access-gated comments.
- Notification delivery on new messages/recommendations/comments/reactions is server-side (`notifyInApp`), scoped to the correct recipient only.

---

## Security

- Server-side mutation authorization for every action, centralized in `src/lib/workflows.ts` (never trust client state or hidden UI).
- `PRIVATE`/`SHARED` visibility enforced in `src/lib/privacy.ts`; buddies can read shared records but never private ones; mutation always requires ownership except for intentionally social actions (comments/reactions/chat) which use read-access or explicit participant checks instead.
- Sessions: HTTP-only, `Secure` in production, `SameSite=Lax`, HMAC-hashed tokens, new token minted per login (no fixation).
- Password hashing: `bcryptjs`, consistent across all creation/change paths.
- Ownership enforcement covers watchlist items, notes, recommendations, chat membership, notifications, and scanner settings — each scoped to the correct owner/participant, proven by unit + DB-integration tests.
- No secrets in the client bundle — only `NEXT_PUBLIC_APP_URL` is public, and it contains no sensitive data.
- No trading/order-submission endpoints exist anywhere in the codebase.
- Input validation: server-side ticker format validation (`src/lib/tickers.ts`) backed by database `CHECK` constraints; password strength validation (`src/lib/account.ts`).
- `/api/health` never leaks database error details (see Deployment section).
- Production HTTP security headers (`next.config.ts`, applied to every route): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, `Strict-Transport-Security`, and a baseline `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`; `script-src`/`style-src` still allow `'unsafe-inline'` because Next's App Router needs it without a nonce setup — a known, accepted tradeoff, not a gap to silently "fix" by weakening the CSP further).
- **No currently known open security issues.** A full audit pass (auth, IDOR, session handling, secrets, headers, health endpoint) was completed and fixes applied — see `docs/HANDOFF.md`'s "Pre-Schwab Production Hardening" entry for the detailed findings/fixes list.

---

## Testing

Last verified (this session, against local Docker Postgres only — nothing run against Supabase):

| Check | Command | Result |
|---|---|---|
| Prisma validate | `pnpm prisma validate` | ✅ passed |
| Prisma generate | `pnpm prisma generate` | ✅ passed |
| TypeScript | `pnpm typecheck` | ✅ passed |
| ESLint | `pnpm lint` | ✅ passed, no warnings |
| Vitest unit tests | `pnpm test` | ✅ 19 passed / 10 skipped (DB tests skip without `RUN_DB_TESTS`) |
| Vitest incl. DB integration | `RUN_DB_TESTS=1 DATABASE_URL=... pnpm test` | ✅ 36/36 passed (9 files) against local Docker Postgres |
| Playwright e2e | `pnpm exec playwright test` | ✅ 5/5 passed against a rebuilt local Docker app container |
| Production build | `pnpm build` (clean, `rm -rf .next` first) | ✅ passed |
| Production-mode smoke test | `next build && PORT=3100 next start` | ✅ dev-login hidden, security headers present, icons/manifest/health correct |

DB-integration tests always use disposable test users with cleanup in `afterAll` — they never touch Matt/Eric's real seeded credentials. Nothing in this repository's test suite is designed to run against Supabase; do not point it there.

---

## Important File Map

- `PROJECT_HANDOFF.md` — this file; canonical current-state document.
- `docs/HANDOFF.md` — older chronological session-by-session log (kept for detailed history); this file is now canonical for *current* state.
- `AGENTS.md` — general agent operating instructions.
- `CLAUDE.md` — Claude-specific entry pointer to this file.
- `README.md` — human/developer-facing docs, local setup, scripts.
- `package.json` — scripts and dependencies.
- `prisma/schema.prisma` — database model.
- `prisma/migrations/` — production migrations (currently `20260828114500_init`, `20260828132500_phase_1b_hardening`).
- `prisma/seed.ts` — **destructive** development/demo seed. Never production.
- `prisma/bootstrap-production.ts` — safe production bootstrap CLI.
- `src/lib/bootstrap.ts` — safe bootstrap logic (idempotent, non-destructive).
- `src/lib/auth.ts` — authentication/session logic.
- `src/lib/account.ts` — change-password logic.
- `src/lib/privacy.ts` — `PRIVATE`/`SHARED` authorization helpers.
- `src/lib/workflows.ts` — server-side mutation/authorization logic for every server action.
- `src/domain/scanner/` — scanner engine (`scanner.ts`) and rule catalog/demo data (`profile.ts`).
- `src/domain/finance/` — financial calculations.
- `src/domain/social/` — recommendation reason tags/statuses.
- `src/components/live-refresh.tsx` — chat's polling live-update mechanism.
- `src/app/(app)/` — authenticated Next.js routes (dashboard, positions, scanner, scanner/settings, watchlist, recommendations, chat, notifications, account, install).
- `src/app/api/health/`, `src/app/api/push-subscriptions/` — API routes.
- `next.config.ts` — security headers.
- `docs/` — supporting architecture/security/decision documentation (`ARCHITECTURE.md`, `SECURITY.md`, `DECISIONS.md`, `DATA_MODEL.md`, `SCANNER_RULES.md`, `PWA_AND_NOTIFICATIONS.md`, `SCHWAB_INTEGRATION.md`, `ROADMAP.md`, `LST_DOMAIN.md`).

---

## Architectural Decisions

Future AI agents should not casually reverse these:

- Hostinger is production application hosting; Supabase is production PostgreSQL.
- Supabase's Data API is not enabled merely because Supabase offers it — Prisma over a direct Postgres connection is the only production data-access path.
- Prisma is the ORM.
- GitHub `main` drives deployment (every push auto-deploys).
- The destructive development seed (`prisma/seed.ts`) and the safe production bootstrap (`prisma/bootstrap-production.ts`) are deliberately separate and must stay that way.
- The production build never runs the bootstrap or migrations automatically (see Deployment section for why and the required manual migration workflow).
- `PRIVATE`/`SHARED` visibility is intentional, load-bearing architecture — not a cosmetic UI toggle.
- Future Schwab integration begins read-only; no automatic trading/order submission.
- The scanner must never represent mock/demo data as live.
- Mobile-first PWA remains a core requirement.
- Chat updates via simple client-side polling (`router.refresh()`), not WebSockets/Realtime — deliberately the simplest option for a two-user app.
- Watchlist Pro/Con/General notes are owner-only; buddy interaction on shared items happens through comments instead.
- Prefer secure, conventional, maintainable implementation choices; do not blindly implement a technically weaker approach when a clearly better one exists (see AI Continuity Rules above).

---

## Known Issues / Technical Debt

- **Web Push is unfinished** — documented no-op, real implementation deferred (see PWA section).
- **`LST_SESSION_SECRET` env var name predates the "Off Shift Options" rebrand.** Cosmetic only (it's an internal config key, not user-visible), but renaming it later requires coordinating the Hostinger env var change with a deploy — not urgent.
- **CSP allows `script-src`/`style-src` `'unsafe-inline'`** because Next's App Router needs it without a nonce-based setup. A stricter nonce-based CSP is a possible future hardening step, not currently required.
- **No CI-automated migration deploy** — Hostinger cannot run `prisma migrate deploy` (see the warning in Production / Deployment). The Supabase migration workflow is currently a manual runbook: apply and verify a migration against Supabase *before* pushing dependent code to `main`. Reasonable to automate in CI later; not done yet, and not to be implemented as a side effect of an unrelated task.
- **Scanner data is entirely demo/mock** until Schwab access is approved and integrated — expected, not a bug, but worth remembering it's the single biggest "not real yet" surface in the app.
- A handful of older docs (e.g. `docs/SCHWAB_INTEGRATION.md`) still say "LST Buddy" in prose; harmless, not yet swept for the rebrand since it doesn't affect any user-visible surface.

---

## Current State — Where We Left Off

- Off Shift Options is live on Hostinger, deployed via GitHub `main` auto-deploy.
- Supabase production PostgreSQL is live and reachable; `/api/health` has reported healthy.
- Production Matt/Eric accounts have been bootstrapped via the safe, non-destructive bootstrap script and login has been verified in production.
- `offshiftoptions.com` has been purchased, connected as the production domain, and confirmed live; `NEXT_PUBLIC_APP_URL` has already been updated in Hostinger to `https://offshiftoptions.com` and Hostinger redeployed afterward (externally confirmed). The old temporary Hostinger URL is no longer primary.
- Schwab Trader API Individual access has been requested; approval is still pending. No Schwab code exists yet.
- Just completed: a full pre-Schwab production hardening pass — rebrand to "Off Shift Options", real PWA icons, a self-service Change Password screen, live (polling) chat, visible demo-data labeling on the scanner, production security headers, and fixes to `/api/health` and `/api/push-subscriptions`. All changes committed and pushed to `main`; nothing was run against Supabase or Hostinger directly from this machine.
- This continuity system (`PROJECT_HANDOFF.md`, `AGENTS.md` update, `CLAUDE.md`) is being created now so any AI can resume by reading this file.
- **Nothing is currently blocked** except Schwab approval, which is external and has no ETA.

---

## Next Tasks

**NOW** (no external blocker)
- Sweep remaining "LST Buddy" prose mentions in older docs (`docs/SCHWAB_INTEGRATION.md`, etc.) for full branding consistency — cosmetic, low priority.
- Consider automating the Supabase migration-deploy step in CI instead of the manual runbook.
- Consider renaming `LST_SESSION_SECRET` to something brand-neutral (coordinate with a Hostinger env var update — not urgent).

**AFTER SCHWAB APPROVAL**
- Schwab OAuth app registration, callback configuration, token storage (server-side, encrypted at rest).
- Read-only account/position/quote/price-history integration.
- Replace demo scanner candidates with live option-chain data, keeping the same PASS/FAIL/UNKNOWN engine.
- Re-verify the "no order execution" boundary once any real brokerage code exists.

**LATER**
- Complete real Web Push delivery (VAPID keys, `web-push` dependency, client subscribe flow, service worker push handler).
- Stricter nonce-based CSP.
- Expand automated test coverage for the change-password and live-chat features with a two-context Playwright scenario, if desired.

---

## Recent Relevant Commits

- `7d847e4` — docs: document pre-Schwab production hardening
- `24158e8` — fix: make chat live, label demo scanner data, harden health/push endpoints
- `32d3578` — feat: add self-service change password screen
- `6e92f8b` — feat: rebrand to Off Shift Options with production PWA icons
- `76189b1` — chore: finalize Hostinger production build (removed temporary first-deploy workaround)
- `94355d5` — feat: add safe non-destructive production bootstrap for first deploy

Full history is in Git — this list is only enough to orient a new AI, not a complete log.
