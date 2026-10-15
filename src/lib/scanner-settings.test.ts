import { beforeEach, describe, expect, it, vi } from "vitest";

// Ticket 7: saving/resetting Scanner settings must never run a scan (demo or live), must persist
// atomically (all rules or none), and must never leak across owners. Since 2026-10-15 the rule set is
// written as deleteMany + createMany + profile touch (3 statements, replaceScannerRules in
// workflows.ts) instead of 15 sequential upserts - which approached the interactive-transaction time
// limit over the remote production database - so these tests assert that shape. Mocked Prisma lets this run
// without a real database - see valuation-query-boundaries.test.ts for the same pattern.
const db = vi.hoisted(() => ({
  scannerProfile: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  scannerRule: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
  scanRun: { create: vi.fn(), findFirst: vi.fn() },
  scanResult: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: db }));

import { SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { rerunDemoScannerForUser, resetScannerSettingsToLstCoreForUser, updateScannerSettingsForUser } from "./workflows";

function mattProfile(overrides: Partial<{ updatedAt: Date }> = {}) {
  return { id: "profile-matt", ownerId: "matt", name: "My LST", updatedAt: new Date("2026-09-21T14:00:00Z"), ...overrides };
}
function ericProfile() {
  return { id: "profile-eric", ownerId: "eric", name: "My LST", updatedAt: new Date("2026-09-21T14:00:00Z") };
}

/** Mirrors the real settings form exactly - every definition gets a valid field for its input
 * kind, matching the shape the actual /scanner/settings page submits. */
function buildValidScannerFormData(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  for (const definition of SCANNER_RULE_DEFINITIONS) {
    formData.set(`${definition.key}:enabled`, "on");
    if (Array.isArray(definition.defaultDesired)) {
      const [min, max] = definition.defaultDesired;
      formData.set(`${definition.key}:min`, String(min));
      formData.set(`${definition.key}:max`, String(max));
    } else if (definition.input.kind === "single") {
      formData.set(`${definition.key}:value`, String(definition.defaultDesired));
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    formData.set(key, value);
  }
  return formData;
}

/** Every profile id any rule delete/create in the current test touched. */
function ruleWriteProfileIds(): Set<string> {
  const ids = new Set<string>();
  for (const [args] of db.scannerRule.deleteMany.mock.calls) ids.add((args.where as { profileId: string }).profileId);
  for (const [args] of db.scannerRule.createMany.mock.calls) for (const row of args.data as Array<{ profileId: string }>) ids.add(row.profileId);
  return ids;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The real prisma.$transaction(async (tx) => {...}) runs its callback inside a single DB
  // transaction; the mock stands in for `tx` with the same `db` object so calls made via `tx.*`
  // are observable on the same mocks as a direct `prisma.*` call would be.
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) => callback(db));
});

