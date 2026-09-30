import "server-only";

/**
 * Post-Phase-2 UX follow-up ("Universal Refresh Status" - final correctness fixes) - a small,
 * PROCESS-LOCAL, per-key guard coalescing concurrent operations, applying a short cooldown after
 * each attempt completes, and BOUNDING how long any single operation may run.
 *
 * Honest limitation, documented per the ticket's own instruction: this is NOT a durable or
 * distributed rate limiter. It lives only in this one Node process's in-memory Map, resets on
 * restart/redeploy, and is never shared across multiple server instances/replicas - a request
 * routed to a different process is not coalesced, cooled down, or bounded against one routed here.
 * That is an accepted, deliberate scope limit for this ticket (no database/persistent storage is
 * added for it - see PROJECT_HANDOFF.md). It is also not a claimed Schwab rate limit or provider
 * quota - purely this app's own spam-prevention and stuck-operation-recovery guard around its own
 * manual "Refresh status" action.
 *
 * Required semantics, reported as an explicit `disposition` so callers never have to infer it from
 * timestamps:
 * - EXECUTED: this call actually performed (or timed out waiting on) the underlying operation.
 * - COALESCED: this call joined an already-running operation and received its outcome.
 * - COOLDOWN: no operation was performed at all - a prior attempt's cooldown is still active, and
 *   its result (or, if it never produced one, the same neutral placeholder a timeout would) is
 *   reused as-is.
 *
 * BOUNDED OPERATIONS: a single underlying operation may not run (from THIS guard's perspective)
 * longer than `timeoutMs`. Threading real cancellation (AbortSignal) through the Schwab provider
 * call chain here would require touching many call sites across the provider layer for a single
 * narrow ticket - out of scope; see refreshPositionEvidenceForUser's own doc comment (workflows.ts)
 * for that same conclusion applied to this specific caller. Instead, a monotonically-increasing
 * per-key GENERATION token is used: when a call times out, the guard immediately releases the key
 * (a new attempt may start after the normal cooldown) and permanently marks that generation as
 * abandoned. The underlying operation keeps running in the background (it cannot be cancelled) -
 * if and when it eventually settles, its result is discarded outright: an abandoned generation can
 * never overwrite a newer generation's result, cooldown, or "last known" value, and can never cause
 * the guard to report a late success. Cache-level safety for the SAME concern (an abandoned Schwab/
 * market-data fetch populating a cache entry after a newer, real fetch already has) is already
 * provided by providers/broker-read/cache.ts's and providers/market-data/cache.ts's own
 * invalidation-version mechanism, unconditionally exercised by every fresh attempt's own
 * cache-clear at its start - this guard does not need to duplicate that.
 */
export type RefreshDisposition = "EXECUTED" | "COALESCED" | "COOLDOWN";

export type GuardedOutcome<T> = {
  result: T;
  /** Epoch ms - when a NEW operation for this key may next actually run. */
  availableAgainAt: number;
  disposition: RefreshDisposition;
};

type GuardEntry<T> = {
  inFlight: Promise<T> | null;
  /** The generation stamped on `inFlight` - incremented every time a genuinely NEW operation
   * starts. */
  inFlightGeneration: number;
  generation: number;
  /** Generations whose timeout already fired - permanently barred from ever mutating
   * hasResult/lastResult/availableAt/inFlight, no matter how or when they eventually settle. */
  abandonedGenerations: Set<number>;
  hasResult: boolean;
  lastResult: T | undefined;
  availableAt: number;
};

const guards = new Map<string, GuardEntry<unknown>>();

export type RunGuardedOptions<T> = {
  cooldownMs: number;
  /** How long THIS guard waits for the underlying operation before treating it as abandoned and
   * releasing the key - never a claimed Schwab/provider quota, purely an app-level operational
   * bound. */
  timeoutMs: number;
  /** Produces the typed result to report when the operation times out, and doubles as the neutral
   * placeholder for a COOLDOWN reuse that has no real prior result to serve (which can only happen
   * after a prior attempt was itself abandoned to timeout). Called at most once per occurrence. */
  onTimeout: () => T;
  now?: () => number;
};

