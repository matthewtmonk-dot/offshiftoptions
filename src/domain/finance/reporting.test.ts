import { describe, expect, it } from "vitest";
import { friendlyReportingReason, summarizeAccountReporting, type AccountReportingInput } from "./reporting";
import type { AccountBrokerRecordInput, AccountPerformanceInput } from "./accountLedger";
import type { CompletedCampaignResult } from "./performance";
import type { CampaignExposureInput } from "./brokerPositions";

// Reporting Phase, Ticket 1: this module is a thin, non-reimplementing wrapper over
// accountLedger.ts/performance.ts/brokerPositions.ts, so most tests here exist to prove the
// WIRING is correct (the right authoritative function feeds the right reporting field) rather
// than to re-prove accounting math those modules' own test suites already cover exhaustively.

function brokerRecord(input: Partial<AccountBrokerRecordInput> & { action: string | null; amount: number; occurredAt: string }): AccountBrokerRecordInput {
  return {
    id: input.id ?? `${input.action ?? "unknown"}-${input.occurredAt}-${input.amount}`,
    fingerprint: input.fingerprint ?? `${input.action ?? "unknown"}-${input.occurredAt}-${input.amount}`,
    kind: "TRANSACTION",
    status: "CONFIRMED",
    description: input.description ?? input.action,
    ...input,
  };
}

function completed(overrides: Partial<CompletedCampaignResult> & Pick<CompletedCampaignResult, "campaignId" | "closedAt" | "finalResult" | "pl">): CompletedCampaignResult {
  return { daysActive: 7, ...overrides };
}

function exposureRow(overrides: Partial<CampaignExposureInput> = {}): CampaignExposureInput {
  return { status: "OPEN", currentCollateralCommitted: null, remainingShareBasis: null, hasOpenCoveredCall: false, ...overrides };
}

function reportFor(input: Partial<AccountReportingInput> & { accounts: AccountPerformanceInput[] }) {
  return summarizeAccountReporting(input);
}

describe("Section 1: Account Value", () => {
  it("1. a valid current account snapshot makes currentAccountValue available", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_300, cash: 3_000 },
          ],
        },
      ],
    });

    expect(report.currentAccountValue).toBe(10_300);
    expect(report.currentAccountValueSource).toBe("SCHWAB");
    expect(report.currentAccountValueAsOf).toEqual(new Date("2026-09-10T12:00:00Z"));
  });

  it("2. no supported account valuation leaves currentAccountValue unavailable", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 }],
          fallbackTradingPL: 500, // trading activity exists, but there is no broker snapshot at all
          asOf: new Date("2026-09-20T00:00:00Z"),
        },
      ],
    });

    expect(report.currentAccountValue).toBeNull();
    expect(report.currentAccountValueAsOf).toBeNull();
    expect(report.currentAccountValueSource).toBeNull();
  });

  it("3. trading P/L never alters the raw account value once a valid snapshot exists", () => {
    const withoutTrading = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_050, cash: 10_050 },
          ],
        },
      ],
    });
    const withTrading = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_050, cash: 10_050 },
          ],
          brokerRecords: [brokerRecord({ action: "Sell to Open", amount: 75, occurredAt: "2026-09-05" })],
        },
      ],
    });

    expect(withTrading.currentAccountValue).toBe(withoutTrading.currentAccountValue);
    expect(withTrading.currentAccountValue).toBe(10_050); // never 10,050 + 75
  });
});

