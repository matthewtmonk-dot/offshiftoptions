import { describe, expect, it } from "vitest";
import { buildStressTable } from "./stressTest";

describe("buildStressTable", () => {
  it("scales committed capital by each shock and expresses it against the whole account", () => {
    const table = buildStressTable({ committed: 4000, accountValue: 10000, hasUnknownExposure: false })!;
    expect(table.isFloor).toBe(false);
    expect(table.rows).toEqual([
      { shockPercent: 20, lossDollars: 800, lossPercentOfAccount: 8 },
      { shockPercent: 30, lossDollars: 1200, lossPercentOfAccount: 12 },
      { shockPercent: 50, lossDollars: 2000, lossPercentOfAccount: 20 },
    ]);
  });

  it("is a floor when some exposure is unknown", () => {
    expect(buildStressTable({ committed: 1000, accountValue: 5000, hasUnknownExposure: true })!.isFloor).toBe(true);
  });

  it("returns nothing when the inputs are missing or unusable (never a made-up number)", () => {
    expect(buildStressTable({ committed: null, accountValue: 5000, hasUnknownExposure: false })).toBeNull();
    expect(buildStressTable({ committed: 1000, accountValue: null, hasUnknownExposure: false })).toBeNull();
    expect(buildStressTable({ committed: 1000, accountValue: 0, hasUnknownExposure: false })).toBeNull();
    expect(buildStressTable({ committed: -5, accountValue: 1000, hasUnknownExposure: false })).toBeNull();
    expect(buildStressTable({ committed: Number.NaN, accountValue: 1000, hasUnknownExposure: false })).toBeNull();
  });

  it("shows zero loss when nothing is committed", () => {
    const table = buildStressTable({ committed: 0, accountValue: 10000, hasUnknownExposure: false })!;
    expect(table.rows.every((row) => row.lossDollars === 0 && row.lossPercentOfAccount === 0)).toBe(true);
  });

  it("ignores invalid shock values", () => {
    const table = buildStressTable({ committed: 1000, accountValue: 10000, hasUnknownExposure: false, shocks: [0.1, 0, -1, 2] })!;
    expect(table.rows.map((row) => row.shockPercent)).toEqual([10]);
  });
});
