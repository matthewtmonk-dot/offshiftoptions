import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSchwabMarketDataProviderForUser } from "./broker-connections";
import { getEquityMarketSessionEvidenceForUser, getQuoteReviewEvidenceForUser, getQuoteSnapshotsForUser } from "./live-quotes";

vi.mock("./broker-connections", () => ({ getSchwabMarketDataProviderForUser: vi.fn() }));
const resolveProvider = vi.mocked(getSchwabMarketDataProviderForUser);
const asOf = new Date("2026-09-14T20:00:00Z");
const getQuote = vi.fn();
const getQuoteReviewEvidence = vi.fn();
const getEquityMarketSessionEvidence = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  resolveProvider.mockResolvedValue({
    getQuote,
    getQuoteReviewEvidence,
    getEquityMarketSessionEvidence,
  } as unknown as NonNullable<Awaited<ReturnType<typeof getSchwabMarketDataProviderForUser>>>);
});

describe("Tracker quote snapshots", () => {
  it("preserves the source snapshot time, normalizes tickers and uses the requesting user's provider", async () => {
    getQuote.mockResolvedValue({ price: 17, asOf });
    const result = await getQuoteSnapshotsForUser("matt", ["CORZ", " corz "]);
    expect(resolveProvider).toHaveBeenCalledWith("matt");
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(result.get("CORZ")).toEqual({ price: 17, asOf });
  });
  it("isolates a failed ticker without replacing it with another user's data", async () => {
    getQuote.mockResolvedValueOnce({ price: 17, asOf }).mockRejectedValueOnce(new Error("unavailable"));
    const result = await getQuoteSnapshotsForUser("eric", ["CORZ", "HL"]);
    expect(resolveProvider).toHaveBeenCalledWith("eric");
    expect(result.get("CORZ")).toEqual({ price: 17, asOf });
    expect(result.get("HL")).toBeNull();
  });
  it.each([null, new Error("connection lookup failed")])("keeps an unavailable provider from breaking manual Tracker cards", async (outcome) => {
    if (outcome) resolveProvider.mockRejectedValue(outcome);
    else resolveProvider.mockResolvedValue(null);
    expect((await getQuoteSnapshotsForUser("matt", ["CORZ"])).get("CORZ")).toBeNull();
    expect(getQuote).not.toHaveBeenCalled();
  });
  it.each([{ price: 0, asOf }, { price: NaN, asOf }, { price: -1, asOf }, { price: 17, asOf: new Date(NaN) }])("rejects unusable quote %j", async (quote) => {
    getQuote.mockResolvedValue(quote);
    expect((await getQuoteSnapshotsForUser("matt", ["CORZ"])).get("CORZ")).toBeNull();
  });
  it("does not request quotes when no active puts need them", async () => {
    expect((await getQuoteSnapshotsForUser("matt", [])).size).toBe(0);
    expect(resolveProvider).not.toHaveBeenCalled();
  });
});

describe("Dashboard V2 Phase 2 - getQuoteReviewEvidenceForUser", () => {
  it("resolves the requesting user's provider and returns AVAILABLE evidence per ticker", async () => {
    const evidence = { status: "AVAILABLE" as const, requestedSymbol: "SPY", returnedSymbol: "SPY", assetMainType: "EQUITY", realtime: true, price: 500, tradeTime: asOf, requestStartedAt: asOf, responseReceivedAt: asOf };
    getQuoteReviewEvidence.mockResolvedValue(evidence);

    const result = await getQuoteReviewEvidenceForUser("matt", ["spy"]);

    expect(resolveProvider).toHaveBeenCalledWith("matt");
    expect(result.get("SPY")).toEqual(evidence);
  });

  it("isolates a per-symbol provider failure to UNAVAILABLE - never throws, never drops other symbols", async () => {
    getQuoteReviewEvidence.mockResolvedValueOnce({ status: "AVAILABLE", requestedSymbol: "SPY", returnedSymbol: "SPY", assetMainType: "EQUITY", realtime: true, price: 500, tradeTime: asOf, requestStartedAt: asOf, responseReceivedAt: asOf });
    getQuoteReviewEvidence.mockRejectedValueOnce(new Error("rate limited"));

    const result = await getQuoteReviewEvidenceForUser("matt", ["SPY", "UPST"]);

    expect(result.get("SPY")?.status).toBe("AVAILABLE");
    expect(result.get("UPST")).toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
  });

  it.each([null, new Error("connection lookup failed")])("maps an unavailable/failed connection resolution to UNAVAILABLE evidence, never a thrown error", async (outcome) => {
    if (outcome) resolveProvider.mockRejectedValue(outcome);
    else resolveProvider.mockResolvedValue(null);

    const result = await getQuoteReviewEvidenceForUser("matt", ["SPY"]);
    expect(result.get("SPY")).toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
    expect(getQuoteReviewEvidence).not.toHaveBeenCalled();
  });

  it("returns an empty map without resolving a provider for an empty ticker list", async () => {
    expect((await getQuoteReviewEvidenceForUser("matt", [])).size).toBe(0);
    expect(resolveProvider).not.toHaveBeenCalled();
  });
});

describe("Dashboard V2 Phase 2 - getEquityMarketSessionEvidenceForUser", () => {
  it("resolves the requesting user's provider and returns the session evidence for the requested date", async () => {
    const evidence = {
      status: "AVAILABLE" as const,
      requestedDate: "2026-06-15",
      returnedDate: "2026-06-15",
      marketType: "EQUITY",
      product: "EQ",
      isOpen: true,
      regularMarketIntervals: [],
    };
    getEquityMarketSessionEvidence.mockResolvedValue(evidence);

    const result = await getEquityMarketSessionEvidenceForUser("matt", "2026-06-15");

    expect(resolveProvider).toHaveBeenCalledWith("matt");
    expect(getEquityMarketSessionEvidence).toHaveBeenCalledWith("2026-06-15");
    expect(result).toEqual(evidence);
  });

  it("maps a provider failure to UNAVAILABLE - never MARKET CLOSED, never thrown", async () => {
    getEquityMarketSessionEvidence.mockRejectedValue(new Error("outage"));
    const result = await getEquityMarketSessionEvidenceForUser("matt", "2026-06-15");
    expect(result).toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
  });

  it.each([null, new Error("connection lookup failed")])("maps an unavailable/failed connection resolution to UNAVAILABLE, never thrown", async (outcome) => {
    if (outcome) resolveProvider.mockRejectedValue(outcome);
    else resolveProvider.mockResolvedValue(null);

    const result = await getEquityMarketSessionEvidenceForUser("matt", "2026-06-15");
    expect(result).toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
    expect(getEquityMarketSessionEvidence).not.toHaveBeenCalled();
  });
});
