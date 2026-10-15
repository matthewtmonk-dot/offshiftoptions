import { describe, expect, it } from "vitest";
import { resolveSessionSecret } from "./auth";

describe("resolveSessionSecret (fail closed in production)", () => {
  it("uses the configured secret everywhere", () => {
    expect(resolveSessionSecret("a-long-random-secret", "production")).toBe("a-long-random-secret");
    expect(resolveSessionSecret("a-long-random-secret", "development")).toBe("a-long-random-secret");
  });

  it("refuses to run in production without a secret, instead of using the publicly-known fallback", () => {
    expect(() => resolveSessionSecret(undefined, "production")).toThrow(/LST_SESSION_SECRET is required/);
    expect(() => resolveSessionSecret("", "production")).toThrow(/required/);
  });

  it("still allows the development fallback outside production (local dev and tests)", () => {
    expect(resolveSessionSecret(undefined, "development")).toBe("local-development-session-secret");
    expect(resolveSessionSecret(undefined, "test")).toBe("local-development-session-secret");
  });
});
