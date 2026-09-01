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

Schwab developer app credentials are entered only through the authenticated `/account` form, validated server-side, encrypted with `SCHWAB_TOKEN_ENCRYPTION_KEY`, and stored as ciphertext in `SchwabDeveloperCredential`. The browser never receives stored secrets again after submission.

## Authorization

Authorization is enforced server-side in `src/lib/privacy.ts` and applied through `src/lib/workflows.ts`, which is the only place server actions mutate data.

- Owners can read their private and shared records.
- Buddies can read shared records.
- Buddies cannot read private records.
- Mutations require ownership (`assertCanMutateRecord`) unless the action is intentionally social on a shared record (comments, reactions, chat messages), which use `assertCanReadRecord` or explicit participant checks instead.
- Pro/Con/General watchlist notes are owner-only (mutation-gated); buddy interaction on a shared watchlist item happens through comments, which remain readable/writable by anyone who can read the item.
- Chat messages and read receipts require active `ConversationMember` membership.
- Scanner settings (`ScannerProfile`/`ScannerRule`) are always scoped to the owning user; `updateScannerSettingsForUser` only ever touches the caller's own profile.
- Schwab market data is resolved through the signed-in user's own Schwab connection first. Shared market-data fallback is disabled until Schwab's official terms/app model explicitly permit it. Personal brokerage data never falls back across users.
- Schwab account reads use `expectedUserId` token checks and `resolvePersonalBrokerProviderForUser(userId)`, so User B cannot receive User A's balances, positions, transactions, account history, account hashes, or observed orders.
- Schwab CSV import/reconciliation is scoped identically: every `broker-import.ts`/`broker-reconciliation.ts` function re-derives its `BrokerImportBatch`/`BrokerRecord` row by `(id, userId)` before acting, so User B cannot preview, confirm, discard, view, link, or skip anything belonging to User A - even with a guessed/tampered ID. Proven by `src/lib/broker-import.integration.test.ts` and `src/lib/broker-reconciliation.integration.test.ts`.

## Schwab CSV Import Security

- Uploads are capped at 5 MB and 20,000 rows; content is decoded as UTF-8 and rejected if it contains a NUL byte (rules out binary files masquerading as `.csv`); only a `.csv` extension is accepted.
- The uploaded filename is sanitized for display only (`safeOriginalFilename` on `BrokerImportBatch`) and is **never** used as economic identity - re-uploading identical content under a different filename is still fully idempotent.
- The raw uploaded file bytes are never written to disk or to the database. Only already-normalized field values (numbers, dates, short strings already extracted from specific CSV columns) are held temporarily in `BrokerImportBatch.previewPayload` until the batch is confirmed or discarded, at which point that payload is cleared (`Prisma.JsonNull`) - the persisted `BrokerRecord` rows are the only lasting result.
- Selecting/uploading a file never mutates financial history by itself - only the explicit "Confirm Import" action persists anything, and only after re-classifying against the *current* database state (not the possibly-stale preview) to close any race window.
- No imported cell value is ever rendered as HTML; all preview/reconciliation UI renders parsed, typed fields (numbers, dates, plain strings) as React text, which is auto-escaped - there is no code path that interprets an imported cell as markup or a formula.
- Account numbers are never displayed from imports beyond the same masked `...last4` convention already used for live Schwab connections; full account numbers are never logged or rendered.

Tests live in `src/lib/privacy.test.ts` (unit), `src/lib/workflows.integration.test.ts`, `src/lib/broker-connections.integration.test.ts`, `src/lib/broker-import.integration.test.ts`, and `src/lib/broker-reconciliation.integration.test.ts` (opt-in, database-backed — see README for `RUN_DB_TESTS`).

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
