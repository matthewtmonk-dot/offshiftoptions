import { describe, expect, it } from "vitest";
import { needsRefresh, tokenExpiresAt } from "./tokens";

describe("Schwab token lifecycle helpers", () => {
  it("refreshes one minute before expiration", () => {
    const now = new Date("2026-08-31T12:00:00Z");

    expect(needsRefresh({ expiresAt: new Date("2026-08-31T12:00:30Z") }, now)).toBe(true);
    expect(needsRefresh({ expiresAt: new Date("2026-08-31T12:05:00Z") }, now)).toBe(false);
    expect(needsRefresh({ expiresAt: null }, now)).toBe(true);
  });

  it("uses the Schwab expires_in field when present", () => {
    const now = new Date("2026-08-31T12:00:00Z");

    expect(tokenExpiresAt({ expires_in: 1800 }, now)).toEqual(new Date("2026-08-31T12:30:00Z"));
    expect(tokenExpiresAt({}, now)).toEqual(new Date("2026-08-31T12:30:00Z"));
  });
});
