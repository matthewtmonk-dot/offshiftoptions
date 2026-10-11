import { afterEach, describe, expect, it, vi } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError, APIError, AuthenticationError, RateLimitError } from "openai";
import { createAiAdvisorProvider, getAiAdvisorModel, getOpenAiApiKey, mapOpenAiError } from "./ai-advisor-provider";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getOpenAiApiKey / getAiAdvisorModel - fail-closed env accessors", () => {
  it("returns null, never a guessed/default key, when OPENAI_API_KEY is unset", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(getOpenAiApiKey()).toBeNull();
  });

  it("returns the configured key when present", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key");
    expect(getOpenAiApiKey()).toBe("sk-test-key");
  });

  it("defaults the model to gpt-6.1-sol when OPENAI_LST_ADVISOR_MODEL is absent", () => {
    vi.stubEnv("OPENAI_LST_ADVISOR_MODEL", "");
    expect(getAiAdvisorModel()).toBe("gpt-6.1-sol");
  });

  it("honors an explicit OPENAI_LST_ADVISOR_MODEL override for testing", () => {
    vi.stubEnv("OPENAI_LST_ADVISOR_MODEL", "gpt-6.1-sol-mini");
    expect(getAiAdvisorModel()).toBe("gpt-6.1-sol-mini");
  });
});

// 8/9 - provider timeout / rate limit map to the correct reason codes, using the SDK's own real
// error classes (never a reimplemented stand-in), without making a real network call.
describe("mapOpenAiError - maps real OpenAI SDK error classes to this module's own reason enum", () => {
  it("8. APIConnectionTimeoutError -> TIMEOUT", () => {
    expect(mapOpenAiError(new APIConnectionTimeoutError()).reason).toBe("TIMEOUT");
  });

  it("9. RateLimitError -> RATE_LIMIT", () => {
    expect(mapOpenAiError(new RateLimitError(429, {}, "rate limited", new Headers())).reason).toBe("RATE_LIMIT");
  });

  it("AuthenticationError -> CONFIG_MISSING (a rejected key is a configuration problem, not a transient failure)", () => {
    expect(mapOpenAiError(new AuthenticationError(401, {}, "invalid api key", new Headers())).reason).toBe("CONFIG_MISSING");
  });

  it("APIConnectionError -> NETWORK", () => {
    expect(mapOpenAiError(new APIConnectionError({ message: "could not connect" })).reason).toBe("NETWORK");
  });

  it("a generic APIError -> API_ERROR", () => {
    expect(mapOpenAiError(new APIError(500, {}, "server error", new Headers())).reason).toBe("API_ERROR");
  });

  it("a completely unrecognized thrown value still maps to a safe API_ERROR, never left unhandled", () => {
    expect(mapOpenAiError(new Error("something unexpected")).reason).toBe("API_ERROR");
    expect(mapOpenAiError("not even an Error instance").reason).toBe("API_ERROR");
  });
});

describe("createAiAdvisorProvider - dev-mock gating", () => {
  it("never returns the dev mock in production, even if the mock flag is set and no key is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_ADVISOR_DEV_MOCK", "1");
    vi.stubEnv("OPENAI_API_KEY", "");
    const provider = createAiAdvisorProvider();
    // The real provider throws CONFIG_MISSING with no key configured - if this were the dev mock,
    // it would resolve successfully instead.
    await expect(provider.review({} as never)).rejects.toMatchObject({ reason: "CONFIG_MISSING" });
  });

  it("never returns the dev mock when a real API key IS configured, even with the flag set", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_ADVISOR_DEV_MOCK", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-real-key-present");
    const provider = createAiAdvisorProvider();
    // Can't make a real network call in tests, but we can confirm it is NOT the mock: the mock
    // never reads the key at all and always resolves instantly with a labeled placeholder.
    const result = await Promise.race([provider.review({ identity: { ticker: "XYZ" }, rules: [] } as never).catch((error) => error), new Promise((resolve) => setTimeout(() => resolve("still-pending"), 50))]);
    // Either it throws a real provider error (network-ish, since sk-real-key-present is fake) or is
    // still pending after 50ms (making the real network call) - never the instantly-resolving mock.
    expect(result === "still-pending" || (result && typeof result === "object" && "reason" in result)).toBe(true);
  });

  it("returns the clearly-labeled dev mock only when NOT production, the flag is set, AND no real key is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_ADVISOR_DEV_MOCK", "1");
    vi.stubEnv("OPENAI_API_KEY", "");
    const provider = createAiAdvisorProvider();
    const review = await provider.review({ identity: { ticker: "XYZ" }, rules: [], riskContext: { deterministicReadiness: "PASS" } } as never);
    expect(review.headline).toMatch(/\[DEV MOCK\]/);
    expect(review.summary.toLowerCase()).toMatch(/placeholder/);
  });

  // The mock is only ever reached once src/lib/ai-advisor.ts has already confirmed every hard LST
  // rule is known-passing - it never needs to (and never does) simulate a hard-rule-failing packet,
  // and it must never return the old ambiguous "PASS" decision value.
  it("the dev mock's decision mirrors Scanner readiness (NEEDS_DATA -> INSUFFICIENT_DATA, otherwise CONSIDER) and never returns the old PASS value", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_ADVISOR_DEV_MOCK", "1");
    vi.stubEnv("OPENAI_API_KEY", "");
    const provider = createAiAdvisorProvider();

    const needsData = await provider.review({ identity: { ticker: "XYZ" }, rules: [], riskContext: { deterministicReadiness: "NEEDS_DATA" } } as never);
    expect(needsData.decision).toBe("INSUFFICIENT_DATA");

    const softFail = await provider.review({ identity: { ticker: "XYZ" }, rules: [], riskContext: { deterministicReadiness: "FAIL" } } as never);
    expect(softFail.decision).toBe("CONSIDER");
    expect(softFail.softPreferenceNotes.length).toBeGreaterThan(0); // flags the tradeoff rather than hiding it

    expect(needsData.hardRuleFailures).toEqual([]);
    expect(softFail.hardRuleFailures).toEqual([]);
  });

  it("never activates the dev mock merely because the flag is set - the real key's absence is a SEPARATE required condition", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_ADVISOR_DEV_MOCK", "0"); // flag explicitly off
    vi.stubEnv("OPENAI_API_KEY", "");
    const provider = createAiAdvisorProvider();
    await expect(provider.review({} as never)).rejects.toMatchObject({ reason: "CONFIG_MISSING" });
  });
});
