import { describe, expect, it } from "vitest";
import type { EarningsFloor } from "@/domain/finance/earningsFloor";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import {
  applyEarningsFloorToStockValues,
  earningsFloorValues,
  enrichPersistedStockStageRow,
  evaluateLiveMarketScan,
  reevaluateEnrichedRowWithEarningsFloor,
  type LiveScanEarningsLookup,
  type LiveScanTechnicalLookup,
} from "./live-scan";
import { GATING_RULE_KEYS, SCANNER_RULE_DEFINITIONS } from "./profile";
import { classifyReadiness, type ScannerRule } from "./scanner";

// "No earnings before" floor from SEC filings: a stock with NO announced earnings date can still clear the earnings
// rules when its floor is far enough away. A floor is a lower bound - it may PASS a rule, it may never FAIL one.

const asOf = new Date("2026-09-16T14:00:00Z"); // Wednesday
const ready: LiveScanTechnicalLookup = { state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28 };
const rules: ScannerRule[] = SCANNER_RULE_DEFINITIONS.filter((rule) => rule.defaultEnabled).map((rule) => ({
  key: rule.key,
  name: rule.name,
  operator: rule.operator,
  desired: rule.defaultDesired,
}));
const floor = (notBefore: string): EarningsFloor => ({ notBefore, source: `SEC quarterly report; not before ${notBefore}.` });
const withFloor = (notBefore: string): Map<string, LiveScanEarningsLookup> => new Map([["TEST", { unavailable: true, evidence: "NO_EVIDENCE", floor: floor(notBefore) }]]);

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

async function scan(options: { earningsLookup?: Map<string, LiveScanEarningsLookup>; maxOptionChainLookups?: number; rules?: ScannerRule[] }) {
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: 2_000_000, asOf }; },
    async getPriceHistory() { throw new Error("Unexpected live history fetch"); },
    async getOptionChain() { return [put("2026-09-23")]; },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  const rows = await evaluateLiveMarketScan({
    provider,
    rules: options.rules ?? rules,
    universe: ["TEST"],
    asOf,
    technicalCache: new Map([["TEST", ready]]),
    earningsLookup: options.earningsLookup,
    ...(options.maxOptionChainLookups === undefined ? {} : { maxOptionChainLookups: options.maxOptionChainLookups }),
  });
  const row = rows[0];
  const status = (key: string) => row.summary.results.find((result) => result.key === key)?.status;
  const readiness = classifyReadiness(row.summary, GATING_RULE_KEYS, row.values.optionEnrichment, row.values.contractReasonCode);
  return { row, status, readiness };
}

/** Persisted shape: undefined -> null, as stored in snapshotJson. */
const persisted = (values: Record<string, unknown>) =>
  JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? null])))) as Record<string, number | string | boolean | null>;

