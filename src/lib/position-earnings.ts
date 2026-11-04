import "server-only";

import { buildPositionEarningsNote, type PositionEarningsNote } from "@/domain/finance/positionEarningsWarning";
import { EARNINGS_SCANNER_TRUST_WINDOW_MS, getEarningsEvidenceLookup } from "./earnings-calendar-cache";

export type PositionEarningsInput = {
  campaignId: string;
  ticker: string;
  legType: "PUT" | "CALL" | null;
  expiration: Date | null;
  /** True when the position review is currently suggesting a roll for this position. */
  rollSuggested: boolean;
};

/**
 * Earnings notes for open positions, from the cached earnings calendar only (no provider call). If the lookup fails the
 * map is empty and the rows simply show no note - a missing warning must never break the Dashboard or Tracker.
 */
export async function getPositionEarningsNotes(rows: PositionEarningsInput[], now: Date = new Date()): Promise<Map<string, PositionEarningsNote>> {
  if (rows.length === 0) return new Map();
  try {
    const evidence = await getEarningsEvidenceLookup(rows.map((row) => row.ticker), now, EARNINGS_SCANNER_TRUST_WINDOW_MS);
    return new Map(
      rows.map((row) => [
        row.campaignId,
        buildPositionEarningsNote({ legType: row.legType, expiration: row.expiration, evidence: evidence.get(row.ticker.trim().toUpperCase()), now, rollSuggested: row.rollSuggested }),
      ]),
    );
  } catch {
    return new Map();
  }
}
