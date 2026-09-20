import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

export type BuildInfo = {
  /** Short commit SHA (12 chars) of the build actually running, or "unknown" - never fabricated. */
  commit: string;
  /** ISO timestamp of when the build was produced, or null when unavailable. */
  buildTime: string | null;
};

const DEFAULT_PATH = path.join(process.cwd(), "src", "generated", "build-info.json");

/**
 * Reads the commit/build-time pair written by scripts/write-build-info.mjs during `pnpm build`
 * (see that script for exactly how the commit is resolved - env var, else .git/HEAD, else
 * "unknown"). Deliberately reads a plain generated file rather than importing it as a TS module:
 * a missing or malformed file (e.g. local `next dev`/tests that never ran the build script) must
 * degrade to an honest "unknown", never fail a build or crash a caller - callers like /api/health
 * must stay up regardless of whether this file exists.
 */
export function getBuildInfo(filePath: string = DEFAULT_PATH): BuildInfo {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { commit?: unknown; generatedAt?: unknown };
    const commit = typeof parsed.commit === "string" && parsed.commit.trim() ? parsed.commit.trim() : "unknown";
    const buildTime = typeof parsed.generatedAt === "string" && parsed.generatedAt.trim() ? parsed.generatedAt.trim() : null;
    return { commit, buildTime };
  } catch {
    return { commit: "unknown", buildTime: null };
  }
}
