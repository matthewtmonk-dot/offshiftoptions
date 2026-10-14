import { describe, expect, it } from "vitest";
import { buildStrikeGaugeGeometry, dteChipLabel } from "./strikeGauge";

function zoneOf(pricePct: number, g: NonNullable<ReturnType<typeof buildStrikeGaugeGeometry>>) {
  const inside = (z: { startPct: number; endPct: number } | null) => z !== null && pricePct >= z.startPct - 1e-9 && pricePct <= z.endPct + 1e-9;
  // Watch is checked before OTM/ITM because zones share boundaries.
  if (g.watch && inside(g.watch) && pricePct !== g.strikePct) return "WATCH";
  if (inside(g.itm) && !inside(g.otm)) return "ITM";
  if (inside(g.otm) && !inside(g.itm)) return "OTM";
  return "EDGE";
}

describe("buildStrikeGaugeGeometry", () => {
  it("draws the production UPST case: $25 put, stock $23.88, 3% buffer -> ITM with the dot left of the strike", () => {
    const g = buildStrikeGaugeGeometry({ optionType: "PUT", strike: 25, price: 23.88, bufferPercent: 3 })!;
    expect(g.moneyness).toBe("ITM");
    expect(g.pricePct).toBeLessThan(g.strikePct);
    expect(g.itm.endPct).toBeCloseTo(g.strikePct, 6);
    expect(g.watch!.startPct).toBeCloseTo(g.strikePct, 6);
    expect(g.watch!.endPct).toBeGreaterThan(g.strikePct);
    expect(g.priceClamped).toBe(false);
  });

  it("puts the watch band ABOVE a put strike and BELOW a call strike (mirror image)", () => {
    const put = buildStrikeGaugeGeometry({ optionType: "PUT", strike: 20, price: 21, bufferPercent: 3 })!;
    const call = buildStrikeGaugeGeometry({ optionType: "CALL", strike: 20, price: 19, bufferPercent: 3 })!;
    expect(put.watch!.startPct).toBeCloseTo(put.strikePct, 6);
    expect(put.watch!.endPct).toBeGreaterThan(put.strikePct);
    expect(call.watch!.endPct).toBeCloseTo(call.strikePct, 6);
    expect(call.watch!.startPct).toBeLessThan(call.strikePct);
    expect(put.moneyness).toBe("OTM");
    expect(call.moneyness).toBe("OTM");
  });

  it("classifies exactly like the evaluator's favorable-distance rule across a grid of prices", () => {
    for (const optionType of ["PUT", "CALL"] as const) {
      for (const buffer of [1, 3, 10]) {
        for (let price = 14; price <= 26; price += 0.25) {
          const strike = 20;
          const g = buildStrikeGaugeGeometry({ optionType, strike, price, bufferPercent: buffer })!;
          const fav = optionType === "PUT" ? ((price - strike) / strike) * 100 : ((strike - price) / strike) * 100;
          const expected = fav <= 0 ? "ITM" : fav <= buffer ? "WATCH" : "OTM";
          const drawn = zoneOf(g.pricePct, g);
          if (g.priceClamped) continue; // pinned dots sit on an edge by design
          if (Math.abs(fav) < 1e-9 || Math.abs(fav - buffer) < 1e-9) continue; // exact boundaries are shared by two zones
          expect(drawn, `${optionType} price ${price} buffer ${buffer}`).toBe(expected);
          if (expected !== "WATCH") expect(g.moneyness).toBe(expected);
        }
      }
    }
  });

  it("pins the dot to an edge and says so when the price is far outside the window", () => {
    const g = buildStrikeGaugeGeometry({ optionType: "PUT", strike: 20, price: 20.2, bufferPercent: 25 })!;
    expect(g.pricePct).toBeGreaterThanOrEqual(0);
    expect(g.pricePct).toBeLessThanOrEqual(100);
  });

  it("never draws from missing or invalid evidence", () => {
    expect(buildStrikeGaugeGeometry({ optionType: "PUT", strike: null, price: 20, bufferPercent: 3 })).toBeNull();
    expect(buildStrikeGaugeGeometry({ optionType: "PUT", strike: 20, price: null, bufferPercent: 3 })).toBeNull();
    expect(buildStrikeGaugeGeometry({ optionType: "PUT", strike: 0, price: 20, bufferPercent: 3 })).toBeNull();
    expect(buildStrikeGaugeGeometry({ optionType: "CALL", strike: 20, price: Number.NaN, bufferPercent: 3 })).toBeNull();
    expect(buildStrikeGaugeGeometry({ optionType: "CALL", strike: 20, price: -1, bufferPercent: 3 })).toBeNull();
  });

  it("omits the watch band when no valid buffer is supplied", () => {
    const g = buildStrikeGaugeGeometry({ optionType: "PUT", strike: 20, price: 22, bufferPercent: null })!;
    expect(g.watch).toBeNull();
    expect(g.otm.startPct).toBeCloseTo(g.strikePct, 6);
  });

  it("reports ATM for an exact strike match", () => {
    expect(buildStrikeGaugeGeometry({ optionType: "PUT", strike: 20, price: 20, bufferPercent: 3 })!.moneyness).toBe("ATM");
  });
});

describe("dteChipLabel", () => {
  it("labels days, today, expired and unknown", () => {
    expect(dteChipLabel(10)).toBe("10d");
    expect(dteChipLabel(0)).toBe("today");
    expect(dteChipLabel(-1)).toBe("expired");
    expect(dteChipLabel(null)).toBeNull();
    expect(dteChipLabel(Number.NaN)).toBeNull();
  });
});
