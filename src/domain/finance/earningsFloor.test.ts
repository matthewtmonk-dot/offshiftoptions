import { describe, expect, it } from "vitest";
import { daysUntilFloor, earningsFloorFrom, latestReportedPeriod, MIN_FISCAL_QUARTER_DAYS } from "./earningsFloor";

const today = new Date("2026-11-16T00:00:00Z");

function submissions(rows: [form: string, filingDate: string, reportDate: string][]) {
  return {
    sic: "3674",
    filings: {
      recent: {
        form: rows.map((row) => row[0]),
        filingDate: rows.map((row) => row[1]),
        reportDate: rows.map((row) => row[2]),
      },
    },
  };
}

describe("latestReportedPeriod", () => {
  it("picks the latest 10-Q/10-K period and ignores earnings press releases (8-K)", () => {
    // Shape of SMCI on Nov 16 2026: a preliminary-results 8-K (Oct 20), the real 8-K (Nov 3), then the 10-Q (Nov 6).
    const period = latestReportedPeriod(
      submissions([
        ["10-Q", "2026-11-06", "2026-09-30"],
        ["8-K", "2026-11-03", "2026-11-03"],
        ["8-K", "2026-10-20", "2026-10-20"],
        ["10-K", "2026-08-28", "2026-06-30"],
      ]),
      today,
    );
    expect(period).toEqual({ form: "10-Q", periodEnd: new Date("2026-09-30T00:00:00Z"), filedAt: new Date("2026-11-06T00:00:00Z") });
  });

  it("does not depend on the order of the rows", () => {
    const period = latestReportedPeriod(
      submissions([
        ["10-K", "2026-08-28", "2026-06-30"],
        ["10-Q", "2026-11-06", "2026-09-30"],
      ]),
      today,
    );
    expect(period?.periodEnd.toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("returns null for a company that has only released earnings (8-K) but not filed the report", () => {
    expect(latestReportedPeriod(submissions([["8-K", "2026-11-03", "2026-11-03"]]), today)).toBeNull();
  });

  it("returns null for a foreign filer (20-F / 6-K only)", () => {
    expect(
      latestReportedPeriod(
        submissions([
          ["6-K", "2026-11-10", "2026-09-30"],
          ["20-F", "2026-04-20", "2025-12-31"],
        ]),
        today,
      ),
    ).toBeNull();
  });

  it("ignores amendments and transition-period forms", () => {
    const period = latestReportedPeriod(
      submissions([
        ["10-Q/A", "2026-11-12", "2026-09-30"],
        ["10-QT", "2026-11-10", "2026-10-31"],
        ["10-Q", "2026-08-05", "2026-06-30"],
      ]),
      today,
    );
    expect(period?.periodEnd.toISOString().slice(0, 10)).toBe("2026-06-30");
  });

  it("ignores corrupt rows: a filing dated in the future, a period ending after its filing, a malformed date", () => {
    expect(
      latestReportedPeriod(
        submissions([
          ["10-Q", "2026-12-01", "2026-10-31"],
          ["10-Q", "2026-11-01", "2026-11-30"],
          ["10-Q", "2026-11-05", "2026-13-40"],
          ["10-Q", "2026-11-05", ""],
        ]),
        today,
      ),
    ).toBeNull();
  });

  it("returns null for anything that is not a submissions document", () => {
    expect(latestReportedPeriod(null, today)).toBeNull();
    expect(latestReportedPeriod({}, today)).toBeNull();
    expect(latestReportedPeriod({ filings: { recent: { form: "10-Q" } } }, today)).toBeNull();
  });
});

describe("earningsFloorFrom", () => {
  it("puts the floor 12 weeks after the reported period ends", () => {
    expect(MIN_FISCAL_QUARTER_DAYS).toBe(84);
    const floor = earningsFloorFrom({ form: "10-Q", periodEnd: new Date("2026-09-30T00:00:00Z"), filedAt: new Date("2026-11-06T00:00:00Z") });
    expect(floor.notBefore).toBe("2026-12-23");
    expect(floor.source).toContain("2026-09-30");
    expect(floor.source).toContain("2026-11-06");
    expect(floor.source).toContain("2026-12-23");
  });

  it("gives a floor already in the past for a company that stopped filing - useless, never misleading", () => {
    const floor = earningsFloorFrom({ form: "10-K", periodEnd: new Date("2025-12-31T00:00:00Z"), filedAt: new Date("2026-02-20T00:00:00Z") });
    expect(daysUntilFloor(floor, today)).toBeLessThan(0);
  });
});

describe("daysUntilFloor", () => {
  it("counts whole calendar days and ignores the time of day", () => {
    const floor = { notBefore: "2026-12-23", source: "" };
    expect(daysUntilFloor(floor, today)).toBe(37);
    expect(daysUntilFloor(floor, new Date("2026-11-16T22:30:00Z"))).toBe(37);
  });

  it("returns null for a malformed floor", () => {
    expect(daysUntilFloor({ notBefore: "soon", source: "" }, today)).toBeNull();
  });
});
