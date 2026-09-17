import { describe, expect, it } from "vitest";
import { summarizeCspSecuredCapital } from "./brokerPositions";
import {
  exactMatchedCampaignId,
  matchDashboardPositions,
  matchTrackedPut,
  resolveTrackerPositionMatchState,
  type DashboardPositionInput,
  type TrackedPut,
} from "./trackerPositionMatch";

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

describe("Persisted-link precedence over inferred matching", () => {
  it("shows LINKED even when the persisted campaign is no longer OPEN (matchTrackedPut alone would say NONE)", () => {
    const inferred = matchTrackedPut("matt", position, [position], [account], [{ ...campaign, status: "CLOSED" }]);
    expect(inferred).toBe("NONE");
    expect(resolveTrackerPositionMatchState(true, inferred)).toBe("LINKED");
  });
  it("prefers a persisted link over an inferred EXACT match", () => {
    const inferred = matchTrackedPut("matt", position, [position], [account], [campaign]);
    expect(inferred).toBe("EXACT");
    expect(resolveTrackerPositionMatchState(true, inferred)).toBe("LINKED");
  });
  it("still surfaces inferred EXACT when there is no persisted link", () => {
    const inferred = matchTrackedPut("matt", position, [position], [account], [campaign]);
    expect(resolveTrackerPositionMatchState(false, inferred)).toBe("EXACT");
  });
  it("does not let a persisted link for one user override another user's isolated (NONE) result", () => {
    const inferred = matchTrackedPut("eric", position, [position], [account], [campaign]);
    expect(inferred).toBe("NONE");
    expect(resolveTrackerPositionMatchState(false, inferred)).toBe("NONE");
  });
  it.each(["AMBIGUOUS", "NONE"] as const)("passes through inferred %s untouched when unlinked", (state) => {
    expect(resolveTrackerPositionMatchState(false, state)).toBe(state);
  });
});

describe("exactMatchedCampaignId (attribution for an already-confirmed EXACT match)", () => {
  it("identifies the specific campaign for a genuine EXACT match", () => {
    expect(exactMatchedCampaignId("matt", position, [position], [account], [campaign])).toBe("campaign-a");
  });
  it("returns null when the match is AMBIGUOUS (never guesses which campaign)", () => {
    const second: TrackedPut = { ...campaign, id: "campaign-b", contracts: 2 };
    expect(exactMatchedCampaignId("matt", position, [position], [account], [campaign, second])).toBeNull();
  });
  it("returns null when the match is NONE", () => {
    expect(exactMatchedCampaignId("matt", position, [position], [account], [{ ...campaign, status: "CLOSED" }])).toBeNull();
  });
  it("returns null for another user even if the same campaign/account identifiers coincide", () => {
    expect(exactMatchedCampaignId("eric", position, [position], [account], [campaign])).toBeNull();
  });
});

