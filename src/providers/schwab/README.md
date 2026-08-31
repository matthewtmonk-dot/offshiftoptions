# Schwab Read-Only Providers

Off Shift Options connects to the Charles Schwab Trader API in read-only mode only. OAuth, token refresh, encrypted token storage, market data, and broker-read foundations live behind provider interfaces; pages should not call Schwab directly.

Allowed provider methods:

- `getQuote(symbol)`
- `getPriceHistory(symbol, ...)`
- `getOptionChain(symbol, ...)`
- `getInstrument(symbol)`
- `getMarketHours(...)`
- `getAccounts()`
- `getAccount(accountId)`
- `getPositions(accountId)`
- `getTransactions(accountId, ...)`
- `getOrders(accountId, ...)` for observation/history only

Forbidden methods:

- `placeOrder`
- `submitOrder`
- `replaceOrder`
- `cancelOrder`
- automated trading or algorithmic execution

OAuth tokens remain server-side, are encrypted at rest with `SCHWAB_TOKEN_ENCRYPTION_KEY`, and are never exposed to browser JavaScript. Brokerage account data is user-scoped; the shared scanner can use a Schwab market-data provider without exposing another user's tokens, account hashes, balances, positions, or transactions.
