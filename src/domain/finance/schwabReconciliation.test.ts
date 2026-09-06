import { describe, expect, it } from "vitest";
import {
  findClosingEvidence,
  findRollPairedOpeningTransactionIds,
  isConfirmedExpiredWorthless,
  parseOpeningPutTransaction,
  type ReconciliationTransaction,
} from "./schwabReconciliation";

function transaction(overrides: Partial<ReconciliationTransaction> = {}): ReconciliationTransaction {
  return {
    id: "txn-1",
    symbol: "APLD 260904P00023500",
    occurredAt: new Date("2026-08-28T14:00:00Z"),
    action: "Sell to Open",
    quantity: 1,
    price: 0.28,
    fees: 0,
    ...overrides,
  };
}

describe("parseOpeningPutTransaction", () => {
  it("parses a clean Sell to Open put into an openable leg", () => {
    const opening = parseOpeningPutTransaction(transaction());
    expect(opening).toMatchObject({
      transactionId: "txn-1",
      underlying: "APLD",
      symbol: "APLD 260904P00023500",
      strike: 23.5,
      contracts: 1,
      premium: 0.28,
      fees: 0,
    });
    expect(opening?.expiration).toEqual(new Date(Date.UTC(2026, 8, 4)));
  });

  it("returns null for anything other than Sell to Open", () => {
    expect(parseOpeningPutTransaction(transaction({ action: "Buy to Close" }))).toBeNull();
    expect(parseOpeningPutTransaction(transaction({ action: "Sell to Close" }))).toBeNull();
    expect(parseOpeningPutTransaction(transaction({ action: null }))).toBeNull();
  });

  it("returns null for a call instead of a put - covered calls flow through the existing manual path", () => {
    expect(parseOpeningPutTransaction(transaction({ symbol: "APLD 260904C00023500" }))).toBeNull();
  });

  it("returns null when quantity or price is missing rather than guessing a campaign's terms", () => {
    expect(parseOpeningPutTransaction(transaction({ quantity: null }))).toBeNull();
    expect(parseOpeningPutTransaction(transaction({ price: null }))).toBeNull();
    expect(parseOpeningPutTransaction(transaction({ price: 0 }))).toBeNull();
  });

  it("returns null for a symbol that doesn't parse as an OCC option", () => {
    expect(parseOpeningPutTransaction(transaction({ symbol: "APLD" }))).toBeNull();
  });
});

describe("findClosingEvidence", () => {
  const leg = { symbol: "APLD 260904P00023500", underlying: "APLD", strike: 23.5, expiration: new Date(Date.UTC(2026, 8, 4)) };

  it("returns NONE when nothing in this sync touches the leg", () => {
    expect(findClosingEvidence(leg, [transaction({ symbol: "RIOT 260904P00017500" })])).toEqual({ kind: "NONE" });
  });

  it("recognizes a plain Buy to Close as a CLOSE", () => {
    const evidence = findClosingEvidence(leg, [
      transaction({ id: "txn-btc", action: "Buy to Close", price: 0.05, occurredAt: new Date("2026-09-01T14:00:00Z") }),
    ]);
    expect(evidence).toMatchObject({ kind: "CLOSE", transactionId: "txn-btc", premium: 0.05 });
  });

  it("recognizes a same-day Buy to Close + Sell to Open on a different contract as a ROLL, not a plain close", () => {
    const evidence = findClosingEvidence(leg, [
      transaction({ id: "txn-btc", action: "Buy to Close", price: 0.1, occurredAt: new Date("2026-09-01T14:00:00Z") }),
      transaction({
        id: "txn-sto-new",
        symbol: "APLD 260918P00022000",
        action: "Sell to Open",
        price: 0.4,
        occurredAt: new Date("2026-09-01T14:00:01Z"),
      }),
    ]);
    expect(evidence).toMatchObject({
      kind: "ROLL",
      closeTransactionId: "txn-btc",
      openTransactionId: "txn-sto-new",
      closePremium: 0.1,
      newStrike: 22,
      newPremium: 0.4,
    });
  });

  it("does not treat a Buy to Close + unrelated next-day Sell to Open as a roll", () => {
    const evidence = findClosingEvidence(leg, [
      transaction({ id: "txn-btc", action: "Buy to Close", price: 0.1, occurredAt: new Date("2026-09-01T14:00:00Z") }),
      transaction({
        id: "txn-sto-new",
        symbol: "APLD 260918P00022000",
        action: "Sell to Open",
        price: 0.4,
        occurredAt: new Date("2026-09-02T14:00:00Z"),
      }),
    ]);
    expect(evidence).toMatchObject({ kind: "CLOSE", transactionId: "txn-btc" });
  });

  it("does not treat re-selling the exact same contract as a roll", () => {
    const evidence = findClosingEvidence(leg, [
      transaction({ id: "txn-btc", action: "Buy to Close", price: 0.1, occurredAt: new Date("2026-09-01T14:00:00Z") }),
      transaction({ id: "txn-sto-same", action: "Sell to Open", price: 0.3, occurredAt: new Date("2026-09-01T14:00:01Z") }),
    ]);
    expect(evidence).toMatchObject({ kind: "CLOSE", transactionId: "txn-btc" });
  });

  it("recognizes an assignment when there is no Buy to Close", () => {
    const evidence = findClosingEvidence(leg, [
      transaction({ id: "txn-assign", action: "Assignment", price: null, occurredAt: new Date("2026-09-04T21:00:00Z") }),
    ]);
    expect(evidence).toMatchObject({ kind: "ASSIGNMENT", transactionId: "txn-assign" });
  });
});

