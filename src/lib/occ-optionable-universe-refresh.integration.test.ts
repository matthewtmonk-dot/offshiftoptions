import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

vi.mock("@/providers/occ/directory-of-listed-products", async () => {
  const actual = await vi.importActual<typeof import("@/providers/occ/directory-of-listed-products")>(
    "@/providers/occ/directory-of-listed-products",
  );
  return { ...actual, fetchOccOptionableSymbols: vi.fn() };
});

maybeDescribe("OCC optionable universe refresh - never real OCC data, fetch mocked", () => {
  let prisma: typeof import("./prisma").prisma;
  let refreshOccOptionableUniverse: typeof import("./occ-optionable-universe-refresh").refreshOccOptionableUniverse;
  let OCC_OPTIONABLE_UNIVERSE_SOURCE: typeof import("./occ-optionable-universe-refresh").OCC_OPTIONABLE_UNIVERSE_SOURCE;
  let fetchOccOptionableSymbols: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ refreshOccOptionableUniverse, OCC_OPTIONABLE_UNIVERSE_SOURCE } = await import("./occ-optionable-universe-refresh"));
    ({ fetchOccOptionableSymbols } = (await import("@/providers/occ/directory-of-listed-products")) as unknown as {
      fetchOccOptionableSymbols: ReturnType<typeof vi.fn>;
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: OCC_OPTIONABLE_UNIVERSE_SOURCE } });
  });

  it("a successful OCC fetch refreshes the shared cache under source OCC and reports raw/excluded row counts", async () => {
    const symbols = Array.from({ length: 1200 }, (_, i) => ({ ticker: `SYM${i}`, name: `Company ${i}` }));
    fetchOccOptionableSymbols.mockResolvedValue({ outcome: "SUCCESS", symbols, rawRowCount: 1250, excludedRowCount: 50 });

    const result = await refreshOccOptionableUniverse();
    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.source).toBe("OCC");
    expect(result.upsertedCount).toBe(1200);
    expect(result.rawRowCount).toBe(1250);
    expect(result.excludedRowCount).toBe(50);
  });

  it("a suspiciously small OCC fetch (below the real ~6,000-row universe) is rejected without touching the existing cache", async () => {
    fetchOccOptionableSymbols.mockResolvedValueOnce({
      outcome: "SUCCESS",
      symbols: Array.from({ length: 1200 }, (_, i) => ({ ticker: `SYM${i}`, name: `Company ${i}` })),
      rawRowCount: 1300,
      excludedRowCount: 100,
    });
    await refreshOccOptionableUniverse();

    fetchOccOptionableSymbols.mockResolvedValueOnce({ outcome: "SUCCESS", symbols: [{ ticker: "ONLYONE", name: "Too small" }] });
    const result = await refreshOccOptionableUniverse();
    expect(result.status).toBe("COUNT_TOO_LOW");

    const rows = await prisma.optionableUniverseSymbol.findMany({ where: { source: OCC_OPTIONABLE_UNIVERSE_SOURCE } });
    expect(rows).toHaveLength(1200); // untouched
  });

  it("an HTTP_ERROR from OCC leaves the existing cache untouched", async () => {
    fetchOccOptionableSymbols.mockResolvedValueOnce({
      outcome: "SUCCESS",
      symbols: Array.from({ length: 1200 }, (_, i) => ({ ticker: `SYM${i}`, name: `Company ${i}` })),
      rawRowCount: 1300,
      excludedRowCount: 100,
    });
    await refreshOccOptionableUniverse();

    fetchOccOptionableSymbols.mockResolvedValueOnce({ outcome: "HTTP_ERROR", status: 503, message: "OCC returned HTTP 503." });
    const result = await refreshOccOptionableUniverse();
    expect(result.status).toBe("EMPTY");

    const rows = await prisma.optionableUniverseSymbol.findMany({ where: { source: OCC_OPTIONABLE_UNIVERSE_SOURCE } });
    expect(rows).toHaveLength(1200); // untouched
  });
});