describe("Section 2: Confirmed Trading P/L", () => {
  it("4. confirmed closed campaign P/L is included in the total", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [
        completed({ campaignId: "c1", closedAt: new Date("2026-08-01"), finalResult: "GAIN", pl: 40 }),
        completed({ campaignId: "c2", closedAt: new Date("2026-08-15"), finalResult: "LOSS", pl: -10 }),
      ],
    });

    expect(report.confirmedTradingPL).toBe(30);
    expect(report.confirmedTradingPLPeriod).toBe("ALL_TIME");
    expect(report.confirmedTradingPLComplete).toBe(true);
  });

  it("5. a pending or incomplete campaign is never silently counted as confirmed", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [
        completed({ campaignId: "confirmed", closedAt: new Date("2026-08-01"), finalResult: "GAIN", pl: 40 }),
        completed({ campaignId: "pending-fee", closedAt: new Date("2026-08-02"), finalResult: "GAIN", pl: 20, feesFullyKnown: false }),
        completed({ campaignId: "incomplete", closedAt: new Date("2026-08-03"), finalResult: "UNKNOWN", pl: null }),
      ],
    });

    // Only the confirmed campaign's $40 counts - the pending $20 and the unknown result never
    // silently inflate (or shrink) this total.
    expect(report.confirmedTradingPL).toBe(40);
    expect(report.confirmedTradingPLComplete).toBe(false);
    expect(report.confirmedTradingPLPendingCount).toBe(1);
    expect(report.confirmedTradingPLIncompleteCount).toBe(1);
  });

  it("6 & 7. confirmed trading P/L only ever reflects closed campaigns - open exposure/projections never feed it", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [],
      // Open positions and their secured capital are supplied here, but this input has no concept
      // of projected OTM value or current mark-to-market at all - confirmedTradingPL structurally
      // cannot see them, since it is derived entirely from `completedCampaigns`.
      openExposure: [exposureRow({ status: "OPEN", currentCollateralCommitted: 5_000 })],
    });

    expect(report.confirmedTradingPL).toBe(0);
    expect(report.confirmedTradingPLComplete).toBe(true);
  });
});

describe("Section 3: Trade Return", () => {
  const asOf = new Date("2026-09-05T13:00:00Z"); // Saturday, in the week of 2026-08-31 - 2026-09-06

  it("8. valid campaigns closed this week produce the existing authoritative return on secured capital", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [
        completed({ campaignId: "APLD", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 28, collateralCommitted: 2_350 }),
        completed({ campaignId: "CORZ", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 68, collateralCommitted: 1_650 }),
      ],
      asOf,
    });

    expect(report.tradeReturnPeriod).toBe("THIS_WEEK");
    expect(report.tradeReturnStatus).toBe("OK");
    expect(report.tradeReturnPercent).toBeCloseTo(2.4, 1); // 96 / 4000
    expect(report.tradeReturnGrossPercent).toBeCloseTo(2.4, 1);
    expect(report.tradeReturnMessage).toBeNull();
    expect(report.tradeReturnBasis.toLowerCase()).toContain("secured");
  });

  it("9. an unresolved fee preserves PENDING_FEE_EVIDENCE status and a gross-only figure", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [
        completed({ campaignId: "CORZ", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 68, collateralCommitted: 1_650, feesFullyKnown: false }),
      ],
      asOf,
    });

    expect(report.tradeReturnStatus).toBe("PENDING_FEE_EVIDENCE");
    expect(report.tradeReturnPercent).toBeNull();
    expect(report.tradeReturnGrossPercent).not.toBeNull();
    expect(report.tradeReturnMessage).toMatch(/pending/i);
  });

  it("10. a campaign that has not closed this week never contributes to the weekly trade return", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [],
      openExposure: [exposureRow({ status: "OPEN", currentCollateralCommitted: 3_000 })],
      asOf,
    });

    expect(report.tradeReturnStatus).toBe("NO_CLOSED_CAMPAIGNS");
    expect(report.tradeReturnPercent).toBeNull();
    expect(report.tradeReturnMessage).toMatch(/no campaigns/i);
  });

  it("11. reporting v1 never invents an all-time blended trade-return figure", () => {
    const report = reportFor({ accounts: [{ ledgerEntries: [] }], completedCampaigns: [], asOf });
    // The only period this ticket's math is proven safe for is THIS_WEEK - the type system itself
    // enforces there is no competing "all-time" trade-return field on this summary.
    expect(report.tradeReturnPeriod).toBe("THIS_WEEK");
    expect(Object.keys(report).some((key) => /allTime.*[Tt]rade[Rr]eturn|tradeReturn.*AllTime/.test(key))).toBe(false);
  });
});

