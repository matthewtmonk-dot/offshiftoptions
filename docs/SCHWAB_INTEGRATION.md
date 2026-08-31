# Schwab Integration

Schwab integration is now implemented as a read-only foundation for OAuth, encrypted token storage, live market data, and future account reads. Production still needs Hostinger environment variables before OAuth can succeed.

## Architectural Rule

Off Shift Options must remain read-only with respect to brokerage accounts. It must never place, submit, replace, cancel, preview, or automate trades.

Matt and Eric each own their own broker connection. Tokens, account hashes, balances, positions, transactions, and account-derived performance must never cross users. Shared market data can power scanner/research, but brokerage account data remains user-scoped.

## Official Schwab Docs Checked

Checked August 31, 2026 against the official Schwab Developer Portal and official Schwab API host:

- OAuth guide: `https://developer.schwab.com/user-guides/get-started/authenticate-with-oauth`
- Callback requirements: `https://developer.schwab.com/user-guides/apis-and-apps/app-callback-url-requirements`
- Refresh-vs-restart guide: `https://developer.schwab.com/user-guides/apis-and-apps/oauth-restart-vs-refresh-token`
- Product catalog: `https://developer.schwab.com/products/trader-api--individual`
- API host paths return Schwab-owned `401 Unauthorized` without credentials, confirming the current host/path family: `https://api.schwabapi.com/...`

The public portal is an Angular app and some detailed reference content is login-gated. Search/indexed official snippets currently state that the only Schwab OAuth grant type is `authorization_code`, and the refresh guide says token lifetime is returned in the `expires_in` field. No official PKCE reference was found in the public docs during this pass, so the implementation uses strong signed state validation and does not send PKCE parameters.

## Required Environment Variables

Server-only, never `NEXT_PUBLIC_`:

- `SCHWAB_CLIENT_ID`
- `SCHWAB_CLIENT_SECRET`
- `SCHWAB_REDIRECT_URI` - production value must be exactly `https://offshiftoptions.com/api/schwab/callback`
- `SCHWAB_TOKEN_ENCRYPTION_KEY` - 32-byte AES-GCM key, recommended format `base64:<base64-encoded-32-random-bytes>`

Generate the encryption key with:

```bash
node -e "console.log('base64:'+require('node:crypto').randomBytes(32).toString('base64'))"
```

## OAuth Flow

- `GET /api/schwab/connect` requires an authenticated OSO session.
- The route verifies Schwab env configuration, creates a signed, HTTP-only, SameSite=Lax OAuth state cookie, and redirects to Schwab authorization.
- `GET /api/schwab/callback` requires the same OSO user session, validates the returned state against the signed cookie, exchanges the authorization code server-side, encrypts access/refresh tokens, and stores them on that user's `BrokerConnection`.
- OAuth callback never sends tokens to client-side JavaScript and does not log token values.
- Refresh uses Schwab's token endpoint. If refresh is rejected or unavailable, the connection is marked `EXPIRED`/reconnect-required instead of hiding the failure.

## Allowed Future Reads

Market data provider methods:

- `getQuote(symbol)`
- `getPriceHistory(symbol, ...)`
- `getOptionChain(symbol, ...)`
- `getInstrument(symbol)`
- `getMarketHours(...)`

Broker read provider methods:

- `getAccounts()`
- `getAccount(accountId)`
- `getPositions(accountId)`
- `getTransactions(accountId, ...)`
- `getOrders(accountId, ...)`

`getOrders` is for historical/account observation only.

## Implemented Provider Files

- `src/providers/schwab/config.ts` - server-only Schwab hosts/env checks.
- `src/providers/schwab/oauth-state.ts` - signed OAuth state cookie helpers.
- `src/providers/schwab/crypto.ts` - AES-256-GCM token encryption.
- `src/providers/schwab/tokens.ts` - authorization-code exchange, refresh, encrypted storage, account-number/hash discovery.
- `src/providers/schwab/market-data.ts` - `SchwabMarketDataProvider`.
- `src/providers/schwab/broker-read.ts` - `SchwabBrokerReadProvider` foundation.
- `src/providers/schwab/normalizers.ts` - defensive Schwab response normalization into OSO provider types.

## Live Scanner Strategy

The first live scanner path is deliberately controlled:

1. Start from a small starter universe (`STARTER_LIVE_SCAN_UNIVERSE`, currently the existing deterministic demo tickers).
2. Fetch quote and daily history for each ticker.
3. Calculate OSO-owned technical values such as Wilder RSI and Bollinger position.
4. Shortlist by inexpensive stock-stage rules.
5. Fetch option chains only for the shortlist, capped at 8 option-chain calls per scan.
6. Normalize puts into OSO values: bid, ask, mark/midpoint, expiration, DTE, strike, delta, open interest, volume, spread %, distance OTM, ROR, annualized ROR.
7. Evaluate the existing PASS/FAIL/UNKNOWN scanner rules.

If live Schwab calls fail, the live scan action returns `LIVE DATA UNAVAILABLE` and does not create a demo scan. The existing demo scanner remains available for deterministic QA.

The next scanner slice should replace the starter universe with a broader curated list and add batching/rate-limit backoff before expanding scan scale.

## Forbidden Methods

Do not add:

- `placeOrder`
- `submitOrder`
- `replaceOrder`
- `cancelOrder`
- `previewOrder`
- algorithmic execution
- automated trading

## Account Read Foundation

`SchwabBrokerReadProvider` can read account summaries, positions, transactions, and historical/observed orders for the signed-in user's own Schwab connection. It does not reconcile, merge, or overwrite OSO Campaign history. A later reconciliation workflow should compare Schwab records to OSO Campaigns and ask the user to confirm matches.

No Prisma migration was needed for this slice; the existing `BrokerConnection` model already had provider/status/token/metadata fields.
