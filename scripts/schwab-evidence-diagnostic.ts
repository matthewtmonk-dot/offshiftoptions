/**
 * PHASE 2 PROVIDER EVIDENCE DIAGNOSTIC — READ ONLY. TEMPORARY DIAGNOSTIC CODE.
 *
 * Lives ONLY on the `schwab-evidence-diagnostic` branch - never merged to main, never part of the
 * application. Run manually from a temporary Hostinger checkout that already has a real,
 * CONNECTED Schwab market-data connection (this local sandbox does not - confirmed: no
 * SCHWAB_CLIENT_ID/SCHWAB_CLIENT_SECRET/SCHWAB_TOKEN_ENCRYPTION_KEY configured anywhere here, and
 * zero BrokerConnection rows for provider SCHWAB in the local database).
 *
 * WHAT THIS DOES
 *   1. Lists CONNECTED Schwab market-data connections by a MASKED account label (first name +
 *      last initial + a 4-character connection-id suffix) - never a raw user id, email, account
 *      hash, or token. If more than one exists, it stops and asks for the 4-character suffix
 *      shown next to the candidate you mean; it never requires pasting anything sensitive.
 *   2. Checks the connection's needsRefresh() state BEFORE touching the token. If a refresh would
 *      be required, it STOPS - no refresh call exists anywhere in this file.
 *   3. Decrypts the existing access token in memory only (never logged, never written anywhere).
 *   4. Makes exactly one quote GET (SPY) and two market-hours GETs (one ordinary day, one
 *      early-close day) against Schwab's real Market Data API - read-only GETs, never an order or
 *      account-write endpoint.
 *   5. Writes ONLY a sanitized JSON artifact (schwab-evidence-capture.json, in the current working
 *      directory) and prints a short safe summary. No database writes anywhere in this file.
 *
 * WHY THIS DOESN'T `import` src/providers/schwab/{tokens,crypto,client,config}.ts directly: every
 * one of those files starts with `import "server-only"`, which throws outside a real Next.js
 * server-render context (confirmed by trying it as a plain tsx script). The small pieces this
 * script needs from them (the CONNECTED-lookup query, needsRefresh's exact comparison, and
 * decryptToken's exact AES-256-GCM envelope format) are reimplemented byte-for-byte below, cited
 * by source file/function - this is intentionally NOT new provider logic, and the encrypt path is
 * never reimplemented (this script only ever needs to decrypt an existing token).
 *
 * RUN (from the Hostinger checkout's repo root, on the `schwab-evidence-diagnostic` branch):
 *   npx tsx scripts/schwab-evidence-diagnostic.ts                 # lists masked candidates, stops
 *   npx tsx scripts/schwab-evidence-diagnostic.ts --account 7ab3  # runs against that one connection
 *
 * Requires the SAME DATABASE_URL and SCHWAB_TOKEN_ENCRYPTION_KEY environment variables the running
 * application already uses - nothing new to configure. Delete this branch and its output file once
 * you've copied what you need from the evidence; never merge it into main.
 */
import "dotenv/config";
import { createDecipheriv } from "node:crypto";
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { connectionSelectorSuffix, deepSanitize, maskAccountLabel, sanitizeQuoteCapture } from "./schwab-evidence-sanitizer";

const SCHWAB_MARKET_DATA_BASE_URL = "https://api.schwabapi.com/marketdata/v1"; // src/providers/schwab/config.ts, value only - not a secret

// --- Reimplemented, read-only, from src/providers/schwab/tokens.ts ---------------------------
type StoredConnection = { id: string; userId: string; accessTokenCiphertext: string | null; expiresAt: Date | null };

async function findConnectedSchwabConnections(): Promise<(StoredConnection & { userName: string })[]> {
  const rows = await prisma.brokerConnection.findMany({
    where: { provider: "SCHWAB", status: "CONNECTED", accessTokenCiphertext: { not: null }, refreshTokenCiphertext: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, userId: true, accessTokenCiphertext: true, expiresAt: true, user: { select: { name: true } } },
  });
  return rows.map((row) => ({ id: row.id, userId: row.userId, accessTokenCiphertext: row.accessTokenCiphertext, expiresAt: row.expiresAt, userName: row.user.name }));
}

