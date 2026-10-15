/**
 * The "Check options" button's batching loop, kept as a pure function (no React, no server import)
 * so its stop conditions are directly unit-tested. The button just wires state and a server action
 * around it.
 */

/** At most this many rows are priced per click (5 batches of 12), so one click is a bounded,
 * predictable amount of Schwab traffic; click again to continue with whatever remains. */
export const MAX_ROWS_PER_CLICK = 60;
/** Pause between batches so a 12-request batch never bursts faster than ~100 option-chain requests a
 * minute - Schwab publishes no hard limit and the provider has no 429 backoff of its own. */
export const PAUSE_BETWEEN_BATCHES_MS = 3000;

export type OptionCheckBatchResult =
  | { ok: true; checked: number; failedLookups: number; remaining: number; newPass: number; newNear: number }
  | { ok: false; error: string };

export type OptionCheckLoopResult =
  | { status: "done"; checked: number; pass: number; near: number; remaining: number; note: string | null }
  | { status: "error"; message: string };

export async function runOptionCheckLoop({
  awaiting,
  checkBatch,
  sleep,
  shouldStop,
  onProgress,
  maxRows = MAX_ROWS_PER_CLICK,
  pauseMs = PAUSE_BETWEEN_BATCHES_MS,
}: {
  awaiting: number;
  checkBatch: () => Promise<OptionCheckBatchResult>;
  sleep: (ms: number) => Promise<void>;
  /** Polled before every batch and after every pause (user pressed Stop, or left the page). */
  shouldStop: () => boolean;
  onProgress: (progress: { checked: number; target: number }) => void;
  maxRows?: number;
  pauseMs?: number;
}): Promise<OptionCheckLoopResult> {
  const target = Math.min(awaiting, maxRows);
  let checked = 0;
  let pass = 0;
  let near = 0;
  let remaining = awaiting;
  let note: string | null = null;
  onProgress({ checked, target });

  while (checked < target && !shouldStop()) {
    const outcome = await checkBatch();
    if (!outcome.ok) return { status: "error", message: outcome.error };
    checked += outcome.checked;
    pass += outcome.newPass;
    near += outcome.newNear;
    remaining = outcome.remaining;
    if (outcome.checked === 0) {
      // Nothing could be priced this round: either everything is done, or Schwab didn't answer.
      note = outcome.failedLookups > 0 ? "Schwab didn't answer for some names (it may be rate limiting). Wait a minute and click again to retry them." : null;
      break;
    }
    onProgress({ checked, target });
    if (remaining === 0) break;
    await sleep(pauseMs);
  }
  return { status: "done", checked, pass, near, remaining, note };
}
