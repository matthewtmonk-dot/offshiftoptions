import "server-only";

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A small, safe, self-service diagnostics log - because production logs are not visible to the people
 * working on this app. It records WHAT HAPPENED (server start/exit, unexpected request errors, and when a
 * settings save started and finished) so a failure can be explained from a page inside the app.
 *
 * Safety: messages are sanitized (no connection strings, tokens or long opaque values, cut to 200
 * characters) and the page that reads it requires a signed-in user. It writes to the OS temp directory,
 * which survives a server restart on the same host - exactly the case it exists to reveal. Every write
 * is best-effort: diagnostics must never be able to break the app.
 */
export type DiagnosticEvent = {
  at: string;
  kind: "boot" | "exit" | "error" | "action";
  source: string;
  message?: string;
  digest?: string;
  durationMs?: number;
};

const LOG_FILE = join(tmpdir(), "oso-diagnostics.jsonl");
const MAX_FILE_BYTES = 256 * 1024;
const KEEP_LINES_ON_ROTATE = 150;
const MAX_MESSAGE_LENGTH = 200;

const globalState = globalThis as typeof globalThis & { __osoDiagnosticsInstalled?: boolean; __osoProcessStartedAt?: number };

/** Strips anything that could be a secret and bounds the length. Exported for tests. */
export function sanitizeDiagnosticText(value: unknown): string {
  const text = typeof value === "string" ? value : value instanceof Error ? `${value.name}: ${value.message}` : "";
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\b(bearer|basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, "[…]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

export function recordDiagnostic(event: Omit<DiagnosticEvent, "at">): void {
  try {
    const entry: DiagnosticEvent = {
      at: new Date().toISOString(),
      kind: event.kind,
      source: sanitizeDiagnosticText(event.source),
      ...(event.message !== undefined ? { message: sanitizeDiagnosticText(event.message) } : {}),
      ...(event.digest ? { digest: sanitizeDiagnosticText(event.digest).slice(0, 40) } : {}),
      ...(event.durationMs !== undefined ? { durationMs: Math.round(event.durationMs) } : {}),
    };
    appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // best-effort only
  }
}

export function readDiagnostics(limit = 80): { events: DiagnosticEvent[]; readable: boolean } {
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    const events: DiagnosticEvent[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        events.push(JSON.parse(line) as DiagnosticEvent);
      } catch {
        // skip a torn line
      }
    }
    return { events: events.reverse(), readable: true };
  } catch {
    return { events: [], readable: false };
  }
}

export function processInfo(): { startedAt: string; uptimeSeconds: number; node: string; memoryMb: number } {
  const startedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

function rotateIfLarge(): void {
  try {
    if (statSync(LOG_FILE).size > MAX_FILE_BYTES) {
      const kept = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).slice(-KEEP_LINES_ON_ROTATE);
      writeFileSync(LOG_FILE, `${kept.join("\n")}\n`);
    }
  } catch {
    // no file yet, or unreadable - nothing to rotate
  }
}

/** Called once per server process from instrumentation.ts. Idempotent. Observes only - it never
 * changes how the process handles errors (uncaughtExceptionMonitor does not swallow the exception). */
export function installProcessDiagnostics(): void {
  if (globalState.__osoDiagnosticsInstalled) return;
  globalState.__osoDiagnosticsInstalled = true;
  rotateIfLarge();
  recordDiagnostic({ kind: "boot", source: "process", message: `server started (node ${process.version})` });
  process.on("uncaughtExceptionMonitor", (error) => {
    recordDiagnostic({ kind: "error", source: "uncaught exception (process will exit)", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  });
  process.on("exit", (code) => {
    recordDiagnostic({ kind: "exit", source: "process", message: `server exiting (code ${code})` });
  });
}
