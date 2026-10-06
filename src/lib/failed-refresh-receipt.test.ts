import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFailedRefreshReceiptsForTests,
  consumeFailedRefreshReceipt,
  recordRefreshOutcome,
  type RetainedPositionEvidence,
} from "./failed-refresh-receipt";

beforeEach(() => {
  clearFailedRefreshReceiptsForTests();
});

const sampleEvidence: RetainedPositionEvidence = {
  brokerPositions: [{ accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, accountLabel: "Test" }],
  quoteEvidenceByTicker: new Map(),
  sessionEvidence: { status: "UNAVAILABLE", reason: "test fixture" },
};

describe("failed-refresh-receipt - the authenticated, server-validated replacement for the untrusted skip-live URL marker", () => {
  it("a failed outcome is retrievable exactly once", () => {
    recordRefreshOutcome("matt", 1, { ok: false, evidence: sampleEvidence });

    expect(consumeFailedRefreshReceipt("matt")).toEqual(sampleEvidence);
    // One-shot: the second read gets nothing, even though it hasn't expired.
    expect(consumeFailedRefreshReceipt("matt")).toBeNull();
  });

  it("owner-scoped: a receipt recorded for one user is never visible to another", () => {
    recordRefreshOutcome("matt", 1, { ok: false, evidence: sampleEvidence });

    expect(consumeFailedRefreshReceipt("eric")).toBeNull();
    // Matt's own receipt is still there, untouched by Eric's failed lookup.
    expect(consumeFailedRefreshReceipt("matt")).toEqual(sampleEvidence);
  });

  it("a successful outcome never stores a receipt", () => {
    recordRefreshOutcome("matt", 1, { ok: true });

    expect(consumeFailedRefreshReceipt("matt")).toBeNull();
  });

  it("a successful outcome clears a STALE receipt from an earlier failed attempt for the same user", () => {
    recordRefreshOutcome("matt", 1, { ok: false, evidence: sampleEvidence });
    recordRefreshOutcome("matt", 2, { ok: true });

    expect(consumeFailedRefreshReceipt("matt")).toBeNull();
  });

  // Codex blocker repair (C, final) - Part 7 test H: a late-arriving, OLDER generation's outcome
  // must never overwrite or invalidate a NEWER generation's already-recorded state, regardless of
  // arrival order (an abandoned/timed-out attempt resolving late is exactly this scenario).
  it("a stale (older-generation) outcome arriving AFTER a newer one is ignored outright, even when the newer one failed", () => {
    recordRefreshOutcome("matt", 2, { ok: false, evidence: sampleEvidence });
    const staleEvidence: RetainedPositionEvidence = { ...sampleEvidence, sessionEvidence: { status: "AVAILABLE", requestedDate: "2026-01-01", returnedDate: "2026-01-01", marketType: "EQUITY", product: "EQ", isOpen: true, regularMarketIntervals: [] } };

    // Generation 1 (older) resolves LATE, after generation 2 already recorded its own outcome.
    recordRefreshOutcome("matt", 1, { ok: false, evidence: staleEvidence });

    // The receipt in place is still generation 2's own evidence, never overwritten by the stale
    // generation 1 completion.
    expect(consumeFailedRefreshReceipt("matt")).toEqual(sampleEvidence);
  });

  it("a stale (older-generation) SUCCESS arriving after a newer FAILURE does not erase the newer failure's receipt", () => {
    recordRefreshOutcome("matt", 2, { ok: false, evidence: sampleEvidence });
    // Generation 1 (older) succeeds, but resolves late - it must not clear generation 2's receipt.
    recordRefreshOutcome("matt", 1, { ok: true });

    expect(consumeFailedRefreshReceipt("matt")).toEqual(sampleEvidence);
  });

  it("the SAME generation recorded twice (COALESCED joiners) only records once - no duplicate/overwrite error", () => {
    recordRefreshOutcome("matt", 1, { ok: false, evidence: sampleEvidence });
    const differentEvidence: RetainedPositionEvidence = { ...sampleEvidence, brokerPositions: null };
    // A second joiner for the EXACT same generation calling this again must be a no-op - it must
    // never be treated as "newer" just because it happened to run second.
    recordRefreshOutcome("matt", 1, { ok: false, evidence: differentEvidence });

    expect(consumeFailedRefreshReceipt("matt")).toEqual(sampleEvidence);
  });

  // Codex blocker repair (C, final) - Part 7 test J: expiry must fail closed.
  it("an expired receipt fails closed - never returned, even though it was genuinely recorded", () => {
    let fakeNow = 1_000_000;
    recordRefreshOutcome("matt", 1, { ok: false, evidence: sampleEvidence }, 5_000, () => fakeNow);

    fakeNow += 5_001; // just past the 5-second TTL used for this call
    expect(consumeFailedRefreshReceipt("matt", () => fakeNow)).toBeNull();
  });

  it("a receipt consumed just before its expiry is still honored", () => {
    let fakeNow = 1_000_000;
    recordRefreshOutcome("matt", 1, { ok: false, evidence: sampleEvidence }, 5_000, () => fakeNow);

    fakeNow += 4_999;
    expect(consumeFailedRefreshReceipt("matt", () => fakeNow)).toEqual(sampleEvidence);
  });

  it("consuming for a user with no receipt at all returns null, never throws", () => {
    expect(consumeFailedRefreshReceipt("nobody-ever-refreshed")).toBeNull();
  });

  it("generation 0 (never a real attempt) is never treated as newer than itself - recordRefreshOutcome requires a strictly positive, increasing generation", () => {
    recordRefreshOutcome("matt", 1, { ok: false, evidence: sampleEvidence });
    // A caller mistakenly passing generation 0 (or re-passing 1) must never be treated as "newer."
    recordRefreshOutcome("matt", 1, { ok: false, evidence: { ...sampleEvidence, brokerPositions: null } });

    expect(consumeFailedRefreshReceipt("matt")).toEqual(sampleEvidence);
  });
});
