import "server-only";

import { resolveMarketDataProviderForUser } from "./broker-connections";
import { recordDiagnostic } from "./diagnostics";
import { runTechnicalPreparationCycleForUser } from "./technical-preparation-orchestrator";

/**
 * The Scanner's "Prepare data now" button: runs ONE bounded cycle (the same up-to-125-symbol cycle the
 * scheduled job runs) for the signed-in user, at any time of day. The scheduled job stays the normal
 * path; this exists so a stale cache (an expired Schwab sign-in, a missed morning) is fixed with a click
 * instead of waiting for the next window. It is read-only toward Schwab (price history only), touches
 * only this user's own technical-cache rows, and is safe to repeat or to overlap with the scheduled
 * job - the existing claim mechanism hands each symbol to one worker at a time, and the daily-candle
 * gate stops the run after at most 5 probe requests whenever Schwab has not published the needed day.
 */
export type PrepareTechnicalDataOutcome =
  | { ok: true; state: "IN_PROGRESS" | "COMPLETE"; processed: number; failed: number; remaining: number }
  | { ok: false; error: string };

export async function prepareTechnicalDataNowForUser(userId: string, now: Date = new Date()): Promise<PrepareTechnicalDataOutcome> {
  const resolved = await resolveMarketDataProviderForUser(userId);
  if (!resolved.provider) {
    return {
      ok: false,
      error:
        resolved.reason === "NO_USER_CONNECTION"
          ? "Connect Schwab from Account first - the scanner's data comes from it."
          : "Your Schwab sign-in has expired. Reconnect Schwab from Account, then try again.",
    };
  }

  const startedAt = Date.now();
  const result = await runTechnicalPreparationCycleForUser(userId, resolved.provider, now);
  const durationMs = Date.now() - startedAt;

  if (result.status === "OK") {
    const outcome = { ok: true as const, state: result.generationStatus, processed: result.historySymbolsProcessed, failed: result.failedCount, remaining: result.remainingEligibleCount };
    if (outcome.state === "COMPLETE") {
      recordDiagnostic({ kind: "action", source: "prepare data now", message: "finished - scanner technical data is complete", durationMs });
    }
    return outcome;
  }

  recordDiagnostic({ kind: "action", source: "prepare data now", message: `stopped - ${result.status}`, durationMs });
  if (result.status === "DAILY_CANDLE_NOT_READY") {
    return { ok: false, error: `Schwab hasn't published the ${result.requiredMarketDate} daily prices yet, so there is nothing to prepare. Try again a little later.` };
  }
  if (result.status === "CANDLE_GATE_INCONCLUSIVE") {
    return { ok: false, error: "Schwab didn't answer clearly when asked whether its daily prices are ready. Wait a minute and try again." };
  }
  return { ok: false, error: "Preparation hit a snag part-way. Nothing was lost - press the button again to continue." };
}
