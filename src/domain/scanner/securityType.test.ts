import { describe, expect, it } from "vitest";
import { excludedSecurityFor } from "./securityType";

const kind = (ticker: string, description: string | null | undefined, subType?: string | null) => excludedSecurityFor(ticker, description, subType)?.kind ?? null;

describe("excludedSecurityFor", () => {
  it("excludes option-income funds by description", () => {
    expect(kind("XYZY", "YieldMax ULTY Option Income Strategy ETF")).toBe("OPTION_INCOME");
    expect(kind("XYZ", "Global X NASDAQ 100 Covered Call ETF")).toBe("OPTION_INCOME");
    expect(kind("XYZ", "Roundhill WeeklyPay Something ETF")).toBe("OPTION_INCOME");
  });

  it("excludes leveraged funds by description", () => {
    expect(kind("XYZ", "Direxion Daily Semiconductor Bull 3X Shares")).toBe("LEVERAGED");
    expect(kind("XYZ", "ProShares Ultra QQQ")).toBe("LEVERAGED"); // "ProShares" has no fund marker word, "QQQ" none either
  });

  it("excludes inverse funds by description", () => {
    expect(kind("XYZ", "ProShares UltraShort S&P500")).toBe("INVERSE");
    expect(kind("XYZ", "Direxion Daily S&P 500 Bear 3X Shares")).toBe("INVERSE");
    expect(kind("XYZ", "Some Inverse Nasdaq ETF")).toBe("INVERSE");
  });

  it("excludes preferred-stock funds by description", () => {
    expect(kind("XYZ", "iShares Preferred and Income Securities ETF")).toBe("PREFERRED");
    expect(kind("XYZ", "Invesco Preferred ETF")).toBe("PREFERRED");
  });

  it("never excludes an ordinary company whose name happens to contain a keyword", () => {
    expect(kind("UCTT", "Ultra Clean Holdings, Inc.")).toBeNull();
    expect(kind("PFBC", "Preferred Bank")).toBeNull();
    expect(kind("BULL", "Webull Corporation")).toBeNull();
  });

  it("by description alone, plain diversified ETFs and bond funds are not a leveraged/income/preferred kind", () => {
    expect(kind("SPY", "SPDR S&P 500 ETF Trust")).toBeNull();
    expect(kind("VTI", "Vanguard Total Stock Market ETF")).toBeNull();
    expect(kind("XYZ", "iShares 1-3 Year Treasury Short-Term Bond ETF")).toBeNull();
  });

  it("excludes any ETF/ETN by Schwab's own asset sub-type, but never an ordinary company or an unknown sub-type", () => {
    expect(kind("DBA", "Invesco DB Agriculture Fund", "ETF")).toBe("ETF");
    expect(kind("DBC", null, "etf")).toBe("ETF");
    expect(kind("XYZ", "Some Note", "ETN")).toBe("ETF");
    expect(kind("HPQ", "HP Inc", "COE")).toBeNull();
    expect(kind("AAPL", "Apple Inc", "ADR")).toBeNull();
    expect(kind("HPQ", "HP Inc", null)).toBeNull();
    expect(kind("HPQ", "HP Inc", undefined)).toBeNull();
    expect(excludedSecurityFor("DBA", "x", "ETF")?.reason).toMatch(/^Excluded: exchange-traded fund/);
  });

  it("a specific fund kind (leveraged, income) wins over the generic ETF reason", () => {
    expect(kind("XYZ", "YieldMax XYZ Option Income Strategy ETF", "ETF")).toBe("OPTION_INCOME");
    expect(kind("PLTU", null, "ETF")).toBe("LEVERAGED");
    expect(kind("FEPI", null, "ETF")).toBe("OPTION_INCOME");
  });

  it("falls back to a known-ticker list when the description is missing, but not for unknown tickers", () => {
    expect(kind("ULTY", null)).toBe("OPTION_INCOME");
    expect(kind("sqqq", undefined)).toBe("INVERSE");
    expect(kind("PFF", "")).toBe("PREFERRED");
    expect(kind("AGQ", null)).toBe("LEVERAGED");
    expect(kind("HPQ", null)).toBeNull();
    expect(kind("LUNR", "Intuitive Machines, Inc.")).toBeNull();
  });

  it("gives a plain-English reason", () => {
    expect(excludedSecurityFor("ULTY", null)?.reason).toMatch(/^Excluded: option-income fund/);
  });
});
