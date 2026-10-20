/**
 * Outbound links to TradingView's own chart page for a ticker - plain navigation to the user's own
 * (already signed-in) TradingView, so no API key, no embedded third-party script and no change to this
 * app's Content-Security-Policy. The app never sends anything but the public ticker symbol.
 *
 * `interval` is TradingView's candle size on the chart page: "D" daily, "W" weekly, or minutes ("30").
 * The visible date range (6M / 1Y / 5Y) is not set from the link - it is whatever the user's TradingView
 * shows, and TradingView's own range buttons change it in one click.
 */
export type TradingViewInterval = "D" | "W" | "30";

export const TRADINGVIEW_CHART_LINKS: { interval: TradingViewInterval; label: string; title: string }[] = [
  { interval: "D", label: "Daily", title: "Daily candles - use the 6M / 1Y buttons on the chart to zoom" },
  { interval: "30", label: "30 min", title: "30-minute candles - the day-to-day action" },
  { interval: "W", label: "Weekly", title: "Weekly candles - the longer 1-2 year picture" },
];

const SAFE_TICKER = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

/** null when the ticker isn't a plain symbol (so nothing odd is ever placed in a URL). */
export function tradingViewChartUrl(ticker: string, interval: TradingViewInterval = "D"): string | null {
  const symbol = ticker.trim().toUpperCase();
  if (!SAFE_TICKER.test(symbol)) return null;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}&interval=${interval}`;
}
