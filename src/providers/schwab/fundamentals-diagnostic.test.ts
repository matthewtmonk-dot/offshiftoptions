import { describe, expect, it } from "vitest";
import { buildSchwabFundamentalsDiagnosticFromToken, buildSchwabFundamentalsDiagnosticReport } from "./fundamentals-diagnostic";

function rowByLabel(report: ReturnType<typeof buildSchwabFundamentalsDiagnosticReport>, label: string) {
  const row = report.rows.find((candidate) => candidate.label === label);
  if (!row) {
    throw new Error(`No diagnostic row for label "${label}"`);
  }
  return row;
}

describe("Schwab fundamentals diagnostic - allowlist and presence semantics", () => {
  const payload = {
    APLD: {
      reference: {
        description: "Applied Digital Corporation",
        exchange: "NASDAQ",
        secretAccountField: "should never surface - not on the allowlist",
      },
      fundamental: {
        peRatio: 18.4,
        eps: null,
        divYield: 0,
        rating: "Bearer abc.def.ghi-should-be-redacted",
      },
      quote: { lastPrice: 12.34, mark: 12.3, quoteTimeInLong: 1735689600000 },
      regular: { regularMarketLastPrice: 12.28 },
    },
  };

  it("marks a present, populated field as PRESENT_VALUE with its real value", () => {
    const report = buildSchwabFundamentalsDiagnosticReport({ payload, symbols: ["APLD"] });
    expect(rowByLabel(report, "P/E").values.APLD).toEqual({ state: "PRESENT_VALUE", value: "18.4" });
    expect(rowByLabel(report, "Description").values.APLD).toEqual({ state: "PRESENT_VALUE", value: "Applied Digital Corporation" });
  });

  it("marks an explicit null field as PRESENT_NULL, never as ABSENT or 0", () => {
    const report = buildSchwabFundamentalsDiagnosticReport({ payload, symbols: ["APLD"] });
    expect(rowByLabel(report, "EPS").values.APLD).toEqual({ state: "PRESENT_NULL", value: null });
  });

  it("marks a genuinely missing field as ABSENT, distinct from PRESENT_NULL", () => {
    const report = buildSchwabFundamentalsDiagnosticReport({ payload, symbols: ["APLD"] });
    expect(rowByLabel(report, "PEG").values.APLD).toEqual({ state: "ABSENT", value: null });
    expect(rowByLabel(report, "PEG ratio").values.APLD).toEqual({ state: "ABSENT", value: null });
  });

  it("preserves a real 0 value as PRESENT_VALUE, never collapsing it to ABSENT/NULL", () => {
    const report = buildSchwabFundamentalsDiagnosticReport({ payload, symbols: ["APLD"] });
    expect(rowByLabel(report, "Dividend yield").values.APLD).toEqual({ state: "PRESENT_VALUE", value: "0" });
  });

  it("redacts a token/secret-shaped value even from an allowlisted field, without leaking it", () => {
    const report = buildSchwabFundamentalsDiagnosticReport({ payload, symbols: ["APLD"] });
    const rating = rowByLabel(report, "Rating").values.APLD;
    expect(rating.state).toBe("PRESENT_UNDISPLAYED");
    expect(rating.value).toBe("Value hidden by safety filter.");
    expect(JSON.stringify(report)).not.toContain("abc.def.ghi");
  });

  it("never surfaces a field that is not on the allowlist, no matter what Schwab returned", () => {
    const report = buildSchwabFundamentalsDiagnosticReport({ payload, symbols: ["APLD"] });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secretAccountField");
    expect(serialized).not.toContain("should never surface");
    expect(report.rows.some((row) => row.label.toLowerCase().includes("secret"))).toBe(false);
  });

  it("determines OSO's real price fallback winner per symbol, in the documented order", () => {
    const winsOnLastPrice = buildSchwabFundamentalsDiagnosticReport({ payload, symbols: ["APLD"] });
    expect(winsOnLastPrice.priceSources[0]).toMatchObject({ symbol: "APLD", path: "quote.lastPrice", value: "12.34", status: "AVAILABLE" });

    const winsOnRegular = buildSchwabFundamentalsDiagnosticReport({
      payload: { RIOT: { quote: {}, regular: { regularMarketLastPrice: 9.87 } } },
      symbols: ["RIOT"],
    });
    expect(winsOnRegular.priceSources[0]).toMatchObject({ path: "regular.regularMarketLastPrice", value: "9.87" });

    const winsOnMark = buildSchwabFundamentalsDiagnosticReport({
      payload: { CORZ: { quote: { mark: 7.5 } } },
      symbols: ["CORZ"],
    });
    expect(winsOnMark.priceSources[0]).toMatchObject({ path: "quote.mark", value: "7.5" });

    const noUsablePrice = buildSchwabFundamentalsDiagnosticReport({
      payload: { CORZ: { quote: {}, regular: {} } },
      symbols: ["CORZ"],
    });
    expect(noUsablePrice.priceSources[0]).toMatchObject({ status: "UNAVAILABLE", path: null, value: null });
  });

  it("reports the exact request path/fields/symbols used, matching the app's own getQuote() call", () => {
    const report = buildSchwabFundamentalsDiagnosticReport({ payload, symbols: ["APLD"] });
    expect(report.quoteRequest).toEqual({
      path: "GET /marketdata/v1/quotes",
      fields: "quote,reference,regular,fundamental",
      symbols: ["APLD"],
    });
    expect(report.readOnly).toBe(true);
    expect(report.nothingSaved).toBe(true);
  });

  it("never includes the access token used to fetch the payload anywhere in the built report", async () => {
    const sentinelToken = "sentinel-access-token-must-never-leak";
    const fetchFn = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

    const report = await buildSchwabFundamentalsDiagnosticFromToken({
      accessToken: sentinelToken,
      symbols: ["APLD"],
      fetchFn,
      now: new Date("2026-09-04T12:00:00Z"),
    });

    expect(JSON.stringify(report)).not.toContain(sentinelToken);
  });

  it("falls back to getInstrument() only when reference.description is absent or null, and never otherwise", async () => {
    let instrumentCalls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/instruments")) {
        instrumentCalls += 1;
        return new Response(JSON.stringify({ instruments: [{ symbol: "RIOT", description: "Riot Platforms Inc", assetType: "EQUITY" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ RIOT: { reference: {}, quote: {}, regular: {} } }), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await buildSchwabFundamentalsDiagnosticFromToken({
      accessToken: "unused-in-this-test",
      symbols: ["RIOT"],
      fetchFn,
      now: new Date("2026-09-04T12:00:00Z"),
    });

    expect(instrumentCalls).toBe(1);
    expect(report.instrumentUse).toMatchObject({ used: true, symbols: ["RIOT"] });
  });
});
