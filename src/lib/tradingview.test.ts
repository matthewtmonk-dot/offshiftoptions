import { describe, expect, it } from "vitest";
import { TRADINGVIEW_CHART_LINKS, tradingViewChartUrl } from "./tradingview";

describe("tradingViewChartUrl", () => {
  it("builds a chart link with the ticker and candle size", () => {
    expect(tradingViewChartUrl("iren")).toBe("https://www.tradingview.com/chart/?symbol=IREN&interval=D");
    expect(tradingViewChartUrl("IREN", "W")).toBe("https://www.tradingview.com/chart/?symbol=IREN&interval=W");
    expect(tradingViewChartUrl(" sofi ", "30")).toBe("https://www.tradingview.com/chart/?symbol=SOFI&interval=30");
  });
  it("allows class-share tickers", () => {
    expect(tradingViewChartUrl("BRK.B")).toContain("symbol=BRK.B");
  });
  it("refuses anything that isn't a plain symbol", () => {
    expect(tradingViewChartUrl("")).toBeNull();
    expect(tradingViewChartUrl("A&B=1")).toBeNull();
    expect(tradingViewChartUrl("https://evil.example")).toBeNull();
    expect(tradingViewChartUrl("<script>")).toBeNull();
    expect(tradingViewChartUrl("TOOLONGTICKERX")).toBeNull();
  });
  it("offers daily, 30-minute and weekly links", () => {
    expect(TRADINGVIEW_CHART_LINKS.map((link) => link.interval)).toEqual(["D", "30", "W"]);
  });
});
