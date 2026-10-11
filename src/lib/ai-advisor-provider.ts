import "server-only";
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, AuthenticationError, RateLimitError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { hardRuleFailures, type AiAdvisorCandidatePacket } from "@/domain/scanner/aiAdvisorPacket";
import { AiAdvisorReviewSchema, buildAiAdvisorDeveloperPrompt, buildAiAdvisorUserPrompt, type AiAdvisorReviewResult } from "@/domain/scanner/aiAdvisorReview";

/**
 * AI Advisor V1 - the ONE place this app ever calls OpenAI. Server-only. Model/reasoning/output
 * format follow the official Responses API + Structured Outputs contract (verified against the
 * currently-installed `openai` SDK's own type declarations and doc comments, not remembered/stale
 * syntax): `client.responses.parse({ model, reasoning: { effort }, input: [...], text: { format:
 * zodTextFormat(schema, name) } })` resolves `response.output_parsed` as the schema-validated
 * result - strict Structured Outputs, never free-form JSON parsing of response text.
 */

export type AiAdvisorProviderErrorReason = "CONFIG_MISSING" | "TIMEOUT" | "RATE_LIMIT" | "API_ERROR" | "NETWORK" | "INVALID_RESPONSE";

export class AiAdvisorProviderError extends Error {
  readonly reason: AiAdvisorProviderErrorReason;
  constructor(reason: AiAdvisorProviderErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.reason = reason;
    this.name = "AiAdvisorProviderError";
  }
}

export interface AiAdvisorProvider {
  review(packet: AiAdvisorCandidatePacket): Promise<AiAdvisorReviewResult>;
}

const DEFAULT_MODEL = "gpt-6.1-sol";
/** High reasoning effort on a single structured call can genuinely take tens of seconds - long
 * enough to need an explicit timeout (the SDK's own default is 10 minutes), short enough that a
 * stuck request fails the UI into its error state well before the user assumes the app is broken. */
const REQUEST_TIMEOUT_MS = 90_000;

/** Fail-closed accessor, mirroring this codebase's established cron-secret pattern
 * (src/lib/cron-auth.ts) - never throws, never defaults to a guessable value; the caller decides
 * what "absent" means (here: refuse to call OpenAI at all). */
export function getOpenAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

/** `OPENAI_LST_ADVISOR_MODEL` is an optional override, for testing a different model without a
 * code change - it can only ever come from server environment configuration, never from client
 * input. Defaults safely to the production model when absent. */
export function getAiAdvisorModel(): string {
  return process.env.OPENAI_LST_ADVISOR_MODEL?.trim() || DEFAULT_MODEL;
}

/** Exported for direct unit testing - maps a real OpenAI SDK error class to this module's own
 * reason enum, without needing to make a real network call to produce one. */
export function mapOpenAiError(error: unknown): AiAdvisorProviderError {
  if (error instanceof AiAdvisorProviderError) return error;
  if (error instanceof APIConnectionTimeoutError) return new AiAdvisorProviderError("TIMEOUT", "The AI review request timed out.", { cause: error });
  if (error instanceof RateLimitError) return new AiAdvisorProviderError("RATE_LIMIT", "The AI review service is rate-limited right now.", { cause: error });
  if (error instanceof AuthenticationError) return new AiAdvisorProviderError("CONFIG_MISSING", "The configured OpenAI API key was rejected.", { cause: error });
  if (error instanceof APIConnectionError) return new AiAdvisorProviderError("NETWORK", "Could not reach the AI review service.", { cause: error });
  if (error instanceof APIError) return new AiAdvisorProviderError("API_ERROR", "The AI review service returned an error.", { cause: error });
  return new AiAdvisorProviderError("API_ERROR", "The AI review failed unexpectedly.", { cause: error });
}

/** The real, production OpenAI-backed provider. No tools of any kind are given to the model (no
 * web/browser/brokerage/DB/function/order tools) - one request in, one structured recommendation
 * out, exactly as scoped for V1. */
export function createOpenAiAdvisorProvider(): AiAdvisorProvider {
  return {
    async review(packet) {
      const apiKey = getOpenAiApiKey();
      if (!apiKey) {
        throw new AiAdvisorProviderError("CONFIG_MISSING", "OPENAI_API_KEY is not configured on the server.");
      }

      const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });

      try {
        const response = await client.responses.parse({
          model: getAiAdvisorModel(),
          reasoning: { effort: "high" },
          input: [
            { role: "developer", content: buildAiAdvisorDeveloperPrompt() },
            { role: "user", content: buildAiAdvisorUserPrompt(packet) },
          ],
          text: { format: zodTextFormat(AiAdvisorReviewSchema, "lst_advisor_review") },
        });

        if (!response.output_parsed) {
          throw new AiAdvisorProviderError("INVALID_RESPONSE", "The model did not return a structured result.");
        }

        return response.output_parsed;
      } catch (error) {
        throw mapOpenAiError(error);
      }
    },
  };
}

/**
 * DEVELOPMENT-ONLY fixture provider - used ONLY when ALL THREE of the following hold:
 * `NODE_ENV !== "production"`, the explicit opt-in flag `AI_ADVISOR_DEV_MOCK=1` is set, AND no real
 * `OPENAI_API_KEY` is configured. There is deliberately no path for this to activate in production
 * even under misconfiguration - the explicit flag and the real-key check are independent gates, not
 * a single switch. Every field is unmistakably labeled so a mock response can never be confused
 * with a real AI review.
 */
function createDevMockAdvisorProvider(): AiAdvisorProvider {
  return {
    async review(packet) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const failures = hardRuleFailures(packet);
      const decision =
        failures.length > 0
          ? "PASS"
          : packet.riskContext.deterministicReadiness === "NEEDS_DATA"
            ? "INSUFFICIENT_DATA"
            : packet.riskContext.deterministicReadiness === "PASS"
              ? "CONSIDER"
              : "WATCH";
      return {
        decision,
        confidence: "LOW",
        headline: `[DEV MOCK] ${packet.identity.ticker} - not a real AI review`,
        summary:
          "This is a development-only placeholder response, shown because OPENAI_API_KEY is not configured locally and AI_ADVISOR_DEV_MOCK=1 is set. It does not reflect any real model output and must never appear in production.",
        strongestReasons: ["(dev mock) placeholder reason"],
        mainConcerns: ["(dev mock) placeholder concern"],
        hardRuleFailures: failures.map((rule) => ({ ruleId: rule.ruleId, explanation: rule.explanation })),
        unknownCriticalEvidence: [],
        softPreferenceNotes: [],
        whatWouldChangeDecision: ["(dev mock) configure OPENAI_API_KEY to get a real review"],
        riskNotes: [],
      } satisfies AiAdvisorReviewResult;
    },
  };
}

/** The one factory the server action actually calls. */
export function createAiAdvisorProvider(): AiAdvisorProvider {
  if (process.env.NODE_ENV !== "production" && process.env.AI_ADVISOR_DEV_MOCK === "1" && !getOpenAiApiKey()) {
    return createDevMockAdvisorProvider();
  }
  return createOpenAiAdvisorProvider();
}
