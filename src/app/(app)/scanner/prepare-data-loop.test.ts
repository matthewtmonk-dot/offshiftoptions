import { describe, expect, it, vi } from "vitest";
import { MAX_IDLE_PREPARE_CALLS, runPrepareDataLoop, type PrepareBatchResult } from "./prepare-data-loop";

const batch = (processed: number, remaining: number, failed = 0): PrepareBatchResult => ({
  ok: true,
  state: remaining === 0 ? "COMPLETE" : "IN_PROGRESS",
  processed,
  failed,
  remaining,
});

function loopWith(results: Array<PrepareBatchResult | Error>, extra: Partial<Parameters<typeof runPrepareDataLoop>[0]> = {}) {
  const queue = [...results];
  const prepare = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("prepare called more times than the test expected");
    if (next instanceof Error) throw next;
    return next;
  });
  const onProgress = vi.fn();
  const run = runPrepareDataLoop({ prepare, sleep: async () => {}, shouldStop: () => false, onProgress, ...extra });
  return { prepare, onProgress, run };
}

describe("runPrepareDataLoop", () => {
  it("repeats until the data is complete and reports the totals", async () => {
    const { prepare, onProgress, run } = loopWith([batch(125, 250), batch(125, 125), batch(125, 0, 2)]);
    expect(await run).toEqual({ status: "complete", processed: 375, failed: 2 });
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith({ processed: 375, total: 375 });
  });

  it("stops with the server's own message when Schwab's prices aren't ready", async () => {
    const { run } = loopWith([{ ok: false, error: "Schwab hasn't published the 2026-10-29 daily prices yet." }]);
    expect(await run).toEqual({ status: "error", processed: 0, remaining: null, message: "Schwab hasn't published the 2026-10-29 daily prices yet." });
  });

  it("keeps the progress made before an error and never stays stuck on a thrown action", async () => {
    const { run } = loopWith([batch(125, 500), new Error("fetch failed")]);
    const result = await run;
    expect(result.status).toBe("error");
    expect(result).toMatchObject({ processed: 125, remaining: 500 });
  });

  it("stops at once, without another call, when the user presses Stop", async () => {
    let stop = false;
    const { prepare, run } = loopWith([batch(125, 400), batch(125, 275)], { shouldStop: () => stop, sleep: async () => { stop = true; } });
    const result = await run;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "paused", processed: 125, remaining: 400 });
  });

  it("gives up after several cycles that do no work (another worker holds the rest)", async () => {
    const idle = Array.from({ length: MAX_IDLE_PREPARE_CALLS + 2 }, () => batch(0, 300));
    const { prepare, run } = loopWith(idle);
    const result = await run;
    expect(prepare).toHaveBeenCalledTimes(MAX_IDLE_PREPARE_CALLS);
    expect(result).toMatchObject({ status: "paused", processed: 0, remaining: 300 });
  });

  it("an idle cycle between productive ones does not end the run", async () => {
    const { run } = loopWith([batch(125, 300), batch(0, 300), batch(125, 175), batch(175, 0)]);
    expect(await run).toMatchObject({ status: "complete", processed: 425 });
  });

  it("a run that is already complete finishes immediately", async () => {
    const { prepare, run } = loopWith([batch(0, 0)]);
    expect(await run).toEqual({ status: "complete", processed: 0, failed: 0 });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("caps the number of cycles so it can never loop forever", async () => {
    const { prepare, run } = loopWith(Array.from({ length: 5 }, () => batch(10, 1000)), { maxCalls: 3 });
    const result = await run;
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "paused", processed: 30, remaining: 1000 });
  });
});
