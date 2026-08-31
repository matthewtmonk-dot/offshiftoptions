import { describe, expect, it } from "vitest";
import { formatOccExpiration, formatOccOptionSymbol, formatOccStrike, parseOccOptionSymbol } from "./occOption";

describe("parseOccOptionSymbol", () => {
  it("parses a single-space short-put OCC symbol", () => {
    const parsed = parseOccOptionSymbol("RIOT 260904P00017500");
    expect(parsed).toMatchObject({
      underlying: "RIOT",
      optionType: "PUT",
      strike: 17.5,
    });
    expect(parsed?.expiration.toISOString()).toBe("2026-09-04T00:00:00.000Z");
  });

  it("parses a double-space padded OCC symbol the same way", () => {
    const parsed = parseOccOptionSymbol("APLD  260904P00023500");
    expect(parsed).toMatchObject({ underlying: "APLD", optionType: "PUT", strike: 23.5 });
  });

  it("parses a call option", () => {
    const parsed = parseOccOptionSymbol("CORZ 260904C00016500");
    expect(parsed).toMatchObject({ underlying: "CORZ", optionType: "CALL", strike: 16.5 });
  });

  it("is case-insensitive and trims whitespace", () => {
    const parsed = parseOccOptionSymbol("  corz 260904p00016500  ");
    expect(parsed).toMatchObject({ underlying: "CORZ", optionType: "PUT", strike: 16.5 });
  });

  it("returns null for a plain equity symbol", () => {
    expect(parseOccOptionSymbol("CORZ")).toBeNull();
  });

  it("returns null for an invalid date", () => {
    expect(parseOccOptionSymbol("CORZ 269913P00016500")).toBeNull();
  });

  it("returns null for a malformed strike/date length", () => {
    expect(parseOccOptionSymbol("CORZ 260904P0016500")).toBeNull();
  });

  it("formats the parsed symbol for display", () => {
    const parsed = parseOccOptionSymbol("RIOT 260904P00017500")!;
    expect(formatOccExpiration(parsed.expiration)).toBe("Sep 4, 2026");
    expect(formatOccStrike(parsed.strike)).toBe("$17.50");
    expect(formatOccOptionSymbol(parsed)).toBe("RIOT · Sep 4, 2026 · $17.50 Put");
  });
});
