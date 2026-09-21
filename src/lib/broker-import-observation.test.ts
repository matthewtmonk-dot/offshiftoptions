import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSchwabApiPosition } from "@/providers/schwab/csv";

const db = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: { brokerRecord: db } }));
import { persistNormalizedBrokerRecordsForUser } from "./broker-import";

const prior = new Date("2026-09-17T15:00:00Z");
const recent = new Date("2026-09-21T15:00:00Z");
const position = { accountId: "external-account", symbol: "RIOT 261016P00020000", quantity: -1, marketValue: -100 };

beforeEach(() => {
  vi.clearAllMocks();
  db.findMany.mockResolvedValue([{ ...normalizeSchwabApiPosition(position, prior), id: "existing" }]);
  db.updateMany.mockResolvedValue({ count: 1 });
});

describe("position observation refresh", () => {
  it("refreshes a newer unchanged observation without changing financial fields or creating an event", async () => {
    const result = await persistNormalizedBrokerRecordsForUser("owner", "internal-account", [normalizeSchwabApiPosition(position, recent)]);
    expect(db.updateMany).toHaveBeenCalledTimes(1);
    const update = db.updateMany.mock.calls[0][0];
    expect(Object.keys(update.data).sort()).toEqual(["metadata", "observedAt"]);
    expect(update.data.observedAt).toEqual(recent);
    expect(update.data.metadata.valuationAsOf).toBeNull();
    expect(update.where).toMatchObject({ id: "existing", userId: "owner", accountId: "internal-account", kind: "POSITION", quantity: -1, amount: -100 });
    expect(update.where.OR).toContainEqual({ observedAt: { lt: recent } });
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(result.inserted).toBe(0);
  });
  it("older and repeated observations never move freshness backwards", async () => {
    await persistNormalizedBrokerRecordsForUser("owner", "internal-account", [normalizeSchwabApiPosition(position, prior)]);
    expect(db.updateMany).not.toHaveBeenCalled();
  });
  it("verified valuation time remains separate from a newer retrieval time", async () => {
    await persistNormalizedBrokerRecordsForUser("owner", "internal-account", [normalizeSchwabApiPosition({ ...position, valuationAsOf: prior }, recent)]);
    expect(db.updateMany.mock.calls[0][0].data.metadata.valuationAsOf).toBe(prior.toISOString());
  });
  it("clears an older price when a newer snapshot reports an unavailable valuation", async () => {
    await persistNormalizedBrokerRecordsForUser("owner", "internal-account", [normalizeSchwabApiPosition({ ...position, marketValue: null }, recent)]);
    expect(db.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: null, observedAt: recent }) }));
    expect(db.create).not.toHaveBeenCalled();
  });
  it("preserves economic fields but invalidates an equal-time conflicting observation", async () => {
    const result = await persistNormalizedBrokerRecordsForUser("owner", "internal-account", [normalizeSchwabApiPosition({ ...position, marketValue: -200 }, prior)]);
    const update = db.updateMany.mock.calls[0][0];
    expect(Object.keys(update.data)).toEqual(["metadata"]);
    expect(update.data.metadata.observationConflict).toBe(true);
    expect(update.where.observedAt).toEqual(prior);
    expect(result.unresolved).toBe(1);
    expect(db.create).not.toHaveBeenCalled();
  });
  it("does not overwrite a snapshot that became newer during classification", async () => {
    db.updateMany.mockResolvedValue({ count: 0 });
    const result = await persistNormalizedBrokerRecordsForUser("owner", "internal-account", [normalizeSchwabApiPosition({ ...position, marketValue: -200 }, recent)]);
    expect(db.updateMany.mock.calls[0][0].where.OR).toContainEqual({ observedAt: { lt: recent } });
    expect(result.inserted).toBe(0);
    expect(db.update).not.toHaveBeenCalled();
  });
});
