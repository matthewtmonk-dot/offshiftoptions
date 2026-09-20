import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBuildInfo } from "./build-info";

describe("getBuildInfo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "build-info-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a well-formed generated file", () => {
    const file = path.join(dir, "build-info.json");
    writeFileSync(file, JSON.stringify({ commit: "123bcc5abcde", generatedAt: "2026-09-19T18:00:00.000Z" }));
    expect(getBuildInfo(file)).toEqual({ commit: "123bcc5abcde", buildTime: "2026-09-19T18:00:00.000Z" });
  });

  it("returns 'unknown' and null buildTime when the file does not exist - never crashes the caller", () => {
    const missing = path.join(dir, "does-not-exist.json");
    expect(getBuildInfo(missing)).toEqual({ commit: "unknown", buildTime: null });
  });

  it("returns 'unknown' when the file contains malformed JSON", () => {
    const file = path.join(dir, "build-info.json");
    writeFileSync(file, "{ not valid json");
    expect(getBuildInfo(file)).toEqual({ commit: "unknown", buildTime: null });
  });

  it("returns 'unknown' when commit is missing or not a string, and null buildTime when generatedAt is missing or not a string", () => {
    const file = path.join(dir, "build-info.json");
    writeFileSync(file, JSON.stringify({ generatedAt: 12345 }));
    expect(getBuildInfo(file)).toEqual({ commit: "unknown", buildTime: null });
  });

  it("treats a blank commit string the same as missing", () => {
    const file = path.join(dir, "build-info.json");
    writeFileSync(file, JSON.stringify({ commit: "   ", generatedAt: "2026-09-19T18:00:00.000Z" }));
    expect(getBuildInfo(file).commit).toBe("unknown");
  });
});
