import { describe, expect, it } from "vitest";
import { MAX_IMPORT_BYTES, parseEthicsImport } from "./ethicsImport";

const company = (over: Record<string, unknown> = {}) => ({
  ticker: "corz",
  companyName: "Core Scientific",
  researchedAt: "2026-10-31",
  assessments: [{ category: "ABORTION", level: "NONE", confidence: "MEDIUM", summary: "No involvement found." }],
  evidence: [{ category: "ABORTION", claim: "Business is hosting and mining.", sourceUrl: "https://www.sec.gov/example", sourceType: "PRIMARY_FILING", supports: "SUPPORTS_CLEARANCE", publishedAt: "2026-02-27" }],
  ...over,
});
const doc = (companies: unknown[]) => JSON.stringify({ companies });

describe("parseEthicsImport", () => {
  it("accepts a valid file and upper-cases the ticker", () => {
    const result = parseEthicsImport(doc([company()]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.companies[0].ticker).toBe("CORZ");
  });

  it("rejects non-JSON, oversized, empty and duplicate-ticker input with a plain message", () => {
    expect(parseEthicsImport("hello")).toMatchObject({ ok: false });
    expect(parseEthicsImport("x".repeat(MAX_IMPORT_BYTES + 1))).toMatchObject({ ok: false });
    expect(parseEthicsImport(doc([]))).toMatchObject({ ok: false });
    expect(parseEthicsImport(doc([company(), company()]))).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
  });

  it("only allows https links without embedded credentials", () => {
    const bad = (url: string) => parseEthicsImport(doc([company({ evidence: [{ ...company().evidence[0], sourceUrl: url }] })]));
    expect(bad("http://example.com/x").ok).toBe(false);
    expect(bad("javascript:alert(1)").ok).toBe(false);
    expect(bad("https://user:pass@example.com/x").ok).toBe(false);
    expect(bad("https://example.com/x").ok).toBe(true);
  });

  it("rejects unknown categories / levels, bad dates, and out-of-range percentages", () => {
    const withAssessment = (assessment: Record<string, unknown>) => parseEthicsImport(doc([company({ assessments: [{ ...company().assessments[0], ...assessment }] })]));
    expect(withAssessment({ category: "OTHER" }).ok).toBe(false);
    expect(withAssessment({ level: "AWFUL" }).ok).toBe(false);
    expect(withAssessment({ revenueSharePercent: 140 }).ok).toBe(false);
    expect(withAssessment({ revenueSharePercent: null }).ok).toBe(true);
    expect(parseEthicsImport(doc([company({ researchedAt: "10/31/2026" })])).ok).toBe(false);
  });

  it("accepts a GENERAL business-overview source but rejects unknown evidence categories", () => {
    const withEvidenceCategory = (category: string) => parseEthicsImport(doc([company({ evidence: [{ ...company().evidence[0], category }] })]));
    expect(withEvidenceCategory("GENERAL").ok).toBe(true);
    expect(withEvidenceCategory("EXPORT_CONTROLS").ok).toBe(false);
  });

  it("requires at least one assessment per company", () => {
    expect(parseEthicsImport(doc([company({ assessments: [] })])).ok).toBe(false);
  });
});
