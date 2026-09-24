import { describe, expect, it, vi } from "vitest";
import { captureAccountStructure, sanitizeAccountStructure } from "./account-structure-diagnostic";

describe("one-off account structure sanitizer", () => {
  it("withholds camel-case dynamic identities and timing nested inside financial objects", () => {
    const output = JSON.stringify(sanitizeAccountStructure({ mattMonk: { accountPrivateKey: "secret" },
      positionsBySymbol: { aapl: { timestamp: "2026-09-23" } },
      marketValue: { timestamp: 1790193600000 }, mysterySession: "REGULAR" }));
    for (const secret of ["mattMonk", "accountPrivateKey", "aapl", "secret", "1790193600000", "2026-09-23", "REGULAR"]) expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED_KEY_");
  });
  it("replaces thrown fetch errors containing secrets with a fixed error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("https://secret.example/HASH Authorization: TOKEN Cookie: SECRET"));
    await expect(captureAccountStructure("TOKEN", "HASH", fetchFn)).rejects.toThrow(/^Account diagnostic unavailable\.$/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("replaces JSON parser errors rather than leaking raw response fragments", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"SECRET_TOKEN":broken'));
    await expect(captureAccountStructure("TOKEN", "HASH", fetchFn)).rejects.toThrow(/^Account diagnostic unavailable\.$/);
  });
  it("retains unknown structure and nulls while removing financial and identifying values", () => {
    const report = sanitizeAccountStructure({ securitiesAccount: {
      accountNumber: "ACCOUNT_SECRET", accountHash: "HASH_SECRET", customerName: "NAME_SECRET",
      currentBalances: { liquidationValue: 10188.41, cashBalance: 9999.21 },
      unknownMetadata: { novelField: "UNKNOWN_SECRET", absentValue: null },
      positions: [{ longQuantity: 123, marketValue: 456.78, profitLoss: 17.2,
        instrument: { symbol: "TICKER_SECRET", cusip: "CUSIP_SECRET", instrumentId: "INSTRUMENT_SECRET" } }],
      transactionId: "TRANSACTION_SECRET", price: 33.33,
    } });
    const output = JSON.stringify(report);
    for (const secret of ["ACCOUNT_SECRET", "HASH_SECRET", "NAME_SECRET", "UNKNOWN_SECRET", "TICKER_SECRET", "CUSIP_SECRET", "INSTRUMENT_SECRET", "TRANSACTION_SECRET", "10188.41", "9999.21", "456.78", "123", "17.2", "33.33"]) expect(output).not.toContain(secret);
    expect(report).toContainEqual({ path: "$.securitiesAccount.[REDACTED_KEY_1].[REDACTED_KEY_1]", type: "string", value: "[REDACTED_STRING]" });
    expect(report).toContainEqual({ path: "$.securitiesAccount.[REDACTED_KEY_1].[REDACTED_KEY_2]", type: "null", value: "null" });
    expect(output).toContain("positions[].instrument.symbol");
  });

  it("preserves safe timing and session values, not arbitrary source text or financial time values", () => {
    const report = sanitizeAccountStructure({ valuationAsOf: "2026-09-23T20:00:00Z", quoteTime: 1790193600000,
      sessionDate: "2026-09-23", timezone: "America/New_York", session: "REGULAR", pricingBasis: "MARK",
      source: "https://secret.example/?token=SECRET", timeValue: 35, updateTime: "CUSTOMER_SECRET" });
    const output = JSON.stringify(report);
    for (const kept of ["2026-09-23T20:00:00Z", "1790193600000", "2026-09-23", "America/New_York", "REGULAR", "MARK"]) expect(output).toContain(kept);
    for (const removed of ["https://", "CUSTOMER_SECRET", '"value":"35"']) expect(output).not.toContain(removed);
  });

  it("blocks credentials even when nested under timing labels or echoed as safe-looking metadata", () => {
    const output = JSON.stringify(sanitizeAccountStructure({ accessToken: "2026-09-23", refreshToken: "REGULAR",
      authorization: { asOf: "2026-09-23T20:00:00Z" }, cookies: { sessionDate: "2026-09-22" },
      clientSecret: "MARK", session: "REGULAR", source: "MARK", asOf: "2026-09-23",
      accountHash: "accountSecret", accountSecret: { timestamp: "2026-09-20" },
    }));
    for (const secret of ["2026-09-23", "2026-09-22", "2026-09-20", "REGULAR", "MARK", "accountSecret"]) expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED_KEY_");
  });

  it("does not reveal array position counts, including heterogeneous fields", () => {
    const rows = sanitizeAccountStructure({ positions: [{ a: 1 }, { a: 2, b: null }] });
    expect(rows.filter(r => r.path === "$.positions[].[REDACTED_KEY_1]")).toHaveLength(1);
    expect(rows.some(r => r.path === "$.positions[].[REDACTED_KEY_2]")).toBe(true);
  });

  it("makes exactly one GET through the existing client and emits only sanitized transport/body evidence", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      securitiesAccount: { accountNumber: "PRIVATE_ACCOUNT", asOf: "2026-09-23T20:00:00Z", liquidationValue: 10188.41 },
    }), { headers: { date: "Wed, 23 Sep 2026 22:00:00 GMT", "set-cookie": "PRIVATE_COOKIE" } }));
    const report = await captureAccountStructure("PRIVATE_TOKEN", "PRIVATE_HASH", fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe("https://api.schwabapi.com/trader/v1/accounts/PRIVATE_HASH?fields=positions");
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(report.transport.httpDate).toBe("Wed, 23 Sep 2026 22:00:00 GMT");
    expect(report.transport.meaning).toBe("TRANSPORT / RETRIEVAL EVIDENCE ONLY");
    for (const secret of ["PRIVATE_TOKEN", "PRIVATE_HASH", "PRIVATE_COOKIE", "PRIVATE_ACCOUNT", "10188.41", "Authorization"]) expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("does not retry a rejected account read or expose its response body", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("SECRET_FAILURE", { status: 401 }));
    await expect(captureAccountStructure("TOKEN", "HASH", fetchFn)).rejects.toThrow("Account diagnostic unavailable.");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
