// Manual only. Run with --conditions=react-server; never import into build/start/routes.

const writeReport = process.stdout.write.bind(process.stdout);
const writeFailure = process.stderr.write.bind(process.stderr);

async function main() {
  await import("dotenv/config");
  if (process.argv.slice(2).some(arg => arg !== "--list") || process.argv.slice(2).length > 1) throw new Error("Invalid mode");
  const ownerId = process.env.OSO_DIAGNOSTIC_OWNER_ID;
  const accountId = process.env.OSO_DIAGNOSTIC_ACCOUNT_ID;
  const listMode = process.argv[2] === "--list";
  if (!listMode && (!ownerId || !accountId)) throw new Error("Selection missing");
  const { prisma } = await import("../../src/lib/prisma");
  // Prevent Prisma's default error logger from exposing connection/query details.
  try {
    const { listDiagnosticAccounts, runSelectedAccountDiagnostic } = await import("../../src/providers/schwab/account-structure-preflight");
    const report = listMode ? await listDiagnosticAccounts() : await runSelectedAccountDiagnostic(ownerId, accountId);
    writeReport(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await prisma.$disconnect();
  }
}

// Imported library log/error paths must not print raw payloads, credentials or SQL.
console.log = console.info = console.warn = console.error = console.debug = () => {};
process.stdout.write = (() => true) as typeof process.stdout.write;
process.stderr.write = (() => true) as typeof process.stderr.write;
function fail() {
  writeFailure("Diagnostic unavailable. Check owner/account selection, environment and a fresh existing Schwab connection. No raw error details emitted.\n");
  process.exitCode = 1;
}
process.on("uncaughtException", () => { fail(); process.exit(1); });
process.on("unhandledRejection", () => { fail(); process.exit(1); });
main().catch(fail);
