import { describe, expect, it } from "vitest";
import { deriveDefaultAccountName } from "./account-defaults";

describe("deriveDefaultAccountName", () => {
  it("uses Matt's own name when Matt is the current user", () => {
    expect(deriveDefaultAccountName("Matt", "IRA")).toBe("Matt IRA");
  });

  it("uses Eric's own name when Eric is the current user", () => {
    expect(deriveDefaultAccountName("Eric", "IRA")).toBe("Eric IRA");
  });

  it("never derives one user's default from another user's name", () => {
    const eric = deriveDefaultAccountName("Eric", "IRA");
    const matt = deriveDefaultAccountName("Matt", "IRA");
    expect(eric).not.toContain("Matt");
    expect(matt).not.toContain("Eric");
  });

  it("falls back to a neutral name when no display name is available", () => {
    expect(deriveDefaultAccountName(null, "IRA")).toBe("My IRA");
    expect(deriveDefaultAccountName(undefined, "IRA")).toBe("My IRA");
    expect(deriveDefaultAccountName("   ", "IRA")).toBe("My IRA");
  });

  it("uses only the first token of a full display name", () => {
    expect(deriveDefaultAccountName("Eric Smith", "Taxable")).toBe("Eric Taxable");
  });
});
