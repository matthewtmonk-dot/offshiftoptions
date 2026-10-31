import { describe, expect, it } from "vitest";
import { getCurrentOpenCall, summarizeCampaign, type CampaignEventInput } from "./campaigns";
import {
  planCoveredCallStep,
  planShareClosureAction,
  stepTransactionIds,
  type ClosureTransaction,
  type CoveredCallStep,
} from "./shareClosureReconciliation";

// Real Schwab record shapes (Oct 2026, fake ids): equity rows carry the bare ticker and a signed quantity;
// option rows carry an OCC symbol; expiration / assignment notices have no price.
const txn = (over: Omit<Partial<ClosureTransaction>, "occurredAt"> & { id: string; action: string; occurredAt: string }): ClosureTransaction => ({
  symbol: null,
  underlyingSymbol: null,
  quantity: null,
  price: null,
  fees: null,
  ...over,
  occurredAt: new Date(`${over.occurredAt}T15:00:00Z`),
});
const call = (expiry: string, strike = "00014000") => `PATH  ${expiry}C${strike}`;

type SimCampaign = { id: string; ticker: string; status: "ASSIGNED" | "CLOSED"; events: CampaignEventInput[] };

function ev(id: string, type: CampaignEventInput["type"], occurredAt: string, extra: Partial<CampaignEventInput> = {}): CampaignEventInput {
  return { id, type, occurredAt: new Date(`${occurredAt}T00:00:00Z`), sortOrder: 0, ...extra };
}

/** Applies a planned step the way the database layer does, so whole backlogs can be replayed in memory. */
function apply(campaign: SimCampaign, step: CoveredCallStep) {
  const next = campaign.events.length;
  const openCall = getCurrentOpenCall(campaign.events);
  const at = (day: string) => new Date(`${day}T00:00:00Z`);
  switch (step.kind) {
    case "CLOSE_CALL":
      campaign.events.push(ev(`c${next}`, "CLOSE_COVERED_CALL", step.occurredOn, { sortOrder: next, optionType: "CALL", contracts: openCall!.contracts, strike: openCall!.strike, expiration: openCall!.expiration, premium: step.premium, fees: step.fees }));
      break;
    case "OPEN_CALL":
      campaign.events.push(ev(`c${next}`, "SELL_COVERED_CALL", step.occurredOn, { sortOrder: next, optionType: "CALL", contracts: step.contracts, strike: step.strike, expiration: at(step.expiration), premium: step.premium, fees: step.fees }));
      break;
    case "EXPIRE_CALL":
      campaign.events.push(ev(`c${next}`, "COVERED_CALL_EXPIRED", step.occurredOn, { sortOrder: next, optionType: "CALL", contracts: openCall!.contracts, strike: openCall!.strike, expiration: openCall!.expiration, premium: 0 }));
      break;
    case "CALLED_AWAY":
      campaign.events.push(ev(`c${next}`, "COVERED_CALL_EXPIRED", step.assignedOn, { sortOrder: next, optionType: "CALL", contracts: openCall!.contracts, strike: openCall!.strike, expiration: openCall!.expiration, premium: 0, fees: step.assignmentFees }));
      campaign.events.push(ev(`c${next + 1}`, "STOCK_SALE", step.soldOn, { sortOrder: next + 1, shares: step.shares, underlyingPrice: step.price, fees: step.saleFees }));
      campaign.status = "CLOSED";
      break;
    case "SELL_SHARES":
      campaign.events.push(ev(`c${next}`, "STOCK_SALE", step.soldOn, { sortOrder: next, shares: step.shares, underlyingPrice: step.price, fees: step.fees }));
      if (summarizeCampaign({ status: "ASSIGNED", events: campaign.events }).sharesHeld === 0) campaign.status = "CLOSED";
      break;
    case "LINK_DELIVERY":
      break;
  }
}

function replay(campaigns: SimCampaign[], transactions: ClosureTransaction[], asOf = new Date("2026-10-31T16:00:00Z")) {
  let remaining = [...transactions];
  const steps: CoveredCallStep[] = [];
  for (let pass = 0; pass < 30; pass += 1) {
    const live = campaigns.filter((c) => c.status === "ASSIGNED");
    const step = planCoveredCallStep({ campaigns: live, candidates: remaining, asOf });
    if (!step) break;
    apply(campaigns.find((c) => c.id === step.campaignId)!, step);
    const used = new Set(stepTransactionIds(step));
    remaining = remaining.filter((t) => !used.has(t.id));
    steps.push(step);
  }
  return { steps, remaining };
}

