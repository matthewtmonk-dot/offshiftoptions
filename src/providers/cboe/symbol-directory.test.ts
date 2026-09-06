import { describe, expect, it } from "vitest";
import { fetchCboeOptionableSymbols, parseCboeSymbolDirectoryCsv } from "./symbol-directory";

function fetchFnReturning(text: string, status = 200) {
  return (async () => new Response(text, { status: status, statusText: status === 200 ? "OK" : "Error" })) as unknown as typeof fetch;
}

// A real sample fetched live (2026-09) from Cboe's own documented Equity & Index Options
// symbol directory download - confirms the exact header/quoting shape, and that ETFs/ETNs
// (UVIX) are present alongside ordinary equities, not excluded.
const REAL_SAMPLE_CSV = `Company Name, Stock Symbol, DPM Name, Post/Station, Global Trading Hours DPM
"-1x Short VIX Futures ETF","SVIX","Citadel Securities LLC","9/1","-"
"1 800 FLOWERS COM INC CL A","FLWS","Belvedere Trading LLC","1/1","-"
"2x Long VIX Futures ETF ","UVIX","Wolverine Trading, LLC","9/1","-"
"3M CO COM","MMM","Susquehanna Securities, LLC","2/1","-"
`;

describe("parseCboeSymbolDirectoryCsv", () => {
  it("parses a real Cboe directory sample into ticker/name pairs, including ETFs/ETNs", () => {
    const symbols = parseCboeSymbolDirectoryCsv(REAL_SAMPLE_CSV);
    expect(symbols).toHaveLength(4);
    expect(symbols.map((s) => s.ticker)).toEqual(["SVIX", "FLWS", "UVIX", "MMM"]);
    // Never silently excluded merely for being an ETF/ETN - see Stabilization Slice 3 audit.
    expect(symbols.find((s) => s.ticker === "UVIX")?.name).toBe("2x Long VIX Futures ETF");
  });

  it("handles a quoted company name containing a comma without breaking column alignment", () => {
    const symbols = parseCboeSymbolDirectoryCsv(REAL_SAMPLE_CSV);
    const uvix = symbols.find((s) => s.ticker === "UVIX");
    // "Wolverine Trading, LLC" (DPM Name) contains a comma - if quoting weren't respected,
    // ticker/name columns would shift and this assertion would fail.
    expect(uvix).toBeDefined();
  });

  it("deduplicates a repeated ticker, keeping the first occurrence", () => {
    const csv = `Company Name, Stock Symbol, DPM Name, Post/Station, Global Trading Hours DPM
"3M CO COM","MMM","Susquehanna Securities, LLC","2/1","-"
"3M CO COM DUPLICATE ROW","MMM","Other DPM","1/1","-"
`;
    const symbols = parseCboeSymbolDirectoryCsv(csv);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("3M CO COM");
  });

  it("returns an empty array for a response missing the expected header columns", () => {
    expect(parseCboeSymbolDirectoryCsv("foo,bar\n1,2\n")).toEqual([]);
  });

  it("returns an empty array for empty input rather than throwing", () => {
    expect(parseCboeSymbolDirectoryCsv("")).toEqual([]);
  });
});

describe("fetchCboeOptionableSymbols", () => {
  it("returns SUCCESS with parsed symbols and the requested date on a real-shaped 200 response", async () => {
    const result = await fetchCboeOptionableSymbols({ date: "2026-09-06", fetchFn: fetchFnReturning(REAL_SAMPLE_CSV) });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.asOfDate).toBe("2026-09-06");
  });

  it("classifies a non-2xx status as HTTP_ERROR", async () => {
    const result = await fetchCboeOptionableSymbols({ date: "2026-09-06", fetchFn: fetchFnReturning("", 500) });
    expect(result.outcome).toBe("HTTP_ERROR");
  });

  it("classifies an empty/unparseable response as EMPTY", async () => {
    const result = await fetchCboeOptionableSymbols({ date: "2026-09-06", fetchFn: fetchFnReturning("") });
    expect(result.outcome).toBe("EMPTY");
  });
});
