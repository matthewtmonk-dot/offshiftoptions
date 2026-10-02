import { describe, expect, it } from "vitest";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import { evaluatePositionReview, type PositionReviewInput, type PositionReviewResult } from "./positionReview";
import {
  computePositionReviewContextFingerprint,
  evaluateHistoricalAssessmentEligibility,
  evaluatePositionReviewWriteEligibility,
  isPersistablePositionReviewAction,
  type CurrentLegMatchContext,
  type CurrentPositionAssessmentCandidate,
  type PositionReviewAssessmentScope,
  type PositionReviewContextFingerprintInput,
} from "./positionReviewAssessment";

const NY_DATE = "2026-06-15";
const NOON = new Date(`${NY_DATE}T16:00:00Z`); // 12:00 PM ET
const SESSION_OPEN = new Date(`${NY_DATE}T09:30:00-04:00`);
const SESSION_CLOSE = new Date(`${NY_DATE}T16:00:00-04:00`);

function ordinarySession(overrides: Partial<Extract<EquityMarketSessionEvidence, { status: "AVAILABLE" }>> = {}): EquityMarketSessionEvidence {
  return {
    status: "AVAILABLE",
    requestedDate: NY_DATE,
    returnedDate: NY_DATE,
    marketType: "EQUITY",
    product: "EQ",
    isOpen: true,
    regularMarketIntervals: [{ start: SESSION_OPEN, end: SESSION_CLOSE }],
    ...overrides,
  };
}

function quote(price: number, tradeTime: Date = NOON): QuoteReviewEvidence {
  return {
    status: "AVAILABLE",
    requestedSymbol: "UPST",
    returnedSymbol: "UPST",
    assetMainType: "EQUITY",
    realtime: true,
    price,
    tradeTime,
    requestStartedAt: tradeTime,
    responseReceivedAt: tradeTime,
  };
}

function baseInput(overrides: Partial<PositionReviewInput> = {}): PositionReviewInput {
  return {
    campaignId: "campaign-1",
    accountId: "account-1",
    ticker: "UPST",
    leg: { kind: "PUT", strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), contracts: 1 },
    lifecycleStage: "Cash-secured put",
    rollBufferPercent: 3,
    position: { state: "SCHWAB_CONFIRMED", asOf: NOON },
    quote: quote(26),
    session: ordinarySession(),
    now: NOON,
    ...overrides,
  };
}

const SCOPE: PositionReviewAssessmentScope = { ownerId: "matt", accountId: "account-1", campaignId: "campaign-1", openingEventId: "evt-1" };

function contextInput(overrides: Partial<PositionReviewContextFingerprintInput> = {}): PositionReviewContextFingerprintInput {
  return {
    scope: SCOPE,
    ticker: "UPST",
    optionType: "PUT",
    strike: 25,
    expiration: new Date("2026-10-02T00:00:00.000Z"),
    contracts: 1,
    campaignStatus: "OPEN",
    campaignLifecycleStage: "Cash-secured put",
    accountSource: "SCHWAB",
    brokerageMappingIdentity: "broker-a",
    appliedRollBufferPercent: 3,
    evaluationPolicyVersion: 1,
    ...overrides,
  };
}

function candidateFor(result: PositionReviewResult, overrides: Partial<PositionReviewContextFingerprintInput> = {}): CurrentPositionAssessmentCandidate {
  const context = contextInput({ ...(result.evidence.position === "MANUAL_POSITION" ? { accountSource: "MANUAL" as const } : {}), ...overrides });
  const evaluationInput = baseInput({
      now: result.explanation.evaluatedAt,
      leg: { kind: result.explanation.optionType ?? "PUT", strike: 25, contracts: 1, expiration: new Date("2026-10-02T00:00:00.000Z") },
      quote: quote(result.explanation.stockPrice ?? 30, result.explanation.quoteTradeTime ?? NOON),
      position: result.evidence.position === "MANUAL_POSITION" ? { state: "MANUAL_POSITION" } : { state: "SCHWAB_CONFIRMED", asOf: result.explanation.positionEvidenceAsOf ?? NOON },
    });
  return { scope: SCOPE, context, result, evaluationInput, evaluationScope: { ...SCOPE }, sessionEvidence: ordinarySession() };
}