describe("Section 4: Current Capital Utilization", () => {
  it("12. utilization is committed capital divided by a valid current account value", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 5_000 },
          ],
        },
      ],
      openExposure: [exposureRow({ status: "OPEN", currentCollateralCommitted: 2_500 })],
    });

    expect(report.currentCapitalCommitted).toBe(2_500);
    expect(report.currentCapitalUtilizationPercent).toBeCloseTo(25, 4);
    expect(report.capitalUtilizationStatus).toBe("OK");
  });

  it("13. more idle cash (same committed capital) lowers utilization", () => {
    const secured = exposureRow({ status: "OPEN", currentCollateralCommitted: 2_500 });
    const smallerAccount = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 5_000 },
          ],
        },
      ],
      openExposure: [secured],
    });
    const largerAccount = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 20_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 20_000, cash: 15_000 },
          ],
        },
      ],
      openExposure: [secured],
    });

    expect(largerAccount.currentCapitalUtilizationPercent).toBeLessThan(smallerAccount.currentCapitalUtilizationPercent!);
  });

  it("14. zero committed capital reports 0% when the denominator is valid, never unavailable", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 10_000 },
          ],
        },
      ],
      openExposure: [],
    });

    expect(report.currentCapitalUtilizationPercent).toBe(0);
    expect(report.capitalUtilizationStatus).toBe("OK");
  });

  it("15. no valid current account value leaves utilization unavailable, never guessed", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }] }],
      openExposure: [exposureRow({ status: "OPEN", currentCollateralCommitted: 2_500 })],
    });

    expect(report.capitalUtilizationStatus).toBe("NO_ACCOUNT_VALUE");
    expect(report.currentCapitalCommitted).toBeNull();
    expect(report.currentCapitalUtilizationPercent).toBeNull();
    expect(report.capitalUtilizationMessage).not.toBeNull();
  });

  it("16. a CLOSED campaign's historical collateral is excluded from current utilization", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 10_000 },
          ],
        },
      ],
      openExposure: [exposureRow({ status: "CLOSED", currentCollateralCommitted: 4_000 })],
    });

    expect(report.currentCapitalCommitted).toBe(0);
  });

  it("17. a rolled campaign's collateral counts once, from its currently-open leg only", () => {
    // summarizeCampaign (campaigns.ts) already resolves currentCollateralCommitted to the leg
    // actually open right now after a roll - this proves the reporting layer sums that resolved
    // value as-is, rather than re-deriving (and risking double-counting) old and new legs itself.
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 10_000 },
          ],
        },
      ],
      openExposure: [exposureRow({ status: "OPEN", currentCollateralCommitted: 1_800 })], // the post-roll leg's own value
    });

    expect(report.currentCapitalCommitted).toBe(1_800);
  });

  it("18. an assigned/stock-holding campaign is never represented as an active CSP, but still counts as committed capital", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 10_000 },
          ],
        },
      ],
      openExposure: [exposureRow({ status: "ASSIGNED", currentCollateralCommitted: null, remainingShareBasis: 3_000 })],
    });

    expect(report.currentCapitalCommittedSecuredPut).toBe(0); // never counted as an active put
    expect(report.currentCapitalCommittedAssignedShares).toBe(3_000);
    expect(report.currentCapitalCommitted).toBe(3_000); // still capital at work, correctly labeled
  });
});

