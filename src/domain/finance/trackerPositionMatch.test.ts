import { describe, expect, it } from "vitest";
import { matchTrackedPut, type TrackedPut } from "./trackerPositionMatch";

const account = { id: "account-a", userId: "matt", externalAccountId: "broker-a" };
const position = { accountId: "broker-a", symbol: "CORZ  260918P00016500", quantity: -1 };
const campaign: TrackedPut = { id: "campaign-a", ownerId: "matt", accountId: "account-a", ticker: "CORZ",
  status: "OPEN", strike: 16.5, expiration: new Date("2026-09-18"), contracts: 1 };

describe("Tracker display-only put matching", () => {
  it("matches padded/canonical/case equivalents in the user's own account", () => {
    for (const symbol of [position.symbol, "CORZ260918P00016500", " corz 260918p00016500 "]) {
      const row = { ...position, symbol };
      expect(matchTrackedPut("matt", row, [row], [account], [campaign])).toBe("EXACT");
    }
  });
  it.each([
    { ticker: "HL" }, { strike: 18 }, { expiration: new Date("2026-09-25") }, { contracts: 2 },
    { accountId: "another-account" }, { ownerId: "eric" }, { status: "CLOSED" }, { status: "ASSIGNED" },
  ])("rejects a different active leg, quantity, account, owner or lifecycle: %j", (change) => {
    expect(matchTrackedPut("matt", position, [position], [account], [{ ...campaign, ...change }])).toBe("NONE");
  });
  it.each([
    { quantity: 1 }, { quantity: 0 }, { quantity: -0.5 }, { quantity: NaN },
    { symbol: "CORZ 260918C00016500" }, { symbol: "CORZ" }, { accountId: "broker-b" },
    { putCall: "CALL" as const }, { assetType: "EQUITY" }, { strikePrice: 18 }, { underlyingSymbol: "HL" },
  ])("rejects incompatible/invalid broker evidence: %j", (change) => {
    const row = { ...position, ...change };
    expect(matchTrackedPut("matt", row, [row], [account], [campaign])).toBe("NONE");
  });
  it("does not match another user's account even if identifiers coincide", () => {
    expect(matchTrackedPut("eric", position, [position], [account], [campaign])).toBe("NONE");
  });
  it("keeps multiple campaigns for a contract ambiguous instead of selecting by quantity", () => {
    expect(matchTrackedPut("matt", position, [position], [account], [campaign, { ...campaign, id: "second", contracts: 2 }])).toBe("AMBIGUOUS");
  });
  it("rejects duplicate provider rows and ambiguous account mappings", () => {
    expect(matchTrackedPut("matt", position, [position, { ...position, symbol: "CORZ260918P00016500" }], [account], [campaign])).toBe("AMBIGUOUS");
    expect(matchTrackedPut("matt", position, [position], [account, { ...account, id: "duplicate" }], [campaign])).toBe("AMBIGUOUS");
  });
});
