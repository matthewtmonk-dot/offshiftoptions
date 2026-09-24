import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), connection: vi.fn(), token: vi.fn(), capture: vi.fn() }));
// No write method exists in this mock: any attempted mutation fails the test.
vi.mock("@/lib/prisma", () => ({ prisma: { tradingAccount: { findMany: mocks.findMany } } }));
vi.mock("./tokens", () => ({ findSchwabMarketDataConnectionForUser: mocks.connection, getValidSchwabAccessTokenForConnection: mocks.token,
  accountNumbersFromMetadata: (metadata: unknown) => metadata }));
vi.mock("./account-structure-diagnostic", () => ({ captureAccountStructure: mocks.capture }));
import { listDiagnosticAccounts, runSelectedAccountDiagnostic } from "./account-structure-preflight";

describe("diagnostic account preflight", () => {
  beforeEach(() => vi.resetAllMocks());
  it("lists only internal IDs even if returned rows contain extra sensitive columns", async () => {
    mocks.findMany.mockResolvedValue([{ id: "internal-account", userId: "internal-owner", name: "SECRET_NAME", externalAccountId: "SECRET_HASH", balance: 12000 }]);
    expect(await listDiagnosticAccounts()).toEqual([{ ownerId: "internal-owner", accountId: "internal-account" }]);
    expect(mocks.findMany.mock.calls[0][0].select).toEqual({ id: true, userId: true });
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
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
