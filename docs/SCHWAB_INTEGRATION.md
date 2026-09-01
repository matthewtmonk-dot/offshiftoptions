# Schwab Integration

Schwab integration is implemented as a read-only foundation for OAuth, encrypted token storage, live market data, account reads, per-user developer app credentials, provider routing, and sanitized CSV normalization.

## Architectural Rule

Off Shift Options must remain read-only with respect to brokerage accounts. It must never place, submit, replace, cancel, preview, or automate trades.

Matt and Eric each own their own broker connection. Tokens, account hashes, balances, positions, transactions, and account-derived performance must never cross users. Market-data routing must prefer the signed-in user's own Schwab connection. A shared OSO market-data provider is allowed only if Schwab's current terms/app model explicitly permit it; that fallback is currently disabled because no public official allowance was found during the 2026-08-31 doc check.

## Official Schwab Docs Checked

Checked August 31, 2026 against the official Schwab Developer Portal and official Schwab API host:

- OAuth guide: `https://developer.schwab.com/user-guides/get-started/authenticate-with-oauth`
- Callback requirements: `https://developer.schwab.com/user-guides/apis-and-apps/app-callback-url-requirements`
- Refresh-vs-restart guide: `https://developer.schwab.com/user-guides/apis-and-apps/oauth-restart-vs-refresh-token`
- Individual Developer role: `https://developer.schwab.com/user-guides/individual-developer/about-individual-developer-role`
- Create an app: `https://developer.schwab.com/user-guides/apis-and-apps/create-an-app`
- Terms and Conditions: `https://developer.schwab.com/terms-and-conditions`
- Product catalog: `https://developer.schwab.com/products/trader-api--individual`
- API host paths return Schwab-owned `401 Unauthorized` without credentials, confirming the current host/path family: `https://api.schwabapi.com/...`

The public portal is an Angular app and some detailed reference content is login-gated. Search/indexed official snippets currently state that the only Schwab OAuth grant type is `authorization_code`, an Individual Developer is limited to one app, and a Schwab brokerage account is required to access Trader APIs. No official PKCE reference was found in the public docs during this pass, so the implementation uses strong signed state validation and does not send PKCE parameters.

No public official Schwab documentation found in this pass clearly permits OSO to route one user's market-data usage through another user's personal developer app/OAuth connection. The resolver therefore returns `UNAVAILABLE` with `sharedFallback: "DISABLED_POLICY_NOT_VERIFIED"` instead of guessing.

## Required Environment Variables

Server-only, never `NEXT_PUBLIC_`:

- `SCHWAB_CLIENT_ID`
- `SCHWAB_CLIENT_SECRET`
- `SCHWAB_REDIRECT_URI` - production value must be exactly `https://offshiftoptions.com/api/schwab/callback`
- `SCHWAB_TOKEN_ENCRYPTION_KEY` - 32-byte AES-GCM key, recommended format `base64:<base64-encoded-32-random-bytes>`

The same server-held encryption key is also used to encrypt per-user Schwab developer app client IDs/secrets before they are stored in `SchwabDeveloperCredential`. Stored secrets are never displayed again.

Generate the encryption key with:

```bash
node -e "console.log('base64:'+require('node:crypto').randomBytes(32).toString('base64'))"
```

## OAuth Flow

- `GET /api/schwab/connect` requires an authenticated OSO session.
- The route resolves OAuth config in this order: the signed-in user's saved Schwab developer app first, then the server-held OSO app env vars if no per-user app is configured.
- The route creates a signed, HTTP-only, SameSite=Lax OAuth state cookie tied to the current user and the selected developer credential ID, then redirects to Schwab authorization.
- `GET /api/schwab/callback` requires the same OSO user session, validates the returned state against the signed cookie, exchanges the authorization code server-side with the same developer app credentials, encrypts access/refresh tokens, and stores them on that user's `BrokerConnection`.
- OAuth callback never sends tokens to client-side JavaScript and does not log token values.
- Refresh uses Schwab's token endpoint. If refresh is rejected or unavailable, the connection is marked `EXPIRED`/reconnect-required instead of hiding the failure.

## Per-User Developer App Credentials

`/account` -> Brokerage Connections -> Schwab -> Configure developer app lets a signed-in user save or replace their own Schwab app key/client ID, client secret, and callback URL. The browser is only the entry form. The server action authenticates the user, validates input, encrypts the client ID and secret server-side, and stores only ciphertext.

