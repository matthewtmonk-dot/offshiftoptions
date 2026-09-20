#!/usr/bin/env node
// Resolves the commit actually being built - at BUILD TIME only, never at runtime - and writes
// it to a generated JSON file the app reads defensively (see src/lib/build-info.ts). Runs as the
// first step of `pnpm build` (see package.json), before `next build` compiles anything, so
// /api/health can report which deployed commit is live without any runtime git dependency,
// subprocess, or reliance on a specific env var actually being present in production.
//
// PROJECT_HANDOFF.md's Deployment section documents no Hostinger-provided commit env var, and
// separately documents that Hostinger's managed build environment restricts *executing* arbitrary
// spawned binaries (the exact cause of `prisma migrate deploy`'s EACCES failure there). Shelling
// out to `git rev-parse HEAD` would risk the same class of failure, so this script never spawns a
// subprocess at all - it only reads plain files under `.git` with the built-in `fs` module.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "src", "generated");
const OUT_FILE = path.join(OUT_DIR, "build-info.json");

// 1. A deploy-provided commit env var, if the host already sets one. Not confirmed for
// Hostinger as of this slice - checked first in case that changes (e.g. Matt configures one in
// its build settings later), and harmless to check when none of these are set.
function commitFromEnv() {
  const candidates = [
    "GIT_COMMIT_SHA",
    "COMMIT_SHA",
    "SOURCE_COMMIT",
    "SOURCE_VERSION",
    "VERCEL_GIT_COMMIT_SHA",
    "RENDER_GIT_COMMIT",
    "HEROKU_SLUG_COMMIT",
  ];
  for (const name of candidates) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

// 2. Resolve .git/HEAD to the actual commit SHA using only fs reads (see the file-level comment
// for why this deliberately never spawns `git` as a subprocess). Handles both a normal branch
// checkout (HEAD is a "ref: refs/heads/<branch>" pointer) and a detached HEAD (HEAD already
// holds the raw SHA) - Hostinger's GitHub-based auto-deploy checks out `main` normally, so the
// ref-pointer path is the one actually expected to be exercised in production.
function commitFromGitDir() {
  try {
    const gitDir = path.join(process.cwd(), ".git");
    const headPath = path.join(gitDir, "HEAD");
    if (!existsSync(headPath)) return null;

    const head = readFileSync(headPath, "utf8").trim();
    if (!head.startsWith("ref:")) {
      return /^[0-9a-f]{40}$/i.test(head) ? head : null;
    }

    const ref = head.slice(4).trim();
    const refPath = path.join(gitDir, ref);
    if (existsSync(refPath)) {
      const sha = readFileSync(refPath, "utf8").trim();
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    }

    // The ref may have been packed (e.g. after `git gc`) instead of having its own loose file.
    const packedRefsPath = path.join(gitDir, "packed-refs");
    if (existsSync(packedRefsPath)) {
      const line = readFileSync(packedRefsPath, "utf8")
        .split("\n")
        .find((entry) => entry.trim().endsWith(` ${ref}`));
      const sha = line?.trim().split(/\s+/)[0];
      return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    }

    return null;
  } catch {
    return null;
  }
}

function shortSha(sha) {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12) : null;
}

const resolved = commitFromEnv() ?? commitFromGitDir();
const commit = shortSha(resolved) ?? "unknown";
const generatedAt = new Date().toISOString();

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify({ commit, generatedAt }, null, 2)}\n`, "utf8");

console.log(`[write-build-info] commit=${commit} generatedAt=${generatedAt} -> ${path.relative(process.cwd(), OUT_FILE)}`);
