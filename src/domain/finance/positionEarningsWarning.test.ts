import { describe, expect, it } from "vitest";
import { evaluatePositionEarningsWarning, rollEarningsCaution } from "./positionEarningsWarning";

// Wed Nov 4, 2026, 10:00 AM New York (15:00 UTC, EST).
const now = new Date("2026-11-04T15:00:00Z");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const scheduled = (iso: string) => ({ status: "SCHEDULED" as const, reportDate: day(iso) });

describe("evaluatePositionEarningsWarning", () => {
  it("flags an open put whose expiration is on or after the report", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: day("2026-11-06"), evidence: scheduled("2026-11-05"), now });
    expect(warning.level).toBe("BEFORE_EXPIRY");
    expect(warning.reportDate).toBe("2026-11-05");
    expect(warning.daysAway).toBe(1);
    expect(warning.message).toContain("tomorrow");
    expect(warning.message).toContain("before this put expires");
  });

  it("treats a report on the expiration day as before expiry (announcement time is unknown)", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: day("2026-11-06"), evidence: scheduled("2026-11-06"), now });
    expect(warning.level).toBe("BEFORE_EXPIRY");
  });

  it("is quiet when the report is after the expiration", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: day("2026-11-06"), evidence: scheduled("2026-11-09"), now });
    expect(warning.level).toBe("NONE");
    expect(warning.message).toBe("");
    expect(warning.reportDate).toBe("2026-11-09");
  });

  it("flags an open covered call that spans earnings", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "CALL", expiration: day("2026-11-13"), evidence: scheduled("2026-11-05"), now });
    expect(warning.level).toBe("BEFORE_EXPIRY");
    expect(warning.message).toContain("before this call expires");
  });

  it("flags assigned shares with no call when earnings are within a week", () => {
    const warning = evaluatePositionEarningsWarning({ legType: null, expiration: null, evidence: scheduled("2026-11-05"), now });
    expect(warning.level).toBe("SHARES_SOON");
    expect(warning.message).toContain("no call is open");
  });

  it("does not flag assigned shares when earnings are further out", () => {
    const warning = evaluatePositionEarningsWarning({ legType: null, expiration: null, evidence: scheduled("2026-11-30"), now });
    expect(warning.level).toBe("NONE");
  });

  it("says the date is unconfirmed for missing, stale, ambiguous or already-past evidence - never 'no earnings'", () => {
    for (const evidence of [undefined, null, { status: "NO_EVIDENCE" as const, reportDate: null }, { status: "STALE" as const, reportDate: day("2026-11-05") }, { status: "AMBIGUOUS" as const, reportDate: null }, scheduled("2026-11-02")]) {
      const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: day("2026-11-06"), evidence, now });
      expect(warning.level).toBe("UNKNOWN");
      expect(warning.reportDate).toBeNull();
    }
  });

  it("says 'today' when the report is today", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: day("2026-11-06"), evidence: scheduled("2026-11-04"), now });
    expect(warning.level).toBe("BEFORE_EXPIRY");
    expect(warning.daysAway).toBe(0);
    expect(warning.message).toContain("today");
  });

  it("uses the New York date, not UTC, for 'today' (late evening ET is already the next UTC day)", () => {
    const lateEvening = new Date("2026-11-05T02:30:00Z"); // 9:30 PM ET on Nov 4
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: day("2026-11-06"), evidence: scheduled("2026-11-05"), now: lateEvening });
    expect(warning.daysAway).toBe(1);
  });
});

describe("rollEarningsCaution", () => {
  const putExpiringFriday = day("2026-11-06");

  it("warns not to roll when the current position already spans earnings", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: putExpiringFriday, evidence: scheduled("2026-11-05"), now });
    expect(rollEarningsCaution(warning, putExpiringFriday)).toContain("Don't roll into earnings");
  });

  it("warns when rolling out one week would reach the report even though the current expiry is clear", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: putExpiringFriday, evidence: scheduled("2026-11-10"), now });
    expect(warning.level).toBe("NONE");
    expect(rollEarningsCaution(warning, putExpiringFriday)).toContain("2026-11-10");
  });

  it("is quiet when the report is beyond the rolled expiration", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: putExpiringFriday, evidence: scheduled("2026-11-20"), now });
    expect(rollEarningsCaution(warning, putExpiringFriday)).toBeNull();
  });

  it("asks to confirm an unknown date before rolling", () => {
    const warning = evaluatePositionEarningsWarning({ legType: "PUT", expiration: putExpiringFriday, evidence: null, now });
    expect(rollEarningsCaution(warning, putExpiringFriday)).toBe("Confirm the earnings date before rolling.");
  });
});
