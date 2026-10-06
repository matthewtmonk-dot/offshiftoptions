import "server-only";

/**
 * Post-Phase-2 UX follow-up ("Universal Refresh Status" - end-to-end abandonment repair) - a
 * small, PROCESS-LOCAL, per-key guard coalescing concurrent operations, applying a short cooldown
 * after each attempt completes, and BOUNDING how long any single operation may run.
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
 * ONE GENERATION, ONE DEADLINE, ONE TERMINAL OUTCOME. Each per-key attempt ("generation") owns
 * exactly one `AbortController`, one deadline, one underlying operation promise, and one shared
 * `terminalPromise` that every waiter for that generation - the original executor AND every
 * COALESCED joiner - awaits and observes identically. A generation's terminal outcome is one of:
 *
 * - SUCCESS: the operation resolved before the deadline.
 * - FAILURE: the operation rejected before the deadline.
 * - TIMEOUT: the deadline fired first; `controller.abort()` is called (so a signal-aware operation
 *   can actually cancel its outstanding work - see refreshPositionEvidenceForUser's own doc
 *   comment for exactly how this threads down to the real Schwab HTTP calls), and the underlying
 *   operation - which cannot always be force-killed even with abort support (a promise that never
 *   observes its own signal, or is already past the point where aborting has any effect) - is
 *   simply never listened to again for the purposes of THIS generation's outcome.
 *
 * Once a generation's terminalPromise settles, it can never change: a `settled` flag inside
 * `createTerminalPromise` below guarantees only the FIRST of {operation settles, deadline fires}
 * actually produces the outcome every waiter sees - the other is a no-op. This is what makes the
 * two defects this repair fixes structurally impossible, not just improbable:
 *
 * 1. A coalesced waiter can never receive a different outcome than the executor for the SAME
 *    generation - they all await the literal same `terminalPromise` object.
 * 2. An abandoned (timed-out) generation's eventual late resolution can never retroactively become
 *    that generation's outcome, and can never affect a NEWER generation's own state (guarded by
 *    generation-identity checks in `finalizeGeneration`).
 *
 * Cache-level safety for the same "abandoned work publishes stale evidence" concern is handled two
 * ways, together: (a) `controller.abort()` propagates into the real Schwab fetch call (see
 * schwabGetJson), so an outstanding request genuinely stops rather than running to completion in
 * the background; (b) providers/broker-read/cache.ts's and providers/market-data/cache.ts's own
 * cache-publication step additionally refuses to `cache.set` when its own `signal.aborted` is true,
 * as defense in depth on top of (never instead of) their existing invalidationVersions mechanism.
 */
export type RefreshDisposition = "EXECUTED" | "COALESCED" | "COOLDOWN";

export type GuardedOutcome<T> = {
  result: T;
  /** Epoch ms - when a NEW operation for this key may next actually run. */
  availableAgainAt: number;
  disposition: RefreshDisposition;
  /**
   * Codex blocker repair (C, final) - this key's own strictly-increasing per-attempt counter
   * (never reused, never shared across keys/users). Lets a caller record an attempt's outcome
   * against a receipt store (or similar) with correct ordering: a LATER-completing but
   * actually-OLDER generation can be detected and ignored, so a stale/abandoned attempt's
   * eventual resolution can never overwrite a newer attempt's already-recorded state. EXECUTED
   * and every COALESCED joiner for the same attempt all observe the SAME generation number.
   */
  generation: number;
};

type TerminalOutcome<T> = { kind: "SUCCESS"; value: T } | { kind: "FAILURE"; error: unknown } | { kind: "TIMEOUT" };

type ActiveGeneration<T> = {
  generation: number;
  controller: AbortController;
  terminalPromise: Promise<TerminalOutcome<T>>;
};

type KeyState<T> = {
  activeGeneration: ActiveGeneration<T> | null;
  generationCounter: number;
  hasResult: boolean;
  lastResult: T | undefined;
  availableAt: number;
};

const keyStates = new Map<string, KeyState<unknown>>();

export type RunGuardedOptions<T> = {
  cooldownMs: number;
  /** How long a generation is allowed to run before this guard treats it as abandoned, aborts its
   * signal, and releases the key - never a claimed Schwab/provider quota, purely an app-level
   * operational bound. */
  timeoutMs: number;
  /** Produces the typed result to report when a generation times out, and doubles as the neutral
   * placeholder for a COOLDOWN reuse that has no real prior result to serve (which can only happen
   * right after a prior generation was itself abandoned to timeout). Called at most once per
   * occurrence. */
  onTimeout: () => T;
  now?: () => number;
};

