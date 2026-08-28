import { describe, expect, it } from "vitest";
import { isValidTicker, normalizeTicker, parseTicker, requireTicker, ValidationError } from "./tickers";

describe("ticker validation", () => {
  it("normalizes ticker input to uppercase without a leading dollar sign", () => {
    expect(normalizeTicker(" $corz ")).toBe("CORZ");
  });

  it("accepts common ticker characters and rejects blank or unsafe values", () => {
    expect(isValidTicker("BRK.B")).toBe(true);
    expect(parseTicker("sofi")).toBe("SOFI");
    expect(parseTicker("")).toBeNull();
    expect(parseTicker("TOO-LONG-SYMBOL")).toBeNull();
    expect(() => requireTicker("<script>")).toThrow(ValidationError);
  });
});