describe("computePositionReviewContextFingerprint", () => {
  it("is deterministic for identical inputs", () => {
    expect(computePositionReviewContextFingerprint(contextInput())).toBe(computePositionReviewContextFingerprint(contextInput()));
  });

  const fieldChanges: Array<[string, Partial<PositionReviewContextFingerprintInput>]> = [
    ["ticker", { ticker: "OTHER" }],
    ["optionType", { optionType: "CALL" }],
    ["strike", { strike: 30 }],
    ["expiration calendar date", { expiration: new Date("2026-10-09T00:00:00.000Z") }],
    ["contracts", { contracts: 2 }],
    ["campaignStatus", { campaignStatus: "ASSIGNED" }],
    ["campaignLifecycleStage", { campaignLifecycleStage: "Rolled put" }],
    ["accountSource", { accountSource: "MANUAL" }],
    ["brokerageMappingIdentity", { brokerageMappingIdentity: "broker-b" }],
    ["appliedRollBufferPercent", { appliedRollBufferPercent: 5 }],
    ["evaluationPolicyVersion", { evaluationPolicyVersion: 2 }],
  ];

  it.each(fieldChanges)("changes when %s changes", (_label, override) => {
    expect(computePositionReviewContextFingerprint(contextInput(override))).not.toBe(computePositionReviewContextFingerprint(contextInput()));
  });

  it("changes when any scope component changes (owner/account/campaign/openingEvent)", () => {
    const base = computePositionReviewContextFingerprint(contextInput());
    expect(computePositionReviewContextFingerprint(contextInput({ scope: { ...SCOPE, ownerId: "other" } }))).not.toBe(base);
    expect(computePositionReviewContextFingerprint(contextInput({ scope: { ...SCOPE, accountId: "other" } }))).not.toBe(base);
    expect(computePositionReviewContextFingerprint(contextInput({ scope: { ...SCOPE, campaignId: "other" } }))).not.toBe(base);
    expect(computePositionReviewContextFingerprint(contextInput({ scope: { ...SCOPE, openingEventId: "other" } }))).not.toBe(base);
  });

  it("never hashes rendered text - the fingerprint itself contains the raw canonical field values", () => {
    const fingerprint = computePositionReviewContextFingerprint(contextInput());
    expect(fingerprint).toContain("UPST");
    expect(fingerprint).toContain("evt-1");
  });
});

describe("isPersistablePositionReviewAction", () => {
  it("accepts exactly the four meaningful actions", () => {
    expect(isPersistablePositionReviewAction("COMFORTABLE")).toBe(true);
    expect(isPersistablePositionReviewAction("WATCH")).toBe(true);
    expect(isPersistablePositionReviewAction("REVIEW_ROLL")).toBe(true);
    expect(isPersistablePositionReviewAction("REVIEW_CALL")).toBe(true);
  });

  it("rejects CANNOT_ASSESS", () => {
    expect(isPersistablePositionReviewAction("CANNOT_ASSESS")).toBe(false);
  });
});

describe("evaluatePositionReviewWriteEligibility - persists the 4 meaningful actions", () => {
  it("COMFORTABLE is eligible", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
    expect(result.action).toBe("COMFORTABLE");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: true });
  });

  it("WATCH is eligible", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(25.3) }));
    expect(result.action).toBe("WATCH");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: true });
  });

  it("REVIEW_ROLL (put at/ITM) is eligible", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(20) }));
    expect(result.action).toBe("REVIEW_ROLL");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: true });
  });

  it("REVIEW_CALL (call at/ITM) is eligible", () => {
    const callLegInput = baseInput({
      leg: { kind: "CALL", strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), contracts: 1 },
      quote: quote(30),
    });
    const result = evaluatePositionReview(callLegInput);
    expect(result.action).toBe("REVIEW_CALL");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result, { optionType: "CALL" }), NOON)).toEqual({ eligible: true });
  });
});

