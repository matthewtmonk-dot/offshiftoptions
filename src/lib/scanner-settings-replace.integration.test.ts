import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash } from "bcryptjs";
import { SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

/**
 * Saving or resetting Scanner Rules now writes the whole rule set as delete + create + touch inside one
 * transaction (see replaceScannerRules in workflows.ts) instead of 15 sequential upserts. Uses its own
 * throwaway user so it never touches the seeded Matt/Eric profiles.
 */
maybeDescribe("scanner settings save/reset (replaceScannerRules)", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let userId: string;
  let profileId: string;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    const user = await prisma.user.create({
      data: { name: "Settings Test User", email: `settings-${Date.now()}@lst.local`, passwordHash: await hash("not-used", 4) },
      select: { id: true },
    });
    userId = user.id;
    profileId = (await workflows.ensureMyLstScannerProfileForUser(userId)).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  function formWith(overrides: Record<string, string | null> = {}) {
    const formData = new FormData();
    for (const definition of SCANNER_RULE_DEFINITIONS) {
      if (definition.defaultEnabled) formData.set(`${definition.key}:enabled`, "on");
      if (Array.isArray(definition.defaultDesired)) {
        formData.set(`${definition.key}:min`, String(definition.defaultDesired[0]));
        formData.set(`${definition.key}:max`, String(definition.defaultDesired[1]));
      } else if (definition.input.kind === "single") {
        formData.set(`${definition.key}:value`, String(definition.defaultDesired));
      }
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) formData.delete(key);
      else formData.set(key, value);
    }
    return formData;
  }

  const rules = () => prisma.scannerRule.findMany({ where: { profileId }, orderBy: { sortOrder: "asc" } });

  it("saves every rule once, in definition order, with the submitted enabled flags and values", async () => {
    await workflows.updateScannerSettingsForUser(
      userId,
      formWith({ "dte:enabled": "on", "dte:min": "3", "dte:max": "9", "delta:enabled": null, "ror:value": "1.5" }),
    );
    const saved = await rules();
    expect(saved.map((rule) => rule.key)).toEqual(SCANNER_RULE_DEFINITIONS.map((definition) => definition.key));
    expect(new Set(saved.map((rule) => rule.key)).size).toBe(SCANNER_RULE_DEFINITIONS.length);
    expect(saved.map((rule) => rule.sortOrder)).toEqual(SCANNER_RULE_DEFINITIONS.map((_, index) => index));
    const byKey = new Map(saved.map((rule) => [rule.key, rule]));
    expect(byKey.get("dte")).toMatchObject({ enabled: true, valueJson: { desired: [3, 9] } });
    expect(byKey.get("delta")?.enabled).toBe(false);
    expect(byKey.get("ror")?.valueJson).toMatchObject({ desired: 1.5 });
  });

  it("advances the profile's updatedAt (the 'settings changed after this scan' marker)", async () => {
    const before = (await prisma.scannerProfile.findUniqueOrThrow({ where: { id: profileId } })).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await workflows.updateScannerSettingsForUser(userId, formWith());
    const after = (await prisma.scannerProfile.findUniqueOrThrow({ where: { id: profileId } })).updatedAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("is all-or-nothing: an invalid field rejects the whole save and leaves every earlier value untouched", async () => {
    await workflows.updateScannerSettingsForUser(userId, formWith({ "rsi:value": "37" }));
    const before = JSON.stringify((await rules()).map((rule) => [rule.key, rule.enabled, rule.valueJson]));

    await expect(workflows.updateScannerSettingsForUser(userId, formWith({ "rsi:value": "41", "dte:min": "20", "dte:max": "5" }))).rejects.toThrow(/valid range/);

    expect(JSON.stringify((await rules()).map((rule) => [rule.key, rule.enabled, rule.valueJson]))).toBe(before);
  });

  it("leaves a rule outside the current definitions alone", async () => {
    await prisma.scannerRule.create({
      data: { profileId, key: "retiredRule", name: "Retired rule", operator: "GTE", valueJson: { desired: 1 }, enabled: true, sortOrder: 99 },
    });
    await workflows.updateScannerSettingsForUser(userId, formWith());
    await workflows.resetScannerSettingsToLstCoreForUser(userId);
    expect(await prisma.scannerRule.count({ where: { profileId, key: "retiredRule" } })).toBe(1);
  });

  it("Reset to LST Core restores every default - including the 3-11 day expiration window being ON", async () => {
    await workflows.updateScannerSettingsForUser(userId, formWith({ "dte:enabled": null, "price:min": "20", "price:max": "40" }));
    await workflows.resetScannerSettingsToLstCoreForUser(userId);
    const byKey = new Map((await rules()).map((rule) => [rule.key, rule]));
    for (const definition of SCANNER_RULE_DEFINITIONS) {
      expect(byKey.get(definition.key), definition.key).toMatchObject({ enabled: definition.defaultEnabled, valueJson: { desired: definition.defaultDesired } });
    }
    expect(byKey.get("dte")).toMatchObject({ enabled: true, valueJson: { desired: [3, 11] } });
  });
});
