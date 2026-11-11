import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import { DEFAULT_PLAN_LIMITS } from "@/domain/portfolio/portfolioPlan";

vi.mock("server-only", () => ({}));

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

/**
 * Portfolio limits are stored as the rules of a second per-user ScannerProfile ("Portfolio limits"). These tests prove
 * the round trip, per-user isolation, and - most important - that the scanner's own "My LST" profile and its rules are
 * never touched or confused with it. Uses throwaway users only.
 */
maybeDescribe("portfolio limits store (lib/plan-limits)", () => {
  let prisma: typeof import("./prisma").prisma;
  let store: typeof import("./plan-limits");
  let workflows: typeof import("./workflows");
  let appData: typeof import("./app-data");
  let userId: string;
  let otherUserId: string;

  const full = (overrides: Record<string, unknown> = {}) => ({ ...DEFAULT_PLAN_LIMITS, ...overrides });

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    store = await import("./plan-limits");
    workflows = await import("./workflows");
    appData = await import("./app-data");
    const stamp = Date.now();
    userId = (await prisma.user.create({ data: { name: "Limits Test User", email: `limits-${stamp}@lst.local`, passwordHash: await hash("not-used", 4) }, select: { id: true } })).id;
    otherUserId = (await prisma.user.create({ data: { name: "Limits Other User", email: `limits-other-${stamp}@lst.local`, passwordHash: await hash("not-used", 4) }, select: { id: true } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it("returns the defaults before anything is saved, without creating a row", async () => {
    expect(await store.getPlanLimitsForUser(userId)).toEqual(DEFAULT_PLAN_LIMITS);
    expect(await prisma.scannerProfile.count({ where: { ownerId: userId, name: store.PLAN_LIMITS_PROFILE_NAME } })).toBe(0);
  });

  it("saves and reads back every field, and saving twice updates in place", async () => {
    await store.savePlanLimitsForUser(userId, full({ maxCommittedPct: "65", sizeLimitsFromAccountValue: "0", minReturnPct: 0.8 }));
    const first = await store.getPlanLimitsForUser(userId);
    expect(first).toEqual({ ...DEFAULT_PLAN_LIMITS, maxCommittedPct: 65, sizeLimitsFromAccountValue: 0, minReturnPct: 0.8 });

    await store.savePlanLimitsForUser(userId, full({ maxCommittedPct: 70 }));
    expect((await store.getPlanLimitsForUser(userId)).maxCommittedPct).toBe(70);
    expect((await store.getPlanLimitsForUser(userId)).sizeLimitsFromAccountValue).toBe(DEFAULT_PLAN_LIMITS.sizeLimitsFromAccountValue);
    const profiles = await prisma.scannerProfile.findMany({ where: { ownerId: userId, name: store.PLAN_LIMITS_PROFILE_NAME }, include: { rules: true } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].rules).toHaveLength(Object.keys(DEFAULT_PLAN_LIMITS).length);
  });

  it("is per user: one user's limits never change another's", async () => {
    expect(await store.getPlanLimitsForUser(otherUserId)).toEqual(DEFAULT_PLAN_LIMITS);
  });

  it("rejects out-of-range or non-numeric input and a larger-position limit below the normal one, saving nothing", async () => {
    const before = await store.getPlanLimitsForUser(userId);
    await expect(store.savePlanLimitsForUser(userId, full({ maxCommittedPct: 140 }))).rejects.toThrow(/must be a number from 1 to 100/);
    await expect(store.savePlanLimitsForUser(userId, full({ maxPerTheme: "lots" }))).rejects.toThrow(/must be a number/);
    await expect(store.savePlanLimitsForUser(userId, full({ maxPerCompanyPct: 40, maxLargePositionPct: 30 }))).rejects.toThrow(/cannot be lower/);
    expect(await store.getPlanLimitsForUser(userId)).toEqual(before);
  });

  it("never touches or pollutes the scanner's own profile, and the scanner page still loads only 'My LST'", async () => {
    const scannerProfile = await workflows.ensureMyLstScannerProfileForUser(userId);
    const rulesBefore = await prisma.scannerRule.findMany({ where: { profileId: scannerProfile.id }, orderBy: { key: "asc" } });

    await store.savePlanLimitsForUser(userId, full({ maxCommittedPct: 62 }));

    const rulesAfter = await prisma.scannerRule.findMany({ where: { profileId: scannerProfile.id }, orderBy: { key: "asc" } });
    expect(rulesAfter).toEqual(rulesBefore);
    const limitKeys = new Set(Object.keys(DEFAULT_PLAN_LIMITS));
    expect(rulesAfter.some((rule) => limitKeys.has(rule.key))).toBe(false);

    const page = await appData.getScannerPageData(userId);
    expect(page?.id).toBe(scannerProfile.id);
    expect(page?.rules.some((rule) => limitKeys.has(rule.key))).toBe(false);
    expect((await workflows.ensureMyLstScannerProfileForUser(userId)).id).toBe(scannerProfile.id);
  });
});
