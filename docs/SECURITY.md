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

Authorization is enforced server-side.

- Owners can read their private and shared records.
- Buddies can read shared records.
- Buddies cannot read private records.
- Mutations require ownership unless the action is intentionally social on a shared record.

Tests live in `src/lib/privacy.test.ts`.

## Financial Safety

The app does not place trades. It is educational/research/tracking software only.

Avoid gamification that rewards larger risk, leverage, or trade count. Reward rule-following, learning, consistency, and appropriate management.
