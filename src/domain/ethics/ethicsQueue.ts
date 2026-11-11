/**
 * Which scanned companies still need ethics research, in the order worth doing them. Pure.
 *
 * A company with no research is never offered as a pick, so the ones to research first are the ones closest to
 * being a pick: PASS, then NEAR, then names still waiting on option prices - highest score first. Anything that
 * failed the scan is left out: researching it would not change this week's picks.
 */
export type EthicsQueueInput = {
  ticker: string;
  readiness: "PASS" | "NEAR" | "NEEDS_DATA" | "FAIL";
  score: number;
  /** PASS/NEAR, or passed the stock screen and is only waiting for its option check. */
  worthALook: boolean;
  /** True when this company already has ethics research on file (any rating). */
  researched: boolean;
};

const READINESS_ORDER: Record<EthicsQueueInput["readiness"], number> = { PASS: 0, NEAR: 1, NEEDS_DATA: 2, FAIL: 3 };

/** Most the queue will ever name at once - one research batch, and one import file, stays small. */
export const ETHICS_QUEUE_LIMIT = 25;

export function ethicsResearchQueue(rows: readonly EthicsQueueInput[]): string[] {
  const seen = new Set<string>();
  return rows
    .filter((row) => row.worthALook && !row.researched)
    .sort((left, right) => READINESS_ORDER[left.readiness] - READINESS_ORDER[right.readiness] || right.score - left.score || left.ticker.localeCompare(right.ticker))
    .map((row) => row.ticker)
    .filter((ticker) => (seen.has(ticker) ? false : (seen.add(ticker), true)))
    .slice(0, ETHICS_QUEUE_LIMIT);
}

/** The request Matt pastes into a Claude chat. Categories are named so the answer matches the import format. */
export function ethicsResearchRequest(tickers: readonly string[]): string {
  return [
    "Research these companies against my Off Shift Options ethics screen and give me the import file for Research > Ethics.",
    "Categories: abortion, pornography, gambling, predatory lending, substances and marketing, donations and associations.",
    "Rate how directly each company takes part (not mere association), read primary sources first, and say how confident the evidence is.",
    `Tickers: ${tickers.join(", ")}`,
  ].join("\n");
}
