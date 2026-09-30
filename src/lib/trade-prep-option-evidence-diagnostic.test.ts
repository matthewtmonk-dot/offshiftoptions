import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isRegularUsTradingSession,
  buildOptionChainDateRange,
  maskConnectionSelector,
  selectEligibleConnection,
  sanitizeForDiagnosticOutput,
  captureRootStructure,
  captureContractEvidence,
  selectNearOtmPutContracts,
  MAX_CAPTURED_CONTRACTS,
  type EligibleConnection,
} from "../../scripts/trade-prep-option-evidence-diagnostic";

const SCRIPT_SOURCE = readFileSync(new URL("../../scripts/trade-prep-option-evidence-diagnostic.ts", import.meta.url), "utf8");

describe("trade-prep-option-evidence-diagnostic: static safety proofs (source inspection)", () => {
  it("never imports or calls the refresh-capable token helpers", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/getValidSchwabAccessTokenForConnection\(/);
    expect(SCRIPT_SOURCE).not.toMatch(/refreshSchwabConnectionAccessToken\(/);
    expect(SCRIPT_SOURCE).not.toMatch(/import\s*\{[^}]*getValidSchwabAccessTokenForConnection[^}]*\}/);
    expect(SCRIPT_SOURCE).not.toMatch(/import\s*\{[^}]*refreshSchwabConnectionAccessToken[^}]*\}/);
  });

  it("only imports the pure needsRefresh export from the tokens module", () => {
    const tokensImport = SCRIPT_SOURCE.match(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/src\/providers\/schwab\/tokens"/);
    expect(tokensImport).not.toBeNull();
    expect(tokensImport![1].trim()).toBe("needsRefresh");
  });

  it("performs no Prisma write operations anywhere in the script", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/);
  });

  it("never references an order/trading endpoint path", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\/orders/i);
    expect(SCRIPT_SOURCE).not.toMatch(/\/trading/i);
    expect(SCRIPT_SOURCE).not.toMatch(/\/accounts/i);
    expect(SCRIPT_SOURCE).not.toMatch(/\/transactions/i);
  });

  it("makes exactly one fetch call in its source", () => {
    const fetchCalls = SCRIPT_SOURCE.match(/fetchFn\(/g) ?? [];
    expect(fetchCalls.length).toBe(1);
  });

  it("never logs the raw response body to console", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/console\.log\(raw\)/);
    expect(SCRIPT_SOURCE).not.toMatch(/console\.log\(JSON\.stringify\(raw/);
  });
});

describe("isRegularUsTradingSession", () => {
  it("is true for a Tuesday 10:00 ET instant", () => {
    // 2026-09-29 14:00:00Z = 10:00 ET (EDT, UTC-4)
    expect(isRegularUsTradingSession(new Date("2026-09-29T14:00:00Z"))).toBe(true);
  });

  it("is false before 9:30 ET", () => {
    expect(isRegularUsTradingSession(new Date("2026-09-29T13:00:00Z"))).toBe(false);
  });

  it("is false at/after 16:00 ET", () => {
    expect(isRegularUsTradingSession(new Date("2026-09-29T20:00:00Z"))).toBe(false);
  });

  it("is false on a weekend", () => {
    expect(isRegularUsTradingSession(new Date("2026-09-27T15:00:00Z"))).toBe(false); // Sunday
  });

  it("is false on Christmas (NYSE holiday)", () => {
    expect(isRegularUsTradingSession(new Date("2026-12-25T15:00:00Z"))).toBe(false);
  });
});

describe("buildOptionChainDateRange", () => {
  it("computes toDate as fromDate + 13 calendar days", () => {
    const { fromDate, toDate } = buildOptionChainDateRange(new Date("2026-09-29T14:00:00Z"));
    expect(fromDate).toBe("2026-09-29");
    expect(toDate).toBe("2026-10-12");
  });
});

describe("maskConnectionSelector", () => {
  it("matches the ticket's exact example format", () => {
    const { label, suffix } = maskConnectionSelector("Matt", "clx0000000000000000abcd");
    expect(suffix).toBe("abcd");
    expect(label).toBe("Matt (ref ...abcd) -> --account abcd");
  });

  it("never includes the full connection id", () => {
    const { label } = maskConnectionSelector("Matt", "clx0000000000000000abcd");
    expect(label).not.toContain("clx0000000000000000abcd");
  });
});

