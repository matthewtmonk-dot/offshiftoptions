import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAdvisorProvider } from "./ai-advisor-provider";
import type { AiAdvisorReviewResult } from "@/domain/scanner/aiAdvisorReview";

const mocks = vi.hoisted(() => ({
  db: { scanResult: { findUnique: vi.fn() } },
}));
vi.mock("./prisma", () => ({ prisma: mocks.db }));

const { requestAiAdvisorReviewForUser } = await import("./ai-advisor");
const { AiAdvisorProviderError } = await import("./ai-advisor-provider");

function reviewFixture(overrides: Partial<AiAdvisorReviewResult> = {}): AiAdvisorReviewResult {
  return {
    decision: "CONSIDER",
    confidence: "MEDIUM",
    headline: "Looks reasonable",
    summary: "A solid setup overall.",
    strongestReasons: ["Good premium"],
    mainConcerns: [],
    hardRuleFailures: [],
    unknownCriticalEvidence: [],
    softPreferenceNotes: [],
    whatWouldChangeDecision: [],
    riskNotes: [],
    ...overrides,
  };
}

function scanResultRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "result-1",
    ticker: "XYZ",
    createdAt: new Date("2026-10-10T20:00:00.000Z"),
    snapshotJson: { price: 45, strike: 40, optionBid: 1.2 },
    run: { ownerId: "matt-id" },
    criterionResults: [
      // "Stock price" is a HARD/gating rule (GATING_RULE_KEYS, profile.ts) - PASS here keeps the
      // default fixture out of either short-circuit gate, so most tests reach the provider.
      { criterionName: "Stock price", actualValue: "45", operator: "GTE", desiredValue: "20", status: "PASS", explanation: "Stock price $45.00 is above the $20.00 minimum." },
    ],
    ...overrides,
  };
}

function fakeProvider(review: AiAdvisorReviewResult = reviewFixture()): AiAdvisorProvider {
  return { review: vi.fn().mockResolvedValue(review) };
}

beforeEach(() => {
  mocks.db.scanResult.findUnique.mockReset();
});

