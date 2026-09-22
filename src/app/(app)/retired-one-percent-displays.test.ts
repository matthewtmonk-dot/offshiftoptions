import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Account Baseline & Funding Boundaries ticket: both misleading 1% displays (the Tracker's
// GoalTracker component and the Dashboard's weekly-percent block) must be retired in favor of
// neutral copy, with no replacement percentage metric. There is no component-render harness in
// this repo, so this asserts against the page source itself - the same precedent already accepted
// for Schwab CSV fixtures (see providers/schwab/csv.test.ts).
function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("positions page no longer renders the 1% Goal Tracker", () => {
  const text = source("./positions/page.tsx");

  it("has no GoalTracker component or 1% Goal Pace metric left", () => {
    expect(text).not.toMatch(/function GoalTracker/);
    expect(text).not.toContain("<GoalTracker");
    expect(text).not.toContain("1% Goal Pace");
    expect(text).not.toContain("1% Goal Tracker");
  });

  it("shows the neutral rebuild-in-progress copy instead", () => {
    expect(text).toContain("Trade-return goal reporting is being rebuilt from verified account and trade data.");
  });
});

describe("dashboard page no longer renders the weekly 1% target block", () => {
  const text = source("./dashboard/page.tsx");

  it("has no weekly-percent-of-target display left", () => {
    expect(text).not.toContain("summarizeWeeklyReturns");
    expect(text).not.toContain("WEEKLY_TARGET_PERCENT");
    expect(text).not.toContain("weeklyToneClass");
    expect(text).not.toMatch(/of\s*\{WEEKLY_TARGET_PERCENT\}%\s*target/);
  });

  it("still shows the win/loss record and the neutral rebuild-in-progress copy", () => {
    expect(text).toContain("Trade-return goal reporting is being rebuilt from verified account and trade data.");
    expect(text).toMatch(/W-L \{winLoss\.wins\}-\{winLoss\.losses\}/);
  });
});
