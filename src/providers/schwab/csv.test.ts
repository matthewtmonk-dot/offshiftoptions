import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  mergeBrokerRecords,
  normalizeSchwabApiPosition,
  normalizeSchwabApiTransaction,
  parseSchwabGainLossCsv,
  parseSchwabPositionsCsv,
  parseSchwabTransactionsCsv,
  reconcileBrokerRecords,
} from "./csv";

const accountHint = "training-999";

function fixture(name: string) {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

describe("Schwab CSV normalization", () => {
  it("parses the positions export shape and skips cash/total rows", () => {
    const records = parseSchwabPositionsCsv(fixture("positions.csv"), { accountHint });

    expect(records).toHaveLength(3);
    const lsto = records.find((record) => record.underlyingSymbol === "LSTO");
    expect(lsto).toMatchObject({
      provider: "SCHWAB",
      kind: "POSITION",
      symbol: "LSTO 260904P00017500",
      underlyingSymbol: "LSTO",
      quantity: -1,
      amount: -16,
      sources: ["SCHWAB_POSITIONS_CSV"],
    });
    expect(lsto?.observedAt?.toISOString()).toBe("2026-08-31T23:09:00.000Z");
    expect(records.map((record) => record.symbol)).not.toContain("Cash & Cash Investments");
    expect(records.map((record) => record.symbol)).not.toContain("Positions Total");
  });

  it("parses transactions as the primary historical activity source", () => {
    const records = parseSchwabTransactionsCsv(fixture("transactions.csv"), { accountHint });

    expect(records).toHaveLength(7);
    expect(records[0]).toMatchObject({
      kind: "TRANSACTION",
      action: "Sell to Open",
      symbol: "LSTO 260904P00017500",
      underlyingSymbol: "LSTO",
      quantity: 1,
      price: 0.28,
      fees: 0.66,
      amount: 27.34,
      sources: ["SCHWAB_TRANSACTIONS_CSV"],
    });

    const interest = records.find((record) => record.action === "Bank Interest");
    expect(interest).toMatchObject({
      symbol: null,
      amount: 0.07,
    });
    expect(interest?.metadata.asOfDate).toBe("2026-08-15T00:00:00.000Z");
  });

  it("parses realized gain/loss as reconciliation metadata, not another cash-flow row", () => {
    const records = parseSchwabGainLossCsv(fixture("gainloss-realized.csv"), { accountHint });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "REALIZED_GAIN_LOSS",
      symbol: "TOOL 260828P00016500",
      reconciliationKey: "option:TOOL 260828P00016500",
      amount: null,
      sources: ["SCHWAB_GAINLOSS_CSV"],
    });
    expect(records[0].metadata).toMatchObject({
      realizedGainLoss: 1.68,
      economicEffect: "RECONCILIATION_ONLY",
    });
  });

  it("dedupes repeated exports without using filename or row number identity", () => {
    const transactions = parseSchwabTransactionsCsv(fixture("transactions.csv"), { accountHint });
    const positions = parseSchwabPositionsCsv(fixture("positions.csv"), { accountHint });
    const realized = parseSchwabGainLossCsv(fixture("gainloss-realized.csv"), { accountHint });

    expect(mergeBrokerRecords([...transactions, ...transactions])).toHaveLength(transactions.length);
    expect(mergeBrokerRecords([...positions, ...positions])).toHaveLength(positions.length);
    expect(mergeBrokerRecords([...realized, ...realized])).toHaveLength(realized.length);
  });

  it("reconciles a current API position and Positions CSV row without doubling quantity", () => {
    const csvPosition = parseSchwabPositionsCsv(fixture("positions.csv"), { accountHint }).find(
      (record) => record.symbol === "LSTO 260904P00017500",
    );
    const apiPosition = normalizeSchwabApiPosition(
      {
        accountId: accountHint,
        symbol: "LSTO 260904P00017500",
        quantity: -1,
        marketValue: -16,
        assetType: "OPTION",
        putCall: "PUT",
        strikePrice: 17.5,
        underlyingSymbol: "LSTO",
      },
      new Date("2026-08-31T23:09:00.000Z"),
    );

    const result = reconcileBrokerRecords([csvPosition!, apiPosition]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      quantity: -1,
      sources: ["SCHWAB_POSITIONS_CSV", "SCHWAB_API"],
    });
    expect(result.links).toContainEqual(
      expect.objectContaining({
        status: "CURRENT_POSITION_CONFIRMED",
        realizedPLDelta: 0,
      }),
    );
  });

  it("dedupes the same broker event when API and Transactions CSV are confidently identifiable", () => {
    const csvTransaction = parseSchwabTransactionsCsv(fixture("transactions.csv"), { accountHint })[0];
    const apiTransaction = normalizeSchwabApiTransaction({
      id: "schwab-stable-activity-id",
      accountId: accountHint,
      symbol: "LSTO 260904P00017500",
      amount: 27.34,
      occurredAt: new Date("2026-08-31T00:00:00.000Z"),
      description: "Sell to Open PUT LOW STRESS TOOLS INC $17.5 EXP 09/04/26",
    });

    const records = mergeBrokerRecords([csvTransaction, apiTransaction]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      amount: 27.34,
      sources: ["SCHWAB_TRANSACTIONS_CSV", "SCHWAB_API"],
    });
    expect(records[0].sourceIds).toContain("schwab-api-transaction:schwab-stable-activity-id");
  });

  it("uses Gain/Loss data to validate a completed campaign without adding realized P/L twice", () => {
    const closeTransactions = parseSchwabTransactionsCsv(fixture("transactions.csv"), { accountHint }).filter(
      (record) => record.symbol === "TOOL 260828P00016500",
    );
    const realized = parseSchwabGainLossCsv(fixture("gainloss-realized.csv"), { accountHint });

    const result = reconcileBrokerRecords([...closeTransactions, ...realized]);
    expect(result.campaignRealizedPLDelta).toBe(0);
    expect(result.links).toContainEqual(
      expect.objectContaining({
        key: "option:TOOL 260828P00016500",
        status: "REALIZED_RESULT_CONFIRMED",
        realizedPLDelta: 0,
      }),
    );
  });
});
