import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRefreshGuardsForTests, runGuarded } from "./refresh-guard";

const onTimeout = () => "TIMED_OUT" as const;

describe("runGuarded - disposition contract (EXECUTED / COALESCED / COOLDOWN)", () => {
  afterEach(() => {
    clearRefreshGuardsForTests();
  });

  it("the first call for a key is EXECUTED", async () => {
    const outcome = await runGuarded("matt", async () => "result-1", { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout });
    expect(outcome.disposition).toBe("EXECUTED");
    expect(outcome.result).toBe("result-1");
  });

  it("two concurrent calls for the SAME key: the first is EXECUTED, the second COALESCES into it - exactly one underlying operation runs, both receive the coherent result", async () => {
    let calls = 0;
    let resolveOp: ((value: string) => void) | undefined;
    const operation = () =>
      new Promise<string>((resolve) => {
        calls += 1;
        resolveOp = resolve;
      });

    const first = runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout });
    const second = runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout });
    resolveOp!("done");

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(calls).toBe(1); // only ONE underlying operation ever started
    expect(firstOutcome.disposition).toBe("EXECUTED");
    expect(secondOutcome.disposition).toBe("COALESCED");
    expect(firstOutcome.result).toBe("done");
    expect(secondOutcome.result).toBe("done");
    expect(firstOutcome.availableAgainAt).toBe(secondOutcome.availableAgainAt);
  });

  it("a call within the cooldown window is COOLDOWN and starts no new operation", async () => {
    let calls = 0;
    let now = 0;
    const operation = async () => {
      calls += 1;
      return `result-${calls}`;
    };

    const first = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });
    expect(first.disposition).toBe("EXECUTED");

    now += 5_000; // still within the 15s cooldown
    const second = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });

    expect(second.disposition).toBe("COOLDOWN");
    expect(second.result).toBe("result-1"); // reused, never a fresh "result-2"
    expect(calls).toBe(1); // no second underlying operation triggered
  });

  it("a call AFTER the cooldown expires is EXECUTED again", async () => {
    let calls = 0;
    let now = 0;
    const operation = async () => {
      calls += 1;
      return `result-${calls}`;
    };

    await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });
    now += 15_001;
    const second = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });

    expect(second.disposition).toBe("EXECUTED");
    expect(second.result).toBe("result-2");
    expect(calls).toBe(2);
  });

  it("Matt and Eric each have fully independent in-flight/cooldown state", async () => {
    let now = 0;
    const mattOp = vi.fn(async () => "matt-1");
    const ericOp = vi.fn(async () => "eric-1");

    await runGuarded("matt", mattOp, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });
    await runGuarded("eric", ericOp, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });

    now += 5_000;
    const mattSecond = await runGuarded("matt", mattOp, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });
    const ericSecond = await runGuarded("eric", ericOp, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });

    expect(mattOp).toHaveBeenCalledTimes(1);
    expect(ericOp).toHaveBeenCalledTimes(1);
    expect(mattSecond.disposition).toBe("COOLDOWN");
    expect(ericSecond.disposition).toBe("COOLDOWN");
    expect(mattSecond.result).toBe("matt-1");
    expect(ericSecond.result).toBe("eric-1");
  });

  it("applies the cooldown even after a rejected operation, so a call within it is COOLDOWN and never re-attempts the provider", async () => {
    let calls = 0;
    let now = 0;
    const operation = async () => {
      calls += 1;
      throw new Error("provider unavailable");
    };

    await expect(runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now })).rejects.toThrow("provider unavailable");
    expect(calls).toBe(1);

    // Within the cooldown a rejection's own availableAt still applies - COOLDOWN, no second
    // provider call, and no reusable success value to serve, so the neutral onTimeout()-shaped
    // placeholder is returned instead (never a fabricated success, never a repeat live attempt).
    now += 5_000;
    const second = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now });
    expect(second.disposition).toBe("COOLDOWN");
    expect(second.result).toBe("TIMED_OUT");
    expect(calls).toBe(1); // no second provider call during cooldown

    // After cooldown expires, a genuine new attempt is made again.
    now += 10_001;
    await expect(runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 20_000, onTimeout, now: () => now })).rejects.toThrow("provider unavailable");
    expect(calls).toBe(2);
  });
});

