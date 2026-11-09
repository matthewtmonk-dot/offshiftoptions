import { describe, expect, it } from "vitest";
import { AUTO_QUALITY_LIMIT, nextFinishStep } from "./scan-finish-plan";

describe("nextFinishStep", () => {
  it("prices waiting options before anything else", () => {
    expect(nextFinishStep({ runId: "r1", awaitingOptionCheck: 3, qualityTickers: ["HPE"] })).toEqual({ kind: "price-options", count: 3, signature: "r1:price:3" });
  });

  it("checks company quality once every option is priced", () => {
    expect(nextFinishStep({ runId: "r1", awaitingOptionCheck: 0, qualityTickers: ["HPQ", "FCEL", "HPQ"] })).toEqual({ kind: "check-quality", tickers: ["FCEL", "HPQ"], signature: "r1:quality:FCEL,HPQ" });
  });

  it("has nothing to do on a finished scan", () => {
    expect(nextFinishStep({ runId: "r1", awaitingOptionCheck: 0, qualityTickers: [] })).toBeNull();
  });

  it("gives a new scan a new signature, so it is finished again", () => {
    const first = nextFinishStep({ runId: "r1", awaitingOptionCheck: 5, qualityTickers: [] });
    const second = nextFinishStep({ runId: "r2", awaitingOptionCheck: 5, qualityTickers: [] });
    expect(first?.signature).not.toBe(second?.signature);
  });

  it("bounds one automatic quality pass", () => {
    const tickers = Array.from({ length: AUTO_QUALITY_LIMIT + 10 }, (_, index) => `T${String(index).padStart(3, "0")}`);
    const step = nextFinishStep({ runId: "r1", awaitingOptionCheck: 0, qualityTickers: tickers });
    expect(step?.kind === "check-quality" ? step.tickers.length : 0).toBe(AUTO_QUALITY_LIMIT);
  });
});
