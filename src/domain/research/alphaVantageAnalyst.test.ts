import { describe, expect, it } from "vitest";
import { summarizeAlphaVantageAnalystConsensus } from "./alphaVantageAnalyst";

describe("summarizeAlphaVantageAnalystConsensus", () => {
  it("returns null when there is no analyst data at all (never fabricates a Hold)", () => {
    expect(summarizeAlphaVantageAnalystConsensus({ strongBuy: null, buy: null, hold: null, sell: null, strongSell: null })).toBeNull();
    expect(summarizeAlphaVantageAnalystConsensus({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 })).toBeNull();
  });

  it("labels a heavily bullish set as Strong Buy", () => {
    const result = summarizeAlphaVantageAnalystConsensus({ strongBuy: 10, buy: 1, hold: 0, sell: 0, strongSell: 0 });
    expect(result?.label).toBe("Strong Buy");
    expect(result?.totalAnalysts).toBe(11);
  });

  it("labels a moderately bullish set as Buy", () => {
    const result = summarizeAlphaVantageAnalystConsensus({ strongBuy: 2, buy: 6, hold: 3, sell: 0, strongSell: 0 });
    expect(result?.label).toBe("Buy");
  });

  it("labels a mostly-hold set as Hold", () => {
    const result = summarizeAlphaVantageAnalystConsensus({ strongBuy: 1, buy: 1, hold: 8, sell: 1, strongSell: 0 });
    expect(result?.label).toBe("Hold");
  });

  it("labels a bearish set as Sell", () => {
    const result = summarizeAlphaVantageAnalystConsensus({ strongBuy: 0, buy: 0, hold: 2, sell: 6, strongSell: 1 });
    expect(result?.label).toBe("Sell");
  });

  it("labels a heavily bearish set as Strong Sell", () => {
    const result = summarizeAlphaVantageAnalystConsensus({ strongBuy: 0, buy: 0, hold: 0, sell: 1, strongSell: 10 });
    expect(result?.label).toBe("Strong Sell");
  });

  it("treats null counts within a partially-populated set as zero, not as missing data", () => {
    const result = summarizeAlphaVantageAnalystConsensus({ strongBuy: 5, buy: null, hold: null, sell: null, strongSell: null });
    expect(result?.label).toBe("Strong Buy");
    expect(result?.totalAnalysts).toBe(5);
  });

  it("computes the exact documented weighted-average score", () => {
    // 2 StrongBuy(+2) + 2 Sell(-1) = (4 - 2) / 4 = 0.5 -> Buy bucket (> 0.3)
    const result = summarizeAlphaVantageAnalystConsensus({ strongBuy: 2, buy: 0, hold: 0, sell: 2, strongSell: 0 });
    expect(result?.score).toBeCloseTo(0.5);
    expect(result?.label).toBe("Buy");
  });
});
