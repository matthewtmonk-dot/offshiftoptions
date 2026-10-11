import "server-only";
import { prisma } from "./prisma";
import { buildAiAdvisorPacket, unknownHardRules, validateAiAdvisorPacket } from "@/domain/scanner/aiAdvisorPacket";
import { enforceHardRuleConsistency, LST_ADVISOR_PROMPT_VERSION, type AiAdvisorReviewResult } from "@/domain/scanner/aiAdvisorReview";
import { AiAdvisorProviderError, createAiAdvisorProvider, type AiAdvisorProvider } from "./ai-advisor-provider";

/**
 * AI Advisor V1 - the one orchestration function the server action (ai-advisor-actions.ts)
 * delegates to, following this codebase's established `*ForUser(userId, ...)` convention so the
 * real logic is testable directly (mocked prisma + an injected fake provider) without needing to
 * invoke a "use server" action, exactly the way this repo's own test precedents already work.
 *
 * Authentication/ownership: a `ScanResult` has no owner of its own - it belongs to a `ScanRun`,
 * which has exactly one `ownerId` (scanner data is never Matt/Eric-shared the way campaigns/
 * research are - see app-data.ts's own getScannerPageData). A result that doesn't exist or belongs
 * to a different user returns the SAME generic "not available" message either way - never confirms
 * or denies that another user's scan result exists.
 */
export type AiAdvisorReviewOutcome =
  | {
      ok: true;
      review: AiAdvisorReviewResult;
      promptVersion: string;
      ticker: string;
      evaluatedAt: string;
      /** Computed directly from the packet, same reliability guarantee as
       * `review.hardRuleFailures` (enforceHardRuleConsistency) - an UNKNOWN hard rule is a distinct
       * finding from a FAIL and must be just as visible, never only mentioned (or omitted) in the
       * model's own free-text fields. */
      unknownHardRules: { ruleId: string; explanation: string }[];
    }
  | { ok: false; error: string };

export async function requestAiAdvisorReviewForUser(
  userId: string,
  scanResultId: string,
  options?: { provider?: AiAdvisorProvider },
): Promise<AiAdvisorReviewOutcome> {
  if (!scanResultId || scanResultId.trim() === "") {
    return { ok: false, error: "No candidate was specified." };
  }

  const record = await prisma.scanResult.findUnique({
    where: { id: scanResultId },
    include: { run: { select: { ownerId: true } }, criterionResults: true },
  });

  if (!record || record.run.ownerId !== userId) {
    return { ok: false, error: "This candidate is not available for review." };
  }

  const packet = buildAiAdvisorPacket({
    ticker: record.ticker,
    evaluatedAt: record.createdAt,
    snapshot: record.snapshotJson,
    criteria: record.criterionResults.map((criterion) => ({
      criterionName: criterion.criterionName,
      actualValue: criterion.actualValue,
      operator: criterion.operator,
      desiredValue: criterion.desiredValue,
      status: criterion.status,
      explanation: criterion.explanation,
    })),
  });

  const validation = validateAiAdvisorPacket(packet);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const provider = options?.provider ?? createAiAdvisorProvider();

  try {
    const review = await provider.review(packet);
    const consistent = enforceHardRuleConsistency(packet, review);
    return {
      ok: true,
      review: consistent,
      promptVersion: LST_ADVISOR_PROMPT_VERSION,
      ticker: packet.identity.ticker,
      evaluatedAt: packet.timing.evaluatedAt,
      unknownHardRules: unknownHardRules(packet).map((rule) => ({ ruleId: rule.ruleId, explanation: rule.explanation })),
    };
  } catch (error) {
    return { ok: false, error: friendlyProviderError(error) };
  }
}

/** Never makes a failed AI call look like a PASS/CONSIDER result - every branch here is a plain
 * "unavailable, nothing changed" message, matching the ticket's own required copy style. The
 * specific `reason` is never shown to the user (no SDK/network internals leaked), only logged via
 * the thrown error's own `cause` chain for server-side debugging. */
function friendlyProviderError(error: unknown): string {
  if (error instanceof AiAdvisorProviderError) {
    switch (error.reason) {
      case "CONFIG_MISSING":
        return "AI review is not configured yet. Your scanner data is unchanged.";
      case "TIMEOUT":
        return "AI review timed out. Your scanner data is unchanged.";
      case "RATE_LIMIT":
        return "AI review is busy right now. Your scanner data is unchanged.";
      case "NETWORK":
      case "API_ERROR":
      case "INVALID_RESPONSE":
      default:
        return "AI review unavailable right now. Your scanner data is unchanged.";
    }
  }
  return "AI review unavailable right now. Your scanner data is unchanged.";
}