describe("Section 5 & 6: Whole-Account Gain and Return %", () => {
  it("19. complete, supported accounting surfaces a confirmed gain", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_300, cash: 10_300 },
          ],
          brokerTransactionCoverageStatus: "COMPLETE",
        },
      ],
    });

    expect(report.wholeAccountGain).toBe(300);
    expect(report.wholeAccountGainStatus).toBe("OK");
    expect(report.wholeAccountGainUnavailableReason).toBeNull();
    expect(report.wholeAccountReturnPercent).toBeCloseTo(3, 4);
    expect(report.wholeAccountReturnStatus).toBe("OK");
  });

  it("20 & 21. no supported ending valuation leaves whole-account gain unavailable with a NO_CURRENT_VALUE reason", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-08-01T00:00:00Z", accountValue: 9_000, cash: 9_000 }, // before the baseline - invalid
          ],
        },
      ],
    });

    expect(report.wholeAccountGain).toBeNull();
    expect(report.wholeAccountGainStatus).toBe("UNAVAILABLE");
    expect(report.wholeAccountGainUnavailableReason).toBe("NO_CURRENT_VALUE");
    expect(report.wholeAccountGainUnavailableMessage).not.toBeNull();
  });

  it("22. mixed funding sources leave whole-account gain unavailable with an INCOMPLETE_MIXED_SOURCES reason", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 500 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 12_800, cash: 12_800 },
          ],
          brokerRecords: [brokerRecord({ action: "MoneyLink Transfer", amount: 2_000, occurredAt: "2026-08-01" })],
        },
      ],
    });

    expect(report.wholeAccountGain).toBeNull();
    expect(report.wholeAccountGainUnavailableReason).toBe("INCOMPLETE_MIXED_SOURCES");
    expect(report.fundingCoverageStatus).toBe("INCOMPLETE_MIXED_SOURCES");
  });

  it("23. an inferred/provisional baseline leaves whole-account gain unavailable with an INCOMPLETE_INFERRED_BASELINE reason", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_123.77, cash: 10_123.77 }],
          brokerRecords: [brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" })],
        },
      ],
    });

    expect(report.wholeAccountGain).toBeNull();
    expect(report.wholeAccountGainUnavailableReason).toBe("INCOMPLETE_INFERRED_BASELINE");
  });

  it("24. a contribution-present period still surfaces a dollar gain but withholds percentage return", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 2_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 12_100, cash: 12_100 },
          ],
          brokerTransactionCoverageStatus: "COMPLETE",
        },
      ],
    });

    expect(report.wholeAccountGain).toBe(100);
    expect(report.wholeAccountGainStatus).toBe("OK");
    expect(report.wholeAccountReturnPercent).toBeNull();
    expect(report.wholeAccountReturnStatus).toBe("CONTRIBUTIONS_NEED_ADVANCED_RETURN");
    expect(report.wholeAccountReturnMessage).toMatch(/money moved/i);
  });

  it("25. the raw account value still displays even when whole-account gain is unavailable", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_123.77, cash: 10_123.77 }],
          brokerRecords: [brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" })],
        },
      ],
    });

    expect(report.wholeAccountGain).toBeNull();
    expect(report.currentAccountValue).toBe(10_123.77);
    expect(report.currentAccountValueSource).toBe("SCHWAB");
  });
});

describe("Section 7: Friendly Availability Reasons", () => {
  it("26. important internal statuses map to stable, specific user-facing sentences", () => {
    expect(friendlyReportingReason("NO_BASELINE")).toBe("Set a starting account value to measure account performance.");
    expect(friendlyReportingReason("NO_CURRENT_VALUE")).toBe("An ending account value is not available for this period.");
    expect(friendlyReportingReason("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY")).toBe(
      "Schwab funding history has not been fully verified for this period.",
    );
    expect(friendlyReportingReason("INCOMPLETE_MIXED_SOURCES")).toBe(
      "Funding history needs review before account performance can be calculated.",
    );
    expect(friendlyReportingReason("CONTRIBUTIONS_NEED_ADVANCED_RETURN")).toBe(
      "Percentage return is not available yet because money moved into or out of the account during this period.",
    );
    expect(friendlyReportingReason("OK")).toBeNull();
    expect(friendlyReportingReason(null)).toBeNull();
  });

  it("27. raw internal enum names are never used as the display copy itself", () => {
    const codes = [
      "NO_BASELINE",
      "NO_CURRENT_VALUE",
      "INCOMPLETE_MIXED_SOURCES",
      "INCOMPLETE_INFERRED_BASELINE",
      "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY",
      "CONTRIBUTIONS_NEED_ADVANCED_RETURN",
      "NO_CLOSED_CAMPAIGNS",
      "INCOMPLETE_RESULT_EVIDENCE",
      "INCOMPLETE_CAPITAL_EVIDENCE",
      "PENDING_FEE_EVIDENCE",
      "NO_SECURED_CAPITAL",
      "NO_ACCOUNT_VALUE",
      "UNKNOWN_EXPOSURE",
    ] as const;
    for (const code of codes) {
      const message = friendlyReportingReason(code);
      expect(message).not.toBeNull();
      expect(message).not.toBe(code);
      expect(message).not.toMatch(/^[A-Z_]+$/); // never a bare SCREAMING_SNAKE_CASE code
    }
  });

  it("33. fees, incomplete results, incomplete collateral, and unknown exposure each get their own distinct, truthful message", () => {
    const feeMessage = friendlyReportingReason("PENDING_FEE_EVIDENCE")!;
    const incompleteResultMessage = friendlyReportingReason("INCOMPLETE_RESULT_EVIDENCE")!;
    const incompleteCapitalMessage = friendlyReportingReason("INCOMPLETE_CAPITAL_EVIDENCE")!;
    const unknownExposureMessage = friendlyReportingReason("UNKNOWN_EXPOSURE")!;

    const messages = [feeMessage, incompleteResultMessage, incompleteCapitalMessage, unknownExposureMessage];
    expect(new Set(messages).size).toBe(messages.length); // all four are distinct sentences

    expect(feeMessage).toMatch(/fee/i);
    expect(incompleteResultMessage).not.toMatch(/fee/i);
    expect(incompleteCapitalMessage).not.toMatch(/fee/i);
    expect(unknownExposureMessage).toBe("Some current position exposure could not be verified.");
  });
});

