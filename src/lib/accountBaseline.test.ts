import { beforeEach, describe, expect, it, vi } from "vitest";

// Account Baseline & Funding Boundaries ticket: setAccountBaselineForUser and the funding-authority
// block in addAccountLedgerEntryForUser both need real ownership/concurrency checks against Prisma.
// Mocked Prisma lets this run without a real database - see scanner-settings.test.ts for the same pattern.
const db = vi.hoisted(() => ({
  tradingAccount: { findFirst: vi.fn() },
  accountLedgerEntry: { findMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: db }));

import { addAccountLedgerEntryForUser, setAccountBaselineForUser } from "./workflows";
import { ValidationError } from "./tickers";
import { Prisma } from "@/generated/prisma/client";

function manualAccount(overrides: Partial<{ id: string; userId: string }> = {}) {
  return { id: "acct-1", userId: "matt", source: "MANUAL", ...overrides };
}
function schwabAccount(overrides: Partial<{ id: string; userId: string }> = {}) {
  return { id: "acct-1", userId: "matt", source: "SCHWAB", ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mirrors the real prisma.$transaction(async (tx) => {...}) by running the callback against the
  // same mocked db object standing in for `tx`.
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) => callback(db));
});

describe("addAccountLedgerEntryForUser funding authority (Account Baseline & Funding Boundaries)", () => {
  it("blocks a new manual deposit on a Schwab account based on persisted account.source", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(schwabAccount());

    await expect(addAccountLedgerEntryForUser("matt", "acct-1", "DEPOSIT", "2026-09-01", "100", null)).rejects.toThrow(ValidationError);
    expect(db.accountLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("still blocks the Schwab account even when the request looks like Schwab is disconnected (source is persisted, not live connection status)", async () => {
    // The mocked account record here has no connection-status field at all - the block must come
    // purely from `source`, since addAccountLedgerEntryForUser never queries connection health.
    db.tradingAccount.findFirst.mockResolvedValue(schwabAccount());

    await expect(addAccountLedgerEntryForUser("matt", "acct-1", "WITHDRAWAL", "2026-09-01", "50", null)).rejects.toThrow(
      /tracked from Schwab activity/i,
    );
  });

  it("allows a manual account's deposit through as before", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    db.accountLedgerEntry.create.mockResolvedValue({ id: "entry-1" });

    await addAccountLedgerEntryForUser("matt", "acct-1", "DEPOSIT", "2026-09-01", "100", null);

    expect(db.accountLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "DEPOSIT", amount: 100, source: "MANUAL" }) }),
    );
  });

  it("rejects an account the caller does not own, before any ledger write", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(null);

    await expect(addAccountLedgerEntryForUser("matt", "not-mine", "DEPOSIT", "2026-09-01", "100", null)).rejects.toThrow(ValidationError);
    expect(db.accountLedgerEntry.create).not.toHaveBeenCalled();
  });
});