The UI shows only configured state, last validation time, replace, and remove controls. It never renders the saved secret, stores it in browser storage, places it in URLs, uses `NEXT_PUBLIC_`, or logs it. Replacing/removing a developer app expires broker connections tied to that credential so stale OAuth tokens are not silently reused.

## Provider Resolution

- `resolveMarketDataProviderForUser(userId)` uses only that user's own connected Schwab OAuth/token. It wraps market-data methods in a provider-keyed cache so repeated quote/history/chain/instrument/hour calls are reused safely within one provider without sharing broker state.
- Shared OSO market-data fallback is intentionally disabled until explicit Schwab policy confirmation exists.
- `resolvePersonalBrokerProviderForUser(userId)` uses only that user's own Schwab brokerage authorization. It never falls back to another user's connection for balances, positions, transactions, account history, account hashes, or observed orders.

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
- `src/providers/schwab/developer-credentials.ts` - encrypted per-user developer app storage and OAuth config resolution.
- `src/providers/schwab/market-data.ts` - `SchwabMarketDataProvider`.
- `src/providers/schwab/broker-read.ts` - `SchwabBrokerReadProvider` foundation.
- `src/providers/schwab/normalizers.ts` - defensive Schwab response normalization into OSO provider types.
- `src/providers/schwab/csv.ts` - sanitized CSV export normalization, deterministic fingerprints, provenance, dedupe, and reconciliation helpers.
- `src/providers/market-data/cache.ts` - provider-level market-data cache/in-flight coalescing.

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

The next scanner slice should replace the starter universe with a broader curated list and add batching/rate-limit backoff before expanding scan scale. The current provider-level cache is deliberately simple and avoids hardcoded undocumented Schwab rate limits.

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

## CSV Export Normalization

**Verified against real Schwab exports on 2026-08-31.** Matt provided the actual content of one real Positions export, one real Transactions export, and one real Realized Gain/Loss export directly (never saved to this Git workspace or repository - only sanitized, fake-ticker fixtures are committed, under `src/providers/schwab/__fixtures__/`). The existing parser's header sets, preamble/title-row handling, quoting, date formats (including the `"MM/DD/YYYY as of MM/DD/YYYY"` settlement-date variant on cash rows like Bank Interest), currency formatting, and option-symbol format all matched the real files exactly - **no parser logic changes were needed**, only expanding the fixtures from 2 to 3 positions/7 transactions to mirror the real files' row counts more closely.

- **Positions export**: current account/position snapshot, e.g. `"Positions for account <name> ...<last4> as of <time> ET, <date>"` title row, then a header row (`Symbol, Description, Qty (Quantity), Price, ..., Asset Type`), then one row per holding plus `Cash & Cash Investments` and `Positions Total` summary rows (skipped, never treated as a position). Cash/total rows are ignored; option display symbols (e.g. `TICKER 09/04/2026 17.50 P`) are normalized to OCC-style symbols (e.g. `TICKER 260904P00017500`) so API and CSV current positions can merge into one current representation with both sources retained.
- **Transactions export**: primary historical economic activity source - `Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount`. Real observed actions include `Sell to Open`, `Buy to Close`, `Bank Interest`, `Security Transfer` (see `src/domain/finance/brokerTransactionActions.ts` for the full classified vocabulary and `UNKNOWN` fallback). Cash-only rows (interest, transfers) have no `Symbol`/`Quantity`/`Price`.
- **Realized gain/loss export**: reconciliation/validation source only - a title row, then a wide header (`Symbol, Name, Closed Date, Opened Date, Quantity, Proceeds Per Share, Cost Per Share, Proceeds, Cost Basis (CB), Gain/Loss ($), ..., Wash Sale?, ...`), then one row per closed tax lot. Realized gain/loss is preserved in metadata with `economicEffect: "RECONCILIATION_ONLY"` and is never emitted as a second cash-flow amount.

`BrokerRecord` is the persistence target for normalized broker records (API or CSV). `BrokerImportBatch` tracks one CSV upload's lifecycle (`PENDING_PREVIEW` -> `CONFIRMED`/`DISCARDED`) and row-count breakdown. See "Import Schwab Data" and "Broker Activity Awaiting Review" in `PROJECT_HANDOFF.md`'s Schwab API section for the full upload -> preview -> confirm -> reconcile -> link-to-Campaign workflow, which is implemented and browser-verified end-to-end.
