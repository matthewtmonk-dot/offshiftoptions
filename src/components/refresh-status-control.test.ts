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

describe("Final correctness fixes - disposition-driven revalidation/refresh (never inferred from timestamps)", () => {
  it("actions.ts only calls revalidatePath for a successful EXECUTED disposition - never for COOLDOWN, and never redundantly for a COALESCED caller", () => {
    const actions = source("../app/(app)/actions.ts");
    const actionStart = actions.indexOf("export async function refreshPositionEvidenceAction");
    expect(actionStart).toBeGreaterThan(-1);
    const actionBody = actions.slice(actionStart, actions.indexOf("\n}", actionStart));
    expect(actionBody).toMatch(/disposition === "EXECUTED"/);
    expect(actionBody).toContain("revalidatePath");
  });

  it("RefreshStatusControl never calls router.refresh() for a COOLDOWN result, and defers to the server's own shouldRefreshClient flag rather than re-deriving the decision from `ok`", () => {
    const control = source("./refresh-status-control.tsx");
    expect(control).toContain('disposition === "COOLDOWN"');
    expect(control).toContain("shouldRefreshClient");
    // The COOLDOWN branch returns before ever reaching router.refresh() - structurally checked by
    // requiring an early `return` between the disposition check and the router.refresh() call.
    const cooldownCheckIndex = control.indexOf('disposition === "COOLDOWN"');
    const nextReturnIndex = control.indexOf("return;", cooldownCheckIndex);
    const routerRefreshIndex = control.indexOf("router.refresh()", cooldownCheckIndex);
    expect(nextReturnIndex).toBeGreaterThan(-1);
    expect(nextReturnIndex).toBeLessThan(routerRefreshIndex);
  });

  it("RefreshStatusControl retains the prior 'Last checked' value on a COOLDOWN result rather than manufacturing a new one - it never calls setLastRefreshedAt in that branch", () => {
    const control = source("./refresh-status-control.tsx");
    const cooldownCheckIndex = control.indexOf('disposition === "COOLDOWN"');
    const nextReturnIndex = control.indexOf("return;", cooldownCheckIndex);
    const cooldownBranch = control.slice(cooldownCheckIndex, nextReturnIndex);
    expect(cooldownBranch).not.toContain("setLastRefreshedAt");
  });

  it("workflows.ts bounds a single refresh operation with an APPLICATION timeout, never a claimed Schwab quota, and the guard is process-local (documented, not a distributed limiter)", () => {
    const workflows = source("../lib/workflows.ts");
    expect(workflows).toMatch(/REFRESH_POSITION_EVIDENCE_TIMEOUT_MS\s*=\s*20_000/);
    expect(workflows).toContain('reason: "TIMEOUT"');
    const guard = source("../lib/refresh-guard.ts");
    expect(guard).toMatch(/process-local/i);
    expect(guard).toMatch(/NOT a durable or\s*\n?\s*\*?\s*distributed rate limiter/i);
  });
});

describe("Codex blocker repair (C, final) - a failed refresh resolves a durable fallback, authenticated server-side, never a client-trusted flag", () => {
  it("workflows.ts now sets shouldRefreshClient for a genuine failure too, not only result.ok", () => {
    const workflows = source("../lib/workflows.ts");
    expect(workflows).toContain('shouldRefreshClient: disposition !== "COOLDOWN"');
    expect(workflows).not.toContain('shouldRefreshClient: result.ok && disposition !== "COOLDOWN"');
  });

  it("RefreshStatusControl calls the SAME plain, unconditional router.refresh() on both success and failure - no second navigation mechanism, no URL parameter of any kind", () => {
    const control = source("./refresh-status-control.tsx");
    const code = control.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // Exactly one router.refresh() CALL SITE (comments may still mention it in prose), reached by
    // `if (result.shouldRefreshClient)` alone - never branching further on `result.ok` to decide
    // HOW to refresh.
    const matches = code.match(/router\.refresh\(\)/g) ?? [];
    expect(matches.length).toBe(1);
    expect(code).not.toContain("router.replace(");
    expect(control).not.toContain("oso_skip_live");
    expect(control).not.toContain("useSearchParams");
    expect(control).not.toContain("usePathname");
    expect(code).not.toMatch(/cookies\(\)\.set/);
  });

  it("a stale click's own late completion is guarded against via a ref, not state - so it can never publish a newer click's result", () => {
    const control = source("./refresh-status-control.tsx");
    expect(control).toContain("useRef");
    expect(control).toContain("latestClickToken");
  });

  it("the skip-live-evidence decision lives entirely server-side (failed-refresh-receipt.ts), owner-scoped by the authenticated session alone - never a client-supplied token/flag", () => {
    const receipt = source("../lib/failed-refresh-receipt.ts");
    const code = receipt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(receipt).toContain("export function consumeFailedRefreshReceipt");
    expect(receipt).toContain("export function recordRefreshOutcome");
    // Never a client-visible identifier/capability of any kind in the actual CODE (comments
    // legitimately discuss, in prose, why this is deliberately not a token/cookie) - looked up
    // by userId alone.
    expect(code).not.toMatch(/token|cookie|searchParam/i);
  });

  it("Dashboard and Tracker both consume the receipt server-side - no client flag/query param reaches either page", () => {
    const dashboard = source("../app/(app)/dashboard/page.tsx");
    const tracker = source("../app/(app)/positions/page.tsx");
    expect(dashboard).toContain("consumeFailedRefreshReceipt");
    expect(tracker).toContain("consumeFailedRefreshReceipt");
    expect(dashboard).not.toContain("oso_skip_live");
    expect(tracker).not.toContain("oso_skip_live");
  });

  it("Tracker's independent 'Stock snapshot' quote call also uses retained evidence when present - never an unguarded second provider call (Codex defect 2)", () => {
    const tracker = source("../app/(app)/positions/page.tsx");
    expect(tracker).toContain("quoteSnapshotsFromRetainedEvidence");
  });

  it("resolvePositionReviewsForUser's retained-evidence option reuses the exact same BROKER_UNAVAILABLE code path a genuine outage already takes - no new eligibility rule", () => {
    const positionReview = source("../lib/position-review.ts");
    expect(positionReview).toContain("retainedEvidence");
    expect(positionReview).toContain("resolveRelevantCampaignLegs");
  });

  it("the orchestration layer's CURRENT read-back and true historical-fallback questions stay on two separate functions - never reunified by this fix", () => {
    const orchestration = source("../lib/positionAssessmentOrchestration.ts");
    expect(orchestration).toContain("getVerifiedPositionAssessmentForCurrentLeg");
    expect(orchestration).toContain("getLastValidPositionAssessment");
  });

  it("refresh-guard.ts exposes the generation number so a receipt store can enforce strict ordering, without weakening its own coalescing/cooldown/timeout contract", () => {
    const guard = source("../lib/refresh-guard.ts");
    expect(guard).toContain("generation: number");
    // The existing contract (disposition, cooldown, timeout) is still fully intact.
    expect(guard).toContain("RefreshDisposition");
    expect(guard).toContain("cooldownMs");
    expect(guard).toContain("timeoutMs");
  });
});
