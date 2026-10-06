import { describe, expect, it } from "vitest";
import { actionLabelFor, moneynessDistanceLabel } from "./position-review-badge";

describe("actionLabelFor", () => {
  it("labels the four persistable actions", () => {
    expect(actionLabelFor("COMFORTABLE", [])).toBe("Comfortable");
    expect(actionLabelFor("REVIEW_ROLL", [])).toBe("Review roll");
    expect(actionLabelFor("REVIEW_CALL", [])).toBe("Review call");
    expect(actionLabelFor("WATCH", [])).toBe("Watch");
  });

  it("appends the expires-today qualifier only when the reasonCodes passed in actually carry it", () => {
    expect(actionLabelFor("WATCH", ["EXPIRES_TODAY"])).toBe("Watch · expires today");
    expect(actionLabelFor("WATCH", ["WITHIN_ROLL_BUFFER"])).toBe("Watch");
  });

  it("labels CANNOT_ASSESS", () => {
    expect(actionLabelFor("CANNOT_ASSESS", [])).toBe("Cannot assess");
  });
});

describe("moneynessDistanceLabel", () => {
  it("returns 'At strike' for ATM regardless of distance values", () => {
    expect(moneynessDistanceLabel({ moneyness: "ATM", dollarDistance: 0, percentageDistance: 0 })).toBe("At strike");
  });

  it("formats OTM/ITM distance as '<moneyness> by $X.XX / Y.Y%'", () => {
    expect(moneynessDistanceLabel({ moneyness: "OTM", dollarDistance: 5, percentageDistance: 20 })).toBe("OTM by $5.00 / 20.0%");
    expect(moneynessDistanceLabel({ moneyness: "ITM", dollarDistance: 1.256, percentageDistance: 3.21 })).toBe("ITM by $1.26 / 3.2%");
  });

  it("returns null when moneyness or either distance is missing", () => {
    expect(moneynessDistanceLabel({ moneyness: null, dollarDistance: 5, percentageDistance: 20 })).toBeNull();
    expect(moneynessDistanceLabel({ moneyness: "OTM", dollarDistance: null, percentageDistance: 20 })).toBeNull();
    expect(moneynessDistanceLabel({ moneyness: "OTM", dollarDistance: 5, percentageDistance: null })).toBeNull();
  });
});
