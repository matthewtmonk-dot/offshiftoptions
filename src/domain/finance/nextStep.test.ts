import { describe, expect, it } from "vitest";
import { nextStepFor } from "./nextStep";

const base = { settlementPending: false, dte: 7, historical: false } as const;

describe("nextStepFor", () => {
  it("settlement pending always says wait", () => {
    expect(nextStepFor({ ...base, settlementPending: true, action: "WATCH" }).tone).toBe("wait");
  });
  it("no reading -> wait, never a trade suggestion", () => {
    expect(nextStepFor({ ...base, action: null }).tone).toBe("wait");
    expect(nextStepFor({ ...base, action: "CANNOT_ASSESS" }).tone).toBe("wait");
  });
  it("comfortable -> nothing to do, mentions expiry only when it is today/tomorrow", () => {
    expect(nextStepFor({ ...base, action: "COMFORTABLE" }).text).toBe("No action needed.");
    expect(nextStepFor({ ...base, action: "COMFORTABLE", dte: 0 }).text).toContain("expires today");
  });
  it("watch -> check again; expiring soon points at the 3 PM check", () => {
    expect(nextStepFor({ ...base, action: "WATCH" })).toMatchObject({ tone: "watch" });
    expect(nextStepFor({ ...base, action: "WATCH", dte: 1 }).text).toContain("Expires tomorrow");
  });
  it("review roll -> decision due", () => {
    expect(nextStepFor({ ...base, action: "REVIEW_ROLL" }).tone).toBe("act");
    expect(nextStepFor({ ...base, action: "REVIEW_ROLL", dte: 0 }).text).toContain("Decide today");
  });
  it("review call -> decision due", () => {
    expect(nextStepFor({ ...base, action: "REVIEW_CALL" }).tone).toBe("act");
  });
  it("marks a historical reading as older", () => {
    expect(nextStepFor({ ...base, action: "REVIEW_ROLL", historical: true }).text).toContain("last valid reading");
  });
});
