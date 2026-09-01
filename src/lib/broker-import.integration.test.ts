import { readFileSync } from "node:fs";
import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "./tickers";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

function fixture(name: string) {
  return readFileSync(new URL(`../providers/schwab/__fixtures__/${name}`, import.meta.url), "utf8");
}

function csvFile(name: string, content: string) {
  return new File([content], name, { type: "text/csv" });
}

maybeDescribe("Schwab broker import (preview/confirm/dedupe/conflict/privacy)", () => {
  let prisma: typeof import("./prisma").prisma;
  let previewBrokerImportForUser: typeof import("./broker-import").previewBrokerImportForUser;
  let confirmBrokerImportForUser: typeof import("./broker-import").confirmBrokerImportForUser;
  let discardBrokerImportForUser: typeof import("./broker-import").discardBrokerImportForUser;
  let getPendingBrokerImportBatchForUser: typeof import("./broker-import").getPendingBrokerImportBatchForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ previewBrokerImportForUser, confirmBrokerImportForUser, discardBrokerImportForUser, getPendingBrokerImportBatchForUser } =
      await import("./broker-import"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({ data: { name: "Import User A", email: `import-a-${timestamp}@lst.local`, passwordHash } });
    userB = await prisma.user.create({ data: { name: "Import User B", email: `import-b-${timestamp}@lst.local`, passwordHash } });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.brokerImportBatch.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("preview never persists a BrokerRecord; confirm does", async () => {
    const preview = await previewBrokerImportForUser(userA.id, csvFile("positions.csv", fixture("positions.csv")), null);
    expect(preview.exportType).toBe("POSITIONS");
    expect(preview.counts.newCount).toBe(3);

    const beforeConfirm = await prisma.brokerRecord.count({ where: { userId: userA.id } });
    expect(beforeConfirm).toBe(0);

    const confirmed = await confirmBrokerImportForUser(userA.id, preview.batchId);
    expect(confirmed.status).toBe("CONFIRMED");
    const afterConfirm = await prisma.brokerRecord.count({ where: { userId: userA.id } });
    expect(afterConfirm).toBe(3);
  });

  it("is idempotent for the exact same file imported twice", async () => {
    const first = await previewBrokerImportForUser(userA.id, csvFile("transactions-run1.csv", fixture("transactions.csv")), null);
    await confirmBrokerImportForUser(userA.id, first.batchId);
    const countAfterFirst = await prisma.brokerRecord.count({ where: { userId: userA.id, kind: "TRANSACTION" } });

    const second = await previewBrokerImportForUser(userA.id, csvFile("transactions-run1-again.csv", fixture("transactions.csv")), null);
    expect(second.counts.newCount).toBe(0);
    expect(second.counts.duplicateCount).toBeGreaterThan(0);
    await confirmBrokerImportForUser(userA.id, second.batchId);

    const countAfterSecond = await prisma.brokerRecord.count({ where: { userId: userA.id, kind: "TRANSACTION" } });
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("is idempotent even under a different filename with the same content", async () => {
    const renamed = await previewBrokerImportForUser(userA.id, csvFile("totally-different-name.csv", fixture("transactions.csv")), null);
    expect(renamed.counts.newCount).toBe(0);
  });

  it("discarding a preview batch never creates BrokerRecords", async () => {
    const preview = await previewBrokerImportForUser(userA.id, csvFile("gainloss.csv", fixture("gainloss-realized.csv")), null);
    await discardBrokerImportForUser(userA.id, preview.batchId);

    const rows = await prisma.brokerRecord.count({ where: { userId: userA.id, kind: "REALIZED_GAIN_LOSS" } });
    expect(rows).toBe(0);

    await expect(confirmBrokerImportForUser(userA.id, preview.batchId)).rejects.toThrow(ValidationError);
  });

  it("flags a same-identity transaction with a different amount as CONFLICT and does not overwrite the original", async () => {
    const original = fixture("transactions.csv");
    const conflicting = original.replace(
      '"08/31/2026","Sell to Open","LSTO 09/04/2026 17.50 P","PUT LOW STRESS TOOLS INC $17.5 EXP 09/04/26","1","$0.28","$0.66","$27.34"',
      '"08/31/2026","Sell to Open","LSTO 09/04/2026 17.50 P","PUT LOW STRESS TOOLS INC $17.5 EXP 09/04/26","1","$0.99","$0.66","$98.34"',
    );

    const originalPreview = await previewBrokerImportForUser(userA.id, csvFile("conflict-base.csv", original), null);
    await confirmBrokerImportForUser(userA.id, originalPreview.batchId);
    const originalRow = await prisma.brokerRecord.findFirst({
      where: { userId: userA.id, kind: "TRANSACTION", symbol: "LSTO 260904P00017500", action: "Sell to Open" },
    });
    expect(originalRow).not.toBeNull();
    expect(Number(originalRow!.amount)).toBe(27.34);

    const conflictPreview = await previewBrokerImportForUser(userA.id, csvFile("conflict-variant.csv", conflicting), null);
    const conflictRow = conflictPreview.rows.find((row) => row.symbol === "LSTO 260904P00017500" && row.amount === 98.34);
    expect(conflictRow?.classification).toBe("CONFLICT");

    await confirmBrokerImportForUser(userA.id, conflictPreview.batchId);

    const stillOriginal = await prisma.brokerRecord.findUnique({ where: { id: originalRow!.id } });
    expect(Number(stillOriginal!.amount)).toBe(27.34);

    const flagged = await prisma.brokerRecord.findFirst({
      where: { userId: userA.id, symbol: "LSTO 260904P00017500", status: "CONFLICT" },
    });
    expect(flagged).not.toBeNull();
    expect(Number(flagged!.amount)).toBe(98.34);
  });

  it("supersedes an older position snapshot with a newer one instead of summing quantities", async () => {
    const olderText = fixture("positions.csv");
    const newerText = olderText
      .replace("07:09 PM ET, 2026/08/31", "08:09 PM ET, 2026/08/31")
      .replace('"-1","0.16"', '"-2","0.20"')
      .replace('"-$16.00"', '"-$40.00"');

    const olderPreview = await previewBrokerImportForUser(userA.id, csvFile("positions-older.csv", olderText), null);
    await confirmBrokerImportForUser(userA.id, olderPreview.batchId);

    const newerPreview = await previewBrokerImportForUser(userA.id, csvFile("positions-newer.csv", newerText), null);
    const lstoRow = newerPreview.rows.find((row) => row.symbol === "LSTO 260904P00017500");
    expect(lstoRow?.classification).toBe("NEW");
    await confirmBrokerImportForUser(userA.id, newerPreview.batchId);

    const current = await prisma.brokerRecord.findFirst({
      where: { userId: userA.id, kind: "POSITION", symbol: "LSTO 260904P00017500" },
    });
    expect(Number(current!.quantity)).toBe(-2);
    expect(Number(current!.amount)).toBe(-40);

    const totalLstoRows = await prisma.brokerRecord.count({
      where: { userId: userA.id, kind: "POSITION", symbol: "LSTO 260904P00017500" },
    });
    expect(totalLstoRows).toBe(1);
  });

  it("reports a malformed row as invalid instead of silently dropping it or crashing the batch", async () => {
    // A positions row with a symbol present but an unreadable quantity should be surfaced
    // as INVALID, not silently skipped like the legitimate cash/total summary rows are.
    const positionsWithBadRow = fixture("positions.csv").replace(
      '"Cash & Cash Investments"',
      '"BADROW 09/04/2026 1.00 P","PUT BAD ROW","not-a-number","0.10","0","0%","-$1.00","$0","0%","-$1.00","$0","0%","N/A","N/A","Option",\n"Cash & Cash Investments"',
    );

    const preview = await previewBrokerImportForUser(userA.id, csvFile("positions-with-bad-row.csv", positionsWithBadRow), null);
    expect(preview.counts.invalidCount).toBeGreaterThanOrEqual(1);
  });

  it("User B cannot view, confirm, or discard User A's import batch", async () => {
    const preview = await previewBrokerImportForUser(userA.id, csvFile("privacy-check.csv", fixture("gainloss-realized.csv")), null);

    const asOtherUser = await getPendingBrokerImportBatchForUser(userB.id, preview.batchId);
    expect(asOtherUser).toBeNull();

    await expect(confirmBrokerImportForUser(userB.id, preview.batchId)).rejects.toThrow(ValidationError);
    await expect(discardBrokerImportForUser(userB.id, preview.batchId)).rejects.toThrow(ValidationError);

    // Never actually got confirmed by the attempted cross-user call.
    const batch = await prisma.brokerImportBatch.findUniqueOrThrow({ where: { id: preview.batchId } });
    expect(batch.status).toBe("PENDING_PREVIEW");

    await discardBrokerImportForUser(userA.id, preview.batchId);
  });

  it("User B cannot see User A's persisted broker records", async () => {
    const preview = await previewBrokerImportForUser(
      userA.id,
      csvFile("records-privacy.csv", fixture("transactions.csv").replace(/08\/2[48]\/2026/g, "01/02/2026")),
      null,
    );
    await confirmBrokerImportForUser(userA.id, preview.batchId);

    const userBRecords = await prisma.brokerRecord.count({ where: { userId: userB.id } });
    expect(userBRecords).toBe(0);
    const userARecords = await prisma.brokerRecord.count({ where: { userId: userA.id } });
    expect(userARecords).toBeGreaterThan(0);
  });
});
