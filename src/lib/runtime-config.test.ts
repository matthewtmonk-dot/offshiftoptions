import { describe, expect, it } from "vitest";
import { runtimeConfigReport } from "./runtime-config";
import { readSessionSecretFromEnv } from "./session-secret";

const full = {
  DATABASE_URL: "postgresql://example",
  LST_SESSION_SECRET: "secret-value",
  NEXT_PUBLIC_APP_URL: "https://example.test",
  SCHWAB_CLIENT_ID: "id",
  SCHWAB_CLIENT_SECRET: "secret",
  SCHWAB_REDIRECT_URI: "https://example.test/api/schwab/callback",
  SCHWAB_TOKEN_ENCRYPTION_KEY: "base64:key",
  OSO_CRON_SECRET: "cron",
  OSO_SCHEDULED_CAPTURE_SECRET: "capture",
  ALPHA_VANTAGE_API_KEY: "av",
  SEC_USER_AGENT: "App research someone@example.test",
  OPENAI_API_KEY: "sk-test",
  SUPABASE_URL: "https://example.supabase.test",
  SUPABASE_SECRET_KEY: "sb",
};

describe("runtimeConfigReport", () => {
  it("is ok when everything is present, and never includes a value", () => {
    const report = runtimeConfigReport(full);
    expect(report).toEqual({ status: "ok", missingRequired: [], missingOptional: [] });
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });

  it("reports the session secret as missing when neither name is set (the Nov 11 2026 outage)", () => {
    const { LST_SESSION_SECRET: _removed, ...withoutSecret } = full;
    void _removed;
    const report = runtimeConfigReport(withoutSecret);
    expect(report.status).toBe("missing-required");
    expect(report.missingRequired).toEqual(["OSO_SESSION_SECRET|LST_SESSION_SECRET"]);
  });

  it("accepts either session secret name", () => {
    const { LST_SESSION_SECRET: _removed, ...rest } = full;
    void _removed;
    expect(runtimeConfigReport({ ...rest, OSO_SESSION_SECRET: "x" }).status).toBe("ok");
  });

  it("treats a blank value as missing and lists optional settings separately", () => {
    const report = runtimeConfigReport({ ...full, DATABASE_URL: "  ", OPENAI_API_KEY: "" });
    expect(report.missingRequired).toEqual(["DATABASE_URL"]);
    expect(report.missingOptional).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("readSessionSecretFromEnv", () => {
  it("prefers OSO_SESSION_SECRET, falls back to LST_SESSION_SECRET, and ignores empty values", () => {
    expect(readSessionSecretFromEnv({ OSO_SESSION_SECRET: "new", LST_SESSION_SECRET: "old" })).toBe("new");
    expect(readSessionSecretFromEnv({ OSO_SESSION_SECRET: "", LST_SESSION_SECRET: "old" })).toBe("old");
    expect(readSessionSecretFromEnv({ LST_SESSION_SECRET: "old" })).toBe("old");
    expect(readSessionSecretFromEnv({})).toBeUndefined();
  });
});