/**
 * `operation` receives this generation's OWN `AbortSignal` - pass it through to every abort-aware
 * call your operation makes (see refreshPositionEvidenceForUser). An operation that ignores the
 * signal entirely still gets a correct TIMEOUT outcome reported to every waiter; it just can't stop
 * its own outstanding work early, which is exactly why threading the signal down matters.
 */
export async function runGuarded<T>(key: string, operation: (signal: AbortSignal) => Promise<T>, options: RunGuardedOptions<T>): Promise<GuardedOutcome<T>> {
  const { cooldownMs, timeoutMs, onTimeout, now = Date.now } = options;

  let state = keyStates.get(key) as KeyState<T> | undefined;
  if (!state) {
    state = { activeGeneration: null, generationCounter: 0, hasResult: false, lastResult: undefined, availableAt: 0 };
    keyStates.set(key, state as KeyState<unknown>);
  }

  // COALESCED: a generation for this key is already running - join its SAME shared terminal
  // promise rather than starting a second underlying operation. (Synchronous up to this point - no
  // other call for the same key can interleave here.)
  if (state.activeGeneration) {
    const { generation, terminalPromise } = state.activeGeneration;
    const outcome = await terminalPromise;
    finalizeGeneration(state, generation, outcome, cooldownMs, now);
    return outcomeForCaller(outcome, state, "COALESCED", onTimeout, generation);
  }

  // COOLDOWN: a prior generation for this key completed (or was abandoned to timeout) recently -
  // never starts a new underlying operation, never aborts anything, never clears caches.
  if (now() < state.availableAt) {
    const result = state.hasResult ? (state.lastResult as T) : onTimeout();
    return { result, availableAgainAt: state.availableAt, disposition: "COOLDOWN", generation: state.generationCounter };
  }

  // EXECUTED: genuinely start a new generation, with its own controller/deadline/terminal promise.
  state.generationCounter += 1;
  const generation = state.generationCounter;
  const controller = new AbortController();
  const terminalPromise = createTerminalPromise(() => operation(controller.signal), controller, timeoutMs);
  state.activeGeneration = { generation, controller, terminalPromise };

  const outcome = await terminalPromise;
  finalizeGeneration(state, generation, outcome, cooldownMs, now);
  return outcomeForCaller(outcome, state, "EXECUTED", onTimeout, generation);
}

/** Settles EXACTLY ONCE, to whichever of {operation settles, deadline fires} happens first - the
 * other is permanently ignored via the `settled` flag. This one promise is shared by the executor
 * and every COALESCED joiner, so they can never observe different outcomes for the same
 * generation. Calls `controller.abort()` on timeout so a signal-aware operation can actually stop. */
function createTerminalPromise<T>(run: () => Promise<T>, controller: AbortController, timeoutMs: number): Promise<TerminalOutcome<T>> {
  return new Promise<TerminalOutcome<T>>((resolve) => {
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve({ kind: "TIMEOUT" });
    }, timeoutMs);

    run().then(
      (value) => {
        if (settled) return; // TIMEOUT already won - this late resolution has no effect whatsoever.
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({ kind: "SUCCESS", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({ kind: "FAILURE", error });
      },
    );
  });
}

/** Applies a generation's terminal outcome to the shared per-key state - EXACTLY once per
 * generation, no matter how many waiters (the executor plus every COALESCED joiner) call this for
 * the same outcome: only the first to observe `state.activeGeneration` still matching this
 * generation actually mutates anything; every later call for the same generation is a no-op. */
function finalizeGeneration<T>(state: KeyState<T>, generation: number, outcome: TerminalOutcome<T>, cooldownMs: number, now: () => number) {
  if (state.activeGeneration?.generation !== generation) {
    return;
  }
  state.activeGeneration = null;
  state.availableAt = now() + cooldownMs;
  if (outcome.kind === "SUCCESS") {
    state.hasResult = true;
    state.lastResult = outcome.value;
  }
  // FAILURE/TIMEOUT: deliberately does not overwrite hasResult/lastResult - there is no genuine
  // value to remember from either, so a subsequent COOLDOWN reuse falls back to `onTimeout()`
  // (a neutral, honest placeholder) rather than fabricating one.
}

function outcomeForCaller<T>(outcome: TerminalOutcome<T>, state: KeyState<T>, disposition: RefreshDisposition, onTimeout: () => T, generation: number): GuardedOutcome<T> {
  if (outcome.kind === "FAILURE") {
    throw outcome.error;
  }
  const result = outcome.kind === "SUCCESS" ? outcome.value : onTimeout();
  return { result, availableAgainAt: state.availableAt, disposition, generation };
}

export function clearRefreshGuardsForTests() {
  keyStates.clear();
}