describe("evaluatePositionReviewWriteEligibility - never persists from a disqualifying evidence state", () => {
  it("rejects CANNOT_ASSESS (e.g. assigned shares, no call)", () => {
    const result = evaluatePositionReview(baseInput({ leg: { kind: "NONE" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: false, reasonCode: "NOT_MEANINGFUL_ACTION" });
  });

  it("rejects stale quote evidence", () => {
    const staleTrade = new Date(NOON.getTime() - 10 * 60_000);
    const result = evaluatePositionReview(baseInput({ quote: quote(26, staleTrade) }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: false, reasonCode: "NOT_MEANINGFUL_ACTION" });
  });

  it("rejects after-hours (closed session) evidence", () => {
    const afterHours = new Date(`${NY_DATE}T21:00:00Z`); // 5:00 PM ET, after close
    const result = evaluatePositionReview(baseInput({ now: afterHours, quote: quote(26, afterHours) }));
    expect(result.evidence.quote).not.toBe("ELIGIBLE");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), afterHours).eligible).toBe(false);
  });

  it("rejects a failed-refresh/unavailable quote", () => {
    const result = evaluatePositionReview(baseInput({ quote: { status: "UNAVAILABLE", reason: "provider error" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: false, reasonCode: "NOT_MEANINGFUL_ACTION" });
  });

  it("rejects missing provider position evidence (BROKER_UNAVAILABLE)", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "BROKER_UNAVAILABLE" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: false, reasonCode: "NOT_MEANINGFUL_ACTION" });
  });

  it("rejects ambiguous broker position evidence (POSITION_MISMATCH_AMBIGUOUS)", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "POSITION_MISMATCH_AMBIGUOUS" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: false, reasonCode: "NOT_MEANINGFUL_ACTION" });
  });

  it("rejects unsupported covered-call coverage (INSUFFICIENT_SHARE_COVERAGE)", () => {
    const result = evaluatePositionReview(
      baseInput({
        leg: { kind: "CALL", strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), contracts: 1 },
        position: { state: "INSUFFICIENT_SHARE_COVERAGE" },
      }),
    );
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result, { optionType: "CALL" }), NOON)).toEqual({ eligible: false, reasonCode: "NOT_MEANINGFUL_ACTION" });
  });

  it("rejects expired guidance even if the action itself is meaningful", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
    expect(result.action).toBe("COMFORTABLE");
    const pastDeadline = new Date(result.explanation.activeGuidanceDeadline!.getTime() + 1);
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), pastDeadline)).toEqual({ eligible: false, reasonCode: "GUIDANCE_DEADLINE_EXPIRED" });
  });

  it("rejects a missing guidance deadline", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(24.5) }));
    const withoutDeadline: PositionReviewResult = { ...result, explanation: { ...result.explanation, activeGuidanceDeadline: null } };
    expect(evaluatePositionReviewWriteEligibility(candidateFor(withoutDeadline), NOON)).toEqual({ eligible: false, reasonCode: "GUIDANCE_DEADLINE_MISSING" });
  });

  it("rejects a session marked CLOSED even if quote/action evidence looks eligible (defense in depth)", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(24.5) }));
    const closedSession: PositionReviewResult = { ...result, evidence: { ...result.evidence, session: "CLOSED" } };
    expect(evaluatePositionReviewWriteEligibility(candidateFor(closedSession), NOON)).toEqual({ eligible: false, reasonCode: "SESSION_NOT_OPEN" });
  });

  it("accepts a MANUAL_POSITION on exactly the same terms as SCHWAB_CONFIRMED", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "MANUAL_POSITION" }, quote: quote(30) }));
    expect(result.action).toBe("COMFORTABLE");
    expect(evaluatePositionReviewWriteEligibility(candidateFor(result), NOON)).toEqual({ eligible: true });
  });
});