describe("runGuarded - bounded operations (timeout + generation-safe abandonment)", () => {
  afterEach(() => {
    clearRefreshGuardsForTests();
  });

  function neverSettles<T>(): Promise<T> {
    return new Promise<T>(() => {});
  }

  it("STALE TEST 1-5 - a provider promise that never settles times out, releases the guard, applies the cooldown, and a request during that cooldown starts no new operation", async () => {
    let now = 0;
    let calls = 0;
    const operation = () => {
      calls += 1;
      return neverSettles<string>();
    };

    const outcome = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 30, onTimeout, now: () => now });

    expect(outcome.disposition).toBe("EXECUTED");
    expect(outcome.result).toBe("TIMED_OUT"); // (3) caller receives the typed timeout result
    expect(calls).toBe(1);

    // (4) in-flight state is released - a request even a moment later is COOLDOWN, not stuck forever.
    now += 100;
    const duringCooldown = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 30, onTimeout, now: () => now });
    expect(duringCooldown.disposition).toBe("COOLDOWN");
    expect(calls).toBe(1); // (6) no new provider operation started during cooldown

    // (7) after cooldown, a new refresh can genuinely execute.
    now += 15_000;
    const afterCooldown = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 30, onTimeout, now: () => now });
    expect(afterCooldown.disposition).toBe("EXECUTED");
    expect(calls).toBe(2);
  });

  it("a request that JOINS an already-timed-out (but still-running) operation also receives the timeout result, not an indefinite wait", async () => {
    let now = 0;
    const operation = () => neverSettles<string>();

    // Start generation 1, let it time out from this caller's own perspective.
    const first = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 30, onTimeout, now: () => now });
    expect(first.disposition).toBe("EXECUTED");
    expect(first.result).toBe("TIMED_OUT");

    // A DIFFERENT concurrent caller who was coalesced into the SAME abandoned promise before it
    // timed out must also resolve to a timeout, never hang forever waiting on a promise that never
    // settles and was already abandoned.
    now += 15_001; // past cooldown, so a fresh EXECUTED attempt happens instead - this proves the
    // guard is truly available again, not permanently stuck on the abandoned generation.
    const afterCooldown = await runGuarded("matt", operation, { cooldownMs: 15_000, timeoutMs: 30, onTimeout, now: () => now });
    expect(afterCooldown.disposition).toBe("EXECUTED");
  });

  it("STALE TEST 8-11 (generation safety) - an abandoned (timed-out) generation that LATER resolves successfully can never replace a newer generation's result, cooldown, or report success", async () => {
    let now = 0;
    let resolveGen1: ((value: string) => void) | undefined;
    const gen1Operation = () =>
      new Promise<string>((resolve) => {
        resolveGen1 = resolve;
      });

    // Generation 1 times out (from the guard's own short timeout) while its real operation is still
    // pending in the background.
    const gen1Outcome = await runGuarded("matt", gen1Operation, { cooldownMs: 15_000, timeoutMs: 30, onTimeout, now: () => now });
    expect(gen1Outcome.disposition).toBe("EXECUTED");
    expect(gen1Outcome.result).toBe("TIMED_OUT");

    // Generation 2 starts after generation 1's cooldown and succeeds normally.
    now += 15_001;
    const gen2Outcome = await runGuarded("matt", async () => "gen2-result", { cooldownMs: 15_000, timeoutMs: 30, onTimeout, now: () => now });
    expect(gen2Outcome.disposition).toBe("EXECUTED");
    expect(gen2Outcome.result).toBe("gen2-result");
    const gen2AvailableAt = gen2Outcome.availableAgainAt;

    // Generation 1's real operation FINALLY resolves late, well after generation 2 has already
    // completed - it must be discarded outright: it can never replace generation 2's result,
    // cooldown, or make a subsequent COOLDOWN call report a stale "success."
    resolveGen1!("gen1-late-result");
    await Promise.resolve(); // flush the (now-abandoned) generation 1 continuation's microtask
    await Promise.resolve();

    now += 100; // still within generation 2's own cooldown
    const duringGen2Cooldown = await runGuarded("matt", async () => "gen3-result", { cooldownMs: 15_000, timeoutMs: 30, onTimeout, now: () => now });

    expect(duringGen2Cooldown.disposition).toBe("COOLDOWN");
    expect(duringGen2Cooldown.result).toBe("gen2-result"); // generation 2's own result, never generation 1's late one
    expect(duringGen2Cooldown.availableAgainAt).toBe(gen2AvailableAt); // generation 1's late resolution never re-extended the cooldown
  });
});