function needsRefresh(connection: Pick<StoredConnection, "expiresAt">, now = new Date()): boolean {
  if (!connection.expiresAt) return true;
  return connection.expiresAt.getTime() - now.getTime() < 60_000;
}

// --- Reimplemented, decrypt-only, from src/providers/schwab/crypto.ts ------------------------
function parseTokenEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.startsWith("base64:")) return Buffer.from(value.slice("base64:".length), "base64");
  if (value.startsWith("hex:")) return Buffer.from(value.slice("hex:".length), "hex");
  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) return base64;
  return Buffer.from(value, "utf8");
}
function decryptToken(envelope: string): string {
  const raw = process.env.SCHWAB_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("SCHWAB_TOKEN_ENCRYPTION_KEY is required for Schwab token storage.");
  const key = parseTokenEncryptionKey(raw);
  if (key.length !== 32) throw new Error("SCHWAB_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  const [version, ivBase64, tagBase64, ciphertextBase64] = envelope.split(":");
  if (version !== "v1" || !ivBase64 || !tagBase64 || !ciphertextBase64) throw new Error("Unsupported encrypted token format.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextBase64, "base64url")), decipher.final()]).toString("utf8");
}

// --- Live, read-only Schwab Market Data GETs --------------------------------------------------
async function schwabGet(accessToken: string, path: string, params: Record<string, string>) {
  const url = new URL(`${SCHWAB_MARKET_DATA_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const requestStartedAt = new Date();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const responseReceivedAt = new Date();
  const httpDateHeader = response.headers.get("date");
  if (!response.ok) throw new Error(`Schwab GET ${path} failed: HTTP ${response.status}`);
  const payload = await response.json();
  return { payload, requestStartedAt, responseReceivedAt, httpDateHeader };
}

async function captureMarketHours(accessToken: string, dateStr: string) {
  try {
    const { payload, requestStartedAt, responseReceivedAt } = await schwabGet(accessToken, "/markets", { markets: "equity", date: dateStr });
    return {
      requestedDate: dateStr,
      path: "GET /marketdata/v1/markets",
      diagnosticTransportEvidence: { requestStartedAt: requestStartedAt.toISOString(), responseReceivedAt: responseReceivedAt.toISOString() },
      // Full nested structure, never flattened - only secret-shaped keys/values are redacted.
      sanitizedFullResponse: deepSanitize(payload),
    };
  } catch (error) {
    return { requestedDate: dateStr, error: "Market hours request failed.", message: error instanceof Error ? error.message : String(error) };
  }
}

function parseArgs(argv: string[]) {
  const idx = argv.indexOf("--account");
  const suffix = idx !== -1 ? argv[idx + 1] : undefined;
  return { suffix: suffix?.trim().toLowerCase() };
}

async function main() {
  const { suffix } = parseArgs(process.argv.slice(2));
  const connections = await findConnectedSchwabConnections();

  if (connections.length === 0) {
    console.error("STOP: no CONNECTED Schwab market-data connection exists. Nothing was fetched.");
    await prisma.$disconnect();
    process.exit(1);
  }

  let selected: (StoredConnection & { userName: string }) | undefined;
  if (suffix) {
    const matches = connections.filter((c) => connectionSelectorSuffix(c.id) === suffix);
    if (matches.length !== 1) {
      console.error(
        matches.length === 0
          ? `STOP: no CONNECTED Schwab connection matches suffix "${suffix}".`
          : `STOP: suffix "${suffix}" matches more than one connection - ask for a longer/different disambiguator, this should not normally happen with a 4-character suffix.`,
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    selected = matches[0];
  } else if (connections.length === 1) {
    selected = connections[0];
    console.log("Exactly one CONNECTED Schwab connection found - proceeding automatically:");
    console.log(`  ${maskAccountLabel(selected.userName, selected.id)}`);
  } else {
    console.log(`${connections.length} CONNECTED Schwab connections found. Re-run with --account <suffix> to pick one:\n`);
    for (const c of connections) {
      console.log(`  ${maskAccountLabel(c.userName, c.id)}  ->  --account ${connectionSelectorSuffix(c.id)}`);
    }
    console.log("\nSTOP: no unambiguous selector was supplied. Nothing was fetched.");
    await prisma.$disconnect();
    process.exit(1);
  }

  if (needsRefresh(selected)) {
    console.error(
      "STOP: the stored access token is expired or within 60s of expiring. Token refresh is disabled for " +
        "this diagnostic - no refresh call exists in this file. Nothing was fetched.",
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`Using connection: ${maskAccountLabel(selected.userName, selected.id)}`);
  const accessToken = decryptToken(selected.accessTokenCiphertext!);

  const capture: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    nothingSaved: true,
    tokenRefreshUsed: false,
    account: maskAccountLabel(selected.userName, selected.id),
  };

  // A. Equity quote capture (SPY)
  const quoteSymbol = "SPY";
  const quoteFields = "quote,reference,regular,fundamental,extended";
  try {
    const { payload, requestStartedAt, responseReceivedAt, httpDateHeader } = await schwabGet(accessToken, "/quotes", {
      symbols: quoteSymbol,
      fields: quoteFields,
    });
    capture.quoteCapture = sanitizeQuoteCapture({
      symbol: quoteSymbol, fields: quoteFields, payload,
      requestStartedAt: requestStartedAt.toISOString(), responseReceivedAt: responseReceivedAt.toISOString(), httpDateHeader,
    });
  } catch (error) {
    capture.quoteCapture = { error: "Quote request failed.", message: error instanceof Error ? error.message : String(error) };
  }

  // B. Market hours capture - ordinary day + early-close day
  const ordinaryDay = "2026-09-22"; // an ordinary NYSE Tuesday, already in the past
  const earlyCloseDay = "2026-11-27"; // scheduled NYSE early close (day after Thanksgiving) - if
  // Schwab rejects a future date, edit this to a known historical early-close date instead
  // (e.g. "2025-11-28" or "2024-11-29") and note in your report which date was actually used.
  capture.marketHoursOrdinaryDay = await captureMarketHours(accessToken, ordinaryDay);
  capture.marketHoursEarlyClose = await captureMarketHours(accessToken, earlyCloseDay);

  const outPath = "./schwab-evidence-capture.json";
  writeFileSync(outPath, JSON.stringify(capture, null, 2), "utf8");

  console.log("\n=== Safe summary ===");
  console.log("Account:", capture.account);
  const quoteCapture = capture.quoteCapture as ReturnType<typeof sanitizeQuoteCapture> | { error: string };
  if ("error" in quoteCapture) {
    console.log("Quote capture: FAILED -", quoteCapture.error);
  } else {
    console.log("Quote: requested", quoteCapture.requestedSymbol, "| exact symbol match:", quoteCapture.exactSymbolKeyMatch, "| matched key:", quoteCapture.matchedKeyUsed);
    console.log("  quote group present:", quoteCapture.quoteGroup.present, "| regular group present:", quoteCapture.regularGroup.present, "| extended group present:", quoteCapture.extendedGroup.present);
  }
  console.log("Market hours (ordinary day, isOpen if determinable):", summarizeMarketHours(capture.marketHoursOrdinaryDay));
  console.log("Market hours (early-close day, isOpen if determinable):", summarizeMarketHours(capture.marketHoursEarlyClose));
  console.log("\nSanitized capture written to:", outPath);
  console.log("Delete this file and this branch once you've copied what you need - never commit either to main.");

  await prisma.$disconnect();
}

function summarizeMarketHours(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "unavailable";
  const e = entry as { error?: string; sanitizedFullResponse?: unknown };
  if (e.error) return `FAILED - ${e.error}`;
  return "captured (see JSON file for full nested structure)";
}

main().catch((error) => {
  console.error("Diagnostic failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