describe("evaluateHistoricalAssessmentEligibility", () => {
  const storedFingerprint = computePositionReviewContextFingerprint(contextInput());
  const stored = { scope: SCOPE, contextFingerprint: storedFingerprint };

  function currentContext(overrides: Partial<CurrentLegMatchContext> = {}): CurrentLegMatchContext {
    return {
      scope: SCOPE,
      contextFingerprint: storedFingerprint,
      positionEvidenceState: "SCHWAB_CONFIRMED",
      lifecycle: "CURRENT_PUT",
      reasonCodes: [],
      ...overrides,
    };
  }

  it("accepts when owner/account/campaign/openingEvent/fingerprint all match and current leg is healthy", () => {
    expect(evaluateHistoricalAssessmentEligibility({ stored, current: currentContext() })).toEqual({ eligible: true });
  });

  it("rejects when there is no current leg at all (closed/rolled away/assigned)", () => {
    expect(evaluateHistoricalAssessmentEligibility({ stored, current: null })).toEqual({ eligible: false, reasonCode: "NO_CURRENT_LEG" });
  });

  it("rejects on owner mismatch", () => {
    const current = currentContext({ scope: { ...SCOPE, ownerId: "someone-else" } });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "OWNER_MISMATCH" });
  });

  it("rejects on account mismatch", () => {
    const current = currentContext({ scope: { ...SCOPE, accountId: "other-account" } });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "ACCOUNT_MISMATCH" });
  });

  it("rejects on campaign mismatch", () => {
    const current = currentContext({ scope: { ...SCOPE, campaignId: "other-campaign" } });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "CAMPAIGN_MISMATCH" });
  });

  it("rejects when the opening event id changed (roll or reopen)", () => {
    const current = currentContext({ scope: { ...SCOPE, openingEventId: "evt-2" } });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "OPENING_EVENT_CHANGED" });
  });

  it("rejects when the context fingerprint changed (strike/expiration/quantity/policy/etc.)", () => {
    const current = currentContext({ contextFingerprint: computePositionReviewContextFingerprint(contextInput({ strike: 30 })) });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "CONTEXT_FINGERPRINT_CHANGED" });
  });

  it("rejects once the current lifecycle has reached past-expiration primacy", () => {
    const current = currentContext({ lifecycle: "EXPIRATION_PENDING" });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "EXPIRATION_LIFECYCLE_PRIMARY" });
  });

  it("rejects once the current session has ended on expiration day", () => {
    const current = currentContext({ lifecycle: "EXPIRATION_SESSION_ENDED" });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "EXPIRATION_LIFECYCLE_PRIMARY" });
  });

  it("rejects ambiguous current position-match evidence", () => {
    const current = currentContext({ positionEvidenceState: "POSITION_MISMATCH_AMBIGUOUS" });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "COVERAGE_AMBIGUOUS_OR_UNSUPPORTED" });
  });

  it("rejects insufficient covered-call share coverage", () => {
    const current = currentContext({ positionEvidenceState: "INSUFFICIENT_SHARE_COVERAGE" });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "COVERAGE_AMBIGUOUS_OR_UNSUPPORTED" });
  });

  it("rejects an unsupported contract deliverable", () => {
    const current = currentContext({ positionEvidenceState: "UNSUPPORTED_CONTRACT_DELIVERABLE" });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: false, reasonCode: "COVERAGE_AMBIGUOUS_OR_UNSUPPORTED" });
  });

  it("does NOT reject merely because the broker/quote is transiently unavailable right now - that is the whole point of the fallback", () => {
    const current = currentContext({ positionEvidenceState: "BROKER_UNAVAILABLE" });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: true });
  });

  it("does NOT reject merely because current confirmation is still awaiting broker read-back", () => {
    const current = currentContext({ positionEvidenceState: "AWAITING_CONFIRMATION" });
    expect(evaluateHistoricalAssessmentEligibility({ stored, current })).toEqual({ eligible: true });
  });
});