describe("updateScannerSettingsForUser (Ticket 7: settings save must not run a scan)", () => {
  it("1. saves valid settings while the latest result is LIVE: rules persist, no scan of any kind runs", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    await updateScannerSettingsForUser("matt", buildValidScannerFormData({ "price:min": "12", "price:max": "60" }));

    expect(db.scannerRule.createMany).toHaveBeenCalledTimes(1);
    const created = db.scannerRule.createMany.mock.calls[0][0].data as Array<{ key: string; profileId: string; valueJson: unknown; enabled: boolean }>;
    expect(created).toHaveLength(SCANNER_RULE_DEFINITIONS.length);
    expect(new Set(created.map((rule) => rule.key)).size).toBe(SCANNER_RULE_DEFINITIONS.length);
    const price = created.find((rule) => rule.key === "price")!;
    expect(price.valueJson).toEqual({ desired: [12, 60] });
    expect(price.profileId).toBe("profile-matt");

    // No scan (demo or live) was ever triggered by a settings save - this is the exact bug fix.
    expect(db.scanRun.create).not.toHaveBeenCalled();
    expect(db.scanResult.create).not.toHaveBeenCalled();
  });

  it("persists atomically: the rule replacement and the profile touch happen inside one $transaction", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    await updateScannerSettingsForUser("matt", buildValidScannerFormData());

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Every write call happened through the tx stand-in (the same db object here), which only
    // happens if they were issued from inside the $transaction callback.
    expect(db.scannerRule.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.scannerRule.createMany).toHaveBeenCalledTimes(1);
    expect(db.scannerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "profile-matt" } }),
    );
  });

  it("uses THREE statements, not one per rule, and gives the transaction a real time limit (the production crash)", async () => {
    // Against the remote production database a round trip is hundreds of milliseconds; 15 sequential
    // upserts plus the touch approached Prisma's default 5-second interactive-transaction limit and
    // failed the save there while being instant locally.
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    await updateScannerSettingsForUser("matt", buildValidScannerFormData());

    const statements = db.scannerRule.deleteMany.mock.calls.length + db.scannerRule.createMany.mock.calls.length + db.scannerProfile.update.mock.calls.length;
    expect(statements).toBe(3);
    const options = db.$transaction.mock.calls[0][1] as { timeout?: number; maxWait?: number } | undefined;
    expect(options?.timeout).toBeGreaterThanOrEqual(20_000);
    expect(options?.maxWait).toBeGreaterThanOrEqual(5_000);
  });

  it("only replaces the rules this app defines - a rule outside the definitions is never deleted", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    await updateScannerSettingsForUser("matt", buildValidScannerFormData());
    const where = db.scannerRule.deleteMany.mock.calls[0][0].where as { profileId: string; key: { in: string[] } };
    expect(where.profileId).toBe("profile-matt");
    expect(where.key.in.sort()).toEqual(SCANNER_RULE_DEFINITIONS.map((definition) => definition.key).sort());
  });

  it("4. rejects the entire save on an invalid field, before any database write is attempted", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    // "price" is a range rule - min > max is invalid (parseScannerDesiredFromForm throws).
    const invalidForm = buildValidScannerFormData({ "price:min": "999", "price:max": "1" });

    await expect(updateScannerSettingsForUser("matt", invalidForm)).rejects.toThrow(/valid range/i);

    // Validation runs entirely before the transaction opens - nothing was persisted, not even
    // the rules that were parsed successfully before "price" was reached.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.scannerRule.deleteMany).not.toHaveBeenCalled();
    expect(db.scannerRule.createMany).not.toHaveBeenCalled();
    expect(db.scannerProfile.update).not.toHaveBeenCalled();
  });

  it("5. a mid-transaction persistence failure never reaches the profile touch, and the thrown error propagates", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    db.scannerRule.createMany.mockRejectedValueOnce(new Error("connection lost"));

    await expect(updateScannerSettingsForUser("matt", buildValidScannerFormData())).rejects.toThrow("connection lost");

    // The transaction callback aborted at the failing create - the profile-touch step after it
    // never ran. (True atomic rollback of the earlier delete is Postgres's own guarantee for a real
    // $transaction, which a mock cannot itself prove - scanner-settings-replace.integration.test.ts
    // proves it against a real database.)
    expect(db.scannerProfile.update).not.toHaveBeenCalled();
  });

  it("6 & 7. Matt's save never touches Eric's profile or rules, and vice versa", async () => {
    db.scannerProfile.findFirst.mockResolvedValueOnce(mattProfile());
    await updateScannerSettingsForUser("matt", buildValidScannerFormData({ "price:min": "12", "price:max": "60" }));
    expect(ruleWriteProfileIds()).toEqual(new Set(["profile-matt"]));
    expect(db.scannerProfile.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: "matt" }) }));

    vi.clearAllMocks();
    db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) => callback(db));
    db.scannerProfile.findFirst.mockResolvedValueOnce(ericProfile());
    await updateScannerSettingsForUser("eric", buildValidScannerFormData({ "price:min": "15", "price:max": "45" }));
    expect(ruleWriteProfileIds()).toEqual(new Set(["profile-eric"]));
    expect(db.scannerProfile.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: "eric" }) }));
  });

  it("9. does not itself touch any ScanResult/criterion data, so it cannot alter Ticket 6 readiness of a stored run", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    await updateScannerSettingsForUser("matt", buildValidScannerFormData());
    expect(db.scanResult.create).not.toHaveBeenCalled();
  });

  it("10. saving settings issues zero scan-related database writes (no provider call could ever follow from one)", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    await updateScannerSettingsForUser("matt", buildValidScannerFormData());
    expect(db.scanRun.create).not.toHaveBeenCalled();
    expect(db.scanResult.create).not.toHaveBeenCalled();
  });
});