export async function runGuarded<T>(key: string, operation: () => Promise<T>, options: RunGuardedOptions<T>): Promise<GuardedOutcome<T>> {
  const { cooldownMs, timeoutMs, onTimeout, now = Date.now } = options;

  let entry = guards.get(key) as GuardEntry<T> | undefined;
  if (!entry) {
    entry = { inFlight: null, inFlightGeneration: 0, generation: 0, abandonedGenerations: new Set(), hasResult: false, lastResult: undefined, availableAt: 0 };
    guards.set(key, entry as GuardEntry<unknown>);
  }

  // COALESCED: an operation for this key is already running - join it rather than starting a
  // second one. (Synchronous up to this point - no other call for the same key can interleave here.)
  if (entry.inFlight) {
    const result = await raceAgainstTimeout(entry, entry.inFlightGeneration, timeoutMs, onTimeout, cooldownMs, now);
    return { result, availableAgainAt: entry.availableAt, disposition: "COALESCED" };
  }

  // COOLDOWN: a prior attempt for this key completed (or was abandoned to timeout) recently -
  // never starts a new underlying operation, never clears caches, never triggers revalidation.
  if (now() < entry.availableAt) {
    const result = entry.hasResult ? (entry.lastResult as T) : onTimeout();
    return { result, availableAgainAt: entry.availableAt, disposition: "COOLDOWN" };
  }

  // EXECUTED: genuinely start a new operation, bounded by `timeoutMs`.
  entry.generation += 1;
  const myGeneration = entry.generation;
  entry.inFlight = operation();
  entry.inFlightGeneration = myGeneration;

  const result = await raceAgainstTimeout(entry, myGeneration, timeoutMs, onTimeout, cooldownMs, now);
  return { result, availableAgainAt: entry.availableAt, disposition: "EXECUTED" };
}

async function raceAgainstTimeout<T>(
  entry: GuardEntry<T>,
  myGeneration: number,
  timeoutMs: number,
  onTimeout: () => T,
  cooldownMs: number,
  now: () => number,
): Promise<T> {
  const promise = entry.inFlight!;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const settled = promise.then((value) => ({ timedOut: false as const, value }));

  // Attached to the ORIGINAL shared promise by every waiter (the executor and any COALESCED
  // joiners) - applies the result if (and only if) this generation is still current AND was never
  // abandoned to timeout. Re-applying the same state from multiple waiters is harmless (idempotent
  // in effect); this is what lets a late, abandoned result be safely discarded outright.
  void promise.then(
    (value) => {
      if (entry.inFlightGeneration === myGeneration && !entry.abandonedGenerations.has(myGeneration)) {
        entry.hasResult = true;
        entry.lastResult = value;
        entry.availableAt = now() + cooldownMs;
        entry.inFlight = null;
      }
    },
    () => {
      // An unexpected rejection still applies the cooldown, exactly like a normal failure would -
      // but only if this generation is still current and was never abandoned.
      if (entry.inFlightGeneration === myGeneration && !entry.abandonedGenerations.has(myGeneration)) {
        entry.availableAt = now() + cooldownMs;
        entry.inFlight = null;
      }
    },
  );

  const raced = await Promise.race([settled, timeout]);
  clearTimeout(timeoutHandle);

  if (!raced.timedOut) {
    return raced.value;
  }

  // Timed out from THIS caller's perspective - permanently abandon this generation and release the
  // key immediately so a fresh attempt may start after the normal cooldown, rather than leaving
  // every future caller joining a promise that may never settle.
  entry.abandonedGenerations.add(myGeneration);
  if (entry.inFlightGeneration === myGeneration) {
    entry.availableAt = now() + cooldownMs;
    entry.inFlight = null;
  }
  return onTimeout();
}

export function clearRefreshGuardsForTests() {
  guards.clear();
}
