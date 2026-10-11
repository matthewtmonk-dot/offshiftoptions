"use server";

import { requireCurrentUser } from "@/lib/auth";
import { requestAiAdvisorReviewForUser, type AiAdvisorReviewOutcome } from "@/lib/ai-advisor";

/**
 * AI Advisor V1 - the one authenticated entry point a client component can call. Deliberately thin
 * - `requireCurrentUser()` first, then delegate everything else (ownership check, packet build/
 * validate, the actual OpenAI call, hard-rule-consistency enforcement) to
 * `requestAiAdvisorReviewForUser` (src/lib/ai-advisor.ts), matching this codebase's established
 * `*Action` -> `*ForUser` split (see `runLiveSchwabScannerAction`/`getAssignedCampaignsForCoveredCallScanForUser`
 * precedent) so the real logic stays independently testable without invoking a server action.
 *
 * Takes only a `scanResultId` - never a client-supplied evidence packet. The authoritative packet
 * is always built server-side from this user's own, freshly-loaded `ScanResult` row, so a client
 * can never tamper with the evidence an AI review is based on.
 */
export async function requestAiAdvisorReviewAction(scanResultId: string): Promise<AiAdvisorReviewOutcome> {
  const user = await requireCurrentUser();
  return requestAiAdvisorReviewForUser(user.id, scanResultId);
}
