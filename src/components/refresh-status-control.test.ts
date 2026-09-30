import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Post-Phase-2 UX follow-up (universal "Refresh status" control) - there is no component-render
 * harness in this repo (see PROJECT_HANDOFF.md), so several of the ticket's own required checks -
 * "Dashboard/Tracker/global control share same refresh path" and "no fake quota is ever rendered" -
 * are proven against the source itself, the same precedent already accepted elsewhere in this repo
 * (see src/app/(app)/retired-one-percent-displays.test.ts). The actual refresh SEMANTICS (per-user
 * scope, no transaction import, no review-rule duplication) are covered directly, with real
 * behavior, in src/lib/workflows.test.ts's refreshPositionEvidenceForUser suite.
 */
function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("RefreshStatusControl - truthful rate-limit display", () => {
  const text = source("./refresh-status-control.tsx");

  it("never renders a fabricated request-quota counter (no verified Schwab quota evidence exists to build one on)", () => {
    // Strip comments first - this file's OWN doc comments legitimately discuss why no quota exists;
    // the check is about what could actually render, never about that prose.
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(withoutComments).not.toMatch(/\d+\s*\/\s*\d+\s*requests?/i);
    expect(withoutComments).not.toMatch(/quota/i);
    expect(withoutComments).not.toMatch(/rate\s*limit/i);
  });

  it("only ever shows truthful, app-known states: Ready, Refreshing, Last checked, a cooldown countdown, or a concise failure reason", () => {
    expect(text).toContain('"Ready"');
    expect(text).toContain("Refreshing");
    expect(text).toContain("Last checked");
    expect(text).toContain("Available again in");
    expect(text).toContain("Schwab connection needs attention");
    expect(text).toContain("Current status could not be refreshed");
  });

  it("the client-only fallback cooldown is a plain constant reusing the server's own default TTL, not a persisted/invented limit - no new Prisma model/migration for it", () => {
    expect(text).toMatch(/FALLBACK_COOLDOWN_MS\s*=\s*15_000/);
    expect(text).not.toMatch(/prisma\./i);
  });

  it("the server's own authoritative cooldown (availableAgainAt) drives the countdown in the normal case - never only a client-invented timer", () => {
    expect(text).toContain("availableAgainAt");
    expect(text).toContain("result.availableAgainAt");
  });
});

describe("Universal 'Refresh status' control - ONE manual refresh control, not two divergent ones (correctness repair item 6)", () => {
  it("the global app layout renders RefreshStatusControl", () => {
    const layout = source("../app/(app)/layout.tsx");
    expect(layout).toContain('import { RefreshStatusControl } from "@/components/refresh-status-control";');
    expect(layout).toContain("<RefreshStatusControl");
  });

  it("Tracker no longer mounts its own instance of RefreshStatusControl - the global header control is the ONE manual refresh action", () => {
    const positionsPage = source("../app/(app)/positions/page.tsx");
    expect(positionsPage).not.toContain("RefreshStatusControl");
    expect(positionsPage).not.toContain("<RefreshStatusControl");
    // The old ad-hoc router.refresh()-only button is gone too, not left behind as a THIRD path.
    expect(positionsPage).not.toContain("RefreshSnapshot");
  });

  it("Tracker still shows useful factual status text (snapshot checked / brokerage synced / positions available) - only the manual ACTION was removed, not the information", () => {
    const positionsPage = source("../app/(app)/positions/page.tsx");
    expect(positionsPage).toContain("Snapshot checked");
    expect(positionsPage).toMatch(/brokerage last synced/i);
    expect(positionsPage).toMatch(/Positions \{/);
  });

  it("the ONE control calls the single shared server action, refreshPositionEvidenceAction", () => {
    const control = source("./refresh-status-control.tsx");
    expect(control).toContain("refreshPositionEvidenceAction");
  });
});

describe("refreshPositionEvidenceAction never duplicates Phase 2's own review/roll rules", () => {
  it("actions.ts's refresh action contains no review/roll/moneyness logic of its own - it only resolves the user and delegates to the guarded workflow", () => {
    const actions = source("../app/(app)/actions.ts");
    const actionStart = actions.indexOf("export async function refreshPositionEvidenceAction");
    expect(actionStart).toBeGreaterThan(-1);
    const actionBody = actions.slice(actionStart, actionStart + 400);
    expect(actionBody).not.toMatch(/evaluatePositionReview|rollBufferPercent|moneyness|COMFORTABLE|REVIEW_ROLL/);
    expect(actionBody).toContain("refreshPositionEvidenceForUserGuarded");
  });

  it("workflows.ts's refreshPositionEvidenceForUser never calls the position-review EVALUATOR, campaign reconciliation, or transaction import - it reuses the shared evidence-scoping helpers, never re-derives them", () => {
    const workflows = source("../lib/workflows.ts");
    const fnStart = workflows.indexOf("export async function refreshPositionEvidenceForUser(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = workflows.indexOf("\n}", fnStart);
    const fnBody = workflows.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/evaluatePositionReview|resolvePositionReviewsForUser\(|reconcileSchwabActivityForUser|reconcileSchwabCoveredCallActivityForUser|getTransactions|persistNormalizedBrokerRecordsForUser/);
    // It DOES reuse the shared scoping helpers - never a second, independently-maintained answer to
    // "which tickers need review evidence."
    expect(fnBody).toContain("resolveRelevantCampaignLegs");
    expect(fnBody).toContain("tickersNeedingReviewQuotes");
  });
});