describe("earnings floor in the live scan", () => {
  it("baseline: with no announced date and no floor the row can only be VERIFY (needs data), never PASS", async () => {
    const { status, readiness } = await scan({ earningsLookup: new Map([["TEST", { unavailable: true, evidence: "NO_EVIDENCE" }]]) });
    expect(status("earningsDistance")).toBe("UNKNOWN");
    expect(readiness).toBe("NEEDS_DATA");
  });

  it("a floor far beyond expiration passes all three earnings rules and the row becomes a PASS", async () => {
    // Floor Dec 23: 98 days out; expiration Sep 23.
    const { row, status, readiness } = await scan({ earningsLookup: withFloor("2026-12-23") });
    expect(row.values.earningsDate).toBeNull(); // a floor is never shown as a date
    expect(row.values.earningsNotBefore).toBe("2026-12-23");
    expect(row.values.earningsEvidence).toBe("NOT_BEFORE");
    expect(row.values.earningsDistance).toBe(98);
    expect(row.values.earningsFreeDaysAfterExpiry).toBe(90);
    expect(row.values.earningsWithinHoldingPeriod).toBe(false);
    expect(row.values.earningsVerifyReason).toBeNull();
    expect(status("earningsDistance")).toBe("PASS");
    expect(status("earningsFreeDaysAfterExpiry")).toBe("PASS");
    expect(status("earningsExitSessions")).toBe("PASS");
    expect(readiness).toBe("PASS");
  });

  it("a floor that falls BEFORE expiration proves nothing: rules stay UNKNOWN (never FAIL) and the row asks to verify", async () => {
    // Floor Sep 20 is 4 days out and before the Sep 23 expiration. The real date could still be months away.
    const { row, status, readiness } = await scan({ earningsLookup: withFloor("2026-09-20") });
    expect(row.values.earningsDistance).toBeNull();
    expect(row.values.earningsFreeDaysAfterExpiry).toBeNull();
    expect(row.values.earningsExitSessions).toBeNull();
    expect(row.values.earningsWithinHoldingPeriod).toBeNull();
    expect(String(row.values.earningsVerifyReason)).toContain("2026-09-20");
    for (const key of ["earningsDistance", "earningsFreeDaysAfterExpiry", "earningsExitSessions"]) expect(status(key)).toBe("UNKNOWN");
    expect(readiness).toBe("NEEDS_DATA");
  });

  it("a floor just after expiration but inside the 3-day buffer stays UNKNOWN, not FAIL", async () => {
    // Expiration Wed Sep 23; floor Fri Sep 25 = 1 free day (needs 3). Distance 9 days (needs 10).
    const { row, status, readiness } = await scan({ earningsLookup: withFloor("2026-09-25") });
    expect(row.values.earningsFreeDaysAfterExpiry).toBeNull();
    expect(status("earningsFreeDaysAfterExpiry")).toBe("UNKNOWN");
    expect(status("earningsDistance")).toBe("UNKNOWN");
    expect(row.values.earningsVerifyReason).toBeTruthy();
    expect(readiness).toBe("NEEDS_DATA");
  });

  it("keeps the verify reason when the buffer rules clear but the distance rule cannot be proven", async () => {
    // Distance rule raised to 30 days; floor Oct 10 is 24 days out but clears the 3-day buffer after Sep 23.
    const strict = rules.map((rule) => (rule.key === "earningsDistance" ? { ...rule, desired: 30 } : rule));
    const { row, status, readiness } = await scan({ earningsLookup: withFloor("2026-10-10"), rules: strict });
    expect(status("earningsFreeDaysAfterExpiry")).toBe("PASS");
    expect(status("earningsDistance")).toBe("UNKNOWN");
    expect(String(row.values.earningsVerifyReason)).toContain("2026-10-10");
    expect(readiness).toBe("NEEDS_DATA");
  });

  it("a floor that has already passed is ignored entirely", async () => {
    const { row } = await scan({ earningsLookup: withFloor("2026-09-16") });
    expect(row.values.earningsNotBefore ?? null).toBeNull();
    expect(row.values.earningsEvidence).toBe("NO_EVIDENCE");
    expect(String(row.values.earningsVerifyReason)).toContain("not proof");
  });

  it("never applies a floor over conflicting announced dates", async () => {
    const { row, status } = await scan({ earningsLookup: new Map([["TEST", { unavailable: true, evidence: "AMBIGUOUS", floor: floor("2026-12-23") }]]) });
    expect(row.values.earningsEvidence).toBe("AMBIGUOUS");
    expect(status("earningsDistance")).toBe("UNKNOWN");
  });

  it("an announced date always wins: the floor is not consulted when the calendar has a date", async () => {
    const { row } = await scan({ earningsLookup: new Map([["TEST", { reportDate: "2026-10-05", daysUntilReport: 19, evidence: "SCHEDULED" }]]) });
    expect(row.values.earningsDate).toBe("2026-10-05");
    expect(row.values.earningsNotBefore ?? null).toBeNull();
  });
});

describe("earningsFloorValues", () => {
  it("only uses a rule that is a plain numeric minimum", () => {
    const odd = rules.map((rule) => (rule.key === "earningsDistance" ? { ...rule, operator: "LTE" as const } : rule));
    expect(earningsFloorValues(floor("2026-12-23"), odd, asOf)?.earningsDistance).toBeNull();
  });

  it("shows the minimum distance when the distance rule is switched off", () => {
    const off = rules.filter((rule) => rule.key !== "earningsDistance");
    expect(earningsFloorValues(floor("2026-09-20"), off, asOf)).toMatchObject({ earningsDistance: 4, earningsVerifyReason: null });
  });
});

