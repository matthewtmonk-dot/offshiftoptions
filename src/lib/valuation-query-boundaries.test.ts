import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchDashboardPositions } from "@/domain/finance/trackerPositionMatch";
import { summarizeCspSecuredCapital } from "@/domain/finance/brokerPositions";

const db = vi.hoisted(() => ({
  brokerRecord: { findMany: vi.fn() },
  campaign: { findMany: vi.fn() },
  tradingAccount: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  userSettings: { findUnique: vi.fn() },
  optionContractSnapshot: { findMany: vi.fn() },
}));
vi.mock("./prisma", () => ({ prisma: db }));
vi.mock("./workflows", () => ({ createCampaignForUser: vi.fn() }));
import { brokerPositionLinkKey, getLinkedCampaignIdsBySymbolForUser } from "./broker-reconciliation";
import { getTrackerPageData } from "./app-data";

const account = { id: "internal-A", userId: "matt", externalAccountId: "external-A" };
const campaign = { id: "campaign-A", ownerId: "matt", accountId: account.id, ticker: "RIOT", status: "OPEN", events: [
  { type: "SELL_PUT", occurredAt: new Date("2026-09-01"), strike: 20, expiration: new Date("2026-10-16"), contracts: 1, premium: 1 },
] };
const position = { accountId: account.externalAccountId, symbol: "RIOT 261016P00020000", quantity: -1, marketValue: -100 };
const linked = { accountId: account.id, symbol: position.symbol, account, linkedCampaign: campaign };

beforeEach(() => {
  vi.clearAllMocks();
  db.brokerRecord.findMany.mockResolvedValue([linked]);
  db.campaign.findMany.mockResolvedValue([]);
  db.tradingAccount.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  db.userSettings.findUnique.mockResolvedValue(null);
  db.optionContractSnapshot.findMany.mockResolvedValue([]);
});

describe("owner and account valuation query boundaries", () => {
  it.each(["mine", "buddy", "both"] as const)("Performance remains owner-scoped under the %s display scope", async (scope) => {
    await getTrackerPageData("eric", scope, { includeLegacyTrades: false });
    const performanceQuery = db.campaign.findMany.mock.calls.map(([query]) => query).find((query) => query.include?.linkedBrokerRecords);
    expect(performanceQuery.where).toEqual({ ownerId: "eric" });
    expect(performanceQuery.include.linkedBrokerRecords.where).toEqual({ userId: "eric", provider: "SCHWAB", kind: "POSITION", status: "CONFIRMED" });
  });
  it("same contract in two accounts contributes collateral exactly once per account", async () => {
    const otherPosition = { ...position, accountId: "external-B" };
    const positions = [position, otherPosition];
    const links = await getLinkedCampaignIdsBySymbolForUser("matt", positions);
    expect(links.get(brokerPositionLinkKey(position.accountId, position.symbol)!)).toBe(campaign.id);
    expect(links.has(brokerPositionLinkKey(otherPosition.accountId, otherPosition.symbol)!)).toBe(false);
    const matches = matchDashboardPositions("matt", positions.map((p) => ({ ...p, linkedCampaignId: links.get(brokerPositionLinkKey(p.accountId, p.symbol)!) ?? null })),
      [account, { id: "internal-B", userId: "matt", externalAccountId: "external-B" }],
      [{ ...campaign, strike: 20, expiration: new Date("2026-10-16"), contracts: 1 }]);
    expect(matches.map((m) => m.disposition)).toEqual(["LINKED", "NONE"]);
    const additive = matches.filter((m) => m.disposition === "NONE" || m.disposition === "AMBIGUOUS").map((m) => m.position);
    expect(2000 + summarizeCspSecuredCapital(additive).total).toBe(4000);
  });
  it("the link query scopes both account and campaign ownership, and rejects another owner's returned record", async () => {
    const links = await getLinkedCampaignIdsBySymbolForUser("eric", [position]);
    const query = db.brokerRecord.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({ userId: "eric", account: { userId: "eric" }, linkedCampaign: { ownerId: "eric", status: "OPEN" } });
    expect(links.size).toBe(0);
  });
  it("an old link with changed quantity or a closed obligation does not remove exposure", async () => {
    expect((await getLinkedCampaignIdsBySymbolForUser("matt", [{ ...position, quantity: -2 }])).size).toBe(0);
    db.brokerRecord.findMany.mockResolvedValue([{ ...linked, linkedCampaign: { ...campaign, status: "CLOSED" } }]);
    expect((await getLinkedCampaignIdsBySymbolForUser("matt", [position])).size).toBe(0);
  });
  it("even a bad preexisting cross-account link cannot override Dashboard's exact obligation check", () => {
    const matches = matchDashboardPositions("matt", [{ ...position, accountId: "external-B", linkedCampaignId: campaign.id }],
      [account, { id: "internal-B", userId: "matt", externalAccountId: "external-B" }],
      [{ ...campaign, strike: 20, expiration: new Date("2026-10-16"), contracts: 1 }]);
    expect(matches[0].disposition).toBe("NONE");
  });
});
