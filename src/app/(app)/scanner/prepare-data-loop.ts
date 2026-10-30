/**
 * The "Prepare data now" button's repeat loop, kept pure (no React, no server import) so its stop
 * conditions are unit-tested. Each call to `prepare` is one bounded server cycle (~125 symbols, ~15
 * seconds); the loop repeats it until the data is complete, the user presses Stop or leaves the page,
 * something errors, or no progress is being made.
 */
import { describeActionFailure } from "@/lib/action-failure-message";

/** ~2,500 symbols at ~125 per cycle is ~20 calls; the cap only exists so a stuck loop cannot run forever. */
export const MAX_PREPARE_CALLS = 40;
export const PAUSE_BETWEEN_PREPARE_CALLS_MS = 1000;
/** Consecutive cycles that did no work (another worker holds the remaining symbols) before giving up. */
export const MAX_IDLE_PREPARE_CALLS = 3;

export type PrepareBatchResult =
  | { ok: true; state: "IN_PROGRESS" | "COMPLETE"; processed: number; failed: number; remaining: number }
  | { ok: false; error: string };

export type PrepareLoopResult =
  | { status: "complete"; processed: number; failed: number }
  | { status: "paused"; processed: number; remaining: number; note: string }
  | { status: "error"; processed: number; remaining: number | null; message: string };

export async function runPrepareDataLoop({
  prepare,
  sleep,
  shouldStop,
  onProgress,
  maxCalls = MAX_PREPARE_CALLS,
  pauseMs = PAUSE_BETWEEN_PREPARE_CALLS_MS,
}: {
  prepare: () => Promise<PrepareBatchResult>;
  sleep: (ms: number) => Promise<void>;
  /** Polled before every cycle and after every pause (user pressed Stop, or left the page). */
  shouldStop: () => boolean;
  onProgress: (progress: { processed: number; total: number | null }) => void;
  maxCalls?: number;
  pauseMs?: number;
}): Promise<PrepareLoopResult> {
  let processed = 0;
  let failed = 0;
  let remaining: number | null = null;
  let idleCalls = 0;
  onProgress({ processed, total: null });

  for (let call = 0; call < maxCalls; call += 1) {
    if (shouldStop()) {
      return { status: "paused", processed, remaining: remaining ?? 0, note: "Stopped. Progress is saved - press the button again to continue." };
    }
    let outcome: PrepareBatchResult;
    try {
      outcome = await prepare();
    } catch (error) {
      // A thrown server action (stale page after a deploy, dropped connection) must end the loop with a
      // message - never leave the button stuck on "Preparing...".
      return { status: "error", processed, remaining, message: describeActionFailure(error, "Preparing the data failed unexpectedly. Try again in a moment.") };
    }
    if (!outcome.ok) return { status: "error", processed, remaining, message: outcome.error };

    processed += outcome.processed;
    failed += outcome.failed;
    remaining = outcome.remaining;
    onProgress({ processed, total: processed + remaining });
    if (outcome.state === "COMPLETE") return { status: "complete", processed, failed };

    idleCalls = outcome.processed === 0 ? idleCalls + 1 : 0;
    if (idleCalls >= MAX_IDLE_PREPARE_CALLS) {
      return { status: "paused", processed, remaining, note: "Nothing more could be prepared right now - another preparation may be running. Wait a minute and press the button again." };
    }
    await sleep(pauseMs);
  }
  return { status: "paused", processed, remaining: remaining ?? 0, note: "That is a lot of work for one go - progress is saved. Press the button again to continue." };
}
