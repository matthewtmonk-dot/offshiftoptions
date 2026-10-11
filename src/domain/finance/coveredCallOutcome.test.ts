import { describe, expect, it } from "vitest";
import { calculateCoveredCallOutcome, coveredCallOutcomeTone, type CoveredCallOutcomeInput } from "./coveredCallOutcome";

function baseInput(overrides: Partial<CoveredCallOutcomeInput> = {}): CoveredCallOutcomeInput {
  return {
    assignedPrice: 14,
    shares: 100,
    priorOptionCashFlow: 58.36,
    proposedStrike: 13,
    proposedPremiumPerShare: 0.25,
    targetReturnPct: 1,
    ...overrides,
  };
}

describe("calculateCoveredCallOutcome", () => {
  // CASE 1 - the ticket's own worked example, matched to its exact expected precision.
  it("1. assigned $14, 100 shares, prior cash flow +$58.36, strike $13, premium $0.25, target 1% - matches the ticket's own exact numbers", () => {
    const result = calculateCoveredCallOutcome(baseInput());
    expect(result.shareCost).toBe(1400);
    expect(result.stockGainLossIfCalled).toBe(-100);
    expect(result.newPremiumTotal).toBe(25);
    expect(result.campaignProfitIfCalled).toBe(-16.64);
    expect(result.campaignReturnPct).toBeCloseTo(-1.1886, 4);
    expect(result.effectiveBreakEven).toBe(13.4164);
    expect(result.premiumRequiredToBreakEven).toBe(0.4164);
    expect(result.premiumRequiredForTarget).toBe(0.5564);
  });

  // CASE 2 - same position, strike raised to $14 (at assigned price) - verify a positive result.
  it("2. same position, strike $14, premium $0.25, target 1% - positive result, correct target classification", () => {
    const result = calculateCoveredCallOutcome(baseInput({ proposedStrike: 14 }));
    // stockGainLossIfCalled = 0, campaignProfitIfCalled = 0 + 58.36 + 25 = 83.36
    expect(result.stockGainLossIfCalled).toBe(0);
    expect(result.campaignProfitIfCalled).toBe(83.36);
    expect(result.campaignReturnPct).toBeCloseTo((83.36 / 1400) * 100, 4);
    expect(result.campaignReturnPct).toBeGreaterThan(1);
    expect(coveredCallOutcomeTone(result, 1)).toBe("good");
  });

  // CASE 3 - positive but below target -> AMBER.
  it("3. result positive but below target -> AMBER (warn)", () => {
    // campaignProfitIfCalled must be >= 0 but campaignReturnPct < targetReturnPct.
    const result = calculateCoveredCallOutcome(baseInput({ proposedStrike: 13, proposedPremiumPerShare: 0.42, targetReturnPct: 1 }));
    expect(result.campaignProfitIfCalled).toBeGreaterThanOrEqual(0);
    expect(result.campaignReturnPct).toBeLessThan(1);
    expect(coveredCallOutcomeTone(result, 1)).toBe("warn");
  });

  // CASE 4 - result >= target -> GREEN.
  it("4. result >= target -> GREEN (good)", () => {
    const result = calculateCoveredCallOutcome(baseInput({ proposedStrike: 13, proposedPremiumPerShare: 0.56, targetReturnPct: 1 }));
    expect(result.campaignReturnPct).toBeGreaterThanOrEqual(1);
    expect(coveredCallOutcomeTone(result, 1)).toBe("good");
  });

  // CASE 5 - result negative -> RED.
  it("5. result negative -> RED (bad)", () => {
    const result = calculateCoveredCallOutcome(baseInput({ proposedPremiumPerShare: 0 }));
    expect(result.campaignProfitIfCalled).toBeLessThan(0);
    expect(coveredCallOutcomeTone(result, 1)).toBe("bad");
  });

  // CASE 6 - prior cash flow negative due to a roll debit - math remains correct (no special-casing).
  it("6. negative prior cash flow (roll debit) - math remains correct", () => {
    const result = calculateCoveredCallOutcome(baseInput({ priorOptionCashFlow: -20, proposedStrike: 14, proposedPremiumPerShare: 0.3 }));
    // campaignProfitIfCalled = 0 + (-20) + 30 = 10
    expect(result.campaignProfitIfCalled).toBe(10);
    expect(result.effectiveBreakEven).toBe(14.2); // 14 - (-20/100) = 14 + 0.2
  });

  // CASE 7 - zero prior cash flow.
  it("7. zero prior cash flow", () => {
    const result = calculateCoveredCallOutcome(baseInput({ priorOptionCashFlow: 0, proposedStrike: 14, proposedPremiumPerShare: 0.5 }));
    expect(result.campaignProfitIfCalled).toBe(50); // 0 + 0 + 50
    expect(result.effectiveBreakEven).toBe(14);
  });

  // CASE 8 - 200 shares - math scales correctly (linear in `shares`, except priorOptionCashFlow,
  // which is a flat campaign-level total that is never itself multiplied by share count).
  it("8. 200 shares - math scales correctly", () => {
    const oneHundred = calculateCoveredCallOutcome(baseInput({ shares: 100 }));
    const twoHundred = calculateCoveredCallOutcome(baseInput({ shares: 200 }));
    expect(twoHundred.shareCost).toBe(2800); // 14 * 200, double the 100-share case's 1400
    expect(twoHundred.shareCost).toBe(oneHundred.shareCost * 2);
    expect(twoHundred.stockGainLossIfCalled).toBe(oneHundred.stockGainLossIfCalled * 2); // -200 vs -100
    expect(twoHundred.newPremiumTotal).toBe(oneHundred.newPremiumTotal * 2); // 50 vs 25
    expect(twoHundred.campaignProfitIfCalled).toBe(-91.64); // -200 + 58.36 + 50
    expect(twoHundred.effectiveBreakEven).toBeCloseTo(14 - 58.36 / 200, 4);
  });

  // CASE 9 - premium required is already <= 0 - display 0.00, never negative.
  it("9. premium required is already <= 0 (strike/prior cash flow already clear it) - floored at 0, never negative", () => {
    const result = calculateCoveredCallOutcome(baseInput({ proposedStrike: 14, priorOptionCashFlow: 200, proposedPremiumPerShare: 0 }));
    expect(result.premiumRequiredToBreakEven).toBe(0);
    expect(result.premiumRequiredForTarget).toBe(0);
  });

  // CASE 10 - current stock hypothetical exit calculation, matched to the ticket's own PATH-like example.
  it("10. hypothetical current share exit - matches the ticket's own PATH-like example ($13.44 snapshot)", () => {
    const result = calculateCoveredCallOutcome(baseInput({ currentStockPrice: 13.44 }));
    // (13.44 - 14) * 100 + 58.36 = -56 + 58.36 = 2.36
    expect(result.hypotheticalShareExitProfit).toBe(2.36);
  });

  // CASE 12 - no trustworthy stock snapshot - do not fabricate a hypothetical share-exit value.
  it("12. no current stock price supplied - hypotheticalShareExitProfit is null, never fabricated", () => {
    expect(calculateCoveredCallOutcome(baseInput({ currentStockPrice: null })).hypotheticalShareExitProfit).toBeNull();
    expect(calculateCoveredCallOutcome(baseInput({ currentStockPrice: undefined })).hypotheticalShareExitProfit).toBeNull();
    expect(calculateCoveredCallOutcome(baseInput()).hypotheticalShareExitProfit).toBeNull();
  });

  it("never double-counts: proposedPremiumPerShare of 0 leaves the campaign result identical to prior cash flow + stock result alone", () => {
    const withZeroNewPremium = calculateCoveredCallOutcome(baseInput({ proposedPremiumPerShare: 0, proposedStrike: 14 }));
    // stockGainLossIfCalled (0) + priorOptionCashFlow (58.36) + 0 new premium = 58.36 - exactly the
    // already-recorded cash flow, proving a $0 proposed premium never silently re-adds anything.
    expect(withZeroNewPremium.campaignProfitIfCalled).toBe(58.36);
  });

  it("targetDifferencePct is signed - negative below target, positive once exceeded", () => {
    const below = calculateCoveredCallOutcome(baseInput());
    expect(below.targetDifferencePct).toBeLessThan(0);
    const above = calculateCoveredCallOutcome(baseInput({ proposedStrike: 14, proposedPremiumPerShare: 0.5 }));
    expect(above.targetDifferencePct).toBeGreaterThan(0);
  });
});

