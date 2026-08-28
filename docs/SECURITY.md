# Security And Privacy

## Authentication

Email/password authentication with database-backed sessions.

- Password hashes use `bcryptjs` (cost 10), consistently across sign-up-equivalent flows (`prisma/seed.ts`, `prisma/bootstrap-production.ts`, and `src/lib/account.ts`).
- Session cookies are HTTP-only, `SameSite=Lax`, and `Secure` when `NODE_ENV === "production"` (Next.js sets this automatically for `next build`/`next start`, which is how Hostinger runs the app).
- Database session tokens are opaque random values in the cookie, HMAC-hashed with `LST_SESSION_SECRET` before being stored/looked up — the raw token is never persisted.
- A new session token is always minted on successful sign-in (never reused from an existing cookie), which prevents session fixation.
- Seeded demo/bootstrap users are Matt and Eric; their initial passwords come from `DEV_SEED_PASSWORD`. There is no public signup — this remains a private two-user application.
- Authenticated users can change their own password at `/account` (`src/lib/account.ts`): requires the correct current password, enforces a minimum length plus letter+number complexity, hashes with the same `bcryptjs` settings, and deletes every other session for that user (keeping only the session that made the change) so a changed password immediately signs out other devices/browsers.
- The dev-only quick-login buttons on `/login` (`Login as Matt` / `Login as Eric`) only render when `process.env.NODE_ENV !== "production"`, so they do not appear in the deployed Hostinger build.

## Secrets

Never commit:

- `.env`
- OAuth tokens
- Schwab secrets
- VAPID private keys
- session secrets
- generated credentials
- database data

## Authorization

Authorization is enforced server-side in `src/lib/privacy.ts` and applied through `src/lib/workflows.ts`, which is the only place server actions mutate data.

- Owners can read their private and shared records.
- Buddies can read shared records.
- Buddies cannot read private records.
- Mutations require ownership (`assertCanMutateRecord`) unless the action is intentionally social on a shared record (comments, reactions, chat messages), which use `assertCanReadRecord` or explicit participant checks instead.
- Pro/Con/General watchlist notes are owner-only (mutation-gated); buddy interaction on a shared watchlist item happens through comments, which remain readable/writable by anyone who can read the item.
- Chat messages and read receipts require active `ConversationMember` membership.
- Scanner settings (`ScannerProfile`/`ScannerRule`) are always scoped to the owning user; `updateScannerSettingsForUser` only ever touches the caller's own profile.

Tests live in `src/lib/privacy.test.ts` (unit) and `src/lib/workflows.integration.test.ts` (opt-in, database-backed — see README for `RUN_DB_TESTS`).

## Input Validation

- Ticker symbols are validated server-side with `src/lib/tickers.ts` (`requireTicker`/`parseTicker`) before being persisted, and the Phase 1B hardening migration adds matching `CHECK` constraints on `WatchlistItem`, `StockNote`, `Recommendation`, `ChatMessage`, and `Activity` ticker columns as a database-level backstop.
- Server actions that can fail validation (`ValidationError`) redirect back to a safe, allow-listed return path (`src/lib/workflows.ts#safeReturnPath`) with an error message rather than throwing to the client.

## HTTP Security Headers

`next.config.ts` sets, on every route: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy` (camera/microphone/geolocation/payment all denied), `Strict-Transport-Security` (safe to send even before the custom domain is HTTPS-only, since browsers ignore HSTS received over plain HTTP), and a baseline `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, with `'unsafe-inline'` on script/style because Next.js's App Router relies on inline hydration/style data — a stricter nonce-based CSP is a future hardening step, not required now).

## Health Endpoint

`GET /api/health` reports `{ app, database, latencyMs, checkedAt }` (or `database: "error"` with a 503) without ever including the database error message, connection string, or stack trace in the response body — failures are logged server-side only (`console.error`), never returned to the caller. It is intentionally unauthenticated (used for uptime/health checks) and intentionally minimal.

## Financial Safety

The app does not place trades. It is educational/research/tracking software only.

Avoid gamification that rewards larger risk, leverage, or trade count. Reward rule-following, learning, consistency, and appropriate management.