describe("selectEligibleConnection", () => {
  const conn = (id: string, ownerName = "Matt"): EligibleConnection => ({ id, expiresAt: null, accessTokenCiphertext: "x", ownerName });

  it("returns NONE_ELIGIBLE for an empty list", () => {
    expect(selectEligibleConnection([], null).outcome).toBe("NONE_ELIGIBLE");
  });

  it("auto-selects the single eligible connection", () => {
    const result = selectEligibleConnection([conn("abcd")], null);
    expect(result.outcome).toBe("SELECTED");
    if (result.outcome === "SELECTED") expect(result.connection.id).toBe("abcd");
  });

  it("reports AMBIGUOUS with masked selectors when multiple exist and no --account given", () => {
    const result = selectEligibleConnection([conn("aaaaabcd"), conn("bbbbwxyz")], null);
    expect(result.outcome).toBe("AMBIGUOUS");
    if (result.outcome === "AMBIGUOUS") {
      expect(result.selectors).toEqual(["Matt (ref ...abcd) -> --account abcd", "Matt (ref ...wxyz) -> --account wxyz"]);
    }
  });

  it("selects by --account suffix when multiple exist", () => {
    const result = selectEligibleConnection([conn("aaaaabcd"), conn("bbbbwxyz")], "wxyz");
    expect(result.outcome).toBe("SELECTED");
    if (result.outcome === "SELECTED") expect(result.connection.id).toBe("bbbbwxyz");
  });

  it("reports NOT_FOUND for an unmatched --account suffix", () => {
    const result = selectEligibleConnection([conn("aaaaabcd")], "zzzz");
    expect(result.outcome).toBe("NOT_FOUND");
  });
});

describe("sanitizeForDiagnosticOutput", () => {
  it("redacts secret-shaped keys anywhere in the object graph", () => {
    const input = {
      accessToken: "secret-value",
      nested: { refreshToken: "another-secret", authorization: "Bearer abc", clientSecret: "shh", DATABASE_URL: "postgres://...", accountHash: "hash123", cookie: "session=abc" },
      safe: "SPY",
    };
    const output = sanitizeForDiagnosticOutput(input) as Record<string, unknown>;
    expect(output.accessToken).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).refreshToken).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).clientSecret).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).DATABASE_URL).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).accountHash).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).cookie).toBe("[REDACTED]");
    expect(output.safe).toBe("SPY");
  });

  it("drops raw headers objects entirely, never leaking Authorization bearer values", () => {
    const output = sanitizeForDiagnosticOutput({ headers: { authorization: "Bearer real-token", date: "Tue" } }) as Record<string, unknown>;
    expect(output.headers).toBeUndefined();
    expect(JSON.stringify(output)).not.toMatch(/Bearer real-token/);
  });

  it("passes through public market data unchanged", () => {
    const output = sanitizeForDiagnosticOutput({ symbol: "SPY", bid: 1.23, ask: 1.25 });
    expect(output).toEqual({ symbol: "SPY", bid: 1.23, ask: 1.25 });
  });
});

describe("captureRootStructure", () => {
  it("captures present fields and putExpDateMap keys", () => {
    const raw = { symbol: "SPY", status: "SUCCESS", putExpDateMap: { "2026-10-01:1": {} } };
    const result = captureRootStructure(raw);
    expect(result.isRecord).toBe(true);
    expect(result.symbol).toEqual({ present: true, value: "SPY", type: "string" });
    expect(result.putExpDateMapPresent).toBe(true);
    expect(result.putExpDateMapKeys).toEqual(["2026-10-01:1"]);
  });

  it("reports absent fields as present:false, never inventing a value", () => {
    const result = captureRootStructure({});
    expect(result.symbol).toEqual({ present: false });
    expect(result.putExpDateMapPresent).toBe(false);
  });
});

describe("captureContractEvidence", () => {
  it("preserves the raw provider symbol exactly when present", () => {
    const result = captureContractEvidence({ symbol: "SPY  261012P00500000", strikePrice: 500 });
    expect(result.providerSymbol).toEqual({ present: true, value: "SPY  261012P00500000", rawLocation: "contract.symbol" });
  });

  it("reports a missing provider symbol as missing, never backfilling a synthesized one", () => {
    const result = captureContractEvidence({ strikePrice: 500 });
    expect(result.providerSymbol).toEqual({ present: false, value: null, rawLocation: "contract.symbol" });
  });

  it("reports absent multiplier/deliverable fields as absent, never assuming 100", () => {
    const result = captureContractEvidence({ symbol: "X" });
    expect(result.contractTerms.multiplier).toEqual({ present: false });
    expect(result.contractTerms.deliverable).toEqual({ present: false });
  });

  it("captures a present multiplier field exactly as returned, without assuming its meaning", () => {
    const result = captureContractEvidence({ symbol: "X", multiplier: 100 });
    expect(result.contractTerms.multiplier).toEqual({ present: true, value: 100, type: "number" });
  });

  it("captures every present timing field with its raw name, value, and type", () => {
    const result = captureContractEvidence({ symbol: "X", quoteTimeInLong: 1234567890, tradeTime: "2026-09-29T14:00:00Z" });
    expect(result.timing.quoteTimeInLong).toEqual({ present: true, value: 1234567890, type: "number" });
    expect(result.timing.tradeTime).toEqual({ present: true, value: "2026-09-29T14:00:00Z", type: "string" });
    expect(result.timing.lastTradingDay).toEqual({ present: false });
  });
});