// CASE 3/4/5 color boundary, expressed directly against coveredCallOutcomeTone - the ticket's own
// explicit rule: color reflects TOTAL CAMPAIGN OUTCOME, never merely whether premium is positive.
describe("coveredCallOutcomeTone - color represents total campaign outcome, never premium alone", () => {
  it("a positive new premium that still locks in a net campaign loss is RED, not green", () => {
    // +$25 new premium, but a -$100 stock loss and no prior cash flow cushion -> net loss overall.
    const result = calculateCoveredCallOutcome({ assignedPrice: 14, shares: 100, priorOptionCashFlow: 0, proposedStrike: 13, proposedPremiumPerShare: 0.25, targetReturnPct: 1 });
    expect(result.campaignProfitIfCalled).toBeLessThan(0);
    expect(coveredCallOutcomeTone(result, 1)).toBe("bad");
  });

  it("exactly at target is GREEN (>= , not strictly >)", () => {
    const result = { campaignProfitIfCalled: 14, campaignReturnPct: 1 };
    expect(coveredCallOutcomeTone(result, 1)).toBe("good");
  });

  it("exactly $0 campaign profit is never RED (>= 0 rule) - amber if below target, green if it also meets target", () => {
    const zeroButBelowTarget = { campaignProfitIfCalled: 0, campaignReturnPct: 0 };
    expect(coveredCallOutcomeTone(zeroButBelowTarget, 1)).toBe("warn");
    const zeroAndTargetIsZero = { campaignProfitIfCalled: 0, campaignReturnPct: 0 };
    expect(coveredCallOutcomeTone(zeroAndTargetIsZero, 0)).toBe("good");
  });
});
