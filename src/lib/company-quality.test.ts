import { afterEach, describe, expect, it } from "vitest";
import { normalizeQualityTicker, secUserAgent } from "./company-quality";

const original = process.env.SEC_USER_AGENT;
afterEach(() => {
  if (original === undefined) delete process.env.SEC_USER_AGENT;
  else process.env.SEC_USER_AGENT = original;
});

describe("secUserAgent", () => {
  it("is null when unset, blank, or a placeholder without a contact address", () => {
    delete process.env.SEC_USER_AGENT;
    expect(secUserAgent()).toBeNull();
    process.env.SEC_USER_AGENT = "   ";
    expect(secUserAgent()).toBeNull();
    process.env.SEC_USER_AGENT = "OffShiftOptions";
    expect(secUserAgent()).toBeNull();
  });

  it("returns the configured identifier when it contains a contact address", () => {
    process.env.SEC_USER_AGENT = "OffShiftOptions research someone@example.com";
    expect(secUserAgent()).toBe("OffShiftOptions research someone@example.com");
  });
});

describe("normalizeQualityTicker", () => {
  it("accepts normal tickers (any case, class shares) and rejects anything else", () => {
    expect(normalizeQualityTicker(" hpq ")).toBe("HPQ");
    expect(normalizeQualityTicker("BRK.B")).toBe("BRK.B");
    expect(normalizeQualityTicker("BF-B")).toBe("BF-B");
    for (const bad of ["", "1ABC", "A B", "../etc", "TOOLONGTICKER1", "A;DROP", "<script>"]) expect(normalizeQualityTicker(bad)).toBeNull();
  });
});
