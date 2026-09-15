import { describe, expect, it } from "vitest";
import {
  evaluateWorthlessExpiration,
  type SchwabReconciliationEvidence,
  type ReconciliationPosition,
  findClosingEvidence,
  findRollPairedOpeningTransactionIds,
  isConfirmedExpiredWorthless,
  parseOpeningPutTransaction,
  type ReconciliationTransaction,
} from "./schwabReconciliation";

function completeEvidence(positions: ReconciliationPosition[]): SchwabReconciliationEvidence {
  return {
    positions: { status: "COMPLETE", data: positions },
    transactions: { status: "COMPLETE", from: new Date("2026-01-01"), to: new Date("2026-09-30") },
    persistenceStatus: "COMPLETE",
  };
}

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

  it.each(["APLD  260904P00023500", "apld260904p00023500"])("recognizes padded/canonical close and assignment evidence: %s", (symbol) => {
    expect(findClosingEvidence(leg, [transaction({ symbol, action: "Buy to Close", price: 0.1 })]).kind).toBe("CLOSE");
    expect(findClosingEvidence(leg, [transaction({ symbol, action: "Assignment", price: null })]).kind).toBe("ASSIGNMENT");
    expect(findClosingEvidence(leg, [
      transaction({ symbol, action: "Buy to Close", price: 0.1 }),
      transaction({ id: "roll-open", symbol: "APLD  260918P00022000" }),
    ]).kind).toBe("ROLL");
  });

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

  it("never treats a 'Removed - Expiration' record as a CLOSE, even with a matching symbol and a real price - expiration evidence alone cannot close or win a campaign", () => {
    const evidence = findClosingEvidence(leg, [
      transaction({ id: "txn-removed", action: "Removed - Expiration", price: 0, occurredAt: new Date("2026-09-04T21:00:00Z") }),
    ]);
    expect(evidence).toEqual({ kind: "NONE" });
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
  // Sep 4, 2026 is a Friday; Labor Day makes Tuesday Sep 8 the next NYSE business day.
  const expiration = new Date(Date.UTC(2026, 8, 4));
  const symbol = "APLD 260904P00023500";
  const underlying = "APLD";

  it("is not confirmed while expiration day itself is still trading", () => {
    expect(
      isConfirmedExpiredWorthless({
        expiration,
        symbol,
        underlying,
        evidence: completeEvidence([{ symbol, quantity: -1 }]),
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
        evidence: completeEvidence([]),
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
        evidence: completeEvidence([]),
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
        evidence: completeEvidence([]),
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
        evidence: completeEvidence([]),
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
        evidence: completeEvidence([]),
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
        evidence: completeEvidence([{ symbol, quantity: -1 }]),
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
        evidence: completeEvidence([]),
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
        evidence: completeEvidence([{ symbol: underlying, assetType: "EQUITY", quantity: 100 }]),
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
        evidence: completeEvidence([{ symbol: "OTHER", assetType: "EQUITY", quantity: 100 }]),
        hasClosingEvidence: false,
        asOf: new Date("2026-09-08T18:00:00Z"),
      }),
    ).toBe(true);
  });
});

describe("expiration evidence completeness", () => {
  const input = {
    expiration: new Date("2026-09-04"), symbol: "APLD 260904P00023500", underlying: "APLD",
    hasClosingEvidence: false, asOf: new Date("2026-09-08T18:00:00Z"),
  };
  const incomplete = { status: "PENDING", reason: "EXPIRATION_EVIDENCE_INCOMPLETE" };

  it("distinguishes an empty successful positions response from an empty failed response", () => {
    const evidence = completeEvidence([]);
    expect(evaluateWorthlessExpiration({ ...input, evidence })).toEqual({ status: "CONFIRMED" });
    evidence.positions.status = "FAILED";
    expect(evaluateWorthlessExpiration({ ...input, evidence })).toEqual(incomplete);
  });
  it.each(["PARTIAL", "FAILED"] as const)("blocks synthetic expiration for %s transaction evidence", (status) => {
    const evidence = completeEvidence([]);
    evidence.transactions.status = status;
    expect(evaluateWorthlessExpiration({ ...input, evidence })).toEqual(incomplete);
  });
  it("blocks expiration after persistence failure", () => {
    const evidence = completeEvidence([]);
    evidence.persistenceStatus = "FAILED";
    expect(evaluateWorthlessExpiration({ ...input, evidence })).toEqual(incomplete);
  });
  it.each(["APLD  260904P00023500", "APLD260904P00023500", " apld 260904p00023500 "])("never treats a present equivalent contract as absent: %s", (symbol) => {
    expect(evaluateWorthlessExpiration({ ...input, evidence: completeEvidence([{ symbol, quantity: -1 }]) }))
      .toEqual({ status: "PENDING", reason: "OPTION_STILL_PRESENT" });
  });
  it("does not infer absence when an option instrument cannot be parsed", () => {
    expect(evaluateWorthlessExpiration({ ...input, evidence: completeEvidence([{ symbol: "unparsed", assetType: "OPTION", quantity: -1 }]) }))
      .toEqual(incomplete);
  });
  it("requires the successful transaction window to cover expiration and its processing date", () => {
    const evidence = completeEvidence([]);
    evidence.transactions.from = new Date("2026-09-05");
    expect(evaluateWorthlessExpiration({ ...input, evidence })).toEqual(incomplete);
    evidence.transactions.from = new Date("2026-08-01");
    evidence.transactions.to = new Date("2026-09-05");
    expect(evaluateWorthlessExpiration({ ...input, evidence })).toEqual(incomplete);
  });
});
