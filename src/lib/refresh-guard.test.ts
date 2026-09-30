import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRefreshGuardsForTests, runGuarded } from "./refresh-guard";

describe("runGuarded", () => {
  afterEach(() => {
    clearRefreshGuardsForTests();
  });

  it("two concurrent calls for the SAME key coalesce into exactly one underlying operation", async () => {
    let calls = 0;
    let resolveOp: ((value: string) => void) | undefined;
    const operation = () =>
      new Promise<string>((resolve) => {
        calls += 1;
        resolveOp = resolve;
      });

    const first = runGuarded("matt", 15_000, operation);
    const second = runGuarded("matt", 15_000, operation);
    resolveOp!("done");

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(calls).toBe(1); // only ONE underlying operation ever started
    expect(firstOutcome.result).toBe("done");
    expect(secondOutcome.result).toBe("done"); // both callers receive the coherent result
    expect(firstOutcome.startedNewOperation).toBe(true);
    expect(secondOutcome.startedNewOperation).toBe(false); // coalesced, never started its own
  });

  it("a call for a DIFFERENT key never coalesces with or blocks another key's operation", async () => {
    let mattCalls = 0;
    let ericCalls = 0;

    const [mattOutcome, ericOutcome] = await Promise.all([
      runGuarded("matt", 15_000, async () => {
        mattCalls += 1;
        return "matt-result";
      }),
      runGuarded("eric", 15_000, async () => {
        ericCalls += 1;
        return "eric-result";
      }),
    ]);

    expect(mattCalls).toBe(1);
    expect(ericCalls).toBe(1);
    expect(mattOutcome.result).toBe("matt-result");
    expect(ericOutcome.result).toBe("eric-result");
  });

  it("a call for the same key WITHIN the cooldown window reuses the last result and starts no new operation", async () => {
    let calls = 0;
    let now = 0;
    const operation = async () => {
      calls += 1;
      return `result-${calls}`;
    };

    const first = await runGuarded("matt", 15_000, operation, () => now);
    expect(first.startedNewOperation).toBe(true);
    expect(first.result).toBe("result-1");

    now += 5_000; // still within the 15s cooldown
    const second = await runGuarded("matt", 15_000, operation, () => now);
    expect(second.startedNewOperation).toBe(false);
    expect(second.result).toBe("result-1"); // reused, never a fresh "result-2"
    expect(calls).toBe(1); // no second underlying operation triggered
  });

  it("a call for the same key AFTER the cooldown expires starts a genuine new operation", async () => {
    let calls = 0;
    let now = 0;
    const operation = async () => {
      calls += 1;
      return `result-${calls}`;
    };

    await runGuarded("matt", 15_000, operation, () => now);
    now += 15_001; // cooldown has just expired
    const second = await runGuarded("matt", 15_000, operation, () => now);

    expect(second.startedNewOperation).toBe(true);
    expect(second.result).toBe("result-2");
    expect(calls).toBe(2);
  });

  it("applies the cooldown even after a rejected operation, so rapid failed calls cannot hammer the provider", async () => {
    let calls = 0;
    let now = 0;
    const operation = async () => {
      calls += 1;
      throw new Error("provider unavailable");
    };

    await expect(runGuarded("matt", 15_000, operation, () => now)).rejects.toThrow("provider unavailable");
    expect(calls).toBe(1);

    now += 5_000; // still within cooldown
    await expect(runGuarded("matt", 15_000, operation, () => now)).rejects.toThrow("provider unavailable");
    expect(calls).toBe(2); // a rejection has no reusable "last result" to serve, so it retries -
    // but the cooldown window (availableAgainAt) is still what the caller uses to decide whether to
    // even attempt again; runGuarded itself only refuses to reuse a non-existent success value.
  });

  it("Matt and Eric each have fully independent in-flight/cooldown state", async () => {
    let now = 0;
    const mattOp = vi.fn(async () => "matt-1");
    const ericOp = vi.fn(async () => "eric-1");

    await runGuarded("matt", 15_000, mattOp, () => now);
    await runGuarded("eric", 15_000, ericOp, () => now);

    now += 5_000;
    const mattSecond = await runGuarded("matt", 15_000, mattOp, () => now);
    const ericSecond = await runGuarded("eric", 15_000, ericOp, () => now);

    expect(mattOp).toHaveBeenCalledTimes(1); // Matt's second call reused his own cooldown result
    expect(ericOp).toHaveBeenCalledTimes(1); // Eric's second call reused his own cooldown result
    expect(mattSecond.result).toBe("matt-1");
    expect(ericSecond.result).toBe("eric-1");
  });
});
