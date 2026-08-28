# LST Domain

LST Buddy initially supports conservative cash-secured puts.

## Strategy

The supported Phase 1 strategy is `CASH_SECURED_PUT`.

Tracked fields include:

- symbol
- contracts
- strike
- expiration
- opened/closed timestamps
- status
- premium received
- closing cost
- fees
- realized P/L
- secured capital
- return on risk
- break-even

## Statuses

Supported trade statuses:

- `OPEN`
- `CLOSED`
- `EXPIRED`
- `ASSIGNED`
- `ROLLED`

## Roll Handling

Rolling must preserve historical truth. Model a roll as:

1. Closing the original option with a closing leg or closed trade.
2. Opening a new option as a new trade/leg.
3. Linking the new trade through `rolledFromTradeId`.

Do not mutate the old contract into the new contract.

## Financial Calculations

Implemented in `src/domain/finance/calculations.ts`:

- Wilder RSI 14
- Bollinger lower/middle/upper
- BB position percentage
- BB width
- historical volatility from daily log returns
- DTE
- distance to strike in dollars and percent
- CSP break-even
- cash-secured return on risk
- annualized ROR
- percentage of maximum premium captured
- remaining premium
- bid/ask spread dollars and percent
- estimated Buy-to-Close cost

Black-Scholes or modeled option estimates are not implemented in Phase 1. Any future model must be clearly labeled as fallback/demo and never presented as live option-chain data.
