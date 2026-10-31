import { describe, expect, it } from "vitest";
import {
  ethicsGate,
  ethicsReviewDue,
  evaluateEthicalCompatibility,
  gamblingLevelFromRevenueShare,
  isMaterialEthicsChange,
  type CategoryAssessment,
  type EthicsCategory,
  type InvolvementLevel,
} from "./ethicalCompatibility";

const a = (category: EthicsCategory, level: InvolvementLevel, confidence: CategoryAssessment["confidence"] = "HIGH", extra: Partial<CategoryAssessment> = {}): CategoryAssessment => ({
  category,
  level,
  confidence,
  summary: "test",
  ...extra,
});
const cleanCore = (confidence: CategoryAssessment["confidence"] = "HIGH") => [a("ABORTION", "NONE", confidence), a("PORNOGRAPHY", "NONE", confidence), a("GAMBLING", "NONE", confidence), a("PREDATORY_LENDING", "NONE", confidence)];

describe("evaluateEthicalCompatibility", () => {
  it("nothing assessed is UNREVIEWED with no score - never green by default", () => {
    expect(evaluateEthicalCompatibility([])).toMatchObject({ score: null, rating: "UNREVIEWED", incomplete: true });
  });

  it("a fully reviewed company with no involvement is green at 100", () => {
    expect(evaluateEthicalCompatibility(cleanCore())).toMatchObject({ score: 100, rating: "GREEN", needsReview: false, incomplete: false, confidence: "HIGH" });
  });

  it("incidental associations carry almost no weight (no guilt by association)", () => {
    const result = evaluateEthicalCompatibility([...cleanCore(), a("ASSOCIATIONS", "INCIDENTAL"), a("ABORTION", "INCIDENTAL")]);
    expect(result.rating).toBe("GREEN");
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("not all core categories assessed -> flagged incomplete and capped below strongly compatible", () => {
    const result = evaluateEthicalCompatibility([a("ABORTION", "NONE"), a("GAMBLING", "NONE")]);
    expect(result.incomplete).toBe(true);
    expect(result.rating).toBe("LIGHT_GREEN");
  });

  it("verified direct abortion participation is a hard exclusion regardless of how small the business share is", () => {
    const result = evaluateEthicalCompatibility([...cleanCore().filter((x) => x.category !== "ABORTION"), a("ABORTION", "DIRECT", "HIGH", { revenueSharePercent: 1 })]);
    expect(result).toMatchObject({ rating: "EXCLUDED", score: 0 });
  });

  it("the same finding on unverified evidence is NOT an exclusion - it is capped and flagged for Matt's review", () => {
    const result = evaluateEthicalCompatibility([...cleanCore().filter((x) => x.category !== "ABORTION"), a("ABORTION", "DIRECT", "MEDIUM")]);
    expect(result.rating).toBe("RED");
    expect(result.needsReview).toBe(true);
    expect(result.score).toBeLessThanOrEqual(39);
    expect(result.confidence).toBe("MEDIUM");
  });

  it("a defining pornography business, verified, is excluded", () => {
    expect(evaluateEthicalCompatibility([...cleanCore().filter((x) => x.category !== "PORNOGRAPHY"), a("PORNOGRAPHY", "DIRECT", "HIGH")]).rating).toBe("EXCLUDED");
  });

  it("substances and associations never hard-exclude on their own", () => {
    const result = evaluateEthicalCompatibility([...cleanCore(), a("SUBSTANCES", "DIRECT", "HIGH"), a("ASSOCIATIONS", "DIRECT", "HIGH")]);
    expect(result.rating).not.toBe("EXCLUDED");
  });

  it("abortion weighs more than gambling at the same level", () => {
    const abortion = evaluateEthicalCompatibility([...cleanCore().filter((x) => x.category !== "ABORTION"), a("ABORTION", "MODERATE")]);
    const gambling = evaluateEthicalCompatibility([...cleanCore().filter((x) => x.category !== "GAMBLING"), a("GAMBLING", "MODERATE")]);
    expect(abortion.score!).toBeLessThan(gambling.score!);
  });

  it("gambling follows the sliding scale: warning, review, then substantial", () => {
    expect(gamblingLevelFromRevenueShare(0)).toBe("NONE");
    expect(gamblingLevelFromRevenueShare(3)).toBe("MINOR");
    expect(gamblingLevelFromRevenueShare(5)).toBe("MODERATE");
    expect(gamblingLevelFromRevenueShare(10)).toBe("MODERATE");
    expect(gamblingLevelFromRevenueShare(25)).toBe("SUBSTANTIAL");
    expect(gamblingLevelFromRevenueShare(80)).toBe("DIRECT");
    const minor = evaluateEthicalCompatibility([...cleanCore().filter((x) => x.category !== "GAMBLING"), a("GAMBLING", "MINOR", "HIGH", { revenueSharePercent: 3 })]);
    expect(minor.rating).toBe("GREEN");
    expect(minor.concerns[0]).toContain("~3% of business");
  });

  it("confidence is the weakest assessed confidence, kept separate from the score", () => {
    const result = evaluateEthicalCompatibility([...cleanCore("HIGH").slice(0, 3), a("PREDATORY_LENDING", "NONE", "LOW")]);
    expect(result.confidence).toBe("LOW");
    expect(result.score).toBe(100);
  });

  it("a duplicated category keeps the worse finding", () => {
    const result = evaluateEthicalCompatibility([...cleanCore(), a("GAMBLING", "MODERATE")]);
    expect(result.concerns.some((c) => c.startsWith("Gambling: moderate"))).toBe(true);
  });
});

describe("ethicsGate", () => {
  it("Matt's decision always wins over the computed rating", () => {
    expect(ethicsGate({ rating: "GREEN", needsReview: false, decision: "EXCLUDED" })).toBe("BLOCKED");
    expect(ethicsGate({ rating: "EXCLUDED", needsReview: false, decision: "APPROVED" })).toBe("OK");
    expect(ethicsGate({ rating: "GREEN", needsReview: false, decision: "UNDER_REVIEW" })).toBe("REVIEW");
  });
  it("an approval needing recheck (material new evidence) goes back to review", () => {
    expect(ethicsGate({ rating: "GREEN", needsReview: false, decision: "APPROVED", recheckNeeded: true })).toBe("REVIEW");
  });
  it("without a decision: green is OK, yellow/red/unverified-severe need review, verified exclusion blocks, unrated is unreviewed", () => {
    expect(ethicsGate({ rating: "GREEN", needsReview: false, decision: null })).toBe("OK");
    expect(ethicsGate({ rating: "LIGHT_GREEN", needsReview: false, decision: null })).toBe("OK");
    expect(ethicsGate({ rating: "YELLOW", needsReview: false, decision: null })).toBe("REVIEW");
    expect(ethicsGate({ rating: "RED", needsReview: true, decision: null })).toBe("REVIEW");
    expect(ethicsGate({ rating: "EXCLUDED", needsReview: false, decision: null })).toBe("BLOCKED");
    expect(ethicsGate({ rating: "UNREVIEWED", needsReview: false, decision: null })).toBe("UNREVIEWED");
  });
});

describe("material change and review due", () => {
  const before = { rating: "GREEN" as const, assessments: cleanCore() };
  it("a worse rating or a worse category level is material; the same or better is not", () => {
    expect(isMaterialEthicsChange(null, before)).toBe(false);
    expect(isMaterialEthicsChange(before, before)).toBe(false);
    expect(isMaterialEthicsChange(before, { rating: "YELLOW", assessments: cleanCore() })).toBe(true);
    expect(isMaterialEthicsChange(before, { rating: "GREEN", assessments: [...cleanCore().slice(1), a("ABORTION", "MINOR")] })).toBe(true);
    expect(isMaterialEthicsChange({ rating: "YELLOW", assessments: cleanCore() }, before)).toBe(false);
  });
  it("review is due once the date passes", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    expect(ethicsReviewDue(null, now)).toBe(false);
    expect(ethicsReviewDue(new Date("2026-12-01T00:00:00Z"), now)).toBe(false);
    expect(ethicsReviewDue(new Date("2026-10-01T00:00:00Z"), now)).toBe(true);
  });
});