describe("floors applied to persisted rows (Check options)", () => {
  it("a waiting row with no earnings date is priced as a PASS once its floor is applied", async () => {
    const { row } = await scan({ earningsLookup: new Map([["TEST", { unavailable: true, evidence: "NO_EVIDENCE" }]]), maxOptionChainLookups: 0 });
    const stored = persisted(row.values);
    expect(stored.optionEnrichment).toBe("NOT_ENRICHED_BUDGET");

    const values = applyEarningsFloorToStockValues(stored, floor("2026-12-23"), rules, asOf);
    const result = enrichPersistedStockStageRow({ values, options: [put("2026-09-23")], rules, asOf });
    expect(result?.values.earningsNotBefore).toBe("2026-12-23");
    expect(classifyReadiness(result!.summary, GATING_RULE_KEYS, result!.values.optionEnrichment, result!.values.contractReasonCode)).toBe("PASS");
  });

  it("leaves a row alone when there is no floor, or the row already has an earnings date", async () => {
    const dated = await scan({ earningsLookup: new Map([["TEST", { reportDate: "2026-10-05", daysUntilReport: 19, evidence: "SCHEDULED" }]]), maxOptionChainLookups: 0 });
    const stored = persisted(dated.row.values);
    expect(applyEarningsFloorToStockValues(stored, floor("2026-12-23"), rules, asOf)).toBe(stored);
    expect(applyEarningsFloorToStockValues(stored, undefined, rules, asOf)).toBe(stored);
  });

  it("re-judges an already-priced VERIFY row in place: same contract, earnings values only", async () => {
    const priced = await scan({ earningsLookup: new Map([["TEST", { unavailable: true, evidence: "NO_EVIDENCE" }]]) });
    expect(priced.readiness).toBe("NEEDS_DATA");
    const stored = persisted(priced.row.values);

    const result = reevaluateEnrichedRowWithEarningsFloor({ values: stored, floor: floor("2026-12-23"), rules, asOf });
    expect(result).not.toBeNull();
    expect(result!.values.optionSymbol).toBe(stored.optionSymbol);
    expect(result!.values.strike).toBe(stored.strike);
    expect(result!.values.optionBid).toBe(stored.optionBid);
    expect(result!.values.earningsFreeDaysAfterExpiry).toBe(90);
    expect(result!.values.earningsVerifyReason).toBeNull();
    expect(classifyReadiness(result!.summary, GATING_RULE_KEYS, result!.values.optionEnrichment, result!.values.contractReasonCode)).toBe("PASS");

    // Same answer as a scan that knew the floor from the start.
    const direct = await scan({ earningsLookup: withFloor("2026-12-23") });
    expect(result!.summary.results.map((r) => [r.key, r.status])).toEqual(direct.row.summary.results.map((r) => [r.key, r.status]));
  });

  it("does not re-judge a row that is not priced, already has a floor, or whose floor has passed", async () => {
    const waiting = await scan({ earningsLookup: new Map([["TEST", { unavailable: true, evidence: "NO_EVIDENCE" }]]), maxOptionChainLookups: 0 });
    expect(reevaluateEnrichedRowWithEarningsFloor({ values: persisted(waiting.row.values), floor: floor("2026-12-23"), rules, asOf })).toBeNull();

    const floored = await scan({ earningsLookup: withFloor("2026-12-23") });
    expect(reevaluateEnrichedRowWithEarningsFloor({ values: persisted(floored.row.values), floor: floor("2026-12-30"), rules, asOf })).toBeNull();

    const priced = await scan({ earningsLookup: new Map([["TEST", { unavailable: true, evidence: "NO_EVIDENCE" }]]) });
    expect(reevaluateEnrichedRowWithEarningsFloor({ values: persisted(priced.row.values), floor: floor("2026-09-10"), rules, asOf })).toBeNull();
  });
});
