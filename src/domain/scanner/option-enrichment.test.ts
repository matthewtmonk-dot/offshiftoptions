import { describe, expect, it } from "vitest";
import {
  isNotOptionAssessed,
  notEnrichedScanNote,
  notOptionAssessedLabel,
  scannerRowReasons,
  NOT_OPTION_ASSESSED_BADGE,
} from "./option-enrichment";

/** The exact per-criterion phrases the Scanner UI shows for a genuinely unknown option input -
 * the wording this slice exists to keep OFF never-assessed rows. */
const OPTION_UNKNOWN_PHRASES = ["Option bid unavailable", "Open interest unavailable", "Put ROR is unknown"];

describe("option enrichment state", () => {
  it.each(["NOT_ENRICHED_BUDGET", "NOT_ENRICHED_STOCK_FILTER", "NOT_ENRICHED_DATA_UNAVAILABLE"] as const)(
    "treats %s as never assessed",
    (state) => {
      expect(isNotOptionAssessed(state)).toBe(true);
      expect(notOptionAssessedLabel(state, 8)).not.toBeNull();
    },
  );

  it("treats an enriched row - including one whose chain request failed - as assessed", () => {
    expect(isNotOptionAssessed("ENRICHED")).toBe(false);
    expect(notOptionAssessedLabel("ENRICHED", 8)).toBeNull();
  });

  it.each([null, undefined, "", "SOMETHING_ELSE", 7])(
    "never relabels a row whose run predates the field (%p) - it keeps its existing display",
    (state) => {
      expect(isNotOptionAssessed(state)).toBe(false);
      expect(notOptionAssessedLabel(state, 8)).toBeNull();
    },
  );

  it("distinguishes a budget loss from a stock-screen disqualification in both UI and persisted wording", () => {
    expect(notOptionAssessedLabel("NOT_ENRICHED_BUDGET", 8)).toBe("Options not checked — outside top-8 enrichment budget");
    expect(notOptionAssessedLabel("NOT_ENRICHED_STOCK_FILTER", 8)).toBe("Options not checked — stock screen did not qualify");
    // A stock-screen exclusion must never claim it ran out of budget - it never competed at all.
    expect(notOptionAssessedLabel("NOT_ENRICHED_STOCK_FILTER", 8)).not.toContain("budget");
    expect(notEnrichedScanNote("NOT_ENRICHED_STOCK_FILTER", 8)).not.toContain("budget");
    expect(notEnrichedScanNote("NOT_ENRICHED_BUDGET", 8)).toContain("top 8");
  });

  it("reports the real budget rather than a hardcoded 8", () => {
    expect(notOptionAssessedLabel("NOT_ENRICHED_BUDGET", 20)).toContain("top-20");
    expect(notEnrichedScanNote("NOT_ENRICHED_BUDGET", 20)).toContain("top 20");
  });

  it("is not one of the option-quality verdicts", () => {
    expect(["PASS", "NEAR", "FAIL", "VERIFY"]).not.toContain(NOT_OPTION_ASSESSED_BADGE);
  });
});

describe("scanner row reasons", () => {
  it.each(["NOT_ENRICHED_BUDGET", "NOT_ENRICHED_STOCK_FILTER", "NOT_ENRICHED_DATA_UNAVAILABLE"] as const)(
    "%s shows one truthful line instead of option inputs that were never requested",
    (state) => {
      const reasons = scannerRowReasons(state, OPTION_UNKNOWN_PHRASES, 8);
      expect(reasons).toHaveLength(1);
      for (const phrase of OPTION_UNKNOWN_PHRASES) {
        expect(reasons).not.toContain(phrase);
      }
      expect(reasons[0]).toContain("Options not checked");
    },
  );

  it("keeps real per-criterion unknowns for a row whose chain WAS requested", () => {
    expect(scannerRowReasons("ENRICHED", OPTION_UNKNOWN_PHRASES, 8)).toEqual(OPTION_UNKNOWN_PHRASES);
  });

  it("keeps existing behavior for a run predating the field", () => {
    expect(scannerRowReasons(null, OPTION_UNKNOWN_PHRASES, 8)).toEqual(OPTION_UNKNOWN_PHRASES);
  });
});
