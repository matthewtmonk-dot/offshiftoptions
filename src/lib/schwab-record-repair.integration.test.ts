import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Schwab malformed-record repair - narrow, dry-run-first, token-locked, never touches linked/CSV/other-user rows", () => {
  let prisma: typeof import("./prisma").prisma;
  let previewMalformedSchwabTransactionRepairForUser: typeof import("./schwab-record-repair").previewMalformedSchwabTransactionRepairForUser;
  let repairMalformedSchwabTransactionRecordsForUser: typeof import("./schwab-record-repair").repairMalformedSchwabTransactionRecordsForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];
  let fingerprintCounter = 0;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ previewMalformedSchwabTransactionRepairForUser, repairMalformedSchwabTransactionRecordsForUser } = await import(
      "./schwab-record-repair"
    ));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({ data: { name: "Repair User A", email: `repair-a-${timestamp}@lst.local`, passwordHash } });
    userB = await prisma.user.create({ data: { name: "Repair User B", email: `repair-b-${timestamp}@lst.local`, passwordHash } });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.campaign.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.tradingAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createLinkableCampaign(userId: string) {
    const account = await prisma.tradingAccount.create({
      data: { userId, name: "Repair Test Account", brokerName: "Schwab", accountType: "Brokerage", source: "SCHWAB", visibility: "PRIVATE" },
    });
    return prisma.campaign.create({
      data: { ownerId: userId, accountId: account.id, ticker: "TEST", strategy: "CASH_SECURED_PUT", status: "OPEN", visibility: "PRIVATE", openedAt: new Date() },
    });
  }

  async function createRecord(
    userId: string,
    overrides: Partial<{
      symbol: string | null;
      action: string | null;
      status: "CONFIRMED" | "CONFLICT" | "NEEDS_REVIEW";
      linkedCampaignId: string | null;
      sources: ("SCHWAB_API" | "SCHWAB_TRANSACTIONS_CSV")[];
    }> = {},
  ) {
    fingerprintCounter += 1;
    return prisma.brokerRecord.create({
      data: {
        userId,
        provider: "SCHWAB",
        kind: "TRANSACTION",
        status: overrides.status ?? "NEEDS_REVIEW",
        linkedCampaignId: overrides.linkedCampaignId ?? null,
        fingerprint: `repair-test-fp-${userId}-${fingerprintCounter}`,
        identityKey: `repair-test-id-${userId}-${fingerprintCounter}`,
        symbol: overrides.symbol === undefined ? "CURRENCY_USD" : overrides.symbol,
        action: overrides.action === undefined ? null : overrides.action,
        sources: overrides.sources ?? ["SCHWAB_API"],
        metadata: {},
      },
    });
  }

  it("dry-run finds only the malformed, unlinked, SCHWAB_API-sourced rows with a null action, categorizes them, and returns a match token", async () => {
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    await createRecord(userA.id, { symbol: "RIOT 260904P00017500" }); // expiration-removal-shaped, correct symbol, still null action

    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id);

    expect(preview.totalMatched).toBe(3);
    expect(preview.countsByCategory).toEqual({ CASH_LEG_MISIDENTIFIED: 2, UNRECOGNIZED_ACTIVITY: 1 });
    expect(preview.safetyCapExceeded).toBe(false);
    expect(preview.matchToken).toMatch(/^[0-9a-f]{64}$/); // sha256 hex - never raw ids

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("never matches a row with a real action - only the exact null-action malformed signature", async () => {
    await createRecord(userA.id, { symbol: "APLD 260904P00023500", action: "Sell to Open" });

    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    expect(preview.totalMatched).toBe(0);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("never matches a linked record, regardless of status or action", async () => {
    const campaign = await createLinkableCampaign(userA.id);
    await createRecord(userA.id, { linkedCampaignId: campaign.id });

    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    expect(preview.totalMatched).toBe(0);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("never matches a CONFIRMED-status record", async () => {
    await createRecord(userA.id, { status: "CONFIRMED" });

    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    expect(preview.totalMatched).toBe(0);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("never matches a CSV-imported record, even with the same malformed shape", async () => {
    await createRecord(userA.id, { sources: ["SCHWAB_TRANSACTIONS_CSV"] });

    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    expect(preview.totalMatched).toBe(0);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("repair with a valid, current match token deletes exactly the previewed rows and nothing else - leaves linked, confirmed, CSV, and other-user rows untouched", async () => {
    const campaign = await createLinkableCampaign(userA.id);
    const malformed1 = await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    const malformed2 = await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    const linked = await createRecord(userA.id, { linkedCampaignId: campaign.id });
    const confirmed = await createRecord(userA.id, { status: "CONFIRMED", action: "Sell to Open" });
    const csvImported = await createRecord(userA.id, { sources: ["SCHWAB_TRANSACTIONS_CSV"] });
    const otherUsersMalformedRow = await createRecord(userB.id, { symbol: "CURRENCY_USD" });

    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    expect(preview.totalMatched).toBe(2);

    const result = await repairMalformedSchwabTransactionRecordsForUser(userA.id, preview.matchToken);
    expect(result.deletedCount).toBe(2);

    const remaining = await prisma.brokerRecord.findMany({ where: { id: { in: [malformed1.id, malformed2.id, linked.id, confirmed.id, csvImported.id, otherUsersMalformedRow.id] } } });
    const remainingIds = new Set(remaining.map((row) => row.id));
    expect(remainingIds.has(malformed1.id)).toBe(false);
    expect(remainingIds.has(malformed2.id)).toBe(false);
    expect(remainingIds.has(linked.id)).toBe(true);
    expect(remainingIds.has(confirmed.id)).toBe(true);
    expect(remainingIds.has(csvImported.id)).toBe(true);
    expect(remainingIds.has(otherUsersMalformedRow.id)).toBe(true);

    await prisma.brokerRecord.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
  });

  it("refuses with a stale/garbage token and deletes nothing", async () => {
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });

    await expect(repairMalformedSchwabTransactionRecordsForUser(userA.id, "not-a-real-token")).rejects.toThrow(/matching set has changed/i);

    const stillThere = await prisma.brokerRecord.count({ where: { userId: userA.id } });
    expect(stillThere).toBe(1);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("refuses a token from an earlier preview once the qualifying set has changed - e.g. a row got linked to a campaign in between", async () => {
    const row1 = await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });

    const staleePreview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    expect(staleePreview.totalMatched).toBe(2);

    // The set changes after the preview was taken - row1 gets linked to a campaign (e.g. a
    // concurrent sync/reconciliation run resolved it) and no longer qualifies.
    const campaign = await createLinkableCampaign(userA.id);
    await prisma.brokerRecord.update({ where: { id: row1.id }, data: { linkedCampaignId: campaign.id } });

    await expect(repairMalformedSchwabTransactionRecordsForUser(userA.id, staleePreview.matchToken)).rejects.toThrow(/matching set has changed/i);

    // Nothing was deleted - not even the row that still qualifies.
    const stillThere = await prisma.brokerRecord.count({ where: { userId: userA.id, linkedCampaignId: null } });
    expect(stillThere).toBe(1);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("refuses a token from an earlier preview once a new row also comes to qualify", async () => {
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });

    const firstPreview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    expect(firstPreview.totalMatched).toBe(1);

    // A second malformed row shows up (e.g. another sync ran) before the confirm click lands.
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });

    await expect(repairMalformedSchwabTransactionRecordsForUser(userA.id, firstPreview.matchToken)).rejects.toThrow(/matching set has changed/i);

    const stillThere = await prisma.brokerRecord.count({ where: { userId: userA.id } });
    expect(stillThere).toBe(2);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("a fresh preview after a refused repair produces a token that then succeeds", async () => {
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    const stalePreview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });

    await expect(repairMalformedSchwabTransactionRecordsForUser(userA.id, stalePreview.matchToken)).rejects.toThrow();

    const freshPreview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    expect(freshPreview.totalMatched).toBe(2);
    const result = await repairMalformedSchwabTransactionRecordsForUser(userA.id, freshPreview.matchToken);
    expect(result.deletedCount).toBe(2);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("never touches another user's malformed rows when repairing this user", async () => {
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    const bRow = await createRecord(userB.id, { symbol: "CURRENCY_USD" });

    await repairMalformedSchwabTransactionRecordsForUser(userA.id, preview.matchToken);

    const stillThere = await prisma.brokerRecord.findUnique({ where: { id: bRow.id } });
    expect(stillThere).not.toBeNull();

    await prisma.brokerRecord.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
  });

  it("refuses to repair when the match count exceeds the safety cap, and deletes nothing, even with a correct token", async () => {
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id, { safetyCap: 1 });
    expect(preview.safetyCapExceeded).toBe(true);

    await expect(repairMalformedSchwabTransactionRecordsForUser(userA.id, preview.matchToken, { safetyCap: 1 })).rejects.toThrow(/safety cap/i);

    const stillThere = await prisma.brokerRecord.count({ where: { userId: userA.id } });
    expect(stillThere).toBe(2);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });

  it("dry-run and repair agree on the exact same count (single shared predicate)", async () => {
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    await createRecord(userA.id, { symbol: "CURRENCY_USD" });
    await createRecord(userA.id, { symbol: "RIOT 260904P00017500" });

    const preview = await previewMalformedSchwabTransactionRepairForUser(userA.id);
    const result = await repairMalformedSchwabTransactionRecordsForUser(userA.id, preview.matchToken);

    expect(result.deletedCount).toBe(preview.totalMatched);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
  });
});
