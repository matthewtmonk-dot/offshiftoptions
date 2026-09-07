import { describe, expect, it } from "vitest";
import { auditOccDlpText, fetchOccOptionableSymbols, parseOccDlpText } from "./directory-of-listed-products";

function fetchFnReturning(text: string, status = 200) {
  return (async () => new Response(text, { status, statusText: status === 200 ? "OK" : "Error" })) as unknown as typeof fetch;
}

// Real rows fetched live (2026-09) from OCC's own documented DLP HTTP Download
// (marketdata.theocc.com/delo-download?prodType=EU&downloadFields=OS;US;SN;EXCH;ONN&format=txt) -
// tab-delimited, no header row, CRLF line endings. Confirms: no header row; AAL present as a
// plain single-root underlying; AACT/KDK where Options Symbol and Underlying Symbol genuinely
// diverge (a corporate-action renaming case, still one usable underlying); BYND/BYND1 where a
// legacy split-adjusted contract root duplicates an existing underlying; BRKB (OCC's own
// concatenated form for the Berkshire Hathaway Class B dual-class ticker - OCC never uses the
// dotted "BRK.B" form Cboe used, a real, non-obvious source-format difference).
const REAL_SAMPLE =
  "AAL   \tAAL   \tAmerican Airlines Group, Inc.                      \tABCDEHIJLMPQRTUWXZ\tEU\t\r\n" +
  "AACT  \tKDK   \tARES ACQUISITION CORPORATION II                    \tABCDEHIJLMPQRTUWXZ\tEU\t\r\n" +
  "BRKB  \tBRKB  \tBerkshire Hathaway Inc. - Cl B                     \tABCDEHIJLMPQRTUWXZ\tEU\t\r\n" +
  "BYND  \tBYND  \tBEYOND MEAT, INC.                                  \tABCDEHIJLMPQRTUWXZ\tEU\t\r\n" +
  "BYND1 \tBYND  \tBEYOND MEAT, INC.(1:30)                            \tABCEHIJLMPQRTUWXZ\tEU\t\r\n";

describe("parseOccDlpText", () => {
  it("parses real OCC DLP HTTP Download rows with no header row into ticker/name pairs", () => {
    const symbols = parseOccDlpText(REAL_SAMPLE);
    expect(symbols.map((s) => s.ticker).sort()).toEqual(["AAL", "BRKB", "BYND", "KDK"]);
  });

  it("keeps Options Symbol and Underlying Symbol as genuinely distinct when they diverge (AACT/KDK)", () => {
    const symbols = parseOccDlpText(REAL_SAMPLE);
    const kdk = symbols.find((s) => s.ticker === "KDK");
    expect(kdk).toBeDefined();
    expect(kdk?.name).toContain("ARES ACQUISITION");
    expect(symbols.find((s) => s.ticker === "AACT")).toBeUndefined();
  });

  it("dedupes a legacy split-adjusted Options Symbol (BYND1) into its one real underlying (BYND), preferring the canonical row's name", () => {
    const symbols = parseOccDlpText(REAL_SAMPLE);
    const bynd = symbols.filter((s) => s.ticker === "BYND");
    expect(bynd).toHaveLength(1);
    // The canonical row (Options Symbol === Underlying Symbol) wins, never the "(1:30)"-annotated one.
    expect(bynd[0].name).toBe("BEYOND MEAT, INC.");
  });

  it("prefers the canonical row's name even when the non-canonical duplicate is listed first in the file", () => {
    const reordered =
      "BYND1 \tBYND  \tBEYOND MEAT, INC.(1:30)                            \tABCEHIJLMPQRTUWXZ\tEU\t\r\n" +
      "BYND  \tBYND  \tBEYOND MEAT, INC.                                  \tABCDEHIJLMPQRTUWXZ\tEU\t\r\n";
    const symbols = parseOccDlpText(reordered);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("BEYOND MEAT, INC.");
  });

  it("passes OCC's own concatenated dual-class form (BRKB) through unchanged - OCC never uses Cboe's dotted BRK.B form", () => {
    const symbols = parseOccDlpText(REAL_SAMPLE);
    expect(symbols.find((s) => s.ticker === "BRKB")?.name).toBe("Berkshire Hathaway Inc. - Cl B");
  });

  it("excludes a row whose Product Type (ONN) is not EU, even if it otherwise looks well-formed", () => {
    const csv = "MRUT  \tMRUT  \tMini Russell 2000 Index Options                   \tIJ\tIU\t\r\n";
    expect(parseOccDlpText(csv)).toEqual([]);
  });

  it("excludes a row with a blank underlying symbol", () => {
    const csv = "AAL   \t      \tAmerican Airlines Group, Inc.                      \tABCDEHIJLMPQRTUWXZ\tEU\t\r\n";
    expect(parseOccDlpText(csv)).toEqual([]);
  });

  it("excludes a row that fails OSO's own ticker format rule, rather than sending it to Schwab unchecked", () => {
    const csv = "$SPX  \t$SPX  \tIndex Only Symbol                                  \tABC\tEU\t\r\n";
    expect(parseOccDlpText(csv)).toEqual([]);
  });

  it("fails safely (returns empty) for OCC's own 'No data exists.' empty-result response, rather than throwing", () => {
    expect(parseOccDlpText("No data exists.\r\n")).toEqual([]);
  });

  it("fails safely (returns empty) for a truly empty response", () => {
    expect(parseOccDlpText("")).toEqual([]);
  });
});

