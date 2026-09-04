import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash } from "bcryptjs";
import { AuthorizationError } from "./privacy";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Research (Watchlist->Research) privacy, isolation, and personal-rule fields", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Research User A", email: `research-a-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Research User B", email: `research-b-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.watchlistItem.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.watchlist.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("creates a new research item PRIVATE by default with no legacy 'watchlist' visibility leak", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZA", "WATCH");
    expect(item.visibility).toBe("PRIVATE");
    expect(item.researchStatus).toBe("WATCH");
  });

  it("does not let User B read User A's private research item", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZB", "LIKE");
    await expect(workflows.getReadableWatchlistItemForUser(userB.id, item.id)).rejects.toThrow(AuthorizationError);
    // Reading your own item always works regardless of visibility.
    await expect(workflows.getReadableWatchlistItemForUser(userA.id, item.id)).resolves.toMatchObject({ id: item.id });
  });

  it("does not let User B mutate (status, details, or removal) User A's research item", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZC", "WATCH");

    const formData = new FormData();
    formData.set("companyName", "Should not apply");
    await expect(workflows.updateResearchDetailsForUser(userB.id, item.id, formData)).rejects.toThrow(AuthorizationError);
    await expect(workflows.toggleWatchlistItemVisibilityForUser(userB.id, item.id)).rejects.toThrow(AuthorizationError);

    const untouched = await prisma.watchlistItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(untouched.companyName).toBeNull();

    await expect(workflows.removeWatchlistItemForUser(userB.id, item.id)).rejects.toThrow(AuthorizationError);
    await expect(prisma.watchlistItem.findUnique({ where: { id: item.id } })).resolves.not.toBeNull();
  });

  it("lets User B LIKE a ticker that User A has marked NEVER_TRADE, with zero interference", async () => {
    await workflows.setResearchStatusForUser(userA.id, "ZZZD", "NEVER_TRADE");
    const bItem = await workflows.setResearchStatusForUser(userB.id, "ZZZD", "LIKE");

    expect(bItem.researchStatus).toBe("LIKE");
    const aItem = await prisma.watchlistItem.findFirst({ where: { ownerId: userA.id, ticker: "ZZZD" } });
    expect(aItem?.researchStatus).toBe("NEVER_TRADE");
  });

  it("preserves disagreement instead of merging - both users' own view of the same ticker stay independent", async () => {
    await workflows.setResearchStatusForUser(userA.id, "ZZZE", "LIKE");
    await workflows.setResearchStatusForUser(userB.id, "ZZZE", "NEVER_TRADE");

    const rows = await prisma.watchlistItem.findMany({ where: { ticker: "ZZZE", ownerId: { in: userIds } } });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.ownerId === userA.id)?.researchStatus).toBe("LIKE");
    expect(rows.find((row) => row.ownerId === userB.id)?.researchStatus).toBe("NEVER_TRADE");
  });

  it("an exclusion can be undone (status change), never a hard delete of the research history", async () => {
    const excluded = await workflows.setResearchStatusForUser(userA.id, "ZZZF", "NEVER_TRADE");
    const restored = await workflows.setResearchStatusForUser(userA.id, "ZZZF", "NEUTRAL");
    expect(restored.id).toBe(excluded.id);
    expect(restored.researchStatus).toBe("NEUTRAL");
  });

  it("persists would-own/monthly-only/roll-friendliness/manual grade fields exactly as entered", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZG", "LIKE");
    const formData = new FormData();
    formData.set("companyName", "Zzz Corp");
    formData.set("whatItDoes", "Makes widgets.");
    formData.set("wouldOwn", "CONDITIONAL");
    formData.set("wouldOwnMaxPrice", "42.50");
    formData.set("monthlyPutsOnly", "on");
    formData.set("rollFriendliness", "DIFFICULT");
    formData.set("rollFriendlinessNote", "Wide spreads on rolls.");
    formData.set("manualSchwabGrade", "B");
    formData.set("manualLsegRating", "Buy");
    formData.set("manualLsegScore", "7.2");
    formData.set("manualLsegTarget", "50");

    const updated = await workflows.updateResearchDetailsForUser(userA.id, item.id, formData);
    expect(updated).toMatchObject({
      companyName: "Zzz Corp",
      whatItDoes: "Makes widgets.",
      wouldOwn: "CONDITIONAL",
      monthlyPutsOnly: true,
      rollFriendliness: "DIFFICULT",
      rollFriendlinessNote: "Wide spreads on rolls.",
      manualSchwabGrade: "B",
      manualLsegRating: "Buy",
      manualLsegScore: "7.2",
      manualLsegTarget: "50",
    });
    expect(Number(updated?.wouldOwnMaxPrice)).toBe(42.5);
  });

  it("clears wouldOwnMaxPrice when wouldOwn is not CONDITIONAL, rather than leaving a stale price", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZH", "LIKE");
    const first = new FormData();
    first.set("wouldOwn", "CONDITIONAL");
    first.set("wouldOwnMaxPrice", "20");
    await workflows.updateResearchDetailsForUser(userA.id, item.id, first);

    const second = new FormData();
    second.set("wouldOwn", "YES");
    const updated = await workflows.updateResearchDetailsForUser(userA.id, item.id, second);
    expect(updated?.wouldOwnMaxPrice).toBeNull();
  });

  it("a quick status change never wipes previously-saved research details", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZI", "LIKE");
    const formData = new FormData();
    formData.set("companyName", "Should survive");
    await workflows.updateResearchDetailsForUser(userA.id, item.id, formData);

    const restatused = await workflows.setResearchStatusForUser(userA.id, "ZZZI", "AVOID");
    expect(restatused.researchStatus).toBe("AVOID");
    expect(restatused.companyName).toBe("Should survive");
  });

  it("includes LIKE/WATCH/NEUTRAL research tickers in the scanner universe union, but excludes AVOID/NEVER_TRADE", async () => {
    await workflows.setResearchStatusForUser(userA.id, "ZZZLIKE", "LIKE");
    await workflows.setResearchStatusForUser(userA.id, "ZZZWATCH", "WATCH");
    await workflows.setResearchStatusForUser(userA.id, "ZZZNEUTRAL", "NEUTRAL");
    await workflows.setResearchStatusForUser(userA.id, "ZZZAVOID", "AVOID");
    await workflows.setResearchStatusForUser(userA.id, "ZZZNEVER", "NEVER_TRADE");

    const universe = await workflows.getResearchUniverseTickersForUser(userA.id);
    expect(universe).toEqual(expect.arrayContaining(["ZZZLIKE", "ZZZWATCH", "ZZZNEUTRAL"]));
    expect(universe).not.toContain("ZZZAVOID");
    expect(universe).not.toContain("ZZZNEVER");
  });

  it("rejects an invalid research status rather than silently accepting it", async () => {
    await expect(workflows.setResearchStatusForUser(userA.id, "ZZZJ", "BOGUS")).rejects.toThrow("Invalid research status");
  });

  it("persists the new fundamental/external-research/profitability/dividend fields exactly as entered, with blank staying null (not 0)", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZK", "LIKE");
    const formData = new FormData();
    formData.set("manualPeRatio", "18.5");
    formData.set("manualPegRatio", "-1.2");
    formData.set("manualDebtToEquity", "0.42");
    formData.set("manualCurrentRatio", "1.8");
    formData.set("manualLsegRecommendation", "BUY");
    formData.set("profitability", "PROFITABLE");
    formData.set("profitabilityNote", "Profitable 4 of last 5 years");
    formData.set("paysDividend", "YES");
    formData.set("manualDividendYield", "2.1");
    formData.set("manualDividendAmount", "0.88");
    // manualCurrentRatio's counterpart (current ratio auto column) intentionally left blank.

    const updated = await workflows.updateResearchDetailsForUser(userA.id, item.id, formData);
    expect(updated).toMatchObject({
      manualLsegRecommendation: "BUY",
      profitability: "PROFITABLE",
      profitabilityNote: "Profitable 4 of last 5 years",
      paysDividend: true,
    });
    expect(Number(updated?.manualPeRatio)).toBe(18.5);
    expect(Number(updated?.manualPegRatio)).toBe(-1.2);
    expect(Number(updated?.manualDebtToEquity)).toBe(0.42);
    expect(Number(updated?.manualCurrentRatio)).toBe(1.8);
    expect(Number(updated?.manualDividendYield)).toBe(2.1);
    expect(Number(updated?.manualDividendAmount)).toBe(0.88);
    // Never auto-populated by this manual-only path - stays reserved for a future verified source.
    expect(updated?.fundamentalPeRatio).toBeNull();
  });

  it("persists a blank manual numeric field as null, never as 0", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZL", "LIKE");
    const formData = new FormData();
    formData.set("manualPeRatio", "");
    formData.set("manualDebtToEquity", "");

    const updated = await workflows.updateResearchDetailsForUser(userA.id, item.id, formData);
    expect(updated?.manualPeRatio).toBeNull();
    expect(updated?.manualDebtToEquity).toBeNull();
  });

  it("treats an absent paysDividend selection as unknown (null), not false", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZM", "LIKE");
    const updated = await workflows.updateResearchDetailsForUser(userA.id, item.id, new FormData());
    expect(updated?.paysDividend).toBeNull();
  });

  it("rejects an invalid LSEG recommendation / profitability value rather than silently accepting it", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZN", "LIKE");
    const formData = new FormData();
    formData.set("manualLsegRecommendation", "STRONG_BUY_NOT_REAL");
    formData.set("profitability", "SUPER_PROFITABLE_NOT_REAL");

    const updated = await workflows.updateResearchDetailsForUser(userA.id, item.id, formData);
    expect(updated?.manualLsegRecommendation).toBe("UNKNOWN");
    expect(updated?.profitability).toBe("UNKNOWN");
  });
});

const runColumnPreferenceTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribeColumns = runColumnPreferenceTests ? describe : describe.skip;

maybeDescribeColumns("Per-user Research column/sort preferences", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Columns User A", email: `columns-a-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Columns User B", email: `columns-b-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.userSettings.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("saves a user's column order and sort key, sanitizing out unknown keys", async () => {
    const result = await workflows.updateResearchColumnsForUser(userA.id, ["company", "bogusColumn", "peRatio"], "ticker");
    expect(result).toEqual({ columns: ["company", "peRatio"], sortKey: "ticker" });

    const saved = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    expect(saved.researchColumns).toEqual(["company", "peRatio"]);
    expect(saved.researchSortKey).toBe("ticker");
  });

  it("one user's column change never touches another user's saved preference", async () => {
    await workflows.updateResearchColumnsForUser(userA.id, ["company"], "added");
    await workflows.updateResearchColumnsForUser(userB.id, ["wouldOwn", "notes"], "price");

    const savedA = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    const savedB = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userB.id } });
    expect(savedA.researchColumns).toEqual(["company"]);
    expect(savedB.researchColumns).toEqual(["wouldOwn", "notes"]);
    expect(savedA.researchSortKey).toBe("added");
    expect(savedB.researchSortKey).toBe("price");
  });

  it("rejects an invalid sort key rather than persisting it", async () => {
    const result = await workflows.updateResearchColumnsForUser(userA.id, ["company"], "not-a-real-sort-key");
    expect(result.sortKey).toBeNull();
  });
});

const runFundamentalsSyncTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribeFundamentalsSync = runFundamentalsSyncTests ? describe : describe.skip;

maybeDescribeFundamentalsSync("syncVerifiedFundamentalsForUser - verified Schwab fundamentals persistence", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Fundamentals Sync User A", email: `fundamentals-sync-a-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Fundamentals Sync User B", email: `fundamentals-sync-b-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.watchlistItem.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.watchlist.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  function fakeSummary() {
    return { status: "UNKNOWN" as const, passed: 0, total: 0, results: [] };
  }

  it("persists real negative P/E, real negative EPS, and real 0 dividend fields exactly - never dropped, never coerced to null/blank", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZFUNDA", "WATCH");

    await workflows.syncVerifiedFundamentalsForUser(userA.id, [
      {
        ticker: "ZFUNDA",
        values: {},
        summary: fakeSummary(),
        verifiedFundamentals: { peRatio: -27.50359, eps: -0.9057, dividendAmount: 0, dividendYield: 0, dividendFrequency: 0 },
      },
    ]);

    const updated = await prisma.watchlistItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(updated.fundamentalPeRatio)).toBeCloseTo(-27.5, 1);
    expect(Number(updated.fundamentalEps)).toBeCloseTo(-0.9057, 4);
    expect(Number(updated.fundamentalDividendAmount)).toBe(0);
    expect(Number(updated.fundamentalDividendYield)).toBe(0);
    expect(updated.fundamentalSource).toBe("Schwab Trader API");
    expect(updated.fundamentalAsOf).not.toBeNull();
  });

  it("never overwrites a previously-captured real value with a later ABSENT/null fetch", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZFUNDB", "WATCH");
    await workflows.syncVerifiedFundamentalsForUser(userA.id, [
      { ticker: "ZFUNDB", values: {}, summary: fakeSummary(), verifiedFundamentals: { peRatio: 18.4, eps: 0.5, dividendAmount: null, dividendYield: null, dividendFrequency: null } },
    ]);

    // A later scan where Schwab happened to return nothing usable for this ticker (e.g. a
    // transient issue) must not blank out the good value captured above.
    await workflows.syncVerifiedFundamentalsForUser(userA.id, [
      { ticker: "ZFUNDB", values: {}, summary: fakeSummary(), verifiedFundamentals: { peRatio: null, eps: null, dividendAmount: null, dividendYield: null, dividendFrequency: null } },
    ]);

    const updated = await prisma.watchlistItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(updated.fundamentalPeRatio)).toBeCloseTo(18.4, 1);
    expect(Number(updated.fundamentalEps)).toBeCloseTo(0.5, 1);
  });

  it("only ever writes to the calling user's own existing Research rows - never creates a row, never touches another user's", async () => {
    // User B has no ZFUNDC research item at all - the ticker merely appearing in a scan
    // must never create one, and must never touch User A's item for a different ticker.
    const userAItem = await workflows.setResearchStatusForUser(userA.id, "ZFUNDC", "WATCH");
    const userBItem = await workflows.setResearchStatusForUser(userB.id, "ZFUNDD", "WATCH");

    await workflows.syncVerifiedFundamentalsForUser(userB.id, [
      { ticker: "ZFUNDC", values: {}, summary: fakeSummary(), verifiedFundamentals: { peRatio: 99, eps: 99, dividendAmount: 99, dividendYield: 99, dividendFrequency: 99 } },
    ]);

    const userAItemAfter = await prisma.watchlistItem.findUniqueOrThrow({ where: { id: userAItem.id } });
    expect(userAItemAfter.fundamentalPeRatio).toBeNull();

    const userBItemAfter = await prisma.watchlistItem.findUniqueOrThrow({ where: { id: userBItem.id } });
    expect(userBItemAfter.fundamentalPeRatio).toBeNull();

    const noNewRow = await prisma.watchlistItem.findFirst({ where: { ownerId: userB.id, ticker: "ZFUNDC" } });
    expect(noNewRow).toBeNull();
  });

  it("does nothing when a ticker has no verified fundamentals at all (e.g. a demo-scan candidate)", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZFUNDE", "WATCH");

    await workflows.syncVerifiedFundamentalsForUser(userA.id, [
      { ticker: "ZFUNDE", values: {}, summary: fakeSummary(), verifiedFundamentals: null },
    ]);

    const unchanged = await prisma.watchlistItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.fundamentalPeRatio).toBeNull();
    expect(unchanged.fundamentalSource).toBeNull();
  });
});
