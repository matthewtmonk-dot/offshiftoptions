import { beforeEach, describe, expect, it, vi } from "vitest";
import { runListDiagnosticMode } from "../../../scripts/diagnostics/schwab-account-structure";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), connection: vi.fn(), token: vi.fn(), capture: vi.fn() }));
// No write method exists in this mock: any attempted mutation fails the test.
vi.mock("@/lib/prisma", () => ({ prisma: { tradingAccount: { findMany: mocks.findMany } } }));
vi.mock("@/lib/prisma-diagnostic", () => ({ prismaDiagnostic: { tradingAccount: { findMany: mocks.findMany } } }));
vi.mock("./tokens", () => ({ findSchwabMarketDataConnectionForUser: mocks.connection, getValidSchwabAccessTokenForConnection: mocks.token,
  accountNumbersFromMetadata: (metadata: unknown) => Array.isArray(metadata) ? metadata : [] }));
vi.mock("./account-structure-diagnostic", () => ({ captureAccountStructure: mocks.capture }));
import { listDiagnosticAccounts, runSelectedAccountDiagnostic } from "./account-structure-preflight";

describe("diagnostic account preflight", () => {
  beforeEach(() => vi.resetAllMocks());
  it("lists only safe metadata while reusing owner-scoped Schwab connection mapping semantics", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "internal-account", userId: "internal-owner", name: "CASH ...5106", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_5106", balance: 12000 },
    ]);
    mocks.connection.mockResolvedValue({ id: "conn-1", metadata: [{ hashValue: "HASH_5106" }] });

    expect(await listDiagnosticAccounts()).toEqual([
      {
        ownerId: "internal-owner",
        accountId: "internal-account",
        appAccountName: "CASH ...5106",
        accountSource: "SCHWAB",
        accountType: "Brokerage",
        hasOwnerSchwabConnection: true,
        isMappedToConnectedSchwabAccount: true,
        diagnosticCaptureEligible: true,
      },
    ]);
    expect(mocks.findMany.mock.calls[0][0].select).toMatchObject({ id: true, userId: true, name: true, source: true, accountType: true, externalAccountId: true });
    expect(mocks.connection).toHaveBeenCalledWith("internal-owner");
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("marks owner-scoped connection presence and connected-account mapping independently", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "account-a", userId: "owner-a", name: "CASH ...5106", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_A" },
      { id: "account-b", userId: "owner-b", name: "CASH ...8239", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_B" },
    ]);
    mocks.connection.mockImplementation(async (ownerId: string) => {
      if (ownerId === "owner-a") return { id: "conn-a", metadata: [{ hashValue: "HASH_A" }] };
      return null;
    });

    await expect(listDiagnosticAccounts()).resolves.toEqual([
      {
        ownerId: "owner-a",
        accountId: "account-a",
        appAccountName: "CASH ...5106",
        accountSource: "SCHWAB",
        accountType: "Brokerage",
        hasOwnerSchwabConnection: true,
        isMappedToConnectedSchwabAccount: true,
        diagnosticCaptureEligible: true,
      },
      {
        ownerId: "owner-b",
        accountId: "account-b",
        appAccountName: "CASH ...8239",
        accountSource: "SCHWAB",
        accountType: "Brokerage",
        hasOwnerSchwabConnection: false,
        isMappedToConnectedSchwabAccount: false,
        diagnosticCaptureEligible: false,
      },
    ]);

    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.connection).toHaveBeenCalledTimes(2);
    expect(mocks.connection).toHaveBeenNthCalledWith(1, "owner-a");
    expect(mocks.connection).toHaveBeenNthCalledWith(2, "owner-b");
  });
  it("rejects mismatched external mapping even when owner has an active connection", async () => {
    mocks.findMany.mockResolvedValue([{ id: "account", userId: "owner", name: "CASH ...5106", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_A" }]);
    mocks.connection.mockResolvedValue({ id: "conn", metadata: [{ hashValue: "HASH_B" }] });

    await expect(listDiagnosticAccounts()).resolves.toEqual([
      {
        ownerId: "owner",
        accountId: "account",
        appAccountName: "CASH ...5106",
        accountSource: "SCHWAB",
        accountType: "Brokerage",
        hasOwnerSchwabConnection: true,
        isMappedToConnectedSchwabAccount: false,
        diagnosticCaptureEligible: false,
      },
    ]);

    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("fails closed by clearing eligibility when more than one row maps to active Schwab connections", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "account-a", userId: "owner-a", name: "CASH ...5106", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_A" },
      { id: "account-b", userId: "owner-b", name: "CASH ...8239", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_B" },
    ]);
    mocks.connection.mockImplementation(async (ownerId: string) => ({
      id: `conn-${ownerId}`,
      metadata: ownerId === "owner-a" ? [{ hashValue: "HASH_A" }] : [{ hashValue: "HASH_B" }],
    }));

    await expect(listDiagnosticAccounts()).resolves.toEqual([
      {
        ownerId: "owner-a",
        accountId: "account-a",
        appAccountName: "CASH ...5106",
        accountSource: "SCHWAB",
        accountType: "Brokerage",
        hasOwnerSchwabConnection: true,
        isMappedToConnectedSchwabAccount: true,
        diagnosticCaptureEligible: false,
      },
      {
        ownerId: "owner-b",
        accountId: "account-b",
        appAccountName: "CASH ...8239",
        accountSource: "SCHWAB",
        accountType: "Brokerage",
        hasOwnerSchwabConnection: true,
        isMappedToConnectedSchwabAccount: true,
        diagnosticCaptureEligible: false,
      },
    ]);
  });
  it("uses DB-only list query with no owner or account selection required", async () => {
    mocks.findMany.mockResolvedValue([{ id: "account", userId: "owner", name: "CASH ...5106", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_A" }]);
    mocks.connection.mockResolvedValue({ id: "conn", metadata: [{ hashValue: "HASH_A" }] });
    await listDiagnosticAccounts();

    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0][0]).toMatchObject({
      where: { source: "SCHWAB", externalAccountId: { not: null } },
      orderBy: [{ userId: "asc" }, { id: "asc" }],
    });
    expect(mocks.findMany.mock.calls[0][0].select).toMatchObject({ id: true, userId: true, name: true, source: true, accountType: true, externalAccountId: true });
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("emits a fixed non-sensitive message when no eligible rows are found", async () => {
    const report = vi.fn();
    const failure = vi.fn();
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      report(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      failure(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      mocks.findMany.mockResolvedValue([]);
      await runListDiagnosticMode();
      expect(report).toHaveBeenCalledWith("No eligible diagnostic accounts found.\n");
      expect(failure).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  });
  it("emits a fixed non-sensitive message when the database is unavailable", async () => {
    const report = vi.fn();
    const failure = vi.fn();
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      report(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      failure(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      mocks.findMany.mockRejectedValue(new Error("raw prisma connection failure"));
      await runListDiagnosticMode();
      expect(failure).toHaveBeenCalledWith("Diagnostic database unavailable.\n");
      expect(report).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  });
  it("fails closed when eligibility is ambiguous or unavailable", async () => {
    const report = vi.fn();
    const failure = vi.fn();
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      report(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      failure(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      mocks.findMany.mockResolvedValue([
        { id: "a", userId: "owner-1", name: "CASH ...5106", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_A" },
        { id: "b", userId: "owner-2", name: "CASH ...8239", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "HASH_B" },
      ]);
      mocks.connection.mockImplementation(async (ownerId: string) => ({
        id: `conn-${ownerId}`,
        metadata: ownerId === "owner-1" ? [{ hashValue: "HASH_A" }] : [{ hashValue: "HASH_B" }],
      }));
      await runListDiagnosticMode();
      expect(failure).toHaveBeenCalledWith("Diagnostic capture eligibility is ambiguous or unavailable from safe metadata.\n");
      expect(report).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  });
  it("prints no sensitive identifiers in --list output", async () => {
    const report = vi.fn();
    const failure = vi.fn();
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      report(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      failure(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      mocks.findMany.mockResolvedValue([
        { id: "account", userId: "owner", name: "CASH ...5106", source: "SCHWAB", accountType: "Brokerage", externalAccountId: "SECRET_HASH_5106", balance: 9999 },
      ]);
      mocks.connection.mockResolvedValue({ id: "conn", metadata: [{ hashValue: "SECRET_HASH_5106", accountNumberLast4: "5106" }] });
      await runListDiagnosticMode();

      expect(failure).not.toHaveBeenCalled();
      const printed = report.mock.calls.map(([value]) => String(value)).join("");
      expect(printed).toContain("\"ownerId\"");
      expect(printed).toContain("\"accountId\"");
      expect(printed).toContain("\"hasOwnerSchwabConnection\"");
      expect(printed).toContain("\"isMappedToConnectedSchwabAccount\"");
      expect(printed).toContain("\"diagnosticCaptureEligible\"");
      expect(printed).not.toContain("externalAccountId");
      expect(printed).not.toContain("SECRET_HASH_5106");
      expect(printed).not.toContain("accountNumberLast4");
      expect(printed).not.toContain("balance");
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  });
  it("refuses unspecified selection instead of guessing among listed accounts", async () => {
    await expect(runSelectedAccountDiagnostic()).rejects.toThrow("Explicit owner and account selection required.");
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it.each([{ rows: [] }, { rows: [{ userId: "owner", externalAccountId: "a" }, { userId: "owner", externalAccountId: "b" }] }])("rejects absent or ambiguous selection", async ({ rows }) => {
    mocks.findMany.mockResolvedValue(rows);
    await expect(runSelectedAccountDiagnostic("owner", "account")).rejects.toThrow("Account unavailable.");
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("rejects a wrong owner even if a faulty query returns that account", async () => {
    mocks.findMany.mockResolvedValue([{ userId: "other", externalAccountId: "hash" }]);
    await expect(runSelectedAccountDiagnostic("owner", "account")).rejects.toThrow("You are not allowed to change this record.");
    expect(mocks.connection).not.toHaveBeenCalled();
  });
  it("rejects a hash outside the owner's connection", async () => {
    mocks.findMany.mockResolvedValue([{ userId: "owner", externalAccountId: "hash" }]);
    mocks.connection.mockResolvedValue({ id: "connection", metadata: [{ hashValue: "different" }] });
    await expect(runSelectedAccountDiagnostic("owner", "account")).rejects.toThrow("Connection unavailable.");
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("uses the selected owner, disables refresh and makes one capture", async () => {
    mocks.findMany.mockResolvedValue([{ userId: "owner", externalAccountId: "hash" }]);
    mocks.connection.mockResolvedValue({ id: "connection", metadata: [{ hashValue: "hash" }] });
    mocks.token.mockResolvedValue("TOKEN");
    mocks.capture.mockResolvedValue({ fields: [] });
    expect(await runSelectedAccountDiagnostic("owner", "account")).toEqual({ fields: [] });
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ id: "account", userId: "owner", source: "SCHWAB" });
    expect(mocks.token).toHaveBeenCalledWith("connection", { expectedUserId: "owner", allowRefresh: false });
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith("TOKEN", "hash");
    mocks.token.mockResolvedValue(null);
    await expect(runSelectedAccountDiagnostic("owner", "account")).rejects.toThrow("Fresh token unavailable.");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
});