describe("Section 9: Multi-account / owner behavior", () => {
  it("28. two separate single-owner calls never leak state into one another", () => {
    const first = reportFor({
      accounts: [{ ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }] }],
    });
    const second = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 5_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 5_500, cash: 5_500 },
          ],
        },
      ],
    });

    expect(first.currentAccountValue).toBeNull();
    expect(second.currentAccountValue).toBe(5_500); // unaffected by the first, unrelated call
  });

  it("29. one account's incomplete funding coverage withholds the combined aggregate gain, not just its own", () => {
    const report = reportFor({
      accounts: [
        {
          // Clean, complete account.
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_300, cash: 10_300 },
          ],
        },
        {
          // Mixed-source funding - ambiguous.
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 5_000 },
            { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 500 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 6_800, cash: 6_800 },
          ],
          brokerRecords: [brokerRecord({ action: "MoneyLink Transfer", amount: 1_000, occurredAt: "2026-08-01" })],
        },
      ],
    });

    // The first account alone would have a confirmed $300 gain, but the aggregate must never
    // present that as if the whole portfolio's evidence were complete.
    expect(report.wholeAccountGain).toBeNull();
    expect(report.wholeAccountGainUnavailableReason).toBe("INCOMPLETE_MIXED_SOURCES");
    expect(report.accountCount).toBe(2);
  });

  it("30. trustworthy current values aggregate correctly across accounts, exposing the true snapshot range rather than a false common instant (Astra corrective patch, Issue 5)", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T09:00:00Z", accountValue: 10_300, cash: 10_300 },
          ],
        },
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 5_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T11:00:00Z", accountValue: 5_500, cash: 5_500 },
          ],
        },
      ],
    });

    expect(report.currentAccountValue).toBe(15_800);
    expect(report.currentAccountValueSource).toBe("SCHWAB");
    // The two accounts were snapshotted at genuinely different times - there is no single common
    // "as of" instant for the combined $15,800, so the exact-instant field must be null rather
    // than dishonestly pretending 09:00 (or any single time) is when the WHOLE total existed.
    expect(report.currentAccountValueAsOf).toBeNull();
    expect(report.currentAccountValueOldestSnapshotAsOf).toEqual(new Date("2026-09-10T09:00:00Z"));
    expect(report.currentAccountValueNewestSnapshotAsOf).toEqual(new Date("2026-09-10T11:00:00Z"));
    expect(report.accountCount).toBe(2);
  });

  it("31. a single account's account-value timestamp remains an exact instant, not a range", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T09:00:00Z", accountValue: 10_300, cash: 10_300 },
          ],
        },
      ],
    });

    expect(report.currentAccountValueAsOf).toEqual(new Date("2026-09-10T09:00:00Z"));
    expect(report.currentAccountValueOldestSnapshotAsOf).toEqual(new Date("2026-09-10T09:00:00Z"));
    expect(report.currentAccountValueNewestSnapshotAsOf).toEqual(new Date("2026-09-10T09:00:00Z"));
  });

  it("32. multiple accounts snapshotted at the exact same instant still report one common as-of", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T09:00:00Z", accountValue: 10_300, cash: 10_300 },
          ],
        },
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 5_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T09:00:00Z", accountValue: 5_500, cash: 5_500 },
          ],
        },
      ],
    });

    expect(report.currentAccountValueAsOf).toEqual(new Date("2026-09-10T09:00:00Z"));
  });
});

