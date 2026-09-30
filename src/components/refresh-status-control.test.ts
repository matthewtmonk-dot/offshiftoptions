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

  it("the client-side cooldown is a plain constant reusing an existing app TTL, not a persisted/invented limit - no new Prisma model/migration for it", () => {
    expect(text).toMatch(/COOLDOWN_MS\s*=\s*15_000/);
    expect(text).not.toMatch(/prisma\./i);
  });
});

describe("Universal 'Refresh status' control - one shared implementation, not two divergent ones", () => {
  it("the global app layout renders RefreshStatusControl", () => {
    const layout = source("../app/(app)/layout.tsx");
    expect(layout).toContain('import { RefreshStatusControl } from "@/components/refresh-status-control";');
    expect(layout).toContain("<RefreshStatusControl");
  });

  it("Tracker's own refresh button now uses the exact same shared component - never a second implementation", () => {
    const positionsPage = source("../app/(app)/positions/page.tsx");
    expect(positionsPage).toContain('import { RefreshStatusControl } from "@/components/refresh-status-control";');
    expect(positionsPage).toContain("<RefreshStatusControl");
    // The old ad-hoc router.refresh()-only button is gone, not left behind as a second path.
    expect(positionsPage).not.toContain("RefreshSnapshot");
  });

  it("both call the same single server action, refreshPositionEvidenceAction", () => {
    const control = source("./refresh-status-control.tsx");
    expect(control).toContain("refreshPositionEvidenceAction");
  });
});

describe("refreshPositionEvidenceAction never duplicates Phase 2's own review/roll rules", () => {
  it("actions.ts's refresh action contains no review/roll/moneyness logic of its own - it only resolves the user and delegates", () => {
    const actions = source("../app/(app)/actions.ts");
    const actionStart = actions.indexOf("export async function refreshPositionEvidenceAction");
    expect(actionStart).toBeGreaterThan(-1);
    const actionBody = actions.slice(actionStart, actionStart + 400);
    expect(actionBody).not.toMatch(/evaluatePositionReview|rollBufferPercent|moneyness|COMFORTABLE|REVIEW_ROLL/);
    expect(actionBody).toContain("refreshPositionEvidenceForUser");
  });

  it("workflows.ts's refreshPositionEvidenceForUser never imports or calls the position-review evaluator, campaign reconciliation, or transaction import", () => {
    const workflows = source("../lib/workflows.ts");
    const fnStart = workflows.indexOf("export async function refreshPositionEvidenceForUser");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = workflows.indexOf("\n}", fnStart);
    const fnBody = workflows.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/evaluatePositionReview|resolvePositionReviewsForUser|reconcileSchwabActivityForUser|reconcileSchwabCoveredCallActivityForUser|getTransactions|persistNormalizedBrokerRecordsForUser/);
  });
});