describe("matchDashboardPositions (Dashboard duplicate-position dedup)", () => {
  const accountB = { id: "account-b", userId: "matt", externalAccountId: "broker-b" };
  const campaignB: TrackedPut = { ...campaign, id: "campaign-b", accountId: "account-b" };

  function positionInput(overrides: Partial<DashboardPositionInput> = {}): DashboardPositionInput {
    return { ...position, linkedCampaignId: null, ...overrides };
  }

  it("test 1: a persisted-linked position renders its campaign once (LINKED, confirmed)", () => {
    // Campaign is CLOSED so the inferred match alone would be NONE - the persisted link must
    // still win, exactly like resolveTrackerPositionMatchState's own precedence.
    const linked = positionInput({ linkedCampaignId: "campaign-a" });
    const [result] = matchDashboardPositions("matt", [linked], [account], [{ ...campaign, status: "CLOSED" }]);
    expect(result.disposition).toBe("LINKED");
    expect(result.confirmedCampaignId).toBe("campaign-a");
  });

  it("test 2: an EXACT inferred match (no persisted link) renders its campaign once", () => {
    const [result] = matchDashboardPositions("matt", [positionInput()], [account], [campaign]);
    expect(result.disposition).toBe("EXACT");
    expect(result.confirmedCampaignId).toBe("campaign-a");
  });

  it("test 3: an EXACT match is excluded from the additive/broker-collateral set (the caller filters on disposition)", () => {
    const [result] = matchDashboardPositions("matt", [positionInput()], [account], [campaign]);
    expect(["LINKED", "EXACT"]).toContain(result.disposition);
  });

  it("test 4: a linked/EXACT position never doubles as its own separate broker line - exactly one representation per real position", () => {
    const results = matchDashboardPositions("matt", [positionInput()], [account], [campaign]);
    expect(results).toHaveLength(1); // one input position -> one match record, never split into two
    expect(results[0].disposition).toBe("EXACT");
  });

  it("test 5: an AMBIGUOUS broker position stays separate and is never assigned a confirmed campaign", () => {
    const secondCampaign: TrackedPut = { ...campaign, id: "campaign-second", contracts: 2 };
    const [result] = matchDashboardPositions("matt", [positionInput()], [account], [campaign, secondCampaign]);
    expect(result.disposition).toBe("AMBIGUOUS");
    expect(result.confirmedCampaignId).toBeNull();
  });

  it("test 6: an untracked (NONE) broker position stays separate and unconfirmed", () => {
    const [result] = matchDashboardPositions("matt", [positionInput()], [account], []);
    expect(result.disposition).toBe("NONE");
    expect(result.confirmedCampaignId).toBeNull();
  });

  it("test 7: a cross-user position can never suppress/confirm another user's campaign", () => {
    const [result] = matchDashboardPositions("eric", [positionInput()], [account], [campaign]);
    expect(result.disposition).toBe("NONE");
    expect(result.confirmedCampaignId).toBeNull();
  });

  it("test 8: a cross-account position cannot merge with a campaign in a different account, even with an identical contract", () => {
    // The position belongs to broker-a (account-a); only campaignB (account-b) exists as a
    // candidate for that exact contract - must not merge across accounts.
    const [result] = matchDashboardPositions("matt", [positionInput()], [account, accountB], [campaignB]);
    expect(result.disposition).toBe("NONE");
    expect(result.confirmedCampaignId).toBeNull();
  });

  it("test 9: duplicate compatible campaigns for one contract remain AMBIGUOUS, never deduped by picking one", () => {
    const duplicate: TrackedPut = { ...campaign, id: "campaign-dup" };
    const [result] = matchDashboardPositions("matt", [positionInput()], [account], [campaign, duplicate]);
    expect(result.disposition).toBe("AMBIGUOUS");
    expect(result.confirmedCampaignId).toBeNull();
  });

  describe("acceptance example: 4 tracked puts must total $7,550, never $15,100", () => {
    // Matt's real production numbers: CORZ $16.50 + HL $18.00 + PATH $14.00 + ONON $27.00, each
    // 1 contract, secured at strike x 100 = $1,650 / $1,800 / $1,400 / $2,700 = $7,550 total. The
    // Dashboard bug doubled this to $15,100 by also adding each position's collateral a second
    // time as "unlinked Schwab" even though every one was the exact same real position.
    const acceptanceAccount = { id: "account-a", userId: "matt", externalAccountId: "broker-a" };
    const contracts = [
      { ticker: "CORZ", strike: 16.5 },
      { ticker: "HL", strike: 18 },
      { ticker: "PATH", strike: 14 },
      { ticker: "ONON", strike: 27 },
    ];
    const expiration = new Date("2026-09-18");
    const occSymbol = (ticker: string, strike: number) => `${ticker} 260918P${String(Math.round(strike * 1000)).padStart(8, "0")}`;

    const acceptanceCampaigns: TrackedPut[] = contracts.map((contract) => ({
      id: `campaign-${contract.ticker}`, ownerId: "matt", accountId: "account-a", ticker: contract.ticker,
      status: "OPEN", strike: contract.strike, expiration, contracts: 1,
    }));
    const acceptancePositions = contracts.map((contract) => ({
      accountId: "broker-a", symbol: occSymbol(contract.ticker, contract.strike), quantity: -1,
      marketValue: -100, linkedCampaignId: null as string | null,
    }));

    it("matches all four positions EXACT to their own campaign - none stay additive", () => {
      const results = matchDashboardPositions("matt", acceptancePositions, [acceptanceAccount], acceptanceCampaigns);
      expect(results.map((result) => result.disposition)).toEqual(["EXACT", "EXACT", "EXACT", "EXACT"]);
      expect(new Set(results.map((result) => result.confirmedCampaignId))).toEqual(new Set(acceptanceCampaigns.map((campaign) => campaign.id)));
    });

    it("campaign collateral ($7,550) plus matched-position collateral ($0) totals $7,550, not $15,100", () => {
      const results = matchDashboardPositions("matt", acceptancePositions, [acceptanceAccount], acceptanceCampaigns);
      const additive = results
        .filter((result): result is typeof result & { disposition: "AMBIGUOUS" | "NONE" } => result.disposition === "AMBIGUOUS" || result.disposition === "NONE")
        .map((result) => result.position);
      expect(additive).toHaveLength(0);

      const campaignCollateral = acceptanceCampaigns.reduce((sum, campaign) => sum + campaign.strike * campaign.contracts * 100, 0);
      expect(campaignCollateral).toBe(7550);

      const fixedBrokerCollateral = summarizeCspSecuredCapital(additive).total;
      expect(fixedBrokerCollateral).toBe(0);
      expect(campaignCollateral + fixedBrokerCollateral).toBe(7550);

      // The regression this fixes, made concrete: the OLD "unlinked-only" dedup treated every one
      // of these four positions as additive (nothing was persisted-linked), double-counting the
      // exact same real collateral and producing Matt's reported $15,100.
      const oldBuggyBrokerCollateral = summarizeCspSecuredCapital(acceptancePositions).total;
      expect(oldBuggyBrokerCollateral).toBe(7550);
      expect(campaignCollateral + oldBuggyBrokerCollateral).toBe(15100);
    });
  });

  it("processes multiple positions independently in one batch - one ambiguous position never affects another's clean match", () => {
    const corz = positionInput({ symbol: "CORZ  260918P00016500", accountId: "broker-a" });
    const hl = positionInput({ symbol: "HL  260918P00018000", accountId: "broker-a" });
    const hlCampaign: TrackedPut = {
      id: "campaign-hl", ownerId: "matt", accountId: "account-a", ticker: "HL",
      status: "OPEN", strike: 18, expiration: new Date("2026-09-18"), contracts: 1,
    };
    // Two OPEN campaigns compete for CORZ (ambiguous), but HL has exactly one - independent outcomes.
    const results = matchDashboardPositions(
      "matt",
      [corz, hl],
      [account],
      [campaign, { ...campaign, id: "campaign-dup" }, hlCampaign],
    );
    const corzResult = results.find((result) => result.position.symbol === corz.symbol);
    const hlResult = results.find((result) => result.position.symbol === hl.symbol);
    expect(corzResult?.disposition).toBe("AMBIGUOUS");
    expect(hlResult?.disposition).toBe("EXACT");
    expect(hlResult?.confirmedCampaignId).toBe("campaign-hl");
  });
});
