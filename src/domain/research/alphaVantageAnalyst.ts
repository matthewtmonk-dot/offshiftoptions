/**
 * Alpha Vantage OVERVIEW returns raw Strong Buy/Buy/Hold/Sell/Strong Sell analyst-rating
 * COUNTS - not a single rating. This is a simple, explicit, tested DISPLAY summary of those
 * counts. It is NOT LSEG, NOT Schwab's own rating, and NOT a proprietary OSO signal - always
 * label it "Alpha Vantage Analyst Consensus" wherever it's shown (see PROJECT_HANDOFF.md
 * Alpha Vantage API section). Existing manual LSEG fields are completely separate and untouched.
 */
export type AlphaVantageAnalystCounts = {
  strongBuy: number | null;
  buy: number | null;
  hold: number | null;
  sell: number | null;
  strongSell: number | null;
};

export type AlphaVantageConsensusLabel = "Strong Buy" | "Buy" | "Hold" | "Sell" | "Strong Sell";

export type AlphaVantageAnalystConsensus = {
  label: AlphaVantageConsensusLabel;
  totalAnalysts: number;
  score: number;
};

/**
 * Weighted-average score across the 5 buckets (StrongBuy=+2, Buy=+1, Hold=0, Sell=-1,
 * StrongSell=-2) divided by total analyst count, then bucketed by explicit thresholds. Returns
 * null when there is no analyst data at all (total count 0) - never fabricates a "Hold" for
 * missing data.
 */
export function summarizeAlphaVantageAnalystConsensus(counts: AlphaVantageAnalystCounts): AlphaVantageAnalystConsensus | null {
  const strongBuy = counts.strongBuy ?? 0;
  const buy = counts.buy ?? 0;
  const hold = counts.hold ?? 0;
  const sell = counts.sell ?? 0;
  const strongSell = counts.strongSell ?? 0;
  const totalAnalysts = strongBuy + buy + hold + sell + strongSell;

  if (totalAnalysts <= 0) {
    return null;
  }

  const score = (strongBuy * 2 + buy * 1 + sell * -1 + strongSell * -2) / totalAnalysts;
  const label: AlphaVantageConsensusLabel =
    score > 1.2 ? "Strong Buy" : score > 0.3 ? "Buy" : score >= -0.3 ? "Hold" : score >= -1.2 ? "Sell" : "Strong Sell";

  return { label, totalAnalysts, score };
}
