import "server-only";

/**
 * Post-Phase-2 UX follow-up ("Universal Refresh Status - correctness repair") - a small,
 * PROCESS-LOCAL, per-key guard coalescing concurrent operations and applying a short cooldown after
 * each attempt completes (success or failure).
 *
 * Honest limitation, documented per the ticket's own instruction: this is NOT a durable or
 * distributed rate limiter. It lives only in this one Node process's in-memory Map, resets on
 * restart/redeploy, and is never shared across multiple server instances/replicas - a request
 * routed to a different process is not coalesced or cooled down against one routed here. That is an
 * accepted, deliberate scope limit for this ticket (no database/persistent storage is added for
 * it - see PROJECT_HANDOFF.md). It is also not a claimed Schwab rate limit - purely this app's own
 * spam-prevention guard around its own manual "Refresh status" action.
 *
 * Required semantics:
 * - IN-FLIGHT COALESCING: a second call for the same key while an operation is already running
 *   awaits and reuses the SAME in-flight promise - it never starts a second underlying operation.
 * - COOLDOWN: once an operation completes (success OR failure), a further call for the same key
 *   within `cooldownMs` reuses the LAST completed result rather than starting a new one.
 * - Independent keys (e.g. different userIds) never affect each other.
 */
export type GuardedOutcome<T> = {
  result: T;
  /** Epoch ms - when a NEW operation for this key may next actually run. */
  availableAgainAt: number;
  /** False when this call was coalesced into an in-flight operation or served from the cooldown
   * cache rather than actually starting a new underlying operation. */
  startedNewOperation: boolean;
};

type GuardEntry<T> = {
  inFlight: Promise<T> | null;
  hasResult: boolean;
  lastResult: T | undefined;
  availableAt: number;
};

const guards = new Map<string, GuardEntry<unknown>>();

export async function runGuarded<T>(key: string, cooldownMs: number, operation: () => Promise<T>, now: () => number = Date.now): Promise<GuardedOutcome<T>> {
  let entry = guards.get(key) as GuardEntry<T> | undefined;
  if (!entry) {
    entry = { inFlight: null, hasResult: false, lastResult: undefined, availableAt: 0 };
    guards.set(key, entry as GuardEntry<unknown>);
  }

  // Coalesce: an operation for this key is already running - reuse it rather than starting a
  // second one. (Synchronous up to this point - no other call for the same key can interleave here.)
  if (entry.inFlight) {
    const result = await entry.inFlight;
    return { result, availableAgainAt: entry.availableAt, startedNewOperation: false };
  }

  // Cooldown: the last attempt for this key completed recently - reuse its result rather than
  // starting a new underlying operation (never hammers the provider on rapid repeat clicks).
  if (entry.hasResult && now() < entry.availableAt) {
    return { result: entry.lastResult as T, availableAgainAt: entry.availableAt, startedNewOperation: false };
  }

  const promise = operation().then(
    (result) => {
      entry!.hasResult = true;
      entry!.lastResult = result;
      entry!.availableAt = now() + cooldownMs;
      entry!.inFlight = null;
      return result;
    },
    (error: unknown) => {
      // A cooldown still applies even on an unexpected rejection - rapid failed calls must not
      // hammer the provider repeatedly - but there is no truthful "last result" to reuse from a
      // thrown error, so hasResult/lastResult are left untouched.
      entry!.availableAt = now() + cooldownMs;
      entry!.inFlight = null;
      throw error;
    },
  );
  entry.inFlight = promise;

  const result = await promise;
  return { result, availableAgainAt: entry.availableAt, startedNewOperation: true };
}

export function clearRefreshGuardsForTests() {
  guards.clear();
}
