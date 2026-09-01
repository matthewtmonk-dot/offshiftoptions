# Data Model

The schema is normalized around users, record visibility, CSP trades, scanner runs, and social activity.

## Identity And Privacy

- `User` supports arbitrary future users.
- `Session` stores HMAC-hashed cookie session tokens.
- `UserSettings` stores UI and notification preferences.
- `SharingPreferences` stores user defaults for private/shared categories.
- Shareable records use `Visibility` with `PRIVATE` and `SHARED`.

Server-side access checks live in `src/lib/privacy.ts`. Tests prove shared records are readable by buddies and private records are blocked symmetrically.

## Trading And Positions

- `TradingAccount` and `AccountSnapshot` support manual/demo account values.
- `AccountLedgerEntry` records starting values, deposits, withdrawals, manual adjustments, and broker snapshots; account performance must come from this ledger instead of `currentBalance - startingBalance`.
- `Trade` stores the strategy, owner, visibility, symbol, status, and roll-chain relationship.
- `TradeLeg` stores the historical option contract action.
- `PositionSnapshot` stores point-in-time option and underlying values used by the position card.
- `Campaign` and append-only `CampaignEvent` records model current CSP/wheel trade tracking. Campaign visibility may inherit from its account or override it.

Rolled trades should be modeled by closing the old trade/leg and creating a new related trade. Do not overwrite historical contract truth.

## Watchlists And Notes

- `Watchlist` belongs to a user.
- `WatchlistItem` stores ticker, status, tags, owner, and visibility.
- `StockNote` stores Pro/Con/General notes.
- `Comment` can attach to recommendations, trades, or watchlist items.
- `Reaction` supports social encouragement without rewarding risk size or trade count.

## Recommendations And Chat

- `Recommendation` stores sender, recipient, ticker, message, reason tags, visibility, and status. `RecommendationStatus` is `NEW | WATCHING | PASSED | ARCHIVED` (renamed from `DISMISSED`/`DONE` in the Phase 1B hardening migration, which converts existing rows).
- `Conversation`, `ConversationMember`, `ChatMessage`, and `ChatMessageRead` support simple private/group chat.

## Notifications

- `Notification` stores in-app notifications.
- `PushSubscription` stores future Web Push subscription material.

## Scanner And Market Data

- `ScannerProfile` belongs to a user and can differ per user.
- `ScannerRule` stores configurable rule metadata and is editable per user at `/scanner/settings`. `@@unique([profileId, key])` (added in the Phase 1B hardening migration) prevents duplicate rule keys within one profile.
- `ScanRun`, `ScanResult`, and `ScanCriterionResult` preserve criterion-level PASS/FAIL/UNKNOWN explanations.
- `MarketQuoteCache`, `PriceCandle`, and `OptionContractSnapshot` prepare for read-only market data ingestion.
- `BrokerConnection` stores read-only Schwab OAuth/provider state, encrypted access/refresh tokens, token expiry, scopes, server-only account-hash metadata, and an optional `developerCredentialId`.
- `SchwabDeveloperCredential` stores one encrypted Schwab developer app credential set per user/provider. It keeps app key/client ID ciphertext, client secret ciphertext, callback URL, validation status, and safe metadata such as last validated time. It never stores or exposes raw browser-readable secrets.
- `BrokerRecord` stores normalized broker records from live Schwab API calls and/or CSV imports. `kind` distinguishes transactions, current positions, and realized gain/loss validation rows; `sources` preserves provenance (`SCHWAB_API`, `SCHWAB_TRANSACTIONS_CSV`, `SCHWAB_POSITIONS_CSV`, `SCHWAB_GAINLOSS_CSV`); `fingerprint` plus `(userId, provider, kind)` is a DB-level unique constraint preventing duplicate imports; `identityKey` identifies "the same real-world slot" (e.g. same account+date+symbol+action) without the financial fields, so a same-identity record with different quantity/price/amount is detected as a `status: CONFLICT` row instead of silently overwriting the original; `importBatchId` traces a row back to the `BrokerImportBatch` that created it (nullable - live-synced rows have none); `linkedCampaignId` durably links a reconciled position to an OSO `Campaign` so the Dashboard counts it once, not twice; `reconciliationDismissedAt` records an explicit "skip" so a dismissed position doesn't keep reappearing in the reconciliation queue.
- `BrokerImportBatch` tracks one CSV upload's lifecycle: `exportType` (`POSITIONS`/`TRANSACTIONS`/`REALIZED_GAIN_LOSS`), `safeOriginalFilename` (sanitized, display-only - never used as economic identity), `fileFingerprint` (content hash), `status` (`PENDING_PREVIEW` -> `CONFIRMED`/`DISCARDED`), and per-classification row counts (`newCount`/`duplicateCount`/`conflictCount`/`reviewCount`/`invalidCount`). `previewPayload` holds the classified candidate rows only until confirm/discard, then is cleared - the raw uploaded file bytes are never persisted at all.
