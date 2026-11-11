import { describe, expect, it } from "vitest";
import { ETHICS_QUEUE_LIMIT, ethicsResearchQueue, ethicsResearchRequest, type EthicsQueueInput } from "./ethicsQueue";

const row = (ticker: string, overrides: Partial<EthicsQueueInput> = {}): EthicsQueueInput => ({ ticker, readiness: "PASS", score: 90, worthALook: true, researched: false, ...overrides });

describe("ethicsResearchQueue", () => {
  it("lists only unresearched companies that are worth a look", () => {
    const queue = ethicsResearchQueue([
      row("AAA"),
      row("BBB", { researched: true }),
      row("CCC", { worthALook: false, readiness: "FAIL" }),
    ]);
    expect(queue).toEqual(["AAA"]);
  });

  it("puts the names closest to being a pick first: PASS, NEAR, then waiting on prices, by score", () => {
    const queue = ethicsResearchQueue([
      row("WAIT", { readiness: "NEEDS_DATA", score: 99 }),
      row("NEAR", { readiness: "NEAR", score: 95 }),
      row("PASSLOW", { readiness: "PASS", score: 80 }),
      row("PASSHIGH", { readiness: "PASS", score: 100 }),
    ]);
    expect(queue).toEqual(["PASSHIGH", "PASSLOW", "NEAR", "WAIT"]);
  });

  it("names a ticker once and never more than one batch", () => {
    expect(ethicsResearchQueue([row("AAA"), row("AAA")])).toEqual(["AAA"]);
    const many = Array.from({ length: ETHICS_QUEUE_LIMIT + 10 }, (_, index) => row(`T${String(index).padStart(2, "0")}`));
    expect(ethicsResearchQueue(many)).toHaveLength(ETHICS_QUEUE_LIMIT);
  });

  it("is empty when everything worth a look is already researched", () => {
    expect(ethicsResearchQueue([row("AAA", { researched: true })])).toEqual([]);
  });
});

describe("ethicsResearchRequest", () => {
  it("names every ticker and every category of the screen", () => {
    const text = ethicsResearchRequest(["HPE", "ASYS"]);
    expect(text).toContain("Tickers: HPE, ASYS");
    for (const category of ["abortion", "pornography", "gambling", "predatory lending", "substances", "donations"]) {
      expect(text).toContain(category);
    }
  });
});
