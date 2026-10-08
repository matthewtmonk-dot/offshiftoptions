import { afterEach, describe, expect, it } from "vitest";
import { MAX_PROVIDER_REQUESTS_PER_MINUTE, resetScheduledCaptureBudgetForTests, tryReserveProviderRequestBudget } from "./scheduled-capture-budget";

describe("tryReserveProviderRequestBudget", () => {
  afterEach(() => {
    resetScheduledCaptureBudgetForTests();
  });

  it("allows a reservation well under the per-minute ceiling", () => {
    expect(tryReserveProviderRequestBudget(5, new Date("2026-10-08T09:35:00Z"))).toBe(true);
  });

  it("allows reservations that together exactly reach the ceiling", () => {
    const now = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(10, now)).toBe(true);
    expect(tryReserveProviderRequestBudget(2, now)).toBe(true); // 10 + 2 = 12, exactly MAX
  });

  it("refuses a reservation that would exceed the per-minute ceiling", () => {
    const now = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(10, now)).toBe(true);
    expect(tryReserveProviderRequestBudget(5, now)).toBe(false); // 10 + 5 = 15 > 12
  });

  it("a refused reservation does not consume any of the budget", () => {
    const now = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(10, now)).toBe(true);
    expect(tryReserveProviderRequestBudget(5, now)).toBe(false);
    expect(tryReserveProviderRequestBudget(2, now)).toBe(true); // still only 10 used, 2 more fits
  });

  it("the window resets once 60 seconds have elapsed, allowing a fresh reservation", () => {
    const t0 = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(12, t0)).toBe(true); // exhausts the window
    expect(tryReserveProviderRequestBudget(1, t0)).toBe(false);

    const t1 = new Date(t0.getTime() + 60_000); // exactly 60s later
    expect(tryReserveProviderRequestBudget(12, t1)).toBe(true);
  });

  it("does not reset prematurely before 60 seconds have elapsed", () => {
    const t0 = new Date("2026-10-08T09:35:00Z");
    expect(tryReserveProviderRequestBudget(12, t0)).toBe(true);
    const almostAMinuteLater = new Date(t0.getTime() + 59_000);
    expect(tryReserveProviderRequestBudget(1, almostAMinuteLater)).toBe(false);
  });

  it("MAX_PROVIDER_REQUESTS_PER_MINUTE is the ticket's own explicit conservative target (12), never an assumed higher entitlement", () => {
    expect(MAX_PROVIDER_REQUESTS_PER_MINUTE).toBe(12);
  });
});
