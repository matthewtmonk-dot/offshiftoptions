import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractProvidedCronSecret, getCronConfigStatus, isValidCronSecret } from "./cron-auth";

describe("cron-auth", () => {
  const ORIGINAL_SECRET = process.env.OSO_CRON_SECRET;

  beforeEach(() => {
    process.env.OSO_CRON_SECRET = "sentinel-cron-secret-value";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.OSO_CRON_SECRET;
    } else {
      process.env.OSO_CRON_SECRET = ORIGINAL_SECRET;
    }
  });

  it("reports configured status based on whether the env var is set", () => {
    expect(getCronConfigStatus().configured).toBe(true);
    delete process.env.OSO_CRON_SECRET;
    expect(getCronConfigStatus().configured).toBe(false);
  });

  it("accepts the exact configured secret", () => {
    expect(isValidCronSecret("sentinel-cron-secret-value")).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(isValidCronSecret("sentinel-cron-secret-VALUE")).toBe(false);
  });

  it("rejects a wrong secret of a different length without throwing", () => {
    expect(isValidCronSecret("short")).toBe(false);
    expect(isValidCronSecret("way-way-way-way-longer-than-the-real-secret")).toBe(false);
  });

  it("rejects null/empty provided values", () => {
    expect(isValidCronSecret(null)).toBe(false);
    expect(isValidCronSecret("")).toBe(false);
  });

  it("never accepts any secret when the server itself has none configured", () => {
    delete process.env.OSO_CRON_SECRET;
    expect(isValidCronSecret("sentinel-cron-secret-value")).toBe(false);
    expect(isValidCronSecret("")).toBe(false);
  });

  it("extracts the secret from a Bearer Authorization header", () => {
    const headers = new Headers({ authorization: "Bearer my-secret-value" });
    expect(extractProvidedCronSecret(headers)).toBe("my-secret-value");
  });

  it("extracts the secret from the X-OSO-Cron-Secret header when no Authorization header is present", () => {
    const headers = new Headers({ "x-oso-cron-secret": "my-secret-value" });
    expect(extractProvidedCronSecret(headers)).toBe("my-secret-value");
  });

  it("ignores a non-Bearer Authorization scheme", () => {
    const headers = new Headers({ authorization: "Basic dXNlcjpwYXNz" });
    expect(extractProvidedCronSecret(headers)).toBeNull();
  });

  it("returns null when no relevant header is present at all", () => {
    expect(extractProvidedCronSecret(new Headers())).toBeNull();
  });
});
