import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { tradingAccount: { count: vi.fn() } },
  loadCampaigns: vi.fn(),
  resolveRelevantCampaignLegs: vi.fn(),
  tickersNeedingReviewQuotes: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: mocks.db }));
vi.mock("./workflows", () => ({ loadOpenAndAssignedCampaignsForUser: mocks.loadCampaigns }));
vi.mock("./position-review-scope", () => ({
  resolveRelevantCampaignLegs: mocks.resolveRelevantCampaignLegs,
  tickersNeedingReviewQuotes: mocks.tickersNeedingReviewQuotes,
}));

import { MAX_PROVIDER_REQUESTS_PER_MINUTE, estimateProviderCost, resetScheduledCaptureBudgetForTests, tryReserveProviderRequestBudget } from "./scheduled-capture-budget";

describe("tryReserveProviderRequestBudget", () => {
  afterEach(() => {
    resetScheduledCaptureBudgetForTests();
  });

  it("allows a reservation well under the per-minute ceiling", () => {
    expect(tryReserveProviderRequestBudget(5, new Date("2026-10-08T09:35:00Z"))).toBe(true);
  });

  it("allows reservations that together exactly reach the ceiling", () => {
    const now = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(17, now)).toBe(true);
    expect(tryReserveProviderRequestBudget(3, now)).toBe(true); // 17 + 3 = 20, exactly MAX
  });

  it("refuses a reservation that would exceed the per-minute ceiling", () => {
    const now = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(17, now)).toBe(true);
    expect(tryReserveProviderRequestBudget(5, now)).toBe(false); // 17 + 5 = 22 > 20
  });

  it("a refused reservation does not consume any of the budget", () => {
    const now = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(17, now)).toBe(true);
    expect(tryReserveProviderRequestBudget(5, now)).toBe(false);
    expect(tryReserveProviderRequestBudget(3, now)).toBe(true); // still only 17 used, 3 more fits
  });

  it("the window resets once 60 seconds have elapsed, allowing a fresh reservation", () => {
    const t0 = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(20, t0)).toBe(true); // exhausts the window
    expect(tryReserveProviderRequestBudget(1, t0)).toBe(false);

    const t1 = new Date(t0.getTime() + 60_000); // exactly 60s later
    expect(tryReserveProviderRequestBudget(20, t1)).toBe(true);
  });

  it("does not reset prematurely before 60 seconds have elapsed", () => {
    const t0 = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(20, t0)).toBe(true);
    const almostAMinuteLater = new Date(t0.getTime() + 59_000);
    expect(tryReserveProviderRequestBudget(1, almostAMinuteLater)).toBe(false);
  });

  it("Codex blocker repair (B2) - MAX_PROVIDER_REQUESTS_PER_MINUTE is a justified, raised ceiling (20), still far below any Schwab-reported entitlement", () => {
    expect(MAX_PROVIDER_REQUESTS_PER_MINUTE).toBe(20);
  });
});

describe("estimateProviderCost (Codex blocker repair B2)", () => {
  const now = new Date("2026-10-08T13:35:00Z");

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadCampaigns.mockResolvedValue([]);
    mocks.resolveRelevantCampaignLegs.mockReturnValue({ relevant: [], legByCampaignId: new Map() });
  });

  it("1 account + 5 tickers reserves accountCount + tickerCount + fixed overhead(3) + token-refresh reserve(3) = 12", async () => {
    mocks.db.tradingAccount.count.mockResolvedValue(1);
    mocks.tickersNeedingReviewQuotes.mockReturnValue(["AAPL", "MSFT", "GOOG", "AMZN", "TSLA"]);

    const cost = await estimateProviderCost("owner-1", now);
    expect(cost).toBe(12);
  });

  it("1 account + 10 tickers reserves 1 + 10 + 3 + 3 = 17 - still comfortably under the 20 ceiling", async () => {
    mocks.db.tradingAccount.count.mockResolvedValue(1);
    mocks.tickersNeedingReviewQuotes.mockReturnValue(Array.from({ length: 10 }, (_, i) => `T${i}`));

    const cost = await estimateProviderCost("owner-1", now);
    expect(cost).toBe(17);
  });

  it("zero accounts and zero tickers still reserves the fixed overhead + token-refresh reserve = 6", async () => {
    mocks.db.tradingAccount.count.mockResolvedValue(0);
    mocks.tickersNeedingReviewQuotes.mockReturnValue([]);

    const cost = await estimateProviderCost("owner-1", now);
    expect(cost).toBe(6);
  });

  it("scopes the account count query to this owner's own SCHWAB accounts only", async () => {
    mocks.db.tradingAccount.count.mockResolvedValue(2);
    mocks.tickersNeedingReviewQuotes.mockReturnValue([]);

    await estimateProviderCost("owner-42", now);
    expect(mocks.db.tradingAccount.count).toHaveBeenCalledWith({ where: { userId: "owner-42", source: "SCHWAB" } });
  });

  it("a single owner whose own estimated cost exceeds MAX_PROVIDER_REQUESTS_PER_MINUTE is never silently clamped - the real number is returned for the caller to defer on", async () => {
    mocks.db.tradingAccount.count.mockResolvedValue(3);
    mocks.tickersNeedingReviewQuotes.mockReturnValue(Array.from({ length: 20 }, (_, i) => `T${i}`));

    const cost = await estimateProviderCost("owner-1", now);
    expect(cost).toBe(3 + 20 + 3 + 3);
    expect(cost).toBeGreaterThan(MAX_PROVIDER_REQUESTS_PER_MINUTE);
  });
});
