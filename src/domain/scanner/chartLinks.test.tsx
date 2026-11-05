import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chartLinksFor, chartSymbolFor } from "./chartLinks";
import { ChartLinks } from "@/components/chart-links";

describe("chartSymbolFor", () => {
  it("normalizes case and writes class shares with a dot", () => {
    expect(chartSymbolFor(" arqq ")).toBe("ARQQ");
    expect(chartSymbolFor("BRK-B")).toBe("BRK.B");
    expect(chartSymbolFor("BF.B")).toBe("BF.B");
  });

  it("rejects anything that is not a ticker, so nothing odd can end up in a link", () => {
    for (const bad of ["", "1ABC", "A B", "../x", "A&b=1", "AAA#frag", "TOOLONGTICKER1", "<s>", "A\nB", "javascript:alert(1)"]) {
      expect(chartSymbolFor(bad)).toBeNull();
      expect(chartLinksFor(bad)).toEqual([]);
    }
  });
});

describe("chartLinksFor", () => {
  const [sixMonth, daily] = chartLinksFor("ARQQ");

  it("gives a 6-month link and a daily link, both on TradingView's embeddable chart over https", () => {
    expect(sixMonth.key).toBe("6M");
    expect(daily.key).toBe("D");
    for (const link of [sixMonth, daily]) {
      const url = new URL(link.url);
      expect(url.protocol).toBe("https:");
      expect(url.host).toBe("s.tradingview.com");
      expect(url.pathname).toBe("/widgetembed/");
      expect(url.searchParams.get("symbol")).toBe("ARQQ");
      expect(url.searchParams.get("theme")).toBe("dark");
    }
  });

  it("has Bollinger Bands and RSI switched on in both", () => {
    for (const link of [sixMonth, daily]) {
      const studies = new URL(link.url).searchParams.get("studies") ?? "";
      expect(studies).toContain("BB@tv-basicstudies");
      expect(studies).toContain("RSI@tv-basicstudies");
    }
  });

  it("6M asks for the 6-month range; D asks for daily candles", () => {
    expect(new URL(sixMonth.url).searchParams.get("range")).toBe("6M");
    expect(new URL(daily.url).searchParams.get("interval")).toBe("D");
    expect(new URL(daily.url).searchParams.get("range")).toBeNull();
  });

  it("carries only the ticker: no account, position or app information", () => {
    for (const link of [sixMonth, daily]) {
      const params = [...new URL(link.url).searchParams.keys()].sort();
      expect(params).toEqual(["allow_symbol_change", "hidesidetoolbar", "interval", "locale", "studies", "style", "symbol", "theme", "timezone", "withdateranges", ...(link.key === "6M" ? ["range"] : [])].sort());
    }
  });

  it("encodes a class-share ticker safely", () => {
    const [link] = chartLinksFor("brk-b");
    expect(new URL(link.url).searchParams.get("symbol")).toBe("BRK.B");
  });
});

describe("ChartLinks component", () => {
  it("renders two new-tab links with no referrer, and nothing for a bad ticker", () => {
    const markup = renderToStaticMarkup(<ChartLinks ticker="ARQQ" />);
    expect(markup.match(/target="_blank"/g)?.length).toBe(2);
    expect(markup.match(/rel="noopener noreferrer"/g)?.length).toBe(2);
    expect(markup.match(/referrerpolicy="no-referrer"/gi)?.length).toBe(2);
    expect(markup).toContain(">6M<");
    expect(markup).toContain(">D<");
    expect(renderToStaticMarkup(<ChartLinks ticker="not a ticker" />)).toBe("");
  });
});