describe("PATH: weekly covered calls ending in a call assignment and the stock called away", () => {
  const pathCampaign = (): SimCampaign => ({
    id: "path",
    ticker: "PATH",
    status: "ASSIGNED",
    events: [
      ev("e1", "SELL_PUT", "2026-09-14", { sortOrder: 0, optionType: "PUT", contracts: 1, strike: 14, expiration: new Date("2026-09-18T00:00:00Z"), premium: 0.25 }),
      ev("e2", "ROLL_PUT_CLOSE", "2026-09-18", { sortOrder: 1, optionType: "PUT", contracts: 1, strike: 14, expiration: new Date("2026-09-18T00:00:00Z"), premium: 0.46 }),
      ev("e3", "ROLL_PUT_OPEN", "2026-09-18", { sortOrder: 2, optionType: "PUT", contracts: 1, strike: 14, expiration: new Date("2026-09-25T00:00:00Z"), premium: 0.7 }),
      ev("e4", "ASSIGNMENT", "2026-09-25", { sortOrder: 3, optionType: "PUT", contracts: 1, shares: 100, strike: 14 }),
      // The Oct 2 covered call (expires Oct 9) was linked by an earlier sync and then never marked expired.
      ev("e5", "SELL_COVERED_CALL", "2026-10-02", { sortOrder: 4, optionType: "CALL", contracts: 1, strike: 14, expiration: new Date("2026-10-09T00:00:00Z"), premium: 0.12 }),
    ],
  });

  const unlinked = () => [
    txn({ id: "deliver", action: "Buy to Open", symbol: "PATH", underlyingSymbol: "PATH", quantity: 100, price: 14, occurredAt: "2026-09-25" }),
    txn({ id: "exp1", action: "Removed - Expiration", symbol: call("261009"), underlyingSymbol: "PATH", quantity: 1, occurredAt: "2026-10-09" }),
    txn({ id: "sto1", action: "Sell to Open", symbol: call("261016"), underlyingSymbol: "PATH", quantity: -1, price: 0.08, fees: 0.66, occurredAt: "2026-10-12" }),
    txn({ id: "btc1", action: "Buy to Close", symbol: call("261016"), underlyingSymbol: "PATH", quantity: 1, price: 0.02, fees: 0.01, occurredAt: "2026-10-15" }),
    txn({ id: "sto2", action: "Sell to Open", symbol: call("261023"), underlyingSymbol: "PATH", quantity: -1, price: 0.22, fees: 0.66, occurredAt: "2026-10-15" }),
    txn({ id: "assign", action: "Assignment", symbol: call("261023"), underlyingSymbol: "PATH", quantity: 1, occurredAt: "2026-10-23" }),
    txn({ id: "sale", action: "Sell to Close", symbol: "PATH", underlyingSymbol: "PATH", quantity: -100, price: 14, fees: 0.03, occurredAt: "2026-10-23" }),
  ];

  it("walks the whole backlog in order and ends with the campaign closed, shares called away, no stray records", () => {
    const campaigns = [pathCampaign()];
    const { steps, remaining } = replay(campaigns, unlinked());

    expect(steps.map((s) => s.kind)).toEqual(["LINK_DELIVERY", "EXPIRE_CALL", "OPEN_CALL", "CLOSE_CALL", "OPEN_CALL", "CALLED_AWAY"]);
    expect(remaining).toEqual([]);
    const [campaign] = campaigns;
    expect(campaign.status).toBe("CLOSED");
    const summary = summarizeCampaign({ status: "CLOSED", events: campaign.events });
    expect(summary.sharesHeld).toBe(0);
    expect(getCurrentOpenCall(campaign.events)).toBeNull();
    // premiums .25+.70+.12+.08+.22 = 137, debits .46+.02 = 48, stock bought and sold at 14, fees .66+.01+.66+.03
    expect(summary.stockProceeds).toBe(1400);
    expect(summary.stockCost).toBe(1400);
    expect(summary.realizedPL).toBeCloseTo(89 - (0.66 + 0.01 + 0.66 + 0.03), 2);
  });

  it("the Oct 9 call is closed out as expired on its real expiration date, which is what frees the next call to attach", () => {
    const first = planCoveredCallStep({ campaigns: [pathCampaign()], candidates: unlinked().filter((t) => t.id !== "deliver"), asOf: new Date("2026-10-31T16:00:00Z") });
    expect(first).toMatchObject({ campaignId: "path", kind: "EXPIRE_CALL", transactionId: "exp1", occurredOn: "2026-10-09" });
  });

  it("waits (no guess) when the call was assigned but the stock sale has not synced yet", () => {
    const campaign = pathCampaign();
    const { steps } = replay([campaign], unlinked().filter((t) => t.id !== "sale"));
    expect(steps.at(-1)?.kind).toBe("OPEN_CALL");
    expect(campaign.status).toBe("ASSIGNED");
    expect(getCurrentOpenCall(campaign.events)).not.toBeNull();
  });

  it("does not treat a sale at the wrong price, the wrong size, or far from the assignment date as the called-away shares", () => {
    for (const bad of [{ price: 14.5 }, { quantity: -50 }, { occurredAt: "2026-12-01" }]) {
      const campaign = pathCampaign();
      const records = unlinked().map((t) => (t.id === "sale" ? txn({ id: "sale", action: "Sell to Close", symbol: "PATH", underlyingSymbol: "PATH", quantity: -100, price: 14, occurredAt: "2026-10-23", ...bad }) : t));
      replay([campaign], records);
      expect(campaign.status).toBe("ASSIGNED");
    }
  });

  it("never acts when Schwab shows both an assignment and an expiration for the same call", () => {
    const campaign = pathCampaign();
    campaign.events.push(ev("e6", "SELL_COVERED_CALL", "2026-10-15", { sortOrder: 5, optionType: "CALL", contracts: 1, strike: 14, expiration: new Date("2026-10-23T00:00:00Z"), premium: 0.22 }));
    campaign.events.splice(4, 1); // drop the stale Oct 9 call for this case
    const both = [
      txn({ id: "assign", action: "Assignment", symbol: call("261023"), quantity: 1, occurredAt: "2026-10-23" }),
      txn({ id: "expired", action: "Removed - Expiration", symbol: call("261023"), quantity: 1, occurredAt: "2026-10-23" }),
      txn({ id: "sale", action: "Sell to Close", symbol: "PATH", quantity: -100, price: 14, occurredAt: "2026-10-23" }),
    ];
    expect(planShareClosureAction({ campaign, assignedPeers: [{ id: "path", ticker: "PATH" }], candidates: both, asOf: new Date("2026-10-31T16:00:00Z") })).toBeNull();
  });

  it("does not touch a call that has not reached its expiration yet", () => {
    const campaign = pathCampaign();
    const plan = planShareClosureAction({
      campaign,
      assignedPeers: [{ id: "path", ticker: "PATH" }],
      candidates: [txn({ id: "exp1", action: "Removed - Expiration", symbol: call("261009"), quantity: 1, occurredAt: "2026-10-09" })],
      asOf: new Date("2026-10-09T16:00:00Z"), // expiration day itself is not past yet
    });
    expect(plan).toBeNull();
  });

  it("refuses to guess when two assigned campaigns hold the same ticker", () => {
    const first = pathCampaign();
    const second = { ...pathCampaign(), id: "path2" };
    const { steps } = replay([first, second], unlinked());
    expect(steps.filter((s) => ["EXPIRE_CALL", "CALLED_AWAY", "SELL_SHARES", "LINK_DELIVERY"].includes(s.kind))).toEqual([]);
  });

  it("an opening dated before the campaign's own assignment is never attached to it", () => {
    const campaign: SimCampaign = { id: "path", ticker: "PATH", status: "ASSIGNED", events: [ev("a", "ASSIGNMENT", "2026-09-25", { sortOrder: 0, optionType: "PUT", contracts: 1, shares: 100, strike: 14 })] };
    const early = txn({ id: "early", action: "Sell to Open", symbol: call("260918"), quantity: -1, price: 0.1, occurredAt: "2026-09-10" });
    expect(planCoveredCallStep({ campaigns: [campaign], candidates: [early], asOf: new Date("2026-10-31T16:00:00Z") })).toBeNull();
  });
});

