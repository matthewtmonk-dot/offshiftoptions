import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ brokerConnection: { findFirst: vi.fn() } }));
vi.mock("@/lib/prisma", () => { throw new Error("Application DB must not be imported"); });
vi.mock("./crypto", () => ({ decryptToken: () => "TOKEN" }));
import { findSchwabMarketDataConnectionForUser, getValidSchwabAccessTokenForConnection } from "./token-read";

describe("diagnostic DB isolation", () => {
  it("uses injected read-only token DB without importing application client or refresh code", async () => {
    db.brokerConnection.findFirst.mockResolvedValue({ userId: "owner", status: "CONNECTED", accessTokenCiphertext: "cipher", refreshTokenCiphertext: "cipher", expiresAt: new Date(Date.now() + 600000) });
    expect(await findSchwabMarketDataConnectionForUser("owner", db)).toBeTruthy();
    expect(await getValidSchwabAccessTokenForConnection("c", { expectedUserId: "owner", db, allowRefresh: false })).toBe("TOKEN");
    db.brokerConnection.findFirst.mockResolvedValue({ userId: "owner", status: "CONNECTED", accessTokenCiphertext: "cipher", refreshTokenCiphertext: "cipher", expiresAt: new Date(0) });
    expect(await getValidSchwabAccessTokenForConnection("c", { expectedUserId: "owner", db, allowRefresh: false })).toBeNull();
  });

  it.each([true, false])("standalone DB error emits only fixed output (list=%s)", list => {
    const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/diagnostics/schwab-account-structure.ts", ...(list ? ["--list"] : [])], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8", timeout: 20000,
      env: { ...process.env, NODE_OPTIONS: "", NODE_ENV: "production", DATABASE_URL: "postgresql://SECRET_USER:SECRET_PASSWORD@127.0.0.1:1/SECRET_DB?connect_timeout=1", OSO_DIAGNOSTIC_OWNER_ID: "owner", OSO_DIAGNOSTIC_ACCOUNT_ID: "account" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(list ? "Diagnostic database unavailable.\n" : "Diagnostic unavailable. Check owner/account selection, environment and a fresh existing Schwab connection. No raw error details emitted.\n");
  }, 25000);
});
