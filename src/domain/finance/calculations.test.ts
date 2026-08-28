import { describe, expect, it } from "vitest";
import {
  annualizedReturnOnRisk,
  bidAskSpreadDollars,
  bidAskSpreadPercent,
  bollingerBands,
  bollingerPositionPercent,
  bollingerWidth,
  cashSecuredReturnOnRisk,
  cspBreakEven,
  daysToExpiration,
  distanceToStrikeDollars,
  distanceToStrikePercent,
  estimatedBuyToCloseCost,
  historicalVolatility,
  premiumCapturedPercent,
  remainingPremium,
  wilderRsi,
} from "./calculations";

describe("financial calculations", () => {
  it("calculates Wilder RSI 14 deterministically", () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03,
      45.61, 46.28, 46.28,
    ];

    expect(wilderRsi(closes)).toBe(70.46);
  });

  it("calculates Bollinger bands, position, and width", () => {
    const closes = [
      20, 20.3, 20.4, 20.2, 20.7, 21, 21.2, 21.1, 20.9, 21.4, 21.7, 21.5, 21.8, 22,
      22.2, 22.1, 22.5, 22.7, 22.9, 23,
    ];
    const bands = bollingerBands(closes);

    expect(bands).toEqual({ lower: 19.6927, middle: 21.48, upper: 23.2673 });
    expect(bollingerPositionPercent(21.5, bands!)).toBe(50.56);
    expect(bollingerWidth(bands!)).toBe(16.64);
  });

  it("calculates historical volatility from log returns", () => {
    expect(historicalVolatility([10, 10.2, 10.1, 10.5, 10.8, 10.7])).toBe(35.16);
  });

  it("calculates CSP position values", () => {
    expect(daysToExpiration(new Date("2026-09-18T20:00:00Z"), new Date("2026-08-28T12:00:00Z"))).toBe(21);
    expect(distanceToStrikeDollars(16.89, 16.5)).toBe(0.39);
    expect(distanceToStrikePercent(16.89, 16.5)).toBe(2.31);
    expect(cspBreakEven(16.5, 0.26)).toBe(16.24);
    expect(cashSecuredReturnOnRisk(0.26, 16.5, 1)).toBe(1.58);
    expect(annualizedReturnOnRisk(1.58, 21)).toBe(27.46);
    expect(premiumCapturedPercent(0.26, 0.05)).toBe(80.77);
    expect(remainingPremium(0.26, 0.05)).toBe(0.05);
    expect(bidAskSpreadDollars(0.04, 0.06)).toBe(0.02);
    expect(bidAskSpreadPercent(0.04, 0.06)).toBe(40);
    expect(estimatedBuyToCloseCost(1, 0.06, 0.65)).toBe(6.65);
  });
});
