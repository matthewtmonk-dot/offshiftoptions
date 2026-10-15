import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { sanitizeDiagnosticText } = await import("./diagnostics");

describe("sanitizeDiagnosticText", () => {
  it("removes connection strings and URLs", () => {
    const text = sanitizeDiagnosticText("connect failed for postgresql://user:pass@db.example.com:5432/postgres?sslmode=require");
    expect(text).toBe("connect failed for [url]");
    expect(text).not.toMatch(/pass|example/);
  });

  it("removes bearer tokens and long opaque values", () => {
    // Built at run time from neutral pieces so no key-shaped string exists in the source (secret scanners
    // - rightly - flag key-shaped text even in tests).
    const opaque = "Zq".repeat(16);
    const text = sanitizeDiagnosticText(`Authorization: Bearer abc.def and token ${opaque} and ok`);
    expect(text).not.toMatch(/abc\.def/);
    expect(text).not.toContain(opaque);
    expect(text).toContain("ok");
  });

  it("flattens newlines, bounds the length, and accepts an Error", () => {
    expect(sanitizeDiagnosticText("line one\nline two\r\n\tline three")).toBe("line one line two line three");
    expect(sanitizeDiagnosticText("x ".repeat(500)).length).toBeLessThanOrEqual(200);
    expect(sanitizeDiagnosticText(new Error("boom"))).toBe("Error: boom");
  });

  it("keeps ordinary short messages readable", () => {
    expect(sanitizeDiagnosticText("An unexpected response was received from the server.")).toBe("An unexpected response was received from the server.");
    expect(sanitizeDiagnosticText("started")).toBe("started");
  });

  it("returns an empty string for a non-text value", () => {
    expect(sanitizeDiagnosticText(undefined)).toBe("");
    expect(sanitizeDiagnosticText(42)).toBe("");
  });
});
