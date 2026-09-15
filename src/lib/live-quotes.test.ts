import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSchwabMarketDataProviderForUser } from "./broker-connections";
import { getQuoteSnapshotsForUser } from "./live-quotes";

vi.mock("./broker-connections", () => ({ getSchwabMarketDataProviderForUser: vi.fn() }));
const resolveProvider = vi.mocked(getSchwabMarketDataProviderForUser);
const asOf = new Date("2026-09-14T20:00:00Z");
const getQuote = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  resolveProvider.mockResolvedValue({ getQuote } as unknown as NonNullable<Awaited<ReturnType<typeof getSchwabMarketDataProviderForUser>>>);
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
