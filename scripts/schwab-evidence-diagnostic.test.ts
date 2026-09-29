import { describe, expect, it } from "vitest";
import {
  connectionSelectorSuffix,
  deepSanitize,
  isLikelySecretKey,
  looksLikeEpochMillis,
  maskAccountLabel,
  pick,
  REDACTED,
  safeValue,
  sanitizeKeyValue,
  sanitizeQuoteCapture,
} from "./schwab-evidence-sanitizer";

// TEMPORARY DIAGNOSTIC CODE - lives only on the `schwab-evidence-diagnostic` branch, never main.
// Dry-run/synthetic coverage for the sanitizer, per the ticket's explicit safety-validation
// requirement - proves the redaction logic against deliberately-poisoned fake payloads, since no
// real Schwab connection exists in this environment to exercise it against a live response.

describe("isLikelySecretKey / sanitizeKeyValue - key-name layer", () => {
  it("flags every key name the ticket explicitly lists as never-print", () => {
    for (const key of [
      "accessToken", "access_token", "refreshToken", "refresh-token", "clientSecret",
      "authorization", "Authorization", "bearer", "accountNumber", "accountHash",
      "databaseUrl", "DATABASE_URL", "encryptionKey", "password", "credential", "apiKey",
    ]) {
      expect(isLikelySecretKey(key)).toBe(true);
    }
  });

  it("does not flag ordinary Schwab market-data key names", () => {
    for (const key of [
      "symbol", "lastPrice", "mark", "closePrice", "tradeTimeInLong", "quoteTimeInLong",
      "regularMarketLastPrice", "regularMarketTradeTimeInLong", "isOpen", "sessionHours",
      "regularMarket", "start", "end", "assetMainType", "quoteType",
    ]) {
      expect(isLikelySecretKey(key)).toBe(false);
    }
  });

  it("redacts by key name alone, even when the value itself looks innocuous", () => {
    expect(sanitizeKeyValue("accessToken", "just-some-opaque-string-123")).toBe(REDACTED);
    expect(sanitizeKeyValue("accountHash", "AB12CD34")).toBe(REDACTED);
  });

  it("redacts by value content alone, even under an innocuous/renamed key", () => {
    expect(sanitizeKeyValue("note", "Bearer eyJhbGciOi...")).toBe(REDACTED);
    expect(sanitizeKeyValue("misc", "client_secret=abc123")).toBe(REDACTED);
  });

  it("passes through a genuine market-data value unchanged", () => {
    expect(sanitizeKeyValue("lastPrice", 452.31)).toBe(452.31);
    expect(sanitizeKeyValue("symbol", "SPY")).toBe("SPY");
  });
});

describe("pick - allowlisted, key+value sanitized", () => {
  it("only returns allowlisted keys, sanitized, and omits keys absent from the record", () => {
    const record = { lastPrice: 452.31, mark: 452.0, accessToken: "should-never-appear", notAllowlisted: "ignored" };
    const result = pick(record, ["lastPrice", "mark", "accessToken", "closePrice"]);
    expect(result).toEqual({ lastPrice: 452.31, mark: 452.0, accessToken: REDACTED });
    expect(result).not.toHaveProperty("notAllowlisted");
    expect(result).not.toHaveProperty("closePrice");
  });

  it("returns undefined for an absent record without fabricating anything", () => {
    expect(pick(undefined, ["lastPrice"])).toBeUndefined();
  });
});

describe("deepSanitize - full nested structure preserved, never flattened", () => {
  it("preserves nesting and every key name, redacting only poisoned leaves", () => {
    const fake = {
      equity: {
        EQ: {
          date: "2026-09-22",
          marketType: "EQUITY",
          product: "EQ",
          productName: "equity",
          isOpen: true,
          sessionHours: {
            regularMarket: [{ start: "2026-09-22T13:30:00Z", end: "2026-09-22T20:00:00Z" }],
            preMarket: [{ start: "2026-09-22T08:00:00Z", end: "2026-09-22T13:30:00Z" }],
          },
          // Deliberately poisoned leaf, nested deep, to prove recursion actually reaches it.
          internalAccountHash: "shouldNeverAppearAB12",
        },
      },
    };
    const sanitized = deepSanitize(fake) as typeof fake;
    expect(sanitized.equity.EQ.date).toBe("2026-09-22");
    expect(sanitized.equity.EQ.isOpen).toBe(true);
    expect(sanitized.equity.EQ.sessionHours.regularMarket).toEqual(fake.equity.EQ.sessionHours.regularMarket);
    expect(sanitized.equity.EQ.sessionHours.preMarket).toEqual(fake.equity.EQ.sessionHours.preMarket);
    expect((sanitized.equity.EQ as unknown as Record<string, unknown>).internalAccountHash).toBe(REDACTED);
    // The structure itself (every key name, the full nesting depth) is unchanged - never flattened.
    expect(Object.keys(sanitized.equity.EQ)).toEqual(Object.keys(fake.equity.EQ));
  });

  it("redacts an array element value matching the blocked content pattern", () => {
    const fake = { notes: ["fine", "Authorization: Bearer abc.def.ghi"] };
    const sanitized = deepSanitize(fake) as { notes: string[] };
    expect(sanitized.notes[0]).toBe("fine");
    expect(sanitized.notes[1]).toBe(REDACTED);
  });
});

