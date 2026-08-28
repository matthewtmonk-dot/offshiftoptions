# Security And Privacy

## Authentication

Phase 1 uses email/password authentication with database-backed sessions.

- Password hashes use `bcryptjs`.
- Session cookies are HTTP-only and same-site lax.
- Database session tokens are HMAC-hashed with `LST_SESSION_SECRET`.
- Seeded demo users are Matt and Eric.
- Development passwords come from `DEV_SEED_PASSWORD`.

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

## Financial Safety

The app does not place trades. It is educational/research/tracking software only.

Avoid gamification that rewards larger risk, leverage, or trade count. Reward rule-following, learning, consistency, and appropriate management.
