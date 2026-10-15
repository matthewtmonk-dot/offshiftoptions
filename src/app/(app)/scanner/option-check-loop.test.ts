import { describe, expect, it, vi } from "vitest";
import { MAX_ROWS_PER_CLICK, runOptionCheckLoop, type OptionCheckBatchResult } from "./option-check-loop";

const batch = (checked: number, remaining: number, extra: Partial<Extract<OptionCheckBatchResult, { ok: true }>> = {}): OptionCheckBatchResult => ({
  ok: true, checked, failedLookups: 0, remaining, newPass: 0, newNear: 0, ...extra,
});

function run(results: OptionCheckBatchResult[], options: { awaiting?: number; stopAfterCalls?: number } = {}) {
  const queue = [...results];
  const checkBatch = vi.fn(async () => queue.shift() ?? batch(0, 0));
  const sleep = vi.fn(async () => {});
  const progress: Array<{ checked: number; target: number }> = [];
  const promise = runOptionCheckLoop({
    awaiting: options.awaiting ?? 30,
    checkBatch,
    sleep,
    shouldStop: () => options.stopAfterCalls !== undefined && checkBatch.mock.calls.length >= options.stopAfterCalls,
    onProgress: (p) => progress.push(p),
  });
  return { promise, checkBatch, sleep, progress };
}

describe("runOptionCheckLoop", () => {
  it("keeps going batch by batch until nothing is left, pausing between batches (not after the last)", async () => {
    const { promise, checkBatch, sleep } = run([batch(12, 18, { newPass: 2 }), batch(12, 6, { newNear: 1 }), batch(6, 0, { newPass: 1 })]);
    const result = await promise;
    expect(result).toEqual({ status: "done", checked: 30, pass: 3, near: 1, remaining: 0, note: null });
    expect(checkBatch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops at the per-click cap even if more are waiting", async () => {
    const batches = Array.from({ length: 10 }, (_, i) => batch(12, 200 - (i + 1) * 12));
    const { promise, checkBatch } = run(batches, { awaiting: 200 });
    const result = await promise;
    expect(MAX_ROWS_PER_CLICK).toBe(60);
    expect(result).toMatchObject({ status: "done", checked: 60 });
    expect(checkBatch).toHaveBeenCalledTimes(5);
    expect((result as { remaining: number }).remaining).toBeGreaterThan(0);
  });

  it("stops promptly when the user presses Stop or leaves the page, keeping what was already priced", async () => {
    const { promise, checkBatch } = run([batch(12, 18), batch(12, 6), batch(6, 0)], { stopAfterCalls: 1 });
    const result = await promise;
    expect(checkBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "done", checked: 12, remaining: 18 });
  });

  it("surfaces a refusal (e.g. rules changed, scan too old, Schwab not connected) as an error and stops", async () => {
    const { promise, checkBatch } = run([batch(12, 18), { ok: false, error: "Run a new live scan first." }]);
    expect(await promise).toEqual({ status: "error", message: "Run a new live scan first." });
    expect(checkBatch).toHaveBeenCalledTimes(2);
  });

  it("explains a round where Schwab priced nothing, and does not spin on it", async () => {
    const { promise, checkBatch } = run([batch(0, 12, { failedLookups: 12 })], { awaiting: 12 });
    const result = await promise;
    expect(checkBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "done", checked: 0, remaining: 12 });
    expect((result as { note: string | null }).note).toMatch(/rate limiting/);
  });

  it("finishes quietly (no scary note) when there was simply nothing left to price", async () => {
    const result = await run([batch(0, 0)], { awaiting: 5 }).promise;
    expect(result).toEqual({ status: "done", checked: 0, pass: 0, near: 0, remaining: 0, note: null });
  });

  it("reports progress against the capped target", async () => {
    const { promise, progress } = run([batch(12, 0)], { awaiting: 12 });
    await promise;
    expect(progress[0]).toEqual({ checked: 0, target: 12 });
    expect(progress.at(-1)).toEqual({ checked: 12, target: 12 });
  });
});
