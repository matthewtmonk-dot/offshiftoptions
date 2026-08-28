# Schwab Read-Only Provider Placeholder

Off Shift Options may eventually connect to the Charles Schwab Individual Trader API, but the application must remain read-only.

Allowed future provider methods:

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

Future OAuth tokens must remain server-side, be encrypted at rest, and never be exposed to browser JavaScript.
