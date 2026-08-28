import { describe, expect, it } from "vitest";
import { isRecommendationStatus, normalizeReasonTags } from "./recommendations";

describe("recommendation helpers", () => {
  it("keeps only known reason tags and removes duplicates", () => {
    expect(normalizeReasonTags(["RSI", "RSI", "Nope", "Premium,Delta"])).toEqual(["RSI", "Premium", "Delta"]);
  });

  it("uses the Phase 1B recommendation statuses", () => {
    expect(isRecommendationStatus("PASSED")).toBe(true);
    expect(isRecommendationStatus("ARCHIVED")).toBe(true);
    expect(isRecommendationStatus("DISMISSED")).toBe(false);
    expect(isRecommendationStatus("DONE")).toBe(false);
  });
});
