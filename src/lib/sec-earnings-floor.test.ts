import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { ticker: string; cik?: string | null; form: string | null; periodEnd: Date | null; filedAt: Date | null; fetchedAt: Date };

const mocks = vi.hoisted(() => ({
  db: { secReportedPeriod: { findMany: vi.fn(), upsert: vi.fn() } },
  cikFor: vi.fn(),
  secFetchJson: vi.fn(),
  secUserAgent: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: mocks.db }));
vi.mock("./company-quality", () => ({
  cikFor: mocks.cikFor,
  secFetchJson: mocks.secFetchJson,
  secUserAgent: mocks.secUserAgent,
  normalizeQualityTicker: (raw: string) => (/^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(raw.trim()) ? raw.trim().toUpperCase() : null),
}));

const { ensureEarningsFloors, getEarningsFloorLookup } = await import("./sec-earnings-floor");

const NOW = new Date("2026-11-16T16:30:00Z");
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const stored = (ticker: string, periodEnd: string | null, fetchedAt = NOW): Row => ({
  ticker,
  form: periodEnd ? "10-Q" : null,
  periodEnd: periodEnd ? d(periodEnd) : null,
  filedAt: periodEnd ? new Date(d(periodEnd).getTime() + 35 * 86_400_000) : null,
  fetchedAt,
});
const submissions = (periodEnd: string, filed: string) => ({ ok: true, json: { filings: { recent: { form: ["8-K", "10-Q"], filingDate: [filed, filed], reportDate: [filed, periodEnd] } } } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.secReportedPeriod.findMany.mockResolvedValue([]);
  mocks.db.secReportedPeriod.upsert.mockResolvedValue({});
  mocks.secUserAgent.mockReturnValue("OffShiftOptions research someone@example.com");
  mocks.cikFor.mockResolvedValue("0000000123");
});
afterEach(() => vi.restoreAllMocks());

describe("getEarningsFloorLookup (stored floors only)", () => {
  it("returns a floor only while it is still in the future, and never contacts the SEC", async () => {
    mocks.db.secReportedPeriod.findMany.mockResolvedValue([stored("ENPH", "2026-09-30"), stored("OLD", "2026-06-30"), stored("YPF", null)]);
    const floors = await getEarningsFloorLookup(["enph", "OLD", "YPF"], NOW);
    expect([...floors.keys()]).toEqual(["ENPH"]);
    expect(floors.get("ENPH")?.notBefore).toBe("2026-12-23");
    expect(mocks.secFetchJson).not.toHaveBeenCalled();
    expect(mocks.cikFor).not.toHaveBeenCalled();
  });

  it("reports no floors (rather than failing the scan) when the table is not set up", async () => {
    mocks.db.secReportedPeriod.findMany.mockRejectedValue(Object.assign(new Error("table does not exist"), { code: "P2021" }));
    expect((await getEarningsFloorLookup(["ENPH"], NOW)).size).toBe(0);
  });
});

