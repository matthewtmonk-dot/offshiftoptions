import "server-only";
import { DEFAULT_PLAN_LIMITS, PLAN_LIMIT_FIELDS, sanitizePlanLimits, type PlanLimits } from "@/domain/portfolio/portfolioPlan";
import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/tickers";

/**
 * Per-user portfolio limits (the picks planner's ceilings), saved on the server so every device and the Dashboard
 * use the same numbers. Until Nov 11 2026 they lived only in each browser's localStorage.
 *
 * STORAGE - no schema change: the limits are the rules of a second `ScannerProfile` row per user, named
 * PLAN_LIMITS_PROFILE_NAME. A ScannerProfile is "a named set of per-user rules (key, value, enabled)", which is exactly
 * what these are, and `@@unique([ownerId, name])` gives one row per user. Every existing reader looks the scanner's own
 * profile up BY NAME ("My LST"), so this row is never mistaken for scan criteria, never evaluated against a stock and
 * never touched by "Reset all to LST Core". Each limit is one ScannerRule: `key` = the PlanLimits field,
 * `valueJson` = { desired: number }. Do not attach ScanRuns to this profile.
 */
export const PLAN_LIMITS_PROFILE_NAME = "Portfolio limits";

/** The user's saved limits, with defaults for anything not saved. Fails soft to the defaults - never throws. */
export async function getPlanLimitsForUser(userId: string): Promise<PlanLimits> {
  try {
    const profile = await prisma.scannerProfile.findFirst({
      where: { ownerId: userId, name: PLAN_LIMITS_PROFILE_NAME },
      select: { rules: { select: { key: true, valueJson: true } } },
    });
    if (!profile) return { ...DEFAULT_PLAN_LIMITS };
    const saved: Record<string, unknown> = {};
    for (const rule of profile.rules) {
      const value = rule.valueJson as { desired?: unknown } | null;
      if (value && typeof value === "object" && "desired" in value) saved[rule.key] = value.desired;
    }
    return sanitizePlanLimits(saved);
  } catch (error) {
    console.warn("Portfolio limits unavailable, using defaults:", error instanceof Error ? error.name : "unknown error");
    return { ...DEFAULT_PLAN_LIMITS };
  }
}

/** Validates the form values (rejects out-of-range input with a plain message) and saves them for this user only. */
export async function savePlanLimitsForUser(userId: string, input: Record<string, unknown>): Promise<PlanLimits> {
  const next: Partial<Record<keyof PlanLimits, number>> = {};
  for (const field of PLAN_LIMIT_FIELDS) {
    const raw = input[field.key];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max) {
      throw new ValidationError(`"${field.label}" must be a number from ${field.min} to ${field.max}.`);
    }
    next[field.key] = field.integer ? Math.round(parsed) : parsed;
  }
  const limits = sanitizePlanLimits(next);
  if (limits.maxLargePositionPct < limits.maxPerCompanyPct) {
    throw new ValidationError("The larger-position limit cannot be lower than the normal per-company limit.");
  }

  await prisma.$transaction(async (tx) => {
    const profile = await tx.scannerProfile.upsert({
      where: { ownerId_name: { ownerId: userId, name: PLAN_LIMITS_PROFILE_NAME } },
      update: { updatedAt: new Date() },
      create: { ownerId: userId, name: PLAN_LIMITS_PROFILE_NAME, visibility: "PRIVATE" },
      select: { id: true },
    });
    for (const [index, field] of PLAN_LIMIT_FIELDS.entries()) {
      const data = { name: field.label, operator: field.key === "minReturnPct" || field.key === "sizeLimitsFromAccountValue" ? ("GTE" as const) : ("LTE" as const), valueJson: { desired: limits[field.key] }, enabled: true, sortOrder: index };
      await tx.scannerRule.upsert({
        where: { profileId_key: { profileId: profile.id, key: field.key } },
        update: data,
        create: { profileId: profile.id, key: field.key, ...data },
      });
    }
  });
  return limits;
}