describe("requestAiAdvisorReviewForUser", () => {
  // 1. hard-rule-passing complete packet -> provider receives expected deterministic evidence
  it("1. a complete, hard-rule-passing packet reaches the provider with the full deterministic evidence", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow());
    const provider = fakeProvider();
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.reviewSource).toBe("MODEL");
    expect(provider.review).toHaveBeenCalledTimes(1);
    const packetSent = (provider.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(packetSent.identity.ticker).toBe("XYZ");
    expect(packetSent.underlying.stockPrice).toBe(45);
    expect(packetSent.rules).toHaveLength(1);
    expect(packetSent.rules[0].status).toBe("PASS");
  });

  // 2/10. hard-rule FAIL -> the OpenAI call is structurally skipped, final decision is SKIP, and a
  // misleading model answer (even "all rules passed") can never be rendered because it is never
  // produced in the first place.
  it("2. a hard-rule failure short-circuits to a deterministic SKIP and the provider is never called, even if it would have returned a misleading CONSIDER", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(
      scanResultRow({ criterionResults: [{ criterionName: "Stock price", actualValue: "5", operator: "GTE", desiredValue: "20", status: "FAIL", explanation: "Below minimum price." }] }),
    );
    const provider = fakeProvider(reviewFixture({ decision: "CONSIDER", headline: "This candidate meets all LST rules!", hardRuleFailures: [] }));
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(provider.review).not.toHaveBeenCalled(); // the model is never asked - not merely overridden afterward
    expect(outcome.reviewSource).toBe("HARD_RULE_GATE");
    expect(outcome.review.decision).toBe("SKIP");
    expect(outcome.review.headline).toBe("Hard LST rule failed."); // never the misleading model text above
    expect(outcome.review.hardRuleFailures).toEqual([{ ruleId: "price", explanation: "Below minimum price." }]);
  });

  // 3. UNKNOWN evidence on a SOFT (non-gating) rule still reaches the provider as UNKNOWN - a soft
  // unknown does not gate the call, only a HARD one does (see test 3b below).
  it("3. UNKNOWN evidence on a soft rule reaches the provider as UNKNOWN, never silently converted to zero or PASS", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(
      scanResultRow({
        criterionResults: [
          { criterionName: "Stock price", actualValue: "45", operator: "GTE", desiredValue: "20", status: "PASS", explanation: "ok" },
          { criterionName: "RSI", actualValue: null, operator: "LTE", desiredValue: "40", status: "UNKNOWN", explanation: "RSI is unknown for this candidate." },
        ],
      }),
    );
    const provider = fakeProvider();
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.reviewSource).toBe("MODEL");
    const packetSent = (provider.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const rsiRule = packetSent.rules.find((rule: { ruleId: string }) => rule.ruleId === "rsi");
    expect(rsiRule.status).toBe("UNKNOWN");
    expect(rsiRule.actualValue).toBe("unknown");
  });

  // 3b/4. a HARD rule's UNKNOWN (not a FAIL) short-circuits to INSUFFICIENT_DATA, never "all passed",
  // and the provider is never called - same structural guarantee as the hard-FAIL gate.
  it("3b. a hard-rule UNKNOWN (no FAIL) short-circuits to a deterministic INSUFFICIENT_DATA and the provider is never called, even if it would have returned CONSIDER", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(
      scanResultRow({ criterionResults: [{ criterionName: "Stock price", actualValue: null, operator: "GTE", desiredValue: "20", status: "UNKNOWN", explanation: "Stock price is unknown for this candidate." }] }),
    );
    const provider = fakeProvider(reviewFixture({ decision: "CONSIDER" }));
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(provider.review).not.toHaveBeenCalled();
    expect(outcome.reviewSource).toBe("HARD_UNKNOWN_GATE");
    expect(outcome.review.decision).toBe("INSUFFICIENT_DATA");
    expect(outcome.unknownHardRules).toEqual([{ ruleId: "price", explanation: "Stock price is unknown for this candidate." }]);
  });

  // 4. quote/freshness missing -> explicit missing evidence
  it("4. missing option/quote evidence in the snapshot reaches the packet as explicit null, never a fabricated value", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow({ snapshotJson: { price: 45 } })); // no option fields at all
    const provider = fakeProvider();
    await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });
    const packetSent = (provider.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(packetSent.option.strike).toBeNull();
    expect(packetSent.option.optionBid).toBeNull();
    expect(packetSent.option.ror).toBeNull();
  });

  // 5. ownership mismatch -> unauthorized / rejected
  it("5. a scan result owned by a different user is rejected, never built into a packet or sent to the provider", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow({ run: { ownerId: "eric-id" } }));
    const provider = fakeProvider();
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });

    expect(outcome.ok).toBe(false);
    expect(provider.review).not.toHaveBeenCalled();
  });

  // 6. Matt cannot accidentally request Eric-private context and vice versa
  it("6. the SAME generic error is returned whether the result does not exist or belongs to someone else - never confirms/denies another user's data", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValueOnce(null);
    const notFound = await requestAiAdvisorReviewForUser("matt-id", "missing-result", { provider: fakeProvider() });

    mocks.db.scanResult.findUnique.mockResolvedValueOnce(scanResultRow({ run: { ownerId: "eric-id" } }));
    const wrongOwner = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider: fakeProvider() });

    expect(notFound.ok).toBe(false);
    expect(wrongOwner.ok).toBe(false);
    if (notFound.ok || wrongOwner.ok) throw new Error("unreachable");
    expect(notFound.error).toBe(wrongOwner.error); // identical wording either way - never a tell
  });

  // 7. malformed model structured response -> safe unavailable error
  it("7. a provider-level invalid-response error becomes a safe, generic unavailable message", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow());
    const provider: AiAdvisorProvider = { review: vi.fn().mockRejectedValue(new AiAdvisorProviderError("INVALID_RESPONSE", "bad json")) };
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toMatch(/unavailable/i);
    expect(outcome.error).not.toMatch(/bad json/i); // never leaks internal provider detail
  });

  // 8. provider timeout -> safe unavailable error
  it("8. a provider timeout becomes a safe, generic unavailable message", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow());
    const provider: AiAdvisorProvider = { review: vi.fn().mockRejectedValue(new AiAdvisorProviderError("TIMEOUT", "timed out")) };
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toMatch(/timed out/i);
  });

  // 9. provider rate limit -> safe unavailable error
  it("9. a provider rate-limit error becomes a safe, generic unavailable message", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow());
    const provider: AiAdvisorProvider = { review: vi.fn().mockRejectedValue(new AiAdvisorProviderError("RATE_LIMIT", "429")) };
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toMatch(/busy/i);
  });

  // 11. AI error does not alter scanner state - this function never writes to the DB at all
  it("11. a failed AI review never calls any prisma write - read-only, no scanner state mutation", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow());
    const provider: AiAdvisorProvider = { review: vi.fn().mockRejectedValue(new AiAdvisorProviderError("API_ERROR", "boom")) };
    await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });
    expect(mocks.db.scanResult.findUnique).toHaveBeenCalledTimes(1); // the one read, no writes exist on this mock at all
  });

  // 12. no secrets present in client bundle/response
  it("12. the returned outcome never contains an API key or any provider/network internal detail", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow());
    const provider: AiAdvisorProvider = { review: vi.fn().mockRejectedValue(new AiAdvisorProviderError("API_ERROR", "sk-secret-leak-test")) };
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });
    expect(JSON.stringify(outcome)).not.toMatch(/sk-/);

    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow());
    const okOutcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider: fakeProvider() });
    expect(JSON.stringify(okOutcome)).not.toMatch(/OPENAI_API_KEY|apiKey/i);
  });

  // 6 (ticket's "soft fail" case). all hard PASS + a soft rule FAIL (Scanner readiness FAIL overall)
  // + AI CONSIDER -> the call still reaches the model (soft failures never gate), and the outcome's
  // own scannerReadiness still reads FAIL so the UI can render "CONSIDER WITH TRADEOFFS", never a
  // plain/green CONSIDER.
  it("a soft-rule FAIL with hard rules passing still reaches the provider, and the outcome carries the Scanner's own (non-PASS) readiness alongside a model CONSIDER", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(
      scanResultRow({
        criterionResults: [
          { criterionName: "Stock price", actualValue: "45", operator: "GTE", desiredValue: "20", status: "PASS", explanation: "ok" },
          { criterionName: "RSI", actualValue: "80", operator: "LTE", desiredValue: "40", status: "FAIL", explanation: "RSI is too high." },
        ],
      }),
    );
    const provider = fakeProvider(reviewFixture({ decision: "CONSIDER", softPreferenceNotes: ["RSI missed, but the setup is still interesting."] }));
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(provider.review).toHaveBeenCalledTimes(1);
    expect(outcome.reviewSource).toBe("MODEL");
    expect(outcome.review.decision).toBe("CONSIDER");
    expect(outcome.scannerReadiness).toBe("FAIL"); // Scanner's own readiness - never silently promoted to PASS
  });

  it("rejects an empty scanResultId before ever touching prisma", async () => {
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "", { provider: fakeProvider() });
    expect(outcome.ok).toBe(false);
    expect(mocks.db.scanResult.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a malformed packet (pre-call gating) before ever calling the provider", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(scanResultRow({ criterionResults: [] })); // no rules at all
    const provider = fakeProvider();
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });
    expect(outcome.ok).toBe(false);
    expect(provider.review).not.toHaveBeenCalled();
  });
});