describe("auditOccDlpText", () => {
  it("reports raw row count, normalized (deduplicated) count, and zero exclusions for a clean real-shaped file", () => {
    const audit = auditOccDlpText(REAL_SAMPLE);
    expect(audit.rawRowCount).toBe(5);
    expect(audit.normalizedSymbolCount).toBe(4); // AAL, KDK, BRKB, BYND (BYND1 dedupes into BYND)
    expect(audit.excludedRowCount).toBe(0);
    expect(audit.exclusionReasons).toEqual([]);
  });

  it("reports exclusion reasons and counts for wrong-product-type, blank, and format-invalid rows", () => {
    const csv =
      "GOOD  \tGOOD  \tGood Corp                                          \tABC\tEU\t\r\n" +
      "MRUT  \tMRUT  \tMini Russell 2000 Index Options                   \tIJ\tIU\t\r\n" +
      "BAD   \t      \tNo Symbol Corp                                     \tABC\tEU\t\r\n" +
      "IDX   \t$SPX  \tIndex Only                                         \tABC\tEU\t\r\n" +
      "No data exists.\r\n";
    const audit = auditOccDlpText(csv);
    expect(audit.rawRowCount).toBe(5);
    expect(audit.normalizedSymbolCount).toBe(1); // only GOOD
    expect(audit.excludedRowCount).toBe(4);
    const reasonsByLabel = Object.fromEntries(audit.exclusionReasons.map((r) => [r.reason, r.count]));
    expect(reasonsByLabel["Excluded product type (IU)"]).toBe(1);
    expect(reasonsByLabel["Blank underlying symbol"]).toBe(1);
    expect(reasonsByLabel["Failed OSO ticker format rule (isValidTicker)"]).toBe(1);
    expect(reasonsByLabel["Malformed row (fewer than 5 fields)"]).toBe(1); // "No data exists."
  });
});

describe("fetchOccOptionableSymbols", () => {
  it("returns SUCCESS with parsed, deduplicated symbols on a real-shaped 200 response", async () => {
    const result = await fetchOccOptionableSymbols({ fetchFn: fetchFnReturning(REAL_SAMPLE) });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.symbols.length).toBeGreaterThan(0);
  });

  it("also reports the raw row count and excluded row count alongside the deduplicated symbols", async () => {
    const result = await fetchOccOptionableSymbols({ fetchFn: fetchFnReturning(REAL_SAMPLE) });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.rawRowCount).toBe(5); // AAL, AACT/KDK, BRKB, BYND, BYND1
    expect(result.excludedRowCount).toBe(0);
    expect(result.symbols).toHaveLength(4); // BYND1 dedupes into BYND
  });

  it("classifies a non-2xx status as HTTP_ERROR", async () => {
    const result = await fetchOccOptionableSymbols({ fetchFn: fetchFnReturning("", 500) });
    expect(result.outcome).toBe("HTTP_ERROR");
  });

  it("classifies OCC's own 'No data exists.' response as EMPTY, not a crash", async () => {
    const result = await fetchOccOptionableSymbols({ fetchFn: fetchFnReturning("No data exists.\r\n") });
    expect(result.outcome).toBe("EMPTY");
  });

  it("requests prodType=EU and the expected downloadFields", async () => {
    let requestedUrl: URL | undefined;
    const fetchFn = (async (input: unknown) => {
      requestedUrl = input as URL;
      return new Response(REAL_SAMPLE, { status: 200 });
    }) as unknown as typeof fetch;

    await fetchOccOptionableSymbols({ fetchFn });
    expect(requestedUrl?.searchParams.get("prodType")).toBe("EU");
    expect(requestedUrl?.searchParams.get("downloadFields")).toBe("OS;US;SN;EXCH;ONN");
    expect(requestedUrl?.searchParams.get("format")).toBe("txt");
  });
});