describe("repair: current-session evidence and result binding", () => {
  function validCandidate() { return candidateFor(evaluatePositionReview(baseInput())); }
  it.each([
    ["invalid evaluation", (c: CurrentPositionAssessmentCandidate) => { c.result.explanation.evaluatedAt = new Date(NaN); }],
    ["invalid deadline", (c: CurrentPositionAssessmentCandidate) => { c.result.explanation.activeGuidanceDeadline = new Date(NaN); }],
    ["unavailable session", (c: CurrentPositionAssessmentCandidate) => { c.sessionEvidence = { status: "UNAVAILABLE", reason: "offline" }; }],
    ["missing interval", (c: CurrentPositionAssessmentCandidate) => { c.sessionEvidence = ordinarySession({ regularMarketIntervals: [] }); }],
    ["zero interval", (c: CurrentPositionAssessmentCandidate) => { c.sessionEvidence = ordinarySession({ regularMarketIntervals: [{ start: NOON, end: NOON }] }); }],
    ["reversed interval", (c: CurrentPositionAssessmentCandidate) => { c.sessionEvidence = ordinarySession({ regularMarketIntervals: [{ start: SESSION_CLOSE, end: SESSION_OPEN }] }); }],
    ["invalid interval", (c: CurrentPositionAssessmentCandidate) => { c.sessionEvidence = ordinarySession({ regularMarketIntervals: [{ start: new Date(NaN), end: SESSION_CLOSE }] }); }],
    ["wrong session date", (c: CurrentPositionAssessmentCandidate) => { c.sessionEvidence = ordinarySession({ returnedDate: "2026-06-16" }); }],
    ["before open", (c: CurrentPositionAssessmentCandidate) => { c.result.explanation.evaluatedAt = new Date(SESSION_OPEN.getTime() - 1); }],
    ["at close", (c: CurrentPositionAssessmentCandidate) => { c.result.explanation.evaluatedAt = SESSION_CLOSE; }],
    ["after close", (c: CurrentPositionAssessmentCandidate) => { c.result.explanation.evaluatedAt = new Date(SESSION_CLOSE.getTime() + 1); }],
    ["quote transport NaN", (c: CurrentPositionAssessmentCandidate) => { if (c.evaluationInput.quote.status === "AVAILABLE") c.evaluationInput.quote.responseReceivedAt = new Date(NaN); }],
    ["wrong quote ticker", (c: CurrentPositionAssessmentCandidate) => { c.evaluationInput.quote = { ...quote(26), requestedSymbol: "OTHER", returnedSymbol: "OTHER" } as QuoteReviewEvidence; }],
    ["fabricated price", (c: CurrentPositionAssessmentCandidate) => { c.result.explanation.stockPrice = 999; }],
    ["quantity", (c: CurrentPositionAssessmentCandidate) => { c.context.contracts = 2; }],
    ["scope", (c: CurrentPositionAssessmentCandidate) => { c.scope = { ...SCOPE, campaignId: "other" }; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const c = validCandidate(); mutate(c);
    expect(evaluatePositionReviewWriteEligibility(c, NOON).eligible).toBe(false);
  });
  it("rejects NaN write clock", () => {
    expect(evaluatePositionReviewWriteEligibility(validCandidate(), new Date(NaN))).toEqual({ eligible: false, reasonCode: "INVALID_CLOCK" });
  });
  it("rejects write at session close", () => {
    expect(evaluatePositionReviewWriteEligibility(validCandidate(), SESSION_CLOSE).eligible).toBe(false);
  });
});

describe("repair: explicit historical fallback allowlist", () => {
  const stored = { scope: SCOPE, contextFingerprint: computePositionReviewContextFingerprint(contextInput()) };
  const current: CurrentLegMatchContext = { ...stored, positionEvidenceState: "SCHWAB_CONFIRMED", lifecycle: "CURRENT_PUT", reasonCodes: [] };
  it.each(["MARKET_CLOSED", "QUOTE_STALE_TIMESTAMP", "QUOTE_EVIDENCE_UNAVAILABLE", "QUOTE_SESSION_EVIDENCE_UNAVAILABLE"])("allows actual transient %s", reason => {
    expect(evaluateHistoricalAssessmentEligibility({ stored, current: { ...current, reasonCodes: [reason] } }).eligible).toBe(true);
  });
  it.each(["absent broker position", "nonexact quantity", "wrong contract", "missing receipt"])("denies overloaded NOT_ASSESSED: %s", () => {
    expect(evaluateHistoricalAssessmentEligibility({ stored, current: { ...current, positionEvidenceState: "NOT_ASSESSED", reasonCodes: ["POSITION_NOT_ASSESSED"] } }).eligible).toBe(false);
  });
  it.each(["UNKNOWN_FUTURE_REASON", "QUOTE_SYMBOL_MISMATCH", "ASSIGNED_SHARES_NO_CALL", "PAST_EXPIRATION_UNRESOLVED", "POSITION_POSITION_MISMATCH_AMBIGUOUS", "POSITION_INSUFFICIENT_SHARE_COVERAGE", "POSITION_UNSUPPORTED_CONTRACT_DELIVERABLE"])("denies %s", reason => {
    expect(evaluateHistoricalAssessmentEligibility({ stored, current: { ...current, reasonCodes: [reason] } }).eligible).toBe(false);
  });
  it("denies assignment even if caller retained the old fingerprint", () => {
    expect(evaluateHistoricalAssessmentEligibility({ stored, current: { ...current, lifecycle: "ASSIGNED_SHARES" } }).eligible).toBe(false);
  });
  it.each([
    ["closed market", baseInput({ now: new Date("2026-06-15T21:00:00Z"), quote: quote(26, new Date("2026-06-15T21:00:00Z")) })],
    ["stale quote", baseInput({ quote: quote(26, new Date(NOON.getTime() - 180000)) })],
    ["provider outage", baseInput({ quote: { status: "UNAVAILABLE", reason: "offline" } })],
    ["broker outage", baseInput({ position: { state: "BROKER_UNAVAILABLE" } })],
    ["stale confirmation", baseInput({ position: { state: "SCHWAB_CONFIRMED", asOf: new Date(NOON.getTime() - 600000) } })],
  ] as const)("accepts real evaluator reasons from %s", (_name, input) => {
    const result = evaluatePositionReview(input);
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(evaluateHistoricalAssessmentEligibility({ stored, current: { ...current, positionEvidenceState: result.evidence.position, lifecycle: result.lifecycle, reasonCodes: result.explanation.reasonCodes } }).eligible).toBe(true);
  });
  it("rejects relabeling the evaluated opening event even when every financial term matches", () => {
    const candidate = candidateFor(evaluatePositionReview(baseInput()));
    candidate.scope = { ...candidate.scope, openingEventId: "new-identical-terms-leg" };
    candidate.context.scope = candidate.scope;
    expect(evaluatePositionReviewWriteEligibility(candidate, NOON)).toEqual({ eligible: false, reasonCode: "RESULT_CONTEXT_MISMATCH" });
  });

});