describe("ensureEarningsFloors", () => {
  it("asks the SEC about a ticker with nothing stored, saves the period, and returns its floor", async () => {
    mocks.secFetchJson.mockResolvedValue(submissions("2026-09-30", "2026-11-06"));
    const floors = await ensureEarningsFloors(["SMCI"], NOW);
    expect(mocks.secFetchJson).toHaveBeenCalledWith("https://data.sec.gov/submissions/CIK0000000123.json", expect.any(String));
    expect(mocks.db.secReportedPeriod.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ticker: "SMCI" }, create: expect.objectContaining({ form: "10-Q", periodEnd: d("2026-09-30"), filedAt: d("2026-11-06") }) }),
    );
    expect(floors.get("SMCI")?.notBefore).toBe("2026-12-23");
  });

  it("does not ask again while a stored floor is still in the future", async () => {
    mocks.db.secReportedPeriod.findMany.mockResolvedValue([stored("ENPH", "2026-09-30", new Date("2026-11-01T00:00:00Z"))]);
    const floors = await ensureEarningsFloors(["ENPH"], NOW);
    expect(mocks.secFetchJson).not.toHaveBeenCalled();
    expect(floors.has("ENPH")).toBe(true);
  });

  it("re-checks a passed floor after a day, and a no-report ticker only after a week", async () => {
    mocks.db.secReportedPeriod.findMany.mockResolvedValue([
      stored("PASSED", "2026-06-30", new Date("2026-11-15T10:00:00Z")), // 30h old -> due
      stored("FRESH", "2026-06-30", new Date("2026-11-16T10:00:00Z")), // 6h old -> not due
      stored("FOREIGN", null, new Date("2026-11-13T00:00:00Z")), // 3 days old -> not due
      stored("FOREIGNOLD", null, new Date("2026-11-01T00:00:00Z")), // 15 days old -> due
    ]);
    mocks.secFetchJson.mockResolvedValue(submissions("2026-09-30", "2026-11-06"));
    await ensureEarningsFloors(["PASSED", "FRESH", "FOREIGN", "FOREIGNOLD"], NOW);
    expect(mocks.cikFor.mock.calls.map((call) => call[0])).toEqual(["PASSED", "FOREIGNOLD"]);
  });

  it("records 'no report' for a ticker the SEC does not know or that has no 10-Q/10-K, so it is not asked every time", async () => {
    mocks.cikFor.mockResolvedValueOnce(null);
    mocks.secFetchJson.mockResolvedValue({ ok: true, json: { filings: { recent: { form: ["6-K"], filingDate: ["2026-11-10"], reportDate: ["2026-09-30"] } } } });
    const floors = await ensureEarningsFloors(["FUND", "YPF"], NOW);
    expect(floors.size).toBe(0);
    expect(mocks.db.secReportedPeriod.upsert).toHaveBeenCalledTimes(2);
    for (const call of mocks.db.secReportedPeriod.upsert.mock.calls) expect(call[0].create).toMatchObject({ form: null, periodEnd: null, filedAt: null });
  });

  it("writes nothing when an SEC request fails, and carries on with the next ticker", async () => {
    mocks.secFetchJson.mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce(submissions("2026-09-30", "2026-11-06"));
    const floors = await ensureEarningsFloors(["AAA", "BBB"], NOW);
    expect(mocks.db.secReportedPeriod.upsert).toHaveBeenCalledTimes(1);
    expect([...floors.keys()]).toEqual(["BBB"]);
  });

  it("stops when the SEC is unreachable, when the contact setting is missing, or when the database is not set up - never throws", async () => {
    mocks.cikFor.mockResolvedValue("UNAVAILABLE");
    expect((await ensureEarningsFloors(["AAA", "BBB"], NOW)).size).toBe(0);
    expect(mocks.cikFor).toHaveBeenCalledTimes(1);

    mocks.secUserAgent.mockReturnValue(null);
    mocks.db.secReportedPeriod.findMany.mockResolvedValue([stored("ENPH", "2026-09-30")]);
    expect([...(await ensureEarningsFloors(["ENPH", "NEW"], NOW)).keys()]).toEqual(["ENPH"]);
    expect(mocks.secFetchJson).not.toHaveBeenCalled();

    mocks.db.secReportedPeriod.findMany.mockRejectedValue(new Error("relation does not exist"));
    expect((await ensureEarningsFloors(["ENPH"], NOW)).size).toBe(0);
  });

  it("keeps what it has when saving fails part-way", async () => {
    mocks.secFetchJson.mockResolvedValue(submissions("2026-09-30", "2026-11-06"));
    mocks.db.secReportedPeriod.upsert.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("db down"));
    const floors = await ensureEarningsFloors(["AAA", "BBB", "CCC"], NOW);
    expect([...floors.keys()]).toEqual(["AAA"]);
  });

  it("limits how many SEC lookups one call makes", async () => {
    mocks.secFetchJson.mockResolvedValue(submissions("2026-09-30", "2026-11-06"));
    const many = Array.from({ length: 30 }, (_, index) => `T${String.fromCharCode(65 + (index % 26))}${index}`);
    await ensureEarningsFloors(many, NOW);
    expect(mocks.cikFor).toHaveBeenCalledTimes(20);
  });
});