describe("Astra corrective patch - Issue 1 (blocker): trade return requires complete capital evidence", () => {
  const asOf = new Date("2026-09-05T13:00:00Z");

  it("two confirmed closed-this-week campaigns, one missing collateral -> trade return unavailable with an INCOMPLETE_CAPITAL_EVIDENCE status", () => {
    // Exact Astra repro: $100 + $100 confirmed gain, one campaign's $1,000 collateral known, the
    // other's unknown - must never report 200/1000 = 20%.
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [
        completed({ campaignId: "known", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 100, collateralCommitted: 1_000 }),
        completed({ campaignId: "unknown", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 100 }),
      ],
      asOf,
    });

    expect(report.tradeReturnPercent).toBeNull();
    expect(report.tradeReturnGrossPercent).toBeNull();
    expect(report.tradeReturnStatus).toBe("INCOMPLETE_CAPITAL_EVIDENCE");
    expect(report.tradeReturnMessage).toMatch(/capital|collateral/i);
    // Confirmed trading P/L is independently confirmed and must still show - the $200 is real.
    expect(report.confirmedTradingPL).toBe(200);
  });

  it("all contributing campaigns have valid collateral -> trade return still calculates correctly", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [
        completed({ campaignId: "APLD", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 28, collateralCommitted: 2_350 }),
        completed({ campaignId: "CORZ", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 68, collateralCommitted: 1_650 }),
      ],
      asOf,
    });

    expect(report.tradeReturnStatus).toBe("OK");
    expect(report.tradeReturnPercent).toBeCloseTo(2.4, 1);
  });
});

describe("Astra corrective patch - Issue 2 (should-fix): incomplete result evidence is never mislabeled as a fee problem", () => {
  const asOf = new Date("2026-09-05T13:00:00Z");

  it("a confirmed campaign plus an incomplete-result campaign reports INCOMPLETE_RESULT_EVIDENCE, not a fee status", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [
        completed({ campaignId: "confirmed", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 100, collateralCommitted: 1_000 }),
        completed({ campaignId: "incomplete", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "UNKNOWN", pl: null }),
      ],
      asOf,
    });

    expect(report.tradeReturnStatus).toBe("INCOMPLETE_RESULT_EVIDENCE");
    expect(report.tradeReturnMessage).not.toMatch(/fee/i);
    expect(report.tradeReturnMessage).toMatch(/result/i);
  });

  it("a genuinely unresolved fee (no incomplete result, no missing collateral) still reports the fee-specific status/message", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [
        completed({
          campaignId: "CORZ",
          closedAt: new Date("2026-09-04T21:00:00Z"),
          finalResult: "GAIN",
          pl: 68,
          collateralCommitted: 1_650,
          feesFullyKnown: false,
        }),
      ],
      asOf,
    });

    expect(report.tradeReturnStatus).toBe("PENDING_FEE_EVIDENCE");
    expect(report.tradeReturnMessage).toMatch(/fee/i);
  });
});