describe("resetScannerSettingsToLstCoreForUser (Ticket 7: reset must not run a scan)", () => {
  it("2. resets to defaults while the latest result is LIVE: defaults persist, no scan runs", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    await resetScannerSettingsToLstCoreForUser("matt");

    const created = db.scannerRule.createMany.mock.calls[0][0].data as Array<{ key: string; enabled: boolean; valueJson: { desired: unknown } }>;
    expect(created).toHaveLength(SCANNER_RULE_DEFINITIONS.length);
    for (const definition of SCANNER_RULE_DEFINITIONS) {
      const row = created.find((rule) => rule.key === definition.key)!;
      expect(row.enabled).toBe(definition.defaultEnabled);
      expect(row.valueJson).toEqual({ desired: definition.defaultDesired });
    }
    expect(ruleWriteProfileIds()).toEqual(new Set(["profile-matt"]));
    expect(db.scanRun.create).not.toHaveBeenCalled();
    expect(db.scanResult.create).not.toHaveBeenCalled();
  });

  it("persists atomically and bumps the profile's updatedAt (the signal the Scanner page reads for the 'earlier settings' disclosure)", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    await resetScannerSettingsToLstCoreForUser("matt");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.scannerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "profile-matt" }, data: expect.objectContaining({ updatedAt: expect.any(Date) }) }),
    );
  });

  it("6 & 7. resetting Matt's profile never touches Eric's, and vice versa", async () => {
    db.scannerProfile.findFirst.mockResolvedValueOnce(mattProfile());
    await resetScannerSettingsToLstCoreForUser("matt");
    expect(ruleWriteProfileIds()).toEqual(new Set(["profile-matt"]));

    vi.clearAllMocks();
    db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) => callback(db));
    db.scannerProfile.findFirst.mockResolvedValueOnce(ericProfile());
    await resetScannerSettingsToLstCoreForUser("eric");
    expect(ruleWriteProfileIds()).toEqual(new Set(["profile-eric"]));
  });
});

describe("rerunDemoScannerForUser (Ticket 7: demo mode still works, but only as an explicit action)", () => {
  it("3. an explicit demo action still creates a demo run, unaffected by the settings-save fix", async () => {
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile());
    db.scannerRule.findMany.mockResolvedValue([]);
    db.scanRun.create.mockResolvedValue({ id: "run-demo-1" });
    db.scanResult.create.mockResolvedValue({});

    await rerunDemoScannerForUser("matt");

    expect(db.scanRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ source: "DEMO", ownerId: "matt" }) }));
    expect(db.scanResult.create).toHaveBeenCalled();
  });
});

describe("settings-revision stamping (Astra follow-up: scan/settings concurrency)", () => {
  it("stamps every persisted result with the settings revision (profile.updatedAt) read at scan-start time, not persist time", async () => {
    const readAtScanStart = new Date("2026-09-21T14:00:00Z");
    db.scannerProfile.findFirst.mockResolvedValue(mattProfile({ updatedAt: readAtScanStart }));
    db.scannerRule.findMany.mockResolvedValue([]);
    db.scanRun.create.mockResolvedValue({ id: "run-demo-1" });
    db.scanResult.create.mockResolvedValue({});

    await rerunDemoScannerForUser("matt");

    expect(db.scanResult.create).toHaveBeenCalled();
    for (const [args] of db.scanResult.create.mock.calls) {
      expect(args.data.snapshotJson.settingsRevisionAsOf).toBe(readAtScanStart.toISOString());
    }
  });
});