describe("SOFI: the assigned shares were sold in a plain stock sale", () => {
  const sofi = (): SimCampaign => ({
    id: "sofi",
    ticker: "SOFI",
    status: "ASSIGNED",
    events: [
      ev("s1", "SELL_PUT", "2026-10-16", { sortOrder: 0, optionType: "PUT", contracts: 1, strike: 15, expiration: new Date("2026-10-23T00:00:00Z"), premium: 0.14 }),
      ev("s2", "ASSIGNMENT", "2026-10-23", { sortOrder: 1, optionType: "PUT", contracts: 1, shares: 100, strike: 15 }),
    ],
  });
  const records = () => [
    txn({ id: "deliver", action: "Buy to Open", symbol: "SOFI", underlyingSymbol: "SOFI", quantity: 100, price: 15, occurredAt: "2026-10-23" }),
    txn({ id: "sale", action: "Sell to Close", symbol: "SOFI", underlyingSymbol: "SOFI", quantity: -100, price: 16.975, fees: 0.03, occurredAt: "2026-10-30" }),
  ];

  it("links the assignment delivery record, then closes the campaign with the real sale proceeds", () => {
    const campaigns = [sofi()];
    const { steps, remaining } = replay(campaigns, records());
    expect(steps.map((s) => s.kind)).toEqual(["LINK_DELIVERY", "SELL_SHARES"]);
    expect(remaining).toEqual([]);
    expect(campaigns[0].status).toBe("CLOSED");
    const summary = summarizeCampaign({ status: "CLOSED", events: campaigns[0].events });
    expect(summary.stockProceeds).toBe(1697.5);
    expect(summary.stockCost).toBe(1500);
    expect(summary.sharesHeld).toBe(0);
    // 14 premium + 197.50 stock gain - 0.03 fee
    expect(summary.realizedPL).toBeCloseTo(14 + 197.5 - 0.03, 2);
  });

  it("leaves a partial sale for manual entry (other lots could exist) and a sale dated before the assignment alone", () => {
    for (const bad of [{ quantity: -50 }, { occurredAt: "2026-10-01" }]) {
      const campaign = sofi();
      replay([campaign], [records()[0], { ...records()[1], ...bad, occurredAt: bad.occurredAt ? new Date(`${bad.occurredAt}T15:00:00Z`) : records()[1].occurredAt }]);
      expect(campaign.status).toBe("ASSIGNED");
    }
  });

  it("does not link a share-purchase record that does not match the assignment (price or size)", () => {
    const campaign = sofi();
    const step = planShareClosureAction({
      campaign,
      assignedPeers: [{ id: "sofi", ticker: "SOFI" }],
      candidates: [txn({ id: "other", action: "Buy to Open", symbol: "SOFI", quantity: 100, price: 16.2, occurredAt: "2026-10-23" })],
      asOf: new Date("2026-10-31T16:00:00Z"),
    });
    expect(step).toBeNull();
  });

  it("a different ticker's sale is never attributed to this campaign", () => {
    const campaign = sofi();
    const step = planShareClosureAction({
      campaign,
      assignedPeers: [{ id: "sofi", ticker: "SOFI" }],
      candidates: [txn({ id: "x", action: "Sell to Close", symbol: "HOOD", underlyingSymbol: "HOOD", quantity: -100, price: 16.975, occurredAt: "2026-10-30" })],
      asOf: new Date("2026-10-31T16:00:00Z"),
    });
    expect(step).toBeNull();
  });
});

describe("a covered call that simply expires worthless leaves the shares held and the campaign open", () => {
  it("expires the call only; selling the call again later still works", () => {
    const campaign: SimCampaign = {
      id: "corz",
      ticker: "CORZ",
      status: "ASSIGNED",
      events: [
        ev("a", "ASSIGNMENT", "2026-10-23", { sortOrder: 0, optionType: "PUT", contracts: 1, shares: 100, strike: 14.5 }),
        ev("c", "SELL_COVERED_CALL", "2026-10-26", { sortOrder: 1, optionType: "CALL", contracts: 1, strike: 14.5, expiration: new Date("2026-10-30T00:00:00Z"), premium: 0.2 }),
      ],
    };
    const { steps } = replay([campaign], [txn({ id: "x", action: "Removed - Expiration", symbol: "CORZ  261030C00014500", quantity: 1, occurredAt: "2026-10-30" })]);
    expect(steps.map((s) => s.kind)).toEqual(["EXPIRE_CALL"]);
    expect(campaign.status).toBe("ASSIGNED");
    expect(summarizeCampaign({ status: "ASSIGNED", events: campaign.events }).sharesHeld).toBe(100);
    expect(getCurrentOpenCall(campaign.events)).toBeNull();
  });
});
