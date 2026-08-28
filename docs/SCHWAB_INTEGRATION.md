# Schwab Integration

Schwab integration is not active in Phase 1.

## Architectural Rule

LST Buddy must remain read-only with respect to brokerage accounts. It must never place, submit, replace, cancel, or automate trades.

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

## Forbidden Methods

Do not add:

- `placeOrder`
- `submitOrder`
- `replaceOrder`
- `cancelOrder`
- algorithmic execution
- automated trading

## Future OAuth Requirements

Future Schwab OAuth tokens must:

- remain server-side
- never enter browser JavaScript
- be encrypted at rest
- refresh securely
- be scoped to read-oriented access
