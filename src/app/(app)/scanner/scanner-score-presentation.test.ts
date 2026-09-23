import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreChipClass } from "./scanner-workspace";

// Micro-ticket, post-Reporting-Phase Scanner polish: a NEEDS_DATA row's numeric score chip must
// visually deemphasize itself (muted gray, matching the existing "Verify" treatment) regardless of
// how high the score reads over whatever criteria happen to be known - so it never implies false
// confidence for a row that isn't actually actionable. This is a pure presentation change: `score`
// itself, readiness/classification, and which rows are actionable are untouched (see scanner.ts,
// unmodified by this ticket).

const MUTED = "border-zinc-600 bg-zinc-800 text-zinc-300";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("scoreChipClass - NEEDS_DATA deemphasis", () => {
  it("1. NEEDS_DATA with a high numeric score still uses muted styling, not a confident color", () => {
    expect(scoreChipClass(86, "NEEDS_DATA", "Excellent")).toBe(MUTED);
    expect(scoreChipClass(86, "NEEDS_DATA", "Excellent")).not.toContain("emerald");
  });

  it("2. NEEDS_DATA + STOCK SCREEN ONLY (a non-'Verify' scoreLabel) uses muted styling", () => {
    // isNotOptionAssessed rows keep whatever scoreLabel their known (stock-level) criteria earned -
    // never "Verify" - this is the exact production gap: a bright score next to STOCK SCREEN ONLY.
    expect(scoreChipClass(66, "NEEDS_DATA", "Strong")).toBe(MUTED);
    expect(scoreChipClass(66, "NEEDS_DATA", "Good")).toBe(MUTED);
  });

  it("3. NEEDS_DATA + VERIFY (scoreLabel already 'Verify') keeps the same muted styling as before", () => {
    expect(scoreChipClass(72, "NEEDS_DATA", "Verify")).toBe(MUTED);
  });

  it("4. PASS preserves normal actionable/confident styling, unaffected by the new NEEDS_DATA branch", () => {
    expect(scoreChipClass(95, "PASS", "Excellent")).toContain("emerald");
    expect(scoreChipClass(80, "PASS", "Strong")).toContain("sky");
  });

  it("5. NEAR preserves its existing styling, unaffected by the new NEEDS_DATA branch", () => {
    expect(scoreChipClass(60, "NEAR", "Fair")).toBe("border-amber-400/40 bg-amber-400/15 text-amber-100");
  });

  it("6. FAIL preserves existing failure styling, unaffected by the new NEEDS_DATA branch", () => {
    // A gating rule failure caps honestSetupLabel at "Fails" (scanner.ts) - the realistic FAIL
    // fixture always carries that label; a merely-low score without the "Fails" label already fell
    // through to the same red branch via score < 45 before this ticket, unchanged here.
    expect(scoreChipClass(30, "FAIL", "Fails")).toBe("border-red-400/40 bg-red-400/15 text-red-100");
    expect(scoreChipClass(40, "FAIL", "Fair")).toBe("border-red-400/40 bg-red-400/15 text-red-100");
  });

  it("a pre-existing 'Verify'-labeled row with a non-NEEDS_DATA readiness (e.g. a known FAIL elsewhere) keeps its prior muted-first behavior unchanged", () => {
    // This exact precedence already existed before this ticket (label checked ahead of score/fail
    // checks) - proving the new NEEDS_DATA branch was added ahead of it without reordering or
    // removing this pre-existing case.
    expect(scoreChipClass(20, "FAIL", "Verify")).toBe(MUTED);
  });
});

describe("Source-level guarantees (no component-render harness in this repo)", () => {
  const text = source("./scanner-workspace.tsx");

  it("7. the numeric score value itself is rendered unchanged - {result.score}, never a placeholder", () => {
    expect(text).toContain("{result.score}");
    expect(text).not.toMatch(/result\.score\s*[+\-*/]/);
  });

  it("8 & 9. no scoring/ranking/filter/classification logic was touched - only the chip's readiness parameter was added", () => {
    expect(text).toContain("scoreChipClass(result.score, result.readiness, result.scoreLabel)");
    // classifyReadiness/isActionableReadiness/applyQuickFilter/honestSetupScore call sites are
    // untouched - this ticket only added a new early-return branch inside scoreChipClass itself.
    expect(text).not.toMatch(/function classifyReadiness/);
    expect(text).not.toMatch(/function honestSetupScore/);
    expect(text).not.toMatch(/function applyQuickFilter\([^)]*\)\s*\{\s*switch[^}]*case "pass":\s*return results\.filter\(\(result\) => result\.readiness !== "PASS"/);
  });

  it("statusInfo's authoritative readiness-derived status word/tone is untouched by this ticket", () => {
    expect(text).toContain('if (result.readiness === "NEEDS_DATA") {');
    expect(text).toContain("NOT_OPTION_ASSESSED_BADGE");
  });
});