describe("selectNearOtmPutContracts", () => {
  it("caps selection at MAX_CAPTURED_CONTRACTS even when more are available", () => {
    const raw = {
      putExpDateMap: {
        "2026-10-01:1": {
          "500.0": [{ symbol: "A" }, { symbol: "B" }],
          "495.0": [{ symbol: "C" }, { symbol: "D" }],
        },
        "2026-10-08:8": {
          "490.0": [{ symbol: "E" }],
        },
      },
    };
    const selected = selectNearOtmPutContracts(raw);
    expect(selected.length).toBe(MAX_CAPTURED_CONTRACTS);
    expect(selected).toEqual([{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }]);
  });

  it("returns an empty array when putExpDateMap is absent", () => {
    expect(selectNearOtmPutContracts({ symbol: "SPY" })).toEqual([]);
  });
});

describe("main(): end-to-end request-construction and safety behavior", () => {
  const originalKey = process.env.SCHWAB_TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 7).toString("base64")}`;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SCHWAB_TOKEN_ENCRYPTION_KEY;
    else process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = originalKey;
    vi.doUnmock("./prisma");
    vi.doUnmock("node:fs/promises");
  });

  it("makes exactly one Schwab request, with the exact specified query params, and writes no DB rows", async () => {
    const { encryptToken } = await import("../providers/schwab/crypto");
    const ciphertext = encryptToken("plaintext-access-token");
    const farFuture = new Date("2026-09-29T14:00:00Z");
    const expiresAt = new Date(farFuture.getTime() + 60 * 60 * 1000);

    const findMany = vi.fn().mockResolvedValue([
      { id: "clxconnectionabcd", expiresAt, accessTokenCiphertext: ciphertext, user: { name: "Matt" } },
    ]);
    vi.doMock("./prisma", () => ({ prisma: { brokerConnection: { findMany } } }));
    const writeFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("node:fs/promises", () => ({ writeFile }));

    const { runTradeprepOptionEvidenceDiagnostic } = await import("../../scripts/trade-prep-option-evidence-diagnostic");

    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "date" ? "Tue, 29 Sep 2026 14:00:00 GMT" : null) },
      json: async () => ({ symbol: "SPY", putExpDateMap: {} }),
    });

    await runTradeprepOptionEvidenceDiagnostic({ fetchFn: fetchFn as unknown as typeof fetch, now: farFuture, argv: [] });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0];
    const requested = url as URL;
    expect(requested.pathname.endsWith("/chains")).toBe(true);
    expect(requested.searchParams.get("symbol")).toBe("SPY");
    expect(requested.searchParams.get("contractType")).toBe("PUT");
    expect(requested.searchParams.get("strategy")).toBe("SINGLE");
    expect(requested.searchParams.get("includeQuotes")).toBe("TRUE");
    expect(requested.searchParams.get("range")).toBe("OTM");
    expect(requested.searchParams.get("fromDate")).toBe("2026-09-29");
    expect(requested.searchParams.get("toDate")).toBe("2026-10-12");

    // Only a findMany read call was made - no write methods exist on the mocked prisma object at all.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContents] = writeFile.mock.calls[0];
    expect(writtenPath).toBe("trade-prep-option-evidence-capture.json");
    expect(String(writtenContents)).not.toMatch(/plaintext-access-token/);
  });

  it("stops without making any Schwab call when the token needs refresh", async () => {
    const { encryptToken } = await import("../providers/schwab/crypto");
    const ciphertext = encryptToken("plaintext-access-token");
    const farFuture = new Date("2026-09-29T14:00:00Z");
    const almostExpired = new Date(farFuture.getTime() + 1000); // within the 60s needsRefresh threshold

    const findMany = vi.fn().mockResolvedValue([
      { id: "clxconnectionabcd", expiresAt: almostExpired, accessTokenCiphertext: ciphertext, user: { name: "Matt" } },
    ]);
    vi.doMock("./prisma", () => ({ prisma: { brokerConnection: { findMany } } }));

    const { runTradeprepOptionEvidenceDiagnostic } = await import("../../scripts/trade-prep-option-evidence-diagnostic");
    const fetchFn = vi.fn();

    await runTradeprepOptionEvidenceDiagnostic({ fetchFn: fetchFn as unknown as typeof fetch, now: farFuture, argv: [] });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stops without making any Schwab call outside a regular trading session", async () => {
    const findMany = vi.fn();
    vi.doMock("./prisma", () => ({ prisma: { brokerConnection: { findMany } } }));
    const { runTradeprepOptionEvidenceDiagnostic } = await import("../../scripts/trade-prep-option-evidence-diagnostic");
    const fetchFn = vi.fn();

    const weekend = new Date("2026-09-27T15:00:00Z");
    await runTradeprepOptionEvidenceDiagnostic({ fetchFn: fetchFn as unknown as typeof fetch, now: weekend, argv: [] });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
