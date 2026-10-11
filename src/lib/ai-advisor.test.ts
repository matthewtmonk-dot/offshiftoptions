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
    expect(provider.review).toHaveBeenCalledTimes(1);
    const packetSent = (provider.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(packetSent.identity.ticker).toBe("XYZ");
    expect(packetSent.underlying.stockPrice).toBe(45);
    expect(packetSent.rules).toHaveLength(1);
    expect(packetSent.rules[0].status).toBe("PASS");
  });

  // 2. hard-rule failure -> failure is included and cannot disappear from rendered result
  it("2. a hard-rule failure is included in the result and cannot disappear even if the model omits it", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(
      scanResultRow({ criterionResults: [{ criterionName: "Stock price", actualValue: "5", operator: "GTE", desiredValue: "20", status: "FAIL", explanation: "Below minimum price." }] }),
    );
    const provider = fakeProvider(reviewFixture({ decision: "CONSIDER", hardRuleFailures: [] })); // model wrongly omits it
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.review.hardRuleFailures).toEqual([{ ruleId: "price", explanation: "Below minimum price." }]);
    expect(outcome.review.decision).toBe("PASS"); // never shown as CONSIDER despite the model's own answer
  });

  // 3. UNKNOWN critical evidence -> packet preserves UNKNOWN, never converts to zero/pass
  it("3. UNKNOWN evidence reaches the provider as UNKNOWN, never silently converted to zero or PASS", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(
      scanResultRow({ criterionResults: [{ criterionName: "Open interest", actualValue: null, operator: "GTE", desiredValue: "50", status: "UNKNOWN", explanation: "Open interest is unknown for this candidate." }] }),
    );
    const provider = fakeProvider();
    await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider });
    const packetSent = (provider.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(packetSent.rules[0].status).toBe("UNKNOWN");
    expect(packetSent.rules[0].actualValue).toBe("unknown");
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

  it("surfaces an UNKNOWN hard rule in outcome.unknownHardRules, computed from the packet directly - never only from the model's own text", async () => {
    mocks.db.scanResult.findUnique.mockResolvedValue(
      scanResultRow({ criterionResults: [{ criterionName: "Stock price", actualValue: null, operator: "GTE", desiredValue: "20", status: "UNKNOWN", explanation: "Stock price is unknown for this candidate." }] }),
    );
    const outcome = await requestAiAdvisorReviewForUser("matt-id", "result-1", { provider: fakeProvider() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.unknownHardRules).toEqual([{ ruleId: "price", explanation: "Stock price is unknown for this candidate." }]);
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