describe("setAccountBaselineForUser (Account Baseline & Funding Boundaries)", () => {
  it("creates a first STARTING_VALUE for a manual account when no baseline exists yet", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    db.accountLedgerEntry.findMany.mockResolvedValue([]);
    db.accountLedgerEntry.create.mockResolvedValue({ id: "baseline-1" });

    await setAccountBaselineForUser("matt", "acct-1", "2026-06-15", "10000", "", "");

    expect(db.accountLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accountId: "acct-1", type: "STARTING_VALUE", amount: 10_000, source: "MANUAL", notes: null }),
      }),
    );
    // End-of-NY-day convention: 2026-06-15 23:59:59.999 America/New_York (EDT, UTC-4) is 03:59:59.999Z the next day.
    const call = db.accountLedgerEntry.create.mock.calls[0]![0];
    expect((call.data.occurredAt as Date).toISOString()).toBe("2026-06-16T03:59:59.999Z");
  });

  it("is NOT gated by account.source - a Schwab account can also receive an explicit baseline", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(schwabAccount());
    db.accountLedgerEntry.findMany.mockResolvedValue([]);
    db.accountLedgerEntry.create.mockResolvedValue({ id: "baseline-1" });

    await setAccountBaselineForUser("matt", "acct-1", "2026-06-15", "10000", "", "");

    expect(db.accountLedgerEntry.create).toHaveBeenCalled();
  });

  it("rejects an invalid baseline date before touching the database", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());

    await expect(setAccountBaselineForUser("matt", "acct-1", "not-a-date", "10000", "", "")).rejects.toThrow(ValidationError);
    expect(db.accountLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(db.accountLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("rejects an account the caller does not own", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(null);

    await expect(setAccountBaselineForUser("matt", "not-mine", "2026-06-15", "10000", "", "")).rejects.toThrow(ValidationError);
    expect(db.accountLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("appends a correction rather than editing the prior STARTING_VALUE, recording the replaced id and reason in notes", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    db.accountLedgerEntry.findMany.mockResolvedValue([
      { id: "baseline-1", occurredAt: new Date("2026-06-16T03:59:59.999Z"), createdAt: new Date("2026-06-16T04:00:00Z"), amount: 10_000 },
    ]);
    db.accountLedgerEntry.create.mockResolvedValue({ id: "baseline-2" });

    await setAccountBaselineForUser("matt", "acct-1", "2026-06-20", "10500", "found an old statement", "baseline-1");

    // The prior entry is never updated or deleted - only a new row is created.
    expect(db.accountLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "STARTING_VALUE",
          amount: 10_500,
          notes: "Replaces STARTING_VALUE baseline-1 - found an old statement",
        }),
      }),
    );
  });

  it("rejects a correction that identifies a stale baseline revision (another correction was already recorded)", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    // The caller believes "baseline-1" is still effective, but "baseline-2" (created later) already is.
    db.accountLedgerEntry.findMany.mockResolvedValue([
      { id: "baseline-1", occurredAt: new Date("2026-06-16T03:59:59.999Z"), createdAt: new Date("2026-06-16T04:00:00Z"), amount: 10_000 },
      { id: "baseline-2", occurredAt: new Date("2026-06-20T03:59:59.999Z"), createdAt: new Date("2026-06-21T04:00:00Z"), amount: 10_500 },
    ]);

    await expect(setAccountBaselineForUser("matt", "acct-1", "2026-06-25", "11000", "", "baseline-1")).rejects.toThrow(
      /already updated elsewhere/i,
    );
    expect(db.accountLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("re-selects the effective baseline inside the same transaction as the write (re-check-then-write)", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    db.accountLedgerEntry.findMany.mockResolvedValue([]);
    db.accountLedgerEntry.create.mockResolvedValue({ id: "baseline-1" });

    await setAccountBaselineForUser("matt", "acct-1", "2026-06-15", "10000", "", "");

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.accountLedgerEntry.findMany).toHaveBeenCalledTimes(1);
    expect(db.accountLedgerEntry.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a correction with no reason, before any write (Astra corrective patch, Issue 9)", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    db.accountLedgerEntry.findMany.mockResolvedValue([
      { id: "baseline-1", occurredAt: new Date("2026-06-16T03:59:59.999Z"), createdAt: new Date("2026-06-16T04:00:00Z"), amount: 10_000 },
    ]);

    await expect(setAccountBaselineForUser("matt", "acct-1", "2026-06-20", "10500", "", "baseline-1")).rejects.toThrow(
      /reason/i,
    );
    expect(db.accountLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("allows the very first baseline with no reason - there is no prior revision to explain replacing", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    db.accountLedgerEntry.findMany.mockResolvedValue([]);
    db.accountLedgerEntry.create.mockResolvedValue({ id: "baseline-1" });

    await expect(setAccountBaselineForUser("matt", "acct-1", "2026-06-15", "10000", "", "")).resolves.toBeDefined();
  });

  it("runs the correction transaction at Serializable isolation (Astra corrective patch, Issue 6)", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    db.accountLedgerEntry.findMany.mockResolvedValue([]);
    db.accountLedgerEntry.create.mockResolvedValue({ id: "baseline-1" });

    await setAccountBaselineForUser("matt", "acct-1", "2026-06-15", "10000", "", "");

    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("translates a Postgres serialization/write-conflict failure (P2034) into a user-safe stale/reload error", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    // Simulates two concurrent corrections both reading the same effective revision and both
    // passing the transaction's internal re-check - only Serializable isolation catches this at
    // the database level, surfacing as Prisma error code P2034 when the transaction commits.
    db.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock. Please retry your transaction", {
        code: "P2034",
        clientVersion: "test",
      }),
    );

    await expect(setAccountBaselineForUser("matt", "acct-1", "2026-06-15", "10000", "", "")).rejects.toThrow(ValidationError);
    await expect(setAccountBaselineForUser("matt", "acct-1", "2026-06-15", "10000", "", "")).rejects.toThrow(/reload and try again/i);
  });

  it("does not swallow an unrelated transaction failure as if it were a stale-revision conflict", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(manualAccount());
    db.$transaction.mockRejectedValueOnce(new Error("connection lost"));

    await expect(setAccountBaselineForUser("matt", "acct-1", "2026-06-15", "10000", "", "")).rejects.toThrow("connection lost");
  });
});
