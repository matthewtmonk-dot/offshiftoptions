/**
 * One-click chart links for a ticker. Pure: builds plain https URLs to TradingView's free embeddable chart page, which
 * accepts everything in the link (no account, no sign-in): ticker, dark theme, and the Bollinger Bands, RSI and volume
 * studies already switched on.
 *
 * Two views, because TradingView's own "6M" range forces 2-hour candles:
 *  - "6M": the last six months (2-hour candles).
 *  - "D": daily candles (about a year), which match the daily RSI/Bollinger numbers this scanner computes.
 *
 * Privacy: only the ticker symbol is placed in the link. The caller opens it with rel="noopener noreferrer" so the other
 * site is not told which page of this app you came from. Nothing about the account or positions is ever included.
 */

export type ChartLink = { key: "6M" | "D"; label: string; title: string; url: string };

const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const BASE = "https://s.tradingview.com/widgetembed/";
// BB and RSI, separated by the unit-separator character TradingView expects between studies.
const STUDIES = "BB@tv-basicstudies\u001FRSI@tv-basicstudies";

/** TradingView writes class shares with a dot (BRK.B), the scanner may carry a dash (BRK-B). */
export function chartSymbolFor(raw: string): string | null {
  const ticker = raw.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) return null;
  return ticker.replace(/-/g, ".");
}

function build(symbol: string, extra: Record<string, string>): string {
  const params = new URLSearchParams({
    symbol,
    theme: "dark",
    style: "1",
    studies: STUDIES,
    hidesidetoolbar: "1",
    withdateranges: "1",
    timezone: "America/New_York",
    locale: "en",
    allow_symbol_change: "0",
    ...extra,
  });
  return `${BASE}?${params.toString()}`;
}

/** The chart links for a ticker, or an empty list when the ticker does not look like a real symbol. */
export function chartLinksFor(ticker: string): ChartLink[] {
  const symbol = chartSymbolFor(ticker);
  if (!symbol) return [];
  return [
    { key: "6M", label: "6M", title: `${symbol}: last 6 months (2-hour candles) with Bollinger Bands and RSI - opens TradingView in a new tab`, url: build(symbol, { interval: "120", range: "6M" }) },
    { key: "D", label: "D", title: `${symbol}: daily candles (about a year) with Bollinger Bands and RSI - matches the scanner's numbers - opens TradingView in a new tab`, url: build(symbol, { interval: "D" }) },
  ];
}
