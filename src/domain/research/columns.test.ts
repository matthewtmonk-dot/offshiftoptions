import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESEARCH_COLUMNS,
  RESEARCH_HEAVY_COLUMN_PRESET,
  isResearchColumnKey,
  isResearchSortKey,
  RESEARCH_COLUMN_KEYS,
  resolveAutoOrManual,
  sanitizeResearchColumns,
} from "./columns";

describe("research column registry", () => {
  it("every default and research-heavy-preset column key is a real, registered column", () => {
    for (const key of [...DEFAULT_RESEARCH_COLUMNS, ...RESEARCH_HEAVY_COLUMN_PRESET]) {
      expect(RESEARCH_COLUMN_KEYS.has(key)).toBe(true);
    }
  });

  it("the research-heavy preset does not duplicate any column", () => {
    expect(new Set(RESEARCH_HEAVY_COLUMN_PRESET).size).toBe(RESEARCH_HEAVY_COLUMN_PRESET.length);
  });

  it("recognizes valid keys and rejects unknown ones", () => {
    expect(isResearchColumnKey("peRatio")).toBe(true);
    expect(isResearchColumnKey("status")).toBe(false);
    expect(isResearchColumnKey("ticker")).toBe(false);
    expect(isResearchColumnKey(42)).toBe(false);
  });

  it("recognizes valid sort keys only", () => {
    expect(isResearchSortKey("price")).toBe(true);
    expect(isResearchSortKey("bogus")).toBe(false);
  });
});

describe("sanitizeResearchColumns", () => {
  it("drops unknown keys while preserving order of the valid ones", () => {
    expect(sanitizeResearchColumns(["peRatio", "bogus", "wouldOwn"])).toEqual(["peRatio", "wouldOwn"]);
  });

  it("dedupes repeated keys, keeping the first occurrence's position", () => {
    expect(sanitizeResearchColumns(["company", "peRatio", "company"])).toEqual(["company", "peRatio"]);
  });

  it("returns an empty array for non-array input", () => {
    expect(sanitizeResearchColumns(null)).toEqual([]);
    expect(sanitizeResearchColumns(undefined)).toEqual([]);
    expect(sanitizeResearchColumns("peRatio")).toEqual([]);
  });
});

describe("resolveAutoOrManual", () => {
  it("prefers a verified auto value over a manual one", () => {
    expect(resolveAutoOrManual(5, 10)).toBe(5);
  });

  it("falls back to the manual value when auto is null or undefined", () => {
    expect(resolveAutoOrManual(null, 10)).toBe(10);
    expect(resolveAutoOrManual(undefined, 10)).toBe(10);
  });

  it("returns null when neither is set", () => {
    expect(resolveAutoOrManual(null, null)).toBeNull();
    expect(resolveAutoOrManual(undefined, undefined)).toBeNull();
  });

  it("treats a real 0 auto value as present, not missing", () => {
    expect(resolveAutoOrManual(0, 10)).toBe(0);
  });
});