describe("sanitizeQuoteCapture - symbol substitution and group structure", () => {
  it("reports an exact symbol match and the allowlisted quote/regular/extended fields", () => {
    const payload = {
      SPY: {
        symbol: "SPY", assetMainType: "EQUITY", quoteType: "NBBO", realtime: true,
        quote: { lastPrice: 452.31, mark: 452.1, closePrice: 450.0, quoteTimeInLong: 1_774_000_000_000, tradeTimeInLong: 1_774_000_000_500, securityStatus: "Normal" },
        regular: { regularMarketLastPrice: 452.31, regularMarketTradeTimeInLong: 1_774_000_000_500, regularMarketLastSize: 100, regularMarketNetChange: 1.2, regularMarketPercentChange: 0.27, someOtherKey: "kept" },
      },
    };
    const capture = sanitizeQuoteCapture({
      symbol: "SPY", fields: "quote,regular", payload,
      requestStartedAt: "2026-09-22T14:00:00.000Z", responseReceivedAt: "2026-09-22T14:00:00.300Z", httpDateHeader: "Tue, 22 Sep 2026 14:00:00 GMT",
    });
    expect(capture.exactSymbolKeyMatch).toBe(true);
    expect(capture.matchedKeyUsed).toBe("SPY");
    expect(capture.quoteGroup.present).toBe(true);
    expect(capture.quoteGroup.fields?.lastPrice).toBe(452.31);
    expect(capture.regularGroup.allKeyNames).toContain("someOtherKey");
    expect(capture.extendedGroup.present).toBe(false);
    expect(capture.diagnosticTransportEvidence.requestStartedAt).toBe("2026-09-22T14:00:00.000Z");
  });

  it("flags a symbol mismatch instead of silently substituting the first object (the known risk being checked)", () => {
    const payload = { AAPL: { symbol: "AAPL", quote: { lastPrice: 230 } } };
    const capture = sanitizeQuoteCapture({
      symbol: "SPY", fields: "quote", payload,
      requestStartedAt: "t0", responseReceivedAt: "t1", httpDateHeader: null,
    });
    expect(capture.exactSymbolKeyMatch).toBe(false);
    expect(capture.matchedKeyUsed).toBe("AAPL");
    expect(capture.requestedSymbol).toBe("SPY");
  });

  it("redacts a poisoned field inside the extended group by key name", () => {
    const payload = { SPY: { symbol: "SPY", extended: { askPrice: 452.4, accessToken: "leak-attempt" } } };
    const capture = sanitizeQuoteCapture({
      symbol: "SPY", fields: "extended", payload,
      requestStartedAt: "t0", responseReceivedAt: "t1", httpDateHeader: null,
    });
    expect(capture.extendedGroup.present).toBe(true);
    expect(capture.extendedGroup.keyNames).toContain("accessToken");
    expect(capture.extendedGroup.fields?.askPrice).toBe(452.4);
    expect(capture.extendedGroup.fields?.accessToken).toBe(REDACTED);
  });
});

describe("looksLikeEpochMillis", () => {
  it("classifies a real epoch-milliseconds magnitude", () => {
    expect(looksLikeEpochMillis(1_774_000_000_000)).toContain("epoch milliseconds");
  });
  it("classifies an epoch-seconds magnitude as NOT milliseconds", () => {
    expect(looksLikeEpochMillis(1_774_000_000)).toContain("SECONDS, not milliseconds");
  });
  it("reports non-numeric values plainly", () => {
    expect(looksLikeEpochMillis("2026-09-22T14:00:00Z")).toBe("not numeric");
  });
});

describe("maskAccountLabel / connectionSelectorSuffix - safe account selection", () => {
  it("never includes the full connection id, email, or a bare unqualified name", () => {
    const label = maskAccountLabel("Matthew Monk", "cmxyzabcdef1234567890");
    expect(label).toContain("Matthew");
    expect(label).toContain("M.");
    expect(label).toContain("7890");
    expect(label).not.toContain("cmxyzabcdef1234567890");
    expect(label).not.toContain("@");
  });

  it("the selector suffix is short and stable, safe to type on a command line", () => {
    expect(connectionSelectorSuffix("cmxyzabcdef1234567890")).toBe("7890");
    expect(connectionSelectorSuffix("cmxyzabcdef1234567890").length).toBe(4);
  });

  it("handles a single-word name without throwing", () => {
    expect(() => maskAccountLabel("Cher", "abcd1234")).not.toThrow();
    expect(maskAccountLabel("Cher", "abcd1234")).toContain("Cher");
  });
});

describe("safeValue", () => {
  it("leaves a non-string value untouched", () => {
    expect(safeValue(123)).toBe(123);
    expect(safeValue(true)).toBe(true);
    expect(safeValue(null)).toBeNull();
  });
});
