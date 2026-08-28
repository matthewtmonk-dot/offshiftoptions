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
- `Trade` stores the strategy, owner, visibility, symbol, status, and roll-chain relationship.
- `TradeLeg` stores the historical option contract action.
- `PositionSnapshot` stores point-in-time option and underlying values used by the position card.

Rolled trades should be modeled by closing the old trade/leg and creating a new related trade. Do not overwrite historical contract truth.

## Watchlists And Notes

- `Watchlist` belongs to a user.
- `WatchlistItem` stores ticker, status, tags, owner, and visibility.
- `StockNote` stores Pro/Con/General notes.
- `Comment` can attach to recommendations, trades, or watchlist items.
- `Reaction` supports social encouragement without rewarding risk size or trade count.

## Recommendations And Chat

- `Recommendation` stores sender, recipient, ticker, message, reason tags, visibility, and status.
- `Conversation`, `ConversationMember`, `ChatMessage`, and `ChatMessageRead` support simple private/group chat.

## Notifications

- `Notification` stores in-app notifications.
- `PushSubscription` stores future Web Push subscription material.

## Scanner And Market Data

- `ScannerProfile` belongs to a user and can differ per user.
- `ScannerRule` stores configurable rule metadata.
- `ScanRun`, `ScanResult`, and `ScanCriterionResult` preserve criterion-level PASS/FAIL/UNKNOWN explanations.
- `MarketQuoteCache`, `PriceCandle`, and `OptionContractSnapshot` prepare for read-only market data ingestion.
- `BrokerConnection` stores future provider state and encrypted-token placeholders.
