import { afterEach, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

const TEST_SOURCE = "TEST_FIXTURE_OPTIONABLE_UNIVERSE";

maybeDescribe("Optionable universe cache - atomic, failure-safe refresh (never real OCC data)", () => {
  let prisma: typeof import("./prisma").prisma;
  let refreshOptionableUniverseCache: typeof import("./optionable-universe-cache").refreshOptionableUniverseCache;
  let getOptionableUniverseCacheStatus: typeof import("./optionable-universe-cache").getOptionableUniverseCacheStatus;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ refreshOptionableUniverseCache, getOptionableUniverseCacheStatus } = await import("./optionable-universe-cache"));
  });

  afterEach(async () => {
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
  });

  it("a successful refresh upserts symbols and updates lastSeenAt", async () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const result = await refreshOptionableUniverseCache(
      [
        { ticker: "AAA", name: "Alpha Corp" },
        { ticker: "BBB", name: "Beta Corp" },
      ],
      TEST_SOURCE,
      { now },
    );

    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.upsertedCount).toBe(2);

    const rows = await prisma.optionableUniverseSymbol.findMany({ where: { source: TEST_SOURCE }, orderBy: { ticker: "asc" } });
    expect(rows.map((r) => r.ticker)).toEqual(["AAA", "BBB"]);
    expect(rows[0].lastSeenAt.toISOString()).toBe(now.toISOString());
  });

  it("deduplicates a repeated ticker (case-insensitively), keeping one row", async () => {
    const result = await refreshOptionableUniverseCache(
      [
        { ticker: "AAA", name: "Alpha Corp" },
        { ticker: "aaa", name: "Alpha Corp Duplicate" },
      ],
      TEST_SOURCE,
    );

    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.upsertedCount).toBe(1);

    const rows = await prisma.optionableUniverseSymbol.findMany({ where: { source: TEST_SOURCE } });
    expect(rows).toHaveLength(1);
  });

  it("an empty symbol list fails without touching the existing cache", async () => {
    await refreshOptionableUniverseCache([{ ticker: "EXISTING", name: "Existing Corp" }], TEST_SOURCE);

    const result = await refreshOptionableUniverseCache([], TEST_SOURCE);
    expect(result.status).toBe("EMPTY");

    const rows = await prisma.optionableUniverseSymbol.findMany({ where: { source: TEST_SOURCE } });
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe("EXISTING");
  });

  it("a suspiciously low symbol count (below the caller's expected minimum) fails without touching the existing cache - guards against a truncated/malformed fetch", async () => {
    await refreshOptionableUniverseCache(
      Array.from({ length: 10 }, (_, i) => ({ ticker: `OLD${i}`, name: `Old Corp ${i}` })),
      TEST_SOURCE,
    );

    const result = await refreshOptionableUniverseCache([{ ticker: "ONLYONE", name: "Suspiciously small file" }], TEST_SOURCE, {
      minimumExpectedCount: 5,
    });

    expect(result.status).toBe("COUNT_TOO_LOW");
    const rows = await prisma.optionableUniverseSymbol.findMany({ where: { source: TEST_SOURCE } });
    expect(rows).toHaveLength(10); // completely untouched
  });

  it("removes (prunes) symbols no longer present, but ONLY after a successful complete refresh - never on a rejected one", async () => {
    await refreshOptionableUniverseCache(
      [
        { ticker: "STAYS", name: "Still Optionable Corp" },
        { ticker: "DELISTED", name: "No Longer Optionable Corp" },
      ],
      TEST_SOURCE,
    );

    // A rejected refresh (too few symbols) must never prune anything.
    const rejected = await refreshOptionableUniverseCache([{ ticker: "STAYS", name: "Still Optionable Corp" }], TEST_SOURCE, {
      minimumExpectedCount: 2,
    });
    expect(rejected.status).toBe("COUNT_TOO_LOW");
    expect(await prisma.optionableUniverseSymbol.findFirst({ where: { ticker: "DELISTED" } })).not.toBeNull();

    // A genuinely successful refresh that no longer mentions DELISTED removes it.
    const success = await refreshOptionableUniverseCache([{ ticker: "STAYS", name: "Still Optionable Corp" }], TEST_SOURCE);
    expect(success.status).toBe("SUCCESS");
    if (success.status !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(success.removedCount).toBe(1);
    expect(await prisma.optionableUniverseSymbol.findFirst({ where: { ticker: "DELISTED" } })).toBeNull();
    expect(await prisma.optionableUniverseSymbol.findFirst({ where: { ticker: "STAYS" } })).not.toBeNull();
  });

  it("getOptionableUniverseCacheStatus reports the real row count and most recent lastSeenAt per source", async () => {
    const now = new Date("2026-09-06T12:00:00Z");
    await refreshOptionableUniverseCache(
      [
        { ticker: "AAA", name: "Alpha Corp" },
        { ticker: "BBB", name: "Beta Corp" },
      ],
      TEST_SOURCE,
      { now },
    );

    const status = await getOptionableUniverseCacheStatus();
    const sourceStatus = status.lastSuccessfulRefreshBySource.get(TEST_SOURCE);
    expect(sourceStatus?.symbolCount).toBe(2);
    expect(sourceStatus?.lastSeenAt.toISOString()).toBe(now.toISOString());
  });
});
