// Manual only. Run with --conditions=react-server; never import into build/start/routes.

import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function runListDiagnosticMode() {
  try {
    const { listDiagnosticAccounts } = await import("../../src/providers/schwab/account-structure-list");
    const accounts = await listDiagnosticAccounts();
    const eligibleCount = accounts.filter((row) => row.diagnosticCaptureEligible).length;
    process.stdout.write(JSON.stringify({ accounts, eligibleCount }, null, 2) + "\n");
  } catch {
    writeSync(2, "Diagnostic database unavailable.\n");
    process.exitCode = 1;
  }
}

export async function runCaptureDiagnosticMode(ownerId: string, accountId: string) {
  try {
    const { runSelectedAccountDiagnostic } = await import("../../src/providers/schwab/account-structure-preflight");
    const report = await runSelectedAccountDiagnostic(ownerId, accountId);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch {
    writeSync(2, "Diagnostic unavailable. Check owner/account selection, environment and a fresh existing Schwab connection. No raw error details emitted.\n");
    process.exitCode = 1;
  }
}

async function main() {
  await import("dotenv/config");

  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--list")) {
    throw new Error("Invalid mode");
  }

  const ownerId = process.env.OSO_DIAGNOSTIC_OWNER_ID;
  const accountId = process.env.OSO_DIAGNOSTIC_ACCOUNT_ID;
  const listMode = args[0] === "--list";

  if (!listMode && (!ownerId || !accountId)) {
    throw new Error("Selection missing");
  }

  const { prismaDiagnostic } = await import("../../src/lib/prisma-diagnostic");
  try {
    if (listMode) await runListDiagnosticMode();
    else await runCaptureDiagnosticMode(ownerId!, accountId!);
  } finally { await prismaDiagnostic.$disconnect(); }
}

function fail(message: string) {
  writeSync(2, `${message}\n`);
  process.exitCode = 1;
}

const isDirectExecution = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  process.on("uncaughtException", () => { fail("Diagnostic unavailable. Check owner/account selection, environment and a fresh existing Schwab connection. No raw error details emitted."); process.exit(1); });
  process.on("unhandledRejection", () => { fail("Diagnostic unavailable. Check owner/account selection, environment and a fresh existing Schwab connection. No raw error details emitted."); process.exit(1); });
  main().catch(() => {
    fail("Diagnostic unavailable. Check owner/account selection, environment and a fresh existing Schwab connection. No raw error details emitted.");
  });
}