describe("findRollPairedOpeningTransactionIds", () => {
  it("reserves a same-day Sell to Open on a different contract as a roll's new leg", () => {
    const reserved = findRollPairedOpeningTransactionIds([
      transaction({ id: "btc", symbol: "ROLL 260828P00018000", action: "Buy to Close", occurredAt: new Date("2026-08-27T14:00:00Z") }),
      transaction({ id: "sto-new", symbol: "ROLL 260904P00017500", action: "Sell to Open", occurredAt: new Date("2026-08-27T14:01:00Z") }),
    ]);
    expect(reserved.has("sto-new")).toBe(true);
  });

  it("does not reserve an independent Sell to Open on an unrelated underlying", () => {
    const reserved = findRollPairedOpeningTransactionIds([
      transaction({ id: "btc", symbol: "ROLL 260828P00018000", action: "Buy to Close", occurredAt: new Date("2026-08-27T14:00:00Z") }),
      transaction({ id: "sto-independent", symbol: "OTHER 260904P00017500", action: "Sell to Open", occurredAt: new Date("2026-08-27T14:01:00Z") }),
    ]);
    expect(reserved.size).toBe(0);
  });

  it("does not reserve a Sell to Open on a different day - only same-day pairs count as a roll", () => {
    const reserved = findRollPairedOpeningTransactionIds([
      transaction({ id: "btc", symbol: "ROLL 260828P00018000", action: "Buy to Close", occurredAt: new Date("2026-08-27T14:00:00Z") }),
      transaction({ id: "sto-later", symbol: "ROLL 260904P00017500", action: "Sell to Open", occurredAt: new Date("2026-08-28T14:00:00Z") }),
    ]);
    expect(reserved.size).toBe(0);
  });
});

describe("isConfirmedExpiredWorthless", () => {
  // Sep 4, 2026 is a Friday - the next NY business day is Monday Sep 7.
  const expiration = new Date(Date.UTC(2026, 8, 4));
  const symbol = "APLD 260904P00023500";
  const underlying = "APLD";

  it("is not confirmed while expiration day itself is still trading", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [{ symbol, quantity: -1 }],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-04T20:00:00Z"),
      }),
    ).toBe(false);
  });

  it("is NOT confirmed on the Saturday right after expiration, even with the option already gone - not 'Saturday means expired'", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-05T18:00:00Z"),
      }),
    ).toBe(false);
  });

  it("is NOT confirmed Sunday either - still waiting for the next NY business day", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-06T18:00:00Z"),
      }),
    ).toBe(false);
  });

  it("is NOT confirmed on Monday Sep 7 2026 - Labor Day, NYSE closed - even though it's a weekday", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-07T18:00:00Z"),
      }),
    ).toBe(false);
  });

  it("uses NY time, not raw UTC, for the market-day boundary - 2am UTC Tuesday is still Monday night in NY", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-08T02:00:00Z"),
      }),
    ).toBe(false);
  });

  it("is confirmed on Tuesday Sep 8 2026 - the first NYSE market day after the Labor Day weekend - once the option is gone with no closing/assignment/stock evidence", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-08T18:00:00Z"),
      }),
    ).toBe(true);
  });

  it("is not confirmed when Schwab still reports the option position even after the market-day window", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [{ symbol, quantity: -1 }],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-08T18:00:00Z"),
      }),
    ).toBe(false);
  });

  it("is never confirmed when this sync found closing evidence (assignment/BTC prevents a false expired-win)", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [],
        hasClosingEvidence: true,
        asOf: new Date("2026-09-08T18:00:00Z"),
      }),
    ).toBe(false);
  });

  it("+100 acquired shares of the underlying prevents a false expired-win, even with the option gone and no assignment transaction found", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [{ symbol: underlying, assetType: "EQUITY", quantity: 100 }],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-08T18:00:00Z"),
      }),
    ).toBe(false);
  });

  it("an unrelated EQUITY position in a different ticker does not block confirmation", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        freshPositions: [{ symbol: "OTHER", assetType: "EQUITY", quantity: 100 }],
        hasClosingEvidence: false,
        asOf: new Date("2026-09-08T18:00:00Z"),
      }),
    ).toBe(true);
  });
});
