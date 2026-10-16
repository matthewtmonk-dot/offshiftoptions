import { describe, expect, it } from "vitest";
import { requiredTechnicalMarketDateUtc } from "./technical-indicator-cache";

const iso = (date: Date) => date.toISOString().slice(0, 10);

describe("requiredTechnicalMarketDateUtc - uses the New York calendar day, not the UTC day", () => {
  it("Thursday 11 PM ET (already Friday in UTC) still requires Wednesday's candle - the prep job only produces Thursday's the next morning", () => {
    // 2026-10-16T03:08Z = Thursday Oct 15, 11:08 PM EDT
    expect(iso(requiredTechnicalMarketDateUtc(new Date("2026-10-16T03:08:00Z")))).toBe("2026-10-14");
  });

  it("Thursday afternoon requires Wednesday (unchanged)", () => {
    expect(iso(requiredTechnicalMarketDateUtc(new Date("2026-10-15T17:30:00Z")))).toBe("2026-10-14");
  });

  it("Friday morning requires Thursday", () => {
    expect(iso(requiredTechnicalMarketDateUtc(new Date("2026-10-16T13:00:00Z")))).toBe("2026-10-15");
  });

  it("Monday morning requires the previous Friday", () => {
    expect(iso(requiredTechnicalMarketDateUtc(new Date("2026-10-19T14:00:00Z")))).toBe("2026-10-16");
  });

  it("Friday 9 PM ET (Saturday in UTC) requires Thursday, not Friday", () => {
    expect(iso(requiredTechnicalMarketDateUtc(new Date("2026-10-17T01:00:00Z")))).toBe("2026-10-15");
  });

  it("winter (EST): 8:30 PM ET is already the next UTC day and must not advance the requirement", () => {
    // 2026-12-02T01:30Z = Tuesday Dec 1, 8:30 PM EST
    expect(iso(requiredTechnicalMarketDateUtc(new Date("2026-12-02T01:30:00Z")))).toBe("2026-11-30");
  });
});