describe("Astra corrective patch - Issue 3 (should-fix): unknown exposure must not produce a clean 0% utilization", () => {
  it("unknown open-campaign collateral leaves utilization unavailable, never a false 0%/OK", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 10_000 },
          ],
        },
      ],
      openExposure: [exposureRow({ status: "OPEN", currentCollateralCommitted: null })], // evidence incomplete, not zero
    });

    expect(report.capitalUtilizationStatus).toBe("UNKNOWN_EXPOSURE");
    expect(report.currentCapitalUtilizationPercent).toBeNull(); // never presented as 0% or complete
    expect(report.capitalUtilizationHasUnknownExposure).toBe(true);
    expect(report.capitalUtilizationMessage).toMatch(/could not be verified|unknown|unverified/i);
    // The known committed-capital dollar figure ($0 here, genuinely nothing confirmed) is still a
    // real, non-fabricated floor and stays available even though the percentage is withheld.
    expect(report.currentCapitalCommitted).toBe(0);
  });

  it("an assigned campaign with an unknown share-cost basis also withholds the utilization percentage", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 10_000 },
          ],
        },
      ],
      openExposure: [exposureRow({ status: "ASSIGNED", remainingShareBasis: null })],
    });

    expect(report.capitalUtilizationStatus).toBe("UNKNOWN_EXPOSURE");
    expect(report.currentCapitalUtilizationPercent).toBeNull();
  });

  it("known zero committed capital with fully-known, complete exposure remains a legitimate 0% (not confused with unknown exposure)", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_000, cash: 10_000 },
          ],
        },
      ],
      openExposure: [], // no open/assigned campaigns at all - nothing unknown, nothing committed
    });

    expect(report.capitalUtilizationHasUnknownExposure).toBe(false);
    expect(report.capitalUtilizationStatus).toBe("OK");
    expect(report.currentCapitalUtilizationPercent).toBe(0);
  });
});

describe("Astra corrective patch - Issue 4 (should-fix): explicit period metadata per metric", () => {
  it("trade return exposes the exact ISO week boundary summarizeThisWeek actually used", () => {
    const asOf = new Date("2026-09-05T13:00:00Z"); // Saturday, week of 2026-08-31 (Mon) - 2026-09-06 (Sun)
    const report = reportFor({ accounts: [{ ledgerEntries: [] }], completedCampaigns: [], asOf });

    expect(report.tradeReturnPeriod).toBe("THIS_WEEK");
    expect(report.tradeReturnPeriodStartUtc).toEqual(new Date("2026-08-31T00:00:00.000Z"));
    expect(report.tradeReturnPeriodEndUtc).toEqual(new Date("2026-09-06T23:59:59.999Z"));
    expect(report.tradeReturnAsOf).toEqual(asOf);
  });

  it("confirmed trading P/L clearly retains ALL_TIME/tracked-history period semantics, not a weekly one", () => {
    const report = reportFor({
      accounts: [{ ledgerEntries: [] }],
      completedCampaigns: [completed({ campaignId: "old", closedAt: new Date("2025-01-01"), finalResult: "GAIN", pl: 50 })],
    });

    expect(report.confirmedTradingPLPeriod).toBe("ALL_TIME");
    expect(report.confirmedTradingPLBasis.toLowerCase()).not.toContain("week");
    expect(report.confirmedTradingPL).toBe(50); // a campaign closed over a year ago still counts
  });

  it("whole-account gain exposes the baseline-start and ending-valuation instants when available", () => {
    const report = reportFor({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
            { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_300, cash: 10_300 },
          ],
          brokerTransactionCoverageStatus: "COMPLETE",
        },
      ],
    });

    expect(report.wholeAccountGainPeriod).toBe("SINCE_BASELINE");
    expect(report.wholeAccountGainPeriodStart).toEqual(new Date("2026-06-16T03:59:59.999Z"));
    expect(report.wholeAccountGainPeriodEnd).toEqual(new Date("2026-09-10T12:00:00Z"));
  });

  it("whole-account gain period metadata is null (not fabricated) when there is no baseline at all", () => {
    const report = reportFor({ accounts: [{ ledgerEntries: [] }] });

    expect(report.wholeAccountGainPeriodStart).toBeNull();
    expect(report.wholeAccountGainPeriodEnd).toBeNull();
  });
});
