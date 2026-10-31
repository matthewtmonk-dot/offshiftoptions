import { describe, expect, it } from "vitest";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import { evaluateLiveMarketScan, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import { SCANNER_RULE_DEFINITIONS } from "./profile";
import type { ScannerRule } from "./scanner";

// New-put earnings rules in the live scan: calendar buffer + a full trading session to exit, and an explicit
// "verify the earnings date" state for anything that is not a current, single date.

const asOf = new Date("2026-09-16T14:00:00Z"); // Wednesday
const ready: LiveScanTechnicalLookup = { state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28 };
const rules: ScannerRule[] = SCANNER_RULE_DEFINITIONS.filter((rule) => rule.defaultEnabled).map((rule) => ({
  key: rule.key,
  name: rule.name,
  operator: rule.operator,
  desired: rule.defaultDesired,
}));

function put(expiration: string): OptionContractSnapshot {
  return {
    symbol: "P-TEST",
    underlyingSymbol: "TEST",
    optionType: "PUT",
    strike: 19,
    expiration: new Date(`${expiration}T20:00:00Z`),
    bid: 0.25,
    ask: 0.3,
    mark: 0.275,
    openInterest: 200,
    volume: 41,
    delta: -0.2,
  };
}

async function scan(options: { expiration: string; asOf?: Date; earningsLookup?: Map<string, LiveScanEarningsLookup> }) {
  const when = options.asOf ?? asOf;
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: 2_000_000, asOf: when }; },
    async getPriceHistory() { throw new Error("Unexpected live history fetch"); },
    async getOptionChain() { return [put(options.expiration)]; },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  const rows = await evaluateLiveMarketScan({
    provider,
    rules,
    universe: ["TEST"],
    asOf: when,
    technicalCache: new Map([["TEST", ready]]),
    earningsLookup: options.earningsLookup,
  });
  const row = rows[0];
  const status = (key: string) => row.summary.results.find((result) => result.key === key)?.status;
  return { row, status };
}

const scheduled = (reportDate: string, daysUntilReport = 40): Map<string, LiveScanEarningsLookup> =>
  new Map([["TEST", { reportDate, daysUntilReport, evidence: "SCHEDULED" }]]);

describe("new-put earnings buffer in the live scan", () => {
  it("passes both rules when earnings fall well after expiration with trading sessions to exit", async () => {
    const { row, status } = await scan({ expiration: "2026-09-23", earningsLookup: scheduled("2026-10-05") });
    expect(row.values.earningsFreeDaysAfterExpiry).toBe(11);
    expect(row.values.earningsExitSessions).toBe(7);
    expect(row.values.earningsVerifyReason).toBeNull();
    expect(status("earningsFreeDaysAfterExpiry")).toBe("PASS");
    expect(status("earningsExitSessions")).toBe("PASS");
  });

  it("fails the buffer when earnings fall within 3 calendar days after expiration", async () => {
    const { row, status } = await scan({ expiration: "2026-09-23", earningsLookup: scheduled("2026-09-25") });
    expect(row.values.earningsFreeDaysAfterExpiry).toBe(1);
    expect(status("earningsFreeDaysAfterExpiry")).toBe("FAIL");
  });

  it("fails when earnings fall on the expiration day (announcement time unknown: assume the open)", async () => {
    const { row, status } = await scan({ expiration: "2026-09-23", earningsLookup: scheduled("2026-09-23") });
    expect(row.values.earningsFreeDaysAfterExpiry).toBe(-1);
    expect(status("earningsFreeDaysAfterExpiry")).toBe("FAIL");
  });

  it("fails the exit-session rule across a market holiday even when the calendar buffer passes (Labor Day)", async () => {
    // Fri Sep 4 2026 expiration, Mon Sep 7 Labor Day, Tue Sep 8 report: 3 free days, but no trading session in between.
    const { row, status } = await scan({ expiration: "2026-09-04", asOf: new Date("2026-09-01T14:00:00Z"), earningsLookup: scheduled("2026-09-08") });
    expect(row.values.earningsFreeDaysAfterExpiry).toBe(3);
    expect(row.values.earningsExitSessions).toBe(0);
    expect(status("earningsFreeDaysAfterExpiry")).toBe("PASS");
    expect(status("earningsExitSessions")).toBe("FAIL");
  });

  it("a ticker missing from a supplied lookup is flagged 'verify', never read as clear", async () => {
    const { row, status } = await scan({ expiration: "2026-09-23", earningsLookup: new Map() });
    expect(row.values.earningsFreeDaysAfterExpiry).toBeNull();
    expect(row.values.earningsExitSessions).toBeNull();
    expect(String(row.values.earningsVerifyReason)).toContain("not proof");
    expect(status("earningsFreeDaysAfterExpiry")).toBe("UNKNOWN");
    expect(status("earningsExitSessions")).toBe("UNKNOWN");
  });

  it("a stale date is UNKNOWN for the buffer rules and flagged, while the distance rule still sees the date", async () => {
    const lookup = new Map<string, LiveScanEarningsLookup>([["TEST", { reportDate: "2026-12-01", daysUntilReport: 76, evidence: "STALE" }]]);
    const { row, status } = await scan({ expiration: "2026-09-23", earningsLookup: lookup });
    expect(row.values.earningsDate).toBe("2026-12-01");
    expect(row.values.earningsFreeDaysAfterExpiry).toBeNull();
    expect(String(row.values.earningsVerifyReason)).toContain("out of date");
    expect(status("earningsFreeDaysAfterExpiry")).toBe("UNKNOWN");
  });

  it("conflicting dates (ambiguous) are flagged and never clear", async () => {
    const lookup = new Map<string, LiveScanEarningsLookup>([["TEST", { unavailable: true, evidence: "AMBIGUOUS" }]]);
    const { row, status } = await scan({ expiration: "2026-09-23", earningsLookup: lookup });
    expect(String(row.values.earningsVerifyReason)).toContain("Conflicting");
    expect(status("earningsExitSessions")).toBe("UNKNOWN");
  });

  it("a caller that supplies no lookup at all behaves as before: unknown values, no verify flag invented", async () => {
    const { row, status } = await scan({ expiration: "2026-09-23" });
    expect(row.values.earningsVerifyReason ?? null).toBeNull();
    expect(row.values.earningsFreeDaysAfterExpiry).toBeNull();
    expect(status("earningsFreeDaysAfterExpiry")).toBe("UNKNOWN");
  });
});
